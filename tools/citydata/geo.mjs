// Small geometry helpers for the city data pipeline. Everything works in a
// local metric frame per city: x metres east of the bbox's west edge, y metres
// north of its south edge (equirectangular, accurate to well under 1% across
// a few kilometres).

export const M_PER_DEG_LAT = 110574;

export function makeFrame(bbox) {
  const [west, south, east, north] = bbox;
  const latc = (south + north) / 2;
  const kx = 111320 * Math.cos((latc * Math.PI) / 180);
  const ky = M_PER_DEG_LAT;
  return {
    lng0: west,
    lat0: south,
    kx,
    ky,
    width: (east - west) * kx,
    height: (north - south) * ky,
    toXY(lng, lat) {
      return [(lng - west) * kx, (lat - south) * ky];
    },
    toLngLat(x, y) {
      return [west + x / kx, south + y / ky];
    },
  };
}

export function lngLatToTile(lng, lat, z) {
  const n = 2 ** z;
  const x = ((lng + 180) / 360) * n;
  const r = (lat * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n;
  return [x, y];
}

export function tilePointToLngLat(tx, ty, z, px, py, extent) {
  const n = 2 ** z;
  const lng = ((tx + px / extent) / n) * 360 - 180;
  const yy = Math.PI * (1 - (2 * (ty + py / extent)) / n);
  const lat = (Math.atan(Math.sinh(yy)) * 180) / Math.PI;
  return [lng, lat];
}

// Sutherland–Hodgman clip of one ring against the square [0,E]x[0,E].
export function clipRing(ring, E) {
  let pts = ring;
  const edges = [
    (p) => p.x >= 0,
    (p) => p.x <= E,
    (p) => p.y >= 0,
    (p) => p.y <= E,
  ];
  const inter = [
    (a, b) => ({ x: 0, y: a.y + ((b.y - a.y) * (0 - a.x)) / (b.x - a.x) }),
    (a, b) => ({ x: E, y: a.y + ((b.y - a.y) * (E - a.x)) / (b.x - a.x) }),
    (a, b) => ({ x: a.x + ((b.x - a.x) * (0 - a.y)) / (b.y - a.y), y: 0 }),
    (a, b) => ({ x: a.x + ((b.x - a.x) * (E - a.y)) / (b.y - a.y), y: E }),
  ];
  for (let e = 0; e < 4; e++) {
    if (pts.length === 0) break;
    const out = [];
    const inside = edges[e];
    for (let i = 0; i < pts.length; i++) {
      const cur = pts[i];
      const prev = pts[(i + pts.length - 1) % pts.length];
      const ci = inside(cur);
      const pi = inside(prev);
      if (ci) {
        if (!pi) out.push(inter[e](prev, cur));
        out.push(cur);
      } else if (pi) {
        out.push(inter[e](prev, cur));
      }
    }
    pts = out;
  }
  return pts;
}

// Liang–Barsky clip of a segment to [0,E]^2; returns null when outside.
export function clipSegment(a, b, E) {
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const p = [-dx, dx, -dy, dy];
  const q = [a.x, E - a.x, a.y, E - a.y];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return null;
    } else {
      const t = q[i] / p[i];
      if (p[i] < 0) {
        if (t > t1) return null;
        if (t > t0) t0 = t;
      } else {
        if (t < t0) return null;
        if (t < t1) t1 = t;
      }
    }
  }
  return [
    { x: a.x + t0 * dx, y: a.y + t0 * dy },
    { x: a.x + t1 * dx, y: a.y + t1 * dy },
  ];
}

export function signedArea(ring) {
  let s = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % n];
    s += x1 * y2 - x2 * y1;
  }
  return s / 2;
}

export function ringCentroid(ring) {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % n];
    const f = x1 * y2 - x2 * y1;
    a += f;
    cx += (x1 + x2) * f;
    cy += (y1 + y2) * f;
  }
  if (Math.abs(a) < 1e-9) {
    const m = ring.reduce((acc, p) => [acc[0] + p[0], acc[1] + p[1]], [0, 0]);
    return [m[0] / ring.length, m[1] / ring.length, 0];
  }
  return [cx / (3 * a), cy / (3 * a), a / 2];
}

// Even-odd point in polygon over a list of rings.
export function pointInRings(x, y, rings) {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

// A raster over the city frame with a given cell size in metres.
export class Raster {
  constructor(width, height, cell) {
    this.cell = cell;
    this.w = Math.ceil(width / cell);
    this.h = Math.ceil(height / cell);
    this.data = new Uint8Array(this.w * this.h);
  }
  idx(cx, cy) {
    return cy * this.w + cx;
  }
  get(cx, cy) {
    if (cx < 0 || cy < 0 || cx >= this.w || cy >= this.h) return 0;
    return this.data[cy * this.w + cx];
  }
  // Fill polygon rings (even-odd) with value v, by cell centres.
  fillRings(rings, v) {
    let minY = Infinity;
    let maxY = -Infinity;
    for (const r of rings) for (const p of r) {
      if (p[1] < minY) minY = p[1];
      if (p[1] > maxY) maxY = p[1];
    }
    const c = this.cell;
    const y0 = Math.max(0, Math.floor(minY / c));
    const y1 = Math.min(this.h - 1, Math.ceil(maxY / c));
    for (let cy = y0; cy <= y1; cy++) {
      const yc = (cy + 0.5) * c;
      const xs = [];
      for (const r of rings) {
        for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
          const [xi, yi] = r[i];
          const [xj, yj] = r[j];
          if (yi > yc !== yj > yc) xs.push(xi + ((yc - yi) * (xj - xi)) / (yj - yi));
        }
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const x0 = Math.max(0, Math.ceil(xs[k] / c - 0.5));
        const x1 = Math.min(this.w - 1, Math.floor(xs[k + 1] / c - 0.5));
        for (let cx = x0; cx <= x1; cx++) this.data[cy * this.w + cx] = v;
      }
    }
  }
  // Mark every cell whose centre lies within halfWidth of segment a-b.
  strokeSegment(a, b, halfWidth, v) {
    const c = this.cell;
    const minX = Math.max(0, Math.floor((Math.min(a[0], b[0]) - halfWidth) / c));
    const maxX = Math.min(this.w - 1, Math.floor((Math.max(a[0], b[0]) + halfWidth) / c));
    const minY = Math.max(0, Math.floor((Math.min(a[1], b[1]) - halfWidth) / c));
    const maxY = Math.min(this.h - 1, Math.floor((Math.max(a[1], b[1]) + halfWidth) / c));
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    const hw2 = halfWidth * halfWidth;
    for (let cy = minY; cy <= maxY; cy++) {
      const py = (cy + 0.5) * c;
      for (let cx = minX; cx <= maxX; cx++) {
        const px = (cx + 0.5) * c;
        let t = len2 > 0 ? ((px - a[0]) * dx + (py - a[1]) * dy) / len2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = a[0] + t * dx - px;
        const ey = a[1] + t * dy - py;
        if (ex * ex + ey * ey <= hw2) this.data[cy * this.w + cx] = v;
      }
    }
  }
}

// Pack a 0/1 Uint8Array into bits, LSB-first within each byte. This matches
// Postgres get_bit(bytea, n) = (byte[n >> 3] >> (n & 7)) & 1.
export function packBits(arr) {
  const out = new Uint8Array(Math.ceil(arr.length / 8));
  for (let i = 0; i < arr.length; i++) if (arr[i]) out[i >> 3] |= 1 << (i & 7);
  return out;
}
