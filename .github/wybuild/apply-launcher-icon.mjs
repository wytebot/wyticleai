import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const sharp = require(path.join(process.env.WB_TOOLS || path.resolve('.wybuild-tools'), 'icon', 'node_modules', 'sharp'));

const project = process.env.WB_OUT ? path.join(process.env.WB_OUT, 'project') : path.resolve('.wybuild-out/project');
const cfg = JSON.parse(process.env.TWA_CONFIG || '{}');
const manifestPath = process.env.WB_OUT ? path.join(process.env.WB_OUT, 'twa-resolved.json') : path.resolve('.wybuild-out/twa-resolved.json');
let resolved = {};
try { resolved = JSON.parse(await fs.readFile(manifestPath, 'utf8')); } catch {}
const iconUrl = cfg.iconUrl || resolved.iconUrl;
const maskUrl = cfg.maskableIconUrl || resolved.maskableIconUrl;
const background = /^#[0-9a-f]{6}$/i.test(cfg.backgroundColor || resolved.backgroundColor || '') ? (cfg.backgroundColor || resolved.backgroundColor) : '#ffffff';
if (!iconUrl && !maskUrl) throw new Error('No app icon URL was supplied by WyBuild or detected from the web manifest.');
async function fetchImage(url) {
  if (!url) return null;
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok) throw new Error(`Icon download failed (${r.status}): ${url}`);
  const b = Buffer.from(await r.arrayBuffer());
  const meta = await sharp(b).metadata();
  if (!meta.width || !meta.height) throw new Error(`Invalid icon image: ${url}`);
  return { bytes: b, width: meta.width, height: meta.height };
}
const [regular, maskable] = await Promise.all([fetchImage(iconUrl).catch(e => { console.warn(e.message); return null; }), fetchImage(maskUrl).catch(e => { console.warn(e.message); return null; })]);
const chosen = maskable && (!regular || maskable.width >= regular.width) ? maskable : (regular || maskable);
if (!chosen) throw new Error('WyBuild could not download a valid app icon; refusing to silently ship a generic launcher icon.');
const res = path.join(project, 'app', 'src', 'main', 'res');
await fs.access(res);
const opaque = (await sharp(chosen.bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true })).data[3] > 200;
const fgScale = opaque ? 0.80 : 0.62;
const densities = { mdpi: [48,108], hdpi: [72,162], xhdpi: [96,216], xxhdpi: [144,324], xxxhdpi: [192,432] };
for (const dirName of await fs.readdir(res)) {
  if (!dirName.startsWith('mipmap-')) continue;
  const dir = path.join(res, dirName);
  for (const f of await fs.readdir(dir)) if (/^ic_launcher(?:_round)?\.(?:png|webp|xml)$/.test(f)) await fs.rm(path.join(dir, f), { force: true });
}
for (const [density, [legacy, fg]] of Object.entries(densities)) {
  const dir = path.join(res, `mipmap-${density}`);
  await fs.mkdir(dir, { recursive: true });
  const square = await sharp((regular || chosen).bytes).resize(legacy, legacy, { fit: 'cover' }).png().toBuffer();
  await fs.writeFile(path.join(dir, 'ic_launcher.png'), square);
  const circle = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${legacy}" height="${legacy}"><circle cx="${legacy/2}" cy="${legacy/2}" r="${legacy/2}"/></svg>`);
  await fs.writeFile(path.join(dir, 'ic_launcher_round.png'), await sharp(square).composite([{ input: circle, blend: 'dest-in' }]).png().toBuffer());
  const inner = Math.round(fg * fgScale);
  const layer = await sharp({ create: { width: fg, height: fg, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite([{ input: await sharp(chosen.bytes).resize(inner, inner, { fit: 'contain' }).png().toBuffer(), gravity: 'center' }]).png().toBuffer();
  await fs.writeFile(path.join(dir, 'wybuild_icon_fg.png'), layer);
}
const adaptive = '<?xml version="1.0" encoding="utf-8"?>\n<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n  <background android:drawable="@color/wybuild_icon_bg"/>\n  <foreground android:drawable="@mipmap/wybuild_icon_fg"/>\n</adaptive-icon>\n';
const v26 = path.join(res, 'mipmap-anydpi-v26');
await fs.mkdir(v26, { recursive: true });
await fs.writeFile(path.join(v26, 'ic_launcher.xml'), adaptive);
await fs.writeFile(path.join(v26, 'ic_launcher_round.xml'), adaptive);
const values = path.join(res, 'values');
await fs.mkdir(values, { recursive: true });
await fs.writeFile(path.join(values, 'wybuild_icon.xml'), `<?xml version="1.0" encoding="utf-8"?>\n<resources><color name="wybuild_icon_bg">${background}</color></resources>\n`);
console.log(`WYBUILD_ICON_APPLIED=true source=${maskable ? maskUrl : iconUrl}; project=${project}`);
