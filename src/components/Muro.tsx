import Link from 'next/link';
import Image from 'next/image';
import { getWall, type WallFilters } from '@/lib/dogs-server';
import { formatMeta } from '@/lib/dogs';
import type { Dog } from '@/lib/types';

interface MuroProps extends WallFilters {
  title?: string;
}

/**
 * El Muro de Adopción — the core loop of the whole site, and now a Server
 * Component: dogs are fetched with the Admin SDK at request time and rendered
 * to real HTML before it leaves the server. That is the whole reason this
 * moved off the old client-side Firestore fetch — a search engine, or a
 * WhatsApp link preview, sees a dog's name and photo on the very first
 * response instead of an empty shell that fills in after hydration.
 */
export async function Muro({ title, ...filters }: MuroProps) {
  let dogs: Dog[] = [];
  let fallo = false;

  try {
    dogs = await getWall(filters);
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
            No pudimos cargar los perritos en este momento. Intenta de nuevo en un rato.
          </p>
        )}

        {!fallo && dogs.length === 0 && (
          <p className="muro-vacio">
            No hay perritos publicados en este momento.{' '}
            <a href="https://www.facebook.com/profile.php?id=61563998952145">
              Mira las últimas novedades en Facebook.
            </a>
          </p>
        )}

        {!fallo && dogs.length > 0 && (
          <div className="muro">
            {dogs.map((dog, i) => (
              <Cartel key={dog.id} dog={dog} index={i} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function Cartel({ dog, index }: { dog: Dog; index: number }) {
  const urgente = dog.status === 'perdido';

  return (
    <Link
      href={`/adopta/${dog.slug}`}
      className="cartel"
      style={{ animationDelay: `${Math.min(index, 11) * 45}ms` }}
    >
      <div className="cartel__foto">
        {dog.coverPhoto && (
          <Image
            src={dog.coverPhoto}
            alt={dog.name}
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
        <div className="t-nombre cartel__nombre">{dog.name}</div>
        <div className="t-dato">{formatMeta(dog)}</div>
        <div className="cartel__cta">
          Adóptame <span aria-hidden="true">↗</span>
        </div>
      </div>
    </Link>
  );
}
