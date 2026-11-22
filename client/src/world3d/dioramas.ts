// A small 3D diorama of a street in each city, for the city picker: a
// landmark, a few buildings, a cart and some people. Rendered once to a
// picture.
import * as THREE from 'three';
import { box, rbox, cyl, cone, ball, gable, group, awning, shade } from './kit';
import { businessModel } from './models';

const cache = new Map<string, string>();

function person(x: number, z: number, c: string) {
  return group([box(0.5, 1.6, 0.5, '#2c3440', { at: [x, 0, z] }), rbox(1.2, 1.5, 0.8, c, { at: [x, 1.6, z] }, 0.2), rbox(1.0, 0.9, 0.9, '#eac0a0', { at: [x, 3.1, z] }, 0.25)]);
}

function block(x: number, z: number, w: number, d: number, h: number, c: string) {
  const parts = [rbox(w, h, d, c, { at: [x, 0, z] }, 0.4), box(w + 0.3, 0.4, d + 0.3, shade(c, -0.18), { at: [x, h, z] })];
  for (let y = 2; y < h - 1; y += 3) for (let i = -1; i <= 1; i++) parts.push(box(w * 0.18, 1.3, 0.1, '#ffe7b0', { at: [x + i * w * 0.28, y, z + d / 2 + 0.02] }));
  return group(parts);
}

function landmark(city: string): THREE.BufferGeometry {
  switch (city) {
    case 'london': // a clock tower
      return group([
        box(5, 24, 5, '#d9c08a', { at: [0, 0, 0] }),
        box(5.6, 6, 5.6, '#e2cb98', { at: [0, 24, 0] }),
        ...[0, 1, 2, 3].map((i) => cyl(1.9, 1.9, 0.3, '#fff6dc', { at: [Math.sin((i * Math.PI) / 2) * 2.85, 27, Math.cos((i * Math.PI) / 2) * 2.85], rot: [Math.PI / 2, (i * Math.PI) / 2, 0] }, 16)),
        cone(3.6, 9, '#4a5a4a', { at: [0, 30, 0] }, 4),
        cyl(0.2, 0.2, 2, '#c9a227', { at: [0, 38.5, 0] }, 4),
      ]);
    case 'new-york': // a stepped tower with a spire
      return group([box(10, 22, 10, '#c9c3b6'), box(7.5, 10, 7.5, '#d4cec1', { at: [0, 22, 0] }), box(5, 7, 5, '#ddd8cc', { at: [0, 32, 0] }), box(3, 4, 3, '#e8e4dc', { at: [0, 39, 0] }), cyl(0.5, 0.2, 7, '#c0c6cc', { at: [0, 43, 0] }, 6)]);
    case 'tokyo': // a red and white lattice tower
      return group([
        ...[[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([x, z]) => box(0.8, 22, 0.8, '#e3502d', { at: [x * 3.5, 0, z * 3.5], rot: [z * 0.13, 0, -x * 0.13] })),
        box(7, 1.4, 7, '#ffffff', { at: [0, 12, 0] }),
        box(4.5, 2, 4.5, '#e3502d', { at: [0, 21, 0] }),
        cone(2.2, 14, '#e3502d', { at: [0, 23, 0] }, 4),
        box(2.4, 1, 2.4, '#ffffff', { at: [0, 29, 0] }),
      ]);
    case 'singapore': // three towers carrying a long deck
      return group([
        ...[-6, 0, 6].map((x) => box(3.6, 26, 6, '#cfd8de', { at: [x, 0, 0], rot: [0, 0, 0] })),
        rbox(20, 1.6, 7, '#9fb8c4', { at: [0, 26, 0] }, 2),
        ...[-6, 0, 6].flatMap((x) => [4, 9, 14, 19].map((y) => box(3.4, 0.6, 0.1, '#9fd3e6', { at: [x, y, 3.02] }))),
        cone(1.5, 3, '#4a8a3a', { at: [-12, 0, 5] }, 5),
        cone(1.5, 3, '#4a8a3a', { at: [12, 0, 5] }, 5),
      ]);
    case 'paris': // an iron lattice tower
      return group([
        ...[[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([x, z]) => box(1.1, 14, 1.1, '#8a6f58', { at: [x * 5, 0, z * 5], rot: [z * 0.3, 0, -x * 0.3] })),
        box(9, 1.2, 9, '#7a6250', { at: [0, 9, 0] }),
        ...[[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([x, z]) => box(0.7, 14, 0.7, '#8a6f58', { at: [x * 2.2, 9.6, z * 2.2], rot: [z * 0.12, 0, -x * 0.12] })),
        box(4, 0.9, 4, '#7a6250', { at: [0, 22.5, 0] }),
        cone(1.4, 12, '#8a6f58', { at: [0, 23.4, 0] }, 4),
      ]);
    default:
      return box(6, 20, 6, '#c9c3b6');
  }
}

function vehicle(city: string) {
  const c = city === 'london' ? '#c9302c' : city === 'new-york' ? '#f2c14b' : city === 'tokyo' ? '#ffffff' : city === 'singapore' ? '#2f8f6e' : '#3f8ed6';
  if (city === 'london') return group([rbox(2.6, 4.8, 9, c, { at: [0, 0.4, 0] }, 0.6), box(2.65, 0.9, 8.4, '#9fd3e6', { at: [0, 1.8, 0] }), box(2.65, 0.9, 8.4, '#9fd3e6', { at: [0, 3.7, 0] })]);
  return group([rbox(2.0, 1.2, 4.4, c, { at: [0, 0.4, 0] }, 0.4), rbox(1.8, 0.9, 2.4, shade(c, 0.15), { at: [0, 1.6, -0.2] }, 0.35)]);
}

const LAND: Record<string, string> = { london: '#e9e1cf', 'new-york': '#e4ded2', tokyo: '#ece6dc', singapore: '#e2ead8', paris: '#ece2d0' };

export function cityDiorama(city: string): string {
  const hit = cache.get(city);
  if (hit) return hit;
  try {
    const W = 480;
    const H = 260;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const r = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
    r.setClearColor(0x000000, 0);
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight('#fff6e8', '#8a7f6a', 1.35));
    const sun = new THREE.DirectionalLight('#ffe9c8', 2.3);
    sun.position.set(-6, 10, 7);
    scene.add(sun);
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    const parts = [
      rbox(64, 1, 34, LAND[city] ?? '#e9e1cf', { at: [0, -1, 0] }, 3),
      box(64, 0.08, 7, '#ffffff', { at: [0, 0, 7] }),
      box(64, 0.1, 0.4, '#e8b23a', { at: [0, 0.02, 7] }),
      landmark(city).translate(14, 0, -6),
      block(-22, -8, 9, 9, 14, '#e2d6c1'),
      block(-11, -9, 8, 8, 20, '#d9cdb5'),
      block(-1.5, -9, 7, 8, 11, '#efe3cc'),
      block(28, -8, 6, 8, 16, '#dcd0ba'),
      businessModel('cart', 1, 1, 'open').base.clone().scale(1.4, 1.4, 1.4).translate(-6, 0, 3),
      vehicle(city).rotateY(Math.PI / 2).translate(10, 0, 8),
      person(-1, 4, '#3f8ed6'),
      person(-3.2, 5.2, '#e3694d'),
      person(20, 3, '#2f6f5e'),
      person(-18, 4, '#f3c443'),
      ...(city === 'paris' ? [cyl(0.06, 0.06, 2.8, '#ddd', { at: [-16, 0, 2] }, 4), cone(1.8, 0.8, '#c9302c', { at: [-16, 2.6, 2] }, 8)] : []),
      ...(city === 'tokyo' ? [box(0.6, 6, 0.6, '#c9302c', { at: [-28, 0, 2] }), box(0.6, 6, 0.6, '#c9302c', { at: [-23, 0, 2] }), box(7.5, 0.7, 0.9, '#c9302c', { at: [-25.5, 6, 2] }), box(6.5, 0.5, 0.7, '#c9302c', { at: [-25.5, 4.8, 2] })] : []),
      ...(city === 'singapore' ? [ball(2, '#5f9f45', { at: [-28, 3, 3] }), cyl(0.3, 0.4, 3, '#6f4a2a', { at: [-28, 0, 3] }, 5)] : []),
      ...(city === 'new-york' ? [cyl(0.25, 0.25, 4, '#3a3f46', { at: [-28, 0, 4] }, 5), box(1.4, 0.9, 0.2, '#2f8f6e', { at: [-27.4, 3.6, 4] })] : []),
      ...(city === 'london' ? [box(1.2, 2.6, 1.2, '#c9302c', { at: [-28, 0, 4] }), box(1.4, 0.5, 1.4, '#c9302c', { at: [-28, 2.6, 4] })] : []),
      awning(5, 2, ['#2f8f6e', '#f6efe0'], { at: [-1.5, 4.5, -3.5] }),
      gable(9.4, 3, 9.4, '#a4573a', { at: [-22, 14, -8] }),
    ];
    scene.add(new THREE.Mesh(group(parts), mat));
    const cam = new THREE.PerspectiveCamera(26, W / H, 1, 1000);
    cam.position.set(18, 52, 92);
    cam.lookAt(0, 9, -2);
    r.render(scene, cam);
    const url = canvas.toDataURL('image/png');
    r.dispose();
    r.forceContextLoss();
    cache.set(city, url);
    return url;
  } catch {
    return '';
  }
}
