import { SHELTER } from '@/config/shelter';
import { t } from '@/i18n';
import { TagFallback } from './TagFallback';

/**
 * A code that is not a working tag of this shelter — mistyped, never minted,
 * or pointing at a record that no longer exists. Served with a real 404.
 *
 * It does not echo the code back into the WhatsApp message: a not-found
 * boundary does not receive the route params, and a finder who mistyped it can
 * say what the tag reads in the chat.
 */
export default function TagNotFound() {
  return (
    <TagFallback
      title={t.tag.unknownTitle}
      body={t.tag.unknownBody(SHELTER.shortName)}
      message={t.tag.unknownMessage(SHELTER.shortName)}
      code={null}
    />
  );
}
