# RepWorth — External Services & Environment Variables

A catalogue of every third-party service RepWorth integrates with, plus a full
inventory of environment variables the code actually reads — cross-checked
against `.env.example`.

- **Last verified:** 2026-07-15 (WS8 tier/cutover sweep; original full scan
  procedure remains in §4).
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
| **Google Maps Platform** | Onboarding PlaceAutocomplete; separate Admin Demos picker under ADR 0030 D4's named browser exception | `@googlemaps/js-api-loader` | `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` | browser |
| **Google Sheets** | Optional owner-lead mirror (service-account JWT) | REST/JWT | `OWNER_LEADS_*`, `GOOGLE_SHEETS_*` | server |
| **Google GBP API** | *Phase 5 — not yet wired* | placeholder | `GOOGLE_CLIENT_*`, `GCP_PROJECT_ID` | — |
| **Resend** | Transactional + marketing email + custom SMTP | `resend` | `RESEND_*`, `LIST_UNSUBSCRIBE_*`, `CONTACT_NOTIFY_TO`, `ADMIN_NOTIFICATION_EMAIL` | worker |
| **Twilio** | WhatsApp (*channel flag off by default*) | `twilio` | `TWILIO_*`, `WHATSAPP_*` | worker |
| **Telegram** | Bot approval channel (*flag off by default*) | raw Bot API (no SDK) | `TELEGRAM_*` | worker |
| **Stripe** | Subscriptions / billing (Checkout Sessions + webhooks) | `stripe` | `STRIPE_*` | both |
| **Sentry** | Error tracking (browser + server + worker) | `@sentry/nextjs`, `@sentry/node` | `SENTRY_*`, `NEXT_PUBLIC_SENTRY_DSN` | both |
| **PostHog** | Product analytics (server/worker only) | `posthog-node` | `POSTHOG_*` | worker |

---

## 2. Environment variable inventory

**Format contract (since 2026-08-24, #918):** one variable per table row; the
first cell holds exactly one backticked name. `ci:env-registry` parses ONLY
that name cell — a var mentioned in another row's prose does not count as
registered — and fails on the old inline-list / slash-separated shapes.

**Legend:** ✅ in code + `.env.example` · 🟢 added to `.env.example` in the
2026-05-29 pass · ⬜ inventoried in the 2026-08-24 #918 audit pass (read by
production code; `.env.example` coverage not re-audited) · 🔸 retired as
vestigial · 🧩 future placeholder · 🧪 test/CI only · ⚙️ platform-injected
(not app config).

### Database (Supabase / Postgres)
| Var | Status | Note |
|---|---|---|
| `DATABASE_URL` | ✅ | direct (5432) — migrations/tooling; **not** read by app runtime |
| `DATABASE_POOL_URL` | ✅ | pooled (6543, PgBouncer) — app runtime |
| `SUPABASE_URL` | ✅ | |
| `NEXT_PUBLIC_SUPABASE_URL` | ✅ | browser-safe sibling of `SUPABASE_URL` |
| `SUPABASE_SERVICE_KEY` | ✅ | server-only |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | ✅ | browser-safe |
| `DB_POOL_MAX` | ⬜ | write-pool ceiling; deep tuning notes in `.claude/reference/env-vars.md` |
| `DB_READ_POOL_MAX` | ⬜ | read-pool (`sqlRead`) ceiling |
| `DB_ADMISSION_ENABLED` | ⬜ | default-ON kill switch for the #773 admission chokepoint |

### Redis (Upstash cache / Railway queue)
| Var | Status | Note |
|---|---|---|
| `REDIS_CACHE_URL` | ✅ | Upstash (TLS, Vercel-reachable) |
| `REDIS_CACHE_TOKEN` | ✅ | |
| `REDIS_QUEUE_URL` | ✅ | Railway Redis (private net; BullMQ) |
| `REDIS_QUEUE_TOKEN` | ✅ | |

### LLM
| Var | Status | Note |
|---|---|---|
| `OPENAI_API_KEY` | ✅ | |
| `ANTHROPIC_API_KEY` | ✅ | fallback provider |
| `OPENAI_MODERATION_ENABLED` | 🟢 | worker-only moderation gate, fail-open |
| `LLM_CIRCUIT_BREAKER_ENABLED` | ⬜ | default-ON kill switch for the per-provider circuit breaker |

### Reviews / GBP (Zernio, SerpAPI, Maps)
| Var | Status | Note |
|---|---|---|
| `ZERNIO_PUBLISHING_ENABLED` | 🟢 | master flag (ingestion **and** posting) |
| `ZERNIO_API_KEY` | 🟢 | **required when flag on** |
| `ZERNIO_WEBHOOK_SECRET` | 🟢 | **required when flag on**; HMAC, must match Zernio dashboard |
| `ZERNIO_API_BASE` | 🟢 | optional — sandbox override |
| `ZERNIO_PROFILE_ID_PREFIX` | 🟢 | optional — prod/staging/local collision guard |
| `ZERNIO_INGEST_MAX_PAGES` | 🟢 | optional — backfill page cap |
| `ZERNIO_IMPORT_MAX_PAGES` | ⬜ | optional — consented-import page cap (distinct from ingest cap) |
| `ZERNIO_RECENT_REVIEW_POLL_DISABLED` | 🟢 | optional |
| `ZERNIO_RECENT_REVIEW_POLL_INTERVAL_MS` | ⬜ | optional poller cadence |
| `ZERNIO_RECENT_REVIEW_POLL_MAX_PAGES` | 🟢 | optional |
| `ZERNIO_RECENT_REVIEW_POLL_MAX_CONNECTIONS` | 🟢 | optional |
| `ZERNIO_RECENT_REVIEW_POLL_CONCURRENCY` | 🟢 | optional |
| `ZERNIO_RECENT_REVIEW_POLL_DEADLINE_MS` | 🟢 | optional |
| `ZERNIO_RECENT_REVIEW_POLL_PAGE_SIZE` | ⬜ | optional |
| `ZERNIO_RECENT_REVIEW_CONNECT_GRACE_MS` | ⬜ | optional — skip-poll grace after a fresh connect |
| `MOCK_ZERNIO_LOCATION_COUNT` | ⬜ | local-dev only — synthetic location count under `MOCK_EXTERNAL_APIS` |
| `SERPAPI_API_KEY` | ✅ | |
| `SERPAPI_TIMEOUT_MS` | 🟢 | optional |
| `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` | ✅ | referrer-locked |
| `GOOGLE_CLIENT_ID` | 🧩 | Phase-5 GBP API placeholder |
| `GOOGLE_CLIENT_SECRET` | 🧩 | Phase-5 GBP API placeholder |
| `GCP_PROJECT_ID` | 🧩 | Phase-5 GBP API placeholder |

### Email (Resend) & lead intake
| Var | Status | Note |
|---|---|---|
| `RESEND_API_KEY` | ✅ | |
| `RESEND_WEBHOOK_SECRET` | ✅ | |
| `RESEND_FROM_EMAIL` | ✅ | |
| `ADMIN_NOTIFICATION_EMAIL` | ✅ | |
| `CONTACT_NOTIFY_TO` | ✅ | |
| `LIST_UNSUBSCRIBE_EMAIL` | ✅ | mailto fallback |
| `LIST_UNSUBSCRIBE_URL` | 🟢 | one-click https endpoint — distinct var |
| `EMAIL_SEND_TIMEOUT_MS` | ⬜ | optional — outbound Resend call timeout |
| `OWNER_LEADS_GOOGLE_SHEET_ID` | ✅ | |
| `OWNER_LEADS_GOOGLE_SHEET_RANGE` | ✅ | |
| `GOOGLE_SHEETS_CLIENT_EMAIL` | ✅ | |
| `GOOGLE_SHEETS_PRIVATE_KEY` | ✅ | |

### Payments (Stripe)
| Var | Status | Note |
|---|---|---|
| `STRIPE_SECRET_KEY` | ✅ | |
| `STRIPE_WEBHOOK_SECRET` | ✅ | |
| `STRIPE_PRICE_COPILOT_LIST` | ✅ | |
| `STRIPE_PRICE_COPILOT_FOUNDING` | ✅ | |
| `STRIPE_PRICE_AUTOPILOT_LIST` | ✅ | |
| `STRIPE_PRICE_AUTOPILOT_FOUNDING` | ✅ | |
| `STRIPE_PRICE_COPILOT_OVERAGE` | ✅ | |
| `STRIPE_PRICE_AUTOPILOT_OVERAGE` | ✅ | |
| `FOUNDING_DEADLINE` | ✅ | |
| `STRIPE_TAX_ENABLED` | ⬜ | server-only, default off — behavior row in `env-vars.md` |
| `TRIAL_ENABLED` | ⬜ | card-up-front 30-day trial flag (migration 069) |
| `TRIAL_PERIOD_DAYS` | ⬜ | optional trial-length override |
| `BETA_COMP_COUPON_ID` | ✅ | admin-invite beta comp coupon — full behavior row in `env-vars.md` |

The seven pre-WS8 Price variables remain deployed only through the cutover
rollback window and are read only by the cutover preflight (`scripts/`), not by
production runtime: `STRIPE_PRICE_BASIC`, `STRIPE_PRICE_FOUNDING`,
`STRIPE_PRICE_FOUNDERS_OVERAGE`, `STRIPE_PRICE_STANDARD`,
`STRIPE_PRICE_STANDARD_OVERAGE`, `STRIPE_PRICE_PREMIUM`,
`STRIPE_PRICE_PREMIUM_OVERAGE`.

### Channels (Twilio / Telegram) — flags off by default
| Var | Status | Note |
|---|---|---|
| `CHANNELS_TELEGRAM_ENABLED` | ✅ | |
| `TELEGRAM_BOT_TOKEN` | ✅ | |
| `TELEGRAM_WEBHOOK_SECRET` | ✅ | |
| `TELEGRAM_BOT_USERNAME` | ✅ | |
| `CHANNELS_WHATSAPP_ENABLED` | ✅ | |
| `TWILIO_ACCOUNT_SID` | ✅ | |
| `TWILIO_AUTH_TOKEN` | ✅ | |
| `TWILIO_WHATSAPP_NUMBER` | ✅ | |
| `WHATSAPP_APPROVAL_TEMPLATE_SID` | ✅ | |
| `WHATSAPP_APPROVAL_URL_BASE` | ✅ | |
| `WHATSAPP_AUTOPOST_TEMPLATE_SID` | ⬜ | auto-approved post FYI template |
| `WHATSAPP_PENDING_POST_TEMPLATE_SID` | ⬜ | pending-post notice template |
| `WHATSAPP_ESCALATION_TEMPLATE_SID` | ⬜ | Guardian escalation template |
| `WHATSAPP_AUTONOMY_SUSPENDED_TEMPLATE_SID` | ⬜ | Governor suspension notice template |
| `WHATSAPP_SOLICITATION_VETO_TEMPLATE_SID` | ⬜ | solicitation veto-window notice template |

### Security / secrets
| Var | Status | Note |
|---|---|---|
| `SESSION_COOKIE_SECRET` | ✅ | |
| `SESSION_COOKIE_SECRET_PREVIOUS` | ⬜ | rotation predecessor — accepted for verify, never for sign |
| `CSRF_SECRET` | ✅ | |
| `IMPERSONATION_COOKIE_SECRET` | ✅ | HMAC-SHA256, ≥32 chars |
| `WORKER_INTERNAL_SECRET` | ⬜ | shared secret for internal worker-to-app calls |
| `ADMIN_APP_URL` | ⬜ | Server-only Admin app origin, required at home cutover (#1192+#1201, ADR 0029). Sole lazy reader `src/lib/config/admin-app-url.ts`; no public companion. Set per Vercel environment before deploying the cutover. |
| `ADMIN_APP_ORIGINS` | ⬜ | **Admin origin allowlist** (#1186, ADR 0026) — comma list of EXACT origins allowed to call `/api/admin/**` cross-origin, one value per environment. Server-only, **no `NEXT_PUBLIC_*` companion** (invariant #13). An entry containing `*` throws at read. Behavior row: `env-vars.md`. |
| `ENCRYPTION_KEY` | 🔸 | **Retired.** No references in code (tokens are SHA-256 *hashed*, no symmetric crypto). Commented out in `.env.example` pending removal. |
| `ENCRYPTION_KEY_VERSION` | 🔸 | **Retired.** Sibling of `ENCRYPTION_KEY`. |

### App / worker URLs & lifecycle
| Var | Status | Note |
|---|---|---|
| `NEXT_PUBLIC_APP_URL` | ✅ | |
| `WORKER_PUBLIC_URL` | ✅ | public worker origin (webhook signature base); 10 code refs |
| `WORKER_SERVICE_URL` | 🔸 | **Retired and removed from `.env.example`** (2026-09-06). 0 code refs — superseded by `WORKER_PUBLIC_URL`. Do not re-add. |
| `WORKER_SHUTDOWN_GRACE_MS` | ⬜ | optional — graceful-shutdown budget before hard exit |
| `BOOT_STAGGER_ENABLED` | ⬜ | optional — staggers worker registrations at boot |

### Observability
| Var | Status | Note |
|---|---|---|
| `SENTRY_DSN` | ✅ | worker boot gate (`assertAlertSinkEnv`) |
| `NEXT_PUBLIC_SENTRY_DSN` | ✅ | |
| `SENTRY_ORG` | ✅ | |
| `SENTRY_PROJECT` | ✅ | |
| `SENTRY_AUTH_TOKEN` | ✅ | |
| `POSTHOG_API_KEY` | ✅ | no-op when unset |
| `POSTHOG_HOST` | ✅ | |
| `LOG_SERVICE` | 🟢 | log-label, cosmetic |

### Agentic autonomy (personas + watchdogs) — behavior rows in `env-vars.md`
| Var | Status | Note |
|---|---|---|
| `TRIAGE_ENABLED` | ⬜ | Guardian triage lane |
| `ESCALATION_ENABLED` | ⬜ | Guardian escalation notices |
| `JUDGE_ENABLED` | ⬜ | Judge review of auto-posts — posting precondition (invariant #3) |
| `JUDGE_POLL_INTERVAL_MS` | ⬜ | optional poller cadence |
| `GOVERNOR_ENABLED` | ⬜ | per-account autonomy suspension |
| `GOVERNOR_INTERVAL_MS` | ⬜ | optional poller cadence |
| `AUTO_APPROVAL_ENABLED` | 🟢 | auto-policy approval master flag, default off |
| `AUTO_APPROVAL_PROVIDER_MODERATION_READY` | 🟢 | provider-moderation gate attestation |
| `AUTOPILOT_PURCHASABLE` | ✅ | Autopilot tier purchasable in checkout |
| `OWNER_OPERATOR_ENABLED` | ⬜ | Owner Operator turn pipeline **and the `/dashboard/operator` screen + apply/decline routes (Run B)** — requires migration 120 in that environment AND Sentry rule 11 in that environment's project before the flip; staging flip scheduled after Run B merges, both lanes (Railway + Vercel) |
| `REFUSAL_LEDGER_ENABLED` | ⬜ | default-ON kill switch for the Refusal ledger's TWO insert helpers, `writeRefusalEvent` and the set-based `writeRefusalEvents` (#1009, #1010) |

### Solicitation
| Var | Status | Note |
|---|---|---|
| `SOLICITATION_WATCH_ENABLED` | ⬜ | watch-mode lane flag |
| `SOLICITATION_SEND_ENABLED` | ⬜ | send-mode lane flag |
| `SOLICITATION_AUTO_APPROVAL_ENABLED` | ⬜ | Autopilot solicitation batches (#631), veto-windowed |
| `SOLICITATION_RESEND_API_KEY` | ⬜ | dedicated Sending-identity Resend key |
| `SOLICITATION_SEND_FROM_ADDRESS` | ⬜ | the one shared Sending identity |
| `SOLICITATION_UNSUBSCRIBE_MAILTO` | ⬜ | List-Unsubscribe mailto for asks |
| `SOLICITATION_PLATFORM_DAILY_CAP` | ⬜ | platform-wide daily send ceiling (blast-radius bound) |
| `SOLICITATION_RELEASE_POLL_INTERVAL_MS` | ⬜ | optional release-poller cadence (#900) |

### Feature flags (behavior rows in `env-vars.md`)
| Var | Status | Note |
|---|---|---|
| `SELF_SERVE_SIGNUP_ENABLED` | ✅ | |
| `RANKING_TRACKING_ENABLED` | ✅ | |
| `EDIT_REPLIES_ENABLED` | ✅ | |
| `MULTI_LOCATION_ENABLED` | 🟢 | |
| `ONBOARDING_DEMO_ENABLED` | 🟢 | |
| `EXTERNAL_REPLY_IMPORT_ENABLED` | 🟢 | |
| `MFA_ENFORCEMENT_ENABLED` | 🟢 | |
| `ACCOUNT_OFFBOARDING_ENABLED` | 🟢 | |

> Behavior of each flag: `.claude/reference/env-vars.md`. All are
> server-authoritative — never add a `NEXT_PUBLIC_*` companion.
> **Retired:** `PAST_REPLIES_VIEW_ENABLED` (#678) — the **Reviews list** at
> `dashboard/reviews/history` renders unconditionally. `EDIT_REPLIES_ENABLED`
> is kept: it gates the live-Google mutation, a different and larger risk. The
> var may still be set in deployed environments; it is simply unread.

### Costs
| Var | Status | Note |
|---|---|---|
| `GLOBAL_DAILY_COST_LIMIT_CENTS` | ✅ | |
| `DAILY_COST_LIMIT_CENTS_COPILOT` | ✅ | required positive operator input |
| `DAILY_COST_LIMIT_CENTS_AUTOPILOT` | ✅ | required positive operator input |
| `ONBOARDING_DEMO_DAILY_CENTS` | 🟢 | |
| `ONBOARDING_DEMO_STAFF_EMAILS_CSV` | 🟢 | |

### Poller / scheduler tuning — all optional, code defaults
| Var | Status | Note |
|---|---|---|
| `OUTBOX_POLL_INTERVAL_MS` | 🟢 | |
| `OUTBOX_BATCH_SIZE` | ⬜ | |
| `OUTBOX_DISPATCH_TIMEOUT_MS` | ⬜ | per-dispatch enqueue timeout |
| `OUTBOX_POLL_MAX_CYCLE_MS` | ⬜ | cycle watchdog budget |
| `OUTBOX_DRAIN_BUDGET_MS` | ⬜ | per-tick drain-loop budget after a full batch |
| `OUTBOX_WATCHDOG_STALE_MS` | ⬜ | stale `dispatching` reclaim threshold |
| `ARCHIVAL_INTERVAL_MS` | 🟢 | |
| `CANCELLATION_GRACE_INTERVAL_MS` | 🟢 | |
| `ENGAGEMENT_MONITOR_INTERVAL_MS` | 🟢 | |
| `EMAIL_CHANNEL_RECONCILE_INTERVAL_MS` | 🟢 | |
| `EMAIL_CHANNEL_RECONCILE_BATCH_SIZE` | 🟢 | |
| `EMAIL_CHANNEL_RECONCILE_DISABLED` | 🟢 | |
| `ANALYTICS_DISPATCH_POLL_INTERVAL_MS` | 🟢 | |
| `ANALYTICS_DISPATCH_BATCH_SIZE` | 🟢 | |
| `STRIPE_LOCATIONS_RECONCILE_INTERVAL_MS` | 🟢 | |
| `STRIPE_LOCATIONS_RECONCILE_DISABLED` | 🟢 | |
| `MONTHLY_IMPACT_SCHEDULER_INTERVAL_MS` | 🟢 | |
| `WEEKLY_SUMMARY_SCHEDULER_INTERVAL_MS` | 🟢 | |
| `ONBOARDING_DRIP_INTERVAL_MS` | 🟢 | |
| `NOTIFICATION_FAILOVER_INTERVAL_MS` | 🟢 | |
| `NOTIFICATION_FAILOVER_DISABLED` | 🟢 | |
| `CLEANUP_ABANDONED_SIGNUPS_INTERVAL_MS` | 🟢 | |
| `CLEANUP_ABANDONED_SIGNUPS_BATCH_SIZE` | 🟢 | |
| `RANKING_TRACKING_INTERVAL_MS` | 🟢 | |
| `ACCOUNT_OFFBOARDING_ACCESS_END_INTERVAL_MS` | ⬜ | |
| `ACCOUNT_OFFBOARDING_ACCESS_END_BATCH_SIZE` | ⬜ | |
| `ACCOUNT_OFFBOARDING_PURGE_INTERVAL_MS` | ⬜ | |
| `ACCOUNT_OFFBOARDING_PURGE_BATCH_SIZE` | ⬜ | |
| `ACCOUNT_OFFBOARDING_PURGE_REMINDER_INTERVAL_MS` | ⬜ | |
| `ACCOUNT_OFFBOARDING_PURGE_REMINDER_BATCH_SIZE` | ⬜ | |
| `ACCOUNT_OFFBOARDING_PURGE_WINDOW_OVERRIDE_MS` | ⬜ | **staging/non-prod only** — see `env-vars.md` |
| `ACCOUNT_OFFBOARDING_REACTIVATION_RESET_INTERVAL_MS` | ⬜ | |
| `ACCOUNT_OFFBOARDING_REACTIVATION_RESET_BATCH_SIZE` | ⬜ | |
| `ACCOUNT_OFFBOARDING_TEARDOWN_RETRY_INTERVAL_MS` | ⬜ | |
| `ACCOUNT_OFFBOARDING_TEARDOWN_RETRY_BATCH_SIZE` | ⬜ | |
| `ACCOUNT_OFFBOARDING_TEARDOWN_RETRY_COOLDOWN_MS` | ⬜ | |
| `ACCOUNT_OFFBOARDING_TEARDOWN_MAX_RETRIES` | ⬜ | |

### Worker health alerting (`HealthAlertPoller`) — all optional threshold tuning
| Var | Status | Note |
|---|---|---|
| `HEALTH_ALERT_POLL_INTERVAL_MS` | ⬜ | |
| `HEALTH_ALERT_MONITOR_SLUG` | ⬜ | Sentry cron-monitor slug |
| `HEALTH_ALERT_FAILED_THRESHOLD` | ⬜ | |
| `HEALTH_ALERT_FAILED_WINDOW_S` | ⬜ | |
| `HEALTH_ALERT_STALE_DISPATCHING_S` | ⬜ | |
| `HEALTH_ALERT_PENDING_AGE_S` | ⬜ | |
| `HEALTH_ALERT_BACKLOG_DEPTH_THRESHOLD` | ⬜ | |
| `HEALTH_ALERT_ZERO_DELIVERY_WINDOW_S` | ⬜ | |
| `HEALTH_ALERT_FLAGGED_OPEN_THRESHOLD` | ⬜ | |
| `HEALTH_ALERT_OWNER_UNREACHABLE_THRESHOLD` | ⬜ | |
| `HEALTH_ALERT_OWNER_UNREACHABLE_AGE_S` | ⬜ | |
| `HEALTH_ALERT_WEDGED_CLIENT_READ_THRESHOLD` | ⬜ | |
| `HEALTH_ALERT_WEDGED_CLIENT_READ_AGE_S` | ⬜ | |

### Docs / misc
| Var | Status | Note |
|---|---|---|
| `NEXT_PUBLIC_DOCS_BASE_URL` | 🟢 | makes `/admin/runbook` names clickable |
| `MOCK_EXTERNAL_APIS` | ✅ | local-dev bypass of all external APIs; `false` in CI |

### Test / CI only
| Var | Status | Note |
|---|---|---|
| `TEST_DATABASE_POOL_URL` | 🧪 | |
| `PLAYWRIGHT_BASE_URL` | 🧪 | |
| `ALLOW_E2E_DB_WRITES` | 🧪 | |
| `E2E_ADMIN_TEST_BUSINESS_ID` | 🧪 | |

### Platform-injected — never put in `.env.example`
| Var | Status | Note |
|---|---|---|
| `NODE_ENV` | ⚙️ | |
| `NEXT_RUNTIME` | ⚙️ | |
| `PORT` | ⚙️ | |
| `CI` | ⚙️ | |
| `VERCEL_GIT_COMMIT_SHA` | ⚙️ | |

## 3. Historical drift report (2026-05-29 snapshot; not the current inventory)

The bullets below preserve the outcome of the original 2026-05-29 scan. They
are historical evidence, not a claim about the WS8-era variable set; the current
inventory is §2 and `.env.example`.

- **Missing from `.env.example`, read by code (34):** the full Zernio family (8),
  6 feature flags, `DAILY_COST_LIMIT_CENTS_PREMIUM`, `LIST_UNSUBSCRIBE_URL`,
  `LOG_SERVICE`, `NEXT_PUBLIC_DOCS_BASE_URL`, `SERPAPI_TIMEOUT_MS`,
  `ONBOARDING_DEMO_DAILY_CENTS`, the poller/scheduler intervals, and 4 test vars.
  → **All added** (required ones as live keys, optional ones commented with notes).
- **In `.env.example`, never read by code (vestigial):** `ENCRYPTION_KEY`,
  `ENCRYPTION_KEY_VERSION`, `WORKER_SERVICE_URL`. → **Commented out** with a note.
  `WORKER_SERVICE_URL` was **deleted outright on 2026-09-06** — that is the
  follow-up this line asked for; `ENCRYPTION_KEY*` stay commented. (`DATABASE_URL` and the Phase-5
  `GOOGLE_*` placeholders are *not* vestigial — kept intentionally.)
- **False positive:** `X` — appears only inside a code comment.

---

## 4. How to regenerate this scan

```bash
EXCL="--exclude-dir=node_modules --exclude-dir=.next --exclude-dir=.git --exclude-dir=dist --exclude-dir=build --exclude-dir=coverage --exclude-dir=.claude"

# every var read by code
grep -rhoE "process\.env\.[A-Za-z_][A-Za-z0-9_]*|process\.env\[['\"][A-Za-z_][A-Za-z0-9_]*['\"]\]" $EXCL \
  --include="*.ts" --include="*.tsx" --include="*.js" --include="*.mjs" --include="*.cjs" . \
  | sed -E "s/process\.env\.//; s/process\.env\[['\"]//; s/['\"]\]//" | sort -u > /tmp/codevars.txt

# every var documented in the template
grep -oE "^#?[[:space:]]*[A-Z_][A-Z0-9_]*=" .env.example | sed -E "s/^#//; s/[[:space:]]//g; s/=//" | sort -u > /tmp/examplevars.txt

comm -23 /tmp/codevars.txt /tmp/examplevars.txt   # in code, missing from template
comm -13 /tmp/codevars.txt /tmp/examplevars.txt   # in template, not read by code
```
