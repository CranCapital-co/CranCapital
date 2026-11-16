// Live updates over Supabase Realtime:
// * world:<city>  public presence: who is walking where (game positions only)
// * user:<uuid>   private: notifications, sales, order fills, DMs (server-sent)
// * chat:<id>     private: chat messages (only the server can post)
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from './supabase';

export interface Presence {
  no: number;
  n: string;
  s: string;
  r: string;
  rs: string;
  t?: string | null;
  lat: number;
  lng: number;
  in: boolean;
  at: number;
}

let world: RealtimeChannel | null = null;
let worldCity: string | null = null;
let user: RealtimeChannel | null = null;
let lastTrack = 0;
let pendingTrack: Presence | null = null;
let trackTimer: any = 0;

export type PresenceMap = Map<number, Presence>;
const listeners = new Set<(p: PresenceMap) => void>();
let others: PresenceMap = new Map();

export function onPresence(fn: (p: PresenceMap) => void) {
  listeners.add(fn);
  fn(others);
  return () => listeners.delete(fn);
}

async function auth() {
  const { data } = await supabase.auth.getSession();
  if (data.session) supabase.realtime.setAuth(data.session.access_token);
}

export async function joinWorld(cityId: string, myNo: number, initial: Presence) {
  if (worldCity === cityId && world) {
    track(initial);
    return;
  }
  leaveWorld();
  await auth();
  worldCity = cityId;
  others = new Map();
  world = supabase.channel(`world:${cityId}`, { config: { presence: { key: String(myNo) } } });
  world.on('presence', { event: 'sync' }, () => {
    const state = world!.presenceState<Presence>();
    const next: PresenceMap = new Map();
    for (const [key, metas] of Object.entries(state)) {
      if (Number(key) === myNo) continue;
      const m = metas[metas.length - 1] as unknown as Presence;
      if (m && typeof m.lat === 'number') next.set(Number(key), m);
    }
    others = next;
    listeners.forEach((l) => l(others));
  });
  world.subscribe((status) => {
    if (status === 'SUBSCRIBED') track(initial, true);
  });
}

export function leaveWorld() {
  if (world) supabase.removeChannel(world);
  world = null;
  worldCity = null;
  others = new Map();
  listeners.forEach((l) => l(others));
}

let lastPresence: Presence | null = null;

// Re-announce my position (the heartbeat calls this so idle players stay visible).
export function retrack() {
  if (lastPresence) track({ ...lastPresence, at: Date.now() }, true);
}

// Share my position, at most once a second.
export function track(p: Presence, force = false) {
  lastPresence = p;
  pendingTrack = p;
  const now = Date.now();
  if (force || now - lastTrack > 1000) {
    lastTrack = now;
    world?.track({ ...p, at: now }).catch(() => {});
    pendingTrack = null;
  } else if (!trackTimer) {
    trackTimer = setTimeout(() => {
      trackTimer = 0;
      if (pendingTrack) track(pendingTrack, true);
    }, 1000);
  }
}

export async function subscribeUser(uid: string, onEvent: (event: string, payload: any) => void) {
  if (user) supabase.removeChannel(user);
  await auth();
  user = supabase.channel(`user:${uid}`, { config: { private: true } });
  for (const ev of ['notification', 'sales', 'order', 'dm']) {
    user.on('broadcast', { event: ev }, (msg) => onEvent(ev, msg.payload));
  }
  user.subscribe();
}

export function unsubscribeUser() {
  if (user) supabase.removeChannel(user);
  user = null;
}

export async function subscribeChat(channelId: number, onMessage: (m: any) => void): Promise<() => void> {
  await auth();
  const ch = supabase.channel(`chat:${channelId}`, { config: { private: true } });
  ch.on('broadcast', { event: 'message' }, (msg) => onMessage(msg.payload));
  ch.subscribe();
  return () => {
    supabase.removeChannel(ch);
  };
}

// Keep the realtime token fresh when the session refreshes.
supabase.auth.onAuthStateChange((_e, session) => {
  if (session) supabase.realtime.setAuth(session.access_token);
});
