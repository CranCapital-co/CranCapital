import { useState } from 'react';
import { useGame } from '../../lib/store';
import { Icon } from '../Icon';

// One expandable column for the map buttons: find me, land, heat map, taxi.
export function MapTools({ heat, onHeat, onFindMe }: { heat: boolean; onHeat: () => void; onFindMe: () => void }) {
  const mode = useGame((s) => s.mode);
  const set = useGame((s) => s.set);
  const [openTools, setOpen] = useState(false);
  const toggle = (k: 'land' | 'taxi') => set({ mode: mode.kind === k ? { kind: 'walk' } : { kind: k } });
  const anyOn = heat || mode.kind === 'land' || mode.kind === 'taxi';
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
          {tool('Taxi', 'taxi', mode.kind === 'taxi', () => toggle('taxi'))}
          {tool('Foot traffic', 'heat', heat, onHeat)}
          {tool('Land and plots', 'land', mode.kind === 'land', () => toggle('land'))}
        </>
      )}
      {tool('Find me', 'locate', false, onFindMe)}
      <button className={`fab main ${anyOn && !openTools ? 'on' : ''}`} onClick={() => setOpen(!openTools)} aria-expanded={openTools} aria-label={openTools ? 'Hide map tools' : 'Map tools'}>
        <Icon name={openTools ? 'close' : 'tools'} size={24} />
      </button>
    </div>
  );
}
