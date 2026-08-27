resource "google_cloud_run_v2_service" "app" {
  project  = var.project_id
  name     = "${var.app_name}-${var.environment}"
  location = var.region

  # 2nd gen is the default for google_cloud_run_v2_service and is required
  # for some networking features; noted explicitly since CLAUDE.md's cost
  # table calls it out by name.
  launch_stage = "GA"

  template {
    service_account = google_service_account.cloud_run.email

    # Scale to zero is the whole cost argument for Cloud Run over anything
    # VM-shaped: an idle shelter site between visits costs nothing. Raise
    # min_instance_count to 1 only if cold starts become a real, reported
    # problem — that trade costs a small always-on fee and should be made
    # deliberately, not defaulted into.
    #
    # ⚠️ KNOWN BENIGN DIFF — `plan` will always show this block as changing:
    #
    #   - scaling {
    #       - manual_instance_count = 0 -> null
    #       - min_instance_count    = 0 -> null
    #
    # It is a google provider quirk, not drift in the infrastructure. Verified
    # 2026-08-12 by removing `min_instance_count` entirely and re-planning: the
    # diff was byte-identical, so the trigger is `manual_instance_count` — a
    # field this config never sets. `apply` accepts it as a no-op and the next
    # `plan` shows it again.
    #
    # Deliberately NOT suppressed with `lifecycle { ignore_changes }`: the only
    # expression broad enough to hide it would also hide real changes to
    # max_instance_count, which is a value worth seeing change. Documented
    # instead. If a plan ever shows something OTHER than these two lines here,
    # that one is real.
    scaling {
      min_instance_count = 0
      max_instance_count = 4
    }

    containers {
      image = var.container_image

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
        # CPU is only allocated during request processing, not idle between
        # them — this is what makes scale-to-zero pricing work at all.
        cpu_idle = true
      }

      ports {
        container_port = 8080
      }

      env {
        name  = "NEXT_PUBLIC_FIREBASE_PROJECT_ID"
        value = var.project_id
      }

      # The Gemini API key, read from Secret Manager at revision start.
      #
      # Gated on a variable rather than simply written, because the binding and
      # the secret's first version cannot land in the same apply: the secret is
      # created empty, and a revision that cannot resolve "latest" fails its
      # startup probe while traffic is pinned to LATEST. See terraform/secrets.tf
      # for the three-step runbook.
      #
      # Contrast the NEXT_PUBLIC_* values below: those are build args, not env
      # vars. This one is a genuine runtime secret and must never be given a
      # NEXT_PUBLIC_ prefix — that would compile it into the browser bundle.
      dynamic "env" {
        for_each = var.gemini_api_key_enabled ? [1] : []
        content {
          name = "GEMINI_API_KEY"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.gemini_api_key.secret_id
              version = "latest"
            }
          }
        }
      }

      # The rest of the NEXT_PUBLIC_* Firebase web config, the Maps key, and
      # the App Check site key are intentionally NOT set here. They are
      # public values baked in at *build* time (see Dockerfile's ARGs), not
      # runtime environment — Next.js inlines NEXT_PUBLIC_ vars into the
      # client bundle during `next build`, so setting them only as a Cloud
      # Run env var would leave the browser bundle looking for values that
      # were never actually compiled in.
    }
  }

  traffic {
    type    = "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST"
    percent = 100
  }

  # ⚠️ ADDED WITH THE CI PIPELINE — do not remove while .github/workflows/
  # deploy.yml exists.
  #
  # Ownership of the running image moved to CI the moment that workflow
  # landed. Terraform still declares `var.container_image` because Cloud Run
  # cannot be created without an image, but from the second deploy onward the
  # tag in terraform.tfvars is stale by design — CI pushes a commit-SHA tag
  # and rolls the revision itself.
  #
  # Without this block the next `terraform apply` would quietly roll
  # production back to whatever tag tfvars still names. That is the sibling
  # stack's §3 lesson, and the instruction there was explicit: add it in the
  # same commit as the pipeline, not after.
  #
  # `client` / `client_version` are here because `gcloud run services update`
  # stamps them ("gcloud", a version string) and Terraform would otherwise
  # plan to clear them on every apply.
  #
  # NOT ignored: `template[0].scaling`. The sibling stack suppresses it, but
  # the comment above explains why this project deliberately does not — the
  # only expression broad enough to hide the benign diff would also hide a
  # real change to max_instance_count.
  lifecycle {
    ignore_changes = [
      client,
      client_version,
      template[0].containers[0].image,
    ]
  }

  depends_on = [
    google_project_service.required,
    google_project_iam_member.cloud_run_datastore,
    google_storage_bucket_iam_member.cloud_run_storage,
  ]
}
