"""What the parts of the function share: the table, the AWS clients, numbers
for DynamoDB and JSON, time and one-off markers."""

import logging
import os
import time
from datetime import datetime, timezone
from decimal import Decimal

logger = logging.getLogger()
logger.setLevel(logging.INFO)

_clients = {}
_table = None


# AWS ---------------------------------------------------------------------------------

def client(name):
    if name not in _clients:
        import boto3
        _clients[name] = boto3.client(name)
    return _clients[name]


def table():
    global _table
    if _table is None:
        import boto3
        _table = boto3.resource("dynamodb").Table(os.environ["TABLE_NAME"])
    return _table


def error_code(exc):
    data = getattr(exc, "response", None)
    return data.get("Error", {}).get("Code", "") if isinstance(data, dict) else ""


def conditional_failed(exc):
    return error_code(exc) == "ConditionalCheckFailedException"


def env_number(name, default):
    try:
        return float(os.environ.get(name, default))
    except ValueError:
        return float(default)


# Time --------------------------------------------------------------------------------

def now_utc():
    return datetime.now(timezone.utc)


def iso(moment):
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def now_iso():
    return iso(now_utc())


def today():
    return now_utc().strftime("%Y-%m-%d")


# Numbers ------------------------------------------------------------------------------

def plain(value):
    """DynamoDB's Decimals as ints or floats, for JSON."""
    if isinstance(value, Decimal):
        return int(value) if value == value.to_integral_value() else float(value)
    if isinstance(value, dict):
        return {key: plain(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [plain(item) for item in value]
    return value


def clean_item(value):
    """Floats in Decimal, as DynamoDB wants them, to 6 places."""
    if isinstance(value, float):
        return Decimal(str(round(value, 6)))
    if isinstance(value, dict):
        return {key: clean_item(item) for key, item in value.items()}
    if isinstance(value, list):
        return [clean_item(item) for item in value]
    return value


# Table ----------------------------------------------------------------------------------

def get(pk, sk):
    return table().get_item(Key={"pk": pk, "sk": sk}).get("Item")


def query_all(pk, prefix=None):
    """Every item of a partition, or of the part of it under prefix."""
    from boto3.dynamodb.conditions import Key

    condition = Key("pk").eq(pk)
    if prefix:
        condition = condition & Key("sk").begins_with(prefix)
    items, cursor = [], None
    while True:
        kwargs = {"KeyConditionExpression": condition}
        if cursor:
            kwargs["ExclusiveStartKey"] = cursor
        page = table().query(**kwargs)
        items.extend(page.get("Items", []))
        cursor = page.get("LastEvaluatedKey")
        if not cursor:
            return items


def put(item):
    table().put_item(Item=clean_item(item))


def put_new(item):
    """Writes item unless its key is taken; False when it is."""
    try:
        table().put_item(Item=clean_item(item), ConditionExpression="attribute_not_exists(pk)")
        return True
    except Exception as exc:
        if conditional_failed(exc):
            return False
        raise


def delete_all(items):
    with table().batch_writer() as batch:
        for item in items:
            batch.delete_item(Key={"pk": item["pk"], "sk": item["sk"]})


def marked(key):
    return get("MARK", key) is not None


def mark(key, seconds):
    put({"pk": "MARK", "sk": key, "at": now_iso(), "expires": int(time.time()) + int(seconds)})
