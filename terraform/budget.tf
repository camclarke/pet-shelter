# The one promise made repeatedly in CLAUDE.md: a budget alert goes up before
# anything else. Notifies at 50%, 90%, and 100% of threshold so there's
# warning before the bill actually arrives, not just at the moment it does.

resource "google_billing_budget" "alert" {
  billing_account = var.billing_account
  display_name    = "${var.app_name}-${var.environment} budget alert"

  budget_filter {
    projects = ["projects/${var.project_id}"]
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
}

resource "google_monitoring_notification_channel" "budget_email" {
  project      = var.project_id
  display_name = "${var.app_name} budget alert email"
  type         = "email"

  labels = {
    email_address = var.budget_alert_email
  }
}
