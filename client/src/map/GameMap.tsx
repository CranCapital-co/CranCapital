import { useEffect, useRef, useState } from 'react';
import maplibregl, { type Map as MLMap, type GeoJSONSource, type VectorTileSource } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { mapStyle, LIGHT, DARK, OSM_ATTRIBUTION, mapText } from './style';
import { LOCAL_TILES, tileBounds } from './localTiles';
import { installIconFactory } from './icons';
import { Crowd, crowdLevel, nightAlpha } from './crowd';
import { applyPalette, blendPalette, NIGHT } from './style';
import type { LivingCity, Weather } from '../world3d/living';

// The latest weather and world event for this city (the HUD fetches them;
// the map listens), kept so a map that loads later can use them.
let lastWeather: Weather | null = null;
let lastEvent: string | null = null;
window.addEventListener('cc:weather', (e) => (lastWeather = (e as CustomEvent).detail));
window.addEventListener('cc:event', (e) => (lastEvent = (e as CustomEvent).detail?.kind ?? null));
import { useGame, catalog } from '../lib/store';
import { rpc } from '../lib/supabase';
import { loadWalk, walkable, nearestWalkable, walkImage, plotOf, plotBuildable, plotCoastal, plotPolygon, distM, trafficImage, trafficAt, inCity, type CityData } from '../lib/citydata';
import { trafficLabel } from '../ui/common';
import { localHour, money } from '../lib/format';
import { reportError } from '../lib/errors';
import { reducedMotion, useSettings, lowPowerDevice } from '../lib/settings';
import type { WorldLayer } from '../world3d/WorldLayer';
import { sound } from '../audio/sound';
import { useWorldView, WORLD_ZOOM } from '../nations/worldView';
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
  // A big moment: cheer, then circle the camera around your empire.
  celebrate: () => void;
  emote: (anim: 'wave' | 'cheer') => void;
  // Visit an empire: the camera tours a player's businesses in this city.
  tour: (playerNo: number, name: string) => void;
  // Photo mode: pin the time of day (null = now) and take a picture.
  setPhotoHour: (hour: number | null) => void;
  snapshot: () => Promise<string>;
}

interface Props {
  city: CityData;
  onReady?: (api: MapApi) => void;

  onPlace?: (lat: number, lng: number) => void;
  onSurvey?: (lat: number, lng: number) => void;
}

const empty = (): GeoJSON.FeatureCollection => ({ type: 'FeatureCollection', features: [] });

// Cities you've already flown into this visit (the arrival swoop plays once).
const arrived = new Set<string>();

function dark() {
  const t = document.documentElement.dataset.theme;
  if (t === 'dark') return true;
  if (t === 'light') return false;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches;
}

export default function GameMap({ city, onReady, onPlace, onSurvey }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const ghostEl = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLMap | null>(null);
  const [issue, setIssue] = useState<MapIssue>(null);
  const [arrival, setArrival] = useState<string | null>(null);
  const debugEl = useRef<HTMLPreElement>(null);
  const debug = /[?&#]debug\b|[?&]debug=/.test(location.search + location.hash);
  const cbs = useRef({ onPlace, onSurvey });
  cbs.current = { onPlace, onSurvey };

  useEffect(() => {
    const g = useGame.getState();
    const m = city.meta;
    // There is no character: the camera starts over the city's square (or
    // where you last looked in this city).
    const startPos = (g.pos && inCity(m, g.pos.lat, g.pos.lng) ? g.pos : null) ?? { lat: m.start.lat, lng: m.start.lng };
    arrived.add(m.id);
    useGame.setState({ pos: startPos });
    // iPads and phones: fewer pixels and no multisampling (high-DPI screens
    // barely need it), so the GPU keeps up and memory stays low.
    const lowPower = lowPowerDevice();
    const q = useSettings.getState().quality;
    const map = new maplibregl.Map({
      container: el.current!,
      style: mapStyle(dark() ? DARK : LIGHT, tileBounds(m.bbox)),
      center: [startPos.lng, startPos.lat],
      // Tilted, like a model city on a table.
      zoom: 16.6,
      pitch: lowPower ? 45 : 52,
      bearing: -12,
      maxPitch: lowPower ? 60 : 70,
      // Zoom out as far as the whole world: the city fades out and the
      // countries fade in (the world layers attach to this map).
      minZoom: 1.2,
      maxZoom: 19.5,
      renderWorldCopies: false,
      attributionControl: false,
      antialias: !lowPower && q !== 'saver',
      pixelRatio: Math.min(window.devicePixelRatio || 1, q === 'high' ? (lowPower ? 1.25 : 2) : q === 'medium' ? (lowPower ? 1 : 1.5) : 1),
      dragRotate: true,
      fadeDuration: lowPower ? 0 : 300,
      refreshExpiredTiles: false,
      doubleClickZoom: false, // a tap selects; pinch or use the buttons to zoom
    });
    // Touch screens (iPad first): fingers are less precise than a mouse.
    const touch = window.matchMedia?.('(pointer: coarse)').matches ?? false;
    const canHover = window.matchMedia?.('(hover: hover)').matches ?? !touch;
    mapRef.current = map;
    // Tell the world layers (and the Nation screen) about this map, and
    // whether we're zoomed out far enough to see countries.
    const far = () => map.getZoom() < WORLD_ZOOM;
    useWorldView.getState().set({ map, zoomedOut: far() });
    map.on('zoom', () => {
      const z = far();
      if (z !== useWorldView.getState().zoomedOut) useWorldView.getState().set({ zoomedOut: z });
    });
    map.addControl(new maplibregl.AttributionControl({ compact: false }), 'bottom-left');
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
    installIconFactory(map);
    const crowd = new Crowd(map);
    let selectedBuilding: number | null = null;
    let stateIds: number[] = [];
    let destroyed = false;
    let ready = false; // our sources and layers are on the map
    let world: WorldLayer | null = null; // the 3D layer, once loaded
    let lastBiz: any[] = [];
    let living: LivingCity | null = null;

    // Async results can land after the map is gone (city switch, nation screen).
    const setGeo = (id: string, data: GeoJSON.FeatureCollection) => {
      if (!destroyed) (map.getSource(id) as GeoJSONSource | undefined)?.setData(data);
    };

    // ---------- the camera ----------
    // No character: remember where you were looking, for when you come back.
    const pos = { ...startPos };
    let rafId = 0;
    const unsubPos = useGame.subscribe((s, prev) => {
      if (s.mode !== prev.mode) applyMode();
      if (s.selection.building !== prev.selection.building) selectBuilding(s.selection.building ?? null);
      if (s.refreshKey !== prev.refreshKey) refreshData();
    });
    const unsubPresence = () => {};

    // ---------- game data in view ----------
    let refreshing = false;
    const refreshData = async () => {
      if (refreshing || destroyed) return;
      // Zoomed out over the world: no city data to load.
      if (map.getZoom() < 13) return;
      refreshing = true;
      try {
        const b = map.getBounds();
        const args = { p_city: m.id, p_w: b.getWest() - 0.002, p_s: b.getSouth() - 0.002, p_e: b.getEast() + 0.002, p_n: b.getNorth() + 0.002 };
        const types = catalog()?.business_types ?? [];
        const [biz, blds] = await Promise.all([
          rpc<any[]>('map_businesses', args),
          map.getZoom() >= 14 ? rpc<any[]>('map_buildings', args) : Promise.resolve([] as any[]),
        ]);
        if (destroyed) return;
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
        lastBiz = biz.map((x) => ({ id: x.id, kind: x.kind, tier: types.find((tt) => tt.id === x.kind)?.tier ?? 1, level: x.level, status: x.status, mine: x.mine, lat: x.lat, lng: x.lng, name: x.name, crop: x.crop, fill: x.fill, resource: x.resource, decor: x.decor, owner_no: x.owner_no }));
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
      if (destroyed) return;
      if (map.getZoom() < 15.5) {
        setGeo('plots', empty());
        return;
      }
      const b = map.getBounds();
      const a = plotOf(city, b.getSouth(), b.getWest());
      const z = plotOf(city, b.getNorth(), b.getEast());
      const res = await rpc<any>('map_plots', { p_city: m.id, p_w: b.getWest(), p_s: b.getSouth(), p_e: b.getEast(), p_n: b.getNorth() });
      if (destroyed) return;
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
      // While placing, a finger drag moves the cart preview instead of the map
      // (two fingers still pinch and turn), and the parkable streets shimmer.
      if (placing) map.dragPan.disable();
      else map.dragPan.enable();
      clearInterval(shimmer);
      if (placing && !reducedMotion(useGame.getState().me?.prefs)) {
        let k = 0;
        shimmer = setInterval(() => {
          k += 0.25;
          if (map.getLayer('walk')) map.setPaintProperty('walk', 'raster-opacity', 0.45 + Math.sin(k) * 0.2);
        }, 120);
      }
    };

    let shimmer: any = 0;
    // Show the cart where the finger is, with how busy the street is.
    const preview = (pt: { x: number; y: number }, lngLat: { lat: number; lng: number }) => {
      const el = ghostEl.current;
      if (!el) return;
      const spot = city.walk ? nearestWalkable(city, lngLat.lat, lngLat.lng, 18) : null;
      el.style.display = 'block';
      el.style.left = pt.x + 'px';
      el.style.top = pt.y + 'px';
      el.dataset.ok = spot ? '1' : '0';
      const tr = trafficAt(city, lngLat.lat, lngLat.lng);
      const label = trafficLabel(tr);
      el.dataset.label = spot ? `${label.label} ${'★'.repeat(label.stars)}${'☆'.repeat(3 - label.stars)} · ${tr.toFixed(2)}` : 'Not a street';
    };
    let dragPlace: { lat: number; lng: number; moved: boolean } | null = null;
    map.on('touchstart', (e) => {
      const mode = useGame.getState().mode;
      if ((mode.kind !== 'place-cart' && mode.kind !== 'move-cart') || (e.originalEvent as TouchEvent).touches.length > 1) return;
      dragPlace = { lat: e.lngLat.lat, lng: e.lngLat.lng, moved: false };
      preview(e.point, e.lngLat);
    });
    map.on('touchmove', (e) => {
      if (!dragPlace) return;
      if ((e.originalEvent as TouchEvent).touches.length > 1) {
        dragPlace = null;
        if (ghostEl.current) ghostEl.current.style.display = 'none';
        return;
      }
      dragPlace = { lat: e.lngLat.lat, lng: e.lngLat.lng, moved: true };
      preview(e.point, e.lngLat);
    });
    map.on('touchend', () => {
      const d = dragPlace;
      dragPlace = null;
      if (ghostEl.current && !canHover) ghostEl.current.style.display = 'none';
      if (!d?.moved) return; // a plain tap is handled by 'click'
      const spot = city.walk ? nearestWalkable(city, d.lat, d.lng, 18) : null;
      if (spot) cbs.current.onPlace?.(spot.lat, spot.lng);
      else useGame.getState().toast('Carts park on the green streets and paths: drag onto a green spot.', 'error');
    });

    map.on('mousemove', (e) => {
      const mode = useGame.getState().mode;
      if ((mode.kind === 'place-cart' || mode.kind === 'move-cart') && ghostEl.current && canHover) preview(e.point, e.lngLat);
    });

    map.on('click', async (e) => {
      // Zoomed out: taps are for the countries (the world layers handle them).
      if (map.getZoom() < 13) return;
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
      if (mode.kind === 'survey') {
        cbs.current.onSurvey?.(lat, lng);
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
      // A 3D business model, badges or buildings.
      const hit3d = world?.pick(e.point.x, e.point.y);
      if (hit3d) {
        st.open('business', { id: hit3d.id });
        return;
      }
      // Icons get a generous hit area; the nearest one to the tap wins.
      const pad = touch ? 22 : 8;
      const near = map.queryRenderedFeatures(
        [[e.point.x - pad, e.point.y - pad], [e.point.x + pad, e.point.y + pad]],
        { layers: ['businesses'].filter((l) => map.getLayer(l)) }
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
      if (pick?.layer.id === 'businesses') {
        st.open('business', { id: pick.properties.id });
        return;
      }
      const hits = map.queryRenderedFeatures(e.point, { layers: ['building-3d', 'building-flat'].filter((l) => map.getLayer(l)) });
      const bld = hits.find((h) => h.layer.id.startsWith('building') && h.id !== undefined);
      // Further out the street map merges buildings into blocks: zoom in to
      // pick one building.
      if (bld && map.getZoom() < 14.2) {
        map.flyTo({ center: e.lngLat, zoom: 16.4, duration: 700 });
        return;
      }
      if (bld) {
        useGame.setState({ selection: { building: Number(bld.id) } });
        st.open('property', { building: Number(bld.id) });
        return;
      }
      if (st.win) st.close();
    });

    // ---------- the street map: watch it, and fall back if it can't load ----------
    // The street tiles and fonts are served with the game itself (see
    // localTiles.ts), so school and work networks that block map servers
    // don't stop them. If no street tile has arrived after a few seconds
    // anyway (offline, a very slow connection), we draw the city's streets
    // from the game's own data and say what's wrong. MapLibre's 'load'
    // event waits for every tile, so nothing of ours waits for it.
    let baseOk = false;
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
      if (err?.name === 'AbortError' || /\babort/i.test(msg)) return; // we cancelled it
      console.error('map:', e?.sourceId ?? '', msg);
      reportError('map', (e?.sourceId ? `[${e.sourceId}] ` : '') + msg + (err?.url ? ` (${String(err.url).slice(0, 120)})` : ''));
      if (e?.sourceId !== 'ofm') return;
      startFallback('blocked');
      // One more try later, in case it was a blip.
      if (!retried) {
        retried = true;
        setTimeout(() => {
          if (!destroyed && !baseOk) (map.getSource('ofm') as VectorTileSource | undefined)?.setTiles([LOCAL_TILES]);
        }, 15_000);
      }
    });
    const baseTimer = setTimeout(() => {
      if (baseOk || destroyed) return;
      reportError('map', `no street-map tiles after ${BASE_MAP_TIMEOUT / 1000} s`);
      startFallback('slow');
    }, BASE_MAP_TIMEOUT);

    // Our layers go on as soon as the style is parsed, not on 'load' (which
    // waits for every tile and never comes if the tile server is blocked).
    map.once('style.load', () => {
      if (destroyed) return;
      ready = true;
      map.addSource('plots', { type: 'geojson', data: empty() });
      map.addSource('deposits', { type: 'geojson', data: empty() });
      map.addSource('businesses', { type: 'geojson', data: empty() });
      map.addSource('me', { type: 'geojson', data: empty(), attribution: OSM_ATTRIBUTION });
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
      // City markers belong to street level: they vanish as you zoom out.
      for (const id of ['traffic', 'plots-fill', 'plots-line', 'deposits', 'businesses', 'me', 'business-names']) {
        if (map.getLayer(id)) map.setLayerZoomRange(id, 12.5, 24);
      }
      applyMode();
      refreshData();
      (window as any).__ccMap = map; // handy for debugging and browser tests
      // The 3D layer (Three.js) loads once the street map has drawn, so the
      // city appears first and the heavy download doesn't compete with it.
      let started = false;
      const start3d = () => {
        if (started || destroyed) return;
        started = true;
        loadWorld();
      };
      map.once('idle', start3d);
      setTimeout(start3d, 4000);
      setArrival(m.name);
      setTimeout(() => setArrival(null), 2200);
      onReady?.({
        map,
        flyTo: (lat, lng, zoom) => map.flyTo({ center: [lng, lat], zoom: zoom ?? Math.max(map.getZoom(), 16.2), duration: 1200 }),
        refresh: () => refreshData(),
        setHeatmap: (on) => map.setLayoutProperty('traffic', 'visibility', on ? 'visible' : 'none'),
        setPadding: (inset) =>
          map.easeTo({ padding: { top: 0, left: 0, right: inset.right, bottom: inset.bottom }, duration: reducedMotion(useGame.getState().me?.prefs) ? 0 : 450 }),
        emote: (anim) => world?.emote(anim),
        tour: async (playerNo, name) => {
          const bb = m.bbox;
          const all = await rpc<any[]>('map_businesses', { p_city: m.id, p_w: bb[0], p_s: bb[1], p_e: bb[2], p_n: bb[3] }).catch(() => []);
          const theirs = all.filter((b) => b.owner_no === playerNo).slice(0, 12);
          if (!theirs.length) {
            useGame.getState().toast(`${name} has nothing in ${m.name} to visit.`, 'info');
            return;
          }
          let stop = false;
          const halt = () => {
            stop = true;
            window.dispatchEvent(new CustomEvent('cc:tour', { detail: null }));
          };
          map.once('mousedown', halt);
          map.once('touchstart', halt);
          for (let i = 0; i < theirs.length && !stop && !destroyed; i++) {
            const b = theirs[i];
            window.dispatchEvent(new CustomEvent('cc:tour', { detail: { name, business: b.name, i: i + 1, n: theirs.length } }));
            map.flyTo({ center: [b.lng, b.lat], zoom: 17.6, pitch: 58, bearing: map.getBearing() + 40, duration: reducedMotion(useGame.getState().me?.prefs) ? 0 : 1800, essential: true });
            await new Promise((r) => setTimeout(r, 4200));
          }
          if (!stop) halt();
        },
        setPhotoHour: (hour) => {
          if (!living) return;
          if (hour == null) return living.update(new Date());
          // That hour of today in the city.
          const now = new Date();
          const local = localHour(m.tz, now) + now.getMinutes() / 60;
          living.update(new Date(now.getTime() + (hour - local) * 3600_000));
        },
        snapshot: () =>
          new Promise<string>((resolve) => {
            map.once('render', () => {
              try {
                resolve(map.getCanvas().toDataURL('image/png'));
              } catch {
                resolve('');
              }
            });
            map.triggerRepaint();
          }),
        celebrate: async () => {
          world?.emote('cheer');
          const mine = await rpc<any[]>('my_businesses').catch(() => []);
          const c0 = map.getCenter();
          const pts = [...mine.filter((b) => b.city_id === m.id).map((b) => [b.lng, b.lat] as [number, number]), [c0.lng, c0.lat] as [number, number]];
          const b = new maplibregl.LngLatBounds(pts[0], pts[0]);
          pts.forEach((p) => b.extend(p));
          map.fitBounds(b, { padding: 140, maxZoom: 17.5, pitch: 50, duration: 1400 });
          let stop = false;
          const halt = () => (stop = true);
          map.once('mousedown', halt);
          map.once('touchstart', halt);
          map.once('wheel', halt);
          setTimeout(() => {
            const b0 = map.getBearing();
            const t0 = performance.now();
            const spin = (t: number) => {
              const k = (t - t0) / 8000;
              if (stop || k >= 1 || destroyed) return;
              map.rotateTo(b0 + 360 * (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2), { duration: 0 });
              requestAnimationFrame(spin);
            };
            requestAnimationFrame(spin);
          }, 1500);
        },
        empireView: async () => {
          const mine = await rpc<any[]>('my_businesses').catch(() => []);
          const here = mine.filter((b) => b.city_id === m.id);
          const pts = here.map((b) => [b.lng, b.lat] as [number, number]);
          if (pts.length < 2) {
            map.flyTo({ center: pts[0] ?? [m.start.lng, m.start.lat], zoom: 15.5, pitch: 40, duration: 1200 });
            useGame.getState().toast(here.length ? 'This is your empire in ' + m.name + '.' : 'You don’t own anything in ' + m.name + ' yet.', 'info');
            return;
          }
          const b = new maplibregl.LngLatBounds(pts[0], pts[0]);
          pts.forEach((p) => b.extend(p));
          map.fitBounds(b, { padding: 90, maxZoom: 17, pitch: 45, bearing: map.getBearing(), duration: reducedMotion(useGame.getState().me?.prefs) ? 0 : 1300 });
        },
      });
    });
    map.on('moveend', () => {
      if (map.getZoom() < 13) return; // remember where you were in the city, not the world view
      const c = map.getCenter();
      pos.lat = c.lat;
      pos.lng = c.lng;
      useGame.setState({ pos: { lat: c.lat, lng: c.lng } });
      refreshData();
    });

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
        const w = new WorldLayer(city, () => null); // no character of your own
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
        const { LivingCity } = await import('../world3d/living');
        if (destroyed) return; // switched city while it loaded
        living = new LivingCity(w, map, dark() ? DARK : LIGHT);
        living.setWeather(lastWeather);
        living.setEvent(lastEvent);
        (window as any).__ccLiving = living;
        loadProjects();
        findRivals();
        // Badges hand over to models as you zoom in; names float above heads.
        if (!map.getLayer('businesses')) return;
        map.setPaintProperty('businesses', 'icon-opacity', ['step', ['zoom'], 1, 15.5, 0]);
        map.setLayoutProperty('businesses', 'text-offset', ['interpolate', ['linear'], ['zoom'], 15.5, ['literal', [0, 1.6]], 16, ['literal', [0, -2.5]], 18, ['literal', [0, -6]]]);
        map.setLayoutProperty('businesses', 'text-anchor', ['step', ['zoom'], 'top', 16, 'bottom']);
        map.triggerRepaint();
      } catch (err) {
        reportError('3d', 'world layer failed: ' + String((err as Error)?.message ?? err));
      }
    };
    // City projects rise on the map as players give goods.
    const loadProjects = () =>
      rpc<any[]>('city_projects', { p_city: m.id })
        .then((list) => world?.setProjects(list.map((p) => ({ id: p.id, lat: p.lat, lng: p.lng, progress: Number(p.progress ?? 0), status: p.status, name: p.name }))))
        .catch(() => {});
    // Street rivals: another player's cart nearby selling the same dish.
    const menus = new Map<number, { at: number; ids: string[] }>();
    const menuOf = async (id: number) => {
      const c = menus.get(id);
      if (c && Date.now() - c.at < 300_000) return c.ids;
      const d = await rpc<any>('business_detail', { p_id: id }).catch(() => null);
      const ids = ((d?.menu ?? d?.settings?.menu ?? []) as any[]).map((x) => x.id);
      menus.set(id, { at: Date.now(), ids });
      return ids;
    };
    const findRivals = async () => {
      if (!world) return;
      const rivals = new Set<number>();
      const carts = lastBiz.filter((b) => b.kind === 'cart' && b.status === 'open');
      for (const mine of carts.filter((b) => b.mine).slice(0, 5)) {
        const near = carts.filter((b) => !b.mine && distM(b.lat, b.lng, mine.lat, mine.lng) < 60).slice(0, 4);
        if (!near.length) continue;
        const a = await menuOf(mine.id);
        if (destroyed) return;
        for (const o of near) {
          const bIds = await menuOf(o.id);
          if (a.some((x) => bIds.includes(x))) {
            rivals.add(mine.id);
            rivals.add(o.id);
          }
        }
      }
      world.rivals = rivals;
    };
    const rivalTimer = setInterval(findRivals, 90_000);
    const projectTimer = setInterval(loadProjects, 120_000);

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
    // Shipping: fly to the port and watch the ship leave.
    const onShip = (e: Event) => {
      const id = (e as CustomEvent).detail?.id;
      const b = lastBiz.find((x) => x.id === id);
      if (b) map.flyTo({ center: [b.lng, b.lat], zoom: Math.max(16.4, Math.min(17.2, map.getZoom())), duration: reducedMotion(useGame.getState().me?.prefs) ? 0 : 1200 });
      setTimeout(() => world?.shipOut(id), 1300);
    };
    // Ships arriving at one of your ports in this city sail in.
    const seenArrivals = new Set<number>();
    const watchArrivals = async () => {
      if (!world || document.hidden) return;
      const ships = await rpc<any[]>('my_ships').catch(() => [] as any[]);
      if (destroyed) return;
      const now = Date.now();
      for (const sh of ships) {
        if (sh.to_city !== m.id || seenArrivals.has(sh.id)) continue;
        const due = new Date(sh.arrive_at).getTime() - now;
        if (due > 60_000) continue;
        seenArrivals.add(sh.id);
        const port = lastBiz.find((x) => x.mine && x.kind === 'port');
        if (port) setTimeout(() => world?.shipIn(port.id), Math.max(0, due - 30_000));
      }
    };
    const arrivalTimer = setInterval(watchArrivals, 30_000);
    window.addEventListener('cc:delivery', onDelivery);
    // Fast-forward: sweep the sun from when you left until now.
    const onFastForward = (e: Event) => {
      const hours = Math.min(24, Number((e as CustomEvent).detail?.hours) || 0);
      if (!living || !hours) return;
      const end = Date.now();
      const from = end - hours * 3600_000;
      const t0 = performance.now();
      sound.play('whoosh');
      const tickFf = (t: number) => {
        const k = Math.min(1, (t - t0) / 3000);
        living?.update(new Date(from + (end - from) * (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2)));
        if (k < 1 && !destroyed) requestAnimationFrame(tickFf);
      };
      requestAnimationFrame(tickFf);
    };
    window.addEventListener('cc:fastforward', onFastForward);
    const onWeather = (e: Event) => living?.setWeather((e as CustomEvent).detail);
    const onEvent = (e: Event) => living?.setEvent((e as CustomEvent).detail?.kind ?? null);
    window.addEventListener('cc:weather', onWeather);
    window.addEventListener('cc:event', onEvent);
    window.addEventListener('cc:ship', onShip);
    window.addEventListener('cc:levelup', onLevel);

    // Night falls with the city's local time; crowds follow the clock.
    const tick = () => {
      const now = new Date();
      const h = localHour(m.tz, now) + now.getMinutes() / 60;
      if (living) living.update(now);
      else if (ready) applyPalette(map, blendPalette(dark() ? DARK : LIGHT, NIGHT, (nightAlpha(h) / 0.34) * 0.85)); // 2D map: night by the clock
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
    const poll = setInterval(() => !document.hidden && refreshData(), 40_000);

    return () => {
      destroyed = true;
      clearTimeout(baseTimer);
      cancelAnimationFrame(rafId);
      clearInterval(clock);
      clearInterval(rivalTimer);
      clearInterval(projectTimer);
      clearInterval(shimmer);
      clearInterval(dbg);
      clearInterval(poll);
      clearInterval(arrivalTimer);
      unsubPos();
      unsubPresence();
      unsubSettings();
      window.removeEventListener('cc:sales', onSales);
      window.removeEventListener('cc:built', onBuilt);
      window.removeEventListener('cc:delivery', onDelivery);
      window.removeEventListener('cc:fastforward', onFastForward);
      window.removeEventListener('cc:weather', onWeather);
      window.removeEventListener('cc:event', onEvent);
      window.removeEventListener('cc:ship', onShip);
      window.removeEventListener('cc:levelup', onLevel);
      crowd.destroy();
      if (useWorldView.getState().map === map) useWorldView.getState().set({ map: null, zoomedOut: false });
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [city.meta.id]);

  return (
    <div className="map-wrap">
      <div ref={el} className="map" />
      <div ref={ghostEl} className="cart-ghost" style={{ display: 'none' }}>
        <svg width="26" height="26" aria-hidden><use href="#i-cart" /></svg>
      </div>
      {debug && <pre ref={debugEl} className="debug-overlay" />}
      {arrival && (
        <div className="arrival" aria-live="polite">
          <span className="arrival-kicker">Welcome to</span>
          <span className="arrival-city">{arrival}</span>
        </div>
      )}
      {issue && (
        <div className="map-issue" role="status">
          <strong>{issue === 'slow' ? 'The street map is slow to load.' : 'The street map can’t load on this device.'}</strong>
          <span>
            Check your internet connection, then reload. Until then, play on this simple street map.
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
