// Renown moments: "+32 XP" floating up from the badge, a full-screen card
// when you level up (bigger when it's a new rank), achievement banners. The
// server has already given the reward; this is only the show.
import { useEffect, useRef, useState } from 'react';
import { rpc } from '../lib/supabase';
import { useGame } from '../lib/store';
import { reducedMotion } from '../lib/settings';
import { sound } from '../audio/sound';
import { Icon } from './Icon';
import { burst } from './Moments';
import type { RenownBrief } from '../lib/types';

interface LevelCard { level: number; rank: string; rankUp: boolean; unlocks: { key: string; title: string; body: string; icon: string }[] }
interface Banner { id: number; title: string; body: string; tier: number }

let bid = 0;
let refreshT: any = 0;

// Refresh the HUD's level and XP a moment after XP arrives.
export function refreshRenown() {
  clearTimeout(refreshT);
  refreshT = setTimeout(async () => {
    try {
      const r = await rpc<RenownBrief>('renown_brief');
      const g = useGame.getState();
      if (g.me) g.set({ me: { ...g.me, renown: r } });
    } catch {
      /* offline */
    }
  }, 900);
}

export function RenownMoments() {
  const [floats, setFloats] = useState<{ id: number; text: string }[]>([]);
  const [card, setCard] = useState<LevelCard | null>(null);
  const [banners, setBanners] = useState<Banner[]>([]);
  const confetti = useRef<HTMLCanvasElement>(null);
  const open = useGame((s) => s.open);

  useEffect(() => {
    const onXp = (e: Event) => {
      const d = (e as CustomEvent).detail ?? {};
      if (!d.xp) return;
      const id = ++bid;
      setFloats((f) => [...f.slice(-3), { id, text: `+${d.xp} XP` }]);
      setTimeout(() => setFloats((f) => f.filter((x) => x.id !== id)), 1600);
      refreshRenown();
    };
    const onNote = (e: Event) => {
      const d = (e as CustomEvent).detail ?? {};
      if (d.kind === 'levelup' && d.data) {
        const rankUp = !!d.data.rank_up;
        setCard({ level: d.data.level, rank: d.data.rank, rankUp, unlocks: d.data.unlocks ?? [] });
        sound.play(rankUp ? 'tierup' : 'levelup');
        if (!reducedMotion(useGame.getState().me?.prefs)) burst(confetti.current, rankUp ? '#e8b23a' : '#4fb58a', rankUp ? 200 : 110);
        refreshRenown();
      } else if (d.kind === 'achievement') {
        const id = ++bid;
        setBanners((b) => [...b.slice(-2), { id, title: d.title, body: d.body ?? '', tier: d.data?.tier ?? 1 }]);
        sound.play('badge');
        setTimeout(() => setBanners((b) => b.filter((x) => x.id !== id)), 4500);
      }
    };
    window.addEventListener('cc:xp', onXp);
    window.addEventListener('cc:notification', onNote);
    return () => {
      window.removeEventListener('cc:xp', onXp);
      window.removeEventListener('cc:notification', onNote);
    };
  }, []);

  return (
    <>
      <canvas ref={confetti} className="confetti" aria-hidden />
      <div className="xp-floats" aria-live="polite">
        {floats.map((f) => <span key={f.id} className="xp-float">{f.text}</span>)}
      </div>
      {banners.length > 0 && (
        <div className="moment-banners">
          {banners.map((b) => (
            <button key={b.id} className="moment-banner" style={{ ['--tier' as any]: MEDAL[b.tier] }} onClick={() => open('progress', { tab: 'achievements' })}>
              <Icon name="medal" size={30} accent={MEDAL[b.tier]} />
              <span><b>{b.title}</b><span className="small">{b.body}</span></span>
            </button>
          ))}
        </div>
      )}
      {card && (
        <div className="moment-back" onClick={() => setCard(null)}>
          <div className={`moment-card level-card ${card.rankUp ? 'rank-up' : ''}`} style={{ ['--tier' as any]: card.rankUp ? '#e8a93a' : '#2f8f6e' }} onClick={(e) => e.stopPropagation()}>
            <span className="level-burst"><b>{card.level}</b></span>
            <h2>{card.rankUp ? `New rank: ${card.rank}!` : `Level ${card.level}!`}</h2>
            <p>{card.rankUp ? `You reached level ${card.level}. A gold crate and the ${card.rank} title are yours.` : 'A supply crate and a perk point are waiting for you.'}</p>
            {card.unlocks.length > 0 && (
              <div className="unlock-list">
                {card.unlocks.map((u) => (
                  <div key={u.key} className="unlock-row"><Icon name={u.icon} size={22} accent="var(--gold)" /><span><b>{u.title}</b><span className="small muted">{u.body}</span></span></div>
                ))}
              </div>
            )}
            <div className="row" style={{ gap: 8 }}>
              <button className="btn ghost" onClick={() => setCard(null)}>Keep playing</button>
              <button className="btn gold" onClick={() => { setCard(null); open('progress'); }}>Open my crates</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export const MEDAL: Record<number, string> = { 0: 'var(--line-2)', 1: '#c07a43', 2: '#a8b3bd', 3: '#e8b23a', 4: '#7fd6e8' };

// The level badge in the HUD: level, a ring that fills toward the next
// level, and a dot when something is waiting (daily reward, crates, perks).
export function RenownBadge() {
  const me = useGame((s) => s.me)!;
  const open = useGame((s) => s.open);
  const r = me.renown;
  useEffect(() => {
    if (!r) refreshRenown();
  }, [r]);
  const size = 52;
  const rad = size / 2 - 4;
  const c = 2 * Math.PI * rad;
  const k = r ? Math.max(0, Math.min(1, r.into / Math.max(1, r.need))) : 0;
  const waiting = !!r && (r.daily || r.crates > 0 || r.perk_points > 0);
  return (
    <button className="renown-badge" onClick={() => open('progress')} aria-label={r ? `Renown level ${r.level}, ${r.rank}. ${r.into} of ${r.need} XP to the next level.${waiting ? ' Rewards waiting.' : ''}` : 'Renown'}>
      <svg width={size} height={size} aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={rad} fill="none" stroke="var(--line-2)" strokeWidth="5" />
        <circle cx={size / 2} cy={size / 2} r={rad} fill="none" stroke="var(--gold)" strokeWidth="5" strokeLinecap="round"
          strokeDasharray={`${c * k} ${c}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} style={{ transition: 'stroke-dasharray .7s cubic-bezier(.2,.9,.3,1.2)' }} />
      </svg>
      <b className="renown-level">{r?.level ?? '·'}</b>
      <span className="renown-xp tiny">XP</span>
      {waiting && <span className="dot" aria-hidden>!</span>}
      {r?.boost_until && <span className="boost" title="XP boost active"><Icon name="bolt" size={14} accent="var(--gold)" /></span>}
    </button>
  );
}
