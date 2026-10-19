"""The AWS services of the tests, in memory: DynamoDB, S3, SES and Cognito.
Nothing goes to the network."""

import copy
import json
from datetime import datetime, timezone
from decimal import Decimal

import common
import files


class ClientError(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.response = {"Error": {"Code": code}}


def matches(condition, item):
    """A boto3 key condition (Key(...).eq / begins_with, and their &) against
    an item."""
    expression = condition.get_expression()
    operator, values = expression["operator"], expression["values"]
    if operator == "AND":
        return matches(values[0], item) and matches(values[1], item)
    value = item.get(values[0].name)
    if value is None:
        return False
    if operator == "=":
        return value == values[1]
    if operator == "begins_with":
        return value.startswith(values[1])
    raise NotImplementedError(operator)


def stored(value):
    """As DynamoDB keeps it: no floats."""
    if isinstance(value, float):
        raise TypeError("Float types are not supported. Use Decimal types instead.")
    if isinstance(value, dict):
        return {key: stored(item) for key, item in value.items()}
    if isinstance(value, list):
        return [stored(item) for item in value]
    if isinstance(value, bool) or value is None or isinstance(value, (str, Decimal)):
        return value
    if isinstance(value, int):
        return Decimal(value)
    return value


class Batch:
    def __init__(self, table):
        self.table = table

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def put_item(self, Item):
        self.table.put_item(Item=Item)

    def delete_item(self, Key):
        self.table.delete_item(Key=Key)


class FakeTable:
    def __init__(self):
        self.items = {}

    def get_item(self, Key, ConsistentRead=False):
        item = self.items.get((Key["pk"], Key["sk"]))
        return {"Item": copy.deepcopy(item)} if item else {}

    def put_item(self, Item, ConditionExpression=None):
        key = (Item["pk"], Item["sk"])
        if ConditionExpression == "attribute_not_exists(pk)":
            if key in self.items:
                raise ClientError("ConditionalCheckFailedException")
        elif ConditionExpression is not None:
            raise NotImplementedError(ConditionExpression)
        self.items[key] = stored(dict(Item))

    def delete_item(self, Key):
        self.items.pop((Key["pk"], Key["sk"]), None)

    def query(self, KeyConditionExpression, ExclusiveStartKey=None):
        found = sorted((item for item in self.items.values() if matches(KeyConditionExpression, item)), key=lambda item: item["sk"])
        # Pages of 100, so that the tests go through the cursor too.
        if ExclusiveStartKey:
            found = [item for item in found if item["sk"] > ExclusiveStartKey["sk"]]
        page = found[:100]
        result = {"Items": [copy.deepcopy(item) for item in page]}
        if len(found) > 100:
            result["LastEvaluatedKey"] = {"pk": page[-1]["pk"], "sk": page[-1]["sk"]}
        return result

    def batch_writer(self):
        return Batch(self)

    def scan(self, ProjectionExpression=None, ExclusiveStartKey=None):
        return {"Items": [copy.deepcopy(item) for item in self.items.values()]}


class FakeS3:
    def __init__(self):
        self.deleted = []
        # Versions of the objects of the bucket, for the reset: (key, version).
        self.versions = []

    def generate_presigned_post(self, Bucket, Key, Fields, Conditions, ExpiresIn):
        return {"url": f"https://{Bucket}.s3.example.com/", "fields": {"key": Key, **Fields}}

    def delete_objects(self, Bucket, Delete):
        self.deleted.extend(entry["Key"] for entry in Delete["Objects"])
        gone = {(entry["Key"], entry.get("VersionId")) for entry in Delete["Objects"]}
        self.versions = [version for version in self.versions if version not in gone]
        return {}

    def get_paginator(self, name):
        assert name == "list_object_versions"
        return Pager(lambda Bucket: {"Versions": [{"Key": key, "VersionId": version} for key, version in self.versions]})


class FakeSes:
    def __init__(self):
        self.sent = []

    def send_email(self, FromEmailAddress, Destination, Content):
        self.sent.append({"from": FromEmailAddress, "to": Destination["ToAddresses"],
                          "subject": Content["Simple"]["Subject"]["Data"], "text": Content["Simple"]["Body"]["Text"]["Data"]})
        return {"MessageId": str(len(self.sent))}


class Pager:
    def __init__(self, fn):
        self.fn = fn

    def paginate(self, **kwargs):
        return [self.fn(**kwargs)]


class FakeCognito:
    def __init__(self):
        self.users = {}
        self.groups = {"admins": set()}

    def add(self, email, locale="", enabled=True):
        attributes = [{"Name": "email", "Value": email}] + ([{"Name": "locale", "Value": locale}] if locale else [])
        self.users[email] = {"Username": email, "UserStatus": "CONFIRMED", "Enabled": enabled, "Attributes": attributes,
                             "UserCreateDate": datetime.now(timezone.utc)}

    def get_paginator(self, name):
        return Pager(getattr(self, name))

    def list_users(self, UserPoolId):
        return {"Users": list(self.users.values())}

    def list_users_in_group(self, UserPoolId, GroupName):
        return {"Users": [self.users[email] for email in self.groups[GroupName] if email in self.users]}

    def admin_get_user(self, UserPoolId, Username):
        if Username not in self.users:
            raise ClientError("UserNotFoundException")
        return {"Username": Username, "UserMFASettingList": []}

    def admin_create_user(self, UserPoolId, Username, **kwargs):
        if Username in self.users:
            raise ClientError("UsernameExistsException")
        self.add(Username)
        self.users[Username]["UserStatus"] = "FORCE_CHANGE_PASSWORD"

    def admin_delete_user(self, UserPoolId, Username):
        if Username not in self.users:
            raise ClientError("UserNotFoundException")
        self.users.pop(Username)

    def admin_disable_user(self, UserPoolId, Username):
        self.users[Username]["Enabled"] = False

    def admin_add_user_to_group(self, UserPoolId, Username, GroupName):
        self.groups[GroupName].add(Username)

    # What the reset does to the demo user.
    def admin_enable_user(self, UserPoolId, Username):
        self.users[Username]["Enabled"] = True

    def admin_set_user_password(self, UserPoolId, Username, Password, Permanent):
        self.users[Username]["password"] = Password

    def admin_set_user_mfa_preference(self, UserPoolId, Username, SoftwareTokenMfaSettings):
        self.users[Username]["mfa"] = SoftwareTokenMfaSettings["Enabled"]

    def admin_delete_user_attributes(self, UserPoolId, Username, UserAttributeNames):
        user = self.users[Username]
        user["Attributes"] = [item for item in user["Attributes"] if item["Name"] not in UserAttributeNames]

    def admin_user_global_sign_out(self, UserPoolId, Username):
        self.users[Username]["signed_out"] = True


class FakeSsm:
    def __init__(self):
        self.values = {}

    def get_parameter(self, Name, WithDecryption=False):
        return {"Parameter": {"Value": self.values[Name]}}


def install():
    """Fresh fakes in place of every client; returns them by name."""
    fakes = {"table": FakeTable(), "s3": FakeS3(), "sesv2": FakeSes(), "cognito-idp": FakeCognito(), "ssm": FakeSsm()}
    common._table = fakes["table"]
    common._clients.clear()
    common._clients.update({name: fake for name, fake in fakes.items() if name != "table"})
    files._s3 = fakes["s3"]
    return fakes


def event(method, path, body=None, params=None, email="owner@example.com", admin=False):
    return {
        "rawPath": path,
        "requestContext": {"http": {"method": method}, "authorizer": {"jwt": {"claims": {
            "email": email, "email_verified": "true", **({"cognito:groups": "[admins]"} if admin else {})}}}},
        "queryStringParameters": params or {},
        "body": json.dumps(body) if body is not None else None,
    }

