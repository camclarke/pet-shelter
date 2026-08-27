#!/usr/bin/env node
/**
 * Verify the Gemini setup: is there a key, does it work, and do the model IDs
 * this project is configured with actually exist?
 *
 *   npm run ai:probe            # key + model ID check
 *   npm run ai:probe -- --call  # ...and make ONE real call, to prove it end to end
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * `src/lib/ai/model-ids.ts` carries model IDs taken from
 * docs/gemini-api-playbook.md, which was extracted from a SIBLING project on
 * 2026-08-16. They have never been checked against a live API from this
 * project. The playbook's own §2.3 records a model that kept serving 8 days
 * past its published shutdown, and preview models retired without a GA
 * successor — so "it works" is not "it is supported", and an ID that was right
 * for another stack ten days ago is a hypothesis here.
 *
 * ── This never prints your API key ───────────────────────────────────────────
 * Only a masked fingerprint (last 4 characters), so you can tell WHICH key is
 * loaded without the value reaching a terminal, a log, or a screenshot. The key
 * is sent as an `x-goog-api-key` HEADER and never as a `?key=` URL parameter:
 * URLs end up in proxy logs and browser history.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const BASE = 'https://generativelanguage.googleapis.com/v1beta';

// ── load .env.local without a dependency ─────────────────────────────────────
async function loadEnvLocal() {
  const file = path.join(ROOT, '.env.local');
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return {};
  }
  const out = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    // Strip one layer of matching quotes, the way dotenv does.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function mask(key) {
  if (key.length <= 8) return '(too short to be a real key)';
  return `…${key.slice(-4)} (${key.length} chars)`;
}

const env = { ...(await loadEnvLocal()), ...process.env };
const apiKey = (env.GEMINI_API_KEY ?? '').trim();
const altKey = (env.GOOGLE_GENERATIVE_AI_API_KEY ?? '').trim();

console.log('=== key ===');
if (!apiKey) {
  console.log('GEMINI_API_KEY: MISSING');
  console.log('');
  console.log('Create one at https://aistudio.google.com/apikey and add to .env.local:');
  console.log('  GEMINI_API_KEY=<the key>');
  console.log('  GOOGLE_GENERATIVE_AI_API_KEY=<the same key>');
  console.log('');
  console.log('Without it the app still works: /api/intake/suggest answers 503 and');
  console.log('the intake wizard shows the manual form. Nothing is broken.');
  process.exit(1);
}
console.log(`GEMINI_API_KEY:               present ${mask(apiKey)}`);
if (!altKey) {
  console.log('GOOGLE_GENERATIVE_AI_API_KEY: MISSING — some AI SDK paths read this name.');
  console.log('                              Set it to the same value.');
} else if (altKey !== apiKey) {
  console.log('GOOGLE_GENERATIVE_AI_API_KEY: present but DIFFERENT from GEMINI_API_KEY.');
  console.log('                              That will behave inconsistently. Make them match.');
} else {
  console.log('GOOGLE_GENERATIVE_AI_API_KEY: present, matches');
}

const headers = { 'x-goog-api-key': apiKey };

// ── what models does this key actually have? ─────────────────────────────────
console.log('\n=== live models (supporting generateContent) ===');
let available = [];
try {
  const res = await fetch(`${BASE}/models?pageSize=200`, { headers });
  if (!res.ok) {
    const body = await res.text();
    console.log(`ListModels failed: HTTP ${res.status}`);
    // Deliberately truncated: an error body can echo request context.
    console.log(body.slice(0, 300));
    if (res.status === 400 || res.status === 403) {
      console.log('\nA 400/403 here usually means the key is invalid, restricted, or');
      console.log('the Generative Language API is not enabled for it.');
    }
    process.exit(1);
  }
  const json = await res.json();
  available = (json.models ?? [])
    .filter((m) => (m.supportedGenerationMethods ?? []).includes('generateContent'))
    .map((m) => String(m.name).replace(/^models\//, ''));
  for (const id of available.sort()) console.log(`  ${id}`);
  console.log(`  (${available.length} models)`);
} catch (err) {
  console.log('ListModels threw:', err.message);
  process.exit(1);
}

// ── do OUR configured IDs exist? ─────────────────────────────────────────────
const configured = {
  FLASH_MODEL: (env.GEMINI_FLASH_MODEL ?? '').trim() || 'gemini-3.6-flash',
  FLASH_LITE_MODEL: (env.GEMINI_FLASH_LITE_MODEL ?? '').trim() || 'gemini-3.1-flash-lite',
  PRO_MODEL: (env.GEMINI_PRO_MODEL ?? '').trim() || 'gemini-3.1-pro-preview',
};

console.log('\n=== configured model IDs ===');
let missing = 0;
for (const [name, id] of Object.entries(configured)) {
  const ok = available.includes(id);
  if (!ok) missing++;
  console.log(`  ${ok ? 'OK     ' : 'MISSING'} ${name} = ${id}`);
}

if (missing > 0) {
  console.log('\n⚠️  At least one configured model ID does not exist for this key.');
  console.log('   FLASH_MODEL is the only one photo-assisted intake actually calls.');
  console.log('   Override without a code change by adding to .env.local:');
  console.log('     GEMINI_FLASH_MODEL=<an id from the list above>');
  console.log('   Then update src/lib/ai/model-ids.ts, and add a matching row to');
  console.log('   src/lib/ai/pricing.mjs BEFORE relying on the cost dashboard —');
  console.log('   an unlisted model is costed at Flash rates, not zero.');
}

// ── optionally, one real call ────────────────────────────────────────────────
if (!process.argv.includes('--call')) {
  console.log('\nRun with --call to make one real request and prove it end to end.');
  process.exit(missing > 0 ? 1 : 0);
}

const model = configured.FLASH_MODEL;
if (!available.includes(model)) {
  console.log(`\nSkipping --call: ${model} is not available for this key.`);
  process.exit(1);
}

console.log(`\n=== one real call (${model}) ===`);
const started = Date.now();
const res = await fetch(`${BASE}/models/${model}:generateContent`, {
  method: 'POST',
  headers: { ...headers, 'content-type': 'application/json' },
  body: JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: 'Respondé solamente: listo' }] }],
    // ⚠️ NOT a tight budget. Gemini 3.x reasons by default and thinking is
    // billed as output while `maxOutputTokens` does NOT bound it — measured
    // 2026-08-26, a budget of 16 returned finishReason MAX_TOKENS, 13
    // thinking tokens and no answer at all. A tight cap here looks exactly
    // like a broken key.
    generationConfig: { maxOutputTokens: 512 },
  }),
});
const elapsed = Date.now() - started;

if (!res.ok) {
  console.log(`HTTP ${res.status}`);
  console.log((await res.text()).slice(0, 400));
  process.exit(1);
}

const json = await res.json();
const text = json.candidates?.[0]?.content?.parts?.[0]?.text ?? '(no text)';
const usage = json.usageMetadata ?? {};

const { estimateCostUsd, hasPricingRow } = await import('../src/lib/ai/pricing.mjs');
// thoughtsTokenCount is reported SEPARATELY from candidatesTokenCount and is
// additive. It is billed at the output rate, and on this model it routinely
// dwarfs the visible answer.
const reasoning = usage.thoughtsTokenCount ?? 0;
const cost = estimateCostUsd({
  model,
  inputTokens: usage.promptTokenCount ?? 0,
  outputTokens: usage.candidatesTokenCount ?? 0,
  reasoningTokens: reasoning,
});

console.log(`  reply:   ${JSON.stringify(text.trim())}`);
console.log(`  latency: ${elapsed} ms`);
console.log(`  finish:  ${json.candidates?.[0]?.finishReason ?? '(none)'}`);
console.log(`  tokens:  in=${usage.promptTokenCount ?? 0} out=${usage.candidatesTokenCount ?? 0} thinking=${reasoning}`);
if (reasoning > (usage.candidatesTokenCount ?? 0)) {
  console.log('           ^ thinking exceeds the visible answer. That is normal here,');
  console.log('             and it is billed at the OUTPUT rate.');
}
console.log(`  est cost: $${cost.toFixed(6)}${hasPricingRow(model) ? '' : '  (⚠️ no pricing row — costed at Flash fallback)'}`);
console.log('\nThe key works. Next: drive a real photo through /admin/intake and find');
console.log('the [ai-usage] line in the server log — that is what proves the app path,');
console.log('not this script.');
