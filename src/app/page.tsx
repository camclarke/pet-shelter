import Link from 'next/link';
import { Muro } from '@/components/Muro';

const PASOS = [
  {
    n: '01',
    t: 'Encuéntralo',
    d: 'Mira el muro. Cada perrito tiene su historia, su edad y su carácter. Alguno te va a mirar distinto.',
  },
  {
    n: '02',
    t: 'Escríbenos',
    d: 'Un mensaje de WhatsApp con su nombre. Te contamos todo lo que sabemos de él, sin adornos.',
  },
  {
    n: '03',
    t: 'Conócelo',
    d: 'Se coordina un encuentro en un punto seguro. Sin compromiso: queremos que estén seguros los dos.',
  },
  {
    n: '04',
    t: 'Llévalo a casa',
    d: 'Castración gratuita a los 6 o 7 meses y seguimiento de la adopción. No desaparecemos después.',
  },
];

export default function HomePage() {
  return (
    <>
      <section className="portada">
        <div className="env">
          <p className="portada__intro">Refugio transitorio · Cochabamba, Bolivia</p>
          <h1 className="portada__lema">
            De la calle,
            <br />
            <b>a tu corazón.</b>
          </h1>
          <p className="portada__texto">
            Rescatamos perritos abandonados y maltratados, los rehabilitamos física y
            emocionalmente, y les buscamos una familia para toda la vida en adopción responsable.
          </p>
          <div className="portada__acciones">
            <Link href="/adopta" className="btn btn--accion">
              Conoce a los perritos ↓
            </Link>
            <Link href="/ayuda" className="btn btn--tenue">
              Quiero ayudar
            </Link>
          </div>
        </div>
      </section>

      <Muro limit={8} title="Están esperando una familia." />

      <div className="env">
        <Link href="/adopta" className="btn btn--marca ver-todos">
          Ver todos los perritos
        </Link>
      </div>

      <section className="pasos">
        <div className="env">
          <h2 className="t-titulo pasos__titulo">
            Adoptar no solo cambia una vida: transforma dos.
          </h2>
          <ol className="pasos__lista">
            {PASOS.map((p) => (
              <li key={p.n} className="paso">
                <span className="paso__n">{p.n}</span>
                <h3 className="paso__t">{p.t}</h3>
                <p className="paso__d">{p.d}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="cita-seccion">
        <div className="env">
          <blockquote className="t-cita cita">
            Detrás de cada mirada hay una historia de abandono, de sufrimiento y supervivencia —
            pero también una enorme capacidad de volver a confiar.
          </blockquote>
        </div>
      </section>
    </>
  );
}
