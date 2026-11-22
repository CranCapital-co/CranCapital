// Income rate for the HUD ("+$1,240 an hour"): sales seen in the last hour.
// Sales events arrive live from the server; they're kept on this device so a
// reload doesn't reset the rate. The server's own hourly figure (my_income)
// fills in when there's no live history yet.
import { create } from 'zustand';

interface Sale { t: number; r: number }
const KEY = 'cc_sales_hist';
const HOUR = 3600_000;

function load(): Sale[] {
  try {
    const x = JSON.parse(localStorage.getItem(KEY) || '[]') as Sale[];
    return x.filter((s) => Date.now() - s.t < HOUR);
  } catch {
    return [];
  }
}

interface Income {
  sales: Sale[];
  since: number; // when we started watching (ms)
  server: number | null; // mills per hour, from the server
  add: (revenue: number) => void;
  setServer: (v: number | null) => void;
}

export const useIncome = create<Income>((set, get) => ({
  sales: load(),
  since: (() => {
    const s = load();
    return s.length ? Math.min(Date.now(), s[0].t) : Date.now();
  })(),
  server: null,
  add: (r) => {
    const now = Date.now();
    const sales = [...get().sales.filter((s) => now - s.t < HOUR), { t: now, r }];
    set({ sales });
    try {
      localStorage.setItem(KEY, JSON.stringify(sales.slice(-400)));
    } catch {
      /* fine */
    }
  },
  setServer: (v) => set({ server: v }),
}));

// Mills per hour, or null if we can't tell yet. The server's figure (all
// sales in the last hour, including ones made while away) wins when known.
export function incomePerHour(s: Income = useIncome.getState()): number | null {
  if (s.server != null) return s.server;
  const now = Date.now();
  const recent = s.sales.filter((x) => now - x.t < HOUR);
  const watched = Math.min(HOUR, now - s.since);
  if (watched >= 10 * 60_000 || recent.length >= 6) {
    const sum = recent.reduce((a, b) => a + b.r, 0);
    return Math.round((sum * HOUR) / Math.max(watched, 5 * 60_000));
  }
  return s.server;
}
