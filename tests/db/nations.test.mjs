// Nations: choosing a country, the national economy, military building,
// research, war, peace, alliances and the AI, including ways people might
// try to cheat.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, q, one, newPlayer, rpc, rpcError, anonClient, ledgerMismatches } from './helpers.mjs';

after(async () => { await db.end(); });

before(async () => {
  // A clean world for these tests (the local database only).
  await q('update game.nations set leader_id = null, leader_since = null');
  await q('select game.world_reset()');
  await q(`delete from game.rate_buckets where action in ('envoy', 'denounce', 'peace', 'declare_war')`);
});

const levelUp = async (id, level) =>
  q('select game.grant_xp($1, greatest(1, (select total from game.level_xp where level = $2)::int - coalesce((select xp from game.renown where player_id = $1), 0)::int), $3)', [id, level, 'test']);

// A pair of neighbouring AI countries nobody leads.
async function freePair(kind = 'land', skip = 0) {
  return one(
    `select l.a, l.b from game.territory_links l
       join game.nations x on x.id = l.a join game.nations y on y.id = l.b
      where l.kind = $1 and x.leader_id is null and y.leader_id is null and x.status = 'active' and y.status = 'active'
        and game.alliance_of(x.id) is null and game.alliance_of(y.id) is null
        and not exists (select 1 from game.war_sides s where s.nation_id in (x.id, y.id))
        and (select count(*) from game.territory_links z where z.a = l.b) <= 6
      order by l.a, l.b offset $2 limit 1`,
    [kind, skip]
  );
}

test('choosing a country: first come first served, one each, a fresh start, protection', async () => {
  const a = await newPlayer('Leader');
  const b = await newPlayer('Second');
  const pair = await freePair('land', 0);
  // Give the AI country a head start that should vanish when a player takes over.
  await q(`update game.nations set treasury = 999999999999 where id = $1`, [pair.a]);
  await q(`insert into game.nation_techs (nation_id, tech) values ($1, 'drills')`, [pair.a]);
  await q(`update game.territories set owner_id = $1, controller_id = $1 where id = $2`, [pair.a, pair.b]);

  const r = await rpc(a.client, 'claim_nation', { p_id: pair.a });
  assert.equal(r.nation, pair.a);
  assert.ok(new Date(r.protected_until) > new Date(Date.now() + 23 * 3600e3));
  const n = await one('select * from game.nations where id = $1', [pair.a]);
  assert.equal(n.leader_id, a.id);
  assert.ok(Number(n.treasury) < 999999999999, 'fresh treasury');
  assert.equal(Number((await one('select count(*) c from game.nation_techs where nation_id = $1', [pair.a])).c), 0, 'no research');
  const tb = await one('select owner_id, controller_id from game.territories where id = $1', [pair.b]);
  assert.equal(tb.owner_id, pair.b, 'land it had conquered goes back to its own people');
  assert.equal((await one('select status from game.nations where id = $1', [pair.b])).status, 'active');
  assert.ok(Number((await one(`select qty from game.garrisons where territory_id = $1 and nation_id = $1 and unit = 'infantry'`, [pair.a])).qty) > 0);

  // One leader per country; one country per leader.
  assert.match(await rpcError(b.client, 'claim_nation', { p_id: pair.a }), /already has a leader/);
  assert.match(await rpcError(a.client, 'claim_nation', { p_id: pair.b }), /already lead/);
  const me = await rpc(a.client, 'get_me');
  assert.equal(me.nation, pair.a);
  const world = await rpc(anonClient(), 'world_state');
  assert.equal(world.nations.find((x) => x.id === pair.a).leader.no, a.me.player_no);

  // Two players race for the same country: exactly one wins.
  const c = await newPlayer('RaceA');
  const d = await newPlayer('RaceB');
  const race = await freePair('land', 3);
  const results = await Promise.allSettled([rpc(c.client, 'claim_nation', { p_id: race.a }), rpc(d.client, 'claim_nation', { p_id: race.a })]);
  assert.equal(results.filter((x) => x.status === 'fulfilled').length, 1);
  assert.equal(Number((await one('select count(*) c from game.nations where id = $1 and leader_id in ($2, $3)', [race.a, c.id, d.id])).c), 1);

  // A homeland held by a player-led nation can't be claimed.
  const e = await newPlayer('Exile');
  await q(`update game.territories set owner_id = $1, controller_id = $1 where id = $2`, [pair.a, pair.b]);
  assert.match(await rpcError(e.client, 'claim_nation', { p_id: pair.b }), /conquered by/);
  await q(`update game.territories set owner_id = $1, controller_id = $1 where id = $1`, [pair.b]);

  // Stepping down hands it to the AI, with a 12-hour wait to lead again.
  await rpc(b.client, 'claim_nation', { p_id: (await freePair('land', 6)).a });
  await rpc(b.client, 'abdicate');
  assert.match(await rpcError(b.client, 'claim_nation', { p_id: (await freePair('land', 9)).a }), /12 hours/);
  assert.equal((await rpc(b.client, 'my_nation')).nation, null);
});

test('running a nation: invest, tax, recruit, build and research, all gated and paid for', async () => {
  const a = await newPlayer('Ruler');
  const pair = await freePair('land', 12);
  await rpc(a.client, 'claim_nation', { p_id: pair.a });
  let mine = await rpc(a.client, 'my_nation');
  const t0 = Number(mine.nation.treasury);

  // Invest business money: it leaves your cash through the ledger.
  await q(`select game.money($1, 100000000, 'admin', 'test money')`, [a.id]);
  await rpc(a.client, 'nation_invest', { p_amount: 50000000 });
  mine = await rpc(a.client, 'my_nation');
  assert.equal(Number(mine.nation.treasury), t0 + 50000000);
  assert.match(await rpcError(a.client, 'nation_invest', { p_amount: 999999999999 }), /Not enough money/);

  // Recruit infantry: treasury and manpower pay; it trains in the barracks.
  const mp0 = Number(mine.nation.manpower);
  const r = await rpc(a.client, 'nation_recruit', { p_territory: pair.a, p_unit: 'infantry', p_qty: 10 });
  assert.equal(Number(r.cost), 3000000);
  mine = await rpc(a.client, 'my_nation');
  assert.equal(Number(mine.nation.manpower), mp0 - 500);
  assert.match(await rpcError(a.client, 'nation_recruit', { p_territory: pair.a, p_unit: 'infantry', p_qty: 500 }), /Orders here are 1 to 20/);
  assert.match(await rpcError(a.client, 'nation_recruit', { p_territory: pair.b, p_unit: 'infantry', p_qty: 5 }), /own and hold/);
  // Armour: Renown level first, then the research.
  assert.match(await rpcError(a.client, 'nation_recruit', { p_territory: pair.a, p_unit: 'armor', p_qty: 1 }), /level 5/);
  await levelUp(a.id, 5);
  assert.match(await rpcError(a.client, 'nation_recruit', { p_territory: pair.a, p_unit: 'armor', p_qty: 1 }), /Research Mechanized Warfare/);

  // Training finishes on the tick.
  const g0 = Number((await one(`select qty from game.garrisons where territory_id = $1 and nation_id = $1 and unit = 'infantry'`, [pair.a])).qty);
  await q(`update game.recruit_queue set ready_at = now() - interval '1 second' where nation_id = $1`, [pair.a]);
  await q('select game.world_tick()');
  const g1 = Number((await one(`select qty from game.garrisons where territory_id = $1 and nation_id = $1 and unit = 'infantry'`, [pair.a])).qty);
  assert.ok(g1 >= g0 + 10, 'the recruits joined the garrison');
  assert.ok(Number((await one(`select value from game.player_counters where player_id = $1 and key = 'recruited'`, [a.id])).value) >= 10);

  // Build a fort (level 4+), then a second level costs four times as much.
  const before = Number((await rpc(a.client, 'my_nation')).nation.treasury);
  const b1 = await rpc(a.client, 'nation_build', { p_territory: pair.a, p_kind: 'fort' });
  assert.equal(Number(b1.cost), 3000000);
  assert.match(await rpcError(a.client, 'nation_build', { p_territory: pair.a, p_kind: 'fort' }), /already being built/);
  assert.match(await rpcError(a.client, 'nation_build', { p_territory: pair.a, p_kind: 'airbase' }), /level 10/);
  assert.ok(Number((await rpc(a.client, 'my_nation')).nation.treasury) <= before - 3000000);
  await q(`update game.facilities set ready_at = now() - interval '1 second' where territory_id = $1`, [pair.a]);
  await q('select game.world_tick()');
  assert.equal(Number((await one(`select level from game.facilities where territory_id = $1 and kind = 'fort'`, [pair.a])).level), 1);
  const b2 = await rpc(a.client, 'nation_build', { p_territory: pair.a, p_kind: 'fort' });
  assert.equal(Number(b2.cost), 12000000);

  // Research: prerequisites, then the bank feeds it.
  assert.match(await rpcError(a.client, 'nation_research', { p_tech: 'jets' }), /needs first|what it needs/);
  await rpc(a.client, 'nation_research', { p_tech: 'armor' });
  await q(`update game.nations set research_bank = 1000, last_econ_at = now() - interval '1 minute' where id = $1`, [pair.a]);
  await q('select game.nation_economy($1)', [pair.a]);
  mine = await rpc(a.client, 'my_nation');
  assert.ok(mine.techs.find((t) => t.id === 'armor').done);
  assert.equal(mine.nation.researching, null);

  // Policy and the hourly economy: income in, upkeep out, a stipend for the leader.
  await rpc(a.client, 'nation_policy', { p_tax: 'high', p_research_pct: 20, p_infra_pct: 10 });
  assert.match(await rpcError(a.client, 'nation_policy', { p_tax: 'extreme', p_research_pct: 20, p_infra_pct: 10 }), /low, normal or high/);
  const cash0 = BigInt((await one('select cash from game.players where id = $1', [a.id])).cash);
  await q(`update game.nations set last_econ_at = now() - interval '1 hour' where id = $1`, [pair.a]);
  await q('select game.nation_economy($1)', [pair.a]);
  const cash1 = BigInt((await one('select cash from game.players where id = $1', [a.id])).cash);
  assert.ok(cash1 > cash0, 'the leader is paid a stipend');
  assert.ok(await one(`select 1 from game.ledger where player_id = $1 and kind = 'stipend'`, [a.id]));
  assert.deepEqual(await ledgerMismatches(), []);

  // Crate prizes reach the nation.
  const label = (await one(`select game.crate_nation_reward($1, 'funds', 5000000) as l`, [a.id])).l;
  assert.match(label, /treasury/);
});

test('war: declare, march, win, capture, capitulate and annex', async () => {
  const a = await newPlayer('General');
  const pair = await freePair('land', 20);
  await rpc(a.client, 'claim_nation', { p_id: pair.a });
  assert.match(await rpcError(a.client, 'declare_war', { p_nation: pair.b }), /level 5/);
  await levelUp(a.id, 5);

  // A protected new leader can't be attacked.
  const other = await newPlayer('Newbie');
  const far = await freePair('land', 30);
  await rpc(other.client, 'claim_nation', { p_id: far.a });
  assert.match(await rpcError(a.client, 'declare_war', { p_nation: far.a }), /protected/);

  // Can't march on a country you're not at war with.
  assert.match(await rpcError(a.client, 'army_send', { p_from: pair.a, p_to: pair.b, p_units: { infantry: 1 } }), /aren't at war/);
  const w = await rpc(a.client, 'declare_war', { p_nation: pair.b });
  assert.ok(w.war);
  assert.equal((await one('select protected_until from game.nations where id = $1', [pair.a])).protected_until, null, 'declaring ends your protection');
  assert.ok(Number((await one('select score from game.relations where a = least($1, $2) and b = greatest($1, $2)', [pair.a, pair.b])).score) <= -40);

  // A big army marches; you can't send what you don't have.
  await q(`update game.garrisons set qty = 2000 where territory_id = $1 and nation_id = $1 and unit = 'infantry'`, [pair.a]);
  assert.match(await rpcError(a.client, 'army_send', { p_from: pair.a, p_to: pair.b, p_units: { infantry: 999999 } }), /only have/);
  const m = await rpc(a.client, 'army_send', { p_from: pair.a, p_to: pair.b, p_units: { infantry: 1500 } });
  assert.equal(m.kind, 'attack');
  assert.equal(Number((await one(`select qty from game.garrisons where territory_id = $1 and nation_id = $1 and unit = 'infantry'`, [pair.a])).qty), 500);
  const incoming = (await rpc(a.client, 'my_nation')).armies;
  assert.equal(incoming.length, 1);

  // It arrives: a battle, a capture, and with no land left the enemy falls.
  await q(`update game.movements set arrive_at = now() - interval '1 second' where id = $1`, [m.id]);
  await q('select game.arrive($1)', [m.id]);
  const battle = await one(`select * from game.battles where attacker_id = $1 order by id desc limit 1`, [pair.a]);
  assert.equal(battle.winner, 'attacker');
  assert.equal(battle.captured, true);
  const t = await one('select owner_id, controller_id from game.territories where id = $1', [pair.b]);
  assert.equal(t.controller_id, pair.a);
  assert.equal(t.owner_id, pair.a, 'capitulation: the conqueror annexes it');
  assert.equal((await one('select status from game.nations where id = $1', [pair.b])).status, 'fallen');
  assert.equal((await one('select status from game.wars where id = $1', [w.war])).status, 'ended');
  assert.ok(Number((await one(`select value from game.player_counters where player_id = $1 and key = 'territories'`, [a.id])).value) >= 1);
  assert.ok(Number((await one(`select value from game.player_counters where player_id = $1 and key = 'battles_won'`, [a.id])).value) >= 1);
  const news = await rpc(anonClient(), 'world_news', { p_limit: 20 });
  assert.ok(news.some((x) => x.kind === 'fallen'));
  // A truce now stands between them.
  assert.ok(await one(`select 1 from game.treaties where kind = 'truce' and a = least($1, $2) and b = greatest($1, $2)`, [pair.a, pair.b]));

  // Someone else can claim the fallen country only while an AI holds it: here a player does.
  const late = await newPlayer('Late');
  assert.match(await rpcError(late.client, 'claim_nation', { p_id: pair.b }), /conquered by/);
});

test('a lost battle, peace terms the AI weighs, and allies who come to help', async () => {
  const a = await newPlayer('Diplomat');
  const pair = await freePair('land', 40);
  await rpc(a.client, 'claim_nation', { p_id: pair.a });
  await levelUp(a.id, 6);

  // Alliances: found one, invite a friendly AI, which says yes.
  const friend = await one(
    `select l.b id from game.territory_links l join game.nations n on n.id = l.b
      where l.a = $1 and l.b <> $2 and n.leader_id is null and n.status = 'active' and game.alliance_of(n.id) is null limit 1`, [pair.a, pair.b]);
  await rpc(a.client, 'alliance_create', { p_name: 'Test Accord' });
  if (friend) {
    await q(`insert into game.relations (a, b, score) values (least($1, $2), greatest($1, $2), 80)
             on conflict (a, b) do update set score = 80`, [pair.a, friend.id]);
    const inv = await rpc(a.client, 'alliance_invite', { p_nation: friend.id });
    assert.equal(inv.status, 'accepted');
    // Someone attacks us: our ally joins the war.
    await q(`update game.nations set protected_until = null where id = $1`, [pair.a]);
    const war = (await one('select game.do_declare($1, $2) as w', [pair.b, pair.a])).w;
    const sides = await q('select nation_id, side from game.war_sides where war_id = $1', [war]);
    assert.ok(sides.find((s) => s.nation_id === friend.id && s.side === 'def'), 'the ally defends');

    // A tiny attack fails against the defence.
    await q(`update game.garrisons set qty = 1 where territory_id = $1 and nation_id = $1`, [pair.a]);
    await q(`update game.garrisons set qty = 400 where territory_id = $1 and nation_id = $1 and unit = 'infantry'`, [pair.b]);
    await q('select game.garrison_add($1, $1, $2, 1)', [pair.a, 'infantry']);
    const m = await rpc(a.client, 'army_send', { p_from: pair.a, p_to: pair.b, p_units: { infantry: 1 } });
    await q(`update game.movements set arrive_at = now() where id = $1`, [m.id]);
    await q('select game.arrive($1)', [m.id]);
    const lost = await one(`select * from game.battles where attacker_id = $1 order by id desc limit 1`, [pair.a]);
    assert.equal(lost.winner, 'defender');
    assert.equal(lost.captured, false);

    // Only war leaders make peace. The AI attacker refuses a white peace
    // while it's fresh and winning, then takes it when exhausted.
    await q(`update game.wars set att_wins = 10 where id = $1`, [war]);
    await q(`update game.nations set exhaustion = 0 where id = $1`, [pair.b]);
    const no = await rpc(a.client, 'propose_peace', { p_war: war, p_terms: 'white' });
    assert.equal(no.status, 'declined');
    await q(`update game.nations set exhaustion = 90 where id = $1`, [pair.b]);
    await q(`delete from game.rate_buckets where subject = $1 and action = 'peace'`, [pair.a]);
    const yes = await rpc(a.client, 'propose_peace', { p_war: war, p_terms: 'white' });
    assert.equal(yes.status, 'accepted');
    assert.equal((await one('select status from game.wars where id = $1', [war])).status, 'ended');
    assert.ok(Number((await one(`select value from game.player_counters where player_id = $1 and key = 'treaties'`, [a.id])).value) >= 1);
  }

  // Envoys cost treasury money and warm relations; denouncing an ally isn't allowed.
  const target = await freePair('land', 50);
  const t0 = Number((await one('select treasury from game.nations where id = $1', [pair.a])).treasury);
  const env = await rpc(a.client, 'diplo_envoy', { p_nation: target.a });
  assert.ok(env.relations >= 10);
  assert.equal(Number((await one('select treasury from game.nations where id = $1', [pair.a])).treasury), t0 - 2500000);
  assert.match(await rpcError(a.client, 'diplo_envoy', { p_nation: target.a }), /Slow down/);
  if (friend) assert.match(await rpcError(a.client, 'diplo_denounce', { p_nation: friend.id }), /ally/);
  const info = await rpc(a.client, 'nation_info', { p_id: target.a });
  assert.equal(info.can_declare, true);
  assert.ok(info.territories.length >= 1);
});

test('every AI government can think without errors, and the world tick runs', async () => {
  const ids = (await q(`select id from game.nations where leader_id is null and status = 'active' order by id`)).map((r) => r.id);
  const failures = [];
  for (const id of ids) {
    try {
      await q('select game.ai_think($1)', [id]);
    } catch (e) {
      failures.push(`${id}: ${e.message}`);
    }
  }
  assert.deepEqual(failures, []);
  await q(`update game.nations set next_think_at = now() - interval '1 second', last_econ_at = now() - interval '30 minutes'`);
  await q('select game.world_tick()');
  await q('select game.world_scores()');
  const ranks = await rpc(anonClient(), 'world_rankings');
  assert.ok(ranks.powers.length > 10);
  const map = await rpc(anonClient(), 'world_map');
  assert.equal(map.territories.length, 175);
  assert.ok(map.links.length > 600);
  // Anonymous visitors can look but not act.
  assert.ok(await rpcError(anonClient(), 'claim_nation', { p_id: ids[0] }));
  assert.deepEqual(await ledgerMismatches(), []);
});
