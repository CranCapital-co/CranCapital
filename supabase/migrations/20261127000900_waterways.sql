-- Sea routes, vital waterways, and ships everyone can see.
--
-- 1. Real sea routes. tools/world/sea.mjs works out, on a quarter-degree
--    grid of open water, the shortest sea route between every pair of
--    coastal countries, the waterways on the way, and the detour when one
--    of them is closed (20261127001000_sea_routes_data.sql). Troopship
--    voyages and cargo ships now sail those routes (they used to take a
--    straight line plus 20%, through any land in the way).
-- 2. Vital waterways: the Suez and Panama canals and the straits of
--    Gibraltar, the Bosphorus, Hormuz, Bab-el-Mandeb, Malacca and Denmark.
--    Whoever holds the country they're in sets who may pass: everyone,
--    everyone for a toll (allies free), allies only, or nobody. Countries at
--    war with the holder can never pass. Closed to you, your ships go the
--    long way round, or can't go at all (the Black Sea, the Baltic, the
--    Persian Gulf and the Red Sea each have only one way in). A new holder
--    starts with the waterway open.
-- 3. Everyone's cargo ships and warships at sea are on the world map for
--    everyone, with the route they sail.

create table if not exists game.waterways (
  id text primary key,
  name text not null,
  kind text not null check (kind in ('canal', 'strait')),
  territory_id text not null references game.territories(id),
  lat float8 not null,
  lng float8 not null,
  path jsonb not null, -- the channel, [[lng, lat], ...], to draw
  policy text not null default 'open' check (policy in ('open', 'toll', 'allies', 'closed')),
  toll bigint not null default 0 check (toll between 0 and 100000000),
  set_at timestamptz
);
alter table game.waterways enable row level security;
revoke all on game.waterways from public, anon, authenticated;

insert into game.waterways (id, name, kind, territory_id, lat, lng, path) values
  ('suez', 'Suez Canal', 'canal', 'egy', 30.6, 32.4, '[[32.3,31.45],[32.33,30.9],[32.42,30.4],[32.55,29.95],[32.75,29.4],[33.3,28.5],[33.9,27.8]]'),
  ('panama', 'Panama Canal', 'canal', 'pan', 9.1, -79.7, '[[-79.95,9.7],[-79.85,9.35],[-79.7,9.1],[-79.55,8.85],[-79.5,8.5]]'),
  ('gibraltar', 'Strait of Gibraltar', 'strait', 'esp', 35.97, -5.6, '[[-7.0,35.9],[-5.6,35.97],[-4.4,36.2]]'),
  ('bosphorus', 'Bosphorus and Dardanelles', 'strait', 'tur', 41.15, 29.05, '[[25.6,39.9],[26.3,40.15],[26.7,40.4],[27.5,40.7],[28.4,40.9],[29.0,41.05],[29.15,41.3],[29.4,41.6]]'),
  ('hormuz', 'Strait of Hormuz', 'strait', 'irn', 26.45, 56.4, '[[55.4,25.9],[56.3,26.55],[57.0,25.9]]'),
  ('bab_el_mandeb', 'Bab-el-Mandeb', 'strait', 'yem', 12.6, 43.35, '[[42.4,13.9],[43.3,12.7],[43.9,12.3]]'),
  ('malacca', 'Strait of Malacca', 'strait', 'mys', 2.5, 101.4, '[[97.5,6.0],[99.0,4.3],[100.6,3.0],[101.6,2.3],[102.8,1.6],[103.6,1.2],[104.6,1.3]]'),
  ('danish', 'Danish Straits', 'strait', 'dnk', 55.6, 11.8, '[[8.5,57.9],[10.6,57.8],[11.4,57.1],[11.9,56.4],[12.6,56.0],[12.8,55.4],[13.6,55.0]]')
on conflict (id) do update set name = excluded.name, kind = excluded.kind, territory_id = excluded.territory_id,
  lat = excluded.lat, lng = excluded.lng, path = excluded.path;

create table if not exists game.sea_routes (
  a text not null,
  b text not null,
  km int not null,
  via text[] not null default '{}',
  primary key (a, b)
);
create table if not exists game.sea_alts (
  a text not null,
  b text not null,
  waterway text not null,
  km int, -- null: no way round
  via text[] not null default '{}',
  primary key (a, b, waterway)
);
alter table game.sea_routes enable row level security;
alter table game.sea_alts enable row level security;
revoke all on game.sea_routes, game.sea_alts from public, anon, authenticated;

alter table game.shipments
  add column if not exists from_t text,
  add column if not exists to_t text,
  add column if not exists via text[] not null default '{}',
  add column if not exists avoid text[] not null default '{}',
  add column if not exists tolls bigint not null default 0;

insert into game.ledger_kinds (kind, label, flow) values
  ('waterway_toll', 'Waterway tolls', 'world_out'),
  ('waterway_income', 'Waterway tolls collected', 'world_in')
on conflict (kind) do nothing;

-- Who may pass: 'open', 'toll' or 'closed' for this nation (null: a player
-- with no country).
create or replace function game.waterway_access(w game.waterways, p_nation text) returns text
language plpgsql stable set search_path = game, pg_temp as $$
declare
  v_ctrl text := (select controller_id from game.territories where id = w.territory_id);
begin
  if p_nation is not null and p_nation = v_ctrl then return 'open'; end if;
  if p_nation is not null and game.at_war(p_nation, v_ctrl) then return 'closed'; end if;
  return case w.policy
    when 'open' then 'open'
    when 'toll' then case when p_nation is not null and game.allied(p_nation, v_ctrl) then 'open' else 'toll' end
    when 'allies' then case when p_nation is not null and game.allied(p_nation, v_ctrl) then 'open' else 'closed' end
    else 'closed' end;
end $$;

-- The sea route this nation's ships take from one country to another:
-- km, the waterways on the way, tolls due, and the waterways closed to it
-- (for drawing the route). blocked: the waterway that leaves no way round.
create or replace function game.sea_route(p_nation text, p_from text, p_to text) returns jsonb
language plpgsql stable set search_path = game, pg_temp as $$
declare
  r game.sea_routes;
  al game.sea_alts;
  v_closed text[];
  v_km int;
  v_via text[];
  v_tolls bigint := 0;
  w game.waterways;
begin
  if p_from = p_to then return jsonb_build_object('km', 0, 'via', '[]'::jsonb, 'tolls', 0, 'avoid', '[]'::jsonb); end if;
  select * into r from game.sea_routes where a = least(p_from, p_to) and b = greatest(p_from, p_to);
  if not found then return null; end if;
  select coalesce(array_agg(x.id), '{}') into v_closed from game.waterways x where game.waterway_access(x, p_nation) = 'closed';
  v_km := r.km;
  v_via := r.via;
  for w in select * from game.waterways where id = any (r.via) and id = any (v_closed) limit 1 loop
    select * into al from game.sea_alts where a = least(p_from, p_to) and b = greatest(p_from, p_to) and waterway = w.id;
    if al.km is null or al.via && v_closed then
      return jsonb_build_object('blocked', w.id, 'blocked_name', w.name, 'avoid', to_jsonb(v_closed));
    end if;
    v_km := al.km;
    v_via := al.via;
  end loop;
  select coalesce(sum(x.toll), 0) into v_tolls from game.waterways x where x.id = any (v_via) and game.waterway_access(x, p_nation) = 'toll';
  return jsonb_build_object('km', v_km, 'via', to_jsonb(v_via), 'tolls', v_tolls, 'avoid', to_jsonb(v_closed));
end $$;

-- Tolls: from the payer (a nation's funds, or a player with no country) to
-- whoever holds each waterway.
create or replace function game.pay_tolls(p_player uuid, p_nation text, p_via text[], p_what text) returns bigint
language plpgsql set search_path = game, pg_temp as $$
declare
  w game.waterways;
  v_ctrl text;
  v_total bigint := 0;
begin
  for w in select * from game.waterways where id = any (p_via) and toll > 0 loop
    if game.waterway_access(w, p_nation) <> 'toll' then continue; end if;
    v_ctrl := (select controller_id from game.territories where id = w.territory_id);
    if p_nation is not null and (select leader_id from game.nations where id = p_nation) is null then
      perform game.spend(p_nation, w.toll, w.name || ' toll');
    else
      if (select cash from game.players where id = p_player) < w.toll then
        perform game.fail(format('The %s toll is %s and you can''t afford it.', w.name, game.fmt(w.toll)));
      end if;
      perform game.money(p_player, -w.toll, 'waterway_toll', format('%s toll (%s)', w.name, p_what), jsonb_build_object('waterway', w.id));
    end if;
    if (select leader_id from game.nations where id = v_ctrl) is not null then
      perform game.money((select leader_id from game.nations where id = v_ctrl), w.toll, 'waterway_income', format('%s toll', w.name), jsonb_build_object('waterway', w.id));
    else
      update game.nations set treasury = treasury + w.toll where id = v_ctrl;
    end if;
    v_total := v_total + w.toll;
  end loop;
  return v_total;
end $$;

-- A new holder starts with the waterway open.
create or replace function game.waterway_holder_changed() returns trigger
language plpgsql set search_path = game, pg_temp as $$
begin
  update game.waterways set policy = 'open', toll = 0, set_at = null where territory_id = new.id and policy <> 'open';
  return null;
end $$;
drop trigger if exists waterway_holder_changed on game.territories;
create trigger waterway_holder_changed after update of controller_id on game.territories
  for each row when (old.controller_id is distinct from new.controller_id and new.id in ('egy', 'pan', 'esp', 'tur', 'irn', 'yem', 'mys', 'dnk'))
  execute function game.waterway_holder_changed();

-- The waterways, and what they mean for you.
create or replace function public.waterways() returns jsonb
language plpgsql stable security definer set search_path = game, pg_temp as $$
declare
  v_me text := game.player_nation(game.uid());
begin
  return (select coalesce(jsonb_agg(jsonb_build_object(
      'id', w.id, 'name', w.name, 'kind', w.kind, 'territory', w.territory_id, 'lat', w.lat, 'lng', w.lng, 'path', w.path,
      'holder', t.controller_id, 'holder_name', game.nation_name(t.controller_id),
      'policy', w.policy, 'toll', w.toll, 'mine', t.controller_id = v_me,
      'access', game.waterway_access(w, v_me)) order by w.name), '[]'::jsonb)
    from game.waterways w join game.territories t on t.id = w.territory_id);
end $$;

create or replace function public.waterway_set(p_id text, p_policy text, p_toll bigint default 0) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  n game.nations := game.my_nation_row(game.me());
  w game.waterways;
begin
  perform game.rate_limit(n.id, 'waterway', 6, 6);
  select * into w from game.waterways where id = p_id for update;
  if not found then perform game.fail('Unknown waterway.'); end if;
  if (select controller_id from game.territories where id = w.territory_id) <> n.id then
    perform game.fail(format('Only whoever holds %s controls the %s.', game.nation_name(w.territory_id), w.name));
  end if;
  if p_policy not in ('open', 'toll', 'allies', 'closed') then perform game.fail('Choose open, toll, allies or closed.'); end if;
  if p_policy = 'toll' and (p_toll is null or p_toll < 1000 or p_toll > 100000000) then
    perform game.fail('Set a toll between $1 and $100,000 a ship.');
  end if;
  update game.waterways set policy = p_policy, toll = case when p_policy = 'toll' then p_toll else 0 end, set_at = now() where id = w.id;
  if p_policy <> w.policy then
    perform game.news('waterway',
      case p_policy
        when 'open' then format('%s opens the %s to all ships', n.name, w.name)
        when 'toll' then format('%s charges %s a ship through the %s', n.name, game.fmt(p_toll), w.name)
        when 'allies' then format('%s closes the %s to all but its allies', n.name, w.name)
        else format('%s closes the %s', n.name, w.name) end,
      null, array[n.id]);
  end if;
  delete from game.api_cache where key = 'world_ships';
  return public.waterways();
end $$;

-- What a voyage would be, for the Send troops window.
create or replace function public.sea_route_info(p_from text, p_to text) returns jsonb
language sql stable security definer set search_path = game, pg_temp as $$
  select game.sea_route(game.player_nation(game.uid()), p_from, p_to)
$$;

-- Everyone's ships at sea, the same for every player (shared for 30 s):
-- cargo ships with their owner and load, and warships with their country
-- and roughly how many.
create or replace function game.world_ships_build() returns jsonb
language sql stable set search_path = game, pg_temp as $$
  select jsonb_build_object(
    'cargo', (select coalesce(jsonb_agg(x order by x.arrive_at), '[]'::jsonb) from (
      select s.id, pl.display_name owner, pl.player_no owner_no, game.player_nation(s.owner_id) nation,
             s.good_id good, s.qty, s.from_city, s.to_city, s.from_t, s.to_t, s.avoid,
             a.hub_lng from_lng, a.hub_lat from_lat, b.hub_lng to_lng, b.hub_lat to_lat, s.depart_at, s.arrive_at
        from game.shipments s join game.players pl on pl.id = s.owner_id
        join game.cities a on a.id = s.from_city join game.cities b on b.id = s.to_city
       where s.status = 'in_transit' order by s.depart_at desc limit 150) x),
    'fleets', (select coalesce(jsonb_agg(x order by x.arrive_at), '[]'::jsonb) from (
      select m.id, m.nation_id nation, m.from_t, m.to_t, m.kind, m.depart_at, m.arrive_at,
             game.intel((m.units ->> 'naval')::int) qty,
             (select coalesce(jsonb_agg(w.id), '[]'::jsonb) from game.waterways w where game.waterway_access(w, m.nation_id) = 'closed') avoid
        from game.movements m
       where m.status = 'moving' and coalesce((m.units ->> 'naval')::int, 0) > 0
       order by m.depart_at desc limit 150) x));
$$;

create or replace function public.world_ships() returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  v jsonb;
begin
  select val into v from game.api_cache where key = 'world_ships' and at > now() - interval '30 seconds';
  return coalesce(v, game.cache_put('world_ships', game.world_ships_build()));
end $$;

revoke all on function public.waterways(), public.waterway_set(text, text, bigint), public.sea_route_info(text, text), public.world_ships() from public, anon;
grant execute on function public.waterways(), public.waterway_set(text, text, bigint), public.sea_route_info(text, text), public.world_ships() to authenticated, service_role;

-- A city's country (for sea routes): by name, or the nearest coastal one.
create or replace function game.city_territory(p_city text) returns text
language sql stable set search_path = game, pg_temp as $$
  select coalesce(
    (select t.id from game.territories t join game.cities c on c.id = p_city where lower(t.name) = lower(c.country)),
    (select t.id from game.territories t, game.cities c where c.id = p_city and not t.landlocked
      order by game.dist_m(t.lat, t.lng, c.hub_lat, c.hub_lng) limit 1))
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
  v_route jsonb;
  v_tolls bigint := 0;
  v_via text[] := '{}';
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
    -- The real sea route (around the land, and around any waterway closed
    -- to us), and its tolls.
    v_route := game.sea_route(p_nation, p_from, p_to);
    if v_route is null then
      v_km := round(game.dist_m(f.lat, f.lng, t.lat, t.lng) / 1000 * 1.2);
    elsif v_route ? 'blocked' then
      perform game.fail(format('The %s is closed to you, and there''s no other way to %s by sea.', v_route ->> 'blocked_name', t.name));
    else
      v_km := (v_route ->> 'km')::numeric;
      v_tolls := (v_route ->> 'tolls')::bigint;
      v_via := array(select jsonb_array_elements_text(v_route -> 'via'));
    end if;
    if v_km > v_range then
      perform game.fail(format('%s is %s km away by sea: your troopships reach %s km. Upgrade them to sail further.', t.name, to_char(v_km, 'FM999,999'), to_char(v_range, 'FM999,999')));
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
  -- Waterway tolls on the way.
  if v_tolls > 0 then perform game.pay_tolls((select leader_id from game.nations where id = p_nation), p_nation, v_via, 'fleet to ' || t.name); end if;
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

create or replace function game.ship(p game.players, p_port bigint, p_good text, p_qty bigint, p_to text, p_kind text) returns jsonb
language plpgsql set search_path = game, pg_temp as $$
declare
  b game.businesses := game.my_business(p, p_port);
  g game.goods;
  v_km float8;
  v_freight bigint;
  v_minutes int;
  v_unit bigint;
  v_cap bigint;
  v_used bigint;
  v_id bigint;
  v_from_t text;
  v_to_t text;
  v_route jsonb;
  v_via text[] := '{}';
  v_avoid text[] := '{}';
  v_tolls bigint := 0;
begin
  if b.kind <> 'port' then perform game.fail('Ship goods from one of your ports.'); end if;
  if p_kind not in ('transfer', 'export') then perform game.fail('Choose transfer or export.'); end if;
  select * into g from game.goods where id = p_good;
  if not found then perform game.fail('Unknown good.'); end if;
  if p_to = b.city_id or not exists (select 1 from game.cities where id = p_to) then perform game.fail('Choose another city.'); end if;
  if p_qty is null or p_qty <= 0 then perform game.fail('Enter a quantity.'); end if;
  v_cap := round(b.level * 50000);
  select coalesce(sum(qty), 0) into v_used from game.shipments where port_id = b.id and depart_at > now() - interval '1 hour';
  if v_used + p_qty > v_cap then
    perform game.fail(format('This port can load %s units an hour (%s left this hour). Upgrade it for more.', v_cap, greatest(0, v_cap - v_used)));
  end if;
  -- By sea: around the land, and around any waterway closed to us.
  v_from_t := game.city_territory(b.city_id);
  v_to_t := game.city_territory(p_to);
  v_route := game.sea_route(game.player_nation(p.id), v_from_t, v_to_t);
  if v_route ? 'blocked' then
    perform game.fail(format('The %s is closed to your ships, and there''s no other way there by sea.', v_route ->> 'blocked_name'));
  end if;
  if v_route is null or v_from_t = v_to_t then
    v_km := game.city_km(b.city_id, p_to);
  else
    v_km := (v_route ->> 'km')::float8;
    v_via := array(select jsonb_array_elements_text(v_route -> 'via'));
    v_avoid := array(select jsonb_array_elements_text(v_route -> 'avoid'));
    v_tolls := (v_route ->> 'tolls')::bigint;
  end if;
  v_minutes := 8 + round(v_km / 600)::int;
  v_freight := round(p_qty * g.base_price * (0.02 + v_km / 400000.0));
  perform game.stock_add(p.id, b.city_id, p_good, -p_qty);
  perform game.money(p.id, -v_freight, 'freight', format('Shipping %s %s to %s', p_qty, g.name, (select name from game.cities where id = p_to)),
    jsonb_build_object('good', p_good, 'qty', p_qty, 'to', p_to));
  if v_tolls > 0 then perform game.pay_tolls(p.id, game.player_nation(p.id), v_via, format('%s %s', p_qty, g.name)); end if;
  if p_kind = 'export' then
    v_unit := floor(g.base_price * game.import_mult(p_to, p_good));
  end if;
  insert into game.shipments (owner_id, port_id, kind, from_city, to_city, good_id, qty, freight, unit_price, arrive_at, from_t, to_t, via, avoid, tolls)
  values (p.id, b.id, p_kind, b.city_id, p_to, p_good, p_qty, v_freight, v_unit, now() + make_interval(mins => v_minutes), v_from_t, v_to_t, v_via, v_avoid, v_tolls)
  returning id into v_id;
  delete from game.api_cache where key = 'world_ships';
  return jsonb_build_object('shipment_id', v_id, 'arrive_minutes', v_minutes, 'freight', v_freight, 'est_unit_price', v_unit, 'km', round(v_km), 'via', v_via, 'tolls', v_tolls);
end $$;

-- Troopships reach further now that voyages follow real sea lanes (longer
-- than the straight line plus a fifth they used to be): 4,000 km at level
-- 1 and 3,000 km more each level (16,000 km at level 5).
create or replace function game.troop_range_km(p_nation text) returns numeric
language sql stable as $$
  select case when l = 0 then 0 else 4000 + 3000 * (l - 1) end::numeric from (select game.upgrade_level(p_nation, 'troopships') l) x
$$;
create or replace function game.upgrade_effect(p_track text, p_level int) returns text
language sql immutable as $$
  select case p_track
    when 'missile_range' then to_char(3000 + 1500 * p_level, 'FM999,999') || ' km range'
    when 'missile_warhead' then case when p_level = 0 then 'Standard warheads' else '+' || (25 * p_level) || '% damage' end
    when 'missile_guidance' then case when p_level = 0 then 'Standard guidance' else (15 * p_level) || '% fewer shot down' end
    when 'troopships' then case when p_level = 0 then 'Fleets can''t carry troops overseas'
      else (20 + 10 * (p_level - 1)) || ' soldiers a fleet · ' || to_char(4000 + 3000 * (p_level - 1), 'FM999,999') || ' km' end
  end
$$;
update game.upgrade_tracks set body = 'Fleets carry troops overseas: 20 soldiers a fleet at level 1 and 10 more each level, up to 4,000 km by sea and 3,000 km further each level.'
 where id = 'troopships';
