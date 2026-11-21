import { useEffect, useState } from 'react';
import { useGame, cityOf } from '../../lib/store';
import { rpc } from '../../lib/supabase';
import { money, localTime, ringFor, localHour } from '../../lib/format';
import { useSettings } from '../../lib/settings';
import { useIncome, incomePerHour } from '../../lib/income';
import { sound } from '../../audio/sound';
import { Avatar } from '../components';
import { Icon } from '../Icon';
import { RollingMoney } from './RollingNumber';
import type { Me } from '../../lib/types';

const TIER_COLORS: Record<number, string> = { 1: '#e3694d', 2: '#2f8f6e', 3: '#6c9a3d', 4: '#8a6b4a', 5: '#4b6a8c', 6: '#6b4b8c' };

// Avatar inside a ring that fills toward the next tier.
function TierRing({ me, size = 50 }: { me: Me; size?: number }) {
  const cat = useGame((s) => s.catalog);
  const prev = cat?.tiers.find((t) => t.tier === me.tier)?.net_worth ?? 0;
  const next = me.next_tier;
  const k = next ? Math.max(0, Math.min(1, (me.peak_net_worth - prev) / Math.max(1, next.net_worth - prev))) : 1;
  const r = size / 2 - 3;
  const c = 2 * Math.PI * r;
  return (
    <span className="tier-ring" style={{ width: size, height: size }}>
      <svg width={size} height={size} aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--line-2)" strokeWidth="4" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={TIER_COLORS[next?.tier ?? me.tier] ?? 'var(--gold)'}
          strokeWidth="4"
          strokeLinecap="round"
          strokeDasharray={`${c * k} ${c}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          style={{ transition: 'stroke-dasharray .6s cubic-bezier(.2,.9,.3,1.2)' }}
        />
      </svg>
      <Avatar skin={me.skin} ring={ringFor(me.net_worth)} ringStyle={me.ring_style} size={size - 14} />
      <b className="tier-num">{me.tier}</b>
    </span>
  );
}

export function HudMoney() {
  const me = useGame((s) => s.me)!;
  const open = useGame((s) => s.open);
  const [showWorth, setShowWorth] = useState(false);
  // During the fast-forward, the counter starts from before you left and rolls up.
  const [ffCash, setFfCash] = useState<number | null>(null);
  useEffect(() => {
    const on = (e: Event) => {
      const net = Number((e as CustomEvent).detail?.net) || 0;
      if (!net) return;
      setFfCash(useGame.getState().me!.cash - net);
      setTimeout(() => setFfCash(null), 300);
    };
    window.addEventListener('cc:fastforward', on);
    return () => window.removeEventListener('cc:fastforward', on);
  }, []);
  useIncome((s) => s.sales.length); // re-render on new sales
  const [, tick] = useState(0);
  useEffect(() => {
    const load = () =>
      rpc<{ per_hour: number }>('my_income')
        .then((r) => useIncome.getState().setServer(Number(r.per_hour)))
        .catch(() => {});
    load();
    const i = setInterval(() => {
      tick((x) => x + 1);
      load();
    }, 60_000);
    // Catch up soon after a sale lands.
    let t: any = 0;
    const onSale = () => {
      clearTimeout(t);
      t = setTimeout(load, 4000);
    };
    window.addEventListener('cc:sales', onSale);
    return () => {
      clearInterval(i);
      clearTimeout(t);
      window.removeEventListener('cc:sales', onSale);
    };
  }, []);
  const rate = incomePerHour();
  const next = me.next_tier;
  return (
    <div className="hud-pill hud-money">
      <button onClick={() => open('account')} aria-label={`Your account. Tier ${me.tier}${next ? `, next tier ${next.name} at ${money(next.net_worth, { compact: true })}` : ''}`}>
        <TierRing me={me} />
      </button>
      <button className="hud-money-text" onClick={() => setShowWorth(!showWorth)} aria-label="Show net worth or income">
        <RollingMoney value={ffCash ?? me.cash} className="hud-cash" />
        <span className="hud-sub tnum">
          {showWorth ? (
            <>Net worth {money(me.net_worth, { compact: true })}{next ? ` · next tier at ${money(next.net_worth, { compact: true })}` : ''}</>
          ) : rate != null && rate > 0 ? (
            <span className="up">
              <Icon name="trendUp" size={13} /> +{money(rate, { cents: false })} an hour
            </span>
          ) : (
            <>Net worth {money(me.net_worth, { compact: true })}</>
          )}
        </span>
      </button>
    </div>
  );
}

function weatherIcon(code: number | null | undefined, night: boolean) {
  if (code == null) return night ? 'moon' : 'sun';
  if (code === 0) return night ? 'moon' : 'sun';
  if (code <= 2) return 'partly';
  if (code === 3) return 'cloud';
  if (code === 45 || code === 48) return 'fog';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
  if (code >= 95) return 'storm';
  return 'rain';
}

export interface CityWeather {
  city_id: string;
  temp_c: number | null;
  code: number | null;
  wind_kmh: number | null;
  is_day: boolean | null;
  rain_mm: number | null;
  snow_cm: number | null;
  cloud_pct: number | null;
  updated_at: string;
}

// Each city's weather, saved by the server every 30 minutes.
let weatherCache: { at: number; rows: CityWeather[] } | null = null;
export function useWeather(cityId: string | null | undefined) {
  const [w, setW] = useState<CityWeather | null>(() => weatherCache?.rows.find((r) => r.city_id === cityId) ?? null);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      if (!weatherCache || Date.now() - weatherCache.at > 10 * 60_000) {
        try {
          weatherCache = { at: Date.now(), rows: await rpc<CityWeather[]>('city_weather') };
        } catch {
          weatherCache = { at: Date.now(), rows: weatherCache?.rows ?? [] };
        }
      }
      if (alive) {
        const row = weatherCache.rows.find((r) => r.city_id === cityId) ?? null;
        setW(row);
        window.dispatchEvent(new CustomEvent('cc:weather', { detail: row }));
      }
    };
    load();
    const i = setInterval(load, 10 * 60_000);
    return () => {
      alive = false;
      clearInterval(i);
    };
  }, [cityId]);
  return w;
}

export interface WorldEvent { id: number; city_id: string | null; kind: string; title: string; body: string; active: boolean; ends_at: string }
export function useCityEvent(cityId: string | null | undefined) {
  const [ev, setEv] = useState<WorldEvent | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      rpc<WorldEvent[]>('world_events')
        .then((all) => {
          if (!alive) return;
          const e = all.find((x) => x.active && (x.city_id === cityId || !x.city_id)) ?? null;
          setEv(e);
          window.dispatchEvent(new CustomEvent('cc:event', { detail: e }));
        })
        .catch(() => {});
    load();
    const i = setInterval(load, 5 * 60_000);
    return () => {
      alive = false;
      clearInterval(i);
    };
  }, [cityId]);
  return ev;
}

export function CityStrip({ cityId }: { cityId: string }) {
  const info = cityOf(cityId);
  const open = useGame((s) => s.open);
  const w = useWeather(cityId);
  const ev = useCityEvent(cityId);
  const [t, setT] = useState(() => (info ? localTime(info.tz) : ''));
  useEffect(() => {
    if (!info) return;
    const i = setInterval(() => setT(localTime(info.tz)), 20_000);
    return () => clearInterval(i);
  }, [info]);
  if (!info) return null;
  const hour = localHour(info.tz);
  const night = w?.is_day === false || hour < 6 || hour >= 20;
  return (
    <div className="hud-strip">
      <button className="hud-pill hud-city-pill" onClick={() => open('travel')} aria-label={`${info.name}, ${t} local time. Travel`}>
        <Icon name="skyline" size={22} accent="var(--brand-2)" />
        <span className="hud-city">{info.name}</span>
        <span className="hud-sep" />
        <span className="hud-sub tnum">{t}</span>
        {w && w.temp_c != null && (
          <>
            <span className="hud-sep" />
            <Icon name={weatherIcon(w.code, night)} size={20} accent={night ? '#9aa7ff' : 'var(--gold)'} />
            <span className="hud-sub tnum">{Math.round(w.temp_c)}°</span>
          </>
        )}
      </button>
      {ev && (
        <button className="hud-pill event-chip" onClick={() => useGame.getState().toast(`${ev.title}: ${ev.body}`, 'info')} title={ev.body}>
          <Icon name="event" size={18} accent="var(--coral)" />
          <span className="ellipsis">{ev.title}</span>
        </button>
      )}
    </div>
  );
}

export function HudRight({ onEmpireView }: { onEmpireView: () => void }) {
  const me = useGame((s) => s.me)!;
  const open = useGame((s) => s.open);
  const sounds = useSettings((s) => s.sound);
  const setSound = useSettings((s) => s.setSound);
  return (
    <div className="hud-right">
      <button className="round-btn" onClick={onEmpireView} aria-label="Empire view: see everything you own" title="Empire view">
        <Icon name="view" size={24} />
      </button>
      <button
        className="round-btn"
        onClick={() => {
          sound.unlock();
          setSound({ muted: !sounds.muted });
        }}
        aria-label={sounds.muted ? 'Sound off. Turn sound on' : 'Sound on. Turn sound off'}
        aria-pressed={!sounds.muted}
      >
        <Icon name={sounds.muted ? 'mute' : 'sound'} size={24} />
      </button>
      <button className="round-btn bell" onClick={() => open('notifications')} aria-label={`Notifications${me.unread ? `, ${me.unread} unread` : ''}`}>
        <Icon name="bell" size={24} />
        {me.unread > 0 && <span className="dot">{me.unread > 99 ? '99+' : me.unread}</span>}
      </button>
    </div>
  );
}

export { localHour };
