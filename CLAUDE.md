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
| Local dev server | ✅ **Runs and renders** — all 5 routes verified in a browser 2026-08-08 |
| Muro de Adopción | ✅ **Live in production, reading real Firestore** — renders its empty state from an actual query. Still **never shown a real pet**, because no pet document exists |
| Pet identity (RFID microchip) | ✅ Modelled + validated, 10/10 unit tests — `src/lib/microchip.ts` |
| Medical history + feeding | ✅ Modelled — not yet surfaced in any UI |
| Template config for other shelters | ✅ `src/config/shelter.ts`, `README.md`, MIT licensed |
| Dockerfile + Cloud Run target | ✅ **Built and deployed 2026-08-12.** Now built by **GitHub Actions** (`docker buildx`); the first build was Cloud Build, since there is no local Docker on this machine. `ENV HOSTNAME=0.0.0.0` is proven, not assumed: Cloud Run's startup probe passed |
| Terraform | ✅ **APPLIED — 40 resources live.** GCS backend in `gs://wawitas-terraform-state`. One known-benign perpetual diff on `cloud_run scaling`, documented in `cloud_run.tf` |
| **CI/CD** | ✅ **GitHub Actions, applied 2026-08-12.** Keyless via Workload Identity Federation — no service-account key exists. `.github/workflows/{ci,deploy}.yml`, identity in `terraform/cicd.tf` |
| GCP playbook | ✅ [`docs/gcp-lessons-from-trustcert.md`](docs/gcp-lessons-from-trustcert.md) — bootstrap order, ownership split, IAM, secrets, CI, and the incident catalogue from a live sibling stack |
| **Live site** | ✅ **https://pet-shelter-web-production-poz3ad3gaa-ue.a.run.app** — HTTP 200, real Spanish HTML, wall reading live Firestore. No custom domain yet |
| GCP project | ✅ **`wawitas`** (`181094228409`), region **`us-east1`**, personal account `israel.rocha.clarke@gmail.com`. **No org parent.** Replaces `wawitas-pet-shelter` (employer's org, deleted same day) — see log |
| Billing | ✅ **`billingEnabled: true`** — `01AC67-128A11-DCD80D`, personal free trial ($300 / 90 days). **Trial expires ~2026-11-10; upgrade to a paid account before then or services stop** |
| ADC | ✅ Verified reaching `wawitas`. One global file, **two identities** — see the switch ritual below |
| Firestore | ✅ **Live** — `(default)`, `us-east1`, PITR on, daily + weekly backups, delete protection |
| **Firestore rules** | ✅ **Deployed 2026-08-12** — `firestore.rules` compiled and released. Enforcement itself is still **untested**: no client can reach Firestore yet |
| Firestore indexes | ✅ **Deployed** — 10 composite + the `identity.code` collection-group field override that `findPetByMicrochip()` needs |
| Storage rules | 🟡 **Not deployed** — needs a Firebase *default* bucket (console-only "Get Started"). **Not an exposure:** `wawitas-app` has no `allUsers` binding and uniform access is on |
| Firebase emulator suite | ❌ **Not used — decided 2026-08-08.** Also cannot run here (no Java) |
| Firebase web app | ⬜ Not registered — the four empty `NEXT_PUBLIC_FIREBASE_*` values need it |
| Auth flows | ⬜ Not started |
| Admin publishing UI | ⬜ Not started |
| Maps + sightings | ⬜ Not started |
| Reporting (BigQuery mirror) | ⬜ **Decided 2026-08-09, deliberately not built** — add when a real report is asked for |
| LLM vaccination-card parsing | ⬜ Stage 2 — deliberately deferred |

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

---

## Next session — start here

**IT IS DEPLOYED AND IT SERVES.** As of 2026-08-12 this project crossed the line
it had been sitting on since it started: infrastructure applied, image built,
Cloud Run live, and the Muro rendering a real Firestore query in production.

**https://pet-shelter-web-production-poz3ad3gaa-ue.a.run.app**

Every ✅ below was *executed*, not inferred. The remaining gaps are narrow and
named: **no security rules deployed, 11 of 12 indexes missing, and no pet
documents.**

### Verified state, as of 2026-08-12

| Check | Command | Result |
|---|---|---|
| **Live site** | `GET /` | ✅ **HTTP 200**, correct Spanish copy, wall shows its empty state from a live query |
| **Live site** | `GET /adopta` | ✅ HTTP 200, empty state correct |
| Container image | GitHub Actions `docker buildx` | ✅ **built + pushed**, tag = commit SHA. `gcloud builds submit` was the bootstrap path and is now the fallback, not the norm |
| Infra | `terraform apply` | ✅ **40 resources live**, GCS backend |
| Infra | `terraform plan` | 🟡 one **known-benign** diff on `cloud_run` `scaling` — see `cloud_run.tf`. Anything else is real |
| **CI** | GitHub Actions, PR #1 | ✅ typecheck + 10/10 tests + build + **0 vulnerabilities**, 47s |
| **CD** | GitHub Actions, push to `main` | ✅ **built, pushed, deployed, verified 200** — keyless via WIF, 3m23s |
| **CD ↔ Terraform** | `terraform plan` after a CI deploy | ✅ **does NOT roll the image back** — `ignore_changes` proven, not assumed |
| Firestore | live query via Admin SDK | ✅ connects, returns 0 docs |
| GCP project | `gcloud projects describe wawitas` | ✅ `ACTIVE`, `us-east1`, **no org parent** |
| Billing | `gcloud billing projects describe wawitas` | ✅ `billingEnabled: true` — trial expires ~2026-11-10 |
| ADC | `google-auth-library` probe | ✅ resolves `wawitas` with no `.env.local` help |
| Build | `npm run build` | ✅ 8 routes *(last local run 2026-08-08; Cloud Build has since built it twice)* |
| Tests | `npm test` | ✅ 10/10 (microchip validation) |
| Dependencies | `npm audit --omit=dev` | ✅ 0 vulnerabilities |
| **Firestore rules** | `firebase deploy` | ✅ **compiled + released** — but enforcement never exercised (no client) |
| **Indexes** | `gcloud firestore indexes composite list` | ✅ **10 composite + 1 field override** |
| Storage rules | `firebase deploy --only storage` | ❌ blocked on a Firebase default bucket; bucket is private regardless |
| Real data | any pet document | ❌ none exists |

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

Its four `NEXT_PUBLIC_FIREBASE_*` client values are still empty — they need a
registered Firebase **web app**, which does not exist yet.

### The next four things, in order

1. **Put one real pet in Firestore and load the wall.** This is now the shortest
   path to a proven end-to-end system and the last unverified link in the core
   loop: `pets-server.ts` → `Muro.tsx` → rendered HTML has never once run with
   data in it. Everything underneath it is live — database, rules, indexes,
   Cloud Run.

   Two constraints on the seed document:
   - **`coverPhoto` must be hosted on `firebasestorage.googleapis.com`** or the
     page throws `E231 Invalid src prop` and 500s (`next.config.ts`
     `images.remotePatterns`). This is the constraint that killed the mock-data
     attempt on 2026-08-08.
   - `status` must be `adopcion` and `createdAt` must exist, or the wall query
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
3. **Auth flows** (email + Google). Everything gated is currently a placeholder —
   `/cuenta` renders static text and the expediente's sign-in prompt is not a
   working gate. The `detail`, `medical`, and `care/feeding` tiers have rules
   written but no UI can reach them yet.
4. **Admin publishing UI**, including microchip entry. `validateMicrochip()` and
   `MICROCHIP_ERROR_ES` are built and tested, ready to wire into a form.

### Two open questions awaiting a decision

- **Scan-history retention.** Currently indefinite — because nothing deletes it,
  not because anyone chose that. A rolling 24-month window (keeping intake and
  adoption permanently as `custody` records) would preserve every recovery use
  case while shrinking the surveillance surface. See concern #3.
- **The `LICENSE` copyright line** reads "pet-shelter contributors" rather than a
  named person or company, deliberately. Change it if a specific holder is wanted.

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
