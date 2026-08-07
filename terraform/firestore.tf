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

  depends_on = [google_project_service.required]
}
