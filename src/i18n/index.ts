/**
 * Locale selection.
 *
 * One locale ships today (`es`), chosen by `SHELTER.locale` so a forking
 * shelter switches language in config rather than in code. Adding English is
 * adding `en.ts` and one entry to `LOCALES` — the `Messages` interface makes
 * the compiler list anything the new file forgot.
 *
 * ⚠️ This resolves the locale ONCE, at module load, from configuration. It is
 * deliberately not per-request: there is no locale segment in the URL yet and
 * no language negotiation, so pretending otherwise would be a lie the type
 * system would happily tell. Route-level i18n (`/[locale]/…`) is the follow-up
 * this module exists to make cheap — see CLAUDE.md.
 */

import { SHELTER } from '@/config/shelter';
import type { Messages } from './messages';
import { es } from './es';

const LOCALES: Record<string, Messages> = { es };

/** The active message catalogue. Import this, not a specific locale file. */
const language = SHELTER.locale.split('-')[0] ?? 'es';
export const t: Messages = LOCALES[language] ?? es;

export type { Messages } from './messages';
