// Choosing the country you'll lead: first come, first served.
import { lazy, Suspense, useMemo, useState } from 'react';
import { rpc } from '../lib/supabase';
import { useGame, cityOf } from '../lib/store';
import { money, num } from '../lib/format';
import { sound } from '../audio/sound';
import { Icon } from '../ui/Icon';
import type { Me } from '../lib/types';
import { useWorldMap, useWorldState, flag, fmtPop, fmtGdp, PERSONALITY, type Territory } from './api';
import './nations.css';

const WorldMap = lazy(() => import('./WorldMap'));

type Sort = 'power' | 'name' | 'pop';

export default function NationPicker({ onDone, onLater }: { onDone: (me: Me) => void; onLater?: () => void }) {
  const { data, error } = useWorldMap();
  const state = useWorldState(20000);
  const [sel, setSel] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [onlyFree, setOnlyFree] = useState(true);
  const [sort, setSort] = useState<Sort>('power');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const nations = useMemo(() => new Map((state?.nations ?? []).map((n) => [n.id, n])), [state]);
  const owners = useMemo(() => new Map((state?.territories ?? []).map(([id, owner]) => [id, owner])), [state]);
  const status = (t: Territory) => {
    const n = nations.get(t.id);
    if (n?.leader) return { free: false, why: `Led by ${n.leader.name}` };
    const holder = nations.get(owners.get(t.id) ?? t.id);
    if (holder && holder.id !== t.id && holder.leader) return { free: false, why: `Conquered by ${holder.name}` };
    return { free: true, why: holder && holder.id !== t.id ? `Held by ${holder.name} (AI): yours if you claim it` : 'Free' };
  };
  const list = useMemo(() => {
    if (!data) return [];
    const words = q.trim().toLowerCase();
    return data.map.territories
      .filter((t) => !words || t.name.toLowerCase().includes(words) || t.continent.toLowerCase().includes(words))
      .filter((t) => !onlyFree || status(t).free)
      .sort((a, b) =>
        sort === 'name' ? a.name.localeCompare(b.name) : sort === 'pop' ? b.pop_m - a.pop_m : (nations.get(b.id)?.power ?? 0) - (nations.get(a.id)?.power ?? 0)
      );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, q, onlyFree, sort, nations, owners]);
  const free = data ? data.map.territories.filter((t) => status(t).free).length : 0;
  const t = data?.map.territories.find((x) => x.id === sel) ?? null;
  const n = t ? nations.get(t.id) : null;
  const st = t ? status(t) : null;
  const neighbours = t && data ? data.map.links.filter((l) => l[0] === t.id || l[1] === t.id) : [];

  async function claim() {
    if (!t) return;
    setBusy(true);
    setErr(null);
    try {
      await rpc('claim_nation', { p_id: t.id });
      sound.play('tierup');
      const me = await rpc<Me>('get_me');
      onDone(me);
    } catch (e: any) {
      setErr(e.message);
      sound.play('error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="picker-screen">
      <div className="picker-map">
        {data && (
          <Suspense fallback={null}>
            <WorldMap map={data.map} shapes={data.shapes} state={state} selected={sel} onSelect={setSel} mode="picker" />
          </Suspense>
        )}
        {error && <div className="notice red picker-error">{error}</div>}
      </div>
      <aside className="picker-panel">
        <header className="stack" style={{ gap: 6 }}>
          <span className="eyebrow"><Icon name="globe" size={16} accent="var(--gold)" /> One world · every player leads a real country</span>
          <h1>Choose the country you’ll lead</h1>
          <p className="muted small" style={{ margin: 0 }}>
            First come, first served: each country has one leader. Countries without one are run by AI governments, some far shrewder than others.
            {state && <> <b>{free}</b> of {data?.map.territories.length ?? 175} are free.</>}
          </p>
        </header>

        {t ? (
          <section className="card stack picker-detail">
            <div className="row between">
              <h2 style={{ margin: 0 }}><span className="flag">{flag(t.iso2)}</span> {t.name}</h2>
              <button className="btn tiny ghost" onClick={() => setSel(null)} aria-label="Back to the list"><Icon name="close" size={16} /></button>
            </div>
            <div className="chips">
              <span className="chip">{t.continent}</span>
              <span className="chip">{t.landlocked ? 'Landlocked' : 'Coast'}</span>
              <span className="chip">{neighbours.length} neighbours</span>
              {n && <span className="chip">Power {num(n.power)}</span>}
            </div>
            <div className="grid2">
              <div className="stat"><span className="label">Population</span><span className="value">{fmtPop(t.pop_m)}</span></div>
              <div className="stat"><span className="label">Economy</span><span className="value">{fmtGdp(t.gdp_bn)}</span></div>
              <div className="stat"><span className="label">Tax income</span><span className="value">{money(t.income, { cents: false })}/h</span></div>
              <div className="stat"><span className="label">Recruits</span><span className="value">{num(t.manpower)}/h</span></div>
            </div>
            {t.home && cityOf(t.home) && (
              <div className="notice small row" style={{ gap: 8 }}>
                <Icon name="skyline" size={20} accent="var(--brand-2)" />
                <span>
                  You’ll run your businesses in <b>{cityOf(t.home)!.name}</b>
                  {cityOf(t.home)!.country === t.name ? `, ${t.name}` : ` (${cityOf(t.home)!.country}), the nearest game city to ${t.name}`}.
                </span>
              </div>
            )}
            {n && !n.leader && (
              <p className="small muted" style={{ margin: 0 }}>
                Run now by a <b>{n.skill_name}</b> AI ({PERSONALITY[n.personality]?.split(':')[0].toLowerCase()}). Claim it and it resets for you:
                a fresh treasury, a home army and barracks, and 24 hours of protection while you find your feet.
              </p>
            )}
            {st && !st.free && <div className="notice">{st.why}. Pick another country.</div>}
            {st?.free && st.why !== 'Free' && <div className="notice small">{st.why}.</div>}
            {err && <div className="notice red">{err}</div>}
            <button className="btn gold block big" disabled={busy || !st?.free} onClick={claim}>
              <Icon name="flag" size={20} accent="rgba(255,255,255,.4)" /> Lead {t.name}
            </button>
            <p className="tiny muted center" style={{ margin: 0 }}>
              Small countries grow by research, money and alliances; big ones by force. Both can rule the world.
            </p>
          </section>
        ) : (
          <>
            <div className="row" style={{ gap: 8 }}>
              <input className="input grow" placeholder="Search countries or continents" value={q} onChange={(e) => setQ(e.target.value)} />
              <select className="input" style={{ width: 'auto' }} value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sort by">
                <option value="power">Strongest</option>
                <option value="pop">Biggest</option>
                <option value="name">A to Z</option>
              </select>
            </div>
            <label className="check small">
              <input type="checkbox" checked={onlyFree} onChange={(e) => setOnlyFree(e.target.checked)} />
              <span>Only countries I can lead</span>
            </label>
            <div className="picker-list scroll">
              {!data && <div className="spinner" />}
              {list.map((x) => {
                const s = status(x);
                const nn = nations.get(x.id);
                return (
                  <button key={x.id} className={`picker-row ${s.free ? '' : 'taken'}`} onClick={() => { setSel(x.id); window.dispatchEvent(new CustomEvent('cc:worldfly', { detail: x.id })); }}>
                    <span className="flag">{flag(x.iso2)}</span>
                    <span className="grow">
                      <b>{x.name}</b>
                      <span className="tiny muted">{fmtPop(x.pop_m)} · {fmtGdp(x.gdp_bn)} · {s.free ? (nn ? `${nn.skill_name} AI` : 'AI') : s.why}</span>
                    </span>
                    <span className="swatch" style={{ background: nn?.color ?? x.color }} />
                  </button>
                );
              })}
              {data && list.length === 0 && <p className="small muted">No countries match.</p>}
            </div>
          </>
        )}
        {data && free === 0 && (
          <div className="notice">
            Every country has a leader right now. Keep building your business, and we’ll offer you a country as soon as one is free.
            {onLater && <button className="btn small" style={{ marginTop: 8 }} onClick={onLater}>Play the business game</button>}
          </div>
        )}
      </aside>
    </div>
  );
}

export function useNeedsNation(me: Me | null) {
  return !!me && !me.nation;
}

export const pickerKey = 'cc_nation_later';
export function nationLater() {
  try {
    return sessionStorage.getItem(pickerKey) === '1';
  } catch {
    return false;
  }
}
export function setNationLater() {
  try {
    sessionStorage.setItem(pickerKey, '1');
  } catch {
    /* ignore */
  }
  useGame.getState().bump();
}
