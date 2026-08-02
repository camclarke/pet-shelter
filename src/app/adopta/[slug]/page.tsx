import type { Metadata } from 'next';
import Image from 'next/image';
import { notFound } from 'next/navigation';
import { getDogBySlug } from '@/lib/dogs-server';
import { formatAge, whatsappLink, sizeLabel } from '@/lib/dogs';

export const revalidate = 300;

interface Props {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const dog = await getDogBySlug(slug);
  if (!dog) return {};

  const title = dog.name;
  const description = `${dog.breed} · ${formatAge(dog.ageMonths)} · ${dog.sex === 'hembra' ? 'hembra' : 'macho'}. Conoce a ${dog.name} en Wawitas Red de Apoyo.`;

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      images: dog.coverPhoto ? [{ url: dog.coverPhoto }] : undefined,
    },
  };
}

/**
 * The expediente: the page every WhatsApp click and every "adoptar perro
 * Cochabamba" search should land on. Everything here is from the PUBLIC
 * `dogs/{id}` document — the gated story, health notes, and full photo set
 * live in `dogs/{id}/detail/main` and land on this page once auth (task #5)
 * is wired up. Until then the sign-in prompt below is a placeholder, not a
 * working gate.
 */
export default async function DogPage({ params }: Props) {
  const { slug } = await params;
  const dog = await getDogBySlug(slug);
  if (!dog) notFound();

  const size = sizeLabel(dog.size, dog.sex);

  return (
    <article className="expediente">
      <div className="env expediente__grid">
        <div className="expediente__foto">
          {dog.coverPhoto && (
            <Image src={dog.coverPhoto} alt={dog.name} width={640} height={800} priority />
          )}
        </div>

        <div className="expediente__info">
          <h1 className="t-nombre expediente__nombre">{dog.name}</h1>
          {dog.formerNames.length > 0 && (
            <p className="expediente__antes">Antes conocido como {dog.formerNames.join(', ')}</p>
          )}
          <p className="t-dato expediente__meta">
            {dog.breed} · {formatAge(dog.ageMonths)} · {dog.sex} · {size}
          </p>

          <a href={whatsappLink(dog.name)} className="btn btn--accion expediente__cta">
            Adóptame ↗
          </a>

          <div className="expediente__gated">
            <p>
              La historia completa de {dog.name}, sus fotos y su estado de salud están
              disponibles al iniciar sesión.
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
