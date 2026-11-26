import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import GameMap, { type MapApi } from '../map/GameMap';
import { useGame, act, catalog } from '../lib/store';
import { rpc } from '../lib/supabase';
import { loadCity, trafficAt, type CityData } from '../lib/citydata';
import { money } from '../lib/format';
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

export default function World() {
  const me = useGame((s) => s.me)!;
  const win = useGame((s) => s.win);
  const mode = useGame((s) => s.mode);
  const away = useGame((s) => s.away);
  const { open, set, toast, bump } = useGame.getState();
  const [city, setCity] = useState<CityData | null>(null);
  const [heat, setHeat] = useState(false);
  const [cartPrompt, setCartPrompt] = useState<{ lat: number; lng: number } | null>(null);
  const [cartName, setCartName] = useState('');
  const api = useRef<MapApi | null>(null);
  const cityId = me.city_id ?? me.travel_to ?? me.travel_from ?? 'london';
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

  // Once the city is up, fetch the common windows in the background so they
  // open instantly later (and the offline cache keeps them).
  useEffect(() => {
    const t = setTimeout(() => {
      const idle = (window as any).requestIdleCallback ?? ((f: () => void) => setTimeout(f, 200));
      idle(() => {
        for (const load of [
          () => import('../ui/panels/BuildWindow'), () => import('../ui/panels/EmpireWindow'), () => import('../ui/panels/BusinessWindow'),
          () => import('../ui/panels/ProgressWindow'), () => import('../nations/NationsScreen'), () => import('../ui/panels/MarketWindow'),
          () => import('../ui/panels/PeopleWindow'), () => import('../ui/panels/MoreWindow'),
        ]) load().catch(() => {});
      });
    }, 8000);
    return () => clearTimeout(t);
  }, []);

  // Refresh money and open windows every 30 s so offline sales show up.
  useEffect(() => {
    // Less often, and not at all while the game is in the background.
    const i = setInterval(() => !document.hidden && bump(), 60_000);
    return () => clearInterval(i);
  }, [bump]);

  // No character to walk anywhere: a tap on a street places the cart there.
  const onPlace = async (lat: number, lng: number) => {
    const m = useGame.getState().mode;
    if (m.kind === 'move-cart') {
      const r = await act(() => rpc('move_cart', { p_id: m.businessId, p_lat: lat, p_lng: lng }), 'Cart moved.');
      if (r) {
        set({ mode: { kind: 'walk' } });
        bump();
      }
      return;
    }
    setCartPrompt({ lat, lng });
    setCartName(`${me.display_name}'s Cart`.slice(0, 40));
  };

  // Survey mode: tap a block to look for minerals there.
  const onSurvey = async (lat: number, lng: number) => {
    const r = await act(() => rpc<any>('survey', { p_lat: lat, p_lng: lng }));
    if (!r) return;
    const names = (r.deposits ?? []).map((d: any) => catalog()?.goods.find((g) => g.id === d.resource)?.name ?? d.resource);
    toast(
      names.length
        ? `Survey found ${names.length} deposit${names.length > 1 ? 's' : ''}: ${names.join(', ')}. Tap the gold plot to build a mine.`
        : 'The survey found nothing in this block. Try another area.',
      names.length ? 'success' : 'info'
    );
    set({ mode: { kind: 'land' } });
    const fresh = await rpc<Me>('get_me').catch(() => null);
    if (fresh) set({ me: fresh });
  };

  // Keep what you're looking at clear of the open sheet.
  useEffect(() => {
    api.current?.setPadding(inset);
  }, [inset]);

  const Win = win ? WINDOWS[win.id] : null;

  return (
    <div className={`game ${photo ? 'photo' : ''}`}>
      {/* One map at a time: the city map closes while the world map is open
          (an iPad can't hold both in memory). */}
      {city && !nations && (
        <GameMap
          key={city.meta.id}
          city={city}
          onReady={(a) => (api.current = a)}
          onPlace={onPlace}
          onSurvey={onSurvey}
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

      {me.status === 'suspended' && (
        <div className="mode-banner" style={{ top: 'calc(env(safe-area-inset-top) + 110px)', background: 'var(--bad)' }}>
          Suspended until {new Date(me.status_until!).toLocaleString()}: {me.status_reason}
        </div>
      )}

      {mode.kind !== 'walk' && (
        <div className="mode-banner" role="status">
          {mode.kind === 'place-cart' && 'Tap a green street to park your new cart.'}
          {mode.kind === 'move-cart' && 'Tap a green street to move your cart there.'}
          {mode.kind === 'survey' && 'Tap a block to survey it for minerals. Each survey covers about 200 m.'}
          {mode.kind === 'land' && 'Land mode: tap a green plot to see it. Gold plots are yours.'}
          <button className="btn small" onClick={() => set({ mode: { kind: 'walk' } })}>Done</button>
        </div>
      )}

      <MapTools
        heat={heat}
        onHeat={() => {
          setHeat(!heat);
          api.current?.setHeatmap(!heat);
        }}
        onFindMe={() => city && api.current?.flyTo(city.meta.start.lat, city.meta.start.lng, 16.6)}
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
