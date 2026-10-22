import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getPetBySlug, getPetSterilized } from '@/lib/pets-server';
import { dossierFacts, storyParagraphs } from '@/lib/dossier';
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
 * Shown here: the story (public by owner decision 2026-10-22), colour and coat,
 * the age as a range when it is an estimate, and the sterilization line, which
 * is the one fact read from the signed-in `detail` tier. Medical history and
 * the feeding plan are NOT shown on this page.
 */
export default async function PetPage({ params }: Props) {
  const { slug } = await params;
  const pet = await getPetBySlug(slug);
  if (!pet) notFound();

  const facts = dossierFacts(pet);
  const colorCoat = t.colorCoatLine(pet.colorPattern, pet.coatType);
  const story = storyParagraphs(pet.story);
  const sterilized = t.sterilizedStatus(await getPetSterilized(pet.id), pet.sex);
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
          {colorCoat && <p className="t-data dossier__meta">{colorCoat}</p>}
          {sterilized && <p className="t-data dossier__meta">{sterilized}</p>}

          {story.length > 0 && (
            <div className="dossier__story">
              {story.map((paragraph, i) => (
                <p key={i}>{paragraph}</p>
              ))}
            </div>
          )}

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

          {/* Present tense, promising only what exists: an account lets a person
              follow the animal or apply. No medical history or feeding plan is
              shown anywhere on this page, so none is mentioned. */}
          <div className="dossier__gated">
            <p>
              Crea tu cuenta para seguir a {pet.name}{canApply ? ' y poder adoptar' : ''}.
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
