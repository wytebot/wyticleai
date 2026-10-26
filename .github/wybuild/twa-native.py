#!/usr/bin/env python3
"""WyBuild native features for the generated Bubblewrap TWA project.

Runs after `twa-generate.mjs` and before `bubblewrap build`. Everything here is idempotent and
fails loudly: a feature the developer switched on must really be inside the APK, not silently skipped.

  python3 twa-native.py <generated-project-dir>
"""
import json, os, re, shutil, subprocess, sys

proj = sys.argv[1]
out = os.environ["WB_OUT"]
cfg = json.load(open(out + "/twa-resolved.json"))
extras = json.load(open(out + "/wybuild-extras.json")) if os.path.exists(out + "/wybuild-extras.json") else {}
manifest_path = proj + "/app/src/main/AndroidManifest.xml"
xml = open(manifest_path, encoding="utf8").read()
applied, notes = [], []
# "standalone" (default): the site runs in WyBuild's own native WebView shell, so there is never an address bar.
# "twa": plain Trusted Web Activity (needs Digital Asset Links, or Chrome shows its address bar).
standalone = extras.get("shell", "standalone") != "twa"
here = os.path.dirname(os.path.abspath(__file__))
native_name = "%s.WyBuildActivity" % cfg.get("packageId", "")


def perm(name):
    return name if "." in name else "android.permission." + name


def has_perm(name):
    return re.search(r'<uses-permission[^>]+android:name="%s"' % re.escape(name), xml) is not None


def add_before_application(block):
    global xml
    xml, n = re.subn(r"(<application\b)", lambda m: block + "    " + m.group(1), xml, count=1)
    if not n:
        raise SystemExit("AndroidManifest.xml has no <application> element")


# ---------------------------------------------------------------- 1. permissions
wanted = [perm(p) for p in cfg.get("androidPermissions", [])]
if "android.permission.ACCESS_FINE_LOCATION" in wanted or "android.permission.ACCESS_COARSE_LOCATION" in wanted:
    wanted += ["android.permission.ACCESS_FINE_LOCATION", "android.permission.ACCESS_COARSE_LOCATION"]
if standalone:
    # A TWA lets Chrome do the networking; our own WebView needs these itself or every page fails to load.
    wanted += ["android.permission.INTERNET", "android.permission.ACCESS_NETWORK_STATE"]
features = cfg.get("features", {}) or {}
# Native bridge features (standalone shell only). BASE needs no permission and no manifest entry, so every build gets it;
# OPT-IN features touch the manifest (permission, intent filter or receiver), so they exist only when the developer selects them.
NATIVE_BASE = ["clipboard", "haptics", "keepawake", "deviceinfo", "orientation", "lifecycle", "calendar", "contacts", "rate",
               "securescreen", "savefile", "shortcuts", "speech"]
NATIVE_OPTIN = ["biometric", "sharetarget", "reminders"]
opted = [f for f in dict.fromkeys(extras.get("nativeFeatures") or []) if f in NATIVE_OPTIN]
native_features = (NATIVE_BASE + opted) if standalone else []
if standalone and "biometric" in opted:
    wanted.append("android.permission.USE_BIOMETRIC")
if standalone and "reminders" in opted:
    wanted.append("android.permission.POST_NOTIFICATIONS")
if cfg.get("enableNotifications"):
    # Android 13+ will not show ANY notification, and cannot even ask, unless the app declares this
    wanted.append("android.permission.POST_NOTIFICATIONS")
if (features.get("locationDelegation") or {}).get("enabled"):
    # Android 12+ lets users pick "approximate"; the app must declare both for the prompt to offer it
    wanted += ["android.permission.ACCESS_FINE_LOCATION", "android.permission.ACCESS_COARSE_LOCATION"]
block = ""
for p in dict.fromkeys(wanted):
    if not re.fullmatch(r"[A-Za-z0-9_.]+", p):
        raise SystemExit("bad permission: " + p)
    if not has_perm(p):
        block += '    <uses-permission android:name="%s" />\n' % p
        applied.append("permission " + p.rsplit(".", 1)[-1])

# Camera / microphone: without these <uses-feature required="false"> lines Google Play hides the app
# from every phone that lacks the hardware, because the permission implies the feature is required.
for permission, feature_names in (
    ("android.permission.CAMERA", ["android.hardware.camera", "android.hardware.camera.autofocus"]),
    ("android.permission.RECORD_AUDIO", ["android.hardware.microphone"]),
    ("android.permission.ACCESS_FINE_LOCATION", ["android.hardware.location.gps"]),
):
    if permission in wanted:
        for feat in feature_names:
            if feat not in xml:
                block += '    <uses-feature android:name="%s" android:required="false" />\n' % feat
if block:
    add_before_application(block)

# ---------------------------------------------------------------- 2. notifications (delegation)
if cfg.get("enableNotifications"):
    # Web Push -> Chrome -> this app. The service must exist and be enabled, or notifications fall back to Chrome's own.
    if standalone:
        applied.append("native notifications (WyBuildNative.notify from your site)")
    elif "DelegationService" not in xml:
        raise SystemExit("Notifications are on, but Bubblewrap did not generate DelegationService. Update bubblewrap_version.")
    if not standalone and "NotificationPermissionRequestActivity" not in xml:
        add = '        <activity android:name="com.google.androidbrowserhelper.trusted.NotificationPermissionRequestActivity" />\n'
        xml = xml.replace("</application>", add + "    </application>", 1)
    if not standalone:
        applied.append("notification delegation (web push shows as native Android notifications)")

# ---------------------------------------------------------------- 3. fullscreen / immersive
# TWA display metadata belongs to Chrome. Standalone fullscreen is implemented by WyBuildActivity.
want = {"fullscreen": "immersive", "fullscreen-sticky": "sticky-immersive"}.get(cfg.get("display"))
if want and not standalone:
    meta = '\n            <meta-data android:name="android.support.customtabs.trusted.DISPLAY_MODE" android:value="%s" />' % want
    if "trusted.DISPLAY_MODE" in xml:
        xml = re.sub(r'(android:name="android\.support\.customtabs\.trusted\.DISPLAY_MODE"\s+android:value=")[^"]*(")', r"\g<1>%s\g<2>" % want, xml)
    else:
        # Bubblewrap normally uses LauncherActivity. Fail rather than silently losing the TWA display mode.
        m = re.search(r'<activity\b[^>]*android:name="(?:[^"]*\.)?LauncherActivity"[^>]*>', xml)
        if not m:
            raise SystemExit("Could not add the TWA fullscreen display mode: LauncherActivity not found in AndroidManifest.xml")
        xml = xml[:m.end()] + meta + xml[m.end():]
    applied.append("display=" + want)
    notes.append("TWA fullscreen depends on Digital Asset Links; Standalone fullscreen does not.")
elif want and standalone:
    applied.append("native immersive fullscreen requested; implemented by WyBuildActivity (not Chrome/TWA metadata)")
# ---------------------------------------------------------------- 4. predictive back (Android 13+)
if extras.get("predictiveBack"):
    gradle = ""
    for g in ("app/build.gradle", "app/build.gradle.kts"):
        if os.path.exists(proj + "/" + g):
            gradle += open(proj + "/" + g, encoding="utf8").read()
    m = re.search(r"compileSdk(?:Version)?\s*(?:=\s*)?(\d+)", gradle)
    if m and int(m.group(1)) < 33:
        print("::warning::Predictive back skipped: this project compiles against API %s (needs 33+)." % m.group(1))
    elif "enableOnBackInvokedCallback" not in xml:
        xml = re.sub(r"<application\b", '<application android:enableOnBackInvokedCallback="true"', xml, count=1)
        applied.append("predictive-back")

# ---------------------------------------------------------------- 4b. link handling
# Rules come from the "Link handling" panel: internal (stay in the app), external (system browser), other (hand to Android).
link_rules = [r for r in (extras.get("linkRules") or []) if isinstance(r, dict)]
own_host = (cfg.get("host") or "").split(":")[0].lower()
deep_hosts = []
for r in link_rules:
    if r.get("kind") != "host" or r.get("mode") != "internal":
        continue
    host = ("*." if r.get("wildcard") else "") + r["host"]
    if not re.fullmatch(r"(\*\.)?[a-z0-9.-]+", host) or not re.fullmatch(r"(/[A-Za-z0-9._~%/-]*)?", r.get("path", "")):
        raise SystemExit("bad link rule: " + host + r.get("path", ""))
    if host.replace("www.", "", 1) == own_host.replace("www.", "", 1) and not r.get("path"):
        continue  # the app's own site already opens in the app
    deep_hosts.append((host, r.get("path", "")))
    if r.get("wildcard"):
        deep_hosts.append((r["host"], r.get("path", "")))  # Android's *.example.com does not match example.com itself
deep_hosts = list(dict.fromkeys(deep_hosts))
if deep_hosts:
    filters = ""
    for host, path in deep_hosts:
        key = 'android:host="%s"' % host
        if key in xml and ('android:pathPrefix="%s"' % path in xml if path else True):
            continue
        filters += (
            '            <intent-filter android:autoVerify="true">\n'
            '                <action android:name="android.intent.action.VIEW" />\n'
            '                <category android:name="android.intent.category.DEFAULT" />\n'
            '                <category android:name="android.intent.category.BROWSABLE" />\n'
            '                <data android:scheme="https" android:host="%s"%s />\n'
            '            </intent-filter>\n' % (host, (' android:pathPrefix="%s"' % path) if path else "")
        )
    if filters:
        # Insert intent-filters while Bubblewrap still exposes its launcher; the standalone
        # transformation below then renames that same component to WyBuildActivity.
        activity_name = "LauncherActivity"
        start = re.search(r'<activity\b(?:(?!/>)[^>])*android:name="(?:[^"]*\.)?' + re.escape(activity_name) + r'"[^>]*>', xml)
        if not start:
            # Bubblewrap can use the fully-qualified helper name in the TWA manifest.
            start = re.search(r'<activity\b(?:(?!/>)[^>])*' + re.escape(activity_name) + r'(?:(?!/>)[^>])*>', xml)
        if not start:
            raise SystemExit("Could not add link handling: target launcher activity not found in AndroidManifest.xml")
        end = xml.find("</activity>", start.end())
        if end == -1:
            raise SystemExit("Could not add link handling: target launcher activity is not closed in AndroidManifest.xml")
        # Insert inside the target activity, immediately before its closing tag.
        xml = xml[:end] + filters + xml[end:]
        applied.append("links to %s open in the app (%d domain%s)" % (", ".join(h + p for h, p in deep_hosts), len(deep_hosts), "" if len(deep_hosts) == 1 else "s"))
    if any(h.startswith("*.") for h, _ in deep_hosts):
        notes.append("Wildcard domains open the app only after Android verifies the root domain: publish assetlinks.json on it too. Wildcards cannot be trusted origins, so list each subdomain you want without the address bar.")
n_ext = sum(1 for r in link_rules if r.get("mode") == "external")
n_other = sum(1 for r in link_rules if r.get("mode") == "other")
if n_ext or n_other:
    if standalone:
        applied.append("link rules enforced natively in the app: %d external, %d handed to Android" % (n_ext, n_other))
    else:
        applied.append("link rules for the website: %d external, %d handed to Android (wybuild-links.js)" % (n_ext, n_other))
        notes.append("External / Other link rules are applied by wybuild-links.js on your website: add it to your site (see NATIVE-FEATURES.md in the build artifact). A Trusted Web Activity cannot intercept those links natively.")


# ---------------------------------------------------------------- 4c. standalone shell (native WebView host)
def own_hosts():
    hosts = [own_host] if own_host else []
    for o in cfg.get("additionalTrustedOrigins", []):
        h = re.sub(r"^https?://", "", str(o)).strip("/").split(":")[0].lower()
        if h and h not in hosts:
            hosts.append(h)
    return hosts


def set_attr(tag, name, value):
    pat = r'android:%s="[^"]*"' % name
    if re.search(pat, tag):
        return re.sub(pat, lambda m: 'android:%s="%s"' % (name, value), tag, count=1)
    return re.sub(r"^(<activity\b)", lambda m: m.group(1) + '\n            android:%s="%s"' % (name, value), tag, count=1)


if standalone:
    pkg_id = cfg.get("packageId", "")
    if not re.fullmatch(r"[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+", pkg_id):
        raise SystemExit("bad package id: " + pkg_id)
    tpl = os.path.join(here, "WyBuildActivity.java")
    if not os.path.exists(tpl):
        raise SystemExit("WyBuildActivity.java is missing next to twa-native.py. Reinstall the WyBuild TWA workflow (WyBuild > Web to Android > Update workflow).")
    src_dir = os.path.join(proj, "app", "src", "main", "java", *pkg_id.split("."))
    os.makedirs(src_dir, exist_ok=True)
    open(os.path.join(src_dir, "WyBuildActivity.java"), "w", encoding="utf8").write(open(tpl, encoding="utf8").read().replace("__PACKAGE__", pkg_id))

    def js_rule_cfg(r):
        if r.get("kind") == "scheme":
            return {"k": "s", "s": r["scheme"], "m": r["mode"]}
        return {"k": "h", "h": r["host"], "w": bool(r.get("wildcard")), "p": r.get("path", ""), "m": r["mode"]}

    start_abs = "https://%s%s" % (cfg.get("host", ""), cfg.get("startUrl") or "/")
    assets = os.path.join(proj, "app", "src", "main", "assets")
    os.makedirs(assets, exist_ok=True)
    json.dump({
        "startUrl": start_abs,
        "name": cfg.get("name", ""),
        "versionName": cfg.get("appVersion", ""),
        "display": cfg.get("display", "standalone"),
        "fullscreen": cfg.get("display") in ("fullscreen", "fullscreen-sticky"),
        "notifications": bool(cfg.get("enableNotifications")),
        "themeColor": cfg.get("themeColor", "#FFFFFF"),
        "backgroundColor": cfg.get("backgroundColor", "#FFFFFF"),
        "navigationColor": cfg.get("navigationColor") or cfg.get("themeColor", "#FFFFFF"),
        "ownHosts": own_hosts(),
        "rules": [js_rule_cfg(r) for r in link_rules],
        "nativeFeatures": native_features,
    }, open(os.path.join(assets, "wybuild-config.json"), "w", encoding="utf8"), indent=2)

    values = os.path.join(proj, "app", "src", "main", "res", "values")
    os.makedirs(values, exist_ok=True)
    open(os.path.join(values, "wybuild_theme.xml"), "w", encoding="utf8").write(
        '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n'
        '    <style name="WyBuildTheme" parent="android:Theme.Material.Light.NoActionBar">\n'
        '        <item name="android:windowBackground">%s</item>\n'
        '        <item name="android:statusBarColor">%s</item>\n'
        '        <item name="android:navigationBarColor">%s</item>\n'
        '        <item name="android:windowDrawsSystemBarBackgrounds">true</item>\n'
        '    </style>\n</resources>\n' % (cfg.get("backgroundColor", "#FFFFFF"), cfg.get("themeColor", "#FFFFFF"), cfg.get("navigationColor") or cfg.get("themeColor", "#FFFFFF")))

    # Point EVERY Bubblewrap launcher/alias at the native shell. A TWA project can expose
    # LauncherActivity through either a direct activity or an activity-alias; changing only one
    # can silently leave Chrome's Custom Tab as the real launcher (the URL/share/three-dot bar).
    launcher_hits = 0
    # Direct activity declarations. Keep all intent-filters on the component so MAIN/LAUNCHER,
    # VIEW and shortcuts continue to work, but replace the implementation class.
    def replace_launcher_activity(m):
        global launcher_hits
        tag = m.group(0)
        if not re.search(r'android:(?:name|targetActivity)="(?:[^"]*\.)?LauncherActivity"', tag):
            return tag
        launcher_hits += 1
        tag = re.sub(r'android:name="(?:[^"]*\.)?LauncherActivity"', 'android:name="%s"' % native_name, tag, count=1)
        tag = set_attr(tag, "theme", "@style/WyBuildTheme")
        tag = set_attr(tag, "configChanges", "orientation|screenSize|smallestScreenSize|screenLayout|keyboard|keyboardHidden|navigation|uiMode|density|layoutDirection|fontScale")
        tag = set_attr(tag, "windowSoftInputMode", "adjustResize")
        tag = set_attr(tag, "hardwareAccelerated", "true")
        return tag
    xml = re.sub(r'<activity\b[^>]*android:name="(?:[^"]*\.)?LauncherActivity"[^>]*>', replace_launcher_activity, xml)

    # Activity aliases do not themselves run code; redirect their targetClass to WyBuildActivity.
    def replace_alias(m):
        global launcher_hits
        tag = m.group(0)
        if not re.search(r'android:(?:name|targetActivity)="(?:[^"]*\.)?LauncherActivity"', tag):
            return tag
        launcher_hits += 1
        tag = re.sub(r'android:targetActivity="(?:[^"]*\.)?LauncherActivity"', 'android:targetActivity="%s"' % native_name, tag, count=1)
        return re.sub(r'android:targetClass="(?:[^"]*\.)?LauncherActivity"', 'android:targetClass="%s"' % native_name, tag, count=1)
    xml = re.sub(r'<activity-alias\b[^>]*>', replace_alias, xml)

    # If Bubblewrap ever changes its manifest shape, add a native launcher rather than building a
    # browser shell by accident. This is intentionally an error for a missing launcher only after
    # we have tried both activity and alias forms.
    if launcher_hits == 0:
        raise SystemExit("Could not switch the standalone shell: Bubblewrap exposed no LauncherActivity activity or alias")

    # Redirect any shortcut/alias targetClass references left in generated XML resources.
    xml_dir = os.path.join(proj, "app", "src", "main", "res", "xml")
    if os.path.isdir(xml_dir):
        for fn in os.listdir(xml_dir):
            fp = os.path.join(xml_dir, fn)
            try:
                t = open(fp, encoding="utf8").read()
            except Exception:
                continue
            if re.search(r'android:(?:targetActivity|targetClass)="(?:[^"]*\.)?LauncherActivity"', t):
                t2 = re.sub(r'android:targetActivity="(?:[^"]*\.)?LauncherActivity"', 'android:targetActivity="%s"' % native_name, t)
                t2 = re.sub(r'android:targetClass="(?:[^"]*\.)?LauncherActivity"', 'android:targetClass="%s"' % native_name, t2)
                if t2 != t:
                    open(fp, "w", encoding="utf8").write(t2)

    # Release builds shrink code: keep the shell and the methods the web page calls through window.WyBuildNative
    pg = os.path.join(proj, "app", "proguard-rules.pro")
    keep = "\n# WyBuild standalone shell\n-keep class %s.WyBuildActivity { *; }\n-keepclassmembers class * { @android.webkit.JavascriptInterface <methods>; }\n" % pkg_id
    old = open(pg, encoding="utf8").read() if os.path.exists(pg) else ""
    if "WyBuild standalone shell" not in old:
        open(pg, "a", encoding="utf8").write(keep)
    # ---- opt-in features that need manifest entries. Fail loudly: a selected feature must really be in the build.
    def activity_span():
        m = re.search(r'<activity\b[^>]*android:name="%s"[^>]*>' % re.escape(native_name), xml)
        if not m or m.group(0).rstrip().endswith("/>"):
            raise SystemExit("Could not find the WyBuildActivity element to attach native features to")
        end = xml.find("</activity>", m.end())
        if end < 0:
            raise SystemExit("WyBuildActivity element is not closed")
        return end

    if "sharetarget" in opted:
        end = activity_span()
        xml = xml[:end] + (
            '    <intent-filter>\n'
            '                <action android:name="android.intent.action.SEND" />\n'
            '                <category android:name="android.intent.category.DEFAULT" />\n'
            '                <data android:mimeType="text/plain" />\n'
            '            </intent-filter>\n        ') + xml[end:]
        applied.append("share target: the app appears in Android's Share sheet for text")
    if "biometric" in opted:
        applied.append("biometric unlock (platform BiometricPrompt, USE_BIOMETRIC)")
    # WyBuildActivity references the receiver class, so its source must ALWAYS be compiled in.
    # It is only registered in the manifest (and therefore only ever runs) when Reminders is selected.
    rt = os.path.join(here, "WyBuildReminderReceiver.java")
    if not os.path.exists(rt):
        raise SystemExit("WyBuildReminderReceiver.java is missing next to twa-native.py. Reinstall the WyBuild TWA workflow (WyBuild > Web to Android > Update workflow).")
    open(os.path.join(src_dir, "WyBuildReminderReceiver.java"), "w", encoding="utf8").write(open(rt, encoding="utf8").read().replace("__PACKAGE__", pkg_id))
    if "reminders" in opted:
        recv = '    <receiver android:name="%s.WyBuildReminderReceiver" android:exported="false" />\n' % pkg_id
        xml, n = re.subn(r"</application>", lambda m: recv + "    </application>", xml, count=1)
        if not n:
            raise SystemExit("AndroidManifest.xml has no </application>")
        applied.append("local reminders (AlarmManager + notification receiver)")
    # Text-to-speech needs package visibility on Android 11+
    tts_q = '    <queries>\n        <intent><action android:name="android.intent.action.TTS_SERVICE" /></intent>\n    </queries>\n'
    if "TTS_SERVICE" not in xml:
        if "<queries>" in xml:
            xml = xml.replace("<queries>", "<queries>\n        <intent><action android:name=\"android.intent.action.TTS_SERVICE\" /></intent>", 1)
        else:
            add_before_application(tts_q)
    applied.append("native bridge: " + ", ".join(native_features))
    applied.append("standalone app shell: your site runs inside the app's own WebView, so there is no address bar or Chrome toolbar and no Digital Asset Links dependency")
    applied.append("native file upload, downloads, camera/microphone/location prompts, JS dialogs, fullscreen video, offline screen, back button")
    if (features.get("playBilling") or {}).get("enabled"):
        notes.append("Play Billing needs the Trusted Web Activity shell. Choose 'Trusted Web Activity' as the app shell in WyBuild if you use it.")

open(manifest_path, "w", encoding="utf8").write(xml)
assert "<application" in xml


# ---------------------------------------------------------------- 5. status-bar notification icon
def magick():
    return shutil.which("magick") or shutil.which("convert")


def silhouette(path):
    """Android paints the small notification icon in a single colour. A full-colour icon turns into a white square."""
    tool = magick()
    if not tool or not os.path.exists(path):
        return False
    base = [tool]
    probe = subprocess.run(base + [path, "-format", "%[opaque]", "info:"], capture_output=True, text=True)
    tmp = path + ".tmp.png"
    if probe.stdout.strip().lower() == "true":
        # opaque square: treat the colour of the top-left pixel as background and keep only the logo
        bg = subprocess.run(base + [path, "-format", "%[pixel:p{0,0}]", "info:"], capture_output=True, text=True).stdout.strip()
        r = subprocess.run(base + [path, "-alpha", "set", "-fuzz", "18%", "-transparent", bg, "-channel", "RGB", "-evaluate", "set", "100%", "+channel", tmp])
    else:
        r = subprocess.run(base + [path, "-alpha", "set", "-channel", "RGB", "-evaluate", "set", "100%", "+channel", tmp])
    if r.returncode != 0 or not os.path.exists(tmp):
        return False
    os.replace(tmp, path)
    return True


if cfg.get("enableNotifications") and not cfg.get("monochromeIconUrl"):
    done = 0
    for d in os.listdir(proj + "/app/src/main/res"):
        f = "%s/app/src/main/res/%s/ic_notification_icon.png" % (proj, d)
        if d.startswith("drawable") and os.path.exists(f) and silhouette(f):
            done += 1
    if done:
        applied.append("white notification icon (%d sizes)" % done)
    else:
        notes.append("Add a monochrome icon to your web manifest: otherwise Android may show a plain square in the status bar for notifications.")

# ---------------------------------------------------------------- 6. developer kit for web push (ships in the build artifact)
kit = out + "/dist/native"
os.makedirs(kit, exist_ok=True)
host = cfg.get("host", "")
pkg = cfg.get("packageId", "")

open(kit + "/wybuild-push.js", "w", encoding="utf8").write(r"""/*! WyBuild push helper. Add to your website: <script src="/wybuild-push.js" defer></script>
 * Works in the Android app (Trusted Web Activity) AND in the normal browser.
 * In the app, the browser's push notification is delegated to Android, so users see a real native notification
 * with your app icon, name and notification channel; tapping it opens your app on the url you send.
 *
 *   WyBuildPush.enable({ vapidPublicKey: 'B...', endpoint: '/api/push/subscribe' })   // call from a button tap
 */
(function () {
  var KEY = 'wybuild_in_app';
  function inApp() {
    try {
      if (window.WyBuildNative || /WyBuildApp\//.test(navigator.userAgent)) return true;
      if (document.referrer && document.referrer.indexOf('android-app://') === 0) localStorage.setItem(KEY, '1');
      return localStorage.getItem(KEY) === '1' || (window.matchMedia && matchMedia('(display-mode: fullscreen)').matches);
    } catch (e) { return false; }
  }
  function b64ToBytes(s) {
    var p = '='.repeat((4 - (s.length % 4)) % 4);
    var raw = atob((s + p).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(raw, function (c) { return c.charCodeAt(0); });
  }
  var api = {
    isApp: inApp,
    supported: function () { return !inApp() && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window; },
    permission: function () { return 'Notification' in window ? Notification.permission : 'unsupported'; },
    /** Ask permission (Android shows its own prompt in the app), subscribe, and send the subscription to your server. */
    enable: function (opts) {
      opts = opts || {};
      if (inApp()) return Promise.reject(new Error('Remote Web Push is not supported by the standalone WebView shell. Use WyBuildPush.notify() for native notifications or the Trusted Web Activity shell for Web Push.'));
      if (!api.supported()) return Promise.reject(new Error('Push is not supported here'));
      if (!opts.vapidPublicKey) return Promise.reject(new Error('vapidPublicKey is required'));
      return navigator.serviceWorker.register(opts.serviceWorker || '/sw.js').then(function () {
        return navigator.serviceWorker.ready;
      }).then(function (reg) {
        return Notification.requestPermission().then(function (perm) {
          if (perm !== 'granted') throw new Error('Notifications were not allowed');
          return reg.pushManager.getSubscription().then(function (existing) {
            return existing || reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(opts.vapidPublicKey) });
          });
        });
      }).then(function (sub) {
        var body = JSON.stringify({ subscription: sub.toJSON(), app: inApp(), platform: inApp() ? 'android-app' : 'web' });
        if (!opts.endpoint) return sub;
        return fetch(opts.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: body })
          .then(function (r) { if (!r.ok) throw new Error('Your server rejected the subscription (' + r.status + ')'); return sub; });
      });
    },
    /** Show a notification right now. In the Android app this is a native Android notification (works without Web Push). */
    notify: function (title, body, url) {
      if (window.WyBuildNative && window.WyBuildNative.notify) { window.WyBuildNative.notify(String(title || ''), String(body || ''), url ? new URL(url, location.href).href : ''); return Promise.resolve(true); }
      if (!api.supported()) return Promise.resolve(false);
      return navigator.serviceWorker.ready.then(function (reg) { return reg.showNotification(title, { body: body || '', data: { url: url || '/' } }); }).then(function () { return true; });
    },
    disable: function (opts) {
      return navigator.serviceWorker.getRegistration().then(function (reg) {
        return reg && reg.pushManager.getSubscription();
      }).then(function (sub) {
        if (!sub) return false;
        var ep = sub.endpoint;
        return sub.unsubscribe().then(function () {
          if (opts && opts.endpoint) return fetch(opts.endpoint, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ endpoint: ep }) }).then(function () { return true; });
          return true;
        });
      });
    }
  };
  window.WyBuildPush = api;
})();
""")

open(kit + "/sw.js", "w", encoding="utf8").write(r"""/* Minimal push service worker. Serve at /sw.js (or change the path in WyBuildPush.enable).
 * Merge into your own service worker if you already have one. */
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });

self.addEventListener('push', function (event) {
  var data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { title: event.data && event.data.text() }; }
  var title = data.title || 'New message';
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || '',
    icon: data.icon || '/icon-192.png',        // large icon
    badge: data.badge || '/badge-72.png',      // small monochrome icon (the app's own is used inside the Android app)
    image: data.image,
    tag: data.tag,                              // same tag = replace instead of stacking
    renotify: !!data.tag,
    data: { url: data.url || '/' },
    actions: data.actions || []
  }));
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var url = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) {
      if (list[i].url.indexOf(self.location.origin) === 0 && 'focus' in list[i]) { list[i].navigate(url); return list[i].focus(); }
    }
    return self.clients.openWindow(url);
  }));
});
""")

open(kit + "/NATIVE-FEATURES.md", "w", encoding="utf8").write("""# Native features in this build

Package: `%(pkg)s`   Site: `https://%(host)s`

## Push notifications
For a **Trusted Web Activity**, the app uses **notification delegation**: when your site shows a web push notification,
Chrome hands it to this app, and Android shows it as a native notification (your app icon and name, its own channel,
tap opens the app). `POST_NOTIFICATIONS` is declared, so Android 13+ asks the user once, with the system prompt.

1. Generate VAPID keys once: `npx web-push generate-vapid-keys`
2. Put `wybuild-push.js` and `sw.js` from this folder at your site root.
3. Add `<script src="/wybuild-push.js" defer></script>` and call, from a button the user taps:
   `WyBuildPush.enable({ vapidPublicKey: '<PUBLIC KEY>', endpoint: '/api/push/subscribe' })`
4. On your server store the posted `subscription`, then send with the `web-push` library:
   `webpush.sendNotification(subscription, JSON.stringify({ title, body, url: '/orders/42', tag: 'order-42' }), { TTL: 86400 })`

Needs: the site verified for this app (see below), HTTPS, and a service worker.
Use `tag` to replace instead of stack, and `url` to deep-link inside the app.

## Fullscreen
Display mode in this build: `%(display)s`. App shell: `%(shell)s`.
%(shell_doc)s

## Others
Camera, microphone and location are declared with optional hardware so Google Play does not hide your app
from phones without them. The website still asks the user at the moment it uses them.
""" % {"pkg": pkg, "host": host, "display": cfg.get("display", "standalone"), "shell": "standalone (native WebView)" if standalone else "Trusted Web Activity",
       "shell_doc": (
           "The site runs inside the app itself, so no address bar or Chrome toolbar can ever appear, and nothing has to be published on your site.\n"
           "`fullscreen` also hides the status bar and navigation bar (swipe from an edge to peek; they hide again by themselves).\n\n"
           "Your page can call the native app through `window.WyBuildNative` (check `WyBuildNative.isApp()`): `notify(title, body, url)`, "
           "`share(title, text, url)`, `openExternal(url)`, `vibrate(ms)`. `wybuild-push.js` wraps notify as `WyBuildPush.notify(...)`.\n"
           "Remote push messages need a push service (Firebase Cloud Messaging) that a plain WebView cannot receive; use the Trusted Web Activity shell if you rely on Web Push."
           if standalone else
           "The status bar and navigation bar are hidden by Android itself.\n"
           "The browser address bar stays away only while Android can verify that your site trusts this app: publish\n"
           "`assetlinks.json` (in this artifact) at `https://%s/.well-known/assetlinks.json` with no redirect.\n"
           "If the app was installed from Google Play, also add the Play app-signing SHA-256 in WyBuild." % host)})

# ---------------------------------------------------------------- 7. link handling kit (ships in the build artifact)
def js_rule(r):
    if r.get("kind") == "scheme":
        return {"k": "s", "s": r["scheme"], "m": r["mode"]}
    return {"k": "h", "h": r["host"], "w": bool(r.get("wildcard")), "p": r.get("path", ""), "m": r["mode"]}

own = [own_host] if own_host else []
for o in cfg.get("additionalTrustedOrigins", []):
    h = re.sub(r"^https?://", "", str(o)).strip("/").split(":")[0].lower()
    if h and h not in own:
        own.append(h)
open(kit + "/wybuild-links.json", "w", encoding="utf8").write(json.dumps({"ownHosts": own, "rules": link_rules}, indent=2))
links_js = r"""/*! WyBuild link handling. Add to your website: <script src="/wybuild-links.js" defer></script>
 * Decides what happens when a link is tapped inside the Android app (and the installed PWA):
 *   internal  stays in the app            external  opens in the phone's browser
 *   other     handed to Android (dialer, mail, WhatsApp, Maps ...)
 * Links on your own site always stay internal. The first matching rule wins. "*.domain" covers the domain and its
 * subdomains. Plain browsers are left alone.
 * Generated from the rules in WyBuild: rebuild to change them (wybuild-links.json lists them).
 */
(function () {
  var OWN = __OWN__;
  var RULES = __RULES__;
  var KEY = 'wybuild_in_app';
  var nativeOpen = window.open;
  function norm(h) { return String(h || '').toLowerCase().replace(/^www\./, ''); }
  function inApp() {
    try {
      if (window.WyBuildNative || /WyBuildApp\//.test(navigator.userAgent)) return true;
      if (document.referrer && document.referrer.indexOf('android-app://') === 0) localStorage.setItem(KEY, '1');
      if (localStorage.getItem(KEY) === '1') return true;
    } catch (e) {}
    return !!(window.matchMedia && (matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: fullscreen)').matches || matchMedia('(display-mode: minimal-ui)').matches));
  }
  function parse(url) { try { return new URL(String(url), location.href); } catch (e) { return null; } }
  function resolve(url) {
    var u = parse(url); if (!u) return null;
    var scheme = u.protocol.replace(':', '').toLowerCase();
    var web = scheme === 'http' || scheme === 'https';
    var h = norm(u.hostname);
    for (var i = 0; i < RULES.length; i++) {
      var r = RULES[i];
      if (r.k === 's') { if (!web && r.s === scheme) return r.m; continue; }
      if (!web) continue;
      var rh = norm(r.h);
      var hostOk = h === rh || (r.w && h.slice(-(rh.length + 1)) === '.' + rh);
      if (hostOk && (!r.p || u.pathname.indexOf(r.p) === 0)) return r.m;
    }
    if (web && OWN.indexOf(h) !== -1) return 'internal';
    return null;
  }
  function viaAndroid(u) {
    return 'intent://' + u.host + u.pathname + u.search + u.hash + '#Intent;scheme=' + u.protocol.replace(':', '') +
      ';action=android.intent.action.VIEW;category=android.intent.category.BROWSABLE;end';
  }
  function go(url, mode) {
    var u = parse(url); if (!u) return;
    var web = u.protocol === 'http:' || u.protocol === 'https:';
    if (mode === 'internal') { location.assign(u.href); return; }
    if (!inApp()) { if (web) nativeOpen.call(window, u.href, '_blank', 'noopener'); else location.href = u.href; return; }
    location.href = web ? viaAndroid(u) : u.href;
  }
  document.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button > 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a || a.hasAttribute('download')) return;
    var mode = resolve(a.href); if (!mode) return;
    var t = a.getAttribute('target');
    if (mode === 'internal') {
      if (t && t !== '_self' && inApp()) { e.preventDefault(); location.assign(a.href); }  // no stray blank tab for your own pages
      return;
    }
    if (mode === 'other' && !inApp() && !(t && t !== '_self')) return;  // in a browser tab tel:, mailto: etc. already behave normally
    e.preventDefault();
    go(a.href, mode);
  }, true);
  window.open = function (url) {
    if (url) {
      var mode = resolve(url);
      if (mode === 'external' || mode === 'other') { go(url, mode); return null; }
      if (mode === 'internal' && inApp()) { location.assign(String(url)); return null; }
    }
    return nativeOpen.apply(window, arguments);
  };
  window.WyBuildLinks = { rules: RULES, ownHosts: OWN, isApp: inApp, resolve: resolve, open: function (url) { go(url, resolve(url) || 'internal'); } };
})();
"""
open(kit + "/wybuild-links.js", "w", encoding="utf8").write(
    links_js.replace("__OWN__", json.dumps(own)).replace("__RULES__", json.dumps([js_rule(r) for r in link_rules]))
)
doc = "\n## Link handling\n"
if link_rules:
    doc += "Rules in this build (first match wins; your own site always stays internal; `*.domain` covers the domain and its subdomains):\n\n"
    for r in link_rules:
        who = r["scheme"] + ":" if r.get("kind") == "scheme" else ("*." if r.get("wildcard") else "") + r["host"] + r.get("path", "")
        doc += "- `%s` -> **%s**\n" % (who, {"internal": "internal (stays in the app)", "external": "external (phone browser)", "other": "other (handed to Android)"}[r["mode"]])
    doc += "\n"
else:
    doc += ("No link rules were set: your site stays in the app and other websites open in the phone's browser.\n\n" if standalone else
            "No link rules were set, so links behave like a normal Trusted Web Activity: your site stays in the app, other sites open in an in-app browser tab.\n\n")
if standalone:
    doc += (
        "This app uses the standalone shell, so these rules are enforced **inside the app itself**: no script on your site is needed and no address bar can appear.\n"
        "Anything with no matching rule: your own site (and any internal domain) stays in the app, other websites open in the phone's browser, "
        "and tel:, mailto:, WhatsApp, Maps etc. are handed to Android.\n"
        "Sign-in providers (for example `accounts.google.com`) that must stay in the app need an **internal** rule.\n"
    )
else:
  doc += (
    "- **Internal** domains are added as trusted origins and as verified app links, so tapping a link to them anywhere on the phone opens this app.\n"
    "  Publish `assetlinks.json` (in this artifact) at `/.well-known/assetlinks.json` on **every** internal domain, with no redirect.\n"
    "- **External** and **Other** rules are applied by `wybuild-links.js`: put it at your site root and add\n"
    "  `<script src=\"/wybuild-links.js\" defer></script>` to every page. A Trusted Web Activity cannot intercept those taps natively.\n"
    "  Without the script, those links open in Chrome's in-app tab (external sites) or are handled by Chrome (tel:, mailto:).\n"
    "- `WyBuildLinks.open(url)` applies the same rules from your own JavaScript.\n"
)
open(kit + "/NATIVE-FEATURES.md", "a", encoding="utf8").write(doc)

# ---------------------------------------------------------------- 8. native bridge kit (ships in the build artifact)
if standalone:
    open(kit + "/wybuild-native.js", "w", encoding="utf8").write(r"""/*! WyBuild native helper. Add to your website: <script src="/wybuild-native.js" defer></script>
 * Inside the Android app each call uses the real Android feature. In a normal browser it falls back to the web API
 * where one exists, or rejects with code "unsupported", so one codebase serves both.
 *
 *   WyBuild.isApp()   WyBuild.has('biometric')   await WyBuild.device()
 *   WyBuild.clipboard.write(text) / .read()      WyBuild.haptic('tick'|'click'|'heavy'|'success'|'error')
 *   WyBuild.keepAwake(true)   WyBuild.secureScreen(true)   WyBuild.orientation('portrait'|'landscape'|'auto')
 *   WyBuild.biometric.status()  /  .authenticate({ title, subtitle })   // local unlock only, NOT proof of identity to your server
 *   WyBuild.speech.listen({ lang })  /  .speak(text, { lang })  /  .stop()
 *   WyBuild.contacts.pick()              // one contact the user taps; no contacts permission needed
 *   WyBuild.calendar.add({ title, description, location, start, end })   // start/end: Date or ms
 *   WyBuild.shortcuts.set([{ id, label, url }])                          // long-press the app icon; own pages only, max 4
 *   WyBuild.reminders.schedule({ id, title, body, url, at }) / .cancel(id)   // needs the Reminders feature; lost on phone restart
 *   WyBuild.files.save(name, mime, blobOrBase64)                          // into Downloads
 *   WyBuild.share.onReceive(fn)          // text shared to your app from other apps (needs the Share target feature)
 *   WyBuild.rate()   WyBuild.openSettings()   WyBuild.on('network'|'lifecycle', fn)
 */
(function () {
  var N = window.WyBuildNative;
  var pending = {}, seq = 0;
  function fail(code) { var e = new Error(code); e.code = code; return Promise.reject(e); }
  function inApp() { return !!(N && N.isApp && N.isApp()); }
  function feats() { try { return inApp() ? JSON.parse(N.features() || '[]') : []; } catch (e) { return []; } }
  window.addEventListener('wybuild:result', function (ev) {
    var d = ev.detail || {}, p = pending[d.id];
    if (!p) return;
    delete pending[d.id];
    if (d.ok) p.resolve(d); else { var e = new Error(d.error || 'failed'); e.code = d.error || 'failed'; p.reject(e); }
  });
  function ask(fn) {
    return new Promise(function (resolve, reject) {
      var id = 'r' + (++seq) + '_' + Date.now();
      pending[id] = { resolve: resolve, reject: reject };
      try { fn(id); } catch (e) { delete pending[id]; reject(e); }
    });
  }
  function ms(v) { return v instanceof Date ? v.getTime() : Number(v) || 0; }
  function toBase64(x) {
    if (typeof x === 'string') return Promise.resolve(x);
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(String(r.result)); };
      r.onerror = function () { reject(new Error('read failed')); };
      r.readAsDataURL(x);
    });
  }
  var W = window.WyBuild = {
    isApp: inApp,
    features: feats,
    has: function (n) { return feats().indexOf(n) !== -1; },
    device: function () { return Promise.resolve(inApp() ? JSON.parse(N.deviceInfo() || '{}') : { platform: 'web', online: navigator.onLine }); },
    on: function (name, fn) { window.addEventListener('wybuild:' + name, function (e) { fn(e.detail); }); },
    clipboard: {
      write: function (t) { if (inApp()) { N.copyText(String(t)); return Promise.resolve(); } return navigator.clipboard ? navigator.clipboard.writeText(String(t)) : fail('unsupported'); },
      read: function () { return inApp() ? ask(function (id) { N.readClipboard(id); }).then(function (d) { return d.text; }) : (navigator.clipboard && navigator.clipboard.readText ? navigator.clipboard.readText() : fail('unsupported')); }
    },
    haptic: function (k) { if (inApp()) N.haptic(k || 'click'); else if (navigator.vibrate) navigator.vibrate(k === 'heavy' ? 40 : 15); },
    keepAwake: function (on) { if (inApp()) N.keepAwake(!!on); },
    secureScreen: function (on) { if (inApp()) N.setSecure(!!on); },
    orientation: function (m) { if (inApp()) N.setOrientation(m || 'auto'); },
    rate: function () { if (inApp()) N.rateApp(); },
    openSettings: function () { if (inApp()) N.openAppSettings(); },
    biometric: {
      status: function () { return Promise.resolve(inApp() ? N.biometricStatus() : 'unsupported'); },
      authenticate: function (o) { o = o || {}; return inApp() ? ask(function (id) { N.biometricAuth(id, o.title || '', o.subtitle || ''); }).then(function () { return true; }) : fail('unsupported'); }
    },
    speech: {
      listen: function (o) { return inApp() ? ask(function (id) { N.listen(id, (o && o.lang) || ''); }) : fail('unsupported'); },
      speak: function (t, o) { if (inApp()) N.speak(String(t), (o && o.lang) || ''); else if (window.speechSynthesis) speechSynthesis.speak(new SpeechSynthesisUtterance(String(t))); },
      stop: function () { if (inApp()) N.stopSpeaking(); else if (window.speechSynthesis) speechSynthesis.cancel(); }
    },
    contacts: { pick: function () { return inApp() ? ask(function (id) { N.pickContact(id); }) : fail('unsupported'); } },
    calendar: { add: function (e) { if (!inApp()) return fail('unsupported'); N.addToCalendar(e.title || '', e.description || '', e.location || '', ms(e.start), ms(e.end)); return Promise.resolve(); } },
    shortcuts: { set: function (list) { if (inApp()) N.setShortcuts(JSON.stringify(list || [])); } },
    reminders: {
      schedule: function (r) { return inApp() ? ask(function (id) { N.scheduleReminder(String(r.id || id), r.title || '', r.body || '', r.url || '/', ms(r.at)); }) : fail('unsupported'); },
      cancel: function (id) { if (inApp()) N.cancelReminder(String(id)); }
    },
    files: { save: function (name, mime, data) { return inApp() ? toBase64(data).then(function (b) { return ask(function (id) { N.saveFile(id, name, mime || '', b); }); }) : fail('unsupported'); } },
    share: {
      onReceive: function (fn) {
        function take() { try { var t = N.takeSharedContent(); if (t) fn(JSON.parse(t)); } catch (e) {} }
        if (!inApp()) return;
        take();
        window.addEventListener('wybuild:share', take);
      }
    }
  };
})();
""")
    open(kit + "/NATIVE-FEATURES.md", "a", encoding="utf8").write("""
## Native bridge (`wybuild-native.js`)
This build includes: %s.
Put `wybuild-native.js` from this folder at your site root and add `<script src="/wybuild-native.js" defer></script>`.
The bridge answers only pages served from your own site (and domains you set to Internal), never third-party frames or sign-in pages.

### Google Play and other stores: what actually counts
Stores do not look for a feature list in the manifest. Google Play's *Minimum functionality* and *Spam* policies are judged by a
reviewer using the app: it must offer value beyond opening a website, and the permissions it declares must be used.
- Wire the bridge into screens users really use (biometric unlock on a private area, share-to-app, reminders, saving files, voice input, calendar add).
- Do not declare or enable features you do not use: unused permissions are a common rejection reason.
- Wrapping a site you do not own or control is rejected under the *Spam and Minimum Functionality* policy regardless of features.
- Biometric success is a local unlock gate. Never treat it as proof of identity to your server.
""" % ", ".join(native_features))
    open(out + "/dist/NATIVE-BRIDGE.txt", "w", encoding="utf8").write("\n".join(native_features) + "\n")

# ---------------------------------------------------------------- summary
print("Android features applied:", ", ".join(applied) or "none")
summary = os.environ.get("GITHUB_STEP_SUMMARY")
if summary:
    with open(summary, "a") as f:
        f.write("### Android features baked into this build\n- " + ("\n- ".join(applied) or "none") + "\n")
        for n in notes:
            f.write("\n> " + n + "\n")
