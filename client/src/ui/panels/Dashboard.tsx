import { useState } from 'react';
import { rpc } from '../../lib/supabase';
import { useGame, cityName } from '../../lib/store';
import { money } from '../../lib/format';
import { incomePerHour, useIncome } from '../../lib/income';
import { restockAll } from '../../lib/restock';
import { sound } from '../../audio/sound';
import { useApi, Loading, Empty } from '../components';
import { flagList } from '../common';
import { BizIcon, Icon } from '../Icon';
import { refreshMe } from '../common';
import type { Business } from '../../lib/types';
import { NetWorthChart } from './NetWorthChart';
import { DailyGoals } from './DailyGoals';

// The Empire overview: how it's going, what needs you, and today's goals.
export default function Dashboard({ api }: { api?: any }) {
  const me = useGame((s) => s.me)!;
  const open = useGame((s) => s.open);
  const { data, loading, reload } = useApi(() => rpc<Business[]>('my_businesses'), [], 30000);
  useIncome((s) => s.sales.length);
  const [busy, setBusy] = useState(false);
  const list = data ?? [];
  const tier = (kind: string) => useGame.getState().catalog?.business_types.find((t) => t.id === kind)?.tier;
  const profit = (b: Business) => (b.revenue_today ?? 0) - (b.costs_today ?? 0);
  const ranked = [...list].sort((a, b) => profit(b) - profit(a));
  const best = Math.max(1, ...ranked.map((b) => Math.abs(profit(b))));
  const attention = list.filter((b) => b.status !== 'open' || flagList(b.flags).length > 0);
  const needStock = list.filter((b) => b.flags?.out_of_stock || b.flags?.low_stock);
  const today = list.reduce((a, b) => a + profit(b), 0);
  const rate = incomePerHour();

  if (loading && !data) return <Loading />;
  return (
    <div className="stack dash">
      <div className="stat-tiles">
        <div className="stat">
          <span className="stat-label">Net worth</span>
          <b className="tnum">{money(me.net_worth, { compact: true })}</b>
        </div>
        <div className="stat">
          <span className="stat-label">Today (after costs)</span>
          <b className={`tnum ${today >= 0 ? 'up' : 'down'}`}>
            <Icon name={today >= 0 ? 'trendUp' : 'trendDown'} size={16} /> {money(today, { cents: false })}
          </b>
        </div>
        <div className="stat">
          <span className="stat-label">Income rate</span>
          <b className="tnum">{rate ? `${money(rate, { cents: false })}/h` : '—'}</b>
        </div>
      </div>

      <NetWorthChart />

      {attention.length > 0 && (
        <section className="card stack attention">
          <div className="row between">
            <strong className="row"><Icon name="warn" accent="var(--coral)" /> Needs attention</strong>
            {needStock.length > 0 && (
              <button
                className="btn small gold"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  const r = await restockAll(needStock);
                  setBusy(false);
                  if (r.spent) {
                    sound.play('buy');
                    useGame.getState().toast(`Restocked ${needStock.length} business${needStock.length > 1 ? 'es' : ''} for ${money(r.spent)}.`, 'success');
                  }
                  if (r.failed) useGame.getState().toast(r.failed, 'error');
                  reload();
                  refreshMe();
                }}
              >
                {busy ? 'Buying…' : 'Restock all'}
              </button>
            )}
          </div>
          {attention.slice(0, 6).map((b) => (
            <div key={b.id} className="row between attention-row">
              <span className="row grow">
                <BizIcon kind={b.kind} tier={tier(b.kind)} />
                <span className="grow">
                  <b className="ellipsis">{b.name}</b>
                  <span className="small muted">{b.status !== 'open' ? `It's ${b.status}.` : flagList(b.flags).join(' · ')}</span>
                </span>
              </span>
              {b.status === 'closed' ? (
                <button
                  className="btn small"
                  onClick={async () => {
                    try {
                      await rpc('set_business_open', { p_id: b.id, p_open: true });
                      sound.play('success');
                      reload();
                    } catch (e: any) {
                      useGame.getState().toast(e.message, 'error');
                    }
                  }}
                >
                  Reopen
                </button>
              ) : (
                <button className="btn small ghost" onClick={() => open('business', { id: b.id })}>Open</button>
              )}
            </div>
          ))}
        </section>
      )}

      <section className="card stack">
        <strong>Income by business, today</strong>
        {ranked.length === 0 ? (
          <Empty icon="cart" title="Nothing built yet">
            <button className="btn" onClick={() => open('build')}>Build your first cart</button>
          </Empty>
        ) : (
          ranked.slice(0, 12).map((b) => {
            const p = profit(b);
            return (
              <button
                key={b.id}
                className="bar-row"
                onClick={() => {
                  open('business', { id: b.id });
                  if (api && b.city_id === me.city_id) api.flyTo(b.lat, b.lng);
                }}
              >
                <BizIcon kind={b.kind} tier={tier(b.kind)} size={20} />
                <span className="bar-name ellipsis">{b.name}<span className="small muted"> · {cityName(b.city_id)}</span></span>
                <span className="bar-track"><i className={p >= 0 ? 'pos' : 'neg'} style={{ width: `${(Math.abs(p) / best) * 100}%` }} /></span>
                <span className={`tnum small ${p >= 0 ? 'up' : 'down'}`}>{p >= 0 ? '▲' : '▼'} {money(Math.abs(p), { cents: false })}</span>
              </button>
            );
          })
        )}
      </section>

      <DailyGoals />
    </div>
  );
}
