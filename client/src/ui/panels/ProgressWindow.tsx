// Renown: your level, rank, daily reward, crates, missions, perks,
// achievements and the free season track.
import { useEffect, useRef, useState } from 'react';
import { rpc } from '../../lib/supabase';
import { useGame, act } from '../../lib/store';
import { money, num, until, ago } from '../../lib/format';
import { sound } from '../../audio/sound';
import { reducedMotion } from '../../lib/settings';
import { Window, Tabs, Loading, Modal, useApi } from '../components';
import { Icon } from '../Icon';
import { burst } from '../Moments';
import { MEDAL, refreshRenown } from '../RenownMoments';

type Tab = 'overview' | 'missions' | 'perks' | 'achievements' | 'season';

export default function ProgressWindow({ params }: { params?: { tab?: Tab } }) {
  const [tab, setTab] = useState<Tab>(params?.tab ?? 'overview');
  const { data: r, reload } = useApi(() => rpc<any>('my_renown'), []);
  const done = () => { reload(); refreshRenown(); };
  const missionsReady = r?.missions?.filter((m: any) => !m.claimed && m.progress >= m.target).length ?? 0;
  const seasonReady = r ? Array.from({ length: Math.min(40, Math.floor(r.season.xp / 400)) }, (_, i) => i + 1).filter((t) => !r.season.claimed.includes(t)).length : 0;
  return (
    <Window title="Renown" icon="star">
      <div className="tab-sticky">
        <Tabs<Tab>
          tabs={[
            ['overview', 'Level'],
            ['missions', `Missions${missionsReady ? ` (${missionsReady})` : ''}`],
            ['perks', `Perks${r?.perk_points ? ` (${r.perk_points})` : ''}`],
            ['achievements', 'Achievements'],
            ['season', `Season${seasonReady ? ` (${seasonReady})` : ''}`],
          ]}
          value={tab}
          onChange={setTab}
        />
      </div>
      {!r ? <Loading lines={6} /> : tab === 'overview' ? <Overview r={r} done={done} /> : tab === 'missions' ? <Missions r={r} done={done} /> : tab === 'perks' ? <Perks r={r} done={done} /> : tab === 'achievements' ? <Achievements r={r} /> : <Season r={r} done={done} />}
    </Window>
  );
}

function XpBar({ into, need }: { into: number; need: number }) {
  return (
    <div className="xp-bar" role="progressbar" aria-valuemin={0} aria-valuemax={need} aria-valuenow={into}>
      <div style={{ width: `${Math.min(100, (into / Math.max(1, need)) * 100)}%` }} />
      <span className="tiny">{num(into)} / {num(need)} XP</span>
    </div>
  );
}

function Overview({ r, done }: { r: any; done: () => void }) {
  const open = useGame((s) => s.open);
  const [crate, setCrate] = useState<string | null>(null);
  const crates = Object.entries(r.crate_counts ?? {}).filter(([, v]) => Number(v) > 0) as [string, number][];
  const next = r.unlocks.filter((u: any) => !u.open).slice(0, 3);
  const s = r.streak;
  return (
    <div className="stack">
      <section className="card stack level-hero">
        <div className="row" style={{ gap: 14 }}>
          <span className="level-burst small"><b>{r.level}</b></span>
          <span className="grow stack" style={{ gap: 2 }}>
            <strong style={{ fontSize: 20 }}>{r.rank}</strong>
            <span className="small muted">{r.next_rank ? `${r.next_rank.name} at level ${r.next_rank.level}` : 'Legend ranks every 10 levels from 60'}</span>
          </span>
          {r.boost_until && <span className="chip gold"><Icon name="bolt" size={14} /> +{r.boost_pct}% XP · {until(r.boost_until)}</span>}
        </div>
        <XpBar into={r.into} need={r.need} />
        <span className="tiny muted">XP comes from everything: sales, trades, building, contracts, missions, your nation’s research, buildings and victories.</span>
      </section>

      <section className="card stack">
        <div className="row between">
          <strong className="row"><Icon name="calendar" size={18} accent="var(--gold)" /> Daily reward</strong>
          <span className="chip"><Icon name="fire" size={14} accent="var(--coral)" /> {s.streak}-day streak{s.shields ? ` · ${s.shields} shield${s.shields > 1 ? 's' : ''}` : ''}</span>
        </div>
        <div className="daily-track">
          {s.week.map((d: any) => {
            const got = d.day <= s.cycle_day;
            const today = !s.claimed_today && d.day === s.next.day;
            return (
              <div key={d.day} className={`daily-day ${got ? 'got' : ''} ${today ? 'today' : ''}`}>
                <span className="tiny muted">Day {d.day}</span>
                <Icon name={d.crate ? 'crate' : d.cash ? 'cash' : 'star'} size={22} accent={d.crate === 'gold' ? 'var(--gold)' : undefined} />
                <span className="tiny"><b>{d.xp} XP</b></span>
                {d.cash > 0 && <span className="tiny muted">{money(d.cash, { compact: true, cents: false })}</span>}
                {d.crate && <span className="tiny muted">{d.crate} crate</span>}
              </div>
            );
          })}
        </div>
        {s.claimed_today ? (
          <span className="small muted">Collected today. Come back tomorrow for day {s.next.day}. Missing a day only breaks your streak, never the reward cycle, and a shield (one per 7-day streak) covers a missed day.</span>
        ) : (
          <button className="btn gold" onClick={async () => {
            const x = await act(() => rpc<any>('claim_daily'), (v) => `Day ${v.day}: +${v.xp} XP${v.cash ? ` and ${money(v.cash, { cents: false })}` : ''}${v.crate ? `, a ${v.crate} crate` : ''}!`);
            if (x) { sound.play('chaching'); done(); }
          }}>Collect day {s.next.day}</button>
        )}
      </section>

      <section className="card stack">
        <strong className="row"><Icon name="crate" size={18} accent="var(--gold)" /> Crates</strong>
        {crates.length === 0 ? (
          <span className="small muted">You get a supply crate every level and a gold one every rank. Every 10th supply crate is gold{r.pity ? ` (${10 - r.pity} to go)` : ''}.</span>
        ) : (
          <div className="row wrap" style={{ gap: 8 }}>
            {crates.map(([k, v]) => (
              <button key={k} className={`crate-btn ${k}`} onClick={() => setCrate(k)}>
                <Icon name="crate" size={30} accent={k === 'gold' ? 'var(--gold)' : k === 'war' ? 'var(--coral)' : 'var(--brand-2)'} />
                <span><b>{v} {k} crate{v > 1 ? 's' : ''}</b><span className="tiny muted">Tap to open</span></span>
              </button>
            ))}
          </div>
        )}
        {r.tokens?.respec > 0 && <span className="tiny muted">You have {r.tokens.respec} perk respec token{r.tokens.respec > 1 ? 's' : ''}.</span>}
      </section>

      {r.perk_points > 0 && (
        <button className="card click menu-link" onClick={() => open('progress', { tab: 'perks' })}>
          <Icon name="sparkle" size={26} accent="var(--gold)" />
          <span className="grow"><strong>{r.perk_points} perk point{r.perk_points > 1 ? 's' : ''} to spend</strong><span className="small muted">Boost your sales, XP, armies or nation</span></span>
          <Icon name="next" size={18} />
        </button>
      )}

      {next.length > 0 && (
        <section className="card stack">
          <strong className="row"><Icon name="lock" size={18} accent="var(--gold)" /> Coming up</strong>
          {next.map((u: any) => (
            <div key={u.key} className="row" style={{ gap: 10 }}>
              <span className="chip tnum">Lv {u.level}</span>
              <Icon name={u.icon} size={20} />
              <span className="grow"><b>{u.title}</b> <span className="small muted">{u.body}</span></span>
            </div>
          ))}
        </section>
      )}

      {r.titles?.length > 0 && <TitlePicker titles={r.titles} current={r.title} done={done} />}

      <section className="card stack">
        <strong>Recent XP</strong>
        {r.log.length === 0 && <span className="small muted">Nothing yet. Make a sale!</span>}
        {r.log.map((l: any, i: number) => (
          <div key={i} className="row between small"><span>{l.reason}</span><span className="tnum"><b className="pos">+{l.xp}</b> <span className="tiny muted">{ago(l.at)}</span></span></div>
        ))}
      </section>
      {crate && <CrateOpen kind={crate} left={Number(r.crate_counts[crate] ?? 0)} onClose={() => { setCrate(null); done(); }} />}
    </div>
  );
}

function TitlePicker({ titles, current, done }: { titles: string[]; current: string | null; done: () => void }) {
  return (
    <section className="card stack">
      <strong className="row"><Icon name="crown" size={18} accent="var(--gold)" /> Your title</strong>
      <div className="row wrap" style={{ gap: 6 }}>
        <button className={`chip click ${!current ? 'on' : ''}`} onClick={async () => { if (await act(() => rpc('use_title', { p_title: null }))) done(); }}>None</button>
        {titles.map((t) => (
          <button key={t} className={`chip click ${current === t ? 'on' : ''}`} onClick={async () => {
            if (await act(() => rpc('use_title', { p_title: t }), `You are now known as ${t}.`)) {
              const g = useGame.getState();
              if (g.me) g.set({ me: { ...g.me, title: t } });
              done();
            }
          }}>{t}</button>
        ))}
      </div>
    </section>
  );
}

function CrateOpen({ kind, left, onClose }: { kind: string; left: number; onClose: () => void }) {
  const [prize, setPrize] = useState<any>(null);
  const [opening, setOpening] = useState(true);
  const [remaining, setRemaining] = useState(left);
  const confetti = useRef<HTMLCanvasElement>(null);
  const openOne = async () => {
    setOpening(true);
    setPrize(null);
    sound.play('whoosh');
    const [res] = await Promise.all([
      rpc<any>('open_crate', { p_kind: kind }).catch((e) => ({ error: e.message })),
      new Promise((r) => setTimeout(r, reducedMotion(useGame.getState().me?.prefs) ? 0 : 1100)),
    ]);
    setOpening(false);
    setPrize(res);
    if (!res.error) {
      setRemaining((x) => x - 1);
      sound.play(res.rare ? 'tierup' : 'chaching');
      if (!reducedMotion(useGame.getState().me?.prefs)) burst(confetti.current, res.rare ? '#e8b23a' : '#4fb58a', res.rare ? 160 : 70);
      if (res.prize === 'cash') {
        const g = useGame.getState();
        if (g.me) g.set({ me: { ...g.me, cash: g.me.cash + Number(res.amount) } });
      }
    }
  };
  useEffect(() => { openOne(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);
  return (
    <Modal onClose={onClose}>
      <canvas ref={confetti} className="confetti" aria-hidden />
      <div className="stack center crate-open">
        <span className={`crate-icon ${opening ? 'shake' : 'open'} ${prize?.rare ? 'rare' : ''}`}>
          <Icon name={opening ? 'crate' : prizeIcon(prize?.prize)} size={84} accent={kind === 'gold' || prize?.rare ? 'var(--gold)' : 'var(--brand-2)'} />
        </span>
        {opening ? (
          <h2>Opening a {kind} crate…</h2>
        ) : prize?.error ? (
          <p className="neg">{prize.error}</p>
        ) : (
          <>
            {prize.opened_as === 'gold' && kind === 'supply' && <span className="chip gold">Lucky! It was a gold crate</span>}
            <h2>{prize.label}</h2>
          </>
        )}
        <div className="row" style={{ gap: 8, justifyContent: 'center' }}>
          <button className="btn ghost" onClick={onClose}>Done</button>
          {!opening && remaining > 0 && <button className="btn gold" onClick={openOne}>Open another ({remaining})</button>}
        </div>
      </div>
    </Modal>
  );
}

const prizeIcon = (p?: string) => ({ xp: 'star', cash: 'cash', points: 'gift', boost: 'bolt', respec: 'refresh', research: 'flask', troops: 'people', funds: 'bank' } as Record<string, string>)[p ?? ''] ?? 'gift';

function Missions({ r, done }: { r: any; done: () => void }) {
  const claim = async (m: any) => {
    const x = await act(() => rpc<any>('claim_mission', { p_id: m.id }), (v) => `+${v.xp} XP${v.crate ? ' and a supply crate' : ''}!`);
    if (x) { sound.play('success'); done(); }
  };
  const list = (scope: string) => r.missions.filter((m: any) => m.scope === scope);
  const midnight = new Date();
  midnight.setUTCHours(24, 0, 0, 0);
  const monday = new Date(midnight);
  monday.setUTCDate(monday.getUTCDate() + ((8 - monday.getUTCDay()) % 7));
  return (
    <div className="stack">
      {(['daily', 'weekly'] as const).map((scope) => (
        <section key={scope} className="card stack">
          <div className="row between">
            <strong className="row"><Icon name={scope === 'daily' ? 'target' : 'calendar'} size={18} accent="var(--gold)" /> {scope === 'daily' ? 'Today' : 'This week'}</strong>
            <span className="tiny muted">New ones in {until(scope === 'daily' ? midnight : monday)}</span>
          </div>
          {list(scope).length === 0 && <span className="small muted">{scope === 'weekly' ? 'Weekly missions open at level 2.' : 'Loading…'}</span>}
          {list(scope).map((m: any) => (
            <div key={m.id} className={`mission ${m.claimed ? 'done' : ''}`}>
              <span className="grow stack" style={{ gap: 4 }}>
                <span className="row between"><b>{m.title}</b><span className="tiny muted">+{m.xp} XP{scope === 'weekly' ? ' + crate' : ''}</span></span>
                <div className="progress"><div style={{ width: `${Math.min(100, (m.progress / Math.max(1, m.target)) * 100)}%`, background: m.progress >= m.target ? 'var(--good)' : 'var(--gold)' }} /></div>
                <span className="tiny muted tnum">{num(m.progress)} / {num(m.target)}</span>
              </span>
              {m.claimed ? <span className="chip green"><Icon name="check" size={14} /></span> : <button className="btn tiny gold" disabled={m.progress < m.target} onClick={() => claim(m)}>Collect</button>}
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}

function Perks({ r, done }: { r: any; done: () => void }) {
  return (
    <div className="stack">
      <p className="small muted" style={{ margin: 0 }}>A perk point every level. Rank 1 costs 1 point, rank 2 costs 2, and so on; ranks 4 and 5 open at level 15. You have <b>{r.perk_points}</b>.</p>
      {r.perk_branches.map((b: any) => {
        const rank = Number(r.perks?.[b.id] ?? 0);
        const cost = rank + 1;
        return (
          <section key={b.id} className="card stack perk">
            <div className="row between">
              <strong className="row"><Icon name={b.icon} size={20} accent="var(--gold)" /> {b.name}</strong>
              <span className="pips">{[1, 2, 3, 4, 5].map((i) => <i key={i} className={i <= rank ? 'on' : ''} />)}</span>
            </div>
            <span className="small muted">{b.body} per rank{rank ? `: now ${rank}×` : ''}.</span>
            <button className="btn small" disabled={rank >= 5 || r.perk_points < cost} onClick={async () => {
              const x = await act(() => rpc('spend_perk', { p_branch: b.id }), `${b.name} rank ${rank + 1}!`);
              if (x) { sound.play('success'); done(); }
            }}>{rank >= 5 ? 'Maxed' : `Rank ${rank + 1} · ${cost} point${cost > 1 ? 's' : ''}`}</button>
          </section>
        );
      })}
      <button className="btn ghost small" onClick={async () => {
        const x = await act(() => rpc<any>('respec_perks'), (v) => `${v.refunded} points back.`);
        if (x) done();
      }}>Reset my perks {r.respec_free ? '(free this week)' : '(uses a respec token)'}</button>
    </div>
  );
}

function Achievements({ r }: { r: any }) {
  const [nationOnly, setNationOnly] = useState(false);
  const list = r.achievements.filter((a: any) => a.nation === nationOnly);
  return (
    <div className="stack">
      <Tabs<'biz' | 'nation'> tabs={[['biz', 'Business'], ['nation', 'Nation']]} value={nationOnly ? 'nation' : 'biz'} onChange={(v) => setNationOnly(v === 'nation')} />
      {list.map((a: any) => {
        const span = a.next != null ? Math.max(1, a.next - a.prev) : 1;
        const k = a.next != null ? Math.min(1, Math.max(0, (a.value - a.prev) / span)) : 1;
        return (
          <div key={a.id} className="achievement">
            <span className="medal" style={{ ['--accent' as any]: MEDAL[a.tier] }}><Icon name={a.icon} size={24} accent={MEDAL[a.tier]} /></span>
            <span className="grow stack" style={{ gap: 3 }}>
              <span className="row between"><b>{a.title}</b><span className="tiny muted">{a.tier ? ['', 'Bronze', 'Silver', 'Gold', 'Platinum'][a.tier] : 'Not started'}</span></span>
              {a.goal ? <span className="tiny muted">Next: {a.goal} · +{a.xp} XP{a.tier >= 2 ? ' + gold crate' : ''}</span> : <span className="tiny muted">Complete!</span>}
              <div className="progress"><div style={{ width: `${k * 100}%`, background: MEDAL[Math.min(4, a.tier + 1)] }} /></div>
            </span>
          </div>
        );
      })}
    </div>
  );
}

function Season({ r, done }: { r: any; done: () => void }) {
  const s = r.season;
  const tier = Math.min(40, Math.floor(s.xp / s.per_tier));
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector('.season-tier.current')?.scrollIntoView({ inline: 'center', block: 'nearest' });
  }, []);
  return (
    <div className="stack">
      <section className="card stack">
        <div className="row between"><strong className="row"><Icon name="trophy" size={18} accent="var(--gold)" /> Season {new Date(s.key + '-01').toLocaleString('en-GB', { month: 'long', year: 'numeric' })}</strong><span className="tiny muted">ends in {until(s.ends_at)}</span></div>
        <span className="small muted">Free for everyone: every XP you earn this month counts. {s.per_tier} XP a tier, 40 tiers, a reward at every one.</span>
        <XpBar into={s.xp - tier * s.per_tier} need={tier >= 40 ? 1 : s.per_tier} />
        <span className="small">Tier <b>{tier}</b> of 40</span>
      </section>
      <div className="season-track" ref={ref}>
        {s.rewards.map((w: any) => {
          const reached = w.tier <= tier;
          const claimed = s.claimed.includes(w.tier);
          return (
            <div key={w.tier} className={`season-tier ${reached ? 'reached' : ''} ${claimed ? 'claimed' : ''} ${w.tier === tier + 1 ? 'current' : ''} ${w.title ? 'big' : ''}`}>
              <span className="tiny muted">Tier {w.tier}</span>
              <Icon name={w.crate ? 'crate' : 'cash'} size={26} accent={w.crate === 'gold' ? 'var(--gold)' : undefined} />
              <span className="tiny"><b>{w.crate ? `${w.n > 1 ? `${w.n} ` : ''}${w.crate} crate${w.n > 1 ? 's' : ''}` : money(w.cash, { compact: true, cents: false })}</b></span>
              {w.title && <span className="tiny gold-text">“{w.title}”</span>}
              {claimed ? <Icon name="check" size={16} /> : reached ? (
                <button className="btn tiny gold" onClick={async () => {
                  const x = await act(() => rpc('claim_season', { p_tier: w.tier }), `Tier ${w.tier} collected!`);
                  if (x) { sound.play('chaching'); done(); }
                }}>Collect</button>
              ) : <Icon name="lock" size={14} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}
