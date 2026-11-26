// One small off-screen WebGL renderer for every 3D picture outside the map:
// business icons, city cards and the room previews in business windows.
//
// iPad Safari allows only a few WebGL contexts and kills the oldest when a
// page makes too many, which can be the map itself (a blank map that "never
// loads"). So nothing else in the game creates its own: pictures are drawn
// here and copied into ordinary 2D canvases or images.
import * as THREE from 'three';

let renderer: THREE.WebGLRenderer | null = null;
let failed = false;

export function offscreen(): THREE.WebGLRenderer | null {
  if (renderer) return renderer;
  if (failed) return null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true, powerPreference: 'low-power' });
    renderer.setClearColor(0x000000, 0);
    renderer.setPixelRatio(1);
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      renderer = null;
    });
    return renderer;
  } catch {
    failed = true;
    return null;
  }
}

// Draw a scene at w x h CSS pixels into a 2D canvas (scaled for the screen,
// capped so iPads don't render at 2x for small pictures).
export function drawInto(target: HTMLCanvasElement, scene: THREE.Scene, cam: THREE.Camera, w: number, h: number) {
  const r = offscreen();
  if (!r) return false;
  const dpr = Math.min(1.5, window.devicePixelRatio || 1);
  const pw = Math.round(w * dpr);
  const ph = Math.round(h * dpr);
  r.setSize(pw, ph, false);
  r.clear();
  r.render(scene, cam);
  if (target.width !== pw || target.height !== ph) {
    target.width = pw;
    target.height = ph;
  }
  const ctx = target.getContext('2d');
  if (!ctx) return false;
  ctx.clearRect(0, 0, pw, ph);
  ctx.drawImage(r.domElement, 0, 0, pw, ph, 0, 0, pw, ph);
  return true;
}

// Render to a PNG data URL (for pictures that are shown many times).
export function renderToUrl(scene: THREE.Scene, cam: THREE.Camera, w: number, h: number): string {
  const r = offscreen();
  if (!r) return '';
  r.setSize(w, h, false);
  r.clear();
  r.render(scene, cam);
  return r.domElement.toDataURL('image/png');
}
