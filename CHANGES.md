# Changes in this update

Bugs found by reviewing the server, SQL, and frontend, and fixed here. Parsing and the sanitizer were tested;
database functions and live Flutterwave/Blogger/OpenAI flows could not be exercised offline (see "Not verified").

## Payments / credits
- **Timed-out charge no longer marked failed.** If creating the Flutterwave charge times out or returns 5xx/409, the
  request is retried once with the same idempotency key. If it is still unclear, the payment stays `pending` and the
  customer is told not to pay again; the webhook/verify path can then attach the charge and credit it. Before, the
  payment was marked `failed`, which blocked webhook recovery even though the card may have been charged.
- **Provider success now wins over a local `failed` flag.** `wryte_credit_payment` accepts `pending` or `failed` rows
  when Flutterwave's verified transaction matches (status, reference, currency, id, amount). New migration:
  `server/sql/payment-recovery-migration.sql` (also folded into `schema.sql` and the hardening migration).
- Checkout now ensures the wallet row exists before inserting the payment (the payment table references it).
- Frontend: a payment that fails is now cleared from `wryte-pending-payment` (it was re-verified on every sign-in
  forever); a stale/foreign reference (HTTP 404) no longer aborts sign-in onboarding; the "credits added" toast no
  longer says "0 credits" for an already-credited payment; the `?payment_ref=` return from 3-D Secure on the web is
  remembered and verified after sign-in.
- Credits modal shows the purchased balance even while free generations remain.

## Security
- **Blogger HTML sanitizer rewritten** (`cleanHtml`). The old regex version missed `<img/onerror=...>`, `<svg/onload=...>`,
  entity-obfuscated `javascript:` links and unbalanced tags. It is now a linear-time allow-list tokenizer that rebuilds
  every tag, only keeps safe attributes/URLs, allows only YouTube-nocookie/Vimeo embeds, and keeps output balanced
  so stray closing tags cannot break out of the post container.
- Webhook and scheduled-worker secret comparisons now compare byte lengths (a multibyte header made
  `crypto.timingSafeEqual` throw and the request hang).
- HTML export now sanitizes the article body and featured-image URL.

## Data safety
- **Editor data loss fixed.** Reopening the app while in the editor restored a stale snapshot over the user's saved
  edits. The saved project record is now the single source of truth.

## Smaller improvements
- Generate requests send only `id/title/niche/body` instead of the whole project (including a multi-MB base64 image).
- Truncated model output (`incomplete`) and model refusals now give a clear message; the reservation is released, so
  the user is not charged.
- README corrected: Blogger success + Drive TXT failure marks the job published (matches the code).
- Server version 1.1.1.

## Not verified (needs your environment)
- `npm install` / `vite build` could not run offline; the frontend was checked with esbuild (parses) and TypeScript
  (no undefined identifiers), not a real build.
- SQL was not run against Postgres. Run `payment-recovery-migration.sql` in the Supabase SQL editor and test one
  sandbox payment end to end.
- Known limits left as-is: the Google OAuth scope is full `drive` (a narrower `drive.file` scope would be safer, but
  changing it forces all users to reconnect and breaks listing existing exports); if Flutterwave rejects customer
  creation because the email already exists, checkout fails until `flw_customer_id` is set manually.

## Firestore fallback for native push registry
- Push device registration now writes to Supabase first and falls back to Firestore collection `wyticlePushDevices` when Supabase is unavailable or the push registry operation fails.
- Push delivery reads from Supabase first and falls back to Firestore if the Supabase lookup fails or Supabase is not configured.
- Device unregister and invalid-token cleanup support both stores.
- This fallback is limited to push-device registry storage; it does not replace Supabase for account, credit, article, or scheduled-post data.

## Text size, custom pickers, visible generation errors
- Text size setting: menu -> "Text size" (also in Settings). Small / Default / Large / Extra large. All font sizes now scale via `--fs`.
- Native browser pickers (niche, length, editor Text style / Font type, document Date) replaced by in-app bottom-sheet pickers and a calendar. Schedule time uses date + hour + minute pickers.
- Generation failures no longer drop you silently on the Projects page: the Create form reopens with your details and the error is shown (plus a toast). API calls now have timeouts and clear network / 504 messages.


## October 2026 update
- Added a mobile fullscreen top/bottom safe-area buffer so the app UI does not sit against the physical top edge when packaged as a fullscreen APK.
- Added a Blogger blog selector populated from the user's connected Blogger sites. The selected connection ID is saved in the existing IndexedDB `settings` store and reused for immediate and scheduled publishing. If the saved blog is no longer connected, the app falls back to the first available blog.


## Gemini-only AI, clearer errors, stronger sign-in and results
**AI provider**
- All OpenAI code, env vars and docs are removed. Gemini (Google AI Studio) now does writing, revisions, diagnosis, live research and featured images (`GEMINI_API_KEY`).
- Model fallback chain with retry/backoff for overload and rate limits; an unsupported model moves to the next one; an invalid key stops immediately. The API key is sent in a header, not the URL.
- Pricing now uses Gemini token prices (thinking tokens counted as output), one grounded research request and a Gemini image cost; all overridable by env. Failed upstream attempts are absorbed, never billed to the user.

**Credit / provider error message**
- Provider quota, billing, key and outage errors are mapped to short neutral messages ("The AI service is busy right now... You were not charged."). Raw provider text is only logged on the server.
- HTTP 402 now means only "you are out of credits". Provider problems return 503/422, so they no longer open the buy-credits dialog or look like a wallet problem.
- The app shows one clear out-of-credits message, clears any stale form error when the credits dialog opens and after a successful payment, and keeps your form details.

**Sign-in (browser and APK)**
- Token expiry: API calls force-refresh the Firebase ID token and retry once on 401. The server returns 401 only for a bad/expired token and 503 for a Firebase Admin/network failure, so an outage no longer signs everyone out.
- Browser: popup with redirect fallback; installed PWAs use redirect; in-app browsers that Google blocks get a clear message; redirect return keeps the button busy; cancelled/duplicate popups are handled; `VITE_FIREBASE_CONFIG` (documented before but ignored) and `VITE_FIREBASE_AUTH_DOMAIN` are now honoured.
- Native: listens to the native auth state (session restored, revoked or signed out), de-duplicates sign-in sync, and has precise messages for cancel, Play Services, network and the SHA-fingerprint DEVELOPER_ERROR.

**Result quality**
- Research-then-write: one Google Search-grounded request produces notes; the article is written from them. Sources shown to users come only from Search results (no model-invented citations). If research fails, the article is written without precise statistics rather than guessing.
- Structured JSON with a response schema, a required JSON shape in the prompt, JSON repair, and automatic retry when output is invalid or far below the requested word count. Word count, plain text and slug are computed on the server. Plain text is no longer generated by the model (about half the output tokens).
- Stronger prompts: audience/country spelling, anti-cliché rules, explicit section/length targets, revision/fix instructions that return the complete updated content, and a stricter diagnosis rubric with a clamped 0-100 score.
- Revisions and fixes keep existing sources and featured image.

**Not verified here (no network/npm in this environment)**
- The frontend was syntax-checked with TypeScript, not built with Vite; the Gemini calls were tested against a mocked API, not live. Run one real article, revision, diagnosis and image, and one browser plus one APK sign-in, before releasing.
- Model IDs come from the existing configuration and Google's docs at the time of writing; confirm they are enabled for your API key in AI Studio.

## Browser sign-in loop fix + stronger results for every project type
**Sign-in (browser)**
- Root cause of "returns to the login page after Google": browsers that block third-party storage (Chrome/Brave/Safari/Firefox) lose the redirect result when the Firebase auth domain differs from the site domain.
- Web sign-in now tries: popup -> Google Identity Services token sign-in (no redirect, no cross-site iframe) -> redirect (only when the auth domain is the site's own domain). If a redirect ever returns without a session, the app says so and switches to the token method automatically.
- ONE-TIME SETUP for the token method: Google Cloud Console -> APIs & Services -> Credentials -> the Web client (auto created by Google Service) -> Authorized JavaScript origins -> add your site origin (for example https://your-app.vercel.app). `VITE_GOOGLE_WEB_CLIENT_ID` can override the client ID.
- Optional, official alternative: proxy `/__/auth/*` on your own domain to `https://<project>.firebaseapp.com/__/auth/*`, set `VITE_FIREBASE_AUTH_DOMAIN` to your domain, and add `https://<your-domain>/__/auth/handler` as an authorized redirect URI on the same Web client.

**Results**
- Fixed: documents (emails, letters, resumes, ...) were silently told "Length: 1,200-1,800 words" and "Niche: Personal Finance" because of hidden article defaults in the form. Documents now get a per-type length and ignore article-only fields.
- Per-type structure, layout and length specs for all 11 document types (letter, email, resume, cover letter, proposal, report, business plan, meeting minutes, social post, product description, press release) plus a minimum-length check per type.
- System prompt: language matching, prompt-injection safety, no meta commentary, placeholder rules and a self-check list.
- When Gemini returns unusable output (too short, truncated, "rest unchanged" placeholders) the retry now tells it exactly what was wrong. Revisions and fixes are rejected and retried if they silently drop most of the content. Stray markdown bold is converted to HTML.
- Article length floor raised to 85% of the requested minimum; article guidance adds audience/country fit, tables/checklists and anti-repetition rules.
- Tip: set `GEMINI_THINKING_LEVEL=medium` (or `high`) on the server for the best quality; it uses more output tokens, so check your credit pricing.

## Owner billing bypass
- `ilemobayotolulope11092003@gmail.com` skips all credit billing: AI writing, revisions, fixes, diagnosis and featured images. Credits are never reserved or charged and the credits screen shows Unlimited.
- Enforced on the server only, and only when the Google account's email is verified (the client cannot grant it). Extra accounts: `BILLING_BYPASS_EMAILS=a@x.com,b@y.com` in the server environment.
- Blogger OAuth redirect URI: `<API_PUBLIC_URL>/api/connect/blogger/callback` (API_PUBLIC_URL must be your real https domain, no trailing slash; it defaults to localhost, which causes redirect_uri_mismatch).

## Blogger / Drive connection without redirects
- **Browser:** "Connect Blogger" now opens a Google popup (Google Identity Services code flow) and sends the returned code to `POST /api/connect/blogger/exchange`. There is no redirect URI, so `redirect_uri_mismatch` can no longer happen on the web.
- **Android APK:** "Connect Blogger" first shows the native Google account chooser (`FirebaseAuthentication.signInWithGoogle` with the Blogger + Drive scopes) and sends its server auth code to the same endpoint. If the plugin does not return a server auth code on a device, the app falls back to the old browser flow automatically. Check `adb logcat | grep "serverAuthCode"` if it keeps falling back.
- The old redirect flow (`/api/connect/blogger/start` + `/callback`) is kept as the fallback.

### One-time Google Cloud setup (use ONE Web OAuth client for everything)
Set `VITE_GOOGLE_WEB_CLIENT_ID` to the Web application OAuth client ID from Google Cloud Console. Do not hard-code this ID in source. The Android `google-services.json` remains a native build configuration file.
1. Google Cloud Console -> APIs & Services -> Credentials -> that Web client.
2. Set server env `GOOGLE_OAUTH_CLIENT_ID` to that ID and `GOOGLE_OAUTH_CLIENT_SECRET` to its secret (shown on the client page). The code exchange only works when the app and server use the same client.
3. Authorized JavaScript origins: add your site origin, for example `https://your-app.vercel.app` (needed for browser sign-in and the Blogger popup).
4. Authorized redirect URIs (only needed for the fallback flow): `https://your-app.vercel.app/api/connect/blogger/callback`, and set `API_PUBLIC_URL=https://your-app.vercel.app`.
5. APIs & Services -> Library: enable Blogger API v3 and Google Drive API. On the OAuth consent screen add the Blogger and Drive scopes; while the app is in Testing mode, add your Google account under Test users.

## Diagnose: visible report, live fact-check for every project type, Fix button
- The diagnosis report now opens as a pop-up the moment it is ready (it used to appear at the very bottom of the page, below the whole draft, so it looked like nothing happened). It stays available inline too.
- If the server returns no diagnosis the app now shows an error instead of made-up placeholder findings.
- Diagnosis now runs a live Google Search fact-check for all 12 project types (article, letter, email, resume, cover letter, proposal, report, business plan, meeting minutes, social post, product description, press release). Only external facts are checked (figures, dates, laws, prices, studies, organisations); personal details, resume history and attendees are ignored because they cannot be verified. Each claim is labelled Verified / Partly correct / Incorrect / Unverified with the correct fact and its sources. If the fact-check fails, the audit still runs and says so.
- "Fix issues" is in the report pop-up, in the report card, and next to the Diagnose button once a report exists. It sends every finding plus the verified corrections to the fix action, which is told to apply them exactly.
- Billing: the fact-check is one grounded search request, included in the diagnosis reservation and settled on actual usage. Set `ENABLE_WEB_SEARCH=false` to turn live checks off.

## "Error 401: invalid_client" on the Blogger browser flow
- Google shows this when the client ID in the authorization link does not exist. The usual causes are a typo, a deleted client, a value copied with quotes or spaces (Vercel keeps them literally), or the client secret / an Android client ID pasted into GOOGLE_OAUTH_CLIENT_ID.
- The server now trims spaces and quotes from GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET, and refuses to start the Google flow with a clear message when the ID is not shaped like `123456789-abc.apps.googleusercontent.com`.
- The Android app now tells you why the native Google prompt was skipped before it falls back to the browser flow.
- Use the same Web application client ID for `VITE_GOOGLE_WEB_CLIENT_ID` and server-side `GOOGLE_OAUTH_CLIENT_ID`; keep its matching secret only in server-side `GOOGLE_OAUTH_CLIENT_SECRET`.
