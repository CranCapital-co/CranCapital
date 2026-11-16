-- CranCapital businesses and property: carts, rented rooms with fit-out and
-- staff, plots and what's built on them, buildings and landlords, surveys
-- and deposits, ports and shipping, net worth and tiers.

insert into game.config (key, value, note) values
  ('max_carts', 5, 'Most food carts one player can run'),
  ('cart_spacing_m', 12, 'Two carts can''t park closer than this'),
  ('competition_radius_m', 120, 'Businesses this close compete for the same crowd'),
  ('sellback_pct', 50, 'Share of book value the city pays when you sell a business back'),
  ('plot_base_price', 30000000, 'Plot price before city and foot-traffic factors ($30,000)'),
  ('building_price_days', 90, 'A building costs this many days of its full rent'),
  ('npc_rent_per_unit', 70000, 'Daily rent per apartment unit from local tenants ($70)'),
  ('apartment_units', 40, 'Apartment units per level'),
  ('room_rent_base', 50000, 'Base daily rent of a room ($50) before traffic, kind and city factors'),
  ('max_dt_hours', 1, 'Longest stretch one tick will simulate for a business');

-- City price and wage levels.
create function game.seed_city_economy() returns void
language sql set search_path = game, pg_temp as $$
  update game.cities set price_factor = 1.4, wage_per_hour = 16000, sort = 1 where id = 'london';
  update game.cities set price_factor = 1.5, wage_per_hour = 18000, sort = 2 where id = 'new-york';
  update game.cities set price_factor = 1.3, wage_per_hour = 14000, sort = 3 where id = 'tokyo';
  update game.cities set price_factor = 1.2, wage_per_hour = 13000, sort = 4 where id = 'singapore';
$$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table game.businesses (
  id bigint generated always as identity primary key,
  owner_id uuid not null references game.players(id),
  city_id text not null references game.cities(id),
  kind text not null references game.business_types(id),
  name text not null,
  lat float8 not null,
  lng float8 not null,
  traffic numeric not null default 1,
  building_id bigint references game.buildings(id),
  plot_x int,
  plot_y int,
  deposit_id bigint,
  level smallint not null default 1,
  status text not null default 'open' check (status in ('open', 'closed', 'sold', 'abandoned', 'depleted')),
  open_hour smallint not null default 7 check (open_hour between 0 and 23),
  close_hour smallint not null default 22 check (close_hour between 0 and 24),
  staff int not null default 0 check (staff >= 0),
  settings jsonb not null default '{}'::jsonb,
  fitout jsonb not null default '[]'::jsonb,
  capacity numeric not null default 0,
  attract numeric not null default 1,
  max_staff int not null default 0,
  carry numeric not null default 0,
  fuel_carry numeric not null default 0,
  book_value bigint not null default 0,
  last_tick_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  stats_day date,
  sales_today bigint not null default 0,
  revenue_today bigint not null default 0,
  costs_today bigint not null default 0,
  produced_today bigint not null default 0,
  lifetime_sales bigint not null default 0,
  lifetime_revenue bigint not null default 0,
  flags jsonb not null default '{}'::jsonb
);
create index businesses_owner_idx on game.businesses (owner_id) where status not in ('sold');
create index businesses_city_idx on game.businesses (city_id, lat, lng) where status in ('open', 'closed', 'abandoned', 'depleted');
create index businesses_building_idx on game.businesses (building_id) where building_id is not null;

-- Daily history per business, for charts.
alter table game.players add column starter_given boolean not null default false;

create table game.business_days (
  business_id bigint not null references game.businesses(id),
  day date not null,
  sales bigint not null default 0,
  revenue bigint not null default 0,
  costs bigint not null default 0,
  produced bigint not null default 0,
  primary key (business_id, day)
);

create table game.leases (
  id bigint generated always as identity primary key,
  building_id bigint not null references game.buildings(id),
  tenant_id uuid not null references game.players(id),
  business_id bigint not null references game.businesses(id),
  rent_per_day bigint not null,
  started_at timestamptz not null default now(),
  unpaid bigint not null default 0,
  unpaid_since timestamptz,
  status text not null default 'active' check (status in ('active', 'ended')),
  ended_at timestamptz
);
create unique index leases_business_active on game.leases (business_id) where status = 'active';
create index leases_building_idx on game.leases (building_id) where status = 'active';

create table game.plots (
  city_id text not null references game.cities(id),
  px int not null,
  py int not null,
  owner_id uuid not null references game.players(id),
  bought_price bigint not null,
  city_price bigint not null,
  bought_at timestamptz not null default now(),
  business_id bigint references game.businesses(id),
  for_sale_price bigint,
  primary key (city_id, px, py)
);
create index plots_owner_idx on game.plots (owner_id);

create table game.secrets (
  key text primary key,
  value text not null
);
insert into game.secrets (key, value) values ('deposit_salt', encode(extensions.gen_random_bytes(24), 'hex'));
revoke all on game.secrets from public;

create table game.deposits (
  id bigint generated always as identity primary key,
  city_id text not null references game.cities(id),
  px int not null,
  py int not null,
  bx int not null,
  by int not null,
  resource text not null references game.goods(id),
  units_total bigint not null,
  units_left bigint not null,
  unique (city_id, px, py)
);
create index deposits_block_idx on game.deposits (city_id, bx, by);

create table game.surveyed_blocks (
  city_id text not null,
  bx int not null,
  by int not null,
  generated_at timestamptz not null default now(),
  primary key (city_id, bx, by)
);

create table game.surveys (
  player_id uuid not null references game.players(id),
  city_id text not null,
  bx int not null,
  by int not null,
  at timestamptz not null default now(),
  primary key (player_id, city_id, bx, by)
);

create table game.shipments (
  id bigint generated always as identity primary key,
  owner_id uuid not null references game.players(id),
  port_id bigint references game.businesses(id),
  kind text not null check (kind in ('transfer', 'export')),
  from_city text not null references game.cities(id),
  to_city text not null references game.cities(id),
  good_id text not null references game.goods(id),
  qty bigint not null check (qty > 0),
  freight bigint not null default 0,
  unit_price bigint,
  depart_at timestamptz not null default now(),
  arrive_at timestamptz not null,
  status text not null default 'in_transit' check (status in ('in_transit', 'delivered')),
  delivered_value bigint
);
create index shipments_due_idx on game.shipments (arrive_at) where status = 'in_transit';
create index shipments_owner_idx on game.shipments (owner_id, depart_at desc);

-- Overseas buyers' prices for exports, per destination city and good.
create table game.import_markets (
  city_id text not null references game.cities(id),
  good_id text not null references game.goods(id),
  ref_mult float8 not null default 1,
  primary key (city_id, good_id)
);

-- ---------------------------------------------------------------------------
-- Prices of things
-- ---------------------------------------------------------------------------
create function game.room_rent(b game.buildings) returns bigint
language sql stable set search_path = game, pg_temp as $$
  select round(game.cfg('room_rent_base') * power(0.5 + b.traffic, 1.2)
    * case b.kind when 'station' then 1.6 when 'landmark' then 1.5 when 'hotel' then 1.2
                  when 'commercial' then 1.1 when 'office' then 1.0 else 0.9 end
    * (select price_factor from game.cities where id = b.city_id)
    * case when b.owner_id is null then 1 else b.rent_pct / 100.0 end)::bigint
$$;

-- What the city sells a building for: days of full (100%) rent.
create function game.building_value(b game.buildings) returns bigint
language sql stable set search_path = game, pg_temp as $$
  select round(b.rooms_total * game.cfg('room_rent_base') * power(0.5 + b.traffic, 1.2)
    * case b.kind when 'station' then 1.6 when 'landmark' then 1.5 when 'hotel' then 1.2
                  when 'commercial' then 1.1 when 'office' then 1.0 else 0.9 end
    * (select price_factor from game.cities where id = b.city_id)
    * game.cfg('building_price_days'))::bigint
$$;

create function game.plot_price(c game.cities, p_px int, p_py int) returns bigint
language plpgsql stable set search_path = game, pg_temp as $$
declare
  pc record;
begin
  select * into pc from game.plot_center(c, p_px, p_py);
  return round(game.cfg('plot_base_price') * c.price_factor * (0.6 + 0.4 * game.traffic_at(c, pc.lat, pc.lng)))::bigint;
end $$;

create function game.upgrade_cost(t game.business_types, p_level int) returns bigint
language sql immutable set search_path = game, pg_temp as $$
  select round(t.cost * 1.5 * p_level)::bigint
$$;

create function game.level_mult(p_level int) returns numeric
language sql immutable set search_path = game, pg_temp as $$
  select 1 + 0.8 * (p_level - 1)
$$;

-- Menu slots by business kind and level.
create function game.menu_slots(p_kind text, p_level int) returns int
language sql immutable set search_path = game, pg_temp as $$
  select case when p_kind = 'cart' then (array[3, 4, 6])[least(greatest(p_level, 1), 3)] else 4 + p_level end
$$;

create function game.is_open_hour(p_open int, p_close int, p_hour int) returns boolean
language sql immutable set search_path = game, pg_temp as $$
  select case
    when p_open = p_close or (p_open = 0 and p_close = 24) then true
    when p_open < p_close then p_hour >= p_open and p_hour < p_close
    else p_hour >= p_open or p_hour < p_close end
$$;

-- How busy each kind of business is through the day (local time).
create function game.hour_factor(p_category text, p_hour int, p_dow int) returns numeric
language sql immutable set search_path = game, pg_temp as $$
  select (case p_category
    when 'street' then array[0.05,0.03,0.02,0.02,0.03,0.08,0.2,0.45,0.6,0.55,0.6,0.95,1.45,1.4,0.95,0.75,0.75,0.95,1.05,0.95,0.75,0.55,0.35,0.15]
    when 'cafe' then array[0.02,0.01,0.01,0.01,0.02,0.1,0.5,1.3,1.7,1.5,1.1,0.9,0.95,0.9,0.85,0.9,0.75,0.55,0.35,0.25,0.15,0.08,0.04,0.03]
    when 'restaurant' then array[0.05,0.02,0.01,0.01,0.01,0.01,0.03,0.1,0.15,0.2,0.3,0.7,1.1,1.0,0.5,0.35,0.4,0.8,1.5,1.7,1.5,1.0,0.5,0.2]
    when 'grocery' then array[0.02,0.01,0.01,0.01,0.01,0.03,0.15,0.5,0.8,0.9,1.0,1.1,1.2,1.1,1.0,1.0,1.1,1.3,1.3,1.0,0.7,0.4,0.15,0.05]
    else array[0.01,0.01,0.01,0.01,0.01,0.01,0.02,0.05,0.2,0.6,1.0,1.1,1.2,1.2,1.2,1.2,1.2,1.1,1.0,0.8,0.5,0.2,0.05,0.02]
  end)[p_hour + 1]
  * case when p_dow in (6, 7) then
      case p_category when 'street' then 1.15 when 'restaurant' then 1.2 when 'grocery' then 1.2 when 'cafe' then 1.0 else 1.4 end
    else 1 end
$$;

-- ---------------------------------------------------------------------------
-- Derived numbers of a business: capacity (customers/hour it can serve),
-- attractiveness, staff limit. Recomputed after any change to it.
-- ---------------------------------------------------------------------------
create function game.recompute_business(p_id bigint) returns void
language plpgsql set search_path = game, pg_temp as $$
declare
  b game.businesses;
  t game.business_types;
  v_cap numeric := 0;
  v_decor numeric := 0;
  v_slots int := 0;
  v_missing text[] := '{}';
  it record;
  v_item text;
begin
  select * into b from game.businesses where id = p_id;
  select * into t from game.business_types where id = b.kind;
  if t.placement = 'street' then
    update game.businesses
       set capacity = (array[40, 70, 110])[least(b.level, 3)],
           attract = 1 + 0.08 * (b.level - 1),
           max_staff = 0,
           flags = flags - 'missing'
     where id = p_id;
    return;
  end if;
  if t.placement <> 'room' or t.menu_category is null then
    update game.businesses
       set capacity = 0, attract = 1, staff = round(t.staff_fixed * (1 + 0.5 * (b.level - 1))),
           max_staff = round(t.staff_fixed * (1 + 0.5 * (b.level - 1)))
     where id = p_id;
    return;
  end if;
  for v_item in select jsonb_array_elements_text(b.fitout) loop
    select * into it from game.fitout_items where id = v_item;
    if found then
      v_cap := v_cap + coalesce((it.cap ->> t.menu_category)::numeric, 0);
      v_decor := v_decor + it.decor;
      if coalesce((it.cap ->> t.menu_category)::numeric, 0) > 0 then
        v_slots := v_slots + 2;
      end if;
    end if;
  end loop;
  select coalesce(array_agg(f.name order by f.sort), '{}') into v_missing
    from game.fitout_items f
   where t.menu_category = any (f.required_for)
     and not exists (select 1 from jsonb_array_elements_text(b.fitout) x where x = f.id);
  update game.businesses
     set max_staff = least(30, v_slots),
         staff = least(staff, least(30, v_slots)),
         capacity = case when cardinality(v_missing) > 0 then 0
                         else least(least(staff, least(30, v_slots)) * t.per_staff, v_cap) * (1 + 0.1 * (b.level - 1)) end,
         attract = least(1.5, 1 + 0.06 * v_decor) * (1 + 0.05 * (b.level - 1)),
         flags = case when cardinality(v_missing) > 0 then flags || jsonb_build_object('missing', to_jsonb(v_missing))
                      else flags - 'missing' end
   where id = p_id;
end $$;

-- ---------------------------------------------------------------------------
-- Net worth and tiers
-- ---------------------------------------------------------------------------
create function game.compute_net_worth(p_player uuid) returns bigint
language plpgsql stable set search_path = game, pg_temp as $$
declare
  v bigint := 0;
  v_fin bigint;
begin
  select cash into v from game.players where id = p_player;
  v := v + coalesce((select sum(book_value) from game.businesses where owner_id = p_player and status in ('open', 'closed', 'depleted')), 0);
  -- Property counts at the lower of the price paid and the city's value, so
  -- selling land back and forth between friends can't inflate net worth.
  v := v + coalesce((select sum(least(bought_price, city_price)) from game.plots where owner_id = p_player), 0);
  v := v + coalesce((select sum(least(b.bought_price, game.building_value(b))) from game.buildings b where b.owner_id = p_player), 0);
  v := v + coalesce((select sum(round(s.qty * game.npc_bid(m.ref_price))) from game.storage s join game.markets m using (good_id)
                      where s.owner_id = p_player and s.qty > 0), 0);
  v := v + coalesce((select sum(case when o.side = 'buy' then o.escrow
                                     else round((o.qty - o.filled) * game.npc_bid(m.ref_price)) end)
                       from game.orders o join game.markets m using (good_id)
                      where o.player_id = p_player and o.status = 'open'), 0);
  v := v + coalesce((select sum(case when s.kind = 'export' then s.qty * coalesce(s.unit_price, 0)
                                     else round(s.qty * game.npc_bid(m.ref_price)) end)
                       from game.shipments s join game.markets m using (good_id)
                      where s.owner_id = p_player and s.status = 'in_transit'), 0);
  if to_regprocedure('game.finance_net_worth(uuid)') is not null then
    execute 'select game.finance_net_worth($1)' into v_fin using p_player;
    v := v + coalesce(v_fin, 0);
  end if;
  return v;
end $$;

-- Updates net worth and unlocks tiers; returns the new net worth.
create function game.refresh_worth(p_player uuid) returns bigint
language plpgsql set search_path = game, pg_temp as $$
declare
  v bigint := game.compute_net_worth(p_player);
  p game.players;
  v_tier int;
begin
  select * into p from game.players where id = p_player;
  select coalesce(max(tier), 1) into v_tier from game.tiers where game.tier_threshold(tier) <= greatest(v, p.peak_net_worth);
  update game.players
     set net_worth = v, net_worth_at = now(), peak_net_worth = greatest(peak_net_worth, v),
         tier = greatest(tier, v_tier)
   where id = p_player;
  if v_tier > p.tier then
    perform game.notify(p_player, 'tier', format('Tier %s unlocked: %s', v_tier, (select name from game.tiers where tier = v_tier)),
      (select 'New idea: ' || idea || '.' from game.tiers where tier = v_tier), jsonb_build_object('tier', v_tier));
  end if;
  if v >= 100000000 then perform game.award(p_player, 'first_100k'); end if;
  if v >= 1000000000 then perform game.award(p_player, 'first_million'); end if;
  return v;
end $$;

create function game.require_tier(p game.players, p_tier int) returns void
language plpgsql set search_path = game, pg_temp as $$
begin
  if p.tier < p_tier then
    perform game.fail(format('Unlocks at tier %s (%s), when your net worth reaches %s.',
      p_tier, (select name from game.tiers where tier = p_tier), game.fmt(game.tier_threshold(p_tier))));
  end if;
end $$;

create function game.clean_name(p_name text, p_default text) returns text
language plpgsql set search_path = game, pg_temp as $$
declare
  v text := btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'));
begin
  if v = '' then v := p_default; end if;
  if length(v) > 40 then perform game.fail('Names can be at most 40 characters.'); end if;
  -- Filters (links, slurs) live in the social migration; applied when present.
  if to_regprocedure('game.check_name(text)') is not null then
    execute 'select game.check_name($1)' into v using v;
  end if;
  return v;
end $$;

-- Owned, active business, locked for update.
create function game.my_business(p game.players, p_id bigint) returns game.businesses
language plpgsql set search_path = game, pg_temp as $$
declare
  b game.businesses;
begin
  select * into b from game.businesses where id = p_id and owner_id = p.id and status in ('open', 'closed', 'depleted') for update;
  if not found then perform game.fail('That business isn''t yours, or it''s gone.'); end if;
  return b;
end $$;

create function game.add_book_value(p_id bigint, p_amount bigint) returns void
language sql set search_path = game, pg_temp as $$
  update game.businesses set book_value = book_value + p_amount where id = p_id
$$;

-- ---------------------------------------------------------------------------
-- Tier 1: food carts
-- ---------------------------------------------------------------------------
create function game.buy_cart(p game.players, p_name text, p_lat float8, p_lng float8) returns jsonb
language plpgsql set search_path = game, pg_temp as $$
declare
  c game.cities;
  t game.business_types;
  v_id bigint;
  v_first boolean;
begin
  perform game.rate_limit(p.id::text, 'build', 10, 6);
  -- Serialise this player's purchases (cart limit, starter stock).
  select * into p from game.players where id = p.id for update;
  select * into t from game.business_types where id = 'cart';
  if (select count(*) from game.businesses where owner_id = p.id and kind = 'cart' and status in ('open', 'closed')) >= game.cfg('max_carts') then
    perform game.fail(format('You can run at most %s carts. Sell one or grow into shops.', game.cfg('max_carts')));
  end if;
  if p.city_id is null then perform game.fail('Pick a city first.'); end if;
  select * into c from game.cities where id = p.city_id;
  p := game.set_position(p, c.id, p_lat, p_lng);
  if game.dist_m(p.lat, p.lng, p_lat, p_lng) > 25 then
    perform game.fail('Walk to that spot first.');
  end if;
  if not game.walkable(c, p_lat, p_lng) then
    perform game.fail('Carts must park on a street or path, not inside a building or on water.');
  end if;
  if exists (select 1 from game.businesses where city_id = c.id and kind = 'cart' and status in ('open', 'closed')
               and lat between p_lat - 0.0003 and p_lat + 0.0003
               and game.dist_m(lat, lng, p_lat, p_lng) < game.cfg('cart_spacing_m')) then
    perform game.fail('Another cart is parked right here. Find your own spot.');
  end if;
  v_first := not p.starter_given;
  perform game.money(p.id, -t.cost, 'purchase', 'Bought a food cart', jsonb_build_object('kind', 'cart'));
  insert into game.businesses (owner_id, city_id, kind, name, lat, lng, traffic, book_value, settings, open_hour, close_hour)
  values (p.id, c.id, 'cart', game.clean_name(p_name, p.display_name || '''s Cart'), p_lat, p_lng,
          game.traffic_at(c, p_lat, p_lng), t.cost,
          jsonb_build_object('menu', jsonb_build_array(
            jsonb_build_object('id', 'salad', 'price', 4000),
            jsonb_build_object('id', 'chips', 'price', 3500),
            jsonb_build_object('id', 'onigiri', 'price', 3000))),
          7, 23)
  returning id into v_id;
  perform game.recompute_business(v_id);
  if v_first then
    update game.players set starter_given = true where id = p.id;
    -- Starter stock so the first sales arrive straight away.
    perform game.stock_add(p.id, c.id, 'lettuce', 600, false);
    perform game.stock_add(p.id, c.id, 'tomato', 400, false);
    perform game.stock_add(p.id, c.id, 'potato', 600, false);
    perform game.stock_add(p.id, c.id, 'rice', 400, false);
    perform game.stock_add(p.id, c.id, 'wasabi', 200, false);
  end if;
  perform game.refresh_worth(p.id);
  return jsonb_build_object('business_id', v_id, 'starter_stock', v_first);
end $$;

create function game.move_cart(p game.players, p_id bigint, p_lat float8, p_lng float8) returns jsonb
language plpgsql set search_path = game, pg_temp as $$
declare
  b game.businesses := game.my_business(p, p_id);
  c game.cities;
begin
  if b.kind <> 'cart' then perform game.fail('Only carts can move.'); end if;
  perform game.rate_limit(p.id::text, 'move_cart', 6, 6);
  if p.city_id <> b.city_id then perform game.fail('You need to be in the same city as your cart.'); end if;
  select * into c from game.cities where id = b.city_id;
  p := game.set_position(p, c.id, p_lat, p_lng);
  if game.dist_m(p.lat, p.lng, p_lat, p_lng) > 25 then perform game.fail('Walk to that spot first.'); end if;
  if not game.walkable(c, p_lat, p_lng) then
    perform game.fail('Carts must park on a street or path, not inside a building or on water.');
  end if;
  if exists (select 1 from game.businesses where city_id = c.id and kind = 'cart' and id <> b.id and status in ('open', 'closed')
               and lat between p_lat - 0.0003 and p_lat + 0.0003
               and game.dist_m(lat, lng, p_lat, p_lng) < game.cfg('cart_spacing_m')) then
    perform game.fail('Another cart is parked right here. Find your own spot.');
  end if;
  update game.businesses set lat = p_lat, lng = p_lng, traffic = game.traffic_at(c, p_lat, p_lng) where id = b.id;
  return jsonb_build_object('ok', true, 'traffic', game.traffic_at(c, p_lat, p_lng));
end $$;

-- ---------------------------------------------------------------------------
-- Settings shared by all customer-facing businesses
-- ---------------------------------------------------------------------------
create function game.set_menu(p game.players, p_id bigint, p_menu jsonb) returns jsonb
language plpgsql set search_path = game, pg_temp as $$
declare
  b game.businesses := game.my_business(p, p_id);
  t game.business_types;
  it jsonb;
  mi game.menu_items;
  v_price bigint;
  v_out jsonb := '[]'::jsonb;
  v_seen text[] := '{}';
begin
  select * into t from game.business_types where id = b.kind;
  if t.menu_category is null then perform game.fail('This business doesn''t sell to customers.'); end if;
  if jsonb_typeof(p_menu) <> 'array' then perform game.fail('Menu must be a list.'); end if;
  if jsonb_array_length(p_menu) > game.menu_slots(b.kind, b.level) then
    perform game.fail(format('This business can sell up to %s items. Upgrade it for more.', game.menu_slots(b.kind, b.level)));
  end if;
  for it in select * from jsonb_array_elements(p_menu) loop
    select * into mi from game.menu_items where id = it ->> 'id';
    if not found or mi.category <> t.menu_category then
      perform game.fail(format('%s can''t be sold here.', coalesce(it ->> 'id', 'That item')));
    end if;
    if mi.id = any (v_seen) then perform game.fail('Each item can be on the menu once.'); end if;
    v_seen := v_seen || mi.id;
    v_price := coalesce((it ->> 'price')::bigint, mi.fair_price);
    if v_price < mi.fair_price / 10 or v_price > mi.fair_price * 5 then
      perform game.fail(format('Price for %s must be between %s and %s.', mi.name, game.fmt(mi.fair_price / 10), game.fmt(mi.fair_price * 5)));
    end if;
    v_out := v_out || jsonb_build_object('id', mi.id, 'price', v_price);
  end loop;
  update game.businesses set settings = jsonb_set(settings, '{menu}', v_out), flags = flags - 'out_of_stock' where id = b.id;
  return jsonb_build_object('menu', v_out);
end $$;

create function game.set_hours(p game.players, p_id bigint, p_open int, p_close int) returns jsonb
language plpgsql set search_path = game, pg_temp as $$
declare
  b game.businesses := game.my_business(p, p_id);
begin
  if p_open is null or p_close is null or p_open < 0 or p_open > 23 or p_close < 0 or p_close > 24 then
    perform game.fail('Opening hours must be between 0 and 24.');
  end if;
  update game.businesses set open_hour = p_open, close_hour = p_close where id = b.id;
  return jsonb_build_object('open_hour', p_open, 'close_hour', p_close);
end $$;

create function game.set_status(p game.players, p_id bigint, p_open boolean) returns jsonb
language plpgsql set search_path = game, pg_temp as $$
declare
  b game.businesses := game.my_business(p, p_id);
begin
  if b.status = 'depleted' then perform game.fail('This deposit is used up.'); end if;
  update game.businesses set status = case when p_open then 'open' else 'closed' end where id = b.id;
  return jsonb_build_object('status', case when p_open then 'open' else 'closed' end);
end $$;

create function game.rename_business(p game.players, p_id bigint, p_name text) returns jsonb
language plpgsql set search_path = game, pg_temp as $$
declare
  b game.businesses := game.my_business(p, p_id);
  v text := game.clean_name(p_name, b.name);
begin
  update game.businesses set name = v where id = b.id;
  return jsonb_build_object('name', v);
end $$;

create function game.set_business_option(p game.players, p_id bigint, p_key text, p_value jsonb) returns jsonb
language plpgsql set search_path = game, pg_temp as $$
declare
  b game.businesses := game.my_business(p, p_id);
  t game.business_types;
  c game.cities;
  g game.goods;
begin
  select * into t from game.business_types where id = b.kind;
  select * into c from game.cities where id = b.city_id;
  if p_key = 'crop' then
    if t.produces <> 'crop' then perform game.fail('Only farms grow crops.'); end if;
    select g2.* into g from game.goods g2 join game.crops cr on cr.good_id = g2.id where g2.id = p_value #>> '{}';
    if not found then perform game.fail('That isn''t a crop.'); end if;
    if g.warm_only and c.climate <> 'warm' then
      perform game.fail(format('%s only grows in warm cities like Singapore.', g.name));
    end if;
  elsif p_key = 'auto_sell' then
    if coalesce(t.produces, '') not in ('crop', 'timber', 'recipe') and t.placement <> 'deposit' then
      perform game.fail('Only producers can auto-sell.');
    end if;
    if jsonb_typeof(p_value) <> 'boolean' then perform game.fail('Choose on or off.'); end if;
  else
    perform game.fail('Unknown setting.');
  end if;
  update game.businesses set settings = jsonb_set(settings, array[p_key], p_value) where id = b.id;
  return jsonb_build_object(p_key, p_value);
end $$;

create function game.upgrade_business(p game.players, p_id bigint) returns jsonb
language plpgsql set search_path = game, pg_temp as $$
declare
  b game.businesses := game.my_business(p, p_id);
  t game.business_types;
  v_cost bigint;
begin
  select * into t from game.business_types where id = b.kind;
  if b.level >= t.max_level then perform game.fail('Already at the top level.'); end if;
  v_cost := game.upgrade_cost(t, b.level);
  perform game.money(p.id, -v_cost, 'upgrade', format('Upgraded %s to level %s', b.name, b.level + 1),
    jsonb_build_object('business', b.id));
  update game.businesses set level = level + 1, book_value = book_value + v_cost where id = b.id;
  perform game.recompute_business(b.id);
  perform game.refresh_worth(p.id);
  return jsonb_build_object('level', b.level + 1, 'cost', v_cost);
end $$;

-- Sell a business back to the city. Its plot stays yours; a lease ends.
create function game.sell_business(p game.players, p_id bigint) returns jsonb
language plpgsql set search_path = game, pg_temp as $$
declare
  b game.businesses := game.my_business(p, p_id);
  v_back bigint;
begin
  v_back := round(b.book_value * game.cfg('sellback_pct') / 100.0);
  if v_back > 0 then
    perform game.money(p.id, v_back, 'sale_to_game', format('Sold %s back to the city', b.name), jsonb_build_object('business', b.id));
  end if;
  update game.leases set status = 'ended', ended_at = now() where business_id = b.id and status = 'active';
  update game.plots set business_id = null where business_id = b.id;
  update game.businesses set status = 'sold', staff = 0, book_value = 0 where id = b.id;
  perform game.refresh_worth(p.id);
  return jsonb_build_object('received', v_back);
end $$;

-- ---------------------------------------------------------------------------
-- Tier 2: rooms in buildings
-- ---------------------------------------------------------------------------
create function game.resolve_building(p_id bigint) returns bigint
language sql stable set search_path = game, pg_temp as $$
  select coalesce((select building_id from game.building_aliases where alias_id = p_id),
                  (select id from game.buildings where id = p_id))
$$;

create function game.rooms_free(p_building bigint) returns int
language sql stable set search_path = game, pg_temp as $$
  select greatest(0, (select rooms_total from game.buildings where id = p_building)
    - (select count(*) from game.leases where building_id = p_building and status = 'active'))::int
$$;

-- Range for acting on a building: big blocks get a bigger radius.
create function game.building_range(b game.buildings) returns float8
language sql immutable set search_path = game, pg_temp as $$
  select greatest(game.cfg('action_range_m')::float8, sqrt(b.footprint_m2) * 0.75 + 40)
$$;

create function game.rent_room(p game.players, p_building bigint, p_kind text, p_name text, p_lat float8, p_lng float8) returns jsonb
language plpgsql set search_path = game, pg_temp as $$
declare
  bld game.buildings;
  t game.business_types;
  v_rent bigint;
  v_id bigint;
begin
  perform game.rate_limit(p.id::text, 'build', 10, 6);
  select * into t from game.business_types where id = p_kind;
  if not found or t.placement <> 'room' then perform game.fail('That kind of business doesn''t go in a room.'); end if;
  perform game.require_tier(p, t.tier);
  select * into bld from game.buildings where id = game.resolve_building(p_building) for update;
  if not found then perform game.fail('That building isn''t part of the game yet.'); end if;
  if bld.city_id <> p.city_id then perform game.fail('That building is in another city.'); end if;
  p := game.set_position(p, bld.city_id, p_lat, p_lng);
  perform game.require_near(p, bld.lat, bld.lng, game.building_range(bld));
  if game.rooms_free(bld.id) < 1 then perform game.fail('Every room in this building is taken.'); end if;
  v_rent := game.room_rent(bld);
  perform game.money(p.id, -t.cost, 'purchase', format('%s licence', t.name), jsonb_build_object('kind', t.id, 'building', bld.id));
  insert into game.businesses (owner_id, city_id, kind, name, lat, lng, traffic, building_id, book_value, open_hour, close_hour, settings)
  values (p.id, bld.city_id, t.id, game.clean_name(p_name, p.display_name || '''s ' || t.name), bld.lat, bld.lng, bld.traffic, bld.id,
          t.cost,
          case t.id when 'cafe' then 7 when 'restaurant' then 11 when 'bank' then 9 else 9 end,
          case t.id when 'cafe' then 18 when 'restaurant' then 23 when 'bank' then 17 else 20 end,
          jsonb_build_object('menu', '[]'::jsonb))
  returning id into v_id;
  -- First day's rent up front, then every minute.
  if bld.owner_id is not null and bld.owner_id <> p.id then
    perform game.money(p.id, -v_rent, 'rent', format('First day''s rent at %s', coalesce(bld.custom_name, bld.name, 'a building')),
      jsonb_build_object('building', bld.id));
    perform game.money(bld.owner_id, v_rent, 'rent_income', format('New tenant: %s', p.display_name), jsonb_build_object('building', bld.id));
    perform game.notify(bld.owner_id, 'tenant', 'New tenant', format('%s rented a room in your building for %s a day.', p.display_name, game.fmt(v_rent)),
      jsonb_build_object('building', bld.id));
  elsif bld.owner_id is null then
    perform game.money(p.id, -v_rent, 'rent', format('First day''s rent at %s', coalesce(bld.name, 'a building')), jsonb_build_object('building', bld.id));
  end if;
  insert into game.leases (building_id, tenant_id, business_id, rent_per_day) values (bld.id, p.id, v_id, v_rent);
  perform game.recompute_business(v_id);
  if t.id = 'bank' then perform game.award(p.id, 'first_bank'); else perform game.award(p.id, 'first_room'); end if;
  perform game.refresh_worth(p.id);
  return jsonb_build_object('business_id', v_id, 'rent_per_day', v_rent);
end $$;

-- Replace a room's fit-out (array of up to 40 item ids). New items are
-- bought at full price; removed items are sold back for half.
create function game.set_fitout(p game.players, p_id bigint, p_items jsonb) returns jsonb
language plpgsql set search_path = game, pg_temp as $$
declare
  b game.businesses := game.my_business(p, p_id);
  t game.business_types;
  v_old jsonb;
  v_new jsonb := '[]'::jsonb;
  v_cost bigint := 0;
  v_refund bigint := 0;
  r record;
begin
  select * into t from game.business_types where id = b.kind;
  if t.placement <> 'room' then perform game.fail('Only rooms have a fit-out.'); end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 40 then
    perform game.fail('A room holds up to 40 items.');
  end if;
  -- Normalise: keep only known item ids, in grid order (nulls are empty tiles).
  select coalesce(jsonb_agg(case when f.id is null then 'null'::jsonb else to_jsonb(f.id) end order by x.ord), '[]'::jsonb)
    into v_new
    from jsonb_array_elements(p_items) with ordinality x(v, ord)
    left join game.fitout_items f on f.id = x.v #>> '{}';
  v_old := b.fitout;
  for r in
    with o as (select x #>> '{}' id, count(*) n from jsonb_array_elements(v_old) x where jsonb_typeof(x) = 'string' group by 1),
         nw as (select x #>> '{}' id, count(*) n from jsonb_array_elements(v_new) x where jsonb_typeof(x) = 'string' group by 1)
    select coalesce(o.id, nw.id) id, coalesce(o.n, 0) old_n, coalesce(nw.n, 0) new_n
      from o full join nw on o.id = nw.id
  loop
    if r.new_n > r.old_n then
      v_cost := v_cost + (r.new_n - r.old_n) * (select cost from game.fitout_items where id = r.id);
    elsif r.old_n > r.new_n then
      v_refund := v_refund + (r.old_n - r.new_n) * (select cost from game.fitout_items where id = r.id) / 2;
    end if;
  end loop;
  if v_cost > 0 then
    perform game.money(p.id, -v_cost, 'fitout', format('Fit-out for %s', b.name), jsonb_build_object('business', b.id));
  end if;
  if v_refund > 0 then
    perform game.money(p.id, v_refund, 'sale_to_game', format('Sold fittings from %s', b.name), jsonb_build_object('business', b.id));
  end if;
  update game.businesses set fitout = v_new, book_value = greatest(0, book_value + v_cost - v_refund * 2) where id = b.id;
  perform game.recompute_business(b.id);
  perform game.refresh_worth(p.id);
  return jsonb_build_object('spent', v_cost, 'refunded', v_refund,
    'business', (select to_jsonb(x) - 'settings' from game.businesses x where id = b.id));
end $$;

create function game.set_staff(p game.players, p_id bigint, p_staff int) returns jsonb
language plpgsql set search_path = game, pg_temp as $$
declare
  b game.businesses := game.my_business(p, p_id);
  t game.business_types;
begin
  select * into t from game.business_types where id = b.kind;
  if t.placement <> 'room' then perform game.fail('Staff here are hired automatically.'); end if;
  if p_staff is null or p_staff < 0 or p_staff > b.max_staff then
    perform game.fail(format('You can hire 0 to %s staff here. More fit-out makes room for more.', b.max_staff));
  end if;
  update game.businesses set staff = p_staff, flags = flags - 'staff_quit' where id = b.id;
  perform game.recompute_business(b.id);
  return jsonb_build_object('staff', p_staff, 'capacity', (select capacity from game.businesses where id = b.id));
end $$;

-- ---------------------------------------------------------------------------
-- Tier 3: plots and buildings
-- ---------------------------------------------------------------------------
create function game.buy_plot(p game.players, p_city text, p_px int, p_py int, p_lat float8, p_lng float8) returns jsonb
language plpgsql set search_path = game, pg_temp as $$
declare
  c game.cities;
  v_price bigint;
  pc record;
begin
  perform game.require_tier(p, 3);
  perform game.rate_limit(p.id::text, 'build', 10, 6);
  select * into c from game.cities where id = p_city;
  if not found then perform game.fail('Unknown city.'); end if;
  if not game.plot_buildable(c, p_px, p_py) then perform game.fail('That land can''t be built on.'); end if;
  select * into pc from game.plot_center(c, p_px, p_py);
  p := game.set_position(p, c.id, p_lat, p_lng);
  perform game.require_near(p, pc.lat, pc.lng, 60);
  if exists (select 1 from game.plots where city_id = c.id and px = p_px and py = p_py) then
    perform game.fail('Someone already owns this plot.');
  end if;
  v_price := game.plot_price(c, p_px, p_py);
  perform game.money(p.id, -v_price, 'purchase', 'Bought a plot of land', jsonb_build_object('city', c.id, 'px', p_px, 'py', p_py));
  insert into game.plots (city_id, px, py, owner_id, bought_price, city_price) values (c.id, p_px, p_py, p.id, v_price, v_price);
  perform game.award(p.id, 'first_plot');
  perform game.refresh_worth(p.id);
  return jsonb_build_object('price', v_price);
end $$;

create function game.build_on_plot(p game.players, p_city text, p_px int, p_py int, p_kind text, p_name text, p_option text) returns jsonb
language plpgsql set search_path = game, pg_temp as $$
declare
  c game.cities;
  pl game.plots;
  t game.business_types;
  d game.deposits;
  pc record;
  v_id bigint;
  v_settings jsonb := '{}'::jsonb;
  g game.goods;
begin
  perform game.rate_limit(p.id::text, 'build', 10, 6);
  select * into c from game.cities where id = p_city;
  select * into pl from game.plots where city_id = p_city and px = p_px and py = p_py and owner_id = p.id for update;
  if not found then perform game.fail('You don''t own that plot.'); end if;
  if pl.business_id is not null and exists (select 1 from game.businesses where id = pl.business_id and status in ('open', 'closed', 'depleted')) then
    perform game.fail('Something is already built here. Sell it first.');
  end if;
  select * into t from game.business_types where id = p_kind;
  if not found or t.placement not in ('plot', 'coastal', 'deposit') then perform game.fail('That can''t be built on a plot.'); end if;
  perform game.require_tier(p, t.tier);
  if t.placement = 'coastal' and not game.plot_coastal(c, p_px, p_py) then
    perform game.fail('Ports need a plot right by open water.');
  end if;
  if t.placement = 'deposit' then
    select * into d from game.deposits where city_id = p_city and px = p_px and py = p_py;
    if not found or d.resource <> t.resource then
      perform game.fail(format('There''s no %s deposit under this plot. Survey first.', lower((select name from game.goods where id = t.resource))));
    end if;
    if not exists (select 1 from game.surveys where player_id = p.id and city_id = p_city and bx = d.bx and by = d.by) then
      perform game.fail('Survey this area before you dig.');
    end if;
    if exists (select 1 from game.businesses where deposit_id = d.id and status in ('open', 'closed')) then
      perform game.fail('This deposit is already being mined.');
    end if;
    if d.units_left <= 0 then perform game.fail('This deposit is used up.'); end if;
  end if;
  if t.produces = 'crop' then
    select * into g from game.goods where id = coalesce(p_option, case when c.climate = 'warm' then 'banana' else 'lettuce' end);
    if not found or not exists (select 1 from game.crops where good_id = g.id) then perform game.fail('Choose a crop.'); end if;
    if g.warm_only and c.climate <> 'warm' then perform game.fail(format('%s only grows in warm cities.', g.name)); end if;
    v_settings := jsonb_build_object('crop', g.id, 'auto_sell', false);
  elsif t.produces in ('timber', 'recipe') or t.placement = 'deposit' then
    v_settings := jsonb_build_object('auto_sell', false);
  end if;
  select * into pc from game.plot_center(c, p_px, p_py);
  perform game.money(p.id, -t.cost, 'purchase', format('Built a %s', lower(t.name)), jsonb_build_object('kind', t.id, 'px', p_px, 'py', p_py));
  insert into game.businesses (owner_id, city_id, kind, name, lat, lng, traffic, plot_x, plot_y, deposit_id, book_value, settings, open_hour, close_hour)
  values (p.id, c.id, t.id, game.clean_name(p_name, p.display_name || '''s ' || t.name), pc.lat, pc.lng,
          game.traffic_at(c, pc.lat, pc.lng), p_px, p_py, d.id, t.cost, v_settings, 0, 24)
  returning id into v_id;
  update game.plots set business_id = v_id, for_sale_price = null where city_id = p_city and px = p_px and py = p_py;
  perform game.recompute_business(v_id);
  if t.placement = 'deposit' then perform game.award(p.id, 'first_mine'); end if;
  if t.produces = 'recipe' then perform game.award(p.id, 'first_factory'); end if;
  perform game.refresh_worth(p.id);
  return jsonb_build_object('business_id', v_id);
end $$;

create function game.buy_building(p game.players, p_building bigint, p_lat float8, p_lng float8, p_expected_price bigint default null) returns jsonb
language plpgsql set search_path = game, pg_temp as $$
declare
  bld game.buildings;
  v_price bigint;
  v_seller uuid;
begin
  perform game.require_tier(p, 3);
  perform game.rate_limit(p.id::text, 'build', 10, 6);
  select * into bld from game.buildings where id = game.resolve_building(p_building) for update;
  if not found then perform game.fail('That building isn''t part of the game yet.'); end if;
  if bld.landmark then perform game.fail('Landmarks belong to the city and can''t be bought. You can still rent rooms in them.'); end if;
  if bld.owner_id = p.id then perform game.fail('You already own this building.'); end if;
  p := game.set_position(p, bld.city_id, p_lat, p_lng);
  perform game.require_near(p, bld.lat, bld.lng, game.building_range(bld));
  if bld.owner_id is null then
    v_price := game.building_value(bld);
    perform game.money(p.id, -v_price, 'purchase', format('Bought %s', coalesce(bld.name, 'a building')), jsonb_build_object('building', bld.id));
  else
    if bld.for_sale_price is null then perform game.fail('The owner isn''t selling this building.'); end if;
    if p_expected_price is distinct from bld.for_sale_price then
      perform game.fail(format('The asking price changed to %s. Check it and try again.', game.fmt(bld.for_sale_price)));
    end if;
    v_price := bld.for_sale_price;
    v_seller := bld.owner_id;
    perform game.money(p.id, -v_price, 'property_buy', format('Bought %s from %s', coalesce(bld.custom_name, bld.name, 'a building'),
      (select display_name from game.players where id = v_seller)), jsonb_build_object('building', bld.id));
    perform game.money(v_seller, v_price, 'property_sale', format('Sold %s to %s', coalesce(bld.custom_name, bld.name, 'a building'), p.display_name),
      jsonb_build_object('building', bld.id));
    perform game.notify(v_seller, 'property', 'Building sold', format('%s bought your building for %s.', p.display_name, game.fmt(v_price)),
      jsonb_build_object('building', bld.id));
  end if;
  update game.buildings set owner_id = p.id, bought_price = v_price, bought_at = now(), for_sale_price = null, rent_pct = 100 where id = bld.id;
  -- Existing tenants now pay the new owner at the city's rate.
  update game.leases set rent_per_day = game.room_rent((select b2 from game.buildings b2 where b2.id = bld.id))
   where building_id = bld.id and status = 'active';
  perform game.award(p.id, 'first_building');
  if v_seller is not null then perform game.refresh_worth(v_seller); end if;
  perform game.refresh_worth(p.id);
  return jsonb_build_object('price', v_price);
end $$;

create function game.set_building(p game.players, p_building bigint, p_rent_pct int, p_name text, p_for_sale bigint) returns jsonb
language plpgsql set search_path = game, pg_temp as $$
declare
  bld game.buildings;
begin
  select * into bld from game.buildings where id = game.resolve_building(p_building) and owner_id = p.id for update;
  if not found then perform game.fail('You don''t own that building.'); end if;
  if p_rent_pct is not null and (p_rent_pct < 50 or p_rent_pct > 200) then
    perform game.fail('Set rent between 50% and 200% of the going rate.');
  end if;
  if p_for_sale is not null and p_for_sale <= 0 then perform game.fail('Set a price above zero.'); end if;
  update game.buildings
     set rent_pct = coalesce(p_rent_pct, rent_pct),
         custom_name = case when p_name is null then custom_name when btrim(p_name) = '' then null else game.clean_name(p_name, null) end,
         for_sale_price = p_for_sale
   where id = bld.id
  returning * into bld;
  update game.leases set rent_per_day = game.room_rent(bld) where building_id = bld.id and status = 'active';
  return jsonb_build_object('rent_pct', bld.rent_pct, 'for_sale_price', bld.for_sale_price, 'rent_per_day', game.room_rent(bld));
end $$;

create function game.sell_building_to_city(p game.players, p_building bigint) returns jsonb
language plpgsql set search_path = game, pg_temp as $$
declare
  bld game.buildings;
  v_back bigint;
begin
  select * into bld from game.buildings where id = game.resolve_building(p_building) and owner_id = p.id for update;
  if not found then perform game.fail('You don''t own that building.'); end if;
  v_back := round(least(bld.bought_price, game.building_value(bld)) * 0.7);
  perform game.money(p.id, v_back, 'sale_to_game', format('Sold %s to the city', coalesce(bld.custom_name, bld.name, 'a building')),
    jsonb_build_object('building', bld.id));
  update game.buildings set owner_id = null, bought_price = null, bought_at = null, for_sale_price = null, rent_pct = 100, custom_name = null
   where id = bld.id returning * into bld;
  update game.leases set rent_per_day = game.room_rent(bld) where building_id = bld.id and status = 'active';
  perform game.refresh_worth(p.id);
  return jsonb_build_object('received', v_back);
end $$;

create function game.set_plot_sale(p game.players, p_city text, p_px int, p_py int, p_price bigint) returns jsonb
language plpgsql set search_path = game, pg_temp as $$
begin
  if p_price is not null and p_price <= 0 then perform game.fail('Set a price above zero.'); end if;
  update game.plots set for_sale_price = p_price where city_id = p_city and px = p_px and py = p_py and owner_id = p.id;
  if not found then perform game.fail('You don''t own that plot.'); end if;
  return jsonb_build_object('for_sale_price', p_price);
end $$;

-- Buy a plot another player listed for sale (with whatever stands on it).
create function game.buy_listed_plot(p game.players, p_city text, p_px int, p_py int, p_expected_price bigint default null) returns jsonb
language plpgsql set search_path = game, pg_temp as $$
declare
  pl game.plots;
begin
  perform game.require_tier(p, 3);
  select * into pl from game.plots where city_id = p_city and px = p_px and py = p_py for update;
  if not found or pl.for_sale_price is null then perform game.fail('That plot isn''t for sale.'); end if;
  if pl.owner_id = p.id then perform game.fail('That''s already yours.'); end if;
  if p_expected_price is distinct from pl.for_sale_price then
    perform game.fail(format('The asking price changed to %s. Check it and try again.', game.fmt(pl.for_sale_price)));
  end if;
  perform game.money(p.id, -pl.for_sale_price, 'property_buy', 'Bought a plot', jsonb_build_object('city', p_city, 'px', p_px, 'py', p_py));
  perform game.money(pl.owner_id, pl.for_sale_price, 'property_sale', format('Sold a plot to %s', p.display_name),
    jsonb_build_object('city', p_city, 'px', p_px, 'py', p_py));
  perform game.notify(pl.owner_id, 'property', 'Plot sold', format('%s bought your plot for %s.', p.display_name, game.fmt(pl.for_sale_price)));
  update game.plots set owner_id = p.id, bought_price = pl.for_sale_price, bought_at = now(), for_sale_price = null
   where city_id = p_city and px = p_px and py = p_py;
  if pl.business_id is not null then
    update game.businesses set owner_id = p.id where id = pl.business_id and status in ('open', 'closed', 'depleted');
  end if;
  perform game.refresh_worth(pl.owner_id);
  perform game.refresh_worth(p.id);
  return jsonb_build_object('price', pl.for_sale_price);
end $$;

create function game.sell_plot_to_city(p game.players, p_city text, p_px int, p_py int) returns jsonb
language plpgsql set search_path = game, pg_temp as $$
declare
  pl game.plots;
  v_back bigint;
begin
  select * into pl from game.plots where city_id = p_city and px = p_px and py = p_py and owner_id = p.id for update;
  if not found then perform game.fail('You don''t own that plot.'); end if;
  if pl.business_id is not null and exists (select 1 from game.businesses where id = pl.business_id and status in ('open', 'closed', 'depleted')) then
    perform game.fail('Sell what''s built on it first.');
  end if;
  v_back := round(least(pl.bought_price, pl.city_price) * 0.7);
  perform game.money(p.id, v_back, 'sale_to_game', 'Sold a plot to the city', jsonb_build_object('city', p_city, 'px', p_px, 'py', p_py));
  delete from game.plots where city_id = p_city and px = p_px and py = p_py;
  perform game.refresh_worth(p.id);
  return jsonb_build_object('received', v_back);
end $$;

-- ---------------------------------------------------------------------------
-- Tier 4: surveys and deposits. A survey covers the 200 m block you stand
-- in. Deposits are fixed per block (from a secret seed), the same for
-- everyone, but only players who surveyed a block can see what's there.
-- ---------------------------------------------------------------------------
create function game.rand01(p_key text) returns float8
language sql stable set search_path = game, pg_temp as $$
  select ('x' || substr(encode(extensions.hmac(p_key, (select value from game.secrets where key = 'deposit_salt'), 'sha256'), 'hex'), 1, 12))::bit(48)::bigint
         / 281474976710656.0
$$;

create function game.generate_block(c game.cities, p_bx int, p_by int) returns void
language plpgsql set search_path = game, pg_temp as $$
declare
  v_free int[];
  v_n int;
  i int;
  r float8;
  v_cell int;
  v_res text;
  dt game.deposit_types;
  v_total numeric;
  v_acc numeric;
  v_units bigint;
  x int;
  y int;
begin
  insert into game.surveyed_blocks (city_id, bx, by) values (c.id, p_bx, p_by) on conflict do nothing;
  if not found then return; end if;
  select coalesce(array_agg(yy * 8 + xx), '{}') into v_free
    from generate_series(0, 7) xx, generate_series(0, 7) yy
   where game.plot_buildable(c, p_bx * 8 + xx, p_by * 8 + yy);
  if cardinality(v_free) = 0 then return; end if;
  r := game.rand01(format('%s:%s:%s:n', c.id, p_bx, p_by));
  v_n := case when r < 0.30 then 0 when r < 0.78 then 1 else 2 end;
  select sum(weight) into v_total from game.deposit_types;
  for i in 1 .. v_n loop
    v_cell := v_free[1 + floor(game.rand01(format('%s:%s:%s:%s:cell', c.id, p_bx, p_by, i)) * cardinality(v_free))::int];
    x := p_bx * 8 + v_cell % 8;
    y := p_by * 8 + v_cell / 8;
    r := game.rand01(format('%s:%s:%s:%s:res', c.id, p_bx, p_by, i)) * v_total;
    v_acc := 0;
    for dt in select * from game.deposit_types order by resource loop
      v_acc := v_acc + dt.weight;
      if r <= v_acc then exit; end if;
    end loop;
    v_units := dt.min_units + floor(game.rand01(format('%s:%s:%s:%s:size', c.id, p_bx, p_by, i)) * (dt.max_units - dt.min_units));
    insert into game.deposits (city_id, px, py, bx, by, resource, units_total, units_left)
    values (c.id, x, y, p_bx, p_by, dt.resource, v_units, v_units)
    on conflict (city_id, px, py) do nothing;
  end loop;
end $$;

create function game.survey(p game.players, p_lat float8, p_lng float8) returns jsonb
language plpgsql set search_path = game, pg_temp as $$
declare
  c game.cities;
  pp record;
  v_bx int;
  v_by int;
  v_cost bigint := game.cfg('survey_cost')::bigint;
begin
  perform game.require_tier(p, 4);
  perform game.rate_limit(p.id::text, 'survey', 5, 2);
  if p.city_id is null then perform game.fail('Pick a city first.'); end if;
  select * into c from game.cities where id = p.city_id;
  p := game.set_position(p, c.id, p_lat, p_lng);
  select * into pp from game.plot_of(c, p.lat, p.lng);
  v_bx := floor(pp.px / 8.0);
  v_by := floor(pp.py / 8.0);
  if exists (select 1 from game.surveys where player_id = p.id and city_id = c.id and bx = v_bx and by = v_by) then
    perform game.fail('You''ve already surveyed this block. Its results are on your map.');
  end if;
  perform game.money(p.id, -v_cost, 'survey', format('Mineral survey in %s', c.name), jsonb_build_object('city', c.id, 'bx', v_bx, 'by', v_by));
  perform game.generate_block(c, v_bx, v_by);
  insert into game.surveys (player_id, city_id, bx, by) values (p.id, c.id, v_bx, v_by);
  perform game.award(p.id, 'first_survey');
  return jsonb_build_object('bx', v_bx, 'by', v_by, 'deposits', coalesce((
    select jsonb_agg(jsonb_build_object('id', d.id, 'px', d.px, 'py', d.py, 'resource', d.resource,
      'units_left', d.units_left, 'units_total', d.units_total,
      'lat', (game.plot_center(c, d.px, d.py)).lat, 'lng', (game.plot_center(c, d.px, d.py)).lng,
      'claimed', exists (select 1 from game.businesses b where b.deposit_id = d.id and b.status in ('open', 'closed')),
      'plot_owner', (select pl.owner_id = p.id from game.plots pl where pl.city_id = d.city_id and pl.px = d.px and pl.py = d.py)))
      from game.deposits d where d.city_id = c.id and d.bx = v_bx and d.by = v_by), '[]'::jsonb));
end $$;

-- ---------------------------------------------------------------------------
-- Tier 5: ports, shipping and exports
-- ---------------------------------------------------------------------------
create function game.import_mult(p_city text, p_good text) returns float8
language sql stable set search_path = game, pg_temp as $$
  select coalesce((select mult from game.import_prices where city_id = p_city and good_id = p_good), 1.2)
       * coalesce((select ref_mult from game.import_markets where city_id = p_city and good_id = p_good), 1)
$$;

-- Ship goods from your port's city to another city. 'transfer' moves them
-- into your storage there; 'export' sells them to overseas buyers there.
create function game.ship(p game.players, p_port bigint, p_good text, p_qty bigint, p_to text, p_kind text) returns jsonb
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
  v_km := game.city_km(b.city_id, p_to);
  v_minutes := 8 + round(v_km / 600)::int;
  v_freight := round(p_qty * g.base_price * (0.02 + v_km / 400000.0));
  perform game.stock_add(p.id, b.city_id, p_good, -p_qty);
  perform game.money(p.id, -v_freight, 'freight', format('Shipping %s %s to %s', p_qty, g.name, (select name from game.cities where id = p_to)),
    jsonb_build_object('good', p_good, 'qty', p_qty, 'to', p_to));
  if p_kind = 'export' then
    v_unit := floor(g.base_price * game.import_mult(p_to, p_good));
  end if;
  insert into game.shipments (owner_id, port_id, kind, from_city, to_city, good_id, qty, freight, unit_price, arrive_at)
  values (p.id, b.id, p_kind, b.city_id, p_to, p_good, p_qty, v_freight, v_unit, now() + make_interval(mins => v_minutes))
  returning id into v_id;
  return jsonb_build_object('shipment_id', v_id, 'arrive_minutes', v_minutes, 'freight', v_freight, 'est_unit_price', v_unit);
end $$;

-- Deliver shipments that have arrived. Exports are paid at the buyers'
-- price on arrival (big loads push that price down).
create function game.deliver_shipments() returns void
language plpgsql set search_path = game, pg_temp as $$
declare
  s game.shipments;
  g game.goods;
  k float8;
  v_mult float8;
  v_value bigint;
begin
  for s in select * from game.shipments where status = 'in_transit' and arrive_at <= now() order by arrive_at for update skip locked loop
    select * into g from game.goods where id = s.good_id;
    if s.kind = 'transfer' then
      if game.storage_used(s.owner_id, s.to_city) + s.qty > game.storage_capacity(s.owner_id, s.to_city) then
        continue; -- waits at the dock until there's room
      end if;
      perform game.stock_add(s.owner_id, s.to_city, s.good_id, s.qty, false);
      update game.shipments set status = 'delivered' where id = s.id;
      perform game.notify(s.owner_id, 'shipment', format('%s %s arrived in %s', s.qty, g.name, (select name from game.cities where id = s.to_city)), null,
        jsonb_build_object('shipment', s.id));
    else
      insert into game.import_markets (city_id, good_id) values (s.to_city, s.good_id) on conflict do nothing;
      v_mult := game.import_mult(s.to_city, s.good_id);
      k := ln(1.1) / (g.depth * 2);
      v_value := floor(g.base_price * v_mult * (1 - exp(-k * s.qty)) / k);
      update game.import_markets set ref_mult = ref_mult * exp(-k * s.qty) where city_id = s.to_city and good_id = s.good_id;
      perform game.money(s.owner_id, v_value, 'export', format('Export: %s %s sold in %s', s.qty, g.name, (select name from game.cities where id = s.to_city)),
        jsonb_build_object('shipment', s.id, 'good', s.good_id, 'qty', s.qty));
      update game.shipments set status = 'delivered', delivered_value = v_value where id = s.id;
      perform game.award(s.owner_id, 'first_export');
      perform game.notify(s.owner_id, 'shipment', format('Export sold: %s', game.fmt(v_value)),
        format('%s %s sold to buyers in %s.', s.qty, g.name, (select name from game.cities where id = s.to_city)),
        jsonb_build_object('shipment', s.id));
    end if;
  end loop;
  -- Overseas prices recover toward normal.
  update game.import_markets set ref_mult = ref_mult + (1 - ref_mult) * 0.004;
end $$;
