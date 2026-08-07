# RFID pet microchips: standards, regulation, and what they can't do

Research notes behind the identity model in `src/lib/microchip.ts` and
`src/lib/types.ts`. Written down because several of these findings are
counter-intuitive and would otherwise get re-litigated every time someone new
touches this part of the schema.

---

## 1. The most important finding: a microchip is not a tracker

An implanted pet microchip is a **passive RFID transponder**. It has no
battery, no GPS, and no radio of its own. It is completely inert until a
scanner's field energises it, at which point it returns one number and nothing
else. Read range is a few centimetres — the scanner has to be held against the
animal.

The American Veterinary Medical Association states it plainly: a microchip is
["not a GPS device and cannot track your animal"](https://www.avma.org/resources-tools/pet-owners/petcare/microchips-reunite-pets-families/microchipping-faq).

**What this means for this project.** "Track the pet's last location" is
achievable, but only in a specific sense: what gets recorded is the location of
the **scanner** at the moment of a scan, not the location of the pet at any
other time. That makes the system a **recovery** tool — *this animal was seen
here, by this organisation, at this time* — and not a **prevention** tool. No
device implanted under an animal's skin can be a prevention tool, because
nothing in the animal reports its position between scans.

This is modelled honestly as `ScanEvent` rather than as a `currentLocation`
field, precisely so nobody later reads the schema and assumes live tracking is
available. A shelter that promises adopters "you'll always know where your pet
is" on the strength of a microchip is making a promise the hardware cannot
keep, and adopters who believe it may take fewer precautions as a result.

If genuine live tracking is ever wanted, that is a **separate, external
device**: a GPS collar tag, battery-powered, visible, and removable — with all
the tradeoffs (cost, charging, and the fact that anyone who wants to steal an
animal simply removes the collar).

---

## 2. The standards: ISO 11784 and ISO 11785

Two standards, frequently cited together and often confused:

| Standard | Governs |
|---|---|
| **ISO 11784** | The **data structure** — what the number means |
| **ISO 11785** | The **air interface** — frequency and protocol |

### The 64-bit structure (ISO 11784)

```
  1 bit    animal application flag
 14 bits   reserved
  1 bit    flag: an additional data block follows
 15 bits   reserved
 10 bits   country code (ISO 3166-1 numeric) OR ICAR manufacturer code
 38 bits   national identification number
```

Rendered for humans as **15 decimal digits**: a 3-digit prefix followed by a
12-digit national ID.

### The 3-digit prefix

| Range | Meaning |
|---|---|
| `000`–`899` | ISO 3166-1 **numeric country code**, used where a national authority guarantees uniqueness for that species |
| `900` | ICAR **shared** manufacturer code — allocated in sub-ranges to several manufacturers |
| `901`–`998` | ICAR **unshared** manufacturer code — one manufacturer, granted only after two consecutive years of selling ≥1 million certified transponders annually |
| `999` | **Test transponder.** Not a real animal; need not be unique |

### Two validation rules that matter more than they look

**The code must be stored as a string, never a number.** ISO 3166 numeric
country codes below 100 genuinely begin with a zero — Bolivia is `068`. Parsed
as an integer, `068000000000001` becomes `68000000000001`, and every chip
registered under a low country code is silently corrupted. There is a
regression test for exactly this.

**A `999` prefix must be rejected.** Those are calibration chips shipped with
scanners. One entered during staff training — or, worse, implanted — would
collide with every other test chip in the world.

The 38-bit national ID also has a hard ceiling of **274,877,906,943**
(2³⁸ − 1). A 15-digit string can express values above that, but they are not
physically representable ISO codes.

### The air interface (ISO 11785)

**134.2 kHz**, in one of two protocols:

- **FDX-B** (full duplex) — transmits continuously while energised, so reads
  faster and more often. The common choice for companion animals.
- **HDX** (half duplex) — cannot transmit while the activating field is on, so
  it stores energy and replies after. More common in livestock.

---

## 3. The interoperability problem (mostly North America)

Not every chip in circulation is ISO. The United States has a large installed
base at **125 kHz** and, less commonly, **128 kHz**, using **9- and 10-digit**
codes with no standardised internal structure. Historically the split has been
roughly 125 kHz in the US versus 134.2 kHz in Europe.

Consequences this system has to live with:

- An ISO-only scanner **cannot read** a 125/128 kHz chip. It reports nothing —
  indistinguishable, to the person holding it, from an unchipped animal.
- "Universal" scanners read all three frequencies, but research by
  Dr. Linda Lord at Ohio State found the scanners marketed as universal were
  **not 100% accurate**.
- Best practice is therefore a **full-body scan with a universal scanner**, not
  a quick pass between the shoulder blades. Chips **migrate** from the implant
  site, which is why `PetIdentity.implantSite` is recorded.

This is why `MicrochipStandard` models `non-iso-125` and `non-iso-128` as
first-class values with their own 9/10-digit validation, rather than forcing
every chip into a 15-digit field it does not fit.

---

## 4. A chip with no registration reunites nobody

This is the failure mode that actually loses animals.

The chip stores **only a number**. It contains no owner name, no phone number,
and no address. Turning that number back into a person requires a **registry**
that maps number → contact details. If the chip was never registered, or the
registered phone number is three years stale, the scan produces a number that
resolves to nothing.

The US has **no central registry** — multiple competing commercial databases
each hold their own records. Europe has national databases of varying
interoperability.

**Implications for this project:**

- `PetIdentity.externalRegistry` / `externalRegistryId` exist so a shelter can
  record *whether and where* a chip is registered externally. "Implanted" and
  "registered" are different facts and conflating them is how animals get lost.
- For Bolivia specifically (see §6), there is no national registry to defer to,
  which means **this system is effectively the registry of record** for the
  animals it handles. That is a responsibility, not a feature: the contact data
  in it has to stay current or the whole chain breaks.
- `findPetByMicrochip()` in `pets-server.ts` is the lookup that closes the
  loop. It deliberately returns only the **public** record — a finder learns
  which animal it is and how to make contact, without gaining the ability to
  enumerate the registry or read anyone's address.

---

## 5. Regulation

### EU — Regulation (EU) No 576/2013

Governs non-commercial movement of dogs, cats, and ferrets. Requires an
**ISO 11784/11785-compliant transponder**, a valid rabies vaccination, and an
EU pet passport.

**The ordering rule.** The transponder must be implanted **before** the rabies
vaccination. A vaccination administered first is **invalid and must be
redone** — a real cost to a shelter and a real delay to an international
adoption. Rabies validity additionally begins no less than 21 days after the
primary vaccination protocol completes.

This is encoded as `rabiesVaccinationIsValid()` so it can be caught at data
entry rather than at a border. It is a genuine business rule, not a formality.

### EU — mandatory microchipping

The EU has moved toward compulsory microchipping and registration of dogs and
cats in **interoperable national databases**. Member states are implementing
this on their own timelines.

### United Kingdom

- **Dogs:** compulsory since **6 April 2016**
- **Cats (England):** compulsory since **10 June 2024**
- Non-compliance carries a fine of up to **£500**

### Elsewhere

Thailand made microchipping compulsory under the Animal Control Ordinance
B.E. 2567, effective January 2026. Poland has draft legislation pending.

### Data protection (GDPR and equivalents)

A microchip registry holds **personal data about the owner**, not just the
animal — name, address, phone number. That places it squarely inside GDPR for
any EU deployment, with penalties up to **€20 million or 4% of annual
turnover**.

Directly relevant to this codebase:

- Established registries let owners **control what is revealed on a scan**;
  contact details are not public by default.
- This is why the microchip number sits in the **restricted** tier
  (`pets/{id}/identity/microchip`) rather than the merely-authenticated one.
  Creating an account is not a reason to learn every chipped animal's number,
  and the number is the credential by which ownership gets asserted.
- The **scan ledger is restricted for the same reason, more strongly**. One
  location is an address; a scan history is a pattern of movement over time —
  for an adopted pet, effectively a trail of its owner's vet, neighbourhood,
  and routine.

---

## 6. Bolivia (the reference deployment)

**Ley 700** (1 June 2015) is Bolivia's animal protection framework, covering
violence, cruelty, and mistreatment. It is a welfare statute rather than an
identification regime.

Microchip requirements exist at the **municipal** level and are narrow —
notably, subcutaneous microchip identification tied to licensing of dogs
classified as dangerous. There is **no comprehensive national mandatory
microchipping or registration scheme** for companion animals.

Activists have proposed repealing and replacing Ley 700 with stronger
legislation, so this may change.

**Practical consequence:** there is no national registry to integrate with, and
no legal template to inherit. This system is the registry of record. Chips
should still be **ISO 11784/11785**, both because the international standard is
the right default and because it keeps an internationally adopted animal
eligible under EU rules.

---

## Sources

- [ISO 11784 and ISO 11785 — Wikipedia](https://en.wikipedia.org/wiki/ISO_11784_and_ISO_11785)
- [ICAR — Guidelines for Testing and Certification of Animal Identification (Section 10)](https://www.icar.org/Guidelines/10-Identification-Device-Certification.pdf)
- [ICAR Manufacturer Codes](https://www.service-icar.com/tables/Tabella3.php)
- [AVMA — Microchipping FAQs for pet owners](https://www.avma.org/resources-tools/pet-owners/petcare/microchips-reunite-pets-families/microchipping-faq)
- [AVMA — Microchipping of animals](https://www.avma.org/resources-tools/animal-health-and-welfare/microchipping-animals)
- [WSAVA — Microchip Identification Guidelines](https://wsava.org/global-guidelines/microchip-identification-guidelines/)
- [Regulation (EU) No 576/2013 — EUR-Lex](https://eur-lex.europa.eu/legal-content/EN/TXT/PDF/?uri=CELEX:32013R0576)
- [European Commission — Non-commercial movement of pets within the EU](https://food.ec.europa.eu/animals/movement-pets/eu-legislation/non-commercial-movement-within-eu_en)
- [ManyPets — Compulsory microchipping in UK law](https://manypets.com/uk/articles/guide-to-new-microchipping-of-dogs-law/)
- [Notes From Poland — Compulsory microchipping and registration proposal](https://notesfrompoland.com/2026/04/20/poland-seeks-to-introduce-compulsory-microchipping-and-registration-for-pet-dogs-and-cats/)
- [Ley N° 700 de 1 de junio de 2015 (Bolivia) — FAOLEX](https://faolex.fao.org/docs/pdf/bol146525.pdf)
- [Microchip Central — GDPR and microchipping of pets](https://www.microchipcentral.com/gdpr/)
