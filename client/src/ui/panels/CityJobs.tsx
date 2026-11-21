import { useState } from 'react';
import { rpc } from '../../lib/supabase';
import { useGame, act, goodName, cityName } from '../../lib/store';
import { money, num } from '../../lib/format';
import { sound } from '../../audio/sound';
import { useApi, Loading, Empty } from '../components';
import { GoodIcon, Icon } from '../Icon';
import { refreshMe } from '../common';

// Contracts (orders from the city) and city projects (everyone chips in).
export default function CityJobs() {
  const me = useGame((s) => s.me)!;
  const city = me.city_id ?? 'london';
  const { data, reload } = useApi(() => rpc<any>('city_contracts', { p_city: city }), [city], 30000);
  const { data: projects, reload: reloadProjects } = useApi(() => rpc<any[]>('city_projects', { p_city: city }), [city], 60000);
  const { data: storage } = useApi(() => rpc<any[]>('my_storage'), [city]);
  const have = (g: string) => storage?.find((s) => s.city_id === city)?.goods.find((x: any) => x.good === g)?.qty ?? 0;
  const due = (t: string) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZone: useGame.getState().catalog?.cities.find((c) => c.id === city)?.tz });

  return (
    <div className="stack">
      <section className="card stack">
        <div className="row between">
          <strong className="row"><Icon name="doc" accent="var(--gold)" /> Contracts in {cityName(city)}</strong>
          <span className="tiny muted">Pays above market · deposit back on delivery</span>
        </div>
        {me.tier < 2 && <p className="small muted">Contracts open at tier 2. Here's what the city wants right now:</p>}
        {(data?.mine ?? []).map((c: any) => (
          <div key={c.id} className={`contract mine ${c.status}`}>
            <GoodIcon id={c.good_id} size={30} />
            <span className="grow">
              <b>{c.client}</b>
              <span className="small">
                {num(c.qty)} {goodName(c.good_id).toLowerCase()} by {due(c.due_at)} · you have {num(c.have ?? 0)}
              </span>
              <span className="small muted">Pays {money(c.total, { cents: false })} + your {money(c.deposit, { cents: false })} deposit back</span>
            </span>
            {c.status === 'taken' ? (
              <button
                className="btn small gold"
                disabled={(c.have ?? 0) < c.qty}
                onClick={async () => {
                  const r = await act(() => rpc<any>('deliver_contract', { p_id: c.id }), (x) => `Delivered! ${money(x.paid + x.deposit)} paid.`);
                  if (r) {
                    sound.play('chaching');
                    reload();
                    refreshMe();
                  }
                }}
              >
                Deliver
              </button>
            ) : (
              <span className={`chip ${c.status === 'done' ? 'green' : 'red'}`}>{c.status === 'done' ? 'Delivered' : 'Missed'}</span>
            )}
          </div>
        ))}
        {!data ? (
          <Loading />
        ) : data.open.length === 0 ? (
          <p className="small muted">No open orders right now. New ones come in every hour.</p>
        ) : (
          data.open.map((c: any) => (
            <div key={c.id} className="contract">
              <GoodIcon id={c.good_id} size={30} />
              <span className="grow">
                <b>{c.client}</b>
                <span className="small">wants {num(c.qty)} {goodName(c.good_id).toLowerCase()} by {due(c.due_at)}</span>
                <span className="small muted">Pays {money(c.total, { cents: false })} · deposit {money(c.deposit, { cents: false })}</span>
              </span>
              <button
                className="btn small"
                disabled={me.tier < 2}
                onClick={async () => {
                  const r = await act(() => rpc('accept_contract', { p_id: c.id }), 'Contract taken. Deliver before the deadline to get your deposit back.');
                  if (r) {
                    sound.play('success');
                    reload();
                    refreshMe();
                  }
                }}
              >
                Take it
              </button>
            </div>
          ))
        )}
      </section>

      {(projects ?? []).map((p) => (
        <Project key={p.id} p={p} have={have} onDone={() => { reloadProjects(); refreshMe(); }} />
      ))}
      {!projects && <Loading />}
      {projects && projects.length === 0 && <Empty icon="flag" title="No city projects here yet" />}
    </div>
  );
}

function Project({ p, have, onDone }: { p: any; have: (g: string) => number; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const done = p.status === 'done';
  return (
    <section className="card stack project">
      <div className="row between">
        <strong className="row"><Icon name="apartments" accent="var(--brand-2)" /> {p.name}</strong>
        <span className={`chip ${done ? 'green' : ''}`}>{done ? 'Open!' : `${Math.round((p.progress ?? 0) * 100)}% built`}</span>
      </div>
      <p className="small muted" style={{ margin: 0 }}>{p.description}</p>
      <div className="progress"><div style={{ width: `${Math.round((p.progress ?? 0) * 100)}%`, background: done ? 'var(--good)' : 'var(--gold)' }} /></div>
      {!done &&
        Object.entries(p.needs as Record<string, number>).map(([g, need]) => {
          const given = Number(p.given?.[g] ?? 0);
          const left = Math.max(0, need - given);
          const mine = have(g);
          const give = Math.min(left, mine);
          return (
            <div key={g} className="row between need-row">
              <span className="row grow">
                <GoodIcon id={g} size={24} />
                <span>
                  <b>{goodName(g)}</b>
                  <span className="small muted"> {num(given)} of {num(need)}</span>
                </span>
              </span>
              <button
                className="btn tiny"
                disabled={busy || give <= 0}
                title={give <= 0 ? (left <= 0 ? 'It has enough' : 'None in your storage here') : undefined}
                onClick={async () => {
                  setBusy(true);
                  const r = await act(() => rpc<any>('contribute_project', { p_project: p.id, p_good: g, p_qty: give }), (x) => `Thank you! You gave ${num(x.given)} and got ${money(x.reward)}.`);
                  setBusy(false);
                  if (r) {
                    sound.play(r.done ? 'tierup' : 'success');
                    onDone();
                  }
                }}
              >
                {give > 0 ? `Give ${num(give)}` : left <= 0 ? 'Done' : 'None here'}
              </button>
            </div>
          );
        })}
      {p.top?.length > 0 && (
        <div className="small muted">
          Top givers: {p.top.map((t: any) => `${t.name} (${money(t.value, { compact: true })})`).join(', ')}
          {p.mine > 0 && <> · you gave {money(p.mine, { compact: true })}</>}
        </div>
      )}
    </section>
  );
}
