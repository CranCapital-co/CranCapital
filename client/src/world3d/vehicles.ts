// Vehicles: background cars and buses on the main roads (from the map's own
// road lines), the taxi that picks you up, delivery vans when you restock,
// and ships that carry exports out of your ports.
import * as THREE from 'three';
import type { WorldLayer } from './WorldLayer';
import { vehicleParts } from './models';
import { sound } from '../audio/sound';

interface Lane { pts: THREE.Vector3[]; len: number[]; total: number }
interface Car { lane: number; d: number; dir: 1 | -1; speed: number; kind: 'car' | 'bus' | 'taxi'; color: string }
interface Mover { kind: 'van' | 'taxi' | 'ship'; from: THREE.Vector3; to: THREE.Vector3; t: number; dur: number; wait: number; then?: () => void; yaw: number; leave?: THREE.Vector3; stage: 0 | 1 | 2 }

const CAR_COLORS = ['#e3694d', '#3f8ed6', '#f6efe0', '#2b2f33', '#9aa3ad', '#2f6f5e', '#c9302c', '#e8b23a', '#5b6c8c'];
const COUNT = { high: 36, medium: 16, saver: 0 };

// Cars, buses, taxis and vans are gone (iPad performance).
const NO_CARS = true;

export class Vehicles {
  lanes: Lane[] = [];
  private cars: Car[] = [];
  private movers: Mover[] = [];
  private parts = vehicleParts();
  private lastFetch = 0;
  private col = new THREE.Color();
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private v = new THREE.Vector3();
  private s = new THREE.Vector3(1.6, 1.6, 1.6); // vehicles are a bit larger than life, like the people
  private y = new THREE.Vector3(0, 1, 0);
  hideMe = false;

  constructor(private w: WorldLayer) {
    w.extraDraw.push((dt) => this.frame(dt));
    w.map.on('moveend', () => (this.lastFetch = 0));
  }

  // Road lines near the camera, from the street map's vector tiles.
  private fetchLanes() {
    this.lastFetch = performance.now();
    let feats: any[] = [];
    try {
      feats = this.w.map.querySourceFeatures('ofm', { sourceLayer: 'transportation', filter: ['in', ['get', 'class'], ['literal', ['primary', 'secondary', 'tertiary', 'trunk']]] });
    } catch {
      return;
    }
    const c = this.w.map.getCenter();
    const center = this.w.local(c.lat, c.lng);
    const lanes: Lane[] = [];
    for (const f of feats) {
      if (f.properties?.brunnel === 'tunnel') continue;
      const lines = f.geometry.type === 'LineString' ? [f.geometry.coordinates] : f.geometry.type === 'MultiLineString' ? f.geometry.coordinates : [];
      for (const line of lines) {
        if (line.length < 2) continue;
        const pts = line.map(([lng, lat]: number[]) => this.w.local(lat, lng));
        if (!pts.some((p: THREE.Vector3) => p.distanceTo(center) < 450)) continue;
        const len: number[] = [0];
        for (let i = 1; i < pts.length; i++) len.push(len[i - 1] + pts[i].distanceTo(pts[i - 1]));
        if (len[len.length - 1] < 60) continue;
        lanes.push({ pts, len, total: len[len.length - 1] });
        if (lanes.length > 80) break;
      }
    }
    this.lanes = lanes;
    this.cars = this.cars.filter((c) => c.lane < lanes.length);
  }

  private at(l: Lane, d: number, out: THREE.Vector3) {
    let i = 1;
    while (i < l.len.length - 1 && l.len[i] < d) i++;
    const k = (d - l.len[i - 1]) / Math.max(0.001, l.len[i] - l.len[i - 1]);
    out.lerpVectors(l.pts[i - 1], l.pts[i], Math.max(0, Math.min(1, k)));
    return Math.atan2(l.pts[i].x - l.pts[i - 1].x, l.pts[i].z - l.pts[i - 1].z);
  }

  // A taxi pulls up, you get in, and it drives off toward where you're going.
  taxi(from: { lat: number; lng: number }, to: { lat: number; lng: number }, onGone: () => void) {
    const a = this.w.local(from.lat, from.lng);
    const b = this.w.local(to.lat, to.lng);
    const dir = new THREE.Vector3().subVectors(b, a).setY(0).normalize();
    const start = a.clone().addScaledVector(dir, -45).add(new THREE.Vector3(dir.z, 0, -dir.x).multiplyScalar(4));
    const stop = a.clone().add(new THREE.Vector3(dir.z, 0, -dir.x).multiplyScalar(4));
    this.movers.push({ kind: 'taxi', from: start, to: stop, t: 0, dur: 1.3, wait: 0.6, yaw: Math.atan2(dir.x, dir.z), leave: stop.clone().addScaledVector(dir, 70), stage: 0, then: onGone });
  }

  // A delivery van drives along the street past the business, stopping outside.
  delivery(at: THREE.Vector3, yaw: number) {
    if (NO_CARS) return;
    const front = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    const side = new THREE.Vector3(front.z, 0, -front.x);
    const stop = at.clone().addScaledVector(front, 9);
    this.movers.push({ kind: 'van', from: stop.clone().addScaledVector(side, -70), to: stop, t: 0, dur: 2.6, wait: 3, yaw: Math.atan2(side.x, side.z), leave: stop.clone().addScaledVector(side, 70), stage: 0 });
  }

  // A ship sails out from the quay with the export.
  ship(at: THREE.Vector3, yaw: number) {
    const out = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    const quay = at.clone().addScaledVector(out, 16);
    sound.play('horn');
    this.movers.push({ kind: 'ship', from: quay, to: quay.clone().addScaledVector(out, 900), t: 0, dur: 45, wait: 0, yaw: Math.atan2(out.x, out.z), stage: 1 });
  }

  // A ship sails in from the sea to the quay with a delivery.
  shipIn(at: THREE.Vector3, yaw: number) {
    const out = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    const quay = at.clone().addScaledVector(out, 16);
    sound.play('horn');
    this.movers.push({ kind: 'ship', from: quay.clone().addScaledVector(out, 700), to: quay, t: 0, dur: 30, wait: 0, yaw: Math.atan2(-out.x, -out.z), stage: 1 });
  }

  private frame(dt: number) {
    // No street traffic any more (it cost a road scan every few seconds and
    // a few hundred moving models): only the ships that carry your exports.
    if (NO_CARS) {
      /* no cars */
    } else if (this.w.map.getZoom() >= 15.5 && COUNT[this.w.quality] > 0) {
      const q = this.w.quality;
      if (performance.now() - this.lastFetch > 8000) this.fetchLanes();
      const want = Math.min(COUNT[q], this.lanes.length * 3);
      while (this.cars.length < want && this.lanes.length) {
        const lane = Math.floor(Math.random() * this.lanes.length);
        const r = Math.random();
        this.cars.push({ lane, d: Math.random() * this.lanes[lane].total, dir: Math.random() < 0.5 ? 1 : -1, speed: 9 + Math.random() * 6, kind: r < 0.08 ? 'bus' : r < 0.2 ? 'taxi' : 'car', color: CAR_COLORS[Math.floor(Math.random() * CAR_COLORS.length)] });
      }
      if (this.cars.length > want) this.cars.length = want;
      const night = this.w.night;
      const lights = night > 0.35 ? this.w.pools.get('car-lights', () => carLights, 'glow') : null;
      for (const c of this.cars) {
        const l = this.lanes[c.lane];
        if (!l) continue;
        c.d += c.dir * c.speed * (c.kind === 'bus' ? 0.7 : 1) * dt;
        if (c.d < 0 || c.d > l.total) {
          // Off the end of the road: start again somewhere else.
          c.lane = Math.floor(Math.random() * this.lanes.length);
          c.d = c.dir > 0 ? 0 : this.lanes[c.lane].total;
          continue;
        }
        let yaw = this.at(l, c.d, this.v);
        if (c.dir < 0) yaw += Math.PI;
        // Keep left in London, right elsewhere.
        const side = this.w.city.meta.id === 'london' || this.w.city.meta.id === 'tokyo' || this.w.city.meta.id === 'singapore' ? 1 : -1;
        this.v.x += Math.cos(yaw) * 2.6 * side;
        this.v.z -= Math.sin(yaw) * 2.6 * side;
        this.q.setFromAxisAngle(this.y, yaw);
        this.m.compose(this.v, this.q, this.s);
        if (c.kind === 'bus') this.w.pools.get('v-bus', () => this.parts.bus).add(this.m);
        else if (c.kind === 'taxi') this.w.pools.get('v-taxi', () => this.parts.taxi).add(this.m);
        else this.w.pools.get('v-car', () => this.parts.car, 'solid', true).add(this.m, this.col.set(c.color));
        if (lights) lights.add(this.m);
      }
    }
    // Scripted movers: taxi, vans, ships.
    this.movers = this.movers.filter((mv) => {
      mv.t += dt;
      let pos: THREE.Vector3;
      if (mv.stage === 0) {
        const k = easeInOut(Math.min(1, mv.t / mv.dur));
        pos = this.v.lerpVectors(mv.from, mv.to, k);
        if (mv.t >= mv.dur) {
          mv.stage = 1;
          mv.t = 0;
          if (mv.kind === 'taxi') {
            this.hideMe = true;
            sound.play('whoosh');
          }
        }
      } else if (mv.leave && mv.kind !== 'ship') {
        if (mv.t < mv.wait) pos = this.v.copy(mv.to);
        else {
          const k = Math.min(1, (mv.t - mv.wait) / 1.8);
          pos = this.v.lerpVectors(mv.to, mv.leave, k * k);
          if (k >= 1) {
            mv.then?.();
            return false;
          }
        }
      } else {
        const k = Math.min(1, mv.t / mv.dur);
        pos = this.v.lerpVectors(mv.from, mv.to, k * k);
        if (k >= 1) return false;
      }
      this.q.setFromAxisAngle(this.y, mv.yaw);
      if (mv.kind === 'ship') {
        this.m.compose(pos, this.q, this.s.set(1.3, 1.3, 1.3));
        this.w.pools.get('v-ship', () => this.parts.ship).add(this.m);
      } else {
        this.m.compose(pos, this.q, this.s.set(1.6, 1.6, 1.6));
        this.w.pools.get(mv.kind === 'van' ? 'v-van' : 'v-taxi', () => (mv.kind === 'van' ? this.parts.van : this.parts.taxi)).add(this.m);
      }
      this.s.set(1.6, 1.6, 1.6);
      return true;
    });
  }
}

const carLights = (() => {
  const g = new THREE.BufferGeometry();
  const pts: number[] = [];
  const col: number[] = [];
  const quad = (x: number, y: number, z: number, w: number, h: number, c: [number, number, number]) => {
    const v = [
      [x - w, y - h, z], [x + w, y - h, z], [x + w, y + h, z],
      [x - w, y - h, z], [x + w, y + h, z], [x - w, y + h, z],
    ];
    for (const p of v) {
      pts.push(...p);
      col.push(...c);
    }
  };
  // headlights at the front (+z), tail lights at the back
  quad(-0.65, 0.75, 2.26, 0.22, 0.12, [1, 0.95, 0.75]);
  quad(0.65, 0.75, 2.26, 0.22, 0.12, [1, 0.95, 0.75]);
  quad(-0.7, 0.8, -2.26, 0.2, 0.1, [1, 0.15, 0.1]);
  quad(0.7, 0.8, -2.26, 0.2, 0.1, [1, 0.15, 0.1]);
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return g;
})();

function easeInOut(k: number) {
  return k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
}
