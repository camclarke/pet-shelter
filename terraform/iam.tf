# The Cloud Run runtime identity. Deliberately its own service account rather
# than the Compute Engine default one — the default SA carries the broad
# "Editor" role in older projects and is exactly the kind of ambient
# over-privilege a least-privilege setup exists to avoid.
resource "google_service_account" "cloud_run" {
  project      = var.project_id
  account_id   = "${var.app_name}-run"
  display_name = "Cloud Run runtime — ${var.app_name}"
}

# Firestore access, via the Admin SDK inside the Next.js server. Not
# "roles/editor", not "roles/datastore.owner" — just read/write to documents,
# which is all dogs-server.ts ever does.
resource "google_project_iam_member" "cloud_run_datastore" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.cloud_run.email}"
}

# Read/write on the app bucket specifically — not project-wide Storage admin.
resource "google_storage_bucket_iam_member" "cloud_run_storage" {
  bucket = google_storage_bucket.app.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.cloud_run.email}"
}

# Cloud Run needs this to verify Firebase Auth ID tokens passed from the
# client (once auth lands) and to mint custom tokens / set the admin claim
# from the admin console.
resource "google_project_iam_member" "cloud_run_firebase_auth" {
  project = var.project_id
  role    = "roles/firebaseauth.admin"
  member  = "serviceAccount:${google_service_account.cloud_run.email}"
}

# Server-only secrets (none exist yet, but the wiring belongs here rather
# than being bolted on later under time pressure).
resource "google_project_iam_member" "cloud_run_secrets" {
  project = var.project_id
  role    = "roles/secretmanager.secretAccessor"
  member  = "serviceAccount:${google_service_account.cloud_run.email}"
}

# Public, unauthenticated access to the Cloud Run service itself. This is
# safe and intended: the service serves the public site, and Firestore/Storage
# authorization happens in firestore.rules / storage.rules regardless of who
# can reach the Next.js server. Firebase Hosting's rewrite also requires the
# backing service to accept unauthenticated invocations.
resource "google_cloud_run_v2_service_iam_member" "public_invoker" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.app.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}
