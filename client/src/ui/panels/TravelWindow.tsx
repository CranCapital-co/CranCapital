import { rpc } from '../../lib/supabase';
import { useGame, act, catalog } from '../../lib/store';
import { localTime, money } from '../../lib/format';
import { Window, useApi, Loading } from '../components';
import type { Me } from '../../lib/types';

export default function TravelWindow() {
  const me = useGame((s) => s.me)!;
  const cat = catalog();
  const { data: quotes } = useApi(async () => {
    const out: Record<string, any> = {};
    for (const c of cat.cities) if (c.id !== me.city_id) out[c.id] = await rpc('travel_quote', { p_city: c.id });
    return out;
  }, [me.city_id]);
  const { data: events } = useApi(() => rpc<any[]>('world_events'), []);
  return (
    <Window title="Travel" icon="✈️">
      <div className="stack">
        <p className="small muted">You can manage your businesses from anywhere. To open new ones, walk the streets of a city: fly there first. Your position is a game position only.</p>
        {cat.cities.map((c) => {
          const here = c.id === me.city_id;
          const q = quotes?.[c.id];
          const ev = events?.filter((e) => e.city_id === c.id) ?? [];
          return (
            <div key={c.id} className="card stack">
              <div className="row between">
                <div>
                  <strong>{c.name}</strong> <span className="small muted">{c.country}</span>
                  <div className="small muted">{localTime(c.tz)} local · {c.climate}</div>
                </div>
                {here ? (
                  <span className="chip green">You’re here</span>
                ) : !q ? (
                  <Loading lines={1} />
                ) : (
                  <button
                    className="btn small"
                    disabled={!!me.travel_to}
                    onClick={async () => {
                      const m = await act(() => rpc<Me>('travel', { p_city: c.id }), `Bon voyage! Landing in ${q.minutes} minutes.`);
                      if (m) useGame.setState({ me: m });
                    }}
                  >
                    Fly · {money(q.price, { cents: false })} · {q.minutes} min
                  </button>
                )}
              </div>
              {ev.map((e) => (
                <div key={e.id} className="notice small">🎉 <b>{e.title}</b> {e.active ? '(on now)' : '(soon)'} — {e.body}</div>
              ))}
            </div>
          );
        })}
      </div>
    </Window>
  );
}
