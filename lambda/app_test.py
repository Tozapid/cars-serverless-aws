import json
import os
import unittest

import app
import carexpenses
import fakes
import files
import mail
import reminders

OWNER = "owner@example.com"
class Base(unittest.TestCase):
    def setUp(self):
        self.fakes = fakes.install()
        self.table = self.fakes["table"]
        os.environ.update({"TABLE_NAME": "cars", "USER_POOL_ID": "pool", "SENDER": "alert@cars.example.com", "SITE_URL": "https://cars.example.com",
                           "ADMIN_GROUP": "admins", "FILES_BUCKET": "files", "FILE_MAX_BYTES": "1000000", "CLOUDFRONT_KEY_PAIR_ID": "K1",
                           "REMINDER_LEAD_DAYS": "14", "REMINDER_LEAD_KM": "1000"})
        self.fakes["cognito-idp"].add(OWNER)

    def call(self, method, path, body=None, params=None, admin=False, email=OWNER):
        result = app.handler(fakes.event(method, path, body, params, email=email, admin=admin), None)
        return result["statusCode"], json.loads(result["body"])

    def car(self, **fields):
        status, car = self.call("POST", "/api/cars", {"name": "Tesla Model X", "vin": "5yjxcce24jf121229", **fields})
        self.assertEqual(status, 201, car)
        return car

    def add(self, car, **fields):
        status, item = self.call("POST", f"/api/cars/{car['id']}/events", {"kind": "expense", "date": "2026-10-01T10:00", **fields})
        self.assertEqual(status, 201, item)
        return item


class CarsTest(Base):
    def test_create_list_update(self):
        car = self.car(year=2018, unit="kWh")
        self.assertEqual(car["vin"], "5YJXCCE24JF121229")
        self.assertEqual(car["currency"], "EUR")
        status, saved = self.call("PUT", f"/api/cars/{car['id']}", {"name": "Model X", "unit": "kWh", "sold": True})
        self.assertEqual(status, 200)
        self.assertTrue(saved["sold"])
        self.assertNotIn("vin", saved)
        status, listed = self.call("GET", "/api/cars")
        self.assertEqual([item["name"] for item in listed["items"]], ["Model X"])

    def test_car_id_is_short_and_unique(self):
        drawn = iter(["abc123", "abc123", "xyz789"])
        original = app.new_car_id
        app.new_car_id = lambda: next(drawn)
        try:
            first, second = self.car(), self.car()
        finally:
            app.new_car_id = original
        self.assertEqual((first["id"], second["id"]), ("abc123", "xyz789"))
        self.assertRegex(self.car()["id"], r"^[0-9a-z]{6}$")
        status, _ = self.call("GET", "/api/cars/xyz789/events")
        self.assertEqual(status, 200)
        # A car made before keeps its long id.
        self.table.items[("USER#" + OWNER, "CAR#0123456789abcdef")] = {**self.table.items[("USER#" + OWNER, "CAR#abc123")], "sk": "CAR#0123456789abcdef", "id": "0123456789abcdef"}
        status, car = self.call("GET", "/api/cars/0123456789abcdef")
        self.assertEqual((status, car["id"]), (200, "0123456789abcdef"))

    def test_last_event(self):
        car = self.car()
        self.assertEqual(self.call("GET", "/api/cars")[1]["items"][0]["event_count"], 0)
        first = self.add(car, date="2026-03-01T10:00")
        later = self.add(car, date="2026-05-01T10:00")
        listed = self.call("GET", "/api/cars")[1]["items"][0]
        self.assertEqual((listed["last_event"], listed["event_count"]), ("2026-05-01T10:00", 2))
        self.call("DELETE", f"/api/cars/{car['id']}/events/{later['id']}")
        self.call("PUT", f"/api/cars/{car['id']}", {"name": "Renamed"})
        listed = self.call("GET", "/api/cars")[1]["items"][0]
        self.assertEqual((listed["name"], listed["last_event"], listed["event_count"]), ("Renamed", "2026-03-01T10:00", 1))
        self.call("PUT", f"/api/cars/{car['id']}/events/{first['id']}", {"kind": "expense", "date": "2026-04-02T10:00"})
        self.assertEqual(self.call("GET", "/api/cars")[1]["items"][0]["last_event"], "2026-04-02T10:00")
        # A car of before: counted on the first listing.
        key = ("USER#" + OWNER, "CAR#" + car["id"])
        self.table.items[key] = {k: v for k, v in self.table.items[key].items() if k not in ("last_event", "event_count")}
        listed = self.call("GET", "/api/cars")[1]["items"][0]
        self.assertEqual((listed["last_event"], listed["event_count"]), ("2026-04-02T10:00", 1))
        self.assertIn("event_count", self.table.items[key])

    def test_validation(self):
        for body, field in (({"name": ""}, "name"), ({"name": "A", "unit": "gal"}, "unit"), ({"name": "A", "year": 1700}, "year"),
                            ({"name": "A", "currency": "euro"}, "currency")):
            status, error = self.call("POST", "/api/cars", body)
            self.assertEqual((status, error["code"], error.get("detail")), (400, "bad_field", field))

    def test_cars_of_others_are_not_found(self):
        car = self.car()
        status, error = self.call("GET", f"/api/cars/{car['id']}/events", email="other@example.com")
        self.assertEqual((status, error["code"]), (404, "car_not_found"))

    def test_delete_takes_events_reminders_and_files(self):
        car = self.car()
        path = f"/files/{files.user_key(OWNER)}/{'a' * 32}.jpg"
        self.add(car, files=[{"path": path, "name": "check.jpg", "type": "image/jpeg", "size": 100}])
        self.call("POST", f"/api/cars/{car['id']}/reminders", {"category": "Гараж", "days": 30})
        status, result = self.call("DELETE", f"/api/cars/{car['id']}")
        self.assertEqual((status, result["items"]), (200, 2))
        self.assertEqual(self.fakes["s3"].deleted, [path[1:]])
        self.assertEqual([key for key in self.table.items if key[0] == "USER#" + OWNER], [])


    def test_photo_is_replaced_and_deleted(self):
        first = f"/files/{files.user_key(OWNER)}/{'a' * 32}.jpg"
        second = f"/files/{files.user_key(OWNER)}/{'b' * 32}.jpg"
        car = self.car(photo={"path": first, "name": "x.jpg", "type": "image/jpeg", "size": 100})
        self.assertEqual(car["photo"]["path"], first)
        for photo in ({"path": first, "type": "application/pdf"}, {"path": "/files/0123456789abcdef0123/" + "c" * 32 + ".jpg", "type": "image/jpeg"}):
            status, error = self.call("PUT", f"/api/cars/{car['id']}", {"name": "A", "photo": photo})
            self.assertEqual((status, error.get("detail")), (400, "photo"))
        status, saved = self.call("PUT", f"/api/cars/{car['id']}", {"name": "A", "photo": {"path": second, "type": "image/jpeg"}})
        self.assertEqual((status, saved["photo"]["path"]), (200, second))
        self.assertEqual(self.fakes["s3"].deleted, [first[1:]])
        status, saved = self.call("PUT", f"/api/cars/{car['id']}", {"name": "A", "photo": {"path": second, "type": "image/jpeg"}})
        self.assertEqual(self.fakes["s3"].deleted, [first[1:]])
        self.call("DELETE", f"/api/cars/{car['id']}")
        self.assertEqual(self.fakes["s3"].deleted, [first[1:], second[1:]])


    def test_admin_views_cars_of_others(self):
        car = self.car()
        self.add(car, category="Гараж")
        other = "other@example.com"
        self.fakes["cognito-idp"].add(other)
        status, error = self.call("GET", "/api/cars", params={"owner": OWNER}, email=other)
        self.assertEqual((status, error["code"]), (403, "admin_only"))
        status, listed = self.call("GET", "/api/cars", params={"owner": OWNER}, email=other, admin=True)
        self.assertEqual([item["id"] for item in listed["items"]], [car["id"]])
        status, events = self.call("GET", f"/api/cars/{car['id']}/events", params={"owner": OWNER.upper()}, email=other, admin=True)
        self.assertEqual((status, len(events["items"])), (200, 1))
        status, error = self.call("PUT", f"/api/cars/{car['id']}", {"name": "A"}, params={"owner": OWNER}, email=other, admin=True)
        self.assertEqual((status, error["code"]), (403, "read_only"))
        status, error = self.call("POST", f"/api/cars/{car['id']}/events", {"kind": "expense"}, params={"owner": OWNER}, email=other, admin=True)
        self.assertEqual((status, error["code"]), (403, "read_only"))
        # Without the parameter, or with one's own address, a user has their own cars.
        status, listed = self.call("GET", "/api/cars", params={"owner": other}, email=other)
        self.assertEqual((status, listed["items"]), (200, []))
        status, found = self.call("GET", "/api/admin/owners", email=other, admin=True)
        self.assertEqual(found["items"], [{"email": other, "cars": 0}, {"email": OWNER, "cars": 1}])


class LogTest(unittest.TestCase):
    def test_the_log_names_the_route_not_the_request(self):
        self.assertEqual(app.route_label("/api/share/s3cr3t-token/cars/abc123/events"), "/api/share/*/cars/*/events")
        self.assertEqual(app.route_label("/api/cars/abc123/import/carexpenses"), "/api/cars/*/import/carexpenses")
        self.assertEqual(app.route_label("/"), "/")


class AccessTest(Base):
    def anonymous(self, method, path, headers=None, body=None):
        event = {"rawPath": path, "requestContext": {"http": {"method": method, "sourceIp": "130.176.0.1"}},
                 "headers": headers or {}, "queryStringParameters": {}, "body": json.dumps(body) if body is not None else None}
        result = app.handler(event, None)
        return result["statusCode"], json.loads(result["body"])

    def test_api_keys(self):
        car = self.car()
        status, read = self.call("POST", "/api/keys", {"name": "Home Assistant"})
        self.assertEqual((status, read["scope"]), (201, "read"))
        self.assertTrue(read["key"].startswith("cars_" + read["id"] + "_"))
        self.assertNotIn("hash", read)
        agent = {"User-Agent": "curl/8", "X-Forwarded-For": "198.51.100.7, 130.176.0.1"}
        status, listed = self.anonymous("GET", "/api/v1/cars", {"Authorization": "Bearer " + read["key"], **agent})
        self.assertEqual((status, [item["id"] for item in listed["items"]]), (200, [car["id"]]))
        # The last use: the viewer's address before CloudFront's, and the program.
        _, keys = self.call("GET", "/api/keys")
        self.assertEqual([(entry["uses"], entry["last_ip"], entry["last_agent"]) for entry in keys["items"]], [(1, "198.51.100.7", "curl/8")])
        status, error = self.anonymous("POST", f"/api/v1/cars/{car['id']}/events", {"X-Api-Key": read["key"]}, {"kind": "expense", "date": "2026-10-01T10:00"})
        self.assertEqual((status, error["code"]), (403, "key_read_only"))
        _, write = self.call("POST", "/api/keys", {"name": "Charger", "scope": "write"})
        status, item = self.anonymous("POST", f"/api/v1/cars/{car['id']}/events", {"X-Api-Key": write["key"]}, {"kind": "expense", "date": "2026-10-01T10:00", "amount": 5})
        self.assertEqual((status, item["amount"]), (201, 5))
        status, keys = self.call("GET", "/api/keys")
        found = {entry["name"]: entry for entry in keys["items"]}
        self.assertEqual((found["Home Assistant"]["uses"], found["Home Assistant"]["last_ip"]), (2, "130.176.0.1"))
        self.assertNotIn("key", found["Home Assistant"])
        self.assertTrue(found["Home Assistant"]["hint"].endswith(read["key"][-4:]))
        for headers in ({}, {"Authorization": "Bearer cars_nope_x"}, {"X-Api-Key": read["key"] + "x"}):
            self.assertEqual(self.anonymous("GET", "/api/v1/cars", headers)[0], 401)
        # A key reaches the cars only.
        self.assertEqual(self.anonymous("GET", "/api/v1/keys", {"X-Api-Key": write["key"]})[0], 404)
        self.call("DELETE", "/api/keys", params={"id": read["id"]})
        self.assertEqual(self.anonymous("GET", "/api/v1/cars", {"X-Api-Key": read["key"]})[0], 401)

    def test_share_links(self):
        car, other = self.car(), self.car(name="Other")
        self.add(car, category="Гараж")
        status, share = self.call("POST", "/api/shares", {"name": "Для друга", "car": car["id"], "days": 7})
        self.assertEqual(status, 201)
        token = share["token"]
        status, info = self.anonymous("GET", f"/api/share/{token}")
        self.assertEqual((status, info["car"], info["name"]), (200, car["id"], "Для друга"))
        status, listed = self.anonymous("GET", f"/api/share/{token}/cars")
        self.assertEqual([item["id"] for item in listed["items"]], [car["id"]])
        status, events = self.anonymous("GET", f"/api/share/{token}/cars/{car['id']}/events")
        self.assertEqual((status, len(events["items"])), (200, 1))
        self.assertEqual(self.anonymous("GET", f"/api/share/{token}/cars/{other['id']}/events")[0], 404)
        self.assertEqual(self.anonymous("POST", f"/api/share/{token}/cars/{car['id']}/events", body={"kind": "expense"})[0], 403)
        self.assertEqual(self.anonymous("GET", "/api/share/nope/cars")[0], 404)
        _, shares = self.call("GET", "/api/shares")
        # Every request with the link counts, refused ones too.
        self.assertEqual(shares["items"][0]["uses"], 5)
        # Expired, and then deleted.
        key = ("USER#" + OWNER, "SHARE#" + share["id"])
        self.table.items[key]["expires"] = "2020-01-01T00:00:00Z"
        self.assertEqual(self.anonymous("GET", f"/api/share/{token}/cars")[0], 404)
        self.call("DELETE", "/api/shares", params={"id": share["id"]})
        self.assertEqual(self.call("GET", "/api/shares")[1]["items"], [])
        # A link to all the cars.
        _, every = self.call("POST", "/api/shares", {})
        self.assertEqual(len(self.anonymous("GET", f"/api/share/{every['token']}/cars")[1]["items"]), 2)


class EventsTest(Base):
    def test_refuel_counts_its_amount(self):
        car = self.car()
        item = self.add(car, kind="refuel", category="Garage-Night", quantity=150, price=0.092796, odometer=139504)
        self.assertAlmostEqual(item["amount"], 13.9194)
        status, listed = self.call("GET", f"/api/cars/{car['id']}/events")
        self.assertEqual(len(listed["items"]), 1)
        self.assertEqual(listed["items"][0]["category"], "Garage-Night")

    def test_fuel(self):
        car = self.car()
        self.assertEqual(self.add(car, kind="refuel", category="Бутан", quantity=30, price=0.6, fuel="lpg")["fuel"], "lpg")
        self.assertNotIn("fuel", self.add(car, kind="refuel", category="Shell", quantity=30, price=1.6))
        self.assertNotIn("fuel", self.add(car, kind="service", fuel="lpg", amount=5))
        status, error = self.call("POST", f"/api/cars/{car['id']}/events", {"kind": "refuel", "date": "2026-10-01T10:00", "fuel": "coal"})
        self.assertEqual((status, error["detail"]), (400, "fuel"))
        self.assertEqual([carexpenses.fuel_of(name, tank) for name, tank in (("Бутан", "2"), ("АИ-95", "1"), ("95 V-Power", "1"), ("Газ", "1"), ("Газпром", "1"), ("Autogas", "1"), ("ДТ", "1"), ("X", "2"))],
                         ["lpg", "petrol", "petrol", "lpg", "petrol", "lpg", "diesel", "lpg"])

    def test_event_named_by_the_page_goes_in_once(self):
        car = self.car()
        body = {"kind": "expense", "date": "2026-10-01T10:00", "amount": 5, "id": "0123456789abcdef"}
        status, first = self.call("POST", f"/api/cars/{car['id']}/events", body)
        self.assertEqual((status, first["id"]), (201, "0123456789abcdef"))
        status, again = self.call("POST", f"/api/cars/{car['id']}/events", {**body, "amount": 7})
        self.assertEqual((again["id"], again["amount"]), ("0123456789abcdef", 5))
        self.assertEqual(len(self.call("GET", f"/api/cars/{car['id']}/events")[1]["items"]), 1)
        self.assertEqual(self.call("GET", "/api/cars")[1]["items"][0]["event_count"], 1)
        status, error = self.call("POST", f"/api/cars/{car['id']}/events", {**body, "id": "../x"})
        self.assertEqual((status, error["detail"]), (400, "id"))

    def test_other_kinds_have_no_quantity(self):
        car = self.car()
        item = self.add(car, kind="service", quantity=5, amount=10)
        self.assertNotIn("quantity", item)

    def test_validation(self):
        car = self.car()
        for body, field in (({"kind": "fuel"}, "kind"), ({"date": "2026-13-01T10:00"}, "date"), ({"date": "1.10.2026"}, "date"),
                            ({"odometer": -1}, "odometer"), ({"amount": "12"}, "amount"), ({"excluded": "yes"}, "excluded"),
                            ({"link": "javascript:alert(1)"}, "link"),
                            ({"files": [{"path": "/files/0123456789abcdef0123/" + "b" * 32 + ".jpg"}]}, "files")):
            status, error = self.call("POST", f"/api/cars/{car['id']}/events", {"kind": "expense", "date": "2026-10-01T10:00", **body})
            self.assertEqual((status, error["code"], error.get("detail")), (400, "bad_field", field), body)

    def test_location(self):
        car = self.car()
        item = self.add(car, location={"lat": 43.21412345, "lon": 27.9147, "accuracy": 15.4})
        self.assertEqual(item["location"], {"lat": 43.214123, "lon": 27.9147, "accuracy": 15})
        self.assertNotIn("location", self.add(car, location=None))
        for location in ({"lat": 91, "lon": 0}, {"lat": 10}, {"lat": "1", "lon": 2}, [1, 2]):
            status, error = self.call("POST", f"/api/cars/{car['id']}/events", {"kind": "expense", "date": "2026-10-01T10:00", "location": location})
            self.assertEqual((status, error.get("detail")), (400, "location"), location)

    def test_update_drops_removed_files(self):
        car = self.car()
        first = f"/files/{files.user_key(OWNER)}/{'a' * 32}.jpg"
        second = f"/files/{files.user_key(OWNER)}/{'b' * 32}.pdf"
        item = self.add(car, files=[{"path": first}, {"path": second}])
        status, saved = self.call("PUT", f"/api/cars/{car['id']}/events/{item['id']}",
                                  {"kind": "expense", "date": "2026-10-02T10:00", "amount": 5, "files": [{"path": second}]})
        self.assertEqual(status, 200)
        self.assertEqual(saved["created"], item["created"])
        self.assertEqual(self.fakes["s3"].deleted, [first[1:]])
        status, _ = self.call("DELETE", f"/api/cars/{car['id']}/events/{item['id']}")
        self.assertEqual(status, 200)
        self.assertEqual(self.fakes["s3"].deleted, [first[1:], second[1:]])

    def test_many_events_are_read_past_a_page(self):
        car = self.car()
        for day in range(1, 29):
            for hour in range(10, 15):
                self.add(car, date=f"2026-02-{day:02d}T{hour}:00", amount=1)
        status, listed = self.call("GET", f"/api/cars/{car['id']}/events")
        self.assertEqual(len(listed["items"]), 140)


class FilesTest(Base):
    def test_presign(self):
        status, target = self.call("POST", "/api/files", {"content_type": "application/pdf", "size": 1000})
        self.assertEqual(status, 200)
        self.assertTrue(files.owns(OWNER, target["path"]))
        self.assertEqual(target["post"]["fields"]["Content-Disposition"], "attachment")
        for body in ({"content_type": "text/html", "size": 10}, {"content_type": "image/png", "size": 2_000_000}, {"content_type": "image/png"}):
            status, error = self.call("POST", "/api/files", body)
            self.assertEqual((status, error["code"]), (400, "bad_file"))

    def test_cookies_open_the_users_folder(self):
        sign, key = files.rsa_sha1_sign, files.signing_key
        files.rsa_sha1_sign, files.signing_key = (lambda message, key: b"signature"), (lambda: None)
        try:
            found = files.cookies("cars.example.com", OWNER, now=1000)
        finally:
            files.rsa_sha1_sign, files.signing_key = sign, key
        policy = found[0].split(";")[0].split("=", 1)[1].replace("-", "+").replace("_", "=").replace("~", "/")
        import base64
        statement = json.loads(base64.b64decode(policy))["Statement"][0]
        self.assertEqual(statement["Resource"], f"https://cars.example.com/files/{files.user_key(OWNER)}/*")
        self.assertEqual(statement["Condition"]["DateLessThan"]["AWS:EpochTime"], 4600)
        self.assertTrue(all("Path=/files" in cookie for cookie in found))
        self.assertTrue(found[2].startswith("CloudFront-Key-Pair-Id=K1;"))


def ce_backup():
    """A Car Expenses backup as the app writes it: tab separated, padded."""
    def table(name, columns, rows):
        return [f"### {name}", "\t".join(f"{column}   " for column in columns)] + ["\t".join(f"{cell}  " for cell in row) for row in rows]
    lines = ["### CE v.30.87"]
    lines += table("vehicle info", ["_id", "name", "currency", "buy_date", "buy_price", "buy_mileage", "veh_manufacturer", "veh_model", "veh_modification", "veh_birthday", "veh_vin", "engine_type"],
                   [["3", "VW Sharan", "lv", "20220707", "5755.98", "296151", "Volkswagen", "Sharan", "V6", "20050819", "WVWZZZ7M6V005888", "2"]])
    lines += table("category info", ["_id", "name", "expense_type"], [["2", "Доходы", "0"], ["4", "Основные расходы", "1"], ["5", "Расходы на содержание", "1"]])
    lines += table("pattern info", ["_id", "name", "id_category", "period_type", "period_mileage", "period_month"],
                   [["2", "Моторное масло", "4", "1", "10000", "0.0"], ["42", "Личный водитель", "2", "0", "0", "0.0"], ["51", "Виньетка", "5", "2", "0", "12.0"]])
    lines += table("pattern info (VW Sharan)", ["_id", "name", "id_category", "period_type", "period_mileage", "period_month"], [["48", "Гараж", "5", "2", "0", "1.0"]])
    lines += table("expenses info (VW Sharan)", ["_id", "id_vehicle", "id_pattern", "date", "mileage", "predicated_mileage", "name", "note", "costpart", "costwork", "comment"],
                   [["57", "VW Sharan", "2; 51", "20220523", "295000", "0", "ТО", "", "40.0; 0.0", "20.0; 15.0", " ; 7 дней"],
                    ["66", "VW Sharan", "42", "20220912", "0", "299594", "Катал в Софию", "", "-63.05", "0.0", ""],
                    ["78", "VW Sharan", "48", "20221227", "0", "0", "", "", "0.0", "50.0", ""]])
    lines += table("records info (VW Sharan)", ["id_vehicle", "date", "note", "mileage", "volume", "volumecost", "cost", "type", "missed"],
                   [["VW Sharan", "20220707", "Внос от Швейцария", "0", "0.0", "0.0", "0.0", "АИ-95", "0"],
                    ["VW Sharan", "20220707", "", "296151", "60.35", "3.43", "207.0", "АИ-95", "0"],
                    ["VW Sharan", "20230204", "", "303178", "0.0", "0.0", "0.0", "Бутан", "0"]])
    lines += ["### image start info", "id_object\ttype_object\tnote", "57\t2\t", "iVBORw0KGgo=", "### image end"]
    return "\r\n".join(lines) + "\r\n"


class CarExpensesTest(Base):
    def test_import(self):
        car = self.car(name="Sharan", vin="")
        status, result = self.call("POST", f"/api/cars/{car['id']}/import/carexpenses", {"text": ce_backup(), "rate": 1 / 1.95583})
        self.assertEqual(status, 200, result)
        # Two patterns of one expense are two events; the odometer reading and the purchase are expenses.
        self.assertEqual(result["created"], {"refuel": 1, "service": 1, "expense": 4, "income": 1})
        self.assertEqual((result["reminders_created"], result["vehicle"], result["car_id"]), (3, "VW Sharan", "3"))
        _, listed = self.call("GET", f"/api/cars/{car['id']}/events")
        events = {(item["kind"], item["category"]): item for item in listed["items"]}
        refuel = events[("refuel", "АИ-95")]
        self.assertEqual(refuel["fuel"], "petrol")
        self.assertEqual((refuel["date"], refuel["odometer"], refuel["quantity"], refuel["amount"]), ("2022-07-07T12:00", 296151, 60.35, 105.84))
        self.assertAlmostEqual(refuel["price"], 1.753731, 5)
        oil = events[("service", "Моторное масло")]
        self.assertEqual((oil["amount"], oil["odometer"], oil["notes"]), (30.68, 295000, "ТО"))
        self.assertEqual(events[("expense", "Виньетка")]["notes"], "ТО\n7 дней")
        self.assertEqual(events[("income", "Личный водитель")]["amount"], 32.24)
        self.assertNotIn("odometer", events[("income", "Личный водитель")])
        reading = events[("expense", "Пробег")]
        self.assertEqual((reading["odometer"], reading["amount"], reading["excluded"]), (303178, 0, True))
        self.assertEqual(events[("expense", "Покупка машины")]["amount"], 2942.99)
        self.assertEqual(result["expense_events"]["57"], oil["id"])
        self.assertEqual(sorted(result["expense_events"]), ["57", "66", "78"])
        _, saved = self.call("GET", f"/api/cars/{car['id']}")
        self.assertEqual((saved["make"], saved["model"], saved["vin"], saved["year"], saved["notes"]), ("Volkswagen", "Sharan V6", "WVWZZZ7M6V005888", 2005, "Внос от Швейцария"))
        _, found = self.call("GET", f"/api/cars/{car['id']}/reminders")
        self.assertEqual({item["category"]: (item.get("every"), item.get("unit"), item.get("km")) for item in found["items"]},
                         {"Моторное масло": (None, None, 10000), "Виньетка": (1, "year", None), "Гараж": (1, "month", None)})
        # A picture goes on the event afterwards.
        path = f"/files/{files.user_key(OWNER)}/{'c' * 32}.jpg"
        status, with_file = self.call("POST", f"/api/cars/{car['id']}/events/{oil['id']}/files", {"files": [{"path": path, "type": "image/jpeg", "size": 9}]})
        self.assertEqual((status, [entry["path"] for entry in with_file["files"]]), (200, [path]))
        # Again: nothing new, no pictures to upload, the notes once.
        status, again = self.call("POST", f"/api/cars/{car['id']}/import/carexpenses", {"text": ce_backup(), "rate": 1 / 1.95583})
        self.assertEqual((again["created"], again["unchanged"], again["expense_events"]), ({"refuel": 0, "service": 0, "expense": 0, "income": 0}, 7, {}))
        self.assertEqual(self.call("GET", f"/api/cars/{car['id']}")[1]["notes"], "Внос от Швейцария")

    def test_sale(self):
        car = self.car(name="Sharan")
        text = ce_backup().replace("\t".join(f"{c}   " for c in ["_id", "name", "currency", "buy_date"]), "\t".join(f"{c}   " for c in ["_id", "name", "currency", "sell_date", "sell_price", "sell_mileage", "buy_date"]))
        text = text.replace("3  \tVW Sharan  \tlv  \t20220707  ", "3  \tVW Sharan  \tlv  \t20231101  \t4000  \t322000  \t20220707  ")
        status, result = self.call("POST", f"/api/cars/{car['id']}/import/carexpenses", {"text": text})
        self.assertEqual((status, result["created"]["income"]), (200, 2), result)
        _, listed = self.call("GET", f"/api/cars/{car['id']}/events")
        sale = next(item for item in listed["items"] if item["category"] == "Продажа машины")
        self.assertEqual((sale["date"], sale["amount"], sale["odometer"]), ("2023-11-01T12:00", 4000, 322000))
        self.assertTrue(self.call("GET", f"/api/cars/{car['id']}")[1]["sold"])

    def test_not_a_backup(self):
        car = self.car()
        status, error = self.call("POST", f"/api/cars/{car['id']}/import/carexpenses", {"text": "date,amount\n2026-01-01,5"})
        self.assertEqual((status, error["code"]), (400, "bad_carexpenses"))


class JsonImportTest(Base):
    def exported(self):
        """A car as exportCar writes it, from another account."""
        car = self.car(make="Volkswagen", vin="WVWZZZ7M6V005888")
        self.add(car, kind="refuel", category="Shell", quantity=40, price=1.8, odometer=50000, location={"lat": 43.2, "lon": 27.9})
        self.add(car, kind="service", category="Масло", amount=120, files=[{"path": f"/files/{files.user_key(OWNER)}/{'a' * 32}.jpg", "type": "image/jpeg"}])
        self.call("POST", f"/api/cars/{car['id']}/reminders", {"category": "Стоянка", "repeat": "weekday", "weekdays": [1, 4], "start": "2026-11-01"})
        _, events = self.call("GET", f"/api/cars/{car['id']}/events")
        _, found = self.call("GET", f"/api/cars/{car['id']}/reminders")
        _, saved = self.call("GET", f"/api/cars/{car['id']}")
        return {"format": "cars-serverless-aws", "version": 1, "car": saved, "events": events["items"],
                "reminders": [{key: value for key, value in item.items() if key != "status"} for item in found["items"]]}

    def test_import(self):
        data = self.exported()
        other = "other@example.com"
        self.fakes["cognito-idp"].add(other)
        _, car = self.call("POST", "/api/cars", {"name": "Golf"}, email=other)
        status, result = self.call("POST", f"/api/cars/{car['id']}/import/json", data, email=other)
        self.assertEqual(status, 200, result)
        self.assertEqual((result["created"], result["reminders_created"]), ({"refuel": 1, "service": 1, "expense": 0, "income": 0}, 1))
        self.assertEqual(sorted(result["event_ids"]), sorted(item["id"] for item in data["events"]))
        _, events = self.call("GET", f"/api/cars/{car['id']}/events", email=other)
        refuel = next(item for item in events["items"] if item["kind"] == "refuel")
        self.assertEqual((refuel["category"], refuel["amount"], refuel["location"]["lat"], refuel["by"]), ("Shell", 72, 43.2, other))
        # The files of another account do not come along; the page uploads them.
        self.assertFalse(any(item.get("files") for item in events["items"]))
        _, reminders_now = self.call("GET", f"/api/cars/{car['id']}/reminders", email=other)
        self.assertEqual((reminders_now["items"][0]["weekdays"], reminders_now["items"][0]["start"]), ([1, 4], "2026-11-01"))
        _, saved = self.call("GET", f"/api/cars/{car['id']}", email=other)
        self.assertEqual((saved["name"], saved["make"], saved["vin"]), ("Golf", "Volkswagen", "WVWZZZ7M6V005888"))
        status, again = self.call("POST", f"/api/cars/{car['id']}/import/json", data, email=other)
        self.assertEqual((status, again["unchanged"], again["event_ids"], again["reminders_created"], again["reminders_updated"]), (200, 2, {}, 0, 0))
        # A changed schedule in the file changes the reminder.
        data["reminders"][0] = {**data["reminders"][0], "weekdays": [6]}
        _, changed = self.call("POST", f"/api/cars/{car['id']}/import/json", data, email=other)
        self.assertEqual(changed["reminders_updated"], 1)
        _, reminders_now = self.call("GET", f"/api/cars/{car['id']}/reminders", email=other)
        self.assertEqual(reminders_now["items"][0]["weekdays"], [6])

    def test_not_an_export(self):
        car = self.car()
        for body in ({"events": []}, {"format": "cars.jagomann.com", "events": "x"}, {"format": "cars.jagomann.com", "events": [{"kind": "fuel", "date": "2026-01-01T10:00"}]}):
            status, error = self.call("POST", f"/api/cars/{car['id']}/import/json", body)
            self.assertEqual(status, 400, body)


class RemindersTest(Base):
    def test_states(self):
        events = [{"category": "Шины", "date": "2026-01-01T10:00", "odometer": 100000},
                  {"category": "Гараж", "date": "2026-10-01T10:00", "odometer": 105000}]
        status = reminders.status({"category": " шины ", "days": 365, "km": 20000}, events, "2026-10-19", 14, 1000)
        self.assertEqual((status["state"], status["due_date"], status["left_days"], status["left_km"]), ("ok", "2027-01-01", 74, 15000))
        self.assertEqual(reminders.status({"category": "Шины", "days": 300}, events, "2026-10-19", 14, 1000)["state"], "soon")
        self.assertEqual(reminders.status({"category": "Шины", "km": 4000}, events, "2026-10-19", 14, 1000)["state"], "overdue")
        self.assertEqual(reminders.status({"category": "Шины", "km": 5500}, events, "2026-10-19", 14, 1000)["state"], "soon")
        self.assertEqual(reminders.status({"category": "ТО", "days": 365}, events, "2026-10-19", 14, 1000)["state"], "never")

    def test_periods(self):
        def due(every, unit, last):
            return reminders.status({"category": "A", "every": every, "unit": unit}, [{"category": "A", "date": last + "T10:00"}], "2026-10-19", 14, 1000)["due_date"]
        self.assertEqual(due(10, "day", "2026-10-01"), "2026-10-11")
        self.assertEqual(due(2, "week", "2026-10-01"), "2026-10-15")
        self.assertEqual(due(1, "month", "2026-01-31"), "2026-02-28")
        self.assertEqual(due(14, "month", "2026-10-15"), "2027-12-15")
        self.assertEqual(due(4, "year", "2024-02-29"), "2028-02-29")
        self.assertEqual(due(1, "year", "2024-02-29"), "2025-02-28")

    def test_calendar_and_start(self):
        def state(reminder, events, today):
            found = reminders.status({"category": "Стоянка", "created": "2026-01-01T00:00:00Z", **reminder},
                                     [{"category": "Стоянка", "date": day + "T10:00"} for day in events], today, 14, 1000)
            return found["state"], found["due_date"]
        # The first of every month: from the start, then after the last payment.
        self.assertEqual(state({"repeat": "monthday", "day": 1, "start": "2026-10-01"}, [], "2026-09-20"), ("ok", "2026-10-01"))
        self.assertEqual(state({"repeat": "monthday", "day": 1, "start": "2026-10-01"}, [], "2026-09-29"), ("soon", "2026-10-01"))
        self.assertEqual(state({"repeat": "monthday", "day": 1, "start": "2026-10-01"}, [], "2026-10-05"), ("overdue", "2026-10-01"))
        self.assertEqual(state({"repeat": "monthday", "day": 1, "start": "2026-10-01"}, ["2026-10-02"], "2026-10-05"), ("ok", "2026-11-01"))
        # The 31st in a short month is its last day; December goes to January.
        self.assertEqual(state({"repeat": "monthday", "day": 31}, ["2027-02-03"], "2027-02-10")[1], "2027-02-28")
        self.assertEqual(state({"repeat": "monthday", "day": 5}, ["2026-12-20"], "2026-12-21")[1], "2027-01-05")
        # Every Monday (2026-10-19 is one): soon a day before, not a week.
        self.assertEqual(state({"repeat": "weekday", "weekdays": [1]}, ["2026-10-19"], "2026-10-20"), ("ok", "2026-10-26"))
        self.assertEqual(state({"repeat": "weekday", "weekdays": [1]}, ["2026-10-19"], "2026-10-25"), ("soon", "2026-10-26"))
        self.assertEqual(state({"repeat": "weekday", "weekdays": [1]}, [], "2026-01-05")[1], "2026-01-05")
        # Monday and Thursday: the nearest of them.
        self.assertEqual(state({"repeat": "weekday", "weekdays": [1, 4]}, ["2026-10-19"], "2026-10-20")[1], "2026-10-22")
        self.assertEqual(state({"repeat": "weekday", "weekdays": [1, 4]}, ["2026-10-22"], "2026-10-23")[1], "2026-10-26")
        # A period counts from the start while there is no event since.
        self.assertEqual(state({"every": 1, "unit": "year", "start": "2026-03-01"}, [], "2026-10-19"), ("ok", "2027-03-01"))
        self.assertEqual(state({"every": 1, "unit": "year", "start": "2026-03-01"}, ["2025-05-01"], "2026-10-19")[1], "2027-03-01")
        self.assertEqual(state({"every": 1, "unit": "year", "start": "2026-03-01"}, ["2026-06-01"], "2026-10-19")[1], "2027-06-01")
        self.assertEqual(state({"every": 1, "unit": "year"}, [], "2026-10-19")[0], "never")

    def test_calendar_api(self):
        car = self.car()
        status, item = self.call("POST", f"/api/cars/{car['id']}/reminders", {"category": "Стоянка", "repeat": "monthday", "day": 1, "start": "2026-11-01"})
        self.assertEqual((status, item["day"], item["start"], item["status"]["due_date"]), (201, 1, "2026-11-01", "2026-11-01"))
        self.assertNotIn("every", item)
        for body, field in (({"repeat": "monthday"}, "day"), ({"repeat": "monthday", "day": 32}, "day"), ({"repeat": "weekday", "weekdays": [8]}, "weekdays"), ({"repeat": "weekday", "weekdays": []}, "weekdays"),
                            ({"repeat": "yearly"}, "repeat"), ({"every": 1, "start": "1.11.2026"}, "start"), ({"every": 1, "start": "2026-02-30"}, "start")):
            status, error = self.call("POST", f"/api/cars/{car['id']}/reminders", {"category": "Стоянка", **body})
            self.assertEqual((status, error.get("detail")), (400, field), body)
        status, saved = self.call("PUT", f"/api/cars/{car['id']}/reminders/{item['id']}", {"category": "Стоянка", "repeat": "weekday", "weekdays": [5, 1, 1]})
        self.assertEqual((status, saved["weekdays"], saved["created"]), (200, [1, 5], item["created"]))
        self.assertNotIn("day", saved)

    def test_api(self):
        car = self.car()
        self.add(car, category="Гараж", date="2026-09-25T08:00", odometer=139419)
        status, item = self.call("POST", f"/api/cars/{car['id']}/reminders", {"category": "Гараж", "days": 30})
        self.assertEqual(status, 201)
        self.assertEqual(item["status"]["last_date"], "2026-09-25")
        status, error = self.call("POST", f"/api/cars/{car['id']}/reminders", {"category": "Гараж"})
        self.assertEqual((status, error["detail"]), (400, "every"))
        for body, field in (({"every": 2, "unit": "decade"}, "unit"), ({"every": 101, "unit": "year"}, "every")):
            status, error = self.call("POST", f"/api/cars/{car['id']}/reminders", {"category": "Гараж", **body})
            self.assertEqual((status, error["detail"]), (400, field))
        status, item = self.call("PUT", f"/api/cars/{car['id']}/reminders/{item['id']}", {"category": "Гараж", "every": 2, "unit": "month"})
        self.assertEqual((status, item["every"], item["unit"], item["status"]["due_date"]), (200, 2, "month", "2026-11-25"))
        status, listed = self.call("GET", f"/api/cars/{car['id']}/reminders")
        self.assertEqual([entry["category"] for entry in listed["items"]], ["Гараж"])

    def test_daily_mail_once(self):
        car = self.car()
        self.add(car, category="Гараж", date="2026-10-01T08:00")
        self.call("POST", f"/api/cars/{car['id']}/reminders", {"category": "Гараж", "days": 30})
        self.call("POST", f"/api/cars/{car['id']}/reminders", {"category": "Шины", "days": 30})
        self.fakes["cognito-idp"].add("ru@example.com", locale="ru")
        self.assertEqual(mail.send_reminders("2026-10-19"), 1)
        sent = self.fakes["sesv2"].sent
        self.assertEqual(sent[0]["to"], [OWNER])
        self.assertEqual(sent[0]["subject"], "Cars: Гараж (Tesla Model X)")
        self.assertIn("[soon] Tesla Model X: Гараж — in 12 days (2026-10-31)", sent[0]["text"])
        # The same state of the same reminder is not mailed again.
        self.assertEqual(mail.send_reminders("2026-10-20"), 0)
        # Overdue is a new state: one more mail.
        self.assertEqual(mail.send_reminders("2026-11-02"), 1)
        self.assertIn("[overdue] Tesla Model X: Гараж — 2 days ago (2026-10-31)", sent[1]["text"])
        # A newer event starts the reminder over.
        self.add(car, category="Гараж", date="2026-11-03T08:00")
        self.assertEqual(mail.send_reminders("2026-11-25"), 1)

    def test_no_mail_when_turned_off(self):
        car = self.car()
        self.add(car, category="Гараж", date="2026-09-01T08:00")
        self.call("POST", f"/api/cars/{car['id']}/reminders", {"category": "Гараж", "days": 30})
        self.call("PUT", "/api/me/prefs", {"reminders": False})
        self.assertEqual(mail.send_reminders("2026-10-19"), 0)


class AccountTest(Base):
    def test_me(self):
        status, me = self.call("GET", "/api/me")
        self.assertEqual((status, me["email"], me["admin"], me["prefs"], me["lead_days"]), (200, OWNER, False, {"reminders": True}, 14))

    def test_admin_only(self):
        status, error = self.call("GET", "/api/admin/users")
        self.assertEqual((status, error["code"]), (403, "admin_only"))

    def test_invite_and_delete(self):
        status, created = self.call("POST", "/api/admin/users", {"email": "New@Example.com"}, admin=True)
        self.assertEqual((status, created["email"]), (201, "new@example.com"))
        car = self.call("POST", "/api/cars", {"name": "Golf"}, email="new@example.com")[1]
        self.call("POST", f"/api/cars/{car['id']}/events", {"kind": "expense", "date": "2026-10-01T10:00"}, email="new@example.com")
        status, users = self.call("GET", "/api/admin/users", admin=True)
        self.assertEqual([user["email"] for user in users["items"]], ["new@example.com", OWNER])
        status, deleted = self.call("DELETE", "/api/admin/users", params={"email": "new@example.com"}, admin=True)
        self.assertEqual((status, deleted["items"]), (200, 2))
        status, error = self.call("DELETE", "/api/admin/users", params={"email": OWNER}, admin=True)
        self.assertEqual(error["code"], "not_yourself")

    def test_version_without_repository(self):
        os.environ["VERSION"] = "v0.1.0"
        os.environ["RELEASES_REPOSITORY"] = ""
        status, info = self.call("GET", "/api/version")
        self.assertEqual((status, info["version"], info["repository"]), (200, "v0.1.0", ""))


if __name__ == "__main__":
    unittest.main()
