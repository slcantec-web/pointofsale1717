# Building the POS Android app (APK)

The APK is a Capacitor wrapper around your existing root web files (the same ones Cloudflare Pages serves). The pages are bundled inside the app (so it opens offline) and talk to your live Worker at `API_BASE`.

## Order of work
1. **Database** – run `migration-add-otp-and-client-ref.sql` in the D1 Console.
2. **Worker** – already applied to `worker.js` in this repo — deploy it manually. OTP emails go through your existing `sendEmail()` (Resend or Gmail), so no new env vars.
3. **Frontend** – already applied in this repo: `app.js`, `signup.html`, `forgot-password.html`, `offline.js`, `dashboard.html`. Pages redeploys the web version (deploy the Worker + migration FIRST, or signup breaks).
4. **APK** – push this repo to GitHub. Actions → *Build Android APK* → Run workflow → download `pos-debug-apk` → `app-debug.apk`. Install on the phone (allow "install unknown apps").
   To build locally instead: install Node 20, JDK 17, Android Studio; then in `android-app/`: `npm install && npm run prepare-web && npx cap add android && npx cap sync android && cd android && ./gradlew assembleDebug`.

## Things to know
- **Printing:** `window.print()` does nothing inside an Android WebView. Receipts won't print from the APK until a print/Bluetooth-printer plugin is added (tell me the printer model and I'll wire it up). Browser/PWA printing is unchanged.
- **Offline scope:** billing + receipts work offline; voids, edits, stock-in, reports, history, signup, OTP and first login need internet (details at the bottom of `dashboard-offline-patch.md`).
- **Session:** the 30-day token lets the clerk open the app offline; if it expires while offline they must log in once online.
- **Play Store / sharing:** debug APKs are fine for your own shops. For the Play Store you need a signed release build (keystore) — can add later.
- **App icon:** default Capacitor icon until you supply one (`npx @capacitor/assets generate`).
- **Back-office clocks:** offline sales keep the time they were rung up; a phone with a wrong clock will date them wrongly (server rejects future times).
