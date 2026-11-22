// Builds the world for Nations from Natural Earth's 1:110m countries
// (public domain): one territory per country with its population, GDP and
// label point; land links between countries that share a border; sea links
// between coasts within 450 km; and a check that the whole world is
// connected. Writes:
//   supabase/migrations/20261122000500_world_data.sql  (territories + links)
//   client/public/world/countries.json                 (TopoJSON for the map)
//
//   NODE_USE_ENV_PROXY=1 node tools/world/build.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { topology } from 'topojson-server';
import { neighbors, feature } from 'topojson-client';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_admin_0_countries.geojson';
const cache = path.join(root, 'tools/world/.cache/ne_110m_admin_0_countries.geojson');

const SKIP = new Set(['ATA', 'ATF']);
const NAMES = {
  'Dem. Rep. Congo': 'DR Congo',
  'Central African Rep.': 'Central African Republic',
  'Bosnia and Herz.': 'Bosnia and Herzegovina',
  'Eq. Guinea': 'Equatorial Guinea',
  'Solomon Is.': 'Solomon Islands',
  'Falkland Is.': 'Falkland Islands',
  'Dominican Rep.': 'Dominican Republic',
  'S. Sudan': 'South Sudan',
  'N. Cyprus': 'Northern Cyprus',
  'W. Sahara': 'Western Sahara',
  eSwatini: 'Eswatini',
  'United States of America': 'United States',
};
// No coast: naval bases can't be built here.
const LANDLOCKED = new Set(
  'AFG ARM AUT AZE BLR BTN BOL BWA BFA BDI CAF TCD CZE SWZ ETH HUN KAZ KOS KGZ LAO LSO LUX MWI MLI MDA MNG NPL NER MKD PRY RWA SRB SVK SDS CHE TJK TKM UGA UZB ZMB ZWE'.split(' ')
);
// 12 colours that read on the dark ocean; neighbours get different ones.
const PALETTE = ['#e0794f', '#4fa3e0', '#7bc96f', '#e0c14f', '#b07be0', '#4fd1c5', '#e06f9a', '#9fb34f', '#6f86e0', '#e09a4f', '#5fbf9a', '#c9806f'];
const SEA_KM = 450;

async function load() {
  if (!fs.existsSync(cache)) {
    fs.mkdirSync(path.dirname(cache), { recursive: true });
    const r = await fetch(SRC);
    if (!r.ok) throw new Error(`download failed: ${r.status}`);
    fs.writeFileSync(cache, await r.text());
  }
  return JSON.parse(fs.readFileSync(cache, 'utf8'));
}

const rad = (d) => (d * Math.PI) / 180;
function km(a, b) {
  const [lng1, lat1] = a;
  const [lng2, lat2] = b;
  const s = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2;
  return 12742 * Math.asin(Math.min(1, Math.sqrt(s)));
}

function rings(geom) {
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
  return polys.map((p) => p[0]);
}

// Points along the outline, densified so coast-to-coast distances are fair.
function outline(geom) {
  const pts = [];
  for (const ring of rings(geom)) {
    for (let i = 0; i < ring.length - 1; i++) {
      const a = ring[i];
      const b = ring[i + 1];
      const d = km(a, b);
      const n = Math.max(1, Math.ceil(d / 60));
      for (let k = 0; k < n; k++) pts.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
    }
  }
  return pts;
}

function minKm(A, B) {
  let best = Infinity;
  for (const a of A) {
    for (const b of B) {
      const d = km(a, b);
      if (d < best) best = d;
    }
  }
  return best;
}

const sql = (s) => `'${String(s).replace(/'/g, "''")}'`;

async function main() {
  const ne = await load();
  const feats = ne.features.filter((f) => !SKIP.has(f.properties.ADM0_A3));
  const T = feats.map((f) => {
    const p = f.properties;
    const iso2 = p.ISO_A2_EH && p.ISO_A2_EH !== '-99' ? p.ISO_A2_EH : p.ISO_A2;
    return {
      id: p.ADM0_A3.toLowerCase(),
      a3: p.ADM0_A3,
      name: NAMES[p.NAME] ?? p.NAME,
      iso2: iso2 && iso2 !== '-99' ? iso2 : null,
      continent: p.CONTINENT,
      region: p.SUBREGION,
      pop: Math.max(0.01, p.POP_EST / 1e6),
      gdp: Math.max(0.05, p.GDP_MD / 1000),
      lat: p.LABEL_Y,
      lng: p.LABEL_X,
      landlocked: LANDLOCKED.has(p.ADM0_A3),
      geom: f.geometry,
    };
  });

  // Land borders from the shared arcs of a topology.
  const topo = topology({ countries: { type: 'FeatureCollection', features: feats.map((f, i) => ({ ...f, id: T[i].id, properties: {} })) } }, 1e5);
  const nb = neighbors(topo.objects.countries.geometries);
  const links = new Map(); // "a|b" -> {kind, km}
  const key = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const centre = (t) => [t.lng, t.lat];
  nb.forEach((list, i) => {
    for (const j of list) if (T[j].id !== T[i].id) links.set(key(T[i].id, T[j].id), { kind: "land", km: Math.round(km(centre(T[i]), centre(T[j]))) });
  });

  // Sea links between nearby coasts.
  const outl = T.map((t) => outline(t.geom));
  const bbox = T.map((t) => {
    const xs = [];
    const ys = [];
    for (const r of rings(t.geom)) for (const [x, y] of r) { xs.push(x); ys.push(y); }
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  });
  const near = new Map(); // i -> [[d, j]]
  for (let i = 0; i < T.length; i++) {
    for (let j = i + 1; j < T.length; j++) {
      const [ax0, ay0, ax1, ay1] = bbox[i];
      const [bx0, by0, bx1, by1] = bbox[j];
      const dy = Math.max(0, by0 - ay1, ay0 - by1) * 111;
      if (dy > 3000) continue;
      const wraps = ax1 - ax0 > 300 || bx1 - bx0 > 300;
      const dx = wraps ? 0 : Math.max(0, bx0 - ax1, ax0 - bx1) * 111 * Math.cos(rad(Math.min(70, Math.abs((ay0 + by1) / 2))));
      if (dx > 3000) continue;
      const d = minKm(outl[i], outl[j]);
      (near.get(i) ?? near.set(i, []).get(i)).push([d, j]);
      (near.get(j) ?? near.set(j, []).get(j)).push([d, i]);
      if (d <= SEA_KM && !links.has(key(T[i].id, T[j].id))) {
        links.set(key(T[i].id, T[j].id), { kind: 'sea', km: Math.round(km(centre(T[i]), centre(T[j]))) });
      }
    }
  }
  const degree = (id) => [...links.keys()].filter((k) => k.split('|').includes(id)).length;
  // Remote islands get their two nearest neighbours.
  for (let i = 0; i < T.length; i++) {
    const list = (near.get(i) ?? []).sort((a, b) => a[0] - b[0]);
    for (const [, j] of list) {
      if (degree(T[i].id) >= 2) break;
      if (!links.has(key(T[i].id, T[j].id))) links.set(key(T[i].id, T[j].id), { kind: 'sea', km: Math.round(km(centre(T[i]), centre(T[j]))) });
    }
  }
  // Everything must be reachable: join components at their closest coasts.
  for (;;) {
    const comp = new Map();
    const adj = new Map(T.map((t) => [t.id, []]));
    for (const k of links.keys()) {
      const [a, b] = k.split('|');
      adj.get(a).push(b);
      adj.get(b).push(a);
    }
    let c = 0;
    for (const t of T) {
      if (comp.has(t.id)) continue;
      const q = [t.id];
      comp.set(t.id, c);
      while (q.length) for (const n of adj.get(q.pop())) if (!comp.has(n)) { comp.set(n, c); q.push(n); }
      c++;
    }
    if (c === 1) break;
    let best = [Infinity, -1, -1];
    for (let i = 0; i < T.length; i++) {
      if (comp.get(T[i].id) !== 0) continue;
      for (const [d, j] of near.get(i) ?? []) if (comp.get(T[j].id) !== 0 && d < best[0]) best = [d, i, j];
    }
    if (best[1] < 0) throw new Error('could not connect the world');
    const [, i, j] = best;
    links.set(key(T[i].id, T[j].id), { kind: 'sea', km: Math.round(km(centre(T[i]), centre(T[j]))) });
    console.log(`joined ${T[i].name} – ${T[j].name} (${Math.round(best[0])} km)`);
  }

  // Colours: greedy, so no two neighbours share one.
  const color = new Map();
  const order = [...T].sort((a, b) => degree(b.id) - degree(a.id));
  for (const t of order) {
    const used = new Set([...links.keys()].filter((k) => k.split('|').includes(t.id)).map((k) => color.get(k.split('|').find((x) => x !== t.id))));
    let h = 0;
    for (const ch of t.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    for (let k = 0; k < PALETTE.length; k++) {
      const c = PALETTE[(h + k) % PALETTE.length];
      if (!used.has(c)) { color.set(t.id, c); break; }
    }
    if (!color.has(t.id)) color.set(t.id, PALETTE[h % PALETTE.length]);
  }

  // SQL
  const rows = T.map((t) =>
    `  (${sql(t.id)}, ${sql(t.name)}, ${t.iso2 ? sql(t.iso2) : 'null'}, ${sql(t.continent)}, ${sql(t.region)}, ${t.pop.toFixed(3)}, ${t.gdp.toFixed(2)}, ${t.lat.toFixed(4)}, ${t.lng.toFixed(4)}, ${t.landlocked}, ${sql(color.get(t.id))})`
  );
  const L = [...links.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => {
    const [a, b] = k.split('|');
    return `  (${sql(a)}, ${sql(b)}, ${sql(v.kind)}, ${v.km})`;
  });
  const out = `-- Generated by tools/world/build.mjs from Natural Earth 1:110m countries
-- (public domain, naturalearthdata.com). Do not edit by hand.
insert into game.territories (id, name, iso2, continent, region, pop_m, gdp_bn, lat, lng, landlocked, color) values
${rows.join(',\n')};

insert into game.territory_links (a, b, kind, km)
select a, b, kind, km from (values
${L.join(',\n')}
) v(a, b, kind, km)
union all
select b, a, kind, km from (values
${L.join(',\n')}
) v(a, b, kind, km);

select game.world_reset();
`;
  fs.writeFileSync(path.join(root, 'supabase/migrations/20261122000500_world_data.sql'), out);

  // TopoJSON for the client: shapes and ids only.
  const slim = topology({ countries: { type: 'FeatureCollection', features: feats.map((f, i) => ({ type: 'Feature', id: T[i].id, properties: {}, geometry: f.geometry })) } }, 1e4);
  fs.mkdirSync(path.join(root, 'client/public/world'), { recursive: true });
  fs.writeFileSync(path.join(root, 'client/public/world/countries.json'), JSON.stringify(slim));
  // Sanity: decodes.
  feature(slim, slim.objects.countries);
  const land = [...links.values()].filter((v) => v.kind === 'land').length;
  console.log(`${T.length} territories, ${links.size} links (${land} land, ${links.size - land} sea)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
