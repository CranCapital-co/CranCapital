import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useGame } from '../lib/store';
import { avatarDataUrl } from '../map/icons';
import { money } from '../lib/format';

// Load data from the API, reload on demand and when the game asks open
// windows to refresh (after actions, or every so often).
export function useApi<T>(fn: () => Promise<T>, deps: unknown[] = [], every = 0) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const refreshKey = useGame((s) => s.refreshKey);
  const alive = useRef(true);
  const load = useCallback(async () => {
    try {
      const r = await fn();
      if (alive.current) {
        setData(r);
        setError(null);
      }
    } catch (e: any) {
      if (alive.current) setError(e?.message ?? String(e));
    } finally {
      if (alive.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    alive.current = true;
    setLoading(true);
    load();
    if (!every) return () => { alive.current = false; };
    const t = setInterval(load, every);
    return () => {
      alive.current = false;
      clearInterval(t);
    };
  }, [load, refreshKey, every]);
  return { data, error, loading, reload: load, setData };
}

export function Window({ title, icon, children, onBack, wide, actions }: { title: ReactNode; icon?: string; children: ReactNode; onBack?: () => void; wide?: boolean; actions?: ReactNode }) {
  const close = useGame((s) => s.close);
  return (
    <aside className={`window ${wide ? 'wide' : ''}`} role="dialog" aria-label={typeof title === 'string' ? title : undefined}>
      <header className="window-head">
        {onBack && (
          <button className="btn ghost icon small" onClick={onBack} aria-label="Back">←</button>
        )}
        {icon && <span className="window-icon" aria-hidden>{icon}</span>}
        <h2 className="grow ellipsis">{title}</h2>
        {actions}
        <button className="btn ghost icon small" onClick={close} aria-label="Close">✕</button>
      </header>
      <div className="window-body scroll">{children}</div>
    </aside>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: [T, string][]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map(([k, label]) => (
        <button key={k} role="tab" aria-selected={value === k} className={value === k ? 'on' : ''} onClick={() => onChange(k)}>
          {label}
        </button>
      ))}
    </div>
  );
}

export function Modal({ children, onClose, title }: { children: ReactNode; onClose: () => void; title?: string }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true">
        {title && <h2>{title}</h2>}
        {children}
      </div>
    </div>
  );
}

export function Confirm({ title, body, confirm, danger, onConfirm, onCancel }: { title: string; body: ReactNode; confirm: string; danger?: boolean; onConfirm: () => void; onCancel: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={title} onClose={onCancel}>
      <div className="stack">
        <div>{body}</div>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn ghost" onClick={onCancel}>Cancel</button>
          <button
            className={`btn ${danger ? 'danger' : ''}`}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm();
              } finally {
                setBusy(false);
              }
            }}
          >
            {confirm}
          </button>
        </div>
      </div>
    </Modal>
  );
}

export function Toasts() {
  const toasts = useGame((s) => s.toasts);
  const dismiss = useGame((s) => s.dismissToast);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} onClick={() => dismiss(t.id)}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="stat">
      <span className="label">{label}</span>
      <span className="value">{value}</span>
      {sub && <span className="tiny muted">{sub}</span>}
    </div>
  );
}

export function Loading({ lines = 3 }: { lines?: number }) {
  return (
    <div className="stack">
      {Array.from({ length: lines }).map((_, i) => (
        <div key={i} className="skeleton" style={{ height: 18, width: `${90 - i * 12}%` }} />
      ))}
    </div>
  );
}

export function Empty({ icon, title, children }: { icon: string; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-icon" aria-hidden>{icon}</div>
      <strong>{title}</strong>
      {children && <div className="muted small">{children}</div>}
    </div>
  );
}

export function Avatar({ skin, ring, size = 48, ringStyle = 'standard' }: { skin: string; ring: string; size?: number; ringStyle?: string }) {
  const src = useMemo(() => avatarDataUrl(skin, ring, 56, ringStyle), [skin, ring, ringStyle]);
  return <img src={src} width={size} height={size} alt="" style={{ display: 'block' }} />;
}

export function Money({ v, sign, compact }: { v: number | null | undefined; sign?: boolean; compact?: boolean }) {
  const cls = sign && v ? (v > 0 ? 'good' : v < 0 ? 'bad' : '') : '';
  return <span className={`money ${cls}`}>{money(v, { sign, compact })}</span>;
}

// A tiny line chart.
export function Spark({ values, width = 120, height = 34, color = 'var(--brand-2)' }: { values: number[]; width?: number; height?: number; color?: string }) {
  if (values.length < 2) return <svg width={width} height={height} />;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * width},${height - 3 - ((v - min) / (max - min || 1)) * (height - 6)}`).join(' ');
  return (
    <svg width={width} height={height} aria-hidden>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" />
    </svg>
  );
}

// Bars for daily history.
export function Bars({ values, labels, height = 90, color = 'var(--brand-2)', format }: { values: number[]; labels: string[]; height?: number; color?: string; format: (v: number) => string }) {
  const max = Math.max(1, ...values);
  return (
    <div className="bars" style={{ height }}>
      {values.map((v, i) => (
        <div key={i} className="bar-col" title={`${labels[i]}: ${format(v)}`}>
          <div className="bar" style={{ height: `${(v / max) * 100}%`, background: color }} />
          <span className="tiny muted">{labels[i]}</span>
        </div>
      ))}
    </div>
  );
}

// Hourly candles with a price axis.
export function Candles({ candles, height = 180 }: { candles: { t: string; o: number; h: number; l: number; c: number; v: number }[]; height?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(360);
  useEffect(() => {
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width));
    if (ref.current) ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  const data = candles.slice(-72);
  if (!data.length) return <div ref={ref} className="muted small">No price history yet.</div>;
  const lo = Math.min(...data.map((c) => c.l));
  const hi = Math.max(...data.map((c) => c.h));
  const pad = (hi - lo) * 0.08 || hi * 0.05 || 1;
  const min = lo - pad;
  const max = hi + pad;
  const left = 0;
  const right = 56;
  const cw = Math.min(16, (w - left - right) / data.length);
  const y = (v: number) => 6 + (1 - (v - min) / (max - min)) * (height - 24);
  const ticks = [min + (max - min) * 0.15, (min + max) / 2, max - (max - min) * 0.15];
  return (
    <div ref={ref} style={{ width: '100%' }}>
      <svg width={w} height={height} role="img" aria-label="Price chart, last 3 days by hour">
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={left} x2={w - right} y1={y(t)} y2={y(t)} stroke="var(--line)" />
            <text x={w - right + 6} y={y(t) + 4} fontSize="11" fill="var(--muted)">{t >= 1000 ? `$${(t / 1000).toFixed(2)}` : `$${(t / 1000).toFixed(3)}`}</text>
          </g>
        ))}
        {data.map((c, i) => {
          const x = w - right - (data.length - i) * cw + cw / 2;
          const up = c.c >= c.o;
          const col = up ? 'var(--good)' : 'var(--bad)';
          return (
            <g key={i}>
              <line x1={x} x2={x} y1={y(c.h)} y2={y(c.l)} stroke={col} strokeWidth="1" />
              <rect x={x - Math.max(1, cw * 0.32)} width={Math.max(2, cw * 0.64)} y={Math.min(y(c.o), y(c.c))} height={Math.max(1.5, Math.abs(y(c.o) - y(c.c)))} fill={col} rx="1" />
            </g>
          );
        })}
        <text x={left} y={height - 4} fontSize="11" fill="var(--muted)">{new Date(data[0].t).toLocaleDateString('en-GB', { weekday: 'short', hour: '2-digit' })}</text>
        <text x={w - right} y={height - 4} fontSize="11" fill="var(--muted)" textAnchor="end">now</text>
      </svg>
    </div>
  );
}

export function Progress({ value, max, color = 'var(--brand-2)' }: { value: number; max: number; color?: string }) {
  const p = Math.max(0, Math.min(100, (value / (max || 1)) * 100));
  return (
    <div className="progress" role="progressbar" aria-valuenow={Math.round(p)} aria-valuemin={0} aria-valuemax={100}>
      <div style={{ width: `${p}%`, background: color }} />
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small className="muted">{hint}</small>}
    </label>
  );
}

// Dollar input that keeps mills internally.
export function DollarInput({ value, onChange, min = 0, step = 0.01 }: { value: number; onChange: (mills: number) => void; min?: number; step?: number }) {
  const [text, setText] = useState((value / 1000).toString());
  useEffect(() => setText((value / 1000).toString()), [value]);
  return (
    <div className="dollar">
      <span>$</span>
      <input
        className="input"
        inputMode="decimal"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const v = Number(e.target.value);
          if (!Number.isNaN(v) && v >= min) onChange(Math.round(v * 1000));
        }}
        step={step}
      />
    </div>
  );
}
