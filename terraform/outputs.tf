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

// ── Firebase web app config ─────────────────────────────────────────────────
// The four values .env.local has carried as empty placeholders since it was
// created, plus the two already known from the project itself.
//
// NOT marked sensitive, and that is correct rather than an oversight. Every
// NEXT_PUBLIC_* value is compiled into the browser bundle by `next build` and
// served to anyone who loads the site — a Firebase web API key identifies the
// project, it does not authorise anything. firestore.rules is what protects
// the data. Marking these sensitive would hide them from `terraform output`
// while changing nothing about who can see them, and would only make the one
// step that needs them harder.
//
// This is a genuinely different case from the sibling stack's leaked salt,
// which was a real secret that appeared in plan output and had to be rotated.
// The distinction is worth keeping sharp: public-by-design is not the same as
// low-risk-in-practice.

output "firebase_web_config" {
  description = "Fill these into .env.local AND into the GitHub repository variables the deploy workflow reads. They are BUILD-time values inlined by `next build`, not Cloud Run env vars — setting them on the service does nothing at all."
  value = {
    NEXT_PUBLIC_FIREBASE_API_KEY             = data.google_firebase_web_app_config.web.api_key
    NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN         = data.google_firebase_web_app_config.web.auth_domain
    NEXT_PUBLIC_FIREBASE_PROJECT_ID          = var.project_id
    NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET      = google_storage_bucket.app.name
    NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID = data.google_firebase_web_app_config.web.messaging_sender_id
    NEXT_PUBLIC_FIREBASE_APP_ID              = google_firebase_web_app.web.app_id
  }
}

// ── Custom domain (wawitas.org) ─────────────────────────────────────────────
// The records that have to be entered by hand at Spaceship, where wawitas.org's
// DNS is managed. Firebase computes these; they are not guessable, because the
// ownership TXT value is unique per site and per domain.
//
// Read them AFTER `terraform apply`. Both domains are created with
// `wait_dns_verification = false`, so apply returns immediately and Firebase
// reconciles once the records resolve — meaning this output is the handoff
// point between the part Terraform can do and the part it cannot.
//
//   terraform output -json custom_domain_dns_records
//
// `host_state` and `ownership_state` are the two fields to watch. They go
// PENDING -> ACTIVE / OWNERSHIP_ACTIVE as DNS propagates. A domain showing
// ACTIVE is still not proof the site serves — the certificate is provisioned
// separately and takes longer. Verify by fetching the URL over HTTPS.

output "custom_domain_dns_records" {
  description = "DNS records to create at the registrar, per domain. Enter these in Spaceship's DNS panel."
  value = {
    for d in [
      google_firebase_hosting_custom_domain.apex,
      google_firebase_hosting_custom_domain.www,
      ] : d.custom_domain => {
      host_state           = d.host_state
      ownership_state      = d.ownership_state
      cert_state           = try(d.cert[0].state, null)
      required_dns_updates = d.required_dns_updates
    }
  }
}
