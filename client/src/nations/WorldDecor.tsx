// The zoomed-out world's finishing touches, on the city map:
//   * the world's square edges are rounded into a circle and feathered into
//     the page, so you never see where the map simply stops;
//   * a "you are here" marker on your city, so you always know where to
//     zoom back in. Tap it to fly home.
import { useEffect, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import { useWorldView, WORLD_ZOOM } from './worldView';

const MAX_LAT = 85.051129;

export function WorldDecor({ home, name, onHome }: { home: [number, number]; name: string; onHome: () => void }) {
  const map = useWorldView((s) => s.map);
  const edge = useRef<HTMLDivElement>(null);
  const onHomeRef = useRef(onHome);
  onHomeRef.current = onHome;
  useEffect(() => {
    if (!map) return;
    const el = document.createElement('button');
    el.className = 'here-marker';
    el.setAttribute('aria-label', `You are here: ${name}. Tap to zoom back in.`);
    const dot = document.createElement('span');
    dot.className = 'here-dot';
    const label = document.createElement('span');
    label.className = 'here-label';
    label.textContent = `You are here · ${name}`;
    el.append(dot, label);
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      onHomeRef.current();
    });
    const marker = new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat(home).addTo(map);
    let raf = 0;
    const update = () => {
      raf = 0;
      el.style.display = map.getZoom() < WORLD_ZOOM - 0.4 ? '' : 'none';
      const d = edge.current;
      if (!d) return;
      const a = map.project([-180, MAX_LAT]);
      const b = map.project([180, -MAX_LAT]);
      const c = map.getContainer();
      const W = c.clientWidth;
      const H = c.clientHeight;
      // Only when the edge of the world is on screen.
      if (map.getZoom() > 5 || (a.x < -8 && a.y < -8 && b.x > W + 8 && b.y > H + 8)) {
        d.style.display = 'none';
        return;
      }
      d.style.display = '';
      d.style.transform = `translate(${a.x}px, ${a.y}px)`;
      d.style.width = `${b.x - a.x}px`;
      d.style.height = `${b.y - a.y}px`;
      d.style.setProperty('--feather', `${Math.max(24, Math.min(110, (b.x - a.x) * 0.07))}px`);
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    map.on('move', schedule);
    map.on('resize', schedule);
    update();
    return () => {
      cancelAnimationFrame(raf);
      map.off('move', schedule);
      map.off('resize', schedule);
      marker.remove();
    };
  }, [map, home[0], home[1], name]);
  return <div ref={edge} className="world-edge" aria-hidden style={{ display: 'none' }} />;
}
