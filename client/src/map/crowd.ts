// Simulated crowds walking real streets. Purely visual: a canvas over the
// map draws pedestrians moving along the street lines in view. More people
// where foot traffic is high and at busy times of day.
import type { Map as MLMap } from 'maplibre-gl';

interface Ped {
  line: number;
  seg: number;
  t: number;
  dir: 1 | -1;
  speed: number; // metres per second (sped up for the game)
  color: string;
  size: number;
}

const COLORS = ['#e3694d', '#2f6f5e', '#3f8ed6', '#f3c443', '#8a5cc2', '#e58fb0', '#4a4a4a', '#6aa84f', '#d9822b', '#5b6c8c'];

export class Crowd {
  private map: MLMap;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private lines: [number, number][][] = [];
  private segLen: number[][] = [];
  private peds: Ped[] = [];
  private raf = 0;
  private last = 0;
  private density = 1;
  private enabled = true;
  private refreshTimer: any = 0;

  constructor(map: MLMap) {
    this.map = map;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'crowd-canvas';
    Object.assign(this.canvas.style, { position: 'absolute', inset: '0', pointerEvents: 'none', zIndex: '1' });
    map.getContainer().appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
    const onMove = () => {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = setTimeout(() => this.refresh(), 300);
    };
    map.on('moveend', onMove);
    map.on('sourcedata', (e: any) => {
      if (e.sourceId === 'ofm' && e.isSourceLoaded && this.lines.length === 0) onMove();
    });
    window.addEventListener('resize', () => this.resize());
    this.resize();
    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
  }

  setDensity(d: number) {
    this.density = d;
    this.refresh();
  }

  setEnabled(on: boolean) {
    this.enabled = on;
    if (!on) this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.canvas.remove();
  }

  private resize() {
    const r = this.map.getContainer().getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = r.width * dpr;
    this.canvas.height = r.height * dpr;
    this.canvas.style.width = r.width + 'px';
    this.canvas.style.height = r.height + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  refresh() {
    if (this.map.getZoom() < 14.8 || !this.map.getSource('ofm')) {
      this.lines = [];
      this.peds = [];
      return;
    }
    let feats: any[] = [];
    try {
      feats = this.map.querySourceFeatures('ofm', {
        sourceLayer: 'transportation',
        filter: ['in', ['get', 'class'], ['literal', ['primary', 'secondary', 'tertiary', 'minor', 'path', 'service', 'pedestrian']]],
      });
    } catch {
      return;
    }
    const b = this.map.getBounds();
    const lines: [number, number][][] = [];
    for (const f of feats) {
      if (f.properties?.brunnel === 'tunnel') continue;
      const geoms = f.geometry.type === 'LineString' ? [f.geometry.coordinates] : f.geometry.type === 'MultiLineString' ? f.geometry.coordinates : [];
      for (const g of geoms) {
        if (g.length < 2) continue;
        if (!g.some(([x, y]: number[]) => b.contains([x, y]))) continue;
        lines.push(g as [number, number][]);
        if (lines.length > 400) break;
      }
    }
    this.lines = lines;
    this.segLen = lines.map((l) => {
      const out: number[] = [];
      for (let i = 0; i + 1 < l.length; i++) out.push(distM(l[i], l[i + 1]));
      return out;
    });
    const target = Math.round(Math.min(260, Math.max(12, lines.length * 0.9 * this.density)));
    const peds: Ped[] = this.peds.filter((p) => p.line < lines.length).slice(0, target);
    while (peds.length < target && lines.length) peds.push(this.spawn());
    this.peds = peds;
  }

  private spawn(): Ped {
    const line = Math.floor(Math.random() * this.lines.length);
    const segs = Math.max(1, this.lines[line].length - 1);
    return {
      line,
      seg: Math.floor(Math.random() * segs),
      t: Math.random(),
      dir: Math.random() < 0.5 ? 1 : -1,
      speed: 3 + Math.random() * 3,
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
      size: 2.2 + Math.random() * 1.1,
    };
  }

  private loop(ts: number) {
    this.raf = requestAnimationFrame(this.loop);
    const dt = Math.min(0.1, (ts - (this.last || ts)) / 1000);
    this.last = ts;
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;
    ctx.clearRect(0, 0, w, h);
    if (!this.enabled || !this.lines.length) return;
    const zoom = this.map.getZoom();
    if (zoom < 14.8) return;
    const scale = Math.min(1.6, Math.max(0.6, (zoom - 14) / 3));
    for (const p of this.peds) {
      const line = this.lines[p.line];
      const lens = this.segLen[p.line];
      if (!line || !lens || !lens.length) continue;
      const len = lens[p.seg] || 1;
      p.t += (p.dir * p.speed * dt) / len;
      if (p.t > 1 || p.t < 0) {
        p.seg += p.dir;
        if (p.seg < 0 || p.seg >= lens.length) {
          // End of the street: turn round, or hop onto another street.
          if (Math.random() < 0.5) {
            p.dir = (-p.dir) as 1 | -1;
            p.seg = Math.min(Math.max(p.seg, 0), lens.length - 1);
          } else {
            Object.assign(p, this.spawn());
            continue;
          }
        }
        p.t = p.dir === 1 ? 0 : 1;
      }
      const a = line[p.seg];
      if (!a) continue;
      const b = line[p.seg + 1] ?? a;
      const lng = a[0] + (b[0] - a[0]) * p.t;
      const lat = a[1] + (b[1] - a[1]) * p.t;
      const pt = this.map.project([lng, lat]);
      // Walk slightly to one side of the street centre line.
      const off = (p.dir === 1 ? 3 : -3) * scale;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(pt.x + off, pt.y + off * 0.4, p.size * scale, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function distM(a: [number, number], b: [number, number]) {
  const kx = 111320 * Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180);
  return Math.hypot((b[0] - a[0]) * kx, (b[1] - a[1]) * 110574);
}

// How busy the streets are by local hour (for crowd density and the HUD).
export function crowdLevel(hour: number) {
  const curve = [0.15, 0.1, 0.08, 0.08, 0.1, 0.2, 0.4, 0.75, 0.95, 0.85, 0.85, 1, 1.25, 1.2, 1, 0.9, 0.95, 1.1, 1.2, 1.05, 0.85, 0.6, 0.4, 0.25];
  return curve[((hour % 24) + 24) % 24];
}

// Darkness of the night overlay, 0..0.5, by local hour (with minutes).
export function nightAlpha(hourFloat: number) {
  const h = ((hourFloat % 24) + 24) % 24;
  if (h >= 7.5 && h <= 18.5) return 0;
  if (h > 18.5 && h < 20.5) return ((h - 18.5) / 2) * 0.34;
  if (h >= 5.5 && h < 7.5) return ((7.5 - h) / 2) * 0.34;
  return 0.34;
}
