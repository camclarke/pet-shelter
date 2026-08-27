# Server-only runtime secrets.
#
# ── Why the VALUE is not in here ─────────────────────────────────────────────
# This file declares the secret *container* and nothing else. The version that
# carries the actual key is added out of band with `gcloud secrets versions
# add`, deliberately, and is NOT a `google_secret_manager_secret_version`
# resource.
#
# The reason is that Terraform state stores resource attributes in plaintext.
# A `secret_version` resource would put the API key into
# gs://wawitas-terraform-state, into every local `.terraform` plan file, and
# potentially into `plan` output on a terminal or in CI logs. The sibling stack
# leaked a salt exactly that way and had to rotate it
# (docs/gcp-lessons-from-trustcert.md §6). Splitting container from value means
# the key exists in precisely two places: Secret Manager, and the developer's
# gitignored .env.local.
#
# The cost is that `terraform apply` cannot tell you whether a version exists.
# That is what `var.gemini_api_key_enabled` in cloud_run.tf is for — see the
# runbook below.
#
# ── THE ORDERING TRAP — READ BEFORE APPLYING ─────────────────────────────────
# Secrets are created EMPTY. Cloud Run resolves a `version = "latest"` binding
# at revision start, so binding an empty secret makes the new revision fail its
# startup probe — and because traffic is pinned to LATEST, that is a live
# outage on wawitas.org, not a failed deploy sitting harmlessly to one side.
#
# So this is THREE steps, never one:
#
#   1. terraform apply                       # creates the empty secret only
#   2. gcloud secrets versions add gemini-api-key \
#        --project=wawitas --data-file=-     # paste the key, then Ctrl-D
#      (--data-file=- reads stdin so the key never lands in shell history)
#   3. set gemini_api_key_enabled = true in terraform.tfvars, then apply again
#
# Verify between 2 and 3:
#   gcloud secrets versions list gemini-api-key --project=wawitas
#
# To rotate: add a new version (step 2 again). `latest` is resolved per
# revision, so the new value is picked up by the next deploy — not instantly by
# the running one. Force it with a no-op Cloud Run deploy if it must be
# immediate.

resource "google_secret_manager_secret" "gemini_api_key" {
  project   = var.project_id
  secret_id = "gemini-api-key"

  # Automatic replication rather than user_managed. There is no data-residency
  # requirement — this is an API key, not personal data — and pinning a
  # location adds an apply-time failure mode (the region must support Secret
  # Manager) for no benefit here. Apply-time-only failures are the single
  # most-repeated lesson in the GCP playbook, so one fewer is worth having.
  replication {
    auto {}
  }

  labels = {
    app       = var.app_name
    component = "ai"
  }

  depends_on = [google_project_service.required]
}

# NOTE ON ACCESS: the Cloud Run runtime service account already holds
# roles/secretmanager.secretAccessor at the PROJECT level, granted in iam.tf
# before any secret existed. That is broader than this one secret needs. It is
# left as is rather than tightened here, because narrowing it is a change to a
# live binding that deserves its own commit and its own verification — and with
# exactly one secret in the project the two are equivalent in practice. If a
# second secret is ever added that Cloud Run should NOT read, tighten it then,
# and that is the moment it stops being equivalent.
