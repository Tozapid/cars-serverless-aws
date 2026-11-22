# The demo was the root module of this repository before the code became a
# module (v0.3.3): its state keeps every resource, now under module.cars.

moved {
  from = aws_cloudwatch_log_delivery_source.access
  to   = module.cars.aws_cloudwatch_log_delivery_source.access
}

moved {
  from = aws_cloudwatch_log_delivery_destination.access
  to   = module.cars.aws_cloudwatch_log_delivery_destination.access
}

moved {
  from = aws_cloudwatch_log_delivery.access
  to   = module.cars.aws_cloudwatch_log_delivery.access
}

moved {
  from = aws_apigatewayv2_api.http
  to   = module.cars.aws_apigatewayv2_api.http
}

moved {
  from = aws_apigatewayv2_authorizer.cognito
  to   = module.cars.aws_apigatewayv2_authorizer.cognito
}

moved {
  from = aws_apigatewayv2_integration.lambda
  to   = module.cars.aws_apigatewayv2_integration.lambda
}

moved {
  from = aws_apigatewayv2_route.api
  to   = module.cars.aws_apigatewayv2_route.api
}

moved {
  from = aws_apigatewayv2_route.keyed
  to   = module.cars.aws_apigatewayv2_route.keyed
}

moved {
  from = aws_apigatewayv2_route.shared
  to   = module.cars.aws_apigatewayv2_route.shared
}

moved {
  from = aws_cloudwatch_log_group.api
  to   = module.cars.aws_cloudwatch_log_group.api
}

moved {
  from = aws_apigatewayv2_stage.default
  to   = module.cars.aws_apigatewayv2_stage.default
}

moved {
  from = aws_lambda_permission.api
  to   = module.cars.aws_lambda_permission.api
}

moved {
  from = tls_private_key.files
  to   = module.cars.tls_private_key.files
}

moved {
  from = aws_cloudfront_public_key.files
  to   = module.cars.aws_cloudfront_public_key.files
}

moved {
  from = aws_cloudfront_key_group.files
  to   = module.cars.aws_cloudfront_key_group.files
}

moved {
  from = aws_ssm_parameter.files_signing_key
  to   = module.cars.aws_ssm_parameter.files_signing_key
}

moved {
  from = aws_ssm_parameter.files_key
  to   = module.cars.aws_ssm_parameter.files_key
}

moved {
  from = aws_cloudfront_function.api_host
  to   = module.cars.aws_cloudfront_function.api_host
}

moved {
  from = aws_cloudfront_function.manifest
  to   = module.cars.aws_cloudfront_function.manifest
}

moved {
  from = aws_cloudfront_cache_policy.files
  to   = module.cars.aws_cloudfront_cache_policy.files
}

moved {
  from = aws_cloudfront_response_headers_policy.files
  to   = module.cars.aws_cloudfront_response_headers_policy.files
}

moved {
  from = aws_cloudfront_origin_access_control.web
  to   = module.cars.aws_cloudfront_origin_access_control.web
}

moved {
  from = aws_cloudfront_cache_policy.web
  to   = module.cars.aws_cloudfront_cache_policy.web
}

moved {
  from = aws_cloudfront_response_headers_policy.web
  to   = module.cars.aws_cloudfront_response_headers_policy.web
}

moved {
  from = aws_cloudfront_distribution.web
  to   = module.cars.aws_cloudfront_distribution.web
}

moved {
  from = aws_cognito_user_pool.main
  to   = module.cars.aws_cognito_user_pool.main
}

moved {
  from = aws_cognito_user_pool_client.web
  to   = module.cars.aws_cognito_user_pool_client.web
}

moved {
  from = aws_cognito_user.admin
  to   = module.cars.aws_cognito_user.admin
}

moved {
  from = aws_cognito_user_group.admins
  to   = module.cars.aws_cognito_user_group.admins
}

moved {
  from = aws_cognito_user_in_group.admin
  to   = module.cars.aws_cognito_user_in_group.admin
}

moved {
  from = aws_acm_certificate.web
  to   = module.cars.aws_acm_certificate.web
}

moved {
  from = aws_route53_record.certificate
  to   = module.cars.aws_route53_record.certificate
}

moved {
  from = aws_acm_certificate_validation.web
  to   = module.cars.aws_acm_certificate_validation.web
}

moved {
  from = aws_route53_record.web
  to   = module.cars.aws_route53_record.web
}

moved {
  from = aws_dynamodb_table.main
  to   = module.cars.aws_dynamodb_table.main
}

moved {
  from = aws_s3_object.web
  to   = module.cars.aws_s3_object.web
}

moved {
  from = aws_s3_object.config
  to   = module.cars.aws_s3_object.config
}

moved {
  from = aws_iam_role.lambda
  to   = module.cars.aws_iam_role.lambda
}

moved {
  from = aws_iam_role_policy.lambda
  to   = module.cars.aws_iam_role_policy.lambda
}

moved {
  from = aws_cloudwatch_log_group.lambda
  to   = module.cars.aws_cloudwatch_log_group.lambda
}

moved {
  from = aws_lambda_function.app
  to   = module.cars.aws_lambda_function.app
}

moved {
  from = aws_lambda_function_event_invoke_config.app
  to   = module.cars.aws_lambda_function_event_invoke_config.app
}

moved {
  from = aws_cloudwatch_event_rule.daily
  to   = module.cars.aws_cloudwatch_event_rule.daily
}

moved {
  from = aws_cloudwatch_event_target.daily
  to   = module.cars.aws_cloudwatch_event_target.daily
}

moved {
  from = aws_lambda_permission.daily
  to   = module.cars.aws_lambda_permission.daily
}

moved {
  from = aws_ssm_parameter.admin_password
  to   = module.cars.aws_ssm_parameter.admin_password
}

moved {
  from = aws_cloudwatch_log_group.reset
  to   = module.cars.aws_cloudwatch_log_group.reset
}

moved {
  from = aws_iam_role.reset
  to   = module.cars.aws_iam_role.reset
}

moved {
  from = aws_iam_role_policy.reset
  to   = module.cars.aws_iam_role_policy.reset
}

moved {
  from = aws_lambda_function.reset
  to   = module.cars.aws_lambda_function.reset
}

moved {
  from = aws_cloudwatch_event_rule.reset
  to   = module.cars.aws_cloudwatch_event_rule.reset
}

moved {
  from = aws_cloudwatch_event_target.reset
  to   = module.cars.aws_cloudwatch_event_target.reset
}

moved {
  from = aws_lambda_permission.reset
  to   = module.cars.aws_lambda_permission.reset
}

moved {
  from = aws_lambda_invocation.first_reset
  to   = module.cars.aws_lambda_invocation.first_reset
}

moved {
  from = aws_s3_bucket.web
  to   = module.cars.aws_s3_bucket.web
}

moved {
  from = aws_s3_bucket_public_access_block.web
  to   = module.cars.aws_s3_bucket_public_access_block.web
}

moved {
  from = aws_s3_bucket_ownership_controls.web
  to   = module.cars.aws_s3_bucket_ownership_controls.web
}

moved {
  from = aws_s3_bucket_server_side_encryption_configuration.web
  to   = module.cars.aws_s3_bucket_server_side_encryption_configuration.web
}

moved {
  from = aws_s3_bucket_lifecycle_configuration.web
  to   = module.cars.aws_s3_bucket_lifecycle_configuration.web
}

moved {
  from = aws_s3_bucket_policy.web
  to   = module.cars.aws_s3_bucket_policy.web
}

moved {
  from = aws_s3_bucket.files
  to   = module.cars.aws_s3_bucket.files
}

moved {
  from = aws_s3_bucket_public_access_block.files
  to   = module.cars.aws_s3_bucket_public_access_block.files
}

moved {
  from = aws_s3_bucket_ownership_controls.files
  to   = module.cars.aws_s3_bucket_ownership_controls.files
}

moved {
  from = aws_s3_bucket_versioning.files
  to   = module.cars.aws_s3_bucket_versioning.files
}

moved {
  from = aws_s3_bucket_server_side_encryption_configuration.files
  to   = module.cars.aws_s3_bucket_server_side_encryption_configuration.files
}

moved {
  from = aws_s3_bucket_cors_configuration.files
  to   = module.cars.aws_s3_bucket_cors_configuration.files
}

moved {
  from = aws_s3_bucket_policy.files
  to   = module.cars.aws_s3_bucket_policy.files
}

moved {
  from = aws_s3_bucket_lifecycle_configuration.files
  to   = module.cars.aws_s3_bucket_lifecycle_configuration.files
}

moved {
  from = aws_s3_bucket_logging.files
  to   = module.cars.aws_s3_bucket_logging.files
}

moved {
  from = aws_sesv2_email_identity.mail
  to   = module.cars.aws_sesv2_email_identity.mail
}

moved {
  from = aws_route53_record.mail_dkim
  to   = module.cars.aws_route53_record.mail_dkim
}

moved {
  from = aws_sesv2_email_identity_mail_from_attributes.mail
  to   = module.cars.aws_sesv2_email_identity_mail_from_attributes.mail
}

moved {
  from = aws_route53_record.mail_from_mx
  to   = module.cars.aws_route53_record.mail_from_mx
}

moved {
  from = aws_route53_record.mail_from_spf
  to   = module.cars.aws_route53_record.mail_from_spf
}

moved {
  from = aws_route53_record.mail_dmarc
  to   = module.cars.aws_route53_record.mail_dmarc
}
