// People: the player character (everyone's), the 14 skins as outfits, and
// the simpler instanced walkers in the crowd. Parts are white where they take
// a per-instance colour (clothes, skin, trousers), so one geometry serves
// every outfit and every walker.
//
// The character is about three times real size (5 m tall) so it reads at
// street zoom. Part origins are at their joints: legs and arms hang from
// y = 0, the torso and head stand on y = 0.
import * as THREE from 'three';
import { box, rbox, ball, cyl, cone, group, torus, sphere } from './kit';

const W = '#ffffff';
const EYE = '#1e1e24';

export const CHAR = {
  hip: 1.9, // leg length
  torso: 1.75,
  shoulderX: 0.98,
  hipX: 0.36,
  neck: 0.05,
  scale: 1,
};

export function charParts() {
  const leg = group([rbox(0.56, 1.85, 0.62, W, { at: [0, -1.85, 0] }), box(0.6, 0.28, 0.82, '#3a3330', { at: [0, -1.9, 0.08] })]);
  const torso = group([
    rbox(1.55, CHAR.torso, 1.0, W, {}, 0.28),
    box(1.62, 0.16, 1.06, W, { at: [0, 0.02, 0] }), // belt line catches light
  ]);
  const arm = group([rbox(0.4, 1.45, 0.44, W, { at: [0, -1.45, 0] }), ball(0.27, W, { at: [0, -1.55, 0] })]); // mitten in the outfit colour
  // Head: skin-tinted block with two eyes and a little smile on the front (+z).
  const head = group([
    rbox(1.28, 1.18, 1.14, W, {}, 0.32),
    box(0.17, 0.24, 0.06, EYE, { at: [-0.27, 0.58, 0.58] }),
    box(0.17, 0.24, 0.06, EYE, { at: [0.27, 0.58, 0.58] }),
    box(0.34, 0.07, 0.05, '#b05a4a', { at: [0, 0.32, 0.58] }),
  ]);
  const hair = group([rbox(1.36, 0.34, 1.2, W, { at: [0, 1.0, -0.04] }, 0.34), box(1.3, 0.55, 0.3, W, { at: [0, 0.5, -0.48] })]);
  return { leg, torso, arm, head, hair };
}

// Outfit details drawn over the torso, tinted with the skin's accent colour.
export function accentParts() {
  return {
    tie: group([box(0.22, 0.95, 0.06, W, { at: [0, 0.55, 0.52] }), box(0.34, 0.2, 0.07, W, { at: [0, 1.48, 0.52] })]),
    vest: group([box(0.42, 1.45, 0.08, W, { at: [-0.5, 0.2, 0.5] }), box(0.42, 1.45, 0.08, W, { at: [0.5, 0.2, 0.5] }), box(1.6, 0.2, 1.08, W, { at: [0, 0.9, 0] })]),
    stripe: group([box(1.6, 0.3, 1.06, W, { at: [0, 0.75, 0] }), box(1.6, 0.18, 1.06, W, { at: [0, 1.25, 0] })]),
    dots: group([0, 1, 2, 3, 4, 5].map((i) => box(0.18, 0.18, 0.05, W, { at: [-0.45 + (i % 3) * 0.45, 0.45 + Math.floor(i / 3) * 0.6, 0.52] }))),
    shine: group([box(0.3, 1.2, 0.05, W, { at: [-0.45, 0.3, 0.52] })]),
    watch: group([box(0.46, 0.16, 0.5, W, { at: [0, -1.1, 0] })]), // worn on the arm
  };
}

// Hats sit on top of the head (head height 1.18).
export function hatParts() {
  const top = 1.15;
  return {
    tophat: group([cyl(0.85, 0.85, 0.08, W, { at: [0, top, 0] }, 12), cyl(0.55, 0.58, 0.95, W, { at: [0, top + 0.08, 0] }, 12), cyl(0.59, 0.59, 0.16, '#c9a227', { at: [0, top + 0.1, 0] }, 12)]),
    hardhat: group([ball(0.72, W, { at: [0, top - 0.05, 0], scale: [1, 0.62, 1] }, 1), cyl(0.85, 0.85, 0.07, W, { at: [0, top - 0.05, 0.1] }, 12)]),
    mortarboard: group([cyl(0.55, 0.62, 0.32, W, { at: [0, top - 0.05, 0] }, 8), box(1.55, 0.08, 1.55, W, { at: [0, top + 0.27, 0], rot: [0, Math.PI / 4, 0] }), box(0.06, 0.55, 0.06, '#f2c14b', { at: [0.62, top - 0.2, 0.2] })]),
    sailor: group([cyl(0.68, 0.7, 0.38, W, { at: [0, top - 0.04, 0] }, 10), box(1.0, 0.07, 0.55, '#1b2a44', { at: [0, top - 0.02, 0.55] })]),
    cap: group([ball(0.7, W, { at: [0, top - 0.06, 0], scale: [1, 0.5, 1] }, 1), box(0.95, 0.07, 0.65, W, { at: [0, top, 0.62] })]),
    beanie: group([ball(0.72, W, { at: [0, top - 0.12, 0], scale: [1, 0.7, 1] }, 1), ball(0.18, W, { at: [0, top + 0.42, 0] })]),
    crown: group([cyl(0.6, 0.6, 0.35, W, { at: [0, top, 0] }, 8), ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => cone(0.13, 0.32, W, { at: [Math.cos((i / 8) * Math.PI * 2) * 0.55, top + 0.33, Math.sin((i / 8) * Math.PI * 2) * 0.55] }, 4))]),
  };
}

// The 14 skins as outfits (ids unchanged, so nobody loses one).
export interface Outfit { body: string; accent: string; legs: string; acc?: keyof ReturnType<typeof accentParts>; hat?: keyof ReturnType<typeof hatParts>; hatColor?: string; hair?: string; watch?: boolean }
export const OUTFITS: Record<string, Outfit> = {
  classic: { body: '#2f6f5e', accent: '#f2c14b', legs: '#2c3440', acc: 'tie', hair: '#3b2a20' },
  mint: { body: '#5cc8a6', accent: '#ffffff', legs: '#3d4f6b', acc: 'stripe', hair: '#c98a4a' },
  coral: { body: '#e3694d', accent: '#ffe2b3', legs: '#3b3f4a', acc: 'stripe', hat: 'cap', hatColor: '#ffe2b3', hair: '#2b1d17' },
  sky: { body: '#3f8ed6', accent: '#e3f2ff', legs: '#e8e2cf', acc: 'tie', hair: '#d9b56a' },
  sunny: { body: '#f3c443', accent: '#7a4b00', legs: '#5a4630', acc: 'dots', hat: 'beanie', hatColor: '#e3694d', hair: '#3b2a20' },
  night: { body: '#2b2f4a', accent: '#9aa7ff', legs: '#1d1f2e', acc: 'stripe', hair: '#111118' },
  sprout: { body: '#7cb34a', accent: '#f4f9e8', legs: '#5a4630', acc: 'dots', hat: 'beanie', hatColor: '#4f8a2c', hair: '#8c5a30' },
  graduate: { body: '#1d1d2b', accent: '#f2c14b', legs: '#1d1d2b', acc: 'tie', hat: 'mortarboard', hatColor: '#1d1d2b' },
  hardhat: { body: '#5a6a7a', accent: '#f2e23a', legs: '#2c3a4a', acc: 'vest', hat: 'hardhat', hatColor: '#f2a12b' },
  captain: { body: '#1f3f73', accent: '#ffffff', legs: '#ffffff', acc: 'stripe', hat: 'sailor', hatColor: '#ffffff' },
  tycoon: { body: '#134d3b', accent: '#f2c14b', legs: '#16231e', acc: 'tie', hat: 'tophat', hatColor: '#141414', watch: true },
  gilded: { body: '#d8a531', accent: '#fff3c4', legs: '#b8862a', acc: 'shine', hat: 'crown', hatColor: '#f2c14b', watch: true },
  neon: { body: '#b03ad6', accent: '#47f5d0', legs: '#2b1d3a', acc: 'dots', hat: 'cap', hatColor: '#47f5d0', hair: '#47f5d0' },
  marble: { body: '#e8e4dc', accent: '#8c8579', legs: '#6a645a', acc: 'stripe', hair: '#6a645a' },
};

export const SKIN_TONES = ['#f6d7bf', '#eac0a0', '#d9a07a', '#b97c55', '#8d5a3b', '#6a412a'];

// ---------- crowd walkers ----------
// Three body shapes, each in one merged geometry: clothes (tinted), with a
// small fixed-colour face. Legs and heads are separate so they can be tinted
// and swung.
export function walkerParts() {
  const s = 0.82; // walkers are a touch smaller than player characters
  const body = (w: number, h: number, coat: boolean) =>
    group([rbox(w, h, 0.9, W, {}, 0.25), coat ? box(w + 0.1, 0.7, 0.95, W, { at: [0, -0.5, 0] }) : null, box(0.36, 1.2, 0.4, W, { at: [-w / 2 - 0.2, h - 1.25, 0] }), box(0.36, 1.2, 0.4, W, { at: [w / 2 + 0.2, h - 1.25, 0] })], { scale: [s, s, s] });
  const head = group([rbox(1.1, 1.0, 1.0, W, {}, 0.3), box(0.15, 0.2, 0.05, EYE, { at: [-0.24, 0.5, 0.51] }), box(0.15, 0.2, 0.05, EYE, { at: [0.24, 0.5, 0.51] })], { scale: [s, s, s] });
  const leg = group([rbox(0.5, 1.7, 0.56, W, { at: [0, -1.7, 0] })], { scale: [s, s, s] });
  const hair = group([rbox(1.16, 0.3, 1.06, W, { at: [0, 0.86, -0.03] }, 0.3), box(1.1, 0.45, 0.25, W, { at: [0, 0.45, -0.42] })], { scale: [s, s, s] });
  return {
    bodies: [body(1.45, 1.65, false), body(1.7, 1.55, false), body(1.45, 1.8, true)],
    head,
    leg,
    hair,
    scale: s,
  };
}

// The crowd: round blobs with big eyes that bounce along (one merged
// geometry each, tinted per person; the eyes keep their own colour).
// Origin at the bottom centre.
export function blobParts() {
  const eye = (x: number) => group([sphere(0.26, '#ffffff', { at: [x, 1.55, 0.98], scale: [1, 1.15, 0.6] }, 8, 6), sphere(0.13, EYE, { at: [x, 1.55, 1.12], scale: [1, 1.15, 0.6] }, 6, 4)]);
  const body = group([
    sphere(1.15, W, { at: [0, 1.15, 0], scale: [1, 1.05, 1] }, 14, 10),
    eye(-0.36),
    eye(0.36),
    rbox(0.5, 0.08, 0.1, '#7a3a2a', { at: [0, 1.08, 1.12] }, 0.03), // a little smile
  ]);
  return { body };
}

// Things people carry after buying.
export function carryParts() {
  return {
    bag: group([box(0.75, 0.8, 0.4, W), box(0.5, 0.25, 0.05, W, { at: [0, 0.8, 0] })]),
    cup: group([cyl(0.22, 0.17, 0.55, W, {}, 8), cyl(0.24, 0.24, 0.08, '#e3694d', { at: [0, 0.52, 0] }, 8)]),
    umbrella: group([cyl(0.04, 0.04, 2.3, '#3a3a3a', {}, 4), cone(1.4, 0.55, W, { at: [0, 2.0, 0] }, 8)]),
  };
}

// The net-worth ring on the ground and the player's gold "mine" marker.
export function groundParts() {
  return {
    ring: torus(1.45, 0.13, W, { rot: [Math.PI / 2, 0, 0], at: [0, 0.08, 0] }, 24),
    ring2: torus(1.85, 0.08, W, { rot: [Math.PI / 2, 0, 0], at: [0, 0.08, 0] }, 24),
  };
}

export function blobShadow() {
  const g = new THREE.CircleGeometry(1, 16);
  g.rotateX(-Math.PI / 2);
  g.translate(0, 0.04, 0);
  return g;
}
