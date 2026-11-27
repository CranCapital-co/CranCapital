// Fleets on the world map: where a country's warships lie at anchor (just
// off its coast), the sea lane a fleet sails, and the little warship model
// drawn for them.
import { mesh } from 'topojson-client';
import { worldShapes, worldTopology } from './api';

const anchors = new Map<string, [number, number] | null>();

// ---------------------------------------------------------------------------
// Sea lanes. Ships sail around the land on a half-degree grid of water cells:
// the country shapes are drawn once on a small canvas, cells mostly covered
// by land are land, and the straits and canals that a map this coarse
// closes are cut open again. The ice near the poles is closed.
// ---------------------------------------------------------------------------
const CELL = 0.5;
const GW = 360 / CELL;
const GH = 180 / CELL;
const CHANNELS: [number, number][][] = [
  [[-6.6, 35.9], [-5.6, 35.95], [-4.4, 36.2]], // Gibraltar
  [[25.6, 39.9], [26.4, 40.2], [27.5, 40.7], [29.0, 41.0], [29.2, 41.4]], // Dardanelles, Marmara, Bosphorus
  [[8.5, 57.9], [10.6, 57.8], [11.6, 57.0], [12.6, 56.1], [12.8, 55.4], [13.6, 55.0]], // Skagerrak, Kattegat, Øresund
  [[32.3, 31.4], [32.4, 30.6], [32.5, 29.9], [32.7, 29.5], [33.6, 28.0], [34.3, 27.5]], // Suez Canal, Gulf of Suez
  [[42.6, 13.6], [43.4, 12.6], [44.2, 12.1]], // Bab-el-Mandeb
  [[55.6, 25.9], [56.4, 26.5], [57.2, 25.6]], // Hormuz
  [[-79.9, 9.7], [-79.7, 9.2], [-79.5, 8.7]], // Panama Canal
  [[36.4, 45.6], [36.6, 45.0]], // Kerch
  [[-5.6, 49.8], [1.4, 50.9], [2.6, 51.4]], // English Channel
  [[98.0, 6.0], [100.6, 3.0], [103.4, 1.2], [104.6, 1.3]], // Malacca, Singapore
];
let water: Uint8Array | null = null;
const cellX = (lng: number) => ((Math.floor((lng + 180) / CELL) % GW) + GW) % GW;
const cellY = (lat: number) => Math.max(0, Math.min(GH - 1, Math.floor((90 - lat) / CELL)));

function waterGrid(): Uint8Array | null {
  if (water) return water;
  const shapes = worldShapes();
  if (!shapes || typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = GW;
  c.height = GH;
  const g = c.getContext('2d', { willReadFrequently: true });
  if (!g) return null;
  g.fillStyle = '#000';
  const ring = (r: number[][]) => {
    r.forEach(([x, y], i) => (i ? g.lineTo((x + 180) / CELL, (90 - y) / CELL) : g.moveTo((x + 180) / CELL, (90 - y) / CELL)));
    g.closePath();
  };
  for (const f of shapes.features) {
    const geo = f.geometry as GeoJSON.Polygon | GeoJSON.MultiPolygon | null;
    if (!geo) continue;
    const polys = geo.type === 'Polygon' ? [geo.coordinates] : geo.type === 'MultiPolygon' ? geo.coordinates : [];
    for (const p of polys) {
      g.beginPath();
      p.forEach((r) => ring(r as number[][]));
      g.fill('evenodd');
    }
  }
  const px = g.getImageData(0, 0, GW, GH).data;
  const w = new Uint8Array(GW * GH);
  for (let i = 0; i < w.length; i++) w[i] = px[i * 4 + 3] < 140 ? 1 : 0;
  // Polar ice.
  for (let y = 0; y < GH; y++) {
    const lat = 90 - (y + 0.5) * CELL;
    if (lat > 79 || lat < -67) for (let x = 0; x < GW; x++) w[y * GW + x] = 0;
  }
  for (const line of CHANNELS) {
    for (let i = 1; i < line.length; i++) {
      const [x0, y0] = line[i - 1];
      const [x1, y1] = line[i];
      const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 0.1);
      for (let k = 0; k <= n; k++) w[cellY(y0 + ((y1 - y0) * k) / n) * GW + cellX(x0 + ((x1 - x0) * k) / n)] = 1;
    }
  }
  water = w;
  return w;
}

// The nearest water cell to a point (searching outwards), or -1.
function nearestWater(w: Uint8Array, lng: number, lat: number) {
  const cx = cellX(lng);
  const cy = cellY(lat);
  for (let r = 0; r <= 12; r++) {
    let best = -1;
    let bd = Infinity;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const y = cy + dy;
        if (y < 0 || y >= GH) continue;
        const i = y * GW + (((cx + dx) % GW) + GW) % GW;
        const d = dx * dx + dy * dy;
        if (w[i] && d < bd) {
          bd = d;
          best = i;
        }
      }
    }
    if (best >= 0) return best;
  }
  return -1;
}

const COS = Float32Array.from({ length: GH }, (_, y) => Math.max(0.05, Math.cos(((90 - (y + 0.5) * CELL) * Math.PI) / 180)));
let gScore: Float32Array | null = null;
let cameFrom: Int32Array | null = null;
let shut: Uint8Array | null = null;

// A* over the water cells (8 directions, wrapping at the date line).
function search(w: Uint8Array, s: number, t: number): number[] | null {
  const N = GW * GH;
  gScore ??= new Float32Array(N);
  cameFrom ??= new Int32Array(N);
  shut ??= new Uint8Array(N);
  gScore.fill(Infinity);
  cameFrom.fill(-1);
  shut.fill(0);
  const tx = t % GW;
  const ty = (t / GW) | 0;
  const h = (i: number) => {
    const x = i % GW;
    const y = (i / GW) | 0;
    let dx = Math.abs(x - tx);
    if (dx > GW / 2) dx = GW - dx;
    return Math.hypot(dx * (COS[y] + COS[ty]) * 0.5, y - ty);
  };
  // A binary heap of [f, cell].
  const hf: number[] = [];
  const hi: number[] = [];
  const push = (f: number, i: number) => {
    let k = hf.length;
    hf.push(f);
    hi.push(i);
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (hf[p] <= f) break;
      hf[k] = hf[p];
      hi[k] = hi[p];
      k = p;
    }
    hf[k] = f;
    hi[k] = i;
  };
  const pop = () => {
    const top = hi[0];
    const lf = hf.pop()!;
    const li = hi.pop()!;
    if (hf.length) {
      let k = 0;
      for (;;) {
        let c = 2 * k + 1;
        if (c >= hf.length) break;
        if (c + 1 < hf.length && hf[c + 1] < hf[c]) c++;
        if (hf[c] >= lf) break;
        hf[k] = hf[c];
        hi[k] = hi[c];
        k = c;
      }
      hf[k] = lf;
      hi[k] = li;
    }
    return top;
  };
  gScore[s] = 0;
  push(h(s), s);
  let budget = 300_000;
  while (hf.length && budget-- > 0) {
    const i = pop();
    if (i === t) {
      const out = [t];
      for (let c = cameFrom[t]; c >= 0; c = cameFrom[c]) out.push(c);
      return out.reverse();
    }
    if (shut[i]) continue;
    shut[i] = 1;
    const x = i % GW;
    const y = (i / GW) | 0;
    for (let dy = -1; dy <= 1; dy++) {
      const ny = y + dy;
      if (ny < 0 || ny >= GH) continue;
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const j = ny * GW + (x + dx + GW) % GW;
        if (!w[j] || shut[j]) continue;
        // No cutting corners across land.
        if (dx && dy && (!w[y * GW + (x + dx + GW) % GW] || !w[ny * GW + x])) continue;
        const step = Math.hypot(dx * (COS[y] + COS[ny]) * 0.5, dy);
        const gs = gScore[i] + step;
        if (gs < gScore[j]) {
          gScore[j] = gs;
          cameFrom[j] = i;
          push(gs + h(j) * 1.15, j);
        }
      }
    }
  }
  return null;
}

const lanes = new Map<string, [number, number][] | null>();

// A ship's route between two points at sea, or null when there's no way
// round (an inland sea) or the map isn't ready.
export function seaRoute(a: [number, number], b: [number, number]): [number, number][] | null {
  const key = `${a[0].toFixed(2)},${a[1].toFixed(2)}>${b[0].toFixed(2)},${b[1].toFixed(2)}`;
  if (lanes.has(key)) return lanes.get(key)!;
  const w = waterGrid();
  if (!w) return null;
  const s = nearestWater(w, a[0], a[1]);
  const t = nearestWater(w, b[0], b[1]);
  const cells = s >= 0 && t >= 0 ? search(w, s, t) : null;
  let out: [number, number][] | null = null;
  if (cells) {
    // Cell centres, unwrapped across the date line so the line is continuous.
    const pts: [number, number][] = [];
    let shift = 0;
    let prev = -1;
    for (const i of cells) {
      const x = i % GW;
      if (prev >= 0 && Math.abs(x - prev) > GW / 2) shift += x < prev ? GW : -GW;
      prev = x;
      pts.push([x + shift + 0.5, ((i / GW) | 0) + 0.5]);
    }
    // Straighten: from each point, jump to the furthest one in clear sight.
    const clear = (p: [number, number], q: [number, number]) => {
      const n = Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]) * 3);
      for (let k = 1; k < n; k++) {
        const x = Math.floor(p[0] + ((q[0] - p[0]) * k) / n);
        const y = Math.floor(p[1] + ((q[1] - p[1]) * k) / n);
        if (!w[y * GW + ((x % GW) + GW) % GW]) return false;
      }
      return true;
    };
    const keep: [number, number][] = [pts[0]];
    let i = 0;
    while (i < pts.length - 1) {
      let j = pts.length - 1;
      while (j > i + 1 && !clear(pts[i], pts[j])) j--;
      keep.push(pts[j]);
      i = j;
    }
    out = keep.map(([x, y]) => [x * CELL - 180, 90 - y * CELL]);
    // From the exact start to the exact end, on the same side of the date line.
    const fix = (p: [number, number], near: [number, number]): [number, number] => {
      let x = p[0];
      while (x - near[0] > 180) x -= 360;
      while (near[0] - x > 180) x += 360;
      return [x, p[1]];
    };
    out.unshift(fix(a, out[0]));
    out.push(fix(b, out[out.length - 1]));
  }
  lanes.set(key, out);
  return out;
}

// Whether a point is at sea (on the coarse grid); true until the map is ready.
function atSea(p: [number, number]) {
  const w = waterGrid();
  return !w || !!w[cellY(p[1]) * GW + cellX(p[0])];
}

// Off the stretch of coast nearest the country's centre. Coast is the edges
// of its shape that no other country shares.
export function anchorOf(id: string, lat: number, lng: number): [number, number] {
  const hit = anchors.get(id);
  if (hit !== undefined) return hit ?? [lng, lat];
  const topo = worldTopology();
  if (!topo) return [lng, lat];
  const geoms: any[] = topo.objects.countries.geometries;
  const g = geoms.find((x) => String(x.id) === id);
  let best: [number, number] | null = null;
  if (g) {
    const coast = mesh(topo, topo.objects.countries, (a: any, b: any) => a === b && a === g) as GeoJSON.MultiLineString;
    const k = Math.cos((lat * Math.PI) / 180);
    let bd = Infinity;
    for (const line of coast.coordinates) {
      for (const [x, y] of line) {
        const d = ((x - lng) * k) ** 2 + (y - lat) ** 2;
        if (d < bd) {
          bd = d;
          best = [x, y];
        }
      }
    }
    if (best) {
      // A little out to sea, away from the centre.
      const dx = (best[0] - lng) * k;
      const dy = best[1] - lat;
      const len = Math.hypot(dx, dy) || 1;
      best = [best[0] + ((dx / len) * 0.7) / Math.max(0.2, k), best[1] + (dy / len) * 0.7];
      // Make sure it's water (a bay or a neighbour's coast can be in the way).
      const w = waterGrid();
      if (w && !atSea(best)) {
        const i = nearestWater(w, best[0], best[1]);
        if (i >= 0) best = [(i % GW) * CELL - 180 + CELL / 2, 90 - (((i / GW) | 0) + 0.5) * CELL];
      }
    }
  }
  anchors.set(id, best);
  return best ?? [lng, lat];
}

// A sea lane between two points: a gentle curve (good enough on a flat map),
// crossing the date line the short way.
export function seaPath(a: [number, number], b: [number, number], bend = 0.18): [number, number][] {
  let bl = b[0];
  if (bl - a[0] > 180) bl -= 360;
  if (a[0] - bl > 180) bl += 360;
  const mx = (a[0] + bl) / 2;
  const my = (a[1] + b[1]) / 2;
  const dx = bl - a[0];
  const dy = b[1] - a[1];
  const cx = mx - dy * bend;
  const cy = my + dx * bend;
  const pts: [number, number][] = [];
  for (let i = 0; i <= 24; i++) {
    const t = i / 24;
    pts.push([(1 - t) * (1 - t) * a[0] + 2 * (1 - t) * t * cx + t * t * bl, (1 - t) * (1 - t) * a[1] + 2 * (1 - t) * t * cy + t * t * b[1]]);
  }
  return pts;
}

// A ship's lane: around the land when we can work it out, else a curve.
export function lane(a: [number, number], b: [number, number], bend = 0.12) {
  return seaRoute(a, b) ?? seaPath(a, b, bend);
}

// The point a fraction k of the way along a path (by distance), and the
// heading there (degrees).
const lengths = new WeakMap<[number, number][], number[]>();
export function along(path: [number, number][], k: number): [number, number, number] {
  let cum = lengths.get(path);
  if (!cum) {
    cum = [0];
    for (let i = 1; i < path.length; i++) {
      const c = Math.cos((((path[i][1] + path[i - 1][1]) / 2) * Math.PI) / 180);
      cum.push(cum[i - 1] + Math.hypot((path[i][0] - path[i - 1][0]) * c, path[i][1] - path[i - 1][1]));
    }
    lengths.set(path, cum);
  }
  const total = cum[cum.length - 1] || 1;
  const d = Math.max(0, Math.min(1, k)) * total;
  let i = 1;
  while (i < cum.length - 1 && cum[i] < d) i++;
  const seg = cum[i] - cum[i - 1] || 1;
  const t = Math.max(0, Math.min(1, (d - cum[i - 1]) / seg));
  const [x0, y0] = path[i - 1];
  const [x1, y1] = path[i];
  const hdg = (Math.atan2((x1 - x0) * Math.cos((y0 * Math.PI) / 180), y1 - y0) * 180) / Math.PI;
  return [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, hdg];
}

export const FLEET_COLORS = { mine: '#f5c451', ally: '#6fb5ff', enemy: '#e0533f' } as const;

// A warship seen from above, bow up, lit from the top left: a shaded hull,
// deck, two gun turrets, the bridge, a radar mast and a funnel in the
// fleet's colour. Sailing ships trail a wake.
export function drawWarship(color: string, wake: boolean) {
  const W = 48;
  const H = 140;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  const cx = W / 2;
  if (wake) {
    const grad = g.createLinearGradient(0, 96, 0, H);
    grad.addColorStop(0, 'rgba(255,255,255,0.85)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(cx - 7, 98);
    g.quadraticCurveTo(cx - 14, 120, cx - 22, H);
    g.lineTo(cx - 12, H);
    g.quadraticCurveTo(cx - 4, 118, cx, 104);
    g.quadraticCurveTo(cx + 4, 118, cx + 12, H);
    g.lineTo(cx + 22, H);
    g.quadraticCurveTo(cx + 14, 120, cx + 7, 98);
    g.closePath();
    g.fill();
  }
  const hull = () => {
    g.beginPath();
    g.moveTo(cx, 4);
    g.bezierCurveTo(cx + 9, 18, cx + 11, 34, cx + 11, 48);
    g.lineTo(cx + 10, 92);
    g.quadraticCurveTo(cx + 9, 100, cx + 6, 101);
    g.lineTo(cx - 6, 101);
    g.quadraticCurveTo(cx - 9, 100, cx - 10, 92);
    g.lineTo(cx - 11, 48);
    g.bezierCurveTo(cx - 11, 34, cx - 9, 18, cx, 4);
    g.closePath();
  };
  // Shadow on the water, then the hull with side lighting.
  g.save();
  g.shadowColor = 'rgba(0,0,0,0.55)';
  g.shadowBlur = 5;
  g.shadowOffsetX = 3;
  g.shadowOffsetY = 4;
  hull();
  const side = g.createLinearGradient(cx - 11, 0, cx + 11, 0);
  side.addColorStop(0, '#c9d2da');
  side.addColorStop(0.55, '#97a4b0');
  side.addColorStop(1, '#5f6c78');
  g.fillStyle = side;
  g.fill();
  g.restore();
  g.lineWidth = 1.6;
  g.strokeStyle = '#17222b';
  hull();
  g.stroke();
  // Deck.
  g.save();
  hull();
  g.clip();
  g.fillStyle = 'rgba(40,52,62,0.18)';
  g.fillRect(cx - 7, 12, 14, 84);
  g.strokeStyle = 'rgba(30,40,50,0.35)';
  g.lineWidth = 0.8;
  for (let y = 20; y < 98; y += 6) {
    g.beginPath();
    g.moveTo(cx - 8, y);
    g.lineTo(cx + 8, y);
    g.stroke();
  }
  g.restore();
  const turret = (y: number, dir: 1 | -1) => {
    g.strokeStyle = '#1c262e';
    g.lineWidth = 2.4;
    g.beginPath();
    g.moveTo(cx - 1.6, y);
    g.lineTo(cx - 1.6, y - dir * 13);
    g.moveTo(cx + 1.6, y);
    g.lineTo(cx + 1.6, y - dir * 13);
    g.stroke();
    const tg = g.createRadialGradient(cx - 2, y - 2, 1, cx, y, 6);
    tg.addColorStop(0, '#d7dee4');
    tg.addColorStop(1, '#6b7782');
    g.fillStyle = tg;
    g.beginPath();
    g.arc(cx, y, 5.5, 0, Math.PI * 2);
    g.fill();
    g.lineWidth = 1.2;
    g.stroke();
  };
  turret(30, 1);
  turret(84, -1);
  // Bridge, with its shadow to give it height.
  g.fillStyle = 'rgba(0,0,0,0.35)';
  g.beginPath();
  g.roundRect(cx - 6, 42, 15, 22, 3);
  g.fill();
  const br = g.createLinearGradient(cx - 7, 40, cx + 7, 60);
  br.addColorStop(0, '#f2f5f7');
  br.addColorStop(1, '#a9b5bf');
  g.fillStyle = br;
  g.strokeStyle = '#1c262e';
  g.lineWidth = 1.2;
  g.beginPath();
  g.roundRect(cx - 8, 40, 15, 21, 3);
  g.fill();
  g.stroke();
  g.fillStyle = '#26333d';
  g.fillRect(cx - 6, 42, 11, 3);
  // Radar mast.
  g.strokeStyle = '#1c262e';
  g.lineWidth = 1.4;
  g.beginPath();
  g.moveTo(cx - 6, 52);
  g.lineTo(cx + 5, 52);
  g.stroke();
  g.fillStyle = '#e9eef2';
  g.beginPath();
  g.arc(cx - 0.5, 52, 2.4, 0, Math.PI * 2);
  g.fill();
  g.stroke();
  // Funnel in the fleet's colour.
  g.fillStyle = '#2b353e';
  g.beginPath();
  g.ellipse(cx, 69, 4.5, 6, 0, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = color;
  g.fillRect(cx - 4.5, 66, 9, 3.5);
  g.fillStyle = '#0e151b';
  g.beginPath();
  g.ellipse(cx, 70.5, 2.2, 3, 0, 0, Math.PI * 2);
  g.fill();
  // A stripe of colour at the bow, to tell sides apart at a glance.
  g.fillStyle = color;
  g.beginPath();
  g.moveTo(cx, 6);
  g.bezierCurveTo(cx + 4, 11, cx + 6, 15, cx + 6.5, 18);
  g.lineTo(cx - 6.5, 18);
  g.bezierCurveTo(cx - 6, 15, cx - 4, 11, cx, 6);
  g.fill();
  return { width: W, height: H, data: new Uint8Array(g.getImageData(0, 0, W, H).data.buffer) };
}
