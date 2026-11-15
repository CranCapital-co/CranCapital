-- CranCapital core: schema, configuration, cities and buildings, players,
-- the money ledger, positions and travel, rate limits.
--
-- Conventions
-- * All game tables live in schema "game", which the API never exposes.
--   Players reach the game only through functions in "public" (see the
--   api migrations), each SECURITY DEFINER with a fixed search_path.
-- * Money is a bigint count of thousandths of a dollar ("mills"):
--   $1.00 = 1000. Cheap goods like lettuce ($0.08 = 80) stay exact.
-- * Every change to a player's cash goes through game.money(), which writes
--   the ledger. Nothing else may update players.cash.
-- * Errors meant for players are raised with errcode P0001 and a plain
--   English message; the client shows error.message as-is.

create extension if not exists pgcrypto with schema extensions;

create schema if not exists game;
revoke all on schema game from public;
grant usage on schema game to postgres, service_role;

-- ---------------------------------------------------------------------------
-- Configuration: tunable numbers, readable by game.cfg('key').
-- ---------------------------------------------------------------------------
create table game.config (
  key text primary key,
  value numeric not null,
  note text
);

insert into game.config (key, value, note) values
  ('start_cash', 10000000, 'Starting money for new players (mills): $10,000'),
  ('offline_cap_hours', 24, 'Businesses keep running this long after the owner was last online'),
  ('trade_fee_pct', 1.0, 'Exchange fee, % of trade value, paid by the seller'),
  ('max_walk_speed', 60, 'Metres per second a player can move on foot (game speed)'),
  ('action_range_m', 80, 'How close you must stand to place or rent something'),
  ('tier2_net_worth', 20000000, 'Net worth to unlock shops and restaurants ($20k)'),
  ('tier3_net_worth', 150000000, 'Net worth to unlock land and buildings ($150k)'),
  ('tier4_net_worth', 750000000, 'Net worth to unlock mining ($750k)'),
  ('tier5_net_worth', 3000000000, 'Net worth to unlock industry ($3M)'),
  ('tier6_net_worth', 15000000000, 'Net worth to unlock finance ($15M)'),
  ('property_tax_pct_day', 0.05, 'Property tax per day, % of land and building value'),
  ('npc_spread_pct', 20, 'Gap between NPC traders'' buy and sell prices, %'),
  ('npc_reversion_per_tick', 0.004, 'How fast NPC reference prices return to base each minute'),
  ('global_chat_enabled', 1, '1 = global chat channel open to everyone'),
  ('chat_rate_per_min', 12, 'Chat messages per minute per player'),
  ('survey_cost', 20000000, 'Cost of a mineral survey ($20,000)'),
  ('eviction_days', 3, 'Days of unpaid rent before a lease ends'),
  ('loyalty_per_day', 10, 'Loyalty points for each day played');

create function game.cfg(p_key text) returns numeric
language sql stable set search_path = game, pg_temp as $$
  select value from game.config where key = p_key
$$;

-- Player-facing error helper.
create function game.fail(p_message text) returns void
language plpgsql set search_path = game, pg_temp as $$
begin
  raise exception using errcode = 'P0001', message = p_message;
end $$;

-- $1,234.56 style formatting of mills.
create function game.fmt(p_mills bigint) returns text
language sql immutable set search_path = game, pg_temp as $$
  select case when p_mills < 0 then '-' else '' end || '$' ||
    case when abs(p_mills) >= 1000000000000 then to_char(abs(p_mills) / 1000.0, 'FM999,999,999,999,999')
         when abs(p_mills) >= 10000 then to_char(abs(p_mills) / 1000.0, 'FM999,999,999,990.00')
         else to_char(abs(p_mills) / 1000.0, 'FM990.00#') end
$$;

-- ---------------------------------------------------------------------------
-- Cities and their precomputed grids (from tools/citydata).
-- ---------------------------------------------------------------------------
create table game.cities (
  id text primary key,
  name text not null,
  country text not null,
  tz text not null,
  climate text not null default 'temperate',
  bbox float8[] not null,
  start_lng float8 not null,
  start_lat float8 not null,
  start_label text,
  hub_lng float8 not null,
  hub_lat float8 not null,
  hub_label text,
  lng0 float8 not null,
  lat0 float8 not null,
  kx float8 not null,
  ky float8 not null,
  width_m float8 not null,
  height_m float8 not null,
  walk_w int not null,
  walk_h int not null,
  plot_w int not null,
  plot_h int not null,
  traffic_w int not null,
  traffic_h int not null,
  walk_bits bytea not null,
  plot_bits bytea not null,
  coast_bits bytea not null,
  traffic bytea not null,
  open boolean not null default true,
  price_factor numeric not null default 1.0,
  wage_per_hour bigint not null default 15000,
  sort smallint not null default 0
);

create table game.buildings (
  id bigint primary key,
  city_id text not null references game.cities(id),
  lat float8 not null,
  lng float8 not null,
  footprint_m2 int not null,
  height_m numeric not null,
  levels int not null,
  rooms_total int not null,
  kind text not null,
  name text,
  landmark boolean not null default false,
  traffic numeric not null default 1,
  owner_id uuid,
  custom_name text,
  rent_pct int not null default 100,
  for_sale_price bigint,
  bought_price bigint,
  bought_at timestamptz,
  npc_occupancy numeric not null default 0.5
);
create index buildings_city_idx on game.buildings (city_id, lat, lng);
create index buildings_owner_idx on game.buildings (owner_id) where owner_id is not null;

create table game.building_aliases (
  alias_id bigint primary key,
  building_id bigint not null references game.buildings(id) on delete cascade
);

-- Local metric frame of a city.
create function game.city_xy(c game.cities, p_lat float8, p_lng float8, out x float8, out y float8)
language sql immutable set search_path = game, pg_temp as $$
  select (p_lng - c.lng0) * c.kx, (p_lat - c.lat0) * c.ky
$$;

create function game.dist_m(lat1 float8, lng1 float8, lat2 float8, lng2 float8) returns float8
language sql immutable set search_path = game, pg_temp as $$
  select sqrt(power((lng2 - lng1) * 111320 * cos(radians((lat1 + lat2) / 2)), 2) + power((lat2 - lat1) * 110574, 2))
$$;

create function game.bit_at(p_bits bytea, p_index bigint) returns boolean
language sql immutable set search_path = game, pg_temp as $$
  select p_index >= 0 and p_index < length(p_bits)::bigint * 8 and get_bit(p_bits, p_index::int) = 1
$$;

create function game.in_city(c game.cities, p_lat float8, p_lng float8) returns boolean
language sql immutable set search_path = game, pg_temp as $$
  select p_lng >= c.bbox[1] and p_lat >= c.bbox[2] and p_lng <= c.bbox[3] and p_lat <= c.bbox[4]
$$;

create function game.walkable(c game.cities, p_lat float8, p_lng float8) returns boolean
language plpgsql immutable set search_path = game, pg_temp as $$
declare
  x float8 := (p_lng - c.lng0) * c.kx;
  y float8 := (p_lat - c.lat0) * c.ky;
  cx int := floor(x / 5);
  cy int := floor(y / 5);
begin
  if cx < 0 or cy < 0 or cx >= c.walk_w or cy >= c.walk_h then return false; end if;
  return game.bit_at(c.walk_bits, cy::bigint * c.walk_w + cx);
end $$;

create function game.traffic_at(c game.cities, p_lat float8, p_lng float8) returns numeric
language plpgsql immutable set search_path = game, pg_temp as $$
declare
  cx int := floor((p_lng - c.lng0) * c.kx / 50);
  cy int := floor((p_lat - c.lat0) * c.ky / 50);
begin
  if cx < 0 or cy < 0 or cx >= c.traffic_w or cy >= c.traffic_h then return 0.1; end if;
  return get_byte(c.traffic, cy * c.traffic_w + cx) / 80.0;
end $$;

create function game.plot_of(c game.cities, p_lat float8, p_lng float8, out px int, out py int)
language sql immutable set search_path = game, pg_temp as $$
  select floor((p_lng - c.lng0) * c.kx / 25)::int, floor((p_lat - c.lat0) * c.ky / 25)::int
$$;

create function game.plot_center(c game.cities, p_px int, p_py int, out lat float8, out lng float8)
language sql immutable set search_path = game, pg_temp as $$
  select c.lat0 + (p_py + 0.5) * 25 / c.ky, c.lng0 + (p_px + 0.5) * 25 / c.kx
$$;

create function game.plot_buildable(c game.cities, p_px int, p_py int) returns boolean
language sql immutable set search_path = game, pg_temp as $$
  select p_px >= 0 and p_py >= 0 and p_px < c.plot_w and p_py < c.plot_h
     and game.bit_at(c.plot_bits, p_py::bigint * c.plot_w + p_px)
$$;

create function game.plot_coastal(c game.cities, p_px int, p_py int) returns boolean
language sql immutable set search_path = game, pg_temp as $$
  select p_px >= 0 and p_py >= 0 and p_px < c.plot_w and p_py < c.plot_h
     and game.bit_at(c.coast_bits, p_py::bigint * c.plot_w + p_px)
$$;

create function game.local_hour(p_city text) returns int
language sql stable set search_path = game, pg_temp as $$
  select extract(hour from now() at time zone (select tz from game.cities where id = p_city))::int
$$;

create function game.local_dow(p_city text) returns int
language sql stable set search_path = game, pg_temp as $$
  select extract(isodow from now() at time zone (select tz from game.cities where id = p_city))::int
$$;

-- ---------------------------------------------------------------------------
-- Players
-- ---------------------------------------------------------------------------
create table game.players (
  id uuid primary key,
  player_no bigint generated always as identity unique,
  display_name text not null,
  title text,
  skin text not null default 'classic',
  ring_style text not null default 'standard',
  cash bigint not null default 0 check (cash >= 0),
  net_worth bigint not null default 0,
  net_worth_at timestamptz,
  peak_net_worth bigint not null default 0,
  tier smallint not null default 1,
  city_id text references game.cities(id),
  lat float8,
  lng float8,
  pos_at timestamptz,
  inside_building bigint,
  travel_from text,
  travel_to text references game.cities(id),
  travel_arrive_at timestamptz,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  last_day date,
  days_played int not null default 0,
  loyalty_points int not null default 0,
  referral_code text unique,
  referred_by uuid references game.players(id),
  role text not null default 'player' check (role in ('player', 'mod', 'admin')),
  status text not null default 'active' check (status in ('active', 'suspended', 'banned', 'deleted')),
  status_until timestamptz,
  status_reason text,
  age_ok boolean not null default false,
  tutorial_done boolean not null default false,
  prefs jsonb not null default '{}'::jsonb,
  away_since timestamptz,
  month_start_worth bigint not null default 0,
  month_key text
);
create unique index players_name_unique on game.players (lower(display_name)) where status <> 'deleted';
create index players_city_idx on game.players (city_id, last_seen_at desc);
create index players_worth_idx on game.players (net_worth desc) where status = 'active';

-- ---------------------------------------------------------------------------
-- The ledger: every money change, who, what, how much, why.
-- Individual actions get one row each. Automatic income and costs from the
-- economy tick are summed into one row per player, kind and hour, so the
-- table stays small while every dollar is still accounted for.
-- ---------------------------------------------------------------------------
create table game.ledger (
  id bigint generated always as identity primary key,
  player_id uuid not null references game.players(id),
  at timestamptz not null default now(),
  amount bigint not null,
  balance_after bigint not null,
  kind text not null,
  memo text,
  ref jsonb,
  bucket timestamptz,
  entries int not null default 1
);
create index ledger_player_idx on game.ledger (player_id, at desc);
create index ledger_kind_at_idx on game.ledger (kind, at);
create unique index ledger_bucket_unique on game.ledger (player_id, kind, bucket) where bucket is not null;

-- Kinds of money flows. "world" flows create or destroy money; "transfer"
-- flows move it between players. World GDP sums world_in flows.
create table game.ledger_kinds (
  kind text primary key,
  label text not null,
  flow text not null check (flow in ('world_in', 'world_out', 'transfer', 'internal'))
);
insert into game.ledger_kinds (kind, label, flow) values
  ('start_grant', 'Starting money', 'world_in'),
  ('sales', 'Sales to customers', 'world_in'),
  ('npc_trade_sell', 'Sold to market traders', 'world_in'),
  ('npc_trade_buy', 'Bought from market traders', 'world_out'),
  ('npc_rent', 'Rent from local tenants', 'world_in'),
  ('export', 'Exports', 'world_in'),
  ('purchase', 'Purchases', 'world_out'),
  ('upgrade', 'Upgrades', 'world_out'),
  ('fitout', 'Fit-out', 'world_out'),
  ('wages', 'Staff wages', 'world_out'),
  ('upkeep', 'Running costs', 'world_out'),
  ('rent', 'Rent', 'transfer'),
  ('rent_income', 'Rent from tenants', 'transfer'),
  ('trade_buy', 'Bought on the exchange', 'transfer'),
  ('trade_sell', 'Sold on the exchange', 'transfer'),
  ('fee', 'Exchange fees', 'world_out'),
  ('tax', 'Property tax', 'world_out'),
  ('survey', 'Mineral surveys', 'world_out'),
  ('travel', 'Travel', 'world_out'),
  ('freight', 'Freight', 'world_out'),
  ('sale_to_game', 'Sold back to the city', 'world_in'),
  ('property_sale', 'Property sales', 'transfer'),
  ('property_buy', 'Property purchases', 'transfer'),
  ('escrow', 'Order escrow', 'internal'),
  ('escrow_return', 'Order escrow returned', 'internal'),
  ('loan', 'Loans', 'transfer'),
  ('loan_repay', 'Loan repayments', 'transfer'),
  ('interest', 'Interest', 'transfer'),
  ('bank_deposit', 'Bank capital', 'internal'),
  ('bank_withdraw', 'Bank capital returned', 'internal'),
  ('npc_loan', 'City bank loan', 'world_in'),
  ('npc_loan_repay', 'City bank repayment', 'world_out'),
  ('shares_buy', 'Bought shares', 'transfer'),
  ('shares_sell', 'Sold shares', 'transfer'),
  ('dividend', 'Dividends', 'transfer'),
  ('event', 'Event rewards', 'world_in'),
  ('admin', 'Staff adjustment', 'world_in'),
  ('reward', 'Rewards', 'world_in');

-- The one and only way to change a player's cash.
-- p_hourly = true sums the change into this hour's row for (player, kind).
create function game.money(
  p_player uuid,
  p_amount bigint,
  p_kind text,
  p_memo text default null,
  p_ref jsonb default null,
  p_hourly boolean default false
) returns bigint
language plpgsql set search_path = game, pg_temp as $$
declare
  v_bal bigint;
begin
  if p_amount is null then
    perform game.fail('Internal error: missing amount.');
  end if;
  if not exists (select 1 from game.ledger_kinds where kind = p_kind) then
    raise exception 'unknown ledger kind %', p_kind;
  end if;
  update game.players set cash = cash + p_amount
   where id = p_player and cash + p_amount >= 0
  returning cash into v_bal;
  if not found then
    if not exists (select 1 from game.players where id = p_player) then
      raise exception 'unknown player %', p_player;
    end if;
    select cash into v_bal from game.players where id = p_player;
    perform game.fail(format('Not enough money: you need %s more.', game.fmt(-p_amount - v_bal)));
  end if;
  if p_amount = 0 then
    return v_bal;
  end if;
  if p_hourly then
    insert into game.ledger as l (player_id, amount, balance_after, kind, memo, ref, bucket)
    values (p_player, p_amount, v_bal, p_kind, p_memo, p_ref, date_trunc('hour', now()))
    on conflict (player_id, kind, bucket) where bucket is not null do update
      set amount = l.amount + excluded.amount,
          balance_after = excluded.balance_after,
          at = now(),
          entries = l.entries + 1;
  else
    insert into game.ledger (player_id, amount, balance_after, kind, memo, ref)
    values (p_player, p_amount, v_bal, p_kind, p_memo, p_ref);
  end if;
  return v_bal;
end $$;

-- Charge only if affordable; returns false instead of failing.
create function game.try_money(
  p_player uuid, p_amount bigint, p_kind text, p_memo text default null,
  p_ref jsonb default null, p_hourly boolean default false
) returns boolean
language plpgsql set search_path = game, pg_temp as $$
begin
  if p_amount >= 0 then
    perform game.money(p_player, p_amount, p_kind, p_memo, p_ref, p_hourly);
    return true;
  end if;
  if (select cash from game.players where id = p_player) + p_amount < 0 then
    return false;
  end if;
  perform game.money(p_player, p_amount, p_kind, p_memo, p_ref, p_hourly);
  return true;
end $$;

-- ---------------------------------------------------------------------------
-- Notifications (shown in the bell menu, pushed live over Realtime).
-- ---------------------------------------------------------------------------
create table game.notifications (
  id bigint generated always as identity primary key,
  player_id uuid not null references game.players(id),
  at timestamptz not null default now(),
  kind text not null,
  title text not null,
  body text,
  data jsonb,
  read boolean not null default false
);
create index notifications_player_idx on game.notifications (player_id, at desc);

create function game.notify(p_player uuid, p_kind text, p_title text, p_body text default null, p_data jsonb default null)
returns void language plpgsql set search_path = game, pg_temp as $$
declare
  v_id bigint;
begin
  insert into game.notifications (player_id, kind, title, body, data)
  values (p_player, p_kind, p_title, p_body, p_data) returning id into v_id;
  perform game.push('user:' || p_player::text, 'notification',
    jsonb_build_object('id', v_id, 'kind', p_kind, 'title', p_title, 'body', p_body, 'data', p_data));
end $$;

-- Broadcast to a private Realtime channel from inside the database.
-- Silently does nothing where Realtime isn't installed (plain Postgres tests).
create function game.push(p_topic text, p_event text, p_payload jsonb)
returns void language plpgsql set search_path = game, pg_temp as $$
begin
  if to_regprocedure('realtime.send(jsonb,text,text,boolean)') is not null then
    execute 'select realtime.send($1, $2, $3, true)' using p_payload, p_event, p_topic;
  end if;
exception when others then
  -- A broadcast failure must never undo a game action.
  null;
end $$;

-- ---------------------------------------------------------------------------
-- Rate limits: token bucket per player (or anonymous key) and action.
-- ---------------------------------------------------------------------------
create table game.rate_buckets (
  subject text not null,
  action text not null,
  tokens float8 not null,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (subject, action)
);

-- Allows p_burst actions at once, refilling at p_per_minute.
create function game.rate_limit(p_subject text, p_action text, p_burst int, p_per_minute float8)
returns void language plpgsql set search_path = game, pg_temp as $$
declare
  v_tokens float8;
begin
  insert into game.rate_buckets as b (subject, action, tokens, updated_at)
  values (p_subject, p_action, p_burst - 1, clock_timestamp())
  on conflict (subject, action) do update
    set tokens = least(p_burst::float8,
          b.tokens + extract(epoch from clock_timestamp() - b.updated_at) / 60.0 * p_per_minute) - 1,
        updated_at = clock_timestamp()
  returning tokens into v_tokens;
  if v_tokens < 0 then
    -- Undo the overdraw so waiting is enough to recover.
    update game.rate_buckets set tokens = 0 where subject = p_subject and action = p_action;
    perform game.fail('Slow down: you''re doing that too often. Try again in a moment.');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Session helpers used by every API function.
-- ---------------------------------------------------------------------------
create function game.uid() returns uuid
language sql stable set search_path = game, pg_temp as $$
  select nullif(coalesce(
    current_setting('request.jwt.claims', true)::jsonb ->> 'sub',
    current_setting('request.jwt.claim.sub', true)
  ), '')::uuid
$$;

-- The signed-in player, checked: signed in, has a profile, may act.
-- Also lands arriving travellers and keeps last_seen fresh.
create function game.me(p_for_action boolean default true) returns game.players
language plpgsql set search_path = game, pg_temp as $$
declare
  v_uid uuid := game.uid();
  p game.players;
begin
  if v_uid is null then
    perform game.fail('Please sign in first.');
  end if;
  select * into p from game.players where id = v_uid;
  if not found then
    perform game.fail('Create your player profile first.');
  end if;
  if p.status = 'deleted' then
    perform game.fail('This account has been deleted.');
  end if;
  if p.status in ('suspended', 'banned') and p.status_until is not null and p.status_until < now() then
    update game.players set status = 'active', status_until = null, status_reason = null where id = p.id
    returning * into p;
  end if;
  if p_for_action and p.status = 'banned' then
    perform game.fail('Your account is banned: ' || coalesce(p.status_reason, 'no reason given') || '.');
  end if;
  if p_for_action and p.status = 'suspended' then
    perform game.fail(format('Your account is suspended until %s: %s.',
      to_char(p.status_until at time zone 'UTC', 'DD Mon YYYY HH24:MI "UTC"'), coalesce(p.status_reason, 'no reason given')));
  end if;
  if p.travel_to is not null and p.travel_arrive_at <= now() then
    update game.players
       set city_id = p.travel_to,
           lat = (select hub_lat from game.cities where id = p.travel_to),
           lng = (select hub_lng from game.cities where id = p.travel_to),
           pos_at = now(), travel_to = null, travel_from = null, travel_arrive_at = null
     where id = p.id
    returning * into p;
  end if;
  if p.last_seen_at < now() - interval '30 seconds' then
    update game.players set last_seen_at = now() where id = p.id;
    p.last_seen_at := now();
  end if;
  return p;
end $$;

create function game.require_staff(p game.players, p_admin boolean default false) returns void
language plpgsql set search_path = game, pg_temp as $$
begin
  if p.role = 'admin' or (not p_admin and p.role = 'mod') then
    return;
  end if;
  perform game.fail('Only staff can do that.');
end $$;

-- ---------------------------------------------------------------------------
-- Movement. Positions are game positions only; the game never asks for a
-- player's real location. Moves are checked against a maximum speed so a
-- modified client can't teleport around the map to grab spots.
-- ---------------------------------------------------------------------------
create function game.set_position(p game.players, p_city text, p_lat float8, p_lng float8, p_inside bigint default null)
returns game.players
language plpgsql set search_path = game, pg_temp as $$
declare
  c game.cities;
  v_elapsed float8;
  v_allowed float8;
  v_dist float8;
  v_lat float8 := p_lat;
  v_lng float8 := p_lng;
  f float8;
begin
  if p.travel_to is not null then
    perform game.fail('You''re travelling. Wait until you arrive.');
  end if;
  if p.city_id is null or p.city_id <> p_city then
    perform game.fail('You''re not in that city. Travel there first.');
  end if;
  select * into c from game.cities where id = p_city;
  if not game.in_city(c, p_lat, p_lng) then
    perform game.fail('That spot is outside the playable part of ' || c.name || '.');
  end if;
  if p.lat is not null and p.pos_at is not null then
    v_elapsed := greatest(0, extract(epoch from now() - p.pos_at));
    v_allowed := 40 + v_elapsed * game.cfg('max_walk_speed');
    v_dist := game.dist_m(p.lat, p.lng, p_lat, p_lng);
    if v_dist > v_allowed then
      -- Too far for the time elapsed: move as far as allowed toward it.
      f := v_allowed / v_dist;
      v_lat := p.lat + (p_lat - p.lat) * f;
      v_lng := p.lng + (p_lng - p.lng) * f;
    end if;
  end if;
  update game.players
     set lat = v_lat, lng = v_lng, pos_at = now(), inside_building = p_inside, last_seen_at = now()
   where id = p.id
  returning * into p;
  return p;
end $$;

-- Must be standing within range of a point (after applying a claimed position).
create function game.require_near(p game.players, p_lat float8, p_lng float8, p_range float8 default null)
returns void language plpgsql set search_path = game, pg_temp as $$
declare
  v_range float8 := coalesce(p_range, game.cfg('action_range_m'));
begin
  if p.lat is null or game.dist_m(p.lat, p.lng, p_lat, p_lng) > v_range then
    perform game.fail(format('Walk closer first: you need to be within %s m.', round(v_range)));
  end if;
end $$;

-- Travel distance between cities in km (great circle).
create function game.city_km(a text, b text) returns float8
language sql stable set search_path = game, pg_temp as $$
  select 6371 * 2 * asin(sqrt(
    power(sin(radians(cb.hub_lat - ca.hub_lat) / 2), 2) +
    cos(radians(ca.hub_lat)) * cos(radians(cb.hub_lat)) * power(sin(radians(cb.hub_lng - ca.hub_lng) / 2), 2)))
  from game.cities ca, game.cities cb where ca.id = a and cb.id = b
$$;

-- Ticket price (mills) and flight time (minutes) between two cities.
create function game.travel_quote(a text, b text, out price bigint, out minutes int)
language sql stable set search_path = game, pg_temp as $$
  select (150000 + round(game.city_km(a, b) * 60))::bigint,
         (3 + round(game.city_km(a, b) / 1500))::int
$$;

-- ---------------------------------------------------------------------------
-- Badges: milestones players earn (shown on profiles).
-- ---------------------------------------------------------------------------
create table game.badges (
  id text primary key,
  name text not null,
  description text not null,
  icon text not null,
  sort smallint not null default 0
);
insert into game.badges (id, name, description, icon, sort) values
  ('first_sale', 'First sale', 'Sold to your first customer.', '🪙', 1),
  ('first_100k', 'Six figures', 'Reached $100,000 in net worth.', '💵', 2),
  ('first_million', 'Millionaire', 'Reached $1,000,000 in net worth.', '💰', 3),
  ('first_room', 'Open for business', 'Opened a shop or restaurant in a rented room.', '🏪', 4),
  ('first_building', 'Landlord', 'Bought your first building.', '🏢', 5),
  ('first_plot', 'Landowner', 'Bought your first plot of land.', '🗺️', 6),
  ('first_survey', 'Prospector', 'Paid for your first mineral survey.', '🔍', 7),
  ('first_mine', 'Strike!', 'Opened your first mine.', '⛏️', 8),
  ('first_factory', 'Industrialist', 'Built your first factory.', '🏭', 9),
  ('first_export', 'Exporter', 'Sold your first export through a port.', '🚢', 10),
  ('first_trade', 'Trader', 'Traded on the exchange.', '📈', 11),
  ('globetrotter', 'Globetrotter', 'Visited every launch city.', '✈️', 12),
  ('first_bank', 'Banker', 'Opened a bank.', '🏦', 13),
  ('public_company', 'Public company', 'Took your company public.', '🔔', 14),
  ('tutorial', 'Graduate', 'Finished Tutorial Island.', '🎓', 15),
  ('bug_hunter', 'Bug hunter', 'A bug you reported was confirmed by staff.', '🐞', 16),
  ('founder', 'Founding player', 'Joined in the first month.', '🌱', 17),
  ('trophy_diamond', 'Diamond inviter', 'Top inviter of the month.', '💎', 20),
  ('trophy_gold', 'Gold inviter', 'Second-best inviter of the month.', '🥇', 21),
  ('trophy_silver', 'Silver inviter', 'Third-best inviter of the month.', '🥈', 22),
  ('trophy_bronze', 'Bronze inviter', 'Fourth-best inviter of the month.', '🥉', 23);

create table game.player_badges (
  player_id uuid not null references game.players(id),
  badge_id text not null references game.badges(id),
  earned_at timestamptz not null default now(),
  note text,
  primary key (player_id, badge_id, earned_at)
);
create unique index player_badges_once on game.player_badges (player_id, badge_id) where badge_id not like 'trophy_%';

-- Award a badge once (trophies can repeat); notifies the player.
create function game.award(p_player uuid, p_badge text, p_note text default null) returns boolean
language plpgsql set search_path = game, pg_temp as $$
declare
  b game.badges;
begin
  select * into b from game.badges where id = p_badge;
  if not found then return false; end if;
  if p_badge not like 'trophy_%' and exists (select 1 from game.player_badges where player_id = p_player and badge_id = p_badge) then
    return false;
  end if;
  insert into game.player_badges (player_id, badge_id, note) values (p_player, p_badge, p_note);
  perform game.notify(p_player, 'badge', 'Badge earned: ' || b.name, b.description, jsonb_build_object('badge', p_badge));
  return true;
end $$;
