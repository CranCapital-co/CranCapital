import { Modal, Money } from './components';
import { flagList } from './common';
import { useGame } from '../lib/store';
import { ago } from '../lib/format';

export default function AwayCard({ away, onClose }: { away: any; onClose: () => void }) {
  const open = useGame((s) => s.open);
  return (
    <Modal title="While you were away" onClose={onClose}>
      <div className="stack">
        <p className="muted">
          You were away for {away.hours} hours (since {ago(away.since)}).
          {away.paused && ' Your businesses paused after 24 hours offline and start again now.'}
        </p>
        <div className="card soft">
          <div className="row between">
            <strong>Net change</strong>
            <strong><Money v={away.net} sign /></strong>
          </div>
          <div className="away-flows" style={{ marginTop: 8 }}>
            {away.flows.slice(0, 8).map((f: any) => (
              <div key={f.kind} className="row between">
                <span>{f.label}</span>
                <Money v={f.amount} sign />
              </div>
            ))}
          </div>
        </div>
        {away.attention?.length > 0 && (
          <div className="stack tight">
            <strong>Needs attention</strong>
            {away.attention.map((a: any) => (
              <button key={a.business} className="card click row between" onClick={() => { onClose(); open('business', { id: a.business }); }}>
                <span>{a.name}</span>
                <span className="chip red">{flagList(a.flags)[0] ?? a.status}</span>
              </button>
            ))}
          </div>
        )}
        {away.notifications?.length > 0 && (
          <div className="stack tight">
            <strong>News</strong>
            {away.notifications.slice(0, 5).map((n: any) => (
              <div key={n.id} className="small">
                <b>{n.title}</b> {n.body && <span className="muted">— {n.body}</span>}
              </div>
            ))}
          </div>
        )}
        <button className="btn block" onClick={onClose}>Back to business</button>
      </div>
    </Modal>
  );
}
