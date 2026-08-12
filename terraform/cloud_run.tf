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

  depends_on = [
    google_project_service.required,
    google_project_iam_member.cloud_run_datastore,
    google_storage_bucket_iam_member.cloud_run_storage,
  ]
}
