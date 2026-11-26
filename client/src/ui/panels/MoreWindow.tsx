import { useGame } from '../../lib/store';
import { useSettings } from '../../lib/settings';
import { Window } from '../components';
import { Icon } from '../Icon';

export default function MoreWindow() {
  const me = useGame((s) => s.me)!;
  const open = useGame((s) => s.open);
  const { sound, setSound } = useSettings();
  const row = (icon: string, title: string, sub: string, fn: () => void) => (
    <button className="card click menu-link" onClick={fn}>
      <Icon name={icon} size={28} accent="var(--brand-2)" />
      <span className="grow">
        <strong>{title}</strong>
        <span className="small muted">{sub}</span>
      </span>
      <Icon name="next" size={18} />
    </button>
  );
  return (
    <Window title="More" icon="more">
      <div className="stack">
        {row('book', 'Help', 'How everything works, tier by tier', () => open('wiki'))}
        {row('account', 'Account', 'Your look, sound, graphics, privacy and data', () => open('account'))}
        {row('skyline', 'Cities', 'Switch to another city, instantly', () => open('travel'))}
        {row('bell', 'Notifications', 'Everything that happened while you were busy', () => open('notifications'))}
        {row('camera', 'Photo mode', 'Hide the interface, set the time of day, save a picture', () => window.dispatchEvent(new CustomEvent('cc:photo')))}
        {me.role !== 'player' && row('staff', 'Staff', 'Reports, moderation and events', () => open('mod'))}
        <div className="card soft row between">
          <span className="row">
            <Icon name={sound.muted ? 'mute' : 'sound'} />
            Sound
          </span>
          <button className="btn small ghost" onClick={() => setSound({ muted: !sound.muted })}>{sound.muted ? 'Turn on' : 'Turn off'}</button>
        </div>
        <p className="small muted center">
          <a className="link" href="#/legal/terms">Terms</a> · <a className="link" href="#/legal/privacy">Privacy</a> · <a className="link" href="#/legal/credits">Credits</a>
        </p>
      </div>
    </Window>
  );
}
