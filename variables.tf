variable "region" {
  type        = string
  default     = "eu-central-1"
  description = "Region of every resource but CloudFront: the API, the data, the files and the sign-in."
}

variable "name" {
  type        = string
  default     = "cars-serverless"
  description = "Prefix of every resource name; bucket names add the account id. The deploy role of the demo is limited to it."
}

variable "demo" {
  type        = bool
  default     = true
  description = "Public demo: the sign-in screen shows and fills in the demo sign-in, the settings hide the password and two-factor authentication, and administrators may look at the users but not change them."
}

variable "domain_name" {
  type        = string
  default     = ""
  description = "Name of the page, such as cars.example.com, in the Route 53 zone route53_zone_name. Empty: the page answers at its CloudFront address (the demo)."
}

variable "route53_zone_name" {
  type        = string
  default     = ""
  description = "Public Route 53 zone of domain_name; the stack writes the certificate's validation, the alias records and, with sender_address, the records of the SES identity there."
}

variable "admin_email" {
  type        = string
  default     = "demo@example.com"
  description = "Sign-in of the first user, an administrator. Self sign-up is off; administrators invite the others on the page."
}

variable "admin_password" {
  type        = string
  default     = "Demo-Password-1"
  sensitive   = true
  description = "Permanent password of the first user, published in the demo and put back by the reset. Empty: Cognito mails admin_email a temporary password instead."
}

variable "reset_schedule" {
  type        = string
  default     = "rate(1 hour)"
  description = "When the demo goes back to its initial state: the table and the files are wiped, the examples of seed/seed.json written again, the first user gets admin_password back and other users go. An empty string turns the reset off."
}

variable "file_max_bytes" {
  type        = number
  default     = 10485760
  description = "Maximum size of one attached file (a receipt, a photo, a PDF). The page shrinks a photo to 2000 pixels before the upload."
}

variable "sender_address" {
  type        = string
  default     = ""
  description = "From address of the reminders, such as alert@cars.example.com, on domain_name, which the stack makes an SES identity (ses.tf). Empty, or the demo: no SES identity and no mails."

  validation {
    condition     = var.sender_address == "" || can(regex("^[^@\\s]+@[^@\\s]+$", var.sender_address))
    error_message = "sender_address is an email address or empty."
  }
}

variable "reminder_schedule" {
  type        = string
  default     = "cron(0 6 * * ? *)"
  description = "When the daily job looks for reminders that are due (EventBridge, UTC) and mails them."
}

variable "reminder_lead_days" {
  type        = number
  default     = 14
  description = "A reminder is due this many days before its date. The page marks it and the daily job mails it."

  validation {
    condition     = var.reminder_lead_days >= 0
    error_message = "reminder_lead_days is not negative."
  }
}

variable "reminder_lead_km" {
  type        = number
  default     = 1000
  description = "A reminder is due this many kilometres before its distance."

  validation {
    condition     = var.reminder_lead_km >= 0
    error_message = "reminder_lead_km is not negative."
  }
}

variable "releases_repository" {
  type        = string
  default     = "Tozapid/cars-serverless-aws"
  description = "GitHub repository (owner/name) whose releases the settings compare the version of the site with. Empty turns the check off."
}

variable "access_logs_bucket" {
  type        = string
  default     = ""
  description = "Bucket that the access logs of this site go to, such as the logs_bucket of an overview of the account (Tozapid/account-serverless-aws): the standard logs (v2) of the distribution under cloudfront/<name>/, and the S3 server access logs of the files bucket under s3/. Its policy has to let delivery.logs.amazonaws.com and logging.s3.amazonaws.com write there. Empty: no access logs."
}

variable "tags" {
  type = map(string)
  default = {
    Managed = "IAC"
    Project = "cars-serverless-aws"
  }
  description = "Tags applied to supported resources."
}
