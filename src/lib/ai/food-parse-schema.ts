/**
 * The structured-output schema for donation parsing.
 *
 * In its own module, with no `server-only` import, so the unit suite can
 * assert it and the eval harness can import the SAME schema production uses —
 * the reason `intake-prompt.ts` was split out of `intake-suggest.ts`.
 *
 * ⚠️ Every quantity field is a STRING, deliberately. The model copies the
 * words; `parseQuantityPhrase` turns them into grams. A `z.number()` here would
 * invite the model to do arithmetic, which is the one thing plan §12.1 keeps
 * away from it.
 */

import { z } from 'zod';

import type { FoodCategory } from '../types';

/**
 * Mirrors `FoodCategory`. A test holds the two together, because a category
 * the schema offers and the pantry does not know is a line that can never be
 * stocked.
 */
export const FOOD_CATEGORY_VALUES = [
  'meat',
  'offal',
  'bone',
  'grain',
  'vegetable',
  'kibble',
  'wet-food',
  'other',
] as const satisfies readonly FoodCategory[];

export const DonationParseSchema = z.object({
  /** Who brought it, copied from the text. Null when the text does not say. */
  donor: z.string().nullable(),
  items: z
    .array(
      z.object({
        /** The exact fragment of the text this food came from. */
        snippet: z.string(),
        /** The food, as named in the text. */
        food: z.string(),
        category: z.enum(FOOD_CATEGORY_VALUES),
        /** The quantity words, copied: "3 bolsas", "2 kg", "medio kilo". */
        amount: z.string().nullable(),
        /** The size of each container, copied: "de 5 kg". */
        packageSize: z.string().nullable(),
        /** The expiry words, copied: "vence el 20/10/2026". */
        expiry: z.string().nullable(),
        confidence: z.enum(['high', 'medium', 'low']),
      })
    )
    // Loose on purpose, like the intake schema's name list: a schema that
    // rejects a long answer throws away the whole parse to enforce a cap the
    // pure layer applies for free (DONATION_MAX_LINES).
    .max(60),
});

export type DonationParse = z.infer<typeof DonationParseSchema>;
