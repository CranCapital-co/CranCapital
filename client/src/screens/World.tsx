import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import GameMap, { type MapApi } from '../map/GameMap';
import { useGame, act, cityName } from '../lib/store';
import { rpc } from '../lib/supabase';
import { loadCity, trafficAt, distM, type CityData } from '../lib/citydata';
import { joinWorld, leaveWorld } from '../lib/realtime';
import { money, ringFor, until } from '../lib/format';
import { Modal } from '../ui/components';
import AwayCard from '../ui/AwayCard';
import { HudMoney, CityStrip, HudRight } from '../ui/hud/Hud';
import { Dock } from '../ui/hud/Dock';
import { MapTools } from '../ui/hud/MapTools';
import { Icon } from '../ui/Icon';
import { Moments } from '../ui/Moments';
import { RenownMoments, RenownBadge } from '../ui/RenownMoments';
import { PhotoMode } from '../ui/PhotoMode';
import { reducedMotion } from '../lib/settings';
import { trafficLabel } from '../ui/common';
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
const EmpireWindow = lazy(() => import('../ui/panels/EmpireWindow'));
const PeopleWindow = lazy(() => import('../ui/panels/PeopleWindow'));
const MoreWindow = lazy(() => import('../ui/panels/MoreWindow'));
const ProgressWindow = lazy(() => import('../ui/panels/ProgressWindow'));
const NationsScreen = lazy(() => import('../nations/NationsScreen'));

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
  empire: EmpireWindow,
  people: PeopleWindow,
  more: MoreWindow,
  progress: ProgressWindow,
};

type Pending = { kind: 'buy-cart' | 'move-cart'; lat: number; lng: number; businessId?: number } | null;

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
      <Icon name="plane" size={20} accent="rgba(255,255,255,.4)" /> Flying to {cityName(me.travel_to)} · lands in {until(me.travel_arrive_at)}
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
  const inset = useGame((s) => s.inset);
  // Coming back: a 3-second fast-forward of the city (the sun sweeps across,
  // the cash counter rolls up), then the summary. A tap skips it.
  const [ffDone, setFfDone] = useState(false);
  // Photo mode (from More) and the empire tour banner.
  const [photo, setPhoto] = useState(false);
  const [tour, setTour] = useState<{ name: string; business: string; i: number; n: number } | null>(null);
  // Your nation and the world map, over the city.
  const [nations, setNations] = useState(false);
  useEffect(() => {
    const on = () => {
      useGame.getState().close();
      setNations(true);
    };
    window.addEventListener('cc:nations', on);
    return () => window.removeEventListener('cc:nations', on);
  }, []);
  useEffect(() => {
    (window as any).__ccPause3d = nations;
    if (!nations) window.dispatchEvent(new Event('resize'));
  }, [nations]);
  useEffect(() => {
    const onPhoto = () => setPhoto(true);
    const onTour = (e: Event) => setTour((e as CustomEvent).detail);
    window.addEventListener('cc:photo', onPhoto);
    window.addEventListener('cc:tour', onTour);
    return () => {
      window.removeEventListener('cc:photo', onPhoto);
      window.removeEventListener('cc:tour', onTour);
    };
  }, []);
  useEffect(() => {
    if (!away) return;
    if (reducedMotion(me.prefs) || !away.hours) {
      setFfDone(true);
      return;
    }
    setFfDone(false);
    const start = setTimeout(() => window.dispatchEvent(new CustomEvent('cc:fastforward', { detail: { hours: Number(away.hours), net: Number(away.net ?? 0) } })), 1200);
    const done = setTimeout(() => setFfDone(true), 4400);
    const skip = () => setFfDone(true);
    window.addEventListener('pointerdown', skip, { once: true });
    return () => {
      clearTimeout(start);
      clearTimeout(done);
      window.removeEventListener('pointerdown', skip);
    };
  }, [away]);
  // New players: the Build button glows until their first business exists.
  const refreshKey = useGame((s) => s.refreshKey);
  const [hasBusiness, setHasBusiness] = useState(true);
  useEffect(() => {
    rpc<any[]>('my_businesses').then((l) => setHasBusiness(l.length > 0)).catch(() => {});
  }, [refreshKey]);

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

  // Leave the city's presence channel when flying or leaving the game.
  useEffect(() => {
    if (me.travel_to) leaveWorld();
  }, [me.travel_to]);
  useEffect(() => () => leaveWorld(), []);

  // A half-finished cart placement is dropped when the mode changes.
  useEffect(() => {
    setPending(null);
  }, [mode.kind]);

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

  // Keep what you're looking at clear of the open sheet.
  useEffect(() => {
    api.current?.setPadding(inset);
  }, [inset]);

  const Win = win ? WINDOWS[win.id] : null;

  return (
    <div className={`game ${photo ? 'photo' : ''}`}>
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
        <HudMoney />
        <RenownBadge />
        <div className="grow hud-mid">
          <CityStrip cityId={cityId} />
        </div>
        <HudRight onEmpireView={() => api.current?.empireView()} />
      </div>

      {me.travel_to && <TravelBanner me={me} />}
      {me.status === 'suspended' && (
        <div className="mode-banner" style={{ top: 'calc(env(safe-area-inset-top) + 110px)', background: 'var(--bad)' }}>
          Suspended until {new Date(me.status_until!).toLocaleString()}: {me.status_reason}
        </div>
      )}

      {mode.kind !== 'walk' && (
        <div className="mode-banner" role="status">
          {mode.kind === 'place-cart' && 'Tap a green street to park your new cart.'}
          {mode.kind === 'move-cart' && 'Tap a green street to move your cart there.'}
          {mode.kind === 'taxi' && 'Tap anywhere in the city to take a taxi there.'}
          {mode.kind === 'land' && 'Land mode: tap a green plot to see it. Gold plots are yours.'}
          <button className="btn small" onClick={() => { set({ mode: { kind: 'walk' } }); setPending(null); }}>Done</button>
        </div>
      )}

      <MapTools
        heat={heat}
        onHeat={() => {
          setHeat(!heat);
          api.current?.setHeatmap(!heat);
        }}
        onFindMe={() => {
          const p = useGame.getState().pos;
          if (p) api.current?.flyTo(p.lat, p.lng);
        }}
      />

      <Dock glowBuild={!hasBusiness && mode.kind === 'walk' && !win} />

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
                window.dispatchEvent(new CustomEvent('cc:built', { detail: { id: r.business_id } }));
                setCartPrompt(null);
                set({ mode: { kind: 'walk' } });
                const fresh = await rpc<Me>('get_me');
                set({ me: fresh });
                bump();
                open('business', { id: r.business_id });
              }
            }}
          >
            <TrafficStars value={trafficAt(city, cartPrompt.lat, cartPrompt.lng)} />
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
                  const from = useGame.getState().pos;
                  const to = { lat: taxi.lat, lng: taxi.lng };
                  set({ walkingTo: null, mode: { kind: 'walk' } });
                  setTaxi(null);
                  // The taxi pulls up and you get in before it drives you there.
                  if (from) window.dispatchEvent(new CustomEvent('cc:taxi', { detail: { from, to } }));
                  await new Promise((res) => setTimeout(res, (window as any).__ccWorld ? 2000 : 0));
                  set({ pos: to });
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

      {away && ffDone && <AwayCard away={away} onClose={() => set({ away: null })} />}
      <Moments api={api} />
      <RenownMoments />
      {nations && (
        <Suspense fallback={<div className="boot"><div className="spinner" /></div>}>
          <NationsScreen onClose={() => setNations(false)} />
        </Suspense>
      )}
      {photo && <PhotoMode api={api} onClose={() => setPhoto(false)} />}
      {tour && (
        <div className="mode-banner tour-banner" role="status">
          <Icon name="eye" size={20} /> Visiting {tour.name}’s empire · {tour.business} ({tour.i} of {tour.n})
          <button className="btn small" onClick={() => setTour(null)}>Stop</button>
        </div>
      )}
    </div>
  );
}

// Foot traffic as Quiet / Busy / Packed with stars, and the exact number.
function TrafficStars({ value }: { value: number }) {
  const t = trafficLabel(value);
  return (
    <div className="traffic-stars">
      <span className="stars" aria-hidden>
        {[1, 2, 3].map((i) => <Icon key={i} name="star" size={22} accent={i <= t.stars ? 'var(--gold)' : 'transparent'} />)}
      </span>
      <span>
        <b>{t.label}</b> street <span className="muted small">· foot traffic {value.toFixed(2)} (1.0 is a normal street)</span>
      </span>
    </div>
  );
}
