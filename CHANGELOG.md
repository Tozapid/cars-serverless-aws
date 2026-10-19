# Changelog

## v0.1.0

### Added

- Cars of their own per user: name, make, model, year, VIN, number plate, energy in kWh or litres, currency, notes, sold, and a photo opened full size on a click; the list of cars tells the day of the last event and how many there are.
- Events of a car: charges and refuels, service, expenses and income, with date and time, odometer, a category with its own list of choices (opening on a click even when filled in), notes, receipts, photos and PDFs — photos shrunk by the browser and also pasted from the clipboard (⌘V / Ctrl+V) — and "leave out of the statistics". Of quantity, unit price and total a change of one counts the one of the other two that was filled in earliest, and a new refuel takes the last price of its station.
- Fuels of a refuel: petrol, diesel, gas (LPG), methane (CNG, in kilograms) and electricity, guessed from the station when not given. A car on more than one fuel, such as gas and petrol, gets the consumption per 100 km, the quantity, the price of a litre and the price of a kilometre of each, and a chart of them.
- Statistics counted by the page for 12 months, a year or all the time: distance and kilometres a day, costs and costs less income, the price of a kilometre, a day and a month, consumption per 100 km, the average price of a kWh or a litre, shares of stations and categories, totals by year; an (i) on every tile tells what it is and its formula. An event left out of the statistics counts for the odometer only, within the counted events.
- Charts of costs, kilometres, the odometer, consumption and the price of a kilometre by day, week, month or year, with a crosshair shared across them, zoom by selecting a stretch, a large view, and series hidden or shown alone from the legend.
- The place of an event from the location of the browser or a click on a map; the categories used near it come first, and the nearest becomes the category of a new event. A map of the events with an icon of their kind, near ones grouped and opened with a click, and a table of the places; a place also opens in a panel with a map from the list of events.
- Reminders after so many days, weeks, months or years and kilometres from the last event of their category, on a day of every month or on chosen days of the week, with a start date; "soon" and "overdue" on the page, and once a day by mail in the language of the page.
- Short forms of each kind of event under links of their own, with a QR code, to open on a phone; a draft of every form kept in the browser until it is saved, deleted or cancelled.
- Import of a backup of the Android app Car Expenses: refuels, expenses by pattern, income, odometer readings, reminders from the patterns with a period, the fields of the car, its photo, purchase and sale, and the photos of the expenses; into a car, or a new car for each vehicle of the file; leva converted to euro if asked.
- Export of a car to a JSON file with its events, reminders and, if asked, its receipts and photos, and the import of such a file as a new car or into one, also into another account; the list of events as CSV.
- API keys for programs, read or read and write, and share links that open the cars or one car read only without a sign-in, for a time or for good; each tells where and when it was made and last used, and how often.
- Administrators (Cognito group `admins`) invite and manage the users in Settings → Users, and look at the cars of every user, read only.
- Settings: password, two-factor authentication with an authenticator app, language (English, Russian, French, Italian), mails of the reminders, API keys, share links, users for administrators, version.
- The public demo: the sign-in published and filled in, no mail, the administration read-only, and an hourly reset to the examples of `seed/seed.json`.
