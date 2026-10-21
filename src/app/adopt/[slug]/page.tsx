import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getPetBySlug } from '@/lib/pets-server';
import { whatsappLink } from '@/lib/pets';
import { signInHrefReturningTo } from '@/lib/return-path';
import { SHELTER } from '@/config/shelter';
import { t } from '@/i18n';

export const revalidate = 300;

interface Props {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const pet = await getPetBySlug(slug);
  if (!pet) return {};

  // Known facts only. A pet publishes with a name and a photo (owner decision
  // 2026-10-18), so species, sex, breed and age can all be missing here — and
  // `speciesNoun(null, …)` used to throw, which 500'd the whole page.
  const facts = t.petFacts(pet);
  const description = `${facts ? `${facts}. ` : ''}Conoce a ${pet.name} en ${SHELTER.name}.`;

  return {
    title: pet.name,
    description,
    openGraph: {
      title: pet.name,
      description,
      images: pet.coverPhoto ? [{ url: pet.coverPhoto }] : undefined,
    },
  };
}

/**
 * The pet's dossier — "el expediente" — the page every WhatsApp click and
 * every "adoptar perro Cochabamba" search should land on. Everything here
 * comes from the PUBLIC `pets/{id}` document.
 *
 * Note what is deliberately absent: the microchip number. `hasMicrochip` is
 * shown because a finder benefits from knowing the animal is chipped, but the
 * number itself lives in the restricted `identity` tier — it is the credential
 * by which ownership gets asserted, and publishing it would let anyone claim
 * the animal.
 *
 * The gated story, medical history, and feeding plan land here once auth is
 * wired up; the prompt below is a placeholder, not a working gate.
 */
export default async function PetPage({ params }: Props) {
  const { slug } = await params;
  const pet = await getPetBySlug(slug);
  if (!pet) notFound();

  const facts = t.petFacts(pet);
  const whatsapp = whatsappLink(SHELTER.whatsapp, t.adoptionInquiry(pet.name));
  const canApply = SHELTER.adoptionApplications.enabled && pet.status === 'available';

  return (
    <article className="dossier">
      <div className="container dossier__grid">
        <div className="dossier__photo">
          {pet.coverPhoto && (
            <Image src={pet.coverPhoto} alt={pet.name} width={640} height={800} priority />
          )}
        </div>

        <div className="dossier__info">
          <h1 className="t-name dossier__name">{pet.name}</h1>
          {pet.formerNames.length > 0 && (
            <p className="dossier__former-names">
              {t.formerNamesNote(pet.sex, pet.formerNames)}
            </p>
          )}
          {facts && <p className="t-data dossier__meta">{facts}</p>}

          {pet.hasMicrochip && (
            <p className="dossier__chip-note">
              <span aria-hidden="true">🔒</span> {t.microchipFinderNote(pet.name, pet.sex)}
            </p>
          )}

          {/* The adopt button. Owner decision 2026-10-21, REVERSING the earlier
              "WhatsApp is primary, no account in front of it": when the online
              application is switched on and the animal is on the wall, choosing
              to adopt leads to an account and then the application. The page is
              static (ISR), so it cannot know who is signed in; the apply page's
              own gate handles both cases (form, or sign-in that returns there).
              WhatsApp stays as a small secondary link for doubts.
              Everywhere no form exists (switch off, or the animal is not on the
              wall: shelter, foster, lost) WhatsApp is still the primary button. */}
          {canApply ? (
            <>
              <Link href={`/adopt/${pet.slug}/apply`} className="btn btn--action dossier__cta">
                {t.applications.adoptButton(pet.name)}
              </Link>
              <p className="dossier__apply">
                <a href={whatsapp}>{t.applications.whatsappQuestions}</a>
              </p>
            </>
          ) : (
            <a href={whatsapp} className="btn btn--action dossier__cta">
              Adóptame ↗
            </a>
          )}

          {/* ⚠️ Deliberately phrased in the FUTURE tense. Sign-in works as of
              2026-08-23, but nothing reads the `detail`, `medical` or
              `care/feeding` tiers yet — so "están disponibles al iniciar
              sesión" would be a promise the site cannot keep the moment the
              first pet is seeded. Switch it to the present tense in the same
              commit that actually renders those tiers, not before. */}
          <div className="dossier__gated">
            <p>
              Crea tu cuenta para seguir a {pet.name}. Pronto encontrarás aquí su historia
              completa, sus fotos, su historial médico y su plan de alimentación.
            </p>
            <a
              href={canApply ? signInHrefReturningTo(`/adopt/${pet.slug}/apply`) : '/account'}
              className="btn btn--muted"
            >
              Crear cuenta o entrar
            </a>
          </div>
        </div>
      </div>
    </article>
  );
}
