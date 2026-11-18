import { useMemo, useState } from 'react';
import { rpc } from '../../lib/supabase';
import { money } from '../../lib/format';
import { useApi, Tabs } from '../components';

interface Point { day: string; net_worth: number }

// Net worth over the last 7 or 30 days, from the server's daily snapshots.
export function NetWorthChart() {
  const [days, setDays] = useState<'7' | '30'>('7');
  const { data } = useApi(() => rpc<Point[]>('net_worth_history', { p_days: Number(days) }).catch(() => [] as Point[]), [days]);
  const [hover, setHover] = useState<number | null>(null);
  const pts = data ?? [];
  const W = 400;
  const H = 120;
  const P = 6;
  const geo = useMemo(() => {
    if (pts.length < 2) return null;
    const vs = pts.map((p) => p.net_worth);
    let lo = Math.min(...vs);
    let hi = Math.max(...vs);
    if (hi - lo < 1000) {
      hi += 500;
      lo -= 500;
    }
    const x = (i: number) => P + (i / (pts.length - 1)) * (W - 2 * P);
    const y = (v: number) => P + (1 - (v - lo) / (hi - lo)) * (H - 2 * P);
    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.net_worth).toFixed(1)}`).join('');
    return { x, y, line, area: `${line}L${x(pts.length - 1)},${H}L${x(0)},${H}Z`, lo, hi };
  }, [pts]);
  if (!pts.length) return null;
  const first = pts[0].net_worth;
  const last = pts[pts.length - 1].net_worth;
  const change = last - first;
  const h = hover != null ? pts[hover] : null;
  return (
    <section className="card stack">
      <div className="row between">
        <div>
          <div className="small muted">Net worth, last {days} days</div>
          <b className={`tnum ${change >= 0 ? 'up' : 'down'}`}>
            {change >= 0 ? '▲' : '▼'} {money(Math.abs(change), { compact: true })} {first > 0 && `(${((change / first) * 100).toFixed(1)}%)`}
          </b>
        </div>
        <Tabs tabs={[['7', '7 days'], ['30', '30 days']]} value={days} onChange={setDays} />
      </div>
      {geo ? (
        <div className="chart-wrap">
          <svg
            viewBox={`0 0 ${W} ${H}`}
            className="nw-chart"
            role="img"
            aria-label={`Net worth went from ${money(first, { compact: true })} to ${money(last, { compact: true })}`}
            onPointerMove={(e) => {
              const r = (e.currentTarget as SVGElement).getBoundingClientRect();
              const k = (e.clientX - r.left) / r.width;
              setHover(Math.max(0, Math.min(pts.length - 1, Math.round(k * (pts.length - 1)))));
            }}
            onPointerLeave={() => setHover(null)}
          >
            <path d={geo.area} className="nw-area" />
            <path d={geo.line} className="nw-line" />
            {hover != null && <circle cx={geo.x(hover)} cy={geo.y(pts[hover].net_worth)} r="4" className="nw-dot" />}
          </svg>
          {h && (
            <div className="chart-tip small">
              {new Date(h.day).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}: <b className="tnum">{money(h.net_worth, { compact: true })}</b>
            </div>
          )}
        </div>
      ) : (
        <p className="small muted">Your chart starts tomorrow: the game saves your net worth once a day.</p>
      )}
    </section>
  );
}
