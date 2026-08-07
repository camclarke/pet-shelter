import Link from 'next/link';
import Image from 'next/image';
import { getWall, type WallFilters } from '@/lib/pets-server';
import { formatMeta } from '@/lib/pets';
import { SHELTER } from '@/config/shelter';
import type { Pet } from '@/lib/types';

interface MuroProps extends WallFilters {
  title?: string;
}

/**
 * El Muro de Adopción — the core loop of the whole site, and a Server
 * Component: pets are fetched with the Admin SDK at request time and rendered
 * to real HTML before it leaves the server. That is the whole reason this
 * moved off a client-side Firestore fetch — a search engine, or a WhatsApp
 * link preview, sees a pet's name and photo on the very first response
 * instead of an empty shell that fills in after hydration.
 */
export async function Muro({ title, ...filters }: MuroProps) {
  let pets: Pet[] = [];
  let fallo = false;

  try {
    pets = await getWall(filters);
  } catch (err) {
    console.error('[muro] no se pudo cargar', err);
    fallo = true;
  }

  return (
    <section className="muro-seccion">
      <div className="env">
        {title && <h2 className="t-titulo muro-seccion__titulo">{title}</h2>}

        {fallo && (
          <p className="muro-vacio">
            No pudimos cargar los animalitos en este momento. Intenta de nuevo en un rato.
          </p>
        )}

        {!fallo && pets.length === 0 && (
          <p className="muro-vacio">
            No hay animalitos publicados en este momento.{' '}
            {SHELTER.facebook && (
              <a href={SHELTER.facebook}>Mira las últimas novedades en Facebook.</a>
            )}
          </p>
        )}

        {!fallo && pets.length > 0 && (
          <div className="muro">
            {pets.map((pet, i) => (
              <Cartel key={pet.id} pet={pet} index={i} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function Cartel({ pet, index }: { pet: Pet; index: number }) {
  const urgente = pet.status === 'perdido';

  return (
    <Link
      href={`/adopta/${pet.slug}`}
      className="cartel"
      style={{ animationDelay: `${Math.min(index, 11) * 45}ms` }}
    >
      <div className="cartel__foto">
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
        <div className="cartel__marco">
          <span className={`cartel__chip${urgente ? ' cartel__chip--urgente' : ''}`}>
            {urgente ? 'Perdido' : 'Disponible'}
          </span>
        </div>
      </div>
      <div className="cartel__pie">
        <div className="t-nombre cartel__nombre">{pet.name}</div>
        <div className="t-dato">{formatMeta(pet)}</div>
        <div className="cartel__cta">
          Adóptame <span aria-hidden="true">↗</span>
        </div>
      </div>
    </Link>
  );
}
