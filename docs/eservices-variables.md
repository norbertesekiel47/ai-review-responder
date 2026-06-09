# RepWorth — External Services & Environment Variables

A catalogue of every third-party service RepWorth integrates with, plus a full
inventory of environment variables the code actually reads — cross-checked
against `.env.example`.

- **Last verified:** 2026-05-29 (by codebase scan — see §4 to reproduce).
- **Canonical files:** `.env.example` is the copy-paste template; this doc is the
  service map + var index + drift report. Deep per-flag *behavior* lives in
  `.claude/reference/env-vars.md` — don't duplicate it here.
- **Scan result:** 119 distinct `process.env.*` reads in code vs 82 vars then in
  `.env.example`. 34 real app vars were missing (now added); 3 were vestigial
  (now retired).

---

## 1. External services

| Service | Purpose | Integration point | Env prefix | Runs on |
|---|---|---|---|---|
| **Vercel** | Hosts the Next.js UI | platform | `NEXT_PUBLIC_*`, `VERCEL_*` (injected) | — |
| **Railway** | Hosts the Fastify + BullMQ worker | platform | `PORT` (injected), `WORKER_PUBLIC_URL` | — |
| **Supabase** | Postgres DB + Auth + Storage | `@supabase/supabase-js`, `@supabase/ssr`, `postgres` (Postgres.js) | `DATABASE_*`, `SUPABASE_*`, `NEXT_PUBLIC_SUPABASE_*` | both |
| **Upstash Redis** | Cache **and** BullMQ queue (two separate instances) | `ioredis`, `bullmq` | `REDIS_CACHE_*`, `REDIS_QUEUE_*` | worker |
| **OpenAI** | Primary LLM (`gpt-4o-mini`) + Moderation API | `openai` | `OPENAI_*` | worker |
| **Anthropic** | Fallback LLM (`claude-haiku-4-5-20251001`) | `@anthropic-ai/sdk` | `ANTHROPIC_API_KEY` | worker |
| **Zernio** | **GBP review ingestion + reply posting** (core) | custom client `src/lib/zernio/*` (no SDK) | `ZERNIO_*` | worker |
| **SerpAPI** | Review/ranking data prefill | `serpapi` | `SERPAPI_*` | worker |
| **Google Maps Platform** | Onboarding PlaceAutocomplete (Essentials tier) | `@googlemaps/js-api-loader` | `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` | browser |
| **Google Sheets** | Optional owner-lead mirror (service-account JWT) | REST/JWT | `OWNER_LEADS_*`, `GOOGLE_SHEETS_*` | server |
| **Google GBP API** | *Phase 5 — not yet wired* | placeholder | `GOOGLE_CLIENT_*`, `GCP_PROJECT_ID` | — |
| **Resend** | Transactional + marketing email + custom SMTP | `resend` | `RESEND_*`, `LIST_UNSUBSCRIBE_*`, `CONTACT_NOTIFY_TO`, `ADMIN_NOTIFICATION_EMAIL` | worker |
| **Twilio** | SMS / WhatsApp / Verify OTP (*channel flags off by default*) | `twilio` | `TWILIO_*`, `WHATSAPP_*`, `SMS_*` | worker |
| **Telegram** | Bot approval channel (*flag off by default*) | raw Bot API (no SDK) | `TELEGRAM_*` | worker |
| **Stripe** | Subscriptions / billing (Checkout Sessions + webhooks) | `stripe` | `STRIPE_*` | both |
| **Sentry** | Error tracking (browser + server + worker) | `@sentry/nextjs`, `@sentry/node` | `SENTRY_*`, `NEXT_PUBLIC_SENTRY_DSN` | both |
| **PostHog** | Product analytics (server/worker only) | `posthog-node` | `POSTHOG_*` | worker |

---

## 2. Environment variable inventory

**Legend:** ✅ in code + `.env.example` · 🟢 added to `.env.example` in the
2026-05-29 pass · 🔸 retired as vestigial · 🧩 future placeholder · 🧪 test/CI
only · ⚙️ platform-injected (not app config).

### Database (Supabase)
| Var | Status | Note |
|---|---|---|
| `DATABASE_URL` | ✅ | direct (5432) — migrations/tooling; **not** read by app runtime |
| `DATABASE_POOL_URL` | ✅ | pooled (6543, PgBouncer) — app runtime |
| `SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_URL` | ✅ | |
| `SUPABASE_SERVICE_KEY` | ✅ | server-only |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | ✅ | browser-safe |

### Redis (Upstash)
`REDIS_CACHE_URL` ✅ · `REDIS_CACHE_TOKEN` ✅ · `REDIS_QUEUE_URL` ✅ · `REDIS_QUEUE_TOKEN` ✅

### LLM
`OPENAI_API_KEY` ✅ · `ANTHROPIC_API_KEY` ✅ · `OPENAI_MODERATION_ENABLED` 🟢 (worker-only moderation gate, fail-open)

### Reviews / GBP
| Var | Status | Note |
|---|---|---|
| `ZERNIO_PUBLISHING_ENABLED` | 🟢 | master flag (ingestion **and** posting) |
| `ZERNIO_API_KEY` | 🟢 | **required when flag on** |
| `ZERNIO_WEBHOOK_SECRET` | 🟢 | **required when flag on**; HMAC, must match Zernio dashboard |
| `ZERNIO_API_BASE` | 🟢 | optional — sandbox override |
| `ZERNIO_PROFILE_ID_PREFIX` | 🟢 | optional — prod/staging/local collision guard |
| `ZERNIO_INGEST_MAX_PAGES` | 🟢 | optional — backfill page cap |
| `ZERNIO_RECENT_REVIEW_POLL_DISABLED` | 🟢 | optional |
| `ZERNIO_RECENT_REVIEW_POLL_MAX_PAGES` | 🟢 | optional |
| `SERPAPI_API_KEY` | ✅ | |
| `SERPAPI_TIMEOUT_MS` | 🟢 | optional |
| `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` | ✅ | referrer-locked |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GCP_PROJECT_ID` | 🧩 | Phase-5 GBP API placeholders |

### Email (Resend) & lead intake
`RESEND_API_KEY` ✅ · `RESEND_WEBHOOK_SECRET` ✅ · `RESEND_FROM_EMAIL` ✅ · `ADMIN_NOTIFICATION_EMAIL` ✅ · `CONTACT_NOTIFY_TO` ✅ · `LIST_UNSUBSCRIBE_EMAIL` ✅ (mailto fallback) · `LIST_UNSUBSCRIBE_URL` 🟢 (one-click https endpoint — distinct var) · `OWNER_LEADS_GOOGLE_SHEET_ID` ✅ · `OWNER_LEADS_GOOGLE_SHEET_RANGE` ✅ · `GOOGLE_SHEETS_CLIENT_EMAIL` ✅ · `GOOGLE_SHEETS_PRIVATE_KEY` ✅

### Payments (Stripe)
`STRIPE_SECRET_KEY` ✅ · `STRIPE_WEBHOOK_SECRET` ✅ · `STRIPE_PRICE_BASIC` / `_FOUNDING` / `_FOUNDERS_OVERAGE` / `_STANDARD` / `_STANDARD_OVERAGE` / `_PREMIUM` / `_PREMIUM_OVERAGE` ✅ (Payment Links deprecated)

### Channels (Twilio / Telegram) — flags off by default
SMS: `CHANNELS_SMS_ENABLED` ✅ · `TWILIO_ACCOUNT_SID` ✅ · `TWILIO_AUTH_TOKEN` ✅ · `TWILIO_MESSAGING_SERVICE_SID` ✅ · `TWILIO_VERIFY_SERVICE_SID` ✅ · `SMS_DAILY_LIMIT_CENTS_PER_BUSINESS` ✅ · `SMS_DAILY_LIMIT_CENTS_GLOBAL` ✅
Telegram: `CHANNELS_TELEGRAM_ENABLED` ✅ · `TELEGRAM_BOT_TOKEN` ✅ · `TELEGRAM_WEBHOOK_SECRET` ✅ · `TELEGRAM_BOT_USERNAME` ✅
WhatsApp: `CHANNELS_WHATSAPP_ENABLED` ✅ · `TWILIO_WHATSAPP_NUMBER` ✅ · `WHATSAPP_APPROVAL_TEMPLATE_SID` ✅ · `WHATSAPP_APPROVAL_URL_BASE` ✅

### Security / secrets
| Var | Status | Note |
|---|---|---|
| `SESSION_COOKIE_SECRET` | ✅ | |
| `CSRF_SECRET` | ✅ | |
| `IMPERSONATION_COOKIE_SECRET` | ✅ | HMAC-SHA256, ≥32 chars |
| `ENCRYPTION_KEY` / `ENCRYPTION_KEY_VERSION` | 🔸 | **Retired.** No references anywhere in code (no symmetric crypto exists; tokens are SHA-256 *hashed*). Commented out in `.env.example` pending full removal. |

### App / worker URLs
| Var | Status | Note |
|---|---|---|
| `NEXT_PUBLIC_APP_URL` | ✅ | |
| `WORKER_PUBLIC_URL` | ✅ | public worker origin (webhook signature base + SMS statusCallback); 10 code refs |
| `WORKER_SERVICE_URL` | 🔸 | **Retired.** 0 code refs — superseded by `WORKER_PUBLIC_URL`. Commented out pending removal. |

### Observability
`SENTRY_DSN` ✅ · `NEXT_PUBLIC_SENTRY_DSN` ✅ · `SENTRY_ORG` ✅ · `SENTRY_PROJECT` ✅ · `SENTRY_AUTH_TOKEN` ✅ · `POSTHOG_API_KEY` ✅ · `POSTHOG_HOST` ✅ · `LOG_SERVICE` 🟢 (log-label, cosmetic)

### Feature flags
`SELF_SERVE_SIGNUP_ENABLED` ✅ · `RANKING_TRACKING_ENABLED` ✅ · `EDIT_REPLIES_ENABLED` ✅ · `MULTI_LOCATION_ENABLED` 🟢 · `ONBOARDING_DEMO_ENABLED` 🟢 · `EXTERNAL_REPLY_IMPORT_ENABLED` 🟢 · `PAST_REPLIES_VIEW_ENABLED` 🟢 · `MFA_ENFORCEMENT_ENABLED` 🟢 · `AUTO_APPROVAL_ENABLED` 🟢 · `AUTO_APPROVAL_PROVIDER_MODERATION_READY` 🟢 · `ACCOUNT_OFFBOARDING_ENABLED` 🟢 · `OPENAI_MODERATION_ENABLED` 🟢 (listed under LLM)
> Behavior of each flag: `.claude/reference/env-vars.md`. All are server-authoritative — never add a `NEXT_PUBLIC_*` companion.

### Costs
`GLOBAL_DAILY_COST_LIMIT_CENTS` ✅ · `DAILY_COST_LIMIT_CENTS_FOUNDING` ✅ · `DAILY_COST_LIMIT_CENTS_STANDARD` ✅ · `DAILY_COST_LIMIT_CENTS_PREMIUM` 🟢 (the tier the example had dropped) · `ONBOARDING_DEMO_DAILY_CENTS` 🟢 · `ONBOARDING_DEMO_STAFF_EMAILS_CSV` 🟢

### Poller / scheduler tuning — all optional, code defaults; 🟢 added as commented docs
`OUTBOX_POLL_INTERVAL_MS` · `OUTBOX_BATCH_SIZE` · `ARCHIVAL_INTERVAL_MS` · `CANCELLATION_GRACE_INTERVAL_MS` · `ENGAGEMENT_MONITOR_INTERVAL_MS` · `EMAIL_CHANNEL_RECONCILE_INTERVAL_MS` / `_BATCH_SIZE` / `_DISABLED` · `ANALYTICS_DISPATCH_POLL_INTERVAL_MS` / `_BATCH_SIZE` · `STRIPE_LOCATIONS_RECONCILE_INTERVAL_MS` / `_DISABLED` · `MONTHLY_IMPACT_SCHEDULER_INTERVAL_MS` · `WEEKLY_SUMMARY_SCHEDULER_INTERVAL_MS` · `ONBOARDING_DRIP_INTERVAL_MS` · `NOTIFICATION_FAILOVER_INTERVAL_MS` / `_DISABLED` · `CLEANUP_ABANDONED_SIGNUPS_INTERVAL_MS` / `_BATCH_SIZE` · `RANKING_TRACKING_INTERVAL_MS`

### Docs / misc
`NEXT_PUBLIC_DOCS_BASE_URL` 🟢 (makes `/admin/runbook` names clickable) · `MOCK_EXTERNAL_APIS` ✅

### Test / CI only — 🟢 documented under a test section
`TEST_DATABASE_POOL_URL` · `PLAYWRIGHT_BASE_URL` · `ALLOW_E2E_DB_WRITES` · `E2E_ADMIN_TEST_BUSINESS_ID`

### Platform-injected — ⚙️ never put in `.env.example`
`NODE_ENV` · `NEXT_RUNTIME` · `PORT` · `CI` · `VERCEL_GIT_COMMIT_SHA`

---

## 3. Drift report (snapshot at scan time)

- **Missing from `.env.example`, read by code (34):** the full Zernio family (8),
  6 feature flags, `DAILY_COST_LIMIT_CENTS_PREMIUM`, `LIST_UNSUBSCRIBE_URL`,
  `LOG_SERVICE`, `NEXT_PUBLIC_DOCS_BASE_URL`, `SERPAPI_TIMEOUT_MS`,
  `ONBOARDING_DEMO_DAILY_CENTS`, the poller/scheduler intervals, and 4 test vars.
  → **All added** (required ones as live keys, optional ones commented with notes).
- **In `.env.example`, never read by code (vestigial):** `ENCRYPTION_KEY`,
  `ENCRYPTION_KEY_VERSION`, `WORKER_SERVICE_URL`. → **Commented out** with a note;
  remove fully once confirmed in a follow-up. (`DATABASE_URL` and the Phase-5
  `GOOGLE_*` placeholders are *not* vestigial — kept intentionally.)
- **False positive:** `X` — appears only inside a code comment.

---

## 4. How to regenerate this scan

```bash
EXCL="--exclude-dir=node_modules --exclude-dir=.next --exclude-dir=.git --exclude-dir=dist --exclude-dir=build --exclude-dir=coverage --exclude-dir=graphify-out --exclude-dir=.claude"

# every var read by code
grep -rhoE "process\.env\.[A-Za-z_][A-Za-z0-9_]*|process\.env\[['\"][A-Za-z_][A-Za-z0-9_]*['\"]\]" $EXCL \
  --include="*.ts" --include="*.tsx" --include="*.js" --include="*.mjs" --include="*.cjs" . \
  | sed -E "s/process\.env\.//; s/process\.env\[['\"]//; s/['\"]\]//" | sort -u > /tmp/codevars.txt

# every var documented in the template
grep -oE "^#?[[:space:]]*[A-Z_][A-Z0-9_]*=" .env.example | sed -E "s/^#//; s/[[:space:]]//g; s/=//" | sort -u > /tmp/examplevars.txt

comm -23 /tmp/codevars.txt /tmp/examplevars.txt   # in code, missing from template
comm -13 /tmp/codevars.txt /tmp/examplevars.txt   # in template, not read by code
```
