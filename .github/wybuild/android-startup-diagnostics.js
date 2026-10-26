/* Runs before app modules so errors during module download/evaluation are visible in Android WebView. */
(function () {
  'use strict';
  if (window.__WYBUILD_STARTUP_DIAGNOSTICS__) return;
  // The bundle has no backend. If the WebView ever lands on /api/... (a link written for the live site), go back to the app root
  // before the app modules load. '/' never matches, so this cannot loop and needs no once-per-session flag.
  try { if (/^\/api(\/|$)/.test(location.pathname || '/')) { location.replace('/'); return; } } catch (_) {}
  window.__WYBUILD_STARTUP_DIAGNOSTICS__ = true;
  var startedAt = Date.now();
  var entries = [];
  var panelId = 'wybuild-android-startup-diagnostic';
  function describe(value) {
    try { return String(value && (value.stack || value.message) || value); }
    catch (_) { return 'Unknown startup error'; }
  }
  function redact(value) { return String(value || '').replace(/https?:\/\/[^\s?#]+[^\s]*/g, function (u) { try { var x = new URL(u); return x.origin + x.pathname; } catch (_) { return '[url]'; } }).replace(/(authorization|access_token|token|code|verifier|secret|password)[=:][^&\s]+/ig, '$1=[redacted]'); }
  function record(kind, detail) {
    var entry = { time: new Date().toISOString(), kind: kind, detail: redact(detail) };
    entries.push(entry);
    if (entries.length > 30) entries.shift();
    try { localStorage.setItem('wybuild.android.startupDiagnostics', JSON.stringify(entries)); } catch (_) {}
    try { console.error('[WyBuild Android startup]', kind, detail); } catch (_) {}
  }
  function show(reason) {
    if (!document.body || document.getElementById(panelId)) return;
    var old = document.getElementById(panelId); if (old) old.remove();
    var panel = document.createElement('main'); panel.id = panelId;
    panel.style.cssText = 'position:fixed;inset:0;z-index:2147483647;overflow:auto;box-sizing:border-box;padding:24px;background:#020617;color:#e2e8f0;font:14px system-ui,sans-serif';
    var card = document.createElement('section'); card.style.cssText = 'max-width:620px;margin:4vh auto;padding:22px;border:1px solid #475569;border-radius:16px;background:#0f172a';
    var title = document.createElement('h1'); title.textContent = 'WyBuild could not start'; title.style.cssText = 'font-size:22px;margin:0 0 12px';
    var intro = document.createElement('p'); intro.textContent = 'Android detected that the app interface did not finish loading. This diagnostic is local to the app and does not clear your data.'; intro.style.cssText = 'line-height:1.5;color:#cbd5e1';
    var details = document.createElement('pre'); details.textContent = String(reason || 'No visible app content was detected.') + '\n\nPage: ' + location.origin + location.pathname + '\nElapsed: ' + (Date.now() - startedAt) + ' ms\nUser agent: ' + navigator.userAgent + '\n\nRecent errors:\n' + entries.map(function (e) { return e.time + ' [' + e.kind + '] ' + e.detail; }).join('\n');
    details.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;max-height:42vh;overflow:auto;padding:12px;border-radius:8px;background:#020617;color:#fca5a5;font-size:11px';
    var row = document.createElement('div'); row.style.cssText = 'display:flex;flex-wrap:wrap;gap:10px;margin-top:14px';
    function button(label, action, bg) { var b = document.createElement('button'); b.textContent = label; b.onclick = action; b.style.cssText = 'padding:11px 14px;border:0;border-radius:9px;background:' + bg + ';color:#fff;font-weight:700'; return b; }
    row.appendChild(button('Copy diagnostics', function () { var text = details.textContent || ''; if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).catch(function () {}); try { var ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); } catch (_) {} }, '#4f46e5'));
    row.appendChild(button('Reload app', function () { location.reload(); }, '#047857'));
    card.append(title, intro, details, row); panel.appendChild(card); document.body.appendChild(panel);
  }
  window.addEventListener('error', function (event) {
    if (event.target && event.target !== window) {
      var target = event.target;
      var url = target.src || target.href || target.tagName || 'unknown resource';
      record('resource-load-failed', url);
      // Recovery: assets are served from the bundle root. If we are on some other path (a link to the live site's /api/...
      // opened inside the WebView), go back to the app root once instead of showing a blank screen.
      try {
        var path = location.pathname || '/';
        if (path !== '/' && path !== '/index.html' && !sessionStorage.getItem('wybuild.startup.recovered')) {
          sessionStorage.setItem('wybuild.startup.recovered', '1');
          record('startup-recovery', 'Returning to app root from ' + path);
          location.replace('/');
        }
      } catch (_) {}
      return;
    }
    var detail = (event.message || 'JavaScript error') + (event.filename ? ' at ' + event.filename + ':' + event.lineno + ':' + event.colno : '');
    record('javascript-error', detail);
    window.setTimeout(function () { show(detail); }, 0);
  }, true);
  window.addEventListener('unhandledrejection', function (event) {
    var detail = describe(event.reason);
    if (/failed to fetch|network request failed|load failed|networkerror|could not reach|server.*unreachable/i.test(detail)) { record('backend-unreachable', detail); return; }
    record('unhandled-rejection', detail); window.setTimeout(function () { show(detail); }, 0);
  });
  window.addEventListener('securitypolicyviolation', function (event) { record('csp-violation', event.violatedDirective + ' ' + event.blockedURI); });
  document.addEventListener('DOMContentLoaded', function () {
    window.setTimeout(function () {
      var root = document.getElementById('root');
      var hasText = !!(root && (root.innerText || root.textContent || '').trim().length > 0);
      var hasVisibleControl = false;
      if (root) Array.prototype.some.call(root.querySelectorAll('button,a,input,textarea,select,img,svg,canvas,[role=button]'), function (el) {
        var rect = el.getBoundingClientRect(); var style = window.getComputedStyle(el);
        if (rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0) { hasVisibleControl = true; return true; }
        return false;
      });
      if (!root || (!hasText && !hasVisibleControl)) { record('startup-timeout', 'No visible app content after 15000 ms'); show('No visible app content appeared after 15000 ms. This usually indicates a module load/evaluation failure or startup code that never rendered.'); }
    }, 15000);
  });
  record('diagnostics-installed', 'Early Android startup diagnostics installed before application modules');
})();
