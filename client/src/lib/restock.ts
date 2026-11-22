// Working out what a business needs to keep selling, and buying it from the
// exchange. Shared by the Business window and the Empire dashboard's
// "Restock all".
import { rpc } from './supabase';
import { catalog } from './store';
import type { Business } from './types';

export interface StorageCity { city_id: string; goods: { good: string; qty: number }[] }

// Ingredient units per serving (the most any one menu item needs).
export function ingredientNeeds(b: Business): Record<string, number> {
  const cat = catalog();
  const per: Record<string, number> = {};
  for (const m of (b.settings?.menu ?? []) as { id: string }[]) {
    const mi = cat.menu_items.find((x) => x.id === m.id);
    if (!mi) continue;
    for (const [g, q] of Object.entries(mi.ingredients)) per[g] = Math.max(per[g] ?? 0, q as number);
  }
  return per;
}

export function restockPlan(b: Business, storage: StorageCity[] | null | undefined, servings: number) {
  const needs = ingredientNeeds(b);
  const menuLen = Math.max(1, (b.settings?.menu ?? []).length);
  const have = (g: string) => storage?.find((s) => s.city_id === b.city_id)?.goods.find((x) => x.good === g)?.qty ?? 0;
  return Object.keys(needs).map((g) => ({ g, qty: Math.max(0, needs[g] * servings * menuLen - have(g)) }));
}

// Buy what's missing for each business. Returns the total spent (mills).
export async function restockAll(list: Business[], servings = 300): Promise<{ spent: number; failed: string | null }> {
  const storage = await rpc<StorageCity[]>('my_storage');
  // Group by city and good so shared ingredients are bought once.
  const want = new Map<string, number>();
  for (const b of list) {
    for (const x of restockPlan(b, storage, servings)) {
      if (x.qty <= 0) continue;
      const k = `${b.city_id}|${x.g}`;
      want.set(k, (want.get(k) ?? 0) + x.qty);
    }
  }
  let spent = 0;
  for (const [k, qty] of want) {
    const [city, good] = k.split('|');
    try {
      const r = await rpc<any>('place_order', { p_good: good, p_side: 'buy', p_qty: qty, p_city: city });
      spent += r?.value ?? 0;
    } catch (e: any) {
      return { spent, failed: e?.message ?? String(e) };
    }
  }
  return { spent, failed: null };
}
