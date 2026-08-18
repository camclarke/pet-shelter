# Gemini API Playbook — everything trustcert.ai learned, portable to a new project

**Scope:** Google **AI Studio / Gemini API** (`generativelanguage.googleapis.com`) with an API key.
**Explicitly out of scope:** Vertex AI. Nothing here assumes a GCP project binding, ADC, or Vertex quotas — only `GEMINI_API_KEY`.

Everything below was learned by running this in production for ~4 months, including a **$665/month** surprise bill, a metering layer that was **9× wrong**, a grounded-search counter that was **22× wrong**, an embedding migration that could have silently zeroed retrieval, and roughly a dozen answer-quality failures that traced back to how the models are called rather than to the prompts.

Read §3 and §5 first. They are where the money and the correctness live.

---

## 1. Setup: you need TWO SDKs, and that is not a mistake

```jsonc
// package.json
"ai":              "^6.0.159",   // Vercel AI SDK core
"@ai-sdk/google":  "^3.0.62",    // Gemini provider for the AI SDK
"@ai-sdk/react":   "^3.0.163",   // useChat
"@google/genai":   "2.8.0",      // Google's native SDK — PINNED, see §8/§9
"zod":             "^3.24.1"     // generateObject schemas
```

### 1.1 The AI SDK provider (all real-time paths)

```ts
// lib/ai/google.ts
import { createGoogleGenerativeAI } from "@ai-sdk/google";

export const google = createGoogleGenerativeAI({
  apiKey: process.env.GEMINI_API_KEY,
  // v1beta is required for Gemini 3 preview models AND for Search Grounding.
  // The v1 surface silently lacks both.
  baseURL: "https://generativelanguage.googleapis.com/v1beta",
  // The SDK sets this implicitly from `apiKey`, but making it explicit rules out
  // a Bearer-vs-x-goog-api-key transport mismatch when debugging 401s.
  headers: { "x-goog-api-key": process.env.GEMINI_API_KEY ?? "" },
});
```

Also alias `GOOGLE_GENERATIVE_AI_API_KEY = GEMINI_API_KEY` in the environment — some SDK code paths read the former.

### 1.2 The native SDK (`@google/genai`) — only for what the AI SDK doesn't expose

| Feature | AI SDK exposes it? | Use |
|---|---|---|
| `generateText` / `streamText` / `generateObject` / `embed` | ✅ | AI SDK |
| Search Grounding tool | ✅ (`google.tools.googleSearch({})`) | AI SDK |
| **Files API** (`ai.files.upload`) | ❌ | `@google/genai` |
| **Batch API** (`ai.batches.createEmbeddings`) | ❌ | `@google/genai` |

Keep this split rigid: real-time request paths never touch `@google/genai`, background/upload paths use it in a thin wrapper (`lib/ai/files.ts`, `lib/ai/batch.ts`) that the rest of the app imports through. Both wrappers lazily construct one client and read the same `GEMINI_API_KEY`.

**Pin `@google/genai` to an exact version.** `batches.createEmbeddings` is documented as *"experimental, may change without notice"*. An unpinned minor that renames a `JobState` enum member is a silent stall, not a build error (§8.3).

---

## 2. Model IDs: centralize them, and split them by failure mode

Two files, deliberately different formats. This distinction cost real money to learn.

### 2.1 Chat/generation model IDs → one `.ts`

```ts
// lib/ai/model-ids.ts
export const FLASH_MODEL      = "gemini-3.6-flash";        // chat + all search/extract
export const FLASH_LITE_MODEL = "gemini-3.1-flash-lite";   // probes, classifiers, extractor-B
export const PRO_MODEL        = "gemini-3.1-pro-preview";  // arbitration, reasoning
export const PRO_MODEL_GA_FALLBACK = "gemini-2.5-pro";     // escape hatch
```

**Model KEY vs model ID.** Persist a stable *key* (`"gemini-3-flash"`) on every stored message, never the raw ID. IDs churn every few months; a key written into a database and a Zod enum can never be renamed. A registry maps key → current ID:

```ts
export const MODELS: Record<ModelKey, ModelConfig> = {
  "gemini-3-flash": { id: FLASH_MODEL, label: "Standard", supportsThinking: false, ... },
  "gemini-3-pro":   { id: PRO_MODEL,   label: "Reasoning", supportsThinking: true, ... },
};
```

`.mjs` scripts keep local string literals and get swept by hand on a swap. That is survivable **because a wrong chat model is loud** — you notice immediately.

### 2.2 The embedding model ID → a `.mjs` importable from BOTH TS and scripts

```js
// lib/ai/embedding-model.mjs
export const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL_ID?.trim() || "gemini-embedding-2";
export const EMBEDDING_DIM = 3072;
```

This is a different file type on purpose. **A wrong embedding model is silent** (§7.1): a missed literal in one script writes vectors that no query will ever retrieve, with nothing thrown and nothing logged. Making the module `.mjs` means the offline scripts import the *same constant* the app uses instead of hand-copying it, and the hand-sweep step disappears.

Apply the same rule to any constant where a mismatch is silent: pricing tables, hash schemes, shared prompts. In this project those are all `.mjs` + `.d.ts` pairs (`pricing.mjs`, `embed-text.mjs`, `search-prompts.mjs`, `dedup-key.mjs`) — pure, unit-testable under `node --test`, importable everywhere.

### 2.3 Model lifecycle traps actually hit

- A model's **published shutdown date can pass while it is still serving.** `gemini-embedding-001` was live 8 days after its stated shutdown. Do not treat "still working" as "still supported" — migrate on the announced date, not the observed one.
- **`*-preview` models get retired without a GA successor.** `gemini-3.1-pro-preview` is the only Gemini 3 Pro; its own "GA fallback" (`gemini-2.5-pro`) shuts down first, and Google's recommended replacement for the fallback is the preview it exists to fall back from. Track shutdown dates in a doc; a fallback constant that points at something dying sooner is not a fallback.
- **A model swap changes token counts, not just rates.** Flash 3.6 vs 3.5: same input rate, output rate $9.00 → $7.50/1M, *and* Google claimed ~17% fewer output tokens for the same work. It also fanned out into **more** grounded queries, which made per-discovery cost roughly a wash. Measure end-to-end cost after a swap, not the rate card.

---

## 3. Cost: the part everyone gets wrong

### 3.1 Grounded search is billed **per search query**, not per API call

This is the single most important fact in this document.

One `generateText({ tools: { googleSearch } })` call fans out into **many** search queries, and Google bills each one at **$0.014** (SKU: *"Generate content search query gemini 3 paid one"*, $14/1k).

- That one SKU was **73% of a month's bill**.
- Metering that hardcoded `groundingRequests: 1` per call under-counted **22×** (418 recorded vs 9,416 billed).
- Grounded queries carry **zero tokens**. A token-based cost counter, quota, or rate limit is **structurally blind** to the dominant SKU.

Read the real count out of provider metadata:

```js
// pricing.mjs — pure
export function countGroundedQueries(providerMetadata) {
  const queries = providerMetadata?.google?.groundingMetadata?.webSearchQueries;
  return Array.isArray(queries) && queries.length > 0 ? queries.length : 1;
}
```

Fall back to `1`, never `0` — a grounded call always bills at least one query, and recording zero recreates the blind spot.

**Consequence for product design:** if you meter, quota, or bill in tokens, and you use grounding, your numbers are wrong. Meter in **USD cost units** derived from a price table, or in **grounded turns** if you need something a human can reason about.

### 3.2 Derive rates from the bill, not from the pricing page

Google has no firm public price list for Gemini 3.x. This project's first price table used Gemini-2.x-tier proxies and under-reported spend **~9×** ($19 estimated vs $178 billed for the same window).

The fix: back-compute each rate as `(SKU usage cost ÷ SKU usage count)` from **Cloud Billing → Reports → group by SKU** over a known window. Every rate landed on a clean round number, which is strong evidence they are the real list rates.

```js
export const MODEL_PRICING = {
  "gemini-3.6-flash":      { inputPer1M: 1.5,  outputPer1M: 7.5  },
  "gemini-3.5-flash":      { inputPer1M: 1.5,  outputPer1M: 9.0  },
  "gemini-3.1-flash-lite": { inputPer1M: 0.25, outputPer1M: 1.5  },
  "gemini-3.1-pro-preview":{ inputPer1M: 2.0,  outputPer1M: 12.0 },
  "gemini-embedding-2":    { inputPer1M: 0.2,  outputPer1M: 0.0  },
};
export const FALLBACK_PRICING = { inputPer1M: 1.5, outputPer1M: 9.0 }; // assume Flash, never 0
export const GROUNDING_USD_PER_REQUEST = 0.014;

export function estimateCostUsd({ model, inputTokens = 0, outputTokens = 0, groundingRequests = 0 }) {
  const p = MODEL_PRICING[model] ?? FALLBACK_PRICING;
  return (inputTokens / 1e6) * p.inputPer1M
       + (outputTokens / 1e6) * p.outputPer1M
       + groundingRequests * GROUNDING_USD_PER_REQUEST;
}
```

Two operational rules that came out of this:

1. **Add the row for a new model BEFORE you swap to it.** `pricingFor()` falls back to Flash for unknown IDs, so an unlisted embedding model reports at $1.50/$9.00 — a 7.5× over-report on the very dashboard you'd use to confirm the migration.
2. **Mark which rows are bill-derived and which are published-list.** A published-list row is a hypothesis until it appears on an invoice; re-derive it the moment it does.

### 3.3 Thinking tokens are billed as OUTPUT, and `maxOutputTokens` does not bound them

`maxOutputTokens` caps the visible answer. It does **not** cap the model's reasoning. Read `result.usage.reasoningTokens` and log the reasoning share per call before deciding whether a `thinkingConfig` budget is worth applying — do not blind-apply one:

```ts
console.info(`[search-thinking] model=${model} outputTokens=${result.usage?.outputTokens ?? 0} reasoningTokens=${result.usage?.reasoningTokens ?? 0}`);
```

To surface thoughts to the user (Pro tier only, in this project):

```ts
providerOptions: { google: { thinkingConfig: { includeThoughts: true } } }
```

### 3.4 Measured unit economics (useful as an order-of-magnitude prior)

| Operation | Cost |
|---|---|
| Corpus-hit chat turn (no grounding) | **~$0.003** |
| Corpus-miss turn, 5 grounded search angles, unbounded output | **~$1.19** |
| Same after output-cap + fan-out work | **~$0.20–0.25** |
| One grounded search query | **$0.014** |
| Two-extractor consensus + arbitration per discovery | **~$0.017** |
| Structured-output classifier on flash-lite | **~$0.0002–0.001** |
| Embedding one document | fractions of a cent |

The distribution is brutally bimodal: grounded paths cost **~100×** ungrounded ones. Design your product so grounding fires on a *decision*, never by default.

---

## 4. Metering architecture (copy this shape wholesale)

Three layers, each with a different question it answers.

### 4.1 Per-call recorder — `recordAiUsage`

Every AI call site in the app funnels through one function that (a) logs a greppable structured line, (b) increments a bounded daily Firestore rollup, (c) feeds a per-request ledger.

```ts
export async function recordAiUsage({ process, model, usage, providerMetadata, groundingRequests }) {
  try {
    const inputTokens  = usage?.inputTokens ?? usage?.tokens ?? 0;  // embeddings report {tokens}
    const outputTokens = usage?.outputTokens ?? 0;
    const grounding = providerMetadata != null
      ? countGroundedQueries(providerMetadata)   // metadata always wins
      : groundingRequests ?? 0;
    const estCostUsd = estimateCostUsd({ model, inputTokens, outputTokens, groundingRequests: grounding });

    addToLedger(estCostUsd, process);                                  // §4.3
    console.info(`[ai-usage] ${JSON.stringify({ process, model, inputTokens, outputTokens, groundingRequests: grounding, estCostUsd })}`);
    await db.collection("api_usage_daily")
      .doc(`${utcDate()}__${process}__${model}`)
      .set({ date, process, model,
             calls: increment(1), inputTokens: increment(inputTokens),
             outputTokens: increment(outputTokens), groundingRequests: increment(grounding),
             estCostUsd: increment(estCostUsd) }, { merge: true });
  } catch (err) {
    console.warn("[ai-usage] record failed", err);   // metering NEVER breaks the pipeline it measures
  }
}
```

Non-negotiable properties:

- **Never throws.** Call sites use `void recordAiUsage(...)`. An observation that can break the thing it observes is worse than no observation.
- **Per-call detail → logs; aggregate → database.** Backends are chatty. The rollup is `~processes × models × 365` docs/year — bounded.
- **The log line is emitted synchronously** so detail survives a serverless cold shutdown that drops the database write.
- **Tag by PROCESS, not by user.** Per-customer attribution is the ledger's job (§4.3), and mixing them makes the rollup unbounded.

### 4.2 A process taxonomy in the owner's vocabulary

```js
export const PROCESS_LABELS = {
  chat: "Chat answer",
  classify: "Classifiers & guards",       // per-turn probes/routing on flash-lite
  librarian_discovery: "Discovery",
  librarian_reverify: "Re-verify",
  consensus: "Consensus extraction",
  senior: "Senior arbitration",
  deep_research: "Deep research",
  embeddings: "Embeddings",
  miners: "Miners",
};
```

Two lessons:

- **Meter the things you're sure are too small to matter.** The per-turn classifiers were left unmetered for months because they're ~$0.0005 each. *"Too small to matter"* should be a claim the dashboard can **check**, not an assumption baked into a blind spot.
- **A shared pipeline function needs a `costContext` argument** so its grounded searches attribute to the *calling* process, while cross-cutting steps inside it (extractors, arbitration) keep their own tags. Otherwise one row absorbs three unrelated workloads.

Track coverage explicitly: *"every AI call site in `src/` reaches `recordAiUsage`, with N documented exclusions"*. When this project audited, **14 call sites were unmetered**.

### 4.3 Per-request cost ledger via `AsyncLocalStorage`

`api_usage_daily` answers *"what did process X cost today"*. It can never answer *"what did this customer's turn cost"* — which is the question every quota is set from.

```js
import { AsyncLocalStorage } from "node:async_hooks";
const storage = new AsyncLocalStorage();

export function runWithUsageLedger(fn) {           // wrap request ENTRY POINTS only
  const ledger = { totalUsd: 0, byProcess: {}, calls: 0, flushedUsd: 0 };
  return storage.run(ledger, () => fn(ledger));
}
export function addToLedger(usd, process) { /* no-op outside a request; never throws */ }
export function takeUnflushedUsd() { /* returns delta since last call, clamped ≥ 0 */ }
```

Why this shape:

- `recordAiUsage` is called ~10 files deep. Threading a parameter through every signature is a huge diff for zero behavioural benefit. Requires `runtime = "nodejs"` (not edge).
- Background work runs outside any request → outside any ledger → **no-ops with nothing to special-case**.
- Fire-and-forget tails spawned inside the context still land in the ledger. That's intended: the ledger decides what to *observe*; a separate policy decides what to *bill*.
- **`takeUnflushedUsd()` returns a delta, not the total**, because the persistence path is reachable from ~10 branches and a double-persist would otherwise double-charge. Make the invariant structural, not something every future caller must remember.
- Ship it in **shadow mode first** — run the new counter beside the old one for ≥7 days, then measure, then enforce. Never pick a limit before you have the distribution.

---

## 5. Google Search Grounding — the deep end

```ts
const result = await generateText({
  model: google(FLASH_MODEL),
  tools: { googleSearch: google.tools.googleSearch({}) },
  prompt,
  maxOutputTokens: 1500,        // see §5.2
});
// result.text, result.sources[], result.providerMetadata.google.groundingMetadata
```

### 5.1 Grounding NEVER returns real source URLs

Every `result.sources[].url` is an opaque `vertexaisearch.cloud.google.com/grounding-api-redirect/…` link that:

- 30x-redirects to the real document,
- **expires within days** (then 404s),
- is unusable as a user-facing citation.

Handed only these, an extractor model will "resolve" them by **guessing the publisher homepage**. In this corpus, an audit found **40% of stored source URLs were bare site roots** and ~23% were raw redirects that had since died — 251 of 421 documents ended up with **zero usable source link**.

Three-layer fix, all of which you need:

**(A) Resolve at ingest, while the links are fresh.** One `GET` with `redirect: "manual"`, read the `Location` header, discard the body, follow up to 4 hops, 3.5s timeout, run in parallel, best-effort:

```ts
const res = await fetch(current, { method: "GET", redirect: "manual", signal: ctrl.signal,
                                   headers: { "user-agent": "…" } });
await res.body?.cancel();
if (res.status >= 300 && res.status < 400) {
  const loc = res.headers.get("location");
  current = new URL(loc, current).toString();
  if (!isGroundingRedirectUrl(current)) return current;   // real canonical URL
}
```

**(B) Guard at persistence.** A pure `isUsableSourceUrl(url)` (not a redirect host, not a bare homepage) filters what gets stored.

**(C) Guard at display.** Render unusable URLs as **non-clickable label text**, never as a dead link. An honest non-link beats a broken link.

Also tell the extractor explicitly, in the prompt, that a `grounding-api-redirect` URL must never be emitted and to omit the source rather than emit one.

### 5.2 Bounding fan-out and output — where the money went

Three levers, in order of measured impact:

1. **Cap search output tokens.** `maxOutputTokens: 1500` plus a "≤700 words" prompt rule. This *alone* collapsed query fan-out from **~11 to ~1.3 queries per call** (~6.4 per multi-angle invocation) and dropped corpus-miss cost from ~$1.19 to ~$0.20–0.25. A verbose output budget is an implicit permission to search more.
2. **Budget each search angle's text BEFORE joining** for extraction:
   ```js
   export const PER_ANGLE_EXTRACT_CHARS = 4000;
   export function combineSearchTexts(texts, perAngleChars = PER_ANGLE_EXTRACT_CHARS) {
     return texts.map((t, i) => (typeof t === "string" && t ? t.slice(0, budgetAt(i)) : ""))
                 .filter(Boolean).join("\n\n---\n\n");
   }
   ```
   Before this, the first angle (~30k chars) overflowed a 12k-char extraction window and the later angles — added specifically to catch amendments — **never reached the extractor at all**. That is a cost bug *and* a quality bug in one line.
3. **A loose fan-out cap in the prompt** (`SEARCH_FANOUT_CAP=5`, permissive wording). A *strict* low cap ("AT MOST 3, do not explore beyond them") measurably narrows source diversity. Treat this as a tail guardrail, not a saving.

**Traps in this area:**

- **Raising a producer's ceiling does nothing if a consumer still truncates.** When one angle's output cap was raised to 4000 tokens to retrieve a full data table, the flat 4000-char per-angle join still discarded ~¾ of it. Worse, the persist-time grounding check reads that *same* truncated text, so the cut data was dropped twice for two different-looking reasons. Give that angle its own budget (16000 chars).
- **A search angle inherits whatever label you give it.** One angle was built from a category label instead of the user's actual question and returned a real, verbatim, correctly-transcribed table **for the wrong device class**. Pass the user's actual ask to the angle that needs it — and *only* to that one, so a narrow question doesn't shrink what the broad angles discover.
- **Keep search prompts in ONE shared module** imported by both production and your eval CLI. This project's eval CLI silently drifted from production wording; evals were measuring a prompt nobody shipped.

### 5.3 Don't put grounding on the user-facing call

This project **removed** `tools: { googleSearch }` from the user-facing `streamText` and grounds via its own retrieval + a separate discovery pipeline. Reasons that generalize:

- Citation URLs are unusable without the resolution work in §5.1, and you can't do that mid-stream.
- Cost becomes unbounded and unattributable per turn.
- You lose control over *when* the expensive path fires.

A "DEBUG (re-enabled)" grounding re-add crept in via an unrelated commit and ran in production for **5 weeks** before anyone noticed. If you remove it, leave a comment at the call site saying why, or it comes back.

---

## 6. Structured output: `generateObject` + Zod

The workhorse. Used for classifiers, extractors, adjudicators, gates.

```ts
const { object, usage } = await generateObject({
  model: google(FLASH_LITE_MODEL),
  schema: MySchema,          // Zod v3
  system, prompt,
});
void recordAiUsage({ process: "classify", model: FLASH_LITE_MODEL, usage });
```

### 6.1 Two-model consensus + conditional arbitration

Run the same schema + prompt on **two different model tiers** in parallel, key results by a normalized identity, and split into *dual-confirmed* vs *singletons*. Escalate only the singletons to a stronger model.

```ts
const [extA, extB] = await Promise.allSettled([
  generateObject({ model: google(FLASH_MODEL),      schema, system, prompt }),
  generateObject({ model: google(FLASH_LITE_MODEL), schema, system, prompt }),
]);
// meter each fulfilled result separately; proceed if EITHER succeeded
```

- **`Promise.allSettled`, not `Promise.all`** — one extractor failing must not lose the other's work.
- **Dual-confirmation upgrades the confidence tier**; singletons go to arbitration; if arbitration itself fails, fall back to `pending_review` rather than dropping or trusting.
- **Measured reality: a Flash + Flash-Lite pair disagrees on ~100% of extractions.** The documented "arbitration fires 10–20% of the time" figure was stale by a year. If you assume the escalation is rare, measure it. At ~$0.017 it was still worth keeping — but budget for *always*, not *sometimes*.
- **Merge fields across the pair, don't take the first copy.** Keying on identity and keeping the first-seen object silently drops data that only one extractor transcribed. Union the sub-arrays.

### 6.2 Failure-direction asymmetry — decide it per gate, explicitly

This is the most transferable design idea in the whole project.

| Gate | Fails toward | Why |
|---|---|---|
| Answer-path guard on a finished answer | **silence** (don't flag) | A false alarm on a correct answer costs more trust than a missed catch |
| Persistence gate into the corpus | **dropping** | A bad record is served, cited and re-served for months |
| Taxonomy/classifier gate before writing | **closed** (no write) | Any classifier error → no persist |
| Cost/quota checks | **open** (allow) | A datastore blip must never block a paying request |
| Ambiguity resolution | **no action** | A stale-but-real answer beats a confidently-wrong substitution |

Two helpers from the *same family* can and should point in **opposite** directions (one validates answers → stays quiet; one validates corpus writes → drops aggressively). Don't "unify" them.

Write the direction in the module header. Every one of these was rediscovered painfully.

### 6.3 Prompt rules that are actually load-bearing CODE

- **"Quote values VERBATIM in the source's own unit."** This is not style. It's what lets a persist-time grounding check be a **literal string match**: a silently converted `23 dBm` cannot match a source saying `200 mW`, so it gets dropped. A future "helpful" normalization silently deletes correct data.
- **A no-confabulation gate needs a prompt rule AND a post-hoc validator.** The model will emit specific-but-nonexistent identifiers (a fabricated regulation number, complete with plausible clauses). The prompt rule reduces it; a pure post-extraction check that every cited identifier appears verbatim in the source text is what actually stops it. Keep the regex narrow so ordinary numbers don't trip it — and know its blind spots (a `YYYY/NN` matcher cannot see `NN/YYYY`).
- **An enumerated prohibition is only as complete as the last failure someone thought of.** A rule forbidding *"specific requirements, fees, timelines, or dates"* was obeyed to the letter while the model invented operators, hardware bands, and market facts. Close positively — *"this block establishes X and nothing else; everything beyond X is ungrounded"* — then still name the known-bad categories explicitly, because a purely general statement leaves the model adjudicating what counts.
- **Deleting text from a model's output is dangerous.** A link-scrubber that removed a link left *"Submit the completed to the regulator."* — confident, grammatical, wrong. Prefer: observe-mode logging → then a disclaimer or a regeneration, chosen from measured fire-rate.
- **Copy edits to guard prompts have non-local effects.** Removing one sentence that framed a deferral as a *complete* answer dropped an eval from 11/11 to 9/11 — without it, the model padded the gap with invented content. Re-measure after any wording change (§13).

### 6.4 Guards must not depend on each other's behaviour

Two guards on the same path each disengaged on the same turn, each assuming the other was active — one was documented as *"unnecessary here because the other is strictly stronger"*, and then a third condition suppressed that other one.

**Fix pattern:** pass the first guard's actual decision into the second as an explicit argument, so they're mutually exclusive **by construction** rather than by inference. **Rename the argument** rather than reusing an existing name, so any stale caller falls back to the safe default instead of silently inheriting the bug.

---

## 7. Embeddings

```ts
const { embedding, usage } = await embed({
  model: google.textEmbeddingModel(EMBEDDING_MODEL),
  value: text,
  providerOptions: { google: { taskType: "RETRIEVAL_DOCUMENT" } },  // or RETRIEVAL_QUERY
});
```

### 7.1 Two embedding models are ORTHOGONAL — a mismatch doesn't degrade retrieval, it zeroes it

Measured on live data, querying with `gemini-embedding-2` against 200 documents embedded with `gemini-embedding-001`:

| | cosine p50 | max | above a 0.45 floor |
|---|---|---|---|
| **Matched** model | 0.665 | 0.752 | most |
| **Cross**-model | **0.005** | 0.027 | **0 / 200** |

A corpus split across two embedding models isn't a quality regression — the mismatched docs simply **never surface**. Nothing throws, nothing logs, and (in this system) the turn silently converts into an expensive research call. This is why §2.2 exists.

Corollary: **the corpus and the query embedder must always be on the same model**, and a migration must be a full sweep, not a rolling one. Run it via an idempotent, resumable script that **exits non-zero if it leaves the corpus mixed**.

### 7.2 Make the model ID an env override during a migration

```js
export const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL_ID?.trim() || "gemini-embedding-001";
```

Cutover and rollback become a ~2-minute config change instead of a ~10-minute CI build. **Then delete the override** once stable — while it exists, a locally-run script without the env var set writes vectors with the *old* model.

### 7.3 Re-embed detection: hash the exact text you embedded

```ts
export function needsReembed(doc) {
  if (!Array.isArray(doc.embedding)) return true;
  if (doc.embedding.length !== EMBEDDING_DIM) return true;
  if (doc._embeddingModel !== EMBEDDING_MODEL) return true;
  return doc._embeddingHash !== hashEmbedText(buildEmbedText(doc));  // content drift
}
```

Store `{ embedding, _embeddingModel, _embeddingHash, _lastEmbeddedAt }`. `buildEmbedText` and `hashEmbedText` must live in a shared `.mjs` for the same reason as the model ID.

**Bug found in production:** one write path stored `_embeddingHash` as a base64 slice while `needsReembed()` computed sha256 — so every document from that path was permanently flagged "due" and re-embedded at full price on every reconcile run, forever. **If you have more than one write path, assert they produce the same hash in a test.**

### 7.4 Reconciler traps

- **`.limit(N)` without `orderBy` is not "deferred", it's "unreachable".** A daily reconciler scanned `collection.limit(500)` with no ordering; 187 of 687 documents — including *every* document from one entire high-traffic segment — were never visited. Not once. **Always order the scan, and make the job degrade to a `partial` status + alert if it ever truncates.**
- Have exactly **one** `persistEmbedding(id, vector, hash)` write path shared by the synchronous and batch ingest routes, and pass the hash **recorded at submit time** — if content drifted during the async gap, `needsReembed()` correctly flags it again next run.

---

## 8. Batch API — embeddings ONLY

50% of standard cost, ≤24h turnaround, **48h hard expiry**. Native SDK only.

```ts
const job = await client().batches.createEmbeddings({
  model: EMBEDDING_MODEL,
  src: { inlinedRequests: {
    contents: items.map(it => it.text),
    config: { taskType: "RETRIEVAL_DOCUMENT", outputDimensionality: EMBEDDING_DIM },
  }},
  config: { displayName },
});
return job.name;   // resource name — persist it
```

### 8.1 It fits one-call-in → one-result-out work, and nothing else

Do **not** try to "batch" an orchestrated pipeline (search → two extractors → arbitration). Those steps are sequentially dependent; expressing them as one batch entry means collapsing the design that produces the accuracy. Batch embeddings; leave orchestration on standard pricing.

### 8.2 Results map back POSITIONALLY

Inline responses come back in **input order** with no ids. Persist your own ordered `items: [{id, hash}]` list in a tracker document to survive the async gap:

```ts
const responses = job.dest?.inlinedEmbedContentResponses ?? [];
const vectors = responses.map(r => Array.isArray(r.response?.embedding?.values)
                                   ? r.response.embedding.values : null);  // null = per-item failure
```

`JOB_STATE_PARTIALLY_SUCCEEDED` still carries the vectors that completed — treat it as success and count per-item gaps as errors.

### 8.3 The stale-job guard (this is the one that bites)

Collapse the SDK's `JobState` enum into a coarse state, with `default: "running"`:

```ts
JOB_STATE_SUCCEEDED | PARTIALLY_SUCCEEDED → "succeeded"
JOB_STATE_FAILED | CANCELLED | CANCELLING → "failed"
JOB_STATE_EXPIRED                          → "expired"
default (QUEUED/PENDING/RUNNING/PAUSED/…)  → "running"
```

That `default` is what makes an SDK rename **silent**: an unknown state collapses to `"running"`, the job never resolves, and — because submits are idempotency-guarded on "is any job in flight?" — it blocks **all future submits forever**, with no alert.

**Guard:** any job older than Gemini's own 48h expiry is force-marked `expired` (it's dead on Google's side regardless), which unblocks the next submit **and** trips the run's alert email. Turn the silent stall loud.

**No auto-failover.** The synchronous path is the fallback but stays a *manual* lever — automatic failover means a silent 2× cost flip plus timeout pressure on the sync path.

---

## 9. Files API — large attachments

Inline data caps at **~20 MB** per request (and base64 inflates ~33%). Above that, upload once and pass a reference. Files API: up to **2 GB/file**, **48h retention**, same API key.

```ts
const file = await client().files.upload({ file: blob, config: { mimeType, displayName } });
const active = await waitUntilActive(file.name);   // poll files.get every 2s, 60s timeout
return { name: file.name, uri: active.uri ?? file.uri };
```

Rules learned:

- **`generateContent` rejects files in `PROCESSING`.** Poll to `ACTIVE` at **upload/finalize time**, never at request time. Images are near-instant; large PDFs/audio take seconds.
- **Cache the routing decision** (`{ path, uid, fileUri | null, expiresAt: now + 47h }`, keyed by a hash of the storage path). Set the TTL *below* the 48h Files API lifetime.
- **Model-side limits are stricter than upload limits and are format-specific.** PDFs failed at exactly **50 MiB** (`50*1024*1024`; empirically bracketed: 49.90 MiB passes, 50.0009 MiB fails) even though the Files API upload itself went `ACTIVE`. Enforce those caps at upload time, in the client, and at finalize — and word the error for the constraint that actually binds.
- **A kill switch that only disables the *upload* path is not a rollback** if the client's advertised size limit was raised at the same time — users then pick files the inline path can't carry. Roll back both together.
- **AI SDK v6 file parts use `mediaType`, not `mimeType`.** `mimeType` type-checks with `as never` and throws at runtime.

---

## 10. Streaming (AI SDK v6 + `useChat`)

```ts
const result = streamText({
  model: google(modelId),
  ...(isProModel ? { providerOptions: { google: { thinkingConfig: { includeThoughts: true } } } } : {}),
  system, messages: coreMessages,
  onError: ({ error }) => { capturedStreamError = error; /* log statusCode/responseBody */ },
  onFinish: ({ reasoning, providerMetadata, usage }) => { /* capture for metering + persistence */ },
});
const reader = result.toUIMessageStream({ sendReasoning: true, sendSources: false }).getReader();
```

- **Stream errors arrive at `onError`, they are not thrown.** A `try/catch` around `streamText` catches nothing. You need both paths: captured stream error *and* thrown error.
- **`data-*` parts must be emitted AFTER the manual `start` chunk** inside `createUIMessageStream.execute`, or the client silently discards them.
- **Buffer-then-flush.** Buffer text deltas until the reader exits, then post-process (redaction, guard verdicts, disclaimers) before writing to the UI. Non-text chunks are collected separately and re-emitted after, preserving order. This also removes any visible flash of content you're about to redact. Cost: you lose true token-by-token streaming — decide deliberately.
- If you open your own message context early (to stream progress during a long retrieval phase), **skip the model stream's own `start` chunk**.
- **`sendSources: false`** unless you have fixed §5.1 — raw grounding sources stream through as opaque redirect hosts.
- **Retry loop around the whole `streamText`** with a small `MAX_ATTEMPTS`, plus an explicit empty-output branch: empty output means something specific, and you need the captured error to tell *which* thing.
- **Classify the error before showing it.** A context-window overflow ("token count", "input token", "context length", "request payload size", "entity too large") deserves a capability-framed message, not a generic retry prompt. Flatten `{ message, responseBody, data, statusCode, cause }` into one haystack and match narrow patterns so an ordinary malformed-request 400 isn't misread as an overflow.

---

## 11. Timeouts, latency and the async gap

```ts
const discovered = await Promise.race([discoverAndPersist(...), timeout(30_000)]);
```

- **Race the wait, don't abort the work.** The background promise keeps running and completes its own persistence, so a timed-out turn still enriches the system for the next one. Losing the race must not lose the work.
- **Measure the promise itself, not the race.** Log `[discovery] settled in ${ms}ms` inside the operation — otherwise a lost race only ever tells you ">30s".
  Measured here: a 30s inline budget against real settle times of **52–68s**. The asking turn *always* lost. If you don't instrument the operation, you'll tune the timeout blind forever.
- **Multi-angle grounded discovery is 20–70s.** Plan the UX for it: stream progress events, or make it a background job with a tracking page. Don't hide it behind a spinner.
- Give each stage its own budget (registry lookup 15s, inline discovery 30s, adjudication 6s, attachment profiling 6s) and **fail open** on every one.
- Serverless: `runtime = "nodejs"`, `maxDuration = 300` for streaming chat.

---

## 12. Spend guardrails (product-level, learned the hard way)

The provider spend cap is **not** a safety net: it cannot tell a free user from a paying one, so a burst of legitimate free signups exhausting it takes down *paid* service. That's an availability incident, not a cost one.

Layer rings that bound different things:

| Ring | Bounds | Note |
|---|---|---|
| Per-account allowance | how often **one** user hits the expensive path | e.g. N grounded turns/week, lazy weekly reset |
| Per-network budget | one abusive **cluster** | fails open on any read error |
| **Aggregate daily pool** | the **SUM** across the whole free population | one shared counter doc per UTC day |
| Provider spend cap | the disaster stop | size as *COGS + free pool + paid headroom*, and set it **last** |

Design rules that survived contact:

- **Count the unit that costs money.** Count grounded **turns** (or USD), never tokens — §3.1.
- **Degrade, never refuse.** Cheap paths (cached/retrieved answers) keep streaming; only the *new* expensive operations stop. Users get an honest notice.
- **Fail open everywhere.** A counter read failing must never block a request.
- **Size limits from an allocation, don't pick them.** `$30/mo ÷ (30 days × $0.22/turn) = 4.5 → 4` (round **down** — an allocation is a ceiling).
- **Change the code default AND the env value together.** Env-only means a dropped env block silently loosens the limit back to the old default.
- **Kill-switch polarity is a per-feature decision, and analogy is how you get it wrong.**
  - Guard whose *protection* must survive a lost env block → default **ON** (`FOO_DISABLED = "0"`, module defaults to enabled).
  - Feature whose *disabled state* is the safe one → default **OFF**.
  Write the reasoning at the env var, or someone will "fix" the inconsistency.
- **Cache negative results.** A repeated fruitless expensive lookup should cost one cached read and an honest answer, not the full sweep. TTL by reason (a genuine "nothing exists" caches long; "the searches failed" caches ~1 day).
- **A background job must never consume a user's quota while they sleep.** Settle background costs at job creation, or to the job record — not to the user's live counter.

**The five levers that cut this project's bill ~95%:** provider spend cap · 10–25× longer re-verification TTLs · a cheap re-verify mode (2 search angles on flash-lite instead of 5 on Flash) · pausing automatic corpus growth · lowering per-run task caps. Note that **four of five are about how often the expensive path fires**, not about making it cheaper.

---

## 13. Evals: how to measure a probabilistic guard

Guards implemented as prompts are probabilistic. Treat their evals as measurements, not tests.

- **Run ≥5 repetitions per fixture.** A 3-rep run misses real leaks. One clean 5-rep run was mistaken for "closed" and later re-measured as leaking 1/3.
- **Always run before/after on the same fixtures**, with a *baseline* arm that has the guard removed. If the baseline invents 0 values, your fixture is testing nothing.
- **The fixture must be faithful to the production call shape.** A single-turn `prompt` string tested nothing for a bug that only reproduces multi-turn — the production route streams a `messages` array. A question like *"are THESE bands correct?"* has no antecedent when asked cold; the model just asks for clarification and the case ships green.
- **Do not change how existing fixtures are submitted while measuring a change to what they measure.** Normalizing every case to a new call shape at the same time as a behaviour change makes a regression and a harness artifact indistinguishable.
- **Leave a known-failing case RED as a tracking gate.** Do not add a tolerance to make the suite green — that deletes the only signal you have.
- **Isolate one guard per fixture.** Composing a second guard's wording into the case can suppress the behaviour and flatten the baseline to zero; pin the other guard's wording with a unit test instead.
- **Extract inline prompt strings into modules** so they can be pinned by a test. String concatenation inside a stream handler had nothing pinning the wording that *was* the bug.
- **Deterministic checkers have blind spots.** A checker scanning for numeric values with units cannot see a bare `Band 20` or `n78` — a bare integer is unsafe to flag generally. Know what your checker can't see and count it separately.

---

## 14. Verification: shipping ≠ working

Every one of these happened here.

- **Writing a remediation script is not remediating.** One sat unrun for 6 weeks while docs and status notes recorded it as done.
- **Armed ≠ exercised.** A feature can be live, fail-open, and have literally never fired. Silence is not success — find a positive signal that proves the path ran.
- **A clean `terraform plan` / green test suite / clean offline replay proves nothing about a live path.** One feature shipped with 61 green unit tests and a clean replay, and was structurally incapable of firing in production — because an upstream classifier *inferred* the very input whose absence was the feature's precondition. **Drive the real flow to verify.**
- **"The classifier produced X" is not "the user specified X".** This single conflation caused three separate production bugs in this project. If a downstream decision depends on the user having supplied something, check *provenance*, not just presence.
- **A shelf-check is not a fact-check.** "I have a document for this country" was repeatedly mistaken for "I have the answer to this question". Ask whether the retrieved context answers what was *asked* — the general disease is *"I have something"* ≠ *"I have the right thing"*.
- **Provenance stamps get dropped by automated re-verification.** Judge a data fix by the live field values and a real query, not by a `_fixedAt` marker.
- **When a plausible story fits a bug family you just fixed three times, that is a reason to verify it, not to believe it.** One diagnosis was confidently wrong in exactly that way.
- **Verify layer by layer with logs, not end-to-end by outcome.** One value-delivery chain failed at **five** consecutive links (no schema field → consensus dropped it → truncation → dedup discarded the doc → never rendered into the prompt), and each link looked like a different bug. Even stored data that is never **rendered into the prompt** does not exist to the model.
- **Fighting a guard that's behaving correctly is the signal that something upstream is modelled wrong.** The fix was a missing schema field, not an exemption bolted onto the guard.
- **Whenever you add a field that a re-run can fill in but existing records lack, check the dedup path** — otherwise the value-less version is pinned forever and you re-pay for discovery on every request.

---

## 15. New-project starter checklist

**Day 1**
1. `lib/ai/google.ts` — provider on `v1beta` + explicit `x-goog-api-key`.
2. `lib/ai/model-ids.ts` — every model ID; persistence-stable *keys* separate from IDs.
3. `lib/ai/embedding-model.mjs` — embedding ID + dims, importable from TS **and** scripts.
4. `lib/ai/pricing.mjs` — price table (with a Flash-tier fallback, never 0) + `countGroundedQueries` + `estimateCostUsd`. Pure, unit-tested.
5. `lib/ai/metered.ts` — `recordAiUsage`, never throws, `void`-called everywhere. **Wire it at the very first call site**, not later.

**Week 1**
6. Process taxonomy + a daily rollup collection, locked to server-side access only.
7. `AsyncLocalStorage` request ledger if you will ever need per-user cost.
8. An admin cost view, and a coverage assertion: *every* AI call site reaches the recorder, exclusions documented at the exclusion.
9. Kill switches for each expensive path, polarity decided and written down.
10. Timeout budgets per stage, `Promise.race` with the work continuing in the background, latency logged **inside** the operation.

**Before you enable grounding**
11. The redirect-resolution + usable-URL guard + label-only display trio (§5.1).
12. `maxOutputTokens` on search calls, and a per-angle extraction budget (§5.2).
13. Shared prompt module imported by both production and evals.
14. A negative-result cache.
15. Confirm your quota/limit unit is **cost or grounded turns**, not tokens.

**Before you ship a corpus**
16. One shared embed-text + hash module; a test asserting every write path produces the same hash.
17. A migration script that is idempotent, resumable, and exits non-zero on a mixed corpus.
18. A reconciler that **orders** its scan and alerts on truncation.

**Before you trust anything**
19. Eval harness at ≥5 reps, before/after, baseline arm, production call shape.
20. Drive the real user flow once, on the real deployment, and find a log line proving your feature actually ran.

---

*Extracted 2026-08-16 from `trustcert.ai` (Next.js 16 · Cloud Run · Firestore · Gemini API via AI Studio). Figures are measured on this workload — re-derive rates and cost shapes for yours; the failure modes transfer, the numbers don't.*
