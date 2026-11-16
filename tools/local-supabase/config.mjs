// Local-only Supabase settings. The JWT secret and keys below are for a
// throwaway database on your own machine; never reuse them anywhere else.
import crypto from 'node:crypto';

export const PORTS = {
  gateway: 54321,
  db: 54322,
  rest: 54330,
  auth: 54331,
  realtime: 54332,
};

export const JWT_SECRET = 'crancapital-local-dev-jwt-secret-not-for-production-use';

function b64url(input) {
  return Buffer.from(input).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

export function signJwt(payload, secret = JWT_SECRET) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

const iat = 1767225600; // 2026-01-01
const exp = 2082758400; // 2036-01-01
export const KEYS = {
  anon: signJwt({ role: 'anon', iss: 'supabase-local', iat, exp }),
  service: signJwt({ role: 'service_role', iss: 'supabase-local', iat, exp }),
};

export const DB_URL = `postgres://postgres:postgres@127.0.0.1:${PORTS.db}/postgres`;
export const API_URL = `http://localhost:${PORTS.gateway}`;

if (process.argv[1] && process.argv[1].endsWith('config.mjs')) {
  // `node config.mjs` prints shell exports for scripts.
  console.log(`export LOCAL_ANON_KEY=${KEYS.anon}`);
  console.log(`export LOCAL_SERVICE_KEY=${KEYS.service}`);
  console.log(`export LOCAL_JWT_SECRET=${JWT_SECRET}`);
  console.log(`export LOCAL_DB_URL=${DB_URL}`);
  console.log(`export LOCAL_API_URL=${API_URL}`);
}
