import { useEffect, useState } from 'react';
import { rpc, BACKEND_READY } from '../lib/supabase';
import { money, num, pct, unitPrice } from '../lib/format';
import { Footer } from './Pages';
import '../styles/landing.css';
import { GoodIcon, Icon } from '../ui/Icon';
import LandingHero from './LandingHero';
const TIER_ACCENT = ['#e3694d', '#2f8f6e', '#6c9a3d', '#8a6b4a', '#4b6a8c', '#6b4b8c'];

const TIERS = [
  { icon: 'cart', name: 'Food carts', text: 'Park on a busy real street, pick a menu and set your prices.' },
  { icon: 'restaurant', name: 'Shops and restaurants', text: 'Rent a room in any building, fit it out, hire a crew, sell while you sleep.' },
  { icon: 'apartments', name: 'Land and buildings', text: 'Buy plots and whole buildings. Farm, build homes, collect rent.' },
  { icon: 'mine', name: 'Mining and surveys', text: 'Pay for a survey that only you can see, then dig out what you found.' },
  { icon: 'factory', name: 'Industry and ports', text: 'Turn raw goods into steel, furniture and electronics, and ship them abroad.' },
  { icon: 'bank', name: 'Finance', text: 'Run a bank that lends to other players, or take your company public.' },
];

const PILLARS = [
  ['Your real world', 'Every street comes from real map data: London, New York, Tokyo, Singapore and Paris.'],
  ['Small start, huge ceiling', 'A cart with one menu grows into land, mines, factories, shipping and trading.'],
  ['One economy for everyone', 'All goods trade on one shared exchange. Other players are your customers, suppliers and rivals.'],
  ['It keeps running', 'Businesses sell while you’re away. Coming back to see what you earned is half the fun.'],
  ['Honest and fair', 'No pay-to-win. Game money can’t be bought, and the rules are written in plain English.'],
];

function Skyline() {
  // A hand-drawn street scene: buildings, a cart, people, map pins.
  const blds = [
    [10, 120, 46, 'var(--brand)'], [60, 80, 40, 'var(--brand-2)'], [104, 150, 54, 'var(--sky)'], [164, 100, 44, 'var(--brand)'],
    [214, 170, 50, 'var(--gold)'], [270, 110, 46, 'var(--brand-2)'], [322, 140, 58, 'var(--sky)'], [386, 90, 42, 'var(--brand)'],
  ] as const;
  return (
    <svg viewBox="0 0 440 260" className="hero-art" role="img" aria-label="A street with buildings, a food cart and shoppers">
      <defs>
        <linearGradient id="sky" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="var(--sky-soft)" />
          <stop offset="1" stopColor="var(--bg)" />
        </linearGradient>
      </defs>
      <rect width="440" height="260" rx="22" fill="url(#sky)" />
      <circle cx="372" cy="54" r="22" fill="var(--gold)" opacity="0.85" />
      {blds.map(([x, h, w, c], i) => (
        <g key={i}>
          <rect x={x} y={214 - h} width={w} height={h} rx="4" fill={c} opacity={0.9} />
          {Array.from({ length: Math.floor(h / 22) }).map((_, r) =>
            [0, 1].map((k) => (
              <rect key={`${r}-${k}`} x={x + 8 + k * (w / 2 - 4)} y={214 - h + 10 + r * 22} width={w / 2 - 14} height="9" rx="2" fill="#fff" opacity={(r + k + i) % 3 ? 0.55 : 0.9} />
            ))
          )}
        </g>
      ))}
      <rect x="0" y="214" width="440" height="46" fill="var(--bg-2)" />
      <rect x="0" y="234" width="440" height="4" fill="var(--line-2)" />
      {/* Cart */}
      <g transform="translate(186 178)">
        <rect x="0" y="10" width="62" height="30" rx="6" fill="var(--coral)" />
        <path d="M-4 12 L66 12 L58 -6 L4 -6 Z" fill="#fff" />
        <path d="M4 -6 L14 12 M24 -6 L28 12 M38 -6 L36 12 M52 -6 L46 12" stroke="var(--coral)" strokeWidth="4" />
        <circle cx="14" cy="44" r="7" fill="var(--ink)" />
        <circle cx="48" cy="44" r="7" fill="var(--ink)" />
        <text x="31" y="31" textAnchor="middle" fontSize="13" fontWeight="800" fill="#fff">$4</text>
      </g>
      {/* People */}
      {[[120, '#2f6f5e'], [150, '#e3694d'], [280, '#3f8ed6'], [306, '#f3c443'], [340, '#8a5cc2']].map(([x, c], i) => (
        <g key={i} transform={`translate(${x} 214)`}>
          <circle cx="0" cy="-26" r="6" fill={c as string} />
          <rect x="-6" y="-19" width="12" height="18" rx="5" fill={c as string} />
        </g>
      ))}
      {/* Pins */}
      {[[80, 70, '+$12.50'], [300, 50, '+$7.80']].map(([x, y, t], i) => (
        <g key={i} transform={`translate(${x} ${y})`} className="pin">
          <rect x="-34" y="-16" width="68" height="26" rx="13" fill="var(--panel-solid)" stroke="var(--line-2)" />
          <text x="0" y="2" textAnchor="middle" fontSize="12" fontWeight="800" fill="var(--good)">{t}</text>
        </g>
      ))}
    </svg>
  );
}

export default function Landing() {
  const [stats, setStats] = useState<any>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!BACKEND_READY) return;
    let alive = true;
    const load = () => rpc('world_stats').then((s) => alive && setStats(s)).catch(() => alive && setError(true));
    load();
    const t = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  return (
    <div className="landing">
      <nav className="land-nav">
        <a className="brand" href="#/">
          <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" />
          CranCapital
        </a>
        <div className="row">
          <a className="link hide-sm" href="#/wiki">How it works</a>
          <a className="btn small" href="#/play">Sign in</a>
        </div>
      </nav>

      <header className="hero">
        <div className="hero-copy">
          <span className="chip gold">A shared world, open now</span>
          <h1>Start with one food cart on a real street. Build an empire.</h1>
          <p className="lead">
            CranCapital is a business game on a real map that every player shares. Your businesses keep earning while you’re offline,
            so it’s about smart choices, not hours of clicking.
          </p>
          <div className="row wrap">
            <a className="btn gold" href="#/play">Play free</a>
            <a className="btn ghost" href="#/tutorial">Try Tutorial Island</a>
          </div>
          <p className="tiny muted">Made for iPad: add it to your Home Screen to play full screen. Works in any modern browser. Money in the game can’t be bought.</p>
        </div>
        <LandingHero fallback={<Skyline />} />
      </header>

      <section className="stats-band" aria-label="Live world stats">
        <div className="stat-card"><span>Players online</span><strong>{stats ? num(stats.players_online) : '—'}</strong></div>
        <div className="stat-card"><span>Total players</span><strong>{stats ? num(stats.players_total) : '—'}</strong></div>
        <div className="stat-card"><span>World GDP, last 24 h</span><strong>{stats ? money(stats.gdp_24h, { compact: true }) : '—'}</strong></div>
        <div className="stat-card"><span>Combined net worth</span><strong>{stats ? money(stats.net_worth_total, { compact: true }) : '—'}</strong></div>
        {error && <p className="tiny muted">Live stats are unavailable right now.</p>}
      </section>

      {stats?.ticker?.length > 0 && (
        <div className="ticker" aria-label="Exchange prices">
          <div className="ticker-track">
            {[...stats.ticker, ...stats.ticker].map((t: any, i: number) => (
              <span key={i}>
                <GoodIcon id={t.good ?? t.id} size={18} /> {t.name} <b>{unitPrice(t.price)}</b>{' '}
                <em className={t.change_pct > 0 ? 'good' : t.change_pct < 0 ? 'bad' : 'muted'}>{pct(t.change_pct)}</em>
              </span>
            ))}
          </div>
        </div>
      )}

      <section className="section">
        <h2>Six tiers, each with one new idea</h2>
        <p className="muted">Climb from a cart to a bank. Each step unlocks when your net worth is big enough.</p>
        <div className="tier-grid">
          {TIERS.map((t, i) => (
            <div key={t.name} className="tier-card">
              <div className="tier-top">
                <span className="tier-icon"><Icon name={t.icon} size={34} accent={TIER_ACCENT[i]} /></span>
                <span className="chip">Tier {i + 1}</span>
              </div>
              <h3>{t.name}</h3>
              <p className="muted small">{t.text}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="section how">
        <h2>How a session goes</h2>
        <ol className="steps">
          <li><strong>Log in</strong> and see what you earned while you were away.</li>
          <li><strong>Walk the streets</strong> to find a busy spot or a cheap supply.</li>
          <li><strong>Make a few decisions:</strong> prices, stock, a new shop, a trade.</li>
          <li><strong>Log off.</strong> Your businesses keep selling for up to 24 hours.</li>
        </ol>
      </section>

      <section className="section">
        <h2>What we promise</h2>
        <div className="pillars">
          {PILLARS.map(([h, t]) => (
            <div key={h} className="pillar">
              <h3>{h}</h3>
              <p className="muted small">{t}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="section cta">
        <h2>Your first cart is waiting</h2>
        <p className="muted">Every new player starts with $10,000. A cart costs $5,000, and your first sales arrive within a minute.</p>
        <a className="btn gold" href="#/play">Start playing</a>
      </section>

      <Footer />
    </div>
  );
}
