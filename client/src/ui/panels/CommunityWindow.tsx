import { useEffect, useMemo, useRef, useState } from 'react';
import { rpc, supabase } from '../../lib/supabase';
import { subscribeChat } from '../../lib/realtime';
import { useGame, act, cityName } from '../../lib/store';
import { ago } from '../../lib/format';
import { Window, Tabs, useApi, Loading, Avatar, Empty, Field, Modal } from '../components';
import { Icon } from '../Icon';

type Tab = 'chat' | 'friends' | 'boards' | 'discord';

let filterCache: RegExp[] | null = null;
async function filters() {
  if (filterCache) return filterCache;
  try {
    const r = await rpc<any>('get_filter_patterns');
    // Server patterns use (?=...) lookahead; JS supports it.
    filterCache = (r.words as string[]).map((w) => new RegExp(w, 'gi'));
  } catch {
    filterCache = [];
  }
  return filterCache;
}
const LINK = /(https?:|www\.|[a-z0-9-]+\s*(\.|\[\s*dot\s*\]|\(\s*dot\s*\))\s*(com|net|org|io|gg|co|uk|me|tv|app|dev|xyz|info|biz|ru|de|fr|jp|sg|us|ly|to|be|link|site|online|shop|store|live|club|ai|so|fm|cc)([^a-z]|$)|discord\s*\.\s*gg|bit\s*\.\s*ly|t\.me\/)/i;

export default function CommunityWindow({ params }: { params?: { tab?: Tab; channel?: number } }) {
  const [tab, setTab] = useState<Tab>(params?.tab ?? 'chat');
  return (
    <Window title="Community" icon="chat" wide>
      <div className="stack" style={{ height: '100%' }}>
        <Tabs tabs={[['chat', 'Chat'], ['friends', 'Friends'], ['boards', 'Boards'], ['discord', 'Discord']]} value={tab} onChange={setTab} />
        {tab === 'chat' && <Chat initial={params?.channel} />}
        {tab === 'friends' && <Friends />}
        {tab === 'boards' && <Boards />}
        {tab === 'discord' && <Discord />}
      </div>
    </Window>
  );
}

function MessageMenu({ m, onClose }: { m: any; onClose: () => void }) {
  const open = useGame((s) => s.open);
  const [reason, setReason] = useState('harassment');
  return (
    <Modal title={`Message from ${m.author.name}`} onClose={onClose}>
      <div className="stack">
        <blockquote className="card soft small">{m.body}</blockquote>
        <button className="btn ghost" onClick={() => { onClose(); open('profile', { player_no: m.author.player_no }); }}>View profile</button>
        <Field label="Report this message">
          <select className="input" value={reason} onChange={(e) => setReason(e.target.value)}>
            <option value="harassment">Harassment or bullying</option>
            <option value="hate">Hate or slurs</option>
            <option value="spam">Spam</option>
            <option value="personal_info">Sharing someone’s personal details</option>
            <option value="scam">Scam or off-site trading</option>
            <option value="other">Something else</option>
          </select>
        </Field>
        <div className="row">
          <button className="btn danger" onClick={async () => { if (await act(() => rpc<any>('report', { p_kind: 'message', p_target: m.id, p_reason: reason }), (r) => r.message)) onClose(); }}>Report</button>
          <button className="btn ghost" onClick={async () => { if (await act(() => rpc('block_player', { p_player_no: m.author.player_no, p_block: true }), `${m.author.name} is blocked. You won’t see their messages.`)) onClose(); }}>Block {m.author.name}</button>
        </div>
      </div>
    </Modal>
  );
}

function Chat({ initial }: { initial?: number }) {
  const me = useGame((s) => s.me)!;
  const { data: channels, reload } = useApi(() => rpc<any[]>('chat_channels'), [], 30000);
  const [channel, setChannel] = useState<number | null>(initial ?? null);
  const [messages, setMessages] = useState<any[]>([]);
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<{ masked: boolean; link: boolean }>({ masked: false, link: false });
  const [menu, setMenu] = useState<any>(null);
  const [joinName, setJoinName] = useState('');
  const log = useRef<HTMLDivElement>(null);
  const current = channels?.find((c) => c.id === channel);

  useEffect(() => {
    if (!channel && channels?.length) setChannel(channels[0].id);
  }, [channels, channel]);

  useEffect(() => {
    if (!channel) return;
    let alive = true;
    let unsub: (() => void) | null = null;
    const load = () => rpc<any[]>('chat_history', { p_channel: channel }).then((m) => alive && setMessages(m)).catch(() => {});
    load();
    let blocked = new Set<number>();
    rpc<any[]>('my_blocks').then((b) => (blocked = new Set(b.map((x) => x.player_no)))).catch(() => {});
    subscribeChat(channel, (m) => {
      if (!alive || blocked.has(m.author?.player_no)) return;
      setMessages((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]));
    }).then((u) => {
      if (alive) unsub = u;
      else u();
    });
    const poll = setInterval(() => !document.hidden && load(), 15000);
    return () => {
      alive = false;
      clearInterval(poll);
      unsub?.();
    };
  }, [channel]);

  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight });
  }, [messages.length]);

  useEffect(() => {
    let alive = true;
    filters().then((fs) => {
      if (!alive) return;
      setPreview({ masked: fs.some((f) => { f.lastIndex = 0; return f.test(text); }), link: LINK.test(text) });
    });
    return () => {
      alive = false;
    };
  }, [text]);

  const send = async () => {
    if (!channel || !text.trim()) return;
    const r = await act(() => rpc<any>('send_chat', { p_channel: channel, p_body: text }));
    if (r) {
      setText('');
      setMessages((prev) => (prev.some((x) => x.id === r.message.id) ? prev : [...prev, r.message]));
      if (r.notice) useGame.getState().toast(r.notice, 'info');
    }
  };

  const label = (c: any) => (c.kind === 'dm' ? `@${c.with?.name}` : c.kind === 'city' ? `${c.name}${c.city_id === me.city_id ? ' (here)' : ''}` : c.kind === 'global' ? 'Global' : `#${c.name}`);

  return (
    <div className="chat">
      <div className="chan-list">
        {channels?.map((c) => (
          <button key={c.id} className={c.id === channel ? 'on' : ''} onClick={() => setChannel(c.id)}>
            {label(c)}{c.unread > 0 ? ` (${c.unread})` : ''}
          </button>
        ))}
      </div>
      <div className="chat-log" ref={log}>
        {messages.length === 0 && <p className="muted small center">No messages yet. Say hello!</p>}
        {messages.map((m) => (
          <div key={m.id} className="msg">
            <Avatar skin={m.author.skin} ring={m.author.ring} size={30} />
            <div>
              <div className="row" style={{ gap: 6 }}>
                <span className="who" onClick={() => setMenu(m)}>{m.author.name}</span>
                {m.author.title && <span className="tiny muted">{m.author.title}</span>}
                <span className="tiny muted">{ago(m.at)}</span>
                {!m.removed && m.author.player_no !== me.player_no && <button className="link tiny" onClick={() => setMenu(m)} aria-label="Message options">⋯</button>}
              </div>
              <div className={`body ${m.removed ? 'removed' : ''}`}>{m.removed ? `Removed by staff${m.removed_reason ? `: ${m.removed_reason}` : ''}` : m.body}</div>
            </div>
          </div>
        ))}
      </div>
      {current && !current.can_post ? (
        <p className="small muted">{current.kind === 'city' ? `You can read ${current.name} chat, but only post in the city you’re in.` : 'Global chat isn’t open yet.'}</p>
      ) : (
        <>
          {(preview.masked || preview.link) && (
            <div className={`notice small ${preview.link ? 'red' : ''}`}>
              {preview.link ? 'Links aren’t allowed, so this won’t send. Share Discord servers in the Discord tab.' : 'Some words will be masked by the filter.'}
            </div>
          )}
          <form className="chat-input" onSubmit={(e) => { e.preventDefault(); send(); }}>
            <input className="input" value={text} maxLength={400} placeholder={current ? `Message ${label(current)}` : 'Pick a channel'} onChange={(e) => setText(e.target.value)} />
            <button className="btn" disabled={!text.trim() || preview.link}>Send</button>
          </form>
        </>
      )}
      <details className="small" style={{ marginTop: 8 }}>
        <summary>Channels</summary>
        <div className="row" style={{ marginTop: 6 }}>
          <input className="input" placeholder="Channel name" value={joinName} onChange={(e) => setJoinName(e.target.value)} maxLength={24} />
          <button className="btn small ghost" onClick={async () => { const r = await act(() => rpc<any>('join_channel', { p_name: joinName }), (x) => `Joined #${x.name}.`); if (r) { reload(); setChannel(r.channel_id); } }}>Join</button>
          <button className="btn small ghost" onClick={async () => { const r = await act(() => rpc<any>('create_channel', { p_name: joinName }), (x) => `Created #${x.name}.`); if (r) { reload(); setChannel(r.channel_id); } }}>Create</button>
        </div>
        {current?.kind === 'custom' && (
          <button className="link tiny" onClick={async () => { await act(() => rpc('leave_channel', { p_channel: current.id }), `Left #${current.name}.`); setChannel(null); reload(); }}>Leave #{current.name}</button>
        )}
      </details>
      {menu && <MessageMenu m={menu} onClose={() => setMenu(null)} />}
    </div>
  );
}

function Friends() {
  const open = useGame((s) => s.open);
  const { data, reload } = useApi(() => rpc<any[]>('my_friends'), [], 30000);
  const [no, setNo] = useState('');
  if (!data) return <Loading />;
  const incoming = data.filter((f) => f.incoming);
  const friends = data.filter((f) => f.status === 'accepted');
  const pending = data.filter((f) => f.status === 'pending' && !f.incoming);
  return (
    <div className="stack">
      <form className="row" onSubmit={async (e) => { e.preventDefault(); if (await act(() => rpc('friend_request', { p_player_no: Number(no) }), 'Friend request sent.')) { setNo(''); reload(); } }}>
        <input className="input" inputMode="numeric" placeholder="Player number, e.g. 42" value={no} onChange={(e) => setNo(e.target.value.replace(/\D/g, ''))} />
        <button className="btn small" disabled={!no}>Add friend</button>
      </form>
      {incoming.length > 0 && (
        <div className="card stack">
          <strong>Requests</strong>
          {incoming.map((f) => (
            <div key={f.player_no} className="row between">
              <span>{f.name} <span className="muted small">#{f.player_no}</span></span>
              <span className="row">
                <button className="btn tiny" onClick={async () => { await act(() => rpc('friend_respond', { p_player_no: f.player_no, p_accept: true }), 'Friend added.'); reload(); }}>Accept</button>
                <button className="btn tiny ghost" onClick={async () => { await act(() => rpc('friend_respond', { p_player_no: f.player_no, p_accept: false })); reload(); }}>Decline</button>
              </span>
            </div>
          ))}
        </div>
      )}
      {friends.length === 0 ? <Empty icon="handshake" title="No friends yet">Add players by their number (on their profile). Friends can see which city you’re in.</Empty> : (
        <table className="list">
          <tbody>
            {friends.map((f) => (
              <tr key={f.player_no} className="click" onClick={() => open('profile', { player_no: f.player_no })}>
                <td><div className="row"><Avatar skin={f.skin} ring={f.ring} size={28} /> {f.name}</div></td>
                <td className="small">{f.online ? <span className="good">● online</span> : <span className="muted">{ago(f.last_seen_at)}</span>}</td>
                <td className="small muted">{cityName(f.city_id)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {pending.length > 0 && <p className="small muted">Waiting for: {pending.map((f) => f.name).join(', ')}</p>}
    </div>
  );
}

function Boards() {
  const me = useGame((s) => s.me)!;
  const [board, setBoard] = useState<'bugs' | 'ideas'>('bugs');
  const [sort, setSort] = useState<'top' | 'new'>('top');
  const [post, setPost] = useState<number | null>(null);
  const [writing, setWriting] = useState(false);
  const { data, reload } = useApi(() => rpc<any[]>('board_list', { p_board: board, p_sort: sort }), [board, sort]);
  if (post) return <PostView id={post} onBack={() => { setPost(null); reload(); }} staff={me.role !== 'player'} />;
  if (writing) return <NewPost board={board} onDone={(id) => { setWriting(false); if (id) setPost(id); reload(); }} />;
  return (
    <div className="stack">
      <div className="row between wrap">
        <Tabs tabs={[['bugs', 'Bug reports'], ['ideas', 'Suggestions']]} value={board} onChange={setBoard} />
        <Tabs tabs={[['top', 'Top'], ['new', 'New']]} value={sort} onChange={setSort} />
      </div>
      <button className="btn small" onClick={() => setWriting(true)}>{board === 'bugs' ? 'Report a bug' : 'Suggest something'}</button>
      {!data ? <Loading /> : data.length === 0 ? <Empty icon={board === 'bugs' ? 'bug' : 'idea'} title="Nothing here yet" /> : data.map((p) => (
        <button key={p.id} className="card click row top" style={{ textAlign: 'left' }} onClick={() => setPost(p.id)}>
          <div className="center" style={{ minWidth: 44 }}>
            <div style={{ fontWeight: 800 }}>{p.votes}</div>
            <div className="tiny muted">votes</div>
          </div>
          <div className="grow">
            <strong>{p.title}</strong>
            <div className="row wrap tiny muted" style={{ gap: 6 }}>
              <span className={`chip ${p.status === 'done' ? 'green' : p.status === 'duplicate' || p.status === 'wont_do' ? '' : 'blue'}`}>{p.status.replace('_', ' ')}</span>
              <span>{p.author?.name}</span>
              <span>{ago(p.created_at)}</span>
              <span className="row" style={{ gap: 4 }}><Icon name="chat" size={16} /> {p.comments}</span>
            </div>
          </div>
        </button>
      ))}
    </div>
  );
}

function screenshotUrl(path: string) {
  return supabase.storage.from('screenshots').getPublicUrl(path).data.publicUrl;
}

function NewPost({ board, onDone }: { board: 'bugs' | 'ideas'; onDone: (id?: number) => void }) {
  const me = useGame((s) => s.me)!;
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="stack"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        let path: string | null = null;
        if (file) {
          if (file.size > 2_000_000) {
            useGame.getState().toast('Screenshots must be under 2 MB.', 'error');
            setBusy(false);
            return;
          }
          const ext = (file.type.split('/')[1] || 'png').replace(/[^a-z]/g, '');
          path = `${me.id}/${Date.now()}.${ext}`;
          const { error } = await supabase.storage.from('screenshots').upload(path, file, { contentType: file.type, upsert: false });
          if (error) {
            useGame.getState().toast('Couldn’t upload the screenshot: ' + error.message, 'error');
            path = null;
          }
        }
        const r = await act(() => rpc<any>('board_create', { p_board: board, p_title: title, p_body: body, p_screenshot: path }), (x) => x.notice ?? 'Posted. Thanks!');
        setBusy(false);
        if (r) onDone(r.id);
      }}
    >
      <button type="button" className="link small" onClick={() => onDone()}>← Back</button>
      <Field label="Title"><input className="input" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} required /></Field>
      <Field label={board === 'bugs' ? 'What happened? What did you expect?' : 'Your idea'}>
        <textarea className="input" value={body} maxLength={4000} onChange={(e) => setBody(e.target.value)} required />
      </Field>
      <Field label="Screenshot (optional, under 2 MB)">
        <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </Field>
      <p className="tiny muted">No links, please. Search first: if someone already posted it, vote for theirs instead.</p>
      <button className="btn" disabled={busy}>Post</button>
    </form>
  );
}

function PostView({ id, onBack, staff }: { id: number; onBack: () => void; staff: boolean }) {
  const { data: p, reload } = useApi(() => rpc<any>('board_post', { p_id: id }), [id]);
  const [comment, setComment] = useState('');
  const [status, setStatus] = useState('');
  const [note, setNote] = useState('');
  const [dupOf, setDupOf] = useState('');
  const open = useGame((s) => s.open);
  if (!p) return <Loading />;
  return (
    <div className="stack">
      <button className="link small" onClick={onBack}>← All posts</button>
      <h3 style={{ margin: 0 }}>{p.title}</h3>
      <div className="row wrap tiny muted" style={{ gap: 6 }}>
        <span className="chip blue">{p.status.replace('_', ' ')}</span>
        <button className="link tiny" onClick={() => open('profile', { player_no: p.author.player_no })}>{p.author.name}</button>
        <span>{ago(p.created_at)}</span>
        {p.merged_into && <span>Duplicate of #{p.merged_into}</span>}
      </div>
      {p.staff_note && <div className="notice blue small">Staff: {p.staff_note}</div>}
      {p.removed ? <p className="muted">Removed by staff{p.removed_reason ? `: ${p.removed_reason}` : ''}.</p> : <p style={{ whiteSpace: 'pre-wrap' }}>{p.body}</p>}
      {p.screenshot && <img src={screenshotUrl(p.screenshot)} alt="Screenshot attached to the post" style={{ borderRadius: 10, border: '1px solid var(--line)' }} />}
      <div className="row">
        <button className={`btn small ${p.voted ? '' : 'ghost'}`} onClick={async () => { await act(() => rpc('board_vote', { p_id: id, p_vote: !p.voted })); reload(); }}>▲ {p.votes} {p.voted ? 'Voted' : 'Vote'}</button>
        {!p.mine && <button className="link tiny" onClick={async () => { await act(() => rpc<any>('report', { p_kind: 'post', p_target: id, p_reason: 'spam' }), (r) => r.message); }}>Report</button>}
      </div>
      <strong className="small">Comments</strong>
      {p.comments_list.map((c: any) => (
        <div key={c.id} className="msg">
          <Avatar skin={c.author.skin} ring={c.author.ring} size={28} />
          <div>
            <span className="who">{c.author.name}</span> <span className="tiny muted">{ago(c.at)}</span>
            <div className={`body ${c.removed ? 'removed' : ''}`}>{c.removed ? 'Removed by staff' : c.body}</div>
          </div>
        </div>
      ))}
      <form className="chat-input" onSubmit={async (e) => { e.preventDefault(); if (await act(() => rpc<any>('board_comment', { p_id: id, p_body: comment }), (x) => x.notice)) { setComment(''); reload(); } }}>
        <input className="input" value={comment} maxLength={2000} placeholder="Add a comment" onChange={(e) => setComment(e.target.value)} />
        <button className="btn small" disabled={!comment.trim()}>Post</button>
      </form>
      {staff && (
        <div className="card stack">
          <strong className="small">Staff</strong>
          <div className="grid2">
            <select className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">Set status…</option>
              {['open', 'planned', 'in_progress', 'done', 'duplicate', 'wont_do'].map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
            </select>
            {status === 'duplicate' && <input className="input" placeholder="Original post #" value={dupOf} onChange={(e) => setDupOf(e.target.value.replace(/\D/g, ''))} />}
          </div>
          <input className="input" placeholder="Note to the poster" value={note} onChange={(e) => setNote(e.target.value)} />
          <button className="btn small" disabled={!status} onClick={async () => { if (await act(() => rpc('board_set_status', { p_id: id, p_status: status, p_merged_into: dupOf ? Number(dupOf) : null, p_note: note || null }), 'Updated.')) reload(); }}>Save</button>
        </div>
      )}
    </div>
  );
}

function Discord() {
  const { data, reload } = useApi(() => rpc<any[]>('discord_directory'), []);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const list = useMemo(() => data ?? [], [data]);
  return (
    <div className="stack">
      <p className="small muted">Community Discord servers. This is the only place links appear in CranCapital: you give an invite code and the game builds the link.</p>
      {!data ? <Loading /> : list.length === 0 ? <Empty icon="headset" title="No servers listed yet" /> : list.map((d) => (
        <div key={d.id} className="card row between">
          <div className="grow">
            <strong>{d.name}</strong>
            {d.description && <div className="small">{d.description}</div>}
            <div className="tiny muted">Listed by {d.owner?.name} · {ago(d.created_at)}</div>
          </div>
          <div className="stack tight">
            <a className="btn small" href={d.url} target="_blank" rel="noopener noreferrer">Join</a>
            {d.mine ? (
              <button className="link tiny" onClick={async () => { await act(() => rpc('discord_remove', { p_id: d.id }), 'Removed.'); reload(); }}>Remove</button>
            ) : (
              <button className="link tiny" onClick={async () => { await act(() => rpc<any>('report', { p_kind: 'discord', p_target: d.id, p_reason: 'other' }), (r) => r.message); }}>Report</button>
            )}
          </div>
        </div>
      ))}
      <details>
        <summary className="small">List your server</summary>
        <form className="stack" style={{ marginTop: 8 }} onSubmit={async (e) => { e.preventDefault(); if (await act(() => rpc('discord_add', { p_code: code, p_name: name, p_description: desc || null }), 'Listed!')) { setCode(''); setName(''); setDesc(''); reload(); } }}>
          <Field label="Invite code" hint="Just the code from discord.gg/your-code"><input className="input" value={code} onChange={(e) => setCode(e.target.value)} required /></Field>
          <Field label="Server name"><input className="input" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} required /></Field>
          <Field label="Short description"><input className="input" value={desc} maxLength={200} onChange={(e) => setDesc(e.target.value)} /></Field>
          <button className="btn small">Add</button>
        </form>
      </details>
    </div>
  );
}
