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

function slimTile(buf, outer = false) {
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
  fs.rmSync(OUT, { recursive: true, force: true });
  let raw = 0;
  let slim = 0;
  let gz = 0;
  for (const k of [...want].sort()) {
    const [z, x, y] = k.split('/').map(Number);
    let buf = await download(tpl, z, x, y);
    if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
    raw += buf.length;
    const s = slimTile(buf, !inner.has(k));
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
