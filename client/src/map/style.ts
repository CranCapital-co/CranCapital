import type { StyleSpecification } from 'maplibre-gl';

// CranCapital's own map look, drawn from OpenFreeMap's OpenStreetMap vector
// tiles (free, no key). Buildings are tinted by game state through
// feature-state: status = mine | rented | owned | sale, selected = true.

export const ATTRIBUTION =
  '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> · <a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">© OpenMapTiles</a> · <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a>';

export interface Palette {
  land: string;
  park: string;
  water: string;
  road: string;
  roadCasing: string;
  minor: string;
  path: string;
  rail: string;
  building: string;
  buildingTop: string;
  label: string;
  labelHalo: string;
}

export const LIGHT: Palette = {
  land: '#efe8da',
  park: '#cfe2bd',
  water: '#9fd0d3',
  road: '#ffffff',
  roadCasing: '#d6ccb9',
  minor: '#fbf8f2',
  path: '#c9bea8',
  rail: '#b7ad9c',
  building: '#f1e6d2',
  buildingTop: '#e2d5bd',
  label: '#3d4a44',
  labelHalo: '#f7f2e8',
};

export const DARK: Palette = {
  land: '#1b2320',
  park: '#1f3428',
  water: '#163845',
  road: '#38433f',
  roadCasing: '#26302c',
  minor: '#2d3734',
  path: '#3c4642',
  rail: '#4a5450',
  building: '#2b3532',
  buildingTop: '#34403c',
  label: '#c9d4cf',
  labelHalo: '#141b19',
};

export const STATE_COLORS = {
  mine: '#e8a93a',
  rented: '#2fa37a',
  owned: '#5b8fc4',
  sale: '#e0654a',
  selected: '#ffd65c',
};

const statusColor = (p: Palette): any => [
  'case',
  ['boolean', ['feature-state', 'selected'], false], STATE_COLORS.selected,
  ['match', ['coalesce', ['feature-state', 'status'], 'none'],
    'mine', STATE_COLORS.mine,
    'rented', STATE_COLORS.rented,
    'owned', STATE_COLORS.owned,
    'sale', STATE_COLORS.sale,
    p.building],
];

export function mapStyle(p: Palette = LIGHT): StyleSpecification {
  // One zoom curve on the outside; the road class picks the size at each stop.
  const widths = (major: number, mid: number, minor: number, service: number): any => {
    const at = (k: number) => ['match', ['get', 'class'], ['motorway', 'trunk', 'primary'], major * k, ['secondary', 'tertiary'], mid * k, 'service', service * k, minor * k];
    return ['interpolate', ['exponential', 1.6], ['zoom'], 12, at(0.4), 15, at(2.2), 18, at(9)];
  };
  return {
    version: 8,
    // Soft, warm light so 3D buildings read clearly without going grey.
    light: { anchor: 'viewport', color: '#fff6e5', intensity: 0.22, position: [1.3, 210, 35] },
    glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    sources: {
      ofm: { type: 'vector', url: 'https://tiles.openfreemap.org/planet', attribution: ATTRIBUTION },
    },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': p.land } },
      {
        id: 'landuse', type: 'fill', source: 'ofm', 'source-layer': 'landuse',
        filter: ['in', ['get', 'class'], ['literal', ['residential', 'commercial', 'retail', 'university', 'school', 'hospital']]],
        paint: { 'fill-color': p.buildingTop, 'fill-opacity': 0.18 },
      },
      {
        id: 'landcover', type: 'fill', source: 'ofm', 'source-layer': 'landcover',
        filter: ['in', ['get', 'class'], ['literal', ['grass', 'wood', 'farmland']]],
        paint: { 'fill-color': p.park, 'fill-opacity': 0.75 },
      },
      { id: 'park', type: 'fill', source: 'ofm', 'source-layer': 'park', paint: { 'fill-color': p.park, 'fill-opacity': 0.85 } },
      { id: 'water', type: 'fill', source: 'ofm', 'source-layer': 'water', paint: { 'fill-color': p.water } },
      {
        id: 'waterway', type: 'line', source: 'ofm', 'source-layer': 'waterway',
        paint: { 'line-color': p.water, 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 1, 18, 6] },
      },
      {
        id: 'path', type: 'line', source: 'ofm', 'source-layer': 'transportation', minzoom: 14,
        filter: ['all', ['in', ['get', 'class'], ['literal', ['path', 'track', 'pier']]], ['!=', ['get', 'brunnel'], 'tunnel']],
        paint: { 'line-color': p.path, 'line-width': ['interpolate', ['linear'], ['zoom'], 14, 0.6, 18, 3], 'line-dasharray': [2, 1.5] },
      },
      {
        id: 'road-casing', type: 'line', source: 'ofm', 'source-layer': 'transportation',
        filter: ['all', ['in', ['get', 'class'], ['literal', ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor', 'service']]], ['!=', ['get', 'brunnel'], 'tunnel']],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': p.roadCasing,
          'line-width': widths(1.6, 1.25, 0.9, 0.5),
        },
      },
      {
        id: 'road', type: 'line', source: 'ofm', 'source-layer': 'transportation',
        filter: ['all', ['in', ['get', 'class'], ['literal', ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor', 'service']]], ['!=', ['get', 'brunnel'], 'tunnel']],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': ['match', ['get', 'class'], ['minor', 'service'], p.minor, p.road],
          'line-width': widths(1.2, 0.95, 0.65, 0.35),
        },
      },
      {
        id: 'rail', type: 'line', source: 'ofm', 'source-layer': 'transportation',
        filter: ['all', ['in', ['get', 'class'], ['literal', ['rail', 'transit']]], ['!=', ['get', 'brunnel'], 'tunnel']],
        paint: { 'line-color': p.rail, 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 0.6, 18, 2.5], 'line-dasharray': [3, 2] },
      },
      {
        id: 'building-flat', type: 'fill', source: 'ofm', 'source-layer': 'building', maxzoom: 15,
        paint: { 'fill-color': statusColor(p), 'fill-opacity': ['interpolate', ['linear'], ['zoom'], 13, 0.4, 15, 0.9] },
      },
      {
        id: 'building-3d', type: 'fill-extrusion', source: 'ofm', 'source-layer': 'building', minzoom: 14.5,
        filter: ['!=', ['get', 'hide_3d'], true],
        paint: {
          'fill-extrusion-color': statusColor(p),
          'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'], 14.5, 0, 15.5, ['coalesce', ['get', 'render_height'], 6]],
          'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
          'fill-extrusion-opacity': 0.92,
          'fill-extrusion-vertical-gradient': true,
        },
      },
      {
        id: 'water-label', type: 'symbol', source: 'ofm', 'source-layer': 'water_name', minzoom: 12,
        layout: { 'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']], 'text-font': ['Noto Sans Italic'], 'text-size': 13 },
        paint: { 'text-color': '#3b7b86', 'text-halo-color': p.labelHalo, 'text-halo-width': 1 },
      },
      {
        id: 'road-label', type: 'symbol', source: 'ofm', 'source-layer': 'transportation_name', minzoom: 15,
        filter: ['in', ['get', 'class'], ['literal', ['primary', 'secondary', 'tertiary', 'minor', 'trunk']]],
        layout: {
          'symbol-placement': 'line', 'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']],
          'text-font': ['Noto Sans Regular'], 'text-size': ['interpolate', ['linear'], ['zoom'], 15, 10, 18, 13],
        },
        paint: { 'text-color': p.label, 'text-halo-color': p.labelHalo, 'text-halo-width': 1.4 },
      },
      {
        id: 'poi-label', type: 'symbol', source: 'ofm', 'source-layer': 'poi', minzoom: 15.5,
        filter: ['all', ['in', ['get', 'class'], ['literal', ['railway', 'attraction', 'museum', 'theatre', 'park', 'stadium']]], ['<=', ['get', 'rank'], 12]],
        layout: {
          'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']], 'text-font': ['Noto Sans Bold'], 'text-size': 11,
          'text-max-width': 8, 'text-offset': [0, 0.6], 'text-anchor': 'top',
        },
        paint: { 'text-color': '#7a5a2f', 'text-halo-color': p.labelHalo, 'text-halo-width': 1.4 },
      },
      {
        id: 'place-label', type: 'symbol', source: 'ofm', 'source-layer': 'place',
        filter: ['in', ['get', 'class'], ['literal', ['city', 'town', 'suburb', 'quarter', 'neighbourhood']]],
        layout: {
          'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']], 'text-font': ['Noto Sans Bold'],
          'text-size': ['match', ['get', 'class'], 'city', 18, 'town', 15, 12], 'text-transform': 'uppercase', 'text-letter-spacing': 0.08,
        },
        paint: { 'text-color': p.label, 'text-halo-color': p.labelHalo, 'text-halo-width': 1.6, 'text-opacity': 0.8 },
      },
    ],
  } as StyleSpecification;
}
