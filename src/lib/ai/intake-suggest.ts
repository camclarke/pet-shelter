import 'server-only';

import { generateObject } from 'ai';
import { z } from 'zod';

import { google } from './google';
import { FLASH_LITE_MODEL, FLASH_MODEL, modelKeyFor } from './model-ids';
import type { PetPhotoSlot } from '../types';
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

  /**
   * ⚠️ A DELIBERATE REVERSAL, made by the owner on 2026-08-30.
   *
   * Sex was absent from this schema by construction, and there was a test
   * asserting it could not be added. The reasoning stands and is worth
   * keeping in view: sex drives Spanish gender agreement in every sentence
   * on the site — the species noun, the size adjective, every past
   * participle — so one wrong value makes the whole page ungrammatical in
   * the only language its readers use.
   *
   * What changed is the evidence available. The guided capture asks for a
   * GENITAL photograph, which makes this readable rather than guessable.
   * Two guards remain: decideSex refuses unless that slot was actually
   * supplied, and the value is OFFERED for one tap rather than prefilled.
   * Do not promote it to prefill without re-reading the above.
   */
  sex: z.enum(['male', 'female']).nullable(),
  sexConfidence: z.enum(['high', 'medium', 'low']),
  /** True only if the model actually saw genitalia, not inferred from build. */
  sexFromGenitalPhoto: z.boolean(),
  /** Visible desexing evidence: absent testicles, a spay scar. */
  apparentlySterilized: z.enum(['yes', 'no', 'unknown']),

  visibleType: z.string().nullable(),
  isLikelyPurebred: z.boolean(),
  purebredGuess: z.string().nullable(),
  /**
   * Breeds the animal RESEMBLES, for a mixed-breed. Structured rather than
   * left inside `visibleType` prose, because the wizard has to compose a
   * label — "mestizo con rasgos de pastor alemán" — and cannot parse a
   * sentence for it. Capped at 3: a longer list stops reading as a
   * resemblance and starts reading as a guess.
   */
  resemblesBreeds: z.array(z.string()).max(3),

  lifeStage: z.enum(['puppy', 'young', 'adult', 'senior']).nullable(),
  ageMonthsMin: z.number().nullable(),
  ageMonthsMax: z.number().nullable(),
  ageBasis: z.enum(['teeth', 'body', 'coat', 'unknown']),
  ageConfidence: z.enum(['high', 'medium', 'low']),

  size: z.enum(['small', 'medium', 'large']).nullable(),
  sizeConfidence: z.enum(['high', 'medium', 'low']),
  hasSizeReference: z.boolean(),

  /**
   * Colour and coat are SEPARATE questions and were one `coatDescription`
   * string until 2026-08-30. "negro, gris y blanco con máscara facial" and
   * "doble capa, largo y denso" are different facts: the first is what someone
   * types when searching for a lost dog, the second is what tells an adopter
   * how much brushing they are signing up for.
   */
  colorPattern: z.string().nullable(),
  coatType: z.string().nullable(),
  distinguishingMarks: z.string().nullable(),

  /**
   * Posture, build, bearing — whatever stands out that is not covered above.
   * Deliberately NOT the place for anything health-adjacent: `notes` is the
   * only channel for that, so the vet has one field to read rather than
   * hunting through a coat description.
   */
  generalObservations: z.string().nullable(),

  /**
   * An estimated weight RANGE in kg, never a single number.
   *
   * Rescuers have no scale, and the vet arrives hours or days later, so
   * something is better than nothing for choosing a pen and planning rations.
   * But a weight read off a photograph is a guess, and this one is barred from
   * mg/kg dosing by `weightIsEstimate` travelling with it everywhere.
   */
  weightKgMin: z.number().nullable(),
  weightKgMax: z.number().nullable(),
  weightConfidence: z.enum(['high', 'medium', 'low']),

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

Además, en resemblesBreeds poné entre una y tres razas a las que este animal se
PAREZCA, ordenadas de más a menos parecida — por ejemplo ["pastor alemán",
"husky siberiano"]. Esto NO afirma que sea de esa raza: describe a qué se
parece, que es lo que una persona buscando adoptar entiende de un vistazo.
Usá nombres de raza comunes en español. Si de verdad no se parece a ninguna
raza reconocible, devolvé una lista vacía — eso también es una respuesta
válida y es mejor que inventar un parecido.

FOTOS. Vas a recibir entre una y cuatro fotografías, cada una precedida de
una etiqueta que dice qué es: «frente», «perfil», «dientes» o «genitales».
Usá cada una para lo que sirve y no para otra cosa:

- La EDAD se estima SÓLO de la foto de dientes. Si no hay foto de dientes,
  poné ageConfidence en "low" y devolvé un rango honesto o ninguno. El pelo
  claro alrededor del hocico NO es canas: en muchas razas es la máscara
  facial y no dice nada de la edad.
- El SEXO se determina SÓLO de la foto de genitales. Si no hay foto de
  genitales, poné sex en null, sexFromGenitalPhoto en false y
  sexConfidence en "low". No lo deduzcas del tamaño ni de la forma del
  cuerpo: no se ve ahí.
- En apparentlySterilized poné "yes" sólo si se ve evidencia clara
  (testículos ausentes, cicatriz de castración). Ante la duda, "unknown".
- La RAZA, el COLOR y el PELAJE se leen de las fotos de frente y de perfil.

COLOR Y PELAJE. Son dos campos distintos y no los mezcles. En colorPattern
poné los colores y las marcas visibles — por ejemplo "negro, gris y blanco, con
máscara facial y pecho blanco". En coatType poné la textura, el largo y la
densidad — por ejemplo "doble capa, largo y denso, con flecos en las patas".
El color es lo que escribe alguien que busca a su perro perdido; el pelaje es
lo que le dice a quien adopta cuánto cepillado le espera.

OBSERVACIONES. En generalObservations describí el porte, la postura y lo que
llame la atención y no entre en los campos anteriores. NO pongas nada de salud
acá: para eso está notes, y el veterinario necesita un solo campo que leer.

PESO. Estimá un rango en kilos en weightKgMin y weightKgMax, nunca un número
único, y sólo si hay algo en la foto que dé escala. Sin escala poné los dos en
null y weightConfidence en "low": un perro solo en una foto puede pesar 4 kg o
40 kg. Quien rescata no tiene balanza, así que este número sirve para elegir un
área y calcular raciones aproximadas, y NUNCA para calcular una dosis.

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

/**
 * A photo suggestion should never hold up an intake.
 *
 * ⚠️ PER ATTEMPT, not for the whole operation — and that distinction is the
 * whole point of this constant.
 *
 * Measured in production 2026-08-30, four real calls from a phone:
 *
 *   ok      4683ms  photo=323KB
 *   FAILED 25009ms  photo=393KB
 *   ok      6795ms  photo=435KB
 *   FAILED 25001ms  photo=229KB
 *
 * Read those numbers carefully. Photo size is NOT the variable — the largest
 * succeeded and the smallest failed. The failures sit on the abort to the
 * millisecond, which means the request never came back at all rather than
 * being slow: a hung connection, not a slow model. Successes are 4.7-6.8s.
 *
 * The earlier design passed ONE `AbortSignal.timeout(25_000)` to
 * generateObject alongside `maxRetries: 1`. That retry was unreachable: the
 * signal spans every attempt, so a hang on the first consumed the entire
 * budget and the second never started. A retry that cannot run is worse than
 * no retry, because it reads like resilience that is not there.
 *
 * So the budget is per attempt now, and the retry is ours. 12s is roughly
 * double the slowest success, so a healthy call is never cut off, and a hung
 * one is abandoned early enough to try again on a fresh connection inside a
 * total budget an admin will still wait through.
 */
export const SUGGEST_ATTEMPT_TIMEOUT_MS = 12_000;

/**
 * The Flash tier needs its own, larger budget. Measured on the same real
 * photograph 2026-08-30:
 *
 *   gemini-3.6-flash       10060 ms
 *   gemini-3.1-flash-lite   3991 ms
 *
 * Flash reasons before answering, which is exactly what buys the correct
 * age — so the latency is the feature, not overhead to squeeze out. 12s was
 * calibrated for Lite and left Flash no headroom once the structured schema
 * was added: the first real run aborted twice and returned nothing.
 *
 * 25s is roughly 2.5x the measured time, matching the margin Lite has.
 */
export const SUGGEST_ATTEMPT_TIMEOUT_MS_FLASH = 25_000;

/**
 * Extra budget per photo beyond the first.
 *
 * The budget has to scale with the photo count, not just the tier. Measured
 * 2026-08-30 on Flash-Lite: one image 4978ms, two images 7240ms, so roughly
 * +2.2s per image. Flash runs about 2.5x slower, hence ~6s.
 *
 * ⚠️ Extrapolated from TWO images, not measured at four. A two-photo Flash
 * run took ~13s on the attempt that succeeded. Re-measure when guided capture
 * actually sends four, and do not trust this constant until then — the last
 * two times a timeout was set from a guess rather than a measurement it was
 * wrong in production.
 */
export const SUGGEST_PER_EXTRA_PHOTO_MS_FLASH = 6_000;
export const SUGGEST_PER_EXTRA_PHOTO_MS_LITE = 2_500;

/**
 * Per-attempt budget for the tier being called AND the number of photos.
 *
 * A single shared budget across attempts was the bug fixed earlier today; a
 * budget that ignores photo count is the same mistake one axis over.
 */
export function attemptTimeoutMsFor(modelId: string, photoCount = 1): number {
  const lite = modelId.includes('lite');
  const base = lite ? SUGGEST_ATTEMPT_TIMEOUT_MS : SUGGEST_ATTEMPT_TIMEOUT_MS_FLASH;
  const perExtra = lite
    ? SUGGEST_PER_EXTRA_PHOTO_MS_LITE
    : SUGGEST_PER_EXTRA_PHOTO_MS_FLASH;
  return base + perExtra * Math.max(0, photoCount - 1);
}

/** Attempts in total, not retries after the first. */
export const SUGGEST_MAX_ATTEMPTS = 2;

/**
 * Kept as the OVERALL ceiling the caller can reason about, and it is what the
 * route's 504 means. Deliberately a little over attempts x per-attempt, since
 * each attempt carries its own setup.
 */
export const SUGGEST_TIMEOUT_MS =
  SUGGEST_ATTEMPT_TIMEOUT_MS_FLASH * SUGGEST_MAX_ATTEMPTS + 1_000;

/**
 * The Flash tier, not Flash-Lite — and the reason is an error, not a preference.
 *
 * Measured 2026-08-30 in AI Studio, same prompt and same photographs, on a
 * husky-type dog: a Lite-tier model read the white facial MASK as muzzle
 * greying and called the animal "mature adult to senior, 6-8+ years". A
 * full Flash model with thinking on read the dentition instead and returned
 * "young adult, 1.5-3 years". The Lite run even noted the teeth were clean
 * and then overrode itself with the coat.
 *
 * On a public listing that gap decides whether an animal is passed over, so
 * age is what buys the tier. Breed, colour and coat are comfortable on Lite.
 *
 * ⚠️ gemini-3.7-flash is available on this key and tested well, but it is
 * listed in UNPRICED_BUT_AVAILABLE and the rule recorded there is to add the
 * price row BEFORE swapping. Until an invoice gives a real rate, this stays
 * on the priced model. Switching is one env var, GEMINI_FLASH_MODEL, and no
 * deploy — do it once the row exists.
 */
export const SUGGEST_MODEL = FLASH_MODEL;

/**
 * Used only when the primary is out of daily quota.
 *
 * Free-tier limits on this project, read off its own quota 2026-08-30:
 * Flash models get 20 requests/day, Flash-Lite gets 500. So the strong
 * model runs out first, and falling back to a weaker answer beats failing
 * — an intake must never depend on a suggestion. The degradation is
 * recorded in the modelKey, so a later reader can tell which tier
 * produced a given record.
 */
export const SUGGEST_FALLBACK_MODEL = FLASH_LITE_MODEL;

/** One photograph plus the slot it was taken for. */
export interface SlottedPhoto {
  slot: PetPhotoSlot;
  bytes: Uint8Array;
  mediaType: string;
}

/**
 * The Spanish label each slot is announced with in the prompt. These strings
 * are read by the MODEL, not by a person, but they are Spanish because the
 * whole prompt is — mixing languages in one instruction measurably degrades
 * following, and the prompt is the one place this project does not keep
 * Spanish out of code.
 */
const SLOT_LABEL: Record<PetPhotoSlot, string> = {
  front: 'frente',
  side: 'perfil',
  teeth: 'dientes',
  genitals: 'genitales',
  other: 'otra',
};

export interface SuggestResult {
  suggestion: RawPhotoSuggestion;
  /** The stable model KEY, for provenance. Never the raw id. */
  modelKey: string;
}

/**
 * Ask the model what it sees. Throws on failure — the caller decides what a
 * failure means, and for intake it means "carry on without suggestions".
 */
/**
 * Out of quota, as opposed to broken. Matched on the status rather than the
 * message, because the message is provider prose and will change.
 */
function isQuotaExhausted(err: unknown): boolean {
  const status = (err as { statusCode?: number; status?: number } | null)?.statusCode
    ?? (err as { status?: number } | null)?.status;
  return status === 429;
}

/** A timeout or an abort — the shapes worth retrying, since both mean "no answer". */
function isTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
}

/**
 * Retry ONLY on a timeout, and only within SUGGEST_MAX_ATTEMPTS.
 *
 * Deliberately narrow. A 400 for a malformed image, a 401 for a bad key or a
 * 429 for a spent quota will all fail the same way twice, and retrying them
 * just doubles the wait before the admin sees the message they needed
 * immediately. A hang is the one failure a second attempt genuinely fixes,
 * because it gets a new connection.
 */
async function withRetry<T>(call: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= SUGGEST_MAX_ATTEMPTS; attempt++) {
    const started = Date.now();
    try {
      return await call();
    } catch (err) {
      lastErr = err;
      if (!isTimeout(err) || attempt === SUGGEST_MAX_ATTEMPTS) throw err;
      // Logged per attempt, so a future failure still says which attempt died
      // and how long it took — the thing that was missing when this was one
      // opaque 25s abort.
      console.warn(
        `[intake-suggest] attempt ${attempt}/${SUGGEST_MAX_ATTEMPTS} timed out after ${Date.now() - started}ms; retrying`
      );
    }
  }
  throw lastErr;
}

/**
 * ⚠️ Takes the WHOLE photo set in ONE call, never one call per photo.
 *
 * Measured 2026-08-30: an image costs ~1064 input tokens and the prompt
 * costs ~990, paid once. So four photos batched is 5246 tokens against 8216
 * for four separate calls — but the tokens are not the point. Free-tier
 * quota is counted in REQUESTS, and the Flash tier gets 20 a day. Batched
 * that is 20 animals a day; one call per photo would be five.
 */
export async function suggestFromPhoto(
  photos: readonly SlottedPhoto[]
): Promise<SuggestResult> {
  if (photos.length === 0) throw new Error('suggestFromPhoto: at least one photo is required');
  try {
    return await extractWith(SUGGEST_MODEL, photos);
  } catch (err) {
    if (!isQuotaExhausted(err)) throw err;
    // Degrade rather than fail. Plan §3: a gate stricter than the reality of
    // the shelter gets worked around, and an animal arriving at 22:00 must
    // not wait on a daily quota.
    console.warn(
      `[intake-suggest] ${SUGGEST_MODEL} out of quota; falling back to ${SUGGEST_FALLBACK_MODEL}`
    );
    return extractWith(SUGGEST_FALLBACK_MODEL, photos);
  }
}

async function extractWith(
  modelId: string,
  photos: readonly SlottedPhoto[]
): Promise<SuggestResult> {
  const { object, usage, providerMetadata } = await withRetry(() =>
    generateObject({
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
        model: google(modelId),
      schema: SuggestionSchema,
      system: INTAKE_SUGGEST_SYSTEM,
      messages: [
        {
          role: 'user',
          // Each image is preceded by its own label. Without it the model has
          // to work out which photo is which — the AI Studio run that got the
          // age right had to write "Dental Indicators (Image 1)" to say so.
          // Two labels measured at ~14 tokens, so this is effectively free.
          content: [
            { type: 'text', text: USER_INSTRUCTION },
            ...photos.flatMap((p) => [
              { type: 'text' as const, text: `Foto: ${SLOT_LABEL[p.slot]}` },
              { type: 'image' as const, image: p.bytes, mediaType: p.mediaType },
            ]),
          ],
        },
      ],
      // A FRESH signal per attempt — see SUGGEST_ATTEMPT_TIMEOUT_MS. Creating
      // it inside the callback is load-bearing: hoisting it out would restore
      // the single shared budget this replaced.
      abortSignal: AbortSignal.timeout(attemptTimeoutMsFor(modelId, photos.length)),
      // 0, because withRetry owns retrying. Leaving the SDK's own retries on
      // would nest two policies and make the timing impossible to reason about.
      maxRetries: 0,
    })
  );

  // void, never awaited: metering must not be able to break the thing it
  // measures, and must not add latency to an admin waiting on a form.
  void recordAiUsage({
    process: 'intake_suggest',
    model: modelId,
    usage,
    providerMetadata,
  });

  return {
    suggestion: object as RawPhotoSuggestion,
    modelKey: String(modelKeyFor(modelId)),
  };
}
