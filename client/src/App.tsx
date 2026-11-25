import { lazy, Suspense, useEffect, useState } from 'react';
import Landing from './screens/Landing';
import { Toasts } from './ui/components';
import { IconSprite } from './ui/Icon';
import { supabase, AUTH_RETURN } from './lib/supabase';

const Play = lazy(() => import('./screens/Play'));
const Tutorial = lazy(() => import('./screens/Tutorial'));
// Help and legal pages (with their Markdown) load only when opened.
const LegalPage = lazy(() => import('./screens/Pages').then((m) => ({ default: m.LegalPage })));
const WikiPage = lazy(() => import('./screens/Pages').then((m) => ({ default: m.WikiPage })));
const ReportPage = lazy(() => import('./screens/Pages').then((m) => ({ default: m.ReportPage })));

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

  // Back from a sign-in link: wait for the session, then go to the game.
  const [authLanding, setAuthLanding] = useState(AUTH_RETURN);
  useEffect(() => {
    if (!AUTH_RETURN) return;
    supabase.auth.getSession().finally(() => {
      window.location.hash = '/play';
      setAuthLanding(false);
    });
  }, []);

  const path = hash.replace(/^#/, '') || '/';
  let page;
  if (authLanding) page = <div className="boot"><div className="spinner" /></div>;
  else if (path.startsWith('/play')) page = <Play />;
  else if (path.startsWith('/tutorial')) page = <Tutorial />;
  else if (path.startsWith('/legal/')) page = <LegalPage slug={path.slice(7)} />;
  else if (path.startsWith('/wiki')) page = <WikiPage slug={path.slice(6) || null} />;
  else if (path.startsWith('/report')) page = <ReportPage />;
  else page = <Landing />;

  return (
    <>
      <Suspense fallback={<div className="boot"><div className="spinner" /></div>}>{page}</Suspense>
      <IconSprite />
      <Toasts />
    </>
  );
}
