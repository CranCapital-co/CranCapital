-- CranCapital public API, part 1: world, players, movement, businesses,
-- property, exchange, storage, ledger, notifications. Players call these
-- through Supabase (supabase.rpc). Each is SECURITY DEFINER with a fixed
-- search_path; the client can only ask, and the server decides.

-- ---------------------------------------------------------------------------
-- World (anyone, signed in or not)
-- ---------------------------------------------------------------------------
create function public.get_catalog() returns jsonb
language sql stable security definer set search_path = game, pg_temp as $$
  select jsonb_build_object(
    'cities', (select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'country', country, 'tz', tz, 'climate', climate,
       'bbox', bbox, 'start', jsonb_build_object('lng', start_lng, 'lat', start_lat, 'label', start_label),
       'hub', jsonb_build_object('lng', hub_lng, 'lat', hub_lat, 'label', hub_label),
       'price_factor', price_factor, 'wage_per_hour', wage_per_hour, 'open', open) order by sort) from game.cities),
    'goods', (select jsonb_agg(to_jsonb(g) order by sort) from game.goods g),
    'menu_items', (select jsonb_agg(to_jsonb(m) order by sort) from game.menu_items m),
    'business_types', (select jsonb_agg(to_jsonb(t) order by sort) from game.business_types t),
    'fitout_items', (select jsonb_agg(to_jsonb(f) order by sort) from game.fitout_items f),
    'recipes', (select jsonb_agg(to_jsonb(r)) from game.recipes r),
    'crops', (select jsonb_object_agg(good_id, per_hour) from game.crops),
    'tiers', (select jsonb_agg(jsonb_build_object('tier', tier, 'name', name, 'idea', idea, 'net_worth', game.tier_threshold(tier)) order by tier) from game.tiers),
    'badges', (select jsonb_agg(to_jsonb(b) order by sort) from game.badges b),
    'deposit_types', (select jsonb_agg(to_jsonb(d)) from game.deposit_types d),
    'config', (select jsonb_object_agg(key, value) from game.config where key in (
       'start_cash', 'offline_cap_hours', 'trade_fee_pct', 'max_walk_speed', 'action_range_m', 'max_carts',
       'survey_cost', 'eviction_days', 'property_tax_pct_day', 'global_chat_enabled', 'base_storage',
       'cart_spacing_m', 'competition_radius_m', 'sellback_pct', 'loyalty_per_day', 'npc_spread_pct'))
  )
$$;

create function public.world_stats() returns jsonb
language sql stable security definer set search_path = game, pg_temp as $$
  select jsonb_build_object(
    'players_online', (select count(*) from game.players where status = 'active' and last_seen_at > now() - interval '5 minutes'),
    'players_total', (select count(*) from game.players where status <> 'deleted'),
    'gdp_24h', (select coalesce(sum(l.amount), 0) from game.ledger l join game.ledger_kinds k using (kind)
                 where l.at > now() - interval '24 hours' and k.flow = 'world_in' and l.kind not in ('start_grant', 'admin', 'reward', 'npc_loan')),
    'net_worth_total', (select coalesce(sum(net_worth), 0) from game.players where status = 'active'),
    'businesses', (select count(*) from game.businesses where status = 'open'),
    'ticker', (select jsonb_agg(jsonb_build_object(
        'good', m.good_id, 'name', g.name, 'icon', g.icon,
        'price', coalesce(m.last_price, round(m.ref_price)),
        'change_pct', round(((m.ref_price - coalesce(
            (select c.close from game.candles c where c.good_id = m.good_id and c.bucket <= now() - interval '24 hours' order by c.bucket desc limit 1),
            g.base_price)) / nullif(coalesce(
            (select c.close from game.candles c where c.good_id = m.good_id and c.bucket <= now() - interval '24 hours' order by c.bucket desc limit 1),
            g.base_price), 0) * 100)::numeric, 1)) order by g.sort)
        from game.markets m join game.goods g on g.id = m.good_id),
    'at', now()
  )
$$;

-- ---------------------------------------------------------------------------
-- Players
-- ---------------------------------------------------------------------------
create function game.player_json(p game.players) returns jsonb
language sql stable set search_path = game, pg_temp as $$
  select jsonb_build_object(
    'id', p.id, 'player_no', p.player_no, 'display_name', p.display_name, 'title', p.title, 'skin', p.skin,
    'ring_style', p.ring_style, 'cash', p.cash, 'net_worth', p.net_worth, 'peak_net_worth', p.peak_net_worth, 'tier', p.tier,
    'city_id', p.city_id, 'lat', p.lat, 'lng', p.lng, 'inside_building', p.inside_building,
    'travel_from', p.travel_from, 'travel_to', p.travel_to, 'travel_arrive_at', p.travel_arrive_at,
    'created_at', p.created_at, 'days_played', p.days_played, 'loyalty_points', p.loyalty_points,
    'referral_code', p.referral_code, 'role', p.role, 'status', p.status, 'status_until', p.status_until,
    'status_reason', p.status_reason, 'tutorial_done', p.tutorial_done, 'prefs', p.prefs,
    'unread', (select count(*) from game.notifications n where n.player_id = p.id and not n.read),
    'next_tier', (select jsonb_build_object('tier', t.tier, 'name', t.name, 'net_worth', game.tier_threshold(t.tier))
                    from game.tiers t where t.tier = p.tier + 1)
  )
$$;

create function game.check_display_name(p_name text) returns text
language plpgsql set search_path = game, pg_temp as $$
declare
  v text := btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'));
begin
  if length(v) < 3 or length(v) > 20 then perform game.fail('Display names are 3 to 20 characters.'); end if;
  if v !~ '^[[:alnum:] _''-]+$' then perform game.fail('Use letters, numbers, spaces, dashes, apostrophes and underscores only.'); end if;
  v := game.clean_name(v, v);
  return v;
end $$;

create function public.create_player(p_name text, p_age_ok boolean, p_referral text default null) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  v_uid uuid := game.uid();
  v_name text;
  v_ref uuid;
  p game.players;
  v_code text;
begin
  if v_uid is null then perform game.fail('Please sign in first.'); end if;
  if exists (select 1 from game.players where id = v_uid) then perform game.fail('You already have a player.'); end if;
  if not coalesce(p_age_ok, false) then perform game.fail('You must be 13 or over to play CranCapital.'); end if;
  perform game.rate_limit(v_uid::text, 'create_player', 5, 1);
  v_name := game.check_display_name(p_name);
  if exists (select 1 from game.players where lower(display_name) = lower(v_name) and status <> 'deleted') then
    perform game.fail('That name is taken. Try another.');
  end if;
  if p_referral is not null and btrim(p_referral) <> '' then
    select id into v_ref from game.players where referral_code = upper(btrim(p_referral)) and status = 'active';
  end if;
  loop
    v_code := upper(substr(encode(extensions.gen_random_bytes(6), 'hex'), 1, 8));
    exit when not exists (select 1 from game.players where referral_code = v_code);
  end loop;
  insert into game.players (id, display_name, age_ok, referral_code, referred_by, last_day, days_played)
  values (v_uid, v_name, true, v_code, v_ref, (now() at time zone 'utc')::date, 1)
  returning * into p;
  perform game.money(p.id, game.cfg('start_cash')::bigint, 'start_grant', 'Welcome to CranCapital');
  if p.created_at < coalesce((select min(created_at) from game.players), now()) + interval '30 days' then
    perform game.award(p.id, 'founder');
  end if;
  if v_ref is not null then
    perform game.notify(v_ref, 'referral', 'Someone joined with your invite', format('%s joined CranCapital using your link.', v_name));
  end if;
  perform game.refresh_worth(p.id);
  select * into p from game.players where id = v_uid;
  return game.player_json(p);
end $$;

create function public.get_me() returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
begin
  if game.uid() is null then return null; end if;
  if not exists (select 1 from game.players where id = game.uid()) then
    return jsonb_build_object('needs_profile', true);
  end if;
  return game.player_json(game.me(false));
end $$;

-- Called when the game opens: daily login bonus, and the "while you were
-- away" summary when the player has been gone for a while.
create function public.session_start() returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  v_uid uuid := game.uid();
  raw game.players;
  p game.players;
  v_prev timestamptz;
  v_today date := (now() at time zone 'utc')::date;
  v_away jsonb;
  v_new_day boolean := false;
begin
  if v_uid is null then return null; end if;
  select * into raw from game.players where id = v_uid;
  if not found then return jsonb_build_object('needs_profile', true); end if;
  v_prev := greatest(raw.last_seen_at, coalesce(raw.away_since, raw.last_seen_at));
  p := game.me(false);
  update game.players set last_seen_at = now() where id = p.id;
  if to_regprocedure('game.record_device(uuid)') is not null then
    execute 'select game.record_device($1)' using p.id;
  end if;
  if p.last_day is distinct from v_today and p.status = 'active' then
    update game.players set last_day = v_today, days_played = days_played + 1,
           loyalty_points = loyalty_points + game.cfg('loyalty_per_day')::int
     where id = p.id returning * into p;
    v_new_day := true;
  end if;
  if now() - raw.last_seen_at > interval '10 minutes' then
    v_away := jsonb_build_object(
      'since', raw.last_seen_at,
      'hours', round(extract(epoch from now() - raw.last_seen_at) / 3600.0, 1),
      'paused', now() - raw.last_seen_at > make_interval(hours => game.cfg('offline_cap_hours')::int),
      'flows', (select coalesce(jsonb_agg(jsonb_build_object('kind', l.kind, 'label', k.label, 'amount', l.total) order by abs(l.total) desc), '[]'::jsonb)
                  from (select kind, sum(amount) total from game.ledger
                         where player_id = p.id and at > raw.last_seen_at and kind not in ('escrow', 'escrow_return')
                         group by kind) l join game.ledger_kinds k using (kind)),
      'net', (select coalesce(sum(amount), 0) from game.ledger where player_id = p.id and at > raw.last_seen_at and kind not in ('escrow', 'escrow_return')),
      'notifications', (select coalesce(jsonb_agg(to_jsonb(n) order by n.at desc), '[]'::jsonb)
                          from (select id, at, kind, title, body, data from game.notifications
                                 where player_id = p.id and at > raw.last_seen_at order by at desc limit 8) n),
      'attention', (select coalesce(jsonb_agg(jsonb_build_object('business', b.id, 'name', b.name, 'kind', b.kind, 'flags', b.flags, 'status', b.status)), '[]'::jsonb)
                      from game.businesses b
                     where b.owner_id = p.id and b.status in ('open', 'closed', 'abandoned', 'depleted')
                       and (b.status <> 'open' or b.flags ?| array['out_of_stock', 'rent_due', 'staff_quit', 'no_fuel', 'no_inputs', 'storage_full', 'missing', 'evicted']))
    );
  end if;
  return jsonb_build_object('me', game.player_json(p), 'away', v_away, 'new_day', v_new_day,
    'loyalty_added', case when v_new_day then game.cfg('loyalty_per_day') else 0 end);
end $$;

create function public.complete_tutorial() returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me(false);
begin
  update game.players set tutorial_done = true where id = p.id;
  perform game.award(p.id, 'tutorial');
  return jsonb_build_object('ok', true);
end $$;

-- First arrival in a city (free). Later moves between cities are flights.
create function public.choose_city(p_city text) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me();
  c game.cities;
begin
  select * into c from game.cities where id = p_city and open;
  if not found then perform game.fail('That city isn''t open yet.'); end if;
  if p.city_id is not null then perform game.fail('You''re already in a city. Travel to move.'); end if;
  update game.players set city_id = c.id, lat = c.start_lat, lng = c.start_lng, pos_at = now() where id = p.id returning * into p;
  return game.player_json(p);
end $$;

create function public.report_position(p_lat float8, p_lng float8, p_inside bigint default null) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me(false);
  v_inside bigint;
  bl game.buildings;
begin
  update game.players set last_seen_at = now() where id = p.id;
  if p.city_id is null or p.travel_to is not null then
    return jsonb_build_object('lat', p.lat, 'lng', p.lng, 'city_id', p.city_id);
  end if;
  perform game.rate_limit(p.id::text, 'pos', 20, 40);
  if p_inside is not null then
    select * into bl from game.buildings where id = game.resolve_building(p_inside) and city_id = p.city_id;
    if found and game.dist_m(bl.lat, bl.lng, p_lat, p_lng) <= game.building_range(bl) then
      v_inside := bl.id;
    end if;
  end if;
  p := game.set_position(p, p.city_id, p_lat, p_lng, v_inside);
  return jsonb_build_object('lat', p.lat, 'lng', p.lng, 'city_id', p.city_id);
end $$;

-- The open game calls this every minute; it keeps "last online" fresh,
-- which is what the 24-hour offline earnings window counts from.
create function public.heartbeat() returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me(false);
begin
  update game.players set last_seen_at = now() where id = p.id;
  return jsonb_build_object('cash', p.cash, 'net_worth', p.net_worth, 'tier', p.tier,
    'unread', (select count(*) from game.notifications n where n.player_id = p.id and not n.read),
    'city_id', p.city_id, 'travel_to', p.travel_to, 'travel_arrive_at', p.travel_arrive_at, 'status', p.status);
end $$;

create function public.taxi(p_lat float8, p_lng float8) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me();
  c game.cities;
  v_km float8;
  v_cost bigint;
begin
  if p.city_id is null or p.travel_to is not null then perform game.fail('You can''t take a taxi right now.'); end if;
  select * into c from game.cities where id = p.city_id;
  if not game.in_city(c, p_lat, p_lng) then perform game.fail('That''s outside the playable part of the city.'); end if;
  perform game.rate_limit(p.id::text, 'taxi', 6, 6);
  v_km := game.dist_m(coalesce(p.lat, c.start_lat), coalesce(p.lng, c.start_lng), p_lat, p_lng) / 1000;
  v_cost := round(3000 + v_km * 2000);
  perform game.money(p.id, -v_cost, 'travel', format('Taxi ride (%s km)', round(v_km::numeric, 1)));
  update game.players set lat = p_lat, lng = p_lng, pos_at = now(), inside_building = null where id = p.id;
  return jsonb_build_object('cost', v_cost, 'lat', p_lat, 'lng', p_lng);
end $$;

create function public.travel_quote(p_city text) returns jsonb
language plpgsql stable security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me(false);
  q record;
begin
  if p.city_id is null then return jsonb_build_object('price', 0, 'minutes', 0); end if;
  select * into q from game.travel_quote(p.city_id, p_city);
  return jsonb_build_object('price', q.price, 'minutes', q.minutes, 'km', round(game.city_km(p.city_id, p_city)));
end $$;

create function public.travel(p_city text) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me();
  q record;
begin
  if p.city_id is null then perform game.fail('Pick your first city instead.'); end if;
  if p.travel_to is not null then perform game.fail('You''re already travelling.'); end if;
  if p.city_id = p_city then perform game.fail('You''re already here.'); end if;
  if not exists (select 1 from game.cities where id = p_city and open) then perform game.fail('That city isn''t open.'); end if;
  select * into q from game.travel_quote(p.city_id, p_city);
  perform game.money(p.id, -q.price, 'travel', format('Flight to %s', (select name from game.cities where id = p_city)),
    jsonb_build_object('to', p_city));
  update game.players set travel_from = city_id, travel_to = p_city, travel_arrive_at = now() + make_interval(mins => q.minutes),
         inside_building = null
   where id = p.id returning * into p;
  if (select count(distinct (ref ->> 'to')) from game.ledger where player_id = p.id and kind = 'travel' and ref ? 'to')
     >= (select count(*) - 1 from game.cities where open) then
    perform game.award(p.id, 'globetrotter');
  end if;
  return game.player_json(p);
end $$;

-- ---------------------------------------------------------------------------
-- Businesses
-- ---------------------------------------------------------------------------
create function game.business_json(b game.businesses, p_full boolean) returns jsonb
language sql stable set search_path = game, pg_temp as $$
  select (case when p_full then to_jsonb(b) - array['owner_id', 'carry', 'fuel_carry']
          else jsonb_build_object('id', b.id, 'kind', b.kind, 'name', b.name, 'city_id', b.city_id, 'lat', b.lat, 'lng', b.lng,
                 'level', b.level, 'status', b.status, 'open_hour', b.open_hour, 'close_hour', b.close_hour,
                 'building_id', b.building_id, 'plot_x', b.plot_x, 'plot_y', b.plot_y, 'created_at', b.created_at) end)
    || jsonb_build_object(
      'type_name', (select name from game.business_types where id = b.kind),
      'icon', (select icon from game.business_types where id = b.kind),
      'menu_category', (select menu_category from game.business_types where id = b.kind),
      'owner_name', (select display_name from game.players where id = b.owner_id),
      'owner_no', (select player_no from game.players where id = b.owner_id))
    || case when p_full then jsonb_build_object(
      'lease', (select jsonb_build_object('rent_per_day', l.rent_per_day, 'unpaid', l.unpaid, 'unpaid_since', l.unpaid_since,
                  'building_name', coalesce(bl.custom_name, bl.name), 'landlord', (select display_name from game.players where id = bl.owner_id))
                  from game.leases l join game.buildings bl on bl.id = l.building_id where l.business_id = b.id and l.status = 'active'),
      'upgrade_cost', case when b.level < (select max_level from game.business_types where id = b.kind)
                           then game.upgrade_cost((select t from game.business_types t where t.id = b.kind), b.level) end,
      'menu_slots', game.menu_slots(b.kind, b.level),
      'deposit', (select jsonb_build_object('resource', d.resource, 'units_left', d.units_left, 'units_total', d.units_total)
                    from game.deposits d where d.id = b.deposit_id),
      'history', (select coalesce(jsonb_agg(jsonb_build_object('day', day, 'sales', sales, 'revenue', revenue, 'costs', costs, 'produced', produced) order by day), '[]'::jsonb)
                    from (select * from game.business_days where business_id = b.id order by day desc limit 14) h),
      'local_hour', game.local_hour(b.city_id),
      'wage_per_hour', (select wage_per_hour from game.cities where id = b.city_id)
    ) else '{}'::jsonb end
$$;

create function public.my_businesses() returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me(false);
begin
  return coalesce((select jsonb_agg(game.business_json(b, true) order by b.created_at)
    from game.businesses b where b.owner_id = p.id and b.status in ('open', 'closed', 'abandoned', 'depleted')), '[]'::jsonb);
end $$;

create function public.business_detail(p_id bigint) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me(false);
  b game.businesses;
begin
  select * into b from game.businesses where id = p_id and status <> 'sold';
  if not found then perform game.fail('Business not found.'); end if;
  if b.owner_id = p.id then return game.business_json(b, true); end if;
  -- Others see the shop front: name, kind, owner, menu and prices.
  return game.business_json(b, false) || jsonb_build_object('menu', b.settings -> 'menu', 'mine', false);
end $$;

create function public.buy_cart(p_name text, p_lat float8, p_lng float8) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
begin return game.buy_cart(game.me(), p_name, p_lat, p_lng); end $$;

create function public.move_cart(p_id bigint, p_lat float8, p_lng float8) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
begin return game.move_cart(game.me(), p_id, p_lat, p_lng); end $$;

create function public.set_menu(p_id bigint, p_menu jsonb) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
begin return game.set_menu(game.me(), p_id, p_menu); end $$;

create function public.set_hours(p_id bigint, p_open int, p_close int) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
begin return game.set_hours(game.me(), p_id, p_open, p_close); end $$;

create function public.set_business_open(p_id bigint, p_open boolean) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
begin return game.set_status(game.me(), p_id, p_open); end $$;

create function public.rename_business(p_id bigint, p_name text) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
begin return game.rename_business(game.me(), p_id, p_name); end $$;

create function public.set_business_option(p_id bigint, p_key text, p_value jsonb) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
begin return game.set_business_option(game.me(), p_id, p_key, p_value); end $$;

create function public.upgrade_business(p_id bigint) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
begin return game.upgrade_business(game.me(), p_id); end $$;

create function public.sell_business(p_id bigint) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
begin return game.sell_business(game.me(), p_id); end $$;

create function public.rent_room(p_building bigint, p_kind text, p_name text, p_lat float8, p_lng float8) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
begin return game.rent_room(game.me(), p_building, p_kind, p_name, p_lat, p_lng); end $$;

create function public.set_fitout(p_id bigint, p_items jsonb) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
begin return game.set_fitout(game.me(), p_id, p_items); end $$;

create function public.set_staff(p_id bigint, p_staff int) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
begin return game.set_staff(game.me(), p_id, p_staff); end $$;

-- ---------------------------------------------------------------------------
-- Map queries
-- ---------------------------------------------------------------------------
create function public.map_businesses(p_city text, p_w float8, p_s float8, p_e float8, p_n float8) returns jsonb
language plpgsql stable security definer set search_path = game, pg_temp as $$
declare
  v_uid uuid := game.uid();
begin
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', b.id, 'kind', b.kind, 'name', b.name, 'lat', b.lat, 'lng', b.lng, 'level', b.level, 'status', b.status,
      'owner_no', pl.player_no, 'owner_name', pl.display_name, 'mine', b.owner_id = v_uid, 'building_id', b.building_id,
      'plot_x', b.plot_x, 'plot_y', b.plot_y))
    from (select * from game.businesses
           where city_id = p_city and status in ('open', 'closed', 'abandoned', 'depleted')
             and lat between p_s and p_n and lng between p_w and p_e
           order by (owner_id = v_uid) desc, lifetime_revenue desc limit 800) b
    join game.players pl on pl.id = b.owner_id), '[]'::jsonb);
end $$;

-- Buildings in view that have something to show: owners, my rooms, sales.
create function public.map_buildings(p_city text, p_w float8, p_s float8, p_e float8, p_n float8) returns jsonb
language plpgsql stable security definer set search_path = game, pg_temp as $$
declare
  v_uid uuid := game.uid();
begin
  return coalesce((select jsonb_agg(jsonb_build_object('id', bl.id, 'owner_no', pl.player_no, 'owner_name', pl.display_name,
      'mine', bl.owner_id = v_uid, 'for_sale', bl.for_sale_price is not null,
      'my_room', exists (select 1 from game.leases l where l.building_id = bl.id and l.tenant_id = v_uid and l.status = 'active'),
      'tenants', (select count(*) from game.leases l where l.building_id = bl.id and l.status = 'active'),
      'aliases', (select coalesce(jsonb_agg(alias_id), '[]'::jsonb) from game.building_aliases a where a.building_id = bl.id)))
    from game.buildings bl left join game.players pl on pl.id = bl.owner_id
   where bl.city_id = p_city and bl.lat between p_s and p_n and bl.lng between p_w and p_e
     and (bl.owner_id is not null or exists (select 1 from game.leases l where l.building_id = bl.id and l.status = 'active'))), '[]'::jsonb);
end $$;

create function public.building_info(p_building bigint) returns jsonb
language plpgsql stable security definer set search_path = game, pg_temp as $$
declare
  v_uid uuid := game.uid();
  bl game.buildings;
begin
  select * into bl from game.buildings where id = game.resolve_building(p_building);
  if not found then return null; end if;
  return jsonb_build_object('id', bl.id, 'city_id', bl.city_id, 'lat', bl.lat, 'lng', bl.lng, 'footprint_m2', bl.footprint_m2,
    'height_m', bl.height_m, 'levels', bl.levels, 'rooms_total', bl.rooms_total, 'kind', bl.kind, 'name', bl.name, 'landmark', bl.landmark,
    'traffic', bl.traffic, 'custom_name', bl.custom_name, 'rent_pct', bl.rent_pct, 'for_sale_price', bl.for_sale_price,
    'bought_price', case when bl.owner_id = v_uid then bl.bought_price end, 'owned', bl.owner_id is not null) || jsonb_build_object(
    'display_name', coalesce(bl.custom_name, bl.name),
    'owner_name', (select display_name from game.players where id = bl.owner_id),
    'owner_no', (select player_no from game.players where id = bl.owner_id),
    'mine', bl.owner_id = v_uid,
    'rooms_free', game.rooms_free(bl.id),
    'rent_per_day', game.room_rent(bl),
    'price', case when bl.landmark then null when bl.owner_id is null then game.building_value(bl) else bl.for_sale_price end,
    'range_m', round(game.building_range(bl)),
    'tenants', (select coalesce(jsonb_agg(jsonb_build_object('business_id', b.id, 'name', b.name, 'kind', b.kind,
                  'icon', (select icon from game.business_types where id = b.kind),
                  'owner_name', pl.display_name, 'owner_no', pl.player_no, 'mine', b.owner_id = v_uid,
                  'rent_per_day', l.rent_per_day)), '[]'::jsonb)
                  from game.leases l join game.businesses b on b.id = l.business_id join game.players pl on pl.id = b.owner_id
                 where l.building_id = bl.id and l.status = 'active'),
    'npc_income_per_day', case when bl.owner_id = v_uid then
        round(game.rooms_free(bl.id) * game.room_rent(bl) * 100.0 / bl.rent_pct * bl.npc_occupancy * least(1, 100.0 / bl.rent_pct)) end
  );
end $$;

create function public.map_plots(p_city text, p_w float8, p_s float8, p_e float8, p_n float8) returns jsonb
language plpgsql stable security definer set search_path = game, pg_temp as $$
declare
  v_uid uuid := game.uid();
  c game.cities;
  a record;
  b record;
begin
  select * into c from game.cities where id = p_city;
  if not found then return '[]'::jsonb; end if;
  select * into a from game.plot_of(c, p_s, p_w);
  select * into b from game.plot_of(c, p_n, p_e);
  return jsonb_build_object(
    'owned', coalesce((select jsonb_agg(jsonb_build_object('px', pt.px, 'py', pt.py, 'owner_no', pl.player_no, 'owner_name', pl.display_name,
        'mine', pt.owner_id = v_uid, 'business_id', pt.business_id, 'for_sale_price', pt.for_sale_price,
        'kind', (select kind from game.businesses where id = pt.business_id and status in ('open', 'closed', 'depleted'))))
      from game.plots pt join game.players pl on pl.id = pt.owner_id
     where pt.city_id = p_city and pt.px between a.px - 1 and b.px + 1 and pt.py between a.py - 1 and b.py + 1), '[]'::jsonb),
    'deposits', coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'px', d.px, 'py', d.py, 'resource', d.resource,
        'units_left', d.units_left, 'units_total', d.units_total,
        'claimed', exists (select 1 from game.businesses bz where bz.deposit_id = d.id and bz.status in ('open', 'closed'))))
      from game.deposits d
     where d.city_id = p_city and d.px between a.px - 1 and b.px + 1 and d.py between a.py - 1 and b.py + 1
       and exists (select 1 from game.surveys s where s.player_id = v_uid and s.city_id = d.city_id and s.bx = d.bx and s.by = d.by)), '[]'::jsonb),
    'surveyed', coalesce((select jsonb_agg(jsonb_build_object('bx', s.bx, 'by', s.by))
      from game.surveys s where s.player_id = v_uid and s.city_id = p_city), '[]'::jsonb)
  );
end $$;

create function public.plot_info(p_city text, p_px int, p_py int) returns jsonb
language plpgsql stable security definer set search_path = game, pg_temp as $$
declare
  v_uid uuid := game.uid();
  c game.cities;
  pt game.plots;
  pc record;
begin
  select * into c from game.cities where id = p_city;
  if not found then perform game.fail('Unknown city.'); end if;
  select * into pt from game.plots where city_id = p_city and px = p_px and py = p_py;
  select * into pc from game.plot_center(c, p_px, p_py);
  return jsonb_build_object(
    'city_id', p_city, 'px', p_px, 'py', p_py, 'lat', pc.lat, 'lng', pc.lng,
    'buildable', game.plot_buildable(c, p_px, p_py),
    'coastal', game.plot_coastal(c, p_px, p_py),
    'traffic', game.traffic_at(c, pc.lat, pc.lng),
    'price', case when pt.owner_id is null then game.plot_price(c, p_px, p_py) else pt.for_sale_price end,
    'owner_name', (select display_name from game.players where id = pt.owner_id),
    'owner_no', (select player_no from game.players where id = pt.owner_id),
    'mine', pt.owner_id = v_uid,
    'for_sale_price', pt.for_sale_price,
    'bought_price', case when pt.owner_id = v_uid then pt.bought_price end,
    'business', (select game.business_json(b, b.owner_id = v_uid) from game.businesses b where b.id = pt.business_id and b.status in ('open', 'closed', 'depleted')),
    'deposit', (select jsonb_build_object('id', d.id, 'resource', d.resource, 'units_left', d.units_left, 'units_total', d.units_total)
                  from game.deposits d
                 where d.city_id = p_city and d.px = p_px and d.py = p_py
                   and exists (select 1 from game.surveys s where s.player_id = v_uid and s.city_id = d.city_id and s.bx = d.bx and s.by = d.by)),
    'surveyed', exists (select 1 from game.surveys s where s.player_id = v_uid and s.city_id = p_city and s.bx = floor(p_px / 8.0) and s.by = floor(p_py / 8.0))
  );
end $$;

create function public.buy_plot(p_city text, p_px int, p_py int, p_lat float8, p_lng float8) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
begin return game.buy_plot(game.me(), p_city, p_px, p_py, p_lat, p_lng); end $$;

create function public.build_on_plot(p_city text, p_px int, p_py int, p_kind text, p_name text, p_option text default null) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
begin return game.build_on_plot(game.me(), p_city, p_px, p_py, p_kind, p_name, p_option); end $$;

create function public.set_plot_sale(p_city text, p_px int, p_py int, p_price bigint) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
begin return game.set_plot_sale(game.me(), p_city, p_px, p_py, p_price); end $$;

create function public.buy_listed_plot(p_city text, p_px int, p_py int, p_expected_price bigint) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
begin return game.buy_listed_plot(game.me(), p_city, p_px, p_py, p_expected_price); end $$;

create function public.sell_plot_to_city(p_city text, p_px int, p_py int) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
begin return game.sell_plot_to_city(game.me(), p_city, p_px, p_py); end $$;

create function public.buy_building(p_building bigint, p_lat float8, p_lng float8, p_expected_price bigint default null) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
begin return game.buy_building(game.me(), p_building, p_lat, p_lng, p_expected_price); end $$;

create function public.set_building(p_building bigint, p_rent_pct int default null, p_name text default null, p_for_sale bigint default null) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
begin return game.set_building(game.me(), p_building, p_rent_pct, p_name, p_for_sale); end $$;

create function public.sell_building_to_city(p_building bigint) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
begin return game.sell_building_to_city(game.me(), p_building); end $$;

create function public.survey(p_lat float8, p_lng float8) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
begin return game.survey(game.me(), p_lat, p_lng); end $$;

create function public.ship(p_port bigint, p_good text, p_qty bigint, p_to text, p_kind text) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
begin return game.ship(game.me(), p_port, p_good, p_qty, p_to, p_kind); end $$;

create function public.my_property() returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me(false);
begin
  return jsonb_build_object(
    'buildings', (select coalesce(jsonb_agg(public.building_info(bl.id)), '[]'::jsonb) from game.buildings bl where bl.owner_id = p.id),
    'plots', (select coalesce(jsonb_agg(public.plot_info(pt.city_id, pt.px, pt.py)), '[]'::jsonb) from game.plots pt where pt.owner_id = p.id),
    'shipments', (select coalesce(jsonb_agg(to_jsonb(s) order by s.depart_at desc), '[]'::jsonb)
                    from (select * from game.shipments where owner_id = p.id order by depart_at desc limit 30) s),
    'export_prices', (select jsonb_object_agg(c.id, (select jsonb_object_agg(g.id, floor(g.base_price * game.import_mult(c.id, g.id))) from game.goods g))
                        from game.cities c where c.open)
  );
end $$;

-- ---------------------------------------------------------------------------
-- Exchange
-- ---------------------------------------------------------------------------
create function public.market_overview() returns jsonb
language sql stable security definer set search_path = game, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'good', g.id, 'name', g.name, 'icon', g.icon, 'category', g.category, 'base_price', g.base_price,
      'bid', (game.npc_quote(g.id)).bid, 'ask', (game.npc_quote(g.id)).ask,
      'best_bid', (select max(price) from game.orders o where o.good_id = g.id and o.side = 'buy' and o.status = 'open'),
      'best_ask', (select min(price) from game.orders o where o.good_id = g.id and o.side = 'sell' and o.status = 'open'),
      'last', coalesce(m.last_price, round(m.ref_price)),
      'ref', round(m.ref_price),
      'volume_24h', m.volume_24h,
      'change_pct', round(((m.ref_price - coalesce(
          (select c.close from game.candles c where c.good_id = g.id and c.bucket <= now() - interval '24 hours' order by c.bucket desc limit 1),
          g.base_price)) / g.base_price * 100)::numeric, 1)
    ) order by g.sort), '[]'::jsonb)
  from game.goods g join game.markets m on m.good_id = g.id
$$;

create function public.market_good(p_good text) returns jsonb
language plpgsql stable security definer set search_path = game, pg_temp as $$
declare
  v_uid uuid := game.uid();
  q record;
begin
  if not exists (select 1 from game.goods where id = p_good) then perform game.fail('Unknown good.'); end if;
  select * into q from game.npc_quote(p_good);
  return jsonb_build_object(
    'good', p_good,
    'npc', jsonb_build_object('bid', q.bid, 'ask', q.ask, 'depth', (select depth from game.goods where id = p_good)),
    'bids', (select coalesce(jsonb_agg(jsonb_build_object('price', price, 'qty', qty) order by price desc), '[]'::jsonb)
               from (select price, sum(qty - filled) qty from game.orders where good_id = p_good and side = 'buy' and status = 'open'
                      group by price order by price desc limit 12) x),
    'asks', (select coalesce(jsonb_agg(jsonb_build_object('price', price, 'qty', qty) order by price), '[]'::jsonb)
               from (select price, sum(qty - filled) qty from game.orders where good_id = p_good and side = 'sell' and status = 'open'
                      group by price order by price limit 12) x),
    'trades', (select coalesce(jsonb_agg(jsonb_build_object('price', price, 'qty', qty, 'at', at,
                  'npc', buyer_id is null or seller_id is null) order by at desc), '[]'::jsonb)
                 from (select * from game.trades where good_id = p_good order by at desc limit 25) t),
    'candles', (select coalesce(jsonb_agg(jsonb_build_object('t', bucket, 'o', open, 'h', high, 'l', low, 'c', close, 'v', volume) order by bucket), '[]'::jsonb)
                  from game.candles where good_id = p_good and bucket > now() - interval '7 days'),
    'my_orders', (select coalesce(jsonb_agg(to_jsonb(o) order by o.created_at desc), '[]'::jsonb)
                    from game.orders o where o.player_id = v_uid and o.good_id = p_good and o.status = 'open'),
    'my_stock', (select coalesce(jsonb_object_agg(city_id, qty), '{}'::jsonb) from game.storage where owner_id = v_uid and good_id = p_good and qty > 0)
  );
end $$;

-- Cost estimate for buying from / selling to market traders (no trade).
create function public.market_quote(p_good text, p_side text, p_qty bigint) returns jsonb
language plpgsql stable security definer set search_path = game, pg_temp as $$
declare
  m game.markets;
  k float8;
  x float8;
begin
  select * into m from game.markets where good_id = p_good;
  if not found or p_qty is null or p_qty <= 0 then return null; end if;
  k := game.impact_k(p_good);
  if p_side = 'buy' then
    x := game.npc_ask(m.ref_price) * (exp(k * p_qty) - 1) / k;
  else
    x := game.npc_bid(m.ref_price) * (1 - exp(-k * p_qty)) / k * (1 - game.cfg('trade_fee_pct') / 100.0);
  end if;
  return jsonb_build_object('total', round(x), 'avg', round((x / p_qty)::numeric, 2));
end $$;

create function public.place_order(p_good text, p_side text, p_qty bigint, p_price bigint default null, p_city text default null) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me();
  v jsonb;
begin
  v := game.place_order(p, p_good, p_side, p_qty, p_price, coalesce(p_city, p.city_id));
  if (v ->> 'filled')::bigint > 0 then perform game.award(p.id, 'first_trade'); end if;
  return v;
end $$;

create function public.cancel_order(p_order bigint) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
begin return game.cancel_order(game.me(), p_order); end $$;

create function public.my_orders() returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me(false);
begin
  return jsonb_build_object(
    'open', (select coalesce(jsonb_agg(to_jsonb(o) || jsonb_build_object('name', g.name, 'icon', g.icon) order by o.created_at desc), '[]'::jsonb)
               from game.orders o join game.goods g on g.id = o.good_id where o.player_id = p.id and o.status = 'open'),
    'recent', (select coalesce(jsonb_agg(to_jsonb(t) order by t.at desc), '[]'::jsonb)
                 from (select tr.id, tr.good_id, tr.price, tr.qty, tr.value, case when tr.seller_id = p.id then tr.fee else 0 end as fee, tr.at,
                              (tr.buyer_id is null or tr.seller_id is null) as npc,
                              g.name, g.icon, case when tr.buyer_id = p.id then 'buy' else 'sell' end as side
                         from game.trades tr join game.goods g on g.id = tr.good_id
                        where tr.buyer_id = p.id or tr.seller_id = p.id order by tr.at desc limit 40) t)
  );
end $$;

-- ---------------------------------------------------------------------------
-- Storage, ledger, notifications
-- ---------------------------------------------------------------------------
create function public.my_storage() returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me(false);
begin
  return coalesce((select jsonb_agg(jsonb_build_object(
      'city_id', c.id, 'city_name', c.name,
      'capacity', game.storage_capacity(p.id, c.id), 'used', game.storage_used(p.id, c.id),
      'goods', (select coalesce(jsonb_agg(jsonb_build_object('good', s.good_id, 'qty', s.qty,
                  'value', round(s.qty * game.npc_bid(m.ref_price))) order by g.sort), '[]'::jsonb)
                  from game.storage s join game.goods g on g.id = s.good_id join game.markets m on m.good_id = s.good_id
                 where s.owner_id = p.id and s.city_id = c.id and s.qty > 0)) order by c.sort)
    from game.cities c
   where c.id = p.city_id or exists (select 1 from game.storage s where s.owner_id = p.id and s.city_id = c.id and s.qty > 0)
      or exists (select 1 from game.businesses b where b.owner_id = p.id and b.city_id = c.id and b.status in ('open', 'closed'))), '[]'::jsonb);
end $$;

create function public.my_ledger(p_before bigint default null, p_kind text default null, p_limit int default 50) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me(false);
begin
  return jsonb_build_object(
    'rows', (select coalesce(jsonb_agg(jsonb_build_object('id', l.id, 'at', l.at, 'amount', l.amount, 'balance_after', l.balance_after,
               'kind', l.kind, 'label', k.label, 'memo', l.memo, 'entries', l.entries, 'hourly', l.bucket is not null) order by l.id desc), '[]'::jsonb)
               from (select * from game.ledger where player_id = p.id and (p_before is null or id < p_before)
                        and (p_kind is null or kind = p_kind)
                      order by id desc limit least(greatest(coalesce(p_limit, 50), 1), 200)) l
               join game.ledger_kinds k using (kind)),
    'today', (select coalesce(jsonb_agg(jsonb_build_object('kind', x.kind, 'label', k.label, 'amount', x.total) order by x.total desc), '[]'::jsonb)
                from (select kind, sum(amount) total from game.ledger where player_id = p.id and at > now() - interval '24 hours'
                         and kind not in ('escrow', 'escrow_return') group by kind) x join game.ledger_kinds k using (kind))
  );
end $$;

create function public.my_notifications(p_before bigint default null) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me(false);
begin
  return coalesce((select jsonb_agg(to_jsonb(n) - 'player_id' order by n.id desc)
    from (select * from game.notifications where player_id = p.id and (p_before is null or id < p_before) order by id desc limit 40) n), '[]'::jsonb);
end $$;

create function public.mark_notifications_read() returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me(false);
begin
  update game.notifications set read = true where player_id = p.id and not read;
  return jsonb_build_object('ok', true);
end $$;

create function public.my_badges() returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me(false);
begin
  return coalesce((select jsonb_agg(jsonb_build_object('badge', pb.badge_id, 'earned_at', pb.earned_at, 'note', pb.note) order by pb.earned_at)
    from game.player_badges pb where pb.player_id = p.id), '[]'::jsonb);
end $$;
