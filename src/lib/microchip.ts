/**
 * ISO 11784 / ISO 11785 microchip identity.
 *
 * ── What a microchip actually is ──────────────────────────────────────────
 * A passive RFID transponder. It has no battery and no GPS. It is inert until
 * a scanner's field energises it, at which point it returns one number and
 * nothing else. Read range is centimetres, not metres.
 *
 * This matters for what this module can and cannot promise. A microchip
 * enables *identification on contact*. It does not enable tracking. Any
 * "location" this system records is the location of the SCANNER at the moment
 * of a scan — see `ScanEvent` in types.ts. That makes it a recovery tool
 * (someone found this pet, here, at this time), never a live tracker.
 *
 * ── The number ────────────────────────────────────────────────────────────
 * ISO 11784 defines a 64-bit structure:
 *
 *     1 bit    animal application flag
 *    14 bits   reserved
 *     1 bit    flag: additional data block follows
 *    15 bits   reserved
 *    10 bits   country code (ISO 3166-1 numeric) OR ICAR manufacturer code
 *    38 bits   national identification number
 *
 * Rendered for humans as 15 decimal digits: a 3-digit prefix followed by a
 * 12-digit national ID.
 *
 * ISO 11785 defines the air interface: 134.2 kHz, FDX-B or HDX.
 */

/** How the transponder is encoded. Non-ISO chips are legacy but still in service. */
export type MicrochipStandard =
  /** ISO 11785 full-duplex B, 134.2 kHz. The international standard, 15 digits. */
  | 'iso-fdx-b'
  /** ISO 11785 half-duplex, 134.2 kHz. Also 15 digits; less common in companion animals. */
  | 'iso-hdx'
  /**
   * Legacy North American chips at 125 kHz or 128 kHz, 9 or 10 digits.
   * Not readable by an ISO-only scanner. Recorded honestly rather than
   * coerced into a 15-digit field it does not fit.
   */
  | 'non-iso-125'
  | 'non-iso-128';

export const ISO_STANDARDS: MicrochipStandard[] = ['iso-fdx-b', 'iso-hdx'];

/**
 * Largest value representable in the 38-bit national ID field.
 * 2^38 - 1. A 15-digit code whose last 12 digits exceed this is not a
 * physically possible ISO 11784 code, however well-formed it looks.
 */
export const MAX_NATIONAL_ID = 274_877_906_943n;

/** ICAR reserves 999 for test transponders. Never a real animal. */
export const TEST_TRANSPONDER_PREFIX = '999';

export type PrefixKind =
  /** 000–899: ISO 3166-1 numeric country code, used where a national authority guarantees uniqueness. */
  | 'country'
  /** 900: ICAR shared manufacturer code, allocated in ranges to several manufacturers. */
  | 'manufacturer-shared'
  /** 901–998: ICAR unshared manufacturer code, granted to a single manufacturer. */
  | 'manufacturer'
  /** 999: test transponder. */
  | 'test';

export interface ParsedMicrochip {
  /** The full 15-digit code, normalised. Always a string — leading zeros are significant. */
  code: string;
  /** First three digits. */
  prefix: string;
  prefixKind: PrefixKind;
  /** Last twelve digits, still a string for the same reason. */
  nationalId: string;
}

export type MicrochipError =
  | 'empty'
  | 'non-numeric'
  | 'wrong-length'
  | 'test-transponder'
  | 'national-id-overflow';

export interface MicrochipValidation {
  valid: boolean;
  error?: MicrochipError;
  parsed?: ParsedMicrochip;
}

/**
 * Strip the separators people actually type. Scanners and vet records render
 * the same number as "985 1120 0123 45678", "985-112-001-234-5678", or with
 * no separators at all.
 */
export function normalizeMicrochipCode(raw: string): string {
  return raw.replace(/[\s\-.]/g, '');
}

function classifyPrefix(prefix: string): PrefixKind {
  const n = Number(prefix);
  if (n === 999) return 'test';
  if (n === 900) return 'manufacturer-shared';
  if (n >= 901) return 'manufacturer';
  return 'country';
}

/**
 * Validate a 15-digit ISO 11784 code.
 *
 * Deliberately strict about two things that look like pedantry and are not:
 *
 *   - The code stays a STRING. `985112001234567` parsed as a number loses any
 *     leading zero, and country-code prefixes below 100 (e.g. Bolivia is 068)
 *     genuinely start with one. Storing a microchip as a number silently
 *     corrupts every chip registered under a low country code.
 *   - A 999 prefix is rejected. Those are test transponders shipped for
 *     scanner calibration; one implanted in a real animal, or typed in from a
 *     demo chip during training, would collide with every other test chip in
 *     the world.
 */
export function validateIsoMicrochip(raw: string): MicrochipValidation {
  const code = normalizeMicrochipCode(raw);

  if (!code) return { valid: false, error: 'empty' };
  if (!/^\d+$/.test(code)) return { valid: false, error: 'non-numeric' };
  if (code.length !== 15) return { valid: false, error: 'wrong-length' };

  const prefix = code.slice(0, 3);
  const nationalId = code.slice(3);
  const prefixKind = classifyPrefix(prefix);

  if (prefixKind === 'test') {
    return { valid: false, error: 'test-transponder' };
  }

  if (BigInt(nationalId) > MAX_NATIONAL_ID) {
    return { valid: false, error: 'national-id-overflow' };
  }

  return { valid: true, parsed: { code, prefix, prefixKind, nationalId } };
}

/** Human-readable, Spanish, for admin form feedback. */
export const MICROCHIP_ERROR_ES: Record<MicrochipError, string> = {
  empty: 'Ingresa el número del microchip.',
  'non-numeric': 'El número del microchip solo puede contener dígitos.',
  'wrong-length':
    'Un microchip ISO tiene exactamente 15 dígitos. Si tiene 9 o 10, es un chip no-ISO: cámbialo en el tipo de estándar.',
  'test-transponder':
    'Los códigos que empiezan con 999 son transponders de prueba y no identifican a un animal real.',
  'national-id-overflow': 'Ese número no corresponde a un código ISO 11784 válido.',
};

/** Grouped for display: 985 112 001 234 5678 reads far better than 15 loose digits. */
export function formatMicrochipCode(code: string): string {
  const c = normalizeMicrochipCode(code);
  if (c.length !== 15) return c;
  return `${c.slice(0, 3)} ${c.slice(3, 7)} ${c.slice(7, 11)} ${c.slice(11)}`;
}

/**
 * Validate a legacy non-ISO chip. These are 9 or 10 digits and carry no
 * standardised internal structure, so length and digits are all that can
 * honestly be checked.
 */
export function validateNonIsoMicrochip(raw: string): MicrochipValidation {
  const code = normalizeMicrochipCode(raw);
  if (!code) return { valid: false, error: 'empty' };
  if (!/^\d+$/.test(code)) return { valid: false, error: 'non-numeric' };
  if (code.length !== 9 && code.length !== 10) {
    return { valid: false, error: 'wrong-length' };
  }
  return {
    valid: true,
    parsed: { code, prefix: '', prefixKind: 'manufacturer', nationalId: code },
  };
}

export function validateMicrochip(raw: string, standard: MicrochipStandard): MicrochipValidation {
  return ISO_STANDARDS.includes(standard)
    ? validateIsoMicrochip(raw)
    : validateNonIsoMicrochip(raw);
}

/**
 * EU Regulation 576/2013: for non-commercial movement of pets, the transponder
 * must be implanted BEFORE the rabies vaccination. A vaccination given first
 * is invalid and has to be redone — a real cost to a shelter and a real delay
 * to an international adoption, caught here rather than at a border.
 */
export function rabiesVaccinationIsValid(implantedAt: Date, rabiesVaccinatedAt: Date): boolean {
  return implantedAt.getTime() <= rabiesVaccinatedAt.getTime();
}
