'use client';

import { useEffect, useState } from 'react';

import {
  SUGGEST_TOTAL_BUDGET_MS,
  analysisPhaseFor,
  type AnalysisPhase,
} from '@/lib/ai/suggest-budget';

/**
 * What the shelter sees while the model is looking at the photographs.
 *
 * ── The one rule this component exists to obey ───────────────────────────────
 * ⚠️ NEVER ANIMATE PROGRESS THE SERVER HAS NOT REPORTED. `/api/intake/suggest`
 * is a single opaque call: it does not stream, it does not report stages, and
 * it cannot say how far through the model is. Anything that fills up smoothly
 * toward "done" would be inventing a number, and the first time it sat at 90%
 * and then failed, the person holding the animal would stop believing the
 * screen — which is worse than the static "Analizando…" this replaces.
 *
 * So the bar measures ELAPSED TIME against a KNOWN CEILING, and says so. It is
 * a clock, not a progress bar, and it is labelled as one.
 *
 * ── The three honest facts ───────────────────────────────────────────────────
 * Everything shown here comes from a constant this codebase owns, plus the
 * browser's own clock:
 *
 *   1. SUGGEST_TOTAL_BUDGET_MS — we will give up at 50s, because Firebase
 *      Hosting terminates the request at 60s and an answer past that cannot be
 *      delivered. So the wait is genuinely bounded, and saying so is useful:
 *      "cerca de un minuto" left people guessing whether to keep waiting.
 *   2. firstAttemptEndsAtMs() — an attempt is CLAMPED, so once that window has
 *      passed there really is a second attempt under way. That is an
 *      inference, but a sound one: no attempt can outlive the clamp.
 *   3. The elapsed time itself.
 *
 * What is deliberately NOT shown: which model is running, which tier of the
 * cascade we are on, or how many attempts remain. The browser cannot know any
 * of it — the retry and the tier walk both happen inside one HTTP request —
 * and guessing would be the same lie as a fake progress bar, told in words.
 */

/**
 * The phase itself is decided in `suggest-budget.ts` — pure, and therefore
 * unit-tested. Only the WORDS live here. Same split as everywhere else.
 */
const PHASE_TEXT: Record<AnalysisPhase, string> = {
  first: 'Primer intento.',
  // True whether the server is retrying the same model or has moved to the
  // next one — both are a second attempt, and which it is cannot be known here.
  retrying: 'El primer intento no respondió. Estamos probando otra vez.',
  'nearly-up': 'Se acabó el tiempo de espera; estamos cerrando el intento.',
};

export interface AnalysisProgressProps {
  /** How many photographs went in the request. Sets the attempt window. */
  photoCount: number;
  /**
   * The heading. Defaults to intake's. Vaccination-card reading passes its
   * own, because it runs under the same budget and the same clock facts.
   */
  title?: string;
  /** What is already safe, said after "No cierres esta pantalla —". */
  savedNote?: string;
}

export function AnalysisProgress({
  photoCount,
  title = 'Mirando las fotos…',
  savedNote = 'las fotos ya se guardaron y quedan aunque el análisis falle.',
}: AnalysisProgressProps) {
  const [elapsedMs, setElapsedMs] = useState(0);

  useEffect(() => {
    const startedAt = Date.now();
    // Once a second. A faster tick would buy nothing — the numbers shown are
    // whole seconds — and would only make the bar look smoother than the
    // information behind it actually is.
    const id = setInterval(() => setElapsedMs(Date.now() - startedAt), 1000);
    return () => clearInterval(id);
  }, []);

  const totalS = Math.round(SUGGEST_TOTAL_BUDGET_MS / 1000);
  const elapsedS = Math.floor(elapsedMs / 1000);
  const phase = analysisPhaseFor(elapsedMs, photoCount);
  const pct = Math.min(100, (elapsedMs / SUGGEST_TOTAL_BUDGET_MS) * 100);

  return (
    <div className="analysing">
      <div className="analysing__head">
        <strong>{title}</strong>
        <span className="t-data analysing__clock">
          {elapsedS}s de {totalS}s
        </span>
      </div>

      {/* Decorative: the meaning is in the text, and this is a clock rather
          than a measure of work done, so it carries no progressbar role. */}
      <div className="analysing__track" aria-hidden="true">
        <div className="analysing__fill" style={{ width: `${pct}%` }} />
      </div>

      {/* Coarse, so a screen reader is not read a new number every second. */}
      <p className="auth__hint analysing__phase" role="status">
        {PHASE_TEXT[phase]}{' '}
        <strong>No cierres esta pantalla</strong> — {savedNote}
      </p>
    </div>
  );
}
