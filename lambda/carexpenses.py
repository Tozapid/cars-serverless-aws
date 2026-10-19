"""Import of a backup of the Android app Car Expenses (CE).

The backup is a text file of sections: a line "### <name> info", a line of
column names and rows, all separated by tabs and padded with spaces. The
sections of one vehicle carry its name: "### expenses info (VW Sharan)".
The pictures of the expenses follow as "### image start info" … "### image
end" (PNG in base64, most of the file's size); the page cuts them out,
sends the rest here and uploads the pictures of the new events itself.

- records: the refuels — fuel type as the category, litres, price of a litre
  and the cost; the fuel from the name of the type ("Бутан" gas, "АИ-95"
  petrol), else from its tank: the second tank of a car is its gas one. A record without litres and cost is an odometer reading: it
  becomes an event "excluded" from the statistics, so that it counts for the
  distance only. A record without an odometer is a note on the vehicle.
- expenses: one CE expense may list several patterns (id_pattern "47; 46"),
  each with the cost of its parts and of the work; every pattern becomes an
  event of its own, named after the pattern. A pattern of an income category
  (expense_type 0) gives an income, of the CE categories 3 and 4 (repairs,
  maintenance) a service, of any other an expense. An expense keeps its
  odometer only when it was entered: CE's predicted one is a guess.
- patterns with a period (period_type 1 kilometres, 2 months, 3 both) that
  the vehicle's expenses use become reminders of their name.
- vehicle: what fills the empty fields of the car; its purchase, an expense
  "Покупка машины" on the day of it, and its sale, an income "Продажа
  машины", which marks the car sold.

CE has no time of day: an event is at noon. rate multiplies every sum and
price, such as 1 / 1.95583 from leva to euro.
"""

import re


SERVICE_CATEGORIES = {"3", "4"}
NOON = "T12:00"


class CarExpensesError(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


def sections(text):
    """{name: [row as {column: value}]} of every section but the pictures."""
    found = {}
    lines = text.splitlines()
    index = 0
    while index < len(lines):
        line = lines[index]
        match = re.match(r"^### (.+?) info(?: \((.+)\))?\s*$", line)
        index += 1
        if not match or match.group(1).startswith("image"):
            continue
        name = match.group(1) + (f" ({match.group(2)})" if match.group(2) else "")
        if index >= len(lines):
            break
        columns = [part.strip() for part in lines[index].split("\t")]
        index += 1
        rows = []
        while index < len(lines) and not lines[index].startswith("###"):
            cells = [part.strip() for part in lines[index].split("\t")]
            if any(cells):
                rows.append(dict(zip(columns, cells)))
            index += 1
        found[name] = rows
    return found


def vehicles(found):
    return [row.get("name", "") for row in found.get("vehicle", [])]


def number(value):
    try:
        return float(str(value).replace(",", "."))
    except (TypeError, ValueError):
        return 0.0


def day(value):
    value = str(value or "")
    if not re.fullmatch(r"\d{8}", value):
        return None
    return f"{value[:4]}-{value[4:6]}-{value[6:]}{NOON}"


def parts(value):
    return [part.strip() for part in str(value or "").split(";")]


def fuel_of(name, tank):
    text = str(name or "").lower()
    # As guessFuel in web/stats.js: "газ" as a word, not "Газпром".
    if re.search(r"lpg|gpl|autogas|propane|butane|бутан|пропан|(?<![а-яё])газ(?![а-яё])", text):
        return "lpg"
    if re.search(r"cng|methane|метан|(?<![а-яё])гнв(?![а-яё])", text):
        return "cng"
    if re.search(r"diesel|gasoil|gazole|дизел|(?<![а-яё])дт(?![а-яё])", text):
        return "diesel"
    if re.search(r"electr|kwh|квт", text):
        return "electric"
    return "lpg" if tank == "2" else "petrol"


def read(text, vehicle=None, rate=1.0):
    """{"vehicle": fields of the car, "notes": text, "events": [...],
    "reminders": [...], "vehicles": names}. An event of an expense keeps the
    expense's CE id in "ce_expense" for its pictures."""
    if "### CE v." not in text[:200] and "### vehicle info" not in text:
        raise CarExpensesError("bad_carexpenses")
    found = sections(text)
    names = vehicles(found)
    if not names:
        raise CarExpensesError("bad_carexpenses")
    name = vehicle if vehicle in names else names[0]
    car = next(row for row in found["vehicle"] if row.get("name") == name)
    categories = {row.get("_id"): row for row in found.get("category", [])}
    patterns = {row.get("_id"): row for row in found.get("pattern", []) + found.get(f"pattern ({name})", [])}
    money = lambda value: round(abs(number(value)) * rate, 2)  # noqa: E731
    tanks = {row.get("_id"): row.get("tank_numb") for row in found.get("fuel_type", [])}
    events, notes, used = [], [], set()

    for row in found.get(f"records ({name})", []):
        when = day(row.get("date"))
        odometer = number(row.get("mileage"))
        volume, cost = number(row.get("volume")), number(row.get("cost"))
        if not when:
            continue
        if not odometer and not volume and not cost:
            if row.get("note"):
                notes.append(row["note"])
            continue
        if not volume and not cost:
            events.append({"kind": "expense", "date": when, "odometer": odometer, "category": "Пробег", "amount": 0.0, "excluded": True,
                           "notes": row.get("note", "")})
            continue
        events.append({"kind": "refuel", "date": when, "odometer": odometer or None, "category": row.get("type", ""),
                       "fuel": fuel_of(row.get("type"), tanks.get(row.get("id_fueltype"))),
                       "quantity": round(volume, 3), "price": round(number(row.get("volumecost")) * rate, 6), "amount": money(cost),
                       "notes": row.get("note", "")})

    for row in found.get(f"expenses ({name})", []):
        when = day(row.get("date"))
        if not when:
            continue
        ids = parts(row.get("id_pattern"))
        costpart, costwork, comments = parts(row.get("costpart")), parts(row.get("costwork")), parts(row.get("comment"))
        odometer = number(row.get("mileage")) or None
        text_of = " ".join(part for part in (row.get("name", ""), row.get("note", "")) if part).strip()
        for position, pattern_id in enumerate(ids):
            pattern = patterns.get(pattern_id, {})
            category = categories.get(pattern.get("id_category"), {})
            kind = "income" if category.get("expense_type") == "0" else "service" if pattern.get("id_category") in SERVICE_CATEGORIES else "expense"
            amount = number(costpart[position] if position < len(costpart) else 0) + number(costwork[position] if position < len(costwork) else 0)
            comment = comments[position] if position < len(comments) else ""
            events.append({"kind": kind, "date": when, "odometer": odometer, "category": pattern.get("name") or comment or "Car Expenses",
                           "amount": money(amount), "notes": "\n".join(part for part in (text_of, comment) if part),
                           "ce_expense": row.get("_id") if position == 0 else None})
            used.add(pattern_id)

    if number(car.get("buy_price")) and day(car.get("buy_date")):
        events.append({"kind": "expense", "date": day(car["buy_date"]), "odometer": number(car.get("buy_mileage")) or None,
                       "category": "Покупка машины", "amount": money(car["buy_price"]), "notes": "Car Expenses"})

    sold = day(car.get("sell_date"))
    if sold and number(car.get("sell_price")):
        events.append({"kind": "income", "date": sold, "odometer": number(car.get("sell_mileage")) or None,
                       "category": "Продажа машины", "amount": money(car["sell_price"]), "notes": "Car Expenses"})

    reminders = []
    for pattern_id in sorted(used, key=lambda value: int(value) if value.isdigit() else 0):
        pattern = patterns.get(pattern_id, {})
        kind_of = pattern.get("period_type")
        km = int(number(pattern.get("period_mileage"))) if kind_of in ("1", "3") else None
        months = int(number(pattern.get("period_month"))) if kind_of in ("2", "3") else None
        if not (km or months) or not pattern.get("name"):
            continue
        every, unit = (months // 12, "year") if months and months % 12 == 0 else (months, "month") if months else (None, None)
        reminders.append({"category": pattern["name"], "every": every, "unit": unit, "km": km or None})

    year = (car.get("veh_birthday") or "")[:4]
    fields = {"make": car.get("veh_manufacturer", ""), "model": " ".join(part for part in (car.get("veh_model", ""), car.get("veh_modification", "")) if part),
              "vin": car.get("veh_vin", ""), "year": int(year) if year.isdigit() and 1886 <= int(year) <= 2100 else None,
              "unit": "kWh" if car.get("engine_type") == "4" else "L", "sold": bool(sold)}
    return {"vehicles": names, "vehicle": fields, "name": name, "vehicle_id": car.get("_id", ""), "currency": car.get("currency", ""), "notes": "\n\n".join(notes),
            "events": events, "reminders": reminders}
