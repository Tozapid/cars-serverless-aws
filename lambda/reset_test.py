import json
import os
import unittest
from datetime import date

import app
import fakes
import reset

DEMO = "demo@example.com"


class ResetTest(unittest.TestCase):
    def setUp(self):
        self.fakes = fakes.install()
        os.environ.update({"TABLE_NAME": "cars", "USER_POOL_ID": "pool", "ADMIN_GROUP": "admins", "FILES_BUCKET": "files",
                           "DEMO_EMAIL": DEMO, "DEMO_PASSWORD_PARAMETER": "/cars-serverless/admin-password",
                           "REMINDER_LEAD_DAYS": "14", "REMINDER_LEAD_KM": "1000", "FILE_MAX_BYTES": "1000000"})
        self.fakes["ssm"].values["/cars-serverless/admin-password"] = "Demo-Password-1"
        cognito = self.fakes["cognito-idp"]
        cognito.add(DEMO, locale="fr")
        cognito.add("visitor@example.com")
        cognito.groups["admins"] = set()

    def call(self, method, path):
        result = app.handler(fakes.event(method, path, email=DEMO, admin=True), None)
        return result["statusCode"], json.loads(result["body"])

    def test_reset(self):
        table = self.fakes["table"]
        table.items[("USER#visitor@example.com", "CAR#abc123")] = {"pk": "USER#visitor@example.com", "sk": "CAR#abc123", "name": "Theirs"}
        self.fakes["s3"].versions = [("files/x/a.jpg", "v1"), ("files/x/a.jpg", "v2")]
        result = reset.handler({"reason": "test"}, None)
        seed = json.loads(reset.SEED.read_text(encoding="utf-8"))
        self.assertEqual((result["removed"], result["files"], result["cars"]), (1, 2, len(seed["cars"])))
        self.assertEqual(result["events"], sum(len(car["events"]) for car in seed["cars"]))
        self.assertEqual(self.fakes["s3"].versions, [])
        # The demo user only, as deployed.
        cognito = self.fakes["cognito-idp"]
        self.assertEqual(list(cognito.users), [DEMO])
        user = cognito.users[DEMO]
        self.assertEqual((user["password"], user["mfa"], user["signed_out"]), ("Demo-Password-1", False, True))
        self.assertNotIn("locale", [item["Name"] for item in user["Attributes"]])
        self.assertIn(DEMO, cognito.groups["admins"])
        # The examples through the API, dated back from today.
        _, cars = self.call("GET", "/api/cars")
        self.assertEqual({car["name"] for car in cars["items"]}, {car["car"]["name"] for car in seed["cars"]})
        first = next(car for car in cars["items"] if car["name"] == seed["cars"][0]["car"]["name"])
        self.assertEqual(first["event_count"], len(seed["cars"][0]["events"]))
        self.assertLessEqual(first["last_event"][:10], date.today().isoformat())
        _, events = self.call("GET", f"/api/cars/{first['id']}/events")
        self.assertEqual(len(events["items"]), first["event_count"])
        self.assertTrue(any(item.get("location") for item in events["items"]))
        _, reminders = self.call("GET", f"/api/cars/{first['id']}/reminders")
        self.assertEqual({item["category"] for item in reminders["items"]}, {item["category"] for item in seed["cars"][0]["reminders"]})
        # Again: the same, not twice.
        again = reset.handler({}, None)
        self.assertEqual(again["cars"], result["cars"])
        _, cars = self.call("GET", "/api/cars")
        self.assertEqual(len(cars["items"]), len(seed["cars"]))

    def test_demo_users_read_only(self):
        os.environ["DEMO"] = "true"
        try:
            status, users = self.call("GET", "/api/admin/users")
            self.assertEqual(status, 200)
            result = app.handler(fakes.event("POST", "/api/admin/users", {"email": "new@example.com"}, email=DEMO, admin=True), None)
            self.assertEqual((result["statusCode"], json.loads(result["body"])["code"]), (403, "demo_readonly"))
            self.assertTrue(self.call("GET", "/api/me")[1]["demo"])
        finally:
            os.environ.pop("DEMO")


if __name__ == "__main__":
    unittest.main()
