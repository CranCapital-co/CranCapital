// Tutorial Island: a small made-up practice town, simulated entirely in the
// browser. Teaches walking, placing a cart, setting a menu and prices, and
// selling to passing crowds. No account or server needed.
import { useEffect, useMemo, useRef, useState } from 'react';
import maplibregl, { type Map as MLMap, type GeoJSONSource } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { supabase, rpc, BACKEND_READY } from '../lib/supabase';
import { money } from '../lib/format';
import { installIconFactory } from '../map/icons';
import { demandAt } from '../ui/common';
import '../styles/tutorial.css';

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

const DISHES = [
  { id: 'salad', name: 'Garden Salad', icon: '🥗', fair: 4000, ing: { lettuce: 3, tomato: 2 } },
  { id: 'chips', name: 'Hot Chips', icon: '🍟', fair: 3500, ing: { potato: 3 } },
  { id: 'onigiri', name: 'Onigiri', icon: '🍙', fair: 3000, ing: { rice: 2, wasabi: 1 } },
  { id: 'soup', name: 'Pumpkin Soup', icon: '🍲', fair: 4500, ing: { pumpkin: 2 } },
  { id: 'smoothie', name: 'Banana Smoothie', icon: '🥤', fair: 4500, ing: { banana: 3 } },
];
const GOODS: Record<string, { name: string; price: number }> = {
  lettuce: { name: 'Lettuce', price: 88 }, tomato: { name: 'Tomato', price: 132 }, potato: { name: 'Potato', price: 77 },
  rice: { name: 'Rice', price: 99 }, wasabi: { name: 'Wasabi', price: 66 }, pumpkin: { name: 'Pumpkins', price: 363 }, banana: { name: 'Banana', price: 165 },
};

type Step = 'intro' | 'walk' | 'place' | 'menu' | 'sell' | 'price' | 'restock' | 'done';

export default function Tutorial() {
  const el = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLMap | null>(null);
  const [step, setStep] = useState<Step>('intro');
  const [cash, setCash] = useState(10_000_000);
  const [cart, setCart] = useState<{ x: number; y: number } | null>(null);
  const [menu, setMenu] = useState<{ id: string; price: number }[]>([
    { id: 'salad', price: 4000 },
    { id: 'chips', price: 3500 },
    { id: 'onigiri', price: 3000 },
  ]);
  const [stock, setStock] = useState<Record<string, number>>({ lettuce: 120, tomato: 80, potato: 120, rice: 80, wasabi: 40, pumpkin: 0, banana: 0 });
  const [sales, setSales] = useState({ count: 0, revenue: 0 });
  const [secs, setSecs] = useState(0);
  const stepRef = useRef(step);
  stepRef.current = step;
  const state = useRef({ pos: { x: -300, y: -20 }, target: null as null | { x: number; y: number }, carry: 0 });
  const live = useRef({ menu, stock, cart });
  live.current = { menu, stock, cart };

  useEffect(() => {
    const map = new maplibregl.Map({
      container: el.current!,
      style: {
        version: 8,
        glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
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
          { id: 'cart', type: 'symbol', source: 'cart', layout: { 'icon-image': 'bz:🛒:1:1:0', 'icon-allow-overlap': true } },
          { id: 'me', type: 'symbol', source: 'me', layout: { 'icon-image': 'av:classic:none:standard', 'icon-allow-overlap': true, 'icon-anchor': 'bottom', 'icon-size': 1.1 } },
        ],
      } as any,
      center: p(-120, 0),
      zoom: 16.3,
      pitch: 48,
      bearing: -10,
      attributionControl: false,
    });
    mapRef.current = map;
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
        const s = state.current;
        if (s.target) {
          const dx = s.target.x - s.pos.x;
          const dy = s.target.y - s.pos.y;
          const d = Math.hypot(dx, dy);
          const step = 70 * dt;
          if (d <= step) {
            s.pos = { ...s.target };
            s.target = null;
            if (stepRef.current === 'walk' && Math.hypot(s.pos.x - TARGET.x, s.pos.y - TARGET.y) < 30) setStep('place');
          } else {
            s.pos = { x: s.pos.x + (dx / d) * step, y: s.pos.y + (dy / d) * step };
          }
        }
        set('me', { type: 'FeatureCollection', features: [pt(s.pos.x, s.pos.y)] });
      }
    };
    map.on('load', () => (raf = requestAnimationFrame(loop)));
    map.on('click', (e) => {
      const { x, y } = toXY(e.lngLat.lng, e.lngLat.lat);
      if (stepRef.current === 'place') {
        if (!onStreet(x, y)) return void flash('Carts go on streets: tap a road or the square.');
        if (Math.hypot(x - state.current.pos.x, y - state.current.pos.y) > 60) {
          state.current.target = { x, y };
          return void flash('Walk closer first: you need to stand where you park.');
        }
        setCart({ x, y });
        setCash((c) => c - 5_000_000);
        set('cart', { type: 'FeatureCollection', features: [pt(x, y)] });
        set('target', { type: 'FeatureCollection', features: [] });
        setStep('menu');
        return;
      }
      if (stepRef.current !== 'intro') state.current.target = { x, y };
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
    if (step === 'walk' && tgt) tgt.setData({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: p(TARGET.x, TARGET.y) } }] });
    if (step === 'walk') map.easeTo({ center: p(-60, 0), duration: 800 });
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
        if (mk) {
          const div = document.createElement('div');
          div.className = 'sale-pop';
          div.textContent = `+${money(m.price)}`;
          const marker = new maplibregl.Marker({ element: div, anchor: 'bottom' }).setLngLat(p(ct.x, ct.y + 6)).addTo(mk);
          setTimeout(() => marker.remove(), 2200);
        }
      }
      if (count) {
        setStock(next);
        setSales((x) => ({ count: x.count + count, revenue: x.revenue + rev }));
        setCash((c) => c + rev);
      }
    }, 1000);
    return () => clearInterval(t);
  }, [step]);

  useEffect(() => {
    if (step === 'sell' && secs >= 18) setStep('price');
    if (step === 'price' && secs >= 16) setStep('restock');
  }, [step, secs]);

  const low = useMemo(() => Object.entries(stock).filter(([g, q]) => q < 40 && menu.some((m) => g in DISHES.find((d) => d.id === m.id)!.ing)), [stock, menu]);

  async function finish() {
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
          <span style={{ fontSize: 22, paddingLeft: 6 }}>🏝️</span>
          <div>
            <div className="hud-cash">{money(cash, { cents: false })}</div>
            <div className="hud-sub">Practice money · Tutorial Island</div>
          </div>
        </div>
        <div className="grow" />
        <a className="btn small ghost" href="#/play" style={{ background: 'var(--panel)' }}>Skip</a>
      </div>
      {msg && <div className="mode-banner">{msg}</div>}
      <div className="coach">
        {step === 'intro' && (
          <>
            <h2>Welcome to Tutorial Island</h2>
            <p>This is a practice town. In three minutes you’ll learn to walk, park a food cart, set a menu and sell to the lunchtime crowd. Nothing here is real money.</p>
            <button className="btn gold" onClick={() => setStep('walk')}>Let’s go</button>
          </>
        )}
        {step === 'walk' && (
          <>
            <span className="chip">Step 1 of 5</span>
            <h3>Walk to the market square</h3>
            <p>Tap the glowing spot (or anywhere) to walk there. In the real game you walk around real streets to find busy spots.</p>
          </>
        )}
        {step === 'place' && (
          <>
            <span className="chip">Step 2 of 5</span>
            <h3>Park your cart</h3>
            <p>Tap a street or the square close to you to park a food cart for $5,000. The busiest spots (near stations, sights and shops) sell the most.</p>
          </>
        )}
        {step === 'menu' && (
          <>
            <span className="chip">Step 3 of 5</span>
            <h3>Choose your menu and prices</h3>
            <p className="small">Each dish has a fair price. Charge less and more people buy; charge more and fewer buy, but each sale earns more.</p>
            {menu.map((m, i) => {
              const d = DISHES.find((x) => x.id === m.id)!;
              return (
                <div key={m.id} className="row" style={{ marginBottom: 6 }}>
                  <select className="input" style={{ width: 'auto' }} value={m.id} onChange={(e) => setMenu(menu.map((x, j) => (j === i ? { id: e.target.value, price: DISHES.find((dd) => dd.id === e.target.value)!.fair } : x)))}>
                    {DISHES.filter((dd) => dd.id === m.id || !menu.some((x) => x.id === dd.id)).map((dd) => <option key={dd.id} value={dd.id}>{dd.icon} {dd.name}</option>)}
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
            <span className="chip">Step 4 of 5</span>
            <h3>{step === 'sell' ? 'Lunchtime rush!' : 'Try a higher price'}</h3>
            <p className="small">
              {step === 'sell'
                ? 'Customers walking past stop and buy. Each sale uses ingredients from your storage.'
                : 'Drag the salad price up to about $6 and watch: fewer people buy. Finding the best price is the game.'}
            </p>
            {step === 'price' && (
              <input type="range" min={2000} max={8000} step={100} value={menu.find((m) => m.id === 'salad')?.price ?? 4000}
                onChange={(e) => setMenu(menu.map((m) => (m.id === 'salad' ? { ...m, price: Number(e.target.value) } : m)))} aria-label="Salad price" />
            )}
            <div className="row between"><span>Sales</span><b>{sales.count}</b></div>
            <div className="row between"><span>Takings</span><b>{money(sales.revenue)}</b></div>
          </>
        )}
        {step === 'restock' && (
          <>
            <span className="chip">Step 5 of 5</span>
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
            <h3>🎓 You’re ready</h3>
            <p className="small">You sold {sales.count} dishes for {money(sales.revenue)}. In real cities your cart keeps selling while you’re offline, for up to 24 hours. Then grow into shops, land, mines, factories and finance.</p>
            <button className="btn gold" onClick={finish}>Leave the island</button>
          </>
        )}
      </div>
    </div>
  );
}
