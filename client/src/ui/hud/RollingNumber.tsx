import { useEffect, useRef, useState } from 'react';
import { money } from '../../lib/format';
import { useSettings } from '../../lib/settings';

// Cash that rolls up smoothly to its new value instead of jumping. Digits are
// even-width so the number doesn't jiggle while it counts.
export function RollingMoney({ value, cents = false, className }: { value: number; cents?: boolean; className?: string }) {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  const raf = useRef(0);
  const reduce = useSettings((s) => s.reduceMotion);
  useEffect(() => {
    cancelAnimationFrame(raf.current);
    if (reduce) {
      setShown(value);
      return;
    }
    const start = performance.now();
    const a = from.current;
    const diff = value - a;
    const dur = Math.min(1400, 350 + Math.log10(1 + Math.abs(diff) / 1000) * 260);
    const step = (t: number) => {
      const k = Math.min(1, (t - start) / dur);
      const e = 1 - Math.pow(1 - k, 3);
      const v = Math.round(a + diff * e);
      from.current = v;
      setShown(v);
      if (k < 1) raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf.current);
  }, [value, reduce]);
  return <span className={`tnum ${className ?? ''}`}>{money(shown, { cents })}</span>;
}

// Cash that's always ticking: it counts up (or down) every moment at your
// income rate, between the server's real figures. When the server's figure
// arrives it never jumps backwards for income already shown; spending shows
// straight away.
export function LiveMoney({ value, perHour, className }: { value: number; perHour: number; className?: string }) {
  const el = useRef<HTMLSpanElement>(null);
  const reduce = useSettings((s) => s.reduceMotion);
  const st = useRef({ base: value, at: performance.now(), server: value, rate: perHour / 3600_000 });
  const shownAt = (t: number) => {
    const s = st.current;
    // Don't run more than two minutes ahead of the last real figure.
    const ahead = Math.max(-Math.abs(s.rate) * 120_000, Math.min(Math.abs(s.rate) * 120_000, s.rate * (t - s.at)));
    return s.base + ahead;
  };
  useEffect(() => {
    const now = performance.now();
    const s = st.current;
    const shown = shownAt(now);
    const diff = value - s.server;
    if (diff < 0) s.base = shown + diff; // spent: show it at once
    else s.base = Math.max(shown, value); // earned: catch up without going backwards
    s.at = now;
    s.server = value;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  useEffect(() => {
    const now = performance.now();
    st.current.base = shownAt(now);
    st.current.at = now;
    st.current.rate = perHour / 3600_000;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [perHour]);
  useEffect(() => {
    let raf = 0;
    let last = 0;
    const cents = Math.abs(perHour) < 36_000_000; // under $10 a second: show the cents ticking
    const draw = (t: number) => {
      raf = requestAnimationFrame(draw);
      if (t - last < (reduce ? 1000 : 100)) return;
      last = t;
      if (el.current) el.current.textContent = money(Math.round(shownAt(t)), { cents });
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [perHour, reduce]);
  return <span ref={el} className={`tnum ${className ?? ''}`}>{money(value, { cents: Math.abs(perHour) < 36_000_000 })}</span>;
}

// "+$0.42 a second", with a coin floating up now and then.
export function PerSecond({ perHour }: { perHour: number }) {
  const reduce = useSettings((s) => s.reduceMotion);
  const [coins, setCoins] = useState<number[]>([]);
  const perSec = perHour / 3600;
  useEffect(() => {
    if (reduce || perSec <= 0) return;
    let n = 0;
    const i = setInterval(() => {
      const id = ++n;
      setCoins((c) => [...c.slice(-3), id]);
      setTimeout(() => setCoins((c) => c.filter((x) => x !== id)), 1400);
    }, 1500);
    return () => clearInterval(i);
  }, [reduce, perSec > 0]);
  const txt = money(Math.abs(perSec), { cents: Math.abs(perSec) < 100000 });
  return (
    <span className={`per-second ${perSec < 0 ? 'down' : 'up'}`}>
      {perSec < 0 ? '−' : '+'}{txt} a second
      {coins.map((id) => <i key={id} className="sec-coin" aria-hidden>+{txt}</i>)}
    </span>
  );
}

