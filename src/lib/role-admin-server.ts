import 'server-only';

import type { UserRecord } from 'firebase-admin/auth';
import { FieldValue } from 'firebase-admin/firestore';

import { getAdminAuth, getAdminDb, verifyAdminIdToken } from './firebase-admin';
import type { AuthAccount, RoleAdminDeps } from './role-admin-handler';

/**
 * The role routes' SERVER side, through the Admin SDK. Only `/api/roles/*`
 * uses this.
 *
 * ⚠️ The Admin SDK BYPASSES the rules and is the only thing that can write a
 * custom claim. Every decision is made in `role-admin-handler.ts` (tested);
 * this file only binds Auth, Firestore and the clock to it. The Cloud Run
 * service account already holds `roles/firebaseauth.admin` (plan §12.4,
 * measured 2026-10-26), so no IAM change is needed.
 */

function account(user: UserRecord): AuthAccount {
  return {
    uid: user.uid,
    email: user.email ?? null,
    displayName: user.displayName ?? null,
    claims: (user.customClaims as Record<string, unknown> | undefined) ?? null,
  };
}

const audit = () => getAdminDb().collection('roleAudit');

/** Everything the role routes need. */
export function roleAdminDeps(): RoleAdminDeps {
  const auth = getAdminAuth();
  return {
    verifyIdToken: verifyAdminIdToken,
    nowMs: () => Date.now(),
    listAllUsers: async () => {
      // Paged to the end: a list that stops at page one would miscount the owners.
      const users: AuthAccount[] = [];
      let pageToken: string | undefined;
      do {
        const page = await auth.listUsers(1000, pageToken);
        users.push(...page.users.map(account));
        pageToken = page.pageToken;
      } while (pageToken);
      return users;
    },
    getUserByEmail: async (email) => {
      try {
        return account(await auth.getUserByEmail(email));
      } catch (error) {
        if ((error as { code?: unknown } | null)?.code === 'auth/user-not-found') return null;
        throw error;
      }
    },
    getUser: async (uid) => account(await auth.getUser(uid)),
    setClaims: (uid, claims) => auth.setCustomUserClaims(uid, claims),
    revokeRefreshTokens: (uid) => auth.revokeRefreshTokens(uid),
    addAudit: async (entry) => {
      const ref = await audit().add({ ...entry, at: FieldValue.serverTimestamp() });
      return ref.id;
    },
    markAuditApplied: async (id, claimsRead) => {
      await audit().doc(id).update({ outcome: 'applied', appliedAt: FieldValue.serverTimestamp(), claimsRead });
    },
    readAuditOutcome: async (id) => {
      const snap = await audit().doc(id).get();
      return snap.exists ? snap.get('outcome') : null;
    },
    // One line, never a raw error object, an email or a claim.
    log: (message) => console.warn(message),
  };
}
