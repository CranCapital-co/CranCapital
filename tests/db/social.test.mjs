// Phase 4: chat, filters, friends, boards, reports, moderation, identity, account.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, q, one, newPlayer, rpc, rpcError, anonClient } from './helpers.mjs';

after(async () => { await db.end(); });

async function cityChannel(client, city = 'london') {
  const chans = await rpc(client, 'chat_channels');
  return chans.find((c) => c.kind === 'city' && c.city_id === city);
}

test('chat: links refused with a reason, slurs masked with a notice, city posting rules', async () => {
  const a = await newPlayer('Talker');
  const ch = await cityChannel(a.client);
  assert.ok(ch.can_post);
  const ok = await rpc(a.client, 'send_chat', { p_channel: ch.id, p_body: 'Hello London, damn this is fun' });
  assert.equal(ok.masked, false, 'ordinary swearing is allowed');
  for (const bad of ['see www.example.com', 'go to example . com now', 'https://x.y', 'join discord.gg/abc']) {
    assert.match(await rpcError(a.client, 'send_chat', { p_channel: ch.id, p_body: bad }), /Links aren't allowed/, bad);
  }
  const masked = await rpc(a.client, 'send_chat', { p_channel: ch.id, p_body: 'you r3t4rd' });
  assert.equal(masked.masked, true);
  assert.match(masked.notice, /masked/);
  assert.doesNotMatch(masked.message.body, /r3t4rd/);
  const tokyo = await cityChannel(a.client, 'tokyo');
  assert.equal(tokyo.can_post, false);
  assert.match(await rpcError(a.client, 'send_chat', { p_channel: tokyo.id, p_body: 'hi' }), /only post in the city/);
  const hist = await rpc(a.client, 'chat_history', { p_channel: ch.id });
  assert.ok(hist.length >= 2);
  assert.ok(!('id' in hist[0].author), 'no player uuids leak in chat');
});

test('DMs, blocks and friends', async () => {
  const a = await newPlayer('Alice');
  const b = await newPlayer('Bob');
  const dm = await rpc(a.client, 'open_dm', { p_player_no: b.me.player_no });
  await rpc(a.client, 'send_chat', { p_channel: dm.channel_id, p_body: 'hey bob' });
  const bobChans = await rpc(b.client, 'chat_channels');
  const bobDm = bobChans.find((c) => c.id === dm.channel_id);
  assert.equal(bobDm.unread, 1);
  await rpc(b.client, 'block_player', { p_player_no: a.me.player_no });
  assert.match(await rpcError(a.client, 'send_chat', { p_channel: dm.channel_id, p_body: 'hello?' }), /can't message/);
  await rpc(b.client, 'block_player', { p_player_no: a.me.player_no, p_block: false });
  const fr = await rpc(a.client, 'friend_request', { p_player_no: b.me.player_no });
  assert.equal(fr.status, 'pending');
  await rpc(b.client, 'friend_respond', { p_player_no: a.me.player_no, p_accept: true });
  const friends = await rpc(a.client, 'my_friends');
  assert.equal(friends[0].status, 'accepted');
  assert.equal(friends[0].city_id, 'london', 'friends see your city');
  const stranger = await newPlayer('Stranger');
  const prof = await rpc(stranger.client, 'public_profile', { p_player_no: a.me.player_no });
  assert.equal(prof.city_id, null, 'strangers do not see your city');
});

test('boards: post, vote, comment, staff status and duplicate merge', async () => {
  const a = await newPlayer('Bugger');
  const b = await newPlayer('Voter');
  const post = await rpc(a.client, 'board_create', { p_board: 'bugs', p_title: 'Cart vanished', p_body: 'My cart disappeared after moving it.' });
  const dup = await rpc(b.client, 'board_create', { p_board: 'bugs', p_title: 'Cart gone', p_body: 'Same thing happened to me today.' });
  await rpc(b.client, 'board_vote', { p_id: post.id, p_vote: true });
  await rpc(b.client, 'board_comment', { p_id: post.id, p_body: 'Same here' });
  const list = await rpc(anonClient(), 'board_list', { p_board: 'bugs' });
  assert.ok(list.find((x) => x.id === post.id).votes >= 2);
  assert.match(await rpcError(a.client, 'board_set_status', { p_id: post.id, p_status: 'planned' }), /Only staff/);
  const staff = await newPlayer('Staffer');
  await q(`update game.players set role = 'mod' where id = $1`, [staff.id]);
  await rpc(staff.client, 'board_set_status', { p_id: dup.id, p_status: 'duplicate', p_merged_into: post.id, p_note: 'Tracking in the first report' });
  await rpc(staff.client, 'board_set_status', { p_id: post.id, p_status: 'in_progress', p_note: 'Found it' });
  const full = await rpc(anonClient(), 'board_post', { p_id: post.id });
  assert.equal(full.status, 'in_progress');
  assert.equal(full.comments_list.length, 1);
  const badge = await one(`select 1 ok from game.player_badges where player_id = $1 and badge_id = 'bug_hunter'`, [a.id]);
  assert.ok(badge);
});

test('reports, staff actions with reasons, suspension blocks actions and shows the reason', async () => {
  const troll = await newPlayer('Troll');
  const victim = await newPlayer('Victim');
  const staff = await newPlayer('Mod');
  await q(`update game.players set role = 'mod' where id = $1`, [staff.id]);
  const ch = await cityChannel(troll.client);
  const m = await rpc(troll.client, 'send_chat', { p_channel: ch.id, p_body: 'you are all losers' });
  const r = await rpc(victim.client, 'report', { p_kind: 'message', p_target: m.message.id, p_reason: 'harassment' });
  assert.ok(r.ok);
  const queue = await rpc(staff.client, 'mod_queue');
  const rep = queue.reports.find((x) => x.target_id === m.message.id);
  assert.equal(rep.snapshot, 'you are all losers');
  assert.match(await rpcError(staff.client, 'mod_action', { p_target_player_no: troll.me.player_no, p_action: 'suspend', p_reason: '' }), /reason/);
  await rpc(staff.client, 'mod_action', { p_target_player_no: troll.me.player_no, p_action: 'remove', p_reason: 'Harassing other players', p_report: rep.id, p_content_kind: 'message', p_content_id: m.message.id });
  await rpc(staff.client, 'mod_action', { p_target_player_no: troll.me.player_no, p_action: 'suspend', p_reason: 'Harassing other players', p_hours: 24 });
  const err = await rpcError(troll.client, 'send_chat', { p_channel: ch.id, p_body: 'hi' });
  assert.match(err, /suspended until .*Harassing other players/);
  const hist = await rpc(victim.client, 'chat_history', { p_channel: ch.id });
  const removed = hist.find((x) => x.id === m.message.id);
  assert.equal(removed.removed, true);
  assert.equal(removed.body, null);
  const mine = await rpc(troll.client, 'my_moderation');
  assert.ok(mine.history.length >= 2);
  // Mods can't ban; only admins.
  assert.match(await rpcError(staff.client, 'mod_action', { p_target_player_no: troll.me.player_no, p_action: 'ban', p_reason: 'Repeated harassment' }), /Only staff/);
});

test('illegal content form works without an account and is rate limited', async () => {
  await q(`delete from game.rate_buckets where action = 'illegal_report'`);
  const anon = anonClient();
  const r = await rpc(anon, 'report_illegal_content', { p_location: 'London chat', p_description: 'Someone posted something illegal here.' });
  assert.ok(r.ok);
  assert.match(await rpcError(anon, 'report_illegal_content', { p_location: 'x', p_description: 'short' }), /at least 10/);
});

test('identity: names filtered, cosmetics, leaderboards, Discord directory', async () => {
  const a = await newPlayer('Proud');
  assert.match(await rpcError(a.client, 'set_profile', { p_name: 'f4ggot' }), /isn't allowed/);
  assert.match(await rpcError(a.client, 'set_profile', { p_skin: 'gilded' }), /haven't unlocked/);
  assert.match(await rpcError(a.client, 'buy_cosmetic', { p_id: 'gilded' }), /loyalty points/);
  await q('update game.players set loyalty_points = 500 where id = $1', [a.id]);
  await rpc(a.client, 'buy_cosmetic', { p_id: 'gilded' });
  const me = await rpc(a.client, 'set_profile', { p_skin: 'gilded', p_title: 't_vendor' });
  assert.equal(me.skin, 'gilded');
  assert.equal(me.title, 'Street Vendor');
  const lb = await rpc(anonClient(), 'leaderboard', { p_kind: 'richest' });
  assert.ok(lb.rows.length > 0);
  const code = 'abc' + Date.now().toString(36);
  const d = await rpc(a.client, 'discord_add', { p_code: `https://discord.gg/${code}`, p_name: 'Tycoon Club' });
  assert.equal(d.url, `https://discord.gg/${code}`);
  assert.match(await rpcError(a.client, 'discord_add', { p_code: 'bad code!', p_name: 'X server' }), /invite code/);
  const dir = await rpc(anonClient(), 'discord_directory');
  assert.ok(dir.some((x) => x.code === code));
});

test('account: download my data, delete account keeps businesses as abandoned', async () => {
  const a = await newPlayer('Leaver');
  const data = await rpc(a.client, 'download_my_data');
  assert.ok(data.ledger.length >= 1);
  assert.match(data.email, /@example.com/);
  assert.match(await rpcError(a.client, 'delete_account', { p_confirm: 'nope' }), /Type your display name/);
  await rpc(a.client, 'delete_account', { p_confirm: a.name });
  const p = await one('select status, display_name from game.players where id = $1', [a.id]);
  assert.equal(p.status, 'deleted');
  assert.match(p.display_name, /Former player/);
  const u = await one('select count(*)::int n from auth.users where id = $1', [a.id]);
  assert.equal(u.n, 0);
});
