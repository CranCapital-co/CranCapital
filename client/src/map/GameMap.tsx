import { useEffect, useRef } from 'react';
import maplibregl, { type Map as MLMap, type GeoJSONSource } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { mapStyle, LIGHT, DARK } from './style';
import { installIconFactory } from './icons';
import { Crowd, crowdLevel, nightAlpha } from './crowd';
import { useGame, catalog } from '../lib/store';
import { rpc } from '../lib/supabase';
import { loadWalk, walkable, nearestWalkable, walkImage, plotOf, plotBuildable, plotCoastal, plotPolygon, distM, trafficImage, inCity, type CityData } from '../lib/citydata';
import { onPresence, track, type Presence } from '../lib/realtime';
import { localHour, money, ringFor } from '../lib/format';

const WALK_SPEED = 45; // metres per second on screen (server allows up to 60)

export interface MapApi {
  map: MLMap;
  flyTo: (lat: number, lng: number, zoom?: number) => void;
  refresh: () => void;
  setHeatmap: (on: boolean) => void;
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
      zoom: 16.4,
      pitch: 52,
      bearing: -12,
      maxPitch: 70,
      minZoom: 12.5,
      maxZoom: 19.5,
      maxBounds: [
        [m.bbox[0] - 0.03, m.bbox[1] - 0.02],
        [m.bbox[2] + 0.03, m.bbox[3] + 0.02],
      ],
      attributionControl: false,
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
            name: me?.display_name ?? 'You',
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
    });

    // ---------- other players ----------
    const unsubPresence = onPresence((others) => {
      const feats: GeoJSON.Feature[] = [];
      others.forEach((p) => {
        if (p.in) return;
        feats.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
          properties: { no: p.no, name: p.n, icon: `av:${p.s}:${p.r}:${p.rs || 'standard'}` },
        });
      });
      setGeo('players', { type: 'FeatureCollection', features: feats });
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
              properties: { id: x.id, name: x.name, mine: x.mine, kind: x.kind, owner: x.owner_name, level: x.level, icon: `bz:${t?.icon ?? '🏪'}:${t?.tier ?? 1}:${x.mine ? 1 : 0}:${dim ? 1 : 0}` },
            };
          }),
        });
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
      const mode = useGame.getState().mode;
      const land = mode.kind === 'land';
      for (const id of ['plots-fill', 'plots-line', 'deposits']) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', land ? 'visible' : 'none');
      if (land) refreshPlots();
      const placing = mode.kind === 'place-cart' || mode.kind === 'move-cart';
      if (placing) {
        await loadWalk(city);
        // Paint the streets where a cart may park in green.
        if (!map.getSource('walk')) {
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
      // Walk mode: avatars, businesses, buildings, or walk.
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

    map.on('load', () => {
      if (destroyed) return;
      map.addSource('plots', { type: 'geojson', data: empty() });
      map.addSource('deposits', { type: 'geojson', data: empty() });
      map.addSource('businesses', { type: 'geojson', data: empty() });
      map.addSource('players', { type: 'geojson', data: empty() });
      map.addSource('me', { type: 'geojson', data: meFeature() });
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
      onReady?.({
        map,
        flyTo: (lat, lng, zoom) => map.flyTo({ center: [lng, lat], zoom: zoom ?? Math.max(map.getZoom(), 16.2), duration: 1200 }),
        refresh: () => refreshData(),
        setHeatmap: (on) => map.setLayoutProperty('traffic', 'visibility', on ? 'visible' : 'none'),
      });
    });
    map.on('moveend', () => refreshData());
    map.on('mouseenter', 'businesses', () => (map.getCanvas().style.cursor = 'pointer'));
    map.on('mouseleave', 'businesses', () => applyMode());

    // Sales pop up over your businesses.
    const onSales = (e: Event) => {
      const d = (e as CustomEvent).detail;
      if (!d?.lat || map.getZoom() < 14) return;
      const div = document.createElement('div');
      div.className = 'sale-pop';
      div.textContent = `+${money(d.revenue)}`;
      const mk = new maplibregl.Marker({ element: div, anchor: 'bottom' }).setLngLat([d.lng, d.lat]).addTo(map);
      setTimeout(() => mk.remove(), 2400);
    };
    window.addEventListener('cc:sales', onSales);

    // Night falls with the city's local time; crowds follow the clock.
    const tick = () => {
      const now = new Date();
      const h = localHour(m.tz, now) + now.getMinutes() / 60;
      if (nightEl.current) nightEl.current.style.opacity = String(nightAlpha(h));
      const prefs = useGame.getState().me?.prefs ?? {};
      crowd.setEnabled(!prefs.hide_crowds);
      crowd.setDensity(crowdLevel(Math.floor(h)));
    };
    tick();
    const clock = setInterval(tick, 60_000);
    const poll = setInterval(refreshData, 20_000);

    return () => {
      destroyed = true;
      cancelAnimationFrame(rafId);
      clearInterval(clock);
      clearInterval(poll);
      unsubPos();
      unsubPresence();
      window.removeEventListener('cc:sales', onSales);
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
      <div ref={ghostEl} className="cart-ghost" style={{ display: 'none' }}>🛒</div>
    </div>
  );
}
