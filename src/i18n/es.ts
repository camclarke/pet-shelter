/**
 * Spanish (es) — the reference locale, and the language of the site today.
 *
 * Every identifier in this file is English. Every value is Spanish. That is
 * the rule for the whole `src/i18n` directory, and it is what lets a forking
 * shelter translate the site without reading a line of logic.
 */

import type { Messages } from './messages';
import type {
  AreaKind,
  MedicalRecordKind,
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

  statusLabel: (status) => STATUS[status],

  medicalKindLabel: (kind) => MEDICAL_KIND[kind],

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
};
