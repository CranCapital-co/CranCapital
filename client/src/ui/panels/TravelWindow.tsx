import { rpc } from '../../lib/supabase';
import { useGame, act, catalog } from '../../lib/store';
import { localTime } from '../../lib/format';
import { Window, useApi } from '../components';
import type { Me } from '../../lib/types';
import { Icon } from '../Icon';

// Every city at a glance: switching is instant and free (there's no
// character to fly around, just your view of the world).
export default function TravelWindow() {
  const me = useGame((s) => s.me)!;
  const cat = catalog();
  const { data: events } = useApi(() => rpc<any[]>('world_events'), []);
  const { data: mine } = useApi(() => rpc<any[]>('my_businesses'), []);
  return (
    <Window title="Cities" icon="skyline">
      <div className="stack">
        <p className="small muted">Look after your businesses from anywhere. To open new ones in a city, switch to it.</p>
        {cat.cities.map((c) => {
          const here = c.id === me.city_id;
          const ev = events?.filter((e) => e.city_id === c.id) ?? [];
          const n = mine?.filter((b) => b.city_id === c.id).length ?? 0;
          return (
            <div key={c.id} className="card stack">
              <div className="row between">
                <div>
                  <strong>{c.name}</strong> <span className="small muted">{c.country}</span>
                  <div className="small muted">{localTime(c.tz)} local · {c.climate}{n ? ` · you own ${n} business${n > 1 ? 'es' : ''} here` : ''}</div>
                </div>
                {here ? (
                  <span className="chip green">You’re here</span>
                ) : (
                  <button
                    className="btn small"
                    onClick={async () => {
                      const m = await act(() => rpc<Me>('travel', { p_city: c.id }));
                      if (m) {
                        useGame.setState({ me: m, pos: null });
                        useGame.getState().close();
                      }
                    }}
                  >
                    Go to {c.name}
                  </button>
                )}
              </div>
              {ev.map((e) => (
                <div key={e.id} className="notice small"><Icon name="event" size={16} accent="var(--coral)" /> <b>{e.title}</b> {e.active ? '(on now)' : '(soon)'} — {e.body}</div>
              ))}
            </div>
          );
        })}
      </div>
    </Window>
  );
}
