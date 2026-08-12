# `user_project_override` + `billing_project` added 2026-08-12, carried over
# from the sibling stack. Without them, some API calls — notably the Firebase
# ones — are quota'd and billed against whatever project Application Default
# Credentials happen to default to, rather than against the target project.
# On this machine ADC defaults to the employer's `trustcert-ai-g`, so this is
# not a theoretical tidiness fix: it is the difference between a call being
# attributed to the shelter or to the work project.

provider "google" {
  project               = var.project_id
  region                = var.region
  user_project_override = true
  billing_project       = var.project_id
}

# Some resources this project needs — Firebase-linked Storage buckets in
# particular — are still gated behind the beta provider. Kept as a separate
# provider block so it's obvious at a glance which resources depend on it.
provider "google-beta" {
  project               = var.project_id
  region                = var.region
  user_project_override = true
  billing_project       = var.project_id
}
