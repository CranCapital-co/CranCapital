// The living city: the real sun for the city's location and local time
// lights both the 3D models and MapLibre's buildings; the sky and the street
// colours follow the day into night; lamps, headlights and windows come on;
// the real weather (rain, snow, cloud) shows; world events change the
// street; and the season dresses it (winter lights, Halloween pumpkins).
import * as THREE from 'three';
import SunCalc from 'suncalc';
import type { Map as MLMap } from 'maplibre-gl';
import type { WorldLayer } from './WorldLayer';
import { applyPalette, blendPalette, wetPalette, NIGHT, type Palette } from '../map/style';
import { propParts, TIER_COLORS } from './models';
import { box, cone, cyl, ball, group } from './kit';
import { sound } from '../audio/sound';

export interface Weather { code: number | null; temp_c: number | null; cloud_pct: number | null; rain_mm: number | null; snow_cm: number | null; is_day: boolean | null }

interface Key { alt: number; sun: string; si: number; sky: string; ground: string; hi: number; skyColor: string; horizon: string }
// Light by sun altitude (degrees): night, dusk, golden hour, day.
const KEYS: Key[] = [
  // Night stays readable: toys under street lights, not silhouettes.
  { alt: -12, sun: '#b4c2ff', si: 0.6, sky: '#8a96d8', ground: '#4a4668', hi: 1.05, skyColor: '#0d1733', horizon: '#26305e' },
  { alt: -4, sun: '#a8a4ff', si: 0.8, sky: '#9aa0d8', ground: '#5a4c68', hi: 1.0, skyColor: '#3a4690', horizon: '#c98aa0' },
  { alt: 4, sun: '#ffb070', si: 1.7, sky: '#ffd9b8', ground: '#7a5e48', hi: 0.95, skyColor: '#f2a66e', horizon: '#ffd9a8' },
  { alt: 14, sun: '#ffe7c4', si: 2.1, sky: '#f2f4ff', ground: '#9a8f78', hi: 1.15, skyColor: '#8fc0ee', horizon: '#f4ece0' },
  { alt: 40, sun: '#fff4e0', si: 2.3, sky: '#eef6ff', ground: '#a89a7e', hi: 1.25, skyColor: '#7db8ef', horizon: '#f2f0ea' },
];

function lerpKey(alt: number): Key {
  if (alt <= KEYS[0].alt) return KEYS[0];
  for (let i = 1; i < KEYS.length; i++) {
    if (alt <= KEYS[i].alt) {
      const a = KEYS[i - 1];
      const b = KEYS[i];
      const k = (alt - a.alt) / (b.alt - a.alt);
      const c = (x: string, y: string) => '#' + new THREE.Color(x).lerp(new THREE.Color(y), k).getHexString();
      return { alt, sun: c(a.sun, b.sun), si: a.si + (b.si - a.si) * k, sky: c(a.sky, b.sky), ground: c(a.ground, b.ground), hi: a.hi + (b.hi - a.hi) * k, skyColor: c(a.skyColor, b.skyColor), horizon: c(a.horizon, b.horizon) };
    }
  }
  return KEYS[KEYS.length - 1];
}

// Seasonal dressing, by date.
export function season(d = new Date()) {
  const m = d.getMonth() + 1;
  const day = d.getDate();
  return {
    winter: (m === 12) || (m === 1 && day <= 6),
    halloween: m === 10 && day >= 20,
  };
}

const RAIN_CODES = (c: number | null) => c != null && ((c >= 51 && c <= 67) || (c >= 80 && c <= 82) || c >= 95);
const SNOW_CODES = (c: number | null) => c != null && ((c >= 71 && c <= 77) || c === 85 || c === 86);

// Street lamps (and the decorations hung on them) are gone: iPad performance.
const NO_LAMPS = true;

export class LivingCity {
  weather: Weather | null = null;
  event: string | null = null;
  rain = 0; // 0..1 (shown amount)
  snow = 0;
  cloud = 0;
  night = 0;
  private drops: Float32Array = new Float32Array(0);
  private lamps: { p: THREE.Vector3; yaw: number }[] = [];
  private lampsAt = 0;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private v = new THREE.Vector3();
  private s = new THREE.Vector3();
  private y = new THREE.Vector3(0, 1, 0);
  private col = new THREE.Color();
  private props = propParts();
  private extra = {
    // A pool of light: bright in the middle, fading to nothing at the edge
    // (drawn additively, so black adds no light).
    halo: (() => {
      const g = new THREE.CircleGeometry(1, 28);
      g.rotateX(-Math.PI / 2);
      g.translate(0, 0.06, 0);
      const n = g.getAttribute('position').count;
      const c = new Float32Array(n * 3);
      c.set([1, 1, 1], 0); // the centre vertex
      g.setAttribute('color', new THREE.BufferAttribute(c, 3));
      return g;
    })(),
    streak: box(0.06, 2.2, 0.06, '#cfe2ff'),
    flake: ball(0.18, '#ffffff'),
    bunting: group([0, 1, 2, 3, 4, 5, 6, 7].map((i) => cone(0.45, 0.8, ['#e3694d', '#f2c14b', '#3f8ed6', '#2f8f6e'][i % 4], { at: [-7 + i * 2, -0.8, 0], rot: [Math.PI, 0, 0] }, 3))),
    tree: group([cyl(0.25, 0.3, 1.2, '#6f4a2a', {}, 6), cone(2.2, 3.2, '#2f6f3a', { at: [0, 1.0, 0] }, 7), cone(1.6, 2.6, '#3f8a42', { at: [0, 2.8, 0] }, 7), ball(0.45, '#f2c14b', { at: [0, 5.5, 0] })]),
    treeLights: group([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => ball(0.2, ['#ff6b6b', '#ffd36b', '#7fd6ff', '#9dff8a'][i % 4], { at: [Math.cos(i * 2.1) * (2 - i * 0.15), 1.4 + i * 0.38, Math.sin(i * 2.1) * (2 - i * 0.15)] }))),
    lampLights: group([0, 1, 2, 3, 4, 5].map((i) => ball(0.16, ['#ff6b6b', '#ffd36b', '#7fd6ff'][i % 3], { at: [0.25, 1.6 + i * 0.75, 0] }))),
    pumpkin: group([ball(0.8, '#f08a2e', { scale: [1.2, 0.85, 1.2] }, 1), cyl(0.12, 0.12, 0.4, '#4a9a3a', { at: [0, 0.6, 0] }, 5)]),
    barrier: group([box(3.2, 0.9, 0.15, '#e8ecf0', { at: [0, 0.3, 0] }), box(0.15, 1.2, 0.15, '#c9302c', { at: [-1.5, 0, 0] }), box(0.15, 1.2, 0.15, '#c9302c', { at: [1.5, 0, 0] })]),
    banner: group([cyl(0.06, 0.06, 4.5, '#ddd', {}, 4), box(1.4, 2.0, 0.05, '#c9302c', { at: [0.75, 2.3, 0] }), box(1.1, 0.35, 0.06, '#ffffff', { at: [0.75, 2.9, 0.01] })]),
  };

  constructor(private w: WorldLayer, private map: MLMap, private day: Palette) {
    w.extraDraw.push((dt) => this.frame(dt));
  }

  setWeather(wx: Weather | null) {
    this.weather = wx;
    this.update();
  }
  setEvent(kind: string | null) {
    this.event = kind;
    this.w.eventMult = kind === 'festival' ? 1.6 : kind === 'strike' ? 0.5 : kind === 'marathon' ? 1.3 : kind === 'sale_season' ? 1.25 : 1;
    this.update();
  }
  setDayPalette(p: Palette) {
    this.day = p;
    this.update();
  }

  // Sun, sky, light and street colours for now. Called every minute and on changes.
  update(date = new Date()) {
    const m = this.w.city.meta;
    const pos = SunCalc.getPosition(date, m.start.lat, m.start.lng);
    const altDeg = (pos.altitude * 180) / Math.PI;
    const key = lerpKey(altDeg);
    const wx = this.weather;
    const code = wx?.code ?? null;
    this.rain = RAIN_CODES(code) || this.event === 'rain' ? Math.min(1, 0.45 + (wx?.rain_mm ?? 0) / 4) : 0;
    this.snow = SNOW_CODES(code) ? Math.min(1, 0.5 + (wx?.snow_cm ?? 0) / 2) : 0;
    this.cloud = Math.min(1, (wx?.cloud_pct ?? (code != null && code >= 3 ? 80 : 20)) / 100);
    if (code === 45 || code === 48) this.cloud = 1;
    if (this.event === 'heatwave') this.cloud = 0;
    const night = Math.max(0, Math.min(1, (2 - altDeg) / 8));
    this.night = night;
    this.w.night = night;
    this.w.rainK = this.rain;
    this.w.eventKind = this.event;
    // Overcast flattens the light: less sun, more sky.
    const dim = 1 - this.cloud * 0.55 - this.rain * 0.2;
    // Direction toward the sun in local coordinates (x east, y up, z south).
    // SunCalc azimuth is from south, positive toward west.
    const alt = Math.max(0.15, pos.altitude);
    const dir = new THREE.Vector3(-Math.sin(pos.azimuth) * Math.cos(alt), Math.sin(alt), Math.cos(pos.azimuth) * Math.cos(alt));
    this.w.setSun(dir, key.sun, key.si * dim, { sky: key.sky, ground: key.ground, intensity: key.hi * (1 + this.cloud * 0.15) });
    // MapLibre's own light for the real buildings, from the same sun.
    const az = ((pos.azimuth * 180) / Math.PI + 180 + 360) % 360;
    const polar = Math.max(10, Math.min(85, 90 - Math.max(altDeg, 15)));
    try {
      this.map.setLight({ anchor: 'map', position: [1.4, az, polar], color: key.sun, intensity: Math.max(0.12, 0.32 * dim * (1 - night * 0.6)) });
      const grey = (c: string) => '#' + new THREE.Color(c).lerp(new THREE.Color('#b8bcc4'), this.cloud * 0.6 + this.rain * 0.2).getHexString();
      (this.map as any).setSky?.({ 'sky-color': grey(key.skyColor), 'horizon-color': grey(key.horizon), 'sky-horizon-blend': 0.6, 'horizon-fog-blend': 0.6, 'fog-color': grey(key.horizon), 'fog-ground-blend': 0.9, 'atmosphere-blend': 0.5 });
      let p = blendPalette(this.day, NIGHT, night * 0.92);
      if (this.rain > 0) p = wetPalette(p, this.rain);
      if (this.snow > 0) p = blendPalette(p, { ...p, land: '#f4f6f8', park: '#e8eef0', buildingTop: '#ffffff' }, this.snow * 0.6);
      applyPalette(this.map, p);
    } catch {
      /* style not ready yet; the next update will do it */
    }
    sound.setAmbience({ rain: this.rain });
  }

  // Lamp posts every ~32 m along the main roads near the camera.
  private placeLamps() {
    this.lampsAt = performance.now();
    if (NO_LAMPS) {
      this.lamps = [];
      return;
    }
    const lanes = this.w.vehicles?.lanes ?? [];
    const out: { p: THREE.Vector3; yaw: number }[] = [];
    for (const l of lanes) {
      let side = 1;
      for (let d = 10; d < l.total; d += 32) {
        let i = 1;
        while (i < l.len.length - 1 && l.len[i] < d) i++;
        const a = l.pts[i - 1];
        const b = l.pts[i];
        const k = (d - l.len[i - 1]) / Math.max(0.001, l.len[i] - l.len[i - 1]);
        const p = new THREE.Vector3().lerpVectors(a, b, k);
        const yaw = Math.atan2(b.x - a.x, b.z - a.z);
        p.x += Math.cos(yaw) * 7 * side;
        p.z -= Math.sin(yaw) * 7 * side;
        out.push({ p, yaw: yaw + (side > 0 ? Math.PI / 2 : -Math.PI / 2) });
        side = -side;
        if (out.length > 260) break;
      }
    }
    this.lamps = out;
  }

  private frame(dt: number) {
    const zoom = this.map.getZoom();
    if (zoom < 15.5) return;
    if (performance.now() - this.lampsAt > 9000) this.placeLamps();
    const P = this.w.pools;
    const c = this.map.getCenter();
    const center = this.w.local(c.lat, c.lng);
    const near = (p: THREE.Vector3, r: number) => Math.abs(p.x - center.x) < r && Math.abs(p.z - center.z) < r;
    const lit = this.night > 0.3 || this.rain > 0.6;
    const sea = season();
    let n = 0;
    for (const l of this.lamps) {
      if (!near(l.p, 380)) continue;
      this.q.setFromAxisAngle(this.y, l.yaw);
      this.m.compose(l.p, this.q, this.s.set(1.3, 1.3, 1.3));
      P.get('lamp', () => this.props.lamp).add(this.m);
      if (lit) {
        P.get('lamp-glow', () => this.props.lampGlow, 'glow').add(this.m);
        // A warm pool of light on the pavement.
        const off = this.v.set(Math.sin(l.yaw) * 1.6, 0, Math.cos(l.yaw) * 1.6).add(l.p);
        this.m.compose(off, this.q.identity(), this.s.set(5.5, 1, 5.5));
        P.get('halo', () => this.extra.halo, 'halo', true).add(this.m, this.col.set('#ffd38a').multiplyScalar(0.9 * this.night));
      }
      if (sea.winter) {
        this.q.setFromAxisAngle(this.y, l.yaw);
        this.m.compose(l.p, this.q, this.s.set(1.3, 1.3, 1.3));
        P.get('lamp-lights', () => this.extra.lampLights, 'glow').add(this.m);
        if (n % 9 === 4) {
          this.m.compose(this.v.set(l.p.x + 4, 0, l.p.z + 4), this.q.identity(), this.s.set(1.2, 1.2, 1.2));
          P.get('xmas-tree', () => this.extra.tree).add(this.m);
          P.get('xmas-lights', () => this.extra.treeLights, 'glow').add(this.m);
        }
      }
      // Events dress the street.
      if (this.event === 'festival' && n % 2 === 0) {
        this.q.setFromAxisAngle(this.y, l.yaw + Math.PI / 2);
        this.m.compose(this.v.set(l.p.x, 7.5, l.p.z), this.q, this.s.set(1, 1, 1));
        P.get('bunting', () => this.extra.bunting).add(this.m);
      }
      if (this.event === 'marathon' && n % 2 === 1) {
        this.q.setFromAxisAngle(this.y, l.yaw);
        this.m.compose(this.v.set(l.p.x - Math.sin(l.yaw) * 2, 0, l.p.z - Math.cos(l.yaw) * 2), this.q, this.s.set(1, 1, 1));
        P.get('barrier', () => this.extra.barrier).add(this.m);
      }
      n++;
    }
    // Your businesses glow gold at night; restaurant-week and sale banners;
    // pumpkins at Halloween.
    for (const b of this.w.businessList()) {
      if (!near(b.pos, 420)) continue;
      if (b.info.mine && this.night > 0.2) {
        const r = Math.max(6, b.model.radius * b.scale * 1.4);
        this.m.compose(this.v.set(b.pos.x, 0, b.pos.z), this.q.identity(), this.s.set(r, 1, r));
        P.get('halo', () => this.extra.halo, 'halo', true).add(this.m, this.col.set('#f2c14b').multiplyScalar(0.85 * this.night));
      }
      const front = (dist: number) => this.v.set(b.pos.x + Math.sin(b.yaw) * dist, 0, b.pos.z + Math.cos(b.yaw) * dist);
      if ((this.event === 'food_week' && b.info.kind === 'restaurant') || (this.event === 'sale_season' && ['grocery', 'furniture_store', 'electronics_store'].includes(b.info.kind))) {
        this.q.setFromAxisAngle(this.y, b.yaw);
        this.m.compose(front(b.model.front * b.scale * 0.6).add(this.s.set(Math.cos(b.yaw) * 5, 0, -Math.sin(b.yaw) * 5)), this.q, this.s.set(1.3, 1.3, 1.3));
        P.get('banner-' + this.event, () => {
          const g = this.extra.banner.clone();
          if (this.event === 'food_week') recolour(g, '#c9302c', TIER_COLORS[2]);
          return g;
        }).add(this.m);
      }
      if (sea.halloween && b.model.front > 0) {
        this.m.compose(front(b.model.front * b.scale * 0.5).add(this.s.set(Math.cos(b.yaw) * 2.5, 0, -Math.sin(b.yaw) * 2.5)), this.q.identity(), this.s.set(1, 1, 1));
        P.get('pumpkin', () => this.extra.pumpkin).add(this.m);
      }
    }
    this.drawWeather(dt, center);
  }

  // Rain streaks or snowflakes in a box around the camera; skipped on
  // Battery saver.
  private drawWeather(dt: number, center: THREE.Vector3) {
    const amount = Math.max(this.rain, this.snow);
    if (amount <= 0 || this.w.quality === 'saver') return;
    const count = Math.round((this.w.quality === 'high' ? 900 : 450) * amount);
    if (this.drops.length !== count * 3) {
      this.drops = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        this.drops[i * 3] = (Math.random() - 0.5) * 300;
        this.drops[i * 3 + 1] = Math.random() * 70;
        this.drops[i * 3 + 2] = (Math.random() - 0.5) * 300;
      }
    }
    const snow = this.snow > this.rain;
    const pool = snow ? this.w.pools.get('flake', () => this.extra.flake, 'glow') : this.w.pools.get('streak', () => this.extra.streak, 'glow');
    const fall = snow ? 4 : 48;
    const t = performance.now() / 1000;
    for (let i = 0; i < count; i++) {
      let y = this.drops[i * 3 + 1] - fall * dt;
      if (y < 0) y += 70;
      this.drops[i * 3 + 1] = y;
      const x = center.x + this.drops[i * 3] + (snow ? Math.sin(t + i) * 2 : y * 0.08);
      const z = center.z + this.drops[i * 3 + 2];
      this.m.compose(this.v.set(x, y, z), this.q.identity(), this.s.set(1, snow ? 1 : 1.4, 1));
      pool.add(this.m);
    }
  }
}

function recolour(g: THREE.BufferGeometry, from: string, to: string) {
  const a = new THREE.Color(from);
  const b = new THREE.Color(to);
  const c = g.getAttribute('color') as THREE.BufferAttribute;
  for (let i = 0; i < c.count; i++) {
    if (Math.abs(c.getX(i) - a.r) < 0.02 && Math.abs(c.getY(i) - a.g) < 0.02 && Math.abs(c.getZ(i) - a.b) < 0.02) c.setXYZ(i, b.r, b.g, b.b);
  }
}
