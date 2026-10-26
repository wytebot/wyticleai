# Wyticle AI

Wyticle AI is a mobile-first black-and-white AI article-writing workspace. It supports a first-visit welcome screen, Google authentication, IndexedDB project history, detailed writing instructions, AI generation/revision/diagnosis, SEO metadata, optional AI featured images, Blogger OAuth publishing, optional Google Drive TXT archiving, a server-side credit ledger, and Flutterwave v4 OPay checkout for NGN.

## Important: configure your own services

The ZIP contains application source, not a prebuilt signed APK. Provider accounts and credentials are intentionally not bundled. Do not deploy with placeholder secrets or open billing until you have tested it in sandbox.

## 1. Frontend

Requires Node.js 20+.

```bash
npm install
cp .env.example .env
npm run dev
```

Paste the Firebase **Web app** configuration object into the single `VITE_FIREBASE_CONFIG` JSON value in `.env`, enable Google sign-in in Firebase Authentication, and add your web hostname to Firebase authorized domains. Set `VITE_API_BASE_URL` to the deployed backend's HTTPS URL. `VITE_API_BASE_URL` is compiled into the web build and APK, so do not leave it as `localhost` when building a standalone APK. These are public client settings; never put provider secrets in any `VITE_` variable.

For local browser development only, `VITE_API_BASE_URL=http://localhost:8787` is fine. For deployed browser and Android APK builds, use the same reachable HTTPS backend URL. The APK cannot reach your development computer through `localhost` on the phone.

## 2. Backend

```bash
cd server
npm install
cp .env.example .env
npm run check
npm start
```

Configure the required values in `server/.env`. `OPENAI_MODEL` explicitly selects the article-writing model at backend startup; change that environment variable to switch models without editing application code, then restart/redeploy the backend. The code fallback is `gpt-4.1-mini` if `OPENAI_MODEL` is omitted. The image model is independently controlled by `OPENAI_IMAGE_MODEL`.

- Firebase Admin service-account JSON.
- Supabase URL and service-role key.
- One encryption key for stored OAuth credentials.
- OpenAI API key.
- Google OAuth client ID and secret.
- Public app URL, public API URL, and allowed frontend origin.
- Flutterwave v4 client ID and secret only if enabling paid credit purchases.
- `SCHEDULE_WORKER_SECRET` only if enabling scheduled publishing; configure your cron service to call the worker every minute.

Use the Flutterwave sandbox URL while testing. For production, set `FLW_V4_BASE_URL` to the production base URL shown in your Flutterwave v4 dashboard. Keep every secret in the backend host, never in the APK or frontend environment.

## 3. Supabase database

Open Supabase SQL Editor and run `server/sql/schema.sql` once. It creates wallets, credit ledger, usage reservations, connected sites, OAuth states, and payment records plus atomic RPCs for credit reservations/refunds/payment crediting. The tables use RLS with no browser policies; only the server service-role key should access them.

If you have already applied an older version of the schema, rerun the schema after backing up your data so the `return_url` column and updated functions are installed. Never expose the service-role key in frontend or APK assets.

## 4. Firebase and Google OAuth / Blogger

1. Create a Firebase project and register the web app. Copy its web configuration object into `VITE_FIREBASE_CONFIG` in the frontend `.env`.
2. Enable Google in Firebase Authentication.
3. In Google Cloud Console, enable the Blogger API and Google Drive API and configure an OAuth web client. The app requests the Google Drive `drive` scope so a user-provided existing folder ID can be accessed. This is a broad Drive permission; clearly explain it in your consent screen and complete Google OAuth verification before public launch.
4. Add this exact authorized redirect URI to that OAuth client: `https://YOUR_API_HOST/api/connect/blogger/callback`.
5. Set `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, and `API_PUBLIC_URL` on the backend.
6. Run the SQL schema so the short-lived OAuth state table exists.

Blogger and Google Drive refresh tokens are encrypted at rest with AES-256-GCM. The backend refreshes access tokens and only publishes to blogs returned by the user's authorized Blogger account. Existing users must reconnect Google access to grant the added Drive permission.

## 5. Publishing scope

Wyticle AI currently publishes to Blogger. WordPress connection and publishing flows are not included, to keep setup simple. The preview/editor provides an HTML download for the final article, and the Google Drive settings screen lists Wyticle TXT exports in the configured folder with a per-file download action.

## 6. Credits and billing

- New accounts receive two free initial article generations. The same trial article can be revised, diagnosed, and fixed without additional AI credits.
- Purchased credits do not expire.
- The backend verifies Firebase ID tokens; it never trusts a client-supplied user ID or balance.
- AI operations reserve credits atomically, settle against actual model tokens/search calls, and refund unused reservations or failed operations.
- AI image generation is separately priced (`IMAGE_CREDIT_COST`); uploading an image from the device is free.
- Credits are cost-based: every paid action reserves credits before the provider call and settles against reported token/search usage afterward; unused units are refunded. The reserve uses a conservative input allowance plus output/search caps. When you change `OPENAI_MODEL`, update per-token price variables. The two initial free article entitlements are atomic. Free follow-up reservations on trial articles are capped atomically by `TRIAL_FOLLOWUP_LIMIT`; failed requests release their reservation and restore the follow-up slot. For an existing database, run `server/sql/pricing-protection-migration.sql` and `server/sql/credit-payment-hardening-migration.sql`.
- Checkout uses the Flutterwave **v4** card flow in NGN: create customer → encrypt card with `FLW_V4_ENCRYPTION_KEY` → create payment method → create charge → submit PIN (`/api/billing/authorize`) → submit OTP or complete 3-D Secure → verify. Credits are only granted after the server fetches the charge from Flutterwave and checks exact reference, transaction ID, currency and amount; database crediting is atomic and duplicate-safe. Charge/authorization requests use stable idempotency keys. Packs are priced in USD (`packs` in `server/index.js`) and charged at `USD_NGN_RATE`. Card data passes through your server in memory only and must never be logged; review PCI-DSS obligations before launch. Run `server/sql/billing-card-migration.sql` and `server/sql/credit-payment-hardening-migration.sql` for existing databases.
- Payment return does not itself grant credits. The authenticated backend retrieves the v4 charge and checks reference, amount, currency and terminal success before the atomic credit RPC can add value. Users can retry verification if a payment is still pending; an optional webhook (`/api/billing/webhook`) also credits completed payments.

## 7. Capacitor standalone Android

```bash
npm install
npm run build
npx cap add android
npm run cap:firebase-setup
npx cap sync android
```

The project includes the native Firebase Authentication, Filesystem, Share, Browser and App plugins, custom icon source assets under `resources/`, and deep-link handling. Core operations use the same authenticated backend from browser and APK: AI generation/revisions/diagnosis/fixes, image generation, account and credits, Blogger/Drive OAuth, immediate publishing, scheduled publishing/status, authenticated Google Drive TXT listing/downloads, and payment checkout/verification. Final articles download as HTML in a browser; the APK writes the export to its cache and opens the native share sheet so the user can save/share it. Web sign-in uses Firebase Web Auth; APK sign-in uses the Capacitor Firebase Authentication plugin. External OAuth/payment pages open in the browser on the APK and return through the `ai.wryte.app://auth-callback` deep link; browser builds return to the configured website origin. The API CORS middleware allows Capacitor localhost origins and still requires the deployed browser origin in `ALLOWED_ORIGIN` for production.

Native Android sign-in uses the bundled Android Firebase configuration and does not require the Firebase Web config. Browser/PWA sign-in still requires a registered Firebase Web app config in `VITE_FIREBASE_CONFIG`. For native Google sign-in:

1. The supplied Android Firebase configuration is bundled at `android-setup/google-services.json` for application ID `app.wyticleai.vercel`; the Capacitor `appId` matches it.
2. Add the SHA-1 and SHA-256 fingerprints for your development and Play App Signing certificates in Firebase and enable the Google provider in Firebase Authentication. The uploaded config currently has an empty `oauth_client` list, so native Google sign-in is not fully ready yet: register fingerprints, enable Google sign-in, then download a fresh `google-services.json` containing the OAuth client entries.
3. Run `npx cap add android`, then `npm run cap:firebase-setup`, then `npx cap sync android`. The setup script copies the JSON and configures the Google Services Gradle plugin.
4. In `android/app/src/main/AndroidManifest.xml`, add this intent filter inside the `MainActivity` `<activity>` element so Blogger authorization and payment returns can reopen the app:

```xml
<intent-filter>
  <action android:name="android.intent.action.VIEW" />
  <category android:name="android.intent.category.DEFAULT" />
  <category android:name="android.intent.category.BROWSABLE" />
  <data android:scheme="ai.wryte.app" android:host="auth-callback" />
</intent-filter>
```

5. Build and test the installed APK on a real device, including Google sign-in, Blogger authorization, card payment with PIN and OTP, 3-D Secure return to the app, and verifying a payment.
6. Build a signed APK/AAB in Android Studio. The API must use HTTPS and be reachable from the installed app.

Custom app icons are in `resources/icon.png`; run `npm run cap:assets` after installing dependencies to generate native icon/splash assets. The Android project is generated by `npx cap add android`, so it is not pre-generated in this ZIP.

## 8. Security and operations checklist

Before public launch:

- Set production HTTPS URLs and strict CORS origins.
- Apply the SQL schema and verify RLS/service-role separation.
- Use a new encryption key and keep all secrets in backend environment settings.
- Test token revocation, OAuth state expiry, payment duplicate callbacks, insufficient credit handling, AI provider failures, and partial publish failures.
- Configure Flutterwave v4 webhook delivery/monitoring in addition to server-side verification if enabled for your account.
- Add a support email and have legal pages reviewed for your business and target markets.
- IndexedDB history is local to one browser/device and can be lost when app storage is cleared; export/backup and cloud sync are separate features.

## Environment variables reference

### Frontend build variables (`.env`)

- `VITE_FIREBASE_CONFIG` — required for browser/PWA Google sign-in; JSON for the Firebase **Web app**. The APK's native sign-in uses `android-setup/google-services.json` instead.
- `VITE_API_BASE_URL` — required for every live backend operation in browser and APK. Use the public HTTPS API URL in production and before building the APK; `localhost` is only for local browser development.

Never put private keys, OAuth client secrets, Supabase service-role keys, or OpenAI keys in a `VITE_` variable because frontend values are public.

### Backend required variables (`server/.env`)

- `FIREBASE_SERVICE_ACCOUNT_JSON` — Firebase Admin service-account JSON. Alternative: `GOOGLE_APPLICATION_CREDENTIALS` — filesystem path to a service-account JSON file; use one of these.
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `TOKEN_ENCRYPTION_KEY` — base64-encoded 32-byte key for encrypted OAuth credentials.
- `OPENAI_API_KEY`
- `OPENAI_MODEL` — article-writing model ID, for example `gpt-4.1-mini`; this environment variable controls the model used by generation, revisions, diagnosis and fixes.
- `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` — Google OAuth web client for Blogger and Drive, separate from the Firebase Web app configuration.
- `APP_URL` — public frontend origin used by OAuth callbacks.
- `API_PUBLIC_URL` — public HTTPS backend origin used in Google OAuth redirect URI.
- `ALLOWED_ORIGIN` — comma-separated allowed browser origins, e.g. `https://your-site.example`; Capacitor's localhost origins are allowed by the backend.

### Optional backend variables (defaults are in code)

- `PORT` — default `8787`.
- `MAX_OUTPUT_TOKENS` — default `9000`.
- `ENABLE_WEB_SEARCH` — default enabled; set `false` to disable research search calls.
- `OPENAI_IMAGE_MODEL` — default `gpt-image-1`.
- `CREDIT_MARKUP` (5), `CREDIT_VALUE_USD` (0.002), `OPENAI_INPUT_USD_PER_M`, `OPENAI_OUTPUT_USD_PER_M`, `SEARCH_USD_PER_CALL`, `IMAGE_USD_COST`, `MAX_SEARCH_CALLS` (3), `TRIAL_FOLLOWUP_LIMIT` (4), `USD_NGN_RATE`, `IMAGE_CREDIT_COST` (optional fixed override).
- `SCHEDULE_MAX_ACTIVE_PER_USER` — default `10`.
- `SCHEDULE_MAX_ACTIVE_GLOBAL` — default `500`.
- `SCHEDULE_MAX_DAYS` — default `90`.

### Optional features

- `FLW_V4_CLIENT_ID` and `FLW_V4_CLIENT_SECRET` — required only to enable Flutterwave v4 checkout; `FLW_V4_BASE_URL` defaults to `https://developersandbox-api.flutterwave.com` for sandbox testing. Use the production base URL shown in your Flutterwave account when ready for production.
- `SCHEDULE_WORKER_SECRET` — required when using an external cron to trigger scheduled publishing on serverless hosting. An always-on Node server can run its built-in worker, but still needs to stay running.

The Android package name, deep-link scheme, model fallback, credit rates, and queue limits do not need additional environment variables. After changing a backend environment variable, restart or redeploy the backend. After changing a `VITE_` variable, rebuild and redeploy the frontend and rebuild/sync the APK if applicable.

## Endpoints

- `GET /health`
- `GET /api/me`
- `POST /api/generate` — initial article, revision, fix, diagnosis
- `POST /api/image` — AI featured image generation
- `POST /api/connect/blogger/start` and `GET /api/connect/blogger/callback`
- `GET /api/sites`
- `GET /api/drive/settings`
- `GET /api/drive/files` — list Wyticle TXT exports in the configured folder
- `GET /api/drive/files/:fileId/download` — authenticated download restricted to the configured folder
- `PUT /api/drive/settings` — configure and verify the user's Google Drive TXT archive folder
- `POST /api/publish`
- `GET /api/credits`
- `GET /api/billing/packs`
- `POST /api/billing/checkout`
- `POST /api/billing/verify`

## Manual article editor

The preview page includes a capsule-shaped **Edit article** action. The editor provides undo/redo, bold/italic/underline/strikethrough, paragraph and heading styles, 10 font families, lists, section movement, image insertion, YouTube/Vimeo embeds, links, and a delete-all control with an in-app confirmation panel. Article content and SEO metadata are saved to IndexedDB automatically as the user edits. The toolbar is sticky and horizontally scrollable on small Capacitor screens.

## Scheduled publishing

The Publish panel supports **Publish now** or **Schedule**. Scheduled date/time is entered in a capsule-style text field as `YYYY-MM-DD HH:MM` in the device's local timezone. The client converts that time to ISO UTC. The backend stores only the publisher-required article fields, selected destinations and connected-site IDs in `wryte_scheduled_posts` (no separate Storage bucket is used). The queued article is limited to 8 MiB. Admission control limits each account to 10 active schedules and the whole service to 500 active schedules by default, and schedules may be set up to 90 days ahead. These defaults can be changed with `SCHEDULE_MAX_ACTIVE_PER_USER`, `SCHEDULE_MAX_ACTIVE_GLOBAL`, and `SCHEDULE_MAX_DAYS`. Limits are enforced atomically by the PostgreSQL function `wryte_enqueue_scheduled_post`, so simultaneous requests cannot bypass the queue caps. The app explains the per-account and scheduling-window limits before submission; if the global queue is full, users receive a retry-later message. On confirmed delivery to every selected destination, the worker immediately sets the temporary `project` payload to `NULL` and retains only small status/result metadata. If delivery fails, the payload is retained for up to 7 days after the scheduled time so the failure can be inspected; the worker then purges it automatically while retaining status metadata. This means completed jobs do not retain article text or embedded image data indefinitely.

For a fresh database, run `server/sql/schema.sql` in Supabase; it includes the credit/payment hardening functions. For an existing database, run `server/sql/credit-payment-hardening-migration.sql` after the prior pricing/billing migrations, then `server/sql/payment-recovery-migration.sql` (lets a payment that Flutterwave later confirms be credited even if it was locally marked failed after a timeout). If you already installed an earlier Wyticle AI schema, run `server/sql/scheduled-content-retention-migration.sql` in Supabase SQL Editor; it safely makes the queued content nullable, adds the expiry/purge fields and indexes, and installs the atomic queue-limit function. For an always-on Node host, the API's built-in worker checks every 15 seconds. If you deploy on serverless hosting where in-process timers do not remain alive, configure `SCHEDULE_WORKER_SECRET` and an external cron to POST `https://YOUR_API_HOST/api/internal/scheduled-worker` every minute with `Authorization: Bearer YOUR_SCHEDULE_WORKER_SECRET`. Keep the secret private. Scheduled publishing and content cleanup both depend on the worker/backend and database being available; keep the service monitored and test with a non-critical draft before relying on it. For reliable delivery on serverless hosts, configure the external cron described above. A job is marked published once Blogger confirms delivery, and its article payload is then removed. If the optional Google Drive TXT copy fails in that case, the failure is recorded in the job's `results` but does not mark the job failed or trigger a retry (a retry would publish a duplicate post). If Blogger itself fails, the job is marked failed and the payload is kept for up to 7 days.


## Google Drive TXT archive

Open **Settings → Google Drive TXT archive**. Reconnect Google access to grant Drive permission, then paste the target folder ID from the folder URL and choose **Verify & save folder**. The backend validates that the ID is an editable folder. When the user publishes an article, Wyticle automatically saves a UTF-8 `.txt` file containing the title, available SEO fields and plain-text article body. The same export runs when a scheduled article is delivered. Exports are idempotent per project: republishing updates the existing Wyticle TXT file rather than creating duplicates. Drive folder IDs are stored per account; access and refresh tokens remain encrypted server-side. The export does not embed image/video binary content.

For existing Supabase databases, run `server/sql/google-drive-archive-migration.sql`. Fresh installs should run the updated `server/sql/schema.sql`. No new environment variables are required; the existing `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `TOKEN_ENCRYPTION_KEY`, `SUPABASE_URL`, and `SUPABASE_SERVICE_ROLE_KEY` are reused. No Drive folder ID environment variable is needed because each user configures their own folder in Settings.

## Remaining launch work

- Complete Google OAuth consent-screen setup and verification for the Drive scope; enable Blogger API and Google Drive API in the same Google Cloud project.
- Configure all environment variables in the deployment host, apply the SQL schema/migrations, and deploy the API over HTTPS.
- Run end-to-end tests with real test accounts for Google sign-in, Blogger publish, Drive folder validation, TXT export, scheduled publish, retries, and partial failures.
- Build and test the Capacitor Android project on a real device; configure `google-services.json`, SHA fingerprints, deep-link intent filters, and sign a release APK/AAB.
- Review final credit pack pricing against current model, search, image and payment costs; test Flutterwave v4 sandbox and production eligibility.
- Add production monitoring, support contact and reviewed privacy/terms, including a clear explanation that article TXT copies are saved in the user's chosen Drive folder.


## App name and Android identity

The visible app name is **Wyticle AI**. To match the Firebase file you supplied, the Android application ID is now `app.wyticleai.vercel`; the custom OAuth/payment deep-link scheme remains `ai.wryte.app`. If you already distributed an APK using the old application ID `ai.wryte.app`, this build installs as a separate Android app and cannot update that old installation. Keep the application ID consistent for future releases.

## Resume where you left off

Wyticle AI automatically saves the current article brief, open creation form, active project, current workspace page, revision instructions, scheduling selections, and non-secret connection form values in IndexedDB. When the app is reopened, it restores the last working screen and the unfinished form so users can continue without starting over. This local state remains on the device unless site/app data is cleared or the app is uninstalled. Passwords and other secret credentials are intentionally not saved in the resume state; 

When a user approves an article and enters preview, Wyticle AI shows a custom in-app prompt recommending a Google Drive folder ID for saving a reusable TXT copy when the article is published. Users can dismiss it and continue to preview/publish, or open Drive settings. Configuring Drive is optional.


## Multi-purpose AI projects and downloads

The plus button opens the project picker for Articles, Letters, Emails, Resumes/CVs, Cover Letters, Proposals, Reports, Business Plans, Meeting Minutes, Social Content, Product Descriptions, and Press Releases. Each type uses a tailored prompt with standard document conventions and asks for the relevant details. The two free trial generations apply to article generation; other document generation uses the configured credit wallet. Publishing is available only for article projects through Blogger.

Completed projects offer PDF, editable DOCX, plain TXT, and HTML downloads in browser and Capacitor. Browser downloads use a standard file download; the standalone app writes the export to its cache and opens the native share sheet so the user can save or share it. PDF/DOCX exports preserve headings, paragraphs, lists, and supplied sender/recipient metadata where available. AI must not invent addresses, qualifications, quotes, figures, or other missing facts.

The frontend now uses `jspdf` for PDF creation and `docx` for real Office Open XML Word files. Run `npm install` after pulling the updated package, then `npm run build`. Live AI/provider integration and Android device export still need end-to-end testing with configured credentials.
