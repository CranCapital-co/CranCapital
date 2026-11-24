-- Making money: a bug fix and a much more generous economy.
--
-- 1. The bug. Each minute a cart gets a customer or two, and simulate_sales
--    shared them across the menu by rounding (customers × item share). With
--    three or more items every share rounded to 0, so nothing was ever sold:
--    "Sales today" stayed at 0. Customers are now shared with the largest
--    remainder method, so every customer is served, and those who wanted a
--    sold-out item buy something else instead of leaving.
-- 2. More income. Businesses serve about three times as many customers, menu
--    prices are three times higher (twice for furniture and electronics), and
--    ingredient prices are unchanged, so margins are much bigger. A first cart
--    on a busy street now earns about $1,000-1,400 an hour instead of
--    about $140. Farms, mines, factories and apartments produce 2.5 times as
--    much. New carts start with the new fair prices and three times the
--    starter stock.

-- ---------------------------------------------------------------------------
-- 1. Sharing customers across the menu
-- ---------------------------------------------------------------------------
create or replace function game.simulate_sales(b game.businesses, t game.business_types, c game.cities, p_dt float8,
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
  v_wsum float8 := 0;
  v_conv float8;
  v_potential float8;
  v_comp float8;
  v_share float8;
  v_demand float8;
  v_served float8;
  v_expected float8;
  v_n bigint;
  v_event float8 := 1;
  v_ids text[] := '{}';
  v_prices bigint[] := '{}';
  v_w float8[] := '{}';
  v_want bigint[] := '{}';
  v_max bigint[] := '{}';
  v_got bigint[] := '{}';
  v_k int;
  v_i int;
  v_left bigint;
  v_m bigint;
  v_order int[];
begin
  sold := 0;
  revenue := 0;
  out_of_stock := '{}';
  new_carry := b.carry;
  item_sales := '{}'::jsonb;
  if not game.is_open_hour(b.open_hour, b.close_hour, v_hour) or b.capacity <= 0 then
    return;
  end if;
  -- Which menu items can be made right now, how many, and how much
  -- customers like the price.
  for it in select * from jsonb_array_elements(v_items) loop
    select * into mi from game.menu_items where id = it ->> 'id';
    if not found then continue; end if;
    v_price := coalesce((it ->> 'price')::bigint, mi.fair_price);
    v_ok := true;
    v_m := null;
    for ing in select key good, value::bigint per from jsonb_each_text(mi.ingredients) loop
      select coalesce(qty, 0) into v_have from game.storage where owner_id = b.owner_id and city_id = b.city_id and good_id = ing.good;
      v_have := coalesce(v_have, 0);
      if v_have < ing.per then v_ok := false; end if;
      v_m := least(coalesce(v_m, v_have / ing.per), v_have / ing.per);
    end loop;
    if not v_ok then
      out_of_stock := out_of_stock || mi.id;
      continue;
    end if;
    r := v_price::float8 / mi.fair_price;
    d := case when r <= 1 then least(1.4, 1 + 0.5 * (1 - r)) else exp(-2.2 * (r - 1)) end;
    v_ids := v_ids || mi.id;
    v_prices := v_prices || v_price;
    v_w := v_w || d;
    v_max := v_max || coalesce(v_m, 0);
    v_wsum := v_wsum + d;
  end loop;
  v_k := cardinality(v_ids);
  if v_k = 0 then
    return;
  end if;
  v_conv := (v_wsum / v_k) * least(1.15, 0.85 + 0.05 * v_k) * b.attract;
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
  -- Share the customers by how well each item is priced (largest
  -- remainder, so the shares always add up to everyone).
  v_left := v_n;
  for v_i in 1 .. v_k loop
    v_want := v_want || floor(v_n * v_w[v_i] / v_wsum)::bigint;
    v_left := v_left - v_want[v_i];
  end loop;
  select array_agg(i order by (v_n * v_w[i] / v_wsum) - floor(v_n * v_w[i] / v_wsum) desc, v_w[i] desc)
    into v_order from generate_series(1, v_k) i;
  v_i := 1;
  while v_left > 0 loop
    v_want[v_order[v_i]] := v_want[v_order[v_i]] + 1;
    v_left := v_left - 1;
    v_i := v_i % v_k + 1;
  end loop;
  -- Serve what's in stock; anyone whose choice ran out picks another item.
  v_left := 0;
  for v_i in 1 .. v_k loop
    v_got := v_got || least(v_want[v_i], v_max[v_i]);
    v_left := v_left + (v_want[v_i] - v_got[v_i]);
    if v_got[v_i] < v_want[v_i] then out_of_stock := out_of_stock || v_ids[v_i]; end if;
  end loop;
  if v_left > 0 then
    select array_agg(i order by v_w[i] desc) into v_order from generate_series(1, v_k) i;
    foreach v_i in array v_order loop
      exit when v_left <= 0;
      v_m := least(v_left, v_max[v_i] - v_got[v_i]);
      if v_m > 0 then
        v_got[v_i] := v_got[v_i] + v_m;
        v_left := v_left - v_m;
      end if;
    end loop;
  end if;
  for v_i in 1 .. v_k loop
    continue when v_got[v_i] <= 0;
    select * into mi from game.menu_items where id = v_ids[v_i];
    for ing in select key good, value::bigint per from jsonb_each_text(mi.ingredients) loop
      update game.storage set qty = qty - v_got[v_i] * ing.per
       where owner_id = b.owner_id and city_id = b.city_id and good_id = ing.good;
    end loop;
    sold := sold + v_got[v_i];
    revenue := revenue + v_got[v_i] * v_prices[v_i];
    item_sales := item_sales || jsonb_build_object(v_ids[v_i], v_got[v_i]);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 2. More customers, better prices, more production
-- ---------------------------------------------------------------------------
update game.business_types set base_cph = base_cph * 3 where menu_category is not null and base_cph > 0;
update game.menu_items set fair_price = fair_price * case when category in ('furniture', 'electronics') then 2 else 3 end;
update game.business_types set rate_per_hour = rate_per_hour * 2.5
 where menu_category is null and rate_per_hour > 0 and id <> 'port';
update game.crops set per_hour = per_hour * 2.5;
update game.recipes set cycles_per_hour = cycles_per_hour * 2.5;
update game.config set value = value * 2.5 where key = 'npc_rent_per_unit';

-- Capacity: carts serve 120 / 200 / 300 customers an hour by level; staffed
-- rooms serve 2.5 times as many as before.
create or replace function game.recompute_business(p_id bigint) returns void
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
       set capacity = (array[120, 200, 300])[least(b.level, 3)],
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
                         else least(least(staff, least(30, v_slots)) * t.per_staff, v_cap) * (1 + 0.1 * (b.level - 1)) * 2.5 end,
         attract = least(1.5, 1 + 0.06 * v_decor) * (1 + 0.05 * (b.level - 1)),
         flags = case when cardinality(v_missing) > 0 then flags || jsonb_build_object('missing', to_jsonb(v_missing))
                      else flags - 'missing' end
   where id = p_id;
end $$;

-- New carts: the fair prices, and enough starter stock for a long first day.
create or replace function game.buy_cart(p game.players, p_name text, p_lat float8, p_lng float8) returns jsonb
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
          jsonb_build_object('menu', (select jsonb_agg(jsonb_build_object('id', id, 'price', fair_price) order by array_position(array['salad', 'chips', 'onigiri'], id))
                                        from game.menu_items where id in ('salad', 'chips', 'onigiri'))),
          7, 23)
  returning id into v_id;
  perform game.recompute_business(v_id);
  if v_first then
    update game.players set starter_given = true where id = p.id;
    -- Starter stock so the first sales arrive straight away (about a day).
    perform game.stock_add(p.id, c.id, 'lettuce', 1800, false);
    perform game.stock_add(p.id, c.id, 'tomato', 1200, false);
    perform game.stock_add(p.id, c.id, 'potato', 1800, false);
    perform game.stock_add(p.id, c.id, 'rice', 1200, false);
    perform game.stock_add(p.id, c.id, 'wasabi', 600, false);
  end if;
  perform game.refresh_worth(p.id);
  return jsonb_build_object('business_id', v_id, 'starter_stock', v_first);
end $$;

-- Existing menus keep their price relative to fair; capacities refresh.
update game.businesses b set settings = jsonb_set(b.settings, '{menu}', coalesce((
    select jsonb_agg(jsonb_build_object('id', m ->> 'id', 'price',
      round((m ->> 'price')::numeric * case when mi.category in ('furniture', 'electronics') then 2 else 3 end)))
      from jsonb_array_elements(b.settings -> 'menu') m left join game.menu_items mi on mi.id = m ->> 'id'), '[]'::jsonb))
 where b.settings ? 'menu';
do $$
declare
  v bigint;
begin
  for v in select id from game.businesses where status in ('open', 'closed') loop
    perform game.recompute_business(v);
  end loop;
end $$;
