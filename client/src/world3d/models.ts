// A 3D model for every business type, built from parts in code. Each one has
// its own silhouette, grows visibly from level 1 to 5, and shows when it's
// closed, abandoned or depleted. Models face +z (the street); room businesses
// are shopfront dressing whose origin sits on the building's front wall.
import * as THREE from 'three';
import { awning, box, cone, cyl, gable, group, rbox, ball, shade, torus } from './kit';
import { overrides } from './gltf';

export const TIER_COLORS: Record<number, string> = { 1: '#e3694d', 2: '#2f8f6e', 3: '#6c9a3d', 4: '#8a6b4a', 5: '#4b6a8c', 6: '#6b4b8c' };
const GOLD = '#e8b23a';
const WOOD = '#b07a42';
const WOOD_D = '#8a5a30';
const CREAM = '#f6efe0';
const STEEL = '#8d99a6';
const DARK = '#3a3f46';
const CONCRETE = '#c9c3b6';
const GLASS = '#9fd3e6';
const ROOF = '#7b5c4a';

export type BizState = 'open' | 'closed' | 'abandoned' | 'depleted';

export interface MovingPart {
  key: string;
  geo: THREE.BufferGeometry;
  at: [number, number, number];
  axis: 'x' | 'y' | 'z';
  kind: 'spin' | 'nod' | 'bob' | 'drive' | 'swing' | 'grow';
  speed: number;
  amp?: number; // nod/swing amplitude (rad) or drive distance (m)
}

export interface ModelDef {
  key: string;
  base: THREE.BufferGeometry;
  glow?: THREE.BufferGeometry; // windows, signs, furnaces: lit at night
  moving: MovingPart[];
  vendor?: [number, number, number]; // where a vendor stands (faces +z)
  steam: [number, number, number][];
  smoke: [number, number, number][];
  radius: number;
  height: number;
  front: number; // distance in front of the origin where customers queue
}

export interface ModelCtx {
  crop?: string | null; // farm crop
  fill?: number; // storage fill 0..1 (yards)
  resource?: string | null; // mines
}

const cache = new Map<string, ModelDef>();

export function businessModel(kind: string, tier: number, level: number, state: BizState, ctx: ModelCtx = {}): ModelDef {
  const lv = Math.max(1, Math.min(5, level | 0));
  const fillStep = ctx.fill != null ? Math.round(ctx.fill * 4) : 0;
  const key = `${kind}:${lv}:${state}:${ctx.crop ?? ''}:${fillStep}:${ctx.resource ?? ''}`;
  let m = cache.get(key);
  if (!m) {
    const b = new Builder(kind, tier, lv, state);
    const custom = overrides.get(`${kind}:${lv}`) ?? overrides.get(kind);
    if (custom) {
      // A hand-made model from models/manifest.json replaces the built one.
      b.add(custom.clone());
      custom.computeBoundingBox();
      const bb = custom.boundingBox!;
      b.radius = Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z) / 2;
      b.height = bb.max.y;
      b.front = ROOM_KINDS.has(kind) || kind === 'cart' ? b.radius + 1 : -1;
    } else (BUILDERS[kind] ?? genericShop)(b, ctx);
    m = b.done(key);
    cache.set(key, m);
  }
  return m;
}

class Builder {
  parts: THREE.BufferGeometry[] = [];
  glows: THREE.BufferGeometry[] = [];
  moving: MovingPart[] = [];
  steam: [number, number, number][] = [];
  smoke: [number, number, number][] = [];
  vendor?: [number, number, number];
  radius = 4;
  height = 4;
  front = 3;
  color: string;
  closed: boolean;
  dead: boolean; // abandoned or depleted: nothing moves
  constructor(public kind: string, public tier: number, public lv: number, public state: BizState) {
    this.color = TIER_COLORS[tier] ?? '#777';
    this.closed = state !== 'open';
    this.dead = state === 'abandoned' || state === 'depleted';
  }
  add(...g: (THREE.BufferGeometry | null | false | undefined)[]) {
    for (const x of g) if (x) this.parts.push(x);
  }
  glow(...g: THREE.BufferGeometry[]) {
    this.glows.push(...g);
  }
  move(p: MovingPart) {
    if (!this.dead && !(this.closed && p.kind !== 'grow')) this.moving.push(p);
    else this.parts.push(p.geo.clone().translate(...p.at));
  }
  // Weeds and boards for abandoned places.
  neglect(r: number) {
    if (this.state !== 'abandoned') return;
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2 + 0.4;
      this.add(cone(0.35 + (i % 3) * 0.15, 0.8 + (i % 2) * 0.5, '#6f8f3a', { at: [Math.cos(a) * r * 0.8, 0, Math.sin(a) * r * 0.8] }, 4));
    }
  }
  done(key: string): ModelDef {
    const base = group(this.parts);
    base.computeBoundingSphere();
    return {
      key,
      base,
      glow: this.glows.length ? group(this.glows) : undefined,
      moving: this.moving,
      vendor: this.vendor,
      steam: this.closed ? [] : this.steam,
      smoke: this.closed ? [] : this.smoke,
      radius: this.radius,
      height: this.height,
      front: this.front,
    };
  }
}

type Build = (b: Builder, ctx: ModelCtx) => void;

// ---------------- tier 1: the food cart ----------------
function cart(b: Builder) {
  const c = b.color;
  if (b.lv >= 3) {
    // A food truck.
    b.add(
      rbox(7.6, 3.6, 3.4, c, { at: [0, 1.0, 0] }, 0.5),
      rbox(2.4, 2.4, 3.3, shade(c, -0.1), { at: [-4.6, 1.0, 0] }, 0.45),
      box(0.1, 1.2, 2.6, GLASS, { at: [-5.82, 2.0, 0] }),
      box(4.2, 1.6, 0.1, '#2b2b2b', { at: [0.6, 2.3, 1.72] }), // serving hatch
      box(4.4, 0.18, 0.7, CREAM, { at: [0.6, 2.2, 1.95] }), // counter
      box(5.2, 0.9, 0.12, CREAM, { at: [0.2, 4.7, 0.6] }), // roof sign
      box(5.2, 0.9, 0.12, b.color, { at: [0.2, 4.72, 0.45] }),
      ...[-3.8, 2.6].flatMap((x) => [cyl(0.85, 0.85, 0.5, DARK, { at: [x, 0.85, 1.6], rot: [Math.PI / 2, 0, 0] }, 10), cyl(0.85, 0.85, 0.5, DARK, { at: [x, 0.85, -1.6], rot: [Math.PI / 2, 0, 0] }, 10)])
    );
    b.add(awning(4.8, 1.6, [c, CREAM], { at: [0.6, 4.1, 2.5] }, 7, 0.4));
    b.glow(box(5.0, 0.6, 0.06, '#ffe7a8', { at: [0.2, 4.85, 0.38] }));
    b.vendor = [0.6, 1.0, 0.4];
    b.steam.push([-1.0, 4.9, 0], [1.6, 4.9, 0]);
    b.radius = 5;
    b.height = 5.5;
    b.front = 3.6;
  } else {
    // A handcart with a striped awning and a menu board.
    b.add(
      rbox(3.8, 1.4, 2.1, WOOD, { at: [0, 1.0, 0] }, 0.25),
      box(3.9, 0.18, 0.3, c, { at: [0, 1.9, 1.02] }),
      box(4.0, 0.16, 2.3, CREAM, { at: [0, 2.4, 0] }),
      cyl(0.78, 0.78, 0.22, DARK, { at: [-2.05, 0.78, 0], rot: [0, 0, Math.PI / 2] }, 10),
      cyl(0.78, 0.78, 0.22, DARK, { at: [2.05, 0.78, 0], rot: [0, 0, Math.PI / 2] }, 10),
      cyl(0.2, 0.2, 0.3, '#c9a227', { at: [-2.15, 0.78, 0], rot: [0, 0, Math.PI / 2] }, 6),
      cyl(0.2, 0.2, 0.3, '#c9a227', { at: [2.15, 0.78, 0], rot: [0, 0, Math.PI / 2] }, 6),
      box(0.12, 0.12, 1.6, WOOD_D, { at: [-1.4, 1.6, -1.8] }),
      box(0.12, 0.12, 1.6, WOOD_D, { at: [1.4, 1.6, -1.8] }),
      ...[-1.8, 1.8].flatMap((x) => [cyl(0.07, 0.07, 2.0, WOOD_D, { at: [x, 2.5, 0.95] }, 5), cyl(0.07, 0.07, 2.0, WOOD_D, { at: [x, 2.5, -0.95] }, 5)]),
      // produce on the counter
      ball(0.32, '#e5533d', { at: [-0.9, 2.8, 0.3] }),
      ball(0.32, '#7cc35a', { at: [-0.3, 2.8, 0.45] }),
      ball(0.3, '#f4cf3f', { at: [0.4, 2.78, 0.35] }),
      cyl(0.35, 0.3, 0.55, '#d9d4c7', { at: [1.15, 2.55, 0.1] }, 8), // the pot
      // menu board (A-frame) in front
      box(1.2, 1.6, 0.1, '#2b2f33', { at: [2.8, 0, 2.4], rot: [0.18, -0.4, 0] }),
      box(1.0, 0.12, 0.06, CREAM, { at: [2.8, 1.05, 2.55], rot: [0.18, -0.4, 0] }),
      box(0.8, 0.08, 0.06, CREAM, { at: [2.8, 0.75, 2.6], rot: [0.18, -0.4, 0] })
    );
    b.add(awning(4.6, 2.8, [c, CREAM], { at: [0, 4.55, 0] }, 6, 0.35));
    b.vendor = [0, 0, -1.9];
    b.steam.push([1.15, 3.1, 0.1]);
    if (b.lv >= 2) {
      // A parasol and a stool for regulars.
      b.add(cyl(0.06, 0.06, 3.6, '#ddd', { at: [-3.4, 0, 2.2] }, 5), cone(1.9, 0.9, GOLD, { at: [-3.4, 3.4, 2.2] }, 8), cyl(0.45, 0.4, 1.1, WOOD_D, { at: [-2.8, 0, 2.9] }, 8), cyl(0.55, 0.55, 0.12, c, { at: [-2.8, 1.1, 2.9] }, 8));
    }
    b.radius = 3.4;
    b.height = 4.8;
    b.front = 3.2;
  }
  if (b.closed) b.add(box(3.6, 1.0, 2.0, '#7d7f80', { at: [0, 2.5, 0] }));
  b.neglect(3);
}

// ---------------- tier 2: shopfronts on real buildings ----------------
function storefront(b: Builder, awn: [string, string], signColor: string) {
  const w = 6 + b.lv * 0.8;
  b.add(
    box(w + 0.6, 1.0, 0.25, signColor, { at: [0, 5.2, 0.15] }),
    box(w + 0.8, 0.12, 0.3, GOLD, { at: [0, 6.2, 0.2] }),
    box(0.3, 5.2, 0.4, shade(signColor, -0.2), { at: [-w / 2 - 0.2, 0, 0.1] }),
    box(0.3, 5.2, 0.4, shade(signColor, -0.2), { at: [w / 2 + 0.2, 0, 0.1] })
  );
  b.glow(box(w - 0.6, 0.55, 0.06, '#fff2c8', { at: [0, 5.42, 0.3] }));
  if (b.closed) {
    b.add(box(w, 3.6, 0.2, '#8e9090', { at: [0, 0, 0.12] }), ...[0.6, 1.4, 2.2, 3.0].map((y) => box(w, 0.06, 0.24, '#6f7171', { at: [0, y, 0.15] })));
  } else {
    b.add(awning(w, 2.4, awn, { at: [0, 4.6, 1.2] }, Math.round(w / 0.9), 0.4));
    b.glow(box(w - 1.4, 2.6, 0.05, '#ffe0a0', { at: [0, 0.6, 0.06] }));
  }
  b.radius = w / 2 + 1;
  b.height = 6.5;
  b.front = 4.5;
}

function tables(b: Builder, n: number, top: string, umbrella?: string) {
  for (let i = 0; i < n; i++) {
    const x = -((n - 1) * 2.6) / 2 + i * 2.6;
    const z = 3.6 + (i % 2) * 1.2;
    b.add(cyl(0.7, 0.7, 0.1, top, { at: [x, 1.6, z] }, 10), cyl(0.08, 0.08, 1.6, DARK, { at: [x, 0, z] }, 5), box(0.6, 0.9, 0.6, WOOD, { at: [x - 1.0, 0, z] }), box(0.6, 0.9, 0.6, WOOD, { at: [x + 1.0, 0, z] }));
    if (umbrella) b.add(cyl(0.05, 0.05, 3.4, '#ddd', { at: [x, 1.6, z] }, 4), cone(1.5, 0.7, umbrella, { at: [x, 4.4, z] }, 8));
    b.steam.push([x, 1.9, z]);
  }
}

function planter(x: number, z: number) {
  return group([box(1.0, 0.8, 1.0, WOOD_D, { at: [x, 0, z] }), ball(0.7, '#5f9f45', { at: [x, 1.2, z] })]);
}

const cafe: Build = (b) => {
  storefront(b, ['#2f8f6e', CREAM], '#1f5f4a');
  if (!b.closed) {
    tables(b, Math.min(4, 1 + Math.ceil(b.lv / 2)), CREAM);
    if (b.lv >= 3) b.add(planter(-5.4, 2.2), planter(5.4, 2.2));
    b.add(box(1.0, 1.4, 0.1, '#2b2f33', { at: [3.4, 0, 2.6], rot: [0.15, 0.3, 0] }));
  }
  b.neglect(5);
};

const restaurant: Build = (b) => {
  storefront(b, ['#9b2d2d', CREAM], '#5a1e1e');
  if (!b.closed) {
    tables(b, Math.min(5, 1 + b.lv), '#ffffff', b.lv >= 2 ? '#9b2d2d' : undefined);
    // string lights over the terrace
    const n = 10 + b.lv * 2;
    for (let i = 0; i < n; i++) b.glow(ball(0.12, '#ffd36b', { at: [-n * 0.33 + i * 0.66, 5.0 - Math.sin((i / (n - 1)) * Math.PI) * 0.6, 5.0] }));
    if (b.lv >= 4) b.add(planter(-6, 2.6), planter(6, 2.6));
  }
  b.neglect(5);
};

const grocery: Build = (b) => {
  storefront(b, ['#4f8a2c', CREAM], '#3d6b22');
  if (!b.closed) {
    const crates = 2 + b.lv;
    const produce = ['#e5533d', '#7cc35a', '#f4cf3f', '#f08a2e', '#c9985a', '#9ccf6a'];
    for (let i = 0; i < crates; i++) {
      const x = -((crates - 1) * 1.5) / 2 + i * 1.5;
      b.add(box(1.3, 0.9, 1.0, WOOD, { at: [x, 0, 2.2], rot: [-0.2, 0, 0] }), ...[0, 1, 2].map((k) => ball(0.3, produce[(i + k) % produce.length], { at: [x - 0.35 + k * 0.35, 0.95, 2.25] })));
    }
  }
  b.neglect(5);
};

const furnitureStore: Build = (b) => {
  storefront(b, ['#8a6b4a', CREAM], '#5e4630');
  // a sofa in the window
  b.add(box(3.0, 0.8, 1.1, '#c96f4a', { at: [0, 0.3, -0.7] }), box(3.0, 1.1, 0.35, '#b85e3a', { at: [0, 0.3, -1.2] }));
  if (b.lv >= 3) van(b, 6.5, 3.4, '#f6efe0');
  b.neglect(5);
};

const electronicsStore: Build = (b) => {
  storefront(b, ['#3a4a6a', '#e3f2ff'], '#24304a');
  for (let i = 0; i < 2 + Math.min(3, b.lv); i++) b.glow(box(1.2, 0.8, 0.05, '#7fd6ff', { at: [-2.4 + i * 1.3, 1.8 + (i % 2) * 0.9, 0.1] }));
  if (b.lv >= 3) van(b, 6.5, 3.4, '#e3f2ff');
  b.neglect(5);
};

function van(b: Builder, x: number, z: number, color: string) {
  b.add(rbox(4.6, 2.5, 2.3, color, { at: [x, 0.6, z], rot: [0, Math.PI / 2, 0] }, 0.4), box(2.0, 1.0, 0.08, GLASS, { at: [x, 1.9, z + 2.32] }), ...[-1.4, 1.4].flatMap((dz) => [-1.15, 1.15].map((dx) => cyl(0.55, 0.55, 0.3, DARK, { at: [x + dx, 0.55, z + dz], rot: [0, 0, Math.PI / 2] }, 8))));
}

const bank: Build = (b) => {
  const w = 9 + b.lv;
  const colH = 6 + b.lv * 0.8;
  const cols = 4 + Math.min(2, Math.floor(b.lv / 2));
  b.add(box(w + 1.2, 0.6, 3.0, '#e8e2d2', { at: [0, 0, 1.3] }), box(w + 0.6, 0.4, 2.4, '#efe9da', { at: [0, 0.6, 1.2] }));
  for (let i = 0; i < cols; i++) {
    const x = -w / 2 + 0.6 + (i * (w - 1.2)) / (cols - 1);
    b.add(cyl(0.42, 0.48, colH, '#f1ece0', { at: [x, 1.0, 2.0] }, 10), box(1.1, 0.3, 1.1, '#e6dfcf', { at: [x, 1.0 + colH, 2.0] }));
  }
  b.add(box(w + 0.8, 0.8, 2.6, '#ece6d8', { at: [0, 1.3 + colH, 1.4] }), gable(w + 0.8, 1.8, 2.6, '#e2dbc9', { at: [0, 2.1 + colH, 1.4] }), box(w * 0.6, 0.5, 0.1, GOLD, { at: [0, 1.45 + colH, 2.72] }));
  b.glow(box(w * 0.55, 0.35, 0.06, '#ffd36b', { at: [0, 1.52 + colH, 2.78] }));
  if (b.lv >= 3) {
    for (const x of [-w / 2 - 1.2, w / 2 + 1.2]) {
      b.add(cyl(0.08, 0.08, colH + 3, '#ddd', { at: [x, 0, 2.6] }, 5));
      b.move({ key: 'flag', geo: box(1.6, 1.0, 0.05, b.color, { at: [0.85, -1.0, 0] }), at: [x, colH + 3, 2.6], axis: 'y', kind: 'swing', speed: 1.6, amp: 0.35 });
    }
  }
  b.radius = w / 2 + 2;
  b.height = colH + 4;
  b.front = 5;
};

// ---------------- tier 3: land ----------------
const CROP_COLORS: Record<string, [string, string]> = {
  lettuce: ['#7cc35a', '#5c9a3e'], tomato: ['#e5533d', '#4a9a3a'], banana: ['#f4cf3f', '#3f8a3a'], pumpkin: ['#f08a2e', '#5a8a3a'],
  wasabi: ['#9ccf6a', '#4a8a3a'], wheat: ['#e8c05a', '#c9a23a'], potato: ['#8fb35a', '#6a8a3a'], rice: ['#b8d86a', '#7aa84a'], coffee: ['#4a7a3a', '#b84a3a'],
};

const farm: Build = (b, ctx) => {
  const [ripe, leaf] = CROP_COLORS[ctx.crop ?? 'lettuce'] ?? CROP_COLORS.lettuce;
  // soil
  b.add(box(22, 0.25, 22, '#8a6a48', { at: [0, 0, 0] }));
  const rows = 3 + b.lv * 2;
  for (let r = 0; r < rows; r++) {
    const z = -9 + (r * 18) / Math.max(1, rows - 1);
    b.add(box(13, 0.35, 0.9, '#6f5236', { at: [-3.2, 0.2, z] }));
    if (!b.dead) b.move({ key: `crop:${ctx.crop ?? 'lettuce'}`, geo: group([box(12.6, 1.0, 0.8, leaf), box(12.4, 0.5, 0.6, ripe, { at: [0, 0.9, 0] })]), at: [-3.2, 0.45, z], axis: 'y', kind: 'grow', speed: 0.05, amp: r * 0.37 });
  }
  // barn and silos
  b.add(box(6, 4.2, 7, '#b5402f', { at: [7.5, 0.25, -5] }), gable(6.6, 2.6, 7.4, '#7b2f24', { at: [7.5, 4.45, -5], rot: [0, Math.PI / 2, 0] }), box(2.2, 3.0, 0.1, CREAM, { at: [7.5, 0.25, -1.45] }));
  b.add(cyl(1.6, 1.6, 8 + b.lv * 0.6, '#d9d4c7', { at: [7.5, 0.25, 3] }, 12), ball(1.6, '#a9b3bb', { at: [7.5, 8.25 + b.lv * 0.6, 3], scale: [1, 0.6, 1] }, 1));
  if (b.lv >= 3) b.add(cyl(1.3, 1.3, 7, '#d9d4c7', { at: [9.6, 0.25, 6.4] }, 12), ball(1.3, '#a9b3bb', { at: [9.6, 7.25, 6.4], scale: [1, 0.6, 1] }, 1));
  if (b.lv >= 4) {
    b.move({ key: 'tractor', geo: group([box(2.6, 1.6, 1.6, '#c9302c', { at: [0, 0.8, 0] }), box(1.2, 1.4, 1.4, '#c9302c', { at: [-0.6, 2.2, 0] }), cyl(0.8, 0.8, 0.4, DARK, { at: [-0.8, 0.8, 0.9], rot: [Math.PI / 2, 0, 0] }, 8), cyl(0.8, 0.8, 0.4, DARK, { at: [-0.8, 0.8, -0.9], rot: [Math.PI / 2, 0, 0] }, 8), cyl(0.5, 0.5, 0.3, DARK, { at: [1.0, 0.5, 0.9], rot: [Math.PI / 2, 0, 0] }, 8)]), at: [-3.2, 0.25, 0], axis: 'x', kind: 'drive', speed: 0.12, amp: 5.5 });
  }
  b.radius = 13;
  b.height = 9;
  b.front = 12;
  b.neglect(11);
};

const treeFarm: Build = (b) => {
  b.add(box(22, 0.25, 22, '#7a6a48'));
  const n = 3 + b.lv;
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      const x = -9 + (i * 18) / (n - 1);
      const z = -9 + (j * 18) / (n - 1);
      b.add(cyl(0.18, 0.22, 1.0, WOOD_D, { at: [x, 0.25, z] }, 5));
      b.move({ key: 'pine', geo: group([cone(1.25, 2.6, '#3f7a3a', {}, 6), cone(0.95, 2.0, '#4f8a42', { at: [0, 1.6, 0] }, 6)]), at: [x, 1.1, z], axis: 'y', kind: 'grow', speed: 0.025, amp: (i * 3 + j * 7) % 10 * 0.1 });
    }
  b.add(...[0, 1, 2, 3].map((k) => cyl(0.45, 0.45, 3.2, WOOD, { at: [10.3, 0.6 + k * 0.85, -7 + (k % 2) * 0.4], rot: [Math.PI / 2, 0, 0] }, 7)));
  b.radius = 13;
  b.height = 5;
  b.front = 12;
  b.neglect(11);
};

const CONTAINER = ['#c9502c', '#2f6f9e', '#e8b23a', '#3f8a5a', '#8a4a8a', '#d9d4c7'];
const yard: Build = (b, ctx) => {
  b.add(box(22, 0.2, 22, '#9a968c'));
  // fence
  for (const s of [-1, 1]) {
    b.add(box(22, 1.8, 0.1, '#b8bcc0', { at: [0, 0.2, s * 11] }), box(0.1, 1.8, 22, '#b8bcc0', { at: [s * 11, 0.2, 0] }));
  }
  const fill = Math.max(0.15, ctx.fill ?? 0.3);
  const cols = 2 + Math.min(3, b.lv);
  let k = 0;
  for (let c = 0; c < cols; c++)
    for (let r = 0; r < 3; r++) {
      const stack = Math.max(1, Math.round(fill * (1 + Math.min(4, b.lv))));
      for (let h = 0; h < stack; h++) b.add(box(6.0, 2.5, 2.4, CONTAINER[(k++ * 7) % CONTAINER.length], { at: [-6.5 + (c * 13) / Math.max(1, cols - 1), 0.2 + h * 2.55, -7 + r * 3.0] }));
    }
  b.move({ key: 'forklift', geo: group([box(2.0, 1.4, 1.4, '#f2c14b', { at: [0, 0.4, 0] }), box(0.1, 3.0, 1.2, DARK, { at: [1.1, 0.2, 0] }), box(1.2, 0.1, 1.0, DARK, { at: [1.7, 0.4, 0] }), box(1.2, 1.4, 1.2, '#f2c14b', { at: [-0.3, 1.8, 0] })]), at: [0, 0.2, 6], axis: 'x', kind: 'drive', speed: 0.2, amp: 6 });
  b.radius = 13;
  b.height = 3 + fill * 10;
  b.front = 12;
  b.neglect(11);
};

const apartments: Build = (b) => {
  const floors = 3 + b.lv * 2;
  const fh = 3.1;
  const w = 13;
  const d = 11;
  b.add(rbox(w, 1.2, d, '#8f8a82', {}, 0.6));
  for (let f = 0; f < floors; f++) {
    const y = 1.2 + f * fh;
    b.add(rbox(w - 0.4, fh - 0.25, d - 0.4, f % 2 ? '#e9dfcd' : '#e2d6c1', { at: [0, y, 0] }, 0.5), box(w, 0.25, d, '#cfc4b0', { at: [0, y + fh - 0.25, 0] }));
    for (let i = 0; i < 4; i++) {
      const x = -4.5 + i * 3;
      b.glow(box(1.4, 1.5, 0.08, '#ffe3a1', { at: [x, y + 0.7, d / 2 - 0.15] }), box(1.4, 1.5, 0.08, '#ffe3a1', { at: [x, y + 0.7, -d / 2 + 0.15] }));
      if (f > 0 && i % 2 === 0) b.add(box(2.6, 0.18, 1.2, '#cfc4b0', { at: [x + 1.5, y, d / 2 + 0.5] }), box(2.6, 0.9, 0.08, b.color, { at: [x + 1.5, y + 0.18, d / 2 + 1.1] }));
    }
  }
  const top = 1.2 + floors * fh;
  b.add(box(w + 0.4, 0.6, d + 0.4, ROOF, { at: [0, top, 0] }), box(3, 2, 3, '#b8b2a6', { at: [3, top + 0.6, -2] }), cyl(1.0, 1.0, 2.4, '#8d99a6', { at: [-3.5, top + 0.6, 1.5] }, 8));
  b.add(box(3, 3, 0.2, '#5a4630', { at: [0, 0, d / 2 + 0.05] }));
  b.radius = 9;
  b.height = top + 3;
  b.front = 9;
  b.neglect(8);
};

// ---------------- tier 4: mines, quarries, oil ----------------
const ORE: Record<string, string> = { coal: '#3a3a3f', iron_ore: '#8a5a48', copper_ore: '#4fa58a', limestone: '#e8e2cf', sand: '#e8c88a', crude_oil: '#2d2a33' };

function mine(b: Builder, ctx: ModelCtx) {
  const ore = ORE[ctx.resource ?? (b.kind === 'coal_mine' ? 'coal' : b.kind === 'iron_mine' ? 'iron_ore' : 'copper_ore')] ?? '#666';
  const h = 9 + b.lv * 1.6;
  const rust = b.state === 'depleted' ? '#7a5a40' : '#5a6a7a';
  b.add(box(20, 0.2, 20, '#8f8578'));
  // headframe: four legs and cross braces
  for (const [x, z] of [[-2, -2], [2, -2], [-2, 2], [2, 2]]) b.add(box(0.4, h, 0.4, rust, { at: [x * 0.8, 0, z * 0.8], rot: [x * 0.03, 0, -z * 0.03] }));
  for (let y = 2; y < h; y += 2.4) b.add(box(3.6, 0.25, 0.25, rust, { at: [0, y, -1.6] }), box(3.6, 0.25, 0.25, rust, { at: [0, y, 1.6] }));
  b.add(box(4.2, 0.6, 4.2, rust, { at: [0, h, 0] }));
  b.move({ key: 'headwheel', geo: group([torus(1.5, 0.18, DARK, {}, 14), box(3.0, 0.15, 0.15, DARK), box(0.15, 3.0, 0.15, DARK)]), at: [0, h + 1.9, 0], axis: 'z', kind: 'spin', speed: 1.4 });
  // winding house, spoil heap, ore carts on rails
  b.add(box(5, 4, 4, '#a4573a', { at: [-6.5, 0.2, -5] }), gable(5.4, 1.6, 4.4, ROOF, { at: [-6.5, 4.2, -5], rot: [0, Math.PI / 2, 0] }), cone(5 + b.lv * 0.5, 4 + b.lv * 0.8, ore, { at: [6, 0.2, -5] }, 7));
  b.add(box(1.0, 0.1, 18, '#6a5a4a', { at: [-0.6, 0.2, 0] }), box(1.0, 0.1, 18, '#6a5a4a', { at: [0.6, 0.2, 0] }));
  for (let i = 0; i < 1 + Math.min(3, b.lv); i++) b.add(box(1.8, 1.2, 2.2, '#6a6f74', { at: [0, 0.5, 3.5 + i * 2.6] }), box(1.5, 0.4, 1.9, ore, { at: [0, 1.7, 3.5 + i * 2.6] }));
  if (!b.closed) b.smoke.push([-6.5, 6.5, -5]);
  b.radius = 12;
  b.height = h + 3;
  b.front = 11;
  b.neglect(10);
}

function pit(b: Builder, sand: boolean) {
  const c = sand ? '#e8c88a' : '#e2dccb';
  if (sand) {
    for (let i = 0; i < 1 + Math.min(3, b.lv); i++) b.add(cone(4 + b.lv * 0.6 - i * 0.4, 3 + b.lv * 0.8, c, { at: [-4 + i * 4.5, 0, -3 + (i % 2) * 5] }, 9));
  } else {
    for (let s = 0; s < 2 + b.lv; s++) b.add(box(20 - s * 3, 0.9, 20 - s * 3, shade(c, -0.06 * s), { at: [0, s * 0.9, 0] }));
  }
  // digger: tracks, cab, arm
  const digger = group([box(3.2, 1.0, 2.6, DARK, { at: [0, 0, 0] }), box(2.4, 1.8, 2.2, '#e8b23a', { at: [0, 1.0, 0] }), box(1.0, 1.0, 1.6, GLASS, { at: [-0.5, 2.8, 0] })]);
  const top = sand ? 0 : (2 + b.lv) * 0.9;
  b.add(digger.translate(4, top, 4));
  b.move({ key: 'diggerarm', geo: group([box(4.2, 0.45, 0.45, '#e8b23a', { at: [2.1, 0, 0] }), box(0.9, 0.9, 1.0, DARK, { at: [4.2, -0.6, 0] })]), at: [5.2, top + 2.4, 4], axis: 'z', kind: 'nod', speed: 0.9, amp: 0.35 });
  b.radius = 12;
  b.height = 6;
  b.front = 11;
  b.neglect(10);
}

const oilWell: Build = (b) => {
  b.add(box(20, 0.2, 20, '#9a8e7a'));
  const n = Math.min(4, 1 + Math.floor((b.lv - 1) / 1.4));
  for (let i = 0; i < n; i++) {
    const x = -6 + (i % 2) * 11;
    const z = -5 + Math.floor(i / 2) * 10;
    b.add(box(4.6, 0.6, 1.8, DARK, { at: [x, 0.2, z] }), box(0.35, 4.2, 0.35, '#c9502c', { at: [x - 0.6, 0.8, z - 0.5], rot: [0, 0, 0.18] }), box(0.35, 4.2, 0.35, '#c9502c', { at: [x + 0.6, 0.8, z - 0.5], rot: [0, 0, -0.18] }), cyl(0.3, 0.3, 2.4, '#555', { at: [x + 2.6, 0.8, z] }, 6));
    b.move({ key: 'pumpbeam', geo: group([box(6.2, 0.5, 0.5, '#c9502c'), box(0.9, 1.6, 0.6, DARK, { at: [3.2, -1.1, 0] }), box(1.2, 1.0, 0.8, DARK, { at: [-3.0, -0.8, 0] })]), at: [x, 5.0, z - 0.5], axis: 'z', kind: 'nod', speed: 1.6, amp: 0.28 });
  }
  b.add(cyl(2.2, 2.2, 4, '#d9d4c7', { at: [7, 0.2, 6] }, 10));
  b.radius = 12;
  b.height = 7;
  b.front = 11;
  b.neglect(10);
};

// ---------------- tier 5: industry and ports ----------------
function hall(b: Builder, w: number, d: number, h: number, wall: string, roof: string, sawtooth = false) {
  b.add(box(w, h, d, wall, { at: [0, 0.2, 0] }));
  if (sawtooth) {
    const teeth = Math.max(2, Math.round(w / 4));
    for (let i = 0; i < teeth; i++) b.add(gable(w / teeth, 1.6, d, roof, { at: [-w / 2 + (w / teeth) * (i + 0.5), h + 0.2, 0], rot: [0, 0, 0] }));
  } else b.add(box(w + 0.4, 0.5, d + 0.4, roof, { at: [0, h + 0.2, 0] }));
  for (let i = 0; i < Math.floor(w / 3); i++) b.glow(box(1.6, 1.0, 0.08, '#ffe3a1', { at: [-w / 2 + 1.5 + i * 3, h * 0.55, d / 2 + 0.05] }));
  b.add(box(3, 3, 0.15, DARK, { at: [w / 2 - 3, 0.2, d / 2 + 0.05] }));
}

function chimney(b: Builder, x: number, z: number, h: number, c = '#a4573a') {
  b.add(cyl(0.8, 1.1, h, c, { at: [x, 0.2, z] }, 8), cyl(0.95, 0.95, 0.5, DARK, { at: [x, h, z] }, 8));
  b.smoke.push([x, h + 0.8, z]);
}

const flourMill: Build = (b) => {
  const h = 9 + b.lv * 1.2;
  b.add(box(20, 0.2, 20, '#a89a7a'), cyl(2.2, 3.4, h, '#e8e0cf', { at: [0, 0.2, 0] }, 8), cone(2.8, 3.0, ROOF, { at: [0, h + 0.2, 0] }, 8), box(1.6, 2.6, 0.2, WOOD_D, { at: [0, 0.2, 3.3] }));
  b.move({ key: 'sails', geo: group([0, 1, 2, 3].map((i) => box(1.3, 7, 0.12, CREAM, { at: [0, 3.6, 0], rot: [0, 0, 0] }).rotateZ((i * Math.PI) / 2))), at: [0, h - 0.6, 3.3], axis: 'z', kind: 'spin', speed: 0.8 });
  if (b.lv >= 3) hall(b, 8, 6, 4, '#d9cdb5', ROOF);
  b.add(...[0, 1, 2].map((i) => box(1.2, 0.8, 0.9, '#efe9da', { at: [5 + i * 1.3, 0.2, 5] })));
  b.radius = 11;
  b.height = h + 8;
  b.front = 10;
  b.neglect(10);
};

function factory(b: Builder, wall: string, roof: string, extras: (b: Builder) => void, sawtooth = true) {
  const w = 12 + b.lv * 1.5;
  const h = 5 + b.lv * 0.6;
  b.add(box(22, 0.2, 22, '#9e988c'));
  hall(b, w, 12, h, wall, roof, sawtooth);
  extras(b);
  b.radius = 13;
  b.height = h + 8;
  b.front = 12;
  b.neglect(11);
}

const foodFactory: Build = (b) => factory(b, '#e8e0cf', '#b5402f', (b) => {
  chimney(b, 7, -4, 9 + b.lv);
  b.steam.push([-3, 7 + b.lv * 0.6, 0]);
  b.add(...[0, 1].map((i) => cyl(1.4, 1.4, 6, '#d9d4c7', { at: [-8, 0.2, -4 + i * 3.2] }, 10)));
});
const steelMill: Build = (b) => factory(b, '#6a6f74', '#4a4f55', (b) => {
  for (let i = 0; i < 1 + Math.min(3, Math.floor(b.lv / 1.5)); i++) chimney(b, -5 + i * 3.4, -4, 12 + b.lv, '#5a5550');
  b.add(cyl(2.6, 3.2, 9, '#7a5a40', { at: [7, 0.2, 3] }, 10));
  b.glow(box(3.4, 1.6, 0.1, '#ff7a2a', { at: [0, 0.6, 6.05] }), cyl(2.0, 2.0, 0.3, '#ff9a3a', { at: [7, 9.2, 3] }, 10));
}, false);
const refinery: Build = (b) => {
  b.add(box(22, 0.2, 22, '#9e988c'));
  const tanks = 2 + Math.min(4, b.lv);
  for (let i = 0; i < tanks; i++) b.add(cyl(2.4, 2.4, 3.5 + (i % 2), '#e8e4dc', { at: [-7 + (i % 3) * 5.2, 0.2, -6 + Math.floor(i / 3) * 5.4] }, 12), cyl(2.5, 2.5, 0.3, '#c9502c', { at: [-7 + (i % 3) * 5.2, 2.2, -6 + Math.floor(i / 3) * 5.4] }, 12));
  for (let i = 0; i < 1 + Math.floor(b.lv / 2); i++) b.add(cyl(0.9, 1.0, 12 + i * 2, STEEL, { at: [5 + i * 2.2, 0.2, 4] }, 8), ...[3, 6, 9].map((y) => cyl(1.25, 1.25, 0.25, '#ddd', { at: [5 + i * 2.2, y, 4] }, 8)));
  b.add(cyl(0.3, 0.4, 16, DARK, { at: [8.5, 0.2, -6] }, 6));
  b.glow(cone(0.7, 2.2, '#ff8a2a', { at: [8.5, 16.2, -6] }, 6));
  b.radius = 13;
  b.height = 18;
  b.front = 12;
  b.neglect(11);
};
const cementWorks: Build = (b) => factory(b, '#d9d4c7', '#a9a49a', (b) => {
  b.add(cyl(1.5, 1.5, 16, '#b8b2a6', { at: [-1, 3, 6.5], rot: [0, 0, Math.PI / 2 - 0.08] }, 10));
  for (let i = 0; i < 2 + Math.min(2, b.lv - 1); i++) b.add(cyl(2.0, 2.0, 11 + b.lv, '#cfc9bd', { at: [-8 + i * 4.4, 0.2, -6] }, 10), cone(2.0, 1.4, '#a9a49a', { at: [-8 + i * 4.4, 11.2 + b.lv, -6] }, 10));
  chimney(b, 8, -6, 13 + b.lv, '#b8b2a6');
});
const glassworks: Build = (b) => factory(b, '#c9d8de', '#6a8090', (b) => {
  b.add(cone(3.2, 11 + b.lv, '#a4573a', { at: [6.5, 0.2, -4] }, 8));
  b.smoke.push([6.5, 11.5 + b.lv, -4]);
  for (let i = 0; i < 3; i++) b.glow(box(1.6, 1.4, 0.1, '#ff9a3a', { at: [-4 + i * 3, 0.8, 6.05] }));
});
const smelter: Build = (b) => factory(b, '#8a6a58', '#5a4a40', (b) => {
  chimney(b, 6, -5, 16 + b.lv * 1.5, '#7a4a38');
  b.add(...[0, 1, 2].map((i) => box(2, 0.6, 1.2, '#d9853b', { at: [-8, 0.2 + i * 0.6, 7] })));
  b.glow(box(2.6, 1.4, 0.1, '#ff7a2a', { at: [-2, 0.8, 6.05] }));
});
const sawmill: Build = (b) => {
  b.add(box(22, 0.2, 22, '#a8987a'));
  hall(b, 10 + b.lv, 8, 4.5, '#b07a42', '#6f4a2a', false);
  for (let s = 0; s < 1 + Math.min(3, b.lv); s++)
    for (let r = 0; r < 3; r++) for (let i = 0; i < 4 - r; i++) b.add(cyl(0.5, 0.5, 6, s % 2 ? '#a06a3a' : '#b07a42', { at: [-7 + s * 4.6 + i * 1.0 + r * 0.5, 0.7 + r * 0.9, 7], rot: [Math.PI / 2, 0, 0] }, 7));
  b.move({ key: 'sawblade', geo: group([cyl(1.4, 1.4, 0.1, '#c0c6cc', {}, 14).rotateX(Math.PI / 2)]), at: [6, 2.0, 4.3], axis: 'z', kind: 'spin', speed: 6 });
  b.radius = 13;
  b.height = 7;
  b.front = 12;
  b.neglect(11);
};
const furnitureFactory: Build = (b) => factory(b, '#d9b98a', '#7a5430', (b) => {
  chimney(b, 7, -5, 8 + b.lv, '#8a5a40');
  b.add(...[0, 1, 2, 3].map((i) => box(4, 0.3, 1.2, '#d9a66a', { at: [-8, 0.2 + i * 0.3, 7] })), box(2.6, 0.8, 1.1, '#c96f4a', { at: [-2, 0.2, 7.5] }));
});
const electronicsPlant: Build = (b) => {
  b.add(box(22, 0.2, 22, '#b8bcc0'));
  const h = 6 + b.lv * 1.4;
  b.add(rbox(16, h, 11, '#e8ecf0', { at: [0, 0.2, 0] }, 1.2), box(16.4, 0.5, 11.4, '#b8c0c8', { at: [0, h + 0.2, 0] }));
  for (let f = 0; f < Math.floor(h / 2.4); f++) b.glow(box(15, 0.9, 0.08, '#8fd4ff', { at: [0, 1.4 + f * 2.4, 5.55] }));
  b.add(...[0, 1, 2].map((i) => cyl(0.06, 0.06, 3, DARK, { at: [-4 + i * 4, h + 0.7, -2] }, 4)), ball(1.0, '#e8ecf0', { at: [4, h + 1.5, 2], scale: [1, 0.4, 1] }, 1));
  b.radius = 12;
  b.height = h + 4;
  b.front = 11;
  b.neglect(10);
};

const port: Build = (b) => {
  // A quay along the water (+z), containers and cranes.
  const len = 18 + b.lv * 2;
  b.add(box(len, 1.2, 9, '#a9a49a', { at: [0, 0, 2] }), box(len, 0.25, 0.4, '#e8b23a', { at: [0, 1.2, 6.4] }));
  for (let i = 0; i < 2 + b.lv; i++) b.add(box(5.5, 2.4, 2.3, CONTAINER[i % CONTAINER.length], { at: [-len / 2 + 3.5 + (i % 3) * 6, 1.2 + Math.floor(i / 3) * 2.4, -0.5] }));
  const cranes = Math.min(3, 1 + Math.floor((b.lv - 1) / 2));
  for (let c = 0; c < cranes; c++) {
    const x = -len / 2 + 5 + c * 8;
    b.add(box(0.6, 12, 0.6, '#c9302c', { at: [x - 2, 1.2, 1] }), box(0.6, 12, 0.6, '#c9302c', { at: [x + 2, 1.2, 1] }), box(0.6, 12, 0.6, '#c9302c', { at: [x - 2, 1.2, 5] }), box(0.6, 12, 0.6, '#c9302c', { at: [x + 2, 1.2, 5] }), box(4.8, 1.0, 4.8, '#c9302c', { at: [x, 13, 3] }));
    b.move({ key: 'boom', geo: group([box(0.9, 0.9, 16, '#c9302c', { at: [0, 0, 5] }), box(2, 1.6, 2, '#e8ecf0', { at: [0, -1.0, 0] })]), at: [x, 14.2, 3], axis: 'y', kind: 'swing', speed: 0.25, amp: 0.25 });
  }
  b.radius = len / 2 + 2;
  b.height = 16;
  b.front = -6; // customers don't queue at a port
  b.neglect(9);
};

function genericShop(b: Builder) {
  b.add(rbox(6, 4, 5, '#e2d6c1', {}, 0.6), box(6.4, 0.6, 5.4, b.color, { at: [0, 4, 0] }), box(4, 1, 0.2, b.color, { at: [0, 2.8, 2.55] }));
  b.radius = 4;
  b.height = 5;
}

const BUILDERS: Record<string, Build> = {
  cart,
  cafe,
  restaurant,
  grocery,
  furniture_store: furnitureStore,
  electronics_store: electronicsStore,
  bank,
  farm,
  tree_farm: treeFarm,
  yard,
  apartments,
  coal_mine: mine,
  iron_mine: mine,
  copper_mine: mine,
  limestone_quarry: (b) => pit(b, false),
  sand_pit: (b) => pit(b, true),
  oil_well: oilWell,
  mill: flourMill,
  food_factory: foodFactory,
  steel_mill: steelMill,
  refinery,
  cement_works: cementWorks,
  glassworks,
  smelter,
  sawmill,
  furniture_factory: furnitureFactory,
  electronics_plant: electronicsPlant,
  port,
};

export const ROOM_KINDS = new Set(['cafe', 'restaurant', 'grocery', 'furniture_store', 'electronics_store', 'bank']);

// ---------------- props ----------------
export function propParts() {
  return {
    lamp: group([cyl(0.12, 0.16, 6.5, '#3a3f46', {}, 6), box(1.4, 0.12, 0.12, '#3a3f46', { at: [0.6, 6.4, 0] }), box(0.7, 0.35, 0.5, '#3a3f46', { at: [1.25, 6.1, 0] })]),
    lampGlow: box(0.55, 0.12, 0.4, '#ffe7a8', { at: [1.25, 6.03, 0] }),
    coin: group([cyl(0.55, 0.55, 0.14, '#f2c14b', { rot: [Math.PI / 2, 0, 0] }, 12), cyl(0.38, 0.38, 0.16, '#e8a93a', { rot: [Math.PI / 2, 0, 0] }, 12)]),
    puff: ball(0.5, '#ffffff', {}, 1),
    smoke: ball(0.9, '#c9c6c0', {}, 1),
    flag: group([cyl(0.05, 0.05, 2.2, '#ddd', {}, 4), box(0.9, 0.55, 0.04, GOLD, { at: [0.47, 1.6, 0] })]),
    scaffold: group([
      ...[-1, 1].flatMap((x) => [-1, 1].map((z) => box(0.18, 6, 0.18, '#c9a227', { at: [x * 2.6, 0, z * 2.6] }))),
      ...[1.8, 3.6, 5.4].flatMap((y) => [box(5.4, 0.15, 0.4, WOOD, { at: [0, y, 2.6] }), box(5.4, 0.15, 0.4, WOOD, { at: [0, y, -2.6] }), box(0.4, 0.15, 5.4, WOOD, { at: [2.6, y, 0] }), box(0.4, 0.15, 5.4, WOOD, { at: [-2.6, y, 0] })]),
    ]),
    crane: group([box(0.5, 9, 0.5, '#e8b23a'), box(7, 0.5, 0.5, '#e8b23a', { at: [2.4, 9, 0] }), box(1, 1, 1, DARK, { at: [-1, 8.6, 0] }), cyl(0.04, 0.04, 4, DARK, { at: [5.4, 5, 0] }, 3)]),
    dust: ball(1, '#d9cdb5', {}, 1),
  };
}

export function vehicleParts() {
  const car = (c: string) =>
    group([
      rbox(4.4, 1.2, 2.0, c, { at: [0, 0.45, 0], rot: [0, Math.PI / 2, 0] }, 0.4),
      rbox(2.4, 0.9, 1.8, shade(c, 0.15), { at: [0, 1.65, -0.2], rot: [0, Math.PI / 2, 0] }, 0.35),
      box(1.7, 0.7, 0.06, GLASS, { at: [0, 1.75, 1.0] }),
      ...[-1.35, 1.35].flatMap((z) => [-0.95, 0.95].map((x) => cyl(0.42, 0.42, 0.25, DARK, { at: [x, 0.42, z], rot: [0, 0, Math.PI / 2] }, 8))),
    ]);
  return {
    car: car('#ffffff'), // tinted per car
    taxi: group([car('#f2c14b'), box(0.8, 0.35, 0.4, '#2b2b2b', { at: [0, 2.15, -0.2] })]),
    bus: group([rbox(2.6, 3.0, 11, '#c9302c', { at: [0, 0.5, 0] }, 0.6), box(2.65, 0.9, 10.4, GLASS, { at: [0, 2.0, 0] }), ...[-3.6, 3.6].flatMap((z) => [-1.2, 1.2].map((x) => cyl(0.55, 0.55, 0.3, DARK, { at: [x, 0.55, z], rot: [0, 0, Math.PI / 2] }, 8)))]),
    van: group([rbox(2.3, 2.5, 4.8, '#f6efe0', { at: [0, 0.6, 0] }, 0.4), box(2.0, 0.9, 0.06, GLASS, { at: [0, 2.2, 2.42] }), box(2.32, 0.5, 2.6, '#2f8f6e', { at: [0, 1.4, -0.8] }), ...[-1.5, 1.5].flatMap((z) => [-1.1, 1.1].map((x) => cyl(0.5, 0.5, 0.3, DARK, { at: [x, 0.5, z], rot: [0, 0, Math.PI / 2] }, 8)))]),
    ship: group([
      box(8, 3, 34, '#2f4f6f', { at: [0, -1, 0] }),
      box(8.2, 0.4, 34.2, '#c9302c', { at: [0, -1.2, 0] }),
      cone(4, 6, '#2f4f6f', { at: [0, -1, 17], rot: [Math.PI / 2, 0, 0], scale: [1, 1, 0.25] }, 4),
      ...[-8, -2, 4, 10].flatMap((z, i) => [box(7, 2.4, 5.6, CONTAINER[i % 6], { at: [0, 2, z] }), box(7, 2.4, 5.6, CONTAINER[(i + 3) % 6], { at: [0, 4.4, z] })]),
      box(7, 5, 4, '#e8ecf0', { at: [0, 2, -14] }),
      cyl(0.7, 0.8, 3, '#c9302c', { at: [0, 7, -14] }, 8),
    ]),
  };
}
