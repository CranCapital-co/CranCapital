// Sea lanes on the map. The grid (public/world/sea.bin.gz, built by
// tools/world/sea.mjs) loads once; routes are worked out a few at a time
// between frames (each takes a few tens of milliseconds) and kept.
import { decodeGrid, coastCells, search, cellsTo, polyline, nearestSea, cellLng, cellLat, km, type SeaGrid } from './searoute';

type Line = [number, number][];
let gridP: Promise<SeaGrid | null> | null = null;
let grid: SeaGrid | null = null;
export const seaGrid = () => grid;

async function gunzip(b: Uint8Array): Promise<Uint8Array> {
  if (b[0] !== 0x1f || b[1] !== 0x8b) return b;
  if (typeof DecompressionStream !== 'undefined') {
    return new Uint8Array(await new Response(new Blob([b as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
  }
  const { gunzipSync } = await import('three/examples/jsm/libs/fflate.module.js');
  return gunzipSync(b);
}

export function loadSea(): Promise<SeaGrid | null> {
  if (!gridP) {
    gridP = fetch(`${import.meta.env.BASE_URL}world/sea.bin.gz`)
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`sea grid: HTTP ${r.status}`))))
      .then((b) => gunzip(new Uint8Array(b)))
      .then((b) => (grid = decodeGrid(b)))
      .catch(() => {
        gridP = null;
        return null;
      });
  }
  return gridP;
}

const lanes = new Map<string, Line | null>();
const queue: { key: string; run: () => Line | null }[] = [];
let pumping = false;
function pump() {
  if (pumping) return;
  pumping = true;
  const step = () => {
    const t0 = performance.now();
    while (queue.length && performance.now() - t0 < 14) {
      const j = queue.shift()!;
      if (!lanes.has(j.key)) {
        try {
          lanes.set(j.key, j.run());
        } catch {
          lanes.set(j.key, null);
        }
      }
    }
    if (queue.length) setTimeout(step, 40);
    else pumping = false;
  };
  setTimeout(step, 0);
}
function lane(key: string, run: () => Line | null): Line | null | undefined {
  if (!grid) {
    loadSea();
    return undefined;
  }
  if (lanes.has(key)) return lanes.get(key)!;
  if (!queue.some((q) => q.key === key)) queue.push({ key, run });
  pump();
  return undefined;
}
const blockedTags = (g: SeaGrid, avoid: string[]) => new Set(avoid.map((w) => g.waterways.indexOf(w) + 1).filter((t) => t > 0));

// Between two countries' coasts (fleets). undefined while being worked out,
// null if there's no way by sea.
export function countryLane(from: string, fromNear: [number, number], to: string, toNear: [number, number], avoid: string[] = []): Line | null | undefined {
  const key = `c:${from}>${to}|${[...avoid].sort().join(',')}`;
  return lane(key, () => {
    const g = grid!;
    const blocked = blockedTags(g, avoid);
    const a = coastCells(g, from, fromNear);
    const b = coastCells(g, to, toNear);
    if (!a.length || !b.length) return null;
    const { reached, s } = search(g, a, b, blocked);
    return reached < 0 ? null : polyline(g, cellsTo(s, reached), blocked);
  });
}

// The sea next to a port city: its country's coast nearest the city.
function portCell(g: SeaGrid, country: string | null, pt: [number, number]): number {
  if (country) {
    const cells = coastCells(g, country);
    let best = -1;
    let bd = Infinity;
    for (const c of cells) {
      const d = km(pt, [cellLng(c), cellLat(c)]);
      if (d < bd) {
        bd = d;
        best = c;
      }
    }
    if (best >= 0 && bd < 1500) return best;
  }
  return nearestSea(g, pt[0], pt[1]);
}

// Between two port cities (cargo ships).
export function portLane(fromPt: [number, number], fromT: string | null, toPt: [number, number], toT: string | null, avoid: string[] = []): Line | null | undefined {
  const key = `p:${fromPt.join(',')}>${toPt.join(',')}|${[...avoid].sort().join(',')}`;
  return lane(key, () => {
    const g = grid!;
    const blocked = blockedTags(g, avoid);
    const a = portCell(g, fromT, fromPt);
    const b = portCell(g, toT, toPt);
    if (a < 0 || b < 0) return null;
    const { reached, s } = search(g, [a], [b], blocked);
    return reached < 0 ? null : polyline(g, cellsTo(s, reached), blocked);
  });
}

// Where a country's fleets lie at anchor: its coast nearest its centre.
const docks = new Map<string, [number, number] | null>();
export function dockPoint(country: string, near: [number, number]): [number, number] | null {
  if (!grid) return null;
  const hit = docks.get(country);
  if (hit !== undefined) return hit;
  const cells = coastCells(grid, country, near);
  let best = -1;
  let bd = Infinity;
  for (const c of cells) {
    const d = km(near, [cellLng(c), cellLat(c)]);
    if (d < bd) {
      bd = d;
      best = c;
    }
  }
  const p: [number, number] | null = best >= 0 ? [cellLng(best), cellLat(best)] : null;
  docks.set(country, p);
  return p;
}
