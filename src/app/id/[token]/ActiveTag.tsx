import Image from 'next/image';
import Link from 'next/link';

import { SHELTER } from '@/config/shelter';
import { t } from '@/i18n';
import { whatsappLink } from '@/lib/pets';
import { formatQrToken, type TagView } from '@/lib/qr-tokens';
import { TagAdminLink } from './TagAdminLink';

type ActiveView = Extract<TagView, { kind: 'active' }>;

/**
 * A working tag: the animal's name, what is going on with it, and the button.
 *
 * Split out of `page.tsx` for one reason that matters: its only input is the
 * ALLOWLISTED view. `view.pet` is a `PublicTagPet`, never a `Pet`, so this
 * component cannot render a field the allowlist in `qr-tokens.ts` does not
 * carry — not by a typo, not by a spread. (It also has no `server-only`
 * import, so it can be rendered on its own to check at 360px.)
 */
export function ActiveTag({ view }: { view: ActiveView }) {
  const { pet, tone } = view;
  const code = formatQrToken(view.token);
  const message = t.tag.finderMessage({ name: pet.name, sex: pet.sex, formattedToken: code, tone });

  return (
    <article className={`tag-page tag-page--${tone}`}>
      <div className="container tag-page__inner">
        {tone === 'lost' && (
          <p className="tag-page__alert" role="alert">
            {t.tag.lostBanner(pet.name, pet.sex)}
          </p>
        )}

        <div className="tag-page__who">
          {pet.coverPhoto && (
            <div className="tag-page__photo">
              <Image src={pet.coverPhoto} alt={pet.name} width={240} height={300} priority />
            </div>
          )}
          <div className="tag-page__identity">
            <h1 className="t-name tag-page__name">{pet.name}</h1>
            <p className="t-data tag-page__meta">
              {t.speciesNoun(pet.species, pet.sex)} · {pet.breed} · {t.sizeLabel(pet.size, pet.sex)}
            </p>
            {pet.colorPattern && <p className="tag-page__color">{pet.colorPattern}</p>}
          </div>
        </div>

        <p className="tag-page__situation">{t.tag.situation(tone, pet.name, pet.sex, SHELTER.shortName)}</p>

        <section className="tag-page__found" aria-labelledby="tag-found">
          <h2 id="tag-found" className="t-title tag-page__question">
            {t.tag.foundQuestion}
          </h2>
          <a href={whatsappLink(SHELTER.whatsapp, message)} className="btn btn--action tag-page__cta">
            {t.tag.writeToShelter} ↗
          </a>
          <p className="tag-page__phone">{t.tag.phoneLine(SHELTER.whatsappDisplay)}</p>
        </section>

        {pet.hasMicrochip && <p className="dossier__chip-note">{t.tag.microchipHint(pet.sex)}</p>}

        {tone === 'available' && (
          <p>
            <Link href={`/adopt/${pet.slug}`} className="auth__link">
              {t.tag.meetLink(pet.name)}
            </Link>
          </p>
        )}

        <p className="t-data tag-page__code">{t.tag.codeLine(code)}</p>

        {/* The label is passed in rather than imported inside the client
            component, so the i18n catalogue stays out of this page's client
            bundle. The pet id is not a new disclosure: it is already in the
            public cover photo's storage path, and `pets` is publicly listable. */}
        <TagAdminLink petId={view.petId} label={t.tag.adminLink} />
      </div>
    </article>
  );
}
