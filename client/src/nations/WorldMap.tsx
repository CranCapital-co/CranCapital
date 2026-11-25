// The world map for Nations: every country coloured by whoever holds it,
// armies on the move, recent battles. Self-contained (shapes ship with the
// game, labels use our own fonts), so it works without the street-map server.
import { useEffect, useRef } from 'react';
import maplibregl, { type Map as MLMap, type GeoJSONSource } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { LOCAL_GLYPHS } from '../map/style';
import type { WorldMapData, WorldState } from './api';

export interface WorldMapProps {
  map: WorldMapData;
  shapes: GeoJSON.FeatureCollection;
  state: WorldState | null;
  me?: string | null;
  selected?: string | null;
  onSelect?: (id: string | null) => void;
  mode?: 'play' | 'picker';
  // Territories to ring (e.g. where an army can go).
  targets?: string[];
  padding?: { right?: number; bottom?: number; top?: number; left?: number };
  // Troops: yours and your allies' exactly, enemies' as estimates.
  troops?: TroopMap | null;
  // Ships at sea (your shipments): from one port city to another.
  ships?: { id: number; from: [number, number]; to: [number, number]; depart: string; arrive: string; label: string }[];
}

export interface TroopMap {
  garrisons: { t: string; n: string; rel: 'mine' | 'ally' | 'enemy'; total: number; units: Record<string, number> | null }[];
  moves: { id: number; size: number; mine: boolean }[];
}

const OCEAN = '#0d2633';
const FALLEN = '#5b6470';

function shade(hex: string, k: number) {
  const n = parseInt(hex.slice(1), 16);
  const f = (c: number) => Math.max(0, Math.min(255, Math.round(c * k)));
  return `rgb(${f(n >> 16)}, ${f((n >> 8) & 255)}, ${f(n & 255)})`;
}

export default function WorldMap({ map: data, shapes, state, me, selected, onSelect, mode = 'play', targets, padding, troops, ships }: WorldMapProps) {
  const el = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLMap | null>(null);
  const ready = useRef(false);
  const latest = useRef({ state, me, selected, targets, mode, troops, ships });
  latest.current = { state, me, selected, targets, mode, troops, ships };
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  const byId = useRef(new Map(data.territories.map((t) => [t.id, t])));

  // Paint the countries from the latest state.
  const paint = () => {
    const m = mapRef.current;
    if (!m || !ready.current) return;
    const { state: s, me: mine, selected: sel, targets: tg, mode: md } = latest.current;
    const holder = new Map<string, [string, string]>((s?.territories ?? []).map(([id, owner, ctrl]) => [id, [owner, ctrl]]));
    const nations = new Map((s?.nations ?? []).map((n) => [n.id, n]));
    const atWar = new Set<string>();
    if (mine) for (const w of s?.wars ?? []) {
      const side = w.att.includes(mine) ? w.def : w.def.includes(mine) ? w.att : [];
      side.forEach((x) => atWar.add(x));
    }
    const tset = new Set(tg ?? []);
    const features = shapes.features.map((f) => {
      const id = String(f.id);
      const [owner, ctrl] = holder.get(id) ?? [id, id];
      const n = nations.get(ctrl);
      const homeNation = nations.get(id);
      let fill = n?.color ?? byId.current.get(id)?.color ?? '#888';
      if (md === 'picker') {
        // Free countries in colour; taken ones dimmed.
        const taken = !!homeNation?.leader || (owner !== id && !!nations.get(owner)?.leader);
        fill = taken ? shade(fill, 0.38) : fill;
      } else if (n?.status === 'fallen') fill = FALLEN;
      return {
        type: 'Feature' as const,
        id: f.id,
        geometry: f.geometry,
        properties: {
          id,
          fill,
          occupied: owner !== ctrl,
          mine: !!mine && ctrl === mine,
          enemy: atWar.has(ctrl),
          leader: !!n?.leader,
          selected: id === sel,
          target: tset.has(id),
        },
      };
    });
    (m.getSource('countries') as GeoJSONSource)?.setData({ type: 'FeatureCollection', features } as any);
    const labels = data.territories.map((t) => {
      const [, ctrl] = holder.get(t.id) ?? [t.id, t.id];
      const n = nations.get(t.id);
      return {
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [t.lng, t.lat] },
        properties: {
          name: md === 'picker' && n?.leader ? `${t.name}\n${n.leader.name}` : ctrl !== t.id && nations.get(ctrl) ? `${t.name}\n(${nations.get(ctrl)!.name})` : t.name,
          rank: -t.value,
          leader: !!n?.leader,
        },
      };
    });
    (m.getSource('labels') as GeoJSONSource)?.setData({ type: 'FeatureCollection', features: labels } as any);
    // Troop badges under each country's name: one per side that has troops there.
    const tr = latest.current.troops;
    const badges: any[] = [];
    if (tr) {
      const per = new Map<string, typeof tr.garrisons>();
      for (const g of tr.garrisons) (per.get(g.t) ?? per.set(g.t, []).get(g.t)!).push(g);
      per.forEach((list, tid) => {
        const t = byId.current.get(tid);
        if (!t) return;
        const order = { mine: 0, ally: 1, enemy: 2 } as const;
        const sides = new Map<string, number>();
        for (const g of list) sides.set(g.rel, (sides.get(g.rel) ?? 0) + g.total);
        const keys = [...sides.keys()].sort((a, b) => order[a as keyof typeof order] - order[b as keyof typeof order]);
        keys.forEach((rel, i) => {
          const n = sides.get(rel)!;
          badges.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [t.lng, t.lat] },
            properties: { rel, label: (rel === 'enemy' ? '~' : '') + (n >= 10000 ? `${Math.round(n / 1000)}k` : String(n)), slot: keys.length === 1 ? 'c' : keys.length === 2 ? (i ? 'r1' : 'l1') : (['l2', 'c', 'r2'][i] ?? 'c') },
          });
        });
      });
    }
    (m.getSource('troops') as GeoJSONSource)?.setData({ type: 'FeatureCollection', features: badges });
    drawMoves();
  };

  const drawMoves = () => {
    const m = mapRef.current;
    if (!m || !ready.current) return;
    const { state: s, me: mine } = latest.current;
    const now = Date.now();
    const lines: any[] = [];
    const dots: any[] = [];
    for (const mv of s?.moves ?? []) {
      const a = byId.current.get(mv.from);
      const b = byId.current.get(mv.to);
      if (!a || !b) continue;
      const t0 = new Date(mv.depart_at).getTime();
      const t1 = new Date(mv.arrive_at).getTime();
      const k = Math.max(0, Math.min(1, (now - t0) / Math.max(1, t1 - t0)));
      // Short way round the antimeridian.
      let bl = b.lng;
      if (bl - a.lng > 180) bl -= 360;
      if (a.lng - bl > 180) bl += 360;
      const kind = mv.nation === mine ? 'mine' : mv.kind === 'move' ? 'move' : 'attack';
      const size = latest.current.troops?.moves.find((x) => x.id === mv.id)?.size;
      lines.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[a.lng, a.lat], [bl, b.lat]] }, properties: { kind } });
      dots.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [a.lng + (bl - a.lng) * k, a.lat + (b.lat - a.lat) * k] },
        properties: { kind, missile: mv.kind === 'missile', label: size != null ? `${mv.kind === 'missile' ? '🚀' : '⚔'} ${size} · ${Math.round(k * 100)}%` : '' },
      });
    }
    // Your ships: a dashed sea lane and a boat sailing along it.
    for (const sh of latest.current.ships ?? []) {
      const t0 = new Date(sh.depart).getTime();
      const t1 = new Date(sh.arrive).getTime();
      const k = Math.max(0, Math.min(1, (now - t0) / Math.max(1, t1 - t0)));
      const path = seaPath(sh.from, sh.to);
      lines.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: path }, properties: { kind: 'ship' } });
      const [x, y, hdg] = along(path, k);
      dots.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [x, y] }, properties: { kind: 'ship', ship: true, hdg, label: `${sh.label} · ${Math.round(k * 100)}%` } });
    }
    (m.getSource('moves') as GeoJSONSource)?.setData({ type: 'FeatureCollection', features: lines });
    (m.getSource('movers') as GeoJSONSource)?.setData({ type: 'FeatureCollection', features: dots });
    const pulse = (now % 1600) / 1600;
    const battles = (s?.battles ?? [])
      .filter((x) => now - new Date(x.at).getTime() < 10 * 60_000)
      .map((x) => {
        const t = byId.current.get(x.territory);
        return t ? { type: 'Feature', geometry: { type: 'Point', coordinates: [t.lng, t.lat] }, properties: { captured: x.captured } } : null;
      })
      .filter(Boolean);
    (m.getSource('battles') as GeoJSONSource)?.setData({ type: 'FeatureCollection', features: battles as any[] });
    if (m.getLayer('battles')) {
      m.setPaintProperty('battles', 'circle-radius', 6 + pulse * 16);
      m.setPaintProperty('battles', 'circle-stroke-opacity', 1 - pulse);
    }
  };

  useEffect(() => {
    if (!el.current) return;
    const m = new maplibregl.Map({
      container: el.current,
      style: {
        version: 8,
        glyphs: LOCAL_GLYPHS,
        sources: {
          countries: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
          labels: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
          moves: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
          movers: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
          battles: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
          troops: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
        },
        layers: [
          { id: 'ocean', type: 'background', paint: { 'background-color': OCEAN } },
          { id: 'fill', type: 'fill', source: 'countries', paint: { 'fill-color': ['get', 'fill'], 'fill-opacity': ['case', ['get', 'selected'], 1, 0.88] } },
          {
            id: 'occupied', type: 'line', source: 'countries', filter: ['==', ['get', 'occupied'], true],
            paint: { 'line-color': '#ff6b5a', 'line-width': 2, 'line-dasharray': [1.5, 1.5] },
          },
          { id: 'border', type: 'line', source: 'countries', paint: { 'line-color': '#0a1820', 'line-width': 0.7 } },
          { id: 'enemy', type: 'line', source: 'countries', filter: ['==', ['get', 'enemy'], true], paint: { 'line-color': '#ff5a4a', 'line-width': 1.6 } },
          { id: 'mine', type: 'line', source: 'countries', filter: ['==', ['get', 'mine'], true], paint: { 'line-color': '#f5c451', 'line-width': 2.2 } },
          { id: 'target', type: 'line', source: 'countries', filter: ['==', ['get', 'target'], true], paint: { 'line-color': '#ffffff', 'line-width': 1.6, 'line-dasharray': [2, 1] } },
          { id: 'selected', type: 'line', source: 'countries', filter: ['==', ['get', 'selected'], true], paint: { 'line-color': '#ffffff', 'line-width': 3 } },
          {
            id: 'moves', type: 'line', source: 'moves',
            paint: {
              'line-color': ['match', ['get', 'kind'], 'mine', '#f5c451', 'move', '#8fd3ff', 'ship', '#e8f4ff', '#ff6b5a'],
              'line-width': ['match', ['get', 'kind'], 'ship', 1.4, 2], 'line-dasharray': [2, 1.5], 'line-opacity': ['match', ['get', 'kind'], 'ship', 0.55, 0.9],
            },
          },
          {
            id: 'movers', type: 'circle', source: 'movers', filter: ['!', ['get', 'ship']],
            paint: {
              'circle-radius': ['case', ['get', 'missile'], 4, 6],
              'circle-color': ['match', ['get', 'kind'], 'mine', '#f5c451', 'move', '#8fd3ff', '#ff6b5a'],
              'circle-stroke-color': '#0a1820', 'circle-stroke-width': 1.5,
            },
          },
          {
            id: 'ships', type: 'symbol', source: 'movers', filter: ['==', ['get', 'ship'], true],
            layout: { 'icon-image': 'cc-ship', 'icon-size': ['interpolate', ['linear'], ['zoom'], 1, 0.55, 4, 0.9], 'icon-rotate': ['get', 'hdg'], 'icon-rotation-alignment': 'map', 'icon-allow-overlap': true },
          },
          {
            id: 'mover-labels', type: 'symbol', source: 'movers', filter: ['!=', ['get', 'label'], ''],
            layout: { 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Bold'], 'text-size': 11, 'text-offset': [0, 1.3], 'text-anchor': 'top', 'text-allow-overlap': true },
            paint: { 'text-color': ['match', ['get', 'kind'], 'mine', '#ffe39a', 'ship', '#e8f4ff', '#ffb3a8'], 'text-halo-color': 'rgba(8,20,28,0.9)', 'text-halo-width': 1.4 },
          },
          {
            id: 'battles', type: 'circle', source: 'battles',
            paint: { 'circle-radius': 8, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': '#ff5a4a', 'circle-stroke-width': 3 },
          },
          {
            id: 'troop-badges', type: 'symbol', source: 'troops',
            layout: {
              'text-field': ['get', 'label'], 'text-font': ['Noto Sans Bold'], 'text-size': ['interpolate', ['linear'], ['zoom'], 1, 10, 4, 13],
              'text-anchor': 'top',
              'text-offset': ['match', ['get', 'slot'], 'l1', ['literal', [-1.6, 1.5]], 'r1', ['literal', [1.6, 1.5]], 'l2', ['literal', [-3, 1.5]], 'r2', ['literal', [3, 1.5]], ['literal', [0, 1.5]]],
              'icon-image': ['match', ['get', 'rel'], 'mine', 'cc-badge-mine', 'ally', 'cc-badge-ally', 'cc-badge-enemy'],
              'icon-text-fit': 'both', 'icon-text-fit-padding': [2, 6, 2, 6], 'icon-allow-overlap': true, 'text-allow-overlap': true,
              'symbol-sort-key': ['match', ['get', 'rel'], 'mine', 0, 'ally', 1, 2],
            },
            paint: { 'text-color': ['match', ['get', 'rel'], 'mine', '#2b1d02', '#ffffff'] },
          },
          {
            id: 'labels', type: 'symbol', source: 'labels',
            layout: {
              'text-field': ['get', 'name'],
              'text-font': ['Noto Sans Bold'],
              'text-size': ['interpolate', ['linear'], ['zoom'], 1, 9, 3, 12, 5, 15],
              'symbol-sort-key': ['get', 'rank'],
              'text-max-width': 8,
              'text-padding': 2,
            },
            paint: { 'text-color': ['case', ['get', 'leader'], '#fff6d6', '#f2f6f8'], 'text-halo-color': 'rgba(8,20,28,0.85)', 'text-halo-width': 1.4 },
          },
        ],
      },
      center: [15, 25],
      zoom: 1.25,
      minZoom: 0.6,
      maxZoom: 6,
      renderWorldCopies: false,
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
      attributionControl: false,
    });
    m.addControl(new maplibregl.AttributionControl({ compact: true, customAttribution: 'Natural Earth' }));
    addMapImages(m);
    m.touchZoomRotate.disableRotation();
    mapRef.current = m;
    m.on('load', () => {
      ready.current = true;
      paint();
    });
    m.on('click', (e) => {
      const f = m.queryRenderedFeatures(e.point, { layers: ['fill'] })[0];
      onSelectRef.current?.(f ? String(f.properties?.id) : null);
    });
    m.on('mousemove', (e) => {
      m.getCanvas().style.cursor = m.queryRenderedFeatures(e.point, { layers: ['fill'] }).length ? 'pointer' : '';
    });
    const anim = setInterval(drawMoves, 250);
    return () => {
      clearInterval(anim);
      m.remove();
      mapRef.current = null;
      ready.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(paint, [state, me, selected, targets, mode, troops, ships]);

  // Keep the selected country in view, clear of the side panel.
  useEffect(() => {
    const m = mapRef.current;
    if (!m) return;
    m.setPadding({ top: padding?.top ?? 0, right: padding?.right ?? 0, bottom: padding?.bottom ?? 0, left: padding?.left ?? 0 });
  }, [padding?.right, padding?.bottom, padding?.top, padding?.left]);

  // Fly to a country when asked (e.g. your own nation on opening).
  useEffect(() => {
    const on = (e: Event) => {
      const t = byId.current.get((e as CustomEvent).detail);
      if (t && mapRef.current) mapRef.current.flyTo({ center: [t.lng, t.lat], zoom: Math.max(mapRef.current.getZoom(), 2.6), duration: 900 });
    };
    window.addEventListener('cc:worldfly', on);
    return () => window.removeEventListener('cc:worldfly', on);
  }, []);

  return <div ref={el} className="world-map" />;
}

// Badge backgrounds (stretched around the number) and the ship icon, drawn
// once on a canvas.
function addMapImages(m: MLMap) {
  const badge = (fill: string, stroke: string) => {
    const c = document.createElement('canvas');
    c.width = 24;
    c.height = 24;
    const g = c.getContext('2d')!;
    g.fillStyle = fill;
    g.strokeStyle = stroke;
    g.lineWidth = 2;
    g.beginPath();
    g.roundRect(1, 1, 22, 22, 9);
    g.fill();
    g.stroke();
    return { width: 24, height: 24, data: new Uint8Array(g.getImageData(0, 0, 24, 24).data.buffer) };
  };
  const opts = { stretchX: [[9, 15]] as [number, number][], stretchY: [[9, 15]] as [number, number][], content: [6, 6, 18, 18] as [number, number, number, number] };
  m.addImage('cc-badge-mine', badge('#f5c451', '#7a5a12'), opts);
  m.addImage('cc-badge-ally', badge('#2f78b7', '#cfe6ff'), opts);
  m.addImage('cc-badge-enemy', badge('#c2412c', '#ffd0c8'), opts);
  // A little cargo ship seen from above, bow pointing up (north).
  const c = document.createElement('canvas');
  c.width = 28;
  c.height = 40;
  const g = c.getContext('2d')!;
  g.fillStyle = '#ffffff';
  g.strokeStyle = '#0a1820';
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(14, 2);
  g.quadraticCurveTo(25, 12, 24, 36);
  g.lineTo(4, 36);
  g.quadraticCurveTo(3, 12, 14, 2);
  g.fill();
  g.stroke();
  g.fillStyle = '#e3694d';
  g.fillRect(8, 14, 12, 8);
  g.fillStyle = '#2f78b7';
  g.fillRect(8, 23, 12, 8);
  g.fillStyle = '#f5c451';
  g.fillRect(10, 31, 8, 3);
  m.addImage('cc-ship', { width: 28, height: 40, data: new Uint8Array(g.getImageData(0, 0, 28, 40).data.buffer) }, { pixelRatio: 2 });
}

// A sea lane between two ports: a gentle curve (good enough on a flat map),
// crossing the date line the short way.
function seaPath(a: [number, number], b: [number, number]): [number, number][] {
  let bl = b[0];
  if (bl - a[0] > 180) bl -= 360;
  if (a[0] - bl > 180) bl += 360;
  const mx = (a[0] + bl) / 2;
  const my = (a[1] + b[1]) / 2;
  const dx = bl - a[0];
  const dy = b[1] - a[1];
  const bend = 0.18;
  const cx = mx - dy * bend;
  const cy = my + dx * bend;
  const pts: [number, number][] = [];
  for (let i = 0; i <= 24; i++) {
    const t = i / 24;
    pts.push([(1 - t) * (1 - t) * a[0] + 2 * (1 - t) * t * cx + t * t * bl, (1 - t) * (1 - t) * a[1] + 2 * (1 - t) * t * cy + t * t * b[1]]);
  }
  return pts;
}

// The point a fraction k along a path, and the heading there (degrees).
function along(path: [number, number][], k: number): [number, number, number] {
  const f = Math.min(path.length - 1.0001, Math.max(0, k * (path.length - 1)));
  const i = Math.floor(f);
  const t = f - i;
  const [x0, y0] = path[i];
  const [x1, y1] = path[i + 1];
  const hdg = (Math.atan2(x1 - x0, y1 - y0) * 180) / Math.PI;
  return [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, hdg];
}

