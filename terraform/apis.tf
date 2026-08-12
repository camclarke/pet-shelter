# Every API this project touches, enabled explicitly. `disable_on_destroy =
# false` because disabling an API as a side effect of `terraform destroy` has
# broken more projects than it's protected — enabling APIs is Terraform's job,
# disabling them is an operator decision.

locals {
  required_apis = [
    "run.googleapis.com",                 # Cloud Run
    "artifactregistry.googleapis.com",    # container images for Cloud Run
    "firestore.googleapis.com",           # the database
    "firebase.googleapis.com",            # Firebase project linkage (Hosting, Auth)
    "identitytoolkit.googleapis.com",     # Firebase Authentication
    "storage.googleapis.com",             # Cloud Storage (pet photos, sighting photos)
    "secretmanager.googleapis.com",       # runtime secrets for Cloud Run
    "cloudbilling.googleapis.com",        # required to read/manage the budget alert
    "billingbudgets.googleapis.com",      # the budget alert itself
    "maps-backend.googleapis.com",        # Maps JavaScript API
    "recaptchaenterprise.googleapis.com", # App Check, for the public sightings endpoint

    # ── Added 2026-08-12, before the first apply ────────────────────────────
    # These three are used by resources already declared in this directory but
    # were never enabled. `validate` and `plan` are structurally blind to a
    # missing API — the failure appears only at apply, which is the single
    # most-repeated lesson in docs/gcp-lessons-from-trustcert.md.
    "monitoring.googleapis.com",           # google_monitoring_notification_channel (budget.tf)
    "firebasestorage.googleapis.com",      # google_firebase_storage_bucket (storage.tf)
    "cloudresourcemanager.googleapis.com", # project-level reads/IAM by both providers

    # Added 2026-08-12. There is no local Docker on the dev machine, so images
    # are built server-side with `gcloud builds submit` rather than `docker
    # build`. Not referenced by any resource here — Terraform does not build
    # images — but the build step is part of the deploy path, so the API
    # belongs in the declared set rather than being enabled by hand.
    "cloudbuild.googleapis.com"
  ]
}

resource "google_project_service" "required" {
  for_each = toset(local.required_apis)

  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}
