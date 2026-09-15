# Accounts: Google sign-in, reCAPTCHA, email from wawitas.org

Runbook for turning on what `feat/account-management` built. The code ships
**inert**: until the steps below run, sign-in works exactly as before, emails
still come from `noreply@wawitas.firebaseapp.com` in English, and the Google
button answers "esa forma de entrar no está habilitada".

Do the steps **in order**. Each one says what proves it worked.

| # | Step | Who | Reversible |
|---|---|---|---|
| 1 | Merge and deploy | agent / owner | redeploy |
| 2 | Release the rules | agent | redeploy the previous ruleset |
| 3 | Spanish emails + action URL + password policy | agent | `--emails` is re-runnable |
| 4 | reCAPTCHA in AUDIT | agent | `--recaptcha off` |
| 5 | Google provider + consent screen | **owner, in the console** | disable the provider |
| 6 | Resend: domain, DNS, API key | **owner** | `--default-sender` |
| 7 | Send through Resend | agent, with the key on stdin | `--default-sender` |
| 8 | reCAPTCHA to ENFORCE | agent, after measuring | `--recaptcha audit` |
| 9 | *(optional)* `authDomain` → wawitas.org | owner | revert the variable |

---

## 1. Merge and deploy

Nothing below may run before `/account/action` is live, because step 3 points
every email link at it. `scripts/auth-config.mjs` checks this and refuses.

**Proof:** `curl -sI https://wawitas.org/account/action` → `200`, and the
deployed Cloud Run tag equals `git rev-parse master`.

## 2. Release the rules

Two changes, both probed first through the Rules test API (nothing released):

```bash
GOOGLE_CLOUD_PROJECT=wawitas npm run probe:account-rules
```

- `firestore.rules` — `users/{uid}`: the email must be the token's own, the
  name 1–60 characters, the photo a Google photo or the person's own upload.
- `storage.rules` — new `users/{uid}/avatar/{fileName}`: owner writes JPEGs
  under 2 MB, owner and admins read.

```bash
firebase login:list
```

```bash
firebase deploy --only firestore:rules
```

```bash
npm run deploy:storage-rules
```

⚠️ `firebase deploy --only storage` does not work on this project — use the
npm script. Check `firebase login:list` shows the personal account first; the
CLI is a separate credential store from gcloud and ADC.

**Proof:** read the released rulesets back and diff them with line endings
normalised on both sides (the project log explains why a naive byte diff of
`storage.rules` always reports drift on this machine).

## 3. Spanish emails, action URL, password policy

```bash
GOOGLE_CLOUD_PROJECT=wawitas npm run auth:config -- --emails --password-policy
```

That is a dry run. Read the plan, then add `--apply`.

It sets:

- `notification.sendEmail.callbackUri` → `https://wawitas.org/account/action`
- the three templates (verify, reset, email changed) from `es.authEmails()`
- `notification.defaultLocale` → `es`
- a server-side 8-character minimum, **without** forcing existing accounts to
  change a shorter password (`forceUpgradeOnSignin: false`)

**Proof:** the script reads the config back and prints PASS/FAIL per field.
Then request a reset for your own address at `/account` and check the email
is in Spanish and its link opens `wawitas.org/account/action`.

⚠️ Emails still come from `@wawitas.firebaseapp.com` until step 7.

## 4. reCAPTCHA Enterprise, AUDIT

Protects sign-up, sign-in and password reset. Invisible — no puzzle. The API
(`recaptchaenterprise.googleapis.com`) is already enabled by Terraform.

Identity Platform needs its service agent to create the reCAPTCHA keys. Once
per project:

```bash
gcloud beta services identity create --service=identitytoolkit.googleapis.com --project=wawitas
```

Grant that agent `roles/identitytoolkit.serviceAgent` if the command does not
say it already has it. Then:

```bash
GOOGLE_CLOUD_PROJECT=wawitas npm run auth:config -- --recaptcha audit --apply
```

AUDIT scores every request and blocks nothing, so clients still loading the
previous bundle keep working.

**Proof:** read-back PASS; the Network tab on `/account` shows a request to
`www.google.com/recaptcha/enterprise.js`; after a few sign-ins, reCAPTCHA
metrics appear under Identity Platform → Settings → Security.

## 5. Google sign-in (owner, console)

1. Firebase console → **Authentication → Sign-in method → Add new provider →
   Google** → Enable.
2. "Public-facing name": **Wawitas**. "Support email": an address the shelter
   reads. Save. This also creates the web OAuth client.
3. Google Cloud console → **Google Auth Platform → Branding**: add
   `wawitas.org` under *Authorized domains*. Do **not** upload a logo unless
   you intend to go through brand verification — a logo triggers it.
4. **Audience**: *External*, and **Publish app** (status "In production").
   In "Testing", only listed test users can sign in and their sessions expire
   after 7 days. Basic scopes (email, profile) need no verification.

**Proof:** at `https://wawitas.org/account`, "Continuar con Google" opens the
account chooser in Spanish, and after choosing an account `/account` shows the
Google name and photo.

⚠️ Inside Facebook's or Instagram's built-in browser Google refuses OAuth
("disallowed_useragent"). The page detects that and says to open the page in
Chrome or Safari; this is expected, not a bug.

## 6. Resend (owner)

1. Create the Resend account.
2. **Domains → Add domain → `wawitas.org`**.
3. Resend lists DNS records. Add them at **Spaceship** exactly as shown —
   typically:
   - `MX` on `send` → Resend's feedback host, priority 10
   - `TXT` on `send` → an SPF record (`v=spf1 include:… ~all`)
   - `TXT` on `resend._domainkey` → the DKIM key
   - recommended: `TXT` on `_dmarc` → `v=DMARC1; p=none;`

   These are all on subdomains, so they do not touch the apex `A` record that
   points `wawitas.org` at Firebase Hosting. Spaceship's Host field takes the
   subdomain part only (`send`, `resend._domainkey`, `_dmarc`).
4. Wait for Resend to show the domain **Verified**.
5. **API Keys → Create**: permission *Sending access*, domain `wawitas.org`
   only. Copy it once; Resend will not show it again.

Check Resend's current free-tier limits before relying on them — auth emails
are low volume, but a sign-up spike counts against the daily cap.

## 7. Send through Resend

```bash
GOOGLE_CLOUD_PROJECT=wawitas npm run auth:config -- --smtp --sender no-responder@wawitas.org --apply
```

Paste the API key when asked (it reads stdin, so the key stays out of argv and
shell history), then Ctrl-D (Ctrl-Z, Enter on Windows).

The key lives only in Identity Platform's config. It is not in Secret Manager,
not in Terraform state, and not in the repo. To rotate: create a new key at
Resend, run this step again, then delete the old key at Resend.

**Proof:** request a reset for your own address. The email arrives from
`no-responder@wawitas.org`, and its headers show `dkim=pass` for
`wawitas.org`. It also appears in Resend's *Emails* list.

**Rollback:** `npm run auth:config -- --default-sender --apply`.

## 8. reCAPTCHA to ENFORCE

After at least a week in AUDIT, and only once the metrics show real sign-ins
scoring well above 0.3:

```bash
GOOGLE_CLOUD_PROJECT=wawitas npm run auth:config -- --recaptcha enforce --apply
```

ENFORCE rejects any sign-up, sign-in or reset without a valid token. Every
deployed bundle since this feature sends one; an old cached tab does not.

**Rollback:** `--recaptcha audit --apply`.

## 9. *(Optional)* `authDomain` on wawitas.org

Today the Google window says *"to continue to wawitas.firebaseapp.com"* — a
domain visitors have never seen. Measured 2026-09-15: Firebase Hosting already
serves `/__/auth/handler` on `wawitas.org` (200), so it can be the auth domain.

1. In the OAuth client created in step 5 (Google Auth Platform → Clients →
   *Web client (auto created by Google Service)*), add
   `https://wawitas.org/__/auth/handler` to **Authorized redirect URIs**.
2. Set the GitHub repository variable `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` to
   `wawitas.org`, and the same in `.env.local`.
3. Redeploy. It is a **build** argument: changing the variable does nothing
   until the next image is built.

**Proof:** the Google window names `wawitas.org`.

---

## Known limits

- **Deleting an account keeps the person's adoption applications.** They are
  the shelter's record of what happened to an animal. The screen says so
  before confirming, and says to ask on WhatsApp for their removal. Whether
  that is the right default is the owner's decision.
- **Admins cannot delete their own account** from `/account`. Revoke the claim
  first with `npm run grant:admin -- <email> --revoke`.
- **A profile photo URL is a Firebase download URL**, whose token lets anyone
  holding the URL fetch it. It is stored only where the person and admins can
  read it, and it appears on no public page. A Google photo URL is equally
  fetchable.
- **No multi-factor authentication** yet. Identity Platform supports SMS and
  TOTP; neither is wired.
