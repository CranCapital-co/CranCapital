import { useState } from 'react';
import { rpc } from '../../lib/supabase';
import { useGame, act, catalog } from '../../lib/store';
import { ago } from '../../lib/format';
import { Window, Tabs, useApi, Loading, Empty, Field, Modal } from '../components';

export default function ModWindow() {
  const me = useGame((s) => s.me)!;
  const [tab, setTab] = useState<'reports' | 'illegal' | 'multi' | 'events' | 'log'>('reports');
  const { data, reload } = useApi(() => rpc<any>('mod_queue'), [], 30000);
  const { data: multi } = useApi(() => (tab === 'multi' ? rpc<any[]>('mod_multi_accounts') : Promise.resolve(null)), [tab]);
  const [acting, setActing] = useState<any>(null);
  const [eventCity, setEventCity] = useState('london');
  const [eventKind, setEventKind] = useState('festival');
  return (
    <Window title="Staff tools" icon="🛡️" wide>
      <div className="stack">
        <p className="small muted">Every decision is made by a person and carries a reason the player sees. Nothing is hidden silently.</p>
        <Tabs tabs={[['reports', `Reports (${data?.reports?.length ?? 0})`], ['illegal', `Illegal content (${data?.illegal?.length ?? 0})`], ['multi', 'Multi-accounts'], ['events', 'Events'], ['log', 'Log']]} value={tab} onChange={setTab} />
        {!data ? <Loading /> : tab === 'reports' ? (
          data.reports.length === 0 ? <Empty icon="✅" title="Queue is clear" /> : data.reports.map((r: any) => (
            <div key={r.id} className="card stack">
              <div className="row between">
                <strong>{r.reason} · {r.kind}</strong>
                <span className="tiny muted">{ago(r.created_at)}</span>
              </div>
              <div className="small">Reported: <b>{r.target?.name}</b> (#{r.target?.player_no}, {r.target?.status}) · {r.target_reports} reports total · by {r.reporter?.name}</div>
              {r.snapshot && <blockquote className="card soft small" style={{ whiteSpace: 'pre-wrap' }}>{r.snapshot}</blockquote>}
              {r.details && <div className="small muted">“{r.details}”</div>}
              {r.target_history.length > 0 && <div className="tiny muted">History: {r.target_history.map((h: any) => `${h.action} (${h.reason})`).join('; ')}</div>}
              <button className="btn small" onClick={() => setActing(r)}>Decide</button>
            </div>
          ))
        ) : tab === 'illegal' ? (
          data.illegal.length === 0 ? <Empty icon="✅" title="No reports" /> : data.illegal.map((r: any) => (
            <div key={r.id} className="card stack">
              <div className="row between"><strong>{r.location}</strong><span className="tiny muted">{ago(r.created_at)}</span></div>
              <div className="small" style={{ whiteSpace: 'pre-wrap' }}>{r.description}</div>
              {r.contact && <div className="tiny muted">Contact: {r.contact}</div>}
              <div className="row">
                <button className="btn small" onClick={async () => { const note = prompt('What did you do about it?'); if (note) { await act(() => rpc('mod_illegal_resolve', { p_id: r.id, p_status: 'actioned', p_resolution: note }), 'Marked as actioned.'); reload(); } }}>Actioned</button>
                <button className="btn small ghost" onClick={async () => { const note = prompt('Why dismiss it?'); if (note) { await act(() => rpc('mod_illegal_resolve', { p_id: r.id, p_status: 'dismissed', p_resolution: note }), 'Dismissed.'); reload(); } }}>Dismiss</button>
              </div>
            </div>
          ))
        ) : tab === 'multi' ? (
          !multi ? <Loading /> : multi.length === 0 ? <Empty icon="✅" title="No shared devices found" /> : multi.map((m: any, i: number) => (
            <div key={i} className="card small">
              {m.players.map((p: any) => `${p.name} (#${p.player_no})`).join(' & ')} · {m.shared_devices} shared device(s) · {m.trades_between} trades between them
            </div>
          ))
        ) : tab === 'events' ? (
          me.role !== 'admin' ? <p className="small muted">Only admins can start events.</p> : (
            <div className="card stack">
              <div className="grid2">
                <select className="input" value={eventCity} onChange={(e) => setEventCity(e.target.value)}>{catalog().cities.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
                <select className="input" value={eventKind} onChange={(e) => setEventKind(e.target.value)}>
                  {['festival', 'heatwave', 'rain', 'strike', 'food_week', 'sale_season', 'marathon'].map((k) => <option key={k} value={k}>{k.replace('_', ' ')}</option>)}
                </select>
              </div>
              <button className="btn small" onClick={() => act(() => rpc('admin_create_event', { p_city: eventCity, p_kind: eventKind, p_starts_in_minutes: 0 }), 'Event started.')}>Start now</button>
            </div>
          )
        ) : (
          data.recent_actions.map((a: any, i: number) => (
            <div key={i} className="small">{ago(a.at)} · <b>{a.staff}</b> {a.action} {a.target ? `→ ${a.target}` : ''}: {a.reason}</div>
          ))
        )}
      </div>
      {acting && <Decide report={acting} admin={me.role === 'admin'} onClose={() => { setActing(null); reload(); }} />}
    </Window>
  );
}

function Decide({ report, admin, onClose }: { report: any; admin: boolean; onClose: () => void }) {
  const [action, setAction] = useState('warn');
  const [reason, setReason] = useState('');
  const [hours, setHours] = useState(24);
  const content = ['message', 'post', 'comment', 'discord', 'business'].includes(report.kind);
  return (
    <Modal title="Decide on this report" onClose={onClose}>
      <div className="stack">
        <Field label="Action">
          <select className="input" value={action} onChange={(e) => setAction(e.target.value)}>
            <option value="dismiss">Dismiss (no action)</option>
            <option value="warn">Warn the player</option>
            {content && <option value="remove">Remove the content</option>}
            <option value="rename">Reset their display name</option>
            <option value="suspend">Suspend</option>
            {admin && <option value="ban">Ban</option>}
          </select>
        </Field>
        {action === 'suspend' && <Field label="Hours"><input className="input" type="number" min={1} max={2160} value={hours} onChange={(e) => setHours(Number(e.target.value))} /></Field>}
        <Field label="Reason (the player sees this)"><textarea className="input" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        <button
          className={`btn ${action === 'ban' || action === 'suspend' ? 'danger' : ''}`}
          disabled={reason.trim().length < 5}
          onClick={async () => {
            const r = await act(() => rpc('mod_action', {
              p_target_player_no: report.target?.player_no ?? null,
              p_action: action,
              p_reason: reason,
              p_hours: action === 'suspend' ? hours : null,
              p_report: report.id,
              p_content_kind: action === 'remove' ? report.kind : null,
              p_content_id: action === 'remove' ? report.target_id : null,
            }), 'Done.');
            if (r) onClose();
          }}
        >
          Confirm
        </button>
      </div>
    </Modal>
  );
}
