"""Reminders by mail through SES from SENDER.

The daily job looks at every enabled user who wants the mails
(pk = USER#<email>, sk = PREFS, "reminders"; on unless turned off in the
settings): the reminders of their cars that are not sold and that mail
(a reminder may be turned off on the page), with the state that
reminders.status gives. A reminder that turned "soon" or "overdue" goes into
one mail of the user's with the others of that day. A marker
(pk = MARK, sk = remind#<email>#<reminder>#<last event>#<state>) keeps it from
being mailed again until a newer event of its category starts it over. Each
mail is in the language the user picked on the page (the Cognito attribute
"locale"), else in English. SENDER empty turns the mails off.
"""

import html
import os

import common
import reminders

FALLBACK = "en"
MARK_SECONDS = 400 * 86400
TEXT = {
    "en": {
        "brand": "Cars",
        "subject": "Cars: {count} reminders due",
        "subject_one": "Cars: {title}",
        "intro": "These reminders are due:",
        "overdue": "overdue",
        "soon": "soon",
        "days_left": "in {days} days ({date})",
        "days_over": "{days} days ago ({date})",
        "today": "today",
        "km_left": "in {km} km",
        "km_over": "{km} km ago",
        "open": "Open the car log: {site}",
        "footer": "Whether you get these mails is set in Settings → Mail.",
    },
    "ru": {
        "brand": "Машины",
        "subject": "Машины: напоминаний — {count}",
        "subject_one": "Машины: {title}",
        "intro": "Подошли напоминания:",
        "overdue": "просрочено",
        "soon": "скоро",
        "days_left": "через {days} дн. ({date})",
        "days_over": "{days} дн. назад ({date})",
        "today": "сегодня",
        "km_left": "через {km} км",
        "km_over": "{km} км назад",
        "open": "Открыть журнал машин: {site}",
        "footer": "Приходят ли эти письма, задаётся в «Настройки» → «Письма».",
    },
    "fr": {
        "brand": "Voitures",
        "subject": "Voitures : {count} rappels à faire",
        "subject_one": "Voitures : {title}",
        "intro": "Ces rappels arrivent à échéance :",
        "overdue": "en retard",
        "soon": "bientôt",
        "days_left": "dans {days} jours ({date})",
        "days_over": "il y a {days} jours ({date})",
        "today": "aujourd’hui",
        "km_left": "dans {km} km",
        "km_over": "il y a {km} km",
        "open": "Ouvrir le carnet des voitures : {site}",
        "footer": "Ces e-mails se règlent dans Paramètres → E-mails.",
    },
    "it": {
        "brand": "Auto",
        "subject": "Auto: {count} promemoria in scadenza",
        "subject_one": "Auto: {title}",
        "intro": "Questi promemoria sono in scadenza:",
        "overdue": "scaduto",
        "soon": "a breve",
        "days_left": "tra {days} giorni ({date})",
        "days_over": "{days} giorni fa ({date})",
        "today": "oggi",
        "km_left": "tra {km} km",
        "km_over": "{km} km fa",
        "open": "Apri il registro delle auto: {site}",
        "footer": "Queste e-mail si impostano in Impostazioni → E-mail.",
    },
}


def prefs(email):
    item = common.get("USER#" + email, "PREFS") or {}
    return {"reminders": item.get("reminders", True) is not False}


def recipients():
    """Enabled users who want the reminders, with their language."""
    found = []
    paginator = common.client("cognito-idp").get_paginator("list_users")
    for page in paginator.paginate(UserPoolId=os.environ["USER_POOL_ID"]):
        for user in page.get("Users", []):
            if not user.get("Enabled", True):
                continue
            attributes = {item.get("Name"): item.get("Value", "") for item in user.get("Attributes", [])}
            email = attributes.get("email", "").lower()
            if not email or not prefs(email)["reminders"]:
                continue
            code = attributes.get("locale", "")[:2].lower()
            found.append((email, code if code in TEXT else FALLBACK))
    return found


def send(to, subject, text, markup):
    sender = os.environ.get("SENDER", "")
    if not sender:
        return False
    try:
        common.client("sesv2").send_email(
            FromEmailAddress=f"{TEXT['en']['brand']} <{sender}>",
            Destination={"ToAddresses": [to]},
            Content={"Simple": {
                "Subject": {"Data": subject[:200], "Charset": "UTF-8"},
                "Body": {"Text": {"Data": text, "Charset": "UTF-8"}, "Html": {"Data": markup, "Charset": "UTF-8"}},
            }},
        )
    except Exception:
        # In the SES sandbox an address that is not verified is refused; the
        # others still get theirs.
        common.logger.exception("mail to %s not sent", to)
        return False
    return True


def kilometres(value):
    return f"{abs(round(value)):,}".replace(",", " ")


def describe(car, reminder, state, words):
    parts = []
    if state["left_days"] is not None:
        days = state["left_days"]
        if days == 0:
            parts.append(words["today"])
        else:
            parts.append(words["days_left" if days > 0 else "days_over"].format(days=abs(days), date=state["due_date"]))
    if state["left_km"] is not None:
        parts.append(words["km_left" if state["left_km"] >= 0 else "km_over"].format(km=kilometres(state["left_km"])))
    return f"[{words[state['state']]}] {car['name']}: {reminder['category']} — " + ", ".join(parts)


def page(lines, words):
    site = os.environ.get("SITE_URL", "")
    text = "\n".join(lines + ["", words["open"].format(site=site), words["footer"]]) + "\n"
    parts = [f'<div style="margin:2px 0">{html.escape(line)}</div>' for line in lines]
    parts.append(f'<p style="margin-top:18px"><a href="{html.escape(site)}">{html.escape(site)}</a></p>')
    parts.append(f'<p style="color:#5f6673;font-size:13px">{html.escape(words["footer"])}</p>')
    markup = ('<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:14px;'
              'line-height:1.5;color:#16181d">' + "".join(parts) + "</div>")
    return text, markup


def due(email, today=None):
    """The reminders of a user that are due and not mailed yet: (car,
    reminder, state, marker) each."""
    items = common.query_all("USER#" + email)
    cars = {item["id"]: item for item in items if item["sk"].startswith("CAR#") and not item.get("sold")}
    found = []
    for car_id, car in cars.items():
        events = [item for item in items if item["sk"].startswith(f"EVENT#{car_id}#")]
        for reminder in (item for item in items if item["sk"].startswith(f"REMINDER#{car_id}#")):
            if reminder.get("mail") is False:
                continue
            state = reminders.status(reminder, events, today)
            if state["state"] not in ("soon", "overdue"):
                continue
            # One mail per state of one due day: a reminder that repeats on
            # the calendar comes again on its next day.
            key = f"remind#{email}#{reminder['id']}#{state['last_date']}#{state['last_km']}#{state['due_date']}#{state['state']}"
            if not common.marked(key):
                found.append((car, reminder, state, key))
    return found


def send_reminders(today=None):
    """Mails each user the reminders that became due; the number of mails."""
    if not os.environ.get("SENDER"):
        return 0
    sent = 0
    for email, code in recipients():
        found = due(email, today)
        if not found:
            continue
        words = TEXT[code]
        found.sort(key=lambda entry: (entry[2]["state"] != "overdue", entry[0]["name"], entry[1]["category"]))
        if len(found) == 1:
            subject = words["subject_one"].format(title=f"{found[0][1]['category']} ({found[0][0]['name']})")
        else:
            subject = words["subject"].format(count=len(found))
        text, markup = page([words["intro"], ""] + [describe(car, reminder, state, words) for car, reminder, state, _ in found], words)
        if send(email, subject, text, markup):
            sent += 1
            for *_, key in found:
                common.mark(key, MARK_SECONDS)
    return sent
