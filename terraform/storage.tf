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

  # adoption-ids/: an applicant's identity-card photo. Once one is deleted (the
  # retention sweep, an erase request), it must not live on as a noncurrent
  # version: the rule above never removes the LAST noncurrent version of a
  # deleted object, because that one never gets 3 newer versions. Measured
  # 2026-10-15: 58 live objects, 132 versions in this bucket.
  #
  # ⚠️ THIS IS THE ONE RULE IN THIS FILE THAT CAN DELETE LIVE ID PHOTOS.
  # GCS ANDs the conditions, and each of the three below is load-bearing:
  #   - matches_prefix: without it (or with it empty) the rule is BUCKET-WIDE
  #     and deletes every noncurrent pet photo and card scan — that is a
  #     separate decision (finding F1), not this one.
  #   - with_state = "ARCHIVED": noncurrent versions only (isLive = false).
  #     Omitted, the provider sends "ANY", and the rule then matches LIVE
  #     objects too.
  #   - days_since_noncurrent_time = 1, never 0. Provider 6.x does NOT send a
  #     zero unless a send_*_if_zero flag is set, so `= 0` reaches GCS as
  #     `{matchesPrefix: ["adoption-ids/"]}` alone — which matches every live
  #     ID photo, open applications included.
  # Never add `age` (deletes live photos after N days without the ARCHIVED
  # guard), `num_newer_versions` or any `send_*_if_zero` here.
  # Kept AFTER the rule above on purpose: `lifecycle_rule` is an ordered list,
  # and inserting this first makes the plan read as though rule 0 changed.
  # src/lib/__tests__/storage-lifecycle.test.ts pins every line of this block.
  lifecycle_rule {
    condition {
      matches_prefix             = ["adoption-ids/"]
      with_state                 = "ARCHIVED"
      days_since_noncurrent_time = 1
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
