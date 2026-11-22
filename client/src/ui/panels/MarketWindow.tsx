import { useEffect, useMemo, useState } from 'react';
import { sound } from '../../audio/sound';
import { rpc } from '../../lib/supabase';
import { useGame, act, catalog, cityName } from '../../lib/store';
import { money, unitPrice, pct, num, ago } from '../../lib/format';
import { Window, useApi, Loading, Tabs, Field } from '../components';
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
      <PriceChart candles={d.candles} trades={d.trades} now={(d.npc.bid + d.npc.ask) / 2} />
      <DepthBook bids={d.bids} asks={d.asks} npc={d.npc} />

      <div className="card stack">
        <Tabs tabs={[['buy', 'Buy'], ['sell', 'Sell']]} value={side} onChange={setSide} />
        <div className="grid2">
          <Field label="Quantity" hint={side === 'sell' ? `You have ${num(have)} in ${cityName(city)}` : undefined}>
            <input className="input" type="number" min={1} value={qty} onChange={(e) => setQty(Math.max(0, Math.floor(Number(e.target.value))))} />
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round(qtyToSlider(qty, side === 'sell' ? Math.max(10, have) : 100000))}
              onChange={(e) => setQty(sliderToQty(Number(e.target.value), side === 'sell' ? Math.max(10, have) : 100000))}
              aria-label="Quantity"
            />
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
            <div className="order-total">
              <div className="row between">
                <span>{num(qty)} × about {unitPrice(quote.avg)}</span>
                <span className="tnum">{money(side === 'sell' ? Math.round(quote.total / (1 - cat.config.trade_fee_pct / 100)) : quote.total)}</span>
              </div>
              {side === 'sell' && (
                <div className="row between small muted">
                  <span>{cat.config.trade_fee_pct}% exchange fee</span>
                  <span className="tnum">− {money(Math.round(quote.total / (1 - cat.config.trade_fee_pct / 100)) - quote.total)}</span>
                </div>
              )}
              <div className="row between total-line">
                <b>{side === 'buy' ? 'You pay' : 'You get'}</b>
                <b className="tnum">{money(quote.total)}</b>
              </div>
              <div className="tiny muted">Big orders move the price; this is an estimate until it fills.</div>
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
              sound.play(side === 'buy' ? 'buy' : 'sell');
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

// Quantity slider on a log scale: fine control for small amounts, reach for big ones.
function sliderToQty(v: number, max: number) {
  if (v <= 0) return 1;
  return Math.max(1, Math.round(Math.pow(max, v / 100)));
}
function qtyToSlider(q: number, max: number) {
  return q <= 1 ? 0 : Math.min(100, (Math.log(q) / Math.log(max)) * 100);
}

// Price over the last hour (from trades), 24 hours or 7 days (hourly candles).
function PriceChart({ candles, trades, now }: { candles: any[]; trades: any[]; now: number }) {
  const [range, setRange] = useState<'1h' | '24h' | '7d'>('24h');
  const pts = useMemo(() => {
    const t = Date.now();
    if (range === '1h') {
      const p = trades.filter((x) => t - new Date(x.at).getTime() < 3600_000).map((x) => ({ t: new Date(x.at).getTime(), v: x.price })).reverse();
      return [...p, { t, v: now }];
    }
    const span = range === '24h' ? 24 : 168;
    const step = range === '24h' ? 1 : 6;
    const out: { t: number; v: number; h: number; l: number }[] = [];
    for (const c of candles) {
      const ct = new Date(c.t).getTime();
      if (t - ct > span * 3600_000) continue;
      const last = out[out.length - 1];
      if (last && step > 1 && ct - last.t < step * 3600_000) {
        last.v = c.c;
        last.h = Math.max(last.h, c.h);
        last.l = Math.min(last.l, c.l);
      } else out.push({ t: ct, v: c.c, h: c.h, l: c.l });
    }
    return [...out, { t, v: now, h: now, l: now }];
  }, [candles, trades, range, now]);
  const W = 400;
  const H = 150;
  const vs = pts.map((p) => p.v);
  let lo = Math.min(...vs);
  let hi = Math.max(...vs);
  if (hi - lo < hi * 0.01) {
    hi *= 1.005;
    lo *= 0.995;
  }
  const t0 = pts[0]?.t ?? 0;
  const t1 = pts[pts.length - 1]?.t ?? 1;
  const x = (t: number) => 4 + ((t - t0) / Math.max(1, t1 - t0)) * (W - 8);
  const y = (v: number) => 6 + (1 - (v - lo) / Math.max(1, hi - lo)) * (H - 12);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
  const change = pts.length > 1 ? (pts[pts.length - 1].v - pts[0].v) / Math.max(1, pts[0].v) : 0;
  return (
    <div className="card stack tight">
      <div className="row between">
        <span className={`tnum small ${change >= 0 ? 'up' : 'down'}`}>{change >= 0 ? '▲' : '▼'} {(Math.abs(change) * 100).toFixed(1)}% over {range === '1h' ? 'the hour' : range === '24h' ? '24 hours' : '7 days'}</span>
        <Tabs tabs={[['1h', '1 h'], ['24h', '24 h'], ['7d', '7 days']]} value={range} onChange={setRange} />
      </div>
      {pts.length < 2 ? (
        <p className="small muted">No trades in this range yet.</p>
      ) : (
        <svg viewBox={`0 0 ${W} ${H}`} className="price-chart" role="img" aria-label={`Price from ${unitPrice(pts[0].v)} to ${unitPrice(pts[pts.length - 1].v)}`}>
          {[0.25, 0.5, 0.75].map((k) => <line key={k} x1="0" x2={W} y1={H * k} y2={H * k} className="grid" />)}
          <path d={`${line}L${x(t1)},${H}L${x(t0)},${H}Z`} className={`area ${change >= 0 ? 'up' : 'down'}`} />
          <path d={line} className={`line ${change >= 0 ? 'up' : 'down'}`} />
          <text x={W - 4} y={12} textAnchor="end" className="lbl">{unitPrice(hi)}</text>
          <text x={W - 4} y={H - 4} textAnchor="end" className="lbl">{unitPrice(lo)}</text>
        </svg>
      )}
    </div>
  );
}

// The order book as depth bars: how much is waiting at each price.
function DepthBook({ bids, asks, npc }: { bids: any[]; asks: any[]; npc: { bid: number; ask: number } }) {
  const all = [...bids, ...asks];
  const max = Math.max(1, ...all.map((r) => r.qty));
  const row = (r: any, side: 'bid' | 'ask') => (
    <div key={side + r.price} className={`depth-row ${side}`}>
      <i style={{ width: `${(r.qty / max) * 100}%` }} />
      <span className="tnum">{unitPrice(r.price)}</span>
      <span className="tnum r">{num(r.qty)}</span>
    </div>
  );
  return (
    <div className="depth">
      <div>
        <div className="tiny muted">Buyers</div>
        {bids.map((r) => row(r, 'bid'))}
        <div className="depth-row bid npc"><span className="tnum">{unitPrice(npc.bid)}</span><span className="tiny muted r">market traders</span></div>
      </div>
      <div>
        <div className="tiny muted">Sellers</div>
        {asks.map((r) => row(r, 'ask'))}
        <div className="depth-row ask npc"><span className="tnum">{unitPrice(npc.ask)}</span><span className="tiny muted r">market traders</span></div>
      </div>
    </div>
  );
}
