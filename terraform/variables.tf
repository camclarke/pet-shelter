variable "project_id" {
  description = "GCP project ID. A new dedicated project per CLAUDE.md — never the trustcert-ai-g work project."
  type        = string
}

variable "region" {
  description = <<-EOT
    Region for Cloud Run, Artifact Registry, and the Firestore/App Engine
    location. Defaults to us-central1 for cost: it's consistently one of the
    cheapest Cloud Run regions and has the broadest free-tier product
    availability. The tradeoff is latency to Cochabamba, Bolivia — a
    southamerica-east1 (São Paulo) or southamerica-west1 (Santiago) deployment
    would be measurably faster for end users at a small cost premium. Revisit
    if latency ever becomes a real complaint; for a shelter site with this
    traffic volume it is very unlikely to be.
  EOT
  type        = string
  default     = "us-central1"
}

variable "billing_account" {
  description = "Billing account ID (format: XXXXXX-XXXXXX-XXXXXX) to link and to attach the budget alert to."
  type        = string
}

variable "budget_amount_usd" {
  description = "Monthly budget alert threshold in USD. CLAUDE.md commits to an alert at $5 going up before anything is deployed."
  type        = number
  default     = 5
}

variable "budget_alert_email" {
  description = "Email address to notify when the budget threshold is crossed."
  type        = string
}

variable "app_name" {
  description = "Short name used to derive resource names (Cloud Run service, Artifact Registry repo, service accounts)."
  type        = string
  default     = "wawitas-web"
}

variable "environment" {
  description = "Deployment environment, e.g. production or staging. Suffixes resource names so both can exist in one project if ever needed."
  type        = string
  default     = "production"
}

variable "container_image" {
  description = <<-EOT
    Full Artifact Registry image reference to deploy, e.g.
    us-central1-docker.pkg.dev/PROJECT/wawitas-web/app:TAG. Left as a variable
    rather than built by Terraform itself — the image is built and pushed by
    CI (or manually via the Dockerfile at the repo root), and Terraform only
    ever points Cloud Run at a tag that already exists. Building images is a
    CI concern, not an infrastructure one.
  EOT
  type        = string
}
