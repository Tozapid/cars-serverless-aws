// Statistics of a car, counted on the page from all its events, as the
// sheets Helpers and Helper-Total of the old Google table did. An event
// marked "excluded" counts for the odometer but not for the money and the
// energy, and only inside the span of the counted events. Costs are refuels, services and expenses; the balance is the costs
// less the income.
(function () {
  const KINDS = ["refuel", "service", "expense", "income"];
  const COSTS = ["refuel", "service", "expense"];
  const DAY = 86400000;

  function month(date) {
    return String(date).slice(0, 7);
  }

  function nextMonth(period) {
    const [year, number] = period.split("-").map(Number);
    return number === 12 ? `${year + 1}-01` : `${year}-${String(number + 1).padStart(2, "0")}`;
  }

  function months(first, last) {
    const list = [];
    for (let period = first; period <= last; period = nextMonth(period)) list.push(period);
    return list;
  }

  // The steps of the charts. A bucket is named by its first day
  // (YYYY-MM-DD; a week by its Monday), its month (YYYY-MM) or its year.
  const STEPS = ["day", "week", "month", "year"];

  function utc(day) {
    return new Date(day + "T12:00:00Z");
  }

  function isoDay(date) {
    return date.toISOString().slice(0, 10);
  }

  function bucket(date, step) {
    const day = String(date).slice(0, 10);
    if (step === "day") return day;
    if (step === "year") return day.slice(0, 4);
    if (step === "week") {
      const value = utc(day);
      value.setUTCDate(value.getUTCDate() - ((value.getUTCDay() + 6) % 7));
      return isoDay(value);
    }
    return day.slice(0, 7);
  }

  function nextBucket(key, step) {
    if (step === "month") return nextMonth(key);
    if (step === "year") return String(Number(key) + 1);
    const value = utc(key);
    value.setUTCDate(value.getUTCDate() + (step === "week" ? 7 : 1));
    return isoDay(value);
  }

  function buckets(first, last, step) {
    const list = [];
    for (let key = first; key <= last; key = nextBucket(key, step)) list.push(key);
    return list;
  }

  // The fuels of a refuel. An event that does not name its fuel gets it
  // from its station's name ("Бутан", "LPG" are gas, "АИ-95" petrol), or
  // from the car's energy: kWh is electric, litres petrol.
  const FUELS = ["petrol", "diesel", "lpg", "cng", "electric"];

  function guessFuel(name, unit) {
    // \b of JavaScript knows Latin letters only: Cyrillic words are bounded
    // by hand.
    const text = " " + String(name || "").toLowerCase() + " ";
    if (/(lpg|gpl|autogas|propane|butane|бутан|пропан|[^а-яё]газ[^а-яё])/.test(text)) return "lpg";
    if (/(cng|methane|метан|[^а-яё]гнв[^а-яё])/.test(text)) return "cng";
    if (/(diesel|gasoil|gazole|дизел|[^а-яё]дт[^а-яё])/.test(text)) return "diesel";
    if (unit === "kWh") return "electric";
    return "petrol";
  }

  function fuelOf(event, unit) {
    return FUELS.includes(event.fuel) ? event.fuel : guessFuel(event.category, unit);
  }

  function days(first, last) {
    return Math.max(1, Math.round((Date.parse(last.slice(0, 10) + "T12:00:00Z") - Date.parse(first.slice(0, 10) + "T12:00:00Z")) / DAY));
  }

  function emptyKinds() {
    return Object.fromEntries(KINDS.map((kind) => [kind, 0]));
  }

  function costOf(values) {
    return COSTS.reduce((sum, kind) => sum + values[kind], 0);
  }

  // The highest odometer of all events by the end of each bucket; a bucket
  // without a reading keeps the one before.
  function odometerBy(events, list, step) {
    const highest = {};
    events.forEach((event) => {
      if (event.odometer == null) return;
      const period = bucket(event.date, step);
      highest[period] = Math.max(highest[period] ?? 0, Number(event.odometer));
    });
    const result = {};
    let running = null;
    list.forEach((period) => {
      if (highest[period] != null) running = Math.max(running ?? 0, highest[period]);
      result[period] = running;
    });
    return result;
  }

  // options.from and options.to (YYYY-MM) narrow the money and the buckets
  // to a period; the odometer of the months before still counts for the
  // distance of the first bucket. options.step: the buckets of the charts,
  // day, week, month (the default) or year.
  function compute(events, options) {
    const from = (options && options.from) || "";
    const to = (options && options.to) || "9999-12";
    const step = STEPS.includes(options && options.step) ? options.step : "month";
    const unit = (options && options.unit) || "kWh";
    const fuels = {};
    const all = events.slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const inPeriod = all.filter((event) => month(event.date) >= from && month(event.date) <= to);
    const counted = inPeriod.filter((event) => !event.excluded);
    const totals = emptyKinds();
    const byMonth = {};
    const categories = Object.fromEntries(KINDS.map((kind) => [kind, {}]));
    const quantities = {};
    let quantity = 0;
    let quantityCost = 0;
    counted.forEach((event) => {
      const amount = Number(event.amount || 0);
      const period = bucket(event.date, step);
      totals[event.kind] += amount;
      if (!byMonth[period]) byMonth[period] = { ...emptyKinds(), quantity: 0, fuels: {} };
      byMonth[period][event.kind] += amount;
      const name = event.category || "";
      categories[event.kind][name] = (categories[event.kind][name] || 0) + amount;
      if (event.kind === "refuel" && event.quantity != null) {
        quantity += Number(event.quantity);
        quantityCost += amount;
        byMonth[period].quantity += Number(event.quantity);
        quantities[name] = (quantities[name] || 0) + Number(event.quantity);
        const fuel = fuelOf(event, unit);
        if (!fuels[fuel]) fuels[fuel] = { fuel, quantity: 0, cost: 0, count: 0 };
        fuels[fuel].quantity += Number(event.quantity);
        fuels[fuel].cost += amount;
        fuels[fuel].count += 1;
        byMonth[period].fuels[fuel] = (byMonth[period].fuels[fuel] || 0) + Number(event.quantity);
      }
    });
    const readings = all.filter((event) => event.odometer != null).map((event) => Number(event.odometer));
    // The span of the period is that of its counted events: an excluded one
    // outside it, such as a repair of a former owner, neither opens the
    // charts earlier nor adds its kilometres; inside it, its odometer counts.
    const first = counted.length ? counted[0].date : null;
    const last = counted.length ? counted[counted.length - 1].date : null;
    const within = first ? inPeriod.filter((event) => event.date >= first && event.date <= last) : [];
    const readingsIn = within.filter((event) => event.odometer != null).map((event) => Number(event.odometer));
    const list = first ? buckets(bucket(first, step), bucket(last, step), step) : [];
    // The distance of the period: from the last reading before it, or from
    // its own first one.
    const before = all.filter((event) => event.odometer != null && month(event.date) < from).map((event) => Number(event.odometer));
    const start = before.length ? Math.max(...before) : readingsIn.length ? Math.min(...readingsIn) : null;
    const end = readingsIn.length ? Math.max(...readingsIn) : null;
    const km = start != null && end != null ? Math.max(0, end - start) : 0;
    const ends = odometerBy(all, list.length ? buckets(bucket(all[0].date, step), list[list.length - 1], step) : [], step);
    let previous = start;
    const series = list.map((period) => {
      const values = byMonth[period] || { ...emptyKinds(), quantity: 0, fuels: {} };
      const odometer = ends[period];
      const driven = odometer != null && previous != null ? Math.max(0, odometer - previous) : 0;
      if (odometer != null) previous = Math.max(previous ?? 0, odometer);
      const cost = costOf(values);
      return {
        period, ...values, cost, balance: cost - values.income, odometer, km: driven,
        // Too few kilometres make a bucket's consumption say nothing.
        consumption: driven >= 100 && values.quantity ? (values.quantity / driven) * 100 : null,
        // The same for each fuel, on the whole distance of the bucket.
        consumptionByFuel: Object.fromEntries(Object.entries(values.fuels).map(([fuel, amount]) => [fuel, driven >= 100 ? (amount / driven) * 100 : null])),
        perKm: driven >= 100 ? cost / driven : null,
      };
    });
    const span = first ? days(first, last) : 0;
    const cost = costOf(totals);
    const balance = cost - totals.income;
    // The table of years counts by month whatever the step: a week may
    // start in the year before.
    const monthly = step === "month" ? series : compute(events, { ...options, step: "month" }).buckets;
    const years = {};
    monthly.forEach((row) => {
      const year = row.period.slice(0, 4);
      if (!years[year]) years[year] = { year, ...emptyKinds(), cost: 0, balance: 0, km: 0, quantity: 0 };
      KINDS.concat(["cost", "balance", "km", "quantity"]).forEach((key) => { years[year][key] += row[key] || 0; });
    });
    return {
      count: counted.length,
      first, last, days: span, totals, cost, balance,
      odometer: readings.length ? Math.max(...readings) : null,
      km,
      kmPerDay: span ? km / span : null,
      quantity,
      pricePerUnit: quantity ? quantityCost / quantity : null,
      consumption: km ? (quantity / km) * 100 : null,
      // Each fuel on the whole distance: the litres of it a hundred
      // kilometres take. Which kilometres went on which fuel is not known,
      // so the fuels together make the consumption above.
      fuels: Object.values(fuels).sort((a, b) => b.quantity - a.quantity).map((item) => ({
        ...item,
        pricePerUnit: item.quantity ? item.cost / item.quantity : null,
        consumption: km ? (item.quantity / km) * 100 : null,
        costPerKm: km ? item.cost / km : null,
      })),
      energyPerKm: km ? totals.refuel / km : null,
      costPerKm: km ? cost / km : null,
      balancePerKm: km ? balance / km : null,
      costPerDay: span ? cost / span : null,
      balancePerDay: span ? balance / span : null,
      // A month of 30 days, as the old table counted.
      costPerMonth: span ? (cost / span) * 30 : null,
      balancePerMonth: span ? (balance / span) * 30 : null,
      step,
      buckets: series,
      years: Object.values(years).sort((a, b) => a.year.localeCompare(b.year)),
      categories,
      quantities,
    };
  }

  // The categories used for a kind (all kinds without one), the most used
  // first: the suggestions of the forms.
  function categoryList(events, kind) {
    const counts = {};
    events.forEach((event) => {
      if ((!kind || event.kind === kind) && event.category) counts[event.category] = (counts[event.category] || 0) + 1;
    });
    return Object.keys(counts).sort((a, b) => counts[b] - counts[a] || a.localeCompare(b));
  }

  // The latest event of a kind (and of a category, if given).
  function latest(events, kind, category) {
    return events.filter((event) => event.kind === kind && (!category || event.category === category))
      .sort((a, b) => String(b.date).localeCompare(String(a.date)))[0] || null;
  }

  // Metres between two places ({lat, lon}), on a sphere.
  function distance(a, b) {
    const rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad;
    const dLon = (b.lon - a.lon) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.sqrt(h));
  }

  // The categories of a kind that were used within radius metres of a place,
  // the nearest first: {category, distance, count}.
  function nearby(events, kind, place, radius) {
    const found = {};
    events.forEach((event) => {
      if (event.kind !== kind || !event.location || !event.category) return;
      const metres = distance(place, event.location);
      if (metres > radius) return;
      const entry = found[event.category] || (found[event.category] = { category: event.category, distance: metres, count: 0 });
      entry.distance = Math.min(entry.distance, metres);
      entry.count += 1;
    });
    return Object.values(found).sort((a, b) => a.distance - b.distance || b.count - a.count);
  }

  function highestOdometer(events) {
    const readings = events.filter((event) => event.odometer != null).map((event) => Number(event.odometer));
    return readings.length ? Math.max(...readings) : null;
  }

  window.CARS_STATS = { KINDS, COSTS, STEPS, FUELS, guessFuel, fuelOf, compute, categoryList, latest, highestOdometer, months, month, bucket, distance, nearby };
})();
