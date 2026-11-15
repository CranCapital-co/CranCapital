import { useState } from 'react';
import { rpc } from '../../lib/supabase';
import { useGame, act, catalog, cityName } from '../../lib/store';
import { date, money, num } from '../../lib/format';
import { Window, useApi, Loading, Avatar, Stat, Field, Modal } from '../components';

export default function ProfileWindow({ params }: { params: { player_no: number } }) {
  const { data: p, reload } = useApi(() => rpc<any>('public_profile', { p_player_no: params.player_no }), [params.player_no]);
  const open = useGame((s) => s.open);
  const [report, setReport] = useState(false);
  const [reason, setReason] = useState('harassment');
  const [details, setDetails] = useState('');
  const cat = catalog();
  if (!p) return <Window title="Player"><Loading /></Window>;
  return (
    <Window title={p.name} icon="👤">
      <div className="stack">
        <div className="row">
          <Avatar skin={p.skin} ring={p.ring} ringStyle={p.ring_style} size={72} />
          <div>
            <h3 style={{ margin: 0 }}>{p.name}</h3>
            <div className="small muted">{p.title ?? ''} {p.title && '·'} Player #{p.player_no}</div>
            <div className="small muted">Member since {date(p.member_since)} · {num(p.days_played)} days played</div>
            {p.city_id && <div className="small">{p.online ? <span className="good">● online</span> : 'offline'} · in {cityName(p.city_id)}</div>}
          </div>
        </div>
        {p.status === 'banned' && <div className="notice red small">This account is banned.</div>}
        <div className="grid3">
          <Stat label="Net worth" value={money(p.net_worth, { compact: true })} sub={`rank #${p.rank}`} />
          <Stat label="Businesses" value={num(p.businesses)} />
          <Stat label="Property" value={`${num(p.buildings)} 🏢 ${num(p.plots)} 🗺️`} />
        </div>
        <div className="row wrap" style={{ gap: 6 }}>
          {p.badges.map((b: any, i: number) => {
            const meta = cat.badges.find((x) => x.id === b.badge);
            return <span key={i} className="chip" title={meta?.description}>{meta?.icon} {meta?.name}</span>;
          })}
        </div>
        {!p.me && (
          <div className="row wrap">
            {!p.is_friend && <button className="btn small" onClick={async () => { await act(() => rpc<any>('friend_request', { p_player_no: p.player_no }), (r) => (r.status === 'accepted' ? 'You’re now friends.' : 'Friend request sent.')); reload(); }}>Add friend</button>}
            <button className="btn small ghost" onClick={async () => { const r = await act(() => rpc<any>('open_dm', { p_player_no: p.player_no })); if (r) open('community', { tab: 'chat', channel: r.channel_id }); }}>Message</button>
            <button className="btn small ghost" onClick={async () => { await act(() => rpc('block_player', { p_player_no: p.player_no, p_block: !p.blocked }), p.blocked ? 'Unblocked.' : 'Blocked. You won’t see their messages.'); reload(); }}>{p.blocked ? 'Unblock' : 'Block'}</button>
            <button className="btn small ghost" onClick={() => setReport(true)}>Report</button>
          </div>
        )}
        {report && (
          <Modal title={`Report ${p.name}`} onClose={() => setReport(false)}>
            <div className="stack">
              <Field label="Reason">
                <select className="input" value={reason} onChange={(e) => setReason(e.target.value)}>
                  <option value="harassment">Harassment or bullying</option>
                  <option value="hate">Hate or slurs</option>
                  <option value="name">Offensive name</option>
                  <option value="impersonation">Pretending to be someone else</option>
                  <option value="cheating">Cheating or bots</option>
                  <option value="scam">Scam or off-site trading</option>
                  <option value="other">Something else</option>
                </select>
              </Field>
              <Field label="Details (optional)"><textarea className="input" value={details} maxLength={1000} onChange={(e) => setDetails(e.target.value)} /></Field>
              <button className="btn danger" onClick={async () => { if (await act(() => rpc<any>('report', { p_kind: 'player', p_target: p.player_no, p_reason: reason, p_details: details || null }), (r) => r.message)) setReport(false); }}>Send report</button>
            </div>
          </Modal>
        )}
      </div>
    </Window>
  );
}
