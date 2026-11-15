// Minimal stand-in for Supabase's API gateway, for local development only.
// Routes the same URL prefixes as hosted Supabase to the local containers:
//   /auth/v1/*      -> GoTrue
//   /rest/v1/*      -> PostgREST
//   /realtime/v1/*  -> Realtime (/socket/*, websocket upgrade included)
// plus one dev-only helper:
//   POST /dev/login {email} -> a one-time code for that email (no email sent),
//   so you can sign in locally without an SMTP server.

import http from 'node:http';
import net from 'node:net';
import { PORTS, KEYS } from './config.mjs';

const routes = [
  { prefix: '/auth/v1/', port: PORTS.auth, rewrite: '/' },
  { prefix: '/rest/v1/', port: PORTS.rest, rewrite: '/' },
  { prefix: '/realtime/v1/', port: PORTS.realtime, rewrite: '/socket/', host: 'realtime-dev.localhost' },
];

function match(url) {
  for (const r of routes) if (url.startsWith(r.prefix)) return { ...r, path: r.rewrite + url.slice(r.prefix.length) };
  return null;
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS,HEAD',
  'access-control-expose-headers': '*',
};

async function devLogin(req, res) {
  let body = '';
  for await (const chunk of req) body += chunk;
  const { email } = JSON.parse(body || '{}');
  const r = await fetch(`http://127.0.0.1:${PORTS.auth}/admin/generate_link`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEYS.service}`, apikey: KEYS.service },
    body: JSON.stringify({ type: 'magiclink', email }),
  });
  let json = await r.json();
  if (!r.ok && /not found|User not found/i.test(JSON.stringify(json))) {
    await fetch(`http://127.0.0.1:${PORTS.auth}/admin/users`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEYS.service}`, apikey: KEYS.service },
      body: JSON.stringify({ email, email_confirm: true }),
    });
    const r2 = await fetch(`http://127.0.0.1:${PORTS.auth}/admin/generate_link`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEYS.service}`, apikey: KEYS.service },
      body: JSON.stringify({ type: 'magiclink', email }),
    });
    json = await r2.json();
  }
  const otp = json.email_otp || json.properties?.email_otp;
  res.writeHead(otp ? 200 : 500, { 'content-type': 'application/json', ...CORS });
  res.end(JSON.stringify(otp ? { otp } : { error: json }));
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/dev/login')) {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS);
      return res.end();
    }
    devLogin(req, res).catch((e) => {
      res.writeHead(500, CORS);
      res.end(String(e));
    });
    return;
  }
  const m = match(req.url);
  if (!m) {
    res.writeHead(404, CORS);
    return res.end('not found');
  }
  const headers = { ...req.headers, host: m.host || `127.0.0.1:${m.port}`, 'x-forwarded-prefix': m.prefix.slice(0, -1) };
  // Like Supabase's gateway: no user session -> the apikey is the bearer.
  if (!headers.authorization && headers.apikey) headers.authorization = `Bearer ${headers.apikey}`;
  const up = http.request({ host: '127.0.0.1', port: m.port, method: req.method, path: m.path, headers }, (ur) => {
    const h = { ...ur.headers };
    if (!h['access-control-allow-origin']) Object.assign(h, CORS);
    res.writeHead(ur.statusCode, h);
    ur.pipe(res);
  });
  up.on('error', (e) => {
    res.writeHead(502, CORS);
    res.end(`upstream error: ${e.message}`);
  });
  req.pipe(up);
});

server.on('upgrade', (req, socket, head) => {
  const m = match(req.url);
  if (!m) return socket.destroy();
  const up = net.connect(m.port, '127.0.0.1', () => {
    const lines = [`${req.method} ${m.path} HTTP/1.1`];
    for (const [k, v] of Object.entries(req.headers)) {
      if (k === 'host') lines.push(`host: ${m.host || '127.0.0.1'}`);
      else lines.push(`${k}: ${v}`);
    }
    up.write(lines.join('\r\n') + '\r\n\r\n');
    if (head && head.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  up.on('error', () => socket.destroy());
  socket.on('error', () => up.destroy());
});

server.listen(PORTS.gateway, () => console.log(`gateway on http://localhost:${PORTS.gateway}`));
