/* LULC Field Survey - offline-first mobile field app (PWA). ASCII only.
   Data stays on the device (IndexedDB) until exported, backed up or synchronised. */
"use strict";
var APP_VERSION = "1.1.0";
var PKG = null, SET = {}, OBS = {}, OBS_ALL = [], DEVICE = null, CUR = null, VIEW = "dash";
var GPS = {last: null, watch: null, err: null, listeners: []}, COMPASS = {heading: null, ms: 0};
var FMAP = null, FL = {}, FOLLOW = false, INSTALL = null, SYNCING = false;
var SHEET_PID = null, CAPTURING = false, LBL_ON = null;
var $ = function (id) { return document.getElementById(id); };

var STATUSES = ["Verified - Correct Classification", "Verified - Classification Mismatch", "Requires Further Verification", "Mixed Land Cover", "Inaccessible Location", "Unable to Verify"];
var NO_CLASS_NEEDED = ["Inaccessible Location", "Unable to Verify"];
var SLOTS = [["general", "1. General landscape view"], ["opposite", "2. Opposite direction"], ["vegetation", "3. Dominant vegetation / crop"], ["feature", "4. Specific land-use feature"]];
var ROUTE_COLORS = ["#d62728", "#1f77b4", "#2ca02c", "#9467bd", "#ff7f0e", "#8c564b"];
var DIRS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

/* ================================================================ utils */
function esc(s) { return String(s === null || s === undefined ? "" : s).replace(/[&<>"']/g, function (c) { return {"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]; }); }
function fmt(v, d) { return (v === null || v === undefined || v === "" || isNaN(v)) ? "-" : Number(v).toFixed(d === undefined ? 1 : d); }
function pad(n) { return String(Math.floor(Math.abs(n))).padStart(2, "0"); }
function isoLocal(d) { d = d || new Date(); var o = -d.getTimezoneOffset(); return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + "T" + pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds()) + (o >= 0 ? "+" : "-") + pad(o / 60) + ":" + pad(o % 60); }
function nowIso() { return isoLocal(new Date()); }
function today() { return nowIso().slice(0, 10); }
function uuid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID().replace(/-/g, "");
  var a = new Uint8Array(16); crypto.getRandomValues(a); return Array.prototype.map.call(a, function (b) { return ("0" + b.toString(16)).slice(-2); }).join("");
}
function hav(lat1, lon1, lat2, lon2) {
  var R = 6371008.8, r = Math.PI / 180, dl = (lat2 - lat1) * r, dn = (lon2 - lon1) * r;
  var a = Math.sin(dl / 2) * Math.sin(dl / 2) + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dn / 2) * Math.sin(dn / 2);
  return 2 * R * Math.asin(Math.sqrt(a));
}
function bearing(lat1, lon1, lat2, lon2) {
  var r = Math.PI / 180, y = Math.sin((lon2 - lon1) * r) * Math.cos(lat2 * r);
  var x = Math.cos(lat1 * r) * Math.sin(lat2 * r) - Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos((lon2 - lon1) * r);
  return (Math.atan2(y, x) / r + 360) % 360;
}
function dirLabel(deg) { return deg === null || deg === undefined ? "" : DIRS[Math.round(deg / 45) % 8]; }
function distTxt(m) { return m === null || m === undefined ? "" : (m < 1000 ? Math.round(m) + " m" : (m / 1000).toFixed(1) + " km"); }
function toast(m, bad) { var t = $("toast"); t.textContent = m; t.className = "toast" + (bad ? " bad" : ""); clearTimeout(t._h); t._h = setTimeout(function () { t.classList.add("hidden"); }, bad ? 6000 : 2800); }
function dlg(html, actions) {
  return new Promise(function (res) {
    var b = $("dlgBox");
    b.innerHTML = html + '<div class="dlg-actions">' + actions.map(function (a) { return '<button class="btn ' + (a.cls || "") + '" data-id="' + a.id + '">' + esc(a.label) + "</button>"; }).join("") + "</div>";
    $("dlg").classList.remove("hidden");
    b.querySelectorAll(".dlg-actions button").forEach(function (x) {
      x.onclick = function () {
        var vals = {}; b.querySelectorAll("[data-f]").forEach(function (i) { vals[i.getAttribute("data-f")] = i.value; });
        $("dlg").classList.add("hidden"); res({id: x.getAttribute("data-id"), vals: vals});
      };
    });
  });
}
function classOf(code) { if (!PKG || code === null || code === undefined || code === "") return null; for (var i = 0; i < PKG.classes.length; i++) if (PKG.classes[i].code === Number(code)) return PKG.classes[i]; return null; }
function hasRoutes() { return !!(PKG && PKG.routes && PKG.routes.length); }
function projId() { return PKG && PKG.project ? PKG.project.project_id : null; }
function inProject(o) { var pj = projId(); return !pj || !o.project_id || o.project_id === pj; }
function noMapped(o) { return o.mapped_class_code === null || o.mapped_class_code === undefined || o.mapped_class_code === ""; }
function pointOf(pid) { if (!PKG) return null; for (var i = 0; i < PKG.points.length; i++) if (PKG.points[i].pid === pid) return PKG.points[i]; return null; }

/* ================================================================ IndexedDB */
var DB = null;
function dbOpen() {
  return new Promise(function (res, rej) {
    var r = indexedDB.open("lulc_field_v1", 1);
    r.onupgradeneeded = function () {
      var d = r.result;
      d.createObjectStore("meta");
      var o = d.createObjectStore("obs", {keyPath: "obs_id"}); o.createIndex("pid", "pid");
      var p = d.createObjectStore("photos", {keyPath: "photo_id"}); p.createIndex("obs_id", "obs_id"); p.createIndex("pid", "pid");
      d.createObjectStore("drafts", {keyPath: "pid"});
    };
    r.onsuccess = function () { DB = r.result; res(DB); };
    r.onerror = function () { rej(r.error); };
  });
}
function idb(store, mode, op) {
  return new Promise(function (res, rej) {
    var t = DB.transaction(store, mode), s = t.objectStore(store), r = op(s), val;
    if (r) r.onsuccess = function () { val = r.result; };
    t.oncomplete = function () { res(val); };
    t.onerror = function () { rej(t.error); };
    t.onabort = function () { rej(t.error || new Error("Storage transaction aborted (device storage full?)")); };
  });
}
function metaGet(k) { return idb("meta", "readonly", function (s) { return s.get(k); }); }
function metaSet(k, v) { return idb("meta", "readwrite", function (s) { return s.put(v, k); }); }
function getAll(st) { return idb(st, "readonly", function (s) { return s.getAll(); }); }
function getOne(st, k) { return idb(st, "readonly", function (s) { return s.get(k); }); }
function put(st, v) { return idb(st, "readwrite", function (s) { return s.put(v); }); }
function del(st, k) { return idb(st, "readwrite", function (s) { return s.delete(k); }); }
function byIndex(st, ix, v) { return idb(st, "readonly", function (s) { return s.index(ix).getAll(v); }); }

async function loadObs() {
  /* Only observations of the loaded project count (several Micro-landscape projects may share one phone). */
  OBS_ALL = (await getAll("obs")).filter(inProject);
  OBS = {};
  OBS_ALL.forEach(function (o) {
    var c = OBS[o.pid];
    if (!c || (o.updated || "") > (c.updated || "")) OBS[o.pid] = o;
  });
}

/* ================================================================ boot */
async function boot() {
  try { await dbOpen(); } catch (e) { $("view").innerHTML = '<div class="note bad">This browser blocks local storage (private mode?). The field app cannot store data here: ' + esc(e.message) + "</div>"; return; }
  DEVICE = await metaGet("device_id");
  if (!DEVICE) { DEVICE = "dev-" + uuid().slice(0, 10); await metaSet("device_id", DEVICE); }
  SET = (await metaGet("settings")) || {surveyor: "", team: "all", gps_seconds: 25, sync_url: "", sync_token: "", auto_sync: false, show_all_sections: false};
  if (SET.auto_gps === undefined) SET.auto_gps = true;
  if (!SET.photo_mode) SET.photo_mode = "stamp2048";
  PKG = (await metaGet("package")) || null;
  await loadObs();
  document.querySelectorAll("#nav button").forEach(function (b) { b.onclick = function () { show(b.getAttribute("data-v")); }; });
  $("btnLocate").onclick = function () { if (GPS.last && FMAP) FMAP.setView([GPS.last.lat, GPS.last.lon], Math.max(FMAP.getZoom(), 16)); else toast("Waiting for GPS..."); };
  $("btnFollow").onclick = function () { FOLLOW = !FOLLOW; $("btnFollow").classList.toggle("on", FOLLOW); };
  $("btnBase").onclick = cycleBase;
  startGps();
  if ("serviceWorker" in navigator) {
    var hadCtrl = !!navigator.serviceWorker.controller, reloading = false;
    navigator.serviceWorker.addEventListener("controllerchange", function () {
      if (!hadCtrl || reloading) return;
      if (VIEW === "form") { toast("App updated. The new version loads next time you open the app."); return; }
      reloading = true; location.reload();
    });
    navigator.serviceWorker.register("sw.js").catch(function (e) { console.warn("SW", e); });
  }
  window.addEventListener("beforeinstallprompt", function (e) { e.preventDefault(); INSTALL = e; });
  window.addEventListener("online", function () { updateChips(); if (SET.auto_sync) syncNow(true); });
  window.addEventListener("offline", updateChips);
  setInterval(function () { if (SET.auto_sync && navigator.onLine) syncNow(true); }, 120000);
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {});
  applyPkgHeader();
  updateChips();
  show(PKG ? "dash" : "settings");
}
function applyPkgHeader() {
  var demo = PKG && PKG.project && PKG.project.demo;
  $("demoBar").classList.toggle("hidden", !demo);
  document.body.classList.toggle("has-demo", !!demo);
  $("hdrTitle").textContent = PKG ? PKG.project.name : "LULC Field Survey";
  var hr = hasRoutes();
  document.querySelectorAll('#nav button[data-v="day1"],#nav button[data-v="day2"]').forEach(function (b) { b.classList.toggle("hidden", !!PKG && !hr); });
}
async function saveSettings() { await metaSet("settings", SET); }

/* ================================================================ status */
function pstatus(pid) {
  var o = OBS[pid];
  if (!o || !o.final_status) return o ? "draft" : "pending";
  if (o.final_status.indexOf("Verified") === 0) return "done";
  if (NO_CLASS_NEEDED.indexOf(o.final_status) >= 0) return "fail";
  return "flag";
}
var ST_COL = {pending: "#ffffff", draft: "#fde68a", done: "#16a34a", flag: "#f59e0b", fail: "#dc2626"};
var ST_LBL = {pending: "Pending", draft: "Draft", done: "Completed", flag: "Needs follow-up", fail: "Not verified"};
function unsaved() {
  var n = 0;
  OBS_ALL.forEach(function (o) { if (Math.max(o.exported_rev || 0, o.synced_rev || 0) < (o.revision || 0)) n++; });
  return n;
}
async function unsavedPhotos() { var ph = await getAll("photos"); return ph.filter(function (p) { return !p.deleted && !p.exported && !p.synced; }).length; }
function updateChips() {
  var c = $("chipGps");
  if (GPS.err && !GPS.last) { c.textContent = "GPS off"; c.className = "chip bad"; }
  else if (!GPS.last) { c.textContent = "GPS ..."; c.className = "chip"; }
  else {
    var acc = GPS.last.accuracy_m, lim = setting("gps_accuracy_warn_m", 10);
    c.textContent = "GPS " + Math.round(acc) + " m"; c.className = "chip " + (acc <= lim ? "ok" : acc <= lim * 3 ? "warn" : "bad");
  }
  var u = unsaved(), s = $("chipSync");
  s.textContent = (navigator.onLine ? "" : "offline - ") + u + " unsaved";
  s.className = "chip " + (u ? "warn" : "ok");
}
function setting(k, d) { return (PKG && PKG.settings && PKG.settings[k] !== undefined && PKG.settings[k] !== null) ? PKG.settings[k] : d; }

/* ================================================================ GPS */
function gpsFix(p) {
  return {lat: p.coords.latitude, lon: p.coords.longitude, accuracy_m: Math.round(p.coords.accuracy * 10) / 10,
    altitude_m: p.coords.altitude === null ? null : Math.round(p.coords.altitude * 10) / 10,
    timestamp: isoLocal(new Date(p.timestamp)), ms: p.timestamp, source: "device"};
}
function startGps() {
  if (!navigator.geolocation) { GPS.err = "This browser has no GPS access"; updateChips(); return; }
  if (!window.isSecureContext) { GPS.err = "GPS needs HTTPS"; updateChips(); return; }
  GPS.watch = navigator.geolocation.watchPosition(function (p) {
    GPS.last = gpsFix(p); GPS.err = null; updateChips(); onMove();
    GPS.listeners.slice().forEach(function (f) { try { f(GPS.last); } catch (e) { console.warn(e); } });
  }, function (e) { GPS.err = e.message || "GPS error"; updateChips(); }, {enableHighAccuracy: true, maximumAge: 3000, timeout: 60000});
}
function captureGps(seconds, target) {
  /* Collects fixes for up to 'seconds' from the background watch plus a dedicated watch and keeps
     the most accurate one. A background fix younger than 15 s counts as the first fix. */
  return new Promise(function (res, rej) {
    if (!navigator.geolocation) return rej(new Error("No GPS in this browser"));
    var best = null, n = 0, seen = {}, t0 = Date.now(), done = false, w = null, tm = null;
    var onFix = function (f) {
      if (done || seen[f.ms + "_" + f.lat]) return;
      seen[f.ms + "_" + f.lat] = 1; n++;
      if (!best || f.accuracy_m < best.accuracy_m) best = f;
      var el = $("gpsLive"); if (el) el.textContent = "Fix " + n + ": accuracy " + f.accuracy_m + " m (best " + best.accuracy_m + " m)";
      if (n >= 3 && best.accuracy_m <= target) finish();
    };
    var finish = function () {
      if (done) return; done = true;
      if (w !== null) navigator.geolocation.clearWatch(w);
      clearTimeout(tm);
      GPS.listeners = GPS.listeners.filter(function (x) { return x !== onFix; });
      if (best) { best = Object.assign({}, best, {n_fixes: n, capture_seconds: Math.round((Date.now() - t0) / 1000)}); res(best); }
      else rej(new Error("No GPS fix obtained. Move to open sky and try again."));
    };
    GPS.listeners.push(onFix);
    if (GPS.last && Date.now() - GPS.last.ms < 15000) onFix(GPS.last);
    var el = $("gpsLive"); if (el && !n) el.textContent = "Waiting for GPS fixes (up to " + seconds + " s)...";
    w = navigator.geolocation.watchPosition(function (p) { onFix(gpsFix(p)); }, function () {}, {enableHighAccuracy: true, maximumAge: 0, timeout: seconds * 1000});
    tm = setTimeout(finish, seconds * 1000);
  });
}
function startCompass() {
  var h = function (e) {
    var hd = null;
    if (e.webkitCompassHeading !== undefined && e.webkitCompassHeading !== null) hd = e.webkitCompassHeading;
    else if (e.absolute && e.alpha !== null) hd = (360 - e.alpha) % 360;
    if (hd !== null) { COMPASS.heading = Math.round(hd); COMPASS.ms = Date.now(); }
  };
  if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function") {
    DeviceOrientationEvent.requestPermission().then(function (r) { if (r === "granted") { window.addEventListener("deviceorientation", h); toast("Compass enabled"); } else toast("Compass permission refused", true); }).catch(function (e) { toast(e.message, true); });
  } else { window.addEventListener("deviceorientationabsolute", h); window.addEventListener("deviceorientation", h); toast("Compass enabled (if the phone has one)"); }
}
function compassNow() { return (COMPASS.heading !== null && Date.now() - COMPASS.ms < 5000) ? COMPASS.heading : null; }

/* ================================================================ views */
function show(v) {
  VIEW = v; closeSheet();
  document.querySelectorAll("#nav button").forEach(function (b) { b.classList.toggle("on", b.getAttribute("data-v") === v || (v === "form" && b.getAttribute("data-v") === "pending")); });
  var isMap = v === "map";
  $("mapView").classList.toggle("hidden", !isMap);
  $("view").classList.toggle("hidden", isMap);
  if (isMap) { initMap(); setTimeout(function () { FMAP.invalidateSize(); }, 50); drawMapPoints(); return; }
  $("view").scrollTop = 0;
  if (!PKG && ["settings", "more", "export"].indexOf(v) < 0) { v = "settings"; }
  ({dash: vDash, day1: function () { vDay(1); }, day2: function () { vDay(2); }, pending: vPending, more: vMore, obs: vObs, photos: vPhotos, export: vExport, settings: vSettings})[v]();
}
function H(html) { $("view").innerHTML = html; }

function myRoutes(day) {
  if (!PKG) return [];
  return PKG.routes.filter(function (r) { return r.day === day && (SET.team === "all" || String(r.team) === String(SET.team)); });
}
function routePoints(r) { var out = []; r.stops.forEach(function (s) { s.members.forEach(function (m) { out.push(m); }); }); return out; }
function currentML() {
  if (!GPS.last || !PKG) return null;
  for (var i = 0; i < PKG.mls.features.length; i++) if (inPoly(GPS.last.lon, GPS.last.lat, PKG.mls.features[i].geometry)) return PKG.mls.features[i].properties.ml_id;
  return null;
}
function inPoly(x, y, g) {
  var polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates, inside = false;
  polys.forEach(function (poly) {
    poly.forEach(function (ring) {
      for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        var xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
        if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
      }
    });
  });
  return inside;
}
function nextPending() {
  if (!PKG) return null;
  if (hasRoutes()) {
    for (var d = 1; d <= 2; d++) {
      var rs = myRoutes(d);
      for (var i = 0; i < rs.length; i++) { var pts = routePoints(rs[i]); for (var k = 0; k < pts.length; k++) if (pstatus(pts[k]) === "pending" || pstatus(pts[k]) === "draft") return {pid: pts[k], route: rs[i]}; }
    }
    return null;
  }
  /* Imported points (no planned routes): nearest pending point to the current GPS position,
     or the first pending point in file order while there is no GPS fix. */
  var best = null, bd = Infinity;
  PKG.points.forEach(function (p, idx) {
    var s = pstatus(p.pid); if (s !== "pending" && s !== "draft") return;
    var d2 = GPS.last ? hav(GPS.last.lat, GPS.last.lon, p.lat, p.lon) : idx;
    if (d2 < bd) { bd = d2; best = p; }
  });
  return best ? {pid: best.pid, route: null, dist: GPS.last ? bd : null} : null;
}
function classProgressHtml() {
  var rows = {}, order = [];
  PKG.points.forEach(function (p) {
    var k = p.class_name || "Not specified";
    if (!rows[k]) { rows[k] = {n: 0, k: 0, c: classOf(p.class_code)}; order.push(k); }
    rows[k].n++; if (OBS[p.pid] && OBS[p.pid].final_status) rows[k].k++;
  });
  if (order.length < 2 && order[0] === "Not specified") return "";
  return '<div class="card"><b>Progress by mapped class</b><div class="kv" style="margin-top:6px">' + order.map(function (k) {
    var r = rows[k];
    return '<div><span class="dot" style="display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px;background:' + (r.c ? r.c.color : "#38bdf8") + '"></span>' + esc(k) + "</div><div>" + r.k + " / " + r.n + "</div>";
  }).join("") + "</div></div>";
}

function vDash() {
  var pts = PKG.points, total = pts.length, done = pts.filter(function (p) { return OBS[p.pid] && OBS[p.pid].final_status; }).length;
  var trip = pts.filter(function (p) { return p.phase === 1; });
  var tripPending = trip.filter(function (p) { var s = pstatus(p.pid); return s === "pending" || s === "draft"; }).length;
  var dayProg = function (d) {
    var ids = []; myRoutes(d).forEach(function (r) { ids = ids.concat(routePoints(r)); });
    var k = ids.filter(function (x) { return OBS[x] && OBS[x].final_status; }).length;
    return {n: ids.length, k: k, p: ids.length ? Math.round(100 * k / ids.length) : 0};
  };
  var d1 = dayProg(1), d2 = dayProg(2), np = nextPending(), cml = currentML(), hr = hasRoutes();
  var pAll = total ? Math.round(100 * done / total) : 0;
  var html = '<h2>' + esc(PKG.project.name) + "</h2>" +
    '<div class="grid"><div class="stat"><b>' + total + '</b><span>Total validation points</span></div><div class="stat"><b>' + done + '</b><span>Completed</span></div><div class="stat"><b>' + tripPending + '</b><span>Pending' + (hr ? " (this trip)" : "") + '</span></div><div class="stat"><b>' + (total - done) + "</b><span>Remaining" + (hr ? " (all phases)" : "") + "</span></div></div>";
  if (hr) html += '<div class="card"><b>Day 1 progress</b> <span class="muted">' + d1.k + " / " + d1.n + '</span><div class="prog"><i style="width:' + d1.p + '%"></i></div><b>Day 2 progress</b> <span class="muted">' + d2.k + " / " + d2.n + '</span><div class="prog"><i style="width:' + d2.p + '%"></i></div>' +
    '<div class="kv" style="margin-top:8px"><div>Team</div><div>' + (SET.team === "all" ? "All teams" : "Team " + esc(SET.team)) + "</div><div>Current Micro-landscape</div><div>" + esc(cml || (GPS.last ? "outside boundaries" : "waiting for GPS")) + "</div><div>Current route</div><div>" + (np && np.route ? esc(np.route.route_id) + " (first ML " + esc(np.route.first_ml) + ")" : "-") + "</div><div>Surveyor</div><div>" + esc(SET.surveyor || "not set") + "</div></div></div>";
  else html += '<div class="card"><b>Overall progress</b> <span class="muted">' + done + " / " + total + '</span><div class="prog"><i style="width:' + pAll + '%"></i></div><div class="kv" style="margin-top:8px">' + (PKG.mls.features.length ? "<div>Current Micro-landscape</div><div>" + esc(cml || (GPS.last ? "outside boundaries" : "waiting for GPS")) + "</div>" : "") + "<div>Surveyor</div><div>" + esc(SET.surveyor || "not set") + "</div><div>Points from</div><div>" + esc((PKG.project.source_files || []).join(", ") || "-") + "</div></div></div>" + classProgressHtml();
  if (np) html += '<button class="btn block" id="btnNext">' + (hr ? "Next point: " : "Nearest pending point: ") + esc(np.pid) + (np.dist !== null && np.dist !== undefined ? " (" + distTxt(np.dist) + ")" : "") + "</button>";
  else html += '<div class="note ok">All ' + (hr ? "trip " : "") + "points have an observation.</div>";
  html += '<button class="btn sec block" id="btnMap">Open map</button>';
  var u = unsaved();
  html += '<div class="note ' + (u ? "warn" : "ok") + '">' + (u ? u + " observation(s) not yet exported or synced. Export at the end of each day (More &gt; Data export)." : "All saved observations have been exported or synced.") + "</div>";
  if (!SET.surveyor) html += '<div class="note warn">Set the surveyor name in Settings.</div>';
  if (PKG.project.approximate_routes) html += '<div class="note bad">Routes in this package are approximate straight-line estimates.</div>';
  if (INSTALL) html += '<button class="btn sec block" id="btnInstall">Install app on this phone</button>';
  H(html);
  if (np) $("btnNext").onclick = function () { if (hr) openSheet(np.pid); else goToPoint(np.pid); };
  $("btnMap").onclick = function () { show("map"); };
  if ($("btnInstall")) $("btnInstall").onclick = function () { INSTALL.prompt(); INSTALL = null; };
}

function pointItem(pid, extra) {
  var p = pointOf(pid); if (!p) return "";
  var st = pstatus(pid), c = classOf(p.class_code), d = GPS.last ? hav(GPS.last.lat, GPS.last.lon, p.lat, p.lon) : null;
  var o = OBS[pid];
  var road = (p.dist_road_m !== null && p.dist_road_m !== undefined) ? "road " + fmt(p.dist_road_m, 0) + " m, walk " + fmt(p.walk_min, 0) + " min" : "pending";
  return '<div class="item" data-pid="' + esc(pid) + '"><span class="dot" style="background:' + (st === "pending" ? (c ? c.color : "#38bdf8") : ST_COL[st]) + '"></span><div class="main"><b>' + esc(pid) + " &middot; " + esc(p.class_name) + "</b><small>" + esc(p.ml_id) + " &middot; " + (st === "pending" ? road : esc(ST_LBL[st]) + (o && o.observed_class_name ? " &rarr; " + esc(o.observed_class_name) : "")) + (extra || "") + '</small></div><div class="side">' + (d !== null ? distTxt(d) : "") + "<br>" + (p.planned_arrival ? esc(p.planned_arrival) : "") + "</div></div>";
}
function bindItems() { document.querySelectorAll(".item[data-pid]").forEach(function (el) { el.onclick = function () { openSheet(el.getAttribute("data-pid")); }; }); }

function vDay(day) {
  var rs = myRoutes(day), html = "<h2>Day " + day + " route</h2>";
  if (!rs.length) html += '<div class="note info">No route for day ' + day + (SET.team !== "all" ? " for team " + esc(SET.team) : "") + ".</div>";
  rs.forEach(function (r, i) {
    var ids = routePoints(r), k = ids.filter(function (x) { return OBS[x] && OBS[x].final_status; }).length;
    html += '<div class="card"><b>' + esc(r.route_id) + (r.team ? " - Team " + r.team : "") + '</b> <span class="badge info">' + k + "/" + ids.length + ' done</span><div class="kv" style="margin-top:6px"><div>Start</div><div>Staging ' + esc(r.start) + "</div><div>First Micro-landscape</div><div>" + esc(r.first_ml) + "</div><div>Order</div><div>" + esc((r.ml_sequence || []).join(" > ")) + "</div><div>Driving</div><div>" + fmt(r.drive_km, 1) + " km / " + fmt(r.drive_min, 0) + " min</div><div>Walking</div><div>" + fmt(r.walk_min, 0) + " min</div><div>Inspection</div><div>" + fmt(r.inspect_min, 0) + " min</div><div>Lunch / buffer</div><div>" + fmt(r.lunch_min, 0) + " / " + fmt(r.buffer_min, 0) + " min</div><div>Finish (est.)</div><div>" + esc(r.finish) + " at staging</div></div></div>";
    html += '<div class="list">';
    r.stops.forEach(function (s, n) {
      var leg = r.legs[n] || {};
      var roads = (leg.segments || []).slice(0, 4).map(function (x) { return x[0] + " " + (x[1] / 1000).toFixed(1) + " km"; }).join(" > ");
      html += '<div class="stop-h"><span>Stop ' + s.stop_no + " &middot; " + esc(s.ml) + " &middot; " + esc(s.arrive) + '</span><a href="' + navUrl(s.park_lat, s.park_lon) + '" target="_blank" rel="noopener">Drive</a></div>' + (roads ? '<div class="muted" style="font-size:12px;padding:4px 12px">via ' + esc(roads) + "</div>" : "");
      s.members.forEach(function (m) { html += pointItem(m); });
      if (s.lunch_after_stop) html += '<div class="stop-h"><span>Lunch break</span></div>';
    });
    html += "</div>";
  });
  H(html); bindItems();
}

function vPending() {
  var scope = SET.pending_scope || "trip", ml = SET.pending_ml || "", sort = SET.pending_sort || "near";
  var pts = PKG.points.filter(function (p) { var s = pstatus(p.pid); return (s === "pending" || s === "draft") && (scope === "all" || p.phase === 1) && (!ml || p.ml_id === ml); });
  if (sort === "near" && GPS.last) pts.sort(function (a, b) { return hav(GPS.last.lat, GPS.last.lon, a.lat, a.lon) - hav(GPS.last.lat, GPS.last.lon, b.lat, b.lon); });
  else pts.sort(function (a, b) { return (a.day || 99) - (b.day || 99) || (a.team || 0) - (b.team || 0) || (a.seq || 0) - (b.seq || 0); });
  var mls = []; PKG.points.forEach(function (p) { if (mls.indexOf(p.ml_id) < 0) mls.push(p.ml_id); }); mls.sort();
  var html = "<h2>Pending points (" + pts.length + ')</h2><div class="row2"><select id="pScope"><option value="trip">This trip</option><option value="all">All phases</option></select><select id="pSort"><option value="near">Nearest first</option><option value="route">' + (hasRoutes() ? "Route order" : "File order") + '</option></select></div><select id="pMl" style="margin-top:8px"><option value="">All Micro-landscapes</option>' + mls.map(function (m) { return "<option>" + esc(m) + "</option>"; }).join("") + '</select><div class="list" style="margin-top:10px">' + (pts.length ? pts.slice(0, 300).map(function (p) { return pointItem(p.pid, p.phase !== 1 ? " &middot; later phase" : ""); }).join("") : '<div class="item">Nothing pending.</div>') + "</div>";
  H(html);
  $("pScope").value = scope; $("pSort").value = sort; $("pMl").value = ml;
  $("pScope").onchange = function () { SET.pending_scope = this.value; saveSettings(); vPending(); };
  $("pSort").onchange = function () { SET.pending_sort = this.value; saveSettings(); vPending(); };
  $("pMl").onchange = function () { SET.pending_ml = this.value; saveSettings(); vPending(); };
  bindItems();
}

function vMore() {
  H('<h2>More</h2><div class="list">' + [["obs", "Field observations", OBS_ALL.length + " saved"], ["photos", "Photographs", ""], ["export", "Data export, backup &amp; sync", unsaved() + " unsaved"], ["settings", "Settings &amp; field package", ""]].map(function (x) {
    return '<div class="item" data-go="' + x[0] + '"><div class="main"><b>' + x[1] + "</b><small>" + x[2] + '</small></div><div class="side">&rsaquo;</div></div>';
  }).join("") + "</div>");
  document.querySelectorAll("[data-go]").forEach(function (el) { el.onclick = function () { show(el.getAttribute("data-go")); }; });
}

function vObs() {
  var list = Object.keys(OBS).map(function (k) { return OBS[k]; }).sort(function (a, b) { return (b.updated || "").localeCompare(a.updated || ""); });
  var html = "<h2>Field observations (" + list.length + ')</h2><div class="list">';
  list.forEach(function (o) {
    var st = pstatus(o.pid), ex = Math.max(o.exported_rev || 0, o.synced_rev || 0) >= o.revision;
    html += '<div class="item" data-edit="' + esc(o.pid) + '"><span class="dot" style="background:' + ST_COL[st] + '"></span><div class="main"><b>' + esc(o.pid) + " &middot; " + esc(o.mapped_class_name) + " &rarr; " + esc(o.observed_class_name || "-") + "</b><small>" + esc(o.final_status || "draft") + " &middot; rev " + o.revision + " &middot; " + esc((o.updated || "").slice(5, 16).replace("T", " ")) + '</small></div><div class="side">' + (ex ? '<span class="badge ok">saved</span>' : '<span class="badge warn">unsaved</span>') + (o.agreement_auto === "Disagree" ? '<br><span class="badge bad">mismatch</span>' : "") + "</div></div>";
  });
  H(html + (list.length ? "" : '<div class="item">No observations yet.</div>') + "</div>");
  document.querySelectorAll("[data-edit]").forEach(function (el) { el.onclick = function () { openForm(el.getAttribute("data-edit")); }; });
}

async function vPhotos() {
  var ph = (await getAll("photos")).filter(function (p) { return !p.deleted && inProject(p); });
  var by = {}; ph.forEach(function (p) { (by[p.pid] = by[p.pid] || []).push(p); });
  var html = "<h2>Photographs (" + ph.length + ")</h2>";
  Object.keys(by).sort().forEach(function (pid) {
    html += '<h3>' + esc(pid) + ' <button class="btn sm sec" data-edit="' + esc(pid) + '">Open</button></h3><div class="gallery">' + by[pid].map(function (p) {
      return '<div><img src="' + (p.thumb ? URL.createObjectURL(p.thumb) : "") + '" alt=""><div class="muted" style="font-size:11px">' + esc(p.slot) + " &middot; " + esc((p.gps && p.gps.source) || "no geotag") + "</div></div>";
    }).join("") + "</div>";
  });
  if (!ph.length) html += '<div class="note info">No photographs yet.</div>';
  H(html);
  document.querySelectorAll("[data-edit]").forEach(function (el) { el.onclick = function () { openForm(el.getAttribute("data-edit")); }; });
}

/* ================================================================ point sheet */
function navUrl(lat, lon) { return "https://www.google.com/maps/dir/?api=1&destination=" + lat + "," + lon + "&travelmode=driving"; }
var IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
function distHtml(p) {
  if (!GPS.last) return '<span class="muted">waiting for GPS...</span>';
  var d = hav(GPS.last.lat, GPS.last.lon, p.lat, p.lon), b = bearing(GPS.last.lat, GPS.last.lon, p.lat, p.lon), lim = setting("distance_warn_m", 30);
  if (d <= lim) return '<span class="badge ok" style="font-size:13px">You are at the point (' + Math.round(d) + " m)</span>";
  return "<b>" + distTxt(d) + "</b> towards " + dirLabel(b) + " (" + Math.round(b) + "&deg;)";
}
function updateSheetDist() {
  if (!SHEET_PID) return;
  var p = pointOf(SHEET_PID), el = $("shDist"); if (!p || !el) return;
  el.innerHTML = distHtml(p);
}
function attrsHtml(p) {
  var a = p.attrs || {}, keys = Object.keys(a).filter(function (k) { return a[k] !== null && a[k] !== undefined && String(a[k]).trim() !== ""; });
  if (!keys.length) return "";
  return '<details style="margin-top:8px"><summary class="muted" style="font-size:13px">Point attributes (' + keys.length + ')</summary><div class="kv" style="margin-top:6px">' + keys.slice(0, 30).map(function (k) { return "<div>" + esc(k) + "</div><div>" + esc(String(a[k]).slice(0, 200)) + "</div>"; }).join("") + "</div></details>";
}
function openSheet(pid) {
  var p = pointOf(pid); if (!p) return;
  var o = OBS[pid], st = pstatus(pid);
  var c = classOf(p.class_code), roadInfo = p.dist_road_m !== null && p.dist_road_m !== undefined;
  SHEET_PID = pid;
  var html = '<div style="display:flex;justify-content:space-between;align-items:center"><h2 style="margin:0">' + esc(pid) + '</h2><span class="badge ' + (st === "done" ? "ok" : st === "pending" ? "" : st === "fail" ? "bad" : "warn") + '">' + ST_LBL[st] + "</span></div>" +
    '<div class="mapped" style="margin:8px 0">Classified LULC: <b>' + (c ? esc(p.class_code + " " + p.class_name) : esc(p.class_name || "not specified")) + '</b> <span class="swatch" style="display:inline-block;width:14px;height:14px;border-radius:3px;background:' + (c ? c.color : "#38bdf8") + '"></span>' + (o && o.observed_class_name ? '<div style="font-size:14px;margin-top:4px">Observed: <b style="font-size:15px">' + esc(o.observed_class_name) + "</b></div>" : "") + "</div>" +
    '<div class="kv"><div>From you</div><div id="shDist">' + distHtml(p) + "</div><div>Micro-landscape</div><div>" + esc(p.ml_id + " " + (p.ml_name && p.ml_name !== p.ml_id ? p.ml_name : "")) + "</div><div>Planned GPS</div><div>" + fmt(p.lat, 6) + ", " + fmt(p.lon, 6) + "</div>" +
    (p.access_label ? "<div>Access</div><div>" + esc(p.access_label) + "</div>" : "") + (roadInfo ? "<div>Road</div><div>" + fmt(p.dist_road_m, 0) + " m from " + esc(p.road_name || p.road_class || "road") + ", walk ~" + fmt(p.walk_min, 0) + " min</div>" : "") + (p.route_id ? "<div>Plan</div><div>" + esc((p.phase === 1 ? "" : "Later phase ") + p.route_id + " #" + p.seq + (p.planned_arrival ? " at " + p.planned_arrival : "")) + "</div>" : "") + (p.role === "replacement" ? "<div>Replaces</div><div>" + esc(p.replaces) + "</div>" : "") + "</div>" +
    attrsHtml(p) +
    '<button class="btn block" id="btnObs" style="margin-top:10px">' + (o ? "Edit observation" : "Record observation at this point") + "</button>" +
    '<div class="row2"><a class="btn sec" target="_blank" rel="noopener" href="' + navUrl(p.lat, p.lon) + '">Navigate</a>' + (p.road_lat ? '<a class="btn sec" target="_blank" rel="noopener" href="' + navUrl(p.road_lat, p.road_lon) + '">Road access</a>' : (IOS ? '<a class="btn sec" target="_blank" rel="noopener" href="https://maps.apple.com/?daddr=' + p.lat + "," + p.lon + '">Apple Maps</a>' : '<a class="btn sec" href="geo:' + p.lat + "," + p.lon + "?q=" + p.lat + "," + p.lon + '">Other app</a>')) + "</div>" +
    (VIEW === "map" ? "" : '<button class="btn sec block" id="btnShowMap">Show on map</button>');
  $("sheetBody").innerHTML = html;
  $("sheet").classList.remove("hidden");
  $("sheet").scrollTop = 0;
  $("btnObs").onclick = function () { openForm(pid); };
  if ($("btnShowMap")) $("btnShowMap").onclick = function () { goToPoint(pid); };
  markSelected(p);
}
function closeSheet() { $("sheet").classList.add("hidden"); SHEET_PID = null; markSelected(null); }
function markSelected(p) {
  if (!FMAP || !FL.sel) return;
  FL.sel.clearLayers();
  if (p) L.circleMarker([p.lat, p.lon], {radius: 14, color: "#2563eb", weight: 3, fill: false, interactive: false}).addTo(FL.sel);
}
function goToPoint(pid) {
  /* Map view with the point card open; zooms so that both you and the point are visible above the card. */
  var p = pointOf(pid); if (!p) return;
  show("map"); openSheet(pid);
  setTimeout(function () {
    if (!FMAP) return;
    var sh = $("sheet").offsetHeight || 0, mh = $("fmap").offsetHeight || 600, bottom = Math.min(sh + 20, mh * 0.6);
    if (GPS.last && hav(GPS.last.lat, GPS.last.lon, p.lat, p.lon) < 20000) FMAP.fitBounds(L.latLngBounds([[GPS.last.lat, GPS.last.lon], [p.lat, p.lon]]), {paddingTopLeft: [50, 50], paddingBottomRight: [50, bottom], maxZoom: 18});
    else { FMAP.setView([p.lat, p.lon], 17); FMAP.panBy([0, bottom / 2], {animate: false}); }
  }, 80);
}

/* ================================================================ map */
var BASES = null, BASE_I = 0;
function initMap() {
  if (FMAP) return;
  FMAP = L.map("fmap", {zoomControl: true, preferCanvas: true, renderer: L.canvas({tolerance: 10})});
  BASE_I = (SET.base_i !== undefined && SET.base_i !== null) ? SET.base_i : 1;
  BASES = [
    ["OpenStreetMap", L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {maxZoom: 19, crossOrigin: "anonymous", attribution: "&copy; OpenStreetMap contributors"})],
    ["Esri imagery", L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {maxZoom: 19, crossOrigin: "anonymous", attribution: "Imagery &copy; Esri, Maxar, Earthstar Geographics"})],
    ["No basemap", L.tileLayer("", {attribution: "No basemap"})]
  ];
  BASES[BASE_I][1].addTo(FMAP);
  FL.ml = L.geoJSON(PKG ? PKG.mls : null, {style: {color: "#111", weight: 2.5, fill: false}, onEachFeature: function (f, l) { l.bindTooltip(f.properties.ml_id, {permanent: false}); }}).addTo(FMAP);
  FL.roads = L.geoJSON(PKG ? PKG.roads : null, {style: {color: "#6b7280", weight: 1.5, opacity: 0.8}}).addTo(FMAP);
  if (PKG && PKG.refs && PKG.refs.features.length) FL.refs = L.geoJSON(PKG.refs, {style: {color: "#ef4444", weight: 2.5, opacity: 0.9}, interactive: false}).addTo(FMAP);
  FL.routes = L.layerGroup().addTo(FMAP);
  (PKG ? PKG.routes : []).forEach(function (r, i) {
    if (r.coords && r.coords.length > 1) L.polyline(r.coords.map(function (c) { return [c[1], c[0]]; }), {color: ROUTE_COLORS[i % 6], weight: 4, opacity: 0.8, dashArray: r.day % 2 === 0 ? "8 6" : null}).bindTooltip(r.route_id).addTo(FL.routes);
  });
  FL.points = L.layerGroup().addTo(FMAP);
  FL.sel = L.layerGroup().addTo(FMAP);
  FL.me = L.layerGroup().addTo(FMAP);
  if (PKG && PKG.staging) L.marker([PKG.staging.lat, PKG.staging.lon], {icon: L.divIcon({className: "", html: '<div style="font-size:26px;color:#facc15;text-shadow:0 0 3px #000">&#9733;</div>', iconSize: [26, 26], iconAnchor: [13, 15]})}).bindTooltip("Staging").addTo(FMAP);
  if (PKG && FL.ml.getLayers().length) FMAP.fitBounds(FL.ml.getBounds().pad(0.05));
  else if (PKG && PKG.points.length) FMAP.fitBounds(L.latLngBounds(PKG.points.map(function (p) { return [p.lat, p.lon]; })).pad(0.08), {maxZoom: 17});
  else FMAP.setView([20, 78], 5);
  FMAP.on("dragstart", function () { if (FOLLOW) { FOLLOW = false; $("btnFollow").classList.remove("on"); } });
  FMAP.on("click", function () { closeSheet(); });
  FMAP.on("zoomend", function () { if ((FMAP.getZoom() >= 16) !== LBL_ON) drawMapPoints(); });
  onMove();
}
function cycleBase() { if (!FMAP) return; FMAP.removeLayer(BASES[BASE_I][1]); BASE_I = (BASE_I + 1) % BASES.length; BASES[BASE_I][1].addTo(FMAP); SET.base_i = BASE_I; saveSettings(); toast(BASES[BASE_I][0]); }
function drawMapPoints() {
  if (!FMAP || !PKG) return;
  FL.points.clearLayers();
  LBL_ON = FMAP.getZoom() >= 16;
  PKG.points.forEach(function (p) {
    var st = pstatus(p.pid), c = classOf(p.class_code), later = p.phase !== 1;
    var m = L.circleMarker([p.lat, p.lon], {bubblingMouseEvents: false, radius: later ? 4 : 8, weight: st === "pending" ? 1.5 : 2.5, color: st === "pending" ? "#111" : "#fff", fillColor: st === "pending" ? (c ? c.color : "#38bdf8") : ST_COL[st], fillOpacity: later ? 0.5 : 0.95});
    if (LBL_ON) m.bindTooltip(esc(p.pid), {permanent: true, direction: "right", offset: [7, 0], className: "plbl"});
    else m.bindTooltip(esc(p.pid + " " + p.class_name), {direction: "top"});
    m.on("click", function (ev) { if (ev && ev.originalEvent) L.DomEvent.stopPropagation(ev.originalEvent); openSheet(p.pid); });
    m.addTo(FL.points);
  });
  if (SHEET_PID) markSelected(pointOf(SHEET_PID));
  if (FL.me) FL.me.eachLayer(function (l) { if (l.bringToFront) l.bringToFront(); });
}
function onMove() {
  updateSheetDist();
  if (!FMAP || !GPS.last) return;
  FL.me.clearLayers();
  /* not interactive: the position dot and accuracy circle must never swallow taps on the point you stand at */
  L.circle([GPS.last.lat, GPS.last.lon], {radius: GPS.last.accuracy_m, color: "#2563eb", weight: 1, fillOpacity: 0.12, interactive: false}).addTo(FL.me);
  L.circleMarker([GPS.last.lat, GPS.last.lon], {radius: 7, color: "#fff", weight: 2, fillColor: "#2563eb", fillOpacity: 1, interactive: false}).addTo(FL.me);
  if (FOLLOW) FMAP.setView([GPS.last.lat, GPS.last.lon]);
}

/* ================================================================ observation form */
var FORM = [
  {id: "B", title: "B. LULC verification", open: true, fields: [
    {k: "observed_class_code", t: "class", l: "What is the actual observed reference LULC class?", req: true},
    {k: "agreement", t: "seg", o: ["Yes", "No", "Uncertain"], l: "Classification agreement", req: true},
    {k: "confidence", t: "seg", o: ["High", "Medium", "Low"], l: "Confidence level", req: true},
    {k: "observed_land_use", t: "text", l: "Observed land-use type", list: ["Cropland", "Fallow", "Orchard", "Coffee estate", "Rubber plantation", "Homestead garden", "Natural forest", "Scrub", "Grazing land", "Settlement", "Water body", "Barren / rocky"]},
    {k: "dominant_vegetation", t: "text", l: "Dominant vegetation"},
    {k: "surrounding_condition", t: "seg", o: ["Homogeneous", "Mostly homogeneous", "Heterogeneous"], l: "Surrounding land-cover condition"},
    {k: "mixed_condition", t: "seg", o: ["No", "Yes"], l: "Mixed land-cover condition"},
    {k: "boundary_mismatch", t: "seg", o: ["No", "Near class boundary", "Map boundary shifted"], l: "Boundary mismatch"},
    {k: "comments", t: "area", l: "Comments"}
  ]},
  {id: "C", title: "C. Agriculture assessment", obj: "agri", when: ["agriculture"], fields: [
    {k: "crop_type", t: "text", l: "Crop type", list: ["Paddy", "Maize", "Ragi", "Jowar", "Sugarcane", "Cotton", "Groundnut", "Pulses", "Vegetables", "Banana", "Tobacco", "Chilli"]},
    {k: "crop_condition", t: "seg", o: ["Good", "Moderate", "Poor", "Harvested"], l: "Crop condition"},
    {k: "active_cultivation", t: "seg", o: ["Yes", "No"], l: "Active cultivation"},
    {k: "cropping", t: "seg", o: ["Single cropping", "Multiple cropping"], l: "Cropping pattern"},
    {k: "water_regime", t: "seg", o: ["Irrigated", "Rainfed"], l: "Irrigated / Rainfed"},
    {k: "fallow", t: "seg", o: ["Not fallow", "Current fallow", "Long fallow"], l: "Fallow condition"},
    {k: "soil_exposure", t: "seg", o: ["None", "Partial", "Full"], l: "Soil exposure"},
    {k: "residue_mgmt", t: "select", o: ["", "Retained", "Incorporated", "Removed", "Burnt", "Grazed", "Not observed"], l: "Crop residue management"},
    {k: "tillage", t: "select", o: ["", "Conventional", "Minimum tillage", "Zero tillage", "Not observed"], l: "Tillage practices"},
    {k: "other", t: "area", l: "Other agricultural observations"}
  ]},
  {id: "D", title: "D. Agroforestry and plantation", obj: "tree", when: ["agroforestry", "plantation"], fields: [
    {k: "species", t: "species", l: "Tree species (add one or more)"},
    {k: "n_trees", t: "num", l: "Number of trees (in plot / around point)"},
    {k: "arrangement", t: "select", o: ["", "Boundary planting", "Scattered", "Block plantation", "Rows / alley", "Home garden"], l: "Tree arrangement"},
    {k: "spacing", t: "text", l: "Tree spacing (e.g. 3 x 3 m)"},
    {k: "est_age_yr", t: "num", l: "Estimated tree age (years)"},
    {k: "establishment_year", t: "num", l: "Plantation establishment year"},
    {k: "height_m", t: "num", l: "Typical tree height (m)"},
    {k: "dbh_cm", t: "num", l: "Typical DBH (cm), where applicable"},
    {k: "canopy", t: "seg", o: ["Dense", "Moderate", "Sparse"], l: "Canopy condition"},
    {k: "intercropping", t: "seg", o: ["Yes", "No"], l: "Intercropping"},
    {k: "intercrop", t: "text", l: "Intercrop (if any)"},
    {k: "health", t: "seg", o: ["Healthy", "Stressed", "Diseased", "Dead"], l: "Tree health"},
    {k: "management", t: "area", l: "Plantation management practices"}
  ]},
  {id: "E", title: "E. Forest and vegetation", obj: "forest", when: ["forest", "scrub"], fields: [
    {k: "type", t: "seg", o: ["Natural forest", "Plantation", "Scrub"], l: "Vegetation type"},
    {k: "density", t: "seg", o: ["Dense >70%", "Moderate 40-70%", "Open 10-40%", "Sparse <10%"], l: "Vegetation density (canopy cover)"},
    {k: "canopy", t: "seg", o: ["Intact", "Degraded", "Fragmented"], l: "Canopy condition"},
    {k: "diversity", t: "seg", o: ["Low", "Medium", "High"], l: "Tree species diversity"},
    {k: "regeneration", t: "seg", o: ["Absent", "Low", "Good"], l: "Regeneration"},
    {k: "disturbance", t: "seg", o: ["None", "Low", "Medium", "High"], l: "Disturbance"},
    {k: "cutting", t: "seg", o: ["No", "Yes"], l: "Evidence of cutting or clearing"},
    {k: "fire", t: "seg", o: ["No", "Yes"], l: "Fire damage"},
    {k: "grazing", t: "seg", o: ["No", "Yes"], l: "Grazing evidence"},
    {k: "remarks", t: "area", l: "Other remarks"}
  ]},
  {id: "F", title: "F. Historical land-use information", obj: "hist", when: ["*"], fields: [
    {k: "previous_land_use", t: "text", l: "Previous land use", src: true},
    {k: "change_year", t: "num", l: "Approximate year of land-use change", src: true},
    {k: "plantation_year", t: "num", l: "Plantation establishment year", src: true},
    {k: "recent_conversion", t: "seg", o: ["No", "Yes", "Unknown"], l: "Recent land-use conversion", src: true},
    {k: "farmer_info", t: "area", l: "Farmer-reported historical information (statement)"},
    {k: "evidence", t: "area", l: "Supporting evidence (documents, stumps, records)"},
    {k: "imagery_status", t: "seg", o: ["Not checked", "Consistent", "Inconsistent", "Pending"], l: "Historical imagery verification status"}
  ]}
];
var SOURCES = ["Field observation", "Farmer statement", "Verified evidence"];

async function openForm(pid) {
  var p = pointOf(pid); if (!p) return;
  closeSheet();
  var saved = OBS[pid], draft = await getOne("drafts", pid);
  var o;
  if (draft && (!saved || (draft.updated || "") > (saved.updated || ""))) { o = draft; o._fromDraft = true; }
  else if (saved) o = JSON.parse(JSON.stringify(saved));
  else o = newObs(p);
  CUR = {pid: pid, p: p, o: o, base: saved ? JSON.parse(JSON.stringify(saved)) : null};
  VIEW = "form";
  $("mapView").classList.add("hidden"); $("view").classList.remove("hidden");
  await renderForm();
  if (o._fromDraft) toast("Unsaved draft restored");
  /* Standing at the point and tapping it is enough: the location is captured automatically. */
  if (!o.gps && SET.auto_gps !== false && !CAPTURING) doCaptureGps();
}
function newObs(p) {
  return {obs_id: uuid(), pid: p.pid, revision: 0, created: nowIso(), updated: nowIso(), device_id: DEVICE,
    package_id: PKG.package_id, project_id: PKG.project.project_id, app_version: APP_VERSION,
    surveyor: SET.surveyor || "", survey_date: today(), plot_id: "", ml_id: p.ml_id,
    planned: {lat: p.lat, lon: p.lon}, gps: null, manual_correction: null, dist_planned_actual_m: null,
    mapped_class_code: p.class_code, mapped_class_name: p.class_name,
    observed_class_code: null, observed_class_name: null, agreement: null, agreement_auto: null, confidence: null,
    agri: {}, tree: {species: []}, forest: {}, hist: {}, photos: [], final_status: null, final_remarks: "", edit_log: [], qc_flags: []};
}
function groupsNow() {
  var g = {}, m = classOf(CUR.o.mapped_class_code), ob = classOf(CUR.o.observed_class_code);
  if (m) g[m.group] = 1; if (ob) g[ob.group] = 1; return g;
}
function fieldHtml(f, obj) {
  var src = obj ? (CUR.o[obj] || {}) : CUR.o, val = src[f.k], id = "f_" + (obj || "o") + "_" + f.k, a = ' data-k="' + f.k + '" data-obj="' + (obj || "") + '"';
  var h = '<label class="f' + (f.req ? " req" : "") + '" for="' + id + '">' + esc(f.l) + "</label>";
  if (f.t === "class") {
    h += '<select id="' + id + '"' + a + ' data-t="int"><option value="">- choose observed class -</option>' + PKG.classes.map(function (c) { return '<option value="' + c.code + '"' + (val !== null && val !== undefined && val !== "" && Number(val) === c.code ? " selected" : "") + ">" + c.code + " " + esc(c.name) + "</option>"; }).join("") + "</select>" +
      (noMapped(CUR.o) ? "" : '<div class="row2" style="margin-top:6px"><button class="btn sm sec" data-same="1">Same as mapped</button><span></span></div>');
    if (!noMapped(CUR.o) && CUR.o.observed_class_code !== null && CUR.o.observed_class_code !== undefined && CUR.o.observed_class_code !== "") h += '<div class="' + (CUR.o.agreement_auto === "Agree" ? "warnline" : "badline") + '" style="' + (CUR.o.agreement_auto === "Agree" ? "color:#15803d" : "") + '">Automatic status: ' + (CUR.o.agreement_auto === "Agree" ? "AGREES with map" : "DISAGREES with map (" + esc(CUR.o.mapped_class_name) + ")") + "</div>";
  } else if (f.t === "seg") {
    h += '<div class="seg"' + a + ">" + f.o.map(function (x) { return '<button type="button" data-v="' + esc(x) + '" class="' + (val === x ? "on" : "") + '">' + esc(x) + "</button>"; }).join("") + "</div>";
  } else if (f.t === "select") {
    h += '<select id="' + id + '"' + a + ">" + f.o.map(function (x) { return "<option" + (val === x ? " selected" : "") + ">" + esc(x) + "</option>"; }).join("") + "</select>";
  } else if (f.t === "area") {
    h += '<textarea id="' + id + '"' + a + ">" + esc(val || "") + "</textarea>";
  } else if (f.t === "num") {
    h += '<input type="number" inputmode="decimal" id="' + id + '"' + a + ' data-t="num" value="' + esc(val === null || val === undefined ? "" : val) + '">';
  } else if (f.t === "species") {
    var sp = src.species || [];
    h += sp.map(function (s, i) {
      return '<div class="species"><div class="row2"><input type="text" placeholder="Species" data-sp="' + i + '" data-sk="name" value="' + esc(s.name || "") + '"><input type="number" placeholder="Count" data-sp="' + i + '" data-sk="count" value="' + esc(s.count || "") + '"></div><div class="row2" style="margin-top:6px"><input type="number" placeholder="Height m" data-sp="' + i + '" data-sk="height_m" value="' + esc(s.height_m || "") + '"><input type="number" placeholder="DBH cm" data-sp="' + i + '" data-sk="dbh_cm" value="' + esc(s.dbh_cm || "") + '"></div><button type="button" class="btn sm sec" data-sprm="' + i + '" style="margin-top:6px">Remove</button></div>';
    }).join("") + '<button type="button" class="btn sm sec" id="btnAddSp">+ Add species</button>';
  } else {
    h += '<input type="text" id="' + id + '"' + a + ' value="' + esc(val || "") + '"' + (f.list ? ' list="dl_' + f.k + '"' : "") + ">" + (f.list ? '<datalist id="dl_' + f.k + '">' + f.list.map(function (x) { return "<option>" + esc(x) + "</option>"; }).join("") + "</datalist>" : "");
  }
  if (f.src) {
    var sv = src[f.k + "_source"] || "";
    h += '<div class="seg" style="margin-top:4px" data-k="' + f.k + '_source" data-obj="' + obj + '">' + SOURCES.map(function (x) { return '<button type="button" style="font-size:12px;min-height:34px" data-v="' + x + '" class="' + (sv === x ? "on" : "") + '">' + x + "</button>"; }).join("") + "</div>";
  }
  return h;
}
function gpsHtml() {
  var o = CUR.o, g = o.gps, lim = setting("gps_accuracy_warn_m", 10), dl = setting("distance_warn_m", 30);
  var h = '<div class="gpsbox"><div class="kv"><div>Planned</div><div>' + fmt(o.planned.lat, 6) + ", " + fmt(o.planned.lon, 6) + "</div>";
  if (g) {
    h += "<div>Actual</div><div><b>" + fmt(g.lat, 6) + ", " + fmt(g.lon, 6) + "</b></div><div>Accuracy</div><div>" + fmt(g.accuracy_m, 1) + " m" + (g.n_fixes ? " (" + g.n_fixes + " fixes)" : "") + "</div><div>Altitude</div><div>" + fmt(g.altitude_m, 0) + " m</div><div>Time</div><div>" + esc((g.timestamp || "").replace("T", " ").slice(0, 19)) + "</div><div>Source</div><div>" + (g.source === "manual" ? '<span class="badge warn">MANUAL entry</span>' : "Device GPS") + "</div><div>Planned vs actual</div><div><b>" + fmt(o.dist_planned_actual_m, 1) + " m</b></div></div>";
    if (g.source !== "manual" && g.accuracy_m > lim) h += '<div class="badline">Poor GPS accuracy (' + fmt(g.accuracy_m, 0) + " m &gt; " + lim + " m). Wait in open sky and capture again.</div>";
    if (o.dist_planned_actual_m > dl) h += '<div class="warnline">You are ' + fmt(o.dist_planned_actual_m, 0) + " m from the planned point (limit " + dl + " m). Observe the planned location if you can see it; the planned coordinates are not changed.</div>";
  } else h += "</div><div class=\"muted\" style=\"margin-top:6px\">No GPS location captured yet.</div>";
  h += '<div id="gpsLive" class="muted" style="font-size:13px;margin-top:4px">' + (CAPTURING ? "Capturing location..." : "") + '</div><div class="row2" style="margin-top:8px"><button type="button" class="btn" id="btnGps"' + (CAPTURING ? " disabled" : "") + ">" + (CAPTURING ? "Capturing..." : (g ? "Re-capture GPS" : "Capture GPS")) + '</button><button type="button" class="btn sec" id="btnManual">Manual correction</button></div></div>';
  return h;
}
function refreshGps() {
  var w = $("gpsWrap"); if (!w || VIEW !== "form") return;
  w.innerHTML = gpsHtml();
  $("btnGps").onclick = function () { doCaptureGps(); };
  $("btnManual").onclick = doManualGps;
}
async function photosHtml() {
  var list = (await byIndex("photos", "pid", CUR.pid)).filter(function (p) { return !p.deleted && p.obs_id === CUR.o.obs_id; });
  var bySlot = {}; list.forEach(function (p) { (bySlot[p.slot] = bySlot[p.slot] || []).push(p); });
  var slots = SLOTS.slice(), extra = (bySlot.extra || []).length;
  for (var i = 0; i <= extra; i++) slots.push(["extra", "Additional photo"]);
  var used = {};
  var h = '<div class="photos">';
  slots.forEach(function (s, idx) {
    var arr = bySlot[s[0]] || [], k = used[s[0]] || 0, ph = arr[k]; used[s[0]] = k + 1;
    h += '<div class="ph"><b>' + esc(s[1]) + "</b>";
    if (ph) {
      var g = ph.gps;
      h += '<img src="' + (ph.thumb ? URL.createObjectURL(ph.thumb) : "") + '" alt=""><div>' + esc((ph.taken_at || "").replace("T", " ").slice(0, 16)) + "</div><div>" + (g && g.lat !== undefined && g.lat !== null ? (g.source === "manual" ? '<span class="badge warn">manual GPS</span>' : '<span class="badge ok">' + esc(g.source) + "</span>") : '<span class="badge bad">no geotag</span>') + "</div>" +
        '<select data-ph="' + ph.photo_id + '" data-pk="direction_label"><option value="">Direction</option>' + DIRS.map(function (d) { return "<option" + (ph.direction_label === d ? " selected" : "") + ">" + d + "</option>"; }).join("") + "</select>" + (ph.direction_deg !== null && ph.direction_deg !== undefined ? '<div class="muted">compass ' + ph.direction_deg + "&deg;</div>" : "") +
        '<input type="text" placeholder="Description" data-ph="' + ph.photo_id + '" data-pk="description" value="' + esc(ph.description || "") + '" style="margin-top:4px">' +
        (!g || g.lat === null || g.lat === undefined ? '<button type="button" class="btn sm sec" data-phgps="' + ph.photo_id + '" style="margin-top:4px;width:100%">Add GPS manually</button>' : "") +
        '<button type="button" class="btn sm sec" data-phrm="' + ph.photo_id + '" style="margin-top:4px;width:100%">Remove</button>';
    } else {
      h += '<div class="empty">No photo</div><div class="row2" style="margin-top:4px"><label class="btn sm">Camera<input type="file" accept="image/*" capture="environment" data-slot="' + s[0] + '"></label><label class="btn sm sec">Gallery<input type="file" accept="image/*" data-slot="' + s[0] + '"></label></div>';
    }
    h += "</div>";
  });
  return h + "</div>";
}
async function renderForm() {
  var o = CUR.o, p = CUR.p, g = groupsNow(), all = SET.show_all_sections;
  var h = '<div style="display:flex;align-items:center;gap:8px"><button class="btn sm sec" id="btnBack">&larr; Back</button><h2 style="margin:0;flex:1">' + esc(p.pid) + '</h2><span class="badge">' + (o.revision ? "rev " + o.revision : "new") + "</span></div>";
  h += '<div class="mapped" style="margin:10px 0">Original classified LULC class: <b>' + (noMapped(o) ? "not specified" : esc(o.mapped_class_code + " " + o.mapped_class_name)) + "</b></div>";
  h += '<details class="sec" open><summary>A. Identification &amp; GPS</summary><div class="body"><div class="kv"><div>Project</div><div>' + esc(PKG.project.name) + " (" + esc(PKG.project.project_id) + ")</div><div>Micro-landscape</div><div>" + esc(p.ml_id) + "</div><div>Validation point</div><div>" + esc(p.pid) + "</div><div>Observation ID</div><div>" + esc(o.obs_id.slice(0, 12)) + "</div></div>" +
    '<label class="f">Plot ID (if available)</label><input type="text" data-k="plot_id" data-obj="" value="' + esc(o.plot_id || "") + '">' +
    '<div class="row2"><div><label class="f req">Survey date</label><input type="date" data-k="survey_date" data-obj="" value="' + esc(o.survey_date || today()) + '"></div><div><label class="f req">Surveyor</label><input type="text" data-k="surveyor" data-obj="" list="dl_surv" value="' + esc(o.surveyor || "") + '"><datalist id="dl_surv">' + (setting("surveyors", []) || []).map(function (s) { return "<option>" + esc(s) + "</option>"; }).join("") + "</datalist></div></div>" +
    '<div id="gpsWrap">' + gpsHtml() + "</div></div></details>";
  FORM.forEach(function (sec) {
    var vis = !sec.when || sec.when.indexOf("*") >= 0 || all || sec.when.some(function (x) { return g[x]; });
    if (!vis) return;
    h += '<details class="sec"' + (sec.open || (sec.when && sec.when[0] !== "*" && !all) ? " open" : "") + "><summary>" + esc(sec.title) + (sec.when && sec.when[0] !== "*" ? '<span class="tag">' + esc(sec.when.join("/")) + "</span>" : "") + '</summary><div class="body">' + sec.fields.map(function (f) { return fieldHtml(f, sec.obj); }).join("") + "</div></details>";
  });
  if (!all) h += '<p class="muted" style="font-size:13px">Sections C-E appear automatically for the mapped and observed class groups. <a href="#" id="lnkAll">Show all sections</a></p>';
  h += '<details class="sec" open><summary>G. Photographic documentation</summary><div class="body"><div class="row2" style="margin-bottom:8px"><button type="button" class="btn sm sec" id="btnCompass">Enable compass</button><span class="muted" style="font-size:12px">Each photo gets your GPS position written into it (EXIF)' + (SET.photo_mode === "orig" ? "" : " and a stamp with point, coordinates and time") + ".</span></div><div id=\"photoBox\">" + (await photosHtml()) + "</div></div></details>";
  h += '<details class="sec" open><summary>H. Final field decision</summary><div class="body"><div class="seg" data-k="final_status" data-obj="" style="flex-direction:column">' + STATUSES.map(function (s) { return '<button type="button" data-v="' + esc(s) + '" class="' + (o.final_status === s ? "on" : "") + '">' + esc(s) + "</button>"; }).join("") + "</div>" + suggestHtml() + '<label class="f">Additional remarks</label><textarea data-k="final_remarks" data-obj="">' + esc(o.final_remarks || "") + "</textarea></div></details>";
  h += '<div class="savebar"><button class="btn block" id="btnSave">Save observation</button></div>';
  H(h);
  bindForm();
}
function suggestHtml() {
  var o = CUR.o;
  if (o.observed_class_code === null || o.observed_class_code === undefined || o.observed_class_code === "" || o.final_status || !o.agreement_auto) return "";
  var s = o.agreement_auto === "Agree" ? STATUSES[0] : STATUSES[1];
  return '<div class="note info" style="font-size:13px">Suggested: ' + esc(s) + ' <button type="button" class="btn sm" id="btnSuggest">Use</button></div>';
}
function setVal(k, obj, v) {
  if (obj) { CUR.o[obj] = CUR.o[obj] || {}; CUR.o[obj][k] = v; } else CUR.o[k] = v;
  if (k === "observed_class_code") {
    var c = classOf(v);
    CUR.o.observed_class_name = c ? c.name : null;
    CUR.o.agreement_auto = (v === null || v === "" || noMapped(CUR.o)) ? null : (Number(v) === Number(CUR.o.mapped_class_code) ? "Agree" : "Disagree");
    if (CUR.o.agreement_auto && !CUR.o.agreement) CUR.o.agreement = CUR.o.agreement_auto === "Agree" ? "Yes" : "No";
  }
  autosave();
}
var _as = null;
function autosave() { clearTimeout(_as); var cur = CUR; if (!cur) return; _as = setTimeout(function () { var d = JSON.parse(JSON.stringify(cur.o)); d.updated = nowIso(); put("drafts", d).catch(function (e) { toast("Draft not saved: " + e.message, true); }); }, 600); }
function bindForm() {
  var root = $("view");
  $("btnBack").onclick = function () { show("pending"); };
  if ($("lnkAll")) $("lnkAll").onclick = function (e) { e.preventDefault(); SET.show_all_sections = true; saveSettings(); renderForm(); };
  root.querySelectorAll("[data-k]").forEach(function (el) {
    var k = el.getAttribute("data-k"), obj = el.getAttribute("data-obj") || null;
    if (el.classList.contains("seg")) {
      el.querySelectorAll("button").forEach(function (b) {
        b.onclick = function () {
          var nv = b.classList.contains("on") ? null : b.getAttribute("data-v");
          el.querySelectorAll("button").forEach(function (x) { x.classList.remove("on"); });
          if (nv) b.classList.add("on");
          setVal(k, obj, nv);
          if (k === "final_status") { var sg = $("btnSuggest"); if (sg) sg.parentNode.remove(); }
          if (k === "agreement" && CUR.o.agreement_auto && ((nv === "Yes" && CUR.o.agreement_auto === "Disagree") || (nv === "No" && CUR.o.agreement_auto === "Agree"))) toast("Note: this differs from the automatic comparison of mapped and observed class", true);
        };
      });
    } else {
      el.oninput = function () {
        var v = el.value;
        if (el.getAttribute("data-t") === "num") v = v === "" ? null : Number(v);
        if (el.getAttribute("data-t") === "int") v = v === "" ? null : parseInt(v, 10);
        setVal(k, obj, v);
      };
      el.onchange = function () { el.oninput(); if (k === "observed_class_code") renderForm(); };
    }
  });
  root.querySelectorAll("[data-same]").forEach(function (b) { b.onclick = function () { setVal("observed_class_code", null, CUR.o.mapped_class_code); CUR.o.agreement = "Yes"; renderForm(); }; });
  if ($("btnAddSp")) $("btnAddSp").onclick = function () { CUR.o.tree = CUR.o.tree || {}; CUR.o.tree.species = CUR.o.tree.species || []; CUR.o.tree.species.push({name: "", count: null}); autosave(); renderForm(); };
  root.querySelectorAll("[data-sp]").forEach(function (el) { el.oninput = function () { var i = +el.getAttribute("data-sp"), k = el.getAttribute("data-sk"); CUR.o.tree.species[i][k] = el.type === "number" ? (el.value === "" ? null : Number(el.value)) : el.value; autosave(); }; });
  root.querySelectorAll("[data-sprm]").forEach(function (el) { el.onclick = function () { CUR.o.tree.species.splice(+el.getAttribute("data-sprm"), 1); autosave(); renderForm(); }; });
  if ($("btnSuggest")) $("btnSuggest").onclick = function () { setVal("final_status", null, CUR.o.agreement_auto === "Agree" ? STATUSES[0] : STATUSES[1]); renderForm(); };
  $("btnGps").onclick = function () { doCaptureGps(); };
  $("btnManual").onclick = doManualGps;
  $("btnCompass").onclick = startCompass;
  bindPhotos();
  $("btnSave").onclick = saveObs;
}
async function doCaptureGps() {
  if (CAPTURING) return;
  var cur = CUR; if (!cur) return;
  CAPTURING = true; refreshGps();
  try {
    var f = await captureGps(Number(SET.gps_seconds || 25), Math.min(5, setting("gps_accuracy_warn_m", 10)));
    if (CUR === cur) {
      if (cur.o.gps && cur.o.gps.source === "manual") cur.o.manual_correction = Object.assign({}, cur.o.manual_correction || {}, {superseded_by_device_fix: nowIso()});
      cur.o.gps = f;
      cur.o.dist_planned_actual_m = Math.round(hav(cur.o.planned.lat, cur.o.planned.lon, f.lat, f.lon) * 10) / 10;
      autosave(); toast("Location captured: " + f.accuracy_m + " m accuracy, " + Math.round(cur.o.dist_planned_actual_m) + " m from the point");
    }
  } catch (e) { if (CUR === cur) toast(e.message, true); }
  CAPTURING = false;
  if (CUR === cur) refreshGps();
}
async function doManualGps() {
  var g = CUR.o.gps || {};
  var r = await dlg('<h3>Manual coordinate correction</h3><div class="note warn">Use only when the device GPS is unusable. The entry is marked MANUAL and the reason is recorded; the planned coordinates are never changed.</div><label class="f">Latitude</label><input type="number" data-f="lat" value="' + esc(g.lat || CUR.o.planned.lat) + '"><label class="f">Longitude</label><input type="number" data-f="lon" value="' + esc(g.lon || CUR.o.planned.lon) + '"><label class="f req">Reason</label><input type="text" data-f="reason" placeholder="e.g. dense canopy, no GPS fix">', [{id: "c", label: "Cancel", cls: "sec"}, {id: "ok", label: "Save"}]);
  if (r.id !== "ok") return;
  var lat = Number(r.vals.lat), lon = Number(r.vals.lon);
  if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180) || isNaN(lat) || isNaN(lon)) return toast("Invalid coordinates", true);
  if (!r.vals.reason || r.vals.reason.trim().length < 3) return toast("A reason is required", true);
  CUR.o.manual_correction = {time: nowIso(), reason: r.vals.reason.trim(), previous_fix: CUR.o.gps || null, lat: lat, lon: lon};
  CUR.o.gps = {lat: lat, lon: lon, accuracy_m: null, altitude_m: null, timestamp: nowIso(), source: "manual"};
  CUR.o.dist_planned_actual_m = Math.round(hav(CUR.o.planned.lat, CUR.o.planned.lon, lat, lon) * 10) / 10;
  autosave(); refreshGps();
}

/* ================================================================ photos */
function bindPhotos() {
  var root = $("view");
  root.querySelectorAll("input[type=file][data-slot]").forEach(function (inp) {
    inp.onchange = async function () { if (inp.files && inp.files[0]) { await addPhoto(inp.getAttribute("data-slot"), inp.files[0]); refreshPhotos(); } };
  });
  root.querySelectorAll("[data-ph]").forEach(function (el) {
    el.onchange = async function () { var ph = await getOne("photos", el.getAttribute("data-ph")); ph[el.getAttribute("data-pk")] = el.value; ph.direction_source = ph.direction_source || (el.getAttribute("data-pk") === "direction_label" ? "manual" : ph.direction_source); ph.exported = false; ph.synced = false; await put("photos", ph); };
  });
  root.querySelectorAll("[data-phrm]").forEach(function (el) {
    el.onclick = async function () {
      var r = await dlg("<h3>Remove photo?</h3><p>The photo stays in the device backup but is excluded from exports.</p>", [{id: "c", label: "Cancel", cls: "sec"}, {id: "ok", label: "Remove", cls: "bad"}]);
      if (r.id !== "ok") return;
      var ph = await getOne("photos", el.getAttribute("data-phrm")); ph.deleted = true; ph.deleted_at = nowIso(); ph.exported = false; ph.synced = false; await put("photos", ph);
      CUR.o.photos = (CUR.o.photos || []).filter(function (x) { return x !== ph.photo_id; }); autosave(); refreshPhotos();
    };
  });
  root.querySelectorAll("[data-phgps]").forEach(function (el) {
    el.onclick = async function () {
      var r = await dlg('<h3>Photo location (manual)</h3><div class="note warn">The photo has no geotag. A manually entered location is labelled MANUAL in all outputs.</div><label class="f">Latitude</label><input type="number" data-f="lat" value="' + esc((CUR.o.gps || CUR.o.planned).lat) + '"><label class="f">Longitude</label><input type="number" data-f="lon" value="' + esc((CUR.o.gps || CUR.o.planned).lon) + '">', [{id: "c", label: "Cancel", cls: "sec"}, {id: "ok", label: "Save"}]);
      if (r.id !== "ok") return;
      var lat = Number(r.vals.lat), lon = Number(r.vals.lon); if (isNaN(lat) || isNaN(lon)) return toast("Invalid coordinates", true);
      var ph = await getOne("photos", el.getAttribute("data-phgps")); ph.gps = {lat: lat, lon: lon, source: "manual", entered_at: nowIso()}; ph.exported = false; ph.synced = false; await put("photos", ph); refreshPhotos();
    };
  });
}
async function refreshPhotos() { var b = $("photoBox"); if (b) { b.innerHTML = await photosHtml(); bindPhotos(); } }
async function sha256(buf) { var h = await crypto.subtle.digest("SHA-256", buf); return Array.prototype.map.call(new Uint8Array(h), function (b) { return ("0" + b.toString(16)).slice(-2); }).join(""); }
function makeThumb(blob) {
  return new Promise(function (res) {
    var url = URL.createObjectURL(blob), img = new Image();
    img.onload = function () {
      var s = 360 / Math.max(img.width, img.height), c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(img.width * s)); c.height = Math.max(1, Math.round(img.height * s));
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      c.toBlob(function (b) { URL.revokeObjectURL(url); res(b); }, "image/jpeg", 0.7);
    };
    img.onerror = function () { URL.revokeObjectURL(url); res(null); };
    img.src = url;
  });
}
async function addPhoto(slot, file) {
  var cur = CUR; if (!cur) return;
  try {
    var buf = await file.arrayBuffer();
    var hash = await sha256(buf);
    var all = await getAll("photos");
    var dup = all.filter(function (p) { return p.sha256 === hash && !p.deleted; })[0];
    if (dup) {
      var r = await dlg("<h3>Duplicate photograph</h3><p>This exact image is already stored for " + esc(dup.pid) + " (" + esc(dup.slot) + "). Add it again?</p>", [{id: "c", label: "Cancel", cls: "sec"}, {id: "ok", label: "Add anyway", cls: "warn"}]);
      if (r.id !== "ok") return;
    }
    var ex = {};
    try { ex = parseExif(buf); } catch (e) { ex = {}; }
    var gps = null;
    if (ex.lat !== undefined && ex.lat !== null) gps = {lat: ex.lat, lon: ex.lon, altitude_m: ex.alt === undefined ? null : ex.alt, source: "exif"};
    else if (GPS.last && Date.now() - GPS.last.ms < 120000) gps = {lat: GPS.last.lat, lon: GPS.last.lon, accuracy_m: GPS.last.accuracy_m, altitude_m: GPS.last.altitude_m, source: "device_at_capture", fix_time: GPS.last.timestamp};
    else if (cur.o.gps && cur.o.gps.lat !== undefined && cur.o.gps.lat !== null) gps = {lat: cur.o.gps.lat, lon: cur.o.gps.lon, accuracy_m: cur.o.gps.accuracy_m, altitude_m: cur.o.gps.altitude_m, source: cur.o.gps.source === "manual" ? "manual" : "observation_fix", fix_time: cur.o.gps.timestamp};
    var head = compassNow();
    var dirDeg = ex.direction !== undefined ? ex.direction : head;
    var takenAt = ex.datetime || nowIso();
    toast("Processing photo...");
    var pr = await processPhoto(buf, file.type || "image/jpeg", {gps: gps, ex: ex, dir: dirDeg, dirSource: ex.direction !== undefined ? "exif" : "compass", slot: slot, takenAt: takenAt, cur: cur});
    var blob = pr.blob;
    var thumb = await makeThumb(blob);
    var ph = {photo_id: uuid(), pid: cur.pid, obs_id: cur.o.obs_id, project_id: projId(), slot: slot,
      taken_at: takenAt, taken_at_source: ex.datetime ? "exif (camera clock)" : "device clock at capture",
      gps: gps, direction_deg: dirDeg, direction_label: dirLabel(dirDeg),
      direction_source: ex.direction !== undefined ? "exif" : (head !== null ? "compass" : null), description: "",
      mime: blob.type || file.type || "image/jpeg", size: blob.size, original_size: file.size, width: pr.width || null, height: pr.height || null,
      processing: pr.mode, exif_gps_written: pr.exifGps, stamped: pr.stamped, processing_note: pr.note || null,
      sha256: hash, original_name: file.name || "", blob: blob, thumb: thumb,
      created: nowIso(), exported: false, synced: false, duplicate_of: dup ? dup.photo_id : null};
    await put("photos", ph);
    cur.o.photos = (cur.o.photos || []).concat([ph.photo_id]);
    autosave();
    toast("Photo stored" + (gps ? (pr.exifGps ? " - geotagged" : " (" + gps.source + ")") : " - no GPS fix yet, capture GPS first"), !gps);
  } catch (e) { toast("Photo not stored: " + e.message, true); }
}

/* ---------------------------------------------------------------- photo geotagging
   Phone browsers (iPhone Safari in particular) remove the GPS tags from photos taken through a web
   page. The app therefore writes its own EXIF block (GPS position, accuracy, altitude, direction,
   date/time, point ID) into every JPEG and, unless switched off, burns a visible stamp onto the image. */
var SLOT_LBL = {general: "General landscape view", opposite: "Opposite direction", vegetation: "Dominant vegetation / crop", feature: "Land-use feature", extra: "Additional photo"};
async function processPhoto(buf, mime, info) {
  var mode = SET.photo_mode || "stamp2048", isJpeg = /jpe?g/i.test(mime) || (new Uint8Array(buf, 0, 2)[0] === 0xFF && new Uint8Array(buf, 0, 2)[1] === 0xD8);
  var orig = new Blob([buf], {type: mime});
  var hasExifGps = info.gps && info.gps.source === "exif";
  if (mode !== "orig") {
    try {
      var maxPx = mode === "stamp_full" ? 4096 : 2048;
      var r = await stampImage(orig, info, maxPx);
      var out = new Uint8Array(await r.blob.arrayBuffer()), exifOk = false;
      try { out = jpegReplaceExif(out, buildExifApp1(exifInfo(info, r.w, r.h, 1))); exifOk = !!info.gps; } catch (e2) { console.warn("EXIF", e2); }
      return {blob: new Blob([out], {type: "image/jpeg"}), mode: mode, stamped: true, exifGps: exifOk, width: r.w, height: r.h};
    } catch (e) { console.warn("stamp failed", e); var note = "stamp failed (" + e.message + "), original kept"; }
  }
  if (isJpeg && info.gps && !hasExifGps) {
    try {
      var o2 = jpegReplaceExif(new Uint8Array(buf), buildExifApp1(exifInfo(info, null, null, info.ex.orientation || 1)));
      return {blob: new Blob([o2], {type: "image/jpeg"}), mode: "orig", stamped: false, exifGps: true, note: note};
    } catch (e3) { console.warn("EXIF orig", e3); note = (note ? note + "; " : "") + "EXIF write failed"; }
  }
  return {blob: orig, mode: "orig", stamped: false, exifGps: !!hasExifGps, note: note};
}
function exifInfo(info, w, h, orientation) {
  var p = info.cur.p, o = info.cur.o, g = info.gps;
  return {gps: g && g.lat !== undefined && g.lat !== null ? g : null, dir: info.dir, dirSource: info.dirSource, takenAt: info.takenAt, w: w, h: h, orientation: orientation,
    make: info.ex.make, model: info.ex.model, artist: o.surveyor || SET.surveyor || "",
    desc: "Point " + p.pid + " | ML " + (p.ml_id || "-") + " | Mapped " + (p.class_name || "-") + " | " + (SLOT_LBL[info.slot] || info.slot) + " | " + (PKG.project.name || "")};
}
function loadImg(blob) {
  return new Promise(function (res, rej) {
    var url = URL.createObjectURL(blob), img = new Image();
    img.onload = function () { res({img: img, url: url}); };
    img.onerror = function () { URL.revokeObjectURL(url); rej(new Error("this image format cannot be decoded here")); };
    img.src = url;
  });
}
function toJpeg(c, q) { return new Promise(function (res, rej) { c.toBlob(function (b) { if (b) res(b); else rej(new Error("image too large for this phone")); }, "image/jpeg", q); }); }
function latTxt(v, pos, neg) { return Math.abs(v).toFixed(6) + "\u00B0 " + (v >= 0 ? pos : neg); }
async function stampImage(blob, info, maxPx) {
  var li = await loadImg(blob), img = li.img;
  var W0 = img.naturalWidth, H0 = img.naturalHeight, s = Math.min(1, maxPx / Math.max(W0, H0));
  var W = Math.max(1, Math.round(W0 * s)), H = Math.max(1, Math.round(H0 * s));
  var c = document.createElement("canvas"); c.width = W; c.height = H;
  var x = c.getContext("2d");
  x.drawImage(img, 0, 0, W, H);
  URL.revokeObjectURL(li.url);
  var p = info.cur.p, o = info.cur.o, g = info.gps, t = info.takenAt || nowIso(), toff = t.length > 19 ? t.slice(19) : "";
  var lines = [
    "Point " + p.pid + "   |   ML " + (p.ml_id || "-") + "   |   Mapped: " + (p.class_name || "not specified"),
    g ? "Lat " + latTxt(g.lat, "N", "S") + "   Lon " + latTxt(g.lon, "E", "W") + (g.accuracy_m ? "   \u00B1" + Math.round(g.accuracy_m) + " m" : "") + (g.altitude_m !== null && g.altitude_m !== undefined ? "   Alt " + Math.round(g.altitude_m) + " m" : "") + (g.source === "manual" ? "   (MANUAL)" : "")
      : "GPS position not available",
    t.replace("T", " ").slice(0, 19) + (toff ? " (UTC" + toff + ")" : "") + "   |   " + (SLOT_LBL[info.slot] || info.slot) + (info.dir !== null && info.dir !== undefined ? "   |   Facing " + dirLabel(info.dir) + " " + Math.round(info.dir) + "\u00B0" : ""),
    (PKG.project.name || "") + ((o.surveyor || SET.surveyor) ? "   |   Surveyor: " + (o.surveyor || SET.surveyor) : "")
  ];
  var fs = Math.max(14, Math.round(Math.max(W, H) / 68)), lh = Math.round(fs * 1.32), pad = Math.round(fs * 0.6);
  var bandH = lines.length * lh + pad * 2;
  x.fillStyle = "rgba(0,0,0,0.58)"; x.fillRect(0, H - bandH, W, bandH);
  x.fillStyle = "#facc15"; x.fillRect(0, H - bandH, Math.max(4, Math.round(fs / 4)), bandH);
  x.textBaseline = "top";
  lines.forEach(function (ln, i) {
    x.font = (i === 0 ? "bold " : "") + fs + "px -apple-system, Roboto, Arial, sans-serif";
    var txt = ln, maxW = W - pad * 3;
    while (txt.length > 4 && x.measureText(txt).width > maxW) txt = txt.slice(0, -2);
    if (txt !== ln) txt = txt.slice(0, -1) + "~";
    x.fillStyle = i === 0 ? "#facc15" : "#ffffff";
    x.fillText(txt, pad * 2, H - bandH + pad + i * lh);
  });
  var out = await toJpeg(c, 0.88);
  c.width = 1; c.height = 1;
  return {blob: out, w: W, h: H};
}
/* Minimal EXIF (TIFF big-endian) writer: IFD0 + Exif IFD + GPS IFD. */
function exifAscii(s) { s = String(s === null || s === undefined ? "" : s).replace(/[^\x20-\x7E]/g, "?"); var a = []; for (var i = 0; i < s.length; i++) a.push(s.charCodeAt(i)); a.push(0); return a; }
function exifIfd(entries, start) {
  /* entries: [tag, type, count, valueBytes]; returns bytes laid out at TIFF offset 'start'. */
  entries.sort(function (a, b) { return a[0] - b[0]; });
  var n = entries.length, head = 2 + n * 12 + 4, data = [], out = [];
  var u16 = function (v) { out.push((v >> 8) & 255, v & 255); }, u32 = function (v) { out.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255); };
  u16(n);
  entries.forEach(function (e) {
    u16(e[0]); u16(e[1]); u32(e[2]);
    var b = e[3];
    if (b.length <= 4) { for (var i = 0; i < 4; i++) out.push(i < b.length ? b[i] : 0); }
    else { u32(start + head + data.length); for (var k = 0; k < b.length; k++) data.push(b[k]); if (data.length % 2) data.push(0); }
  });
  u32(0);
  return out.concat(data);
}
function bU16(v) { return [(v >> 8) & 255, v & 255]; }
function bU32(v) { return [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]; }
function bRat(list) { var a = []; list.forEach(function (r) { a = a.concat(bU32(r[0]), bU32(r[1])); }); return a; }
function dmsRat(v) {
  v = Math.abs(v); var d = Math.floor(v), mf = (v - d) * 60, m = Math.floor(mf), s = Math.round((mf - m) * 60 * 10000);
  if (s >= 600000) { s -= 600000; m++; } if (m >= 60) { m -= 60; d++; }
  return [[d, 1], [m, 1], [s, 10000]];
}
function buildExifApp1(e) {
  var t = e.takenAt || nowIso(), loc = t.slice(0, 19).replace(/-/g, ":").replace("T", " "), off = t.length > 19 ? t.slice(19) : null;
  var ifd0 = [[0x010E, 2, 0, exifAscii(e.desc)], [0x0112, 3, 1, bU16(e.orientation || 1)], [0x0131, 2, 0, exifAscii("LULC Field Survey " + APP_VERSION)], [0x0132, 2, 0, exifAscii(loc)]];
  if (e.make) ifd0.push([0x010F, 2, 0, exifAscii(e.make)]);
  if (e.model) ifd0.push([0x0110, 2, 0, exifAscii(e.model)]);
  if (e.artist) ifd0.push([0x013B, 2, 0, exifAscii(e.artist)]);
  ifd0.forEach(function (x) { if (x[1] === 2) x[2] = x[3].length; });
  var exif = [[0x9000, 7, 4, [48, 50, 51, 50]], [0x9003, 2, 20, exifAscii(loc)], [0x9004, 2, 20, exifAscii(loc)]];
  if (off && /^[+-]\d\d:\d\d$/.test(off)) { exif.push([0x9010, 2, 7, exifAscii(off)]); exif.push([0x9011, 2, 7, exifAscii(off)]); }
  if (e.w && e.h) { exif.push([0xA002, 4, 1, bU32(e.w)]); exif.push([0xA003, 4, 1, bU32(e.h)]); }
  var gps = null;
  if (e.gps) {
    var g = e.gps, utc = new Date(Date.parse(t) || Date.now()), alt = g.altitude_m;
    gps = [[0x0000, 1, 4, [2, 3, 0, 0]], [0x0001, 2, 2, exifAscii(g.lat >= 0 ? "N" : "S")], [0x0002, 5, 3, bRat(dmsRat(g.lat))],
      [0x0003, 2, 2, exifAscii(g.lon >= 0 ? "E" : "W")], [0x0004, 5, 3, bRat(dmsRat(g.lon))], [0x0012, 2, 7, exifAscii("WGS-84")],
      [0x0007, 5, 3, bRat([[utc.getUTCHours(), 1], [utc.getUTCMinutes(), 1], [utc.getUTCSeconds(), 1]])],
      [0x001D, 2, 11, exifAscii(utc.getUTCFullYear() + ":" + pad(utc.getUTCMonth() + 1) + ":" + pad(utc.getUTCDate()))]];
    if (alt !== null && alt !== undefined && isFinite(alt)) { gps.push([0x0005, 1, 1, [alt < 0 ? 1 : 0]]); gps.push([0x0006, 5, 1, bRat([[Math.round(Math.abs(alt) * 10), 10]])]); }
    if (g.accuracy_m !== null && g.accuracy_m !== undefined && isFinite(g.accuracy_m)) gps.push([0x001F, 5, 1, bRat([[Math.round(g.accuracy_m * 10), 10]])]);
    if (e.dir !== null && e.dir !== undefined && isFinite(e.dir)) { gps.push([0x0010, 2, 2, exifAscii(e.dirSource === "exif" ? "T" : "M")]); gps.push([0x0011, 5, 1, bRat([[Math.round(((e.dir % 360) + 360) % 360 * 100), 100]])]); }
  }
  /* layout: header(8) | IFD0 | Exif IFD | GPS IFD ; pointers are LONGs so sizes do not depend on their values */
  ifd0.push([0x8769, 4, 1, bU32(0)]); if (gps) ifd0.push([0x8825, 4, 1, bU32(0)]);
  var size0 = exifIfd(ifd0.map(function (x) { return x.slice(); }), 8).length;
  var exifOff = 8 + size0, exifB = exifIfd(exif, exifOff), gpsOff = exifOff + exifB.length;
  ifd0.forEach(function (x) { if (x[0] === 0x8769) x[3] = bU32(exifOff); if (x[0] === 0x8825) x[3] = bU32(gpsOff); });
  var tiff = [0x4D, 0x4D, 0, 42, 0, 0, 0, 8].concat(exifIfd(ifd0, 8), exifB, gps ? exifIfd(gps, gpsOff) : []);
  var body = [0x45, 0x78, 0x69, 0x66, 0, 0].concat(tiff), len = body.length + 2;
  if (len > 65535) throw new Error("EXIF block too large");
  return new Uint8Array([0xFF, 0xE1, (len >> 8) & 255, len & 255].concat(body));
}
function jpegReplaceExif(jpg, app1) {
  /* Drops JFIF APP0 and existing EXIF APP1 segments, then inserts the new EXIF APP1 right after SOI. */
  if (jpg[0] !== 0xFF || jpg[1] !== 0xD8) throw new Error("not a JPEG");
  var keep = [], i = 2;
  while (i + 4 <= jpg.length) {
    if (jpg[i] !== 0xFF) throw new Error("bad JPEG marker");
    var mk = jpg[i + 1];
    if (mk === 0xFF) { i++; continue; }
    if (mk === 0xDA || mk === 0xD9) break;
    if ((mk >= 0xD0 && mk <= 0xD7) || mk === 0x01) { keep.push(jpg.subarray(i, i + 2)); i += 2; continue; }
    var sl = (jpg[i + 2] << 8) | jpg[i + 3], seg = jpg.subarray(i, i + 2 + sl);
    var isJfif = mk === 0xE0 && seg[4] === 0x4A && seg[5] === 0x46 && seg[6] === 0x49 && seg[7] === 0x46;
    var isExif = mk === 0xE1 && seg[4] === 0x45 && seg[5] === 0x78 && seg[6] === 0x69 && seg[7] === 0x66 && seg[8] === 0 && seg[9] === 0;
    if (!isJfif && !isExif) keep.push(seg);
    i += 2 + sl;
  }
  var rest = jpg.subarray(i), total = 2 + app1.length + rest.length;
  keep.forEach(function (k) { total += k.length; });
  var out = new Uint8Array(total), p = 0;
  out[p++] = 0xFF; out[p++] = 0xD8; out.set(app1, p); p += app1.length;
  keep.forEach(function (k) { out.set(k, p); p += k.length; });
  out.set(rest, p);
  return out;
}
function parseExif(buf) {
  var v = new DataView(buf);
  if (v.byteLength < 4 || v.getUint16(0) !== 0xFFD8) return {};
  var off = 2;
  while (off < v.byteLength - 4) {
    var mk = v.getUint16(off), sz = v.getUint16(off + 2);
    if (mk === 0xFFE1 && v.getUint32(off + 4) === 0x45786966) return readTiff(v, off + 10);
    if ((mk & 0xFF00) !== 0xFF00 || mk === 0xFFDA) break;
    off += 2 + sz;
  }
  return {};
}
function readTiff(v, t) {
  var le = v.getUint16(t) === 0x4949, g16 = function (o) { return v.getUint16(o, le); }, g32 = function (o) { return v.getUint32(o, le); };
  var dir = function (d) { var n = g16(d), out = {}; for (var i = 0; i < n; i++) { var e = d + 2 + i * 12; out[g16(e)] = {type: g16(e + 2), count: g32(e + 4), e: e + 8}; } return out; };
  var size = {1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8};
  var val = function (tg) {
    if (!tg) return undefined;
    var n = tg.count * (size[tg.type] || 1), p = n > 4 ? t + g32(tg.e) : tg.e, out = [];
    for (var i = 0; i < tg.count; i++) {
      if (tg.type === 2) { var s = ""; for (var k = 0; k < tg.count; k++) { var ch = v.getUint8(p + k); if (!ch) break; s += String.fromCharCode(ch); } return s; }
      if (tg.type === 3) out.push(g16(p + i * 2));
      else if (tg.type === 4) out.push(g32(p + i * 4));
      else if (tg.type === 5) out.push(g32(p + i * 8) / (g32(p + i * 8 + 4) || 1));
      else if (tg.type === 10) out.push(v.getInt32(p + i * 8, le) / (v.getInt32(p + i * 8 + 4, le) || 1));
      else out.push(v.getUint8(p + i));
    }
    return out.length === 1 ? out[0] : out;
  };
  var ifd0 = dir(t + g32(t + 4)), res = {};
  try { var orn = val(ifd0[0x0112]); if (orn >= 1 && orn <= 8) res.orientation = orn; res.make = val(ifd0[0x010F]) || null; res.model = val(ifd0[0x0110]) || null; } catch (e) { /* optional tags */ }
  var dt = null;
  if (ifd0[0x8769]) { var ex = dir(t + val(ifd0[0x8769])); dt = val(ex[0x9003]) || null; }
  if (!dt) dt = val(ifd0[0x0132]) || null;
  if (dt && /^\d{4}:\d\d:\d\d \d\d:\d\d:\d\d/.test(dt)) res.datetime = dt.slice(0, 10).replace(/:/g, "-") + "T" + dt.slice(11, 19);
  if (ifd0[0x8825]) {
    var gp = dir(t + val(ifd0[0x8825]));
    var la = val(gp[2]), lo = val(gp[4]);
    if (la && lo && la.length === 3 && lo.length === 3) {
      var lat = la[0] + la[1] / 60 + la[2] / 3600, lon = lo[0] + lo[1] / 60 + lo[2] / 3600;
      if (val(gp[1]) === "S") lat = -lat; if (val(gp[3]) === "W") lon = -lon;
      if (!(lat === 0 && lon === 0) && isFinite(lat) && isFinite(lon)) { res.lat = Math.round(lat * 1e7) / 1e7; res.lon = Math.round(lon * 1e7) / 1e7; }
      var al = val(gp[6]); if (al !== undefined) res.alt = (val(gp[5]) === 1 ? -1 : 1) * al;
      var di = val(gp[0x11]); if (di !== undefined && isFinite(di)) res.direction = Math.round(di);
    }
  }
  return res;
}

/* ================================================================ save */
function validate(o) {
  var miss = [], warn = [];
  var noCls = NO_CLASS_NEEDED.indexOf(o.final_status) >= 0;
  if (!o.final_status) miss.push("Final field decision (Section H)");
  if (!noCls && (o.observed_class_code === null || o.observed_class_code === undefined || o.observed_class_code === "")) miss.push("Observed reference class (Section B)");
  if (!noCls && !o.agreement && !noMapped(o)) miss.push("Classification agreement");
  if (!noCls && !o.confidence) miss.push("Confidence level");
  if (!o.surveyor) miss.push("Surveyor name");
  if (!o.gps) warn.push("No GPS location captured");
  else if (o.gps.source !== "manual" && o.gps.accuracy_m > setting("gps_accuracy_warn_m", 10)) warn.push("GPS accuracy " + o.gps.accuracy_m + " m is worse than " + setting("gps_accuracy_warn_m", 10) + " m");
  var dl = setting("distance_warn_m", 30);
  if (o.dist_planned_actual_m !== null && o.dist_planned_actual_m !== undefined && o.dist_planned_actual_m > dl) warn.push("Actual position is " + Math.round(o.dist_planned_actual_m) + " m from the planned point (limit " + dl + " m)");
  var minP = setting("min_photos", 1);
  if ((o.photos || []).length < minP && !noCls) warn.push("Fewer than " + minP + " photograph(s)");
  if (o.agreement_auto === "Disagree" && o.final_status === STATUSES[0]) warn.push("Final status says 'Correct' but observed class differs from the map");
  if (o.agreement_auto === "Agree" && o.final_status === STATUSES[1]) warn.push("Final status says 'Mismatch' but observed class equals the map");
  return {miss: miss, warn: warn};
}
async function saveObs() {
  if (CAPTURING) {
    var w = await dlg("<h3>Location still being captured</h3><p>Wait a few seconds for the GPS capture to finish, so the observation gets its location.</p>", [{id: "c", label: "Wait", cls: "sec"}, {id: "ok", label: "Save without waiting", cls: "warn"}]);
    if (w.id !== "ok") return;
  }
  var o = CUR.o, v = validate(o);
  if (v.miss.length) return dlg("<h3>Missing mandatory fields</h3><ul>" + v.miss.map(function (x) { return "<li>" + esc(x) + "</li>"; }).join("") + "</ul>", [{id: "ok", label: "OK"}]);
  if (v.warn.length) {
    var r = await dlg("<h3>Please check</h3><ul>" + v.warn.map(function (x) { return "<li>" + esc(x) + "</li>"; }).join("") + "</ul><p>Save anyway? The warnings are stored as QC flags.</p>", [{id: "c", label: "Go back", cls: "sec"}, {id: "ok", label: "Save anyway", cls: "warn"}]);
    if (r.id !== "ok") return;
  }
  var prev = CUR.base, changed = [];
  if (prev) Object.keys(o).forEach(function (k) { if (["updated", "edit_log", "revision", "_fromDraft", "exported_rev", "synced_rev"].indexOf(k) < 0 && JSON.stringify(o[k]) !== JSON.stringify(prev[k])) changed.push(k); });
  if (prev && !changed.length) { toast("No changes"); return show("pending"); }
  delete o._fromDraft;
  o.revision = (prev ? prev.revision : 0) + 1;
  o.updated = nowIso();
  if (!o.surveyor && SET.surveyor) o.surveyor = SET.surveyor;
  o.qc_flags = v.warn.slice();
  o.edit_log = (o.edit_log || []).concat([{ts: o.updated, rev: o.revision, device: DEVICE, changed: prev ? changed : ["created"]}]);
  if (o.surveyor && o.surveyor !== SET.surveyor) { SET.surveyor = o.surveyor; saveSettings(); }
  clearTimeout(_as);
  try { await put("obs", o); await del("drafts", o.pid); } catch (e) { return dlg("<h3>Could not save</h3><p>" + esc(e.message) + "</p><p>Free storage on the phone, then try again. Nothing has been lost from the draft.</p>", [{id: "ok", label: "OK"}]); }
  await loadObs(); updateChips();
  CUR = null;
  toast("Saved " + o.pid + " (revision " + o.revision + ")");
  if (SET.auto_sync && navigator.onLine) syncNow(true);
  var np = nextPending();
  if (np && np.route) { show(np.route.day === 2 ? "day2" : "day1"); openSheet(np.pid); }
  else if (np) goToPoint(np.pid);
  else show("dash");
}

/* ================================================================ export / backup / sync */
function cleanObs(o) { var c = JSON.parse(JSON.stringify(o)); delete c.exported_rev; delete c.synced_rev; delete c._fromDraft; return c; }
function photoMeta(p, file) { var m = {}; Object.keys(p).forEach(function (k) { if (["blob", "thumb", "exported", "synced"].indexOf(k) < 0) m[k] = p[k]; }); if (file) m.file = file; return m; }
function stamp() { return nowIso().slice(0, 16).replace(/[-:T]/g, ""); }
async function deliver(blob, name) {
  var file = null;
  try { file = new File([blob], name, {type: blob.type || "application/octet-stream"}); } catch (e) { file = null; }
  var canShare = file && navigator.canShare && navigator.canShare({files: [file]});
  var r = await dlg("<h3>" + esc(name) + "</h3><p>" + (blob.size / 1048576).toFixed(1) + " MB. Share it to WhatsApp / Google Drive / e-mail, or save it to the phone.</p>", (canShare ? [{id: "share", label: "Share"}] : []).concat([{id: "dl", label: "Download", cls: canShare ? "sec" : ""}, {id: "c", label: "Cancel", cls: "sec"}]));
  if (r.id === "c") return false;
  if (r.id === "share") { try { await navigator.share({files: [file], title: name}); } catch (e) { if (e.name === "AbortError") return false; toast("Share failed: " + e.message, true); return false; } }
  else { var a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 60000); }
  var c = await dlg("<h3>Was the file saved or shared successfully?</h3><p>Only confirmed exports are counted as safe.</p>", [{id: "no", label: "No", cls: "sec"}, {id: "yes", label: "Yes, saved"}]);
  return c.id === "yes";
}
async function exportZip(mode, day) {
  var obs = (await getAll("obs")).filter(inProject), photos = (await getAll("photos")).filter(inProject);
  var selObs = obs.filter(function (o) {
    if (mode === "new") return (o.exported_rev || 0) < o.revision;
    if (mode === "day") { var p = pointOf(o.pid); return p && p.day === day; }
    return true;
  });
  var ids = {}; selObs.forEach(function (o) { ids[o.obs_id] = 1; });
  var selPh = photos.filter(function (p) { return !p.deleted && (mode === "new" ? !p.exported : ids[p.obs_id]); });
  if (!selObs.length && !selPh.length) return toast("Nothing to export");
  var size = selPh.reduce(function (s, p) { return s + (p.size || 0); }, 0);
  if (size > 400 * 1048576) {
    var r = await dlg("<h3>Large export</h3><p>" + (size / 1048576).toFixed(0) + " MB of photos. Large files may fail on some phones; consider exporting day by day.</p>", [{id: "c", label: "Cancel", cls: "sec"}, {id: "ok", label: "Continue"}]);
    if (r.id !== "ok") return;
  }
  toast("Building ZIP...");
  var zip = new JSZip(), meta = [];
  selPh.forEach(function (p) {
    var ext = (p.mime || "").indexOf("png") >= 0 ? ".png" : (p.mime || "").indexOf("heic") >= 0 ? ".heic" : ".jpg";
    var fn = "photos/" + p.pid + "_" + p.slot + "_" + p.photo_id.slice(0, 8) + ext;
    zip.file(fn, p.blob, {binary: true}); meta.push(photoMeta(p, fn));
  });
  var data = {format: "lulc-field-data", version: 1, app_version: APP_VERSION, project_id: PKG.project.project_id, package_id: PKG.package_id, device_id: DEVICE, exported_at: nowIso(), mode: mode, observations: selObs.map(cleanObs), photos: meta};
  zip.file("field_data.json", JSON.stringify(data, null, 1));
  /* ready-to-use tables for QGIS / Excel / Google Earth alongside the raw data */
  var phFiles = {}; meta.forEach(function (m) { (phFiles[m.obs_id] = phFiles[m.obs_id] || []).push(m.file.replace("photos/", "")); });
  var rows = selObs.map(function (o) { var r = obsRow(o); r.photo_files = (phFiles[o.obs_id] || []).join("; "); return r; });
  if (rows.length) {
    zip.file("observations.csv", rowsCsv(rows));
    zip.file("observations.geojson", JSON.stringify(rowsGeoJson(rows)));
    zip.file("observations.kml", rowsKml(rows));
  }
  var blob = await zip.generateAsync({type: "blob", compression: "STORE", mimeType: "application/zip"});
  var name = "field_data_" + DEVICE.slice(4, 10) + "_" + stamp() + ".zip";
  if (await deliver(blob, name)) {
    for (var i = 0; i < selObs.length; i++) { selObs[i].exported_rev = selObs[i].revision; await put("obs", selObs[i]); }
    for (var k = 0; k < selPh.length; k++) { selPh[k].exported = true; await put("photos", selPh[k]); }
    var log = (await metaGet("export_log")) || []; log.push({time: nowIso(), name: name, obs: selObs.length, photos: selPh.length, mode: mode}); await metaSet("export_log", log.slice(-50));
    await loadObs(); updateChips(); toast("Export recorded: " + selObs.length + " observations, " + selPh.length + " photos");
  }
  if (VIEW === "export") vExport();
}
function obsRow(o) {
  var g = o.gps || {}, a = o.agri || {}, t = o.tree || {}, f = o.forest || {};
  return {pid: o.pid, obs_id: o.obs_id, revision: o.revision, ml_id: o.ml_id, survey_date: o.survey_date, surveyor: o.surveyor, mapped_class_code: o.mapped_class_code, mapped_class_name: o.mapped_class_name, observed_class_code: o.observed_class_code, observed_class_name: o.observed_class_name, agreement: o.agreement, agreement_auto: o.agreement_auto, confidence: o.confidence, final_status: o.final_status,
    planned_lat: o.planned.lat, planned_lon: o.planned.lon, gps_lat: g.lat, gps_lon: g.lon, gps_accuracy_m: g.accuracy_m, gps_altitude_m: g.altitude_m, gps_time: g.timestamp, gps_source: g.source, dist_planned_actual_m: o.dist_planned_actual_m,
    observed_land_use: o.observed_land_use, dominant_vegetation: o.dominant_vegetation, surrounding_condition: o.surrounding_condition, mixed_condition: o.mixed_condition, boundary_mismatch: o.boundary_mismatch,
    crop_type: a.crop_type, crop_condition: a.crop_condition, tree_species: (t.species || []).map(function (s) { return s.name + (s.count ? " (" + s.count + ")" : ""); }).filter(function (s) { return s && s !== "undefined"; }).join("; "), canopy_density: f.density,
    n_photos: (o.photos || []).length, qc_flags: (o.qc_flags || []).join("; "), updated: o.updated, comments: o.comments, final_remarks: o.final_remarks};
}
function obsRows() { return Object.keys(OBS).map(function (k) { return obsRow(OBS[k]); }); }
function rowsCsv(rows) {
  var cols = Object.keys(rows[0]);
  return "\uFEFF" + [cols.join(",")].concat(rows.map(function (r) { return cols.map(function (c) { var v = r[c]; v = v === null || v === undefined ? "" : String(v); return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }).join(","); })).join("\r\n");
}
function rowsGeoJson(rows) { return {type: "FeatureCollection", name: "lulc_field_observations", features: rows.map(function (r) { return {type: "Feature", geometry: {type: "Point", coordinates: [r.planned_lon, r.planned_lat]}, properties: r}; })}; }
function xmlEsc(s) { return String(s === null || s === undefined ? "" : s).replace(/[&<>"]/g, function (c) { return {"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"}[c]; }); }
function rowsKml(rows) {
  var sty = function (id, col) { return '<Style id="' + id + '"><IconStyle><color>' + col + '</color><scale>1.1</scale><Icon><href>http://maps.google.com/mapfiles/kml/shapes/placemark_circle.png</href></Icon></IconStyle></Style>'; };
  var k = '<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>' + xmlEsc((PKG ? PKG.project.name : "LULC") + " - field observations") + "</name>" + sty("agree", "ff00c000") + sty("mismatch", "ff0000e0") + sty("other", "ff00a5ff");
  rows.forEach(function (r) {
    var s = r.agreement_auto === "Agree" ? "agree" : r.agreement_auto === "Disagree" ? "mismatch" : "other";
    var keys = ["mapped_class_name", "observed_class_name", "final_status", "confidence", "survey_date", "surveyor", "gps_accuracy_m", "dist_planned_actual_m", "observed_land_use", "dominant_vegetation", "photo_files", "comments", "final_remarks"];
    k += "<Placemark><name>" + xmlEsc(r.pid) + "</name><styleUrl>#" + s + "</styleUrl><description>" + xmlEsc(keys.filter(function (x) { return r[x] !== null && r[x] !== undefined && r[x] !== ""; }).map(function (x) { return x + ": " + r[x]; }).join("\n")) + "</description><ExtendedData>" +
      Object.keys(r).map(function (x) { return '<Data name="' + xmlEsc(x) + '"><value>' + xmlEsc(r[x]) + "</value></Data>"; }).join("") + "</ExtendedData><Point><coordinates>" + r.planned_lon + "," + r.planned_lat + ",0</coordinates></Point></Placemark>";
  });
  return k + "</Document></kml>";
}
async function exportTable(kind) {
  var rows = obsRows(); if (!rows.length) return toast("No observations");
  var blob, name;
  if (kind === "geojson") { blob = new Blob([JSON.stringify(rowsGeoJson(rows))], {type: "application/geo+json"}); name = "observations_" + stamp() + ".geojson"; }
  else if (kind === "kml") { blob = new Blob([rowsKml(rows)], {type: "application/vnd.google-earth.kml+xml"}); name = "observations_" + stamp() + ".kml"; }
  else { blob = new Blob([rowsCsv(rows)], {type: "text/csv"}); name = "observations_" + stamp() + ".csv"; }
  await deliver(blob, name);
}
async function backup() {
  toast("Building backup...");
  var zip = new JSZip(), photos = await getAll("photos"), meta = [];
  photos.forEach(function (p) { var fn = "photos/" + p.photo_id + ".bin"; zip.file(fn, p.blob, {binary: true}); if (p.thumb) zip.file("thumbs/" + p.photo_id + ".jpg", p.thumb, {binary: true}); meta.push(Object.assign(photoMeta(p, fn), {exported: p.exported, synced: p.synced})); });
  var data = {format: "lulc-field-backup", version: 1, app_version: APP_VERSION, created: nowIso(), device_id: DEVICE, settings: SET, package: PKG, observations: await getAll("obs"), drafts: await getAll("drafts"), photos: meta, export_log: (await metaGet("export_log")) || []};
  zip.file("backup.json", JSON.stringify(data));
  var blob = await zip.generateAsync({type: "blob", compression: "STORE"});
  if (await deliver(blob, "field_backup_" + DEVICE.slice(4, 10) + "_" + stamp() + ".zip")) { await metaSet("last_backup", nowIso()); toast("Backup saved"); }
  if (VIEW === "export") vExport();
}
async function restore(file) {
  try {
    var zip = await JSZip.loadAsync(file), j = zip.file("backup.json");
    if (!j) {
      if (zip.file("field_data.json")) return toast("This is a field data export; import it in the planner, not here.", true);
      return toast("Not a field app backup", true);
    }
    var data = JSON.parse(await j.async("string"));
    if (PKG && data.package && data.package.project.project_id !== PKG.project.project_id) return toast("Backup belongs to another project (" + data.package.project.name + ")", true);
    if (!PKG && data.package) { PKG = data.package; await metaSet("package", PKG); applyPkgHeader(); }
    var nObs = 0, nPh = 0;
    for (var i = 0; i < data.observations.length; i++) {
      var o = data.observations[i], cur = await getOne("obs", o.obs_id);
      if (!cur || (o.revision || 0) > (cur.revision || 0)) { await put("obs", o); nObs++; }
    }
    for (var k = 0; k < data.photos.length; k++) {
      var m = data.photos[k];
      if (await getOne("photos", m.photo_id)) continue;
      var f = zip.file(m.file); if (!f) continue;
      var b = await f.async("blob"); m.blob = new Blob([b], {type: m.mime || "image/jpeg"});
      var t = zip.file("thumbs/" + m.photo_id + ".jpg"); m.thumb = t ? await t.async("blob") : await makeThumb(m.blob);
      delete m.file; await put("photos", m); nPh++;
    }
    for (var d = 0; d < (data.drafts || []).length; d++) if (!(await getOne("drafts", data.drafts[d].pid))) await put("drafts", data.drafts[d]);
    await loadObs(); updateChips();
    toast("Restored " + nObs + " observations and " + nPh + " photos (existing data kept)");
  } catch (e) { toast("Restore failed: " + e.message, true); }
}
function syncBase() { return (SET.sync_url || "").trim().replace(/\/+$/, "").replace(/\/api\/sync$/, "").replace(/\/api$/, ""); }
async function syncNow(silent) {
  if (SYNCING) return; var base = syncBase();
  if (!base) { if (!silent) toast("Set the sync URL in Settings first", true); return; }
  if (!navigator.onLine) { if (!silent) toast("Offline - data stays on the phone", true); return; }
  SYNCING = true; var st = $("syncStatus"); if (st) st.textContent = "Synchronising...";
  try {
    var hdr = {"X-Sync-Token": SET.sync_token || ""};
    var obs = (await getAll("obs")).filter(function (o) { return (o.synced_rev || 0) < o.revision; });
    if (obs.length) {
      var r = await fetch(base + "/api/sync/observations", {method: "POST", headers: Object.assign({"Content-Type": "application/json"}, hdr), body: JSON.stringify({format: "lulc-field-data", version: 1, project_id: PKG.project.project_id, package_id: PKG.package_id, device_id: DEVICE, observations: obs.map(cleanObs)})});
      if (!r.ok) throw new Error("Server " + r.status + ": " + ((await r.json().catch(function () { return {}; })).detail || {}).message);
      var js = await r.json(), acc = {};
      js.accepted.forEach(function (a) { acc[a.obs_id] = a.revision; });
      for (var i = 0; i < obs.length; i++) if (acc[obs[i].obs_id] !== undefined && acc[obs[i].obs_id] >= obs[i].revision) { obs[i].synced_rev = obs[i].revision; await put("obs", obs[i]); }
    }
    var ph = (await getAll("photos")).filter(function (p) { return !p.synced && !p.deleted; }), n = 0;
    for (var k = 0; k < ph.length; k++) {
      var fd = new FormData(); fd.append("meta", JSON.stringify(Object.assign(photoMeta(ph[k]), {project_id: PKG.project.project_id}))); fd.append("file", ph[k].blob, ph[k].photo_id + ".jpg");
      var pr = await fetch(base + "/api/sync/photo", {method: "POST", headers: hdr, body: fd});
      if (!pr.ok) throw new Error("Photo upload failed (" + pr.status + ")");
      ph[k].synced = true; await put("photos", ph[k]); n++;
    }
    await metaSet("last_sync", nowIso());
    await loadObs(); updateChips();
    if (!silent) toast("Synchronised " + obs.length + " observations, " + n + " photos");
  } catch (e) { if (!silent) toast("Sync failed: " + e.message + " - data stays on the phone", true); var s2 = $("syncStatus"); if (s2) s2.textContent = "Last attempt failed: " + e.message; }
  SYNCING = false;
  if (VIEW === "export") vExport();
}
async function vExport() {
  var up = await unsavedPhotos(), log = (await metaGet("export_log")) || [], lb = await metaGet("last_backup"), ls = await metaGet("last_sync");
  var html = '<h2>Data export &amp; sync</h2><div class="card"><div class="kv"><div>Observations</div><div>' + OBS_ALL.length + "</div><div>Not yet exported/synced</div><div><b>" + unsaved() + " observations, " + up + " photos</b></div><div>Last backup</div><div>" + esc(lb || "never") + "</div><div>Last sync</div><div>" + esc(ls || "never") + '</div></div><div id="syncStatus" class="muted" style="font-size:13px;margin-top:6px"></div></div>' +
    '<button class="btn block" id="exNew">Export new &amp; changed data (ZIP)</button>' + (hasRoutes() ? '<div class="row2"><button class="btn sec" id="exD1">Export Day 1</button><button class="btn sec" id="exD2">Export Day 2</button></div>' : "") + '<button class="btn sec block" id="exAll">Export everything (ZIP)</button>' +
    '<div class="muted" style="font-size:12.5px">The ZIP holds the geotagged photos plus observations.csv, .geojson and .kml (opens in QGIS, Excel, Google Earth / My Maps).</div>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-top:8px"><button class="btn sec" id="exGj">GeoJSON</button><button class="btn sec" id="exCsv">CSV</button><button class="btn sec" id="exKml">KML</button></div>' +
    '<h3>Backup</h3><button class="btn sec block" id="exBk">Full device backup (ZIP)</button><label class="btn sec block">Restore from backup<input type="file" accept=".zip" id="rsFile" style="display:none"></label>' +
    '<h3>Sync</h3>' + (syncBase() ? '<button class="btn block" id="exSync">Sync now to ' + esc(syncBase()) + "</button>" : '<div class="note info">Live sync is optional. Set a sync URL in Settings, or simply share the export ZIP to the laptop.</div>') +
    (log.length ? "<h3>Export history</h3>" + '<div class="list">' + log.slice().reverse().slice(0, 15).map(function (l) { return '<div class="item"><div class="main"><b>' + esc(l.name) + "</b><small>" + esc(l.time) + " - " + l.obs + " obs, " + l.photos + " photos (" + esc(l.mode) + ")</small></div></div>"; }).join("") + "</div>" : "");
  H(html);
  $("exNew").onclick = function () { exportZip("new"); };
  $("exAll").onclick = function () { exportZip("all"); };
  if ($("exD1")) $("exD1").onclick = function () { exportZip("day", 1); };
  if ($("exD2")) $("exD2").onclick = function () { exportZip("day", 2); };
  $("exGj").onclick = function () { exportTable("geojson"); };
  $("exCsv").onclick = function () { exportTable("csv"); };
  $("exKml").onclick = function () { exportTable("kml"); };
  $("exBk").onclick = backup;
  $("rsFile").onchange = function () { if (this.files[0]) restore(this.files[0]); };
  if ($("exSync")) $("exSync").onclick = function () { syncNow(false); };
}

/* ================================================================ import points (KML / KMZ / GeoJSON / CSV)
   Builds a field package directly from a points file (Google My Maps export, QGIS export, CSV with
   lat/lon), so the planner package is not required. Polygons become Micro-landscape boundaries. */
var DEFAULT_CLASSES = [
  {code: 1, name: "Agriculture", color: "#e6c229", group: "agriculture"}, {code: 2, name: "Fallow land", color: "#f7e08b", group: "agriculture"},
  {code: 3, name: "Agroforestry", color: "#93c47d", group: "agroforestry"}, {code: 4, name: "Plantation", color: "#38761d", group: "plantation"},
  {code: 5, name: "Forest", color: "#0b5d1e", group: "forest"}, {code: 6, name: "Scrub and grassland", color: "#b6d7a8", group: "scrub"},
  {code: 7, name: "Water body", color: "#3d85c6", group: "water"}, {code: 8, name: "Built-up", color: "#cc0000", group: "builtup"},
  {code: 9, name: "Barren land", color: "#b7b7b7", group: "barren"}];
var CLASS_RULES = [[/agro.?forest/, "agroforestry", "#93c47d"], [/fallow/, "agriculture", "#f7e08b"], [/agri|crop|paddy|farm|cultiv|kharif|rabi/, "agriculture", "#e6c229"],
  [/plantation|orchard|coffee|rubber|teak|eucalyp|mango|areca|coconut|cashew|tea\b/, "plantation", "#38761d"], [/forest|woodland|tree/, "forest", "#0b5d1e"],
  [/scrub|shrub|grass|bush|pasture|grazing|meadow/, "scrub", "#b6d7a8"], [/water|river|tank|pond|lake|reservoir|wetland|canal|stream/, "water", "#3d85c6"],
  [/built|settle|urban|habitation|village|road|building|residential|industr/, "builtup", "#cc0000"], [/barren|rock|waste|bare|open land|sand|mining|quarr/, "barren", "#b7b7b7"]];
var PALETTE = ["#e6194b", "#3cb44b", "#ffe119", "#4363d8", "#f58231", "#911eb4", "#46f0f0", "#f032e6", "#bcf60c", "#fabebe", "#008080", "#e6beff", "#9a6324", "#aaffc3", "#808000"];
function classStyle(code, name, i) {
  var d = null; DEFAULT_CLASSES.forEach(function (c) { if (c.code === code && c.name.toLowerCase() === String(name).toLowerCase()) d = c; });
  if (d) return {color: d.color, group: d.group};
  var n = String(name).toLowerCase();
  for (var k = 0; k < CLASS_RULES.length; k++) if (CLASS_RULES[k][0].test(n)) return {color: CLASS_RULES[k][2], group: CLASS_RULES[k][1]};
  return {color: PALETTE[i % PALETTE.length], group: "other"};
}
function stripHtml(s) { var d = document.createElement("div"); d.innerHTML = String(s || "").replace(/<br\s*\/?>/gi, "\n"); return (d.textContent || "").trim(); }
function kChild(el, name) { var c = el.children || []; for (var i = 0; i < c.length; i++) if (c[i].localName === name) return c[i]; return null; }
function kText(el) { return el ? (el.textContent || "").trim() : ""; }
function kCoords(s) { return String(s || "").trim().split(/\s+/).map(function (t) { var a = t.split(","); return [Number(a[0]), Number(a[1])]; }).filter(function (c) { return isFinite(c[0]) && isFinite(c[1]) && !(c[0] === 0 && c[1] === 0); }); }
function parseKml(text, fname) {
  var doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) throw new Error(fname + ": not a valid KML file");
  var out = [], pms = doc.getElementsByTagNameNS("*", "Placemark");
  for (var i = 0; i < pms.length; i++) {
    var pm = pms[i], props = {}, nm = kText(kChild(pm, "name"));
    if (nm) props.name = nm;
    var ext = 0, dd = pm.getElementsByTagNameNS("*", "Data"), sd = pm.getElementsByTagNameNS("*", "SimpleData");
    for (var a = 0; a < dd.length; a++) { var k = dd[a].getAttribute("name"); if (k) { props[k] = kText(kChild(dd[a], "value")); ext++; } }
    for (var b = 0; b < sd.length; b++) { var k2 = sd[b].getAttribute("name"); if (k2) { props[k2] = kText(sd[b]); ext++; } }
    var desc = kText(kChild(pm, "description"));
    if (desc) {
      var plain = stripHtml(desc);
      if (!ext) plain.split(/\n/).forEach(function (ln) { var m = ln.match(/^\s*([^:]{1,40}):\s*(.*)$/); if (m && props[m[1].trim()] === undefined) { props[m[1].trim()] = m[2].trim(); ext++; } });
      if (!ext && plain) props.description = plain.slice(0, 300);
    }
    var layer = fname, par = pm.parentNode;
    while (par && par.nodeType === 1) { if (par.localName === "Folder" || par.localName === "Document") { var ln2 = kText(kChild(par, "name")); if (ln2) { layer = ln2; break; } } par = par.parentNode; }
    var pt = pm.getElementsByTagNameNS("*", "Point");
    if (pt.length) { var c = kCoords(kText(pt[0].getElementsByTagNameNS("*", "coordinates")[0])); if (c.length) out.push({type: "pt", lon: c[0][0], lat: c[0][1], props: props, layer: layer}); }
    var pg = pm.getElementsByTagNameNS("*", "Polygon"), polys = [];
    for (var j = 0; j < pg.length; j++) {
      var rings = [], ob = pg[j].getElementsByTagNameNS("*", "outerBoundaryIs")[0], ib = pg[j].getElementsByTagNameNS("*", "innerBoundaryIs");
      if (ob) rings.push(kCoords(kText(ob.getElementsByTagNameNS("*", "coordinates")[0])));
      for (var q = 0; q < ib.length; q++) rings.push(kCoords(kText(ib[q].getElementsByTagNameNS("*", "coordinates")[0])));
      rings = rings.filter(function (r) { return r.length >= 3; });
      if (rings.length) polys.push(rings);
    }
    if (polys.length) out.push({type: "poly", geometry: polys.length === 1 ? {type: "Polygon", coordinates: polys[0]} : {type: "MultiPolygon", coordinates: polys}, props: props, layer: layer});
    var ls = pm.getElementsByTagNameNS("*", "LineString");
    for (var w = 0; w < ls.length; w++) { var lc = kCoords(kText(ls[w].getElementsByTagNameNS("*", "coordinates")[0])); if (lc.length >= 2) out.push({type: "line", geometry: {type: "LineString", coordinates: lc}, props: props, layer: layer}); }
  }
  return out;
}
function parseGeoJson(j, fname) {
  var feats = j.type === "FeatureCollection" ? j.features : j.type === "Feature" ? [j] : [{type: "Feature", properties: {}, geometry: j}], out = [];
  (feats || []).forEach(function (f) {
    var g = f && f.geometry, props = {}; if (!g) return;
    Object.keys(f.properties || {}).forEach(function (k) { var v = f.properties[k]; props[k] = v === null || v === undefined ? "" : (typeof v === "object" ? JSON.stringify(v) : String(v)); });
    if (f.id !== undefined && props.id === undefined) props.id = String(f.id);
    var layer = j.name || fname;
    if (g.type === "Point") out.push({type: "pt", lon: Number(g.coordinates[0]), lat: Number(g.coordinates[1]), props: props, layer: layer});
    else if (g.type === "MultiPoint") g.coordinates.forEach(function (c) { out.push({type: "pt", lon: Number(c[0]), lat: Number(c[1]), props: Object.assign({}, props), layer: layer}); });
    else if (g.type === "Polygon" || g.type === "MultiPolygon") out.push({type: "poly", geometry: g, props: props, layer: layer});
    else if (g.type === "LineString" || g.type === "MultiLineString") out.push({type: "line", geometry: g, props: props, layer: layer});
  });
  return out;
}
function parseCsvRows(text) {
  text = text.replace(/^\uFEFF/, "");
  var first = text.split(/\r?\n/)[0] || "", delim = [",", ";", "\t"].sort(function (a, b) { return first.split(b).length - first.split(a).length; })[0];
  var rows = [], row = [], cell = "", q = false;
  for (var i = 0; i < text.length; i++) {
    var ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
    else if (ch === '"') q = true;
    else if (ch === delim) { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += ch;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(function (r) { return r.some(function (c) { return String(c).trim() !== ""; }); });
}
function parseCsv(text, fname) {
  var rows = parseCsvRows(text); if (rows.length < 2) throw new Error(fname + ": no data rows");
  var hdr = rows[0].map(function (h) { return String(h).trim(); }), low = hdr.map(function (h) { return h.toLowerCase().replace(/[\s-]/g, "_"); });
  var find = function (c) { for (var i = 0; i < c.length; i++) { var k = low.indexOf(c[i]); if (k >= 0) return k; } return -1; };
  var la = find(["lat", "latitude", "lat_dd", "y", "point_y", "ycoord", "y_coord", "lat_wgs84"]), lo = find(["lon", "lng", "long", "longitude", "lon_dd", "x", "point_x", "xcoord", "x_coord", "lon_wgs84"]);
  if (la < 0 || lo < 0) throw new Error(fname + ": no latitude/longitude columns found (columns: " + hdr.join(", ") + ")");
  return rows.slice(1).map(function (r) {
    var props = {}; hdr.forEach(function (h, i) { if (i !== la && i !== lo && h) props[h] = r[i] === undefined ? "" : String(r[i]).trim(); });
    return {type: "pt", lat: Number(String(r[la]).replace(",", ".")), lon: Number(String(r[lo]).replace(",", ".")), props: props, layer: fname};
  });
}
async function readImportFile(file) {
  var name = file.name || "points", ext = (name.split(".").pop() || "").toLowerCase(), base = name.replace(/\.[^.]+$/, "");
  if (ext === "kmz" || ext === "zip") {
    var z = await JSZip.loadAsync(file), ks = Object.keys(z.files).filter(function (n) { return /\.kml$/i.test(n); });
    if (!ks.length) throw new Error(name + (ext === "zip" ? ": shapefile ZIPs are not supported - export the layer to KML or GeoJSON from QGIS" : ": no KML inside the KMZ"));
    ks.sort(function (a, b) { return (b === "doc.kml") - (a === "doc.kml"); });
    return parseKml(await z.file(ks[0]).async("string"), base);
  }
  var t = await file.text();
  if (ext === "kml" || /<kml[\s>]/i.test(t.slice(0, 3000))) return parseKml(t, base);
  if (ext === "geojson" || ext === "json" || /^\s*[{[]/.test(t)) {
    var j = JSON.parse(t);
    if (j && j.format === "lulc-field-package") return {pkg: j};
    return parseGeoJson(j, base);
  }
  return parseCsv(t, base);
}
function slugify(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "points"; }
function fval(f, field) { if (field === "__layer") return f.layer || ""; var v = f.props[field]; return v === null || v === undefined ? "" : String(v).trim(); }
function detectClasses(pts, field, keys) {
  if (!field || field === "__none") return {numeric: false, map: {}, lines: DEFAULT_CLASSES.map(function (c) { return c.code + " | " + c.name; }).join("\n")};
  var seen = {}, vals = [];
  pts.forEach(function (p) { var v = fval(p, field); if (v !== "" && !seen[v.toLowerCase()]) { seen[v.toLowerCase()] = 1; vals.push(v); } });
  var numeric = vals.length > 0 && vals.every(function (v) { return /^-?\d+(\.0+)?$/.test(v); }), map = {}, lines = [], codeField = null;
  if (numeric) {
    vals.map(function (v) { return parseInt(v, 10); }).sort(function (a, b) { return a - b; }).forEach(function (c) {
      var d = null; DEFAULT_CLASSES.forEach(function (x) { if (x.code === c) d = x; });
      map[String(c)] = c; lines.push(c + " | " + (d ? d.name : "Class " + c));
    });
  } else {
    /* a numeric field that pairs 1:1 with the class names (e.g. Class_code) supplies the codes */
    (keys || []).forEach(function (k) {
      if (codeField || k === field) return;
      var m = {}, rev = {}, ok = true, any = false;
      pts.forEach(function (p) {
        if (!ok) return;
        var v = fval(p, field).toLowerCase(), c = fval(p, k); if (v === "") return;
        if (!/^\d+$/.test(c)) { ok = false; return; }
        if ((m[v] !== undefined && m[v] !== c) || (rev[c] !== undefined && rev[c] !== v)) { ok = false; return; }
        m[v] = c; rev[c] = v; any = true;
      });
      if (ok && any) { codeField = k; vals.forEach(function (v) { map[v.toLowerCase()] = parseInt(m[v.toLowerCase()], 10); }); }
    });
    if (!codeField) {
      var used = {};
      vals.forEach(function (v) { DEFAULT_CLASSES.forEach(function (d) { if (d.name.toLowerCase() === v.toLowerCase()) { map[v.toLowerCase()] = d.code; used[d.code] = 1; } }); });
      var next = 1;
      vals.slice().sort(function (a, b) { return a.toLowerCase() < b.toLowerCase() ? -1 : 1; }).forEach(function (v) { if (map[v.toLowerCase()] !== undefined) return; while (used[next]) next++; map[v.toLowerCase()] = next; used[next] = 1; });
    }
    vals.slice().sort(function (a, b) { return map[a.toLowerCase()] - map[b.toLowerCase()]; }).forEach(function (v) { lines.push(map[v.toLowerCase()] + " | " + v); });
  }
  return {numeric: numeric, map: map, lines: lines.join("\n"), n: vals.length, codeField: codeField};
}
function parseClassLines(txt) {
  var out = [], used = {};
  String(txt || "").split(/\n/).forEach(function (ln) {
    ln = ln.trim(); if (!ln) return;
    var m = ln.match(/^(\d+)\s*[|:=,\t]\s*(.+)$/) || ln.match(/^(\d+)\s+-\s+(.+)$/), code, name;
    if (m) { code = parseInt(m[1], 10); name = m[2].trim(); } else { name = ln; code = null; }
    if (code === null || used[code]) { code = 1; while (used[code]) code++; }
    used[code] = 1; out.push({code: code, name: name});
  });
  return out;
}
function uniqueRatio(pts, field) { var s = {}, n = 0; pts.forEach(function (p) { var v = fval(p, field); if (v !== "") { if (!s[v]) n++; s[v] = 1; } }); return pts.length ? n / pts.length : 0; }
function nUnique(pts, field) { var s = {}, n = 0; pts.forEach(function (p) { var v = fval(p, field); if (v !== "" && !s[v]) { s[v] = 1; n++; } }); return n; }
function pickField(keys, cands, test) {
  for (var i = 0; i < cands.length; i++) for (var k = 0; k < keys.length; k++) if (keys[k].toLowerCase().replace(/[\s-]/g, "_") === cands[i] && (!test || test(keys[k]))) return keys[k];
  return null;
}
async function importFiles(files) {
  var feats = [], names = [];
  try {
    for (var i = 0; i < files.length; i++) {
      var r = await readImportFile(files[i]);
      if (r && r.pkg) return loadPackage(r.pkg);
      feats = feats.concat(r); names.push(files[i].name);
    }
  } catch (e) { return toast("Import failed: " + e.message, true); }
  var pts = feats.filter(function (f) { return f.type === "pt"; }), polys = feats.filter(function (f) { return f.type === "poly"; }), lines = feats.filter(function (f) { return f.type === "line"; });
  var bad = pts.filter(function (p) { return !(isFinite(p.lat) && isFinite(p.lon) && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180); });
  pts = pts.filter(function (p) { return bad.indexOf(p) < 0; });
  if (!pts.length) return toast(bad.length ? "Coordinates are not latitude/longitude. Export the layer in EPSG:4326 (WGS 84) and import again." : "No points found in " + names.join(", ") + (polys.length ? " (only polygons)" : ""), true);
  var keys = [], seenK = {}; pts.forEach(function (p) { Object.keys(p.props).forEach(function (k) { if (!seenK[k]) { seenK[k] = 1; keys.push(k); } }); });
  var layers = {}; pts.forEach(function (p) { layers[p.layer] = (layers[p.layer] || 0) + 1; });
  var layerNames = Object.keys(layers);
  var idF = pickField(keys, ["pid", "point_id", "pointid", "sample_id", "sampleid", "sample_no", "pt_id", "ptid", "vp_id", "id", "name", "fid", "objectid", "sl_no", "slno", "s_no", "sno", "sr_no", "srno", "no"], function (k) { return uniqueRatio(pts, k) >= 0.9; }) || "__auto";
  var clF = pickField(keys, ["class_name", "classname", "lulc_name", "lulc_class", "lulc", "mapped_class", "mapped_cls", "class", "landcover", "land_cover", "lc_class", "lc_name", "cls_name", "cname", "category", "class_code", "classcode", "class_id", "gridcode", "grid_code", "dn", "value", "code"], function (k) { var n = nUnique(pts, k); return n >= 1 && n <= 40; }) || "__none";
  var mlF = pickField(keys, ["ml_id", "ml", "ml_name", "micro_landscape", "microlandscape", "micro_lands", "landscape", "landscape_id", "ml_code"], null) || (layerNames.length > 1 ? "__layer" : "__name");
  var ex = function (k) { for (var i = 0; i < pts.length; i++) { var v = fval(pts[i], k); if (v) return v.length > 18 ? v.slice(0, 18) + "..." : v; } return ""; };
  var opt = function (k, sel) { return '<option value="' + esc(k) + '"' + (k === sel ? " selected" : "") + ">" + esc(k) + (ex(k) ? ' (e.g. "' + esc(ex(k)) + '")' : "") + "</option>"; };
  var defName = names.length ? names[0].replace(/\.[^.]+$/, "") : "Field points";
  if (PKG && PKG.project.source === "imported" && slugify(PKG.project.name) === slugify(defName)) defName = PKG.project.name;
  var det = detectClasses(pts, clF, keys);
  var html = "<h3>Import points</h3>" +
    '<div class="note info">Found <b>' + pts.length + " points</b>" + (polys.length ? " and " + polys.length + " boundary polygon(s)" : "") + (lines.length ? ", " + lines.length + " line(s)" : "") + " in " + esc(names.join(", ")) + "." + (layerNames.length > 1 || layerNames[0] !== defName ? "<br>Layers: " + layerNames.map(function (l) { return esc(l) + " (" + layers[l] + ")"; }).join(", ") : "") + (bad.length ? '<br><b class="badline">' + bad.length + " point(s) skipped: invalid coordinates.</b>" : "") + "</div>" +
    '<label class="f req">Project name (e.g. Micro-landscape name)</label><input type="text" data-f="name" value="' + esc(defName) + '">' +
    '<label class="f">Point ID field (the label you see on the map)</label><select data-f="idf"><option value="__auto"' + (idF === "__auto" ? " selected" : "") + ">(number points automatically)</option>" + keys.map(function (k) { return opt(k, idF); }).join("") + "</select>" +
    '<label class="f">Mapped (classified) LULC class field</label><select data-f="clf" id="impClf"><option value="__none"' + (clF === "__none" ? " selected" : "") + '>(not in the file)</option><option value="__layer"' + (clF === "__layer" ? " selected" : "") + ">(layer / folder name)</option>" + keys.map(function (k) { return opt(k, clF); }).join("") + "</select>" +
    '<label class="f">Micro-landscape field</label><select data-f="mlf"><option value="__name"' + (mlF === "__name" ? " selected" : "") + '>(use the project name)</option><option value="__layer"' + (mlF === "__layer" ? " selected" : "") + ">(layer / folder name)</option>" + keys.map(function (k) { return opt(k, mlF); }).join("") + "</select>" +
    '<label class="f">LULC classes for the form: <i>code | name</i>, one per line. Edit names if needed.</label><textarea data-f="classes" id="impCls" rows="9" style="font-family:monospace;font-size:14px">' + esc(det.lines) + "</textarea>" +
    '<div class="muted" style="font-size:12px" id="impHint">' + (clF === "__none" ? "No class field detected: the standard 9 classes are offered for the observed class." : det.n + " mapped classes detected" + (det.codeField ? ", codes from " + esc(det.codeField) : "") + ".") + "</div>";
  var pr = dlg(html, [{id: "c", label: "Cancel", cls: "sec"}, {id: "ok", label: "Import " + pts.length + " points"}]);
  var cs = $("impClf");
  cs.onchange = function () { det = detectClasses(pts, cs.value, keys); $("impCls").value = det.lines; $("impHint").textContent = cs.value === "__none" ? "No class field: the standard 9 classes are offered for the observed class." : det.n + " mapped classes detected" + (det.codeField ? ", codes from " + det.codeField : "") + (det.n > 25 ? " - this does not look like a class field." : "."); };
  var r2 = await pr;
  if (r2.id !== "ok") return;
  var v = r2.vals, pname = (v.name || "").trim() || defName;
  var classes = parseClassLines(v.classes); if (!classes.length) classes = DEFAULT_CLASSES.map(function (c) { return {code: c.code, name: c.name}; });
  var det2 = detectClasses(pts, v.clf, keys);
  var byName = {}, byCode = {}; classes.forEach(function (c) { byName[c.name.toLowerCase()] = c; byCode[c.code] = c; });
  var points = pts.map(function (f, i) {
    var raw = v.clf === "__none" ? "" : fval(f, v.clf), c = null;
    if (raw !== "") {
      if (det2.numeric) c = byCode[parseInt(raw, 10)] || null;
      else c = byName[raw.toLowerCase()] || byCode[det2.map[raw.toLowerCase()]] || null;
      if (!c) { var nc = det2.numeric ? parseInt(raw, 10) : 1; while (!det2.numeric && byCode[nc]) nc++; c = {code: nc, name: det2.numeric ? "Class " + nc : raw}; classes.push(c); byCode[nc] = c; byName[c.name.toLowerCase()] = c; }
    }
    var ml = v.mlf === "__name" ? pname : (fval(f, v.mlf) || f.layer || pname);
    var id = v.idf === "__auto" ? "" : fval(f, v.idf);
    var attrs = {}; Object.keys(f.props).forEach(function (k) { attrs[k] = String(f.props[k]).slice(0, 300); });
    return {pid: id || ("P" + String(i + 1).padStart(4, "0")), class_code: c ? c.code : null, class_name: c ? c.name : "Not specified", ml_id: ml, ml_name: ml,
      lon: Math.round(f.lon * 1e7) / 1e7, lat: Math.round(f.lat * 1e7) / 1e7, orig_lon: f.lon, orig_lat: f.lat, role: "primary", replaces: null, sample_type: "imported",
      phase: 1, day: null, team: null, route_id: null, seq: i + 1, attrs: attrs};
  });
  /* point IDs must be unique: prefix with the Micro-landscape when IDs repeat across layers, then number duplicates */
  var cnt = {}; points.forEach(function (p) { cnt[p.pid] = (cnt[p.pid] || 0) + 1; });
  var dups = Object.keys(cnt).filter(function (k) { return cnt[k] > 1; }).length, mls0 = {}; points.forEach(function (p) { mls0[p.ml_id] = 1; });
  if (dups && Object.keys(mls0).length > 1) points.forEach(function (p) { p.pid = p.ml_id + "-" + p.pid; });
  var seen2 = {}; points.forEach(function (p) { var b = p.pid, n = 1; while (seen2[p.pid]) { n++; p.pid = b + "-" + n; } seen2[p.pid] = 1; });
  classes.sort(function (a, b) { return a.code - b.code; });
  classes = classes.map(function (c, i) { var st = classStyle(c.code, c.name, i); return {code: c.code, name: c.name, color: st.color, group: st.group}; });
  var mlFeats = polys.map(function (f, i) { var nm = f.props.ml_id || f.props.ML || f.props.name || f.props.Name || (polys.length === 1 ? pname : f.layer + " " + (i + 1)); return {type: "Feature", properties: {ml_id: String(nm), ml_name: String(nm)}, geometry: f.geometry}; });
  var pid = "imp-" + slugify(pname);
  if (PKG && PKG.project.project_id === pid) {
    var rr = await dlg("<h3>Update " + esc(pname) + "?</h3><p>The points of this project are replaced by the imported file. Observations already recorded stay linked by point ID.</p>", [{id: "c", label: "Cancel", cls: "sec"}, {id: "ok", label: "Update points"}]);
    if (rr.id !== "ok") return;
  }
  var pkg = {format: "lulc-field-package", version: 1, package_id: uuid(), created: nowIso(),
    project: {project_id: pid, name: pname, demo: false, locked: true, source: "imported", source_files: names, routing_engine: "None (points imported from file)", approximate_routes: false},
    classes: classes, staging: null, end_location: null,
    mls: {type: "FeatureCollection", features: mlFeats}, roads: {type: "FeatureCollection", features: []},
    refs: {type: "FeatureCollection", features: lines.map(function (f) { return {type: "Feature", properties: {name: f.props.name || f.layer}, geometry: f.geometry}; })},
    points: points, routes: [],
    settings: {gps_accuracy_warn_m: 10, distance_warn_m: 30, min_photos: 1, surveyors: SET.surveyor ? [SET.surveyor] : []}};
  await loadPackage(pkg);
  if (dups) toast("Some point IDs repeated; duplicates were renamed (e.g. " + points.filter(function (p) { return /-\d+$/.test(p.pid) || p.pid.indexOf(p.ml_id + "-") === 0; }).slice(0, 2).map(function (p) { return p.pid; }).join(", ") + ")", true);
}

/* ================================================================ settings */
async function loadPackage(pk) {
  if (!pk || pk.format !== "lulc-field-package") return toast("Not a field package (lulc-field-package)", true);
  if (PKG && PKG.project.project_id !== pk.project.project_id) {
    var u = unsaved() + (await unsavedPhotos());
    if (u > 0) return dlg("<h3>Export first</h3><p>The phone holds " + u + " unexported records of project " + esc(PKG.project.name) + ". Export them (More &gt; Data export) before loading another project.</p>", [{id: "ok", label: "OK"}]);
    var r = await dlg("<h3>Switch project?</h3><p>Load " + esc(pk.project.name) + " instead of " + esc(PKG.project.name) + "? Stored observations stay on the phone.</p>", [{id: "c", label: "Cancel", cls: "sec"}, {id: "ok", label: "Load"}]);
    if (r.id !== "ok") return;
  }
  if (!pk.project.locked) toast("Warning: this package was created from an UNLOCKED sample", true);
  PKG = pk; await metaSet("package", pk);
  if (FMAP) { FMAP.remove(); FMAP = null; FL = {}; }
  await loadObs(); updateChips();
  applyPkgHeader(); toast(pk.project.source === "imported" ? "Imported " + pk.points.length + " points into " + pk.project.name : "Field package loaded: " + pk.points.length + " points, " + pk.routes.length + " routes");
  show(pk.project.source === "imported" ? "map" : "dash");
}
async function vSettings() {
  var est = null; try { est = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null; } catch (e) { est = null; }
  var pers = null; try { pers = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : null; } catch (e) { pers = null; }
  var teams = ["all"]; if (PKG) PKG.routes.forEach(function (r) { if (teams.indexOf(String(r.team)) < 0) teams.push(String(r.team)); });
  var html = "<h2>Settings</h2>";
  html += '<div class="card"><b>Field package</b><div class="kv" style="margin-top:6px">' + (PKG ? "<div>Project</div><div>" + esc(PKG.project.name) + (PKG.project.demo ? ' <span class="badge warn">DEMO</span>' : "") + "</div><div>Points / routes</div><div>" + PKG.points.length + " / " + PKG.routes.length + "</div><div>Created</div><div>" + esc(PKG.created) + "</div><div>Sample</div><div>" + (PKG.project.locked ? "locked, seed " + esc(PKG.project.seed) + ", hash " + esc((PKG.project.sample_hash || "").slice(0, 10)) : '<span class="badge bad">not locked</span>') + "</div><div>Routing</div><div>" + esc(PKG.project.routing_engine || "-") + "</div>" : "<div>Status</div><div>No package loaded</div>") + "</div>" +
    '<label class="btn block">Import points (KML / KMZ / GeoJSON / CSV)<input type="file" multiple id="impFile" style="display:none"></label>' +
    '<div class="muted" style="font-size:12.5px;line-height:1.4">Google My Maps: layer menu &gt; Export data &gt; KML/KMZ (or map menu &gt; Export to KML/KMZ). QGIS: Export &gt; Save Features As &gt; KML or GeoJSON, CRS EPSG:4326. CSV needs latitude/longitude columns. Boundary polygons in the file are shown as Micro-landscape outlines.</div>' +
    '<label class="btn sec block">Load planner field package (.json)<input type="file" accept=".json,application/json" id="pkgFile" style="display:none"></label>' + (!PKG ? '<button class="btn warn block" id="btnDemo">Try with DEMO package (synthetic data)</button>' : "") + "</div>";
  html += '<div class="card"><b>Survey</b><label class="f">Surveyor name</label><input type="text" id="sSurv" value="' + esc(SET.surveyor || "") + '">' + (hasRoutes() ? '<label class="f">My team (filters Day 1 / Day 2 routes)</label><select id="sTeam">' + teams.map(function (t) { return '<option value="' + t + '"' + (String(SET.team) === t ? " selected" : "") + ">" + (t === "all" ? "All teams" : "Team " + t) + "</option>"; }).join("") + "</select>" : "") + '<label class="f">GPS capture time (seconds)</label><input type="number" id="sGps" value="' + esc(SET.gps_seconds || 25) + '"><label style="display:block;margin-top:10px"><input type="checkbox" id="sAuto2"' + (SET.auto_gps !== false ? " checked" : "") + '> Capture GPS automatically when I open a point</label><label style="display:block;margin-top:10px"><input type="checkbox" id="sAll"' + (SET.show_all_sections ? " checked" : "") + "> Always show all form sections</label></div>";
  html += '<div class="card"><b>Photos</b><label class="f">Geotagging</label><select id="sPhoto">' + [["stamp2048", "GPS in EXIF + visible stamp, 2048 px (recommended)"], ["stamp_full", "GPS in EXIF + visible stamp, full size (max 4096 px)"], ["orig", "Original photo, GPS written into EXIF only"]].map(function (o) { return '<option value="' + o[0] + '"' + (SET.photo_mode === o[0] ? " selected" : "") + ">" + o[1] + "</option>"; }).join("") + '</select><div class="muted" style="font-size:12.5px;margin-top:6px">iPhone and Android browsers remove the location from photos taken in a web app, so the app writes your GPS position, accuracy, time and point ID into each photo itself. 2048 px keeps photos around 0.5-1 MB.</div></div>';
  html += '<div class="card"><b>Optional live sync</b><label class="f">Sync URL (HTTPS address of the planner)</label><input type="text" id="sUrl" placeholder="https://xxxx.trycloudflare.com" value="' + esc(SET.sync_url || "") + '"><label class="f">Sync token (from planner Stage 9)</label><input type="text" id="sTok" value="' + esc(SET.sync_token || "") + '"><label style="display:block;margin-top:10px"><input type="checkbox" id="sAuto"' + (SET.auto_sync ? " checked" : "") + '> Sync automatically when online</label><button class="btn sec block" id="btnTest">Test connection</button></div>';
  html += '<div class="card"><b>Device</b><div class="kv" style="margin-top:6px"><div>Device ID</div><div>' + esc(DEVICE) + "</div><div>App version</div><div>" + APP_VERSION + "</div><div>Storage used</div><div>" + (est ? (est.usage / 1048576).toFixed(1) + " MB of " + (est.quota / 1048576).toFixed(0) + " MB" : "unknown") + "</div><div>Persistent storage</div><div>" + (pers === true ? '<span class="badge ok">granted</span>' : pers === false ? '<span class="badge warn">not granted</span>' : "unknown") + "</div><div>Secure (HTTPS)</div><div>" + (window.isSecureContext ? "yes" : '<span class="badge bad">no - GPS blocked</span>') + "</div></div>" +
    '<button class="btn sec block" id="btnPersist">Request persistent storage</button>' + (INSTALL ? '<button class="btn sec block" id="btnInst">Install app</button>' : '<p class="muted" style="font-size:13px">Install: Android Chrome menu &gt; Add to Home screen / Install app. iPhone Safari: Share &gt; Add to Home Screen.</p>') + "</div>";
  html += '<div class="card"><b>Reset</b><p class="muted" style="font-size:13px">Deletes all observations, photos and the package from this phone.</p><button class="btn bad block" id="btnReset">Reset survey data...</button></div>';
  H(html);
  $("pkgFile").onchange = async function () { var f = this.files[0]; if (!f) return; try { await loadPackage(JSON.parse(await f.text())); } catch (e) { toast("Could not read package: " + e.message, true); } };
  if ($("btnDemo")) $("btnDemo").onclick = async function () { try { var r = await fetch("demo_field_package.json"); await loadPackage(await r.json()); } catch (e) { toast("Demo package not available: " + e.message, true); } };
  $("impFile").onchange = async function () { var fs = Array.prototype.slice.call(this.files || []); this.value = ""; if (fs.length) await importFiles(fs); };
  $("sSurv").onchange = function () { SET.surveyor = this.value.trim(); saveSettings(); };
  if ($("sTeam")) $("sTeam").onchange = function () { SET.team = this.value; saveSettings(); };
  $("sAuto2").onchange = function () { SET.auto_gps = this.checked; saveSettings(); };
  $("sPhoto").onchange = function () { SET.photo_mode = this.value; saveSettings(); };
  $("sGps").onchange = function () { SET.gps_seconds = Math.max(5, Math.min(120, Number(this.value) || 25)); saveSettings(); };
  $("sAll").onchange = function () { SET.show_all_sections = this.checked; saveSettings(); };
  $("sUrl").onchange = function () { SET.sync_url = this.value.trim(); saveSettings(); };
  $("sTok").onchange = function () { SET.sync_token = this.value.trim(); saveSettings(); };
  $("sAuto").onchange = function () { SET.auto_sync = this.checked; saveSettings(); };
  $("btnTest").onclick = async function () {
    var b = syncBase(); if (!b) return toast("Enter the sync URL", true);
    try { var r = await fetch(b + "/api/sync/ping", {headers: {"X-Sync-Token": SET.sync_token || ""}}); var js = await r.json(); if (!r.ok) throw new Error((js.detail || {}).message || r.status); toast("Connected to " + js.project + (PKG && js.project_id !== PKG.project.project_id ? " - WARNING: different project" : "")); } catch (e) { toast("Connection failed: " + e.message, true); }
  };
  $("btnPersist").onclick = async function () { try { var ok = await navigator.storage.persist(); toast(ok ? "Persistent storage granted" : "The browser refused; install the app to the home screen and try again", !ok); vSettings(); } catch (e) { toast(e.message, true); } };
  if ($("btnInst")) $("btnInst").onclick = function () { INSTALL.prompt(); INSTALL = null; };
  $("btnReset").onclick = async function () {
    var u = unsaved() + (await unsavedPhotos()), word = u ? "DELETE UNSAVED DATA" : "DELETE";
    var r = await dlg("<h3>Reset survey data</h3>" + (u ? '<div class="note bad"><b>' + u + " records have NOT been exported or synced and would be lost.</b> Export them first.</div>" : "") + "<p>Type <b>" + word + "</b> to confirm.</p><input type=\"text\" data-f=\"w\">", [{id: "c", label: "Cancel", cls: "sec"}, {id: "ok", label: "Reset", cls: "bad"}]);
    if (r.id !== "ok" || r.vals.w !== word) return toast("Reset cancelled");
    for (var s of ["obs", "photos", "drafts"]) await idb(s, "readwrite", function (st) { return st.clear(); });
    await metaSet("package", null); await metaSet("export_log", []);
    PKG = null; await loadObs(); if (FMAP) { FMAP.remove(); FMAP = null; } applyPkgHeader(); updateChips(); toast("Survey data reset"); show("settings");
  };
}

document.addEventListener("DOMContentLoaded", boot);
