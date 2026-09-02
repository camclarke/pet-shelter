# Gemini file uploads — portable knowledge export

**Source:** trustcert.ai (`C:\code\trustcert-ai-g`), extracted 2026-08-30 from the live
production pipeline (`web/src/lib/ai/files.ts`, `lib/attachments/resolve.ts`,
`api/upload/*`, `api/chat/route.ts`, `lib/firebase/tiers.ts`, `lib/storage/gcs.ts`).
**Stack it was proven on:** Next.js App Router on Cloud Run, GCS for object storage,
`ai@6` + `@ai-sdk/google@3` for inference, `@google/genai@2.8.0` for the Files API.

Everything marked **MEASURED** was verified live against the real API, not read off a doc
page. Everything marked **DOC** came from Google's documentation as of 2026-06 and should
be re-verified before you depend on it.

---

## 1. The constraint set (start here)

| Constraint | Value | Confidence |
|---|---|---|
| Inline data cap, per request | **~20 MB** total request payload | DOC |
| Base64 inflation on inline bytes | **~33%** — budget raw bytes at ~0.75× the cap | DOC |
| Files API per-file ceiling | **2 GB** | DOC (never exercised past 50 MB here) |
| Files API retention | **48 h**, then the object is gone | DOC (relied on in prod) |
| **PDF ceiling at `generateContent`** | **exactly 50 MiB (`50*1024*1024`)** | **MEASURED** |
| File must be `ACTIVE` before use | `generateContent` rejects `PROCESSING` | **MEASURED** |
| Files API auth | same `GEMINI_API_KEY` as inference | MEASURED |

### The PDF cap is the single most expensive thing in this document

Gemini's document-understanding pipeline rejects PDFs above **exactly 50 MiB** with a bare
`400 INVALID_ARGUMENT` — **no transport fixes it**. The Files API happily accepts the
upload and reports `state: ACTIVE`; the failure only appears at inference. Bracketed
empirically 2026-06-12: **49.90 MiB passes, 50.0009 MiB fails**.

Consequences you inherit:

- A "200 MB uploads" promise is **impossible for PDFs** and only true for audio/images.
- Enforce this at **upload time**, not at inference time — otherwise the user waits through
  a full upload + transfer + model round-trip to learn the file was never readable.
- It is a **model-side** limit, so it must have **no role/tier bypass**. A superuser
  exemption here just produces a confusing 400 later.

```ts
export const PDF_MODEL_MAX_BYTES = 50 * 1024 * 1024;
/** Per-format model ceiling, independent of tier (null = tier governs). */
export function modelMaxBytesForMime(mimeType: string): number | null {
  return mimeType === "application/pdf" ? PDF_MODEL_MAX_BYTES : null;
}
```

Message it as a **capability instruction, not a plan limit** — "PDF analysis supports
documents up to 50 MB. Split larger PDFs and attach the parts." — and only speak it when it
is the *binding* constraint (i.e. `modelMax <= tierCeiling`), otherwise a small-plan user
gets a "split your PDF" message when their real blocker was their plan.

---

## 2. Hybrid routing: inline vs reference

Two transports, one decision. Do not pick one globally.

| Path | When | Shape sent to the model | Cost |
|---|---|---|---|
| **Inline** | small files | raw bytes → `inlineData` | one storage download per turn |
| **Reference** | large files | `fileUri` → `fileData` | one-off upload + 48 h server-side object |

Thresholds that worked (raw bytes, pre-base64):

```ts
export const CHAT_ATTACHMENT_MAX_BYTES   = 20 * 1024 * 1024; // provider inline cap
export const INLINE_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024; // per-file inline threshold
export const INLINE_AGGREGATE_MAX_BYTES  = 12 * 1024 * 1024; // per-TURN inline budget
```

**The aggregate budget is the non-obvious one.** A per-file threshold alone is unsound:
three 9 MB files each pass the per-file test and together blow the 20 MB request cap. The
rule that works — evict the **largest** inline candidates to the reference path until the
remaining sum fits:

```ts
let inlineSum = inlineCandidates.reduce((s, { a }) => s + a.size, 0);
for (const { a, i } of inlineCandidates.sort((x, y) => y.a.size - x.a.size)) {
  if (inlineSum <= INLINE_AGGREGATE_MAX_BYTES) break;
  mustReference.add(i);
  inlineSum -= a.size;
}
```

Evicting largest-first minimizes the number of files pushed onto the slower path.

---

## 3. Pipeline shape — and why the "finalize" step exists

```
browser                     app server                    storage        Gemini Files API
  │  POST /api/upload  ────────►│ authz + MIME + size checks
  │  ◄──── {url, path, maxBytes}│ mints v4 signed PUT
  │  PUT file ──────────────────────────────────────►│ (server never sees the bytes)
  │  POST /api/upload/finalize ►│ reads REAL size from object metadata
  │                             │ if large: download → upload → poll ACTIVE ──►│
  │                             │ writes cache doc {path → fileUri | null}
  │  ◄──── {ok, fileUri}        │
  │  POST /api/chat ───────────►│ resolve each attachment → inline | reference
```

**Why a separate finalize call is load-bearing:**

1. With direct-to-storage signed uploads, the server never observes the bytes. Finalize is
   the **first moment the server can act on them** — and the first moment it can read the
   *true* size rather than the client's claim.
2. It moves the Files API transfer to **upload time, behind the attachment chip's existing
   spinner**, instead of onto the chat turn. A 50 MB relay is ~5–6 s and a 200 MB one is
   minutes; paying that at send time is a dead chat. **Do not move this to send time.**
3. It lets the client **block send until the file is model-ready**, so a user can never
   submit a message whose attachment silently isn't there.

Set the finalize route's timeout to match the worst relay (`maxDuration = 300` here, same
as the chat route). Cloud Run at **2 CPU / 2 GiB** handled the relay fine; the largest
actually exercised was 50 MB — a ~200 MB audio relay's memory profile is still unmeasured.

---

## 4. SDK mechanics (the parts that cost hours)

### 4a. Two SDKs, deliberately

`@ai-sdk/google` (Vercel AI SDK) does **not** expose the Files API. Use the native
`@google/genai` for upload/get, keep real-time inference on the AI SDK, and let them meet at
the `uri` string. (The same split applies to the Batch API.)

```ts
import { GoogleGenAI, FileState } from "@google/genai";

const file = await client.files.upload({
  file: new Blob([new Uint8Array(data)], { type: mimeType }),
  config: { mimeType, displayName },
});
// generateContent REJECTS a PROCESSING file — poll here, at upload time, never at chat time.
for (;;) {
  const f = await client.files.get({ name: file.name });
  if (f.state === FileState.ACTIVE) break;
  if (f.state === FileState.FAILED) throw new Error("processing FAILED");
  if (Date.now() >= deadline) throw new Error(`not ACTIVE (state=${f.state})`);
  await new Promise((r) => setTimeout(r, 2_000));
}
```

Poll interval **2 s**, timeout **60 s**. Images are near-instant; large PDFs and audio take
several seconds. Keep both the resource `name` (`files/abc123`) and the `uri` — the name is
what `get`/`delete` and any debugging need.

### 4b. The conversion rule that makes references work — **MEASURED**

`@ai-sdk/google@3` picks the transport off the JS *type* of `data`:

| You pass | Provider emits |
|---|---|
| `data: new URL(uri)` | `fileData.fileUri` (reference) |
| `data: Buffer` | `inlineData` (bytes) |

So one uniform part builder covers both transports:

```ts
if (part.kind === "reference") {
  parts.push({ type: "file", data: new URL(part.uri), mediaType: part.mimeType });
} else if (part.mimeType.startsWith("image/")) {
  parts.push({ type: "image", image: part.data, mediaType: part.mimeType });
} else {
  parts.push({ type: "file", data: part.data, mediaType: part.mimeType });
}
```

Two traps in those three lines:

- **AI SDK v6 file/image parts use `mediaType`, NOT `mimeType`.** `mimeType` type-checks
  through `as never` and throws at runtime.
- **Referenced images travel as `file` parts, not `image` parts** — the provider folds image
  parts into file parts anyway, and the `image:` field has no URL form.

### 4c. Attach to the **last user message**

Walk the message array backwards to the most recent `role: "user"` entry and append the file
parts to its content, converting string content to `[{ type: "text" }]` first.

---

## 5. The reference cache (and its off-by-one-hour)

A file uploaded at finalize time must be findable at chat time, across requests and
instances. One doc per uploaded object, keyed by hash of the storage path so it needs **no
index**:

```
attachment_files/{sha256(storagePath)}
  path, uid, sizeBytes, mimeType,
  fileUri: string | null,   // null ⇒ small file, inline at chat time
  fileName: string | null,  // "files/abc123" — for get/delete/debugging
  state: "ready" | "failed",
  expiresAt: Timestamp | null
```

**Expire cache entries at 47 h against the provider's 48 h retention.** A `fileUri` is then
never handed to the model in its final hour — otherwise a long-running turn can start valid
and die mid-inference. The one-hour haircut is the whole trick.

Small files still get a `fileUri: null` doc. That record means "**inline this**", which is
different from "no record", which means "unknown — go find out".

---

## 6. Failure ladder — every rung is load-bearing

This is the most transferable part of the design. Each failure degrades to something the
user can still use; only the last rung is an error.

**Cache miss at chat time** (finalize race, expired 47 h entry, local dev without finalize):

1. Lazy in-request transfer, hard-capped at **45 s** via `Promise.race`, re-warming the
   cache on success so a re-send within 47 h is a hit.
2. On failure: if the file still fits the inline cap, **download and inline it**.
3. Only then throw a *retryable*, human-readable error: `"<name>" is still being prepared
   for analysis. Please resend in a few seconds.`

**Finalize transfer fails:** if the file fits inline, write a `fileUri: null` doc and return
`ok` — the user is not blocked by a transient provider error. If it doesn't fit, write
`state: "failed"` and return 502 with retry copy.

**Cache lookup itself throws:** `.catch(() => null)` per lookup — degrade to "no cached
uri", never fail the turn on a datastore blip.

**Model finishes with zero text output.** Undecodable bytes (e.g. corrupt data labeled
`image/png`) make the model complete *successfully* with no deltas — a clean 200 and a blank
bubble. **3/3 reproducible.** Detect empty output at flush time and substitute text.
Distinguish two causes, because the advice differs:

```ts
if (rawText.trim().length === 0) {
  rawText = isContextOverflowError(capturedStreamError) ? CONTEXT_OVERFLOW_NOTICE
          : attachments.length > 0                     ? EMPTY_OUTPUT_FALLBACK_WITH_ATTACHMENT
          :                                              EMPTY_OUTPUT_FALLBACK;
}
```

**Context overflow** (a few-MB `.txt` or a large CSV is tens of millions of tokens) surfaces
as a stream *error* with empty output. Detect narrowly so a generic 400 isn't misread — and
search the message, `responseBody`, nested `cause`, and status code, since the phrasing
lands in different fields depending on which layer threw:

```js
const CONTEXT_OVERFLOW_RE =
  /token count|number of tokens|input token|token limit|too many tokens|context (?:length|window)|exceeds the maximum.{0,40}token|request payload size|payload size exceeds|entity too large|request.{0,20}too large/i;
```

Give the user a **precise next step** ("tell me the section, clause, or page range — or split
the file and attach the most relevant part"), not an apology.

**Different budgets need different fallback policies.** The same resolver serves a 6 s
pre-classification pass and the main answer path, so the behaviour is parameterized:

```ts
resolveAttachmentParts(attachments, { allowLazyTransfer: true });                          // chat: try hard
resolveAttachmentParts(attachments, { allowLazyTransfer: false, skipUnresolvable: true }); // 6s probe: skip
```

A 45 s lazy transfer inside a 6 s budget is not a fallback, it's a timeout.

---

## 7. Security — five rules, all of them from real holes

1. **IDOR prefix guard on every path the client names**, at *every* endpoint that accepts one
   (finalize *and* chat): reject unless the path starts with `uploads/{uid}/`. The client
   sends a storage path; without this it can send someone else's.
2. **The client-declared size is advisory.** `/api/upload` only ever sees a number in a JSON
   body. Re-read the authoritative size from **object metadata** at finalize and re-check
   every ceiling against it.
3. **Bind the signed URL to a size ceiling.** An unbounded signed PUT accepts a body of any
   size no matter what the client declared — the bytes land and bill until the TTL sweep.
   Sign the extension header so the *storage layer* enforces it:
   ```ts
   extensionHeaders: { "x-goog-content-length-range": `0,${maxBytes}` }
   ```
   The browser must then echo that header **byte-identically** on the PUT — it is part of
   the v4 signature.
4. **⚠️ Any signed extension header must be added to the bucket's CORS `response_header` list
   in the same commit.** GCS answers a browser preflight's `Access-Control-Request-Headers`
   from that list. Miss it and the preflight returns **200 with no `Access-Control-Allow-*`
   headers at all** — so nothing errors server-side, no log line appears, and the browser
   silently blocks every upload with a bare `TypeError: Failed to fetch`. This shipped broken
   and stayed broken.
5. **MIME allowlist + filename sanitization.** Validate against a `Set`, and build the storage
   path as `uploads/{uid}/{ts}-{uuid}-{filename.replace(/[^a-zA-Z0-9._-]/g,"_")}`.

Allowlist proven in production:

```
image/jpeg  image/png  audio/mpeg  audio/wav  audio/x-wav
application/pdf  text/plain  text/csv
```

Note the absence of Markdown: browsers report `.md` as `text/markdown` or an empty string,
and it isn't in the model's accepted set — tell users to send `.txt`. Drag-and-drop and
programmatic adds **bypass the file picker's `accept` filter**, so the client-side check is
not decorative; name the rejected extension in the error or the user cannot tell why send
stayed disabled.

---

## 8. Client-side traps (each cost a debugging session)

- **`input.files` is a LIVE FileList.** The `onChange` handler typically does
  `e.target.value = ""` right after calling you, which empties the reference *before* your
  first `await` resumes — the loop then sees zero files and the upload exits with no chip, no
  fetch, no error. **Snapshot synchronously before any await:**
  `const files = fileList ? Array.from(fileList) : [];`
- **Don't use HTML `hidden` on the file input.** Chrome 130+ won't deliver trusted change
  events to programmatic-click flows on hidden inputs. Use
  `className="absolute h-0 w-0 overflow-hidden opacity-0"` + `aria-hidden` + `tabIndex={-1}`.
- **Block send while any upload is in flight or errored.** Otherwise the user sends a message
  whose attachment isn't there and gets an answer about nothing.
- **Mirror the server's ceiling client-side** so the user learns the limit before a doomed
  round-trip — from the *same shared constants module*, never a hardcoded client copy.
- **Surface the server's JSON `error` string, not the raw body.** A 413 should read "File
  exceeds your plan's 5 MB limit" and not a JSON blob in the chip.

---

## 9. Object lifecycle

If one bucket holds several categories under different prefixes, a TTL rule **must** be
prefix-scoped or it deletes the others:

```hcl
lifecycle_rule {
  action    { type = "Delete" }
  condition { age = 1, matches_prefix = ["uploads/"] }   # ← the scope is not optional
}
```

Without `matches_prefix` this silently scrubs every other prefix 24 h after creation. Adding
a new prefix means deciding its retention explicitly. Note the two clocks are independent:
the storage object expires on your TTL, the Files API object on its own 48 h.

---

## 10. Kill switch — and the coupling trap

Ship the reference path behind a switch whose **code default is OFF**, overridden ON by infra
config, so losing the env block disables the feature rather than breaking it:

```ts
export function filesApiAttachmentsDisabled(): boolean {
  return (process.env.FILES_API_ATTACHMENTS_DISABLED ?? "1") !== "0";
}
```

When disabled, every file inlines exactly as before — zero new failure modes.

**⚠️ The trap:** once you *raise customer-facing upload limits* on the strength of the
reference path, the switch alone is no longer a safe rollback. Flipping it back while the UI
still offers 200 MB lets users select files the inline path cannot carry, and they fail at
chat time. **The rollback is two coupled changes** — the switch *and* re-clamping the
advertised per-file limit to the inline cap. Write that down next to the switch.

---

## 11. How to verify it (two tests, both worth porting)

**Offline smoke — proves the transport, no app involved.** Build or take a file **larger than
the inline cap** so it can *only* work by reference; embed a unique marker string in it;
upload via the native SDK, poll ACTIVE, then stream a question through the AI SDK with
`data: new URL(uri)`; assert the answer **quotes the marker**. Marker-quoting is what
distinguishes "the model read the file" from "the model answered plausibly".

Building a synthetic large PDF: one real text page carrying the marker plus a large
unreferenced stream object — structurally valid, parsers skip the orphan, and the raw size
forces the reference path. Keep the marker on **short lines**; a single long text run renders
past the page edge and clips it out of what the model can read.

**Live e2e — proves the pipeline.** Mint a token, then drive the real endpoints in order:
`/api/upload` → signed PUT → `/api/upload/finalize` → streaming chat asserting the marker →
inspect the cache doc. Run it against production after deploy. Exercise it **once as a
non-privileged account**, not only as a superuser — the tier-ceiling and quota branches are
exactly the ones a superuser bypasses, so a superuser-only pass proves the least.

Measured reference timings: 50 MB PUT ~15 s · finalize (50 MB) ~5–6 s · 21 MB PDF to ACTIVE
~10 s.

---

## 12. Adoption checklist

- [ ] Pick thresholds: per-file inline, **per-turn aggregate**, provider inline cap.
- [ ] Enforce format-specific model ceilings **at upload time**, with no role bypass.
- [ ] Signed upload URL bound with a size header — **and that header added to CORS**.
- [ ] IDOR prefix guard at every endpoint that accepts a client-supplied path.
- [ ] Re-read authoritative size from object metadata after upload; re-check ceilings.
- [ ] Transfer to the Files API at **upload** time; poll to ACTIVE there.
- [ ] Cache `path → fileUri` with a TTL **shorter than provider retention** (47 h / 48 h).
- [ ] Lazy in-request transfer with a hard timeout → inline fallback → retryable error.
- [ ] Empty-output detection at flush time, with context-overflow told apart.
- [ ] Prefix-scoped storage TTL.
- [ ] Kill switch defaulting off in code — document the rollback coupling.
- [ ] Marker-based smoke test + live e2e, run once as a non-privileged user.

---

## 13. Known gaps in this knowledge

- The **2 GB** per-file Files API ceiling is documented, never exercised here; the largest
  real relay was 50 MB. **Memory profile of a ~200 MB relay is unmeasured.**
- Only the eight MIME types above were tested. Video was never attempted.
- Provider-side numbers (inline cap, retention, 2 GB) are **2026-06 documentation** and
  drift; the 50 MiB PDF cap is measured but could move with a model revision — re-bracket it
  if large PDFs start failing.
- `@google/genai` was pinned at `2.8.0`; its file and batch surfaces are the SDK's less
  stable ones. Pin the version, don't float it.
