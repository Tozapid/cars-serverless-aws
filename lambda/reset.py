"""Hourly reset of the public demo: back to a fresh deployment.

- Every item of the table goes: the cars, their events and reminders, the
  API keys, the share links and the markers of the mails; so do the receipts
  and photos of the visitors, every version of them.
- The examples of seed.json are written again through the code of the API,
  with days counted back from today, so the demo always looks recent.
- The demo user gets the published password back, two-factor
  authentication off, the default language, the administrator role, and is
  signed out everywhere; any other user is deleted.
"""

import json
import logging
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path

import app
import common

logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Next to the code in the function's zip; in the repository, in seed/.
SEED = next(path for path in (Path(__file__).with_name("seed.json"), Path(__file__).parent.parent / "seed" / "seed.json")
            if path.exists())


def handler(event, context):
    seed = json.loads(SEED.read_text(encoding="utf-8"))
    removed = wipe_table()
    files = wipe_files()
    owner = os.environ["DEMO_EMAIL"].lower()
    written = write_seed(owner, seed, datetime.now(timezone.utc).date())
    reset_users(owner)
    logger.info("reset: %s items and %s files removed, %s written", removed, files, json.dumps(written))
    return {"removed": removed, "files": files, **written}


def wipe_table():
    keys = []
    kwargs = {"ProjectionExpression": "pk, sk"}
    while True:
        page = common.table().scan(**kwargs)
        keys.extend({"pk": item["pk"], "sk": item["sk"]} for item in page.get("Items", []))
        if not page.get("LastEvaluatedKey"):
            break
        kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]
    common.delete_all(keys)
    return len(keys)


# The bucket keeps versions: every version and delete marker goes.
def wipe_files():
    bucket = os.environ["FILES_BUCKET"]
    s3 = common.client("s3")
    keys = []
    for page in s3.get_paginator("list_object_versions").paginate(Bucket=bucket):
        for entry in page.get("Versions", []) + page.get("DeleteMarkers", []):
            keys.append({"Key": entry["Key"], "VersionId": entry["VersionId"]})
    for start in range(0, len(keys), 1000):
        s3.delete_objects(Bucket=bucket, Delete={"Objects": keys[start:start + 1000], "Quiet": True})
    return len(keys)


def write_seed(owner, seed, today):
    """Each car with its events and reminders. An event of the seed is dated
    days_ago before today, at its time of day."""
    cars = events = reminders = 0
    for entry in seed.get("cars", []):
        car = app.create_car(owner, entry["car"])
        items, seen = [], {}
        now = common.now_iso()
        for event in entry.get("events", []):
            when = (today - timedelta(days=event["days_ago"])).isoformat() + "T" + event.get("time", "12:00")
            payload = {key: value for key, value in event.items() if key not in ("days_ago", "time")}
            fields = app.compact(app.event_fields(owner, {**payload, "date": when}))
            event_id = app.import_id(fields, seen)
            items.append(app.compact({"pk": app.pk(owner), "sk": f"EVENT#{car['id']}#{event_id}", "id": event_id, "car": car["id"],
                                      **fields, "source": "seed", "created": now, "modified": now, "by": owner}))
        with common.table().batch_writer() as batch:
            for item in items:
                batch.put_item(Item=common.clean_item(item))
        app.count_events(owner, car["id"], items)
        for reminder in entry.get("reminders", []):
            app.create_reminder(owner, car, reminder)
        cars += 1
        events += len(items)
        reminders += len(entry.get("reminders", []))
    return {"cars": cars, "events": events, "reminders": reminders}


def reset_users(owner):
    """The demo user as deployed, and no one else."""
    pool = os.environ["USER_POOL_ID"]
    cognito = common.client("cognito-idp")
    found = False
    for page in cognito.get_paginator("list_users").paginate(UserPoolId=pool):
        for user in page.get("Users", []):
            email = next((item["Value"] for item in user.get("Attributes", []) if item["Name"] == "email"), "").lower()
            if email == owner:
                found = True
                restore_demo_user(cognito, pool, user["Username"])
            else:
                cognito.admin_delete_user(UserPoolId=pool, Username=user["Username"])
    if not found:
        logger.warning("the demo user %s is missing; the next deploy makes it again", owner)


def restore_demo_user(cognito, pool, username):
    password = common.client("ssm").get_parameter(Name=os.environ["DEMO_PASSWORD_PARAMETER"], WithDecryption=True)["Parameter"]["Value"]
    cognito.admin_enable_user(UserPoolId=pool, Username=username)
    cognito.admin_set_user_password(UserPoolId=pool, Username=username, Password=password, Permanent=True)
    cognito.admin_set_user_mfa_preference(UserPoolId=pool, Username=username,
                                          SoftwareTokenMfaSettings={"Enabled": False, "PreferredMfa": False})
    try:
        cognito.admin_delete_user_attributes(UserPoolId=pool, Username=username, UserAttributeNames=["locale"])
    except Exception as exc:  # noqa: BLE001 - no locale to delete is fine
        logger.info("locale of the demo user not deleted: %s", exc)
    cognito.admin_add_user_to_group(UserPoolId=pool, Username=username, GroupName=os.environ.get("ADMIN_GROUP", "admins"))
    cognito.admin_user_global_sign_out(UserPoolId=pool, Username=username)
