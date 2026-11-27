// Sea lanes on a quarter-degree grid of water cells, shared by the map (to
// draw ships and their routes) and tools/world/sea.mjs (which works out the
// sea distance between every pair of coastal countries for the server).
// No imports, so Node can run it directly.
//
// The grid (client/public/world/sea.bin.gz, built by tools/world/sea.mjs):
//   * water: a cell is sea only if land covers at most an eighth of it, so
//     ships keep clear of every coast; the polar ice is closed;
//   * owner: which country's land covers each land cell most;
//   * tag: cells of the straits and canals a country can control (Suez,
//     Panama, Gibraltar...), cut open so ships can pass.

export const CELL = 0.25;
export const GW = 360 / CELL;
export const GH = 180 / CELL;

export interface SeaGrid {
  water: Uint8Array; // 1 = sea
  owner: Uint8Array; // land: country index + 1; 0 = none
  tag: Uint8Array; // waterway index + 1 on its channel cells
  countries: string[];
  waterways: string[];
}

// ---------------------------------------------------------------------------
// The file
// ---------------------------------------------------------------------------
export function encodeGrid(g: SeaGrid): Uint8Array {
  const names = [...g.countries, ...g.waterways];
  let n = 4 + 2 + 2 + 2 + 1;
  for (const s of names) n += 1 + s.length;
  const bits = Math.ceil((GW * GH) / 8);
  const out = new Uint8Array(n + bits + GW * GH * 2);
  let o = 0;
  out.set([83, 69, 65, 49], 0); // SEA1
  o = 4;
  const u16 = (v: number) => {
    out[o++] = v & 255;
    out[o++] = v >> 8;
  };
  u16(GW);
  u16(GH);
  u16(g.countries.length);
  out[o++] = g.waterways.length;
  for (const s of names) {
    out[o++] = s.length;
    for (let i = 0; i < s.length; i++) out[o++] = s.charCodeAt(i);
  }
  for (let i = 0; i < GW * GH; i++) if (g.water[i]) out[o + (i >> 3)] |= 1 << (i & 7);
  o += bits;
  out.set(g.owner, o);
  o += GW * GH;
  out.set(g.tag, o);
  return out;
}

export function decodeGrid(b: Uint8Array): SeaGrid {
  if (b[0] !== 83 || b[1] !== 69 || b[2] !== 65 || b[3] !== 49) throw new Error('Not a sea grid');
  let o = 4;
  const u16 = () => {
    const v = b[o] | (b[o + 1] << 8);
    o += 2;
    return v;
  };
  if (u16() !== GW || u16() !== GH) throw new Error('Sea grid size mismatch');
  const nc = u16();
  const nw = b[o++];
  const str = () => {
    const len = b[o++];
    let s = '';
    for (let i = 0; i < len; i++) s += String.fromCharCode(b[o++]);
    return s;
  };
  const countries: string[] = [];
  for (let i = 0; i < nc; i++) countries.push(str());
  const waterways: string[] = [];
  for (let i = 0; i < nw; i++) waterways.push(str());
  const water = new Uint8Array(GW * GH);
  for (let i = 0; i < GW * GH; i++) water[i] = (b[o + (i >> 3)] >> (i & 7)) & 1;
  o += Math.ceil((GW * GH) / 8);
  const owner = b.slice(o, o + GW * GH);
  o += GW * GH;
  const tag = b.slice(o, o + GW * GH);
  return { water, owner, tag, countries, waterways };
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------
export const cellX = (lng: number) => ((Math.floor((lng + 180) / CELL) % GW) + GW) % GW;
export const cellY = (lat: number) => Math.max(0, Math.min(GH - 1, Math.floor((90 - lat) / CELL)));
export const cellOf = (lng: number, lat: number) => cellY(lat) * GW + cellX(lng);
export const cellLng = (i: number) => (i % GW) * CELL - 180 + CELL / 2;
export const cellLat = (i: number) => 90 - (Math.floor(i / GW) + 0.5) * CELL;
const KM_LAT = 110.57 * CELL;
const KM_LNG = Float64Array.from({ length: GH }, (_, y) => Math.max(0.5, 111.32 * CELL * Math.cos(((90 - (y + 0.5) * CELL) * Math.PI) / 180)));
export function km(a: [number, number], b: [number, number]) {
  const r = Math.PI / 180;
  const s = Math.sin(((b[1] - a[1]) * r) / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(((b[0] - a[0]) * r) / 2) ** 2;
  return 12742 * Math.asin(Math.min(1, Math.sqrt(s)));
}

// Water cells next to a country's mainland (its coast): the landmass at or
// nearest its centre, so France sails from France, not French Guiana, and
// the United States from its 48 states, not Alaska. For a country whose
// coast is too small for the grid: the nearest sea to its land.
const coastCache = new WeakMap<SeaGrid, Map<string, Int32Array>>();
export function coastCells(g: SeaGrid, country: string, near?: [number, number]): Int32Array {
  const idx = g.countries.indexOf(country);
  if (idx < 0) return new Int32Array(0);
  let cache = coastCache.get(g);
  if (!cache) coastCache.set(g, (cache = new Map()));
  const key = `${country}:${near ? near.join(',') : ''}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const own = idx + 1;
  // The landmass: flood fill from the country's land nearest `near`.
  let seed = -1;
  if (near) {
    const c0 = cellOf(near[0], near[1]);
    if (g.owner[c0] === own) seed = c0;
    else {
      const cx = c0 % GW;
      const cy = (c0 / GW) | 0;
      let bd = Infinity;
      for (let i = 0; i < g.owner.length; i++) {
        if (g.owner[i] !== own) continue;
        let dx = Math.abs((i % GW) - cx);
        dx = Math.min(dx, GW - dx);
        const d = dx * dx + (((i / GW) | 0) - cy) ** 2;
        if (d < bd) {
          bd = d;
          seed = i;
        }
      }
    }
  }
  const land: number[] = [];
  if (seed >= 0) {
    const seen = new Uint8Array(g.owner.length);
    const stack = [seed];
    seen[seed] = 1;
    while (stack.length) {
      const i = stack.pop()!;
      land.push(i);
      const x = i % GW;
      const y = (i / GW) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= GH) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const j = ny * GW + ((x + dx + GW) % GW);
          if (!seen[j] && g.owner[j] === own) {
            seen[j] = 1;
            stack.push(j);
          }
        }
      }
    }
  } else {
    for (let i = 0; i < g.owner.length; i++) if (g.owner[i] === own) land.push(i);
  }
  const out = new Set<number>();
  for (const i of land) {
    const x = i % GW;
    const y = (i / GW) | 0;
    for (let dy = -1; dy <= 1; dy++) {
      const ny = y + dy;
      if (ny < 0 || ny >= GH) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const j = ny * GW + ((x + dx + GW) % GW);
        if (g.water[j] && !g.tag[j]) out.add(j);
      }
    }
  }
  let cells = [...out];
  if (!cells.length && land.length) {
    // A sliver of coast: the nearest water to any of its land.
    let best = -1;
    let bd = Infinity;
    for (const i of land) {
      const x = i % GW;
      const y = (i / GW) | 0;
      for (let r = 1; r <= 6; r++) {
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            const ny = y + dy;
            if (ny < 0 || ny >= GH) continue;
            const j = ny * GW + ((x + dx + GW) % GW);
            const d = dx * dx + dy * dy;
            if (g.water[j] && !g.tag[j] && d < bd) {
              bd = d;
              best = j;
            }
          }
        }
      }
    }
    cells = best >= 0 ? [best] : [];
  }
  const arr = Int32Array.from(cells);
  cache.set(key, arr);
  return arr;
}

// The nearest open water to a point (for a port city), or -1.
export function nearestSea(g: SeaGrid, lng: number, lat: number, maxR = 40): number {
  const cx = cellX(lng);
  const cy = cellY(lat);
  for (let r = 0; r <= maxR; r++) {
    let best = -1;
    let bd = Infinity;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const ny = cy + dy;
        if (ny < 0 || ny >= GH) continue;
        const j = ny * GW + ((cx + dx + GW) % GW);
        const d = dx * dx + dy * dy;
        if (g.water[j] && !g.tag[j] && d < bd) {
          bd = d;
          best = j;
        }
      }
    }
    if (best >= 0) return best;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Shortest sea paths
// ---------------------------------------------------------------------------
class Heap {
  f: number[] = [];
  v: number[] = [];
  push(f: number, v: number) {
    const F = this.f;
    const V = this.v;
    let k = F.length;
    F.push(f);
    V.push(v);
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (F[p] <= f) break;
      F[k] = F[p];
      V[k] = V[p];
      k = p;
    }
    F[k] = f;
    V[k] = v;
  }
  pop() {
    const F = this.f;
    const V = this.v;
    const top = V[0];
    const lf = F.pop()!;
    const lv = V.pop()!;
    if (F.length) {
      let k = 0;
      for (;;) {
        let c = 2 * k + 1;
        if (c >= F.length) break;
        if (c + 1 < F.length && F[c + 1] < F[c]) c++;
        if (F[c] >= lf) break;
        F[k] = F[c];
        V[k] = V[c];
        k = c;
      }
      F[k] = lf;
      V[k] = lv;
    }
    return top;
  }
  get size() {
    return this.f.length;
  }
}

export interface Search {
  dist: Float32Array; // km from the nearest source
  prev: Int32Array; // the cell before, on the way back to a source
}

let buf: Search | null = null;
let shut: Uint8Array | null = null;

// From any `from` cell: shortest sea distances (km), stopping at the first
// `to` cell reached when `to` is given (A* towards them), or exploring the
// whole sea when it isn't. `blocked`: waterway tags ships may not pass.
// Returns the cell reached (or -1).
export function search(g: SeaGrid, from: ArrayLike<number>, to: ArrayLike<number> | null, blocked: Set<number> = new Set(), keep = false): { reached: number; s: Search } {
  const N = GW * GH;
  const s: Search = keep ? { dist: new Float32Array(N), prev: new Int32Array(N) } : (buf ??= { dist: new Float32Array(N), prev: new Int32Array(N) });
  shut ??= new Uint8Array(N);
  s.dist.fill(Infinity);
  s.prev.fill(-1);
  shut.fill(0);
  const goal = to ? new Set(Array.from(to)) : null;
  // Heuristic: distance to the box around the targets (never more than the
  // real distance), weighted a little for speed.
  let h = (_i: number) => 0;
  if (to && to.length) {
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (let k = 0; k < to.length; k++) {
      const x = to[k] % GW;
      const y = (to[k] / GW) | 0;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    }
    const wide = x1 - x0 > GW / 2;
    h = (i: number) => {
      const x = i % GW;
      const y = (i / GW) | 0;
      const dy = y < y0 ? y0 - y : y > y1 ? y - y1 : 0;
      let dx = 0;
      if (!wide) {
        const a = x < x0 ? x0 - x : x > x1 ? x - x1 : 0;
        dx = Math.min(a, GW - a);
      }
      const yy = Math.min(GH - 1, Math.max(y, Math.min(y0, y1)));
      return 1.15 * Math.hypot(dx * KM_LNG[yy] * 0.85, dy * KM_LAT);
    };
  }
  const heap = new Heap();
  for (let k = 0; k < from.length; k++) {
    const i = from[k];
    if (!g.water[i]) continue;
    s.dist[i] = 0;
    heap.push(h(i), i);
  }
  while (heap.size) {
    const i = heap.pop();
    if (shut[i]) continue;
    shut[i] = 1;
    if (goal && goal.has(i)) return { reached: i, s };
    const x = i % GW;
    const y = (i / GW) | 0;
    const di = s.dist[i];
    for (let dy = -1; dy <= 1; dy++) {
      const ny = y + dy;
      if (ny < 0 || ny >= GH) continue;
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = (x + dx + GW) % GW;
        const j = ny * GW + nx;
        if (!g.water[j] || shut[j]) continue;
        const t = g.tag[j];
        if (t && blocked.has(t)) continue;
        // No cutting corners past land.
        if (dx && dy && (!g.water[y * GW + nx] || !g.water[ny * GW + x])) continue;
        const kx = (KM_LNG[y] + KM_LNG[ny]) / 2;
        const step = dx && dy ? Math.hypot(kx, KM_LAT) : dx ? kx : KM_LAT;
        const nd = di + step;
        if (nd < s.dist[j]) {
          s.dist[j] = nd;
          s.prev[j] = i;
          heap.push(nd + h(j), j);
        }
      }
    }
  }
  return { reached: -1, s };
}

// The cells from a source to `end`, in order.
export function cellsTo(s: Search, end: number): number[] {
  const out: number[] = [];
  for (let c = end; c >= 0; c = s.prev[c]) out.push(c);
  return out.reverse();
}

// Waterways a path passes through (their names).
export function via(g: SeaGrid, cells: number[]): string[] {
  const seen: string[] = [];
  for (const c of cells) {
    const t = g.tag[c];
    if (t && !seen.includes(g.waterways[t - 1])) seen.push(g.waterways[t - 1]);
  }
  return seen;
}

// A drawable line for a path: cell centres, straightened wherever the sea
// in between is open (never across land or a closed waterway), continuous
// across the date line, and starting and ending on the coast.
export function polyline(g: SeaGrid, cells: number[], blocked: Set<number> = new Set()): [number, number][] {
  if (!cells.length) return [];
  const pts: [number, number][] = [];
  let shift = 0;
  let prev = -1;
  for (const i of cells) {
    const x = i % GW;
    if (prev >= 0 && Math.abs(x - prev) > GW / 2) shift += x < prev ? GW : -GW;
    prev = x;
    pts.push([x + shift + 0.5, ((i / GW) | 0) + 0.5]);
  }
  const ok = (c: number) => {
    if (!g.water[c]) return false;
    const t = g.tag[c];
    return !(t && blocked.has(t));
  };
  const clear = (p: [number, number], q: [number, number]) => {
    const n = Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]) * 3);
    for (let k = 1; k < n; k++) {
      const x = Math.floor(p[0] + ((q[0] - p[0]) * k) / n);
      const y = Math.floor(p[1] + ((q[1] - p[1]) * k) / n);
      if (!ok(y * GW + (((x % GW) + GW) % GW))) return false;
    }
    return true;
  };
  const keep: [number, number][] = [pts[0]];
  let i = 0;
  while (i < pts.length - 1) {
    let j = Math.min(pts.length - 1, i + 400);
    while (j > i + 1 && !clear(pts[i], pts[j])) j--;
    keep.push(pts[j]);
    i = j;
  }
  const line: [number, number][] = keep.map(([x, y]) => [x * CELL - 180, 90 - y * CELL]);
  // Out to the coastline: halfway to the land next to the first and last cells.
  const shore = (c: number, near: [number, number]): [number, number] | null => {
    const x = c % GW;
    const y = (c / GW) | 0;
    let best: [number, number] | null = null;
    let bd = Infinity;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const ny = y + dy;
        if (ny < 0 || ny >= GH || (!dx && !dy)) continue;
        const j = ny * GW + ((x + dx + GW) % GW);
        if (g.water[j]) continue;
        const d = dx * dx + dy * dy;
        if (d < bd) {
          bd = d;
          best = [near[0] + (dx * CELL) / 2, near[1] - (dy * CELL) / 2];
        }
      }
    }
    return best;
  };
  const a = shore(cells[0], line[0]);
  const b = shore(cells[cells.length - 1], line[line.length - 1]);
  if (a) line.unshift(a);
  if (b) line.push(b);
  return line;
}

// Total length of a line in km.
export function lineKm(line: [number, number][]) {
  let s = 0;
  for (let i = 1; i < line.length; i++) s += km(line[i - 1], line[i]);
  return s;
}
