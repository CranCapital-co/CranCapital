import { useState } from 'react';
import { Window } from '../components';
import { WIKI, wikiMarkdown, Markdown } from '../../screens/Pages';

export default function WikiWindow({ params }: { params?: { slug?: string } }) {
  const [slug, setSlug] = useState<string | null>(params?.slug ?? null);
  const text = slug ? wikiMarkdown(slug) : null;
  return (
    <Window title={slug ? WIKI.find((p) => p.slug === slug)?.title ?? 'Help' : 'Help and wiki'} icon="📖" onBack={slug ? () => setSlug(null) : undefined}>
      {text ? (
        <Markdown text={text} />
      ) : (
        <div className="stack">
          <a className="card click row between" href="#/tutorial" style={{ textDecoration: 'none', color: 'inherit' }}>
            <span>🏝️ <b>Replay Tutorial Island</b><br /><span className="small muted">Walk, park a cart, set a menu and sell, step by step.</span></span>
            <span>→</span>
          </a>
          {WIKI.map((p) => (
            <button key={p.slug} className="card click" style={{ textAlign: 'left' }} onClick={() => setSlug(p.slug)}>
              <strong>{p.title}</strong>
              <div className="small muted">{p.summary}</div>
            </button>
          ))}
          <p className="small muted">
            <a href="#/legal/rules" target="_blank">Community rules</a> · <a href="#/legal/terms" target="_blank">Terms</a> · <a href="#/legal/privacy" target="_blank">Privacy</a> · <a href="#/legal/credits" target="_blank">Credits</a>
          </p>
        </div>
      )}
    </Window>
  );
}
