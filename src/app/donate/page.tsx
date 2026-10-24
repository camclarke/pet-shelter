import type { Metadata } from 'next';
import { cache } from 'react';
import { SHELTER } from '@/config/shelter';
import { ACCOUNT_TYPES, type DonationMethod } from '@/lib/donations';
import { METHOD_KIND_LABEL } from '@/lib/donations-copy';
import { formatDayKey, formatDonationDate } from '@/lib/donations-format';
import { getPublicDonationSettings } from '@/lib/donations-server';
import { CopyButton } from './CopyButton';

/**
 * MANDATORY. The CI build has no Firestore credentials, so a prerender would
 * freeze the "nothing to show" state into the HTML. The page renders per
 * request, and next.config.ts gives it a 5-minute CDN cache (s-maxage=300) so
 * Firestore reads stay bounded. A test fails if either half goes.
 */
export const dynamic = 'force-dynamic';

/** One read per request, shared by `generateMetadata` and the page. */
const load = cache(getPublicDonationSettings);

export async function generateMetadata(): Promise<Metadata> {
  const settings = await load();
  return {
    title: 'Dona',
    description: `Ayuda a ${SHELTER.shortName} con una donación.`,
    alternates: { canonical: '/donate' },
    // Nothing to show: keep the page out of search results rather than index
    // a message that says there is nothing here.
    ...(settings ? {} : { robots: { index: false, follow: true } }),
  };
}

const VOUCHER_MESSAGE = 'Hola, acabo de donar a Wawitas. Te envío mi comprobante.';

/** «Caja de ahorro» in the page, from the stored value. */
function accountTypeLabel(type: DonationMethod['accountType']): string {
  const known = (ACCOUNT_TYPES as readonly string[]).includes(type);
  const text = known ? type : String(type);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export default async function DonatePage() {
  const settings = await load();

  if (!settings) {
    return (
      <div className="container donate">
        <h1 className="t-title">Dona</h1>
        <p className="donate__lead">
          Por ahora recibimos ayuda por <a href={`https://wa.me/${SHELTER.whatsapp}`}>WhatsApp</a>.
        </p>
      </div>
    );
  }

  const holders = [...new Set(settings.methods.map((m) => m.accountHolder))];
  const voucherUrl = `https://wa.me/${SHELTER.whatsapp}?text=${encodeURIComponent(VOUCHER_MESSAGE)}`;

  return (
    <div className="container donate">
      <h1 className="t-title">Dona</h1>
      <p className="donate__lead">
        Con tu ayuda, {SHELTER.shortName} puede cuidar a más animalitos. Puedes donar con una transferencia
        {settings.qrVisible ? ' o con el QR' : ''}.
      </p>

      <p className="auth__notice donate__check">
        Antes de transferir, verifica que el titular sea{' '}
        <strong>{holders.length === 1 ? holders[0] : holders.join(' o ')}</strong>.
      </p>

      <ul className="donate__methods">
        {settings.methods.map((method, index) => (
          <li key={`${method.bankName}-${index}`} className="donate__method">
            <h2 className="t-data donate__method-title">{METHOD_KIND_LABEL[method.kind]}</h2>
            <dl className="donate__facts">
              <div>
                <dt className="t-label">Banco</dt>
                <dd>{method.bankName}</dd>
              </div>
              <div>
                <dt className="t-label">Titular</dt>
                <dd>
                  {method.accountHolder}{' '}
                  <CopyButton value={method.accountHolder} label="el nombre del titular" />
                </dd>
              </div>
              <div>
                <dt className="t-label">Tipo de cuenta</dt>
                <dd>{accountTypeLabel(method.accountType)}</dd>
              </div>
              <div>
                <dt className="t-label">Moneda</dt>
                <dd>{method.currency === 'USD' ? 'Dólares (USD)' : 'Bolivianos (BOB)'}</dd>
              </div>
              {method.accountNumber && (
                <div>
                  <dt className="t-label">Número de cuenta</dt>
                  <dd>
                    <span className="donate__number">{method.accountNumber}</span>{' '}
                    <CopyButton value={method.accountNumber} label="el número de cuenta" />
                  </dd>
                </div>
              )}
            </dl>
            {method.note && <p className="donate__note">{method.note}</p>}
          </li>
        ))}
      </ul>

      {settings.qrVisible && (
        <section className="donate__qr" aria-labelledby="donate-qr-title">
          <h2 id="donate-qr-title" className="t-data">
            Dona con QR
          </h2>
          {/* eslint-disable-next-line @next/next/no-img-element -- a dynamic same-origin image route; next/image would re-encode a QR */}
          <img
            src="/api/donations/qr"
            alt={`Código QR para donar a ${SHELTER.shortName}. Ábrelo con la app de tu banco.`}
            width={280}
            height={280}
          />
          {settings.qrExpiresAt && <p className="donate__note">Este QR sirve hasta el {formatDayKey(settings.qrExpiresAt)}.</p>}
        </section>
      )}

      <section className="donate__voucher" aria-labelledby="donate-voucher-title">
        <h2 id="donate-voucher-title" className="t-data">
          ¿Ya donaste?
        </h2>
        <p>Envíanos tu comprobante por WhatsApp para agradecerte.</p>
        <a className="btn btn--brand" href={voucherUrl} target="_blank" rel="noopener noreferrer">
          Enviar comprobante
        </a>
      </section>

      {settings.updatedAt !== null && (
        <p className="donate__updated t-data">Actualizado el {formatDonationDate(settings.updatedAt)}</p>
      )}
    </div>
  );
}
