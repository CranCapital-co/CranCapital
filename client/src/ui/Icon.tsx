import { memo } from 'react';
import { BUSINESS_ICON, FITOUT_ICON, GOOD_ICONS, UI_ICONS, spriteMarkup } from './icons';
import { catalog } from '../lib/store';
import { BUSINESS_COLORS } from '../map/icons';

// The one sprite every icon points into. Mounted once, at the top of the app.
export const IconSprite = memo(function IconSprite() {
  return <svg aria-hidden width="0" height="0" style={{ position: 'absolute', width: 0, height: 0, overflow: 'hidden' }} dangerouslySetInnerHTML={{ __html: spriteMarkup() }} />;
});

export type IconName = keyof typeof UI_ICONS;

export function Icon({ name, size = 22, accent, className, label }: { name: string; size?: number; accent?: string; className?: string; label?: string }) {
  const id = UI_ICONS[name] ? name : 'box';
  return (
    <svg
      className={`icon ${className ?? ''}`}
      width={size}
      height={size}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      style={accent ? ({ '--accent': accent } as React.CSSProperties) : undefined}
    >
      <use href={`#i-${id}`} />
    </svg>
  );
}

export function GoodIcon({ id, size = 22 }: { id: string; size?: number }) {
  if (!GOOD_ICONS[id]) return <Icon name="box" size={size} />;
  return (
    <svg className="icon good" width={size} height={size} aria-hidden>
      <use href={`#g-${id}`} />
    </svg>
  );
}

// A business type's icon in its tier colour (a picture of its 3D model once
// those are rendered; see world3d/thumbnails).
export function BizIcon({ kind, tier, size = 22 }: { kind: string; tier?: number; size?: number }) {
  return <Icon name={BUSINESS_ICON[kind] ?? 'shop'} size={size} accent={tier ? BUSINESS_COLORS[tier] : undefined} />;
}

// A menu item shows the good it's mostly made from (salad: lettuce, sofa: furniture).
export function MenuIcon({ id, size = 22 }: { id: string; size?: number }) {
  const mi = catalog()?.menu_items.find((m) => m.id === id);
  const main = mi ? Object.entries(mi.ingredients).sort((a, b) => (b[1] as number) - (a[1] as number))[0]?.[0] : null;
  return main ? <GoodIcon id={main} size={size} /> : <Icon name="restaurant" size={size} />;
}

export function FitoutIcon({ id, size = 20 }: { id: string; size?: number }) {
  return <Icon name={FITOUT_ICON[id] ?? 'box'} size={size} accent="var(--brand-2)" />;
}

const MEDAL = ['#e8b23a', '#b8c0c8', '#c98a4a'];
export function RankMedal({ rank }: { rank: number }) {
  return <Icon name="medal" size={22} accent={MEDAL[rank - 1]} label={`Number ${rank}`} />;
}
