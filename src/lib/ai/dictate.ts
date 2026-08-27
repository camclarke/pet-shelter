import 'server-only';

import { generateObject, generateText } from 'ai';
import { z } from 'zod';

import { google } from './google';
import { FLASH_LITE_MODEL, FLASH_MODEL, TRANSCRIBE_MODEL } from './model-ids';
import { recordAiUsage } from './metered';
import {
  reviewDictation,
  type DictationExtraction,
  type ReviewedDictation,
} from '../dictation';

/**
 * Veterinary voice dictation: the model calls.
 *
 * What the answers are WORTH lives in `src/lib/dictation.ts`, pure and tested.
 * This file only obtains them. Plan §4.7.
 *
 * ═══ THREE CALLS, AND THE SHAPE IS THE SAFETY DESIGN ════════════════════════
 *
 *   1. TRANSCRIPT   gemini-3.5-transcribe    — the record of what was said
 *   2. EXTRACTOR A  gemini-3.6-flash         — reads the AUDIO
 *   3. EXTRACTOR B  gemini-3.1-flash-lite    — reads the AUDIO
 *
 * ⚠️ Both extractors read the AUDIO, never the transcript. This is the whole
 * design and it is easy to "simplify" away. The error that kills an animal is a
 * MISHEARING — "medio mililitro" against "cinco mililitros". Two extractors
 * reading one transcript would agree perfectly on the same wrong number and the
 * consensus check would pass them. Independent acoustic paths are what catch
 * it. If someone ever refactors this into transcribe-then-extract-twice, the
 * tests will still pass and the safety property will be gone.
 *
 * ⚠️ Two DIFFERENT TIERS, deliberately. The playbook measured a Flash +
 * Flash-Lite pair disagreeing on ~100% of extractions. That is the property
 * wanted here — a disagreement costs the vet ten seconds, and an agreement
 * between two identical models would mean nothing at all.
 *
 * ═══ AGREEMENT IS NOT PROOF ═════════════════════════════════════════════════
 * Two models can mishear the same word the same way. This is a cheap filter
 * that points the vet's attention at where the models diverged. The UI must
 * never present a `confirmed` medication as verified.
 */

const MedicationSchema = z.object({
  name: z.string(),
  dose: z.number().nullable(),
  doseUnit: z.enum(['mg', 'ml', 'mg/kg', 'UI', 'gotas']).nullable(),
  concentration: z.string().nullable(),
  route: z.enum(['oral', 'sc', 'im', 'iv', 'topica']).nullable(),
  frequency: z.string().nullable(),
  durationDays: z.number().nullable(),
  heardAs: z.string(),
  confidence: z.number(),
});

const ExtractionSchema = z.object({
  transcript: z.string(),
  findings: z.string().nullable(),
  medications: z.array(MedicationSchema),
});

/**
 * Exported so an eval harness imports the SAME prompt production uses.
 *
 * ⚠️ Re-measure after ANY wording change. Playbook §6.3: removing a single
 * framing sentence dropped a sibling-stack eval from 11/11 to 9/11, because
 * without it the model padded the gap with invented content.
 */
export const DICTATION_SYSTEM = `
Sos un asistente que transcribe la consulta de un veterinario en un refugio de
Cochabamba, Bolivia, y extrae los medicamentos indicados.

REGLA PRINCIPAL: transcribí EXACTAMENTE lo que se escucha. No corrijas, no
completes, no interpretes. Si no se entiende una palabra, dejala como se
escucha o marcala como inaudible. El campo transcript es el registro de lo que
dijo el veterinario y tiene que poder leerse como tal.

DOSIS. Es lo más importante de todo el trabajo y donde un error hace daño.
- Poné en heardAs la frase LITERAL de la que sacaste cada dosis, con las
  palabras del veterinario: "medio mililitro", "cinco mililitros", "quince
  miligramos". Quien revisa necesita ver la frase al lado del número.
- Si escuchás "medio", la dosis es 0.5. Si escuchás "cinco", es 5. Son
  distintas y suenan parecido: no elijas la más probable, poné la que
  escuchaste.
- Si no estás seguro de un número, poné dose en null. Un null lo completa una
  persona; un número inventado se le da al animal. NUNCA adivines una dosis.
- La concentración y el volumen son cosas distintas. "Un mililitro de
  ivermectina" no dice la concentración: dejá concentration en null en vez de
  suponerla.
- No calcules nada. Si el veterinario dice mg/kg, poné mg/kg y el número que
  dijo. No lo multipliques por el peso.

MEDICAMENTOS. Escribí el nombre como lo dijo el veterinario, con vocabulario
veterinario boliviano. No lo "corrijas" a la grafía internacional ni al nombre
comercial de otro país.

Este bloque establece qué transcribir y qué extraer, y nada más. No agregues
diagnósticos que no se dijeron, no sugieras tratamientos, no completes una
receta que quedó a medias.
`.trim();

const EXTRACT_INSTRUCTION =
  'Escuchá esta consulta veterinaria. Transcribila textualmente y extraé los medicamentos indicados.';

const TRANSCRIBE_INSTRUCTION = `
Transcribí este audio de una consulta veterinaria en español boliviano,
palabra por palabra. No corrijas la gramática, no completes frases y no
resumas. Si una palabra es inaudible, marcala como [inaudible].
`.trim();

/** A consult must not hang the vet's screen forever. */
export const DICTATION_TIMEOUT_MS = 120_000;

export interface DictationResult {
  reviewed: ReviewedDictation;
  /**
   * How many of the two extractors succeeded.
   *
   * ⚠️ When this is 1 there was NO cross-check. Every medication is a
   * singleton and the UI must say so — a lone extractor's output presented the
   * same way as a confirmed one is exactly the false assurance this design
   * exists to prevent.
   */
  extractorsSucceeded: 1 | 2;
  transcriptModel: string;
}

async function extract(model: string, audio: Uint8Array, mediaType: string) {
  const { object, usage, providerMetadata } = await generateObject({
    model: google(model),
    schema: ExtractionSchema,
    system: DICTATION_SYSTEM,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: EXTRACT_INSTRUCTION },
          { type: 'file', data: audio, mediaType },
        ],
      },
    ],
    abortSignal: AbortSignal.timeout(DICTATION_TIMEOUT_MS),
  });

  void recordAiUsage({
    process: 'dictation_extract',
    model,
    usage,
    providerMetadata,
  });

  return object as DictationExtraction;
}

async function transcribe(audio: Uint8Array, mediaType: string): Promise<string> {
  const { text, usage, providerMetadata } = await generateText({
    model: google(TRANSCRIBE_MODEL),
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: TRANSCRIBE_INSTRUCTION },
          { type: 'file', data: audio, mediaType },
        ],
      },
    ],
    abortSignal: AbortSignal.timeout(DICTATION_TIMEOUT_MS),
  });

  void recordAiUsage({
    process: 'dictation_transcribe',
    model: TRANSCRIBE_MODEL,
    usage,
    providerMetadata,
  });

  return text;
}

/**
 * Transcribe a consult and extract its prescriptions, twice, independently.
 *
 * Throws only when NOTHING usable came back. A single surviving extractor is a
 * degraded but honest result and is reported as such.
 */
export async function dictateConsult(
  audio: Uint8Array,
  mediaType: string
): Promise<DictationResult> {
  // ⚠️ allSettled, never all. One extractor failing must not discard the
  // other's work — playbook §6.1. The transcript is settled alongside them so a
  // transcription failure does not lose two successful extractions either.
  const [transcriptRes, aRes, bRes] = await Promise.allSettled([
    transcribe(audio, mediaType),
    extract(FLASH_MODEL, audio, mediaType),
    extract(FLASH_LITE_MODEL, audio, mediaType),
  ]);

  const a = aRes.status === 'fulfilled' ? aRes.value : null;
  const b = bRes.status === 'fulfilled' ? bRes.value : null;

  if (!a && !b) {
    throw new Error('dictation: both extractors failed');
  }

  // Fall back to an extractor's own transcript ONLY if the dedicated model
  // failed. Degraded, and worth knowing about, but better than losing the words.
  const transcript =
    transcriptRes.status === 'fulfilled'
      ? transcriptRes.value
      : ((a ?? b)!.transcript ?? '');

  if (transcriptRes.status === 'rejected') {
    console.warn('[dictation] transcription failed; fell back to an extractor transcript');
  }

  // With one extractor there is no second opinion. Comparing a result against
  // ITSELF would mark every medication `confirmed`, which would be a lie — so
  // it is compared against an empty extraction, making every one a singleton.
  const empty: DictationExtraction = { transcript, findings: null, medications: [] };

  const reviewed = reviewDictation(transcript, a ?? empty, b ?? empty);

  return {
    reviewed,
    extractorsSucceeded: a && b ? 2 : 1,
    transcriptModel: TRANSCRIBE_MODEL,
  };
}
