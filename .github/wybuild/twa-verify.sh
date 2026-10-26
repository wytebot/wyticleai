#!/usr/bin/env bash
set -euo pipefail
ARTIFACT="${1:?APK or AAB path required}"
DIST="${2:?dist path required}"
STORE_READY="${3:-true}"
MODE="${4:-write}" # write = start a new report, append = add to it (used when both APK and AAB are built)
mkdir -p "$DIST"
command -v apksigner >/dev/null 2>&1 || true
if [[ "$MODE" == "write" ]]; then echo "# WyBuild Android shell readiness" > "$DIST/store-readiness.md"; echo >> "$DIST/store-readiness.md"; fi
SHELL_MODE="${WYBUILD_SHELL:-standalone}"
if [[ "$SHELL_MODE" == "twa" ]]; then SHELL_LINE="Trusted Web Activity (Chrome renders the site; needs Digital Asset Links to hide the address bar)"; else SHELL_LINE="Standalone native shell (the app renders the site itself; no address bar, no Digital Asset Links needed)"; fi
cat >> "$DIST/store-readiness.md" <<REPORT
- Artifact: \`$(basename "$ARTIFACT")\`
- Build path: Bubblewrap project
- App shell: $SHELL_LINE
REPORT
case "$ARTIFACT" in
  *.apk)
    if command -v apksigner >/dev/null 2>&1; then
      apksigner verify --verbose "$ARTIFACT" > "$DIST/apksigner.txt" 2>&1 || { echo 'APK signature verification failed.' >> "$DIST/store-readiness.md"; exit 1; }
      echo '- Android APK signature verification: passed' >> "$DIST/store-readiness.md"
    fi
    if [[ "$SHELL_MODE" != "twa" ]]; then
      # Prove the APK really contains the standalone shell (a stale workflow would silently build a plain TWA with Chrome's address bar)
      AAPT="$(command -v aapt || command -v aapt2 || true)"
      if [[ -n "$AAPT" ]]; then
        BADGING="$("$AAPT" dump badging "$ARTIFACT" 2>/dev/null || true)"
        MANIFEST_XML="$($AAPT dump xmltree "$ARTIFACT" AndroidManifest.xml 2>/dev/null || true)"
        EXPECTED="${WYBUILD_PACKAGE}.WyBuildActivity"
        if ! grep -q "launchable-activity: name='$EXPECTED'" <<<"$BADGING" || ! grep -q "WyBuildActivity" <<<"$MANIFEST_XML"; then
          echo "::error::Standalone APK still references LauncherActivity as an Android manifest component. That can open Chrome/Custom Tabs and show the URL/share toolbar. Reinstall the current WyBuild workflow and rebuild."
          echo '- App shell check: FAILED (browser launcher reference remains)' >> "$DIST/store-readiness.md"; exit 1
        fi
        if ! grep -q "uses-permission: name='android.permission.INTERNET'" <<<"$BADGING"; then
          echo "::error::The standalone APK is missing the INTERNET permission."; echo '- INTERNET permission: MISSING' >> "$DIST/store-readiness.md"; exit 1
        fi
        echo '- App shell check: passed (native shell present, no LauncherActivity launcher, INTERNET declared)' >> "$DIST/store-readiness.md"
      else
        echo '- App shell check: skipped (aapt not found)' >> "$DIST/store-readiness.md"
      fi
    fi
    if [[ "$STORE_READY" == "true" ]]; then
      unzip -p "$ARTIFACT" AndroidManifest.xml >/dev/null 2>&1 || { echo 'APK manifest could not be read.' >> "$DIST/store-readiness.md"; exit 1; }
      echo '- APK package generated successfully.' >> "$DIST/store-readiness.md"
    fi
    ;;
  *.aab)
    if [[ "$SHELL_MODE" != "twa" ]] && ! unzip -p "$ARTIFACT" base/manifest/AndroidManifest.xml 2>/dev/null | grep -aq WyBuildActivity; then
      BUNDLETOOL="$(find "${WB_TOOLS:-}" -type f -name 'bundletool*.jar' 2>/dev/null | head -1 || true)"
      if [[ -n "$BUNDLETOOL" ]]; then
        MANIFEST_DUMP="$(java -jar "$BUNDLETOOL" dump manifest --bundle "$ARTIFACT" 2>/dev/null || true)"
        if ! grep -q "${WYBUILD_PACKAGE}.WyBuildActivity" <<<"$MANIFEST_DUMP"; then
          echo "::error::This App Bundle does not expose WyBuildActivity as the standalone native shell."
          echo '- App shell check: FAILED (native launcher not found in bundle manifest)' >> "$DIST/store-readiness.md"; exit 1
        fi
      else
        echo "::warning::bundletool was not available; standalone AAB launcher verification could not decode the binary manifest."
        echo '- App shell check: warning (bundletool unavailable; binary AAB manifest not decoded)' >> "$DIST/store-readiness.md"
      fi
    fi
    jarsigner -verify "$ARTIFACT" > "$DIST/jarsigner.txt" 2>&1 || { echo 'App Bundle signature verification failed.' >> "$DIST/store-readiness.md"; exit 1; }
    echo '- Android App Bundle signature verification: passed' >> "$DIST/store-readiness.md"
    ;;
  *) echo 'Unsupported verification artifact.' >> "$DIST/store-readiness.md"; exit 1 ;;
esac
