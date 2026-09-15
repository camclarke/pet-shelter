import type { Metadata } from 'next';
import Link from 'next/link';
import { SHELTER } from '@/config/shelter';

export const metadata: Metadata = {
  title: 'Privacidad',
  description: `Qué datos guarda ${SHELTER.name}, para qué, dónde y cómo borrarlos.`,
};

/**
 * ⚠️ Required, even though this page fetches nothing: without it Firebase
 * Hosting caches a static page for a year and no deploy replaces it. The full
 * reasoning is on `src/app/about/page.tsx`.
 */
export const revalidate = 300;

/**
 * DRAFT for the shelter to review before it is published.
 *
 * Every statement below describes what the code, the deployment and the
 * shelter team do today. Keeping adoption applications is the owner's policy
 * (2026-09-15). The app enforces the part it can: no screen or rule erases an
 * application, and deleting an account leaves it in place. The team applies
 * the rest (when an erasure request is granted, legal hold, refused adopters)
 * when someone asks.
 *
 * Update this page in the same change as any of these:
 *   - the online adoption application is switched on
 *     (`SHELTER.adoptionApplications.enabled` and `applicationsEnabled()`), or
 *     its questions stop asking for a name or a WhatsApp number;
 *   - an analytics, advertising or other tracking script is added;
 *   - personal data is stored somewhere new, or a new provider receives it;
 *   - what deleting an account removes or keeps (`src/lib/account-delete.ts`);
 *   - a screen, script or rule starts erasing adoption applications, or a
 *     legal hold or refused-adopter list is built into the app;
 *   - the auth-email sender moves off Resend, or the server-log retention
 *     changes.
 *
 * Deliberately no claim of compliance with any specific law. That is a legal
 * judgement for the shelter, not a description of the code.
 *
 * A shelter forking this template must rewrite this page: it names the
 * reference deployment's providers and regions, which a fork may not share.
 */
const UPDATED = '15 de septiembre de 2026';

const section = { marginTop: 'var(--space-5)', maxWidth: '65ch' } as const;
const heading = { fontSize: '1.2rem', fontWeight: 700 } as const;
const para = { marginTop: 'var(--space-2)', opacity: 0.85 } as const;
const list = {
  marginTop: 'var(--space-2)',
  paddingLeft: '1.2em',
  opacity: 0.85,
  display: 'grid',
  gap: 'var(--space-2)',
} as const;

export default function PrivacyPage() {
  const whatsapp = `https://wa.me/${SHELTER.whatsapp}`;

  return (
    <div className="container" style={{ paddingBlock: 'var(--space-5)' }}>
      <h1 className="t-title">Privacidad</h1>
      <p style={{ ...para, maxWidth: '65ch' }}>
        En {SHELTER.name} cuidamos animalitos y también los datos de las personas que nos
        ayudan. Aquí te contamos qué guardamos, para qué, dónde, y cómo borrarlo.
      </p>
      <p className="t-data" style={{ marginTop: 'var(--space-3)' }}>
        Última actualización: {UPDATED}
      </p>

      <section style={section}>
        <h2 style={heading}>Si solo visitas el sitio</h2>
        <ul style={list}>
          <li>No usamos herramientas de analítica ni de publicidad.</li>
          <li>
            Nuestro proveedor de alojamiento, Google Cloud, registra datos técnicos de cada visita,
            como la dirección IP y el tipo de navegador, para que el sitio funcione y para
            protegerlo. Esos registros se borran solos a los 30 días.
          </li>
          <li>
            Tu navegador guarda si prefieres el tema claro u oscuro. Ese dato no sale de tu
            dispositivo.
          </li>
        </ul>
      </section>

      <section style={section}>
        <h2 style={heading}>Si creas una cuenta</h2>
        <ul style={list}>
          <li>
            <strong>Tu correo electrónico</strong>, para que puedas entrar y para enviarte los
            avisos de tu cuenta.
          </li>
          <li>
            <strong>Tu nombre y tu foto</strong>, solo si los agregas. Si subes una foto, le quitamos
            los datos de ubicación y de la cámara antes de guardarla.
          </li>
          <li>
            <strong>Tu contraseña</strong> la guarda Google Identity Platform. Nosotros nunca la
            vemos.
          </li>
          <li>Si entras con Google, Google nos comparte tu nombre, tu correo y tu foto.</li>
          <li>Tu sesión queda guardada en tu navegador hasta que cierres sesión.</li>
        </ul>
      </section>

      <section style={section}>
        <h2 style={heading}>Protección contra abusos</h2>
        <p style={para}>
          La pantalla para entrar, crear una cuenta o cambiar la contraseña usa reCAPTCHA Enterprise
          de Google, que revisa señales del navegador para distinguir a las personas de los
          programas automáticos. Se aplican la{' '}
          <a href="https://policies.google.com/privacy">Política de Privacidad</a> y las{' '}
          <a href="https://policies.google.com/terms">Condiciones del Servicio</a> de Google.
        </p>
      </section>

      <section style={section}>
        <h2 style={heading}>Correos que te enviamos</h2>
        <p style={para}>
          Solo los de tu cuenta: confirmar tu correo, cambiar tu contraseña y avisarte si cambió el
          correo de tu cuenta. Salen desde una dirección de nuestro dominio a través de Resend. No
          enviamos publicidad.
        </p>
      </section>

      <section style={section}>
        <h2 style={heading}>Cuando nos escribes por WhatsApp</h2>
        <p style={para}>
          La conversación ocurre en WhatsApp, un servicio de Meta, y se rige por sus condiciones.
          Este sitio solo abre el chat.
        </p>
      </section>

      <section style={section}>
        <h2 style={heading}>Fotos de los animalitos</h2>
        <p style={para}>
          El equipo del refugio puede analizar las fotos de los animalitos con Gemini, de Google,
          para sugerir datos como la especie o la edad. Una persona del equipo revisa cada
          sugerencia antes de guardarla.
        </p>
      </section>

      <section style={section}>
        <h2 style={heading}>Quién puede ver tus datos</h2>
        <ul style={list}>
          <li>Tu foto de perfil no aparece en el muro ni en ninguna página pública.</li>
          <li>El equipo del refugio puede ver tu nombre, tu correo y tu foto.</li>
          <li>No vendemos tus datos ni los compartimos para publicidad.</li>
          <li>
            Para funcionar usamos a Google (alojamiento, cuentas, reCAPTCHA y Gemini), a Resend
            (correos) y a Meta (WhatsApp).
          </li>
        </ul>
      </section>

      <section style={section}>
        <h2 style={heading}>Dónde se guardan</h2>
        <p style={para}>
          Tu perfil y tu foto se guardan en Google Cloud, en Estados Unidos, y tu cuenta la
          administra Google Identity Platform. Los correos se envían desde servidores de Resend en
          São Paulo, Brasil.
        </p>
      </section>

      <section style={section}>
        <h2 style={heading}>Cómo cambiar o borrar tus datos</h2>
        <ul style={list}>
          <li>
            En <Link href="/account">Mi cuenta</Link> puedes cambiar tu nombre, tu foto, tu correo
            y tu contraseña.
          </li>
          <li>
            Desde ahí mismo puedes borrar tu cuenta cuando quieras. Se borran tu perfil, las fotos
            que subiste y tu acceso.
          </li>
        </ul>
      </section>

      <section style={section}>
        <h2 style={heading}>Postulaciones de adopción y retención legal</h2>
        <p style={para}>
          Si postulas en línea para adoptar, tu postulación es un registro del refugio sobre lo que
          pasó con un animalito. Guarda tu nombre, tu WhatsApp, tu correo y tus respuestas. Solo tú y
          el equipo del refugio pueden verla, y no se borra cuando borras tu cuenta.
        </p>
        <ul style={list}>
          <li>
            Puedes pedirnos que la borremos por <a href={whatsapp}>WhatsApp</a>. Si adoptaste, solo
            lo hacemos cuando el animalito volvió al refugio y ninguna obligación legal nos pide
            conservarla. Mientras tanto, queda bajo retención legal.
          </li>
          <li>
            El equipo del refugio también puede ponerla bajo retención legal en casos como maltrato o
            la muerte del animalito.
          </li>
          <li>
            Si hubo maltrato, la conservamos aunque hayas devuelto al animalito, para no volver a
            entregarte uno en adopción.
          </li>
        </ul>
      </section>

      <section style={section}>
        <h2 style={heading}>Cambios y contacto</h2>
        <p style={para}>
          Si cambiamos algo importante, lo actualizamos en esta página con su fecha. Si tienes
          preguntas sobre tus datos, escríbenos por{' '}
          <a href={whatsapp}>WhatsApp {SHELTER.whatsappDisplay}</a>.
        </p>
      </section>
    </div>
  );
}
