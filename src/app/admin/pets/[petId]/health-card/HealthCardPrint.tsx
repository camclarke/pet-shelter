'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

import { SHELTER } from '@/config/shelter';
import { t } from '@/i18n';
import { getPetById } from '@/lib/areas-admin';
import { formatDateNumeric } from '@/lib/date-input';
import {
  HEALTH_CARD_BLANK_ROWS,
  buildHealthCardTables,
  formatIsoDay,
  identityFromDraft,
  identityFromPet,
  type HealthCardAge,
  type HealthCardIdentity,
  type HealthCardRow,
  type HealthCardTables,
} from '@/lib/health-card';
import { listMedicalRecords } from '@/lib/medical-admin';
import { loadDraft, loadMicrochipCode } from '@/lib/pets-admin';
import { activeTokenOf, formatQrToken } from '@/lib/qr-tokens';
import { listPetTokens } from '@/lib/qr-tokens-admin';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'failed'; message: string }
  | { kind: 'missing' }
  | { kind: 'ready'; identity: HealthCardIdentity; tables: HealthCardTables; qrToken: string | null };

/**
 * One animal's printable vaccination card — a published pet or a draft.
 *
 * Every animal in the shelter is still a draft today, with its medical history
 * under the draft's id, so a card that read only `pets/{id}` would print for
 * nobody.
 *
 * ⚠️ All or nothing. If any read fails, the card is NOT shown and the print
 * button does not exist: a card with an empty vaccination table, printed
 * because a query failed, says "never vaccinated" on paper.
 */
export function HealthCardPrint({ petId }: { petId: string }) {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const pet = await getPetById(petId);
      const records = listMedicalRecords(petId);
      if (pet) {
        // A tag and a chip record exist only for a published pet: the rules
        // refuse a tag for an id with no `pets` document.
        const [list, chip, tokens] = await Promise.all([records, loadMicrochipCode(petId), listPetTokens(petId)]);
        return {
          kind: 'ready' as const,
          identity: identityFromPet(
            {
              name: pet.name,
              species: pet.species,
              sex: pet.sex,
              breed: pet.breed,
              colorPattern: pet.colorPattern ?? null,
              birthdateMs: pet.birthdateApprox ? pet.birthdateApprox.toMillis() : null,
            },
            chip,
          ),
          tables: buildHealthCardTables(list),
          qrToken: activeTokenOf(tokens)?.token ?? null,
        };
      }
      const draft = await loadDraft(petId);
      if (!draft) return { kind: 'missing' as const };
      return {
        kind: 'ready' as const,
        identity: identityFromDraft({
          name: draft.name,
          species: draft.species,
          sex: draft.sex,
          breed: draft.breed,
          colorPattern: draft.colorPattern,
          hasMicrochip: draft.hasMicrochip,
          microchipCode: draft.microchipCode,
          register: draft.register
            ? { nameRaw: draft.register.nameRaw, ageText: draft.register.ageText, intakeDay: draft.register.intakeDay }
            : null,
        }),
        tables: buildHealthCardTables(await records),
        qrToken: null,
      };
    })()
      .then((next) => {
        if (!cancelled) setState(next);
      })
      .catch((caught) => {
        console.error('[admin/health-card] could not load', caught);
        if (cancelled) return;
        const denied = (caught as { code?: string })?.code === 'permission-denied';
        setState({ kind: 'failed', message: denied ? t.healthCard.permissionDenied : t.healthCard.loadFailed });
      });
    return () => {
      cancelled = true;
    };
  }, [petId]);

  return (
    <div className="admin">
      <header className="admin__header no-print">
        <div>
          <h1 className="t-title">
            {state.kind === 'ready' ? t.healthCard.screenTitle(state.identity.name || '…') : t.healthCard.title}
          </h1>
          <p className="admin__sub">{t.healthCard.printTip}</p>
        </div>
        <div className="admin__header-actions">
          <Link href={`/admin/pets/${petId}`} className="btn btn--muted">
            {t.healthCard.backToRecord}
          </Link>
          {state.kind === 'ready' && (
            <button type="button" className="btn btn--action" onClick={() => window.print()}>
              {t.healthCard.print}
            </button>
          )}
        </div>
      </header>

      {state.kind === 'loading' && <p className="admin__sub no-print">{t.healthCard.loading}</p>}
      {state.kind === 'failed' && (
        <p className="auth__error no-print" role="alert">
          {state.message}
        </p>
      )}
      {state.kind === 'missing' && <p className="auth__error no-print">{t.healthCard.notFound}</p>}

      {state.kind === 'ready' && (
        <div className="health-card__scroll">
          <HealthCardView
            identity={state.identity}
            tables={state.tables}
            qrToken={state.qrToken}
            printedAt={Date.now()}
          />
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

function capitalize(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

function ageText(age: HealthCardAge): string {
  return age.kind === 'born'
    ? t.healthCard.bornOn(formatDateNumeric(age.at))
    : t.healthCard.ageAtIntake(age.text, age.day ? formatIsoDay(age.day) : null);
}

/** Label and value, or nothing: an identity line with no value is left off rather than printed empty. */
function Fact({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div className="health-card__fact">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function BlankRows({ columns }: { columns: number }) {
  return (
    <>
      {Array.from({ length: HEALTH_CARD_BLANK_ROWS }, (_, i) => (
        <tr key={`blank-${i}`} className="health-card__blank">
          {Array.from({ length: columns }, (_, c) => (
            <td key={c} />
          ))}
        </tr>
      ))}
    </>
  );
}

function when(ms: number | null): string {
  return ms === null ? '' : formatDateNumeric(ms);
}

/**
 * The sheet itself. Exported so it can be rendered with fixed data for the
 * print measurement — the page around it needs a signed-in admin.
 */
export function HealthCardView({
  identity,
  tables,
  qrToken,
  printedAt,
}: {
  identity: HealthCardIdentity;
  tables: HealthCardTables;
  qrToken: string | null;
  printedAt: number;
}) {
  const host = new URL(SHELTER.siteUrl).host;
  const hc = t.healthCard;

  return (
    <article className="health-card">
      <header className="health-card__head">
        <div>
          <p className="health-card__shelter">{SHELTER.name}</p>
          <p className="health-card__contact">
            {hc.shelterLine(`${SHELTER.city}, ${SHELTER.country}`, SHELTER.whatsappDisplay, host)}
          </p>
          <h2 className="health-card__title">{hc.title}</h2>
        </div>
        {qrToken && (
          <figure className="health-card__qr">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={`/api/qr/${qrToken}`} alt="" width={80} height={80} />
            <figcaption>{hc.qrCaption(host, formatQrToken(qrToken))}</figcaption>
          </figure>
        )}
      </header>

      <dl className="health-card__animal">
        <Fact label={hc.nameLabel} value={identity.name || null} />
        <Fact
          label={hc.speciesLabel}
          value={identity.species ? capitalize(t.speciesNoun(identity.species, identity.sex ?? 'male')) : null}
        />
        <Fact label={hc.sexLabel} value={identity.sex ? capitalize(t.sexLabel(identity.sex)) : null} />
        <Fact label={hc.breedLabel} value={identity.breed} />
        <Fact label={hc.colorLabel} value={identity.color} />
        <Fact label={hc.ageLabel} value={identity.age ? ageText(identity.age) : null} />
        <Fact label={hc.microchipLabel} value={identity.microchip} />
        <Fact
          label={hc.sterilizationLabel}
          value={tables.sterilizedAt !== null ? formatDateNumeric(tables.sterilizedAt) : null}
        />
      </dl>

      <section className="health-card__section">
        <h3 className="health-card__heading">
          {hc.vaccinationsTitle}
          <span className="health-card__heading-name">{identity.name}</span>
        </h3>
        <table className="health-card__table health-card__table--vaccines">
          <colgroup>
            <col className="health-card__col-date" />
            <col className="health-card__col-name" />
            <col className="health-card__col-lot" />
            <col className="health-card__col-date" />
            <col className="health-card__col-who" />
            <col className="health-card__col-sticker" />
          </colgroup>
          <thead>
            <tr>
              <th>{hc.dateColumn}</th>
              <th>{hc.vaccineColumn}</th>
              <th>{hc.labLotColumn}</th>
              <th>{hc.nextDoseColumn}</th>
              <th>{hc.whoColumn}</th>
              <th>{hc.stickerColumn}</th>
            </tr>
          </thead>
          <tbody>
            {tables.vaccinations.map((row: HealthCardRow) => (
              <tr key={row.id}>
                <td className="health-card__date">{when(row.performedAt)}</td>
                <td>{row.name ?? ''}</td>
                <td>
                  {hc.labLot(
                    row.product,
                    row.manufacturer,
                    row.batch,
                    row.productExpiresAt === null ? null : formatDateNumeric(row.productExpiresAt)
                  )}
                </td>
                <td className="health-card__date">{when(row.nextDueAt)}</td>
                <td>{hc.who(row.veterinarian, row.clinic)}</td>
                <td />
              </tr>
            ))}
            <BlankRows columns={6} />
          </tbody>
        </table>
      </section>

      <section className="health-card__section">
        <h3 className="health-card__heading">
          {hc.dewormingsTitle}
          <span className="health-card__heading-name">{identity.name}</span>
        </h3>
        <table className="health-card__table health-card__table--deworming">
          <colgroup>
            <col className="health-card__col-date" />
            <col className="health-card__col-product" />
            <col className="health-card__col-date" />
            <col className="health-card__col-who" />
            <col className="health-card__col-sign" />
          </colgroup>
          <thead>
            <tr>
              <th>{hc.dateColumn}</th>
              <th>{hc.productColumn}</th>
              <th>{hc.nextDoseColumn}</th>
              <th>{hc.whoColumn}</th>
              <th>{hc.signColumn}</th>
            </tr>
          </thead>
          <tbody>
            {tables.dewormings.map((row: HealthCardRow) => (
              <tr key={row.id}>
                <td className="health-card__date">{when(row.performedAt)}</td>
                <td>{hc.dewormingProduct(row.name, row.product)}</td>
                <td className="health-card__date">{when(row.nextDueAt)}</td>
                <td>{hc.who(row.veterinarian, row.clinic)}</td>
                <td />
              </tr>
            ))}
            <BlankRows columns={5} />
          </tbody>
        </table>
      </section>

      <footer className="health-card__foot">{hc.printedOn(formatDateNumeric(printedAt))}</footer>
    </article>
  );
}
