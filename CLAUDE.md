# pet-shelter

Open-source adoption and rescue platform for animal shelters — dogs, cats, rabbits.
Reference deployment: **Wawitas Red de Apoyo**, a transitional shelter in Cochabamba, Bolivia.

- Repo: https://github.com/camclarke/pet-shelter
- Domain (target): `wawitas.org`
- Facebook: `profile.php?id=61563998952145` · Instagram: `@wawitas_2025` · WhatsApp: `77903553`
- Language: **Spanish** (site copy). English only in code, comments, and docs.

**Primary objective:** get a stranger from "scrolling" to "messaging the shelter about a specific animal."
Everything else is secondary and must not compete with it.

**Secondary objective, added 2026-08-07:** be the identity record for the animals a
shelter handles — microchip, medical history, feeding, and chain of custody — so a
scanned chip resolves to a name and a phone call.

---

## Status

| Area | State |
|---|---|
| Brand + design system | ✅ Defined — [`design/estilo.html`](design/estilo.html) |
| Product plan | ✅ Written — [`PLAN.md`](PLAN.md) |
| GitHub repo | ✅ Created (public, `camclarke/pet-shelter`) |
| Data model + security rules | ✅ Written — `src/lib/types.ts`, `firestore.rules`, `storage.rules` |
| **Frontend** | ✅ **Next.js — builds clean, 0 vulnerabilities.** See below |
| Muro de Adopción | ✅ Server-rendered — `src/components/Muro.tsx`, fetched via `pets-server.ts` |
| Pet identity (RFID microchip) | ✅ Modelled + validated, 10/10 unit tests — `src/lib/microchip.ts` |
| Medical history + feeding | ✅ Modelled — not yet surfaced in any UI |
| Template config for other shelters | ✅ `src/config/shelter.ts`, `README.md`, MIT licensed |
| Dockerfile + Cloud Run target | ✅ Written, unverified — no image has been built or deployed yet |
| Terraform | ✅ Written, validated (`plan` clean) — not yet applied to a real project |
| GCP project | ⛔ Blocked — gcloud re-auth needed |
| Firebase init (Auth/Firestore/Storage) | ⬜ Not started — no live project to init against |
| Auth flows | ⬜ Not started |
| Admin publishing UI | ⬜ Not started |
| Maps + sightings | ⬜ Not started |
| LLM vaccination-card parsing | ⬜ Stage 2 — deliberately deferred |

### Progress log

- **2026-08-02** — Read the Facebook page; catalogued the five recurring content types (adoption, lost pet, adoption fair, education, rescue appeal). Wrote `PLAN.md`.
- **2026-08-02** — Sampled the real brand from their Facebook cover and logo. Jade is `#31907A` in both. Rebuilt the heart-paw mark as SVG. Adopted their own tagline, *"De la calle, a tu corazón"*, as the homepage headline. Style system in `design/estilo.html`.
- **2026-08-02** — Architecture pivoted to GCP serverless + Firestore + Firebase Auth. Repo created. Data model and security model designed (below).
- **2026-08-02** — Wrote the data model (`src/lib/types.ts`), security rules for Firestore and Storage, composite indexes, `firebase.json`, design tokens, base layout, and the Muro de Adopción — originally on **Astro**, static output. Hit a hard Node blocker: Astro ≤7.0.9 carries eight high-severity advisories, and the only patched line (≥7.1.6) requires Node ≥22.12.0 while the machine had 20.20.2.
- **2026-08-02** — **Pivoted to Next.js**, at the user's direction, for scalability and to standardize on Terraform for IaC. This turned out to also resolve the Node blocker: Next 16 only requires Node ≥20.9.0. Rebuilt the frontend as Next.js App Router with `output: 'standalone'` for Cloud Run. The wall and dog pages moved from a client-side Firestore fetch to **Server Components reading via the Admin SDK** (`dogs-server.ts`) — this is a genuine improvement, not just a port: the public teaser is now real HTML in the first response, closing an SEO gap the static-Astro version had (client-fetched data is invisible to a first-pass crawl). `npm run build` was run and succeeds; `npm audit` was run and forced three transitive advisories (`sharp`, `postcss`, `uuid`, all pulled in by Next/firebase-admin's own dependency trees) to patched versions via `overrides` — 0 vulnerabilities. This is the first framework in this project to actually compile.
- **2026-08-02** — Pinned `firebase-admin` to `^13.10.0` rather than the latest `14.x`, which requires Node ≥22 — the dev machine is on 20.20.2 and Next.js itself doesn't need the upgrade, so there was no reason to force it. The Cloud Run image builds on Node 22 regardless (see `Dockerfile`), so this only affects local development.
- **2026-08-07** — **Renamed `dog-shelter` → `pet-shelter`** and generalized the model so the project works for any species and can be forked by other shelters. `Dog` → `Pet` with a `species` dimension; Spanish gender agreement is now computed (`sizeLabel`, `speciesNoun`) rather than hardcoded masculine, because "la gata pequeña" vs "el gato pequeño" reads as carelessness to the entire target audience otherwise. All organisation-specific content moved to `src/config/shelter.ts` — the one file a forking shelter edits. Added `README.md`, MIT `LICENSE`.
- **2026-08-07** — **Added RFID microchip identity, scan ledger, medical history, and feeding plans.** Researched the international regulatory picture first (`docs/rfid-microchips.md`) because it constrains the schema. Three findings changed the design: (1) a microchip is a *passive* transponder with no GPS and centimetre read range — AVMA states it "cannot track your animal" — so the ledger records the **scanner's** location at scan time and is named `ScanEvent`, never `currentLocation`, to make live tracking impossible to misread into the schema; (2) the code must be stored as a **string** because ISO 3166 country prefixes below 100 have leading zeros (Bolivia is `068`) and integer parsing silently corrupts every such chip; (3) EU 576/2013 requires the chip be implanted **before** the rabies vaccination or the vaccination is void, which is a validatable business rule (`rabiesVaccinationIsValid`). The microchip number sits in the **restricted** tier, not the authenticated one — it is the credential by which ownership is asserted, and an account is not a reason to learn every chipped animal's number. Scan history is restricted for a stronger reason: one location is an address, a scan trail is a pattern of an owner's movements. 10 unit tests cover the validation boundaries, including the exact 38-bit national-ID ceiling.
- **2026-08-02** — Wrote `terraform/`: enabled APIs, Firestore database (with both `deletion_policy` and `delete_protection_state` set — redundant on purpose), a Storage bucket linked to Firebase, Artifact Registry with a cleanup policy, a Cloud Run v2 service with its own least-privilege service account (not the Compute Engine default), and a budget alert with email notification at 50/90/100%. `project_id`, `region`, and `billing_account` are variables; the GCS backend is configured via `-backend-config` rather than hardcoded, so moving to the new tenant is a new `backend.hcl` and re-init, not an edit to any `.tf` file. Validated with `terraform validate` and a full `terraform plan` against a placeholder project — both clean, 24 resources, 0 errors — rather than just written and assumed correct.

---

## Architecture

**Constraint: lowest possible cost, no VMs, serverless only.** Every decision below is downstream of that.

| Concern | Service | Free tier | Notes |
|---|---|---|---|
| App server (Next.js SSR) | Cloud Run 2nd gen | 2M requests/mo, scales to zero | No VMs; see [Frontend](#frontend) for why Next over static export |
| CDN + custom domain | Firebase Hosting, rewriting to Cloud Run | 10 GB stored, 360 MB/day transfer | Gives the custom domain and edge caching without a load balancer |
| Auth | Firebase Authentication | 50k MAU | Email/password + Google provider |
| Database | Firestore (Native) | 1 GiB, 50k reads / 20k writes per day | |
| Images | Cloud Storage for Firebase | 5 GB | ~1000 pets at 300 KB optimized |
| Privileged logic | Cloud Functions 2nd gen (on Cloud Run) | 2M invocations/mo | Only where Rules can't reach |
| Maps | Maps JavaScript API | 10k loads/mo per SKU | The first thing that will cost money |
| Infrastructure as code | Terraform | — | See [Terraform](#terraform) |

**Expected steady-state bill: $0/month.** Cloud Run's request volume here is nowhere
near its free tier, and it scales to zero between visits — an idle shelter site pays
nothing for compute. A budget alert at $5 goes up before anything else.

### The cost principle that shapes everything

**Read Firestore directly from the client. Let Security Rules do authorization.**

Rules evaluation is free. Routing reads through a Cloud Function costs an invocation plus CPU-seconds *per read* — the same data served two ways, one free and one metered. Functions are therefore reserved for what Rules genuinely cannot do:

- admin mutations that need server-side validation
- vaccination-card parsing (Stage 2, LLM)
- image derivative generation on upload
- moderation and rate-limit enforcement on public sighting reports

**Corollary:** admin status lives in a **custom auth claim** (`request.auth.token.admin`), not in a `users/{uid}.role` field. A claim is already inside the token and costs nothing to check; a Firestore field costs one document read *on every rule evaluation*.

### Frontend

**Next.js (App Router), deployed as SSR on Cloud Run 2nd gen.** This was originally
Astro with static output — no VM, no server, no compute cost. The project moved
to Next.js on the user's direction, for scalability and to standardize on
Terraform. That trade is worth being explicit about:

- **What Next buys here:** a framework most contributors already know, real
  SSR/ISR instead of a client-side Firestore fetch, and a natural home for the
  admin console if it grows into a stateful React app. `output: 'standalone'`
  keeps the Cloud Run image small (~37 MB before node_modules pruning), and
  Cloud Run's scale-to-zero means an idle shelter site still pays nothing for
  compute — the constraint that mattered with Astro still holds.
- **What it costs:** a request that hits a cold Cloud Run instance pays a
  cold-start penalty that static-from-CDN never had. Cloud Run's minimum
  instance count stays at 0 for cost; if cold starts become a real problem,
  the fix is `min_instance_count = 1` in Terraform, which costs a small
  always-on fee — a deliberate tradeoff to make later, not now.
- **The SEO gap this closes:** the Astro version rendered the public teaser
  client-side, so a first-pass crawler saw an empty wall — the client fetch ran
  after the crawl, not before it. `pets-server.ts` uses the Admin SDK inside
  Server Components, so the wall and each dog's page are real HTML in the
  first response. This was a genuine defect in the Astro version, not
  something Next added — it's fixed regardless of which framework we'd kept.

Firebase Hosting still fronts the app (see `firebase.json`'s `rewrites`), so the
custom domain and CDN caching of static assets are unchanged from the original
plan — only what sits behind the rewrite changed, from static files to a Cloud
Run service.

Gating is unaffected by any of this: see [Open decision #1](#1-how-much-is-public).

---

## Data model

Firestore Rules are **document-level**, not field-level. Visibility tiers therefore become *separate documents*, not fields on one document. This single decision satisfies the login gating, the location privacy, and the microchip confidentiality requirements with one mechanism.

```
pets/{petId}                          PUBLIC READ
  slug, species, name, formerNames[]  current name + every previous name
  breed, ageMonths, birthdateApprox
  sex, size
  status        refugio | transito | adopcion | adoptado | perdido
  hasMicrochip  boolean ONLY — never the number
  coverPhoto
  createdAt, updatedAt

pets/{petId}/detail/main              AUTHENTICATED READ
  story, temperament, healthNotes, photos[]
  commitments, sterilized
  goodWithChildren, goodWithOtherPets

pets/{petId}/identity/microchip       RESTRICTED READ (admin | current owner)
  code          ALWAYS a string — leading zeros are significant
  standard      iso-fdx-b | iso-hdx | non-iso-125 | non-iso-128
  prefix, nationalId
  implantedAt, implantedBy, implantSite
  externalRegistry, externalRegistryId

pets/{petId}/location/current         RESTRICTED READ (admin | current owner)
  geo, precision, address
  publicMeetingPoint                  safe to show; the exact one never is

pets/{petId}/scans/{scanId}           RESTRICTED READ (admin | current owner)
  geo           location OF THE READER, not of the pet afterward
  precision, scannedByOrg, scannedByUid
  context       intake | veterinary | transfer | adoption | found | routine
  codeRead      recorded per-scan so a chip mismatch is visible
  scannedAt

pets/{petId}/custody/{custodyId}      RESTRICTED READ (admin | current owner)
  kind, holder, holderUid, startedAt, endedAt

pets/{petId}/medical/{recordId}       AUTHENTICATED READ
  kind          vacuna | desparasitacion | cirugia | consulta | ...
  name, performedAt, nextDueAt
  veterinarian, clinic, batch
  source        manual | llm-extracted   ← Stage 2 provenance
  confirmedBy, sourceDocument

pets/{petId}/care/feeding             AUTHENTICATED READ
  portion, unit, timesPerDay
  food, foodKind, restrictions[]

pets/{petId}/sightings/{sightingId}   PUBLIC READ, PUBLIC CREATE
  geo           where the pet was SEEN, not where it lives
  note, photoUrl, contact?, reportedAt
  status        pending | confirmed | rejected

users/{uid}                           SELF READ
  (admin is a custom claim, NOT a field here)

adoptions/{petId}                     RESTRICTED — keyed by petId so
  petId, ownerUid, adoptedAt          ownsPet() resolves in one get()
```

### The RFID microchip — what it is and is not

Full research and citations: [`docs/rfid-microchips.md`](docs/rfid-microchips.md).

**A microchip is a passive transponder. No battery, no GPS, a few centimetres of
read range.** The AVMA is explicit that it "cannot track your animal." So the
scan ledger records **where a scanner was when it read the chip** — a recovery
tool, not a prevention tool. `ScanEvent` is named for the event, deliberately,
so nobody later reads `currentLocation` into a schema that cannot support it.

Three constraints this puts on the code:

- **The code is a string, always.** ISO 3166 numeric country prefixes below 100
  carry a leading zero — Bolivia is `068`. Integer parsing silently corrupts
  every chip registered under a low country code. There is a regression test.
- **`999` prefixes are rejected.** ICAR reserves them for scanner-calibration
  transponders; one entered during training would collide globally.
- **EU 576/2013 ordering.** The chip must be implanted *before* the rabies
  vaccination or the vaccination is void — `rabiesVaccinationIsValid()` catches
  this at data entry rather than at a border.

### Security rules — intent

| Path | read | write |
|---|---|---|
| `pets/{id}` | anyone | admin |
| `pets/{id}/detail/main` | signed in | admin |
| `pets/{id}/identity/microchip` | **admin, or the owner** | admin |
| `pets/{id}/location/current` | admin, or the owner | admin |
| `pets/{id}/scans/{sid}` | admin, or the owner | admin |
| `pets/{id}/custody/{cid}` | admin, or the owner | admin |
| `pets/{id}/medical/{rid}` | signed in | admin |
| `pets/{id}/care/feeding` | signed in | admin |
| `pets/{id}/sightings/{sid}` | anyone | **create:** anyone (validated + App Check) · **update/delete:** admin |
| `users/{uid}` | self, admin | self (restricted fields), admin |
| `adoptions/{petId}` | admin, or the owner | admin |

**Why the microchip number is restricted rather than merely gated.** It is the
credential by which ownership gets asserted to registries and vets. Anyone who
can read it can claim the animal is theirs. Creating an account is not a reason
to learn every chipped animal's number. Lookup in the *other* direction — "I
scanned a chip, whose pet is this?" — runs server-side via
`findPetByMicrochip()` and returns only the public record, so a finder gets a
name and a way to make contact without being able to enumerate the registry.

**Why the scan ledger is restricted too.** A single location is one address. A
scan history is a pattern of movement over time — for an adopted pet, a trail of
its owner's vet, neighbourhood, and routine.

**Public write is the sharp edge.** `sightings` accepts writes from unauthenticated visitors by design — that's the point of the lost-pet feature. It needs, without exception:

- **Firebase App Check** (reCAPTCHA Enterprise, 10k free assessments/mo) so only our own site can write
- schema validation in Rules — field whitelist, string length caps, GeoPoint bounds clamped to the service area
- `status: pending` forced on create; only an admin can promote to `confirmed`
- a Cloud Function that rate-limits by IP hash and flags bursts

Without all four, this collection is an open spam endpoint.

---

## Terraform

**Written and validated** in `terraform/` — `terraform validate` and a full
`terraform plan` both run clean (24 resources, 0 errors) against a placeholder
project. Not yet applied to a real project; that's still blocked on gcloud
re-auth and a live GCP project existing. Parameterized for a tenant move from
day one, per the user's plan to move this project to a new GCP tenant once
it's complete, rather than retrofitting that later.

Division of responsibility, decided in advance so it doesn't drift later:

- **Terraform owns infrastructure:** enabled APIs, the Firestore database
  instance, the Storage bucket (linked to Firebase via `google_firebase_storage_bucket`),
  Artifact Registry, the Cloud Run service and its runtime service account,
  and the budget alert.
- **Firebase CLI still owns app-layer config:** `firestore.rules`,
  `storage.rules`, `firestore.indexes.json`, and Auth provider setup. Terraform's
  Firestore-rules support is too thin to be a reliable source of truth for
  something this security-critical — better to keep one tool that's good at it
  than force a second tool to be adequate at it.

Portability plan: `project_id`, `region`, and `billing_account` are Terraform
variables, not literals, with a `terraform.tfvars.example` for each environment.
Remote state uses a GCS backend configured via `-backend-config` flags at
`terraform init` rather than a hardcoded backend block, so the state bucket
itself can differ per tenant without editing `.tf` files. Moving tenants later
should be: stand up the new project, change the tfvars and backend config,
re-init, apply.

---

## Concerns worth a decision

### 1. How much is public? — **decided**

**Public teaser, gated detail.** Login-gated content cannot be found by someone
searching "adoptar perro Cochabamba," and every signup step loses adopters — so
the split preserves discovery while keeping the substance behind an account:

- **Public** — photo, name, age, breed, size, status. Indexable, shareable, enough to fall in love.
- **Signed in** — full story, health notes, the whole photo set, contact route, location.

Implemented as `pets/{id}` vs `pets/{id}/detail/main`. Switching to fully gated
later is a one-line rules change, not a rewrite.

### 2. Publishing pet locations means publishing people's home addresses

This one matters and it needs to be said plainly.

- A pet in `transito` lives in a **foster volunteer's home**. Publishing that location publicly publishes a volunteer's home address.
- An `adoptado` pet lives in the **adopter's home**. Even restricted to owner and admins, we are storing residential addresses of private individuals — which carries real obligations, and real consequences if the database leaks.

What is built unless told otherwise:

- Exact coordinates **only** in `pets/{id}/location/current`, never in a public document
- Public maps for available pets show the **shelter or a meeting point** (`publicMeetingPoint`), never a foster home
- Adopted-pet location defaults to `precision: approx` — coarse area, not a pin on a house — with exact opt-in requiring the owner's explicit consent
- **Sightings are exempt.** A street sighting of a lost pet is a public event in a public place. That feature works exactly as described.

The tracking capability requested is fully intact. The difference is the *default precision* and who can widen it.

### 3. The scan ledger is a stronger version of the same problem

Worth separating from #2, because it is easy to add a scan history without
noticing it is a different category of data.

A single location is one address. **A scan history is a pattern of movement over
time** — for an adopted pet, effectively a trail of its owner's vet, their
neighbourhood, and their routine. Aggregated across a shelter's whole population
it is a small movement-surveillance dataset about private individuals, sitting
in a Firestore collection.

Mitigations in place:

- `scans` is in the **restricted** tier — admin or current owner, never
  "any signed-in user"
- `ScanEvent.precision` defaults to `approx`, same as `location`
- Writes are **admin-only**. A forged scan record would plant a false recovery
  trail, so the public route is `sightings`, which is moderated
- Under GDPR this is personal data about the owner, not just the animal
  (see `docs/rfid-microchips.md` §5) — relevant the moment any EU shelter forks
  this template

**Worth deciding before this goes live:** how long scan history is retained.
Indefinite retention is the default because nothing deletes it, not because
anyone chose it. A rolling window — say 24 months, with intake and adoption
events kept permanently as custody records — would preserve every recovery use
case while shrinking the surveillance surface. Say the word and I'll implement
it.

### 4. Maps is the only line item likely to cost money

10k map loads/month free, then $7 per 1000. Guardrails: lazy-load the map only when a user opens a location view, never on the wall or homepage; use a static map image for previews; cache tiles.

---

## Setup required from you

**1. Re-authenticate gcloud.** Tokens are expired and refresh needs an interactive prompt:

```bash
gcloud auth login
```

This is the only hard blocker left on the frontend side — Node is no longer an
issue; the current Node 20.20.2 satisfies both Next.js and TypeScript.

**2. Decided: a new dedicated GCP project**, and it will later move to a **new
tenant entirely** once the project is complete — Terraform is being written
with that move in mind (see [Terraform](#terraform)). Not `trustcert-ai-g` for
the interim either way — that is a work project, and a nonprofit's
infrastructure should not share quotas, billing, or an audit trail with it.
Needs a Blaze billing account linked (Firestore and Cloud Run require it,
though real usage should stay inside the free tier). A budget alert at $5 goes
up before anything is deployed.

**3. Install Terraform**, if it isn't already, once the Terraform task lands —
`terraform >= 1.9` is assumed.

**4. Later, not now:** DNS for `wawitas.org`, the Maps API key restricted by HTTP
referrer, the Google OAuth consent screen, and the reCAPTCHA Enterprise key for
App Check.

---

## Conventions

- **Spanish** for anything a visitor reads; **English** for code, comments, commits, and docs.
- Firestore: collection names plural and English; document *field* values may be Spanish enums (`refugio`, `transito`) since they mirror the shelter's own vocabulary.
- No secrets in the repo. Firebase Web config is public by design; anything else goes in Secret Manager.
- Commit messages: imperative mood, no attribution trailers.
- Every new visibility tier is a **new document**, never a new field. Rules cannot protect a field.
