// ─────────────────────────────────────────────────────────────────────────────
// CI/CD identity — GitHub Actions authenticating via Workload Identity
// Federation.
//
// The whole point of this file is that **no service-account key ever exists**.
// A downloaded JSON key is a long-lived credential sitting in a GitHub secret
// with nothing to rotate it and no way to tell whether it has leaked. WIF
// swaps GitHub's own short-lived OIDC token for a GCP access token at job
// start, scoped by the attribute condition below.
//
// This is the one piece of infrastructure whose failure mode is a security
// incident rather than an outage, so the two things that matter most:
//
//   1. `attribute_condition` pins the repository. Without it, ANY GitHub
//      repository on the planet can mint tokens against this pool.
//   2. The CI service account is a SEPARATE identity from the Cloud Run
//      runtime service account. CI needs to push images and roll revisions;
//      it has no business reading Firestore. The runtime SA reads Firestore
//      and cannot deploy anything.
// ─────────────────────────────────────────────────────────────────────────────

resource "google_iam_workload_identity_pool" "github" {
  project                   = var.project_id
  workload_identity_pool_id = "github-actions"
  display_name              = "GitHub Actions"
  description               = "Keyless CI/CD identity for ${var.github_repository}"

  depends_on = [google_project_service.required]
}

resource "google_iam_workload_identity_pool_provider" "github" {
  project                            = var.project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github"
  display_name                       = "GitHub OIDC"

  # Only the claims actually used are mapped. `repository` is the one the
  # condition and the principalSet binding both key off; `repository_owner`
  # and `ref` are mapped so a future condition can narrow further (e.g. to
  # refs/heads/master only) without recreating the provider.
  attribute_mapping = {
    "google.subject"             = "assertion.sub"
    "attribute.repository"       = "assertion.repository"
    "attribute.repository_owner" = "assertion.repository_owner"
    "attribute.ref"              = "assertion.ref"
  }

  # ⚠️ DO NOT REMOVE OR BROADEN. Google itself refuses to create a provider
  # with no condition for exactly this reason: the OIDC issuer is shared by
  # every public GitHub repository, so the issuer alone proves nothing about
  # who is calling.
  attribute_condition = "assertion.repository == \"${var.github_repository}\""

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

resource "google_service_account" "ci" {
  project      = var.project_id
  account_id   = "${var.app_name}-ci"
  display_name = "GitHub Actions CI/CD — ${var.app_name}"
  description  = "Builds and pushes images, rolls Cloud Run revisions. Not the runtime identity."
}

# The binding that actually lets the workflow act as the CI service account.
# `principalSet` on attribute.repository means "any workflow in this repo" —
# combined with the attribute_condition above, that is the full trust boundary.
resource "google_service_account_iam_member" "ci_workload_identity" {
  service_account_id = google_service_account.ci.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository/${var.github_repository}"
}

# Push images. Scoped to this one repository rather than granted
# project-wide — there is only one registry today, and that is not a reason to
# hand out a project-level role.
resource "google_artifact_registry_repository_iam_member" "ci_writer" {
  project    = var.project_id
  location   = var.region
  repository = google_artifact_registry_repository.app.name
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${google_service_account.ci.email}"
}

# Roll a new revision.
#
# Deliberately project-level rather than bound to the one Cloud Run service:
# `gcloud run services update` submits a long-running operation and then polls
# it, and in the Cloud Run v2 API operations are project-scoped resources
# (`projects/*/locations/*/operations/*`), not children of the service. A
# service-level binding covers the update call and then fails on the poll.
# There is exactly one service in this project, so the practical difference is
# small; the note is here so nobody "tightens" it and spends an afternoon on
# a deploy that succeeds and then reports failure.
resource "google_project_iam_member" "ci_run_admin" {
  project = var.project_id
  role    = "roles/run.admin"
  member  = "serviceAccount:${google_service_account.ci.email}"
}

# Required to deploy a service that RUNS AS a different service account.
# Without this the deploy fails with `PERMISSION_DENIED: lacks
# iam.serviceAccounts.actAs` — which reads like a problem with the runtime SA
# and is actually a missing grant on the deployer. Scoped to the runtime SA
# specifically, not `roles/iam.serviceAccountUser` on the project.
resource "google_service_account_iam_member" "ci_act_as_runtime" {
  service_account_id = google_service_account.cloud_run.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.ci.email}"
}
