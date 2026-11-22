// The crowd: walkers who follow the real streets (the city's walkable grid),
// thicker where foot traffic is high and at busy times of day. When one of
// your businesses makes a sale, nearby walkers turn, queue, pay and walk off
// carrying their purchase. Positions are in the city grid's metres
// (gx east, gy north from the city's south-west corner).
import type { CityData } from '../lib/citydata';

export type WalkerState = 'walk' | 'toShop' | 'queue' | 'pay' | 'leave';

export interface Walker {
  id: number;
  gx: number;
  gy: number;
  heading: number; // radians, 0 = east, counter-clockwise
  speed: number; // m/s
  phase: number; // walk cycle
  shape: number; // body shape 0..2
  clothes: number; // palette index
  skin: number;
  legs: number;
  hair: number;
  state: WalkerState;
  shop?: { id: number; gx: number; gy: number; fx: number; fy: number; slot: number; paid: boolean; mine: boolean; amount: number };
  wait: number;
  carry: 0 | 1 | 2; // nothing, bag, cup
  life: number;
  slow: number; // 0..1: reading a menu board
}

const DIRS = [0, Math.PI / 4, -Math.PI / 4, Math.PI / 2, -Math.PI / 2, (3 * Math.PI) / 4, (-3 * Math.PI) / 4, Math.PI];

export interface ShopSpot { id: number; gx: number; gy: number; fx: number; fy: number; mine: boolean; level: number; customer: boolean }

export class CrowdSim {
  walkers: Walker[] = [];
  private nextId = 1;
  private w: number;
  private h: number;
  private cell: number;
  private tw: number;
  private th: number;
  private tcell: number;
  private tscale: number;
  center = { gx: 0, gy: 0 };
  radius = 260;
  target = 120;
  onPaid?: (w: Walker) => void;
  shops: ShopSpot[] = [];
  private bgTimer = 0;

  constructor(private city: CityData) {
    const g = city.meta.grids.walk;
    this.w = g.w;
    this.h = g.h;
    this.cell = g.cell;
    const t = city.meta.grids.traffic;
    this.tw = t.w;
    this.th = t.h;
    this.tcell = t.cell;
    this.tscale = t.scale;
  }

  walkable(gx: number, gy: number) {
    const bits = this.city.walk;
    if (!bits) return false;
    const cx = Math.floor(gx / this.cell);
    const cy = Math.floor(gy / this.cell);
    if (cx < 0 || cy < 0 || cx >= this.w || cy >= this.h) return false;
    const i = cy * this.w + cx;
    return ((bits[i >> 3] >> (i & 7)) & 1) === 1;
  }

  traffic(gx: number, gy: number) {
    const cx = Math.floor(gx / this.tcell);
    const cy = Math.floor(gy / this.tcell);
    if (cx < 0 || cy < 0 || cx >= this.tw || cy >= this.th) return 0.1;
    return this.city.traffic[cy * this.tw + cx] / this.tscale;
  }

  // How many walkers this view should have: foot traffic around the camera
  // times the hour's crowd level, capped by the graphics setting.
  setView(gx: number, gy: number, radius: number, hourLevel: number, cap: number, eventMult = 1) {
    this.center = { gx, gy };
    this.radius = radius;
    let sum = 0;
    let n = 0;
    for (let i = 0; i < 25; i++) {
      const a = (i / 25) * Math.PI * 2;
      const r = (radius * ((i % 5) + 1)) / 5;
      sum += Math.min(3, this.traffic(gx + Math.cos(a) * r, gy + Math.sin(a) * r));
      n++;
    }
    const traffic = sum / n; // ~1 on a normal street
    const area = (Math.PI * radius * radius) / (Math.PI * 260 * 260);
    this.target = Math.max(6, Math.min(cap, Math.round(cap * 0.55 * traffic * hourLevel * eventMult * Math.min(1.4, area))));
  }

  private spawnAt(gx: number, gy: number): Walker {
    const r = Math.random;
    return {
      id: this.nextId++,
      gx,
      gy,
      heading: DIRS[Math.floor(r() * 8)],
      speed: 2.6 + r() * 1.6,
      phase: r() * 10,
      shape: Math.floor(r() * 3),
      clothes: Math.floor(r() * 12),
      skin: Math.floor(r() * 6),
      legs: Math.floor(r() * 5),
      hair: Math.floor(r() * 5),
      state: 'walk',
      wait: 0,
      carry: 0,
      life: 60 + r() * 120,
      slow: 0,
    };
  }

  private trySpawn(near?: { gx: number; gy: number; rMin: number; rMax: number }): Walker | null {
    for (let k = 0; k < 14; k++) {
      const a = Math.random() * Math.PI * 2;
      const rr = near ? near.rMin + Math.random() * (near.rMax - near.rMin) : Math.sqrt(Math.random()) * this.radius;
      const cx = near ? near.gx : this.center.gx;
      const cy = near ? near.gy : this.center.gy;
      const gx = cx + Math.cos(a) * rr;
      const gy = cy + Math.sin(a) * rr;
      if (!this.walkable(gx, gy)) continue;
      // Busier streets get more people.
      if (!near && Math.random() > 0.2 + Math.min(1, this.traffic(gx, gy) / 2)) continue;
      const w = this.spawnAt(gx, gy);
      this.walkers.push(w);
      return w;
    }
    return null;
  }

  // A sale at one of the player's businesses: send up to six customers.
  sale(shop: ShopSpot, count: number, amount: number) {
    const n = Math.max(1, Math.min(6, count));
    const free = this.walkers
      .filter((w) => w.state === 'walk' && !w.carry)
      .map((w) => ({ w, d: Math.hypot(w.gx - shop.gx, w.gy - shop.gy) }))
      .filter((x) => x.d < 45)
      .sort((a, b) => a.d - b.d);
    const queued = this.walkers.filter((w) => w.shop?.id === shop.id && w.state !== 'leave').length;
    for (let i = 0; i < n; i++) {
      let w: Walker | undefined = free[i]?.w;
      if (!w) w = this.trySpawn({ gx: shop.gx, gy: shop.gy, rMin: 12, rMax: 30 }) ?? undefined;
      if (!w) break;
      w.state = 'toShop';
      w.shop = { id: shop.id, gx: shop.gx, gy: shop.gy, fx: shop.fx, fy: shop.fy, slot: queued + i, paid: false, mine: shop.mine, amount: amount / n };
      w.speed = 5.5 + Math.random(); // customers walk briskly
      w.life = 120;
    }
  }

  update(dt: number) {
    // Keep the population near the target around the camera.
    const R = this.radius * 1.2;
    this.walkers = this.walkers.filter((w) => {
      if (w.state !== 'walk' && w.state !== 'leave') return true;
      const far = Math.hypot(w.gx - this.center.gx, w.gy - this.center.gy) > R;
      return !far && w.life > 0;
    });
    let walking = 0;
    for (const w of this.walkers) if (w.state === 'walk') walking++;
    let spawns = Math.min(8, this.target - walking);
    while (spawns-- > 0) this.trySpawn();
    if (walking > this.target + 10) {
      const i = this.walkers.findIndex((w) => w.state === 'walk');
      if (i >= 0) this.walkers.splice(i, 1);
    }

    // Other people's shops get background customers now and then (never
    // linked to real sales, so nobody's numbers leak).
    this.bgTimer -= dt;
    if (this.bgTimer <= 0) {
      this.bgTimer = 2.5;
      for (const s of this.shops) {
        if (!s.customer || s.mine) continue;
        if (Math.random() < 0.08 * s.level) {
          const w = this.walkers.find((x) => x.state === 'walk' && !x.carry && Math.hypot(x.gx - s.gx, x.gy - s.gy) < 80);
          if (w) {
            w.state = 'toShop';
            w.shop = { id: s.id, gx: s.gx, gy: s.gy, fx: s.fx, fy: s.fy, slot: 0, paid: false, mine: false, amount: 0 };
          }
        }
      }
    }

    const mine = this.shops.filter((s) => s.mine && s.customer);
    for (const w of this.walkers) {
      w.life -= dt;
      let v = w.speed;
      if (w.state === 'walk' || w.state === 'leave') {
        // Slow down and look at the menu when passing one of your businesses.
        let near = 0;
        for (const s of mine) {
          const d = Math.hypot(w.gx - s.gx, w.gy - s.gy);
          if (d < 9) near = Math.max(near, 1 - d / 9);
        }
        w.slow += (near - w.slow) * Math.min(1, dt * 3);
        v *= 1 - 0.6 * w.slow;
        this.stepStreet(w, v * dt);
      } else if (w.state === 'toShop') {
        const s = w.shop!;
        // Queue spots line up in front of the counter.
        const qx = s.fx * (1 + s.slot * 0.55);
        const qy = s.fy * (1 + s.slot * 0.55);
        const tx = s.gx + qx;
        const ty = s.gy + qy;
        const d = Math.hypot(tx - w.gx, ty - w.gy);
        if (d < 0.6) {
          w.state = 'queue';
          w.wait = 0.6 + s.slot * 1.1;
          w.heading = Math.atan2(-s.fy, -s.fx);
        } else {
          w.heading = Math.atan2(ty - w.gy, tx - w.gx);
          const step = Math.min(d, v * dt);
          w.gx += Math.cos(w.heading) * step;
          w.gy += Math.sin(w.heading) * step;
        }
        if (w.life < 0) w.state = 'leave';
      } else if (w.state === 'queue') {
        w.wait -= dt;
        v = 0;
        if (w.wait <= 0) {
          w.state = 'pay';
          w.wait = 0.9;
        }
      } else if (w.state === 'pay') {
        v = 0;
        w.wait -= dt;
        if (!w.shop!.paid) {
          w.shop!.paid = true;
          if (w.shop!.mine) this.onPaid?.(w);
        }
        if (w.wait <= 0) {
          w.state = 'leave';
          w.carry = Math.random() < 0.55 ? 1 : 2;
          w.life = 40;
          w.heading = Math.atan2(w.shop!.fy, w.shop!.fx) + (Math.random() - 0.5) * 1.6;
        }
      }
      if (v > 0) w.phase += v * dt * 1.9;
    }
  }

  // Walk along the street: keep going, turn when the way ahead is blocked,
  // and now and then take a side street.
  private stepStreet(w: Walker, dist: number) {
    const look = 3;
    const ahead = (h: number) => this.walkable(w.gx + Math.cos(h) * look, w.gy + Math.sin(h) * look);
    if (!ahead(w.heading) || Math.random() < 0.004) {
      const order = DIRS.slice(1, 7).sort(() => Math.random() - 0.5);
      let turned = false;
      for (const d of order) {
        if (ahead(w.heading + d)) {
          w.heading += d;
          turned = true;
          break;
        }
      }
      if (!turned) w.heading += Math.PI;
    }
    const nx = w.gx + Math.cos(w.heading) * dist;
    const ny = w.gy + Math.sin(w.heading) * dist;
    if (this.walkable(nx, ny)) {
      w.gx = nx;
      w.gy = ny;
    }
  }
}
