# wawitas.org — Plan

**Wawitas Red de Apoyo** — refugio transitorio, Cochabamba, Bolivia.
Facebook: `profile.php?id=61563998952145` · Instagram: `@wawitas_2025` · Tel/WhatsApp: `77903553` · 1.9K seguidores

> 💚 Somos un refugio transitorio de hermosos perritos, que han sido abandonados y/o maltratados.
> Nuestra misión es rescatarlos, rehabilitarlos física y emocionalmente y encontrarles una familia
> para toda la vida en ADOPCIÓN RESPONSABLE.

---

## 1. What the Facebook page actually tells us

Reading the live page, the content falls into five repeating shapes. The website must have a home for each:

| Content type | Example from FB | Site destination |
|---|---|---|
| **Adoption post** | "¡ADOPTA A MOCCA! …cachorro de aprox. 3 MESES… COMPROMISOS: castración gratuita a sus 6/7 meses. Se hará seguimiento. Ref. 72281566" | `/adopt` + `/adopt/mocca` |
| **Lost pet** | "URGENTE, SE BUSCA A NUBBY — RECOMPENSA 500 $US", "PERRITA PERDIDA KUKA" | `/lost` |
| **Adoption fair** | "GRAN FERIA DE ADOPCIONES — Encuentra tu Amor Verdadero, 1 y 2 de agosto, Parqueo Vergara" | `/eventos` |
| **Education** | "La Regla 3-3-3", tenencia responsable | `/aprende` |
| **Rescue case / appeal** | "NOS ESCRIBEN…" | `/help` + home feed |

Two things stand out and shape the whole design:

1. **Adoption posts are already structured.** Name, approximate age, temperament, commitments, contact reference. That is a database record wearing a caption. It maps cleanly onto the `Pet` schema, which is what makes the Facebook→website sync realistic rather than wishful.
2. **The contact channel is a Bolivian phone number, not a form.** Every conversion on this site should end in **WhatsApp**, pre-filled with the dog's name — not in a contact form nobody checks. This is the single highest-leverage decision in the plan.

---

## 2. The one job of this website

> **Turn a stranger who is scrolling into someone messaging Wawitas about a specific dog.**

Everything else — donations, education, lost pets, volunteering — is secondary and must not compete with that. The measure of success is *WhatsApp threads opened per visitor*.

The user's stated interaction — **click the dog's photo → adopt** — is the correct instinct and becomes the spine of the site:

```
photo (the wall)  →  click  →  expediente (the dog's file)  →  ADÓPTAME  →  WhatsApp, pre-filled
```

No account, no form, no funnel. Three taps from landing to conversation.

---

## 3. The existing brand

Wawitas already has an identity. We give it structure rather than replacing it. Sampled directly from their Facebook cover and profile image:

| Token | Value | Source |
|---|---|---|
| **Jade Wawitas** | `#31907A` | Eyedropped from the cover *and* the logo — identical in both |
| Jade hondo | `#12463B` | Derived; all body text. 9.5:1 on cream ✓ |
| Crema | `#F6F1E7` | Warm paper base — pure white chills the jade |
| Coral | `#F0532B` | The action color. Exact complement of the jade |
| Sol | `#F5B72B` | Tape, underlines, ticker |

Three assets carry over:

1. **The heart-paw mark** — a paw whose main pad is a heart with a dog's head inside. Rebuilt as SVG so it works as favicon, list bullet, section divider, and watermark instead of being a Facebook JPG. *We should still ask whoever designed it for the original vector file.*
2. **"De la calle, a tu corazón."** — already on their cover. This is the homepage headline. No agency would write a better one.
3. **The cutout band** — their cover puts background-removed dogs standing on a flat jade strip. It's their own device, it already works, and it becomes the site's visual signature.

**Type:** *Fraunces* (display) with its `SOFT` and `WONK` axes on — the deliberate imperfection converses with the brush-drawn logotype without tipping into cartoon. *Instrument Sans* for body and UI. Full Spanish accent coverage in both.

**Contrast rule:** jade (3.5:1) and coral (3.1:1) on cream are **fills, not text**. Body text is jade hondo; text on coral is carbón `#1A0E08` (5.3:1 ✓). One coral element per screen — if it appears twice it stops meaning "click here".

Full spec, rendered: [design/estilo.html](design/estilo.html)

---

## 4. Site map

| Route | Purpose |
|---|---|
| `/` | Hero + mission, the **Muro de Adopción** (latest 8–12 dogs), how adoption works in 3 steps, impact numbers, ways to help |
| `/adopt` | Full wall, filtered by tamaño · edad · sexo · urgencia, searchable |
| `/adopt/[slug]` | The **dossier** (*el expediente*): photos, story, stats, commitments, big WhatsApp CTA. Also opens as an overlay from the wall without losing scroll position |
| `/lost` | Lost & found. Real community value, and strong local SEO |
| `/events` | Adoption fairs — they run these regularly and partner with other rescues |
| `/help` | Donate (QR), foster (*hogar de tránsito*), volunteer, supplies wishlist |
| `/about` | Who they are, the team, transparency |
| `/learn` | Regla 3-3-3, adopción responsable, castración, primeros días |

**Language: Spanish only for v1.** The audience is Cochabamba. English would dilute the copy and double the maintenance for near-zero benefit. Structured for i18n later if it's ever wanted.

---

## 5. The Facebook sync — honestly

This is the ambitious part of the request, so here is the real picture before we build.

### What works
The page is a **Facebook Page** (not a personal profile), so the Graph API can read its own posts:
`GET /{page-id}/posts?fields=id,message,created_time,permalink_url,full_picture,attachments{media,subattachments}`
with a **long-lived Page access token**, which does not expire once issued.

### What will bite us
1. **A Meta app is required.** Wawitas has admin access, so this is unblocked — but we **develop against a test Page on our own Facebook account**, not theirs. The Page ID and access token are environment variables, so switching to the live page at launch is a config change, not a code change. Nothing we do while iterating can touch their real page.
2. **Facebook CDN image URLs expire.** The `oe=` parameter is a timestamp. We cannot hotlink `full_picture` — images must be downloaded and re-hosted, or the site will silently fill with broken images in a few weeks. This is non-negotiable.
3. **A caption is not a schema.** "¡ADOPTA A MOCCA! …aproximadamente 3 MESES…" has to be parsed into `{name, age, sex, size}`. Parsing will be right most of the time and wrong sometimes.
4. **Facebook does not know when a dog is adopted.** There is no signal in the feed. Without a way to mark a dog *adoptado*, the site becomes a graveyard of dogs who found homes months ago — which is worse than no site at all.

### The approach: never block the site on the API

Everything reads from **one interface**, `getDogs()`. What sits behind it can change without touching a single component.

- **Phase 1 — `content/dogs/*.md`.** Hand-authored, images in the repo. The site is complete, live, and fast on day one. Zero dependency on Meta.
- **Phase 2 — the sync job.** A scheduled task pulls new Page posts, filters for adoption posts (`#adopta`, "ADOPTA A"), downloads and re-hosts the images, parses what it can, and writes a **draft** markdown file. A human confirms name/age/sex and flips `estado: disponible`. Same `getDogs()`, same components, nothing re-designed.
- **Phase 3 — nice to have.** Instagram Graph (they post to `@wawitas_2025` too), auto-`adoptado` when the FB post is edited to say so.

**The review step in Phase 2 is deliberate.** Fully automatic publishing means a mis-parsed post or a lost-dog flyer lands on the adoption wall unreviewed. A weekly two-minute confirmation is a fair price for a site that is always correct.

### Stack

**Superseded — see [`CLAUDE.md`](CLAUDE.md) for the current architecture.** The project moved to GCP serverless (Firebase Hosting + Auth, Firestore, Cloud Functions 2nd gen, Cloud Storage, Maps JS API).

What that changes for the sync: the destination is no longer a markdown file in the repo but a **Firestore document**. A scheduled Cloud Function pulls new Page posts, re-hosts images to Cloud Storage, parses what it can, and writes `pets/{id}` with `status: draft`. An admin confirms it in the admin UI. The staged approach and the review step are unchanged — only the storage layer moved.

---

## 6. Build order

1. Design system — tokens, type, the SVG heart-paw, grain/halftone textures, base components
2. `Pet` schema + 6–8 real animals from the Facebook page as seed content
3. The **Muro de Adopción** and the expediente overlay — the core loop, built first
4. Home page around the wall
5. `/adopt` with filters, `/adopt/[slug]`
6. `/lost`, `/events`, `/help`, `/learn`, `/about`
7. SEO — `Pet`/`Organization` structured data, OG images per dog, sitemap, Spanish meta
8. Accessibility + performance pass (contrast, `prefers-reduced-motion`, Lighthouse)
9. Phase 2: the Facebook sync job

---

## 7. Open questions

1. ~~Facebook admin access~~ — **resolved.** Wawitas has it; we prototype against our own test Page.
2. **Is `wawitas.org` registered?**
3. **Is `77903553` the WhatsApp number** every adoption inquiry should go to? (`wa.me/59177903553`) Assumed yes until told otherwise — it's the number on their Facebook page.
4. **Donations** — bank account, QR Simple, or supplies-only?
5. **Does the original logo vector exist?** Worth asking whoever made it. Our SVG reconstruction is good, but the original is better.
6. **Real impact numbers** — rescued, adopted, currently waiting. The homepage has a place for them.
