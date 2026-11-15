import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export const SUPABASE_URL: string = import.meta.env.VITE_SUPABASE_URL;
export const SUPABASE_KEY: string = import.meta.env.VITE_SUPABASE_KEY;
export const DEV_LOGIN = import.meta.env.VITE_DEV_LOGIN === '1';
export const BACKEND_READY = !!(SUPABASE_URL && SUPABASE_KEY);

export const supabase: SupabaseClient = createClient(SUPABASE_URL || 'http://localhost:54321', SUPABASE_KEY || 'missing', {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' },
  realtime: { params: { eventsPerSecond: 20 } },
});

export class GameError extends Error {
  code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}

// Turn database and network errors into something a player can read.
function friendly(message: string, code?: string): string {
  if (code === '40P01' || /deadlock/i.test(message)) return 'The market was busy. Please try again.';
  if (code === 'PGRST202' || /Could not find the function/i.test(message)) return 'The game server is updating. Please refresh in a minute.';
  if (/JWT expired|invalid JWT/i.test(message)) return 'Your session expired. Please sign in again.';
  if (/Failed to fetch|NetworkError|Load failed/i.test(message)) return 'Can’t reach the game server. Check your connection.';
  return message;
}

// Call a game API function. Errors raised by the server for players are
// plain English and are shown as-is.
export async function rpc<T = any>(fn: string, args: Record<string, unknown> = {}, retry = 1): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) {
    if (retry > 0 && (error.code === '40P01' || /deadlock|could not serialize/i.test(error.message))) {
      await new Promise((r) => setTimeout(r, 250 + Math.random() * 400));
      return rpc<T>(fn, args, retry - 1);
    }
    throw new GameError(friendly(error.message, error.code), error.code);
  }
  return data as T;
}

// Local development only: sign in without an email server.
export async function devSignIn(email: string) {
  const res = await fetch(`${SUPABASE_URL}/dev/login`, { method: 'POST', body: JSON.stringify({ email }) });
  const { otp, error } = await res.json();
  if (!otp) throw new GameError('Dev sign-in failed: ' + JSON.stringify(error));
  const { error: e } = await supabase.auth.verifyOtp({ email, token: otp, type: 'email' });
  if (e) throw new GameError(e.message);
}
