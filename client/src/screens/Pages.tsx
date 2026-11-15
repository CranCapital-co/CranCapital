import { useMemo, useState } from 'react';
import { marked } from 'marked';
import { rpc } from '../lib/supabase';
import wikiIndex from '../content/wiki/index.json';
import '../styles/landing.css';

const wikiPages = import.meta.glob('../content/wiki/*.md', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const legalPages = import.meta.glob('../content/legal/*.md', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

export const WIKI: { slug: string; title: string; summary: string }[] = wikiIndex as any;

export function wikiMarkdown(slug: string) {
  return wikiPages[`../content/wiki/${slug}.md`] ?? null;
}

export function Markdown({ text }: { text: string }) {
  const html = useMemo(() => {
    // Our own content only; links open in place for in-app routes.
    const out = marked.parse(text, { async: false }) as string;
    return out.replace(/<a href="(https?:)/g, '<a target="_blank" rel="noopener" href="$1');
  }, [text]);
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
}

export function Footer() {
  return (
    <footer className="footer">
      <nav>
        <a href="#/wiki">Help and wiki</a>
        <a href="#/legal/rules">Community rules</a>
        <a href="#/legal/terms">Terms of use</a>
        <a href="#/legal/privacy">Privacy policy</a>
        <a href="#/legal/credits">Credits</a>
        <a href="#/report">Report illegal content</a>
      </nav>
      <div>CranCapital is based on Capital Rift by NIKS GAMES LLC, used with their permission.</div>
      <div>
        Map data <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a>. Map tiles by{' '}
        <a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a>.
      </div>
      <div>In-game money has no real-world value and can’t be bought or cashed out.</div>
    </footer>
  );
}

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="landing">
      <div className="page-head page">
        <a className="brand" href="#/">
          <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" />
          CranCapital
        </a>
        <a className="btn small" href="#/play">Play</a>
      </div>
      {children}
      <Footer />
    </div>
  );
}

export function LegalPage({ slug }: { slug: string }) {
  const text = legalPages[`../content/legal/${slug}.md`];
  return (
    <PageShell>
      <article className="page card" style={{ padding: '24px 26px' }}>
        {text ? <Markdown text={text} /> : <p>Page not found.</p>}
      </article>
    </PageShell>
  );
}

export function WikiPage({ slug }: { slug: string | null }) {
  const current = slug && wikiMarkdown(slug) ? slug : WIKI[0]?.slug;
  const text = current ? wikiMarkdown(current) : null;
  return (
    <PageShell>
      <div className="wiki-layout">
        <nav className="wiki-nav" aria-label="Wiki pages">
          {WIKI.map((p) => (
            <a key={p.slug} href={`#/wiki/${p.slug}`} className={p.slug === current ? 'on' : ''}>{p.title}</a>
          ))}
          <a href="#/tutorial">↻ Replay Tutorial Island</a>
        </nav>
        <article className="card" style={{ padding: '22px 24px' }}>{text ? <Markdown text={text} /> : <p>Page not found.</p>}</article>
      </div>
    </PageShell>
  );
}

// Public form: anyone can report illegal content, no account needed.
export function ReportPage() {
  const [where, setWhere] = useState('');
  const [what, setWhat] = useState('');
  const [contact, setContact] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <PageShell>
      <div className="page">
        <div className="card" style={{ padding: 24 }}>
          <h1>Report illegal content</h1>
          <p className="muted">
            Use this form to tell the CranCapital team about illegal content in the game: in chat, on the boards, in names or anywhere else.
            You don’t need an account. A person reads every report. For everyday rule-breaking, use the Report button in the game instead.
          </p>
          {done ? (
            <div className="notice green">{done}</div>
          ) : (
            <form
              className="stack"
              onSubmit={async (e) => {
                e.preventDefault();
                setBusy(true);
                setErr(null);
                try {
                  const r = await rpc<any>('report_illegal_content', { p_location: where, p_description: what, p_contact: contact || null });
                  setDone(r.message);
                } catch (x: any) {
                  setErr(x.message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <label className="field">
                <span>Where is it?</span>
                <input className="input" value={where} onChange={(e) => setWhere(e.target.value)} placeholder="e.g. London city chat, a player called …, Bug Reports post #12" required maxLength={500} />
              </label>
              <label className="field">
                <span>What’s wrong with it?</span>
                <textarea className="input" value={what} onChange={(e) => setWhat(e.target.value)} required minLength={10} maxLength={5000} placeholder="Describe the content and why you think it’s illegal." />
              </label>
              <label className="field">
                <span>Your contact details (optional)</span>
                <input className="input" value={contact} onChange={(e) => setContact(e.target.value)} maxLength={200} placeholder="An email address if you’d like a reply" />
                <small className="muted">Only the moderation team sees this. See the <a href="#/legal/privacy">privacy policy</a>.</small>
              </label>
              {err && <div className="notice red">{err}</div>}
              <button className="btn" disabled={busy}>Send report</button>
            </form>
          )}
        </div>
      </div>
    </PageShell>
  );
}
