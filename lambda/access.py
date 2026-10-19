"""Access without a Cognito sign-in: API keys and share links.

An API key (cars_<id>_<secret>) acts for its user on /api/v1/cars…; a key
of the scope "read" only reads. A share link (/#s/<token>) opens the cars of
its user, or one of them, read only, through /api/share/<token>/….

The user's partition keeps each of them (sk = APIKEY#<id>, SHARE#<id>) with
where and when it was made and last used. A pointer named by the SHA-256 of
the secret (pk = KEYHASH#<hash> or SHAREHASH#<hash>, sk = POINTER) finds the
user without a sign-in. Only the hash of a key is kept, so a key is shown
once; a share link keeps its token, so that it can be copied again.
"""

import hashlib
import secrets
import uuid
from datetime import datetime, timedelta, timezone

import common

KEYS_MAX = 10
SHARES_MAX = 20
SCOPES = ("read", "write")
KEY_PREFIX = "cars_"


def compact(item):
    return {key: value for key, value in item.items() if value not in (None, "")}


def digest(secret):
    return hashlib.sha256(secret.encode("utf-8")).hexdigest()


def new_id():
    return uuid.uuid4().hex[:8]


def client(event):
    """Where a request comes from: the viewer's address as CloudFront adds it
    to X-Forwarded-For (API Gateway adds CloudFront's after it), and the
    browser or program."""
    headers = {key.lower(): value for key, value in (event.get("headers") or {}).items()}
    forwarded = [part.strip() for part in (headers.get("x-forwarded-for") or "").split(",") if part.strip()]
    source = event.get("requestContext", {}).get("http", {}).get("sourceIp", "")
    address = forwarded[-2] if len(forwarded) >= 2 else forwarded[0] if forwarded else source
    return {"ip": address[:64], "agent": (headers.get("user-agent") or "")[:300]}


def public(item):
    """An item as the settings show it: without its keys and secrets."""
    return {key: value for key, value in common.plain(item).items() if key not in ("pk", "sk", "hash")}


def touched(item, event):
    seen = client(event)
    return {**item, "last_used": common.now_iso(), "last_ip": seen["ip"], "last_agent": seen["agent"], "uses": int(item.get("uses") or 0) + 1}


def owner_of(prefix, secret):
    pointer = common.get(prefix + digest(secret), "POINTER")
    return pointer and (pointer["owner"], pointer["id"])


# API keys -------------------------------------------------------------------------

def list_keys(owner):
    return sorted((public(item) for item in common.query_all("USER#" + owner, "APIKEY#")), key=lambda item: item["created"], reverse=True)


def create_key(owner, name, scope, event):
    """The new key's item and the key itself, which is not kept."""
    if len(common.query_all("USER#" + owner, "APIKEY#")) >= KEYS_MAX:
        return None, None
    key_id = new_id()
    key = f"{KEY_PREFIX}{key_id}_{secrets.token_urlsafe(24)}"
    seen = client(event)
    item = {"pk": "USER#" + owner, "sk": "APIKEY#" + key_id, "id": key_id, "name": name, "scope": scope, "hash": digest(key),
            "hint": key[:len(KEY_PREFIX) + len(key_id) + 1] + "…" + key[-4:],
            "created": common.now_iso(), "created_ip": seen["ip"], "created_agent": seen["agent"], "uses": 0}
    common.put(item)
    common.put({"pk": "KEYHASH#" + item["hash"], "sk": "POINTER", "owner": owner, "id": key_id})
    return public(item), key


def delete_key(owner, key_id):
    item = common.get("USER#" + owner, "APIKEY#" + key_id)
    if not item:
        return False
    common.delete_all([{"pk": "KEYHASH#" + item["hash"], "sk": "POINTER"}, item])
    return True


def use_key(key, event):
    """The user and the scope of a key, after noting its use; None for a key
    that is not one."""
    if not key.startswith(KEY_PREFIX):
        return None
    found = owner_of("KEYHASH#", key)
    if not found:
        return None
    owner, key_id = found
    item = common.get("USER#" + owner, "APIKEY#" + key_id)
    if not item or not secrets.compare_digest(item["hash"], digest(key)):
        return None
    common.put(touched(item, event))
    return owner, item["scope"]


def key_of(event):
    """The key of a request: Authorization: Bearer <key> or X-Api-Key."""
    headers = {name.lower(): value for name, value in (event.get("headers") or {}).items()}
    bearer = headers.get("authorization") or ""
    if bearer.lower().startswith("bearer "):
        return bearer[7:].strip()
    return (headers.get("x-api-key") or "").strip()


# Share links ------------------------------------------------------------------------

def list_shares(owner):
    return sorted((public(item) for item in common.query_all("USER#" + owner, "SHARE#")), key=lambda item: item["created"], reverse=True)


def create_share(owner, name, car, days, event):
    if len(common.query_all("USER#" + owner, "SHARE#")) >= SHARES_MAX:
        return None
    share_id = new_id()
    token = secrets.token_urlsafe(18)
    seen = client(event)
    expires = (datetime.now(timezone.utc) + timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%SZ") if days else None
    item = compact({"pk": "USER#" + owner, "sk": "SHARE#" + share_id, "id": share_id, "name": name, "car": car, "token": token,
                           "hash": digest(token), "expires": expires, "created": common.now_iso(),
                           "created_ip": seen["ip"], "created_agent": seen["agent"], "uses": 0})
    common.put(item)
    common.put({"pk": "SHAREHASH#" + item["hash"], "sk": "POINTER", "owner": owner, "id": share_id})
    return public(item)


def delete_share(owner, share_id):
    item = common.get("USER#" + owner, "SHARE#" + share_id)
    if not item:
        return False
    common.delete_all([{"pk": "SHAREHASH#" + item["hash"], "sk": "POINTER"}, item])
    return True


def use_share(token, event):
    """The share item of a token that is valid, after noting its use."""
    found = owner_of("SHAREHASH#", token) if token else None
    if not found:
        return None
    owner, share_id = found
    item = common.get("USER#" + owner, "SHARE#" + share_id)
    if not item or not secrets.compare_digest(item["hash"], digest(token)):
        return None
    if item.get("expires") and item["expires"] < common.now_iso():
        return None
    common.put(touched(item, event))
    return {**item, "owner": owner}
