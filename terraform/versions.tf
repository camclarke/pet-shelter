terraform {
  required_version = ">= 1.9"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = "~> 6.0"
    }
  }

  # Deliberately no backend block here. The bucket, prefix, and even the GCS
  # project differ per environment and, eventually, per GCP tenant when this
  # project moves — hardcoding any of that would mean editing this file at
  # migration time instead of just re-running init. Supply it at `terraform
  # init` time instead:
  #
  #   terraform init -backend-config=backend.hcl
  #
  # See backend.hcl.example.
  backend "gcs" {}
}
