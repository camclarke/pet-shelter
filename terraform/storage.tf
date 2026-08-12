# One bucket for everything Storage-facing: pet photos, sighting photos, and
# (Stage 2) vaccination card scans. storage.rules — deployed via the Firebase
# CLI, same division of responsibility as Firestore above — already
# partitions access by path prefix (pets/, sightings/, medical/),
# so a single bucket is simpler than three and costs nothing extra.

resource "google_storage_bucket" "app" {
  project  = var.project_id
  name     = "${var.project_id}-app"
  location = var.region

  # Uniform access means IAM only, no per-object ACLs — the surface that
  # matters here is storage.rules, evaluated by Firebase, not bucket ACLs.
  uniform_bucket_level_access = true

  # A public sighting photo upload is exactly the kind of write that should
  # never silently become permanent. Cheap enough to leave on always.
  versioning {
    enabled = true
  }

  lifecycle_rule {
    condition {
      age                = 90
      num_newer_versions = 3
    }
    action {
      type = "Delete"
    }
  }

  cors {
    origin          = ["https://wawitas.org", "http://localhost:3000"]
    method          = ["GET", "HEAD"]
    response_header = ["Content-Type"]
    max_age_seconds = 3600
  }

  depends_on = [google_project_service.required]
}

# Links the bucket into the Firebase project so the Firebase Storage SDK and
# storage.rules can address it as the default bucket. Without this the bucket
# is just a plain GCS bucket that firebase.json's storage config can't reach.
resource "google_firebase_storage_bucket" "app" {
  provider  = google-beta
  project   = var.project_id
  bucket_id = google_storage_bucket.app.name

  # Added 2026-08-12. This needs both `firebasestorage.googleapis.com` and
  # `firebase.googleapis.com`, neither of which is enabled by default on a new
  # project. The reference to google_storage_bucket.app orders it after the
  # bucket but says nothing about the APIs — so without this it races the
  # enablement and fails at apply, invisibly to `plan`.
  depends_on = [google_project_service.required]
}
