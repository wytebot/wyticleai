# Wyticle AI fallback and free-plan configuration

## Gemini key fallback

Set these on the **backend** hosting service (for example Vercel project environment variables for the API project). Keep them out of `VITE_*` variables, the browser bundle, APK source, and Git.

```dotenv
GEMINI_API_KEY=your_primary_gemini_key
GEMINI_API_KEY_2=your_second_gemini_key
GEMINI_API_KEY_3=your_third_gemini_key
GEMINI_MODEL=your_supported_text_model
GEMINI_FALLBACK_MODELS=your_text_fallback_model_1,your_text_fallback_model_2
GEMINI_IMAGE_MODEL=your_supported_image_model
GEMINI_IMAGE_FALLBACK_MODELS=your_image_fallback_model
```

The app tries each configured Gemini key for a model before advancing to the next model. This applies to text generation, grounded research, and image generation. If Gemini text generation still fails, the existing optional `OPENAI_API_KEY` then `ANTHROPIC_API_KEY` providers can be used for structured text requests. Those are different providers and are not required if you only want Gemini-key rotation.

Prefer keys from separate Google AI Studio projects if you need genuinely separate project quotas. Multiple keys attached to the same project may share the same project quota; extra keys do not guarantee extra free quota. Restrict keys to the Gemini API and never expose them in client-side variables.

## Free-plan enforcement (important)

There is **no environment variable** that safely enforces the free plan. It is enforced by Supabase PostgreSQL reservation/settlement functions in `server/sql/schema.sql`. The current schema allows **two free initial article generations per account** and permits follow-up actions on trial projects under the existing `TRIAL_FOLLOWUP_LIMIT` rules. This is not yet the requested entitlement of one generation, one edit, and one image per free project, counted only at the final stage. That change requires a database migration plus coordinated changes to reservation, settlement, and API display logic; setting a variable alone would not protect against abuse.

`TRIAL_FOLLOWUP_LIMIT=4` controls the current follow-up cap; it does not define the initial-generation allowance or the image entitlement. Do not set a pretend `FREE_GENERATIONS_LIMIT` variable unless the backend and SQL are explicitly updated to read and enforce it.
