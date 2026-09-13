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
import type { FoodCategory, FoodHazard } from '@/lib/types';
import type { DonationError, DonationLineError } from '@/lib/food-parse';
import type { StockMovementError } from '@/lib/food-stock';
import type { EnergyStage } from '@/lib/rations';
import type { FoodParseFailure } from '@/lib/food-parse-client';
import type { FoodCopy } from './messages';
import type { StockEntryKind } from '@/lib/types';

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

// ── food ────────────────────────────────────────────────────────────────────

const FOOD_CATEGORY: Record<FoodCategory, string> = {
  meat: 'Carne',
  offal: 'Menudencia',
  bone: 'Hueso',
  grain: 'Cereales y granos',
  vegetable: 'Verduras',
  kibble: 'Croquetas',
  'wet-food': 'Comida húmeda',
  other: 'Otros',
};

const FOOD_HAZARD: Record<FoodHazard, string> = {
  allium: 'Cebolla, ajo o puerro',
  chocolate: 'Chocolate',
  caffeine: 'Café o cafeína',
  grapes: 'Uvas o pasas',
  xylitol: 'Xilitol',
  macadamia: 'Nuez de macadamia',
  alcohol: 'Alcohol',
  'raw-dough': 'Masa cruda',
  avocado: 'Palta',
  bones: 'Hueso',
  spoilage: 'Moho o mal estado',
};

/**
 * ⚠️ Each one says what the hazard does, in one sentence, and stops. None
 * says what to feed instead — plan §12.4 keeps nutritional advice out of this
 * system — and none refuses anything.
 */
const FOOD_HAZARD_ADVICE: Record<FoodHazard, string> = {
  allium: 'Es tóxico para perros y gatos aunque esté cocido: daña los glóbulos rojos.',
  chocolate: 'Es tóxico para perros y gatos.',
  caffeine: 'La cafeína es tóxica para perros y gatos.',
  grapes: 'En perros pueden dañar los riñones, incluso en poca cantidad.',
  xylitol: 'Es muy tóxico para perros, aun en cantidades pequeñas.',
  macadamia: 'Es tóxica para perros.',
  alcohol: 'Es tóxico para perros y gatos.',
  'raw-dough': 'La masa cruda sigue fermentando en el estómago.',
  avocado: 'En perros y gatos puede causar malestar digestivo; en conejos es tóxica.',
  bones: 'Hay que deshuesar antes de servir: el hueso cocido se astilla.',
  spoilage: 'La comida con moho puede tener toxinas, y cocinarla no la vuelve segura.',
};

/** Grams per market unit, as `food-quantity.ts` converts them, for the note. */
const TRADITIONAL_UNIT_NOTE: Record<'libra' | 'arroba' | 'quintal', string> = {
  libra: '1 libra = 460 g',
  arroba: '1 arroba = 11,5 kg',
  quintal: '1 quintal = 46 kg',
};

const DONATION_ERROR: Record<DonationError, string> = {
  'received-required': 'Falta la fecha en que llegó la donación.',
  'received-in-future': 'Esa fecha todavía no llegó. Revisa el día.',
  'lines-required': 'Agrega al menos un alimento.',
  'too-many-lines': 'Son demasiadas líneas para una donación. Divídela en dos.',
  'text-too-long': 'El texto es muy largo. Usa como máximo 2000 caracteres.',
  'lines-invalid': 'Revisa las líneas marcadas antes de guardar.',
};

const DONATION_LINE_ERROR: Record<DonationLineError, string> = {
  'food-required': 'Escribe qué alimento es.',
  'category-required': 'Elige una categoría para que sume al stock.',
  'mass-required':
    'Sin peso no se puede sumar al stock. Pésalo y anota los kilos, o marca que no suma al stock.',
  'quantity-required': 'Anota la cantidad, por ejemplo «2 kg» o «3 bolsas de 5 kg».',
  'quantity-unreadable':
    'No se entiende la cantidad. Escríbela así: «2 kg», «medio kilo» o «3 bolsas de 5 kg».',
  'quantity-ambiguous':
    'Hay más de una cantidad en esta línea. Deja una sola cantidad por alimento y agrega otra línea para el resto.',
  'quantity-too-precise':
    'Usa como máximo dos decimales. Con tres no se sabe si «1.500» es un kilo y medio o mil quinientos.',
  'quantity-not-positive': 'La cantidad tiene que ser mayor que cero.',
  'quantity-too-heavy': 'Más de dos toneladas en una sola línea no parece posible. Revisa la cantidad.',
};

const STOCK_MOVEMENT_ERROR: Record<StockMovementError, string> = {
  'category-required': 'Elige la categoría.',
  'label-required': 'Escribe qué es, por ejemplo «arroz con gorgojo».',
  'quantity-required': 'Anota los kilos.',
  'quantity-invalid': 'Los kilos tienen que ser un número, por ejemplo 2,5.',
  'quantity-too-precise':
    'Usa como máximo dos decimales. Con tres no se sabe si «1.500» es un kilo y medio o mil quinientos.',
  'quantity-not-positive': 'Los kilos tienen que ser más que cero.',
  'quantity-too-heavy': 'Más de dos toneladas no parece posible. Revisa la cantidad.',
  'occurred-required': 'Falta la fecha.',
  'occurred-in-future': 'Esa fecha todavía no llegó. Revisa el día.',
  'correction-reason-required':
    'Una corrección necesita un motivo, por ejemplo «conteo del sábado». Es lo único que explica el cambio.',
};

const ENERGY_STAGE: Record<EnergyStage, string> = {
  'puppy-early': 'cachorro de menos de 4 meses',
  'puppy-late': 'cachorro de 4 a 12 meses',
  'adult-dog': 'perro adulto',
  kitten: 'gatito',
  'adult-cat': 'gato adulto',
};

const FOOD_PARSE_FAILURE: Record<FoodParseFailure, string> = {
  'not-configured': 'La lectura automática no está configurada. Agrega las líneas a mano.',
  unauthorized: 'Tu sesión no tiene permiso para esto. Cierra sesión y vuelve a entrar.',
  'text-rejected': 'El texto está vacío o es demasiado largo.',
  timeout: 'La lectura automática tardó demasiado. Intenta de nuevo, o agrega las líneas a mano.',
  failed: 'No pudimos leer el texto automáticamente. Agrega las líneas a mano.',
};

const STOCK_ENTRY_KIND: Record<StockEntryKind, string> = {
  donation: 'Donación',
  cook: 'Olla',
  discard: 'Descarte',
  correction: 'Corrección',
};

const FOOD_COPY: FoodCopy = {
  navLabel: 'Comida',
  title: 'Comida del refugio',
  sub: 'Donaciones, despensa, la olla y las raciones del día.',
  backToPanel: 'Volver al panel',
  tabDonation: 'Donación',
  tabStock: 'Despensa',
  tabCook: 'Olla',
  tabRations: 'Raciones',
  loading: 'Cargando…',
  loadFailed: 'No pudimos cargar esta sección. Revisa tu conexión e inténtalo de nuevo.',
  permissionDenied:
    'Firestore rechazó la lectura por permisos. Si te acaban de dar acceso, cierra sesión y vuelve a entrar.',
  saveFailed: 'No pudimos guardar. Revisa tu conexión e inténtalo de nuevo.',
  cancel: 'Cancelar',
  remove: 'Quitar',
  chooseCategory: 'Elegir…',

  donationTextLabel: 'Qué llegó',
  donationTextHint:
    'Escríbelo como lo dirías, por ejemplo «3 bolsas de arroz de 5 kg, 2 kg de hígado». Puedes leerlo automáticamente o agregar las líneas a mano.',
  parseButton: 'Leer el texto',
  parsing: 'Leyendo…',
  addLine: 'Agregar línea',
  receivedLabel: 'Fecha en que llegó',
  donorLabel: 'Quién la trajo (opcional)',
  notesLabel: 'Nota (opcional)',
  lineFood: 'Alimento',
  lineCategory: 'Categoría',
  lineQuantity: 'Cantidad',
  lineMassKg: 'Kilos en la balanza (opcional)',
  lineExpiry: 'Vence (opcional)',
  lineInStock: 'Suma al stock de la olla',
  fromText: 'Del texto:',
  missingHazardsTitle: 'El texto menciona algo que ninguna línea recoge:',
  reviewNote: 'Revisa cada línea antes de guardar. Nada cambia la despensa hasta que guardes.',
  saveDonation: 'Guardar donación',
  savedDonation: 'Donación guardada.',
  recentDonations: 'Últimas donaciones',
  noDonations: 'Todavía no hay donaciones registradas.',
  parsedByModel: 'Leída automáticamente y revisada',
  typedByHand: 'Anotada a mano',

  stockTitle: 'Lo que hay en la despensa',
  stockHint:
    'Es la suma de todo lo que entró y salió. Si no coincide con el estante, registra una corrección con su motivo.',
  stockEmpty: 'nada anotado',
  stockNegative: 'Figura en negativo: puede faltar anotar una donación.',
  movementOpen: 'Registrar descarte o corrección',
  movementKind: 'Tipo',
  directionLabel: 'Cambio',
  directionAdd: 'Suma a la despensa',
  directionRemove: 'Resta de la despensa',
  movementLabel: 'Qué es',
  movementKg: 'Kilos',
  movementDate: 'Fecha',
  movementNote: 'Motivo',
  saveMovement: 'Guardar movimiento',

  cookOpen: 'Registrar una olla',
  cookHint: 'Pesa lo que entra crudo. El peso cocido y los cucharones se pueden anotar después.',
  cookedAtLabel: 'Fecha',
  inputsTitle: 'Ingredientes, en crudo',
  inputLabel: 'Qué es',
  inputKg: 'Kilos crudos',
  addInput: 'Agregar ingrediente',
  toxicAck: 'Lo revisé y va igual a la olla',
  potFillLabel: 'Hasta dónde se llenó la olla',
  notLooked: 'Sin mirar',
  cookedKgLabel: 'Peso cocido, en kilos (opcional)',
  ladlesLabel: 'Cucharones servidos (opcional)',
  dogsServedLabel: 'Perros servidos (opcional)',
  cookedByLabel: 'Quién cocinó (opcional)',
  saveCook: 'Guardar olla',
  recentBatches: 'Ollas anteriores',
  noBatches: 'Todavía no hay ollas registradas.',
  editOutcome: 'Anotar resultado',
  saveOutcome: 'Guardar resultado',
  calibrationTitle: 'Lo que midieron las ollas',
  yieldTitle: 'Cucharones que rinde',

  rationsTitle: 'Raciones de hoy',
  rationsHint:
    'Al lado de cada animalito, lo que sugiere el estándar veterinario (energía en reposo = 70 × kg elevado a 0,75, por un factor de etapa de vida). Es una referencia: no cambia ninguna ración por sí solo.',
  noAnimals: 'No hay animalitos en el refugio ahora.',
  ladlesToday: 'Cucharones hoy',
  adjustedReason: 'Por qué distinto (opcional)',
  dogsPresentLabel: 'Perros presentes (opcional)',
  dogsPresentInvalid: 'Los perros presentes tienen que ser un número entero.',
  shortfallLabel: 'Si faltó comida, anótalo (opcional)',
  saveDay: 'Guardar el día',
  savedDay: 'Día guardado.',
  sharesTitle: 'Cómo se reparte la olla',
  sharesHint:
    'Compara la parte de la olla que recibe cada perro con los cucharones anotados y la parte que le toca según el estándar. No depende de qué haya en la olla, porque todos comen de la misma.',
  sharesNeedTwo:
    'Para comparar hacen falta al menos dos perros con peso medido y cucharones anotados.',
  notFromPot: 'No come de la olla: el valor es solo de referencia.',
  servingInvalid: 'Usa cucharones enteros o medios, hasta 20.',
  measurementsFailed: 'No pudimos leer su peso. No se muestra ninguna ración.',
};

function percent(share: number): string {
  return `${Math.round(share * 100)} %`;
}

function ratioNumber(value: number): string {
  return value.toLocaleString('es-BO', { maximumFractionDigits: 2 });
}

/** "cebolla, ajo o puerro y uvas o pasas" — hazard labels joined for a sentence. */
function hazardList(hazards: readonly FoodHazard[]): string {
  const labels = hazards.map((h) => FOOD_HAZARD[h]);
  if (labels.length <= 1) return labels[0] ?? '';
  return `${labels.slice(0, -1).join(', ')} y ${labels[labels.length - 1]}`;
}

function hazardAdvice(hazards: readonly FoodHazard[]): string {
  return hazards.map((h) => FOOD_HAZARD_ADVICE[h]).join(' ');
}

function gramsText(grams: number): string {
  const sign = grams < 0 ? '−' : '';
  const abs = Math.abs(grams);
  return abs < 1000 ? `${sign}${abs} g` : `${sign}${kgNumber(abs / 1000)} kg`;
}

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

  foodCategoryLabel: (category) => FOOD_CATEGORY[category],

  foodHazardLabel: (hazard) => FOOD_HAZARD[hazard],

  foodHazardAdvice: (hazard) => FOOD_HAZARD_ADVICE[hazard],

  formatGrams: (grams) => gramsText(grams),

  donationError: (error) => DONATION_ERROR[error],

  donationLineError: (error) => DONATION_LINE_ERROR[error],

  donationLineWarning(warning) {
    switch (warning.kind) {
      case 'toxic-excluded':
        return `${hazardList(warning.hazards)}: queda anotado pero NO suma al stock de la olla. ${hazardAdvice(warning.hazards)} Si la lectura se equivocó, márcalo para sumarlo.`;
      case 'toxic-included':
        return `Marcaste esta línea para sumar al stock aunque tiene ${hazardList(warning.hazards).toLowerCase()}. ${hazardAdvice(warning.hazards)}`;
      case 'caution':
        return hazardAdvice(warning.hazards);
      case 'traditional-unit':
        return warning.unit === 'libra' || warning.unit === 'arroba' || warning.unit === 'quintal'
          ? `Convertido a kilos con la medida del mercado: ${TRADITIONAL_UNIT_NOTE[warning.unit]}.`
          : 'Convertido a kilos.';
      case 'unusually-heavy':
        return `Son ${gramsText(warning.grams)} en una sola línea. Revisa que la cantidad esté bien.`;
      case 'expired':
        return 'Ya estaba vencido cuando llegó.';
      case 'expires-soon':
        return 'Vence en los próximos 3 días.';
      case 'expiry-no-year':
        return `Dice «${warning.text}» pero sin año. Elige la fecha para no adivinarla.`;
      case 'species-unstated':
        return 'No dice si es para perro o para gato. La comida de perro no cubre lo que necesita un gato.';
      case 'not-in-text':
        return 'Esta línea no aparece en el texto que escribiste. Revísala antes de sumarla al stock.';
      case 'low-confidence':
        return 'La lectura automática no está segura de esta línea.';
      case 'not-stocked':
        return 'Queda anotada, pero no suma al stock.';
    }
  },

  stockMovementError: (error) => STOCK_MOVEMENT_ERROR[error],

  cookBatchError(error) {
    switch (error.kind) {
      case 'cooked-required':
        return 'Falta la fecha de la cocción.';
      case 'cooked-in-future':
        return 'Esa fecha todavía no llegó. Revisa el día.';
      case 'inputs-required':
        return 'Anota entre 1 y 20 ingredientes.';
      case 'input-category-required':
        return `Ingrediente ${error.index + 1}: elige la categoría.`;
      case 'input-label-required':
        return `Ingrediente ${error.index + 1}: escribe qué es.`;
      case 'input-quantity':
        return `Ingrediente ${error.index + 1}: ${STOCK_MOVEMENT_ERROR[error.error]}`;
      case 'input-toxic-unacknowledged':
        return `Ingrediente ${error.index + 1}: ${hazardList(error.hazards)}. ${hazardAdvice(error.hazards)} Para guardar, confirma que lo revisaste.`;
      case 'pot-fill-invalid':
        return 'El nivel de la olla no es válido.';
      case 'cooked-weight-invalid':
        return 'El peso cocido tiene que ser un número de kilos, por ejemplo 31,5.';
      case 'ladles-invalid':
        return 'Los cucharones tienen que ser un número mayor que cero; se permiten medios.';
      case 'dogs-served-invalid':
        return 'Los perros servidos tienen que ser un número entero mayor que cero.';
    }
  },

  cookBatchWarning(warning) {
    if (warning.kind === 'input-caution') {
      return `Ingrediente ${warning.index + 1}: ${hazardAdvice(warning.hazards)}`;
    }
    return `Ingrediente ${warning.index + 1}: el stock anotado de ${FOOD_CATEGORY[warning.category].toLowerCase()} es ${gramsText(warning.stockGrams)}. Si hay más en la despensa, puede faltar anotar una donación.`;
  },

  yieldEstimateText(estimate) {
    switch (estimate.kind) {
      case 'no-kitchen-constants':
        return 'No se muestra cuántos cucharones rinde la olla: todavía no están medidas la olla ni el cucharón del refugio, y sin esas medidas cualquier número sería inventado.';
      case 'no-fill-level':
        return 'Elige hasta dónde se llenó la olla para estimar los cucharones.';
      case 'calibrating':
        return `Aún calibrando: hacen falta ${estimate.needed} cocciones con el nivel de la olla y los cucharones contados, y hay ${estimate.n}.`;
      case 'ok':
        return `Rinde unos ${estimate.ladles} cucharones, según ${estimate.n} cocciones medidas.`;
    }
  },

  energyStageLabel: (stage) => ENERGY_STAGE[stage],

  bodyConditionSuggestionText(suggestion) {
    const when = suggestion.days <= 0 ? 'hoy' : suggestion.days === 1 ? 'ayer' : `hace ${suggestion.days} días`;
    return suggestion.kind === 'reduce-and-rescore'
      ? `Sugerencia: condición corporal ${suggestion.bcs} (evaluada ${when}). Se podría reducir un poco la ración y volver a evaluar en unas 4 semanas.`
      : `Sugerencia: condición corporal ${suggestion.bcs} (evaluada ${when}). Antes de aumentar la ración, conviene que el veterinario descarte parásitos o enfermedad.`;
  },

  foodParseFailure: (failure) => FOOD_PARSE_FAILURE[failure],

  food: FOOD_COPY,

  stockEntryKindLabel: (kind) => STOCK_ENTRY_KIND[kind],

  formatKcal: (kcal) => `${Math.round(kcal).toLocaleString('es-BO')} kcal`,

  potFillLabel: (level) => percent(level),

  rationSummary(result) {
    switch (result.kind) {
      case 'not-applicable':
        return 'El cálculo de energía no aplica a esta especie.';
      case 'no-weight':
        // Never a kilocalorie figure here — see the note in messages.ts.
        return result.estimate
          ? `Falta pesar. Las fotos de ingreso estimaron ${this.formatKgRange(result.estimate.minKg, result.estimate.maxKg)}, pero esa estimación no se usa para calcular raciones.`
          : 'Falta pesar: sin un peso medido no se calcula ninguna ración.';
      case 'implausible-weight':
        return `El último peso anotado (${this.formatKg(result.weight.kg)}) no es posible. Corrígelo en su ficha.`;
      case 'age-unknown':
        return `Peso ${this.formatKg(result.weight.kg)}, ${this.daysAgoLabel(result.weightDays)}. Energía en reposo ${this.formatKcal(result.rerKcal)} al día. Sin edad no se puede elegir el factor de etapa de vida.`;
      case 'ok': {
        const range =
          Math.round(result.merMinKcal) === Math.round(result.merMaxKcal)
            ? this.formatKcal(result.merMinKcal)
            : `${Math.round(result.merMinKcal).toLocaleString('es-BO')}–${this.formatKcal(result.merMaxKcal)}`;
        const stages = result.stages.map((stage) => ENERGY_STAGE[stage]).join(' o ');
        const stale = result.staleForGrowth
          ? ' Está creciendo y el peso tiene más de 30 días: conviene volver a pesarlo.'
          : '';
        return `Peso ${this.formatKg(result.weight.kg)}, ${this.daysAgoLabel(result.weightDays)}. El estándar sugiere ${range} al día (${stages}).${stale}`;
      }
    }
  },

  potShareText(row) {
    const base = `Según el estándar le toca ${percent(row.standardShare)} de la olla; con lo anotado recibe ${percent(row.recordedShare)}.`;
    if (row.divergence === 'under') return `${base} Recibe bastante menos de lo que sugiere el estándar.`;
    if (row.divergence === 'over') return `${base} Recibe bastante más de lo que sugiere el estándar.`;
    return base;
  },

  measuredRatioText(measure, ratio) {
    const name = measure === 'cooked-to-raw' ? 'Peso cocido entre peso crudo' : 'Gramos por cucharón';
    if (ratio === null) {
      return measure === 'cooked-to-raw'
        ? `${name}: todavía no hay ollas con los dos pesos anotados.`
        : `${name}: todavía no hay ollas con el peso cocido y los cucharones anotados.`;
    }
    const n = `${ratio.n} ${ratio.n === 1 ? 'olla' : 'ollas'}`;
    const spread = ratio.n > 1 ? ` (entre ${ratioNumber(ratio.min)} y ${ratioNumber(ratio.max)})` : '';
    return `${name}: ${ratioNumber(ratio.median)}${spread}, medido en ${n}.`;
  },
};
