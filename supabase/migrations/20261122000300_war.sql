-- Nations, part 2: relations, alliances, pacts, war, armies, battles, peace,
-- the world tick, world domination and what the client reads.

-- ---------------------------------------------------------------------------
-- Relations, treaties, alliances
-- ---------------------------------------------------------------------------
create function game.rel(p_a text, p_b text) returns numeric
language sql stable set search_path = game, pg_temp as $$
  select coalesce((select score from game.relations where a = least(p_a, p_b) and b = greatest(p_a, p_b)), 0)
$$;

create function game.rel_add(p_a text, p_b text, p_d numeric) returns void
language sql set search_path = game, pg_temp as $$
  insert into game.relations as r (a, b, score) values (least(p_a, p_b), greatest(p_a, p_b), greatest(-100, least(100, p_d)))
  on conflict (a, b) do update set score = greatest(-100, least(100, r.score + p_d)), updated_at = now()
$$;

create function game.alliance_of(p_nation text) returns bigint
language sql stable set search_path = game, pg_temp as $$
  select alliance_id from game.alliance_members where nation_id = p_nation
$$;

create function game.allied(p_a text, p_b text) returns boolean
language sql stable set search_path = game, pg_temp as $$
  select p_a = p_b or coalesce(game.alliance_of(p_a) = game.alliance_of(p_b), false)
$$;

create function game.treaty(p_a text, p_b text) returns game.treaties
language sql stable set search_path = game, pg_temp as $$
  select * from game.treaties where a = least(p_a, p_b) and b = greatest(p_a, p_b) and until > now() order by until desc limit 1
$$;

create function game.at_war(p_a text, p_b text) returns boolean
language sql stable set search_path = game, pg_temp as $$
  select exists (
    select 1 from game.war_sides x join game.war_sides y on y.war_id = x.war_id and y.side <> x.side
      join game.wars w on w.id = x.war_id and w.status = 'active'
     where x.nation_id = p_a and y.nation_id = p_b)
$$;

create function game.war_between(p_a text, p_b text) returns bigint
language sql stable set search_path = game, pg_temp as $$
  select x.war_id from game.war_sides x join game.war_sides y on y.war_id = x.war_id and y.side <> x.side
    join game.wars w on w.id = x.war_id and w.status = 'active'
   where x.nation_id = p_a and y.nation_id = p_b order by w.started_at limit 1
$$;

create function game.side_of(p_war bigint, p_nation text) returns text
language sql stable set search_path = game, pg_temp as $$
  select side from game.war_sides where war_id = p_war and nation_id = p_nation
$$;

create function game.add_treaty(p_kind text, p_a text, p_b text, p_hours int) returns void
language sql set search_path = game, pg_temp as $$
  insert into game.treaties (kind, a, b, until) values (p_kind, least(p_a, p_b), greatest(p_a, p_b), now() + make_interval(hours => p_hours))
$$;

create function game.nation_name(p_id text) returns text
language sql stable set search_path = game, pg_temp as $$ select name from game.nations where id = p_id $$;

create function game.leave_alliance_internal(p_nation text) returns void
language plpgsql set search_path = game, pg_temp as $$
declare
  v_al bigint := game.alliance_of(p_nation);
  m text;
begin
  if v_al is null then return; end if;
  delete from game.alliance_members where nation_id = p_nation;
  for m in select nation_id from game.alliance_members where alliance_id = v_al loop
    perform game.rel_add(p_nation, m, -10);
  end loop;
  if not exists (select 1 from game.alliance_members where alliance_id = v_al) then
    delete from game.alliances where id = v_al;
  else
    update game.alliances set founder_id = (select nation_id from game.alliance_members where alliance_id = v_al order by joined_at limit 1)
     where id = v_al and founder_id = p_nation;
  end if;
end $$;

create function game.join_alliance_internal(p_nation text, p_alliance bigint) returns void
language plpgsql set search_path = game, pg_temp as $$
declare
  m text;
begin
  insert into game.alliance_members (nation_id, alliance_id) values (p_nation, p_alliance);
  for m in select nation_id from game.alliance_members where alliance_id = p_alliance and nation_id <> p_nation loop
    perform game.rel_add(p_nation, m, 15);
    perform game.tell(m, 'diplomacy', game.nation_name(p_nation) || ' joined your alliance');
  end loop;
  perform game.leader_xp(p_nation, 100, 'Joined an alliance', 'alliances');
  perform game.news('alliance', format('%s joins %s', game.nation_name(p_nation), (select name from game.alliances where id = p_alliance)),
    null, array[p_nation]);
end $$;

create function game.create_alliance_internal(p_nation text, p_name text) returns bigint
language plpgsql set search_path = game, pg_temp as $$
declare
  v bigint;
begin
  insert into game.alliances (name, color, founder_id)
  values (p_name, (select color from game.nations where id = p_nation), p_nation) returning id into v;
  insert into game.alliance_members (nation_id, alliance_id) values (p_nation, v);
  perform game.leader_xp(p_nation, 100, 'Founded ' || p_name, 'alliances');
  perform game.news('alliance', format('%s founds the %s', game.nation_name(p_nation), p_name), null, array[p_nation]);
  return v;
end $$;

-- ---------------------------------------------------------------------------
-- Offers between nations. An AI answers at once (game.ai_accepts, in the AI
-- file); a human leader gets the offer in their inbox.
-- ---------------------------------------------------------------------------
create function game.apply_offer(o game.diplo_offers) returns void
language plpgsql set search_path = game, pg_temp as $$
declare
  v_al bigint;
begin
  if o.kind = 'alliance' then
    if game.alliance_of(o.to_id) is not null then perform game.fail(game.nation_name(o.to_id) || ' is already in an alliance.'); end if;
    v_al := coalesce(game.alliance_of(o.from_id),
                     game.create_alliance_internal(o.from_id, coalesce(o.terms ->> 'name', game.nation_name(o.from_id) || ' Pact')));
    if (select count(*) from game.alliance_members where alliance_id = v_al) >= 6 then perform game.fail('That alliance is full (6 nations).'); end if;
    if exists (select 1 from game.alliance_members m where m.alliance_id = v_al and game.at_war(m.nation_id, o.to_id)) then
      perform game.fail('They are at war with a member of that alliance.');
    end if;
    perform game.join_alliance_internal(o.to_id, v_al);
  elsif o.kind = 'nap' then
    perform game.add_treaty('nap', o.from_id, o.to_id, 48);
    perform game.rel_add(o.from_id, o.to_id, 10);
    perform game.news('pact', format('%s and %s sign a non-aggression pact', game.nation_name(o.from_id), game.nation_name(o.to_id)),
      'Neither may declare war on the other for 48 hours.', array[o.from_id, o.to_id]);
  elsif o.kind = 'peace' then
    perform game.end_war(o.war_id, o.terms ->> 'terms', o.terms ->> 'winner', null, coalesce((o.terms ->> 'amount')::bigint, 0));
  end if;
end $$;

create function game.make_offer(p_kind text, p_from text, p_to text, p_war bigint, p_terms jsonb) returns jsonb
language plpgsql set search_path = game, pg_temp as $$
declare
  o game.diplo_offers;
  v_human boolean := (select leader_id is not null from game.nations where id = p_to);
begin
  if exists (select 1 from game.diplo_offers where kind = p_kind and from_id = p_from and to_id = p_to and status = 'open'
               and coalesce(war_id, 0) = coalesce(p_war, 0)) then
    perform game.fail('You already have an offer waiting for an answer.');
  end if;
  insert into game.diplo_offers (kind, from_id, to_id, war_id, terms) values (p_kind, p_from, p_to, p_war, coalesce(p_terms, '{}'::jsonb))
  returning * into o;
  if not v_human then
    if game.ai_accepts(o) then
      perform game.apply_offer(o);
      update game.diplo_offers set status = 'accepted' where id = o.id;
      return jsonb_build_object('status', 'accepted', 'id', o.id);
    end if;
    update game.diplo_offers set status = 'declined' where id = o.id;
    return jsonb_build_object('status', 'declined', 'id', o.id);
  end if;
  perform game.tell(p_to, 'diplomacy',
    case p_kind when 'alliance' then game.nation_name(p_from) || ' invites you to an alliance'
                when 'nap' then game.nation_name(p_from) || ' proposes a non-aggression pact'
                else game.nation_name(p_from) || ' proposes peace' end,
    'Open your nation''s Diplomacy tab to answer.', jsonb_build_object('offer', o.id));
  return jsonb_build_object('status', 'open', 'id', o.id);
end $$;

create function public.respond_offer(p_id bigint, p_accept boolean) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  n game.nations := game.my_nation_row(game.me());
  o game.diplo_offers;
begin
  select * into o from game.diplo_offers where id = p_id and to_id = n.id for update;
  if not found then perform game.fail('That offer isn''t yours.'); end if;
  if o.status <> 'open' or o.expires_at < now() then perform game.fail('That offer has closed.'); end if;
  if p_accept then
    perform game.apply_offer(o);
    perform game.count((select leader_id from game.nations where id = n.id), 'diplomacy');
  end if;
  update game.diplo_offers set status = case when p_accept then 'accepted' else 'declined' end where id = o.id;
  perform game.tell(o.from_id, 'diplomacy', format('%s %s your offer', n.name, case when p_accept then 'accepted' else 'turned down' end));
  return jsonb_build_object('status', case when p_accept then 'accepted' else 'declined' end);
end $$;

-- ---------------------------------------------------------------------------
-- Diplomatic actions
-- ---------------------------------------------------------------------------
create function game.target_nation(p_id text) returns game.nations
language plpgsql set search_path = game, pg_temp as $$
declare
  t game.nations;
begin
  select * into t from game.nations where id = p_id;
  if not found or t.status <> 'active' then perform game.fail('That nation isn''t on the map right now.'); end if;
  return t;
end $$;

create function game.do_envoy(p_nation text, p_target text) returns numeric
language plpgsql set search_path = game, pg_temp as $$
declare
  v numeric := 10 * (1 + game.tech_fx(p_nation, 'diplo'));
begin
  if p_nation = p_target then perform game.fail('That''s you.'); end if;
  if game.at_war(p_nation, p_target) then perform game.fail('You are at war. Propose peace instead.'); end if;
  perform game.rate_limit(p_nation || '>' || p_target, 'envoy', 1, 1.0 / 30);
  perform game.spend(p_nation, 2500000, 'an envoy');
  perform game.rel_add(p_nation, p_target, v);
  update game.relations set rival_a = case when a = p_nation then false else rival_a end,
                            rival_b = case when b = p_nation then false else rival_b end
   where a = least(p_nation, p_target) and b = greatest(p_nation, p_target);
  return game.rel(p_nation, p_target);
end $$;

create function game.do_denounce(p_nation text, p_target text) returns numeric
language plpgsql set search_path = game, pg_temp as $$
begin
  if p_nation = p_target then perform game.fail('That''s you.'); end if;
  if game.allied(p_nation, p_target) then perform game.fail('You can''t denounce an ally. Leave the alliance first.'); end if;
  perform game.rate_limit(p_nation || '>' || p_target, 'denounce', 1, 1.0 / 60);
  perform game.rel_add(p_nation, p_target, -25);
  update game.relations set rival_a = case when a = p_nation then true else rival_a end,
                            rival_b = case when b = p_nation then true else rival_b end,
                            denounced_at = now()
   where a = least(p_nation, p_target) and b = greatest(p_nation, p_target);
  perform game.news('denounce', format('%s denounces %s', game.nation_name(p_nation), game.nation_name(p_target)),
    'Relations have soured. Watch the border.', array[p_nation, p_target]);
  perform game.tell(p_target, 'diplomacy', game.nation_name(p_nation) || ' has denounced you',
    'Relations have dropped. A denunciation often comes before a war.');
  return game.rel(p_nation, p_target);
end $$;

create function public.diplo_envoy(p_nation text) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me();
  n game.nations := game.my_nation_row(p);
  v numeric;
begin
  perform game.target_nation(p_nation);
  v := game.do_envoy(n.id, p_nation);
  perform game.count(p.id, 'diplomacy');
  perform game.grant_xp(p.id, 20, 'Sent an envoy');
  return jsonb_build_object('relations', v);
end $$;

create function public.diplo_denounce(p_nation text) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me();
  n game.nations := game.my_nation_row(p);
  v numeric;
begin
  perform game.target_nation(p_nation);
  v := game.do_denounce(n.id, p_nation);
  perform game.count(p.id, 'diplomacy');
  return jsonb_build_object('relations', v);
end $$;

create function public.diplo_nap(p_nation text) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me();
  n game.nations := game.my_nation_row(p);
begin
  perform game.require_level(p.id, 'nap');
  perform game.target_nation(p_nation);
  if p_nation = n.id then perform game.fail('That''s you.'); end if;
  if game.at_war(n.id, p_nation) then perform game.fail('You are at war. Propose peace instead.'); end if;
  if (game.treaty(n.id, p_nation)).id is not null then perform game.fail('You already have a treaty with them.'); end if;
  perform game.count(p.id, 'diplomacy');
  return game.make_offer('nap', n.id, p_nation, null, '{}');
end $$;

create function public.alliance_create(p_name text) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me();
  n game.nations := game.my_nation_row(p);
  v_name text := btrim(coalesce(p_name, ''));
begin
  perform game.require_level(p.id, 'alliance');
  if game.alliance_of(n.id) is not null then perform game.fail('Leave your alliance first.'); end if;
  if length(v_name) < 3 or length(v_name) > 30 then perform game.fail('Alliance names are 3 to 30 characters.'); end if;
  v_name := game.clean_name(v_name, v_name);
  return jsonb_build_object('alliance', game.create_alliance_internal(n.id, v_name));
end $$;

create function public.alliance_invite(p_nation text) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me();
  n game.nations := game.my_nation_row(p);
begin
  perform game.require_level(p.id, 'alliance');
  perform game.target_nation(p_nation);
  if p_nation = n.id then perform game.fail('That''s you.'); end if;
  if game.alliance_of(p_nation) is not null then perform game.fail('They are already in an alliance.'); end if;
  if game.alliance_of(n.id) is null then perform game.fail('Found an alliance first.'); end if;
  if (select count(*) from game.alliance_members where alliance_id = game.alliance_of(n.id)) >= 6 then
    perform game.fail('Your alliance is full (6 nations).');
  end if;
  perform game.count(p.id, 'diplomacy');
  return game.make_offer('alliance', n.id, p_nation, null, '{}');
end $$;

create function public.alliance_leave() returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  n game.nations := game.my_nation_row(game.me());
begin
  if game.alliance_of(n.id) is null then perform game.fail('You aren''t in an alliance.'); end if;
  perform game.leave_alliance_internal(n.id);
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------------------
-- War
-- ---------------------------------------------------------------------------
create function game.do_declare(p_nation text, p_target text) returns bigint
language plpgsql set search_path = game, pg_temp as $$
declare
  n game.nations;
  t game.nations;
  tr game.treaties;
  v_war bigint;
  m text;
  x text;
begin
  select * into n from game.nations where id = p_nation for update;
  t := game.target_nation(p_target);
  if p_nation = p_target then perform game.fail('That''s you.'); end if;
  if game.allied(p_nation, p_target) then perform game.fail(t.name || ' is your ally.'); end if;
  if game.at_war(p_nation, p_target) then perform game.fail('You are already at war with ' || t.name || '.'); end if;
  tr := game.treaty(p_nation, p_target);
  if tr.id is not null then
    perform game.fail(format('You have a %s with %s until %s.', case tr.kind when 'nap' then 'non-aggression pact' else 'truce' end,
      t.name, to_char(tr.until at time zone 'utc', 'HH24:MI "UTC" Mon DD')));
  end if;
  if t.protected_until > now() then
    perform game.fail(format('%s has a new leader and is protected until %s.', t.name, to_char(t.protected_until at time zone 'utc', 'HH24:MI "UTC" Mon DD')));
  end if;
  if (select count(*) from game.wars where attacker_id = p_nation and status = 'active') >= 3 then
    perform game.fail('You are already fighting three wars of your own.');
  end if;
  insert into game.wars (name, attacker_id, defender_id) values (format('%s–%s War', n.name, t.name), p_nation, p_target)
  returning id into v_war;
  insert into game.war_sides (war_id, nation_id, side) values (v_war, p_nation, 'att'), (v_war, p_target, 'def');
  -- The target's allies come to its defence.
  for m in select nation_id from game.alliance_members where alliance_id = game.alliance_of(p_target) and nation_id <> p_target loop
    insert into game.war_sides (war_id, nation_id, side) values (v_war, m, 'def') on conflict do nothing;
    perform game.rel_add(p_nation, m, -20);
    perform game.tell(m, 'war', format('Your ally %s has been attacked by %s', t.name, n.name), 'Your alliance has brought you into the war.');
  end loop;
  update game.nations set protected_until = null,
    stability = greatest(0, stability - 10 / (1 + game.tech_fx(p_nation, 'diplo')))
   where id = p_nation;
  perform game.rel_add(p_nation, p_target, -40);
  -- Infamy: the target's neighbours remember.
  for x in select distinct t2.controller_id from game.territory_links l join game.territories t2 on t2.id = l.b
            where l.a in (select id from game.territories where owner_id = p_target) and t2.controller_id not in (p_nation, p_target) loop
    perform game.rel_add(p_nation, x, -5);
  end loop;
  delete from game.diplo_offers where status = 'open' and ((from_id = p_nation and to_id = p_target) or (from_id = p_target and to_id = p_nation));
  perform game.news('war', format('%s declares war on %s', n.name, t.name), null, array[p_nation, p_target], jsonb_build_object('war', v_war));
  perform game.tell(p_target, 'war', n.name || ' has declared war on you!', 'Reinforce your borders, call on your allies, or sue for peace.',
    jsonb_build_object('war', v_war));
  perform game.leader_xp(p_nation, 25, 'Declared war on ' || t.name, 'wars');
  return v_war;
end $$;

create function public.declare_war(p_nation text) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me();
  n game.nations := game.my_nation_row(p);
begin
  perform game.require_level(p.id, 'war');
  perform game.rate_limit(n.id, 'declare_war', 2, 0.1);
  return jsonb_build_object('war', game.do_declare(n.id, p_nation));
end $$;

-- War score from the attackers' side: occupied land (by value) and battles.
create function game.war_score(p_war bigint) returns numeric
language plpgsql stable set search_path = game, pg_temp as $$
declare
  w game.wars;
  v_att numeric;
  v_def numeric;
  v_att_occ numeric;
  v_def_occ numeric;
begin
  select * into w from game.wars where id = p_war;
  select coalesce(sum(t.value), 0) into v_att from game.territories t join game.war_sides s on s.nation_id = t.owner_id and s.war_id = p_war and s.side = 'att';
  select coalesce(sum(t.value), 0) into v_def from game.territories t join game.war_sides s on s.nation_id = t.owner_id and s.war_id = p_war and s.side = 'def';
  select coalesce(sum(t.value), 0) into v_att_occ from game.territories t
    join game.war_sides o on o.nation_id = t.owner_id and o.war_id = p_war and o.side = 'def'
    join game.war_sides c on c.nation_id = t.controller_id and c.war_id = p_war and c.side = 'att';
  select coalesce(sum(t.value), 0) into v_def_occ from game.territories t
    join game.war_sides o on o.nation_id = t.owner_id and o.war_id = p_war and o.side = 'att'
    join game.war_sides c on c.nation_id = t.controller_id and c.war_id = p_war and c.side = 'def';
  return greatest(-100, least(100,
    100 * v_att_occ / greatest(v_def, 1e-9) - 100 * v_def_occ / greatest(v_att, 1e-9) + 3 * (w.att_wins - w.def_wins)));
end $$;

-- Send an occupier's troops home when they no longer hold the land.
create function game.send_home(p_territory text, p_nation text) returns void
language plpgsql set search_path = game, pg_temp as $$
declare
  g record;
  v_home text;
begin
  select id into v_home from game.territories where controller_id = p_nation order by (id = p_nation) desc, value desc limit 1;
  for g in delete from game.garrisons where territory_id = p_territory and nation_id = p_nation returning unit, qty loop
    if v_home is not null then perform game.garrison_add(v_home, p_nation, g.unit, g.qty); end if;
  end loop;
end $$;

-- A nation with no land left has fallen.
create function game.check_fallen(p_nation text) returns boolean
language plpgsql set search_path = game, pg_temp as $$
declare
  n game.nations;
  w record;
  t record;
begin
  select * into n from game.nations where id = p_nation;
  if n.status <> 'active' or exists (select 1 from game.territories where controller_id = p_nation) then return false; end if;
  -- Capitulation: whoever occupies its land keeps it.
  for w in select s.war_id, x.attacker_id, x.defender_id, s.side from game.war_sides s join game.wars x on x.id = s.war_id
            where s.nation_id = p_nation and x.status = 'active' loop
    if w.attacker_id = p_nation or w.defender_id = p_nation then
      perform game.end_war(w.war_id, 'annex', case w.side when 'att' then 'def' else 'att' end, n.name || ' capitulated');
    else
      delete from game.war_sides where war_id = w.war_id and nation_id = p_nation;
    end if;
  end loop;
  if (select status from game.nations where id = p_nation) = 'fallen' then return true; end if;
  for t in select id, controller_id from game.territories where owner_id = p_nation and controller_id <> p_nation loop
    update game.territories set owner_id = t.controller_id, occupied_at = null where id = t.id;
  end loop;
  if exists (select 1 from game.territories where owner_id = p_nation or controller_id = p_nation) then return false; end if;
  perform game.leave_alliance_internal(p_nation);
  delete from game.garrisons where nation_id = p_nation;
  delete from game.recruit_queue where nation_id = p_nation;
  delete from game.movements where nation_id = p_nation;
  delete from game.diplo_offers where (from_id = p_nation or to_id = p_nation) and status = 'open';
  update game.nations set status = 'fallen', fallen_at = now(), treasury = 0 where id = p_nation;
  perform game.news('fallen', n.name || ' has fallen', 'Its government has collapsed and its land is held by others.', array[p_nation]);
  if n.leader_id is not null then
    perform game.notify(n.leader_id, 'war', n.name || ' has fallen',
      'Your country was conquered. Your Renown and business are safe: pick a new country to lead and rebuild.',
      jsonb_build_object('nation', p_nation));
    update game.nations set leader_id = null, leader_since = null where id = p_nation;
  end if;
  return true;
end $$;

-- End a war. p_terms: white, annex (p_winner annexes what it occupies),
-- reparations (p_winner is paid p_amount), surrender (p_winner annexes and
-- takes a quarter of the loser's treasury).
create function game.end_war(p_war bigint, p_terms text, p_winner text, p_outcome text, p_amount bigint default 0) returns void
language plpgsql set search_path = game, pg_temp as $$
declare
  w game.wars;
  t record;
  a text;
  b text;
  v_loser_lead text;
  v_win_lead text;
  v_pay bigint;
  v_outcome text;
  v_taken int := 0;
begin
  select * into w from game.wars where id = p_war for update;
  if not found or w.status <> 'active' then return; end if;
  v_win_lead := case p_winner when 'att' then w.attacker_id when 'def' then w.defender_id end;
  v_loser_lead := case p_winner when 'att' then w.defender_id when 'def' then w.attacker_id end;
  -- Occupied land changes hands or goes back.
  for t in select tt.id, tt.owner_id, tt.controller_id, cs.side as occ_side
             from game.territories tt
             join game.war_sides os on os.war_id = p_war and os.nation_id = tt.owner_id
             join game.war_sides cs on cs.war_id = p_war and cs.nation_id = tt.controller_id and cs.side <> os.side loop
    if p_terms in ('annex', 'surrender') and t.occ_side = p_winner then
      update game.territories set owner_id = t.controller_id, occupied_at = null where id = t.id;
      update game.facilities set level = greatest(0, level - 1), target = null, ready_at = null where territory_id = t.id;
      v_taken := v_taken + 1;
    else
      perform game.send_home(t.id, t.controller_id);
      update game.territories set controller_id = owner_id, occupied_at = null where id = t.id;
    end if;
  end loop;
  if p_terms = 'reparations' and v_loser_lead is not null and p_amount > 0 then
    v_pay := least(p_amount, (select treasury / 2 from game.nations where id = v_loser_lead));
    update game.nations set treasury = treasury - v_pay where id = v_loser_lead;
    update game.nations set treasury = treasury + v_pay where id = v_win_lead;
  elsif p_terms = 'surrender' and v_loser_lead is not null then
    v_pay := (select treasury / 4 from game.nations where id = v_loser_lead);
    update game.nations set treasury = treasury - v_pay where id = v_loser_lead;
    update game.nations set treasury = treasury + v_pay where id = v_win_lead;
  end if;
  -- Truces between everyone on opposite sides.
  for a, b in select x.nation_id, y.nation_id from game.war_sides x join game.war_sides y on y.war_id = x.war_id and x.side = 'att' and y.side = 'def'
               where x.war_id = p_war loop
    perform game.add_treaty('truce', a, b, 24);
    perform game.rel_add(a, b, 15);
  end loop;
  if v_loser_lead is not null and p_terms <> 'white' then
    update game.nations set stability = greatest(0, stability - 10) where id in (select nation_id from game.war_sides where war_id = p_war and side <> p_winner);
  end if;
  v_outcome := coalesce(p_outcome, case p_terms
    when 'white' then 'White peace: everyone goes home'
    when 'annex' then format('%s takes the land it holds (%s territories)', game.nation_name(v_win_lead), v_taken)
    when 'reparations' then format('%s is paid %s', game.nation_name(v_win_lead), game.fmt(coalesce(v_pay, 0)))
    when 'surrender' then format('%s surrenders to %s', game.nation_name(v_loser_lead), game.nation_name(v_win_lead))
    else 'Peace' end);
  update game.wars set status = 'ended', ended_at = now(), outcome = v_outcome, score = game.war_score(p_war) where id = p_war;
  update game.diplo_offers set status = 'expired' where war_id = p_war and status = 'open';
  for a in select nation_id from game.war_sides where war_id = p_war loop
    perform game.leader_xp(a, 80, 'Peace: ' || w.name, 'treaties');
    perform game.tell(a, 'war', 'Peace: ' || w.name, v_outcome, jsonb_build_object('war', p_war));
  end loop;
  perform game.news('peace', 'Peace: ' || w.name, v_outcome, array[w.attacker_id, w.defender_id], jsonb_build_object('war', p_war));
  for a in select nation_id from game.war_sides where war_id = p_war loop
    perform game.check_fallen(a);
  end loop;
end $$;

create function game.do_propose_peace(p_nation text, p_war bigint, p_terms text, p_amount bigint) returns jsonb
language plpgsql set search_path = game, pg_temp as $$
declare
  w game.wars;
  v_side text;
  v_other text;
  v_winner text;
begin
  select * into w from game.wars where id = p_war;
  if not found or w.status <> 'active' then perform game.fail('That war is over.'); end if;
  if p_nation not in (w.attacker_id, w.defender_id) then perform game.fail('Only the leading nation on each side can make peace.'); end if;
  if p_terms not in ('white', 'annex', 'reparations', 'surrender') then perform game.fail('Unknown terms.'); end if;
  v_side := game.side_of(p_war, p_nation);
  v_other := case when p_nation = w.attacker_id then w.defender_id else w.attacker_id end;
  v_winner := case when p_terms = 'surrender' then case v_side when 'att' then 'def' else 'att' end
                   when p_terms in ('annex', 'reparations') then v_side end;
  if p_terms = 'surrender' then
    perform game.end_war(p_war, 'surrender', v_winner, null);
    return jsonb_build_object('status', 'accepted');
  end if;
  return game.make_offer('peace', p_nation, v_other, p_war,
    jsonb_build_object('terms', p_terms, 'winner', v_winner, 'amount', greatest(0, coalesce(p_amount, 0))));
end $$;

create function public.propose_peace(p_war bigint, p_terms text, p_amount bigint default 0) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  n game.nations := game.my_nation_row(game.me());
begin
  perform game.rate_limit(n.id, 'peace', 4, 0.5);
  return game.do_propose_peace(n.id, p_war, p_terms, p_amount);
end $$;

-- ---------------------------------------------------------------------------
-- Armies on the move
-- ---------------------------------------------------------------------------
create function game.move_minutes(p_nation text, p_units jsonb, p_km numeric) returns numeric
language sql stable set search_path = game, pg_temp as $$
  select 2 + p_km / (min(u.speed) * (1 + game.tech_fx(p_nation, 'speed') + 0.06 * game.leader_perk(p_nation, 'logistics')))
    from jsonb_object_keys(p_units) k join game.unit_types u on u.id = k
$$;

create function game.do_send(p_nation text, p_from text, p_to text, p_units jsonb) returns game.movements
language plpgsql set search_path = game, pg_temp as $$
declare
  f game.territories;
  t game.territories;
  l game.territory_links;
  k text;
  v int;
  v_have int;
  v_air_only boolean := true;
  v_km numeric;
  v_kind text;
  v_units jsonb := '{}'::jsonb;
  m game.movements;
begin
  if p_from = p_to then perform game.fail('Pick a different territory.'); end if;
  select * into f from game.territories where id = p_from;
  select * into t from game.territories where id = p_to;
  if f.id is null or t.id is null then perform game.fail('Unknown territory.'); end if;
  if not game.allied(p_nation, f.controller_id) then perform game.fail('You can only send troops from land you or your allies hold.'); end if;
  for k, v in select key, value::int from jsonb_each_text(coalesce(p_units, '{}'::jsonb)) loop
    continue when v <= 0;
    if not exists (select 1 from game.unit_types where id = k) then perform game.fail('Unknown unit.'); end if;
    if k = 'missile' then perform game.fail('Missiles are launched, not sent.'); end if;
    select qty into v_have from game.garrisons where territory_id = p_from and nation_id = p_nation and unit = k for update;
    if coalesce(v_have, 0) < v then perform game.fail(format('You only have %s %s there.', coalesce(v_have, 0), (select plural from game.unit_types where id = k))); end if;
    if k <> 'air' then v_air_only := false; end if;
    v_units := v_units || jsonb_build_object(k, v);
  end loop;
  if v_units = '{}'::jsonb then perform game.fail('Choose some units to send.'); end if;
  select * into l from game.territory_links where a = p_from and b = p_to;
  if l.a is null then
    v_km := game.dist_m(f.lat, f.lng, t.lat, t.lng) / 1000;
    if not v_air_only then perform game.fail(format('%s doesn''t border %s. Ground forces cross one border at a time; air wings fly up to 2,500 km.', t.name, f.name)); end if;
    if v_km > 2500 then perform game.fail(format('%s is %s km away: air wings reach 2,500 km.', t.name, round(v_km))); end if;
  else
    v_km := l.km;
  end if;
  if v_units ? 'naval' and (t.landlocked or f.landlocked) then perform game.fail('Fleets sail only between coasts.'); end if;
  if game.allied(p_nation, t.controller_id) then
    v_kind := 'move';
  elsif game.at_war(p_nation, t.controller_id) then
    v_kind := case when v_air_only then 'raid' else 'attack' end;
  else
    perform game.fail(format('You aren''t at war with %s.', game.nation_name(t.controller_id)));
  end if;
  for k, v in select key, value::int from jsonb_each_text(v_units) loop
    update game.garrisons set qty = qty - v where territory_id = p_from and nation_id = p_nation and unit = k;
  end loop;
  delete from game.garrisons where territory_id = p_from and nation_id = p_nation and qty = 0;
  insert into game.movements (nation_id, from_t, to_t, units, kind, arrive_at)
  values (p_nation, p_from, p_to, v_units, v_kind, now() + make_interval(secs => round(game.move_minutes(p_nation, v_units, v_km) * 60)::int))
  returning * into m;
  if v_kind <> 'move' then
    perform game.tell(t.controller_id, 'war', format('%s forces are heading for %s', game.nation_name(p_nation), t.name),
      format('They arrive around %s UTC.', to_char(m.arrive_at at time zone 'utc', 'HH24:MI')), jsonb_build_object('movement', m.id));
  end if;
  perform game.push('world:nations', 'move', jsonb_build_object('id', m.id, 'nation', p_nation, 'from', p_from, 'to', p_to, 'kind', v_kind, 'arrive_at', m.arrive_at));
  return m;
end $$;

create function public.army_send(p_from text, p_to text, p_units jsonb) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  n game.nations := game.my_nation_row(game.me());
  m game.movements;
begin
  perform game.rate_limit(n.id, 'army_send', 20, 30);
  if p_units ? 'air' and (p_units ->> 'air')::int > 0 then perform game.check_unlock(n.id, 'air'); end if;
  m := game.do_send(n.id, p_from, p_to, p_units);
  return jsonb_build_object('id', m.id, 'kind', m.kind, 'arrive_at', m.arrive_at);
end $$;

create function game.do_missiles(p_nation text, p_from text, p_to text, p_qty int) returns game.movements
language plpgsql set search_path = game, pg_temp as $$
declare
  f game.territories;
  t game.territories;
  v_have int;
  v_km numeric;
  m game.movements;
begin
  select * into f from game.territories where id = p_from;
  select * into t from game.territories where id = p_to;
  if f.controller_id is distinct from p_nation then perform game.fail('Launch from your own territory.'); end if;
  if game.blevel(p_from, 'silo') < 1 then perform game.fail('You need a missile silo there.'); end if;
  if not game.at_war(p_nation, t.controller_id) then perform game.fail('You aren''t at war with them.'); end if;
  v_km := game.dist_m(f.lat, f.lng, t.lat, t.lng) / 1000;
  if v_km > 3000 then perform game.fail(format('%s is %s km away: missiles reach 3,000 km.', t.name, round(v_km))); end if;
  select qty into v_have from game.garrisons where territory_id = p_from and nation_id = p_nation and unit = 'missile' for update;
  if p_qty < 1 or coalesce(v_have, 0) < p_qty then perform game.fail('Not enough missiles there.'); end if;
  update game.garrisons set qty = qty - p_qty where territory_id = p_from and nation_id = p_nation and unit = 'missile';
  insert into game.movements (nation_id, from_t, to_t, units, kind, arrive_at)
  values (p_nation, p_from, p_to, jsonb_build_object('missile', p_qty), 'missile', now() + make_interval(secs => round((1 + v_km / 1500) * 60)::int))
  returning * into m;
  perform game.tell(t.controller_id, 'war', format('Missile launch detected from %s', f.name), format('%s missiles are heading for %s.', p_qty, t.name));
  return m;
end $$;

create function public.missile_launch(p_from text, p_to text, p_qty int) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  n game.nations := game.my_nation_row(game.me());
  m game.movements;
begin
  perform game.check_unlock(n.id, 'missile');
  perform game.rate_limit(n.id, 'missile', 5, 5);
  m := game.do_missiles(n.id, p_from, p_to, p_qty);
  return jsonb_build_object('id', m.id, 'arrive_at', m.arrive_at);
end $$;

-- ---------------------------------------------------------------------------
-- Battles (Lanchester square law)
-- ---------------------------------------------------------------------------
create function game.unit_mult(p_nation text, p_unit text, p_side text) returns numeric
language sql stable set search_path = game, pg_temp as $$
  select 1 + game.tech_fx(p_nation, p_side || '_' || p_unit) + game.tech_fx(p_nation, p_side || '_all')
         + 0.04 * game.leader_perk(p_nation, 'command')
$$;

-- What the defenders of a territory can field against p_attacker.
create function game.defence_power(p_territory text, p_attacker text, p_militia boolean default true) returns numeric
language plpgsql stable set search_path = game, pg_temp as $$
declare
  t game.territories;
  v numeric;
begin
  select * into t from game.territories where id = p_territory;
  select coalesce(sum(g.qty * u.def * game.unit_mult(g.nation_id, g.unit, 'def')), 0) into v
    from game.garrisons g join game.unit_types u on u.id = g.unit
   where g.territory_id = p_territory and g.qty > 0 and g.unit <> 'missile' and (p_attacker is null or game.at_war(p_attacker, g.nation_id));
  if p_militia and t.controller_id = t.owner_id then v := v + t.militia; end if;
  return v * (1 + 0.15 * game.blevel(p_territory, 'fort') * (1 + game.tech_fx(t.controller_id, 'fort')));
end $$;

create function game.attack_power(p_nation text, p_units jsonb, p_from text, p_to text) returns numeric
language plpgsql stable set search_path = game, pg_temp as $$
declare
  k text;
  v int;
  u game.unit_types;
  v_s numeric;
  v_total numeric := 0;
  v_sea boolean := coalesce((select kind = 'sea' from game.territory_links where a = p_from and b = p_to), true);
  v_navy boolean := coalesce((p_units ->> 'naval')::int, 0) > 0 or game.tech_fx(p_nation, 'sea') > 0;
  v_ad int := game.blevel(p_to, 'air_defence');
begin
  for k, v in select key, value::int from jsonb_each_text(p_units) loop
    select * into u from game.unit_types where id = k;
    v_s := v * u.atk * game.unit_mult(p_nation, k, 'atk');
    if k = 'air' then v_s := v_s * greatest(0, 1 - 0.2 * v_ad * (1 - game.tech_fx(p_nation, 'stealth'))); end if;
    if v_sea and k not in ('air', 'naval') and not v_navy then v_s := v_s * 0.6; end if;
    v_total := v_total + v_s;
  end loop;
  return v_total;
end $$;

create function game.scale_units(p_units jsonb, p_keep numeric) returns jsonb
language sql immutable as $$
  select coalesce(jsonb_object_agg(key, floor(value::int * greatest(0, least(1, p_keep)) + 0.5)::int), '{}'::jsonb)
    from jsonb_each_text(p_units)
$$;

create function game.units_minus(p_a jsonb, p_b jsonb) returns jsonb
language sql immutable as $$
  select coalesce(jsonb_object_agg(key, value::int - coalesce((p_b ->> key)::int, 0)), '{}'::jsonb) from jsonb_each_text(p_a)
$$;

create function game.units_text(p_units jsonb) returns text
language sql stable set search_path = game, pg_temp as $$
  select coalesce(string_agg(format('%s %s', e.value, case when e.value::int = 1 then lower(u.name) else u.plural end), ', ' order by u.sort), 'nothing')
    from jsonb_each_text(p_units) e join game.unit_types u on u.id = e.key where e.value::int > 0
$$;

create function game.return_units(p_nation text, p_from text, p_units jsonb) returns void
language plpgsql set search_path = game, pg_temp as $$
declare
  v_home text;
  k text;
  v int;
begin
  v_home := case when game.allied(p_nation, (select controller_id from game.territories where id = p_from)) then p_from
                 else (select id from game.territories where controller_id = p_nation order by (id = p_nation) desc, value desc limit 1) end;
  if v_home is null then return; end if;
  for k, v in select key, value::int from jsonb_each_text(p_units) loop
    if v > 0 then perform game.garrison_add(v_home, p_nation, k, v); end if;
  end loop;
end $$;

create function game.battle(m game.movements) returns jsonb
language plpgsql set search_path = game, pg_temp as $$
declare
  t game.territories;
  v_def_nation text;
  v_war bigint;
  v_side text;
  A numeric;
  D numeric;
  r numeric;
  v_att_loss numeric;
  v_def_loss numeric;
  v_survivors jsonb;
  v_def_units jsonb;
  v_def_after jsonb;
  v_winner text;
  v_captured boolean := false;
  v_ground boolean;
  v_summary text;
  v_new_controller text;
begin
  select * into t from game.territories where id = m.to_t for update;
  v_def_nation := t.controller_id;
  v_war := game.war_between(m.nation_id, v_def_nation);
  v_side := game.side_of(v_war, m.nation_id);
  A := game.attack_power(m.nation_id, m.units, m.from_t, m.to_t) * (0.9 + random() * 0.2);
  D := greatest(1, game.defence_power(t.id, m.nation_id));
  select coalesce(jsonb_object_agg(unit, q), '{}'::jsonb) into v_def_units
    from (select unit, sum(qty)::int q from game.garrisons where territory_id = t.id and qty > 0 and game.at_war(m.nation_id, nation_id) group by unit) x;
  r := A / D;
  if r > 1 then
    v_winner := 'attacker';
    v_att_loss := 1 - sqrt(1 - 1 / (r * r));
    v_def_loss := 1;
  else
    v_winner := 'defender';
    v_att_loss := 1;
    v_def_loss := 1 - sqrt(1 - r * r);
  end if;
  v_survivors := game.scale_units(m.units, 1 - v_att_loss);
  update game.garrisons set qty = floor(qty * (1 - v_def_loss) + 0.5)
   where territory_id = t.id and game.at_war(m.nation_id, nation_id);
  delete from game.garrisons where territory_id = t.id and qty = 0;
  v_def_after := game.scale_units(v_def_units, 1 - v_def_loss);
  v_ground := exists (select 1 from jsonb_each_text(v_survivors) e where e.key in ('infantry', 'artillery', 'armor', 'naval') and e.value::int > 0);
  if v_winner = 'attacker' and m.kind = 'attack' and v_ground then
    v_captured := true;
    -- Land of your own side goes back to its owner; anything else is occupied.
    v_new_controller := case when game.side_of(v_war, t.owner_id) = v_side then t.owner_id else m.nation_id end;
    update game.territories set controller_id = v_new_controller,
      occupied_at = case when v_new_controller = owner_id then null else now() end,
      damage = least(0.5, damage + 0.1)
     where id = t.id;
    perform game.return_units(m.nation_id, m.to_t, v_survivors);
    update game.wars set att_wins = att_wins + case when v_side = 'att' then 1 else 0 end,
                         def_wins = def_wins + case when v_side = 'def' then 1 else 0 end where id = v_war;
  elsif v_winner = 'attacker' then
    perform game.return_units(m.nation_id, m.from_t, v_survivors);
    update game.territories set damage = least(0.5, damage + 0.05) where id = t.id;
    update game.wars set att_wins = att_wins + case when v_side = 'att' then 1 else 0 end,
                         def_wins = def_wins + case when v_side = 'def' then 1 else 0 end where id = v_war;
  else
    update game.wars set att_wins = att_wins + case when v_side = 'def' then 1 else 0 end,
                         def_wins = def_wins + case when v_side = 'att' then 1 else 0 end where id = v_war;
  end if;
  update game.nations set exhaustion = least(100, exhaustion + case when v_winner = 'attacker' then 1 else 4 end) where id = m.nation_id;
  update game.nations set exhaustion = least(100, exhaustion + case when v_winner = 'attacker' then 4 else 1 end) where id = v_def_nation;
  v_summary := case
    when v_captured then format('%s took %s from %s.', game.nation_name(m.nation_id), t.name, game.nation_name(v_def_nation))
    when v_winner = 'attacker' then format('%s''s air strike on %s hit hard.', game.nation_name(m.nation_id), t.name)
    else format('%s held %s against %s.', game.nation_name(v_def_nation), t.name, game.nation_name(m.nation_id)) end;
  insert into game.battles (war_id, territory_id, attacker_id, defender_id, kind, att_units, def_units, att_lost, def_lost,
                            att_power, def_power, winner, captured, summary)
  values (v_war, t.id, m.nation_id, v_def_nation, m.kind, m.units, v_def_units,
          game.units_minus(m.units, v_survivors), game.units_minus(v_def_units, v_def_after),
          round(A, 1), round(D, 1), v_winner, v_captured, v_summary);
  if v_winner = 'attacker' then
    perform game.leader_xp(m.nation_id, 150 + case when v_captured then 250 else 0 end, 'Victory at ' || t.name, 'battles_won');
    if v_captured then perform game.leader_xp(m.nation_id, 0, null, 'territories'); end if;
  else
    perform game.leader_xp(v_def_nation, 100, 'Held ' || t.name, 'defended');
  end if;
  perform game.tell(m.nation_id, 'battle', case when v_winner = 'attacker' then 'Victory at ' else 'Defeat at ' end || t.name,
    v_summary || format(' You lost %s.', game.units_text(game.units_minus(m.units, v_survivors))), jsonb_build_object('territory', t.id));
  perform game.tell(v_def_nation, 'battle', case when v_winner = 'defender' then 'Held ' else 'Lost ' end || t.name,
    v_summary || format(' You lost %s.', game.units_text(game.units_minus(v_def_units, v_def_after))), jsonb_build_object('territory', t.id));
  if v_captured then
    perform game.news('battle', v_summary, null, array[m.nation_id, v_def_nation], jsonb_build_object('territory', t.id));
    perform game.check_fallen(v_def_nation);
  end if;
  perform game.push('world:nations', 'battle', jsonb_build_object('territory', t.id, 'winner', v_winner, 'captured', v_captured,
    'attacker', m.nation_id, 'defender', v_def_nation));
  return jsonb_build_object('winner', v_winner, 'captured', v_captured, 'ratio', round(r, 2));
end $$;

create function game.missile_strike(m game.movements) returns jsonb
language plpgsql set search_path = game, pg_temp as $$
declare
  t game.territories;
  v_qty int := (m.units ->> 'missile')::int;
  v_power numeric;
  v_intercept numeric;
  v_eff numeric;
  D numeric;
  v_kill numeric;
  v_def_units jsonb;
  b game.facilities;
  v_summary text;
begin
  select * into t from game.territories where id = m.to_t for update;
  if not game.at_war(m.nation_id, t.controller_id) then return jsonb_build_object('wasted', true); end if;
  v_power := v_qty * 60 * (1 + game.tech_fx(m.nation_id, 'missile'));
  v_intercept := case when game.tech_fx(m.nation_id, 'no_intercept') > 0 then 0 else least(0.75, 0.25 * game.blevel(t.id, 'air_defence')) end;
  v_eff := v_power * (1 - v_intercept);
  D := greatest(1, game.defence_power(t.id, m.nation_id, false));
  v_kill := least(0.5, v_eff / D);
  select coalesce(jsonb_object_agg(unit, q), '{}'::jsonb) into v_def_units
    from (select unit, sum(qty)::int q from game.garrisons where territory_id = t.id and game.at_war(m.nation_id, nation_id) group by unit) x;
  update game.garrisons set qty = floor(qty * (1 - v_kill) + 0.5) where territory_id = t.id and game.at_war(m.nation_id, nation_id);
  delete from game.garrisons where territory_id = t.id and qty = 0;
  if v_eff >= 200 then
    select * into b from game.facilities where territory_id = t.id and level > 0 order by level desc, kind limit 1;
    if found then update game.facilities set level = level - 1 where territory_id = b.territory_id and kind = b.kind; end if;
  end if;
  update game.territories set damage = least(0.5, damage + 0.05) where id = t.id;
  v_summary := format('%s missiles from %s hit %s (%s%% intercepted).', v_qty, game.nation_name(m.nation_id), t.name, round(v_intercept * 100));
  insert into game.battles (war_id, territory_id, attacker_id, defender_id, kind, att_units, def_units, att_lost, def_lost,
                            att_power, def_power, winner, captured, summary)
  values (game.war_between(m.nation_id, t.controller_id), t.id, m.nation_id, t.controller_id, 'missile', m.units, v_def_units,
          m.units, game.units_minus(v_def_units, game.scale_units(v_def_units, 1 - v_kill)),
          round(v_eff, 1), round(D, 1), 'attacker', false, v_summary);
  perform game.leader_xp(m.nation_id, 50, 'Missile strike on ' || t.name, 'missiles', v_qty);
  perform game.tell(t.controller_id, 'battle', 'Missile strike on ' || t.name, v_summary);
  return jsonb_build_object('kill', round(v_kill, 3));
end $$;

create function game.arrive(p_id bigint) returns void
language plpgsql set search_path = game, pg_temp as $$
declare
  m game.movements;
  t game.territories;
  r jsonb;
begin
  select * into m from game.movements where id = p_id and status = 'moving' for update skip locked;
  if not found then return; end if;
  select * into t from game.territories where id = m.to_t;
  if m.kind = 'missile' then
    r := game.missile_strike(m);
  elsif game.allied(m.nation_id, t.controller_id) then
    perform game.return_units(m.nation_id, m.to_t, m.units);
    r := jsonb_build_object('arrived', true);
  elsif game.at_war(m.nation_id, t.controller_id) and m.kind in ('attack', 'raid', 'move') then
    if m.kind = 'move' then m.kind := 'attack'; end if;
    r := game.battle(m);
  else
    -- Peace broke out on the way: back home.
    perform game.return_units(m.nation_id, m.from_t, m.units);
    r := jsonb_build_object('returned', true);
  end if;
  update game.movements set status = 'done', result = r where id = m.id;
end $$;

-- ---------------------------------------------------------------------------
-- World domination
-- ---------------------------------------------------------------------------
create function game.military_power(p_nation text) returns numeric
language sql stable set search_path = game, pg_temp as $$
  select coalesce(sum(g.qty * (u.atk + u.def) / 2.0), 0)
    from game.garrisons g join game.unit_types u on u.id = g.unit where g.nation_id = p_nation
$$;

create function game.world_scores() returns void
language plpgsql set search_path = game, pg_temp as $$
declare
  e game.eras;
  w record;
  v_top game.nations;
begin
  update game.nations n set
    share = coalesce((select sum(value) from game.territories t where t.controller_id = n.id), 0),
    power = round(game.military_power(n.id) + n.income_h / 20000.0
                  + 15 * (select count(*) from game.nation_techs where nation_id = n.id)
                  + 25 * (select count(*) from game.territories t where t.controller_id = n.id))
  where n.status = 'active';
  update game.nations set share = 0, power = 0 where status = 'fallen';
  for w in select leader_id, share from game.nations where leader_id is not null loop
    perform game.count_max(w.leader_id, 'domination', floor(w.share * 1000)::bigint);
  end loop;
  -- An era ends when one nation holds half the world, or after 90 days.
  select * into e from game.eras where ended_at is null order by id desc limit 1;
  if not found then return; end if;
  select * into v_top from game.nations where status = 'active' order by share desc, power desc limit 1;
  if v_top.share >= 0.5 or now() >= e.ends_at then
    update game.eras set ended_at = now(), winner_id = v_top.id, winner_name = v_top.name, share = v_top.share,
      leader_name = (select display_name from game.players where id = v_top.leader_id)
     where id = e.id;
    perform game.news('era', format('%s wins era %s', v_top.name, e.number),
      format('Holding %s%% of the world. A new era begins: every nation starts again from its homeland.', round(v_top.share * 100, 1)),
      array[v_top.id]);
    if v_top.leader_id is not null then
      perform game.grant_xp(v_top.leader_id, 10000, 'Won era ' || e.number);
      perform game.add_crate(v_top.leader_id, 'gold', 5);
      update game.renown set titles = array_append(titles, 'World Hegemon (era ' || e.number || ')') where player_id = v_top.leader_id;
    end if;
    perform game.world_reset();
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- The world tick: every minute
-- ---------------------------------------------------------------------------
create function game.world_tick() returns void
language plpgsql set search_path = game, pg_temp as $$
declare
  v_id text;
  q game.recruit_queue;
  b record;
  v_mid bigint;
  w record;
  v_home text;
  v_n int := 0;
begin
  if not pg_try_advisory_xact_lock(434343) then return; end if;
  -- 1. Economies.
  for v_id in select id from game.nations where status = 'active' loop
    begin
      perform game.nation_economy(v_id);
    exception when others then raise warning 'economy % failed: %', v_id, sqlerrm;
    end;
  end loop;
  -- 2. Training done.
  for q in select * from game.recruit_queue where ready_at <= now() order by ready_at loop
    v_home := case when (select controller_id from game.territories where id = q.territory_id) = q.nation_id then q.territory_id
                   else (select id from game.territories where controller_id = q.nation_id order by (id = q.nation_id) desc limit 1) end;
    if v_home is not null then perform game.garrison_add(v_home, q.nation_id, q.unit, q.qty); end if;
    delete from game.recruit_queue where id = q.id;
  end loop;
  -- 3. Construction done.
  for b in update game.facilities set level = target, target = null, ready_at = null
            where ready_at <= now() and target is not null returning territory_id, kind, level loop
    v_id := (select owner_id from game.territories where id = b.territory_id);
    perform game.leader_xp(v_id, 40 * b.level, 'Built ' || (select name from game.facility_types where id = b.kind), 'buildings');
    perform game.tell(v_id, 'nation', format('%s level %s finished', (select name from game.facility_types where id = b.kind), b.level),
      'In ' || (select name from game.territories where id = b.territory_id) || '.');
  end loop;
  -- 4. Armies arrive.
  for v_mid in select id from game.movements where status = 'moving' and arrive_at <= now() order by arrive_at loop
    begin
      perform game.arrive(v_mid);
    exception when others then
      raise warning 'arrival % failed: %', v_mid, sqlerrm;
      update game.movements set status = 'done', result = jsonb_build_object('error', sqlerrm) where id = v_mid;
    end;
  end loop;
  delete from game.movements where status = 'done' and arrive_at < now() - interval '1 day';
  -- 5. Wars: scores, and very long wars burn out.
  for w in select id, started_at from game.wars where status = 'active' loop
    update game.wars set score = game.war_score(w.id) where id = w.id;
    if w.started_at < now() - interval '7 days' then
      perform game.end_war(w.id, 'white', null, 'Exhausted, both sides went home');
    end if;
  end loop;
  -- 6. Unheld occupations revolt when the occupier is unstable or long gone.
  for b in select t.id, t.owner_id, t.controller_id, t.name from game.territories t join game.nations c on c.id = t.controller_id
            where t.controller_id <> t.owner_id
              and not exists (select 1 from game.garrisons g where g.territory_id = t.id and g.nation_id = t.controller_id and g.qty > 0)
              and (c.stability < 35 or t.occupied_at < now() - interval '48 hours') loop
    perform game.nation_revive(b.owner_id);
    update game.territories set controller_id = owner_id, occupied_at = null where id = b.id;
    perform game.news('revolt', format('%s rises up against %s', b.name, game.nation_name(b.controller_id)), null, array[b.owner_id, b.controller_id]);
  end loop;
  -- 7. Old grudges fade; offers and treaties expire.
  if extract(minute from now())::int % 10 = 0 then
    update game.relations r set score = score * 0.97,
      rival_a = rival_a and denounced_at > now() - interval '24 hours',
      rival_b = rival_b and denounced_at > now() - interval '24 hours'
     where not game.at_war(r.a, r.b);
    delete from game.relations where abs(score) < 0.5 and not rival_a and not rival_b;
  end if;
  update game.diplo_offers set status = 'expired' where status = 'open' and expires_at < now();
  delete from game.treaties where until < now();
  -- 8. The AI governments think.
  for v_id in select id from game.nations where leader_id is null and status = 'active' and next_think_at <= now()
               order by next_think_at limit 45 loop
    begin
      perform game.ai_think(v_id);
    exception when others then
      raise warning 'ai % failed: %', v_id, sqlerrm;
    end;
    update game.nations set next_think_at = now() + make_interval(secs => (60 * (2 + 6 - ai_skill) + floor(random() * 60))::int)
     where id = v_id and next_think_at <= now();
    v_n := v_n + 1;
  end loop;
  -- 9. Rankings and world domination, every 5 minutes.
  if extract(minute from now())::int % 5 = 0 then perform game.world_scores(); end if;
  -- 10. Leaders away for 14 days hand back to the AI.
  if extract(minute from now())::int = 41 then
    for w in select n.id, n.name, n.leader_id from game.nations n join game.players p on p.id = n.leader_id
              where p.last_seen_at < now() - interval '14 days' loop
      update game.nations set leader_id = null, leader_since = null where id = w.id;
      perform game.notify(w.leader_id, 'nation', 'You were away, so the AI now runs ' || w.name, 'Pick a country when you are back.');
      perform game.news('leader', w.name || '''s leader has gone quiet', 'The civil service (the AI) is running the country.', array[w.id]);
    end loop;
  end if;
end $$;

do $$
begin
  if to_regnamespace('cron') is not null then
    perform cron.unschedule(jobid) from cron.job where jobname = 'crancapital-world';
    perform cron.schedule('crancapital-world', '* * * * *', 'select game.world_tick()');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Reading the world
-- ---------------------------------------------------------------------------
-- The fixed map: names, numbers and links. Cache it.
create function public.world_map() returns jsonb
language sql stable security definer set search_path = game, pg_temp as $$
  select jsonb_build_object(
    'territories', (select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'iso2', iso2, 'continent', continent, 'region', region,
                      'pop_m', pop_m, 'gdp_bn', gdp_bn, 'lat', lat, 'lng', lng, 'landlocked', landlocked, 'color', color,
                      'value', round(value * 1000, 2), 'income', income, 'manpower', manpower, 'militia', militia) order by name)
                    from game.territories),
    'links', (select jsonb_agg(jsonb_build_array(a, b, kind, km)) from game.territory_links where a < b),
    'units', (select jsonb_agg(to_jsonb(u) order by sort) from game.unit_types u),
    'buildings', (select jsonb_agg(to_jsonb(b) order by sort) from game.facility_types b),
    'techs', (select jsonb_agg(to_jsonb(t) order by sort) from game.techs t))
$$;

-- What's happening now: who holds what, who leads whom, wars and armies.
create function public.world_state() returns jsonb
language sql stable security definer set search_path = game, pg_temp as $$
  select jsonb_build_object(
    'at', now(),
    'era', (select jsonb_build_object('number', number, 'started_at', started_at, 'ends_at', ends_at) from game.eras where ended_at is null order by id desc limit 1),
    'territories', (select jsonb_agg(jsonb_build_array(id, owner_id, controller_id)) from game.territories),
    'nations', (select jsonb_agg(jsonb_build_object('id', n.id, 'name', n.name, 'color', n.color, 'status', n.status,
                  'leader', case when p.id is not null then jsonb_build_object('no', p.player_no, 'name', p.display_name, 'skin', p.skin) end,
                  'skill', n.ai_skill, 'skill_name', game.skill_name(n.ai_skill), 'personality', n.personality,
                  'power', n.power, 'share', round(n.share * 100, 2), 'alliance', m.alliance_id,
                  'protected', n.protected_until > now(), 'stability', round(n.stability)) order by n.power desc)
                from game.nations n left join game.players p on p.id = n.leader_id left join game.alliance_members m on m.nation_id = n.id),
    'alliances', (select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name, 'color', a.color, 'founder', a.founder_id,
                    'members', (select jsonb_agg(nation_id order by joined_at) from game.alliance_members where alliance_id = a.id))), '[]'::jsonb)
                  from game.alliances a),
    'wars', (select coalesce(jsonb_agg(jsonb_build_object('id', w.id, 'name', w.name, 'attacker', w.attacker_id, 'defender', w.defender_id,
               'score', round(w.score), 'started_at', w.started_at,
               'att', (select jsonb_agg(nation_id) from game.war_sides where war_id = w.id and side = 'att'),
               'def', (select jsonb_agg(nation_id) from game.war_sides where war_id = w.id and side = 'def'))), '[]'::jsonb)
             from game.wars w where w.status = 'active'),
    'moves', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'nation', nation_id, 'from', from_t, 'to', to_t, 'kind', kind,
               'depart_at', depart_at, 'arrive_at', arrive_at)), '[]'::jsonb)
              from game.movements where status = 'moving'),
    'battles', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'at', at, 'territory', territory_id, 'winner', winner, 'captured', captured)
                  order by at desc), '[]'::jsonb)
                from game.battles where at > now() - interval '10 minutes'))
$$;

create function public.world_news(p_limit int default 40) returns jsonb
language sql stable security definer set search_path = game, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'at', at, 'kind', kind, 'title', title, 'body', body, 'nations', nations) order by at desc), '[]'::jsonb)
    from (select * from game.world_news order by at desc limit least(greatest(p_limit, 1), 100)) x
$$;

create function public.world_rankings() returns jsonb
language sql stable security definer set search_path = game, pg_temp as $$
  select jsonb_build_object(
    'powers', (select jsonb_agg(x order by x.power desc) from (
                 select n.id, n.name, n.color, n.power, round(n.share * 100, 2) as share,
                        (select count(*) from game.territories t where t.controller_id = n.id) as territories,
                        p.display_name as leader, p.player_no
                   from game.nations n left join game.players p on p.id = n.leader_id
                  where n.status = 'active' order by n.power desc limit 50) x),
    'hall', (select coalesce(jsonb_agg(jsonb_build_object('number', number, 'winner', winner_name, 'leader', leader_name,
               'share', round(coalesce(share, 0) * 100, 1), 'ended_at', ended_at) order by number desc), '[]'::jsonb)
             from game.eras where ended_at is not null and winner_id is not null))
$$;

-- Rounded numbers for a foreign army: intelligence, not certainty.
create function game.intel(p_n int) returns int
language sql immutable as $$
  select case when p_n < 10 then p_n else (round(p_n / power(10, floor(log(p_n)) - 1)) * power(10, floor(log(p_n)) - 1))::int end
$$;

create function public.nation_info(p_id text) returns jsonb
language plpgsql stable security definer set search_path = game, pg_temp as $$
declare
  n game.nations;
  v_me text := game.player_nation(game.uid());
  tr game.treaties;
  v_why text;
begin
  select * into n from game.nations where id = p_id;
  if not found then perform game.fail('No such nation.'); end if;
  if v_me is not null and v_me <> p_id then
    tr := game.treaty(v_me, p_id);
    v_why := case
      when n.status <> 'active' then 'It has fallen.'
      when game.allied(v_me, p_id) then 'You are allies.'
      when game.at_war(v_me, p_id) then 'You are already at war.'
      when tr.id is not null then case tr.kind when 'nap' then 'You signed a non-aggression pact.' else 'You have a truce.' end
      when n.protected_until > now() then 'It has a new leader and is protected for now.'
      else null end;
  end if;
  return jsonb_build_object(
    'id', n.id, 'name', n.name, 'color', n.color, 'status', n.status,
    'leader', (select jsonb_build_object('no', player_no, 'name', display_name, 'skin', skin, 'title', title) from game.players where id = n.leader_id),
    'skill', n.ai_skill, 'skill_name', game.skill_name(n.ai_skill), 'personality', n.personality,
    'power', n.power, 'share', round(n.share * 100, 2), 'stability', round(n.stability), 'exhaustion', round(n.exhaustion),
    'protected_until', case when n.protected_until > now() then n.protected_until end,
    'alliance', (select jsonb_build_object('id', a.id, 'name', a.name) from game.alliances a where a.id = game.alliance_of(n.id)),
    'techs', (select count(*) from game.nation_techs where nation_id = n.id),
    'territories', (select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'owner', t.owner_id, 'controller', t.controller_id,
                      'forts', game.blevel(t.id, 'fort'), 'air_defence', game.blevel(t.id, 'air_defence'),
                      'troops', (select coalesce(jsonb_object_agg(g.unit, case when v_me is not null and game.allied(v_me, g.nation_id) then g.qty else game.intel(g.qty) end), '{}'::jsonb)
                                   from (select unit, nation_id, sum(qty)::int qty from game.garrisons where territory_id = t.id group by unit, nation_id) g)) order by t.value desc), '[]'::jsonb)
                    from game.territories t where t.controller_id = n.id or t.owner_id = n.id),
    'wars', (select coalesce(jsonb_agg(jsonb_build_object('id', w.id, 'name', w.name, 'score', round(case when s.side = 'att' then w.score else -w.score end))), '[]'::jsonb)
             from game.war_sides s join game.wars w on w.id = s.war_id and w.status = 'active' where s.nation_id = n.id),
    'relation', case when v_me is not null and v_me <> p_id then round(game.rel(v_me, p_id)) end,
    'treaty', case when tr.id is not null then jsonb_build_object('kind', tr.kind, 'until', tr.until) end,
    'can_declare', v_me is not null and v_me <> p_id and v_why is null,
    'why_not', v_why,
    'mine', v_me = p_id);
end $$;

-- Everything about your own nation.
create function public.my_nation() returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me(false);
  n game.nations;
  v_level int := game.player_level(p.id);
begin
  select * into n from game.nations where leader_id = p.id;
  if not found then
    return jsonb_build_object('nation', null, 'free', (select count(*) from game.nations where leader_id is null));
  end if;
  return jsonb_build_object(
    'nation', jsonb_build_object('id', n.id, 'name', n.name, 'color', n.color, 'treasury', n.treasury, 'manpower', n.manpower,
      'research_bank', round(n.research_bank, 1), 'researching', n.researching, 'research_progress', round(n.research_progress, 1),
      'stability', round(n.stability, 1), 'exhaustion', round(n.exhaustion, 1), 'tax', n.tax, 'research_pct', n.research_pct,
      'infra_pct', n.infra_pct, 'protected_until', case when n.protected_until > now() then n.protected_until end,
      'power', n.power, 'share', round(n.share * 100, 2), 'leader_since', n.leader_since, 'status', n.status),
    'income', game.nation_income(n.id),
    'level', v_level,
    'territories', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', t.id, 'name', t.name, 'owned', t.owner_id = n.id, 'held', t.controller_id = n.id, 'owner', t.owner_id, 'controller', t.controller_id,
        'landlocked', t.landlocked, 'development', round(t.development, 3), 'damage', round(t.damage, 3), 'militia', t.militia,
        'defence', round(game.defence_power(t.id, null)),
        'garrison', (select coalesce(jsonb_object_agg(unit, qty), '{}'::jsonb) from game.garrisons where territory_id = t.id and nation_id = n.id and qty > 0),
        'allies', (select coalesce(jsonb_agg(jsonb_build_object('nation', nation_id, 'unit', unit, 'qty', qty)), '[]'::jsonb)
                     from game.garrisons where territory_id = t.id and nation_id <> n.id and qty > 0),
        'buildings', (select coalesce(jsonb_agg(jsonb_build_object('kind', kind, 'level', level, 'target', target, 'ready_at', ready_at)), '[]'::jsonb)
                        from game.facilities where territory_id = t.id),
        'queue', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'unit', unit, 'qty', qty, 'ready_at', ready_at) order by ready_at), '[]'::jsonb)
                    from game.recruit_queue where territory_id = t.id and nation_id = n.id),
        'neighbours', (select coalesce(jsonb_agg(jsonb_build_object('id', l.b, 'kind', l.kind, 'km', l.km, 'controller', x.controller_id)), '[]'::jsonb)
                         from game.territory_links l join game.territories x on x.id = l.b where l.a = t.id)
      ) order by (t.id = n.id) desc, t.value desc), '[]'::jsonb)
      from game.territories t where t.owner_id = n.id or t.controller_id = n.id
         or exists (select 1 from game.garrisons g where g.territory_id = t.id and g.nation_id = n.id and g.qty > 0)),
    'armies', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'from', from_t, 'to', to_t, 'units', units, 'kind', kind,
                 'depart_at', depart_at, 'arrive_at', arrive_at) order by arrive_at), '[]'::jsonb)
               from game.movements where nation_id = n.id and status = 'moving'),
    'incoming', (select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'nation', m.nation_id, 'from', m.from_t, 'to', m.to_t, 'kind', m.kind,
                   'arrive_at', m.arrive_at, 'size', game.intel((select sum(value::int) from jsonb_each_text(m.units))::int)) order by m.arrive_at), '[]'::jsonb)
                 from game.movements m join game.territories t on t.id = m.to_t
                where m.status = 'moving' and m.kind <> 'move' and t.controller_id = n.id),
    'techs', (select jsonb_agg(jsonb_build_object('id', t.id, 'done', nt.tech is not null,
                'available', nt.tech is null and not exists (select 1 from unnest(t.requires) r where not game.has_tech(n.id, r))) order by t.sort)
              from game.techs t left join game.nation_techs nt on nt.nation_id = n.id and nt.tech = t.id),
    'unlocks', (select jsonb_object_agg(key, level) from game.renown_unlocks),
    'wars', (select coalesce(jsonb_agg(jsonb_build_object('id', w.id, 'name', w.name, 'side', s.side, 'leader', n.id in (w.attacker_id, w.defender_id),
               'enemy_leader', case when s.side = 'att' then w.defender_id else w.attacker_id end,
               'score', round(case when s.side = 'att' then w.score else -w.score end), 'started_at', w.started_at,
               'allies', (select jsonb_agg(nation_id) from game.war_sides where war_id = w.id and side = s.side and nation_id <> n.id),
               'enemies', (select jsonb_agg(nation_id) from game.war_sides where war_id = w.id and side <> s.side),
               'wins', case when s.side = 'att' then w.att_wins else w.def_wins end,
               'losses', case when s.side = 'att' then w.def_wins else w.att_wins end) order by w.started_at), '[]'::jsonb)
             from game.war_sides s join game.wars w on w.id = s.war_id and w.status = 'active' where s.nation_id = n.id),
    'alliance', (select jsonb_build_object('id', a.id, 'name', a.name, 'color', a.color, 'founder', a.founder_id,
                   'members', (select jsonb_agg(nation_id order by joined_at) from game.alliance_members where alliance_id = a.id))
                 from game.alliances a where a.id = game.alliance_of(n.id)),
    'offers', (select coalesce(jsonb_agg(jsonb_build_object('id', o.id, 'kind', o.kind, 'from', o.from_id, 'to', o.to_id, 'war', o.war_id,
                 'terms', o.terms, 'incoming', o.to_id = n.id, 'created_at', o.created_at, 'expires_at', o.expires_at) order by o.created_at desc), '[]'::jsonb)
               from game.diplo_offers o where (o.to_id = n.id or o.from_id = n.id) and o.status = 'open' and o.expires_at > now()),
    'relations', (select coalesce(jsonb_agg(jsonb_build_object('nation', case when r.a = n.id then r.b else r.a end, 'score', round(r.score),
                    'they_denounced', case when r.a = n.id then r.rival_b else r.rival_a end,
                    'we_denounced', case when r.a = n.id then r.rival_a else r.rival_b end) order by r.score), '[]'::jsonb)
                  from game.relations r where r.a = n.id or r.b = n.id),
    'treaties', (select coalesce(jsonb_agg(jsonb_build_object('kind', kind, 'nation', case when a = n.id then b else a end, 'until', until)), '[]'::jsonb)
                 from game.treaties where (a = n.id or b = n.id) and until > now()),
    'battles', (select coalesce(jsonb_agg(jsonb_build_object('id', b.id, 'at', b.at, 'territory', b.territory_id, 'attacker', b.attacker_id,
                  'defender', b.defender_id, 'kind', b.kind, 'winner', b.winner, 'captured', b.captured, 'summary', b.summary,
                  'att_lost', b.att_lost, 'def_lost', b.def_lost, 'att_power', b.att_power, 'def_power', b.def_power) order by b.at desc), '[]'::jsonb)
                from (select * from game.battles where attacker_id = n.id or defender_id = n.id order by at desc limit 20) b));
end $$;

-- Permissions
do $$
declare
  f text;
begin
  foreach f in array array[
    'claim_nation(text)', 'abdicate()', 'nation_recruit(text,text,int)', 'nation_build(text,text)', 'nation_research(text)',
    'nation_disband(text,text,int)', 'nation_policy(text,int,int)', 'nation_invest(bigint)', 'respond_offer(bigint,boolean)',
    'diplo_envoy(text)', 'diplo_denounce(text)', 'diplo_nap(text)', 'alliance_create(text)', 'alliance_invite(text)', 'alliance_leave()',
    'declare_war(text)', 'propose_peace(bigint,text,bigint)', 'army_send(text,text,jsonb)', 'missile_launch(text,text,int)', 'my_nation()'
  ] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
  foreach f in array array['world_map()', 'world_state()', 'world_news(int)', 'world_rankings()', 'nation_info(text)'] loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to anon, authenticated, service_role', f);
  end loop;
end $$;

-- Signed-in players may listen to world news (wars, battles, armies).
create or replace function public.realtime_can_listen(p_topic text) returns boolean
language plpgsql stable security definer set search_path = game, pg_temp as $$
declare
  v_uid uuid := game.uid();
  v_id bigint;
begin
  if v_uid is null or p_topic is null then return false; end if;
  if p_topic = 'user:' || v_uid::text then return true; end if;
  if p_topic = 'world:nations' then return true; end if;
  if p_topic like 'chat:%' then
    begin
      v_id := substr(p_topic, 6)::bigint;
    exception when others then
      return false;
    end;
    return exists (select 1 from game.chat_channels ch where ch.id = v_id
                     and (ch.kind in ('global', 'city')
                          or exists (select 1 from game.chat_members m where m.channel_id = ch.id and m.player_id = v_uid)));
  end if;
  return false;
end $$;
revoke all on function public.realtime_can_listen(text) from public, anon;
grant execute on function public.realtime_can_listen(text) to authenticated;
