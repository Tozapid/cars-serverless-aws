// Car log: the cars of the user, their charges and refuels, services,
// expenses and income, the statistics of them and the reminders of what is
// due. The page signs in with Cognito and calls /api with the ID token; the
// API is in lambda/app.py. The texts are in i18n.js, the statistics in
// stats.js, the charts in charts.js.
(function () {
  const config = window.CARS_CONFIG || {};
  const i18n = window.CARS_I18N;
  const stats = window.CARS_STATS;
  const charts = window.CARS_CHARTS;
  const root = document.getElementById("root");
  const state = {
    me: null,
    cars: [],
    car: null,
    events: [],
    reminders: [],
    // overview, events, stats, reminders or cars; the address keeps it with
    // the car (#events/<car>).
    view: "overview",
    filter: { kind: "", category: "", year: "", text: "" },
    sort: { key: "date", desc: true },
    // The period of the statistics: "", "12m" or a year.
    period: "12m",
    // The step of the charts of the statistics: day, week, month or year.
    step: "month",
    // The kind of the events on the map, "" for all.
    mapKind: "",
    // The kind of the short form of #add/<kind>/<car>, a page of its own to
    // open on a phone; quickDone is the event it has just saved.
    quick: null,
    quickDone: null,
    // The user whose cars an administrator is viewing (#<view>/<car>/<email>),
    // null for one's own; another user's cars are read only. owners: the
    // users an administrator can pick, with their number of cars.
    owner: null,
    ownerLoaded: null,
    owners: [],
    // The token of a share link (#s/<token>/<view>/<car>): the page shows
    // what it opens, read only, without a sign-in.
    share: null,
    // Without a network: true while the API answers from the cache of the
    // service worker (sw.js), and when that answer was fetched.
    offline: false,
    offlineSince: null,
    // New events saved without a network that wait in the outbox.
    pending: 0,
  };
  const ISSUER = "Cars demo";
  // The open source project of this page, linked from the sign-in page.
  const REPOSITORY = "https://github.com/Tozapid/cars-serverless-aws";
  // The language is the Cognito attribute "locale" of the user; the browser
  // keeps a copy so that the sign-in page speaks it too.
  const LANGUAGE_KEY = "cars-language";
  const CAR_KEY = "cars-car";
  const STEP_KEY = "cars-step";
  // The mark of an exported car, the same on every site of this project; the
  // first one is still read.
  const EXPORT_FORMATS = ["cars-serverless-aws", "cars.jagomann.com"];
  const VIEWS = ["overview", "events", "stats", "map", "reminders", "cars"];
  const KINDS = stats.KINDS;
  // A photo is shrunk to this many pixels on its longer side before the
  // upload; a receipt stays readable.
  const PHOTO_SIZE = 2000;
  const EVENTS_PAGE = 200;
  // How near a past event's place counts for the suggestion of a category.
  const NEAR_METRES = 500;
  let language = i18n.fallback;
  let pool = null;
  let toastTimer = null;
  let listening = false;
  let shown = EVENTS_PAGE;

  // Language ---------------------------------------------------------------

  function known(code) {
    return Boolean(code && i18n.strings[code]);
  }

  // The text of a key in the current language with its {name} parts filled.
  function t(key, params) {
    let text = i18n.strings[language][key] ?? i18n.strings[i18n.fallback][key] ?? key;
    if (typeof text === "object") {
      text = text[new Intl.PluralRules(language).select(params.count)] ?? text.other;
    }
    return text.replace(/\{(\w+)\}/g, (part, name) => (params && name in params ? String(params[name]) : part));
  }

  // A text in the words of the car's energy: "<key>.L" for a car on litres
  // (a refuel, not a charge) when the texts have one, else "<key>".
  function tu(key, params, carUnit) {
    const variant = key + "." + (carUnit || unit());
    return i18n.strings[i18n.fallback][variant] != null ? t(variant, params) : t(key, params);
  }

  function kindName(kind, carUnit) {
    return tu("kind." + kind, null, carUnit);
  }

  function setLanguage(code) {
    if (!known(code)) return;
    language = code;
    document.documentElement.lang = code;
    document.title = t("brand");
    try {
      localStorage.setItem(LANGUAGE_KEY, code);
    } catch (error) {
      // Private windows may refuse storage; the language holds until reload.
    }
  }

  function stored(key) {
    try {
      return localStorage.getItem(key);
    } catch (error) {
      return null;
    }
  }

  function store(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (error) {
      // Without storage the page opens the first car next time.
    }
  }

  function unstore(key) {
    try {
      localStorage.removeItem(key);
    } catch (error) {
      // Nothing was kept then.
    }
  }

  // The first language of the browser this page speaks, else the fallback.
  function browserLanguage() {
    const found = (navigator.languages || [navigator.language]).map((code) => String(code).slice(0, 2)).find(known);
    return found || i18n.fallback;
  }

  async function loadLanguage() {
    try {
      const { user } = await currentUser();
      const attributes = await cognito((done) => user.getUserAttributes(done));
      const locale = (attributes || []).find((attribute) => attribute.getName() === "locale");
      if (locale) setLanguage(locale.getValue());
    } catch (error) {
      // The language of this browser stays.
    }
  }

  async function saveLanguage(code) {
    setLanguage(code);
    try {
      const { user } = await currentUser();
      await cognito((done) => user.updateAttributes([{ Name: "locale", Value: code }], done));
      toast(t("language.saved"));
    } catch (error) {
      toast(authMessage(error));
    }
  }

  // Page helpers -----------------------------------------------------------

  // A text field with its own list of choices instead of a datalist, which
  // the browser narrows to the text already typed: a filled field showed
  // nothing else. The list opens on focus, a click or ▾; a value that is one
  // of the choices shows them all, other text narrows them. A choice is put
  // into the field as typing would, with an input event.
  function combo(field, choices) {
    field.setAttribute("autocomplete", "off");
    field.setAttribute("role", "combobox");
    field.setAttribute("aria-expanded", "false");
    const list = el("ul", { class: "combo-list hidden", role: "listbox" });
    let shown = [];
    let active = -1;
    const fold = (text) => String(text).trim().toLocaleLowerCase();
    const close = () => {
      list.classList.add("hidden");
      field.setAttribute("aria-expanded", "false");
      active = -1;
    };
    const pick = (name) => {
      field.value = name;
      field.dispatchEvent(new Event("input", { bubbles: true }));
      close();
    };
    const mark = () => [...list.children].forEach((node, index) => {
      node.classList.toggle("active", index === active);
      if (index === active) node.scrollIntoView({ block: "nearest" });
    });
    const open = (all) => {
      const typed = fold(field.value);
      const exact = choices.some((name) => fold(name) === typed);
      shown = all || !typed || exact ? choices : choices.filter((name) => fold(name).includes(typed));
      if (!shown.length) return close();
      active = -1;
      fill(list, shown.map((name) => el("li", {
        role: "option",
        class: fold(name) === typed ? "current" : "",
        onmousedown: (event) => {
          event.preventDefault();
          pick(name);
        },
      }, name)));
      list.classList.remove("hidden");
      field.setAttribute("aria-expanded", "true");
    };
    field.addEventListener("focus", () => open());
    field.addEventListener("click", () => open());
    field.addEventListener("input", (event) => { if (event.isTrusted) open(); });
    field.addEventListener("blur", close);
    field.addEventListener("keydown", (event) => {
      const isOpen = !list.classList.contains("hidden");
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (!isOpen) return open(true);
        active = (active + (event.key === "ArrowDown" ? 1 : -1) + shown.length) % shown.length;
        mark();
      } else if (event.key === "Enter" && isOpen && active >= 0) {
        event.preventDefault();
        pick(shown[active]);
      } else if (event.key === "Escape" && isOpen) {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
    });
    const toggle = el("button", {
      type: "button",
      class: "combo-toggle",
      tabindex: "-1",
      "aria-label": t("combo.open"),
      onmousedown: (event) => event.preventDefault(),
      onclick: () => {
        if (list.classList.contains("hidden")) {
          field.focus();
          open(true);
        } else close();
      },
    }, "▾");
    return el("div", { class: "combo" }, [field, choices.length ? toggle : null, list]);
  }

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([key, value]) => {
      if (value == null || value === false) return;
      if (key === "class") node.className = value;
      else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
      else if (key === "value") node.value = value;
      // Through the CSSOM: the CSP of the site blocks style attributes.
      else if (key === "style") node.style.cssText = value;
      else node.setAttribute(key, value === true ? "" : value);
    });
    [].concat(children || []).forEach((child) => {
      if (child == null || child === false) return;
      node.append(child.nodeType ? child : document.createTextNode(String(child)));
    });
    return node;
  }

  // replaceChildren() turns null into the text "null"; empty parts are left out.
  function fill(node, children) {
    node.replaceChildren(...[].concat(children).filter(Boolean));
  }

  function toast(message) {
    let node = document.querySelector(".toast");
    if (!node) {
      node = el("div", { class: "toast", role: "status" });
      document.body.append(node);
    }
    node.textContent = message;
    node.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => node.classList.add("hidden"), 3500);
  }

  // An event's date is local time without a zone (2026-10-05T08:37); it is
  // shown as it was written.
  function local(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(value || "");
    return match ? new Date(Date.UTC(+match[1], +match[2] - 1, +match[3], +(match[4] || 12), +(match[5] || 0))) : null;
  }

  function dateText(value, withTime) {
    const date = local(value);
    if (!date) return value || "";
    return date.toLocaleString(language, withTime ? { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" } : { dateStyle: "medium", timeZone: "UTC" });
  }

  function when(value) {
    if (!value) return "";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString(language, { dateStyle: "short", timeStyle: "short" });
  }

  // The name of a bucket of a chart (stats.js): a day, the week from its
  // Monday, a month or a year.
  function bucketName(key, step, short) {
    if (step === "year") return key;
    if (step === "month") return monthName(key, short);
    const date = new Date(key + "T12:00:00Z");
    const text = date.toLocaleDateString(language, short ? { day: "numeric", month: "short", timeZone: "UTC" }
      : { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
    return step === "week" && !short ? t("stats.weekOf", { date: text }) : text;
  }

  function monthName(period, short) {
    const date = new Date(period + "-15T12:00:00Z");
    return Number.isNaN(date.getTime()) ? period
      : date.toLocaleDateString(language, short ? { month: "short", year: "2-digit", timeZone: "UTC" } : { month: "long", year: "numeric", timeZone: "UTC" });
  }

  function currency() {
    return (state.car && state.car.currency) || "EUR";
  }

  function money(value, unit) {
    const amount = Number(value || 0);
    try {
      return new Intl.NumberFormat(language, { style: "currency", currency: unit || currency(), maximumFractionDigits: 2 }).format(amount);
    } catch (error) {
      return amount.toFixed(2) + " " + (unit || currency());
    }
  }

  // A price of a kilometre or of a kWh needs more places than a sum.
  function price(value) {
    if (value == null) return "—";
    try {
      return new Intl.NumberFormat(language, { style: "currency", currency: currency(), minimumFractionDigits: 3, maximumFractionDigits: 3 }).format(value);
    } catch (error) {
      return Number(value).toFixed(3) + " " + currency();
    }
  }

  function number(value, digits) {
    if (value == null) return "—";
    return new Intl.NumberFormat(language, { maximumFractionDigits: digits ?? 0 }).format(value);
  }

  function metres(value) {
    return value >= 1000 ? t("unit.km", { value: number(value / 1000, 1) }) : t("unit.m", { value: number(Math.round(value)) });
  }

  function km(value) {
    return value == null ? "—" : t("unit.km", { value: number(Math.round(value)) });
  }

  function unit() {
    return (state.car && state.car.unit) || "kWh";
  }

  function nowLocal() {
    const now = new Date();
    return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  }

  // A modal window over the page. The page below may re-render; the dialog
  // stays and fill() replaces its contents.
  function dialog(title, onClose) {
    const body = el("div", { class: "modal-body" });
    const heading = el("h2", {}, title);
    const node = el("dialog", { class: "modal" }, [
      el("div", { class: "modal-head" }, [
        heading,
        el("button", { type: "button", class: "icon-button close", "aria-label": t("close"), onclick: () => node.close() }, "×"),
      ]),
      body,
    ]);
    node.addEventListener("close", () => {
      node.remove();
      if (onClose) onClose();
    });
    node.addEventListener("click", (event) => {
      if (event.target === node) node.close();
    });
    document.body.append(node);
    node.showModal();
    return {
      node,
      close: () => node.close(),
      title: (text) => { heading.textContent = text; },
      fill: (children) => fill(body, children),
    };
  }

  // A photo that opens large over the page on a click: the whole picture,
  // as big as the window lets it.
  function showPhoto(src, title) {
    const box = dialog(title);
    box.node.classList.add("lightbox");
    box.fill(el("img", { class: "lightbox-image", src, alt: title }));
  }

  function photoButton(className, src, title, lazy) {
    return el("button", { type: "button", class: "photo-open", title: t("photo.open"), "aria-label": t("photo.open"), onclick: () => showPhoto(src, title) },
      el("img", { class: className, src, alt: "", loading: lazy ? "lazy" : null }));
  }

  function facts(pairs) {
    return el("dl", { class: "facts" }, pairs.filter((pair) => pair && pair[1] !== "" && pair[1] != null)
      .flatMap(([label, value]) => [el("dt", {}, label), el("dd", {}, value)]));
  }

  // Kind is never colour alone: the badge says it in words.
  function kindBadge(kind) {
    return el("span", { class: "badge kind-" + kind }, kindName(kind));
  }

  function stateBadge(status) {
    const tone = { overdue: "bad", soon: "warn", ok: "ok", never: "" }[status.state];
    return el("span", { class: "badge " + tone }, t("reminder.state." + status.state));
  }

  // Sign-in ----------------------------------------------------------------

  function userPool() {
    if (!pool) {
      pool = new window.AmazonCognitoIdentity.CognitoUserPool({ UserPoolId: config.userPoolId, ClientId: config.clientId });
    }
    return pool;
  }

  // The signed-in user with a valid session, which the account calls need.
  function currentUser() {
    return new Promise((resolve, reject) => {
      const user = userPool().getCurrentUser();
      if (!user) return reject(new Error("auth"));
      user.getSession((error, session) => {
        if (error || !session || !session.isValid()) reject(error || new Error("auth"));
        else resolve({ user, session });
      });
    });
  }

  async function currentSession() {
    return (await currentUser()).session;
  }

  // Wraps a callback-style call of the Cognito library.
  function cognito(call) {
    return new Promise((resolve, reject) => call((error, result) => (error ? reject(error) : resolve(result))));
  }

  function authMessage(error) {
    const code = error && (error.code || error.name);
    if (code === "NotAuthorizedException" || code === "UserNotFoundException") return t("auth.wrong");
    if (code === "InvalidPasswordException") return t("auth.passwordRules");
    if (code === "CodeMismatchException" || code === "EnableSoftwareTokenMFAException") return t("auth.wrongCode");
    if (code === "ExpiredCodeException") return t("auth.expiredCode");
    if (code === "LimitExceededException" || code === "TooManyRequestsException") return t("auth.tooMany");
    return (error && error.message) || t("failed");
  }

  function loginCard(children, onsubmit) {
    root.replaceChildren(el("main", { class: "login" }, el("form", {
      class: "login-card",
      onsubmit: (event) => {
        event.preventDefault();
        onsubmit();
      },
    }, children)));
  }

  function signInCallbacks(user, error) {
    return {
      onSuccess: () => boot(),
      onFailure: (failure) => { error.textContent = authMessage(failure); },
      newPasswordRequired: () => showNewPassword(user),
      totpRequired: () => showTotp(user),
    };
  }

  // The language menu of the sign-in page and of the settings.
  function languagePicker(onchange) {
    return el("select", { class: "lang-select", "aria-label": t("language.title"), onchange: (event) => onchange(event.target.value) },
      i18n.languages.map(([code, name]) => el("option", { value: code, selected: code === language }, name)));
  }

  // In the public demo (config.demo) the sign-in is shown and filled in.
  function showLogin(message) {
    const demo = config.demo || {};
    const error = el("p", { class: "error", role: "alert" }, message || "");
    const email = el("input", { type: "email", autocomplete: "username", required: true, value: demo.email || "" });
    const password = el("input", { type: "password", autocomplete: "current-password", required: true, value: demo.password || "" });
    loginCard([
      el("img", { class: "login-mark", src: "/favicon.svg", alt: "" }),
      el("h1", {}, t("brand")),
      demo.email ? el("p", { class: "demo-note" }, [
        t("demo.signIn", { email: demo.email, password: demo.password }),
        demo.reset ? " " + t("demo.reset") : "",
      ]) : null,
      el("label", {}, [t("login.email"), email]),
      el("label", {}, [t("login.password"), password]),
      el("button", { class: "primary", type: "submit" }, t("login.signIn")),
      error,
      el("div", { class: "login-lang" }, [
        REPOSITORY ? el("a", { href: REPOSITORY, rel: "noopener" }, t("login.source")) : null,
        languagePicker((code) => {
          setLanguage(code);
          showLogin();
        }),
      ]),
    ], () => {
      error.textContent = "";
      const user = new window.AmazonCognitoIdentity.CognitoUser({ Username: email.value.trim(), Pool: userPool() });
      user.authenticateUser(new window.AmazonCognitoIdentity.AuthenticationDetails({
        Username: email.value.trim(),
        Password: password.value,
      }), signInCallbacks(user, error));
    });
    email.focus();
  }

  function showNewPassword(user) {
    const error = el("p", { class: "error", role: "alert" });
    const password = el("input", { type: "password", autocomplete: "new-password", required: true, minlength: "12" });
    loginCard([
      el("h1", {}, t("newPassword.title")),
      el("p", { class: "lede" }, t("newPassword.hint")),
      el("label", {}, [t("password.new"), password]),
      el("button", { class: "primary", type: "submit" }, t("newPassword.submit")),
      error,
    ], () => user.completeNewPasswordChallenge(password.value, {}, signInCallbacks(user, error)));
    password.focus();
  }

  // The second step when two-factor sign-in is on: the code of the
  // authenticator app.
  function showTotp(user) {
    const error = el("p", { class: "error", role: "alert" });
    const code = el("input", { type: "text", inputmode: "numeric", autocomplete: "one-time-code", pattern: "[0-9]{6}", maxlength: "6", required: true });
    loginCard([
      el("h1", {}, t("totp.title")),
      el("p", { class: "lede" }, t("totp.hint")),
      el("label", {}, [t("totp.code"), code]),
      el("button", { class: "primary", type: "submit" }, t("login.signIn")),
      error,
    ], () => {
      error.textContent = "";
      user.sendMFACode(code.value.trim(), signInCallbacks(user, error), "SOFTWARE_TOKEN_MFA");
    });
    code.focus();
  }

  // forget: signed out by hand. The cache of what the page read and the
  // events that wait go too; an ended session keeps them for the next
  // sign-in.
  async function signOut(forget) {
    if (forget === true) {
      if (state.pending && !window.confirm(t("offline.signOutConfirm", { count: state.pending }))) return;
      await outboxClear();
      state.pending = 0;
      if (window.caches) await caches.delete("cars-data-v1").catch(() => {});
      navigator.serviceWorker?.controller?.postMessage("forget");
    }
    const user = pool && pool.getCurrentUser();
    if (user) user.signOut();
    document.querySelectorAll("dialog.modal").forEach((node) => node.close());
    document.querySelector(".dialog-wrap")?.remove();
    showLogin();
  }

  // Another user's cars, or the cars of a share link: read only.
  function readOnly() {
    return Boolean(state.owner || state.share);
  }

  // A form of another user's car shows its values only: the fields are
  // disabled and the buttons go, but the one marked data-keep.
  function lock(form) {
    form.querySelectorAll("input, textarea, select").forEach((node) => { node.disabled = true; });
    form.querySelectorAll("button:not([data-keep])").forEach((node) => node.remove());
  }

  // options.own: the signed-in user's own data even while an administrator
  // views another user's cars.
  async function api(path, options) {
    if (state.share) return shareApi(path);
    if (state.owner && !(options && options.own) && /^\/cars(\/|$)/.test(path)) path += (path.includes("?") ? "&" : "?") + "owner=" + encodeURIComponent(state.owner);
    const method = (options && options.method) || "GET";
    let session = null;
    try {
      session = await currentSession();
    } catch (error) {
      // Without a network an expired token cannot be renewed: the page still
      // reads what the service worker kept, and queues new events.
      if (!looksOffline(error)) {
        showLogin(t("sessionEnded"));
        throw new Error(t("sessionEnded"));
      }
      if (method !== "GET") throw offlineError();
    }
    let response;
    try {
      response = await fetch(config.apiBase + path, {
        method,
        headers: {
          ...(session ? { Authorization: "Bearer " + session.getIdToken().getJwtToken() } : {}),
          ...(options && options.body ? { "Content-Type": "application/json" } : {}),
        },
        body: options && options.body ? JSON.stringify(options.body) : undefined,
      });
    } catch (error) {
      setOffline(true);
      throw offlineError();
    }
    if (response.headers.get("x-offline")) setOffline(true, response.headers.get("x-fetched"));
    else if (response.status !== 503) setOffline(false);
    return answer(response);
  }

  // Offline -----------------------------------------------------------------

  function offlineError() {
    return Object.assign(new Error(t("api.offline")), { offline: true });
  }

  function looksOffline(error) {
    return navigator.onLine === false || /network|fetch|offline/i.test(String((error && (error.code || error.name || error.message)) || ""));
  }

  function setOffline(offline, since) {
    const changed = state.offline !== offline;
    state.offline = offline;
    if (offline && since) state.offlineSince = since;
    if (!offline) state.offlineSince = null;
    if (changed) drawNetwork();
    if (!offline && changed) flushOutbox();
  }

  // The line under the header that tells of a missing network and of the
  // events that wait to be sent.
  function networkNote() {
    if (!state.offline && !state.pending) return null;
    return el("p", { class: "offline-note", role: "status" }, [
      state.offline ? (state.offlineSince ? t("offline.since", { date: when(state.offlineSince) }) : t("offline.now")) : null,
      state.pending ? el("span", {}, t("offline.pending", { count: state.pending })) : null,
    ]);
  }

  function drawNetwork() {
    const note = document.querySelector(".offline-note");
    const fresh = networkNote();
    if (note && fresh) note.replaceWith(fresh);
    else if (note) note.remove();
    else if (fresh) document.querySelector("main.content")?.prepend(fresh);
  }

  // The outbox: new events saved without a network, in IndexedDB with the
  // files picked for them, until the API has them. Each event has its id
  // from the page, so one sent twice goes in once.
  const OUTBOX = "outbox";
  let database = null;

  function outboxDb() {
    if (!database) {
      database = new Promise((resolve, reject) => {
        const opening = indexedDB.open("cars-offline", 1);
        opening.onupgradeneeded = () => opening.result.createObjectStore(OUTBOX, { keyPath: "id" });
        opening.onsuccess = () => resolve(opening.result);
        opening.onerror = () => reject(opening.error);
      });
    }
    return database;
  }

  async function outbox(mode, work) {
    const db = await outboxDb();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(OUTBOX, mode);
      const request = work(transaction.objectStore(OUTBOX));
      transaction.oncomplete = () => resolve(request && request.result);
      transaction.onerror = () => reject(transaction.error);
    });
  }

  const outboxAll = () => outbox("readonly", (store) => store.getAll()).catch(() => []);
  const outboxPut = (item) => outbox("readwrite", (store) => store.put(item));
  const outboxDelete = (id) => outbox("readwrite", (store) => store.delete(id));
  const outboxClear = () => outbox("readwrite", (store) => store.clear()).catch(() => {});

  async function mine() {
    return (await outboxAll()).filter((item) => state.me && item.owner === state.me.email);
  }

  async function countPending() {
    state.pending = (await mine()).length;
    drawNetwork();
  }

  function newEventId() {
    return [...crypto.getRandomValues(new Uint8Array(8))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  // An event of the outbox as the page shows it until it is sent.
  function pendingEvent(item) {
    return { ...item.body, id: item.id, car: item.car, files: [], pending: true, error: item.error || "" };
  }

  async function queueEvent(car, body, files) {
    const item = { id: body.id, car, owner: state.me.email, body, files, created: new Date().toISOString() };
    await outboxPut(item);
    await countPending();
    return pendingEvent(item);
  }

  // Sends what waits, oldest first, while the network lasts: its files
  // first, then the event. An event the API refuses stays, with the error.
  let flushing = false;

  async function flushOutbox() {
    if (flushing || state.share || !state.me || navigator.onLine === false) return;
    flushing = true;
    let sent = 0;
    try {
      const items = (await mine()).sort((a, b) => a.created.localeCompare(b.created));
      for (const item of items) {
        try {
          const uploaded = [];
          for (const file of item.files || []) uploaded.push(await uploadFile(new File([file.blob], file.name, { type: file.type })));
          const saved = await api(`/cars/${item.car}/events`, { method: "POST", body: { ...item.body, files: [...(item.body.files || []), ...uploaded] } });
          await outboxDelete(item.id);
          sent += 1;
          if (state.car && state.car.id === item.car && state.events) {
            state.events = state.events.filter((event) => event.id !== saved.id).concat([saved]);
          }
        } catch (failure) {
          if (failure.offline) break;
          await outboxPut({ ...item, error: failure.message });
        }
      }
    } finally {
      flushing = false;
      await countPending();
    }
    if (sent) {
      toast(t("offline.sent", { count: sent }));
      if (state.car) await reloadReminders();
      await loadCars().catch(() => {});
      render();
    }
  }

  // Asks again whenever the network may be back.
  window.addEventListener("online", () => flushOutbox());
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") flushOutbox(); });
  setInterval(() => { if (state.pending) flushOutbox(); }, 30000);

  // A share link reads without a sign-in, through /api/share/<token>.
  async function shareApi(path) {
    if (path !== "" && !/^\/cars(\/|$)/.test(path)) throw new Error(t("api.read_only"));
    const response = await fetch(config.apiBase + "/share/" + encodeURIComponent(state.share) + path);
    if (response.status === 404 && path === "") {
      throw Object.assign(new Error(t("api.share_not_found")), { code: "share_not_found" });
    }
    return answer(response);
  }

  async function answer(response) {
    let data = {};
    const text = await response.text();
    if (text) {
      try { data = JSON.parse(text); } catch (error) { data = { error: text }; }
    }
    if (response.status === 401 && !state.share) {
      signOut();
      throw new Error(t("sessionEnded"));
    }
    if (response.status === 503 && data.code === "offline") throw offlineError();
    if (!response.ok) {
      // The API names the error with a code; its own text is the English one.
      const translated = data.code && i18n.strings[i18n.fallback]["api." + data.code];
      const message = translated ? t("api." + data.code) : data.error || t("requestFailed");
      const field = data.detail && i18n.strings[i18n.fallback]["field." + data.detail] ? t("field." + data.detail) : data.detail;
      throw new Error(field ? message + ": " + field : message);
    }
    return data;
  }

  // Navigation -------------------------------------------------------------
  // The address keeps the view and the car: #events/<car>.

  // The parts of the address after the share link's #s/<token>/, if any.
  function hashParts() {
    const parts = location.hash.replace(/^#/, "").split("/");
    return parts[0] === "s" ? parts.slice(2) : parts;
  }

  function sharePrefix() {
    return state.share ? "s/" + state.share + "/" : "";
  }

  // The user of #<view>/<car>/<email>, for an administrator only.
  function hashOwner() {
    const parts = hashParts();
    if (parts[0] === "add" || !parts[2] || !state.me.admin || state.share) return null;
    const email = decodeURIComponent(parts[2]).toLowerCase();
    return email === state.me.email ? null : email;
  }

  function readHash() {
    const parts = hashParts();
    state.quick = parts[0] === "add" && KINDS.includes(parts[1]) ? parts[1] : null;
    state.quickDone = null;
    const view = parts[0];
    const car = state.quick ? parts[2] : parts[1];
    state.view = VIEWS.includes(view) ? view : "overview";
    const found = state.cars.find((item) => item.id === car)
      || state.cars.find((item) => item.id === (state.car && state.car.id))
      || state.cars.find((item) => item.id === stored(CAR_KEY))
      || state.cars.find((item) => !item.sold) || state.cars[0] || null;
    return found;
  }

  function go(view, car) {
    const id = car || (state.car && state.car.id);
    const hash = "#" + sharePrefix() + view + (id || state.owner ? "/" + (id || "") : "") + (state.owner ? "/" + encodeURIComponent(state.owner) : "");
    if (location.hash === hash) show();
    else location.hash = hash;
  }

  // The cars of another user: an administrator picks the user, the address
  // keeps it.
  function viewOwner(email) {
    const owner = email && email !== state.me.email ? email : null;
    location.hash = "#" + (state.view === "cars" ? "cars" : "overview") + (owner ? "//" + encodeURIComponent(owner) : "");
  }

  async function show() {
    state.owner = hashOwner();
    if (state.owner !== state.ownerLoaded) {
      state.ownerLoaded = state.owner;
      state.car = null;
      state.cars = [];
      try {
        await loadCars();
      } catch (error) {
        toast(error.message);
      }
    }
    const car = readHash();
    if (!car) {
      state.car = null;
      state.events = [];
      state.reminders = [];
      if (state.view !== "cars") state.view = "overview";
      render();
      return;
    }
    if (!state.car || state.car.id !== car.id) {
      state.car = car;
      state.events = null;
      state.reminders = [];
      state.filter = { kind: "", category: "", year: "", text: "" };
      shown = EVENTS_PAGE;
      if (!state.owner) store(CAR_KEY, car.id);
      render();
      await loadCar();
    }
    render();
  }

  async function loadCar() {
    const id = state.car.id;
    try {
      const [events, reminders] = await Promise.all([api(`/cars/${id}/events`), api(`/cars/${id}/reminders`)]);
      if (!state.car || state.car.id !== id) return;
      const waiting = (await mine()).filter((item) => item.car === id).map(pendingEvent);
      state.events = (events.items || []).filter((event) => !waiting.some((item) => item.id === event.id)).concat(waiting);
      state.reminders = reminders.items || [];
    } catch (error) {
      state.events = state.events || [];
      toast(error.message);
    }
  }

  // The reminders count from the events, so they are read again after a change.
  async function reloadReminders() {
    try {
      state.reminders = (await api(`/cars/${state.car.id}/reminders`)).items || [];
    } catch (error) {
      toast(error.message);
    }
  }

  async function loadCars() {
    state.cars = (await api("/cars")).items || [];
    if (state.car) state.car = state.cars.find((item) => item.id === state.car.id) || null;
  }

  // Page -------------------------------------------------------------------

  function render() {
    // The form that takes a paste registers itself again.
    pasteInto(null);
    if (state.quick) {
      root.replaceChildren(el("div", { class: "app quick-app" }, [
        el("header", { class: "top" }, [
          el("div", { class: "brand" }, [el("img", { class: "brand-mark", src: "/favicon.svg", alt: "" }), el("strong", {}, t("brand")),
            state.car ? el("span", {}, state.car.name) : null]),
          el("a", { class: "ghost", href: "#overview" + (state.car ? "/" + state.car.id : "") }, t("quick.journal")),
        ]),
        el("main", { class: "content" }, [networkNote(), !state.car ? welcomeView() : state.events === null ? loading() : quickView()]),
      ]));
      return;
    }
    const nav = el("nav", { class: "seg views", "aria-label": t("nav.label") }, VIEWS.map((view) => el("button", {
      type: "button",
      class: view === state.view ? "active" : "",
      "aria-current": view === state.view ? "page" : null,
      onclick: () => go(view),
    }, t("nav." + view))));
    const picker = state.cars.length > 1 ? el("select", {
      class: "car-select",
      "aria-label": t("cars.pick"),
      onchange: (event) => go(state.view, event.target.value),
    }, state.cars.map((car) => el("option", { value: car.id, selected: state.car && car.id === state.car.id }, car.name + (car.sold ? " · " + t("car.soldShort") : "")))) : null;
    const ownerPicker = state.me.admin && state.owners.length > 1 ? el("select", {
      class: "owner-select",
      "aria-label": t("owner.pick"),
      onchange: (event) => viewOwner(event.target.value),
    }, state.owners.slice().sort((a, b) => (b.email === state.me.email) - (a.email === state.me.email)).map((item) => el("option", { value: item.email, selected: item.email === (state.owner || state.me.email) },
      (item.email === state.me.email ? t("owner.mine") : item.email) + " (" + item.cars + ")"))) : null;
    let body;
    if (state.view === "cars") body = carsView();
    else if (!state.car) body = welcomeView();
    else if (state.events === null) body = loading();
    else if (state.view === "events") body = eventsView();
    else if (state.view === "stats") body = statsView();
    else if (state.view === "map") body = mapView();
    else if (state.view === "reminders") body = remindersView();
    else body = overviewView();
    root.replaceChildren(el("div", { class: "app" }, [
      el("header", { class: "top" }, [
        el("div", { class: "brand" }, [el("img", { class: "brand-mark", src: "/favicon.svg", alt: "" }), el("strong", {}, t("brand")),
          state.car && !picker ? el("span", {}, state.car.name) : null]),
        ownerPicker,
        picker,
        nav,
        state.share ? el("div", { class: "who" }, languagePicker((code) => {
          setLanguage(code);
          render();
        })) : el("div", { class: "who" }, [
          el("span", { class: "who-email", title: state.me.email }, state.me.email),
          el("button", { type: "button", class: "icon-button", onclick: () => showAccount() }, t("menu.account")),
          el("button", { type: "button", class: "icon-button", onclick: () => signOut(true) }, t("menu.signOut")),
        ]),
      ]),
      el("main", { class: "content" }, [
        networkNote(),
        state.share ? el("p", { class: "owner-note" }, [
          state.me.share.name ? t("share.viewingNamed", { name: state.me.share.name }) : t("share.viewing"),
          state.me.share.expires ? el("span", { class: "muted small" }, t("share.until", { date: when(state.me.share.expires) })) : null,
        ]) : state.owner ? el("p", { class: "owner-note" }, [
          t("owner.viewing", { email: state.owner }),
          el("button", { type: "button", class: "ghost", onclick: () => viewOwner(null) }, t("owner.back")),
        ]) : null,
        ...[].concat(body),
      ]),
    ]));
  }

  // Short forms ---------------------------------------------------------------

  // The form of one kind of event alone on the page, for a phone; after a
  // save it offers the next one.
  function quickView() {
    const kind = state.quick;
    if (state.quickDone) {
      const item = state.quickDone;
      return section(t("quick.saved"), [
        el("p", {}, [kindBadge(item.kind), " ", [dateText(item.date, true), item.category, item.amount != null ? money(item.amount) : null].filter(Boolean).join(" · ")]),
        el("div", { class: "actions" }, [
          el("button", { type: "button", class: "primary", onclick: () => { state.quickDone = null; render(); } }, t("quick.another")),
          el("a", { class: "ghost", href: "#overview/" + state.car.id }, t("quick.journal")),
        ]),
      ]);
    }
    const body = el("div", { class: "modal-body" });
    const host = { node: body, fill: (children) => fill(body, children), close: (saved) => { state.quickDone = saved || null; }, title: () => {} };
    editEvent({ kind }, host);
    return el("section", { class: "panel quick" }, [el("h1", {}, tu("event.new." + kind)), el("p", { class: "muted" }, state.car.name), body]);
  }

  function quickLink(kind, car) {
    return location.origin + "/#add/" + kind + "/" + car.id;
  }

  // The addresses of the short forms of a car, to copy or to scan.
  function quickLinks(car) {
    return el("details", { class: "quick-links" }, [
      el("summary", {}, t("quick.links")),
      el("p", { class: "hint" }, t("quick.linksHint")),
      el("ul", {}, KINDS.map((kind) => {
        const link = quickLink(kind, car);
        const label = t("add." + kind + "." + (kind === "refuel" ? (car.unit === "L" ? "L" : "kWh") : "any"));
        return el("li", {}, [
          el("a", { href: link }, [linkIcon(), " ", label]),
          el("button", {
            type: "button",
            class: "ghost",
            onclick: async () => {
              try {
                await navigator.clipboard.writeText(link);
                toast(t("quick.copied"));
              } catch (error) {
                window.prompt(t("quick.copy"), link);
              }
            },
          }, t("quick.copy")),
          el("button", {
            type: "button",
            class: "ghost",
            onclick: () => {
              const qr = window.qrcode(0, "M");
              qr.addData(link);
              qr.make();
              const box = dialog(label + " · " + car.name);
              box.fill([el("img", { class: "qr", src: qr.createDataURL(6, 2), alt: link }), el("p", { class: "mono small" }, link)]);
            },
          }, t("quick.qr")),
        ]);
      })),
    ]);
  }

  function loading() {
    return el("p", { class: "muted" }, t("loading"));
  }

  function tile(label, value, sub, tone) {
    return el("div", { class: "tile" + (tone ? " " + tone : "") }, [
      el("span", { class: "tile-label" }, label),
      el("strong", { class: "tile-value" }, value),
      sub ? el("span", { class: "tile-sub" }, sub) : null,
    ]);
  }

  // A tile with an (i) after its label: what the number is and how
  // stats.js counts it (the text "info.<key>").
  function infoTile(key, ...args) {
    const node = tile(...args);
    node.querySelector(".tile-label").append(infoButton(tu("info." + key)));
    return node;
  }

  // One tooltip for the whole page, put next to the (i) it explains: on
  // hover and focus, and on a tap for a phone.
  let infoTip = null;

  function infoButton(text) {
    const button = el("button", { type: "button", class: "info", "aria-label": text }, "i");
    const show = () => {
      if (!infoTip) {
        infoTip = el("div", { class: "info-tip hidden", role: "tooltip" });
        document.body.append(infoTip);
      }
      infoTip.textContent = text;
      infoTip.classList.remove("hidden");
      const box = button.getBoundingClientRect();
      const width = infoTip.offsetWidth;
      const left = Math.min(Math.max(8, box.left + box.width / 2 - width / 2), document.documentElement.clientWidth - width - 8);
      const below = box.bottom + 8 + infoTip.offsetHeight < window.innerHeight;
      infoTip.style.left = left + window.scrollX + "px";
      infoTip.style.top = (below ? box.bottom + 8 : box.top - 8 - infoTip.offsetHeight) + window.scrollY + "px";
      infoTip.owner = button;
    };
    const hide = () => {
      if (infoTip && infoTip.owner === button) infoTip.classList.add("hidden");
    };
    button.addEventListener("mouseenter", show);
    button.addEventListener("focus", show);
    button.addEventListener("mouseleave", hide);
    button.addEventListener("blur", hide);
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      if (infoTip && !infoTip.classList.contains("hidden") && infoTip.owner === button) hide();
      else show();
    });
    return button;
  }

  function section(title, children, actions) {
    return el("section", { class: "panel" }, [
      el("div", { class: "panel-head" }, [el("h2", {}, title), actions || null]),
      ...[].concat(children),
    ]);
  }

  // The amounts of a map as rows with a bar of their share, biggest first.
  function shareTable(values, format) {
    const rows = Object.entries(values || {}).map(([key, value]) => [key, Number(value)]).filter(([, value]) => value)
      .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
    const total = rows.reduce((all, [, value]) => all + Math.max(0, value), 0);
    if (!rows.length) return el("p", { class: "muted" }, t("none"));
    return el("table", { class: "data" }, el("tbody", {}, rows.slice(0, 20).map(([key, value]) => el("tr", {}, [
      el("td", { class: "name" }, key || t("category.none")),
      el("td", { class: "share" }, el("span", { class: "share-bar", style: `width:${total > 0 ? Math.max(0, (value / total) * 100) : 0}%` })),
      el("td", { class: "percent muted" }, total > 0 && value > 0 ? number((value / total) * 100, 1) + " %" : ""),
      el("td", { class: "amount" }, format(value)),
    ]))));
  }

  function addButtons() {
    if (readOnly()) return null;
    return el("div", { class: "add-buttons" }, KINDS.map((kind) => el("button", {
      type: "button",
      class: kind === "refuel" ? "primary" : "ghost",
      onclick: () => editEvent({ kind }),
    }, t("add." + kind + "." + (kind === "refuel" ? unit() : "any")))));
  }

  function linkIcon() {
    const ns = "http://www.w3.org/2000/svg";
    const icon = document.createElementNS(ns, "svg");
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("width", "16");
    icon.setAttribute("height", "16");
    icon.setAttribute("aria-hidden", "true");
    ["M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7", "M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"].forEach((d) => {
      const path = document.createElementNS(ns, "path");
      path.setAttribute("d", d);
      icon.append(path);
    });
    return icon;
  }

  // Welcome: no car yet --------------------------------------------------------

  function welcomeView() {
    if (readOnly()) return section(t("owner.noCars"), el("p", { class: "muted" }, t("owner.noCarsText", { email: state.owner })));
    return section(t("welcome.title"), [
      el("p", {}, t("welcome.text")),
      el("div", { class: "actions" }, [
        el("button", { type: "button", class: "primary", onclick: () => editCar(null) }, t("cars.add")),
      ]),
      el("p", { class: "hint" }, t("welcome.import")),
    ]);
  }

  // Overview ----------------------------------------------------------------

  function carLine(car) {
    return [car.make, car.model, car.year, car.plate].filter(Boolean).join(" · ");
  }

  function overviewView() {
    const car = state.car;
    const all = stats.compute(state.events, { unit: unit() });
    const year = stats.compute(state.events, { from: lastMonths(12)[0], unit: unit() });
    const due = state.reminders.filter((item) => item.status.state === "overdue" || item.status.state === "soon");
    const recent = state.events.slice().sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 8);
    return [
      el("div", { class: "car-head" }, [
        el("div", { class: "car-title" }, [
          car.photo ? photoButton("car-thumb", car.photo.path, car.name) : null,
          el("div", {}, [el("h1", {}, car.name), el("p", { class: "muted" }, [carLine(car), car.vin ? el("span", { class: "mono" }, " · " + car.vin) : null])]),
        ]),
        addButtons(),
      ]),
      el("div", { class: "tiles" }, [
        infoTile("odometer", t("tile.odometer"), km(all.odometer), all.last ? t("tile.lastEvent", { date: dateText(all.last) }) : null),
        infoTile("driven", t("tile.driven"), km(all.km), all.kmPerDay != null ? t("tile.perDay", { value: km(all.kmPerDay) }) : null),
        infoTile("cost", t("tile.cost"), money(all.cost), t("tile.balance", { value: money(all.balance) })),
        infoTile("perKm", t("tile.perKm"), price(all.costPerKm), t("tile.perKmBalance", { value: price(all.balancePerKm) })),
        ...(all.fuels.length > 1 ? fuelTiles(all.fuels) : [infoTile("consumption." + unit(), t("tile.consumption." + unit()), all.consumption != null ? number(all.consumption, 1) : "—",
          all.pricePerUnit != null ? t("tile.pricePerUnit." + unit(), { value: price(all.pricePerUnit) }) : null)]),
        infoTile("energyPerKm", tu("tile.energyPerKm"), price(all.energyPerKm), t("tile.energyTotal", { value: money(all.totals.refuel) })),
      ]),
      due.length ? section(t("overview.due"), el("ul", { class: "reminders" }, due.map(reminderRow)),
        el("button", { type: "button", class: "ghost", onclick: () => go("reminders") }, t("overview.allReminders"))) : null,
      section(t("overview.year"), [costChart(year.buckets, year.step), el("div", { class: "tiles compact" }, [
        infoTile("cost", t("tile.cost"), money(year.cost)),
        infoTile("driven", t("tile.driven"), km(year.km)),
        infoTile("perMonth", t("tile.perMonth"), money(year.costPerMonth)),
      ])], el("button", { type: "button", class: "ghost", onclick: () => go("stats") }, t("overview.allStats"))),
      section(t("overview.recent"), recent.length ? eventTable(recent, false) : el("p", { class: "muted" }, t("events.none")),
        el("button", { type: "button", class: "ghost", onclick: () => go("events") }, t("overview.allEvents"))),
    ];
  }

  // The last count months, oldest first, this month included.
  function lastMonths(count) {
    const now = new Date();
    const list = [];
    for (let back = count - 1; back >= 0; back -= 1) {
      const date = new Date(Date.UTC(now.getFullYear(), now.getMonth() - back, 15));
      list.push(date.toISOString().slice(0, 7));
    }
    return list;
  }

  // A panel with a chart and a button that opens it large; build(height)
  // draws the chart.
  function chartSection(title, build, more) {
    return section(title, [build(), ...[].concat(more || [])], el("button", {
      type: "button",
      class: "ghost chart-expand",
      title: t("chart.expand"),
      "aria-label": t("chart.expand"),
      onclick: () => {
        const box = dialog(title);
        box.node.classList.add("wide");
        box.fill([build(Math.min(640, Math.max(320, Math.round(window.innerHeight * 0.6)))), el("p", { class: "hint" }, t("chart.zoomHint"))]);
      },
    }, "⤢"));
  }

  // The options every chart of buckets shares: the names of the step, the
  // crosshair across the charts and the zoom.
  function bucketChart(options, step) {
    return {
      tick: (key) => bucketName(key, step, true),
      title: (key) => bucketName(key, step),
      sync: "buckets",
      resetLabel: t("chart.resetZoom"),
      ...options,
    };
  }

  function rowsByKey(rows) {
    return new Map(rows.map((row) => [row.period, row]));
  }

  function fuelName(fuel) {
    return t("fuel." + fuel);
  }

  // What a fuel is measured in: methane by weight.
  function fuelUnit(fuel) {
    return fuel === "electric" ? "kWh" : fuel === "cng" ? "kg" : "L";
  }

  // A car on more than one fuel, such as gas and petrol: for each, a tile of
  // its consumption on the whole distance with all of it that went in, and
  // then a tile of its price with what it costs a kilometre.
  function fuelTiles(fuels) {
    const consumption = fuels.map((item) => infoTile("fuelConsumption", t("fuel.per100", { fuel: fuelName(item.fuel) }),
      item.consumption != null ? t("unit." + fuelUnit(item.fuel), { value: number(item.consumption, 1) }) : "—",
      t("tile.quantity." + fuelUnit(item.fuel), { value: number(item.quantity, 0) })));
    const prices = fuels.map((item) => infoTile("fuelPrice", t("fuel.priceOf." + fuelUnit(item.fuel), { fuel: fuelName(item.fuel) }),
      price(item.pricePerUnit), item.costPerKm != null ? t("tile.energyPerKmShort", { value: price(item.costPerKm) }) : null));
    return [...consumption, ...prices];
  }

  function fuelTable(fuels) {
    return el("div", { class: "table-wrap" }, el("table", { class: "data years" }, [
      el("thead", {}, el("tr", {}, [t("event.fuel"), t("fuel.quantity"), t("fuel.cost"), t("fuel.price"), t("fuel.per100short"), t("tile.perKm"), t("fuel.count")]
        .map((label, index) => el("th", { class: index ? "num" : null }, label)))),
      el("tbody", {}, fuels.map((item) => el("tr", {}, [
        el("td", {}, fuelName(item.fuel)),
        el("td", { class: "num" }, t("unit." + fuelUnit(item.fuel), { value: number(item.quantity, 0) })),
        el("td", { class: "num" }, money(item.cost)),
        el("td", { class: "num" }, price(item.pricePerUnit)),
        el("td", { class: "num" }, item.consumption != null ? number(item.consumption, 2) : "—"),
        el("td", { class: "num" }, price(item.costPerKm)),
        el("td", { class: "num" }, number(item.count)),
      ]))),
    ]));
  }

  function costChart(rows, step, height) {
    const byKey = rowsByKey(rows);
    return charts.columns(bucketChart({
      labels: rows.map((row) => row.period),
      series: stats.COSTS.map((kind) => ({ key: kind, label: kindName(kind) })),
      value: (key, kind) => (byKey.get(key) || {})[kind] || 0,
      format: (amount) => money(amount),
      extra: (key) => {
        const row = byKey.get(key);
        return row && row.income ? t("chart.income", { value: money(row.income) }) : null;
      },
      totalLabel: t("chart.total"),
      label: t("stats.costs", { by: t("stats.by." + step) }),
      key: "costs",
      legendTitle: t("chart.legendHint"),
      height,
    }, step));
  }

  // Events ------------------------------------------------------------------

  function years() {
    return [...new Set(state.events.map((event) => String(event.date).slice(0, 4)))].sort().reverse();
  }

  function filteredEvents() {
    const { kind, category, year, text } = state.filter;
    const needle = text.trim().toLowerCase();
    return state.events.filter((event) => (!kind || event.kind === kind)
      && (!category || event.category === category)
      && (!year || String(event.date).startsWith(year))
      && (!needle || [event.category, event.notes, event.odometer, event.amount].some((value) => String(value ?? "").toLowerCase().includes(needle))));
  }

  function sortedEvents(events) {
    const { key, desc } = state.sort;
    const value = (event) => (key === "date" || key === "category" ? String(event[key] || "") : Number(event[key] ?? -Infinity));
    const sorted = events.slice().sort((a, b) => {
      const [x, y] = [value(a), value(b)];
      const order = typeof x === "string" ? x.localeCompare(y, language, { numeric: true }) : x - y;
      return order || String(a.date).localeCompare(String(b.date));
    });
    return desc ? sorted.reverse() : sorted;
  }

  function sortHeader(key, label, className) {
    const active = state.sort.key === key;
    return el("th", { class: className || null, "aria-sort": active ? (state.sort.desc ? "descending" : "ascending") : "none" }, el("button", {
      type: "button",
      class: "sort" + (active ? " active" : ""),
      title: t("events.sortBy", { field: label }),
      onclick: () => {
        state.sort = { key, desc: active ? !state.sort.desc : key === "date" };
        render();
      },
    }, [label, active ? (state.sort.desc ? " ↓" : " ↑") : ""]));
  }

  // An event that waits in the outbox is not on the server yet: it can only
  // be taken out of the queue.
  async function openEvent(event) {
    if (!event.pending) return editEvent(event);
    if (!window.confirm((event.error ? t("offline.failed", { error: event.error }) + "\n\n" : "") + t("offline.discard"))) return;
    await outboxDelete(event.id);
    state.events = state.events.filter((item) => item.id !== event.id);
    await countPending();
    render();
  }

  function eventTable(events, sortable) {
    const head = sortable
      ? [sortHeader("date", t("event.date")), el("th", {}, t("event.kind")), sortHeader("category", t("event.category")),
        sortHeader("odometer", t("event.odometer"), "num"), sortHeader("quantity", t("event.quantity." + unit()), "num"),
        sortHeader("amount", t("event.amount"), "num"), el("th", {}, t("event.notes"))]
      : [t("event.date"), t("event.kind"), t("event.category"), t("event.odometer"), t("event.quantity." + unit()), t("event.amount"), t("event.notes")]
        .map((label, index) => el("th", { class: [3, 4, 5].includes(index) ? "num" : null }, label));
    return el("div", { class: "table-wrap" }, el("table", { class: "data events" }, [
      el("thead", {}, el("tr", {}, head)),
      el("tbody", {}, events.map((event) => el("tr", {
        tabindex: "0",
        class: event.excluded ? "excluded" : "",
        onclick: () => openEvent(event),
        onkeydown: (key) => key.key === "Enter" && openEvent(event),
      }, [
        el("td", { class: "nowrap" }, [dateText(event.date), event.pending ? el("span", { class: "pending", title: event.error || t("offline.waits") }, " ⏳") : null]),
        el("td", {}, kindBadge(event.kind)),
        el("td", { class: "name" }, [event.category || el("span", { class: "muted" }, "—"),
          event.excluded ? el("span", { class: "muted small", title: t("event.excludedHint") }, " · " + t("event.excludedShort")) : null]),
        el("td", { class: "num" }, event.odometer != null ? number(event.odometer) : ""),
        // A quantity in another unit than the car's, such as a charge of a car
        // on litres, says its unit.
        el("td", { class: "num" }, event.quantity == null ? "" : event.kind === "refuel" && fuelUnit(stats.fuelOf(event, unit())) !== unit()
          ? t("unit." + fuelUnit(stats.fuelOf(event, unit())), { value: number(event.quantity, 2) }) : number(event.quantity, 2)),
        el("td", { class: "num" + (event.kind === "income" ? " income" : "") }, (event.kind === "income" ? "+" : "") + money(event.amount)),
        el("td", { class: "notes" }, [
          (event.files || []).length ? el("span", { class: "clip", title: t("event.files") }, "📎" + (event.files.length > 1 ? event.files.length : "")) : null,
          // The place opens in a panel with a map; the click does not open the event.
          event.location ? el("button", {
            type: "button",
            class: "clip pin",
            title: t("location.title") + ": " + event.location.lat.toFixed(5) + ", " + event.location.lon.toFixed(5),
            "aria-label": t("location.title"),
            onclick: (click) => {
              click.stopPropagation();
              showPlace(event.location, event);
            },
            onkeydown: (key) => key.stopPropagation(),
          }, "📍") : null,
          event.notes ? el("span", { class: "muted" }, event.notes.split("\n")[0].slice(0, 80)) : null,
        ]),
      ]))),
    ]));
  }

  function eventsView() {
    const filter = state.filter;
    const found = sortedEvents(filteredEvents());
    const sum = found.filter((event) => !event.excluded)
      .reduce((total, event) => total + (event.kind === "income" ? -1 : 1) * Number(event.amount || 0), 0);
    const categories = stats.categoryList(state.events, filter.kind);
    const search = el("input", {
      type: "search",
      value: filter.text,
      placeholder: t("events.search"),
      "aria-label": t("events.search"),
      oninput: (event) => {
        filter.text = event.target.value;
        shown = EVENTS_PAGE;
        const caret = event.target.selectionStart;
        render();
        const again = document.querySelector(".events-tools input[type=search]");
        again.focus();
        again.setSelectionRange(caret, caret);
      },
    });
    const select = (key, options, label) => el("select", {
      "aria-label": label,
      onchange: (event) => {
        filter[key] = event.target.value;
        if (key === "kind") filter.category = "";
        shown = EVENTS_PAGE;
        render();
      },
    }, [el("option", { value: "" }, label), ...options.map(([value, text]) => el("option", { value, selected: filter[key] === value }, text))]);
    return [
      el("div", { class: "toolbar" }, [addButtons()]),
      el("div", { class: "panel filters" }, [
        el("div", { class: "events-tools" }, [
          search,
          select("kind", KINDS.map((kind) => [kind, kindName(kind)]), t("events.allKinds")),
          select("category", categories.map((name) => [name, name]), t("events.allCategories")),
          select("year", years().map((year) => [year, year]), t("events.allYears")),
        ]),
        el("p", { class: "hint" }, t("events.found", { count: found.length, sum: money(sum) })),
      ]),
      section(t("nav.events"), [
        found.length ? eventTable(found.slice(0, shown), true) : el("p", { class: "muted" }, t(state.events.length ? "events.noneFiltered" : "events.none")),
        found.length > shown ? el("div", { class: "actions" }, el("button", {
          type: "button",
          class: "ghost",
          onclick: () => {
            shown += EVENTS_PAGE;
            render();
          },
        }, t("events.more", { count: found.length - shown }))) : null,
      ]),
    ];
  }

  // A file of the browser, saved under name.
  function download(blob, name) {
    const link = el("a", { href: URL.createObjectURL(blob), download: name });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  function fileName(text) {
    return `${String(text).replace(/[^\p{L}\p{N}]+/gu, "-")}-${new Date().toISOString().slice(0, 10)}`;
  }

  function base64(buffer) {
    const bytes = new Uint8Array(buffer);
    let text = "";
    for (let start = 0; start < bytes.length; start += 0x8000) text += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
    return btoa(text);
  }

  // A car in one JSON file: the car, its events and its reminders as the
  // API gives them, and, if asked, the receipts and photos inside it in
  // base64 under their paths ("files"), as the site serves them now.
  async function exportCar(car, withFiles, progress) {
    const [events, found] = state.car && state.car.id === car.id && state.events
      ? [state.events, state.reminders]
      : await Promise.all([api(`/cars/${car.id}/events`).then((data) => data.items || []), api(`/cars/${car.id}/reminders`).then((data) => data.items || [])]);
    const plain = (item) => Object.fromEntries(Object.entries(item).filter(([key]) => key !== "status"));
    const paths = [...new Set([car.photo && car.photo.path, ...events.flatMap((event) => (event.files || []).map((file) => file.path))].filter(Boolean))];
    const files = {};
    let missing = 0;
    if (withFiles) {
      for (const [index, path] of paths.entries()) {
        progress(t("export.files", { done: index, count: paths.length }));
        try {
          const response = await fetch(path, { credentials: "same-origin" });
          if (!response.ok) throw new Error(String(response.status));
          files[path] = { type: response.headers.get("content-type") || "", data: base64(await response.arrayBuffer()) };
        } catch (error) {
          missing += 1;
        }
      }
    }
    const data = {
      format: "cars-serverless-aws",
      version: 1,
      exported: new Date().toISOString().slice(0, 19) + "Z",
      car: plain(car),
      // Oldest first, as they happened.
      events: events.slice().sort((a, b) => String(a.date).localeCompare(String(b.date))).map(plain),
      reminders: found.map(plain),
      ...(withFiles ? { files } : {}),
    };
    download(new Blob([JSON.stringify(data, null, 1)], { type: "application/json" }), fileName(car.name) + ".json");
    return { events: events.length, reminders: found.length, files: Object.keys(files).length, missing, paths: paths.length };
  }

  function showExport(car) {
    const box = dialog(t("export.title"));
    const withFiles = el("input", { type: "checkbox", checked: true });
    const result = el("div");
    const button = el("button", { type: "submit", class: "primary" }, t("export.start"));
    box.fill(el("form", {
      class: "fields",
      onsubmit: async (event) => {
        event.preventDefault();
        button.disabled = true;
        try {
          const done = await exportCar(car, withFiles.checked, (text) => fill(result, el("p", { class: "muted" }, text)));
          fill(result, el("div", { class: "secret-note" }, [
            el("p", {}, t("export.done")),
            el("ul", { class: "plain" }, [
              el("li", {}, t("export.events", { count: done.events })),
              el("li", {}, t("export.reminders", { count: done.reminders })),
              withFiles.checked ? el("li", {}, t("export.filesDone", { count: done.files })) : null,
              done.missing ? el("li", { class: "error" }, t("export.missing", { count: done.missing })) : null,
            ]),
          ]));
        } catch (failure) {
          fill(result, el("p", { class: "error" }, failure.message));
        }
        button.disabled = false;
      },
    }, [
      carChoice(car, null, (next) => { box.close(); showExport(next); }),
      el("p", {}, t("export.intro")),
      el("label", { class: "check" }, [withFiles, t("export.withFiles")]),
      el("p", { class: "hint" }, t("export.hint")),
      el("div", { class: "dialog-actions" }, [el("button", { type: "button", class: "ghost", onclick: () => box.close() }, t("close")), button]),
      result,
    ]));
  }

  // The events of a car as a CSV file: a column per field, the dates as
  // written, a point in the numbers.
  function exportCsv(car, events) {
    const columns = ["date", "kind", "category", "odometer", "quantity", "price", "amount", "excluded", "notes", "link", "lat", "lon"];
    const cell = (value) => {
      const text = value == null ? "" : String(value);
      return /[",\n;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    const lines = [columns.join(",")].concat(sortedEvents(events).map((event) => columns.map((key) => cell(key === "excluded" ? (event.excluded ? "yes" : "")
      : key === "lat" || key === "lon" ? (event.location || {})[key] : event[key])).join(",")));
    download(new Blob(["﻿" + lines.join("\n") + "\n"], { type: "text/csv;charset=utf-8" }), fileName(car.name) + ".csv");
  }

  // The events of the car open on the page as they are; of another car, from the API.
  function carEvents(car) {
    return state.car && state.car.id === car.id && state.events ? Promise.resolve(state.events)
      : api(`/cars/${car.id}/events`).then((data) => data.items || []);
  }

  // The car a dialog of import or export works on, changed by reopening the
  // dialog for the chosen one; newKey: the choice of a new car (null: none).
  function carChoice(car, newKey, reopen) {
    const select = el("select", { onchange: () => reopen(state.cars.find((known) => known.id === select.value) || null) }, [
      newKey ? el("option", { value: "" }, t(newKey)) : null,
      ...state.cars.map((known) => el("option", { value: known.id }, known.name)),
    ]);
    select.value = car ? car.id : "";
    return el("label", {}, [t(newKey ? "io.into" : "io.car"), select]);
  }

  // The car the dialogs of export open on: the one open on the page, or the first.
  function defaultCar() {
    return (state.car && state.cars.find((known) => known.id === state.car.id)) || state.cars[0] || null;
  }

  function showCsv(car) {
    const box = dialog(t("csv.title"));
    const result = el("div");
    const button = el("button", { type: "submit", class: "primary" }, t("export.start"));
    box.fill(el("form", {
      class: "fields",
      onsubmit: async (event) => {
        event.preventDefault();
        button.disabled = true;
        try {
          const events = await carEvents(car);
          exportCsv(car, events);
          fill(result, el("p", { class: "muted" }, t("csv.done", { count: events.length })));
        } catch (failure) {
          fill(result, el("p", { class: "error" }, failure.message));
        }
        button.disabled = false;
      },
    }, [
      carChoice(car, null, (next) => { box.close(); showCsv(next); }),
      el("p", {}, t("csv.intro")),
      el("div", { class: "dialog-actions" }, [el("button", { type: "button", class: "ghost", onclick: () => box.close() }, t("close")), button]),
      result,
    ]));
  }

  // A button that opens a list of choices under it; items: [label, action].
  function menuButton(label, items) {
    const list = el("ul", { class: "menu-list hidden", role: "menu" });
    const button = el("button", { type: "button", class: "ghost", "aria-haspopup": "menu", "aria-expanded": "false" }, label + " ▾");
    const close = () => {
      list.classList.add("hidden");
      button.setAttribute("aria-expanded", "false");
      document.removeEventListener("click", outside, true);
      document.removeEventListener("keydown", onKey);
    };
    const outside = (event) => {
      if (!wrap.contains(event.target)) close();
    };
    const onKey = (event) => {
      if (event.key === "Escape") close();
    };
    fill(list, items.map(([text, action]) => el("li", { role: "none" }, el("button", {
      type: "button",
      role: "menuitem",
      onclick: () => {
        close();
        action();
      },
    }, text))));
    button.addEventListener("click", () => {
      if (!list.classList.contains("hidden")) return close();
      list.classList.remove("hidden");
      button.setAttribute("aria-expanded", "true");
      document.addEventListener("click", outside, true);
      document.addEventListener("keydown", onKey);
    });
    const wrap = el("div", { class: "menu" }, [button, list]);
    return wrap;
  }

  // The form of an event: a new one has only its kind. A charge or a refuel
  // counts the third of quantity, price and amount from the other two, and
  // its station's last price is filled in for a new one.
  // event: the saved one or {kind} for a new one; host: where the form goes
  // instead of a dialog (the short form). Every change keeps a draft in the
  // browser until the event is saved, deleted or the form is cancelled, so
  // that a closed page or an ended session loses nothing.
  function editEvent(event, host) {
    const isNew = !event.id;
    const draftKey = `cars-draft:${state.car.id}:${event.id || "new-" + event.kind}`;
    // The id of a new event, made here: sent again after a lost network, it
    // still goes in once.
    const draftId = event.id || newEventId();
    const draft = {
      kind: event.kind,
      date: event.date || nowLocal(),
      odometer: event.odometer ?? "",
      category: event.category ?? (isNew ? (stats.latest(state.events, event.kind) || {}).category || "" : ""),
      // An imported amount may carry many places (a conversion from leva);
      // the form shows cents.
      quantity: event.quantity ?? "",
      price: event.price != null ? Math.round(event.price * 1e6) / 1e6 : "",
      amount: event.amount != null ? Math.round(event.amount * 100) / 100 : "",
      excluded: Boolean(event.excluded),
      notes: event.notes || "",
      link: event.link || "",
      files: (event.files || []).slice(),
      location: event.location || null,
      fuel: event.fuel || "",
    };
    if (isNew && draft.kind === "refuel" && draft.category) {
      const last = stats.latest(state.events, "refuel", draft.category);
      if (last && last.price != null) draft.price = last.price;
    }
    let kept = null;
    try {
      kept = readOnly() ? null : JSON.parse(stored(draftKey));
    } catch (error) {
      kept = null;
    }
    if (kept && kept.draft) Object.assign(draft, kept.draft, { kind: draft.kind });
    // A file that waits for the network lives in this form only.
    const keep = () => { if (!readOnly()) store(draftKey, JSON.stringify({ at: nowLocal(), draft: { ...draft, files: draft.files.filter((file) => !file.waiting) } })); };
    const forget = () => unstore(draftKey);
    const box = host || dialog(tu((isNew ? "event.new." : "event.edit.") + draft.kind), () => pasteInto(null));
    // The title of a new event's dialog links to its short form
    // (#add/<kind>/<car>), to open on a phone or to copy.
    if (!host && isNew && !readOnly()) {
      box.node.querySelector(".modal-head h2").append(el("a", {
        class: "quick-icon",
        href: quickLink(draft.kind, state.car),
        title: t("quick.linkTitle"),
        "aria-label": t("quick.linkTitle"),
      }, linkIcon()));
    }
    const error = el("p", { class: "error", role: "alert" });
    const highest = stats.highestOdometer(state.events);
    // after(key) runs once the draft has the new value.
    const input = (key, { after, ...attrs }) => el("input", {
      ...attrs,
      value: draft[key] === "" || draft[key] == null ? "" : String(draft[key]),
      oninput: (inputEvent) => {
        draft[key] = inputEvent.target.value;
        if (after) after(key);
      },
    });
    const round = (value, places) => Math.round(value * 10 ** places) / 10 ** places;
    const fields = {};
    // Quantity, price and total: a change of one counts the field filled
    // earliest of the other two, an empty one first. A counted field goes to
    // the front again, so that the next change counts it too.
    let order = ["amount", "quantity", "price"];
    const recount = (changed) => {
      order = order.filter((key) => key !== changed).concat(changed);
      const others = order.filter((key) => key !== changed);
      const target = others.find((key) => draft[key] === "" || draft[key] == null) || others[0];
      const known = others.find((key) => key !== target);
      const value = { [changed]: parseFloat(draft[changed]), [known]: parseFloat(draft[known]) };
      if (!(value[changed] >= 0) || !(value[known] >= 0)) return;
      let result = null;
      if (target === "amount") result = round(value.quantity * value.price, 2);
      else if (target === "price" && value.quantity > 0) result = round(value.amount / value.quantity, 4);
      else if (target === "quantity" && value.price > 0) result = round(value.amount / value.price, 3);
      if (result == null) return;
      draft[target] = String(result);
      fields[target].value = draft[target];
      order = [target].concat(order.filter((key) => key !== target));
    };
    let categoryTyped = Boolean(kept && kept.draft && kept.draft.category);
    const category = input("category", {
      type: "text",
      maxlength: "100",
      after: () => {
        if (draft.kind !== "refuel" || !isNew) return;
        const last = stats.latest(state.events, "refuel", draft.category);
        if (last && last.price != null) {
          draft.price = String(last.price);
          fields.price.value = draft.price;
          recount("price");
        }
      },
    });
    // The place of the event: the browser's location, on a click or by
    // itself for a new event once the site may ask. The categories used
    // near it come first in the list, and the nearest becomes the category
    // of a new event unless one was typed.
    const choices = stats.categoryList(state.events, draft.kind);
    const near = el("div", { class: "near" });
    const place = el("div", { class: "place" });
    const suggest = () => {
      const found = draft.location ? stats.nearby(state.events, draft.kind, draft.location, NEAR_METRES) : [];
      const names = found.map((entry) => entry.category);
      choices.splice(0, choices.length, ...names, ...stats.categoryList(state.events, draft.kind).filter((name) => !names.includes(name)));
      fill(near, found.length ? [t("location.near"), ...found.slice(0, 4).map((entry) => el("button", {
        type: "button",
        class: "chip" + (entry.category === draft.category ? " active" : ""),
        onclick: () => {
          category.value = entry.category;
          category.dispatchEvent(new Event("input", { bubbles: true }));
          suggest();
        },
      }, entry.category + " · " + metres(entry.distance)))] : []);
      if (found.length && isNew && !categoryTyped && draft.category !== found[0].category) {
        category.value = found[0].category;
        category.dispatchEvent(new Event("input", { bubbles: true }));
        suggest();
      }
    };
    const locate = (quiet) => {
      if (!navigator.geolocation) {
        if (!quiet) toast(t("location.unavailable"));
        return;
      }
      fill(place, el("span", { class: "muted small" }, t("location.finding")));
      navigator.geolocation.getCurrentPosition((position) => {
        draft.location = {
          lat: Math.round(position.coords.latitude * 1e6) / 1e6,
          lon: Math.round(position.coords.longitude * 1e6) / 1e6,
          accuracy: Math.round(position.coords.accuracy),
        };
        keep();
        drawPlace();
        suggest();
      }, (failure) => {
        drawPlace();
        if (!quiet) toast(t(failure.code === 1 ? "location.denied" : "location.failed"));
      }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
    };
    const onMap = el("button", {
      type: "button",
      class: "ghost",
      onclick: async () => {
        const picked = await pickPlace(draft.location, draft.kind);
        if (!picked) return;
        draft.location = picked;
        keep();
        drawPlace();
        suggest();
      },
    }, "🗺 " + t("location.onMap"));
    const drawPlace = () => fill(place, draft.location ? [
      el("button", { type: "button", class: "link mono small", onclick: () => showPlace(draft.location, draft) },
        `📍 ${draft.location.lat.toFixed(5)}, ${draft.location.lon.toFixed(5)}` + (draft.location.accuracy != null ? ` ±${metres(draft.location.accuracy)}` : "")),
      el("button", { type: "button", class: "ghost", onclick: () => locate(false) }, t("location.again")),
      onMap,
      el("button", { type: "button", class: "ghost", onclick: () => { draft.location = null; keep(); drawPlace(); suggest(); } }, t("location.remove")),
    ] : [el("button", { type: "button", class: "ghost", onclick: () => locate(false) }, "📍 " + t("location.add")), onMap]);
    drawPlace();
    suggest();
    if (isNew && !draft.location && !readOnly() && navigator.permissions) {
      navigator.permissions.query({ name: "geolocation" }).then((status) => { if (status.state === "granted") locate(true); }).catch(() => {});
    }
    category.addEventListener("input", (inputEvent) => { if (inputEvent.isTrusted) categoryTyped = true; });
    // The fuel follows the station until it is chosen by hand: the one of
    // the station's last refuel, else what its name says.
    let fuelChosen = Boolean(draft.fuel);
    const fuelFor = (name) => {
      const last = stats.latest(state.events, "refuel", name);
      return last ? stats.fuelOf(last, unit()) : stats.guessFuel(name, unit());
    };
    if (!draft.fuel && draft.kind === "refuel") draft.fuel = fuelFor(draft.category);
    // The words of quantity and price follow the fuel: a charge of a car on
    // litres is in kWh.
    const quantityLabel = el("span");
    const priceLabel = el("span");
    const drawUnits = () => {
      const measure = draft.kind === "refuel" && draft.fuel ? fuelUnit(draft.fuel) : unit();
      quantityLabel.textContent = t("event.quantity." + measure);
      priceLabel.textContent = t("event.price." + measure);
    };
    const fuelField = el("select", {
      onchange: (changeEvent) => {
        draft.fuel = changeEvent.target.value;
        fuelChosen = true;
        drawUnits();
      },
    }, stats.FUELS.map((value) => el("option", { value, selected: draft.fuel === value }, fuelName(value))));
    drawUnits();
    category.addEventListener("input", () => {
      if (fuelChosen || draft.kind !== "refuel") return;
      draft.fuel = fuelFor(draft.category);
      fuelField.value = draft.fuel;
      drawUnits();
    });
    fields.amount = input("amount", { type: "number", step: "0.01", min: "-100000000", max: "100000000", inputmode: "decimal", after: draft.kind === "refuel" ? recount : null });
    fields.price = input("price", { type: "number", step: "any", min: "0", inputmode: "decimal", after: recount });
    fields.quantity = input("quantity", { type: "number", step: "any", min: "0", inputmode: "decimal", after: recount });
    const fileList = el("ul", { class: "files" });
    const drawFiles = () => fill(fileList, draft.files.map((file, index) => el("li", {}, [
      file.type && file.type.startsWith("image/")
        ? el("a", { href: file.path, target: "_blank", rel: "noopener" }, el("img", { src: file.path, alt: file.name || "", loading: "lazy" }))
        : el("a", { class: "file-doc", href: file.path, download: file.name || "document.pdf" }, "PDF"),
      el("span", { class: "file-name small" }, file.name || ""),
      el("button", {
        type: "button",
        class: "icon-button",
        "aria-label": t("event.removeFile", { name: file.name || "" }),
        onclick: () => {
          draft.files.splice(index, 1);
          drawFiles();
          keep();
        },
      }, "×"),
    ])));
    drawFiles();
    const picker = el("input", {
      type: "file",
      multiple: true,
      accept: "image/*,application/pdf",
      class: "hidden",
      onchange: (changeEvent) => {
        const chosen = [...changeEvent.target.files];
        changeEvent.target.value = "";
        addFiles(chosen);
      },
    });
    const addFiles = async (chosen) => {
      for (const file of chosen) {
        try {
          toast(t("event.uploading", { name: file.name }));
          draft.files.push(await uploadFile(file));
          drawFiles();
          keep();
        } catch (failure) {
          if (!failure.offline) {
            toast(failure.message);
            continue;
          }
          // Without a network the file waits with the event, in the outbox.
          draft.files.push({ name: file.name.slice(0, 200), type: file.type, size: file.size, blob: file, path: URL.createObjectURL(file), waiting: true });
          drawFiles();
          toast(t("offline.fileWaits"));
        }
      }
    };
    if (!readOnly()) pasteInto(addFiles);
    const save = el("button", { type: "submit", class: "primary" }, t("save"));
    const refuel = draft.kind === "refuel";
    box.fill(el("form", {
      class: "fields",
      oninput: keep,
      onchange: keep,
      onsubmit: async (submitEvent) => {
        submitEvent.preventDefault();
        error.textContent = "";
        const numberOf = (value) => (value === "" || value == null ? null : Number(value));
        const body = {
          kind: draft.kind,
          date: draft.date,
          odometer: numberOf(draft.odometer),
          category: draft.category.trim(),
          amount: numberOf(draft.amount),
          excluded: draft.excluded,
          notes: draft.notes,
          link: draft.link.trim(),
          files: draft.files.filter((file) => !file.waiting),
          location: draft.location,
        };
        const waiting = draft.files.filter((file) => file.waiting).map(({ name, type, blob }) => ({ name, type, blob }));
        if (isNew) body.id = draftId;
        if (refuel) Object.assign(body, { quantity: numberOf(draft.quantity), price: numberOf(draft.price), fuel: draft.fuel || null });
        save.disabled = true;
        try {
          let saved;
          let queued = false;
          if (isNew) {
            try {
              // Files picked while there was no network go up first.
              for (const file of waiting) body.files.push(await uploadFile(new File([file.blob], file.name, { type: file.type })));
              saved = await api(`/cars/${state.car.id}/events`, { method: "POST", body });
            } catch (failure) {
              if (!failure.offline) throw failure;
              saved = await queueEvent(state.car.id, body, waiting.filter((file) => !body.files.some((done) => done.name === file.name)));
              queued = true;
            }
          } else {
            saved = await api(`/cars/${state.car.id}/events/${event.id}`, { method: "PUT", body });
          }
          state.events = state.events.filter((item) => item.id !== saved.id).concat([saved]);
          forget();
          box.close(saved);
          toast(t(queued ? "offline.saved" : "event.saved"));
          await reloadReminders();
          render();
        } catch (failure) {
          error.textContent = failure.message;
          save.disabled = false;
        }
      },
    }, [
      kept ? el("p", { class: "draft-note" }, [
        t("draft.restored", { date: dateText(kept.at, true) }),
        el("button", {
          type: "button",
          class: "ghost",
          onclick: () => {
            forget();
            if (host) render();
            else {
              box.close();
              editEvent(event);
            }
          },
        }, t("draft.discard")),
      ]) : null,
      el("div", { class: "form-grid" }, [
        el("label", {}, [t("event.date"), input("date", { type: "datetime-local", required: true })]),
        el("label", {}, [t("event.odometer"), input("odometer", {
          type: "number", min: "0", step: "1", inputmode: "numeric",
          placeholder: highest != null ? t("event.odometerLast", { value: number(highest) }) : "",
        })]),
      ]),
      el("div", { class: "files-field" }, [el("span", { class: "label" }, t("location.title")), place]),
      refuel && unit() === "L" ? el("div", { class: "form-grid" }, [
        el("label", {}, [tu("event.category." + draft.kind), combo(category, choices)]),
        el("label", {}, [t("event.fuel"), fuelField]),
      ]) : el("label", {}, [tu("event.category." + draft.kind), combo(category, choices)]),
      near,
      refuel ? el("div", { class: "form-grid three" }, [
        el("label", {}, [quantityLabel, fields.quantity]),
        el("label", {}, [priceLabel, fields.price]),
        el("label", {}, [t("event.total"), fields.amount]),
      ]) : el("label", {}, [t(draft.kind === "income" ? "event.received" : "event.amount"), fields.amount]),
      el("label", {}, [t("event.notes"), el("textarea", { rows: "3", maxlength: "5000", oninput: (inputEvent) => { draft.notes = inputEvent.target.value; } }, draft.notes)]),
      el("div", { class: "files-field" }, [
        el("span", { class: "label" }, t("event.files")),
        fileList,
        el("div", { class: "paste-row" }, [
          el("button", { type: "button", class: "ghost", onclick: () => picker.click() }, t("event.attach")),
          el("span", { class: "muted small" }, t("event.pasteHint")),
        ]),
        picker,
      ]),
      draft.link && !host ? el("label", {}, [t("event.link"), input("link", { type: "url" })]) : null,
      host ? null : el("label", { class: "check" }, [el("input", {
        type: "checkbox",
        checked: draft.excluded,
        onchange: (changeEvent) => { draft.excluded = changeEvent.target.checked; },
      }), t("event.excluded")]),
      !isNew && event.modified ? el("p", { class: "hint" }, [
        event.source === "sheet" ? t("event.fromSheet") + " " : "",
        t("event.modified", { date: when(event.modified), email: event.by || "" }),
      ]) : null,
      error,
      el("div", { class: "dialog-actions" }, [
        !isNew ? el("button", {
          type: "button",
          class: "danger",
          onclick: async () => {
            if (!window.confirm(t("event.deleteConfirm"))) return;
            try {
              await api(`/cars/${state.car.id}/events/${event.id}`, { method: "DELETE" });
              state.events = state.events.filter((item) => item.id !== event.id);
              forget();
              box.close();
              toast(t("event.deleted"));
              await reloadReminders();
              render();
            } catch (failure) {
              error.textContent = failure.message;
            }
          },
        }, t("delete")) : null,
        el("button", {
          type: "button",
          class: "ghost",
          "data-keep": true,
          onclick: () => {
            if (readOnly()) return box.close();
            forget();
            if (host) render();
            else box.close();
          },
        }, t(readOnly() ? "close" : "cancel")),
        save,
      ]),
    ]));
    if (readOnly()) lock(box.node);
  }

  // ⌘V / Ctrl+V of an image or a PDF goes to the open form that takes files
  // (pasteInto(handler); null when it closes). A paste of text into a field
  // stays a paste of text.
  let pasteHandler = null;

  function pasteInto(handler) {
    pasteHandler = handler;
  }

  document.addEventListener("click", () => infoTip && infoTip.classList.add("hidden"));
  window.addEventListener("scroll", () => infoTip && infoTip.classList.add("hidden"), { passive: true });

  document.addEventListener("paste", (event) => {
    if (!pasteHandler || !event.clipboardData) return;
    const found = [...event.clipboardData.files].filter((file) => file.type.startsWith("image/") || file.type === "application/pdf");
    if (!found.length) return;
    const field = event.target && event.target.closest && event.target.closest("textarea, input:not([type=file]):not([type=checkbox])");
    if (field && event.clipboardData.getData("text/plain")) return;
    event.preventDefault();
    pasteHandler(found.map((file) => (file.name && file.name !== "image.png" ? file
      : new File([file], t("event.pasted", { date: nowLocal().replace("T", " ") }), { type: file.type }))));
  });

  // A photo, shrunk to PHOTO_SIZE pixels on its longer side as JPEG, or a PDF
  // as it is, goes straight to S3 through a presigned POST; the event keeps
  // its path.
  async function uploadFile(file) {
    let blob = file;
    if (file.type !== "application/pdf") {
      try {
        const bitmap = await createImageBitmap(file);
        const scale = Math.min(1, PHOTO_SIZE / Math.max(bitmap.width, bitmap.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(bitmap.width * scale);
        canvas.height = Math.round(bitmap.height * scale);
        canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
      } catch (error) {
        // A format the browser cannot draw goes as it is, if the API takes it.
      }
    }
    if (!blob || blob.size > state.me.file_max_bytes) throw new Error(t("api.bad_file"));
    const target = await api("/files", { method: "POST", body: { content_type: blob.type, size: blob.size } });
    const form = new FormData();
    Object.entries(target.post.fields).forEach(([key, value]) => form.append(key, value));
    form.append("file", blob);
    const response = await fetch(target.post.url, { method: "POST", body: form });
    if (!response.ok) throw new Error(t("event.uploadFailed"));
    return { path: target.path, name: file.name.slice(0, 200), type: blob.type, size: blob.size };
  }

  // Statistics ----------------------------------------------------------------

  function periodRange() {
    if (state.period === "12m") return { from: lastMonths(12)[0] };
    if (/^\d{4}$/.test(state.period)) return { from: state.period + "-01", to: state.period + "-12" };
    return {};
  }

  function statsView() {
    const data = stats.compute(state.events, { ...periodRange(), step: state.step, unit: unit() });
    const step = data.step;
    const by = t("stats.by." + step);
    const steps = el("div", { class: "seg steps", role: "group", "aria-label": t("stats.step") }, stats.STEPS.map((value) => el("button", {
      type: "button",
      class: value === step ? "active" : "",
      "aria-pressed": String(value === step),
      onclick: () => {
        state.step = value;
        store(STEP_KEY, value);
        render();
      },
    }, t("stats.step." + value))));
    const picker = el("select", {
      "aria-label": t("stats.period"),
      onchange: (event) => {
        state.period = event.target.value;
        render();
      },
    }, [["12m", t("stats.last12")], ["", t("stats.all")], ...years().map((year) => [year, year])]
      .map(([value, label]) => el("option", { value, selected: state.period === value }, label)));
    if (!data.count) return [el("div", { class: "toolbar" }, picker), el("p", { class: "muted panel" }, t("events.none"))];
    const rows = data.buckets;
    const byKey = rowsByKey(rows);
    const columns = (key, format, label) => chartSection(label, (height) => charts.columns(bucketChart({
      labels: rows.map((row) => row.period),
      series: [{ key, label }],
      value: (period) => Number((byKey.get(period) || {})[key] || 0),
      format,
      label,
      height: height || 180,
    }, step)));
    return [
      el("div", { class: "toolbar" }, [picker, steps, data.first ? el("span", { class: "muted small" }, t("stats.span", { from: dateText(data.first), to: dateText(data.last), days: number(data.days) })) : null]),
      el("div", { class: "tiles" }, [
        infoTile("driven", t("tile.driven"), km(data.km), data.kmPerDay != null ? t("tile.perDay", { value: km(data.kmPerDay) }) : null),
        infoTile("cost", t("tile.cost"), money(data.cost), t("tile.balance", { value: money(data.balance) })),
        infoTile("perKm", t("tile.perKm"), price(data.costPerKm), t("tile.perKmBalance", { value: price(data.balancePerKm) })),
        infoTile("perMonth", t("tile.perMonth"), money(data.costPerMonth), t("tile.perMonthBalance", { value: money(data.balancePerMonth) })),
        infoTile("perDay", t("tile.perDayCost"), money(data.costPerDay), t("tile.perDayBalance", { value: money(data.balancePerDay) })),
        ...(data.fuels.length > 1 ? fuelTiles(data.fuels) : [
          infoTile("consumption." + unit(), t("tile.consumption." + unit()), data.consumption != null ? number(data.consumption, 1) : "—",
            t("tile.quantity." + unit(), { value: number(data.quantity, 0) })),
          infoTile("pricePerUnit." + unit(), t("tile.pricePerUnitTitle." + unit()), price(data.pricePerUnit), t("tile.energyPerKmShort", { value: price(data.energyPerKm) })),
        ]),
      ]),
      el("div", { class: "tiles compact" }, KINDS.map((kind) => infoTile("kind." + kind, kindName(kind), money(data.totals[kind]),
        kind === "income" || !data.cost ? null : t("stats.share", { value: number((data.totals[kind] / data.cost) * 100, 1) })))),
      chartSection(t("stats.costs", { by }), (height) => costChart(rows, step, height), el("p", { class: "hint" }, t("stats.costsHint"))),
      el("div", { class: "columns" }, [
        columns("km", (value) => km(value), t("stats.km", { by })),
        chartSection(t("stats.odometer"), (height) => charts.line(bucketChart({
          labels: rows.map((row) => row.period),
          value: (period) => (byKey.get(period) || {}).odometer ?? null,
          format: (value) => km(value),
          label: t("stats.odometer"),
          height: height || 180,
        }, step))),
        data.fuels.length > 1 ? chartSection(t("fuel.chart", { by }), (height) => charts.columns(bucketChart({
          labels: rows.map((row) => row.period),
          // One column of each fuel on the whole distance: together the consumption.
          series: data.fuels.map((item) => ({ key: item.fuel, label: fuelName(item.fuel) })),
          value: (period, fuel) => Number(((byKey.get(period) || {}).consumptionByFuel || {})[fuel] || 0),
          format: (value) => number(value, 1),
          totalLabel: t("chart.total"),
          label: t("fuel.chart", { by }),
          key: "fuels",
          legendTitle: t("chart.legendHint"),
          height: height || 180,
        }, step))) : columns("consumption", (value) => number(value, 1), t("stats.consumption." + unit(), { by })),
        columns("perKm", (value) => price(value), t("stats.perKm", { by })),
      ]),
      data.fuels.length > 1 ? section(t("fuel.title"), fuelTable(data.fuels)) : null,
      el("div", { class: "columns" }, [
        section(tu("stats.byCategory.refuel"), shareTable(data.categories.refuel, (value) => money(value))),
        section(t("stats.byQuantity." + unit()), shareTable(data.quantities, (value) => t("unit." + unit(), { value: number(value, 0) }))),
        section(t("stats.byCategory.service"), shareTable(data.categories.service, (value) => money(value))),
        section(t("stats.byCategory.expense"), shareTable(data.categories.expense, (value) => money(value))),
        section(t("stats.byCategory.income"), shareTable(data.categories.income, (value) => money(value))),
      ]),
      section(t("stats.years"), el("div", { class: "table-wrap" }, el("table", { class: "data years" }, [
        el("thead", {}, el("tr", {}, [t("stats.year"), t("tile.driven"), ...KINDS.map((kind) => kindName(kind)), t("tile.cost"), t("stats.balance"), t("tile.perKm")]
          .map((label, index) => el("th", { class: index ? "num" : null }, label)))),
        el("tbody", {}, data.years.map((row) => el("tr", {}, [
          el("td", {}, row.year),
          el("td", { class: "num" }, km(row.km)),
          ...KINDS.map((kind) => el("td", { class: "num" }, money(row[kind]))),
          el("td", { class: "num" }, money(row.cost)),
          el("td", { class: "num" }, money(row.balance)),
          el("td", { class: "num" }, row.km ? price(row.cost / row.km) : "—"),
        ]))),
      ]))),
    ];
  }

  // Map -----------------------------------------------------------------------

  // Leaflet and its plugin that groups near markers, loaded the first time
  // the map opens; the CSP of the site allows these versions from cdnjs, and
  // the map tiles of OpenStreetMap.
  const MAP_FILES = [
    ["https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css", "sha384-c6Rcwz4e4CITMbu/NBmnNS8yN2sC3cUElMEMfP3vqqKFp7GOYaaBBCqmaWBjmkjb"],
    ["https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js", "sha384-NElt3Op+9NBMCYaef5HxeJmU4Xeard/Lku8ek6hoPTvYkQPh3zLIrJP7KiRocsxO"],
    ["https://cdnjs.cloudflare.com/ajax/libs/leaflet.markercluster/1.5.3/MarkerCluster.css", "sha384-pmjIAcz2bAn0xukfxADbZIb3t8oRT9Sv0rvO+BR5Csr6Dhqq+nZs59P0pPKQJkEV"],
    ["https://cdnjs.cloudflare.com/ajax/libs/leaflet.markercluster/1.5.3/leaflet.markercluster.js", "sha384-eXVCORTRlv4FUUgS/xmOyr66XBVraen8ATNLMESp92FKXLAMiKkerixTiBvXriZr"],
  ];
  let leaflet = null;
  let shownMap = null;

  function loadFile([url, integrity]) {
    return new Promise((resolve, reject) => {
      const common = { integrity, crossorigin: "anonymous", referrerpolicy: "no-referrer", onload: resolve, onerror: reject };
      document.head.append(url.endsWith(".css") ? el("link", { rel: "stylesheet", href: url, ...common }) : el("script", { src: url, ...common }));
    });
  }

  function loadLeaflet() {
    if (window.L && window.L.markerClusterGroup) return Promise.resolve(window.L);
    if (!leaflet) {
      // The plugin needs Leaflet first.
      leaflet = MAP_FILES.reduce((chain, file) => chain.then(() => loadFile(file)), Promise.resolve())
        .then(() => window.L)
        .catch(() => {
          leaflet = null;
          throw new Error(t("map.failed"));
        });
    }
    return leaflet;
  }

  // How close a click on a group of markers goes at most.
  const CLUSTER_ZOOM = 18;

  // The tiles of OpenStreetMap. Its servers refuse a request without a
  // Referer, and the site sends none (Referrer-Policy: no-referrer): the
  // tiles alone tell the origin, never the path or the hash of the page.
  function osmTiles(L) {
    return L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      referrerPolicy: "strict-origin-when-cross-origin",
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    });
  }

  // The sign of an event on the map: what kind it is.
  function kindIcon(kind) {
    if (kind === "refuel") return unit() === "L" ? "⛽" : "⚡";
    return { service: "🔧", expense: "🧾", income: "💶" }[kind] || "•";
  }

  // The places of a kind and category: where it was on average, how often,
  // for how much and when last.
  function places(events) {
    const found = {};
    events.forEach((event) => {
      const key = event.kind + "\n" + (event.category || "");
      const entry = found[key] || (found[key] = { kind: event.kind, category: event.category || "", lat: 0, lon: 0, count: 0, amount: 0, last: "" });
      entry.lat += event.location.lat;
      entry.lon += event.location.lon;
      entry.count += 1;
      entry.amount += Number(event.amount || 0);
      if (String(event.date) > entry.last) entry.last = String(event.date);
    });
    return Object.values(found).map((entry) => ({ ...entry, lat: entry.lat / entry.count, lon: entry.lon / entry.count }))
      .sort((a, b) => b.count - a.count || b.amount - a.amount);
  }

  // A place in a panel over the page: a map around it with the event's sign,
  // its accuracy as a circle, and a link to OpenStreetMap for directions.
  function showPlace(place, event) {
    const box = dialog(event && event.category ? event.category : t("location.title"));
    const node = el("div", { class: "map place-map" });
    const osm = `https://www.openstreetmap.org/?mlat=${place.lat}&mlon=${place.lon}#map=17/${place.lat}/${place.lon}`;
    box.fill([
      node,
      el("p", { class: "place-line" }, [
        event && event.kind ? kindBadge(event.kind) : null,
        event && event.date ? " " + dateText(event.date, true) + " · " : " ",
        el("span", { class: "mono small" }, `${place.lat.toFixed(5)}, ${place.lon.toFixed(5)}` + (place.accuracy != null ? ` ±${metres(place.accuracy)}` : "")),
      ]),
      el("div", { class: "dialog-actions" }, [
        el("a", { class: "ghost", href: osm, target: "_blank", rel: "noopener" }, t("location.osm")),
        el("button", { type: "button", class: "primary", onclick: () => box.close() }, t("close")),
      ]),
    ]);
    loadLeaflet().then((L) => {
      if (!node.isConnected) return;
      const map = L.map(node).setView([place.lat, place.lon], 17);
      osmTiles(L).addTo(map);
      if (place.accuracy) L.circle([place.lat, place.lon], { radius: place.accuracy, className: "place-accuracy" }).addTo(map);
      L.marker([place.lat, place.lon], {
        icon: L.divIcon({ html: event && event.kind ? kindIcon(event.kind) : "📍", className: "map-icon kind-" + (event && event.kind), iconSize: L.point(30, 30) }),
      }).addTo(map);
      setTimeout(() => map.invalidateSize(), 50);
    }).catch((error) => fill(node, el("p", { class: "error" }, error.message)));
  }

  // A place put on a map by hand: a click sets the pin, a drag moves it, a
  // click on a past event's place takes that place. Resolves to {lat, lon},
  // or null when the dialog is closed without one.
  function pickPlace(current, kind) {
    return new Promise((resolve) => {
      let chosen = current ? { lat: current.lat, lon: current.lon } : null;
      let done = false;
      const box = dialog(t("location.pickTitle"), () => { if (!done) resolve(null); });
      box.node.classList.add("wide");
      const node = el("div", { class: "map pick-map" });
      const status = el("p", { class: "hint" }, t("location.pickHint"));
      const ok = el("button", {
        type: "button",
        class: "primary",
        disabled: !chosen,
        onclick: () => {
          done = true;
          box.close();
          resolve(chosen);
        },
      }, t("location.pickDone"));
      box.fill([node, status, el("div", { class: "dialog-actions" }, [
        el("button", { type: "button", class: "ghost", onclick: () => box.close() }, t("cancel")),
        ok,
      ])]);
      loadLeaflet().then((L) => {
        if (!node.isConnected) return;
        const map = L.map(node);
        osmTiles(L).addTo(map);
        let pin = null;
        const put = (latlng) => {
          chosen = { lat: Math.round(latlng.lat * 1e6) / 1e6, lon: Math.round(latlng.lng * 1e6) / 1e6 };
          if (!pin) {
            pin = L.marker(latlng, { draggable: true, autoPan: true, icon: L.divIcon({ html: "📍", className: "map-pin", iconSize: L.point(32, 32), iconAnchor: [16, 30] }) })
              .on("dragend", () => put(pin.getLatLng()))
              .addTo(map);
          } else pin.setLatLng(latlng);
          ok.disabled = false;
          status.textContent = t("location.picked", { place: `${chosen.lat.toFixed(5)}, ${chosen.lon.toFixed(5)}` });
        };
        // The places of past events, those of this kind first to the eye.
        const known = state.events.filter((event) => event.location);
        known.forEach((event) => {
          L.marker([event.location.lat, event.location.lon], {
            title: (event.category || kindName(event.kind)) + " · " + dateText(event.date),
            icon: L.divIcon({ html: kindIcon(event.kind), className: "map-icon kind-" + event.kind + (event.kind === kind ? "" : " faint"), iconSize: L.point(26, 26) }),
          }).on("click", () => put(L.latLng(event.location.lat, event.location.lon))).addTo(map);
        });
        map.on("click", (event) => put(event.latlng));
        if (chosen) {
          map.setView([chosen.lat, chosen.lon], 17);
          put(L.latLng(chosen.lat, chosen.lon));
          status.textContent = t("location.pickHint");
        } else if (known.length) {
          map.fitBounds(L.latLngBounds(known.map((event) => [event.location.lat, event.location.lon])).pad(0.2), { maxZoom: 16 });
        } else {
          map.setView([48, 15], 4);
        }
        // Without a place yet the map starts where the browser is, when the
        // site may know it.
        if (!chosen && navigator.geolocation && navigator.permissions) {
          navigator.permissions.query({ name: "geolocation" }).then((permission) => {
            if (permission.state !== "granted") return;
            navigator.geolocation.getCurrentPosition((position) => {
              if (!chosen) map.setView([position.coords.latitude, position.coords.longitude], 16);
            }, () => {}, { timeout: 10000, maximumAge: 60000 });
          }).catch(() => {});
        }
        // The dialog has its size only now.
        setTimeout(() => map.invalidateSize(), 50);
      }).catch((error) => fill(node, el("p", { class: "error" }, error.message)));
    });
  }

  function mapView() {
    const range = periodRange();
    const inRange = (event) => {
      const period = stats.month(event.date);
      return (!range.from || period >= range.from) && (!range.to || period <= range.to);
    };
    const located = state.events.filter((event) => event.location && inRange(event) && (!state.mapKind || event.kind === state.mapKind));
    const picker = el("select", {
      "aria-label": t("stats.period"),
      onchange: (event) => {
        state.period = event.target.value;
        render();
      },
    }, [["12m", t("stats.last12")], ["", t("stats.all")], ...years().map((year) => [year, year])]
      .map(([value, label]) => el("option", { value, selected: state.period === value }, label)));
    const kinds = el("div", { class: "seg steps", role: "group", "aria-label": t("event.kind") }, ["", ...KINDS].map((kind) => el("button", {
      type: "button",
      class: kind === state.mapKind ? "active" : "",
      "aria-pressed": String(kind === state.mapKind),
      onclick: () => {
        state.mapKind = kind;
        render();
      },
    }, kind ? kindName(kind) : t("map.all"))));
    const toolbar = el("div", { class: "toolbar" }, [picker, kinds, el("span", { class: "muted small" }, t("map.count", { count: located.length }))]);
    if (!located.length) return [toolbar, section(t("nav.map"), el("p", { class: "muted" }, t("map.none")))];
    const node = el("div", { class: "map" });
    const list = places(located);
    let map = null;
    // Leaflet needs the node in the page: it is drawn once render() has put it there.
    requestAnimationFrame(() => loadLeaflet().then((L) => {
      if (!node.isConnected) return;
      if (shownMap) shownMap.remove();
      map = shownMap = L.map(node, { scrollWheelZoom: true });
      osmTiles(L).addTo(map);
      // Markers near each other at this zoom become one with their number,
      // coloured by the kind most of them are. A click flies to all of the
      // group's events at once, not only one zoom step until it splits; when
      // they are at one place, it spreads them out.
      const group = L.markerClusterGroup({
        maxClusterRadius: 48,
        showCoverageOnHover: false,
        spiderfyOnMaxZoom: false,
        zoomToBoundsOnClick: false,
        iconCreateFunction: (cluster) => {
          const counts = {};
          cluster.getAllChildMarkers().forEach((marker) => { counts[marker.options.kind] = (counts[marker.options.kind] || 0) + 1; });
          const kinds = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
          const size = cluster.getChildCount() < 10 ? 36 : cluster.getChildCount() < 100 ? 42 : 48;
          return L.divIcon({
            html: `<span class="map-cluster-count">${cluster.getChildCount()}</span><span class="map-cluster-kinds">${kinds.slice(0, 3).map(kindIcon).join("")}</span>`,
            className: "map-cluster kind-" + kinds[0],
            iconSize: L.point(size, size),
          });
        },
      });
      group.on("clusterclick", (clicked) => {
        const cluster = clicked.layer;
        const bounds = cluster.getBounds();
        const target = Math.min(map.getBoundsZoom(bounds.pad(0.15)), CLUSTER_ZOOM);
        // Within a few metres of each other even this close: one place.
        const spread = map.project(bounds.getNorthEast(), CLUSTER_ZOOM).distanceTo(map.project(bounds.getSouthWest(), CLUSTER_ZOOM));
        if (spread < 40) {
          if (map.getZoom() >= CLUSTER_ZOOM - 1) cluster.spiderfy();
          else map.once("moveend", () => group.getVisibleParent(cluster.getAllChildMarkers()[0])?.spiderfy?.()).flyTo(bounds.getCenter(), CLUSTER_ZOOM, { duration: 0.6 });
          return;
        }
        map.flyToBounds(bounds.pad(0.15), { maxZoom: target, duration: 0.6 });
      });
      located.forEach((event) => {
        L.marker([event.location.lat, event.location.lon], {
          kind: event.kind,
          title: (event.category || kindName(event.kind)) + " · " + dateText(event.date),
          icon: L.divIcon({ html: kindIcon(event.kind), className: "map-icon kind-" + event.kind, iconSize: L.point(30, 30), popupAnchor: [0, -14] }),
        })
          .bindPopup(() => el("div", { class: "map-popup" }, [
            el("strong", {}, event.category || kindName(event.kind)),
            el("div", {}, [kindBadge(event.kind), " ", dateText(event.date, true)]),
            el("div", {}, [money(event.amount), event.quantity != null ? " · " + t("unit." + unit(), { value: number(event.quantity, 1) }) : "",
              event.odometer != null ? " · " + km(event.odometer) : ""]),
            el("button", { type: "button", class: "ghost", onclick: () => editEvent(event) }, t("map.open")),
          ]))
          .addTo(group);
      });
      map.addLayer(group);
      map.fitBounds(L.latLngBounds(located.map((event) => [event.location.lat, event.location.lon])).pad(0.2), { maxZoom: 16 });
    }).catch((error) => fill(node, el("p", { class: "error" }, error.message))));
    return [
      toolbar,
      section(t("nav.map"), node),
      section(t("map.places"), el("div", { class: "table-wrap" }, el("table", { class: "data places" }, [
        el("thead", {}, el("tr", {}, [t("event.kind"), t("event.category"), t("map.visits"), t("event.amount"), t("map.last")]
          .map((label, index) => el("th", { class: index === 2 || index === 3 ? "num" : null }, label)))),
        el("tbody", {}, list.map((entry) => el("tr", {
          tabindex: "0",
          onclick: () => map && map.flyTo([entry.lat, entry.lon], 16),
          onkeydown: (key) => key.key === "Enter" && map && map.flyTo([entry.lat, entry.lon], 16),
        }, [
          el("td", {}, kindBadge(entry.kind)),
          el("td", { class: "name" }, entry.category || el("span", { class: "muted" }, "—")),
          el("td", { class: "num" }, number(entry.count)),
          el("td", { class: "num" }, money(entry.amount)),
          el("td", { class: "nowrap" }, dateText(entry.last)),
        ]))),
      ]))),
    ];
  }

  // Reminders -----------------------------------------------------------------

  function reminderLine(status) {
    const parts = [];
    if (status.left_days != null) {
      parts.push(status.left_days === 0 ? t("reminder.today")
        : t(status.left_days > 0 ? "reminder.inDays" : "reminder.daysAgo", { count: Math.abs(status.left_days), date: dateText(status.due_date) }));
    }
    if (status.left_km != null) {
      parts.push(t(status.left_km >= 0 ? "reminder.inKm" : "reminder.kmAgo", { value: km(Math.abs(status.left_km)) }));
    }
    return parts.join(" · ") || t("reminder.noEvents");
  }

  // How often a reminder comes: its period ("days" alone in reminders saved
  // before units) and its kilometres.
  function periodText(item) {
    const every = item.every || item.days;
    const start = item.start ? t("reminder.startShort", { date: dateText(item.start) }) : null;
    if (item.repeat === "monthday") return [t("reminder.onMonthday", { day: item.day }), start].filter(Boolean).join(" · ");
    if (item.repeat === "weekday") {
      const days = item.weekdays || [item.weekday || 1];
      const text = days.length === 7 ? t("reminder.everyDay") : days.join() === "1,2,3,4,5" ? t("reminder.workdays")
        : days.length === 1 ? t("reminder.onWeekday." + days[0]) : t("reminder.onWeekdays", { days: days.map((day) => weekdayNames("short")[day - 1]).join(", ") });
      return [text, start].filter(Boolean).join(" · ");
    }
    return [
      every ? t("reminder.period." + (item.every ? item.unit : "day"), { count: every }) : null,
      item.km ? t("reminder.periodKm", { value: km(item.km) }) : null,
      start,
    ].filter(Boolean).join(" · ");
  }

  // The names of the days of the week, Monday first, in the page's language.
  function weekdayNames(width) {
    return [1, 2, 3, 4, 5, 6, 7].map((day) => new Date(Date.UTC(2026, 9, 18 + day, 12)).toLocaleDateString(language, { weekday: width || "long", timeZone: "UTC" }));
  }

  function reminderRow(item) {
    return el("li", { class: "reminder state-" + item.status.state }, el("button", { type: "button", class: "reminder-button", onclick: () => editReminder(item) }, [
      stateBadge(item.status),
      el("span", { class: "reminder-title" }, [item.category, el("span", { class: "muted small" }, " · " + periodText(item))]),
      el("span", { class: "reminder-detail" }, reminderLine(item.status)),
      el("span", { class: "reminder-last muted small" }, item.status.last_date
        ? t("reminder.last", { date: dateText(item.status.last_date), odometer: item.status.last_km != null ? km(item.status.last_km) : "—" }) : ""),
    ]));
  }

  const STATE_ORDER = { overdue: 0, soon: 1, ok: 2, never: 3 };

  function remindersView() {
    const items = state.reminders.slice().sort((a, b) => STATE_ORDER[a.status.state] - STATE_ORDER[b.status.state]
      || (a.status.left_days ?? 1e9) - (b.status.left_days ?? 1e9) || a.category.localeCompare(b.category));
    return [
      el("div", { class: "toolbar" }, [
        readOnly() ? null : el("button", { type: "button", class: "primary", onclick: () => editReminder({}) }, t("reminders.add")),
        el("span", { class: "muted small" }, t("reminders.lead", { days: state.me.lead_days, km: km(state.me.lead_km) })),
      ]),
      section(t("nav.reminders"), [
        el("p", { class: "hint" }, t("reminders.hint")),
        items.length ? el("ul", { class: "reminders" }, items.map(reminderRow)) : el("p", { class: "muted" }, t("reminders.none")),
      ]),
    ];
  }

  function editReminder(item) {
    const isNew = !item.id;
    const draft = {
      category: item.category || "",
      repeat: item.repeat || "period",
      every: item.every ?? item.days ?? "",
      unit: item.every ? item.unit : "day",
      km: item.km ?? "",
      day: item.day ?? 1,
      weekdays: new Set(item.weekdays || [item.weekday || 1]),
      start: item.start || "",
      notes: item.notes || "",
      mail: item.mail !== false,
    };
    const box = dialog(t(isNew ? "reminder.new" : "reminder.edit"));
    const error = el("p", { class: "error", role: "alert" });
    const save = el("button", { type: "submit", class: "primary" }, t("save"));
    const input = (key, attrs) => el("input", { ...attrs, value: String(draft[key]), oninput: (event) => { draft[key] = event.target.value; } });
    // What the chosen repeat needs: a period and kilometres, a day of the
    // month or a day of the week.
    const when = el("div", { class: "fields" });
    const dayButtons = el("span", { class: "days", role: "group", "aria-label": t("reminder.weekday") });
    const drawDays = () => fill(dayButtons, weekdayNames("short").map((name, index) => {
      const day = index + 1;
      return el("button", {
        type: "button",
        class: draft.weekdays.has(day) ? "day on" : "day",
        "aria-pressed": String(draft.weekdays.has(day)),
        // Shown, not removed, in a read-only form (lock).
        "data-keep": true,
        disabled: readOnly(),
        title: weekdayNames()[index],
        onclick: () => {
          if (draft.weekdays.has(day)) draft.weekdays.delete(day);
          else draft.weekdays.add(day);
          drawDays();
        },
      }, name);
    }));
    drawDays();
    const drawWhen = () => fill(when, draft.repeat === "monthday" ? [
      el("label", {}, [t("reminder.day"), input("day", { type: "number", min: "1", max: "31", step: "1", inputmode: "numeric", required: true })]),
      el("p", { class: "hint" }, t("reminder.monthdayHint")),
    ] : draft.repeat === "weekday" ? [
      // Days as toggles, Monday first.
      el("div", { class: "files-field" }, [el("span", { class: "label" }, t("reminder.weekday")), dayButtons]),
      el("p", { class: "hint" }, t("reminder.weekdayHint")),
    ] : [
      el("div", { class: "form-grid" }, [
        el("label", {}, [t("reminder.every"), el("div", { class: "period" }, [
          input("every", { type: "number", min: "1", max: "36500", step: "1", inputmode: "numeric", "aria-label": t("reminder.every") }),
          el("select", { "aria-label": t("reminder.every"), onchange: (event) => { draft.unit = event.target.value; } },
            ["day", "week", "month", "year"].map((value) => el("option", { value, selected: draft.unit === value }, t("reminder.unit." + value)))),
        ])]),
        el("label", {}, [t("reminder.km"), input("km", { type: "number", min: "1", step: "1", inputmode: "numeric" })]),
      ]),
      el("p", { class: "hint" }, t("reminder.intervalHint")),
    ]);
    drawWhen();
    box.fill(el("form", {
      class: "fields",
      onsubmit: async (event) => {
        event.preventDefault();
        error.textContent = "";
        const numberOf = (value) => (value === "" ? null : Number(value));
        const body = { category: draft.category, repeat: draft.repeat, start: draft.start || null, notes: draft.notes, mail: draft.mail };
        if (draft.repeat === "monthday") body.day = Number(draft.day);
        else if (draft.repeat === "weekday") {
          if (!draft.weekdays.size) {
            error.textContent = t("reminder.noWeekdays");
            return;
          }
          body.weekdays = [...draft.weekdays].sort();
        }
        else Object.assign(body, { every: numberOf(draft.every), unit: draft.unit, km: numberOf(draft.km) });
        save.disabled = true;
        try {
          if (isNew) await api(`/cars/${state.car.id}/reminders`, { method: "POST", body });
          else await api(`/cars/${state.car.id}/reminders/${item.id}`, { method: "PUT", body });
          box.close();
          toast(t("reminder.saved"));
          await reloadReminders();
          render();
        } catch (failure) {
          error.textContent = failure.message;
          save.disabled = false;
        }
      },
    }, [
      el("label", {}, [t("reminder.category"), combo(input("category", { type: "text", required: true, maxlength: "100" }), stats.categoryList(state.events))]),
      el("p", { class: "hint" }, t("reminder.categoryHint")),
      el("div", { class: "form-grid" }, [
        el("label", {}, [t("reminder.repeat"), el("select", {
          onchange: (event) => {
            draft.repeat = event.target.value;
            drawWhen();
          },
        }, ["period", "monthday", "weekday"].map((value) => el("option", { value, selected: draft.repeat === value }, t("reminder.repeat." + value))))]),
        el("label", {}, [t("reminder.start"), input("start", { type: "date" })]),
      ]),
      when,
      el("label", {}, [t("event.notes"), el("textarea", { rows: "2", maxlength: "1000", oninput: (event) => { draft.notes = event.target.value; } }, draft.notes)]),
      el("label", { class: "check" }, [el("input", {
        type: "checkbox",
        checked: draft.mail,
        onchange: (event) => { draft.mail = event.target.checked; },
      }), t("reminder.mail")]),
      !isNew ? facts([
        [t("reminder.stateTitle"), stateBadge(item.status)],
        [t("reminder.due"), reminderLine(item.status)],
        [t("reminder.lastTitle"), item.status.last_date ? t("reminder.last", { date: dateText(item.status.last_date), odometer: item.status.last_km != null ? km(item.status.last_km) : "—" }) : t("reminder.noEvents")],
        [t("reminder.count"), number(item.status.count)],
      ]) : null,
      error,
      el("div", { class: "dialog-actions" }, [
        !isNew ? el("button", {
          type: "button",
          class: "danger",
          onclick: async () => {
            if (!window.confirm(t("reminder.deleteConfirm", { name: item.category }))) return;
            try {
              await api(`/cars/${state.car.id}/reminders/${item.id}`, { method: "DELETE" });
              box.close();
              await reloadReminders();
              render();
            } catch (failure) {
              error.textContent = failure.message;
            }
          },
        }, t("delete")) : null,
        el("button", { type: "button", class: "ghost", "data-keep": true, onclick: () => box.close() }, t(readOnly() ? "close" : "cancel")),
        save,
      ]),
    ]));
    if (readOnly()) lock(box.node);
  }

  // Cars ------------------------------------------------------------------------

  // The last event of a car and how many it has: from the events loaded for
  // the open car, from the counts the API keeps for the others.
  function lastEventText(car) {
    const events = state.car && state.car.id === car.id && state.events ? state.events : null;
    const last = events ? events.reduce((found, event) => (String(event.date) > found ? String(event.date) : found), "") : car.last_event;
    const count = events ? events.length : car.event_count;
    if (!last) return count === 0 ? t("events.none") : "";
    return dateText(last) + (count != null ? " · " + t("export.events", { count }) : "");
  }

  function carsView() {
    return [
      readOnly() ? null : el("div", { class: "toolbar" }, [
        el("button", { type: "button", class: "primary", onclick: () => editCar(null) }, t("cars.add")),
        menuButton(t("io.import"), [[t("io.carExpenses"), () => importCarExpenses(null)], [t("io.json"), () => importJson(null)]]),
        state.cars.length ? menuButton(t("io.export"), [[t("io.json"), () => showExport(defaultCar())], [t("io.csv"), () => showCsv(defaultCar())]]) : null,
      ]),
      state.cars.length ? el("div", { class: "car-cards" }, state.cars.map((car) => el("section", { class: "panel car-card" + (car.sold ? " sold" : "") }, [
        el("div", { class: "panel-head" }, [
          el("h2", {}, [car.name, car.sold ? el("span", { class: "badge" }, t("car.sold")) : null]),
          el("button", { type: "button", class: "ghost", onclick: () => go("overview", car.id) }, t("cars.open")),
        ]),
        car.photo ? photoButton("car-photo", car.photo.path, car.name, true) : null,
        facts([
          [t("car.makeModel"), [car.make, car.model].filter(Boolean).join(" ")],
          [t("car.year"), car.year],
          ["VIN", car.vin ? el("span", { class: "mono" }, car.vin) : ""],
          [t("car.plate"), car.plate],
          [t("car.unit"), t("car.unit." + car.unit)],
          [t("car.currency"), car.currency],
          [t("car.lastEvent"), lastEventText(car)],
        ]),
        car.notes ? el("p", { class: "muted small pre" }, car.notes) : null,
        readOnly() ? null : el("div", { class: "actions" }, [
          el("button", { type: "button", class: "ghost", onclick: () => editCar(car) }, t("edit")),
        ]),
        readOnly() ? null : quickLinks(car),
      ]))) : welcomeView(),
    ];
  }

  function editCar(car) {
    const isNew = !car;
    const draft = { name: "", make: "", model: "", year: "", vin: "", plate: "", unit: "kWh", currency: "EUR", notes: "", sold: false, photo: null, ...(car || {}) };
    const box = dialog(t(isNew ? "car.new" : "car.edit"), () => pasteInto(null));
    const photo = el("div", { class: "car-photo-field" });
    const setPhoto = async (chosen) => {
      const file = chosen.find((item) => item.type.startsWith("image/"));
      if (!file) return;
      try {
        toast(t("event.uploading", { name: file.name }));
        draft.photo = await uploadFile(file);
        drawPhoto();
      } catch (failure) {
        toast(failure.message);
      }
    };
    const photoPicker = el("input", {
      type: "file",
      accept: "image/*",
      class: "hidden",
      onchange: (event) => {
        const chosen = [...event.target.files];
        event.target.value = "";
        setPhoto(chosen);
      },
    });
    const drawPhoto = () => fill(photo, [
      draft.photo ? photoButton("car-photo", draft.photo.path, draft.name || t("car.photo")) : null,
      el("div", { class: "paste-row" }, [
        el("button", { type: "button", class: "ghost", onclick: () => photoPicker.click() }, t("car.photoChoose")),
        draft.photo ? el("button", { type: "button", class: "ghost", onclick: () => { draft.photo = null; drawPhoto(); } }, t("car.photoRemove")) : null,
        el("span", { class: "muted small" }, t("event.pasteHint")),
      ]),
      photoPicker,
    ]);
    drawPhoto();
    pasteInto(setPhoto);
    const error = el("p", { class: "error", role: "alert" });
    const save = el("button", { type: "submit", class: "primary" }, t("save"));
    const input = (key, attrs) => el("input", { ...attrs, value: String(draft[key] ?? ""), oninput: (event) => { draft[key] = event.target.value; } });
    box.fill(el("form", {
      class: "fields",
      onsubmit: async (event) => {
        event.preventDefault();
        error.textContent = "";
        const body = {
          name: draft.name, make: draft.make, model: draft.model, year: draft.year === "" ? null : Number(draft.year), vin: draft.vin, plate: draft.plate,
          unit: draft.unit, currency: String(draft.currency).trim().toUpperCase(), notes: draft.notes, sold: Boolean(draft.sold),
          photo: draft.photo,
        };
        save.disabled = true;
        try {
          const saved = isNew ? await api("/cars", { method: "POST", body }) : await api(`/cars/${car.id}`, { method: "PUT", body });
          await loadCars();
          box.close();
          toast(t("car.saved"));
          if (isNew) go("overview", saved.id);
          else {
            if (state.car && state.car.id === saved.id) state.car = state.cars.find((item) => item.id === saved.id);
            render();
          }
        } catch (failure) {
          error.textContent = failure.message;
          save.disabled = false;
        }
      },
    }, [
      el("label", {}, [t("car.name"), input("name", { type: "text", required: true, maxlength: "100", placeholder: "Tesla Model X" })]),
      el("div", { class: "files-field" }, [el("span", { class: "label" }, t("car.photo")), photo]),
      el("div", { class: "form-grid" }, [
        el("label", {}, [t("car.make"), input("make", { type: "text", maxlength: "100" })]),
        el("label", {}, [t("car.model"), input("model", { type: "text", maxlength: "100" })]),
        el("label", {}, [t("car.year"), input("year", { type: "number", min: "1886", max: "2100", step: "1", inputmode: "numeric" })]),
        el("label", {}, [t("car.plate"), input("plate", { type: "text", maxlength: "20" })]),
      ]),
      el("label", {}, ["VIN", input("vin", { type: "text", maxlength: "32", class: "mono", autocapitalize: "characters" })]),
      el("div", { class: "form-grid" }, [
        el("label", {}, [t("car.unit"), el("select", { onchange: (event) => { draft.unit = event.target.value; } },
          ["kWh", "L"].map((value) => el("option", { value, selected: draft.unit === value }, t("car.unit." + value))))]),
        el("label", {}, [t("car.currency"), input("currency", { type: "text", maxlength: "3", pattern: "[A-Za-z]{3}", required: true })]),
      ]),
      el("label", {}, [t("car.notes"), el("textarea", { rows: "3", maxlength: "5000", oninput: (event) => { draft.notes = event.target.value; } }, draft.notes)]),
      el("label", { class: "check" }, [el("input", { type: "checkbox", checked: draft.sold, onchange: (event) => { draft.sold = event.target.checked; } }), t("car.soldCheck")]),
      error,
      el("div", { class: "dialog-actions" }, [
        !isNew ? el("button", {
          type: "button",
          class: "danger",
          onclick: async () => {
            if (window.prompt(t("car.deleteConfirm", { name: car.name })) !== car.name) return;
            try {
              await api(`/cars/${car.id}`, { method: "DELETE" });
              box.close();
              state.car = null;
              await loadCars();
              toast(t("car.deleted"));
              go("cars", "");
            } catch (failure) {
              error.textContent = failure.message;
            }
          },
        }, t("delete")) : null,
        el("button", { type: "button", class: "ghost", onclick: () => box.close() }, t("cancel")),
        save,
      ]),
    ]));
  }

  // A backup of the Android app Car Expenses: its pictures (PNG in base64,
  // most of the file) are cut out here, the text goes to the API
  // (lambda/carexpenses.py), and the pictures of the expenses that became
  // new events are uploaded as their files.
  function splitBackup(text) {
    const pictures = [];
    const rest = text.replace(/### image start info\r?\n[^\r\n]*\r?\n([^\r\n]*)\r?\n([\s\S]*?)### image end\r?\n?/g, (whole, owner, data) => {
      const [object, type] = owner.split("\t").map((part) => part.trim());
      pictures.push({ object, type, data: data.replace(/\s+/g, "") });
      return "";
    });
    const vehicles = [];
    const match = rest.match(/### vehicle info\r?\n([^\r\n]*)\r?\n([\s\S]*?)(?=\r?\n###)/);
    if (match) {
      const columns = match[1].split("\t").map((part) => part.trim());
      match[2].split(/\r?\n/).filter((line) => line.trim()).forEach((line) => {
        const cells = line.split("\t").map((part) => part.trim());
        vehicles.push(Object.fromEntries(columns.map((column, index) => [column, cells[index] || ""])));
      });
    }
    // The expenses of each vehicle, to tell its pictures from those of
    // vehicles and expenses that are not in the file any more.
    const expenses = {};
    vehicles.forEach((item) => {
      const name = item.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const found = rest.match(new RegExp(`### expenses info \\(${name}\\)\\r?\\n[^\\r\\n]*\\r?\\n([\\s\\S]*?)(?=\\r?\\n###|$)`));
      expenses[item.name] = new Set(found ? found[1].split(/\r?\n/).map((line) => line.split("\t")[0].trim()).filter(Boolean) : []);
    });
    return { text: rest, pictures, vehicles, expenses };
  }

  // Bulgarian leva to euro: the fixed rate of the euro in Bulgaria.
  const LEV_TO_EURO = 1.95583;

  function isLeva(currency) {
    return /^(lv|лв|bgn)\.?$/i.test(String(currency || "").trim());
  }

  // One vehicle of a backup into one car: the text to the API, then the
  // pictures of its expenses that became new events, and its own picture as
  // the car's photo when the car has none. The counts of what came in.
  async function carExpensesInto(car, backup, vehicle, rate, progress) {
    const answer = await api(`/cars/${car.id}/import/carexpenses`, { method: "POST", body: { text: backup.text, vehicle: vehicle.name, rate } });
    const own = backup.pictures.filter((item) => item.type === "2" && answer.expense_events[item.object]);
    const photo = backup.pictures.find((item) => item.type === "1" && item.object === answer.car_id);
    const picture = (item, name) => new File([Uint8Array.from(atob(item.data), (char) => char.charCodeAt(0))], name, { type: "image/png" });
    let uploaded = 0;
    for (const [index, item] of own.entries()) {
      progress(t("ce.uploading", { done: index, count: own.length }));
      try {
        const files = [await uploadFile(picture(item, `car-expenses-${item.object}-${index + 1}.png`))];
        await api(`/cars/${car.id}/events/${answer.expense_events[item.object]}/files`, { method: "POST", body: { files } });
        uploaded += 1;
      } catch (failure) {
        toast(failure.message);
      }
    }
    const photoSet = photo ? await photoIfNone(car, picture(photo, `${vehicle.name}.png`)) : false;
    return { answer, uploaded, photoSet };
  }

  // The photo of an import becomes the car's when the car has none: true
  // when it did.
  async function photoIfNone(car, file) {
    const current = await api(`/cars/${car.id}`);
    if (current.photo) return false;
    try {
      const photo = await uploadFile(file);
      const fields = ["name", "make", "model", "year", "vin", "plate", "unit", "currency", "notes", "sold"];
      await api(`/cars/${car.id}`, { method: "PUT", body: { ...Object.fromEntries(fields.map((key) => [key, current[key] ?? null])), photo } });
      return true;
    } catch (failure) {
      toast(failure.message);
      return false;
    }
  }

  // A file of exportCar into a car: the events and reminders to the API,
  // then the receipts and photos inside the file, uploaded anew as this
  // user's files, on the events that are new, and the car's photo.
  async function jsonInto(car, data, progress) {
    const strip = (event) => Object.fromEntries(Object.entries(event).filter(([key]) => key !== "files"));
    const answer = await api(`/cars/${car.id}/import/json`, {
      method: "POST",
      body: { format: data.format, version: data.version, car: data.car, events: data.events.map(strip), reminders: data.reminders || [] },
    });
    const inside = data.files || {};
    const asFile = (entry) => {
      const found = inside[entry.path];
      if (!found) return null;
      const bytes = Uint8Array.from(atob(found.data), (char) => char.charCodeAt(0));
      return new File([bytes], entry.name || entry.path.split("/").pop(), { type: entry.type || found.type || "application/octet-stream" });
    };
    const pending = data.events.filter((event) => answer.event_ids[event.id] && (event.files || []).length);
    const total = pending.reduce((sum, event) => sum + event.files.length, 0);
    let uploaded = 0;
    let missing = 0;
    for (const event of pending) {
      const files = [];
      for (const entry of event.files) {
        progress(t("ce.uploading", { done: uploaded + missing, count: total }));
        const file = asFile(entry);
        if (!file) {
          missing += 1;
          continue;
        }
        try {
          files.push({ ...(await uploadFile(file)), name: entry.name || file.name });
          uploaded += 1;
        } catch (failure) {
          missing += 1;
          toast(failure.message);
        }
      }
      if (files.length) await api(`/cars/${car.id}/events/${answer.event_ids[event.id]}/files`, { method: "POST", body: { files } });
    }
    const photo = data.car && data.car.photo && asFile({ ...data.car.photo, name: data.car.photo.name || "photo" });
    const photoSet = photo ? await photoIfNone(car, photo) : false;
    return { answer, uploaded, missing, photoSet };
  }

  // car: the car to import into, or null for a new car named as in the file.
  function importJson(car) {
    const box = dialog(car ? t("json.title", { name: car.name }) : t("json.titleNew"));
    let data = null;
    const info = el("div");
    const result = el("div");
    const button = el("button", { type: "submit", class: "primary", disabled: true }, t("import.start"));
    const picker = el("input", {
      type: "file",
      accept: ".json,application/json",
      required: true,
      onchange: async (event) => {
        const file = event.target.files[0];
        data = null;
        button.disabled = true;
        fill(result, []);
        if (!file) return;
        fill(info, el("p", { class: "muted" }, t("ce.reading")));
        try {
          data = JSON.parse(await file.text());
        } catch (error) {
          data = null;
        }
        if (!data || !EXPORT_FORMATS.includes(data.format) || !Array.isArray(data.events)) {
          fill(info, el("p", { class: "error" }, t("api.bad_export")));
          data = null;
          return;
        }
        const files = Object.keys(data.files || {}).length;
        fill(info, el("p", {}, t("json.found", { name: (data.car && data.car.name) || "—", events: data.events.length, reminders: (data.reminders || []).length, files })));
        button.disabled = false;
      },
    });
    box.fill(el("form", {
      class: "fields",
      onsubmit: async (event) => {
        event.preventDefault();
        if (!data) return;
        button.disabled = true;
        const progress = (text) => fill(result, el("p", { class: "muted" }, text));
        try {
          progress(t("import.running"));
          const source = data.car || {};
          const target = car || await api("/cars", {
            method: "POST",
            body: {
              ...Object.fromEntries(["make", "model", "year", "vin", "plate", "notes", "sold"].map((key) => [key, source[key] ?? null])),
              name: source.name || t("json.unnamed"), unit: source.unit || "kWh", currency: source.currency || "EUR",
            },
          });
          const outcome = await jsonInto(target, data, progress);
          const { answer } = outcome;
          fill(result, el("div", { class: "secret-note" }, [
            el("p", {}, el("strong", {}, target.name)),
            el("ul", { class: "plain" }, [
              ...KINDS.map((kind) => el("li", {}, t("ce.kind", { kind: kindName(kind, target.unit), count: answer.created[kind] }))),
              el("li", {}, t("import.unchanged", { count: answer.unchanged })),
              el("li", {}, t("import.reminders", { created: answer.reminders_created, updated: answer.reminders_updated })),
              el("li", {}, t("ce.pictures", { count: outcome.uploaded })),
              outcome.missing ? el("li", { class: "error" }, t("json.missing", { count: outcome.missing })) : null,
              outcome.photoSet ? el("li", {}, t("ce.photo")) : null,
            ]),
          ]));
          await loadCars();
          if (state.car) {
            state.car = state.cars.find((known) => known.id === state.car.id) || state.car;
            await loadCar();
          }
          render();
        } catch (failure) {
          fill(result, el("p", { class: "error" }, failure.message));
        }
        button.disabled = false;
      },
    }, [
      state.cars.length ? carChoice(car, "io.newCar", (next) => { box.close(); importJson(next); }) : null,
      el("p", {}, t(car ? "json.intro" : "json.introNew")),
      el("ul", { class: "hint-list" }, ["json.ruleEvents", "json.ruleFiles", "json.ruleAgain"].map((key) => el("li", { class: "hint" }, t(key)))),
      el("label", {}, [t("json.file"), picker]),
      info,
      el("div", { class: "dialog-actions" }, [el("button", { type: "button", class: "ghost", onclick: () => box.close() }, t("close")), button]),
      result,
    ]));
  }

  function carExpensesSummary(title, car, outcome) {
    const { answer } = outcome;
    return el("div", { class: "secret-note" }, [
      el("p", {}, el("strong", {}, title)),
      el("ul", { class: "plain" }, [
        ...KINDS.map((kind) => el("li", {}, t("ce.kind", { kind: kindName(kind, car.unit), count: answer.created[kind] }))),
        el("li", {}, t("import.unchanged", { count: answer.unchanged })),
        el("li", {}, t("import.reminders", { created: answer.reminders_created, updated: answer.reminders_updated })),
        el("li", {}, t("ce.pictures", { count: outcome.uploaded })),
        outcome.photoSet ? el("li", {}, t("ce.photo")) : null,
      ]),
    ]);
  }

  // car: the car to import into, or null for new cars, one for each vehicle
  // of the backup that is ticked.
  function importCarExpenses(car) {
    const box = dialog(car ? t("ce.title", { name: car.name }) : t("ce.titleNew"));
    let backup = null;
    const info = el("div");
    const result = el("div");
    const vehicle = el("select", { class: "hidden" });
    const ticks = el("div", { class: "fields" });
    const convert = el("input", { type: "checkbox", checked: true });
    const convertRow = el("label", { class: "check hidden" }, [convert, t("ce.convert", { rate: number(LEV_TO_EURO, 5) })]);
    const button = el("button", { type: "submit", class: "primary", disabled: true }, t("import.start"));
    const chosen = () => (car
      ? [backup.vehicles.find((item) => item.name === vehicle.value) || backup.vehicles[0]]
      : backup.vehicles.filter((item, index) => ticks.querySelectorAll("input")[index].checked));
    const describe = () => {
      const list = chosen();
      // Leva come into a car in euro; new cars are in euro too when converted.
      const leva = list.some((item) => isLeva(item.currency)) && (!car || String(car.currency).toUpperCase() === "EUR");
      convertRow.classList.toggle("hidden", !leva);
      fill(info, list.map((item) => el("p", {}, t("ce.found", {
        name: item.name, currency: item.currency || "—",
        pictures: backup.pictures.filter((picture) => picture.type === "2" && backup.expenses[item.name].has(picture.object)).length,
      }))));
      button.disabled = !list.length;
    };
    const picker = el("input", {
      type: "file",
      accept: ".csv,.txt,text/csv,text/plain",
      required: true,
      onchange: async (event) => {
        const file = event.target.files[0];
        backup = null;
        button.disabled = true;
        fill(result, []);
        if (!file) return;
        fill(info, el("p", { class: "muted" }, t("ce.reading")));
        backup = splitBackup(await file.text());
        if (!backup.vehicles.length) {
          fill(info, el("p", { class: "error" }, t("api.bad_carexpenses")));
          backup = null;
          return;
        }
        if (car) {
          fill(vehicle, backup.vehicles.map((item) => el("option", { value: item.name }, item.name)));
          vehicle.classList.toggle("hidden", backup.vehicles.length < 2);
          vehicle.onchange = describe;
        } else {
          fill(ticks, [el("span", { class: "label" }, t("ce.vehicles")), ...backup.vehicles.map((item) => el("label", { class: "check" }, [
            el("input", { type: "checkbox", checked: !state.cars.some((known) => known.name === item.name), onchange: describe }),
            item.name + (item.comment ? " · " + item.comment : ""),
          ]))]);
        }
        convert.checked = true;
        describe();
      },
    });
    box.fill(el("form", {
      class: "fields",
      onsubmit: async (event) => {
        event.preventDefault();
        if (!backup) return;
        button.disabled = true;
        const summaries = [];
        const progress = (text) => fill(result, [...summaries, el("p", { class: "muted" }, text)]);
        try {
          for (const item of chosen()) {
            const rate = isLeva(item.currency) && !convertRow.classList.contains("hidden") && convert.checked ? 1 / LEV_TO_EURO : 1;
            progress(t("ce.importing", { name: item.name }));
            const target = car || await api("/cars", {
              method: "POST",
              body: { name: item.name, unit: item.engine_type === "4" ? "kWh" : "L", currency: isLeva(item.currency) && rate === 1 ? "BGN" : "EUR" },
            });
            const outcome = await carExpensesInto(target, backup, item, rate, progress);
            summaries.push(carExpensesSummary(target.name, target, outcome));
            fill(result, summaries);
          }
          await loadCars();
          if (state.car) {
            state.car = state.cars.find((known) => known.id === state.car.id) || state.car;
            await loadCar();
          }
          render();
        } catch (failure) {
          fill(result, [...summaries, el("p", { class: "error" }, failure.message)]);
        }
        button.disabled = false;
      },
    }, [
      state.cars.length ? carChoice(car, "io.newCars", (next) => { box.close(); importCarExpenses(next); }) : null,
      el("p", {}, t(car ? "ce.intro" : "ce.introNew")),
      el("ul", { class: "hint-list" }, ["ce.ruleFile", "ce.ruleRecords", "ce.ruleExpenses", "ce.rulePatterns", "ce.rulePictures", "import.ruleAgain"]
        .map((key) => el("li", { class: "hint" }, t(key)))),
      el("label", {}, [t("ce.file"), picker]),
      vehicle,
      ticks,
      info,
      convertRow,
      el("div", { class: "dialog-actions" }, [el("button", { type: "button", class: "ghost", onclick: () => box.close() }, t("close")), button]),
      result,
    ]));
  }

  // Settings ---------------------------------------------------------------

  function showAccount(section) {
    // Visitors of the demo share one account: none may change its password or
    // turn on two-factor authentication for the others.
    const sections = [...(config.demo ? [] : [["password", t("password.title")], ["mfa", t("mfa.title")]]),
      ["language", t("language.title")], ["mail", t("mail.title")], ["api", t("keys.title")], ["share", t("shares.title")]];
    if (state.me.admin) sections.push(["users", t("users.title")]);
    sections.push(["version", t("version.title")]);
    let current = sections.some(([key]) => key === section) ? section : sections[0][0];
    const body = el("div", { class: "settings-body" });
    const tabs = el("div", { class: "tabs", role: "tablist" });
    const close = () => {
      wrap.remove();
      document.removeEventListener("keydown", onKey);
    };
    const onKey = (event) => {
      if (event.key === "Escape") close();
    };
    const wrap = el("div", { class: "dialog-wrap", onclick: (event) => { if (event.target === wrap) close(); } }, [
      el("section", { class: "dialog wide", role: "dialog", "aria-modal": "true", "aria-label": t("account.title") }, [
        el("header", { class: "dialog-head" }, [
          el("h2", {}, t("account.title")),
          el("button", { type: "button", class: "icon-button", onclick: close }, t("close")),
        ]),
        tabs,
        body,
      ]),
    ]);
    function draw() {
      tabs.replaceChildren(...sections.map(([key, label]) => el("button", {
        type: "button",
        role: "tab",
        class: key === current ? "tab active" : "tab",
        "aria-selected": String(key === current),
        onclick: () => {
          current = key;
          draw();
        },
      }, label)));
      body.replaceChildren();
      if (current === "password") body.append(passwordForm());
      else if (current === "mfa") showMfa(body);
      else if (current === "mail") showMail(body);
      else if (current === "api") showKeys(body);
      else if (current === "share") showShares(body);
      else if (current === "users") showUsers(body);
      else if (current === "version") showVersion(body);
      else {
        body.append(languagePicker(async (code) => {
          await saveLanguage(code);
          // Everything on screen is redrawn in the new language.
          close();
          render();
          showAccount("language");
        }));
      }
    }
    document.querySelector(".dialog-wrap")?.remove();
    document.addEventListener("keydown", onKey);
    document.body.append(wrap);
    draw();
  }

  // Where and when a key or a link was made and last used (access.py).
  function usage(item) {
    const where = (ip, agent) => [ip, agent].filter(Boolean).join(" · ");
    return el("dl", { class: "usage small" }, [
      el("dt", {}, t("access.created")),
      el("dd", {}, [when(item.created), item.created_ip || item.created_agent ? el("span", { class: "muted" }, " · " + where(item.created_ip, item.created_agent)) : null]),
      el("dt", {}, t("access.lastUsed")),
      el("dd", {}, item.last_used ? [when(item.last_used), el("span", { class: "muted" }, " · " + where(item.last_ip, item.last_agent))] : el("span", { class: "muted" }, t("access.never"))),
      el("dt", {}, t("access.uses")),
      el("dd", {}, number(item.uses || 0)),
    ]);
  }

  function copyButton(text) {
    return el("button", {
      type: "button",
      class: "ghost",
      onclick: async () => {
        try {
          await navigator.clipboard.writeText(text);
          toast(t("access.copied"));
        } catch (error) {
          window.prompt(t("quick.copy"), text);
        }
      },
    }, t("quick.copy"));
  }

  // API keys: a program reads, or writes, the user's cars through
  // /api/v1/cars with one of them; a key is shown once, when it is made.
  async function showKeys(part) {
    part.replaceChildren(loading());
    let items;
    try {
      items = (await api("/keys")).items || [];
    } catch (error) {
      part.replaceChildren(el("p", { class: "error" }, error.message));
      return;
    }
    const base = location.origin + "/api/v1";
    const name = el("input", { type: "text", maxlength: "100", placeholder: t("keys.namePlaceholder"), required: true });
    const scope = el("select", {}, ["read", "write"].map((value) => el("option", { value }, t("keys.scope." + value))));
    fill(part, [
      el("p", { class: "muted small" }, t("keys.hint")),
      el("pre", { class: "code" }, `curl -H "Authorization: Bearer cars_…" ${base}/cars\ncurl -H "Authorization: Bearer cars_…" ${base}/cars/<id>/events\ncurl -X POST -H "Authorization: Bearer cars_…" -H "Content-Type: application/json" \\\n  -d '{"kind":"refuel","date":"2026-10-19T08:30","quantity":30,"price":0.35}' ${base}/cars/<id>/events`),
      el("form", {
        class: "inline-form",
        onsubmit: async (event) => {
          event.preventDefault();
          try {
            const made = await api("/keys", { method: "POST", body: { name: name.value.trim(), scope: scope.value } });
            await showKeys(part);
            part.prepend(el("div", { class: "secret-box" }, [
              el("strong", {}, t("keys.made", { name: made.name })),
              el("p", { class: "small" }, t("keys.once")),
              el("div", { class: "secret-row" }, [el("code", { class: "mono" }, made.key), copyButton(made.key)]),
            ]));
          } catch (error) {
            toast(error.message);
          }
        },
      }, [el("label", {}, [t("keys.name"), name]), el("label", {}, [t("keys.scope"), scope]), el("button", { type: "submit", class: "primary" }, t("keys.create"))]),
      items.length ? el("ul", { class: "access-list" }, items.map((item) => el("li", {}, [
        el("div", { class: "access-head" }, [
          el("strong", {}, item.name),
          el("span", { class: "badge" }, t("keys.scope." + item.scope)),
          el("code", { class: "mono small muted" }, item.hint),
          el("button", {
            type: "button",
            class: "danger",
            onclick: async () => {
              if (!window.confirm(t("keys.deleteConfirm", { name: item.name }))) return;
              try {
                await api("/keys?id=" + encodeURIComponent(item.id), { method: "DELETE" });
                showKeys(part);
              } catch (error) {
                toast(error.message);
              }
            },
          }, t("delete")),
        ]),
        usage(item),
      ]))) : el("p", { class: "muted" }, t("keys.none")),
    ]);
  }

  function shareLink(item) {
    return location.origin + "/#s/" + item.token + "/overview" + (item.car ? "/" + item.car : "");
  }

  // Links that open the cars, or one car, read only without a sign-in.
  async function showShares(part) {
    part.replaceChildren(loading());
    let items;
    let cars;
    try {
      [items, cars] = await Promise.all([api("/shares").then((data) => data.items || []), api("/cars", { own: true }).then((data) => data.items || [])]);
    } catch (error) {
      part.replaceChildren(el("p", { class: "error" }, error.message));
      return;
    }
    const carName = (id) => (cars.find((car) => car.id === id) || {}).name || id;
    const name = el("input", { type: "text", maxlength: "100", placeholder: t("shares.namePlaceholder") });
    const car = el("select", {}, [el("option", { value: "" }, t("shares.allCars")), ...cars.map((item) => el("option", { value: item.id }, item.name))]);
    const days = el("select", {}, [["", t("shares.forever")], ["1", t("shares.days", { count: 1 })], ["7", t("shares.days", { count: 7 })],
      ["30", t("shares.days", { count: 30 })], ["90", t("shares.days", { count: 90 })], ["365", t("shares.days", { count: 365 })]]
      .map(([value, label]) => el("option", { value }, label)));
    fill(part, [
      el("p", { class: "muted small" }, t("shares.hint")),
      el("form", {
        class: "inline-form",
        onsubmit: async (event) => {
          event.preventDefault();
          try {
            await api("/shares", { method: "POST", body: { name: name.value.trim(), car: car.value || null, days: days.value ? Number(days.value) : null } });
            toast(t("shares.made"));
            showShares(part);
          } catch (error) {
            toast(error.message);
          }
        },
      }, [el("label", {}, [t("keys.name"), name]), el("label", {}, [t("shares.car"), car]), el("label", {}, [t("shares.expires"), days]),
        el("button", { type: "submit", class: "primary" }, t("shares.create"))]),
      items.length ? el("ul", { class: "access-list" }, items.map((item) => {
        const link = shareLink(item);
        const expired = item.expires && item.expires < new Date().toISOString().slice(0, 19) + "Z";
        return el("li", { class: expired ? "expired" : "" }, [
          el("div", { class: "access-head" }, [
            el("strong", {}, item.name || t("shares.unnamed")),
            el("span", { class: "badge" }, item.car ? carName(item.car) : t("shares.allCars")),
            el("span", { class: "muted small" }, item.expires ? t(expired ? "shares.expired" : "share.until", { date: when(item.expires) }) : t("shares.forever")),
          ]),
          el("div", { class: "secret-row" }, [
            el("a", { class: "mono small", href: link, target: "_blank", rel: "noopener" }, link),
            copyButton(link),
            el("button", {
              type: "button",
              class: "ghost",
              onclick: () => {
                const qr = window.qrcode(0, "M");
                qr.addData(link);
                qr.make();
                dialog(item.name || t("shares.unnamed")).fill([el("img", { class: "qr", src: qr.createDataURL(6, 2), alt: link }), el("p", { class: "mono small" }, link)]);
              },
            }, t("quick.qr")),
            el("button", {
              type: "button",
              class: "danger",
              onclick: async () => {
                if (!window.confirm(t("shares.deleteConfirm"))) return;
                try {
                  await api("/shares?id=" + encodeURIComponent(item.id), { method: "DELETE" });
                  showShares(part);
                } catch (error) {
                  toast(error.message);
                }
              },
            }, t("delete")),
          ]),
          usage(item),
        ]);
      })) : el("p", { class: "muted" }, t("shares.none")),
    ]);
  }

  // Whether the user gets the reminders that are due by mail.
  function showMail(part) {
    fill(part, [
      state.me.mail ? null : el("p", { class: "demo-note" }, t("mail.off")),
      el("p", { class: "muted small" }, t("mail.hint", { email: state.me.email })),
      el("label", { class: "check" }, [el("input", {
        type: "checkbox",
        checked: state.me.prefs.reminders,
        onchange: async (event) => {
          try {
            state.me.prefs = await api("/me/prefs", { method: "PUT", body: { reminders: event.target.checked } });
            toast(t("mail.saved"));
          } catch (error) {
            event.target.checked = !event.target.checked;
            toast(error.message);
          }
        },
      }), t("mail.reminders")]),
    ]);
  }

  // Administrators: the accounts. A new user gets an invitation from Cognito;
  // the temporary password is also shown here once.
  function showUsers(part) {
    const note = el("div");
    const list = el("div", { class: "table-wrap" }, loading());
    const email = el("input", { type: "email", required: true, placeholder: "name@example.com", "aria-label": t("users.newEmail") });
    const admin = el("input", { type: "checkbox" });
    const invite = el("form", {
      class: "invite",
      onsubmit: async (event) => {
        event.preventDefault();
        try {
          const created = await api("/admin/users", { method: "POST", body: { email: email.value.trim(), admin: admin.checked } });
          note.replaceChildren(secretNote(created.email, created.temporary_password, true));
          email.value = "";
          admin.checked = false;
          await draw();
        } catch (error) {
          toast(error.message);
        }
      },
    }, [
      email,
      el("label", { class: "check" }, [admin, t("users.admin")]),
      el("button", { type: "submit", class: "primary" }, t("users.invite")),
    ]);
    part.replaceChildren(el("p", { class: "muted small" }, t("users.hint")), invite, note, list);

    async function update(user, changes, question) {
      if (question && !window.confirm(question)) return;
      try {
        const result = await api("/admin/users", { method: "PUT", body: { email: user.email, ...changes } });
        if (result.temporary_password) note.replaceChildren(secretNote(user.email, result.temporary_password, false));
        else toast(t("users.saved"));
      } catch (error) {
        toast(error.message);
      }
      await draw();
    }

    async function remove(user) {
      if (!window.confirm(t("users.deleteConfirm", { email: user.email }))) return;
      try {
        await api(`/admin/users?email=${encodeURIComponent(user.email)}`, { method: "DELETE" });
        toast(t("users.deleted"));
      } catch (error) {
        toast(error.message);
      }
      await draw();
    }

    async function draw() {
      let users;
      try {
        users = (await api("/admin/users")).items || [];
      } catch (error) {
        list.replaceChildren(el("p", { class: "error" }, error.message));
        return;
      }
      list.replaceChildren(el("table", { class: "users" }, [
        el("thead", {}, el("tr", {}, [t("users.email"), t("users.status"), "2FA", t("users.admin"), ""].map((text) => el("th", {}, text)))),
        el("tbody", {}, users.map((user) => el("tr", { class: user.enabled ? "" : "disabled" }, [
          el("td", {}, [user.email, user.self ? el("span", { class: "muted" }, " " + t("users.you")) : null]),
          el("td", {}, user.enabled ? t("users.state." + user.status) : t("users.disabled")),
          el("td", { class: user.mfa ? "" : "muted" }, [el("span", { class: "narrow-only" }, "2FA: "), t(user.mfa ? "users.mfaOn" : "users.mfaOff")]),
          el("td", {}, el("label", { class: "admin-toggle" }, [
            el("input", {
              type: "checkbox",
              checked: user.admin,
              disabled: user.self,
              "aria-label": t("users.adminOf", { email: user.email }),
              onchange: (event) => update(user, { admin: event.target.checked }),
            }),
            el("span", { class: "narrow-only" }, t("users.admin")),
          ])),
          el("td", { class: "row-actions" }, user.self ? null : [
            el("button", { type: "button", onclick: () => update(user, { reset_password: true }, t("users.resetPasswordConfirm", { email: user.email })) }, t("users.resetPassword")),
            user.mfa ? el("button", { type: "button", onclick: () => update(user, { reset_mfa: true }, t("users.resetMfaConfirm", { email: user.email })) }, t("users.resetMfa")) : null,
            el("button", { type: "button", onclick: () => update(user, { enabled: !user.enabled }) }, t(user.enabled ? "users.disable" : "users.enable")),
            el("button", { type: "button", class: "danger", onclick: () => remove(user) }, t("users.delete")),
          ]),
        ]))),
      ]));
    }
    draw();
    email.focus();
  }

  function secretNote(email, password, invited) {
    return el("div", { class: "secret-note" }, [
      el("p", {}, t(invited ? "users.invited" : "users.newPassword", { email })),
      el("p", {}, [t("users.temporaryPassword") + " ", el("code", {}, password)]),
    ]);
  }

  // The version of the site and the releases of the demo repository that came
  // after it, with their notes. The API reads them from GitHub and keeps them
  // an hour.
  async function showVersion(part) {
    part.replaceChildren(loading());
    let info;
    try {
      info = await api("/version");
    } catch (error) {
      part.replaceChildren(el("p", { class: "error" }, error.message));
      return;
    }
    const link = (href, text) => el("a", { href, target: "_blank", rel: "noopener" }, text);
    let status;
    if (info.error) status = el("p", { class: "error" }, t("version.unavailable"));
    else if (!info.repository) status = el("p", { class: "muted" }, t("version.off"));
    else if (!info.latest) status = el("p", { class: "muted" }, t("version.none"));
    else if (!info.newer.length) status = el("p", { class: "totp-status" }, [el("span", { class: "badge ok" }, t("version.current")), " ", t("version.newest")]);
    else status = el("p", { class: "totp-status" }, [el("span", { class: "badge warn" }, t("version.behind")), " ", t("version.newer", { count: info.newer.length })]);
    fill(part, [
      el("dl", { class: "version-facts" }, [
        el("dt", {}, t("version.title")),
        el("dd", {}, info.version && info.url ? link(info.url + "/tag/" + encodeURIComponent(info.version), info.version) : info.version || "—"),
        el("dt", {}, t("version.repository")),
        el("dd", {}, info.repository ? link(info.url, info.repository) : "—"),
      ]),
      status,
      info.newer.length ? el("ul", { class: "releases" }, info.newer.map((release) => el("li", {}, [
        el("strong", {}, link(release.url, release.title)),
        release.date ? el("span", { class: "muted" }, " · " + release.date) : null,
        release.notes ? el("p", { class: "release-notes" }, release.notes) : null,
      ]))) : null,
    ]);
  }

  function passwordForm() {
    const error = el("p", { class: "error", role: "alert" });
    const current = el("input", { type: "password", autocomplete: "current-password", required: true });
    const next = el("input", { type: "password", autocomplete: "new-password", required: true, minlength: "12" });
    const again = el("input", { type: "password", autocomplete: "new-password", required: true, minlength: "12" });
    const button = el("button", { class: "primary", type: "submit" }, t("password.submit"));
    const form = el("form", {
      onsubmit: async (event) => {
        event.preventDefault();
        error.textContent = "";
        if (next.value !== again.value) {
          error.textContent = t("password.mismatch");
          return;
        }
        button.disabled = true;
        try {
          const { user } = await currentUser();
          await cognito((done) => user.changePassword(current.value, next.value, done));
          form.reset();
          toast(t("password.changed"));
        } catch (failure) {
          error.textContent = authMessage(failure);
        }
        button.disabled = false;
      },
    }, [
      el("label", {}, [t("password.current"), current]),
      el("label", {}, [t("password.new"), next]),
      el("label", {}, [t("password.again"), again]),
      el("p", { class: "muted small" }, t("password.rules")),
      el("div", { class: "actions" }, [button]),
      error,
    ]);
    return form;
  }

  // Two-factor sign-in with an authenticator app (TOTP): Cognito gives a
  // secret, the app shows codes, one code confirms the pairing.
  async function showMfa(part) {
    part.replaceChildren(loading());
    let enabled;
    try {
      const { user } = await currentUser();
      const data = await cognito((done) => user.getUserData(done, { bypassCache: true }));
      enabled = (data.UserMFASettingList || []).includes("SOFTWARE_TOKEN_MFA");
    } catch (error) {
      part.replaceChildren(el("p", { class: "error" }, authMessage(error)));
      return;
    }
    if (enabled) {
      part.replaceChildren(
        el("p", {}, [el("span", { class: "badge ok" }, t("mfa.on")), t("mfa.onText")]),
        el("div", { class: "actions" }, el("button", {
          type: "button",
          class: "danger",
          onclick: async () => {
            if (!window.confirm(t("mfa.disableConfirm"))) return;
            try {
              const { user } = await currentUser();
              await cognito((done) => user.setUserMfaPreference(null, { PreferredMfa: false, Enabled: false }, done));
              toast(t("mfa.disabled"));
            } catch (error) {
              toast(authMessage(error));
            }
            showMfa(part);
          },
        }, t("mfa.disable"))));
      return;
    }
    part.replaceChildren(
      el("p", { class: "muted" }, t("mfa.offText")),
      el("div", { class: "actions" }, el("button", { type: "button", class: "primary", onclick: () => pairApp(part) }, t("mfa.enable"))));
  }

  async function pairApp(part) {
    let user;
    let secret;
    try {
      user = (await currentUser()).user;
      secret = await new Promise((resolve, reject) => user.associateSoftwareToken({
        associateSecretCode: resolve,
        onFailure: reject,
      }));
    } catch (error) {
      toast(authMessage(error));
      return;
    }
    const uri = `otpauth://totp/${encodeURIComponent(ISSUER + ":" + state.me.email)}?secret=${secret}&issuer=${encodeURIComponent(ISSUER)}`;
    const qr = window.qrcode(0, "M");
    qr.addData(uri);
    qr.make();
    const error = el("p", { class: "error", role: "alert" });
    const code = el("input", { type: "text", inputmode: "numeric", autocomplete: "one-time-code", pattern: "[0-9]{6}", maxlength: "6", required: true });
    const button = el("button", { class: "primary", type: "submit" }, t("mfa.submit"));
    part.replaceChildren(el("form", {
      class: "pair",
      onsubmit: async (event) => {
        event.preventDefault();
        error.textContent = "";
        button.disabled = true;
        try {
          await new Promise((resolve, reject) => user.verifySoftwareToken(code.value.trim(), ISSUER, { onSuccess: resolve, onFailure: reject }));
          await cognito((done) => user.setUserMfaPreference(null, { PreferredMfa: true, Enabled: true }, done));
          toast(t("mfa.enabled"));
          showMfa(part);
        } catch (failure) {
          error.textContent = authMessage(failure);
          button.disabled = false;
        }
      },
    }, [
      el("p", {}, t("mfa.step1")),
      el("img", { class: "qr", src: qr.createDataURL(5, 2), alt: t("mfa.qrAlt"), width: "205", height: "205" }),
      el("p", { class: "mono secret" }, secret),
      el("label", {}, [t("mfa.step2"), code]),
      el("div", { class: "actions" }, [button]),
      error,
    ]));
    code.focus();
  }

  // A share link opens without a sign-in: what the link allows, read only.
  async function bootShare(token) {
    state.share = token;
    try {
      const info = await api("");
      state.me = { email: "", admin: false, share: info, lead_days: info.lead_days, lead_km: info.lead_km, file_max_bytes: 0 };
      await loadCars();
    } catch (error) {
      root.replaceChildren(el("main", { class: "login" }, el("div", { class: "login-card" }, [
        el("img", { class: "login-mark", src: "/favicon.svg", alt: "" }),
        el("h1", {}, t("brand")),
        el("p", { class: "error" }, error.code === "share_not_found" ? t("api.share_not_found") : error.message),
      ])));
      return;
    }
    if (!listening) window.addEventListener("hashchange", show);
    listening = true;
    show();
  }

  async function boot() {
    const shared = location.hash.match(/^#s\/([^/]+)/);
    if (shared) return bootShare(decodeURIComponent(shared[1]));
    if (!window.AmazonCognitoIdentity || !config.userPoolId || !config.clientId) {
      root.textContent = t("noAuth");
      return;
    }
    try {
      await currentSession().catch((error) => {
        if (!looksOffline(error)) throw error;
      });
      await loadLanguage();
      state.me = await api("/me");
      if (state.me.admin) {
        try {
          state.owners = (await api("/admin/owners")).items || [];
        } catch (error) {
          state.owners = [];
        }
      }
      state.owner = hashOwner();
      state.ownerLoaded = state.owner;
      await loadCars();
    } catch (error) {
      if (!document.querySelector(".login")) showLogin();
      return;
    }
    if (!listening) window.addEventListener("hashchange", show);
    listening = true;
    show();
    countPending().then(() => flushOutbox());
  }

  // The service worker keeps the page and what it read for the times without
  // a network (sw.js).
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
  }

  setLanguage(known(stored(LANGUAGE_KEY)) ? stored(LANGUAGE_KEY) : browserLanguage());
  if (stats.STEPS.includes(stored(STEP_KEY))) state.step = stored(STEP_KEY);
  boot();
})();
