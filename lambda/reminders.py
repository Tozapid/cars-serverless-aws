"""When a reminder is due.

A reminder (sk = REMINDER#<car>#<id>) names a category of events, such as
"Brake fluid" or "Insurance", and how long it holds: so many days, weeks,
months or years (every, unit; days alone in reminders saved before units),
so many kilometres or both. Months and years are calendar ones: a month after
31 January is the last day of February.

A reminder may instead repeat on the calendar (repeat): on a day of every
month (monthday, day 1–31, the last day of a shorter month) or on chosen
days of every week (weekday, weekdays: 1 Monday … 7 Sunday). It is due on the first such day
after the last event of its category, or on the first one from its start
when there is no event since then. Every reminder may have a start
(YYYY-MM-DD): it counts from then, and a period with no event yet counts
from its start too. It counts from the last event of that category, of any
kind: its day and the highest odometer among those events. The distance left
is measured against the highest odometer of the car.

The state is "overdue" once the day or the distance has passed, "soon" when
either is within the lead (REMINDER_LEAD_DAYS, REMINDER_LEAD_KM), "ok"
otherwise and "never" while the car has no event of the category. The page
shows the states that the API counts here, and the daily job mails the due
ones (mail.py).
"""

import calendar
from datetime import date, timedelta

import common

# The units of a reminder's period and the most of each.
UNITS = {"day": 36500, "week": 5200, "month": 1200, "year": 100}
REPEATS = ("period", "monthday", "weekday")
# How long before a calendar day a reminder is "soon": a week's lead of
# fourteen days would make it always soon.
CALENDAR_LEAD = {"weekday": 1, "monthday": 3}


def lead():
    return int(common.env_number("REMINDER_LEAD_DAYS", 14)), int(common.env_number("REMINDER_LEAD_KM", 1000))


def same(a, b):
    return " ".join(str(a or "").split()).casefold() == " ".join(str(b or "").split()).casefold()


def odometer(events):
    values = [float(item["odometer"]) for item in events if item.get("odometer") is not None]
    return max(values) if values else None


def period(reminder):
    """(every, unit) of a reminder, or None without a period."""
    if reminder.get("every") and reminder.get("unit") in UNITS:
        return int(reminder["every"]), reminder["unit"]
    if reminder.get("days"):
        return int(reminder["days"]), "day"
    return None


def add(start, every, unit):
    if unit == "day":
        return start + timedelta(days=every)
    if unit == "week":
        return start + timedelta(weeks=every)
    months = every * (12 if unit == "year" else 1)
    year, month = divmod(start.month - 1 + months, 12)
    year += start.year
    return date(year, month + 1, min(start.day, calendar.monthrange(year, month + 1)[1]))


def weekdays(reminder):
    """The days of the week of a weekly reminder, 1 Monday … 7 Sunday."""
    return {int(day) for day in reminder.get("weekdays") or [reminder.get("weekday") or 1]}


def month_day(year, month, day):
    return date(year, month, min(day, calendar.monthrange(year, month)[1]))


def next_day(reminder, after):
    """The first day of a calendar reminder later than after."""
    if reminder.get("repeat") == "weekday":
        days = weekdays(reminder)
        return next(after + timedelta(days=step) for step in range(1, 8) if (after + timedelta(days=step)).isoweekday() in days)
    day = int(reminder["day"])
    found = month_day(after.year, after.month, day)
    if found <= after:
        year, month = divmod(after.month, 12)
        found = month_day(after.year + year, month + 1, day)
    return found


def status(reminder, events, today=None, lead_days=None, lead_km=None):
    if lead_days is None or lead_km is None:
        lead_days, lead_km = lead()
    today = date.fromisoformat(today or common.today())
    found = [item for item in events if same(item.get("category"), reminder.get("category"))]
    current = odometer(events)
    result = {"state": "never", "count": len(found), "current_km": current, "last_date": None, "last_km": None,
              "due_date": None, "left_days": None, "due_km": None, "left_km": None}
    repeat = reminder.get("repeat") or "period"
    start = date.fromisoformat(reminder["start"]) if reminder.get("start") else None
    if found:
        result["last_date"] = max(str(item["date"])[:10] for item in found)
        result["last_km"] = odometer(found)
    last = date.fromisoformat(result["last_date"]) if result["last_date"] else None
    if repeat != "period":
        # The first calendar day after the last event, or from the start
        # (the day the reminder was made, without one).
        since = start or date.fromisoformat(str(reminder.get("created") or reminder.get("modified") or today.isoformat())[:10])
        due = next_day(reminder, last) if last and last >= since else next_day(reminder, since - timedelta(days=1))
        result["due_date"] = due.isoformat()
        result["left_days"] = (due - today).days
        lead_days = min(lead_days, CALENDAR_LEAD[repeat])
        result["state"] = "overdue" if result["left_days"] < 0 else "soon" if result["left_days"] <= lead_days else "ok"
        return result
    if not found and not start:
        return result
    every = period(reminder)
    km = reminder.get("km")
    if every:
        # From the last event, or from the start when that is later.
        base = max(day for day in (last, start) if day)
        due = add(base, *every)
        result["due_date"] = due.isoformat()
        result["left_days"] = (due - today).days
    if km and result["last_km"] is not None and current is not None:
        result["due_km"] = result["last_km"] + float(km)
        result["left_km"] = result["due_km"] - current
    left_days, left_km = result["left_days"], result["left_km"]
    if (left_days is not None and left_days < 0) or (left_km is not None and left_km < 0):
        result["state"] = "overdue"
    elif (left_days is not None and left_days <= lead_days) or (left_km is not None and left_km <= lead_km):
        result["state"] = "soon"
    else:
        result["state"] = "ok"
    return result
