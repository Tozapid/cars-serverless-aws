locals {
  name         = var.name
  account_id   = data.aws_caller_identity.current.account_id
  web_bucket   = "${local.name}-web-${local.account_id}"
  files_bucket = "${local.name}-files-${local.account_id}"

  # The page on its own domain, or on the CloudFront address without one.
  custom_domain = var.domain_name != ""
  site_host     = local.custom_domain ? var.domain_name : aws_cloudfront_distribution.web.domain_name
  site_url      = "https://${local.site_host}"

  reset = var.reset_schedule != ""
  # The reminders by mail (ses.tf), from sender_address on domain_name. The
  # demo sends nothing.
  mail = !var.demo && var.sender_address != ""

  # The version of this deployment: the newest entry of CHANGELOG.md.
  version = regex("(?m)^## (v[0-9]+\\.[0-9]+\\.[0-9]+)(?:\\s|$)", file("${path.module}/CHANGELOG.md"))[0]

  csp = join("; ", [
    "default-src 'self'",
    # Only the libraries of the page, not all of jsDelivr and cdnjs; Leaflet
    # and its markercluster plugin draw the map.
    "script-src 'self' https://cdn.jsdelivr.net/npm/amazon-cognito-identity-js@6.3.15/ https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/ https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/ https://cdnjs.cloudflare.com/ajax/libs/leaflet.markercluster/1.5.3/",
    "style-src 'self' https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/ https://cdnjs.cloudflare.com/ajax/libs/leaflet.markercluster/1.5.3/",
    # The map tiles are OpenStreetMap's.
    "img-src 'self' blob: data: https://tile.openstreetmap.org",
    # Receipts go straight to the files bucket through a presigned POST.
    "connect-src 'self' https://cognito-idp.${var.region}.amazonaws.com https://*.s3.${var.region}.amazonaws.com",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ])
  # Receipts and photos are served from the site origin. The sandbox keeps a
  # file that is not an image from running script with the site's cookies; a
  # PDF is stored with Content-Disposition: attachment and downloads.
  files_csp = "default-src 'none'; img-src 'self' data:; sandbox"
}
