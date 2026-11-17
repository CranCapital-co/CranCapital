// Send errors from the player's browser to the server (signed-in players
// only), so problems on devices we can't test on can be fixed. Each distinct
// message is sent once per visit, and at most a few per visit.
import { supabase, BACKEND_READY } from './supabase';

const sent = new Set<string>();
const MAX_PER_VISIT = 8;

export function reportError(kind: string, message: unknown) {
  try {
    if (!BACKEND_READY) return;
    const text = String((message as any)?.message ?? message ?? '').slice(0, 1000);
    if (!text || sent.has(kind + text) || sent.size >= MAX_PER_VISIT) return;
    sent.add(kind + text);
    supabase.auth.getSession().then(({ data }) => {
      if (!data.session) return;
      supabase
        .rpc('report_client_error', {
          p_kind: kind,
          p_message: text,
          p_user_agent: navigator.userAgent,
          // Only the screen's route: a sign-in hash carries tokens.
          p_path: location.hash.startsWith('#/') ? location.hash.split(/[?&=]/)[0].slice(0, 200) : '/',
        })
        .then(() => {}, () => {});
    });
  } catch {
    /* reporting must never break the game */
  }
}

export function installErrorReporting() {
  window.addEventListener('error', (e) => reportError('error', e.error ?? e.message));
  window.addEventListener('unhandledrejection', (e) => reportError('promise', e.reason));
}
