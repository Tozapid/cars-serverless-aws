# One table, a partition per user: pk = USER#<email>. sk = CAR#<car> is a car;
# sk = EVENT#<car>#<id> an event of it (a charge or a refuel, a service, an
# expense, an income); sk = REMINDER#<car>#<id> what is due after so many days
# or kilometres or on a day of the calendar; sk = PREFS which mails the user
# wants; sk = APIKEY#<id> and SHARE#<id> the API keys and the share links. The page reads a car
# with two queries of the partition and counts the statistics itself.
# pk = MARK holds the markers that keep a reminder from being mailed twice.
resource "aws_dynamodb_table" "main" {
  #checkov:skip=CKV_AWS_119:An AWS owned key avoids a dedicated KMS charge.
  #checkov:skip=CKV_AWS_28:Point-in-time recovery is off in the demo only, which the reset rebuilds every hour.
  name         = local.name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"

  attribute {
    name = "pk"
    type = "S"
  }

  attribute {
    name = "sk"
    type = "S"
  }

  # The markers of the mailed reminders go when "expires" (epoch seconds) has
  # passed.
  ttl {
    attribute_name = "expires"
    enabled        = true
  }

  # The demo is rebuilt every hour; production keeps 35 days of history.
  point_in_time_recovery {
    enabled = !var.demo
  }

  server_side_encryption {
    enabled = true
  }
}
