// Nations: what the server tells us about the world, cached and kept fresh.
import { useEffect, useRef, useState } from 'react';
import { feature } from 'topojson-client';
import { retrying, rpc, supabase } from '../lib/supabase';
import { useGame } from '../lib/store';

export interface Territory {
  id: string; name: string; iso2: string | null; continent: string; region: string;
  pop_m: number; gdp_bn: number; lat: number; lng: number; landlocked: boolean; color: string;
  value: number; income: number; manpower: number; militia: number; home: string | null;
}
export interface UnitType {
  id: string; name: string; plural: string; icon: string; atk: number; def: number; cost: number; manpower: number;
  upkeep: number; minutes: number; speed: number; building: string; tech: string | null; unlock: string; sort: number;
}
export interface BuildingType {
  id: string; name: string; body: string; icon: string; max_level: number; cost: number; minutes: number;
  upkeep: number; unlock: string; tech: string | null; coastal: boolean; sort: number;
}
export interface Tech { id: string; name: string; body: string; branch: string; cost: number; requires: string[]; effect: Record<string, number>; sort: number }
export interface WorldMapData {
  territories: Territory[];
  links: [string, string, 'land' | 'sea', number][];
  units: UnitType[];
  buildings: BuildingType[];
  techs: Tech[];
}
export interface NationLite {
  id: string; name: string; color: string; status: 'active' | 'fallen';
  leader: { no: number; name: string; skin: string } | null;
  skill: number; skill_name: string; personality: string; power: number; share: number;
  alliance: number | null; protected: boolean; stability: number; rank?: number | null;
}
export interface WarLite { id: number; name: string; attacker: string; defender: string; score: number; started_at: string; att: string[]; def: string[] }
export interface MoveLite { id: number; nation: string; from: string; to: string; kind: 'move' | 'attack' | 'raid' | 'missile'; depart_at: string; arrive_at: string }
export interface WorldState {
  at: string;
  era?: null; // eras are gone: the world never resets
  coalitions?: { id: number; target: string; formed_at: string; members: string[] | null }[];
  territories: [string, string, string][];
  nations: NationLite[];
  alliances: { id: number; name: string; color: string; founder: string; members: string[] }[];
  wars: WarLite[];
  moves: MoveLite[];
  battles: { id: number; at: string; territory: string; winner: string; captured: boolean }[];
}

// The fixed map: fetched once a session.
let mapP: Promise<WorldMapData> | null = null;
export function loadWorldMap(): Promise<WorldMapData> {
  if (!mapP) mapP = rpc<WorldMapData>('world_map').catch((e) => { mapP = null; throw e; });
  return mapP;
}

// Country shapes (Natural Earth 1:110m, public domain), keyed by territory id.
// The topology is kept too: it knows which edges are coast (used by one
// country only), which is where fleets anchor.
let shapesP: Promise<GeoJSON.FeatureCollection> | null = null;
let topology: any = null;
let shapeList: GeoJSON.FeatureCollection | null = null;
export const worldTopology = () => topology;
export const worldShapes = () => shapeList;
export function loadShapes(): Promise<GeoJSON.FeatureCollection> {
  if (!shapesP) {
    shapesP = fetch(`${import.meta.env.BASE_URL}world/countries.json`)
      .then((r) => {
        if (!r.ok) throw new Error('Couldn’t load the world map.');
        return r.json();
      })
      .then((topo) => {
        topology = topo;
        shapeList = feature(topo, topo.objects.countries) as unknown as GeoJSON.FeatureCollection;
        return shapeList;
      })
      .catch((e) => { shapesP = null; throw e; });
  }
  return shapesP;
}

export function useWorldMap() {
  const [data, setData] = useState<{ map: WorldMapData; shapes: GeoJSON.FeatureCollection } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    setError(null);
    // A busy server or a flaky connection: try a few times before giving up.
    retrying(() => Promise.all([loadWorldMap(), loadShapes()]), 3, 20000)
      .then(([map, shapes]) => alive && setData({ map, shapes }))
      .catch((e) => alive && setError(e.message));
    return () => { alive = false; };
  }, [attempt]);
  return { data, error, retry: () => setAttempt((x) => x + 1) };
}

// Live world: polled, and refreshed sooner when the server broadcasts news.
let worldListeners = 0;
let worldChannel: ReturnType<typeof supabase.channel> | null = null;
const worldBus = new EventTarget();
function joinWorldNews() {
  worldListeners++;
  if (worldChannel || !useGame.getState().session) return;
  worldChannel = supabase.channel('world:nations', { config: { private: true } });
  for (const ev of ['news', 'move', 'battle']) {
    worldChannel.on('broadcast', { event: ev }, (msg) => worldBus.dispatchEvent(new CustomEvent(ev, { detail: msg.payload })));
  }
  worldChannel.subscribe();
}
function leaveWorldNews() {
  worldListeners = Math.max(0, worldListeners - 1);
  if (!worldListeners && worldChannel) {
    supabase.removeChannel(worldChannel);
    worldChannel = null;
  }
}
export function onWorldNews(ev: 'news' | 'move' | 'battle', fn: (d: any) => void) {
  const h = (e: Event) => fn((e as CustomEvent).detail);
  worldBus.addEventListener(ev, h);
  return () => worldBus.removeEventListener(ev, h);
}

// One shared copy of the live world for everything that shows it (the
// Nation screen, the world on the city map): one poll, not one per screen.
let shared: WorldState | null = null;
const subs = new Map<number, { every: number; set: (s: WorldState) => void }>();
let subId = 0;
let pollTimer: any = 0;
let soonTimer: any = 0;
let newsOffs: (() => void)[] = [];
let inflight: Promise<void> | null = null;
function loadShared() {
  if (inflight) return inflight;
  inflight = rpc<WorldState>('world_state')
    .then((s) => {
      shared = s;
      subs.forEach((x) => x.set(s));
    })
    .catch(() => {})
    .finally(() => {
      inflight = null;
    });
  return inflight;
}
function repoll() {
  clearInterval(pollTimer);
  if (!subs.size) return;
  const every = Math.min(...[...subs.values()].map((x) => x.every));
  pollTimer = setInterval(() => !document.hidden && loadShared(), every);
}

export function useWorldState(every = 15000, active = true) {
  const [state, setState] = useState<WorldState | null>(shared);
  useEffect(() => {
    if (!active) return;
    const id = ++subId;
    subs.set(id, { every, set: setState });
    if (subs.size === 1) {
      joinWorldNews();
      const soon = () => {
        clearTimeout(soonTimer);
        soonTimer = setTimeout(loadShared, 1200);
      };
      newsOffs = [onWorldNews('news', soon), onWorldNews('move', soon), onWorldNews('battle', soon)];
    }
    if (shared) setState(shared);
    loadShared();
    repoll();
    return () => {
      subs.delete(id);
      repoll();
      if (!subs.size) {
        clearTimeout(soonTimer);
        newsOffs.forEach((f) => f());
        newsOffs = [];
        leaveWorldNews();
      }
    };
  }, [every, active]);
  return state;
}

export const flag = (iso2: string | null | undefined) =>
  iso2 && /^[A-Z]{2}$/.test(iso2) ? String.fromCodePoint(...[...iso2].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65)) : '🏳️';

export const PERSONALITY: Record<string, string> = {
  aggressive: 'Aggressive: quick to pick fights it thinks it can win',
  expansionist: 'Expansionist: grows by taking weaker neighbours',
  balanced: 'Balanced: builds, trades and fights when it must',
  defensive: 'Defensive: forts, pacts and a big army at home',
  diplomatic: 'Diplomatic: makes friends and alliances',
  mercantile: 'Mercantile: money and research first',
};

// "in 3 days" for long waits, "2 h 5 min" for short ones.
export function untilLong(ts: string | number | Date | null | undefined) {
  if (!ts) return '';
  const h = (new Date(ts).getTime() - Date.now()) / 3600e3;
  if (h >= 48) return `${Math.round(h / 24)} days`;
  if (h >= 1) return `${Math.floor(h)} h ${Math.round((h % 1) * 60)} min`;
  return `${Math.max(0, Math.round(h * 60))} min`;
}

export function fmtPop(m: number) {
  return m >= 1000 ? `${(m / 1000).toFixed(2)} billion` : m >= 1 ? `${m.toFixed(m >= 100 ? 0 : 1)} million` : `${Math.round(m * 1000)}k`;
}
export function fmtGdp(bn: number) {
  return bn >= 1000 ? `$${(bn / 1000).toFixed(1)} trillion` : bn >= 1 ? `$${bn.toFixed(bn >= 100 ? 0 : 1)} billion` : `$${Math.round(bn * 1000)} million`;
}

// Estimated attack strength of an army (what the server's battle uses,
// before technology, perks and the ±10% fog of war).
export function attackOf(units: Record<string, number>, types: UnitType[], seaNoFleet: boolean) {
  let a = 0;
  for (const [k, v] of Object.entries(units)) {
    const u = types.find((t) => t.id === k);
    if (!u || !v) continue;
    a += v * u.atk * (seaNoFleet && k !== 'air' && k !== 'naval' ? 0.6 : 1);
  }
  return a;
}

export function oddsLabel(ratio: number) {
  if (!isFinite(ratio)) return { label: 'Unopposed', tone: 'green' };
  if (ratio >= 1.6) return { label: 'Overwhelming', tone: 'green' };
  if (ratio >= 1.2) return { label: 'Favourable', tone: 'green' };
  if (ratio >= 0.95) return { label: 'A coin toss', tone: 'gold' };
  if (ratio >= 0.7) return { label: 'Risky', tone: 'red' };
  return { label: 'Hopeless', tone: 'red' };
}

// ---------------------------------------------------------------------------
// Military upgrades and fleets
// ---------------------------------------------------------------------------
export interface UpgradeTrack {
  id: 'missile_range' | 'missile_warhead' | 'missile_guidance' | 'troopships';
  name: string; icon: string; body: string; tech: string | null; ready: boolean;
  level: number; max: number; price: number | null; now: string; next: string | null;
}
export interface Upgrades { tracks: UpgradeTrack[]; missile_range_km: number; troop_capacity: number; troop_range_km: number }

// Places aboard a troopship: infantry 1, artillery 2, armour 3, missiles 5.
export function cargoOf(units: Record<string, number>) {
  return (units.infantry ?? 0) + 2 * (units.artillery ?? 0) + 3 * (units.armor ?? 0) + 5 * (units.missile ?? 0);
}

export interface FleetMap {
  docked: { t: string; n: string; rel: 'mine' | 'ally' | 'enemy'; qty: number }[];
  sailing: { id: number; n: string; rel: 'mine' | 'ally' | 'enemy'; from: string; to: string; kind: string; depart_at: string; arrive_at: string; qty: number; troops: number | null }[];
}

// Fleets in port and at sea, shared by everything that draws them; polled
// only while the world is on screen (not on every move in the world: that
// would be every player asking at once), and refreshed after you send one.
let fleets: FleetMap | null = null;
const fleetSubs = new Set<(f: FleetMap) => void>();
let fleetTimer: any = 0;
let fleetBusy = false;
export function refreshFleets() {
  if (fleetBusy || !fleetSubs.size) return;
  fleetBusy = true;
  rpc<FleetMap>('fleet_map')
    .then((f) => {
      fleets = f;
      fleetSubs.forEach((s) => s(f));
    })
    .catch(() => {})
    .finally(() => { fleetBusy = false; });
}
export function useFleets(active: boolean) {
  const [f, setF] = useState<FleetMap | null>(fleets);
  useEffect(() => {
    if (!active) return;
    fleetSubs.add(setF);
    if (fleetSubs.size === 1) {
      fleetTimer = setInterval(() => !document.hidden && refreshFleets(), 30000);
    }
    if (fleets) setF(fleets);
    refreshFleets();
    return () => {
      fleetSubs.delete(setF);
      if (!fleetSubs.size) clearInterval(fleetTimer);
    };
  }, [active]);
  return f;
}
