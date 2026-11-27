-- AI countries answer anything.
--
-- The chat understood a fixed set of requests (alliances, pacts, deals,
-- peace, threats...) and met anything else with "We are not sure what you
-- want". Now any message gets a real answer in the country's own voice,
-- built from its actual situation:
--   * another country you mention: what they think of it, and why;
--   * its economy, army, government, people and land, plans, history, the
--     state of the world, how it feels, advice for you, small talk;
--   * yes/no questions get a yes or a no (by mood and personality) with a
--     reason; other questions and plain remarks get a considered reply.
-- It never says it doesn't know.

create or replace function game.chat_open(n game.nations, t text, p_me text, p_mood text, p_rel numeric, p_target text) returns text
language plpgsql set search_path = game, pg_temp as $$
declare
  h game.territories;
  v_land int;
  v_enemies text;
  v_al text;
  v_top game.nations;
  v_units jsonb;
  v_inf int;
  v_navy int;
  v_air int;
  v_mis int;
  v_techs int;
  v_q boolean := t ~ '\?\s*$' or t ~ '^\s*(is|are|do|does|did|can|could|will|would|should|have|has|am|was|were|who|what|where|when|which|how|why)\M';
  v_yn boolean := t ~ '^\s*(is|are|do|does|did|can|could|will|would|should|have|has|am|was|were)\M';
  v_rich text;
  v_strong text;
  v_tn game.nations;
  v_trel numeric;
  v_s text;
begin
  select * into h from game.territories where id = n.id;
  select count(*) into v_land from game.territories where controller_id = n.id;
  select string_agg(game.nation_name(case when s.side = 'att' then w.defender_id else w.attacker_id end), ', ') into v_enemies
    from game.war_sides s join game.wars w on w.id = s.war_id and w.status = 'active' where s.nation_id = n.id;
  select name into v_al from game.alliances where id = game.alliance_of(n.id);
  select * into v_top from game.nations where status = 'active' order by world_rank nulls last, power desc limit 1;
  select coalesce(sum(qty) filter (where unit in ('infantry', 'artillery', 'armor')), 0), coalesce(sum(qty) filter (where unit = 'naval'), 0),
         coalesce(sum(qty) filter (where unit = 'air'), 0), coalesce(sum(qty) filter (where unit = 'missile'), 0)
    into v_inf, v_navy, v_air, v_mis from game.garrisons where nation_id = n.id;
  select count(*) into v_techs from game.nation_techs where nation_id = n.id;
  v_rich := case when n.income_h >= 20000000 then 'one of the richest economies in the world'
                 when n.income_h >= 6000000 then 'a strong economy'
                 when n.income_h >= 2000000 then 'a modest but growing economy'
                 else 'a small economy that we are working hard to grow' end;
  v_strong := case when n.world_rank <= 5 then 'one of the five great powers'
                   when n.world_rank <= 20 then 'a serious military power'
                   when n.world_rank <= 60 then 'a middling power, stronger than most of our neighbours think'
                   else 'a small power that relies on its wits' end;

  -- Another country, mentioned by name.
  if p_target is not null and p_target <> n.id then
    select * into v_tn from game.nations where id = p_target;
    v_trel := game.rel(n.id, p_target);
    return case
      when game.at_war(n.id, p_target) then format('%s? We are at war with them. %s', v_tn.name,
        game.pick(array['They will regret it.', 'Until they come to the table, there is nothing more to say.', 'Our soldiers are dealing with them.']))
      when game.allied(n.id, p_target) then format('%s is our ally. We stand by our friends, and they stand by us.', v_tn.name)
      when v_tn.status <> 'active' then format('%s has fallen. A warning to every country that grows careless.', v_tn.name)
      when v_trel >= 40 then format('We like %s a great deal (relations %s). Good neighbours are worth more than gold.', v_tn.name, round(v_trel))
      when v_trel >= 10 then format('We are on good terms with %s (relations %s).', v_tn.name, round(v_trel))
      when v_trel <= -40 then format('We do not trust %s at all (relations %s). %s', v_tn.name, round(v_trel),
        case when n.personality in ('aggressive', 'expansionist') then 'One day that will be settled.' else 'We keep a close eye on them.' end)
      when v_trel <= -10 then format('Relations with %s are cool (%s). We watch them carefully.', v_tn.name, round(v_trel))
      when v_tn.world_rank <= 5 then format('%s is one of the great powers. Everyone is watching them, and so are we.', v_tn.name)
      else format('We have no strong feelings about %s. They are %s in the world; we are %s.', v_tn.name,
        coalesce('number ' || v_tn.world_rank, 'somewhere'), coalesce('number ' || n.world_rank, 'finding our place')) end;
  end if;

  -- Advice.
  if t ~ '(should (i|we)|advice|advise|recommend|suggest|\mtips?\M|how (do|can|should) (i|we)|help me|what would you do)' then
    if t ~ '(navy|naval|fleet|ships?\M|sea|troopship|boat)' then
      return game.pick(array['Yes, if you have coasts worth defending or enemies across the water. Fit your fleets as troopships and you can land an army anywhere in reach.',
                             'A navy is the only way to fight across the sea. Without one, your allies overseas cannot help you and you cannot reach your enemies.']);
    elsif t ~ '(army|troops|soldier|attack|war|invade|conquer)' then
      return game.pick(array['Only fight a war you can win quickly. Check their defences, bring artillery for forts and armour for open ground.',
                             'Mass your troops on one border and strike hard. Spreading thin loses wars.']);
    elsif t ~ '(money|econom|rich|cash|income|invest|business)' then
      return game.pick(array['Set taxes to normal, fund research and infrastructure, and let your businesses at home pay for your ambitions.',
                             'Money first, armies second. A rich country can always buy an army; a poor one cannot keep one.']);
    elsif t ~ '(missile|silo|nuke)' then
      return 'Missiles are expensive but they hit anywhere in range. Keep a silo near the front and upgrade their range before their warheads.';
    end if;
    return game.pick(array[
      'Build your economy first: taxes pay for everything else. Then research, then an army that can actually reach your enemies.',
      'Never fight two wars at once, and never fight one without allies.',
      'Forts and air defence are cheaper than losing a capital. Defend what you have before you take more.',
      'Make friends before you need them. Envoys and a few gifts go a long way.',
      'If you want to strike across the sea, you need a navy: troopships first, then fleets to escort them.',
      'Watch the great powers. When one grows too big, the rest of the world turns on it. Do not be that country too early.']);
  end if;

  -- The state of the world.
  if t ~ '(world|strongest|biggest|most powerful|who is winning|ranking|\mtop\M|best country|great powers|coalition|balance|empire)' then
    return format('The world is dangerous. %s is the strongest power, holding %s%% of the map. %s', v_top.name, round(v_top.share * 100, 1),
      case when game.coalition_target(n.id) is not null then format('We have joined the coalition against %s; no one should rule the world.', game.nation_name(game.coalition_target(n.id)))
           when v_top.id = n.id then 'And yes, that is us. Others are starting to notice.'
           else 'Whoever grows too big will find the rest of us standing together against them.' end);
  end if;

  -- Economy.
  if t ~ '(econom|money|rich|poor|\mgdp\M|trade|\mtax|budget|income|wealth|industr|\mjobs?\M|market|business|treasury|debt|bank|inflation|export|import)' then
    return format('%s has %s: about %s an hour in taxes from %s %s. %s', n.name, v_rich, '$' || to_char(round(n.income_h / 1000.0), 'FM999,999,999,990'), v_land,
      case when v_land = 1 then 'territory' else 'territories' end,
      case n.personality
        when 'mercantile' then 'Trade is our lifeblood, and we are always open to business.'
        when 'aggressive' then 'Money buys armies, and armies win wars.'
        when 'defensive' then 'Every coin we save goes into our defences.'
        when 'diplomatic' then 'Prosperity shared is prosperity doubled.'
        when 'expansionist' then 'More land means more taxes. That is our plan.'
        else 'We spend carefully and invest in research.' end);
  end if;

  -- Military.
  if t ~ '(army|armies|military|troops|soldier|navy|naval|fleet|ships?\M|air ?force|plane|jet|missile|nuke|nuclear|weapon|defen[cs]e|strong|power|weak|tanks?\M|artillery|forces)' then
    return format('We are %s, with %s. %s', v_strong,
      concat_ws(', ',
        case when v_inf > 0 then 'a standing army' end,
        case when v_navy > 0 then case when v_navy >= 10 then 'a sizeable navy' else 'a small navy' end end,
        case when v_air > 0 then 'an air force' end,
        case when v_mis > 0 then 'missiles in our silos' end,
        case when v_inf = 0 and v_navy = 0 and v_air = 0 then 'very little in the way of an army, for now' end),
      case when p_mood in ('hostile', 'cold') then 'How many exactly is our business, not yours.'
           else game.pick(array['Exact numbers stay secret, even between friends.', 'We could say more, but every country keeps its secrets.', 'Enough to make any attacker think twice.']) end);
  end if;

  -- Government.
  if t ~ '(leader|government|president|king|queen|prime minister|ruler|who (runs|rules|leads)|in charge|regime|democra|dictat|election|\mvote|\mai\M|robot|\mbot\M|computer)' then
    return format('%s is run by a %s government: %s. %s', n.name, lower(game.skill_name(n.ai_skill)),
      case n.personality
        when 'aggressive' then 'we strike first and ask questions later'
        when 'expansionist' then 'we believe a country must grow or wither'
        when 'defensive' then 'we put our own borders before everything else'
        when 'diplomatic' then 'we would rather talk than fight'
        when 'mercantile' then 'we think every problem has a price'
        else 'we weigh every choice carefully' end,
      case when n.stability >= 70 then 'Our people are content.' when n.stability >= 40 then 'Our people grumble, as people do.' else 'Our people are restless, and we know it.' end);
  end if;

  -- People, land and life.
  if t ~ '(people|population|citizen|culture|\mfood|\meat|language|speak|music|sport|football|soccer|tradition|holiday|religion|weather|climate|capital|\mcit(y|ies)\M|touris|visit|beautiful|landscape|nature)' then
    return format('%s is home to %s people in %s. %s', n.name,
      case when h.pop_m >= 1000 then round(h.pop_m / 1000, 1) || ' billion' when h.pop_m >= 1 then round(h.pop_m) || ' million' else round(h.pop_m * 1000) || ' thousand' end,
      coalesce(h.region, h.continent),
      game.pick(array['Come and see it for yourself, if you come in peace.', 'Our people are proud, hard-working and stubborn.',
                      'We love our land, and we will defend every hill of it.', 'Visitors are welcome. Armies are not.']));
  end if;

  -- Plans and ambitions.
  if t ~ '(plan|goal|future|\mnext\M|ambition|dream|strateg|intend|going to do|what will you|what do you want|aim)' then
    return case n.personality
      when 'aggressive' then format('To be feared. %s', coalesce('First we finish our war with ' || v_enemies || '.', 'We are choosing our next target as we speak.'))
      when 'expansionist' then 'To grow. Weak neighbours with good land do not stay independent for long.'
      when 'defensive' then 'To be left alone, behind forts no one can break.'
      when 'diplomatic' then format('Friends in every corner of the world. %s', coalesce('The ' || v_al || ' is a good start.', 'We are looking for allies.'))
      when 'mercantile' then 'To be the richest country on the map. Wars are bad for business, unless they are someone else''s.'
      else format('To climb the rankings: we are %s now, and we mean to rise.', coalesce('number ' || n.world_rank, 'unranked')) end;
  end if;


  -- History and identity.
  if t ~ '(history|\mold\M|founded|\mpast\M|story|about (yourself|you)|who are you|tell me about|what are you)' then
    return format('We are %s, in %s. %s %s', n.name, coalesce(h.region, h.continent),
      case when v_land > 1 then format('Today we hold %s territories.', v_land) else 'We hold our homeland, and nothing more, for now.' end,
      game.pick(array['Our history is long and full of hard winters. We are still here.', 'Empires have come and gone around us. We endured.', 'Every generation of ours has had to fight for what we have.']));
  end if;

  -- Feelings.
  if t ~ '(feel|happy|\msad\M|angry|afraid|scared|worried|mood|bored|tired|lonely|excited)' then
    return case p_mood
      when 'friendly' then 'With friends like you? Confident.'
      when 'warm' then 'Hopeful. Things are going well for us.'
      when 'neutral' then 'Calm. Watchful. As a country should be.'
      when 'cold' then 'Uneasy, if you must know. Especially about you.'
      else 'Angry. And determined.' end
      || case when v_enemies is not null then format(' The war with %s weighs on us.', v_enemies) else '' end;
  end if;


  -- Small talk.
  if t ~ '(joke|funny|laugh|favou?rite|\mfun\M|\mgame\M|secret|sing|dance|party|bored)' then
    return game.pick(array[
      'A joke? Our finance minister once balanced the budget. Nobody believed him either.',
      'Our favourite thing is a quiet border and a full treasury.',
      'Secrets are what keep countries alive. You will have to earn ours.',
      'We laugh, but we never let our guard down.']);
  end if;

  -- Any other yes/no question: an answer, with a reason.
  if v_yn then
    return case
      when p_mood in ('friendly', 'warm') then game.pick(array[
        'Yes, we believe so, and we would tell a friend the truth.',
        'Yes. Between friends there is little we would not consider.',
        'We think so, yes. Ask us again if things change.'])
      when p_mood = 'neutral' then game.pick(array[
        'Perhaps. It depends on what it does for ' || n.name || '.',
        'Possibly. Show us it is in our interest and the answer will be yes.',
        'Not today. Tomorrow, who knows?'])
      else game.pick(array[
        'No. Not for you.',
        'The answer is no, and you know why.',
        'No. Mend things between us first.']) end;
  end if;

  -- A remark rather than a question: acknowledged, in character.
  if not v_q then
    return game.pick(array['Noted.', 'We hear you.', 'Is that so? Interesting.', 'We will remember that.', 'Hm. Go on.'])
      || ' ' || case
        when p_mood in ('friendly', 'warm') then game.pick(array['It is always good to hear from you.', 'Tell us more.'])
        when p_mood = 'hostile' then 'Though from you, words count for little.'
        else case n.personality when 'mercantile' then 'Is there business in it for us?' when 'aggressive' then 'Now, was there something you wanted?' else 'What else is on your mind?' end end;
  end if;

  -- Other questions: a considered reply in character.
  v_s := case n.personality
    when 'aggressive' then game.pick(array['Interesting question. Our answer is always the same: strength first.', 'We hear you. In this world, the strong decide; the rest adapt.'])
    when 'expansionist' then game.pick(array['A fair thought. For us, everything comes back to land and growth.', 'Maybe. We judge everything by one question: does it make us bigger?'])
    when 'defensive' then game.pick(array['We will think about it, from behind our walls.', 'Good question. Our answer is caution, as always.'])
    when 'diplomatic' then game.pick(array['A good question, and one worth talking through together.', 'We like that you ask. More countries should talk before they fight.'])
    when 'mercantile' then game.pick(array['Everything has a price, and that includes ideas like yours.', 'Interesting. If there is profit in it, we are listening.'])
    else game.pick(array['That deserves a careful answer. We are thinking it over.', 'Fair point. We weigh every choice, and that one too.']) end;
  return v_s || ' ' || case
    when v_enemies is not null then format('Right now our minds are on the war with %s.', v_enemies)
    when p_mood in ('friendly', 'warm') then 'What else is on your mind, friend?'
    when p_mood = 'hostile' then 'But words between us are cheap right now.'
    else format('Ask us about our economy, our army, our plans, or any country you like.') end;
end $$;

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
  v_flattery_all numeric;
  v_paid_today int;
  v_open game.chat_deals;
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
  select coalesce(sum(rel_delta), 0) into v_flattery_all from game.diplo_chat
   where player_id = p.id and not from_player and intent = 'compliment' and at > now() - interval '1 day';
  -- Paid deals with this country in the last day, and any offer still open.
  select count(*) into v_paid_today from game.chat_deals
   where player_id = p.id and nation_id = n.id and status = 'accepted' and kind in ('tribute', 'gift') and created_at > now() - interval '1 day';
  select * into v_open from game.chat_deals
   where player_id = p.id and nation_id = n.id and status = 'open' and expires_at > now() and kind in ('tribute', 'gift', 'join_war')
   order by id desc limit 1;
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
    -- Asking them for money: always refused (countries never pay players).
    when t ~ '\m(pay|give|send|transfer|owe)\M\s+(me|us)\M|\m(i|we)\s+(want|need|demand)\s+(your\s+)?(money|cash|gold|\$|[0-9])|\mgive\s+(me|us)\s+money|\mtribute\s+to\s+(me|us)|\mpay\s+up\M|\mprotection money' then 'demand'
    -- A request about another country comes before anything that sounds like a threat.
    when v_target is not null and t ~ '(help|join|with (me|us)|for (me|us)|together|alongside|against|attack|invade|declare|\mwar\M|fight|take (down|out)|go after|deal with)' then 'war_help'
    when t ~ '\m(i will|i''ll|ill|we will|we''ll|gonna|going to|about to)\M\s.{0,25}(attack|invade|destroy|crush|nuke|wipe|conquer|take over|end you|annex|burn)|or else|you will regret|you''ll regret|prepare (for|to) (die|war|lose)|watch your back|\mi will declare|\mi''ll declare' then 'threat'
    when v_amount > 0 and t ~ '(gift|donat|\m(i|we)(''ll|\s+will|\s+can|\s+could|\s+shall)?\s+(give|send|pay|offer)\M|here''?s|\mfor you\M|\mtake this)' then 'gift'
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
  -- A paid deal is already on the table, or two have been paid today:
  -- no new one (this stops buying goodwill over and over).
  if v_intent in ('deal', 'gift', 'war_help') and v_open.id is not null then
    v_intent := 'pending';
  elsif v_intent in ('deal', 'gift') and v_paid_today >= 2 then
    v_intent := 'enough';
  end if;
  if p_me is null and v_intent not in ('greeting', 'compliment', 'insult', 'state', 'other', 'spam') then
    v_core := 'Lead a country first, and then we can talk as equals.';
  elsif v_intent = 'pending' then
    v_core := format('Our offer is still on the table: %s. Accept it or decline it first.', game.fmt(v_open.price));
  elsif v_intent = 'enough' then
    v_core := game.pick(array['You have already bought plenty of goodwill from us today. Come back tomorrow.', 'Enough deals for one day. Our goodwill is not for sale twice over.']);
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
  elsif v_intent = 'demand' then
    v_delta := -(2 + round(3 * v_aggr));
    v_core := case
      when n.personality = 'aggressive' then game.pick(array['Pay you? Come and take it, if you can.', 'We do not pay tribute. We collect it.'])
      when n.personality = 'mercantile' then game.pick(array['Money flows towards us, not away. That is how we stay rich.', 'We sell goodwill; we do not give money away.'])
      when v_ratio >= 3 and v_caution >= 0.6 then 'We will not pay you. If you are worried about war between us, ask for a pact.'
      else game.pick(array['We will not pay you. Countries do not hand out money for asking.', 'No. Our treasury is for our own people.']) end;
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
      v_price := game.chat_price(n, 6, v_rel, p_me) * (1 + v_paid_today);
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
      v_price := game.chat_price(n, 6, v_rel, p_me) * (1 + v_paid_today);
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
      v_price := game.chat_price(n, 3, v_rel, p_me) * (1 + v_paid_today);
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
      v_price := game.chat_price(n, 2, v_rel, p_me) * (1 + v_paid_today);
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
    v_delta := greatest(0, least(1 + round(2 * v_dip), 4 - v_flattery, 10 - v_flattery_all));
    v_core := case when v_delta = 0 then 'Kind words are cheap, and you have spent plenty today.'
      when v_mood = 'hostile' then 'Flattery from an enemy. We are not fooled, but we heard you.'
      else game.pick(array['Kind words. They are appreciated.', 'You flatter us, {leader}. It is working, a little.', 'Our people will be glad to hear it.']) end;
  elsif v_intent = 'greeting' then
    v_delta := 0;
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
      v_core := case v_intent when 'yes' then game.pick(array['Good. Then let us keep talking. What do you have in mind?', 'We are glad we agree. What next?']) else game.pick(array['Very well.', 'As you wish. Our door stays open.']) end;
    end if;
  else
    -- Anything else: a real answer, from what this country knows and is.
    v_core := game.chat_open(n, t, p_me, v_mood, v_rel, v_target);
  end if;

  -- A word on how things stand with them (sometimes).
  if v_intent in ('state', 'greeting') or (random() < 0.2 and v_intent not in ('war_help', 'why_war', 'peace', 'why_no', 'spam', 'yes', 'no', 'other')) then
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
