-- Missiles you can move and upgrade; fleets that carry troops overseas.
--
-- 1. Missiles move like troops: one border at a time (or aboard
--    troopships), between territories you hold. Launching still needs a
--    silo where they are, so you can stock a silo near the front.
-- 2. Military upgrades, bought once per country with the leader's cash:
--      Missile range     3,000 km, +1,500 km a level            (expensive)
--      Warheads          +25% missile damage a level            (expensive)
--      Guidance          air defence stops 15% fewer a level    (expensive)
--      Troopships        each fleet carries 20 soldiers at level 1, +10 a
--                        level, up to 3,000 km, +2,000 km a level (cheap)
--    A new leader starts from scratch, like research.
-- 3. Voyages: fleets fitted as troopships sail from any coast to any coast
--    in range (not just to neighbours) carrying troops, to reinforce your
--    own land or land them on an enemy's shore. Infantry take one place
--    aboard, artillery two, armour three and missiles five.

create table game.upgrade_tracks (
  id text primary key,
  name text not null,
  icon text not null,
  body text not null,
  tech text references game.techs(id),
  prices bigint[] not null, -- mills, one per level ($250k to $4M for missiles, $15k to $120k for troopships)
  sort int not null
);
alter table game.upgrade_tracks enable row level security;
revoke all on game.upgrade_tracks from public, anon, authenticated;

insert into game.upgrade_tracks (id, name, icon, body, tech, prices, sort) values
  ('missile_range', 'Missile range', 'rocket', 'Missiles reach 1,500 km further each level (3,000 km to start).', 'missiles',
    array[250000000, 500000000, 1000000000, 2000000000, 4000000000]::bigint[], 1),
  ('missile_warhead', 'Warheads', 'fire', 'Each level makes your missiles hit 25% harder.', 'missiles',
    array[250000000, 500000000, 1000000000, 2000000000, 4000000000]::bigint[], 2),
  ('missile_guidance', 'Guidance', 'target', 'Each level, enemy air defence stops 15% fewer of your missiles.', 'missiles',
    array[250000000, 500000000, 1000000000, 2000000000, 4000000000]::bigint[], 3),
  ('troopships', 'Troopships', 'ship', 'Fleets carry troops overseas: 20 soldiers a fleet at level 1 and 10 more each level, up to 3,000 km and 2,000 km further each level.', 'navy',
    array[15000000, 30000000, 50000000, 80000000, 120000000]::bigint[], 4)
on conflict (id) do update set name = excluded.name, icon = excluded.icon, body = excluded.body, tech = excluded.tech,
  prices = excluded.prices, sort = excluded.sort;

create table game.nation_upgrades (
  nation_id text not null references game.nations(id) on delete cascade,
  track text not null references game.upgrade_tracks(id),
  level int not null default 0 check (level between 0 and 10),
  primary key (nation_id, track)
);
alter table game.nation_upgrades enable row level security;
revoke all on game.nation_upgrades from public, anon, authenticated;

create function game.upgrade_level(p_nation text, p_track text) returns int
language sql stable as $$
  select coalesce((select level from game.nation_upgrades where nation_id = p_nation and track = p_track), 0)
$$;

-- What the levels do.
create function game.missile_range_km(p_nation text) returns numeric
language sql stable as $$ select 3000 + 1500 * game.upgrade_level(p_nation, 'missile_range')::numeric $$;

create function game.troop_capacity(p_nation text) returns int
language sql stable as $$
  select case when l = 0 then 0 else 20 + 10 * (l - 1) end from (select game.upgrade_level(p_nation, 'troopships') l) x
$$;

create function game.troop_range_km(p_nation text) returns numeric
language sql stable as $$
  select case when l = 0 then 0 else 3000 + 2000 * (l - 1) end::numeric from (select game.upgrade_level(p_nation, 'troopships') l) x
$$;

-- Places aboard a troopship.
create function game.cargo(p_units jsonb) returns int
language sql immutable as $$
  select coalesce((p_units ->> 'infantry')::int, 0) + 2 * coalesce((p_units ->> 'artillery')::int, 0)
       + 3 * coalesce((p_units ->> 'armor')::int, 0) + 5 * coalesce((p_units ->> 'missile')::int, 0)
$$;

-- What a level does, in words.
create function game.upgrade_effect(p_track text, p_level int) returns text
language sql immutable as $$
  select case p_track
    when 'missile_range' then to_char(3000 + 1500 * p_level, 'FM999,999') || ' km range'
    when 'missile_warhead' then case when p_level = 0 then 'Standard warheads' else '+' || (25 * p_level) || '% damage' end
    when 'missile_guidance' then case when p_level = 0 then 'Standard guidance' else (15 * p_level) || '% fewer shot down' end
    when 'troopships' then case when p_level = 0 then 'Fleets can''t carry troops overseas'
      else (20 + 10 * (p_level - 1)) || ' soldiers a fleet · ' || to_char(3000 + 2000 * (p_level - 1), 'FM999,999') || ' km' end
  end
$$;

-- ---------------------------------------------------------------------------
-- Buying upgrades
-- ---------------------------------------------------------------------------
create function game.upgrades_json(p_nation text) returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'tracks', (select coalesce(jsonb_agg(jsonb_build_object(
                  'id', u.id, 'name', u.name, 'icon', u.icon, 'body', u.body, 'tech', u.tech,
                  'ready', p_nation is not null and game.has_tech(p_nation, u.tech),
                  'level', x.lv, 'max', cardinality(u.prices),
                  'price', case when x.lv < cardinality(u.prices) then u.prices[x.lv + 1] end,
                  'now', game.upgrade_effect(u.id, x.lv),
                  'next', case when x.lv < cardinality(u.prices) then game.upgrade_effect(u.id, x.lv + 1) end) order by u.sort), '[]'::jsonb)
                 from game.upgrade_tracks u cross join lateral (select game.upgrade_level(p_nation, u.id) lv) x),
    'missile_range_km', game.missile_range_km(p_nation),
    'troop_capacity', game.troop_capacity(p_nation),
    'troop_range_km', game.troop_range_km(p_nation))
$$;

create function public.military_upgrades() returns jsonb
language plpgsql stable security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me(false);
begin
  return game.upgrades_json(game.player_nation(p.id));
end $$;

create function public.military_upgrade(p_track text) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  n game.nations := game.my_nation_row(game.me());
  u game.upgrade_tracks;
  v_lv int;
begin
  perform game.rate_limit(n.id, 'upgrade', 10, 20);
  select * into u from game.upgrade_tracks where id = p_track;
  if not found then perform game.fail('Unknown upgrade.'); end if;
  if not game.has_tech(n.id, u.tech) then
    perform game.fail(format('Research %s first.', (select name from game.techs where id = u.tech)));
  end if;
  select level into v_lv from game.nation_upgrades where nation_id = n.id and track = u.id for update;
  v_lv := coalesce(v_lv, 0);
  if v_lv >= cardinality(u.prices) then perform game.fail(u.name || ' is fully upgraded.'); end if;
  perform game.spend(n.id, u.prices[v_lv + 1], format('%s level %s', lower(u.name), v_lv + 1));
  insert into game.nation_upgrades (nation_id, track, level) values (n.id, u.id, v_lv + 1)
  on conflict (nation_id, track) do update set level = excluded.level;
  perform game.tell(n.id, 'nation', format('%s level %s', u.name, v_lv + 1), game.upgrade_effect(u.id, v_lv + 1) || '.');
  return game.upgrades_json(n.id);
end $$;

-- A new leader starts from scratch (as with research).
create or replace function game.nation_start(p_id text, p_full boolean) returns void
language plpgsql set search_path = game, pg_temp as $$
declare
  t game.territories;
begin
  select * into t from game.territories where id = p_id;
  delete from game.nation_techs where nation_id = p_id;
  delete from game.research_paid where nation_id = p_id;
  delete from game.recruit_queue where nation_id = p_id;
  delete from game.nation_upgrades where nation_id = p_id;
  delete from game.garrisons where territory_id = p_id;
  delete from game.facilities where territory_id = p_id;
  insert into game.facilities (territory_id, kind, level) values (p_id, 'barracks', 1);
  perform game.garrison_add(p_id, p_id, 'infantry', round(10 + 4 * sqrt(t.pop_m))::int);
  update game.territories set owner_id = p_id, controller_id = p_id, occupied_at = null, development = 1, damage = 0 where id = p_id;
  update game.nations set status = 'active', fallen_at = null,
    treasury = round(t.income * case when p_full then 8 else 4 end)::bigint,
    manpower = t.manpower * 12, research_bank = 0, researching = null, research_progress = 0,
    stability = 70, exhaustion = 0, tax = 'normal', research_pct = 15, infra_pct = 10,
    ai = '{}'::jsonb, last_econ_at = now(), next_think_at = now() + make_interval(secs => 60 + floor(random() * 240)::int)
  where id = p_id;
end $$;

-- ---------------------------------------------------------------------------
-- Moving: missiles between your own land, troops overseas by troopship
-- ---------------------------------------------------------------------------
-- Missiles on the move go by road (120 km a minute), not at missile speed.
create or replace function game.move_minutes(p_nation text, p_units jsonb, p_km numeric) returns numeric
language sql stable as $$
  select 2 + p_km / (min(case when u.id = 'missile' then 120 else u.speed end)
                     * (1 + game.tech_fx(p_nation, 'speed') + 0.06 * game.leader_perk(p_nation, 'logistics')))
    from jsonb_object_keys(p_units) k join game.unit_types u on u.id = k
$$;

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

-- ---------------------------------------------------------------------------
-- Upgraded missiles
-- ---------------------------------------------------------------------------
create or replace function game.do_missiles(p_nation text, p_from text, p_to text, p_qty int) returns game.movements
language plpgsql set search_path = game, pg_temp as $$
declare
  f game.territories;
  t game.territories;
  v_have int;
  v_km numeric;
  v_range numeric := game.missile_range_km(p_nation);
  m game.movements;
begin
  select * into f from game.territories where id = p_from;
  select * into t from game.territories where id = p_to;
  if f.id is null or t.id is null then perform game.fail('Unknown territory.'); end if;
  if f.controller_id is distinct from p_nation then perform game.fail('Launch from your own territory.'); end if;
  if game.blevel(p_from, 'silo') < 1 then perform game.fail('You need a missile silo there.'); end if;
  if not game.at_war(p_nation, t.controller_id) then perform game.fail('You aren''t at war with them.'); end if;
  v_km := game.dist_m(f.lat, f.lng, t.lat, t.lng) / 1000;
  if v_km > v_range then
    perform game.fail(format('%s is %s km away: your missiles reach %s km. Upgrade their range, or move them to a silo nearer.', t.name, round(v_km), to_char(v_range, 'FM999,999')));
  end if;
  select qty into v_have from game.garrisons where territory_id = p_from and nation_id = p_nation and unit = 'missile' for update;
  if p_qty < 1 or coalesce(v_have, 0) < p_qty then perform game.fail('Not enough missiles there.'); end if;
  update game.garrisons set qty = qty - p_qty where territory_id = p_from and nation_id = p_nation and unit = 'missile';
  delete from game.garrisons where territory_id = p_from and nation_id = p_nation and unit = 'missile' and qty = 0;
  insert into game.movements (nation_id, from_t, to_t, units, kind, arrive_at)
  values (p_nation, p_from, p_to, jsonb_build_object('missile', p_qty), 'missile', now() + make_interval(secs => round((1 + v_km / 1500) * 60)::int))
  returning * into m;
  perform game.tell(t.controller_id, 'war', format('Missile launch detected from %s', f.name), format('%s missiles are heading for %s.', p_qty, t.name));
  return m;
end $$;

create or replace function game.missile_strike(m game.movements) returns jsonb
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
  if not game.at_war(m.nation_id, t.controller_id) then
    -- Peace broke out on the way: they're stood down, back at the silo.
    perform game.return_units(m.nation_id, m.from_t, m.units);
    return jsonb_build_object('wasted', true);
  end if;
  v_power := v_qty * 60 * (1 + game.tech_fx(m.nation_id, 'missile')) * (1 + 0.25 * game.upgrade_level(m.nation_id, 'missile_warhead'));
  v_intercept := case when game.tech_fx(m.nation_id, 'no_intercept') > 0 then 0
                      else least(0.75, 0.25 * game.blevel(t.id, 'air_defence'))
                           * greatest(0, 1 - 0.15 * game.upgrade_level(m.nation_id, 'missile_guidance')) end;
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

-- ---------------------------------------------------------------------------
-- Fleets on the map: yours and your allies' exactly, enemies' (at war with
-- you) as estimates, in port and at sea.
-- ---------------------------------------------------------------------------
create function public.fleet_map() returns jsonb
language plpgsql stable security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me(false);
  v_n text := game.player_nation(p.id);
begin
  if v_n is null then return jsonb_build_object('docked', '[]'::jsonb, 'sailing', '[]'::jsonb); end if;
  return jsonb_build_object(
    'docked', (select coalesce(jsonb_agg(jsonb_build_object('t', x.territory_id, 'n', x.nation_id, 'rel', x.rel,
                   'qty', case when x.rel = 'enemy' then game.intel(x.qty) else x.qty end)), '[]'::jsonb)
                 from (select g.territory_id, g.nation_id, g.qty,
                              case when g.nation_id = v_n then 'mine' when game.allied(v_n, g.nation_id) then 'ally'
                                   when game.at_war(v_n, g.nation_id) then 'enemy' end rel
                         from game.garrisons g where g.unit = 'naval' and g.qty > 0) x
                where x.rel is not null),
    'sailing', (select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'n', x.nation_id, 'rel', x.rel, 'from', x.from_t, 'to', x.to_t,
                   'kind', x.kind, 'depart_at', x.depart_at, 'arrive_at', x.arrive_at,
                   'qty', case when x.rel = 'enemy' then game.intel(x.qty) else x.qty end,
                   'troops', case when x.rel = 'enemy' then null else x.troops end)), '[]'::jsonb)
                 from (select m.id, m.nation_id, m.from_t, m.to_t, m.kind, m.depart_at, m.arrive_at,
                              (m.units ->> 'naval')::int qty, game.cargo(m.units) troops,
                              case when m.nation_id = v_n then 'mine' when game.allied(v_n, m.nation_id) then 'ally'
                                   when game.at_war(v_n, m.nation_id) and game.allied(v_n, t.controller_id) then 'enemy' end rel
                         from game.movements m join game.territories t on t.id = m.to_t
                        where m.status = 'moving' and coalesce((m.units ->> 'naval')::int, 0) > 0) x
                where x.rel is not null));
end $$;

revoke all on function public.military_upgrades(), public.military_upgrade(text), public.fleet_map() from public, anon;
grant execute on function public.military_upgrades(), public.military_upgrade(text), public.fleet_map() to authenticated, service_role;
