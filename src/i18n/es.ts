/**
 * Spanish (es) — the reference locale, and the language of the site today.
 *
 * Every identifier in this file is English. Every value is Spanish. That is
 * the rule for the whole `src/i18n` directory, and it is what lets a forking
 * shelter translate the site without reading a line of logic.
 */

import type { Messages } from './messages';
import type { MedicalError, MedicalWarning } from '@/lib/medical';
import type { MeasurementError, MeasurementWarning } from '@/lib/measurements';
import type { MedicalReviewCopy } from './messages';
import type { FieldEvidence, MedicalExtractionSource, WithheldReason } from '@/lib/types';
import type { CardField } from '@/lib/card-extraction';
import type { CardExtractFailure } from '@/lib/card-extract-client';
import type {
  AreaKind,
  MedicalRecordKind,
  MuscleCondition,
  PetSex,
  PetSize,
  PetStatus,
  PlacementReason,
  Species,
} from '@/lib/types';
import type { AreaError, PlacementWarning } from '@/lib/areas';
import { MS_PER_DAY, type Pathogen } from '@/lib/placements';
import type { MicrochipError } from '@/lib/microchip';
import type { AuthError } from '@/lib/auth';
import type { IntakeError } from '@/lib/intake';

/**
 * How much breed copy an adoption-wall card can carry. MEASURED, not guessed.
 *
 * Taken at 360px — the width a real device reported, not the 375 an earlier
 * check used — against this project's own `.t-data` rule (10.5px Instrument
 * Sans, 0.13em letter-spacing, uppercased by CSS) inside `.poster__footer`:
 *
 *     available line width               280.00 px
 *     line-height                         15.22 px
 *     characters per line                    36
 *     "mestiza con rasgos de husky siberiano y alaskan malamute"
 *       — the real ground truth, 56 ch     2 lines
 *     longest string still fitting 2 lines   66 ch
 *     cost of a 2-line breed on a 499px card  +40.4 px
 *
 * Two lines rather than one, deliberately. One line is 36 characters, which
 * cuts "mestiza con rasgos de husky siberiano y alaskan malamute" after the
 * first breed — and the second resemblance is half of why this line exists at
 * all. Two lines carry the realistic worst case (three breeds, the cap in
 * `resemblesBreeds`) whole.
 *
 * A longer string than this degrades to a third line rather than breaking the
 * card: the grid rows are auto-height. That is the reason there is no CSS
 * clamp as well — one deterministic, testable mechanism beats two, and the
 * second one would be invisible.
 *
 * ⚠️ Re-measure if `.t-data`, `.poster__footer` padding, or the `.wall` grid's
 * 236px minimum change. The number is a property of that typography, not of
 * Spanish.
 */
const BREED_LINE_MAX_CHARS = 66;

/**
 * Size adjectives, as stems. "grande" is invariant — it already ends in -e and
 * takes no gendered form — so it is handled separately rather than stemmed.
 */
const SIZE_STEMS: Record<PetSize, string> = {
  small: 'pequeñ',
  medium: 'median',
  large: 'grande',
};

const SPECIES_NOUN: Record<Species, Record<PetSex, string>> = {
  dog: { male: 'perro', female: 'perra' },
  cat: { male: 'gato', female: 'gata' },
  rabbit: { male: 'conejo', female: 'coneja' },
  other: { male: 'animalito', female: 'animalita' },
};

const SPECIES_PLURAL: Record<Species, string> = {
  dog: 'perritos',
  cat: 'gatitos',
  rabbit: 'conejitos',
  other: 'animalitos',
};

const SEX: Record<PetSex, string> = {
  male: 'macho',
  female: 'hembra',
};

/**
 * The shelter's own vocabulary, preserved. `shelter` is "refugio" and `foster`
 * is "hogar de tránsito" — the words the staff actually say. Storing English
 * and displaying Spanish is precisely what this module is for.
 */
const STATUS: Record<PetStatus, string> = {
  inbound: 'En camino',
  quarantine: 'En cuarentena',
  shelter: 'En el refugio',
  foster: 'En hogar de tránsito',
  available: 'Disponible',
  adopted: 'Adoptado',
  lost: 'Perdido',
  cancelled: 'Cancelado',
};

const MEDICAL_KIND: Record<MedicalRecordKind, string> = {
  vaccination: 'Vacuna',
  deworming: 'Desparasitación',
  surgery: 'Cirugía',
  consultation: 'Consulta',
  treatment: 'Tratamiento',
  sterilization: 'Esterilización',
  serology: 'Serología',
};

const MEDICAL_ERROR: Record<MedicalError, string> = {
  'kind-required': 'Elige qué tipo de registro es.',
  'name-required': 'Escribe qué se aplicó o qué se hizo. Por ejemplo «Rabia» o «Quíntuple».',
  'performed-required': 'Falta la fecha en que se hizo.',
  'performed-in-future': 'Esa fecha todavía no llegó. Revisa el día.',
  'due-before-performed': 'La próxima dosis no puede ser antes de la que se aplicó.',
  'valid-until-before-valid-from':
    'La protección no puede terminar antes de empezar. Revisa las dos fechas.',
};

const MEDICAL_WARNING: Record<MedicalWarning, string> = {
  'rabies-before-microchip':
    'La antirrábica figura ANTES de la colocación del microchip. Para viajar a la Unión Europea eso anula la vacuna: haría falta repetirla después del chip. Igual puedes guardar el registro tal como pasó.',
  'rabies-under-age':
    'El animalito habría tenido menos de 12 semanas al momento de la antirrábica. Es el mínimo que exige la norma europea. Guárdalo igual si así fue.',
  'rabies-no-valid-from':
    'Falta desde cuándo protege. En la antirrábica la protección empieza 21 días después de la dosis, y esa es la fecha que vale en un cruce de frontera.',
  'vaccination-no-next-due':
    'No pusiste cuándo toca la próxima. Sin eso no va a aparecer en los recordatorios.',
};

const MEASUREMENT_ERROR: Record<MeasurementError, string> = {
  'nothing-measured': 'Anota al menos uno: el peso, la condición corporal o la masa muscular.',
  'measured-required': 'Falta la fecha de la medición.',
  'measured-in-future': 'Esa fecha todavía no llegó. Revisa el día.',
  'weight-invalid': 'El peso tiene que ser un número, por ejemplo 12,5.',
  'weight-too-precise':
    'Usa como máximo dos decimales, por ejemplo 12,5. Con tres no se sabe si «12.500» son doce kilos y medio o doce mil quinientos.',
  'weight-not-positive': 'El peso tiene que ser mayor que cero.',
  'weight-too-heavy': 'Ese peso no es posible para un animalito. Revisa si falta la coma.',
  'bcs-out-of-range': 'La condición corporal va del 1 al 9, en números enteros.',
};

/**
 * WSAVA's bands, as NOUNS on purpose. "Delgado"/"delgada" would have to agree
 * with the animal's sex, which this label does not receive; "bajo peso" does
 * not inflect.
 */
const BODY_CONDITION_BAND = [
  'Emaciación',
  'Muy bajo peso',
  'Bajo peso',
  'Ideal',
  'Ideal',
  'Sobrepeso',
  'Sobrepeso',
  'Obesidad',
  'Obesidad severa',
] as const;

const MUSCLE_CONDITION: Record<MuscleCondition, string> = {
  normal: 'Masa muscular normal',
  mild: 'Pérdida muscular leve',
  moderate: 'Pérdida muscular moderada',
  marked: 'Pérdida muscular marcada',
};

/**
 * Generic masculine plural, the one form that needs no sex to agree with — and
 * deliberately NOT the diminutive `SPECIES_PLURAL` above. "Poco común en
 * perritos" is the wall's warmth misplaced in a note about a dosing weight.
 */
const SPECIES_PLURAL_PLAIN: Record<Species, string> = {
  dog: 'perros',
  cat: 'gatos',
  rabbit: 'conejos',
  other: 'animales',
};

/**
 * A weight in Bolivian notation: decimal comma, at most two decimals, and NO
 * grouping. ⚠️ No grouping on purpose — in es-BO "1.250" means twelve hundred
 * and fifty, and `parseWeightInput` refuses three decimals rather than guess,
 * so a grouped value would not survive being edited.
 */
function kgNumber(kg: number): string {
  return kg.toLocaleString('es-BO', { maximumFractionDigits: 2, useGrouping: false });
}

const MICROCHIP_ERROR: Record<MicrochipError, string> = {
  empty: 'Ingresa el número del microchip.',
  'non-numeric': 'El número del microchip solo puede contener dígitos.',
  'wrong-length':
    'Un microchip ISO tiene exactamente 15 dígitos. Si tiene 9 o 10, es un chip no-ISO: cámbialo en el tipo de estándar.',
  'test-transponder':
    'Los códigos que empiezan con 999 son transponders de prueba y no identifican a un animal real.',
  'national-id-overflow': 'Ese número no corresponde a un código ISO 11784 válido.',
};

/**
 * Intake wizard validation, in the words the shelter's volunteers use.
 *
 * Phrased as instructions rather than accusations — "Escribe el nombre", not
 * "Falta el nombre". These appear while someone is typing with a rescue in the
 * car, and a form that scolds gets abandoned for the WhatsApp group this
 * system exists to replace.
 */
const INTAKE_ERROR: Record<IntakeError, string> = {
  'name-required': 'Escribe el nombre del animalito.',
  'species-required': 'Elige si es perro, gato, conejo u otro.',
  'sex-required': 'Elige macho o hembra. De esto depende cómo se le nombra en toda la página.',
  'size-required': 'Elige el tamaño.',
  'breed-required': 'Escribe la raza. "Mestizo" o "mestiza" es una respuesta válida.',
  'age-required': 'Escribe la edad aproximada, o marca "no sabemos".',
  'age-range': 'Esa edad no parece posible. Revisa los años y los meses.',
  'slug-invalid':
    'La dirección web no es válida. Usa solo minúsculas, números y guiones — por ejemplo "luna-2".',
  'microchip-required': 'Marcaste que tiene microchip: escribe el número, o desmarca la casilla.',
  'microchip-conflict':
    'Ese microchip ya está registrado a otro animalito, y marcaste que este no es el mismo. Vuelve a escanear el chip por si se coló un dígito, o desmarca "tiene microchip" para continuar sin él. No podemos guardar el mismo número en dos fichas.',
  'photo-required': 'Sube al menos una foto. Sin foto, nadie se enamora.',
  'alt-required':
    'Cada foto necesita una descripción corta, para quien no puede verla. Por ejemplo: "Perra mestiza café echada en el patio".',
};

/**
 * ⚠️ Read the `authError` note in messages.ts before touching
 * `invalid-credentials`. Naming the password or the account would undo
 * Identity Platform's email enumeration protection.
 */
const AUTH_ERROR: Record<AuthError, string> = {
  'invalid-email': 'Ese correo no parece válido. Revísalo e intenta de nuevo.',
  'missing-password': 'Escribe tu contraseña.',
  'invalid-credentials': 'El correo o la contraseña no coinciden. Intenta de nuevo.',
  'email-in-use': 'Ya existe una cuenta con ese correo. Inicia sesión o recupera tu contraseña.',
  'weak-password': 'La contraseña es muy corta. Usa al menos 6 caracteres.',
  'user-disabled': 'Esta cuenta está desactivada. Escríbenos por WhatsApp y lo revisamos.',
  'too-many-requests':
    'Demasiados intentos seguidos. Espera unos minutos antes de volver a probar.',
  network: 'No pudimos conectarnos. Revisa tu internet e intenta de nuevo.',
  'provider-disabled': 'El inicio de sesión con correo no está habilitado en este momento.',
  unknown: 'Algo salió mal. Intenta de nuevo en un momento.',
};


/**
 * The five kinds of area, in the shelter's own vocabulary.
 *
 * ⚠️ `quarantine` and `isolation` are NOT synonyms and must never be worded
 * as though they were. Quarantine holds healthy, newly arrived animals under
 * observation; isolation holds sick or suspected ones. The ASV Guidelines for
 * Standards of Care in Animal Shelters keep them separate because putting a
 * sick animal into a quarantine pen exposes every healthy animal in it — and
 * the only reason the software can warn about that is that the two are
 * distinct here and in `AreaKind`.
 */
const AREA_KIND: Record<AreaKind, string> = {
  quarantine: 'Cuarentena',
  isolation: 'Aislamiento',
  general: 'Población general',
  medical: 'Área médica',
  maternity: 'Maternidad',
};

const AREA_KIND_HINT: Record<AreaKind, string> = {
  quarantine: 'Animalitos sanos recién llegados, en observación.',
  isolation: 'Animalitos enfermos o sospechosos. Nunca junto a los sanos.',
  general: 'El resto del refugio, ya con el alta del veterinario.',
  medical: 'En tratamiento o recuperándose de una cirugía.',
  maternity: 'Preñadas o con cría.',
};

const AREA_ERROR: Record<AreaError, string> = {
  'name-required': 'Ponle el nombre que ustedes usan, como "Cuarentena 2" o "Patio A".',
  'name-too-long': 'El nombre es muy largo. Usa máximo 60 caracteres.',
  'name-duplicate':
    'Ya existe un área con ese nombre. Si de verdad son dos áreas distintas, dales nombres distintos: si quedan dos fichas para el mismo corral, los animalitos se reparten entre las dos y ninguna muestra cuántos hay en realidad.',
  'kind-required':
    'Elige qué tipo de área es. De esto depende que el sistema avise cuando un animalito enfermo está por entrar donde hay sanos.',
  'capacity-invalid':
    'La capacidad tiene que ser un número entero mayor a cero. Si todavía no la han contado, déjala vacía.',
};

const PLACEMENT_REASON: Record<PlacementReason, string> = {
  intake: 'Ingreso',
  'quarantine-cleared': 'Alta veterinaria',
  transfer: 'Traslado',
  medical: 'Por tratamiento',
  outbreak: 'Por brote',
  exit: 'Salida',
};

/**
 * ⚠️ Every one of these informs a decision; none of them blocks one. Plan
 * section 3 is explicit that a gate stricter than the shelter's reality gets
 * worked around, and the workaround is the WhatsApp group this system exists
 * to replace. So the wording must never scold someone for a decision they are
 * making with an animal already in their arms.
 */
const PLACEMENT_WARNING: Record<PlacementWarning, string> = {
  'infectious-into-shared':
    'Lo estás moviendo por enfermedad, pero esta área no es de aislamiento ni médica. Un animalito enfermo aquí expone a todos los sanos que ya están dentro.',
  'over-capacity':
    'Esta área ya está en su límite. Con más animalitos hay más contagio, más estrés y peor aire: la decisión es de ustedes, pero que sea sabiéndolo.',
  'restarts-quarantine-clock':
    'Ya hay animalitos en esta cuarentena. Al entrar uno nuevo, el tiempo de observación vuelve a empezar para todos los que ya estaban.',
  'undocumented-clearance':
    'Sale de cuarentena a población general sin registrar el alta. Si el veterinario ya lo revisó, elige "Alta veterinaria" para que quede quién lo autorizó.',
  'area-inactive': 'Esta área está marcada como fuera de servicio.',
};

const PATHOGEN: Record<Pathogen, string> = {
  parvovirus: 'Parvovirus',
  moquillo: 'Moquillo (distemper)',
};

export const es: Messages = {
  locale: 'es-BO',

  sexLabel: (sex) => SEX[sex],

  sizeLabel(size, sex) {
    if (size === 'large') return 'grande';
    return SIZE_STEMS[size] + (sex === 'female' ? 'a' : 'o');
  },

  speciesNoun: (species, sex) => SPECIES_NOUN[species][sex],

  speciesPlural: (species) => SPECIES_PLURAL[species],

  article: (sex) => (sex === 'female' ? 'la' : 'el'),

  pastParticiple: (stem, sex) => stem + (sex === 'female' ? 'a' : 'o'),

  mixedBreed: (sex) => (sex === 'female' ? 'mestiza' : 'mestizo'),

  mixedBreedWithTraits: (sex, traits) => {
    const base = sex === 'female' ? 'mestiza' : 'mestizo';
    if (traits.length === 0) return base;
    // Spanish joins a final item with "y", not a comma — "pastor alemán y
    // husky", never "pastor alemán, husky". With the cap at 2 this is the
    // only case, but the reduce keeps it correct if the cap ever rises.
    const list =
      traits.length === 1
        ? traits[0]
        : `${traits.slice(0, -1).join(', ')} y ${traits[traits.length - 1]}`;
    return `${base} con rasgos de ${list}`;
  },

  breedNeedsSexFirst: (traits) => {
    // Why the gate exists. Kept second, because the admin already knows they
    // have not chosen a sex — what they do not know is what it unlocks.
    const why =
      'Elige primero el sexo: la palabra cambia entre «mestizo» y «mestiza», y eso no se ve en una foto.';
    if (traits.length === 0) return why;
    // Same "y" join as mixedBreedWithTraits: Spanish joins a final item with
    // "y", never a trailing comma.
    const list =
      traits.length === 1
        ? traits[0]
        : `${traits.slice(0, -1).join(', ')} y ${traits[traits.length - 1]}`;
    // "Se parece a" and not "es": this is a resemblance the model read off a
    // photograph, and the whole breed design fails toward mestizo. Wording it
    // as a claim here would undo that one field before the admin ever taps it.
    return `Se parece a ${list}. ${why}`;
  },

  formatAge(ageMonths) {
    if (ageMonths === null) return 'edad desconocida';
    if (ageMonths < 12) return `${ageMonths} ${ageMonths === 1 ? 'mes' : 'meses'}`;
    const years = Math.floor(ageMonths / 12);
    return `${years} ${years === 1 ? 'año' : 'años'}`;
  },

  formatAgeRange(minMonths, maxMonths) {
    const bothMonths = maxMonths < 12;
    // Collapse the unit when both bounds share it ("entre 4 y 7 meses");
    // spell both out when they do not ("entre 8 meses y 2 años"), because
    // "entre 8 y 2 años" would be simply wrong.
    if (bothMonths) {
      return `entre ${minMonths} y ${maxMonths} ${maxMonths === 1 ? 'mes' : 'meses'}`;
    }
    const bothYears = minMonths >= 12 && minMonths % 12 === 0 && maxMonths % 12 === 0;
    if (bothYears) {
      const lo = minMonths / 12;
      const hi = maxMonths / 12;
      return `entre ${lo} y ${hi} ${hi === 1 ? 'año' : 'años'}`;
    }
    return `entre ${this.formatAge(minMonths)} y ${this.formatAge(maxMonths)}`;
  },

  formatMeta(pet) {
    return [this.formatAge(pet.ageMonths), SEX[pet.sex], this.sizeLabel(pet.size, pet.sex)].join(
      ' · ',
    );
  },

  formatBreedLine(breed) {
    const text = breed.trim().replace(/\s+/g, ' ');
    if (text === '') return null;
    if (text.length <= BREED_LINE_MAX_CHARS) return text;

    // ⚠️ The ellipsis is RENDERED, so it spends one of the measured
    // characters. Budgeting the kept text at the full limit and then appending
    // it produces a line one glyph over — which is exactly what the first
    // version of this did, caught by the test below rather than by reading.
    const keptBudget = BREED_LINE_MAX_CHARS - 1;

    // Cut on the last word boundary that fits. A space found at index i means
    // the text before it is i characters long, so searching a window of
    // `keptBudget + 1` is what lets a word end precisely on the limit.
    const cut = text.slice(0, keptBudget + 1).lastIndexOf(' ');
    // A single word longer than the whole budget is not realistic Spanish
    // breed copy, but it is reachable by typing, so hard-cut rather than
    // returning an empty line.
    const kept = cut > 0 ? text.slice(0, cut) : text.slice(0, keptBudget);

    // Drop a dangling connector so the ellipsis does not read as a broken
    // sentence: "…pastor alemán, husky siberiano y…" should be
    // "…pastor alemán, husky siberiano…".
    return `${kept.replace(/[\s,;]*(?:\sy)?[\s,;]*$/u, '')}…`;
  },

  statusLabel: (status) => STATUS[status],

  medicalKindLabel: (kind) => MEDICAL_KIND[kind],

  medicalError: (error) => MEDICAL_ERROR[error],

  medicalWarning: (warning) => MEDICAL_WARNING[warning],

  measurementError: (error) => MEASUREMENT_ERROR[error],

  measurementWarning(warning) {
    if (warning.kind === 'weight-unusual-for-species') {
      return `Pasa de ${kgNumber(warning.aboveKg)} kg, que es poco común en ${SPECIES_PLURAL_PLAIN[warning.species]}. Revisa que no falte la coma. Si el peso es real, guárdalo igual.`;
    }
    const previous = `${kgNumber(warning.previousKg)} kg`;
    return warning.direction === 'up'
      ? `Es el doble o más del último peso anotado (${previous}). En un cachorro que está creciendo puede ser real; si no, revisa la coma, porque las dosis se calculan por kilo.`
      : `Es la mitad o menos del último peso anotado (${previous}). Revisa la coma, porque las dosis se calculan por kilo. Si de verdad bajó tanto, guárdalo igual.`;
  },

  bodyConditionLabel(score) {
    const band = BODY_CONDITION_BAND[score - 1];
    return band ? `${score} · ${band}` : String(score);
  },

  muscleConditionLabel: (condition) => MUSCLE_CONDITION[condition],

  formatKg: (kg) => `${kgNumber(kg)} kg`,

  formatKgRange: (minKg, maxKg) => `${kgNumber(minKg)}–${kgNumber(maxKg)} kg`,

  formatKgInput: (kg) => kgNumber(kg),

  microchipError: (error) => MICROCHIP_ERROR[error],

  intakeError: (error) => INTAKE_ERROR[error],

  authError: (error) => AUTH_ERROR[error],

  adoptionInquiry: (petName) => `Hola, me interesa adoptar a ${petName}`,

  arrivalAnnouncement({ emoji, descriptors, origin, recordUrl }) {
    // Only the parts that are actually known. "Nuevo ingreso en camino: ?"
    // reads as a broken system and trains people to ignore it.
    const who = descriptors.length > 0 ? descriptors.join(', ') : 'sin datos aún';
    const from = origin ? `\nViene de: ${origin}` : '';
    return `${emoji} Nuevo ingreso en camino: ${who}${from}\nFicha: ${recordUrl}`;
  },

  areaKindLabel: (kind) => AREA_KIND[kind],

  areaKindHint: (kind) => AREA_KIND_HINT[kind],

  areaError: (error) => AREA_ERROR[error],

  placementReasonLabel: (reason) => PLACEMENT_REASON[reason],

  placementWarning: (warning) => PLACEMENT_WARNING[warning],

  pathogenLabel: (pathogen) => PATHOGEN[pathogen],

  occupancyLabel(count, capacity) {
    // Without a capacity there is no ratio to show, and inventing one would be
    // worse than saying nothing — the whole point of the number is to be
    // compared against a limit somebody actually measured.
    if (capacity === null) return `${count} ${count === 1 ? 'animalito' : 'animalitos'}`;
    return `${count} de ${capacity}`;
  },

  daysAgoLabel(days) {
    if (days <= 0) return 'hoy';
    if (days === 1) return 'ayer';
    return `hace ${days} días`;
  },

  contactDurationLabel(ms) {
    const days = ms / MS_PER_DAY;
    // Rounded DOWN, and "menos de un día" rather than "0 días": a contact that
    // reads as zero looks like no contact at all, which is the one impression
    // this list must never give.
    if (days < 1) return 'menos de un día juntos';
    const whole = Math.floor(days);
    return `${whole} ${whole === 1 ? 'día' : 'días'} juntos`;
  },

  // ── the medical review gate, and reading a vaccination card (step 9) ──────

  medicalReview: {
    unconfirmedBadge: 'Sin confirmar',
    notCounted:
      'Todavía no cuenta: no aparece en las próximas dosis, los vencimientos ni las alertas hasta que alguien lo confirme mirando la tarjeta.',
    confirm: 'Confirmar',
    correctAndConfirm: 'Corregir y confirmar',
    saveAndConfirm: 'Guardar y confirmar',
    discard: 'Descartar',
    confirmNeedsEdit:
      'Falta completar lo marcado antes de confirmar. Usa «Corregir y confirmar».',
    showCard: 'Ver tarjeta',
    hideCard: 'Ocultar tarjeta',
    cardAlt: 'Foto de la tarjeta de vacunación',
    unknownKind: 'Tipo sin leer',
    unknownName: 'Nombre sin leer',
    unknownDate: 'Fecha sin leer',
    reviewingNotice:
      'Estás revisando datos leídos de una tarjeta. Compara cada uno con la foto: al guardar, tu nombre queda como quien los confirmó.',
    captureTitle: 'Leer una tarjeta de vacunación',
    captureHint:
      'Fotografía la tarjeta completa, de frente y con buena luz. Cada registro que se lea queda sin confirmar hasta que lo revises.',
    captureTakePhoto: 'Fotografiar tarjeta',
    captureGallery: 'Galería',
    captureRetry: 'Leer otra vez',
    captureUploading: 'Guardando la foto de la tarjeta…',
    captureUploadFailed:
      'No pudimos guardar la foto de la tarjeta. Revisa tu conexión e inténtalo de nuevo.',
    captureUnreadable:
      'No pudimos abrir esa foto. Prueba tomarla con la cámara desde aquí, o elige una en JPG.',
    captureReading: 'Leyendo la tarjeta…',
    captureSavedNote: 'la foto de la tarjeta ya se guardó y queda aunque la lectura falle.',
  } satisfies MedicalReviewCopy,

  extractionSourceLabel(source: MedicalExtractionSource | null) {
    if (source === 'vaccination-card') return 'Leído de una tarjeta de vacunación';
    if (source === 'dictation') return 'Dictado en consulta';
    return 'Extraído automáticamente';
  },

  cardFieldLabel(field: CardField) {
    const labels: Record<CardField, string> = {
      kind: 'Tipo',
      name: 'Qué se aplicó',
      performedAt: 'Fecha',
      nextDueAt: 'Próxima dosis',
      batch: 'Lote',
      manufacturer: 'Laboratorio',
      veterinarian: 'Veterinario',
      clinic: 'Clínica o campaña',
    };
    return labels[field];
  },

  evidenceLine({ snippet, confidence, withheld }: FieldEvidence) {
    // "92 %", with the space the RAE recommends.
    const pct = `${Math.round(confidence * 100)} %`;
    const read = snippet === null ? null : `«${snippet}»`;
    const reason: WithheldReason | null = withheld;
    switch (reason) {
      case 'low-confidence':
        return read
          ? `Leído con dudas: ${read} (${pct}). No se completó: revísalo en la tarjeta.`
          : 'No se pudo leer con seguridad. Revísalo en la tarjeta.';
      case 'unreadable-date':
        return `Leído: ${read ?? '—'}, pero no se entiende como fecha. No se completó.`;
      case 'implausible-date':
        return `Leído: ${read ?? '—'}, pero esa fecha no es posible. No se completó.`;
      case 'too-long':
        return 'Lo leído es demasiado largo para ser un solo dato. No se completó.';
      case 'disputed':
        return 'Las dos lecturas no coinciden. No se completó.';
      default:
        return read ? `Leído: ${read} (${pct})` : 'No se leyó nada en la tarjeta.';
    }
  },

  cardExtractFailure(failure: CardExtractFailure) {
    const messages: Record<CardExtractFailure, string> = {
      'not-configured':
        'La lectura automática de tarjetas no está disponible ahora. La foto quedó guardada; puedes cargar los registros a mano.',
      unauthorized:
        'No tienes permiso para leer tarjetas. Si te acaban de dar acceso, cierra sesión y vuelve a entrar.',
      'already-extracted': 'Esta tarjeta ya se leyó: sus registros están en la lista.',
      'photo-rejected':
        'No pudimos usar esa foto. Prueba con otra foto de la tarjeta, de frente y con buena luz.',
      'pet-missing': 'Esta ficha ya no existe.',
      timeout:
        'La lectura tardó demasiado y la cortamos. La foto ya está guardada: puedes intentar otra vez.',
      failed:
        'No pudimos leer la tarjeta. La foto ya está guardada: puedes intentar otra vez o cargar los registros a mano.',
    };
    return messages[failure];
  },

  cardExtractSummary({ written, droppedRows, notACard }) {
    if (notACard) {
      return 'Esa foto no parece una tarjeta de vacunación ni de desparasitación, así que no se cargó nada.';
    }
    if (written === 0) {
      return droppedRows > 0
        ? 'No se pudo leer con seguridad ninguna fila. Cárgalas a mano mirando la foto.'
        : 'No se encontró ningún registro legible en la tarjeta.';
    }
    const read =
      written === 1
        ? 'Se leyó 1 registro. Queda sin confirmar: revísalo con la tarjeta a la vista.'
        : `Se leyeron ${written} registros. Quedan sin confirmar: revísalos uno por uno con la tarjeta a la vista.`;
    if (droppedRows === 0) return read;
    const dropped =
      droppedRows === 1
        ? 'Una fila no se pudo leer y hay que cargarla a mano.'
        : `${droppedRows} filas no se pudieron leer y hay que cargarlas a mano.`;
    return `${read} ${dropped}`;
  },

  awaitingReviewCount(count: number) {
    return count === 1 ? '1 registro espera revisión' : `${count} registros esperan revisión`;
  },

  confirmedByLabel: (by: string) => `Confirmado por ${by}`,

  nextDueSummary: (name: string, dateText: string) => `Lo próximo: ${name}, el ${dateText}.`,
};
