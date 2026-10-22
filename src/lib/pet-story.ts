/**
 * The animal's story: the one free-text field on the public pet document.
 *
 * Pure, no Firebase import, so the rule is testable without a database and the
 * same function can guard the wizard and the admin editor.
 *
 * ⚠️ The story is PUBLIC (owner decision 2026-10-22). It is shown on
 * `/adopt/{slug}` to anyone, so it carries no names or addresses of people —
 * the editor says so in words; this module can only bound its size.
 */

/** Long enough for a few paragraphs, short enough to stay one card on a phone. */
export const STORY_MAX_CHARS = 4000;

export type StoryError = 'too-long';

export interface StoryCheck {
  /** Trimmed; what would be written. Empty string means "no story". */
  story: string;
  error: StoryError | null;
}

/** Trim and bound a story. A blank story is valid: it clears the field. */
export function checkStory(raw: string): StoryCheck {
  const story = raw.trim();
  if (story.length > STORY_MAX_CHARS) return { story, error: 'too-long' };
  return { story, error: null };
}
