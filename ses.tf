# The sender of the reminders: domain_name as an SES identity with Easy DKIM,
# a MAIL FROM domain (mail.<domain>) and DMARC, its records in the Route 53
# zone. Only with local.mail: the demo creates no SES identity and sends no
# mail. SES verifies the domain a few minutes after the DKIM records resolve;
# while the account is in the SES sandbox, mails reach verified addresses
# only.

resource "aws_sesv2_email_identity" "mail" {
  count = local.mail ? 1 : 0

  email_identity = var.domain_name

  lifecycle {
    precondition {
      condition     = local.custom_domain && endswith(var.sender_address, "@${var.domain_name}")
      error_message = "sender_address needs domain_name and has to be on it: the domain is the SES identity the mails come from."
    }
  }
}

resource "aws_route53_record" "mail_dkim" {
  count = local.mail ? 3 : 0

  zone_id = data.aws_route53_zone.web[0].zone_id
  name    = "${aws_sesv2_email_identity.mail[0].dkim_signing_attributes[0].tokens[count.index]}._domainkey.${var.domain_name}"
  type    = "CNAME"
  ttl     = 300
  records = ["${aws_sesv2_email_identity.mail[0].dkim_signing_attributes[0].tokens[count.index]}.dkim.amazonses.com"]
}

# Bounces come back to mail.<domain>, so that SPF passes for the domain of
# the mail and not for amazonses.com.
resource "aws_sesv2_email_identity_mail_from_attributes" "mail" {
  count = local.mail ? 1 : 0

  email_identity   = aws_sesv2_email_identity.mail[0].email_identity
  mail_from_domain = "mail.${var.domain_name}"
}

resource "aws_route53_record" "mail_from_mx" {
  count = local.mail ? 1 : 0

  zone_id = data.aws_route53_zone.web[0].zone_id
  name    = aws_sesv2_email_identity_mail_from_attributes.mail[0].mail_from_domain
  type    = "MX"
  ttl     = 300
  records = ["10 feedback-smtp.${var.region}.amazonses.com"]
}

resource "aws_route53_record" "mail_from_spf" {
  count = local.mail ? 1 : 0

  zone_id = data.aws_route53_zone.web[0].zone_id
  name    = aws_sesv2_email_identity_mail_from_attributes.mail[0].mail_from_domain
  type    = "TXT"
  ttl     = 300
  records = ["v=spf1 include:amazonses.com ~all"]
}

resource "aws_route53_record" "mail_dmarc" {
  count = local.mail ? 1 : 0

  zone_id = data.aws_route53_zone.web[0].zone_id
  name    = "_dmarc.${var.domain_name}"
  type    = "TXT"
  ttl     = 300
  records = ["v=DMARC1;p=quarantine;pct=25"]
}
