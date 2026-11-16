import { rpc } from '../../lib/supabase';
import { useGame, cityName } from '../../lib/store';
import { money } from '../../lib/format';
import { Window, useApi, Loading, Empty, Money } from '../components';
import { flagList } from '../common';
import type { Business } from '../../lib/types';

export default function BusinessesWindow({ api }: { api: any }) {
  const open = useGame((s) => s.open);
  const { data, loading } = useApi(() => rpc<Business[]>('my_businesses'), [], 30000);
  const list = data ?? [];
  const today = list.reduce((a, b) => a + (b.revenue_today ?? 0) - (b.costs_today ?? 0), 0);
  return (
    <Window title="My businesses" icon="🏪">
      {loading && !data ? (
        <Loading />
      ) : list.length === 0 ? (
        <Empty icon="🛒" title="No businesses yet">
          Open the Build menu and park your first food cart on a busy street.
          <div style={{ marginTop: 12 }}>
            <button className="btn" onClick={() => open('build')}>Build something</button>
          </div>
        </Empty>
      ) : (
        <div className="stack">
          <div className="card soft row between">
            <span className="muted small">Today across all businesses (sales minus costs)</span>
            <strong><Money v={today} sign /></strong>
          </div>
          {list.map((b) => {
            const flags = flagList(b.flags);
            return (
              <button
                key={b.id}
                className="card click"
                style={{ textAlign: 'left' }}
                onClick={() => {
                  open('business', { id: b.id });
                  if (api && b.city_id === useGame.getState().me?.city_id) api.flyTo(b.lat, b.lng);
                }}
              >
                <div className="row">
                  <span style={{ fontSize: 26 }}>{b.icon}</span>
                  <div className="grow">
                    <div className="row between">
                      <strong className="ellipsis">{b.name}</strong>
                      <span className={`chip ${b.status === 'open' ? 'green' : 'red'}`}>{b.status}</span>
                    </div>
                    <div className="small muted">
                      {b.type_name} · level {b.level} · {cityName(b.city_id)}
                    </div>
                    <div className="small">
                      Today: {b.sales_today > 0 && `${b.sales_today} sales · `}
                      {b.produced_today > 0 && `${b.produced_today.toLocaleString()} made · `}
                      {money(b.revenue_today)} in, {money(b.costs_today)} out
                    </div>
                    {flags.length > 0 && (
                      <div className="row wrap" style={{ marginTop: 4, gap: 4 }}>
                        {flags.map((f) => <span key={f} className="chip red">{f}</span>)}
                      </div>
                    )}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </Window>
  );
}
