# Releasing the POS Android app

The APK is a Capacitor wrapper around the root web files. Releases are built by GitHub Actions and published as **GitHub Releases**. The login page link and the in-app update prompt both read the newest release, so there is nothing else to edit.

## One-time setup (signing key)
Android only installs an update if it is signed with the same key as the installed app, so releases use a fixed keystore.
Repo → Settings → Secrets and variables → Actions → New repository secret, add all four:

| Secret | Value |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | contents of `pos-release.jks.b64` |
| `ANDROID_KEYSTORE_PASSWORD` | store password |
| `ANDROID_KEY_ALIAS` | `pos` |
| `ANDROID_KEY_PASSWORD` | key password |

**Back up `pos-release.jks` somewhere safe (never commit it).** If it is lost, existing users must uninstall and reinstall to get future updates.

## Releasing an update
1. Commit and push your changes to `main` (Cloudflare Pages redeploys the web app; deploy `worker.js` / run D1 migrations as before).
2. Tag a new version and push the tag:
   ```
   git tag v1.0.1
   git push origin v1.0.1
   ```
   (or Actions → *Release Android APK* → Run workflow → enter `1.0.1`)
3. About 5 minutes later the Release `v1.0.1` appears with `pos.apk`.

Versions must increase (`1.0.1` → `1.0.2` → `1.1.0`); the Android versionCode is derived from the number.

## What users see
- **Login page (browser):** "Download Android app (v1.0.1)" → always the newest `pos.apk`. Hidden inside the app itself.
- **Installed app:** on launch and when reopened (at most every 10 min) it checks the newest release; if it is newer, a sheet says "Update available" → *Download update* opens the APK, tap it to install over the old app. *Later* asks again after 24h.
- First install: allow "install unknown apps" for the browser.

## Notes
- Existing users who installed an old **debug** APK must uninstall once and install the first signed release (different signing key). After that, updates install in place.
- Printing: `window.print()` does nothing inside an Android WebView; add a print plugin if needed.
- Offline scope, session and clock notes are unchanged: billing + receipts work offline; voids, edits, reports, signup, OTP and first login need internet.
- Local build: Node 20, JDK 17; in `android-app/`: `npm install && npm run prepare-web && npx cap add android && npx cap sync android`, then set the `KEYSTORE_*`/`KEY_*`/`VERSION_NAME` env vars, run `node patch-android.js` and `cd android && ./gradlew assembleRelease`.
