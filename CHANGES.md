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
