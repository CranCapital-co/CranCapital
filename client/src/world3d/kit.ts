// A tiny modelling kit: chunky low-poly parts with flat vertex colours,
// merged into one geometry per model so everything shares one material (few
// draw calls on iPad). Units are metres; y is up; models face +z (south)
// unless rotated.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export type Color = string | number;

export interface PartOpts {
  at?: [number, number, number];
  rot?: [number, number, number]; // radians, XYZ
  scale?: [number, number, number];
}

const tmpColor = new THREE.Color();

function finish(g: THREE.BufferGeometry, color: Color, o: PartOpts = {}): THREE.BufferGeometry {
  let geo = g.index ? g.toNonIndexed() : g;
  geo.deleteAttribute('uv');
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(...(o.rot ?? [0, 0, 0])));
  m.compose(new THREE.Vector3(...(o.at ?? [0, 0, 0])), q, new THREE.Vector3(...(o.scale ?? [1, 1, 1])));
  geo.applyMatrix4(m);
  geo.computeVertexNormals();
  tmpColor.set(color); // Three converts the sRGB hex to linear itself
  const n = geo.getAttribute('position').count;
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    c[i * 3] = tmpColor.r;
    c[i * 3 + 1] = tmpColor.g;
    c[i * 3 + 2] = tmpColor.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return geo;
}

// Box sitting on y=0 at its centre (at gives the centre of the base).
export function box(w: number, h: number, d: number, color: Color, o: PartOpts = {}) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(0, h / 2, 0);
  return finish(g, color, o);
}

// Box with bevelled vertical edges: reads as "rounded" at street zoom.
export function rbox(w: number, h: number, d: number, color: Color, o: PartOpts = {}, bevel = Math.min(w, d) * 0.18) {
  const s = new THREE.Shape();
  const x = w / 2;
  const z = d / 2;
  const b = Math.min(bevel, x * 0.9, z * 0.9);
  s.moveTo(-x + b, -z);
  s.lineTo(x - b, -z);
  s.lineTo(x, -z + b);
  s.lineTo(x, z - b);
  s.lineTo(x - b, z);
  s.lineTo(-x + b, z);
  s.lineTo(-x, z - b);
  s.lineTo(-x, -z + b);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: h, bevelEnabled: false });
  g.rotateX(-Math.PI / 2); // extrude upward; shape's y becomes -z
  return finish(g, color, o);
}

export function cyl(rTop: number, rBottom: number, h: number, color: Color, o: PartOpts = {}, seg = 8) {
  const g = new THREE.CylinderGeometry(rTop, rBottom, h, seg, 1);
  g.translate(0, h / 2, 0);
  return finish(g, color, o);
}

export function cone(r: number, h: number, color: Color, o: PartOpts = {}, seg = 8) {
  const g = new THREE.ConeGeometry(r, h, seg, 1);
  g.translate(0, h / 2, 0);
  return finish(g, color, o);
}

export function ball(r: number, color: Color, o: PartOpts = {}, detail = 0) {
  const g = new THREE.IcosahedronGeometry(r, detail);
  return finish(g, color, o);
}

// A gable roof (triangular prism) of width w (x), depth d (z), height h.
export function gable(w: number, h: number, d: number, color: Color, o: PartOpts = {}) {
  const s = new THREE.Shape();
  s.moveTo(-w / 2, 0);
  s.lineTo(w / 2, 0);
  s.lineTo(0, h);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: d, bevelEnabled: false });
  g.translate(0, 0, -d / 2);
  return finish(g, color, o);
}

// A flat ring on the ground (for the net-worth ring, plazas).
export function ring(rIn: number, rOut: number, color: Color, o: PartOpts = {}, seg = 28) {
  const g = new THREE.RingGeometry(rIn, rOut, seg, 1);
  g.rotateX(-Math.PI / 2);
  return finish(g, color, o);
}

export function torus(r: number, tube: number, color: Color, o: PartOpts = {}, seg = 16) {
  const g = new THREE.TorusGeometry(r, tube, 4, seg);
  return finish(g, color, o);
}

// Striped awning: alternating colours along x, sloping toward +z.
export function awning(w: number, d: number, colors: [Color, Color], o: PartOpts = {}, stripes = 6, drop = 0.35) {
  const parts: THREE.BufferGeometry[] = [];
  const sw = w / stripes;
  for (let i = 0; i < stripes; i++) {
    const x = -w / 2 + sw * (i + 0.5);
    parts.push(box(sw, 0.06, d, colors[i % 2], { at: [x, 0, 0], rot: [-Math.atan2(drop, d), 0, 0] }));
    parts.push(box(sw, drop * 0.55, 0.05, colors[i % 2], { at: [x, -drop * 0.55 - drop / 2 + 0.03, d / 2] }));
  }
  return group(parts, o);
}

// Merge parts into one geometry, optionally moved as a whole.
export function group(parts: (THREE.BufferGeometry | null | undefined | false)[], o: PartOpts = {}) {
  const list = parts.filter(Boolean) as THREE.BufferGeometry[];
  const g = list.length === 1 ? list[0].clone() : mergeGeometries(list, false)!;
  if (o.at || o.rot || o.scale) {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(...(o.rot ?? [0, 0, 0])));
    m.compose(new THREE.Vector3(...(o.at ?? [0, 0, 0])), q, new THREE.Vector3(...(o.scale ?? [1, 1, 1])));
    g.applyMatrix4(m);
  }
  return g;
}

export function triangles(g: THREE.BufferGeometry) {
  return g.getAttribute('position').count / 3;
}

// Mix two colours (0..1) for shading variants.
export function mix(a: Color, b: Color, k: number) {
  return '#' + new THREE.Color(a).lerp(new THREE.Color(b), k).getHexString();
}
export function shade(c: Color, k: number) {
  return k >= 0 ? mix(c, '#ffffff', k) : mix(c, '#000000', -k);
}
