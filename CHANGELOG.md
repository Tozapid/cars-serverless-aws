# Changelog

## v0.4.0

### Changed

- The demo is reset six hours after the first change instead of every hour, and not at all while nobody changes anything: most hours of a demo cost nothing now. The first change through the API (any request but a read that succeeds) makes a one-off schedule `<name>-reset` of EventBridge Scheduler, which calls the reset function `reset_delay_hours` later with the role `<name>-reset-scheduler` and then deletes itself; while it waits, further changes make none. The EventBridge rule of the hourly reset is gone. `reset_schedule` became `reset_delay_hours`, a number of hours (`0`, the default, no reset; `6` in the demo).
- The sign-in page of the demo says when it goes back to the start: six hours after a change.

## v0.3.4

### Removed

- `demo/moved.tf`: the state of the demo already keeps its resources under `module.cars`. A site that still has the resources at the top of its state moves them in its own root module before taking this version.

## v0.3.3

### Added

- Access to a car for another user: Settings → Access — the user's email, the car and "View" or "View and change". They find the car on the Cars tab ("Cars shared with me") and in "Whose cars"; with change they add and edit its events, reminders and drafts, while its settings, imports and deletion stay with the owner. Deleting a car or a user drops their grants.

### Changed

- The repository is a Terraform module: the root makes no providers and no backend (the caller passes `aws` and `aws.global`), and a site is a module call pinned to a release tag, `git::https://github.com/Tozapid/cars-serverless-aws.git?ref=vX.Y.Z`; a newer version of a site is a newer `ref`. The public demo is a call of the module in `demo/`, which the CI deploys (`working_directory: demo`); `demo/moved.tf` moves its resources under `module.cars` in the state. The defaults are those of a production site (`demo = false`, no reset); `name` and `admin_email` have none. New inputs: `ses_identity` (false when the caller manages the SES identity of the domain) and `totp_issuer` (the name in an authenticator app, "Cars demo" in the demo). The region comes from the provider, the tags from its `default_tags`; the zips of the functions are built in `.build/` of the root module. `examples/production.tfvars` became `examples/production/main.tf`.
- The drafts of an event form are kept with the car in the table rather than in the browser: they open in any browser and for everyone with write access to the car (with a note of whose draft it is). Offline a draft waits in the browser and goes later; saving the event deletes it in the table too, also from the offline queue. Old drafts of the browser move to the table when the car opens.
- On an iPhone the page no longer zooms in on a tap into a field: fields on touch screens are 16px (Safari zooms into smaller text), the text size does not change on rotation, and the Export menu and the owner picker stay inside the screen.

### Fixed

- A new form wrote a draft without a single edit — from the place found by geolocation and the category filled in — and after "Discard the draft" it came back. A draft is now written only after an edit by hand.

## v0.3.2

### Added

- An "Add to Home Screen" button on a short form, outside the installed app. A page cannot put itself on the home screen of an iPhone, so on an iPhone the button shows the two steps in Safari; where the browser offers an install prompt (Chrome on Android), the button opens it.

### Changed

- The icon takes the colours of the other projects: a white car on indigo (`#4f46e5`), drawn like their icons, in place of the teal one; `theme-color` and the manifests follow. A phone gets PNGs it can show sharply: `apple-touch-icon.png` (180 × 180, square, iOS rounds it) for the home screen of an iPhone, which takes no SVG, and `icon-192.png` and `icon-512.png` in the manifests for Android.

### Fixed

- A short form added to the home screen of an iPhone still opened the start page after v0.3.1: Safari read the manifest of the page before the page swapped it, and the form was in the `#fragment` of the address. A short form now has an address of its own, `/add/<kind>/<car>/`: the CloudFront function `cloudfront/manifest.js` serves the page there and `/add/<kind>/<car>/manifest.json` beside it, with the form as its `start_url`, and the page links its manifest relatively, so Safari finds the form's at once. Links of the form `/#add/<kind>/<car>` go to the new address. An icon added before this opens the start page; add it again from the form.

## v0.3.1

### Changed

- The car card no longer has the "Links for the phone" block (the links of the short forms with Copy and QR code). The link of a short form stays in the title of the form of a new event.

### Fixed

- A short form (`/#add/<kind>/<car>`) added to the home screen of an iPhone opened the start page: the page linked one manifest for every address, with `start_url` `/`, and Safari takes the address to open from it. A short form now links a manifest of its own, `/manifest/add/<kind>/<car>.json`, made by the CloudFront function `cloudfront/manifest.js` on the default behaviour, whose `start_url` is the form and whose name is the kind and the car. A home screen icon added before this still opens the start page; add it again.
- A preview could not be deployed once the account held ten CloudFront public keys (`TooManyPublicKeys`), a limit that is not raised. A preview (`<name>-pr<N>`) now signs file cookies with the key of the main site, which publishes its ids in the SSM parameter `/<name>/cloudfront-key-ids`; only the main site makes a key. `files_key_from` names another stack to borrow from, or `""` for a key of its own. The main site has to be deployed with this version before the first such preview.
- The API log wrote the path of every request to CloudWatch, the token of a share link (`/api/share/<token>/…`) included. It now names the route (`GET /api/share/*/cars/*/events -> 200`): each word comes from a fixed list, anything else is `*`. CodeQL reported the path as clear-text logging of sensitive data (`py/clear-text-logging-sensitive-data`).

## v0.3.0

### Added

- CloudFront access logs, optional: with `access_logs_bucket` set, the standard logs (v2) of the distribution go to that bucket under `cloudfront/<name>/` as JSON lines, and the S3 server access logs of the files bucket under `s3/`, for an overview of the account such as [account-serverless-aws](https://github.com/Tozapid/account-serverless-aws) to read. The CI passes the repository variable `ACCESS_LOGS_BUCKET`; unset, there are none.

## v0.2.0

### Added

- Work without a network: the page installs on a phone as an app (PWA) and opens with the data last loaded; new events, with their receipts and photos, wait in a queue of the browser and go by themselves when the network is back, and sending one again does not make it twice.

### Changed

- Import and export on the Cars page are two menu buttons next to "Add a car": Import (Car Expenses backup, JSON file) and Export (JSON file, events to CSV), with the car chosen in the window. The buttons on the cards of the cars and "Export CSV" in the list of events are gone.

### Fixed

- The map no longer slides over the top menu when the page scrolls: the layers of Leaflet stay inside a stacking context of their own.
- Dialogs on a phone: the title with × and the buttons hid under the bars of the browser. A dialog is now as high as the visible screen (`100dvh`), with the title and the buttons held in place while the form scrolls between them.

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
