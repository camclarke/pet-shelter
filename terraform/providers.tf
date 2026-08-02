provider "google" {
  project = var.project_id
  region  = var.region
}

# Some resources this project needs — Firebase-linked Storage buckets in
# particular — are still gated behind the beta provider. Kept as a separate
# provider block so it's obvious at a glance which resources depend on it.
provider "google-beta" {
  project = var.project_id
  region  = var.region
}
