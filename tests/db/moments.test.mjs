// The numbers behind the dashboard: daily net-worth snapshots, history
// (yours only, oldest first, today live) and last-hour sales income.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, q, one, newPlayer, rpc, anonClient } from './helpers.mjs';

after(async () => { await db.end(); });

test('net worth history: snapshots by day, oldest first, today live, only your own', async () => {
  const a = await newPlayer('Histo');
  const b = await newPlayer('Other');
  // Three earlier days for a, one for b.
  for (const [d, nw] of [[3, 9_000_000], [2, 9_500_000], [1, 9_800_000]]) {
    await q(`insert into game.net_worth_daily (player_id, day, net_worth, cash) values ($1, (now() at time zone 'utc')::date - $2::int, $3, $3)`, [a.id, d, nw]);
  }
  await q(`insert into game.net_worth_daily (player_id, day, net_worth, cash) values ($1, (now() at time zone 'utc')::date - 1, 1, 1)`, [b.id]);
  const h = await rpc(a.client, 'net_worth_history', { p_days: 7 });
  assert.equal(h.length, 4);
  assert.deepEqual(h.slice(0, 3).map((x) => x.net_worth), [9_000_000, 9_500_000, 9_800_000]);
  const me = await one('select net_worth from game.players where id = $1', [a.id]);
  assert.equal(h[3].net_worth, Number(me.net_worth), 'today is live');
  assert.ok(h.every((x, i) => i === 0 || x.day > h[i - 1].day), 'oldest first');
  // A 2-day window shows yesterday and today.
  assert.equal((await rpc(a.client, 'net_worth_history', { p_days: 2 })).length, 2);
  // The hourly job writes today's row for everyone.
  await q('select game.snapshot_net_worth()');
  const today = await one(`select count(*)::int as n from game.net_worth_daily where player_id = $1 and day = (now() at time zone 'utc')::date`, [a.id]);
  assert.equal(today.n, 1);
  // Visitors can't read anyone's history.
  const { error } = await anonClient().rpc('net_worth_history', { p_days: 7 });
  assert.ok(error);
});

test('income: sales in the last hour', async () => {
  const a = await newPlayer('Earner');
  assert.equal(Number((await rpc(a.client, 'my_income')).per_hour), 0);
  await q(`select game.money($1, 12500, 'sales', 'Sales to customers', null, true)`, [a.id]);
  await q(`select game.money($1, 7500, 'sales', 'Sales to customers', null, true)`, [a.id]);
  assert.equal(Number((await rpc(a.client, 'my_income')).per_hour), 20000);
});
