resource "aws_cloudwatch_log_group" "lambda" {
  #checkov:skip=CKV_AWS_158:CloudWatch's own encryption is enough for these logs. A customer managed key would add a monthly charge.
  #checkov:skip=CKV_AWS_338:Thirty days is enough to look into a failed import or mail and keeps the log bill small.
  name              = "/aws/lambda/${local.name}"
  retention_in_days = 30
}

# The code without the tests and the reset. Git ignores .build/.
data "archive_file" "app" {
  type = "zip"
  dynamic "source" {
    for_each = toset(["app.py", "common.py", "files.py", "reminders.py", "mail.py", "access.py", "carexpenses.py"])

    content {
      content  = file("${path.module}/lambda/${source.value}")
      filename = source.value
    }
  }
  output_path      = "${path.module}/.build/cars.zip"
  output_file_mode = "0644"
}

# One function: the API, the imports and the daily reminders.
resource "aws_lambda_function" "app" {
  #checkov:skip=CKV_AWS_50:X-Ray is disabled to avoid extra cost on a low-traffic function.
  #checkov:skip=CKV_AWS_115:Reserved concurrency is left to the account pool.
  #checkov:skip=CKV_AWS_116:The API answers its caller; a daily run that fails is the next day's, and its error is in the logs.
  #checkov:skip=CKV_AWS_117:The function calls public AWS endpoints and the release feed on GitHub.
  #checkov:skip=CKV_AWS_173:Environment values are names, addresses and thresholds, not secrets.
  #checkov:skip=CKV_AWS_272:Code signing is not used for this internal function.
  function_name = local.name
  role          = aws_iam_role.lambda.arn
  runtime       = "python3.14"
  architectures = ["arm64"]
  handler       = "app.handler"
  memory_size   = 512
  # API Gateway waits 30 seconds; an import of a big backup takes the
  # longest. The daily job has the rest.
  timeout = 120

  filename         = data.archive_file.app.output_path
  source_code_hash = data.archive_file.app.output_base64sha256

  environment {
    variables = {
      TABLE_NAME               = aws_dynamodb_table.main.name
      SITE_URL                 = local.site_url
      USER_POOL_ID             = aws_cognito_user_pool.main.id
      ADMIN_GROUP              = aws_cognito_user_group.admins.name
      SENDER                   = local.mail ? var.sender_address : ""
      VERSION                  = local.version
      DEMO                     = tostring(var.demo)
      RELEASES_REPOSITORY      = var.releases_repository
      FILES_BUCKET             = aws_s3_bucket.files.id
      FILE_MAX_BYTES           = tostring(var.file_max_bytes)
      CLOUDFRONT_KEY_PAIR_ID   = local.files_key.public_key_id
      FILES_KEY_PARAMETER_NAME = local.files_key.private_key_parameter
      REMINDER_LEAD_DAYS       = tostring(var.reminder_lead_days)
      REMINDER_LEAD_KM         = tostring(var.reminder_lead_km)
    }
  }

  logging_config {
    log_format = "Text"
    log_group  = aws_cloudwatch_log_group.lambda.name
  }

  depends_on = [aws_iam_role_policy.lambda]

}

# Not retried: a second run would be a second mail (the markers also guard
# against it).
resource "aws_lambda_function_event_invoke_config" "app" {
  function_name          = aws_lambda_function.app.function_name
  maximum_retry_attempts = 0
}

resource "aws_cloudwatch_event_rule" "daily" {
  name                = "${local.name}-daily"
  description         = "The reminders of ${local.name} that are due."
  schedule_expression = var.reminder_schedule
}

resource "aws_cloudwatch_event_target" "daily" {
  rule  = aws_cloudwatch_event_rule.daily.name
  arn   = aws_lambda_function.app.arn
  input = jsonencode({ action = "daily" })
}

resource "aws_lambda_permission" "daily" {
  statement_id  = "AllowEventBridge-daily"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.app.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.daily.arn
}
