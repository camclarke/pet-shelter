import type { Metadata } from 'next';
import Image from 'next/image';
import { notFound } from 'next/navigation';
import { getPetBySlug } from '@/lib/pets-server';
import { whatsappLink } from '@/lib/pets';
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

  const noun = t.speciesNoun(pet.species, pet.sex);
  const description = `${noun} · ${pet.breed} · ${t.formatAge(pet.ageMonths)}. Conoce a ${pet.name} en ${SHELTER.name}.`;

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
              Antes {t.pastParticiple('conoc', pet.sex)} como {pet.formerNames.join(', ')}
            </p>
          )}
          <p className="t-data dossier__meta">
            {t.speciesNoun(pet.species, pet.sex)} · {pet.breed} · {t.formatAge(pet.ageMonths)} ·{' '}
            {t.sizeLabel(pet.size, pet.sex)}
          </p>

          {pet.hasMicrochip && (
            <p className="dossier__chip-note">
              <span aria-hidden="true">🔒</span> Está {t.pastParticiple('identific', pet.sex)} con
              microchip. Si {t.article(pet.sex)} encuentras{' '}
              {t.pastParticiple('perdid', pet.sex)}, cualquier veterinaria puede leerlo y
              avisarnos.
            </p>
          )}

          <a
            href={whatsappLink(SHELTER.whatsapp, t.adoptionInquiry(pet.name))}
            className="btn btn--action dossier__cta"
          >
            Adóptame ↗
          </a>

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
            <a href="/account" className="btn btn--muted">
              Crear cuenta o entrar
            </a>
          </div>
        </div>
      </div>
    </article>
  );
}
