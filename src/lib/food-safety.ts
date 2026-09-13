/**
 * Food safety at donation intake: the PURE layer. Plan §12.4.
 *
 * No Firestore, no Spanish copy, and — the point of the module — NO MODEL. The
 * parser reads the donation text, and it would cost nothing to ask it whether
 * the box holds onion. It is not asked. A safety check that depends on a
 * non-deterministic reader passes on Monday and misses on Tuesday, and nobody
 * learns which. These are word lists over the text a person typed, run on
 * every line AND on the whole description, so a hazard the parser dropped from
 * its lines is still caught.
 *
 * ═══ WHAT THIS DOES AND DOES NOT CLAIM ═════════════════════════════════════
 * A word list is a tripwire, not a food scientist. An empty result means "none
 * of the words we look for", never "this donation is safe". The lists cover
 * the hazards plan §12.4 names — Allium, chocolate, grapes and raisins,
 * xylitol, macadamia, alcohol, raw dough, cooked bones — plus caffeine,
 * avocado and visible spoilage, in the words a Cochabamba donor uses: "palta"
 * rather than "aguacate", "singani" and "chicha" alongside "cerveza".
 *
 * ═══ FAILURE DIRECTION: FLAG LOUDLY, NEVER REFUSE ══════════════════════════
 * Plan §12.4: the system flags for the shelter's own judgement, does not refuse
 * a donation, and does not tell anyone what to feed. The consequences, decided
 * 2026-09-12:
 *
 *   - A donation is NEVER blocked by a hazard. The onion is physically in the
 *     storeroom; refusing to record it loses the record, not the onion.
 *   - A line with a TOXIC hazard is kept OUT of the pot stock by default. The
 *     person confirming can put it back — a word list has false positives
 *     ("chicha morada" is not alcoholic), and a flag with no way past gets the
 *     food renamed "verdura" to get it through, which loses the one word that
 *     mattered.
 *   - A CAUTION (bones, avocado) warns and changes no default: a bone-in cut is
 *     good food once deboned, which is exactly what the flag tells them to do.
 *
 * ⚠️ Matching folds accents and case ("cebollin" typed on a phone is
 * "cebollín") and uses LETTER-AWARE boundaries, never `\b` — JavaScript's `\b`
 * is ASCII-only even under the `u` flag, so `\bajo\b` would miss nothing here
 * but `\bte\b` style lists break on "ñ". "ajo" must not fire inside "ajonjolí"
 * or "trabajo". Both are pinned by tests.
 */

import type { FoodCategory, FoodHazard, Species } from './types';
import { foldText } from './food-quantity';

export type HazardSeverity = 'toxic' | 'caution';

interface HazardRule {
  hazard: FoodHazard;
  severity: HazardSeverity;
  /** Species this hazard applies to. */
  species: readonly Species[];
  /** Folded (no accents, lowercase). Multi-word terms match across any spacing. */
  terms: readonly string[];
}

/**
 * ⚠️ Adding a term is cheap and removing one is a safety regression. Every
 * hazard below is break-probed: deleting its rule must fail a test by name.
 */
export const HAZARD_RULES: readonly HazardRule[] = [
  {
    // Onion, garlic, leek, chives, shallot. Haemolytic anaemia in dogs and —
    // more severely — cats. Cooking offers no protection, which matters in a
    // shelter that boils everything.
    hazard: 'allium',
    severity: 'toxic',
    species: ['dog', 'cat', 'rabbit'],
    terms: [
      'cebolla', 'cebollas', 'cebollita', 'cebollitas', 'cebollin', 'cebollines',
      'cebollino', 'cebollinos', 'cebolla de verdeo', 'cebolla en polvo',
      'ajo', 'ajos', 'ajo en polvo', 'puerro', 'puerros', 'chalote', 'chalotes',
      'chalota', 'chalotas', 'ciboulette',
    ],
  },
  {
    hazard: 'chocolate',
    severity: 'toxic',
    species: ['dog', 'cat', 'rabbit'],
    terms: ['chocolate', 'chocolates', 'chocolatina', 'chocolatinas', 'cacao', 'cocoa'],
  },
  {
    hazard: 'caffeine',
    severity: 'toxic',
    species: ['dog', 'cat', 'rabbit'],
    terms: ['cafe', 'cafes', 'cafeina', 'energizante', 'energizantes'],
  },
  {
    // Grapes and raisins: acute kidney injury in dogs, with no known safe dose.
    // Singular "pasa" is deliberately absent — it is also the verb ("si pasa
    // algo"), and a tripwire that fires on grammar gets switched off.
    hazard: 'grapes',
    severity: 'toxic',
    species: ['dog', 'cat'],
    terms: ['uva', 'uvas', 'pasas', 'pasa de uva', 'pasas de uva', 'uvas pasas', 'sultanas'],
  },
  {
    hazard: 'xylitol',
    severity: 'toxic',
    species: ['dog'],
    terms: ['xilitol', 'xylitol', 'chicle sin azucar', 'chicles sin azucar'],
  },
  {
    hazard: 'macadamia',
    severity: 'toxic',
    species: ['dog'],
    terms: ['macadamia', 'macadamias'],
  },
  {
    // "chicha" is flagged because chicha cochabambina is fermented and
    // alcoholic. "chicha morada" is not, and is the textbook false positive the
    // override exists for.
    hazard: 'alcohol',
    severity: 'toxic',
    species: ['dog', 'cat', 'rabbit'],
    terms: [
      'alcohol', 'cerveza', 'cervezas', 'vino', 'vinos', 'singani', 'chicha',
      'licor', 'licores', 'ron', 'whisky', 'pisco',
    ],
  },
  {
    hazard: 'raw-dough',
    severity: 'toxic',
    species: ['dog', 'cat'],
    terms: ['masa cruda', 'masa de pan', 'levadura'],
  },
  {
    // Persin is a serious hazard to rabbits and birds; in dogs and cats the
    // documented effect is mainly gastrointestinal. So a CAUTION, which changes
    // no default, rather than a toxic flag that would pull it from stock.
    hazard: 'avocado',
    severity: 'caution',
    species: ['dog', 'cat', 'rabbit'],
    terms: ['palta', 'paltas', 'aguacate', 'aguacates'],
  },
  {
    // Cooked bone splinters and can perforate the gut — a risk distinct from
    // raw bone, and the one a shelter boiling donated meat is producing.
    hazard: 'bones',
    severity: 'caution',
    species: ['dog', 'cat'],
    terms: [
      'hueso', 'huesos', 'con hueso', 'costilla', 'costillas', 'espinazo',
      'espinazos', 'carcasa', 'carcasas', 'osamenta', 'caracu', 'pescuezo',
      'pescuezos', 'cogote', 'cogotes', 'pata de pollo', 'patas de pollo',
      'ala de pollo', 'alas de pollo', 'cabeza de pollo', 'cabezas de pollo',
    ],
  },
  {
    // Mould can carry tremorgenic mycotoxins; this is the one hazard a volunteer
    // might write down as a description rather than as a food.
    hazard: 'spoilage',
    severity: 'toxic',
    species: ['dog', 'cat', 'rabbit'],
    terms: [
      'moho', 'mohoso', 'mohosa', 'mohosos', 'mohosas', 'podrido', 'podrida',
      'podridos', 'podridas', 'descompuesto', 'descompuesta', 'en mal estado',
      'rancio', 'rancia',
    ],
  },
];

const BEFORE = '(?<![\\p{L}\\p{N}])';
const AFTER = '(?![\\p{L}\\p{N}])';

function termPattern(term: string): RegExp {
  const body = term
    .split(' ')
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('\\s+');
  return new RegExp(`${BEFORE}${body}${AFTER}`, 'gu');
}

const COMPILED = HAZARD_RULES.map((rule) => ({
  rule,
  patterns: rule.terms.map((term) => ({ term, pattern: termPattern(term) })),
}));

/**
 * "sin cebolla" names onion to say it is ABSENT. Flagging it is the nag that
 * gets a tool switched off. Also "sin ajo ni cebolla": a "ni" counts when a
 * "sin" opened the list within the last few words.
 *
 * ⚠️ Deliberately NOT "no": "no sé si trae cebolla" says the opposite of
 * "without onion", and suppressing it would hide the one case worth a look.
 */
function isNegated(folded: string, matchStart: number): boolean {
  const before = folded.slice(0, matchStart).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const previous = before[before.length - 1];
  if (previous === 'sin') return true;
  if (previous === 'ni') return before.slice(-6, -1).includes('sin');
  return false;
}

export interface HazardFinding {
  hazard: FoodHazard;
  severity: HazardSeverity;
  /** The folded term that matched, for display next to the label. */
  term: string;
  species: readonly Species[];
}

/**
 * Every hazard mentioned in `text`, one finding per hazard, in rule order.
 *
 * @param shelterSpecies  when given, a hazard that applies to none of these
 *                        species is dropped — a dog-and-cat shelter has no use
 *                        for a rabbit-only warning.
 */
export function findFoodHazards(
  text: string | null | undefined,
  shelterSpecies: readonly Species[] | null = null
): HazardFinding[] {
  if (!text) return [];
  const folded = foldText(text);
  const findings: HazardFinding[] = [];

  for (const { rule, patterns } of COMPILED) {
    if (shelterSpecies && !rule.species.some((s) => shelterSpecies.includes(s))) continue;
    let hit: string | null = null;
    for (const { term, pattern } of patterns) {
      pattern.lastIndex = 0;
      for (const match of folded.matchAll(pattern)) {
        if (!isNegated(folded, match.index ?? 0)) {
          hit = term;
          break;
        }
      }
      if (hit) break;
    }
    if (hit) {
      findings.push({ hazard: rule.hazard, severity: rule.severity, term: hit, species: rule.species });
    }
  }
  return findings;
}

export function severityOf(hazard: FoodHazard): HazardSeverity {
  return HAZARD_RULES.find((rule) => rule.hazard === hazard)?.severity ?? 'toxic';
}

/** True when any hazard on a line is toxic, which keeps the line out of the pot by default. */
export function hasToxicHazard(hazards: readonly FoodHazard[]): boolean {
  return hazards.some((hazard) => severityOf(hazard) === 'toxic');
}

/**
 * Hazards the WHOLE description mentions that no confirmed line carries.
 *
 * This is the case §12.4 argues for: "verduras (tenían cebolla)" parsed into a
 * single "verduras" line whose food name says nothing. The line-level check
 * sees "verduras"; this one sees the sentence.
 */
export function hazardsMissingFromLines(
  rawText: string,
  lineTexts: readonly string[],
  shelterSpecies: readonly Species[] | null = null
): HazardFinding[] {
  const covered = new Set(
    lineTexts.flatMap((text) => findFoodHazards(text, shelterSpecies).map((f) => f.hazard))
  );
  return findFoodHazards(rawText, shelterSpecies).filter((f) => !covered.has(f.hazard));
}

// ─────────────────────────────────────────────────────────────────────────────
// Species relevance
// ─────────────────────────────────────────────────────────────────────────────

const SPECIES_WORDS: Record<Exclude<Species, 'other'>, readonly string[]> = {
  dog: ['perro', 'perros', 'perrito', 'perritos', 'canino', 'caninos', 'cachorro', 'cachorros', 'dog'],
  cat: ['gato', 'gatos', 'gatito', 'gatitos', 'felino', 'felinos', 'cat'],
  rabbit: ['conejo', 'conejos', 'conejito', 'conejitos'],
};

/**
 * Which species a food is for when the text does NOT say.
 *
 * Meat and offal suit both dogs and cats. Grain, vegetables and bone are pot
 * food: cats are obligate carnivores and are not fed rice soup. Kibble and wet
 * food are EMPTY on purpose — dog food lacks what a cat needs (taurine above
 * all), so "croquetas" with no species is a question, not a default.
 */
const CATEGORY_DEFAULT_SPECIES: Record<FoodCategory, readonly Species[]> = {
  meat: ['dog', 'cat'],
  offal: ['dog', 'cat'],
  bone: ['dog'],
  grain: ['dog'],
  vegetable: ['dog'],
  kibble: [],
  'wet-food': [],
  other: [],
};

export type SpeciesRelevance =
  | { stated: true; species: Species[] }
  | { stated: false; species: Species[]; needsAnswer: boolean };

/**
 * Who a food is for, recorded per line.
 *
 * `needsAnswer` is true for kibble and wet food whose text names no species:
 * the one case where the default would be a guess with a nutritional cost.
 */
export function speciesRelevance(
  category: FoodCategory,
  text: string | null | undefined
): SpeciesRelevance {
  const folded = foldText(text ?? '');
  const stated = (Object.keys(SPECIES_WORDS) as (keyof typeof SPECIES_WORDS)[]).filter((species) =>
    SPECIES_WORDS[species].some((word) => termPattern(word).test(folded))
  );
  if (stated.length > 0) return { stated: true, species: stated };
  const species = [...CATEGORY_DEFAULT_SPECIES[category]];
  return { stated: false, species, needsAnswer: species.length === 0 && (category === 'kibble' || category === 'wet-food') };
}

// ─────────────────────────────────────────────────────────────────────────────
// Expiry
// ─────────────────────────────────────────────────────────────────────────────

export type ExpiryParse =
  | { kind: 'none' }
  /** Local midday, like `parseDateInput`, so no timezone can move the day. */
  | { kind: 'ok'; at: number }
  /** "20/10" — a day and month with no year. Never guessed: see below. */
  | { kind: 'no-year'; day: number; month: number }
  | { kind: 'invalid' };

/**
 * An expiry date as printed or said: "20/10/2026", "20-10-26", "20.10.2026".
 *
 * Day first, always — Bolivia writes day/month, and a US-order reading of
 * "05/10" is a date five months off.
 *
 * ⚠️ A date with no year is NOT completed. "vence 01/09" received on
 * 12 September is either eleven days expired or good for a year, and the
 * difference is whether meat goes in the pot. The UI asks for the date instead.
 */
export function parseExpiryText(text: string | null | undefined): ExpiryParse {
  if (!text || text.trim() === '') return { kind: 'none' };
  const match = /(\d{1,2})\s*[/.-]\s*(\d{1,2})(?:\s*[/.-]\s*(\d{2}|\d{4}))?(?!\d)/.exec(text);
  if (!match) return { kind: 'invalid' };

  const day = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return { kind: 'invalid' };
  if (match[3] === undefined) return { kind: 'no-year', day, month };

  const year = match[3].length === 2 ? 2000 + Number(match[3]) : Number(match[3]);
  const date = new Date(year, month - 1, day, 12, 0, 0);
  // 31/02 rolls over to March in JavaScript. Refuse it rather than store March.
  if (date.getMonth() !== month - 1 || date.getDate() !== day) return { kind: 'invalid' };
  return { kind: 'ok', at: date.getTime() };
}

/** Food arriving this close to its date warns. */
export const EXPIRES_SOON_DAYS = 3;

const DAY_MS = 86_400_000;

export type ExpiryWarning = 'expired' | 'expires-soon';

/**
 * Warn, never block. Expired kibble a week past its best-before date is often
 * still food, expired meat is not, and the person holding the bag can smell
 * which one this is. Both dates are compared by CALENDAR DAY, because an expiry
 * printed on a bag has no time of day.
 */
export function expiryWarning(expiresAt: number | null, receivedAt: number): ExpiryWarning | null {
  if (expiresAt === null) return null;
  const expiryDay = calendarDay(expiresAt);
  const receivedDay = calendarDay(receivedAt);
  if (expiryDay < receivedDay) return 'expired';
  if (expiryDay - receivedDay <= EXPIRES_SOON_DAYS) return 'expires-soon';
  return null;
}

function calendarDay(ms: number): number {
  const d = new Date(ms);
  return Math.round(new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12).getTime() / DAY_MS);
}
