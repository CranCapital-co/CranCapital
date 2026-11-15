-- CranCapital economy tick. pg_cron calls `call game.tick()` every minute.
-- Each business is simulated for the time since its last tick (at most
-- max_dt_hours), in its own transaction, so one bad row never stops the
-- world and player actions aren't blocked for long.
--
-- Offline earnings: a player's businesses keep running while they're away,
-- but only for offline_cap_hours after they were last online. After that
-- they pause (no sales, no wages, no production) until the owner returns.

create table game.state (
  key text primary key,
  ts timestamptz,
  val jsonb
);
insert into game.state (key, ts) values ('property_tick', now()), ('worth_tick', now()), ('hourly', now()), ('daily', now())
on conflict do nothing;

create table game.tick_log (
  id bigint generated always as identity primary key,
  started_at timestamptz not null,
  finished_at timestamptz not null,
  businesses int not null,
  errors int not null,
  note text
);

create table game.tick_errors (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  business_id bigint,
  message text
);

-- Customers buying from one business over dt hours. Consumes ingredients
-- from the owner's storage; returns units sold and revenue.
create function game.simulate_sales(b game.businesses, t game.business_types, c game.cities, p_dt float8,
  out sold bigint, out revenue bigint, out out_of_stock text[], out new_carry numeric, out item_sales jsonb)
language plpgsql set search_path = game, pg_temp as $$
declare
  v_hour int := extract(hour from now() at time zone c.tz)::int;
  v_dow int := extract(isodow from now() at time zone c.tz)::int;
  v_items jsonb := coalesce(b.settings -> 'menu', '[]'::jsonb);
  it jsonb;
  mi game.menu_items;
  v_price bigint;
  r float8;
  d float8;
  v_ok boolean;
  ing record;
  v_have bigint;
  v_avail jsonb := '[]'::jsonb;
  v_wsum float8 := 0;
  v_conv float8;
  v_potential float8;
  v_comp float8;
  v_share float8;
  v_demand float8;
  v_served float8;
  v_expected float8;
  v_n bigint;
  v_q bigint;
  v_left bigint;
  v_event float8 := 1;
  a jsonb;
  v_max bigint;
begin
  sold := 0;
  revenue := 0;
  out_of_stock := '{}';
  new_carry := b.carry;
  item_sales := '{}'::jsonb;
  if not game.is_open_hour(b.open_hour, b.close_hour, v_hour) or b.capacity <= 0 then
    return;
  end if;
  -- Which menu items can be made right now, and how much customers like the price.
  for it in select * from jsonb_array_elements(v_items) loop
    select * into mi from game.menu_items where id = it ->> 'id';
    if not found then continue; end if;
    v_price := coalesce((it ->> 'price')::bigint, mi.fair_price);
    v_ok := true;
    for ing in select key good, value::bigint per from jsonb_each_text(mi.ingredients) loop
      select coalesce(qty, 0) into v_have from game.storage where owner_id = b.owner_id and city_id = b.city_id and good_id = ing.good;
      if coalesce(v_have, 0) < ing.per then v_ok := false; end if;
    end loop;
    if not v_ok then
      out_of_stock := out_of_stock || mi.id;
      continue;
    end if;
    r := v_price::float8 / mi.fair_price;
    d := case when r <= 1 then least(1.4, 1 + 0.5 * (1 - r)) else exp(-2.2 * (r - 1)) end;
    v_avail := v_avail || jsonb_build_object('id', mi.id, 'price', v_price, 'w', d, 'ing', mi.ingredients);
    v_wsum := v_wsum + d;
  end loop;
  if jsonb_array_length(v_avail) = 0 then
    return;
  end if;
  v_conv := (v_wsum / jsonb_array_length(v_avail)) * least(1.15, 0.85 + 0.05 * jsonb_array_length(v_avail)) * b.attract;
  if to_regprocedure('game.event_mult(text,text)') is not null then
    execute 'select game.event_mult($1, $2)' into v_event using c.id, t.menu_category;
  end if;
  v_potential := t.base_cph * b.traffic * game.hour_factor(t.menu_category, v_hour, v_dow) * coalesce(v_event, 1);
  -- Nearby businesses of the same kind split the crowd.
  select coalesce(sum(greatest(0, 1 - game.dist_m(o.lat, o.lng, b.lat, b.lng) / game.cfg('competition_radius_m'))), 0)
    into v_comp
    from game.businesses o join game.business_types ot on ot.id = o.kind
   where o.city_id = b.city_id and o.id <> b.id and o.status = 'open' and ot.menu_category = t.menu_category
     and o.lat between b.lat - 0.0012 and b.lat + 0.0012 and o.lng between b.lng - 0.002 and b.lng + 0.002;
  v_share := 1 / (1 + 0.45 * v_comp);
  v_demand := v_potential * v_share * v_conv;
  v_served := least(v_demand, b.capacity);
  v_expected := v_served * p_dt * (0.9 + 0.2 * random()) + b.carry;
  v_n := floor(v_expected);
  new_carry := least(5, v_expected - v_n);
  if v_n <= 0 then
    return;
  end if;
  -- Share the sales across items by how well each is priced, limited by stock.
  for a in select * from jsonb_array_elements(v_avail) order by (value ->> 'w')::float8 desc loop
    v_q := round(v_n * (a ->> 'w')::float8 / v_wsum);
    v_max := null;
    for ing in select key good, value::bigint per from jsonb_each_text(a -> 'ing') loop
      select coalesce(qty, 0) into v_have from game.storage where owner_id = b.owner_id and city_id = b.city_id and good_id = ing.good;
      v_max := least(coalesce(v_max, v_have / ing.per), coalesce(v_have, 0) / ing.per);
    end loop;
    v_q := greatest(0, least(v_q, coalesce(v_max, 0), v_n - sold));
    if v_q < (round(v_n * (a ->> 'w')::float8 / v_wsum)) then
      out_of_stock := out_of_stock || (a ->> 'id');
    end if;
    if v_q > 0 then
      for ing in select key good, value::bigint per from jsonb_each_text(a -> 'ing') loop
        update game.storage set qty = qty - v_q * ing.per
         where owner_id = b.owner_id and city_id = b.city_id and good_id = ing.good;
      end loop;
      sold := sold + v_q;
      revenue := revenue + v_q * (a ->> 'price')::bigint;
      item_sales := item_sales || jsonb_build_object(a ->> 'id', v_q);
    end if;
  end loop;
end $$;

-- Simulate one business. Called in its own transaction by game.tick().
create function game.tick_business(p_id bigint) returns void
language plpgsql set search_path = game, pg_temp as $$
declare
  b game.businesses;
  t game.business_types;
  c game.cities;
  o game.players;
  l game.leases;
  bld game.buildings;
  v_dt float8;
  v_hours_since float8;
  v_day date;
  v_hour int;
  v_open boolean;
  v_dormant boolean;
  v_cost bigint;
  v_rev bigint := 0;
  v_costs bigint := 0;
  v_sold bigint := 0;
  v_prod bigint := 0;
  v_flags jsonb;
  s record;
  v_good text;
  v_rate float8;
  v_qty bigint;
  v_room bigint;
  d game.deposits;
  rc game.recipes;
  v_cycles float8;
  v_max float8;
  ing record;
  v_have bigint;
  v_diesel_need bigint;
  r record;
  v_mult numeric;
begin
  select * into b from game.businesses where id = p_id for update skip locked;
  if not found or b.status not in ('open', 'closed') then return; end if;
  select * into t from game.business_types where id = b.kind;
  select * into c from game.cities where id = b.city_id;
  select * into o from game.players where id = b.owner_id;
  v_hours_since := extract(epoch from now() - b.last_tick_at) / 3600.0;
  v_dt := least(v_hours_since, game.cfg('max_dt_hours'));
  if v_dt <= 0 then return; end if;
  v_day := (now() at time zone c.tz)::date;
  v_hour := extract(hour from now() at time zone c.tz)::int;
  v_flags := b.flags;

  -- New local day: archive yesterday's numbers.
  if b.stats_day is distinct from v_day then
    if b.stats_day is not null then
      insert into game.business_days (business_id, day, sales, revenue, costs, produced)
      values (b.id, b.stats_day, b.sales_today, b.revenue_today, b.costs_today, b.produced_today)
      on conflict (business_id, day) do update
        set sales = excluded.sales, revenue = excluded.revenue, costs = excluded.costs, produced = excluded.produced;
    end if;
    update game.businesses set stats_day = v_day, sales_today = 0, revenue_today = 0, costs_today = 0, produced_today = 0 where id = b.id;
    b.sales_today := 0; b.revenue_today := 0; b.costs_today := 0; b.produced_today := 0;
  end if;

  v_dormant := o.status in ('banned', 'deleted')
            or o.last_seen_at < now() - make_interval(hours => game.cfg('offline_cap_hours')::int);
  if v_dormant then
    update game.businesses set last_tick_at = now(), flags = flags || '{"paused":true}'::jsonb where id = b.id;
    return;
  end if;
  v_flags := v_flags - 'paused';

  -- Producers that auto-sell take their market lock first (same lock order as trading).
  if coalesce((b.settings ->> 'auto_sell')::boolean, false) then
    if t.produces = 'crop' then
      perform 1 from game.markets where good_id = b.settings ->> 'crop' for update;
    elsif t.produces = 'recipe' then
      perform 1 from game.markets m, game.recipes rr where rr.id = t.recipe and m.good_id in (select jsonb_object_keys(rr.outputs)) for update;
    elsif t.placement = 'deposit' or t.produces = 'timber' then
      perform 1 from game.markets where good_id = coalesce(t.resource, t.produces) for update;
    end if;
  end if;

  -- Running costs (all the time).
  v_cost := round(t.upkeep_per_hour * (1 + 0.5 * (b.level - 1)) * v_dt);
  if v_cost > 0 then
    if game.try_money(b.owner_id, -v_cost, 'upkeep', 'Running costs', null, true) then
      v_costs := v_costs + v_cost;
    else
      update game.businesses set status = 'closed', last_tick_at = now(), flags = v_flags || '{"unpaid_upkeep":true}'::jsonb where id = b.id;
      perform game.notify(b.owner_id, 'business', format('%s closed', b.name), 'You couldn''t cover its running costs. Add money and reopen it.',
        jsonb_build_object('business', b.id));
      return;
    end if;
  end if;

  -- Rent for rooms.
  if t.placement = 'room' then
    select * into l from game.leases where business_id = b.id and status = 'active' for update;
    if found then
      select * into bld from game.buildings where id = l.building_id;
      v_cost := round(l.rent_per_day * v_dt / 24.0) + l.unpaid;
      if bld.owner_id = b.owner_id then
        v_cost := 0;
      end if;
      if v_cost > 0 then
        if game.try_money(b.owner_id, -v_cost, 'rent', format('Rent at %s', coalesce(bld.custom_name, bld.name, 'your building')), jsonb_build_object('building', bld.id), true) then
          v_costs := v_costs + v_cost;
          if bld.owner_id is not null then
            perform game.money(bld.owner_id, v_cost, 'rent_income', 'Rent from tenants', jsonb_build_object('building', bld.id), true);
          end if;
          if l.unpaid > 0 then
            update game.leases set unpaid = 0, unpaid_since = null where id = l.id;
            v_flags := v_flags - 'rent_due';
          end if;
        else
          update game.leases set unpaid = l.unpaid + round(l.rent_per_day * v_dt / 24.0), unpaid_since = coalesce(l.unpaid_since, now())
           where id = l.id;
          v_flags := v_flags || '{"rent_due":true}'::jsonb;
          if coalesce(l.unpaid_since, now()) < now() - make_interval(days => game.cfg('eviction_days')::int) then
            update game.leases set status = 'ended', ended_at = now() where id = l.id;
            update game.businesses set status = 'abandoned', staff = 0, last_tick_at = now(), flags = v_flags || '{"evicted":true}'::jsonb where id = b.id;
            perform game.notify(b.owner_id, 'business', format('Evicted: %s', b.name),
              format('You owed rent for over %s days, so the lease ended.', game.cfg('eviction_days')), jsonb_build_object('business', b.id));
            if bld.owner_id is not null then
              perform game.notify(bld.owner_id, 'tenant', 'A tenant was evicted', format('%s left your building after not paying rent.', b.name),
                jsonb_build_object('building', bld.id));
            end if;
            return;
          end if;
        end if;
      end if;
    end if;
  end if;

  if b.status = 'closed' then
    update game.businesses set last_tick_at = now(), costs_today = costs_today + v_costs, flags = v_flags where id = b.id;
    return;
  end if;

  -- Wages: shop staff only while open; producers' crews around the clock.
  v_open := t.menu_category is null or game.is_open_hour(b.open_hour, b.close_hour, v_hour);
  if b.staff > 0 and v_open then
    v_cost := round(b.staff * c.wage_per_hour * v_dt);
    if game.try_money(b.owner_id, -v_cost, 'wages', 'Staff wages', null, true) then
      v_costs := v_costs + v_cost;
    else
      if t.placement = 'room' then
        update game.businesses set staff = 0, flags = v_flags || '{"staff_quit":true}'::jsonb where id = b.id;
        perform game.recompute_business(b.id);
        select * into b from game.businesses where id = b.id;
        v_flags := b.flags;
        perform game.notify(b.owner_id, 'business', format('Staff quit at %s', b.name), 'You couldn''t pay their wages. Hire again once you have money.',
          jsonb_build_object('business', b.id));
      else
        update game.businesses set status = 'closed', last_tick_at = now(), flags = v_flags || '{"unpaid_wages":true}'::jsonb where id = b.id;
        perform game.notify(b.owner_id, 'business', format('%s closed', b.name), 'You couldn''t pay the crew''s wages. Add money and reopen it.',
          jsonb_build_object('business', b.id));
        return;
      end if;
    end if;
  end if;

  -- Customers.
  if t.menu_category is not null then
    select * into s from game.simulate_sales(b, t, c, v_dt);
    v_sold := s.sold;
    if s.revenue > 0 then
      perform game.money(b.owner_id, s.revenue, 'sales', 'Sales to customers', null, true);
      v_rev := s.revenue;
      if b.lifetime_sales = 0 then perform game.award(b.owner_id, 'first_sale'); end if;
      perform game.push('user:' || b.owner_id::text, 'sales',
        jsonb_build_object('business', b.id, 'sold', s.sold, 'revenue', s.revenue, 'items', s.item_sales, 'lat', b.lat, 'lng', b.lng));
    end if;
    if cardinality(s.out_of_stock) > 0 then
      if not (v_flags ? 'out_of_stock') then
        perform game.notify(b.owner_id, 'stock', format('%s is running out', b.name),
          'Restock: ' || (select string_agg(name, ', ') from game.menu_items where id = any (s.out_of_stock)) || '.',
          jsonb_build_object('business', b.id));
      end if;
      v_flags := v_flags || jsonb_build_object('out_of_stock', to_jsonb(s.out_of_stock));
    else
      v_flags := v_flags - 'out_of_stock';
    end if;
    update game.businesses set carry = s.new_carry where id = b.id;
  end if;

  -- Farms and tree farms.
  if t.produces in ('crop', 'timber') then
    v_good := case when t.produces = 'crop' then b.settings ->> 'crop' else 'timber' end;
    v_rate := case when t.produces = 'crop' then (select per_hour from game.crops where good_id = v_good) else t.rate_per_hour end;
    v_qty := floor(v_rate * game.level_mult(b.level) * v_dt + b.carry);
    update game.businesses set carry = (v_rate * game.level_mult(b.level) * v_dt + b.carry) - v_qty where id = b.id;
    v_prod := v_qty;
  end if;

  -- Mines.
  if t.placement = 'deposit' then
    select * into d from game.deposits where id = b.deposit_id for update;
    v_good := t.resource;
    v_rate := t.rate_per_hour * game.level_mult(b.level);
    v_diesel_need := ceil(b.level * v_dt);
    select coalesce(qty, 0) into v_have from game.storage where owner_id = b.owner_id and city_id = b.city_id and good_id = 'diesel';
    if coalesce(v_have, 0) < v_diesel_need then
      v_flags := v_flags || '{"no_fuel":true}'::jsonb;
      v_qty := 0;
    else
      v_flags := v_flags - 'no_fuel';
      perform game.stock_add(b.owner_id, b.city_id, 'diesel', -v_diesel_need, false);
      v_qty := least(d.units_left, floor(v_rate * v_dt + b.carry));
      update game.businesses set carry = greatest(0, (v_rate * v_dt + b.carry) - v_qty) where id = b.id;
      update game.deposits set units_left = units_left - v_qty where id = d.id;
      if d.units_left - v_qty <= 0 then
        update game.businesses set status = 'depleted' where id = b.id;
        perform game.notify(b.owner_id, 'business', format('%s is worked out', b.name),
          'The deposit is empty. Sell the mine and survey for a new one.', jsonb_build_object('business', b.id));
      end if;
    end if;
    v_prod := v_qty;
  end if;

  -- Factories.
  if t.produces = 'recipe' then
    select * into rc from game.recipes where id = t.recipe;
    v_cycles := rc.cycles_per_hour * game.level_mult(b.level) * v_dt + b.carry;
    v_diesel_need := ceil(rc.diesel_per_hour * b.level * v_dt);
    if v_diesel_need > 0 then
      select coalesce(qty, 0) into v_have from game.storage where owner_id = b.owner_id and city_id = b.city_id and good_id = 'diesel';
      if coalesce(v_have, 0) < v_diesel_need then
        v_cycles := 0;
        v_flags := v_flags || '{"no_fuel":true}'::jsonb;
      else
        v_flags := v_flags - 'no_fuel';
      end if;
    end if;
    v_max := v_cycles;
    for ing in select key good, value::bigint per from jsonb_each_text(rc.inputs) loop
      select coalesce(qty, 0) into v_have from game.storage where owner_id = b.owner_id and city_id = b.city_id and good_id = ing.good;
      v_max := least(v_max, floor(coalesce(v_have, 0)::float8 / ing.per));
    end loop;
    if v_max < floor(v_cycles) and v_cycles > 0 then
      v_flags := v_flags || '{"no_inputs":true}'::jsonb;
    else
      v_flags := v_flags - 'no_inputs';
    end if;
    v_qty := floor(v_max);
    if v_qty > 0 then
      if v_diesel_need > 0 then
        perform game.stock_add(b.owner_id, b.city_id, 'diesel', -v_diesel_need, false);
      end if;
      for ing in select key good, value::bigint per from jsonb_each_text(rc.inputs) loop
        perform game.stock_add(b.owner_id, b.city_id, ing.good, -(v_qty * ing.per), false);
      end loop;
    end if;
    update game.businesses set carry = case when v_qty = floor(v_cycles) then v_cycles - v_qty else 0 end where id = b.id;
    v_prod := v_qty;
  end if;

  -- Deliver what was made: into storage, or straight to market traders.
  if v_prod > 0 then
    for r in
      select key good, value::bigint * v_prod qty from jsonb_each_text(rc.outputs) where t.produces = 'recipe'
      union all
      select v_good, v_prod where t.produces <> 'recipe' or t.produces is null
    loop
      if coalesce((b.settings ->> 'auto_sell')::boolean, false) then
        select * into s from game.npc_buy_from(b.owner_id, r.good, r.qty, null);
        v_rev := v_rev + coalesce(s.value, 0);
      else
        v_room := game.storage_capacity(b.owner_id, b.city_id) - game.storage_used(b.owner_id, b.city_id);
        if v_room < r.qty then
          v_flags := v_flags || '{"storage_full":true}'::jsonb;
        else
          v_flags := v_flags - 'storage_full';
        end if;
        if least(r.qty, v_room) > 0 then
          perform game.stock_add(b.owner_id, b.city_id, r.good, least(r.qty, v_room), false);
        end if;
      end if;
    end loop;
  end if;

  -- Apartments: local tenants pay rent.
  if t.produces = 'rent' then
    v_mult := (0.6 + 0.4 * b.traffic) * c.price_factor;
    v_cost := round(t.rate_per_hour * b.level * game.cfg('npc_rent_per_unit') * 0.85 * v_mult * v_dt / 24.0);
    if v_cost > 0 then
      perform game.money(b.owner_id, v_cost, 'npc_rent', 'Rent from local tenants', null, true);
      v_rev := v_rev + v_cost;
    end if;
  end if;

  update game.businesses
     set last_tick_at = now(),
         flags = v_flags,
         sales_today = sales_today + v_sold,
         revenue_today = revenue_today + v_rev,
         costs_today = costs_today + v_costs,
         produced_today = produced_today + v_prod,
         lifetime_sales = lifetime_sales + v_sold,
         lifetime_revenue = lifetime_revenue + v_rev
   where id = b.id;
end $$;

-- Error-catching wrapper so one broken business can't stop the tick.
create function game.tick_business_safe(p_id bigint) returns boolean
language plpgsql set search_path = game, pg_temp as $$
begin
  perform game.tick_business(p_id);
  return true;
exception when others then
  insert into game.tick_errors (business_id, message) values (p_id, sqlerrm);
  update game.businesses set last_tick_at = now() where id = p_id;
  return false;
end $$;

-- Local tenants in player-owned buildings, and property tax.
create function game.tick_property() returns void
language plpgsql set search_path = game, pg_temp as $$
declare
  v_last timestamptz;
  v_dt float8;
  bl record;
  pl record;
  v_income bigint;
  v_tax bigint;
  v_cap interval := make_interval(hours => game.cfg('offline_cap_hours')::int);
begin
  select ts into v_last from game.state where key = 'property_tick' for update;
  v_dt := least(1, extract(epoch from now() - v_last) / 3600.0);
  if v_dt < 0.01 then return; end if;
  update game.state set ts = now() where key = 'property_tick';
  for bl in
    select b.*, p.last_seen_at from game.buildings b join game.players p on p.id = b.owner_id
     where b.owner_id is not null and p.status = 'active' and p.last_seen_at > now() - v_cap
  loop
    v_income := round(greatest(0, game.rooms_free(bl.id)) * game.room_rent(bl) * 100.0 / bl.rent_pct * bl.npc_occupancy
      * least(1, 100.0 / bl.rent_pct) * v_dt / 24.0);
    if v_income > 0 then
      perform game.money(bl.owner_id, v_income, 'npc_rent', 'Rent from local tenants', jsonb_build_object('building', bl.id), true);
    end if;
    v_tax := round(coalesce(bl.bought_price, 0) * game.cfg('property_tax_pct_day') / 100.0 * v_dt / 24.0);
    if v_tax > 0 then
      perform game.try_money(bl.owner_id, -v_tax, 'tax', 'Property tax', null, true);
    end if;
  end loop;
  for pl in
    select pt.owner_id, sum(pt.bought_price) total from game.plots pt join game.players p on p.id = pt.owner_id
     where p.status = 'active' and p.last_seen_at > now() - v_cap
     group by pt.owner_id
  loop
    v_tax := round(pl.total * game.cfg('property_tax_pct_day') / 100.0 * v_dt / 24.0);
    if v_tax > 0 then
      perform game.try_money(pl.owner_id, -v_tax, 'tax', 'Property tax', null, true);
    end if;
  end loop;
end $$;

-- Every 10 minutes: net worth for recently active players.
create function game.tick_worth() returns void
language plpgsql set search_path = game, pg_temp as $$
declare
  v_last timestamptz;
  r record;
begin
  select ts into v_last from game.state where key = 'worth_tick' for update;
  if v_last > now() - interval '10 minutes' then return; end if;
  update game.state set ts = now() where key = 'worth_tick';
  for r in select id from game.players where status = 'active' and last_seen_at > now() - interval '3 days' loop
    perform game.refresh_worth(r.id);
  end loop;
  perform game.markets_stats();
end $$;

-- Housekeeping once an hour.
create function game.tick_hourly() returns void
language plpgsql set search_path = game, pg_temp as $$
declare
  v_last timestamptz;
begin
  select ts into v_last from game.state where key = 'hourly' for update;
  if v_last > now() - interval '1 hour' then return; end if;
  update game.state set ts = now() where key = 'hourly';
  delete from game.rate_buckets where updated_at < now() - interval '1 day';
  delete from game.notifications where at < now() - interval '60 days';
  delete from game.tick_errors where at < now() - interval '14 days';
  delete from game.tick_log where started_at < now() - interval '3 days';
  delete from game.candles where bucket < now() - interval '120 days';
  delete from game.trades where at < now() - interval '45 days';
  delete from game.ledger where at < now() - interval '400 days';
  if to_regprocedure('game.social_hourly()') is not null then
    execute 'select game.social_hourly()';
  end if;
end $$;

-- (No SET clause: a procedure that sets its own search_path can't commit.
-- Everything below is schema-qualified.)
create procedure game.tick()
language plpgsql as $$
declare
  v_start timestamptz := clock_timestamp();
  v_ids bigint[];
  v_id bigint;
  v_n int := 0;
  v_err int := 0;
begin
  -- Only one tick at a time (session lock: released when pg_cron's
  -- connection closes, even if something below fails).
  if not pg_try_advisory_lock(424242) then
    return;
  end if;
  select coalesce(array_agg(id order by owner_id, id), '{}') into v_ids
    from game.businesses where status in ('open', 'closed') and last_tick_at < now() - interval '15 seconds';
  commit;
  foreach v_id in array v_ids loop
    if game.tick_business_safe(v_id) then v_n := v_n + 1; else v_err := v_err + 1; end if;
    commit;
  end loop;
  perform game.tick_property();
  commit;
  perform game.deliver_shipments();
  commit;
  perform game.markets_tick();
  commit;
  if to_regprocedure('game.finance_tick()') is not null then
    execute 'select game.finance_tick()';
    commit;
  end if;
  perform game.tick_worth();
  commit;
  perform game.tick_hourly();
  insert into game.tick_log (started_at, finished_at, businesses, errors) values (v_start, clock_timestamp(), v_n, v_err);
  commit;
  perform pg_advisory_unlock(424242);
end $$;
