import { useEffect, useState } from 'react';
import { rpc } from '../../lib/supabase';
import { useGame, act, catalog, cityName } from '../../lib/store';
import { money, unitPrice, pct, num, ago } from '../../lib/format';
import { Window, useApi, Loading, Candles, Tabs, Field } from '../components';
import { refreshMe } from '../common';
import { GoodIcon } from '../Icon';

export default function MarketWindow({ params }: { params?: { good?: string } }) {
  const [good, setGood] = useState<string>(params?.good ?? 'lettuce');
  const [filter, setFilter] = useState<'all' | 'farm' | 'raw' | 'material' | 'finished'>('all');
  const { data: list } = useApi(() => rpc<any[]>('market_overview'), [], 15000);
  const goods = (list ?? []).filter((g) => filter === 'all' || g.category === filter || (filter === 'material' && g.category === 'fuel'));
  return (
    <Window title="Market" icon="market" wide>
      <div className="market">
        <div className="stack">
          <Tabs tabs={[['all', 'All'], ['farm', 'Farm'], ['raw', 'Raw'], ['material', 'Materials'], ['finished', 'Finished']]} value={filter} onChange={setFilter} />
          <div className="goods-list">
            {!list ? <Loading /> : goods.map((g) => (
              <button key={g.good} className={g.good === good ? 'on' : ''} onClick={() => setGood(g.good)}>
                <GoodIcon id={g.good} size={26} />
                <span className="ellipsis"><b>{g.name}</b><br /><span className="tiny muted">vol {num(g.volume_24h)}</span></span>
                <span className="num small">{unitPrice(g.last)}</span>
                <span className={`num tiny ${g.change_pct > 0 ? 'good' : g.change_pct < 0 ? 'bad' : 'muted'}`}>{pct(g.change_pct)}</span>
              </button>
            ))}
          </div>
        </div>
        <GoodDetail key={good} good={good} />
      </div>
    </Window>
  );
}

function GoodDetail({ good }: { good: string }) {
  const me = useGame((s) => s.me)!;
  const cat = catalog();
  const g = cat.goods.find((x) => x.id === good)!;
  const { data: d, reload } = useApi(() => rpc<any>('market_good', { p_good: good }), [good], 10000);
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [qty, setQty] = useState(1000);
  const [limit, setLimit] = useState(false);
  const [priceText, setPriceText] = useState('');
  const [city, setCity] = useState(me.city_id ?? 'london');
  const [quote, setQuote] = useState<any>(null);
  const price = Math.round(Number(priceText) * 1000) || 0;
  // Suggest the traders' price once per side (the component is keyed by good).
  useEffect(() => {
    if (d && d.good === good) setPriceText(((side === 'buy' ? d.npc.ask : d.npc.bid) / 1000).toString());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [side, d?.good]);
  useEffect(() => {
    if (limit || qty <= 0) return setQuote(null);
    const t = setTimeout(() => rpc('market_quote', { p_good: good, p_side: side, p_qty: qty }).then(setQuote).catch(() => setQuote(null)), 250);
    return () => clearTimeout(t);
  }, [good, side, qty, limit]);
  if (!d) return <Loading lines={6} />;
  const have = d.my_stock?.[city] ?? 0;
  return (
    <div className="stack">
      <div className="row between">
        <h3 style={{ margin: 0 }} className="row"><GoodIcon id={g.id ?? good} size={28} /> {g.name}</h3>
        <span className="small muted">base {unitPrice(g.base_price)}</span>
      </div>
      <p className="small muted" style={{ margin: 0 }}>{g.description}</p>
      <Candles candles={d.candles} />
      <div className="book">
        <div>
          <div className="tiny muted">Buyers</div>
          <table className="list">
            <tbody>
              {d.bids.map((r: any) => <tr key={'b' + r.price}><td className="bid num">{unitPrice(r.price)}</td><td className="r num">{num(r.qty)}</td></tr>)}
              <tr><td className="bid num">{unitPrice(d.npc.bid)}</td><td className="r tiny muted">market traders</td></tr>
            </tbody>
          </table>
        </div>
        <div>
          <div className="tiny muted">Sellers</div>
          <table className="list">
            <tbody>
              {d.asks.map((r: any) => <tr key={'a' + r.price}><td className="ask num">{unitPrice(r.price)}</td><td className="r num">{num(r.qty)}</td></tr>)}
              <tr><td className="ask num">{unitPrice(d.npc.ask)}</td><td className="r tiny muted">market traders</td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <div className="card stack">
        <Tabs tabs={[['buy', 'Buy'], ['sell', 'Sell']]} value={side} onChange={setSide} />
        <div className="grid2">
          <Field label="Quantity" hint={side === 'sell' ? `You have ${num(have)} in ${cityName(city)}` : undefined}>
            <input className="input" type="number" min={1} value={qty} onChange={(e) => setQty(Math.max(0, Math.floor(Number(e.target.value))))} />
          </Field>
          <Field label={side === 'buy' ? 'Deliver to' : 'From storage in'}>
            <select className="input" value={city} onChange={(e) => setCity(e.target.value)}>
              {cat.cities.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
        </div>
        <label className="check small">
          <input type="checkbox" checked={limit} onChange={(e) => setLimit(e.target.checked)} />
          <span>Set my own price (a limit order that waits in the book)</span>
        </label>
        {limit ? (
          <Field label="Price per unit ($)">
            <input className="input" inputMode="decimal" value={priceText} onChange={(e) => setPriceText(e.target.value.replace(/[^0-9.]/g, ''))} />
          </Field>
        ) : (
          quote && (
            <div className="small">
              Market order now: about <b>{money(quote.total)}</b> ({unitPrice(quote.avg)} each{side === 'sell' ? ', after the 1% fee' : ''}). Big orders move the price.
            </div>
          )
        )}
        <button
          className={`btn ${side === 'buy' ? '' : 'gold'}`}
          disabled={qty <= 0 || (limit && price <= 0)}
          onClick={async () => {
            const r = await act(
              () => rpc<any>('place_order', { p_good: good, p_side: side, p_qty: qty, p_price: limit ? price : null, p_city: city }),
              (x) => {
                const parts: string[] = [];
                if (x.filled) parts.push(`${side === 'buy' ? 'Bought' : 'Sold'} ${num(x.filled)} for ${money(x.value)}`);
                if (x.resting) parts.push(`${num(x.resting)} waiting in the book`);
                if (x.unfilled) parts.push(`${num(x.unfilled)} not filled (price moved too far)`);
                return parts.join('. ') + '.';
              }
            );
            if (r) {
              reload();
              refreshMe();
            }
          }}
        >
          {side === 'buy' ? 'Buy' : 'Sell'} {num(qty)} {g.name.toLowerCase()}
        </button>
        <p className="tiny muted">Sellers pay a {cat.config.trade_fee_pct}% fee. Goods bought arrive in your storage straight away.</p>
      </div>

      {d.my_orders.length > 0 && (
        <div className="card">
          <strong>Your open orders</strong>
          <table className="list">
            <tbody>
              {d.my_orders.map((o: any) => (
                <tr key={o.id}>
                  <td className={o.side === 'buy' ? 'bid' : 'ask'}>{o.side}</td>
                  <td className="num">{num(o.qty - o.filled)} @ {unitPrice(o.price)}</td>
                  <td className="small muted">{cityName(o.city_id)}</td>
                  <td className="r"><button className="btn tiny ghost" onClick={async () => { if (await act(() => rpc('cancel_order', { p_order: o.id }), 'Order cancelled.')) { reload(); refreshMe(); } }}>Cancel</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div>
        <strong className="small">Recent trades</strong>
        <table className="list">
          <tbody>
            {d.trades.slice(0, 10).map((t: any, i: number) => (
              <tr key={i}><td className="num">{unitPrice(t.price)}</td><td className="r num">{num(t.qty)}</td><td className="tiny muted">{t.npc ? 'traders' : 'players'}</td><td className="r tiny muted">{ago(t.at)}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
