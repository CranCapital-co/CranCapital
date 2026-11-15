import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import GameMap, { type MapApi } from '../map/GameMap';
import { useGame, act, cityOf, cityName } from '../lib/store';
import { rpc } from '../lib/supabase';
import { loadCity, trafficAt, distM, type CityData } from '../lib/citydata';
import { joinWorld } from '../lib/realtime';
import { money, localTime, ringFor, until } from '../lib/format';
import { Avatar, Modal, Progress } from '../ui/components';
import AwayCard from '../ui/AwayCard';
import type { Me } from '../lib/types';

const BusinessWindow = lazy(() => import('../ui/panels/BusinessWindow'));
const BusinessesWindow = lazy(() => import('../ui/panels/BusinessesWindow'));
const PropertyWindow = lazy(() => import('../ui/panels/PropertyWindow'));
const BuildWindow = lazy(() => import('../ui/panels/BuildWindow'));
const MarketWindow = lazy(() => import('../ui/panels/MarketWindow'));
const BankWindow = lazy(() => import('../ui/panels/BankWindow'));
const InventoryWindow = lazy(() => import('../ui/panels/InventoryWindow'));
const CommunityWindow = lazy(() => import('../ui/panels/CommunityWindow'));
const LeaderboardWindow = lazy(() => import('../ui/panels/LeaderboardWindow'));
const WikiWindow = lazy(() => import('../ui/panels/WikiWindow'));
const AccountWindow = lazy(() => import('../ui/panels/AccountWindow'));
const ProfileWindow = lazy(() => import('../ui/panels/ProfileWindow'));
const TravelWindow = lazy(() => import('../ui/panels/TravelWindow'));
const NotificationsWindow = lazy(() => import('../ui/panels/NotificationsWindow'));
const ModWindow = lazy(() => import('../ui/panels/ModWindow'));

const WINDOWS: Record<string, React.ComponentType<any>> = {
  business: BusinessWindow,
  businesses: BusinessesWindow,
  property: PropertyWindow,
  build: BuildWindow,
  market: MarketWindow,
  bank: BankWindow,
  inventory: InventoryWindow,
  community: CommunityWindow,
  leaderboard: LeaderboardWindow,
  wiki: WikiWindow,
  account: AccountWindow,
  profile: ProfileWindow,
  travel: TravelWindow,
  notifications: NotificationsWindow,
  mod: ModWindow,
};

type Pending = { kind: 'buy-cart' | 'move-cart'; lat: number; lng: number; businessId?: number } | null;

function Clock({ tz }: { tz: string }) {
  const [t, setT] = useState(localTime(tz));
  useEffect(() => {
    const i = setInterval(() => setT(localTime(tz)), 20_000);
    return () => clearInterval(i);
  }, [tz]);
  return <>{t}</>;
}

function TravelBanner({ me }: { me: Me }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const i = setInterval(async () => {
      tick((x) => x + 1);
      if (me.travel_arrive_at && new Date(me.travel_arrive_at).getTime() < Date.now()) {
        const fresh = await rpc<Me>('get_me').catch(() => null);
        if (fresh && !fresh.travel_to) useGame.setState({ me: fresh, pos: fresh.lat ? { lat: fresh.lat, lng: fresh.lng! } : null });
      }
    }, 1000);
    return () => clearInterval(i);
  }, [me.travel_arrive_at]);
  return (
    <div className="mode-banner travel-banner" role="status">
      ✈️ Flying to {cityName(me.travel_to)} · lands in {until(me.travel_arrive_at)}
    </div>
  );
}

export default function World() {
  const me = useGame((s) => s.me)!;
  const win = useGame((s) => s.win);
  const mode = useGame((s) => s.mode);
  const away = useGame((s) => s.away);
  const { open, set, toast, bump } = useGame.getState();
  const [city, setCity] = useState<CityData | null>(null);
  const [heat, setHeat] = useState(false);
  const [pending, setPending] = useState<Pending>(null);
  const [cartPrompt, setCartPrompt] = useState<{ lat: number; lng: number } | null>(null);
  const [cartName, setCartName] = useState('');
  const [taxi, setTaxi] = useState<{ lat: number; lng: number; cost: number } | null>(null);
  const api = useRef<MapApi | null>(null);
  const cityId = me.city_id ?? me.travel_from ?? 'london';
  const cityInfo = cityOf(cityId);

  useEffect(() => {
    let alive = true;
    loadCity(cityId).then((d) => alive && setCity(d)).catch((e) => toast('Couldn’t load the city: ' + e.message, 'error'));
    return () => {
      alive = false;
    };
  }, [cityId, toast]);

  useEffect(() => {
    if (!city || !me || me.travel_to) return;
    const pos = useGame.getState().pos ?? { lat: me.lat ?? city.meta.start.lat, lng: me.lng ?? city.meta.start.lng };
    joinWorld(cityId, me.player_no, { no: me.player_no, n: me.display_name, s: me.skin, r: ringFor(me.net_worth), rs: me.ring_style, t: me.title, lat: pos.lat, lng: pos.lng, in: false, at: Date.now() });
  }, [city, cityId, me?.player_no, me?.skin, me?.display_name, me?.travel_to]);

  // Refresh money and open windows every 30 s so offline sales show up.
  useEffect(() => {
    const i = setInterval(() => bump(), 30_000);
    return () => clearInterval(i);
  }, [bump]);

  const onArrive = async (lat: number, lng: number) => {
    if (!pending) return;
    if (distM(lat, lng, pending.lat, pending.lng) > 20) return;
    if (pending.kind === 'buy-cart') {
      setCartPrompt({ lat: pending.lat, lng: pending.lng });
      setCartName(`${me.display_name}'s Cart`.slice(0, 40));
    } else if (pending.kind === 'move-cart' && pending.businessId) {
      const r = await act(() => rpc('move_cart', { p_id: pending.businessId, p_lat: pending.lat, p_lng: pending.lng }), 'Cart moved.');
      if (r) {
        set({ mode: { kind: 'walk' } });
        bump();
      }
    }
    setPending(null);
  };

  const onPlace = (lat: number, lng: number) => {
    const m = useGame.getState().mode;
    setPending({ kind: m.kind === 'move-cart' ? 'move-cart' : 'buy-cart', lat, lng, businessId: m.kind === 'move-cart' ? m.businessId : undefined });
    useGame.setState({ walkingTo: { lat, lng } });
  };

  const onTaxi = (lat: number, lng: number) => {
    const pos = useGame.getState().pos;
    const km = pos ? distM(pos.lat, pos.lng, lat, lng) / 1000 : 1;
    setTaxi({ lat, lng, cost: Math.round(3000 + km * 2000) });
  };

  const Win = win ? WINDOWS[win.id] : null;
  const nextTier = me.next_tier;
  const prevNw = useGame.getState().catalog?.tiers.find((t) => t.tier === me.tier)?.net_worth ?? 0;

  return (
    <div className="game">
      {city && (
        <GameMap
          key={city.meta.id}
          city={city}
          onReady={(a) => (api.current = a)}
          onArrive={onArrive}
          onPlace={onPlace}
          onTaxi={onTaxi}
        />
      )}

      <div className="hud">
        <div className="hud-pill">
          <button onClick={() => open('account')} aria-label="Your account">
            <Avatar skin={me.skin} ring={ringFor(me.net_worth)} ringStyle={me.ring_style} size={36} />
          </button>
          <div>
            <div className="hud-cash" title="Cash">{money(me.cash, { cents: false })}</div>
            <div className="hud-sub">Net worth {money(me.net_worth, { compact: true })} · Tier {me.tier}</div>
          </div>
          {nextTier && (
            <div className="tierbar hide-sm" title={`Tier ${nextTier.tier} (${nextTier.name}) at ${money(nextTier.net_worth, { compact: true })}`}>
              <Progress value={Math.max(0, me.peak_net_worth - prevNw)} max={nextTier.net_worth - prevNw} color="var(--gold)" />
              <div className="hud-sub">Next: {nextTier.name}</div>
            </div>
          )}
        </div>
        <div className="grow" />
        <button className="hud-pill" onClick={() => open('travel')} style={{ cursor: 'pointer' }}>
          <span style={{ fontSize: 20, paddingLeft: 6 }}>{cityInfo?.climate === 'warm' ? '🌴' : '🏙️'}</span>
          <div style={{ textAlign: 'left' }}>
            <div className="hud-city">{cityInfo?.name}</div>
            <div className="hud-sub">{cityInfo && <Clock tz={cityInfo.tz} />} local</div>
          </div>
        </button>
        <button className="bell" onClick={() => open('notifications')} aria-label={`Notifications${me.unread ? `, ${me.unread} unread` : ''}`}>
          🔔{me.unread > 0 && <span className="dot">{me.unread > 99 ? '99+' : me.unread}</span>}
        </button>
      </div>

      {me.travel_to && <TravelBanner me={me} />}
      {me.status === 'suspended' && (
        <div className="mode-banner" style={{ top: 'calc(env(safe-area-inset-top) + 110px)', background: 'var(--bad)' }}>
          Suspended until {new Date(me.status_until!).toLocaleString()}: {me.status_reason}
        </div>
      )}

      {mode.kind !== 'walk' && (
        <div className="mode-banner" role="status">
          {mode.kind === 'place-cart' && 'Tap a street to park your new cart. Green means you can park there.'}
          {mode.kind === 'move-cart' && 'Tap a street to move your cart there.'}
          {mode.kind === 'taxi' && 'Tap anywhere in the city to take a taxi there.'}
          {mode.kind === 'land' && 'Land mode: tap a green plot to see it. Gold plots are yours.'}
          <button className="btn small" onClick={() => { set({ mode: { kind: 'walk' } }); setPending(null); }}>Done</button>
        </div>
      )}

      <div className="fabs">
        <button className="fab" title="Find me" aria-label="Find me" onClick={() => { const p = useGame.getState().pos; if (p) api.current?.flyTo(p.lat, p.lng); }}>📍</button>
        <button className={`fab ${mode.kind === 'land' ? 'on' : ''}`} title="Land and plots" aria-label="Land mode" onClick={() => set({ mode: mode.kind === 'land' ? { kind: 'walk' } : { kind: 'land' } })}>🗺️</button>
        <button className={`fab ${heat ? 'on' : ''}`} title="Foot traffic heat map" aria-label="Foot traffic heat map" onClick={() => { setHeat(!heat); api.current?.setHeatmap(!heat); }}>🔥</button>
        <button className={`fab ${mode.kind === 'taxi' ? 'on' : ''}`} title="Taxi" aria-label="Taxi" onClick={() => set({ mode: mode.kind === 'taxi' ? { kind: 'walk' } : { kind: 'taxi' } })}>🚕</button>
      </div>

      <nav className="dock" aria-label="Game menu">
        <button className="primary" onClick={() => open('build')}><span>➕</span><span>Build</span></button>
        <button className={win?.id === 'businesses' ? 'on' : ''} onClick={() => open('businesses')}><span>🏪</span><span>Business</span></button>
        <button className={win?.id === 'market' ? 'on' : ''} onClick={() => open('market')}><span>📈</span><span>Market</span></button>
        <button className={win?.id === 'inventory' ? 'on' : ''} onClick={() => open('inventory')}><span>📦</span><span>Storage</span></button>
        <button className={win?.id === 'bank' ? 'on' : ''} onClick={() => open('bank')}><span>🏦</span><span>Bank</span></button>
        <button className={win?.id === 'community' ? 'on' : ''} onClick={() => open('community')}><span>💬</span><span>Community</span></button>
        <button className={win?.id === 'leaderboard' ? 'on' : ''} onClick={() => open('leaderboard')}><span>🏆</span><span>Leaders</span></button>
        <button className={win?.id === 'wiki' ? 'on' : ''} onClick={() => open('wiki')}><span>📖</span><span>Help</span></button>
        {me.role !== 'player' && <button className={win?.id === 'mod' ? 'on' : ''} onClick={() => open('mod')}><span>🛡️</span><span>Staff</span></button>}
      </nav>

      {Win && (
        <Suspense fallback={null}>
          <Win key={JSON.stringify(win)} params={win!.params} city={city} api={api.current} />
        </Suspense>
      )}

      {cartPrompt && city && (
        <Modal title="Park your cart here?" onClose={() => setCartPrompt(null)}>
          <form
            className="stack"
            onSubmit={async (e) => {
              e.preventDefault();
              const r = await act(() => rpc<any>('buy_cart', { p_name: cartName, p_lat: cartPrompt.lat, p_lng: cartPrompt.lng }), (x) =>
                x.starter_stock ? 'Your cart is open! We put some starter stock in your storage.' : 'Your cart is open!'
              );
              if (r) {
                setCartPrompt(null);
                set({ mode: { kind: 'walk' } });
                const fresh = await rpc<Me>('get_me');
                set({ me: fresh });
                bump();
                open('business', { id: r.business_id });
              }
            }}
          >
            <p className="muted">
              Foot traffic here: <b>{trafficAt(city, cartPrompt.lat, cartPrompt.lng).toFixed(2)}</b> (1.0 is a normal street; busy spots near stations and sights go above 2).
            </p>
            <label className="field">
              <span>Cart name</span>
              <input className="input" value={cartName} onChange={(e) => setCartName(e.target.value)} maxLength={40} />
            </label>
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button type="button" className="btn ghost" onClick={() => setCartPrompt(null)}>Not here</button>
              <button className="btn gold">Buy cart for {money(useGame.getState().catalog?.business_types.find((t) => t.id === 'cart')?.cost ?? 5000000)}</button>
            </div>
          </form>
        </Modal>
      )}

      {taxi && (
        <Modal title="Take a taxi?" onClose={() => setTaxi(null)}>
          <p>A taxi there costs about <b>{money(taxi.cost)}</b> and gets you there straight away.</p>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn ghost" onClick={() => setTaxi(null)}>Walk instead</button>
            <button
              className="btn"
              onClick={async () => {
                const r = await act(() => rpc<any>('taxi', { p_lat: taxi.lat, p_lng: taxi.lng }), (x) => `Taxi ride: ${money(x.cost)}`);
                if (r) {
                  set({ pos: { lat: taxi.lat, lng: taxi.lng }, walkingTo: null, mode: { kind: 'walk' } });
                  const fresh = await rpc<Me>('get_me');
                  set({ me: fresh });
                }
                setTaxi(null);
              }}
            >
              Ride
            </button>
          </div>
        </Modal>
      )}

      {away && <AwayCard away={away} onClose={() => set({ away: null })} />}
    </div>
  );
}
