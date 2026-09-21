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
import type { AuthError } from '@/lib/auth-errors';
import type { AuthEmailCopy } from '@/lib/auth-config';
import { PASSWORD_MIN_LENGTH } from '@/lib/profile';
import { SHELTER } from '@/config/shelter';
import type { AccountCopy } from './messages';
import type { IntakeError } from '@/lib/intake';
import type { ApplicationStatus } from '@/lib/types';
import type {
  ApplicationAnswerError,
  ApprovalBlocker,
  ApprovalWarning,
} from '@/lib/applications';
import type { ApplicationSection } from '@/config/shelter';
import type { ApplicationCopy } from './messages';

// ─────────────────────────────────────────────────────────────────────────────
// Online adoption applications — plan §6
// ─────────────────────────────────────────────────────────────────────────────

/** What the SHELTER calls each status, on the queue. */
const APPLICATION_STATUS: Record<ApplicationStatus, string> = {
  submitted: 'Nueva',
  reviewing: 'En revisión',
  interview: 'Entrevista',
  approved: 'Aprobada',
  rejected: 'Rechazada',
  withdrawn: 'Retirada',
};

/**
 * What the APPLICANT sees. Only `rejected` differs, and only in tone: a family
 * turned down reads «No aprobada» on their own account page, which says the
 * same thing without the word a person hears as a verdict on them.
 */
const APPLICANT_STATUS: Record<ApplicationStatus, string> = {
  submitted: 'Enviada',
  reviewing: 'En revisión',
  interview: 'Entrevista',
  approved: 'Aprobada',
  rejected: 'No aprobada',
  withdrawn: 'Retirada',
};

/**
 * ⚠️ Each line must be true. The shelter reviews by hand, nothing is sent
 * automatically, and WhatsApp is where a conversation actually happens — so
 * every status that needs the applicant to do something points them there.
 */
const APPLICANT_STATUS_EXPLANATION: Record<ApplicationStatus, string> = {
  submitted:
    'El equipo todavía no la revisa. Lo hacen a mano, así que puede tomar unos días.',
  reviewing: 'Alguien del equipo la está leyendo.',
  interview:
    'El equipo quiere conversar contigo. Si todavía no te escribieron, escríbeles por WhatsApp.',
  approved: 'La adopción quedó registrada. Gracias por darle un hogar.',
  rejected:
    'Esta vez la solicitud no fue aprobada. Si quieres saber por qué, escríbele al equipo por WhatsApp.',
  withdrawn: 'Esta solicitud se retiró.',
};

const APPLICATION_SECTION: Record<ApplicationSection, string> = {
  contact: 'Contacto',
  housing: 'Vivienda',
  household: 'Quiénes viven en la casa',
  otherPets: 'Otros animales',
  experience: 'Experiencia',
  why: 'Por qué este animalito',
};

const APPLICATION_ANSWER_ERROR: Record<ApplicationAnswerError, string> = {
  required: 'Esta pregunta es obligatoria.',
  'too-long': 'La respuesta es muy larga. Resúmela un poco.',
  'phone-invalid': 'Escribe un número de teléfono, con o sin el +591.',
  'count-invalid': 'Escribe un número entero, sin decimales.',
  'choice-invalid': 'Elige una de las opciones.',
};

/**
 * ⚠️ These BLOCK, so each one says why the state is unsafe and what to do
 * instead — never just "no".
 */
const APPROVAL_BLOCKER: Record<ApprovalBlocker, string> = {
  'application-not-approvable':
    'Solo se puede aprobar una solicitud que está en revisión o en entrevista. Pásala primero a revisión.',
  'pet-missing': 'La ficha de este animalito ya no existe.',
  'pet-already-adopted':
    'Este animalito ya figura como adoptado. Aprobar ahora le daría su microchip y su historial a una segunda familia. Si volvió al refugio, regístralo primero como reingreso.',
  'pet-not-ready':
    'Este animalito todavía no puede pasar a adoptado: está en camino, en cuarentena o su rescate se canceló. Primero tiene que llegar y tener el alta.',
};

const APPLICATION_COPY: ApplicationCopy = {
  applyLink: 'Postular en línea →',

  pageTitle: (petName) => `Postular para adoptar a ${petName}`,
  intro: (petName) =>
    `Esta solicitud es opcional. Si prefieres, escríbenos por WhatsApp: es el camino más rápido para conocer a ${petName}.`,
  whatsappInstead: 'Escribir por WhatsApp',
  privacy: (shelterName) =>
    `Tus respuestas solo las ve el equipo de ${shelterName}. Nunca se publican.`,
  signInPrompt:
    'Para postular en línea necesitas una cuenta. Entra o crea una y vuelves directo a este formulario.',
  signInButton: 'Entrar o crear cuenta',
  returnNotice: 'Cuando entres, vuelves directo al formulario de adopción.',
  continueApplication: 'Volver al formulario de adopción',
  loading: 'Cargando…',
  retry: 'Intentar de nuevo',
  notAccepting: (petName) =>
    `${petName} no está recibiendo solicitudes en línea en este momento. Si quieres saber más, escríbenos por WhatsApp.`,
  alreadyApplied: 'Ya enviaste una solicitud para este animalito.',
  goToAccount: 'Ver mis solicitudes',
  requiredMark: 'obligatoria',
  optionalMark: 'opcional',
  choosePlaceholder: 'Elige…',
  fixErrors: 'Revisa las preguntas marcadas antes de enviar.',
  submit: 'Enviar solicitud',
  submitting: 'Enviando…',
  submitFailed:
    'No pudimos enviar la solicitud. Revisa tu conexión e intenta de nuevo: tus respuestas siguen aquí.',
  submitRefused:
    'No pudimos guardar la solicitud. Puede que este animalito ya no esté disponible o que ya hayas postulado. Revisa «Mi cuenta».',
  confirmationTitle: 'Recibimos tu solicitud',
  confirmationSteps: (petName, shelterName) => [
    `El equipo de ${shelterName} revisa cada solicitud a mano. Puede tomar unos días.`,
    'Nadie te va a responder por esta página ni por correo. Si quieren conversar contigo, te escriben por WhatsApp al número que dejaste.',
    `Enviar la solicitud no reserva a ${petName}. Si tienes apuro o dudas, escríbeles por WhatsApp.`,
    'Puedes ver en qué estado está tu solicitud en «Mi cuenta».',
  ],
  backToPet: (petName) => `← Volver a ${petName}`,

  mine: 'Mis solicitudes de adopción',
  unknownPet: 'Animalito sin ficha pública',
  withdraw: 'Retirar solicitud',
  withdrawQuestion:
    'Si la retiras, no vas a poder volver a postular en línea para este animalito. ¿La retiras?',
  withdrawConfirm: 'Sí, retirarla',
  keep: 'No, mantenerla',
  withdrawFailed: 'No pudimos retirar la solicitud. Revisa tu conexión e intenta de nuevo.',
  loadFailed: 'No pudimos cargar tus solicitudes. Revisa tu conexión e intenta de nuevo.',

  queueLink: 'Solicitudes',
  queueTitle: 'Solicitudes de adopción',
  queueIntro:
    'Agrupadas por animalito, la más antigua primero. Nada de lo que hagas aquí le envía un mensaje a nadie: a cada persona avísale tú por WhatsApp.',
  formStateNote(enabled, questionsAreDraft) {
    if (questionsAreDraft) {
      return 'Las preguntas del formulario todavía son un BORRADOR que no escribió el refugio. El formulario público está apagado hasta que se reemplacen por las preguntas reales.';
    }
    return enabled ? null : 'El formulario público está apagado: nadie puede postular en línea.';
  },
  filterLabel: 'Mostrar',
  filterOpen: 'Abiertas',
  filterAll: 'Todas',
  emptyQueue: 'No hay solicitudes con este filtro.',
  submittedOn: (date) => `Enviada el ${date}`,
  emailUnverifiedTag: 'correo sin verificar',
  backToQueue: '← Solicitudes',
  internalRecord: 'Ficha interna',
  applicantTitle: 'Quién postula',
  answersTitle: 'Respuestas',
  notAnswered: 'Sin responder',
  retiredQuestion: (id) => `Pregunta que ya no está en el formulario (${id})`,
  notesTitle: 'Notas internas',
  notesHint: 'Solo las ve el equipo del refugio. Quien postuló nunca las ve.',
  saveNotes: 'Guardar notas',
  notesSaved: 'Notas guardadas.',
  notesFailed: 'No pudimos guardar las notas. Revisa tu conexión e intenta de nuevo.',
  actionsTitle: 'Qué hacer con esta solicitud',
  noActions: 'Esta solicitud ya está cerrada.',
  approveTitle: 'Aprobar la adopción',
  approveExplain: (petName, applicant) =>
    `Al aprobar, ${petName} pasa a «Adoptado» y ${applicant} queda como responsable: va a poder ver su microchip, su historial de custodia y la ubicación que tenga registrada. Hazlo el día que ${petName} se va con su familia. No se envía ningún mensaje automático.`,
  approveConfirm: 'Sí, aprobar',
  cancel: 'Cancelar',
  approvedDone: (petName) => `Adopción registrada. El estado de ${petName} ahora es «Adoptado».`,
  actionFailed: 'No pudimos guardar el cambio. Revisa tu conexión e intenta de nuevo.',
  actionRefused:
    'Firestore rechazó el cambio. Puede que alguien más la haya cambiado mientras tanto: recarga la página.',
  otherOpenTitle: 'Otras solicitudes abiertas para este animalito',
  applicationMissing: 'Esa solicitud no existe.',
  backToPanel: '← Panel',
  statusTitle: 'Estado',
  decidedByOn: (who, date) => `Decidida por ${who} el ${date}.`,
  withdrawnOn: (date) => `Retirada el ${date}.`,
  emailLabel: 'Correo',
  phoneLabel: 'Teléfono',
  confirmRecordWithdrawal:
    'Esto la cierra para siempre: la persona no va a poder volver a postular en línea para este animalito. ¿Registrar que la retiró?',
  adminLoadFailed: 'No pudimos cargar las solicitudes. Revisa tu conexión e intenta de nuevo.',
  permissionDenied:
    'Firestore rechazó la lectura por permisos. Si te acaban de dar acceso, cierra sesión y vuelve a entrar.',
  blockersTitle: 'No se puede aprobar',
  warningsTitle: 'Antes de aprobar',
  checking: 'Revisando…',
};

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
  'email-in-use':
    'Ya existe una cuenta con ese correo. Inicia sesión (con tu contraseña o con Google) o recupera tu contraseña.',
  'weak-password': `La contraseña es muy corta. Usa al menos ${PASSWORD_MIN_LENGTH} caracteres.`,
  'user-disabled': 'Esta cuenta está desactivada. Escríbenos por WhatsApp y lo revisamos.',
  'too-many-requests':
    'Demasiados intentos seguidos. Espera unos minutos antes de volver a probar.',
  network: 'No pudimos conectarnos. Revisa tu internet e intenta de nuevo.',
  'provider-disabled': 'Esa forma de entrar no está habilitada en este momento.',
  'captcha-failed': 'No pudimos confirmar que eres una persona. Recarga la página e intenta de nuevo.',
  'popup-blocked':
    'Tu navegador bloqueó la ventana de Google. Permite las ventanas emergentes para este sitio e intenta de nuevo.',
  'account-exists-with-different-credential':
    'Ya existe una cuenta con ese correo. Entra con tu correo y contraseña, y después conecta Google desde «Mi cuenta».',
  'credential-already-in-use': 'Esa cuenta de Google ya está conectada a otra cuenta de este sitio.',
  'provider-already-linked': 'Google ya está conectado a tu cuenta.',
  'requires-recent-login': 'Por seguridad, confirma que eres tú y vuelve a intentarlo.',
  'user-mismatch': 'Esa no es la cuenta con la que entraste. Confirma con la misma cuenta.',
  'unauthorized-domain': `Desde esta dirección no se puede entrar con Google. Entra desde ${new URL(SHELTER.siteUrl).host}.`,
  'browser-unsupported': 'Este navegador no permite iniciar sesión así. Abre la página en Chrome o Safari.',
  'session-expired': 'Tu sesión venció. Vuelve a iniciar sesión.',
  'action-code-invalid': 'Este enlace ya no sirve: puede que ya lo hayas usado. Pide uno nuevo.',
  'action-code-expired': 'Este enlace venció. Pide uno nuevo.',
  unknown: 'Algo salió mal. Intenta de nuevo en un momento.',
};

/**
 * `/account` and `/account/action`.
 *
 * ⚠️ Neutral Spanish, tuteo: "Escribe", "Revisa", never "Escribí", "Revisá".
 * `account-copy.test.ts` runs the voseo tripwire over every string here.
 */
const ACCOUNT_COPY: AccountCopy = {
  signInTitle: 'Iniciar sesión',
  signUpTitle: 'Crear una cuenta',
  resetTitle: 'Recuperar contraseña',
  signInIntro: 'Entra para ver la historia completa de cada animalito.',
  signUpIntro:
    'Con una cuenta puedes ver la historia completa de cada animalito, sus fotos, su historial médico y su plan de alimentación.',
  resetIntro: 'Escribe tu correo y te enviamos un enlace para crear una contraseña nueva.',
  signInSubmit: 'Entrar',
  signUpSubmit: 'Crear cuenta',
  resetSubmit: 'Enviar enlace',
  working: 'Un momento…',
  loading: 'Cargando…',
  nameLabel: 'Tu nombre',
  nameHint: 'Así te saludamos y así te ve el equipo del refugio. Puedes cambiarlo después.',
  emailLabel: 'Correo',
  passwordLabel: 'Contraseña',
  passwordHint: (minLength) => `Mínimo ${minLength} caracteres.`,
  createAccountLink: 'Crear una cuenta',
  forgotPasswordLink: 'Olvidé mi contraseña',
  backToSignIn: '← Volver a iniciar sesión',
  // Phrased as a condition, not a confirmation: we are not told whether the
  // account exists, so we must not imply that we are.
  resetSent:
    'Si existe una cuenta con ese correo, te llegará un enlace para cambiar la contraseña. Revisa también la carpeta de spam.',
  helpPrefix: '¿Problemas para entrar? Escríbenos por',
  continueWithGoogle: 'Continuar con Google',
  orWithEmail: 'o con tu correo',
  embeddedBrowser:
    'Estás viendo esta página dentro de otra app (por ejemplo, Facebook o Instagram), y ahí Google no deja iniciar sesión. Para usar Google, ábrela en Chrome o Safari. También puedes entrar con tu correo aquí abajo.',
  embeddedBrowserTryAnyway: 'Probar con Google de todos modos',
  recaptchaNotice: {
    before: 'Este sitio está protegido por reCAPTCHA y se aplican la ',
    privacy: 'Política de Privacidad',
    between: ' y las ',
    terms: 'Condiciones del Servicio',
    after: ' de Google.',
  },

  title: 'Mi cuenta',
  unverified: 'Todavía no verificas tu correo. Te enviamos un enlace cuando creaste la cuenta.',
  resendVerification: 'Reenviar el correo',
  alreadyVerified: 'Ya lo verifiqué',
  verificationResent: 'Te reenviamos el correo de verificación. Revisa también la carpeta de spam.',
  stillUnverified:
    'Todavía aparece sin verificar. Si ya abriste el enlace, espera un momento y vuelve a intentarlo.',
  comingSoon:
    'Estamos preparando tu sección: las historias completas, el historial médico y los planes de alimentación de cada animalito llegarán aquí.',
  adminPanel: 'Panel del refugio',
  seeWall: 'Ver el muro',
  signOut: 'Cerrar sesión',

  profileTitle: 'Tu perfil',
  nameRowLabel: 'Nombre',
  noName: 'Todavía sin nombre',
  change: 'Cambiar',
  add: 'Agregar',
  save: 'Guardar',
  cancel: 'Cancelar',
  nameSaved: 'Guardamos tu nombre.',
  photoRowLabel: 'Foto',
  uploadPhoto: 'Subir una foto',
  changePhoto: 'Cambiar la foto',
  useGooglePhoto: 'Usar mi foto de Google',
  removePhoto: 'Quitar la foto',
  photoSaved: 'Listo, ya está tu foto.',
  photoRemoved: 'Quitamos tu foto.',
  photoUnreadable:
    'No pudimos leer esa foto. Si la tomaste con un iPhone, prueba con otra o con una captura de pantalla.',
  photoPrivacy: 'Tu foto no aparece en el muro ni en ninguna página pública.',

  methodsTitle: 'Cómo entras',
  googleRowLabel: 'Google',
  googleConnected: (email) => (email ? `Conectada con ${email}` : 'Conectada'),
  googleNotConnected: 'Sin conectar',
  connectGoogle: 'Conectar',
  disconnectGoogle: 'Desconectar',
  googleConnectedNotice: 'Listo: ahora también puedes entrar con Google.',
  googleDisconnectedNotice: 'Desconectamos Google. Desde ahora entras con tu correo y tu contraseña.',
  disconnectNeedsPassword: 'Para poder desconectar Google algún día, primero crea una contraseña.',
  passwordRowLabel: 'Contraseña',
  passwordIsSet: 'Creada',
  passwordNotSet: 'Sin contraseña: por ahora entras solo con Google.',
  changePassword: 'Cambiar',
  createPassword: 'Crear una',
  currentPassword: 'Contraseña actual',
  newPassword: 'Contraseña nueva',
  repeatPassword: 'Repite la contraseña nueva',
  // True of Identity Platform: a password change revokes the account's other
  // sessions, so another phone signed in to it is signed out.
  passwordChanged:
    'Cambiamos tu contraseña. Si tenías la sesión abierta en otro teléfono, allí tendrás que volver a entrar.',
  passwordCreated: 'Creamos tu contraseña. Ahora también puedes entrar con tu correo.',
  emailRowLabel: 'Correo',
  changeEmail: 'Cambiar',
  newEmail: 'Correo nuevo',
  emailChangeSent: (newEmail) =>
    `Te enviamos un enlace a ${newEmail}. Tu correo cambia cuando lo abras; mientras tanto sigues entrando con el actual.`,
  emailFromGoogle: 'Viene de tu cuenta de Google.',
  sameEmail: 'Ese ya es tu correo.',

  confirmIdentityPassword: 'Por seguridad, escribe tu contraseña para seguir.',
  confirmIdentityGoogle: 'Por seguridad, vuelve a confirmar con Google para seguir.',
  confirm: 'Confirmar',
  confirmWithGoogle: 'Confirmar con Google',

  deleteTitle: 'Borrar mi cuenta',
  deleteIntro:
    'Se borran tu perfil, tu foto y tu acceso. Las solicitudes de adopción que enviaste se quedan en los registros del refugio; si también quieres que las borren, escríbenos por WhatsApp.',
  deleteStart: 'Quiero borrar mi cuenta',
  deleteConfirmPassword: 'Escribe tu contraseña para confirmar. No se puede deshacer.',
  deleteConfirmGoogle: 'Confirma con Google para borrarla. No se puede deshacer.',
  deleteSubmit: 'Borrar mi cuenta',
  deleted: 'Borramos tu cuenta. Gracias por acompañar a los animalitos.',
  adminCannotDelete:
    'Esta es una cuenta del equipo del refugio, así que no se borra desde aquí. Pide que primero le quiten el acceso de administración.',
  deleteError(failure) {
    switch (failure) {
      case 'requires-recent-login':
        return 'Pasó demasiado tiempo desde que confirmaste. Vuelve a intentarlo.';
      case 'admin-account':
        return ACCOUNT_COPY.adminCannotDelete;
      case 'unauthenticated':
        return 'Tu sesión venció. Vuelve a iniciar sesión e intenta de nuevo.';
      // The server deletes the Auth user LAST, so a failure part-way always
      // leaves an account that still signs in. This sentence depends on that.
      case 'delete-failed':
        return 'No pudimos terminar de borrar la cuenta. Tu acceso sigue funcionando; intenta de nuevo en un momento.';
      case 'network':
        return 'No pudimos conectarnos. Revisa tu internet e intenta de nuevo.';
      case 'unexpected':
        return 'No pudimos borrar la cuenta. Intenta de nuevo en un momento.';
    }
  },

  newPasswordError(error, minLength) {
    switch (error) {
      case 'password-too-short':
        return `La contraseña necesita al menos ${minLength} caracteres.`;
      case 'password-too-long':
        return 'Esa contraseña es demasiado larga.';
      case 'password-mismatch':
        return 'Las dos contraseñas nuevas no coinciden.';
      case 'password-same-as-email':
        return 'La contraseña no puede ser tu correo.';
    }
  },

  profileError(error, maxLength) {
    return error === 'display-name-empty' ? 'Escribe tu nombre.' : `El nombre puede tener hasta ${maxLength} caracteres.`;
  },

  actionTitle: 'Tu cuenta',
  actionChecking: 'Revisando el enlace…',
  actionMalformed:
    'Este enlace está incompleto. Si lo copiaste de un correo, revisa que esté entero, o pide uno nuevo.',
  actionUnsupported: 'Este enlace no es para esta página.',
  linkProblemTitle: 'Este enlace no funcionó',
  requestNewLink: 'Pedir un enlace nuevo',
  emailVerifiedTitle: '¡Correo verificado!',
  emailVerified: 'Listo, tu correo quedó verificado.',
  newPasswordTitle: 'Elige una contraseña nueva',
  newPasswordFor: (email) => `Para la cuenta ${email}.`,
  saveNewPassword: 'Guardar la contraseña',
  passwordResetTitle: 'Contraseña cambiada',
  passwordResetDone: 'Listo. Ya puedes iniciar sesión con tu contraseña nueva.',
  emailRecoveredTitle: 'Recuperamos tu correo',
  emailRecovered: (email) =>
    email ? `Tu cuenta vuelve a usar ${email}.` : 'Tu cuenta vuelve a usar tu correo anterior.',
  emailRecoveredAdvice:
    'Si tú no pediste ese cambio, alguien pudo haber entrado a tu cuenta. Te conviene cambiar la contraseña ahora.',
  sendMeResetLink: 'Enviarme un enlace para cambiarla',
  resetLinkSentTo: (email) => `Te enviamos un enlace a ${email}. Revisa también la carpeta de spam.`,
  emailChangedTitle: 'Correo cambiado',
  emailChanged: (email) =>
    email
      ? `Tu cuenta ahora usa ${email}. Vuelve a iniciar sesión con ese correo.`
      : 'Tu correo cambió. Vuelve a iniciar sesión con el nuevo.',
  goToAccount: 'Ir a mi cuenta',
  goToSignIn: 'Iniciar sesión',
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * The three emails, as Identity Platform will send them.
 *
 * Plain, inline-styled HTML: mail clients strip `<style>` blocks and most CSS,
 * and a phone's mail app is where these are read. Every template repeats
 * `%LINK%` as text under the button, because some clients block links in mail
 * from a sender they have not seen before — which, the first time, is us.
 *
 * ⚠️ Each sentence must be true. The reset link's lifetime is Identity
 * Platform's to decide, so the copy says it expires "al poco tiempo" rather
 * than naming a duration nobody here controls.
 */
function authEmailCopy(shelterName: string, siteUrl: string): AuthEmailCopy {
  const name = escapeHtml(shelterName);
  const origin = new URL(siteUrl).origin;
  const host = escapeHtml(new URL(siteUrl).host);

  const wrap = (inner: string) =>
    `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#12463b;max-width:520px">` +
    inner +
    `<p style="margin-top:28px;font-size:13px;color:#4a5f59">${name} · <a href="${origin}" style="color:#12463b">${host}</a></p>` +
    `</div>`;

  const button = (label: string) =>
    `<p style="margin:24px 0"><a href="%LINK%" style="background:#12463b;color:#ffffff;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:bold;display:inline-block">${label}</a></p>`;

  const fallback =
    `<p style="font-size:13px;color:#4a5f59">Si el botón no funciona, copia este enlace y pégalo en tu navegador:<br>` +
    `<span style="word-break:break-all">%LINK%</span></p>`;

  return {
    senderDisplayName: shelterName,
    verifyEmail: {
      subject: `Confirma tu correo en ${shelterName}`,
      body: wrap(
        `<p>¡Hola!</p>` +
          `<p>Gracias por crear tu cuenta en ${name}. Para confirmar que este correo es tuyo, abre el enlace:</p>` +
          button('Confirmar mi correo') +
          fallback +
          `<p>Si no creaste esta cuenta, puedes ignorar este mensaje.</p>`
      ),
    },
    resetPassword: {
      subject: `Cambia tu contraseña de ${shelterName}`,
      body: wrap(
        `<p>¡Hola!</p>` +
          `<p>Recibimos una solicitud para cambiar la contraseña de la cuenta %EMAIL% en ${name}. Si fuiste tú, abre el enlace para elegir una nueva:</p>` +
          button('Elegir una contraseña nueva') +
          fallback +
          `<p>Si no lo pediste, ignora este mensaje: tu contraseña sigue igual. El enlace deja de funcionar al poco tiempo; si ya no sirve, pide otro desde la página.</p>`
      ),
    },
    changeEmail: {
      subject: `Cambió el correo de tu cuenta en ${shelterName}`,
      body: wrap(
        `<p>¡Hola!</p>` +
          `<p>El correo con el que entras a ${name} cambió a %NEW_EMAIL%.</p>` +
          `<p>Si no fuiste tú, abre este enlace para volver a tu correo anterior, y después cambia tu contraseña:</p>` +
          button('Recuperar mi correo') +
          fallback +
          `<p>Si fuiste tú, no tienes que hacer nada.</p>`
      ),
    },
  };
}


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

  // ⚠️ Gender-free, every one. The animal may be of either sex, and a clitic
  // ("esterilizarlo", "ubicarlo") would be wrong for half of them — the class
  // of error that shipped "Está identifica con microchip" to a live dossier.
  // And none of them may read as "not due yet": see sterilization-timing.ts.
  sterilizationTiming: (result) => {
    switch (result.kind) {
      case 'refused':
        switch (result.reason) {
          case 'species-unknown':
            return 'Todavía no sabemos la especie. La guía AAHA es para perros.';
          case 'not-a-dog':
            // "No canine guideline applies" is a different claim from "no
            // guideline exists", and must not be written as the second.
            return 'La guía AAHA es solo para perros; para esta especie no hay una guía cargada.';
          case 'sex-unknown':
            return 'Falta el sexo para aplicar la guía AAHA.';
          case 'age-unknown':
            return 'Falta la edad. Se completa con la foto de los dientes o con el registro en papel.';
        }
        break;
      case 'act-now':
        return 'Según la guía AAHA ya es el momento, o la ventana ya pasó. Corresponde antes de la adopción; lo decide el veterinario.';
      case 'early':
        // Both standards, side by side, and no "todavía no". AAHA would place
        // the surgery later; ASV §7.1 says a shelter must not let an animal
        // breed. The vet weighs one against the other — not this screen.
        return 'La guía AAHA pondría la esterilización más adelante, pero en un refugio no se puede dejar que críe (norma ASV §7.1). Lo decide el veterinario.';
      case 'depends':
        return result.on === 'band'
          ? 'Depende de cuánto pesará de adulto: si pasará de 20 kg, la guía AAHA cambia. Anótalo en «¿Cuánto crees que pesará de adulto?».'
          : 'La edad es demasiado imprecisa para aplicar la guía AAHA. Hace falta una edad más exacta, por ejemplo con la foto de los dientes.';
    }
    return '';
  },

  sterilizationFemaleOptions:
    'En hembras que pasarán de 20 kg, la guía AAHA da dos opciones y no elige: esterilizar antes del primer celo (menos riesgo de cáncer de mama, evita camadas) o después de que termine de crecer (más riesgo de cáncer de mama, pero menos de otros cánceres y de problemas en huesos y articulaciones, y quizá de incontinencia). Lo decide el veterinario.',

  adultBandConflict: (heaviestKg) =>
    `Un peso medido de ${kgNumber(heaviestKg)} kg contradice «menos de 20 kg». Conviene revisar ese dato: el sobrepeso, una preñez o líquido en el abdomen también suben el peso, así que la balanza sola no lo decide.`,

  formatKgInput: (kg) => kgNumber(kg),

  microchipError: (error) => MICROCHIP_ERROR[error],

  intakeError: (error) => INTAKE_ERROR[error],

  authError: (error) => AUTH_ERROR[error],

  account: ACCOUNT_COPY,

  authEmails: authEmailCopy,

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

  /**
   * QR identity tags. Build-order step 12, plan §7.
   *
   * ⚠️ Nothing on the public side promises to hand over a family's details.
   * "Les avisamos" — WE tell THEM — and never "te pasamos su número": the
   * shelter relays, because a tag is readable by anyone who picks up the
   * animal, including someone who should not learn where it lives.
   */
  tag: {
    foundQuestion: '¿Encontraste a este animalito?',
    writeToShelter: 'Escríbenos por WhatsApp',
    genericTitle: 'Placa de identificación',

    lostBanner: (name, sex) => `¡${name} está ${sex === 'female' ? 'perdida' : 'perdido'}!`,

    situation(tone, name, sex, shelterName) {
      const pronoun = sex === 'female' ? 'la' : 'lo';
      switch (tone) {
        case 'lost':
          return `Su familia ${pronoun} está buscando. Escríbenos y les avisamos enseguida.`;
        case 'adopted':
          return `${name} ya tiene familia. Si ${pronoun} encontraste ${sex === 'female' ? 'sola' : 'solo'} en la calle, algo pasó: escríbenos y les avisamos.`;
        case 'available':
          return `${name} está en adopción con ${shelterName}. Si ${pronoun} encontraste en la calle, se nos escapó: escríbenos y vamos a buscar${pronoun}.`;
        case 'in-care':
          return `${name} está al cuidado de ${shelterName}. Si ${pronoun} encontraste en la calle, se nos escapó: escríbenos y vamos a buscar${pronoun}.`;
        default: {
          const unhandled: never = tone;
          return String(unhandled);
        }
      }
    },

    microchipHint: (sex) =>
      `Tiene microchip. Si puedes, ${sex === 'female' ? 'llévala' : 'llévalo'} a una veterinaria: lo pueden leer ahí mismo y confirmar quién es.`,

    finderMessage({ name, sex, formattedToken, tone }) {
      const base = `Hola, encontré a ${name}. Su placa dice ${formattedToken}.`;
      return tone === 'lost'
        ? `${base} La página dice que está ${sex === 'female' ? 'perdida' : 'perdido'}.`
        : base;
    },

    meetLink: (name) => `Conoce a ${name} →`,
    phoneLine: (display) => `WhatsApp ${display}`,
    codeLine: (formattedToken) => `Placa ${formattedToken}`,
    adminLink: 'Abrir ficha interna',

    inactiveTitle: 'Esta placa ya no está activa',
    inactiveBody: (shelterName) =>
      `La placa fue dada de baja, así que esta página no muestra a quién pertenece. Si tienes al animalito contigo, escríbenos igual: con el código, en ${shelterName} podemos averiguarlo.`,
    inactiveMessage: (formattedToken, shelterName) =>
      `Hola, encontré un animalito con una placa de ${shelterName} que ya no está activa. El código es ${formattedToken}.`,
    unknownTitle: 'No encontramos esta placa',
    unknownBody: (shelterName) =>
      `Ese código no corresponde a ninguna placa activa de ${shelterName}. Revisa que esté bien escrito: son 10 letras y números. Si tienes al animalito contigo, escríbenos igual.`,
    unknownMessage: (shelterName) =>
      `Hola, encontré un animalito con una placa de ${shelterName}, pero su código no aparece en la página.`,
    vetHint: 'Si puedes, llévalo a una veterinaria: si tiene microchip, lo pueden leer ahí mismo.',

    panelTitle: 'Placa QR',
    loading: 'Cargando…',
    noneYet: 'Todavía no tiene placa. Emite una para imprimirla y ponerla en su collar.',
    // The code itself is already shown large right above this line.
    activeSince: (_code, date) => `Activa · emitida el ${date}`,
    revokedOn: (code, date) => `${code} · dada de baja el ${date}`,
    alsoActive: (code, date) => `${code} · TAMBIÉN activa, emitida el ${date}`,
    backToRecord: '← Ficha interna',
    backToPanel: '← Panel',
    issue: 'Emitir placa',
    issuing: 'Guardando…',
    reissue: 'Dar de baja y emitir otra',
    revoke: 'Dar de baja',
    print: 'Imprimir',
    cancel: 'Cancelar',
    revokeConfirm: (code) =>
      `¿Dar de baja la placa ${code}? Quien la escanee verá que ya no está activa. No se puede deshacer.`,
    reissueConfirm: (code) =>
      `¿Dar de baja la placa ${code} y emitir otra? La vieja deja de funcionar en cuanto confirmes, así que imprime la nueva y cámbiala en el collar lo antes posible.`,
    confirmRevoke: 'Sí, dar de baja',
    confirmReissue: 'Sí, emitir otra',

    // Plan §7's honest limitation, and rfid-microchips.md §1: neither a collar
    // tag nor a chip reports where an animal is.
    limitation:
      'Una placa QR va en el collar, y un collar se cae o se quita. El microchip va bajo la piel y no se sale. Se complementan: el QR es el que sirve a cualquier persona con un celular, sin lector de microchip. Ninguno de los dos es un rastreador: no dicen dónde está el animalito, solo a quién avisar cuando alguien lo encuentra.',

    issueFailed: 'No pudimos emitir la placa. Revisa tu conexión e intenta de nuevo.',
    revokeFailed: 'No pudimos dar de baja la placa. Revisa tu conexión e intenta de nuevo.',
    loadFailed: 'No pudimos cargar las placas. Revisa tu conexión e intenta de nuevo.',
    permissionDenied:
      'Firestore rechazó la operación por permisos. Si te acaban de dar acceso, cierra sesión y vuelve a entrar.',
    printTip: 'Imprime al 100 % de escala, sin «ajustar a la página»: así el código sale del tamaño indicado.',
    testTip: 'Antes de ponerla en el collar, escanéala con tu celular y confirma que abre la ficha correcta.',
    printSize: (mm) => `El código mide ${mm} mm por lado, con su margen blanco.`,
    qrAlt: (name) => `Código QR de la placa de ${name}`,
    noActiveTag: 'Este animalito no tiene una placa activa. Emítela desde su ficha interna.',
    printTitle: (name) => `Placa de ${name}`,

    sheetTitle: 'Placas para imprimir',
    sheetIntro:
      'Para un ingreso de varios animalitos a la vez: marca los que necesitan placa, emite las que falten e imprime una sola hoja.',
    sheetEmpty: 'Todavía no hay animalitos publicados.',
    sheetTruncated: (shown, total) =>
      `${
        total === null
          ? `Solo se muestran los ${shown} registros más recientes.`
          : `Se muestran los ${shown} registros más recientes de ${total}.`
      } Si un animalito no aparece, emite e imprime su placa desde su ficha interna.`,
    sheetLink: 'Placas QR',
    noTag: 'sin placa',
    selectAll: 'Marcar todos',
    clearSelection: 'Quitar marcas',
    issueMissing: (count) => (count === 1 ? 'Emitir la placa que falta' : `Emitir las ${count} placas que faltan`),
    printSheet: (count) => (count === 1 ? 'Imprimir 1 placa' : `Imprimir ${count} placas`),
    nothingToPrint: 'Marca al menos un animalito que ya tenga placa.',
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
    candidatesTitle: 'Por revisar',
    candidatesUnavailable:
      'No pudimos cargar las lecturas por revisar. El historial confirmado sí está al día.',
    candidateGone: 'Ese registro ya no está por revisar: alguien más lo confirmó o lo descartó.',
    confirmFailed: 'No pudimos confirmar ese registro. Revisa tu conexión e inténtalo de nuevo.',
    discardFailed: 'No pudimos descartar ese registro.',
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

  yesNo: (value) => (value ? 'Sí' : 'No'),

  applicationStatusLabel: (status) => APPLICATION_STATUS[status],

  applicantStatusLabel: (status) => APPLICANT_STATUS[status],

  applicantStatusExplanation: (status) => APPLICANT_STATUS_EXPLANATION[status],

  applicationActionLabel(from, to) {
    switch (to) {
      case 'reviewing':
        return from === 'rejected' ? 'Volver a revisar' : 'Pasar a revisión';
      case 'interview':
        return 'Marcar para entrevista';
      case 'approved':
        return 'Aprobar adopción…';
      case 'rejected':
        return 'Rechazar';
      case 'withdrawn':
        // The admin is RECORDING the applicant's decision, told to them on
        // WhatsApp — not making it.
        return 'Registrar que la retiró';
      case 'submitted':
        return 'Marcar como nueva';
    }
  },

  applicationSectionLabel: (section) => APPLICATION_SECTION[section],

  applicationAnswerError: (error) => APPLICATION_ANSWER_ERROR[error],

  approvalBlocker: (blocker) => APPROVAL_BLOCKER[blocker],

  approvalWarning(warning, { otherOpenCount }) {
    switch (warning) {
      case 'other-open-applications':
        return otherOpenCount === 1
          ? 'Hay otra solicitud abierta para este animalito. Aprobar esta no la cambia: avísale a esa persona y recházala tú.'
          : `Hay ${otherOpenCount} solicitudes abiertas más para este animalito. Aprobar esta no las cambia: avísales y recházalas tú.`;
      case 'email-unverified':
        return 'La persona no verificó su correo. Confirma sus datos por WhatsApp antes de aprobar.';
      case 'pet-not-on-wall':
        return 'Este animalito ya no figura como disponible en el muro. Si así lo decidieron, puedes aprobar igual.';
      case 'location-will-be-visible':
        return 'Este animalito tiene una ubicación registrada en su ficha, y al aprobar la nueva familia va a poder verla. Si puede ser la dirección de un hogar de tránsito, que la quiten antes de aprobar.';
    }
  },

  applications: APPLICATION_COPY,

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
