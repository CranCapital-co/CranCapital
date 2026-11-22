import { rpc } from '../lib/supabase';
import { useGame } from '../lib/store';
import type { Me } from '../lib/types';

// Reload my player (cash, net worth, tier) and tell open windows to refresh.
export async function refreshMe() {
  try {
    const me = await rpc<Me>('get_me');
    useGame.setState({ me });
  } catch {
    /* ignore */
  }
  useGame.getState().bump();
}

export const FLAG_TEXT: Record<string, string> = {
  out_of_stock: 'Running out of ingredients',
  rent_due: 'Rent is overdue',
  staff_quit: 'Staff quit (unpaid wages)',
  no_fuel: 'Out of diesel',
  no_inputs: 'Missing inputs',
  storage_full: 'Storage is full',
  missing: 'Fit-out incomplete',
  evicted: 'Evicted for unpaid rent',
  paused: 'Paused while you were away',
  unpaid_upkeep: 'Closed: running costs unpaid',
  unpaid_wages: 'Closed: wages unpaid',
};

export function flagList(flags: Record<string, any> | undefined) {
  if (!flags) return [] as string[];
  return Object.keys(flags).filter((k) => flags[k] && FLAG_TEXT[k]).map((k) => FLAG_TEXT[k]);
}

// Customer demand multiplier for a price relative to the fair price (mirrors the server).
export function demandAt(price: number, fair: number) {
  const r = price / fair;
  return r <= 1 ? Math.min(1.4, 1 + 0.5 * (1 - r)) : Math.exp(-2.2 * (r - 1));
}

// Foot traffic in words: what the number means for a cart.
export function trafficLabel(v: number): { label: 'Quiet' | 'Busy' | 'Packed'; stars: number } {
  if (v >= 1.8) return { label: 'Packed', stars: 3 };
  if (v >= 1.0) return { label: 'Busy', stars: 2 };
  return { label: 'Quiet', stars: 1 };
}
