// Splitting merged blocks into building lots.
//
// OpenFreeMap's tiles merge buildings that touch into one feature, so in a
// dense city a whole block (often a ring of buildings around a courtyard)
// arrives as a single "building". Tapping it selected the whole block. Here
// each such block is cut into lots about the size of one building:
//   * seed points every FRONTAGE metres along the block's outline, a few
//     metres in from the street (plus a sparse grid for deep interiors);
//   * the block is drawn on a 1 m grid and every cell joins its nearest
//     seed, so lots run from the street towards the courtyard, like real
//     buildings in a block;
//   * each lot's cells are traced back into outlines and simplified.
// Coordinates are metres in the city frame (x east, y north).

const FRONTAGE = 20; // metres of street front per lot
const INSET = 6; // seeds sit this far in from the outline
const INTERIOR = 45; // grid for seeds deep inside big blocks
const MIN_LOT = 60; // m²: smaller scraps join a neighbour

const area = (r) => {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] - r[i][0]) * (r[j][1] + r[i][1]);
  return a / 2;
};

// Douglas-Peucker on a closed ring.
function simplifyRing(ring, tol) {
  if (ring.length <= 4) return ring;
  // Start from the two points furthest apart so the ring keeps its extent.
  let a = 0;
  let b = 0;
  let best = -1;
  for (let i = 0; i < ring.length; i++) {
    const d = (ring[i][0] - ring[0][0]) ** 2 + (ring[i][1] - ring[0][1]) ** 2;
    if (d > best) {
      best = d;
      b = i;
    }
  }
  const keep = new Uint8Array(ring.length);
  keep[a] = 1;
  keep[b] = 1;
  const stack = [[a, b], [b, ring.length]];
  const pt = (i) => ring[i % ring.length];
  while (stack.length) {
    const [s, e] = stack.pop();
    if (e - s < 2) continue;
    const [x1, y1] = pt(s);
    const [x2, y2] = pt(e);
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    let md = -1;
    let mi = -1;
    for (let i = s + 1; i < e; i++) {
      const [x, y] = pt(i);
      const d = Math.abs(dy * x - dx * y + x2 * y1 - y2 * x1) / len;
      if (d > md) {
        md = d;
        mi = i;
      }
    }
    if (md > tol) {
      keep[mi % ring.length] = 1;
      stack.push([s, mi], [mi, e]);
    }
  }
  const out = ring.filter((_, i) => keep[i]);
  return out.length >= 3 ? out : ring;
}

// Trace the outlines of every label region on a grid (lab: Int32Array, -1
// outside). Returns Map label -> rings of grid vertices; outer rings are
// anticlockwise, holes clockwise.
function traceLabels(lab, w, h) {
  const at = (i, j) => (i < 0 || j < 0 || i >= w || j >= h ? -1 : lab[j * w + i]);
  // Directed edges keyed by start vertex, per label.
  const edges = new Map(); // label -> Map(vkey -> [[ex, ey], ...])
  const W = w + 1;
  const add = (L, sx, sy, ex, ey) => {
    let m = edges.get(L);
    if (!m) edges.set(L, (m = new Map()));
    const k = sy * W + sx;
    const list = m.get(k);
    if (list) list.push([ex, ey]);
    else m.set(k, [[ex, ey]]);
  };
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const L = lab[j * w + i];
      if (L < 0) continue;
      if (at(i, j - 1) !== L) add(L, i, j, i + 1, j); // bottom
      if (at(i + 1, j) !== L) add(L, i + 1, j, i + 1, j + 1); // right
      if (at(i, j + 1) !== L) add(L, i + 1, j + 1, i, j + 1); // top
      if (at(i - 1, j) !== L) add(L, i, j + 1, i, j); // left
    }
  }
  const out = new Map();
  for (const [L, m] of edges) {
    const rings = [];
    for (const [k0, list0] of m) {
      while (list0.length) {
        let sx = k0 % W;
        let sy = Math.floor(k0 / W);
        const ring = [[sx, sy]];
        let [ex, ey] = list0.pop();
        let dx = ex - sx;
        let dy = ey - sy;
        let guard = 0;
        while (!(ex === ring[0][0] && ey === ring[0][1]) && guard++ < 1e6) {
          ring.push([ex, ey]);
          const k = ey * W + ex;
          const list = m.get(k);
          if (!list || !list.length) break;
          // Prefer turning left, then straight, then right (keeps regions
          // that touch only at a corner apart).
          let pick = 0;
          let bestScore = -Infinity;
          for (let n = 0; n < list.length; n++) {
            const nx = list[n][0] - ex;
            const ny = list[n][1] - ey;
            const cross = dx * ny - dy * nx;
            const dot = dx * nx + dy * ny;
            const score = cross > 0 ? 2 : dot > 0 ? 1 : 0;
            if (score > bestScore) {
              bestScore = score;
              pick = n;
            }
          }
          const [nx, ny] = list.splice(pick, 1)[0];
          dx = nx - ex;
          dy = ny - ey;
          ex = nx;
          ey = ny;
        }
        // Drop collinear points.
        const clean = [];
        for (let n = 0; n < ring.length; n++) {
          const p = ring[(n - 1 + ring.length) % ring.length];
          const c = ring[n];
          const q = ring[(n + 1) % ring.length];
          if ((c[0] - p[0]) * (q[1] - c[1]) - (c[1] - p[1]) * (q[0] - c[0]) !== 0) clean.push(c);
        }
        if (clean.length >= 3) rings.push(clean);
      }
    }
    out.set(L, rings);
  }
  return out;
}

// Split one block (rings in metres) into lots. Returns [] when it is too
// small to be worth splitting.
export function splitBlock(rings) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rings) for (const [x, y] of r) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  const blockArea = Math.abs(rings.reduce((s, r) => s + area(r), 0));
  const c = blockArea > 150000 ? 2 : 1; // cell size, metres
  const w = Math.ceil((maxX - minX) / c) + 1;
  const h = Math.ceil((maxY - minY) / c) + 1;
  // Inside mask (even-odd, by cell centres).
  const inside = new Uint8Array(w * h);
  for (let j = 0; j < h; j++) {
    const yc = minY + (j + 0.5) * c;
    const xs = [];
    for (const r of rings) {
      for (let i = 0, k = r.length - 1; i < r.length; k = i++) {
        const [xi, yi] = r[i];
        const [xk, yk] = r[k];
        if (yi > yc !== yk > yc) xs.push(xi + ((yc - yi) * (xk - xi)) / (yk - yi));
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil((xs[k] - minX) / c - 0.5));
      const i1 = Math.min(w - 1, Math.floor((xs[k + 1] - minX) / c - 0.5));
      for (let i = i0; i <= i1; i++) inside[j * w + i] = 1;
    }
  }
  const isIn = (x, y) => {
    const i = Math.floor((x - minX) / c);
    const j = Math.floor((y - minY) / c);
    return i >= 0 && j >= 0 && i < w && j < h && inside[j * w + i] === 1;
  };

  // Seeds along the frontage, a few metres in from every outline ring (the
  // side of the edge that is inside the block).
  const makeSeeds = (frontage) => {
    const seeds = [];
    for (const r of rings) {
      let carry = frontage / 2;
      for (let i = 0; i < r.length; i++) {
        const [x1, y1] = r[i];
        const [x2, y2] = r[(i + 1) % r.length];
        const len = Math.hypot(x2 - x1, y2 - y1);
        if (len < 1e-6) continue;
        const ux = (x2 - x1) / len;
        const uy = (y2 - y1) / len;
        let t = carry;
        while (t < len) {
          const px = x1 + ux * t;
          const py = y1 + uy * t;
          for (const s of [1, -1]) {
            const sx = px - uy * INSET * s;
            const sy = py + ux * INSET * s;
            if (isIn(sx, sy)) {
              if (!seeds.some(([qx, qy]) => (qx - sx) ** 2 + (qy - sy) ** 2 < (frontage * 0.55) ** 2)) seeds.push([sx, sy]);
              break;
            }
          }
          t += frontage;
        }
        carry = t - len;
      }
    }
    // Deep interiors (big blocks): a sparse grid of extra seeds, spaced in
    // step with the frontage.
    const grid = INTERIOR * (frontage / FRONTAGE);
    for (let y = minY + grid / 2; y < maxY; y += grid) {
      for (let x = minX + grid / 2; x < maxX; x += grid) {
        if (!isIn(x, y)) continue;
        if (seeds.every(([qx, qy]) => (qx - x) ** 2 + (qy - y) ** 2 > (grid * 0.7) ** 2)) seeds.push([x, y]);
      }
    }
    return seeds;
  };
  // At most 900 lots a block: bigger lots in giant blocks.
  let frontage = Math.max(FRONTAGE, Math.sqrt(blockArea / 900) * 0.9);
  let seeds = makeSeeds(frontage);
  for (let tries = 0; seeds.length > 900 && tries < 12; tries++) {
    frontage *= 1.3;
    seeds = makeSeeds(frontage);
  }
  if (seeds.length < 2) return [];

  // Every inside cell joins its nearest seed (seeds bucketed on a grid).
  const B = 40;
  const buckets = new Map();
  seeds.forEach(([x, y], n) => {
    const k = `${Math.floor(x / B)},${Math.floor(y / B)}`;
    (buckets.get(k) ?? buckets.set(k, []).get(k)).push(n);
  });
  const lab = new Int32Array(w * h).fill(-1);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      if (!inside[j * w + i]) continue;
      const x = minX + (i + 0.5) * c;
      const y = minY + (j + 0.5) * c;
      const bx = Math.floor(x / B);
      const by = Math.floor(y / B);
      let best = -1;
      let bd = Infinity;
      for (let rad = 1; best < 0 || rad <= 2; rad++) {
        for (let gy = by - rad; gy <= by + rad; gy++) {
          for (let gx = bx - rad; gx <= bx + rad; gx++) {
            const list = buckets.get(`${gx},${gy}`);
            if (!list) continue;
            for (const n of list) {
              const d = (seeds[n][0] - x) ** 2 + (seeds[n][1] - y) ** 2;
              if (d < bd) {
                bd = d;
                best = n;
              }
            }
          }
        }
        if (rad > 50) break;
      }
      lab[j * w + i] = best;
    }
  }

  // Scraps (a seed cut off by a courtyard corner, slivers) join the
  // neighbour they touch most.
  const minCells = Math.ceil(MIN_LOT / (c * c));
  for (let pass = 0; pass < 3; pass++) {
    const count = new Map();
    for (const L of lab) if (L >= 0) count.set(L, (count.get(L) || 0) + 1);
    const small = new Set([...count].filter(([, n]) => n < minCells).map(([L]) => L));
    if (!small.size || small.size === count.size) break;
    const touch = new Map();
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const L = lab[j * w + i];
        if (!small.has(L)) continue;
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const ii = i + di;
          const jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= w || jj >= h) continue;
          const M = lab[jj * w + ii];
          if (M < 0 || M === L || small.has(M)) continue;
          let t = touch.get(L);
          if (!t) touch.set(L, (t = new Map()));
          t.set(M, (t.get(M) || 0) + 1);
        }
      }
    }
    const into = new Map();
    for (const [L, t] of touch) into.set(L, [...t].sort((a, b) => b[1] - a[1])[0][0]);
    if (!into.size) break;
    for (let n = 0; n < lab.length; n++) if (into.has(lab[n])) lab[n] = into.get(lab[n]);
  }

  // Each lot in one piece: a fragment cut off from the rest of its lot (by
  // a courtyard or a wall) joins the neighbour it touches most.
  for (let pass = 0; pass < 4; pass++) {
    const comp = new Int32Array(w * h).fill(-1);
    const sizes = [];
    const labels = [];
    for (let start = 0; start < lab.length; start++) {
      if (lab[start] < 0 || comp[start] >= 0) continue;
      const id = sizes.length;
      const L = lab[start];
      let n = 0;
      const stack = [start];
      comp[start] = id;
      while (stack.length) {
        const c = stack.pop();
        n++;
        const i = c % w;
        const j = (c / w) | 0;
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const ii = i + di;
          const jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= w || jj >= h) continue;
          const d = jj * w + ii;
          if (comp[d] < 0 && lab[d] === L) {
            comp[d] = id;
            stack.push(d);
          }
        }
      }
      sizes.push(n);
      labels.push(L);
    }
    const biggest = new Map();
    sizes.forEach((n, id) => {
      const b = biggest.get(labels[id]);
      if (b === undefined || n > sizes[b]) biggest.set(labels[id], id);
    });
    const touch = new Map();
    for (let c = 0; c < lab.length; c++) {
      const id = comp[c];
      if (id < 0 || biggest.get(labels[id]) === id) continue;
      const i = c % w;
      const j = (c / w) | 0;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ii = i + di;
        const jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= w || jj >= h) continue;
        const M = lab[jj * w + ii];
        if (M < 0 || M === labels[id]) continue;
        let t = touch.get(id);
        if (!t) touch.set(id, (t = new Map()));
        t.set(M, (t.get(M) || 0) + 1);
      }
    }
    if (!touch.size) break;
    const into = new Map();
    for (const [id, t] of touch) into.set(id, [...t].sort((x, y) => y[1] - x[1])[0][0]);
    for (let c = 0; c < lab.length; c++) if (comp[c] >= 0 && into.has(comp[c])) lab[c] = into.get(comp[c]);
  }

  // Outlines, back in metres, simplified (the 1 m staircase on diagonal
  // walls becomes a straight wall again).
  const traced = traceLabels(lab, w, h);
  const lots = [];
  for (const [L, gridRings] of traced) {
    let cells = 0;
    let sx = 0;
    let sy = 0;
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        if (lab[j * w + i] !== L) continue;
        cells++;
        sx += minX + (i + 0.5) * c;
        sy += minY + (j + 0.5) * c;
      }
    }
    if (!cells) continue;
    const ringsM = gridRings
      .map((r) => simplifyRing(r.map(([i, j]) => [minX + i * c, minY + j * c]), 0.9 * c))
      .filter((r) => r.length >= 3 && Math.abs(area(r)) > 1);
    if (!ringsM.length) continue;
    lots.push({ rings: ringsM, area: cells * c * c, cx: sx / cells, cy: sy / cells, seed: L });
  }
  // A stable order: by position along the block (west to east, then south
  // to north), so ids don't shuffle between runs.
  lots.sort((a, b) => a.cx - b.cx || a.cy - b.cy);
  return lots;
}
