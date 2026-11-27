// Missiles you move and upgrade, and fleets that carry troops overseas.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, q, one, newPlayer, rpc, rpcError, ledgerMismatches } from './helpers.mjs';

after(async () => { await db.end(); });

const levelUp = async (id, level) =>
  q('select game.grant_xp($1, greatest(1, (select total from game.level_xp where level = $2)::int - coalesce((select xp from game.renown where player_id = $1), 0)::int), $3)', [id, level, 'test']);

// A coastal country (a) with a land neighbour (n), a coastal country 1,200 to
// 2,000 km away that isn't a neighbour and is within 3,500 km by sea (e), and
// a coastal one 3,300 to 4,300 km from n and over 4,500 km from a by sea (f).
// Nobody leads any of them and none is at war.
async function layout() {
  await q(`update game.nations set protected_until = null where leader_id is null`);
  return one(`
    with free as (select n.id, t.lat, t.lng, t.landlocked from game.nations n join game.territories t on t.id = n.id
      where n.leader_id is null and n.status = 'active' and game.alliance_of(n.id) is null
        and not exists (select 1 from game.war_sides s join game.wars w on w.id = s.war_id and w.status = 'active' where s.nation_id = n.id))
    select a.id a, nb.b n, e.id e, f.id f
      from free a
      join lateral (select l.b from game.territory_links l join free x on x.id = l.b where l.a = a.id and l.kind = 'land' order by l.b limit 1) nb on true
      join game.territories tn on tn.id = nb.b
      join lateral (select e.* from free e where not e.landlocked and e.id not in (a.id, nb.b)
                       and not exists (select 1 from game.territory_links z where z.a = a.id and z.b = e.id)
                       and game.dist_m(a.lat, a.lng, e.lat, e.lng) between 1200000 and 2000000
                       and exists (select 1 from game.sea_routes r where r.a = least(a.id, e.id) and r.b = greatest(a.id, e.id) and r.km < 3500 and r.via = '{}')
                     order by e.id limit 1) e on true
      join lateral (select f.* from free f where not f.landlocked and f.id not in (a.id, nb.b, e.id)
                       and game.dist_m(tn.lat, tn.lng, f.lat, f.lng) between 3300000 and 4300000
                       and game.dist_m(a.lat, a.lng, f.lat, f.lng) > 2600000
                       and exists (select 1 from game.sea_routes r where r.a = least(a.id, f.id) and r.b = greatest(a.id, f.id) and r.km > 4500)
                     order by f.id limit 1) f on true
     where not a.landlocked order by a.id limit 1`);
}

test('missiles: moved between your own land, launched from a silo, expensive upgrades for range, damage and guidance', async () => {
  const p = await newPlayer('Rocketeer');
  const L = await layout();
  assert.ok(L, 'a usable layout of countries');
  await rpc(p.client, 'claim_nation', { p_id: L.a });
  await levelUp(p.id, 20);
  await q(`delete from game.rate_buckets where subject = $1`, [L.a]);
  // n becomes part of the player's country.
  await q(`update game.territories set owner_id = $1, controller_id = $1 where id = $2`, [L.a, L.n]);
  await q(`update game.nations set status = 'fallen' where id = $1`, [L.n]);
  await q(`select game.money($1, 20000000000, 'admin', 'test money')`, [p.id]);
  const cash = async () => Number((await one('select cash from game.players where id = $1', [p.id])).cash);

  // The upgrades, before any research.
  let up = await rpc(p.client, 'military_upgrades');
  assert.deepEqual(up.tracks.map((t) => t.id), ['missile_range', 'missile_warhead', 'missile_guidance', 'troopships']);
  assert.equal(up.missile_range_km, 3000);
  assert.equal(up.troop_capacity, 0);
  assert.equal(Number(up.tracks[0].price), 250000000, 'missile range level 1 costs $250,000');
  assert.equal(Number(up.tracks[3].price), 15000000, 'troopships level 1 costs $15,000');
  assert.match(await rpcError(p.client, 'military_upgrade', { p_track: 'missile_range' }), /Research .* first/);
  assert.match(await rpcError(p.client, 'military_upgrade', { p_track: 'nope' }), /Unknown upgrade/);
  await q(`insert into game.nation_techs (nation_id, tech) values ($1, 'missiles'), ($1, 'navy') on conflict do nothing`, [L.a]);

  // Missiles at home move to n like troops, by road.
  await q(`select game.garrison_add($1, $1, 'missile', 12)`, [L.a]);
  const mv = await rpc(p.client, 'army_send', { p_from: L.a, p_to: L.n, p_units: { missile: 10 } });
  assert.equal(mv.kind, 'move');
  const minutes = (new Date(mv.arrive_at) - Date.now()) / 60000;
  assert.ok(minutes > 2, 'by road, not at missile speed');
  await q(`update game.movements set arrive_at = now() where id = $1`, [mv.id]);
  await q('select game.arrive($1)', [mv.id]);
  assert.equal(Number((await one(`select qty from game.garrisons where territory_id = $1 and nation_id = $2 and unit = 'missile'`, [L.n, L.a])).qty), 10);
  // ...but never to anyone else's land, even at war.
  const w = await rpc(p.client, 'declare_war', { p_nation: L.e });
  assert.ok(w.war);
  await q(`update game.nations set protected_until = null where id = $1`, [L.f]);
  await rpc(p.client, 'declare_war', { p_nation: L.f });
  assert.match(await rpcError(p.client, 'army_send', { p_from: L.a, p_to: L.e, p_units: { missile: 1 } }), /territories you hold/);

  // Launching needs a silo; f is out of reach at 3,000 km.
  assert.match(await rpcError(p.client, 'missile_launch', { p_from: L.n, p_to: L.f, p_qty: 2 }), /silo/);
  await q(`insert into game.facilities (territory_id, kind, level) values ($1, 'silo', 1) on conflict (territory_id, kind) do update set level = 1`, [L.n]);
  assert.match(await rpcError(p.client, 'missile_launch', { p_from: L.n, p_to: L.f, p_qty: 2 }), /missiles reach 3,000 km/);

  // Range level 1: $250,000 from your cash, through the ledger; f is in reach.
  let c0 = await cash();
  up = await rpc(p.client, 'military_upgrade', { p_track: 'missile_range' });
  assert.equal(await cash(), c0 - 250000000);
  assert.ok(await one(`select 1 from game.ledger where player_id = $1 and kind = 'military' and memo ilike 'Missile Range Level 1%'`, [p.id]));
  assert.equal(up.missile_range_km, 4500);
  assert.equal(up.tracks[0].level, 1);
  assert.equal(Number(up.tracks[0].price), 500000000, 'level 2 costs double');
  const launch = await rpc(p.client, 'missile_launch', { p_from: L.n, p_to: L.f, p_qty: 2 });
  assert.ok(launch.id);

  // Warheads and guidance: harder hits, fewer shot down.
  await q(`insert into game.nation_upgrades (nation_id, track, level) values ($1, 'missile_warhead', 2), ($1, 'missile_guidance', 2)
           on conflict (nation_id, track) do update set level = excluded.level`, [L.a]);
  await q(`insert into game.facilities (territory_id, kind, level) values ($1, 'air_defence', 2) on conflict (territory_id, kind) do update set level = 2`, [L.f]);
  await q(`delete from game.nation_techs where nation_id = $1 and tech in (select id from game.techs where effect ? 'missile' or effect ? 'no_intercept')`, [L.a]);
  await q(`update game.movements set arrive_at = now() where id = $1`, [launch.id]);
  await q('select game.arrive($1)', [launch.id]);
  const strike = await one(`select * from game.battles where attacker_id = $1 and kind = 'missile' order by id desc limit 1`, [L.a]);
  // 2 missiles x 60 x 1.5 (warheads) x (1 - 0.5 x 0.7) = 117.
  assert.equal(Number(strike.att_power), 117);
  assert.match(strike.summary, /35% intercepted/);

  // Maxed out: no level 6.
  await q(`update game.nation_upgrades set level = 5 where nation_id = $1 and track = 'missile_warhead'`, [L.a]);
  assert.match(await rpcError(p.client, 'military_upgrade', { p_track: 'missile_warhead' }), /fully upgraded/);

  // Can't afford it: a clear message, nothing taken.
  await q(`select game.money($1, -(select cash from game.players where id = $1) + 1000, 'admin', 'test')`, [p.id]);
  assert.match(await rpcError(p.client, 'military_upgrade', { p_track: 'missile_guidance' }), /can't afford/);
  assert.equal(await cash(), 1000);
  assert.deepEqual(await ledgerMismatches(), []);
});

test('troopships: fleets carry troops overseas, by capacity and range, and land them on an enemy shore', async () => {
  const p = await newPlayer('Admiral');
  const L = await layout();
  assert.ok(L, 'a usable layout of countries');
  await rpc(p.client, 'claim_nation', { p_id: L.a });
  await levelUp(p.id, 20);
  await q(`delete from game.rate_buckets where subject = $1`, [L.a]);
  await q(`select game.money($1, 2000000000, 'admin', 'test money')`, [p.id]);
  await q(`insert into game.nation_techs (nation_id, tech) values ($1, 'navy') on conflict do nothing`, [L.a]);
  await q(`select game.garrison_add($1, $1, 'naval', 3), game.garrison_add($1, $1, 'infantry', 400), game.garrison_add($1, $1, 'artillery', 10)`, [L.a]);
  await rpc(p.client, 'declare_war', { p_nation: L.e });
  await q(`update game.nations set protected_until = null where id = $1`, [L.f]);
  await rpc(p.client, 'declare_war', { p_nation: L.f });

  // Without the upgrade, troops only cross to neighbours.
  assert.match(await rpcError(p.client, 'army_send', { p_from: L.a, p_to: L.e, p_units: { naval: 2, infantry: 20 } }), /troopships/);
  assert.match(await rpcError(p.client, 'army_send', { p_from: L.a, p_to: L.e, p_units: { infantry: 20 } }), /doesn't border/);

  // Level 1: cheap; 20 soldiers a fleet, 4,000 km by sea.
  const c0 = Number((await one('select cash from game.players where id = $1', [p.id])).cash);
  const up = await rpc(p.client, 'military_upgrade', { p_track: 'troopships' });
  assert.equal(Number((await one('select cash from game.players where id = $1', [p.id])).cash), c0 - 15000000);
  assert.equal(up.troop_capacity, 20);
  assert.equal(up.troop_range_km, 4000);
  assert.match(await rpcError(p.client, 'army_send', { p_from: L.a, p_to: L.e, p_units: { naval: 2, infantry: 41 } }), /2 fleets carry 40 soldiers/);
  assert.match(await rpcError(p.client, 'army_send', { p_from: L.a, p_to: L.e, p_units: { naval: 2, infantry: 30, artillery: 6 } }), /carry 40 soldiers and you're sending 42/);
  assert.match(await rpcError(p.client, 'army_send', { p_from: L.a, p_to: L.f, p_units: { naval: 2, infantry: 10 } }), /troopships reach 4,000 km/);

  // Level 2: 30 a fleet; 3 fleets carry 90 to the enemy's shore.
  await rpc(p.client, 'military_upgrade', { p_track: 'troopships' });
  await q(`update game.garrisons set qty = 0 where territory_id = $1`, [L.e]);
  await q(`update game.territories set militia = 1 where id = $1`, [L.e]);
  const m = await rpc(p.client, 'army_send', { p_from: L.a, p_to: L.e, p_units: { naval: 3, infantry: 90 } });
  assert.equal(m.kind, 'attack');
  const mm = await one('select * from game.movements where id = $1', [m.id]);
  const km = Number((await one('select km from game.sea_routes where a = least($1, $2) and b = greatest($1, $2)', [L.a, L.e])).km);
  const mins = (new Date(mm.arrive_at) - new Date(mm.depart_at)) / 60000;
  assert.ok(Math.abs(mins - (2 + km / 90)) < 1.5, `sails the sea route (${km} km) at fleet speed: ${mins} min`);

  // You (and only you, your allies and its target) can see it at sea.
  const fm = await rpc(p.client, 'fleet_map');
  const s = fm.sailing.find((x) => x.id === m.id);
  assert.ok(s, 'the fleet is on the map');
  assert.equal(s.rel, 'mine');
  assert.equal(s.qty, 3);
  assert.equal(s.troops, 90);
  const stranger = await newPlayer('Stranger');
  const other = await one(`select id from game.nations where leader_id is null and status = 'active' and id not in ($1, $2, $3, $4) order by id limit 1`, [L.a, L.n, L.e, L.f]);
  await rpc(stranger.client, 'claim_nation', { p_id: other.id });
  assert.equal((await rpc(stranger.client, 'fleet_map')).sailing.find((x) => x.id === m.id), undefined, 'a stranger doesn\'t see it');

  // It lands: no penalty for crossing the sea with a fleet, and the shore is taken.
  await q(`update game.movements set arrive_at = now() where id = $1`, [m.id]);
  await q('select game.arrive($1)', [m.id]);
  const b = await one(`select * from game.battles where attacker_id = $1 and territory_id = $2 order by id desc limit 1`, [L.a, L.e]);
  assert.equal(b.winner, 'attacker');
  assert.equal(b.captured, true);
  assert.equal((await one('select controller_id from game.territories where id = $1', [L.e])).controller_id, L.a);
  // The fleet is docked there now, and shows on the map.
  const docked = (await rpc(p.client, 'fleet_map')).docked;
  assert.ok(docked.some((d) => d.t === L.e && d.rel === 'mine' && d.qty >= 1));

  // A new leader starts without the upgrades.
  await q('select game.nation_start($1, false)', [L.a]);
  assert.equal(Number((await one(`select count(*) c from game.nation_upgrades where nation_id = $1`, [L.a])).c), 0);
});
