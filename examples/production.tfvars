# Production: your own domain, mails of the reminders, no public sign-in and
# no hourly reset. Copy to terraform.tfvars and fill in.

name = "cars"
demo = false

domain_name       = "cars.example.com"
route53_zone_name = "example.com"

admin_email    = "you@example.com"
admin_password = "" # Cognito mails a temporary password instead

reset_schedule = ""

# Mails the reminders that are due; the stack makes domain_name an SES
# identity. "" sends no mails.
sender_address = "alert@cars.example.com"
