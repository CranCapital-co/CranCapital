import { useEffect, useState } from 'react';
import { sound } from '../audio/sound';
import { useIncome } from '../lib/income';
import { supabase, rpc, DEV_LOGIN, devSignIn, BACKEND_READY, SUPABASE_URL, SUPABASE_KEY, AUTH_ERROR } from '../lib/supabase';
import { useGame } from '../lib/store';
import { subscribeUser, unsubscribeUser, leaveWorld, retrack } from '../lib/realtime';
import { localTime } from '../lib/format';
import type { Catalog, Me } from '../lib/types';
import World from './World';
import NationPicker, { nationLater, setNationLater } from '../nations/NationPicker';
import { Icon } from '../ui/Icon';

function Brand() {
  return (
    <a className="brand" href="#/">
      <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" />
      CranCapital
    </a>
  );
}

function SignIn() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(
    AUTH_ERROR ? 'That sign-in link has expired or was already used. Enter your email to get a new one.' : null
  );
  const [google, setGoogle] = useState(false);
  // Opened from the iPad or iPhone home screen: emailed links open in Safari instead.
  const homeScreenApp = (navigator as any).standalone === true || window.matchMedia?.('(display-mode: standalone)').matches;
  useEffect(() => {
    fetch(`${SUPABASE_URL}/auth/v1/settings`, { headers: { apikey: SUPABASE_KEY } })
      .then((r) => r.json())
      .then((s) => setGoogle(!!s?.external?.google))
      .catch(() => {});
  }, []);
  const redirect = window.location.origin + window.location.pathname;

  async function sendLink(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      if (DEV_LOGIN) {
        await devSignIn(email.trim().toLowerCase());
        return;
      }
      const { error } = await supabase.auth.signInWithOtp({ email: email.trim().toLowerCase(), options: { emailRedirectTo: redirect, shouldCreateUser: true } });
      if (error) throw error;
      setSent(true);
    } catch (x: any) {
      setErr(/rate limit/i.test(x.message) ? 'Too many sign-in emails just now. Please wait a few minutes and try again.' : x.message);
    } finally {
      setBusy(false);
    }
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    const { error } = await supabase.auth.verifyOtp({ email: email.trim().toLowerCase(), token: code.trim(), type: 'email' });
    if (error) setErr('That code didn’t work. Check it, or ask for a new email.');
    setBusy(false);
  }

  return (
    <div className="center-screen">
      <div className="auth-card stack">
        <Brand />
        <h1 style={{ fontSize: 28 }}>Sign in to play</h1>
        {!sent ? (
          <form className="stack" onSubmit={sendLink}>
            <p className="muted">Enter your email and we’ll send you a sign-in link and code. No password needed.</p>
            <label className="field">
              <span>Email</span>
              <input className="input" type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
            </label>
            {err && <div className="notice red">{err}</div>}
            <button className="btn block" disabled={busy}>{DEV_LOGIN ? 'Sign in (local dev)' : 'Email me a sign-in link'}</button>
            {google && (
              <button
                type="button"
                className="btn ghost block"
                onClick={() => supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: redirect } })}
              >
                Continue with Google
              </button>
            )}
          </form>
        ) : (
          <form className="stack" onSubmit={verify}>
            <div className="notice green">We sent an email to <b>{email}</b>. Tap the link in it, or type the 6-digit code here if the email shows one.</div>
            {homeScreenApp && (
              <div className="notice small">
                You’re using the home-screen app, and email links open in Safari. Type the code here to sign in. If your email has no code, open CranCapital in Safari and sign in there.
              </div>
            )}
            <label className="field">
              <span>Code from the email</span>
              <input className="input" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" />
            </label>
            {err && <div className="notice red">{err}</div>}
            <button className="btn block" disabled={busy || code.trim().length < 6}>Sign in</button>
            <button type="button" className="link" onClick={() => setSent(false)}>Use a different email</button>
          </form>
        )}
        <hr className="sep" />
        <p className="small muted">
          New here? <a href="#/tutorial">Try Tutorial Island</a> first, no account needed. By signing in you agree to the{' '}
          <a href="#/legal/terms">terms</a> and <a href="#/legal/rules">community rules</a>, and you’ve read the <a href="#/legal/privacy">privacy policy</a>.
        </p>
      </div>
    </div>
  );
}

function Onboarding({ onDone }: { onDone: (me: Me) => void }) {
  const session = useGame((s) => s.session);
  const [name, setName] = useState(() => (session?.user.email ?? '').split('@')[0].replace(/[^A-Za-z0-9 _'-]/g, '').slice(0, 20));
  const [age, setAge] = useState(false);
  const [ref, setRef] = useState(() => {
    try {
      return localStorage.getItem('cc_ref') ?? '';
    } catch {
      return '';
    }
  });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="center-screen">
      <form
        className="auth-card stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setErr(null);
          try {
            const me = await rpc<Me>('create_player', { p_name: name, p_age_ok: age, p_referral: ref || null });
            try {
              localStorage.removeItem('cc_ref');
            } catch {
              /* ignore */
            }
            onDone(me);
          } catch (x: any) {
            setErr(x.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Brand />
        <h1 style={{ fontSize: 28 }}>Welcome to CranCapital</h1>
        <p className="muted">Choose the name other players will see. You can change it later.</p>
        <label className="field">
          <span>Display name</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} minLength={3} maxLength={20} required />
          <small className="muted">3 to 20 letters, numbers, spaces, dashes or underscores. No links.</small>
        </label>
        <label className="field">
          <span>Invite code (optional)</span>
          <input className="input" value={ref} onChange={(e) => setRef(e.target.value.toUpperCase())} maxLength={12} />
        </label>
        <label className="check">
          <input type="checkbox" checked={age} onChange={(e) => setAge(e.target.checked)} />
          <span>I am 13 or over, and I agree to the <a href="#/legal/terms" target="_blank">terms</a> and <a href="#/legal/rules" target="_blank">community rules</a>.</span>
        </label>
        {err && <div className="notice red">{err}</div>}
        <button className="btn block gold" disabled={busy || !age}>Start with $10,000</button>
        <button type="button" className="link" onClick={() => supabase.auth.signOut()}>Sign out</button>
      </form>
    </div>
  );
}

function TutorialOffer({ onSkip }: { onSkip: () => void }) {
  return (
    <div className="center-screen">
      <div className="auth-card stack center">
        <Icon name="island" size={56} accent="var(--sky)" />
        <h1 style={{ fontSize: 28 }}>Visit Tutorial Island?</h1>
        <p className="muted">A small practice town where you’ll walk, park a cart, set a menu and sell to passing crowds. It takes about three minutes and earns you the Graduate badge and skin.</p>
        <a className="btn gold block" href="#/tutorial">Go to Tutorial Island</a>
        <button className="btn ghost block" onClick={onSkip}>Skip, take me to a city</button>
      </div>
    </div>
  );
}

function CityPicker({ catalog, onPick }: { catalog: Catalog; onPick: (city: string) => Promise<void> }) {
  // Today's weather and who's online in each city.
  const [weather, setWeather] = useState<any[] | null>(null);
  const [stats, setStats] = useState<any[] | null>(null);
  useEffect(() => {
    rpc<any[]>('city_weather').then(setWeather).catch(() => {});
    rpc<any[]>('city_stats').then(setStats).catch(() => {});
  }, []);
  const [busy, setBusy] = useState(false);
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  const blurbs: Record<string, string> = {
    london: 'Start by Trafalgar Square. Busy West End streets, the Thames for ports, a taste for imported coffee.',
    'new-york': 'Start in Times Square. Huge crowds in Midtown and the highest prices and wages.',
    tokyo: 'Start at Tokyo Station. Dense streets, big appetite for raw materials.',
    singapore: 'Start at Raffles Place. The only warm city: bananas and coffee grow here.',
    paris: 'Start at the Louvre. Tourists all day, and the Seine for ports. Bakers pay well for flour.',
  };
  return (
    <div className="center-screen">
      <div className="stack" style={{ width: 'min(980px, 100%)' }}>
        <Brand />
        <h1 style={{ fontSize: 32 }}>Pick your city</h1>
        <p className="muted">Real streets, real local time. You can fly to the others later.</p>
        <div className="city-cards">
          {catalog.cities.filter((c) => c.open).map((c) => (
            <CityCard key={c.id} c={c} blurb={blurbs[c.id] ?? c.country} weather={weather?.find((w) => w.city_id === c.id)} online={stats?.find((s) => s.city_id === c.id)?.online ?? 0} disabled={busy} onPick={async () => { setBusy(true); try { await onPick(c.id); } finally { setBusy(false); } }} />
          ))}
        </div>
      </div>
    </div>
  );
}

export default function Play() {
  const { session, me, catalog, needsProfile, set, toast } = useGame();
  const [booting, setBooting] = useState(true);
  const [skipTutorial, setSkipTutorial] = useState(() => {
    try {
      return sessionStorage.getItem('cc_skip_tutorial') === '1';
    } catch {
      return false;
    }
  });
  const [bootError, setBootError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    if (!BACKEND_READY) {
      setBooting(false);
      return;
    }
    supabase.auth.getSession().then(({ data }) => {
      set({ session: data.session });
      if (!data.session) setBooting(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
      set({ session: s });
      if (!s) {
        set({ me: null, needsProfile: false });
        unsubscribeUser();
        leaveWorld();
      }
    });
    rpc<Catalog>('get_catalog').then((c) => set({ catalog: c })).catch((e) => toast(e.message, 'error'));
    return () => sub.subscription.unsubscribe();
  }, [set, toast]);

  // Signed in: load the player, start live updates and the heartbeat.
  useEffect(() => {
    if (!session) return;
    let alive = true;
    (async () => {
      try {
        setBootError(null);
        const r = await rpc<any>('session_start');
        if (!alive) return;
        if (!r) {
          setBootError('Your session has expired. Please sign in again.');
        } else if (r.needs_profile) {
          set({ needsProfile: true, me: null });
        } else {
          set({ me: r.me, needsProfile: false, away: r.away && (r.away.net !== 0 || r.away.notifications?.length || r.away.attention?.length) ? r.away : null });
          if (r.new_day && r.loyalty_added) toast(`Welcome back! +${r.loyalty_added} loyalty points for today.`, 'success');
        }
      } catch (e: any) {
        if (alive) setBootError(e.message);
      } finally {
        if (alive) setBooting(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [session, set, toast, retry]);

  // Finished Tutorial Island before signing up: count it now.
  useEffect(() => {
    if (!me || me.tutorial_done) return;
    try {
      if (localStorage.getItem('cc_tutorial_done') === '1') {
        rpc('complete_tutorial').then(() => set({ me: { ...me, tutorial_done: true } })).catch(() => {});
      }
    } catch {
      /* storage may be blocked */
    }
  }, [me, set]);

  useEffect(() => {
    if (!me?.id) return;
    subscribeUser(me.id, (ev, payload) => {
      const g = useGame.getState();
      if (ev === 'notification') {
        window.dispatchEvent(new CustomEvent('cc:notification', { detail: payload }));
        if (payload?.kind !== 'badge') sound.play('notify');
        g.toast(payload.title + (payload.body ? ` — ${payload.body}` : ''), 'info');
        if (g.me) g.set({ me: { ...g.me, unread: (g.me.unread ?? 0) + 1 } });
      } else if (ev === 'sales') {
        useIncome.getState().add(payload.revenue ?? 0);
        window.dispatchEvent(new CustomEvent('cc:sales', { detail: payload }));
        if (g.me) g.set({ me: { ...g.me, cash: g.me.cash + (payload.revenue ?? 0) } });
      } else if (ev === 'order') {
        g.bump();
      } else if (ev === 'renown') {
        window.dispatchEvent(new CustomEvent('cc:xp', { detail: payload }));
      } else if (ev === 'dm') {
        sound.play('chat');
        g.toast(`New message from ${payload.from}`, 'info');
        window.dispatchEvent(new CustomEvent('cc:dm', { detail: payload }));
      }
    });
    const beat = async () => {
      try {
        const h = await rpc<any>('heartbeat');
        retrack();
        const g = useGame.getState();
        if (g.me) {
          const arrived = g.me.travel_to && !h.travel_to;
          g.set({ me: { ...g.me, ...h } });
          if (arrived) {
            const fresh = await rpc<Me>('get_me');
            g.set({ me: fresh, pos: fresh.lat ? { lat: fresh.lat, lng: fresh.lng! } : null });
          }
        }
      } catch {
        /* offline for a moment */
      }
    };
    const t = setInterval(beat, 45_000);
    return () => clearInterval(t);
  }, [me?.id]);

  if (!BACKEND_READY) {
    return (
      <div className="center-screen">
        <div className="auth-card stack">
          <Brand />
          <h1 style={{ fontSize: 26 }}>The game server isn’t connected yet</h1>
          <p className="muted">This build has no Supabase address. You can still explore <a href="#/tutorial">Tutorial Island</a>.</p>
        </div>
      </div>
    );
  }
  if (bootError && session && !me) {
    return (
      <div className="center-screen">
        <div className="auth-card stack">
          <Brand />
          <h1 style={{ fontSize: 24 }}>Couldn’t load your game</h1>
          <div className="notice red">{bootError}</div>
          <button className="btn" onClick={() => setRetry((x) => x + 1)}>Try again</button>
          <button className="btn ghost" onClick={() => supabase.auth.signOut()}>Sign out</button>
        </div>
      </div>
    );
  }
  if (booting || (session && !me && !needsProfile)) return <div className="boot"><div className="spinner" /></div>;
  if (!session) return <SignIn />;
  if (needsProfile) return <Onboarding onDone={(m) => set({ me: m, needsProfile: false })} />;
  if (!me || !catalog) return <div className="boot"><div className="spinner" /></div>;
  // First thing: the country you'll lead (first come, first served).
  if (!me.nation && !nationLater()) {
    return <NationPicker onDone={(m) => set({ me: m })} onLater={() => { setNationLater(); set({ me: { ...me } }); }} />;
  }
  if (!me.city_id && !me.travel_to) {
    if (!me.tutorial_done && !skipTutorial) return <TutorialOffer onSkip={() => setSkipTutorial(true)} />;
    return (
      <CityPicker
        catalog={catalog}
        onPick={async (city) => {
          try {
            const m = await rpc<Me>('choose_city', { p_city: city });
            set({ me: m, pos: m.lat ? { lat: m.lat, lng: m.lng! } : null });
          } catch (e: any) {
            toast(e.message, 'error');
          }
        }}
      />
    );
  }
  return <World />;
}

const WEATHER_WORD = (code: number | null | undefined) =>
  code == null ? null : code === 0 ? 'Clear' : code <= 2 ? 'Sunny spells' : code === 3 ? 'Cloudy' : code === 45 || code === 48 ? 'Foggy' : (code >= 71 && code <= 77) || code === 85 || code === 86 ? 'Snow' : code >= 95 ? 'Storms' : 'Rain';

// A city to pick: a little 3D street with its landmark, local time, today's
// weather and how many players are there now.
function CityCard({ c, blurb, weather, online, disabled, onPick }: { c: any; blurb: string; weather?: any; online: number; disabled: boolean; onPick: () => void }) {
  const [pic, setPic] = useState<string>('');
  useEffect(() => {
    let alive = true;
    import('../world3d/dioramas')
      .then((m) => {
        if (alive) setPic(m.cityDiorama(c.id));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [c.id]);
  const word = WEATHER_WORD(weather?.code);
  return (
    <button className="city-card" disabled={disabled} onClick={onPick}>
      <div className="diorama" aria-hidden>
        {pic ? <img src={pic} alt="" /> : <div className="skyline">{[40, 64, 30, 80, 52, 70, 36, 58].map((h, i) => <i key={i} style={{ height: `${h}%` }} />)}</div>}
      </div>
      <div className="row between">
        <h3 style={{ margin: 0 }}>{c.name}</h3>
        <span className="chip tnum">{localTime(c.tz)}</span>
      </div>
      <p className="small muted" style={{ margin: '6px 0 8px' }}>{blurb}</p>
      <div className="row wrap" style={{ gap: 6 }}>
        {word && weather?.temp_c != null && <span className="chip">{word} · {Math.round(weather.temp_c)}°</span>}
        <span className="chip green">{online} online now</span>
      </div>
    </button>
  );
}
