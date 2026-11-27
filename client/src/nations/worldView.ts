// The world, drawn on the city map itself: zoom out and the countries fade
// in as the city fades out. This little store connects the three pieces:
// the city map (which owns the map), the world layers attached to it, and
// the Nation screen's panels (which choose what is selected or targeted).
import { create } from 'zustand';
import type { Map as MLMap } from 'maplibre-gl';
import type { TroopMap } from './WorldMap';

export type Ship = { id: number; from: [number, number]; to: [number, number]; depart: string; arrive: string; label: string };

interface WorldView {
  map: MLMap | null; // the city map, once it exists
  zoomedOut: boolean; // zoomed out far enough to see countries
  open: boolean; // the Nation screen is open
  selected: string | null;
  targets: string[] | undefined;
  troops: TroopMap | null;
  ships: Ship[];
  padding: { right?: number; bottom?: number };
  onSelect: ((id: string | null) => void) | null;
  set: (p: Partial<WorldView>) => void;
}

export const useWorldView = create<WorldView>((set) => ({
  map: null,
  zoomedOut: false,
  open: false,
  selected: null,
  targets: undefined,
  troops: null,
  ships: [],
  padding: {},
  onSelect: null,
  set: (p) => set(p),
}));

// Below this zoom the city fades out and the world fades in.
export const WORLD_ZOOM = 11.5;
