/**
 * Auth state, shared across the tree.
 *
 * ── Why the Firebase import is dynamic ─────────────────────────────────────
 * This provider is mounted in the root layout, so a static
 * `import 'firebase/auth'` would put the Web SDK into the bundle of every
 * page — including the homepage, which is the one page the whole primary
 * objective runs through and which is read on mobile data in Cochabamba.
 * Loading it inside the effect keeps it out of the first paint: the wall
 * renders from server HTML, and auth resolves afterwards.
 *
 * The cost is one render where `loading` is true and `user` is unknown. Any
 * consumer that renders differently for the two states must wait for
 * `loading` to clear, or it will flash the signed-out view at a signed-in
 * visitor on every navigation.
 */

'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import type { User } from 'firebase/auth';

interface AuthState {
  user: User | null;
  /** True until Firebase has restored (or ruled out) a persisted session. */
  loading: boolean;
  /** Re-reads the current user from Firebase, after e.g. email verification. */
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthState>({
  user: null,
  loading: true,
  refresh: async () => {},
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  // `user.reload()` mutates the existing object rather than returning a new
  // one, so React sees an unchanged reference and does not re-render. Bumping
  // this is what makes a freshly-verified `emailVerified` visible. Cloning the
  // User instead would be wrong — it carries private internals the SDK owns.
  const [, bumpNonce] = useState(0);

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    let cancelled = false;

    (async () => {
      const [{ getFirebase }, { onAuthStateChanged }] = await Promise.all([
        import('@/lib/firebase-client'),
        import('firebase/auth'),
      ]);
      if (cancelled) return;

      const { auth } = getFirebase();
      unsubscribe = onAuthStateChanged(auth, (next) => {
        setUser(next);
        setLoading(false);
      });
    })().catch((error) => {
      // A missing NEXT_PUBLIC_FIREBASE_* value lands here. Clearing `loading`
      // matters: leaving it true would hang every consumer on a spinner
      // forever, which looks like a slow network rather than a broken config.
      console.error('[auth] could not initialise', error);
      if (!cancelled) setLoading(false);
    });

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  async function refresh() {
    const { getFirebase } = await import('@/lib/firebase-client');
    const current = getFirebase().auth.currentUser;
    if (!current) return;
    await current.reload();
    bumpNonce((n) => n + 1);
  }

  return (
    <AuthContext.Provider value={{ user, loading, refresh }}>{children}</AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  return useContext(AuthContext);
}
