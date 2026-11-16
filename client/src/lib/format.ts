// Money is stored in thousandths of a dollar ("mills"): $1 = 1000.

export function money(mills: number | null | undefined, opts: { cents?: boolean; sign?: boolean; compact?: boolean } = {}): string {
  if (mills === null || mills === undefined || Number.isNaN(Number(mills))) return '—';
  const v = Number(mills) / 1000;
  const sign = v < 0 ? '−' : opts.sign && v > 0 ? '+' : '';
  const a = Math.abs(v);
  if (opts.compact && a >= 1e6) {
    const units: [number, string][] = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M']];
    for (const [d, s] of units) if (a >= d) return `${sign}$${(a / d).toFixed(a / d >= 100 ? 0 : a / d >= 10 ? 1 : 2)}${s}`;
  }
  if (opts.compact && a >= 10000) {
    if (a >= 999_500) return `${sign}$${(a / 1e6).toFixed(2)}M`;
    return `${sign}$${(a / 1000).toFixed(a >= 100000 ? 0 : 1)}k`;
  }
  const showCents = opts.cents ?? a < 10000;
  // Show tenths of a cent only when they matter (e.g. $0.088).
  const digits = a > 0 && a < 1 && Math.round(a * 1000) % 10 !== 0 ? 3 : showCents ? 2 : 0;
  return `${sign}$${a.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

// Unit price of goods (can be fractions of a cent).
export function unitPrice(mills: number | null | undefined): string {
  if (mills === null || mills === undefined) return '—';
  const v = Number(mills) / 1000;
  if (v < 1) return `$${v.toFixed(3)}`;
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export const toMills = (dollars: number) => Math.round(dollars * 1000);

export function num(n: number | null | undefined, digits = 0): string {
  if (n === null || n === undefined) return '—';
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

export function compactNum(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (a >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (a >= 1e4) return (n / 1e3).toFixed(1) + 'k';
  return num(n);
}

export function pct(n: number | null | undefined, digits = 1, sign = true): string {
  if (n === null || n === undefined) return '—';
  return `${sign && n > 0 ? '+' : ''}${Number(n).toFixed(digits)}%`;
}

export function ago(ts: string | number | Date | null | undefined): string {
  if (!ts) return '';
  const s = (Date.now() - new Date(ts).getTime()) / 1000;
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export function until(ts: string | number | Date | null | undefined): string {
  if (!ts) return '';
  const s = Math.max(0, (new Date(ts).getTime() - Date.now()) / 1000);
  if (s < 60) return `${Math.ceil(s)} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
  return `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
}

export function date(ts: string | Date | null | undefined): string {
  if (!ts) return '';
  return new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function localTime(tz: string, d = new Date()): string {
  try {
    return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz });
  } catch {
    return '';
  }
}

export function localHour(tz: string, d = new Date()): number {
  try {
    return Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone: tz }).format(d));
  } catch {
    return d.getHours();
  }
}

export function hourLabel(h: number): string {
  if (h === 24 || h === 0) return 'midnight';
  if (h === 12) return 'noon';
  return h < 12 ? `${h} am` : `${h - 12} pm`;
}

export function ringFor(netWorthMills: number): 'none' | 'bronze' | 'silver' | 'gold' | 'diamond' {
  if (netWorthMills >= 50_000_000_000) return 'diamond';
  if (netWorthMills >= 5_000_000_000) return 'gold';
  if (netWorthMills >= 500_000_000) return 'silver';
  if (netWorthMills >= 50_000_000) return 'bronze';
  return 'none';
}

export const RING_COLORS: Record<string, string> = {
  none: 'rgba(255,255,255,0.85)',
  bronze: '#c07a3e',
  silver: '#b9c3cc',
  gold: '#f2c14b',
  diamond: '#7fe3f2',
};

export function plural(n: number, one: string, many = one + 's') {
  return `${num(n)} ${n === 1 ? one : many}`;
}
