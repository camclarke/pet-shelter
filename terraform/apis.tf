# Every API this project touches, enabled explicitly. `disable_on_destroy =
# false` because disabling an API as a side effect of `terraform destroy` has
# broken more projects than it's protected — enabling APIs is Terraform's job,
# disabling them is an operator decision.

locals {
  required_apis = [
    "run.googleapis.com",                # Cloud Run
    "artifactregistry.googleapis.com",   # container images for Cloud Run
    "firestore.googleapis.com",          # the database
    "firebase.googleapis.com",           # Firebase project linkage (Hosting, Auth)
    "identitytoolkit.googleapis.com",    # Firebase Authentication
    "storage.googleapis.com",            # Cloud Storage (dog photos, sighting photos)
    "secretmanager.googleapis.com",      # runtime secrets for Cloud Run
    "cloudbilling.googleapis.com",       # required to read/manage the budget alert
    "billingbudgets.googleapis.com",     # the budget alert itself
    "maps-backend.googleapis.com",       # Maps JavaScript API
    "recaptchaenterprise.googleapis.com" # App Check, for the public sightings endpoint
  ]
}

resource "google_project_service" "required" {
  for_each = toset(local.required_apis)

  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}
