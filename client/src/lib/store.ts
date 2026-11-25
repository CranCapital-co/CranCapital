import { create } from 'zustand';
import type { Session } from '@supabase/supabase-js';
import type { Catalog, Me } from './types';
import { sound } from '../audio/sound';

export type WindowId =
  | 'businesses' | 'business' | 'property' | 'build' | 'market' | 'bank' | 'inventory' | 'community'
  | 'leaderboard' | 'wiki' | 'account' | 'profile' | 'travel' | 'notifications' | 'mod'
  | 'empire' | 'people' | 'more' | 'progress';

// Windows that now live as tabs inside the five dock windows.
const TAB_HOME: Partial<Record<WindowId, [WindowId, string]>> = {
  businesses: ['empire', 'businesses'],
  inventory: ['empire', 'storage'],
  bank: ['empire', 'bank'],
  community: ['people', 'chat'],
  leaderboard: ['people', 'leaders'],
};

export type Mode =
  | { kind: 'walk' }
  | { kind: 'place-cart' }
  | { kind: 'move-cart'; businessId: number }
  | { kind: 'survey' }
  | { kind: 'land' };

export interface Toast { id: number; kind: 'error' | 'success' | 'info'; text: string }
export interface OpenWindow { id: WindowId; params?: any }

export interface Selection {
  building?: number | null;
  plot?: { city: string; px: number; py: number } | null;
}

interface State {
  session: Session | null;
  me: Me | null;
  needsProfile: boolean;
  catalog: Catalog | null;
  win: OpenWindow | null;
  // Windows opened on top of each other (business -> a good on the market):
  // Back returns to the one underneath.
  stack: OpenWindow[];
  // How much of the map the open sheet covers (px), so the camera can keep
  // what you're looking at in view.
  inset: { right: number; bottom: number };
  mode: Mode;
  selection: Selection;
  toasts: Toast[];
  away: any | null;
  pos: { lat: number; lng: number } | null;
  walkingTo: { lat: number; lng: number } | null;
  inside: number | null;
  refreshKey: number; // bump to make open windows reload
  set: (p: Partial<State>) => void;
  open: (id: WindowId, params?: any) => void;
  back: () => void;
  close: () => void;
  toast: (text: string, kind?: Toast['kind']) => void;
  dismissToast: (id: number) => void;
  bump: () => void;
}

let toastId = 0;

export const useGame = create<State>((set, get) => ({
  session: null,
  me: null,
  needsProfile: false,
  catalog: null,
  win: null,
  stack: [],
  inset: { right: 0, bottom: 0 },
  mode: { kind: 'walk' },
  selection: {},
  toasts: [],
  away: null,
  pos: null,
  walkingTo: null,
  inside: null,
  refreshKey: 0,
  set: (p) => set(p),
  open: (id, params) => {
    const home = TAB_HOME[id];
    const w: OpenWindow = home ? { id: home[0], params: { tab: home[1], inner: params } } : { id, params };
    const stack = get().stack;
    const top = stack[stack.length - 1];
    if (!top) sound.play('open');
    // Re-opening the same kind of window replaces it; anything else stacks.
    const next = top && top.id === w.id ? [...stack.slice(0, -1), w] : [...stack, w].slice(-8);
    set({ win: w, stack: next });
  },
  back: () => {
    const stack = get().stack.slice(0, -1);
    if (!stack.length) return get().close();
    set({ win: stack[stack.length - 1], stack });
  },
  close: () => {
    if (get().win) sound.play('close');
    set({ win: null, stack: [], selection: {}, inset: { right: 0, bottom: 0 } });
  },
  toast: (text, kind = 'info') => {
    const id = ++toastId;
    if (kind === 'error') sound.play('error');
    set({ toasts: [...get().toasts, { id, kind, text }].slice(-4) });
    setTimeout(() => get().dismissToast(id), kind === 'error' ? 6500 : 4000);
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
  bump: () => set({ refreshKey: get().refreshKey + 1 }),
}));

// Run a game action with error toasts; returns undefined on failure.
export async function act<T>(fn: () => Promise<T>, success?: string | ((r: T) => string | undefined)): Promise<T | undefined> {
  const g = useGame.getState();
  try {
    const r = await fn();
    const msg = typeof success === 'function' ? success(r) : success;
    if (msg) g.toast(msg, 'success');
    return r;
  } catch (e: any) {
    g.toast(e?.message || String(e), 'error');
    return undefined;
  }
}

export const catalog = () => useGame.getState().catalog as Catalog;
export const goodName = (id: string) => catalog()?.goods.find((g) => g.id === id)?.name ?? id;
export const goodIcon = (id: string) => catalog()?.goods.find((g) => g.id === id)?.icon ?? '📦';
export const btype = (id: string) => catalog()?.business_types.find((t) => t.id === id);
export const cityName = (id: string | null | undefined) => catalog()?.cities.find((c) => c.id === id)?.name ?? id ?? '';
export const cityOf = (id: string | null | undefined) => catalog()?.cities.find((c) => c.id === id);
