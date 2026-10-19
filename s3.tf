# The page: static files in a private bucket, read only by CloudFront.
resource "aws_s3_bucket" "web" {
  #checkov:skip=CKV_AWS_145:SSE-S3 is enough for the static page. A customer managed key would add a monthly charge.
  #checkov:skip=CKV_AWS_144:The page source is in git. Cross-region replication is not needed.
  #checkov:skip=CKV2_AWS_62:This bucket only serves the page. Event notifications are not needed.
  #checkov:skip=CKV_AWS_18:CloudFront and the API carry the useful access trail. A second log bucket is not worth it here.
  #checkov:skip=CKV_AWS_21:The page source is in git; each apply uploads it again.
  bucket = local.web_bucket
  # The page is in git; nothing to keep on terraform destroy.
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "web" {
  bucket                  = aws_s3_bucket.web.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "web" {
  bucket = aws_s3_bucket.web.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "web" {
  bucket = aws_s3_bucket.web.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "web" {
  bucket = aws_s3_bucket.web.id

  rule {
    id     = "abort-uploads"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

resource "aws_s3_bucket_policy" "web" {
  bucket = aws_s3_bucket.web.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AllowCloudFrontRead"
        Effect    = "Allow"
        Principal = { Service = "cloudfront.amazonaws.com" }
        Action    = "s3:GetObject"
        Resource  = "${aws_s3_bucket.web.arn}/*"
        Condition = {
          StringEquals = {
            "AWS:SourceArn" = aws_cloudfront_distribution.web.arn
          }
        }
      }
    ]
  })
}

# Receipts, photos and documents of the events, under files/<user>/. The page
# uploads them through a presigned POST and reads them through CloudFront with
# a signed cookie for its user's folder only.
resource "aws_s3_bucket" "files" {
  #checkov:skip=CKV_AWS_145:SSE-S3 is enough for private receipts. A customer managed key would add a monthly charge.
  #checkov:skip=CKV_AWS_144:Files are write-once objects with versioning. Cross-region replication is not needed.
  #checkov:skip=CKV2_AWS_62:Files are referenced from the events. Bucket notifications are not needed.
  #checkov:skip=CKV_AWS_18:The bucket is private. Reads need a signed cookie issued by the API, which logs the caller.
  bucket = local.files_bucket
  # The files of the demo's visitors go with the stack; production keeps them.
  force_destroy = var.demo
}

resource "aws_s3_bucket_public_access_block" "files" {
  bucket                  = aws_s3_bucket.files.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "files" {
  bucket = aws_s3_bucket.files.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_versioning" "files" {
  bucket = aws_s3_bucket.files.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "files" {
  bucket = aws_s3_bucket.files.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_cors_configuration" "files" {
  bucket = aws_s3_bucket.files.id

  cors_rule {
    allowed_headers = ["*"]
    allowed_methods = ["POST"]
    allowed_origins = distinct([local.site_url, "https://${aws_cloudfront_distribution.web.domain_name}"])
    expose_headers  = ["ETag"]
    max_age_seconds = 3000
  }
}

resource "aws_s3_bucket_policy" "files" {
  bucket = aws_s3_bucket.files.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AllowCloudFrontRead"
        Effect    = "Allow"
        Principal = { Service = "cloudfront.amazonaws.com" }
        Action    = "s3:GetObject"
        Resource  = "${aws_s3_bucket.files.arn}/files/*"
        Condition = {
          StringEquals = {
            "AWS:SourceArn" = aws_cloudfront_distribution.web.arn
          }
        }
      }
    ]
  })
}

# A deleted file stays 30 days as an old version, then goes.
resource "aws_s3_bucket_lifecycle_configuration" "files" {
  bucket = aws_s3_bucket.files.id

  rule {
    id     = "abort-and-expire-old"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }

    noncurrent_version_expiration {
      noncurrent_days = 30
    }

    expiration {
      expired_object_delete_marker = true
    }
  }
}
