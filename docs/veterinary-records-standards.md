# Veterinary records: what standards actually exist, and which ones bind us

Research behind the medical/vaccination half of the intake plan
([`PLAN-intake-and-syndication.md`](PLAN-intake-and-syndication.md)). Companion
to [`rfid-microchips.md`](rfid-microchips.md), which covers identity.

Written because the honest answer to "what international standard should we
follow for an animal's medical record?" is uncomfortable, and someone will
otherwise spend a week looking for a standard that does not exist.

---

## 0. The headline finding

**There is no international standard for a companion animal's electronic
medical record.** Nothing in veterinary medicine corresponds to what HL7 FHIR,
SNOMED CT, LOINC and ICD-10 are to human healthcare: no mandated exchange
format, no universal terminology, no regulator requiring interoperability
between practice management systems.

What exists instead is four separate things that are frequently confused with
each other:

| Layer | Standard | Status for us |
|---|---|---|
| **Identity** | ISO 11784 / 11785 | ✅ **Binding.** The only genuinely universal one. Already implemented |
| **Legal travel document** | EU pet passport — Reg. (EU) 2026/131 | ✅ **Model to copy.** Not binding in Bolivia, but it is the only internationally recognised field schema for an animal's health record |
| **Clinical practice** | WSAVA Vaccination Guidelines 2024 | ✅ **Adopt.** A practice standard, not a data standard — but it dictates the vocabulary and the field list |
| **Clinical terminology** | VeNom · SNOMED CT Veterinary Extension | 🟡 **Defer, but leave the socket.** Both real, neither appropriate to force on a shelter today |
| **Population management** | WOAH Terrestrial Code Ch. 7.7 | 🟡 **Cite, don't implement.** Bolivia is a member state; it gives legitimacy, not a schema |

**If you are reading this to answer "we're in Bolivia, what should we follow?" —
skip to [§6](#6-bolivia--which-standards-actually-bind-us-and-which-we-choose).**

The practical consequence: **we design the schema, and we anchor it to the EU
passport's field structure plus WSAVA's recommended certificate fields.** That
gives us a defensible, internationally legible record without pretending to
implement a standard that has no conformance test.

---

## 1. ⚠️ The EU framework changed four months ago

This supersedes what [`rfid-microchips.md`](rfid-microchips.md) §5 says, and
that section is now stale.

**Regulation (EU) No 576/2013 has been superseded by
[Commission Delegated Regulation (EU) 2026/131](https://food.ec.europa.eu/animals/movement-pets/eu-legislation/non-commercial-movement-within-eu_en),
in force since 22 April 2026**, which completes the Animal Health Law
(Regulation (EU) 2016/429). The passport model itself moved to Commission
Implementing Regulation (EU) 2026/705, Annex I Part 1.

What survives unchanged — and this matters, because our code depends on it:

- The transponder must still be **ISO 11784/11785**.
- The chip must still be implanted **before** the rabies vaccination, or the
  vaccination is void. `rabiesVaccinationIsValid()` in `src/lib/microchip.ts`
  remains **correct**; only the citation above it needs updating.
- Rabies protection still begins **not less than 21 days** after the primary
  protocol completes.
- The animal must be **at least 12 weeks old** at rabies vaccination. *This one
  we do not currently validate* — see the plan.

What is new and worth knowing:

- **Microchipping and registration in interoperable national databases becomes
  mandatory for all EU dogs and cats.** The direction of travel is exactly the
  "identity record" secondary objective in `CLAUDE.md` — the EU is building, at
  member-state scale, the thing this project builds at shelter scale.
- Passports issued under the old model stay valid transitionally; a valid
  European pet passport is required for intra-EU movement **from 1 January
  2028**.
- Tattoo identification is accepted only if applied before 3 July 2011.

**None of this is law in Bolivia.** It matters for two reasons anyway: it is the
only complete field schema for this kind of record that anyone has published, and
an internationally adopted animal — which happens — has to satisfy it.

> ⚠️ **Unverified detail.** The section *numbering* of the new passport model
> (2026/705 Annex I Part 1) was not read directly; it was inferred from the
> Commission's summary page and secondary sources. Before we claim passport
> conformance anywhere in the UI, read the Annex itself. What is well-supported
> is the *set* of sections, which has been stable across models.

---

## 2. The EU passport's section structure — our field schema

The passport is the closest thing to a published, internationally recognised
schema for an animal's health record. Its sections, which have been stable
across model revisions:

| § | Section | Where it lands in our model |
|---|---|---|
| I | Details of ownership | `custody` / `adoptions` |
| II | Description of animal | `pets/{id}` — name, species, breed, sex, date of birth, colour |
| III | Marking of animal | `pets/{id}/identity/microchip` — code, date applied, location |
| IV | Issuing of the passport | Out of scope; we are not an issuing authority |
| V | **Rabies vaccination** | `medical` — manufacturer, product name, batch, date, **valid from / valid until**, vet details |
| VI | Rabies antibody titration test | `medical`, kind `serologia` — **not currently modelled** |
| VII | Echinococcus / parasite treatment | `medical`, kind `desparasitacion` |
| VIII | Other vaccinations | `medical`, kind `vacuna` |
| IX | Clinical examination | `medical`, kind `consulta` |
| X | Legalisation | Out of scope |

Two things fall out of this that our current `MedicalRecord` does **not**
capture:

1. **`validFrom` / `validUntil` are distinct from `performedAt` and
   `nextDueAt`.** For rabies these are legally load-bearing: protection starts
   21 days after the primary dose, not on the day of injection. Our
   `nextDueAt` conflates "when the next dose is due" with "when cover lapses",
   and for rabies those are different dates with different consequences.
2. **The vaccine product is three fields, not one.** Manufacturer, product
   name, and batch/lot number. We have `name` and `batch`; manufacturer is
   missing, and it is on every physical card.

---

## 3. WSAVA — the clinical practice standard

The [WSAVA Vaccination Guidelines](https://wsava.org/global-guidelines/vaccination-guidelines/),
2024 edition, from the Vaccination Guidelines Group. This is the global
reference for *how to vaccinate*, and it hands us three directly usable things.

**Core vaccines.** Dogs: distemper (CDV), adenovirus (CAV), parvovirus (CPV) —
plus rabies, core wherever rabies is endemic or required by law. Cats:
panleukopenia (FPV), herpesvirus (FHV-1), calicivirus (FCV), plus rabies on the
same basis. Everything else is non-core and regionally driven. **Bolivia is
rabies-endemic** (§6), so rabies is unambiguously core here.

**The certificate field list.** The VGG's recommendation for what a vaccination
record must carry is, near enough, our schema:

> vaccine name, batch/lot number, date administered, next due date,
> veterinarian details — and **how long into the future the animal is expected
> to be protected**

That last field is the interesting one. The VGG explicitly asks for a
*duration of immunity* statement rather than only a next-due date, because core
vaccine immunity commonly outlasts the annual booster interval by years. Recording
"protected until" separately from "come back on" is a WSAVA recommendation and
an EU passport requirement at the same time — which is a strong signal it belongs
in the model.

**Two artefacts we should use directly:**

- A **Shelter Dogs and Cats Vaccination Table** — WSAVA publishes shelter-specific
  guidance, which is a different protocol from owned-pet practice (earlier first
  dose, shorter intervals, vaccination on intake). This is exactly our use case.
- **Regional recommendations for Latin America, published in Spanish.** The right
  reference for the reference deployment, and it removes the translation problem
  from the admin UI's help text.

**Titre testing** is endorsed as an alternative to automatic revaccination —
which is why §VI of the passport exists, and why `serologia` should be a
first-class `MedicalRecordKind` rather than a `consulta` with a note.

---

## 4. Clinical terminology — the socket, not the plug

Two real options exist for coding diagnoses and procedures:

**[VeNom](https://venomcoding.org/history/)** (Veterinary Nomenclature). Grew
out of the Royal Veterinary College's Queen Mother Hospital, which had been
coding final diagnoses in SNOMED and broke away in 2006 because SNOMED was too
complex for routine clinical use. Deliberately more accessible and more
flexible than SNOMED. Widely used in UK small-animal practice and research.

**SNOMED CT Veterinary Extension (VetSCT)**, maintained by the Veterinary
Terminology Services Laboratory at Virginia Tech. A true extension of SNOMED CT
International — fully compatible, far more expressive, and correspondingly
heavier. SNOMED CT carries member-country licensing, which is a real question
for a Bolivian deployment and for a template other shelters fork.

**Recommendation: adopt neither as the storage format. Add an optional
`codes[]` field and leave it empty.**

The reasoning is about who types. A volunteer in Cochabamba transcribing a
handwritten card that says *"quíntuple"* is not going to select a SNOMED
concept id, and a UI that demands one will get abandoned or filled with
whatever's first in the list — which is worse than free text, because it looks
structured. Coded terminology pays off when you have enough records to query
across, and it can be **backfilled** from free text later (there is active
research on exactly this — [fine-tuning models to code veterinary diagnoses](https://arxiv.org/html/2410.15186v1)).
Free text now, a mapping job when there is something to map.

What we *should* do now is constrain the things that are genuinely enumerable
in this domain — `MedicalRecordKind` already does this — and keep the free-text
field alongside rather than instead.

**HL7 FHIR** deserves a mention only to be ruled out. It is human-medicine and
there is no adopted veterinary profile. Its resource shapes (`Patient`,
`Immunization`, `Observation`) map onto this domain well enough that a future
export is plausible, so it is worth *not painting ourselves out of it* — keep
one medical event per document, with an explicit type, a date, a performer, and
a subject reference. We already do. Nothing further is required today.

---

## 5. Vaccine product identification — there is no global registry

Worth stating because it looks like it should exist. There is no international
identifier for a veterinary vaccine product comparable to a drug's ATC code.
The USDA licenses and codes US products; the EU registers its own; Bolivia's
**SENASAG** registers veterinary biologicals nationally. None interoperate.

**Practical consequence:** record what the physical card actually says —
manufacturer, product name as printed, and lot/batch number as free text. That
is both the most faithful transcription and the only thing a future auditor or
vet can verify against the paper. Do not attempt to normalise product names on
entry; normalise later if a report ever needs it.

---

## 6. Bolivia — which standards actually bind us, and which we choose

**The short answer: Bolivia mandates almost nothing for companion animals, so
the standard is ours to pick — and the right pick is ISO 11784/11785 for
identity, WSAVA's Latin America and shelter guidance for vaccination practice,
and the EU passport's field structure for the record schema.**

That is not an arbitrary choice. Three separate forces converge on it.

### 6.1 What Bolivian law requires

| Layer | Body | What it actually requires |
|---|---|---|
| **Animal welfare** | **Ley 700** (2015) | Cruelty and mistreatment. **A welfare statute, not an identification regime** — no chip, no registry, no record format |
| **Zoosanitary movement** | **SENASAG** | Certificate for moving animals between municipalities and the *Permiso Zoosanitario Internacional* (PZI) for export. **Rabies vaccination is a `sine qua non`** |
| **Rabies** | Ministerio de Salud y Deportes, SEDES | Free national campaign. Certification authority also extends to the Ministry of Agriculture, CEMZOO, and authorised vets |
| **Microchipping** | **Municipal only** | Narrow — tied to licensing dogs classified as dangerous. **No national scheme** |
| **Technical standards** | **IBNORCA** | Bolivia's ISO member body. Adopts international standards as *Normas Bolivianas* — the route by which ISO becomes locally citable |

**There is no Bolivian national companion-animal registry to integrate with and
no legal record format to inherit.** As `rfid-microchips.md` §6 puts it: this
system is the registry of record. That is a responsibility rather than a
freedom — nobody else is holding the mapping from chip number to phone call.

### 6.2 What pushes us to ISO anyway

Three things, none of them "because it's the international standard":

1. **SENASAG already works in ISO.** The PZI process — the paperwork for any
   animal leaving Bolivia — is built around ISO 11784 codes. An animal chipped
   to any other scheme is an animal that cannot be exported without being
   re-chipped.
2. **The hardware sold here is ISO.** Chips and scanners on the Bolivian and
   regional market are ISO 11784/11785 FDX-B at 134.2 kHz. The 125/128 kHz
   installed-base problem in `rfid-microchips.md` §3 is largely a North
   American legacy issue; buying ISO here is the default, not a special order.
   Universal scanners remain the right purchase regardless.
3. **International adoption happens.** An animal placed in Europe must satisfy
   Reg. (EU) 2026/131 — ISO transponder, chip before rabies, 21 days, ≥12
   weeks. Choosing anything else forecloses that at intake, years before anyone
   knows it mattered.

### 6.3 WOAH — the international body Bolivia is actually a member of

This is the standards layer most likely to be overlooked, and it is the one with
genuine standing here. **Bolivia is a member of WOAH** (World Organisation for
Animal Health, founded as OIE — 182 member countries), whose
[**Terrestrial Animal Health Code**](https://www.woah.org/en/what-we-do/standards/codes-and-manuals/)
is the WTO-recognised reference for animal health standards.

Two chapters bear directly on a shelter:

- **Chapter 7.7 — Stray Dog Population Control.** Recommendations for Dog
  Population Management: humane control, and explicitly the need for *"a
  regulatory framework and a national or local infrastructure … to encourage the
  finders of stray dogs to report to the Competent Authority."* That sentence
  describes the sightings feature and the QR/microchip lookup. A shelter
  operating a findable identity record is doing WOAH Ch. 7.7 work.
- **Chapter 4.2 — identification systems for animal traceability.** The
  design principles for traceability systems generally.

**Practical use:** WOAH gives no field schema and no data format, so it changes
no code. What it gives is the *legitimacy argument* — for grant applications, for
municipal partnership, and for the day a Bolivian national scheme does appear and
asks what this system was built against.

> ⚠️ Bolivia's WOAH membership is asserted from WOAH's 182-member figure and
> regional participation, not confirmed against the member list directly.
> Confirm before citing it in a funding application.

### 6.4 The recommendation, in one table

| Domain | Follow | Binding? |
|---|---|---|
| Microchip | **ISO 11784 / 11785**, FDX-B 134.2 kHz | Effectively — via SENASAG's PZI and the local hardware market |
| Chip → record lookup | Our own. **No national registry exists** | We are the registry |
| Vaccination protocol | **WSAVA 2024** — shelter table + **Latin America regional recommendations (Spanish)** | No. Best practice |
| Rabies | Ministerio de Salud campaign; **rabies is core in Bolivia** | Yes — endemic, and SENASAG requires it to move animals |
| Record field schema | **EU pet passport** structure (Reg. 2026/131) | No. Adopted because it is the only published one |
| Clinical terminology | Free text now; VeNom/SNOMED socket for later | No |
| Population management | **WOAH Terrestrial Code Ch. 7.7** | Soft — Bolivia is a member state |
| QR | **ISO/IEC 18004**, level Q | Yes, technically |
| Standards citation locally | **IBNORCA** adopts ISO as *Norma Boliviana* | Route, not requirement |

### 6.5 Rabies is the operative fact

Rabies is the operative fact. Bolivia runs a **free national canine and feline
rabies vaccination campaign** — the Ministry of Health allocated ~3.6–3.7
million doses nationally, with **Cochabamba receiving ~851,760 doses**, the
largest departmental allocation, because **Cochabamba has been the department
worst affected by canine rabies**. Vaccination is available from **10 days of
age** under the national campaign.

Note the divergence worth flagging in the UI: the campaign's 10-day floor is a
mass-vaccination public-health measure, while EU movement rules require the
animal to be **at least 12 weeks old** at the rabies vaccination for that
vaccination to count for travel. Both are true. An animal vaccinated at three
weeks in a municipal campaign has been protected under Bolivian public health
policy and has **not** satisfied EU entry requirements. If we ever surface
"ready to travel", it has to be computed from the EU rule, not from the
presence of a rabies record.

Certification authority sits with the Ministry of Health and Sports, the
Ministry of Agriculture, CEMZOO, and legally authorised veterinarians. **SENASAG**
issues the zoosanitary certificate required to move animals between
municipalities — La Paz, for one, requires it with rabies vaccination as a
*sine qua non*.

**Consequence for the model:** the shelter's record will routinely contain
rabies vaccinations administered by a *campaign*, not a named veterinarian, with
no lot number and possibly no card at all. `veterinarian` and `batch` must stay
nullable, and the UI must not treat a campaign entry as incomplete data.

---

## 7. The QR code

**[ISO/IEC 18004](https://www.gs1.org/docs/Digital-Link/GS1_Digital_link_Standard_i1.1.1.pdf)**
is the QR symbology standard, 3rd edition 2015. Any generator worth using
implements it; this is not a decision so much as a fact.

The decisions that are actually ours:

**Encode a URL, never data.** A QR containing the microchip number would put a
restricted-tier credential (see `rfid-microchips.md` §5) onto a tag hanging off
the animal's collar, readable by anyone with a phone. It also freezes the data
at print time. A URL resolves to whatever is current and enforces our privacy
tiers at read time.

**GS1 Digital Link** ([ISO/IEC 18975](https://ref.gs1.org/standards/digital-link/uri-syntax/))
is the standard for encoding structured identifiers into a resolvable URL, and
it is the right answer for trade items. It is the wrong answer here: it is built
around GTINs and GS1 identification keys, requires GS1 membership for a
prefix — a recurring cost against a $0/month constraint — and buys us
interoperability with retail systems no shelter will ever talk to. **Use a plain
HTTPS URL with a documented structure.** Revisit only if animals ever need to
resolve inside a supply-chain system, which would be a strange day.

**What goes in the URL matters more than the format.**

- **Not the slug.** Slugs derive from names, and `Pet.formerNames` exists
  precisely because rescued animals get renamed — by the finder, by the
  shelter, then by the adopter. A printed tag outlives the name on it.
- **Not the Firestore document id.** It leaks the internal key and is
  enumerable-looking.
- **Not the microchip number.** Restricted tier.
- **An opaque random token**, short enough to keep the symbol at a low version
  so it stays scannable at collar-tag size, and revocable — if a tag is lost
  with the animal, the token can be retired without touching the record.

**Print specification**, which is not optional for something living on a collar:

| Parameter | Value | Why |
|---|---|---|
| Error correction | **Level Q (25%)** | A collar tag gets scratched, muddy, and chewed. M (15%) is the usual default and is not enough here |
| Quiet zone | 4 modules minimum | Per ISO/IEC 18004; scanners fail without it and the failure looks random |
| Minimum printed size | ~20 mm for a tag | Below this, phone cameras start failing at realistic distances |
| Symbol version | Keep low — short URL | Driven entirely by payload length, which is why the token is short |

---

## Sources

- [WSAVA Vaccination Guidelines](https://wsava.org/global-guidelines/vaccination-guidelines/) — landing page, links the 2024 guidelines, the shelter table, and the Latin America regional recommendations
- [WSAVA 2024 guidelines for the vaccination of dogs and cats (PDF)](https://wsava.org/wp-content/uploads/2024/04/WSAVA-Vaccination-guidelines-2024.pdf)
- [2024 guidelines — Journal of Small Animal Practice](https://onlinelibrary.wiley.com/doi/10.1111/jsap.13718)
- [AVMA — WSAVA updates global guidelines for vaccination](https://www.avma.org/news/wsava-updates-global-guidelines-vaccination)
- [European Commission — Non-commercial movement of pets within the EU](https://food.ec.europa.eu/animals/movement-pets/eu-legislation/non-commercial-movement-within-eu_en) — the authority for Reg. (EU) 2026/131
- [Commission Implementing Regulation (EU) No 577/2013 — EUR-Lex](https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=celex%3A32013R0577) — superseded; the old passport model
- [VeNom Coding — history](https://venomcoding.org/history/)
- [SNOMED CT — Wikipedia](https://en.wikipedia.org/wiki/Systematized_Nomenclature_of_Medicine) — VetSCT and the Virginia Tech VTSL
- [Fine-tuning foundational models to code diagnoses from veterinary health records](https://arxiv.org/html/2410.15186v1) — the argument that free text can be coded retrospectively
- [GS1 Digital Link Standard (PDF)](https://www.gs1.org/docs/Digital-Link/GS1_Digital_link_Standard_i1.1.1.pdf) — and its ISO/IEC 18004 dependency
- [GS1 Digital Link URI syntax](https://ref.gs1.org/standards/digital-link/uri-syntax/)
- [WOAH — Codes and Manuals](https://www.woah.org/en/what-we-do/standards/codes-and-manuals/) — the Terrestrial Animal Health Code
- [WOAH Terrestrial Code Ch. 7.7 — Stray Dog Population Control (PDF)](https://www.woah.org/fileadmin/Home/eng/Health_standards/tahc/2023/chapitre_aw_stray_dog.pdf)
- [IBNORCA — Instituto Boliviano de Normalización y Calidad](https://www.ibnorca.org/) · [its ISO member record](https://www.iso.org/member/1565.html)
- [Ministerio de Salud y Deportes (Bolivia) — campaña nacional de vacunación antirrábica](https://www.minsalud.gob.bo/8187-gobierno-lanza-campana-nacional-de-vacunacion-antirrabica-con-mas-de-3-6-millones-de-dosis-para-perros-y-gatos)
- [Ministerio de Salud (Bolivia) — vacuna antirrábica desde los 10 días de nacidos](https://minsalud.gob.bo/8163-perros-y-gatos-pueden-recibir-su-vacuna-antirrabica-desde-los-10-dias-de-nacidos)
- [SEDES Cochabamba — campaña de vacunación](https://sedescochabamba.gob.bo/noticias.php?idp=298)
