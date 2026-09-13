import { SHELTER } from '@/config/shelter';
import { t } from '@/i18n';
import { whatsappLink } from '@/lib/pets';

/**
 * The page for a tag that does not name an animal: revoked, closed, or not a
 * tag at all.
 *
 * It still leads with the WhatsApp button. Whatever the code says, the person
 * reading this has an animal in front of them — a revoked tag on a collar is
 * still a collar the shelter once put there.
 *
 * Carries no pet data by construction: its props are four strings.
 */
export function TagFallback({
  title,
  body,
  message,
  code,
}: {
  title: string;
  body: string;
  message: string;
  code: string | null;
}) {
  return (
    <article className="tag-page tag-page--fallback">
      <div className="container tag-page__inner">
        <h1 className="t-title tag-page__fallback-title">{title}</h1>
        <p className="tag-page__situation">{body}</p>

        <section className="tag-page__found" aria-labelledby="tag-found">
          <h2 id="tag-found" className="t-title tag-page__question">
            {t.tag.foundQuestion}
          </h2>
          <a href={whatsappLink(SHELTER.whatsapp, message)} className="btn btn--action tag-page__cta">
            {t.tag.writeToShelter} ↗
          </a>
          <p className="tag-page__phone">{t.tag.phoneLine(SHELTER.whatsappDisplay)}</p>
        </section>

        <p className="dossier__chip-note">{t.tag.vetHint}</p>

        {code && <p className="t-data tag-page__code">{code}</p>}
      </div>
    </article>
  );
}
