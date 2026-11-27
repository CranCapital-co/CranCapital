// The tabs of the nation screen: your nation, military, research,
// diplomacy and the world.
import { useEffect, useMemo, useState } from 'react';
import { rpc } from '../lib/supabase';
import { act, useGame } from '../lib/store';
import { money, num, until, ago } from '../lib/format';
import { sound } from '../audio/sound';
import { Icon } from '../ui/Icon';
import { Confirm, useApi, Loading } from '../ui/components';
import { refreshMe } from '../ui/common';
import { flag, untilLong, refreshFleets, type WorldMapData, type WorldState, type UnitType, type Upgrades, type UpgradeTrack } from './api';
import type { TroopMap } from './WorldMap';

export interface MyNation {
  nation: null | {
    id: string; name: string; color: string; treasury: number; manpower: number; research_bank: number;
    researching: string | null; research_progress: number; stability: number; exhaustion: number;
    tax: 'low' | 'normal' | 'high'; research_pct: number; infra_pct: number; protected_until: string | null;
    power: number; share: number; leader_since: string; status: string;
  };
  free?: number;
  income: Record<string, number>;
  level: number;
  territories: {
    id: string; name: string; owned: boolean; held: boolean; owner: string; controller: string; landlocked: boolean;
    development: number; damage: number; militia: number; defence: number;
    garrison: Record<string, number>;
    allies: { nation: string; unit: string; qty: number }[];
    buildings: { kind: string; level: number; target: number | null; ready_at: string | null }[];
    queue: { id: number; unit: string; qty: number; ready_at: string }[];
    neighbours: { id: string; kind: 'land' | 'sea'; km: number; controller: string }[];
  }[];
  armies: { id: number; from: string; to: string; units: Record<string, number>; kind: string; depart_at: string; arrive_at: string }[];
  incoming: { id: number; nation: string; from: string; to: string; kind: string; arrive_at: string; size: number }[];
  techs: { id: string; done: boolean; available: boolean; paid?: boolean }[];
  unlocks: Record<string, number>;
  wars: { id: number; name: string; side: 'att' | 'def'; leader: boolean; enemy_leader: string; score: number; started_at: string; allies: string[] | null; enemies: string[] | null; wins: number; losses: number }[];
  alliance: { id: number; name: string; color: string; founder: string; members: string[] } | null;
  offers: { id: number; kind: string; from: string; to: string; war: number | null; terms: any; incoming: boolean; created_at: string; expires_at: string }[];
  relations: { nation: string; score: number; they_denounced: boolean; we_denounced: boolean }[];
  treaties: { kind: string; nation: string; until: string }[];
  battles: { id: number; at: string; territory: string; attacker: string; defender: string; kind: string; winner: string; captured: boolean; summary: string; att_lost: Record<string, number>; def_lost: Record<string, number>; att_power: number; def_power: number }[];
}

export interface Ctx {
  my: MyNation;
  map: WorldMapData;
  world: WorldState | null;
  reload: () => void;
  name: (id: string) => string;
  select: (id: string) => void;
  sendFrom: (from: string, to?: string) => void;
  troops?: TroopMap | null;
}

const Bar = ({ value, max = 100, tone }: { value: number; max?: number; tone?: string }) => (
  <div className="progress"><div style={{ width: `${Math.max(0, Math.min(100, (value / max) * 100))}%`, background: tone ?? 'var(--gold)' }} /></div>
);

export function UnitChips({ units, types }: { units: Record<string, number>; types: UnitType[] }) {
  const list = Object.entries(units).filter(([, v]) => v > 0);
  if (!list.length) return <span className="tiny muted">No troops</span>;
  return (
    <span className="unit-chips">
      {list.map(([k, v]) => {
        const u = types.find((t) => t.id === k);
        return (
          <span key={k} className="unit-chip" title={u?.name}>
            <Icon name={u?.icon ?? 'people'} size={16} /> {num(v)}
          </span>
        );
      })}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Your nation
// ---------------------------------------------------------------------------
export function OverviewTab({ my, reload, name }: Ctx) {
  const n = my.nation!;
  const me = useGame((s) => s.me)!;
  const [tax, setTax] = useState(n.tax);
  const [rp, setRp] = useState(n.research_pct);
  const [ip, setIp] = useState(n.infra_pct);
  const [step, setStep] = useState(false);
  useEffect(() => { setTax(n.tax); setRp(n.research_pct); setIp(n.infra_pct); }, [n.tax, n.research_pct, n.infra_pct]);
  const dirty = tax !== n.tax || rp !== n.research_pct || ip !== n.infra_pct;
  const inc = my.income;
  const line = (label: string, v: number, sign = 1) => (
    <div className="row between small"><span className="muted">{label}</span><b className={sign < 0 ? 'neg' : ''}>{sign < 0 && v > 0 ? '−' : ''}{money(v, { cents: false })}</b></div>
  );
  // A player-led country runs on its leader's money: taxes are paid to you,
  // upkeep and everything military comes out of your cash.
  const pay = inc.gross - inc.research - inc.infrastructure;
  const upkeep = inc.upkeep_units + inc.upkeep_buildings;
  const net = pay - upkeep;
  return (
    <div className="stack">
      {n.protected_until && (
        <div className="notice green small"><Icon name="shield" size={18} /> New-leader protection: nobody can declare war on you for {until(n.protected_until)}. Declaring war yourself ends it.</div>
      )}
      {my.incoming.length > 0 && (
        <section className="card stack danger-card">
          <strong className="row"><Icon name="warn" size={20} accent="var(--coral)" /> Under attack</strong>
          {my.incoming.map((m) => (
            <div key={m.id} className="row between small">
              <span>{name(m.nation)}: about {num(m.size)} units → <b>{name(m.to)}</b></span>
              <span className="chip red tnum">{until(m.arrive_at)}</span>
            </div>
          ))}
        </section>
      )}
      <div className="grid2">
        <div className="stat"><span className="label">Your money</span><span className="value">{money(me.cash, { cents: false })}</span><span className="tiny muted">{net >= 0 ? '+' : '−'}{money(Math.abs(net), { cents: false })} an hour from {n.name}</span></div>
        <div className="stat"><span className="label">Power</span><span className="value">{num(n.power)}</span><span className="tiny muted">{n.share}% of the world</span></div>
        <div className="stat"><span className="label">Manpower</span><span className="value">{num(n.manpower)}</span><span className="tiny muted">+{num(inc.manpower)} an hour</span></div>
        <div className="stat"><span className="label">Research</span><span className="value">{num(inc.rp, 1)}/h</span><span className="tiny muted">{num(n.research_bank)} banked</span></div>
      </div>
      <section className="card stack">
        <div className="row between"><strong>Stability</strong><span className="tnum">{Math.round(n.stability)} → {Math.round(inc.stability_target)}</span></div>
        <Bar value={n.stability} tone={n.stability < 35 ? 'var(--bad)' : n.stability < 55 ? 'var(--gold)' : 'var(--good)'} />
        <p className="tiny muted" style={{ margin: 0 }}>Stability raises income and recruits. High taxes, wars, exhaustion and lost land lower it; peace, alliances and low taxes raise it. Below 35, land you occupy can rise up.</p>
        <div className="row between"><strong>War exhaustion</strong><span className="tnum">{Math.round(n.exhaustion)}</span></div>
        <Bar value={n.exhaustion} tone="var(--coral)" />
      </section>
      <section className="card stack">
        <strong className="row"><Icon name="chart" size={18} accent="var(--gold)" /> An hour in {n.name}</strong>
        {line('Taxes from your land', inc.territory)}
        {inc.occupied > 0 && line('From occupied land', inc.occupied)}
        {line('Research budget', inc.research, -1)}
        {line('Infrastructure', inc.infrastructure, -1)}
        {line('Army upkeep', inc.upkeep_units, -1)}
        {line('Buildings upkeep', inc.upkeep_buildings, -1)}
        <div className="row between"><b>Paid to you</b><b className={net < 0 ? 'neg' : 'pos'}>{net < 0 ? '−' : '+'}{money(Math.abs(net), { cents: false })}</b></div>
        <p className="tiny muted" style={{ margin: 0 }}>Your country runs on your money: taxes are paid to you every minute, and recruits, bases, research and upkeep come out of your cash.</p>
        {inc.wars > 0 && <p className="tiny muted" style={{ margin: 0 }}>Each war costs 5% of income (blockades and disruption).</p>}
      </section>
      <section className="card stack">
        <strong>Policy</strong>
        <div className="seg" role="radiogroup" aria-label="Tax rate">
          {(['low', 'normal', 'high'] as const).map((k) => (
            <button key={k} className={tax === k ? 'on' : ''} aria-pressed={tax === k} onClick={() => setTax(k)}>
              {k === 'low' ? 'Low tax' : k === 'high' ? 'High tax' : 'Normal'}
              <span className="tiny muted">{k === 'low' ? '−15% income, +10 stability' : k === 'high' ? '+20% income, −15 stability' : 'Balanced'}</span>
            </button>
          ))}
        </div>
        <label className="field">
          <span>Research budget: {rp}% of income</span>
          <input type="range" min={0} max={60} value={rp} onChange={(e) => setRp(Number(e.target.value))} />
        </label>
        <label className="field">
          <span>Infrastructure: {ip}% of income (raises income over time)</span>
          <input type="range" min={0} max={40} value={ip} onChange={(e) => setIp(Number(e.target.value))} />
        </label>
        <button className="btn" disabled={!dirty} onClick={async () => {
          const r = await act(() => rpc('nation_policy', { p_tax: tax, p_research_pct: rp, p_infra_pct: ip }), 'Policy updated.');
          if (r) reload();
        }}>Save policy</button>
      </section>
      <button className="link small" onClick={() => setStep(true)}>Step down as leader…</button>
      {step && (
        <Confirm
          title={`Step down in ${n.name}?`}
          body="The AI takes over at once. You can lead a country again in 12 hours, and you keep your Renown and businesses."
          confirm="Step down"
          danger
          onCancel={() => setStep(false)}
          onConfirm={async () => {
            const r = await act(() => rpc('abdicate'), 'You stepped down.');
            setStep(false);
            if (r) {
              const fresh = await rpc('get_me');
              useGame.getState().set({ me: fresh });
            }
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Military
// ---------------------------------------------------------------------------
export function MilitaryTab({ my, map, reload, name, sendFrom, select }: Ctx) {
  const done = new Set(my.techs.filter((t) => t.done).map((t) => t.id));
  // Every unit you have, wherever it is.
  const totals: Record<string, number> = {};
  for (const t of my.territories) for (const [k, v] of Object.entries(t.garrison)) totals[k] = (totals[k] ?? 0) + v;
  const moving: Record<string, number> = {};
  for (const a of my.armies) for (const [k, v] of Object.entries(a.units)) moving[k] = (moving[k] ?? 0) + Number(v);
  const stationed = my.territories.filter((t) => Object.values(t.garrison).some((v) => v > 0));
  const now = Date.now();
  return (
    <div className="stack">
      <section className="card stack">
        <strong className="row"><Icon name="flag" size={18} accent="var(--gold)" /> Your forces</strong>
        <div className="row between small"><span className="muted">Stationed</span><UnitChips units={totals} types={map.units} /></div>
        {Object.keys(moving).length > 0 && <div className="row between small"><span className="muted">On the move</span><UnitChips units={moving} types={map.units} /></div>}
        {stationed.map((t) => (
          <button key={t.id} className="rel-row" onClick={() => select(t.id)}>
            <span className="grow"><b>{t.name}</b>{!t.owned && t.held && <span className="chip red tiny">occupied</span>}</span>
            <span className="tnum small">{num(Object.values(t.garrison).reduce((a, b) => a + b, 0))} units · defence {num(t.defence)}</span>
          </button>
        ))}
        <p className="tiny muted" style={{ margin: 0 }}>Gold numbers on the map are your troops, blue your allies’, red the enemy’s (estimated). Zoom in on the sea to see your warships.</p>
      </section>
      <UpgradesCard nation={my.nation?.id ?? null} map={map} />
      {my.armies.length > 0 && (
        <section className="card stack">
          <strong className="row"><Icon name="truck" size={18} accent="var(--gold)" /> On the move</strong>
          {my.armies.map((a) => {
            const k = Math.max(0, Math.min(1, (now - new Date(a.depart_at).getTime()) / Math.max(1, new Date(a.arrive_at).getTime() - new Date(a.depart_at).getTime())));
            return (
              <button key={a.id} className="stack army-row" onClick={() => select(a.to)}>
                <span className="row between small">
                  <span>{name(a.from)} → <b>{name(a.to)}</b> <span className={`chip ${a.kind === 'move' ? '' : 'red'}`}>{a.kind === 'move' ? 'moving' : a.kind}</span></span>
                  <span className="tnum">{until(a.arrive_at)}</span>
                </span>
                <Bar value={k * 100} tone={a.kind === 'move' ? 'var(--sky)' : 'var(--coral)'} />
                <UnitChips units={a.units} types={map.units} />
              </button>
            );
          })}
        </section>
      )}
      {my.territories.map((t) => (
        <TerritoryCard key={t.id} t={t} my={my} map={map} done={done} reload={reload} name={name} sendFrom={sendFrom} select={select} />
      ))}
    </div>
  );
}

// Military upgrades: missiles (range, warheads, guidance) and troopships.
// Bought once for your country, from your own cash.
function UpgradesCard({ nation, map }: { nation: string | null; map: WorldMapData }) {
  const cash = useGame((s) => s.me?.cash ?? 0);
  const { data, reload } = useApi(() => rpc<Upgrades>('military_upgrades'), [nation]);
  const [ask, setAsk] = useState<UpgradeTrack | null>(null);
  if (!data) return <section className="card"><Loading lines={3} /></section>;
  const buy = async (t: UpgradeTrack) => {
    const r = await act(() => rpc<Upgrades>('military_upgrade', { p_track: t.id }), `${t.name} level ${t.level + 1}: ${t.next}.`);
    if (r) {
      sound.play('tierup');
      reload();
      refreshMe();
      refreshFleets();
    }
  };
  const group = (title: string, icon: string, ids: string[]) => (
    <div className="stack" style={{ gap: 8 }}>
      <span className="row small"><Icon name={icon} size={16} accent="var(--gold)" /> <b>{title}</b></span>
      {data.tracks.filter((t) => ids.includes(t.id)).map((t) => {
        const maxed = t.level >= t.max;
        const tech = map.techs.find((x) => x.id === t.tech)?.name;
        return (
          <div key={t.id} className="upgrade-row">
            <Icon name={t.icon} size={22} accent={t.level ? 'var(--gold)' : undefined} />
            <div className="grow stack" style={{ gap: 2 }}>
              <span className="row between small">
                <b>{t.name}</b>
                <span className="pips" aria-label={`Level ${t.level} of ${t.max}`}>
                  {Array.from({ length: t.max }, (_, i) => <i key={i} className={i < t.level ? 'on' : ''} />)}
                </span>
              </span>
              <span className="tiny muted">{t.body}</span>
              <span className="tiny">{t.now}{t.next && <> → <b>{t.next}</b></>}</span>
              {!t.ready && !maxed && <span className="tiny muted"><Icon name="lock" size={12} /> Research {tech ?? 'it'} first.</span>}
            </div>
            {maxed ? (
              <span className="chip gold tiny">Max</span>
            ) : !t.ready ? (
              <span className="chip tiny" aria-label="Locked"><Icon name="lock" size={14} /></span>
            ) : (
              <button className="btn small gold" disabled={cash < (t.price ?? 0)} onClick={() => ((t.price ?? 0) >= 100_000_000 ? setAsk(t) : buy(t))}>
                {money(t.price, { compact: true, cents: false })}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
  return (
    <section className="card stack">
      <strong className="row"><Icon name="sparkle" size={18} accent="var(--gold)" /> Upgrades</strong>
      {group('Missiles', 'rocket', ['missile_range', 'missile_warhead', 'missile_guidance'])}
      {group('Navy', 'ship', ['troopships'])}
      <p className="tiny muted" style={{ margin: 0 }}>
        Missiles move like troops between territories you hold; launch them from a silo. Troopships sail troops coast to coast:
        infantry take one place, artillery two, armour three, missiles five.
      </p>
      {ask && (
        <Confirm
          title={`${ask.name} level ${ask.level + 1}?`}
          body={<>It costs <b>{money(ask.price, { cents: false })}</b> of your money. {ask.next}.</>}
          confirm="Upgrade"
          onCancel={() => setAsk(null)}
          onConfirm={async () => { const t = ask; setAsk(null); await buy(t); }}
        />
      )}
    </section>
  );
}

function TerritoryCard({ t, my, map, done, reload, name, sendFrom, select }: { t: MyNation['territories'][0]; my: MyNation; map: WorldMapData; done: Set<string>; reload: () => void; name: (id: string) => string; sendFrom: (f: string) => void; select: (id: string) => void }) {
  const n = my.nation!;
  const cash = useGame((s) => s.me?.cash ?? 0);
  const terr = map.territories.find((x) => x.id === t.id);
  const canBuild = t.owned && t.held;
  const blevel = (k: string) => t.buildings.find((b) => b.kind === k)?.level ?? 0;
  const why = (unlock: string, tech: string | null, building?: string) => {
    if ((my.unlocks[unlock] ?? 1) > my.level) return `Renown level ${my.unlocks[unlock]}`;
    if (tech && !done.has(tech)) return `Research ${map.techs.find((x) => x.id === tech)?.name}`;
    if (building && blevel(building) < 1) return `Needs a ${map.buildings.find((b) => b.id === building)?.name.toLowerCase()}`;
    return null;
  };
  const units = map.units.filter((u) => u.id !== 'naval' || !t.landlocked);
  const [unit, setUnit] = useState('infantry');
  const u = map.units.find((x) => x.id === unit)!;
  const maxQ = 20 * Math.max(1, blevel(u.building));
  const [qty, setQty] = useState(10);
  const q = Math.min(qty, maxQ);
  const lock = why(u.unlock, u.tech, u.building);
  const cost = u.cost * q;
  const troops = Object.values(t.garrison).reduce((a, b) => a + b, 0);
  return (
    <section className="card stack terr-card">
      <div className="row between">
        <button className="link-plain row" onClick={() => select(t.id)}>
          <span className="flag">{flag(terr?.iso2)}</span>
          <strong>{t.name}</strong>
        </button>
        <span className="row" style={{ gap: 6 }}>
          {t.id === n.id && <span className="chip gold">Homeland</span>}
          {t.owned && t.id !== n.id && <span className="chip">Annexed</span>}
          {!t.owned && t.held && <span className="chip red">Occupied from {name(t.owner)}</span>}
          {t.owned && !t.held && <span className="chip red">Held by {name(t.controller)}</span>}
          {!t.owned && !t.held && <span className="chip">Stationed with {name(t.controller)}</span>}
        </span>
      </div>
      <div className="row between small">
        <UnitChips units={t.garrison} types={map.units} />
        <span className="muted tnum" title="Defence strength against an attack, with militia and forts">
          <Icon name="shield" size={15} /> {num(t.defence)}
        </span>
      </div>
      {t.allies.length > 0 && <div className="tiny muted">Allied troops here: {t.allies.map((a) => `${name(a.nation)} ${a.qty} ${a.unit}`).join(', ')}</div>}
      {troops > 0 && (
        <button className="btn small" onClick={() => sendFrom(t.id)}><Icon name="swords" size={16} /> Send troops from here</button>
      )}
      {canBuild && (
        <>
          <div className="build-row">
            {map.buildings.filter((b) => !b.coastal || !t.landlocked).map((b) => {
              const cur = t.buildings.find((x) => x.kind === b.id);
              const lvl = cur?.level ?? 0;
              const busy = cur?.target != null;
              const blk = why(b.unlock, b.tech);
              const c = b.cost * (lvl + 1) * (lvl + 1);
              return (
                <button
                  key={b.id}
                  className={`build-tile ${lvl ? 'has' : ''}`}
                  disabled={!!blk || busy || lvl >= b.max_level || cash < c}
                  title={`${b.name}: ${b.body}${blk ? ` (${blk})` : ''}`}
                  onClick={async () => {
                    const r = await act(() => rpc('nation_build', { p_territory: t.id, p_kind: b.id }), `${b.name} level ${lvl + 1} started.`);
                    if (r) { sound.play('success'); reload(); refreshMe(); }
                  }}
                >
                  <Icon name={b.icon} size={22} accent={lvl ? 'var(--gold)' : undefined} />
                  <span className="tiny"><b>{b.name}</b></span>
                  <span className="tiny muted">
                    {busy ? `→ ${cur!.target} in ${until(cur!.ready_at)}` : blk ? blk : lvl >= b.max_level ? `Level ${lvl} (max)` : `${lvl ? `Lv ${lvl} → ${lvl + 1}` : 'Build'} · ${money(c, { compact: true, cents: false })}`}
                  </span>
                </button>
              );
            })}
          </div>
          <div className="recruit stack">
            <div className="unit-pick">
              {units.map((x) => {
                const blk = why(x.unlock, x.tech, x.building);
                return (
                  <button key={x.id} className={`unit-btn ${unit === x.id ? 'on' : ''} ${blk ? 'locked' : ''}`} onClick={() => setUnit(x.id)} title={blk ?? `${x.name}: attack ${x.atk}, defence ${x.def}`}>
                    <Icon name={blk ? 'lock' : x.icon} size={20} />
                    <span className="tiny">{x.name}</span>
                  </button>
                );
              })}
            </div>
            {lock ? (
              <p className="small muted" style={{ margin: 0 }}><Icon name="lock" size={14} /> {u.name}: {lock}.</p>
            ) : (
              <>
                <div className="row between small">
                  <span>{u.name}: attack {u.atk}, defence {u.def}, upkeep {money(u.upkeep)}/h</span>
                  <span className="tnum">{q} × {money(u.cost, { cents: false })}</span>
                </div>
                <div className="row" style={{ gap: 10 }}>
                  <input className="grow" type="range" min={1} max={maxQ} value={q} onChange={(e) => setQty(Number(e.target.value))} aria-label="How many" />
                  <button
                    className="btn small gold"
                    disabled={cash < cost || n.manpower < u.manpower * q}
                    onClick={async () => {
                      const r = await act(() => rpc('nation_recruit', { p_territory: t.id, p_unit: unit, p_qty: q }), `Training ${q} ${u.plural}.`);
                      if (r) { sound.play('success'); reload(); refreshMe(); }
                    }}
                  >
                    Recruit {q} · {money(cost, { compact: true, cents: false })}
                  </button>
                </div>
                {n.manpower < u.manpower * q && <p className="tiny neg" style={{ margin: 0 }}>Needs {num(u.manpower * q)} manpower.</p>}
              </>
            )}
            {t.queue.length > 0 && (
              <div className="tiny muted">
                Training: {t.queue.map((x) => `${x.qty} ${map.units.find((y) => y.id === x.unit)?.plural} (${until(x.ready_at)})`).join(' · ')}
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Research
// ---------------------------------------------------------------------------
const BRANCHES: [string, string, string][] = [
  ['land', 'Land warfare', 'tank'], ['air', 'Air power', 'plane'], ['sea', 'Navy', 'ship'],
  ['defence', 'Defence', 'shield'], ['strategy', 'Strategy', 'rocket'], ['economy', 'Economy', 'chart'],
];
export function ResearchTab({ my, map, reload }: Ctx) {
  const n = my.nation!;
  const cash = useGame((s) => s.me?.cash ?? 0);
  const status = new Map(my.techs.map((t) => [t.id, t]));
  const cur = map.techs.find((t) => t.id === n.researching);
  const rph = my.income.rp || 1;
  const locked = (my.unlocks.research ?? 3) > my.level;
  return (
    <div className="stack">
      {locked && <div className="notice small"><Icon name="lock" size={16} /> Research opens at Renown level {my.unlocks.research}. Your scientists bank research until then.</div>}
      <section className="card stack">
        {cur ? (
          <>
            <div className="row between"><strong className="row"><Icon name="flask" size={18} accent="var(--gold)" /> {cur.name}</strong><span className="tnum small">{num(n.research_progress)} / {num(cur.cost)}</span></div>
            <Bar value={n.research_progress} max={cur.cost} />
            <span className="tiny muted">{num(rph, 1)} research an hour · about {fmtHours(Math.max(0, cur.cost - n.research_progress - n.research_bank) / rph)} to go</span>
          </>
        ) : (
          <span className="small muted">Pick something to research. Research builds up in the bank meanwhile ({num(n.research_bank)} so far).</span>
        )}
      </section>
      {BRANCHES.map(([b, label, icon]) => (
        <section key={b} className="stack" style={{ gap: 8 }}>
          <h4 className="row" style={{ margin: '6px 0 0' }}><Icon name={icon} size={18} /> {label}</h4>
          {map.techs.filter((t) => t.branch === b).map((t) => {
            const s = status.get(t.id);
            const active = n.researching === t.id;
            return (
              <div key={t.id} className={`tech ${s?.done ? 'done' : s?.available ? 'avail' : 'locked'} ${active ? 'active' : ''}`}>
                <span className="grow">
                  <b>{t.name}</b>
                  <span className="small muted">{t.body}</span>
                  {!s?.done && !s?.available && <span className="tiny muted">Needs {t.requires.map((r) => map.techs.find((x) => x.id === r)?.name).join(' and ')}</span>}
                </span>
                {s?.done ? (
                  <span className="chip green"><Icon name="check" size={14} /> Done</span>
                ) : active ? (
                  <span className="chip gold">Researching</span>
                ) : (
                  <button className="btn tiny" disabled={!s?.available || locked || (!s?.paid && cash < t.cost * 20000)} onClick={async () => {
                    const r = await act(() => rpc<any>('nation_research', { p_tech: t.id }), (x) => `Researching ${t.name}${x.paid ? ` for ${money(x.paid, { cents: false })}` : ''}.`);
                    if (r) { reload(); refreshMe(); }
                  }}>{s?.paid ? 'Resume' : money(t.cost * 20000, { compact: true, cents: false })} · {fmtHours(t.cost / rph)}</button>
                )}
              </div>
            );
          })}
        </section>
      ))}
    </div>
  );
}

export function fmtHours(h: number) {
  if (!isFinite(h)) return '—';
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min`;
  if (h < 48) return `${h.toFixed(h < 10 ? 1 : 0)} h`;
  return `${Math.round(h / 24)} days`;
}

// ---------------------------------------------------------------------------
// Diplomacy
// ---------------------------------------------------------------------------
export function DiplomacyTab({ my, world, reload, name, select }: Ctx) {
  const n = my.nation!;
  const [allianceName, setAllianceName] = useState(`${n.name} Accord`);
  const [repAmount, setRepAmount] = useState(20000);
  const offers = my.offers.filter((o) => o.incoming);
  const sent = my.offers.filter((o) => !o.incoming);
  const peace = async (war: number, terms: string, amount = 0) => {
    const r = await act(() => rpc<any>('propose_peace', { p_war: war, p_terms: terms, p_amount: amount }),
      (x) => (x.status === 'accepted' ? 'Peace!' : x.status === 'declined' ? 'They turned it down.' : 'Offer sent. They have 12 hours to answer.'));
    if (r) { sound.play(r.status === 'accepted' ? 'tierup' : 'success'); reload(); }
  };
  return (
    <div className="stack">
      {offers.length > 0 && (
        <section className="card stack">
          <strong className="row"><Icon name="mail" size={18} accent="var(--gold)" /> Offers for you</strong>
          {offers.map((o) => (
            <div key={o.id} className="row between">
              <span className="small">
                <b>{name(o.from)}</b>{' '}
                {o.kind === 'alliance' ? 'invites you to their alliance' : o.kind === 'nap' ? 'proposes a 48-hour non-aggression pact' : peaceText(o.terms, o.from, name)}
              </span>
              <span className="row" style={{ gap: 6 }}>
                <button className="btn tiny ghost" onClick={async () => { if (await act(() => rpc('respond_offer', { p_id: o.id, p_accept: false }))) reload(); }}>No</button>
                <button className="btn tiny gold" onClick={async () => { if (await act(() => rpc('respond_offer', { p_id: o.id, p_accept: true }), 'Accepted.')) { sound.play('success'); reload(); } }}>Accept</button>
              </span>
            </div>
          ))}
        </section>
      )}
      {my.wars.map((w) => (
        <section key={w.id} className="card stack war-card">
          <div className="row between"><strong className="row"><Icon name="swords" size={18} accent="var(--coral)" /> {w.name}</strong><span className="tiny muted">{ago(w.started_at)}</span></div>
          <div className="war-score">
            <div className="war-score-bar"><span style={{ left: `${50 + w.score / 2}%` }} /></div>
            <div className="row between tiny muted"><span>Losing</span><b className={w.score >= 0 ? 'pos' : 'neg'}>War score {w.score > 0 ? '+' : ''}{w.score}</b><span>Winning</span></div>
          </div>
          <div className="small">Against: {(w.enemies ?? []).map((x) => <button key={x} className="link" onClick={() => select(x)}>{name(x)}</button>).reduce((a: any[], b, i) => (i ? [...a, ', ', b] : [b]), [])}</div>
          <Invasion war={w} my={my} world={world} name={name} select={select} />
          {(w.allies ?? []).length > 0 && <div className="small muted">With you: {(w.allies ?? []).map(name).join(', ')}</div>}
          <div className="tiny muted">Battles won {w.wins} · lost {w.losses}</div>
          {w.leader ? (
            <div className="row wrap" style={{ gap: 6 }}>
              <button className="btn tiny" onClick={() => peace(w.id, 'white')}><Icon name="dove" size={14} /> White peace</button>
              <button className="btn tiny" onClick={() => peace(w.id, 'annex')}>Demand the land we hold</button>
              <span className="row" style={{ gap: 4 }}>
                <button className="btn tiny" onClick={() => peace(w.id, 'reparations', repAmount * 1000)}>Demand {money(repAmount * 1000, { compact: true, cents: false })}</button>
                <input className="input tiny-input" type="number" min={1000} step={1000} value={repAmount} onChange={(e) => setRepAmount(Math.max(1000, Number(e.target.value)))} aria-label="Reparations in dollars" />
              </span>
              <SurrenderButton onYes={() => peace(w.id, 'surrender')} />
            </div>
          ) : (
            <p className="tiny muted" style={{ margin: 0 }}>Only the nations leading each side can make peace. You’re in this war as an ally.</p>
          )}
        </section>
      ))}
      <section className="card stack">
        <strong className="row"><Icon name="handshake" size={18} accent="var(--gold)" /> Alliance</strong>
        {my.alliance ? (
          <>
            <div className="row between"><b>{my.alliance.name}</b><span className="chip">{my.alliance.members.length} of 6</span></div>
            <div className="row wrap" style={{ gap: 6 }}>{my.alliance.members.map((m) => <button key={m} className="chip click" onClick={() => select(m)}>{name(m)}</button>)}</div>
            <p className="tiny muted" style={{ margin: 0 }}>Members defend each other: attack one and the others join the war. Invite a nation from its card on the map.</p>
            <button className="btn tiny ghost" onClick={async () => { if (await act(() => rpc('alliance_leave'), 'You left the alliance.')) reload(); }}>Leave alliance</button>
          </>
        ) : (my.unlocks.alliance ?? 6) > my.level ? (
          <p className="small muted" style={{ margin: 0 }}><Icon name="lock" size={14} /> Alliances open at Renown level {my.unlocks.alliance}.</p>
        ) : (
          <div className="row" style={{ gap: 8 }}>
            <input className="input grow" value={allianceName} maxLength={30} onChange={(e) => setAllianceName(e.target.value)} aria-label="Alliance name" />
            <button className="btn small" onClick={async () => { if (await act(() => rpc('alliance_create', { p_name: allianceName }), 'Alliance founded.')) { sound.play('success'); reload(); } }}>Found</button>
          </div>
        )}
      </section>
      {sent.length > 0 && (
        <section className="card stack">
          <strong>Waiting for an answer</strong>
          {sent.map((o) => <div key={o.id} className="small">{o.kind === 'peace' ? 'Peace offer' : o.kind === 'nap' ? 'Pact offer' : 'Alliance invite'} to {name(o.to)} · expires in {until(o.expires_at)}</div>)}
        </section>
      )}
      <section className="card stack">
        <strong className="row"><Icon name="people" size={18} accent="var(--gold)" /> Relations</strong>
        {my.relations.length === 0 && <p className="small muted" style={{ margin: 0 }}>No one has an opinion of you yet. Send envoys to make friends, or denounce rivals.</p>}
        {my.relations.map((r) => (
          <button key={r.nation} className="rel-row" onClick={() => select(r.nation)}>
            <span className="grow">
              <b>{name(r.nation)}</b>
              {r.they_denounced && <span className="chip red tiny">denounced you</span>}
              {r.we_denounced && <span className="chip tiny">rival</span>}
              {my.treaties.filter((t) => t.nation === r.nation).map((t) => <span key={t.kind} className="chip green tiny">{t.kind === 'nap' ? 'pact' : 'truce'} {until(t.until)}</span>)}
            </span>
            <span className={`tnum ${r.score < 0 ? 'neg' : 'pos'}`}>{r.score > 0 ? '+' : ''}{r.score}</span>
          </button>
        ))}
      </section>
      {world && <p className="tiny muted center">{world.wars.length} wars and {world.alliances.length} alliances in the world right now.</p>}
    </div>
  );
}

function peaceText(terms: any, from: string, name: (id: string) => string) {
  switch (terms?.terms) {
    case 'white': return 'proposes a white peace: everyone goes home';
    case 'annex': return `proposes peace: ${name(from)} keeps the land it holds`;
    case 'reparations': return `proposes peace if you pay ${money(terms.amount, { cents: false })}`;
    default: return 'proposes peace';
  }
}

function SurrenderButton({ onYes }: { onYes: () => void }) {
  const [ask, setAsk] = useState(false);
  return (
    <>
      <button className="btn tiny danger" onClick={() => setAsk(true)}>Surrender</button>
      {ask && (
        <Confirm title="Surrender?" body="The enemy keeps all the land it occupies and takes a quarter of your money. The war ends at once." confirm="Surrender" danger onCancel={() => setAsk(false)} onConfirm={() => { setAsk(false); onYes(); }} />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// The world
// ---------------------------------------------------------------------------
export function WorldTab({ my, world, name, select }: Ctx) {
  const { data: ranks } = useApi(() => rpc<any>('world_rankings'), [], 60000);
  const { data: news } = useApi(() => rpc<any[]>('world_news', { p_limit: 40 }), [], 20000);
  const top = useMemo(() => [...(world?.nations ?? [])].filter((n) => n.status === 'active').sort((a, b) => b.share - a.share)[0], [world]);
  const myRank = ranks?.powers?.findIndex((p: any) => p.id === my.nation?.id);
  return (
    <div className="stack">
      <section className="card stack">
        <strong className="row"><Icon name="crown" size={18} accent="var(--gold)" /> Balance of power</strong>
        {top && (
          <>
            <div className="small">Biggest power: <button className="link" onClick={() => select(top.id)}>{top.name}</button>, holding {top.share}% of the world.</div>
            <Bar value={top.share} max={100} tone="var(--coral)" />
          </>
        )}
        {(world?.coalitions ?? []).map((c) => (
          <div key={c.id} className={`small coalition-row ${c.target === my.nation?.id ? 'against-me' : ''}`}>
            <Icon name="swords" size={16} /> <b>{(c.members ?? []).length} countries</b> have formed a coalition against{' '}
            <button className="link" onClick={() => select(c.target)}>{c.target === my.nation?.id ? 'you' : name(c.target)}</button>.
          </div>
        ))}
        <p className="tiny muted" style={{ margin: 0 }}>
          The world never resets. AI governments keep the top five powers in their sights, and when a country grows to 12% of the world by conquest, its neighbours band together against it. Conquering the world is possible, but very hard.
        </p>
        {my.nation && <div className="small">You: {my.nation.share}% of the world{myRank != null && myRank >= 0 ? ` · #${myRank + 1} in power` : ''}</div>}
      </section>
      <section className="card stack">
        <strong className="row"><Icon name="trophy" size={18} accent="var(--gold)" /> World powers</strong>
        {!ranks && <Loading />}
        {(ranks?.powers ?? []).slice(0, 25).map((p: any, i: number) => (
          <button key={p.id} className={`rank-row ${p.id === my.nation?.id ? 'me' : ''}`} onClick={() => select(p.id)}>
            <span className="tnum muted" style={{ width: 24 }}>{i + 1}</span>
            <span className="swatch" style={{ background: p.color }} />
            <span className="grow"><b>{p.name}</b> <span className="tiny muted">{p.leader ? p.leader : 'AI'} · {p.territories} {p.territories === 1 ? 'territory' : 'territories'}</span></span>
            <span className="tnum">{num(p.power)}</span>
          </button>
        ))}
      </section>
      {ranks?.hall?.length > 0 && (
        <section className="card stack">
          <strong className="row"><Icon name="medal" size={18} accent="var(--gold)" /> Hall of fame</strong>
          {ranks.hall.map((h: any) => <div key={h.number} className="small">Era {h.number}: <b>{h.winner}</b>{h.leader ? ` led by ${h.leader}` : ''} ({h.share}%)</div>)}
        </section>
      )}
      <section className="card stack">
        <strong className="row"><Icon name="doc" size={18} accent="var(--gold)" /> World news</strong>
        {!news && <Loading />}
        {(news ?? []).map((x: any) => (
          <div key={x.id} className={`news-row ${x.kind}`}>
            <Icon name={x.kind === 'war' || x.kind === 'battle' ? 'swords' : x.kind === 'peace' || x.kind === 'pact' ? 'dove' : x.kind === 'alliance' ? 'handshake' : x.kind === 'fallen' ? 'flag' : x.kind === 'coalition' ? 'swords' : x.kind === 'era' ? 'crown' : 'globe'} size={16} />
            <span className="grow"><b>{x.title}</b>{x.body && <span className="tiny muted"> {x.body}</span>}</span>
            <span className="tiny muted">{ago(x.at)}</span>
          </div>
        ))}
      </section>
      {my.battles.length > 0 && (
        <section className="card stack">
          <strong className="row"><Icon name="target" size={18} accent="var(--gold)" /> Your battles</strong>
          {my.battles.map((b) => {
            const won = (b.winner === 'attacker') === (b.attacker === my.nation?.id);
            return (
              <div key={b.id} className="small">
                <span className={`chip ${won ? 'green' : 'red'}`}>{won ? 'Won' : 'Lost'}</span> {b.summary} <span className="tiny muted">({num(b.att_power)} vs {num(b.def_power)}, {ago(b.at)})</span>
              </div>
            );
          })}
        </section>
      )}
    </div>
  );
}

// How far the invasion has got: enemy land your side holds, and yours they hold.
function Invasion({ war, my, world, name, select }: { war: MyNation['wars'][0]; my: MyNation; world: WorldState | null; name: (id: string) => string; select: (id: string) => void }) {
  if (!world) return null;
  const mine = new Set([my.nation!.id, ...(war.allies ?? [])]);
  const theirs = new Set(war.enemies ?? []);
  const enemyLand = world.territories.filter(([, owner]) => theirs.has(owner));
  const taken = enemyLand.filter(([, , ctrl]) => mine.has(ctrl));
  const ourLand = world.territories.filter(([, owner]) => mine.has(owner));
  const lost = ourLand.filter(([, , ctrl]) => theirs.has(ctrl));
  const pct = enemyLand.length ? Math.round((taken.length / enemyLand.length) * 100) : 0;
  return (
    <div className="stack" style={{ gap: 4 }}>
      <div className="row between small"><b>Invasion</b><span className="tnum">{taken.length} of {enemyLand.length} enemy territories held ({pct}%)</span></div>
      <Bar value={pct} tone="var(--gold)" />
      {taken.length > 0 && <div className="tiny muted">Held: {taken.map(([id]) => <button key={id} className="link" onClick={() => select(id)}>{name(id)}</button>).reduce((a: any[], b, i) => (i ? [...a, ', ', b] : [b]), [])}</div>}
      {lost.length > 0 && <div className="tiny neg">They hold {lost.length} of yours: {lost.map(([id]) => name(id)).join(', ')}</div>}
    </div>
  );
}

