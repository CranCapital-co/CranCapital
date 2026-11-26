// The latest round: admin cheats, a world that never resets, coalitions
// against the big powers, talking to AI countries, and jobs that never keep
// a player's row locked.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { db, q, one, newPlayer, rpc, rpcError, ledgerMismatches } from './helpers.mjs';

after(async () => { await db.end(); });

before(async () => {
  await q('update game.nations set leader_id = null, leader_since = null');
  await q('select game.world_reset()');
  await q('delete from game.coalition_members');
  await q('delete from game.coalitions');
});

const unthrottle = (id) => q('delete from game.rate_buckets where subject = $1', [String(id)]);
const cashOf = async (id) => Number((await one('select cash from game.players where id = $1', [id])).cash);

async function leader(name, skip = 0) {
  const p = await newPlayer(name);
  const n = await one(
    `select n.id from game.nations n join game.territories t on t.id = n.id
      where n.leader_id is null and n.status = 'active' and t.controller_id = n.id and game.alliance_of(n.id) is null
        and not exists (select 1 from game.war_sides s where s.nation_id = n.id)
      order by t.pop_m offset $1 limit 1`, [skip]);
  await rpc(p.client, 'claim_nation', { p_id: n.id });
  await q(`update game.nations set protected_until = null where id = $1`, [n.id]);
  return { ...p, nation: n.id };
}

test('admin cheats work for admins only, and keep the ledger exact', async () => {
  const a = await leader('Admin', 3);
  const b = await newPlayer('Nobody');
  assert.match(await rpcError(b.client, 'admin_cheat', { p_action: 'money', p_args: { dollars: 1000 } }), /Only staff/);
  await q(`update game.players set role = 'admin' where id = $1`, [a.id]);
  const c0 = await cashOf(a.id);
  await rpc(a.client, 'admin_cheat', { p_action: 'money', p_args: { dollars: 1e9 } });
  assert.equal(await cashOf(a.id), c0 + 1e12);
  await rpc(a.client, 'admin_cheat', { p_action: 'money', p_args: { dollars: 500, player: b.name } });
  assert.equal(await cashOf(b.id), (await one('select sum(amount) s from game.ledger where player_id = $1', [b.id])).s * 1);
  const lv = await rpc(a.client, 'admin_cheat', { p_action: 'levels', p_args: { n: 20 } });
  assert.ok(Number(lv.message.match(/level (\d+)/)[1]) >= 21, lv.message);
  await rpc(a.client, 'admin_cheat', { p_action: 'all_tech' });
  assert.ok(Number((await one('select count(*) c from game.nation_techs where nation_id = $1', [a.nation])).c) >= 20);
  await rpc(a.client, 'admin_cheat', { p_action: 'troops', p_args: { unit: 'armor', qty: 250 } });
  const far = (await one(`select id from game.territories where controller_id <> $1 and owner_id <> $1 order by value limit 1`, [a.nation])).id;
  await rpc(a.client, 'admin_cheat', { p_action: 'annex', p_args: { territory: far } });
  assert.equal((await one('select controller_id from game.territories where id = $1', [far])).controller_id, a.nation);
  await rpc(a.client, 'admin_cheat', { p_action: 'finish' });
  assert.match(await rpcError(a.client, 'admin_cheat', { p_action: 'nope' }), /Unknown cheat/);
  assert.ok(Number((await one('select count(*) c from game.admin_log where admin_id = $1', [a.id])).c) >= 7, 'every cheat is logged');
  assert.equal((await one(`select game.fmt(5000) f`)).f, '$5.00');
  assert.deepEqual(await ledgerMismatches(), []);
});

test('the world never resets, and a conqueror faces a coalition (big countries don\'t)', async () => {
  const before = Number((await one(`select count(*) c from game.territories where owner_id = id`)).c);
  // Natural giants (China, the United States) get no coalition.
  await q('select game.world_scores()');
  assert.equal(Number((await one(`select count(*) c from game.coalitions where ended_at is null`)).c), 0);
  assert.ok((await one(`select world_rank from game.nations where id = 'chn'`)).world_rank <= 2, 'world ranks are set');
  // Germany grabs ~20% of the world.
  await q(`with tot as (select sum(value) v from game.territories),
              pick as (select t.id, sum(t.value) over (order by t.lat desc, t.id) run from game.territories t
                        where t.continent = 'Europe' and t.id <> 'deu')
           update game.territories t set owner_id = 'deu', controller_id = 'deu' from pick, tot where pick.id = t.id and pick.run < tot.v * 0.19`);
  await q('select game.world_scores()');
  const c = await one(`select c.id, count(m.*) n from game.coalitions c left join game.coalition_members m on m.coalition_id = c.id
                        where c.target_id = 'deu' and c.ended_at is null group by c.id`);
  assert.ok(c && Number(c.n) >= 5, `a coalition formed (${c?.n} members)`);
  assert.ok(await one(`select 1 from game.world_news where kind = 'coalition' and title like '%Germany%'`));
  // The members go to war together.
  await q(`update game.nations set ai = ai || jsonb_build_object('coalition_at', now() - interval '1 hour'), stability = 80, next_think_at = now() - interval '1 second'
            where id in (select nation_id from game.coalition_members where coalition_id = $1)`, [c.id]);
  await q(`select game.world_ai_one(nation_id) from game.coalition_members where coalition_id = $1`, [c.id]);
  const fighting = Number((await one(`select count(distinct s.nation_id) n from game.war_sides s join game.wars w on w.id = s.war_id and w.status = 'active'
                                      where s.war_id in (select war_id from game.war_sides where nation_id = 'deu') and s.nation_id <> 'deu'`)).n);
  assert.ok(fighting >= 3, `coalition members at war with the conqueror (${fighting})`);
  // They won't sign a pact with it.
  const member = (await one(`select nation_id from game.coalition_members where coalition_id = $1 limit 1`, [c.id])).nation_id;
  const o = await one(`select * from game.diplo_offers limit 0`);
  assert.equal((await one(`select game.ai_accepts(row(null, 'nap', 'deu', $1, null, '{}'::jsonb, 'open', now(), now())::game.diplo_offers) ok`, [member])).ok, false);
  // No era, no reset: the map is untouched by scoring.
  assert.equal(await one(`select 1 from game.eras where ended_at is null`), undefined);
  // Back to normal: the coalition disbands.
  await q(`update game.territories set owner_id = id, controller_id = id where owner_id = 'deu' or controller_id = 'deu'`);
  await q(`update game.wars set status = 'ended' where status = 'active'`);
  await q('select game.world_scores()');
  assert.ok((await one(`select ended_at from game.coalitions where id = $1`, [c.id])).ended_at, 'disbanded');
  assert.equal(Number((await one(`select count(*) c from game.territories where owner_id = id`)).c), before);
});

test('talking to countries: personalities, reasons, offers you can accept', async () => {
  const a = await leader('Talker', 10);
  await q(`select game.money($1, 1000000000, 'admin', 'test')`, [a.id]);
  const pick = async (pers) => one(`select id, name from game.nations where leader_id is null and status = 'active' and personality = $1
                                     and not game.at_war(id, $2) and game.alliance_of(id) is null order by id limit 1`, [pers, a.nation]);
  const dip = await pick('diplomatic');
  const say = async (n, text) => { await unthrottle(a.id); return rpc(a.client, 'diplo_chat_send', { p_nation: n.id, p_text: text }); };

  const hi = await say(dip, 'Hello!');
  assert.ok(hi.body.length > 3, 'they always answer');
  assert.equal(hi.intent, 'greeting');
  const why = await say(dip, 'Why did you not alliance with me?');
  assert.equal(why.intent, 'why_no');
  assert.match(why.body, /Since you ask/);
  // An insult hurts relations; a compliment helps (a little).
  const r0 = Number((await one('select game.rel($1, $2) r', [a.nation, dip.id])).r);
  const ins = await say(dip, 'You are pathetic and stupid');
  assert.ok(ins.rel_delta < 0);
  assert.ok(Number((await one('select game.rel($1, $2) r', [a.nation, dip.id])).r) < r0);
  const nice = await say(dip, 'Thank you, we really respect your nation');
  assert.ok(nice.rel_delta > 0);

  // A pact: it pops up as an offer, and accepting it signs a real treaty.
  const nap = await say(dip, 'Can we sign a non-aggression pact?');
  assert.ok(nap.offer, 'an offer');
  await rpc(a.client, 'diplo_chat_answer', { p_message: nap.id, p_accept: true });
  assert.ok(await one(`select 1 from game.treaties where kind = 'nap' and a = least($1, $2) and b = greatest($1, $2)`, [a.nation, dip.id]));
  assert.match(await rpcError(a.client, 'diplo_chat_answer', { p_message: nap.id, p_accept: true }), /closed/);

  // A gift: pay, and relations jump.
  const merc = await pick('mercantile');
  const g = await say(merc, "I'll give you $10k as a gift");
  assert.equal(g.offer.kind, 'gift');
  const c0 = await cashOf(a.id);
  const rel0 = Number((await one('select game.rel($1, $2) r', [a.nation, merc.id])).r);
  await rpc(a.client, 'diplo_chat_answer', { p_message: g.id, p_accept: true });
  assert.equal(await cashOf(a.id), c0 - 10000000);
  assert.ok(Number((await one('select game.rel($1, $2) r', [a.nation, merc.id])).r) > rel0 + 5);

  // Pay a country to go to war with a rival.
  const rival = await one(`select id, name from game.nations where leader_id is null and status = 'active' and id not in ($1, $2)
                            and not game.allied(id, $2) and (game.treaty(id, $2)).id is null and game.rel(id, $2) < 30
                            and protected_until is null order by power desc limit 1`, [a.nation, merc.id]);
  const help = await say(merc, `Will you help me attack ${rival.name}?`);
  assert.equal(help.intent, 'war_help');
  if (help.offer?.kind === 'join_war') {
    await rpc(a.client, 'diplo_chat_answer', { p_message: help.id, p_accept: true });
    assert.equal((await one('select game.at_war($1, $2) w', [merc.id, rival.id])).w, true, 'they went to war');
  }

  // Pestering gets curt replies (but still a reply).
  for (let i = 0; i < 8; i++) await say(merc, 'hey');
  const spam = await say(merc, 'hey');
  assert.equal(spam.intent, 'spam');

  // A player-led country: the message is passed on.
  const other = await leader('Listener', 20);
  const passed = await say({ id: other.nation }, 'Hi there, fellow leader');
  assert.match(passed.body, /led by a player/);
  assert.ok(await one(`select 1 from game.notifications where player_id = $1 and body = 'Hi there, fellow leader'`, [other.id]));

  const hist = await rpc(a.client, 'diplo_chat_history', { p_nation: dip.id });
  assert.ok(hist.messages.length >= 10);
  assert.ok(hist.messages.some((m) => m.offer?.status === 'accepted'));
  const list = await rpc(a.client, 'diplo_chat_list');
  assert.ok(list.some((x) => x.nation === dip.id));
  assert.deepEqual(await ledgerMismatches(), []);
});

test('jobs commit as they go: a player is never stuck behind the world tick', async () => {
  const a = await leader('Busy', 30);
  await q(`update game.nations set last_econ_at = now() - interval '61 minutes' where status = 'active'`);
  const other = new pg.Client({ connectionString: process.env.LOCAL_DB_URL || 'postgres://postgres:postgres@127.0.0.1:54322/postgres' });
  await other.connect();
  try {
    let done = false;
    let worst = 0;
    const job = other.query('call game.world_run()').then(() => { done = true; });
    while (!done) {
      const t = performance.now();
      await q(`select game.money($1, 1, 'admin', 'lock test')`, [a.id]);
      worst = Math.max(worst, performance.now() - t);
    }
    await job;
    assert.ok(worst < 250, `worst wait for the player's row ${worst.toFixed(0)} ms`);
    // The heartbeat never waits for a busy row.
    await q(`update game.players set last_seen_at = now() - interval '1 minute' where id = $1`, [a.id]);
    await other.query('begin');
    await other.query('select 1 from game.players where id = $1 for update', [a.id]);
    const t = performance.now();
    await rpc(a.client, 'heartbeat');
    assert.ok(performance.now() - t < 2000, 'heartbeat answered while the row was locked');
    await other.query('rollback');
  } finally {
    await other.end();
  }
  assert.deepEqual(await ledgerMismatches(), []);
});

test('no farming through chat: deals, gifts, compliments and demands are limited', async () => {
  const a = await leader('Farmer', 40);
  await q(`select game.money($1, 2000000000, 'admin', 'test')`, [a.id]);
  const n = await one(`select id, name from game.nations where leader_id is null and status = 'active' and personality = 'balanced'
                        and not game.at_war(id, $1) and game.alliance_of(id) is null order by id offset 2 limit 1`, [a.nation]);
  // Spread the messages out (more than 8 in 10 minutes counts as pestering).
  const say = async (text) => {
    await unthrottle(a.id);
    await q(`update game.diplo_chat set at = at - interval '11 minutes' where player_id = $1 and nation_id = $2 and from_player and at > now() - interval '10 minutes'`, [a.id, n.id]);
    return rpc(a.client, 'diplo_chat_send', { p_nation: n.id, p_text: text });
  };
  const rel = async () => Number((await one('select game.rel($1, $2) r', [a.nation, n.id])).r);
  const cash0 = await cashOf(a.id);

  // Asking for money never pays out, and isn't mistaken for a gift.
  for (const t of ['Pay me 1 million', 'Give us money or else', 'I want 50000 dollars']) {
    const r = await say(t);
    assert.equal(r.intent, 'demand', t);
    assert.ok(!r.offer, 'no offer for a demand');
  }
  assert.ok(await cashOf(a.id) <= cash0, 'no money from asking');

  // Buying goodwill: one offer at a time, two a day, each dearer.
  const r0 = await rel();
  const d1 = await say('I want to make a deal');
  assert.equal(d1.offer?.kind, 'tribute');
  assert.equal((await say('Another deal please')).intent, 'pending', 'one open offer at a time');
  await rpc(a.client, 'diplo_chat_answer', { p_message: d1.id, p_accept: true });
  const d2 = await say('I want to make another deal');
  assert.equal(d2.offer?.kind, 'tribute');
  assert.ok(Number(d2.offer.price) > Number(d1.offer.price), 'the second deal costs more');
  await rpc(a.client, 'diplo_chat_answer', { p_message: d2.id, p_accept: true });
  const d3 = await say('I want to make another deal');
  assert.equal(d3.intent, 'enough');
  assert.ok(!d3.offer, 'no third deal today');
  const g = await say("I'll give you $50k as a gift");
  assert.equal(g.intent, 'enough', 'no more paid goodwill today');
  assert.ok((await rel()) - r0 <= 25.5, `relations bought in a day are capped (${(await rel()) - r0})`);

  // Compliments: a little a day, then nothing.
  let total = 0;
  for (let i = 0; i < 6; i++) total += Number((await say('Thank you, you are wise and great')).rel_delta);
  assert.ok(total <= 4, `compliments capped (${total})`);
  assert.equal(Number((await say('Hello')).rel_delta), 0, 'greetings are free and give nothing');
  assert.deepEqual(await ledgerMismatches(), []);
});
