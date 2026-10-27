# Wyticle AI ↔ WyBuild shared billing integration

## Environment

- `VITE_API_BASE_URL`: Wyticle's application backend. Keep this configured for AI generation, user/account data, Blogger OAuth and publishing, Drive, scheduled publishing, and push notifications.
- `VITE_WYBUILD_BILLING_BASE_URL`: optional HTTPS origin for the shared WyBuild billing gateway, with no trailing slash. Example format: `https://your-wybuild-api.example.com` (replace with your real deployed URL).

When the second value is configured, Wyticle sends only `/api/billing/*` requests to WyBuild. Requests include the authenticated Firebase ID token, `X-WyBuild-App-Id: wyticle`, and an `appId: wyticle` field in payment operations. Existing billing remains on the Wyticle backend when the variable is empty.

## Required WyBuild backend support

The WyBuild backend must explicitly implement and authorize the following contract before you set the URL in production:

- `GET /api/billing/packs` — return Wyticle-specific packs and prices.
- `POST /api/billing/checkout` — accept `{ appId: "wyticle", packId, card, returnUrl }`, create a pending transaction, and return `{ reference, state, credits, amountNGN, currency }`.
- `POST /api/billing/authorize` — accept `{ appId: "wyticle", reference, type, pin|otp }` and return the updated payment state.
- `POST /api/billing/verify` — accept `{ appId: "wyticle", reference }` and return `{ status, addedCredits, credits }`.

All routes must verify the Firebase ID token on the server, bind each payment to the authenticated user and the `wyticle` app, enforce allowed pack IDs and server-side amounts, and return consistent JSON errors. Never trust a client-supplied amount, credit count, app ID, or success redirect as proof of payment. WyBuild must use Flutterwave v4 only if that is the configured payment provider.

## Webhook recognition

For every Flutterwave v4 charge, WyBuild must include `meta.app_id = "wyticle"` in the charge metadata. The shared webhook must validate Flutterwave's signature, look up the transaction by provider transaction ID/reference plus app ID, verify amount/currency/status against the server-created pending record, and grant the Wyticle entitlement/credits exactly once using a database transaction or unique idempotency constraint. Unknown app IDs, mismatched amounts, and duplicate events must never grant extra credits. Configure the actual WyBuild webhook URL in the Flutterwave dashboard; the frontend does not call the webhook.

## Important boundary

This ZIP prepares Wyticle to select the shared billing origin and identify itself as `wyticle`. It does **not** magically add Wyticle-specific routes or webhook routing to an already-deployed WyBuild backend. That backend must be updated and deployed to satisfy the contract above. Keep all provider secrets on the server and never put them in Vite variables.


## WyBuild webhook callback endpoint

The Wyticle backend exposes `POST /api/wybuild-payment-confirmation` for WyBuild's server-to-server webhook relay. Set `WYBUILD_WEBHOOK_SHARED_SECRET` in Wyticle's backend and the matching `WYTICLE_WEBHOOK_SHARED_SECRET` in WyBuild. WyBuild's `WYTICLE_PAYMENT_CONFIRM_URL` must point to this endpoint over HTTPS. The endpoint supports `action: "lookup"` for reference-only Flutterwave events and `action: "settle"` for final events. It never trusts the forwarded status/amount as proof; it matches the stored Wyticle payment and independently fetches/verifies the charge through Flutterwave before granting credits.
