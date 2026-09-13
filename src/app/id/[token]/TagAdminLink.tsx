'use client';

import Link from 'next/link';
import { useAuth } from '@/components/AuthProvider';

/**
 * The only signed-in extra on a tag page: a link to the animal's internal
 * record, for an admin.
 *
 * It makes NO read. `isAdmin` comes from the cached ID token the auth
 * provider already holds, so this cannot depend on a rule that is not
 * deployed, and it costs a finder's page nothing. The internal page itself
 * sits behind `AdminGate` and the rules; this link is a shortcut, not a
 * permission.
 *
 * Renders nothing while auth is still resolving, so a signed-out visitor never
 * sees it flash.
 */
export function TagAdminLink({ petId, label }: { petId: string; label: string }) {
  const { loading, isAdmin } = useAuth();
  if (loading || !isAdmin) return null;
  return (
    <p className="tag-page__admin">
      <Link href={`/admin/pets/${encodeURIComponent(petId)}`} className="auth__link">
        {label}
      </Link>
    </p>
  );
}
