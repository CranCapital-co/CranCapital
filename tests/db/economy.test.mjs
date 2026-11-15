// Phase 2 and 3 economy, tested end to end through the real API.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  db, q, one, newPlayer, rpc, rpcError, streetNear, setLocalHour, runTickAfter, ledgerMismatches, anonClient,
} from './helpers.mjs';

before(async () => {
  await setLocalHour('london', 12);
});

after(async () => {
  await db.end();
});

test('new players get a profile, starting money and a ledger entry', async () => {
  const { client, me } = await newPlayer('Start');
  assert.equal(me.cash, 10000000);
  assert.ok(me.player_no > 0);
  const led = await rpc(client, 'my_ledger');
  assert.equal(led.rows[0].kind, 'start_grant');
  assert.equal(led.rows[0].amount, 10000000);
  const again = await rpcError(client, 'create_player', { p_name: 'Another', p_age_ok: true });
  assert.match(again, /already have a player/);
});

test('players under 13 and bad names are refused', async () => {
  const { signIn } = await import('./helpers.mjs');
  const c = await signIn(`young${Date.now()}@example.com`);
  assert.match(await rpcError(c, 'create_player', { p_name: 'Kiddo', p_age_ok: false }), /13 or over/);
  assert.match(await rpcError(c, 'create_player', { p_name: 'ab', p_age_ok: true }), /3 to 20/);
  assert.match(await rpcError(c, 'create_player', { p_name: 'visit www.x.com', p_age_ok: true }), /letters, numbers/i);
});

test('buying a cart on a street, first sales, ledger stays exact', async () => {
  const { client, id } = await newPlayer('Cart');
  const city = await one(`select * from game.cities where id = 'london'`);
  const spot = await streetNear('london', city.start_lat, city.start_lng);
  // Inside a building is refused.
  const bld = await one(`select lat, lng from game.buildings where city_id = 'london' and footprint_m2 > 3000
                          order by game.dist_m(lat, lng, $1, $2) limit 1`, [city.start_lat, city.start_lng]);
  const inside = await rpcError(client, 'buy_cart', { p_name: 'Nope', p_lat: bld.lat, p_lng: bld.lng });
  assert.ok(inside, 'placing far away or inside a building must fail');

  const res = await rpc(client, 'buy_cart', { p_name: 'Salad Days', p_lat: spot.lat, p_lng: spot.lng });
  assert.ok(res.business_id);
  assert.equal(res.starter_stock, true);
  const me = await rpc(client, 'get_me');
  assert.equal(me.cash, 5000000);

  await runTickAfter([res.business_id], 1);
  const biz = await rpc(client, 'business_detail', { p_id: res.business_id });
  assert.ok(biz.sales_today > 0, 'a lunchtime cart sells within an hour');
  assert.ok(biz.revenue_today > 0);
  const me2 = await rpc(client, 'get_me');
  assert.ok(me2.cash > 5000000 - 10000, 'cash went up from sales (minus upkeep)');
  assert.deepEqual(await ledgerMismatches(), []);
  const badge = await one(`select 1 as ok from game.player_badges where player_id = $1 and badge_id = 'first_sale'`, [id]);
  assert.ok(badge);
});

test('carts cannot teleport across the city', async () => {
  const { client } = await newPlayer('Teleport');
  const far = await streetNear('london', 51.522, -0.08);
  const err = await rpcError(client, 'buy_cart', { p_name: 'Far', p_lat: far.lat, p_lng: far.lng });
  assert.match(err, /Walk to that spot/);
});

test('menus: prices and items are validated', async () => {
  const { client } = await newPlayer('Menu');
  const city = await one(`select * from game.cities where id = 'london'`);
  const spot = await streetNear('london', city.start_lat, city.start_lng, 40);
  const { business_id } = await rpc(client, 'buy_cart', { p_name: 'Menu Test', p_lat: spot.lat, p_lng: spot.lng });
  assert.match(await rpcError(client, 'set_menu', { p_id: business_id, p_menu: [{ id: 'pasta', price: 14000 }] }), /can't be sold here/);
  assert.match(await rpcError(client, 'set_menu', { p_id: business_id, p_menu: [{ id: 'salad', price: 1 }] }), /between/);
  assert.match(
    await rpcError(client, 'set_menu', { p_id: business_id, p_menu: ['salad', 'wrap', 'chips', 'soup'].map((id) => ({ id, price: 4000 })) }),
    /up to 3/
  );
  const ok = await rpc(client, 'set_menu', { p_id: business_id, p_menu: [{ id: 'salad', price: 4500 }, { id: 'chips', price: 3000 }] });
  assert.equal(ok.menu.length, 2);
  // Someone else can't touch it.
  const other = await newPlayer('Other');
  assert.match(await rpcError(other.client, 'set_menu', { p_id: business_id, p_menu: [] }), /isn't yours/);
  assert.match(await rpcError(other.client, 'sell_business', { p_id: business_id }), /isn't yours/);
});

test('exchange: market traders, limit orders, matching between players, fees', async () => {
  const a = await newPlayer('Buyer');
  const b = await newPlayer('Seller');
  // Market buy from traders.
  const buy = await rpc(a.client, 'place_order', { p_good: 'tomato', p_side: 'buy', p_qty: 1000 });
  assert.equal(buy.filled, 1000);
  assert.ok(buy.value > 120 * 1000 && buy.value < 160 * 1000, `paid ${buy.value}`);
  // Seller gets goods and lists them with a limit price inside the traders' spread.
  await rpc(b.client, 'place_order', { p_good: 'potato', p_side: 'buy', p_qty: 500 });
  const mk = await rpc(b.client, 'market_good', { p_good: 'potato' });
  const mid = Math.round((mk.npc.bid + mk.npc.ask) / 2);
  const sell = await rpc(b.client, 'place_order', { p_good: 'potato', p_side: 'sell', p_qty: 500, p_price: mid });
  assert.equal(sell.resting, 500);
  const before = (await rpc(b.client, 'get_me')).cash;
  // Buyer lifts the seller's order (cheaper than traders' ask).
  const take = await rpc(a.client, 'place_order', { p_good: 'potato', p_side: 'buy', p_qty: 200, p_price: mid });
  assert.equal(take.filled, 200);
  assert.equal(take.value, 200 * mid);
  const after_ = (await rpc(b.client, 'get_me')).cash;
  const fee = Math.round(200 * mid * 0.01);
  assert.equal(after_ - before, 200 * mid - fee, 'seller paid minus 1% fee');
  // Cancel returns the rest to storage.
  const orders = await rpc(b.client, 'my_orders');
  const open = orders.open.find((o) => o.good_id === 'potato');
  const c = await rpc(b.client, 'cancel_order', { p_order: open.id });
  assert.equal(c.returned_qty, 300);
  // Can't sell what you don't have, or a negative amount.
  assert.match(await rpcError(a.client, 'place_order', { p_good: 'coal', p_side: 'sell', p_qty: 5 }), /Not enough Coal/);
  assert.match(await rpcError(a.client, 'place_order', { p_good: 'coal', p_side: 'buy', p_qty: -5 }), /quantity/);
  assert.match(await rpcError(a.client, 'place_order', { p_good: 'coal', p_side: 'buy', p_qty: 99999999 }), /Not enough money/);
  assert.deepEqual(await ledgerMismatches(), []);
});

test('resting buy order gets filled by market traders when price comes to it', async () => {
  const a = await newPlayer('Rester');
  const m = await rpc(a.client, 'market_good', { p_good: 'wheat' });
  const r = await rpc(a.client, 'place_order', { p_good: 'wheat', p_side: 'buy', p_qty: 1000, p_price: m.npc.bid });
  assert.equal(r.resting, 1000);
  // Push the traders' ask down to the order by selling lots of wheat as another player.
  await q(`update game.markets set ref_price = $1 / 1.1 where good_id = 'wheat'`, [m.npc.bid]);
  await q('call game.tick()');
  const orders = await rpc(a.client, 'my_orders');
  assert.equal(orders.open.filter((o) => o.good_id === 'wheat').length, 0, 'order filled');
  const st = await rpc(a.client, 'my_storage');
  const london = st.find((s) => s.city_id === 'london');
  assert.equal(london.goods.find((g) => g.good === 'wheat').qty, 1000);
  assert.deepEqual(await ledgerMismatches(), []);
  await q(`update game.markets set ref_price = 50 where good_id = 'wheat'`);
});

test('direct table access and hidden functions are blocked', async () => {
  const { client } = await newPlayer('Hacker');
  // The game schema isn't exposed by the API.
  const { error: e1 } = await client.schema('game').from('players').select('*');
  assert.ok(e1, 'game schema must not be reachable');
  const { error: e2 } = await client.from('players').select('*');
  assert.ok(e2, 'no public players table');
  // Internal functions can't be called.
  const { error: e3 } = await client.rpc('money', { p_player: '00000000-0000-0000-0000-000000000000', p_amount: 1, p_kind: 'admin' });
  assert.ok(e3);
  // Anonymous visitors can read the landing stats but not act.
  const anon = anonClient();
  const stats = await rpc(anon, 'world_stats');
  assert.ok(stats.players_total > 0);
  const { error: e4 } = await anon.rpc('buy_cart', { p_name: 'x', p_lat: 0, p_lng: 0 });
  assert.ok(e4);
});

test('rooms: rent, fit-out, staff, sales and rent payments', async () => {
  const { client, id } = await newPlayer('Chef');
  await q('update game.players set tier = 2 where id = $1', [id]);
  await q(`select game.money($1, 50000000, 'admin', 'test funds')`, [id]);
  const bld = await one(`select b.* from game.buildings b, game.cities c where c.id = 'london' and b.city_id = 'london' and not b.landmark
                          and b.rooms_total > 2 order by game.dist_m(b.lat, b.lng, c.start_lat, c.start_lng) limit 1`);
  await q('update game.players set lat = $2, lng = $3, pos_at = now() where id = $1', [id, bld.lat, bld.lng]);
  const r = await rpc(client, 'rent_room', { p_building: bld.id, p_kind: 'restaurant', p_name: 'Testaurant', p_lat: bld.lat, p_lng: bld.lng });
  assert.ok(r.business_id);
  let biz = await rpc(client, 'business_detail', { p_id: r.business_id });
  assert.equal(biz.capacity, 0);
  assert.ok(biz.flags.missing.length >= 1, 'needs a counter and kitchen');
  await rpc(client, 'set_fitout', { p_id: r.business_id, p_items: ['counter', 'kitchen', 'table4', 'table4', 'plant'] });
  await rpc(client, 'set_staff', { p_id: r.business_id, p_staff: 4 });
  await rpc(client, 'set_menu', { p_id: r.business_id, p_menu: [{ id: 'pasta', price: 14000 }, { id: 'potato_bake', price: 12000 }] });
  await rpc(client, 'set_hours', { p_id: r.business_id, p_open: 0, p_close: 24 });
  await rpc(client, 'place_order', { p_good: 'flour', p_side: 'buy', p_qty: 2000 });
  await rpc(client, 'place_order', { p_good: 'tomato', p_side: 'buy', p_qty: 4000 });
  await rpc(client, 'place_order', { p_good: 'potato', p_side: 'buy', p_qty: 2000 });
  biz = await rpc(client, 'business_detail', { p_id: r.business_id });
  assert.ok(biz.capacity > 0, `capacity ${biz.capacity}`);
  await runTickAfter([r.business_id], 1);
  biz = await rpc(client, 'business_detail', { p_id: r.business_id });
  assert.ok(biz.sales_today > 0, 'restaurant sold at lunch');
  const led = await rpc(client, 'my_ledger');
  const kinds = new Set(led.rows.map((x) => x.kind));
  for (const k of ['rent', 'wages', 'sales', 'fitout', 'purchase']) assert.ok(kinds.has(k), `ledger has ${k}`);
  assert.deepEqual(await ledgerMismatches(), []);
});

test('offline cap: businesses pause 24 hours after the owner was last seen', async () => {
  const { client, id } = await newPlayer('Sleeper');
  const city = await one(`select * from game.cities where id = 'london'`);
  const spot = await streetNear('london', city.start_lat, city.start_lng, 80);
  const { business_id } = await rpc(client, 'buy_cart', { p_name: 'Sleepy', p_lat: spot.lat, p_lng: spot.lng });
  await q(`update game.players set last_seen_at = now() - interval '25 hours' where id = $1`, [id]);
  const cash0 = (await one('select cash from game.players where id = $1', [id])).cash;
  await runTickAfter([business_id], 1);
  const cash1 = (await one('select cash from game.players where id = $1', [id])).cash;
  assert.equal(String(cash1), String(cash0), 'no earnings or costs while paused');
  const b = await one('select flags from game.businesses where id = $1', [business_id]);
  assert.equal(b.flags.paused, true);
  // Coming back shows the away card and resumes.
  const s = await rpc(client, 'session_start');
  assert.ok(s.away, 'away summary');
  assert.equal(s.away.paused, true);
});

test('land, farms, auto-sell, surveys and mines', async () => {
  const { client, id } = await newPlayer('Baron');
  await q('update game.players set tier = 5, cash = cash where id = $1', [id]);
  await q(`select game.money($1, 3000000000, 'admin', 'test funds')`, [id]);
  const plot = await one(`with c as (select * from game.cities where id = 'london')
      select x px, y py, (game.plot_center(c, x, y)).lat lat, (game.plot_center(c, x, y)).lng lng
        from c, generate_series(0, c.plot_w - 1) x, generate_series(0, c.plot_h - 1) y
       where game.plot_buildable(c, x, y) and not exists (select 1 from game.plots p where p.city_id = 'london' and p.px = x and p.py = y)
       limit 1`);
  await q('update game.players set lat = $2, lng = $3, pos_at = now() where id = $1', [id, plot.lat, plot.lng]);
  const bought = await rpc(client, 'buy_plot', { p_city: 'london', p_px: plot.px, p_py: plot.py, p_lat: plot.lat, p_lng: plot.lng });
  assert.ok(bought.price > 0);
  assert.match(await rpcError(client, 'build_on_plot', { p_city: 'london', p_px: plot.px, p_py: plot.py, p_kind: 'farm', p_name: 'Bananas', p_option: 'banana' }), /warm cities/);
  const farm = await rpc(client, 'build_on_plot', { p_city: 'london', p_px: plot.px, p_py: plot.py, p_kind: 'farm', p_name: 'Green Acre', p_option: 'lettuce' });
  await runTickAfter([farm.business_id], 1);
  let st = await rpc(client, 'my_storage');
  assert.ok(st[0].goods.find((g) => g.good === 'lettuce').qty >= 2000, 'farm grew lettuce');
  await rpc(client, 'set_business_option', { p_id: farm.business_id, p_key: 'auto_sell', p_value: true });
  const cash0 = (await rpc(client, 'get_me')).cash;
  await runTickAfter([farm.business_id], 1);
  const cash1 = (await rpc(client, 'get_me')).cash;
  assert.ok(cash1 > cash0, 'auto-sell earned money');
  // Survey where we stand.
  const s = await rpc(client, 'survey', { p_lat: plot.lat, p_lng: plot.lng });
  assert.ok(Array.isArray(s.deposits));
  assert.match(await rpcError(client, 'survey', { p_lat: plot.lat, p_lng: plot.lng }), /already surveyed/);
  assert.deepEqual(await ledgerMismatches(), []);
});

test('cash can never go negative and every dollar is in the ledger', async () => {
  const bad = await one('select count(*)::int n from game.players where cash < 0');
  assert.equal(bad.n, 0);
  assert.deepEqual(await ledgerMismatches(), []);
});
