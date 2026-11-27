// Street-map tiles served with the game itself, so the city map works where
// tiles.openfreemap.org is blocked (school and work networks, some VPNs).
//
// For each launch city: every OpenFreeMap vector tile (OpenMapTiles schema,
// OpenStreetMap data, ODbL) at zoom 12 to 14 that covers the area the map can
// show (the city's bbox plus the camera margin in GameMap). The map
// over-zooms z14 for closer views. To keep the download small, each tile
// keeps only what the game's map style draws:
//   * layers the style uses (no house numbers, boundaries, peaks, airports);
//   * names in the local language and English only (tiles carry dozens);
//   * only the points of interest the style labels.
// Tiles are written gzipped to client/public/tiles/{z}/{x}/{y}.pbf.gz and
// unzipped in the browser (client/src/map/localTiles.ts).
//
// Usage: node citydata/tiles.mjs        (downloads are cached in .cache/tiles)
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import Pbf from 'pbf';
import { CITIES } from './cities.mjs';
import { lngLatToTile } from './geo.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const CACHE = path.join(HERE, '.cache', 'tiles');
const OUT = path.join(ROOT, 'client/public/tiles');
const TILEJSON = 'https://tiles.openfreemap.org/planet';
// Must match the camera bounds in client/src/map/GameMap.tsx.
export const MARGIN = { lng: 0.03, lat: 0.02 };
const ZOOMS = [12, 13, 14];

// What the style (client/src/map/style.ts) uses.
const LAYERS = new Set(['building', 'landcover', 'landuse', 'park', 'place', 'poi', 'transportation', 'transportation_name', 'water', 'water_name', 'waterway']);
const POI_CLASSES = new Set(['railway', 'attraction', 'museum', 'theatre', 'park', 'stadium']);
const PLACE_CLASSES = new Set(['city', 'town', 'suburb', 'quarter', 'neighbourhood']);
const keepKey = (k) => !(k.startsWith('name:') || k.startsWith('name_')) || k === 'name:en';
const keepFeature = (layer, p) =>
  layer === 'poi' ? POI_CLASSES.has(p.class) && Number(p.rank ?? 99) <= 12
  : layer === 'place' ? PLACE_CLASSES.has(p.class)
  : true;
// Tiles that only show the margin around a city (never the playable part)
// keep a light backdrop: main roads, water, parks and land, no buildings.
const OUTER_LAYERS = new Set(['landcover', 'landuse', 'park', 'place', 'transportation', 'water', 'water_name', 'waterway']);
const MAJOR_ROADS = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'rail']);
const keepOuter = (layer, p) => (layer === 'transportation' ? MAJOR_ROADS.has(p.class) : keepFeature(layer, p));

function readValue(buf) {
  const p = new Pbf(buf);
  let v = null;
  while (p.pos < p.length) {
    const tag = p.readVarint() >> 3;
    v = tag === 1 ? p.readString() : tag === 2 ? p.readFloat() : tag === 3 ? p.readDouble() : tag === 4 ? p.readVarint64() : tag === 5 ? p.readVarint() : tag === 6 ? p.readSVarint() : tag === 7 ? p.readBoolean() : null;
  }
  return v;
}

// Read a layer as raw parts: geometry stays as the original bytes.
function readLayer(buf) {
  const p = new Pbf(buf);
  const L = { name: '', version: 2, extent: 4096, keys: [], values: [], features: [] };
  while (p.pos < p.length) {
    const val = p.readVarint();
    const tag = val >> 3;
    if (tag === 1) L.name = p.readString();
    else if (tag === 15) L.version = p.readVarint();
    else if (tag === 5) L.extent = p.readVarint();
    else if (tag === 3) L.keys.push(p.readString());
    else if (tag === 4) {
      const len = p.readVarint();
      L.values.push(buf.subarray(p.pos, p.pos + len));
      p.pos += len;
    } else if (tag === 2) {
      const len = p.readVarint();
      const end = p.pos + len;
      const f = { id: null, tags: [], type: 0, geom: null };
      while (p.pos < end) {
        const v = p.readVarint();
        const t = v >> 3;
        if (t === 1) f.id = p.readVarint();
        else if (t === 2) {
          const te = p.readVarint() + p.pos;
          while (p.pos < te) f.tags.push(p.readVarint());
        }
        else if (t === 3) f.type = p.readVarint();
        else if (t === 4) {
          const gl = p.readVarint();
          f.geom = buf.subarray(p.pos, p.pos + gl);
          p.pos += gl;
        } else p.skip(v);
      }
      L.features.push(f);
    } else p.skip(val);
  }
  return L;
}

// Building lots (from build.mjs, see lots.mjs): in z14 tiles the merged
// block features are replaced by their lots, which keep the block's
// properties (height, colour) and get their own ids.
const LOTS = { parents: new Set(), byParent: new Map() };
function loadLots() {
  const dir = path.join(HERE, '.cache', 'lots');
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir)) {
    const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    for (const p of j.parents) LOTS.parents.add(p);
    for (const l of j.lots) (LOTS.byParent.get(l.parent) ?? LOTS.byParent.set(l.parent, []).get(l.parent)).push(l);
  }
}

const ringArea = (r) => {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j][0] * r[i][1] - r[i][0] * r[j][1];
  return a / 2;
};
const inRing = (x, y, r) => {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i];
    const [xj, yj] = r[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};
// Sutherland–Hodgman against the tile square plus a buffer.
function clipToTile(ring, lo, hi) {
  let pts = ring;
  const sides = [
    [(p) => p[0] >= lo, (a, b) => [lo, a[1] + ((b[1] - a[1]) * (lo - a[0])) / (b[0] - a[0])]],
    [(p) => p[0] <= hi, (a, b) => [hi, a[1] + ((b[1] - a[1]) * (hi - a[0])) / (b[0] - a[0])]],
    [(p) => p[1] >= lo, (a, b) => [a[0] + ((b[0] - a[0]) * (lo - a[1])) / (b[1] - a[1]), lo]],
    [(p) => p[1] <= hi, (a, b) => [a[0] + ((b[0] - a[0]) * (hi - a[1])) / (b[1] - a[1]), hi]],
  ];
  for (const [ins, cut] of sides) {
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[(i + pts.length - 1) % pts.length];
      const b = pts[i];
      if (ins(b)) {
        if (!ins(a)) out.push(cut(a, b));
        out.push(b);
      } else if (ins(a)) out.push(cut(a, b));
    }
    pts = out;
    if (pts.length < 3) return [];
  }
  return pts;
}
// A lot's outline as MVT polygon geometry for tile z/x/y, or null if it
// doesn't reach this tile.
function lotGeometry(lot, z, x, y, extent) {
  const B = 64;
  const n = 2 ** z;
  const toTile = ([lng, lat]) => {
    const [tx, ty] = lngLatToTile(lng, lat, z);
    return [(tx - x) * extent, (ty - y) * extent];
  };
  // Outer rings first, each followed by its holes. In lng/lat (y up) outer
  // rings are anticlockwise; MVT wants exteriors with positive area in tile
  // coordinates (y down).
  const outers = [];
  const holes = [];
  for (const r of lot.rings) (ringArea(r) > 0 ? outers : holes).push(r);
  const ordered = [];
  for (const o of outers) {
    ordered.push([o, true]);
    for (const h of holes) if (inRing(h[0][0], h[0][1], o)) ordered.push([h, false]);
  }
  const cmds = [];
  let cx = 0;
  let cy = 0;
  const zz = (v) => (v << 1) ^ (v >> 31);
  let any = false;
  for (const [r, outer] of ordered) {
    let t = clipToTile(r.map(toTile), -B, extent + B).map(([a, b]) => [Math.round(a), Math.round(b)]);
    t = t.filter((p, i) => i === 0 || p[0] !== t[i - 1][0] || p[1] !== t[i - 1][1]);
    if (t.length > 1 && t[0][0] === t[t.length - 1][0] && t[0][1] === t[t.length - 1][1]) t.pop();
    if (t.length < 3) continue;
    const a = ringArea(t);
    if (a === 0) continue;
    if ((a > 0) !== outer) t.reverse();
    if (!outer && !any) continue; // a hole whose outline isn't in this tile
    cmds.push(1 | (1 << 3), zz(t[0][0] - cx), zz(t[0][1] - cy));
    cx = t[0][0];
    cy = t[0][1];
    cmds.push(2 | ((t.length - 1) << 3));
    for (let i = 1; i < t.length; i++) {
      cmds.push(zz(t[i][0] - cx), zz(t[i][1] - cy));
      cx = t[i][0];
      cy = t[i][1];
    }
    cmds.push(7 | (1 << 3));
    if (outer) any = true;
  }
  if (!any) return null;
  const pb = new Pbf();
  for (const v of cmds) pb.writeVarint(v);
  return pb.finish();
}

function slimTile(buf, outer = false, zxy = null) {
  const layers = outer ? OUTER_LAYERS : LAYERS;
  const keep = outer ? keepOuter : keepFeature;
  const p = new Pbf(buf);
  const out = new Pbf();
  while (p.pos < p.length) {
    const val = p.readVarint();
    if (val >> 3 !== 3) {
      p.skip(val);
      continue;
    }
    const len = p.readVarint();
    const L = readLayer(buf.subarray(p.pos, p.pos + len));
    p.pos += len;
    if (!layers.has(L.name)) continue;
    const decoded = L.values.map(readValue);
    const keys = [];
    const keyIx = new Map();
    const values = [];
    const valIx = new Map();
    const features = [];
    for (const f of L.features) {
      const props = {};
      for (let i = 0; i < f.tags.length; i += 2) props[L.keys[f.tags[i]]] = decoded[f.tags[i + 1]];
      if (!keep(L.name, props)) continue;
      const tags = [];
      for (let i = 0; i < f.tags.length; i += 2) {
        const k = L.keys[f.tags[i]];
        if (!keepKey(k)) continue;
        if (!keyIx.has(k)) { keyIx.set(k, keys.length); keys.push(k); }
        const raw = L.values[f.tags[i + 1]];
        const vk = Buffer.from(raw).toString('base64');
        if (!valIx.has(vk)) { valIx.set(vk, values.length); values.push(raw); }
        tags.push(keyIx.get(k), valIx.get(vk));
      }
      // A merged block in a street-level tile: its lots instead.
      if (L.name === 'building' && zxy && zxy[0] === 14 && f.id !== null && LOTS.parents.has(f.id)) {
        if (!f._done) {
          // Each lot a little taller or lower than its neighbours, so the
          // block reads as separate buildings.
          const hk = keys.indexOf('render_height');
          const baseH = Number(props.render_height) || 0;
          for (const lot of LOTS.byParent.get(f.id) ?? []) {
            const geom = lotGeometry(lot, zxy[0], zxy[1], zxy[2], L.extent);
            if (!geom) continue;
            let lt = tags;
            if (hk >= 0 && baseH > 0) {
              const r = (((lot.id % 9973) * 7919) % 1000) / 1000;
              const h = Math.max(3, Math.round(baseH * (0.82 + 0.36 * r)));
              const pb = new Pbf();
              pb.writeVarintField(5, h);
              const raw = pb.finish();
              const vk = Buffer.from(raw).toString('base64');
              if (!valIx.has(vk)) { valIx.set(vk, values.length); values.push(raw); }
              lt = tags.slice();
              for (let i = 0; i < lt.length; i += 2) if (lt[i] === hk) lt[i + 1] = valIx.get(vk);
            }
            features.push({ id: lot.id, tags: lt, type: 3, geom });
          }
          // The same block can come in several pieces in one tile.
          for (const g of L.features) if (g.id === f.id) g._done = true;
        }
        continue;
      }
      features.push({ ...f, tags });
    }
    if (!features.length) continue;
    out.writeMessage(3, (l, pb) => {
      pb.writeVarintField(15, l.version);
      pb.writeStringField(1, l.name);
      for (const f of l.features) {
        pb.writeMessage(2, (ff, fb) => {
          if (ff.id !== null) fb.writeVarintField(1, ff.id);
          if (ff.tags.length) fb.writePackedVarint(2, ff.tags);
          fb.writeVarintField(3, ff.type);
          if (ff.geom) fb.writeBytesField(4, ff.geom);
        }, f);
      }
      for (const k of l.keys) pb.writeStringField(3, k);
      for (const v of l.values) pb.writeBytesField(4, v);
      pb.writeVarintField(5, l.extent);
    }, { ...L, keys, values, features });
  }
  return out.finish();
}

async function template() {
  const meta = path.join(HERE, '.cache', 'tilejson.json');
  if (fs.existsSync(meta)) return JSON.parse(fs.readFileSync(meta, 'utf8')).tiles[0];
  const r = await fetch(TILEJSON);
  if (!r.ok) throw new Error(`TileJSON ${r.status}`);
  return (await r.json()).tiles[0];
}

async function download(tpl, z, x, y) {
  // z14 tiles may already be cached by build.mjs.
  const old = path.join(HERE, '.cache', `${z}-${x}-${y}.pbf`);
  const file = path.join(CACHE, `${z}-${x}-${y}.pbf`);
  if (z === 14 && fs.existsSync(old)) return fs.readFileSync(old);
  if (!fs.existsSync(file)) {
    for (let attempt = 1; ; attempt++) {
      const r = await fetch(tpl.replace('{z}', z).replace('{x}', x).replace('{y}', y));
      if (r.ok) {
        fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
        break;
      }
      if (attempt >= 4) throw new Error(`tile ${z}/${x}/${y}: HTTP ${r.status}`);
      await new Promise((res) => setTimeout(res, 1000 * attempt));
    }
  }
  return fs.readFileSync(file);
}

async function main() {
  fs.mkdirSync(CACHE, { recursive: true });
  const tpl = await template();
  const want = new Set();
  const inner = new Set(); // tiles that show part of a city's playable area
  const PAD = 0.004;
  for (const c of CITIES) {
    const [w, s, e, n] = c.bbox;
    for (const z of ZOOMS) {
      const [x0, y0] = lngLatToTile(w - MARGIN.lng, n + MARGIN.lat, z).map(Math.floor);
      const [x1, y1] = lngLatToTile(e + MARGIN.lng, s - MARGIN.lat, z).map(Math.floor);
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) want.add(`${z}/${x}/${y}`);
      const [ix0, iy0] = lngLatToTile(w - PAD, n + PAD, z).map(Math.floor);
      const [ix1, iy1] = lngLatToTile(e + PAD, s - PAD, z).map(Math.floor);
      for (let x = ix0; x <= ix1; x++) for (let y = iy0; y <= iy1; y++) inner.add(`${z}/${x}/${y}`);
    }
  }
  loadLots();
  console.log(`${LOTS.parents.size} merged blocks are replaced by their lots`);
  fs.rmSync(OUT, { recursive: true, force: true });
  let raw = 0;
  let slim = 0;
  let gz = 0;
  for (const k of [...want].sort()) {
    const [z, x, y] = k.split('/').map(Number);
    let buf = await download(tpl, z, x, y);
    if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
    raw += buf.length;
    const s = slimTile(buf, !inner.has(k), [z, x, y]);
    slim += s.length;
    const g = zlib.gzipSync(s, { level: 9 });
    gz += g.length;
    fs.mkdirSync(path.join(OUT, String(z), String(x)), { recursive: true });
    fs.writeFileSync(path.join(OUT, String(z), String(x), `${y}.pbf.gz`), g);
  }
  console.log(`${want.size} tiles: ${(raw / 1e6).toFixed(1)} MB from OpenFreeMap, ${(slim / 1e6).toFixed(1)} MB slimmed, ${(gz / 1e6).toFixed(1)} MB gzipped`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
