// Pictures of the 3D models, rendered once and cached, so the steel mill's
// icon is the steel mill: used in the Build menu, windows and the map badges
// you see when zoomed out.
import * as THREE from 'three';
import { businessModel } from './models';

let renderer: THREE.WebGLRenderer | null = null;
const cache = new Map<string, string>();
const waiting = new Map<string, Promise<string>>();
const SIZE = 192;

function setup() {
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setClearColor(0x000000, 0);
  return renderer;
}

const solid = new THREE.MeshLambertMaterial({ vertexColors: true });
const glow = new THREE.MeshBasicMaterial({ vertexColors: true, color: new THREE.Color(0.6, 0.6, 0.6) });

export function thumbKey(kind: string, tier: number, level = 1) {
  return `${kind}:${tier}:${level}`;
}

export function cachedThumb(kind: string, tier: number, level = 1) {
  return cache.get(thumbKey(kind, tier, level)) ?? null;
}

// Render one business model to a transparent PNG data URL.
export function businessThumb(kind: string, tier: number, level = 1): Promise<string> {
  const key = thumbKey(kind, tier, level);
  const hit = cache.get(key);
  if (hit) return Promise.resolve(hit);
  let p = waiting.get(key);
  if (p) return p;
  p = new Promise<string>((resolve) => {
    // Spread the work over frames so opening a menu stays smooth.
    requestAnimationFrame(() => {
      try {
        const r = renderer ?? setup();
        const m = businessModel(kind, tier, level, 'open');
        const scene = new THREE.Scene();
        scene.add(new THREE.HemisphereLight('#fff6e8', '#8a7f6a', 1.4));
        const sun = new THREE.DirectionalLight('#fff1d6', 2.4);
        sun.position.set(-4, 8, 6);
        scene.add(sun);
        const group = new THREE.Group();
        group.add(new THREE.Mesh(m.base, solid));
        if (m.glow) group.add(new THREE.Mesh(m.glow, glow));
        for (const mp of m.moving) {
          const g = new THREE.Mesh(mp.geo, solid);
          g.position.set(...mp.at);
          group.add(g);
        }
        scene.add(group);
        const box = new THREE.Box3().setFromObject(group);
        const sphere = box.getBoundingSphere(new THREE.Sphere());
        const cam = new THREE.PerspectiveCamera(28, 1, 0.1, 1000);
        const dist = (sphere.radius / Math.sin(((28 / 2) * Math.PI) / 180)) * 0.86;
        const dir = new THREE.Vector3(0.75, 0.62, 1).normalize();
        cam.position.copy(sphere.center).addScaledVector(dir, dist);
        cam.lookAt(sphere.center);
        r.setSize(SIZE, SIZE, false);
        r.clear();
        r.render(scene, cam);
        const url = r.domElement.toDataURL('image/png');
        cache.set(key, url);
        resolve(url);
      } catch {
        resolve('');
      } finally {
        waiting.delete(key);
      }
    });
  });
  waiting.set(key, p);
  return p;
}
