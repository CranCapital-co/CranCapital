// Ships as little 3D models on the world map, once you zoom in far enough
// (further out they're labels). Warships and cargo ships, each kind drawn as
// one instanced mesh (one draw call for all of them, which iPads like),
// sized to stay readable at any zoom, heading along their route and rocking
// gently on the swell. A wake trails each ship under way.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { CustomLayerInterface, Map as MLMap } from 'maplibre-gl';
import { MercatorCoordinate } from 'maplibre-gl';

export interface Ship3D {
  lng: number;
  lat: number;
  hdg: number; // degrees clockwise from north
  kind: 'war' | 'cargo';
  color: string; // the country's / owner's colour (funnel band, stripe)
  moving: boolean;
  seed: number;
}

export const SHIP3D_MIN_ZOOM = 3.6;
const MAX = 400;

// Build a part: a box (w x h x l) at (x, y, z), coloured.
function box(w: number, h: number, l: number, x: number, y: number, z: number, color: string) {
  const g = new THREE.BoxGeometry(w, h, l).toNonIndexed();
  g.translate(x, y + h / 2, z);
  return paint(g, color);
}
function cyl(r: number, h: number, x: number, y: number, z: number, color: string, seg = 10) {
  const g = new THREE.CylinderGeometry(r, r, h, seg).toNonIndexed();
  g.translate(x, y + h / 2, z);
  return paint(g, color);
}
function paint(g: THREE.BufferGeometry, color: string) {
  const c = new THREE.Color(color);
  const n = g.getAttribute('position').count;
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    a[i * 3] = c.r;
    a[i * 3 + 1] = c.g;
    a[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  g.deleteAttribute('uv');
  return g;
}
// A hull from a top-view outline (x across, z along; bow towards -z),
// extruded upwards to `h`, tapering towards the keel.
function hull(outline: [number, number][], h: number, color: string, keel = 0.75) {
  const shape = new THREE.Shape(outline.map(([x, z]) => new THREE.Vector2(x, -z)));
  const g = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false }).toNonIndexed();
  // Shape is in x/y, extruded along +z: turn it so y -> -z and the extrusion goes up.
  g.rotateX(-Math.PI / 2);
  // Narrower at the bottom: a ship-shaped hull.
  const p = g.getAttribute('position');
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    if (y < h * 0.5) p.setX(i, p.getX(i) * (keel + (1 - keel) * (y / (h * 0.5))));
  }
  g.computeVertexNormals();
  return paint(g, color);
}

// Models are about 1 unit long (bow at -0.5, stern at +0.5), y up.
function warship() {
  const W = 0.13;
  const outline: [number, number][] = [[0, -0.5], [W * 0.6, -0.36], [W, -0.15], [W, 0.38], [W * 0.75, 0.5], [-W * 0.75, 0.5], [-W, 0.38], [-W, -0.15], [-W * 0.6, -0.36]];
  const parts = [
    hull(outline, 0.06, '#59656f'),
    box(W * 1.7, 0.012, 0.8, 0, 0.06, 0.06, '#8d99a4'), // deck
    box(0.1, 0.07, 0.16, 0, 0.072, 0.05, '#d5dbe0'), // bridge
    box(0.075, 0.05, 0.1, 0, 0.142, 0.06, '#e8ecef'), // upper bridge
    box(0.012, 0.12, 0.012, 0, 0.19, 0.06, '#2b3238'), // mast
    box(0.06, 0.01, 0.01, 0, 0.27, 0.06, '#2b3238'), // radar arm
    cyl(0.032, 0.03, 0, 0.072, -0.22, '#77848f'), // fore turret
    box(0.01, 0.01, 0.12, -0.012, 0.087, -0.3, '#2b3238'), // barrels
    box(0.01, 0.01, 0.12, 0.012, 0.087, -0.3, '#2b3238'),
    cyl(0.028, 0.028, 0, 0.072, 0.32, '#77848f'), // aft turret
    box(0.01, 0.01, 0.1, 0, 0.086, 0.4, '#2b3238'),
    cyl(0.028, 0.06, 0, 0.072, 0.18, '#3b444c'), // funnel
  ];
  const band = [cyl(0.03, 0.022, 0, 0.11, 0.18, '#ffffff')]; // team colour
  return { body: mergeGeometries(parts)!, team: mergeGeometries(band)! };
}

function cargoShip() {
  const W = 0.14;
  const outline: [number, number][] = [[0, -0.5], [W * 0.75, -0.4], [W, -0.25], [W, 0.44], [W * 0.85, 0.5], [-W * 0.85, 0.5], [-W, 0.44], [-W, -0.25], [-W * 0.75, -0.4]];
  const parts = [
    hull(outline, 0.05, '#8c2f2a', 0.8), // red below
    box(W * 1.9, 0.02, 0.92, 0, 0.05, 0.03, '#1e2a33'), // dark topsides
    box(0.15, 0.1, 0.1, 0, 0.07, 0.38, '#f2f2ee'), // bridge at the stern
    box(0.17, 0.02, 0.04, 0, 0.17, 0.36, '#f2f2ee'), // bridge wings
    cyl(0.022, 0.06, 0, 0.17, 0.43, '#2a2f33'), // funnel
  ];
  // Containers, in rows.
  const colours = ['#d8573f', '#2f78b7', '#e8a93a', '#3b8f5a', '#7d4fb0', '#c9c9c9', '#1d6e7a'];
  let k = 0;
  for (let row = 0; row < 6; row++) {
    for (let col = -1; col <= 1; col++) {
      const stack = 1 + ((row * 3 + col + 7) % 3);
      for (let s = 0; s < stack; s++) {
        parts.push(box(0.066, 0.028, 0.095, col * 0.07, 0.07 + s * 0.029, -0.3 + row * 0.105, colours[k++ % colours.length]));
      }
    }
  }
  const band = [box(W * 2.02, 0.012, 0.94, 0, 0.036, 0.02, '#ffffff')]; // owner's stripe
  return { body: mergeGeometries(parts)!, team: mergeGeometries(band)! };
}

function wake() {
  const g = new THREE.BufferGeometry();
  // A V of foam behind the stern, at the waterline.
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
    0, 0.002, 0.48, -0.16, 0.002, 1.35, -0.06, 0.002, 1.35,
    0, 0.002, 0.48, 0.06, 0.002, 1.35, 0.16, 0.002, 1.35,
    -0.05, 0.002, 0.5, 0.05, 0.002, 0.5, 0, 0.002, 1.1,
  ]), 3));
  return g;
}

export class ShipLayer implements CustomLayerInterface {
  id: string;
  type = 'custom' as const;
  renderingMode = '3d' as const;
  private map!: MLMap;
  private renderer!: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.Camera();
  private meshes: { body: THREE.InstancedMesh; team: THREE.InstancedMesh }[] = [];
  private wakes!: THREE.InstancedMesh;
  private ships: Ship3D[] = [];
  private m = new THREE.Matrix4();
  private a = new THREE.Matrix4();
  private toMap = new THREE.Matrix4().makeRotationX(Math.PI / 2);
  private col = new THREE.Color();
  private pending = false;

  constructor(id: string) {
    this.id = id;
  }

  set(ships: Ship3D[]) {
    this.ships = ships;
    this.map?.triggerRepaint();
  }

  onAdd(map: MLMap, gl: WebGLRenderingContext | WebGL2RenderingContext) {
    this.map = map;
    this.renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl as WebGL2RenderingContext, antialias: true });
    this.renderer.autoClear = false;
    // The map's "up" is +z.
    const sky = new THREE.HemisphereLight(0xeef4ff, 0x203040, 1.6);
    sky.position.set(0, 0, 1);
    this.scene.add(sky);
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(-0.4, -0.6, 1); // from the north-west, high
    this.scene.add(sun);
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
    const teamMat = new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.DoubleSide });
    for (const model of [warship(), cargoShip()]) {
      const body = new THREE.InstancedMesh(model.body, mat, MAX);
      const team = new THREE.InstancedMesh(model.team, teamMat, MAX);
      team.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3), 3);
      for (const x of [body, team]) {
        x.count = 0;
        x.frustumCulled = false;
        x.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        this.scene.add(x);
      }
      this.meshes.push({ body, team });
    }
    this.wakes = new THREE.InstancedMesh(wake(), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false }), MAX);
    this.wakes.count = 0;
    this.wakes.frustumCulled = false;
    this.scene.add(this.wakes);
  }

  onRemove() {
    for (const { body, team } of this.meshes) {
      body.geometry.dispose();
      team.geometry.dispose();
    }
    this.wakes.geometry.dispose();
  }

  render(_gl: WebGLRenderingContext | WebGL2RenderingContext, matrix: ArrayLike<number>) {
    const z = this.map.getZoom();
    if (z < SHIP3D_MIN_ZOOM || z > 11 || !this.ships.length) return;
    // About 30 px long at the zoom they appear, growing as you zoom in.
    const px = Math.min(150, 44 + (z - SHIP3D_MIN_ZOOM) * 22);
    const units = px / (512 * 2 ** z);
    const t = performance.now() / 1000;
    const counts = [0, 0];
    let wakes = 0;
    for (const s of this.ships) {
      const k = s.kind === 'war' ? 0 : 1;
      if (counts[k] >= MAX) continue;
      const mc = MercatorCoordinate.fromLngLat([s.lng, s.lat], 0);
      // Model frame (y up, bow towards -z) to the map's (x east, y south,
      // z up): translate . scale(u, -u, u) . rotX(90deg) . heading . swell.
      const roll = Math.sin(t * 1.3 + s.seed) * 0.06;
      const pitch = Math.sin(t * 0.9 + s.seed * 1.7) * 0.03;
      this.m.makeTranslation(mc.x, mc.y, 0);
      this.m.multiply(this.a.makeScale(units, -units, units));
      this.m.multiply(this.toMap);
      this.m.multiply(this.a.makeRotationY((-s.hdg * Math.PI) / 180));
      this.m.multiply(this.a.makeRotationX(pitch));
      this.m.multiply(this.a.makeRotationZ(roll));
      const mesh = this.meshes[k];
      mesh.body.setMatrixAt(counts[k], this.m);
      mesh.team.setMatrixAt(counts[k], this.m);
      mesh.team.setColorAt(counts[k], this.col.set(s.color));
      counts[k]++;
      if (s.moving && wakes < MAX) this.wakes.setMatrixAt(wakes++, this.m);
    }
    for (let k = 0; k < 2; k++) {
      const { body, team } = this.meshes[k];
      body.count = counts[k];
      team.count = counts[k];
      body.instanceMatrix.needsUpdate = true;
      team.instanceMatrix.needsUpdate = true;
      if (team.instanceColor) team.instanceColor.needsUpdate = true;
    }
    this.wakes.count = wakes;
    this.wakes.instanceMatrix.needsUpdate = true;
    this.camera.projectionMatrix.fromArray(Array.from(matrix));
    this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix).invert();
    this.renderer.resetState();
    this.renderer.render(this.scene, this.camera);
    // Keep the swell moving, gently (about 12 frames a second), while ships
    // are on screen and the app is in front.
    if (!this.pending && !document.hidden) {
      this.pending = true;
      setTimeout(() => {
        this.pending = false;
        this.map.triggerRepaint();
      }, 80);
    }
  }
}
