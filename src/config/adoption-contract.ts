/**
 * The shelter's ADOPTION CONTRACT — the COMPROMISOS page of Wawitas' paper
 * adoption document, which an applicant reads in the online application before
 * sending it. Portion 4c-1, plan §4.
 *
 * ═══ VERBATIM, INCLUDING ITS SPELLING ══════════════════════════════════════
 * Every word below is the shelter's, transcribed from the paper document the
 * owner says a lawyer approved, and confirmed by the owner word for word on
 * 2026-10-16 (Bolivia time, UTC−4). The ORIGINAL spelling is kept exactly — "sacare" (no accent),
 * "ADOPCION" (no accent), "TIENEN" (plural), "SANSIONES" (with S). These are
 * NOT typos to fix: changing one changes the text the lawyer approved, and the
 * hash below with it.
 *
 * Only the layout of the paper was normalised, and only like this:
 *   - the heading, COMPROMISOS, is printed large, centred and underlined; its
 *     WORD is the first block of the hashed text, its size, centring and
 *     underline are presentation (the transcription was corrected against
 *     the photograph on 2026-10-17: it had omitted the heading);
 *   - a line the paper wraps is joined with ONE space;
 *   - the opening's two printed lines ("Yo …… mayor de edad," / "con C.I. ……
 *     me comprometo …") are one sentence here: only the paper's line break goes;
 *   - each dotted blank (……) becomes a token, CONTRACT_NAME_TOKEN and
 *     CONTRACT_CI_TOKEN, filled with the applicant's own name and C.I. when the
 *     text is shown;
 *   - the bold clause is a presentation flag (`emphasizedClauses`), not markup;
 *   - the signature line (FIRMA ADOPTANTE ……… FIRMA RESCATISTA) is NOT part of
 *     the online text: the contract is signed in ink at handover (owner
 *     decision D11), and signature lines beside a checkbox would read as an
 *     electronic signature, which this is not.
 *
 * What the online "acepto" means (owner decision, 2026-10-16): "I apply under
 * this contract". The contract itself is signed on paper at handover.
 *
 * ═══ CHANGING IT ═══════════════════════════════════════════════════════════
 * 1. Paste the owner's text verbatim into `opening`, `clauses` and `closing`.
 * 2. Set `version` to the date it takes effect (YYYY-MM-DD).
 * 3. Set `sha256` to the hex sha256 of `contractCanonicalText()` — the tests
 *    print the expected value when it is wrong.
 * 4. Put the same `{ 'version': 'sha256' }` pair in `acceptedContracts()` in
 *    `firestore.rules`, and DEPLOY THE RULES. A test fails if the two differ.
 *
 * Every revision is therefore a config change AND a rules deploy. A browser
 * tab still showing the old version is refused at submit, by design.
 */

export interface AdoptionContract {
  /** The date this text took effect, `YYYY-MM-DD`. Stored on every application. */
  version: string;
  /** Lower-case hex sha256 of `contractCanonicalText(this)`, UTF-8. Stored on every application. */
  sha256: string;
  /**
   * The heading PRINTED above the commitments on the paper, verbatim — or null
   * when the paper prints none (owner decision D8). Hashed, as the first block:
   * it is printed text.
   */
  heading: string | null;
  /**
   * The opening sentence, verbatim, with `CONTRACT_NAME_TOKEN` and
   * `CONTRACT_CI_TOKEN` exactly once each where the paper leaves a blank.
   */
  opening: string;
  /** The "Me comprometo…" commitments, verbatim, one entry each, in the paper's order. */
  clauses: readonly string[];
  /** The closing paragraph ("EN CASO DE INCUMPLIR…"), verbatim. */
  closing: string;
  /**
   * Indexes into `clauses` printed in BOLD on the paper. Presentation only, and
   * deliberately NOT part of the hash (owner decision D10): bold is how the
   * text looks, not what it says.
   */
  emphasizedClauses: readonly number[];
}

/** Where the paper leaves a dotted blank for the applicant's name. */
export const CONTRACT_NAME_TOKEN = '{nombre}';
/** Where the paper leaves a dotted blank for the applicant's C.I. number. */
export const CONTRACT_CI_TOKEN = '{ci}';

/**
 * The shelter's REAL contract, verbatim. Confirmed by the owner word for word
 * on 2026-10-16, Bolivia time (version = that date, owner decision D9). The
 * transcription was corrected against the photograph on 2026-10-17 (the
 * heading); the version stays the confirmation date.
 */
export const ADOPTION_CONTRACT: AdoptionContract | null = {
  version: '2026-10-16',
  sha256: '0874ed097f5fe7ad17ead270413a360ea00009910bec18d3b68bf20656a3dcfa',
  // Printed large, centred and underlined on page 2.
  heading: 'COMPROMISOS',
  opening:
    'Yo {nombre} mayor de edad, con C.I. {ci} me comprometo a cumplir la lista de cuidados de mi animal de compañía:',
  clauses: [
    'Me comprometo a cuidar el animal que estoy recibiendo dándole todos los cuidados que necesita (alimentación, cuidados médicos veterinarios, vacunas, cariño, techo, tiempo, ejercicio o paseos y demás cuidados requeridos por el animal).',
    'Me comprometo a tener el animal en mi compañía durante toda su vida, no lo abandonaré, no lo sacare a la calle sin correa y sin supervisión, no lo venderé, regalaré, permutaré, cederé o alquilaré ya que tengo la CUSTODIA del animal.',
    'Me comprometo, en caso de pérdida o robo del animal que estoy adoptando, a poner dicha circunstancia en conocimiento inmediato del encargado de adopción que me entregó este documento en un plazo máximo de 48 horas desde el momento del hecho.',
    'Me comprometo a costear gastos de mi animal de compañía en caso de ser necesarios.',
    'Me comprometo a vacunar y tener la cartilla de vacunas de mi animal de compañía, al día y a la mano con las vacunas correspondientes y sus refuerzos anuales.',
    'Me comprometo a darle un trato digno, sin violencia, peleas, ni explotación animal o someterlo a sufrimiento o muerte.',
    'Me comprometo a no mutilar al animal ni someterlo a cirugías estéticas innecesarias (desungulación, corte de cuerdas vocales, amputación de cola, corte de orejas, implante testicular, etc.).',
    'Me comprometo a esterilizar o castrar a mi animal de compañía adoptado antes de los 6 meses de edad en caso de no contar con dicha operación, para ello, coordinaré con el encargado de adopción que me entregó este documento.',
    'Me comprometo a colocar permanentemente un collar que porte una placa identificativa con nombre del animalito y números de celular del dueño, para evitar pérdidas con sufrimientos para el animalito y la familia adoptante.',
  ],
  closing:
    'EN CASO DE INCUMPLIR EL PRESENTE COMPROMISO. LA LEY 700/2015, BAJO REGLAMENTOS MUNICIPALES, EL ENCARGADO DE ADOPCION TIENEN TODA LA POTESTAD DE DAR POR NULA LA ADOPCIÓN Y SUJETAR A CORRESPONDIENTES SANSIONES. DEBIENDO ENTREGAR AL ANIMAL ADOPTADO EN 24 HRS, CASO CONTRARIO SE REALIZARÁN ACCIONES LEGALES CORRESPONDIENTES.',
  // The 48-hour loss-or-theft clause is the one the paper prints in bold.
  emphasizedClauses: [2],
};

/**
 * The exact text the hash covers: the heading (if the paper prints one), the
 * opening TEMPLATE (tokens unfilled), each clause, and the closing — separated
 * by a blank line. The rules hold ONE pair for every applicant, so the hash is
 * of the template; the filled-in name and C.I. are stored anyway (the name in
 * `answers`, the C.I. in `private/identity`). Changing this function changes
 * every hash, so it is pinned by a test.
 */
export function contractCanonicalText(
  contract: Pick<AdoptionContract, 'heading' | 'opening' | 'clauses' | 'closing'>,
): string {
  return [
    ...(contract.heading ? [contract.heading] : []),
    contract.opening,
    ...contract.clauses,
    contract.closing,
  ].join('\n\n');
}

/**
 * The words of the one checkbox an applicant ticks before sending (owner
 * decision D12). `{mascota}` is the animal's name.
 *
 * Deliberately no "lo" or "la": a pronoun for the animal would need gender
 * agreement, and this string lives in config, outside `src/i18n`'s helpers.
 *
 * ⚠️ `isDraft` stays TRUE until the owner AND the shelter's lawyer approve
 * these exact words (lawyer question 3). A test refuses
 * `adoptionApplications.enabled: true` while it is.
 */
export interface AdoptionAcceptance {
  /** Shown verbatim beside the checkbox, with `ACCEPTANCE_PET_TOKEN` filled in. */
  readonly label: string;
  /** True until the owner and the lawyer approve `label`. */
  readonly isDraft: boolean;
}

/** Where the acceptance names the animal. */
export const ACCEPTANCE_PET_TOKEN = '{mascota}';

export const ADOPTION_ACCEPTANCE: AdoptionAcceptance = {
  label: 'Quiero adoptar a {mascota} bajo este compromiso, y sé que se firma en papel el día de la entrega.',
  isDraft: true,
};

/**
 * The shelter's lawyer on WHAT the online form collects (plan §8). One flag,
 * false until the lawyer has answered every question below in writing and the
 * answers are reflected in the form and in /privacy:
 *
 *   Q1  the two references and a renter's landlord: may a third person's name
 *       and phone be collected online, from the applicant, without their
 *       consent? Must they be told, by whom, and kept how long?
 *   Q4  the C.I. number and the carnet photo: may both be collected and kept,
 *       and for how long per outcome?
 *   Q5  minors: is refusing under-18s online correct ("mayor de edad")?
 *   Q6  ESTADO CIVIL: necessary online, or dropped (data minimisation)?
 *   Q7  storage in the United States (`us-east1`): is consent or notice required?
 *
 * The other lawyer questions are guarded elsewhere or are not about collection:
 * Q3 (the acceptance wording) is `ADOPTION_ACCEPTANCE.isDraft`. Q2 (the Ley
 * 700/2015 text shown before a signature) and Q8 (what the kept record holds)
 * have no flag of their own.
 *
 * ⚠️ A test refuses `adoptionApplications.enabled: true` while this is false.
 * If an answer is "no", the change is removing a field — free while no
 * application exists.
 */
export interface AdoptionLegalReview {
  readonly dataCollectionApproved: boolean;
}

export const ADOPTION_LEGAL_REVIEW: AdoptionLegalReview = {
  dataCollectionApproved: false,
};
