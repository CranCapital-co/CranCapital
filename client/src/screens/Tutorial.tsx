// Tutorial Island: a small made-up practice town, simulated entirely in the
// browser. Teaches placing a cart, setting a menu and prices, and
// selling to passing crowds. No account or server needed.
import { useEffect, useMemo, useRef, useState } from 'react';
import maplibregl, { type Map as MLMap, type GeoJSONSource } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { supabase, rpc, BACKEND_READY } from '../lib/supabase';
import { money } from '../lib/format';
import { installIconFactory } from '../map/icons';
import { LOCAL_GLYPHS } from '../map/style';
import type { CityData } from '../lib/citydata';
import type { WorldLayer } from '../world3d/WorldLayer';
import { useSettings } from '../lib/settings';
import { sound } from '../audio/sound';
import { demandAt } from '../ui/common';
import '../styles/tutorial.css';
import { Icon } from '../ui/Icon';

const C = { lng: -150.0, lat: 0.25 };
const M_LAT = 1 / 110574;
const M_LNG = 1 / 111320;
const p = (x: number, y: number): [number, number] => [C.lng + x * M_LNG, C.lat + y * M_LAT];

// Roads in metres from the island centre.
const ROADS: [number, number][][] = [
  [[-420, 0], [420, 0]],
  [[0, -330], [0, 300]],
  [[-260, -200], [-260, 220]],
  [[250, -220], [250, 200]],
  [[-260, 150], [250, 150]],
  [[-260, -150], [250, -150]],
  [[0, -330], [60, -420]],
];
const SQUARE = { x: 0, y: 0, r: 45 };
const TARGET = { x: 30, y: 8 };

function islandPolygon(): [number, number][] {
  const pts: [number, number][] = [];
  for (let i = 0; i <= 48; i++) {
    const a = (i / 48) * Math.PI * 2;
    const r = 560 + 70 * Math.sin(a * 3) + 40 * Math.cos(a * 5);
    pts.push(p(Math.cos(a) * r * 1.1, Math.sin(a) * r * 0.85));
  }
  return pts;
}

function buildings() {
  const out: GeoJSON.Feature[] = [];
  let id = 0;
  const add = (x: number, y: number, w: number, h: number, height: number) => {
    out.push({
      type: 'Feature',
      id: ++id,
      properties: { height },
      geometry: { type: 'Polygon', coordinates: [[p(x, y), p(x + w, y), p(x + w, y + h), p(x, y + h), p(x, y)]] },
    });
  };
  for (const x of [-230, -170, -110, 60, 120, 180]) {
    add(x, 18, 46, 38, 12 + ((x * 7) % 18));
    add(x, -58, 46, 38, 10 + ((x * 3) % 20));
    add(x, 165, 46, 34, 8 + ((x * 5) % 12));
    add(x, -200, 46, 34, 9 + ((x * 11) % 14));
  }
  for (const y of [40, 95, -95, -40]) {
    add(-245, y, 34, 40, 14);
    add(265, y, 34, 40, 18);
  }
  return out;
}

function distToSeg(px: number, py: number, a: [number, number], b: [number, number]) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy));
}
const onStreet = (x: number, y: number) => ROADS.some((r) => distToSeg(x, y, r[0], r[1]) < 7) || Math.hypot(x - SQUARE.x, y - SQUARE.y) < SQUARE.r;
const toXY = (lng: number, lat: number) => ({ x: (lng - C.lng) / M_LNG, y: (lat - C.lat) / M_LAT });

// The island as a city grid (walkable roads, foot traffic) so the same 3D
// world runs here: walkers on the roads, your character, a real cart and
// customers who walk up and pay.
function tutorialCity(): CityData {
  const W = 1400;
  const H = 1200;
  const walk = { cell: 5, w: W / 5, h: H / 5 };
  const traffic = { cell: 50, w: W / 50, h: H / 50, scale: 50 };
  const bits = new Uint8Array(Math.ceil((walk.w * walk.h) / 8));
  for (let cy = 0; cy < walk.h; cy++)
    for (let cx = 0; cx < walk.w; cx++) {
      const x = cx * 5 + 2.5 - W / 2;
      const y = cy * 5 + 2.5 - H / 2;
      if (onStreet(x, y)) {
        const i = cy * walk.w + cx;
        bits[i >> 3] |= 1 << (i & 7);
      }
    }
  const tr = new Uint8Array(traffic.w * traffic.h);
  for (let cy = 0; cy < traffic.h; cy++)
    for (let cx = 0; cx < traffic.w; cx++) {
      const x = cx * 50 + 25 - W / 2;
      const y = cy * 50 + 25 - H / 2;
      const nearRoad = ROADS.some((r) => distToSeg(x, y, r[0], r[1]) < 60);
      tr[cy * traffic.w + cx] = Math.round((Math.hypot(x, y) < 130 ? 2.2 : nearRoad ? 1.0 : 0.15) * traffic.scale);
    }
  const origin: [number, number] = [C.lng - (W / 2) * M_LNG, C.lat - (H / 2) * M_LAT];
  return {
    meta: {
      id: 'island', name: 'Tutorial Island', tz: 'UTC', bbox: [origin[0], origin[1], origin[0] + W * M_LNG, origin[1] + H * M_LAT], origin, kx: 1 / M_LNG, ky: 1 / M_LAT, widthM: W, heightM: H,
      start: { lng: C.lng, lat: C.lat, label: 'Market Square' }, travelHub: { lng: C.lng, lat: C.lat, label: 'Market Square' },
      grids: { walk, plot: { cell: 25, w: W / 25, h: H / 25 }, traffic },
    },
    traffic: tr,
    plots: new Uint8Array(0),
    coast: new Uint8Array(0),
    walk: bits,
  };
}

// Pip, the cart vendor who shows you around.
function Pip({ size = 64 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" className="pip" aria-hidden>
      <circle cx="32" cy="34" r="22" fill="#f1c7a5" />
      <path d="M10 26c4-14 40-14 44 0z" fill="#e3694d" />
      <path d="M10 26h44" stroke="#fff" strokeWidth="4" strokeDasharray="6 6" />
      <rect x="40" y="22" width="18" height="5" rx="2.5" fill="#e3694d" />
      <circle cx="25" cy="36" r="3" fill="#1e1e24" />
      <circle cx="39" cy="36" r="3" fill="#1e1e24" />
      <path d="M24 45q8 6 16 0" stroke="#b05a4a" strokeWidth="3" fill="none" strokeLinecap="round" />
      <circle cx="19" cy="42" r="3" fill="#f2a08a" opacity=".6" />
      <circle cx="45" cy="42" r="3" fill="#f2a08a" opacity=".6" />
    </svg>
  );
}

const DISHES = [
  { id: 'salad', name: 'Garden Salad', icon: '🥗', fair: 12000, ing: { lettuce: 3, tomato: 2 } },
  { id: 'chips', name: 'Hot Chips', icon: '🍟', fair: 10500, ing: { potato: 3 } },
  { id: 'onigiri', name: 'Onigiri', icon: '🍙', fair: 9000, ing: { rice: 2, wasabi: 1 } },
  { id: 'soup', name: 'Pumpkin Soup', icon: '🍲', fair: 13500, ing: { pumpkin: 2 } },
  { id: 'smoothie', name: 'Banana Smoothie', icon: '🥤', fair: 13500, ing: { banana: 3 } },
];
const GOODS: Record<string, { name: string; price: number }> = {
  lettuce: { name: 'Lettuce', price: 88 }, tomato: { name: 'Tomato', price: 132 }, potato: { name: 'Potato', price: 77 },
  rice: { name: 'Rice', price: 99 }, wasabi: { name: 'Wasabi', price: 66 }, pumpkin: { name: 'Pumpkins', price: 363 }, banana: { name: 'Banana', price: 165 },
};

type Step = 'intro' | 'place' | 'menu' | 'sell' | 'price' | 'restock' | 'done';

export default function Tutorial() {
  const el = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLMap | null>(null);
  const [step, setStep] = useState<Step>('intro');
  const [cash, setCash] = useState(10_000_000);
  const [cart, setCart] = useState<{ x: number; y: number } | null>(null);
  const [menu, setMenu] = useState<{ id: string; price: number }[]>([
    { id: 'salad', price: 12000 },
    { id: 'chips', price: 10500 },
    { id: 'onigiri', price: 9000 },
  ]);
  const [stock, setStock] = useState<Record<string, number>>({ lettuce: 120, tomato: 80, potato: 120, rice: 80, wasabi: 40, pumpkin: 80, banana: 90 });
  const [sales, setSales] = useState({ count: 0, revenue: 0 });
  const [secs, setSecs] = useState(0);
  const stepRef = useRef(step);
  stepRef.current = step;
  const state = useRef({ pos: { x: -300, y: -20 }, target: null as null | { x: number; y: number }, carry: 0 });
  const worldRef = useRef<WorldLayer | null>(null);
  const live = useRef({ menu, stock, cart });
  live.current = { menu, stock, cart };

  useEffect(() => {
    const map = new maplibregl.Map({
      container: el.current!,
      style: {
        version: 8,
        glyphs: LOCAL_GLYPHS,
        sources: {
          island: { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [islandPolygon()] } } },
          roads: { type: 'geojson', data: { type: 'FeatureCollection', features: ROADS.map((r) => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: r.map(([x, y]) => p(x, y)) } })) } },
          square: { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [Array.from({ length: 33 }, (_, i) => p(Math.cos((i / 32) * 6.283) * SQUARE.r, Math.sin((i / 32) * 6.283) * SQUARE.r))] } } },
          blds: { type: 'geojson', data: { type: 'FeatureCollection', features: buildings() } },
          labels: { type: 'geojson', data: { type: 'FeatureCollection', features: [
            { type: 'Feature', properties: { t: 'Market Square' }, geometry: { type: 'Point', coordinates: p(0, -30) } },
            { type: 'Feature', properties: { t: 'Harbour Street' }, geometry: { type: 'Point', coordinates: p(-160, 6) } },
            { type: 'Feature', properties: { t: 'CRAN BAY' }, geometry: { type: 'Point', coordinates: p(0, -520) } },
          ] } },
          me: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
          target: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
          cart: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
          peds: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
        },
        layers: [
          { id: 'sea', type: 'background', paint: { 'background-color': '#8fcdd2' } },
          { id: 'beach', type: 'line', source: 'island', paint: { 'line-color': '#f1dfb0', 'line-width': 22 } },
          { id: 'land', type: 'fill', source: 'island', paint: { 'fill-color': '#d7e6bf' } },
          { id: 'square', type: 'fill', source: 'square', paint: { 'fill-color': '#efe3cc' } },
          { id: 'roads-c', type: 'line', source: 'roads', layout: { 'line-cap': 'round' }, paint: { 'line-color': '#cdbfa5', 'line-width': ['interpolate', ['linear'], ['zoom'], 14, 6, 18, 30] } },
          { id: 'roads', type: 'line', source: 'roads', layout: { 'line-cap': 'round' }, paint: { 'line-color': '#fbf8f2', 'line-width': ['interpolate', ['linear'], ['zoom'], 14, 4, 18, 24] } },
          { id: 'blds', type: 'fill-extrusion', source: 'blds', paint: { 'fill-extrusion-color': '#e3d6bf', 'fill-extrusion-height': ['get', 'height'], 'fill-extrusion-opacity': 0.95 } },
          { id: 'target', type: 'circle', source: 'target', paint: { 'circle-radius': 18, 'circle-color': '#f2c14b', 'circle-opacity': 0.5, 'circle-stroke-color': '#e8a93a', 'circle-stroke-width': 3 } },
          { id: 'peds', type: 'circle', source: 'peds', paint: { 'circle-radius': 3.5, 'circle-color': ['get', 'c'] } },
          { id: 'labels', type: 'symbol', source: 'labels', layout: { 'text-field': ['get', 't'], 'text-font': ['Noto Sans Bold'], 'text-size': 13 }, paint: { 'text-color': '#5a6b63', 'text-halo-color': '#fff', 'text-halo-width': 1.5 } },
          { id: 'cart', type: 'symbol', source: 'cart', layout: { 'icon-image': 'bz:cart:1:1:0', 'icon-allow-overlap': true } },
          { id: 'me', type: 'symbol', source: 'me', layout: { 'icon-image': 'av:classic:none:standard', 'icon-allow-overlap': true, 'icon-anchor': 'bottom', 'icon-size': 1.1 } },
        ],
      } as any,
      center: p(-140, -5), // you and the market square both in view
      zoom: 16.9,
      pitch: 55,
      bearing: -10,
      attributionControl: false,
    });
    mapRef.current = map;
    (window as any).__ccTutorialMap = map; // for the browser test
    installIconFactory(map);
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
    const set = (id: string, d: any) => (map.getSource(id) as GeoJSONSource | undefined)?.setData(d);
    const pt = (x: number, y: number, props: any = {}) => ({ type: 'Feature', properties: props, geometry: { type: 'Point', coordinates: p(x, y) } });

    // Pedestrians walking the roads.
    const peds = Array.from({ length: 70 }, () => ({ r: Math.floor(Math.random() * ROADS.length), t: Math.random(), d: Math.random() < 0.5 ? 1 : -1, s: 0.02 + Math.random() * 0.03, c: ['#e3694d', '#2f6f5e', '#3f8ed6', '#f3c443', '#8a5cc2'][Math.floor(Math.random() * 5)] }));
    let raf = 0;
    let last = 0;
    const loop = (ts: number) => {
      raf = requestAnimationFrame(loop);
      const dt = Math.min(0.1, (ts - (last || ts)) / 1000);
      last = ts;
      for (const q of peds) {
        q.t += q.d * q.s * dt;
        if (q.t > 1 || q.t < 0) { q.d = -q.d as 1 | -1; q.t = Math.max(0, Math.min(1, q.t)); }
      }
      if (map.isStyleLoaded()) {
        set('peds', { type: 'FeatureCollection', features: peds.map((q) => { const [a, b] = ROADS[q.r]; return pt(a[0] + (b[0] - a[0]) * q.t + (q.d > 0 ? 3 : -3), a[1] + (b[1] - a[1]) * q.t, { c: q.c }); }) });
        set('me', { type: 'FeatureCollection', features: [] });
      }
    };
    map.on('load', async () => {
      raf = requestAnimationFrame(loop);
      // The 3D world: if it can't start, the flat version still works.
      try {
        const { WorldLayer } = await import('../world3d/WorldLayer');
        if (!mapRef.current) return;
        const w = new WorldLayer(tutorialCity(), () => null); // no character
        map.addLayer(w, 'labels');
        w.setQuality(useSettings.getState().quality);
        w.onPaid = (_b, amount) => {
          const ct = live.current.cart;
          if (ct) {
            const div = document.createElement('div');
            div.className = 'sale-pop';
            div.textContent = `+${money(amount)}`;
            const marker = new maplibregl.Marker({ element: div, anchor: 'bottom', offset: [0, -40] }).setLngLat(p(ct.x, ct.y)).addTo(map);
            setTimeout(() => marker.remove(), 2200);
          }
          sound.play('sale', { amount });
        };
        worldRef.current = w;
        (window as any).__ccWorld = w;
        for (const id of ['peds', 'me', 'cart']) map.setLayoutProperty(id, 'visibility', 'none');
      } catch {
        /* flat tutorial */
      }
    });
    map.on('click', (e) => {
      const { x, y } = toXY(e.lngLat.lng, e.lngLat.lat);
      if (stepRef.current === 'place') {
        if (!onStreet(x, y)) return void flash('Carts go on streets: tap a road or the square.');
        setCart({ x, y });
        setCash((c) => c - 5_000_000);
        const w = worldRef.current;
        if (w) {
          const [lng, lat] = p(x, y);
          w.celebrateBuild(1);
          w.setBusinesses([{ id: 1, kind: 'cart', tier: 1, level: 1, status: 'open', mine: true, lat, lng, name: 'Your cart' }]);
          sound.play('hammer');
          setTimeout(() => sound.play('pop'), 2000);
        }
        set('cart', { type: 'FeatureCollection', features: [pt(x, y)] });
        set('target', { type: 'FeatureCollection', features: [] });
        setStep('menu');
        return;
      }
    });
    return () => {
      cancelAnimationFrame(raf);
      map.remove();
    };
  }, []);

  const [msg, setMsg] = useState<string | null>(null);
  function flash(t: string) {
    setMsg(t);
    setTimeout(() => setMsg(null), 2600);
  }

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const tgt = map.getSource('target') as GeoJSONSource | undefined;
    if (step === 'place' && tgt) tgt.setData({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: p(TARGET.x, TARGET.y) } }] });
    if (step === 'place') map.easeTo({ center: p(-60, 0), duration: 800 });
  }, [step]);

  // Selling: a lunchtime rush, sped up. Same price rules as the real game.
  useEffect(() => {
    if (step !== 'sell' && step !== 'price') return;
    setSecs(0);
    const t = setInterval(() => {
      setSecs((s) => s + 1);
      const { menu: mn, stock: st, cart: ct } = live.current;
      if (!ct) return;
      const avail = mn.map((m) => ({ m, d: DISHES.find((x) => x.id === m.id)! })).filter(({ d }) => Object.entries(d.ing).every(([g, q]) => (st[g] ?? 0) >= q));
      if (!avail.length) return;
      const weights = avail.map(({ m, d }) => demandAt(m.price, d.fair));
      const conv = weights.reduce((a, b) => a + b, 0) / avail.length;
      const perSec = 1.6 * conv;
      const s = state.current;
      s.carry += perSec;
      let n = Math.floor(s.carry);
      s.carry -= n;
      const next = { ...st };
      let rev = 0;
      let count = 0;
      while (n-- > 0) {
        const total = weights.reduce((a, b) => a + b, 0);
        let r = Math.random() * total;
        let k = 0;
        while (r > weights[k] && k < weights.length - 1) r -= weights[k++];
        const { m, d } = avail[k];
        if (!Object.entries(d.ing).every(([g, q]) => (next[g] ?? 0) >= q)) continue;
        for (const [g, q] of Object.entries(d.ing)) next[g] -= q;
        rev += m.price;
        count++;
        const mk = mapRef.current;
        if (mk && !worldRef.current) {
          const div = document.createElement('div');
          div.className = 'sale-pop';
          div.textContent = `+${money(m.price)}`;
          const marker = new maplibregl.Marker({ element: div, anchor: 'bottom' }).setLngLat(p(ct.x, ct.y + 6)).addTo(mk);
          setTimeout(() => marker.remove(), 2200);
        }
      }
      if (count) {
        // In 3D, customers walk up and the money pops when they pay.
        worldRef.current?.sale(1, count, rev);
        setStock(next);
        setSales((x) => ({ count: x.count + count, revenue: x.revenue + rev }));
        setCash((c) => c + rev);
      }
    }, 1000);
    return () => clearInterval(t);
  }, [step]);

  useEffect(() => {
    // Reset the clock in the same update so the next step gets its full time.
    if (step === 'sell' && secs >= 18) { setSecs(0); setStep('price'); }
    if (step === 'price' && secs >= 16) { setSecs(0); setStep('restock'); }
  }, [step, secs]);

  const low = useMemo(() => Object.entries(stock).filter(([g, q]) => q < 40 && menu.some((m) => g in DISHES.find((d) => d.id === m.id)!.ing)), [stock, menu]);

  async function finish() {
    try {
      localStorage.setItem('cc_tutorial_done', '1');
    } catch {
      /* storage may be blocked */
    }
    if (BACKEND_READY) {
      const { data } = await supabase.auth.getSession();
      if (data.session) await rpc('complete_tutorial').catch(() => {});
    }
    window.location.hash = '/play';
  }

  return (
    <div className="game tutorial">
      <div ref={el} className="map" />
      <div className="hud">
        <div className="hud-pill">
          <Icon name="island" size={30} accent="var(--sky)" />
          <div>
            <div className="hud-cash">{money(cash, { cents: false })}</div>
            <div className="hud-sub">Practice money · Tutorial Island</div>
          </div>
        </div>
        <div className="grow" />
        <a className="btn small ghost" href="#/play" onClick={() => { try { sessionStorage.setItem('cc_skip_tutorial', '1'); } catch { /* ignore */ } }} style={{ background: 'var(--panel)' }}>Skip</a>
      </div>
      {msg && <div className="mode-banner">{msg}</div>}
      <div className="coach pip-coach">
        <div className="pip-head">
          <Pip size={54} />
          <span className="small muted">Pip, cart vendor</span>
        </div>
        {step === 'intro' && (
          <>
            <h2>Welcome to Tutorial Island</h2>
            <p>This is a practice town. In three minutes you’ll learn to park a food cart, set a menu and sell to the lunchtime crowd. Nothing here is real money.</p>
            <button className="btn gold" onClick={() => setStep('place')}>Let’s go</button>
          </>
        )}
        {step === 'place' && (
          <>
            <span className="chip">Step 1 of 4</span>
            <h3>Park your cart</h3>
            <p>Tap a street or the glowing market square to park a food cart for $5,000. The busiest spots (near stations, sights and shops) sell the most.</p>
          </>
        )}
        {step === 'menu' && (
          <>
            <span className="chip">Step 2 of 4</span>
            <h3>Choose your menu and prices</h3>
            <p className="small">Each dish has a fair price. Charge less and more people buy; charge more and fewer buy, but each sale earns more.</p>
            {menu.map((m, i) => {
              const d = DISHES.find((x) => x.id === m.id)!;
              return (
                <div key={m.id} className="row" style={{ marginBottom: 6 }}>
                  <select className="input" style={{ width: 'auto' }} value={m.id} onChange={(e) => setMenu(menu.map((x, j) => (j === i ? { id: e.target.value, price: DISHES.find((dd) => dd.id === e.target.value)!.fair } : x)))}>
                    {DISHES.filter((dd) => dd.id === m.id || !menu.some((x) => x.id === dd.id)).map((dd) => <option key={dd.id} value={dd.id}>{dd.name}</option>)}
                  </select>
                  <input type="range" min={d.fair * 0.5} max={d.fair * 2} step={100} value={m.price} onChange={(e) => setMenu(menu.map((x, j) => (j === i ? { ...x, price: Number(e.target.value) } : x)))} aria-label={`${d.name} price`} />
                  <b className="num" style={{ minWidth: 56 }}>{money(m.price)}</b>
                </div>
              );
            })}
            <button className="btn gold" onClick={() => setStep('sell')}>Open for lunch</button>
          </>
        )}
        {(step === 'sell' || step === 'price') && (
          <>
            <span className="chip">Step 3 of 4</span>
            <h3>{step === 'sell' ? 'Lunchtime rush!' : 'Try a higher price'}</h3>
            <p className="small">
              {step === 'sell'
                ? 'Customers walking past stop and buy. Each sale uses ingredients from your storage.'
                : `Drag the ${DISHES.find((x) => x.id === menu[0]?.id)?.name ?? 'first dish'} price up by half and watch: fewer people buy. Finding the best price is the game.`}
            </p>
            {step === 'price' && (
              <input type="range" min={1500} max={9000} step={100} value={menu[0]?.price ?? 4000}
                onChange={(e) => setMenu(menu.map((m, i) => (i === 0 ? { ...m, price: Number(e.target.value) } : m)))} aria-label="First dish price" />
            )}
            <div className="row between"><span>Sales</span><b>{sales.count}</b></div>
            <div className="row between"><span>Takings</span><b>{money(sales.revenue)}</b></div>
          </>
        )}
        {step === 'restock' && (
          <>
            <span className="chip">Step 4 of 4</span>
            <h3>Restock</h3>
            <p className="small">When ingredients run out, sales stop. In the game you buy them on the exchange, where market traders always sell, a little above the going price.</p>
            {low.length > 0 && <p className="small bad">Running low: {low.map(([g]) => GOODS[g].name).join(', ')}.</p>}
            <button
              className="btn"
              onClick={() => {
                let cost = 0;
                const next = { ...stock };
                for (const m of menu) for (const [g, q] of Object.entries(DISHES.find((d) => d.id === m.id)!.ing)) {
                  const need = Math.max(0, q * 200 - next[g]);
                  next[g] += need;
                  cost += need * GOODS[g].price;
                }
                setStock(next);
                setCash((c) => c - cost);
                flash(`Bought ingredients for ${money(cost)}.`);
                setStep('done');
              }}
            >
              Buy ingredients for 200 sales
            </button>
          </>
        )}
        {step === 'done' && (
          <>
            <h3 className="row"><Icon name="star" accent="var(--gold)" /> You’re ready</h3>
            <p className="small">You sold {sales.count} dishes for {money(sales.revenue)}. In real cities your cart keeps selling while you’re offline, for up to 24 hours. Then grow into shops, land, mines, factories and finance.</p>
            <button className="btn gold" onClick={finish}>Leave the island</button>
          </>
        )}
      </div>
    </div>
  );
}
