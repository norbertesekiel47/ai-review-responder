# Multi-Location Mission — Readiness Check

**Date:** 2026-05-07
**Working dir:** `C:\Users\norbe\Desktop\RepWorth`
**Branch:** `chore/fallow-health-cleanup`
**Shell:** Windows PowerShell 5.1
**Method:** All checks executed live (real commands, real network probes). No code modified, no packages installed.

---

## Summary

**🟡 YELLOW — mission can run, but with caveats.** Toolchain, Stripe (CLI + API + price IDs), Supabase, Resend, OpenAI, Anthropic, and local Redis are all operational. Three meaningful gaps must be acknowledged or addressed before the mission can exercise SMS/WhatsApp paths or any error-monitoring hooks: (1) Twilio auth token is a placeholder (HTTP 401 from `/Accounts/{SID}.json`) — fine while `CHANNELS_SMS_ENABLED=false` / `CHANNELS_WHATSAPP_ENABLED=false`, but blocks any test that flips those flags, (2) Sentry DSN/auth token are unset — Sentry-related work is no-op, (3) production Redis (Upstash) tokens are absent — only local Redis on `localhost:6379` is available, so any check that targets the production cache/queue topology must run against the local instance.

---

## Toolchain

### 1. Node + pnpm + tsx

| Tool | Version | Status |
| --- | --- | --- |
| `node --version` | `v22.14.0` | ✅ |
| `pnpm --version` | `10.17.1` | ✅ |
| `pnpm exec tsx --version` | `tsx v4.21.0` (Node v22.14.0) | ✅ |

### 2. TypeScript / Next.js / Vitest / Playwright

| Tool | Version | Status |
| --- | --- | --- |
| `pnpm exec tsc --version` | `Version 5.9.3` | ✅ |
| `pnpm exec next --version` | `Next.js v14.2.35` | ✅ |
| `pnpm exec vitest --version` | `vitest/4.1.2 win32-x64 node-v22.14.0` | ✅ |
| `pnpm exec playwright --version` | `Version 1.59.1` | ✅ |

All four binaries resolve and report version without errors. No tests were executed — only binary reachability was confirmed.

### 3. Stripe CLI

- Path: `C:\Users\norbe\Desktop\RepWorth\stripe.exe`
- `stripe --version` → `stripe version 1.40.3` ✅
- `stripe config --list` →
  - `project-name = 'default'`
  - Profile `[default]`
    - `account_id = 'acct_1TJ0TL2ZehYF3mcP'`
    - `device_name = 'LAPTOP-TSD1JB40'`
    - `display_name = 'RepWorth sandbox'`
    - `test_mode_api_key` present (redacted)
    - `test_mode_pub_key` present (redacted)
- The CLI is logged in to the **RepWorth sandbox** test-mode account. No restricted-key or live-mode profile is configured.

---

## External services

### 4. Supabase connectivity

- `NEXT_PUBLIC_SUPABASE_URL`: set
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`: set
- `SUPABASE_URL`: set
- `SUPABASE_SERVICE_KEY`: set
- `DATABASE_URL` / `DATABASE_POOL_URL`: set

Probes:
- `GET /rest/v1/` with `apikey: <SERVICE_KEY>` → **200** ✅
- `GET /auth/v1/health` with `apikey: <ANON_KEY>` → **200** ✅
- `GET /rest/v1/` with anon `apikey + Authorization: Bearer <ANON_KEY>` → 401 (expected — REST root rejects anon access on this project; not a blocker)

Project at `udeyaqnvpojbwgoaxwdg.supabase.co` is reachable, the service role authenticates, and the auth subsystem is healthy.

### 5. Stripe API connectivity

- `STRIPE_SECRET_KEY` (test mode): set
- `GET /v1/prices?limit=1` (basic auth) → **200** ✅

### 6. Resend API connectivity

- `RESEND_API_KEY`: set
- `GET https://api.resend.com/domains` → **200** ✅

### 7. Twilio API connectivity

- `TWILIO_ACCOUNT_SID`: looks real (starts with `A`, length 34)
- `TWILIO_AUTH_TOKEN`: **placeholder** (`xxxx…`, length 32)
- `TWILIO_MESSAGING_SERVICE_SID`: placeholder (`MGxx…`)
- `TWILIO_VERIFY_SERVICE_SID`: placeholder (`VAxx…`)
- `GET https://api.twilio.com/2010-04-01/Accounts/{SID}.json` → **401** ❌

Currently safe because `CHANNELS_SMS_ENABLED=false` and `CHANNELS_WHATSAPP_ENABLED=false`, but any mission step that flips either flag, exercises SMS dispatch, OTP verify, or WhatsApp send will fail at the worker boot-time assertion or on the first API call.

### 8. OpenAI / Anthropic

- `OPENAI_API_KEY` → `GET /v1/models` → **200** ✅
- `ANTHROPIC_API_KEY` → `GET /v1/models` (with `anthropic-version: 2023-06-01`) → **200** ✅

### 10. Stripe price IDs

| Tier | Status | Type | Recurring | Active | Amount | Currency |
| --- | --- | --- | --- | --- | --- | --- |
| FOUNDING | 200 ✅ | recurring | month | true | 9900 | usd |
| STANDARD | 200 ✅ | recurring | month | true | 14900 | usd |
| PREMIUM | 200 ✅ | recurring | month | true | 24900 | usd |

All three configured price IDs (`STRIPE_PRICE_FOUNDING/STANDARD/PREMIUM`) exist on the Stripe sandbox account, are active, and are monthly recurring USD prices at $99 / $149 / $249.

---

## Redis

### 9. Cache + queue

- `REDIS_CACHE_URL`: set (`redis://localhost:6379/0`)
- `REDIS_QUEUE_URL`: set (`redis://localhost:6379/1`)
- `REDIS_CACHE_TOKEN`: missing
- `REDIS_QUEUE_TOKEN`: missing
- `Test-NetConnection localhost -Port 6379` → `TcpTestSucceeded=True`, RemoteAddress `::1` ✅
- `redis-cli`: not on PATH (per task rules: NOT installed)

Local Redis daemon is listening on `127.0.0.1:6379`. Production Upstash credentials are absent (commented in `.env.example`); any mission step that requires the production Upstash REST topology will not have credentials in this environment.

---

## Env var inventory

Presence-only check (set / placeholder / missing). Values are never echoed.

| Variable | Status |
| --- | --- |
| DATABASE_URL | set |
| DATABASE_POOL_URL | set |
| SUPABASE_URL | set |
| SUPABASE_SERVICE_KEY | set |
| NEXT_PUBLIC_SUPABASE_URL | set |
| NEXT_PUBLIC_SUPABASE_ANON_KEY | set |
| STRIPE_SECRET_KEY | set |
| STRIPE_WEBHOOK_SECRET | set |
| STRIPE_PAYMENT_LINK_FOUNDING | set |
| STRIPE_PAYMENT_LINK_STANDARD | set |
| STRIPE_PAYMENT_LINK_PREMIUM | set |
| STRIPE_PRICE_FOUNDING | set |
| STRIPE_PRICE_STANDARD | set |
| STRIPE_PRICE_PREMIUM | set |
| REDIS_CACHE_URL | set |
| REDIS_QUEUE_URL | set |
| REDIS_CACHE_TOKEN | missing |
| REDIS_QUEUE_TOKEN | missing |
| OPENAI_API_KEY | set |
| ANTHROPIC_API_KEY | set |
| RESEND_API_KEY | set |
| RESEND_WEBHOOK_SECRET | set |
| RESEND_FROM_EMAIL | set |
| TWILIO_ACCOUNT_SID | set (real-shaped, length 34, `A…`) |
| TWILIO_AUTH_TOKEN | placeholder (`xxxx…`) |
| TWILIO_MESSAGING_SERVICE_SID | placeholder (`MGxx…`) |
| TWILIO_VERIFY_SERVICE_SID | placeholder (`VAxx…`) |
| TELEGRAM_BOT_TOKEN | set |
| TELEGRAM_WEBHOOK_SECRET | set |
| TELEGRAM_BOT_USERNAME | set (`RepWorthBot`) |
| CHANNELS_SMS_ENABLED | set (`false`) |
| CHANNELS_TELEGRAM_ENABLED | set (`true`) |
| CHANNELS_WHATSAPP_ENABLED | set (`false`) |
| SELF_SERVE_SIGNUP_ENABLED | set (`true`) |
| SESSION_COOKIE_SECRET | set |
| CSRF_SECRET | set |
| ENCRYPTION_KEY | set |
| ENCRYPTION_KEY_VERSION | set (`1`) |
| SERPAPI_API_KEY | set |
| NEXT_PUBLIC_GOOGLE_MAPS_API_KEY | set |
| SENTRY_DSN | missing |
| NEXT_PUBLIC_SENTRY_DSN | missing |
| SENTRY_AUTH_TOKEN | missing |

Notable extras present in `.env.local` (not in the requested list, surfaced for context only):
- `FIRECRAWLAPI`, `WORKER_PUBLIC_URL` (Cloudflare tunnel hostname), `MOCK_EXTERNAL_APIS=false`, `RANKING_TRACKING_ENABLED=false`
- `ZERNIO_PUBLISHING_ENABLED=true`, `ZERNIO_API_KEY`, `ZERNIO_WEBHOOK_SECRET`
- `EXTERNAL_REPLY_IMPORT_ENABLED=true`, `PAST_REPLIES_VIEW_ENABLED=true`
- `ONBOARDING_DEMO_ENABLED=true`, `ONBOARDING_DEMO_DAILY_CENTS=100`
- `OWNER_LEADS_GOOGLE_SHEET_ID`, `OWNER_LEADS_GOOGLE_SHEET_RANGE`, `GOOGLE_SHEETS_CLIENT_EMAIL`, `GOOGLE_SHEETS_PRIVATE_KEY`
- `ALLOW_E2E_DB_WRITES=true`, `TEST_DATABASE_POOL_URL`

---

## Resources

- Total physical RAM: **15.25 GB** (CsTotalPhysicalMemory `16,371,511,296`)
- Logical processors: **16**
- Total processes: **512**
- Top working-set consumers (MB):

  | Process | PID | WS (MB) |
  | --- | --- | --- |
  | Antigravity | 32288 | 560.5 |
  | Memory Compression | 4924 | 514.9 |
  | node | 47640 | 412.0 |
  | Antigravity | 24532 | 410.0 |
  | MsMpEng | 6640 | 338.2 |
  | droid | 42208 | 278.9 |
  | Codex | 40744 | 271.0 |
  | vmmemWSL | 12624 | 270.8 |
  | chrome | 44400 | 257.9 |
  | chrome | 22748 | 232.6 |

Heavy consumers worth flagging: two `Antigravity` instances (~970 MB combined), `vmmemWSL` (WSL2 backing process — typically grows under load), `MsMpEng` (Defender), and 512 total processes is high for a 16 GB box. Headroom for a long Vitest + Next.js dev server + worker run is acceptable but not generous — if the mission spawns multiple dev servers in parallel, expect tight memory.

---

## Blockers

Nothing **prevents** the mission from running in its currently-flagged configuration. Soft blockers per scenario:

1. **SMS-flow exercises** — flipping `CHANNELS_SMS_ENABLED=true` will fail because `TWILIO_AUTH_TOKEN` is a placeholder (Twilio API returns 401). The worker has a boot-time assertion for SMS that will throw unless `MOCK_EXTERNAL_APIS=true`.
2. **WhatsApp-flow exercises** — same reason; `TWILIO_WHATSAPP_NUMBER` and `WHATSAPP_APPROVAL_TEMPLATE_SID` are also empty.
3. **Sentry-related verification** — `SENTRY_DSN` / `NEXT_PUBLIC_SENTRY_DSN` / `SENTRY_AUTH_TOKEN` are unset. The recently-merged Sentry scrubber consolidation (PR-merged commit `6c272c5`) is dormant in this environment; any mission step that wants to confirm scrubbed events flow to Sentry needs a DSN.
4. **Upstash production-shape Redis verification** — only local Redis is reachable; `REDIS_CACHE_TOKEN` and `REDIS_QUEUE_TOKEN` are missing. Mission steps that touch the Upstash REST client path cannot run without setting those.

Everything in the green path (Stripe + Supabase + Resend + OpenAI + Anthropic + Telegram credentials present + local Redis) is wired up and live.

---

## Recommendations for `missionDir`

Concrete actions for the parent agent / mission designer:

1. **Document a clear mission scope w.r.t. channels.** State up front whether the multi-location mission needs SMS / WhatsApp. If yes, the user must either (a) supply real `TWILIO_AUTH_TOKEN` + `TWILIO_MESSAGING_SERVICE_SID` + `TWILIO_VERIFY_SERVICE_SID` (and for WhatsApp: `TWILIO_WHATSAPP_NUMBER`, `WHATSAPP_APPROVAL_TEMPLATE_SID`, `WHATSAPP_APPROVAL_URL_BASE`), or (b) set `MOCK_EXTERNAL_APIS=true` for the duration of the mission. Default assumption: scope to Telegram + email only and leave SMS/WhatsApp flags off.
2. **Decide on Sentry.** If the mission touches error monitoring, the user must add `SENTRY_DSN` and `NEXT_PUBLIC_SENTRY_DSN` (same value), plus `SENTRY_ORG` / `SENTRY_PROJECT` / `SENTRY_AUTH_TOKEN` if source-map uploads matter. Otherwise the mission spec should say "Sentry is intentionally inert in this environment."
3. **Pin Redis topology.** Recommend the mission run against local Redis (`localhost:6379`, DB 0 + DB 1) and ensure the local Redis daemon stays up for the duration of the run. If a step has any Upstash-specific code path, gate it behind `REDIS_CACHE_TOKEN`-presence or skip it.
4. **Allowlists for outbound HTTP probes.** Confirmed reachable from this machine: `*.supabase.co`, `api.stripe.com`, `api.resend.com`, `api.openai.com`, `api.anthropic.com`, `api.twilio.com` (auth fails but TCP/TLS works), `localhost:6379`. No firewall surprises encountered. The `WORKER_PUBLIC_URL` Cloudflare tunnel hostname (`*.trycloudflare.com`) was not validated as live — the mission should re-verify with a `curl` to that URL if it depends on inbound webhook delivery.
5. **Resource hygiene.** Before the mission spins up `pnpm dev` + worker + Vitest + Playwright in parallel, suggest the user close at least one Antigravity window and any Codex/droid sessions that are not active. With 15.25 GB RAM and 512 background processes, parallel-test runs may swap.
6. **Stripe CLI is sandbox-only.** Webhooks forwarded via `stripe listen` will hit the test-mode account `acct_1TJ0TL2ZehYF3mcP` ("RepWorth sandbox"). The mission should not assume production Stripe data is reachable from here.
7. **Repo hygiene note (informational).** A malformed file `C?UsersnorbeDesktopRepWorth.fallow-health.json` exists in repo root (left over from an earlier session). Not a mission blocker but worth deleting before creating new artifacts in the same directory.
