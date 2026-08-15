# NeerMela API — v1 Foundation

An **API-first, modular-monolith** backend for the NeerMela platform, built to the
*Universal API Platform* master spec. Everything (mobile app, web app, admin, business,
future developer apps) talks to **one versioned API** — never to the database directly.

```
Mobile / Web / Admin / Business
              │  HTTPS + Bearer JWT
              ▼
        API Gateway  (auth · rate-limit · idempotency · request-id · logging)
              ▼
      NeerMela API (v1)   ── modular monolith, domain-separated
   auth · users · messaging · media · (roadmap: social, business, payment, ai, …)
              ▼
   PostgreSQL   Redis   Object Storage (GCS)   WebSocket realtime
```

This is **Year-1 of the roadmap** (§96): the foundation that everything else builds on.
It starts as a monolith on purpose (§79) and splits into services later without changing
the public API contract.

## What's implemented and tested

- **Auth (§4–§10)** — SMS/Email **OTP** send + verify, argon2-hashed codes (never plaintext),
  attempt/rate/resend limits, find-or-create user, **JWT access token** + **rotating refresh
  token** with reuse detection, sessions / linked-device list + revoke.
- **Users (§11)** — `me`, update profile, public profile by id/@username, scheduled deletion.
- **Messaging (§13–§14)** — DM/group chats, send/edit/delete messages, read receipts,
  cursor pagination, and **real-time fan-out over WebSocket** (`/v1/realtime`).
- **Media (§21)** — signed-URL **direct-to-storage** upload (big files never touch the API).
- **Gateway (§3)** — request id on every response, structured access logs, per-bucket rate
  limits (stricter for OTP/login), **idempotency keys** (§60), unified error envelope (§58/§59).
- **Provider abstraction (§99)** — SMS, Email, Storage, AI, Payment are swappable adapters.
  Change `*_PROVIDER` env vars; the public API contract never breaks.
- **Audit log (§49)**, **health/readiness (§57)**, **OpenAPI 3.1 spec**, **domain-separated
  Postgres schema (§23)**, Docker + Compose (§54/§55).

Every endpoint above was run end-to-end against real Postgres + Redis (auth → chat → message,
idempotency replay, wrong-OTP rejection, auth enforcement, WebSocket delivery).

## Run it locally

**Option A — Docker (everything):**
```bash
cp .env.example .env
docker compose up --build
# API on http://localhost:8080 ; schema auto-migrates on boot
```

**Option B — Node + your own Postgres/Redis:**
```bash
cp .env.example .env          # set DATABASE_URL / REDIS_URL
npm install
npm run migrate               # apply db/schema.sql
npm run seed                  # optional demo users
npm start
```

Health check: `curl localhost:8080/health` → `{"status":"healthy","version":"1.0.0"}`

## Try the auth flow (mock SMS prints the code to the server log)

```bash
# 1) send OTP
curl -s -XPOST localhost:8080/v1/auth/otp/send \
  -H 'Content-Type: application/json' \
  -d '{"channel":"sms","phone":"+971526969855"}'
#   → { "success":true, "data":{ "challenge_id":"CH_…", "expires_in":300 }, "request_id":"REQ_…" }

# 2) read the 6-digit code from the API log, then verify
curl -s -XPOST localhost:8080/v1/auth/otp/verify \
  -H 'Content-Type: application/json' \
  -d '{"challenge_id":"CH_…","code":"483921"}'
#   → returns user + access_token + refresh_token

# 3) call an authed endpoint
curl -s localhost:8080/v1/users/me -H 'Authorization: Bearer <access_token>'
```

## Response envelopes (§58/§59)

Success:
```json
{ "success": true, "data": { }, "request_id": "REQ_…" }
```
Error:
```json
{ "success": false, "error": { "code": "OTP_EXPIRED", "message": "Verification code has expired.", "request_id": "REQ_…" } }
```

## Project layout

```
src/
  config/        env-driven config, no hardcoded secrets (§50, §90)
  db/            pg pool, migrate, seed
  cache/         redis (otp state, rate-limit, presence, idempotency) (§24)
  gateway/       request-id, auth, rate-limit, idempotency, error handler (§3)
  adapters/      sms · email · storage · ai · payment  (swappable, §99)
  modules/
    auth/        OTP, sessions, tokens (§4–§10)
    users/       profile (§11)
    messaging/   chats, messages, ws realtime (§13–§14)
    media/       signed-URL uploads (§21)
    health/      liveness/readiness (§57)
  routes.js      mounts /v1/*  (roadmap routes return 501 until built)
  server.js      express + websocket entry
db/schema.sql    domain-separated Postgres schema (§23)
openapi.yaml     OpenAPI 3.1 contract for v1
```

## How your existing apps connect

- **NeerMela mobile app / admin panel** already speak snake_case JSON and OTP flows — point
  them at `http://localhost:8080/v1` (or `https://api.neermela.com/v1`). Replace the app's
  Supabase adapter with these endpoints when you're ready; the message shapes line up.
- The app's **Live mode** (Supabase) can keep working during the transition — migrate module
  by module.

## Swapping in real providers

| Concern      | Env var            | Where to implement                              |
|--------------|--------------------|-------------------------------------------------|
| SMS OTP      | `SMS_PROVIDER`     | `src/adapters/sms/index.js` (Twilio / BD gw)    |
| Email OTP    | `EMAIL_PROVIDER`   | `src/adapters/email/index.js`                   |
| Media store  | `STORAGE_PROVIDER` | `src/adapters/storage/index.js` (GCS signed URL)|
| NeerMela AI  | `AI_PROVIDER`      | `src/adapters/ai/index.js` (Gemini)             |
| Payments     | `PAYMENT_PROVIDER` | `src/adapters/payment/index.js` (bKash/Nagad)   |

Each adapter has a working `mock` and a stubbed real provider with the exact call you fill in.

## Security posture (§50)

TLS everywhere, secrets only via env / secret manager, argon2 for OTP hashes, rotating
refresh tokens with reuse detection, parameterized queries only, per-route rate limits,
helmet headers, CORS allow-list, request-id tracing, audit log for sensitive actions.
For production, set **RS256** `JWT_PRIVATE_KEY`/`JWT_PUBLIC_KEY` instead of the dev secret.

## Roadmap mapping (§96)

- **Year 1 (this):** auth, users, chat, groups, media, notifications, calls signalling, business account, API foundation.
- **Year 2+:** social feed / stories / reels / channels, business CRM, catalogue, orders.
- **Year 3+:** developer portal, OAuth, webhooks, SDK, payments, marketing, ads.
- Roadmap routes are mounted and return `501 NOT_IMPLEMENTED` so the surface is discoverable
  and can be filled in without restructuring.

## Not built yet (deliberately — later phases)

Developer portal / OAuth server, webhooks with retry + DLQ, ads, marketplace, billing meters,
E2EE key management, SDKs, multi-tenant enterprise. The architecture leaves clean seams for
all of them (adapters, domain modules, event hooks).

— CineFilm Media · NeerMela API v1.0.0
