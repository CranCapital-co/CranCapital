// Settings kept on this device (and mirrored to the player's prefs on the
// server where it allows): graphics quality and sound levels.
import { create } from 'zustand';

export type Graphics = 'auto' | 'high' | 'medium' | 'saver';
export type Quality = Exclude<Graphics, 'auto'>;

export interface SoundLevels {
  muted: boolean;
  master: number; // 0..1
  effects: number;
  ambience: number;
}

interface Settings {
  graphics: Graphics;
  // What Auto has settled on right now (equals graphics unless that's 'auto').
  quality: Quality;
  sound: SoundLevels;
  reduceMotion: boolean;
  setGraphics: (g: Graphics) => void;
  setQuality: (q: Quality) => void;
  setSound: (s: Partial<SoundLevels>) => void;
}

const KEY = 'cc_settings_v1';
function load(): Partial<Settings> {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '{}');
  } catch {
    return {};
  }
}
const saved = load();
const motionQuery = typeof window !== 'undefined' ? window.matchMedia?.('(prefers-reduced-motion: reduce)') : null;

// Tablets and phones (iPads report themselves as Macs with a touch screen):
// they get fewer pixels, fewer people and no multisampling by default.
export function lowPowerDevice(): boolean {
  const ua = navigator.userAgent;
  return /iPad|iPhone|iPod|Android/.test(ua) || (/Macintosh/.test(ua) && (navigator.maxTouchPoints || 0) > 1)
    || (window.matchMedia?.('(pointer: coarse)').matches ?? false);
}

function initialQuality(): Quality {
  // A first guess for Auto: tablets, phones and small machines start on Medium.
  const cores = navigator.hardwareConcurrency || 4;
  const mem = (navigator as any).deviceMemory || 4;
  return lowPowerDevice() || cores <= 4 || mem <= 3 ? 'medium' : 'high';
}

export const useSettings = create<Settings>((set, get) => ({
  graphics: (saved.graphics as Graphics) ?? 'auto',
  quality: saved.graphics && saved.graphics !== 'auto' ? (saved.graphics as Quality) : initialQuality(),
  sound: { muted: false, master: 0.8, effects: 0.9, ambience: 0.5, ...(saved.sound ?? {}) },
  reduceMotion: !!motionQuery?.matches,
  setGraphics: (g) => {
    set({ graphics: g, quality: g === 'auto' ? get().quality : g });
    persist();
  },
  setQuality: (q) => set({ quality: q }),
  setSound: (s) => {
    set({ sound: { ...get().sound, ...s } });
    persist();
  },
}));

motionQuery?.addEventListener?.('change', (e) => useSettings.setState({ reduceMotion: e.matches }));

function persist() {
  const { graphics, sound } = useSettings.getState();
  try {
    localStorage.setItem(KEY, JSON.stringify({ graphics, sound }));
  } catch {
    /* private mode */
  }
}

// Motion is reduced if the device asks for it or the player turned it on.
export function reducedMotion(prefs?: Record<string, any> | null) {
  return useSettings.getState().reduceMotion || !!prefs?.reduce_motion;
}
