# Plan — pet intake, medical records, adoption, and social syndication

Covers: the arrival pipeline and shelter-area tracking, the admin intake flow,
Gemini-assisted vaccination-card parsing and veterinary voice dictation, the
adopter-facing flow, QR identity tags, food donation and daily ration tracking,
and (deferred) social syndication.

Depends on: [`veterinary-records-standards.md`](veterinary-records-standards.md) ·
[`rfid-microchips.md`](rfid-microchips.md) ·
[`gemini-api-playbook.md`](gemini-api-playbook.md)

Three Gemini-assisted paths, all sharing one provider, one price table and one
review discipline — listed here because their risk levels are **not** the same:

| Path | § | Risk | Consensus extractor |
|---|---|---|---|
| Vaccination card → medical record | §4.3 | Moderate — a wrong date | Optional, phase 2 |
| **Vet dictation → medications + dosages** | **§4.7** | **High — a 10× dose is one syllable** | **Required** |
| Donation description → food stock | §12 | Low — a recount fixes it | No |

---

## 0. Read this first: the plan is blocked on three things that do not exist

Nothing below can ship until these land, and they are already the top of
`CLAUDE.md`'s queue. This plan does not replace them, it sits on top of them:

1. **A registered Firebase web app** — the four `NEXT_PUBLIC_FIREBASE_*` values
   are empty. No client-side Firestore, no auth, no admin console.
2. **Auth flows** — every admin screen here is gated on
   `request.auth.token.admin`, a custom claim nothing currently sets.
3. **One real pet document** — the wall has never rendered with data in it.

**Read every estimate here as conditional on those.** This is the same trap
`CLAUDE.md` names repeatedly: a plan that validates is not a plan that works.

There is also a hard date. **The GCP free trial expires ~2026-11-10.** This plan
adds the project's first per-request paid API — the **Gemini API via AI Studio**
— and its first API-key credential. Both land inside that window.

### 0.1 The first coding session, concretely

Everything in §9's build order assumes the three blockers above are gone.
**Steps 1–3 are that unblocking work, and they are console-and-config, not
architecture.** Do them first and in this order; nothing below them can be
tested otherwise.

| Step | Do | Definition of done |
|---|---|---|
| **1a** | Register a Firebase **web app** in the console for project `wawitas` | Four `NEXT_PUBLIC_FIREBASE_*` values exist |
| **1b** | Fill them in `.env.local` **and** as Docker build ARGs | `next build` inlines them — they are **build-time**, not Cloud Run env vars |
| **1c** | Decide the Storage bucket question (open decision #2) | Either a Firebase default bucket exists, or `wawitas-app` is confirmed as the one |
| **2a** | Enable Email/Password + Google providers | A user can sign in on `/cuenta` |
| **2b** | Write the admin custom claim via a one-off Admin SDK script | `request.auth.token.admin === true` for your own uid |
| **2c** | Exercise `firestore.rules` from a **real client** | First time enforcement is tested at all — see below |
| **3** | Seed one real pet document by hand | The Muro renders it in **production**, allowing one 300 s ISR window |

**Step 2c is the one to slow down on.** `firestore.rules` has been compiled and
released since 2026-08-12 but **never enforced against a client**, because no
client could reach Firestore. The moment auth works, every rule in that file gets
exercised for the first time simultaneously. Expect failures there, and read them
as "the rules were never tested" rather than "auth is broken."

**Seed constraints for step 3**, both already documented and both still true:
`coverPhoto` must be served from `firebasestorage.googleapis.com` or the page
throws `E231` and 500s, and `status` must be `adopcion` with a `createdAt` or
the wall query will not return it.

### 0.2 What to build after that, and what to skip

Steps 4 → 5 → 5a are the shortest path to a system the shelter can actually use
daily: media upload, the intake wizard, and the arrival pipeline. **That is a
coherent shippable increment** — an admin can announce an incoming dog, record
it on arrival, assign it to a quarantine area, and publish it to the wall.

Everything AI-shaped (steps 8, 9, 11) and the food module (13) sit behind that
deliberately. They are the interesting parts and they are not the urgent parts.

Two things to resist:

- **Do not start with the Gemini work** because it is the novel bit. It depends
  on a review UI, which depends on the admin console, which depends on auth.
- **Do not add mock or fallback pet data** to make the wall look populated. It
  was tried on 2026-08-08, collided with the image-host rule, and was reverted.

---

## 1. Standards decisions

The full reasoning is in the research docs, and the Bolivia-specific answer —
what actually binds a shelter in Cochabamba versus what we adopt by choice — is
[`veterinary-records-standards.md` §6](veterinary-records-standards.md#6-bolivia--which-standards-actually-bind-us-and-which-we-choose).

The one-line version: **Bolivia mandates nothing here, so we choose — and the
choice is forced anyway** by SENASAG's ISO-based export paperwork, by the ISO
hardware sold locally, and by keeping internationally adopted animals eligible
under EU rules. The decisions:

| Question | Decision | Why |
|---|---|---|
| **Microchip standard** | **ISO 11784 / 11785**, FDX-B at 134.2 kHz | Already implemented and tested. The only universal standard in the domain. Keeps internationally adopted animals eligible under EU rules |
| Non-ISO chips | Keep `non-iso-125` / `non-iso-128` as first-class | A shelter records what it scans, not what it wishes it scanned |
| **Medical record standard** | **None exists.** Model on the **EU pet passport** section structure + **WSAVA 2024** certificate fields | The only published, internationally legible field schema for this data |
| **Vaccination practice** | **WSAVA 2024**, using the **shelter table** and the **Latin America regional recommendations** (published in Spanish) | Correct protocol for our actual use case, in our actual language |
| **Clinical terminology** | **Defer.** Free text + `MedicalRecordKind` enum, plus an empty optional `codes[]` | VeNom and SNOMED VetSCT are both real; neither survives contact with a volunteer transcribing a handwritten card. Backfillable later |
| **Exchange format** | None. Keep one medical event per document so a FHIR-shaped export stays possible | No adopted veterinary FHIR profile exists. Don't build for it, don't preclude it |
| **Vaccine product ids** | Free text: manufacturer + product name + lot | No international registry exists. Transcribe the card faithfully |
| **Population management** | **WOAH Terrestrial Code Ch. 7.7** — cite, don't implement | Bolivia is a WOAH member state. No schema, but it is the legitimacy argument for grants and municipal partnership |
| **QR symbology** | **ISO/IEC 18004**, error correction **level Q** | Collar tags get scratched. The usual level M default is not enough |
| **QR payload** | Plain HTTPS URL with an **opaque revocable token**. Not GS1 Digital Link | GS1 needs paid membership and buys interoperability with retail systems no shelter will use |

---

## 2. Data model changes

Existing collections are unchanged except where noted. The tier discipline from
`CLAUDE.md` holds throughout: **a new visibility tier is a new document, never a
new field.**

### 2.1 `MedicalRecord` — four additions

The EU passport and WSAVA both demand fields we don't have:

```ts
  /** Vaccine manufacturer as printed on the card. Null for campaign doses. */
  manufacturer: string | null;

  /**
   * When protection BEGINS. For rabies this is 21 days after the primary
   * protocol completes, NOT the injection date — and it is the date with legal
   * consequences. Distinct from performedAt on purpose.
   */
  validFrom: Timestamp | null;

  /**
   * When protection LAPSES — WSAVA's "duration of immunity" field. Distinct
   * from nextDueAt, which is when to come back. Core vaccine immunity commonly
   * outlasts the booster interval, and conflating the two is how an animal gets
   * revaccinated unnecessarily or travels on lapsed cover.
   */
  validUntil: Timestamp | null;

  /** Reserved for a future VeNom / SNOMED VetSCT mapping. Empty for now. */
  codes: string[];
```

Add `'serologia'` to `MedicalRecordKind` — titre testing is §VI of the passport
and WSAVA-endorsed, and it is not a `consulta` with a note.

**Keep `veterinarian` and `batch` nullable and do not treat null as incomplete.**
Bolivia's free national rabies campaign produces exactly this: a real, valid
vaccination with no named vet and no lot number. Cochabamba receives the largest
departmental allocation in the country, so this is the common case here, not an
edge case.

### 2.2 `pets/{petId}/media/{mediaId}` — new, replaces the photo arrays

The request adds **videos**, and the current model has nowhere to put them:
`coverPhoto` is one public string and `detail.photos[]` is an array in a gated
document.

```ts
export type MediaKind = 'photo' | 'video';
export type MediaTier = 'public' | 'auth';

export interface PetMedia {
  id: string;
  kind: MediaKind;
  tier: MediaTier;

  /** Storage path, not a URL — URLs are derived at read time. */
  path: string;
  /** Generated derivatives: thumb, card, full. Videos also get a poster frame. */
  derivatives: Record<string, string>;

  width: number | null;
  height: number | null;
  durationSeconds: number | null;   // video only
  /** Spanish alt text. Required for photos — accessibility, and it feeds the LLM. */
  alt: string | null;
  /** Ordering on the expediente. The cover is order 0 with tier 'public'. */
  order: number;

  uploadedAt: Timestamp;
  uploadedBy: string;
}
```

**This bends the "tier is a document" rule and the reason should be explicit.**
Media is many-per-pet and unbounded; an array in a document means every upload
rewrites the whole document, and a pet with 40 photos plus video derivatives
approaches Firestore's 1 MiB document ceiling. So tier becomes a *field*, and the
rule enforces it via a **query constraint** instead:

```
match /pets/{petId}/media/{mediaId} {
  allow read: if resource.data.tier == 'public' || isSignedIn();
  allow write: if isAdmin();
}
```

The caveat that must be understood by whoever writes the client: on a **query**,
Firestore evaluates rules against the query's constraints, not the results. An
unauthenticated client must issue `where('tier','==','public')` or the whole
query is rejected — it does not silently return a filtered subset. This is a
known Firestore sharp edge and it will look like a broken query the first time
it happens.

`Pet.coverPhoto` stays as-is. It is denormalised on purpose: the wall renders it
server-side, and a subcollection read per card would multiply the wall's
Firestore cost by the number of pets on it.

### 2.3 `petDrafts/{draftId}` — new, admin-only

Where a half-finished intake lives, and where LLM output lands before a human
confirms it. Separate from `pets` so an unfinished animal can never appear on the
public wall through a status typo — the wall queries `pets`, and a draft is not
in `pets`.

```ts
export interface PetDraft {
  id: string;
  /** Everything the wizard has collected so far. All optional by design. */
  payload: Partial<Pet & PetDetail & PetIdentity>;
  medical: Partial<MedicalRecord>[];
  /** Per-field provenance, so the UI can highlight what the LLM guessed. */
  fieldSources: Record<string, 'manual' | 'llm-extracted'>;
  /** 0–1 per field, from the extraction. Low confidence forces review. */
  fieldConfidence: Record<string, number>;
  step: number;
  createdBy: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
```

### 2.4 `adoptionApplications/{applicationId}` — new

`adoptions/{petId}` records a *completed* adoption. "Users should be able to
adopt" needs the step before it, which does not exist.

```ts
export type ApplicationStatus =
  | 'enviada' | 'en-revision' | 'entrevista' | 'aprobada' | 'rechazada' | 'retirada';

export interface AdoptionApplication {
  id: string;
  petId: string;
  applicantUid: string;

  /** Contact + housing + household. The shelter's real screening questions. */
  answers: Record<string, string | boolean | number>;
  status: ApplicationStatus;
  /** Admin-only. Never readable by the applicant. */
  internalNotes: string | null;

  submittedAt: Timestamp;
  decidedAt: Timestamp | null;
  decidedBy: string | null;
}
```

**Read rule: the applicant and admins only.** An application contains a private
individual's housing situation, household composition, and contact details.
`internalNotes` must live in a separate admin-only document — an applicant who
can read the shelter's private assessment of them is a problem the first time
someone is rejected.

### 2.5 `qrTokens/{token}` — new, public read

```ts
export interface QrToken {
  token: string;      // doc id; opaque, ~10 chars base32
  petId: string;
  revokedAt: Timestamp | null;
  createdAt: Timestamp;
  createdBy: string;
}
```

Public read is deliberate and safe: the token resolves to the **public** tier
only, exactly like `findPetByMicrochip()`. A separate document rather than a
field on `pets` so a token can be revoked and reissued without touching the
animal's record, and so the reverse lookup is one `get()` by document id rather
than a query.

### 2.6 `api_usage_daily/{date__process__model}` — new, server-only

Playbook §4.1, and it goes in **at the first AI call site, not later**. A bounded
daily rollup — `~processes × models × 365` documents/year — incremented by
`recordAiUsage`.

```ts
export interface AiUsageDaily {
  date: string;          // UTC, YYYY-MM-DD
  process: string;       // see the taxonomy below
  model: string;         // the resolved id, for cost attribution
  calls: number;
  inputTokens: number;
  outputTokens: number;
  estCostUsd: number;
}
```

Process taxonomy in the shelter's vocabulary, not the code's:

| Process | Label |
|---|---|
| `carnet_extract` | Lectura de carné de vacunación |
| `social_copy` | Redacción para redes *(deferred — §5)* |

**No `groundingRequests` field.** The playbook's rollup carries one; we do not
ground, and a column that is structurally always zero invites someone to later
assume grounding is metered when it is not. If grounding is ever added, the
column arrives with it.

Rules: **server-side access only.** Nothing client-side reads or writes this.

Two properties that are non-negotiable, both from playbook §4.1: `recordAiUsage`
**never throws** (an observation that can break the thing it observes is worse
than no observation), and the structured log line is emitted **synchronously** so
detail survives a Cloud Run cold shutdown that drops the Firestore write.

### 2.7 `pets/{petId}/measurements/{measurementId}` — new, authenticated read

**The model has no weight field, and two new subsystems both require one.**
`Pet.size` is `pequeno | mediano | grande`, which is a wall filter, not a
clinical quantity. Drug dosing is `mg/kg` and energy requirement is a function of
`kg^0.75`; neither can be computed from a size bucket.

```ts
export interface PetMeasurement {
  id: string;
  weightKg: number | null;
  /** WSAVA 9-point Body Condition Score. 1 emaciated, 5 ideal, 9 obese. */
  bcs: number | null;
  /** WSAVA Muscle Condition Score — separate axis from fat. */
  mcs: 'normal' | 'leve' | 'moderada' | 'marcada' | null;
  measuredAt: Timestamp;
  measuredBy: string;
  note: string | null;
}
```

**Why a subcollection and not two fields on `Pet`.** "The fat ones are reduced,
the slim are increased" is a **feedback loop**, and a feedback loop needs a
trend, not a current value. One BCS reading tells you a dog is thin; a sequence
tells you whether the extra ladle is working. Latest values get denormalised onto
`Pet` for the wall and for dose calculation, the way `coverPhoto` already is.

**BCS is a real standard, not an ad-hoc field.** The
[WSAVA Global Nutrition Guidelines](https://wsava.org/global-guidelines/global-nutrition-guidelines/)
9-point scale is the same body whose vaccination guidelines §3 of the research
doc already adopts — 1 emaciated, 5 ideal, 9 grossly obese, with 4–5 ideal for
dogs. WSAVA publishes the charts in its Global Nutrition Toolkit, in Spanish,
which means the admin UI can show the real chart rather than asking a volunteer
to guess what "gordo" means. Modelling it as a free-text `gordo | flaco` would
throw away a calibrated, repeatable scale for nothing.

### 2.8 `socialPosts/{postId}` — ⏸ deferred, not built

> **Deferred at the user's direction, 2026-08-16.** Facebook and Instagram only
> when it happens; X and TikTok are out. Kept here as a record of the intended
> shape so the decision does not get re-litigated — **do not build this yet.**

```ts
export type SocialPlatform = 'facebook' | 'instagram' | 'x' | 'tiktok';
export type SocialPostStatus =
  | 'borrador'      // LLM generated, awaiting human edit
  | 'aprobado'      // human approved, queued
  | 'publicando'
  | 'publicado'
  | 'fallido';

export interface SocialPost {
  id: string;
  petId: string;
  platform: SocialPlatform;

  /** LLM output. Always editable before publish. */
  body: string;
  hashtags: string[];
  mediaIds: string[];

  status: SocialPostStatus;
  /** Set on publish. The permalink, for the audit trail and for un-posting. */
  externalId: string | null;
  externalUrl: string | null;
  error: string | null;

  generatedBy: 'gemini';
  /** Null until a human has read it. Nothing publishes with this null. */
  approvedBy: string | null;
  approvedAt: Timestamp | null;
  publishedAt: Timestamp | null;
}
```

**No access token ever goes in Firestore.** Platform credentials live in Secret
Manager, bound to the Cloud Run runtime service account. `CLAUDE.md` already
carries the rule that Terraform owns the Cloud Run env list — these are secret
refs, declared in Terraform, not CI-injected.

---

## 3. The intake flow

Six steps, each independently saveable to `petDrafts`. The ordering is chosen so
the animal is publishable as early as possible — the primary objective is getting
a stranger to message about a specific animal, and that only needs steps 1–2.

```
1. Identity      species, name, sex, size, estimated age, breed
                 → microchip scan/entry (validateMicrochip already exists)
                 → DEDUPLICATION CHECK — see 3.1
2. Media         drag-drop photos + video. First photo = cover.
                 → Spanish alt text required on photos
3. Story         temperament, story, commitments, good-with-children/pets
4. Medical       ── upload vaccination card → Gemini extraction → REVIEW ──
                 or manual entry
5. Care          feeding plan, restrictions
6. Publish       preview the public card + the expediente
                 → batched write to pets/{petId} + subcollections
                 → mint qrTokens/{token}
```

### 3.1 Re-admission: the chip is a deduplication key, not just a field

Shelters take the same street animal in more than once — returned adoptions,
recaptured strays, transfers back from a foster. A linear "create new pet" wizard
produces a second record for the same animal, and then the medical history is
split across two documents with neither one complete. That is the failure this
system exists to prevent.

So step 1 is not just entry, it is a **lookup**:

```
chip entered → validateMicrochip() → findPetByMicrochip()
                                          │
              ┌───────────────────────────┴──────────────────────┐
              │                                                  │
        resolves to a pet                                  no match
              │                                                  │
    ┌─────────┴──────────┐                             continue as new intake
    │                    │
 Reabrir expediente   Es otro animal
    │                 (chip mis-read, or a
    │                  mis-linked record)
    ▼                    ▼
 skip to step 2,      flag for admin;
 append a new         NEVER silently
 custody + scan       create a duplicate
```

Three things follow:

- **Reopening writes history, it does not overwrite.** A re-admission appends a
  new `CustodyEvent` and a `ScanEvent` with `context: 'intake'`. The existing
  medical records, microchip identity and former names stay. `Pet.status` moves
  back to `refugio`, and the current name goes to `formerNames` if it changed.
- **`findPetByMicrochip()` already exists** and returns the public tier only.
  Intake runs as an admin, so this path needs an admin-scoped variant that can
  show enough to confirm identity — or it reuses the existing one and links
  through to the full expediente.
- **A chip that resolves to an unexpected animal is a real signal, not an
  error.** `ScanEvent.codeRead` exists precisely to record a mismatch. Surface
  it; do not let the wizard "fix" it by creating a fresh record.

**Animals without a chip get no deduplication.** Most street rescues arrive
unchipped, so this check protects the minority case. A name-and-photo similarity
prompt is possible later; it is not in this plan, and pretending otherwise would
oversell the guarantee.

**Steps 3–5 are skippable.** A rescue arriving at 22:00 needs to be on the wall,
not blocked on a feeding plan. Publishing with only steps 1–2 is a supported
path, and the admin dashboard shows what's incomplete rather than refusing.

**Validation that must run at entry, not later:**

- `validateMicrochip()` — already built and tested, 10/10. Wire it in.
- `rabiesVaccinationIsValid()` — already built. Fires when a rabies record is
  entered against a chip implant date.
- **New: the 12-week rule.** Reg. (EU) 2026/131 requires the animal be ≥12 weeks
  old at rabies vaccination. Bolivia's national campaign vaccinates **from 10
  days**. Both are legitimate; they answer different questions. Surface this as
  an informational note — *"protegido bajo la campaña nacional; no cumple los
  requisitos de viaje a la UE"* — and **never as an error**. Flagging a
  correctly-administered Bolivian campaign dose as invalid would train staff to
  ignore the validator.

---

## 4. Gemini vaccination-card extraction

**Decided 2026-08-16: Gemini API via AI Studio (`generativelanguage.googleapis.com`)
with an API key. Not Vertex AI.** This follows
[`gemini-api-playbook.md`](gemini-api-playbook.md), which is ~4 months of
production experience on this exact surface from a sibling stack. Everything in
this section defers to that document; where the two disagree, the playbook wins.

### 4.1 Setup

Per playbook §1 and §15, day one:

```jsonc
"ai":              "^6.0.159",   // AI SDK core — all real-time paths
"@ai-sdk/google":  "^3.0.62",    // Gemini provider
"@google/genai":   "2.8.0",      // PINNED. Files API only — see 4.5
"zod":             "^3.24.1"     // v3, not v4 — generateObject schemas
```

Five modules before the first call, not after:

| File | Why |
|---|---|
| `src/lib/ai/google.ts` | Provider on **`v1beta`** with an explicit `x-goog-api-key` header. The v1 surface silently lacks features |
| `src/lib/ai/model-ids.ts` | Every model ID in one place, with **persistence-stable keys separate from IDs** |
| `src/lib/ai/pricing.mjs` | Pure price table with a **Flash-tier fallback, never 0**, plus `estimateCostUsd`. Unit-tested under `node --test` |
| `src/lib/ai/metered.ts` | `recordAiUsage` — never throws, `void`-called. **Wired at the very first call site** |
| `src/lib/ai/schemas.ts` | The Zod schemas that are both the API contract and the parse boundary |

Also alias `GOOGLE_GENERATIVE_AI_API_KEY = GEMINI_API_KEY`; some SDK paths read
the former.

### 4.2 The cost shape here is the easy one — and it is worth saying why

The playbook's dominant cost risk is **grounded search**, billed per search query
at $0.014, invisible to token counters, and 73% of one month's bill. **We use no
grounding at all.** Card extraction reads an uploaded image; copy generation reads
a Firestore record. Neither searches the web, and neither should ever be given
`googleSearch` as a tool.

That removes the single biggest failure mode in the playbook by construction. Say
so at the call sites, because playbook §5.3 records grounding creeping back in via
an unrelated commit and running for **five weeks** unnoticed.

What still applies: metering from day one, a price table that falls back to Flash
rather than zero, and reading `usage.reasoningTokens` — thinking tokens bill as
output and `maxOutputTokens` does not bound them.

### 4.3 Extraction contract

Runs as a Server Action on the existing Cloud Run service. No new infrastructure.

- **`generateObject` + a Zod v3 schema** (playbook §6). The schema is the parse
  boundary, so malformed output fails loudly instead of writing garbage.
- **Prompt in Spanish.** The cards are Spanish, handwritten, often stamped, often
  faded.
- **Verbatim transcription, in the card's own wording** (playbook §6.3). Do not
  let the model normalise `"quíntuple"` into a canonical vaccine name or reformat
  a date. A silently normalised value cannot be checked against the image, and
  §5 of the research doc already decided product names stay as printed.
- **Return the snippet it read, per field.** Alongside each value, the model
  returns the literal text it believes it saw. This is our substitute for the
  playbook's post-hoc verbatim validator — we cannot string-match against a
  source document because the source is an image, so the check has to be a human
  looking at *"I read `12/03/25` here"* next to the original. It makes review
  fast enough to actually happen.
- **Per-field confidence, 0–1, required.** Below threshold is highlighted rather
  than silently accepted.
- **Never invent a date.** `null` is always the correct answer when unsure. A
  hallucinated vaccination date is a health decision made on fabricated data, and
  for rabies it carries legal consequences.
- **The card image is retained** as `sourceDocument` — the field already exists.

**Failure direction, stated explicitly** (playbook §6.2, the most transferable
idea in it): this is a **persistence gate into a medical record**, so it
**fails toward dropping**. A missing field costs one manual entry; a wrong
vaccination date is served, trusted, and acted on for years.

### 4.4 Store the model key, not the model ID

Playbook §2.1: model IDs churn every few months; a key written into a database
can never be renamed. `MedicalRecord.source` is currently the string
`'llm-extracted'`. Extend the provenance to carry **which** model produced it:

```ts
  source: 'manual' | 'llm-extracted';
  /** Stable KEY, never the raw model id. e.g. "gemini-3-flash". */
  extractedByModel: string | null;
  extractedAt: Timestamp | null;
```

Without this, an accuracy problem traced to one model generation cannot be
scoped — you cannot find the records it wrote.

### 4.5 Inline the image; the Files API is a later problem

Playbook §9: inline data caps at **~20 MB** per request and base64 inflates ~33%,
so the practical inline ceiling is ~15 MB of source image. A phone photo of a
vaccination card is 2–5 MB. **Inline is correct here**, which keeps every
real-time path on the AI SDK and `@google/genai` unused.

Revisit only if someone uploads a multi-page PDF of a full clinical history. If
that day comes, the playbook's rules apply in full: poll to `ACTIVE` at upload
time not request time, cache the routing decision below the 48 h retention, and
note that AI SDK v6 file parts use **`mediaType`, not `mimeType`** — `mimeType`
type-checks and throws at runtime.

### 4.6 Two-extractor consensus — phase 2, and here is the honest case

Playbook §6.1 runs the same schema on two model tiers and escalates
disagreements. Measured reality there: a Flash + Flash-Lite pair **disagrees on
roughly 100% of extractions**, and arbitration cost ~$0.017 per item.

Normally that ratio argues against it. Here it argues *for* it, for a reason
specific to this flow: **we already mandate human review, so the scarce resource
is the reviewer's attention, not the model's verdict.** A second extractor's
disagreement is a precision-targeted *"look at this field"* marker. We do not need
arbitration at all — the human is the arbiter, and they were going to be there
anyway.

Not phase 1: it doubles extraction cost and complexity to improve a review step
that has not yet been used once on a real card. Build the single-extractor path,
measure how often review actually catches something, then decide.

### 4.7 Voice dictation for the veterinary consult

**Added at the user's direction, 2026-08-16.** The vet speaks a diagnosis; the
system transcribes it and extracts medications, dosages and findings into
`pets/{petId}/medical/{recordId}`.

This is the same plumbing as card extraction — same provider, same metering, same
review discipline — but **the stakes are materially higher and the design has to
reflect that.**

#### Why this is the highest-risk path in the system

A misheard vaccination date on a card is recoverable. **A misheard dose is not.**
`0.5 ml` and `5 ml` differ by one syllable in spoken Spanish and by a factor of
ten in the animal. `15 mg` and `50 mg` are near-homophones. Concentration and
volume are routinely conflated in speech — a vet says *"un mililitro de
ivermectina"* without stating the concentration, and the same volume of a
different presentation is a different dose entirely.

So the dosage path gets treatment nothing else in this plan gets.

#### One call, two outputs

Gemini accepts audio natively, so transcription and extraction are a single
`generateObject` call rather than a separate speech-to-text service. But the
schema must return **both**:

```ts
{
  transcript: string,            // VERBATIM. The vet's actual words, unedited.
  findings: { ... },
  medications: Array<{
    name: string,                // as spoken, not normalised
    dose: number | null,
    doseUnit: 'mg' | 'ml' | 'mg/kg' | 'UI' | 'gotas' | null,
    concentration: string | null,
    route: 'oral' | 'sc' | 'im' | 'iv' | 'topica' | null,
    frequency: string | null,
    durationDays: number | null,
    heardAs: string,             // the literal phrase this came from
    confidence: number,
  }>
}
```

**The verbatim transcript is the record; the extraction is a convenience.** If
the two ever disagree, the transcript wins. Storing only the structured output
would discard the one artefact that lets a vet check what was actually said —
and playbook §6.3's warning about deleting text from a model's output applies
directly: a scrubber that removed a link once produced *"Submit the completed to
the regulator"*, confident and grammatical and wrong.

`heardAs` is the §4.3 verbatim-snippet rule doing its most important work. The
reviewer sees *"heard: «medio mililitro»"* beside `0.5 ml`.

#### Two-extractor consensus is REQUIRED here, not phase 2

§4.6 argued consensus was optional for vaccination cards. **For dosages it is
not.** The playbook measured a Flash + Flash-Lite pair disagreeing on ~100% of
extractions, which is precisely the property wanted: run both on the same audio,
and **any disagreement on a dose, unit, or concentration hard-blocks the record**
until a human resolves it. `Promise.allSettled`, never `Promise.all` — one
extractor failing must not lose the other's work.

Agreement is not proof of correctness. It is a cheap filter that lets the vet's
attention go to the fields where the models diverged, and at ~$0.017 per consult
it is the least expensive safety measure in this document.

#### The rest of the rules

- **Failure direction: drop, hard.** Playbook §6.2. An unparseable dose is
  `null` and a manual entry. There is no defensible reason to guess.
- **Nothing auto-commits, ever.** The dictating vet confirms their own record.
  They are professionally responsible for it, and the system must not put words
  in their notes — record `dictatedByUid` separately from `confirmedBy`.
- **Never compute a dose.** The system may *display* `mg/kg × weightKg` as an
  arithmetic aid next to what was dictated, clearly labelled as a calculation.
  It must never write a computed dose into the record as though it were
  prescribed. That is the line between a transcription tool and an unlicensed
  prescribing system, and it is not a line to be near.
- **`weightKg` is a precondition** (§2.7). A `mg/kg` dose against a null weight
  is not a partial record, it is an uninterpretable one — surface it as missing.
- **The audio is the source document**, stored like the card scan. It is
  **restricted tier**: a consult recording can carry a client's name, a
  volunteer's voice, and an address mentioned in passing. It is not `medical`'s
  authenticated tier.
- **Spanish, Bolivian veterinary vocabulary.** Prompt for it explicitly and do
  not let the model normalise drug names into international spellings.

#### Audio size

Playbook §9: inline caps at ~20 MB before base64 inflation. A compressed
few-minute consult is comfortably under that, so **inline, same as the card**.
A long multi-animal session is the case that would need the Files API — enforce a
recording length cap in the client rather than discovering the ceiling in
production, and note that the model-side limits are stricter and format-specific
than the upload limits.

### 4.8 The review gate is not optional

`MedicalRecord.source` and `confirmedBy` **already exist** in the schema — the
2026-08-07 design anticipated this exactly. Honour it:

- Everything Gemini produces is written with `source: 'llm-extracted'` and
  `confirmedBy: null`.
- An unconfirmed record is visible in the admin UI and **excluded from anything
  that computes** — due dates, travel eligibility, the public "vacunado" badge.
- Confirmation is per-record, one click, and stamps `confirmedBy`.

The realistic accuracy expectation should be stated plainly: handwritten dates
on a faded card, photographed on a phone, will be read wrong sometimes. The
review step is not ceremony.

---

## 5. Social syndication — ⏸ DEFERRED

> **Decided 2026-08-16: do not build this now.** When it is built, it is
> **Facebook and Instagram only**. X and TikTok are out — the research below is
> why, and it is kept so the question is not reopened from scratch.
>
> Nothing in §9's build order depends on this section. `socialPosts` (§2.8) is
> not created, no Meta app is registered, and no platform adapter is written.
> The one thing worth doing early is the **one-minute check in §5.3**, because
> if it fails, the eventual plan changes shape entirely and it is better to know
> now than after building an intake flow that assumes a publish target.

### 5.1 What is actually possible, per platform

Researched 2026-08-16. This is the part of the request with the largest gap
between what is asked and what the platforms permit.

| Platform | Programmatic posting | Cost | The blocker |
|---|---|---|---|
| **Facebook Page** | ✅ Graph API | Free | Meta app + `pages_manage_posts`. **App Review avoidable** — see below |
| **Instagram** | ✅ two-step: create container → publish | Free | Professional account linked to the FB Page. 100 API posts / 24 h |
| **X (Twitter)** | ✅ | ⚠️ **~$0.20 per post containing a URL** | The free tier was **discontinued 6 Feb 2026**. New developers get pay-per-use only; the $200/mo Basic tier is closed to new signups |
| **TikTok** | 🟡 Content Posting API | Free | Requires a **separate audit**. Until it passes, every post is forced to `SELF_ONLY` — invisible to the public |
| WhatsApp Channels | ❌ | — | No public posting API |
| Threads | ✅ | Free | Real, lower priority |

**The App Review escape hatch — this is what makes Phase 1 shippable.** A Meta
app in **Development mode** can use `pages_manage_posts` for users who hold a
role on the app, with no App Review. Instagram has the equivalent via the
Instagram Tester role. Since we are posting to *the shelter's own* Page and
account — not offering a service to third parties — the app stays in Development
mode indefinitely and never goes near a 2–4 week review cycle. Combined with a
long-lived Page access token, which does not expire on a timer, this is a
genuinely low-maintenance integration.

**X is the one that costs money.** Every post we generate contains a link to the
pet's expediente — that *is* the point of the post — which puts every X post in
the ~$0.20 bucket rather than the ~$0.015 one. At 20 animals/month that is ~$4/mo:
small in absolute terms, but it is a recurring per-post charge on a project whose
stated constraint is $0/month, and it scales with exactly the activity we want to
increase.

**TikTok fights the format.** Beyond the audit, TikTok is video-first, and the
shelter's content is overwhelmingly photographic. A photo carousel is possible
but it is not what performs there. The honest recommendation is that TikTok
deserves a human posting real video, not an API syndicating a database record.

### 5.2 Decision

**Facebook + Instagram only, and not yet.** Both free, both avoid App Review,
and both are where Wawitas' 1.9K followers already are.

**X and TikTok are out**, not deferred. X charges ~$0.20 per post carrying a URL
and every post we would generate carries one; TikTok demands an audit to escape
`SELF_ONLY` and is a video-first platform for photo-first content. Neither is a
close call. If either is revisited, it should be because something in the tables
above changed, not because the idea resurfaced.

When this is built, the syndication layer should still be written
platform-agnostic so Facebook and Instagram are two adapters rather than two
code paths — but that is a phase-2 design note, not work to do now.

### 5.3 ⚠️ Verify the Facebook target is a Page, not a profile

`PLAN.md` §5 asserts the Wawitas page is a Facebook Page rather than a personal
profile. The URL on file is `profile.php?id=61563998952145`. That format *is*
consistent with a Page created under the New Pages Experience — IDs beginning
`61` are typical — but it is also the format of a personal profile, and **the
Graph API cannot post to a personal profile at all.**

This is a one-minute check that invalidates the entire Facebook and Instagram
half of this plan if it goes the wrong way. **Do it before writing any adapter
code.**

### 5.4 Nothing auto-publishes

Every generated post lands as `borrador` and requires `approvedBy` before it can
be queued. Three reasons, and the first is sufficient:

1. **The copy is machine-written and it goes out under a real shelter's name**,
   to 1.9K people who know them. A hallucinated claim that an animal is "great
   with children" is not a typo — it is a placement decision, and it can get a
   child bitten and an animal returned.
2. A wrong post cannot be reliably retracted across platforms.
3. `PLAN.md` §5 already made this exact call for the inbound Facebook sync — *"A
   weekly two-minute confirmation is a fair price for a site that is always
   correct."* The same logic applies with more force outbound, because outbound
   is public.

### 5.5 LLM copy generation

Same AI Studio path as §4 — provider, metering and price table are shared, and
this becomes a second `process` tag (`social_copy`) on the same rollup. Its
failure direction is **silence**: if generation fails, there is simply no draft
to approve, which is a non-event.

- **Input is the structured record only.** The prompt receives explicit fields
  and is instructed to use nothing else. It must not infer temperament, health,
  or suitability that is not in the record — see reason 1 above.
- **Per-platform variants** from one call: Facebook long-form, Instagram with
  emoji and hashtags, X within 280 characters.
- **Spanish, in the shelter's voice.** They have a corpus already —
  `PLAN.md` §1 quotes real captions (*"¡ADOPTA A MOCCA! …COMPROMISOS: castración
  gratuita a sus 6/7 meses. Se hará seguimiento."*). Few-shot on their own posts
  rather than inventing a voice.
- **Always ends in the conversion.** The `wa.me` deep link pre-filled with the
  animal's name, plus the expediente URL. This is the primary objective and it
  is not the LLM's creative decision — template it around the generated body.
- Media selection: public-tier media only, `order` ascending.

---

## 6. The adoption flow — and a conflict worth naming

### The conflict

`CLAUDE.md`'s primary objective is *"get a stranger from scrolling to messaging
the shelter about a specific animal"*, and `PLAN.md` §2 is emphatic that the
conversion is **WhatsApp, no account, no form** — *"three taps from landing to
conversation"*, and that this is "the single highest-leverage decision in the
plan."

"Users should be able to adopt the pet" implies an account and a form. A signup
wall in front of the WhatsApp button would directly undercut the project's stated
primary objective.

### The resolution

**Both, with WhatsApp unambiguously primary.** They serve different people:

```
Expediente
  ├── [ ADÓPTAME por WhatsApp ]   ← coral, primary, no account. UNCHANGED.
  └──   Postular en línea →        ← secondary, text link, optional account
```

The online application is worth having because it captures the structured
screening answers the shelter currently gathers by hand over WhatsApp, and it
gives them a reviewable queue instead of a chat backlog. It is not worth having
at the cost of the conversion rate.

**Design rule: the account requirement never moves in front of the WhatsApp
button.** If measurement later shows the online path performing better, that is
a decision to revisit with data — not an assumption to build in now.

### The flow

1. Visitor reads the expediente (public tier).
2. Optionally signs in — this also unlocks the gated `detail` tier, which is the
   real incentive to create an account, rather than a wall.
3. Submits an application: housing, household, other pets, experience, why this
   animal.
4. Admin sees it queued against the pet. Status moves through
   `en-revision → entrevista → aprobada`.
5. On approval, the admin creates `adoptions/{petId}` — which is what
   `ownsPet()` resolves against, unlocking the restricted tiers (microchip,
   medical, feeding) **to the new owner**. The identity record transfers with
   the animal, which is the secondary objective working as designed.
6. A `custody` record is written. `Pet.status` → `adoptado`.

**Step 5 is the first real test of `firestore.rules`.** Those rules have been
compiled and released but never exercised against a live client — the ownership
path is the most intricate thing in them, and this is where it either works or
does not.

---

## 7. QR codes

**Payload:** `https://wawitas.org/id/{token}` — a short host and a ~10-character
base32 token keep the symbol at a low version, which is what keeps it scannable
at collar-tag size. Level Q error correction, 4-module quiet zone, ≥20 mm printed.

**Generated server-side as SVG.** No external QR service: sending pet identifiers
to a third-party image API is a privacy leak for zero benefit, and it puts a
runtime dependency in the path of a printable page.

**What `/id/{token}` shows** — the same stance as `findPetByMicrochip()`:

| Visitor | Sees |
|---|---|
| Anyone | Public tier: photo, name, species, breed, size, status, `hasMicrochip`. Plus a prominent **"¿Encontraste a este animalito?"** → WhatsApp |
| Signed in | Adds the gated `detail` tier |
| Owner / admin | Adds microchip, medical, feeding, custody |

A finder gets a name and a phone call in one scan without an account. They do not
get the microchip number, an address, or the ability to enumerate the registry.

**Print surface:** `/admin/pets/{id}/qr` with a print stylesheet — a single tag,
and a sheet of tags for a batch intake.

**The honest limitation, which belongs in the UI copy:** a QR tag is on the
collar and the collar comes off. The microchip is under the skin and does not.
These are complementary, and the QR is the one that works for a member of the
public with a phone and no scanner — which is most finders. Neither is a tracker;
`rfid-microchips.md` §1 applies to both.

---

## 8. Infrastructure changes

| Change | Where | Note |
|---|---|---|
| **Secret Manager: `GEMINI_API_KEY`** | `terraform/` + Cloud Run `secret_key_ref` | **Create the secret version BEFORE a `version = "latest"` binding resolves**, or the revision fails to start. `CLAUDE.md` already carries this lesson |
| `GOOGLE_GENERATIVE_AI_API_KEY` alias | same secret, second env entry | Some SDK paths read the alias |
| Cloud Run env vars | Terraform only | Never `--set-env-vars` in CI. A plain env silently overrides a `secret_key_ref` of the same name |
| Storage rules deployed | blocked | Media upload makes this urgent. Needs the Firebase default-bucket decision |
| `public_access_prevention` on `wawitas-app` | currently `inherited` | Decide now that media is real |
| New composite indexes | `firestore.indexes.json` | `adoptionApplications(petId, status)`, `media(tier, order)`, and the **collection-group** index on `placements(areaId, startedAt)` — §13.7 |
| Rules for new collections | `firestore.rules` | `petDrafts`, `adoptionApplications`, `qrTokens`, `api_usage_daily`, `areas`, `foodDonations`, `foodStock`, `cookBatches`, `feedingLog`, plus the `placements` and `measurements` subcollections. Still deployed by hand, deliberately |

**No Vertex AI, so no `aiplatform.googleapis.com` and no
`roles/aiplatform.user`.** The AI Studio surface is a public API reached with a
key — it needs no GCP project binding, no ADC, and no IAM grant. That is one
fewer apply-time API failure, and it sidesteps the ADC hazard `CLAUDE.md`
documents at length: an AI call now cannot resolve to the wrong project, because
it does not resolve to a project at all.

The tradeoff is honest and is the thing to watch: **an API key is a credential
this project did not previously have.** It goes in Secret Manager, never in
`.env.local` committed anywhere, and never in `plan` output — the sibling stack
leaked a salt that way and had to rotate it.

**Storage rules move from "not urgent" to blocking.** The current assessment in
`CLAUDE.md` — that the undeployed `storage.rules` is not an exposure — rests on
`wawitas-app` having no `allUsers` binding and holding nothing. Media upload ends
both halves of that.

---

## 9. Build order

Sequenced so something is verifiable at each step. With social deferred there is
no longer a risky external dependency to check first — every step below is
self-contained.

| # | Step | Unblocks |
|---|---|---|
| 1 | Firebase web app + `NEXT_PUBLIC_*` | Everything client-side |
| 2 | Auth: email + Google, admin custom claim | Every admin screen |
| 3 | Seed one real pet by hand | Proves the core loop end-to-end |
| 4 | Storage rules + media upload + derivatives | §2.2 |
| 5 | Admin intake wizard, steps 1–3, manual only | An admin can publish an animal |
| **5a** | **Arrival pipeline: `en-camino` → areas → placements** | §13 — weekly-use feature, and the outbreak requirement |
| 6 | **Re-admission / dedup path** | §3.1 — cheap now, expensive once duplicates exist |
| 7 | `MedicalRecord` extensions + manual medical entry | §2.1, §4.4 |
| 8 | **AI foundations**: provider, `model-ids`, `pricing.mjs`, `recordAiUsage` | §4.1 — before the first call |
| 9 | Card extraction + review gate | §4.3, §4.8 |
| 10 | **Weight + BCS measurements** | §2.7 — precondition for 11 and 13 |
| 11 | **Voice dictation + consensus dosage gate** | §4.7 — highest-risk path, build it after the review UI exists |
| 12 | QR tokens + `/id/{token}` + print sheet | §7 |
| 13 | **Food: donation parsing, stock, cook log, daily rations** | §12 — parallelisable |
| 14 | Adoption applications + admin queue | §6 — **first real test of the rules** |
| — | ⏸ *Social syndication* | **Deferred** — §5 |

**§13's arrival pipeline slots in at 5a**, immediately after the intake wizard
and before the dedup path. It is the earliest step in the animal's real-world
journey, it needs almost nothing built (a sparse form, an areas collection, an
interval ledger, a `wa.me` link), and it is the feature the staff touch every
week. Built there, it also gives step 6's dedup check somewhere sensible to
land a re-admission: straight back into quarantine.

**Step 10 before 11 and 13 is not optional.** Dosing is `mg/kg` and energy
requirement is a function of `kg^0.75`; both subsystems are uninterpretable
without a weight, and `Pet.size` is a wall filter, not a clinical quantity.

**Step 11 deliberately follows 9** rather than leading. The voice path is the
highest-consequence thing in this document, and it should be built on a review UI
that has already been exercised on real vaccination cards — not on one that has
only ever been reasoned about.

**Step 13 can move.** Food shares only `Pet` and the Gemini plumbing with
everything above it. If the shelter's daily pain is the pot rather than the wall,
build it right after step 8 and nothing breaks.

**Step 8 is its own step deliberately.** The playbook's §15 checklist puts
metering and the price table on day one, and its §4.2 records the cost of not
doing so: 14 unmetered call sites found in an audit, and per-turn classifiers
left unmeasured for months on the assumption they were too small to matter.
*"Too small to matter"* should be a claim the dashboard can **check**, not an
assumption baked into a blind spot. Wiring `recordAiUsage` at the first call site
costs an hour; retrofitting it costs an audit.

**Step 6 moved earlier than strict dependency order requires**, for a similar
reason: deduplication is cheap before there is data and expensive after, because
retrofitting means merging records that have already diverged.

Steps 5 and 11 are each independently useful if the plan stalls: 5 gives the
shelter a working admin console, 11 gives them a screening queue.

---

## 10. Cost

| Item | Estimate | Note |
|---|---|---|
| Firestore, Cloud Run, Storage | **$0** | Free tier is ~50× this shelter's volume |
| Firestore PITR + backups | small, existing | Already the first deliberate line item |
| **Gemini — card extraction** | cents/month | ~1–2 inline images per animal, Flash tier |
| **Gemini — vet dictation** | cents/month | Audio in, **two extractors** per consult (~$0.017 each), bounded by consults performed |
| **Gemini — donation parsing** | negligible | A short text string per delivery |
| **Food yield calculation** | **$0** | Deterministic arithmetic, not an LLM call — §12.1 |
| **Grounded search** | **$0 — structurally** | We use none. This is the SKU that was 73% of the sibling stack's bill |
| *Social (deferred)* | — | Facebook + Instagram are free when built |

**The bill stays effectively zero.** With X and TikTok out and grounding never
enabled, nothing in this plan has an unbounded cost path — extraction cost is
bounded by the number of animals a shelter physically handles, which is a
self-limiting quantity in a way that per-visitor or per-search costs are not.

Two guardrails worth keeping anyway, both cheap:

- **Price the model before swapping to it** (playbook §3.2). `pricingFor()` falls
  back to Flash rates for unknown IDs, so an unlisted model reports wrong on the
  very dashboard you would use to confirm the change.
- **Derive rates from the bill, not the pricing page.** The sibling stack's first
  price table under-reported spend ~9× because it used proxy rates. Ours will be
  a hypothesis until an invoice confirms it — mark which rows are bill-derived.

**The real financial event remains the trial expiring ~2026-11-10**, not anything
in this plan.

---

## 11. Open decisions

1. **Which Gemini model tier for extraction?** The playbook's Flash is the
   default, but a handwritten faded card is closer to its hardest OCR case than
   its easiest. Start on Flash, measure review-correction rate, and let that
   decide — not a guess made now.
2. **Storage: adopt a Firebase default bucket, or keep Terraform-managed
   `wawitas-app`?** Forced by step 4. Inherited from `CLAUDE.md` and now due.
3. **What does the adoption application actually ask?** The shelter has real
   screening questions today, asked over WhatsApp. Get their list rather than
   inventing one.
4. **Scan-history retention** — still open from `CLAUDE.md` concern #3, and now
   more pressing: intake writes the first real `ScanEvent` records.
5. **Do adopters get write access to their animal's record?** Currently
   admin-only writes throughout. An adopter updating a vaccination after a vet
   visit is genuinely useful and is a meaningful widening of the rules.
6. **Pot and ladle measurements** — the user is providing these. Until then the
   constants in `shelter.ts` stay `null` and no yield estimate is shown. §12.2.
7. **Does the shelter weigh its dogs, and how often?** §2.7 assumes a scale
   exists. If it does not, every `mg/kg` dose and every RER figure is an estimate
   built on an estimate, and that should be visible in the UI rather than hidden
   behind a computed number. This is worth asking before building step 10.
8. **Who dictates — the vet, or a volunteer relaying?** §4.7 assumes the vet
   speaks and confirms their own record. If a volunteer transcribes on their
   behalf, `dictatedByUid` and professional responsibility come apart, and the
   confirmation step needs rethinking.
9. **What are the actual areas, and their kinds and capacities?** §13.5 needs the
   real list — names or numbers as the shelter uses them. Worth seeding from
   reality rather than inventing "Cuarentena 1..3".
10. **How long is Wawitas' quarantine period, and is it observed in practice?**
    The ASV-referenced figures are ≥2 weeks for parvovirus exposure and up to a
    month for distemper. If the shelter's real period is shorter, the system
    should record what they actually do — not display a target they will miss and
    then learn to ignore.
11. *(Deferred with §5)* **Is the Facebook target a Page or a personal profile?**
   Not blocking anything now, but it is a one-minute check and the answer
   reshapes the eventual social plan. Worth doing opportunistically.

---

## 12. Food: donations, cooking, and daily rations

**Added at the user's direction, 2026-08-16.** The shelter receives raw food as
donations — pork, beef, chicken giblets, rice, vegetables — cooks it as soup in
one large pot, and serves ~40 dogs in ladles (*cucharones*): roughly 4 for a
large dog, 2 for a small one, reduced for the overweight and increased for the
thin. The system must track raw stock in, what can be cooked from it, and what is
actually served each day.

### 12.1 The architectural call: the LLM parses, arithmetic decides

The request says the LLM will calculate how much food can be cooked. **I'd do
that differently, and it matters.**

| Job | Who does it | Why |
|---|---|---|
| *"Trajeron 5 kilos de menudencia, 2 bolsas de arroz y una caja de verduras"* → structured items | **Gemini** | Messy natural language → structure. Exactly what it's for, and the same pattern as the card and the consult |
| *This stock yields N ladles, which feeds M dogs* | **Deterministic code** | Arithmetic |

An LLM doing the arithmetic is slower, costs money per calculation, and is
**non-deterministic on numbers** — the same stock could yield two different
answers on two days, and there would be no way to tell which was wrong. A shelter
deciding whether tonight's pot feeds every dog needs an answer that is
reproducible and auditable, not generated.

Keep the LLM at the input boundary. This also keeps the food module almost
entirely free, since parsing a donation is a handful of tokens.

### 12.2 The hard part is not the code, it is the conversion factor

Raw mass → cooked volume → ladles cannot be derived from first principles:

- Rice roughly **triples** in volume as it absorbs water; meat **shrinks** as it
  renders; water is added in an amount nobody measures.
- Bone-in donations carry mass that never becomes food.
- "Una bolsa de arroz" is not a unit. Neither is "una caja de verduras."

**So do not compute the yield — measure it.** The first N cook batches *are* the
calibration dataset: record what went into the pot and how many ladles actually
came out, and the prediction becomes a fit to this shelter's own history rather
than a food-science guess that will be wrong in a way nobody can debug.

Concretely: `cookBatches` records `inputs[]` **and** an observed
`ladlesYielded`. Until there are enough batches to fit, the UI shows *"aún
calibrando"* and no estimate at all — which is more useful than a confident wrong
number, and is the §6.2 failure-direction rule applied to a non-LLM path.

**Pot and ladle geometry go in `src/config/shelter.ts`**, the file a forking
shelter edits — the user is providing measurements later, and until then the
constants are explicitly `null`, not guessed defaults. A shelter with a different
pot must not inherit Wawitas' numbers silently.

### 12.3 Rations have a standard, and it is not "big dog = 4 spoons"

"Big dogs 4, small dogs 2" is a reasonable field heuristic and it is what the
staff will keep using. But there is a real international standard underneath it,
and recording both lets the heuristic be checked rather than merely followed:

**Resting Energy Requirement**, the veterinary standard referenced by WSAVA and
AAHA:

```
RER (kcal/day) = 70 × (weightKg ^ 0.75)
MER            = RER × factor      // neutered adult ~1.6, active ~2.0,
                                   // weight loss ~1.0, growth 2–3
```

Note `^0.75`: energy need scales **sub-linearly** with weight. A 40 kg dog needs
about 2.7× a 10 kg dog's calories, not 4×. A linear ladle rule therefore
systematically **underfeeds large dogs relative to small ones** — which is worth
knowing in a shelter where the large dogs are the ones that look thin.

The system should not overrule the staff. It should show, next to the recorded
ration, what the standard suggests — and let the divergence be visible.

**Body Condition Score (§2.7) is the feedback signal**, on the WSAVA 9-point
scale, not a `gordo | flaco` flag. Ration adjustment becomes: BCS ≥ 7 → reduce
and re-score in 4 weeks; BCS ≤ 3 → increase and check for parasites or disease
first, because a thin dog in a shelter is a clinical question before it is a
feeding one.

### 12.4 Two safety checks that belong at donation intake

**Toxic ingredients.** Donated vegetables genuinely arrive containing onion, and
*Allium* species — onion, garlic, leek, chives — cause haemolytic anaemia in
dogs, with cooking offering no protection. Also grapes and raisins, chocolate,
xylitol, macadamia, alcohol, and raw bread dough. The parser already reads the
donation description, so flagging these costs nothing extra and catches the case
where nobody looked in the box.

**Cooked bones.** Cooked bone splinters and can perforate the digestive tract —
a documented risk distinct from raw bone. A shelter boiling donated meat is
producing exactly this, so bone-in donations should be flagged as *"deshuesar
antes de servir"* at intake.

**Framing, deliberately:** the system **flags for the shelter's own judgement**.
It does not diagnose, does not refuse a donation, and does not tell anyone what
to feed. That is the shelter's and their vet's call, and a tool that nags gets
switched off.

**One thing worth stating plainly, once, and then leaving alone:** a soup of
donated scraps, rice and vegetables is unlikely to be a complete and balanced
canine diet — calcium in particular is easy to miss when meat arrives without
usable bone. This system will be recording the exact data that reveals it, which
is a genuine argument for building it. It is not an argument for the system to
give nutritional advice.

### 12.5 Data model

```
foodDonations/{donationId}        ADMIN
  donor, receivedAt, rawText, items[], flags[], recordedBy
  source: 'manual' | 'llm-parsed'
  confirmedBy                     ← same review gate as everything else

foodStock/{itemKey}               ADMIN   — current pantry, one doc per item type
  category: 'carne' | 'menudencia' | 'arroz' | 'verdura' | 'hueso' | 'otro'
  quantity, unit, updatedAt

cookBatches/{batchId}             ADMIN
  cookedAt, inputs[]              ← decrements foodStock
  potFillLevel
  ladlesYielded                   ← OBSERVED, not predicted. The calibration data
  dogsServed, cookedBy, notes

feedingLog/{YYYY-MM-DD}           ADMIN
  batchIds[], servings[{ petId, ladles, adjustedReason }]
  dogsPresent, shortfall
```

`feedingLog` keyed by date so a day is one document and one read.

**`FeedingPlan` needs reconciling, not extending.** The existing shape —
`portion`, `unit: 'gramos'|'tazas'|'latas'|'ml'`, `food: string`,
`foodKind: 'seco'|'humedo'|'mixto'|'casero'` — describes an **owned pet eating
from a bag**. It is the right model for an adopter and the wrong one for a
communal pot. The split:

- **`care/feeding`** stays, and becomes what travels **with the animal to its
  adopter** — the existing rationale in `types.ts` is exactly this, avoiding
  digestive upset from a sudden diet change.
- **`rationLadles`** is added as the shelter-side ration, with `unit` gaining
  `'cucharones'`.

Conflating them would mean handing an adopter a feeding plan measured in ladles
from a pot they do not have.

### 12.6 Where this sits

Food management is **largely independent of the adoption and identity core** —
it shares only `Pet` and the Gemini plumbing. It can be built in parallel or
deferred without blocking anything else, and it is the one module a different
shelter might want without wanting the rest.

It is also the module most likely to be used **every single day**, by staff who
are not the people entering pets. That argues for its own simple screen rather
than a tab inside the admin console, and for it working on a phone in a
courtyard.

---

## 13. Arrival pipeline and area tracking

**Added at the user's direction, 2026-08-16.** Today the manager announces an
incoming dog by WhatsApp message. Instead: the manager records the basic
information — usually a photo, sometimes a breed, sometimes a name — and staff
can see an animal is on its way. On arrival it goes to one of several quarantine
areas, is examined by a vet, and is then assigned to general population. Areas
are identified by name or number, and **the system must be able to isolate an
area if a virus breaks out.**

### 13.1 ⚠️ `transito` already means something else

`PetStatus` has `transito`, and in `types.ts` it means **"in a foster home
(hogar de tránsito)"** — the standard Bolivian Spanish term. Naming the new
en-route state "en tránsito" would collide with it head-on, in the one language
the staff actually use, and the two states are opposites: a fostered dog has a
home, an incoming dog has nowhere yet.

Use **`en-camino`**. Unambiguous in Spanish, and it cannot be confused with
`hogar de tránsito` by anyone.

New status values:

| Value | Meaning |
|---|---|
| `en-camino` | Announced, not yet physically here |
| `cuarentena` | Arrived, in a quarantine area, not yet cleared by a vet |
| `cancelado` | Announced but never arrived — the rescue fell through |

`refugio` keeps its current meaning: at the shelter, in general population.

**The wall is unaffected.** `getWall()` filters `status == 'adopcion'`, so every
new value is excluded automatically. No query anywhere needs changing — which is
the payoff for the wall having been written as an allowlist rather than a
denylist.

`cancelado` is worth having rather than deleting the record. Announced rescues
that never materialise are common, and "we were told about this dog and then
nothing" is information — particularly if the same source does it repeatedly.

### 13.2 Do not replace the WhatsApp message. Wrap it.

This is the part most likely to fail in practice, so it deserves stating
plainly.

WhatsApp works for this shelter because **everyone already has it and it
pushes.** An in-app-only notification will be missed, staff will go back to the
group chat, and the system will hold empty records while the real information
lives in a chat thread — which is exactly today's problem with extra steps.

**So the record moves to the app; the ping stays on WhatsApp.** The manager
enters the animal, and the app produces a pre-filled `wa.me` link — *"🐕 Nuevo
ingreso en camino: Luna, mestiza. Ficha: wawitas.org/id/xxxx"* — which they send
to the staff group as they do now. Zero new infrastructure, zero cost, no
notification permissions, and the group message now **points at a record instead
of being the record.**

This is the same mechanism the whole public site already converts through, so it
is a pattern the project has rather than a new dependency.

Web push via the PWA is the phase-2 upgrade if staff want it. It is free, but it
needs installation and per-device permission, and it should be *added alongside*
the WhatsApp link rather than replacing it.

### 13.3 The pre-arrival form is a capacity check, not just an announcement

The manager announcing a dog needs to know one thing immediately: **is there
room in quarantine?** So the form shows live occupancy per quarantine area
beside the fields.

It also shows, per quarantine area, **the date of the most recent arrival** —
because adding a new animal to an occupied quarantine pen restarts the
observation clock for everyone already in it. Cohorting matters, and this is the
one derived number that makes it visible at the moment the decision is made.

Fields, all optional except species:

```
foto (usually)   ·   nombre (sometimes)   ·   raza (sometimes)
sexo · tamaño estimado · de dónde viene · quién avisa · cuándo llega
```

**Everything nullable is the point.** The existing intake wizard (§3) assumes
the animal is in front of you. This is earlier than that, and a form that
demands a name for a dog nobody has met yet will be filled with `"?"`.

**This creates a real `pets` document, not a `petDraft`.** The draft/pet boundary
is *"has an admin deliberately declared this animal exists?"* — and an
announcement to the whole staff group is exactly that declaration. Drafts stay
what they are: private, half-finished wizard state.

### 13.4 The state machine

```
   en-camino ──── llegó ────▶ cuarentena ──── alta veterinaria ────▶ refugio
       │                          │                                    │
       │                          ├── traslado ──▶ otra área           │
       └── no llegó ──▶ cancelado └── enfermo ───▶ aislamiento         │
                                                                       ▼
                                                                   adopcion
```

Arrival is an explicit action, not a timer, and it writes three things at once in
one batch: the status change, the first `placement`, and a `ScanEvent` with
`context: 'intake'` if the animal is chipped and scanned on the way in.

Veterinary clearance out of quarantine is likewise explicit and attributed —
`clearedBy`, a real user. "Nobody remembers who moved it" is how an outbreak
investigation stalls.

### 13.5 Areas

```
areas/{areaId}                          ADMIN read + write
  name         "Cuarentena 2" · "Patio A" · "3"   — names OR numbers, free text
  kind         cuarentena | aislamiento | general | medica | maternidad
  capacity     number | null
  active       boolean
  notes
```

**`cuarentena` and `aislamiento` are different kinds and must not be merged.**
This is the [ASV Guidelines](https://www.aspcapro.org/topics-shelter-medicine/asv-guidelines-standards-care-animal-shelters)
distinction: *quarantine* holds healthy, newly admitted or exposed animals under
observation; *isolation* holds animals showing or suspected of infectious
disease. Putting a sick animal into a quarantine pen exposes every healthy animal
in it. If the model conflates them, the UI cannot warn about it.

`capacity` exists because the ASV guidelines are explicit that **crowding is
itself a disease risk** — higher contact rate, worse air quality, more stress. An
occupancy figure the manager sees before saying yes to another dog is the cheapest
possible intervention.

### 13.6 Placements are an interval ledger, and this is the whole design

```
pets/{petId}/placements/{placementId}   AUTHENTICATED read, admin write
  areaId
  areaName      snapshot at the time — areas get renamed, history must not shift
  startedAt
  endedAt       null = currently here
  reason        ingreso | fin-cuarentena | traslado | medico | brote | salida
  movedBy, note
```

**A `currentArea` field would not satisfy the requirement.** The user's stated
reason for tracking area is *"in case of a virus break, to isolate the area"* —
and that question is always asked **retrospectively**. A dog diagnosed today was
infectious before it looked sick. What is needed is not where it is, but
**everywhere it has been, and who was there at the same time.**

The retention window is set by the pathogens, and it is longer than intuition
suggests:

| Disease | Incubation | Implied lookback |
|---|---|---|
| **Canine parvovirus** | 3–4 days typical, **up to 14** | ≥2 weeks |
| **Canine distemper** | 10–14 days typical, **up to 6 weeks** | **≥6 weeks** |

So placement history must reach back **at least six weeks** to be useful for
distemper, which is the case that actually closes shelters. In practice: keep it
indefinitely. At ~40 animals this collection is trivially small, and unlike the
scan ledger (`CLAUDE.md` concern #3) it is **not surveillance of a person** — it
records which pen an animal was in, inside one facility. The retention argument
that applies to `scans` does not apply here.

**A foster home is not an area.** Placements describe positions inside the
shelter's own facility. A dog in `hogar de tránsito` has `custody` and possibly
`location`, and no open placement. Keeping that boundary clean is what stops a
volunteer's home address from ever ending up in an operational area list.

### 13.7 The outbreak query

Given a sick animal, the contact trace is two steps:

1. Read that animal's placements overlapping the exposure window.
2. For each `(areaId, interval)`, find every other placement in the same area
   whose interval overlaps.

```
collectionGroup('placements')
  .where('areaId', '==', areaId)
  .where('startedAt', '<=', windowEnd)
// then filter endedAt >= windowStart in memory
```

Interval overlap is awkward in Firestore because of range-filter constraints, and
the honest answer at this scale is **don't fight it**: forty animals over six
weeks is a few hundred documents. Fetch by area and filter in memory. Optimise
if a shelter with 400 animals ever forks this — not now.

Needs a collection-group index on `placements(areaId, startedAt)`. Note
`CLAUDE.md`'s standing warning here: the microchip lookup broke because a
collection-group index was declared but never deployed, and the symptom was
indistinguishable from "no data." **An outbreak trace that silently returns
nothing is the worst possible version of that bug** — so this query needs a test
with known data, not just a green deploy.

**Current occupancy** uses the same index shape:
`where('areaId','==',X).where('endedAt','==',null)`.

**Deliberately not denormalised onto `Pet`.** A `currentAreaId` field would make
the board view a single query, but `pets/{petId}` is **public read** — and where
an animal is housed is operational data with no reason to be world-readable. The
collection-group query is admin-side and costs nothing at this scale.

### 13.8 What this earns beyond the outbreak case

Three things fall out of the same ledger, free:

- **Length of stay per animal**, which is the single most-used shelter metric and
  currently uncomputable.
- **Whether the quarantine period is actually being observed**, rather than
  assumed — the ASV guidance is only worth anything if someone can check it.
- **Which areas cycle fastest**, which is a capacity-planning input the shelter
  has never had.

None of these need building now. They are queries against data this feature
records anyway, which is the argument for recording intervals rather than a
current-state field.

---

## 14. What this plan does not do

- **No social syndication at all, in either direction.** Outbound is deferred
  (§5). Inbound — `PLAN.md` §5's plan to pull posts *from* Facebook — remains
  unbuilt and is now largely redundant: if the database is the source and posts
  are generated from it, there is nothing to parse back.
- **No Vertex AI.** Decided 2026-08-16. The Gemini API via AI Studio, with a key
  in Secret Manager. See §4 and [`gemini-api-playbook.md`](gemini-api-playbook.md).
- **No grounded search, ever, on any path.** Not a deferral — a standing
  constraint. It is the playbook's dominant cost SKU and nothing in this product
  needs the web.
- **No embeddings, no corpus, no Batch API.** Playbook §7 and §8 do not apply.
  Nothing here is retrieval; if that changes, re-read them before writing a line.
- **No LLM arithmetic.** The food yield is deterministic code (§12.1), and the
  system never computes a drug dose into a record (§4.7). Both are deliberate
  refusals, not gaps.
- **No nutritional or veterinary advice.** The food module flags known-toxic
  ingredients and shows what the RER standard suggests beside what the staff
  actually recorded. It does not prescribe, and it does not overrule anyone.
- **No BigQuery.** `CLAUDE.md` decided 2026-08-09 to add it when a named report
  justifies it. Nothing here is that report.
- **No terminology coding.** §4 of the research doc — the socket, not the plug.
- **No EU passport issuance.** We are not an issuing authority. We model the
  fields so a vet can fill one in; we do not print one.
