import { useEffect } from 'react';
import { rpc } from '../../lib/supabase';
import { useGame } from '../../lib/store';
import { ago } from '../../lib/format';
import { Window, useApi, Loading, Empty } from '../components';
import { Icon } from '../Icon';
import { NOTIFY_ICON } from '../icons';


export default function NotificationsWindow() {
  const me = useGame((s) => s.me)!;
  const open = useGame((s) => s.open);
  const { data } = useApi(() => rpc<any[]>('my_notifications'), []);
  useEffect(() => {
    if (me.unread > 0) rpc('mark_notifications_read').then(() => useGame.setState({ me: { ...me, unread: 0 } })).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <Window title="Notifications" icon="bell">
      {!data ? <Loading /> : data.length === 0 ? <Empty icon="bellOff" title="Nothing yet">Sales milestones, stock warnings, orders and messages show up here.</Empty> : (
        <div className="stack tight">
          {data.map((n) => (
            <button
              key={n.id}
              className="card click row top"
              style={{ textAlign: 'left', borderColor: n.read ? undefined : 'var(--gold)' }}
              onClick={() => {
                if (n.data?.business) open('business', { id: n.data.business });
                else if (n.data?.building) open('property', { building: n.data.building });
                else if (n.data?.post) open('community', { tab: 'boards' });
                else if (n.data?.player_no) open('profile', { player_no: n.data.player_no });
                else if (n.kind === 'order') open('inventory');
              }}
            >
              <Icon name={NOTIFY_ICON[n.kind] ?? 'bell'} size={26} accent="var(--gold)" />
              <div className="grow">
                <strong className="small">{n.title}</strong>
                {n.body && <div className="small muted">{n.body}</div>}
                <div className="tiny muted">{ago(n.at)}</div>
              </div>
            </button>
          ))}
        </div>
      )}
    </Window>
  );
}
