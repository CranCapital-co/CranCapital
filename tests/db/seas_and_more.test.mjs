// Head starts, sending money to countries, allies overseas, the open-ended
// chat, sea routes and vital waterways, and buildings cut out of blocks.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, q, one, newPlayer, rpc, rpcError, ledgerMismatches } from './helpers.mjs';

after(async () => { await db.end(); });

const levelUp = async (id, level) =>
  q('select game.grant_xp($1, greatest(1, (select total from game.level_xp where level = $2)::int - coalesce((select xp from game.renown where player_id = $1), 0)::int), $3)', [id, level, 'test']);
const cash = async (id) => Number((await one('select cash from game.players where id = $1', [id])).cash);
const freeNation = async (skip = 0, extra = '') =>
  (await one(`select n.id from game.nations n join game.territories t on t.id = n.id
               where n.leader_id is null and n.status = 'active' and game.alliance_of(n.id) is null
                 and not exists (select 1 from game.war_sides s join game.wars w on w.id = s.war_id and w.status = 'active' where s.nation_id = n.id)
                 ${extra} order by n.id offset $1 limit 1`, [skip])).id;

test('a new player gets a head start, sized from the world, shown once', async () => {
  await q(`update game.config set value = 1 where key = 'head_start'`);
  try {
    const size = await one('select game.head_start_size() s');
    const p = await newPlayer('Newcomer');
    const hs = await rpc(p.client, 'my_head_start');
    assert.ok(hs, 'there is a head start to show');
    assert.equal(Number(hs.cash), Number(size.s.cash));
    assert.ok(Number(hs.cash) >= 50000000, 'at least $50,000');
    assert.equal(await cash(p.id), 10000000 + Number(hs.cash), 'start money plus the head start');
    assert.ok(hs.level >= 5);
    assert.equal(Number((await one('select level from game.renown where player_id = $1', [p.id])).level), hs.level);
    assert.ok(hs.perk_points >= hs.level - 1, 'the perk points the levels bring');
    assert.ok(Array.isArray(hs.unlocks) && hs.unlocks.length > 0, 'what the levels unlocked');
    assert.ok(Number((await one(`select (crates ->> 'gold')::int n from game.renown where player_id = $1`, [p.id])).n) >= 2);
    await rpc(p.client, 'head_start_seen');
    assert.equal(await rpc(p.client, 'my_head_start'), null, 'shown once');
    assert.deepEqual(await ledgerMismatches(), []);
  } finally {
    await q(`update game.config set value = 0 where key = 'head_start'`);
  }
});

test('send money to any country: AI treasuries, player leaders, goodwill capped, limits between players', async () => {
  const a = await newPlayer('Donor');
  const mine = await freeNation(0);
  await rpc(a.client, 'claim_nation', { p_id: mine });
  await q(`select game.money($1, 5000000000, 'admin', 'test money')`, [a.id]);
  const ai = await freeNation(3);
  const t0 = Number((await one('select treasury from game.nations where id = $1', [ai])).treasury);
  const c0 = await cash(a.id);
  const r = await rpc(a.client, 'send_money', { p_nation: ai, p_amount: 50000000 });
  assert.equal(await cash(a.id), c0 - 50000000);
  assert.equal(Number((await one('select treasury from game.nations where id = $1', [ai])).treasury), t0 + 50000000);
  assert.ok(Number(r.rel_delta) > 0, 'goodwill');
  assert.ok(r.reply, 'they say thank you');
  assert.ok(await one(`select 1 from game.diplo_chat where player_id = $1 and nation_id = $2 and not from_player and body = $3`, [a.id, ai, r.reply]));
  // However much you send, relations bought this way stop at +25 a day.
  for (let i = 0; i < 4; i++) await rpc(a.client, 'send_money', { p_nation: ai, p_amount: 500000000 });
  const gained = Number((await one(`select coalesce(sum(rel_delta), 0) s from game.diplo_chat where player_id = $1 and nation_id = $2 and not from_player and rel_delta > 0`, [a.id, ai])).s);
  assert.ok(gained <= 25, `gained ${gained}`);
  assert.match(await rpcError(a.client, 'send_money', { p_nation: ai, p_amount: 500 }), /at least \$1,000/);
  assert.match(await rpcError(a.client, 'send_money', { p_nation: mine, p_amount: 1000000 }), /your own country/);

  // To a player-led country: the leader gets it, with limits.
  const b = await newPlayer('Receiver');
  const theirs = await freeNation(6);
  await rpc(b.client, 'claim_nation', { p_id: theirs });
  assert.match(await rpcError(a.client, 'send_money', { p_nation: theirs, p_amount: 1000000 }), /3 days old/);
  await q(`update game.players set created_at = now() - interval '4 days' where id = $1`, [a.id]);
  await q('select game.refresh_worth($1)', [a.id]);
  const b0 = await cash(b.id);
  await rpc(a.client, 'send_money', { p_nation: theirs, p_amount: 2000000 });
  assert.equal(await cash(b.id), b0 + 2000000);
  assert.ok(await one(`select 1 from game.notifications where player_id = $1 and kind = 'gift'`, [b.id]));
  assert.match(await rpcError(a.client, 'send_money', { p_nation: theirs, p_amount: 1000000000 }), /a day to other players/);
  assert.deepEqual(await ledgerMismatches(), []);
});

test('allies overseas without a navy don\'t defend, and can\'t ship troops over without one', async () => {
  // b and c: allies, c's land far from b's (no land link), c with no navy.
  const pair = await one(`
    select b.id b, c.id c from game.nations b, game.nations c
     where b.leader_id is null and c.leader_id is null and b.status = 'active' and c.status = 'active' and b.id < c.id
       and game.alliance_of(b.id) is null and game.alliance_of(c.id) is null
       and not exists (select 1 from game.territory_links l where l.a = b.id and l.b = c.id)
       and not exists (select 1 from game.territory_links l join game.territories t on t.id = l.b where l.a = b.id and l.kind = 'land' and t.controller_id = c.id)
       and exists (select 1 from game.territory_links l where l.a = b.id and l.kind = 'sea')
     order by b.id limit 1`);
  await q(`delete from game.garrisons where nation_id = $1 and unit = 'naval'`, [pair.c]);
  const al = Number((await one(`select game.create_alliance_internal($1, 'Far Friends') id`, [pair.c])).id);
  await q('select game.join_alliance_internal($1, $2)', [pair.b, al]);
  const before = Number((await one('select game.defence_power($1, null, false) d', [pair.b])).d);
  await q(`select game.garrison_add($1, $2, 'infantry', 500)`, [pair.b, pair.c]);
  const without = Number((await one('select game.defence_power($1, null, false) d', [pair.b])).d);
  assert.equal(without, before, 'their troops overseas without a navy do not count');
  await q(`select game.garrison_add($1, $1, 'naval', 3)`, [pair.c]);
  const withNavy = Number((await one('select game.defence_power($1, null, false) d', [pair.b])).d);
  assert.ok(withNavy > before + 500, 'with a navy they do');
  // Shipping troops to an ally across a sea link needs fleets (or a navy).
  await q(`delete from game.garrisons where nation_id = $1 and unit = 'naval'`, [pair.c]);
  const sea = await one(`select l.b from game.territory_links l join game.territories t on t.id = l.b where l.a = $1 and l.kind = 'sea' and t.controller_id = $1 limit 1`, [pair.c]);
  if (sea) {
    // (c has a sea link into its own land only: nothing to test here.)
  }
  const across = await one(`select l.a f, l.b t from game.territory_links l join game.territories x on x.id = l.a join game.territories y on y.id = l.b
                              where l.kind = 'sea' and y.controller_id = $1 and x.controller_id <> $1 limit 1`, [pair.b]);
  if (across) {
    const from = across.f;
    const holder = (await one('select controller_id c from game.territories where id = $1', [from])).c;
    await q('select game.join_alliance_internal($1, $2)', [holder, al]).catch(() => {});
    if ((await one('select game.allied($1, $2) a', [holder, pair.b])).a) {
      await q(`delete from game.garrisons where nation_id = $1 and unit = 'naval'`, [holder]);
      await q(`select game.garrison_add($1, $2, 'infantry', 50)`, [from, holder]);
      await assert.rejects(q(`select game.do_send($1, $2, $3, '{"infantry": 10}'::jsonb)`, [holder, from, across.t]), /navy/);
    }
  }
});

test('AI countries answer anything, in their own voice, never "I don\'t know"', async () => {
  const p = await newPlayer('Chatty');
  const n = await freeNation(10);
  for (const msg of ['What food do you eat?', 'How is your economy?', 'Who is the strongest country in the world?', 'Should I build a navy?',
                     'Tell me a joke', 'What is the meaning of life?', 'I like turtles', 'Is the sky blue?']) {
    await q(`delete from game.rate_buckets where subject = $1`, [p.id]);
    await q(`delete from game.diplo_chat where player_id = $1`, [p.id]); // not pestering
    const r = await rpc(p.client, 'diplo_chat_send', { p_nation: n, p_text: msg });
    const body = r.reply?.body ?? r.body ?? r.reply ?? JSON.stringify(r);
    assert.doesNotMatch(String(body), /not sure what you want|don'?t know|ask (us|about) (about )?an alliance, a pact/i, `${msg} -> ${body}`);
    assert.ok(String(body).length > 8, `${msg} -> ${body}`);
  }
  const other = await one(`select id, name from game.nations where id <> $1 and status = 'active' order by id limit 1`, [n]);
  await q(`delete from game.rate_buckets where subject = $1`, [p.id]);
  const r = await rpc(p.client, 'diplo_chat_send', { p_nation: n, p_text: `What do you think of ${other.name}?` });
  assert.match(JSON.stringify(r), new RegExp(other.name));
});

test('sea routes go round the land, waterways can be closed or tolled, and a new holder reopens them', async () => {
  const base = await one(`select km, via from game.sea_routes where a = 'gbr' and b = 'ind'`);
  assert.ok(base.via.includes('suez'), 'Britain to India goes through Suez');
  const viaSuez = await one(`select game.sea_route(null, 'gbr', 'ind') r`);
  assert.equal(viaSuez.r.km, base.km);
  // Egypt closes the canal: the long way round Africa.
  await q(`update game.waterways set policy = 'closed' where id = 'suez'`);
  const round = (await one(`select game.sea_route(null, 'gbr', 'ind') r`)).r;
  assert.ok(round.km > base.km + 3000, 'much further');
  assert.ok(!round.via.includes('suez'));
  assert.ok(round.avoid.includes('suez'));
  // The Black Sea has one way in.
  await q(`update game.waterways set policy = 'closed' where id = 'bosphorus'`);
  const black = (await one(`select game.sea_route(null, 'gbr', 'rou') r`)).r;
  assert.equal(black.blocked, 'bosphorus');
  // A toll: paid to whoever holds the waterway.
  await q(`update game.waterways set policy = 'toll', toll = 5000000 where id = 'suez'`);
  const p = await newPlayer('Shipper');
  await q(`select game.money($1, 100000000, 'admin', 'test money')`, [p.id]);
  const egy = (await one(`select controller_id c from game.territories where id = 'egy'`)).c;
  const t0 = Number((await one('select treasury from game.nations where id = $1', [egy])).treasury);
  const c0 = await cash(p.id);
  const paid = Number((await one(`select game.pay_tolls($1, null, array['suez'], 'test') n`, [p.id])).n);
  assert.equal(paid, 5000000);
  assert.equal(await cash(p.id), c0 - 5000000);
  if (!(await one('select leader_id from game.nations where id = $1', [egy])).leader_id) {
    assert.equal(Number((await one('select treasury from game.nations where id = $1', [egy])).treasury), t0 + 5000000);
  }
  // Only the holder sets the rules.
  const lead = await newPlayer('Pharaoh');
  assert.match(await rpcError(lead.client, 'waterway_set', { p_id: 'suez', p_policy: 'open', p_toll: 0 }), /Pick a country|Only whoever holds/);
  await q(`update game.nations set leader_id = null, leader_since = null where id = 'egy'`);
  await rpc(lead.client, 'claim_nation', { p_id: 'egy' });
  const list = await rpc(lead.client, 'waterway_set', { p_id: 'suez', p_policy: 'allies', p_toll: 0 });
  const suez = list.find((w) => w.id === 'suez');
  assert.equal(suez.policy, 'allies');
  assert.equal(suez.mine, true);
  assert.match(await rpcError(lead.client, 'waterway_set', { p_id: 'panama', p_policy: 'closed', p_toll: 0 }), /Only whoever holds/);
  // Someone else takes Egypt: the canal opens again.
  const other = (await one(`select id from game.nations where id <> 'egy' and status = 'active' order by id limit 1`)).id;
  await q(`update game.territories set controller_id = $1 where id = 'egy'`, [other]);
  assert.equal((await one(`select policy from game.waterways where id = 'suez'`)).policy, 'open');
  await q(`update game.territories set controller_id = 'egy' where id = 'egy'`);
  await q(`update game.waterways set policy = 'open', toll = 0`);
  // Everyone's ships at sea, shared.
  const ws = await rpc(p.client, 'world_ships');
  assert.ok(Array.isArray(ws.cargo) && Array.isArray(ws.fleets));
  assert.deepEqual(await ledgerMismatches(), []);
});

test('troopships sail the real sea route, and a closed strait can shut them out', async () => {
  const p = await newPlayer('Navarch');
  await q(`update game.nations set leader_id = null, leader_since = null, protected_until = null where id in ('gbr', 'rou')`);
  await rpc(p.client, 'claim_nation', { p_id: 'gbr' });
  await levelUp(p.id, 20);
  await q(`delete from game.rate_buckets where subject = 'gbr'`);
  await q(`insert into game.nation_techs (nation_id, tech) values ('gbr', 'navy') on conflict do nothing`);
  await q(`insert into game.nation_upgrades (nation_id, track, level) values ('gbr', 'troopships', 5) on conflict (nation_id, track) do update set level = 5`);
  await q(`select game.garrison_add('gbr', 'gbr', 'naval', 4), game.garrison_add('gbr', 'gbr', 'infantry', 100)`);
  await q(`update game.nations set protected_until = null where id = 'gbr'`);
  await rpc(p.client, 'declare_war', { p_nation: 'rou' });
  await q(`update game.waterways set policy = 'closed' where id = 'bosphorus'`);
  try {
    assert.match(await rpcError(p.client, 'army_send', { p_from: 'gbr', p_to: 'rou', p_units: { naval: 2, infantry: 40 } }), /Bosphorus.*closed/);
    await q(`update game.waterways set policy = 'open' where id = 'bosphorus'`);
    const m = await rpc(p.client, 'army_send', { p_from: 'gbr', p_to: 'rou', p_units: { naval: 2, infantry: 40 } });
    const mv = await one('select * from game.movements where id = $1', [m.id]);
    const sea = Number((await one(`select km from game.sea_routes where a = 'gbr' and b = 'rou'`)).km);
    const minutes = (new Date(mv.arrive_at) - new Date(mv.depart_at)) / 60000;
    assert.ok(minutes > sea / 100, `${minutes} minutes for ${sea} km by sea`);
  } finally {
    await q(`update game.waterways set policy = 'open', toll = 0`);
  }
});

test('a block cut into lots: businesses, rooms and owners move to the lots', async () => {
  const p = await newPlayer('Landlord');
  const c = await one(`select * from game.cities where id = 'london'`);
  const parent = 990000000001;
  await q(`insert into game.buildings (id, city_id, lat, lng, footprint_m2, height_m, levels, rooms_total, kind, landmark, traffic, owner_id, bought_price)
           values ($1, 'london', $2, $3, 10000, 20, 6, 240, 'mixed', false, 1, $4, 100000000)
           on conflict (id) do update set owner_id = excluded.owner_id, bought_price = excluded.bought_price, split = false`, [parent, c.start_lat, c.start_lng, p.id]);
  for (let k = 0; k < 4; k++) {
    await q(`insert into game.buildings (id, city_id, lat, lng, footprint_m2, height_m, levels, rooms_total, kind, landmark, traffic, parent_id)
             values ($1, 'london', $2, $3, 2500, 20, 6, 60, 'mixed', false, 1, $4) on conflict (id) do nothing`,
      [1e14 + parent * 1000 + k + 1, c.start_lat + (k % 2) * 0.0004, c.start_lng + Math.floor(k / 2) * 0.0006, parent]);
  }
  const biz = await one(`insert into game.businesses (owner_id, city_id, kind, name, lat, lng, building_id)
                         values ($1, 'london', 'cart', 'Corner shop', $2, $3, $4) returning id`, [p.id, c.start_lat + 0.0004, c.start_lng + 0.0006, parent]);
  await q(`update game.buildings set split = true where id = $1`, [parent]);
  await q(`select game.remap_split_buildings('london')`);
  const moved = await one('select building_id from game.businesses where id = $1', [biz.id]);
  assert.equal(Number(moved.building_id), 1e14 + parent * 1000 + 4, 'to the lot it stands in');
  const owned = Number((await one('select count(*) c from game.buildings where parent_id = $1 and owner_id = $2', [parent, p.id])).c);
  assert.equal(owned, 4, 'the owner of the block owns every lot');
  assert.equal((await one('select owner_id from game.buildings where id = $1', [parent])).owner_id, null, 'and not the block');
  const paid = Number((await one('select sum(bought_price) s from game.buildings where parent_id = $1', [parent])).s);
  assert.equal(paid, 100000000, 'the price paid is shared out by floor space');
  await q('delete from game.businesses where id = $1', [biz.id]);
  await q('delete from game.buildings where parent_id = $1 or id = $1', [parent]);
});
