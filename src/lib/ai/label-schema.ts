/**
 * The structured-output schema for reading a vaccine or medicine LABEL.
 * Plan C3, 2026-10-14.
 *
 * In its own module, with no `server-only` import, so the unit suite can
 * assert its shape and the eval harness imports the SAME schema production
 * uses — the reason `intake-prompt.ts` and `food-parse-schema.ts` exist.
 *
 * ⚠️ THERE IS NO "DATE GIVEN" AND NO "NEXT DOSE" FIELD, and that is the safety
 * design, not an omission. A label never prints when a dose was given or when
 * the next one is due; it prints when the vial was made and when it expires.
 * Measured 2026-10-14 on Bravo's stickers: a card prompt never read a sticker
 * date as the next dose (0 of 12), and this shape keeps it that way by
 * construction — a field that does not exist cannot be filled with a guess.
 * The same idea kept `sex` out of photo intake until a genital photo made it
 * readable. `label-prompt.test.ts` pins the field list.
 *
 * ⚠️ The lot and both dates carry `fieldWord`, the word printed beside them
 * («N. Lote», «F. Venc», «F. Elab»). On both Zoetis Vanguard stickers the card
 * reader copied the coloured tab's number instead of the lot, 6 of 6. The word
 * is what tells a lot from every other number on a label, so the pure layer
 * refuses a lot or a date whose word is missing or wrong.
 */

import { z } from 'zod';

const Text = z.object({
  snippet: z.string().nullable(),
  // Deliberately NOT `.min(0).max(1)`: a schema that rejects one bad
  // confidence throws away the whole label. The pure layer turns an
  // out-of-range value into 0, which withholds that ONE field.
  confidence: z.number(),
});

const Labelled = z.object({
  /** The word printed beside the value, exactly as printed. */
  fieldWord: z.string().nullable(),
  snippet: z.string().nullable(),
  confidence: z.number(),
});

export const LabelExtractionSchema = z.object({
  isVeterinaryLabel: z.boolean(),
  product: Text,
  manufacturer: Text,
  protectsAgainst: Text,
  lot: Labelled,
  manufacturedAt: Labelled,
  expiresAt: Labelled,
});

export type LabelExtractionShape = z.infer<typeof LabelExtractionSchema>;
