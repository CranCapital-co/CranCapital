// A new player's head start, shown once: what they were given, what each
// part does, and why it's that size (it grows as the world does).
import { useEffect, useState } from 'react';
import { rpc } from '../lib/supabase';
import { useGame } from '../lib/store';
import { money } from '../lib/format';
import { Icon } from './Icon';
import { Modal } from './components';
import { sound } from '../audio/sound';

interface HeadStartData {
  cash: number;
  level: number;
  perk_points: number;
  crates: number;
  unlocks: { title: string; body: string; icon: string }[];
  world_worth: number;
  world_level: number;
  players: number;
}

export function HeadStart() {
  const me = useGame((s) => s.me);
  const [hs, setHs] = useState<HeadStartData | null>(null);
  useEffect(() => {
    if (!me) return;
    let alive = true;
    // Let the city appear first.
    const t = setTimeout(() => {
      rpc<HeadStartData | null>('my_head_start').then((x) => alive && x && setHs(x)).catch(() => {});
    }, 1500);
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me?.id]);
  if (!hs) return null;
  const close = () => {
    setHs(null);
    rpc('head_start_seen').catch(() => {});
  };
  return (
    <Modal title="Your head start" onClose={close}>
      <div className="stack head-start">
        <p className="small" style={{ margin: 0 }}>
          The world has been running for a while, so you don&rsquo;t start from nothing. Here&rsquo;s what you&rsquo;ve been given, and what it does.
        </p>
        <div className="hs-row">
          <Icon name="cash" size={26} accent="var(--gold)" />
          <div>
            <b>{money(hs.cash, { cents: false })} in cash</b>
            <div className="tiny muted">Spend it on businesses straight away: a shop, a restaurant or a factory, instead of saving up from a food cart. It counts towards your net worth and tier.</div>
          </div>
        </div>
        <div className="hs-row">
          <Icon name="star" size={26} accent="var(--gold)" />
          <div>
            <b>Renown level {hs.level}</b>
            <div className="tiny muted">
              Levels open up new parts of the game.
              {hs.unlocks.length > 0 && <> You&rsquo;ve already unlocked: {hs.unlocks.map((u) => u.title).join(', ')}.</>}
            </div>
          </div>
        </div>
        {hs.perk_points > 0 && (
          <div className="hs-row">
            <Icon name="sparkle" size={26} accent="var(--gold)" />
            <div>
              <b>{hs.perk_points} perk points</b>
              <div className="tiny muted">Spend them in Renown, Perks, for permanent bonuses: more income, cheaper upgrades, faster XP and more.</div>
            </div>
          </div>
        )}
        {hs.crates > 0 && (
          <div className="hs-row">
            <Icon name="crate" size={26} accent="var(--gold)" />
            <div>
              <b>{hs.crates} gold crates</b>
              <div className="tiny muted">Open them in Renown for cash, XP, income boosts and more.</div>
            </div>
          </div>
        )}
        <p className="tiny muted" style={{ margin: 0 }}>
          {hs.players > 0
            ? <>Why this much: players active this week are worth about {money(hs.world_worth, { compact: true, cents: false })} and around level {hs.world_level}. The head start grows as the world does.</>
            : <>The head start grows as the world does: the further other players get, the bigger it is.</>}
        </p>
        <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn ghost" onClick={() => { close(); useGame.getState().open('progress'); }}>Open Renown</button>
          <button className="btn gold" onClick={() => { sound.play('levelup'); close(); }}>Let&rsquo;s go</button>
        </div>
      </div>
    </Modal>
  );
}
