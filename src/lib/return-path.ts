/**
 * Where to send someone after they sign in — PURE, no Firebase, no Spanish.
 *
 * The apply page sends a signed-out visitor to `/account?next=…` so that
 * signing in or creating an account brings them straight back to the form.
 * A `next` parameter is also the textbook open redirect: a link to
 * `wawitas.org/account?next=https://evil.example` that bounces a freshly
 * signed-in visitor to a look-alike page asking for their password again.
 *
 * So this is an ALLOWLIST, not a sanitiser. The only place anyone is ever
 * returned to is an adoption application form, `/adopt/{slug}/apply`, with a
 * slug in the same kebab-case the seeder and the intake wizard enforce. Anything
 * else — another host, a protocol-relative `//`, a backslash, a query string,
 * an encoded character — returns null and the visitor simply stays on
 * `/account`. Widening this later means adding a pattern, deliberately.
 *
 * It changes nothing about what the sign-in form SAYS. The enumeration
 * protections in `src/lib/auth.ts` hold exactly as before: a failed sign-in
 * never redirects, and a successful one was going to reveal nothing anyway.
 */

const RETURN_PATTERNS: readonly RegExp[] = [/^\/adopt\/[a-z0-9]+(?:-[a-z0-9]+)*\/apply$/];

const MAX_RETURN_PATH_LENGTH = 160;

export function safeReturnPath(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  if (raw.length === 0 || raw.length > MAX_RETURN_PATH_LENGTH) return null;
  return RETURN_PATTERNS.some((pattern) => pattern.test(raw)) ? raw : null;
}

/** The `/account` link that returns here afterwards. */
export function signInHrefReturningTo(path: string): string {
  const safe = safeReturnPath(path);
  return safe ? `/account?next=${encodeURIComponent(safe)}` : '/account';
}
