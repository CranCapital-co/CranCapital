// Talk to any country. AI governments answer in their own voice about the
// world as it is, and can put real offers on the table: they pop up to
// accept or decline, and stay in the conversation.
import { useEffect, useMemo, useRef, useState } from 'react';
import { rpc } from '../lib/supabase';
import { act, useGame } from '../lib/store';
import { money } from '../lib/format';
import { sound } from '../audio/sound';
import { Icon } from '../ui/Icon';
import { Loading, Modal, useApi } from '../ui/components';
import { refreshMe } from '../ui/common';
import { flag, PERSONALITY } from './api';
import type { Ctx } from './NationTabs';

interface Offer { kind: string; text: string; price?: number; offer_id?: string; deal_id?: number; status?: string; expired?: boolean }
interface Msg { id: number; at: string; mine: boolean; body: string; mood?: string | null; rel_delta?: number | null; offer?: Offer | null }
interface History {
  nation: { id: string; name: string; color: string; personality: string; skill: number; skill_name: string; status: string; rank: number | null; leader: string | null; alliance: string | null };
  rel: number | null; at_war: boolean; allied: boolean; messages: Msg[];
}

const SUGGEST = ['Hello!', 'How are things?', 'Will you ally with us?', 'Why won’t you ally with us?', 'Can we sign a non-aggression pact?', 'What do you think of us?', 'Make me an offer'];

export function TalkTab({ ctx, open, onOpen }: { ctx: Ctx; open: string | null; onOpen: (id: string | null) => void }) {
  return open ? <Conversation key={open} ctx={ctx} id={open} onBack={() => onOpen(null)} /> : <Directory ctx={ctx} onOpen={onOpen} />;
}

// Everyone you can talk to: recent conversations first, then every country.
function Directory({ ctx, onOpen }: { ctx: Ctx; onOpen: (id: string) => void }) {
  const { data: recent } = useApi(() => rpc<{ nation: string; name: string; last: string; at: string; mine: boolean }[]>('diplo_chat_list'), []);
  const [q, setQ] = useState('');
  const iso = useMemo(() => new Map(ctx.map.territories.map((t) => [t.id, t.iso2])), [ctx.map]);
  const nations = useMemo(
    () => [...(ctx.world?.nations ?? [])].filter((n) => n.status === 'active' && n.id !== ctx.my.nation?.id)
      .sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999)),
    [ctx.world, ctx.my.nation?.id]
  );
  const shown = q.trim() ? nations.filter((n) => n.name.toLowerCase().includes(q.trim().toLowerCase())) : nations;
  return (
    <div className="stack">
      <p className="small muted" style={{ margin: 0 }}>
        Talk to any country. Each government has its own personality: some are easy to deal with, some are hard bargainers. Be polite, bring gifts, and they may offer you alliances, pacts or help against your rivals. Annoy them and relations suffer.
      </p>
      {(recent ?? []).length > 0 && (
        <section className="stack" style={{ gap: 4 }}>
          <span className="eyebrow">Recent</span>
          {recent!.slice(0, 6).map((r) => (
            <button key={r.nation} className="rel-row" onClick={() => onOpen(r.nation)}>
              <span className="flag">{flag(iso.get(r.nation))}</span>
              <span className="grow stack" style={{ gap: 0 }}>
                <b>{r.name}</b>
                <span className="tiny muted ellipsis">{r.mine ? 'You: ' : ''}{r.last}</span>
              </span>
            </button>
          ))}
        </section>
      )}
      <input className="input" placeholder="Search countries" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search countries" />
      <section className="stack" style={{ gap: 2 }}>
        {shown.slice(0, 80).map((n) => (
          <button key={n.id} className="rel-row" onClick={() => onOpen(n.id)}>
            <span className="flag">{flag(iso.get(n.id))}</span>
            <span className="grow">
              <b>{n.name}</b>{' '}
              <span className="tiny muted">{n.leader ? `led by ${n.leader.name}` : `${PERSONALITY[n.personality]?.split(':')[0] ?? n.personality} AI`}{n.rank ? ` · #${n.rank}` : ''}</span>
            </span>
            <Icon name="chat" size={18} />
          </button>
        ))}
      </section>
    </div>
  );
}

function relTone(r: number | null) {
  if (r == null) return 'var(--muted)';
  return r >= 50 ? 'var(--good)' : r >= 20 ? '#7cc35a' : r > -10 ? 'var(--muted)' : r > -40 ? 'var(--gold)' : 'var(--bad)';
}

function Conversation({ ctx, id, onBack }: { ctx: Ctx; id: string; onBack: () => void }) {
  const me = useGame((s) => s.me)!;
  const { data, reload, setData } = useApi(() => rpc<History>('diplo_chat_history', { p_nation: id }), [id]);
  const [text, setText] = useState('');
  const [typing, setTyping] = useState(false);
  const [pending, setPending] = useState<Msg | null>(null);
  const [popup, setPopup] = useState<Msg | null>(null);
  const [flash, setFlash] = useState<number | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const iso = ctx.map.territories.find((t) => t.id === id)?.iso2;
  useEffect(() => {
    // In braces: newer browsers return a Promise from scrollIntoView, and an
    // effect may only return a clean-up function.
    end.current?.scrollIntoView({ block: 'end' });
  }, [data?.messages.length, typing, pending]);

  const send = async (body: string) => {
    const b = body.trim();
    if (!b || typing) return;
    setText('');
    const mine: Msg = { id: -Date.now(), at: new Date().toISOString(), mine: true, body: b };
    setPending(mine);
    setTyping(true);
    const started = Date.now();
    try {
      const r = await rpc<any>('diplo_chat_send', { p_nation: id, p_text: b });
      // A moment to "type", so it reads like a reply.
      const wait = Math.max(0, Math.min(1600, 500 + r.body.length * 12) - (Date.now() - started));
      await new Promise((res) => setTimeout(res, wait));
      const reply: Msg = { id: r.id, at: r.at, mine: false, body: r.body, mood: r.mood, rel_delta: r.rel_delta, offer: r.offer ? { ...r.offer, status: 'open' } : null };
      setData((d) => (d ? { ...d, rel: r.rel ?? d.rel, messages: [...d.messages, mine, reply] } : d));
      if (r.rel_delta) {
        setFlash(Number(r.rel_delta));
        setTimeout(() => setFlash(null), 2200);
      }
      sound.play(r.rel_delta < 0 ? 'error' : 'pop');
      if (reply.offer) setPopup(reply);
    } catch (e: any) {
      useGame.getState().toast(e?.message ?? String(e), 'error');
      setText(b);
    } finally {
      setPending(null);
      setTyping(false);
    }
  };

  const answer = async (m: Msg, yes: boolean) => {
    setPopup(null);
    const r = await act(() => rpc<any>('diplo_chat_answer', { p_message: m.id, p_accept: yes }), (x) => x.reply);
    if (r) {
      sound.play(yes ? 'success' : 'close');
      reload();
      ctx.reload();
      refreshMe();
    }
  };

  if (!data) return <Loading lines={5} />;
  const n = data.nation;
  const persona = PERSONALITY[n.personality] ?? n.personality;
  return (
    <div className="talk">
      <header className="talk-head">
        <button className="btn ghost icon small" onClick={onBack} aria-label="All countries"><Icon name="back" /></button>
        <span className="flag big">{flag(iso)}</span>
        <span className="grow stack" style={{ gap: 0 }}>
          <b>{n.name}</b>
          <span className="tiny muted">{n.leader ? `Led by ${n.leader}` : `${persona.split(':')[0]} · ${n.skill_name} AI`}{n.rank ? ` · #${n.rank} in the world` : ''}</span>
        </span>
        {data.rel != null && (
          <span className={`talk-rel ${flash != null ? 'pulse' : ''}`} style={{ color: relTone(data.rel) }} title="How they feel about you">
            {data.at_war ? 'At war' : data.allied ? 'Ally' : 'Relations'} {data.rel > 0 ? '+' : ''}{data.rel}
            {flash != null && <span className="talk-flash">{flash > 0 ? '+' : ''}{flash}</span>}
          </span>
        )}
      </header>
      {!n.leader && <p className="tiny muted talk-persona">{persona}</p>}
      <div className="talk-log">
        {data.messages.length === 0 && <p className="small muted center">Say hello to {n.name}.</p>}
        {data.messages.map((m) => <Bubble key={m.id} m={m} onAnswer={answer} who={n.name} />)}
        {pending && <Bubble m={pending} onAnswer={answer} who={n.name} />}
        {typing && <div className="bubble theirs typing" aria-label={`${n.name} is typing`}><span /><span /><span /></div>}
        <div ref={end} />
      </div>
      <div className="talk-suggest">
        {SUGGEST.map((s) => <button key={s} className="chip click" onClick={() => send(s)} disabled={typing}>{s}</button>)}
      </div>
      <form className="talk-input" onSubmit={(e) => { e.preventDefault(); send(text); }}>
        <input className="input grow" value={text} onChange={(e) => setText(e.target.value)} maxLength={400} placeholder={`Message ${n.name}…`} aria-label={`Message ${n.name}`} />
        <button className="btn" disabled={!text.trim() || typing}><Icon name="send" size={18} /> Send</button>
      </form>
      <p className="tiny muted" style={{ margin: 0 }}>Your money: {money(me.cash, { cents: false })}</p>
      {popup?.offer && (
        <Modal title={`${n.name} makes an offer`} onClose={() => setPopup(null)}>
          <div className="stack">
            <p style={{ margin: 0 }}>{popup.body}</p>
            <div className="card soft row"><Icon name="handshake" size={22} /> <b>{popup.offer.text}</b></div>
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button className="btn ghost" onClick={() => answer(popup, false)}>Decline</button>
              <button className="btn gold" onClick={() => answer(popup, true)}>Accept</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function Bubble({ m, onAnswer, who }: { m: Msg; onAnswer: (m: Msg, yes: boolean) => void; who: string }) {
  const o = m.offer;
  const open = o && (o.status ?? 'open') === 'open' && !o.expired;
  return (
    <div className={`bubble ${m.mine ? 'mine' : 'theirs'} ${m.mood ? 'mood-' + m.mood : ''}`}>
      {!m.mine && <span className="tiny muted">{who}</span>}
      <span>{m.body}</span>
      {!m.mine && m.rel_delta ? <span className={`tiny ${m.rel_delta > 0 ? 'pos' : 'neg'}`}>Relations {m.rel_delta > 0 ? '+' : ''}{m.rel_delta}</span> : null}
      {o && (
        <div className="offer-card">
          <b className="small">{o.text}</b>
          {open ? (
            <div className="row">
              <button className="btn small ghost" onClick={() => onAnswer(m, false)}>Decline</button>
              <button className="btn small gold" onClick={() => onAnswer(m, true)}>Accept</button>
            </div>
          ) : (
            <span className="tiny muted">{o.expired && o.status === 'open' ? 'Expired' : o.status === 'accepted' ? 'Accepted' : o.status === 'declined' ? 'Declined' : 'Closed'}</span>
          )}
        </div>
      )}
    </div>
  );
}
