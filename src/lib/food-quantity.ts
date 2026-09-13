/**
 * Food quantities, from what a volunteer types to grams. The PURE layer.
 *
 * No Firestore, no Spanish copy, no model. Build-order step 13, plan §12.
 *
 * ═══ WHY THIS IS DETERMINISTIC CODE AND NOT THE MODEL ═══════════════════════
 * Plan §12.1: the LLM turns messy words into structure, and arithmetic decides.
 * A model asked "how many grams is 3 bolsas de 5 kg" is right nearly always and
 * non-deterministic always — the same text could stock 15 kg on Monday and
 * 1,5 kg on Tuesday, and nobody could tell which day was wrong. So the parser
 * returns the quantity AS WRITTEN ("3 bolsas", "de 5 kg") and this module is
 * the only thing that turns it into a number.
 *
 * ═══ THE DECIMAL SEPARATOR, AGAIN ══════════════════════════════════════════
 * Same hazard `parseWeightInput` refuses in `measurements.ts`: Bolivia writes
 * 2,5 where English writes 2.5, and uses the point to group thousands. So
 * "1.500 kg" is one and a half kilos to one person and fifteen hundred to
 * another. At most two decimals are read; three are REFUSED rather than
 * guessed. For stock the harm is smaller than a dose, but a pantry that silently
 * gains 1 498 kg of rice is a pantry nobody trusts again.
 *
 * ═══ ONE QUANTITY PER LINE ═════════════════════════════════════════════════
 * "3 bolsas de arroz y 2 kg de hígado" holds two quantities. Reading it as one
 * would multiply them (3 × 2 kg) — a confident wrong number. Anything with a
 * number this grammar did not consume is `ambiguous`, and the UI asks for one
 * food per line.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Units
// ─────────────────────────────────────────────────────────────────────────────

export type MassUnit = 'kg' | 'g' | 'libra' | 'arroba' | 'quintal';

/**
 * Grams per unit.
 *
 * ⚠️ `libra`, `arroba` and `quintal` are the TRADITIONAL units of Bolivian
 * markets, not the imperial pound. A quintal of rice is sold as 46 kg, which is
 * four arrobas of 11,5 kg, which is 100 libras of 460 g — the old Castilian
 * pound, not the 453,6 g international one. The difference is 1,4 %, harmless
 * for a pantry, and the market convention is the one a donor means when they
 * say "un quintal". Every conversion through one of these is surfaced to the
 * person confirming the line, because a regional unit is exactly where a donor
 * and a spreadsheet can mean different things.
 */
export const GRAMS_PER_UNIT: Record<MassUnit, number> = {
  kg: 1000,
  g: 1,
  libra: 460,
  arroba: 11_500,
  quintal: 46_000,
};

export const TRADITIONAL_UNITS: readonly MassUnit[] = ['libra', 'arroba', 'quintal'];

/** Words and abbreviations, already folded to lowercase without accents. */
const MASS_UNIT_WORDS: Record<string, MassUnit> = {
  kg: 'kg',
  kgs: 'kg',
  kilo: 'kg',
  kilos: 'kg',
  kilogramo: 'kg',
  kilogramos: 'kg',
  g: 'g',
  gr: 'g',
  grs: 'g',
  gramo: 'g',
  gramos: 'g',
  lb: 'libra',
  lbs: 'libra',
  libra: 'libra',
  libras: 'libra',
  arroba: 'arroba',
  arrobas: 'arroba',
  quintal: 'quintal',
  quintales: 'quintal',
  qq: 'quintal',
};

/**
 * Unit words that mean ONE unit when written without a number: "kilo y medio",
 * "una libra" already has its number. Abbreviations are excluded — "kg de
 * arroz" with no number is a missing number, not one kilogram.
 */
const IMPLICIT_ONE_WORDS = new Set(['kilo', 'libra', 'arroba', 'quintal']);

/**
 * Containers. A count of these is not a mass — "2 bolsas de arroz" says nothing
 * about how much rice until a size follows ("de 5 kg"). Plan §12.2: "una bolsa
 * de arroz" is not a unit.
 *
 * ⚠️ `presa` is Bolivian for a piece of chicken, and belongs here: a count of
 * pieces with no weight.
 */
const PACKAGE_WORDS: Record<string, string> = {
  bolsa: 'bolsa',
  bolsas: 'bolsa',
  bolsita: 'bolsa',
  bolsitas: 'bolsa',
  saco: 'saco',
  sacos: 'saco',
  costal: 'costal',
  costales: 'costal',
  caja: 'caja',
  cajas: 'caja',
  lata: 'lata',
  latas: 'lata',
  paquete: 'paquete',
  paquetes: 'paquete',
  bandeja: 'bandeja',
  bandejas: 'bandeja',
  balde: 'balde',
  baldes: 'balde',
  frasco: 'frasco',
  frascos: 'frasco',
  sobre: 'sobre',
  sobres: 'sobre',
  funda: 'funda',
  fundas: 'funda',
  bulto: 'bulto',
  bultos: 'bulto',
  unidad: 'unidad',
  unidades: 'unidad',
  pieza: 'pieza',
  piezas: 'pieza',
  presa: 'presa',
  presas: 'presa',
  atado: 'atado',
  atados: 'atado',
  malla: 'malla',
  mallas: 'malla',
};

/** Volumes: a real quantity, but the pantry is kept in mass. */
const VOLUME_WORDS: Record<string, string> = {
  l: 'litro',
  lt: 'litro',
  lts: 'litro',
  litro: 'litro',
  litros: 'litro',
  ml: 'ml',
  cc: 'ml',
};

// ─────────────────────────────────────────────────────────────────────────────
// Numbers
// ─────────────────────────────────────────────────────────────────────────────

/** Spanish number words a donation description realistically uses. */
const NUMBER_WORDS: Record<string, number> = {
  un: 1,
  una: 1,
  uno: 1,
  dos: 2,
  tres: 3,
  cuatro: 4,
  cinco: 5,
  seis: 6,
  siete: 7,
  ocho: 8,
  nueve: 9,
  diez: 10,
  once: 11,
  doce: 12,
  quince: 15,
  veinte: 20,
  veinticinco: 25,
  treinta: 30,
  cuarenta: 40,
  cincuenta: 50,
  cien: 100,
};

/** Fraction words, which multiply whatever number precedes them (default 1). */
const FRACTION_WORDS: Record<string, number> = {
  medio: 0.5,
  media: 0.5,
  cuarto: 0.25,
  cuartos: 0.25,
};

const UNICODE_FRACTIONS: Record<string, number> = { '½': 0.5, '¼': 0.25, '¾': 0.75 };

/** Decimals accepted in a typed number. Three are refused — see the header. */
export const QUANTITY_MAX_DECIMALS = 2;

type NumberToken = { value: number } | { tooPrecise: true } | null;

/**
 * One token as a number, or null if it is not one.
 *
 * ⚠️ Never `Number(text)` or `parseFloat`. `parseFloat('2,5')` is 2 — the
 * half kilo silently disappears, which is the failure this module exists to
 * make impossible. Same warning as `parseWeightInput`.
 */
function readNumber(token: string): NumberToken {
  if (token in NUMBER_WORDS) return { value: NUMBER_WORDS[token]! };
  if (token in UNICODE_FRACTIONS) return { value: UNICODE_FRACTIONS[token]! };

  const fraction = /^(\d+)\/(\d+)$/.exec(token);
  if (fraction) {
    const den = Number(fraction[2]);
    return den > 0 ? { value: Number(fraction[1]) / den } : null;
  }

  const decimal = /^(\d+)(?:[.,](\d+))?$/.exec(token);
  if (!decimal) return null;
  const decimals = decimal[2] ?? '';
  if (decimals.length > QUANTITY_MAX_DECIMALS) return { tooPrecise: true };
  const value = Number(decimals ? `${decimal[1]}.${decimals}` : decimal[1]);
  return Number.isFinite(value) ? { value } : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tokenising
// ─────────────────────────────────────────────────────────────────────────────

/** Lowercase, accents removed, so "Kilos" and "kilós" read alike. */
export function foldText(text: string): string {
  return text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
}

function tokenise(text: string): string[] {
  return (
    foldText(text)
      // "2x5kg", "2 × 5 kg" → "2 x 5 kg"
      .replace(/(\d)\s*[x×*]\s*(?=\d)/g, '$1 x ')
      // "5kg" → "5 kg", but leave "1/2" and "2,5" whole
      .replace(/(\d)([a-z½¼¾])/g, '$1 $2')
      .replace(/[()[\]{}"'«»“”;:!?¡¿]/g, ' ')
      .split(/\s+/)
      // A trailing comma or period ends a clause, it is not a decimal: "2 kg,"
      .map((token) => token.replace(/^[,.]+|[,.]+$/g, ''))
      .filter((token) => token.length > 0)
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Parsing
// ─────────────────────────────────────────────────────────────────────────────

export type QuantityParse =
  | { kind: 'empty' }
  /**
   * A mass. `count` and `packageUnit` are set when it came from containers of
   * a stated size ("3 bolsas de 5 kg"); `traditionalUnit` when a libra, arroba
   * or quintal was converted, so the person confirming can see it happened.
   */
  | {
      kind: 'ok';
      grams: number;
      count: number | null;
      packageUnit: string | null;
      traditionalUnit: MassUnit | null;
    }
  /** Containers, or a volume, with no mass: "2 bolsas", "5 litros". */
  | { kind: 'needs-mass'; count: number; packageUnit: string }
  /** Text, but no quantity at all: "arroz". */
  | { kind: 'no-quantity' }
  /** More than one quantity, or a number that belongs to nothing. */
  | { kind: 'ambiguous' }
  /** Three or more decimals: "1.500 kg". */
  | { kind: 'too-precise' };

interface Mass {
  grams: number;
  unit: MassUnit;
  /** Index of the token that STARTED this mass, to test what precedes it. */
  start: number;
}

/**
 * A quantity phrase as a volunteer or the parser wrote it.
 *
 * Reads, among others: "2 kg", "2,5 kg", "15 kilos", "medio kilo", "kilo y
 * medio", "dos kilos y medio", "un cuarto de kilo", "500 g", "3 libras", "un
 * quintal", "3 bolsas de 5 kg", "un saco de croquetas de 15 kilos", "2 x 5 kg",
 * "2 bolsas" (needs a mass), "5 litros" (needs a mass).
 *
 * Food words and connectors are skipped, so "3 bolsas de arroz de 5 kg" reads
 * the same as "3 bolsas de 5 kg". A NUMBER is never skipped: an unconsumed one
 * makes the phrase ambiguous.
 */
export function parseQuantityPhrase(text: string): QuantityParse {
  if (text.trim() === '') return { kind: 'empty' };
  const tokens = tokenise(text);

  const masses: Mass[] = [];
  const packages: { count: number; unit: string; index: number }[] = [];
  const volumes: { count: number; unit: string }[] = [];
  const multiplies: { count: number; mass: Mass }[] = [];
  let strayNumber = false;

  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i]!;
    const number = readNumber(token);
    if (number && 'tooPrecise' in number) return { kind: 'too-precise' };

    // ── [N] (medio|cuarto|cuartos) de UNIT ────────────────────────────────
    // "medio kilo" reads as number + unit below, because "medio" is a
    // fraction word; this branch is "un cuarto de kilo", "tres cuartos de kilo".
    const fractionAt = number ? i + 1 : i;
    const fractionWord = tokens[fractionAt];
    if (
      fractionWord !== undefined &&
      fractionWord in FRACTION_WORDS &&
      tokens[fractionAt + 1] === 'de' &&
      MASS_UNIT_WORDS[tokens[fractionAt + 2] ?? ''] !== undefined
    ) {
      const unit = MASS_UNIT_WORDS[tokens[fractionAt + 2]!]!;
      const multiplier = number ? number.value : 1;
      masses.push({
        grams: multiplier * FRACTION_WORDS[fractionWord]! * GRAMS_PER_UNIT[unit],
        unit,
        start: i,
      });
      i = fractionAt + 3;
      continue;
    }

    // A digit or number word, or a bare fraction word: "medio kilo".
    const valueHere = number ? number.value : token in FRACTION_WORDS ? FRACTION_WORDS[token]! : null;

    if (valueHere !== null) {
      const next = tokens[i + 1] ?? '';

      // ── N x MASS ──────────────────────────────────────────────────────
      if (next === 'x' || next === 'por') {
        const inner = readMassAt(tokens, i + 2);
        if (inner) {
          multiplies.push({ count: valueHere, mass: inner.mass });
          i = inner.next;
          continue;
        }
      }

      // ── N UNIT [y medio] ──────────────────────────────────────────────
      const mass = readMassAt(tokens, i);
      if (mass) {
        masses.push(mass.mass);
        i = mass.next;
        continue;
      }

      // ── N PACKAGE ─────────────────────────────────────────────────────
      if (next in PACKAGE_WORDS) {
        packages.push({ count: valueHere, unit: PACKAGE_WORDS[next]!, index: i });
        i += 2;
        continue;
      }

      // ── N VOLUME ──────────────────────────────────────────────────────
      if (next in VOLUME_WORDS) {
        volumes.push({ count: valueHere, unit: VOLUME_WORDS[next]! });
        i += 2;
        continue;
      }

      // A number that belongs to nothing. Only a DIGIT counts as stray: "un",
      // "una" and "medio" are also articles and adjectives ("un poco de
      // arroz"), and treating them as a lost quantity would call ordinary
      // Spanish ambiguous. "croquetas 3 en 1" is a stray digit, and ambiguous.
      if (/\d/.test(token)) strayNumber = true;
      i += 1;
      continue;
    }

    // ── an implicit ONE: "kilo y medio", "libra" ─────────────────────────
    if (IMPLICIT_ONE_WORDS.has(token)) {
      const mass = readMassAt(tokens, i, 1);
      if (mass) {
        masses.push(mass.mass);
        i = mass.next;
        continue;
      }
    }

    i += 1;
  }

  if (strayNumber) return { kind: 'ambiguous' };

  // A package's SIZE is a mass introduced by "de" after the package:
  // "3 bolsas de arroz de 5 kg". "3 bolsas y 2 kg" is not a size — that is two
  // quantities, and multiplying them would invent a number.
  const sized = packages.map((pkg) => {
    const size = masses.find((m) => m.start > pkg.index && tokens[m.start - 1] === 'de');
    return { pkg, size };
  });
  const sizeStarts = new Set(sized.flatMap((s) => (s.size ? [s.size.start] : [])));
  const standalone = masses.filter((m) => !sizeStarts.has(m.start));

  const quantities = packages.length + standalone.length + multiplies.length + volumes.length;
  if (quantities === 0) return { kind: 'no-quantity' };
  if (quantities > 1) return { kind: 'ambiguous' };

  const traditional = (unit: MassUnit): MassUnit | null =>
    TRADITIONAL_UNITS.includes(unit) ? unit : null;

  if (packages.length === 1) {
    const { pkg, size } = sized[0]!;
    if (!size) return { kind: 'needs-mass', count: pkg.count, packageUnit: pkg.unit };
    return {
      kind: 'ok',
      grams: Math.round(pkg.count * size.grams),
      count: pkg.count,
      packageUnit: pkg.unit,
      traditionalUnit: traditional(size.unit),
    };
  }
  if (multiplies.length === 1) {
    const { count, mass } = multiplies[0]!;
    return {
      kind: 'ok',
      grams: Math.round(count * mass.grams),
      count,
      packageUnit: null,
      traditionalUnit: traditional(mass.unit),
    };
  }
  if (volumes.length === 1) {
    const volume = volumes[0]!;
    return { kind: 'needs-mass', count: volume.count, packageUnit: volume.unit };
  }
  const mass = standalone[0]!;
  return {
    kind: 'ok',
    grams: Math.round(mass.grams),
    count: null,
    packageUnit: null,
    traditionalUnit: traditional(mass.unit),
  };
}

/**
 * A mass starting at `index`: a number (or `implicit`) then a unit, optionally
 * followed by "y medio" / "y media" / "y cuarto".
 */
function readMassAt(
  tokens: readonly string[],
  index: number,
  implicit: number | null = null
): { mass: Mass; next: number } | null {
  let value: number;
  let unitAt: number;
  if (implicit !== null) {
    value = implicit;
    unitAt = index;
  } else {
    const token = tokens[index] ?? '';
    const number = readNumber(token);
    if (number && 'value' in number) value = number.value;
    else if (token in FRACTION_WORDS) value = FRACTION_WORDS[token]!;
    else return null;
    unitAt = index + 1;
  }

  const unit = MASS_UNIT_WORDS[tokens[unitAt] ?? ''];
  if (unit === undefined) return null;

  let next = unitAt + 1;
  if (tokens[next] === 'y' && (tokens[next + 1] ?? '') in FRACTION_WORDS) {
    value += FRACTION_WORDS[tokens[next + 1]!]!;
    next += 2;
  }
  return { mass: { grams: value * GRAMS_PER_UNIT[unit], unit, start: index }, next };
}

// ─────────────────────────────────────────────────────────────────────────────
// Bounds
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Above this, one donation line is a typo rather than a delivery. Two tonnes:
 * forty quintales of rice is 1 840 kg and is a real, if generous, gift; a
 * missing comma on "15,5 kg" typed as "155 kg" is not caught here, which is
 * what the review step is for.
 */
export const LINE_MAX_GRAMS = 2_000_000;

/** One line heavier than this warns, without blocking. */
export const LINE_UNUSUAL_ABOVE_GRAMS = 500_000;

export type DecimalParse =
  | { kind: 'empty' }
  | { kind: 'ok'; value: number }
  | { kind: 'invalid' }
  | { kind: 'too-precise' };

/**
 * A plain count or measure — ladles, dogs, a percentage — in either decimal
 * convention, never through `Number()`. Signs and words are refused: a form
 * field for "cucharones" is not the place to read "dos".
 */
export function parseDecimalInput(text: string): DecimalParse {
  const trimmed = text.trim();
  if (trimmed === '') return { kind: 'empty' };
  if (!/^\d+(?:[.,]\d+)?$/.test(trimmed)) return { kind: 'invalid' };
  const number = readNumber(trimmed);
  if (number === null) return { kind: 'invalid' };
  if ('tooPrecise' in number) return { kind: 'too-precise' };
  return { kind: 'ok', value: number.value };
}

/**
 * A mass typed straight off the scale, in kilograms, either separator.
 * Same contract as `parseWeightInput`: two decimals at most, three refused.
 */
export function parseKilogramsInput(text: string): QuantityParse {
  const trimmed = text.trim().replace(/\s*(kg|kgs|kilos?)$/i, '').trim();
  if (trimmed === '') return { kind: 'empty' };
  const number = readNumber(trimmed);
  if (number === null) return { kind: 'no-quantity' };
  if ('tooPrecise' in number) return { kind: 'too-precise' };
  return {
    kind: 'ok',
    grams: Math.round(number.value * 1000),
    count: null,
    packageUnit: null,
    traditionalUnit: null,
  };
}
