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
  /**
   * Clauses added AFTER the paper, for the online form (owner, 2026-10-17):
   * electronic consent, cloud storage of personal data, and the resolution of
   * the adoption on a deletion request. Verbatim, hashed after the closing.
   * Each block is one paragraph — a numbered purpose is its own block, with
   * its number as written.
   */
  additionalClauses: readonly ContractAdditionalClause[];
}

export interface ContractAdditionalClause {
  /** The title as written ("CLÁUSULA ADICIONAL: …"). Hashed. */
  title: string;
  /** Its paragraphs, in order, verbatim. Hashed, each its own block. */
  blocks: readonly string[];
}

/** Where the paper leaves a dotted blank for the applicant's name. */
export const CONTRACT_NAME_TOKEN = '{nombre}';
/** Where the paper leaves a dotted blank for the applicant's C.I. number. */
export const CONTRACT_CI_TOKEN = '{ci}';

/**
 * The shelter's REAL contract, verbatim. The paper part (heading, opening, the
 * nine commitments, closing) was confirmed by the owner word for word on
 * 2026-10-16, Bolivia time, and checked again against the photographs on
 * 2026-10-17. The three additional clauses are the owner's text of 2026-10-17,
 * verbatim — their legal citations are the owner's and the lawyer's, not
 * checked here. Version = 2026-10-17, the day the full text took effect.
 *
 * The previous version, '2026-10-16' (sha256 0874ed09…), was the paper part
 * alone. No application was ever made under it (the form was switched off),
 * so it is dropped from `acceptedContracts()` rather than kept.
 */
export const ADOPTION_CONTRACT: AdoptionContract | null = {
  version: '2026-10-17',
  sha256: '17a8c80435b956d9af4421749e0206ae012664deaa30fcfeff11c188f37cf850',
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
  additionalClauses: [
    {
      title: 'CLÁUSULA ADICIONAL: VALIDEZ DEL CONSENTIMIENTO ELECTRÓNICO',
      blocks: [
        'Conformidad electrónica: Al marcar la casilla de verificación (checkbox) y presionar el botón de confirmación en la plataforma web, el adoptante manifiesta su consentimiento expreso de manera libre, previa e informada, otorgando a este acuerdo plena validez jurídica y fuerza obligatoria entre partes, de conformidad con los Artículos 452, 453 y 454 del Código Civil Boliviano y el Artículo 78 y siguientes de la Ley N° 164 (Ley General de Telecomunicaciones y TIC).',
        'Las partes reconocen como prueba fehaciente de la celebración del acuerdo la pista de auditoría digital registrada en el sistema, la cual almacena la fecha y hora exacta (estampa de tiempo), la dirección IP de origen y los datos de autenticación del usuario.',
      ],
    },
    {
      title: 'CLÁUSULA ADICIONAL: TRATAMIENTO Y ALMACENAMIENTO DE DATOS PERSONALES EN LA NUBE',
      blocks: [
        'Autorización y almacenamiento seguro: En cumplimiento de los Artículos 21 (Derecho a la Privacidad) y 130 (Acción de Protección de Privacidad - Habeas Data) de la Constitución Política del Estado, el adoptante autoriza de forma expresa al albergue a recolectar, digitalizar y almacenar en una base de datos segura en la nube (Google Cloud Platform) la fotografía de su Cédula de Identidad, número de contacto y la ubicación fija georreferenciada de su domicilio.',
        'Finalidad y confidencialidad: Dichos datos se utilizarán de manera exclusiva y confidencial para:',
        '1. El registro y comprobación de identidad del custodio responsable.',
        '2. El seguimiento periódico del estado del animal de compañía.',
        '3. El ejercicio de acciones administrativas o penales ante POFOMA o el Ministerio Público en caso de presunto abandono o maltrato (Ley N° 700 y Art. 350 bis del Código Penal).',
        'Queda prohibida la divulgación, comercialización o transferencia de estos datos a terceros ajenos a la protección del animal.',
        'Plazo de retención y eliminación definitiva: La fotografía del documento de identidad y los datos de ubicación se conservarán únicamente durante la vida biológica del animal adoptado o mientras subsista la relación de custodia contractual. Una vez acreditado el fallecimiento por causas naturales del animal o formalizada su devolución al albergue, los archivos fotográficos de identidad serán eliminados y purgados definitivamente del sistema.',
      ],
    },
    {
      title: 'CLÁUSULA ADICIONAL: CONDICIÓN RESOLUTORIA POR SUPRESIÓN DE DATOS',
      blocks: [
        'Revocatoria y restitución: El adoptante reconoce que la conservación de sus datos de identidad y domicilio es la condición indispensable para mantener la custodia del animalito. En consecuencia, si el adoptante solicita la baja o eliminación de sus datos de la plataforma mientras el animal se encuentre con vida, dicha solicitud producirá la resolución automática e inmediata de la adopción, quedando obligado a restituir al animal al albergue en un plazo perentorio de veinticuatro (24) horas.',
      ],
    },
  ],
};

/**
 * The exact text the hash covers: the heading (if the paper prints one), the
 * opening TEMPLATE (tokens unfilled), each clause, and the closing — separated
 * by a blank line, then each additional clause's title and blocks the same
 * way. A contract without additional clauses hashes exactly as it did before
 * they existed. The rules hold ONE pair for every applicant, so the hash is
 * of the template; the filled-in name and C.I. are stored anyway (the name in
 * `answers`, the C.I. in `private/identity`). Changing this function changes
 * every hash, so it is pinned by a test.
 */
export function contractCanonicalText(
  contract: Pick<AdoptionContract, 'heading' | 'opening' | 'clauses' | 'closing'> &
    Partial<Pick<AdoptionContract, 'additionalClauses'>>,
): string {
  return [
    ...(contract.heading ? [contract.heading] : []),
    contract.opening,
    ...contract.clauses,
    contract.closing,
    ...(contract.additionalClauses ?? []).flatMap((clause) => [clause.title, ...clause.blocks]),
  ].join('\n\n');
}

/**
 * The words of the one checkbox an applicant ticks before sending. Since
 * 2026-10-17 they are the owner's own sentence, verbatim (the guillemets that
 * quoted it in the owner's message are not part of it). Under the first
 * additional clause, ticking this box and pressing «Enviar» IS the electronic
 * consent, so its audit trail is recorded: `termsAcceptedAt` on the
 * application, and `private/acceptance` (time, IP, account), written by the
 * acceptance route. The contract is ALSO signed in ink at handover (owner
 * decision, 2026-10-17), as a second record.
 *
 * `{mascota}`, the animal's name, may appear in a label; the owner's sentence
 * does not use it.
 *
 * ⚠️ `isDraft` guarded the approval of these words (lawyer question 3). False
 * since the owner supplied them on 2026-10-17. A test refuses
 * `adoptionApplications.enabled: true` while it is true.
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
  label:
    'He leído y acepto el Formulario de Adopción, sus Compromisos (Ley N° 700) y autorizo el tratamiento y almacenamiento seguro de mis datos personales, imágenes y ubicación de domicilio mientras mantenga la custodia del animalito.',
  isDraft: false,
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
 *
 * TRUE since 2026-10-17, on the OWNER's confirmation: Q1, Q5 and Q6 are kept
 * exactly as the lawyer-approved paper form already asks them; Q4 and Q7 are
 * answered by the additional clauses (the carnet photo and the address are
 * kept while the custody lasts; storage on Google Cloud Platform is authorised
 * expressly).
 */
export interface AdoptionLegalReview {
  readonly dataCollectionApproved: boolean;
}

export const ADOPTION_LEGAL_REVIEW: AdoptionLegalReview = {
  dataCollectionApproved: true,
};
