-- CranCapital storage and the global exchange.
--
-- Goods sit in each player's storage in a city. The exchange is one global
-- order book per good: sell orders take goods out of storage (held until
-- filled or cancelled), buy orders hold cash. Bought goods arrive in the
-- buyer's storage in the city they choose.
--
-- NPC market traders sit at the edges of every market: they always buy a
-- little below a reference price and sell a little above it, so a new
-- player can trade with nobody else online. Trading with them moves their
-- reference price (bigger trades, bigger moves), and the reference drifts
-- back toward the base price every minute. Their trades are where money
-- enters and leaves the economy; the 1% fee on every trade also leaves it.

create table game.storage (
  owner_id uuid not null references game.players(id),
  city_id text not null references game.cities(id),
  good_id text not null references game.goods(id),
  qty bigint not null default 0 check (qty >= 0),
  primary key (owner_id, city_id, good_id)
);

insert into game.config (key, value, note) values
  ('base_storage', 200000, 'Free storage per player per city, in units');

create function game.storage_capacity(p_owner uuid, p_city text) returns bigint
language plpgsql stable set search_path = game, pg_temp as $$
begin
  return game.cfg('base_storage')::bigint + coalesce((
    select sum(t.storage_capacity * b.level)
      from game.businesses b join game.business_types t on t.id = b.kind
     where b.owner_id = p_owner and b.city_id = p_city and t.produces = 'storage' and b.status in ('open', 'closed')), 0)::bigint;
end $$;

create function game.storage_used(p_owner uuid, p_city text) returns bigint
language sql stable set search_path = game, pg_temp as $$
  select coalesce(sum(qty), 0)::bigint from game.storage where owner_id = p_owner and city_id = p_city
$$;

-- Add (or with a negative qty, remove) goods. Returns the new quantity.
create function game.stock_add(p_owner uuid, p_city text, p_good text, p_qty bigint, p_check_capacity boolean default true)
returns bigint language plpgsql set search_path = game, pg_temp as $$
declare
  v_qty bigint;
begin
  if p_qty = 0 then
    return coalesce((select qty from game.storage where owner_id = p_owner and city_id = p_city and good_id = p_good), 0);
  end if;
  if p_qty > 0 and p_check_capacity
     and game.storage_used(p_owner, p_city) + p_qty > game.storage_capacity(p_owner, p_city) then
    perform game.fail(format('Your storage in %s is full. Sell goods or build a storage yard.',
      (select name from game.cities where id = p_city)));
  end if;
  if p_qty < 0 then
    update game.storage set qty = qty + p_qty
     where owner_id = p_owner and city_id = p_city and good_id = p_good and qty + p_qty >= 0
    returning qty into v_qty;
    if not found then
      perform game.fail(format('Not enough %s in storage.', (select name from game.goods where id = p_good)));
    end if;
    return v_qty;
  end if;
  insert into game.storage as s (owner_id, city_id, good_id, qty)
  values (p_owner, p_city, p_good, p_qty)
  on conflict (owner_id, city_id, good_id) do update set qty = s.qty + p_qty
  returning qty into v_qty;
  return v_qty;
end $$;

-- ---------------------------------------------------------------------------
-- Markets
-- ---------------------------------------------------------------------------
create table game.markets (
  good_id text primary key references game.goods(id),
  ref_price float8 not null,
  last_price bigint,
  last_trade_at timestamptz,
  volume_24h bigint not null default 0,
  updated_at timestamptz not null default now()
);
insert into game.markets (good_id, ref_price) select id, base_price from game.goods;

create table game.orders (
  id bigint generated always as identity primary key,
  player_id uuid not null references game.players(id),
  good_id text not null references game.goods(id),
  side text not null check (side in ('buy', 'sell')),
  price bigint not null check (price > 0),
  qty bigint not null check (qty > 0),
  filled bigint not null default 0,
  city_id text not null references game.cities(id),
  escrow bigint not null default 0,
  status text not null default 'open' check (status in ('open', 'filled', 'cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index orders_book_idx on game.orders (good_id, side, price, created_at) where status = 'open';
create index orders_player_idx on game.orders (player_id, status, created_at desc);

create table game.trades (
  id bigint generated always as identity primary key,
  good_id text not null references game.goods(id),
  price bigint not null,
  qty bigint not null,
  value bigint not null,
  fee bigint not null default 0,
  buyer_id uuid references game.players(id),
  seller_id uuid references game.players(id),
  at timestamptz not null default now()
);
create index trades_good_idx on game.trades (good_id, at desc);
create index trades_at_idx on game.trades (at);
create index trades_buyer_idx on game.trades (buyer_id, at desc);
create index trades_seller_idx on game.trades (seller_id, at desc);

create table game.candles (
  good_id text not null references game.goods(id),
  bucket timestamptz not null,
  open bigint not null,
  high bigint not null,
  low bigint not null,
  close bigint not null,
  volume bigint not null default 0,
  primary key (good_id, bucket)
);

create function game.candle(p_good text, p_price bigint, p_volume bigint)
returns void language sql set search_path = game, pg_temp as $$
  insert into game.candles as c (good_id, bucket, open, high, low, close, volume)
  values (p_good, date_trunc('hour', now()), p_price, p_price, p_price, p_price, p_volume)
  on conflict (good_id, bucket) do update
    set high = greatest(c.high, excluded.high),
        low = least(c.low, excluded.low),
        close = excluded.close,
        volume = c.volume + excluded.volume
$$;

-- Reference prices stay within 1/20 and 20x of base.
create function game.clamp_ref(p_good text, p_ref float8) returns float8
language sql stable set search_path = game, pg_temp as $$
  select least(greatest(p_ref, base_price / 20.0), base_price * 20.0) from game.goods where id = p_good
$$;

-- Price impact constant: trading `depth` units moves the reference ~10%.
create function game.impact_k(p_good text) returns float8
language sql stable set search_path = game, pg_temp as $$
  select ln(1.1) / depth from game.goods where id = p_good
$$;

create function game.npc_bid(p_ref float8) returns float8
language sql stable set search_path = game, pg_temp as $$
  select p_ref * (1 - game.cfg('npc_spread_pct') / 200.0)
$$;

create function game.npc_ask(p_ref float8) returns float8
language sql stable set search_path = game, pg_temp as $$
  select p_ref * (1 + game.cfg('npc_spread_pct') / 200.0)
$$;

-- Current NPC quotes for display (per unit, mills).
create function game.npc_quote(p_good text, out bid bigint, out ask bigint)
language sql stable set search_path = game, pg_temp as $$
  select greatest(1, floor(game.npc_bid(ref_price)))::bigint, greatest(1, ceil(game.npc_ask(ref_price)))::bigint
    from game.markets where good_id = p_good
$$;

-- Record a trade: trades row, candle, market stats.
create function game.record_trade(p_good text, p_price bigint, p_qty bigint, p_value bigint, p_fee bigint, p_buyer uuid, p_seller uuid)
returns void language plpgsql set search_path = game, pg_temp as $$
begin
  insert into game.trades (good_id, price, qty, value, fee, buyer_id, seller_id)
  values (p_good, p_price, p_qty, p_value, p_fee, p_buyer, p_seller);
  perform game.candle(p_good, p_price, p_qty);
  update game.markets set last_price = p_price, last_trade_at = now(), volume_24h = volume_24h + p_qty, updated_at = now()
   where good_id = p_good;
end $$;

-- Pay a seller for p_value worth of goods, minus the exchange fee.
create function game.pay_seller(p_seller uuid, p_good text, p_qty bigint, p_value bigint, p_kind text)
returns bigint language plpgsql set search_path = game, pg_temp as $$
declare
  v_fee bigint := round(p_value * game.cfg('trade_fee_pct') / 100.0);
  v_name text := (select name from game.goods where id = p_good);
begin
  perform game.money(p_seller, p_value, p_kind, format('Sold %s %s', p_qty, v_name),
    jsonb_build_object('good', p_good, 'qty', p_qty));
  if v_fee > 0 then
    perform game.money(p_seller, -v_fee, 'fee', format('1%% fee on %s %s', p_qty, v_name),
      jsonb_build_object('good', p_good, 'qty', p_qty));
  end if;
  return v_fee;
end $$;

-- Buy from market traders up to p_qty units without paying more than
-- p_max_unit for the marginal unit. Returns units bought and total cost.
-- The caller must hold the market row lock.
create function game.npc_sell_to(p_player uuid, p_good text, p_qty bigint, p_max_unit float8, p_city text, p_check_capacity boolean default true,
  out bought bigint, out cost bigint)
language plpgsql set search_path = game, pg_temp as $$
declare
  m game.markets;
  k float8 := game.impact_k(p_good);
  ask0 float8;
  q bigint := p_qty;
begin
  bought := 0;
  cost := 0;
  select * into m from game.markets where good_id = p_good;
  ask0 := game.npc_ask(m.ref_price);
  if p_max_unit is not null then
    if p_max_unit < ask0 then
      return;
    end if;
    q := least(q, floor(ln(p_max_unit / ask0) / k)::bigint);
  end if;
  -- Never move the price more than e^5 in one trade (also avoids overflow).
  q := least(q, floor(5 / k)::bigint);
  if q <= 0 then
    return;
  end if;
  cost := ceil(ask0 * (exp(k * q) - 1) / k)::bigint;
  bought := q;
  perform game.money(p_player, -cost, 'npc_trade_buy',
    format('Bought %s %s from market traders', q, (select name from game.goods where id = p_good)),
    jsonb_build_object('good', p_good, 'qty', q));
  perform game.stock_add(p_player, p_city, p_good, q, p_check_capacity);
  update game.markets set ref_price = game.clamp_ref(p_good, ref_price * exp(k * q)) where good_id = p_good;
  perform game.record_trade(p_good, greatest(1, round(cost::numeric / q))::bigint, q, cost, 0, p_player, null);
end $$;

-- Sell to market traders up to p_qty units, not accepting less than
-- p_min_unit for the marginal unit. Goods must already be out of storage.
-- Returns units sold and value received (before fee).
create function game.npc_buy_from(p_player uuid, p_good text, p_qty bigint, p_min_unit float8, p_kind text default 'npc_trade_sell',
  out sold bigint, out value bigint)
language plpgsql set search_path = game, pg_temp as $$
declare
  m game.markets;
  k float8 := game.impact_k(p_good);
  bid0 float8;
  q bigint := p_qty;
  v_fee bigint;
begin
  sold := 0;
  value := 0;
  select * into m from game.markets where good_id = p_good;
  bid0 := game.npc_bid(m.ref_price);
  if p_min_unit is not null then
    if p_min_unit > bid0 then
      return;
    end if;
    q := least(q, floor(ln(bid0 / greatest(p_min_unit, 1e-9)) / k)::bigint);
  end if;
  q := least(q, floor(5 / k)::bigint);
  if q <= 0 then
    return;
  end if;
  value := floor(bid0 * (1 - exp(-k * q)) / k)::bigint;
  sold := q;
  v_fee := game.pay_seller(p_player, p_good, q, value, p_kind);
  update game.markets set ref_price = game.clamp_ref(p_good, ref_price * exp(-k * q)) where good_id = p_good;
  perform game.record_trade(p_good, greatest(1, round(value::numeric / q))::bigint, q, value, v_fee, null, p_player);
end $$;

-- ---------------------------------------------------------------------------
-- Filling resting orders. A resting sell order already holds its goods; a
-- resting buy order already holds its cash (escrow).
-- ---------------------------------------------------------------------------

-- p_taker buys p_qty from resting sell order o, goods to p_city.
create function game.fill_sell_order(p_taker uuid, o game.orders, p_qty bigint, p_city text)
returns bigint language plpgsql set search_path = game, pg_temp as $$
declare
  v_val bigint := p_qty * o.price;
  v_fee bigint;
  v_name text := (select name from game.goods where id = o.good_id);
begin
  perform game.money(p_taker, -v_val, 'trade_buy', format('Bought %s %s', p_qty, v_name),
    jsonb_build_object('good', o.good_id, 'qty', p_qty, 'order', o.id));
  perform game.stock_add(p_taker, p_city, o.good_id, p_qty);
  v_fee := game.pay_seller(o.player_id, o.good_id, p_qty, v_val, 'trade_sell');
  update game.orders set filled = filled + p_qty, updated_at = now(),
         status = case when filled + p_qty >= qty then 'filled' else 'open' end
   where id = o.id;
  perform game.record_trade(o.good_id, o.price, p_qty, v_val, v_fee, p_taker, o.player_id);
  perform game.push('user:' || o.player_id::text, 'order', jsonb_build_object('order', o.id, 'filled', p_qty, 'good', o.good_id));
  return v_val;
end $$;

-- p_taker sells p_qty (already out of their storage) into resting buy order o.
create function game.fill_buy_order(p_taker uuid, o game.orders, p_qty bigint)
returns bigint language plpgsql set search_path = game, pg_temp as $$
declare
  v_val bigint := p_qty * o.price;
  v_fee bigint;
  v_name text := (select name from game.goods where id = o.good_id);
begin
  -- Release the buyer's held cash and spend it, so their ledger reads as a purchase.
  perform game.money(o.player_id, v_val, 'escrow_return', 'Buy order filled', jsonb_build_object('order', o.id));
  perform game.money(o.player_id, -v_val, 'trade_buy', format('Bought %s %s', p_qty, v_name),
    jsonb_build_object('good', o.good_id, 'qty', p_qty, 'order', o.id));
  perform game.stock_add(o.player_id, o.city_id, o.good_id, p_qty, false);
  v_fee := game.pay_seller(p_taker, o.good_id, p_qty, v_val, 'trade_sell');
  update game.orders set filled = filled + p_qty, escrow = escrow - v_val, updated_at = now(),
         status = case when filled + p_qty >= qty then 'filled' else 'open' end
   where id = o.id;
  perform game.record_trade(o.good_id, o.price, p_qty, v_val, v_fee, o.player_id, p_taker);
  perform game.push('user:' || o.player_id::text, 'order', jsonb_build_object('order', o.id, 'filled', p_qty, 'good', o.good_id));
  return v_val;
end $$;

-- ---------------------------------------------------------------------------
-- Placing orders. Matching is price-time priority across player orders and
-- the market traders. Market orders (no price) fill immediately and return
-- any rest; limit orders rest in the book for the unfilled part.
-- ---------------------------------------------------------------------------
create function game.place_order(p game.players, p_good text, p_side text, p_qty bigint, p_price bigint, p_city text)
returns jsonb language plpgsql set search_path = game, pg_temp as $$
declare
  g game.goods;
  v_ref float8;
  remaining bigint := p_qty;
  limit_price float8;
  o game.orders;
  has_o boolean;
  take bigint;
  val bigint;
  r record;
  cap float8;
  filled_qty bigint := 0;
  filled_value bigint := 0;
  v_order_id bigint;
  safety int := 0;
begin
  select * into g from game.goods where id = p_good;
  if not found then perform game.fail('Unknown good.'); end if;
  if p_side is null or p_side not in ('buy', 'sell') then perform game.fail('Choose buy or sell.'); end if;
  if p_qty is null or p_qty <= 0 or p_qty > 100000000 then perform game.fail('Enter a quantity between 1 and 100,000,000.'); end if;
  if p_price is not null and (p_price <= 0 or p_price > 10000000000) then perform game.fail('That price isn''t allowed.'); end if;
  if not exists (select 1 from game.cities where id = p_city) then perform game.fail('Unknown city.'); end if;
  perform game.rate_limit(p.id::text, 'order', 30, 60);

  -- Serialize all matching for this good.
  select ref_price into v_ref from game.markets where good_id = p_good for update;

  if p_side = 'buy' then
    -- A market buy pays at most 25% over the traders' current ask.
    limit_price := coalesce(p_price::float8, game.npc_ask(v_ref) * 1.25);
    loop
      safety := safety + 1;
      exit when remaining <= 0 or safety > 1000;
      select * into o from game.orders
       where good_id = p_good and side = 'sell' and status = 'open' and player_id <> p.id and price <= limit_price
       order by price, created_at limit 1 for update;
      has_o := found;
      select ref_price into v_ref from game.markets where good_id = p_good;
      if has_o and o.price <= game.npc_ask(v_ref) then
        take := least(remaining, o.qty - o.filled);
        val := game.fill_sell_order(p.id, o, take, p_city);
        remaining := remaining - take; filled_qty := filled_qty + take; filled_value := filled_value + val;
        continue;
      end if;
      cap := case when has_o then least(limit_price, o.price::float8) else limit_price end;
      select * into r from game.npc_sell_to(p.id, p_good, remaining, cap, p_city);
      if r.bought > 0 then
        remaining := remaining - r.bought; filled_qty := filled_qty + r.bought; filled_value := filled_value + r.cost;
      elsif has_o then
        -- Traders can't beat the next player order by even one unit: take it.
        take := least(remaining, o.qty - o.filled);
        val := game.fill_sell_order(p.id, o, take, p_city);
        remaining := remaining - take; filled_qty := filled_qty + take; filled_value := filled_value + val;
      else
        exit;
      end if;
    end loop;
    if remaining > 0 and p_price is not null then
      val := remaining * p_price;
      perform game.money(p.id, -val, 'escrow', format('Buy order: %s %s at %s', remaining, g.name, game.fmt(p_price)),
        jsonb_build_object('good', p_good, 'qty', remaining, 'price', p_price));
      insert into game.orders (player_id, good_id, side, price, qty, filled, city_id, escrow)
      values (p.id, p_good, 'buy', p_price, p_qty, filled_qty, p_city, val) returning id into v_order_id;
    end if;
  else
    perform game.stock_add(p.id, p_city, p_good, -p_qty);
    -- A market sell accepts at most 25% under the traders' current bid.
    limit_price := coalesce(p_price::float8, game.npc_bid(v_ref) * 0.75);
    loop
      safety := safety + 1;
      exit when remaining <= 0 or safety > 1000;
      select * into o from game.orders
       where good_id = p_good and side = 'buy' and status = 'open' and player_id <> p.id and price >= limit_price
       order by price desc, created_at limit 1 for update;
      has_o := found;
      select ref_price into v_ref from game.markets where good_id = p_good;
      if has_o and o.price >= game.npc_bid(v_ref) then
        take := least(remaining, o.qty - o.filled);
        val := game.fill_buy_order(p.id, o, take);
        remaining := remaining - take; filled_qty := filled_qty + take; filled_value := filled_value + val;
        continue;
      end if;
      cap := case when has_o then greatest(limit_price, o.price::float8) else limit_price end;
      select * into r from game.npc_buy_from(p.id, p_good, remaining, cap);
      if r.sold > 0 then
        remaining := remaining - r.sold; filled_qty := filled_qty + r.sold; filled_value := filled_value + r.value;
      elsif has_o then
        take := least(remaining, o.qty - o.filled);
        val := game.fill_buy_order(p.id, o, take);
        remaining := remaining - take; filled_qty := filled_qty + take; filled_value := filled_value + val;
      else
        exit;
      end if;
    end loop;
    if remaining > 0 then
      if p_price is not null then
        insert into game.orders (player_id, good_id, side, price, qty, filled, city_id)
        values (p.id, p_good, 'sell', p_price, p_qty, filled_qty, p_city) returning id into v_order_id;
      else
        perform game.stock_add(p.id, p_city, p_good, remaining, false);
      end if;
    end if;
  end if;

  return jsonb_build_object(
    'filled', filled_qty,
    'value', filled_value,
    'avg_price', case when filled_qty > 0 then round(filled_value::numeric / filled_qty, 2) end,
    'resting', case when v_order_id is not null then remaining else 0 end,
    'order_id', v_order_id,
    'unfilled', case when v_order_id is null then remaining else 0 end
  );
end $$;

create function game.cancel_order(p game.players, p_order bigint) returns jsonb
language plpgsql set search_path = game, pg_temp as $$
declare
  o game.orders;
  v_good text;
  left_qty bigint;
begin
  -- Same lock order as matching: market first, then the order.
  select good_id into v_good from game.orders where id = p_order and player_id = p.id;
  if not found then perform game.fail('Order not found.'); end if;
  perform 1 from game.markets where good_id = v_good for update;
  select * into o from game.orders where id = p_order for update;
  if o.status <> 'open' then perform game.fail('That order is already closed.'); end if;
  left_qty := o.qty - o.filled;
  if o.side = 'buy' then
    if o.escrow > 0 then
      perform game.money(p.id, o.escrow, 'escrow_return', 'Cancelled buy order', jsonb_build_object('order', o.id));
    end if;
  else
    perform game.stock_add(p.id, o.city_id, o.good_id, left_qty, false);
  end if;
  update game.orders set status = 'cancelled', escrow = 0, updated_at = now() where id = o.id;
  return jsonb_build_object('cancelled', o.id, 'returned_qty', case when o.side = 'sell' then left_qty else 0 end,
    'returned_cash', case when o.side = 'buy' then o.escrow else 0 end);
end $$;

-- Market traders sweep resting player orders their quotes have crossed,
-- trading with the same price impact as any other trade and only as far as
-- each order's limit; then the reference price drifts back toward base.
-- Called once per good per tick, each in its own transaction.
create function game.market_tick_good(p_good text) returns void
language plpgsql set search_path = game, pg_temp as $$
declare
  g game.goods;
  o game.orders;
  r record;
  v_ref float8;
  v_take bigint;
  v_release bigint;
  i int := 0;
  rev float8 := game.cfg('npc_reversion_per_tick');
begin
  select * into g from game.goods where id = p_good;
  select ref_price into v_ref from game.markets where good_id = p_good for update;
  loop
    i := i + 1;
    exit when i > 50;
    select ref_price into v_ref from game.markets where good_id = p_good;
    -- Sell orders at or under the traders' bid.
    select * into o from game.orders
     where good_id = p_good and side = 'sell' and status = 'open' and price <= game.npc_bid(v_ref)
     order by price, created_at limit 1 for update;
    if found then
      select * into r from game.npc_buy_from(o.player_id, p_good, o.qty - o.filled, o.price::float8);
      if r.sold > 0 then
        update game.orders set filled = filled + r.sold, updated_at = now(),
               status = case when filled + r.sold >= qty then 'filled' else 'open' end where id = o.id;
        perform game.notify(o.player_id, 'order', format('Sold %s %s', r.sold, g.name),
          format('Market traders bought from your sell order for %s.', game.fmt(r.value)), jsonb_build_object('order', o.id));
        continue;
      end if;
    end if;
    -- Buy orders at or over the traders' ask.
    select * into o from game.orders
     where good_id = p_good and side = 'buy' and status = 'open' and price >= game.npc_ask(v_ref)
     order by price desc, created_at limit 1 for update;
    exit when not found;
    v_take := least(o.qty - o.filled, floor(ln(o.price / game.npc_ask(v_ref)) / game.impact_k(p_good))::bigint, floor(5 / game.impact_k(p_good))::bigint);
    exit when v_take <= 0;
    -- Release the held cash for these units; the traders charge the real cost (never more).
    v_release := v_take * o.price;
    perform game.money(o.player_id, v_release, 'escrow_return', 'Buy order filled', jsonb_build_object('order', o.id));
    select * into r from game.npc_sell_to(o.player_id, p_good, v_take, o.price::float8, o.city_id, false);
    update game.orders set filled = filled + r.bought, escrow = escrow - v_release, updated_at = now(),
           status = case when filled + r.bought >= qty then 'filled' else 'open' end where id = o.id;
    if r.bought < v_take then
      -- Put back the escrow for units that weren't bought.
      perform game.money(o.player_id, -((v_take - r.bought) * o.price), 'escrow', 'Buy order still open', jsonb_build_object('order', o.id));
      update game.orders set escrow = escrow + (v_take - r.bought) * o.price where id = o.id;
    end if;
    perform game.notify(o.player_id, 'order', format('Bought %s %s', r.bought, g.name),
      format('Market traders filled your buy order for %s.', game.fmt(r.cost)), jsonb_build_object('order', o.id));
    exit when r.bought = 0;
  end loop;
  update game.markets
     set ref_price = game.clamp_ref(p_good, ref_price + (g.base_price - ref_price) * rev), updated_at = now()
   where good_id = p_good;
  insert into game.candles (good_id, bucket, open, high, low, close, volume)
  select good_id, date_trunc('hour', now()), round(ref_price), round(ref_price), round(ref_price), round(ref_price), 0
    from game.markets where good_id = p_good
  on conflict (good_id, bucket) do nothing;
end $$;

-- All goods in one go (tests and manual runs); the tick does one good per transaction.
create function game.markets_tick() returns void
language plpgsql set search_path = game, pg_temp as $$
declare
  g record;
begin
  for g in select id from game.goods order by id loop
    perform game.market_tick_good(g.id);
  end loop;
end $$;

-- Rolling 24h volume, recomputed every few minutes.
create function game.markets_stats() returns void
language sql set search_path = game, pg_temp as $$
  update game.markets m set volume_24h = coalesce((
    select sum(qty) from game.trades t where t.good_id = m.good_id and t.at > now() - interval '24 hours'), 0)
$$;
