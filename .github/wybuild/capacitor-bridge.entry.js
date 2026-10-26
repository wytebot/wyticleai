/* WyBuild Capacitor bridge. Bundled into the website build only for Capacitor builds. */
import { Camera } from '@capacitor/camera';
import { Clipboard } from '@capacitor/clipboard';
import { Device } from '@capacitor/device';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Geolocation } from '@capacitor/geolocation';
import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics';
import { LocalNotifications } from '@capacitor/local-notifications';
import { Network } from '@capacitor/network';
import { App } from '@capacitor/app';
import { Share } from '@capacitor/share';
import { Browser } from '@capacitor/browser';
import { StatusBar, Style } from '@capacitor/status-bar';
import { ScreenOrientation } from '@capacitor/screen-orientation';
import { Preferences } from '@capacitor/preferences';
import { Keyboard } from '@capacitor/keyboard';
import { PushNotifications } from '@capacitor/push-notifications';
import { FirebaseAuthentication } from '@capacitor-firebase/authentication';
import { BiometricAuth } from '@aparajita/capacitor-biometric-auth';
import { ActionSheet } from '@capacitor/action-sheet';
import { Dialog } from '@capacitor/dialog';
import { registerPlugin } from '@capacitor/core';
const WyBuildContactsPlugin = registerPlugin('WyBuildContacts');

const safe = async (fn) => { try { return await fn(); } catch (e) { return { ok: false, error: String(e?.message || e) }; } };
const pendingNativeUrls = (window.__WYBUILD_PENDING_APP_URLS__ = window.__WYBUILD_PENDING_APP_URLS__ || []);
const emitNativeUrl = (raw) => {
  const url = String(raw || ''); if (!url) return;
  pendingNativeUrls.push(url); if (pendingNativeUrls.length > 10) pendingNativeUrls.shift();
  window.dispatchEvent(new CustomEvent('wybuild-native-url-open', { detail: { url } }));
  try {
    const parsed = new URL(url);
    if (parsed.hostname === 'auth') window.dispatchEvent(new CustomEvent('wybuild-native-auth', { detail: { code: parsed.searchParams.get('code') || '', status: parsed.searchParams.get('status') || '', url } }));
    if (parsed.hostname === 'billing') window.dispatchEvent(new CustomEvent('wybuild-native-billing', { detail: { status: parsed.searchParams.get('status') || '', ref: parsed.searchParams.get('ref') || '', url } }));
  } catch { /* malformed app URLs are ignored */ }
};
try { App.addListener('appUrlOpen', event => emitNativeUrl(event?.url)); } catch { /* cold-start URL is also read via App.getLaunchUrl */ }

// Native survival runtime: only rewrite configured API prefixes; never rewrite normal site navigation.
const runtimeConfig = (() => { try { return window.__WYBUILD_RUNTIME_CONFIG__ || {}; } catch { return {}; } })();
const nativeApiBase = String(runtimeConfig.apiBaseUrl || '').replace(/\/$/, '');
const nativeApiPrefixes = Array.isArray(runtimeConfig.apiPrefixes) && runtimeConfig.apiPrefixes.length ? runtimeConfig.apiPrefixes : ['/api'];
const nativeAuthMode = String(runtimeConfig.authMode || 'none');
const rewriteNativeApi = (raw) => {
  try {
    const value = typeof raw === 'string' ? raw : raw?.url;
    if (!value || !nativeApiBase) return raw;
    const u = new URL(value, location.href);
    if (u.origin === location.origin && nativeApiPrefixes.some(prefix => u.pathname === prefix || u.pathname.startsWith(prefix.replace(/\/$/, '') + '/'))) {
      return new URL(u.pathname + u.search + u.hash, nativeApiBase).href;
    }
    return raw;
  } catch { return raw; }
};
const nativeToken = async () => { if (!['bearer-handoff','custom-tab'].includes(nativeAuthMode)) return ''; try { return (await Preferences.get({ key: 'wybuild:nativeAccessToken' })).value || ''; } catch { return ''; } };
try {
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const rewritten = rewriteNativeApi(input);
    const isApi = typeof rewritten === 'string' && (typeof input !== 'string' || rewritten !== input);
    // Preserve Request method, body, signal, cache and other options when rewriting a Request object.
    // Passing only its URL to fetch() would silently turn POST/PUT requests into GET requests.
    let requestInput = rewritten;
    if (input instanceof Request && typeof rewritten === 'string') requestInput = new Request(rewritten, input);
    let nextInit = init;
    if (isApi && ['bearer-handoff','custom-tab'].includes(nativeAuthMode)) {
      const token = await nativeToken();
      if (token) { const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined)); headers.set('Authorization', `Bearer ${token}`); nextInit = { ...init, headers }; }
    }
    try { return await originalFetch(requestInput, nextInit); }
    catch (e) { if (isApi && window.Capacitor?.isNativePlatform?.()) showBackendUnavailable(); throw e; }
  };
  const xhrOpen = XMLHttpRequest.prototype.open; const xhrSend = XMLHttpRequest.prototype.send; const xhrHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) { const rewritten = rewriteNativeApi(String(url)); this.__wyNativeApi = rewritten !== url; return xhrOpen.call(this, method, rewritten, ...rest); };
  XMLHttpRequest.prototype.send = function(...args) { const xhr = this; if (!xhr.__wyNativeApi || !['bearer-handoff','custom-tab'].includes(nativeAuthMode)) return xhrSend.apply(xhr, args); nativeToken().then(token => { if (token) { try { xhrHeader.call(xhr, 'Authorization', `Bearer ${token}`); } catch {} } xhrSend.apply(xhr, args); }).catch(() => xhrSend.apply(xhr, args)); };
} catch { /* network wrappers must never prevent app startup */ }
let backendPanelShown = false;
function showBackendUnavailable() {
  if (backendPanelShown || !document.body) return; backendPanelShown = true;
  const panel = document.createElement('section'); panel.id = 'wybuild-backend-unreachable';
  panel.style.cssText = 'position:fixed;inset:0;z-index:2147483646;background:#020617;color:#e2e8f0;display:flex;align-items:center;justify-content:center;padding:24px;font:14px system-ui';
  const card = document.createElement('div'); card.style.cssText='max-width:420px;width:100%;border:1px solid #334155;border-radius:16px;padding:24px;background:#0f172a';
  const title=document.createElement('h1'); title.textContent='Can’t reach the app server'; title.style.cssText='font-size:22px;font-weight:700;margin:0 0 10px';
  const desc=document.createElement('p'); desc.textContent='The app interface is installed, but its backend is not responding. Check your connection or open the web version.'; desc.style.cssText='line-height:1.5;color:#cbd5e1';
  const retry=document.createElement('button'); retry.textContent='Retry'; retry.style.cssText='margin-top:16px;width:100%;padding:12px;border-radius:8px;background:#34d399;color:#022c22;font-weight:700'; retry.onclick=()=>location.reload();
  const web=document.createElement('button'); web.textContent='Open web version'; web.style.cssText='margin-top:8px;width:100%;padding:12px;border:1px solid #334155;border-radius:8px;color:#e2e8f0'; web.onclick=()=>Browser.open({url:String(runtimeConfig.webFallbackUrl||location.href)});
  card.append(title,desc,retry,web); panel.append(card); document.body.append(panel);
}
const openExternal = async (url) => { const parsed = new URL(String(url), location.href); if (!['https:','http:','mailto:','tel:'].includes(parsed.protocol)) throw new Error('Unsupported external link'); return Browser.open({ url: parsed.href }); };
try {
  const originalOpen = window.open.bind(window); window.open = (url, target, features) => { if (window.Capacitor?.isNativePlatform?.() && url) { void openExternal(url); return null; } return originalOpen(url, target, features); };
  document.addEventListener('click', event => { const a = event.target?.closest?.('a[target="_blank"],a[href^="/privacy.html"],a[href^="/terms.html"],a[href^="/acceptable-use.html"],a[href^="/refunds.html"]'); if (!a || !window.Capacitor?.isNativePlatform?.()) return; event.preventDefault(); const target = a.getAttribute('href') || ''; const url = target.startsWith('/') ? new URL(target, runtimeConfig.webFallbackUrl || location.href).href : target; void openExternal(url); }, true);
} catch { /* external link handling is best effort */ }

// A same-origin backend link (for example /api/auth/login) has no server behind it on the bundled https://localhost origin.
// Navigating there loads Capacitor's index.html fallback at the wrong path and leaves a blank screen, so open it on the live backend instead.
try {
  const isApiPath = (p) => nativeApiPrefixes.some(prefix => { const x = String(prefix).replace(/\/$/, ''); return p === x || p.startsWith(x + '/'); });
  document.addEventListener('click', event => {
    if (event.defaultPrevented || !window.Capacitor?.isNativePlatform?.()) return;
    const a = event.target?.closest?.('a[href]'); if (!a) return;
    let u; try { u = new URL(a.getAttribute('href') || '', location.href); } catch { return; }
    if (u.origin !== location.origin || !isApiPath(u.pathname)) return;
    event.preventDefault(); event.stopPropagation();
    const base = nativeApiBase || String(runtimeConfig.webFallbackUrl || '').replace(/\/$/, '');
    if (base) void openExternal(new URL(u.pathname + u.search + u.hash, base + '/').href);
  }, true);
} catch { /* link guard is best effort */ }

// Shared scroll-quality layer: smooth page scroll, resilient nested scrollers and horizontal rails.
// Does not prevent touchmove or override app-specific scroll handlers.
try {
  const installScrollQuality = () => {
    if (document.getElementById('wybuild-scroll-quality')) return;
    const style = document.createElement('style');
    style.id = 'wybuild-scroll-quality';
    style.textContent = `
      html { scroll-behavior:smooth; -webkit-overflow-scrolling:touch; overscroll-behavior-x:contain; }
      body { -webkit-overflow-scrolling:touch; overscroll-behavior-x:contain; }
      [data-scroll-x],.wy-scroll-x { overflow-x:auto; -webkit-overflow-scrolling:touch; overscroll-behavior-x:contain; touch-action:pan-x pan-y; scrollbar-width:thin; }
      [data-scroll-y],.wy-scroll-y { overflow-y:auto; -webkit-overflow-scrolling:touch; overscroll-behavior-y:contain; touch-action:pan-y; scrollbar-width:thin; }
      pre,table { max-width:100%; }
      @media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}*,*::before,*::after{scroll-behavior:auto!important}}
    `;
    (document.head || document.documentElement).appendChild(style);
  };
  installScrollQuality();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', installScrollQuality, { once: true });
  new MutationObserver(installScrollQuality).observe(document.documentElement, { childList: true, subtree: true });
} catch { /* scroll enhancements must never block native bridge startup */ }

// Track the real visible WebView height. Android immersive/fullscreen can report a stale 100vh
// on some WebView versions; visualViewport follows the usable viewport during system-bar changes.
try {
  const updateWyBuildViewport = () => {
    const vv = window.visualViewport;
    const height = Math.round((vv && vv.height) || window.innerHeight || document.documentElement.clientHeight || 0);
    if (height > 0) document.documentElement.style.setProperty('--wybuild-viewport-height', `${height}px`);
  };
  updateWyBuildViewport();
  window.addEventListener('resize', updateWyBuildViewport, { passive: true });
  window.addEventListener('orientationchange', () => setTimeout(updateWyBuildViewport, 120), { passive: true });
  window.visualViewport?.addEventListener('resize', updateWyBuildViewport, { passive: true });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) updateWyBuildViewport(); }, { passive: true });
} catch { /* viewport tracking must never block native startup */ }

// Native edge-to-edge/fullscreen layouts need a viewport that includes display cutouts.
// Preserve existing viewport settings and only add viewport-fit=cover when missing.
try {
  const viewport = document.querySelector('meta[name="viewport"]');
  if (viewport && !/viewport-fit\\s*=/.test(viewport.content || '')) {
    viewport.content = `${viewport.content || 'width=device-width, initial-scale=1'}${viewport.content ? ', ' : ''}viewport-fit=cover`;
  }
  document.documentElement.style.setProperty('--wybuild-safe-top', 'env(safe-area-inset-top, 0px)');
  document.documentElement.style.setProperty('--wybuild-safe-bottom', 'env(safe-area-inset-bottom, 0px)');
} catch { /* viewport tuning must never block app startup */ }

const native = {
  isNative: () => !!window.Capacitor?.isNativePlatform?.(),
  platform: () => window.Capacitor?.getPlatform?.() || 'web',
  camera: {
    permissions: () => safe(() => Camera.requestPermissions()),
    takePhoto: (options = {}) => safe(() => Camera.getPhoto({ quality: 90, allowEditing: false, resultType: 'uri', source: 'CAMERA', ...options })),
    pickPhoto: (options = {}) => safe(() => Camera.getPhoto({ quality: 90, resultType: 'uri', source: 'PHOTOS', ...options })),
    pickMedia: (options = {}) => safe(() => Camera.pickImages({ limit: 10, quality: 90, ...options })),
  },
  location: {
    permissions: () => safe(() => Geolocation.requestPermissions()),
    current: (options = {}) => safe(() => Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 15000, ...options })),
    watch: (callback, options = {}) => Geolocation.watchPosition(options, callback),
    clearWatch: (id) => safe(() => Geolocation.clearWatch({ id })),
  },
  notifications: {
    permissions: () => safe(() => LocalNotifications.requestPermissions()),
    schedule: (title, body, id = Date.now(), at = new Date(Date.now() + 1000)) => safe(() => LocalNotifications.schedule({ notifications: [{ id: Number(id) || 1, title: String(title), body: String(body || ''), schedule: { at: new Date(at) } }] })),
    cancel: (ids) => safe(() => LocalNotifications.cancel({ notifications: (Array.isArray(ids) ? ids : [ids]).map(id => ({ id: Number(id) })) })),
    list: () => safe(() => LocalNotifications.getPending()),
  },
  push: {
    permissions: () => safe(() => PushNotifications.requestPermissions()),
    channel: () => safe(() => PushNotifications.createChannel({ id: 'wybuild-builds', name: 'Build updates', description: 'Successful and failed WyBuild jobs', importance: 5, visibility: 1 })),
    register: async () => safe(async () => { if (runtimeConfig.firebaseConfigured !== true) throw new Error('Push notifications are not configured for this build (no google-services.json was packaged).'); const p = await PushNotifications.requestPermissions(); if (p.receive !== 'granted') throw new Error('Notification permission was not granted'); await PushNotifications.register(); return p; }),
    onToken: (callback) => PushNotifications.addListener('registration', callback),
    onNotification: (callback) => PushNotifications.addListener('pushNotificationReceived', callback),
    onAction: (callback) => PushNotifications.addListener('pushNotificationActionPerformed', callback),
  },
  auth: {
    signIn: async ({ url } = {}) => safe(async () => { const target = new URL(String(url || ''), runtimeConfig.webFallbackUrl || location.href); if (!['https:'].includes(target.protocol)) throw new Error('Sign-in URL must use HTTPS'); target.searchParams.set('wybuild_return', `${runtimeConfig.returnScheme || 'wybuild'}://auth`); await Browser.open({ url: target.href }); return { waiting: true }; }),
    google: (options = {}) => safe(() => FirebaseAuthentication.signInWithGoogle(options)),
    apple: (options = {}) => safe(() => FirebaseAuthentication.signInWithApple(options)),
    signOut: () => safe(() => FirebaseAuthentication.signOut()),
    current: () => safe(() => FirebaseAuthentication.getCurrentUser()),
  },
  biometric: {
    available: () => safe(() => BiometricAuth.checkBiometry()),
    verify: (reason = 'Verify your identity') => safe(() => BiometricAuth.authenticate({ reason })),
  },
  clipboard: { read: () => safe(() => Clipboard.read()), write: (text) => safe(() => Clipboard.write({ string: String(text) })) },
  device: { info: () => safe(() => Device.getInfo()), id: () => safe(() => Device.getId()), battery: () => safe(() => Device.getBatteryInfo()) },
  files: {
    write: (path, data, options = {}) => safe(() => Filesystem.writeFile({ path, data, directory: Directory.Documents, recursive: true, ...options })),
    read: (path, options = {}) => safe(() => Filesystem.readFile({ path, directory: Directory.Documents, ...options })),
    delete: (path) => safe(() => Filesystem.deleteFile({ path, directory: Directory.Documents })),
    list: (path = '') => safe(() => Filesystem.readdir({ path, directory: Directory.Documents })),
    download: async (url, filename, options = {}) => safe(async () => {
      const parsed = new URL(url, location.href);
      if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('Downloads must use a safe HTTP(S) URL.');
      const safeName = String(filename || parsed.pathname.split('/').pop() || 'download.bin').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 150) || 'download.bin';
      // Use native streaming instead of fetch->Blob->base64, which can exhaust Android WebView memory on APK/AAB ZIPs.
      const saved = await Filesystem.downloadFile({ url: parsed.href, path: safeName, directory: Directory.Documents });
      const uri = saved?.path || saved?.uri;
      if (options.shareAfterSave && uri) await Share.share({ title: safeName, text: 'Downloaded file', url: uri, dialogTitle: 'Save or share downloaded file' });
      return { ...saved, saved: true, filename: safeName, directory: 'Documents', uri };
    }),
  },
  haptics: { impact: (style = 'medium') => safe(() => Haptics.impact({ style: ({ light: ImpactStyle.Light, heavy: ImpactStyle.Heavy, medium: ImpactStyle.Medium })[style] || ImpactStyle.Medium })), success: () => safe(() => Haptics.notification({ type: NotificationType.Success })), vibrate: (duration = 300) => safe(() => Haptics.vibrate({ duration })) },
  network: { status: () => safe(() => Network.getStatus()), watch: (callback) => Network.addListener('networkStatusChange', callback) },
  app: {
    info: () => safe(() => App.getInfo()), exit: () => safe(() => App.exitApp()),
    onBack: (callback) => App.addListener('backButton', callback),
    onStateChange: (callback) => App.addListener('appStateChange', callback),
  },
  // Opt-in deep links (needs the "Deep links" feature so the Android link filter exists). Returns the https URL
  // that opened the app, and notifies on links opened while the app is already running.
  deepLinks: {
    getLaunchUrl: async () => safe(async () => { const url = (await App.getLaunchUrl())?.url || null; if (url) emitNativeUrl(url); return url; }),
    onOpen: (callback) => App.addListener('appUrlOpen', (event) => { try { const url = event?.url || ''; emitNativeUrl(url); callback(url); } catch { /* site callback errors must not break the bridge */ } }),
  },
  // Opt-in swipe detector for app-specific navigation. It observes gestures but never prevents
  // native scrolling; callbacks run only for clear horizontal swipes that dominate vertical movement.
  gestures: {
    onSwipe: (callback, options = {}) => {
      const threshold = Math.max(35, Number(options.threshold || 65));
      let start = null;
      const down = (event) => { const t = event.touches?.[0]; if (t) start = { x: t.clientX, y: t.clientY, at: Date.now() }; };
      const up = (event) => {
        const t = event.changedTouches?.[0];
        if (!start || !t) { start = null; return; }
        const dx = t.clientX - start.x, dy = t.clientY - start.y, elapsed = Date.now() - start.at;
        if (Math.abs(dx) >= threshold && Math.abs(dx) > Math.abs(dy) * 1.35 && elapsed < 800) {
          try { callback({ direction: dx > 0 ? 'right' : 'left', distance: Math.round(Math.abs(dx)), durationMs: elapsed, startX: start.x, endX: t.clientX }); } catch {}
        }
        start = null;
      };
      document.addEventListener('touchstart', down, { passive: true });
      document.addEventListener('touchend', up, { passive: true });
      return { remove: async () => { document.removeEventListener('touchstart', down); document.removeEventListener('touchend', up); } };
    },
  },
  // Opt-in pull-to-refresh. Nothing happens until the site calls enable(); the site decides what "refresh" means.
  pullToRefresh: (() => {
    let active = null;
    const ensureStyle = () => { if (document.getElementById('wy-ptr-style')) return; const s = document.createElement('style'); s.id = 'wy-ptr-style'; s.textContent = '@keyframes wy-ptr-spin{to{transform:rotate(360deg)}}'; document.head.appendChild(s); };
    const scrolledAncestor = (el) => { for (let n = el; n && n !== document.body && n !== document.documentElement; n = n.parentElement) { const oy = getComputedStyle(n).overflowY; if ((oy === 'auto' || oy === 'scroll') && n.scrollTop > 0) return true; } return false; };
    const disable = () => { if (active) { active.remove(); active = null; } };
    const enable = (options = {}) => {
      disable();
      ensureStyle();
      const threshold = Math.max(64, Number(options.threshold || 92));
      const maxPull = Math.max(threshold + 24, Number(options.maxPull || 156));
      const onRefresh = typeof options.onRefresh === 'function' ? options.onRefresh : () => location.reload();
      const bubble = document.createElement('div');
      bubble.setAttribute('aria-hidden', 'true');
      bubble.style.cssText = 'position:fixed;left:50%;top:env(safe-area-inset-top,0px);width:40px;height:40px;margin-left:-20px;border-radius:50%;background:#fff;color:#0f172a;box-shadow:0 2px 10px rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;z-index:2147483647;pointer-events:none;opacity:0;transform:translateY(-48px);font:600 18px/1 system-ui,sans-serif;will-change:transform,opacity';
      const arrow = '\u2193';
      let start = null, pulling = false, armed = false, refreshing = false;
      const hide = () => { bubble.style.transition = 'transform .2s ease, opacity .2s ease'; bubble.style.transform = 'translateY(-48px)'; bubble.style.opacity = '0'; setTimeout(() => { bubble.remove(); bubble.style.transition = ''; }, 220); };
      const reset = () => { start = null; pulling = false; armed = false; };
      const down = (e) => {
        const t = e.touches?.[0], el = e.target;
        if (refreshing || !t || e.touches.length !== 1 || window.scrollY > 0 || scrolledAncestor(el) || /^(INPUT|TEXTAREA|SELECT)$/.test(el?.tagName || '') || el?.isContentEditable) { start = null; return; }
        start = { x: t.clientX, y: t.clientY };
      };
      const move = (e) => {
        const t = e.touches?.[0];
        if (!start || !t || refreshing) return;
        const dx = t.clientX - start.x, dy = t.clientY - start.y;
        if (!pulling) {
          if (Math.abs(dx) > Math.abs(dy) || dy < -8) { start = null; return; }
          if (dy < 12) return;
          pulling = true; bubble.textContent = arrow; document.body.appendChild(bubble);
        }
        if (window.scrollY > 0) { reset(); hide(); return; }
        const pull = Math.min(maxPull, Math.max(0, dy) * 0.62);
        if (!armed && pull >= threshold) { armed = true; Haptics.impact({ style: ImpactStyle.Light }).catch(() => {}); }
        if (armed && pull < threshold) armed = false;
        bubble.style.opacity = String(Math.min(1, pull / threshold));
        bubble.style.transform = 'translateY(' + (pull - 48) + 'px) rotate(' + (armed ? 180 : 0) + 'deg)';
      };
      const up = (e) => {
        if (!pulling) { start = null; return; }
        const go = armed && e.type === 'touchend';
        reset();
        if (!go) { hide(); return; }
        refreshing = true;
        bubble.innerHTML = '<span style="width:18px;height:18px;border:2px solid #cbd5e1;border-top-color:#0f172a;border-radius:50%;animation:wy-ptr-spin .7s linear infinite"></span>';
        bubble.style.transform = 'translateY(' + (threshold * 0.6) + 'px)';
        Promise.resolve().then(() => onRefresh()).catch(() => {}).finally(() => { refreshing = false; hide(); });
      };
      const prevOverscroll = document.documentElement.style.overscrollBehaviorY;
      document.documentElement.style.overscrollBehaviorY = 'contain';
      document.addEventListener('touchstart', down, { passive: true });
      document.addEventListener('touchmove', move, { passive: true });
      document.addEventListener('touchend', up, { passive: true });
      document.addEventListener('touchcancel', up, { passive: true });
      active = { remove: () => { document.removeEventListener('touchstart', down); document.removeEventListener('touchmove', move); document.removeEventListener('touchend', up); document.removeEventListener('touchcancel', up); document.documentElement.style.overscrollBehaviorY = prevOverscroll; bubble.remove(); } };
      return { remove: async () => disable() };
    };
    return { enable, disable };
  })(),
  // Opt-in edge swipe-to-go-back for in-app navigation. Android's own system back gesture (gesture navigation) already
  // fires app.onBack(); this adds the same behaviour for in-app swipes that start just inside the screen edge.
  swipeBack: (() => {
    let active = null;
    const disable = () => { if (active) { active.remove(); active = null; } };
    const enable = (options = {}) => {
      disable();
      const edge = Math.max(16, Number(options.edge || 40));
      const threshold = Math.max(40, Number(options.threshold || 80));
      const rtl = getComputedStyle(document.documentElement).direction === 'rtl';
      const onBack = typeof options.onBack === 'function' ? options.onBack : () => { if (history.length > 1) history.back(); else if (options.exitAtRoot) App.exitApp(); };
      const hint = document.createElement('div');
      hint.setAttribute('aria-hidden', 'true');
      hint.textContent = rtl ? '\u203A' : '\u2039';
      hint.style.cssText = 'position:fixed;top:50%;' + (rtl ? 'right' : 'left') + ':0;width:36px;height:36px;margin-top:-18px;border-radius:50%;background:rgba(15,23,42,.85);color:#fff;display:flex;align-items:center;justify-content:center;z-index:2147483647;pointer-events:none;opacity:0;font:600 22px/1 system-ui,sans-serif;will-change:transform,opacity';
      let start = null, shown = false;
      const fromEdge = (x) => (rtl ? x >= window.innerWidth - edge : x <= edge);
      const hideHint = () => { shown = false; hint.remove(); };
      const down = (e) => { const t = e.touches?.[0]; start = t && e.touches.length === 1 && fromEdge(t.clientX) ? { x: t.clientX, y: t.clientY, at: Date.now() } : null; };
      const move = (e) => {
        const t = e.touches?.[0];
        if (!start || !t) return;
        const dx = (rtl ? -1 : 1) * (t.clientX - start.x), dy = t.clientY - start.y;
        if (Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx) * 1.2) { start = null; hideHint(); return; }
        if (dx > 10) {
          if (!shown) { document.body.appendChild(hint); shown = true; }
          const p = Math.min(1, dx / threshold);
          hint.style.opacity = String(p);
          hint.style.transform = 'translateX(' + (rtl ? -1 : 1) * (Math.min(dx, threshold) * 0.5 - 18) + 'px)';
        }
      };
      const up = (e) => {
        const t = e.changedTouches?.[0];
        hideHint();
        if (!start || !t) { start = null; return; }
        const dx = (rtl ? -1 : 1) * (t.clientX - start.x), dy = t.clientY - start.y, elapsed = Date.now() - start.at;
        start = null;
        if (e.type === 'touchend' && dx >= threshold && dx > Math.abs(dy) * 1.5 && elapsed < 900) {
          Haptics.impact({ style: ImpactStyle.Light }).catch(() => {});
          try { onBack({ direction: rtl ? 'left' : 'right', distance: Math.round(dx), durationMs: elapsed }); } catch {}
        }
      };
      document.addEventListener('touchstart', down, { passive: true });
      document.addEventListener('touchmove', move, { passive: true });
      document.addEventListener('touchend', up, { passive: true });
      document.addEventListener('touchcancel', up, { passive: true });
      active = { remove: () => { document.removeEventListener('touchstart', down); document.removeEventListener('touchmove', move); document.removeEventListener('touchend', up); document.removeEventListener('touchcancel', up); hint.remove(); } };
      return { remove: async () => disable() };
    };
    return { enable, disable };
  })(),
  contacts: {
    // Opens Android's system picker; returns only the contact the user selects.
    pick: async () => safe(async () => {
      if (!window.Capacitor?.isNativePlatform?.()) throw new Error('Contact picker is available in the native Android app only.');
      return await WyBuildContactsPlugin.pick();
    }),
  },
  share: (title, text, url) => safe(() => Share.share({ title, text, url })),
  shareTarget: {
    // Android SEND/SEND_MULTIPLE intents are registered by the build finalizer when selected.
    // Call on startup and on app resume to consume content shared into the app.
    getSharedContent: async () => {
      try {
        const plugin = window.Capacitor?.Plugins?.WyBuildShareTarget;
        if (!plugin?.getSharedContent) return { ok: false, error: 'Incoming share target is not enabled in this build.' };
        const result = await plugin.getSharedContent();
        return { ok: true, ...result };
      } catch (e) { return { ok: false, error: String(e?.message || e) }; }
    },
  },
  openBrowser: (url) => safe(() => Browser.open({ url: String(url) })),
  statusBar: { show: () => safe(() => StatusBar.show()), hide: () => safe(() => StatusBar.hide()), dark: () => safe(() => StatusBar.setStyle({ style: Style.Dark })), light: () => safe(() => StatusBar.setStyle({ style: Style.Light })) },
  orientation: { lock: (orientation = 'portrait') => safe(() => ScreenOrientation.lock({ orientation })), unlock: () => safe(() => ScreenOrientation.unlock()) },
  storage: { get: (key) => safe(() => Preferences.get({ key: String(key) })), set: (key, value) => safe(() => Preferences.set({ key: String(key), value: String(value) })), remove: (key) => safe(() => Preferences.remove({ key: String(key) })) },
  keyboard: { hide: () => safe(() => Keyboard.hide()) },
  actionSheet: (title, options = []) => safe(() => ActionSheet.showActions({ title, options: options.map((title, i) => ({ title: String(title), style: 'DEFAULT' })) })),
  alert: (title, message) => safe(() => Dialog.alert({ title: String(title), message: String(message || '') })),
};
native.openExternal = openExternal;
window.WyBuildNative = Object.freeze(native);
setTimeout(() => window.dispatchEvent(new CustomEvent('wybuild-native-ready', { detail: { platform: native.platform() } })), 0);
