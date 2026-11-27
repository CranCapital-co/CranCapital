-- Allies overseas only count if they can get there.
--
-- When you attacked a country, its allies' troops stationed in it counted
-- towards its defence (and the odds the game showed you), even an ally on
-- another continent with no navy that had walked its army across a sea
-- link. Now:
--   * an ally's ground troops in a territory count towards its defence only
--     if the ally holds land next to it or has a capable navy (3 fleets or
--     more); air wings and fleets always count;
--   * reinforcing an ally across the sea needs fleets sailing with the
--     troops, or a navy of 3 fleets;
--   * the troop estimates you see leave out allies that can't get there
--     (and add up units properly when several countries have troops there).

create or replace function game.has_navy(p_nation text) returns boolean
language sql stable as $$
  select coalesce((select sum(qty) from game.garrisons where nation_id = p_nation and unit = 'naval'), 0) >= 3
$$;

-- Can this nation get troops to this territory: it holds it, holds land
-- next to it, or has a navy.
create or replace function game.can_reach(p_nation text, p_territory text) returns boolean
language sql stable as $$
  select exists (select 1 from game.territories where id = p_territory and controller_id = p_nation)
      or exists (select 1 from game.territory_links l join game.territories t on t.id = l.b
                  where l.a = p_territory and l.kind = 'land' and t.controller_id = p_nation)
      or game.has_navy(p_nation)
$$;

create or replace function game.defence_power(p_territory text, p_attacker text, p_militia boolean default true) returns numeric
language plpgsql stable set search_path = game, pg_temp as $$
declare
  t game.territories;
  v numeric;
begin
  select * into t from game.territories where id = p_territory;
  select coalesce(sum(g.qty * u.def * game.unit_mult(g.nation_id, g.unit, 'def')), 0) into v
    from game.garrisons g join game.unit_types u on u.id = g.unit
   where g.territory_id = p_territory and g.qty > 0 and g.unit <> 'missile' and (p_attacker is null or game.at_war(p_attacker, g.nation_id))
     -- Allies' troops overseas only count if the ally can get them there.
     and (g.nation_id = t.controller_id or g.unit in ('air', 'naval') or game.can_reach(g.nation_id, p_territory));
  if p_militia and t.controller_id = t.owner_id then v := v + t.militia; end if;
  return v * (1 + 0.15 * game.blevel(p_territory, 'fort') * (1 + game.tech_fx(t.controller_id, 'fort')));
end $$;

create or replace function game.do_send(p_nation text, p_from text, p_to text, p_units jsonb) returns game.movements
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
  v_fleets int;
  v_cap int;
  v_range numeric;
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
    select qty into v_have from game.garrisons where territory_id = p_from and nation_id = p_nation and unit = k for update;
    if coalesce(v_have, 0) < v then perform game.fail(format('You only have %s %s there.', coalesce(v_have, 0), (select plural from game.unit_types where id = k))); end if;
    if k <> 'air' then v_air_only := false; end if;
    v_units := v_units || jsonb_build_object(k, v);
  end loop;
  if v_units = '{}'::jsonb then perform game.fail('Choose some units to send.'); end if;
  if v_units ? 'missile' and (f.controller_id is distinct from p_nation or t.controller_id is distinct from p_nation) then
    perform game.fail('Missiles can only be moved between territories you hold. To hit an enemy, launch them from a silo.');
  end if;
  select * into l from game.territory_links where a = p_from and b = p_to;
  if l.a is not null then
    v_km := l.km;
  elsif v_air_only then
    v_km := game.dist_m(f.lat, f.lng, t.lat, t.lng) / 1000;
    if v_km > 2500 then perform game.fail(format('%s is %s km away: air wings reach 2,500 km.', t.name, round(v_km))); end if;
  elsif v_units ? 'naval' then
    -- A voyage: fleets sail coast to coast, with troops aboard if they're
    -- fitted as troopships. Sea lanes aren't straight lines: +20%.
    if t.landlocked or f.landlocked then perform game.fail('Fleets sail only between coasts.'); end if;
    v_range := game.troop_range_km(p_nation);
    if v_range = 0 then
      perform game.fail(format('%s doesn''t border %s. Upgrade your fleets to troopships (Military, Upgrades) to sail overseas.', t.name, f.name));
    end if;
    v_km := round(game.dist_m(f.lat, f.lng, t.lat, t.lng) / 1000 * 1.2);
    if v_km > v_range then
      perform game.fail(format('%s is %s km away by sea: your troopships reach %s km. Upgrade them to sail further.', t.name, v_km, to_char(v_range, 'FM999,999')));
    end if;
    if coalesce((v_units ->> 'air')::int, 0) > 0 and v_km > 2500 then
      perform game.fail('Air wings reach 2,500 km: send them separately.');
    end if;
    v_fleets := (v_units ->> 'naval')::int;
    v_cap := v_fleets * game.troop_capacity(p_nation);
    if game.cargo(v_units) > v_cap then
      perform game.fail(format('%s %s carry %s soldiers and you''re sending %s (artillery take 2 places, armour 3, missiles 5). Send more fleets or upgrade your troopships.',
        v_fleets, case when v_fleets = 1 then 'fleet' else 'fleets' end, v_cap, game.cargo(v_units)));
    end if;
  else
    perform game.fail(format('%s doesn''t border %s. Ground forces cross one border at a time, air wings fly up to 2,500 km, and troopships carry troops overseas.', t.name, f.name));
  end if;
  if v_units ? 'naval' and (t.landlocked or f.landlocked) then perform game.fail('Fleets sail only between coasts.'); end if;
  -- Reinforcing an ally over the sea takes a navy: fleets sailing with the
  -- troops, or one big enough to escort them (3 fleets or more).
  if l.kind = 'sea' and t.controller_id is distinct from p_nation and game.allied(p_nation, t.controller_id)
     and exists (select 1 from jsonb_object_keys(v_units) uk where uk in ('infantry', 'artillery', 'armor', 'missile'))
     and not v_units ? 'naval' and not game.has_navy(p_nation) then
    perform game.fail(format('%s is across the sea. Send fleets with your troops (or build a navy of 3 fleets) to reinforce an ally overseas.', t.name));
  end if;
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
    perform game.tell(t.controller_id, 'war',
      format('%s %s heading for %s', game.nation_name(p_nation), case when l.a is null and v_units ? 'naval' then 'warships are' else 'forces are' end, t.name),
      format('They arrive around %s UTC.', to_char(m.arrive_at at time zone 'utc', 'HH24:MI')), jsonb_build_object('movement', m.id));
  end if;
  perform game.push('world:nations', 'move', jsonb_build_object('id', m.id, 'nation', p_nation, 'from', p_from, 'to', p_to, 'kind', v_kind, 'arrive_at', m.arrive_at));
  return m;
end $$;

create or replace function public.nation_info(p_id text) returns jsonb
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
                      -- Troops that would defend it: the holder's, and allies' that can get
                      -- there (an ally without a navy overseas doesn't count).
                      'troops', (select coalesce(jsonb_object_agg(x.unit, x.qty), '{}'::jsonb) from (
                                   select g.unit, sum(case when v_me is not null and game.allied(v_me, g.nation_id) then g.qty else game.intel(g.qty) end)::int qty
                                     from (select unit, nation_id, sum(qty)::int qty from game.garrisons where territory_id = t.id and qty > 0 group by unit, nation_id) g
                                    where g.nation_id = t.controller_id or g.unit in ('air', 'naval') or game.can_reach(g.nation_id, t.id)
                                    group by g.unit) x)) order by t.value desc), '[]'::jsonb)
                    from game.territories t where t.controller_id = n.id or t.owner_id = n.id),
    'wars', (select coalesce(jsonb_agg(jsonb_build_object('id', w.id, 'name', w.name, 'score', round(case when s.side = 'att' then w.score else -w.score end))), '[]'::jsonb)
             from game.war_sides s join game.wars w on w.id = s.war_id and w.status = 'active' where s.nation_id = n.id),
    'relation', case when v_me is not null and v_me <> p_id then round(game.rel(v_me, p_id)) end,
    'treaty', case when tr.id is not null then jsonb_build_object('kind', tr.kind, 'until', tr.until) end,
    'can_declare', v_me is not null and v_me <> p_id and v_why is null,
    'why_not', v_why,
    'mine', v_me = p_id);
end $$;
