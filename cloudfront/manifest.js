// A short form has an address of its own, /add/<kind>/<car>/, so that a phone
// adds the form to its home screen, not the start page. Safari on iOS opens
// the start_url of the manifest the page links, and the page links it
// relatively (manifest.json): on the start page that is /manifest.json in the
// bucket, on a short form /add/<kind>/<car>/manifest.json, made here with the
// form as its start_url. The form itself is the page, index.html. Every other
// request goes on to the bucket unchanged.
var FORM = /^\/add\/(refuel|service|expense|income)\/([0-9a-z]{6})(\/|\/manifest\.json)?$/;

// The name under the icon; the page offers its own (the kind and the car) in
// apple-mobile-web-app-title, and the phone lets it be changed.
var NAMES = {
  ru: {refuel: 'Заправка', service: 'Сервис', expense: 'Расход', income: 'Доход'},
  en: {refuel: 'Refuel', service: 'Service', expense: 'Expense', income: 'Income'},
  fr: {refuel: 'Plein', service: 'Entretien', expense: 'Dépense', income: 'Revenu'},
  it: {refuel: 'Rifornimento', service: 'Tagliando', expense: 'Spesa', income: 'Entrata'}
};

function language(request) {
  var header = request.headers['accept-language'];
  var first = header ? header.value.split(',')[0].trim().slice(0, 2).toLowerCase() : '';
  return NAMES[first] ? first : 'en';
}

function handler(event) {
  var request = event.request;
  var match = FORM.exec(request.uri);
  if (!match) {
    return request;
  }
  var path = '/add/' + match[1] + '/' + match[2] + '/';
  if (!match[3]) {
    // Without the closing slash manifest.json would not be the form's.
    return {
      statusCode: 301,
      statusDescription: 'Moved Permanently',
      headers: {location: {value: path}}
    };
  }
  if (match[3] === '/') {
    request.uri = '/index.html';
    return request;
  }
  var name = NAMES[language(request)][match[1]];
  var manifest = {
    id: path,
    name: name,
    short_name: name,
    start_url: path,
    scope: '/',
    display: 'standalone',
    background_color: '#f6f7f9',
    theme_color: '#0f766e',
    icons: [{src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any'}]
  };
  return {
    statusCode: 200,
    statusDescription: 'OK',
    headers: {
      'content-type': {value: 'application/manifest+json'},
      'cache-control': {value: 'no-cache'}
    },
    body: {encoding: 'text', data: JSON.stringify(manifest)}
  };
}
