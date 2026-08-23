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
 *
 * ── The admin claim, and why it is read from a CACHED token here ───────────
 * `isAdmin` comes from the `admin` custom claim inside the ID token, set by
 * `scripts/grant-admin.mjs` and enforced by `firestore.rules` and
 * `storage.rules`. Claims are baked into the token when it is issued and
 * Firebase rotates it roughly hourly, so a freshly-granted admin carries a
 * token that does not mention it — for up to an hour.
 *
 * This provider deliberately reads the CACHED token. Forcing a refresh here
 * would put a network round-trip on every page load for every signed-in
 * visitor, almost all of whom will never be admins, purely to keep a value
 * fresh that only the admin screens read. So the cost is moved to where the
 * value is used: `refreshClaims()` forces a real refresh, and the admin gate
 * calls it on mount. That way an ordinary adopter pays nothing and an admin
 * who was promoted thirty seconds ago still gets in.
 *
 * ⚠️ Do not "simplify" this to `getIdTokenResult(true)` in the effect below.
 * It looks equivalent and is not — the trade is a per-visit request on the
 * homepage against a one-time request on `/admin`.
 */

'use client';

import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { User } from 'firebase/auth';

interface AuthState {
  user: User | null;
  /** True until Firebase has restored (or ruled out) a persisted session. */
  loading: boolean;
  /**
   * Whether the signed-in user carries the `admin` custom claim. Read from
   * the cached ID token, so it can lag a fresh grant by up to an hour —
   * call `refreshClaims()` before trusting a false.
   */
  isAdmin: boolean;
  /** Re-reads the current user from Firebase, after e.g. email verification. */
  refresh: () => Promise<void>;
  /**
   * Force an ID token refresh and re-read the claims. This is the call that
   * makes a just-granted admin claim visible without signing out and back in.
   */
  refreshClaims: () => Promise<void>;
}

const AuthContext = createContext<AuthState>({
  user: null,
  loading: true,
  isAdmin: false,
  refresh: async () => {},
  refreshClaims: async () => {},
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [isAdmin, setIsAdmin] = useState(false);
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

        if (!next) {
          setIsAdmin(false);
          return;
        }
        // Cached token — see the note at the top of this file.
        next
          .getIdTokenResult()
          .then((result) => {
            if (!cancelled) setIsAdmin(result.claims.admin === true);
          })
          .catch((error) => {
            // A failure here is not a reason to grant access, and not a reason
            // to break sign-in either. Fail closed and say so.
            console.error('[auth] could not read custom claims', error);
            if (!cancelled) setIsAdmin(false);
          });
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

  const refresh = useCallback(async () => {
    const { getFirebase } = await import('@/lib/firebase-client');
    const current = getFirebase().auth.currentUser;
    if (!current) return;
    await current.reload();
    bumpNonce((n) => n + 1);
  }, []);

  const refreshClaims = useCallback(async () => {
    const { getFirebase } = await import('@/lib/firebase-client');
    const current = getFirebase().auth.currentUser;
    if (!current) {
      setIsAdmin(false);
      return;
    }
    // `true` forces a round-trip to Firebase for a newly-minted token rather
    // than returning the cached one. This is the whole point of the function.
    const result = await current.getIdTokenResult(true);
    setIsAdmin(result.claims.admin === true);
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, isAdmin, refresh, refreshClaims }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  return useContext(AuthContext);
}
