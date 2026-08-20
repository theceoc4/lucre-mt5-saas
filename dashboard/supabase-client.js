// supabase-client.js — shared Supabase client for the Lucre Hub dashboard.
// Uses the anon/publishable key only — every table is RLS-gated, so this key
// is safe to ship in client-side code. It can never see rows outside the
// signed-in user's own terminals.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

export const SUPABASE_URL = 'https://qxlfnscmrhwfcpattqxa.supabase.co';
export const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InF4bGZuc2Ntcmh3ZmNwYXR0cXhhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY5MTI5NjYsImV4cCI6MjEwMjQ4ODk2Nn0.7nmSfQlFKyuYtej2i9TcQQVIjkeauqPA4iTGessQHWA';

// The hosted /computer/a preview runs the app inside a sandboxed iframe that
// disallows browser-side persistent storage entirely (reading OR writing
// localStorage/sessionStorage throws there). A real deployment (published
// pplx.app link, Vercel, or any normal browser tab) has no such restriction
// and should persist the session across reloads like any other web app.
//
// v1.0.2: feature-detect instead of assuming the preview's constraint always
// applies — try a real localStorage write/read/remove, and only fall back to
// the in-memory adapter if that throws. Fixes the "auth session resets on
// reload" known gap for every real deployment; the preview sandbox continues
// to degrade gracefully to session-only auth exactly as before.
function localStorageIsUsable() {
  try {
    const testKey = '__lucre_storage_test__';
    window.localStorage.setItem(testKey, '1');
    window.localStorage.removeItem(testKey);
    return true;
  } catch {
    return false;
  }
}

function makeMemoryStorage() {
  const mem = new Map();
  return {
    getItem: (key) => (mem.has(key) ? mem.get(key) : null),
    setItem: (key, value) => mem.set(key, value),
    removeItem: (key) => mem.delete(key),
  };
}

const authStorage = localStorageIsUsable() ? window.localStorage : makeMemoryStorage();

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage: authStorage,
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});
