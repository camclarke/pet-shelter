# Terraform owns the DATABASE INSTANCE — location, type, deletion protection.
# It does NOT own firestore.rules or firestore.indexes.json: those are
# deployed with `firebase deploy --only firestore:rules,firestore:indexes`.
# See CLAUDE.md § Terraform for why that split is deliberate rather than
# accidental — Terraform's Firestore-rules support is too thin to trust as
# the source of truth for a security-critical file.

resource "google_firestore_database" "default" {
  project     = var.project_id
  name        = "(default)"
  location_id = var.region
  type        = "FIRESTORE_NATIVE"

  # Two independent safety nets, deliberately redundant: `deletion_policy`
  # controls what Terraform itself will do; `delete_protection_state` controls
  # what the Firestore API will allow regardless of who's asking. A shelter's
  # pet and adopter records should not disappear because of a `terraform
  # destroy` run against the wrong workspace.
  deletion_policy         = "ABANDON"
  delete_protection_state = "DELETE_PROTECTION_ENABLED"

  # Added 2026-08-12. Delete protection stops the database being *removed*; it
  # does nothing about a bad write or a retention sweep that deletes the wrong
  # documents. PITR gives a 7-day rewind window for exactly that case. The
  # argument is the sibling stack's 2026-07-12 incident: data that is correct
  # but unrecoverable is one bug away from wrong and unrecoverable.
  point_in_time_recovery_enablement = "POINT_IN_TIME_RECOVERY_ENABLED"

  depends_on = [google_project_service.required]
}

# PITR covers the last 7 days. Scheduled backups cover everything older, and
# survive the database itself. Two schedules because they answer different
# questions: "undo yesterday's mistake" and "what did this look like a month
# ago, when the vet says the record was different."
#
# Cost note, against this project's $0 target: PITR and backups both bill for
# storage (backups ~$0.03/GiB/month). At a few thousand pet documents this
# rounds to nothing, but it is not literally free — it is the first deliberate
# non-zero line item, and it buys recoverability for a shelter's only copy of
# its adoption and medical records.

resource "google_firestore_backup_schedule" "daily" {
  project  = var.project_id
  database = google_firestore_database.default.name

  retention = "1209600s" # 14 days

  daily_recurrence {}
}

resource "google_firestore_backup_schedule" "weekly" {
  project  = var.project_id
  database = google_firestore_database.default.name

  retention = "8467200s" # 14 weeks — the documented maximum

  weekly_recurrence {
    day = "SUNDAY"
  }
}
