// Selling with a full menu, minute by minute (the way the live tick runs),
// and starting out in the city of the country you lead.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, q, one, newPlayer, rpc, rpcError, streetNear, standAt, ledgerMismatches } from './helpers.mjs';

after(async () => { await db.end(); });

test('a cart with a three-item menu sells every minute and "Sales today" goes up', async () => {
  const a = await newPlayer('Seller');
  const city = await one(`select * from game.cities where id = 'london'`);
  const spot = await streetNear('london', city.start_lat, city.start_lng, 200 + Math.floor(Math.random() * 200));
  await standAt(a.id, spot);
  const r = await rpc(a.client, 'buy_cart', { p_name: 'Menu Cart', p_lat: spot.lat, p_lng: spot.lng });
  const b0 = await one('select * from game.businesses where id = $1', [r.business_id]);
  // New carts sell three things at their fair prices.
  assert.equal(b0.settings.menu.length, 3);
  const fair = await q(`select id, fair_price from game.menu_items where id in ('salad', 'chips', 'onigiri')`);
  for (const m of b0.settings.menu) assert.equal(Number(m.price), Number(fair.find((f) => f.id === m.id).fair_price));
  assert.equal(Number(b0.capacity), 120);
  // Open all day, a busy street, and an hour of one-minute ticks.
  await q(`update game.businesses set open_hour = 0, close_hour = 24, traffic = 2, carry = 0 where id = $1`, [r.business_id]);
  await q(`update game.players set last_seen_at = now() where id = $1`, [a.id]);
  for (let i = 0; i < 60; i++) {
    await q(`update game.businesses set last_tick_at = now() - interval '1 minute' where id = $1`, [r.business_id]);
    await q('select game.tick_business($1)', [r.business_id]);
  }
  const b1 = await one('select * from game.businesses where id = $1', [r.business_id]);
  assert.ok(Number(b1.sales_today) >= 20, `sold ${b1.sales_today} in an hour`);
  assert.ok(Number(b1.revenue_today) >= 200000, `earned $${Number(b1.revenue_today) / 1000} in an hour`);
  // Every item sold, not just one.
  const sold = await one(`select coalesce(sum(qty), 0) q from game.storage where owner_id = $1 and good_id = 'wasabi'`, [a.id]);
  assert.ok(Number(sold.q) < 600, 'onigiri sold too');
  assert.deepEqual(await ledgerMismatches(), []);
});

test('when one item runs out, its customers buy something else', async () => {
  const a = await newPlayer('Spill');
  const city = await one(`select * from game.cities where id = 'london'`);
  const spot = await streetNear('london', city.start_lat, city.start_lng, 400 + Math.floor(Math.random() * 200));
  await standAt(a.id, spot);
  const r = await rpc(a.client, 'buy_cart', { p_name: 'Spill Cart', p_lat: spot.lat, p_lng: spot.lng });
  await q(`update game.storage set qty = 0 where owner_id = $1 and good_id = 'wasabi'`, [a.id]);
  await q(`update game.businesses set open_hour = 0, close_hour = 24, traffic = 2, carry = 0 where id = $1`, [r.business_id]);
  await q(`update game.players set last_seen_at = now() where id = $1`, [a.id]);
  await q(`update game.businesses set last_tick_at = now() - interval '30 minutes' where id = $1`, [r.business_id]);
  await q('select game.tick_business($1)', [r.business_id]);
  const b = await one('select * from game.businesses where id = $1', [r.business_id]);
  assert.ok(Number(b.sales_today) >= 20, `sold ${b.sales_today}`);
  assert.ok(b.flags.out_of_stock?.includes('onigiri'), 'the owner is told onigiri ran out');
});

test('leaders start in their own country’s city, or the nearest one', async () => {
  const home = async (n) => (await one('select game.home_city($1) c', [n])).c;
  assert.equal(await home('bra'), 'rio');
  assert.equal(await home('usa'), 'new-york');
  assert.equal(await home('gbr'), 'london');
  assert.equal(await home('deu'), 'berlin');
  assert.equal(await home('nga'), 'lagos');
  assert.equal(await home('arg'), 'rio', 'Argentina has no city: Rio is nearest');
  assert.equal(await home('nzl'), 'sydney');

  const a = await newPlayer('Carioca', null);
  assert.match(await rpcError(a.client, 'choose_home_city'), /country to lead first/);
  await q('update game.nations set leader_id = null where id = $1', ['bra']);
  await rpc(a.client, 'claim_nation', { p_id: 'bra' });
  const me = await rpc(a.client, 'choose_home_city');
  assert.equal(me.city_id, 'rio');
  assert.match(await rpcError(a.client, 'choose_home_city'), /already in a city/);
  const map = await rpc(a.client, 'world_map');
  assert.equal(map.territories.find((t) => t.id === 'bra').home, 'rio');
});
