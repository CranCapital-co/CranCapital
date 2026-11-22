// Renown: XP, levels, ranks, perks, crates, the daily reward, missions,
// achievements and the season track, including ways people might cheat.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, q, one, newPlayer, rpc, rpcError, ledgerMismatches } from './helpers.mjs';

after(async () => { await db.end(); });

const xp = (id, n, why = 'test') => one('select game.grant_xp($1, $2, $3) as v', [id, n, why]);

test('levels come quickly at first, give perk points and crates, ranks every 5 levels', async () => {
  const a = await newPlayer('Renown');
  const r0 = await rpc(a.client, 'my_renown');
  assert.equal(r0.level, 1);
  assert.equal(r0.need, 100, 'level 2 needs 100 XP');
  assert.equal(r0.rank, 'Recruit');
  assert.ok(r0.missions.filter((m) => m.scope === 'daily').length === 3, 'three daily missions');

  // 100 XP: level 2, a perk point and a supply crate.
  await xp(a.id, 100);
  let r = await rpc(a.client, 'my_renown');
  assert.equal(r.level, 2);
  assert.equal(r.perk_points, 1);
  assert.equal(r.crate_counts.supply, 1);
  // The level-up is announced.
  const note = await one(`select * from game.notifications where player_id = $1 and kind = 'levelup' order by id desc limit 1`, [a.id]);
  assert.match(note.title, /Level 2/);

  // To level 5: a new rank, a gold crate and the rank as a title.
  const need = (await one('select total from game.level_xp where level = 5')).total;
  await xp(a.id, Number(need) - 100);
  r = await rpc(a.client, 'my_renown');
  assert.equal(r.level, 5);
  assert.equal(r.rank, 'Hustler');
  assert.equal(r.crate_counts.gold, 1);
  assert.ok(r.titles.includes('Hustler'));
  assert.ok(r.unlocks.find((u) => u.key === 'war').open, 'war unlocks at 5');
  assert.ok(!r.unlocks.find((u) => u.key === 'air').open);
  // The HUD summary rides along with the player.
  const me = await rpc(a.client, 'get_me');
  assert.equal(me.renown.level, 5);

  // Titles: only earned ones.
  assert.match(await rpcError(a.client, 'use_title', { p_title: 'Emperor' }), /haven't earned/);
  await rpc(a.client, 'use_title', { p_title: 'Hustler' });
  assert.equal((await one('select title from game.players where id = $1', [a.id])).title, 'Hustler');
});

test('perks cost more each rank, master ranks need level 15, respec refunds everything once a week', async () => {
  const a = await newPlayer('Perks');
  await xp(a.id, Number((await one('select total from game.level_xp where level = 8')).total));
  let r = await rpc(a.client, 'my_renown');
  assert.equal(r.perk_points, 7);
  await rpc(a.client, 'spend_perk', { p_branch: 'trade' }); // 1
  await rpc(a.client, 'spend_perk', { p_branch: 'trade' }); // 2
  await rpc(a.client, 'spend_perk', { p_branch: 'trade' }); // 3 -> 6 spent
  assert.match(await rpcError(a.client, 'spend_perk', { p_branch: 'trade' }), /level 15/);
  await rpc(a.client, 'spend_perk', { p_branch: 'fortune' }); // 7
  assert.match(await rpcError(a.client, 'spend_perk', { p_branch: 'command' }), /costs 1 perk points. You have 0/);
  r = await rpc(a.client, 'my_renown');
  assert.equal(r.perks.trade, 3);
  assert.match(await rpcError(a.client, 'spend_perk', { p_branch: 'nonsense' }), /Unknown perk/);
  const back = await rpc(a.client, 'respec_perks');
  assert.equal(back.free, true);
  assert.equal(back.refunded, 6 + 1);
  assert.match(await rpcError(a.client, 'respec_perks'), /no perks/);
  await rpc(a.client, 'spend_perk', { p_branch: 'fortune' });
  assert.match(await rpcError(a.client, 'respec_perks'), /once a week/);
});

test('trade perk pays a bonus on new sales, and sales XP is log-scaled', async () => {
  const a = await newPlayer('Trade');
  await q('select game.renown_scan($1)', [a.id]); // first scan sets the baseline
  await q(`update game.renown set perks = '{"trade":2}', rev_scanned_at = now() - interval '6 minutes' where player_id = $1`, [a.id]);
  // Pretend a business earned $10,000.
  await q(`insert into game.businesses (owner_id, city_id, kind, name, lat, lng, lifetime_revenue)
           select $1, 'london', 'cart', 'Ghost', start_lat, start_lng, 10000000 from game.cities where id = 'london'`, [a.id]);
  const cash0 = BigInt((await one('select cash from game.players where id = $1', [a.id])).cash);
  const xp0 = Number((await one('select xp from game.renown where player_id = $1', [a.id])).xp);
  await q('select game.renown_scan($1)', [a.id]);
  const cash1 = BigInt((await one('select cash from game.players where id = $1', [a.id])).cash);
  assert.equal(cash1 - cash0, 400000n, '4% of $10,000');
  const gained = Number((await one('select xp from game.renown where player_id = $1', [a.id])).xp) - xp0;
  assert.equal(gained, 32, '8 × log10(10,001)');
  // No new sales, no more bonus.
  await q(`update game.renown set rev_scanned_at = now() - interval '6 minutes' where player_id = $1`, [a.id]);
  await q('select game.renown_scan($1)', [a.id]);
  assert.equal(BigInt((await one('select cash from game.players where id = $1', [a.id])).cash), cash1);
  await q('delete from game.businesses where owner_id = $1', [a.id]);
});

test('crates: only ones you have, every 10th supply crate is gold, prizes are real', async () => {
  const a = await newPlayer('Crates');
  assert.match(await rpcError(a.client, 'open_crate', { p_kind: 'supply' }), /no crates/);
  assert.match(await rpcError(a.client, 'open_crate', { p_kind: 'diamond' }), /Unknown crate/);
  await q('select game.renown_row($1)', [a.id]);
  await q(`update game.renown set crates = '{"supply":10}' where player_id = $1`, [a.id]);
  const prizes = [];
  for (let i = 0; i < 10; i++) prizes.push(await rpc(a.client, 'open_crate', { p_kind: 'supply' }));
  assert.equal(prizes.filter((p) => p.opened_as === 'gold').length, 1, 'the pity crate');
  assert.equal(prizes[9].opened_as, 'gold');
  for (const p of prizes) assert.ok(p.label && p.prize);
  await q(`update game.renown set crates = '{}' where player_id = $1`, [a.id]);
  assert.match(await rpcError(a.client, 'open_crate', { p_kind: 'supply' }), /no crates/);
  assert.equal(Number((await one(`select value from game.player_counters where player_id = $1 and key = 'crates_opened'`, [a.id])).value), 10);
  assert.deepEqual(await ledgerMismatches(), []);
});

test('daily reward: once a day, streak shields cover a missed day, the cycle never resets', async () => {
  const a = await newPlayer('Daily');
  const d1 = await rpc(a.client, 'claim_daily');
  assert.equal(d1.day, 1);
  assert.equal(d1.streak, 1);
  assert.match(await rpcError(a.client, 'claim_daily'), /Already collected/);
  // Pretend yesterday: streak 2, day 2 (cash).
  await q(`update game.renown set daily_last = daily_last - 1 where player_id = $1`, [a.id]);
  const d2 = await rpc(a.client, 'claim_daily');
  assert.equal(d2.streak, 2);
  assert.ok(d2.cash > 0);
  // Missed a day with a shield: the streak survives.
  await q(`update game.renown set daily_last = daily_last - 2, shields = 1 where player_id = $1`, [a.id]);
  const d3 = await rpc(a.client, 'claim_daily');
  assert.equal(d3.streak, 3);
  assert.equal(d3.shields_used, 1);
  assert.equal(d3.crate, 'supply', 'day 3 gives a crate');
  // Missed days with no shield: the streak restarts but the cycle carries on.
  await q(`update game.renown set daily_last = daily_last - 5 where player_id = $1`, [a.id]);
  const d4 = await rpc(a.client, 'claim_daily');
  assert.equal(d4.streak, 1);
  assert.equal(d4.day, 4);
});

test('missions and achievements track real progress; season tiers pay once', async () => {
  const a = await newPlayer('Mission');
  const r = await rpc(a.client, 'my_renown');
  const m = r.missions[0];
  assert.match(await rpcError(a.client, 'claim_mission', { p_id: m.id }), /Not done yet/);
  const b = await newPlayer('Other');
  assert.match(await rpcError(b.client, 'claim_mission', { p_id: m.id }), /isn't yours/);
  // Complete it by moving its base back.
  await q('update game.missions set base = base - target where id = $1', [m.id]);
  const lvl0 = (await one('select xp from game.renown where player_id = $1', [a.id])).xp;
  const c = await rpc(a.client, 'claim_mission', { p_id: m.id });
  assert.equal(c.xp, m.xp);
  assert.ok(Number((await one('select xp from game.renown where player_id = $1', [a.id])).xp) > Number(lvl0));
  assert.match(await rpcError(a.client, 'claim_mission', { p_id: m.id }), /Already collected/);

  // Achievements: reaching level 10 earns Renowned bronze.
  await xp(a.id, Number((await one('select total from game.level_xp where level = 10')).total));
  await q('select game.check_achievements($1)', [a.id]);
  const ach = await one(`select tier from game.achievements where player_id = $1 and id = 'renowned'`, [a.id]);
  assert.equal(ach.tier, 1);

  // Season: tier 1 is reached at 400 XP this month.
  const s = (await rpc(a.client, 'my_renown')).season;
  assert.ok(s.xp >= 400);
  await rpc(a.client, 'claim_season', { p_tier: 1 });
  assert.match(await rpcError(a.client, 'claim_season', { p_tier: 1 }), /Already collected/);
  assert.match(await rpcError(a.client, 'claim_season', { p_tier: 40 }), /Not reached/);
  const top = await rpc(b.client, 'renown_leaders');
  assert.ok(top.length >= 1);
});
