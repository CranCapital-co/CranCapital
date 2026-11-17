// Error reports from players' browsers: signed-in only, trimmed, rate limited.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, q, newPlayer, rpc, rpcError, anonClient } from './helpers.mjs';

after(async () => { await db.end(); });

test('client error reports: stored for the signed-in player, trimmed, rate limited, not for visitors', async () => {
  const a = await newPlayer('Crashy');
  await rpc(a.client, 'report_client_error', { p_kind: 'map', p_message: 'x'.repeat(5000), p_user_agent: 'iPad test', p_path: '#/play' });
  const rows = await q('select kind, length(message) as len, user_agent, path from game.client_errors where user_id = $1', [a.id]);
  assert.equal(rows.length, 1);
  assert.deepEqual({ ...rows[0] }, { kind: 'map', len: 1000, user_agent: 'iPad test', path: '#/play' });

  // A burst of reports is cut off.
  let refused = '';
  for (let i = 0; i < 15 && !refused; i++) {
    refused = await rpcError(a.client, 'report_client_error', { p_kind: 'error', p_message: 'boom ' + i, p_user_agent: null, p_path: null }).catch(() => '');
  }
  assert.match(refused, /Slow down/);

  // Visitors who aren't signed in can't call it at all.
  const { error } = await anonClient().rpc('report_client_error', { p_kind: 'error', p_message: 'spam', p_user_agent: null, p_path: null });
  assert.ok(error, 'anonymous call refused');
});
