output "cloud_run_url" {
  description = "The Cloud Run service's own URL. Firebase Hosting rewrites to this; useful for testing a deploy before it's live on the custom domain."
  value       = google_cloud_run_v2_service.app.uri
}

output "cloud_run_service_name" {
  description = "Must match the serviceId in firebase.json's hosting.rewrites."
  value       = google_cloud_run_v2_service.app.name
}

output "artifact_registry_repository" {
  description = "Push images here: {region}-docker.pkg.dev/{project}/{repo}/{image}:{tag}"
  value       = google_artifact_registry_repository.app.repository_id
}

output "cloud_run_service_account" {
  description = "Runtime identity of the Cloud Run service. Grant any future least-privilege IAM to this, not to the Compute Engine default SA."
  value       = google_service_account.cloud_run.email
}

// ── CI/CD ───────────────────────────────────────────────────────────────────
// These two are the values GitHub Actions needs. Neither is a secret — they
// are resource identifiers, and they are useless to anyone whose OIDC token
// does not carry the pinned repository claim. That is the entire point of
// Workload Identity Federation: there is no key to leak. They are stored as
// GitHub repository *variables* rather than secrets so that a failing auth
// step prints what it actually tried to use instead of `***`.

output "workload_identity_provider" {
  description = "Set as the GitHub repository variable GCP_WORKLOAD_IDENTITY_PROVIDER."
  value       = google_iam_workload_identity_pool_provider.github.name
}

output "ci_service_account" {
  description = "Set as the GitHub repository variable GCP_CI_SERVICE_ACCOUNT."
  value       = google_service_account.ci.email
}

output "container_image_base" {
  description = "Image path CI tags with the commit SHA, minus the tag."
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.app.repository_id}/app"
}

output "storage_bucket" {
  description = "Bucket backing Storage for Firebase — matches storage.rules' bucket."
  value       = google_storage_bucket.app.name
}
