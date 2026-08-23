# pet-shelter

Open-source adoption and rescue platform for animal shelters — dogs, cats,
rabbits, whatever arrives. Built for shelters that run on volunteers and cannot
afford a hosting bill.

Reference deployment: **Wawitas Red de Apoyo**, Cochabamba, Bolivia
([wawitas.org](https://wawitas.org)).

---

## What it does

- **Adoption wall** — server-rendered, so a search engine and a WhatsApp link
  preview both see a pet's name and photo in the first response.
- **Pet identity via ISO 11784/11785 RFID microchip** — validated properly, with
  a scan ledger that records where and by whom an animal was last scanned.
- **Medical history and feeding plans** — travel with the animal to its adopter.
- **Lost-pet recovery** — public sighting reports that need no account, plus
  microchip lookup that turns a scanner reading into a phone call.
- **Public teaser, gated detail** — enough to fall in love with is indexable;
  the substance is behind an account.

### Design constraints

**Every visibility tier is a separate Firestore document, never a field.**
Firestore security rules are document-level and cannot protect a field. This one
decision is what makes the login gating, the location privacy, and the microchip
confidentiality all work with the same mechanism.

**Reads go straight from the client to Firestore.** Rules evaluation is free; a
Cloud Function invocation is billed per read. Functions are reserved for what
rules genuinely cannot do.

**Expected steady-state cost: $0/month** on GCP free tiers, with a $5 budget
alert configured in Terraform before anything is deployed.

---

## A note on what microchips can and cannot do

A pet microchip is a **passive RFID transponder**. No battery, no GPS, read
range of a few centimetres. It is inert until a scanner energises it.

So this system records **where a scanner was when it read the chip** — a
recovery tool. It does not and cannot track an animal continuously, and the
schema is written to make that impossible to misread. If you need live tracking,
that is a separate GPS collar device with its own tradeoffs.

Full research notes, including regulatory requirements by jurisdiction:
**[docs/rfid-microchips.md](docs/rfid-microchips.md)**.

---

## Make it your shelter

1. **Edit [`src/config/shelter.ts`](src/config/shelter.ts)** — name, tagline,
   mission, WhatsApp number, city, service-area bounds, and which species you
   take in. This is the only file with organisation-specific content.

2. **Update the service-area bounds in [`firestore.rules`](firestore.rules)** to
   match. The config copy drives the UI; the rules copy is the one actually
   enforced against public sighting reports, so both need to change together.

3. **Replace the brand** — the logo mark is
   [`src/components/Brand.tsx`](src/components/Brand.tsx) (inline SVG) and the
   colour/type tokens are at the top of
   [`src/app/globals.css`](src/app/globals.css).

4. **Translate, if you need to.** Visitor-facing copy is Spanish; code,
   routes, comments, docs, and stored Firestore values are English. Language
   lives in [`src/i18n/`](src/i18n/) — add a file satisfying the `Messages`
   interface and register it in `index.ts`. You should never have to touch a
   query or a status value to change language.

---

## Stack

| Concern | Service |
|---|---|
| App server (Next.js SSR) | Cloud Run 2nd gen, scales to zero |
| CDN + custom domain | Firebase Hosting, rewriting to Cloud Run |
| Auth | Firebase Authentication (email + Google) |
| Database | Firestore (Native mode) |
| Images | Cloud Storage for Firebase |
| Maps | Maps JavaScript API |
| Infrastructure | Terraform |

Next.js 16 (App Router) · React 19 · TypeScript · no CSS framework — the design
is a bespoke poster system expressed as CSS custom properties.

---

## Running locally

Requires **Node ≥ 20.9**.

```bash
npm install
cp .env.example .env.local   # fill in from the Firebase console
npm run dev
```

```bash
npm test        # microchip validation suite
npm run build   # production build
```

> **Local development runs against a real Firestore project.** Set
> `GOOGLE_CLOUD_PROJECT` in `.env.local` to your own project id *before* you run
> `gcloud auth application-default login`. Left unset, the Admin SDK resolves
> Application Default Credentials and connects to whatever real GCP project your
> `gcloud` happens to be pointed at — which is silent, and is how shelter data
> ends up in an unrelated project.
>
> Use a **dedicated project** for the shelter, not one shared with other work.
> `src/lib/pets-server.ts` uses the Admin SDK, which bypasses `firestore.rules`
> entirely, so a misconfigured project id is not caught by your security rules.

---

## Deploying

```bash
cd terraform
cp terraform.tfvars.example terraform.tfvars   # fill in
cp backend.hcl.example backend.hcl             # fill in
terraform init -backend-config=backend.hcl
terraform apply
```

Terraform owns the infrastructure. Security rules and indexes stay with the
Firebase CLI, because Terraform's Firestore-rules support is too thin to be a
trustworthy source of truth for a security-critical file:

```bash
firebase deploy --only firestore:rules,firestore:indexes,storage:rules
```

### Continuous deployment

After the first `terraform apply`, application deploys are automatic. Every push
to `main` that touches application code runs
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml): typecheck, tests
and build, then a container build, a push to Artifact Registry under an
immutable commit-SHA tag, a Cloud Run revision, and a check that the live URL
answers `200`.

Authentication is **Workload Identity Federation — there is no service-account
key anywhere.** GitHub's own OIDC token is exchanged for a short-lived GCP
token, and `terraform/cicd.tf` pins the pool to a single repository, so no other
repo can mint one. Wiring it up in a fork is two `terraform output` values
pasted into GitHub repository variables:

```bash
gh variable set GCP_WORKLOAD_IDENTITY_PROVIDER --body "$(terraform -chdir=terraform output -raw workload_identity_provider)"
```

```bash
gh variable set GCP_CI_SERVICE_ACCOUNT --body "$(terraform -chdir=terraform output -raw ci_service_account)"
```

**CI owns the image tag and nothing else.** `terraform/cloud_run.tf` carries a
matching `lifecycle { ignore_changes }` so a later `terraform apply` does not
roll production back to the stale tag in `terraform.tfvars`. Everything else
about the service — env vars, scaling, IAM — stays Terraform's. Infrastructure
changes are still applied deliberately by a person; `terraform/**` is in the
workflow's `paths-ignore`.

Security rules and indexes are deliberately **not** in the pipeline. An
unreviewed automatic rules deploy is worse than a manual one; that changes when
there is a rules test to put in front of it.

---

## Contributing

Issues and pull requests welcome. Two conventions worth knowing before you open
one:

- **Every new visibility tier is a new document, never a new field.** Rules
  cannot protect a field.
- **Everything a machine reads is English; everything a person reads is not.**
  Routes, components, CSS classes, variables, and stored Firestore enum values
  (`status: 'available'`) are English. Visitor-facing language lives only in
  `src/i18n/` — where every identifier is English and every value is not.

## License

MIT — see [LICENSE](LICENSE).
