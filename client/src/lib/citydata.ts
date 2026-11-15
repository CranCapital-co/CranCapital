// Per-city grids built by tools/citydata, mirroring the server's rules so
// the map can show what's allowed before asking (the server still decides).

export interface CityMeta {
  id: string;
  name: string;
  tz: string;
  bbox: [number, number, number, number];
  origin: [number, number];
  kx: number;
  ky: number;
  widthM: number;
  heightM: number;
  start: { lng: number; lat: number; label: string };
  travelHub: { lng: number; lat: number; label: string };
  grids: {
    walk: { cell: number; w: number; h: number };
    plot: { cell: number; w: number; h: number };
    traffic: { cell: number; w: number; h: number; scale: number };
  };
}

export interface CityData {
  meta: CityMeta;
  traffic: Uint8Array;
  plots: Uint8Array;
  coast: Uint8Array;
  walk?: Uint8Array;
}

const cache = new Map<string, Promise<CityData>>();
const base = import.meta.env.BASE_URL;

async function bin(url: string) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

export function loadCity(id: string): Promise<CityData> {
  if (!cache.has(id)) {
    cache.set(
      id,
      (async () => {
        const dir = `${base}cities/${id}/`;
        const meta = (await (await fetch(dir + 'meta.json')).json()) as CityMeta;
        const [traffic, plots, coast] = await Promise.all([bin(dir + 'traffic.bin'), bin(dir + 'plots.bin'), bin(dir + 'coast.bin')]);
        return { meta, traffic, plots, coast };
      })()
    );
  }
  return cache.get(id)!;
}

// The 5 m walkable-street grid is bigger (~130-210 KB), so it loads only
// when you start placing a cart.
export async function loadWalk(d: CityData): Promise<Uint8Array> {
  if (!d.walk) d.walk = await bin(`${base}cities/${d.meta.id}/walk.bin`);
  return d.walk;
}

const bit = (bits: Uint8Array, i: number) => i >= 0 && i < bits.length * 8 && ((bits[i >> 3] >> (i & 7)) & 1) === 1;

export function toXY(m: CityMeta, lat: number, lng: number) {
  return { x: (lng - m.origin[0]) * m.kx, y: (lat - m.origin[1]) * m.ky };
}

export function inCity(m: CityMeta, lat: number, lng: number) {
  return lng >= m.bbox[0] && lat >= m.bbox[1] && lng <= m.bbox[2] && lat <= m.bbox[3];
}

export function walkable(d: CityData, lat: number, lng: number): boolean | null {
  if (!d.walk) return null;
  const { x, y } = toXY(d.meta, lat, lng);
  const g = d.meta.grids.walk;
  const cx = Math.floor(x / g.cell);
  const cy = Math.floor(y / g.cell);
  if (cx < 0 || cy < 0 || cx >= g.w || cy >= g.h) return false;
  return bit(d.walk, cy * g.w + cx);
}

export function trafficAt(d: CityData, lat: number, lng: number): number {
  const { x, y } = toXY(d.meta, lat, lng);
  const g = d.meta.grids.traffic;
  const cx = Math.floor(x / g.cell);
  const cy = Math.floor(y / g.cell);
  if (cx < 0 || cy < 0 || cx >= g.w || cy >= g.h) return 0.1;
  return d.traffic[cy * g.w + cx] / g.scale;
}

export function plotOf(d: CityData, lat: number, lng: number) {
  const { x, y } = toXY(d.meta, lat, lng);
  return { px: Math.floor(x / 25), py: Math.floor(y / 25) };
}

export function plotBuildable(d: CityData, px: number, py: number) {
  const g = d.meta.grids.plot;
  return px >= 0 && py >= 0 && px < g.w && py < g.h && bit(d.plots, py * g.w + px);
}

export function plotCoastal(d: CityData, px: number, py: number) {
  const g = d.meta.grids.plot;
  return px >= 0 && py >= 0 && px < g.w && py < g.h && bit(d.coast, py * g.w + px);
}

// Corners of a plot cell as [lng, lat].
export function plotPolygon(m: CityMeta, px: number, py: number): [number, number][] {
  const lng0 = m.origin[0] + (px * 25) / m.kx;
  const lng1 = m.origin[0] + ((px + 1) * 25) / m.kx;
  const lat0 = m.origin[1] + (py * 25) / m.ky;
  const lat1 = m.origin[1] + ((py + 1) * 25) / m.ky;
  return [[lng0, lat0], [lng1, lat0], [lng1, lat1], [lng0, lat1], [lng0, lat0]];
}

export function plotCenter(m: CityMeta, px: number, py: number) {
  return { lat: m.origin[1] + ((py + 0.5) * 25) / m.ky, lng: m.origin[0] + ((px + 0.5) * 25) / m.kx };
}

export function distM(lat1: number, lng1: number, lat2: number, lng2: number) {
  const kx = 111320 * Math.cos((((lat1 + lat2) / 2) * Math.PI) / 180);
  return Math.hypot((lng2 - lng1) * kx, (lat2 - lat1) * 110574);
}

// Heat-map image of foot traffic for the map (one pixel per 50 m cell).
export function trafficImage(d: CityData): { url: string; coords: [[number, number], [number, number], [number, number], [number, number]] } {
  const g = d.meta.grids.traffic;
  const c = document.createElement('canvas');
  c.width = g.w;
  c.height = g.h;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(g.w, g.h);
  for (let y = 0; y < g.h; y++)
    for (let x = 0; x < g.w; x++) {
      const v = d.traffic[y * g.w + x] / g.scale; // 0..3
      const t = Math.min(1, v / 2.4);
      const o = ((g.h - 1 - y) * g.w + x) * 4; // north up
      img.data[o] = Math.round(40 + 215 * t);
      img.data[o + 1] = Math.round(180 - 120 * t);
      img.data[o + 2] = Math.round(120 - 90 * t);
      img.data[o + 3] = v <= 0.01 ? 0 : Math.round(60 + 150 * t);
    }
  ctx.putImageData(img, 0, 0);
  const m = d.meta;
  const w = m.origin[0];
  const s = m.origin[1];
  const e = m.origin[0] + (g.w * g.cell) / m.kx;
  const n = m.origin[1] + (g.h * g.cell) / m.ky;
  return { url: c.toDataURL(), coords: [[w, n], [e, n], [e, s], [w, s]] };
}
