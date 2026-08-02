# dog-shelter — wawitas.org

Adoption and rescue platform for **Wawitas Red de Apoyo**, a transitional dog shelter in Cochabamba, Bolivia.

- Repo: https://github.com/camclarke/dog-shelter
- Domain (target): `wawitas.org`
- Facebook: `profile.php?id=61563998952145` · Instagram: `@wawitas_2025` · WhatsApp: `77903553`
- Language: **Spanish** (site copy). English only in code, comments, and docs.

**Primary objective:** get a stranger from "scrolling" to "messaging Wawitas about a specific dog."
Everything else is secondary and must not compete with it.

---

## Status

| Area | State |
|---|---|
| Brand + design system | ✅ Defined — [`design/estilo.html`](design/estilo.html) |
| Product plan | ✅ Written — [`PLAN.md`](PLAN.md) |
| GitHub repo | ✅ Created (public, `camclarke/dog-shelter`) |
| GCP project | ⛔ **Blocked** — see [Setup](#setup-required-from-you) |
| Firebase init | ⬜ Not started |
| Data model + rules | 🟡 Designed below, not implemented |
| Frontend scaffold | ⬜ Not started |
| Cloud Functions | ⬜ Not started |
| Maps integration | ⬜ Not started |
| LLM vaccination-card parsing | ⬜ Stage 2 — deliberately deferred |

### Progress log

- **2026-08-02** — Read the Facebook page; catalogued the five recurring content types (adoption, lost pet, adoption fair, education, rescue appeal). Wrote `PLAN.md`.
- **2026-08-02** — Sampled the real brand from their Facebook cover and logo. Jade is `#31907A` in both. Rebuilt the heart-paw mark as SVG. Adopted their own tagline, *"De la calle, a tu corazón"*, as the homepage headline. Style system in `design/estilo.html`.
- **2026-08-02** — Architecture pivoted to GCP serverless + Firestore + Firebase Auth. Repo created. Data model and security model designed (below).

---

## Architecture

**Constraint: lowest possible cost, no VMs, serverless only.** Every decision below is downstream of that.

| Concern | Service | Free tier | Notes |
|---|---|---|---|
| Static hosting + CDN | Firebase Hosting | 10 GB stored, 360 MB/day transfer | No SSR — SSR means compute means cost |
| Auth | Firebase Authentication | 50k MAU | Email/password + Google provider |
| Database | Firestore (Native) | 1 GiB, 50k reads / 20k writes per day | |
| Images | Cloud Storage for Firebase | 5 GB | ~1000 dogs at 300 KB optimized |
| Privileged logic | Cloud Functions 2nd gen (on Cloud Run) | 2M invocations/mo | Only where Rules can't reach |
| Maps | Maps JavaScript API | 10k loads/mo per SKU | The first thing that will cost money |

**Expected steady-state bill: $0/month.** A budget alert at $5 goes up before anything else.

### The cost principle that shapes everything

**Read Firestore directly from the client. Let Security Rules do authorization.**

Rules evaluation is free. Routing reads through a Cloud Function costs an invocation plus CPU-seconds *per read* — the same data served two ways, one free and one metered. Functions are therefore reserved for what Rules genuinely cannot do:

- admin mutations that need server-side validation
- vaccination-card parsing (Stage 2, LLM)
- image derivative generation on upload
- moderation and rate-limit enforcement on public sighting reports

**Corollary:** admin status lives in a **custom auth claim** (`request.auth.token.admin`), not in a `users/{uid}.role` field. A claim is already inside the token and costs nothing to check; a Firestore field costs one document read *on every rule evaluation*.

### Frontend

**Astro, static output, plus the modular Firebase Web SDK.** Static shell served free from CDN; dog data hydrates client-side from Firestore. No server rendering, so no compute cost.

This is the right call *because* the content is auth-gated — gated pages can't be indexed anyway, so we give up nothing by rendering them on the client. See [Open decision #1](#1-how-much-is-public) — if we expose public teasers, those specific pages get statically generated at build time for SEO.

---

## Data model

Firestore Rules are **document-level**, not field-level. Visibility tiers therefore become *separate documents*, not fields on one document. This single decision satisfies both the login-gating requirement and the location-privacy requirement.

```
dogs/{dogId}                          PUBLIC READ
  slug, name, formerNames[]           current name + every previous name
  breed, ageMonths, birthdateApprox
  sex, size
  status        refugio | transito | adopcion | adoptado | perdido
  coverPhoto                          single optimized image
  createdAt, updatedAt

dogs/{dogId}/detail/main              AUTHENTICATED READ
  story, temperament, healthNotes
  photos[]
  commitments                         castration, follow-up
  microchip
  vaccinations[]                      ← Stage 2: LLM-extracted from card scan

dogs/{dogId}/location/current         RESTRICTED READ (admin | current owner)
  geo: GeoPoint
  precision: exact | approx
  address                             never leaves this document
  updatedAt

dogs/{dogId}/sightings/{sightingId}   PUBLIC READ, PUBLIC CREATE
  geo: GeoPoint                       where the dog was seen, not where it lives
  note, photoUrl, contact?
  reportedAt
  status        pending | confirmed | rejected

users/{uid}                           SELF READ
  displayName, email, photoURL
  createdAt
  (admin is a custom claim, NOT a field here)

adoptions/{adoptionId}                RESTRICTED
  dogId, ownerUid, adoptedAt, approvedBy
```

### Security rules — intent

| Path | read | write |
|---|---|---|
| `dogs/{id}` | anyone | admin |
| `dogs/{id}/detail/main` | signed in | admin |
| `dogs/{id}/location/current` | admin, or `uid == adoption.ownerUid` | admin |
| `dogs/{id}/sightings/{sid}` | anyone | **create:** anyone (validated + App Check) · **update/delete:** admin |
| `users/{uid}` | self, admin | self (restricted fields), admin |
| `adoptions/{id}` | admin, or the owner | admin |

**Public write is the sharp edge.** `sightings` accepts writes from unauthenticated visitors by design — that's the point of the lost-dog feature. It needs, without exception:

- **Firebase App Check** (reCAPTCHA Enterprise, 10k free assessments/mo) so only our own site can write
- schema validation in Rules — field whitelist, string length caps, GeoPoint bounds clamped to the Cochabamba region
- `status: pending` forced on create; only an admin can promote to `confirmed`
- a Cloud Function that rate-limits by IP hash and flags bursts

Without all four, this collection is an open spam endpoint.

---

## Concerns worth a decision

### 1. How much is public?

The requirement is that users log in to see dog information and pictures. That conflicts directly with the stated primary objective: **content behind a login cannot be found by someone searching "adoptar perro Cochabamba," and every signup step loses potential adopters.**

Proposed middle ground, already reflected in the data model above:

- **Public** — photo, name, age, breed, size, status. Indexable, shareable, enough to fall in love.
- **Signed in** — full story, health notes, the whole photo set, contact route, location.

This preserves discovery while keeping the substance gated. Implemented as `dogs/{id}` vs `dogs/{id}/detail/main`, so switching to fully-gated later is a one-line rules change, not a rewrite.

**Default assumed:** the split above. Say the word and I'll gate everything instead.

### 2. Publishing dog locations means publishing people's home addresses

This one matters and it needs to be said plainly.

- A dog in `transito` lives in a **foster volunteer's home**. Publishing that location publicly publishes a volunteer's home address.
- An `adoptado` dog lives in the **adopter's home**. Even restricted to owner and admins, we are storing residential addresses of private individuals — which carries real obligations, and real consequences if the database leaks.

What I'll build unless told otherwise:

- Exact coordinates **only** in `dogs/{id}/location/current`, never in a public document
- Public maps for available dogs show the **shelter or a meeting point**, never a foster home
- Adopted-dog location defaults to `precision: approx` — coarse area, not a pin on a house — with exact opt-in requiring the owner's explicit consent
- **Sightings are exempt.** A street sighting of a lost dog is a public event in a public place. That feature works exactly as described.

The tracking capability you asked for is fully intact. The difference is the *default precision* and who can widen it.

### 3. Maps is the only line item likely to cost money

10k map loads/month free, then $7 per 1000. Guardrails: lazy-load the map only when a user opens a location view, never on the wall or homepage; use a static map image for previews; cache tiles.

---

## Setup required from you

**1. Re-authenticate gcloud.** Its tokens are expired and refresh needs an interactive prompt I can't answer:

```bash
gcloud auth login
```

**2. Confirm which GCP project.** The active one is `trustcert-ai-g` (work). The shelter needs its own — new project, own budget alert, own billing isolation. I'll create it once you can confirm a billing account is available to link (Firestore and Functions need Blaze, though real usage should stay inside the free tier).

**3. Later, not now:** DNS for `wawitas.org`, the Maps API key with HTTP referrer restrictions, and the Google OAuth consent screen.

---

## Conventions

- **Spanish** for anything a visitor reads; **English** for code, comments, commits, and docs.
- Firestore: collection names plural and English; document *field* values may be Spanish enums (`refugio`, `transito`) since they mirror the shelter's own vocabulary.
- No secrets in the repo. Firebase Web config is public by design; anything else goes in Secret Manager.
- Commit messages: imperative mood, no attribution trailers.
- Every new visibility tier is a **new document**, never a new field. Rules cannot protect a field.
