-- Talk to any country. Every AI government answers, in its own voice,
-- about the world as it really is: its wars, its alliances, what it thinks
-- of you, who it fears. Its personality decides how easy it is to deal
-- with: a diplomatic government is warm and cheap to please, an aggressive
-- one is blunt and expensive, a mercantile one will do almost anything for
-- money. Insults and threats sour relations; compliments help a little
-- (only so much a day); gifts help a lot; pestering it doesn't.
--
-- It can put real offers on the table, which pop up for you to accept or
-- decline: an alliance, a non-aggression pact, peace (white, or for a
-- price), a payment for its goodwill (and a pact or alliance with it), or
-- joining your war against a country you name, for a fee. Everything is
-- decided here on the server with the same rules as the rest of diplomacy;
-- the words are templates chosen by personality, mood and situation.

create table if not exists game.diplo_chat (
  id bigint generated always as identity primary key,
  player_id uuid not null references game.players(id) on delete cascade,
  nation_id text not null references game.nations(id),
  at timestamptz not null default now(),
  from_player boolean not null,
  body text not null,
  intent text,
  mood text,
  rel_delta numeric,
  offer jsonb
);
create index if not exists diplo_chat_pair_idx on game.diplo_chat (player_id, nation_id, id desc);
alter table game.diplo_chat enable row level security;
revoke all on game.diplo_chat from public, anon, authenticated;

create table if not exists game.chat_deals (
  id bigint generated always as identity primary key,
  player_id uuid not null references game.players(id) on delete cascade,
  nation_id text not null references game.nations(id),
  kind text not null check (kind in ('gift', 'tribute', 'join_war', 'ally')),
  price bigint not null default 0,
  terms jsonb not null default '{}'::jsonb,
  status text not null default 'open' check (status in ('open', 'accepted', 'declined', 'expired')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '30 minutes'
);
create index if not exists chat_deals_player_idx on game.chat_deals (player_id, status);
alter table game.chat_deals enable row level security;
revoke all on game.chat_deals from public, anon, authenticated;

-- A random line from a list (empty strings allowed, for "say nothing").
create or replace function game.pick(p text[]) returns text
language sql volatile as $$
  select p[1 + floor(random() * coalesce(array_length(p, 1), 1))::int]
$$;

-- Fill {placeholders} from a jsonb object.
create or replace function game.fill(p_tpl text, p_vars jsonb) returns text
language plpgsql immutable as $$
declare
  k text;
  v text;
  s text := p_tpl;
begin
  for k, v in select key, value from jsonb_each_text(p_vars) loop
    s := replace(s, '{' || k || '}', coalesce(v, ''));
  end loop;
  return s;
end $$;

-- What a deal costs with this government: hours of its income, more if it
-- dislikes you, by personality, and more if you are a big power.
create or replace function game.chat_price(n game.nations, p_hours numeric, p_rel numeric, p_me text) returns bigint
language sql stable as $$
  select (round(greatest(n.income_h, 500000) * p_hours
           * (case n.personality when 'diplomatic' then 0.6 when 'mercantile' then 0.8 when 'balanced' then 1.0
                                 when 'defensive' then 1.2 when 'expansionist' then 1.5 else 2.0 end)
           * (1 + greatest(0, -p_rel) / 40.0)
           * (case when coalesce((select share from game.nations where id = p_me), 0) >= 0.10 then 2 else 1 end)
           / 1000) * 1000)::bigint
$$;

-- Turn "$5k", "2 million", "250000 dollars" into mills (0 if none).
create or replace function game.chat_amount(p_text text) returns bigint
language plpgsql immutable as $$
declare
  m text[];
  v numeric;
begin
  m := regexp_match(lower(p_text), '\$?\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*(k|m|b|bn|thousand|million|billion|grand)?\M');
  if m is null then return 0; end if;
  v := replace(m[1], ',', '')::numeric;
  v := v * case m[2] when 'k' then 1e3 when 'thousand' then 1e3 when 'grand' then 1e3 when 'm' then 1e6 when 'million' then 1e6
                     when 'b' then 1e9 when 'bn' then 1e9 when 'billion' then 1e9 else 1 end;
  return least(v, 1e12)::bigint * 1000;
end $$;

-- The other country a message is about (by name), if any.
create or replace function game.chat_mention(p_text text, p_skip text[]) returns text
language sql stable as $$
  select t.id from game.territories t join game.nations n on n.id = t.id
   where n.status = 'active' and not (t.id = any(p_skip))
     and position(lower(t.name) in lower(p_text)) > 0
   order by length(t.name) desc limit 1
$$;

-- The reply: decides the outcome, writes the words, and makes any offer.
create or replace function game.diplo_reply(p game.players, p_me text, n game.nations, p_text text) returns jsonb
language plpgsql set search_path = game, pg_temp as $$
declare
  t text := lower(coalesce(p_text, ''));
  tr jsonb := game.ai_traits(n.personality);
  v_dip numeric := (tr ->> 'dip')::numeric;
  v_aggr numeric := (tr ->> 'aggr')::numeric;
  v_caution numeric := (tr ->> 'caution')::numeric;
  m game.nations;
  v_rel numeric := 0;
  v_war boolean := false;
  v_war_id bigint;
  v_ally boolean := false;
  tr2 game.treaties;
  v_coal boolean := false;
  v_big boolean := false;
  v_ratio numeric := 1;
  v_recent int;
  v_flattery numeric;
  v_intent text;
  v_mood text;
  v_delta numeric := 0;
  v_core text := '';
  v_state text := '';
  v_offer jsonb;
  v_price bigint;
  v_amount bigint;
  v_target text;
  v_tname text;
  v_deal bigint;
  v_res jsonb;
  v_their_al bigint := game.alliance_of(n.id);
  v_my_al bigint;
  v_sc numeric;
  v_enemies text;
  v_vars jsonb;
  v_opener text;
  v_closer text;
  v_why text[] := '{}';
begin
  -- The situation.
  if p_me is not null then
    select * into m from game.nations where id = p_me;
    v_rel := game.rel(p_me, n.id);
    v_war := game.at_war(p_me, n.id);
    v_war_id := game.war_between(p_me, n.id);
    v_ally := game.allied(p_me, n.id);
    tr2 := game.treaty(p_me, n.id);
    v_coal := game.in_coalition_against(n.id, p_me);
    v_big := m.share >= greatest(0.12, game.home_share(m.id) + 0.08);
    v_ratio := greatest(1, game.military_power(p_me)) / greatest(1, game.military_power(n.id));
    v_my_al := game.alliance_of(p_me);
  end if;
  select count(*) into v_recent from game.diplo_chat
   where player_id = p.id and nation_id = n.id and from_player and at > now() - interval '10 minutes';
  select coalesce(sum(rel_delta), 0) into v_flattery from game.diplo_chat
   where player_id = p.id and nation_id = n.id and not from_player and intent = 'compliment' and at > now() - interval '1 day';
  select string_agg(game.nation_name(case when s.side = 'att' then w.defender_id else w.attacker_id end), ', ')
    into v_enemies
    from game.war_sides s join game.wars w on w.id = s.war_id and w.status = 'active' where s.nation_id = n.id;

  -- What was said.
  v_target := game.chat_mention(t, array[n.id, coalesce(p_me, '')]);
  v_tname := game.nation_name(v_target);
  v_amount := game.chat_amount(t);
  v_intent := case
    when v_recent >= 8 then 'spam'
    when t ~ '\m(idiot|stupid|dumb|loser|trash|pathetic|clown|moron|fool|useless|shut up|ugly|cringe|noob|worthless|garbage|rubbish|scum|hate you|suck|sucks|fuck|shit|bitch|dick|crap)\M' then 'insult'
    -- A request about another country comes before anything that sounds like a threat.
    when v_target is not null and t ~ '(help|join|with (me|us)|for (me|us)|together|alongside|against|attack|invade|declare|\mwar\M|fight|take (down|out)|go after|deal with)' then 'war_help'
    when t ~ '\m(i will|i''ll|ill|we will|we''ll|gonna|going to|about to)\M\s.{0,25}(attack|invade|destroy|crush|nuke|wipe|conquer|take over|end you|annex|burn)|or else|you will regret|you''ll regret|prepare (for|to) (die|war|lose)|watch your back|\mi will declare|\mi''ll declare' then 'threat'
    when v_amount > 0 and t ~ '(give|gift|pay|send|offer|bribe|tribute|donat|here''?s|take)' then 'gift'
    when t ~ '\mwhy\M' and t ~ '(ally|alliance|allies|refus|declin|reject|join|friend|deal|pact)' then 'why_no'
    when t ~ '\mwhy\M' and t ~ '(attack|war|invad|denounc|hate|angry|enemy|enemies|hostile|threat)' then 'why_war'
    when v_war and t ~ '(peace|ceasefire|cease fire|stop (the )?(war|fight|attack)|end (the|this) war|truce|surrender|call it off)' then 'peace'
    when t ~ '(alliance|\mally\M|allies|allied|team up|join (us|me|my)|side with|partner)' then 'alliance'
    when t ~ '(non.?aggression|\mpact\M|truce|ceasefire|not attack|no war|leave (me|us) alone|don''t attack|dont attack|peace treaty|\mpeace\M)' then 'nap'
    when t ~ '(deal|trade|barter|bargain|offer|what do you want|what would it take|\mprice\M|cost|terms|negotiat|propos)' then 'deal'
    when t ~ '(think of (me|us)|like (me|us)|trust (me|us)|relations|relationship|friends\?|are we friends|opinion)' then 'opinion'
    when t ~ '(\mhow (are|is|''s|r)\M|what''s up|whats up|wassup|\mnews\M|status|situation|economy|\marmy\M|plans|doing|going on|what are you up to|how things)' then 'state'
    when t ~ '(thank|great|respect|admire|love|amazing|awesome|beautiful|wise|appreciate|honou?r|brilliant|best|nice|cool|legend|good job|well done)' then 'compliment'
    when t ~ '^\s*(hi|hello|hey|yo|greetings|good (morning|afternoon|evening|day)|sup|hiya|howdy|salut|hola|bonjour)\M' then 'greeting'
    when t ~ '^\s*(yes|yeah|yep|ok|okay|sure|deal|agreed|accept|fine|alright|sounds good)\M' then 'yes'
    when t ~ '^\s*(no|nope|nah|never|no way|not now|decline)\M' then 'no'
    else 'other' end;

  -- How they feel about you.
  v_mood := case
    when v_war or v_coal then 'hostile'
    when v_rel <= -40 then 'hostile'
    when v_rel <= -10 then 'cold'
    when v_ally or v_rel >= 50 then 'friendly'
    when v_rel >= 20 then 'warm'
    else 'neutral' end;

  v_vars := jsonb_build_object('us', n.name, 'me', coalesce(m.name, p.display_name), 'leader', p.display_name,
    'target', coalesce(v_tname, ''), 'enemies', coalesce(v_enemies, ''), 'alliance', coalesce((select name from game.alliances where id = v_their_al), ''),
    'rel', round(v_rel)::text, 'share', round(coalesce(m.share, 0) * 100, 1)::text);

  -- What they decide, and the heart of what they say.
  if p_me is null and v_intent not in ('greeting', 'compliment', 'insult', 'state', 'other', 'spam') then
    v_core := 'Lead a country first, and then we can talk as equals.';
  elsif v_intent = 'spam' then
    v_delta := -2;
    v_core := game.pick(array['We have heard you. Many, many times.', 'Enough messages. Our diplomats need rest.', 'You are wearing out our patience.']);
  elsif v_intent = 'insult' then
    v_delta := -(6 + round(6 * v_aggr));
    v_core := case n.personality
      when 'aggressive' then game.pick(array['Say that again and our tanks will answer for us.', 'Insults from {me}? Remember them when our army is at your border.'])
      when 'expansionist' then game.pick(array['Rude, and foolish. We will remember this when we redraw the map.', 'Mock us while you can, {leader}.'])
      when 'defensive' then game.pick(array['There is no need for that. We will keep our distance from {me}.', 'Hostile words. Our guard is up.'])
      when 'diplomatic' then game.pick(array['That was uncalled for. We expected better from {me}.', 'We are disappointed. Words matter in diplomacy.'])
      when 'mercantile' then game.pick(array['Insults are bad for business. Our prices for you just went up.', 'Rudeness costs extra, {leader}.'])
      else game.pick(array['Noted. Relations between us will suffer for it.', 'That is not how nations speak to each other.']) end;
    if v_aggr >= 0.7 and not v_ally and v_rel - 12 < -30 then
      begin
        perform game.do_denounce(n.id, p_me);
        v_core := v_core || ' We denounce you before the world.';
      exception when others then null;
      end;
    end if;
  elsif v_intent = 'threat' then
    if v_ratio >= 2.5 and v_caution >= 0.6 and not v_war then
      v_delta := 2;
      v_core := 'Your army is far bigger than ours, and we are not fools. Let us not come to blows.';
      if tr2.id is null then
        begin
          v_res := game.make_offer('nap', n.id, p_me, null, '{}');
          v_offer := jsonb_build_object('kind', 'nap', 'offer_id', v_res ->> 'id', 'text', 'A 48-hour non-aggression pact');
          v_core := v_core || ' We propose a non-aggression pact.';
        exception when others then null;
        end;
      end if;
    else
      v_delta := -(8 + round(6 * v_aggr));
      v_core := case
        when v_aggr >= 0.7 then game.pick(array['Come and try. We have been waiting for an excuse.', 'Threats? We will see whose flag flies at the end.'])
        when v_ratio < 0.7 then game.pick(array['With that army? We are not impressed.', 'Your army is smaller than ours. Choose your words more carefully.'])
        else game.pick(array['A threat. We will prepare our defences, and remember who made it.', 'Threats only push us towards your enemies.']) end;
    end if;
  elsif v_intent = 'gift' then
    v_price := least(v_amount, p.cash);
    if v_price <= 0 then
      v_core := 'A generous thought, but you can''t afford it right now.';
    else
      insert into game.chat_deals (player_id, nation_id, kind, price, terms) values (p.id, n.id, 'gift', v_price, '{}') returning id into v_deal;
      v_offer := jsonb_build_object('kind', 'gift', 'deal_id', v_deal, 'price', v_price, 'text', 'Send ' || game.fmt(v_price) || ' to ' || n.name);
      v_core := case n.personality
        when 'mercantile' then 'Now you are speaking our language. Send it, and you will find us very friendly.'
        when 'aggressive' then 'Money will not buy our respect, but it may buy our patience.'
        when 'diplomatic' then 'A kind gesture. Our people will remember it.'
        else 'A gift would be welcome, and noticed.' end;
    end if;
  elsif v_intent = 'why_no' or (v_intent = 'alliance' and (v_war or v_coal or v_big or v_rel < -10)) then
    -- The honest reasons, most important first.
    if v_war then v_why := v_why || 'we are at war with you'::text; end if;
    if v_coal then v_why := v_why || format('we are part of the coalition against you: you hold %s%% of the world, and nobody trusts a giant', round(m.share * 100, 1)); end if;
    if not v_coal and v_big then v_why := v_why || 'you have grown too powerful for our comfort'::text; end if;
    if v_their_al is not null and not v_ally then v_why := v_why || format('we are already bound to the %s', (select name from game.alliances where id = v_their_al)); end if;
    if exists (select 1 from game.alliance_members am where am.alliance_id = v_their_al and p_me is not null and game.at_war(am.nation_id, p_me)) then
      v_why := v_why || 'you are at war with one of our allies'::text;
    end if;
    if v_rel < -10 then v_why := v_why || format('our relations are poor (%s)', round(v_rel)); end if;
    if (n.ai ->> 'target') = p_me then v_why := v_why || 'our generals see you as a threat'::text; end if;
    if v_enemies is not null and p_me is not null and exists (select 1 from game.alliance_members x where x.nation_id = p_me and x.alliance_id in (
         select alliance_id from game.alliance_members where nation_id in (select case when s2.side = 'att' then w2.defender_id else w2.attacker_id end
           from game.war_sides s2 join game.wars w2 on w2.id = s2.war_id and w2.status = 'active' where s2.nation_id = n.id))) then
      v_why := v_why || 'your alliance stands with our enemies'::text;
    end if;
    if v_aggr >= 0.85 then v_why := v_why || 'we prefer to stand alone'::text; end if;
    if v_ratio < 0.25 then v_why := v_why || 'frankly, your army is too small to be much use to us'::text; end if;
    if array_length(v_why, 1) is null then
      v_why := v_why || case when v_rel < 5 + 20 * (1 - v_dip) then format('we don''t know you well enough yet (relations %s)', round(v_rel)) else 'nobody has asked us properly' end;
    end if;
    v_core := 'Since you ask: ' || array_to_string(v_why[1:3], '; ') || '.';
    if not v_war and not v_coal and not v_big and v_their_al is null and v_rel > -40 and v_aggr < 0.85 then
      v_price := game.chat_price(n, 6, v_rel, p_me);
      insert into game.chat_deals (player_id, nation_id, kind, price, terms) values (p.id, n.id, 'tribute', v_price, jsonb_build_object('then', 'alliance'))
      returning id into v_deal;
      v_offer := jsonb_build_object('kind', 'tribute', 'deal_id', v_deal, 'price', v_price, 'then', 'alliance', 'text', 'Pay ' || game.fmt(v_price) || ' for an alliance');
      v_core := v_core || ' But for ' || game.fmt(v_price) || ' towards our treasury, we could put all that behind us and stand together.';
    end if;
  elsif v_intent = 'why_war' then
    v_core := case
      when v_coal then format('Because you hold %s%% of the world and keep reaching for more. The coalition will not let one nation swallow everyone.', round(m.share * 100, 1))
      when v_war then 'You know why. Our soldiers are already in the field.'
      when (n.ai ->> 'target') = p_me then 'Our generals have studied your borders. They like what they see.'
      when v_rel <= -30 then format('Our relations are bad (%s). You have given us little reason to trust you.', round(v_rel))
      else 'We have no quarrel with you right now. Keep it that way.' end;
  elsif v_intent = 'peace' then
    v_sc := case when game.side_of(v_war_id, n.id) = 'att' then (select score from game.wars where id = v_war_id) else -(select score from game.wars where id = v_war_id) end;
    if v_coal and n.exhaustion < 70 and v_sc > -40 then
      v_core := 'Peace? The coalition will not stop until you are cut down to size.';
    elsif v_sc < 20 or n.exhaustion > 60 then
      begin
        v_res := game.make_offer('peace', n.id, p_me, v_war_id, jsonb_build_object('terms', 'white'));
        v_offer := jsonb_build_object('kind', 'peace', 'offer_id', v_res ->> 'id', 'text', 'White peace: everyone goes home');
        v_core := game.pick(array['We are tired of this war too. Let everyone go home.', 'Enough blood. We offer a white peace.']);
        v_delta := 3;
      exception when others then
        v_core := 'We have already sent you terms. Answer them.';
      end;
    else
      v_price := greatest(game.chat_price(n, 4, v_rel, p_me), 1000000);
      begin
        v_res := game.make_offer('peace', n.id, p_me, v_war_id,
          jsonb_build_object('terms', 'reparations', 'winner', game.side_of(v_war_id, n.id), 'amount', v_price));
        v_offer := jsonb_build_object('kind', 'peace', 'offer_id', v_res ->> 'id', 'price', v_price, 'text', 'Peace if you pay ' || game.fmt(v_price) || ' in reparations');
        v_core := format('We are winning this war. Pay %s in reparations and we will stop.', game.fmt(v_price));
      exception when others then
        v_core := 'We have already sent you terms. Answer them.';
      end;
    end if;
  elsif v_intent = 'war_help' then
    if v_target = p_me then
      v_core := 'You want us to attack you? Strange request.';
    elsif game.allied(n.id, v_target) then
      v_core := format('%s is our ally. We would never turn on them.', v_tname);
    elsif game.at_war(n.id, v_target) then
      v_core := format('We are already at war with %s. Fight alongside us if you like.', v_tname);
    elsif v_war or v_coal then
      v_core := 'Help you? We are not on your side.';
    elsif (game.treaty(n.id, v_target)).id is not null then
      v_core := format('We have a treaty with %s. We keep our word.', v_tname);
    elsif game.rel(n.id, v_target) >= 30 then
      v_core := format('%s is a friend of ours (relations %s). Find someone else.', v_tname, round(game.rel(n.id, v_target)));
    elsif v_rel < -20 then
      v_core := 'We don''t take orders from you, and we don''t trust you enough to fight beside you.';
    else
      v_price := game.chat_price(n, case when game.in_coalition_against(n.id, v_target) then 2 else 8 end, v_rel - least(0, game.rel(n.id, v_target)), p_me);
      insert into game.chat_deals (player_id, nation_id, kind, price, terms)
      values (p.id, n.id, 'join_war', v_price, jsonb_build_object('target', v_target)) returning id into v_deal;
      v_offer := jsonb_build_object('kind', 'join_war', 'deal_id', v_deal, 'price', v_price, 'target', v_target,
        'text', format('Pay %s and %s goes to war with %s', game.fmt(v_price), n.name, v_tname));
      v_core := case
        when game.in_coalition_against(n.id, v_target) then format('%s must be stopped. Cover our costs, %s, and we march.', v_tname, game.fmt(v_price))
        when game.rel(n.id, v_target) < -20 then format('We have no love for %s. For %s, we will gladly join the fight.', v_tname, game.fmt(v_price))
        when n.personality = 'mercantile' then format('War is expensive. %s, and our army is yours against %s.', game.fmt(v_price), v_tname)
        else format('Going to war with %s is a big step. It will cost you %s.', v_tname, game.fmt(v_price)) end;
    end if;
  elsif v_intent = 'alliance' then
    v_my_al := game.alliance_of(p_me);
    if v_ally then
      v_core := 'We are already allies, my friend.';
    elsif v_their_al is not null and v_my_al is not null then
      v_core := format('We are already bound to the %s, and you to yours. One alliance each.', (select name from game.alliances where id = v_their_al));
    elsif v_rel >= 5 + 20 * (1 - v_dip) - 10 * game.ai_common_enemy(n.id, p_me) and v_aggr < 0.85 then
      if v_my_al is not null then
        insert into game.chat_deals (player_id, nation_id, kind, price, terms) values (p.id, n.id, 'ally', 0, jsonb_build_object('join', v_my_al))
        returning id into v_deal;
        v_offer := jsonb_build_object('kind', 'ally', 'deal_id', v_deal, 'text', n.name || ' joins your alliance');
        v_core := 'Yes. We will join your alliance, if you will have us.';
      else
        begin
          v_res := game.make_offer('alliance', n.id, p_me, null, jsonb_build_object('name', coalesce((select name from game.alliances where id = v_their_al), n.name || '–' || m.name || ' Accord')));
          v_offer := jsonb_build_object('kind', 'alliance', 'offer_id', v_res ->> 'id', 'text', case when v_their_al is not null then 'Join the ' || (select name from game.alliances where id = v_their_al) else 'Found an alliance together' end);
          v_core := case when v_their_al is not null then 'Yes. Join us in the ' || (select name from game.alliances where id = v_their_al) || '.' else 'Yes. Let us found an alliance together.' end;
          v_delta := 2;
        exception when others then
          v_core := 'We have already invited you. Answer our invitation.';
        end;
      end if;
    else
      v_price := game.chat_price(n, 6, v_rel, p_me);
      insert into game.chat_deals (player_id, nation_id, kind, price, terms) values (p.id, n.id, 'tribute', v_price, jsonb_build_object('then', 'alliance'))
      returning id into v_deal;
      v_offer := jsonb_build_object('kind', 'tribute', 'deal_id', v_deal, 'price', v_price, 'then', 'alliance', 'text', 'Pay ' || game.fmt(v_price) || ' for an alliance');
      v_core := case n.personality
        when 'mercantile' then format('An alliance is a valuable thing. %s, and it is yours.', game.fmt(v_price))
        when 'aggressive' then format('We don''t ally with strangers. Prove you are serious: %s.', game.fmt(v_price))
        else format('We hardly know you (relations %s). %s for our treasury would show you mean it.', round(v_rel), game.fmt(v_price)) end;
    end if;
  elsif v_intent = 'nap' then
    if v_war then
      v_core := 'We are at war. Talk to us about peace, not pacts.';
    elsif tr2.id is not null then
      v_core := format('We already have a %s with you until %s.', case tr2.kind when 'nap' then 'pact' else 'truce' end, to_char(tr2.until at time zone 'utc', 'HH24:MI "UTC"'));
    elsif not v_coal and v_rel >= -15 and (n.ai ->> 'target') is distinct from p_me and v_aggr < 0.8 then
      begin
        v_res := game.make_offer('nap', n.id, p_me, null, '{}');
        v_offer := jsonb_build_object('kind', 'nap', 'offer_id', v_res ->> 'id', 'text', 'A 48-hour non-aggression pact');
        v_core := game.pick(array['Agreed. Neither of us attacks the other for two days.', 'A pact suits us. Sign it and we will keep the peace.']);
        v_delta := 1;
      exception when others then
        v_core := 'Our pact offer is already on your desk.';
      end;
    elsif v_coal then
      v_core := 'No pacts with you. The coalition stands together.';
    else
      v_price := game.chat_price(n, 3, v_rel, p_me);
      insert into game.chat_deals (player_id, nation_id, kind, price, terms) values (p.id, n.id, 'tribute', v_price, jsonb_build_object('then', 'nap'))
      returning id into v_deal;
      v_offer := jsonb_build_object('kind', 'tribute', 'deal_id', v_deal, 'price', v_price, 'then', 'nap', 'text', 'Pay ' || game.fmt(v_price) || ' for a non-aggression pact');
      v_core := format('Peace has a price. %s, and we sign.', game.fmt(v_price));
    end if;
  elsif v_intent = 'deal' then
    if v_war then
      v_core := 'The only deal on the table is peace. Ask for it.';
    elsif v_coal then
      v_core := 'There is nothing you can offer that would make us help you grow bigger.';
    else
      v_price := game.chat_price(n, 2, v_rel, p_me);
      insert into game.chat_deals (player_id, nation_id, kind, price, terms) values (p.id, n.id, 'tribute', v_price, jsonb_build_object('then', 'relations'))
      returning id into v_deal;
      v_offer := jsonb_build_object('kind', 'tribute', 'deal_id', v_deal, 'price', v_price, 'then', 'relations', 'text', 'Pay ' || game.fmt(v_price) || ' for better relations');
      v_core := case n.personality
        when 'mercantile' then format('Here is our offer: %s buys you a great deal of goodwill. Ask about alliances or wars, too: everything has a price.', game.fmt(v_price))
        when 'diplomatic' then format('We would rather build trust. A contribution of %s to our treasury would warm things up, and then we can talk alliances.', game.fmt(v_price))
        when 'aggressive' then format('Deals are for the weak, but %s would buy you some patience from us.', game.fmt(v_price))
        else format('Start with %s for our goodwill. After that, ask about pacts, alliances or common enemies.', game.fmt(v_price)) end;
    end if;
  elsif v_intent = 'opinion' then
    v_core := case v_mood
      when 'friendly' then format('You are one of our closest friends (relations %s).', round(v_rel))
      when 'warm' then format('We think well of you (relations %s). There is room to grow.', round(v_rel))
      when 'neutral' then format('We don''t have strong feelings about you either way (relations %s).', round(v_rel))
      when 'cold' then format('Frankly, we don''t trust you (relations %s).', round(v_rel))
      else format('You are an enemy of %s (relations %s).', n.name, round(v_rel)) end;
  elsif v_intent = 'compliment' then
    v_delta := greatest(0, least(1 + round(3 * v_dip), 8 - v_flattery));
    v_core := case when v_delta = 0 then 'Kind words are cheap, and you have spent plenty today.'
      when v_mood = 'hostile' then 'Flattery from an enemy. We are not fooled, but we heard you.'
      else game.pick(array['Kind words. They are appreciated.', 'You flatter us, {leader}. It is working, a little.', 'Our people will be glad to hear it.']) end;
  elsif v_intent = 'greeting' then
    v_delta := case when exists (select 1 from game.diplo_chat where player_id = p.id and nation_id = n.id and not from_player and intent = 'greeting' and at > now() - interval '1 day') then 0 else 0.5 end;
    v_core := case v_mood
      when 'friendly' then game.pick(array['Welcome, friend. What can {us} do for you?', 'Good to see you again. How can we help?'])
      when 'warm' then game.pick(array['Greetings from {us}. What brings you here?', 'Hello, {leader}. What would you like to discuss?'])
      when 'neutral' then game.pick(array['Greetings. State your business.', 'Hello. {us} is listening.'])
      when 'cold' then game.pick(array['What do you want?', 'Make it quick.'])
      else game.pick(array['We have nothing to say to {me}.', 'An enemy says hello. How touching.']) end;
  elsif v_intent in ('yes', 'no') then
    -- Answering our last offer in words: point at the buttons, or shrug.
    if exists (select 1 from game.diplo_chat c where c.player_id = p.id and c.nation_id = n.id and not c.from_player and c.offer is not null
                 and c.id = (select max(id) from game.diplo_chat where player_id = p.id and nation_id = n.id and not from_player)) then
      v_core := case v_intent when 'yes' then 'Good. Press Accept on our offer and it is done.' else 'Then press Decline, and we will say no more about it.' end;
    else
      v_core := case v_intent when 'yes' then 'Agreed to what? Ask us for something specific.' else 'Very well.' end;
    end if;
  else
    v_core := case v_mood
      when 'friendly' then game.pick(array['Of course, my friend. Ask us about alliances, pacts, deals or your enemies.', 'We are listening, as always.'])
      when 'hostile' then game.pick(array['We have little to discuss unless it is peace.', 'Words will not change what is happening between us.'])
      else game.pick(array['Interesting. Ask us plainly: an alliance, a pact, a deal, or help against a rival?', 'We are not sure what you want. Try asking about an alliance, a pact, or a deal.']) end;
  end if;

  -- A word on how things stand with them (sometimes).
  if v_intent in ('state', 'other', 'greeting') or (random() < 0.2 and v_intent not in ('war_help', 'why_war', 'peace', 'why_no', 'spam', 'yes', 'no')) then
    v_state := case
      when v_enemies is not null then format('We are at war with %s.', v_enemies)
      when game.coalition_target(n.id) is not null then format('We stand with the coalition against %s.', game.nation_name(game.coalition_target(n.id)))
      when n.stability < 40 then 'Our people are restless; stability is low.'
      when n.world_rank <= 10 then format('We are among the great powers: number %s in the world.', n.world_rank)
      when v_their_al is not null then format('We are proud members of the %s.', (select name from game.alliances where id = v_their_al))
      else game.pick(array['Our economy is growing.', 'Our borders are quiet, for now.', 'We are building our strength.']) end;
    -- Don't repeat a line it said in its last few messages.
    if v_intent <> 'state' and exists (select 1 from (select body from game.diplo_chat where player_id = p.id and nation_id = n.id and not from_player
                                                      order by id desc limit 4) x where position(v_state in x.body) > 0) then
      v_state := '';
    end if;
    if v_intent = 'state' then v_core := v_state; v_state := ''; end if;
  end if;

  v_opener := case v_mood
    when 'friendly' then game.pick(array['', 'My friend, ', 'Ah, {leader}. '])
    when 'warm' then game.pick(array['', 'Greetings. ', ''])
    when 'neutral' then game.pick(array['', '', 'Hm. '])
    when 'cold' then game.pick(array['', 'Listen. '])
    else game.pick(array['', 'Enemy of {us}: ']) end;
  v_closer := case when random() > 0.35 then '' else case n.personality
    when 'aggressive' then game.pick(array['', 'Strength is the only language we respect.', 'Do not mistake our patience for weakness.'])
    when 'expansionist' then game.pick(array['', 'The map is not finished yet.', 'Every deal must make {us} bigger.'])
    when 'defensive' then game.pick(array['', 'We only want to be left in peace.', 'Our borders come first.'])
    when 'diplomatic' then game.pick(array['', 'Our door is always open.', 'Talking beats fighting.'])
    when 'mercantile' then game.pick(array['', 'Everything has a price.', 'Good business makes good neighbours.'])
    else game.pick(array['', 'We weigh every choice carefully.']) end end;

  if v_delta <> 0 and p_me is not null then perform game.rel_add(p_me, n.id, v_delta); end if;
  return jsonb_build_object(
    'body', trim(game.fill(v_opener || v_core || case when v_state <> '' then ' ' || v_state else '' end
                            || case when v_closer <> '' and v_intent not in ('state') then ' ' || v_closer else '' end, v_vars)),
    'intent', v_intent, 'mood', v_mood, 'rel_delta', v_delta, 'offer', v_offer,
    'rel', case when p_me is null then null else round(game.rel(p_me, n.id)) end);
end $$;

-- Send a message to a country; its reply comes straight back.
create or replace function public.diplo_chat_send(p_nation text, p_text text) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me();
  v_me text := (select id from game.nations where leader_id = p.id and status = 'active');
  n game.nations;
  v_text text := left(trim(coalesce(p_text, '')), 400);
  r jsonb;
  v_id bigint;
begin
  if v_text = '' then perform game.fail('Write something first.'); end if;
  select * into n from game.nations where id = p_nation;
  if not found then perform game.fail('Pick a country to talk to.'); end if;
  perform game.rate_limit(p.id::text, 'diplo_chat', 8, 10);
  insert into game.diplo_chat (player_id, nation_id, from_player, body) values (p.id, n.id, true, v_text);
  if n.id = v_me then
    r := jsonb_build_object('body', 'That''s your own country. Try talking to someone else.', 'mood', 'neutral', 'intent', 'self', 'rel_delta', 0);
  elsif n.status <> 'active' then
    r := jsonb_build_object('body', n.name || ' has fallen. Nobody is left to answer.', 'mood', 'neutral', 'intent', 'fallen', 'rel_delta', 0);
  elsif n.leader_id is not null then
    r := jsonb_build_object('body', format('%s is led by a player, %s. We passed your message on.', n.name, (select display_name from game.players where id = n.leader_id)),
      'mood', 'neutral', 'intent', 'player', 'rel_delta', 0);
    perform game.notify(n.leader_id, 'diplomacy', format('%s (%s) says:', p.display_name, coalesce(game.nation_name(v_me), 'no country')), v_text,
      jsonb_build_object('from', p.id));
  else
    r := game.diplo_reply(p, v_me, n, v_text);
  end if;
  insert into game.diplo_chat (player_id, nation_id, from_player, body, intent, mood, rel_delta, offer)
  values (p.id, n.id, false, r ->> 'body', r ->> 'intent', r ->> 'mood', (r ->> 'rel_delta')::numeric,
          case when jsonb_typeof(r -> 'offer') = 'object' then r -> 'offer' end)
  returning id into v_id;
  return r || jsonb_build_object('id', v_id, 'at', now());
end $$;

-- The conversation with one country, and how they feel about you.
create or replace function public.diplo_chat_history(p_nation text) returns jsonb
language plpgsql stable security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me(false);
  v_me text := (select id from game.nations where leader_id = p.id and status = 'active');
  n game.nations;
begin
  select * into n from game.nations where id = p_nation;
  if not found then perform game.fail('Pick a country to talk to.'); end if;
  return jsonb_build_object(
    'nation', jsonb_build_object('id', n.id, 'name', n.name, 'color', n.color, 'personality', n.personality, 'skill', n.ai_skill,
      'skill_name', game.skill_name(n.ai_skill), 'status', n.status, 'rank', n.world_rank,
      'leader', (select display_name from game.players where id = n.leader_id),
      'alliance', (select name from game.alliances where id = game.alliance_of(n.id))),
    'rel', case when v_me is null then null else round(game.rel(v_me, n.id)) end,
    'at_war', v_me is not null and game.at_war(v_me, n.id),
    'allied', v_me is not null and game.allied(v_me, n.id),
    'messages', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'at', c.at, 'mine', c.from_player, 'body', c.body, 'mood', c.mood,
        'rel_delta', c.rel_delta, 'offer', case when jsonb_typeof(c.offer) = 'object' then c.offer ||
          case when c.offer ? 'deal_id' then jsonb_build_object('status', (select status from game.chat_deals where id = (c.offer ->> 'deal_id')::bigint),
                                                               'expired', (select expires_at < now() from game.chat_deals where id = (c.offer ->> 'deal_id')::bigint))
               when c.offer ? 'offer_id' then jsonb_build_object('status', (select status from game.diplo_offers where id = (c.offer ->> 'offer_id')::bigint),
                                                                'expired', (select expires_at < now() from game.diplo_offers where id = (c.offer ->> 'offer_id')::bigint))
               else '{}'::jsonb end end) order by c.id)
      from (select * from game.diplo_chat where player_id = p.id and nation_id = n.id order by id desc limit 60) c), '[]'::jsonb));
end $$;

-- Everyone you've talked to, most recent first.
create or replace function public.diplo_chat_list() returns jsonb
language sql stable security definer set search_path = game, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('nation', x.nation_id, 'name', game.nation_name(x.nation_id), 'last', x.body, 'at', x.at, 'mine', x.from_player) order by x.at desc), '[]'::jsonb)
    from (select distinct on (nation_id) nation_id, body, at, from_player from game.diplo_chat
           where player_id = game.uid() order by nation_id, id desc) x
$$;

-- Accept or decline something a country offered in chat.
create or replace function public.diplo_chat_answer(p_message bigint, p_accept boolean) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me();
  v_me text := (select id from game.nations where leader_id = p.id and status = 'active');
  c game.diplo_chat;
  d game.chat_deals;
  n game.nations;
  v_reply text;
  v_delta numeric := 0;
  v_war bigint;
  o game.diplo_offers;
begin
  select * into c from game.diplo_chat where id = p_message and player_id = p.id and not from_player;
  if not found or jsonb_typeof(c.offer) is distinct from 'object' then perform game.fail('That offer isn''t yours.'); end if;
  select * into n from game.nations where id = c.nation_id;
  if c.offer ? 'offer_id' then
    -- A real diplomatic offer (alliance, pact, peace): the usual rules.
    select * into o from game.diplo_offers where id = (c.offer ->> 'offer_id')::bigint;
    if o.status <> 'open' or o.expires_at < now() then perform game.fail('That offer has closed.'); end if;
    perform public.respond_offer(o.id, p_accept);
    v_reply := case when p_accept then
      case o.kind when 'alliance' then 'Then we stand together. Our enemies are your enemies now.'
                  when 'nap' then 'Signed. Neither of us will strike the other.'
                  else 'Peace, at last. Our soldiers are coming home.' end
      else 'A pity. The offer will not wait forever.' end;
    v_delta := case when p_accept then 3 else -2 end;
  else
    select * into d from game.chat_deals where id = (c.offer ->> 'deal_id')::bigint and player_id = p.id for update;
    if not found then perform game.fail('That offer isn''t yours.'); end if;
    if d.status <> 'open' or d.expires_at < now() then perform game.fail('That offer has closed.'); end if;
    if not p_accept then
      update game.chat_deals set status = 'declined' where id = d.id;
      v_reply := case d.kind when 'gift' then 'Changed your mind? So be it.' else game.pick(array['Your loss.', 'Then we have nothing more to discuss on that.', 'As you wish.']) end;
      v_delta := case when d.kind = 'gift' then -1 else -2 end;
    else
      if v_me is null and d.kind <> 'gift' then perform game.fail('You need to lead a country for that.'); end if;
      if d.price > 0 then
        perform game.money(p.id, -d.price, 'diplomacy_payment', 'To ' || n.name, jsonb_build_object('nation', n.id, 'deal', d.id));
        update game.nations set treasury = treasury + d.price where id = n.id;
      end if;
      if d.kind = 'gift' then
        v_delta := least(25, 12.0 * d.price / greatest(n.income_h, 500000))
                 * case n.personality when 'mercantile' then 1.5 when 'diplomatic' then 1.2 when 'aggressive' then 0.6 else 1 end;
        v_reply := case when v_delta >= 15 then 'A princely gift! You have a true friend in ' || n.name || '.'
                        when v_delta >= 5 then 'Thank you. This will not be forgotten.'
                        else 'Thank you. Every little helps.' end;
      elsif d.kind = 'tribute' then
        v_delta := 20;
        if d.terms ->> 'then' = 'alliance' then
          if game.alliance_of(v_me) is not null and game.alliance_of(n.id) is null then
            perform game.join_alliance_internal(n.id, game.alliance_of(v_me));
          elsif game.alliance_of(v_me) is null then
            perform game.apply_offer(row(null, 'alliance', n.id, v_me, null,
              jsonb_build_object('name', coalesce((select name from game.alliances where id = game.alliance_of(n.id)), n.name || '–' || game.nation_name(v_me) || ' Accord')),
              'accepted', now(), now())::game.diplo_offers);
          else
            perform game.fail('You are both already in alliances.');
          end if;
          v_reply := 'Paid and done. We stand together now.';
        elsif d.terms ->> 'then' = 'nap' then
          perform game.apply_offer(row(null, 'nap', n.id, v_me, null, '{}'::jsonb, 'accepted', now(), now())::game.diplo_offers);
          v_reply := 'Paid. The pact is signed: no war between us for 48 hours.';
        else
          v_reply := 'Paid. You will find us much friendlier from now on.';
        end if;
      elsif d.kind = 'join_war' then
        v_war := game.war_between(v_me, d.terms ->> 'target');
        if v_war is not null then
          insert into game.war_sides (war_id, nation_id, side) values (v_war, n.id, game.side_of(v_war, v_me)) on conflict do nothing;
          perform game.rel_add(n.id, d.terms ->> 'target', -30);
          perform game.tell(d.terms ->> 'target', 'war', n.name || ' joins the war against you');
        else
          perform game.do_declare(n.id, d.terms ->> 'target');
        end if;
        perform game.news('war', format('%s goes to war with %s', n.name, game.nation_name(d.terms ->> 'target')),
          format('Paid by %s.', game.nation_name(v_me)), array[n.id, d.terms ->> 'target']);
        v_delta := 10;
        v_reply := format('Our army marches on %s.', game.nation_name(d.terms ->> 'target'));
      elsif d.kind = 'ally' then
        if game.alliance_of(n.id) is not null then perform game.fail(n.name || ' has joined another alliance since.'); end if;
        if game.alliance_of(v_me) is null then perform game.fail('You are no longer in an alliance.'); end if;
        if (select count(*) from game.alliance_members where alliance_id = game.alliance_of(v_me)) >= 6 then perform game.fail('Your alliance is full (6 nations).'); end if;
        perform game.join_alliance_internal(n.id, game.alliance_of(v_me));
        v_reply := 'We are proud to join you.';
        v_delta := 5;
      end if;
      update game.chat_deals set status = 'accepted' where id = d.id;
    end if;
  end if;
  if v_me is not null and v_delta <> 0 then perform game.rel_add(v_me, n.id, v_delta); end if;
  insert into game.diplo_chat (player_id, nation_id, from_player, body, intent, mood, rel_delta)
  values (p.id, n.id, false, v_reply, 'answer', null, v_delta);
  return jsonb_build_object('ok', true, 'reply', v_reply, 'rel', case when v_me is null then null else round(game.rel(v_me, n.id)) end);
end $$;

insert into game.ledger_kinds (kind, label, flow) values ('diplomacy_payment', 'Payments to other countries', 'world_out')
on conflict (kind) do nothing;

revoke all on function public.diplo_chat_send(text, text), public.diplo_chat_history(text), public.diplo_chat_list(), public.diplo_chat_answer(bigint, boolean) from public, anon;
grant execute on function public.diplo_chat_send(text, text), public.diplo_chat_history(text), public.diplo_chat_list(), public.diplo_chat_answer(bigint, boolean) to authenticated;
