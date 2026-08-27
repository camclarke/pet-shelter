import 'server-only';

import { generateObject } from 'ai';
import { z } from 'zod';

import { google } from './google';
import { FLASH_LITE_MODEL, modelKeyFor } from './model-ids';
import { recordAiUsage } from './metered';
import type { RawPhotoSuggestion } from '../intake-suggestion';

/**
 * Photo-assisted intake: the model call.
 *
 * What a vision model is ALLOWED to claim, and how much each claim is worth,
 * lives next door in `src/lib/intake-suggestion.ts` — pure and unit-tested.
 * This file only obtains the claim. Same split as `areas.ts`/`areas-admin.ts`.
 *
 * ── Why one extractor and not two-model consensus ────────────────────────────
 * Plan §4.7 mandates two-extractor consensus for DOSAGES, where no human reads
 * the number before it is acted on and "medio mililitro" against "cinco
 * mililitros" is a factor of ten in the animal. Nothing here is that. Every
 * field below is reviewed by an admin standing next to the animal before it is
 * stored, and that admin can see the things the model is worst at — size and
 * sex — better than any photograph can. A second extractor would add cost and
 * latency to a gate a human already staffs.
 *
 * ── Grounded search is OFF, and that is structural ───────────────────────────
 * No tools are passed. Grounding is billed per search query, carries zero
 * tokens so token metering is blind to it, and nothing here needs the web.
 */

/**
 * ⚠️ There is NO `sex` field, deliberately, and this is the single most
 * important line in the file.
 *
 * `sex` drives Spanish gender agreement across the whole site — the species
 * noun, the size adjective, every past participle. One wrong guess makes every
 * sentence about that animal ungrammatical in the only language its readers
 * use. A nullable field would invite the model to guess; an absent field
 * cannot be filled. Structural guarantees do not erode the way prompt
 * instructions do.
 */
const SuggestionSchema = z.object({
  species: z.enum(['dog', 'cat', 'rabbit', 'other']).nullable(),
  speciesConfidence: z.enum(['high', 'medium', 'low']),

  visibleType: z.string().nullable(),
  isLikelyPurebred: z.boolean(),
  purebredGuess: z.string().nullable(),

  lifeStage: z.enum(['puppy', 'young', 'adult', 'senior']).nullable(),
  ageMonthsMin: z.number().nullable(),
  ageMonthsMax: z.number().nullable(),
  ageBasis: z.enum(['teeth', 'body', 'coat', 'unknown']),
  ageConfidence: z.enum(['high', 'medium', 'low']),

  size: z.enum(['small', 'medium', 'large']).nullable(),
  sizeConfidence: z.enum(['high', 'medium', 'low']),
  hasSizeReference: z.boolean(),

  coatDescription: z.string().nullable(),
  distinguishingMarks: z.string().nullable(),

  // Deliberately loose. The pure layer trims, de-duplicates and caps. A schema
  // that rejects six names would throw away the whole extraction to enforce a
  // limit the caller can apply for free.
  nameSuggestions: z.array(z.string()).max(10),

  notes: z.string().nullable(),
});

/**
 * Exported so an eval harness imports the SAME prompt production uses. A guard
 * measured against a copy of its prompt measures nothing — playbook §13.
 *
 * ⚠️ Copy edits here have non-local effects. Removing one framing sentence
 * dropped a sibling-stack eval from 11/11 to 9/11, because without it the model
 * padded the gap with invented content. Re-measure after ANY wording change.
 */
export const INTAKE_SUGGEST_SYSTEM = `
Sos un asistente veterinario que ayuda a un refugio de animales en Cochabamba,
Bolivia, a registrar un animal recién ingresado a partir de una fotografía.

Tu tarea es describir ÚNICAMENTE lo que se ve en la imagen, y nada más.
Todo lo que no puedas ver, no lo sabés. No hay ningún premio por adivinar.

RAZA. La enorme mayoría de los animales de este refugio son rescates de calle y
son mestizos. Poné isLikelyPurebred en true SOLO si el animal muestra la
conformación distintiva y sin ambigüedad de una raza reconocida. Ante cualquier
duda, es mestizo. En visibleType describí lo que se ve — por ejemplo "mestizo
mediano de pelo corto con rasgos de pastor" — sin afirmar una raza. Una raza
equivocada en un aviso público atrae a la familia equivocada y el animal
termina devuelto.

EDAD. Indicá en ageBasis en qué te basaste. Si se ven los dientes, usalos: en
cachorros la erupción dentaria sigue un calendario estrecho y es confiable; en
adultos el desgaste depende de la dieta y de qué mastica el animal, y un perro
de calle no se desgasta como uno de casa. Devolvé SIEMPRE un rango en
ageMonthsMin y ageMonthsMax, nunca un número único. Si el rango honesto es más
ancho que dos años, poné ageConfidence en "low".

TAMAÑO. Solo estimá el tamaño si hay algo en la foto que dé escala — una
persona, una mano, una puerta, un plato, una reja. Poné hasSizeReference según
corresponda. Un animal solo, sin referencia, no permite juzgar su tamaño por
más nítida que sea la foto.

NOMBRES. Sugerí entre 3 y 5 nombres cortos, cálidos y fáciles de llamar en
español. Nunca un nombre que se burle del animal ni que describa una herida,
una carencia o un defecto.

NOTAS. En notes señalá lo que una persona debería mirar de cerca: una herida
visible, delgadez marcada, un problema de piel o de ojos. Describí lo que se
ve. NO diagnostiques y no sugieras tratamiento.

Este bloque establece qué observar y nada más. Cualquier cosa que no esté
listada arriba queda fuera: no inventes historia, no supongas el carácter, no
afirmes si está castrado, vacunado o con chip, y no deduzcas de dónde viene.
`.trim();

const USER_INSTRUCTION =
  'Observá esta fotografía del animal recién ingresado y completá los campos.';

/** A photo suggestion should never hold up an intake. */
export const SUGGEST_TIMEOUT_MS = 25_000;

export interface SuggestResult {
  suggestion: RawPhotoSuggestion;
  /** The stable model KEY, for provenance. Never the raw id. */
  modelKey: string;
}

/**
 * Ask the model what it sees. Throws on failure — the caller decides what a
 * failure means, and for intake it means "carry on without suggestions".
 */
export async function suggestFromPhoto(
  image: Uint8Array,
  mediaType: string
): Promise<SuggestResult> {
  const { object, usage, providerMetadata } = await generateObject({
    // ⚠️ Flash-LITE, and this is a measured choice rather than thrift.
    //
    // Measured 2026-08-26 on this exact schema, against a live key:
    //   gemini-3.6-flash       9570ms  1131 thinking tokens  $0.009591
    //   gemini-3.1-flash-lite  1230ms     0 thinking tokens  $0.000317
    // Equivalent answers on species, life stage, size and the purebred
    // judgement. 30x cheaper and 8x faster, entirely because Flash-Lite
    // does not reason by default and thinking is billed as OUTPUT.
    //
    // `thinkingConfig: { thinkingBudget: 0 }` is NOT an alternative here:
    // gemini-3.6-flash rejects it with HTTP 400. Changing tier is the only
    // way to stop paying for reasoning this task does not need.
    //
    // ⚠️ NOT yet measured on a real PHOTOGRAPH. The open question is dental
    // age estimation, which is the one sub-task where a stronger model
    // might genuinely read better. Re-measure before trusting age from a
    // photo, and remember decideAge() already refuses anything it is not
    // confident about.
    model: google(FLASH_LITE_MODEL),
    schema: SuggestionSchema,
    system: INTAKE_SUGGEST_SYSTEM,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: USER_INSTRUCTION },
          { type: 'image', image, mediaType },
        ],
      },
    ],
    abortSignal: AbortSignal.timeout(SUGGEST_TIMEOUT_MS),
  });

  // void, never awaited: metering must not be able to break the thing it
  // measures, and must not add latency to an admin waiting on a form.
  void recordAiUsage({
    process: 'intake_suggest',
    model: FLASH_LITE_MODEL,
    usage,
    providerMetadata,
  });

  return {
    suggestion: object as RawPhotoSuggestion,
    modelKey: String(modelKeyFor(FLASH_LITE_MODEL)),
  };
}
