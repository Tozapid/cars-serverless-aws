"""Car log: the cars of each user, their events and reminders.

One function does all of it:

- the page calls /api/... through API Gateway with a Cognito token;
- the daily job ({"action": "daily"}) mails the reminders that are due
  (mail.py).

Every user has cars of their own. DynamoDB, a partition per user,
pk = USER#<email>:
sk = CAR#<car>                a car: name, make, model, year, VIN, plate, the
                              unit of its energy (kWh or L), currency, sold;
sk = EVENT#<car>#<id>         an event: kind (refuel, service, expense,
                              income), date (local time, YYYY-MM-DDTHH:MM),
                              odometer, category, amount, for a refuel the
                              quantity and the unit price, excluded (left out
                              of the statistics), notes, files;
sk = REMINDER#<car>#<id>      a reminder: category, every and unit, km, mail
                              (reminders.py);
sk = PREFS                    which mails the user wants.

The page reads all events of a car and counts the statistics itself; the
reminders come with their state (reminders.status).

API: /me, /me/prefs; /cars, /cars/<car>; /cars/<car>/events[/<id>];
/cars/<car>/reminders[/<id>];
/files (a presigned POST for a file of an event, files.py); /version.
Administrators, the members of the Cognito group ADMIN_GROUP, also manage
the accounts at /admin/users.
"""

import hashlib
import html.parser
import json
import os
import re
import secrets
import string
import time
import urllib.request
import uuid
from datetime import date, datetime, timezone
from urllib.parse import unquote

import common
import files
import access
import carexpenses
import mail
import reminders

FUELS = ("petrol", "diesel", "lpg", "cng", "electric")
# The mark of a car exported by the page (exportCar), the same on every site
# of this project; the first one is still read.
EXPORT_FORMATS = ("cars-serverless-aws", "cars.jagomann.com")
KINDS = ("refuel", "service", "expense", "income")
UNITS = ("kWh", "L")
# Events and reminders have 16 hex digits; a car has CAR_ID_LENGTH letters
# and digits, short for its addresses, or 16 hex digits when it was made
# before.
ID_RE = re.compile(r"^(?:[0-9a-f]{16}|[0-9a-z]{6})$")
CAR_ID_LENGTH = 6
CAR_ID_ALPHABET = string.ascii_lowercase + string.digits
DATE_RE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$")
CURRENCY_RE = re.compile(r"^[A-Z]{3}$")
EMAIL_RE = re.compile(r"[^@\s]+@[^@\s]+\.[^@\s]+")
CARS_MAX = 50
EVENTS_MAX = 20_000
REMINDERS_MAX = 200
FILES_MAX = 20
AMOUNT_MAX = 100_000_000
ODOMETER_MAX = 10_000_000

ERRORS = {
    "not_found": "Not found",
    "email_not_verified": "Email not verified",
    "admin_only": "Administrators only",
    "demo_readonly": "Not available in the demo",
    "read_only": "The cars of another user can only be viewed",
    "bad_key": "Missing or unknown API key",
    "key_read_only": "This API key may only read",
    "share_not_found": "This link does not exist or has expired",
    "too_many_keys": "Too many API keys",
    "too_many_shares": "Too many links",
    "bad_carexpenses": "This is not a backup of Car Expenses",
    "bad_export": "This is not a file exported from this site",
    "bad_json": "Invalid JSON",
    "bad_json_object": "A JSON object was expected",
    "too_large": "Request too large",
    "internal": "Internal error",
    "bad_field": "A field is not valid",
    "car_not_found": "No such car",
    "event_not_found": "No such event",
    "reminder_not_found": "No such reminder",
    "too_many_cars": "Too many cars",
    "too_many_events": "The car has too many events",
    "too_many_reminders": "The car has too many reminders",
    "bad_file": "A file must be JPEG, PNG, GIF, WebP or PDF and not larger than the limit",
    "bad_flag": "A switch must be on or off",
    "bad_email": "An email address is needed",
    "user_exists": "This user already exists",
    "user_not_found": "No such user",
    "not_yourself": "You cannot do this to your own account",
}


class ApiError(Exception):
    def __init__(self, status, code, detail=""):
        super().__init__(ERRORS[code])
        self.status = status
        self.code = code
        self.message = ERRORS[code]
        # Which field was wrong, for the page to show.
        self.detail = detail


def handler(event, context):
    if not isinstance(event, dict):
        return {"ok": True}
    if event.get("action") == "daily":
        return {"mails": mail.send_reminders()}
    if "requestContext" in event:
        return api(event)
    return {"ok": True}


# API ----------------------------------------------------------------------------

def api(event):
    method = event.get("requestContext", {}).get("http", {}).get("method", "GET")
    parts = [unquote(part) for part in (event.get("rawPath") or "/").split("/") if part]
    owner = None
    try:
        if parts[:1] != ["api"]:
            raise ApiError(404, "not_found")
        # Without a Cognito sign-in: an API key or a share link, whose routes
        # API Gateway lets through without the JWT authorizer.
        if parts[1:2] == ["v1"]:
            owner, result = keyed(method, parts[2:], event)
        elif parts[1:2] == ["share"]:
            owner, result = shared(method, parts[2:], event)
        else:
            owner = actor(event)
            # An administrator reads the cars of another user with ?owner=<email>.
            if parts[1:2] == ["cars"] and query_param(event, "owner"):
                viewed = clean_email(query_param(event, "owner"))
                if viewed != owner:
                    if not is_admin(event):
                        raise ApiError(403, "admin_only")
                    if method != "GET":
                        raise ApiError(403, "read_only")
                    owner = viewed
            result = route(method, parts[1:], event, owner)
    except ApiError as exc:
        result = response(exc.status, {"error": exc.message, "code": exc.code, **({"detail": exc.detail} if exc.detail else {})})
    except json.JSONDecodeError:
        result = response(400, {"error": ERRORS["bad_json"], "code": "bad_json"})
    except Exception:
        common.logger.exception("unhandled")
        result = response(500, {"error": ERRORS["internal"], "code": "internal"})
    if 200 <= result["statusCode"] < 300 and owner:
        files.attach_cookies(result, event, owner)
    common.logger.info("%s %s -> %s", method, route_label(event.get("rawPath") or "/"), result["statusCode"])
    return result


# The log names the route, not the request: the token of a share link, car,
# event and reminder ids and whatever else a caller puts in the path stay out
# of it. Each word comes from this table, never from the request.
ROUTE_WORDS = {word: word for word in (
    "api", "v1", "share", "me", "prefs", "version", "keys", "shares", "files", "admin", "users", "owners",
    "cars", "events", "reminders", "import", "json", "carexpenses",
)}


def route_label(path):
    return "/" + "/".join(ROUTE_WORDS.get(part, "*") for part in path.split("/") if part)


# /api/v1/…: the cars of the key's user; a read key only reads.
def keyed(method, parts, event):
    found = access.use_key(access.key_of(event), event)
    if not found:
        raise ApiError(401, "bad_key")
    owner, scope = found
    if parts == ["me"] and method == "GET":
        return owner, response(200, {"email": owner, "scope": scope})
    if parts[:1] != ["cars"]:
        raise ApiError(404, "not_found")
    if method != "GET" and scope != "write":
        raise ApiError(403, "key_read_only")
    return owner, route(method, parts, event, owner)


# /api/share/<token>/…: what the link shows, read only: its user's cars, or
# the one car it names.
def shared(method, parts, event):
    share = access.use_share(parts[0] if parts else "", event)
    if not share:
        raise ApiError(404, "share_not_found")
    owner, rest = share["owner"], parts[1:]
    if method != "GET":
        raise ApiError(403, "read_only")
    if not rest:
        lead_days, lead_km = reminders.lead()
        return owner, response(200, {"name": share.get("name", ""), "car": share.get("car"), "expires": share.get("expires"),
                                     "lead_days": lead_days, "lead_km": lead_km})
    if rest[:1] != ["cars"]:
        raise ApiError(404, "not_found")
    if share.get("car"):
        if rest == ["cars"]:
            return owner, response(200, {"items": [public(item) for item in cars(owner) if item["id"] == share["car"]]})
        if len(rest) < 2 or rest[1] != share["car"]:
            raise ApiError(404, "car_not_found")
    return owner, route(method, rest, event, owner)


def route(method, parts, event, owner):
    if parts == ["me"] and method == "GET":
        lead_days, lead_km = reminders.lead()
        return response(200, {"email": owner, "admin": is_admin(event), "demo": demo(), "prefs": mail.prefs(owner), "mail": bool(os.environ.get("SENDER")),
                              "file_max_bytes": files.max_bytes(), "lead_days": lead_days, "lead_km": lead_km})
    if parts == ["me", "prefs"] and method == "PUT":
        return response(200, save_prefs(owner, body_json(event)))
    if parts == ["version"] and method == "GET":
        return response(200, version_info())
    if parts == ["keys"]:
        return keys_route(method, event, owner)
    if parts == ["shares"]:
        return shares_route(method, event, owner)
    if parts == ["files"] and method == "POST":
        payload = body_json(event)
        target = files.presign(owner, payload.get("content_type"), payload.get("size"))
        if not target:
            raise ApiError(400, "bad_file")
        return response(200, target)
    if parts[:1] == ["admin"]:
        if not is_admin(event):
            raise ApiError(403, "admin_only")
        return admin_route(method, parts[1:], event, owner)
    if parts == ["cars"] and method == "GET":
        # A car made before the counts were kept gets them once here.
        return response(200, {"items": [public(item if "event_count" in item else count_events(owner, item["id"])) for item in cars(owner)]})
    if parts == ["cars"] and method == "POST":
        return response(201, create_car(owner, body_json(event)))
    if len(parts) >= 2 and parts[0] == "cars":
        car = get_car(owner, parts[1])
        return car_route(method, parts[2:], event, owner, car)
    raise ApiError(404, "not_found")


def car_route(method, rest, event, owner, car):
    if not rest and method == "GET":
        return response(200, public(car))
    if not rest and method == "PUT":
        return response(200, save_car(owner, car, body_json(event)))
    if not rest and method == "DELETE":
        return response(200, delete_car(owner, car))
    if rest == ["events"] and method == "GET":
        return response(200, {"items": [public(item) for item in car_events(owner, car["id"])]})
    if rest == ["events"] and method == "POST":
        return response(201, create_event(owner, car, body_json(event)))
    if len(rest) == 2 and rest[0] == "events":
        current = get_item(owner, f"EVENT#{car['id']}#", rest[1], "event_not_found")
        if method == "PUT":
            return response(200, save_event(owner, car, current, body_json(event)))
        if method == "DELETE":
            common.table().delete_item(Key={"pk": current["pk"], "sk": current["sk"]})
            files.delete([item["path"] for item in current.get("files") or []])
            count_events(owner, car["id"])
            return response(200, {"deleted": current["id"]})
    if rest == ["reminders"] and method == "GET":
        return response(200, {"items": reminder_list(owner, car["id"])})
    if rest == ["reminders"] and method == "POST":
        return response(201, create_reminder(owner, car, body_json(event)))
    if len(rest) == 2 and rest[0] == "reminders":
        current = get_item(owner, f"REMINDER#{car['id']}#", rest[1], "reminder_not_found")
        if method == "PUT":
            return response(200, save_reminder(owner, car, current, body_json(event)))
        if method == "DELETE":
            common.table().delete_item(Key={"pk": current["pk"], "sk": current["sk"]})
            return response(200, {"deleted": current["id"]})
    if rest == ["import", "json"] and method == "POST":
        return response(200, import_json(owner, car, body_json(event, limit=5_000_000)))
    if rest == ["import", "carexpenses"] and method == "POST":
        # The text of a backup without its pictures: some hundred kilobytes.
        return response(200, import_carexpenses(owner, car, body_json(event, limit=3_000_000)))
    if len(rest) == 3 and rest[0] == "events" and rest[2] == "files" and method == "POST":
        current = get_item(owner, f"EVENT#{car['id']}#", rest[1], "event_not_found")
        return response(200, add_files(owner, current, body_json(event)))
    raise ApiError(404, "not_found")


def public(item):
    return {key: value for key, value in common.plain(item).items() if key not in ("pk", "sk")}


def new_id():
    return uuid.uuid4().hex[:16]


def new_car_id():
    return "".join(secrets.choice(CAR_ID_ALPHABET) for _ in range(CAR_ID_LENGTH))


def pk(owner):
    return "USER#" + owner


def get_item(owner, prefix, item_id, code):
    item = common.get(pk(owner), prefix + item_id) if ID_RE.match(item_id or "") else None
    if not item:
        raise ApiError(404, code)
    return item


# Fields -------------------------------------------------------------------------

def text(payload, name, limit, required=False):
    value = payload.get(name)
    if value is None:
        value = ""
    if not isinstance(value, str) or len(value) > limit:
        raise ApiError(400, "bad_field", name)
    value = value.strip()
    if required and not value:
        raise ApiError(400, "bad_field", name)
    return value


def number(payload, name, low, high, integer=False):
    """A number of the payload, or None when it is empty."""
    value = payload.get(name)
    if value is None or value == "":
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value != value or not low <= value <= high:
        raise ApiError(400, "bad_field", name)
    if integer:
        if int(value) != value:
            raise ApiError(400, "bad_field", name)
        return int(value)
    return float(value)


def flag(payload, name, default=False):
    value = payload.get(name, default)
    if not isinstance(value, bool):
        raise ApiError(400, "bad_field", name)
    return value


def compact(item):
    """Without the fields that are empty."""
    return {key: value for key, value in item.items() if value not in (None, "", [])}


# API keys and share links (access.py) ------------------------------------------------

def keys_route(method, event, owner):
    if method == "GET":
        return response(200, {"items": access.list_keys(owner)})
    if method == "POST":
        payload = body_json(event)
        scope = payload.get("scope", "read")
        if scope not in access.SCOPES:
            raise ApiError(400, "bad_field", "scope")
        item, key = access.create_key(owner, text(payload, "name", 100) or "API", scope, event)
        if not item:
            raise ApiError(400, "too_many_keys")
        return response(201, {**item, "key": key})
    if method == "DELETE":
        if not access.delete_key(owner, query_param(event, "id")):
            raise ApiError(404, "not_found")
        return response(200, {"deleted": query_param(event, "id")})
    raise ApiError(404, "not_found")


def shares_route(method, event, owner):
    if method == "GET":
        return response(200, {"items": access.list_shares(owner)})
    if method == "POST":
        payload = body_json(event)
        car = text(payload, "car", 32) or None
        if car:
            get_car(owner, car)
        days = number(payload, "days", 1, 3650, integer=True)
        item = access.create_share(owner, text(payload, "name", 100), car, days, event)
        if not item:
            raise ApiError(400, "too_many_shares")
        return response(201, item)
    if method == "DELETE":
        if not access.delete_share(owner, query_param(event, "id")):
            raise ApiError(404, "not_found")
        return response(200, {"deleted": query_param(event, "id")})
    raise ApiError(404, "not_found")


# Cars ---------------------------------------------------------------------------

def cars(owner):
    return sorted(common.query_all(pk(owner), "CAR#"), key=lambda item: (bool(item.get("sold")), item.get("created", "")))


def get_car(owner, car_id):
    return get_item(owner, "CAR#", car_id, "car_not_found")


def car_fields(owner, payload):
    unit = payload.get("unit", "kWh")
    if unit not in UNITS:
        raise ApiError(400, "bad_field", "unit")
    currency = text(payload, "currency", 3) or "EUR"
    if not CURRENCY_RE.match(currency):
        raise ApiError(400, "bad_field", "currency")
    return {
        "name": text(payload, "name", 100, required=True),
        "make": text(payload, "make", 100),
        "model": text(payload, "model", 100),
        "year": number(payload, "year", 1886, 2100, integer=True),
        "vin": text(payload, "vin", 32).upper(),
        "plate": text(payload, "plate", 20),
        "unit": unit,
        "currency": currency,
        "notes": text(payload, "notes", 5000),
        "sold": flag(payload, "sold"),
        "photo": car_photo(owner, payload.get("photo")),
    }


# The photo of a car: one image of its owner, as a file of an event.
def car_photo(owner, value):
    if value in (None, "", {}):
        return None
    if not isinstance(value, dict) or not str(value.get("type") or "").startswith("image/"):
        raise ApiError(400, "bad_field", "photo")
    return file_entry(owner, value, "photo")


def create_car(owner, payload):
    if len(cars(owner)) >= CARS_MAX:
        raise ApiError(400, "too_many_cars")
    fields = car_fields(owner, payload)
    now = common.now_iso()
    # The short id is unique among the user's cars: a taken one is drawn again.
    for _ in range(10):
        car_id = new_car_id()
        item = compact({"pk": pk(owner), "sk": "CAR#" + car_id, "id": car_id, **fields, "created": now, "modified": now})
        if common.put_new(item):
            return public(item)
    raise ApiError(500, "internal")


def save_car(owner, car, payload):
    item = compact({**{key: car[key] for key in ("pk", "sk", "id", "created")}, **car_fields(owner, payload),
                    "modified": common.now_iso(), **{key: car.get(key) for key in ("imported", "last_event", "event_count")}})
    common.put(item)
    old = (car.get("photo") or {}).get("path")
    if old and old != (item.get("photo") or {}).get("path"):
        files.delete([old])
    return public(item)


# The car keeps the day of its last event and how many it has, for the list
# of cars, which does not read the events: counted again after each change.
def count_events(owner, car_id, events=None):
    car = common.get(pk(owner), "CAR#" + car_id)
    if events is None:
        events = car_events(owner, car_id)
    item = {key: value for key, value in car.items() if key != "last_event"}
    item["event_count"] = len(events)
    if events:
        item["last_event"] = max(str(event["date"]) for event in events)
    common.put(item)
    return item


def delete_car(owner, car):
    items = common.query_all(pk(owner), f"EVENT#{car['id']}#") + common.query_all(pk(owner), f"REMINDER#{car['id']}#")
    files.delete([entry["path"] for item in items for entry in item.get("files") or []]
                 + ([car["photo"]["path"]] if car.get("photo") else []))
    common.delete_all(items + [car])
    return {"deleted": car["id"], "items": len(items)}


# Events -------------------------------------------------------------------------

def car_events(owner, car_id):
    return common.query_all(pk(owner), f"EVENT#{car_id}#")


def event_files(owner, payload):
    value = payload.get("files") or []
    if not isinstance(value, list) or len(value) > FILES_MAX:
        raise ApiError(400, "bad_field", "files")
    return [file_entry(owner, entry, "files") for entry in value]


def file_entry(owner, entry, field):
    if not isinstance(entry, dict) or not files.owns(owner, entry.get("path")):
        raise ApiError(400, "bad_field", field)
    size = number(entry, "size", 0, 1_000_000_000, integer=True)
    return compact({"path": entry["path"], "name": text(entry, "name", 200), "type": text(entry, "type", 100), "size": size})


# Where the event was, as the browser gave it: latitude, longitude and the
# accuracy in metres.
def event_location(value):
    if value in (None, "", {}):
        return None
    if not isinstance(value, dict):
        raise ApiError(400, "bad_field", "location")
    try:
        found = {"lat": number(value, "lat", -90, 90), "lon": number(value, "lon", -180, 180),
                 "accuracy": number(value, "accuracy", 0, 1_000_000)}
    except ApiError:
        raise ApiError(400, "bad_field", "location") from None
    if found["lat"] is None or found["lon"] is None:
        raise ApiError(400, "bad_field", "location")
    return compact({"lat": round(found["lat"], 6), "lon": round(found["lon"], 6),
                    "accuracy": round(found["accuracy"]) if found["accuracy"] is not None else None})


def event_fields(owner, payload):
    kind = payload.get("kind")
    if kind not in KINDS:
        raise ApiError(400, "bad_field", "kind")
    when = text(payload, "date", 16, required=True)
    match = DATE_RE.match(when)
    try:
        if not match:
            raise ValueError(when)
        datetime(*(int(part) for part in match.groups()))
    except ValueError:
        raise ApiError(400, "bad_field", "date") from None
    item = {
        "kind": kind,
        "date": when,
        "odometer": number(payload, "odometer", 0, ODOMETER_MAX),
        "category": " ".join(text(payload, "category", 100).split()),
        "amount": number(payload, "amount", -AMOUNT_MAX, AMOUNT_MAX),
        "excluded": flag(payload, "excluded"),
        "notes": text(payload, "notes", 5000),
        "link": text(payload, "link", 2000),
        "files": event_files(owner, payload),
        "location": event_location(payload.get("location")),
    }
    if item["link"] and not item["link"].startswith("https://"):
        raise ApiError(400, "bad_field", "link")
    if kind == "refuel":
        item["quantity"] = number(payload, "quantity", 0, 1_000_000)
        item["price"] = number(payload, "price", 0, 1_000_000)
        # The fuel of a car with more than one, such as gas and petrol; the
        # page guesses it from the station when it is missing.
        fuel = payload.get("fuel") or None
        if fuel is not None and fuel not in FUELS:
            raise ApiError(400, "bad_field", "fuel")
        item["fuel"] = fuel
        if item["amount"] is None and item["quantity"] is not None and item["price"] is not None:
            item["amount"] = item["quantity"] * item["price"]
    if item["amount"] is None:
        item["amount"] = 0.0
    return item


# The page may name a new event itself (16 hex digits): an event saved
# without a network waits on the phone and is sent again until it gets
# through, and the second time it is already there and stays as it is.
def create_event(owner, car, payload):
    fields = event_fields(owner, payload)
    wanted = str(payload.get("id") or "")
    if wanted and not re.fullmatch(r"[0-9a-f]{16}", wanted):
        raise ApiError(400, "bad_field", "id")
    if wanted:
        known = common.get(pk(owner), f"EVENT#{car['id']}#{wanted}")
        if known:
            return public(known)
    events = car_events(owner, car["id"])
    if len(events) >= EVENTS_MAX:
        raise ApiError(400, "too_many_events")
    event_id = wanted or new_id()
    now = common.now_iso()
    item = compact({"pk": pk(owner), "sk": f"EVENT#{car['id']}#{event_id}", "id": event_id, "car": car["id"],
                    **fields, "created": now, "modified": now, "by": owner})
    if not common.put_new(item):
        return public(common.get(pk(owner), item["sk"]))
    count_events(owner, car["id"], events + [item])
    return public(item)


def save_event(owner, car, current, payload):
    item = compact({**{key: current[key] for key in ("pk", "sk", "id", "car", "created")}, **event_fields(owner, payload),
                    "modified": common.now_iso(), "by": owner, "source": current.get("source")})
    common.put(item)
    count_events(owner, car["id"])
    # Files taken off the event go from the bucket too.
    kept = {entry["path"] for entry in item.get("files") or []}
    files.delete([entry["path"] for entry in current.get("files") or [] if entry["path"] not in kept])
    return public(item)


# Reminders ----------------------------------------------------------------------

def reminder_fields(payload):
    repeat = payload.get("repeat") or "period"
    if repeat not in reminders.REPEATS:
        raise ApiError(400, "bad_field", "repeat")
    start = text(payload, "start", 10) or None
    if start:
        try:
            date.fromisoformat(start)
        except ValueError:
            raise ApiError(400, "bad_field", "start") from None
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", start):
            raise ApiError(400, "bad_field", "start")
    common_fields = {
        "category": " ".join(text(payload, "category", 100, required=True).split()),
        "repeat": repeat,
        "start": start,
        "notes": text(payload, "notes", 1000),
        "mail": flag(payload, "mail", True),
    }
    if repeat == "monthday":
        day = number(payload, "day", 1, 31, integer=True)
        if not day:
            raise ApiError(400, "bad_field", "day")
        return {**common_fields, "day": day}
    if repeat == "weekday":
        days = payload.get("weekdays")
        if not isinstance(days, list) or not days or any(isinstance(day, bool) or day not in range(1, 8) for day in days):
            raise ApiError(400, "bad_field", "weekdays")
        return {**common_fields, "weekdays": sorted(set(days))}
    # "days" alone is a period in days, as the API took it before units.
    unit = payload.get("unit") or "day"
    if unit not in reminders.UNITS:
        raise ApiError(400, "bad_field", "unit")
    every = number(payload, "every", 1, reminders.UNITS[unit], integer=True) if "every" in payload else number(payload, "days", 1, 36500, integer=True)
    item = {
        **common_fields,
        "every": every,
        "unit": unit if every else None,
        "km": number(payload, "km", 1, ODOMETER_MAX, integer=True),
    }
    if not item["every"] and not item["km"]:
        raise ApiError(400, "bad_field", "every")
    return item


def reminder_list(owner, car_id):
    events = car_events(owner, car_id)
    items = common.query_all(pk(owner), f"REMINDER#{car_id}#")
    found = [{**public(item), "status": reminders.status(item, events)} for item in items]
    return sorted(found, key=lambda item: item["category"].casefold())


def create_reminder(owner, car, payload):
    if len(common.query_all(pk(owner), f"REMINDER#{car['id']}#")) >= REMINDERS_MAX:
        raise ApiError(400, "too_many_reminders")
    reminder_id = new_id()
    now = common.now_iso()
    item = compact({"pk": pk(owner), "sk": f"REMINDER#{car['id']}#{reminder_id}", "id": reminder_id, "car": car["id"],
                    **reminder_fields(payload), "created": now, "modified": now})
    common.put(item)
    return {**public(item), "status": reminders.status(item, car_events(owner, car["id"]))}


def save_reminder(owner, car, current, payload):
    item = compact({**{key: current[key] for key in ("pk", "sk", "id", "car")}, **reminder_fields(payload),
                    "created": current.get("created"), "modified": common.now_iso()})
    common.put(item)
    return {**public(item), "status": reminders.status(item, car_events(owner, car["id"]))}


# Import -------------------------------------------------------------------------

# What says when a reminder is due.
SCHEDULE = ("repeat", "every", "unit", "km", "day", "weekdays", "start", "days")


def schedule_of(item):
    found = compact({key: common.plain(item.get(key)) for key in SCHEDULE})
    return {**found, "repeat": found.get("repeat") or "period"}


def import_id(item, seen):
    """The id of an imported event: the same event gives the same id at
    every import; identical ones are told apart by their order."""
    key = "|".join(str(part) for part in (item["kind"], item["date"], item["category"].casefold(),
                                         round(item.get("odometer", -1)), round(item["amount"], 2)))
    seen[key] = seen.get(key, 0) + 1
    return hashlib.sha256(f"{key}|{seen[key]}".encode("utf-8")).hexdigest()[:16]


def merge_reminders(owner, car, entries, now, result):
    """The reminders of an import: a new category is a new reminder; one the
    car has gets the schedule of the import. Car Expenses gives periods only
    (no "repeat") and leaves a calendar reminder as it is; an exported file
    gives the whole schedule."""
    if not entries:
        return
    current = common.query_all(pk(owner), f"REMINDER#{car['id']}#")
    for entry in entries:
        match = next((item for item in current if reminders.same(item["category"], entry["category"])), None)
        if match:
            if "repeat" not in entry and (match.get("repeat") or "period") != "period":
                continue
            schedule = compact({key: entry.get(key) for key in SCHEDULE})
            if schedule_of(match) != schedule_of(schedule):
                updated = {key: value for key, value in match.items() if key not in SCHEDULE}
                common.put(compact({**updated, **schedule, "modified": now}))
                result["reminders_updated"] += 1
        elif len(current) < REMINDERS_MAX:
            reminder_id = new_id()
            item = compact({"pk": pk(owner), "sk": f"REMINDER#{car['id']}#{reminder_id}", "id": reminder_id, "car": car["id"],
                            **entry, "mail": True, "created": now, "modified": now})
            common.put(item)
            current.append(item)
            result["reminders_created"] += 1


def import_carexpenses(owner, car, payload):
    """The events and reminders of a Car Expenses backup (carexpenses.py).
    An event imported before is left as it is. "expense_events" names the
    new event of each CE expense, {CE expense id: event id}: the page puts
    the pictures it cut out of the backup on them."""
    rate = number(payload, "rate", 0.000001, 1000) or 1.0
    try:
        found = carexpenses.read(str(payload.get("text") or ""), text(payload, "vehicle", 200) or None, rate)
    except carexpenses.CarExpensesError as exc:
        raise ApiError(400, exc.code) from None
    existing = car_events(owner, car["id"])
    if len(existing) + len(found["events"]) > EVENTS_MAX:
        raise ApiError(400, "too_many_events")
    known = {item["id"] for item in existing}
    now = common.now_iso()
    result = {"vehicle": found["name"], "created": {kind: 0 for kind in KINDS}, "unchanged": 0, "reminders_created": 0, "reminders_updated": 0,
              "expense_events": {}}
    seen = {}
    for entry in found["events"]:
        fields = compact(event_fields(owner, {key: value for key, value in entry.items() if key != "ce_expense"}))
        event_id = import_id(fields, seen)
        if event_id in known:
            result["unchanged"] += 1
            continue
        item = compact({"pk": pk(owner), "sk": f"EVENT#{car['id']}#{event_id}", "id": event_id, "car": car["id"], **fields,
                        "source": "carexpenses", "created": now, "modified": now, "by": owner})
        if common.put_new(item):
            result["created"][fields["kind"]] += 1
            known.add(event_id)
            if entry.get("ce_expense"):
                result["expense_events"][entry["ce_expense"]] = event_id
        else:
            result["unchanged"] += 1
    merge_reminders(owner, car, found["reminders"], now, result)
    # The empty fields of the car, and the vehicle's note in its notes.
    filled = {key: value for key, value in found["vehicle"].items() if value and not car.get(key) and key != "unit"}
    result["car_id"] = found["vehicle_id"]
    notes = car.get("notes", "")
    if found["notes"] and found["notes"][:200] not in notes:
        notes = (notes + "\n\n" + found["notes"]).strip()[:5000]
    common.put(compact({**car, **filled, "notes": notes, "imported": now}))
    count_events(owner, car["id"])
    return result


def import_json(owner, car, payload):
    """A car exported by the page (exportCar in web/app.js) into this car:
    its events keep their ids, so a second import of the file adds nothing;
    its reminders go in as those of an import; the empty fields of the car
    are filled. The files come afterwards: the page uploads the ones of the
    new events, "event_ids" names them, {id in the file: id here}."""
    if payload.get("format") not in EXPORT_FORMATS or not isinstance(payload.get("events"), list) or not isinstance(payload.get("reminders", []), list):
        raise ApiError(400, "bad_export")
    entries = payload["events"]
    existing = car_events(owner, car["id"])
    if len(existing) + len(entries) > EVENTS_MAX:
        raise ApiError(400, "too_many_events")
    known = {item["id"] for item in existing}
    now = common.now_iso()
    result = {"created": {kind: 0 for kind in KINDS}, "unchanged": 0, "reminders_created": 0, "reminders_updated": 0, "event_ids": {}}
    seen = {}
    for entry in entries:
        if not isinstance(entry, dict):
            raise ApiError(400, "bad_export")
        # Files are put on the new events afterwards, under this user's paths.
        fields = compact(event_fields(owner, {**entry, "files": []}))
        original = str(entry.get("id") or "")
        event_id = original if ID_RE.match(original) else import_id(fields, seen)
        if event_id in known:
            result["unchanged"] += 1
            continue
        created = text(entry, "created", 30) or now
        item = compact({"pk": pk(owner), "sk": f"EVENT#{car['id']}#{event_id}", "id": event_id, "car": car["id"], **fields,
                        "source": text(entry, "source", 30) or "json", "created": created, "modified": now, "by": owner})
        if common.put_new(item):
            result["created"][fields["kind"]] += 1
            known.add(event_id)
            if original:
                result["event_ids"][original] = event_id
        else:
            result["unchanged"] += 1
    reminders_in = []
    for entry in payload.get("reminders") or []:
        if isinstance(entry, dict):
            reminders_in.append(compact(reminder_fields(entry)))
    merge_reminders(owner, car, reminders_in, now, result)
    source = payload.get("car") if isinstance(payload.get("car"), dict) else {}
    filled = {key: source[key] for key in ("make", "model", "year", "vin", "plate", "notes") if source.get(key) and not car.get(key)}
    if filled:
        checked = car_fields(owner, {**{key: car.get(key) for key in ("name", "make", "model", "year", "vin", "plate", "unit", "currency", "notes", "sold")}, **filled})
        common.put(compact({**car, **{key: checked[key] for key in filled}, "imported": now}))
    else:
        common.put(compact({**car, "imported": now}))
    count_events(owner, car["id"])
    return result


def add_files(owner, current, payload):
    """Files put on an event after it was made: the pictures of an import."""
    added = event_files(owner, payload)
    files_now = (current.get("files") or []) + [entry for entry in added if entry["path"] not in {item["path"] for item in current.get("files") or []}]
    if len(files_now) > FILES_MAX:
        raise ApiError(400, "bad_field", "files")
    item = {**current, "files": files_now, "modified": common.now_iso()}
    common.put(item)
    return public(item)


# Settings -----------------------------------------------------------------------

def save_prefs(owner, payload):
    current = mail.prefs(owner)
    if "reminders" in payload:
        if not isinstance(payload["reminders"], bool):
            raise ApiError(400, "bad_flag")
        current["reminders"] = payload["reminders"]
    common.put({"pk": pk(owner), "sk": "PREFS", **current, "updated_at": common.now_iso()})
    return current


# Administration -------------------------------------------------------------

def admin_route(method, parts, event, me):
    # The demo shows the users; changing them is not for visitors.
    if demo() and method != "GET":
        raise ApiError(403, "demo_readonly")
    if parts == ["users"] and method == "GET":
        return response(200, {"items": list_users(me)})
    if parts == ["owners"] and method == "GET":
        return response(200, {"items": owners()})
    if parts == ["users"] and method == "POST":
        payload = body_json(event)
        return response(201, create_user(clean_email(payload.get("email")), payload.get("admin") is True))
    if parts == ["users"] and method == "PUT":
        return response(200, update_user(body_json(event), me))
    if parts == ["users"] and method == "DELETE":
        email = clean_email(query_param(event, "email"))
        if email == me:
            raise ApiError(400, "not_yourself")
        return response(200, delete_user(email))
    raise ApiError(404, "not_found")


# Only a verified email from the Cognito token counts, and only the groups
# Cognito put into it.
def actor(event):
    claims = event.get("requestContext", {}).get("authorizer", {}).get("jwt", {}).get("claims", {})
    address = str(claims.get("email") or "").lower()
    if not address or str(claims.get("email_verified")).lower() != "true":
        raise ApiError(403, "email_not_verified")
    return address


# The public demo (DEMO=true): its visitors share one account.
def demo():
    return os.environ.get("DEMO", "false") == "true"


def is_admin(event):
    claims = event.get("requestContext", {}).get("authorizer", {}).get("jwt", {}).get("claims", {})
    groups = claims.get("cognito:groups") or []
    if isinstance(groups, str):
        # API Gateway passes a list claim as a string such as "[admins other]".
        groups = groups.strip("[]").replace(",", " ").split()
    return admin_group() in groups


def admin_group():
    return os.environ.get("ADMIN_GROUP", "admins")


def cognito():
    return common.client("cognito-idp")


# The users and how many cars each has, for an administrator to open theirs.
def owners():
    pool = os.environ["USER_POOL_ID"]
    found = []
    for page in cognito().get_paginator("list_users").paginate(UserPoolId=pool):
        for user in page.get("Users", []):
            email = user_email(user)
            found.append({"email": email, "cars": len(cars(email))})
    return sorted(found, key=lambda item: item["email"])


def list_users(me):
    pool = os.environ["USER_POOL_ID"]
    admins = set()
    for page in cognito().get_paginator("list_users_in_group").paginate(UserPoolId=pool, GroupName=admin_group()):
        admins.update(user_email(user) for user in page.get("Users", []))
    users = []
    for page in cognito().get_paginator("list_users").paginate(UserPoolId=pool):
        for user in page.get("Users", []):
            email = user_email(user)
            users.append({
                "email": email,
                "status": user.get("UserStatus", ""),
                "enabled": bool(user.get("Enabled", True)),
                "created": common.iso(user["UserCreateDate"]) if user.get("UserCreateDate") else "",
                "admin": email in admins,
                "mfa": has_mfa(pool, user.get("Username")),
                "self": email == me,
            })
    users.sort(key=lambda user: user["email"])
    return users


# ListUsers does not say whether a user has an authenticator app, so each user
# is asked for separately. There are a handful of users.
def has_mfa(pool, username):
    user = cognito().admin_get_user(UserPoolId=pool, Username=username)
    return "SOFTWARE_TOKEN_MFA" in (user.get("UserMFASettingList") or [])


def create_user(email, admin):
    pool = os.environ["USER_POOL_ID"]
    password = temporary_password()
    try:
        cognito().admin_create_user(
            UserPoolId=pool,
            Username=email,
            UserAttributes=[{"Name": "email", "Value": email}, {"Name": "email_verified", "Value": "true"}],
            TemporaryPassword=password,
            DesiredDeliveryMediums=["EMAIL"],
        )
    except Exception as exc:
        if common.error_code(exc) == "UsernameExistsException":
            raise ApiError(409, "user_exists") from None
        raise
    if admin:
        cognito().admin_add_user_to_group(UserPoolId=pool, Username=email, GroupName=admin_group())
    return {"email": email, "temporary_password": password}


def update_user(payload, me):
    email = clean_email(payload.get("email"))
    pool = os.environ["USER_POOL_ID"]
    own = email == me
    result = {"email": email}
    for name in ("enabled", "admin", "reset_mfa", "reset_password"):
        if name in payload and not isinstance(payload[name], bool):
            raise ApiError(400, "bad_flag")
    try:
        if "enabled" in payload:
            if own and not payload["enabled"]:
                raise ApiError(400, "not_yourself")
            if payload["enabled"]:
                cognito().admin_enable_user(UserPoolId=pool, Username=email)
            else:
                cognito().admin_disable_user(UserPoolId=pool, Username=email)
        if "admin" in payload:
            if own and not payload["admin"]:
                raise ApiError(400, "not_yourself")
            if payload["admin"]:
                cognito().admin_add_user_to_group(UserPoolId=pool, Username=email, GroupName=admin_group())
            else:
                cognito().admin_remove_user_from_group(UserPoolId=pool, Username=email, GroupName=admin_group())
        # A user who lost their phone signs in with the password alone and can
        # set up the app again in the settings.
        if payload.get("reset_mfa"):
            cognito().admin_set_user_mfa_preference(
                UserPoolId=pool,
                Username=email,
                SoftwareTokenMfaSettings={"Enabled": False, "PreferredMfa": False},
            )
        if payload.get("reset_password"):
            password = temporary_password()
            cognito().admin_set_user_password(UserPoolId=pool, Username=email, Password=password, Permanent=False)
            result["temporary_password"] = password
    except ApiError:
        raise
    except Exception as exc:
        if common.error_code(exc) == "UserNotFoundException":
            raise ApiError(404, "user_not_found") from None
        raise
    return result


# The account goes, and with it its cars, their events, reminders and files.
def delete_user(email):
    try:
        cognito().admin_delete_user(UserPoolId=os.environ["USER_POOL_ID"], Username=email)
    except Exception as exc:
        if common.error_code(exc) != "UserNotFoundException":
            raise
    items = common.query_all(pk(email))
    files.delete([entry["path"] for item in items for entry in item.get("files") or []])
    common.delete_all(items)
    return {"deleted": email, "items": len(items)}


PASSWORD_SYMBOLS = "!@#%&*-_=+"


def temporary_password():
    alphabet = string.ascii_letters + string.digits + PASSWORD_SYMBOLS
    while True:
        password = "".join(secrets.choice(alphabet) for _ in range(16))
        if (any(c.islower() for c in password) and any(c.isupper() for c in password)
                and any(c.isdigit() for c in password) and any(c in PASSWORD_SYMBOLS for c in password)):
            return password


def user_email(user):
    attributes = {item.get("Name"): item.get("Value", "") for item in user.get("Attributes", [])}
    return attributes.get("email", "").lower() or user.get("Username", "")


def clean_email(value):
    email = str(value or "").strip().lower()
    if not EMAIL_RE.fullmatch(email) or len(email) > 254:
        raise ApiError(400, "bad_email")
    return email


# Versions -----------------------------------------------------------------
# The version of this deployment (VERSION) and the releases of the demo
# repository (RELEASES_REPOSITORY, owner/name) that came after it. They come
# from the Atom feed of the repository's GitHub releases, a public page that
# the hourly limit of the REST API, shared by every function behind Lambda's
# addresses, does not touch. The list stays an hour in the warm function, and
# the last one read serves while GitHub does not answer.

RELEASES_SECONDS = 3600
VERSION_RE = re.compile(r"^v(\d+)\.(\d+)\.(\d+)$")
ATOM = "{http://www.w3.org/2005/Atom}"
_releases = None


def version_info():
    current = os.environ.get("VERSION", "")
    repository = os.environ.get("RELEASES_REPOSITORY", "")
    info = {
        "version": current,
        "repository": repository,
        "url": f"https://github.com/{repository}/releases" if repository else None,
        "latest": None,
        "newer": [],
        "checked_at": None,
        "error": None,
    }
    if not repository:
        return info
    try:
        releases, checked_at = github_releases(repository)
    except Exception:
        common.logger.exception("releases of %s not read", repository)
        info["error"] = "unavailable"
        return info
    info["checked_at"] = checked_at
    info["latest"] = releases[0]["version"] if releases else None
    info["newer"] = [release for release in releases if version_key(release["version"]) > version_key(current)]
    return info


def version_key(value):
    match = VERSION_RE.match(value or "")
    return tuple(int(part) for part in match.groups()) if match else ()


def github_releases(repository):
    global _releases
    now = time.time()
    if _releases and _releases[0] == repository and now - _releases[1] < RELEASES_SECONDS:
        return _releases[2], _releases[3]
    try:
        request = urllib.request.Request(
            f"https://github.com/{repository}/releases.atom",
            headers={"Accept": "application/atom+xml", "User-Agent": "release-check (+https://github.com/" + repository + ")"},
        )
        with urllib.request.urlopen(request, timeout=5) as answer:
            releases = parse_releases(answer.read(2_000_000))
    except Exception:
        if _releases and _releases[0] == repository:
            common.logger.warning("releases of %s not read; the list of %s serves", repository, _releases[3], exc_info=True)
            return _releases[2], _releases[3]
        raise
    checked_at = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    _releases = (repository, now, releases, checked_at)
    return releases, checked_at


# The entries of the feed whose tag is a version, newest version first, with
# their notes as plain text.
def parse_releases(feed):
    import xml.etree.ElementTree as ElementTree

    releases = []
    for entry in ElementTree.fromstring(feed).findall(ATOM + "entry"):
        link = entry.find(ATOM + "link")
        url = link.get("href", "") if link is not None else ""
        version = unquote(url.rstrip("/").rsplit("/", 1)[-1])
        if not version_key(version):
            continue
        releases.append({
            "version": version,
            "title": (entry.findtext(ATOM + "title") or version).strip(),
            "date": (entry.findtext(ATOM + "updated") or "")[:10],
            "url": url,
            "notes": release_notes(entry.findtext(ATOM + "content") or "")[:4000],
        })
    releases.sort(key=lambda release: version_key(release["version"]), reverse=True)
    return releases


class ReleaseNotes(html.parser.HTMLParser):
    BREAKS = {"p", "div", "br", "ul", "ol", "pre", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote"}

    def __init__(self):
        super().__init__()
        self.parts = []

    def handle_starttag(self, tag, attrs):
        if tag == "li":
            self.parts.append("\n• ")
        elif tag in self.BREAKS:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in self.BREAKS:
            self.parts.append("\n")

    def handle_data(self, data):
        self.parts.append(data)


def release_notes(value):
    parser = ReleaseNotes()
    parser.feed(value)
    parser.close()
    lines = (" ".join(line.split()) for line in "".join(parser.parts).splitlines())
    return "\n".join(line for line in lines if line)


# Helpers ------------------------------------------------------------------

def query_param(event, name):
    return ((event.get("queryStringParameters") or {}).get(name) or "").strip()


def body_json(event, limit=100_000):
    raw = event.get("body") or "{}"
    if event.get("isBase64Encoded"):
        import base64
        raw = base64.b64decode(raw).decode("utf-8")
    if len(raw) > limit:
        raise ApiError(413, "too_large")
    payload = json.loads(raw)
    if not isinstance(payload, dict):
        raise ApiError(400, "bad_json_object")
    return payload


def response(status, payload):
    return {
        "statusCode": status,
        "headers": {"content-type": "application/json; charset=utf-8", "cache-control": "no-store"},
        "body": json.dumps(common.plain(payload), ensure_ascii=False),
    }
