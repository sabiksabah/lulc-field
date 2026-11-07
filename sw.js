/* Service worker: offline app shell + runtime cache of viewed map tiles. ASCII only. */
var VERSION = "lulc-field-v1.0.0";
var TILES = "lulc-tiles-v1";
var MAX_TILES = 6000;
var SHELL = ["./", "index.html", "app.js", "app.css", "manifest.webmanifest",
  "vendor/leaflet/leaflet.js", "vendor/leaflet/leaflet.css", "vendor/leaflet/images/layers.png",
  "vendor/leaflet/images/layers-2x.png", "vendor/leaflet/images/marker-icon.png",
  "vendor/leaflet/images/marker-icon-2x.png", "vendor/leaflet/images/marker-shadow.png",
  "vendor/jszip.min.js", "icons/icon-192.png", "icons/icon-512.png", "demo/demo_field_package.json"];
var TILE_HOSTS = ["tile.openstreetmap.org", "server.arcgisonline.com"];
var puts = 0;

self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(VERSION).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== VERSION && k !== TILES; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
function trimTiles() {
  return caches.open(TILES).then(function (c) {
    return c.keys().then(function (keys) {
      if (keys.length <= MAX_TILES) return;
      return Promise.all(keys.slice(0, keys.length - MAX_TILES).map(function (k) { return c.delete(k); }));
    });
  });
}
self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;
  var url = new URL(req.url);
  if (TILE_HOSTS.indexOf(url.hostname) >= 0) {
    e.respondWith(caches.open(TILES).then(function (c) {
      return c.match(req).then(function (hit) {
        if (hit) return hit;
        return fetch(req).then(function (r) {
          if (r && r.ok) { c.put(req, r.clone()); if (++puts % 100 === 0) trimTiles(); }
          return r;
        }).catch(function () { return new Response("", {status: 504, statusText: "offline tile"}); });
      });
    }));
    return;
  }
  if (url.origin !== self.location.origin) return;
  e.respondWith(caches.open(VERSION).then(function (c) {
    return c.match(req, {ignoreSearch: true}).then(function (hit) {
      var net = fetch(req).then(function (r) { if (r && r.ok && r.type === "basic") c.put(req, r.clone()); return r; }).catch(function () { return hit || c.match("index.html"); });
      return hit || net;
    });
  }));
});
