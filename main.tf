provider "aws" {
  region = var.region

  default_tags {
    tags = var.tags
  }
}

# CloudFront and its certificate (on a domain of its own) live in us-east-1.
provider "aws" {
  alias  = "global"
  region = "us-east-1"

  default_tags {
    tags = var.tags
  }
}

data "aws_caller_identity" "current" {}
