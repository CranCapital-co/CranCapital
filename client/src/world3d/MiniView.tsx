// A small live 3D view at the top of the Business window: a cutaway of a
// shop's room ("peek inside"), or the business's own model turning slowly.
// Drawn by the one shared off-screen renderer, only while visible.
//
// The room is laid out the way a real one would be, whatever order the
// fit-out tiles were placed in: the working kit against the back wall, the
// service counter in a straight line, tables in tidy rows, booths along the
// wall, shelves in aisles, plants in the corners, art on the walls and lamps
// over the tables. A few blob staff and customers when it's open.
import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { offscreen, drawInto } from './offscreen';
import { businessModel, TIER_COLORS, type BizState } from './models';
import { box, cyl, ball, group, rbox, cone, sphere } from './kit';
import { reducedMotion } from '../lib/settings';

type Cat = 'cafe' | 'restaurant' | 'grocery' | 'furniture' | 'electronics' | 'bank';
const CATS: Record<string, Cat> = { cafe: 'cafe', restaurant: 'restaurant', grocery: 'grocery', furniture_store: 'furniture', electronics_store: 'electronics', bank: 'bank' };

// Floors and walls that suit each kind of shop.
const LOOK: Record<Cat, { floor: [string, string]; wall: string; side: string }> = {
  cafe: { floor: ['#d9b88c', '#cfa877'], wall: '#f6efe0', side: '#efe3cf' },
  restaurant: { floor: ['#9a6a45', '#8c5f3d'], wall: '#f3e6d6', side: '#e9d8c4' },
  grocery: { floor: ['#eef0f2', '#e1e5e9'], wall: '#f4f7f5', side: '#e8efec' },
  furniture: { floor: ['#e8e0d4', '#ddd3c4'], wall: '#f7f3ec', side: '#ece5da' },
  electronics: { floor: ['#e6e9ee', '#dbe0e7'], wall: '#f5f7fa', side: '#e7ebf1' },
  bank: { floor: ['#efece6', '#e2ddd3'], wall: '#f7f4ee', side: '#ebe5da' },
};

const WOOD = '#b07a42';
const DARK = '#3a3f46';

function fitoutPiece(id: string, accent: string, cat: Cat): THREE.BufferGeometry {
  switch (id) {
    case 'counter':
      if (cat === 'grocery') // a checkout: belt, till and a bagging end
        return group([rbox(1.1, 0.85, 0.6, '#d9dde2', {}, 0.06), box(0.75, 0.05, 0.42, '#2b2f33', { at: [-0.12, 0.85, 0] }), box(0.26, 0.3, 0.22, DARK, { at: [0.38, 0.85, -0.12] }), box(0.2, 0.14, 0.03, '#7fd1e8', { at: [0.38, 1.05, -0.0] })]);
      return group([rbox(1.2, 0.95, 0.65, cat === 'bank' ? '#7a5636' : WOOD, {}, 0.04), box(1.22, 0.07, 0.72, cat === 'bank' ? '#e9e4da' : '#f6efe0', { at: [0, 0.95, 0] }), box(1.2, 0.12, 0.04, accent, { at: [0, 0.6, 0.33] }), box(0.28, 0.22, 0.2, DARK, { at: [0.3, 1.02, -0.1] })]);
    case 'table2':
      return group([cyl(0.36, 0.36, 0.05, '#ffffff', { at: [0, 0.74, 0] }, 14), cyl(0.04, 0.04, 0.74, DARK, {}, 6), cyl(0.18, 0.2, 0.03, DARK, {}, 10), ...[-1, 1].map((s) => chair(s * 0.55, 0, s > 0 ? -Math.PI / 2 : Math.PI / 2, accent))]);
    case 'table4':
      return group([box(0.9, 0.05, 0.9, '#ffffff', { at: [0, 0.74, 0] }), cyl(0.05, 0.05, 0.74, DARK, {}, 6), box(0.5, 0.03, 0.5, DARK), ...[[-1, 0, Math.PI / 2], [1, 0, -Math.PI / 2], [0, -1, 0], [0, 1, Math.PI]].map(([x, z, r]) => chair(x * 0.62, z * 0.62, r, accent))]);
    case 'booth':
      return group([box(1.15, 0.45, 0.5, '#9b2d2d', { at: [0, 0, -0.3] }), box(1.15, 0.72, 0.14, '#9b2d2d', { at: [0, 0.45, -0.5] }), box(0.95, 0.05, 0.55, '#ffffff', { at: [0, 0.74, 0.22] }), cyl(0.05, 0.05, 0.74, DARK, { at: [0, 0, 0.22] }, 6)]);
    case 'kitchen':
      return group([box(1.15, 0.9, 0.75, '#c0c6cc'), box(1.15, 0.05, 0.75, DARK, { at: [0, 0.9, 0] }), cyl(0.2, 0.18, 0.28, '#8d99a6', { at: [-0.25, 0.95, 0] }, 10), cyl(0.18, 0.18, 0.1, '#8d99a6', { at: [0.28, 0.95, 0] }, 10), box(1.0, 0.5, 0.35, '#a9b1b9', { at: [0, 1.75, -0.2] })]);
    case 'coffee_machine':
      return group([box(1.15, 0.9, 0.7, WOOD), box(1.17, 0.05, 0.72, '#f6efe0', { at: [0, 0.9, 0] }), rbox(0.6, 0.5, 0.42, '#c0c6cc', { at: [-0.15, 0.95, -0.05] }, 0.06), box(0.5, 0.06, 0.3, DARK, { at: [-0.15, 1.45, -0.05] }), cyl(0.06, 0.05, 0.1, '#ffffff', { at: [0, 0.96, 0.22] }, 8), cyl(0.06, 0.05, 0.1, '#ffffff', { at: [-0.3, 0.96, 0.22] }, 8), cyl(0.12, 0.1, 0.3, '#6b4a2f', { at: [0.38, 0.95, 0] }, 8)]);
    case 'shelf': {
      const goods = cat === 'electronics' ? ['#2b2f33', '#5a6470', '#d6dbe0', '#3f8ed6'] : cat === 'furniture' ? ['#c96f4a', '#e6d3b3', '#7a9a6a', '#8c6a4a'] : ['#e5533d', '#7cc35a', '#f4cf3f', '#3f8ed6'];
      return group([box(1.1, 1.8, 0.42, WOOD), box(1.06, 1.7, 0.02, '#f1e6d2', { at: [0, 0.05, 0.2] }), ...[0.12, 0.55, 1.0, 1.42].flatMap((y, i) => [box(1.06, 0.04, 0.4, '#8c5f36', { at: [0, y - 0.04, 0.02] }), ...[0, 1, 2, 3].map((k) => box(0.2, 0.26, 0.24, goods[(k + i) % 4], { at: [-0.36 + k * 0.24, y, 0.06] }))])]);
    }
    case 'fridge':
      return group([rbox(1.05, 1.95, 0.75, '#f1f4f6', {}, 0.06), box(0.9, 1.45, 0.04, '#9fd3e6', { at: [0, 0.3, 0.37] }), ...[0.55, 1.0, 1.45].map((y, i) => box(0.8, 0.18, 0.3, ['#e5533d', '#f4cf3f', '#7cc35a'][i], { at: [0, y, 0.1] })), box(1.05, 0.2, 0.75, accent, { at: [0, 1.95, 0] })]);
    case 'display':
      if (cat === 'furniture') // a sofa on a rug
        return group([box(1.5, 0.02, 1.1, '#d8c7a6'), rbox(1.25, 0.4, 0.55, '#6f8fa8', { at: [0, 0.02, 0.05] }, 0.08), rbox(1.25, 0.45, 0.18, '#5f7f98', { at: [0, 0.4, -0.2] }, 0.05), rbox(0.15, 0.55, 0.55, '#5f7f98', { at: [-0.62, 0.02, 0.05] }, 0.05), rbox(0.15, 0.55, 0.55, '#5f7f98', { at: [0.62, 0.02, 0.05] }, 0.05), cyl(0.18, 0.18, 0.04, WOOD, { at: [0, 0.38, 0.55] }, 10)]);
      if (cat === 'electronics') // a table of screens and laptops
        return group([box(1.3, 0.8, 0.7, '#f5f7fa'), box(0.62, 0.42, 0.05, '#1e2328', { at: [-0.3, 0.82, -0.2] }), box(0.5, 0.33, 0.03, '#4fb3e8', { at: [-0.3, 0.86, -0.17] }), box(0.42, 0.02, 0.3, '#c9ced4', { at: [0.3, 0.8, 0.1] }), box(0.42, 0.28, 0.02, '#2b2f33', { at: [0.3, 0.8, -0.05], rot: [-0.3, 0, 0] })]);
      if (cat === 'grocery') // a fruit and veg stand
        return group([box(1.2, 0.6, 0.8, WOOD), ...[-0.4, 0, 0.4].flatMap((x, i) => [box(0.36, 0.12, 0.7, '#8c5f36', { at: [x, 0.6, 0] }), ...[-0.2, 0.05, 0.25].map((z) => ball(0.09, ['#e5533d', '#f4cf3f', '#7cc35a'][i], { at: [x, 0.78, z] }, 1))])]);
      return group([box(1.2, 0.85, 0.65, WOOD), box(1.15, 0.45, 0.6, '#d7f0f6', { at: [0, 0.85, 0] }), ...[-0.35, 0, 0.35].map((x, i) => cyl(0.13, 0.13, 0.14, ['#e8a93a', '#c96f4a', '#f3d9e0'][i], { at: [x, 0.88, 0] }, 10))]);
    case 'plant':
      return group([cyl(0.24, 0.19, 0.45, '#c96f4a', {}, 10), ball(0.4, '#5f9f45', { at: [0, 0.8, 0] }, 1), ball(0.3, '#6faf55', { at: [0.14, 1.1, 0.05] }, 1), ball(0.26, '#4f8f3a', { at: [-0.15, 1.05, -0.05] }, 1)]);
    case 'art': // hung on a wall: frame faces +z, centred at y = 0
      return group([box(1.0, 0.75, 0.05, '#5e4630', { at: [0, -0.375, 0] }), box(0.86, 0.6, 0.06, accent, { at: [0, -0.3, 0] }), box(0.4, 0.3, 0.07, '#f4cf3f', { at: [-0.12, -0.18, 0] })]);
    case 'lighting': // a pendant lamp hanging from the ceiling
      return group([cyl(0.012, 0.012, 0.95, DARK, { at: [0, 1.85, 0] }, 4), cone(0.3, 0.28, '#2f6f5e', { at: [0, 2.13, 0], rot: [Math.PI, 0, 0] }, 12), ball(0.1, '#fff3c4', { at: [0, 1.83, 0] }, 1)]);
    case 'safe':
      return group([rbox(1.1, 1.6, 0.8, '#4a4f55', {}, 0.08), cyl(0.22, 0.22, 0.06, '#e8b23a', { at: [0, 0.85, 0.42], rot: [Math.PI / 2, 0, 0] }, 14), box(0.06, 0.4, 0.04, '#c0c6cc', { at: [0.4, 0.65, 0.41] })]);
    default:
      return box(0.6, 0.6, 0.6, accent);
  }
}

function chair(x: number, z: number, r: number, color: string) {
  // Seat and back; the back sits on the far side from the table.
  const g = group([box(0.36, 0.05, 0.36, color, { at: [0, 0.44, 0] }), box(0.36, 0.42, 0.05, color, { at: [0, 0.46, 0.16] }), ...[[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([a, b]) => box(0.04, 0.44, 0.04, DARK, { at: [a * 0.15, 0, b * 0.15] }))]);
  g.rotateY(r + Math.PI);
  g.translate(x, 0, z);
  return g;
}

interface Spot { id: string; x: number; z: number; r?: number; y?: number }
interface Person { x: number; z: number; y: number; r: number; seated?: boolean }


// Lay a room out like a real one from the items it has (their tiles don't
// matter: only how many of each). z runs from the back wall (0) forward.
export function arrange(fitout: (string | null)[], cat: Cat) {
  const n: Record<string, number> = {};
  for (const id of fitout) if (id) n[id] = (n[id] ?? 0) + 1;
  // A cosier room for a small fit-out. x runs from the left wall to the open side.
  const W = fitout.filter(Boolean).length <= 6 ? 7.5 : 10;
  const take = (id: string) => {
    const k = n[id] ?? 0;
    n[id] = 0;
    return k;
  };
  const L = -W / 2;
  const R = W / 2;
  const spots: Spot[] = [];
  const people: Person[] = [];
  const anchors: { x: number; z: number }[] = []; // where pendant lamps look good
  let z = 0;

  // 1. The working kit along the back wall.
  const back: string[] = [];
  const add = (id: string, k: number) => {
    for (let i = 0; i < k; i++) back.push(id);
  };
  add('safe', take('safe'));
  add('kitchen', take('kitchen'));
  add('coffee_machine', take('coffee_machine'));
  add('fridge', take('fridge'));
  if (cat !== 'grocery') add('shelf', take('shelf'));
  const PER = Math.floor((W - 1) / 1.2);
  // Behind the counter (from the open side); a grocer's chillers from the wall.
  const fromWall = cat === 'grocery';
  back.forEach((id, i) => spots.push({ id, x: fromWall ? L + 0.85 + (i % PER) * 1.2 : R - 0.85 - (i % PER) * 1.2, z: 0.48 + Math.floor(i / PER) * 1.15 }));
  if (back.length) z = 0.48 + (Math.ceil(back.length / PER) - 1) * 1.15 + 0.45;

  // 2. The service counter: one straight run from the open side, with the
  //    cake case or display beside it. Staff stand behind it.
  const line: string[] = [];
  if (cat !== 'grocery') {
    for (let i = take('counter'); i > 0; i--) line.push('counter');
    if (cat === 'cafe' || cat === 'restaurant' || cat === 'bank') for (let i = take('display'); i > 0; i--) line.push('display');
  }
  let lineLeft = R;
  if (line.length) {
    z += back.length ? 0.95 : 0.6; // room for the staff
    const rows = Math.ceil(line.length / PER);
    line.forEach((id, i) => {
      const x = R - 0.8 - (i % PER) * 1.22;
      const zz = z + 0.35 + Math.floor(i / PER) * 1.6;
      spots.push({ id, x, z: zz });
      lineLeft = Math.min(lineLeft, x - 0.6);
      if (id === 'counter' && i < 3) people.push({ x, z: zz - 0.75, y: 0, r: 0 });
    });
    anchors.push(...line.slice(0, 3).map((_, i) => ({ x: R - 0.8 - i * 1.22, z: z + 0.35 })));
    z += 0.35 + (rows - 1) * 1.6 + 0.35;
    if (cat !== 'bank') people.push({ x: R - 0.8, z: z + 0.55, y: 0, r: Math.PI }, { x: R - 0.8, z: z + 1.15, y: 0, r: Math.PI }); // a little queue
  }

  // 3. The shop floor.
  if (cat === 'grocery') {
    const k = take('shelf');
    if (k) {
      z += 1.0;
      const cols = Math.min(6, Math.max(1, Math.ceil(k / 3)));
      const per = Math.ceil(k / cols);
      const gap = 1.55;
      const x0 = -((cols - 1) * gap) / 2 - 0.5;
      for (let i = 0; i < k; i++) {
        const c = Math.floor(i / per);
        spots.push({ id: 'shelf', x: x0 + c * gap, z: z + 0.6 + (i % per) * 1.12, r: Math.PI / 2 });
      }
      if (k > 1) people.push({ x: x0 + 0.75, z: z + 1.2, y: 0, r: -Math.PI / 2 });
      z += per * 1.12 + 0.2;
    }
  }
  const nd = take('display');
  if (nd) {
    z += 1.0;
    const cols = Math.min(4, nd);
    const sx = 2.1;
    const x0 = -((cols - 1) * sx) / 2 + 0.4;
    for (let i = 0; i < nd; i++) {
      const p = { x: x0 + (i % cols) * sx, z: z + 0.6 + Math.floor(i / cols) * 1.8 };
      spots.push({ id: 'display', ...p });
      anchors.push(p);
      if (i === 0) people.push({ x: p.x + 0.9, z: p.z + 0.4, y: 0, r: -Math.PI / 2 });
    }
    z += Math.ceil(nd / cols) * 1.8;
  }
  if (cat === 'grocery') {
    const k = take('counter');
    if (k) {
      z += 0.9;
      for (let i = 0; i < k; i++) {
        const x = R - 0.9 - (i % 5) * 1.75;
        const zz = z + 0.4 + Math.floor(i / 5) * 1.4;
        spots.push({ id: 'counter', x, z: zz });
        if (i < 3) people.push({ x: x + 0.3, z: zz - 0.65, y: 0, r: 0 });
      }
      z += 0.4 + Math.floor((k - 1) / 5) * 1.4 + 0.5;
    }
  }

  // 4. Dining: booths along the wall, tables in tidy rows.
  const nb = take('booth');
  const t4 = take('table4');
  const t2 = take('table2');
  if (nb || t4 || t2) {
    z += 1.0;
    const z0 = z;
    for (let i = 0; i < nb; i++) {
      const p = { x: L + 0.58, z: z0 + 0.65 + i * 1.3 };
      spots.push({ id: 'booth', ...p, r: Math.PI / 2 });
      anchors.push({ x: p.x + 0.22, z: p.z });
      if (i % 2 === 0) people.push({ x: L + 0.42, z: p.z, y: 0.42, r: Math.PI / 2, seated: true });
    }
    const boothDepth = nb ? nb * 1.3 + 0.3 : 0;
    const xmin = L + (nb ? 2.0 : 0.9);
    const xmax = R - 0.8;
    let zz = z0;
    let seat = 0;
    const rowOf = (id: string, count: number, s: number) => {
      const per = Math.max(1, Math.floor((xmax - xmin) / s) + 1);
      for (let i = 0; i < count; i += per) {
        const k = Math.min(per, count - i);
        const off = xmin + (xmax - xmin - (k - 1) * s) / 2;
        for (let j = 0; j < k; j++) {
          const p = { x: off + j * s, z: zz + s / 2 };
          spots.push({ id, ...p });
          anchors.push(p);
          if (seat++ % 2 === 0) people.push({ x: p.x - (id === 'table4' ? 0.62 : 0.55), z: p.z, y: 0.47, r: -Math.PI / 2, seated: true });
        }
        zz += s;
      }
    };
    rowOf('table4', t4, 1.95);
    rowOf('table2', t2, 1.6);
    z = z0 + Math.max(boothDepth, zz - z0);
  }

  // Anything else goes in a neat row at the front.
  const rest = Object.entries(n).filter(([id, k]) => k > 0 && !['plant', 'art', 'lighting'].includes(id));
  if (rest.length) {
    z += 0.8;
    let i = 0;
    for (const [id, k] of rest) for (let j = 0; j < k; j++, i++) spots.push({ id, x: L + 0.9 + (i % PER) * 1.25, z: z + Math.floor(i / PER) * 1.25 });
    z += Math.ceil(i / PER) * 1.25;
    for (const [id] of rest) n[id] = 0;
  }

  // 5. Decor. Plants in the corners and by the counter, then along the front.
  const plants = take('plant');
  const depth = Math.ceil(Math.max(5, z + (plants ? 1.1 : 0.6)) / 1.25) * 1.25;
  const slots = [
    { x: L + 0.45, z: depth - 0.45 },
    { x: R - 0.45, z: depth - 0.45 },
    ...(back.length < PER - 1 ? [fromWall ? { x: R - 0.45, z: 0.45 } : { x: L + 0.45, z: 0.45 }] : []),
    ...(line.length ? [{ x: lineLeft - 0.1, z: spots.find((s) => s.id === line[0])!.z }] : []),
  ];
  for (let x = L + 1.6; x < R - 1.2; x += 1.35) slots.push({ x, z: depth - 0.45 });
  for (let i = 0; i < Math.min(plants, slots.length); i++) spots.push({ id: 'plant', ...slots[i] });

  // Art on the left wall, then the back wall.
  const art = take('art');
  const wallSpots: Spot[] = [];
  for (let zz = 1.4; zz < depth - 0.6; zz += 1.55) wallSpots.push({ id: 'art', x: L + 0.04, z: zz, r: Math.PI / 2, y: 2.05 });
  for (let x = R - 1.2; x > L + 1; x -= 1.6) wallSpots.push({ id: 'art', x, z: 0.04, y: 2.45 });
  spots.push(...wallSpots.slice(0, art));

  // Pendant lamps over tables and counters.
  const lamps = take('lighting');
  for (let i = 0; i < lamps; i++) {
    const a = anchors[i] ?? { x: L + 1.2 + (i - anchors.length) * 1.4, z: depth - 1.2 };
    spots.push({ id: 'lighting', x: a.x, z: a.z });
  }
  return { spots, people, depth, W };
}

function blobGeo(color: string) {
  const eye = (x: number) => group([sphere(0.085, '#ffffff', { at: [x, 0.52, 0.31], scale: [1, 1.15, 0.6] }, 8, 6), sphere(0.045, '#1e1e24', { at: [x, 0.52, 0.36], scale: [1, 1.15, 0.6] }, 6, 4)]);
  return group([sphere(0.38, color, { at: [0, 0.38, 0], scale: [1, 1.06, 1] }, 14, 10), eye(-0.12), eye(0.12)]);
}
const BLOB_COLORS = ['#ff8a5c', '#5cb8ff', '#ffd25c', '#8ad66b', '#c58aff', '#ff6f91', '#4fd1c5'];

function roomGeometry(fitout: (string | null)[], tier: number, cat: Cat) {
  const accent = TIER_COLORS[tier] ?? '#2f8f6e';
  const look = LOOK[cat];
  const { spots, people, depth, W } = arrange(fitout, cat);
  const parts: THREE.BufferGeometry[] = [];
  const T = 1.25;
  for (let r = 0; r < depth / T; r++)
    for (let c = 0; c < W / T; c++) parts.push(box(T - 0.02, 0.1, T - 0.02, look.floor[(r + c) % 2], { at: [-W / 2 + (c + 0.5) * T, -0.1, (r + 0.5) * T] }));
  // Back and left walls; the front and right are cut away so you can see in.
  parts.push(
    box(W + 0.3, 2.9, 0.15, look.wall, { at: [0, -0.1, -0.08] }),
    box(0.15, 2.9, depth, look.side, { at: [-W / 2 - 0.08, -0.1, depth / 2] }),
    box(W + 0.3, 0.3, 0.18, accent, { at: [0, 2.5, -0.06] }),
    box(W + 0.3, 0.14, 0.2, '#ffffff', { at: [0, -0.02, 0.02] }), // skirting
    box(0.2, 0.14, depth, '#ffffff', { at: [-W / 2 + 0.02, -0.02, depth / 2] })
  );
  // A menu board over the counter in cafés and restaurants.
  if ((cat === 'cafe' || cat === 'restaurant') && spots.some((s) => s.id === 'counter'))
    parts.push(box(2.4, 0.9, 0.06, '#2b2f33', { at: [W / 2 - 1.8, 1.55, 0.04] }), ...[0, 1, 2].map((i) => box(1.7, 0.05, 0.07, '#f6efe0', { at: [W / 2 - 1.8, 2.22 - i * 0.22, 0.05] })));
  for (const s of spots) {
    const g = fitoutPiece(s.id, accent, cat).clone();
    if (s.r) g.rotateY(s.r);
    g.translate(s.x, s.y ?? 0, s.z);
    parts.push(g);
  }
  const geo = group(parts);
  geo.translate(0, 0, -depth / 2);
  return { geo, people: people.map((p) => ({ ...p, z: p.z - depth / 2 })) };
}

export default function MiniView({ kind, tier, level, status, fitout, height = 170 }: { kind: string; tier: number; level: number; status: string; fitout?: (string | null)[] | null; height?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const key = JSON.stringify([kind, tier, level, status, fitout]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Drawn by the one shared off-screen renderer into a plain canvas (no
    // WebGL context of its own: iPads only allow a few).
    if (!offscreen()) return; // no WebGL: the window works without the picture
    const canvas = document.createElement('canvas');
    canvas.style.display = 'block';
    el.appendChild(canvas);
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight('#fff6e8', '#8a7f6a', 1.35));
    const sun = new THREE.DirectionalLight('#fff1d6', 2.2);
    sun.position.set(-3, 8, 5);
    scene.add(sun);
    const solid = new THREE.MeshLambertMaterial({ vertexColors: true });
    const glow = new THREE.MeshBasicMaterial({ vertexColors: true, color: new THREE.Color(0.65, 0.65, 0.65) });
    const cat = CATS[kind];
    const room = !!cat; // a room business always shows its room, even before the fit-out
    const obj = new THREE.Group();
    const blobs: { mesh: THREE.Mesh; y: number; phase: number; seated?: boolean }[] = [];
    const geos: THREE.BufferGeometry[] = [];
    if (room) {
      const r = roomGeometry(fitout ?? [], tier, cat);
      geos.push(r.geo);
      obj.add(new THREE.Mesh(r.geo, solid));
      if (status === 'open') {
        r.people.forEach((p, i) => {
          const g = blobGeo(BLOB_COLORS[i % BLOB_COLORS.length]);
          geos.push(g);
          const m = new THREE.Mesh(g, solid);
          m.position.set(p.x, p.y, p.z);
          m.rotation.y = p.r;
          obj.add(m);
          blobs.push({ mesh: m, y: p.y, phase: i * 1.7, seated: p.seated });
        });
      }
    } else {
      const st: BizState = status === 'open' ? 'open' : status === 'abandoned' ? 'abandoned' : status === 'depleted' ? 'depleted' : 'closed';
      const m = businessModel(kind, tier, level, st);
      obj.add(new THREE.Mesh(m.base, solid));
      if (m.glow) obj.add(new THREE.Mesh(m.glow, glow));
      for (const mp of m.moving) {
        const g = new THREE.Mesh(mp.geo, solid);
        g.position.set(...mp.at);
        obj.add(g);
      }
      const disc = new THREE.Mesh(new THREE.CircleGeometry(m.radius * 1.15, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: '#000000', transparent: true, opacity: 0.08 }));
      obj.add(disc);
    }
    scene.add(obj);
    const bb = new THREE.Box3().setFromObject(obj);
    const sphere = bb.getBoundingSphere(new THREE.Sphere());
    const cam = new THREE.PerspectiveCamera(30, 1, 0.1, 2000);
    let cw = el.clientWidth || 300;
    const resize = () => {
      cw = el.clientWidth || 300;
      canvas.style.width = '100%';
      canvas.style.height = height + 'px';
      cam.aspect = cw / height;
      cam.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    let raf = 0;
    let last = 0;
    let visible = true;
    const io = new IntersectionObserver(([e]) => (visible = e.isIntersecting));
    io.observe(el);
    const still = reducedMotion();
    const draw = (t: number) => {
      raf = requestAnimationFrame(draw);
      if (!visible || document.hidden || t - last < 50) return;
      last = t;
      const a = still ? 0.5 : room ? 0.5 + Math.sin(t / 2600) * 0.35 : t / 4000;
      if (!still)
        for (const b of blobs) {
          // Little hops in the queue; a gentle bob when sitting.
          const h = Math.abs(Math.sin(t / 260 + b.phase));
          b.mesh.position.y = b.y + (b.seated ? h * 0.03 : h * 0.14);
          b.mesh.scale.set(1 + (1 - h) * 0.06, 1 - (1 - h) * 0.08, 1 + (1 - h) * 0.06);
        }
      const dist = sphere.radius / Math.sin((15 * Math.PI) / 180) * (room ? 0.66 : 0.62);
      cam.position.set(sphere.center.x + Math.sin(a) * dist, sphere.center.y + dist * (room ? 0.75 : 0.55), sphere.center.z + Math.cos(a) * dist);
      cam.lookAt(sphere.center);
      drawInto(canvas, scene, cam, cw, height);
      if (still) cancelAnimationFrame(raf);
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      solid.dispose();
      glow.dispose();
      for (const g of geos) g.dispose();
      canvas.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, height]);
  return <div ref={ref} className="mini-view" aria-hidden />;
}
