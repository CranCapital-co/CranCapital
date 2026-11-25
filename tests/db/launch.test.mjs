// Before launch: press everything. Every business type can be built, every
// military building (minefields too) and every unit can be bought, and the
// new no-walking, cash-paid, troops-on-the-map rules hold together.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, q, one, newPlayer, rpc, rpcError, streetNear, ledgerMismatches } from './helpers.mjs';

after(async () => { await db.end(); });

before(async () => {
  await q('update game.nations set leader_id = null, leader_since = null');
  await q('select game.world_reset()');
});

const levelUp = async (id, level) =>
  q('select game.grant_xp($1, greatest(1, (select total from game.level_xp where level = $2)::int - coalesce((select xp from game.renown where player_id = $1), 0)::int), $3)', [id, level, 'test']);
const unthrottle = (id) => q('delete from game.rate_buckets where subject = $1', [String(id)]);
const cashOf = async (id) => Number((await one('select cash from game.players where id = $1', [id])).cash);

// A buildable London plot nobody owns, optionally by the water.
async function freePlot(skip = 0, coastal = false) {
  return one(
    `with c as (select * from game.cities where id = 'london')
     select x px, y py, (game.plot_center(c, x, y)).lat lat, (game.plot_center(c, x, y)).lng lng
       from c, generate_series(0, c.plot_w - 1) x, generate_series(0, c.plot_h - 1) y
      where game.plot_buildable(c, x, y) and ($2 = false or game.plot_coastal(c, x, y))
        and not exists (select 1 from game.plots p where p.city_id = 'london' and p.px = x and p.py = y)
        and not exists (select 1 from game.deposits d where d.city_id = 'london' and d.px = x and d.py = y)
      order by x, y offset $1 limit 1`,
    [skip, coastal]
  );
}

test('every business type can be built, by tapping (no walking)', async () => {
  const p = await newPlayer('Tycoon');
  await q('update game.players set tier = 6 where id = $1', [p.id]);
  await q(`select game.money($1, 200000000000, 'admin', 'test funds')`, [p.id]);
  const types = await q('select id, placement, resource from game.business_types order by sort');
  const built = {};
  const city = await one(`select * from game.cities where id = 'london'`);

  // Street: a cart, far from where the player "is".
  await unthrottle(p.id);
  const spot = await streetNear('london', city.start_lat + 0.01, city.start_lng + 0.02, 5);
  built.cart = (await rpc(p.client, 'buy_cart', { p_name: 'Launch Cart', p_lat: spot.lat, p_lng: spot.lng })).business_id;

  // Rooms: one in a different building each.
  const rooms = types.filter((t) => t.placement === 'room');
  const blds = await q(
    `select b.id, b.lat, b.lng from game.buildings b where b.city_id = 'london' and not b.landmark and b.rooms_total > 2
        and not exists (select 1 from game.businesses x where x.building_id = b.id and x.status in ('open', 'closed'))
      order by game.dist_m(b.lat, b.lng, $1, $2) limit $3`,
    [city.start_lat, city.start_lng, rooms.length]
  );
  for (const [i, t] of rooms.entries()) {
    await unthrottle(p.id);
    const b = blds[i];
    built[t.id] = (await rpc(p.client, 'rent_room', { p_building: b.id, p_kind: t.id, p_name: `Launch ${t.id}`, p_lat: b.lat, p_lng: b.lng })).business_id;
  }

  // Plots: farms, yards, apartments and every factory.
  let skip = 0;
  for (const t of types.filter((x) => x.placement === 'plot')) {
    await unthrottle(p.id);
    const pl = await freePlot(skip++);
    await rpc(p.client, 'buy_plot', { p_city: 'london', p_px: pl.px, p_py: pl.py, p_lat: pl.lat, p_lng: pl.lng });
    await unthrottle(p.id);
    built[t.id] = (await rpc(p.client, 'build_on_plot', { p_city: 'london', p_px: pl.px, p_py: pl.py, p_kind: t.id, p_name: `Launch ${t.id}`, p_option: null })).business_id;
  }

  // The port, on the water.
  await unthrottle(p.id);
  const wet = await freePlot(0, true);
  assert.ok(wet, 'London has a plot by the water');
  await rpc(p.client, 'buy_plot', { p_city: 'london', p_px: wet.px, p_py: wet.py, p_lat: wet.lat, p_lng: wet.lng });
  await unthrottle(p.id);
  built.port = (await rpc(p.client, 'build_on_plot', { p_city: 'london', p_px: wet.px, p_py: wet.py, p_kind: 'port', p_name: 'Launch Port', p_option: null })).business_id;

  // Mines: survey a block by tapping it, then dig each kind of deposit.
  const mines = types.filter((x) => x.placement === 'deposit');
  const site = await freePlot(40);
  await unthrottle(p.id);
  const s = await rpc(p.client, 'survey', { p_lat: site.lat, p_lng: site.lng });
  assert.ok(Array.isArray(s.deposits), 'survey works without walking there');
  const bx = Math.floor(site.px / 8);
  const by = Math.floor(site.py / 8);
  const cells = await q(
    `with c as (select * from game.cities where id = 'london')
     select x px, y py, (game.plot_center(c, x, y)).lat lat, (game.plot_center(c, x, y)).lng lng
       from c, generate_series($1 * 8, $1 * 8 + 7) x, generate_series($2 * 8, $2 * 8 + 7) y
      where game.plot_buildable(c, x, y) and not exists (select 1 from game.plots p where p.city_id = 'london' and p.px = x and p.py = y)
      order by x, y`,
    [bx, by]
  );
  assert.ok(cells.length >= mines.length, `room in the block for ${mines.length} mines`);
  for (const [i, t] of mines.entries()) {
    const cell = cells[i];
    // Deposits are random; make sure this cell holds the right resource.
    await q(
      `insert into game.deposits (city_id, px, py, bx, by, resource, units_total, units_left) values ('london', $1, $2, $3, $4, $5, 100000, 100000)
       on conflict (city_id, px, py) do update set resource = excluded.resource, units_left = 100000, bx = excluded.bx, by = excluded.by`,
      [cell.px, cell.py, bx, by, t.resource]
    );
    await unthrottle(p.id);
    await rpc(p.client, 'buy_plot', { p_city: 'london', p_px: cell.px, p_py: cell.py, p_lat: cell.lat, p_lng: cell.lng });
    await unthrottle(p.id);
    built[t.id] = (await rpc(p.client, 'build_on_plot', { p_city: 'london', p_px: cell.px, p_py: cell.py, p_kind: t.id, p_name: `Launch ${t.id}`, p_option: null })).business_id;
  }

  for (const t of types) assert.ok(built[t.id], `built a ${t.id}`);
  assert.equal(Object.keys(built).length, types.length);

  // Each one opens in the business window.
  for (const id of Object.values(built)) assert.ok((await rpc(p.client, 'business_detail', { p_id: id })).id);

  // A mine produces on the tick (it burns diesel).
  await q(`select game.stock_add($1, 'london', 'diesel', 100, false)`, [p.id]);
  await q(`update game.businesses set last_tick_at = now() - interval '1 hour' where id = $1`, [built.coal_mine]);
  await q('call game.tick()');
  const st = await rpc(p.client, 'my_storage');
  assert.ok((st.find((x) => x.city_id === 'london')?.goods ?? []).some((g) => g.good === 'coal' && g.qty > 0), 'the coal mine dug coal');

  // The port ships, and the boat shows up in my_ships with where it sails.
  await q(`select game.stock_add($1, 'london', 'coal', 1000, false)`, [p.id]);
  await unthrottle(p.id);
  const sh = await rpc(p.client, 'ship', { p_port: built.port, p_good: 'coal', p_qty: 500, p_to: 'paris', p_kind: 'export' });
  assert.ok(sh.shipment_id);
  const ships = await rpc(p.client, 'my_ships');
  const boat = ships.find((x) => x.id === sh.shipment_id);
  assert.ok(boat, 'my ship is listed');
  assert.ok(boat.from && boat.to, 'with its route');
  assert.deepEqual(await ledgerMismatches(), []);
});

test('cities: switching is instant and free; no taxis, no walking', async () => {
  const p = await newPlayer('Jetsetter');
  const before = await cashOf(p.id);
  assert.equal(Number((await rpc(p.client, 'travel_quote', { p_city: 'paris' })).cost ?? 0), 0);
  await rpc(p.client, 'travel', { p_city: 'paris' });
  const me = await rpc(p.client, 'get_me');
  assert.equal(me.city_id ?? me.city, 'paris');
  assert.equal(await cashOf(p.id), before, 'it cost nothing');
  await q('delete from game.rate_buckets where subject = $1', [String(p.id)]);
  await rpc(p.client, 'travel', { p_city: 'london' });
  assert.match(await rpcError(p.client, 'taxi', { p_lat: 51.5, p_lng: -0.1 }), /no taxis/);
});

test('every military building and every unit can be bought with your cash', async () => {
  const a = await newPlayer('Marshal');
  // A coastal country (for the naval base and fleets).
  const home = await one(
    `select n.id from game.nations n join game.territories t on t.id = n.id
      where n.leader_id is null and n.status = 'active' and not t.landlocked and t.controller_id = n.id
        and game.alliance_of(n.id) is null and not exists (select 1 from game.war_sides s where s.nation_id = n.id)
      order by t.pop_m desc offset 5 limit 1`
  );
  await rpc(a.client, 'claim_nation', { p_id: home.id });
  await levelUp(a.id, 25);
  await q(`select game.money($1, 50000000000, 'admin', 'test funds')`, [a.id]);
  await q('insert into game.nation_techs (nation_id, tech) select $1, id from game.techs on conflict do nothing', [home.id]);
  await q('update game.nations set manpower = 1000000 where id = $1', [home.id]);

  const kinds = (await q('select id from game.facility_types order by sort')).map((x) => x.id);
  for (const k of kinds) {
    await unthrottle(a.id);
    const c0 = await cashOf(a.id);
    const r = await rpc(a.client, 'nation_build', { p_territory: home.id, p_kind: k });
    assert.ok(Number(r.cost) > 0, `${k} has a price`);
    assert.equal(await cashOf(a.id), c0 - Number(r.cost), `${k} is paid from your cash`);
    await q(`update game.facilities set ready_at = now() - interval '1 second' where territory_id = $1`, [home.id]);
    await q('select game.world_tick()');
  }
  for (const k of kinds) {
    assert.ok(Number((await one(`select coalesce(max(level), 0) l from game.facilities where territory_id = $1 and kind = $2`, [home.id, k])).l) >= 1, `${k} finished`);
  }

  const units = (await q('select id from game.unit_types order by sort')).map((x) => x.id);
  for (const u of units) {
    await unthrottle(a.id);
    const c0 = await cashOf(a.id);
    const r = await rpc(a.client, 'nation_recruit', { p_territory: home.id, p_unit: u, p_qty: 1 });
    assert.ok(Number(r.cost) > 0, `${u} has a price`);
    assert.equal(await cashOf(a.id), c0 - Number(r.cost), `${u} is paid from your cash`);
  }
  await q(`update game.recruit_queue set ready_at = now() - interval '1 second' where nation_id = $1`, [home.id]);
  await q('select game.world_tick()');

  // The world map sees them.
  const tm = await rpc(a.client, 'troop_map');
  const mine = tm.garrisons.find((g) => g.t === home.id && g.rel === 'mine');
  assert.ok(mine && mine.total > 0, 'my garrison is on the map');
  assert.deepEqual(await ledgerMismatches(), []);
});

test('minefields thin out an invading army, and the invasion shows on the map', async () => {
  const a = await newPlayer('Sapper');
  const pair = await one(
    `select l.a, l.b from game.territory_links l
       join game.nations x on x.id = l.a join game.nations y on y.id = l.b
      where l.kind = 'land' and x.leader_id is null and y.leader_id is null and x.status = 'active' and y.status = 'active'
        and game.alliance_of(x.id) is null and game.alliance_of(y.id) is null
        and not exists (select 1 from game.war_sides s where s.nation_id in (x.id, y.id))
      order by l.a desc, l.b offset 4 limit 1`
  );
  await rpc(a.client, 'claim_nation', { p_id: pair.a });
  await levelUp(a.id, 6);
  await q(`select game.money($1, 1000000000, 'admin', 'test funds')`, [a.id]);
  await q(`update game.nations set protected_until = null where id = any($1)`, [[pair.a, pair.b]]);
  // The defender has three levels of minefield.
  await q(`insert into game.facilities (territory_id, kind, level) values ($1, 'minefield', 3)
           on conflict (territory_id, kind) do update set level = 3, ready_at = null`, [pair.b]);
  await rpc(a.client, 'declare_war', { p_nation: pair.b });
  await q(`update game.garrisons set qty = 1000 where territory_id = $1 and nation_id = $1 and unit = 'infantry'`, [pair.a]);
  const m = await rpc(a.client, 'army_send', { p_from: pair.a, p_to: pair.b, p_units: { infantry: 1000 } });

  // On its way, it's on my troop map.
  const tm = await rpc(a.client, 'troop_map');
  assert.ok(tm.moves.some((x) => x.id === m.id && x.mine), 'my army is on the map');

  await q(`update game.movements set arrive_at = now() - interval '1 second' where id = $1`, [m.id]);
  await q('select game.arrive($1)', [m.id]);
  const n = await one(`select * from game.notifications where player_id = $1 and title like 'Minefields at%' order by id desc limit 1`, [a.id]);
  assert.ok(n, 'told about the minefields');
  assert.match(n.body, /180 infantry/, '18% of 1,000 lost to three levels of mines');
});
