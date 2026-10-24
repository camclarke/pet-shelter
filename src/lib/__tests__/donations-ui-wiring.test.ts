import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { PROPOSAL_ERROR_TEXT, FAILURE_TEXT, donationFailureText } from '../donations-copy';
import { formatDayKey, formatDonationDate } from '../donations-format';
import { qrFileProblem } from '../donations-client';
import { DONATION_FAILURES } from '../donations-protocol';

/**
 * Source guards for the donation screens (PR-2, UI half). No component-test
 * setup exists and `/donate` reads Firestore through the Admin SDK, so what
 * can be checked offline is the wiring: how the page is rendered and cached,
 * what the hidden state shows, where it is linked from, and that the review
 * screen cannot skip the two-person rule.
 */

const read = (path: string) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
/** Source with comments removed, so a guard cannot be satisfied by a comment. */
const code = (path: string) =>
  read(path)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/^\s*\/\/.*$/gm, '');

const DONATE = 'src/app/donate/page.tsx';
const PANEL = 'src/app/admin/donations/DonationsPanel.tsx';

test('/donate renders per request and is CDN-cached for five minutes', async () => {
  assert.match(read(DONATE), /^export const dynamic = 'force-dynamic';$/m);
  assert.ok(!/^export const revalidate\b/m.test(read(DONATE)), 'must not export revalidate');
  const { CDN_CACHED_PATHS, CDN_CACHE_CONTROL } = await import('../../../next.config');
  assert.ok(CDN_CACHED_PATHS.includes('/donate'));
  assert.match(CDN_CACHE_CONTROL, /public, s-maxage=300, stale-while-revalidate=\d+/);
});

test('/donate returns its neutral message BEFORE any bank detail when nothing is shown', () => {
  const src = code(DONATE);
  const hidden = src.indexOf('if (!settings)');
  const methods = src.indexOf('settings.methods.map');
  const number = src.indexOf('accountNumber');
  assert.ok(hidden > 0 && methods > hidden && number > hidden, 'the early return comes first');
  const shownState = src.indexOf('const holders');
  assert.ok(shownState > hidden, 'CONTROL: found the shown-state code');
  const early = src.slice(hidden, shownState);
  assert.match(early, /Por ahora recibimos ayuda por/);
  assert.ok(!/accountNumber|accountHolder|bankName|api\/donations\/qr/.test(early), 'the hidden state names no bank data');
  // Hidden state is kept out of search results, and never reads as a gap.
  assert.match(src, /robots: \{ index: false/);
  assert.ok(!/construcci[oó]n|pr[oó]ximamente|todav[ií]a no/i.test(src));
});

test('/donate: voucher block, holder check and the QR only when visible', () => {
  const src = read(DONATE);
  assert.match(src, /¿Ya donaste\?/);
  assert.match(src, /Envíanos tu comprobante por WhatsApp para agradecerte\./);
  assert.match(src, /Hola, acabo de donar a Wawitas\. Te envío mi comprobante\./);
  assert.match(src, /https:\/\/wa\.me\/\$\{SHELTER\.whatsapp\}\?text=\$\{encodeURIComponent\(VOUCHER_MESSAGE\)\}/);
  assert.match(src, /Antes de transferir, verifica que el titular sea/);
  assert.match(src, /Actualizado el/);
  assert.match(src, /\{settings\.qrVisible && \(/);
  assert.match(src, /src="\/api\/donations\/qr"/);
  // No honor page is promised until one exists (D-decision 2026-10-24).
  assert.ok(!/\bmuro\b|honor|reconocimiento p[uú]blico/i.test(src));
});

test('/help, the footer and the sitemap link to /donate; «en construcción» is gone for donations', () => {
  const help = read('src/app/help/page.tsx');
  assert.match(help, /<Link href="\/donate">Dona<\/Link>/);
  assert.ok(!/Donaciones[^.]*en construcci/i.test(help));
  assert.match(read('src/components/SiteChrome.tsx'), /<Link href="\/donate">Dona<\/Link>/);
  assert.match(read('src/lib/sitemap.ts'), /'\/donate'/);
});

test('the dashboard offers Donaciones only through canAccess', () => {
  assert.match(read('src/app/admin/AdminDashboard.tsx'), /canAccess\('donations', roles\) && \(\s*<Link href="\/admin\/donations"/);
});

test('/admin/donations keeps its section gate and the revalidate the shell needs', () => {
  const page = read('src/app/admin/donations/page.tsx');
  assert.match(page, /<AdminGate section="donations">/);
  assert.match(page, /^export const revalidate = 300;$/m);
});

test('the review screen asks canConfirm, diffs against the current details and gates Confirmar on the checklist', () => {
  const src = code(PANEL);
  assert.match(src, /canConfirm\(\{ callerUid, callerRoles: roles, proposerUid: pending\.proposedBy \}\)/);
  assert.match(src, /diffSettings\(current, proposal\)/);
  assert.match(src, /Esperando confirmación de otra persona\./);
  assert.match(src, /Llamé a quien propuso el cambio y lo confirmó\./);
  assert.match(src, /Escaneé el QR con la app de mi banco y el titular coincide\./);
  // Confirmar is disabled until the boxes are ticked, and its buttons live only in the !mayDecide=false branch.
  assert.match(src, /disabled=\{busy \|\| !ready\}/);
  assert.match(src, /const ready = calledProposer && \(!qrInProposal \|\| scannedQr\);/);
  const waiting = src.indexOf('!mayDecide ?');
  const confirmButton = src.indexOf('confirmDonation(user, pending.id)');
  assert.ok(waiting > 0 && confirmButton > waiting, 'the confirm call sits after the mayDecide check');
  // A change is labelled with text, not colour alone.
  assert.match(src, /Cambió/);
});

test('the QR file input is visible, never `hidden`, and the proposed QR object URL is revoked', () => {
  const src = code(PANEL);
  assert.match(src, /type="file"/);
  assert.match(src, /accept="image\/jpeg,image\/png"/);
  assert.ok(!/\bhidden\b/.test(src.slice(src.indexOf('type="file"') - 200, src.indexOf('type="file"') + 300)), 'no hidden attribute on the file input');
  assert.ok(!/\.click\(\)/.test(src), 'no programmatic click on an input');
  assert.match(src, /URL\.revokeObjectURL/);
});

test('the account number is typed twice without blocking paste or autofill history being offered', () => {
  const src = code(PANEL);
  assert.match(src, /accountNumberConfirm/);
  assert.match(src, /autoComplete="off"/);
  assert.ok(!/onPaste/.test(src), 'paste is never blocked');
  assert.match(src, /accountNumbersMatch\(m\.accountNumber, m\.accountNumberConfirm\)/);
});

test('a stale sign-in asks for the existing re-authentication and retries the same action', () => {
  const src = code(PANEL);
  assert.match(src, /error\.failure === 'requires-recent-login'/);
  assert.match(src, /setReauth\(\{ at, retry: action \}\)/);
  assert.match(src, /<ReauthPrompt/);
  const prompt = code('src/app/admin/donations/ReauthPrompt.tsx');
  assert.match(prompt, /reauthenticate\(user, methods\.password \? password : null\)/);
  assert.match(prompt, /t\.account/);
});

test('every refusal the routes can send has a Spanish sentence, and no copy uses voseo', () => {
  for (const failure of DONATION_FAILURES) assert.ok(FAILURE_TEXT[failure], failure);
  for (const text of [...Object.values(FAILURE_TEXT), ...Object.values(PROPOSAL_ERROR_TEXT)]) {
    assert.ok(text.length > 10);
    assert.ok(!/\b(vos|tenés|podés|escribí|elegí|intentá|revisá|usá|quitá|acortá|agregá|propón[eé])\b/i.test(text), text);
  }
  assert.equal(donationFailureText('invalid-proposal', 'account-mismatch'), PROPOSAL_ERROR_TEXT['account-mismatch']);
  assert.equal(donationFailureText('own-proposal'), FAILURE_TEXT['own-proposal']);
  assert.match(donationFailureText(null), /conexión/);
});

test('dates print in the shelter zone, and a calendar day never shifts', () => {
  // 03:00 UTC on the 26th is still the 25th at 23:00 in La Paz (UTC-4).
  assert.match(formatDonationDate(Date.UTC(2028, 7, 26, 3, 0)), /^25 de agosto de 2028$/);
  assert.equal(formatDayKey('2028-08-25'), '25 de agosto de 2028');
  assert.equal(formatDayKey('0000-00-00'), '0000-00-00');
});

test('qrFileProblem accepts JPEG and PNG up to 2 MB and refuses the rest', () => {
  assert.equal(qrFileProblem({ type: 'image/png', size: 1000 }), null);
  assert.equal(qrFileProblem({ type: 'image/jpeg', size: 2 * 1024 * 1024 }), null);
  assert.ok(qrFileProblem({ type: 'image/webp', size: 1000 }));
  assert.ok(qrFileProblem({ type: 'image/png', size: 2 * 1024 * 1024 + 1 }));
  assert.ok(qrFileProblem({ type: 'image/png', size: 0 }));
});
