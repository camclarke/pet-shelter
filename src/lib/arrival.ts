/**
 * The arrival pipeline: the status state machine, and the WhatsApp ping.
 *
 * ── Why the ping stays on WhatsApp ────────────────────────────────────────
 * Today the manager announces an incoming animal with a WhatsApp message to
 * the staff group. The temptation is to replace that with an in-app
 * notification. Doing so is how this feature fails: WhatsApp works here
 * because everyone already has it and it PUSHES. An in-app notification gets
 * missed, staff drift back to the group chat, and the system ends up holding
 * empty records while the real information lives in a thread — today's problem
 * with extra steps.
 *
 * So the record moves into the app and the ping stays where it works. The app
 * emits a pre-filled wa.me link the manager sends exactly as they do now, and
 * the group message now POINTS AT a record instead of BEING the record. Zero
 * new infrastructure, zero cost, no notification permissions, and it is the
 * same mechanism the public site already converts through.
 */

import type { Pet, PetStatus } from './types';

/**
 * Which status changes are legal.
 *
 * ⚠️ Isolation is NOT in this table, and that is not an omission. `aislamiento`
 * is an AREA KIND (see `AreaKind`), not a status — moving a sick animal into
 * isolation is a new `placement`, while its status stays whatever it was. The
 * two axes are independent on purpose: an animal can be in `adopcion` and
 * temporarily in the medical pen without losing its place on the wall. Folding
 * isolation into this enum would force a choice between those and lose one.
 */
export const PET_STATUS_TRANSITIONS: Record<PetStatus, readonly PetStatus[]> = {
  // Announced but not here yet. It either arrives or it does not.
  'en-camino': ['cuarentena', 'cancelado'],

  // Arrived. Quarantine ends with an explicit, attributed veterinary
  // clearance — never a timer. It can also go straight to a foster home if
  // one is waiting.
  cuarentena: ['refugio', 'transito', 'perdido'],

  // General population.
  refugio: ['adopcion', 'transito', 'cuarentena', 'perdido', 'adoptado'],

  // In a foster home (hogar de tránsito) — a HOME, not a journey.
  transito: ['adopcion', 'refugio', 'adoptado', 'perdido'],

  // On the wall, actively seeking a family.
  adopcion: ['adoptado', 'refugio', 'transito', 'perdido'],

  /**
   * Placed. `refugio` is reachable again because returns happen, and a return
   * is a RE-ADMISSION, not a new animal — the chip is a deduplication key and
   * the existing record is reopened rather than duplicated. `cuarentena` is
   * reachable for the same reason: a returned animal usually goes back into
   * quarantine before rejoining the population.
   */
  adoptado: ['refugio', 'cuarentena', 'perdido'],

  // Missing. Activates the public sighting reporter.
  perdido: ['refugio', 'cuarentena', 'transito', 'adoptado'],

  /**
   * The rescue fell through. Kept as a record rather than deleted: "we were
   * told about this animal and then nothing" is information, particularly if
   * the same source does it repeatedly. Reopenable, because a rescue that
   * fell through on Tuesday can be back on by Friday.
   */
  cancelado: ['en-camino'],
};

/** Is this status change legal? A same-status write is a no-op, not a move. */
export function canTransition(from: PetStatus, to: PetStatus): boolean {
  if (from === to) return true;
  return PET_STATUS_TRANSITIONS[from].includes(to);
}

/**
 * Statuses meaning "physically inside the shelter's facility", i.e. the ones
 * that should have an open `placement`.
 *
 * `transito` is deliberately absent: a foster home is not an area. An animal
 * in a hogar de tránsito has custody and possibly a location, and NO open
 * placement — which is precisely what keeps a volunteer's home address out of
 * the operational area list.
 */
export const STATUSES_INSIDE_FACILITY: readonly PetStatus[] = [
  'cuarentena',
  'refugio',
  'adopcion',
];

export function shouldHaveOpenPlacement(status: PetStatus): boolean {
  return STATUSES_INSIDE_FACILITY.includes(status);
}

/**
 * The pre-arrival announcement, as a wa.me deep link.
 *
 * Everything except species is optional and that is the entire point. The
 * intake wizard assumes the animal is standing in front of you; this is
 * earlier than that. A form demanding a name for a dog nobody has met yet gets
 * filled with "?" — so the message simply omits what is not known.
 */
export interface ArrivalAnnouncement {
  pet: Pick<Pet, 'name' | 'species' | 'breed'>;
  /** Where it is coming from, if known. */
  origin?: string | null;
  /** Public URL of the animal's record — the whole reason to send a link. */
  recordUrl: string;
}

const SPECIES_EMOJI: Record<Pet['species'], string> = {
  perro: '🐕',
  gato: '🐈',
  conejo: '🐇',
  otro: '🐾',
};

export function arrivalAnnouncementText(a: ArrivalAnnouncement): string {
  const emoji = SPECIES_EMOJI[a.pet.species];

  // Only the parts that are actually known. "Nuevo ingreso en camino: ?" reads
  // as a broken system and trains people to ignore it.
  const descriptors = [a.pet.name?.trim(), a.pet.breed?.trim()].filter(
    (v): v is string => !!v && v.length > 0,
  );

  const who = descriptors.length > 0 ? descriptors.join(', ') : 'sin datos aún';
  const from = a.origin?.trim() ? `\nViene de: ${a.origin.trim()}` : '';

  return `${emoji} Nuevo ingreso en camino: ${who}${from}\nFicha: ${a.recordUrl}`;
}

/**
 * The link the manager actually sends. `phone` is configuration rather than a
 * constant — this template is meant to be forked, and a hardcoded Bolivian
 * number would follow another shelter into their copy.
 */
export function arrivalAnnouncementLink(a: ArrivalAnnouncement, phone: string): string {
  return `https://wa.me/${phone}?text=${encodeURIComponent(arrivalAnnouncementText(a))}`;
}
