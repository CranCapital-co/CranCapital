// Big moments: coins flying to your cash, the first sale, levelling up, a new
// tier (confetti, the camera circling your empire, a fanfare), badges and
// leaderboard climbs. Animations are only a show: they follow what the
// server has already confirmed. A tap skips any of them, nothing blocks
// play, and Reduce Motion turns the motion off.
import { useEffect, useRef, useState } from 'react';
import { useGame, catalog, cityName } from '../lib/store';
import { rpc } from '../lib/supabase';
import { money } from '../lib/format';
import { reducedMotion } from '../lib/settings';
import { sound } from '../audio/sound';
import { Icon, BizIcon } from './Icon';
import type { MapApi } from '../map/GameMap';

const TIER_COLORS: Record<number, string> = { 1: '#e3694d', 2: '#2f8f6e', 3: '#6c9a3d', 4: '#8a6b4a', 5: '#4b6a8c', 6: '#6b4b8c' };

interface Card {
  id: number;
  kind: 'tier' | 'first' | 'badge' | 'level' | 'rank';
  title: string;
  body?: string;
  color: string;
  tier?: number;
  action?: { label: string; fn: () => void };
}

let cardId = 0;

export function Moments({ api }: { api: React.MutableRefObject<MapApi | null> }) {
  const me = useGame((s) => s.me)!;
  const [cards, setCards] = useState<Card[]>([]);
  const confetti = useRef<HTMLCanvasElement>(null);
  const coinLayer = useRef<HTMLDivElement>(null);
  const prevTier = useRef(me.tier);
  const firstSaleDone = useRef<boolean | null>(null);
  const rank = useRef<number | null>(null);

  const push = (c: Omit<Card, 'id'>) => setCards((cs) => [...cs.filter((x) => x.kind !== c.kind), { ...c, id: ++cardId }]);
  const dismiss = (id: number) => setCards((cs) => cs.filter((c) => c.id !== id));

  // Banner cards dismiss themselves.
  useEffect(() => {
    const quick = cards.filter((c) => c.kind === 'badge' || c.kind === 'level' || c.kind === 'rank');
    if (!quick.length) return;
    const t = setTimeout(() => dismiss(quick[0].id), 4200);
    return () => clearTimeout(t);
  }, [cards]);

  // ---------- coins fly from a sale to the cash counter ----------
  useEffect(() => {
    const onCoin = (e: Event) => {
      const { x, y, amount } = (e as CustomEvent).detail ?? {};
      const layer = coinLayer.current;
      const target = document.querySelector('.hud-money .hud-cash')?.getBoundingClientRect();
      if (!layer || !target || reducedMotion(useGame.getState().me?.prefs)) return;
      const n = Math.max(2, Math.min(7, Math.round(Math.log10(1 + (amount ?? 1000) / 1000) * 3)));
      for (let i = 0; i < n; i++) {
        const c = document.createElement('div');
        c.className = 'fly-coin';
        layer.appendChild(c);
        const tx = target.left + 18 - x;
        const ty = target.top + 12 - y;
        const bend = (Math.random() - 0.5) * 160;
        const a = c.animate(
          [
            { transform: `translate(${x}px, ${y}px) scale(.4)`, opacity: 0 },
            { transform: `translate(${x + bend * 0.3}px, ${y - 60 - Math.random() * 40}px) scale(1.1)`, opacity: 1, offset: 0.25 },
            { transform: `translate(${x + tx * 0.6 + bend}px, ${y + ty * 0.55}px) scale(.95)`, opacity: 1, offset: 0.65 },
            { transform: `translate(${x + tx}px, ${y + ty}px) scale(.55)`, opacity: 0.9 },
          ],
          { duration: 900 + i * 70, delay: i * 70, easing: 'cubic-bezier(.45,.05,.55,.95)' }
        );
        a.onfinish = () => {
          c.remove();
          sound.play('coin');
          document.querySelector('.hud-money')?.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.06)' }, { transform: 'scale(1)' }], { duration: 180 });
        };
      }
    };
    window.addEventListener('cc:coin', onCoin);
    return () => window.removeEventListener('cc:coin', onCoin);
  }, []);

  // ---------- a new tier ----------
  useEffect(() => {
    if (me.tier > prevTier.current) {
      const t = catalog()?.tiers.find((x) => x.tier === me.tier);
      const kinds = catalog()?.business_types.filter((b) => b.tier === me.tier) ?? [];
      sound.play('tierup');
      const color = TIER_COLORS[me.tier] ?? '#e8b23a';
      if (!reducedMotion(me.prefs)) {
        burst(confetti.current, color, 180);
        api.current?.celebrate();
      }
      push({
        kind: 'tier',
        tier: me.tier,
        title: `Tier ${me.tier}: ${t?.name ?? ''}`,
        body: `New idea: ${t?.idea ?? ''}. You can now build ${kinds.map((k) => k.name.toLowerCase()).join(', ')}.`,
        color,
        action: { label: 'Build one', fn: () => useGame.getState().open('build') },
      });
    }
    prevTier.current = me.tier;
  }, [me.tier]);

  // ---------- the first sale ever ----------
  useEffect(() => {
    rpc<any[]>('my_badges')
      .then((b) => (firstSaleDone.current = b.some((x) => x.badge === 'first_sale')))
      .catch(() => (firstSaleDone.current = true));
    const onSales = (e: Event) => {
      if (firstSaleDone.current !== false) return;
      firstSaleDone.current = true;
      const d = (e as CustomEvent).detail;
      if (d?.lat && !reducedMotion(useGame.getState().me?.prefs)) api.current?.flyTo(d.lat, d.lng, 18);
      setTimeout(() => {
        sound.play('chaching');
        api.current?.emote('cheer');
        if (!reducedMotion(useGame.getState().me?.prefs)) burst(confetti.current, '#e8b23a', 90);
        push({ kind: 'first', title: 'First sale!', body: `Someone just bought from you: ${money(d?.revenue ?? 0)}. Every sale is a customer at your counter.`, color: '#e8b23a' });
      }, 2600);
    };
    window.addEventListener('cc:sales', onSales);
    return () => window.removeEventListener('cc:sales', onSales);
  }, []);

  // ---------- badges and level-ups ----------
  useEffect(() => {
    const onNote = (e: Event) => {
      const n = (e as CustomEvent).detail;
      if (n?.kind !== 'badge' || n?.data?.badge === 'first_sale') return;
      sound.play('badge');
      push({ kind: 'badge', title: n.title, body: n.body, color: '#e8b23a' });
    };
    const onLevel = (e: Event) => {
      const d = (e as CustomEvent).detail;
      push({ kind: 'level', title: `Level ${d?.level ?? ''}!`, body: 'It grows on the map and serves more customers.', color: '#2f8f6e' });
    };
    window.addEventListener('cc:notification', onNote);
    window.addEventListener('cc:levelup', onLevel);
    return () => {
      window.removeEventListener('cc:notification', onNote);
      window.removeEventListener('cc:levelup', onLevel);
    };
  }, []);

  // ---------- climbing the city leaderboard ----------
  useEffect(() => {
    if (!me.city_id) return;
    const check = async () => {
      try {
        const lb = await rpc<any>('leaderboard', { p_kind: 'richest', p_city: me.city_id });
        const mine = lb.rows.find((r: any) => r.me);
        if (!mine) return;
        if (rank.current != null && mine.rank < rank.current) {
          sound.play('success');
          push({ kind: 'rank', title: `You're now #${mine.rank} in ${cityName(me.city_id)}`, body: `Up from #${rank.current} on the city's richest list.`, color: '#4b6a8c' });
        }
        rank.current = mine.rank;
      } catch {
        /* not ranked yet */
      }
    };
    check();
    const i = setInterval(check, 4 * 60_000);
    return () => clearInterval(i);
  }, [me.city_id]);

  const big = cards.find((c) => c.kind === 'tier' || c.kind === 'first');
  const small = cards.filter((c) => c !== big);
  return (
    <>
      <div ref={coinLayer} className="coin-layer" aria-hidden />
      <canvas ref={confetti} className="confetti" aria-hidden />
      {big && (
        <div className="moment-back" onClick={() => dismiss(big.id)} role="dialog" aria-label={big.title}>
          <div className="moment-card" style={{ '--tier': big.color } as React.CSSProperties} onClick={(e) => e.stopPropagation()}>
            {big.kind === 'tier' ? (
              <div className="moment-pics">
                {(catalog()?.business_types.filter((b) => b.tier === big.tier) ?? []).slice(0, 4).map((b) => <BizIcon key={b.id} kind={b.id} tier={b.tier} size={64} />)}
              </div>
            ) : (
              <Icon name="coin" size={64} accent="var(--gold)" />
            )}
            <h2>{big.title}</h2>
            {big.body && <p>{big.body}</p>}
            <div className="row" style={{ justifyContent: 'center' }}>
              {big.action && (
                <button
                  className="btn gold"
                  onClick={() => {
                    dismiss(big.id);
                    big.action!.fn();
                  }}
                >
                  {big.action.label}
                </button>
              )}
              <button className="btn ghost" onClick={() => dismiss(big.id)}>{big.action ? 'Later' : 'Nice!'}</button>
            </div>
          </div>
        </div>
      )}
      <div className="moment-banners">
        {small.map((c) => (
          <button key={c.id} className={`moment-banner ${c.kind}`} style={{ '--tier': c.color } as React.CSSProperties} onClick={() => dismiss(c.id)}>
            <Icon name={c.kind === 'badge' ? 'medal' : c.kind === 'rank' ? 'trophy' : 'star'} size={30} accent={c.color} />
            <span>
              <b>{c.title}</b>
              {c.body && <span className="small">{c.body}</span>}
            </span>
          </button>
        ))}
      </div>
    </>
  );
}

// Confetti in the tier's colour (with gold and white), drawn on a canvas.
function burst(canvas: HTMLCanvasElement | null, color: string, n: number) {
  if (!canvas) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = window.innerWidth * dpr;
  canvas.height = window.innerHeight * dpr;
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const cols = [color, '#f2c14b', '#ffffff', color];
  const parts = Array.from({ length: n }, () => ({
    x: window.innerWidth / 2 + (Math.random() - 0.5) * 200,
    y: window.innerHeight * 0.35,
    vx: (Math.random() - 0.5) * 900,
    vy: -300 - Math.random() * 700,
    r: Math.random() * Math.PI,
    vr: (Math.random() - 0.5) * 12,
    w: 6 + Math.random() * 7,
    h: 4 + Math.random() * 5,
    c: cols[Math.floor(Math.random() * cols.length)],
  }));
  let last = performance.now();
  const end = last + 3200;
  const step = (t: number) => {
    const dt = Math.min(0.05, (t - last) / 1000);
    last = t;
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    for (const p of parts) {
      p.vy += 1100 * dt;
      p.vx *= 0.99;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.r += p.vr * dt;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.r);
      ctx.fillStyle = p.c;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.r * 2)));
      ctx.restore();
    }
    if (t < end) requestAnimationFrame(step);
    else ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  };
  requestAnimationFrame(step);
}
