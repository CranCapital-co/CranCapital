// The world on the city map. Nothing loads until you first zoom out (or
// open the Nation screen); then the countries, borders, troops, armies and
// ships are drawn on the same map as the city, fading in as you zoom out.
// Zoom in on the sea and your warships appear as little models.
// Tap a country out there to open the Nation screen on it.
import { lazy, Suspense, useEffect, useState } from 'react';
import { useGame } from '../lib/store';
import { useFleets, useWorldMap, useWorldState } from './api';
import { useWorldView } from './worldView';

const WorldMap = lazy(() => import('./WorldMap'));

export default function WorldOverlay() {
  const map = useWorldView((s) => s.map);
  const zoomedOut = useWorldView((s) => s.zoomedOut);
  const open = useWorldView((s) => s.open);
  const wanted = zoomedOut || open;
  const [started, setStarted] = useState(false);
  useEffect(() => {
    if (wanted) setStarted(true);
  }, [wanted]);
  if (!map || !started) return null;
  return <Attached active={wanted} />;
}

function Attached({ active }: { active: boolean }) {
  const me = useGame((s) => s.me)!;
  const v = useWorldView();
  const { data } = useWorldMap();
  // Polled only while you can see it.
  const world = useWorldState(v.open ? 20000 : 30000, active);
  // Warships: yours, your allies', and enemy fleets coming at you.
  const fleets = useFleets(active && !!me.nation);
  if (!data || !v.map) return null;
  return (
    <Suspense fallback={null}>
      <WorldMap
        attachTo={v.map}
        map={data.map}
        shapes={data.shapes}
        state={world}
        me={me.nation}
        selected={v.open ? v.selected : null}
        targets={v.open ? v.targets : undefined}
        troops={v.open ? v.troops : null}
        ships={v.open ? v.ships : []}
        padding={v.open ? v.padding : {}}
        fleets={fleets}
        onSelect={(id) => {
          const cb = useWorldView.getState().onSelect;
          if (cb) cb(id);
          else if (id) window.dispatchEvent(new CustomEvent('cc:nations', { detail: { select: id } }));
        }}
      />
    </Suspense>
  );
}
