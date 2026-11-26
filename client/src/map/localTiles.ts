// The street map's tiles, served with the game itself (built by
// tools/citydata/tiles.mjs from OpenFreeMap's OpenStreetMap tiles), so the
// city map works where tiles.openfreemap.org is blocked: school and work
// networks, some VPNs and filters. Tiles are stored gzipped and unzipped
// here, whatever the web server does about compression.
import maplibregl from 'maplibre-gl';

const BASE = new URL(import.meta.env.BASE_URL, location.href).href;
export const LOCAL_TILES = 'cctile://{z}/{x}/{y}';
// Must match MARGIN in tools/citydata/tiles.mjs and the camera bounds in GameMap.
export const TILE_MARGIN = { lng: 0.03, lat: 0.02 };

let gunzip: ((b: Uint8Array) => Promise<ArrayBuffer>) | null = null;
async function unzip(b: Uint8Array): Promise<ArrayBuffer> {
  if (!gunzip) {
    if (typeof DecompressionStream !== 'undefined') {
      gunzip = async (x) => new Response(new Blob([x]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
    } else {
      // Older iPads (before iPadOS 16.4).
      const { gunzipSync } = await import('three/examples/jsm/libs/fflate.module.js');
      gunzip = async (x) => {
        const out = gunzipSync(x);
        return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
      };
    }
  }
  return gunzip(b);
}

let added = false;
export function registerLocalTiles() {
  if (added) return;
  added = true;
  maplibregl.addProtocol('cctile', async (params, abort) => {
    const m = /^cctile:\/\/(\d+)\/(\d+)\/(\d+)/.exec(params.url);
    if (!m) throw new Error('bad tile url ' + params.url);
    const res = await fetch(`${BASE}tiles/${m[1]}/${m[2]}/${m[3]}.pbf.gz`, { signal: abort.signal });
    // Outside the area we ship: an empty tile, not an error.
    if (res.status === 404) return { data: new ArrayBuffer(0) };
    if (!res.ok) throw new Error(`street tile ${m[1]}/${m[2]}/${m[3]}: HTTP ${res.status}`);
    // A web page instead of a tile (a dev server's fallback, or a school
    // filter's "blocked" page): treat it as an empty tile, not garbage.
    if ((res.headers.get('content-type') ?? '').includes('text/html')) return { data: new ArrayBuffer(0) };
    const b = new Uint8Array(await res.arrayBuffer());
    if (b[0] === 0x3c) return { data: new ArrayBuffer(0) }; // '<': HTML or XML, not a tile
    // A server (or proxy) may already have unzipped it.
    return { data: b[0] === 0x1f && b[1] === 0x8b ? await unzip(b) : b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) };
  });
  // Label fonts. We ship the common ranges (Latin, Greek, Cyrillic,
  // punctuation); a range we don't have (a street name in another script)
  // loads as an empty font, so those letters are just left out.
  maplibregl.addProtocol('ccglyph', async (params, abort) => {
    const m = /^ccglyph:\/\/([^/]+)\/(\d+-\d+)/.exec(params.url);
    if (!m) return { data: new ArrayBuffer(0) };
    const res = await fetch(`${BASE}glyphs/${decodeURIComponent(m[1])}/${m[2]}.pbf`, { signal: abort.signal }).catch(() => null);
    if (!res || !res.ok || (res.headers.get('content-type') ?? '').includes('text/html')) return { data: new ArrayBuffer(0) };
    const b = await res.arrayBuffer();
    return { data: new Uint8Array(b)[0] === 0x3c ? new ArrayBuffer(0) : b };
  });
}

export function tileBounds(bbox: [number, number, number, number]): [number, number, number, number] {
  return [bbox[0] - TILE_MARGIN.lng, bbox[1] - TILE_MARGIN.lat, bbox[2] + TILE_MARGIN.lng, bbox[3] + TILE_MARGIN.lat];
}
