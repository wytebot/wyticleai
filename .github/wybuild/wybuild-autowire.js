/* WyBuild auto-wire layer (workflow v49).
 * Appended to the generated native bridge bundle by the workflow. It runs AFTER window.WyBuildNative exists.
 *
 * Purpose: a native feature ticked in WyBuild must take effect in the APK even when the website's own code
 * has never heard of WyBuildNative. Each shim below maps a STANDARD web API onto the native plugin, and is
 * installed ONLY when the matching feature was selected (runtime config `nativeFeatures`).
 *
 * Rules: never throw during startup, never replace behaviour that already works, always fall back to the
 * original browser behaviour when the native call fails, and apply only inside the native app.
 */
(function wybuildAutowire() {
  'use strict';
  var applied = [];
  var skipped = [];
  var active = false;
  try {
    var cfg = window.__WYBUILD_RUNTIME_CONFIG__ || {};
    var picked = new Set(Array.isArray(cfg.nativeFeatures) ? cfg.nativeFeatures : []);
    var N = window.WyBuildNative;
    if (window.__WYBUILD_DISABLE_AUTOWIRE__ || !N || typeof N.isNative !== 'function' || !N.isNative()) return;
    active = true;
    var has = function () { for (var i = 0; i < arguments.length; i++) if (picked.has(arguments[i])) return true; return false; };
    var guard = function (name, fn) {
      try { fn(); applied.push(name); }
      catch (e) { skipped.push(name); try { console.warn('[WyBuild] auto-wire "' + name + '" skipped:', e && e.message ? e.message : e); } catch (_) {} }
    };
    var define = function (proto, key, value) { Object.defineProperty(proto, key, { configurable: true, writable: true, value: value }); };
    var failed = function (r) { return !!r && r.ok === false; };
    var isCancel = function (r) { return /cancel|dismiss|abort/i.test(String((r && r.error) || '')); };
    var safeName = function (n, fallback) { return String(n || fallback || 'download').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '').slice(0, 120) || 'download'; };
    var toBase64 = function (blob) {
      return new Promise(function (resolve, reject) {
        var r = new FileReader();
        r.onerror = function () { reject(r.error || new Error('read failed')); };
        r.onload = function () { var s = String(r.result || ''); resolve(s.slice(s.indexOf(',') + 1)); };
        r.readAsDataURL(blob);
      });
    };
    var saveBlob = function (blob, name) {
      return toBase64(blob).then(function (b64) { return N.files.write('wybuild-saved/' + name, b64); }).then(function (saved) {
        if (failed(saved)) throw new Error(saved.error);
        var uri = saved && (saved.uri || saved.path);
        return uri ? N.share(name, '', uri) : saved;
      });
    };

    // ---- Web Share API -> Android share sheet (feature: shareout) -------------------------------------------
    if (has('shareout')) guard('shareout', function () {
      define(Navigator.prototype, 'canShare', function (data) {
        if (!data) return false;
        return !!(data.title || data.text || data.url || (data.files && data.files.length));
      });
      define(Navigator.prototype, 'share', function (data) {
        data = data || {};
        var done = function (r) {
          if (failed(r)) { if (isCancel(r)) throw new DOMException('Share canceled', 'AbortError'); throw new Error(r.error || 'Share failed'); }
        };
        var file = data.files && data.files[0];
        if (file) {
          return saveBlob(file, safeName(file.name, 'shared-file')).then(done);
        }
        if (!data.title && !data.text && !data.url) return Promise.reject(new TypeError('Nothing to share'));
        return Promise.resolve(N.share(data.title || '', data.text || '', data.url || '')).then(done);
      });
    });

    // ---- Downloads: <a download>, blob:/data: links, programmatic a.click() -> save + Android share/save sheet --
    if (has('downloads', 'fileaccess')) guard('downloads', function () {
      var handling = new WeakSet();
      var looksDownloadable = function (a) {
        if (!a || !a.getAttribute) return false;
        var href = a.getAttribute('href') || '';
        return a.hasAttribute('download') || /^(blob|data):/i.test(href);
      };
      var nameFor = function (a, url) {
        var given = a.getAttribute('download');
        if (given) return safeName(given);
        try { var p = new URL(url, location.href).pathname.split('/').pop(); if (p) return safeName(decodeURIComponent(p)); } catch (_) {}
        return /^data:/i.test(url) ? 'download' : 'download';
      };
      var run = function (a) {
        var url = a.href;
        var name = nameFor(a, url);
        var sameOrigin = /^(blob|data):/i.test(url) || new URL(url, location.href).origin === location.origin;
        var job = sameOrigin
          ? fetch(url).then(function (r) { return r.blob(); }).then(function (b) { return saveBlob(b, name); })
          : Promise.resolve(N.files.download(url, name, { shareAfterSave: true }));
        return job.then(function (r) { if (failed(r)) throw new Error(r.error); });
      };
      var intercept = function (a, event) {
        if (!looksDownloadable(a) || handling.has(a)) return false;
        if (event) { event.preventDefault(); event.stopImmediatePropagation(); }
        handling.add(a);
        run(a).catch(function (e) {
          try { console.warn('[WyBuild] native download failed, opening externally:', e && e.message ? e.message : e); } catch (_) {}
          if (/^https?:/i.test(a.href)) N.openExternal(a.href);
        }).then(function () { handling.delete(a); });
        return true;
      };
      document.addEventListener('click', function (event) {
        var a = event.target && event.target.closest ? event.target.closest('a') : null;
        if (a) intercept(a, event);
      }, true);
      // Sites usually build a detached <a download>, then call .click(); that never reaches document listeners.
      var origClick = HTMLAnchorElement.prototype.click;
      define(HTMLAnchorElement.prototype, 'click', function () {
        if (!intercept(this, null)) return origClick.apply(this, arguments);
      });
    });

    // ---- Notification API -> Android local notifications (features: localnotifications, reminders) -----------
    if (has('localnotifications', 'reminders')) guard('notifications', function () {
      var KEY = 'wybuild:notification-permission';
      var perm = 'default';
      try { perm = localStorage.getItem(KEY) || 'default'; } catch (_) {}
      var setPerm = function (p) { perm = p; try { localStorage.setItem(KEY, p); } catch (_) {} };
      var seq = 0;
      var nextId = function () { seq = (seq + 1) % 1000; return ((Date.now() % 2000000) * 1000) + seq; };
      var Shim = function Notification(title, options) {
        if (!(this instanceof Shim)) throw new TypeError("Failed to construct 'Notification': Please use the 'new' operator.");
        options = options || {};
        var self = this;
        this.title = String(title);
        this.body = String(options.body || '');
        this.tag = options.tag || '';
        this.data = options.data;
        this.onshow = this.onclick = this.onclose = this.onerror = null;
        this._id = nextId();
        if (perm !== 'granted') { setTimeout(function () { if (typeof self.onerror === 'function') self.onerror(new Event('error')); }, 0); return; }
        Promise.resolve(N.notifications.schedule(this.title, this.body, this._id, new Date(Date.now() + 800))).then(function (r) {
          var ev = new Event(failed(r) ? 'error' : 'show');
          var h = failed(r) ? self.onerror : self.onshow;
          if (typeof h === 'function') h.call(self, ev);
        });
      };
      Shim.prototype.close = function () { try { N.notifications.cancel([this._id]); } catch (_) {} };
      Shim.prototype.addEventListener = function () {};
      Shim.prototype.removeEventListener = function () {};
      Shim.requestPermission = function (cb) {
        return Promise.resolve(N.notifications.permissions()).then(function (r) {
          var d = r && (r.display || r.receive);
          setPerm(d === 'granted' ? 'granted' : d === 'denied' ? 'denied' : 'default');
          if (typeof cb === 'function') cb(perm);
          return perm;
        });
      };
      Object.defineProperty(Shim, 'permission', { configurable: true, get: function () { return perm; } });
      Shim.maxActions = 0;
      window.Notification = Shim;
      if (window.ServiceWorkerRegistration && ServiceWorkerRegistration.prototype) {
        define(ServiceWorkerRegistration.prototype, 'showNotification', function (title, options) {
          options = options || {};
          if (perm !== 'granted') return Promise.reject(new TypeError('Notification permission has not been granted'));
          return Promise.resolve(N.notifications.schedule(String(title), String(options.body || ''), nextId(), new Date(Date.now() + 800))).then(function (r) { if (failed(r)) throw new Error(r.error); });
        });
      }
    });

    // ---- navigator.vibrate -> Android haptics (feature: haptics) -------------------------------------------
    if (has('haptics')) guard('haptics', function () {
      define(Navigator.prototype, 'vibrate', function (pattern) {
        var list = [].concat(pattern == null ? [] : pattern).map(function (n) { return Number(n) || 0; });
        var total = list.filter(function (_, i) { return i % 2 === 0; }).reduce(function (a, b) { return a + b; }, 0);
        if (!list.length || total <= 0) return true; // vibrate(0) / [] cancels; nothing to cancel natively
        if (total <= 30) N.haptics.impact('light'); else N.haptics.vibrate(Math.min(total, 1000));
        return true;
      });
    });

    // ---- navigator.onLine + online/offline events from validated Android connectivity (feature: networkstatus) --
    if (has('networkstatus')) guard('networkstatus', function () {
      var online = navigator.onLine !== false;
      Object.defineProperty(Navigator.prototype, 'onLine', { configurable: true, get: function () { return online; } });
      var set = function (next) {
        next = !!next;
        if (next === online) return;
        online = next;
        window.dispatchEvent(new Event(next ? 'online' : 'offline'));
      };
      Promise.resolve(N.network.status()).then(function (s) { if (s && typeof s.connected === 'boolean') set(s.connected); });
      N.network.watch(function (s) { if (s && typeof s.connected === 'boolean') set(s.connected); });
    });

    // ---- navigator.getBattery() (feature: deviceinfo) ---------------------------------------------------------
    if (has('deviceinfo')) guard('deviceinfo', function () {
      var mgr = new EventTarget();
      mgr.level = 1; mgr.charging = false; mgr.chargingTime = Infinity; mgr.dischargingTime = Infinity;
      var refresh = function () {
        return Promise.resolve(N.device.battery()).then(function (b) {
          if (!b || failed(b)) return;
          if (typeof b.batteryLevel === 'number') mgr.level = b.batteryLevel;
          if (typeof b.isCharging === 'boolean') mgr.charging = b.isCharging;
          mgr.dispatchEvent(new Event('levelchange'));
        });
      };
      var ready = refresh();
      document.addEventListener('visibilitychange', function () { if (!document.hidden) refresh(); });
      define(Navigator.prototype, 'getBattery', function () { return ready.then(function () { return mgr; }); });
    });

    // ---- Android App Links / deep links open the matching page inside the app (feature: deeplinks) -------------
    if (has('deeplinks')) guard('deeplinks', function () {
      var appHost = ''; try { appHost = new URL(cfg.webFallbackUrl || '').host; } catch (_) {}
      if (!appHost) throw new Error('no web address configured for deep links');
      var route = function (raw) {
        var u; try { u = new URL(String(raw)); } catch (_) { return; }
        if (u.protocol !== 'https:' || u.host !== appHost) return;
        var key = 'wybuild:deeplink:' + u.href;
        try { if (sessionStorage.getItem(key)) return; sessionStorage.setItem(key, '1'); } catch (_) {}
        var target = u.pathname + u.search + u.hash;
        if (target !== location.pathname + location.search + location.hash) location.assign(target);
      };
      window.addEventListener('wybuild-native-url-open', function (e) { route(e && e.detail && e.detail.url); });
      (window.__WYBUILD_PENDING_APP_URLS__ || []).forEach(route);
      Promise.resolve(N.deepLinks.getLaunchUrl()).then(function (u) { if (u) route(u); });
    });

    // ---- Edge swipe back with default history navigation (feature: swipeback) ------------------------------
    if (has('swipeback')) guard('swipeback', function () { N.swipeBack.enable(); });
  } catch (e) {
    try { console.warn('[WyBuild] auto-wire failed safely:', e && e.message ? e.message : e); } catch (_) {}
  } finally {
    if (active) try {
      window.__WYBUILD_AUTOWIRED__ = Object.freeze({ applied: applied.slice(), skipped: skipped.slice() });
      if (applied.length) console.log('[WyBuild] auto-enabled native features for existing site code: ' + applied.join(', '));
      window.dispatchEvent(new CustomEvent('wybuild-autowire-ready', { detail: { applied: applied.slice(), skipped: skipped.slice() } }));
    } catch (_) { /* diagnostics only */ }
  }
})();
