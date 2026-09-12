/**
 * Spanish register tripwires: does a piece of text ADDRESS someone, and does
 * it speak voseo?
 *
 * Pure, with no `server-only` import, so the unit suite and the eval harness
 * can both use it — the same split as `intake-prompt.ts`, `suggest-budget.ts`
 * and `areas.ts`.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * On 2026-09-12 a real four-photo intake (the draft that became "Lobita")
 * returned, for `generalObservations`:
 *
 *     Permaneces echada de lado en el suelo de baldosas con actitud tranquila
 *     y relajada. Tu pelaje es muy abundante.
 *
 * The model was talking TO the dog. `npm run eval:intake` could not have
 * noticed: nothing in it read prose register at all.
 *
 * ⚠️ These are WORD-LIST TRIPWIRES, not a parser. Spanish second person cannot
 * be recognised from a finite list — every verb has a tú form — so an empty
 * result means "none of the forms we know to look for", never "this text is in
 * third person". The lists cover what production actually produced plus the
 * forms an observation or a note is most likely to reach for. Read the text as
 * well; the eval prints it for exactly that reason.
 */

/**
 * ⚠️ NOT `\b`. JavaScript's `\b` is ASCII-only even under the `u` flag: it
 * treats "ú" and "ñ" as non-word characters. So `\btú\b` never matches "tú "
 * (there is no boundary between "ú" and a space), and `\bte\b` DOES match
 * inside "teñido" (a false boundary before "ñ"). Letter-aware lookarounds get
 * both right, and both are pinned by a test.
 */
const BEFORE = '(?<![\\p{L}\\p{N}])';
const AFTER = '(?![\\p{L}\\p{N}])';

function wordPattern(words: readonly string[]): RegExp {
  const alternation = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return new RegExp(`${BEFORE}(?:${alternation})${AFTER}`, 'giu');
}

function findAll(pattern: RegExp, text: string | null | undefined): string[] {
  if (!text) return [];
  return [...text.matchAll(pattern)].map((m) => m[0]);
}

/**
 * Forms that ADDRESS someone in the second person — tú and vos alike.
 *
 * ⚠️ Accent-sensitive on purpose. "estás" addresses someone; "estas patas" is a
 * demonstrative. Folding accents, as the eval's breed matcher does, would make
 * "estas" a hit on every description of legs.
 *
 * ⚠️ Deliberately NOT listed, because they are also ordinary nouns an
 * observation or a vet note can legitimately use: "muestras" (samples) and
 * "miras" (sights). A tripwire that cries wolf gets switched off.
 */
export const SECOND_PERSON_FORMS: readonly string[] = [
  // pronouns and possessives
  'tú', 'tu', 'tus', 'te', 'ti', 'contigo', 'vos',
  // tú verbs a description or a note is likely to reach for — "permaneces" is
  // the one production actually produced
  'eres', 'estás', 'tienes', 'pareces', 'permaneces', 'presentas', 'descansas',
  'puedes', 'debes', 'necesitas', 'sigues',
  // the same, in voseo
  'sos', 'tenés', 'parecés', 'podés', 'debés',
];

/**
 * Voseo: the Rioplatense forms the prompt forbids — and, until 2026-09-12, used
 * itself in six places ("Estimá" twice, "Indicá", "usalos", "Sugerí",
 * "señalá") while telling the model "Nada de voseo".
 */
export const VOSEO_FORMS: readonly string[] = [
  'vos', 'sos', 'tenés', 'querés', 'podés', 'sabés',
  'sacá', 'poné', 'elegí', 'mirá', 'fijate', 'usá', 'usalos', 'tomá', 'dejá',
  'contá', 'pensá', 'estimá', 'indicá', 'sugerí', 'señalá', 'observá',
  'completá', 'describí', 'escribí', 'devolvé', 'decí', 'hacé', 'vení', 'andá',
];

const SECOND_PERSON = wordPattern(SECOND_PERSON_FORMS);
const VOSEO = wordPattern(VOSEO_FORMS);

/** Every second-person form in `text`, as it appears, in order. */
export function findSecondPerson(text: string | null | undefined): string[] {
  return findAll(SECOND_PERSON, text);
}

/** Every voseo form in `text`, as it appears, in order. */
export function findVoseo(text: string | null | undefined): string[] {
  return findAll(VOSEO, text);
}

/**
 * Remove quoted spans — "…", “…” and «…» — so a prompt's COUNTER-EXAMPLES
 * (`Nada de voseo ("sacá", "poné")`) are not mistaken for the prompt speaking
 * that way. Quotes may span lines: the prompt is hard-wrapped at ~78 columns.
 *
 * ⚠️ Straight quotes pair left to right, so an unbalanced count would shift
 * every pair after it and strip real instructions — hiding exactly the words a
 * check is looking for. `intake-prompt.test.ts` asserts the count is even.
 */
export function stripQuoted(text: string): string {
  return text.replace(/"[^"]*"|“[^”]*”|«[^»]*»/g, ' ');
}

/** The free-text fields the model writes and a person reads. */
export const PROSE_FIELDS = [
  'visibleType',
  'colorPattern',
  'coatType',
  'distinguishingMarks',
  'generalObservations',
  'notes',
] as const;

export type ProseField = (typeof PROSE_FIELDS)[number];

/**
 * Every second-person form in the model's prose, labelled by field — the
 * register check `npm run eval:intake` scores.
 *
 * ⚠️ ALL prose fields, not only `generalObservations`. That is where it was
 * seen, but the cause was a prompt-wide instruction, and a fix that merely
 * moved the defect into `notes` must not score as a fix.
 */
export function proseRegisterFindings(
  raw: Partial<Record<ProseField, string | null | undefined>>
): string[] {
  return PROSE_FIELDS.flatMap((field) =>
    findSecondPerson(raw[field]).map((form) => `${field}: ${form}`)
  );
}
