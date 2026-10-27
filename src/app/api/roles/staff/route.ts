import { handleRoleStaff } from '@/lib/role-admin-handler';
import { roleAdminDeps } from '@/lib/role-admin-server';

/**
 * GET /api/roles/staff — the owner or the superuser lists every account that
 * holds a role, EXCEPT accounts holding `su`, with what the caller may grant
 * or revoke on each. `StaffResponse` in `role-admin-protocol.ts`.
 *
 * Everything that decides lives in `src/lib/role-admin-handler.ts`; this file
 * only supplies the Admin SDK. ⚠️ Outside the rules: the handler verifies the
 * token (`requireRole`, `checkRevoked`) itself, first.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  return handleRoleStaff(request, roleAdminDeps());
}
