# Plan — pet intake, medical records, adoption, and social syndication

Covers: the admin intake flow, Gemini-assisted vaccination-card parsing, the
adopter-facing flow, QR identity tags, and LLM-generated cross-posting to social
media.

Standards research this depends on:
[`veterinary-records-standards.md`](veterinary-records-standards.md) ·
[`rfid-microchips.md`](rfid-microchips.md)

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

### 2.7 `socialPosts/{postId}` — ⏸ deferred, not built

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

### 4.7 The review gate is not optional

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
> Nothing in §9's build order depends on this section. `socialPosts` (§2.7) is
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
| New composite indexes | `firestore.indexes.json` | `adoptionApplications(petId, status)`, `media(tier, order)` |
| Rules for 4 new collections | `firestore.rules` | `petDrafts`, `adoptionApplications`, `qrTokens`, `api_usage_daily`. Still deployed by hand, deliberately |

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
| 6 | **Re-admission / dedup path** | §3.1 — cheap now, expensive once duplicates exist |
| 7 | `MedicalRecord` extensions + manual medical entry | §2.1, §4.4 |
| 8 | **AI foundations**: provider, `model-ids`, `pricing.mjs`, `recordAiUsage` | §4.1 — before the first call |
| 9 | Card extraction + review gate | §4.3, §4.7 |
| 10 | QR tokens + `/id/{token}` + print sheet | §7 |
| 11 | Adoption applications + admin queue | §6 — **first real test of the rules** |
| — | ⏸ *Social syndication* | **Deferred** — §5 |

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
6. *(Deferred with §5)* **Is the Facebook target a Page or a personal profile?**
   Not blocking anything now, but it is a one-minute check and the answer
   reshapes the eventual social plan. Worth doing opportunistically.

---

## 12. What this plan does not do

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
- **No BigQuery.** `CLAUDE.md` decided 2026-08-09 to add it when a named report
  justifies it. Nothing here is that report.
- **No terminology coding.** §4 of the research doc — the socket, not the plug.
- **No EU passport issuance.** We are not an issuing authority. We model the
  fields so a vet can fill one in; we do not print one.
