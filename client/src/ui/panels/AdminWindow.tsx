// Admin panel (role 'admin' only): cheats for testing and running the game.
// Every button calls admin_cheat on the server, which checks the role and
// logs the action; this window only decides what to ask for.
import { useState } from 'react';
import { rpc } from '../../lib/supabase';
import { act, catalog, useGame } from '../../lib/store';
import { refreshMe } from '../common';
import { Window } from '../components';
import { Icon } from '../Icon';
import { useWorldMap } from '../../nations/api';

export default function AdminWindow() {
  const me = useGame((s) => s.me)!;
  const bump = useGame((s) => s.bump);
  const cat = catalog();
  const { data: world } = useWorldMap();
  const [player, setPlayer] = useState('');
  const [dollars, setDollars] = useState('1000000');
  const [good, setGood] = useState(cat.goods[0]?.id ?? '');
  const [qty, setQty] = useState('10000');
  const [unit, setUnit] = useState('infantry');
  const [troops, setTroops] = useState('1000');
  const [place, setPlace] = useState('');
  const [nation, setNation] = useState('');
  const [score, setScore] = useState('100');
  const [role, setRole] = useState('mod');

  if (me.role !== 'admin') {
    return (
      <Window title="Admin" icon="crown">
        <p className="muted">Only admins can use this.</p>
      </Window>
    );
  }

  const cheat = async (action: string, args: Record<string, unknown> = {}) => {
    const r = await act(() => rpc<{ message: string }>('admin_cheat', { p_action: action, p_args: { ...args, player: player.trim() || undefined } }), (x) => x.message);
    if (r) {
      await refreshMe();
      bump();
    }
  };
  const btn = (label: string, action: string, args: Record<string, unknown> = {}, cls = 'btn small') => (
    <button className={cls} onClick={() => cheat(action, args)}>{label}</button>
  );
  const territories = [...(world?.map.territories ?? [])].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <Window title="Admin" icon="crown">
      <div className="stack admin">
        <div className="notice small">Cheats apply to you, or to the player named here. Everything is logged.</div>
        <label className="field">
          <span>Player (blank for yourself)</span>
          <input className="input" value={player} onChange={(e) => setPlayer(e.target.value)} placeholder={me.display_name} autoCapitalize="off" autoCorrect="off" />
        </label>

        <section className="card stack">
          <h3 className="row"><Icon name="cash" size={20} /> Money</h3>
          <div className="row wrap">
            {btn('+$1M', 'money', { dollars: 1e6 })}
            {btn('+$100M', 'money', { dollars: 1e8 })}
            {btn('+$10B', 'money', { dollars: 1e10 })}
            {btn('+$1T', 'money', { dollars: 1e12 }, 'btn small gold')}
          </div>
          <div className="row">
            <input className="input grow" inputMode="numeric" value={dollars} onChange={(e) => setDollars(e.target.value.replace(/[^\d-]/g, ''))} aria-label="Dollars" />
            {btn('Give', 'money', { dollars: Number(dollars) || 0 })}
            {btn('Take', 'money', { dollars: -(Number(dollars) || 0) }, 'btn small ghost')}
          </div>
        </section>

        <section className="card stack">
          <h3 className="row"><Icon name="star" size={20} /> Renown and tier</h3>
          <div className="row wrap">
            {btn('+1 level', 'levels', { n: 1 })}
            {btn('+5 levels', 'levels', { n: 5 })}
            {btn('+25 levels', 'levels', { n: 25 })}
            {btn('+100 levels', 'levels', { n: 100 })}
          </div>
          <div className="row wrap">
            {btn('+10 perk points', 'perk_points', { n: 10 })}
            {btn('+5 supply crates', 'crates', { kind: 'supply', n: 5 })}
            {btn('+5 gold crates', 'crates', { kind: 'gold', n: 5 })}
            {btn('+5 war crates', 'crates', { kind: 'war', n: 5 })}
          </div>
          <div className="row wrap">
            {[1, 2, 3, 4, 5, 6].map((t) => <span key={t}>{btn(`Tier ${t}`, 'tier', { tier: t }, 'btn small ghost')}</span>)}
          </div>
        </section>

        <section className="card stack">
          <h3 className="row"><Icon name="box" size={20} /> Goods</h3>
          <div className="row">
            <select className="input grow" value={good} onChange={(e) => setGood(e.target.value)} aria-label="Good">
              {cat.goods.map((g) => <option key={g.id} value={g.id}>{g.icon} {g.name}</option>)}
            </select>
            <input className="input" style={{ width: 110 }} inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value.replace(/\D/g, ''))} aria-label="Quantity" />
            {btn('Add', 'goods', { good, qty: Number(qty) || 0 })}
          </div>
        </section>

        <section className="card stack">
          <h3 className="row"><Icon name="clock" size={20} /> Time</h3>
          {btn('Finish everything now (bases, recruits, research, armies, ships)', 'finish', {}, 'btn')}
        </section>

        <section className="card stack">
          <h3 className="row"><Icon name="flag" size={20} /> Nation</h3>
          <div className="row wrap">
            {btn('All research', 'all_tech')}
            {btn('+100k manpower', 'manpower', { n: 100000 })}
            {btn('Max stability', 'stability')}
            {btn('Peace with everyone', 'peace')}
            {btn('Remove protection', 'unprotect', {}, 'btn small ghost')}
          </div>
          <div className="row">
            <select className="input grow" value={unit} onChange={(e) => setUnit(e.target.value)} aria-label="Unit">
              {['infantry', 'artillery', 'armor', 'air', 'naval', 'missile'].map((u) => <option key={u} value={u}>{u}</option>)}
            </select>
            <input className="input" style={{ width: 110 }} inputMode="numeric" value={troops} onChange={(e) => setTroops(e.target.value.replace(/\D/g, ''))} aria-label="How many" />
            {btn('Add troops', 'troops', { unit, qty: Number(troops) || 0 })}
          </div>
          <div className="row">
            <select className="input grow" value={place} onChange={(e) => setPlace(e.target.value)} aria-label="Territory">
              <option value="">Pick a territory…</option>
              {territories.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            <button className="btn small" disabled={!place} onClick={() => cheat('annex', { territory: place })}>Take it</button>
          </div>
          <div className="row">
            <select className="input grow" value={nation} onChange={(e) => setNation(e.target.value)} aria-label="Country">
              <option value="">Relations with…</option>
              {territories.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            <input className="input" style={{ width: 80 }} inputMode="numeric" value={score} onChange={(e) => setScore(e.target.value.replace(/[^\d-]/g, ''))} aria-label="Score" />
            <button className="btn small" disabled={!nation} onClick={() => cheat('relations', { nation, score: Number(score) })}>Set</button>
          </div>
        </section>

        <section className="card stack">
          <h3 className="row"><Icon name="staff" size={20} /> Roles</h3>
          <p className="small muted">Make the player named at the top a player, moderator or admin.</p>
          <div className="row">
            <select className="input grow" value={role} onChange={(e) => setRole(e.target.value)} aria-label="Role">
              <option value="player">Player</option>
              <option value="mod">Moderator</option>
              <option value="admin">Admin</option>
            </select>
            <button className="btn small" disabled={!player.trim()} onClick={() => cheat('role', { role })}>Set role</button>
          </div>
        </section>
      </div>
    </Window>
  );
}
