/**
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ONE FILE YOU EDIT TO MAKE THIS YOUR SHELTER.
 *
 * Everything organisation-specific lives here so that adopting this template
 * is a config change rather than a search-and-replace through the codebase.
 * The values below are the reference deployment (Wawitas Red de Apoyo,
 * Cochabamba, Bolivia); replace them with your own.
 *
 * Design tokens — colours, fonts — live in src/app/globals.css, and the drawn
 * artwork in src/components/Brand.tsx (the mark) and Wordmark.tsx (the name as
 * lettering). Those are the other three files worth changing; everything else
 * reads from here.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { IdDocumentSide, Species } from '@/lib/types';

export interface ShelterConfig {
  name: string;
  shortName: string;
  tagline: string;

  /**
   * Whether this shelter has a DRAWN logotype — its own name as artwork rather
   * than as type. True renders src/components/Wordmark.tsx in place of the
   * first word of `name`; the rest of `name` still sets below it as text.
   *
   * Leave it false unless you have replaced that file with your own lettering.
   * True with the reference artwork still in place would put "Wawitas" in your
   * header no matter what `name` says.
   */
  hasWordmark: boolean;
  mission: string;

  /** Full international format, digits only, no + or spaces. Used to build wa.me links. */
  whatsapp: string;
  /** As a human should read it. */
  whatsappDisplay: string;

  instagram: string | null;
  facebook: string | null;
  email: string | null;

  city: string;
  country: string;
  /** BCP 47, used for <html lang> and Intl formatting. */
  locale: string;
  /**
   * IANA time zone the shelter lives in. Every event time is ENTERED, STORED
   * and SHOWN as this zone's wall clock — never the device's, so an admin
   * whose phone is set to Madrid still publishes Cochabamba's 15:00. An
   * invalid name makes `Intl` throw a RangeError, and a test checks it.
   */
  timeZone: string;
  /** Production origin, for canonical URLs and Open Graph. */
  siteUrl: string;

  /**
   * Which species this shelter actually takes in. Drives the filters shown on
   * the wall — a dog-only rescue should not display an empty "conejos" tab.
   */
  species: Species[];

  /**
   * Geographic bounds used to sanity-check sighting reports and scan
   * locations. Keep these tight around your service area: they are what stops
   * the public sighting endpoint from accepting coordinates on another
   * continent. Mirrored in firestore.rules, which is the enforcing copy —
   * update both together.
   */
  bounds: {
    minLat: number;
    maxLat: number;
    minLng: number;
    maxLng: number;
  };

  /**
   * The map an adoption applicant may mark their home on (portion 4d). Loaded
   * only when the person taps to open it, so nobody who skips it ever contacts
   * the tile server. A forking shelter changes the centre; the tiles and
   * attribution are OpenStreetMap's, under its tile usage policy
   * (https://operations.osmfoundation.org/policies/tiles/), which requires the
   * attribution to stay visible.
   */
  map: {
    tileUrl: string;
    attribution: string;
    center: { latitude: number; longitude: number };
    zoom: number;
    /** The furthest out a person may zoom: the service area, not the continent. */
    minZoom: number;
    maxZoom: number;
  };

  /**
   * The optional online adoption application. See `ApplicationConfig`.
   * WhatsApp stays the primary way to adopt whatever this says.
   */
  adoptionApplications: ApplicationConfig;

  /**
   * The cooking pot and the serving ladle, MEASURED at your shelter.
   *
   * ⚠️ `null` until someone measures them, and null is a real value, not a
   * placeholder to fill with a typical pot. While either is null the app shows
   * NO yield or ladle estimate anywhere and says why (plan §12.2). A shelter
   * forking this template must not inherit another shelter's pot silently —
   * a wrong capacity produces a confident count of ladles for dogs that go
   * unfed.
   *
   * To measure: fill the pot with water one known jug at a time for
   * `potCapacityLitres`; fill the ladle level with water into a measuring jug
   * for `ladleVolumeMl`.
   */
  kitchen: {
    potCapacityLitres: number | null;
    ladleVolumeMl: number | null;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Online adoption application — plan §6, build-order step 14, portion 4c
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The paper form's own sections, in its order (portion 4c-1). Their LABELS are
 * shelter content, so they live in `ApplicationConfig.sections`, not in i18n.
 * The paper's fourth section, DATOS DEL PELUDITO ADOPTADO, is not here: the
 * shelter fills it in at handover and the applicant is never asked it (D16).
 */
export type ApplicationSection = 'personal' | 'references' | 'home';

/**
 * How a question is asked and stored.
 *
 * - `shortText` / `longText` / `phone` store a string
 * - `idNumber` stores an identity-card number as typed (tidied), never split
 *   or upper-cased — a Bolivian C.I. can carry a complement and letters
 * - `choice` stores the option's English `value`, never its Spanish label
 * - `yesNo` stores a boolean
 * - `count` stores a whole number from the question's `min` (default 0) to its `max`
 */
export type ApplicationQuestionKind =
  | 'shortText'
  | 'longText'
  | 'phone'
  | 'idNumber'
  | 'choice'
  | 'yesNo'
  | 'count';

/**
 * Which document an answer is written to.
 *
 * - `'application'` → `answers` on the main application document. The
 *   applicant and admins read it, EVERY admin queue load downloads it, and
 *   nothing may ever erase it (`allow delete: if false`, `answers` frozen).
 *   Only what the shelter needs to recognise and call the person, plus the
 *   housing answers.
 * - `'identity'` → `private/identity`, an admin-only document created in the
 *   same batch and erased by the retention sweep with the carnet photo and the
 *   address. Identity numbers, personal details, and ALL third-party data (the
 *   references' and the landlord's names and phones), which belong to people
 *   who never agreed to anything.
 */
export type ApplicationAnswerStore = 'application' | 'identity';

export interface ApplicationQuestion {
  /**
   * The key the answer is stored under. English, stable, and MIRRORED in
   * `firestore.rules` — `applicationAnswerKeys()` for `store: 'application'`,
   * `identityAnswerKeys()` for `store: 'identity'` — which is the enforcing
   * copy: the rules refuse any key not on the list. Change both together — a
   * test fails if they drift.
   */
  id: string;
  section: ApplicationSection;
  /** Required, no default: where an answer lands decides who reads it and whether it can be erased. */
  store: ApplicationAnswerStore;
  /**
   * Spanish. For the paper's own fields, VERBATIM from the shelter's form —
   * its capitals, its usted and its missing accents ("¿QUE TIPO…") included
   * (owner decision D6). Shelter content, so it lives here rather than in i18n.
   */
  label: string;
  /** Ours, in neutral tuteo, shown under the verbatim label. Never an edit to the shelter's words. */
  hint?: string;
  /**
   * A sentence the PAPER prints above this question, verbatim — the landlord's
   * "Si es arrendatario, coloque…". Shown once, before the question.
   */
  intro?: string;
  kind: ApplicationQuestionKind;
  required: boolean;
  /** `choice` only. `value` is stored; `label` is shown. */
  options?: readonly { value: string; label: string }[];
  /** `count` only. The smallest accepted number; 0 when absent. */
  min?: number;
  /** `count` only. At most 99, the bound the rules enforce. */
  max?: number;
  /**
   * Asked only when an EARLIER question's answer is one of `values` — the
   * landlord only for a rented home, "amurallado" only for a house or a farm.
   * A question not asked is never required and its answer is never stored,
   * even if it was typed before the controlling answer changed.
   */
  askedWhen?: { questionId: string; values: readonly (string | boolean)[] };
  /**
   * Marks the question whose answer names the applicant, or gives the number
   * to reach them on. The admin queue shows these first, and the name becomes
   * the holder on the custody record when an adoption is approved.
   */
  purpose?: 'applicantName' | 'applicantPhone';
}

export interface ApplicationConfig {
  /**
   * Whether the public ever sees the form: the "Postular en línea" link on a
   * dossier and the `/adopt/{slug}/apply` page. The admin queue works either
   * way.
   *
   * ⚠️ MIRRORED in `firestore.rules` as `applicationsEnabled()`, which is the
   * enforcing copy: this flag only hides the page, while the rule is what stops
   * an application being written straight through the SDK. Change both, then
   * deploy the rules — a test fails if they disagree.
   *
   * ⚠️ FALSE. The questions are now the shelter's own paper form (portion
   * 4c-1), but switching on still waits on things tests enforce: the
   * acceptance wording approved by the owner and the lawyer
   * (`ADOPTION_ACCEPTANCE.isDraft`), the retention sweep (4e), and the
   * /privacy rewrite (4f). Each has a guard that fails the moment this is
   * true without it.
   */
  enabled: boolean;
  /**
   * True while `questions` is a placeholder set nobody at the shelter wrote. A
   * test refuses `enabled: true` while this is still true. False since 4c-1:
   * the questions are the fields of Wawitas' paper adoption form.
   */
  questionsAreDraft: boolean;
  /** The paper's sections, in its order, with their printed labels (verbatim). */
  sections: readonly { id: ApplicationSection; label: string }[];
  /** The paper's introductory paragraph, verbatim. Shown above the personal data. */
  formIntro: string;
  /**
   * The paper's labels for the two fields that live in `private/home`, not in
   * `questions` (a test forbids a QUESTION that asks for an address). Verbatim.
   */
  homeLabels: { address: string; details: string; map: string };
  /**
   * The paper's fourth section, DATOS DEL PELUDITO ADOPTADO, verbatim — its
   * heading, its field labels and its printed choices (portion 4c-2). The
   * review step shows these filled from the PUBLIC pet document, read-only:
   * the applicant is never asked them and nothing here is stored (D16).
   * Sterilisation, vaccines and RESPONSABLE stay on the paper the team fills
   * in at handover. The paper's section number is dropped (D7).
   */
  petSection: {
    title: string;
    name: string;
    age: string;
    breed: string;
    color: string;
    species: string;
    sex: string;
    /** The paper prints CANINO / FELINO only; another species shows no ESPECIE row. */
    speciesValues: { dog: string; cat: string };
    sexValues: { female: string; male: string };
  };
  questions: readonly ApplicationQuestion[];
  /**
   * Which sides of the applicant's identity card are photographed. Every side
   * listed must have arrived before an application can be approved.
   *
   * ⚠️ MIRRORED in `firestore.rules` as `idDocumentReceived()`, which is the
   * enforcing copy for the approval. Change both, then deploy the rules — a
   * test fails if the sides differ.
   */
  idDocumentSides: readonly IdDocumentSide[];
}

export const SHELTER: ShelterConfig = {
  name: 'Wawitas Red de Apoyo',
  shortName: 'Wawitas',
  tagline: 'De la calle, a tu corazón.',
  hasWordmark: true,
  mission:
    'Rescatamos animalitos abandonados y maltratados, los rehabilitamos física y emocionalmente, y les buscamos una familia para toda la vida en adopción responsable.',

  whatsapp: '59177903553',
  whatsappDisplay: '77903553',

  instagram: 'https://www.instagram.com/wawitas_2025/',
  facebook: 'https://www.facebook.com/profile.php?id=61563998952145',
  email: null,

  city: 'Cochabamba',
  country: 'Bolivia',
  locale: 'es-BO',
  // Bolivia: UTC−4 all year, no daylight saving. The conversion code still
  // reads the offset from Intl rather than assuming −4, so a fork in a zone
  // with DST gets it right.
  timeZone: 'America/La_Paz',
  siteUrl: 'https://wawitas.org',

  species: ['dog', 'cat'],

  bounds: {
    minLat: -17.75,
    maxLat: -17.15,
    minLng: -66.45,
    maxLng: -65.85,
  },

  map: {
    tileUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    // Plaza 14 de Septiembre, the centre of Cochabamba.
    center: { latitude: -17.3935, longitude: -66.157 },
    zoom: 13,
    minZoom: 11,
    maxZoom: 19,
  },

  adoptionApplications: {
    // ⚠️ OFF. See `enabled` above: the switch-on guards in
    // application-identity.test.ts fail the moment this is true before the
    // acceptance wording is approved, the sweep exists and /privacy is
    // rewritten. Flipping it also means changing `applicationsEnabled()` in
    // firestore.rules to match, then deploying the rules.
    enabled: false,
    questionsAreDraft: false,

    // ═══ WAWITAS' PAPER ADOPTION FORM (portion 4c-1) ═══════════════════════
    // Every LABEL below is printed on the shelter's paper form, VERBATIM —
    // capitals, usted and missing accents ("¿QUE TIPO DE INMUEBLE POSEE?")
    // included — from the transcription the owner confirmed word for word on
    // 2026-10-16 (corrected against the photograph on 2026-10-17: the landline
    // label is just "CASA"). The one label that is not printed: the tenure row has no
    // question text on paper, only "PROPIO · ARRENDADO" (owner decision D5).
    // Every HINT is ours, in neutral tuteo, shown under the shelter's label
    // (D6). If an `id` changes, update applicationAnswerKeys() or
    // identityAnswerKeys() in firestore.rules and deploy the rules.
    //
    // ⚠️ A RECORDED DECISION, REVERSED in portion 4a (owner, 2026-10-16), and
    // narrowed in 4c-1. The form once asked for a ZONE, never an address, and
    // nothing asked for an ID. Now:
    //   - the address is not a question: it goes only into `private/home`
    //     (labels in `homeLabels` below), and the carnet photo only through its
    //     upload route into Storage;
    //   - the C.I. number, the age, the civil status, the landline, both
    //     references and the landlord ARE questions, but with
    //     `store: 'identity'` — written only to the admin-only, erasable
    //     `private/identity`, never into `answers`.
    // So the old rule holds for every `store: 'application'` question: none may
    // ask for an address, an identity document or a third person (a test reads
    // every label).
    //
    // Not asked at all: the paper's "Formulario No" and "FECHA" (the document
    // id and `submittedAt` play that role), CROQUIS UBICACIÓN (the map pin is
    // portion 4d; never a dead field until then), and the whole of section 4,
    // DATOS DEL PELUDITO ADOPTADO, which the shelter fills in at handover (D16).
    sections: [
      { id: 'personal', label: 'DATOS PERSONALES' },
      { id: 'references', label: 'REFERENCIAS' },
      { id: 'home', label: 'DOMICILIO' },
    ],
    formIntro:
      'Se recomienda a las personas interesadas en adoptar, la importancia de diligenciar este documento para realizar la adopción. Los peludos colocados en adopción son animales abandonados, callejeros, no son regalados y tampoco comprados, los requisitos aqui contenidos deben observarse de manera responsable, de acuerdo con lo dispuesto en la ley 700/2015. Esperamos ubicar a cada peludito en un hogar y a cargo de un adoptante responsable.',
    homeLabels: {
      address: 'DIRECCIÓN EXACTA DONDE ESTARÁ EL PELUDITO',
      details: 'NÚMERO DE CASA Y DETALLES',
      // The paper's CROQUIS UBICACIÓN box: online, an optional pin on a map.
      map: 'CROQUIS UBICACIÓN',
    },
    // Section 4 of the paper, verbatim ("GENERO" without its accent, as
    // printed). Shown read-only on the review step, filled from the public
    // pet document; never asked, never stored (D16).
    petSection: {
      title: 'DATOS DEL PELUDITO ADOPTADO',
      name: 'NOMBRE',
      age: 'EDAD',
      breed: 'RAZA',
      color: 'COLOR',
      species: 'ESPECIE',
      sex: 'GENERO',
      speciesValues: { dog: 'CANINO', cat: 'FELINO' },
      sexValues: { female: 'HEMBRA', male: 'MACHO' },
    },
    questions: [
      // ── 1. DATOS PERSONALES ─────────────────────────────────────────────
      {
        id: 'fullName',
        section: 'personal',
        store: 'application',
        label: 'NOMBRE COMPLETO',
        kind: 'shortText',
        required: true,
        purpose: 'applicantName',
      },
      {
        id: 'ciNumber',
        section: 'personal',
        store: 'identity',
        label: 'C.I.',
        hint: 'Tu número de carnet, con su complemento si tiene.',
        kind: 'idNumber',
        required: true,
      },
      {
        // The contract opens "Yo … mayor de edad": the form and the rules
        // both refuse an age under 18 (owner decision D4).
        id: 'age',
        section: 'personal',
        store: 'identity',
        label: 'EDAD',
        kind: 'count',
        required: true,
        min: 18,
        max: 99,
      },
      {
        // Free text: the paper prints no options, so none are invented.
        id: 'civilStatus',
        section: 'personal',
        store: 'identity',
        label: 'ESTADO CIVIL',
        kind: 'shortText',
        required: true,
      },
      {
        // The key stays `whatsapp`: /privacy says the application keeps "tu
        // WhatsApp", and privacy-page.test.ts pins this key.
        id: 'whatsapp',
        section: 'personal',
        store: 'application',
        label: 'CELULAR',
        hint: 'El equipo te escribe por WhatsApp a este número.',
        kind: 'phone',
        required: true,
        purpose: 'applicantPhone',
      },
      {
        id: 'landline',
        section: 'personal',
        store: 'identity',
        // Printed as just "CASA", beside a ☎ icon; what it asks for is in our hint.
        label: 'CASA',
        hint: 'Teléfono fijo. Déjalo vacío si no tienes.',
        kind: 'phone',
        required: false,
      },

      // ── 2. REFERENCIAS — third parties, so identity only ─────────────────
      {
        id: 'personalRefName',
        section: 'references',
        store: 'identity',
        label: 'REFERENCIA PERSONAL',
        hint: 'Avísale que el refugio podría llamarla.',
        kind: 'shortText',
        required: true,
      },
      {
        id: 'personalRefPhone',
        section: 'references',
        store: 'identity',
        label: 'TELÉFONO',
        kind: 'phone',
        required: true,
      },
      {
        id: 'personalRefRelation',
        section: 'references',
        store: 'identity',
        label: 'RELACIÓN',
        kind: 'shortText',
        required: true,
      },
      {
        id: 'familyRefName',
        section: 'references',
        store: 'identity',
        label: 'REFERENCIA FAMILIAR',
        kind: 'shortText',
        required: true,
      },
      {
        id: 'familyRefPhone',
        section: 'references',
        store: 'identity',
        label: 'TELÉFONO',
        kind: 'phone',
        required: true,
      },
      {
        id: 'familyRefRelation',
        section: 'references',
        store: 'identity',
        label: 'RELACIÓN',
        kind: 'shortText',
        required: true,
      },

      // ── 3. DOMICILIO ────────────────────────────────────────────────────
      {
        // Values changed from the draft (0 documents existed). The draft's
        // "cuarto" and "otro" are gone, as on paper.
        id: 'housingType',
        section: 'home',
        store: 'application',
        label: '¿QUE TIPO DE INMUEBLE POSEE?',
        kind: 'choice',
        required: true,
        options: [
          { value: 'house', label: 'CASA' },
          { value: 'apartment', label: 'DEPARTAMENTO' },
          { value: 'farm', label: 'FINCA' },
        ],
      },
      {
        // ⚠️ The ONE label not printed on paper: the row is only "PROPIO ·
        // ARRENDADO" (owner decision D5). "Anticrético" and "de mi familia"
        // are gone, as on paper.
        id: 'housingTenure',
        section: 'home',
        store: 'application',
        label: '¿EL INMUEBLE ES PROPIO O ARRENDADO?',
        kind: 'choice',
        required: true,
        options: [
          { value: 'owned', label: 'PROPIO' },
          { value: 'rented', label: 'ARRENDADO' },
        ],
      },
      {
        id: 'landlordName',
        section: 'home',
        store: 'identity',
        intro: 'Si es arrendatario, coloque nombre y teléfono del dueño de casa:',
        label: 'Nombre de dueño del inmueble',
        kind: 'shortText',
        required: true,
        askedWhen: { questionId: 'housingTenure', values: ['rented'] },
      },
      {
        id: 'landlordPhone',
        section: 'home',
        store: 'identity',
        label: 'Teléfono',
        kind: 'phone',
        required: true,
        askedWhen: { questionId: 'housingTenure', values: ['rented'] },
      },
      {
        id: 'movingSoon',
        section: 'home',
        store: 'application',
        label: '¿Planea mudarse pronto?',
        kind: 'yesNo',
        required: true,
      },
      {
        id: 'walled',
        section: 'home',
        store: 'application',
        label: 'Si es finca o casa, ¿se encuentra amurallado?',
        kind: 'yesNo',
        required: true,
        askedWhen: { questionId: 'housingType', values: ['house', 'farm'] },
      },
    ],

    // Owner decision, 2026-10-16: the front only, required before approval.
    idDocumentSides: ['front'],
  },

  // The owner is providing these (plan §11 #6). Deliberately null until then.
  kitchen: {
    potCapacityLitres: null,
    ladleVolumeMl: null,
  },
};
