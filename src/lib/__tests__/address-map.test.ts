/**
 * Step 3's optional map (the paper's CROQUIS UBICACIÓN), portion 4d.
 *
 * What is pinned here:
 *   1. the map is NOT loaded until the person taps «Marcar mi casa en el mapa»,
 *      so a person who skips it never contacts the tile server;
 *   2. a tap on the map marks the home, «Quitar la marca» removes the mark;
 *   3. a map that cannot load says so, and the step still works without it;
 *   4. Leaflet is imported by ONE module, and that module only dynamically, so
 *      no other page carries it;
 *   5. the map's config: OpenStreetMap tiles over https, with the attribution
 *      their policy requires, centred inside the service area.
 *
 * The real Leaflet map is not run here (it needs a real browser); a fake map
 * component stands in through `loadMap`, the same seam the page uses.
 *
 * Run with:  node --test --import tsx src/lib/__tests__/address-map.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { click, find, findAll, installFakeDom, textOf, type Installed } from './fake-dom';

// React decides whether it runs in a browser when its module loads.
const env: Installed = installFakeDom('https://wawitas.org/adopt/luna/apply');

async function modules() {
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const home = await import('@/app/adopt/[slug]/apply/HomeStep');
  const { SHELTER } = await import('@/config/shelter');
  const { es } = await import('@/i18n/es');
  return { React, createRoot, home, SHELTER, es };
}
type Modules = Awaited<ReturnType<typeof modules>>;
let loaded: Modules | null = null;
const load = async () => (loaded ??= await modules());

const sleep = () => new Promise((resolve) => setTimeout(resolve, 0));
async function settle(m: Modules) {
  await m.React.act(async () => {
    for (let i = 0; i < 6; i += 1) await sleep();
  });
}

type Pin = { latitude: number; longitude: number } | null;

/** Mount step 3 inside a parent that keeps the pin, as the stepper does. */
async function mount(loadMap: () => Promise<{ default: unknown }>) {
  const m = await load();
  const pins: Pin[] = [];
  const { React } = m;
  function Parent() {
    const [pin, setPin] = React.useState<Pin>(null);
    return React.createElement(m.home.HomeStep, {
      labels: m.SHELTER.adoptionApplications.homeLabels,
      petName: 'Luna',
      addressText: 'Calle Sucre 123',
      reference: '',
      pin,
      errors: {},
      disabled: false,
      onChange: () => {},
      onPin: (next: Pin) => {
        pins.push(next);
        setPin(next);
      },
      loadMap: loadMap as never,
    });
  }
  const container = env.document.createElement('div');
  env.document.body.appendChild(container);
  const root = m.createRoot(container as unknown as Element);
  await m.React.act(async () => {
    root.render(m.React.createElement(Parent));
  });
  await settle(m);
  return {
    m,
    container,
    pins,
    unmount: async () => {
      await m.React.act(async () => root.unmount());
      env.document.body.removeChild(container);
    },
  };
}

/** A stand-in for the Leaflet map: one button marks a point, one reports failed tiles. */
async function fakeMapModule() {
  const { React } = await load();
  function FakeMap(props: { pin: Pin; onPin?: (pin: Pin) => void; onFailed?: () => void }) {
    return React.createElement(
      'div',
      { className: 'fake-map' },
      React.createElement('button', { type: 'button', onClick: () => props.onPin?.({ latitude: -17.3935, longitude: -66.157 }) }, 'fake-tap'),
      React.createElement('button', { type: 'button', onClick: () => props.onFailed?.() }, 'fake-tiles-fail'),
    );
  }
  return { default: FakeMap };
}

test('the map is not loaded until asked for; a tap marks the home, «Quitar la marca» removes it', async () => {
  const m = await load();
  const copy = m.es.applicationSteps;
  let loads = 0;
  const mounted = await mount(async () => {
    loads += 1;
    return fakeMapModule();
  });
  try {
    assert.equal(loads, 0, 'nothing is fetched before the tap');
    assert.equal(findAll(mounted.container, '.fake-map').length, 0);

    click(find(mounted.container, 'button', copy.mapOpen));
    await settle(m);
    assert.equal(loads, 1, 'opening the map loads it once');
    assert.ok(textOf(mounted.container).includes(copy.mapTap));

    click(find(mounted.container, 'button', 'fake-tap'));
    await settle(m);
    assert.deepEqual(mounted.pins, [{ latitude: -17.3935, longitude: -66.157 }]);
    assert.ok(textOf(mounted.container).includes(copy.mapMarked));

    click(find(mounted.container, 'button', copy.mapClear));
    await settle(m);
    assert.deepEqual(mounted.pins.at(-1), null);
    assert.equal(findAll(mounted.container, 'button', copy.mapClear).length, 0);
    assert.ok(textOf(mounted.container).includes(copy.mapTap), 'the map stays open to mark again');
  } finally {
    await mounted.unmount();
  }
});

test('a map that cannot download says so, and offers to go on without it', async () => {
  const m = await load();
  const copy = m.es.applicationSteps;
  const mounted = await mount(async () => {
    throw new Error('ChunkLoadError');
  });
  try {
    click(find(mounted.container, 'button', copy.mapOpen));
    await settle(m);
    assert.ok(textOf(mounted.container).includes(copy.mapFailed));
    assert.equal(findAll(mounted.container, '.address-map').length, 0, 'no endless loading box');
  } finally {
    await mounted.unmount();
  }
});

test('a map whose tiles all fail says so too', async () => {
  const m = await load();
  const copy = m.es.applicationSteps;
  const mounted = await mount(fakeMapModule);
  try {
    click(find(mounted.container, 'button', copy.mapOpen));
    await settle(m);
    click(find(mounted.container, 'button', 'fake-tiles-fail'));
    await settle(m);
    assert.ok(textOf(mounted.container).includes(copy.mapFailed));
    assert.equal(findAll(mounted.container, '.fake-map').length, 0);
  } finally {
    await mounted.unmount();
  }
});

// ── Leaflet stays in one module, loaded on demand ──────────────────────────

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx)$/.test(entry.name) && !full.includes(`${path.sep}__tests__${path.sep}`)) out.push(full);
  }
  return out;
}

test('only AddressMap imports Leaflet, and only LazyAddressMap loads AddressMap, dynamically', () => {
  const files = sourceFiles(path.join(process.cwd(), 'src'));
  const leaflet = files.filter((f) => /from ['"]leaflet(\/[^'"]*)?['"]|import ['"]leaflet/.test(fs.readFileSync(f, 'utf8')));
  assert.deepEqual(
    leaflet.map((f) => path.relative(process.cwd(), f).split(path.sep).join('/')),
    ['src/components/AddressMap.tsx'],
  );
  // A VALUE import of AddressMap anywhere would put Leaflet in that page's bundle.
  const valueImport = /import\s+(?!type\b)[^;]*from\s+['"](\.\/|@\/components\/)AddressMap['"]/;
  const offenders = files.filter((f) => valueImport.test(fs.readFileSync(f, 'utf8')));
  assert.deepEqual(offenders, [], 'import AddressMap only as a type; LazyAddressMap loads it');
  const lazy = fs.readFileSync(path.join(process.cwd(), 'src/components/LazyAddressMap.tsx'), 'utf8');
  assert.match(lazy, /import\('\.\/AddressMap'\)/);
});

test("the map config: OpenStreetMap over https, its attribution, centred inside the service area", async () => {
  const { SHELTER } = await load();
  const { map, bounds } = SHELTER;
  assert.equal(map.tileUrl, 'https://tile.openstreetmap.org/{z}/{x}/{y}.png');
  assert.match(map.attribution, /© <a href="https:\/\/www\.openstreetmap\.org\/copyright">OpenStreetMap<\/a>/);
  assert.ok(map.center.latitude > bounds.minLat && map.center.latitude < bounds.maxLat);
  assert.ok(map.center.longitude > bounds.minLng && map.center.longitude < bounds.maxLng);
  assert.ok(map.minZoom <= map.zoom && map.zoom <= map.maxZoom);
  assert.ok(map.maxZoom <= 19, "OpenStreetMap's standard tiles stop at zoom 19");
  assert.equal(SHELTER.adoptionApplications.homeLabels.map, 'CROQUIS UBICACIÓN', "the paper's label, verbatim");
});

test('the admin Google Maps link carries only the rounded point', async () => {
  const { googleMapsUrl } = await import('@/lib/applications');
  assert.equal(
    googleMapsUrl(-17.39351234, -66.15704987),
    'https://www.google.com/maps/search/?api=1&query=-17.3935,-66.157',
  );
});
