/**
 * The applicant's step-by-step form, RENDERED and WIRED (portion 4c-2).
 *
 * Run with:  node --test --import tsx src/lib/__tests__/application-stepper.test.ts
 *
 * There is no component-test setup in this repo and the form ships switched
 * OFF behind a sign-in, so two instruments are used, each honest about what it
 * can see:
 *   - STATIC RENDERS (`react-dom/server`) of the presentational views — what
 *     markup each step produces for a given state. Not a browser: no layout,
 *     no events. The 360px check is a separate, human-run measurement.
 *   - SOURCE GUARDS on the containers — that code EXISTS in a given order (the
 *     batch before the upload, the acceptance passed explicitly). They can be
 *     evaded by indirection, and exist because nothing else would notice.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { SHELTER } from '@/config/shelter';
import {
  ADOPTION_ACCEPTANCE,
  ADOPTION_CONTRACT,
  CONTRACT_CI_TOKEN,
  CONTRACT_NAME_TOKEN,
  contractCanonicalText,
} from '@/config/adoption-contract';
import { ContractText } from '@/app/adopt/[slug]/apply/ContractText';
import {
  ApplicationStepperView,
  DEFAULT_SERVICES,
  LeaveDialog,
  NO_ERRORS,
  UploadFailedView,
  acceptanceLabelFor,
  inAppDestination,
  photoSummary,
  type ApplicationStepperViewProps,
} from '@/app/adopt/[slug]/apply/ApplicationStepper';
import { ID_PHOTO_SIDE, IdPhotoUploaderView, type IdPhotoState } from '@/app/adopt/[slug]/apply/IdPhotoStep';
import { ExistingApplication, SignInGate } from '@/app/adopt/[slug]/apply/ApplicationForm';
import {
  DEFAULT_MY_APPLICATIONS_SERVICES,
  MyApplicationsView,
  itemsAfterFailedLoad,
  needsAcceptanceRecord,
  withCarnetReceived,
} from '@/app/account/MyApplications';
import { getPublicPets, listMyApplications, withdrawMyApplication } from '../applications-client';
import { uploadIdDocument } from '../id-document-client';
import { recordAcceptance } from '@/lib/acceptance-client';
import { APPLICATION_STEPS, type ApplicationStep } from '../application-steps';
import { emptyAnswerDraft, type AnswerDraft } from '../applications';
import type { MyApplication } from '../applications-client';
import type { IdUploadProblem } from '../id-document-client';
import { STATIC_SITEMAP_ROUTES } from '../sitemap';
import { findVoseo } from '../ai/spanish-register';
import { es } from '@/i18n/es';

const config = SHELTER.adoptionApplications;
const QUESTIONS = config.questions;
const ROOT = process.cwd();
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8').replace(/\r\n/g, '\n');
/** Source with comments removed, so a comment naming a call cannot satisfy a check. */
const code = (path: string) =>
  read(path)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

const STEPPER = 'src/app/adopt/[slug]/apply/ApplicationStepper.tsx';
const FORM = 'src/app/adopt/[slug]/apply/ApplicationForm.tsx';
const CONTRACT_PAGE = 'src/app/adopt/contract/page.tsx';

assert.ok(ADOPTION_CONTRACT, 'the tests below render the real contract');
const CONTRACT = ADOPTION_CONTRACT;

const decode = (html: string) =>
  html
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

/** The text of each block element (h2/h3, p, li) inside the contract section, in order. */
function contractBlocks(html: string): string[] {
  const section = /<section class="contract"[^>]*>([\s\S]*?)<\/section>/.exec(html);
  assert.ok(section, 'no contract section rendered');
  return [...section[1]!.matchAll(/<(h2|h3|h4|p|li)\b[^>]*>([\s\S]*?)<\/\1>/g)].map((m) =>
    decode(m[2]!.replace(/<[^>]+>/g, '')),
  );
}

const count = (html: string, needle: string) => html.split(needle).length - 1;

/**
 * The canonical text with both blanks filled AT ONCE. Two sequential
 * `.replace` calls would be wrong exactly where the component must be right:
 * a name containing `{ci}` would have the C.I. put inside it.
 */
function filledCanonical(name: string, ci: string): string[] {
  const tokens = new RegExp(`${CONTRACT_NAME_TOKEN.replace(/[{}]/g, '\\$&')}|${CONTRACT_CI_TOKEN.replace(/[{}]/g, '\\$&')}`, 'g');
  return contractCanonicalText(CONTRACT)
    .replace(tokens, (token) => (token === CONTRACT_NAME_TOKEN ? name : ci))
    .split('\n\n');
}

// ─── the contract: nothing displayed differs from what is hashed ────────────

test('the BLANK contract, tags stripped, is the canonical text with the blanks read aloud', () => {
  const html = renderToStaticMarkup(createElement(ContractText, { contract: CONTRACT, mode: 'blank' }));
  assert.deepEqual(contractBlocks(html), filledCanonical(es.applicationSteps.blankName, es.applicationSteps.blankCi));
});

test('the FILLED contract shows the name and the C.I. in bold, and otherwise the canonical text', () => {
  const name = 'Ana {ci} Pérez'; // a token inside a name stays literal
  const html = renderToStaticMarkup(
    createElement(ContractText, { contract: CONTRACT, mode: 'filled', name, ci: '1234567 LP' }),
  );
  assert.deepEqual(contractBlocks(html), filledCanonical(name, '1234567 LP'));
  assert.match(html, /<strong class="contract__filled">Ana \{ci\} Pérez<\/strong>/);
  assert.match(html, /<strong class="contract__filled">1234567 LP<\/strong>/);
  // Filled without values falls back to blanks, never to an empty bold.
  const empty = renderToStaticMarkup(createElement(ContractText, { contract: CONTRACT, mode: 'filled', name: null, ci: '' }));
  assert.equal(count(empty, 'contract__blank'), 2);
  assert.equal(count(empty, 'contract__filled'), 0);
});

test('exactly the 48-hour clause is bold, as on paper (D10), and no signature line is drawn (D11)', () => {
  const html = renderToStaticMarkup(createElement(ContractText, { contract: CONTRACT, mode: 'blank' }));
  const items = [...html.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => m[1]!);
  assert.equal(items.length, 9);
  items.forEach((item, i) => assert.equal(item.startsWith('<strong>'), i === 2, `clause ${i}`));
  assert.ok(!/FIRMA|RESCATISTA/.test(html));
  assert.ok(!html.includes('dangerouslySetInnerHTML') && !/<script/i.test(html));
});

// ─── the steps, rendered ────────────────────────────────────────────────────

const READY: IdPhotoState = {
  kind: 'ready',
  photo: { bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), width: 2048, height: 1536 },
  previewUrl: 'blob:preview',
};

function answers(overrides: AnswerDraft = {}): AnswerDraft {
  return { ...emptyAnswerDraft(QUESTIONS), ...overrides };
}

function view(step: ApplicationStep, overrides: Partial<ApplicationStepperViewProps> = {}): string {
  const props: ApplicationStepperViewProps = {
    step,
    petName: 'Luna',
    questions: QUESTIONS,
    contract: CONTRACT,
    answers: answers({ fullName: 'Ana Pérez', ciNumber: '1234567' }),
    home: { addressText: 'Calle Sucre 123', reference: '', pin: null },
    accepted: false,
    photo: READY,
    errors: NO_ERRORS,
    notice: null,
    sending: 'idle',
    fromReview: false,
    petFacts: [{ label: 'NOMBRE', value: 'Luna' }],
    onAnswer: () => {},
    onHome: () => {},
    onPin: () => {},
    onAccept: () => {},
    onFile: () => {},
    onBack: () => {},
    onContinue: () => {},
    onEdit: () => {},
    onSubmit: () => {},
    ...overrides,
  };
  return renderToStaticMarkup(createElement(ApplicationStepperView, props));
}

test('every step says where it is, as text: "Paso N de 7 · …", in the owner\'s order', () => {
  const titles = APPLICATION_STEPS.map((step) => {
    const h2 = /<h2 class="t-title apply-step__title" tabindex="-1">([^<]*)<\/h2>/.exec(view(step));
    assert.ok(h2, `${step}: no focusable step heading`);
    return decode(h2[1]!);
  });
  assert.deepEqual(titles, [
    'Paso 1 de 7 · El compromiso',
    'Paso 2 de 7 · Tu carnet',
    'Paso 3 de 7 · Dónde vivirá Luna',
    'Paso 4 de 7 · DATOS PERSONALES',
    'Paso 5 de 7 · REFERENCIAS',
    'Paso 6 de 7 · DOMICILIO',
    'Paso 7 de 7 · Revisar y enviar',
  ]);
});

test('every step has exactly ONE .btn--action — Continuar, or Enviar on the review', () => {
  for (const step of APPLICATION_STEPS) {
    assert.equal(count(view(step), 'btn--action'), 1, step);
  }
  assert.ok(view('review').includes('>Enviar solicitud</button>'));
  assert.ok(!view('contract').includes('>Atrás</button>'), 'step 1 has nowhere to go back to');
  assert.ok(view('carnet').includes('>Atrás</button>'));
});

test('step 1 is the contract with blanks and the paper note OUTSIDE the contract block', () => {
  const html = view('contract');
  assert.equal(count(html, 'contract__blank'), 2);
  const note = html.indexOf('apply-paper-note');
  assert.ok(note > html.indexOf('</section>'), 'the paper note sits inside the contract block');
  assert.ok(decode(html).includes(es.applicationSteps.paperNote));
});

test('step 2: two visually-hidden file inputs inside labels — never `hidden` — one with the camera', () => {
  const html = view('carnet', { photo: { kind: 'empty' } });
  const inputs = [...html.matchAll(/<input[^>]*type="file"[^>]*>/g)].map((m) => m[0]);
  assert.equal(inputs.length, 2);
  for (const input of inputs) {
    assert.match(input, /class="visually-hidden"/);
    assert.ok(!/\shidden(=|\s|>)/.test(input), 'a file input carries `hidden`: Chrome 130+ drops its change event');
    assert.match(input, /accept="image\/\*"/);
  }
  assert.equal(inputs.filter((i) => i.includes('capture="environment"')).length, 1);
  assert.equal(count(html, '<label class="btn'), 2, 'each picker is a label styled as a button');
  assert.ok(html.includes('>Continuar</button>'));
});

test('step 2 with a ready photo shows the local preview and asks «¿Se leen bien tus datos?»', () => {
  const html = decode(view('carnet'));
  assert.match(html, /<img src="blob:preview"/);
  assert.ok(html.includes('¿Se leen bien tus datos?'));
  assert.ok(html.includes('>Sí, continuar</button>'));
  assert.ok(html.includes('Tomar otra'));
  const required = decode(view('carnet', { photo: { kind: 'empty' }, errors: { ...NO_ERRORS, step: 'photo-required' } }));
  assert.ok(required.includes(es.applicationSteps.photoRequired));
  const problem = decode(view('carnet', { photo: { kind: 'problem', problem: 'too-small' } }));
  assert.ok(problem.includes(es.applicationSteps.photoProblem('too-small')));
});

test("step 3 asks the paper's address fields verbatim, and the CROQUIS is an optional map that is NOT loaded yet", () => {
  const html = decode(view('address'));
  assert.ok(html.includes('DIRECCIÓN EXACTA DONDE ESTARÁ EL PELUDITO'));
  assert.ok(html.includes('NÚMERO DE CASA Y DETALLES'));
  assert.ok(html.includes('CROQUIS UBICACIÓN'));
  assert.ok(html.includes('CROQUIS UBICACIÓN <small class="apply-field__mark">(opcional)</small>'), 'marked optional');
  assert.ok(html.includes(`>${es.applicationSteps.mapOpen}</button>`), 'a button opens the map');
  // Nothing of the map before the tap: no tile URL, no Leaflet, no loading box.
  assert.ok(!/openstreetmap|leaflet|address-map/i.test(html), 'the map must not load until asked for');
  // React serialises the prop as `autoComplete`; HTML attribute names are case-insensitive.
  assert.equal((html.match(/autocomplete="off"/gi) ?? []).length, 2, 'a shared phone must not offer an address back');
});

test("step 4 opens with the paper's intro verbatim, and keeps the section legend for screen readers only", () => {
  const html = decode(view('personal'));
  assert.ok(html.includes(config.formIntro));
  assert.match(html, /<legend class="sr-only">DATOS PERSONALES<\/legend>/);
  for (const label of ['NOMBRE COMPLETO', 'C.I.', 'EDAD', 'ESTADO CIVIL', 'CELULAR', 'CASA']) {
    assert.ok(html.includes(`${label} <small`), label);
  }
  assert.ok(html.includes('CASA <small class="apply-field__mark">(opcional)</small>'), 'CASA is the optional one');
});

test('step 6 shows the landlord only for ARRENDADO and «amurallado» only for CASA or FINCA', () => {
  const html = (overrides: AnswerDraft) => decode(view('dwelling', { answers: answers(overrides) }));
  assert.ok(!html({}).includes('Nombre de dueño del inmueble'));
  assert.ok(!html({}).includes('amurallado'));
  const rented = html({ housingTenure: 'rented' });
  assert.ok(rented.includes('Si es arrendatario, coloque nombre y teléfono del dueño de casa:'));
  assert.ok(rented.includes('Nombre de dueño del inmueble'));
  assert.ok(html({ housingType: 'house' }).includes('¿se encuentra amurallado?'));
  assert.ok(html({ housingType: 'farm' }).includes('¿se encuentra amurallado?'));
  assert.ok(!html({ housingType: 'apartment' }).includes('amurallado'));
});

test('the review: a summary with «Cambiar», the pet facts, the contract FILLED, and an UNTICKED box', () => {
  const raw = view('review');
  const html = decode(raw);
  assert.equal(count(raw, '>Cambiar</button>'), 5, 'carnet, address and the three sections');
  assert.ok(html.includes(config.petSection.title));
  assert.match(raw, /<strong class="contract__filled">Ana Pérez<\/strong>/);
  assert.match(raw, /<strong class="contract__filled">1234567<\/strong>/);
  const box = /<input id="apply-acceptance"[^>]*>/.exec(raw);
  assert.ok(box, 'no acceptance box');
  assert.ok(!/\schecked/.test(box[0]), 'the box is pre-ticked');
  assert.ok(html.includes(ADOPTION_ACCEPTANCE.label.replace('{mascota}', 'Luna')));
  // The button is never disabled for an unticked box: the error goes beside it.
  assert.ok(/<button type="button" class="btn btn--action apply-step__primary">Enviar solicitud<\/button>/.test(raw));
  const refused = decode(view('review', { errors: { ...NO_ERRORS, step: 'acceptance-required' } }));
  assert.ok(refused.includes('Marca la casilla para enviar tu solicitud.'));
  assert.ok(html.includes('Enviar no es la adopción: el equipo revisa tu solicitud y te escribe por WhatsApp.'));
});

test('the acceptance shows no DRAFT marker: the owner supplied the words on 2026-10-17', () => {
  assert.equal(ADOPTION_ACCEPTANCE.isDraft, false);
  assert.ok(!view('review').includes('apply-accept__draft'));
});

test('while sending, the one button is disabled and the screen says which half is in flight', () => {
  const application = decode(view('review', { accepted: true, sending: 'application' }));
  assert.ok(application.includes('Enviando tu solicitud…'));
  assert.ok(/apply-step__primary" disabled="">Enviar solicitud/.test(application));
  assert.ok(decode(view('review', { accepted: true, sending: 'photo' })).includes('Subiendo la foto de tu carnet…'));
});

// ─── the application arrived; the photo did not ────────────────────────────

function failed(problem: IdUploadProblem, photo: IdPhotoState = READY): string {
  return decode(
    renderToStaticMarkup(createElement(UploadFailedView, { problem, photo, busy: false, onFile: () => {}, onRetry: () => {} })),
  );
}

test('a failed upload says the application arrived, offers «Reintentar» with the same photo, and names «Mis solicitudes»', () => {
  const html = failed('retry');
  assert.ok(html.includes('Tu solicitud llegó, pero la foto de tu carnet no. Sin ella no se puede aprobar.'));
  assert.ok(html.includes('>Reintentar</button>'));
  assert.ok(html.includes('También puedes subirla después desde «Mis solicitudes».'));
  assert.ok(html.includes('href="/account"'));
});

test('a closed or paused application offers no retry that cannot work; a refused photo asks for another', () => {
  for (const problem of ['closed', 'paused', 'sign-in'] as const) {
    assert.ok(!failed(problem).includes('>Reintentar</button>'), problem);
  }
  const refused = failed('photo-rejected', { kind: 'empty' });
  assert.ok(!refused.includes('>Reintentar</button>'), 'the refused photo would be sent again');
  assert.ok(refused.includes('type="file"'), 'no way to choose another photo');
});

test('after any failure a retry cannot fix, the stepper discards the photo (review 4c-2 #8)', () => {
  const src = code(STEPPER);
  assert.match(src, /if \(!keepsPhotoForRetry\(problem\)\) clearPhoto\(\);/);
  assert.match(code('src/app/adopt/[slug]/apply/IdPhotoStep.tsx'), /if \(!keepsPhotoForRetry\(refused\)\) clear\(\);/);
});

test('«Mis solicitudes» is named only where a later upload can work (review 4c-2 #6)', () => {
  for (const problem of ['retry', 'sign-in', 'photo-too-small', 'photo-rejected'] as const) {
    assert.ok(failed(problem, { kind: 'empty' }).includes('También puedes subirla después'), problem);
  }
  for (const problem of ['closed', 'paused'] as const) {
    assert.ok(!failed(problem).includes('También puedes subirla después'), problem);
  }
});

test('the name in the contract is TEXT, never markup (review 4c-2 #13)', () => {
  const raw = renderToStaticMarkup(
    createElement(ContractText, { contract: CONTRACT, mode: 'filled', name: '<img src=x onerror=alert(1)>', ci: '"><script>alert(1)</script>' }),
  );
  assert.ok(!/<img|<script/i.test(raw), 'the typed name became markup');
  assert.match(raw, /<strong class="contract__filled">&lt;img src=x onerror=alert\(1\)&gt;<\/strong>/);
  assert.ok(decode(raw).includes('"><script>alert(1)</script>'), 'the C.I. was not shown as typed');
  assert.ok(!/dangerouslySetInnerHTML|innerHTML/.test(read('src/app/adopt/[slug]/apply/ContractText.tsx')), 'ContractText may set HTML');
});

// ─── the wiring: batch first, then the photo ────────────────────────────────

test('the submit writes the batch FIRST and uploads the photo only after it commits', () => {
  const src = code(STEPPER);
  const submit = src.slice(src.indexOf('async function onSubmit()'), src.indexOf('async function sendPhoto('));
  assert.ok(submit.length > 0, 'onSubmit is not where it was');
  const batchAt = submit.indexOf('await services.submit(petId, user,');
  const photoAt = submit.indexOf('await sendPhoto(applicationId, photo.photo)');
  assert.ok(batchAt > 0 && photoAt > batchAt, 'the photo is sent before the application exists');
  // A failed batch returns before the photo is ever touched.
  const catchAt = submit.indexOf('} catch (caught) {');
  assert.ok(catchAt > batchAt && catchAt < photoAt);
  assert.ok(/setSending\('idle'\);\s*return;\s*\}/.test(submit.slice(catchAt, photoAt)), 'a refused batch still uploads');
  // The only upload call site: inside sendPhoto, and the retry calls sendPhoto.
  assert.equal((src.match(/services\.upload\(/g) ?? []).length, 1, 'a second upload call site');
  assert.equal((src.match(/uploadIdDocument\(/g) ?? []).length, 0, 'an upload that bypasses the services');
  assert.ok(src.slice(src.indexOf('async function sendPhoto(')).includes('services.upload(user, applicationId, ID_PHOTO_SIDE, prepared)'));
});

test('the injectable services default to the REAL submit, upload and navigation — and production passes none', () => {
  assert.equal(DEFAULT_SERVICES.upload, uploadIdDocument, 'the default upload is not the route client');
  assert.equal(DEFAULT_SERVICES.recordAcceptance, recordAcceptance, 'the default consent record is not the route client');
  const src = code(STEPPER);
  const defaults = src.slice(src.indexOf('export const DEFAULT_SERVICES'), src.indexOf('export interface ApplicationStepperProps'));
  assert.match(defaults, /const \{ submitApplication \} = await import\('@\/lib\/applications-client'\);\s*return submitApplication\(petId, user, submission\);/);
  assert.match(defaults, /navigate: \(href\) => window\.location\.assign\(href\),/);
  assert.match(src, /services = DEFAULT_SERVICES,/);
  // Nothing in the app passes services: only the tests do.
  assert.ok(!/services=\{/.test(code(FORM)), 'the apply page overrides the stepper services');
  assert.ok(!/services=\{/.test(code('src/app/account/AccountSettings.tsx')), '/account overrides the list services');
  assert.equal(DEFAULT_MY_APPLICATIONS_SERVICES.list, listMyApplications);
  assert.equal(DEFAULT_MY_APPLICATIONS_SERVICES.pets, getPublicPets);
  assert.equal(DEFAULT_MY_APPLICATIONS_SERVICES.withdraw, withdrawMyApplication);
});

test('the stepper sends identity and home, and the acceptance EXPLICITLY, for the version it rendered', () => {
  const src = code(STEPPER);
  assert.match(src, /answers: submission\.answers,\s*identity: submission\.identity,\s*home: submission\.home,\s*acceptance: \{ accepted, contractVersion: contract\.version \},/);
  // Every step is re-checked before sending, and the box last.
  const submit = src.slice(src.indexOf('async function onSubmit()'));
  assert.ok(submit.indexOf('firstInvalidStep(') < submit.indexOf('services.submit('));
  // submitApplication's type now REQUIRES both private documents and the box.
  const client = code('src/lib/applications-client.ts');
  assert.match(client, /identity: Record<string, ApplicationAnswer>;/);
  assert.match(client, /home: ValidHome;/);
  assert.match(client, /acceptance: AcceptanceGiven;/);
});

test('the stepper uploads the front only, which is exactly what the shelter asks for', () => {
  assert.equal(ID_PHOTO_SIDE, 'front');
  assert.deepEqual([...config.idDocumentSides], [ID_PHOTO_SIDE], 'a new side needs the stepper to ask for it');
});

test('nothing on the applicant side keeps anything in the browser: no storage API, ever', () => {
  for (const file of [
    STEPPER,
    FORM,
    'src/app/adopt/[slug]/apply/IdPhotoStep.tsx',
    'src/app/adopt/[slug]/apply/HomeStep.tsx',
    'src/app/adopt/[slug]/apply/ReviewStep.tsx',
    'src/app/adopt/[slug]/apply/ApplicationFields.tsx',
    'src/app/account/MyApplications.tsx',
    'src/lib/application-steps.ts',
    'src/lib/id-document-client.ts',
  ]) {
    assert.ok(!/localStorage|sessionStorage|indexedDB|caches\.open|document\.cookie/.test(code(file)), file);
  }
});

test('only "Continuar" pushes an entry; every other move travels with history.go (review 4c-2 #3)', () => {
  const src = code(STEPPER);
  const pushes = [...src.matchAll(/window\.history\.pushState\(/g)].length;
  // forward(): step 1 put back on a bare guard, then the step; the mount: step 1; the guard re-arm.
  assert.equal(pushes, 4, 'a new pushState call site');
  const forward = src.slice(src.indexOf('function forward('), src.indexOf('function move('));
  assert.equal((forward.match(/pushState\(/g) ?? []).length, 2);
  const move = src.slice(src.indexOf('function move('), src.indexOf('function clearError('));
  assert.match(move, /window\.history\.go\(next\.delta\);/);
  assert.ok(!move.includes('pushState'), 'a travel pushes an entry');
  assert.match(src, /onBack=\{\(\) => move\(\{ kind: 'back' \}\)\}/);
  assert.match(src, /onEdit=\{\(target\) => move\(\{ kind: 'edit', target \}/);
  assert.match(src, /move\(fromReview \? \{ kind: 'return-to-review' \} : \{ kind: 'continue' \}\);/);
  assert.match(src, /const shown = stepForHistory\(requested, furthestRef\.current\);/);
  assert.match(src, /window\.addEventListener\('beforeunload', warn\)/);
  assert.match(src, /const unsent = phase\.kind === 'form' && hasUnsentData\(stepperState\);/);
  // Focus moves to the step heading (or the first error) on every move.
  assert.match(src, /if \(!focusField\(target\)\) headingRef\.current\?\.focus\(\);/);
});

test('in-app links are guarded in the CAPTURE phase, so a Next <Link> sees defaultPrevented', () => {
  const src = code(STEPPER);
  assert.match(src, /document\.addEventListener\('click', onClick, true\);/);
  assert.match(src, /document\.removeEventListener\('click', onClick, true\);/);
  assert.ok(!/window\.confirm|confirm\(/.test(src), 'a browser confirm box');
  // Next's own <Link> refuses to navigate once the event is prevented. Found
  // through Node's resolution, so a copy of the tree without its own
  // node_modules (a mutation probe) still reads the installed Next.
  const resolveFrom = createRequire(join(ROOT, 'package.json'));
  const link = readFileSync(resolveFrom.resolve('next/dist/client/link.js'), 'utf8');
  assert.match(link, /if \(e\.defaultPrevented\) \{?\s*return;/, 'next/link no longer checks defaultPrevented');
  const appLink = readFileSync(resolveFrom.resolve('next/dist/client/app-dir/link.js'), 'utf8');
  assert.match(appLink, /if \(e\.defaultPrevented\) \{?\s*return;/, 'the app-router <Link> no longer checks defaultPrevented');
});

test('inAppDestination: a same-origin page in this tab, and nothing else', () => {
  const here = 'https://wawitas.org/adopt/luna/apply?paso=3';
  const anchor = (href: string, attrs: Record<string, string> = {}) => ({
    getAttribute: (name: string) => (name === 'href' ? href : (attrs[name] ?? null)),
    hasAttribute: (name: string) => name in attrs,
    closest(this: unknown) {
      return this;
    },
  });
  const click = (target: unknown, init: Partial<MouseEvent> = {}) => ({
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    defaultPrevented: false,
    target: target as EventTarget,
    ...init,
  });
  assert.equal(inAppDestination(click(anchor('/adopt')), here), 'https://wawitas.org/adopt');
  assert.equal(inAppDestination(click(anchor('/privacy#x')), here), 'https://wawitas.org/privacy#x');
  assert.equal(inAppDestination(click(anchor('https://wa.me/1')), here), null);
  assert.equal(inAppDestination(click(anchor('/adopt', { target: '_blank' })), here), null);
  assert.equal(inAppDestination(click(anchor('/adopt', { target: '_self' })), here), 'https://wawitas.org/adopt');
  assert.equal(inAppDestination(click(anchor('/adopt', { download: '' })), here), null);
  assert.equal(inAppDestination(click(anchor('/adopt'), { shiftKey: true }), here), null);
  assert.equal(inAppDestination(click(anchor('/adopt'), { button: 2 }), here), null);
  assert.equal(inAppDestination(click(anchor('/adopt'), { defaultPrevented: true }), here), null);
  assert.equal(inAppDestination(click(anchor('#main')), here), null, 'a jump within the same page');
  assert.equal(inAppDestination(click(null), here), null);
});

test('the leave dialog: our words, the safe choice first, never a browser box', () => {
  const raw = renderToStaticMarkup(createElement(LeaveDialog, { onStay: () => {}, onLeave: () => {} }));
  const html = decode(raw);
  assert.match(raw, /role="alertdialog" aria-modal="true" aria-labelledby="apply-leave-title"/);
  // The buttons, not the title (which also says "Salir sin enviar").
  assert.ok(html.indexOf('>Seguir aquí</button>') > 0);
  assert.ok(html.indexOf('>Seguir aquí</button>') < html.indexOf('>Salir sin enviar</button>'));
  assert.ok(html.includes(es.applicationSteps.leaveBody));
  assert.equal(count(raw, 'btn--action'), 0, 'leaving is not the loud action');
});

test("the acceptance is the owner's sentence, verbatim, whatever the pet is called (review 4c-2 #5)", () => {
  // The owner's sentence (2026-10-17) names no animal, so no name can enter
  // it — and a name that looks like a replacement pattern must not either.
  const OWNER =
    'He leído y acepto el Formulario de Adopción, sus Compromisos (Ley N° 700) y autorizo el tratamiento y almacenamiento seguro de mis datos personales, imágenes y ubicación de domicilio mientras mantenga la custodia del animalito.';
  assert.equal(ADOPTION_ACCEPTANCE.label, OWNER);
  for (const name of ['Luna', 'Toby $&', "O'Brien $'", 'A $` B', '$1 {mascota}']) {
    assert.equal(acceptanceLabelFor(name), OWNER, name);
  }
  assert.ok(decode(view('review', { petName: 'Toby $&' })).includes(OWNER));
  assert.ok(!/ACCEPTANCE_PET_TOKEN,\s*petName\)|\.replace\(ACCEPTANCE_PET_TOKEN/.test(code(STEPPER)), 'String.replace is back');
});

test('the review says what is TRUE about the photo now (review 4c-2 #3)', () => {
  assert.equal(photoSummary(READY), 'Foto lista para enviar.');
  assert.equal(photoSummary({ kind: 'empty' }), 'Falta la foto de tu carnet.');
  assert.equal(photoSummary({ kind: 'problem', problem: 'unreadable' }), 'Falta la foto de tu carnet.');
  assert.equal(photoSummary({ kind: 'preparing' }), 'Preparando la foto…');
  assert.ok(decode(view('review', { photo: { kind: 'empty' } })).includes('Falta la foto de tu carnet.'));
  assert.ok(!decode(view('review', { photo: { kind: 'empty' } })).includes('Foto lista para enviar.'));
});

// ─── "Falta tu carnet" ──────────────────────────────────────────────────────

const MINE: MyApplication = {
  id: 'pet1__uid1',
  petId: 'pet1',
  status: 'submitted',
  submittedAt: 1_760_000_000_000,
  updatedAt: 1_760_000_000_000,
  idDocumentMissing: true,
  identityErased: false,
};

test('«Mis solicitudes» asks again for the consent record of every OPEN, not-erased application only', () => {
  assert.deepEqual(
    needsAcceptanceRecord([
      MINE,
      { ...MINE, id: 'pet2__uid1', status: 'interview' },
      { ...MINE, id: 'pet3__uid1', status: 'withdrawn' },
      { ...MINE, id: 'pet4__uid1', status: 'approved' },
      { ...MINE, id: 'pet5__uid1', identityErased: true },
    ]),
    ['pet1__uid1', 'pet2__uid1'],
  );
  assert.equal(DEFAULT_MY_APPLICATIONS_SERVICES.recordAcceptance, recordAcceptance);
});

function mine(overrides: Partial<Parameters<typeof MyApplicationsView>[0]> = {}): string {
  return decode(
    renderToStaticMarkup(
      createElement(MyApplicationsView, {
        items: [MINE],
        pets: new Map(),
        error: null,
        confirming: null,
        busy: false,
        uploadEnabled: true,
        uploadingFor: null,
        uploadedFor: null,
        uploader: null,
        onAskUpload: () => {},
        onAskWithdraw: () => {},
        onWithdraw: () => {},
        onKeep: () => {},
        ...overrides,
      }),
    ),
  );
}

test('«Mis solicitudes» says «Falta la foto de tu carnet» and offers «Subir foto» while the form is on', () => {
  const html = mine();
  assert.ok(html.includes(es.applicationSteps.carnetMissing));
  assert.ok(html.includes('>Subir foto</button>'));
  assert.ok(html.includes('>Retirar solicitud</button>'), 'withdrawal is still offered');
  const received = mine({ items: [{ ...MINE, idDocumentMissing: false }] });
  assert.ok(!received.includes('Falta la foto') && !received.includes('Subir foto'));
});

test('with the switch OFF (the kill switch), no upload is offered — the route would 404 — and WhatsApp is named', () => {
  const html = mine({ uploadEnabled: false });
  assert.ok(!html.includes('Subir foto'));
  assert.ok(html.includes(es.applicationSteps.carnetMissingPaused));
  assert.match(code('src/app/account/MyApplications.tsx'), /uploadEnabled=\{SHELTER\.adoptionApplications\.enabled\}/);
});

test('the open uploader replaces the button under its own application, and a receipt is confirmed', () => {
  const html = mine({ uploadingFor: MINE.id, uploader: createElement('div', { className: 'stub-uploader' }) });
  assert.ok(html.includes('stub-uploader'));
  assert.ok(!html.includes('>Subir foto</button>'));
  const done = mine({ items: [{ ...MINE, idDocumentMissing: false }], uploadedFor: MINE.id });
  assert.ok(done.includes(es.applicationSteps.uploadDone));
});

test('a received carnet is shown at once, and a failed reload keeps what was on screen (review 4c-2 #7)', () => {
  const other = { ...MINE, id: 'pet2__uid1', petId: 'pet2' };
  assert.deepEqual(
    withCarnetReceived([MINE, other], MINE.id)?.map((m) => m.idDocumentMissing),
    [false, true],
  );
  assert.equal(withCarnetReceived(null, MINE.id), null);
  assert.deepEqual(itemsAfterFailedLoad([MINE]), [MINE]);
  assert.deepEqual(itemsAfterFailedLoad(null), []);
  const src = code('src/app/account/MyApplications.tsx');
  assert.match(src, /setItems\(itemsAfterFailedLoad\);/);
  assert.ok(!/setItems\(\[\]\)/.test(src), 'a failed load empties the list again');
  assert.match(src, /setItems\(\(previous\) => withCarnetReceived\(previous, id\)\);/);
});

test('the uploader: pickers, then «Subir esta foto» only once a photo is ready, and the problem in words', () => {
  const render = (state: IdPhotoState, problem: IdUploadProblem | null = null, phase: 'idle' | 'uploading' | 'done' = 'idle') =>
    decode(renderToStaticMarkup(createElement(IdPhotoUploaderView, { state, phase, problem, onFile: () => {}, onUpload: () => {} })));
  assert.ok(!render({ kind: 'empty' }).includes('Subir esta foto'));
  assert.ok(render(READY).includes('>Subir esta foto</button>'));
  assert.ok(render(READY, 'retry').includes(es.applicationSteps.uploadProblem('retry')));
  assert.ok(render(READY, null, 'uploading').includes('Subiendo la foto de tu carnet…'));
  assert.ok(render({ kind: 'empty' }, null, 'done').includes(es.applicationSteps.uploadDone));
});

test('the apply page offers the upload for an existing application whose carnet is missing', () => {
  const src = code(FORM);
  assert.match(src, /case 'existing':\s*return \(\s*<ExistingApplication/);
  assert.match(src, /<IdPhotoUploader\s+user=\{user\}\s+applicationId=\{phase\.application\.id\}/);
  const existing = (application: MyApplication, justUploaded = false) =>
    decode(
      renderToStaticMarkup(
        createElement(ExistingApplication, {
          application,
          justUploaded,
          uploader: createElement('div', { className: 'stub-uploader' }),
        }),
      ),
    );
  const missing = existing(MINE);
  assert.ok(missing.includes(es.applicationSteps.carnetMissing) && missing.includes('stub-uploader'));
  assert.ok(missing.includes('Ya enviaste una solicitud para este animalito.'), 'a second form instead of the status');
  const received = existing({ ...MINE, idDocumentMissing: false }, true);
  assert.ok(!received.includes('stub-uploader') && received.includes(es.applicationSteps.uploadDone));
});

test('the signed-out gate: what this is, then sign-in that returns here, then the commitments to read first', () => {
  assert.match(code(FORM), /if \(!user\) return <SignInGate slug=\{slug\} \/>;/);
  const raw = renderToStaticMarkup(createElement(SignInGate, { slug: 'luna' }));
  const html = decode(raw);
  assert.ok(html.indexOf(es.applicationSteps.gateIntro) < html.indexOf('Entrar o crear cuenta'));
  assert.match(raw, /href="\/account\?next=%2Fadopt%2Fluna%2Fapply"/);
  assert.match(raw, /<a class="auth__link" href="\/adopt\/contract">Leer el compromiso<\/a>/);
  assert.equal(count(raw, 'btn--action'), 1);
});

test('MyApplication decides «missing» and «erased» through the shared predicates', () => {
  const client = code('src/lib/applications-client.ts');
  assert.match(client, /const identityErased = isIdentityErased\(data\.identityErasedAt\);/);
  assert.match(client, /idDocumentBadge\(\{ status, idDocument: data\.idDocument as IdDocumentMarker \| undefined, identityErased \}\) ===\s*'missing'/);
});

// ─── /adopt/contract ────────────────────────────────────────────────────────

test('/adopt/contract 404s while the form is off, keeps revalidate = 300, is noindex and not in the sitemap', async () => {
  const src = code(CONTRACT_PAGE);
  assert.match(src, /^export const revalidate = 300;$/m);
  assert.match(src, /if \(!SHELTER\.adoptionApplications\.enabled \|\| ADOPTION_CONTRACT === null\) notFound\(\);/);
  assert.match(src, /robots: \{ index: false, follow: false \}/);
  assert.ok(!STATIC_SITEMAP_ROUTES.some((route) => route.includes('contract')));
  // Rendered for real: switched off, it throws Next's 404.
  assert.equal(config.enabled, false);
  const { default: ContractPage } = await import('@/app/adopt/contract/page');
  assert.throws(
    () => ContractPage(),
    (err: unknown) => /404/.test(String((err as { digest?: unknown })?.digest ?? '')),
  );
});

test('the apply page 404s without a contract, and hands the stepper only PUBLIC pet facts', () => {
  const src = code('src/app/adopt/[slug]/apply/page.tsx');
  assert.match(src, /if \(contract === null\) notFound\(\);/);
  assert.match(src, /petFactRows\(pet, config\.petSection,/);
  assert.ok(!/getPetDetail|medical|identity/.test(src), 'the apply page reads a non-public tier');
});

// ─── the copy ───────────────────────────────────────────────────────────────

function allStepCopy(): string[] {
  const c = es.applicationSteps;
  const out: string[] = [];
  for (const value of Object.values(c)) if (typeof value === 'string') out.push(value);
  out.push(
    c.stepOf(3, 7, 'Dónde vivirá Luna'),
    c.titleAddress('Luna'),
    c.addressLead('Luna'),
    c.changeStep('Tu carnet'),
    c.contractPageIntro('Wawitas'),
    ...(['unreadable', 'too-small', 'rejected', 'failed'] as const).map((p) => c.photoProblem(p)),
    ...(['retry', 'closed', 'sign-in', 'paused', 'photo-too-small', 'photo-rejected'] as const).map((p) => c.uploadProblem(p)),
    es.applications.submitRefused,
  );
  return out;
}

test('every new line of copy is neutral tuteo — no voseo — and none is empty', () => {
  const copy = allStepCopy();
  assert.ok(copy.length >= 60, `only ${copy.length} strings: the walk is not reading the catalogue`);
  for (const text of copy) {
    assert.ok(text.trim() !== '', 'empty copy');
    assert.deepEqual(findVoseo(text), [], text);
  }
});

test('no applicant copy promises a retention period (that is 4f, with /privacy)', () => {
  for (const text of allStepCopy()) {
    assert.ok(!/\b(\d+\s*d[ií]as|se borra|borramos|eliminamos|30)\b/i.test(text), text);
  }
});

test('the refused-send copy names the three reasons, including a changed contract', () => {
  assert.equal(
    es.applications.submitRefused,
    'No pudimos guardar la solicitud. Puede que este animalito ya no esté disponible, que ya hayas postulado o que el compromiso haya cambiado: recarga la página.',
  );
});

test("the paper's section 4 labels are verbatim, «GENERO» without its accent", () => {
  assert.deepEqual(config.petSection, {
    title: 'DATOS DEL PELUDITO ADOPTADO',
    name: 'NOMBRE',
    age: 'EDAD',
    breed: 'RAZA',
    color: 'COLOR',
    species: 'ESPECIE',
    sex: 'GENERO',
    speciesValues: { dog: 'CANINO', cat: 'FELINO' },
    sexValues: { female: 'HEMBRA', male: 'MACHO' },
  });
});
