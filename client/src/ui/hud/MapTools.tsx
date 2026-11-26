import { useState } from 'react';
import { useGame } from '../../lib/store';
import { Icon } from '../Icon';

// One expandable column for the map buttons: home, land, heat map, survey.
export function MapTools({ heat, onHeat, onFindMe }: { heat: boolean; onHeat: () => void; onFindMe: () => void }) {
  const mode = useGame((s) => s.mode);
  const set = useGame((s) => s.set);
  const [openTools, setOpen] = useState(false);
  const me = useGame((s) => s.me);
  const toggle = (k: 'land' | 'survey') => set({ mode: mode.kind === k ? { kind: 'walk' } : { kind: k } });
  const anyOn = heat || mode.kind === 'land' || mode.kind === 'survey';
  const tool = (label: string, icon: string, on: boolean, fn: () => void) => (
    <button className={`fab ${on ? 'on' : ''}`} onClick={fn} aria-label={label} aria-pressed={on} title={label}>
      <Icon name={icon} size={24} />
      <span className="fab-label">{label}</span>
    </button>
  );
  return (
    <div className={`fabs ${openTools ? 'open' : ''}`}>
      {openTools && (
        <>
          {(me?.tier ?? 1) >= 4 && tool('Survey for minerals', 'mine', mode.kind === 'survey', () => toggle('survey'))}
          {tool('Foot traffic', 'heat', heat, onHeat)}
          {tool('Land and plots', 'land', mode.kind === 'land', () => toggle('land'))}
        </>
      )}
      {tool('Back to the square', 'locate', false, onFindMe)}
      <button className={`fab main ${anyOn && !openTools ? 'on' : ''}`} onClick={() => setOpen(!openTools)} aria-expanded={openTools} aria-label={openTools ? 'Hide map tools' : 'Map tools'}>
        <Icon name={openTools ? 'close' : 'tools'} size={24} />
      </button>
    </div>
  );
}
