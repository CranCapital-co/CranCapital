// The world map for Nations: every country coloured by whoever holds it,
// armies on the move, recent battles. Self-contained (shapes ship with the
// game, labels use our own fonts), so it works without the street-map server.
import { useEffect, useRef, useState } from 'react';
import maplibregl, { type Map as MLMap, type GeoJSONSource } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { LOCAL_GLYPHS } from '../map/style';
import type { FleetMap, WorldMapData, WorldState, WorldShips, Waterway } from './api';
import { WORLD_ZOOM } from './worldView';
import { anchorOf, along } from './fleets';
import { countryLane, dockPoint, loadSea, portLane } from './sea';
import { ShipLayer, SHIP3D_MIN_ZOOM, type Ship3D } from './ships3d';
import { goodName } from '../lib/store';

type Rel = 'mine' | 'ally' | 'enemy' | 'other';
const REL_COLOR: Record<Rel, string> = { mine: '#f5c451', ally: '#6fb5ff', enemy: '#e0533f', other: '#c7cfd6' };
const pt = (x: number, y: number, properties: Record<string, unknown>) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [x, y] }, properties });
// A line's length in degrees (for spacing ships along it).
const lineLen = (p: [number, number][]) => {
  let s = 0;
  for (let i = 1; i < p.length; i++) s += Math.hypot((p[i][0] - p[i - 1][0]) * Math.cos((p[i][1] * Math.PI) / 180), p[i][1] - p[i - 1][1]);
  return s;
};
const byNation = (s: WorldState | null, id: string) => s?.nations.find((n) => n.id === id)?.name ?? id;
const goodLabel = (id: string) => {
  try {
    return goodName(id).toLowerCase();
  } catch {
    return id;
  }
};
const WATERWAY_COLOR = ['match', ['get', 'policy'], 'open', '#5fd0ff', 'toll', '#f5c451', 'allies', '#ff9f43', '#ff5a4a'];

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
  // Draw on this existing map (the city map) instead of making our own.
  attachTo?: MLMap | null;
  // Warships in port and at sea (yours, your allies', enemies' coming at you).
  fleets?: FleetMap | null;
  // Everyone's cargo ships and warships at sea.
  worldShips?: WorldShips | null;
  // The vital waterways (Suez, Panama...), who holds them and who may pass.
  waterways?: Waterway[] | null;
  // Your player number (to pick out your own cargo ships).
  meNo?: number | null;
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

export default function WorldMap({ map: data, shapes, state, me, selected, onSelect, mode = 'play', targets, padding, troops, ships, attachTo, fleets, worldShips, waterways, meNo }: WorldMapProps) {
  // Our layer and source names: prefixed when they share the city's map.
  const P = attachTo ? 'w-' : '';
  const el = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLMap | null>(null);
  const ready = useRef(false);
  const latest = useRef({ state, me, selected, targets, mode, troops, ships, fleets, worldShips, waterways, meNo });
  latest.current = { state, me, selected, targets, mode, troops, ships, fleets, worldShips, waterways, meNo };
  const shipLayer = useRef<ShipLayer | null>(null);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  const byId = useRef(new Map(data.territories.map((t) => [t.id, t])));
  // If the map can't draw (an iPad out of graphics memory), offer a retry
  // instead of a blank screen; each retry builds a fresh map.
  const [failed, setFailed] = useState(false);
  const [gen, setGen] = useState(0);

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
    (m.getSource(P + 'countries') as GeoJSONSource)?.setData({ type: 'FeatureCollection', features } as any);
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
    (m.getSource(P + 'labels') as GeoJSONSource)?.setData({ type: 'FeatureCollection', features: labels } as any);
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
    (m.getSource(P + 'troops') as GeoJSONSource)?.setData({ type: 'FeatureCollection', features: badges });
    // The vital waterways: the channel, and a marker saying who lets ships through.
    const wws = latest.current.waterways ?? [];
    const status = (w: Waterway) =>
      (w.policy === 'open' ? 'Open' : w.policy === 'toll' ? 'Toll $' + Math.round(w.toll / 1000).toLocaleString() : w.policy === 'allies' ? 'Allies only' : 'Closed')
      + (w.mine ? ' (yours)' : w.access === 'closed' && w.policy !== 'closed' ? ' (closed to you)' : '');
    (m.getSource(P + 'waterways') as GeoJSONSource)?.setData({
      type: 'FeatureCollection',
      features: wws.map((w) => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: w.path }, properties: { policy: w.policy, canal: w.kind === 'canal' } })) as any,
    });
    (m.getSource(P + 'waterway-pts') as GeoJSONSource)?.setData({
      type: 'FeatureCollection',
      features: wws.map((w) => pt(w.lng, w.lat, { policy: w.policy, label: w.name + '\n' + status(w) + ' · ' + w.holder_name })) as any,
    });
    drawMoves();
  };

  const drawMoves = () => {
    const m = mapRef.current;
    if (!m || !ready.current) return;
    const { state: s, me: mine } = latest.current;
    const now = Date.now();
    const lines: any[] = [];
    const dots: any[] = [];
    const prog = (d: string, a: string) => {
      const t0 = new Date(d).getTime();
      const t1 = new Date(a).getTime();
      return Math.max(0, Math.min(1, (now - t0) / Math.max(1, t1 - t0)));
    };
    // How a country stands with you: yours, an ally, an enemy, or neither.
    const myAlliance = (s?.alliances ?? []).find((al) => mine && al.members.includes(mine));
    const enemies = new Set<string>();
    if (mine) for (const w of s?.wars ?? []) (w.att.includes(mine) ? w.def : w.def.includes(mine) ? w.att : []).forEach((x) => enemies.add(x));
    const relOf = (n: string | null | undefined): Rel => (!n ? 'other' : n === mine ? 'mine' : myAlliance?.members.includes(n) ? 'ally' : enemies.has(n) ? 'enemy' : 'other');
    const near = (id: string): [number, number] | null => {
      const t = byId.current.get(id);
      return t ? [t.lng, t.lat] : null;
    };
    // Fleets at sea: everyone's (rough numbers), with exact numbers for your
    // own and your allies'. They sail real sea lanes, coast to coast.
    const fl = latest.current.fleets;
    const ws = latest.current.worldShips;
    const exact = new Map((fl?.sailing ?? []).map((f) => [f.id, f]));
    const fleetsAtSea = new Map<number, { id: number; nation: string; from: string; to: string; depart_at: string; arrive_at: string; qty: number; troops: number | null; avoid: string[] }>();
    for (const f of ws?.fleets ?? []) fleetsAtSea.set(f.id, { id: f.id, nation: f.nation, from: f.from_t, to: f.to_t, depart_at: f.depart_at, arrive_at: f.arrive_at, qty: f.qty, troops: null, avoid: f.avoid ?? [] });
    for (const f of fl?.sailing ?? []) {
      const w = fleetsAtSea.get(f.id);
      fleetsAtSea.set(f.id, { id: f.id, nation: f.n, from: f.from, to: f.to, depart_at: f.depart_at, arrive_at: f.arrive_at, qty: f.qty, troops: f.troops, avoid: w?.avoid ?? [] });
    }
    const fleetPath = (f: { nation: string; from: string; to: string; avoid: string[] }) => {
      const a = near(f.from);
      const b = near(f.to);
      return a && b ? countryLane(f.from, a, f.to, b, f.avoid) : null;
    };
    for (const mv of s?.moves ?? []) {
      if (fleetsAtSea.has(mv.id)) continue; // drawn with the ships below
      const a = byId.current.get(mv.from);
      const b = byId.current.get(mv.to);
      if (!a || !b) continue;
      const k = prog(mv.depart_at, mv.arrive_at);
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
        properties: { kind, missile: mv.kind === 'missile', label: size != null ? `${mv.kind === 'missile' ? 'Missiles' : 'Army'} ${size} · ${Math.round(k * 100)}%` : '' },
      });
    }
    // Ships: a label (and a dot) further out, a 3D model closer in.
    const shipLabels: any[] = [];
    const models: Ship3D[] = [];
    const LANE = { mine: 'mine', ally: 'move', enemy: 'attack', other: 'other' } as const;
    for (const f of fleetsAtSea.values()) {
      const path = fleetPath(f);
      if (!path) continue;
      const rel = relOf(f.nation);
      const k = prog(f.depart_at, f.arrive_at);
      lines.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: path }, properties: { kind: LANE[rel] } });
      const len = lineLen(path);
      const n = rel === 'mine' || rel === 'ally' ? String(f.qty) : '~' + f.qty;
      const label = `${byNation(s, f.nation)}: ${n} ${f.qty === 1 ? 'fleet' : 'fleets'}${f.troops ? ` · ${f.troops} troops` : ''}`;
      const ships = f.qty >= 10 ? 3 : f.qty >= 3 ? 2 : 1;
      for (let i = 0; i < ships; i++) {
        // Escorts follow the flagship along the lane.
        const [x, y, hdg] = along(path, Math.max(0, k - (i * 0.6) / Math.max(0.6, len)));
        models.push({ lng: x, lat: y, hdg, kind: 'war', color: REL_COLOR[rel], moving: true, seed: f.id * 3 + i });
        if (i === 0) shipLabels.push(pt(x, y, { label, rel, ship: 'war' }));
      }
    }
    (fl?.docked ?? []).forEach((d, i) => {
      const t = byId.current.get(d.t);
      if (!t) return;
      const at = dockPoint(d.t, [t.lng, t.lat]) ?? anchorOf(d.t, t.lat, t.lng);
      const shift = ({ mine: 0, ally: 0.35, enemy: 0.7 } as const)[d.rel] ?? 0;
      const ships = d.qty >= 10 ? 3 : d.qty >= 3 ? 2 : 1;
      for (let j = 0; j < ships; j++) {
        models.push({ lng: at[0] + shift + j * 0.22, lat: at[1] - j * 0.12, hdg: 60 + ((i * 47) % 90), kind: 'war', color: REL_COLOR[d.rel], moving: false, seed: i * 7 + j });
      }
      shipLabels.push(pt(at[0] + shift, at[1], { label: `${d.rel === 'enemy' ? '~' : ''}${d.qty} ${d.qty === 1 ? 'fleet' : 'fleets'} in port`, rel: d.rel, ship: 'war' }));
    });
    // Everyone's cargo ships, port to port, with whose they are and what they carry.
    const meNo = latest.current.meNo;
    for (const c of ws?.cargo ?? []) {
      const path = portLane([c.from_lng, c.from_lat], c.from_t, [c.to_lng, c.to_lat], c.to_t, c.avoid ?? []);
      if (!path) continue;
      const yours = c.owner_no === meNo;
      const k = prog(c.depart_at, c.arrive_at);
      lines.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: path }, properties: { kind: yours ? 'mine' : 'ship' } });
      const [x, y, hdg] = along(path, k);
      models.push({ lng: x, lat: y, hdg, kind: 'cargo', color: yours ? '#f5c451' : '#e8eef2', moving: true, seed: c.id });
      shipLabels.push(pt(x, y, { label: `${yours ? 'Your ship' : c.owner}: ${Number(c.qty).toLocaleString()} ${goodLabel(c.good)}`, rel: yours ? 'mine' : 'cargo', ship: 'cargo' }));
    }
    (m.getSource(P + 'fleets') as GeoJSONSource)?.setData({ type: 'FeatureCollection', features: shipLabels });
    shipLayer.current?.set(models);
    (m.getSource(P + 'moves') as GeoJSONSource)?.setData({ type: 'FeatureCollection', features: lines });
    (m.getSource(P + 'movers') as GeoJSONSource)?.setData({ type: 'FeatureCollection', features: dots });
    const pulse = (now % 1600) / 1600;
    const battles = (s?.battles ?? [])
      .filter((x) => now - new Date(x.at).getTime() < 10 * 60_000)
      .map((x) => {
        const t = byId.current.get(x.territory);
        return t ? { type: 'Feature', geometry: { type: 'Point', coordinates: [t.lng, t.lat] }, properties: { captured: x.captured } } : null;
      })
      .filter(Boolean);
    (m.getSource(P + 'battles') as GeoJSONSource)?.setData({ type: 'FeatureCollection', features: battles as any[] });
    if (m.getLayer(P + 'battles')) {
      m.setPaintProperty(P + 'battles', 'circle-radius', 6 + pulse * 16);
      m.setPaintProperty(P + 'battles', 'circle-stroke-opacity', 1 - pulse);
    }
  };

  useEffect(() => {
    // Attached: add our layers to the city map (they fade in as you zoom out).
    if (attachTo) {
      const m = attachTo;
      const ws = worldStyle(P, true);
      const add = () => {
        if (!m.getStyle()) return;
        if (!m.getGlyphs?.()) m.setGlyphs?.(LOCAL_GLYPHS);
        for (const [id, src] of Object.entries(ws.sources)) if (!m.getSource(id)) m.addSource(id, src);
        // The ocean goes just above the city's own background; the rest on top.
        const firstReal = m.getStyle().layers.find((l) => l.type !== 'background')?.id;
        for (const l of ws.layers) if (!m.getLayer(l.id)) m.addLayer(l, l.type === 'background' ? firstReal : undefined);
        addMapImages(m);
        // Ships as 3D models when you zoom in.
        if (!m.getLayer(P + 'ship3d')) {
          shipLayer.current = new ShipLayer(P + 'ship3d');
          m.addLayer(shipLayer.current);
        }
        loadSea().then(() => drawMoves());
        mapRef.current = m;
        ready.current = true;
        paint();
        drawMoves();
      };
      if (m.isStyleLoaded()) add();
      else m.once('idle', add);
      const far = () => m.getZoom() < WORLD_ZOOM + 0.3;
      const onClick = (e: any) => {
        if (!far()) return;
        const f = m.queryRenderedFeatures(e.point, { layers: [P + 'fill'] })[0];
        onSelectRef.current?.(f ? String(f.properties?.id) : null);
      };
      m.on('click', onClick);
      const anim = setInterval(() => far() && drawMoves(), 250);
      return () => {
        clearInterval(anim);
        m.off('click', onClick);
        ready.current = false;
        mapRef.current = null;
        try {
          if (!m.getStyle()) return;
          for (const l of ws.layers) if (m.getLayer(l.id)) m.removeLayer(l.id);
          if (m.getLayer(P + 'ship3d')) m.removeLayer(P + 'ship3d');
          shipLayer.current = null;
          for (const id of Object.keys(ws.sources)) if (m.getSource(id)) m.removeSource(id);
        } catch {
          /* the map is closing */
        }
      };
    }
    if (!el.current) return;
    setFailed(false);
    let m: MLMap;
    try {
    m = new maplibregl.Map({
      container: el.current,
      style: { version: 8, glyphs: LOCAL_GLYPHS, ...worldStyle(P, false) },
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
    } catch {
      setFailed(true);
      return;
    }
    m.addControl(new maplibregl.AttributionControl({ compact: true, customAttribution: 'Natural Earth' }));
    addMapImages(m);
    m.touchZoomRotate.disableRotation();
    mapRef.current = m;
    // Paint as soon as the style is ready (our data is all local), and
    // again on 'load', which can come late.
    const go = () => {
      if (ready.current) return;
      ready.current = true;
      paint();
      drawMoves();
    };
    m.once('style.load', go);
    m.on('load', () => {
      go();
      paint();
    });
    if (m.isStyleLoaded()) go();
    // A real loss of the graphics context (not our own, when the map closes).
    const onLost = () => setFailed(true);
    m.getCanvas().addEventListener('webglcontextlost', onLost);
    m.on('webglcontextrestored', () => setFailed(false));
    const ro = new ResizeObserver(() => m.resize());
    ro.observe(el.current);
    m.on('click', (e) => {
      const f = m.queryRenderedFeatures(e.point, { layers: [P + 'fill'] })[0];
      onSelectRef.current?.(f ? String(f.properties?.id) : null);
    });
    m.on('mousemove', (e) => {
      m.getCanvas().style.cursor = m.queryRenderedFeatures(e.point, { layers: [P + 'fill'] }).length ? 'pointer' : '';
    });
    const anim = setInterval(drawMoves, 250);
    return () => {
      clearInterval(anim);
      ro.disconnect();
      m.getCanvas().removeEventListener('webglcontextlost', onLost);
      m.remove();
      mapRef.current = null;
      ready.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gen, attachTo]);

  useEffect(paint, [state, me, selected, targets, mode, troops, ships, fleets, worldShips, waterways]);

  // Keep the selected country in view, clear of the side panel.
  useEffect(() => {
    const m = mapRef.current;
    if (!m) return;
    const want = { top: padding?.top ?? 0, right: padding?.right ?? 0, bottom: padding?.bottom ?? 0, left: padding?.left ?? 0 };
    const cur = m.getPadding();
    // setPadding jumps the camera (cancelling any flight), so only when it changes.
    if (cur.top !== want.top || cur.right !== want.right || cur.bottom !== want.bottom || cur.left !== want.left) m.setPadding(want);
  }, [padding?.right, padding?.bottom, padding?.top, padding?.left]);

  // Fly to a country when asked (e.g. your own nation on opening).
  useEffect(() => {
    const on = (e: Event) => {
      const t = byId.current.get((e as CustomEvent).detail);
      // A country-sized view (not the city zoom a flight might be passing through).
      if (t && mapRef.current) mapRef.current.flyTo({ center: [t.lng, t.lat], zoom: Math.min(4.5, Math.max(mapRef.current.getZoom(), 2.6)), pitch: 0, bearing: 0, duration: 900 });
    };
    window.addEventListener('cc:worldfly', on);
    return () => window.removeEventListener('cc:worldfly', on);
  }, []);

  if (attachTo) return null;
  return (
    <>
      <div ref={el} className="world-map" />
      {failed && (
        <div className="map-wait">
          <span>The world map couldn’t draw.</span>
          <button className="btn small" onClick={() => setGen((g) => g + 1)}>Try again</button>
        </div>
      )}
    </>
  );
}

// The world's layers (ids prefixed with P), for the standalone map or for
// the city map they attach to (where they fade out as you zoom in).
function worldStyle(P: string, attached: boolean) {
  const sources: Record<string, any> = {
          [P + 'countries']: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
          [P + 'labels']: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
          [P + 'moves']: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
          [P + 'movers']: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
          [P + 'battles']: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
          [P + 'troops']: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
          [P + 'fleets']: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
          [P + 'waterways']: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
          [P + 'waterway-pts']: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
        };
  const layers: any[] = [
          { id: P + 'ocean', type: 'background', paint: { 'background-color': OCEAN } },
          { id: P + 'fill', type: 'fill', source: P + 'countries', paint: { 'fill-color': ['get', 'fill'], 'fill-opacity': ['case', ['get', 'selected'], 1, 0.88] } },
          {
            id: P + 'occupied', type: 'line', source: P + 'countries', filter: ['==', ['get', 'occupied'], true],
            paint: { 'line-color': '#ff6b5a', 'line-width': 2, 'line-dasharray': [1.5, 1.5] },
          },
          { id: P + 'border', type: 'line', source: P + 'countries', paint: { 'line-color': '#0a1820', 'line-width': 0.7 } },
          { id: P + 'enemy', type: 'line', source: P + 'countries', filter: ['==', ['get', 'enemy'], true], paint: { 'line-color': '#ff5a4a', 'line-width': 1.6 } },
          { id: P + 'mine', type: 'line', source: P + 'countries', filter: ['==', ['get', 'mine'], true], paint: { 'line-color': '#f5c451', 'line-width': 2.2 } },
          { id: P + 'target', type: 'line', source: P + 'countries', filter: ['==', ['get', 'target'], true], paint: { 'line-color': '#ffffff', 'line-width': 1.6, 'line-dasharray': [2, 1] } },
          { id: P + 'selected', type: 'line', source: P + 'countries', filter: ['==', ['get', 'selected'], true], paint: { 'line-color': '#ffffff', 'line-width': 3 } },
          {
            id: P + 'moves', type: 'line', source: P + 'moves',
            paint: {
              'line-color': ['match', ['get', 'kind'], 'mine', '#f5c451', 'move', '#8fd3ff', 'ship', '#e8f4ff', 'other', '#aab6bf', '#ff6b5a'],
              'line-width': ['match', ['get', 'kind'], 'ship', 1.2, 'other', 1.2, 2], 'line-dasharray': [2, 1.5], 'line-opacity': ['match', ['get', 'kind'], 'ship', 0.45, 'other', 0.45, 0.9],
            },
          },
          {
            id: P + 'movers', type: 'circle', source: P + 'movers', filter: ['!', ['get', 'ship']],
            paint: {
              // A fleet's dot gives way to its warships once you zoom in.
              'circle-opacity': ['interpolate', ['linear'], ['zoom'], 2.6, 1, 3.2, ['case', ['to-boolean', ['get', 'fleet']], 0, 1]],
              'circle-stroke-opacity': ['interpolate', ['linear'], ['zoom'], 2.6, 1, 3.2, ['case', ['to-boolean', ['get', 'fleet']], 0, 1]],
              'circle-radius': ['case', ['get', 'missile'], 4, 6],
              'circle-color': ['match', ['get', 'kind'], 'mine', '#f5c451', 'move', '#8fd3ff', '#ff6b5a'],
              'circle-stroke-color': '#0a1820', 'circle-stroke-width': 1.5,
            },
          },
          {
            id: P + 'ships', type: 'symbol', source: P + 'movers', filter: ['==', ['get', 'ship'], true],
            layout: { 'icon-image': 'cc-ship', 'icon-size': ['interpolate', ['linear'], ['zoom'], 1, 0.55, 4, 0.9], 'icon-rotate': ['get', 'hdg'], 'icon-rotation-alignment': 'map', 'icon-allow-overlap': true },
          },
          {
            // The vital waterways: the channel (a canal drawn across the land it cuts).
            id: P + 'waterway-lines', type: 'line', source: P + 'waterways', minzoom: 2,
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: { 'line-color': WATERWAY_COLOR, 'line-width': ['interpolate', ['linear'], ['zoom'], 2, 1.5, 6, 4], 'line-opacity': 0.85 },
          },
          {
            id: P + 'waterway-labels', type: 'symbol', source: P + 'waterway-pts', minzoom: 2.6,
            layout: {
              'text-field': ['get', 'label'], 'text-font': ['Noto Sans Bold'], 'text-size': 10.5, 'text-anchor': 'top', 'text-offset': [0, 1.4],
              'text-allow-overlap': true, 'text-max-width': 14,
            },
            paint: { 'text-color': WATERWAY_COLOR, 'text-halo-color': 'rgba(8,20,28,0.9)', 'text-halo-width': 1.4 },
          },
          {
            // Ships further out: a dot (the 3D models take over closer in).
            id: P + 'ship-dots', type: 'circle', source: P + 'fleets', maxzoom: SHIP3D_MIN_ZOOM,
            paint: {
              'circle-radius': ['case', ['==', ['get', 'ship'], 'war'], 4.5, 3.5],
              'circle-color': ['match', ['get', 'rel'], 'mine', '#f5c451', 'ally', '#6fb5ff', 'enemy', '#e0533f', 'cargo', '#e8eef2', '#c7cfd6'],
              'circle-stroke-color': '#0a1820', 'circle-stroke-width': 1.2,
            },
          },
          {
            id: P + 'ship-labels', type: 'symbol', source: P + 'fleets', minzoom: 2.2,
            layout: {
              'text-field': ['get', 'label'], 'text-font': ['Noto Sans Bold'],
              'text-size': ['interpolate', ['linear'], ['zoom'], 2.2, 9.5, 5, 11.5],
              'text-anchor': 'top',
              'text-offset': ['interpolate', ['linear'], ['zoom'], 3, ['literal', [0, 0.6]], SHIP3D_MIN_ZOOM, ['literal', [0, 1.6]], 8, ['literal', [0, 3.2]]],
              'text-allow-overlap': true, 'symbol-sort-key': ['match', ['get', 'rel'], 'mine', 0, 'enemy', 1, 'ally', 2, 3],
            },
            paint: {
              'text-color': ['match', ['get', 'rel'], 'mine', '#ffe39a', 'ally', '#cfe6ff', 'enemy', '#ffb3a8', '#e8eef2'],
              'text-halo-color': 'rgba(8,20,28,0.9)', 'text-halo-width': 1.4,
            },
          },
          {
            id: P + 'mover-labels', type: 'symbol', source: P + 'movers', filter: ['!=', ['get', 'label'], ''],
            layout: { 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Bold'], 'text-size': 11, 'text-offset': [0, 1.3], 'text-anchor': 'top', 'text-allow-overlap': true },
            paint: {
              'text-color': ['match', ['get', 'kind'], 'mine', '#ffe39a', 'ship', '#e8f4ff', '#ffb3a8'], 'text-halo-color': 'rgba(8,20,28,0.9)', 'text-halo-width': 1.4,
              'text-opacity': ['interpolate', ['linear'], ['zoom'], 2.6, 1, 3.2, ['case', ['to-boolean', ['get', 'fleet']], 0, 1]],
            },
          },
          {
            id: P + 'battles', type: 'circle', source: P + 'battles',
            paint: { 'circle-radius': 8, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': '#ff5a4a', 'circle-stroke-width': 3 },
          },
          {
            id: P + 'troop-badges', type: 'symbol', source: P + 'troops',
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
            id: P + 'labels', type: 'symbol', source: P + 'labels',
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
        ];
  if (attached) {
    for (const l of layers) {
      if (l.type === 'background') {
        l.paint = { ...l.paint, 'background-opacity': ['interpolate', ['linear'], ['zoom'], WORLD_ZOOM - 3.5, 1, WORLD_ZOOM, 0.35, WORLD_ZOOM + 0.6, 0] };
        l.maxzoom = WORLD_ZOOM + 0.7;
      } else {
        l.maxzoom = WORLD_ZOOM + 0.6;
      }
      // Countries fade gradually as you come down towards the city.
      if (l.type === 'fill') l.paint = { ...l.paint, 'fill-opacity': ['interpolate', ['linear'], ['zoom'], WORLD_ZOOM - 5, 0.88, WORLD_ZOOM - 1.5, 0.35, WORLD_ZOOM + 0.5, 0] };
    }
  }
  return { sources, layers };
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
  if (m.hasImage('cc-ship')) return;
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
