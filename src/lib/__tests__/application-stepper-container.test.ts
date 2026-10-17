/**
 * The applicant's form, MOUNTED — the real `ApplicationStepper`, the real
 * `IdPhotoUploader` and the real `MyApplications`, rendered by React DOM's
 * client renderer into `fake-dom.ts` (review 4c-2). What a static render
 * cannot see: the container's own initial state, its history, its guards
 * against leaving, and the photo's lifecycle.
 *
 * Run with:  node --test --import tsx src/lib/__tests__/application-stepper-container.test.ts
 *
 * Honest about its instrument: a fake DOM, no browser. It proves what the
 * containers DO with the DOM and the history they are given — not that a real
 * Chrome or Safari behaves the same (that is the 360px and phone pass).
 * Firebase is never reached: `submit`, `upload` and `navigate` are injected,
 * and the one test of the default upload path stubs `fetch`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FakeEvent,
  check,
  chooseFile,
  click,
  find,
  findAll,
  installFakeDom,
  textOf,
  type FakeElement,
  type Installed,
} from './fake-dom';

const APPLY = 'https://wawitas.org/adopt/luna/apply';
const DOSSIER = 'https://wawitas.org/adopt/luna';

// React decides whether it runs in a browser when its module loads, so the
// fake goes on globalThis before the first import of react-dom.
let first: Installed | null = installFakeDom(APPLY, [DOSSIER]);

async function modules() {
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const stepper = await import('@/app/adopt/[slug]/apply/ApplicationStepper');
  const photo = await import('@/app/adopt/[slug]/apply/IdPhotoStep');
  const mine = await import('@/app/account/MyApplications');
  const { SHELTER } = await import('@/config/shelter');
  const { ADOPTION_CONTRACT } = await import('@/config/adoption-contract');
  const { questionDomId } = await import('@/app/adopt/[slug]/apply/ApplicationFields');
  return { React, createRoot, stepper, photo, mine, SHELTER, ADOPTION_CONTRACT, questionDomId };
}

type Modules = Awaited<ReturnType<typeof modules>>;
let loaded: Modules | null = null;
async function load(): Promise<Modules> {
  loaded ??= await modules();
  return loaded;
}

const sleep = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

/** Let every queued timer, popstate, photo encode and state update finish, inside act. */
async function settle(m: Modules, rounds = 12) {
  await m.React.act(async () => {
    for (let i = 0; i < rounds; i += 1) await sleep(0);
  });
}

async function act(m: Modules, fn: () => void) {
  await m.React.act(async () => {
    fn();
  });
  await settle(m);
}

const USER = { uid: 'u1', getIdToken: async () => 'token' };

interface Mounted {
  m: Modules;
  env: Installed;
  calls: { submit: unknown[][]; upload: unknown[][]; accept: unknown[][]; navigate: string[]; order: string[] };
  unmount: () => Promise<void>;
}

async function mountStepper(
  options: { upload?: (...args: unknown[]) => Promise<unknown>; accept?: (...args: unknown[]) => Promise<unknown> } = {},
): Promise<Mounted> {
  const env = first ?? installFakeDom(APPLY, [DOSSIER]);
  first = null;
  const m = await load();
  const calls: Mounted['calls'] = { submit: [], upload: [], accept: [], navigate: [], order: [] };
  const services = {
    submit: async (...args: unknown[]) => {
      calls.submit.push(args);
      calls.order.push('submit');
      return 'pet1__u1';
    },
    upload: async (...args: unknown[]) => {
      calls.upload.push(args);
      calls.order.push('upload');
      return options.upload ? options.upload(...args) : { ok: true };
    },
    recordAcceptance: async (...args: unknown[]) => {
      calls.accept.push(args);
      calls.order.push('accept');
      return options.accept ? options.accept(...args) : { ok: true };
    },
    navigate: (href: string) => {
      calls.navigate.push(href);
    },
  };
  const container = env.document.createElement('div');
  env.document.body.appendChild(container);
  const root = m.createRoot(container as unknown as Element);
  await m.React.act(async () => {
    root.render(
      m.React.createElement(m.stepper.ApplicationStepper, {
        user: USER as never,
        petId: 'pet1',
        petName: 'Luna',
        slug: 'luna',
        shelterName: 'Wawitas',
        questions: m.SHELTER.adoptionApplications.questions,
        contract: m.ADOPTION_CONTRACT!,
        petFacts: [{ label: 'NOMBRE', value: 'Luna' }],
        services: services as never,
      }),
    );
  });
  await settle(m);
  return {
    m,
    env,
    calls,
    unmount: async () => {
      await m.React.act(async () => root.unmount());
    },
  };
}

const heading = (h: Mounted) => textOf(find(h.env.document, 'h2'));
const button = (h: Mounted, text: string) => find(h.env.document, 'button', text);
const field = (h: Mounted, id: string) => {
  const element = h.env.document.getElementById(h.m.questionDomId(id));
  assert.ok(element, `no field ${id}`);
  return element as FakeElement;
};

async function typeInto(h: Mounted, element: FakeElement, value: string) {
  await act(h.m, () => {
    element.value = value;
    element.dispatchEvent(new FakeEvent('input', { bubbles: true }));
  });
}

async function pick(h: Mounted, questionId: string, value: string) {
  const radio = find(h.env.document, `input[name="${h.m.questionDomId(questionId)}"][value="${value}"]`);
  await act(h.m, () => check(radio));
}

async function choosePhoto(h: Mounted) {
  const camera = find(h.env.document, 'input[capture]');
  await act(h.m, () => chooseFile(camera, new Blob(['raw'])));
}

async function next(h: Mounted) {
  await act(h.m, () => click(button(h, 'ontinuar')));
}

/** Steps 1 to 6 answered as a person on a flat they own would; ends on the review. */
async function fillToReview(h: Mounted) {
  await next(h); // 1 → 2
  await choosePhoto(h);
  await next(h); // 2 → 3
  await typeInto(h, h.env.document.getElementById('apply-home-address') as FakeElement, 'Calle Sucre 123, zona central');
  await next(h); // 3 → 4
  await typeInto(h, field(h, 'fullName'), 'Ana Pérez');
  await typeInto(h, field(h, 'ciNumber'), '1234567');
  await typeInto(h, field(h, 'age'), '34');
  await typeInto(h, field(h, 'civilStatus'), 'soltera');
  await typeInto(h, field(h, 'whatsapp'), '77903553');
  await next(h); // 4 → 5
  for (const [id, value] of [
    ['personalRefName', 'Carla'],
    ['personalRefPhone', '70712345'],
    ['personalRefRelation', 'amiga'],
    ['familyRefName', 'Luis'],
    ['familyRefPhone', '71234567'],
    ['familyRefRelation', 'hermano'],
  ] as const) {
    await typeInto(h, field(h, id), value);
  }
  await next(h); // 5 → 6
  await pick(h, 'housingType', 'apartment');
  await pick(h, 'housingTenure', 'owned');
  await pick(h, 'movingSoon', 'false');
  await next(h); // 6 → 7
  assert.equal(heading(h), 'Paso 7 de 7 · Revisar y enviar');
}

const acceptanceBox = (h: Mounted) => h.env.document.getElementById('apply-acceptance') as FakeElement;

// ─── the container's own initial state ──────────────────────────────────────

test('CONTAINER: the acceptance box starts unticked, and «Enviar» without it sends nothing', async () => {
  const h = await mountStepper();
  await fillToReview(h);
  assert.equal(acceptanceBox(h).checked, false, 'the box is ticked before the person ticked it');
  await act(h.m, () => click(button(h, 'Enviar solicitud')));
  assert.equal(h.calls.submit.length, 0, 'sent without the box');
  assert.ok(textOf(h.env.document).includes('Marca la casilla para enviar tu solicitud.'));
  await act(h.m, () => check(acceptanceBox(h)));
  await act(h.m, () => click(button(h, 'Enviar solicitud')));
  assert.equal(h.calls.submit.length, 1);
  const submission = h.calls.submit[0]![2] as { acceptance: unknown; identity: Record<string, unknown>; answers: Record<string, unknown> };
  assert.deepEqual(submission.acceptance, { accepted: true, contractVersion: h.m.ADOPTION_CONTRACT!.version });
  assert.equal(submission.identity.ciNumber, '1234567');
  assert.ok(!('ciNumber' in submission.answers));
  await h.unmount();
});

test('CONTAINER: the batch is sent first, and the photo only after it, to that application', async () => {
  const h = await mountStepper();
  await fillToReview(h);
  await act(h.m, () => check(acceptanceBox(h)));
  await act(h.m, () => click(button(h, 'Enviar solicitud')));
  assert.equal(h.calls.submit.length, 1);
  assert.equal(h.calls.upload.length, 1);
  assert.equal(h.calls.upload[0]![1], 'pet1__u1', 'the photo went to another application');
  assert.equal(h.calls.upload[0]![2], 'front');
  assert.equal(textOf(find(h.env.document, 'h2')), 'Recibimos tu solicitud');
  await h.unmount();
});

test('CONTAINER: the consent is recorded after the batch and before the photo, for that application', async () => {
  const h = await mountStepper();
  await fillToReview(h);
  await act(h.m, () => check(acceptanceBox(h)));
  await act(h.m, () => click(button(h, 'Enviar solicitud')));
  assert.deepEqual(h.calls.order, ['submit', 'accept', 'upload']);
  assert.equal(h.calls.accept[0]![1], 'pet1__u1');
  await h.unmount();
});

test('CONTAINER: a consent record that fails does not stop the photo or the confirmation', async () => {
  const h = await mountStepper({ accept: async () => ({ ok: false, failure: 'network' }) });
  await fillToReview(h);
  await act(h.m, () => check(acceptanceBox(h)));
  await act(h.m, () => click(button(h, 'Enviar solicitud')));
  assert.deepEqual(h.calls.order, ['submit', 'accept', 'upload']);
  assert.equal(textOf(find(h.env.document, 'h2')), 'Recibimos tu solicitud');
  await h.unmount();
});

// ─── the history ────────────────────────────────────────────────────────────

test('CONTAINER: the entry the form opened in is a GUARD, and step 1 is pushed on top of it', async () => {
  const h = await mountStepper();
  assert.deepEqual(h.env.window.history.steps(), ['-/adopt/luna', '-/adopt/luna/apply', '1']);
  assert.equal(heading(h), 'Paso 1 de 7 · El compromiso');
  await h.unmount();
});

test('CONTAINER: a forged forward entry cannot jump past the furthest step reached', async () => {
  const h = await mountStepper();
  await next(h); // step 2: furthest is 2
  const history = h.env.window.history;
  history.entries.push({ state: history.current.state, url: `${APPLY}?paso=7` });
  history.go(1);
  await settle(h.m);
  assert.equal(heading(h), 'Paso 2 de 7 · Tu carnet', 'the history skipped steps 3 to 6');
  assert.equal(history.steps()[history.index], '2', 'the entry no longer says the step on screen');
  await h.unmount();
});

test('CONTAINER: «Atrás» travels back through the history — it never adds an entry, so the back gesture never goes forward', async () => {
  const h = await mountStepper();
  await next(h);
  await choosePhoto(h);
  await next(h); // step 3
  assert.equal(heading(h), 'Paso 3 de 7 · Dónde vivirá Luna');
  const before = h.env.window.history.length;
  await act(h.m, () => click(button(h, 'Atrás')));
  assert.equal(heading(h), 'Paso 2 de 7 · Tu carnet');
  assert.equal(h.env.window.history.length, before, '«Atrás» pushed an entry');
  h.env.window.history.back(); // the gesture
  await settle(h.m);
  assert.equal(heading(h), 'Paso 1 de 7 · El compromiso', 'the back gesture went forward');
  // And the browser's forward button retraces the same steps.
  h.env.window.history.forward();
  await settle(h.m);
  assert.equal(heading(h), 'Paso 2 de 7 · Tu carnet');
  await h.unmount();
});

test('CONTAINER: «Cambiar» and "Guardar y volver a revisar" travel through existing entries, both ways', async () => {
  const h = await mountStepper();
  await fillToReview(h);
  const length = h.env.window.history.length;
  const [change] = findAll(h.env.document, 'button', 'Cambiar').filter((b) => b.getAttribute('aria-label')?.includes('DATOS PERSONALES'));
  assert.ok(change);
  await act(h.m, () => click(change));
  assert.equal(heading(h), 'Paso 4 de 7 · DATOS PERSONALES');
  assert.ok(button(h, 'Guardar y volver a revisar'));
  await act(h.m, () => click(button(h, 'Guardar y volver a revisar')));
  assert.equal(heading(h), 'Paso 7 de 7 · Revisar y enviar');
  assert.equal(h.env.window.history.length, length, 'a travel pushed an entry');
  h.env.window.history.back();
  await settle(h.m);
  assert.equal(heading(h), 'Paso 6 de 7 · DOMICILIO', 'the back gesture from the review is not one step back');
  await h.unmount();
});

test('CONTAINER: «Enviar» re-checks EVERY step first — an answer emptied after the review is caught, nothing is sent', async () => {
  const h = await mountStepper();
  await fillToReview(h);
  const [change] = findAll(h.env.document, 'button', 'Cambiar').filter((b) => b.getAttribute('aria-label')?.includes('DATOS PERSONALES'));
  await act(h.m, () => click(change!));
  await typeInto(h, field(h, 'fullName'), '');
  // The browser's forward button, straight back to the review entry.
  h.env.window.history.go(3);
  await settle(h.m);
  assert.equal(heading(h), 'Paso 7 de 7 · Revisar y enviar');
  await act(h.m, () => check(acceptanceBox(h)));
  await act(h.m, () => click(button(h, 'Enviar solicitud')));
  assert.equal(h.calls.submit.length, 0, 'sent with an empty name');
  assert.equal(heading(h), 'Paso 4 de 7 · DATOS PERSONALES', 'not sent back to the gap');
  assert.ok(textOf(h.env.document).includes('Esta pregunta es obligatoria.'));
  await h.unmount();
});

// ─── the photo's lifecycle ──────────────────────────────────────────────────

test("CONTAINER: the preview URL is revoked when a photo is replaced, and when the form unmounts", async () => {
  const h = await mountStepper();
  await next(h);
  await choosePhoto(h);
  assert.equal(h.env.created.length, 1);
  const firstUrl = h.env.created[0]!;
  assert.equal(find(h.env.document, 'img').getAttribute('src'), firstUrl);
  await choosePhoto(h);
  assert.equal(h.env.created.length, 2);
  assert.ok(h.env.revoked.includes(firstUrl), 'the replaced preview was never revoked');
  const secondUrl = h.env.created[1]!;
  assert.ok(!h.env.revoked.includes(secondUrl));
  await h.unmount();
  assert.ok(h.env.revoked.includes(secondUrl), 'the preview outlived the form');
});

test('CONTAINER: after a successful upload the photo is dropped and its preview revoked, with the form still on screen', async () => {
  const h = await mountStepper();
  await fillToReview(h);
  const url = h.env.created[h.env.created.length - 1]!;
  await act(h.m, () => check(acceptanceBox(h)));
  await act(h.m, () => click(button(h, 'Enviar solicitud')));
  assert.equal(textOf(find(h.env.document, 'h2')), 'Recibimos tu solicitud');
  assert.ok(h.env.revoked.includes(url), 'the carnet photo stayed in the tab after it arrived');
  assert.equal(h.env.document.activeElement, find(h.env.document, 'h2'), 'focus did not move to the confirmation');
  await h.unmount();
});

test('CONTAINER: a retryable failure keeps the photo for «Reintentar»; a closed application drops it and names no later upload', async () => {
  const answers: unknown[] = [
    { ok: false, failure: 'marker-failed' },
    { ok: true },
  ];
  const h = await mountStepper({ upload: async () => answers.shift() });
  await fillToReview(h);
  await act(h.m, () => check(acceptanceBox(h)));
  await act(h.m, () => click(button(h, 'Enviar solicitud')));
  const failedHeading = find(h.env.document, 'h2');
  assert.ok(textOf(failedHeading).startsWith('Tu solicitud llegó, pero la foto de tu carnet no.'));
  assert.equal(h.env.document.activeElement, failedHeading, 'focus did not move to the outcome');
  assert.ok(textOf(h.env.document).includes('También puedes subirla después desde «Mis solicitudes».'));
  assert.equal(h.env.revoked.length, h.env.created.length - 1, 'the photo was dropped before the retry');
  await act(h.m, () => click(button(h, 'Reintentar')));
  assert.equal(h.calls.upload.length, 2);
  assert.equal(textOf(find(h.env.document, 'h2')), 'Recibimos tu solicitud');
  await h.unmount();

  const closed = await mountStepper({ upload: async () => ({ ok: false, failure: 'not-open' }) });
  await fillToReview(closed);
  await act(closed.m, () => check(acceptanceBox(closed)));
  await act(closed.m, () => click(button(closed, 'Enviar solicitud')));
  const text = textOf(closed.env.document);
  assert.ok(text.includes('Esta solicitud ya está cerrada'));
  assert.ok(!text.includes('También puedes subirla después'), 'a later upload is promised for a closed application');
  assert.ok(findAll(closed.env.document, 'button', 'Reintentar').length === 0);
  assert.ok(closed.env.revoked.includes(closed.env.created[closed.env.created.length - 1]!), 'a photo nothing can take stayed in the tab');
  await closed.unmount();
});

test("CONTAINER: the review says what is true about the photo — not «lista» once it is gone", async () => {
  const h = await mountStepper();
  await fillToReview(h);
  assert.ok(textOf(h.env.document).includes('Foto lista para enviar.'));
  const [change] = findAll(h.env.document, 'button', 'Cambiar').filter((b) => b.getAttribute('aria-label')?.includes('Tu carnet'));
  await act(h.m, () => click(change!));
  assert.equal(heading(h), 'Paso 2 de 7 · Tu carnet');
  h.env.nextBitmap = { width: 1, height: 1, unreadable: true };
  await choosePhoto(h);
  assert.ok(textOf(h.env.document).includes('No pudimos abrir esta foto.'));
  h.env.window.history.go(5); // the forward button, to the review entry
  await settle(h.m);
  assert.equal(heading(h), 'Paso 7 de 7 · Revisar y enviar');
  const text = textOf(h.env.document);
  assert.ok(!text.includes('Foto lista para enviar.'), 'the review claims a photo that is not there');
  assert.ok(text.includes('Falta la foto de tu carnet.'));
  await h.unmount();
});

// ─── leaving with something unsent ──────────────────────────────────────────

function headerLink(env: Installed, href: string, attrs: Record<string, string> = {}) {
  const a = env.document.createElement('a');
  a.setAttribute('href', href);
  for (const [k, v] of Object.entries(attrs)) a.setAttribute(k, v);
  a.textContent = 'Adoptar';
  env.document.body.insertBefore(a, env.document.body.firstChild);
  return a;
}

function clickLink(a: FakeElement, init: Record<string, unknown> = {}) {
  const event = new FakeEvent('click', { bubbles: true, cancelable: true, button: 0, ...init });
  a.dispatchEvent(event);
  return event;
}

test('CONTAINER: with nothing typed, an in-app link and a reload are not stopped', async () => {
  const h = await mountStepper();
  const link = headerLink(h.env, '/adopt');
  let event!: FakeEvent;
  await act(h.m, () => {
    event = clickLink(link);
  });
  assert.equal(event.defaultPrevented, false);
  assert.equal(findAll(h.env.document, '.apply-leave').length, 0);
  const unload = new FakeEvent('beforeunload', { cancelable: true });
  h.env.window.dispatchEvent(unload);
  assert.equal(unload.defaultPrevented, false);
  await h.unmount();
});

test('CONTAINER: with a photo chosen, an in-app link opens the inline dialog — «Seguir aquí» stays, «Salir sin enviar» leaves', async () => {
  const h = await mountStepper();
  await next(h);
  await choosePhoto(h);
  const link = headerLink(h.env, '/adopt?x=1');
  let event!: FakeEvent;
  await act(h.m, () => {
    event = clickLink(link);
  });
  assert.equal(event.defaultPrevented, true, 'the <Link> would have navigated');
  const dialog = find(h.env.document, '[role="alertdialog"]');
  assert.ok(textOf(dialog).includes('¿Salir sin enviar tu solicitud?'));
  assert.equal(h.env.document.activeElement, find(h.env.document, 'button', 'Seguir aquí'), 'focus is not on the safe choice');
  await act(h.m, () => click(button(h, 'Seguir aquí')));
  assert.equal(findAll(h.env.document, '.apply-leave').length, 0);
  assert.equal(h.calls.navigate.length, 0);
  assert.equal(heading(h), 'Paso 2 de 7 · Tu carnet', 'staying lost the step');

  await act(h.m, () => {
    clickLink(link);
  });
  await act(h.m, () => click(button(h, 'Salir sin enviar')));
  assert.deepEqual(h.calls.navigate, ['https://wawitas.org/adopt?x=1']);
  const unload = new FakeEvent('beforeunload', { cancelable: true });
  h.env.window.dispatchEvent(unload);
  assert.equal(unload.defaultPrevented, false, 'the browser would ask a second time');
  await h.unmount();
});

test('CONTAINER: Escape keeps the person here; a reload warns while anything is unsent', async () => {
  const h = await mountStepper();
  await next(h);
  await choosePhoto(h);
  const unload = new FakeEvent('beforeunload', { cancelable: true });
  h.env.window.dispatchEvent(unload);
  assert.equal(unload.defaultPrevented, true);
  await act(h.m, () => {
    clickLink(headerLink(h.env, '/about'));
  });
  await act(h.m, () => {
    find(h.env.document, 'button', 'Seguir aquí').dispatchEvent(new FakeEvent('keydown', { bubbles: true, key: 'Escape' }));
  });
  assert.equal(findAll(h.env.document, '.apply-leave').length, 0);
  assert.equal(h.calls.navigate.length, 0);
  await h.unmount();
});

test('CONTAINER: another origin, a new tab, a modified click and a same-page anchor are not intercepted', async () => {
  const h = await mountStepper();
  await next(h);
  await choosePhoto(h);
  const cases: [FakeElement, Record<string, unknown>][] = [
    [headerLink(h.env, 'https://wa.me/59177903553'), {}],
    [headerLink(h.env, '/adopt', { target: '_blank' }), {}],
    [headerLink(h.env, '/adopt', { download: '' }), {}],
    [headerLink(h.env, '/adopt'), { ctrlKey: true }],
    [headerLink(h.env, '/adopt'), { button: 1 }],
    [headerLink(h.env, '#main'), {}],
  ];
  for (const [link, init] of cases) {
    let event!: FakeEvent;
    await act(h.m, () => {
      event = clickLink(link, init);
    });
    assert.equal(event.defaultPrevented, false, `${link.getAttribute('href')} ${JSON.stringify(init)}`);
  }
  assert.equal(findAll(h.env.document, '.apply-leave').length, 0);
  await h.unmount();
});

test('CONTAINER: the back gesture from step 1 with something unsent lands on the guard and asks; «Salir sin enviar» goes to the page before', async () => {
  const h = await mountStepper();
  await next(h);
  await choosePhoto(h);
  await act(h.m, () => click(button(h, 'Atrás')));
  assert.equal(heading(h), 'Paso 1 de 7 · El compromiso');
  h.env.window.history.back(); // the gesture, from step 1
  await settle(h.m);
  assert.equal(heading(h), 'Paso 1 de 7 · El compromiso');
  assert.ok(find(h.env.document, '[role="alertdialog"]'), 'left the form without asking');
  assert.equal(h.env.window.location.search, '?paso=1', 'the guard was not re-armed');
  await act(h.m, () => click(button(h, 'Salir sin enviar')));
  await settle(h.m);
  assert.equal(h.env.window.location.href, DOSSIER, 'did not go back to the page before the form');
  await h.unmount();
});

test('CONTAINER: the back gesture from step 1 with nothing typed simply leaves, without asking', async () => {
  const h = await mountStepper();
  h.env.window.history.back();
  await settle(h.m);
  assert.equal(findAll(h.env.document, '.apply-leave').length, 0);
  assert.equal(h.env.window.location.href, DOSSIER);
  await h.unmount();
});

// ─── the uploader and «Mis solicitudes» ─────────────────────────────────────

async function mountUploader(fetchAnswers: Response[]) {
  const env = first ?? installFakeDom('https://wawitas.org/account');
  first = null;
  const m = await load();
  const requests: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    requests.push({ url, init });
    return fetchAnswers.shift() ?? new Response(null, { status: 201 });
  }) as unknown as typeof fetch;
  let uploaded = 0;
  const container = env.document.createElement('div');
  env.document.body.appendChild(container);
  const root = m.createRoot(container as unknown as Element);
  await m.React.act(async () => {
    root.render(
      m.React.createElement(m.photo.IdPhotoUploader, {
        user: USER,
        applicationId: 'pet1__u1',
        onUploaded: () => {
          uploaded += 1;
        },
      }),
    );
  });
  return {
    m,
    env,
    requests,
    uploaded: () => uploaded,
    unmount: async () => {
      await m.React.act(async () => root.unmount());
    },
  };
}

test('CONTAINER: the uploader drops the photo and revokes it after the route has it', async () => {
  const u = await mountUploader([new Response(null, { status: 201 })]);
  await act(u.m, () => chooseFile(find(u.env.document, 'input[capture]'), new Blob(['raw'])));
  assert.equal(u.env.created.length, 1);
  await act(u.m, () => click(find(u.env.document, 'button', 'Subir esta foto')));
  assert.equal(u.requests.length, 1);
  assert.equal(u.requests[0]!.url, '/api/adoption-applications/pet1__u1/id-document/front');
  assert.equal(u.uploaded(), 1);
  assert.ok(u.env.revoked.includes(u.env.created[0]!), 'the uploader kept the photo after success');
  assert.ok(textOf(u.env.document).includes('Recibimos la foto de tu carnet.'));
  await u.unmount();
});

test('CONTAINER: the uploader keeps the photo for a retryable failure, and drops it for a closed application', async () => {
  const stamped = (status: number, failure: string) =>
    new Response('{}', { status, headers: { 'X-Id-Document-Failure': failure } });
  const u = await mountUploader([stamped(500, 'marker-failed'), stamped(409, 'not-open')]);
  await act(u.m, () => chooseFile(find(u.env.document, 'input[capture]'), new Blob(['raw'])));
  await act(u.m, () => click(find(u.env.document, 'button', 'Subir esta foto')));
  assert.ok(textOf(u.env.document).includes('No pudimos subir la foto de tu carnet.'));
  assert.equal(u.env.revoked.length, 0, 'a retryable failure dropped the photo');
  const input = find(u.env.document, 'input[capture]');
  assert.ok((input.getAttribute('aria-describedby') ?? '').includes('-problem'), 'the refusal is not linked to the file input');
  await act(u.m, () => click(find(u.env.document, 'button', 'Subir esta foto')));
  assert.ok(textOf(u.env.document).includes('Esta solicitud ya está cerrada'));
  assert.ok(u.env.revoked.includes(u.env.created[0]!), 'a photo nothing can take stayed in the tab');
  assert.equal(findAll(u.env.document, 'button', 'Subir esta foto').length, 0);
  await u.unmount();
});

test('CONTAINER: a carnet error is linked to the file inputs (aria-describedby), with the tips and the hint', async () => {
  const h = await mountStepper();
  await next(h);
  await act(h.m, () => click(button(h, 'Continuar'))); // no photo yet
  const inputs = findAll(h.env.document, 'input[type="file"]');
  assert.equal(inputs.length, 2);
  for (const input of inputs) {
    const ids = (input.getAttribute('aria-describedby') ?? '').split(' ');
    const described = ids.map((id) => textOf(h.env.document.getElementById(id) ?? h.env.document.createElement('i')));
    assert.ok(described.some((t) => t.includes('Toma o elige una foto de tu carnet para seguir.')), 'the error is not read with the input');
    assert.ok(described.some((t) => t.includes('buena luz')), 'the tips are not read with the input');
    assert.equal(input.getAttribute('aria-invalid'), 'true');
  }
  await h.unmount();
});

test('CONTAINER «Mis solicitudes»: after an upload the line says it arrived at once, and a failed reload keeps the list', async () => {
  const env = first ?? installFakeDom('https://wawitas.org/account');
  first = null;
  const m = await load();
  globalThis.fetch = (async () => new Response(null, { status: 201 })) as unknown as typeof fetch;
  const mine = {
    id: 'pet1__u1',
    petId: 'pet1',
    status: 'submitted' as const,
    submittedAt: 1,
    updatedAt: 1,
    idDocumentMissing: true,
    identityErased: false,
  };
  let releaseReload!: (value: unknown) => void;
  let listCalls = 0;
  const services = {
    list: async () => {
      listCalls += 1;
      if (listCalls === 1) return [mine];
      // The reload after the upload: held open, then it fails.
      await new Promise((resolve) => {
        releaseReload = resolve;
      });
      throw Object.assign(new Error('unavailable'), { code: 'unavailable' });
    },
    pets: async () => new Map(),
    withdraw: async () => {},
    recordAcceptance: async () => ({ ok: true as const }),
  };
  const container = env.document.createElement('div');
  env.document.body.appendChild(container);
  const root = m.createRoot(container as unknown as Element);
  // The upload is offered only while the form is switched on (the kill
  // switch). Flipped in THIS test process only, and restored below.
  const config = m.SHELTER.adoptionApplications as { enabled: boolean };
  const wasEnabled = config.enabled;
  config.enabled = true;
  try {
    await runMyApplications();
  } finally {
    config.enabled = wasEnabled;
    await m.React.act(async () => root.unmount());
  }

  async function runMyApplications() {
    await m.React.act(async () => {
      root.render(m.React.createElement(m.mine.MyApplications, { user: USER as never, services: services as never }));
    });
    await settle(m);
    assert.ok(textOf(env.document).includes('Falta la foto de tu carnet.'));
    await act(m, () => click(find(env.document, 'button', 'Subir foto')));
    await act(m, () => chooseFile(find(env.document, 'input[capture]'), new Blob(['raw'])));
    await act(m, () => click(find(env.document, 'button', 'Subir esta foto')));
    // The reload is still pending: the screen must already say the photo arrived.
    let text = textOf(env.document);
    assert.ok(text.includes('Recibimos la foto de tu carnet.'), 'the receipt waits for the reload');
    assert.ok(!text.includes('Falta la foto de tu carnet.'), '«Falta…» flashed back for a photo that arrived');
    assert.equal(findAll(env.document, 'button', 'Subir foto').length, 0);
    await act(m, () => releaseReload(null));
    text = textOf(env.document);
    assert.ok(text.includes('No pudimos cargar tus solicitudes.'), 'the failed reload is not reported');
    assert.ok(text.includes('Retirar solicitud'), 'a failed reload wiped the list');
  }
});
