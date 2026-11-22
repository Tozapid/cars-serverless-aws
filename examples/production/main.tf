# Production: the module on your own domain, mails of the reminders, no
# public sign-in and no reset. Pin the module to a release tag; a newer
# release is a change of ref.
terraform {
  required_version = ">= 1.10.0"

  backend "s3" {
    encrypt      = true
    use_lockfile = true
  }

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

provider "aws" {
  region = "eu-central-1"
}

# CloudFront and its certificate live in us-east-1.
provider "aws" {
  alias  = "global"
  region = "us-east-1"
}

module "cars" {
  source = "git::https://github.com/Tozapid/cars-serverless-aws.git?ref=v0.3.3"

  providers = {
    aws        = aws
    aws.global = aws.global
  }

  name              = "cars"
  domain_name       = "cars.example.com"
  route53_zone_name = "example.com"
  admin_email       = "you@example.com"
  # Mails the reminders that are due; the module makes domain_name an SES
  # identity. "" sends no mails.
  sender_address = "alert@cars.example.com"
}

output "site_url" {
  description = "Address of the page."
  value       = module.cars.site_url
}
