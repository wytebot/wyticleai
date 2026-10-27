# Wyticle AI – environment variables and where to get them

## Frontend (`.env` in project root, baked in at build time)
| Variable | Get it from |
|---|---|
| `VITE_FIREBASE_CONFIG` | Firebase Console → Project settings → Your apps → **Web app** → SDK config. Paste as one-line JSON in single quotes (apiKey, authDomain, projectId, appId). |
| `VITE_GOOGLE_WEB_CLIENT_ID` | Google Cloud Console → APIs & Services → Credentials → the **Web application** OAuth client ID. Add the deployed website origin to that same client. Public ID only; never put the client secret in a `VITE_` variable. |
| `VITE_API_BASE_URL` | Your deployed backend HTTPS URL (Render/Railway/Fly/VPS). Must be HTTPS for the APK. |

## Backend (`server/.env`)
| Variable | Get it from |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Firebase Console → Project settings → Service accounts → Generate new private key. Minify to one line, wrap in single quotes. Must be the SAME project as the app (`wryteai-62356` per google-services.json). |
| `SUPABASE_URL` | Supabase → Project Settings → API → Project URL. |
| `SUPABASE_SERVICE_ROLE_KEY` | Same page → `service_role` key (secret, server only). Then run `server/sql/schema.sql` in the SQL editor. |
| `TOKEN_ENCRYPTION_KEY` | Run `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. Never change it after users connect sites. |
| `GEMINI_API_KEY` | aistudio.google.com/apikey (Google AI Studio). Used for writing, live research and featured images. |
| `GEMINI_MODEL` / `GEMINI_FALLBACK_MODELS` | Optional. Defaults `gemini-3.5-flash-lite` and `gemini-3.8-flash,gemini-3.6-flash`. |
| `GEMINI_IMAGE_MODEL` / `GEMINI_IMAGE_FALLBACK_MODELS` | Optional. Defaults `gemini-3.1-flash-image-preview` and `gemini-2.5-flash-image`. |
| `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` | Google Cloud Console → APIs & Services → Credentials → Create OAuth client ID → **Web application**. Authorized redirect URI: `<API_PUBLIC_URL>/api/connect/blogger/callback`. Enable **Blogger API** and **Google Drive API**; add scopes `blogger` and `drive` on the consent screen. |
| `APP_URL` | Public URL of the web frontend. |
| `API_PUBLIC_URL` | Public HTTPS URL of this backend (same as VITE_API_BASE_URL). |
| `ALLOWED_ORIGIN` | Comma-separated frontend origins, e.g. `https://yourapp.com`. APK origins are allowed automatically. |
| `FLW_V4_CLIENT_ID` / `FLW_V4_CLIENT_SECRET` | Flutterwave dashboard → Settings → API keys (v4 keys, not v3). Use sandbox first. |
| `FLW_V4_ENCRYPTION_KEY` | Same page → **Encryption key** (base64, 32 bytes). Required: card number, CVV and PIN are AES-256-GCM encrypted with it. |
| `FLW_V4_BASE_URL` | Sandbox `https://developersandbox-api.flutterwave.com`; live `https://f4bexperience.flutterwave.com`. |
| `USD_NGN_RATE` | Your own naira-per-dollar rate (e.g. `1500`). Packs are priced in USD ($4 / $9 / $18) and the card is charged the naira equivalent. |
| `FLW_V4_WEBHOOK_SECRET_HASH` | Optional. Any secret string you also enter as the secret hash under Settings → Webhooks; webhook URL is `<API_PUBLIC_URL>/api/billing/webhook`. |
| `SCHEDULE_WORKER_SECRET` | Any long random string (`openssl rand -hex 32`); only needed if an external cron pings `/api/internal/scheduled-worker`. |
| `NODE_ENV`, `TRUST_PROXY_HOPS`, `PORT` | `production`, `1`, host-provided. |
| Pricing and usage limits | `PRICING_CONFIG` in `server/index.js` has defaults for Gemini token prices, research and image cost, credit markup/value and trial follow-up limit. Override with `GEMINI_INPUT_USD_PER_M`, `GEMINI_OUTPUT_USD_PER_M`, `SEARCH_USD_PER_CALL`, `IMAGE_USD_COST`, `CREDIT_MARKUP`, `CREDIT_VALUE_USD`, `TRIAL_FOLLOWUP_LIMIT` when you change model or Google changes prices. |
| Other tuning | `MAX_OUTPUT_TOKENS`, `ENABLE_WEB_SEARCH`, `GEMINI_THINKING_LEVEL`, `SCHEDULE_MAX_*`. |

## Android-only (not env vars)
1. Firebase → Add Android app, package `app.wyticleai.vercel` → download `google-services.json` into `android-setup/`.
2. Firebase → Authentication → enable **Google**.
3. Add your debug and release **SHA-1 and SHA-256** (`cd android && ./gradlew signingReport`), then re-download `google-services.json` (it must contain a non-empty `oauth_client`).
4. `npm install && npx cap add android && npm run cap:firebase-setup && npm run cap:assets && npm run cap:sync && npm run android`.

## Database
Run `server/sql/pricing-protection-migration.sql` and `server/sql/billing-card-migration.sql` once for older databases. Also run `server/sql/credit-payment-hardening-migration.sql` to enable atomic free-follow-up reservations and strict duplicate-safe payment crediting, then `server/sql/payment-recovery-migration.sql` so a provider-confirmed payment is never left uncredited. Fresh databases should run the complete `server/sql/schema.sql`, which includes the current functions.

### Native push notification storage fallback

Push-device registrations use Supabase when available and automatically fall back to the Firebase project's **Cloud Firestore** collection `wyticlePushDevices` if the Supabase registry is missing or fails. This fallback is for push-device tokens only; user accounts, wallet/credits, article data, and scheduled posts still require the app's configured primary database.

For Firestore fallback, enable **Cloud Firestore** in the same Firebase project used by Firebase Admin, and configure the backend service account using `FIREBASE_SERVICE_ACCOUNT_JSON` (or `GOOGLE_APPLICATION_CREDENTIALS`). The service account needs permission to read/write Firestore and send Firebase Cloud Messaging notifications. No client-side Firestore rules should be opened publicly; these writes are performed by the trusted backend. FCM delivery still requires a valid native device token and Android notification permission.

## Google OAuth client ID consistency

Set `VITE_GOOGLE_WEB_CLIENT_ID` in the frontend build environment (Vercel project settings) and rebuild. Set `GOOGLE_OAUTH_CLIENT_ID` plus `GOOGLE_OAUTH_CLIENT_SECRET` only in the backend environment. The frontend variable must contain the same Web application client ID as `GOOGLE_OAUTH_CLIENT_ID`; the secret must never be exposed to frontend code. Do not hard-code OAuth IDs or secrets in source. The Android `google-services.json` is Firebase native configuration and is kept for native sign-in.


## Optional WyBuild shared billing gateway

`VITE_WYBUILD_BILLING_BASE_URL` is optional. If set, only `/api/billing/*` requests are routed to that HTTPS base URL; AI generation, account data, Blogger OAuth/publishing, Drive, and push registration continue using `VITE_API_BASE_URL`. Set it to the public WyBuild backend origin (no trailing slash), then rebuild the web app/APK. The frontend sends `X-WyBuild-App-Id: wyticle` and `appId: wyticle` on billing requests.

**Important:** this client switch alone does not make an arbitrary WyBuild deployment compatible. WyBuild must expose the same `/api/billing/packs`, `/checkout`, `/authorize`, and `/verify` routes; verify Firebase ID tokens for the same Firebase project (or implement an explicitly trusted identity bridge); scope transactions and entitlements by app ID; and include `app_id: wyticle` in Flutterwave v4 charge metadata so the WyBuild webhook credits the correct Wyticle account exactly once. Never expose Flutterwave, Supabase, Firebase service-account, or webhook secrets in `VITE_*` variables. The webhook URL is configured in the Flutterwave dashboard and is not called by the app directly.


## WyBuild shared billing webhook (optional)

To let WyBuild own the registered Flutterwave webhook and forward verified Wyticle payment events, set this **server-side only** variable in Wyticle's backend deployment:

- `WYBUILD_WEBHOOK_SHARED_SECRET`: a long random secret, identical to `WYTICLE_WEBHOOK_SHARED_SECRET` in WyBuild.

In WyBuild's Vercel environment set `WYTICLE_PAYMENT_CONFIRM_URL` to this backend's `/api/wybuild-payment-confirmation` endpoint and set `WYTICLE_WEBHOOK_SHARED_SECRET` to the same value. Never expose this secret in `VITE_` variables or commit it to source control. When using the shared webhook, do not also register Wyticle's direct `/api/billing/webhook` endpoint with Flutterwave.
