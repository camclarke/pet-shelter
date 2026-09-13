/**
 * Draw synthetic Bolivian-style vaccination cards, with their answer key, for
 * `npm run eval:cards`. Build-order step 9.
 *
 *   npm run cards:synthesize
 *
 * Writes `_e2e/cards/card-*.jpg` and `_e2e/cards/ground-truth.json`. Both are
 * gitignored with the rest of `_e2e/`; only the EXAMPLE answer key is tracked.
 *
 * ── ⚠️ SYNTHETIC CARDS ARE EASIER THAN REAL ONES ────────────────────────────
 * These are rendered text on a flat background: a script font standing in for
 * handwriting, a clean grid, no glare, no fold, no thumb over a corner, no
 * phone perspective. A score on them is an UPPER BOUND on what a real card
 * photographed in a shelter will get, never an estimate of it. The one thing
 * they do test well is the failure this path exists to prevent — whether a
 * model INVENTS a date it cannot read — because the illegible date is
 * genuinely absent from the image, so any date returned for it was made up.
 *
 * The three cards:
 *   clean      — two vaccinations and a deworming, with a printed sticker,
 *                a stamp, a Roman-numeral month and a day-first ambiguous date
 *   faded      — washed-out ink and a blurred photo, plus a red campaign
 *                rubber stamp carrying the rabies date, no vet and no lot
 *   illegible  — a deworming that reads fine, and a vaccination whose dates are
 *                scribbled out: the correct answer for them is null
 *
 * Every card also prints an OWNER section (name, phone, address). No field may
 * copy it — the eval checks every snippet.
 *
 * Needs the fonts this machine has (Segoe Print, Arial). Rendered by librsvg
 * through sharp, which is already a transitive dependency.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(resolve(HERE, '..'), '_e2e', 'cards');
mkdirSync(OUT, { recursive: true });

const W = 1600;
const H = 1150;
const HAND = "'Segoe Print', 'Ink Free', 'Comic Sans MS', cursive";
const PRINT = "Arial, 'Segoe UI', sans-serif";

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function text(x, y, s, o = {}) {
  const {
    size = 30,
    font = PRINT,
    color = '#1d1d1d',
    weight = 400,
    rotate = 0,
    opacity = 1,
    anchor = 'start',
  } = o;
  const t = rotate ? ` transform="rotate(${rotate} ${x} ${y})"` : '';
  return `<text x="${x}" y="${y}" font-family="${font}" font-size="${size}" font-weight="${weight}" fill="${color}" fill-opacity="${opacity}" text-anchor="${anchor}"${t}>${esc(s)}</text>`;
}

const OWNER = {
  name: 'Marcela Quiroga Rojas',
  phone: '71234567',
  address: 'Av. Blanco Galindo km 4, Quillacollo',
};

/** The printed frame every card shares: header, owner, animal, table grid. */
function frame({ paper, ink, opacity = 1 }) {
  const p = (x, y, s, o = {}) => text(x, y, s, { color: ink, opacity, ...o });
  const cols = [60, 300, 780, 1010, 1250, 1540];
  const grid = [];
  for (const x of cols) grid.push(`<line x1="${x}" y1="430" x2="${x}" y2="820" stroke="${ink}" stroke-opacity="${0.5 * opacity}" stroke-width="2"/>`);
  for (const y of [430, 480, 600, 720, 820]) grid.push(`<line x1="60" y1="${y}" x2="1540" y2="${y}" stroke="${ink}" stroke-opacity="${0.5 * opacity}" stroke-width="2"/>`);
  const dgrid = [];
  for (const x of [60, 300, 780, 1010, 1540]) dgrid.push(`<line x1="${x}" y1="900" x2="${x}" y2="1080" stroke="${ink}" stroke-opacity="${0.5 * opacity}" stroke-width="2"/>`);
  for (const y of [900, 950, 1080]) dgrid.push(`<line x1="60" y1="${y}" x2="1540" y2="${y}" stroke="${ink}" stroke-opacity="${0.5 * opacity}" stroke-width="2"/>`);

  return [
    `<rect width="100%" height="100%" fill="${paper}"/>`,
    p(800, 90, 'CARNET DE VACUNACIÓN', { size: 54, weight: 700, anchor: 'middle' }),
    p(800, 140, 'Canino · Felino', { size: 28, anchor: 'middle' }),
    p(70, 220, `Propietario: ${OWNER.name}`, { size: 28 }),
    p(70, 262, `Teléfono: ${OWNER.phone}`, { size: 28 }),
    p(70, 304, `Dirección: ${OWNER.address}`, { size: 28 }),
    p(900, 220, 'Nombre: Canela', { size: 28 }),
    p(900, 262, 'Especie: Canino   Raza: Mestiza', { size: 28 }),
    p(70, 410, 'VACUNAS', { size: 32, weight: 700 }),
    p(80, 465, 'FECHA', { size: 22, weight: 700 }),
    p(320, 465, 'VACUNA', { size: 22, weight: 700 }),
    p(800, 465, 'LOTE', { size: 22, weight: 700 }),
    p(1030, 465, 'PRÓXIMA', { size: 22, weight: 700 }),
    p(1270, 465, 'FIRMA Y SELLO', { size: 22, weight: 700 }),
    ...grid,
    p(70, 880, 'DESPARASITACIÓN', { size: 32, weight: 700 }),
    p(80, 935, 'FECHA', { size: 22, weight: 700 }),
    p(320, 935, 'PRODUCTO', { size: 22, weight: 700 }),
    p(800, 935, 'PESO', { size: 22, weight: 700 }),
    p(1030, 935, 'PRÓXIMA', { size: 22, weight: 700 }),
    ...dgrid,
  ].join('\n');
}

/** A printed vaccine sticker, as pasted into the VACUNA column. */
function sticker(x, y, { product, maker, lot }) {
  return [
    `<rect x="${x}" y="${y}" width="440" height="100" fill="#ffffff" stroke="#6a6a6a" stroke-width="2" rx="6"/>`,
    text(x + 16, y + 34, product, { size: 28, weight: 700, color: '#10205a' }),
    text(x + 16, y + 64, maker, { size: 20, color: '#333333' }),
    text(x + 16, y + 90, `Lote: ${lot}`, { size: 20, color: '#333333' }),
  ].join('\n');
}

/** An oval rubber stamp with a vet's name and clinic. */
function vetStamp(cx, cy, lines, color = '#1f3d9a', rotate = -6) {
  return [
    `<g transform="rotate(${rotate} ${cx} ${cy})" opacity="0.85">`,
    `<ellipse cx="${cx}" cy="${cy}" rx="140" ry="52" fill="none" stroke="${color}" stroke-width="4"/>`,
    ...lines.map((l, i) => text(cx, cy - 12 + i * 26, l, { size: 20, color, weight: 700, anchor: 'middle' })),
    `</g>`,
  ].join('\n');
}

/** A heavy scribble that leaves nothing of what was under it. */
function scribble(x, y, w, h, color) {
  const pts = [];
  for (let i = 0; i <= 14; i++) {
    const px = x + (w * i) / 14;
    const py = i % 2 === 0 ? y : y + h;
    pts.push(`${px.toFixed(1)},${py.toFixed(1)}`);
  }
  const back = pts.slice().reverse().map((p) => {
    const [px, py] = p.split(',').map(Number);
    return `${(px + 9).toFixed(1)},${(py - 6).toFixed(1)}`;
  });
  return `<polyline points="${[...pts, ...back].join(' ')}" fill="none" stroke="${color}" stroke-width="11" stroke-linejoin="round" stroke-linecap="round"/>`;
}

function svg(body) {
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">\n${body}\n</svg>`);
}

// ── the cards ────────────────────────────────────────────────────────────────

const cards = [];

// 1 · CLEAN
{
  const ink = '#1c1c28';
  const hand = (x, y, s, o = {}) => text(x, y, s, { font: HAND, size: 34, color: '#1b2a6b', ...o });
  const body = [
    frame({ paper: '#f6efdc', ink }),
    // row 1: sticker vaccine
    hand(80, 555, '14/02/2025'),
    sticker(320, 490, { product: 'Vanguard Plus 5', maker: 'Zoetis', lot: '293847A' }),
    hand(1030, 555, '14/02/2026'),
    vetStamp(1395, 540, ['Dra. Lucía Mendoza', 'Clínica Veterinaria Tunari']),
    // row 2: handwritten rabies, day-first ambiguous date
    hand(80, 675, '3/4/25'),
    hand(320, 675, 'Antirrábica'),
    hand(800, 675, 'RB-5521'),
    hand(1030, 675, '3/4/26'),
    vetStamp(1395, 660, ['Dra. Lucía Mendoza', 'Clínica Veterinaria Tunari'], '#1f3d9a', 4),
    // deworming: Roman month
    hand(80, 1030, '20-IV-2025'),
    hand(320, 1030, 'Drontal Plus'),
    hand(800, 1030, '12 kg'),
    hand(1030, 1030, '20-VII-2025'),
  ].join('\n');
  const file = 'card-clean.jpg';
  await sharp(svg(body)).jpeg({ quality: 88 }).toFile(join(OUT, file));
  cards.push({
    variant: 'clean',
    file,
    subject: 'Clean card: sticker, stamp, day-first ambiguous date, Roman-numeral month',
    rows: [
      { kind: 'vaccination', name: ['Vanguard Plus 5', 'Vanguard'], printedDate: '14/02/2025', performedAt: '2025-02-14', nextDueAt: '2026-02-14', batch: '293847A', manufacturer: 'Zoetis', veterinarian: 'Lucía Mendoza', clinic: 'Tunari' },
      { kind: 'vaccination', name: ['Antirrábica'], printedDate: '3/4/25', performedAt: '2025-04-03', nextDueAt: '2026-04-03', batch: 'RB-5521', manufacturer: null, veterinarian: 'Lucía Mendoza', clinic: 'Tunari' },
      { kind: 'deworming', name: ['Drontal Plus', 'Drontal'], printedDate: '20-IV-2025', performedAt: '2025-04-20', nextDueAt: '2025-07-20', batch: null, manufacturer: null, veterinarian: null, clinic: null },
    ],
  });
}

// 2 · FADED + STAMPED
{
  const ink = '#8a8170';
  const hand = (x, y, s, o = {}) => text(x, y, s, { font: HAND, size: 34, color: '#7c7f96', opacity: 0.62, ...o });
  const red = '#b3261e';
  const body = [
    frame({ paper: '#efe3c4', ink, opacity: 0.55 }),
    hand(80, 555, '12/03/2025'),
    hand(320, 555, 'Quíntuple'),
    hand(800, 555, 'QX-7781'),
    hand(1030, 555, '12/03/2026'),
    hand(1280, 555, 'firma', { opacity: 0.4 }),
    // row 2: campaign rubber stamp carries the date; no vet, no lot
    hand(320, 675, 'Antirrábica'),
    `<g transform="rotate(-8 700 665)" opacity="0.78">`,
    `<rect x="470" y="612" width="470" height="110" fill="none" stroke="${red}" stroke-width="5" rx="8"/>`,
    text(705, 648, 'CAMPAÑA ANTIRRÁBICA 2025', { size: 26, weight: 700, color: red, anchor: 'middle' }),
    text(705, 676, 'SEDES COCHABAMBA', { size: 22, weight: 700, color: red, anchor: 'middle' }),
    text(705, 710, '08 SEP 2025', { size: 30, weight: 700, color: red, anchor: 'middle' }),
    `</g>`,
    // deworming: faded
    hand(80, 1030, '02/05/2025'),
    hand(320, 1030, 'Total Full'),
    hand(800, 1030, '11 kg'),
  ].join('\n');
  const file = 'card-faded.jpg';
  await sharp(svg(body))
    .blur(1.1)
    .modulate({ brightness: 1.04, saturation: 0.8 })
    .jpeg({ quality: 72 })
    .toFile(join(OUT, file));
  cards.push({
    variant: 'faded',
    file,
    subject: 'Faded, blurred card with a red campaign rubber stamp carrying the rabies date',
    rows: [
      { kind: 'vaccination', name: ['Quíntuple', 'Quintuple'], printedDate: '12/03/2025', performedAt: '2025-03-12', nextDueAt: '2026-03-12', batch: 'QX-7781', manufacturer: null, veterinarian: null, clinic: null },
      { kind: 'vaccination', name: ['Antirrábica'], printedDate: '08 SEP 2025', performedAt: '2025-09-08', nextDueAt: null, batch: null, manufacturer: null, veterinarian: null, clinic: 'SEDES' },
      { kind: 'deworming', name: ['Total Full'], printedDate: '02/05/2025', performedAt: '2025-05-02', nextDueAt: null, batch: null, manufacturer: null, veterinarian: null, clinic: null },
    ],
  });
}

// 3 · ILLEGIBLE DATE
{
  const ink = '#1c1c28';
  const handColor = '#1b2a6b';
  const hand = (x, y, s, o = {}) => text(x, y, s, { font: HAND, size: 34, color: handColor, ...o });
  const body = [
    frame({ paper: '#f4ecd6', ink }),
    // row 1: the dates are scribbled out. NOTHING is drawn underneath, so any
    // date a model returns for this row was invented.
    scribble(78, 520, 200, 50, handColor),
    hand(320, 555, 'Quíntuple'),
    hand(800, 555, 'QT-3320'),
    scribble(1028, 520, 200, 50, handColor),
    // a coffee ring, for texture — away from the text
    `<circle cx="1400" cy="700" r="70" fill="none" stroke="#8b5a2b" stroke-opacity="0.25" stroke-width="14"/>`,
    // deworming: legible
    hand(80, 1030, '15/06/2025'),
    hand(320, 1030, 'Drontal Plus'),
    hand(800, 1030, '13 kg'),
  ].join('\n');
  const file = 'card-illegible.jpg';
  await sharp(svg(body)).jpeg({ quality: 88 }).toFile(join(OUT, file));
  cards.push({
    variant: 'illegible',
    file,
    subject: 'A vaccination whose dates are scribbled out — the correct answer is null',
    rows: [
      { kind: 'vaccination', name: ['Quíntuple', 'Quintuple'], printedDate: null, performedAt: null, nextDueAt: null, batch: 'QT-3320', manufacturer: null, veterinarian: null, clinic: null },
      { kind: 'deworming', name: ['Drontal Plus', 'Drontal'], printedDate: '15/06/2025', performedAt: '2025-06-15', nextDueAt: null, batch: null, manufacturer: null, veterinarian: null, clinic: null },
    ],
  });
}

const truth = {
  '//': 'Generated by scripts/make-synthetic-cards.mjs. SYNTHETIC: rendered text, easier than a real card — scores on these are an UPPER BOUND. Dates are ISO calendar days; null means the correct answer is no date.',
  ownerData: [OWNER.name, 'Quiroga', OWNER.phone, 'Blanco Galindo'],
  cards,
};
writeFileSync(join(OUT, 'ground-truth.json'), `${JSON.stringify(truth, null, 2)}\n`);

console.log(`Wrote ${cards.length} cards and ground-truth.json to ${OUT}`);
for (const c of cards) console.log(`  ${c.file.padEnd(20)} ${c.rows.length} rows — ${c.subject}`);
