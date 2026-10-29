locals {
  web_assets = {
    "index.html"  = "text/html; charset=utf-8"
    "app.js"      = "text/javascript; charset=utf-8"
    "stats.js"    = "text/javascript; charset=utf-8"
    "charts.js"   = "text/javascript; charset=utf-8"
    "i18n.js"     = "text/javascript; charset=utf-8"
    "styles.css"  = "text/css; charset=utf-8"
    "favicon.svg" = "image/svg+xml"
    # iOS puts a PNG on the home screen, never the SVG; the manifest offers
    # the PNGs to Android.
    "apple-touch-icon.png" = "image/png"
    "icon-192.png"         = "image/png"
    "icon-512.png"         = "image/png"
    # The offline side of the page (sw.js) and what a phone installs it as.
    "sw.js"         = "text/javascript; charset=utf-8"
    "manifest.json" = "application/manifest+json"
  }
}

resource "aws_s3_object" "web" {
  for_each = local.web_assets

  bucket        = aws_s3_bucket.web.id
  key           = each.key
  source        = "${path.module}/web/${each.key}"
  etag          = filemd5("${path.module}/web/${each.key}")
  content_type  = each.value
  cache_control = contains(["favicon.svg", "apple-touch-icon.png", "icon-192.png", "icon-512.png"], each.key) ? "public, max-age=86400" : "no-cache"
}

resource "aws_s3_object" "config" {
  bucket        = aws_s3_bucket.web.id
  key           = "config.js"
  content_type  = "text/javascript; charset=utf-8"
  cache_control = "no-cache"
  content = templatefile("${path.module}/web/config.js.tftpl", {
    region       = var.region
    user_pool_id = aws_cognito_user_pool.main.id
    client_id    = aws_cognito_user_pool_client.web.id
    # The demo publishes its sign-in on the sign-in screen; nothing else is.
    demo = jsonencode(var.demo ? {
      email    = var.admin_email
      password = var.admin_password
      reset    = local.reset
    } : null)
  })
}
