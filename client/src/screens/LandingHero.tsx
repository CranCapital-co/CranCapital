import { useEffect, useRef, useState, type ReactNode } from 'react';
import { reducedMotion, useSettings } from '../lib/settings';
import { rpc } from '../lib/supabase';

// The landing page's hero: a live 3D view slowly circling a real London
// street, with walkers, carts and real players' businesses. It loads after
// the page is idle, skips slow connections, Battery saver and Reduce
// Motion, and shows the drawing (the fallback) until the street map's first
// tiles arrive, or for good if WebGL or the tiles fail.
export default function LandingHero({ fallback }: { fallback: ReactNode }) {
  const el = useRef<HTMLDivElement>(null);
  const [live, setLive] = useState(false);
  useEffect(() => {
    const conn = (navigator as any).connection;
    if (reducedMotion() || useSettings.getState().quality === 'saver' || conn?.saveData || /(^|-)2g$/.test(conn?.effectiveType ?? '')) return;
    let map: any = null;
    let destroyed = false;
    let raf = 0;
    const start = async () => {
      const [{ default: maplibregl }, style, citydata, { WorldLayer }] = await Promise.all([
        import('maplibre-gl'),
        import('../map/style'),
        import('../lib/citydata'),
        import('../world3d/WorldLayer'),
        import('maplibre-gl/dist/maplibre-gl.css'),
      ]);
      const city = await citydata.loadCity('london');
      await citydata.loadWalk(city);
      if (destroyed || !el.current) return;
      const c = city.meta.start;
      map = new maplibregl.Map({
        container: el.current,
        style: style.mapStyle(style.LIGHT),
        center: [c.lng, c.lat],
        zoom: 17.2,
        pitch: 60,
        bearing: -20,
        interactive: false,
        attributionControl: false,
        fadeDuration: 0,
      });
      map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
      map.on('error', () => {}); // blocked tiles: the drawing stays
      map.once('style.load', async () => {
        if (destroyed) return;
        const w = new WorldLayer(city, () => null);
        w.setQuality('medium');
        w.autoQuality = false;
        map.addLayer(w, map.getLayer('water-label') ? 'water-label' : undefined);
        // Real businesses nearby (when the server allows), plus a few carts
        // so the street always has something going on.
        const b = map.getBounds();
        let biz: any[] = [];
        try {
          biz = await rpc<any[]>('map_businesses', { p_city: 'london', p_w: b.getWest(), p_s: b.getSouth(), p_e: b.getEast(), p_n: b.getNorth() });
        } catch {
          /* visitors may not be allowed: decorative carts only */
        }
        const carts = [[12, -40], [-35, 18], [48, 30]].map(([dx, dy], i) => {
          const s = citydata.nearestWalkable(city, c.lat + dy / 111000, c.lng + dx / 69000, 30) ?? { lat: c.lat, lng: c.lng };
          return { id: -1 - i, kind: 'cart', tier: 1, level: 1 + (i % 3), status: 'open', mine: false, lat: s.lat, lng: s.lng };
        });
        w.setBusinesses([...carts, ...biz.slice(0, 40).map((x) => ({ id: x.id, kind: x.kind, tier: 1, level: x.level, status: x.status, mine: false, lat: x.lat, lng: x.lng }))]);
      });
      map.on('sourcedata', (e: any) => {
        if (e.sourceId === 'ofm' && e.tile && !destroyed) setLive(true);
      });
      // A slow circle around the square.
      let last = performance.now();
      const spin = (t: number) => {
        raf = requestAnimationFrame(spin);
        if (document.hidden) return;
        const dt = (t - last) / 1000;
        last = t;
        map.setBearing(map.getBearing() + dt * 3);
      };
      raf = requestAnimationFrame(spin);
    };
    const idle = (window as any).requestIdleCallback ?? ((f: () => void) => setTimeout(f, 700));
    const handle = idle(() => start().catch(() => {}));
    return () => {
      destroyed = true;
      cancelAnimationFrame(raf);
      (window as any).cancelIdleCallback?.(handle);
      map?.remove();
    };
  }, []);
  return (
    <div className={`hero-scene ${live ? 'live' : ''}`}>
      <div className="hero-fallback">{fallback}</div>
      <div ref={el} className="hero-map" aria-label="A live view of a real London street" role="img" />
    </div>
  );
}
