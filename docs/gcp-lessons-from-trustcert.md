# GCP lessons from `trustcert-ai-g`

Distilled from a full read of the sibling repo at `C:\code\trustcert-ai-g` on
2026-08-08 — its `CLAUDE.md` (43 numbered gotchas), `qa/postmortems/` (three
blameless writeups), all of `infra/*.tf`, `.github/workflows/deploy.yml`, and
its `Dockerfile`.

That project is the same architecture this one is heading for — **Next.js 16 on
Cloud Run, Firestore, Firebase Auth, Cloud Storage, Terraform, GitHub Actions** —
except it is live, has been for months, and has already paid the tuition. This
file is the transferable part.

> **Scope note.** `trustcert-ai-g` is the employer's project. Nothing here is
> copied from it operationally: no project ids, billing account ids, keys,
> secrets, or personal data. These are engineering patterns and failure modes.
> The rule in [`../CLAUDE.md`](../CLAUDE.md) still stands — shelter data must
> never land in that project.

---

## 0. The one meta-lesson

Almost every incident in that repo has the same shape:

> **A thing that validated, compiled, or passed tests was not the thing that
> was verified.**

- `terraform validate` + `terraform plan` were clean on an SLO config that the
  API rejected **at apply**, because the constraint (a 24h ceiling on burn-rate
  lookbacks) is server-side. *"A clean plan is not proof of a valid config."*
- A remediation script was written, reviewed, and merged — and then **not run
  with `--commit` for six weeks**. The corpus was recorded as fixed. *"Writing a
  remediation script is not the same as remediating."*
- A feature shipped with 61 green unit tests and a clean offline replay, and
  **failed on the first real request** because the live classifier fed it an
  input the tests never produced. *"Verify features by driving the real flow."*

This project is currently in exactly that state: **everything compiles,
validates, and renders; nothing has been applied.** Treat every ✅ in
`CLAUDE.md`'s verified-state table as "not yet falsified," not "working."

---

## 1. Bootstrap order

`trustcert-ai-g`'s `infra/README.md` records the order that worked. The state
bucket has to exist before `terraform init` can run, which is the one
chicken-and-egg step:

```bash
# 1. Create the project + link Blaze billing (console or gcloud)
# 2. Pin the project locally BEFORE authenticating  ← this project's own rule
#    echo GOOGLE_CLOUD_PROJECT=<id> >> .env.local
# 3. gcloud auth login
# 4. gcloud auth application-default login
# 5. State bucket — regional, versioned
gcloud config set project "$PROJECT_ID"
gsutil mb -p "$PROJECT_ID" -l "$REGION" "gs://${PROJECT_ID}-tfstate"
gsutil versioning set on "gs://${PROJECT_ID}-tfstate"
# 6. terraform init -backend-config=backend.hcl
# 7. terraform plan && terraform apply
# 8. firebase deploy --only firestore:rules,firestore:indexes,storage
```

Steps 2–4 are this project's addition and they are the important ones here —
see `CLAUDE.md` § "Next session". Steps 5–8 are lifted from what worked there.

**Versioning on the state bucket is not optional.** It is the only undo for a
corrupted or half-applied state file.

---

## 2. Who owns what

The single most valuable structural decision in that repo, made early and never
drifted:

| Layer | Owner | Why |
|---|---|---|
| APIs, Firestore instance, buckets, Artifact Registry, Cloud Run, service accounts, IAM, queues, crons, budget, monitoring | **Terraform** | Reproducible, reviewable, portable across tenants |
| `firestore.rules`, `firestore.indexes.json`, `storage.rules`, Auth provider setup | **Firebase CLI** | Terraform's rules support is too thin to be a trustworthy source of truth for a security-critical file |
| Container image + revision rollout | **CI (GitHub Actions)** | Terraform must `ignore_changes` the image or it rolls prod back |
| Firebase Auth **Custom SMTP**, OAuth client creation, Search Console user grants, AI Studio spend caps | **Console only** | No API/Terraform surface exists |

This project already made the same Terraform/Firebase-CLI split (see
[`../CLAUDE.md`](../CLAUDE.md) § Terraform). It has **not** yet reckoned with
rows 3 and 4.

### 2a. The console-only list is a real category

Things that cannot be automated and therefore have to live in a runbook or they
get lost:

- OAuth 2.0 web client (id + secret) — Terraform can *consume* one, not create it
- Firebase Auth Custom SMTP config (three separate silent-failure traps; see §8)
- AI Studio / provider-side spend caps
- Search Console property user grants
- DNS records at the registrar

---

## 3. Terraform patterns worth copying verbatim

### `ignore_changes` on the Cloud Run image — the CI/Terraform ownership conflict

```hcl
lifecycle {
  ignore_changes = [
    client,
    client_version,
    template[0].containers[0].image,
    template[0].scaling,
    scaling,
  ]
}
```

Without this, CI pushes revision N, then the next `terraform apply` rolls the
service back to whatever tag is in the tfvars. `client`/`client_version` are in
the list because `gcloud run deploy` stamps them and they'd otherwise produce a
permanent diff.

~~**This repo's `terraform/cloud_run.tf` has no `lifecycle` block.**~~
**Closed 2026-08-12**, in the same commit as the pipeline, exactly as this
instruction said to. `ignore_changes` covers `image`, `client`, and
`client_version` — and **the block was then proven rather than assumed**: after
CI deployed a commit-SHA tag, `terraform plan` showed only the known-benign
`scaling` diff and did *not* propose reverting to the stale tag still sitting in
`terraform.tfvars`. That is the rollback this lesson predicts, observed not
happening.

One deliberate divergence: `template[0].scaling` is **not** ignored here. That
would also hide real changes to `max_instance_count` — see the reasoning in
`terraform/cloud_run.tf`.

### Backend via `-backend-config`, never hardcoded

Already done here (`terraform/backend.hcl.example`). Confirmed as the right call
by that project's own tenant-portability requirement.

### Provider block: `user_project_override` + `billing_project`

```hcl
provider "google" {
  project               = var.project_id
  user_project_override = true
  billing_project       = var.project_id
}
```

Needed once you touch Firebase-linked and beta resources — without it, some API
calls get billed/quota'd against the *ADC quota project* rather than the target
project. Given this repo's whole ADC hazard, that is worth having explicitly.
**Missing from `terraform/providers.tf` here.**

### Secrets: create the container, add versions by hand — and mind the ordering

```hcl
resource "google_secret_manager_secret" "resend_api_key" {
  secret_id  = "resend-api-key"
  replication { auto {} }
  depends_on = [google_project_service.services]
}
```

Terraform creates the secret **empty**. The Cloud Run env binding uses
`version = "latest"`. If you apply the service before adding a version, **the
revision fails to start** — the binding cannot resolve. Their comment says it
outright: add the version *before* the binding resolves.

Project-level `roles/secretmanager.secretAccessor` on the runtime SA means no
per-secret IAM is needed. This repo already grants that role.

### Bucket lifecycle rules must be prefix-scoped

Their gotcha #24: one bucket, three prefixes, and a 1-day TTL rule written
without `condition.matches_prefix` silently deleted rate-card and quotation PDFs
24h after creation.

This repo's `terraform/storage.tf` has an unscoped rule:

```hcl
lifecycle_rule {
  condition { age = 90, num_newer_versions = 3 }
  action    { type = "Delete" }
}
```

It is currently *safe* — `num_newer_versions = 3` only reaps non-current
versions, so live objects survive. But the bucket is explicitly planned to hold
three categories with different retention needs (pet photos, sighting photos,
Stage-2 vaccination scans). **Decide each category's retention explicitly before
adding a fourth rule**, and scope any age-based rule by prefix.

### Immutable choices to get right the first time

- **Firestore location.** Theirs is `nam5`, because `us-east1` is not a valid
  Firestore single-region and they found that at apply time. This repo defaults
  to `us-central1`, which *is* valid — but the location is immutable, so confirm
  it against the current valid-locations list before the first apply. Moving it
  later means a new database.
- **Firestore `(default)` database name.** Same — one shot.

### Count-guarded optional resources

```hcl
resource "google_billing_budget" "monthly" {
  count = var.billing_account_id != "" ? 1 : 0
  ...
}
```

Lets the whole stack apply before the billing-account permission exists. Useful
here: `terraform/budget.tf` currently makes `billing_account` a **required**
variable with no guard, so the first apply hard-depends on having
`roles/billing.costsManager`.

---

## 4. Concrete gaps in `terraform/` right now

Found by diffing this repo's stack against theirs. Ordered by when they'd bite.

| # | Gap | Consequence |
|---|---|---|
| 1 | `monitoring.googleapis.com` not in `apis.tf`, but `budget.tf` creates a `google_monitoring_notification_channel` | Possible **apply failure** on a fresh project. Plan won't catch it. |
| 2 | `firebasestorage.googleapis.com` not in `apis.tf`, but `storage.tf` creates a `google_firebase_storage_bucket` | Same class — apply-time only |
| 3 | `cloudresourcemanager.googleapis.com` not enabled | Project-level IAM operations can fail on a fresh project |
| 4 | ~~No `lifecycle { ignore_changes }` on Cloud Run~~ | ✅ **Closed 2026-08-12** with the pipeline, and verified by a plan that declined to roll back (§3) |
| 5 | No `user_project_override` / `billing_project` on the providers | Quota/billing attributed to the ADC quota project — the exact hazard this repo is guarding against |
| 6 | Firestore has `delete_protection_state` but **no PITR and no backup schedule** | An accidental delete is unrecoverable. Their 2026-07-12 incident is precisely this. |
| 7 | No uptime check, no 5xx alert | Nothing tells you the site is down except a person noticing |
| 8 | No Secret Manager secrets declared | Fine now (none needed); the pattern and its ordering trap are in §3 for when Maps/reCAPTCHA keys land |
| 9 | ~~No WIF pool / CI service account~~ | ✅ **Closed 2026-08-12** — `terraform/cicd.tf`, copied from §7 nearly wholesale (§7) |
| 10 | `Dockerfile` runner stage does not set `ENV HOSTNAME=0.0.0.0` | See §9 — a real Cloud Run startup-probe failure mode |

Items 1–3 are the ones that turn the first `terraform apply` into a debugging
session. They cost about four lines to fix and cannot be caught by `plan`.

---

## 5. IAM — their live runtime role set

The Cloud Run runtime SA in that project, after eight months of accretion:

```
aiplatform.user                      datastore.user
secretmanager.secretAccessor         storage.objectAdmin (bucket-scoped)
logging.logWriter                    monitoring.metricWriter
identitytoolkit.admin                cloudtasks.enqueuer
recaptchaenterprise.agent            iam.serviceAccountTokenCreator (self)
iam.serviceAccountOpenIdTokenCreator (self)
iam.serviceAccountUser               (self)
```

Two are non-obvious and both cost them real debugging time:

- **`iam.serviceAccountUser` on itself.** Their gotcha #21: Cloud Tasks
  enqueueing fails `PERMISSION_DENIED: lacks iam.serviceAccounts.actAs` without
  it — **even when the caller and the signer are the same service account.**
  `tokenCreator` alone is not enough. Worse, their enqueue calls were
  `.catch()`-wrapped, so the failures were invisible for weeks.
- **`logging.logWriter` + `monitoring.metricWriter`.** Easy to omit because
  Cloud Run "just logs." Missing here in `terraform/iam.tf`; add them when you
  start relying on logs for diagnosis.

The two `TokenCreator` self-bindings exist for signed URLs and OIDC tokens
respectively. Not needed here until Storage signed URLs or authenticated crons
appear.

---

## 6. Secrets, env vars, and build args — the drift incident

Three delivery mechanisms, and mixing them caused a recurring outage-shaped bug:

1. **Build args** (`NEXT_PUBLIC_*`) — Next inlines these at `next build`. They
   must be `--build-arg` in CI. Setting them as a Cloud Run env var does
   nothing, because the browser bundle was compiled without them. This repo's
   `cloud_run.tf` comment already gets this right.
2. **Plain Cloud Run env** — non-secret runtime config only.
3. **`secret_key_ref`** — Secret Manager, Terraform-declared.

**The incident:** `IP_HASH_SALT` was injected as a plain env by CI
(`--update-env-vars`) and *not* declared in Terraform. Terraform owns the
service's whole `env` list, so **every full apply planned to delete it**. The
fix was to bring it under Terraform as a `secret_key_ref` and delete the CI
injection — and their deploy workflow now carries a comment saying don't re-add
it, because a plain env of the same name silently overrides the secret binding.

A second lesson from the same cleanup: **the old salt value leaked into a
`terraform plan` output** and had to be rotated. Plan output is not a safe place
for secret values — that's what `sensitive = true` on the variable is for.

**Rule to carry over:** the set of env var names on the Cloud Run service has
exactly one owner. If Terraform owns the service, Terraform declares every env
var; CI passes only the image tag.

---

## 7. CI/CD — Workload Identity Federation, no service-account keys

Their pipeline, worth copying wholesale:

- A **separate CI service account** from the runtime SA
  (`artifactregistry.writer`, `run.admin`, `iam.serviceAccountUser` on the
  runtime SA — the last one is required to deploy a service that *runs as*
  another SA).
- A **WIF pool** with the repository pinned in the attribute condition:

  ```hcl
  attribute_condition = "attribute.repository == \"camclarke/pet-shelter\""
  ```

  Without that condition, any GitHub repo can mint tokens for the pool.
- `permissions: { id-token: write }` in the workflow, `google-github-actions/auth`
  with the provider + SA — **no JSON key anywhere**.
- Terraform `output`s the two values you paste into GitHub repo secrets.

**What CI deliberately does not own there:** `firebase deploy`. Rules and
indexes are a manual step, which is their gotcha #31 and the direct cause of one
security incident and one outage (§8). They know it's a gap and left it open —
if you wire CI here, consider closing it, but only with a rules test in front of
it, because an unreviewed automatic rules deploy is worse than a manual one.

**Built here 2026-08-12** (`terraform/cicd.tf`, `.github/workflows/`), following
this section closely enough that it is worth recording only where it differs:

- **`run.admin` is project-level, not bound to the one service.** Cloud Run v2
  operations are project-scoped resources, so a service-level binding covers
  `services.update` and then fails polling the operation it returns. Everything
  else is scoped tight — `artifactregistry.writer` to the one repository,
  `serviceAccountUser` to the runtime SA alone.
- **Three APIs, not one.** `iam` fails at apply; `sts` and `iamcredentials` fail
  at the first workflow run, which is a worse place to discover them.
- **The two outputs are GitHub repository *variables*, not secrets.** They are
  resource identifiers and useless without a matching OIDC claim — that being
  the entire point of WIF — and as variables a failed auth step prints what it
  tried instead of `***`.
- **The rules/indexes gap was left open here too**, for the reason given above.

---

## 8. Firestore rules and indexes — two incidents, both worth reading twice

### Privilege escalation (2026-06-20, HIGH)

`allow read, write: if request.auth.uid == uid` on `users/{uid}` — while the
**server read that same document** for `role`, `tier`, and quota. Any signed-in
user could `setDoc({role:'superuser'})` from the browser console.

The fix was to make the update rule **diff-aware**, not identity-aware:

```
allow update: if isSelf(uid)
  && !request.resource.data.diff(resource.data)
       .affectedKeys().hasAny(userPrivilegedFields());
allow create: if isSelf(uid)
  && request.resource.data.role == 'user'
  && request.resource.data.tier == 'FREE';
allow delete: if false;   // also stops quota-reset-by-recreate
```

> **Never let the client write a field the server trusts for authz or billing.
> If a document mixes client-editable and server-authoritative fields, the rule
> must gate on the diff, not just the identity.**

**Direct relevance here.** This repo's data model already uses the stronger
version of that idea — *"Every new visibility tier is a new document, never a
new field"* — and puts admin in a **custom claim**, not a `users/{uid}.role`
field. Both decisions structurally prevent this incident. Keep them. The place
it can still bite is `users/{uid}` itself once auth lands: if the client ever
writes its own profile doc, add the diff guard on day one, and `allow delete: if
false`.

Also worth adopting: **deny-all is the default for every Admin-SDK-only
collection.** They add an explicit deny rule for each one rather than relying on
the absence of a match.

### The chats index outage (2026-07-12, HIGH)

`fieldOverrides` in `firestore.indexes.json` **replace** a field's default
single-field indexes rather than adding to them. An override that listed only
`COLLECTION_GROUP` entries **deleted** the default `COLLECTION`-scope ASC/DESC
indexes, and every list query started failing `FAILED_PRECONDITION`. The UI
rendered empty. It looked exactly like total data loss; **not one document was
lost.**

Three lessons:

- Any `fieldOverride` on any field must **re-list the `COLLECTION` ASC+DESC
  defaults** alongside the group-scope entries.
- **"Data gone" is usually "query broken."** Check the documents exist before
  assuming loss.
- Watch the rebuild with
  `gcloud firestore indexes fields describe <field> --collection-group=<cg>`
  until nothing reports `CREATING` (~3 min for them).

Relevant here because `findPetByMicrochip()` depends on a composite index on
`identity.code`. If that index is missing or broken, the lookup doesn't error
loudly — it returns nothing, which reads as "chip not registered."

---

## 9. Container and Cloud Run

Their runner stage sets two things this repo's `Dockerfile` does not:

```dockerfile
ENV PORT=8080
ENV HOSTNAME=0.0.0.0     # ← missing here
```

**Why `HOSTNAME` matters:** Next.js `output: 'standalone'` generates a
`server.js` that reads `process.env.HOSTNAME` for its bind address, and
container runtimes set `HOSTNAME` to the container id. The server then binds to
a name that isn't a routable interface, Cloud Run's startup probe never
succeeds, and the deploy fails with a message that points at the container, not
at this line. One line, add it before the first `docker build`.

They also convert every build `ARG` to an explicit `ENV` before `npm run build`.
Build args *are* visible to `RUN` in the same stage, so this repo's Dockerfile
should work as written — but the explicit form is what's been proven against a
real build, and it removes the question.

Other Cloud Run settings from their service, for reference:
`max_instance_request_concurrency = 80`, `timeout = "300s"`, `cpu_idle = true`,
`min_instance_count = 0`. This repo matches on the ones that matter for cost.

---

## 10. Cost — the $665 month

Their single largest operational failure, and the mechanism generalises past LLM
billing:

> **Cost is per API call, not per artifact.**

A "cheap" scheduled re-verification job ran a full 5-search discovery pass over
a permanently saturated queue — every cycle, whether or not anything had
changed. User traffic was **$0.33 lifetime**; the bill was ~99% background jobs.

What was missing when it happened:

- no provider-side spend cap
- no budget alert
- no per-process metering, so the in-app view could not have caught it

What to carry here — this project's exposure is smaller but the same shape:

- The budget alert at $5 is already in `terraform/budget.tf`. **Good.** It is
  also the only thing standing between a misconfigured loop and a surprise.
- **Maps is this project's equivalent line item** (`CLAUDE.md` concern #4): 10k
  loads/month free, then $7/1000. The guardrails already written down —
  lazy-load, static previews, never on the wall or homepage — are the right
  ones. Add them when the map lands, not after.
- If any scheduled job is ever added here (a Facebook sync, a scan-retention
  sweep), estimate **per-cycle calls × frequency** before it ships.
- Their budget covers the **whole billing account**, not one project, precisely
  because spend escaped to a sibling project nobody was watching.

---

## 11. Verification discipline

The habits that repo built after being burned, all cheap:

- **Verify data fixes on the live documents**, not by the existence of a script.
  Check a provenance stamp *and* re-run the real query — and know that a later
  automated process can strip the stamp while preserving the fix, so the stamp
  alone is not evidence either way.
- **Drive the real flow.** Green tests plus a clean offline replay proved
  nothing for them; the first live request failed.
- **Measure before waiting.** They deferred a milestone two weeks to "accumulate
  baseline data" that Cloud Monitoring had been collecting all along. *Before
  waiting for data, query for it.*
- **A plausible story that fits a family of bugs you just fixed is a reason to
  verify, not to believe.** Three separate incidents were first misdiagnosed as
  a repeat of the previous one.
- **Blameless postmortems in the repo.** Their `qa/postmortems/` has a template
  and three writeups, each ending in a `Lessons` section that became a numbered
  gotcha. That loop — incident → postmortem → gotcha → next person reads it — is
  the reason their `CLAUDE.md` is worth 163 KB.

---

## 12. What does not transfer

Stated so nobody imports it by analogy:

- **Their scale of `CLAUDE.md`.** 43 gotchas and five status blocks is a
  reasonable steady state for a live revenue product with a year of incidents.
  Copying that density onto a pre-deployment shelter site would be cargo-culting.
- **Cloud Tasks, Cloud Scheduler, OIDC workers, batch pipelines.** None of it is
  justified here yet. `CLAUDE.md`'s cost principle — *read Firestore directly
  from the client, let Security Rules do authorization; Functions only where
  Rules cannot reach* — is the correct posture for this project and is
  **stricter** than theirs.
- **Their auth surface** (TOTP MFA, six federated providers, reCAPTCHA
  Enterprise on signup, abuse clustering). This project needs email + Google.
  App Check on the public `sightings` write is the one piece of that machinery
  that *is* load-bearing here, and it's already specified.
- **Identity Platform via Terraform.** They manage providers in
  `google_identity_platform_*` resources. Viable, and worth considering when
  auth lands — but each provider still needs a hand-created OAuth client, so it
  is not full automation.
