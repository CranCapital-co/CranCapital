import { rpc } from '../../lib/supabase';
import { useGame } from '../../lib/store';
import { useApi } from '../components';
import { Icon } from '../Icon';
import { sound } from '../../audio/sound';
import { refreshMe } from '../common';

export interface Goal { id: number; kind: string; title: string; target: number; progress: number; reward_points: number; claimed: boolean; day: string }

// Three small goals a day that pay loyalty points.
export function DailyGoals() {
  const { data, reload } = useApi(() => rpc<Goal[]>('my_goals').catch(() => [] as Goal[]), [], 60000);
  const goals = data ?? [];
  if (!goals.length) return null;
  return (
    <section className="card stack">
      <strong className="row"><Icon name="flag" accent="var(--gold)" /> Today's goals</strong>
      {goals.map((g) => {
        const done = g.progress >= g.target;
        return (
          <div key={g.id} className={`goal ${g.claimed ? 'claimed' : ''}`}>
            <div className="row between">
              <span className={g.claimed ? 'muted' : ''}>{g.title}</span>
              {g.claimed ? (
                <span className="chip green"><Icon name="check" size={14} /> {g.reward_points} pts</span>
              ) : done ? (
                <button
                  className="btn tiny gold"
                  onClick={async () => {
                    try {
                      await rpc('claim_goal', { p_id: g.id });
                      sound.play('badge');
                      useGame.getState().toast(`Goal done: +${g.reward_points} loyalty points`, 'success');
                      reload();
                      refreshMe();
                    } catch (e: any) {
                      useGame.getState().toast(e.message, 'error');
                    }
                  }}
                >
                  Claim {g.reward_points} pts
                </button>
              ) : (
                <span className="small muted tnum">{Math.min(g.progress, g.target).toLocaleString()} / {g.target.toLocaleString()}</span>
              )}
            </div>
            <div className="progress"><div style={{ width: `${Math.min(100, (g.progress / g.target) * 100)}%`, background: done ? 'var(--good)' : 'var(--gold)' }} /></div>
          </div>
        );
      })}
    </section>
  );
}
