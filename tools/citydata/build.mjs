// Builds CranCapital's game data for each launch city from OpenFreeMap vector
// tiles (OpenStreetMap data, ODbL). Outputs:
//
//   client/public/cities/<id>/meta.json   grid dimensions + projection
//   client/public/cities/<id>/traffic.bin uint8 foot-traffic score x 80 per 50 m cell
//   client/public/cities/<id>/plots.bin   bit per 25 m buildable plot
//   client/public/cities/<id>/coast.bin   bit per 25 m plot next to open water (ports)
//   client/public/cities/<id>/walk.bin    bit per 5 m walkable street cell (carts)
//   supabase/seed/cities/<id>.sql         city row, grids, buildings, aliases
//
// Usage: node citydata/build.mjs [cityId ...]
// Tiles are cached in tools/citydata/.cache so reruns are offline.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { VectorTile } from '@mapbox/vector-tile';
import Pbf from 'pbf';
import { CITIES, GRID } from './cities.mjs';
import {
  makeFrame,
  lngLatToTile,
  tilePointToLngLat,
  clipRing,
  clipSegment,
  signedArea,
  ringCentroid,
  pointInRings,
  Raster,
  packBits,
} from './geo.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const CACHE = path.join(HERE, '.cache');
const Z = 14;
const TILEJSON = 'https://tiles.openfreemap.org/planet';

const WALK_HALF_WIDTH = {
  trunk: 9,
  primary: 8,
  secondary: 7,
  tertiary: 6,
  minor: 5,
  service: 3.5,
  path: 3,
  track: 3,
  pier: 3,
  bridge: 4,
};

// Foot traffic weight of each point of interest class.
const POI_WEIGHT = {
  railway: 40,
  attraction: 22,
  museum: 18,
  stadium: 20,
  theatre: 10,
  cinema: 8,
  art_gallery: 5,
  zoo: 15,
  shop: 3,
  clothing_store: 3,
  grocery: 3,
  fast_food: 3.5,
  restaurant: 3,
  cafe: 3,
  bar: 3,
  beer: 3,
  ice_cream: 3,
  lodging: 4,
  office: 2,
  college: 5,
  university: 6,
  school: 2,
  hospital: 6,
  park: 4,
  library: 2,
  place_of_worship: 2,
  bank: 2,
  post: 1,
  information: 3,
  bus: 3,
  town_hall: 4,
  castle: 12,
  monument: 6,
  ferry_terminal: 10,
};

const LANDMARK_CLASSES = new Set([
  'attraction',
  'museum',
  'theatre',
  'castle',
  'monument',
  'stadium',
  'zoo',
  'town_hall',
]);
const FOOD_SHOP_CLASSES = new Set([
  'shop',
  'clothing_store',
  'grocery',
  'fast_food',
  'restaurant',
  'cafe',
  'bar',
  'beer',
  'ice_cream',
  'bakery',
  'alcohol_shop',
  'jewelry',
  'florist',
]);

function cachePath(z, x, y) {
  return path.join(CACHE, `${z}-${x}-${y}.pbf`);
}

async function tileUrlTemplate() {
  const metaFile = path.join(CACHE, 'tilejson.json');
  if (fs.existsSync(metaFile)) return JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  const res = await fetch(TILEJSON);
  if (!res.ok) throw new Error(`TileJSON ${res.status}`);
  const json = await res.json();
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(metaFile, JSON.stringify({ tiles: json.tiles }, null, 1));
  return { tiles: json.tiles };
}

async function getTile(template, x, y) {
  const file = cachePath(Z, x, y);
  if (!fs.existsSync(file)) {
    const url = template.replace('{z}', Z).replace('{x}', x).replace('{y}', y);
    for (let attempt = 1; ; attempt++) {
      const res = await fetch(url);
      if (res.ok) {
        fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
        break;
      }
      if (attempt >= 4) throw new Error(`tile ${x},${y}: HTTP ${res.status}`);
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
  let buf = fs.readFileSync(file);
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
  return new VectorTile(new Pbf(buf));
}

function q(s) {
  if (s === null || s === undefined) return 'null';
  return `'${String(s).replace(/'/g, "''")}'`;
}

async function buildCity(city, template) {
  const t0 = Date.now();
  const frame = makeFrame(city.bbox);
  const [west, south, east, north] = city.bbox;
  const [txa, tya] = lngLatToTile(west, north, Z);
  const [txb, tyb] = lngLatToTile(east, south, Z);
  const tiles = [];
  for (let x = Math.floor(txa); x <= Math.floor(txb); x++)
    for (let y = Math.floor(tya); y <= Math.floor(tyb); y++) tiles.push([x, y]);

  const walk = new Raster(frame.width, frame.height, GRID.walk); // 1 = walkable
  const blocked = new Raster(frame.width, frame.height, GRID.walk); // 1 = not buildable
  const water = new Raster(frame.width, frame.height, GRID.walk); // 1 = open water
  const anyWater = new Raster(frame.width, frame.height, GRID.walk);
  const pedestrian = new Raster(frame.width, frame.height, GRID.walk); // pedestrian streets
  const landuse = new Raster(frame.width, frame.height, GRID.walk); // landuse code
  const LANDUSE_CODE = { residential: 1, commercial: 2, retail: 2, industrial: 3 };

  const buildings = new Map(); // id -> building accumulator
  const pois = [];

  const toXY = (tx, ty, ext) => (p) => {
    const [lng, lat] = tilePointToLngLat(tx, ty, Z, p.x, p.y, ext);
    return frame.toXY(lng, lat);
  };

  for (const [tx, ty] of tiles) {
    const tile = await getTile(template, tx, ty);
    const get = (name) => tile.layers[name];

    // Buildings
    const bl = get('building');
    if (bl) {
      const conv = toXY(tx, ty, bl.extent);
      for (let i = 0; i < bl.length; i++) {
        const f = bl.feature(i);
        if (f.type !== 3 || f.id === undefined) continue;
        const rings = f
          .loadGeometry()
          .map((r) => clipRing(r, bl.extent))
          .filter((r) => r.length >= 3)
          .map((r) => r.map(conv));
        if (!rings.length) continue;
        let b = buildings.get(f.id);
        if (!b) {
          b = {
            id: f.id,
            rings: [],
            area: 0,
            cx: 0,
            cy: 0,
            height: 0,
            minHeight: Infinity,
            hide3d: false,
          };
          buildings.set(f.id, b);
        }
        // Classify rings: those with the same winding as the first are outer.
        const sign = Math.sign(signedArea(rings[0])) || 1;
        for (const r of rings) {
          const [cx, cy, a] = ringCentroid(r);
          const sa = a * sign;
          b.area += sa;
          b.cx += cx * sa;
          b.cy += cy * sa;
          b.rings.push(r);
        }
        const p = f.properties;
        b.height = Math.max(b.height, Number(p.render_height) || 0);
        b.minHeight = Math.min(b.minHeight, Number(p.render_min_height) || 0);
        if (p.hide_3d) b.hide3d = true;
      }
    }

    // Streets and paths
    const tl = get('transportation');
    if (tl) {
      const conv = toXY(tx, ty, tl.extent);
      for (let i = 0; i < tl.length; i++) {
        const f = tl.feature(i);
        const p = f.properties;
        const cls = p.class;
        if (p.brunnel === 'tunnel') continue;
        const hw = WALK_HALF_WIDTH[cls];
        if (!hw) continue;
        const isPed = cls === 'path' && (p.subclass === 'pedestrian' || p.subclass === 'footway');
        if (f.type === 2) {
          for (const line of f.loadGeometry()) {
            for (let k = 0; k + 1 < line.length; k++) {
              const seg = clipSegment(line[k], line[k + 1], tl.extent);
              if (!seg) continue;
              const a = conv(seg[0]);
              const b = conv(seg[1]);
              walk.strokeSegment(a, b, hw, 1);
              blocked.strokeSegment(a, b, Math.max(hw, 4), 1);
              if (isPed) pedestrian.strokeSegment(a, b, hw, 1);
            }
          }
        } else if (f.type === 3) {
          const rings = f
            .loadGeometry()
            .map((r) => clipRing(r, tl.extent))
            .filter((r) => r.length >= 3)
            .map((r) => r.map(conv));
          if (!rings.length) continue;
          walk.fillRings(rings, 1);
          blocked.fillRings(rings, 1);
          if (cls === 'path' || cls === 'pier') pedestrian.fillRings(rings, 1);
        }
      }
    }

    // Water, parks and other land that can't be built on
    for (const layerName of ['water', 'park', 'landuse', 'landcover']) {
      const l = get(layerName);
      if (!l) continue;
      const conv = toXY(tx, ty, l.extent);
      for (let i = 0; i < l.length; i++) {
        const f = l.feature(i);
        if (f.type !== 3) continue;
        const cls = f.properties.class;
        let block = false;
        let isWater = false;
        let isOpenWater = false;
        if (layerName === 'water') {
          block = true;
          isWater = true;
          isOpenWater = ['ocean', 'river', 'lake', 'sea', 'bay', 'dock'].includes(cls);
        } else if (layerName === 'park') block = true;
        else if (layerName === 'landuse')
          block = ['cemetery', 'railway', 'military', 'pitch', 'stadium', 'track', 'zoo', 'theme_park', 'garages'].includes(cls);
        else if (layerName === 'landcover') block = ['wood', 'wetland', 'ice', 'sand'].includes(cls);
        const code = layerName === 'landuse' ? LANDUSE_CODE[cls] : undefined;
        if (!block && !code) continue;
        const rings = f
          .loadGeometry()
          .map((r) => clipRing(r, l.extent))
          .filter((r) => r.length >= 3)
          .map((r) => r.map(conv));
        if (!rings.length) continue;
        if (block) blocked.fillRings(rings, 1);
        if (isWater) anyWater.fillRings(rings, 1);
        if (isOpenWater) water.fillRings(rings, 1);
        if (code) landuse.fillRings(rings, code);
      }
    }

    // Points of interest
    const pl = get('poi');
    if (pl) {
      const conv = toXY(tx, ty, pl.extent);
      for (let i = 0; i < pl.length; i++) {
        const f = pl.feature(i);
        if (f.type !== 1) continue;
        const pt = f.loadGeometry()[0][0];
        if (pt.x < 0 || pt.y < 0 || pt.x > pl.extent || pt.y > pl.extent) continue;
        const [x, y] = conv(pt);
        if (x < 0 || y < 0 || x > frame.width || y > frame.height) continue;
        const p = f.properties;
        pois.push({ x, y, cls: p.class, sub: p.subclass, name: p['name:en'] || p.name || null, rank: p.rank ?? 99 });
      }
    }
  }

  // Buildings become solid: not walkable, not buildable.
  const finalBuildings = [];
  for (const b of buildings.values()) {
    if (!(b.area > 0)) continue;
    b.cx /= b.area;
    b.cy /= b.area;
    blocked.fillRings(b.rings, 1);
    walk.fillRings(b.rings, 0);
    if (b.cx < 0 || b.cy < 0 || b.cx > frame.width || b.cy > frame.height) continue;
    finalBuildings.push(b);
  }
  // Water is never walkable.
  for (let i = 0; i < walk.data.length; i++) if (anyWater.data[i]) walk.data[i] = 0;

  // Building parts: a building split into 3D parts has an outline marked
  // hide_3d plus separate part features. Map each part to its outline so a
  // click on any part resolves to the whole building.
  const outlines = finalBuildings.filter((b) => b.hide3d);
  const aliases = [];
  const outlineIndex = new Map();
  const IDX = 100;
  const bboxOf = (rings) => {
    let a = [Infinity, Infinity, -Infinity, -Infinity];
    for (const r of rings) for (const [x, y] of r) a = [Math.min(a[0], x), Math.min(a[1], y), Math.max(a[2], x), Math.max(a[3], y)];
    return a;
  };
  for (const o of outlines) {
    o.bbox = bboxOf(o.rings);
    for (let gx = Math.floor(o.bbox[0] / IDX); gx <= Math.floor(o.bbox[2] / IDX); gx++)
      for (let gy = Math.floor(o.bbox[1] / IDX); gy <= Math.floor(o.bbox[3] / IDX); gy++) {
        const k = `${gx},${gy}`;
        if (!outlineIndex.has(k)) outlineIndex.set(k, []);
        outlineIndex.get(k).push(o);
      }
  }
  const partIds = new Set();
  for (const b of finalBuildings) {
    if (b.hide3d) continue;
    const cands = outlineIndex.get(`${Math.floor(b.cx / IDX)},${Math.floor(b.cy / IDX)}`) || [];
    for (const o of cands) {
      if (o.id !== b.id && pointInRings(b.cx, b.cy, o.rings) && b.area < o.area * 1.05) {
        aliases.push([b.id, o.id]);
        partIds.add(b.id);
        o.height = Math.max(o.height, b.height);
        break;
      }
    }
  }
  let gameBuildings = finalBuildings.filter((b) => !partIds.has(b.id) && b.area >= 20);

  // POIs inside buildings give them a kind and sometimes a name.
  const bIndex = new Map();
  for (const b of gameBuildings) {
    b.bbox = b.bbox || bboxOf(b.rings);
    for (let gx = Math.floor(b.bbox[0] / IDX); gx <= Math.floor(b.bbox[2] / IDX); gx++)
      for (let gy = Math.floor(b.bbox[1] / IDX); gy <= Math.floor(b.bbox[3] / IDX); gy++) {
        const k = `${gx},${gy}`;
        if (!bIndex.has(k)) bIndex.set(k, []);
        bIndex.get(k).push(b);
      }
  }
  for (const p of pois) {
    const cands = bIndex.get(`${Math.floor(p.x / IDX)},${Math.floor(p.y / IDX)}`) || [];
    for (const b of cands) {
      if (p.x < b.bbox[0] || p.x > b.bbox[2] || p.y < b.bbox[1] || p.y > b.bbox[3]) continue;
      if (pointInRings(p.x, p.y, b.rings)) {
        (b.pois = b.pois || []).push(p);
        break;
      }
    }
  }

  // Foot traffic grid.
  const tr = new Raster(frame.width, frame.height, GRID.traffic);
  const raw = new Float64Array(tr.w * tr.h);
  const R = 360;
  const rc = Math.ceil(R / GRID.traffic);
  for (const p of pois) {
    let w = POI_WEIGHT[p.cls] ?? 1;
    if (p.cls === 'railway' && p.sub && !['station', 'subway', 'halt'].includes(p.sub)) w = 6;
    const pcx = Math.floor(p.x / GRID.traffic);
    const pcy = Math.floor(p.y / GRID.traffic);
    for (let cy = pcy - rc; cy <= pcy + rc; cy++) {
      if (cy < 0 || cy >= tr.h) continue;
      for (let cx = pcx - rc; cx <= pcx + rc; cx++) {
        if (cx < 0 || cx >= tr.w) continue;
        const dx = (cx + 0.5) * GRID.traffic - p.x;
        const dy = (cy + 0.5) * GRID.traffic - p.y;
        const d = Math.hypot(dx, dy);
        if (d > R) continue;
        raw[cy * tr.w + cx] += w * Math.exp(-d / 120);
      }
    }
  }
  // Street share and pedestrian bonus per traffic cell.
  const ratio = GRID.traffic / GRID.walk;
  const walkShare = new Float64Array(tr.w * tr.h);
  const waterShare = new Float64Array(tr.w * tr.h);
  for (let cy = 0; cy < walk.h; cy++)
    for (let cx = 0; cx < walk.w; cx++) {
      const ti = Math.floor(cy / ratio) * tr.w + Math.floor(cx / ratio);
      if (ti >= raw.length) continue;
      const i = cy * walk.w + cx;
      if (walk.data[i]) walkShare[ti] += 1 / (ratio * ratio);
      if (pedestrian.data[i]) raw[ti] += 0.6;
      if (anyWater.data[i]) waterShare[ti] += 1 / (ratio * ratio);
    }
  const landVals = [];
  for (let i = 0; i < raw.length; i++) if (walkShare[i] > 0.05 && waterShare[i] < 0.5) landVals.push(raw[i]);
  landVals.sort((a, b) => a - b);
  const pct = (p) => landVals[Math.min(landVals.length - 1, Math.floor(p * landVals.length))] || 1;
  const p50 = pct(0.5);
  const traffic = new Uint8Array(tr.w * tr.h);
  const scoreAt = new Float64Array(tr.w * tr.h);
  for (let i = 0; i < raw.length; i++) {
    let s = Math.pow(raw[i] / p50, 0.55);
    if (walkShare[i] < 0.05) s *= 0.35;
    if (waterShare[i] > 0.6) s = 0;
    s = Math.max(waterShare[i] > 0.6 ? 0 : 0.1, Math.min(3, s));
    scoreAt[i] = s;
    traffic[i] = Math.round(s * 80);
  }
  const trafficAt = (x, y) => {
    const cx = Math.min(tr.w - 1, Math.max(0, Math.floor(x / GRID.traffic)));
    const cy = Math.min(tr.h - 1, Math.max(0, Math.floor(y / GRID.traffic)));
    return traffic[cy * tr.w + cx] / 80;
  };

  // Buildable plots and coastal plots (ports).
  const pl = new Raster(frame.width, frame.height, GRID.plot);
  const pr = GRID.plot / GRID.walk;
  const plots = new Uint8Array(pl.w * pl.h);
  const coast = new Uint8Array(pl.w * pl.h);
  const nearWater = (cx5, cy5, rad) => {
    for (let dy = -rad; dy <= rad; dy++)
      for (let dx = -rad; dx <= rad; dx++) if (water.get(cx5 + dx, cy5 + dy)) return true;
    return false;
  };
  let plotCount = 0;
  let coastCount = 0;
  for (let py = 0; py < pl.h; py++)
    for (let px = 0; px < pl.w; px++) {
      if ((px + 1) * GRID.plot > frame.width || (py + 1) * GRID.plot > frame.height) continue;
      let free = 0;
      for (let sy = 0; sy < pr; sy++)
        for (let sx = 0; sx < pr; sx++) if (!blocked.get(px * pr + sx, py * pr + sy)) free++;
      if (free >= pr * pr - 2) {
        plots[py * pl.w + px] = 1;
        plotCount++;
        if (nearWater(px * pr + 2, py * pr + 2, 8)) {
          coast[py * pl.w + px] = 1;
          coastCount++;
        }
      }
    }

  // Final building records.
  const records = [];
  for (const b of gameBuildings) {
    const height = Math.max(3, Math.round(b.height * 10) / 10);
    const levels = Math.max(1, Math.min(80, Math.round(height / 3.5)));
    const footprint = Math.round(b.area);
    const floorArea = footprint * levels;
    const rooms = Math.max(1, Math.min(80, Math.round(floorArea / 250)));
    const merged = footprint > 25000; // tiles merge whole blocks into one feature
    let kind = null;
    let name = null;
    let best = null;
    for (const p of merged ? [] : b.pois || []) {
      let k = null;
      if (p.cls === 'railway' && ['station', 'subway', 'halt'].includes(p.sub)) k = 'station';
      else if (LANDMARK_CLASSES.has(p.cls)) k = 'landmark';
      else if (p.cls === 'lodging') k = 'hotel';
      else if (['college', 'university', 'school'].includes(p.cls)) k = 'education';
      else if (p.cls === 'hospital') k = 'hospital';
      else if (p.cls === 'place_of_worship') k = 'worship';
      else if (FOOD_SHOP_CLASSES.has(p.cls)) k = 'commercial';
      else if (p.cls === 'office') k = 'office';
      if (!k) continue;
      const order = ['station', 'landmark', 'hospital', 'education', 'worship', 'hotel', 'commercial', 'office'];
      const score = order.indexOf(k) * 100 + (p.rank || 0);
      if (!best || score < best.score) best = { k, score, name: p.name };
    }
    if (best) {
      kind = best.k;
      if (['station', 'landmark', 'hospital', 'education', 'worship', 'hotel'].includes(kind)) name = best.name;
    }
    if (!kind) {
      const lu = landuse.get(Math.floor(b.cx / GRID.walk), Math.floor(b.cy / GRID.walk));
      kind = lu === 1 ? 'residential' : lu === 2 ? 'commercial' : lu === 3 ? 'industrial' : 'mixed';
    }
    const landmark = !merged && (['station', 'landmark', 'worship'].includes(kind) || (!!name && footprint > 4000));
    const [lng, lat] = frame.toLngLat(b.cx, b.cy);
    records.push({
      id: b.id,
      lng: Math.round(lng * 1e6) / 1e6,
      lat: Math.round(lat * 1e6) / 1e6,
      footprint,
      height,
      levels,
      rooms,
      kind,
      name: name ? name.slice(0, 80) : null,
      landmark,
      traffic: trafficAt(b.cx, b.cy),
    });
  }

  // Write client files.
  const outDir = path.join(ROOT, 'client/public/cities', city.id);
  fs.mkdirSync(outDir, { recursive: true });
  const walkBits = packBits(walk.data);
  const plotBits = packBits(plots);
  const coastBits = packBits(coast);
  const meta = {
    id: city.id,
    name: city.name,
    country: city.country,
    tz: city.tz,
    climate: city.climate,
    bbox: city.bbox,
    start: city.start,
    travelHub: city.travelHub,
    origin: [frame.lng0, frame.lat0],
    kx: frame.kx,
    ky: frame.ky,
    widthM: frame.width,
    heightM: frame.height,
    grids: {
      walk: { cell: GRID.walk, w: walk.w, h: walk.h },
      plot: { cell: GRID.plot, w: pl.w, h: pl.h },
      traffic: { cell: GRID.traffic, w: tr.w, h: tr.h, scale: 80 },
    },
    counts: { buildings: records.length, plots: plotCount, coast: coastCount, pois: pois.length },
  };
  fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify(meta, null, 1));
  fs.writeFileSync(path.join(outDir, 'traffic.bin'), traffic);
  fs.writeFileSync(path.join(outDir, 'plots.bin'), plotBits);
  fs.writeFileSync(path.join(outDir, 'coast.bin'), coastBits);
  fs.writeFileSync(path.join(outDir, 'walk.bin'), walkBits);

  // Write SQL seed.
  const sqlDir = path.join(ROOT, 'supabase/seed/cities');
  fs.mkdirSync(sqlDir, { recursive: true });
  const hex = (u8) => Buffer.from(u8).toString('hex');
  const lines = [];
  lines.push(`-- Generated by tools/citydata/build.mjs from OpenFreeMap tiles.`);
  lines.push(`-- Map data (c) OpenStreetMap contributors, ODbL 1.0. Do not edit by hand.`);
  lines.push(
    `insert into game.cities (id, name, country, tz, climate, bbox, start_lng, start_lat, start_label, hub_lng, hub_lat, hub_label, lng0, lat0, kx, ky, width_m, height_m, walk_w, walk_h, plot_w, plot_h, traffic_w, traffic_h, walk_bits, plot_bits, coast_bits, traffic) values (` +
      [
        q(city.id),
        q(city.name),
        q(city.country),
        q(city.tz),
        q(city.climate),
        `array[${city.bbox.join(',')}]::float8[]`,
        city.start.lng,
        city.start.lat,
        q(city.start.label),
        city.travelHub.lng,
        city.travelHub.lat,
        q(city.travelHub.label),
        frame.lng0,
        frame.lat0,
        frame.kx,
        frame.ky,
        frame.width.toFixed(1),
        frame.height.toFixed(1),
        walk.w,
        walk.h,
        pl.w,
        pl.h,
        tr.w,
        tr.h,
        `decode('${hex(walkBits)}','hex')`,
        `decode('${hex(plotBits)}','hex')`,
        `decode('${hex(coastBits)}','hex')`,
        `decode('${hex(traffic)}','hex')`,
      ].join(', ') +
      `) on conflict (id) do update set name = excluded.name, country = excluded.country, tz = excluded.tz, climate = excluded.climate, bbox = excluded.bbox, start_lng = excluded.start_lng, start_lat = excluded.start_lat, start_label = excluded.start_label, hub_lng = excluded.hub_lng, hub_lat = excluded.hub_lat, hub_label = excluded.hub_label, lng0 = excluded.lng0, lat0 = excluded.lat0, kx = excluded.kx, ky = excluded.ky, width_m = excluded.width_m, height_m = excluded.height_m, walk_w = excluded.walk_w, walk_h = excluded.walk_h, plot_w = excluded.plot_w, plot_h = excluded.plot_h, traffic_w = excluded.traffic_w, traffic_h = excluded.traffic_h, walk_bits = excluded.walk_bits, plot_bits = excluded.plot_bits, coast_bits = excluded.coast_bits, traffic = excluded.traffic;`
  );
  const BATCH = 500;
  for (let i = 0; i < records.length; i += BATCH) {
    const vals = records
      .slice(i, i + BATCH)
      .map(
        (r) =>
          `(${r.id},${q(city.id)},${r.lat},${r.lng},${r.footprint},${r.height},${r.levels},${r.rooms},${q(r.kind)},${q(r.name)},${r.landmark},${r.traffic.toFixed(3)})`
      )
      .join(',\n');
    lines.push(
      `insert into game.buildings (id, city_id, lat, lng, footprint_m2, height_m, levels, rooms_total, kind, name, landmark, traffic) values\n${vals}\non conflict (id) do update set city_id = excluded.city_id, lat = excluded.lat, lng = excluded.lng, footprint_m2 = excluded.footprint_m2, height_m = excluded.height_m, levels = excluded.levels, rooms_total = excluded.rooms_total, kind = excluded.kind, name = excluded.name, landmark = excluded.landmark, traffic = excluded.traffic;`
    );
  }
  const keep = new Set(records.map((r) => r.id));
  const goodAliases = aliases.filter(([, o]) => keep.has(o));
  for (let i = 0; i < goodAliases.length; i += 1000) {
    const vals = goodAliases
      .slice(i, i + 1000)
      .map(([a, o]) => `(${a},${o})`)
      .join(',');
    lines.push(
      `insert into game.building_aliases (alias_id, building_id) values ${vals} on conflict (alias_id) do update set building_id = excluded.building_id;`
    );
  }
  fs.writeFileSync(path.join(sqlDir, `${city.id}.sql`), lines.join('\n') + '\n');

  const kinds = {};
  for (const r of records) kinds[r.kind] = (kinds[r.kind] || 0) + 1;
  const tv = [...scoreAt].filter((v) => v > 0).sort((a, b) => a - b);
  console.log(
    `${city.id}: ${tiles.length} tiles, ${records.length} buildings (${goodAliases.length} part aliases), ${plotCount} plots (${coastCount} coastal), ${pois.length} POIs, walk ${walk.w}x${walk.h}, traffic p10 ${tv[Math.floor(tv.length * 0.1)]?.toFixed(2)} p50 ${tv[Math.floor(tv.length * 0.5)]?.toFixed(2)} p90 ${tv[Math.floor(tv.length * 0.9)]?.toFixed(2)} max ${tv[tv.length - 1]?.toFixed(2)}; ${JSON.stringify(kinds)} in ${((Date.now() - t0) / 1000).toFixed(1)}s`
  );
}

const wanted = process.argv.slice(2);
const { tiles } = await tileUrlTemplate();
fs.mkdirSync(CACHE, { recursive: true });
for (const city of CITIES) {
  if (wanted.length && !wanted.includes(city.id)) continue;
  await buildCity(city, tiles[0]);
}
