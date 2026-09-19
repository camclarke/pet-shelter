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

import type { Species } from '@/lib/types';

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
// Online adoption application — plan §6, build-order step 14
// ─────────────────────────────────────────────────────────────────────────────

/** The headings plan §6 names, in the order the form shows them. */
export type ApplicationSection =
  | 'contact'
  | 'housing'
  | 'household'
  | 'otherPets'
  | 'experience'
  | 'why';

/**
 * How a question is asked and stored.
 *
 * - `shortText` / `longText` / `phone` store a string
 * - `choice` stores the option's English `value`, never its Spanish label
 * - `yesNo` stores a boolean
 * - `count` stores a whole number from 0 to the question's `max`
 */
export type ApplicationQuestionKind =
  | 'shortText'
  | 'longText'
  | 'phone'
  | 'choice'
  | 'yesNo'
  | 'count';

export interface ApplicationQuestion {
  /**
   * The key the answer is stored under. English, stable, and MIRRORED in
   * `firestore.rules` (`applicationAnswerKeys()`), which is the enforcing copy:
   * the rules refuse any key not on that list. Change both together — a test
   * fails if they drift.
   */
  id: string;
  section: ApplicationSection;
  /** Spanish, neutral tuteo. Shelter content, so it lives here rather than in i18n. */
  label: string;
  hint?: string;
  kind: ApplicationQuestionKind;
  required: boolean;
  /** `choice` only. `value` is stored; `label` is shown. */
  options?: readonly { value: string; label: string }[];
  /** `count` only. At most 99, the bound the rules enforce. */
  max?: number;
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
   * ⚠️ FALSE until the shelter's REAL screening questions replace the draft
   * below. Wawitas asks its own questions over WhatsApp today and nobody has
   * written them down for us yet (plan §11 #3). Publishing invented questions
   * as though the shelter asked them would be a lie told to every applicant.
   */
  enabled: boolean;
  /**
   * True while `questions` is the placeholder set. A test refuses
   * `enabled: true` while this is still true, so flipping the switch without
   * replacing the questions fails CI rather than reaching wawitas.org.
   */
  questionsAreDraft: boolean;
  questions: readonly ApplicationQuestion[];
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
  siteUrl: 'https://wawitas.org',

  species: ['dog', 'cat'],

  bounds: {
    minLat: -17.75,
    maxLat: -17.15,
    minLng: -66.45,
    maxLng: -65.85,
  },

  adoptionApplications: {
    // ⚠️ OFF. Flip only after replacing the DRAFT questions below with the ones
    // Wawitas actually asks, setting `questionsAreDraft` to false, and changing
    // `applicationsEnabled()` in firestore.rules to match — then deploy the rules.
    enabled: false,
    questionsAreDraft: true,

    // ═══ DRAFT — NOT WAWITAS' QUESTIONS ═══════════════════════════════════════
    // A placeholder covering the headings in plan §6 (housing, household, other
    // pets, experience, why this animal), written 2026-09-12 without the
    // shelter. Replace every entry with the shelter's own list. If an `id`
    // changes, update `applicationAnswerKeys()` in firestore.rules and deploy
    // the rules — the rules reject any key they do not list.
    //
    // Two choices here are deliberate and worth keeping in the real set: the
    // form asks for a ZONE, never an address, because an application must not
    // become a list of where strangers live; and nothing asks for an ID number.
    questions: [
      {
        id: 'fullName',
        section: 'contact',
        label: 'Tu nombre completo',
        kind: 'shortText',
        required: true,
        purpose: 'applicantName',
      },
      {
        id: 'whatsapp',
        section: 'contact',
        label: 'Tu número de WhatsApp',
        hint: 'Es por donde el equipo te va a escribir.',
        kind: 'phone',
        required: true,
        purpose: 'applicantPhone',
      },
      {
        id: 'zone',
        section: 'contact',
        label: '¿En qué zona o barrio vives?',
        hint: 'Solo la zona. No necesitamos tu dirección.',
        kind: 'shortText',
        required: true,
      },
      {
        id: 'housingType',
        section: 'housing',
        label: '¿Dónde vives?',
        kind: 'choice',
        required: true,
        options: [
          { value: 'house', label: 'Casa' },
          { value: 'apartment', label: 'Departamento' },
          { value: 'room', label: 'Cuarto' },
          { value: 'other', label: 'Otro' },
        ],
      },
      {
        id: 'housingTenure',
        section: 'housing',
        label: 'La vivienda es…',
        kind: 'choice',
        required: true,
        options: [
          { value: 'owned', label: 'Propia' },
          { value: 'rented', label: 'Alquilada' },
          { value: 'anticretico', label: 'En anticrético' },
          { value: 'family', label: 'De mi familia' },
          { value: 'other', label: 'Otra situación' },
        ],
      },
      {
        id: 'landlordAllows',
        section: 'housing',
        label: 'Si la vivienda no es tuya, ¿el dueño permite animales?',
        kind: 'choice',
        required: false,
        options: [
          { value: 'yes', label: 'Sí' },
          { value: 'no', label: 'No' },
          { value: 'unsure', label: 'No lo sé' },
        ],
      },
      {
        id: 'outdoorSpace',
        section: 'housing',
        label: '¿Tiene patio o espacio al aire libre?',
        kind: 'choice',
        required: true,
        options: [
          { value: 'enclosed', label: 'Sí, cerrado' },
          { value: 'open', label: 'Sí, pero sin cerrar' },
          { value: 'none', label: 'No' },
        ],
      },
      {
        id: 'adults',
        section: 'household',
        label: '¿Cuántas personas adultas viven en la casa?',
        kind: 'count',
        required: true,
        max: 30,
      },
      {
        id: 'children',
        section: 'household',
        label: '¿Cuántos niños o niñas?',
        hint: 'Pon 0 si no hay.',
        kind: 'count',
        required: true,
        max: 30,
      },
      {
        id: 'everyoneAgrees',
        section: 'household',
        label: '¿Todos en la casa están de acuerdo con adoptar?',
        kind: 'yesNo',
        required: true,
      },
      {
        id: 'otherPets',
        section: 'otherPets',
        label: '¿Tienes otros animales?',
        hint: 'Cuéntanos cuáles, qué edad tienen y si están esterilizados. Déjalo vacío si no tienes.',
        kind: 'longText',
        required: false,
      },
      {
        id: 'previousPets',
        section: 'experience',
        label: '¿Tuviste perros o gatos antes? ¿Qué pasó con ellos?',
        kind: 'longText',
        required: true,
      },
      {
        id: 'hoursAlone',
        section: 'experience',
        label: '¿Cuántas horas al día pasaría solo?',
        kind: 'count',
        required: true,
        max: 24,
      },
      {
        id: 'whyThisAnimal',
        section: 'why',
        label: '¿Por qué quieres adoptar a este animalito?',
        kind: 'longText',
        required: true,
      },
    ],
  },

  // The owner is providing these (plan §11 #6). Deliberately null until then.
  kitchen: {
    potCapacityLitres: null,
    ladleVolumeMl: null,
  },
};
