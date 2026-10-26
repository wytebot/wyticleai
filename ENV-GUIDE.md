# Wyticle AI – environment variables and where to get them

## Frontend (`.env` in project root, baked in at build time)
| Variable | Get it from |
|---|---|
| `VITE_FIREBASE_CONFIG` | Firebase Console → Project settings → Your apps → **Web app** → SDK config. Paste as one-line JSON in single quotes (apiKey, authDomain, projectId, appId). |
| `VITE_API_BASE_URL` | Your deployed backend HTTPS URL (Render/Railway/Fly/VPS). Must be HTTPS for the APK. |

## Backend (`server/.env`)
| Variable | Get it from |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Firebase Console → Project settings → Service accounts → Generate new private key. Minify to one line, wrap in single quotes. Must be the SAME project as the app (`wryteai-62356` per google-services.json). |
| `SUPABASE_URL` | Supabase → Project Settings → API → Project URL. |
| `SUPABASE_SERVICE_ROLE_KEY` | Same page → `service_role` key (secret, server only). Then run `server/sql/schema.sql` in the SQL editor. |
| `TOKEN_ENCRYPTION_KEY` | Run `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. Never change it after users connect sites. |
| `OPENAI_API_KEY` | platform.openai.com → API keys (needs billing; gpt-image-1 may need org verification). |
| `OPENAI_MODEL` | Optional, default `gpt-4.1-mini`. |
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
| Pricing (all optional) | `CREDIT_MARKUP` (default 5), `CREDIT_VALUE_USD` (0.002), `OPENAI_INPUT_USD_PER_M` (0.40), `OPENAI_OUTPUT_USD_PER_M` (1.60), `SEARCH_USD_PER_CALL`, `IMAGE_USD_COST` (0.063), `MAX_SEARCH_CALLS` (3), `MAX_INPUT_TOKENS_ESTIMATE` (35000), `TRIAL_FOLLOWUP_LIMIT` (4). Copy per-token prices from platform.openai.com/docs/pricing for your model. |
| Other tuning | `MAX_OUTPUT_TOKENS`, `ENABLE_WEB_SEARCH`, `OPENAI_IMAGE_MODEL`, `SCHEDULE_MAX_*`. |

## Android-only (not env vars)
1. Firebase → Add Android app, package `app.wyticleai.vercel` → download `google-services.json` into `android-setup/`.
2. Firebase → Authentication → enable **Google**.
3. Add your debug and release **SHA-1 and SHA-256** (`cd android && ./gradlew signingReport`), then re-download `google-services.json` (it must contain a non-empty `oauth_client`).
4. `npm install && npx cap add android && npm run cap:firebase-setup && npm run cap:assets && npm run cap:sync && npm run android`.

## Database
Run `server/sql/pricing-protection-migration.sql` and `server/sql/billing-card-migration.sql` once for older databases. Also run `server/sql/credit-payment-hardening-migration.sql` to enable atomic free-follow-up reservations and strict duplicate-safe payment crediting, then `server/sql/payment-recovery-migration.sql` so a provider-confirmed payment is never left uncredited. Fresh databases should run the complete `server/sql/schema.sql`, which includes the current functions.
