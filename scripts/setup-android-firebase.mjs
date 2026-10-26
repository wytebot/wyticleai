import fs from 'node:fs';
import path from 'node:path';
const root = process.cwd();
const android = path.join(root, 'android');
const source = path.join(root, 'android-setup', 'google-services.json');
const appDir = path.join(android, 'app');
const appGradle = path.join(appDir, 'build.gradle');
const manifestPath = path.join(appDir, 'src', 'main', 'AndroidManifest.xml');
const capacitorConfigPath = path.join(root, 'capacitor.config.json');
const rootGradle = path.join(android, 'build.gradle');
if (!fs.existsSync(source)) throw new Error('Missing android-setup/google-services.json.');
const firebaseConfig = JSON.parse(fs.readFileSync(source, 'utf8'));
const capacitorConfig = JSON.parse(fs.readFileSync(capacitorConfigPath, 'utf8'));
const firebasePackage = firebaseConfig.client?.[0]?.client_info?.android_client_info?.package_name;
if (firebasePackage && firebasePackage !== capacitorConfig.appId) throw new Error(`Firebase package ${firebasePackage} does not match capacitor.config.json appId ${capacitorConfig.appId}. Register the matching Android app in Firebase and download its google-services.json.`);
if (!fs.existsSync(appDir)) throw new Error('Android platform is missing. Run `npx cap add android` first.');
if (!(firebaseConfig.client?.[0]?.oauth_client || []).length) console.warn('Warning: this google-services.json has no OAuth client entries. Google sign-in may fail until you add SHA fingerprints, enable the Google provider, and download a fresh config from Firebase.');
fs.copyFileSync(source, path.join(appDir, 'google-services.json'));
function addPlugin(file, pluginId, version, isApp = false) {
  if (!fs.existsSync(file)) throw new Error(`Missing Gradle file: ${path.relative(root, file)}`);
  let text = fs.readFileSync(file, 'utf8');
  if (text.includes('com.google.gms.google-services') || text.includes('com.google.gms:google-services')) return;
  if (/plugins\s*\{/.test(text)) {
    text = text.replace(/plugins\s*\{/, match => `${match}\n    id '${pluginId}'${version ? ` version '${version}'${isApp ? '' : ' apply false'}` : ''}`);
  } else if (!isApp) {
    if (/buildscript\s*\{[\s\S]*?dependencies\s*\{/.test(text)) text = text.replace(/(buildscript\s*\{[\s\S]*?dependencies\s*\{)/, `$1\n        classpath '${pluginId}:${version}'`);
    else text = `buildscript { repositories { google(); mavenCentral() }; dependencies { classpath '${pluginId}:${version}' } }\n${text}`;
  } else text += `\napply plugin: '${pluginId}'\n`;
  fs.writeFileSync(file, text);
}
addPlugin(rootGradle, 'com.google.gms.google-services', '4.4.2', false);
addPlugin(appGradle, 'com.google.gms.google-services', null, true);
if (fs.existsSync(manifestPath)) {
  let manifest = fs.readFileSync(manifestPath, 'utf8');
  const scheme = 'ai.wryte.app';
  if (!manifest.includes(`android:scheme=\"${scheme}\" android:host=\"auth-callback\"`)) {
    const activity = /<activity\b(?=[^>]*android:name=\"[^\"]*MainActivity\")[^>]*>[\s\S]*?<\/activity>/;
    const match = manifest.match(activity);
    if (match) {
      const filter = `\n            <intent-filter>\n                <action android:name=\"android.intent.action.VIEW\" />\n                <category android:name=\"android.intent.category.DEFAULT\" />\n                <category android:name=\"android.intent.category.BROWSABLE\" />\n                <data android:scheme=\"${scheme}\" android:host=\"auth-callback\" />\n            </intent-filter>\n        `;
      manifest = manifest.replace(activity, match[0].replace('</activity>', `${filter}</activity>`));
      fs.writeFileSync(manifestPath, manifest);
    } else console.warn('Could not locate MainActivity in AndroidManifest.xml; add the deep-link intent filter manually from android-setup/AndroidManifest-intent-filter.xml.');
  }
}
console.log('Firebase Android config copied, Google Services Gradle plugin configured, and OAuth return deep link prepared.');
console.log('Next: add SHA-1/SHA-256 signing fingerprints in Firebase, enable Google sign-in, then refresh google-services.json if Firebase updates OAuth client entries.');
