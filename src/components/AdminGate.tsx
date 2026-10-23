/**
 * The gate every admin screen sits behind.
 *
 * ── What this is NOT ───────────────────────────────────────────────────────
 * This is not the security boundary. It cannot be: it runs in the browser,
 * where anyone can edit the state it reads. The real boundary is
 * `firestore.rules` and `storage.rules`, both of which gate every write on
 * `request.auth.token.admin == true`, and both of which have been proven to
 * enforce against a real client. Someone who bypasses this component reaches
 * exactly one thing: a form whose every save fails with `permission-denied`.
 *
 * What it IS is the difference between "you are not an admin" and a wall of
 * red errors. That is worth a component, and it is worth being honest that
 * the value is UX rather than security — a gate that is quietly believed to
 * be the authorization layer is how authorization gets removed from the layer
 * that actually has it.
 *
 * ── Why it forces a token refresh ──────────────────────────────────────────
 * `useAuth().isAdmin` comes from the CACHED ID token, which can lag a claim
 * grant by up to an hour — see the note in `AuthProvider`. That lag is
 * harmless everywhere else in the app and intolerable here: it is exactly the
 * moment someone was just promoted and is trying to get in. So this mounts,
 * forces a refresh, and only then decides. The refresh is why a person who
 * was granted the claim thirty seconds ago does not have to sign out and back
 * in.
 *
 * ── Sections ───────────────────────────────────────────────────────────────
 * Since roles (2026-10-22) every page names its `section`, and the gate asks
 * `canAccess()` in `src/config/roles.ts` whether the signed-in roles open
 * it: a rescuer reaches the dashboard and intake, event staff the dashboard
 * and events, coordination everything. The prop is REQUIRED, so a new admin
 * page cannot forget to say which section it is; `admin-sections.test.ts`
 * also checks every page under `src/app/admin` passes the right one. The
 * same caveat as above applies: this is the difference between a clear
 * message and a wall of permission errors, not the boundary.
 */

'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/components/AuthProvider';
import { SHELTER } from '@/config/shelter';
import { canAccess, isStaff, type AdminSection } from '@/config/roles';

export function AdminGate({ section, children }: { section: AdminSection; children: React.ReactNode }) {
  const { user, loading, roles, refreshClaims } = useAuth();
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    if (loading) return;
    if (!user) {
      setChecking(false);
      return;
    }
    let cancelled = false;
    refreshClaims()
      .catch((error) => console.error('[admin] could not refresh claims', error))
      .finally(() => {
        if (!cancelled) setChecking(false);
      });
    return () => {
      cancelled = true;
    };
  }, [loading, user, refreshClaims]);

  if (loading || checking) {
    return (
      <div className="admin-gate" aria-busy="true">
        <p className="admin-gate__note">Verificando permisos…</p>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="admin-gate">
        <h1 className="t-title">Panel del refugio</h1>
        <p className="admin-gate__note">
          Esta sección es para el equipo de {SHELTER.shortName}. Inicia sesión para continuar.
        </p>
        <Link href="/account" className="btn btn--action">
          Iniciar sesión
        </Link>
      </div>
    );
  }

  if (isStaff(roles) && !canAccess(section, roles)) {
    // A member of the team, on a screen their role does not open. Saying so
    // beats "you have no permissions", which reads as a broken grant.
    return (
      <div className="admin-gate">
        <h1 className="t-title">Panel del refugio</h1>
        <p className="admin-gate__note">
          Esta sección no es parte de tu rol. Si la necesitas, pídele a quien administra el sistema
          que te dé acceso.
        </p>
        <div className="admin-gate__actions">
          <Link href="/admin" className="btn btn--muted">
            Volver al panel
          </Link>
        </div>
      </div>
    );
  }

  if (!canAccess(section, roles)) {
    return (
      <div className="admin-gate">
        <h1 className="t-title">Panel del refugio</h1>
        <p className="admin-gate__note">
          Tu cuenta (<strong>{user.email}</strong>) todavía no tiene permisos de administración.
          Pídele a quien administra el sistema que te habilite, y luego vuelve a entrar.
        </p>
        <div className="admin-gate__actions">
          <Link href="/" className="btn btn--muted">
            Volver al inicio
          </Link>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
