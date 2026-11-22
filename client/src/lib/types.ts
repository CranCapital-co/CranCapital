// Shapes of what the game API returns (kept loose where the UI doesn't care).

export interface City {
  id: string;
  name: string;
  country: string;
  tz: string;
  climate: string;
  bbox: [number, number, number, number];
  start: { lng: number; lat: number; label: string };
  hub: { lng: number; lat: number; label: string };
  price_factor: number;
  wage_per_hour: number;
  open: boolean;
}
export interface Good { id: string; name: string; category: string; base_price: number; depth: number; warm_only: boolean; icon: string; sort: number; description: string }
export interface MenuItem { id: string; name: string; category: string; fair_price: number; ingredients: Record<string, number>; icon: string }
export interface BusinessType {
  id: string; name: string; tier: number; placement: 'street' | 'room' | 'plot' | 'coastal' | 'deposit';
  menu_category: string | null; cost: number; upkeep_per_hour: number; staff_fixed: number; per_staff: number;
  base_cph: number; max_level: number; produces: string | null; resource: string | null; recipe: string | null;
  rate_per_hour: number; storage_capacity: number; icon: string; description: string;
}
export interface FitoutItem { id: string; name: string; cost: number; cap: Record<string, number>; decor: number; required_for: string[]; icon: string }
export interface Recipe { id: string; name: string; inputs: Record<string, number>; outputs: Record<string, number>; cycles_per_hour: number; diesel_per_hour: number }
export interface Tier { tier: number; name: string; idea: string; net_worth: number }
export interface Badge { id: string; name: string; description: string; icon: string }
export interface Catalog {
  cities: City[];
  goods: Good[];
  menu_items: MenuItem[];
  business_types: BusinessType[];
  fitout_items: FitoutItem[];
  recipes: Recipe[];
  crops: Record<string, number>;
  tiers: Tier[];
  badges: Badge[];
  deposit_types: { resource: string; business_type: string }[];
  config: Record<string, number>;
}

export interface RenownBrief {
  level: number;
  xp: number;
  rank: string;
  into: number;
  need: number;
  perk_points: number;
  crates: number;
  daily: boolean;
  boost_until: string | null;
}

export interface Me {
  id: string;
  player_no: number;
  display_name: string;
  title: string | null;
  skin: string;
  ring_style: string;
  cash: number;
  net_worth: number;
  peak_net_worth: number;
  tier: number;
  city_id: string | null;
  lat: number | null;
  lng: number | null;
  travel_from: string | null;
  travel_to: string | null;
  travel_arrive_at: string | null;
  created_at: string;
  days_played: number;
  loyalty_points: number;
  referral_code: string;
  role: 'player' | 'mod' | 'admin';
  status: string;
  status_until: string | null;
  status_reason: string | null;
  tutorial_done: boolean;
  prefs: Record<string, any>;
  unread: number;
  renown?: RenownBrief | null;
  nation?: string | null;
  next_tier: { tier: number; name: string; net_worth: number } | null;
}

export interface Business {
  id: number;
  kind: string;
  name: string;
  city_id: string;
  lat: number;
  lng: number;
  level: number;
  status: string;
  open_hour: number;
  close_hour: number;
  staff: number;
  max_staff: number;
  capacity: number;
  attract: number;
  traffic: number;
  settings: any;
  fitout: (string | null)[];
  flags: Record<string, any>;
  building_id: number | null;
  plot_x: number | null;
  plot_y: number | null;
  book_value: number;
  sales_today: number;
  revenue_today: number;
  costs_today: number;
  produced_today: number;
  lifetime_revenue: number;
  type_name: string;
  icon: string;
  menu_category: string | null;
  owner_name: string;
  owner_no: number;
  lease?: { rent_per_day: number; unpaid: number; building_name: string; landlord: string | null } | null;
  upgrade_cost?: number | null;
  menu_slots?: number;
  deposit?: { resource: string; units_left: number; units_total: number } | null;
  history?: { day: string; sales: number; revenue: number; costs: number; produced: number }[];
  local_hour?: number;
  wage_per_hour?: number;
  menu?: { id: string; price: number }[];
}

export interface PublicPlayer { player_no: number; name: string; title: string | null; skin: string; ring: string; ring_style: string }
