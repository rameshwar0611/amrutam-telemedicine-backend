variable "region" {
  type    = string
  default = "ap-south-1"
}
variable "name" {
  type    = string
  default = "amrutam-staging"
}
variable "azs" {
  type    = list(string)
  default = ["ap-south-1a", "ap-south-1b"]
  validation {
    condition     = length(var.azs) == 2
    error_message = "Exactly two distinct-region availability zones are required."
  }
}
variable "certificate_arn" {
  type = string
}
variable "api_secret_arn" {
  type        = string
  description = "Existing Secrets Manager JSON: API DB URL and AUTH_ fields; no values in Terraform."
}
variable "worker_secret_arn" {
  type        = string
  description = "Existing JSON: worker DATABASE_URL and REDIS_URL only."
}
variable "migration_secret_arn" {
  type        = string
  description = "Existing owner DATABASE_URL for one-shot migrations/bootstrap only."
}
variable "maintenance_secret_arn" {
  type        = string
  description = "Existing maintenance DATABASE_URL for function execution only."
}
variable "secrets_kms_key_arn" {
  type = string
}
variable "cache_auth_token" {
  type        = string
  sensitive   = true
  description = "Unique externally supplied token; Terraform state is sensitive and must use the private encrypted backend. Never commit tfvars or plans."
}
variable "image_digest" {
  type = string
  validation {
    condition     = can(regex("^sha256:[a-f0-9]{64}$", var.image_digest))
    error_message = "Deploy an immutable reviewed image digest."
  }
}
variable "github_repository" {
  type    = string
  default = "rameshwar0611/amrutam-telemedicine-backend"
}
variable "alarm_topic_arn" {
  type        = string
  description = "Existing SNS topic with verified on-call subscriptions; deployment must test notification routing."
}
variable "collector_image_digest" {
  type        = string
  description = "Digest of reviewed ADOT collector mirrored into the private collector ECR repository before deployment."
  validation {
    condition     = can(regex("^sha256:[a-f0-9]{64}$", var.collector_image_digest))
    error_message = "Use an immutable mirrored collector digest."
  }
}
