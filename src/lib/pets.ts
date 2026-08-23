/**
 * Presentation logic shared by server and client code. No Firestore import
 * here on purpose — see pets-server.ts (Admin SDK) and the client SDK module.
 *
 * ⚠️ No user-facing words in this file either. Anything a visitor reads comes
 * from `src/i18n`, so that adding a language never means editing logic. What
 * lives here is the shape of things: URLs, ordering, composition.
 */

/**
 * The conversion path. In Bolivia, WhatsApp is the channel that actually gets
 * answered, so every adoption action ends here — pre-filled with the pet's
 * name so the shelter knows which animal before they read a word.
 *
 * `phone` is configuration, not a constant: this template is meant to be
 * adopted by other shelters, and a hardcoded Bolivian number would follow them
 * into their fork. `message` is passed in rather than built here for the same
 * reason one layer up — the wording is language, and language lives in i18n.
 */
export function whatsappLink(phone: string, message: string): string {
  return `https://wa.me/${phone}?text=${encodeURIComponent(message)}`;
}
