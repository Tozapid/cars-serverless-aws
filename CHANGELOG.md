# Changelog

## v0.1.0 — 2026-10-20

### Added

- A log of cars on AWS: Cognito sign-in with optional two-factor authentication, users and administrators, four languages (English, Russian, French, Italian); every user has their own cars.
- Events of a car: charges and refuels (quantity, unit price and total — a change of one counts the one of the other two that was filled in earliest), service, expenses and income; odometer, category, notes, "leave out of the statistics", receipts, photos and PDFs, also pasted from the clipboard; a place from the browser's location or put on a map.
- Fuels of a refuel — petrol, diesel, gas (LPG), methane (CNG, in kilograms) and electricity — and for a car on more than one, such as gas and petrol, the consumption per 100 km and the price of each.
- Statistics: distance, kilometres a day, costs and costs less income, the price of a kilometre, a day and a month, consumption per 100 km, the average price of a kWh or a litre; charts by day, week, month or year with a shared crosshair, zoom by selection and a large view; shares of stations and categories, totals by year; an (i) on every tile with what it is and its formula.
- A map of the events with icons of their kind and groups of near ones; a station or a service that was near is suggested for a new event, with its last price.
- Reminders after so many days, weeks, months or years and kilometres from the last event of their category, or on a day of every month or on chosen days of the week, with a start date; "soon" and "overdue" on the page and by mail once a day.
- Short forms of each kind of event under links of their own, for a phone; drafts of the forms kept in the browser.
- Import of a Car Expenses backup (Android): refuels, expenses by pattern, income, odometer readings, reminders from the patterns with a period, the car's fields, its photo, its sale and the photos of the expenses; leva can be converted to euro. Export of a car to a JSON file, with its receipts and photos, and the import of such a file as a new car or into one.
- API keys (read, or read and write) and read-only share links without a sign-in, each with where and when it was made and last used; administrators may look at the cars of the other users.
- The public demo: the sign-in filled in on the sign-in screen, and every hour everything goes back to the examples of `seed/seed.json`.
