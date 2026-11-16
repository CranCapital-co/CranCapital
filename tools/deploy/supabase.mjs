// Deploys CranCapital's database to a hosted Supabase project through the
// Supabase Management API.
//
//   SUPABASE_ACCESS_TOKEN=sbp_...  node tools/deploy/supabase.mjs [--seed] [--auth] [--keys]
//
//   (no flags)  apply new migrations from supabase/migrations
//   --seed      load city data and world settings (safe to repeat)
//   --auth      set the sign-in site URL, redirect URLs and email templates
//   --keys      write the project URL and publishable key to client/.env.production
//
// Applied migrations are recorded in supabase_migrations.schema_migrations,
// the same table the Supabase CLI uses, so `supabase db push` stays usable.
// The project ref comes from SUPABASE_PROJECT_REF or tools/deploy/project.json.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const conf = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/deploy/project.json'), 'utf8'));
const REF = process.env.SUPABASE_PROJECT_REF || conf.ref;
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN || 'proxy-injected';
const API = `https://api.supabase.com/v1/projects/${REF}`;
const args = new Set(process.argv.slice(2));

async function api(method, p, body) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(API + p, {
      method,
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (res.ok) return text ? JSON.parse(text) : null;
    if ((res.status === 429 || res.status >= 500) && attempt < 5) {
      await new Promise((r) => setTimeout(r, 2000 * attempt));
      continue;
    }
    throw new Error(`${method} ${p}: ${res.status} ${text.slice(0, 800)}`);
  }
}

const sql = (query) => api('POST', '/database/query', { query });

// Split a big seed file into statements, then group them under ~700 KB.
function chunks(text, limit = 700_000) {
  const stmts = text.split(/;\n(?=(?:insert|select|update|delete|with|--)\b|\s*$)/i).map((s) => s.trim()).filter(Boolean);
  const out = [];
  let cur = '';
  for (const s of stmts) {
    const st = s.endsWith(';') ? s : s + ';';
    if (cur && cur.length + st.length > limit) {
      out.push(cur);
      cur = '';
    }
    cur += st + '\n';
  }
  if (cur) out.push(cur);
  return out;
}

async function migrate() {
  await sql(`create schema if not exists supabase_migrations;
    create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text);`);
  const done = new Set((await sql('select version from supabase_migrations.schema_migrations')).map((r) => r.version));
  const dir = path.join(ROOT, 'supabase/migrations');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    const [version, ...rest] = f.replace(/\.sql$/, '').split('_');
    if (done.has(version)) continue;
    process.stdout.write(`migration ${f} ... `);
    const body = fs.readFileSync(path.join(dir, f), 'utf8');
    await sql(body);
    await sql(`insert into supabase_migrations.schema_migrations (version, name) values ('${version}', '${rest.join('_').replace(/'/g, "''")}') on conflict do nothing`);
    console.log('ok');
  }
  // Re-run the security pass so grants and RLS cover anything new.
  const sec = fs.readdirSync(dir).find((x) => x.endsWith('_security.sql'));
  if (sec) await sql(fs.readFileSync(path.join(dir, sec), 'utf8'));
  await sql(`notify pgrst, 'reload schema'`);
}

async function seed() {
  const dir = path.join(ROOT, 'supabase/seed');
  const files = [
    ...fs.readdirSync(path.join(dir, 'cities')).filter((x) => x.endsWith('.sql')).sort().map((x) => path.join(dir, 'cities', x)),
    ...fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort().map((x) => path.join(dir, x)),
  ];
  for (const f of files) {
    const parts = chunks(fs.readFileSync(f, 'utf8'));
    process.stdout.write(`seed ${path.relative(ROOT, f)} (${parts.length} part${parts.length > 1 ? 's' : ''}) ... `);
    for (const part of parts) await sql(part);
    console.log('ok');
  }
}

async function auth() {
  const site = conf.siteUrl;
  const linkCode = (what) => `<h2>${what} CranCapital</h2>
<p>Your sign-in code is:</p>
<p style="font-size:28px;font-weight:700;letter-spacing:4px">{{ .Token }}</p>
<p>Or <a href="{{ .ConfirmationURL }}">click here to sign in</a>.</p>
<p style="color:#666">If you didn't ask for this, you can ignore this email.</p>`;
  await api('PATCH', '/config/auth', {
    site_url: site,
    uri_allow_list: [site, `${site}**`, 'http://localhost:5173/**', 'http://localhost:4173/**'].join(','),
    external_email_enabled: true,
    mailer_otp_length: 6,
  });
  console.log(`auth: site ${site} and redirect URLs set`);
  // Custom email text needs a paid plan or your own SMTP server.
  try {
    await api('PATCH', '/config/auth', {
      mailer_subjects_magic_link: 'Your CranCapital sign-in code',
      mailer_templates_magic_link_content: linkCode('Sign in to'),
      mailer_subjects_confirmation: 'Your CranCapital sign-in code',
      mailer_templates_confirmation_content: linkCode('Welcome to'),
    });
    console.log('auth: email templates set (link + 6-digit code)');
  } catch (e) {
    console.log('auth: kept Supabase default email text (custom templates need your own SMTP server; see docs/SETUP.md)');
  }
}

async function keys() {
  const list = await api('GET', '/api-keys?reveal=true');
  const pub = list.find((k) => k.type === 'publishable') ?? list.find((k) => k.name === 'anon');
  if (!pub) throw new Error('no publishable key found');
  const env = `# Public settings for the production build (safe to commit: the
# publishable key only allows what the database's own rules allow).
VITE_SUPABASE_URL=https://${REF}.supabase.co
VITE_SUPABASE_KEY=${pub.api_key}
`;
  fs.writeFileSync(path.join(ROOT, 'client/.env.production'), env);
  console.log('wrote client/.env.production');
}

if (args.has('--keys')) await keys();
await migrate();
if (args.has('--seed') || (await sql('select count(*)::int n from game.cities'))[0].n === 0) await seed();
if (args.has('--auth')) await auth();
console.log('done');
