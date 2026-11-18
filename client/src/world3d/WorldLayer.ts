// The 3D world: Three.js drawn inside MapLibre as a custom layer, sharing its
// camera, canvas and depth buffer (so real buildings hide models behind
// them). Owns the scene, lights, materials, instanced pools and everything
// that moves: players, the crowd, businesses, steam, coins.
//
// Local coordinates are metres from the city's start point: x east, y up,
// z south.
import * as THREE from 'three';
import { MercatorCoordinate, type CustomLayerInterface, type Map as MLMap } from 'maplibre-gl';
import type { CityData } from '../lib/citydata';
import { Pools } from './pool';
import { charParts, accentParts, hatParts, walkerParts, carryParts, groundParts, blobShadow, OUTFITS, SKIN_TONES, CHAR, type Outfit } from './people';
import { businessModel, propParts, ROOM_KINDS, type BizState, type ModelDef } from './models';
import { box } from './kit';
import { Vehicles } from './vehicles';
import { CrowdSim, type ShopSpot, type Walker } from './crowd3d';
import type { Quality } from '../lib/settings';

export interface BizInfo {
  id: number;
  kind: string;
  tier: number;
  level: number;
  status: string;
  mine: boolean;
  lat: number;
  lng: number;
  name?: string;
  crop?: string | null;
  fill?: number;
  resource?: string | null;
}

export interface CharInfo {
  key: string; // 'me' or 'p:<player_no>'
  lat: number;
  lng: number;
  skin: string;
  ring: string; // ring colour
  double: boolean;
  skinTone: number;
}

export interface MeInfo extends CharInfo {
  moving: boolean;
}

const QUALITY: Record<Quality, { people: number; pixelRatio: number; fps: number; particles: boolean }> = {
  high: { people: 300, pixelRatio: 2, fps: 60, particles: true },
  medium: { people: 150, pixelRatio: 1.5, fps: 60, particles: true },
  saver: { people: 50, pixelRatio: 1, fps: 30, particles: false },
};

const PEOPLE_SCALE = 1.25; // characters are ~3.5x real size so they read at street zoom
const KIND_SCALE: Record<string, number> = { cart: 1.7 };
const ROOM_SCALE = 1.3;

const WALKER_CLOTHES = ['#e3694d', '#3f8ed6', '#f3c443', '#2f6f5e', '#8a5cc2', '#e58fb0', '#4a4a4a', '#6aa84f', '#d9822b', '#5b6c8c', '#f6efe0', '#9b2d2d'];
const WALKER_LEGS = ['#2c3440', '#3d4f6b', '#5a4630', '#1d1f2e', '#7a7468'];
const HAIR = ['#2b1d17', '#3b2a20', '#8c5a30', '#d9b56a', '#6a645a'];

interface Particle { kind: 'puff' | 'smoke' | 'coin' | 'dust'; x: number; y: number; z: number; vx: number; vy: number; vz: number; age: number; life: number; size: number }

interface CharState { pos: THREE.Vector3; target: THREE.Vector3; yaw: number; speed: number; phase: number; idle: number; anim: Anim; animT: number; info: CharInfo; seen: number }
export type Anim = 'idle' | 'walk' | 'run' | 'wave' | 'cheer' | 'sit' | 'phone';

export interface BizState3D { info: BizInfo; pos: THREE.Vector3; yaw: number; model: ModelDef; scale: number; spot: ShopSpot | null; born: number; grow: number; vendorWave: number }

export class WorldLayer implements CustomLayerInterface {
  id = 'world3d';
  type = 'custom' as const;
  renderingMode = '3d' as const;

  map!: MLMap;
  renderer!: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera = new THREE.Camera();
  sun = new THREE.DirectionalLight('#fff1d6', 2.2);
  hemi = new THREE.HemisphereLight('#fff6e8', '#9a8f78', 1.25);
  materials!: Record<string, THREE.Material>;
  pools!: Pools;
  crowd: CrowdSim;
  origin: MercatorCoordinate;
  private s: number;
  private gridX0 = 0;
  private gridAx = 1;
  private gridZ0 = 0;
  private gridAz = -1;
  private biz = new Map<number, BizState3D>();
  private pendingBuilds = new Set<number>();
  private chars = new Map<string, CharState>();
  private particles: Particle[] = [];
  private last = 0;
  private time = 0;
  quality: Quality = 'high';
  private frames = 0;
  private fpsT = 0;
  fps = 60;
  private lowFor = 0;
  private highFor = 0;
  autoQuality = true;
  onQuality?: (q: Quality) => void;
  onPaid?: (biz: BizInfo, amount: number, screen: { x: number; y: number } | null) => void;
  night = 0; // 0 day .. 1 night, set by the living-city code
  rainK = 0; // how hard it's raining (umbrellas come out)
  eventKind: string | null = null;
  private parts = {
    char: charParts(),
    acc: accentParts(),
    hats: hatParts(),
    walk: walkerParts(),
    carry: carryParts(),
    ground: groundParts(),
    props: propParts(),
  };
  hourLevel = 1;
  eventMult = 1;
  extraDraw: ((dt: number) => void)[] = []; // hooks for the living city (lamps, weather, vehicles)
  lastStats = { calls: 0, tris: 0 };
  vehicles!: Vehicles;
  private tmp = new THREE.Matrix4();
  private tmp2 = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private v = new THREE.Vector3();
  private sc = new THREE.Vector3();
  private col = new THREE.Color();
  private yAxis = new THREE.Vector3(0, 1, 0);
  private xAxis = new THREE.Vector3(1, 0, 0);
  private zAxis = new THREE.Vector3(0, 0, 1);
  // Scratch objects: drawing allocates nothing per frame (iPad GC pauses).
  private mBase = new THREE.Matrix4();
  private mPart = new THREE.Matrix4();
  private mOut = new THREE.Matrix4();
  private qPart = new THREE.Quaternion();
  private vPart = new THREE.Vector3();
  private one = new THREE.Vector3(1, 1, 1);
  private ePart = new THREE.Euler();

  constructor(
    public city: CityData,
    private getMe: () => MeInfo | null,
  ) {
    const st = city.meta.start;
    this.origin = MercatorCoordinate.fromLngLat([st.lng, st.lat], 0);
    this.s = this.origin.meterInMercatorCoordinateUnits();
    // City grid metres -> local metres (x depends only on longitude, z only
    // on latitude; linear over a city's few kilometres).
    const m = city.meta;
    const p0 = this.local(m.origin[1] + (st.lat - m.origin[1]), m.origin[0]);
    const pxA = this.local(st.lat, m.origin[0] + 1000 / m.kx);
    const pyA = this.local(st.lat + 1000 / m.ky, m.origin[0]);
    this.gridAx = (pxA.x - p0.x) / 1000;
    this.gridX0 = p0.x;
    const gyStart = (st.lat - m.origin[1]) * m.ky;
    this.gridAz = (pyA.z - p0.z) / 1000;
    this.gridZ0 = p0.z - this.gridAz * gyStart;
    this.crowd = new CrowdSim(city);
    this.crowd.onPaid = (w) => this.paid(w);
  }

  // ---------- coordinates ----------
  local(lat: number, lng: number, out = new THREE.Vector3()) {
    const mc = MercatorCoordinate.fromLngLat([lng, lat], 0);
    return out.set((mc.x - this.origin.x) / this.s, 0, (mc.y - this.origin.y) / this.s);
  }
  gridToLocal(gx: number, gy: number, out = new THREE.Vector3()) {
    return out.set(this.gridX0 + this.gridAx * gx, 0, this.gridZ0 + this.gridAz * gy);
  }
  latLngToGrid(lat: number, lng: number) {
    const m = this.city.meta;
    return { gx: (lng - m.origin[0]) * m.kx, gy: (lat - m.origin[1]) * m.ky };
  }
  // A grid heading (0 = east, counter-clockwise) as a yaw for models that face +z.
  static yawOf(heading: number) {
    return Math.atan2(Math.cos(heading), -Math.sin(heading));
  }
  screenOf(p: THREE.Vector3) {
    const mc = new MercatorCoordinate(this.origin.x + p.x * this.s, this.origin.y + p.z * this.s, 0);
    const pt = this.map.project(mc.toLngLat());
    return { x: pt.x, y: pt.y };
  }

  // ---------- MapLibre hooks ----------
  onAdd(map: MLMap, gl: WebGLRenderingContext | WebGL2RenderingContext) {
    this.map = map;
    this.renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl as WebGL2RenderingContext, antialias: true });
    this.renderer.autoClear = false;
    this.materials = {
      solid: new THREE.MeshLambertMaterial({ vertexColors: true }),
      glow: new THREE.MeshBasicMaterial({ vertexColors: true }),
      shadow: new THREE.MeshBasicMaterial({ color: '#2a2418', transparent: true, opacity: 0.22, depthWrite: false }),
      puff: new THREE.MeshLambertMaterial({ color: '#ffffff', transparent: true, opacity: 0.75, depthWrite: false }),
      ringGlow: new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9 }),
      halo: new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false }),
    };
    this.pools = new Pools(this.scene, this.materials);
    this.scene.add(this.hemi, this.sun, this.sun.target);
    this.vehicles = new Vehicles(this);
    this.setSun(new THREE.Vector3(-0.5, 0.8, 0.4));
  }

  onRemove() {
    this.pools?.dispose();
    for (const m of Object.values(this.materials ?? {})) m.dispose();
  }

  setSun(dir: THREE.Vector3, color?: THREE.ColorRepresentation, intensity?: number, hemi?: { sky: THREE.ColorRepresentation; ground: THREE.ColorRepresentation; intensity: number }) {
    this.sun.position.copy(dir).normalize().multiplyScalar(100);
    this.sun.target.position.set(0, 0, 0);
    if (color) this.sun.color.set(color);
    if (intensity != null) this.sun.intensity = intensity;
    if (hemi) {
      this.hemi.color.set(hemi.sky);
      this.hemi.groundColor.set(hemi.ground);
      this.hemi.intensity = hemi.intensity;
    }
    // Lit windows and signs glow brighter as night falls.
    const k = 0.45 + this.night * 0.9;
    (this.materials?.glow as THREE.MeshBasicMaterial | undefined)?.color.setRGB(k, k, k);
  }

  setQuality(q: Quality) {
    this.quality = q;
    const pr = Math.min(window.devicePixelRatio || 1, QUALITY[q].pixelRatio);
    if (Math.abs(this.map.getPixelRatio() - pr) > 0.01) this.map.setPixelRatio(pr);
  }

  // ---------- data in ----------
  setBusinesses(list: BizInfo[]) {
    const seen = new Set<number>();
    for (const b of list) {
      seen.add(b.id);
      const state: BizState = b.status === 'open' ? 'open' : b.status === 'abandoned' ? 'abandoned' : b.status === 'depleted' ? 'depleted' : 'closed';
      const model = businessModel(b.kind, b.tier, b.level, state, { crop: b.crop, fill: b.fill, resource: b.resource });
      const cur = this.biz.get(b.id);
      if (cur && cur.model.key === model.key && cur.info.lat === b.lat && cur.info.lng === b.lng) {
        cur.info = b;
        continue;
      }
      const room = ROOM_KINDS.has(b.kind);
      const placed = this.placement(b, room, model);
      // The build show plays only for a business you just built.
      const born = cur ? cur.born : this.pendingBuilds.delete(b.id) ? this.time : -10;
      const grew = cur && cur.info.level < b.level ? this.time : cur?.grow ?? -10;
      const spot: ShopSpot | null =
        model.front > 0
          ? {
              id: b.id,
              ...this.latLngToGrid(b.lat, b.lng),
              fx: placed.front.gx * model.front * placed.scale,
              fy: placed.front.gy * model.front * placed.scale,
              mine: b.mine,
              level: b.level,
              customer: !!['cart', 'cafe', 'restaurant', 'grocery', 'furniture_store', 'electronics_store', 'bank'].includes(b.kind) && state === 'open',
            }
          : null;
      if (spot && room) {
        // Shop dressing stands on the building's front wall, by the street.
        spot.gx = placed.gx;
        spot.gy = placed.gy;
      }
      this.biz.set(b.id, { info: b, pos: placed.pos, yaw: placed.yaw, model, scale: placed.scale, spot, born, grow: grew, vendorWave: -10 });
    }
    for (const id of [...this.biz.keys()]) if (!seen.has(id)) this.biz.delete(id);
    this.crowd.shops = [...this.biz.values()].map((b) => b.spot).filter(Boolean) as ShopSpot[];
  }

  // Face carts and shopfronts toward the most open side (the street).
  private placement(b: BizInfo, room: boolean, model: ModelDef) {
    let { gx, gy } = this.latLngToGrid(b.lat, b.lng);
    const scale = room ? ROOM_SCALE : KIND_SCALE[b.kind] ?? 1;
    if (room) {
      // Shop dressing stands against its building's front wall, facing the
      // street. The point may be inside the building (walk out to the
      // street) or on the pavement outside (walk in to the wall).
      const inside = !this.crowd.walkable(gx, gy);
      let found: { gx: number; gy: number; ang: number } | null = null;
      for (let r = 2; r <= 40 && !found; r += 2)
        for (let a = 0; a < 24; a++) {
          const ang = (a / 24) * Math.PI * 2;
          const x = gx + Math.cos(ang) * r;
          const y = gy + Math.sin(ang) * r;
          if (this.crowd.walkable(x, y) === inside) {
            // inside: first street point, facing out along ang.
            // outside: first wall point; stand just before it, facing back.
            found = inside ? { gx: x, gy: y, ang } : { gx: x - Math.cos(ang) * 2.5, gy: y - Math.sin(ang) * 2.5, ang: ang + Math.PI };
            break;
          }
        }
      if (found) {
        // Snap the face to the nearest right angle if the street is straight there.
        const pos = this.gridToLocal(found.gx, found.gy);
        return { pos, yaw: WorldLayer.yawOf(found.ang), front: { gx: Math.cos(found.ang), gy: Math.sin(found.ang) }, gx: found.gx, gy: found.gy, scale };
      }
    }
    let bestA = 0;
    let bestOpen = -1;
    for (let a = 0; a < 16; a++) {
      const ang = (a / 16) * Math.PI * 2;
      let open = 0;
      for (let r = 2; r <= 14; r += 2) if (this.crowd.walkable(gx + Math.cos(ang) * r, gy + Math.sin(ang) * r)) open++;
      if (open > bestOpen + 0.5 || (open === bestOpen && Math.abs(Math.sin(ang)) > Math.abs(Math.sin(bestA)))) {
        bestOpen = open;
        bestA = ang;
      }
    }
    if (model.front <= 0 || !['cart'].includes(b.kind)) bestA = Math.round(bestA / (Math.PI / 2)) * (Math.PI / 2);
    return { pos: this.gridToLocal(gx, gy), yaw: WorldLayer.yawOf(bestA), front: { gx: Math.cos(bestA), gy: Math.sin(bestA) }, gx, gy, scale };
  }

  setPlayers(list: CharInfo[]) {
    const now = this.time;
    for (const p of list) {
      const target = this.local(p.lat, p.lng);
      const c = this.chars.get(p.key);
      if (c) {
        c.target.copy(target);
        c.info = p;
        c.seen = now;
      } else this.chars.set(p.key, { pos: target.clone(), target, yaw: 0, speed: 0, phase: 0, idle: Math.random() * 5, anim: 'idle', animT: 0, info: p, seen: now });
    }
    for (const [k, c] of this.chars) if (k !== 'me' && now - c.seen > 1 && !list.some((p) => p.key === k)) this.chars.delete(k);
  }

  // A sale at one of your businesses: customers walk up and pay.
  sale(businessId: number, sold: number, revenue: number): boolean {
    const b = this.biz.get(businessId);
    if (!b?.spot || this.map.getZoom() < 15.5) return false;
    const center = this.map.getCenter();
    const c = this.latLngToGrid(center.lat, center.lng);
    if (Math.hypot(b.spot.gx - c.gx, b.spot.gy - c.gy) > this.crowd.radius * 1.3) return false;
    this.crowd.sale(b.spot, sold, revenue);
    return true;
  }

  private paid(w: Walker) {
    const b = this.biz.get(w.shop!.id);
    if (!b) return;
    b.vendorWave = this.time;
    const p = this.gridToLocal(w.gx, w.gy);
    this.particles.push({ kind: 'coin', x: p.x, y: 5.5 * PEOPLE_SCALE, z: p.z, vx: 0, vy: 4.5, vz: 0, age: 0, life: 1.1, size: 1.4 });
    this.onPaid?.(b.info, w.shop!.amount, this.screenOf(new THREE.Vector3(b.pos.x, 6, b.pos.z)));
  }

  // A van delivers to one of your businesses; a ship leaves your port.
  delivery(businessId: number) {
    const b = this.biz.get(businessId);
    if (b) this.vehicles.delivery(b.pos, b.yaw);
  }
  shipOut(businessId: number) {
    const b = this.biz.get(businessId);
    if (b) this.vehicles.ship(b.pos, b.yaw);
  }

  // Player character moments: cheer for a big moment, wave hello.
  emote(anim: Anim, key = 'me') {
    const c = this.chars.get(key);
    if (c) {
      c.anim = anim;
      c.animT = 0;
    }
  }

  // Build dust and the level-up bounce are shown by the business itself.
  celebrateBuild(businessId: number) {
    const b = this.biz.get(businessId);
    if (b) b.born = this.time;
    else this.pendingBuilds.add(businessId); // starts when it arrives on the map
  }

  businessList() {
    return this.biz.values();
  }

  // Tap picking: the business whose model is under the point, if any.
  pick(x: number, y: number): BizInfo | null {
    if (this.map.getZoom() < 15) return null;
    const mpp = (40075016.686 * Math.cos((this.map.getCenter().lat * Math.PI) / 180)) / (512 * Math.pow(2, this.map.getZoom()));
    const ppm = 1 / mpp;
    const tilt = Math.sin((this.map.getPitch() * Math.PI) / 180);
    let best: { b: BizInfo; d: number } | null = null;
    for (const b of this.biz.values()) {
      const g = this.screenOf(b.pos);
      const hpx = b.model.height * b.scale * ppm * tilt;
      const r = b.model.radius * b.scale * ppm * 0.8 + 14;
      // distance from the tap to the segment from the base up to the top
      const ty = Math.max(g.y - hpx, Math.min(g.y, y));
      const d = Math.hypot(x - g.x, y - ty);
      if (d < r && (!best || d < best.d)) best = { b: b.info, d };
    }
    return best?.b ?? null;
  }

  // ---------- frame ----------
  prerender() {}

  render(_gl: WebGLRenderingContext | WebGL2RenderingContext, matrix: any) {
    const now = performance.now() / 1000;
    const dt = Math.min(0.1, this.last ? now - this.last : 0.016);
    this.last = now;
    this.time += dt;
    this.measure(dt);

    const zoom = this.map.getZoom();
    const show = zoom >= 14.5;
    const close = zoom >= 16;
    const q = QUALITY[this.quality];

    this.pools.begin();
    if (show) {
      const center = this.map.getCenter();
      const cg = this.latLngToGrid(center.lat, center.lng);
      const b = this.map.getBounds();
      const radius = Math.min(420, Math.max(80, (Math.hypot(b.getEast() - b.getWest(), b.getNorth() - b.getSouth()) * 0.5 * this.city.meta.ky) * 0.6));
      const cLocal = this.gridToLocal(cg.gx, cg.gy);
      this.drawBusinesses(dt, close, cLocal, radius * 1.6);
      if (zoom >= 15) this.drawChars(dt);
      if (close && this.city.walk) {
        this.crowd.setView(cg.gx, cg.gy, radius, this.hourLevel, q.people, this.eventMult);
        this.crowd.update(dt);
        this.drawCrowd();
      }
      if (q.particles || this.particles.some((p) => p.kind === 'coin')) this.drawParticles(dt, close && q.particles);
      for (const f of this.extraDraw) f(dt);
    }
    this.pools.end();
    this.lastStats = this.pools.stats();

    const m = new THREE.Matrix4().fromArray(matrix);
    const l = new THREE.Matrix4()
      .makeTranslation(this.origin.x, this.origin.y, this.origin.z)
      .scale(new THREE.Vector3(this.s, -this.s, this.s))
      .multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2));
    this.camera.projectionMatrix = m.multiply(l);
    this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix).invert();
    this.renderer.resetState();
    this.renderer.render(this.scene, this.camera);

    // Keep animating while there's something moving on screen.
    if (show && !document.hidden) {
      if (q.fps < 60) setTimeout(() => this.map.triggerRepaint(), 1000 / q.fps - 4);
      else this.map.triggerRepaint();
    }
  }

  // Auto graphics: step down if it can't hold 45 fps for 5 s, back up after
  // 30 s above 58.
  private measure(dt: number) {
    this.frames++;
    this.fpsT += dt;
    if (this.fpsT < 1) return;
    this.fps = this.frames / this.fpsT;
    this.frames = 0;
    this.fpsT = 0;
    if (!this.autoQuality || this.map.getZoom() < 15.5) return;
    const order: Quality[] = ['saver', 'medium', 'high'];
    const i = order.indexOf(this.quality);
    if (this.fps < 45 && this.quality !== 'saver') {
      this.lowFor++;
      this.highFor = 0;
      if (this.lowFor >= 5) {
        this.lowFor = 0;
        this.setQuality(order[i - 1]);
        this.onQuality?.(this.quality);
      }
    } else if (this.fps > 58 && this.quality !== 'high') {
      this.highFor++;
      this.lowFor = 0;
      if (this.highFor >= 30) {
        this.highFor = 0;
        this.setQuality(order[i + 1]);
        this.onQuality?.(this.quality);
      }
    } else {
      this.lowFor = 0;
      this.highFor = 0;
    }
  }

  // ---------- businesses ----------
  private drawBusinesses(dt: number, close: boolean, center: THREE.Vector3, range: number) {
    const shadow = this.pools.get('shadow', blobShadow, 'shadow');
    const mineRing = this.pools.get('minering', () => this.parts.ground.ring2, 'ringGlow', true);
    for (const b of this.biz.values()) {
      if (Math.hypot(b.pos.x - center.x, b.pos.z - center.z) > range + b.model.radius * 2) continue;
      // Pop up after the build show, and bounce when levelling up.
      const sinceBorn = this.time - b.born;
      const sinceGrow = this.time - b.grow;
      let k = 1;
      if (sinceBorn >= 0 && sinceBorn < 2.6) {
        k = sinceBorn < 2 ? 0 : easeOutBack(Math.min(1, (sinceBorn - 2) / 0.6));
        this.buildShow(b, sinceBorn);
      } else if (sinceGrow >= 0 && sinceGrow < 0.8) k = 1 + Math.sin((sinceGrow / 0.8) * Math.PI) * 0.12;
      if (k <= 0.001) continue;
      const s = b.scale * k;
      this.q.setFromAxisAngle(this.yAxis, b.yaw);
      this.tmp.compose(b.pos, this.q, this.sc.set(s, s, s));
      this.pools.get('b:' + b.model.key, () => b.model.base).add(this.tmp);
      if (b.model.glow) this.pools.get('g:' + b.model.key, () => b.model.glow!, 'glow').add(this.tmp);
      const r = b.model.radius * b.scale;
      if (!ROOM_KINDS.has(b.info.kind)) {
        this.tmp2.compose(this.v.set(b.pos.x, 0, b.pos.z), this.q, this.sc.set(r, 1, r * 0.8));
        shadow.add(this.tmp2);
      }
      if (b.info.mine) {
        this.col.set('#f2c14b');
        const rr = (r / 1.85) * 1.05;
        this.tmp2.compose(this.v.set(b.pos.x, 0.05, b.pos.z), this.q, this.sc.set(rr, 1, rr));
        mineRing.add(this.tmp2, this.col);
      }
      if (!close) continue;
      // Moving parts.
      for (const mp of b.model.moving) {
        const pool = this.pools.get(`m:${mp.key}`, () => mp.geo);
        const t = this.time * mp.speed + b.info.id;
        const local = this.mPart;
        if (mp.kind === 'grow') {
          // crops ripen, trees grow, get cut and replanted
          const cyc = ((this.time * mp.speed + (mp.amp ?? 0)) % 1 + 1) % 1;
          const g = cyc < 0.85 ? 0.15 + (cyc / 0.85) * 0.85 : Math.max(0.05, 1 - (cyc - 0.85) * 6.5);
          local.compose(this.vPart.set(...mp.at), this.qPart.identity(), this.sc.set(1, g, 1));
        } else if (mp.kind === 'drive') {
          const d = Math.sin(t) * (mp.amp ?? 4);
          const facing = Math.cos(t) >= 0 ? 0 : Math.PI;
          local.compose(this.vPart.set(mp.at[0] + (mp.axis === 'x' ? d : 0), mp.at[1], mp.at[2] + (mp.axis === 'z' ? d : 0)), this.qPart.setFromAxisAngle(this.yAxis, facing), this.one);
        } else {
          const ang = mp.kind === 'spin' ? t : Math.sin(t) * (mp.amp ?? 0.3);
          const axis = mp.axis === 'x' ? this.xAxis : mp.axis === 'y' ? this.yAxis : this.zAxis;
          local.compose(this.vPart.set(...mp.at), this.qPart.setFromAxisAngle(axis, ang), this.one);
        }
        pool.add(this.tmp2.multiplyMatrices(this.tmp, local));
      }
      // Steam from cooking, smoke from running industry.
      if (b.info.status === 'open' && QUALITY[this.quality].particles) {
        for (const p of b.model.steam) if (Math.random() < dt * 1.6) this.emit('puff', b, p);
        for (const p of b.model.smoke) if (Math.random() < dt * 1.2) this.emit('smoke', b, p);
      }
      // The vendor behind the counter waves at each sale.
      if (b.model.vendor && b.info.status === 'open') {
        const vp = new THREE.Vector3(...b.model.vendor).multiplyScalar(b.scale).applyQuaternion(this.q).add(b.pos);
        const waving = this.time - b.vendorWave < 1.4;
        this.drawCharacter(vp, b.yaw, waving ? 'wave' : 'idle', this.time - b.vendorWave, this.time + b.info.id, VENDOR, 1, null, false, 0.9);
      }
    }
  }

  // Scaffolding, a little crane and hammering, then a puff of dust.
  private buildShow(b: BizState3D, t: number) {
    const r = Math.max(2.5, b.model.radius * b.scale * 0.55);
    if (t < 2) {
      const rise = Math.min(1, t / 0.6);
      this.q.setFromAxisAngle(this.yAxis, b.yaw);
      this.tmp.compose(b.pos, this.q, this.sc.set(r / 2.6, Math.max(0.05, rise) * (b.model.height * b.scale) / 6, r / 2.6));
      this.pools.get('scaffold', () => this.parts.props.scaffold).add(this.tmp);
      this.tmp.compose(this.v.set(b.pos.x + r, 0, b.pos.z - r), new THREE.Quaternion().setFromAxisAngle(this.yAxis, t * 1.2), this.sc.set(1, rise, 1));
      this.pools.get('crane', () => this.parts.props.crane).add(this.tmp);
    } else if (t < 2.1 && !(b as any)._dusted) {
      (b as any)._dusted = true;
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * Math.PI * 2;
        this.particles.push({ kind: 'dust', x: b.pos.x + Math.cos(a) * r * 0.6, y: 0.5, z: b.pos.z + Math.sin(a) * r * 0.6, vx: Math.cos(a) * 3, vy: 1.2, vz: Math.sin(a) * 3, age: 0, life: 1.1, size: 1.6 });
      }
    }
  }

  private emit(kind: 'puff' | 'smoke', b: BizState3D, p: [number, number, number]) {
    if (this.particles.length > 260) return;
    const v = new THREE.Vector3(...p).multiplyScalar(b.scale).applyAxisAngle(this.yAxis, b.yaw).add(b.pos);
    this.particles.push({ kind, x: v.x, y: v.y, z: v.z, vx: (Math.random() - 0.5) * 0.4, vy: kind === 'smoke' ? 2.2 : 1.4, vz: (Math.random() - 0.5) * 0.4, age: 0, life: kind === 'smoke' ? 4 : 1.8, size: kind === 'smoke' ? 1.6 : 0.5 });
  }

  private drawParticles(dt: number, show: boolean) {
    const puff = this.pools.get('puff', () => this.parts.props.puff, 'puff');
    const smoke = this.pools.get('smoke', () => this.parts.props.smoke, 'puff');
    const coin = this.pools.get('coin', () => this.parts.props.coin);
    const dust = this.pools.get('dust', () => this.parts.props.dust, 'puff');
    this.particles = this.particles.filter((p) => (p.age += dt) < p.life);
    for (const p of this.particles) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      const k = p.age / p.life;
      if (p.kind === 'coin') {
        p.vy -= 6 * dt;
        this.tmp.compose(this.v.set(p.x, p.y, p.z), this.q.setFromAxisAngle(this.yAxis, p.age * 12), this.sc.setScalar(p.size * (k > 0.8 ? (1 - k) * 5 : 1)));
        coin.add(this.tmp);
        continue;
      }
      if (!show) continue;
      const s = p.size * (0.6 + k * 1.6) * (k > 0.7 ? (1 - k) / 0.3 : 1);
      this.tmp.compose(this.v.set(p.x, p.y, p.z), this.q.identity(), this.sc.setScalar(Math.max(0.01, s)));
      (p.kind === 'puff' ? puff : p.kind === 'smoke' ? smoke : dust).add(this.tmp);
      if (p.kind === 'dust') {
        p.vx *= 0.92;
        p.vz *= 0.92;
      }
    }
  }

  // ---------- characters ----------
  private drawChars(dt: number) {
    const me = this.getMe();
    if (me) {
      const target = this.local(me.lat, me.lng);
      let c = this.chars.get('me');
      if (!c) {
        c = { pos: target.clone(), target, yaw: 0, speed: 0, phase: 0, idle: 0, anim: 'idle', animT: 0, info: me, seen: this.time };
        this.chars.set('me', c);
      }
      c.info = me;
      c.target.copy(target);
      c.seen = this.time;
    }
    for (const [key, c] of this.chars) {
      if (key === 'me' && this.vehicles?.hideMe) continue; // riding in a taxi
      // Glide toward the latest position instead of jumping.
      const dx = c.target.x - c.pos.x;
      const dz = c.target.z - c.pos.z;
      const d = Math.hypot(dx, dz);
      if (key === 'me') {
        c.pos.copy(c.target); // my walk is already animated by the map
        c.speed = d / Math.max(dt, 0.001) * 0.25 + c.speed * 0.75;
      } else if (d > 0.05) {
        const step = Math.min(d, Math.max(8, d * 2.5) * dt);
        c.pos.x += (dx / d) * step;
        c.pos.z += (dz / d) * step;
        c.speed = step / Math.max(dt, 0.001);
      } else c.speed *= 0.8;
      if (d > 0.05 || c.speed > 1) c.yaw = lerpAngle(c.yaw, Math.atan2(dx || Math.sin(c.yaw), dz || Math.cos(c.yaw)), Math.min(1, dt * 10));
      const moving = c.speed > 1.2 || (key === 'me' && (this.getMe()?.moving ?? false));
      // Special animations run their course, then hand back.
      c.animT += dt;
      if (c.anim === 'wave' || c.anim === 'cheer') {
        if (c.animT > 2.2 || moving) c.anim = 'idle';
      } else if (moving) c.anim = c.speed > 14 ? 'run' : 'walk';
      else if (c.anim === 'walk' || c.anim === 'run') {
        c.anim = 'idle';
        c.idle = 0;
      } else {
        c.idle += dt;
        if (c.idle > 9 && c.anim === 'idle') {
          c.anim = 'phone';
          c.animT = 0;
        }
      }
      if (c.anim === 'phone' && c.animT > 6) {
        c.anim = 'idle';
        c.idle = 0;
      }
      if (moving) c.phase += dt * (c.anim === 'run' ? 11 : 7.5);
      const outfit = OUTFITS[c.info.skin] ?? OUTFITS.classic;
      this.drawCharacter(c.pos, c.yaw, c.anim, c.animT, c.phase, outfit, c.info.skinTone, c.info.ring, c.info.double, PEOPLE_SCALE);
    }
  }

  drawCharacter(pos: THREE.Vector3, yaw: number, anim: Anim, t: number, phase: number, o: Outfit, skinTone: number, ring: string | null, double: boolean, scale: number) {
    const P = this.parts;
    const p = pose(anim, t, phase);
    const base = this.mBase.compose(this.v.set(pos.x, p.lift * scale, pos.z), this.q.setFromAxisAngle(this.yAxis, yaw), this.sc.setScalar(scale));
    const at = (x: number, y: number, z: number, rx = 0, rz = 0, ry = 0) => {
      this.mPart.compose(this.vPart.set(x, y, z), this.qPart.setFromEuler(this.ePart.set(rx, ry, rz)), this.one);
      return this.tmp2.multiplyMatrices(base, this.mPart);
    };
    const c = (hex: string) => this.col.set(hex);
    const hip = CHAR.hip + p.bob;
    this.pools.get('c-leg', () => P.char.leg, 'solid', true).add(at(-CHAR.hipX, hip, 0, p.legL), c(o.legs));
    this.pools.get('c-leg', () => P.char.leg, 'solid', true).add(at(CHAR.hipX, hip, 0, p.legR), c(o.legs));
    const torsoM = this.mOut.copy(at(0, hip, 0, p.lean));
    this.pools.get('c-torso', () => P.char.torso, 'solid', true).add(torsoM, c(o.body));
    if (o.acc) this.pools.get('c-acc-' + o.acc, () => P.acc[o.acc!], 'solid', true).add(torsoM, c(o.accent));
    const sh = hip + CHAR.torso - 0.2;
    this.pools.get('c-arm', () => P.char.arm, 'solid', true).add(at(-CHAR.shoulderX, sh, 0, p.armL, -p.armOutL), c(o.body));
    const armR = this.mOut.copy(at(CHAR.shoulderX, sh, 0, p.armR, p.armOutR));
    this.pools.get('c-arm', () => P.char.arm, 'solid', true).add(armR, c(o.body));
    if (o.watch) this.pools.get('c-watch', () => P.acc.watch, 'solid', true).add(armR, c('#f2c14b'));
    const headM = this.mOut.copy(at(0, hip + CHAR.torso + CHAR.neck, 0, p.headTilt, 0, p.headTurn));
    this.pools.get('c-head', () => P.char.head, 'solid', true).add(headM, c(SKIN_TONES[skinTone % SKIN_TONES.length]));
    if (o.hat) this.pools.get('c-hat-' + o.hat, () => P.hats[o.hat!], 'solid', true).add(headM, c(o.hatColor ?? o.accent));
    else if (o.hair) this.pools.get('c-hair', () => P.char.hair, 'solid', true).add(headM, c(o.hair));
    if (anim === 'phone') this.pools.get('c-phone', () => phoneGeo, 'glow', true).add(at(CHAR.shoulderX * 0.6, sh - 0.2, 0.9, -0.4), c('#9fd3ff'));
    this.tmp.compose(this.v.set(pos.x, 0, pos.z), this.q.identity(), this.sc.set(scale * 1.1, 1, scale * 0.9));
    this.pools.get('shadow', blobShadow, 'shadow').add(this.tmp);
    if (ring) {
      this.tmp.compose(this.v.set(pos.x, 0.04, pos.z), this.q.identity(), this.sc.setScalar(scale));
      this.pools.get('ring', () => P.ground.ring, 'ringGlow', true).add(this.tmp, c(ring));
      if (double) this.pools.get('ring2', () => P.ground.ring2, 'ringGlow', true).add(this.tmp, c(ring));
    }
  }

  // ---------- crowd ----------
  private drawCrowd() {
    const P = this.parts.walk;
    const S = PEOPLE_SCALE;
    for (const w of this.crowd.walkers) {
      const pos = this.gridToLocal(w.gx, w.gy, this.v);
      const yaw = WorldLayer.yawOf(w.heading);
      const moving = w.state === 'walk' || w.state === 'toShop' || w.state === 'leave';
      const bob = moving ? Math.abs(Math.sin(w.phase)) * 0.18 : 0;
      const swing = moving ? Math.sin(w.phase) * 0.55 : 0;
      const px = pos.x;
      const pz = pos.z;
      const base = this.mBase.compose(this.vPart.set(px, 0, pz), this.q.setFromAxisAngle(this.yAxis, yaw), this.sc.setScalar(S));
      const hipY = 1.7 * P.scale + bob;
      const leg = (x: number, a: number) => this.tmp2.multiplyMatrices(base, this.mPart.compose(this.vPart.set(x, hipY, 0), this.qPart.setFromAxisAngle(this.xAxis, a), this.one));
      // Shorts in a heatwave: bare legs.
      const lc = this.col.set(this.eventKind === 'heatwave' && w.id % 2 === 0 ? SKIN_TONES[w.skin] : WALKER_LEGS[w.legs]);
      this.pools.get('w-leg', () => P.leg, 'solid', true).add(leg(-0.3 * P.scale, swing), lc);
      this.pools.get('w-leg', () => P.leg, 'solid', true).add(leg(0.3 * P.scale, -swing), lc);
      const bodyM = this.tmp2.multiplyMatrices(base, this.mPart.makeTranslation(0, hipY, 0));
      this.pools.get('w-body' + w.shape, () => P.bodies[w.shape], 'solid', true).add(bodyM, this.col.set(WALKER_CLOTHES[w.clothes]));
      const bodyH = (w.shape === 2 ? 1.8 : w.shape === 1 ? 1.55 : 1.65) * P.scale;
      // Heads turn toward your menu board as they pass.
      const headM = this.mOut.multiplyMatrices(base, this.mPart.compose(this.vPart.set(0, hipY + bodyH, 0), this.qPart.setFromAxisAngle(this.yAxis, w.slow * 0.6), this.one));
      this.pools.get('w-head', () => P.head, 'solid', true).add(headM, this.col.set(SKIN_TONES[w.skin]));
      this.pools.get('w-hair', () => P.hair, 'solid', true).add(headM, this.col.set(HAIR[w.hair]));
      if (this.rainK > 0.3 && w.id % 3 !== 0 && (w.state === 'walk' || w.state === 'leave' || w.state === 'toShop')) {
        const m = this.tmp2.multiplyMatrices(base, this.mPart.compose(this.vPart.set(0.55, hipY - 0.3, 0.1), this.qPart.identity(), this.sc.setScalar(1.25)));
        this.pools.get('umbrella', () => this.parts.carry.umbrella, 'solid', true).add(m, this.col.set(WALKER_CLOTHES[(w.clothes + 3) % WALKER_CLOTHES.length]));
      } else if (w.carry) {
        const m = this.tmp2.multiplyMatrices(base, this.mPart.makeTranslation(0.95, hipY - 0.9 + bob * 0.5, 0.2));
        if (w.carry === 1) this.pools.get('carry-bag', () => this.parts.carry.bag, 'solid', true).add(m, this.col.set('#e8d9b8'));
        else this.pools.get('carry-cup', () => this.parts.carry.cup, 'solid', true).add(m, this.col.set('#ffffff'));
      }
      this.tmp.compose(this.v.set(px, 0, pz), this.q.identity(), this.sc.set(S * 0.9, 1, S * 0.75));
      this.pools.get('shadow', blobShadow, 'shadow').add(this.tmp);
    }
  }

  stats() {
    const info = this.renderer?.info;
    return {
      fps: Math.round(this.fps),
      quality: this.quality,
      calls: info?.render.calls ?? this.lastStats.calls,
      tris: info?.render.triangles ?? this.lastStats.tris,
      walkers: this.crowd.walkers.length,
      businesses: this.biz.size,
      players: this.chars.size,
      geometries: info?.memory.geometries ?? 0,
      mem: (performance as any).memory ? Math.round((performance as any).memory.usedJSHeapSize / 1048576) : null,
    };
  }
}

const VENDOR: Outfit = { body: '#f6efe0', accent: '#e3694d', legs: '#2c3440', acc: 'stripe', hat: 'cap', hatColor: '#e3694d' };
const phoneGeo = box(0.35, 0.6, 0.08, '#ffffff');

// Joint angles for each animation. t: seconds into the animation; phase: walk cycle.
function pose(anim: Anim, t: number, phase: number) {
  const p = { legL: 0, legR: 0, armL: 0, armR: 0, armOutL: 0.08, armOutR: 0.08, bob: 0, lean: 0, headTilt: 0, headTurn: 0, lift: 0 };
  const s = Math.sin(phase);
  switch (anim) {
    case 'walk':
      p.legL = s * 0.6;
      p.legR = -s * 0.6;
      p.armL = -s * 0.55;
      p.armR = s * 0.55;
      p.bob = Math.abs(s) * 0.12;
      p.lean = 0.06;
      break;
    case 'run':
      p.legL = s * 0.95;
      p.legR = -s * 0.95;
      p.armL = -s * 0.9;
      p.armR = s * 0.9;
      p.bob = Math.abs(s) * 0.3;
      p.lean = 0.2;
      break;
    case 'wave':
      p.armR = Math.PI * 0.95;
      p.armOutR = 0.35 + Math.sin(t * 12) * 0.35;
      p.headTilt = -0.1;
      break;
    case 'cheer': {
      const j = Math.abs(Math.sin(t * 6));
      p.armL = Math.PI * 0.9;
      p.armR = Math.PI * 0.9;
      p.armOutL = 0.45;
      p.armOutR = 0.45;
      p.lift = j * 0.9;
      p.legL = -j * 0.3;
      p.legR = -j * 0.3;
      p.headTilt = -0.25;
      break;
    }
    case 'sit':
      p.legL = -1.4;
      p.legR = -1.4;
      p.bob = -0.9;
      break;
    case 'phone':
      p.armR = -2.5; // forearm up to the face (negative swings forward)
      p.armOutR = -0.35;
      p.headTilt = 0.35;
      p.bob = Math.sin(t * 1.5) * 0.02;
      break;
    default:
      p.bob = Math.sin(t * 2 + phase) * 0.03;
      p.armL = Math.sin(t * 1.3) * 0.05;
      p.armR = -Math.sin(t * 1.3) * 0.05;
  }
  return p;
}

function easeOutBack(k: number) {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(k - 1, 3) + c1 * Math.pow(k - 1, 2);
}

function lerpAngle(a: number, b: number, k: number) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * k;
}
