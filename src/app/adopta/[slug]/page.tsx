import type { Metadata } from 'next';
import Image from 'next/image';
import { notFound } from 'next/navigation';
import { getPetBySlug } from '@/lib/pets-server';
import { formatAge, whatsappLink, sizeLabel, speciesNoun, article } from '@/lib/pets';
import { SHELTER } from '@/config/shelter';

export const revalidate = 300;

interface Props {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const pet = await getPetBySlug(slug);
  if (!pet) return {};

  const noun = speciesNoun(pet.species, pet.sex);
  const description = `${noun} · ${pet.breed} · ${formatAge(pet.ageMonths)}. Conoce a ${pet.name} en ${SHELTER.name}.`;

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
 * The expediente: the page every WhatsApp click and every "adoptar perro
 * Cochabamba" search should land on. Everything here comes from the PUBLIC
 * `pets/{id}` document.
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
    <article className="expediente">
      <div className="env expediente__grid">
        <div className="expediente__foto">
          {pet.coverPhoto && (
            <Image src={pet.coverPhoto} alt={pet.name} width={640} height={800} priority />
          )}
        </div>

        <div className="expediente__info">
          <h1 className="t-nombre expediente__nombre">{pet.name}</h1>
          {pet.formerNames.length > 0 && (
            <p className="expediente__antes">
              Antes {pet.sex === 'hembra' ? 'conocida' : 'conocido'} como{' '}
              {pet.formerNames.join(', ')}
            </p>
          )}
          <p className="t-dato expediente__meta">
            {speciesNoun(pet.species, pet.sex)} · {pet.breed} · {formatAge(pet.ageMonths)} ·{' '}
            {sizeLabel(pet.size, pet.sex)}
          </p>

          {pet.hasMicrochip && (
            <p className="expediente__chip-nota">
              <span aria-hidden="true">🔒</span> {article(pet.sex) === 'la' ? 'Está' : 'Está'}{' '}
              {pet.sex === 'hembra' ? 'identificada' : 'identificado'} con microchip. Si{' '}
              {article(pet.sex)} encuentras perdid{pet.sex === 'hembra' ? 'a' : 'o'}, cualquier
              veterinaria puede leerlo y avisarnos.
            </p>
          )}

          <a
            href={whatsappLink(pet.name, SHELTER.whatsapp)}
            className="btn btn--accion expediente__cta"
          >
            Adóptame ↗
          </a>

          <div className="expediente__gated">
            <p>
              La historia completa de {pet.name}, sus fotos, su historial médico y su plan de
              alimentación están disponibles al iniciar sesión.
            </p>
            <a href="/cuenta" className="btn btn--tenue">
              Iniciar sesión
            </a>
          </div>
        </div>
      </div>
    </article>
  );
}
