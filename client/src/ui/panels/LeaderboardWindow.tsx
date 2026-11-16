import { useState } from 'react';
import { rpc } from '../../lib/supabase';
import { useGame, catalog } from '../../lib/store';
import { money, num } from '../../lib/format';
import { Window, Tabs, useApi, Loading, Avatar, Empty } from '../components';

type Kind = 'richest' | 'landowners' | 'exporters' | 'monthly' | 'referrals';

export default function LeaderboardWindow() {
  const [kind, setKind] = useState<Kind>('richest');
  const [city, setCity] = useState<string>('');
  const open = useGame((s) => s.open);
  const { data } = useApi(() => rpc<any>('leaderboard', { p_kind: kind, p_city: city || null }), [kind, city], 60000);
  const perCity = kind === 'richest' || kind === 'landowners' || kind === 'exporters';
  return (
    <Window title="Leaderboards" icon="🏆">
      <div className="stack">
        <Tabs tabs={[['richest', 'Richest'], ['landowners', 'Landowners'], ['exporters', 'Exporters'], ['monthly', 'This month'], ['referrals', 'Referral race']]} value={kind} onChange={(k) => { setKind(k); if (k === 'monthly' || k === 'referrals') setCity(''); }} />
        {perCity && (
          <select className="input" value={city} onChange={(e) => setCity(e.target.value)}>
            <option value="">Worldwide</option>
            {catalog().cities.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        )}
        <p className="small muted">
          {kind === 'richest' && (city ? 'Value of businesses and property in this city.' : 'Net worth: cash, businesses, property and goods, minus debts.')}
          {kind === 'landowners' && 'Value of plots and buildings owned.'}
          {kind === 'exporters' && `Exports sold through ports this month (${data?.month ?? ''}).`}
          {kind === 'monthly' && `Net worth gained since the start of ${data?.month ?? 'the month'}. Starts fresh every month.`}
          {kind === 'referrals' && `Friends you invited this month who played at least 2 days. The top four win Diamond, Gold, Silver and Bronze trophies (cosmetic).`}
        </p>
        {!data ? <Loading /> : data.rows.length === 0 ? <Empty icon="🏁" title="Nobody on this board yet" /> : (
          <table className="list">
            <tbody>
              {data.rows.map((r: any) => (
                <tr key={r.player_no} className="click" style={r.me ? { background: 'var(--gold-soft)' } : undefined} onClick={() => open('profile', { player_no: r.player_no })}>
                  <td style={{ width: 36 }} className="num"><b>{r.rank <= 3 ? ['🥇', '🥈', '🥉'][r.rank - 1] : r.rank}</b></td>
                  <td><div className="row"><Avatar skin={r.skin} ring={r.ring} size={28} /><span>{r.name}{r.title && <span className="tiny muted"> · {r.title}</span>}</span></div></td>
                  <td className="r num">{kind === 'referrals' ? num(r.score) : money(r.score, { compact: true })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Window>
  );
}
