import fs from 'node:fs/promises';
import crypto from 'node:crypto';

const out = process.env.WB_OUT || `${process.cwd()}/.wybuild-out`;
const raw = JSON.parse(process.env.TWA_CONFIG || '{}');
if (!raw.webUrl) throw new Error('Web app URL is missing.');
await fs.mkdir(out, { recursive: true });

const pageUrl = new URL(raw.webUrl);
if (pageUrl.protocol !== 'https:') throw new Error('Web app URL must use HTTPS.');

const page = await fetch(pageUrl, { redirect: 'follow' });
if (!page.ok) throw new Error(`Web app returned HTTP ${page.status}.`);
const html = await page.text();
const manifestTag = html.match(/<link[^>]+rel=["'][^"']*manifest[^"']*["'][^>]+href=["']([^"']+)["']/i) || html.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["'][^"']*manifest[^"']*["']/i);
const manifestUrl = raw.webManifestUrl || (manifestTag ? new URL(manifestTag[1], page.url || pageUrl).href : '');
if (!manifestUrl) throw new Error('No Web App Manifest was found. A quality TWA needs a valid manifest.');
const manifestParsed = new URL(manifestUrl);
if (manifestParsed.protocol !== 'https:') throw new Error('Web App Manifest URL must use HTTPS.');
const mr = await fetch(manifestParsed, { redirect: 'follow', headers: { Accept: 'application/manifest+json,application/json' } });
if (!mr.ok) throw new Error(`Web App Manifest returned HTTP ${mr.status}.`);
const web = await mr.json();

const abs = v => v ? new URL(v, manifestUrl).href : '';
const icons = Array.isArray(web.icons) ? web.icons : [];
const size = i => Math.max(...String(i?.sizes || '').split(/\s+/).map(x => Number.parseInt(x, 10) || 0), 0);
const best = [...icons].filter(i => !String(i.purpose || '').includes('maskable')).sort((a,b) => size(b)-size(a))[0] || [...icons].sort((a,b)=>size(b)-size(a))[0];
const maskable = icons.find(i => String(i.purpose || '').includes('maskable'));
const mono = icons.find(i => String(i.purpose || '').includes('monochrome'));
if (!best?.src || size(best) < 192) throw new Error('The web manifest needs an app icon. Add a PNG icon of at least 192px; 512px is recommended.');

const host = new URL(page.url || pageUrl).hostname.replace(/^www\./, '').toLowerCase();
const HOST_PLATFORMS = ['vercel.app','netlify.app','pages.dev','github.io','web.app','firebaseapp.com','onrender.com','herokuapp.com','fly.dev','railway.app','surge.sh','workers.dev','glitch.me','repl.co','replit.app','azurewebsites.net','framer.app','webflow.io','wixsite.com','blogspot.com'];
const cleanSeg = x => String(x).toLowerCase().replace(/[^a-z0-9]/g, '');
const platform = HOST_PLATFORMS.find(p => host.endsWith('.' + p));
// Free hosts: app.<name>.<platform> (Google Play accepts app.wybuildblack.vercel, not app.vercel.wybuildblack); owned domains: reverse-DNS
const generatedPackage = (platform
  ? ['app', cleanSeg(host.slice(0, -(platform.length + 1)).split('.').join('')), cleanSeg(platform.split('.')[0])]
  : host.split('.').reverse().map(cleanSeg)
).filter(Boolean).map(x => /^[a-z]/.test(x) ? x : `a${x}`).join('.');
const packageId = raw.packageId || generatedPackage;
if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(packageId)) throw new Error(`Could not generate a valid free package ID from ${host}.`);

const start = new URL(raw.startUrl || web.start_url || '/', manifestParsed);
if (start.protocol !== 'https:' || start.hostname.replace(/^www\./, '').toLowerCase() !== host) throw new Error('start_url must remain on the same HTTPS site as the wrapped web app.');
const display = ['standalone','fullscreen','minimal-ui','fullscreen-sticky'].includes(raw.display || web.display) ? (raw.display || web.display) : 'standalone';
const orientation = ['default','portrait','landscape'].includes(raw.orientation || web.orientation) ? (raw.orientation || web.orientation) : 'default';
const themeColor = /^#[0-9a-f]{6}$/i.test(raw.themeColor || web.theme_color || '') ? (raw.themeColor || web.theme_color) : '#FFFFFF';
const backgroundColor = /^#[0-9a-f]{6}$/i.test(raw.backgroundColor || web.background_color || '') ? (raw.backgroundColor || web.background_color) : '#FFFFFF';
const shortcuts = Array.isArray(web.shortcuts) ? web.shortcuts.slice(0,4).filter(s => s?.name && s?.url).map(s => ({ name: s.name, shortName: (s.short_name || s.name).slice(0,12), url: new URL(s.url, manifestUrl).pathname + new URL(s.url, manifestUrl).search, chosenIconUrl: s.icons?.[0]?.src ? abs(s.icons[0].src) : undefined })) : [];
// Link handling rules (already validated by the WyBuild API; re-parsed here so a hand-edited config cannot break the build)
const linkRules = [];
for (const r of Array.isArray(raw.linkRules) ? raw.linkRules.slice(0, 30) : []) {
  const mode = ['internal', 'external', 'other'].includes(r?.mode) ? r.mode : '';
  const orig = String(r?.pattern || '').trim();
  const t = orig.toLowerCase();
  if (!mode || !t) continue;
  const bare = t.replace(/:\/\/$/, ':').replace(/:$/, '');
  if (!/[/.]/.test(bare) && /^[a-z][a-z0-9+.-]*$/.test(bare)) {
    if (mode === 'other' && !['http', 'https', 'javascript', 'data', 'file', 'blob', 'about', 'vbscript', 'content', 'intent'].includes(bare)) linkRules.push({ kind: 'scheme', scheme: bare, mode });
    continue;
  }
  const rest = orig.replace(/^https?:\/\//i, '');
  const slash = rest.indexOf('/');
  const h = (slash === -1 ? rest : rest.slice(0, slash)).toLowerCase();
  let path = slash === -1 ? '' : rest.slice(slash).replace(/[?#].*$/, '').replace(/\*+$/, '');
  if (path === '/') path = '';
  if (!/^(\*\.)?([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(h) || (path && !/^\/[A-Za-z0-9\-._~%/]*$/.test(path))) continue;
  linkRules.push({ kind: 'host', host: h.replace(/^\*\./, ''), wildcard: h.startsWith('*.'), path, mode });
}
// A custom domain set to "internal" must be a trusted origin too, or Chrome shows the address bar over it.
// (Wildcards cannot be trusted origins: list each subdomain you want fullscreen.)
const trusted = new Set((Array.isArray(raw.additionalTrustedOrigins) ? raw.additionalTrustedOrigins : []).map(String));
for (const r of linkRules) if (r.kind === 'host' && r.mode === 'internal' && !r.wildcard && r.host.replace(/^www\./, '') !== host) trusted.add(`https://${r.host}`);
const features = {};
if (raw.locationDelegation) features.locationDelegation = { enabled: true };
if (raw.playBilling) features.playBilling = { enabled: true };
const perms = Array.isArray(raw.androidPermissions) ? raw.androidPermissions : [];
// Google Play rejects any upload whose versionCode is not higher than every code it has seen for this package
// (including ones from earlier tools or deleted drafts). So the code is the HIGHEST of:
//   - the minimum you set in WyBuild (raw.versionCode), 
//   - the CI run number, 
//   - minutes since the Unix epoch (~29 million today; always rising, far above any hand-picked code).
// Android's ceiling is 2,100,000,000, which minutes-since-epoch will not reach for thousands of years.
const minutesNow = Math.floor(Date.now() / 60000);
const versionCode = Math.min(2100000000, Math.max(Number(raw.versionCode) || 0, Number(process.env.GITHUB_RUN_NUMBER) || 0, minutesNow));
const json = {
  packageId,
  host: new URL(page.url || pageUrl).host,
  name: String(raw.name || web.name || web.short_name || host).slice(0,50),
  launcherName: String(raw.launcherName || web.short_name || web.name || host).slice(0,12),
  display,
  themeColor,
  themeColorDark: themeColor,
  navigationColor: /^#[0-9a-f]{6}$/i.test(raw.navigationColor || '') ? raw.navigationColor : themeColor,
  backgroundColor,
  enableNotifications: raw.enableNotifications !== false,
  enableSiteSettingsShortcut: raw.enableSiteSettingsShortcut !== false,
  startUrl: start.pathname + start.search,
  iconUrl: abs(raw.iconUrl || best.src),
  maskableIconUrl: abs(raw.maskableIconUrl || maskable?.src),
  monochromeIconUrl: abs(raw.monochromeIconUrl || mono?.src),
  appVersionCode: versionCode,
  appVersion: String(raw.versionName || '1.0.0'),
  splashScreenFadeOutDuration: 300,
  signingKey: { path: `${out}/wybuild-release.jks`, alias: process.env.WB_KEY_ALIAS || process.env.WB_KEY_ALIAS_SECRET || 'wybuild' },
  shortcuts,
  webManifestUrl: manifestUrl,
  // Standalone must never fall back to a browser Custom Tab. Bubblewrap accepts only
  // 'customtabs' or 'webview'; use WebView as the safety fallback, while TWA keeps Custom Tabs.
  fallbackType: raw.shell === 'twa' ? 'customtabs' : 'webview',
  features,
  minSdkVersion: Math.max(24, Number(raw.minSdkVersion) || 24), // androidbrowserhelper 2.7.x needs 24
  orientation,
  additionalTrustedOrigins: [...trusted],
  fingerprints: raw.expectedFingerprint ? [{ value: String(raw.expectedFingerprint).replace(/:/g,'').toUpperCase() }] : [],
  fileHandlers: web.file_handlers || [],
  protocolHandlers: web.protocol_handlers || [],
  launchHandlerClientMode: web.launch_handler?.client_mode || '',
  generatorApp: 'WyBuild',
  androidPermissions: perms,
};
// WyBuild-only options (not Bubblewrap manifest fields): applied by the "Apply manual Android features" step
const extras = {
  // "standalone" = WyBuild's native shell (never an address bar); "twa" = plain Trusted Web Activity (needs Digital Asset Links)
  shell: raw.shell === 'twa' ? 'twa' : 'standalone',
  linkRules,
  predictiveBack: raw.predictiveBack === true,
  // opt-in native bridge features (the always-on set is defined in twa-native.py)
  nativeFeatures: (Array.isArray(raw.nativeFeatures) ? raw.nativeFeatures : []).filter(f => ['biometric', 'sharetarget', 'reminders'].includes(f)),
  playSigningFingerprint: /^([0-9A-Fa-f]{2}:?){32}$/.test(String(raw.playSigningFingerprint || '')) ? String(raw.playSigningFingerprint).replace(/:/g, '').toUpperCase().match(/.{2}/g).join(':') : '',
};
await fs.writeFile(`${out}/wybuild-extras.json`, JSON.stringify(extras, null, 2));
await fs.writeFile(`${out}/twa-resolved.json`, JSON.stringify(json, null, 2));
await fs.writeFile(`${out}/twa-manifest.json`, JSON.stringify(json, null, 2));
const snapshot = crypto.createHash('sha256').update(JSON.stringify({ web, json })).digest('hex');
await fs.writeFile(`${out}/snapshot.txt`, snapshot);
console.log(`WYBUILD_PACKAGE=${packageId}`);
console.log(`WYBUILD_VERSION=${json.appVersion}`);
console.log(`WYBUILD_VERSION_CODE=${json.appVersionCode}`);
console.log(`WYBUILD_WEB_MANIFEST=${manifestUrl}`);
console.log(`WYBUILD_SNAPSHOT=${snapshot}`);
console.log(`WYBUILD_SOURCE_HOST=${json.host}`);
console.log(`WYBUILD_SHELL=${extras.shell}`);
