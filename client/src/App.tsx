import { lazy, Suspense, useEffect, useState } from 'react';
import Landing from './screens/Landing';
import { LegalPage, WikiPage, ReportPage } from './screens/Pages';
import { Toasts } from './ui/components';

const Play = lazy(() => import('./screens/Play'));
const Tutorial = lazy(() => import('./screens/Tutorial'));

function useHash() {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const on = () => setHash(window.location.hash);
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return hash;
}

export function go(path: string) {
  window.location.hash = path;
}

export default function App() {
  const hash = useHash();
  useEffect(() => {
    // Back from a sign-in link (?code=...): go straight to the game.
    const params = new URLSearchParams(window.location.search);
    if (params.get('code') && !window.location.hash.startsWith('#/play')) window.location.hash = '/play';
    // Invite links: #/r/CODE remembers the inviter.
    const m = window.location.hash.match(/^#\/r\/([A-Za-z0-9]{4,12})/);
    if (m) {
      try {
        localStorage.setItem('cc_ref', m[1].toUpperCase());
      } catch {
        /* storage may be blocked */
      }
      window.location.hash = '/';
    }
  }, [hash]);

  const path = hash.replace(/^#/, '') || '/';
  let page;
  if (path.startsWith('/play')) page = <Play />;
  else if (path.startsWith('/tutorial')) page = <Tutorial />;
  else if (path.startsWith('/legal/')) page = <LegalPage slug={path.slice(7)} />;
  else if (path.startsWith('/wiki')) page = <WikiPage slug={path.slice(6) || null} />;
  else if (path.startsWith('/report')) page = <ReportPage />;
  else page = <Landing />;

  return (
    <>
      <Suspense fallback={<div className="boot"><div className="spinner" /></div>}>{page}</Suspense>
      <Toasts />
    </>
  );
}
