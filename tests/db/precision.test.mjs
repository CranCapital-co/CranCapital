// Numbers the ticks keep recalculating must not grow digits. Stability once
// gained decimal places every tick until it held 16,383 of them, and the
// arithmetic on those numbers starved the live server's CPU.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, q, one } from './helpers.mjs';

after(async () => { await db.end(); });

test('stability and relation scores stay short however often they are recalculated', async () => {
  const n = await one(`select id from game.nations where status = 'active' and leader_id is null order by id limit 1`);
  for (let i = 0; i < 25; i++) {
    await q(`update game.nations set last_econ_at = now() - interval '1 second' * (60 + random() * 300), stability = stability - 1.234567 where id = $1`, [n.id]);
    await q('select game.world_economy_one($1)', [n.id]);
  }
  const s = await one('select stability::text s from game.nations where id = $1', [n.id]);
  assert.ok(s.s.length <= 10, `stability is ${s.s.length} characters long`);
  await q(`update game.relations set score = score * 0.97 where true`);
  await q(`update game.relations set score = score * 0.97 where true`);
  const r = await one('select coalesce(max(length(score::text)), 0) l from game.relations');
  assert.ok(Number(r.l) <= 10, `a relation score is ${r.l} characters long`);
  // No other number the game stores can grow without limit either.
  const loose = await q(`select c.relname || '.' || a.attname col from pg_attribute a join pg_class c on c.oid = a.attrelid
      join pg_namespace s on s.oid = c.relnamespace
     where s.nspname = 'game' and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
       and a.atttypid = 'numeric'::regtype and a.atttypmod = -1`);
  const big = [];
  for (const { col } of loose) {
    const [t, c] = col.split('.');
    const m = await one(`select coalesce(max(length(${c}::text)), 0) l from game.${t}`);
    if (Number(m.l) > 40) big.push(`${col} (${m.l})`);
  }
  assert.deepEqual(big, [], 'numeric columns with runaway digits');
});
