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
