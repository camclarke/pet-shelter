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
   [`src/components/Marca.tsx`](src/components/Marca.tsx) (inline SVG) and the
   colour/type tokens are at the top of
   [`src/app/globals.css`](src/app/globals.css).

4. **Translate, if you need to.** Visitor-facing copy is Spanish throughout;
   code, comments, and docs are English.

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
npm run emulators            # Firestore, Auth, Storage on localhost
npm run dev
```

```bash
npm test        # microchip validation suite
npm run build   # production build
```

> Point the app at the **Firebase emulators** for local development. Without
> `FIRESTORE_EMULATOR_HOST` set, the Admin SDK resolves Application Default
> Credentials and will connect to whatever real GCP project your `gcloud` is
> currently pointed at.

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

Then build and push the container, and point the Cloud Run service at the new
tag via the `container_image` variable.

---

## Contributing

Issues and pull requests welcome. Two conventions worth knowing before you open
one:

- **Every new visibility tier is a new document, never a new field.** Rules
  cannot protect a field.
- **Spanish** for anything a visitor reads; **English** for code, comments,
  commits, and docs.

## License

MIT — see [LICENSE](LICENSE).
