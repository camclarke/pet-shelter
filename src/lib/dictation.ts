/**
 * Veterinary voice dictation: the PURE decision layer.
 *
 * No Firestore, no AI, no Spanish. It takes what two independent extractors
 * heard in the same recording and decides what a human must look at. The model
 * calls live in `src/lib/ai/dictate.ts`. Same split as `areas.ts`/`areas-admin.ts`.
 *
 * ═══ THIS IS THE HIGHEST-CONSEQUENCE PATH IN THE SYSTEM ═════════════════════
 * A misheard vaccination date is recoverable. A misheard dose is not.
 * "medio mililitro" and "cinco mililitros" differ by one syllable in spoken
 * Spanish and by a factor of ten in the animal. "15 mg" and "50 mg" are near
 * homophones. Plan §4.7.
 *
 * ═══ FAILURE DIRECTION: DROP, HARD ══════════════════════════════════════════
 * Playbook §6.2. An unparseable dose is `null` and a manual entry. There is no
 * defensible reason to guess a number that will be given to an animal. This
 * points the OPPOSITE way from the outbreak trace, which fails toward
 * INCLUDING a contact — there, a false positive costs one examination. Here a
 * false positive is a wrong drug dose. Two helpers from the same codebase,
 * deliberately opposite, and neither should be "unified" with the other.
 *
 * ═══ WHY BOTH EXTRACTORS MUST READ THE AUDIO ════════════════════════════════
 * ⚠️ The tempting shortcut — transcribe once, then run two extractors over the
 * TEXT — is not equivalent and is actively dangerous. The error that matters is
 * a MISHEARING. Two extractors reading one transcript would agree perfectly on
 * the same wrong number, and this comparison would pass them. Independent
 * acoustic paths are the entire point. See `src/lib/ai/dictate.ts`.
 *
 * The dedicated transcript is a THIRD signal and is the record of what was
 * said; it is never the input to the extractors.
 */

// ─────────────────────────────────────────────────────────────────────────────
// What a model may report
// ─────────────────────────────────────────────────────────────────────────────

export type DoseUnit = 'mg' | 'ml' | 'mg/kg' | 'UI' | 'gotas';

export type Route = 'oral' | 'sc' | 'im' | 'iv' | 'topica';

export interface MedicationClaim {
  /** As spoken. NOT normalised into an international spelling. */
  name: string;
  dose: number | null;
  doseUnit: DoseUnit | null;
  /** e.g. "1%", "50 mg/ml". Null when the vet did not say it — which is common. */
  concentration: string | null;
  route: Route | null;
  frequency: string | null;
  durationDays: number | null;
  /**
   * The literal phrase this was taken from. MANDATORY.
   *
   * This is the single most useful field in the schema. The reviewer sees
   * `heard: «medio mililitro»` beside `0.5 ml` and can judge in one glance
   * instead of replaying four minutes of audio.
   */
  heardAs: string;
  /** The model's own confidence, 0..1. Advisory only — never a gate on its own. */
  confidence: number;
}

export interface DictationExtraction {
  /** VERBATIM. The vet's actual words. */
  transcript: string;
  findings: string | null;
  medications: MedicationClaim[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Comparing two independent hearings
// ─────────────────────────────────────────────────────────────────────────────

/** Which fields, if they differ, mean a human must look. */
export type DisagreementField =
  | 'dose'
  | 'doseUnit'
  | 'concentration'
  | 'route'
  | 'frequency'
  | 'durationDays';

/**
 * Fields where a difference is a SAFETY issue rather than a detail.
 *
 * A disagreement on frequency is worth showing. A disagreement on dose or unit
 * is the reason this whole subsystem exists.
 */
export const CRITICAL_FIELDS: readonly DisagreementField[] = [
  'dose',
  'doseUnit',
  'concentration',
] as const;

export interface Disagreement {
  field: DisagreementField;
  a: string | number | null;
  b: string | number | null;
  critical: boolean;
}

export type MedicationStatus =
  /** Both extractors heard it and agree on every critical field. */
  | 'confirmed'
  /** Both heard it, but differ somewhere. */
  | 'disputed'
  /** Only ONE extractor heard this medication at all. */
  | 'singleton';

export interface ReviewedMedication {
  status: MedicationStatus;
  /** The merged claim. Critical fields in dispute are NULLED — never guessed. */
  medication: MedicationClaim;
  disagreements: Disagreement[];
  /** Which extractor(s) reported it, for the reviewer's context. */
  heardBy: ('a' | 'b')[];
  /** The other extractor's phrase, when they disagreed on what was said. */
  alternateHeardAs: string | null;
}

export interface ReviewedDictation {
  /** From the dedicated transcription model — the record of what was said. */
  transcript: string;
  findings: string | null;
  medications: ReviewedMedication[];
  /** True when ANY medication needs a human decision before this is usable. */
  needsReview: boolean;
  /** True when a CRITICAL field is in dispute anywhere. */
  hasCriticalDisagreement: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Normalisation, for comparison only
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fold a spoken drug name for MATCHING only.
 *
 * ⚠️ The stored `name` keeps the vet's own words. This is used to decide
 * whether two extractors are talking about the same medication, nothing else.
 * Normalising what gets stored would erase Bolivian veterinary vocabulary in
 * favour of international spellings, which plan §4.7 forbids.
 */
export function foldName(name: string): string {
  return name
    .normalize('NFD')
    // Strip the combining marks NFD just exposed. Written as an escape
    // range, never as literal combining characters: those are invisible in
    // an editor and a stray one pasted here would be undebuggable. Same
    // reasoning, and the same shape, as slugify() in intake.ts.
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Are two doses the same NUMBER? `0.5` and `0.50` are; `0.5` and `5` are not.
 *
 * Compared on the value, not on the string, so formatting differences between
 * extractors do not read as a safety disagreement — and a genuine order of
 * magnitude always does.
 */
export function sameDose(a: number | null, b: number | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  // Exact on value. Deliberately NOT a tolerance: there is no dose difference
  // small enough to be worth waving through automatically.
  return a === b;
}

function sameText(a: string | null, b: string | null): boolean {
  const fa = a === null ? null : foldName(a);
  const fb = b === null ? null : foldName(b);
  return fa === fb;
}

// ─────────────────────────────────────────────────────────────────────────────
// The comparison
// ─────────────────────────────────────────────────────────────────────────────

function compareOne(a: MedicationClaim, b: MedicationClaim): Disagreement[] {
  const out: Disagreement[] = [];

  if (!sameDose(a.dose, b.dose)) {
    out.push({ field: 'dose', a: a.dose, b: b.dose, critical: true });
  }
  if (a.doseUnit !== b.doseUnit) {
    out.push({ field: 'doseUnit', a: a.doseUnit, b: b.doseUnit, critical: true });
  }
  if (!sameText(a.concentration, b.concentration)) {
    out.push({
      field: 'concentration',
      a: a.concentration,
      b: b.concentration,
      critical: true,
    });
  }
  if (a.route !== b.route) {
    out.push({ field: 'route', a: a.route, b: b.route, critical: false });
  }
  if (!sameText(a.frequency, b.frequency)) {
    out.push({ field: 'frequency', a: a.frequency, b: b.frequency, critical: false });
  }
  if (a.durationDays !== b.durationDays) {
    out.push({
      field: 'durationDays',
      a: a.durationDays,
      b: b.durationDays,
      critical: false,
    });
  }

  return out;
}

/**
 * Merge two claims about the same medication.
 *
 * ⚠️ A critical field in dispute is set to NULL rather than resolved. Picking
 * one extractor's number would present a coin-flip as a reading, and the whole
 * point of running two is that neither is authoritative. A null shows up in the
 * UI as "the vet must fill this in", which is the correct outcome.
 *
 * Non-critical fields fall back to whichever extractor heard something, since
 * a missing frequency is an inconvenience rather than a hazard.
 */
function merge(a: MedicationClaim, b: MedicationClaim, disagreements: Disagreement[]): MedicationClaim {
  const disputed = new Set(disagreements.filter((d) => d.critical).map((d) => d.field));

  return {
    // The stored name comes from the more confident extractor, but both are
    // shown to the reviewer via heardAs / alternateHeardAs.
    name: a.confidence >= b.confidence ? a.name : b.name,
    dose: disputed.has('dose') ? null : a.dose,
    doseUnit: disputed.has('doseUnit') ? null : a.doseUnit,
    concentration: disputed.has('concentration') ? null : (a.concentration ?? b.concentration),
    route: a.route ?? b.route,
    frequency: a.frequency ?? b.frequency,
    durationDays: a.durationDays ?? b.durationDays,
    heardAs: a.confidence >= b.confidence ? a.heardAs : b.heardAs,
    // The pair is only as trustworthy as its weaker member.
    confidence: Math.min(a.confidence, b.confidence),
  };
}

/**
 * Compare two independent hearings of the same recording.
 *
 * ⚠️ Agreement is NOT proof of correctness. Two models can mishear the same
 * word the same way. This is a cheap filter that directs the vet's attention to
 * where the models diverged — it is not a verification step, and the UI must
 * never present a `confirmed` medication as checked.
 *
 * Medications only ONE extractor heard are kept, never dropped. Playbook §6.1:
 * keying on identity and keeping the first-seen object silently discards data
 * that only one extractor transcribed. A drug the vet mentioned once is exactly
 * the thing worth surfacing.
 */
export function reviewDictation(
  transcript: string,
  a: DictationExtraction,
  b: DictationExtraction
): ReviewedDictation {
  const bByName = new Map<string, MedicationClaim>();
  for (const med of b.medications) bByName.set(foldName(med.name), med);

  const seenInB = new Set<string>();
  const medications: ReviewedMedication[] = [];

  for (const medA of a.medications) {
    const key = foldName(medA.name);
    const medB = bByName.get(key);

    if (!medB) {
      medications.push({
        status: 'singleton',
        medication: medA,
        disagreements: [],
        heardBy: ['a'],
        alternateHeardAs: null,
      });
      continue;
    }

    seenInB.add(key);
    const disagreements = compareOne(medA, medB);
    medications.push({
      status: disagreements.length === 0 ? 'confirmed' : 'disputed',
      medication: merge(medA, medB, disagreements),
      disagreements,
      heardBy: ['a', 'b'],
      alternateHeardAs: medA.heardAs === medB.heardAs ? null : medB.heardAs,
    });
  }

  // Anything only B heard.
  for (const medB of b.medications) {
    if (seenInB.has(foldName(medB.name))) continue;
    medications.push({
      status: 'singleton',
      medication: medB,
      disagreements: [],
      heardBy: ['b'],
      alternateHeardAs: null,
    });
  }

  const hasCriticalDisagreement = medications.some((m) =>
    m.disagreements.some((d) => d.critical)
  );

  return {
    transcript,
    findings: a.findings ?? b.findings,
    medications,
    needsReview: medications.some((m) => m.status !== 'confirmed'),
    hasCriticalDisagreement,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Policy
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Does a critical disagreement BLOCK saving, or merely flag it loudly?
 *
 * ⚠️ Plan §4.7 specified a hard block. The project owner decided on
 * 2026-08-26 that errors are acceptable because the dictating vet reviews and
 * edits their own record, and chose FLAG over BLOCK. That is a legitimate call
 * — a gate stricter than the vet's reality gets worked around, which is plan
 * §3's own rule — and it is recorded here rather than buried so that changing
 * it is one line and one decision.
 *
 * What makes flagging defensible is that the dangerous error is a PLAUSIBLE
 * one: `0.5 ml` and `5 ml` both read as normal, so a reviewer skimming will not
 * catch it by reading. The mitigation is not a block, it is making the check
 * take two seconds — `heardAs` beside the number, and a word timestamp that
 * plays the moment the vet said it. If that verification affordance is ever
 * removed from the UI, this constant should go back to true.
 */
export const BLOCK_ON_CRITICAL_DISAGREEMENT = false;

/**
 * A dose the system may DISPLAY as an arithmetic aid, never store.
 *
 * ⚠️ Returns a labelled calculation, not a prescription. The system must never
 * write a computed dose into a medical record as though it were prescribed:
 * that is the line between a transcription tool and an unlicensed prescribing
 * system, and it is not a line to be near. Plan §4.7.
 *
 * Returns null when the dose is not weight-based or the weight is unknown — a
 * `mg/kg` dose against a null weight is not a partial record, it is an
 * uninterpretable one.
 */
export function displayOnlyDoseAid(
  med: Pick<MedicationClaim, 'dose' | 'doseUnit'>,
  weightKg: number | null
): { mg: number; label: 'calculated' } | null {
  if (med.doseUnit !== 'mg/kg') return null;
  // Belt and braces: the isFinite check below already rejects null, so a
  // deliberate-break probe cannot make this line fail independently. Kept
  // because an explicit null test states the precondition where a reader
  // looks for it, and it becomes load-bearing the moment isFinite is
  // loosened. The BEHAVIOUR is what the tests assert.
  if (med.dose === null || weightKg === null) return null;
  if (!Number.isFinite(med.dose) || !Number.isFinite(weightKg)) return null;
  if (weightKg <= 0) return null;
  return { mg: med.dose * weightKg, label: 'calculated' };
}
