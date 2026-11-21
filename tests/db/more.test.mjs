// New things to do: daily goals, contracts, city projects and shop
// decorations, including the ways people might try to cheat them.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, q, one, newPlayer, rpc, rpcError, anonClient, streetNear, standAt, ledgerMismatches } from './helpers.mjs';

after(async () => { await db.end(); });

async function withCart(prefix) {
  const a = await newPlayer(prefix);
  const city = await one(`select * from game.cities where id = 'london'`);
  const spot = await streetNear('london', city.start_lat, city.start_lng, Math.floor(Math.random() * 40));
  await standAt(a.id, spot);
  const r = await rpc(a.client, 'buy_cart', { p_name: prefix + ' Cart', p_lat: spot.lat, p_lng: spot.lng });
  return { ...a, cart: r.business_id };
}

test('daily goals: three a day, progress from real counters, one claim each, points not cash', async () => {
  const a = await withCart('Goal');
  const goals = await rpc(a.client, 'my_goals');
  assert.equal(goals.length, 3);
  assert.deepEqual((await rpc(a.client, 'my_goals')).map((g) => g.id), goals.map((g) => g.id), 'the same three all day');
  const sell = goals.find((g) => g.kind === 'starter_sell');
  assert.ok(sell, 'new players get the starter goals');
  assert.equal(sell.progress, 0);

  // Not done yet.
  assert.match(await rpcError(a.client, 'claim_goal', { p_id: sell.id }), /Not done yet/);

  // Sales happen (as the tick would record them).
  await q('update game.businesses set lifetime_sales = lifetime_sales + 12 where id = $1', [a.cart]);
  const now = (await rpc(a.client, 'my_goals')).find((g) => g.id === sell.id);
  assert.equal(now.progress, 10, 'progress is capped at the target');

  // Someone else can't claim it.
  const b = await newPlayer('Thief');
  assert.match(await rpcError(b.client, 'claim_goal', { p_id: sell.id }), /isn't yours/);

  const before = await one('select cash, loyalty_points from game.players where id = $1', [a.id]);
  const r = await rpc(a.client, 'claim_goal', { p_id: sell.id });
  assert.equal(r.reward_points, sell.reward_points);
  const afterClaim = await one('select cash, loyalty_points from game.players where id = $1', [a.id]);
  assert.equal(afterClaim.loyalty_points - before.loyalty_points, sell.reward_points);
  assert.equal(String(afterClaim.cash), String(before.cash), 'goals pay points, not cash');
  assert.match(await rpcError(a.client, 'claim_goal', { p_id: sell.id }), /already collected/);

  // Two claims at once: only one counts.
  const price = goals.find((g) => g.kind === 'starter_price');
  await q(`update game.businesses set settings = jsonb_set(settings, '{menu}', '[{"id":"salad","price":4321}]') where id = $1`, [a.cart]);
  const pts0 = (await one('select loyalty_points from game.players where id = $1', [a.id])).loyalty_points;
  await Promise.allSettled([rpc(a.client, 'claim_goal', { p_id: price.id }), rpc(a.client, 'claim_goal', { p_id: price.id })]);
  const pts1 = (await one('select loyalty_points from game.players where id = $1', [a.id])).loyalty_points;
  assert.equal(pts1 - pts0, price.reward_points);
});

test('contracts: deposit, deliver for more than market, no goods no pay, no double delivery, missed deadlines keep the deposit', async () => {
  await q('select game.contracts_tick()');
  const a = await newPlayer('Supplier');
  const b = await newPlayer('Rival');
  // Tier 1 can't take contracts.
  const list0 = await rpc(a.client, 'city_contracts', { p_city: 'london' });
  assert.ok(list0.open.length >= 4);
  assert.match(await rpcError(a.client, 'accept_contract', { p_id: list0.open[0].id }), /tier 2/);
  await q('update game.players set tier = 2 where id = any($1)', [[a.id, b.id]]);

  const c = list0.open[0];
  const cash0 = BigInt((await one('select cash from game.players where id = $1', [a.id])).cash);
  await rpc(a.client, 'accept_contract', { p_id: c.id });
  const cash1 = BigInt((await one('select cash from game.players where id = $1', [a.id])).cash);
  assert.equal(cash0 - cash1, BigInt(c.deposit), 'the deposit is paid');
  assert.match(await rpcError(b.client, 'accept_contract', { p_id: c.id }), /Someone else took/);
  assert.match(await rpcError(b.client, 'deliver_contract', { p_id: c.id }), /isn't your contract/);

  // Without the goods: refused, nothing changes.
  assert.match(await rpcError(a.client, 'deliver_contract', { p_id: c.id }), /Not enough/);
  assert.equal(String((await one('select cash from game.players where id = $1', [a.id])).cash), String(cash1));

  // With the goods: paid above market, deposit back, goods gone.
  await q('select game.stock_add($1, $2, $3, $4, false)', [a.id, 'london', c.good_id, c.qty]);
  const r = await rpc(a.client, 'deliver_contract', { p_id: c.id });
  assert.equal(String(r.paid), String(BigInt(c.qty) * BigInt(c.pay_per_unit)));
  const cash2 = BigInt((await one('select cash from game.players where id = $1', [a.id])).cash);
  assert.equal(cash2 - cash1, BigInt(c.qty) * BigInt(c.pay_per_unit) + BigInt(c.deposit));
  const ref = await one('select ref_price from game.markets where good_id = $1', [c.good_id]);
  assert.ok(Number(c.pay_per_unit) > Number(ref.ref_price), 'pays above market');
  assert.equal(Number((await one('select coalesce(sum(qty), 0) as q from game.storage where owner_id = $1 and good_id = $2', [a.id, c.good_id])).q), 0);
  assert.match(await rpcError(a.client, 'deliver_contract', { p_id: c.id }), /already closed/);

  // A missed deadline: the deposit is lost, the contract fails.
  const d = (await rpc(b.client, 'city_contracts', { p_city: 'london' })).open[0];
  const bc0 = BigInt((await one('select cash from game.players where id = $1', [b.id])).cash);
  await rpc(b.client, 'accept_contract', { p_id: d.id });
  await q(`update game.contracts set due_at = now() - interval '1 minute' where id = $1`, [d.id]);
  await q('select game.contracts_tick()');
  assert.equal((await one('select status from game.contracts where id = $1', [d.id])).status, 'failed');
  assert.match(await rpcError(b.client, 'deliver_contract', { p_id: d.id }), /closed|deadline/);
  assert.equal(bc0 - BigInt((await one('select cash from game.players where id = $1', [b.id])).cash), BigInt(d.deposit));

  // At most three at a time.
  const open = (await rpc(b.client, 'city_contracts', { p_city: 'london' })).open;
  for (const x of open.slice(0, 3)) await rpc(b.client, 'accept_contract', { p_id: x.id });
  if (open[3]) assert.match(await rpcError(b.client, 'accept_contract', { p_id: open[3].id }), /three contracts/);

  assert.deepEqual(await ledgerMismatches(), []);
});

test('city projects: give goods for a thank-you, capped at what it needs, then it opens and lifts foot traffic', async () => {
  const a = await withCart('Builder');
  const proj = (await rpc(a.client, 'city_projects', { p_city: 'london' }))[0];
  assert.equal(proj.status, 'open');
  // Shrink the project so the test can finish it.
  await q(`update game.city_projects set needs = '{"planks": 50, "glass": 20}', given = '{}' where id = $1`, [proj.id]);
  // Goods it doesn't need, or that you don't have: refused.
  assert.match(await rpcError(a.client, 'contribute_project', { p_project: proj.id, p_good: 'lettuce', p_qty: 10 }), /doesn't need/);
  assert.match(await rpcError(a.client, 'contribute_project', { p_project: proj.id, p_good: 'planks', p_qty: 10 }), /Not enough/);

  await q('select game.stock_add($1, $2, $3, $4, false)', [a.id, 'london', 'planks', 80]);
  await q('select game.stock_add($1, $2, $3, $4, false)', [a.id, 'london', 'glass', 20]);
  const cash0 = BigInt((await one('select cash from game.players where id = $1', [a.id])).cash);
  const r1 = await rpc(a.client, 'contribute_project', { p_project: proj.id, p_good: 'planks', p_qty: 80 });
  assert.equal(r1.given, 50, 'only what it still needs is taken');
  assert.equal(Number((await one(`select qty from game.storage where owner_id = $1 and good_id = 'planks' and city_id = 'london'`, [a.id])).qty), 30);
  assert.ok(BigInt((await one('select cash from game.players where id = $1', [a.id])).cash) > cash0, 'a thank-you payment');
  assert.match(await rpcError(a.client, 'contribute_project', { p_project: proj.id, p_good: 'planks', p_qty: 1 }), /all the planks/);

  // Finishing it lifts foot traffic for nearby businesses.
  await q(`update game.businesses set lat = $2, lng = $3 where id = $1`, [a.cart, proj.lat + 0.0005, proj.lng]);
  const t0 = Number((await one('select traffic from game.businesses where id = $1', [a.cart])).traffic);
  const r2 = await rpc(a.client, 'contribute_project', { p_project: proj.id, p_good: 'glass', p_qty: 20 });
  assert.equal(r2.done, true);
  const t1 = Number((await one('select traffic from game.businesses where id = $1', [a.cart])).traffic);
  assert.ok(Math.abs(t1 - t0 * 1.15) < 0.01, 'foot traffic up 15%');
  assert.match(await rpcError(a.client, 'contribute_project', { p_project: proj.id, p_good: 'glass', p_qty: 1 }), /finished/);
  const after = (await rpc(anonClient(), 'city_projects', { p_city: 'london' })).find((x) => x.id === proj.id);
  assert.equal(after.status, 'done');
  assert.equal(after.top[0].player_no, a.me.player_no);
  assert.deepEqual(await ledgerMismatches(), []);
});

test('decorations: bought with points for your own businesses only, looks only', async () => {
  const a = await withCart('Decor');
  const b = await newPlayer('Nosy');
  const items = await rpc(anonClient(), 'decor_catalog');
  const flowers = items.find((i) => i.id === 'flower_boxes');
  assert.match(await rpcError(a.client, 'buy_decor', { p_business: a.cart, p_item: 'flower_boxes' }), /loyalty points/);
  await q('update game.players set loyalty_points = 100 where id = any($1)', [[a.id, b.id]]);
  assert.match(await rpcError(b.client, 'buy_decor', { p_business: a.cart, p_item: 'flower_boxes' }), /your own/);
  const cash0 = (await one('select cash from game.players where id = $1', [a.id])).cash;
  const traffic0 = (await one('select traffic, attract from game.businesses where id = $1', [a.cart]));
  const r = await rpc(a.client, 'buy_decor', { p_business: a.cart, p_item: 'flower_boxes' });
  assert.equal(r.points_left, 100 - flowers.cost_points);
  assert.match(await rpcError(a.client, 'buy_decor', { p_business: a.cart, p_item: 'flower_boxes' }), /already has/);
  assert.equal(String((await one('select cash from game.players where id = $1', [a.id])).cash), String(cash0));
  const traffic1 = (await one('select traffic, attract from game.businesses where id = $1', [a.cart]));
  assert.deepEqual(traffic1, traffic0, 'no effect on sales');
  // Shown on the map.
  const city = await one(`select * from game.cities where id = 'london'`);
  const onMap = await rpc(a.client, 'map_businesses', { p_city: 'london', p_w: city.start_lng - 0.02, p_s: city.start_lat - 0.02, p_e: city.start_lng + 0.02, p_n: city.start_lat + 0.02 });
  assert.deepEqual(onMap.find((x) => x.id === a.cart).decor, ['flower_boxes']);
});
