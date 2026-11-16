// Phase 3 gate: "market prices hold steady through a test week".
// Simulates 7 days in 10-minute steps: farms and mines dumping output,
// restaurants and factories buying inputs, and noisy traders, all trading
// with the market traders. Prices must stay within a sane band and end
// close to base once the pressure stops.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, q, one, newPlayer } from './helpers.mjs';

after(async () => { await db.end(); });

test('market prices hold steady through a simulated week', { timeout: 600_000 }, async () => {
  const sim = await newPlayer('Simulator');
  await q(`select game.money($1, 900000000000, 'admin', 'simulation funds')`, [sim.id]);
  const rev0 = (await one(`select value from game.config where key = 'npc_reversion_per_tick'`)).value;
  // Each step is 10 minutes: compound the per-minute reversion.
  await q(`update game.config set value = 1 - power(1 - $1::numeric, 10) where key = 'npc_reversion_per_tick'`, [rev0]);
  await q(`update game.config set value = 1e12 where key = 'base_storage'`);
  const goods = await q(`select id, base_price, depth from game.goods`);
  const sellers = { lettuce: 18000, tomato: 12000, wheat: 30000, coal: 1200, iron_ore: 900, crude_oil: 900 }; // per 10 min
  const buyers = { flour: 9000, tomato: 9000, rice: 6000, coal: 800, iron_ore: 700, crude_oil: 650, diesel: 300 };
  let worst = { good: '', dev: 0 };
  try {
    for (let step = 0; step < 7 * 24 * 6; step++) {
      // Daily rhythm: heavier trading in the day.
      const hour = Math.floor(step / 6) % 24;
      const load = hour >= 8 && hour <= 20 ? 1.3 : 0.5;
      const calls = [];
      for (const [g, n] of Object.entries(sellers)) {
        const qty = Math.round(n * load * (0.8 + Math.random() * 0.4));
        calls.push(`select game.stock_add('${sim.id}', 'london', '${g}', ${qty}, false); select * from game.npc_buy_from('${sim.id}', '${g}', ${qty}, null);`);
      }
      for (const [g, n] of Object.entries(buyers)) {
        const qty = Math.round(n * load * (0.8 + Math.random() * 0.4));
        calls.push(`select * from game.npc_sell_to('${sim.id}', '${g}', ${qty}, null, 'london', false);`);
      }
      // Noise traders on a few random goods.
      for (let i = 0; i < 3; i++) {
        const g = goods[Math.floor(Math.random() * goods.length)];
        const qty = Math.max(1, Math.round(Number(g.depth) * 0.05 * Math.random()));
        if (Math.random() < 0.5) calls.push(`select * from game.npc_sell_to('${sim.id}', '${g.id}', ${qty}, null, 'london', false);`);
        else calls.push(`select game.stock_add('${sim.id}', 'london', '${g.id}', ${qty}, false); select * from game.npc_buy_from('${sim.id}', '${g.id}', ${qty}, null);`);
      }
      await db.query(calls.join('\n'));
      await db.query('select game.markets_tick()');
      if (step % 36 === 0) {
        const rows = await q(`select g.id, m.ref_price / g.base_price as r from game.markets m join game.goods g on g.id = m.good_id`);
        for (const r of rows) {
          const dev = Math.abs(Number(r.r) - 1);
          if (dev > worst.dev) worst = { good: r.id, dev };
        }
      }
    }
    // During the week no price strayed more than 40% from base.
    assert.ok(worst.dev < 0.4, `worst deviation ${worst.good} ${(worst.dev * 100).toFixed(1)}%`);
    // A quiet day later, prices are back near base.
    for (let i = 0; i < 6 * 24; i++) await db.query('select game.markets_tick()');
    const end = await q(`select g.id, m.ref_price / g.base_price as r from game.markets m join game.goods g on g.id = m.good_id`);
    for (const r of end) assert.ok(Math.abs(Number(r.r) - 1) < 0.05, `${r.id} ended at ${(Number(r.r) * 100).toFixed(1)}% of base`);
    console.log(`# worst deviation during the week: ${worst.good} ${(worst.dev * 100).toFixed(1)}%`);
  } finally {
    await q(`update game.config set value = $1 where key = 'npc_reversion_per_tick'`, [rev0]);
    await q(`update game.config set value = 200000 where key = 'base_storage'`);
    await q(`update game.markets m set ref_price = g.base_price from game.goods g where g.id = m.good_id`);
  }
});
