/**
 * The shelter's ADOPTION CONTRACT — the text an applicant reads in the online
 * application before sending it. Portion 4, plan §5.
 *
 * ═══ NULL UNTIL THE SHELTER SUPPLIES ITS REAL TEXT ═════════════════════════
 * This is legal text that belongs to the shelter. It is never a placeholder,
 * never a draft and never text written by us. While it is null:
 *   - `buildApplicationCreate()` refuses to describe an application, so the
 *     browser cannot even attempt a submit;
 *   - `acceptedContracts()` in `firestore.rules` is EMPTY, so the rules refuse
 *     every create whatever the browser sends — a third lock beside
 *     `applicationsEnabled()`;
 *   - a test refuses `adoptionApplications.enabled: true`.
 *
 * What the online "acepto" means (owner decision, 2026-10-16): "I apply under
 * this contract". The contract itself is signed on paper at handover.
 *
 * ═══ CHANGING IT ═══════════════════════════════════════════════════════════
 * 1. Paste the owner's text verbatim into `title` and `clauses`.
 * 2. Set `version` to the date it takes effect (YYYY-MM-DD).
 * 3. Set `sha256` to the hex sha256 of `contractCanonicalText()` — the tests
 *    print the expected value when it is wrong.
 * 4. Put the same `{ 'version': 'sha256' }` pair in `acceptedContracts()` in
 *    `firestore.rules`, and DEPLOY THE RULES. A test fails if the two differ.
 *
 * Every revision is therefore a config change AND a rules deploy.
 */

export interface AdoptionContract {
  /** The date this text took effect, `YYYY-MM-DD`. Stored on every application. */
  version: string;
  /** Lower-case hex sha256 of `contractCanonicalText(this)`. Stored on every application. */
  sha256: string;
  /** Spanish, the shelter's own words. */
  title: string;
  /** Spanish, the shelter's own words, one entry per clause, in order. */
  clauses: string[];
}

/**
 * The shelter's REAL contract, verbatim, supplied by the owner. null until then.
 * Never a placeholder, never a draft, never text written by us.
 */
export const ADOPTION_CONTRACT: AdoptionContract | null = null;

/**
 * The exact text the hash covers: the title, then each clause, separated by a
 * blank line. Changing this function changes every hash, so it is pinned by a
 * test.
 */
export function contractCanonicalText(contract: Pick<AdoptionContract, 'title' | 'clauses'>): string {
  return [contract.title, ...contract.clauses].join('\n\n');
}
