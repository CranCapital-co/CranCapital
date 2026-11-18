import { useEffect, useRef, useState } from 'react';
import maplibregl, { type Map as MLMap, type GeoJSONSource, type VectorTileSource } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { mapStyle, LIGHT, DARK, OFM_URL, OFM_GLYPHS, LOCAL_GLYPHS, OSM_ATTRIBUTION, mapText } from './style';
import { installIconFactory } from './icons';
import { Crowd, crowdLevel, nightAlpha } from './crowd';
import { useGame, catalog } from '../lib/store';
import { rpc } from '../lib/supabase';
import { loadWalk, walkable, nearestWalkable, walkImage, plotOf, plotBuildable, plotCoastal, plotPolygon, distM, trafficImage, inCity, type CityData } from '../lib/citydata';
import { onPresence, track, type Presence } from '../lib/realtime';
import { localHour, money, ringFor } from '../lib/format';
import { reportError } from '../lib/errors';
import { reducedMotion, useSettings } from '../lib/settings';
import type { WorldLayer, CharInfo } from '../world3d/WorldLayer';
import { RING_COLORS } from '../lib/format';
import { sound } from '../audio/sound';

const WALK_SPEED = 45; // metres per second on screen (server allows up to 60)
const BASE_MAP_TIMEOUT = 10_000; // ms before we stop waiting for street-map tiles

// Why the street map isn't showing: 'slow' (no tiles yet) or 'blocked'
// (the tile server refused or couldn't be reached).
type MapIssue = null | 'slow' | 'blocked';

export interface MapApi {
  map: MLMap;
  flyTo: (lat: number, lng: number, zoom?: number) => void;
  refresh: () => void;
  setHeatmap: (on: boolean) => void;
  // Keep the centre of attention clear of an open sheet.
  setPadding: (inset: { right: number; bottom: number }) => void;
  // Lift the camera to show everything you own in this city.
  empireView: () => void;
}

interface Props {
  city: CityData;
  onReady?: (api: MapApi) => void;
  onArrive?: (lat: number, lng: number) => void;
  onPlace?: (lat: number, lng: number) => void;
  onTaxi?: (lat: number, lng: number) => void;
}

const empty = (): GeoJSON.FeatureCollection => ({ type: 'FeatureCollection', features: [] });

function dark() {
  const t = document.documentElement.dataset.theme;
  if (t === 'dark') return true;
  if (t === 'light') return false;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches;
}

export default function GameMap({ city, onReady, onArrive, onPlace, onTaxi }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const nightEl = useRef<HTMLDivElement>(null);
  const ghostEl = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLMap | null>(null);
  const [issue, setIssue] = useState<MapIssue>(null);
  const debugEl = useRef<HTMLPreElement>(null);
  const debug = /[?&#]debug\b|[?&]debug=/.test(location.search + location.hash);
  const cbs = useRef({ onArrive, onPlace, onTaxi });
  cbs.current = { onArrive, onPlace, onTaxi };

  useEffect(() => {
    const g = useGame.getState();
    const m = city.meta;
    const startPos = g.pos ?? (g.me?.lat && g.me.city_id === m.id ? { lat: g.me.lat, lng: g.me.lng! } : { lat: m.start.lat, lng: m.start.lng });
    useGame.setState({ pos: startPos });
    const map = new maplibregl.Map({
      container: el.current!,
      style: mapStyle(dark() ? DARK : LIGHT),
      center: [startPos.lng, startPos.lat],
      zoom: 17.3, // on foot: close in and tilted, like a model city on a table
      pitch: 55,
      bearing: -12,
      maxPitch: 70,
      minZoom: 12.5,
      maxZoom: 19.5,
      maxBounds: [
        [m.bbox[0] - 0.03, m.bbox[1] - 0.02],
        [m.bbox[2] + 0.03, m.bbox[3] + 0.02],
      ],
      attributionControl: false,
      antialias: useSettings.getState().quality !== 'saver',
      pixelRatio: Math.min(window.devicePixelRatio || 1, useSettings.getState().quality === 'high' ? 2 : useSettings.getState().quality === 'medium' ? 1.5 : 1),
      dragRotate: true,
      doubleClickZoom: false, // a tap walks; pinch or use the buttons to zoom
    });
    // Touch screens (iPad first): fingers are less precise than a mouse.
    const touch = window.matchMedia?.('(pointer: coarse)').matches ?? false;
    const canHover = window.matchMedia?.('(hover: hover)').matches ?? !touch;
    mapRef.current = map;
    map.addControl(new maplibregl.AttributionControl({ compact: false }), 'bottom-left');
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
    installIconFactory(map);
    const crowd = new Crowd(map);
    let selectedBuilding: number | null = null;
    let stateIds: number[] = [];
    let destroyed = false;
    let ready = false; // our sources and layers are on the map
    let world: WorldLayer | null = null; // the 3D layer, once loaded
    let follow = true; // the camera eases after you as you walk
    let lastBiz: any[] = [];

    const setGeo = (id: string, data: GeoJSON.FeatureCollection) => (map.getSource(id) as GeoJSONSource | undefined)?.setData(data);

    // ---------- my avatar and walking ----------
    let pos = { ...startPos };
    let lastReport = 0;
    const meFeature = () => {
      const me = useGame.getState().me;
      return {
        type: 'FeatureCollection',
        features: [{
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [pos.lng, pos.lat] },
          properties: {
            icon: `av:${me?.skin ?? 'classic'}:${ringFor(me?.net_worth ?? 0)}:${me?.ring_style ?? 'standard'}`,
            name: mapText(me?.display_name) || 'You',
          },
        }],
      } as GeoJSON.FeatureCollection;
    };
    const presence = (moving: boolean): Presence => {
      const me = useGame.getState().me!;
      return { no: me.player_no, n: me.display_name, s: me.skin, r: ringFor(me.net_worth), rs: me.ring_style, t: me.title, lat: pos.lat, lng: pos.lng, in: !!useGame.getState().inside && !moving, at: Date.now() };
    };
    const report = (force = false) => {
      const now = Date.now();
      if (!force && now - lastReport < 1600) return;
      lastReport = now;
      const st = useGame.getState();
      rpc('report_position', { p_lat: pos.lat, p_lng: pos.lng, p_inside: st.inside }).then((r: any) => {
        if (r && typeof r.lat === 'number' && distM(r.lat, r.lng, pos.lat, pos.lng) > 60 && !useGame.getState().walkingTo) {
          pos = { lat: r.lat, lng: r.lng }; // the server held us back
          useGame.setState({ pos: { ...pos } });
          setGeo('me', meFeature());
        }
      }).catch(() => {});
    };
    let rafId = 0;
    let lastT = 0;
    const step = (t: number) => {
      rafId = requestAnimationFrame(step);
      const dt = Math.min(0.1, (t - (lastT || t)) / 1000);
      lastT = t;
      const st = useGame.getState();
      const target = st.walkingTo;
      if (!target) return;
      const d = distM(pos.lat, pos.lng, target.lat, target.lng);
      const stepM = WALK_SPEED * dt;
      if (d <= stepM || d < 0.5) {
        pos = { ...target };
        useGame.setState({ walkingTo: null, pos: { ...pos } });
        setGeo('me', meFeature());
        setGeo('route', empty());
        report(true);
        if (st.me) track(presence(false), true);
        cbs.current.onArrive?.(pos.lat, pos.lng);
        return;
      }
      const f = stepM / d;
      pos = { lat: pos.lat + (target.lat - pos.lat) * f, lng: pos.lng + (target.lng - pos.lng) * f };
      setGeo('me', meFeature());
      if (world && follow && !map.isMoving()) {
        // Ease after the walker so they stay in view.
        const c = map.getCenter();
        const k = Math.min(1, dt * 2.2);
        map.jumpTo({ center: [c.lng + (pos.lng - c.lng) * k, c.lat + (pos.lat - c.lat) * k] });
      }
      setGeo('route', { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[pos.lng, pos.lat], [target.lng, target.lat]] } }] });
      if (st.me) track(presence(true));
      report();
      if (Math.random() < 0.05) useGame.setState({ pos: { ...pos } });
    };

    // Follow external position changes (taxi, arrival after a flight).
    const unsubPos = useGame.subscribe((s, prev) => {
      if (s.pos && s.pos !== prev.pos && !s.walkingTo && (s.pos.lat !== pos.lat || s.pos.lng !== pos.lng)) {
        pos = { ...s.pos };
        setGeo('me', meFeature());
      }
      if (s.me !== prev.me) setGeo('me', meFeature());
      if (s.mode !== prev.mode) applyMode();
      if (s.selection.building !== prev.selection.building) selectBuilding(s.selection.building ?? null);
      if (s.refreshKey !== prev.refreshKey) refreshData();
      if (s.walkingTo && s.walkingTo !== prev.walkingTo) follow = true;
    });

    // ---------- other players ----------
    const unsubPresence = onPresence((others) => {
      const feats: GeoJSON.Feature[] = [];
      others.forEach((p) => {
        if (p.in) return;
        feats.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
          properties: { no: p.no, name: mapText(p.n), icon: `av:${p.s}:${p.r}:${p.rs || 'standard'}` },
        });
      });
      setGeo('players', { type: 'FeatureCollection', features: feats });
      world?.setPlayers(
        [...others.values()]
          .filter((p) => !p.in)
          .map((p): CharInfo => ({ key: 'p:' + p.no, lat: p.lat, lng: p.lng, skin: p.s, ring: RING_COLORS[p.r] ?? RING_COLORS.none, double: p.rs === 'double', skinTone: p.no % 6 }))
      );
    });

    // ---------- game data in view ----------
    let refreshing = false;
    const refreshData = async () => {
      if (refreshing || destroyed) return;
      refreshing = true;
      try {
        const b = map.getBounds();
        const args = { p_city: m.id, p_w: b.getWest() - 0.002, p_s: b.getSouth() - 0.002, p_e: b.getEast() + 0.002, p_n: b.getNorth() + 0.002 };
        const types = catalog()?.business_types ?? [];
        const [biz, blds] = await Promise.all([
          rpc<any[]>('map_businesses', args),
          map.getZoom() >= 14 ? rpc<any[]>('map_buildings', args) : Promise.resolve([] as any[]),
        ]);
        setGeo('businesses', {
          type: 'FeatureCollection',
          features: biz.map((x) => {
            const t = types.find((tt) => tt.id === x.kind);
            const dim = x.status !== 'open';
            return {
              type: 'Feature',
              geometry: { type: 'Point', coordinates: [x.lng, x.lat] },
              properties: { id: x.id, name: mapText(x.name), mine: x.mine, kind: x.kind, owner: x.owner_name, level: x.level, icon: `bz:${x.kind}:${t?.tier ?? 1}:${x.mine ? 1 : 0}:${dim ? 1 : 0}` },
            };
          }),
        });
        lastBiz = biz.map((x) => ({ id: x.id, kind: x.kind, tier: types.find((tt) => tt.id === x.kind)?.tier ?? 1, level: x.level, status: x.status, mine: x.mine, lat: x.lat, lng: x.lng, name: x.name, crop: x.crop, fill: x.fill, resource: x.resource }));
        world?.setBusinesses(lastBiz);
        for (const id of stateIds) map.setFeatureState({ source: 'ofm', sourceLayer: 'building', id }, { status: null });
        stateIds = [];
        for (const x of blds) {
          const status = x.mine ? 'mine' : x.my_room ? 'rented' : x.for_sale ? 'sale' : x.owner_no ? 'owned' : null;
          if (!status) continue;
          for (const id of [x.id, ...(x.aliases ?? [])]) {
            map.setFeatureState({ source: 'ofm', sourceLayer: 'building', id }, { status });
            stateIds.push(id);
          }
        }
        if (useGame.getState().mode.kind === 'land') await refreshPlots();
      } catch {
        /* map data is best-effort */
      } finally {
        refreshing = false;
      }
    };

    const refreshPlots = async () => {
      if (map.getZoom() < 15.5) {
        setGeo('plots', empty());
        return;
      }
      const b = map.getBounds();
      const a = plotOf(city, b.getSouth(), b.getWest());
      const z = plotOf(city, b.getNorth(), b.getEast());
      const res = await rpc<any>('map_plots', { p_city: m.id, p_w: b.getWest(), p_s: b.getSouth(), p_e: b.getEast(), p_n: b.getNorth() });
      const owned = new Map<string, any>();
      for (const o of res.owned) owned.set(`${o.px},${o.py}`, o);
      const feats: GeoJSON.Feature[] = [];
      for (let px = Math.max(0, a.px - 1); px <= z.px + 1; px++)
        for (let py = Math.max(0, a.py - 1); py <= z.py + 1; py++) {
          if (!plotBuildable(city, px, py)) continue;
          const o = owned.get(`${px},${py}`);
          feats.push({
            type: 'Feature',
            geometry: { type: 'Polygon', coordinates: [plotPolygon(m, px, py)] },
            properties: { px, py, state: o ? (o.mine ? 'mine' : o.for_sale_price ? 'sale' : 'owned') : plotCoastal(city, px, py) ? 'coast' : 'free' },
          });
          if (feats.length > 3000) break;
        }
      setGeo('plots', { type: 'FeatureCollection', features: feats });
      setGeo('deposits', {
        type: 'FeatureCollection',
        features: res.deposits.map((d: any) => {
          const poly = plotPolygon(m, d.px, d.py);
          return {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [(poly[0][0] + poly[2][0]) / 2, (poly[0][1] + poly[2][1]) / 2] },
            properties: { label: `${d.resource.replace('_', ' ')} ${Math.round(d.units_left / 1000)}k${d.claimed ? ' (claimed)' : ''}` },
          };
        }),
      });
    };

    const selectBuilding = (id: number | null) => {
      if (selectedBuilding !== null) map.setFeatureState({ source: 'ofm', sourceLayer: 'building', id: selectedBuilding }, { selected: false });
      selectedBuilding = id;
      if (id !== null) map.setFeatureState({ source: 'ofm', sourceLayer: 'building', id }, { selected: true });
    };

    // ---------- modes ----------
    const applyMode = async () => {
      if (!ready) return;
      const mode = useGame.getState().mode;
      const land = mode.kind === 'land';
      for (const id of ['plots-fill', 'plots-line', 'deposits']) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', land ? 'visible' : 'none');
      if (land) refreshPlots();
      const placing = mode.kind === 'place-cart' || mode.kind === 'move-cart';
      if (placing) {
        await loadWalk(city);
        // Paint the streets where a cart may park in green.
        if (!destroyed && !map.getSource('walk')) {
          const img = walkImage(city);
          if (img) {
            map.addSource('walk', { type: 'image', url: img.url, coordinates: img.coords });
            map.addLayer({ id: 'walk', type: 'raster', source: 'walk', paint: { 'raster-opacity': 0.55, 'raster-resampling': 'nearest', 'raster-fade-duration': 0 } }, 'building-flat');
          }
        }
      }
      if (map.getLayer('walk')) map.setLayoutProperty('walk', 'visibility', placing ? 'visible' : 'none');
      map.getCanvas().style.cursor = mode.kind === 'walk' ? '' : 'crosshair';
      if (ghostEl.current) ghostEl.current.style.display = placing && canHover ? 'block' : 'none';
    };

    map.on('mousemove', (e) => {
      const mode = useGame.getState().mode;
      if ((mode.kind === 'place-cart' || mode.kind === 'move-cart') && ghostEl.current) {
        const ok = walkable(city, e.lngLat.lat, e.lngLat.lng);
        ghostEl.current.style.left = e.point.x + 'px';
        ghostEl.current.style.top = e.point.y + 'px';
        ghostEl.current.dataset.ok = ok ? '1' : '0';
      }
    });

    map.on('click', async (e) => {
      const st = useGame.getState();
      const mode = st.mode;
      const { lat, lng } = e.lngLat;
      if (!inCity(m, lat, lng)) {
        st.toast('That’s outside the playable part of ' + m.name + '.', 'info');
        return;
      }
      if (mode.kind === 'place-cart' || mode.kind === 'move-cart') {
        await loadWalk(city);
        // Snap a near miss onto the street (fingers aren't pixel-precise).
        const spot = nearestWalkable(city, lat, lng, touch ? 18 : 7);
        if (!spot) {
          st.toast('Carts park on the green streets and paths: tap a green spot.', 'error');
          return;
        }
        cbs.current.onPlace?.(spot.lat, spot.lng);
        return;
      }
      if (mode.kind === 'taxi') {
        cbs.current.onTaxi?.(lat, lng);
        return;
      }
      if (mode.kind === 'land') {
        const { px, py } = plotOf(city, lat, lng);
        if (!plotBuildable(city, px, py)) {
          st.toast('That land can’t be built on (roads, buildings, parks and water are off limits).', 'info');
          return;
        }
        useGame.setState({ selection: { plot: { city: m.id, px, py } } });
        st.open('property', { plot: { city: m.id, px, py } });
        return;
      }
      // Walk mode: a 3D business model, avatars, badges, buildings, or walk.
      const hit3d = world?.pick(e.point.x, e.point.y);
      if (hit3d) {
        st.open('business', { id: hit3d.id });
        return;
      }
      // Icons get a generous hit area; the nearest one to the tap wins.
      const pad = touch ? 22 : 8;
      const near = map.queryRenderedFeatures(
        [[e.point.x - pad, e.point.y - pad], [e.point.x + pad, e.point.y + pad]],
        { layers: ['players', 'businesses'].filter((l) => map.getLayer(l)) }
      );
      let pick: (typeof near)[number] | null = null;
      let pickD = Infinity;
      for (const f of near) {
        const c = (f.geometry as GeoJSON.Point).coordinates as [number, number];
        const p = map.project(c);
        const dd = Math.hypot(p.x - e.point.x, p.y - 14 - e.point.y); // icons sit above their point
        if (dd < pickD) {
          pickD = dd;
          pick = f;
        }
      }
      if (pick?.layer.id === 'players') {
        st.open('profile', { player_no: pick.properties.no });
        return;
      }
      if (pick?.layer.id === 'businesses') {
        st.open('business', { id: pick.properties.id });
        return;
      }
      const hits = map.queryRenderedFeatures(e.point, { layers: ['building-3d', 'building-flat'].filter((l) => map.getLayer(l)) });
      const bld = hits.find((h) => h.layer.id.startsWith('building') && h.id !== undefined);
      if (bld) {
        useGame.setState({ selection: { building: Number(bld.id) } });
        st.open('property', { building: Number(bld.id) });
        return;
      }
      useGame.setState({ walkingTo: { lat, lng }, inside: null });
    });

    // ---------- the street map: watch it, and fall back if it can't load ----------
    // The base map comes from OpenFreeMap. If its tiles or fonts are blocked
    // (a VPN, an ad blocker, a school network) or very slow, MapLibre's
    // 'load' event never fires, so nothing of ours waits for it: our layers
    // go on as soon as the style is parsed. Then, if no street tile has
    // arrived after a few seconds, we draw the city's streets from the game's
    // own data (served with the site) and say what's wrong.
    let baseOk = false;
    let localGlyphs = false;
    let fallbackAdded = false;
    let retried = false;
    const showFallback = (on: boolean) => {
      if (map.getLayer('fallback-streets')) map.setLayoutProperty('fallback-streets', 'visibility', on ? 'visible' : 'none');
    };
    const startFallback = async (why: Exclude<MapIssue, null>) => {
      if (destroyed || baseOk) return;
      setIssue((cur) => (cur === 'blocked' ? cur : why));
      if (fallbackAdded) return;
      fallbackAdded = true;
      try {
        await loadWalk(city);
        if (destroyed || !ready || map.getSource('fallback-streets')) return;
        const p = dark() ? DARK : LIGHT;
        const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
        const img = walkImage(city, [...hex(p.road), 255] as [number, number, number, number]);
        if (!img) return;
        map.addSource('fallback-streets', { type: 'image', url: img.url, coordinates: img.coords });
        map.addLayer(
          { id: 'fallback-streets', type: 'raster', source: 'fallback-streets', layout: { visibility: baseOk ? 'none' : 'visible' }, paint: { 'raster-opacity': 0.95, 'raster-fade-duration': 0 } },
          'landuse'
        );
      } catch (err) {
        fallbackAdded = false;
        reportError('map', 'fallback streets: ' + String((err as Error)?.message ?? err));
      }
    };
    // Fonts first: if the font server is the only thing blocked, our own copy
    // brings back the whole map. A failed tile doesn't say whether its tiles
    // or its fonts failed, so ask the font server directly.
    const useLocalGlyphs = () => {
      if (localGlyphs || !ready) return;
      localGlyphs = true;
      try {
        map.setGlyphs(LOCAL_GLYPHS);
        (map.getSource('ofm') as VectorTileSource | undefined)?.setUrl(OFM_URL); // reload tiles that failed on fonts
      } catch {
        /* the fallback still covers us */
      }
    };
    let fontCheck: Promise<boolean> | null = null;
    const fontsReachable = () =>
      (fontCheck ??= (async () => {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), 3000);
        try {
          const r = await fetch(OFM_GLYPHS.replace('{fontstack}', 'Noto Sans Regular').replace('{range}', '0-255'), { signal: ctl.signal });
          return r.ok;
        } catch {
          return false;
        } finally {
          clearTimeout(t);
        }
      })());
    const onBaseTrouble = async (why: Exclude<MapIssue, null>) => {
      if (!(await fontsReachable())) {
        useLocalGlyphs();
        // Give the street tiles a moment to come back with our fonts.
        setTimeout(() => startFallback(why), why === 'slow' ? 0 : 4000);
      } else {
        startFallback(why);
      }
    };
    map.on('sourcedata', (e: any) => {
      if (e.sourceId === 'ofm' && e.tile && !baseOk) {
        baseOk = true;
        setIssue(null);
        showFallback(false);
      }
    });
    map.on('error', (e: any) => {
      const err = e?.error;
      const msg = String(err?.message ?? err ?? 'unknown map error');
      if (err?.name === 'AbortError' || /\babort/i.test(msg)) return; // we cancelled it (reloading the source)
      console.error('map:', e?.sourceId ?? '', msg);
      reportError('map', (e?.sourceId ? `[${e.sourceId}] ` : '') + msg + (err?.url ? ` (${String(err.url).slice(0, 120)})` : ''));
      if (!e?.sourceId && !/openfreemap/i.test(msg)) return;
      onBaseTrouble('blocked');
      // One more try later, in case it was a blip.
      if (e.sourceId === 'ofm' && !retried) {
        retried = true;
        setTimeout(() => {
          if (!destroyed && !baseOk) (map.getSource('ofm') as VectorTileSource | undefined)?.setUrl(OFM_URL);
        }, 15_000);
      }
    });
    const baseTimer = setTimeout(() => {
      if (baseOk || destroyed) return;
      reportError('map', `no street-map tiles after ${BASE_MAP_TIMEOUT / 1000} s`);
      onBaseTrouble('slow');
    }, BASE_MAP_TIMEOUT);

    // Our layers go on as soon as the style is parsed, not on 'load' (which
    // waits for every tile and never comes if the tile server is blocked).
    map.once('style.load', () => {
      if (destroyed) return;
      ready = true;
      map.addSource('plots', { type: 'geojson', data: empty() });
      map.addSource('deposits', { type: 'geojson', data: empty() });
      map.addSource('businesses', { type: 'geojson', data: empty() });
      map.addSource('players', { type: 'geojson', data: empty() });
      map.addSource('me', { type: 'geojson', data: meFeature(), attribution: OSM_ATTRIBUTION });
      map.addSource('route', { type: 'geojson', data: empty() });
      const heat = trafficImage(city);
      map.addSource('traffic', { type: 'image', url: heat.url, coordinates: heat.coords });
      map.addLayer({ id: 'traffic', type: 'raster', source: 'traffic', layout: { visibility: 'none' }, paint: { 'raster-opacity': 0.55, 'raster-resampling': 'linear' } }, 'building-flat');
      map.addLayer({
        id: 'plots-fill', type: 'fill', source: 'plots', layout: { visibility: 'none' },
        paint: {
          'fill-color': ['match', ['get', 'state'], 'mine', '#e8a93a', 'owned', '#5b8fc4', 'sale', '#e0654a', 'coast', '#4fb3c4', '#7fc28f'],
          'fill-opacity': ['match', ['get', 'state'], 'free', 0.18, 'coast', 0.25, 0.55],
        },
      });
      map.addLayer({ id: 'plots-line', type: 'line', source: 'plots', layout: { visibility: 'none' }, paint: { 'line-color': '#2f6f5e', 'line-width': 0.6, 'line-opacity': 0.6 } });
      map.addLayer({
        id: 'deposits', type: 'symbol', source: 'deposits', layout: { visibility: 'none', 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Bold'], 'text-size': 12, 'text-allow-overlap': true },
        paint: { 'text-color': '#5a3b12', 'text-halo-color': '#ffe9b8', 'text-halo-width': 2 },
      });
      map.addLayer({ id: 'route', type: 'line', source: 'route', paint: { 'line-color': '#e8a93a', 'line-width': 3, 'line-dasharray': [1, 1.5] } });
      map.addLayer({
        id: 'businesses', type: 'symbol', source: 'businesses',
        layout: {
          'icon-image': ['get', 'icon'], 'icon-size': ['interpolate', ['linear'], ['zoom'], 14, 0.55, 17, 0.9, 19, 1.1],
          'icon-allow-overlap': true,
          'text-field': ['step', ['zoom'], '', 16.8, ['get', 'name']], 'text-font': ['Noto Sans Bold'], 'text-size': 11,
          'text-offset': [0, 1.6], 'text-anchor': 'top', 'text-optional': true, 'text-max-width': 9,
          'symbol-sort-key': ['case', ['get', 'mine'], 0, 1],
        },
        paint: { 'text-color': '#2b2b2b', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 },
      });
      map.addLayer({
        id: 'players', type: 'symbol', source: 'players',
        layout: {
          'icon-image': ['get', 'icon'], 'icon-size': ['interpolate', ['linear'], ['zoom'], 14, 0.5, 18, 0.95], 'icon-allow-overlap': true, 'icon-anchor': 'bottom',
          'text-field': ['step', ['zoom'], '', 16, ['get', 'name']], 'text-font': ['Noto Sans Bold'], 'text-size': 11, 'text-offset': [0, 0.3], 'text-anchor': 'top', 'text-optional': true,
        },
        paint: { 'text-color': '#1d3f35', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 },
      });
      map.addLayer({
        id: 'me', type: 'symbol', source: 'me',
        layout: { 'icon-image': ['get', 'icon'], 'icon-size': ['interpolate', ['linear'], ['zoom'], 14, 0.65, 18, 1.15], 'icon-allow-overlap': true, 'icon-anchor': 'bottom' },
      });
      applyMode();
      refreshData();
      rafId = requestAnimationFrame(step);
      (window as any).__ccMap = map; // handy for debugging and browser tests
      loadWorld();
      onReady?.({
        map,
        flyTo: (lat, lng, zoom) => map.flyTo({ center: [lng, lat], zoom: zoom ?? Math.max(map.getZoom(), 16.2), duration: 1200 }),
        refresh: () => refreshData(),
        setHeatmap: (on) => map.setLayoutProperty('traffic', 'visibility', on ? 'visible' : 'none'),
        setPadding: (inset) =>
          map.easeTo({ padding: { top: 0, left: 0, right: inset.right, bottom: inset.bottom }, duration: reducedMotion(useGame.getState().me?.prefs) ? 0 : 450 }),
        empireView: async () => {
          const mine = await rpc<any[]>('my_businesses').catch(() => []);
          const here = mine.filter((b) => b.city_id === m.id);
          const pts = [...here.map((b) => [b.lng, b.lat] as [number, number]), [pos.lng, pos.lat] as [number, number]];
          if (pts.length < 2) {
            map.flyTo({ center: [pos.lng, pos.lat], zoom: 15, pitch: 40, duration: 1200 });
            useGame.getState().toast(here.length ? 'This is your empire in ' + m.name + '.' : 'You don’t own anything in ' + m.name + ' yet.', 'info');
            return;
          }
          const b = new maplibregl.LngLatBounds(pts[0], pts[0]);
          pts.forEach((p) => b.extend(p));
          map.fitBounds(b, { padding: 90, maxZoom: 17, pitch: 45, bearing: map.getBearing(), duration: reducedMotion(useGame.getState().me?.prefs) ? 0 : 1300 });
        },
      });
    });
    map.on('moveend', () => refreshData());
    map.on('dragstart', () => (follow = false));

    // ---------- the 3D world ----------
    // Loaded separately (Three.js is big), only on the play screen. If it
    // can't start (an old browser without WebGL 2), the 2D map carries on.
    const loadWorld = async () => {
      try {
        await loadWalk(city);
        const { WorldLayer } = await import('../world3d/WorldLayer');
        const { loadModelOverrides } = await import('../world3d/gltf');
        await loadModelOverrides();
        if (destroyed) return;
        const w = new WorldLayer(city, () => {
          const me = useGame.getState().me;
          if (!me) return null;
          return { key: 'me', lat: pos.lat, lng: pos.lng, skin: me.skin, ring: RING_COLORS[ringFor(me.net_worth)] ?? RING_COLORS.none, double: me.ring_style === 'double', skinTone: me.player_no % 6, moving: !!useGame.getState().walkingTo };
        });
        const before = map.getLayer('water-label') ? 'water-label' : undefined;
        map.addLayer(w, before);
        world = w;
        (window as any).__ccWorld = w;
        const settings = useSettings.getState();
        w.autoQuality = settings.graphics === 'auto';
        w.setQuality(settings.quality);
        w.onQuality = (q) => useSettings.getState().setQuality(q);
        w.onPaid = (b, amount, screen) => {
          salePop(b.lat, b.lng, amount);
          sound.play('sale', { amount });
          if (screen) window.dispatchEvent(new CustomEvent('cc:coin', { detail: { x: screen.x, y: screen.y, amount } }));
        };
        w.setBusinesses(lastBiz);
        crowd.setEnabled(false); // the 3D crowd replaces the dots
        // Badges hand over to models as you zoom in; names float above heads.
        map.setPaintProperty('me', 'icon-opacity', ['step', ['zoom'], 1, 15, 0]);
        map.setPaintProperty('players', 'icon-opacity', ['step', ['zoom'], 1, 15, 0]);
        map.setLayoutProperty('players', 'text-offset', ['interpolate', ['linear'], ['zoom'], 15, ['literal', [0, -1.8]], 18, ['literal', [0, -5.5]]]);
        map.setLayoutProperty('players', 'text-anchor', 'bottom');
        map.setPaintProperty('businesses', 'icon-opacity', ['step', ['zoom'], 1, 15.5, 0]);
        map.setLayoutProperty('businesses', 'text-offset', ['interpolate', ['linear'], ['zoom'], 15.5, ['literal', [0, 1.6]], 16, ['literal', [0, -2.5]], 18, ['literal', [0, -6]]]);
        map.setLayoutProperty('businesses', 'text-anchor', ['step', ['zoom'], 'top', 16, 'bottom']);
        map.triggerRepaint();
      } catch (err) {
        reportError('3d', 'world layer failed: ' + String((err as Error)?.message ?? err));
      }
    };
    const unsubSettings = useSettings.subscribe((s2, prev) => {
      if (!world) return;
      if (s2.graphics !== prev.graphics) {
        world.autoQuality = s2.graphics === 'auto';
        if (s2.graphics !== 'auto') world.setQuality(s2.graphics);
      }
    });
    map.on('mouseenter', 'businesses', () => (map.getCanvas().style.cursor = 'pointer'));
    map.on('mouseleave', 'businesses', () => applyMode());

    // Sales: in 3D, customers walk up and the money pops when they pay;
    // otherwise the amount pops straight away.
    const pops = new Map<number, { mk: maplibregl.Marker; total: number; t: any; el: HTMLDivElement }>();
    const salePop = (lat: number, lng: number, amount: number, key = Math.round(lat * 1e5) * 1e6 + Math.round(lng * 1e5)) => {
      if (map.getZoom() < 14) return;
      // Labels above the same business stack and merge.
      const cur = pops.get(key);
      if (cur) {
        cur.total += amount;
        cur.el.textContent = `+${money(cur.total)}`;
        cur.el.classList.toggle('big', cur.total >= 50000);
        cur.el.style.animation = 'none';
        void cur.el.offsetWidth;
        cur.el.style.animation = '';
        clearTimeout(cur.t);
        cur.t = setTimeout(() => {
          cur.mk.remove();
          pops.delete(key);
        }, 2400);
        return;
      }
      const div = document.createElement('div');
      div.className = 'sale-pop' + (amount >= 50000 ? ' big' : '');
      div.textContent = `+${money(amount)}`;
      const mk = new maplibregl.Marker({ element: div, anchor: 'bottom', offset: [0, -40] }).setLngLat([lng, lat]).addTo(map);
      const t = setTimeout(() => {
        mk.remove();
        pops.delete(key);
      }, 2400);
      pops.set(key, { mk, total: amount, t, el: div });
    };
    const onSales = (e: Event) => {
      const d = (e as CustomEvent).detail;
      if (!d?.lat) return;
      if (world?.sale(d.business, d.sold ?? 1, d.revenue ?? 0)) return;
      salePop(d.lat, d.lng, d.revenue ?? 0);
      if (map.getZoom() >= 14 && map.getBounds().contains([d.lng, d.lat])) sound.play('sale', { amount: d.revenue });
    };
    window.addEventListener('cc:sales', onSales);
    // Something new was built, or levelled up: show it.
    const onBuilt = (e: Event) => {
      const id = (e as CustomEvent).detail?.id;
      if (!id) return;
      world?.celebrateBuild(id);
      sound.play('hammer');
      setTimeout(() => sound.play('pop'), 2000);
      refreshData();
    };
    const onLevel = () => {
      sound.play('levelup');
      refreshData();
    };
    window.addEventListener('cc:built', onBuilt);
    const onDelivery = (e: Event) => ((e as CustomEvent).detail?.ids ?? []).forEach((id: number) => world?.delivery(id));
    const onShip = (e: Event) => world?.shipOut((e as CustomEvent).detail?.id);
    const onTaxi = (e: Event) => {
      const { from, to } = (e as CustomEvent).detail;
      if (!world || map.getZoom() < 15.5) {
        map.flyTo({ center: [to.lng, to.lat], duration: 1200 });
        return;
      }
      world.vehicles.taxi(from, to, () => {});
      setTimeout(() => {
        map.flyTo({ center: [to.lng, to.lat], zoom: Math.max(map.getZoom(), 17), duration: reducedMotion(useGame.getState().me?.prefs) ? 0 : 1600 });
        setTimeout(() => {
          if (world) world.vehicles.hideMe = false;
          sound.play('pop');
        }, 1700);
      }, 2000);
    };
    window.addEventListener('cc:delivery', onDelivery);
    window.addEventListener('cc:ship', onShip);
    window.addEventListener('cc:taxi', onTaxi);
    window.addEventListener('cc:levelup', onLevel);

    // Night falls with the city's local time; crowds follow the clock.
    const tick = () => {
      const now = new Date();
      const h = localHour(m.tz, now) + now.getMinutes() / 60;
      if (nightEl.current) nightEl.current.style.opacity = String(nightAlpha(h));
      const prefs = useGame.getState().me?.prefs ?? {};
      crowd.setEnabled(!prefs.hide_crowds && !world);
      crowd.setDensity(crowdLevel(Math.floor(h)));
      if (world) world.hourLevel = prefs.hide_crowds ? 0.05 : crowdLevel(Math.floor(h));
      sound.setAmbience({ hour: h, zoom: map.getZoom() });
    };
    tick();
    const clock = setInterval(tick, 60_000);
    // ?debug: frame rate, draw calls, triangles and memory.
    const dbg = debug
      ? setInterval(() => {
          if (!debugEl.current) return;
          const st = world?.stats();
          debugEl.current.textContent = st
            ? `fps ${st.fps}  ${st.quality}\ncalls ${st.calls}  tris ${(st.tris / 1000).toFixed(1)}k\nwalkers ${st.walkers}  biz ${st.businesses}  players ${st.players}\ngeometries ${st.geometries}${st.mem != null ? `  heap ${st.mem} MB` : ''}\nzoom ${map.getZoom().toFixed(2)}  pitch ${map.getPitch().toFixed(0)}`
            : '3D layer not loaded';
        }, 500)
      : 0;
    const poll = setInterval(refreshData, 20_000);

    return () => {
      destroyed = true;
      clearTimeout(baseTimer);
      cancelAnimationFrame(rafId);
      clearInterval(clock);
      clearInterval(dbg);
      clearInterval(poll);
      unsubPos();
      unsubPresence();
      unsubSettings();
      window.removeEventListener('cc:sales', onSales);
      window.removeEventListener('cc:built', onBuilt);
      window.removeEventListener('cc:delivery', onDelivery);
      window.removeEventListener('cc:ship', onShip);
      window.removeEventListener('cc:taxi', onTaxi);
      window.removeEventListener('cc:levelup', onLevel);
      crowd.destroy();
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [city.meta.id]);

  return (
    <div className="map-wrap">
      <div ref={el} className="map" />
      <div ref={nightEl} className="night" />
      <div ref={ghostEl} className="cart-ghost" style={{ display: 'none' }} />
      {debug && <pre ref={debugEl} className="debug-overlay" />}
      {issue && (
        <div className="map-issue" role="status">
          <strong>{issue === 'slow' ? 'The street map is slow to load.' : 'The street map can’t load on this device.'}</strong>
          <span>
            It comes from tiles.openfreemap.org. A VPN, ad blocker or school or work network may be blocking it: allow that site or switch
            it off, then reload. Until then, play on this simple street map.
          </span>
          <span className="row">
            <button className="btn small" onClick={() => location.reload()}>Reload</button>
            <button className="btn small ghost" onClick={() => setIssue(null)}>OK</button>
          </span>
        </div>
      )}
    </div>
  );
}
