// Test helpers: real players signed in through the local Supabase stack
// (tools/local-supabase/start.sh), plus a direct Postgres connection for
// setting up scenarios and checking invariants.
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';
import { KEYS, API_URL, DB_URL } from '../../tools/local-supabase/config.mjs';

export const db = new pg.Pool({ connectionString: DB_URL, max: 4 });

export async function q(sql, params = []) {
  const r = await db.query(sql, params);
  return r.rows;
}

export async function one(sql, params = []) {
  const rows = await q(sql, params);
  return rows[0];
}

let counter = 0;
export function uniqueName(prefix = 'Tester') {
  counter += 1;
  return `${prefix}${Date.now().toString(36).slice(-4)}${counter}`;
}

export function anonClient() {
  return createClient(API_URL, KEYS.anon, { auth: { persistSession: false, autoRefreshToken: false } });
}

// Signs a new email in with a one-time code (no email sent locally).
export async function signIn(email) {
  const res = await fetch(`${API_URL}/dev/login`, { method: 'POST', body: JSON.stringify({ email }) });
  const { otp, error } = await res.json();
  if (!otp) throw new Error('dev login failed: ' + JSON.stringify(error));
  const client = anonClient();
  const { error: e } = await client.auth.verifyOtp({ email, token: otp, type: 'email' });
  if (e) throw e;
  return client;
}

export async function rpc(client, fn, args = {}) {
  const { data, error } = await client.rpc(fn, args);
  if (error) {
    const err = new Error(error.message);
    err.code = error.code;
    throw err;
  }
  return data;
}

export async function rpcError(client, fn, args = {}) {
  const { error } = await client.rpc(fn, args);
  return error ? error.message : null;
}

export async function newPlayer(prefix = 'Tester', city = 'london') {
  const name = uniqueName(prefix);
  const client = await signIn(`${name.toLowerCase()}@example.com`);
  const me = await rpc(client, 'create_player', { p_name: name, p_age_ok: true });
  if (city) await rpc(client, 'choose_city', { p_city: city });
  return { client, me, name, id: me.id };
}

// A walkable street point near (lat, lng) in a city.
export async function streetNear(city, lat, lng, skip = 0) {
  return one(
    `with c as (select * from game.cities where id = $1),
          pt as (select (($3 - c.lng0) * c.kx / 5)::int cx0, (($2 - c.lat0) * c.ky / 5)::int cy0 from c)
     select c.lat0 + (pt.cy0 + dy + 0.5) * 5 / c.ky as lat, c.lng0 + (pt.cx0 + dx + 0.5) * 5 / c.kx as lng
       from c, pt, generate_series(-30, 30) dx, generate_series(-30, 30) dy
      where game.walkable(c, c.lat0 + (pt.cy0 + dy + 0.5) * 5 / c.ky, c.lng0 + (pt.cx0 + dx + 0.5) * 5 / c.kx)
        and not exists (select 1 from game.businesses b where b.city_id = $1 and b.kind = 'cart' and b.status in ('open', 'closed')
              and game.dist_m(b.lat, b.lng, c.lat0 + (pt.cy0 + dy + 0.5) * 5 / c.ky, c.lng0 + (pt.cx0 + dx + 0.5) * 5 / c.kx) < 15)
      order by dx * dx + dy * dy limit 1 offset $4`,
    [city, lat, lng, skip]
  );
}

// Make it lunchtime in a city for the rest of the test run.
export async function setLocalHour(city, hour) {
  const h = new Date().getUTCHours();
  let o = hour - h;
  if (o > 12) o -= 24;
  if (o < -12) o += 24;
  const tz = o === 0 ? 'UTC' : `Etc/GMT${o > 0 ? '-' : '+'}${Math.abs(o)}`;
  await q('update game.cities set tz = $2 where id = $1', [city, tz]);
}

// Pretend a business last ticked `hours` ago, then run the tick.
export async function runTickAfter(businessIds, hours) {
  await q(`update game.businesses set last_tick_at = now() - make_interval(secs => $2 * 3600) where id = any($1)`, [businessIds, hours]);
  await q('call game.tick()');
}

// Gate 2 invariant: every player's cash equals the sum of their ledger.
export async function ledgerMismatches() {
  return q(`select p.id, p.display_name, p.cash, coalesce(sum(l.amount), 0) as ledger
              from game.players p left join game.ledger l on l.player_id = p.id
             group by p.id having p.cash <> coalesce(sum(l.amount), 0)`);
}

// Put a player at a spot, as if they had walked there.
export async function standAt(playerId, spot) {
  await q('update game.players set lat = $2, lng = $3, pos_at = now() where id = $1', [playerId, spot.lat, spot.lng]);
}
