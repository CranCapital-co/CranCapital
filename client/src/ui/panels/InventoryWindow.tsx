import { useState } from 'react';
import { rpc } from '../../lib/supabase';
import { useGame, goodName, goodIcon, cityName } from '../../lib/store';
import { money, num, until } from '../../lib/format';
import { Window, Tabs, useApi, Loading, Progress, Empty } from '../components';
import { GoodIcon } from '../Icon';

export default function InventoryWindow() {
  const [tab, setTab] = useState<'storage' | 'shipments' | 'orders'>('storage');
  const open = useGame((s) => s.open);
  const { data: storage } = useApi(() => rpc<any[]>('my_storage'), [], 20000);
  const { data: prop } = useApi(() => (tab === 'shipments' ? rpc<any>('my_property') : Promise.resolve(null)), [tab]);
  const { data: orders } = useApi(() => (tab === 'orders' ? rpc<any>('my_orders') : Promise.resolve(null)), [tab]);
  return (
    <Window title="Storage" icon="box">
      <div className="stack">
        <Tabs tabs={[['storage', 'Goods'], ['shipments', 'Shipments'], ['orders', 'Orders']]} value={tab} onChange={setTab} />
        {tab === 'storage' && (!storage ? <Loading /> : storage.length === 0 ? <Empty icon="box" title="Nothing in storage">Buy goods on the market, or make them on your farms and in factories.</Empty> : storage.map((c) => (
          <div key={c.city_id} className="card stack">
            <div className="row between">
              <strong>{c.city_name}</strong>
              <span className="small muted">{num(c.used)} / {num(c.capacity)} units</span>
            </div>
            <Progress value={c.used} max={c.capacity} color={c.used / c.capacity > 0.9 ? 'var(--bad)' : 'var(--brand-2)'} />
            {c.goods.length === 0 ? <p className="small muted">Empty.</p> : (
              <table className="list">
                <tbody>
                  {c.goods.map((g: any) => (
                    <tr key={g.good} className="click" onClick={() => open('market', { good: g.good })}>
                      <td className="nowrap"><GoodIcon id={g.good} size={20} /> {goodName(g.good)}</td>
                      <td className="r num">{num(g.qty)}</td>
                      <td className="r num small muted">{money(g.value)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )))}
        {tab === 'shipments' && (!prop ? <Loading /> : prop.shipments.length === 0 ? <Empty icon="ship" title="No shipments">Ship goods from a port (tier 5).</Empty> : (
          <table className="list">
            <tbody>
              {prop.shipments.map((s: any) => (
                <tr key={s.id}>
                  <td><GoodIcon id={s.good_id} size={18} /> {num(s.qty)} {goodName(s.good_id)}</td>
                  <td className="small">{cityName(s.from_city)} → {cityName(s.to_city)}</td>
                  <td className="r small">{s.status === 'delivered' ? (s.delivered_value ? money(s.delivered_value) : 'arrived') : `in ${until(s.arrive_at)}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
        {tab === 'orders' && (!orders ? <Loading /> : (
          <div className="stack">
            <strong className="small">Open orders</strong>
            {orders.open.length === 0 ? <p className="small muted">None.</p> : (
              <table className="list"><tbody>
                {orders.open.map((o: any) => (
                  <tr key={o.id} className="click" onClick={() => open('market', { good: o.good_id })}>
                    <td className="nowrap"><GoodIcon id={o.good_id ?? o.good} size={18} /> {o.name}</td><td>{o.side}</td><td className="r num">{num(o.qty - o.filled)}</td><td className="r num">{money(o.price)}</td>
                  </tr>
                ))}
              </tbody></table>
            )}
            <strong className="small">Recent trades</strong>
            <table className="list"><tbody>
              {orders.recent.map((t: any) => (
                <tr key={t.id}><td className="nowrap"><GoodIcon id={t.good_id ?? t.good} size={18} /> {t.name}</td><td className={t.side === 'buy' ? 'good' : 'bad'}>{t.side}</td><td className="r num">{num(t.qty)}</td><td className="r num">{money(t.value)}</td></tr>
              ))}
            </tbody></table>
          </div>
        ))}
      </div>
    </Window>
  );
}
