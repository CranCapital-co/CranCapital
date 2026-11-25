// Your nation and the world: a full-screen map with a command panel.
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { rpc } from '../lib/supabase';
import { act, useGame } from '../lib/store';
import { money, num, until } from '../lib/format';
import { sound } from '../audio/sound';
import { Icon } from '../ui/Icon';
import { Modal, Tabs, Loading, useApi } from '../ui/components';
import type { TroopMap } from './WorldMap';
import { cityName, goodName as catalogGood } from '../lib/store';
import { useWorldMap, useWorldState, flag, fmtPop, fmtGdp, PERSONALITY, attackOf, oddsLabel, type WorldMapData } from './api';
import { OverviewTab, MilitaryTab, ResearchTab, DiplomacyTab, WorldTab, UnitChips, type MyNation, type Ctx } from './NationTabs';
import NationPicker from './NationPicker';
import { refreshMe } from '../ui/common';
import './nations.css';

const WorldMap = lazy(() => import('./WorldMap'));

type Tab = 'nation' | 'military' | 'research' | 'diplomacy' | 'world';

export default function NationsScreen({ onClose }: { onClose: () => void }) {
  const me = useGame((s) => s.me)!;
  const { data, error } = useWorldMap();
  const world = useWorldState(12000);
  const { data: my, reload } = useApi(() => rpc<MyNation>('my_nation'), [me.nation], 8000);
  // Where all the troops are, and your ships at sea.
  const { data: troops } = useApi(() => rpc<TroopMap>('troop_map'), [me.nation], 10000);
  const { data: shipList } = useApi(() => rpc<any[]>('my_ships'), [], 15000);
  const ships = useMemo(
    () => (shipList ?? []).filter((x) => x.status === 'in_transit').map((x) => ({
      id: x.id, from: x.from as [number, number], to: x.to as [number, number], depart: x.depart_at, arrive: x.arrive_at,
      label: `${Number(x.qty).toLocaleString()} ${catalogGood(x.good)} → ${cityName(x.to_city)}`,
    })),
    [shipList]
  );
  const [tab, setTab] = useState<Tab>('nation');
  const [sel, setSel] = useState<string | null>(null);
  const [send, setSend] = useState<{ from: string; to?: string } | null>(null);
  const [wide, setWide] = useState(() => window.innerWidth >= 900);
  useEffect(() => {
    const r = () => setWide(window.innerWidth >= 900);
    window.addEventListener('resize', r);
    return () => window.removeEventListener('resize', r);
  }, []);
  // Fly home on the first open.
  useEffect(() => {
    if (my?.nation?.id && data) setTimeout(() => window.dispatchEvent(new CustomEvent('cc:worldfly', { detail: my.nation!.id })), 400);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!my?.nation?.id, !!data]);

  const names = useMemo(() => {
    const m = new Map<string, string>();
    data?.map.territories.forEach((t) => m.set(t.id, t.name));
    world?.nations.forEach((n) => m.set(n.id, n.name));
    return m;
  }, [data, world]);
  const name = useCallback((id: string) => names.get(id) ?? id, [names]);
  const select = useCallback((id: string) => {
    setSel(id);
    window.dispatchEvent(new CustomEvent('cc:worldfly', { detail: id }));
  }, []);

  const targets = useMemo(() => {
    if (!send || !my) return undefined;
    return my.territories.find((t) => t.id === send.from)?.neighbours.map((x) => x.id);
  }, [send, my]);

  // No country (fell, stepped down, or never picked): pick one here.
  if (my && !my.nation) {
    return (
      <div className="nations-screen">
        <button className="btn ghost nations-close" onClick={onClose}><Icon name="back" size={18} /> Back to the city</button>
        <NationPicker onDone={(fresh) => { useGame.getState().set({ me: fresh }); reload(); }} />
      </div>
    );
  }

  const ctx: Ctx | null = my && data ? { my, map: data.map, world, reload, name, select, sendFrom: (from, to) => setSend({ from, to }), troops: troops ?? null } : null;
  const n = my?.nation;

  return (
    <div className="nations-screen">
      <div className="nations-map">
        {data && (
          <Suspense fallback={null}>
            <WorldMap
              map={data.map}
              shapes={data.shapes}
              state={world}
              me={n?.id}
              selected={sel}
              onSelect={(id) => setSel(id)}
              targets={targets}
              troops={troops}
              ships={ships}
              padding={wide ? { right: 440 } : { bottom: Math.round(window.innerHeight * 0.5) }}
            />
          </Suspense>
        )}
        {error && <div className="notice red picker-error">{error}</div>}
      </div>

      <header className="nations-top">
        <button className="round-btn" onClick={onClose} aria-label="Back to the city"><Icon name="back" size={22} /></button>
        {n && (
          <div className="hud-pill nation-pill">
            <span className="flag big">{flag(data?.map.territories.find((t) => t.id === n.id)?.iso2)}</span>
            <span className="stack" style={{ gap: 0 }}>
              <b>{n.name}</b>
              <span className="tiny muted tnum">{money(me.cash, { compact: true, cents: false })} · power {num(n.power)} · {n.share}% of the world</span>
            </span>
          </div>
        )}
        {world?.era && <span className="hud-pill era-pill tiny"><Icon name="crown" size={16} accent="var(--gold)" /> Era {world.era.number} · {world.wars.length} wars</span>}
      </header>

      <aside className={`nations-panel ${wide ? 'side' : 'bottom'}`}>
        {sel && ctx && <SelectedCard id={sel} ctx={ctx} onClose={() => setSel(null)} />}
        <div className="tab-sticky">
          <Tabs<Tab>
            tabs={[['nation', 'Nation'], ['military', 'Military'], ['research', 'Research'], ['diplomacy', `Diplomacy${my?.offers.some((o) => o.incoming) ? ' •' : ''}`], ['world', 'World']]}
            value={tab}
            onChange={setTab}
          />
        </div>
        <div className="nations-body scroll">
          {!ctx ? <Loading lines={6} /> : tab === 'nation' ? <OverviewTab {...ctx} /> : tab === 'military' ? <MilitaryTab {...ctx} /> : tab === 'research' ? <ResearchTab {...ctx} /> : tab === 'diplomacy' ? <DiplomacyTab {...ctx} /> : <WorldTab {...ctx} />}
        </div>
      </aside>

      {send && ctx && <ArmyDialog ctx={ctx} from={send.from} to={send.to ?? null} onClose={() => setSend(null)} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The card for a tapped country
// ---------------------------------------------------------------------------
function SelectedCard({ id, ctx, onClose }: { id: string; ctx: Ctx; onClose: () => void }) {
  const { my, map, world, reload, name } = ctx;
  const holder = world?.territories.find((t) => t[0] === id);
  const controller = holder?.[2] ?? id;
  const { data: info, reload: reloadInfo } = useApi(() => rpc<any>('nation_info', { p_id: controller }), [controller, my.nation?.id]);
  const t = map.territories.find((x) => x.id === id)!;
  const mineHere = my.territories.find((x) => x.id === id);
  const isMine = controller === my.nation?.id;
  const allied = !!my.alliance?.members.includes(controller);
  const atWar = my.wars.some((w) => (w.enemies ?? []).includes(controller));
  // My territories next to it, with troops, to attack or reinforce from.
  const sources = my.territories.filter((x) => x.held && x.neighbours.some((nb) => nb.id === id) && Object.values(x.garrison).some((v) => v > 0));
  const intelHere = info?.territories?.find((x: any) => x.id === id);
  const level = my.level;
  const done = () => { reload(); reloadInfo(); };
  const doAct = async (fn: string, args: any, ok: string) => {
    const r = await act(() => rpc<any>(fn, args), (x) => (x?.status === 'declined' ? 'They said no.' : x?.status === 'open' ? 'Offer sent.' : ok));
    if (r) { sound.play('success'); done(); refreshMe(); }
  };
  if (!t) return null;
  return (
    <section className="card stack selected-card">
      <div className="row between">
        <h3 className="row" style={{ margin: 0 }}><span className="flag big">{flag(t.iso2)}</span> {t.name}</h3>
        <button className="btn tiny ghost" onClick={onClose} aria-label="Close"><Icon name="close" size={16} /></button>
      </div>
      {controller !== id && <div className="small">Held by <b>{name(controller)}</b>{holder?.[1] !== controller ? ` (occupied from ${name(holder![1])})` : ''}</div>}
      <div className="chips">
        <span className="chip">{fmtPop(t.pop_m)}</span>
        <span className="chip">{fmtGdp(t.gdp_bn)}</span>
        <span className="chip">{money(t.income, { cents: false })}/h</span>
        {info && <span className="chip">Power {num(info.power)}</span>}
        {info?.alliance && <span className="chip">{info.alliance.name}</span>}
      </div>
      {info && !isMine && (
        <div className="small">
          {info.leader ? <>Led by <b>{info.leader.name}</b>{info.leader.title ? `, ${info.leader.title}` : ''}</> : <>A <b>{info.skill_name}</b> AI government. {PERSONALITY[info.personality]}.</>}
          {info.relation != null && <> Relations with you: <b className={info.relation < 0 ? 'neg' : 'pos'}>{info.relation > 0 ? '+' : ''}{info.relation}</b>.</>}
          {info.treaty && <> {info.treaty.kind === 'nap' ? 'Pact' : 'Truce'} for {until(info.treaty.until)}.</>}
          {info.protected_until && <> Protected for {until(info.protected_until)}.</>}
        </div>
      )}
      {intelHere && !isMine && (
        <div className="row between small">
          <span>Troops (estimated): <UnitChips units={intelHere.troops ?? {}} types={map.units} /></span>
          <span className="muted">{intelHere.forts ? `Fort ${intelHere.forts}` : 'No fort'}{intelHere.air_defence ? ` · AA ${intelHere.air_defence}` : ''}</span>
        </div>
      )}
      {isMine && mineHere && <div className="small"><UnitChips units={mineHere.garrison} types={map.units} /> <span className="muted">· defence {num(mineHere.defence)}</span></div>}
      {my.nation && !isMine && (
        <div className="row wrap" style={{ gap: 6 }}>
          {(atWar || allied) && sources.length > 0 && (
            <button className={`btn small ${atWar ? 'danger' : ''}`} onClick={() => ctx.sendFrom(sources[0].id, id)}>
              <Icon name="swords" size={16} /> {atWar ? 'Attack' : 'Send troops'}
            </button>
          )}
          {info?.can_declare && !atWar && (
            level >= (my.unlocks.war ?? 5) ? (
              <DeclareButton target={info.name} onYes={() => doAct('declare_war', { p_nation: controller }, `War with ${info.name}!`)} />
            ) : (
              <span className="chip"><Icon name="lock" size={14} /> War at level {my.unlocks.war}</span>
            )
          )}
          {!atWar && <button className="btn small ghost" onClick={() => doAct('diplo_envoy', { p_nation: controller }, 'Envoy sent: relations improved.')}><Icon name="mail" size={16} /> Envoy · $2,500</button>}
          {!atWar && !allied && <button className="btn small ghost" onClick={() => doAct('diplo_denounce', { p_nation: controller }, 'Denounced.')}>Denounce</button>}
          {!atWar && !allied && !info?.treaty && level >= (my.unlocks.nap ?? 6) && (
            <button className="btn small ghost" onClick={() => doAct('diplo_nap', { p_nation: controller }, 'Pact signed!')}><Icon name="dove" size={16} /> Pact</button>
          )}
          {my.alliance && !info?.alliance && !atWar && (
            <button className="btn small ghost" onClick={() => doAct('alliance_invite', { p_nation: controller }, `${info?.name} joined your alliance!`)}><Icon name="handshake" size={16} /> Invite</button>
          )}
          {info?.why_not && !atWar && <span className="tiny muted">{info.why_not}</span>}
        </div>
      )}
      {isMine && mineHere && Object.values(mineHere.garrison).some((v) => v > 0) && (
        <button className="btn small" onClick={() => ctx.sendFrom(id)}><Icon name="swords" size={16} /> Send troops from here</button>
      )}
    </section>
  );
}

function DeclareButton({ target, onYes }: { target: string; onYes: () => void }) {
  const [ask, setAsk] = useState(false);
  return (
    <>
      <button className="btn small danger" onClick={() => setAsk(true)}><Icon name="swords" size={16} /> Declare war</button>
      {ask && (
        <Modal title={`Declare war on ${target}?`} onClose={() => setAsk(false)}>
          <div className="stack">
            <p className="small">Their allies will join them. You’ll lose 10 stability and goodwill with their neighbours, and any new-leader protection you have ends. Make sure your army can break their defences.</p>
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button className="btn ghost" onClick={() => setAsk(false)}>Not yet</button>
              <button className="btn danger" onClick={() => { setAsk(false); onYes(); }}>Declare war</button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Sending an army
// ---------------------------------------------------------------------------
function km(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const r = (d: number) => (d * Math.PI) / 180;
  const s = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lng - a.lng) / 2) ** 2;
  return 12742 * Math.asin(Math.min(1, Math.sqrt(s)));
}

function ArmyDialog({ ctx, from: from0, to: to0, onClose }: { ctx: Ctx; from: string; to: string | null; onClose: () => void }) {
  const { my, map, world, name, reload } = ctx;
  const [from, setFrom] = useState(from0);
  const src = my.territories.find((t) => t.id === from)!;
  const air = (src?.garrison.air ?? 0) > 0;
  // Where it can go: neighbours, plus anywhere in air range for air wings.
  const options = useMemo(() => {
    const ids = new Set(src?.neighbours.map((n) => n.id) ?? []);
    if (air) {
      const a = map.territories.find((t) => t.id === from)!;
      map.territories.forEach((t) => { if (t.id !== from && km(a, t) <= 2500) ids.add(t.id); });
    }
    return [...ids].map((id) => map.territories.find((t) => t.id === id)!).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
  }, [src, air, from, map]);
  const [to, setTo] = useState<string>(to0 && options.some((o) => o.id === to0) ? to0 : options[0]?.id ?? '');
  const [units, setUnits] = useState<Record<string, number>>(() => Object.fromEntries(Object.entries(src?.garrison ?? {}).filter(([k]) => k !== 'missile').map(([k, v]) => [k, Math.ceil(v * 0.8)])));
  const [missiles, setMissiles] = useState(0);
  const controller = world?.territories.find((t) => t[0] === to)?.[2] ?? to;
  const { data: info } = useApi(() => (to ? rpc<any>('nation_info', { p_id: controller }) : Promise.resolve(null)), [to, controller]);
  if (!src) return null;
  const link = map.links.find((l) => (l[0] === from && l[1] === to) || (l[1] === from && l[0] === to));
  const a = map.territories.find((t) => t.id === from)!;
  const b = map.territories.find((t) => t.id === to);
  const dist = link ? link[3] : b ? km(a, b) : 0;
  const chosen = Object.entries(units).filter(([, v]) => v > 0);
  const speed = Math.min(...chosen.map(([k]) => map.units.find((u) => u.id === k)?.speed ?? 100));
  const minutes = chosen.length ? 2 + dist / speed : 0;
  const allied = controller === my.nation?.id || !!my.alliance?.members.includes(controller);
  const atWar = my.wars.some((w) => (w.enemies ?? []).includes(controller));
  const groundAllowed = !!link || chosen.every(([k]) => k === 'air');
  // Odds: our attack against their estimated defence (troops, militia, forts).
  const terr = info?.territories?.find((x: any) => x.id === to);
  const tDef = terr
    ? (Object.entries(terr.troops ?? {}) as [string, number][]).reduce((s, [k, v]) => s + v * (map.units.find((u) => u.id === k)?.def ?? 0), 0)
      + (terr.owner === terr.controller ? (b?.militia ?? 0) : 0)
    : 0;
  const def = tDef * (1 + 0.15 * (terr?.forts ?? 0));
  const atk = attackOf(units, map.units, link?.[2] === 'sea' && !(units.naval > 0));
  const odds = oddsLabel(def ? atk / def : Infinity);
  const silo = my.territories.find((t) => t.id === from)?.buildings.find((x) => x.kind === 'silo')?.level ?? 0;
  const go = async () => {
    const r = await act(() => rpc<any>('army_send', { p_from: from, p_to: to, p_units: units }), (x) =>
      x.kind === 'move' ? `On the way to ${name(to)}.` : `Attack on ${name(to)} launched! Arrives in ${until(x.arrive_at)}.`);
    if (r) {
      sound.play(r.kind === 'move' ? 'success' : 'tierup');
      reload();
      onClose();
    }
  };
  return (
    <Modal title="Send troops" onClose={onClose}>
      <div className="stack">
        <div className="grid2">
          <label className="field">
            <span>From</span>
            <select className="input" value={from} onChange={(e) => setFrom(e.target.value)}>
              {my.territories.filter((t) => Object.values(t.garrison).some((v) => v > 0)).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </label>
          <label className="field">
            <span>To</span>
            <select className="input" value={to} onChange={(e) => setTo(e.target.value)}>
              {options.map((o) => <option key={o.id} value={o.id}>{o.name}{world?.territories.find((t) => t[0] === o.id)?.[2] !== o.id ? ` (${name(world!.territories.find((t) => t[0] === o.id)![2])})` : ''}</option>)}
            </select>
          </label>
        </div>
        {Object.entries(src.garrison).filter(([k, v]) => v > 0 && k !== 'missile').map(([k, v]) => {
          const u = map.units.find((x) => x.id === k);
          return (
            <div key={k} className="row" style={{ gap: 10 }}>
              <Icon name={u?.icon ?? 'people'} size={20} />
              <span style={{ width: 88 }} className="small">{u?.name}</span>
              <input className="grow" type="range" min={0} max={v} value={units[k] ?? 0} onChange={(e) => setUnits({ ...units, [k]: Number(e.target.value) })} aria-label={u?.name} />
              <span className="tnum small" style={{ width: 70, textAlign: 'right' }}>{num(units[k] ?? 0)} / {num(v)}</span>
            </div>
          );
        })}
        {to && (
          <div className="card soft stack" style={{ gap: 6 }}>
            <div className="row between small"><span>{allied ? 'Reinforce' : atWar ? 'Attack' : 'Not at war'} · {Math.round(dist)} km{link ? ` by ${link[2]}` : ' by air'}</span><span className="tnum">{chosen.length ? `${Math.round(minutes)} min` : ''}</span></div>
            {atWar && (
              <div className="row between small">
                <span>Your attack {num(atk)} vs their defence about {num(def)}</span>
                <span className={`chip ${odds.tone}`}>{odds.label}</span>
              </div>
            )}
            {link?.[2] === 'sea' && !(units.naval > 0) && atWar && <span className="tiny muted">Crossing the sea without a fleet costs 40% of your attack.</span>}
            {!groundAllowed && <span className="tiny neg">That’s not next door: only air wings can fly there.</span>}
            {!allied && !atWar && <span className="tiny neg">You’re not at war with {name(controller)}. Declare war first.</span>}
          </div>
        )}
        {silo > 0 && (src.garrison.missile ?? 0) > 0 && atWar && (
          <div className="row" style={{ gap: 8 }}>
            <Icon name="rocket" size={20} />
            <input className="grow" type="range" min={0} max={src.garrison.missile} value={missiles} onChange={(e) => setMissiles(Number(e.target.value))} aria-label="Missiles" />
            <button className="btn small danger" disabled={!missiles} onClick={async () => {
              const r = await act(() => rpc('missile_launch', { p_from: from, p_to: to, p_qty: missiles }), `${missiles} missiles launched.`);
              if (r) { reload(); onClose(); }
            }}>Launch {missiles}</button>
          </div>
        )}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className={`btn ${atWar ? 'danger' : 'gold'}`} disabled={!chosen.length || !to || !groundAllowed || (!allied && !atWar)} onClick={go}>
            {atWar ? 'Attack' : 'Send'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

export type { WorldMapData };
