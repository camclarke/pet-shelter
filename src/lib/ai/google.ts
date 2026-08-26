import 'server-only';

import { createGoogleGenerativeAI } from '@ai-sdk/google';

/**
 * The Gemini provider. AI Studio with an API key — never Vertex.
 *
 * ⚠️ SERVER ONLY, and the `server-only` import above is what enforces it: any
 * client component that reaches this module fails the BUILD rather than
 * shipping a key to the browser. `GEMINI_API_KEY` is a real secret, unlike the
 * six `NEXT_PUBLIC_FIREBASE_*` values, which are public by design. Do not add a
 * `NEXT_PUBLIC_` alias for it under any circumstances — that prefix means
 * "compile this into the bundle and serve it to everyone".
 *
 * This is why intake extraction goes through a route handler rather than being
 * called from `IntakeWizard.tsx` directly. That has a consequence worth naming:
 * a route handler sits OUTSIDE `firestore.rules`, so it must check the caller's
 * ID token and admin claim itself. See `src/app/api/intake/suggest/route.ts`.
 *
 * Why AI Studio and not Vertex, in one line: it needs no `aiplatform` API, no
 * IAM grant and no ADC, so an AI call cannot resolve to the wrong project
 * because it does not resolve to a project at all. Cost is one secret.
 * See `docs/gemini-api-playbook.md`.
 */

const apiKey = process.env.GEMINI_API_KEY?.trim() ?? '';

export const google = createGoogleGenerativeAI({
  apiKey,
  // v1beta is required for Gemini 3 preview models. The v1 surface silently
  // lacks them — silently, which is the part that costs an afternoon.
  baseURL: 'https://generativelanguage.googleapis.com/v1beta',
  // The SDK sets this implicitly from `apiKey`. Making it explicit rules out a
  // Bearer-vs-x-goog-api-key transport mismatch when debugging a 401.
  headers: { 'x-goog-api-key': apiKey },
});

/**
 * Whether an API key is configured at all.
 *
 * Callers use this to degrade politely rather than throw: the intake wizard
 * must keep working with the key absent, because photo suggestions are an
 * accelerator and the shelter still has to be able to admit an animal at 22:00
 * when a dependency is down. Plan §3's rule — a gate stricter than the
 * shelter's reality gets worked around, and the workaround is the WhatsApp
 * group this system exists to replace.
 */
export function aiIsConfigured(): boolean {
  return apiKey.length > 0;
}
