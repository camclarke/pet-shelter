/**
 * Spanish (es) — the reference locale, and the language of the site today.
 *
 * Every identifier in this file is English. Every value is Spanish. That is
 * the rule for the whole `src/i18n` directory, and it is what lets a forking
 * shelter translate the site without reading a line of logic.
 */

import type { Messages } from './messages';
import type { MedicalRecordKind, PetSex, PetSize, PetStatus, Species } from '@/lib/types';
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

  formatAge(ageMonths) {
    if (ageMonths === null) return 'edad desconocida';
    if (ageMonths < 12) return `${ageMonths} ${ageMonths === 1 ? 'mes' : 'meses'}`;
    const years = Math.floor(ageMonths / 12);
    return `${years} ${years === 1 ? 'año' : 'años'}`;
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
};
