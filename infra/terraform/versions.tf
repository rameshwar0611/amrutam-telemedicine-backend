terraform {
  required_version = ">= 1.13.0, < 2.0.0"
  required_providers {
    aws = {
      source = "hashicorp/aws", version = "~> 6.22"
    }
  }
  backend "s3" {
  } # Supply an existing private/versioned/KMS state bucket and use_lockfile=true at init.
}
provider "aws" {
  region = var.region
  default_tags {
    tags = {
      Project = "amrutam", Environment = "staging", ManagedBy = "terraform"
    }
  }
}
