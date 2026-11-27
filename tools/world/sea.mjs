// Sea lanes for the world map and the server.
//
// 1. Draws every country (client/public/world/countries.json) on a quarter-
//    degree grid. A cell is sea only if land covers at most an eighth of it,
//    so ships keep clear of every coast; the polar ice is closed.
// 2. Cuts open the straits and canals that a coarse map closes, and tags the
//    waterways a country can control (WATERWAYS below).
// 3. Checks every coastal country can reach the open ocean.
// 4. For every pair of coastal countries: the shortest sea route (km) and
//    the waterways it passes through, and, for each of those, the detour if
//    that waterway is closed.
// Writes client/public/world/sea.bin.gz (the grid, for the map) and
// supabase/migrations/20261127001000_sea_routes_data.sql (for the server).
//
// Usage: node tools/world/sea.mjs   (needs the local database for the list
// of countries)
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import * as topojson from 'topojson-client';
import { CELL, GW, GH, encodeGrid, coastCells, search, cellsTo, via, cellOf, cellLng, cellLat } from '../../client/src/nations/searoute.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const DB = process.env.LOCAL_DB_URL ?? 'postgres://postgres:postgres@127.0.0.1:54322/postgres';

// Waterways a country can control: the country, a channel cut through the
// coarse map (tagged), and a gate (all sea within `r` degrees of a point,
// tagged) that every ship through the waterway must cross.
export const WATERWAYS = [
  { id: 'suez', name: 'Suez Canal', country: 'egy', kind: 'canal',
    channel: [[32.3, 31.45], [32.33, 30.9], [32.42, 30.4], [32.55, 29.95], [32.75, 29.4], [33.3, 28.5], [33.9, 27.8], [34.4, 27.3]], gate: [32.4, 30.6, 0.2] },
  { id: 'panama', name: 'Panama Canal', country: 'pan', kind: 'canal',
    channel: [[-79.95, 9.7], [-79.85, 9.35], [-79.7, 9.1], [-79.55, 8.85], [-79.5, 8.5]], gate: [-79.7, 9.1, 0.15] },
  { id: 'gibraltar', name: 'Strait of Gibraltar', country: 'esp', kind: 'strait',
    channel: [[-7.0, 35.9], [-5.6, 35.97], [-4.4, 36.2]], gate: [-5.6, 35.97, 0.45] },
  { id: 'bosphorus', name: 'Bosphorus and Dardanelles', country: 'tur', kind: 'strait',
    channel: [[25.6, 39.9], [26.3, 40.15], [26.7, 40.4], [27.5, 40.7], [28.4, 40.9], [29.0, 41.05], [29.15, 41.3], [29.4, 41.6]], gate: [29.05, 41.15, 0.3] },
  { id: 'hormuz', name: 'Strait of Hormuz', country: 'irn', kind: 'strait',
    channel: [[55.4, 25.9], [56.3, 26.55], [57.0, 25.9], [57.4, 25.3]], gate: [56.4, 26.45, 0.55] },
  { id: 'bab_el_mandeb', name: 'Bab-el-Mandeb', country: 'yem', kind: 'strait',
    channel: [[42.4, 13.9], [43.3, 12.7], [43.9, 12.3], [44.6, 12.0]], gate: [43.35, 12.6, 0.4] },
  { id: 'malacca', name: 'Strait of Malacca', country: 'mys', kind: 'strait',
    channel: [[97.5, 6.0], [99.0, 4.3], [100.6, 3.0], [101.6, 2.3], [102.8, 1.6], [103.6, 1.2], [104.6, 1.3], [105.2, 1.6]], gate: [101.4, 2.5, 0.75] },
  { id: 'danish', name: 'Danish Straits', country: 'dnk', kind: 'strait',
    channel: [[8.5, 57.9], [10.6, 57.8], [11.4, 57.1], [11.9, 56.4], [12.6, 56.0], [12.8, 55.4], [13.6, 55.0], [14.4, 54.8]], gate: [11.8, 55.6, 0.7] },
];
// Passages the grid closes but nobody controls: cut open, not tagged.
const OPEN = [
  [[-5.4, 49.8], [-3.0, 50.0], [-1.0, 50.3], [0.8, 50.6], [1.45, 50.95], [2.3, 51.25], [3.2, 51.6]], // English Channel
  [[36.4, 45.6], [36.6, 45.0]], // Kerch
  [[105.95, -5.5], [105.7, -6.2]], // Sunda
  [[115.75, -8.2], [115.75, -9.1]], // Lombok
  [[141.7, -10.5], [143.6, -10.5]], // Torres
  [[79.3, 9.6], [79.6, 9.0]], // Palk / Adam's Bridge (Pamban)
];
// Ice and land bridges: the Bering Strait is closed, so the Arctic is a
// dead end from the Pacific (no sailing from China to Britain over Siberia).
const CLOSED = [[-175, 69.5, -163, 63.5]]; // [west, north, east, south]

function rasterize(features, countries) {
  // Land cover in sixteenths per cell (4 x 4 samples), and who owns it.
  const SUB = 4;
  const SW = GW * SUB;
  const cover = new Uint8Array(GW * GH);
  const owner = new Uint8Array(GW * GH);
  const best = new Uint8Array(GW * GH);
  const touched = new Uint16Array(GW * GH);
  for (const f of features) {
    const ci = countries.indexOf(String(f.id));
    const geo = f.geometry;
    if (!geo) continue;
    const polys = geo.type === 'Polygon' ? [geo.coordinates] : geo.type === 'MultiPolygon' ? geo.coordinates : [];
    const hit = new Map();
    for (const rings of polys) {
      let minY = Infinity;
      let maxY = -Infinity;
      for (const r of rings) for (const [, lat] of r) {
        minY = Math.min(minY, lat);
        maxY = Math.max(maxY, lat);
      }
      const sy0 = Math.max(0, Math.floor(((90 - maxY) / CELL) * SUB));
      const sy1 = Math.min(GH * SUB - 1, Math.ceil(((90 - minY) / CELL) * SUB));
      for (let sy = sy0; sy <= sy1; sy++) {
        const lat = 90 - ((sy + 0.5) / SUB) * CELL;
        const xs = [];
        for (const r of rings) {
          for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
            const [xi, yi] = r[i];
            const [xj, yj] = r[j];
            if (yi > lat !== yj > lat) xs.push(xi + ((lat - yi) * (xj - xi)) / (yj - yi));
          }
        }
        xs.sort((a, b) => a - b);
        for (let k = 0; k + 1 < xs.length; k += 2) {
          const a = Math.max(0, Math.ceil(((xs[k] + 180) / CELL) * SUB - 0.5));
          const b = Math.min(SW - 1, Math.floor(((xs[k + 1] + 180) / CELL) * SUB - 0.5));
          for (let sx = a; sx <= b; sx++) {
            const c = Math.floor(sy / SUB) * GW + Math.floor(sx / SUB);
            hit.set(c, (hit.get(c) || 0) + 1);
          }
        }
      }
    }
    for (const [c, n] of hit) {
      cover[c] = Math.min(16, cover[c] + n);
      if (ci >= 0 && n > best[c]) {
        best[c] = n;
        owner[c] = ci + 1;
      }
      touched[c]++;
    }
  }
  return { cover, owner };
}

// Cut a channel along a line, edge to edge (ships can't cut corners past
// land, so diagonal steps get a neighbour cell too).
function carve(water, tag, line, t) {
  let last = -1;
  const set = (c) => {
    water[c] = 1;
    if (t) tag[c] = t;
  };
  for (let i = 1; i < line.length; i++) {
    const [x0, y0] = line[i - 1];
    const [x1, y1] = line[i];
    const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) / (CELL / 5));
    for (let k = 0; k <= n; k++) {
      const c = cellOf(x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n);
      if (c === last) continue;
      if (last >= 0) {
        const lx = last % GW;
        const ly = Math.floor(last / GW);
        const cx = c % GW;
        const cy = Math.floor(c / GW);
        if (lx !== cx && ly !== cy) set(ly * GW + cx);
      }
      set(c);
      last = c;
    }
  }
}

async function main() {
  const t0 = Date.now();
  const db = new pg.Client({ connectionString: DB });
  await db.connect();
  const terr = (await db.query('select id, name, lat, lng, landlocked from game.territories order by id')).rows;
  await db.end();
  const countries = terr.map((t) => t.id);
  const topo = JSON.parse(fs.readFileSync(path.join(ROOT, 'client/public/world/countries.json'), 'utf8'));
  const features = topojson.feature(topo, topo.objects.countries).features;

  const { cover, owner } = rasterize(features, countries);
  const water = new Uint8Array(GW * GH);
  const tag = new Uint8Array(GW * GH);
  for (let i = 0; i < GW * GH; i++) {
    const lat = cellLat(i);
    water[i] = cover[i] <= 2 && lat < 79 && lat > -67 ? 1 : 0;
  }
  for (const line of OPEN) carve(water, tag, line, 0);
  for (const [w, n, e, so] of CLOSED) {
    for (let i = 0; i < GW * GH; i++) {
      const lng = cellLng(i);
      const lat = cellLat(i);
      if (lng >= w && lng <= e && lat <= n && lat >= so) water[i] = 0;
    }
  }
  WATERWAYS.forEach((w, k) => {
    carve(water, tag, w.channel, k + 1);
    const [lng, lat, r] = w.gate;
    for (let y = cellY(lat + r); y <= cellY(lat - r); y++) {
      for (let x = cellX(lng - r * 1.5); x !== (cellX(lng + r * 1.5) + 1) % GW; x = (x + 1) % GW) {
        const c = y * GW + x;
        const dLng = (cellLng(c) - lng) * Math.cos((lat * Math.PI) / 180);
        const dLat = cellLat(c) - lat;
        if (water[c] && Math.hypot(dLng, dLat) <= r) tag[c] = k + 1;
      }
    }
  });
  // Land owners only matter on land.
  for (let i = 0; i < GW * GH; i++) if (water[i]) owner[i] = 0;

  const grid = { water, owner, tag, countries, waterways: WATERWAYS.map((w) => w.id) };
  const outBin = path.join(ROOT, 'client/public/world/sea.bin.gz');
  fs.writeFileSync(outBin, zlib.gzipSync(encodeGrid(grid), { level: 9 }));
  console.log(`grid: ${water.reduce((s, v) => s + v, 0)} sea cells of ${GW * GH}; ${(fs.statSync(outBin).size / 1024).toFixed(0)} KB gzipped`);

  // Which coastal countries reach the open sea (mid-Atlantic)?
  const ocean = search(grid, [cellOf(-30, 30)], null).s.dist.slice();
  const coastal = terr.filter((t) => !t.landlocked);
  const ports = new Map();
  const cut = [];
  for (const t of coastal) {
    const cells = Array.from(coastCells(grid, t.id, [Number(t.lng), Number(t.lat)])).filter((c) => isFinite(ocean[c]));
    if (!cells.length) {
      // A coast too small for the grid (Jordan's Aqaba): the nearest open sea
      // to any of its land.
      const own = countries.indexOf(t.id) + 1;
      let best = -1;
      let bd = Infinity;
      for (let i = 0; i < GW * GH; i++) {
        if (owner[i] !== own) continue;
        const x = i % GW;
        const y = Math.floor(i / GW);
        for (let dy = -8; dy <= 8; dy++) for (let dx = -8; dx <= 8; dx++) {
          const j = (y + dy) * GW + ((x + dx + GW) % GW);
          if (j < 0 || j >= GW * GH || !water[j] || tag[j] || !isFinite(ocean[j])) continue;
          const d = dx * dx + dy * dy;
          if (d < bd) { bd = d; best = j; }
        }
      }
      if (best >= 0) cells.push(best);
    }
    if (cells.length) ports.set(t.id, Int32Array.from(cells));
    else cut.push(`${t.id} (${t.name})`);
  }
  console.log(`${ports.size} coastal countries reach the ocean; ${cut.length} don't: ${cut.join(', ')}`);

  // Routes between every pair, and detours around each closed waterway.
  const ids = [...ports.keys()].sort();
  const routes = [];
  const alts = [];
  const best = (s, cells) => {
    let b = -1;
    let bd = Infinity;
    for (const c of cells) if (s.dist[c] < bd) {
      bd = s.dist[c];
      b = c;
    }
    return b;
  };
  for (let ai = 0; ai < ids.length; ai++) {
    const a = ids[ai];
    const { s } = search(grid, ports.get(a), null, new Set(), true);
    const used = new Map(); // waterway tag -> [b...]
    for (let bi = ai + 1; bi < ids.length; bi++) {
      const b = ids[bi];
      const end = best(s, ports.get(b));
      if (end < 0) continue;
      const path = cellsTo(s, end);
      const v = via(grid, path);
      routes.push([a, b, Math.max(50, Math.round(s.dist[end])), v]);
      for (const w of v) {
        const t = grid.waterways.indexOf(w) + 1;
        (used.get(t) ?? used.set(t, []).get(t)).push(b);
      }
    }
    for (const [t, bs] of used) {
      const { s: s2 } = search(grid, ports.get(a), null, new Set([t]), true);
      for (const b of bs) {
        const end = best(s2, ports.get(b));
        alts.push([a, b, grid.waterways[t - 1], end < 0 || !isFinite(s2.dist[end]) ? null : Math.max(50, Math.round(s2.dist[end])), end < 0 ? [] : via(grid, cellsTo(s2, end))]);
      }
    }
    if (ai % 10 === 0) console.log(`  ${ai + 1}/${ids.length} ${a} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  }

  // The server's copy.
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
  const arr = (v) => (v.length ? `array[${v.map(q).join(',')}]` : `'{}'::text[]`);
  const lines = [
    '-- Generated by tools/world/sea.mjs. Do not edit by hand.',
    '-- Sea routes between coastal countries on a quarter-degree water grid:',
    '-- the distance, the controllable waterways on the way, and the detour',
    '-- when one of them is closed (null km: no way round).',
    'delete from game.sea_routes;',
    'delete from game.sea_alts;',
  ];
  for (let i = 0; i < routes.length; i += 500) {
    lines.push(`insert into game.sea_routes (a, b, km, via) values\n${routes.slice(i, i + 500).map(([a, b, k, v]) => `(${q(a)},${q(b)},${k},${arr(v)})`).join(',\n')};`);
  }
  for (let i = 0; i < alts.length; i += 500) {
    lines.push(`insert into game.sea_alts (a, b, waterway, km, via) values\n${alts.slice(i, i + 500).map(([a, b, w, k, v]) => `(${q(a)},${q(b)},${q(w)},${k ?? 'null'},${arr(v)})`).join(',\n')};`);
  }
  fs.writeFileSync(path.join(ROOT, 'supabase/migrations/20261127001000_sea_routes_data.sql'), lines.join('\n') + '\n');
  console.log(`${routes.length} routes, ${alts.length} detours in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

const cellX = (lng) => ((Math.floor((lng + 180) / CELL) % GW) + GW) % GW;
const cellY = (lat) => Math.max(0, Math.min(GH - 1, Math.floor((90 - lat) / CELL)));

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
