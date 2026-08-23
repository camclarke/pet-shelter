# pet-shelter

Open-source adoption and rescue platform for animal shelters — dogs, cats, rabbits.
Reference deployment: **Wawitas Red de Apoyo**, a transitional shelter in Cochabamba, Bolivia.

- Repo: https://github.com/camclarke/pet-shelter
- Domain: **`wawitas.org`** — purchased at Spaceship, DNS managed there, pointed at Firebase Hosting 2026-08-22. Live host today is **`wawitas.web.app`** until the edge rollout completes
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
| **Naming convention** | ✅ **English code/routes/enums, i18n split — PR #3, merged + deployed 2026-08-23.** Visitor language lives only in `src/i18n/`. Page-level JSX copy is the one remaining exception |
| Local dev server | ✅ **Runs and renders** — all 5 routes verified in a browser 2026-08-08 |
| Adoption wall (`AdoptionWall.tsx`) | ✅ **Live in production, reading real Firestore** — renders its empty state from an actual query. Still **never shown a real pet**, because no pet document exists. Renamed from `Muro.tsx` 2026-08-23 |
| Pet identity (RFID microchip) | ✅ Modelled + validated, 10/10 unit tests — `src/lib/microchip.ts` |
| Medical history + feeding | ✅ Modelled — not yet surfaced in any UI |
| Template config for other shelters | ✅ `src/config/shelter.ts`, `README.md`, MIT licensed |
| Dockerfile + Cloud Run target | ✅ **Built and deployed 2026-08-12.** Now built by **GitHub Actions** (`docker buildx`); the first build was Cloud Build, since there is no local Docker on this machine. `ENV HOSTNAME=0.0.0.0` is proven, not assumed: Cloud Run's startup probe passed |
| Terraform | ✅ **APPLIED — 40 resources live.** GCS backend in `gs://wawitas-terraform-state`. One known-benign perpetual diff on `cloud_run scaling`, documented in `cloud_run.tf` |
| **CI/CD** | ✅ **GitHub Actions, applied 2026-08-12.** Keyless via Workload Identity Federation — no service-account key exists. `.github/workflows/{ci,deploy}.yml`, identity in `terraform/cicd.tf`. **All seven actions moved to Node 24 majors 2026-08-23** (PR #10) — the deprecation annotation is gone, measured against a back-to-back run on the old versions |
| Dependency security | ✅ **0 vulnerabilities** in both the production and dev trees. Two independent checks: `npm audit` in CI on every push, and **Dependabot alerts + automated security updates**, enabled 2026-08-12 |
| GCP playbook | ✅ [`docs/gcp-lessons-from-trustcert.md`](docs/gcp-lessons-from-trustcert.md) — bootstrap order, ownership split, IAM, secrets, CI, and the incident catalogue from a live sibling stack |
| **Live site** | ✅ **https://wawitas.org**, **https://wawitas.web.app** and the Cloud Run URL — all serving on **every** route including the bare apex, real Spanish HTML, wall reading live Firestore |
| **Firebase Hosting** | ✅ **DEPLOYED 2026-08-22 — the first release ever.** `sites/wawitas/releases` had been `{}` since the project began, so `wawitas.web.app` 404'd. Cause: `firebase.json`'s hosting block had `rewrites` + `headers` but **no `public`/`source`**, so there was no document root to upload. A rewrite is not a deployable artifact |
| **Custom domain** | ✅ **FULLY SERVING 2026-08-23, apex included.** `wawitas.org` + `www`: `HOST_ACTIVE`, `OWNERSHIP_ACTIVE`, **`CERT_ACTIVE`**, `DNS_MATCH`, **0 issues**. Every route returns 200 **including the bare `/`**, which had 404'd since provisioning — cleared by a `firebase deploy --only hosting` that purged the edge. Safe to publish on flyers and social profiles |
| GCP project | ✅ **`wawitas`** (`181094228409`), region **`us-east1`**, personal account `israel.rocha.clarke@gmail.com`. **No org parent.** Replaces `wawitas-pet-shelter` (employer's org, deleted same day) — see log |
| Billing | ✅ **`billingEnabled: true`** — `01AC67-128A11-DCD80D`, personal free trial. **Blaze plan via the trial. Expires 2026-11-11 exactly** (read off the Firebase console: 85 days, $300.00 remaining, as of 2026-08-17). Upgrade before then or services stop |
| ADC | ✅ Verified reaching `wawitas`. One global file, **two identities** — see the switch ritual below |
| Firestore | ✅ **Live** — `(default)`, `us-east1`, PITR on, daily + weekly backups, delete protection |
| **Firestore rules** | ✅ **DEPLOYED, AND PROVEN ENFORCING 2026-08-23** — 22/22 assertions from a real client SDK, on both the allow *and* deny branches, including the privilege-escalation one. The five-day-old caveat that they "compiled and released, which is not the same as being correct" is now retired. See the log |
| Firestore indexes | ✅ **Deployed** — 10 composite + the `identity.code` collection-group field override that `findPetByMicrochip()` needs |
| **Firebase project** | ✅ **ADDED 2026-08-16** — `projects/wawitas`, ACTIVE. Was never added until this session. **Google Analytics deliberately declined.** Imported into Terraform (`google_firebase_project.default`) |
| Storage rules | ✅ **DEPLOYED, PROVEN ENFORCING, and FIXED 2026-08-23** — `pets/**` used a single `allow write`, which covers delete, while the condition dereferenced `request.resource` (null on delete): an admin could upload a photo and **never delete one**. Now `create, update` and `delete` are separate.  — the only rules in this project that have been. Same bucket, same upload: `pets/**` reads 200, `medical/**` reads **403**. Deployed by `npm run deploy:storage-rules`, **not** the Firebase CLI, which cannot do it — see the row below and `scripts/release-storage-rules.mjs` |
| **Pet seeding tool** | ✅ **Built + tested 2026-08-23** — `npm run seed:pet`, `scripts/seed-pet.mjs`, template in `seed/EXAMPLE-pet.json`. Validates, strips EXIF, uploads, and derives `coverPhoto`. **Never run against real data — `pets` is still empty** |
| `firebase deploy --only storage` | ❌ **Will never work here, and that is fine.** It demands a Firebase *default* bucket; this project uses a named Terraform-managed one. Adding the Firebase project did **not** fix it — that was a wrong guess too. Use the npm script |
| Firebase emulator suite | ❌ **Not used — decided 2026-08-08.** Also cannot run here (no Java) |
| Firebase web app | ✅ **Registered 2026-08-16** by Terraform (`google_firebase_web_app.web`). The four `NEXT_PUBLIC_*` values are in `.env.local`, from `terraform output firebase_web_config` — never copied from a console |
| Firebase Auth | ✅ **Initialized 2026-08-16, Email/Password ON, and EXERCISED end to end 2026-08-23.** Subtype is **`IDENTITY_PLATFORM`**, not legacy Firebase Auth — which matters: **email enumeration protection is on by default** and is measured, not assumed. **Google provider still off** — needs an OAuth consent screen |
| **Auth flows (UI)** | ✅ **BUILT + VERIFIED IN A BROWSER 2026-08-23** — sign up, sign in, sign out, password reset, email verification, session persistence across reload. `src/lib/auth.ts`, `AuthProvider`, `AccountPanel`, `AccountLink`. Firebase is **dynamically imported** so it stays out of the homepage bundle — measured, see the log |
| **Admin intake UI** | ✅ **BUILT + VERIFIED IN A BROWSER 2026-08-23** — `/admin`, `/admin/intake`, steps 1–3 manual. A pet was entered, photographed, published and deleted end to end. Plan §3, build-order step 5. Dedup (§3.1) is step 6 and is **not** built |
| **Admin custom claim** | ✅ **`npm run grant:admin`** — `scripts/grant-admin.mjs`. The only thing that writes `request.auth.token.admin`, deliberately outside the deployed surface. Merges claims rather than replacing them, and verifies by reading back |
| **`petDrafts` rules** | ✅ **DEPLOYED + PROVEN ENFORCING 2026-08-23** — 11/11 client-SDK assertions across *no claim → granted → revoked*. Byte-identical readback from the Rules API |
| Maps + sightings | ⬜ Not started |
| Reporting (BigQuery mirror) | ⬜ **Decided 2026-08-09, deliberately not built** — add when a real report is asked for |
| **Intake / medical / food / areas plan** | ✅ **Written 2026-08-16** — [`PLAN-intake-and-syndication.md`](docs/PLAN-intake-and-syndication.md). 14 sections |
| Arrival pipeline — model layer | ✅ **Built + tested 2026-08-16.** Statuses, `areas`, `placements`, rules, indexes. **Outbreak trace verified against live Firestore with known data**, not just deployed |
| Arrival pipeline — UI | ⬜ Not started — **no longer blocked on auth**; the admin surface and the claim now exist |
| Veterinary record standards | ✅ **Researched 2026-08-16** — [`veterinary-records-standards.md`](docs/veterinary-records-standards.md). No international EMR standard exists; modelled on the EU passport + WSAVA 2024 |
| LLM vaccination-card parsing | ⬜ **Planned in full**, plan §4. **Gemini via AI Studio, never Vertex** — [`gemini-api-playbook.md`](docs/gemini-api-playbook.md) |
| LLM veterinary voice dictation | ⬜ Planned, plan §4.7. **Highest-risk path in the system** — mandatory two-extractor consensus on dosages |
| Arrival pipeline + shelter areas | ⬜ Planned, plan §13. Placement intervals for outbreak tracing, not a current-area field |
| Food: donations → pot → rations | ⬜ Planned, plan §12. LLM parses, **deterministic code does the arithmetic** |
| Social syndication | ⏸ **Deferred 2026-08-16 at the user's direction.** Facebook + Instagram only when resumed; X and TikTok are *out* |

### Progress log

- **2026-08-02** — Read the Facebook page; catalogued the five recurring content types (adoption, lost pet, adoption fair, education, rescue appeal). Wrote `PLAN.md`.
- **2026-08-02** — Sampled the real brand from their Facebook cover and logo. Jade is `#31907A` in both. Rebuilt the heart-paw mark as SVG. Adopted their own tagline, *"De la calle, a tu corazón"*, as the homepage headline. Style system in `design/estilo.html`.
- **2026-08-02** — Architecture pivoted to GCP serverless + Firestore + Firebase Auth. Repo created. Data model and security model designed (below).
- **2026-08-02** — Wrote the data model (`src/lib/types.ts`), security rules for Firestore and Storage, composite indexes, `firebase.json`, design tokens, base layout, and the Muro de Adopción — originally on **Astro**, static output. Hit a hard Node blocker: Astro ≤7.0.9 carries eight high-severity advisories, and the only patched line (≥7.1.6) requires Node ≥22.12.0 while the machine had 20.20.2.
- **2026-08-02** — **Pivoted to Next.js**, at the user's direction, for scalability and to standardize on Terraform for IaC. This turned out to also resolve the Node blocker: Next 16 only requires Node ≥20.9.0. Rebuilt the frontend as Next.js App Router with `output: 'standalone'` for Cloud Run. The wall and dog pages moved from a client-side Firestore fetch to **Server Components reading via the Admin SDK** (`dogs-server.ts`) — this is a genuine improvement, not just a port: the public teaser is now real HTML in the first response, closing an SEO gap the static-Astro version had (client-fetched data is invisible to a first-pass crawl). `npm run build` was run and succeeds; `npm audit` was run and forced three transitive advisories (`sharp`, `postcss`, `uuid`, all pulled in by Next/firebase-admin's own dependency trees) to patched versions via `overrides` — 0 vulnerabilities. This is the first framework in this project to actually compile.
- **2026-08-02** — Pinned `firebase-admin` to `^13.10.0` rather than the latest `14.x`, which requires Node ≥22 — the dev machine is on 20.20.2 and Next.js itself doesn't need the upgrade, so there was no reason to force it. The Cloud Run image builds on Node 22 regardless (see `Dockerfile`), so this only affects local development.
- **2026-08-02** — Wrote `terraform/`: enabled APIs, Firestore database (with both `deletion_policy` and `delete_protection_state` set — redundant on purpose), a Storage bucket linked to Firebase, Artifact Registry with a cleanup policy, a Cloud Run v2 service with its own least-privilege service account (not the Compute Engine default), and a budget alert with email notification at 50/90/100%. `project_id`, `region`, and `billing_account` are variables; the GCS backend is configured via `-backend-config` rather than hardcoded, so moving to the new tenant is a new `backend.hcl` and re-init, not an edit to any `.tf` file. Validated with `terraform validate` and a full `terraform plan` against a placeholder project — both clean, 24 resources, 0 errors — rather than just written and assumed correct.
- **2026-08-07** — **Renamed `dog-shelter` → `pet-shelter`** and generalized the model so the project works for any species and can be forked by other shelters. `Dog` → `Pet` with a `species` dimension; Spanish gender agreement is now computed (`sizeLabel`, `speciesNoun`) rather than hardcoded masculine, because "la gata pequeña" vs "el gato pequeño" reads as carelessness to the entire target audience otherwise. All organisation-specific content moved to `src/config/shelter.ts` — the one file a forking shelter edits. Added `README.md`, MIT `LICENSE`.
- **2026-08-07** — **Added RFID microchip identity, scan ledger, medical history, and feeding plans.** Researched the international regulatory picture first (`docs/rfid-microchips.md`) because it constrains the schema. Three findings changed the design: (1) a microchip is a *passive* transponder with no GPS and centimetre read range — AVMA states it "cannot track your animal" — so the ledger records the **scanner's** location at scan time and is named `ScanEvent`, never `currentLocation`, to make live tracking impossible to misread into the schema; (2) the code must be stored as a **string** because ISO 3166 country prefixes below 100 have leading zeros (Bolivia is `068`) and integer parsing silently corrupts every such chip; (3) EU 576/2013 requires the chip be implanted **before** the rabies vaccination or the vaccination is void, which is a validatable business rule (`rabiesVaccinationIsValid`). The microchip number sits in the **restricted** tier, not the authenticated one — it is the credential by which ownership is asserted, and an account is not a reason to learn every chipped animal's number. Scan history is restricted for a stronger reason: one location is an address, a scan trail is a pattern of an owner's movements. 10 unit tests cover the validation boundaries, including the exact 38-bit national-ID ceiling.
- **2026-08-08** — **Ran the app in a browser for the first time.** Everything before this was compile-and-validate; the dev server had never been started. It works: all five routes (`/`, `/adopta`, `/ayuda`, `/nosotros`, `/cuenta`) render with correct Spanish copy, branding, nav, dark-mode toggle and footer. The Muro degrades to *"No pudimos cargar los animalitos"* rather than crashing when Firestore is unreachable — the error path is real, not theoretical. **No source file needed changing to get this far.** Four traps surfaced, none previously documented: (1) a stale `.next` cache serves `404` on every route while still logging `200`, and makes `tsc --noEmit` report phantom syntax errors inside `.next/dev/types/` — `rm -rf .next` and restart; (2) a Firestore endpoint that accepts no connection hangs the SSR render 12–40 s on gRPC retries, so the browser times out before the server answers, though the request still ends `200`; (3) `next.config.ts` `images.remotePatterns` allows **only** `firebasestorage.googleapis.com`, so any `coverPhoto` on another host throws `E231 Invalid src prop` and 500s the page — a real constraint on how seed data is written; (4) `.env.local` did not exist, and was created this session with placeholders (gitignored).
- **2026-08-08** — **Decided: real Firestore, no emulator suite, ever.** The emulator cannot start on this machine regardless — `firebase emulators:start` dies with "Could not spawn `java -version`" and no JRE/JDK is installed — but the decision is independent of that: a second source of truth for rules and composite-index behaviour is not wanted. Removed the emulator instructions from `CLAUDE.md`, `.env.example`, and `README.md`. The safety net they provided is replaced by **pinning `GOOGLE_CLOUD_PROJECT` explicitly** rather than redirecting to localhost. The `README` warning was rewritten to be true for forking shelters too — it now argues from "the Admin SDK bypasses `firestore.rules`, so a wrong project id is not caught by your security rules," which holds on any machine, instead of from this machine's credential situation.
- **2026-08-08** — **Mined the sibling `trustcert-ai-g` repo for GCP experience and wrote it up as [`docs/gcp-lessons-from-trustcert.md`](docs/gcp-lessons-from-trustcert.md).** Same architecture as this project (Next.js on Cloud Run + Firestore + Firebase Auth + Terraform + GitHub Actions), except live for months, so its 43 gotchas, three blameless postmortems, and `infra/*.tf` are a record of what this stack actually does wrong. Nothing operational was copied — no project ids, billing ids, keys, or data; the employer-project boundary is unchanged. The concrete output is §4: ten gaps between that stack and `terraform/` here, three of which (`monitoring`, `firebasestorage`, `cloudresourcemanager` APIs not enabled) are apply-time-only failures that `validate` and `plan` are structurally blind to — which is itself their most-repeated lesson, that *a clean plan is not proof of a valid config*. Also carried over: `lifecycle { ignore_changes }` on the Cloud Run image (needed the day CI exists, or `apply` rolls prod back), `user_project_override`/`billing_project` on the providers (directly relevant to the ADC hazard here), Firestore PITR + backups, the diff-aware `users/{uid}` rule that closed their privesc incident, the `fieldOverrides`-replace-not-merge index outage, and `ENV HOSTNAME=0.0.0.0` in the Dockerfile runner stage — without which a Next.js standalone container binds to the container id and never passes Cloud Run's startup probe.
- **2026-08-08** — **Corrected a stale and dangerous claim in this file.** It previously said ADC was still valid and pinned to `trustcert-ai-g`. ADC has since expired: the Admin SDK now fails with `2 UNKNOWN: Getting metadata from plugin failed ... {"error_subtype":"invalid_rapt"}`, a reauth demand. Both the gcloud CLI **and** ADC now need re-authenticating. That is temporarily the *safe* state — nothing can silently reach the work project — and the hazard returns the moment either is refreshed.
- **2026-08-09** — **Confirmed the database choice: Firestore as system of record, BigQuery for reporting later.** Revisited because the model is genuinely relational and it was worth checking the NoSQL assumption before any data existed rather than after. Firestore holds, but on *cost and integration*, not fit: Cloud SQL cannot scale to zero and so fails the project's first constraint at ~$9–25/mo forever, and Firebase Auth + Storage + App Check + Rules are one system this design leans on in four places. Supabase RLS was the only alternative preserving that property and it costs the GCP tenant plan and the written Terraform. Five weaknesses are now named in `## Architecture` rather than left to be rediscovered — reporting queries, the retention sweep, no referential integrity, tier-as-subcollection being a workaround rather than a good design, and no `ALTER TABLE`. BigQuery via the Firestore streaming extension fixes the first (and the analysis half of the second) at $0, and is **deliberately not built yet**: it is a second copy of personal data, so it should arrive with a named report justifying it and with the restricted tiers considered rather than mirrored by default. Also recorded a correction to the cost principle itself — the Next.js pivot moved the wall and pet pages to the Admin SDK, which bypasses Rules, so "Rules do authorization for free" currently applies to no path at all; it starts paying off when auth flows land and the expediente and admin console read client-side.
- **2026-08-12** — **The GCP project exists.** `wawitas-pet-shelter`, number `236546422205`. The user re-authenticated the gcloud CLI, and the project was created and `core/project` pinned to it. **It is inside the employer's `trustcertllc.com` org (`162969569100`), which reverses the constraint this file had asserted since 2026-08-02** — the user was shown the tradeoff (inherited org policies, shared billing and audit trail, a tenant move that becomes a migration instead of a re-init) and chose the work account anyway. Only the narrower rule survives: never `trustcert-ai-g` itself. Ordering mattered and CLAUDE.md's own instruction was not literally followable — it said to pin `GOOGLE_CLOUD_PROJECT` *before* both logins, but the project id does not exist until after `gcloud auth login`. The order actually used preserves the same property: CLI login → create project → pin `.env.local` and `gcloud config` → *then* ADC login, because ADC is the credential `firebase-admin` and Terraform consult, and it stayed dead throughout. **Billing is blocked and is now the critical path:** `israel.rocha@` has only `roles/billing.costsManager` on `014C58-4F2EB7-670697`, which cannot run `billing.resourceAssociations.create`; `danibuzolin@` holds `roles/billing.admin`. Two things could not be checked at all: org policies (permission denied at the org level — so whether Domain Restricted Sharing will block `allUsers` on Cloud Run is unknown until apply) and `terraform plan` (needs ADC). Also landed all five pre-apply Terraform/Docker fixes — three API enablements, `user_project_override` + `billing_project` on both providers, Firestore PITR + daily/weekly backup schedules, and `ENV HOSTNAME=0.0.0.0` — `terraform validate` clean, which is the weakest of the three claims and is all that was earned.
- **2026-08-12** — **ADC refreshed, and for the first time a credential in this project actually reached a live Google API.** The user ran `gcloud auth application-default login` while thinking about the *other* project, which surfaced the thing worth writing down: **ADC is one machine-global file, not one per project.** It takes its quota project from whatever `gcloud config` holds at the moment it runs — which was `wawitas-pet-shelter`, because that had been pinned first. So the ordering used earlier in the day paid off exactly as intended. Verified with a read-only `google-auth-library` probe run with **no `.env.local` loaded**, so it tests ADC alone rather than testing the env var: it resolved `wawitas-pet-shelter` for both projectId and quotaProjectId and returned the live project record. **The hazard has now reversed** — local `trustcert-ai-g` work that leans on ADC for its project id will resolve *here* until `set-quota-project` is run the other way; it fails loudly only because no Firestore database exists yet, and that protection ends at the first `terraform apply`. The probe also **empirically confirmed a gap that had been inherited rather than measured**: it failed first with *"Cloud Resource Manager API has not been used in project wawitas-pet-shelter"*. Enumerating the project's default APIs then corrected the sibling stack's claim — of the three "missing" enablements, `monitoring` was already on by default and only `cloudresourcemanager` and `firebasestorage` were genuinely absent. `cloudresourcemanager` was enabled manually via `gcloud services enable` because the Terraform provider needs it to bootstrap; `serviceusage` was already on, so Terraform can do the rest. With ADC live, **`terraform plan` ran against the real project for the first time: 29 to add, 0 to change, 0 to destroy, no warnings** — 24 as previously documented plus the 3 API entries and 2 backup schedules. It needed a temporary `backend_override.tf` to use local state, because the GCS backend needs a state bucket and that needs billing; the override was deleted afterwards and no `.tfstate` was written, so the GCS backend path is still unexercised. `terraform.tfvars` now holds the real project id, billing account, and image path (gitignored).
- **2026-08-12** — **DEPLOYED. The site is live and serving from real Firestore.** Region moved to **`us-east1`** at the user's direction — which forced a check of an inherited claim in this file that `us-east1` is not a valid Firestore location. **It is.** `gcloud firestore locations list` lists it alongside ~45 others; that was the *second* claim inherited from the sibling stack to fail verification in one day (the first being "three missing APIs," which was two). us-east1 is also the better choice here: inside the GCS Always Free tier and ~1,200 km closer to Cochabamba than Iowa. Applied in **three stages**, because the user correctly pushed back on deploying a placeholder image: Artifact Registry cannot exist before Terraform creates it, and Cloud Build cannot push before it exists — so stage 1 was `-target` on the APIs + registry, stage 2 was `gcloud builds submit` (**no local Docker on this machine; the Dockerfile had never once been built**), stage 3 was the full apply with a real image. **Three things that had been unfalsifiable since they were written all came back green at once:** the Firestore backup retention values passed server-side validation, `allUsers` on `run.invoker` succeeded (no org parent, so no Domain Restricted Sharing), and `ENV HOSTNAME=0.0.0.0` proved itself — Cloud Run's startup probe passed and the container logged `Network: http://0.0.0.0:8080`. Then the wall showed its **error** state rather than its empty state, and chasing that found **two real defects**. First, the composite index on `pets(status, createdAt desc)` was declared but never deployed — Firestore demands it even against an empty collection, and the symptom is indistinguishable from "no data," which is precisely the sibling stack's *"data gone is usually query broken"* lesson happening live. Second and worse: **`src/app/page.tsx` had no `revalidate`**, so Next.js prerendered the homepage at *build* time — inside Cloud Build, where Firestore is unreachable — and froze the Muro's error state into static HTML permanently. `/adopta` and `/adopta/[slug]` both carried `revalidate = 300` and self-healed on their own; the homepage, the single most important page for the primary objective, would never have recovered and nothing would have appeared in any log. Fixed with `revalidate = 300` (not `force-dynamic`, which would cost one Firestore query per visitor). Also found and fixed before they could bite: **no `.dockerignore`** existed, so `COPY . .` would have baked `.env.local` and `terraform.tfvars` — including the billing account id — into the image layers; `firebase.json` pointed the Hosting rewrite at the wrong service name *and* the wrong region; and two **perpetual Terraform diffs** were eliminated or documented rather than left to train everyone to skim plans. Rules were **still not deployed** at that point — the Firebase CLI turns out to be a *third* credential store, authed as the expired work account, and it ignores `GOOGLE_APPLICATION_CREDENTIALS`.
- **2026-08-12** — **Firestore rules and indexes deployed.** After `firebase logout` / `firebase login` as the personal account, the first-ever deploy of `firestore.indexes.json` **rejected the file**, which found two bugs that had sat undetected precisely because the file had never been deployed and nothing else validates it. Both were single-field entries declared as composite indexes, which Firestore refuses with *"this index is not necessary, configure using single field index controls"*: `scans`/`scannedAt` was already automatic and was deleted outright, and `identity`/`code` — **the microchip lookup, the single most important query in the system** — had to move to `fieldOverrides`, because a COLLECTION_GROUP scope on a *single* field is a field-level setting, not an index. That fix ran straight into this file's own inherited warning that **a `fieldOverride` replaces rather than merges**: the default COLLECTION ASC and DESC entries are now re-listed explicitly, since dropping them would have silently disabled ordinary per-pet queries on `code`. Deployed result verified by API, not by the CLI's success message: 10 composite indexes plus the `code` field override. **Rules compiled and released, but their enforcement remains completely untested** — no Firebase web app exists, so no client can reach Firestore at all. `storage.rules` is still undeployed: the CLI demands a Firebase *default* bucket while this project deliberately uses a Terraform-managed named one, and setting `storage.bucket` in `firebase.json` did not satisfy it. Confirmed that is not an exposure — `wawitas-app` carries no `allUsers` binding, has uniform bucket-level access, and grants `objectAdmin` only to the Cloud Run service account.
- **2026-08-12** — **Moved off the employer's org entirely, onto a personal free-trial account, and billing finally works.** The user judged the trustcertllc.com arrangement too complex — a fair call, since it had already cost a blocked billing link, an unreadable org policy, and a dependency on a colleague. `wawitas-pet-shelter` was shut down. **Two project IDs are now permanently burned:** Google never releases an ID for reuse after deletion, so `wawitas-pet-shelter` is gone forever, and `pet-shelter` turned out to be already taken globally by someone else. The project is **`wawitas`** (`181094228409`) on `israel.rocha.clarke@gmail.com`, with **no organization parent** — `gcloud projects create` without `--organization` leaves the project outside the org Google auto-provisioned for the account. That kills the single largest unknown in the apply: there is no org policy to inherit, so the Domain Restricted Sharing risk to `allUsers` on Cloud Run is gone. Billing linked in one command (`billingEnabled: true`) because the user holds `billing.admin` on their own account. **The trial is $300 over 90 days, not 90 months as first understood — it expires around 2026-11-10, and services stop unless the account is upgraded to paid.** The new structural fact is that **two Google identities now share one machine**, and ADC is a single file that cannot hold both. This bit immediately: an `application-default login` run as the work account kept `quota_project_id: wawitas-pet-shelter`, a project deleted minutes earlier, leaving a credential useless to both projects. Offered per-project `CLOUDSDK_CONFIG` directories versus manual re-login; **the user chose manual switching.** Worth recording from that investigation: `google-auth-library` *does* honour `CLOUDSDK_CONFIG` (verified in `node_modules/.../util.js:162`), but Terraform's Go provider does not, so the config-dir approach needs `GOOGLE_APPLICATION_CREDENTIALS` alongside it — which is why it was judged more machinery than it is worth. One consolation in the split: the two accounts share no access, so a forgotten switch now fails with a permission error instead of silently writing to the wrong project. The 2026-08-07 class of incident is structurally impossible now.

- **2026-08-12** — **CI/CD is live and a deploy has actually run through it.** Every deploy before this was hand-driven: `gcloud builds submit`, bump `container_image` in tfvars, `terraform apply`. Now a push to `main` builds, pushes a commit-SHA tag, rolls a Cloud Run revision, and checks the URL answers. **No service-account key exists** — GitHub's OIDC token is exchanged via STS, and the pool provider's `attribute_condition` pins the repository, which is the only thing separating this repo from every other one presenting a token from the same shared issuer. The CI service account is separate from the runtime one, so CI cannot read Firestore and the runtime cannot deploy. Applied 10 resources (40 total now). **The `lifecycle { ignore_changes }` on the Cloud Run image landed in the same commit as the pipeline**, as `docs/gcp-lessons-from-trustcert.md` §3 explicitly instructs, and — unusually for this project — **it was then proven rather than assumed**: after CI deployed `app:7c62d54…`, `terraform plan` showed only the known-benign `scaling` diff and did *not* propose reverting to `20260812-2`, the tag still sitting in `terraform.tfvars`. That is the silent production rollback this file has been warning about since 2026-08-08, observed not happening. Three findings worth keeping. (1) **`run.admin` had to stay project-level.** Cloud Run v2 operations are project-scoped resources, not children of the service, so a service-level binding covers `services.update` and then fails polling the operation it returns — the failure would look like a broken deploy, not a missing grant. (2) **WIF is three APIs, not one.** `iam` fails at apply; `sts` and `iamcredentials` fail at the *first workflow run*, which is a strictly worse place to find out — the same apply-time-blindness lesson one layer further out. (3) **The pipeline found a real vulnerability on its first run.** `npm audit --omit=dev` reported nanoid 3.3.16 (high, GHSA-2v37-7h3g-55p8), reached through `next → postcss`. Not a regression — the advisory postdates the 2026-08-08 audit, which is precisely the argument for the step existing. Fixed with an `overrides` entry, matching how `sharp`/`postcss`/`uuid` were already handled; back to 0 vulnerabilities. The audit step is deliberately `continue-on-error` — a newly-published advisory against a transitive dependency should warn, not block an unrelated PR. **Rules and indexes are deliberately still not in the pipeline:** an unreviewed automatic rules deploy is worse than a manual one until there is a rules test in front of it. `terraform/**` is in `paths-ignore` for the same reason — infrastructure stays a deliberate human `apply`.

- **2026-08-12** — **Swept for vulnerabilities and confirmed everything deployable was already deployed.** Nothing needed fixing: `npm audit` is clean on both the production and dev trees, and the nanoid advisory found hours earlier is in the running image — the Docker build log for `app:7c62d54…` shows `found 0 vulnerabilities`, which is a stronger check than auditing the working tree. Terraform needed no apply: `plan` proposes exactly one action, the known-benign `scaling` no-op, and nothing else is drifting. Firebase needed no deploy either, and this was **verified rather than inferred from git history** — the released ruleset was pulled from the Rules API and diffed against `firestore.rules` byte-for-byte (identical), and the 10 deployed composite indexes plus the `identity/code` field override match the declared set. `storage.rules` is still blocked, re-confirmed by running the deploy rather than trusting the note: *"Firebase Storage has not been set up."* The Rules API shows only a `cloud.firestore` release and the project has no default bucket, only `wawitas-app`, `wawitas-terraform-state`, and a now-orphaned `wawitas_cloudbuild` left over from the bootstrap build. **The one real gap found was that Dependabot alerts were disabled** — CI's audit step only runs when someone pushes, so a new advisory during a quiet week would go unseen, which is exactly how the nanoid one nearly slipped by. Alerts *and* automated security updates are now on, verified by API (`{"enabled":true,"paused":false}`, 0 open alerts). Dependabot's fix PRs run through `ci.yml` like any other, so nothing merges unverified. Note the interaction to watch: this project pins transitive fixes with `overrides`, and Dependabot does not manage those — a PR bumping a direct dependency may leave a stale override behind.

- **2026-08-16** — **Planned the next phase end to end, and wrote down the standards it rests on.** No code; the output is `docs/PLAN-intake-and-syndication.md` plus `docs/veterinary-records-standards.md`, on `feature/pet-intake-and-social-syndication`. The research produced one **negative** headline that shapes everything else: **there is no international standard for a companion animal's electronic medical record** — nothing in veterinary medicine corresponds to FHIR/SNOMED/LOINC, so the schema is ours to design. It is anchored to the **EU pet passport's section structure** (the only published field schema for this data) plus **WSAVA 2024**'s certificate fields, which between them produced four `MedicalRecord` additions we lacked — `manufacturer`, and `validFrom`/`validUntil` as genuinely distinct from `performedAt`/`nextDueAt`, because for rabies the date protection *begins* is 21 days after injection and is the one with legal force. Clinical terminology (VeNom, SNOMED VetSCT) is **deliberately deferred with an empty `codes[]` socket**: neither survives contact with a volunteer transcribing a handwritten card, and free text is backfillable. **Corrected a stale claim in `rfid-microchips.md` §5** — Regulation (EU) 576/2013 was superseded on **22 April 2026** by Delegated Regulation (EU) 2026/131 under the Animal Health Law. Every rule the code depends on survived, so `rabiesVaccinationIsValid()` is still right; one rule was *added* (≥12 weeks at rabies vaccination) that we do not validate. For **Bolivia** the answer is that nothing here is nationally mandated, but the choice is forced anyway by SENASAG's ISO-based export paperwork, the ISO hardware sold locally, and keeping internationally adopted animals eligible — with **WOAH Ch. 7.7** added as the legitimacy argument rather than a schema. Two platform findings killed most of the social-media request on the facts: **X discontinued its free tier on 6 February 2026** and charges ~$0.20 per post carrying a URL, which every post of ours would; and **TikTok forces unaudited posts to `SELF_ONLY`**. Facebook and Instagram are free and avoid App Review entirely, because posting only to the shelter's own accounts lets the Meta app stay in Development mode indefinitely. The user then **deferred social work altogether** and scoped it to those two.

- **2026-08-16** — **Three directed reversals and three new subsystems, same day.** (1) **Gemini goes through AI Studio with an API key, not Vertex AI**, at the user's direction, following `docs/gemini-api-playbook.md` — ~4 months of production experience on that exact surface, carried from the sibling stack. This reversed a recommendation made hours earlier that had argued for Vertex on the grounds that the runtime service account avoids managing a key; the playbook wins because adopting Vertex would discard a document cataloguing a **$665/month surprise bill** and a metering layer that was **9× wrong**. Infrastructure got *simpler* — no `aiplatform` API, no IAM grant, no ADC involvement, so an AI call can no longer resolve to the wrong project because it does not resolve to a project at all — at the cost of one new credential in Secret Manager. **Grounded search is ruled out as a standing constraint, not a deferral**: it is billed per search query, was 73% of one month's bill, carries zero tokens so token-based metering is structurally blind to it, and nothing here needs the web. (2) **Veterinary voice dictation** is now the highest-consequence path in the system and is designed accordingly — one call returns *both* a verbatim transcript and the structured extraction, the transcript is the record, and **two-extractor consensus is mandatory** because *"medio mililitro"* and *"cinco mililitros"* differ by one syllable in spoken Spanish and a factor of ten in the animal. The system may display `mg/kg × weight` as a labelled aid but must never write a computed dose as though prescribed. (3) **Food management reverses the requested design on purpose:** the LLM parses donation descriptions into structured stock, and **deterministic code does the yield arithmetic** — an LLM is non-deterministic on numbers, so the same stock could give two answers on two days with no way to tell which was wrong. The raw→cooked→ladle conversion is **measured, not computed**: rice triples, meat shrinks, water is unmeasured, and the first N cook batches *are* the calibration dataset. Grounded rations in `RER = 70 × kg^0.75`, which surfaces something the ladle heuristic hides — energy need scales **sub-linearly**, so a linear ladle rule systematically underfeeds large dogs. Body condition uses the **WSAVA 9-point scale**, from the same body whose vaccination guidelines this project already follows. All of which exposed a real gap: **there is no weight field** — `Pet.size` is a wall filter, not a clinical quantity — so a `measurements` subcollection was added, as a subcollection rather than two fields because *"reduce the fat ones"* is a feedback loop and a loop needs a trend.

- **2026-08-16** — **Arrival pipeline and shelter areas planned, replacing a WhatsApp message with a record.** Caught a naming collision worth knowing about: **`PetStatus.transito` already means "hogar de tránsito" — a foster home** — so the new en-route state is **`en-camino`**, because the two are opposites and colliding them in the only language the staff use would be a lasting mistake. The wall needed no change at all, since `getWall()` filters to `adopcion`: an allowlist, not a denylist. **Deliberately did not replace the WhatsApp ping — wrapped it.** WhatsApp works because everyone has it and it pushes; an in-app notification gets missed, staff revert to the group chat, and the system holds empty records while the real information lives in a thread. So the record moves to the app and the app emits a pre-filled `wa.me` link, making the group message *point at* a record rather than *be* it — the same mechanism the public site already converts through. The central design point is that **placements are an interval ledger, not a `currentArea` field**: outbreak isolation is always asked retrospectively, a dog diagnosed today was infectious before it looked sick, and **canine distemper incubation reaches six weeks** (parvovirus two), which sets the minimum lookback. Kept **quarantine and isolation as distinct area kinds** per the **ASV Guidelines for Standards of Care in Animal Shelters** — merging them means the UI cannot warn when a sick animal is about to go in among healthy ones — and modelled area capacity because those guidelines are explicit that crowding is itself a disease risk. `currentAreaId` is **not** denormalised onto `Pet`, because that document is public-read and where an animal is housed has no reason to be. Flagged that the required collection-group index is the same shape as the one whose non-deployment broke `findPetByMicrochip()`, and that **an outbreak trace silently returning nothing is the worst version of that bug** — so it needs a test with known data, not a green deploy.

- **2026-08-16** — **Started executing the plan, and the first act was finding that a load-bearing assumption in this file was false: the GCP project had never been added to Firebase.** `firebase projects:list` returns *"No projects found"*, and the Management API answers `searchApps` with *"Firebase project 181094228409 not found"*. **This is the real cause of the undeployable `storage.rules`**, which this file had recorded for four days as *"needs a Firebase default bucket (console-only Get Started)"* — a plausible diagnosis that sent the previous session hunting for the wrong thing. The reason the gap survived undetected is worth keeping, because it will recur: **several Firebase-branded things work fine without a Firebase project.** `firestore.rules` and `firestore.indexes.json` deploy through `firebaserules.googleapis.com`, and `google_firebase_storage_bucket` applies through `firebasestorage.googleapis.com` — both plain GCP APIs. `wawitas-app` really is registered as a Firebase Storage bucket, confirmed by querying the API rather than inferring it from Terraform state. So "the Firebase CLI deployed something successfully" was never evidence the project existed. **`addFirebase` cannot be automated here:** it returns a bare `403 PERMISSION_DENIED` for `israel.rocha.clarke@gmail.com` *holding `roles/owner`*, and returns the identical 403 with a raw `gcloud` token rather than the Firebase CLI's — so it is not a scope or credential problem. It is the un-accepted Firebase Terms of Service, which needs a human in the console once per account. Declared `google_firebase_project` + `google_firebase_web_app` in a new `terraform/firebase.tf` with an **import-do-not-create** warning, and added a `firebase_web_config` output so the four `NEXT_PUBLIC_*` values come out of `terraform output` instead of being copied from a console. That output is deliberately **not** marked sensitive: every `NEXT_PUBLIC_*` value is compiled into the browser bundle and served to anyone who loads the site, so hiding it from `terraform output` would change nothing about who can read it. Public-by-design is a different category from the sibling stack's leaked salt, and conflating the two makes the real rule harder to follow. Also **corrected the ADC state**: it was silently holding the *work* identity again — caught not by inspection but by a `terraform state list` failing as `israel.rocha@trustcertllc.com`. The user re-ran the login and it now resolves the personal account with `quota_project_id: wawitas`, verified against the oauth2 userinfo endpoint rather than trusting the command's output.

- **2026-08-16** — **Built and verified the arrival pipeline's model layer — and the outbreak trace is the first thing in this project proven against live data rather than deployed and hoped for.** `PetStatus` gained `en-camino`, `cuarentena` and `cancelado`; the claim that the wall needed no change was **checked rather than trusted** (`getWall()` filters `status == 'adopcion'`, and `Muro.tsx` only tests `perdido` — no exhaustive switch exists anywhere, so nothing broke). Added `Area`, `Placement`, `PetMedia`, `PetMeasurement`, the four EU-passport/WSAVA `MedicalRecord` fields, `serologia`, and the `extractedByModel` provenance pair. The decision logic lives in `src/lib/placements.ts` as **pure functions over epoch milliseconds with no Firestore import**, precisely so it can be tested without a database — 23 tests, plus 14 for the status machine in `arrival.ts`, 47 total. **Then it was run against real Firestore**: seeded five animals with hand-computed intervals across two areas, ran the real `collectionGroup('placements')` query through the Admin SDK, and asserted the trace returned `resident (10d), luna (5d)` in that order while correctly excluding an animal that left before the window and one in a different area — then deleted the fixtures and confirmed the collection was empty again. Three findings. (1) **Two composite indexes I first wrote were unnecessary** — single-field orderings that Firestore indexes automatically — and declaring them would have had the *whole file* rejected, not just the offending entry, which is exactly the 2026-08-12 failure. Removed before deploying, and the reason is now recorded in the file so they do not get re-added. (2) **The missing-index failure is loud, not silent.** The first run hit `9 FAILED_PRECONDITION: the query requires an index... currently building`, which is genuinely reassuring: this file's standing fear was a broken collection-group query returning an empty result indistinguishable from "no contacts." It does not — it throws. The remaining silent-failure risk is *missing data*, so `traceOutbreak()` returns an explicit `noPlacementData` flag rather than leaving a caller to infer it from an empty array. (3) Interval overlap is **closed, not half-open, on purpose**: a contact trace fails toward *including*, the opposite of the LLM extraction gate's fail-toward-dropping, because a false positive costs one examination while a false negative leaves an infected animal in general population — and touching intervals are a real exposure route, since parvovirus survives on surfaces for months.

- **2026-08-16** — **Unblocked Firebase end to end, and two of this file's own diagnoses turned out to be wrong along the way.** The user accepted the Firebase Terms in the console (the un-scriptable step) and the project is now `projects/wawitas`, ACTIVE — **with Google Analytics deliberately declined.** Worth recording how that decision nearly went the other way: the "add Firebase to an existing GCP project" flow puts the **Enable Google Analytics toggle on one screen and the mandatory-looking GA terms on the next**, so clicking Continue past the toggle lands you on a screen where accepting GA terms is the *only* way forward and the button is greyed out. It reads as compulsory and is not. Going back one step and switching the toggle off changed the button from "Continue" to "Add Firebase" and skipped the GA terms entirely — no GA account, no linked property. The rationale for declining is the 2026-08-09 BigQuery precedent (a second data pipeline arrives when a named report justifies it) plus a concrete objection: the conversion this project optimises is an outbound `wa.me` jump, which Analytics can log and then goes blind on, so it cannot measure the one thing that matters — and on an EU fork it would add a consent banner sitting directly between the landing page and the WhatsApp button. **Then `terraform import` + `apply` registered the web app**, so the four `NEXT_PUBLIC_*` values came out of `terraform output firebase_web_config` rather than being copied from a console; they are in `.env.local`, and `deploy.yml` already passes all eight as build args so the pipeline needed no change. **The `storage.rules` diagnosis was wrong twice.** This file said "needs a default bucket" (wrong), the previous entry said "there is no Firebase project" (also wrong, or rather incomplete) — the truth is that the **CLI** demands a default bucket while the **Rules API does not**, and adding the Firebase project did not change the error by one character. The fix is `scripts/release-storage-rules.mjs` (`npm run deploy:storage-rules`), which creates a ruleset and releases it under `firebase.storage/{bucket}` — the bucket lives in the *release name*, which is exactly the hook a named bucket needs. It reads the bucket out of `firebase.json` so a forking shelter cannot silently inherit `wawitas-app`, and it verifies by reading the live ruleset back and diffing it rather than trusting the write. Deliberately not in CI, same reasoning as `firestore.rules`. **Also initialized Firebase Auth**, which had never been touched: `initializeAuth` succeeded over the API, Email/Password is on, and the subtype is **`IDENTITY_PLATFORM`** rather than legacy Firebase Auth — same 50k MAU free allowance for email and social, but it is the upgraded product and its pricing page is the one to read. The trap found there: **`authorizedDomains` contained only `wawitas.firebaseapp.com` and `wawitas.web.app`** — no `localhost`, no Cloud Run URL — so sign-in would have failed in dev *and* production with an error pointing at the domain rather than at this list. Added both plus `wawitas.org`. Two smaller things: the Firebase console reports the trial expiring **2026-11-11** exactly (85 days, $300.00 remaining), replacing this file's "~2026-11-10"; and **PowerShell 5.1's `Get-Content -Raw` decodes a BOM-less UTF-8 file as ANSI**, which made a byte-identical ruleset look like a 570-character mismatch — every rules diff in this repo must be done in Node, because the file headers are full of multi-byte box-drawing characters.

- **2026-08-22** — **Firebase Hosting deployed for the very first time, and `wawitas.org` pointed at it.** The blocker was one missing key: `firebase.json`'s hosting block carried `rewrites` and `headers` but **no `public` and no `source`**, so `firebase deploy --only hosting` had no document root, `sites/wawitas/releases` stayed `{}`, and `wawitas.web.app` returned 404 — while the Cloud Run URL served fine, which is exactly why it went unnoticed. **A rewrite is not a deployable artifact; a Hosting version needs a file root even when almost every path proxies away.** Fixed with `"public": "public"`, which also puts `robots.txt` on the CDN edge instead of proxying it. **Confirmed Firebase Hosting is still the right front end rather than porting to a Cloud Run domain mapping**, and this time by measurement: domain mappings *are* available in `us-east1` (the API answers), so the alternative was real — it loses because it has **no CDN** (every hashed chunk and photo would cross ~5,000 km to an audience on mobile data in Cochabamba) and because Google steers production to an HTTPS Load Balancer at ~$18/mo, which breaks the $0 constraint the whole Architecture section descends from. **`/_next/static` is deliberately proxied, not uploaded**: Next stamps `max-age=31536000, immutable` on it so Hosting's CDN caches it after one hit, and that hit lands on an instance the visitor's own HTML request just warmed — serving it from Hosting instead would need CI to deploy Hosting in lockstep with the image, and a build-id/chunk mismatch is a new outage class. That review found a real defect: the existing `**/*.@(…|woff2)` header rule matches `/_next/static/media/*.woff2` and **downgraded content-hashed immutable fonts to 7 days**; a `/_next/static/**` rule now precedes it, and *which rule wins was verified by fetching a chunk* (`max-age=31536000, immutable`) rather than assumed from ordering. Domains are in `terraform/hosting.tf` with `wait_dns_verification = false`, since the records they require cannot exist until a human enters them at the registrar — apply would otherwise block on an action apply cannot take. The Hosting **site** is deliberately *not* imported: it is a byproduct of `google_firebase_project`, its id always equals the project id, and importing it would hand `terraform destroy` a way to delete the site out from under the domain. **Apex is canonical, `www` 301s to it** via Firebase's own `redirect_target`, so no app code is involved. Four findings from the registrar work. (1) **The Firebase CLI was logged in as the work account again** — second occurrence — and it **ignores `GOOGLE_APPLICATION_CREDENTIALS`**, re-verified by setting it and watching nothing change; only `firebase logout` / `firebase login` fixes it. (2) **Spaceship showed "DNS Records (0)" while `wawitas.org` resolved to two AWS IPs** — the parking A records are *implicit*, not rows in the panel, and there is no URL-redirect config either. Adding an explicit apex A record displaced them, confirmed by querying `launch1.spaceship.net` directly rather than trusting the UI. (3) **Spaceship's Host field rejects empty for the apex** — the `@` shown is a placeholder, and leaving it blank fails validation with a bare *"Invalid host value"*; `@` must be typed in. (4) **A catch-all `**` rewrite does not break ACME**: probing `/.well-known/acme-challenge/…` on `wawitas.web.app` returns Cloud Run's 404 with `X-Powered-By: Next.js`, which looks alarming, but the same path on `wawitas.org` is answered by `Server: Varnish` — Hosting's own edge — because interception only applies to a domain actually in provisioning. **The claim earned here is "DNS, ownership and certificate are verified," not "the site serves on wawitas.org."** Watched to ground truth rather than trusted: `CERT_VALIDATING` → `CERT_PROPAGATING` at 17:03, TLS handshake started succeeding at 17:05 (the 404 that replaced the cert error is *progress*, not a regression), `OWNERSHIP_MISSING` → `OWNERSHIP_ACTIVE` at 17:09. At handoff both domains were `HOST_ACTIVE` + `OWNERSHIP_ACTIVE` with **`issues: 0`**, `reconciling: false`, a FINALIZED release on the site, and a genuine `CN=wawitas.org` certificate from Google Trust Services — with the apex still answering 404 for ~45 minutes. **That 404 is Firebase's own "Site Not Found" page, not Cloud Run's and not the app's**, which is the distinguishing detail: it means the hostname→site binding has not reached that edge node yet, and it is the difference between "wait" and "something is wrong." `X-Powered-By: Next.js` on a 404 would have meant the opposite.

- **2026-08-22** — **Renamed every Spanish identifier, route, and stored enum value to English, at the user's direction — and reversed this file's own convention to match.** The rule is now *everything a machine reads is English; everything a person reads is not*, with visitor-facing language confined to a new `src/i18n/`. The previous convention explicitly permitted Spanish enum values because they "mirror the shelter's own vocabulary"; that vocabulary is not lost, it moved — `shelter` renders as "refugio", `foster` as "hogar de tránsito". **The timing is the whole reason this was cheap: `PetStatus` and friends are STORED values, so renaming them is a data migration — and Firestore holds 0 documents in every collection, so there was nothing to migrate.** Doing this after the first real pet exists would have meant a backfill script plus a dual-read window. Four things worth keeping. (1) **The security layer needed no change at all**, which was checked rather than assumed: `firestore.rules` and `firestore.indexes.json` contain no enum values — rules gate on paths and auth, indexes on field *names*. The blast radius was `src/` alone. (2) **A mechanical token rename silently corrupted display copy.** Replacing the CSS class `muro` → `wall` also rewrote the Spanish sentence *"Mira el muro"* into *"Mira el wall"* in the homepage's step list — a token rename cannot tell a class name from a noun in prose. Caught by diffing every added line that was neither a `className` nor an `import`, which is the check to repeat next time, not the sed itself. (3) **The rename forced the i18n seam into existence rather than merely suggesting it.** `formatMeta()` rendered `pet.sex` raw, so the moment the value became `'male'` the Spanish UI would have read "male" — there was no choice but to build a label layer. `src/i18n/messages.ts` is an interface of *functions*, not tables, because Spanish inflects for gender ("pequeña"/"pequeño", "la gata"/"el gato") and English does not; a `Record<PetSize, string>` can express one language or the other but not both. (4) **Renaming public URLs without redirects is a defect**, so all six Spanish paths 308 to their English equivalents from `next.config.ts`, `/adopta/:slug` listed first because a bare `/adopta` rule does not carry the slug. Verified in a browser, not just compiled: all 6 English routes 200, all 6 legacy routes redirect, the renamed custom properties resolve (`--jade` `#31907a`, `--space-4`, `--shadow`, `--ease`), Fraunces still loads, and the `data-tema`→`data-theme` rename toggles light/dark with no console errors. One scare worth recording: after toggling, `getComputedStyle(document.body).backgroundColor` still reported the dark value while `--cream` reported the light one. That was **not** a broken cascade — `body` carries `transition: background 0.5s` and the tab was backgrounded and throttled, so the transition had stalled mid-flight. A no-transition probe element resolved the light cream immediately. **Computed style during a CSS transition is not the resolved value**, and in a background tab it can stay wrong indefinitely.

- **2026-08-23** — **PR #3 merged, deployed, and verified in production; and the `wawitas.org` diagnosis in this file turned out to be wrong.** The English rename shipped: CI green (47/47, 44s), CD green (2m24s), and the running Cloud Run image tag **equals `git rev-parse HEAD`** rather than merely being newer — checked, because "a deploy ran" and "the deploy that ran is this commit" are different claims. Live production behaviour was verified rather than inferred from a green pipeline: all six English routes return 200, all six legacy Spanish paths 308 with the slug preserved on `/adopta/:slug`, on both `wawitas.web.app` and the apex. **The more useful finding is that this file's `wawitas.org` runbook was actively misleading.** It offered exactly two branches — Firebase's 404 means *wait*, `X-Powered-By: Next.js` means *routing bug* — and escalation to Firebase after 24h. Reality was a third case neither branch covers: the domain is **fully provisioned** (`HOST_ACTIVE`, `OWNERSHIP_ACTIVE`, **`CERT_ACTIVE`**, `DNS_MATCH`, zero issues, confirmed independently by Terraform's own refresh recording `CERT_VALIDATING → CERT_ACTIVE` and dropping `required_dns_updates`), **every route serves 200**, and only the bare `/` returns 404 — a *stale Fastly cache entry* holding the "Site Not Found" page from the provisioning window. `X-Cache: HIT` across six different `cache-lim-*` (Lima) edge nodes, and the cache key includes the query string, which is why `/?cb=1` misses the cache and returns the real page while `/` does not. So the actionable fix is a cache invalidation, not a wait and not an escalation — and the diagnostic that separates them is `X-Cache`, which the old runbook never mentioned. Left unrun because it publishes to the live site. The lesson generalises past this incident: **"Firebase's own 404" was treated as a single condition when it is at least two**, and the one that mattered was distinguishable only by a header nobody had thought to look at. Also confirmed for the handover: Firestore is still **0 documents in every collection**, Email/Password auth is enabled with `authorizedDomains` already covering localhost, Cloud Run, both Firebase hosts and `wawitas.org`, and all six `NEXT_PUBLIC_FIREBASE_*` values are populated — so **step 3 (seed one pet) and step 2 (auth UI) are both fully unblocked**, and nothing is waiting on a human.

- **2026-08-23** — **Built the seeding tool and measured every constraint step 3 depends on — but deliberately did NOT seed a pet, so Firestore is still 0 documents.** The stop was the user's call and the reason is worth keeping: a real animal needs the *shelter's* name, breed, age and photograph, and `wawitas.org` is a live public adoption site, so a fabricated pet is outward-facing content on a real organisation's site — with a WhatsApp CTA pre-filled with the invented animal's name. The tool is `scripts/seed-pet.mjs` (`npm run seed:pet`), plus a self-describing `seed/EXAMPLE-pet.json`. **The constraint that killed the 2026-08-08 mock-data attempt is now measured rather than feared:** a generated JPEG was uploaded to `pets/_pipeline-check/cover.jpg` in `wawitas-app` and the resulting `firebasestorage.googleapis.com` URL fetched **unauthenticated — 200, `image/jpeg`, exact byte count** — then deleted, leaving the bucket at 0 objects. **Both URL forms work**, with a `?token=` download token and without one; the tokenless form works because `storage.rules` grants `allow read: if true` on `pets/{petId}/{fileName}`. So a named, Terraform-managed bucket needs no Firebase *default* bucket to serve public images, and `next.config.ts`'s single-host allowlist is satisfiable exactly as written. **The bigger result is the first proof that any security rule in this project enforces anything.** Same bucket, same Admin SDK upload, two paths: `pets/**` (public rule) returned **200** and `medical/**` (admin-only rule) returned **403**. Identical everything except the rule, which is what isolates the *rule* as the thing denying it rather than IAM or a bucket ACL. This file has said since 2026-08-12 that rules "compiled and released, which is not the same as being correct" — that still holds for **`firestore.rules`**, which remains unexercised, but `storage.rules` is now tested on both its allow *and* its deny branch. Three things about the seeder itself. (1) It **derives `coverPhoto` from the upload and refuses a hand-typed one**, because the 2026-08-08 failure was a URL on the wrong host and the fix is to make that URL unwritable by hand. It also rejects the pre-rename Spanish enum values (`adopcion`, `perro`, `hembra`), which is the live legacy trap now that stored values are English. (2) It **strips EXIF, and that is a privacy control rather than an optimisation** — a photo taken in a foster home carries GPS coordinates, so publishing it publishes a volunteer's home address. That is concern #2 arriving through the *image pipeline* instead of the location field, which is where this file had been watching for it. `seed/*` is gitignored except the template for the same reason: the seeder strips EXIF on **upload**, which is too late if the original was committed. (3) **A guard that silently disabled itself was caught before it shipped, and only because the check was checked.** The enum-drift guard reads the real `PetStatus`/`Species`/`PetSex`/`PetSize` out of `src/lib/types.ts` and compares them to the script's copies — but its `if (!theirs) continue` meant that if the parser ever stopped matching, it would skip every comparison and report success forever. Now it fails loudly instead, and both branches were verified by breaking them on purpose. **A false negative nearly caused the opposite mistake:** a throwaway `bash` heredoc test reported the guard was dead code, because a quoted heredoc mangled `[\\s\\S]` down to `[sS]` — the test was broken, not the script. Re-running it from a properly written file showed all four enums parsing correctly. **Escaping-sensitive code cannot be tested through a shell heredoc; write the probe to a file.** Verified at the end: typecheck clean, 47/47 tests, `pets`/`areas`/`users`/`adoptions` all still 0 documents, bucket back to 0 objects, and nothing published.

- **2026-08-23** — **Built email/password auth, and in doing so turned `firestore.rules` from "released" into "proven".** That second half is the headline: this file has carried the caveat since 2026-08-12 that the rules "compiled and released, which is not the same as being correct," and it is now retired. A **22/22 probe using the real client SDK** — not the Admin SDK, which bypasses rules entirely — checked both directions: signed out, `pets/{id}` reads and every subcollection is refused; signed in as an ordinary non-admin, non-owner account, `detail` and `medical` open while `identity`, `location`, `scans`, `areas` and `collectionGroup('placements')` stay shut; and the write branches refuse another user's document, a `role:'admin'` self-grant, an `email` self-edit, a self-delete, and a sighting created with `status: 'confirmed'`, while permitting exactly the `displayName` edit the rules intend. **The probe needed no pet documents at all** — Firestore evaluates rules *before* existence, so a denied path returns `permission-denied` and an allowed path returns an empty snapshot, which is the entire signal. That is why this could be done without fabricating a single animal, and it is the technique to reuse. **Three things were measured rather than assumed.** (1) **Email enumeration protection is really on.** Identity Platform returns a raw `INVALID_LOGIN_CREDENTIALS` for a wrong password *and* for an address with no account, and `sendPasswordResetEmail` **resolves successfully for an address that has no account** — verified by sending to one. So "te enviamos el enlace" would have been a false statement, and the conditional "si existe una cuenta con ese correo" is *required*, not merely tactful. Equally, the UI must never say "contraseña incorrecta": we are genuinely not told which half was wrong. (2) **The dynamic Firebase import works**, checked by reading each prerendered page's own script tags: `/`, `/adopt` and `/about` carry **no** firebase chunk in their initial scripts (634 KB raw) while `/account` does (1320 KB raw). Mounting `AuthProvider` in the root layout therefore costs the homepage — the page the whole primary objective runs through, read on mobile data — nothing at first paint. (3) **`users/{uid}` must be create-if-absent, never a blind write**, because the update rule permits only a `displayName`/`photoURL` diff; re-writing the whole document on each sign-in would be rejected the instant `createdAt` resolved to a fresh `serverTimestamp()`. **Two old traps recurred and were correctly *not* acted on.** The 2026-08-22 computed-style scare came back exactly as written: light mode reported near-white input text on near-white paper, which looks like a contrast bug and is not — `body` carries `transition: color 0.5s`, and the browser pane was not compositing, so the transition stalled indefinitely and `getComputedStyle` kept returning the dark value. Reading the tokens straight off `:root` with a transition-free probe element gave the true pairing (`#12463b` on `#ede5d6` light, `#efe9dc` on `#142320` dark). **A non-compositing tab does not just delay the resolved colour, it never arrives.** And the heredoc lesson repeated verbatim — writing the JSX through a `bash` heredoc died on quoting and produced no file at all, so the component was written with the file tool instead. Cleanup was verified rather than assumed: the probe account and its profile document were deleted, leaving **0 auth accounts and 0 documents in every collection**. Typecheck clean, 47/47 tests, build clean, 0 vulnerabilities in both trees. **Deliberately no new unit tests:** the only pure logic added is a Firebase-code→`AuthError` map whose correctness depends on strings the SDK owns, and a `Record<AuthError, string>` already makes a missing translation a compile error — a mocked test would assert my own assumptions back at me, which is weaker than the live run that was actually done.

- **2026-08-23** — **PR #6 merged, and following the deploy through found a production defect that had been latent since the project began: four routes were pinned in the CDN for a YEAR, and a deploy does not invalidate them.** The pipeline was green, and the running Cloud Run image tag **equalled `git rev-parse HEAD`** — yet `https://wawitas.web.app/account` still served the *old placeholder*, "El inicio de sesión con correo y Google está en construcción." The container was right; the edge was stale. **The distinguishing measurement is one request:** `/account` returns `X-Cache: HIT` with the old HTML, while `/account?cb=1` returns `X-Cache: MISS` and the new page from the origin — the Hosting cache key includes the query string. **Cause:** a fully-static App Router page makes Next.js send `Cache-Control: s-maxage=31536000`. On Vercel that is safe because a deployment purges the edge; **Firebase Hosting has no idea the Cloud Run revision behind its rewrite changed**, so it honours the year. Surveying every route made the split obvious: `/` and `/adopt` carry `export const revalidate = 300` and therefore send `s-maxage=300, stale-while-revalidate` — they self-heal — while `/about`, `/help`, `/lost` and `/account` had no `revalidate` and sent the year. **This is the 2026-08-12 homepage-`revalidate` defect again, in its second form.** That entry fixed `/` and stopped there, because a page whose content never changes cannot reveal that it is frozen. `/account` is simply **the first page in this project's history to change after being cached**, which is why four years-long entries sat undetected. Fixed by giving all four the same `revalidate = 300` the other two already had, and the fix was **measured from a real `next start` response header** (`s-maxage=300, stale-while-revalidate=31535700` on every route) rather than read off the build table. **Note what this does NOT explain:** the apex `/` 404. That one is Firebase's own "Site Not Found" page with **no `X-Powered-By`**, cached during the provisioning window — same family (a Hosting edge entry that a deploy does not purge) but a different cause, and `/` already had a correct 300s header throughout. Do not merge the two diagnoses. **The already-poisoned entries still need flushing** — the code fix only governs what gets cached from now on — and the documented way to do that is a fresh `firebase deploy --only hosting`, which publishes to the live site.

- **2026-08-23** — **Flushed the Hosting edge, and both the year-long cache defect and the apex 404 are gone. `wawitas.org` now serves completely.** Order mattered and was deliberate: the `revalidate` fix (PR #7) had to reach Cloud Run **before** the flush, because purging while the origin still sent `s-maxage=31536000` would simply have re-poisoned every entry for another year. So the sequence was — merge, wait for CD, confirm the deployed tag equals `git rev-parse HEAD`, **verify the origin's own header via `?cb=` on all six routes**, and only then `firebase deploy --only hosting`. Results, measured on both hosts rather than inferred: the stale "en construcción" placeholder is gone and `/account` serves the real auth page; every route returns 200 with `s-maxage=300, stale-while-revalidate`; all six legacy Spanish paths still 308 with the slug preserved. **The apex `/` returns 200 across five consecutive requests with `X-Cache: HIT`** — the cache now holds the correct page — carrying `X-Powered-By: Next.js`, `lang="es"`, the tagline and the WhatsApp link. **The flyers warning is lifted.** Two production-only facts were confirmed that no local check could establish. (1) **The `NEXT_PUBLIC_FIREBASE_*` Docker build args really do reach the bundle** — the API key, `authDomain` and `identitytoolkit` are all present in `/account`'s 11 chunks, so auth genuinely works in production and not merely on localhost. This check had been *inconclusive earlier in the day and looked like a failure*: it reported the config missing, but it was reading the **stale cached chunks** from the old build — a reminder that during a cache incident every derived measurement is suspect until the cache is cleared. (2) **The bundle split holds in production**: the homepage's 9 chunks contain no firebase. Also confirmed by API rather than by trusting this file: `authorizedDomains` covers all five hosts including `wawitas.org`, email/password is enabled, and **`enableImprovedEmailPrivacy` is `true`** — so the enumeration protection measured behaviourally earlier is confirmed at the config level too. ⚠️ **One handling note:** the `admin/v2/projects/wawitas/config` response embeds `signIn.hashConfig.signerKey`, the SCRYPT signer key for password hashes. Query that endpoint with a field filter; do not dump the whole document.

- **2026-08-23** — **Moved all seven GitHub Actions onto a Node 24 runtime, ahead of a deadline this project does not control.** Every run of both workflows was emitting *"Node.js 20 is deprecated ... being forced to run on Node.js 24"*, naming `actions/checkout@v4`, `actions/setup-node@v4`, `docker/build-push-action@v6`, `docker/login-action@v3`, `docker/setup-buildx-action@v3`, `google-github-actions/auth@v2` and `google-github-actions/setup-gcloud@v2`. **The fallback is GitHub's to withdraw, and when it goes the failure will name the actions rather than anything in this repo** — which is the whole reason it was worth doing before it became an outage. Bumped to `checkout@v7`, `setup-node@v7`, `build-push-action@v7`, `login-action@v4`, `setup-buildx-action@v4`, `auth@v3`, `setup-gcloud@v3` (PR #10). **Every target was verified by reading `runs.using` out of the action's own `action.yml` at the floating major tag the workflow actually resolves** — not from the marketplace listing, and not from memory, which for three of these was already out of date. That distinction matters more than it sounds: the workflows pin floating majors, so the tag is the thing that resolves at run time and the tag is therefore the thing to check; a latest-*release* being node24 does not prove the major tag points at it. All seven were `node24` and all were stable releases, no prereleases. **`checkout` and `setup-node` each jump three majors, so the intervening releases were read rather than skipped**, and the only removals that touch this repo's surface are ones it does not use: `auth` v3 drops `retries`/`backoff`/`backoff_limit`, `setup-gcloud` v3 drops `skip_tool_cache`, `build-push-action` v7 drops two `DOCKER_BUILD_*` envs, `setup-buildx-action` v4 drops deprecated inputs we pass none of. Two near-misses that were checked instead of assumed: **`setup-node` v5 added automatic caching keyed off a `packageManager` field** in `package.json` and v6 narrowed it to npm — moot here only because `package.json` declares no `packageManager` *and* `ci.yml` sets `cache: npm` explicitly; and **`checkout` v7 blocks checking out fork PRs**, but only for `pull_request_target` and `workflow_run`, while `ci.yml` triggers on plain `pull_request`. **The one bump with real blast radius was `auth` v2 → v3, because it sits on the WIF exchange**, and it was confirmed live rather than by reading the changelog: the `Authenticate to Google Cloud` step completed and `steps.auth.outputs.access_token` still populated, proven by the `Log in to Artifact Registry` step immediately after succeeding on it — that step is the read-through, and it is what would have failed first had the output been dropped. Still keyless, no service-account key, `terraform/cicd.tf` untouched. **The verification got an accidental control group.** PR #9 merged 40 seconds ahead of PR #10 and still carried the old versions, so two deploy runs went back to back on the same workflow in the same repo: the older logged **2** deprecation warnings (one per job — the reusable `ci` job names two actions, the `deploy` job names six), the newer logged **0**, with zero annotations on both jobs and no `##[warning]` line of any kind. Same probe, before and after, which is the only thing that makes a zero mean anything. **A broken probe nearly produced a false positive, and it is the same class of error this file has recorded twice already.** The first grep reported the warning was *still present* in the new run; it was not. The pipeline was `grep ... | sort -u && echo PRESENT || echo OK`, and a pipeline's exit status is the **last** command's — `sort -u` succeeds on empty input, so the `&&` branch fired on nothing. The replacement counts matches into a variable, compares old against new, and prints the pattern's hits on the old run to demonstrate the pattern works before a zero is allowed to mean absence. **`grep` in a pipeline does not gate anything; only its own exit status does.** Production checked rather than inferred from a green pipeline: the deploy's own verify step passed the image-tag assertion and got `attempt 1: HTTP 200`, the run's `headSha` equals `origin/main` so the **deployed tag still equals `git rev-parse HEAD`**, and both `wawitas.org` and `wawitas.web.app` return 200. **Explicitly not touched:** the machine's local Node 20.20.2 and `ci.yml`'s `node-version: 22`, which matches the Dockerfile — `node24` here is the *runner's* runtime for the action wrappers and has nothing to do with the runtime the app ships on. Nothing about `paths-ignore`, the `continue-on-error` audit step, or the Cloud Run env list changed; the whole diff is eight `uses:` lines.

- **2026-08-23** — **Built the admin intake wizard, and running it end to end found a Spanish grammar bug that had been live and unseeable since the rename.** Build-order step 5: `/admin` and `/admin/intake`, steps 1–3 manual, plus `scripts/grant-admin.mjs` for the claim the whole thing rests on. **The claim had to come first and could not come from inside the app**: `firestore.rules` and `storage.rules` gate every write on `request.auth.token.admin`, only the Admin SDK can set it, and a self-service bootstrap route would be a self-service privilege-escalation route. Two traps went into that script rather than into a comment: `setCustomUserClaims()` **replaces** the claims object rather than merging — the same shape as this project's `fieldOverrides` lesson — so existing claims are spread, and revoking **deletes** the key instead of writing `admin: false`, which would read as a grant in every audit. **The grammar bug is the entry's real headline.** `t.pastParticiple()` took a stem, and two of its three values were the *verb root* rather than the participle stem: `'identific'` and `'conoc'` rendered "Está **identifica** con microchip" and "Antes **conoca** como" — non-words, on the pet dossier, in the site's only language. It survived because **the dossier has never once rendered with a pet in it**, which is this project's most-repeated failure shape arriving in a new place: not a broken query this time, but broken *prose* that no test could catch and no reviewer would see. Fixed to `'identificad'`/`'conocid'`, and the union in `messages.ts` now carries the reason. **The verification was the point, and it was done against live Firestore rather than reasoned about.** An 11/11 client-SDK probe walked one probe account through *no claim → granted → revoked*: `petDrafts` read, list and write all denied without the claim, `pets` and `pets/{id}/identity` writes denied too, everything allowed after a forced token refresh, and denied again after revoke. Then the wizard itself was driven in a browser: `Ñoño Prueba` derived the slug `nono-prueba` (**the accent handling works in a real browser, not just in the 34 new unit tests**), a 999-prefix chip surfaced the correct Spanish test-transponder message from the validator that already had 10 tests, a valid `068…` code was accepted, a 2400×3000 JPEG was uploaded and came back **1280×1600** — the long edge capped exactly — and publish produced the tier split intact: `pets/{id}` carrying `hasMicrochip: true` and **no chip number anywhere in it**, `detail/main`, one `media` doc at `tier: 'public'`, and `identity/microchip` with the code stored as a **string whose leading zero survived** (`prefix: "068"`). `ageMonths` came out 14 from "1 año 2 meses". The draft was deleted by the same batch, so a half-published animal is not a state that exists. **Two claims were measured rather than asserted.** (1) **EXIF stripping is real**: the uploaded object was downloaded and its JPEG marker segments walked — `FFE0 FFE2 FFDB FFDB FFC0 FFC4×4 FFDA`, no APP1, and no `Exif`, `GPS` or XMP bytes anywhere. That is concern #2 closed through the image pipeline, and it is a privacy control rather than an optimisation: a foster-home photo carries the volunteer's address. (2) **The custom-claim token lag is real**: immediately after the grant the *cached* ID token did **not** carry `admin`, and only `getIdTokenResult(true)` surfaced it. That is why `AuthProvider` reads the cached token (so the homepage pays no round-trip) while `AdminGate` forces a refresh on mount (so a just-promoted admin gets in without signing out) — a split that would look like pointless complexity to anyone who had not seen the measurement. **Nothing fabricated was left behind, and that was verified rather than assumed:** the probe pet was published with `status: 'shelter'`, never `'available'`, so it could not reach the wall — confirmed by loading `/adopt` and getting the empty state **while the document existed**, which is the first time the wall's allowlist has been exercised against real data. Afterwards everything was deleted, including subcollections (Firestore does not cascade, and an orphan still answers a `collectionGroup` query), and the readback shows **0 documents in every collection, 0 in every collection group, 0 bucket objects, 0 auth accounts**. **Three smaller things worth keeping.** The working tree is **CRLF** (`core.autocrlf=true`), so every LF needle in an edit script silently matches nothing and reads as "the rule moved" — normalise, edit, restore. The file-editing tool **round-trips `\uf8ff` and combining marks back into literal invisible characters**, so `slugify`'s diacritic range and the slug prefix-query bound had to be written through a Node script to stay as escapes; an invisible character in a regex is undebuggable. And the heredoc lesson repeated a third time — the first two attempts at these fixes were mangled by shell quoting before the probe was written to a file and run from there. **Step 3 is still not done: Firestore holds 0 pets.** That is unchanged and still needs the shelter's own animal — but it is now a form someone fills in, not a JSON file someone writes.

- **2026-08-23** — **Bug-fix pass over the intake wizard, and the most valuable find was a three-week-old hole in `storage.rules` that no code had ever been able to trip.** Five defects, four of them found by *clicking things* rather than by reading. (1) **An admin could upload a pet photo and never delete one.** `pets/{petId}/{fileName}` carried a single `allow write`, which covers create, update **and delete** — and its condition called `isImage()`, which dereferences `request.resource.contentType`. On a delete `request.resource` is **null**, so the rule threw and denied. Every admin, every photo, since 2026-08-02. It went unseen because **nothing in the project had ever attempted a delete**; the wizard's "Quitar" button was the first, and it failed silently behind a best-effort handler. Confirmed with a client-SDK probe (`storage/unauthorized` while signed in *with* the claim), fixed by splitting `create, update` from `delete`, redeployed, and re-verified — and then checked in the other direction, because a fix to a deny rule is exactly where a hole gets opened: unauthenticated **and** signed-in-without-claim are still refused both delete and upload. `sightings` and `medical` were already correct, and `firestore.rules` never dereferences `request.resource` on a delete path, so `pets` was the only one. **The general rule now recorded: `allow write` includes delete, and any condition that inspects the payload will deny it.** (2) **"Registrar otro" was a dead button.** It was a `<Link href="/admin/intake">` on a success screen that already lives at `/admin/intake`, so Next matched the same segment, kept the component mounted, and `published` pinned the screen — the shelter could not register a second animal without manually navigating away. A reset is a button that clears state, not a link to where you already are. (3) **A disambiguated slug was silently different from what was typed.** Publishing a second Luna produced `luna-prueba-2` and said nothing; the success screen now shows the final URL and explains the change, which is also why `slug-taken` was **removed** from `IntakeError` rather than wired up — a collision is normal, not an error to block on. (4) **Discarding a draft, or removing a photo, orphaned the Storage object** with no sweep job to ever collect it; both now delete best-effort at the one moment the path is still known. (5) **An unreadable image reported "revisa tu conexión"** — `accept="image/*"` lets a phone offer HEIC, which Chrome cannot decode, so `PhotoUnreadableError` now says what actually happened and what to do. Verified after: 81/81, typecheck and build clean, 0 vulnerabilities in both trees, and Firestore/Storage/Auth all read back at **0** again.

---

## Next session — start here

**Last session: 2026-08-23. The ADMIN INTAKE UI is BUILT and verified end to
end in a browser — `/admin` and `/admin/intake`, build-order step 5. A pet was
entered, photographed, published, checked, and deleted. Firestore is back to 0
documents and 0 auth accounts.**

**Two things changed about what "next" means.** Step 3 no longer needs anyone
to hand-write JSON: the shelter can enter their own animal through a form. And
the admin claim now exists as a one-command bootstrap:

```bash
npm run grant:admin -- someone@example.com
```

That account must **sign up first** at `/account` — a claim attaches to an
account. `GOOGLE_CLOUD_PROJECT=wawitas` must be set. `--list` shows every
admin, `--revoke` removes one. **Right now there are 0 admins and 0 accounts**,
so the first real action is: the shelter signs up, then gets granted.

⚠️ **A fresh grant is invisible to an already-signed-in browser for up to an
hour** — custom claims are baked into the ID token at issue time. This is
measured, not folklore. `AdminGate` forces `getIdTokenResult(true)` on mount
precisely to paper over it; if someone still cannot get in, have them sign out
and back in before suspecting the grant failed.

**Step 3 is still NOT done: Firestore is still 0 documents, because it needs
the shelter's own animal and photograph, not a technical fix.**

**The next task is still step 3: put one real pet in Firestore — and the only
thing missing is the shelter's own data.** No code is needed. Run:

```bash
npm run seed:pet -- seed/luna.json
```

**https://wawitas.org** and **https://wawitas.web.app** both serve. The Cloud
Run URL (`https://pet-shelter-web-production-poz3ad3gaa-ue.a.run.app`) is the
origin behind them.

Every ✅ below was *executed*, not inferred. `firestore.rules` is deployed but
has **never been enforced against a client**, because no client can reach
Firestore yet. **`storage.rules` is now the exception** — it was exercised on
both its allow and its deny branch on 2026-08-23, and it works.

### ▶ Do this next — step 3: seed one real pet

**Why this and not auth:** the wall, the dossier, `pets-server.ts`, the
Firestore query, the composite index, Cloud Run and Hosting are all live and
proven — and **not one of them has ever run with an animal in it.**
`pets-server.ts` → `AdoptionWall.tsx` → rendered HTML is the project's primary
objective end to end, and it is the only link never exercised.

**What is already done** (2026-08-23), so do not redo it:

- `scripts/seed-pet.mjs` — validates the document, strips EXIF, uploads the
  photo, and **derives `coverPhoto` from the upload**. Tested: it rejects the
  legacy Spanish enums, a hand-typed `coverPhoto`, a non-kebab slug, a missing
  `formerNames`, and a non-boolean `hasMicrochip`. `--dry-run` and `--delete`
  both work. Idempotent by `slug`, so re-running corrects rather than duplicates
- `seed/EXAMPLE-pet.json` — the template, with every constraint explained
  inline. `seed/*` is gitignored except that file
- The image-host constraint is **measured, not assumed**: a
  `firebasestorage.googleapis.com` URL for `wawitas-app` serves 200
  unauthenticated, with or without a `?token=`. See the log entry

**What is missing is not technical.** It is one animal's real details and one
real photograph, which only the shelter has:

| Needed | Notes |
|---|---|
| `name`, `breed` | "mestizo" / "mestiza" is an honest answer for a street rescue |
| `sex` | drives Spanish gender agreement everywhere — never decorative |
| `size`, `ageMonths` | `ageMonths` may be `null` if genuinely unknown |
| `hasMicrochip` | boolean only. The **number** never goes in this document |
| a photo | any local image file; the seeder resizes and strips EXIF |

**Do not invent a pet to make the wall look populated.** `wawitas.org` is a
live public adoption site and the dossier's CTA opens WhatsApp pre-filled with
the animal's name — a fabricated animal sends a stranger to message the shelter
about a dog that does not exist. This is also why **mock/fallback data must not
go in `pets-server.ts`**: that was tried on 2026-08-08, collided with the
image-host rule, and was reverted.

Once seeded, confirm it renders **in production**, not just locally. The
homepage is ISR at 300s, so allow one revalidation window.

### ✅ The English rename — done 2026-08-23, PR #3

**The convention is now: everything a machine reads is English; everything a
person reads is not.** This reversed what this file used to say. If you are
reading an older note that permits Spanish enum values, it is stale.

- Routes: `/adopt`, `/help`, `/about`, `/lost`, `/account` (+ `/adopt/[slug]`)
- The six legacy Spanish paths **308 redirect** from `next.config.ts`. They
  were live on both hosts; drop them only when logs show no traffic
- Components: `AdoptionWall` (was `Muro`), `PetPoster` (was `Cartel`), `Brand`,
  `ThemeToggle`. CSS: `.wall`, `.poster`, `.container`, `.dossier`, `.hero`,
  `--space-N`, `--cream`, `--shadow`, `--ease`. `data-theme` = `light`/`dark`
- **Stored enum values changed**: `available` (was `adopcion`), `foster` (was
  `transito`), `shelter` (was `refugio`), `inbound` (was `en-camino`), plus
  `Species`, `PetSex`, `PetSize`, `MedicalRecordKind`, `FeedingUnit`,
  `AreaKind`, `PlacementReason`, `MuscleCondition`
- **All visitor-facing language lives in `src/i18n/`.** Every identifier there
  is English, every value is Spanish. `Messages` is an interface of
  *functions*, not tables, because Spanish inflects for gender and English does
  not. Adding a locale = one file + one line in `index.ts`

**The one thing that made this free was timing:** enum values are *stored
data*, and Firestore holds 0 documents. It is still 0. **Any further renames
are cheapest right now and get monotonically more expensive the moment step 3
lands.** If anything else is misnamed, say so before seeding a pet.

**Known gap, deliberately deferred:** page-level JSX copy is still inline in
the route files. Moving it into `src/i18n` — and adding `/[locale]/…` route
segments — is what makes a second language real. Not started.

### ✅ wawitas.org — FULLY SERVING, apex included. Resolved 2026-08-23

**The bare apex `/` returns 200.** It had returned 404 since the domain was
provisioned. Resolved by running `firebase deploy --only hosting`, which
publishes a new Hosting release and purges the edge — confirmed by five
consecutive requests returning `200` with `X-Cache: HIT` (the cache now holds
the *correct* page) and `X-Powered-By: Next.js`, serving `lang="es"`, the
tagline, and the WhatsApp link.

Every route on **both** hosts returns 200 with
`s-maxage=300, stale-while-revalidate`, and all six legacy Spanish paths still
308 with the slug preserved.

**`wawitas.org` is safe to put on flyers, the Instagram bio, and the WhatsApp
profile.** The warning this file carried since 2026-08-22 is lifted.

**Keep the diagnostic — the two 404s are still different things:**

```bash
curl -sSI https://wawitas.org | grep -i -E '^(HTTP|x-cache|x-powered-by)'
```

- **404, `X-Cache: HIT`, no `X-Powered-By`** → Firebase's own "Site Not Found"
  held at the edge. A Hosting release purges it. Not a wait, not an escalation.
- **404 with `X-Powered-By: Next.js`** → the request reached our app and *our*
  app 404'd. A routing bug, completely different. Do not conflate them.

**Note what the apex 404 was NOT:** it was not the year-long `s-maxage` defect
fixed in PR #7. `/` always carried `revalidate = 300`. Same family — a Hosting
edge entry that a Cloud Run deploy does not purge — but a different cause.

### ✅ Step 2 — email/password auth. DONE 2026-08-23

Built and **exercised in a browser**, not just compiled: sign up, sign in,
sign out, password reset, email verification with resend, and session
persistence across a hard reload.

| File | Role |
|---|---|
| `src/lib/auth.ts` | every Firebase call, plus the `AuthError` union |
| `src/components/AuthProvider.tsx` | `onAuthStateChanged`, mounted in the root layout |
| `src/app/account/AccountPanel.tsx` | the form — sign in / sign up / reset |
| `src/components/AccountLink.tsx` | the header button, auth-aware |

Four things worth knowing before touching it:

- **Firebase is imported dynamically** inside `AuthProvider`'s effect, on
  purpose. Measured: `/`, `/adopt` and `/about` carry **no** firebase chunk in
  their initial scripts; `/account` does. A static import in the root layout
  would put the Web SDK on the homepage. **Do not "simplify" it.**
- **Never name which half of a bad login was wrong.** Identity Platform's
  email enumeration protection collapses wrong-password and no-such-account
  into one `INVALID_LOGIN_CREDENTIALS`. Same reason password reset says *"si
  existe una cuenta"* — it resolves for unknown addresses, measured.
- **`users/{uid}` is create-if-absent.** The rules allow an update to touch
  only `displayName`/`photoURL`, so a blind re-write is rejected the moment
  `createdAt` resolves to a fresh `serverTimestamp()`.
- Auth failure text lives in `src/i18n`, reached through `t.authError()`.
  `src/lib/auth.ts` carries no Spanish, by the same rule as `microchipError`.

**Google as a provider still needs an OAuth consent screen** (a console task,
still on the "later, not now" list). Email/Password is enough for everything
currently designed.

### ✅ `firestore.rules` is PROVEN ENFORCING — 2026-08-23

This file said from 2026-08-12 to 2026-08-23 that the rules "compiled and
released, which is not the same as being correct." **That caveat is retired.**
A 22/22 probe with the real client SDK covered both branches:

| Signed out | Signed in (ordinary account) |
|---|---|
| `pets/{id}` ✅ read | `detail`, `medical` ✅ read |
| `detail`, `identity`, `location` ❌ | `identity`, `location`, `scans` ❌ |
| write `pets/{id}` ❌ | `areas`, `collectionGroup(placements)` ❌ |
| `areas` ❌ | another user's `users/{uid}` ❌ read and write |
|  | `role:'admin'` self-grant ❌ · `email` self-edit ❌ |
|  | `displayName` edit ✅ · self-delete ❌ |
|  | undeclared collection ❌ · self-confirmed sighting ❌ |

**The technique matters more than the result: it needed no pet documents.**
Firestore evaluates rules *before* existence, so a denied path throws
`permission-denied` and an allowed path returns an empty snapshot — that
difference is the whole signal. Reuse this rather than seeding fixtures.


### ✅ THE FIREBASE BLOCKER IS GONE — 2026-08-16

**Firebase is on the project, the web app is registered, the four
`NEXT_PUBLIC_*` values are in `.env.local`, and `storage.rules` is deployed.**
Five days of "blocked on Storage" is over.

**The one remaining human action is the Google sign-in provider.** Email/Password
is enabled; Google needs an OAuth consent screen, which is a console task and
was already on this file's "later, not now" list. Email/Password alone is enough
to build and test step 2.

**Two corrections this session earned, both worth keeping:**

1. **`firebase deploy --only storage` will never work on this project**, and the
   Firebase project was *not* the reason. It checks for a Firebase **default**
   bucket — the one the console's "Get Started" button creates — and we
   deliberately use a named, Terraform-managed bucket. Adding the Firebase
   project did not change that error by one character. Setting `storage.bucket`
   in `firebase.json` does not satisfy it either.

   **Use `npm run deploy:storage-rules`.** It does what the CLI does underneath
   — create a ruleset, then release it under a name that encodes the bucket
   (`firebase.storage/wawitas-app`) — and the API has no default-bucket
   precondition at all. The CLI is simply stricter than the service.

2. **The Firebase console can now delete the GCP project.** "Deleting a Firebase
   project deletes the Google Cloud project too, and all contained resources."
   That is new blast radius: one button now reaches all 41 Terraform-managed
   resources *and* Firestore, including the PITR window and backup schedules,
   since those live inside the thing being deleted.

**Why the original gap went unnoticed for four days, which is the transferable
part:** several Firebase-branded things work fine *without* a Firebase project.
`firestore.rules` and the indexes deploy via `firebaserules.googleapis.com`;
`google_firebase_storage_bucket` applies via `firebasestorage.googleapis.com`.
Both are plain GCP APIs. **"The Firebase CLI deployed something successfully"
was never evidence that the Firebase project existed.**

### 📋 There is now a written build plan. Read it before starting.

**[`docs/PLAN-intake-and-syndication.md`](docs/PLAN-intake-and-syndication.md)**
— written 2026-08-16, covering the arrival pipeline and shelter areas, the admin
intake flow, Gemini card parsing and veterinary voice dictation, adoption, QR
identity tags, and food management. **Its §0.1 is a concrete first-session
checklist** and §9 is the 14-step build order.

Nothing in it is built. It is a plan, and per this file's own most-repeated
lesson, **a plan that reads well is not a plan that works.**

Two supporting documents:

- [`docs/veterinary-records-standards.md`](docs/veterinary-records-standards.md)
  — the standards research. §6 answers "we are in Bolivia, what should we
  follow?" **Also corrects a stale citation in `rfid-microchips.md`:** EU
  576/2013 was superseded by Reg. (EU) 2026/131 on 22 April 2026.
- [`docs/gemini-api-playbook.md`](docs/gemini-api-playbook.md) — **read before
  writing any AI code.** All LLM work is Gemini via **AI Studio**, never Vertex.

The four-item list further down this section is superseded by that plan's build
order. It is kept because its constraints and warnings are still accurate.

### Verified state, as of 2026-08-23

| Check | Command | Result |
|---|---|---|
| **Live site** | `GET /` | ✅ **HTTP 200**, correct Spanish copy, wall shows its empty state from a live query |
| **Live site** | `GET /adopt` | ✅ HTTP 200, empty state correct |
| Container image | GitHub Actions `docker buildx` | ✅ **built + pushed**, tag = commit SHA. `gcloud builds submit` was the bootstrap path and is now the fallback, not the norm |
| Infra | `terraform apply` | ✅ **40 resources live**, GCS backend |
| Infra | `terraform plan` | 🟡 one **known-benign** diff on `cloud_run` `scaling` — see `cloud_run.tf`. Anything else is real |
| **CI** | GitHub Actions, PR #10 | ✅ typecheck + **47/47** tests + build + **0 vulnerabilities**, 38s |
| **CD** | GitHub Actions, push to `main` | ✅ **built, pushed, deployed, verified 200** — keyless via WIF. Last run 1m26s on the PR #10 merge |
| **Actions on Node 24** | `gh run view --log`, old run vs new | ✅ **PROVEN 2026-08-23** — PR #9's deploy (old versions) logged **2** `Node.js 20 is deprecated` warnings, PR #10's logged **0**, 40s apart on the same workflow. Zero annotations on both jobs. The zero only means something because the same pattern hits twice on the old run |
| **WIF survives `auth@v3`** | the deploy run itself | ✅ `Authenticate to Google Cloud` completed and `steps.auth.outputs.access_token` still populated — proven by the Artifact Registry login succeeding on it, which is the step that fails first if the output is dropped |
| **CD ↔ Terraform** | `terraform plan` after a CI deploy | ✅ **does NOT roll the image back** — `ignore_changes` proven, not assumed |
| Firestore | live query via Admin SDK | ✅ connects, returns 0 docs |
| GCP project | `gcloud projects describe wawitas` | ✅ `ACTIVE`, `us-east1`, **no org parent** |
| Billing | `gcloud billing projects describe wawitas` | ✅ `billingEnabled: true` — trial expires ~2026-11-10 |
| ADC | `google-auth-library` probe | ✅ resolves `wawitas` with no `.env.local` help |
| Build | `npm run build` | ✅ **8 routes, run locally 2026-08-23** after the English rename |
| Tests | `npm test` | ✅ **81/81** — 10 microchip, 23 placement/outbreak, 14 arrival state machine, **34 intake** (slug/accents, age, per-step validation, publish gate) |
| Typecheck | `npm run typecheck` | ✅ clean |
| **Outbreak trace** | seeded fixtures → live `collectionGroup` query → asserted → deleted | ✅ **PROVEN AGAINST LIVE FIRESTORE**, not just deployed. Contacts, ordering, area isolation, window clipping and occupancy all returned hand-computed answers |
| Terraform | `terraform plan` after this session | ✅ 2 to add (both Firebase), **1 to change = the documented benign `cloud_run` `scaling` diff and nothing else** |
| Dependencies | `npm audit --omit=dev` | ✅ 0 vulnerabilities |
| **Firestore rules ENFORCEMENT** | client-SDK probe, signed out **and** signed in | ✅ **PROVEN 2026-08-23 — 22/22.** Public tier reads, auth tier reads, restricted-tier denials, admin-only denials, collection-group denial, cross-user write denial, `role:'admin'` self-grant denial, `email` self-edit denial, `displayName` edit allowed, default-deny, and a self-confirmed sighting rejected. **Needed zero pet documents** — rules are evaluated before existence |
| **Indexes** | `gcloud firestore indexes composite list` | ✅ **10 composite + 1 field override** |
| Storage rules | `firebase deploy --only storage` | ❌ blocked on a Firebase default bucket; bucket is private regardless — use `npm run deploy:storage-rules` |
| **Storage rules ENFORCEMENT** | unauthenticated `curl` of two paths in `wawitas-app` | ✅ **PROVEN 2026-08-23** — `pets/**` → **200**, `medical/**` → **403**. Same bucket, same Admin SDK upload, so the *rule* is what differs. The first security rule in this project shown to enforce anything |
| **Auth flows end to end** | browser, real Firebase | ✅ **2026-08-23** — sign up, sign in, sign out, password reset, verification resend, and a hard reload that restores the session |
| **Auth error mapping** | deliberate bad logins in the browser | ✅ wrong credentials and a 3-char password both surfaced the correct **Spanish** message, from a real Firebase refusal |
| **Enumeration protection** | raw Identity Toolkit call | ✅ **measured** — `INVALID_LOGIN_CREDENTIALS`; and `sendPasswordResetEmail` resolves for an address with **no account** |
| **Firebase kept off the homepage** | prerendered script tags per route | ✅ **measured** — `/` `/adopt` `/about` carry no firebase chunk (634 KB raw); `/account` does (1320 KB raw) |
| **Cleanup after probing** | Admin SDK | ✅ **0 auth accounts, 0 documents** in `users`, `pets`, `areas`, `adoptions` |
| **Public image URL** | unauthenticated `curl` of a `firebasestorage.googleapis.com` URL | ✅ **200, `image/jpeg`, exact bytes** — with **and** without a `?token=`. Resolves the constraint that killed the 2026-08-08 mock-data attempt. Probe objects deleted; bucket back to 0 |
| **Firebase Hosting** | `firebase deploy --only hosting` | ✅ **released 2026-08-22** — `sites/wawitas/releases/1787431703816000`, FINALIZED. First release in the project's life |
| **wawitas.web.app** | `GET /` | ✅ **HTTP 200 with real Spanish HTML** — `lang="es"`, the tagline, the WhatsApp link. `X-Powered-By: Next.js` proves the rewrite reaches Cloud Run rather than serving a static file |
| **`/_next/static` cache header** | `curl -I` on a real chunk | ✅ `public, max-age=31536000, immutable` — the specific rule wins over the `woff2` rule. **Measured, not inferred from ordering** |
| **DNS for wawitas.org** | `nslookup` against `launch1.spaceship.net` | ✅ all 4 records authoritative; apex resolves **only** to `199.36.158.100` (parking IPs displaced) |
| **Certificate** | `openssl s_client` | ✅ `CN=wawitas.org`, Google Trust Services, valid to 2026-11-20 |
| **Custom domain gates** | Hosting API | ✅ **2026-08-23: `HOST_ACTIVE` + `OWNERSHIP_ACTIVE` + `CERT_ACTIVE` + `DNS_MATCH`, zero issues** on apex and `www` |
| **wawitas.org routes** | `GET /adopt`, `GET /?cb=1` | ✅ **HTTP 200** — the domain serves |
| **wawitas.org bare `/`** | `GET /` | ✅ **200 — RESOLVED 2026-08-23** by `firebase deploy --only hosting`. Five consecutive requests, `X-Cache: HIT` on the *correct* page, `X-Powered-By: Next.js`, real Spanish HTML. Safe for flyers |
| **HTML cache headers** | `curl -I` every route, both hosts | ✅ **`s-maxage=300, stale-while-revalidate`** everywhere. Was `s-maxage=31536000` (one year) on `/about` `/help` `/lost` `/account` until PR #7 |
| **Prod Firebase config** | fetch `/account`'s 11 chunks and grep | ✅ **API key + `authDomain` + `identitytoolkit` all baked in** — the Docker build args reach the bundle, so auth works in production |
| **Prod bundle split** | fetch the homepage's 9 chunks and grep | ✅ **no firebase on the homepage** — the `AuthProvider` dynamic import holds in production, not just locally |
| **authorizedDomains** | Identity Toolkit admin API | ✅ all five hosts incl. `wawitas.org`; email/password on; **`enableImprovedEmailPrivacy: true`** |
| **English routes** | `GET /adopt /help /about /lost /account` | ✅ **all 200 in production**, 2026-08-23 |
| **Legacy redirects** | `GET /adopta /ayuda /nosotros /perdidos /cuenta` | ✅ **all 308**, slug preserved on `/adopta/:slug` |
| **Deployed image ↔ HEAD** | `gcloud run services describe` | ✅ tag `8abe308c` **equals `git rev-parse HEAD`** |
| **Firebase Auth** | Identity Toolkit admin API | ✅ Email/Password **enabled**; `authorizedDomains` covers localhost, Cloud Run, both Firebase hosts and `wawitas.org` |
| **Client config** | `.env.local` | ✅ all six `NEXT_PUBLIC_FIREBASE_*` **populated**. Maps + App Check keys still empty (not needed yet) |
| **Pet seeder** | `npm run seed:pet -- <file> --dry-run` | ✅ **validated 2026-08-23** — rejects legacy Spanish enums, hand-typed `coverPhoto`, bad slug, missing `formerNames`, non-boolean `hasMicrochip`. Enum-drift guard fires on both drift *and* a broken parser |
| **Admin intake, end to end** | browser: enter → upload → publish → render → delete | ✅ **PROVEN 2026-08-23.** `Ñoño Prueba` → slug `nono-prueba`, 2400×3000 JPEG → **1280×1600**, tier split intact, `ageMonths` 14 from "1 año 2 meses", draft deleted by the same batch. Then removed; **0 documents, 0 objects, 0 accounts** on readback |
| **`petDrafts` rules ENFORCEMENT** | client-SDK probe: no claim → granted → revoked | ✅ **11/11** — reads, lists and writes denied without the claim, allowed after a forced token refresh, denied again after revoke |
| **Custom-claim token lag** | cached vs forced `getIdTokenResult` | ✅ **MEASURED** — right after the grant the cached token did **not** carry `admin`; only `getIdTokenResult(true)` surfaced it. This is why `AdminGate` forces a refresh and `AuthProvider` does not |
| **Browser EXIF stripping** | download the uploaded object, walk its JPEG segments | ✅ `FFE0 FFE2 FFDB FFDB FFC0 FFC4×4 FFDA` — **no APP1**, no `Exif`, no `GPS`, no XMP. A canvas re-encode cannot carry metadata through |
| **Wall allowlist vs real data** | `GET /adopt` while a `shelter`-status pet existed | ✅ empty state — `getWall()` filters `status == 'available'`, exercised for the first time against an actual document |
| **Admin CAN delete a pet photo** | client SDK, signed in with the claim | ✅ **FIXED + PROVEN 2026-08-23.** Was `storage/unauthorized` for every admin because `allow write` covers delete and `isImage()` dereferences a null `request.resource`. Split into `create, update` / `delete` |
| **Non-admins still cannot** | unauthenticated, and signed-in-without-claim | ✅ delete **and** upload both denied on `pets/**` — the delete fix did not widen anything |
| **"Registrar otro" resets** | browser: publish → click → form is blank | ✅ **FIXED.** Was a `<Link>` to the route it was already on, so the component never remounted and the success screen never cleared — a second animal could not be registered without navigating away |
| **Slug collision is surfaced** | publish three pets called Luna | ✅ `luna-prueba` → `-2` → `-3`, and the success screen now names the final URL and says why it changed |
| **Stale `?draft=` id** | open `/admin/intake?draft=doesNotExist` | ✅ says so, starts a fresh draft, and strips the dead query so a reload does not mint another id |
| **Deployed ruleset ↔ file** | Rules API readback, diffed in Node | ✅ **byte-identical** (16230 bytes), `petDrafts` rule present |
| Real data | any pet document | ❌ **none exists — `pets`, `areas`, `users`, `adoptions` all 0 docs.** Still the next task, and it needs the **shelter's** animal + photo — but it is now a form, not a JSON file |

Still not covered by any green check: server-side validation at apply (retention
bounds, immutable locations) and `docker build`. Org policy has dropped off this
list entirely — the personal project has no org parent, so there is none.

### ⚠️ Read before running anything locally

**Decided 2026-08-08: this project uses real Firestore. The emulator suite is
not used.** It cannot start on this machine anyway — `firebase emulators:start`
dies with "Could not spawn `java -version`" and no JRE/JDK is installed — and a
second source of truth for rules and composite-index behaviour is not wanted.
`FIRESTORE_EMULATOR_HOST` should not appear in any config.

That removes the old safety net, so the credential situation has to be handled
directly. `gcloud` CLI auth and **Application Default Credentials are separate**,
they expire independently, and `firebase-admin` and Terraform consult **ADC
only**.

### ⚠️ Two Google identities share this machine

This is the thing to understand before running anything:

| Project | Google account |
|---|---|
| `wawitas` (this project) | `israel.rocha.clarke@gmail.com` — personal, free trial |
| `trustcert-ai-g` (work) | `israel.rocha@trustcertllc.com` — employer |

**There is exactly one ADC file per Windows profile**
(`%APPDATA%\gcloud\application_default_credentials.json`). It cannot hold both
accounts. `gcloud auth application-default login` does not create a per-project
credential — it *replaces* that single file.

**The user chose manual switching over per-project config directories**
(2026-08-12), having been shown both. `CLOUDSDK_CONFIG` pointed at separate
directories would isolate account, project, and ADC per project — and it is
honoured by `google-auth-library` (verified in
`node_modules/google-auth-library/build/src/util.js`) — but it is *not* read by
Terraform's Go provider, so it needs `GOOGLE_APPLICATION_CREDENTIALS` alongside
it. That was judged more machinery than it is worth. Revisit if switching starts
getting forgotten.

**The full switch ritual, when moving between projects:**

```bash
gcloud config set account israel.rocha.clarke@gmail.com
```

```bash
gcloud config set project wawitas
```

```bash
gcloud auth application-default login
```

All three. Setting the account without redoing ADC leaves the *previous*
identity in the credential file — which is exactly what happened on 2026-08-12,
producing a work-account ADC carrying `quota_project_id: wawitas-pet-shelter`,
a project that had just been deleted. Useless for both projects.

**Note that `gcloud auth application-default set-quota-project` is no longer a
fix.** It was the right advice while both projects lived under one identity; it
cannot help now, because the problem is the *credential*, not the quota project.
A gmail-account ADC has no access to `trustcert-ai-g` at any quota project.

**One genuine improvement from the split:** a wrong-identity ADC now fails with
a permission error instead of silently writing to the wrong place. The two
accounts share no access, so the 2026-08-07 class of incident — a build quietly
reaching real Firestore in the work project — is no longer possible. Forgetting
to switch is now noisy rather than dangerous.

Verify rather than trusting this note; both values are mutable:

```bash
gcloud config get-value project
```

`.env.local` is pinned as a second layer and is gitignored, so it does not
travel between machines:

```bash
GOOGLE_CLOUD_PROJECT=wawitas
```

All six `NEXT_PUBLIC_FIREBASE_*` client values are **populated** (since
2026-08-16, from `terraform output firebase_web_config`). The Maps and App
Check keys are still empty, and are not needed yet.

### The next four things, in order

> ⚠️ **Steps 1 and 2 of this list are DONE** (Firebase web app registered
> 2026-08-16; the seed-a-pet constraints below are still exactly right and are
> restated at the top of this section under ▶ *Do this next*). Read the top of
> the file first — this list is kept for its constraints and warnings, which
> remain accurate, not for its ordering.
>
> **Superseded 2026-08-16 by
> [`docs/PLAN-intake-and-syndication.md`](docs/PLAN-intake-and-syndication.md)
> §0.1 and §9**, which expand this into a 14-step order covering the arrival
> pipeline, medical records, AI extraction, food and adoption. The four items
> below are still steps 1–4 of that order and their constraints are all still
> accurate — the plan adds sequence and definitions of done around them, it does
> not contradict them. Read this for the *why*, the plan for the *order*.

1. **Put one real pet in Firestore and load the wall.** This is now the shortest
   path to a proven end-to-end system and the last unverified link in the core
   loop: `pets-server.ts` → `AdoptionWall.tsx` → rendered HTML has never once run with
   data in it. Everything underneath it is live — database, rules, indexes,
   Cloud Run.

   Two constraints on the seed document:
   - **`coverPhoto` must be hosted on `firebasestorage.googleapis.com`** or the
     page throws `E231 Invalid src prop` and 500s (`next.config.ts`
     `images.remotePatterns`). This is the constraint that killed the mock-data
     attempt on 2026-08-08.
   - `status` must be `available` and `createdAt` must exist, or the wall query
     will not return it.

   Then confirm it renders in **production**, not just locally. Note the
   homepage is ISR at 300s, so allow one revalidation window.

   **Still outstanding from the deploy, but not blocking:**
   - **`storage.rules` is not deployed.** `firebase deploy --only storage`
     fails with *"Firebase Storage has not been set up"* — the CLI wants a
     Firebase **default** bucket, and this project deliberately uses a named
     one (`wawitas-app`) created by Terraform. Naming it via `storage.bucket`
     in `firebase.json` did not satisfy the check. Resolving it likely means
     clicking "Get Started" at
     `https://console.firebase.google.com/project/wawitas/storage`, which
     creates a *second*, default bucket — decide whether to adopt that as the
     real one or keep the Terraform-managed one. **Not urgent:** `wawitas-app`
     has no `allUsers` binding, uniform bucket-level access is on, and only the
     Cloud Run service account holds `objectAdmin`.
   - **Rules enforcement has never been exercised.** They compiled and
     released, which is not the same as being correct. The first real test
     comes with auth (step 3).
   - `public_access_prevention` on `wawitas-app` is `inherited`, not
     `enforced`. Decide when Storage is actually used — enforcing it may affect
     how pet photos are served.
2. **Register a Firebase web app** and fill the four empty
   `NEXT_PUBLIC_FIREBASE_*` values in `.env.local`. Nothing client-side can
   exist until this does — no auth, no client reads, and therefore no way to
   test that `firestore.rules` actually enforces anything. Remember these are
   **build-time** values baked into the bundle by `next build` (see the
   Dockerfile ARGs), not Cloud Run runtime env vars.
3. ~~**Auth flows** (email + Google)~~ — **email/password DONE 2026-08-23**,
   and it did what this list predicted: it proved `firestore.rules` enforces.
   Google as a provider still needs an OAuth consent screen.
   **Still true:** the `detail`, `medical`, and `care/feeding` tiers have rules
   written and now-reachable credentials, but **no UI reads them yet** — the
   dossier's gated block is still a prompt, not a gate. That is the natural
   follow-up, and it is the first thing that will read Firestore *client-side*,
   where the cost principle in `## Architecture` finally starts paying off.
4. **Admin publishing UI**, including microchip entry. `validateMicrochip()` and
   `MICROCHIP_ERROR_ES` are built and tested, ready to wire into a form.

### Open questions awaiting a decision

- **Scan-history retention.** Currently indefinite — because nothing deletes it,
  not because anyone chose that. A rolling 24-month window (keeping intake and
  adoption permanently as `custody` records) would preserve every recovery use
  case while shrinking the surveillance surface. See concern #3. **Note the
  contrast with `placements`** (plan §13.6), which is also indefinite but for a
  sound reason: it records a pen inside one facility, not a person's movements.
- **The `LICENSE` copyright line** reads "pet-shelter contributors" rather than a
  named person or company, deliberately. Change it if a specific holder is wanted.

**Eleven more are open in the plan** ([§11](docs/PLAN-intake-and-syndication.md)).
Six of them are things only the shelter can answer, and they block real work:

| Needed from the shelter | Blocks |
|---|---|
| Pot and ladle measurements | Any food yield estimate — constants stay `null` until then |
| The real area list — names/numbers, kinds, capacities | The arrival pipeline. Seed from reality, don't invent "Cuarentena 1–3" |
| Their actual quarantine period | Whether the system shows a target they will meet or one they will learn to ignore |
| **Do they weigh the dogs?** | Every `mg/kg` dose and every ration. If there is no scale, say so in the UI rather than hiding it behind a computed number |
| Who dictates — the vet, or a volunteer relaying? | Who is professionally responsible for a dictated medical record |
| Their existing adoption screening questions | The application form. They ask these over WhatsApp today |

### Things that will bite whoever picks this up

Found by running it (2026-08-08):

- **A stale `.next` cache 404s every route** while the server still logs `200`,
  and makes `tsc --noEmit` report phantom syntax errors inside
  `.next/dev/types/`. Suspect this before suspecting your routing.
  `rm -rf .next` and restart.
- **An unreachable Firestore endpoint hangs the SSR render 12–40 s** on gRPC
  retries — the browser gives up before the server answers, though the request
  still ends `200`. A slow page here means a connection problem, not slow code.
- **`images.remotePatterns` allows only `firebasestorage.googleapis.com`**
  (`next.config.ts`). Any `coverPhoto` on another host throws
  `E231 Invalid src prop` and 500s the whole page. This constrains seed data.
- **`.env.local` holds placeholders only** and is gitignored, so it does not
  travel between machines. Every value needs filling in.
- **Do not add mock/fallback data to `pets-server.ts`** to make the wall look
  populated. It was tried on 2026-08-08, collided with the image-host rule
  above, and was reverted. Seed real documents instead.

From building the seeder (2026-08-23):

- **Escaping-sensitive code cannot be tested through a shell heredoc.** A
  quoted `<<'EOF'` heredoc silently rewrote `[\\s\\S]` to `[sS]`, so a probe
  reported the enum-drift guard was dead code when the guard was fine. The
  test was broken, not the thing under test. Two wasted diagnoses in a row
  came out of it — first "the guard never runs," then nearly "fix" working
  code. **Write the probe to a file and run the file.**
- **A guard that skips silently reads as a passing check forever.** The drift
  guard's original `if (!theirs) continue` meant a reformat of `types.ts`
  would disable it with no signal. It now fails loudly. This is the project's
  own *validated-is-not-verified* lesson applied to a validator: the check
  itself needed a check, and breaking it on purpose is the only way to earn
  the claim.
- **`coverPhoto` is derived, never accepted.** The seeder errors if the pet
  file contains one. The 2026-08-08 outage was a URL on the wrong host, and
  the durable fix is making that URL impossible to type by hand rather than
  documenting the hostname again.
- **EXIF stripping is a privacy control here, not an optimisation.** A photo
  taken in a foster home carries GPS. The seeder strips it on **upload**,
  which is too late if the original was committed — hence `seed/*` being
  gitignored except the template.
- **`sharp` is present but only as a transitive Next.js dependency**, pinned
  by an `overrides` entry. `require('sharp')` works; `require('sharp/package.json')`
  does not (`exports` blocks the subpath), which is a misleading way to
  conclude it is missing.

From following a deploy to production (2026-08-23):

- **Every prerendered HTML route needs an explicit `revalidate`, or Firebase
  Hosting caches it for a year.** A static App Router page sends
  `s-maxage=31536000`; Hosting cannot know the Cloud Run revision behind its
  rewrite changed, so a deploy does not purge it. `revalidate = 300` turns it
  into `s-maxage=300, stale-while-revalidate`. **Add it to every new page**,
  including pages that fetch nothing — "it has no data" is exactly the
  reasoning that left four routes frozen.
- **A green pipeline and a matching image tag do not mean production changed.**
  Both were true while the old page was still being served. The check that
  actually settles it is fetching the page and looking for something only the
  new build contains.
- **`?cb=<random>` is the fastest CDN-vs-origin test there is.** Hosting's
  cache key includes the query string, so a busted URL bypasses the edge. If
  the plain URL and the busted URL disagree, the deploy is fine and the cache
  is stale — do not go looking for a build bug.

From building auth (2026-08-23):

- **A rules probe does not need data.** Firestore evaluates rules *before*
  document existence, so a denied path throws `permission-denied` and an
  allowed path returns an empty snapshot. Both branches are testable against
  an empty database — which is how `firestore.rules` got proven without
  fabricating a pet. Use the **client** SDK; the Admin SDK bypasses rules and
  proves nothing about them.
- **Never tell a visitor which half of a login was wrong.** Identity Platform
  hides it from *us* too — wrong password and no-such-account both return
  `INVALID_LOGIN_CREDENTIALS`, and password reset succeeds for addresses with
  no account. A message like "contraseña incorrecta" would be a guess
  presented as a fact, and "no existe esa cuenta" would leak what the
  protection exists to hide.
- **`users/{uid}` is create-if-absent, never a blind write.** The update rule
  permits only a `displayName`/`photoURL` diff, so re-writing the document on
  each sign-in fails as soon as `createdAt` becomes a fresh
  `serverTimestamp()`. The `getDoc` first is what makes it idempotent.
- **The computed-style trap from 2026-08-22 is worse than recorded.** It is
  not merely that a transition delays the resolved value — in a tab that is
  **not compositing** (browser pane hidden, tab backgrounded), the transition
  stalls and the stale value never arrives, at any wait. It reported
  near-white text on near-white paper and looked exactly like a real contrast
  bug. Read tokens off `:root` with a `transition: none` probe element; do not
  wait longer and do not "fix" the CSS.
- **`AuthProvider`'s dynamic `import()` is load-bearing, not style.** It is
  what keeps the Firebase Web SDK out of the homepage bundle while still
  letting the root layout provide auth everywhere. Measured per route — see
  the verified-state table. A static import would undo it invisibly.

From building the admin intake UI (2026-08-23):

- **The admin claim is set by a script and by nothing else.**
  `npm run grant:admin -- <email>`. There is deliberately no HTTP route, no
  Cloud Function, and no self-service path — a bootstrap an authenticated user
  could call is a privilege-escalation path, and `firestore.rules` refusing a
  `role: 'admin'` field says nothing about the claim, which never lived in
  Firestore. The account must exist before it can be promoted.
- **`setCustomUserClaims()` REPLACES the claims object, it does not merge.**
  Passing `{ admin: true }` deletes every other claim. Same shape as the
  `fieldOverrides` lesson: a partial write that looks like an addition. Revoke
  by **deleting the key**, never by writing `admin: false` — that is
  indistinguishable from a grant in any log or dashboard.
- **A granted claim is invisible to a signed-in browser for up to an hour**,
  and this is measured, not folklore: right after a grant the cached ID token
  did not carry it and only `getIdTokenResult(true)` surfaced it. Hence the
  split — `AuthProvider` reads the **cached** token so the homepage pays no
  round-trip, `AdminGate` **forces** a refresh on mount so a just-promoted
  admin gets in. **Do not "simplify" either half.** A fresh grant that "does
  not work" is almost always this, not a failed write.
- **`AdminGate` is UX, not the security boundary.** It runs in the browser.
  The boundary is `firestore.rules` and `storage.rules`. Someone who bypasses
  the component reaches a form whose every save fails `permission-denied`. A
  client-side gate quietly believed to be the authorization layer is how
  authorization gets removed from the layer that has it.
- **A pet dossier had non-words in it for months and nothing could have caught
  it.** `t.pastParticiple()` was given verb roots instead of participle stems,
  so a chipped animal read "Está **identifica** con microchip". No test covers
  prose, and the page had **never rendered with a pet in it**. The general
  form: *copy that only appears when real data exists is untested by
  construction* — the fix is to render it once with real data, which is now a
  form anyone can fill in.
- **Publish is one `writeBatch` across four tiers, and the draft delete is in
  it.** A half-published animal is therefore not a state that exists. The
  draft id is minted up front and IS the petId, so step 2's photos upload
  straight to `pets/{petId}/…` and publishing moves no files and changes no
  URL.
- **Browser EXIF stripping is a canvas re-encode, and it drops orientation
  too.** `createImageBitmap(file, { imageOrientation: 'from-image' })` bakes
  the rotation into the pixels before drawing — without it, portrait phone
  photos publish sideways while the original looks fine in every viewer, so
  the bug appears to be ours alone. Verified by walking the uploaded JPEG's
  marker segments: no APP1, no `Exif`, no `GPS`, no XMP.
- **`allow write` in a Storage or Firestore rule COVERS DELETE, and on a
  delete `request.resource` is null.** So any condition that inspects the
  incoming payload — `isImage()`, a size cap, a field whitelist — makes the
  rule throw and deny. `pets/**` carried this from 2026-08-02 and nobody
  noticed for three weeks, because **no code in the project had ever tried to
  delete an object.** Split `create, update` from `delete`, and when adding
  any rule ask which verbs the condition can actually evaluate. `sightings`
  and `medical` were already correct; only `pets` was wrong.
- **A same-route `<Link>` does not reset component state.** "Registrar otro"
  pointed at `/admin/intake` from a success screen that already lives there,
  so Next matched the same segment, kept the component mounted, and the
  `published` state pinned the screen forever. A reset is a **button that
  clears state**, not a link to where you already are. Found by clicking it,
  not by reading it.
- **The working tree is CRLF** (`core.autocrlf=true`, no `.gitattributes`).
  Any edit script matching LF needles finds nothing and reads as "the rule
  moved". Normalise to LF, edit, restore the file's own endings.
- **The file-editing tool turns `\uf8ff` and combining-mark escapes back into
  literal invisible characters.** `slugify`'s diacritic range and the slug
  prefix-query bound both had to be written through a Node script to survive
  as escapes. An invisible character inside a regex is undebuggable — and this
  is the third recurrence of the wider lesson: **escaping-sensitive edits go
  in a file you run, never through a shell heredoc or an inline `-e`.**

From the English rename (2026-08-22):

- **Stored enum values are data, not code.** `PetStatus`, `AreaKind`,
  `Species` and the rest are written into Firestore. Renaming one now is free
  only while `pets` is empty; once a single document exists it is a backfill,
  and once production traffic exists it is a dual-read window. If more renames
  are wanted, they are cheapest today and get monotonically more expensive.
- **Never token-rename across files that mix identifiers and prose.** The CSS
  class `muro` and the Spanish noun *muro* are the same string. The sweep that
  catches it: diff every added line, drop the ones containing `className`,
  `href=` or `import`, and read what is left.
- **`src/i18n` is the only place Spanish belongs.** If a translated string
  appears in a component, a lib module, or a type, it is in the wrong file —
  that is what made `pet.sex` renderable as raw data in the first place.
- **The legacy Spanish routes redirect from `next.config.ts`.** They are not
  dead weight: `/adopta` was live on both hosts. Drop them only when server
  logs show no traffic, not on sight.

From Hosting and the custom domain (2026-08-22):

- **A Hosting block with `rewrites` but no `public`/`source` deploys nothing,
  silently.** The CLI prints no warning, `releases` stays `{}`, and the site
  404s while the Cloud Run origin serves perfectly — so the symptom points away
  from the cause. If `wawitas.web.app` ever 404s again, check for a document
  root before anything else.
- **The Firebase CLI has now been on the wrong Google account twice.** It is a
  third credential store, it does **not** read `GOOGLE_APPLICATION_CREDENTIALS`
  (re-verified 2026-08-22 by setting it and observing no change), and `gcloud`
  being correct tells you nothing. Run `firebase login:list` before any deploy.
- **Spaceship's DNS panel can show "DNS Records (0)" while the domain
  resolves.** Registrar parking is implicit — not a row you can see or delete.
  Adding an explicit record displaces it. Never trust the panel; query
  `launch1.spaceship.net` directly.
- **Spaceship rejects a blank Host field for the apex.** The `@` is a
  placeholder, not a value. Leaving it empty fails with a bare *"Invalid host
  value"* that does not say which field is wrong.
- **A 404 on a custom domain has two completely different causes, and the
  response headers tell them apart.** Firebase's "Site Not Found" page (no
  `X-Powered-By`) means the hostname has not reached that edge node — wait.
  `X-Powered-By: Next.js` means the request arrived and *our* app 404'd — a
  routing bug. Conflating these wastes hours.
- **`/.well-known/acme-challenge/…` returning Next.js's 404 on `web.app` is a
  red herring.** Hosting only intercepts that path for a domain actually in
  cert provisioning; on `wawitas.org` it is answered by `Server: Varnish`. A
  catch-all `**` rewrite does not break certificate issuance.

From the CI/CD pipeline (2026-08-12):

- **Never add `--set-env-vars` / `--update-env-vars` to `deploy.yml`.** Terraform
  owns the Cloud Run service's entire env list, so a CI-injected variable it
  does not declare gets planned for deletion on every apply — and a plain env
  silently overrides a Secret Manager binding of the same name. The workflow
  carries this warning inline. `NEXT_PUBLIC_*` are the exception and are *not*
  env vars: Next inlines them at `next build`, so they are build args, and
  setting them on Cloud Run does nothing whatsoever.
- **`terraform.tfvars`' `container_image` is stale on purpose** and must not be
  "corrected" to match production. See the comment in that file.
- **A commit touching only `**.md`, `docs/`, `design/`, or `terraform/` does not
  deploy** — `paths-ignore` in `deploy.yml`. Infrastructure stays a deliberate
  human `apply`. If a deploy seems not to have fired, check this before
  suspecting the pipeline.
- **The two GitHub repository variables are not secrets, and must be reset if
  the WIF pool is ever recreated.** `terraform output workload_identity_provider`
  and `ci_service_account`. A recreated pool gets a new resource path and auth
  fails with a message about the audience, which does not obviously point here.
- **`attribute_condition` in `terraform/cicd.tf` is the entire trust boundary.**
  Every GitHub Actions workflow on the planet presents a token from the same
  issuer. Broadening or removing that condition hands deploy rights to anyone.

From bumping the actions to Node 24 (2026-08-23):

- **Check `runs.using` at the floating major tag, not at the latest release.**
  The workflows pin `@v7`, `@v4`, `@v3` — the moving tag is what resolves at
  run time, so it is the thing to verify. A latest *release* being `node24`
  does not prove the major tag points at it. Read the action's own
  `action.yml` at that ref; the marketplace listing is a summary and memory
  was already stale for three of these.
- **`grep` inside a pipeline gates nothing.** `grep X | sort -u && echo BAD`
  takes its exit status from `sort -u`, which succeeds on empty input, so the
  `&&` branch fires when there are no matches. This produced a false "the
  warning is still there" during this work. Count into a variable and compare,
  and prove the pattern hits on a known-positive input before letting a zero
  mean absence — the same discipline the seeder's drift guard needed.
- **`google-github-actions/auth` is the only action here on the credential
  path.** If a future bump breaks anything, it shows at
  `Authenticate to Google Cloud` or at the Artifact Registry login immediately
  after — that login reads `steps.auth.outputs.access_token` and is the
  read-through on the output still existing. v3 dropped only
  `retries`/`backoff`/`backoff_limit`, none of which this repo passes.
- **Three Node versions are in play and only one of them is this.** The
  runner's `node24` runs the *action wrappers*; `ci.yml`'s `node-version: 22`
  matches the Dockerfile and is what the app is tested on; the dev machine's
  20.20.2 is neither. A deprecation notice about the first is not a reason to
  touch the other two.

Known from before:

- **The service-area bounds live in two places** — `src/config/shelter.ts` and
  `firestore.rules`. The rules copy is the enforced one. Change both together.
- **`pets-server.ts` bypasses all security rules** (Admin SDK). It must never be
  imported from a Client Component, and its exports deliberately return only
  public-tier data so a Server Component cannot leak a restricted tier by accident.
- **`node --test` globs do not work on Node 20** — the `test` script names the
  test file explicitly. Revisit when the machine moves to Node 22.
- **Facebook sync (`PLAN.md` §5) was never built.** It predates the GCP pivot;
  the destination is now a Firestore document, not a markdown file.

Known from the sibling stack, not yet hit here (full list:
[`docs/gcp-lessons-from-trustcert.md`](docs/gcp-lessons-from-trustcert.md)):

- **The `Dockerfile` runner stage does not set `ENV HOSTNAME=0.0.0.0`.**
  Next.js `output: 'standalone'` generates a `server.js` that reads
  `process.env.HOSTNAME`, and container runtimes set it to the container id —
  so the server binds to a non-routable name, Cloud Run's startup probe never
  succeeds, and the failure message points at the container rather than at this
  line. One line, add it before the first `docker build`.
- **`terraform apply` will fail on APIs that `plan` never checks** —
  `monitoring`, `firebasestorage`, and `cloudresourcemanager` are all used by
  resources in `terraform/` but absent from `apis.tf`.
- ~~**The moment CI deploys images, Cloud Run needs `lifecycle {
  ignore_changes }`**~~ — **done 2026-08-12**, in the same commit as the
  pipeline, as that lesson instructed. `cloud_run.tf` ignores `image`,
  `client`, and `client_version`. It deliberately does *not* ignore
  `template[0].scaling`, so the benign diff above stays visible.

### Emulator leftovers still in the repo

The emulator decision is documented but not fully swept out of the code. None of
these are active — `NEXT_PUBLIC_USE_EMULATORS` is unset, so the branch is dead
and the client never attempts an emulator connection — but they are the last
things that would let someone re-derive the retired workflow:

- `src/lib/firebase-client.ts` — `if (process.env.NEXT_PUBLIC_USE_EMULATORS === 'true')`, now a dead branch
- `src/lib/firebase-admin.ts` — two comments still describing emulator routing
- `package.json` — the `emulators` script
- `firebase.json` — the `emulators` port block

---

## Architecture

**Constraint: lowest possible cost, no VMs, serverless only.** Every decision below is downstream of that.

| Concern | Service | Free tier | Notes |
|---|---|---|---|
| App server (Next.js SSR) | Cloud Run 2nd gen | 2M requests/mo, scales to zero | No VMs; see [Frontend](#frontend) for why Next over static export |
| CDN + custom domain | Firebase Hosting, rewriting to Cloud Run | 10 GB stored, 360 MB/day transfer | Gives the custom domain and edge caching without a load balancer |
| Auth | Firebase Authentication | 50k MAU | Email/password + Google provider |
| Database | Firestore (Native) | 1 GiB, 50k reads / 20k writes per day | System of record — see [Database choice](#database-choice--decided-2026-08-09) |
| Reporting | BigQuery, fed by the Firestore→BigQuery extension | 1 TB queries/mo, 10 GB storage | **Not built yet** — add when the first report is asked for, not before |
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

**Caveat, noted 2026-08-09:** the Next.js pivot moved the wall and pet pages to
Server Components using the Admin SDK, which **bypasses Rules entirely** and pays
Cloud Run compute per read. So this principle currently pays off only on the
paths that are still client-side — and none of those exist yet, because auth
flows aren't built. Every future read is a live decision about which side of this
line it sits on: public, crawlable, SEO-relevant pages belong server-side despite
the cost; the signed-in expediente and the admin console should read client-side
so Rules do the authorization for free.

### Database choice — **decided 2026-08-09**

**Firestore is the system of record. BigQuery gets added for reporting when a
report is actually asked for, not before.** The model here is genuinely
relational and Firestore is not the best *fit* for it — this is a decision made
on cost and integration, and it's worth keeping the reasoning honest so the
revisit triggers below stay legible.

**Why NoSQL holds.** The binding constraint is the one at the top of this
section — serverless, scale-to-zero, $0/month — and it eliminates most of the
field before data-model fit is even considered:

| Option | Scales to zero | Realistic floor | Notes |
|---|---|---|---|
| **Firestore** | yes | **$0** | Free tier is ~50× this shelter's traffic |
| Cloud SQL Postgres | **no** | ~$9–25/mo | Smallest instance bills 24/7, forever |
| AlloyDB | no | ~$200+/mo | Not in the conversation |
| Supabase (Postgres + RLS) | free tier pauses | $0 → $25/mo | Closest philosophical match; leaves GCP |
| Neon / Turso | yes | $0 | Real option, but no Auth/Storage/App Check to integrate with |

Cloud SQL is the natural "just use Postgres" answer and it fails the first
constraint on line one. The rest is coupling: Firebase Auth, Cloud Storage, App
Check, and Rules are one integrated system, and this design leans on all four.
Supabase RLS is the only alternative that preserves that property, and it costs
the GCP tenant plan and the Terraform already written.

**Where the fit is genuinely bad.** Named so nobody rediscovers them as
surprises:

1. **Reporting queries.** "Which pets are due for a vaccination in the next 30
   days," "adoptions per month," "animals with no microchip" — one line of SQL
   each, awkward-to-impossible in Firestore. Every new filter combination needs
   its own composite index and there are no joins. **This is what BigQuery is
   for.**
2. **The retention sweep** (concern #3). `DELETE ... WHERE scannedAt < ...` in
   SQL; in Firestore a paginated batched job you write, schedule, and pay
   per-document-delete for. The deferral is fine — the implementation cost is
   higher than it looks.
3. **No referential integrity.** `adoptions.ownerUid`, `custody.holderUid`,
   `scans.scannedByUid` are strings pointing at documents nothing enforces. A
   deleted user leaves orphans that surface much later as a UI bug.
4. **Tier-as-subcollection is a Firestore-shaped workaround.** Rules can't
   protect a field, so visibility tiers became five documents; assembling one
   pet's full expediente is five reads where Postgres RLS would be one `SELECT`
   with a column-level policy. Free at this scale — but it is not a
   universally-good design, it is a design *this database* forced.
5. **No `ALTER TABLE`.** Schema changes are code changes plus a backfill script.

**What BigQuery fixes and what it doesn't.** The Firebase
*Stream Firestore to BigQuery* extension mirrors collections continuously.
Firestore stays the system of record; BigQuery only answers the questions
Firestore is bad at (weakness 1, and the *analysis* half of 2). It does not fix
3, 4, or 5. At this data size it stays inside the free tier. **Do not add it
speculatively** — it is a second copy of personal data (see concerns #2 and #3),
so it should arrive with a named report to justify it, and with the restricted
tiers considered rather than mirrored by default.

**Revisit the database choice if any of these become true:**

- **The identity record becomes the product** rather than the adoption wall —
  the secondary objective. Medical history + custody chain + scan ledger is the
  most relational part of the model; if shelters use this primarily as a chip
  registry, Postgres gets more attractive.
- **Multiple shelters share one deployment** and want cross-shelter queries. The
  current template design is one shelter per deployment, which sidesteps this.
- **Someone needs ad-hoc SQL against live data** — a grant report, a vet audit —
  and BigQuery's mirror lag or missing tiers make it insufficient.

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
  status        shelter | foster | available | adopted | lost
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

**Planned additions, none built.** Specified in
[`docs/PLAN-intake-and-syndication.md`](docs/PLAN-intake-and-syndication.md) §2,
§12.5 and §13; listed here so this stays the one place the whole shape is
visible:

```
pets/{petId}/media/{mediaId}          public|auth — REPLACES detail.photos[]
  kind, tier, path, derivatives       photos AND video. Tier is a FIELD here,
  alt, order, uploadedAt              not a document — the one deliberate
                                      exception, see plan §2.2

pets/{petId}/measurements/{id}        AUTHENTICATED
  weightKg, bcs (WSAVA 1–9), mcs      the model has NO weight today, and both
  measuredAt, measuredBy              mg/kg dosing and kg^0.75 energy need it

pets/{petId}/placements/{id}          AUTHENTICATED — the outbreak ledger
  areaId, areaName, startedAt         INTERVALS, not a currentArea field.
  endedAt (null = here now), reason   Distemper incubation reaches 6 weeks

areas/{areaId}                        ADMIN
  name ("Cuarentena 2" | "3"), kind   quarantine|isolation|general|
  capacity, active                    medical|maternity — ASV keeps
                                      quarantine and isolation SEPARATE.
                                      `name` stays as the shelter says it:
                                      it is data they type, not an enum

petDrafts/{draftId}                   ADMIN — half-finished wizard state,
                                      deliberately OUTSIDE pets/

adoptionApplications/{id}             applicant + admin. internalNotes must
                                      NOT be readable by the applicant

qrTokens/{token}                      PUBLIC READ — resolves to public tier
                                      only, like findPetByMicrochip()

api_usage_daily/{date__proc__model}   SERVER ONLY — playbook §4.1 rollup,
                                      wired at the FIRST AI call site

foodDonations/{id} · foodStock/{key}  ADMIN — LLM parses the donation text,
cookBatches/{id} · feedingLog/{date}  deterministic code does the arithmetic

socialPosts/{postId}                  ⏸ DEFERRED — do not create
```

Three enum changes go with these: `PetStatus` gains `inbound`, `quarantine`
and `cancelled` (`inbound`, **not** anything built on "tránsito" — `foster`
already means *hogar de tránsito*, a foster home, and the two are opposites);
`MedicalRecordKind` gains `serology`; and `FeedingUnit` gains `ladles`.

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

**A clean plan is not proof of a valid config.** Several classes of error —
an unenabled API, a server-side constraint, an invalid immutable location —
surface only at `apply`. [`docs/gcp-lessons-from-trustcert.md`](docs/gcp-lessons-from-trustcert.md)
§4 lists ten specific gaps in this stack found by diffing it against a live
one; three of them are exactly that class and should be fixed before the
first apply.

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

## Lessons from a live sibling stack

Carried over 2026-08-08 from `trustcert-ai-g` — same architecture (Next.js on
Cloud Run + Firestore + Firebase Auth + Terraform + GitHub Actions), except live
for months. Full write-up, with the reasoning and the incident timelines:
[`docs/gcp-lessons-from-trustcert.md`](docs/gcp-lessons-from-trustcert.md).
The rules below are the part that changes what gets built here.

### The one that generalises

**A thing that validated, compiled, or passed tests was not the thing that was
verified.** Every incident in that repo has this shape. A clean `terraform plan`
on a config the API rejected at apply. A remediation script written, merged, and
then not run with `--commit` for six weeks while the data was recorded as fixed.
A feature with 61 green tests and a clean offline replay that failed on the
first live request. This project is in exactly that state right now: everything
compiles, validates, and renders; **nothing has been applied**. Read every ✅ in
the verified-state table as "not yet falsified."

### Before the first `terraform apply` — **all five done 2026-08-12**

1. ✅ **Enabled `monitoring`, `firebasestorage`, and `cloudresourcemanager`** in
   `apis.tf`. All three are used by resources already in `terraform/` and none
   were declared. `validate` and `plan` are structurally blind to this class.
   **Corrected 2026-08-12 by measuring the real project rather than trusting
   the sibling stack's list:** of the three, `monitoring` was *already enabled
   by default* on a fresh project in this org. Only `cloudresourcemanager` and
   `firebasestorage` were genuinely missing. Declaring all three is still right
   — `google_project_service` is idempotent and pins them against later
   disablement — but "three missing APIs" was inherited, not observed, and two
   is the true number here. `cloudresourcemanager` was confirmed missing the
   hard way: an ADC probe failed with *"Cloud Resource Manager API has not been
   used in project wawitas-pet-shelter before or it is disabled."*
   It has since been enabled manually via `gcloud services enable`, because the
   Terraform provider needs it to bootstrap. `serviceusage` is on by default, so
   Terraform can enable the remainder itself.
2. ✅ **Firestore location confirmed — and a inherited claim corrected.** This
   item used to say `us-east1` is *not* a valid Firestore single-region, taken
   from the sibling stack's incident log. **That is wrong.** Checked against
   `gcloud firestore locations list` on the real project rather than trusted:
   `us-east1`, `us-central1`, `southamerica-east1` and ~40 others are all valid.
   Whatever the sibling stack actually hit, it was not this.
   **`var.region` is now `us-east1`**, at the user's direction — it is inside
   the Cloud Storage Always Free tier (only `us-east1`, `us-central1`,
   `us-west1` are), a cheap Cloud Run region, and ~1,200 km closer to Cochabamba
   than Iowa, with South American traffic typically routing via Miami. The
   Firestore location remains **immutable** once created.
   **Second inherited claim from that doc to fail verification today** — the
   first was "three missing APIs," which was two. Treat its specifics as leads
   to check, not facts.
3. ✅ **`ENV HOSTNAME=0.0.0.0`** added to the `Dockerfile` runner stage, with a
   do-not-remove comment. No `docker build` has run yet, so this is still
   unverified — it is the fix for a failure that has not been reproduced here.
4. ✅ **`user_project_override` + `billing_project`** added to both provider
   blocks. Directly relevant to the ADC hazard — without them some calls are
   quota'd against whatever ADC defaults to rather than the target project.
5. ✅ **Firestore PITR + two backup schedules** (daily/14d, weekly/14w). Delete
   protection was already set; it does not help against a bad write or a sweep.
   Their 2026-07-12 incident is the argument: *correct + unrecoverable* is one
   bug away from *wrong + unrecoverable*. Both bill for storage — this is the
   project's first deliberate non-zero line item, and it is worth it.

**All five are now `plan`-clean against the live project** — 29 to add, 0
warnings — which is a stronger claim than the `validate` this section originally
earned, but still not `apply`. Retention bounds and the PITR flag are validated
server-side at apply and remain unproven. So does org policy. So does
`docker build`. The checkmarks mean "planned successfully," not "known to work."

### Rules to hold as the project grows

- **The Cloud Run env var list has exactly one owner.** If Terraform owns the
  service, Terraform declares every env var and CI passes only the image tag.
  Their `IP_HASH_SALT` was CI-injected and Terraform-undeclared, so every full
  apply planned to delete it. A plain env silently overrides a `secret_key_ref`
  of the same name.
- **The day CI deploys images, Cloud Run needs `lifecycle { ignore_changes }`**
  on `template[0].containers[0].image` (plus `client`, `client_version`,
  `scaling`) — otherwise the next `apply` rolls production back to the tfvars
  tag. Add it in the same commit as the pipeline, not after.
- **Never let the client write a field the server trusts for authz.** Gate the
  *diff*, not the identity: `!diff().affectedKeys().hasAny(privilegedFields())`,
  plus `allow delete: if false`. This repo's design already avoids the incident
  structurally (tiers are separate documents; admin is a custom claim) — the
  exposure returns the moment a client writes its own `users/{uid}`.
- **A `fieldOverride` in `firestore.indexes.json` replaces, it does not merge.**
  Always re-list the default `COLLECTION` ASC+DESC entries. And when documents
  look missing, check they exist before assuming loss — *"data gone" is usually
  "query broken."* This is live risk for `findPetByMicrochip()`: a broken index
  on `identity.code` returns nothing, which reads as "chip not registered."
- **Cost is per API call, not per artifact.** A cheap-looking scheduled job over
  a saturated queue is a recurring bill. Estimate per-cycle calls × frequency
  before shipping any cron. Their user traffic was $0.33 lifetime against a $665
  month that was ~99% background jobs. Here the equivalent line item is Maps.
- **Secrets in Secret Manager are created empty.** Add the version *before* a
  `version = "latest"` binding resolves, or the revision fails to start. And
  keep values out of `plan` output — theirs leaked a salt and had to rotate it.
- **Write the postmortem.** Their loop — incident → blameless writeup → numbered
  gotcha → next person reads it — is the only reason any of this was recoverable
  eight months later.

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

**1. ✅ gcloud CLI authenticated** as `israel.rocha.clarke@gmail.com` with
`core/project = wawitas`. **ADC needs re-running whenever you switch between
this project and `trustcert-ai-g`** — one file, two identities. The full ritual
is in [Next session](#next-session--start-here); do not skip the ADC step, and
do not reach for `set-quota-project`, which cannot fix a wrong identity.

Node is no longer a blocker: the current Node 20.20.2 satisfies Next.js,
TypeScript, and `firebase-admin` 13.x.

**2. ✅ Project and billing both exist.** This landed after a same-day
false start worth knowing about, because it explains a burned project ID:

| | |
|---|---|
| Project ID | `wawitas` |
| Project number | `181094228409` |
| Parent org | **none** — created without `--organization` |
| Owner account | `israel.rocha.clarke@gmail.com` (personal) |
| Billing | ✅ `01AC67-128A11-DCD80D`, free trial, `billingEnabled: true` |

**The false start:** the project was first created as `wawitas-pet-shelter`
inside the employer's `trustcertllc.com` org, at the user's explicit choice.
Billing there was blocked (`israel.rocha@` had only
`roles/billing.costsManager`), and the user then judged the whole arrangement
too complex and moved to a personal free-trial account. `wawitas-pet-shelter`
was shut down. **Its ID is permanently burned** — Google never releases a
project ID for reuse, even after deletion. `pet-shelter` was tried next and was
already taken globally, which is how the ID landed on `wawitas`.

**Two consequences of the personal account, both good:** there is no
organization parent, so no inherited org policy — the Domain Restricted Sharing
risk that could have blocked `allUsers` on Cloud Run is gone. And the account
holds `billing.admin` on its own billing account, so linking took one command
rather than a colleague.

**⏰ The one date that matters: the free trial is $300 over 90 days, expiring
around 2026-11-10.** When it ends, services stop and resources are eventually
deleted unless the account is upgraded to paid. Upgrading does not mean paying —
real usage here sits well inside the Always Free tier — but it does mean a card
stays on file. A budget alert at $5 is in the Terraform and goes up with
everything else. **Set a reminder for ~2026-11-01.**

**3. Terraform is installed** (v1.14.8 verified). `terraform >= 1.9` is assumed.

**4. Later, not now:** ~~DNS for `wawitas.org`~~ (**done 2026-08-22** — records live at Spaceship, ownership verified, certificate issued; only Firebase's edge rollout outstanding), the Maps API key restricted by HTTP
referrer, the Google OAuth consent screen, and the reCAPTCHA Enterprise key for
App Check.

---

## Conventions

- **Spanish** for anything a visitor reads; **English** for code, comments, commits, and docs.
- **Everything a machine reads is English. Everything a person reads is not.**
  That means route segments, component names, CSS classes and custom
  properties, variables, function names, Firestore collection names **and
  stored enum values** are all English — `status: 'available'`, not
  `'adopcion'`. Reversed 2026-08-22 at the user's direction; the previous rule
  allowed Spanish enum values and is gone.
- **Visitor-facing language lives in `src/i18n/` and nowhere else.** Every
  identifier in that directory is English and every value is Spanish. Adding a
  language is adding one file that satisfies the `Messages` interface — never
  editing a query, a status value, or a component. The shelter's own
  vocabulary is not lost, just moved: `shelter` still displays as "refugio",
  `foster` as "hogar de tránsito".
- Page-level JSX copy is still inline and is the one exception left. Moving it
  into `src/i18n` is the follow-up that makes a second locale real.
- No secrets in the repo. Firebase Web config is public by design; anything else goes in Secret Manager.
- Commit messages: imperative mood, no attribution trailers.
- Every new visibility tier is a **new document**, never a new field. Rules cannot protect a field.
