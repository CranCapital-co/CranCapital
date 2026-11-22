import { useGame } from '../../lib/store';
import { Icon } from '../Icon';

const EMPIRE = ['empire', 'businesses', 'business', 'property', 'inventory', 'bank'];
const PEOPLE = ['people', 'community', 'leaderboard', 'profile'];
const MORE = ['more', 'wiki', 'account', 'mod', 'travel'];

export function Dock({ glowBuild }: { glowBuild?: boolean }) {
  const win = useGame((s) => s.win);
  const open = useGame((s) => s.open);
  const id = win?.id ?? '';
  const item = (key: string, label: string, icon: string, on: boolean, primary = false) => (
    <button
      key={key}
      className={`${primary ? 'primary' : ''} ${on ? 'on' : ''} ${primary && glowBuild ? 'glow' : ''}`}
      aria-pressed={on}
      onClick={() => (on ? useGame.getState().close() : open(key as any))}
    >
      <Icon name={icon} size={28} accent={primary ? 'rgba(255,255,255,.35)' : undefined} />
      <span>{label}</span>
    </button>
  );
  return (
    <nav className="dock" aria-label="Game menu">
      {item('build', 'Build', 'build', id === 'build', true)}
      {item('empire', 'Empire', 'empire', EMPIRE.includes(id))}
      {item('market', 'Market', 'market', id === 'market')}
      {item('people', 'People', 'people', PEOPLE.includes(id))}
      {item('more', 'More', 'more', MORE.includes(id))}
    </nav>
  );
}
