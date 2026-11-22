"""Access of other users to a car: its owner names a user by email and what
they may do, "read" (view the car) or "write" (also add and change its
events, reminders and drafts). The car itself, its settings, imports and
deletion stay with the owner.

Two items for each grant:

pk = USER#<owner>, sk = GRANT#<car>#<email>     what the owner gave;
pk = USER#<email>, sk = SHARED#<owner>#<car>    the pointer of the user it
                                                was given to, for the cars
                                                shared with them.

The user opens such a car as an administrator opens another user's, with
?owner=<email> (app.api).
"""

import common

ROLES = ("read", "write")
GRANTS_MAX = 100


def pk(email):
    return "USER#" + email


def given(owner):
    """The grants of the owner's cars."""
    return [{key: item.get(key) for key in ("car", "email", "role", "created")}
            for item in common.plain(common.query_all(pk(owner), "GRANT#"))]


def give(owner, car, email, role):
    """Gives email the role on the owner's car, or changes it. False when the
    owner has given too many."""
    current = common.get(pk(owner), f"GRANT#{car}#{email}")
    if not current and len(common.query_all(pk(owner), "GRANT#")) >= GRANTS_MAX:
        return False
    now = common.now_iso()
    created = (current or {}).get("created") or now
    common.put({"pk": pk(owner), "sk": f"GRANT#{car}#{email}", "car": car, "email": email, "role": role, "created": created, "modified": now})
    common.put({"pk": pk(email), "sk": f"SHARED#{owner}#{car}", "owner": owner, "car": car, "role": role, "created": created})
    return True


def take(owner, car, email):
    """Ends a grant; False when there was none."""
    if not common.get(pk(owner), f"GRANT#{car}#{email}"):
        return False
    common.delete_all([{"pk": pk(owner), "sk": f"GRANT#{car}#{email}"}, {"pk": pk(email), "sk": f"SHARED#{owner}#{car}"}])
    return True


def received(email):
    """The cars shared with email: [{owner, car, role}]."""
    return [{key: item.get(key) for key in ("owner", "car", "role")} for item in common.query_all(pk(email), "SHARED#")]


def roles(owner, email):
    """What email may do with each car of owner: {car: role}."""
    return {item["car"]: item["role"] for item in common.query_all(pk(email), f"SHARED#{owner}#")}


def drop_car(owner, car):
    """The grants of a car that goes."""
    items = common.query_all(pk(owner), f"GRANT#{car}#")
    common.delete_all(items + [{"pk": pk(item["email"]), "sk": f"SHARED#{owner}#{car}"} for item in items])


def drop_user(email):
    """The grants of a user who goes: those they gave and those they got."""
    gave = common.query_all(pk(email), "GRANT#")
    got = common.query_all(pk(email), "SHARED#")
    common.delete_all(gave + got
                      + [{"pk": pk(item["email"]), "sk": f"SHARED#{email}#{item['car']}"} for item in gave]
                      + [{"pk": pk(item["owner"]), "sk": f"GRANT#{item['car']}#{email}"} for item in got])
