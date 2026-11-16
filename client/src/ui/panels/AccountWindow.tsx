import { useState } from 'react';
import { rpc, supabase } from '../../lib/supabase';
import { useGame, act, catalog } from '../../lib/store';
import { date, money, num, ringFor } from '../../lib/format';
import { Window, Tabs, useApi, Loading, Stat, Avatar, Field, Confirm } from '../components';
import { refreshMe } from '../common';

type Tab = 'overview' | 'profile' | 'referrals' | 'notifications' | 'privacy' | 'security' | 'danger';

export default function AccountWindow() {
  const [tab, setTab] = useState<Tab>('overview');
  return (
    <Window title="Account" icon="👤">
      <div className="stack">
        <Tabs
          tabs={[['overview', 'Overview'], ['profile', 'Profile'], ['referrals', 'Referrals'], ['notifications', 'Notifications'], ['privacy', 'Privacy & data'], ['security', 'Security'], ['danger', 'Danger zone']]}
          value={tab}
          onChange={setTab}
        />
        {tab === 'overview' && <Overview />}
        {tab === 'profile' && <Profile />}
        {tab === 'referrals' && <Referrals />}
        {tab === 'notifications' && <Notifications />}
        {tab === 'privacy' && <Privacy />}
        {tab === 'security' && <Security />}
        {tab === 'danger' && <Danger />}
      </div>
    </Window>
  );
}

function Overview() {
  const me = useGame((s) => s.me)!;
  const cat = catalog();
  const { data: badges } = useApi(() => rpc<any[]>('my_badges'), []);
  const earned = new Set((badges ?? []).map((b) => b.badge));
  return (
    <div className="stack">
      <div className="row">
        <Avatar skin={me.skin} ring={ringFor(me.net_worth)} ringStyle={me.ring_style} size={64} />
        <div>
          <h3 style={{ margin: 0 }}>{me.display_name}</h3>
          <div className="small muted">{me.title ?? 'No title'} · Player #{me.player_no}</div>
          <div className="small muted">Member since {date(me.created_at)}</div>
        </div>
      </div>
      <div className="grid3">
        <Stat label="Days played" value={num(me.days_played)} />
        <Stat label="Loyalty points" value={num(me.loyalty_points)} sub="for cosmetics" />
        <Stat label="Tier" value={me.tier} sub={cat.tiers.find((t) => t.tier === me.tier)?.name} />
      </div>
      <strong>Badges</strong>
      <div className="badge-grid">
        {cat.badges.filter((b) => !b.id.startsWith('trophy_') || earned.has(b.id)).map((b) => (
          <div key={b.id} className={`badge-tile ${earned.has(b.id) ? '' : 'locked'}`} title={b.description}>
            <div className="ico">{b.icon}</div>
            <div>{b.name}</div>
          </div>
        ))}
      </div>
      <button className="btn ghost small" onClick={() => supabase.auth.signOut()}>Sign out</button>
    </div>
  );
}

function Profile() {
  const me = useGame((s) => s.me)!;
  const { data, reload } = useApi(() => rpc<any>('my_cosmetics'), []);
  const [name, setName] = useState(me.display_name);
  if (!data) return <Loading />;
  const items = (k: string) => data.items.filter((i: any) => i.kind === k);
  const save = async (args: any, msg: string) => {
    const r = await act(() => rpc('set_profile', args), msg);
    if (r) {
      await refreshMe();
      reload();
    }
  };
  const buy = async (id: string) => {
    if (await act(() => rpc('buy_cosmetic', { p_id: id }), 'Unlocked!')) {
      await refreshMe();
      reload();
    }
  };
  const lockText = (i: any) => (i.requires_badge ? `Earn: ${catalog().badges.find((b) => b.id === i.requires_badge)?.name}` : i.requires_tier ? `Tier ${i.requires_tier}` : `${i.points} pts`);
  return (
    <div className="stack">
      <div className="card stack">
        <Field label="Display name" hint="3 to 20 characters. You can rename twice a day at most.">
          <input className="input" value={name} maxLength={20} onChange={(e) => setName(e.target.value)} />
        </Field>
        <button className="btn small" disabled={name === me.display_name} onClick={() => save({ p_name: name }, 'Name changed.')}>Save name</button>
      </div>
      <strong>Skin</strong>
      <div className="skins">
        {items('skin').map((i: any) => (
          <button key={i.id} className={me.skin === i.id ? 'on' : ''} onClick={() => (i.owned ? save({ p_skin: i.id }, 'Skin changed.') : i.points > 0 ? buy(i.id) : undefined)} disabled={!i.owned && !(i.points > 0)}>
            <Avatar skin={i.id} ring={ringFor(me.net_worth)} size={44} />
            <span>{i.name}</span>
            {!i.owned && <span className="tiny muted">{lockText(i)}</span>}
          </button>
        ))}
      </div>
      <strong>Title</strong>
      <div className="row wrap" style={{ gap: 6 }}>
        <button className={`chip ${!me.title ? 'green' : ''}`} style={{ border: 0, cursor: 'pointer' }} onClick={() => save({ p_title: '' }, 'Title removed.')}>None</button>
        {items('title').map((i: any) => (
          <button key={i.id} className={`chip ${me.title === i.name ? 'green' : ''}`} style={{ border: 0, cursor: i.owned || i.points ? 'pointer' : 'default', opacity: i.owned ? 1 : 0.6 }}
            onClick={() => (i.owned ? save({ p_title: i.id }, 'Title set.') : i.points > 0 ? buy(i.id) : undefined)}>
            {i.name}{!i.owned && ` · ${lockText(i)}`}
          </button>
        ))}
      </div>
      <strong>Ring style</strong>
      <p className="small muted">Your ring’s colour shows your net worth: bronze from $50k, silver $500k, gold $5M, diamond $50M.</p>
      <div className="row wrap" style={{ gap: 6 }}>
        {items('ring_style').map((i: any) => (
          <button key={i.id} className={`chip ${me.ring_style === i.id ? 'green' : ''}`} style={{ border: 0, cursor: 'pointer', opacity: i.owned ? 1 : 0.6 }}
            onClick={() => (i.owned ? save({ p_ring_style: i.id }, 'Ring changed.') : buy(i.id))}>
            {i.name}{!i.owned && ` · ${i.points} pts`}
          </button>
        ))}
      </div>
      <p className="tiny muted">You have {num(data.points)} loyalty points. You earn {catalog().config.loyalty_per_day} for each day you play. Cosmetics never give an advantage.</p>
    </div>
  );
}

function Referrals() {
  const { data } = useApi(() => rpc<any>('my_referrals'), []);
  if (!data) return <Loading />;
  const link = `${window.location.origin}${window.location.pathname}#/r/${data.code}`;
  const share = async () => {
    if (navigator.share) await navigator.share({ title: 'CranCapital', text: 'Build a business empire on a real map with me in CranCapital.', url: link }).catch(() => {});
    else {
      await navigator.clipboard.writeText(link);
      useGame.getState().toast('Link copied.', 'success');
    }
  };
  return (
    <div className="stack">
      <p>Invite friends with your link. Each friend who plays at least 2 days counts for this month’s referral race.</p>
      <div className="card row between">
        <code className="ellipsis small">{link}</code>
        <div className="row">
          <button className="btn small ghost" onClick={async () => { await navigator.clipboard.writeText(link); useGame.getState().toast('Link copied.', 'success'); }}>Copy</button>
          <button className="btn small" onClick={share}>Share</button>
        </div>
      </div>
      <div className="grid3">
        <Stat label="This month" value={num(data.this_month)} />
        <Stat label="All time" value={num(data.total)} />
        <Stat label="Not counted yet" value={num(data.pending)} sub="played under 2 days" />
      </div>
      {data.trophies.length > 0 && (
        <div className="card">
          <strong>Trophies</strong>
          {data.trophies.map((t: any, i: number) => <div key={i} className="small">{catalog().badges.find((b) => b.id === t.badge)?.icon} {catalog().badges.find((b) => b.id === t.badge)?.name} · {t.month}</div>)}
        </div>
      )}
    </div>
  );
}

function Toggle({ k, label, hint }: { k: string; label: string; hint: string }) {
  const me = useGame((s) => s.me)!;
  const on = !!me.prefs?.[k];
  return (
    <label className="check card">
      <input
        type="checkbox"
        checked={on}
        onChange={async (e) => {
          const prefs = await act(() => rpc<any>('set_prefs', { p_prefs: { [k]: e.target.checked } }));
          if (prefs) useGame.setState({ me: { ...me, prefs } });
        }}
      />
      <span><b>{label}</b><br /><span className="small muted">{hint}</span></span>
    </label>
  );
}

function Notifications() {
  return (
    <div className="stack">
      <p className="small muted">Email notifications are all off unless you turn them on. In-game notifications always show in the bell.</p>
      <Toggle k="notify_launch" label="Launch news" hint="One email when new cities or big features open." />
      <Toggle k="notify_digest" label="Weekly market digest" hint="A short weekly email with prices and your earnings." />
      <Toggle k="notify_events" label="Events" hint="An email when festivals and other events start." />
      <Toggle k="hide_crowds" label="Hide street crowds" hint="Turn off the animated pedestrians if your device struggles." />
    </div>
  );
}

function Privacy() {
  const [busy, setBusy] = useState(false);
  return (
    <div className="stack">
      <Toggle k="analytics" label="Help improve the game" hint="Allow anonymous usage statistics. Off by default; the game works the same either way." />
      <div className="card stack">
        <strong>Download my data</strong>
        <p className="small muted">A copy of everything the game holds about you: profile, ledger, businesses, messages, posts and more, as a JSON file.</p>
        <button
          className="btn small"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            const data = await act(() => rpc('download_my_data'));
            setBusy(false);
            if (!data) return;
            const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
            const a = document.createElement('a');
            a.href = url;
            a.download = 'crancapital-my-data.json';
            a.click();
            URL.revokeObjectURL(url);
          }}
        >
          Download
        </button>
      </div>
      <p className="small"><a href="#/legal/privacy" target="_blank">Read the privacy policy</a></p>
    </div>
  );
}

function Security() {
  const { data } = useApi(() => rpc<any[]>('my_sessions'), []);
  const { data: mod } = useApi(() => rpc<any>('my_moderation'), []);
  return (
    <div className="stack">
      <strong>Signed-in devices</strong>
      {!data ? <Loading /> : data.length === 0 ? <p className="small muted">No session details available.</p> : (
        <table className="list">
          <tbody>
            {data.map((s) => (
              <tr key={s.id}><td className="small">{(s.user_agent ?? 'Unknown device').slice(0, 60)}</td><td className="small muted">{s.ip}</td><td className="small muted">{date(s.updated_at ?? s.created_at)}</td></tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="row">
        <button className="btn small ghost" onClick={async () => { await supabase.auth.signOut({ scope: 'others' }); useGame.getState().toast('Signed out everywhere else.', 'success'); }}>Sign out other devices</button>
        <button className="btn small" onClick={() => supabase.auth.signOut()}>Sign out</button>
      </div>
      {mod && mod.history.length > 0 && (
        <div className="card">
          <strong className="small">Moderation history</strong>
          {mod.history.map((h: any, i: number) => <div key={i} className="small">{date(h.at)} · {h.action}: {h.reason}</div>)}
        </div>
      )}
    </div>
  );
}

function Danger() {
  const me = useGame((s) => s.me)!;
  const [text, setText] = useState('');
  const [confirm, setConfirm] = useState(false);
  return (
    <div className="stack">
      <div className="notice red">
        Deleting your account removes your email, name, messages and other personal data (fully within 30 days). Your businesses stay on the map as
        abandoned buildings. Your {money(me.cash)} and everything you own are lost. This can’t be undone.
      </div>
      <Field label={`Type your display name (${me.display_name}) to confirm`}>
        <input className="input" value={text} onChange={(e) => setText(e.target.value)} />
      </Field>
      <button className="btn danger" disabled={text.trim().toLowerCase() !== me.display_name.toLowerCase()} onClick={() => setConfirm(true)}>Delete my account</button>
      {confirm && (
        <Confirm
          title="Delete your account for good?"
          body="Last chance: this can’t be undone."
          confirm="Delete"
          danger
          onCancel={() => setConfirm(false)}
          onConfirm={async () => {
            if (await act(() => rpc('delete_account', { p_confirm: text }), 'Your account was deleted.')) {
              await supabase.auth.signOut();
              window.location.hash = '/';
            }
          }}
        />
      )}
    </div>
  );
}
