import { handleRoleChange } from '@/lib/role-admin-handler';
import { roleAdminDeps } from '@/lib/role-admin-server';

/**
 * POST /api/roles/change — `{email, role, action}`. The owner or the
 * superuser grants or revokes ONE role on another person's account, within
 * the guardrails of plan §12.2 (`decideRoleChange()`), after a sign-in under
 * five minutes old. Writes `roleAudit` before and after, as the grant script
 * does. `su` is never changed here.
 *
 * Everything that decides lives in `src/lib/role-admin-handler.ts`; this file
 * only supplies the Admin SDK. ⚠️ Outside the rules, and it writes the claims
 * every rule trusts: the handler verifies the token, the recent sign-in and
 * every guardrail itself.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleRoleChange(request, roleAdminDeps());
}
