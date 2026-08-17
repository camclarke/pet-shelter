# ─────────────────────────────────────────────────────────────────────────────
# Firebase project linkage and the web app.
#
# Written 2026-08-16, after discovering that the GCP project had NEVER been
# added to Firebase. `firebase projects:list` returned "No projects found" and
# the Management API answered `searchApps` with
# "Firebase project 181094228409 not found".
#
# That single fact explains a cluster of symptoms CLAUDE.md had attributed to
# other causes — most importantly the undeployable storage.rules, which was
# recorded as "needs a Firebase default bucket" when the real reason was that
# there was no Firebase project to hold any bucket at all.
#
# Two things kept working throughout and are worth understanding, because they
# are why the gap went unnoticed for four days:
#   • firestore.rules and firestore.indexes.json deploy through
#     firebaserules.googleapis.com / firestore.googleapis.com, which are plain
#     GCP APIs and need no Firebase project. They deployed successfully.
#   • google_firebase_storage_bucket applied against
#     firebasestorage.googleapis.com, also project-level. `wawitas-app` is
#     genuinely registered — confirmed by API, not inferred from state.
#
# So "some Firebase things work" was never evidence that the project existed.
# ─────────────────────────────────────────────────────────────────────────────

# ⚠️ IMPORT, DO NOT CREATE.
#
# `addFirebase` returns a bare 403 PERMISSION_DENIED for an account that has
# never accepted the Firebase Terms of Service — verified here against
# `roles/owner`, with both the Firebase CLI's credential and a raw gcloud
# token, so it is not a scope or a credential problem. Terms have to be
# accepted by a human in the console once, per account.
#
# After that has happened:
#
#   terraform import google_firebase_project.default projects/wawitas
#
# Creating it from scratch would fail with "already exists" against a project
# the console has already linked, which is the expected state here.
resource "google_firebase_project" "default" {
  provider = google-beta
  project  = var.project_id

  depends_on = [google_project_service.required]
}

# The web app. This is what mints the four NEXT_PUBLIC_FIREBASE_* values that
# `firebase-client.ts` cannot initialise without — no auth, no client-side
# Firestore, and therefore no way to test that firestore.rules enforces
# anything, until this exists.
resource "google_firebase_web_app" "web" {
  provider     = google-beta
  project      = var.project_id
  display_name = "Wawitas"

  # DELETE rather than ABANDON: an orphaned web app left behind by a destroy
  # would keep issuing a config for a project nothing else remains in.
  deletion_policy = "DELETE"

  depends_on = [google_firebase_project.default]
}

# The generated client config, read back so the values land in `terraform
# output` instead of being copied out of a console by hand.
data "google_firebase_web_app_config" "web" {
  provider   = google-beta
  project    = var.project_id
  web_app_id = google_firebase_web_app.web.app_id
}
