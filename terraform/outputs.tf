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

output "storage_bucket" {
  description = "Bucket backing Storage for Firebase — matches storage.rules' bucket."
  value       = google_storage_bucket.app.name
}
