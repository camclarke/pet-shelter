# ─────────────────────────────────────────────────────────────────────────────
# The custom domain: wawitas.org.
#
# ── Why Firebase Hosting rather than a Cloud Run domain mapping ─────────────
# Both were checked against this project on 2026-08-22 rather than assumed.
# Cloud Run domain mappings ARE available in us-east1 (`gcloud beta run
# domain-mappings list --region=us-east1` answers rather than erroring), so
# the alternative is real — it is just worse here, for two reasons:
#
#   1. A domain mapping has NO CDN. Every request, including every hashed JS
#      chunk and every photograph, would cross ~5,000 km to us-east1. This
#      site's audience browses on mid-range Android over mobile data in
#      Cochabamba, and next.config.ts already treats image weight as the
#      dominant cost. Firebase Hosting puts all of that on an edge.
#   2. Google's own guidance steers production traffic to an external HTTP(S)
#      Load Balancer instead, which is ~$18/month of forwarding rules before
#      a single request. That fails the constraint at the top of CLAUDE.md's
#      Architecture section, which every other decision here is downstream of.
#
# Firebase Hosting gives the custom domain, a managed certificate, and the CDN
# for $0. The rewrite in firebase.json is what carries SSR through to Cloud
# Run. That was already the documented architecture; this file executes it.
#
# ── Ownership split ────────────────────────────────────────────────────────
# Terraform owns the DOMAIN (infrastructure). The Firebase CLI owns the
# RELEASE — the uploaded files and the rewrite config — because that is
# app-layer config, exactly like firestore.rules. CLAUDE.md's division holds
# without amendment.
#
# The Hosting SITE itself is deliberately NOT declared here. `wawitas` is the
# DEFAULT_SITE, created as a byproduct of google_firebase_project.default, and
# its site_id always equals the project id. Importing it would put a resource
# under Terraform's control that Terraform did not create and cannot
# meaningfully recreate — and would hand `terraform destroy` a way to delete
# the site out from under the domain. Referencing it by id is enough.
# ─────────────────────────────────────────────────────────────────────────────

locals {
  # The default Hosting site's id is the project id. Verified against
  # firebasehosting.googleapis.com: projects/wawitas/sites/wawitas, type
  # DEFAULT_SITE, defaultUrl https://wawitas.web.app.
  hosting_site_id = var.project_id
}

# ── Apex, and it is the canonical one ───────────────────────────────────────
#
# The shelter's reach is WhatsApp, Instagram bio, and printed flyers, where
# every character is read aloud or typed by hand. "wawitas.org" is the name
# the organisation already uses; "www." is four more characters that earn
# nothing. Firebase Hosting serves an apex directly over anycast A/AAAA
# records, so the usual "you cannot CNAME an apex" objection does not apply.
resource "google_firebase_hosting_custom_domain" "apex" {
  provider      = google-beta
  project       = var.project_id
  site_id       = local.hosting_site_id
  custom_domain = "wawitas.org"

  # false on purpose. The DNS records this resource requires do not exist
  # until a human has entered them at the registrar (Spaceship), so waiting
  # would block `apply` on an action `apply` itself cannot take. Create the
  # resource, read `required_dns_updates` out of the output below, enter the
  # records, and let Firebase reconcile asynchronously.
  wait_dns_verification = false
}

# ── www redirects to the apex ───────────────────────────────────────────────
#
# Registered rather than left unclaimed: someone WILL type it, and an
# unregistered www is a dead page rather than a redirect. `redirect_target`
# makes Firebase issue the 301 itself, so no application code and no extra
# rewrite rule is involved.
#
# This still needs its own DNS record at Spaceship — a redirect is served by
# Hosting, so the name has to resolve to Hosting first.
resource "google_firebase_hosting_custom_domain" "www" {
  provider        = google-beta
  project         = var.project_id
  site_id         = local.hosting_site_id
  custom_domain   = "www.wawitas.org"
  redirect_target = "wawitas.org"

  wait_dns_verification = false
}
