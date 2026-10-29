// The web app manifest of a short form, made on the edge: a phone that adds
// /#add/<kind>/<car> to its home screen opens that form, not the start page.
// The page links /manifest/add/<kind>/<car>.json?name=<name> on a short form;
// Safari on iOS and Chrome take start_url from the manifest. Every other
// request goes on to the bucket unchanged.
var FORM = /^\/manifest\/add\/(refuel|service|expense|income)\/([0-9a-z]{6})\.json$/;

function handler(event) {
  var request = event.request;
  var match = FORM.exec(request.uri);
  if (!match) {
    return request;
  }
  var path = '/add/' + match[1] + '/' + match[2];
  var name = '';
  if (request.querystring.name) {
    try {
      name = decodeURIComponent(request.querystring.name.value.replace(/\+/g, ' '));
    } catch (error) {
      name = '';
    }
  }
  name = name.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 60) || 'Cars';
  var manifest = {
    id: path,
    name: name,
    short_name: name.split(' · ')[0].slice(0, 30),
    start_url: '/#' + path.slice(1),
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
