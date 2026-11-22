// A small live 3D view at the top of the Business window: a cutaway of a
// shop's room built from its fit-out grid ("peek inside"), or the business's
// own model turning slowly. Its own little WebGL canvas; draws only while
// visible, at 30 frames a second.
import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { businessModel, TIER_COLORS, type BizState } from './models';
import { box, cyl, ball, group, rbox, cone } from './kit';
import { reducedMotion } from '../lib/settings';

const TILE = 1.25;
const COLS = 8;
const ROWS = 5;

function fitoutPiece(id: string, accent: string): THREE.BufferGeometry {
  const WOOD = '#b07a42';
  const DARK = '#3a3f46';
  switch (id) {
    case 'counter':
      return group([rbox(1.15, 0.95, 0.65, WOOD, {}, 0.1), box(1.2, 0.08, 0.7, '#f6efe0', { at: [0, 0.95, 0] }), box(0.3, 0.25, 0.25, '#e8b23a', { at: [0.3, 1.03, 0] })]);
    case 'table2':
      return group([cyl(0.38, 0.38, 0.06, '#ffffff', { at: [0, 0.75, 0] }, 12), cyl(0.05, 0.05, 0.75, DARK, {}, 5), ...[-1, 1].map((s) => box(0.32, 0.45, 0.32, accent, { at: [s * 0.5, 0, 0] }))]);
    case 'table4':
      return group([box(0.85, 0.06, 0.85, '#ffffff', { at: [0, 0.75, 0] }), cyl(0.05, 0.05, 0.75, DARK, {}, 5), ...[[-1, 0], [1, 0], [0, -1], [0, 1]].map(([x, z]) => box(0.3, 0.45, 0.3, accent, { at: [x * 0.55, 0, z * 0.55] }))]);
    case 'booth':
      return group([box(1.1, 0.45, 0.45, '#9b2d2d', { at: [0, 0, -0.3] }), box(1.1, 0.7, 0.15, '#9b2d2d', { at: [0, 0.45, -0.48] }), box(0.9, 0.06, 0.5, '#ffffff', { at: [0, 0.75, 0.2] }), cyl(0.05, 0.05, 0.75, DARK, { at: [0, 0, 0.2] }, 5)]);
    case 'kitchen':
      return group([box(1.15, 0.9, 0.8, '#c0c6cc'), box(1.15, 0.05, 0.8, DARK, { at: [0, 0.9, 0] }), cyl(0.2, 0.18, 0.3, '#8d99a6', { at: [-0.25, 0.95, 0] }, 8), cyl(0.18, 0.18, 0.12, '#8d99a6', { at: [0.28, 0.95, 0] }, 8)]);
    case 'coffee_machine':
      return group([box(0.8, 0.8, 0.6, WOOD), box(0.55, 0.6, 0.45, '#2b2f33', { at: [0, 0.8, 0] }), box(0.4, 0.08, 0.3, '#c0c6cc', { at: [0, 1.4, 0] }), cyl(0.07, 0.06, 0.12, '#ffffff', { at: [0.1, 0.82, 0.2] }, 6)]);
    case 'shelf':
      return group([box(1.1, 1.8, 0.4, WOOD), ...[0.35, 0.8, 1.25].flatMap((y, i) => [0, 1, 2, 3].map((k) => box(0.2, 0.28, 0.25, ['#e5533d', '#7cc35a', '#f4cf3f', '#3f8ed6'][(k + i) % 4], { at: [-0.38 + k * 0.25, y, 0.05] })))]);
    case 'fridge':
      return group([rbox(0.9, 1.9, 0.7, '#f1f4f6', {}, 0.08), box(0.7, 1.4, 0.04, '#9fd3e6', { at: [0, 0.35, 0.36] })]);
    case 'display':
      return group([box(1.1, 0.7, 0.6, WOOD), box(1.05, 0.45, 0.55, '#bfe6f0', { at: [0, 0.7, 0] }), ball(0.12, '#e8a93a', { at: [-0.25, 0.85, 0] }), ball(0.12, '#e5533d', { at: [0.2, 0.85, 0] })]);
    case 'plant':
      return group([cyl(0.25, 0.2, 0.45, '#c96f4a', {}, 8), ball(0.42, '#5f9f45', { at: [0, 0.75, 0] }, 1), ball(0.3, '#6faf55', { at: [0.15, 1.05, 0.05] }, 1)]);
    case 'art':
      return group([box(0.9, 0.7, 0.06, '#5e4630', { at: [0, 0.8, -0.5] }), box(0.78, 0.58, 0.07, accent, { at: [0, 0.86, -0.5] }), box(0.08, 0.8, 0.08, '#5e4630', { at: [0, 0, -0.5] })]);
    case 'lighting':
      return group([cyl(0.04, 0.04, 1.5, DARK, {}, 5), cone(0.32, 0.35, '#ffe7a8', { at: [0, 1.45, 0] }, 8), cyl(0.2, 0.25, 0.05, DARK, {}, 8)]);
    case 'safe':
      return group([rbox(0.8, 0.85, 0.7, '#4a4f55', {}, 0.08), cyl(0.12, 0.12, 0.05, '#e8b23a', { at: [0, 0.5, 0.36], rot: [Math.PI / 2, 0, 0] }, 10)]);
    default:
      return box(0.6, 0.6, 0.6, accent);
  }
}

function roomGeometry(fitout: (string | null)[], tier: number) {
  const accent = TIER_COLORS[tier] ?? '#2f8f6e';
  const parts: THREE.BufferGeometry[] = [];
  const W = COLS * TILE;
  const D = ROWS * TILE;
  for (let r = 0; r < ROWS; r++)
    for (let c = 0; c < COLS; c++) parts.push(box(TILE - 0.02, 0.1, TILE - 0.02, (r + c) % 2 ? '#efe6d4' : '#e4d8c2', { at: [-W / 2 + (c + 0.5) * TILE, -0.1, -D / 2 + (r + 0.5) * TILE] }));
  // Back and left walls; the front and right are cut away so you can see in.
  parts.push(box(W + 0.3, 2.8, 0.15, '#f6efe0', { at: [0, -0.1, -D / 2 - 0.08] }), box(0.15, 2.8, D, '#efe6d4', { at: [-W / 2 - 0.08, -0.1, 0] }), box(W + 0.3, 0.35, 0.18, accent, { at: [0, 2.35, -D / 2 - 0.05] }));
  fitout.slice(0, COLS * ROWS).forEach((id, i) => {
    if (!id) return;
    const c = i % COLS;
    const r = Math.floor(i / COLS);
    const g = fitoutPiece(id, accent).clone();
    g.translate(-W / 2 + (c + 0.5) * TILE, 0, -D / 2 + (r + 0.5) * TILE);
    parts.push(g);
  });
  return group(parts);
}

export default function MiniView({ kind, tier, level, status, fitout, height = 170 }: { kind: string; tier: number; level: number; status: string; fitout?: (string | null)[] | null; height?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const key = JSON.stringify([kind, tier, level, status, fitout]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      return; // no WebGL: the window works without the picture
    }
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.setClearColor(0x000000, 0);
    el.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight('#fff6e8', '#8a7f6a', 1.35));
    const sun = new THREE.DirectionalLight('#fff1d6', 2.2);
    sun.position.set(-3, 8, 5);
    scene.add(sun);
    const solid = new THREE.MeshLambertMaterial({ vertexColors: true });
    const glow = new THREE.MeshBasicMaterial({ vertexColors: true, color: new THREE.Color(0.65, 0.65, 0.65) });
    const room = !!fitout && fitout.some(Boolean);
    const obj = new THREE.Group();
    if (room) obj.add(new THREE.Mesh(roomGeometry(fitout!, tier), solid));
    else {
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
    const resize = () => {
      const w = el.clientWidth || 300;
      renderer.setSize(w, height, false);
      renderer.domElement.style.width = '100%';
      renderer.domElement.style.height = height + 'px';
      cam.aspect = w / height;
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
      if (!visible || document.hidden || t - last < 33) return;
      last = t;
      const a = still ? 0.5 : room ? 0.5 + Math.sin(t / 2600) * 0.35 : t / 4000;
      const dist = sphere.radius / Math.sin((15 * Math.PI) / 180) * (room ? 0.78 : 0.7);
      cam.position.set(sphere.center.x + Math.sin(a) * dist, sphere.center.y + dist * (room ? 0.75 : 0.55), sphere.center.z + Math.cos(a) * dist);
      cam.lookAt(sphere.center);
      renderer.render(scene, cam);
      if (still) cancelAnimationFrame(raf);
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      renderer.dispose();
      solid.dispose();
      glow.dispose();
      renderer.domElement.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, height]);
  return <div ref={ref} className="mini-view" aria-hidden />;
}
