import Link from 'next/link';
import Image from 'next/image';
import { getWall, type WallFilters } from '@/lib/pets-server';
import { SHELTER } from '@/config/shelter';
import { t } from '@/i18n';
import type { Pet } from '@/lib/types';

interface AdoptionWallProps extends WallFilters {
  title?: string;
}

/**
 * The adoption wall — "el Muro de Adopción" to everyone who uses it, and the
 * core loop of the whole site. A Server Component: pets are fetched with the
 * Admin SDK at request time and rendered to real HTML before it leaves the
 * server. That is the whole reason this
 * moved off a client-side Firestore fetch — a search engine, or a WhatsApp
 * link preview, sees a pet's name and photo on the very first response
 * instead of an empty shell that fills in after hydration.
 *
 * The visual metaphor is deliberate and survives the rename: a wall of
 * adoption flyers taped up at a street corner. Each `PetPoster` hangs slightly
 * crooked and straightens when you reach for it. See `design/estilo.html`.
 */
export async function AdoptionWall({ title, ...filters }: AdoptionWallProps) {
  let pets: Pet[] = [];
  let failed = false;

  try {
    pets = await getWall(filters);
  } catch (err) {
    console.error('[adoption-wall] failed to load pets', err);
    failed = true;
  }

  return (
    <section className="wall-section">
      <div className="container">
        {title && <h2 className="t-title wall-section__title">{title}</h2>}

        {failed && (
          <p className="wall-empty">
            No pudimos cargar los animalitos en este momento. Intenta de nuevo en un rato.
          </p>
        )}

        {!failed && pets.length === 0 && (
          <p className="wall-empty">
            No hay animalitos publicados en este momento.{' '}
            {SHELTER.facebook && (
              <a href={SHELTER.facebook}>Mira las últimas novedades en Facebook.</a>
            )}
          </p>
        )}

        {!failed && pets.length > 0 && (
          <div className="wall">
            {pets.map((pet, i) => (
              <PetPoster key={pet.id} pet={pet} index={i} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function PetPoster({ pet, index }: { pet: Pet; index: number }) {
  const urgent = pet.status === 'lost';

  return (
    <Link
      href={`/adopt/${pet.slug}`}
      className="poster"
      style={{ animationDelay: `${Math.min(index, 11) * 45}ms` }}
    >
      <div className="poster__photo">
        {pet.coverPhoto && (
          <Image
            src={pet.coverPhoto}
            alt={pet.name}
            width={480}
            height={600}
            priority={index < 4}
            sizes="(max-width: 640px) 90vw, (max-width: 1024px) 45vw, 236px"
          />
        )}
        <div className="poster__frame">
          <span className={`poster__chip${urgent ? ' poster__chip--urgent' : ''}`}>
            {t.statusLabel(pet.status)}
          </span>
        </div>
      </div>
      <div className="poster__footer">
        <div className="t-name poster__name">{pet.name}</div>
        <div className="t-data">{t.formatMeta(pet)}</div>
        <div className="poster__cta">
          Adóptame <span aria-hidden="true">↗</span>
        </div>
      </div>
    </Link>
  );
}
