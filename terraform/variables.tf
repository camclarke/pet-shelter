variable "project_id" {
  description = "GCP project ID. A new dedicated project per CLAUDE.md — never the trustcert-ai-g work project."
  type        = string
}

variable "region" {
  description = <<-EOT
    Region for Cloud Run, Artifact Registry, and the Firestore location.

    Defaults to us-east1. It is one of the three US regions covered by the
    Cloud Storage Always Free tier (with us-central1 and us-west1), it is a
    cheap Cloud Run region, and it is roughly 1,200 km closer to Cochabamba
    than us-central1 — South American traffic generally routes through Miami,
    so us-east1 is the better US choice for this deployment's actual users.

    NOTE: the Firestore location is IMMUTABLE once the database is created.
    Verified against `gcloud firestore locations list` rather than assumed:
    both us-east1 and us-central1 are valid Firestore regional locations. An
    earlier note in CLAUDE.md claimed us-east1 was not — that was inherited
    from a sibling project and is incorrect.

    southamerica-east1 (São Paulo) or southamerica-west1 (Santiago) are also
    valid and would be faster still for end users, at a cost premium and
    outside the free storage tier. Revisit only if latency becomes a real,
    reported complaint.
  EOT
  type        = string
  default     = "us-east1"
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
  default     = "pet-shelter-web"
}

variable "environment" {
  description = "Deployment environment, e.g. production or staging. Suffixes resource names so both can exist in one project if ever needed."
  type        = string
  default     = "production"
}

variable "container_image" {
  description = <<-EOT
    Full Artifact Registry image reference to deploy, e.g.
    us-central1-docker.pkg.dev/PROJECT/pet-shelter-web/app:TAG. Left as a variable
    rather than built by Terraform itself — the image is built and pushed by
    CI (or manually via the Dockerfile at the repo root), and Terraform only
    ever points Cloud Run at a tag that already exists. Building images is a
    CI concern, not an infrastructure one.
  EOT
  type        = string
}
