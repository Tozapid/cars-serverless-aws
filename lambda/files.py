"""Files of the events: receipts, photos and PDF documents.

They stay private in S3 under files/<user>/<id>.<ext>, where <user> is a
hash of the email. The page uploads a file straight to S3 through a
presigned POST and shows it through CloudFront with a signed cookie that
opens that user's folder only; every answer of the API renews the cookie. A
PDF is stored with Content-Disposition: attachment, so it downloads instead
of opening under the sandbox of the files (cloudfront.tf).
"""

import base64
import hashlib
import json
import os
import re
import time
import uuid

import common

COOKIE_SECONDS = 3600
TYPES = {"image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp", "application/pdf": "pdf"}
PATH_RE = re.compile(r"^/files/([0-9a-f]{20})/[0-9a-f]{32}\.(jpg|png|gif|webp|pdf)$")
SHA1_DIGEST_INFO = bytes.fromhex("3021300906052b0e03021a05000414")
_s3 = None
_signing_key = None


def user_key(owner):
    """The folder of the user's files; the email stays out of S3."""
    return hashlib.sha256(owner.encode("utf-8")).hexdigest()[:20]


def max_bytes():
    return int(common.env_number("FILE_MAX_BYTES", 10_485_760))


def owns(owner, path):
    match = PATH_RE.match(path or "")
    return bool(match) and match.group(1) == user_key(owner)


def s3():
    global _s3
    if _s3 is None:
        import boto3
        from botocore.config import Config

        # Sign against the regional endpoint. The global s3.amazonaws.com host
        # answers with a redirect, and a signed POST cannot follow it.
        region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION") or "eu-central-1"
        _s3 = boto3.client(
            "s3",
            region_name=region,
            endpoint_url=f"https://s3.{region}.amazonaws.com",
            config=Config(signature_version="s3v4", s3={"addressing_style": "virtual"}),
        )
    return _s3


def presign(owner, content_type, size):
    """Where the page posts a file: the form of the POST and the path the
    event keeps. None when the type or the size is not allowed."""
    content_type = str(content_type or "").lower()
    if content_type not in TYPES or not isinstance(size, int) or not 1 <= size <= max_bytes():
        return None
    key = f"files/{user_key(owner)}/{uuid.uuid4().hex}.{TYPES[content_type]}"
    fields = {"Content-Type": content_type}
    if content_type == "application/pdf":
        fields["Content-Disposition"] = "attachment"
    post = s3().generate_presigned_post(
        Bucket=os.environ["FILES_BUCKET"],
        Key=key,
        Fields=fields,
        Conditions=[{name: value} for name, value in fields.items()] + [["content-length-range", 1, max_bytes()]],
        ExpiresIn=300,
    )
    return {"post": post, "path": "/" + key}


def delete(paths):
    """Removes files from the bucket; the old versions go after 30 days."""
    keys = [{"Key": path.lstrip("/")} for path in paths if PATH_RE.match(path or "")]
    for start in range(0, len(keys), 1000):
        try:
            s3().delete_objects(Bucket=os.environ["FILES_BUCKET"], Delete={"Objects": keys[start:start + 1000], "Quiet": True})
        except Exception:
            common.logger.exception("files not deleted")


# Cookies ------------------------------------------------------------------------------

def viewer_host(event):
    headers = {str(key).lower(): value for key, value in (event.get("headers") or {}).items()}
    host = (headers.get("x-viewer-host") or "").split(",")[0].strip().split(":")[0]
    if not host or "execute-api" in host:
        return ""
    return host


def attach_cookies(result, event, owner):
    host = viewer_host(event)
    if not host:
        return
    try:
        result["cookies"] = cookies(host, owner)
    except Exception:
        common.logger.exception("file cookie was not issued")


# The cookie opens the files of its user only.
def cookies(host, owner, now=None):
    expires = int(now if now is not None else time.time()) + COOKIE_SECONDS
    policy = json.dumps({
        "Statement": [{
            "Resource": f"https://{host}/files/{user_key(owner)}/*",
            "Condition": {"DateLessThan": {"AWS:EpochTime": expires}},
        }]
    }, separators=(",", ":")).encode("utf-8")
    signature = rsa_sha1_sign(policy, signing_key())
    attributes = f"Path=/files; Secure; HttpOnly; SameSite=Lax; Max-Age={COOKIE_SECONDS}"
    return [
        f"CloudFront-Policy={cloudfront_b64(policy)}; {attributes}",
        f"CloudFront-Signature={cloudfront_b64(signature)}; {attributes}",
        f"CloudFront-Key-Pair-Id={os.environ['CLOUDFRONT_KEY_PAIR_ID']}; {attributes}",
    ]


def cloudfront_b64(data):
    return base64.b64encode(data).decode("ascii").replace("+", "-").replace("=", "_").replace("/", "~")


def signing_key():
    global _signing_key
    if _signing_key is None:
        parameter = common.client("ssm").get_parameter(Name=os.environ["FILES_KEY_PARAMETER_NAME"], WithDecryption=True)
        _signing_key = load_rsa_private_key(parameter["Parameter"]["Value"])
    return _signing_key


# CloudFront wants RSASSA-PKCS1-v1_5 with SHA-1. The runtime has no crypto
# package, so the key is read from its DER form and signed with plain pow().
def der_read(data, offset):
    tag = data[offset]
    length = data[offset + 1]
    offset += 2
    if length & 0x80:
        count = length & 0x7F
        length = int.from_bytes(data[offset:offset + count], "big")
        offset += count
    return tag, data[offset:offset + length], offset + length


def der_sequence(data):
    items = []
    offset = 0
    while offset < len(data):
        tag, value, offset = der_read(data, offset)
        items.append((tag, value))
    return items


def load_rsa_private_key(pem):
    lines = [line.strip() for line in pem.strip().splitlines()]
    der = base64.b64decode("".join(line for line in lines if line and not line.startswith("-----")))
    _, body, _ = der_read(der, 0)
    items = der_sequence(body)
    if len(items) == 3 and items[2][0] == 0x04:
        # PKCS#8 wraps the PKCS#1 key in an OCTET STRING.
        _, body, _ = der_read(items[2][1], 0)
        items = der_sequence(body)
    numbers = [int.from_bytes(value, "big") for tag, value in items if tag == 0x02]
    _, n, e, d, p, q, dp, dq, qinv = numbers[:9]
    return {"n": n, "e": e, "d": d, "p": p, "q": q, "dp": dp, "dq": dq, "qinv": qinv}


def rsa_sha1_sign(message, key):
    size = (key["n"].bit_length() + 7) // 8
    digest = SHA1_DIGEST_INFO + hashlib.sha1(message).digest()
    encoded = b"\x00\x01" + b"\xff" * (size - len(digest) - 3) + b"\x00" + digest
    m = int.from_bytes(encoded, "big")
    s1 = pow(m, key["dp"], key["p"])
    s2 = pow(m, key["dq"], key["q"])
    h = (key["qinv"] * (s1 - s2)) % key["p"]
    return (s2 + h * key["q"]).to_bytes(size, "big")
