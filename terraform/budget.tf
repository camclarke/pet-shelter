# The one promise made repeatedly in CLAUDE.md: a budget alert goes up before
# anything else. Notifies at 50%, 90%, and 100% of threshold so there's
# warning before the bill actually arrives, not just at the moment it does.

# Needed only for .number — see the budget_filter comment below.
data "google_project" "this" {
  project_id = var.project_id
}

resource "google_billing_budget" "alert" {
  billing_account = var.billing_account
  display_name    = "${var.app_name}-${var.environment} budget alert"

  budget_filter {
    # Project NUMBER, not project id. The Billing Budgets API always returns
    # this filter as "projects/<number>", so writing "projects/${var.project_id}"
    # produces a diff on every single plan that can never converge — apply it,
    # and the very next plan shows it again. Perpetual drift is worse than
    # cosmetic: it trains you to skim plans, and that is when a real change
    # slips past. Found on the first apply, 2026-08-12.
    projects = ["projects/${data.google_project.this.number}"]
  }

  amount {
    specified_amount {
      currency_code = "USD"
      units         = tostring(var.budget_amount_usd)
    }
  }

  threshold_rules {
    threshold_percent = 0.5
  }
  threshold_rules {
    threshold_percent = 0.9
  }
  threshold_rules {
    threshold_percent = 1.0
  }

  all_updates_rule {
    monitoring_notification_channels = [google_monitoring_notification_channel.budget_email.id]
    disable_default_iam_recipients   = false
  }

  # Added 2026-08-12. Without this, Terraform can attempt the budget before
  # `billingbudgets.googleapis.com` finishes enabling — it parallelises to 10
  # and nothing else links these two. `plan` cannot see this class of failure;
  # it appears only at apply, as "API has not been used in project ... before
  # or it is disabled".
  depends_on = [google_project_service.required]
}

resource "google_monitoring_notification_channel" "budget_email" {
  project      = var.project_id
  display_name = "${var.app_name} budget alert email"
  type         = "email"

  labels = {
    email_address = var.budget_alert_email
  }

  # `monitoring.googleapis.com` happens to be enabled by default on a new
  # project, so this is belt-and-braces rather than a known failure — but
  # relying on a Google default that is not declared anywhere is how the
  # sibling stack lost a cycle.
  depends_on = [google_project_service.required]
}
