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
 * Every statement below describes what the code, the deployment and the
 * shelter team do today. Keeping adoption applications is the owner's policy
 * (2026-09-15). The app enforces the part it can: no screen or rule erases an
 * application, and deleting an account leaves it in place. The team applies
 * the rest (when an erasure request is granted, legal hold, refused adopters)
 * when someone asks.
 *
 * The online application section (2026-10-17) describes, field by field, what
 * the form stores and where, each claim checked against its source:
 *   - the questions and their stores: `SHELTER.adoptionApplications` in
 *     `src/config/shelter.ts` (`store: 'identity'` → admin-only
 *     `private/identity`), and `firestore.rules` (`match /private/{docId}`);
 *   - the carnet photo: `src/lib/id-document-handler.ts` and
 *     `src/lib/jpeg-inspect.ts` (APP1 removed), `storage.rules`
 *     (`adoption-ids/`: admins read, nobody writes), and the guard that no
 *     module under `src/lib/ai` names it (`id-document-guards.test.ts`);
 *   - the address and the pin: `private/home`, `roundPin4` / `PIN_DECIMALS`
 *     in `src/lib/applications.ts`;
 *   - the consent record: `AcceptanceReceipt` in
 *     `src/lib/acceptance-handler.ts` plus `recordedAt` in its route;
 *   - the three purposes: the contract's data clause in
 *     `src/config/adoption-contract.ts` (paraphrased, never widened);
 *   - erasure: `src/lib/identity-erase-handler.ts`, `-protocol.ts` and
 *     `-server.ts` (reasons, what is deleted, what is kept);
 *   - backups: the two `google_firestore_backup_schedule` resources in
 *     `terraform/firestore.tf`;
 *   - the map: `SHELTER.map.tileUrl` (OpenStreetMap), loaded only on tap in
 *     `HomeStep.tsx` and in the admin review's `HomeMap`.
 *
 * Update this page in the same change as any of these:
 *   - what an online adoption application collects — its questions, the
 *     carnet photo and which sides, the address, the map pin and its rounding,
 *     the consent record's fields — or who can read each of them;
 *   - how long any of it is kept, who erases it and for which reasons
 *     (`identity-erase-*`), or what an erase deletes and keeps;
 *   - the Firestore backup schedules, or the map's tile provider;
 *   - its questions stop asking for a name or a WhatsApp number;
 *   - an analytics, advertising or other tracking script is added;
 *   - personal data is stored somewhere new, or a new provider receives it;
 *   - what deleting an account removes or keeps (`src/lib/account-delete.ts`),
 *     including the refusal while an animal is in the person's custody;
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
const UPDATED = '17 de octubre de 2026';

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
        <h2 style={heading}>Si postulas en línea para adoptar</h2>
        <p style={para}>
          Para adoptar puedes llenar en línea el formulario de adopción del refugio. Esto es lo que
          se guarda:
        </p>
        <ul style={list}>
          <li>
            <strong>Tu postulación.</strong> Es un registro del refugio sobre lo que pasó con un
            animalito. Guarda tu nombre, tu WhatsApp, tu correo y tus respuestas sobre tu casa, como
            el tipo de inmueble y si es propio o arrendado. Solo tú y el equipo del refugio pueden
            verla.
          </li>
          <li>
            <strong>Tus datos personales y tus referencias:</strong> tu número de C.I., tu edad, tu
            estado civil, tu teléfono fijo si lo das, el nombre, el teléfono y la relación de tus dos
            referencias (una personal y una familiar) y, si alquilas, el nombre y el teléfono del
            dueño de casa. Se guardan aparte de tu postulación y solo el equipo del refugio puede
            verlos. Si nos das los datos de otra persona, avísale que el refugio podría llamarla.
          </li>
          <li>
            <strong>Una foto de tu carnet de identidad</strong>, del frente. Antes de guardarla le
            quitamos los datos de ubicación y de la cámara. Solo el equipo del refugio puede verla:
            no aparece en ninguna página pública, no se puede descargar desde tu cuenta y nunca se
            envía a Gemini ni a ninguna otra inteligencia artificial.
          </li>
          <li>
            <strong>La dirección exacta donde estará el animalito</strong>, con el número de casa y
            los detalles para llegar, y <strong>un punto en el mapa</strong>, solo si decides
            marcarlo. El punto se guarda redondeado a unos 11 metros. El equipo visita cada hogar y
            usa estos datos para llegar. Solo tú y el equipo del refugio pueden verlos.
          </li>
        </ul>
      </section>

      <section style={section}>
        <h2 style={heading}>Tu aceptación del compromiso de adopción</h2>
        <p style={para}>
          Antes de enviar tu postulación marcas una casilla para aceptar el compromiso de adopción
          del refugio. Cuando la envías, nuestro servidor guarda un registro de tu aceptación, que
          sirve como prueba de que la diste:
        </p>
        <ul style={list}>
          <li>la fecha y la hora;</li>
          <li>la dirección IP desde la que te conectaste, tal como llega a nuestro servidor;</li>
          <li>el tipo de navegador y de dispositivo que usas, tal como tu navegador lo informa;</li>
          <li>tu cuenta: su identificador y tu correo;</li>
          <li>
            la versión del compromiso que aceptaste y su huella digital, un código que comprueba su
            texto exacto.
          </li>
        </ul>
        <p style={para}>Solo el equipo del refugio puede ver este registro.</p>
      </section>

      <section style={section}>
        <h2 style={heading}>Para qué usamos los datos de tu postulación</h2>
        <p style={para}>
          Como dice el compromiso de adopción, la foto de tu carnet, tu número de contacto y la
          ubicación de tu casa se usan solo para:
        </p>
        <ol style={list}>
          <li>comprobar tu identidad como responsable del animalito;</li>
          <li>hacer el seguimiento periódico de cómo está el animalito;</li>
          <li>
            presentar una denuncia ante POFOMA o el Ministerio Público si hay sospecha de abandono o
            maltrato.
          </li>
        </ol>
        <p style={para}>
          No los divulgamos, no los vendemos y no se los pasamos a nadie ajeno a la protección del
          animalito.
        </p>
      </section>

      <section style={section}>
        <h2 style={heading}>El mapa para marcar tu casa</h2>
        <p style={para}>
          El mapa usa OpenStreetMap. Solo se carga si lo abres para marcar tu casa: entonces tu
          navegador pide las imágenes del mapa a los servidores de OpenStreetMap, que ven tu
          dirección IP y la zona que muestra el mapa. Pasa lo mismo cuando una persona del equipo
          abre el mapa de tu postulación para ver el punto. El equipo también puede abrir ese punto
          en Google Maps.
        </p>
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
          sugerencia antes de guardarla. Ningún dato de las postulaciones de adopción se envía a
          Gemini.
        </p>
      </section>

      <section style={section}>
        <h2 style={heading}>Quién puede ver tus datos</h2>
        <ul style={list}>
          <li>Tu foto de perfil no aparece en el muro ni en ninguna página pública.</li>
          <li>
            El equipo del refugio puede ver tu nombre, tu correo y tu foto. Si postulas, también ve
            todo lo que guarda tu postulación.
          </li>
          <li>No vendemos tus datos ni los compartimos para publicidad.</li>
          <li>
            Para funcionar usamos a Google (alojamiento, cuentas, reCAPTCHA y Gemini), a Resend
            (correos), a Meta (WhatsApp) y a OpenStreetMap (el mapa de la postulación).
          </li>
        </ul>
      </section>

      <section style={section}>
        <h2 style={heading}>Dónde se guardan</h2>
        <p style={para}>
          Tu perfil, tu foto y tus postulaciones, con la foto de tu carnet, tu dirección y el
          registro de tu aceptación, se guardan en Google Cloud, en Estados Unidos, y tu cuenta la
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
            que subiste y tu acceso. Tus postulaciones de adopción se quedan en los registros del
            refugio, como te explicamos abajo.
          </li>
          <li>
            Si tienes un animalito adoptado con nosotros, tu cuenta no se borra desde ahí: según el
            compromiso de adopción, pedir que borremos tus datos mientras el animalito está contigo
            significa devolverlo al refugio en 24 horas. Escríbenos por{' '}
            <a href={whatsapp}>WhatsApp</a> para coordinarlo.
          </li>
        </ul>
      </section>

      <section style={section}>
        <h2 style={heading}>Postulaciones de adopción y retención legal</h2>
        <p style={para}>
          Tu postulación no se borra cuando borras tu cuenta. Tu carnet, tu dirección y tus datos
          personales tampoco: una persona del equipo los borra en los casos que te explicamos aquí.
        </p>
        <ul style={list}>
          <li>
            La foto de tu carnet, tu dirección, el punto del mapa, tus datos personales y tus
            referencias se guardan hasta que el animalito vuelva al refugio o muera por causas
            naturales. Entonces una persona del equipo los borra. Nada se borra de forma automática.
          </li>
          <li>
            Si tu postulación no terminó en una adopción, porque la rechazamos o porque la retiraste,
            el equipo también puede borrar esos datos. Pídelo por <a href={whatsapp}>WhatsApp</a>.
            Mientras revisamos una postulación, no se borran.
          </li>
          <li>
            Al borrarlos se eliminan la foto de tu carnet, tu dirección y el punto del mapa, tu C.I.,
            tu edad, tu estado civil, tu teléfono fijo, tus referencias, los datos del dueño de casa
            y el texto de las notas del equipo sobre tu postulación. El resto queda como historial:
            tu nombre, tu WhatsApp, tu correo, tus respuestas, el estado y las fechas de la
            postulación, y el registro de tu aceptación del compromiso.
          </li>
          <li>
            Lo que se borra de nuestra base de datos puede quedar en sus copias de seguridad hasta 14
            semanas: guardamos una copia diaria durante 14 días y una semanal durante 14 semanas.
          </li>
          <li>
            Puedes pedirnos que borremos tu postulación por <a href={whatsapp}>WhatsApp</a>. Si
            adoptaste, solo lo hacemos cuando el animalito volvió al refugio y ninguna obligación
            legal nos pide conservarla. Mientras tanto, queda bajo retención legal.
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
