# RepWorth (AI Review Responder) — Claude Code Context

## What this project is

An automated service for small businesses that monitors Google reviews via SerpAPI polling (MVP) and generates personalized, multilingual AI response drafts for owner approval. Built with Next.js 14 + Railway workers + Supabase + BullMQ.

**MVP mode**: SerpAPI polling + manual copy-paste posting. When GBP API access is approved, Phase 5 in `docs/Implementation_Phases_SerpAPI_First.md` upgrades to automated ingestion and posting — a mechanical swap, not a rewrite.

## Architecture invariants — NEVER violate these

- **Vercel serves UI only.** All SLA-critical compute (review sync, response generation, notifications, publishing) runs on Railway workers. NEVER put LLM calls, external API calls, or long-running operations in Next.js API routes.
- **Transactional outbox for all async work.** Every state change + its follow-up work are written in the SAME Postgres transaction via the `job_outbox` table. NEVER write to Postgres and then separately enqueue a BullMQ job — if the enqueue fails, work is lost silently.
- **Third-party ingress terminates on Railway.** Stripe, Resend, future Twilio, and future Google Pub/Sub push requests should hit `worker/ingress/*` directly in production. Do NOT proxy production webhooks through Next.js routes unless you are in local development and explicitly documenting the exception.
- **No auto-posting.** Every response requires explicit owner approval. The system must make it architecturally impossible to bypass approval. There is NO code path from response generation to Google posting without an approval step.
- **Approval tokens are NEVER stored raw.** Only SHA-256 hashes go in `approval_links`. Raw tokens exist only in memory during generation and in the sent email. They are NEVER persisted in Postgres, outbox payloads, or logs.
- **ReviewSource contract.** All review sources (SerpAPI, manual paste, future GBP API) normalize to the same `NormalizedReview` DTO. No source-specific fields leak into the prompt builder.
- **Prospect demo generation is worker work.** Demo generation performs SerpAPI calls plus multiple LLM calls and can exceed Vercel limits. Admin routes may validate input and queue work, but the actual generation must run on Railway.
- **Auth scope is app-enforced, not implied.** Supabase Auth identity must map to `users.auth_id`; browser code never receives `SUPABASE_SERVICE_KEY`; every owner read/write must be scoped by `business_id` even if RLS is also enabled.
- **Use Node.js native `crypto` for all hashing.** `import { createHash, randomUUID } from 'node:crypto'`. Never use `crypto-js` — it's slower and redundant.

## Tech stack

- **Runtime**: Node.js 20 LTS, TypeScript 5 strict mode
- **Framework**: Next.js 14 App Router (Vercel)
- **Worker**: Standalone Node.js process (Railway) — Fastify HTTP server (`fastify` + `fastify-raw-body`) for webhook ingress + BullMQ consumers + OutboxPoller
- **Database**: PostgreSQL 15 via Supabase (PgBouncer pooling enabled). Two clients: `postgres` (Postgres.js) for transactional writes (`sql.begin()`), `@supabase/supabase-js` for auth/storage/reads
- **Cache**: Redis 7 via Upstash (SEPARATE instance from job queue)
- **Job queue**: BullMQ 5 with Redis via Upstash (SEPARATE instance from cache)
- **LLM**: OpenAI GPT-4o-mini (primary), Anthropic Claude Haiku (fallback)
- **Reviews**: SerpAPI (production polling + demo engine)
- **Email**: Resend
- **Payments**: Stripe
- **Monitoring**: Sentry (errors), PostHog (analytics)
- **Package manager**: pnpm
- **Testing**: Vitest (unit/integration), Playwright (E2E)

## Directory structure

```
src/
├── app/                    # Next.js pages (Vercel)
│   ├── (public)/           # Landing, demo viewer, approval page
│   ├── (authenticated)/    # Owner dashboard + settings
│   └── (admin)/            # Sales partner CRM, demos, costs, notifications, jobs
├── lib/                    # Shared business logic
│   ├── db/                 # Supabase client, query helpers, Redis cache client
│   ├── reviews/            # ReviewSource interface, SerpAPI source + monitor, process-review domain logic
│   ├── responses/          # Response generator, prompt builder
│   ├── approval/           # ApprovalService, token management
│   ├── notifications/      # Resend email service, email templates, delivery recording
│   ├── publishing/         # Manual posting workflow (GBP API stub)
│   ├── costs/              # Cost guards (tracker.ts) + audit trail (audit.ts)
│   ├── demos/              # Demo generation pipeline
│   └── shared/             # Types, utils, constants (status enums, URL builders)
└── types/                  # Shared TypeScript interfaces

worker/                     # Railway worker (separate process, at project root)
├── env.ts                  # Dotenv loader — must be imported first in index.ts
├── index.ts                # Entry point — `pnpm worker` or `npx tsx worker/index.ts`
├── queues.ts               # BullMQ queue definitions + Redis connection
├── jobs/                   # Workers: ReviewSync, ResponseGenerator, DemoGeneration, etc.
│   └── OutboxPoller.ts     # 10s interval, FOR UPDATE SKIP LOCKED, dispatches to BullMQ
└── ingress/                # Webhook handlers: Stripe, Resend (direct Railway endpoints)
```

Configure tsconfig paths so `worker/` can import shared code: `"@/lib/*": ["./src/lib/*"]`, `"@/types/*": ["./src/types/*"]`.

## Database

All tables use UUIDv7 (time-ordered). Full schema is in `supabase/migrations/001_initial_schema.sql`.

Key tables: `businesses` (includes `last_sync_at` for SerpAPI polling), `google_connections`, `reviews`, `responses`, `approval_links`, `job_outbox`, `inbound_events`, `prospect_demos`, `notification_deliveries`, `api_costs`, `review_exceptions`, `weekly_summaries`, `users`, `approval_audit_log`

### Response status values

`'pending_approval'` | `'approved'` | `'edited'` | `'superseded'` | `'awaiting_manual_post'` | `'posted'` | `'failed'`

- `superseded`: terminal — the owner requested a regeneration and this draft was replaced by a newer version. **At most one non-terminal response per review at a time.**
- `awaiting_manual_post`: SerpAPI-mode state after approval but before sales partner manually posts to Google. When GBP API arrives, the ResponsePublisherWorker branches: if `google_connections` exists, auto-post; otherwise, manual post.

### Business subscription lifecycle

`'pending_payment'` (default) → `'active'` (Stripe confirms) → `'past_due'` | `'cancelled'`

Businesses start in `pending_payment`. Stripe's `checkout.session.completed` webhook transitions to `active`. The ReconciliationPoller only polls `active` businesses.

**`pending_payment` trial scope:** The onboarding form triggers ONE initial sync. Reviews are ingested and responses are generated (visible in admin UI during the sales call). But `NotificationWorker` and `ResponsePublisherWorker` MUST skip `pending_payment` — no approval emails or posting instructions until payment confirms.

**Subscription guard in ALL customer-facing workers:** Every worker that produces customer-visible output must check `subscription_status` early:

- `cancelled` → no-op, complete outbox entry
- `past_due` → 7-day grace period, then treat as cancelled
- `pending_payment` → `NotificationWorker` and `ResponsePublisherWorker` skip; `ResponseGeneratorWorker` is allowed (for admin-visible demo drafts)
- Apply to: `ResponseGeneratorWorker`, `NotificationWorker`, `ResponsePublisherWorker`, `WeeklySummaryWorker`

## Key patterns to follow

- **Cost guard**: Redis INCRBY for pessimistic cost reservation BEFORE LLM calls. DECRBY to refund on failure. DB `api_costs` table is the audit trail, reconciled hourly. See `.claude/skills/cost-guard.md`.
- **Approval flow**: GET is read-only (renders page). POST /api/approval/session binds device cookie. POST approve/edit/regenerate requires device cookie + CSRF. Email scanners prefetch GET but never POST. See `.claude/skills/approval-security.md`.
- **Outbox pattern**: State change + follow-up work in the SAME Postgres transaction. OutboxPoller dispatches to BullMQ. See `.claude/skills/outbox-pattern.md`.
- **External ingress**: worker ingress handlers verify signatures/tokens, write `inbound_events` first for deduplication, then fan out via `job_outbox`. Signature verification and dedup happen before business logic.
- **Demo generation**: admin action creates a queued demo record + `job_outbox` entry in ONE transaction (same outbox pattern as everything else). Worker fetches reviews, generates responses, and updates the record through `queued -> running -> completed|failed`. Sales lifecycle status is separate from generation lifecycle.
- **Review deduplication (SerpAPI mode)**:
  - **Stable identity** (does NOT include mutable text): `provider='serpapi_poll'`, `provider_review_id` = SerpAPI's raw review ID if available, else SHA-256(reviewerName + "|" + reviewDate + "|" + reviewerProfileUrl). Prefer source-provided identifiers over synthetic hashes to avoid collision with common/anonymous reviewer names.
  - **Synthetic resource names**: `provider_review_name='serpapi://{placeId}/reviews/{provider_review_id}'`, `provider_location_name='serpapi://{placeId}'`
  - **Mutable content**: `review_content_hash=SHA-256(starRating + "|" + reviewText)` — compared to detect edits
  - **Collision handling**: if two reviews produce the same identity key but have different content on first encounter, flag to `review_exceptions` with type `'identity_collision'` instead of silently merging.
  - When GBP API arrives: swap `provider` to `'google'`, replace synthetic IDs with canonical Google resource names. Content hash logic stays identical.
- **Voice learning**: fetch recent owner-edited responses as few-shot examples. Returns empty array until >=5 edited+posted responses exist. The hook is in place; it activates naturally.
- **Owner auth data flow**: Supabase Auth handles identity, the app `users` table handles role + business scope, and server handlers must check both. Do not trust client-submitted business IDs.
- **Demo vs Production mode**: The response generator has two modes. Demo mode (used by `DemoGenerationWorker`) skips cost guards, caching, and voice learning — fast feedback for prospect demos. Production mode (used by `ResponseGeneratorWorker`) runs the full cost guard lifecycle: reserve → concurrency slot → generate → finalize → cache → audit. The mode is set via `GenerationOptions.mode`.
- **Mock mode**: Set `MOCK_EXTERNAL_APIS=true` in `.env.local` to bypass SerpAPI + LLM calls. Uses `MockReviewSource` (canned reviews) and `generateMockResponse` (template responses) for local testing without API keys.
- **Error handling**: all workers are idempotent. Replaying an outbox entry must produce the same result. Use unique constraints + ON CONFLICT for deduplication.

## GBP API migration path

When Google Business Profile API access is approved, follow Phase 5 in `docs/Implementation_Phases_SerpAPI_First.md`. Key changes:

1. Build OAuth flow for business onboarding (`google_connections` table populated)
2. Set up Pub/Sub for real-time notifications
3. Add `gbp-api-source.ts` ReviewSource implementation
4. Update ResponsePublisherWorker to auto-post via GBP API (with `google_connections` check for backward compat)
5. Switch ReconciliationPoller to adaptive intervals (60/120/240 min)
6. Migrate existing customers from `provider='serpapi_poll'` to `provider='google'`
   The architecture was designed so this is a mechanical swap — same outbox, same workers, same approval flow.

## Testing approach

- Unit tests (Vitest): business logic, cost calculation, token hashing, dedup logic
- Integration tests (Vitest + real Supabase): full pipeline flows, outbox recovery, idempotency
- E2E tests (Playwright): approval page flows, demo generation, admin pages

## Dev commands

- `pnpm dev` — Next.js dev server (port 3000)
- `pnpm worker` — Railway worker via tsx (port 3001)
- `pnpm test` — Run Vitest unit tests
- `pnpm test:watch` — Vitest in watch mode
- `pnpm test:e2e` — Playwright E2E tests
- Set `MOCK_EXTERNAL_APIS=true` in `.env.local` to bypass SerpAPI + LLM calls for local testing

## Current status

**Shipped:** Sprints 1–6 COMPLETE + Communication Channels Phase 0 (multi-channel dispatcher, `channel_enrollments`, admin Channels UI) + Communication Channels Phase 1 SMS (code-complete, merged to main 2026-04-22, flag-gated off pending Twilio 10DLC brand/campaign registration) + Communication Channels Phase 2 Telegram (code-complete + **real-bot ship gate PASSED 2026-04-23** against `@RepWorthBot` in local dev; PR to `main` opened; flag-gated off at merge — prod cutover pending prod bot registration + `setWebhook` + one-business pilot walkthrough) + **Communication Channels Phase 3 WhatsApp (code-complete on branch `feat/channels-whatsapp-phase-3` 2026-04-23, 23 commits, 1087/1087 tests pass, 0 tsc errors, 0 migrations; flag-gated off pending Meta Business verification + WABA + Twilio Content template approval)**. See §"What each sprint shipped" below for detail.
**Next:** Merge Phase 2 Telegram PR, then Phase 3 WhatsApp PR. SMS: register 10DLC then flip `CHANNELS_SMS_ENABLED=true` in prod. Telegram: register prod `@RepWorthBot` via BotFather + prod `setWebhook`, run ship gate on pilot business, then flip `CHANNELS_TELEGRAM_ENABLED=true` in prod. WhatsApp: start Meta Business verification (2–4 week external clock), provision WABA + Twilio WA sender, submit `repworth_approval_request_v1` Content template, run 8-item ship gate on pilot, flip `CHANNELS_WHATSAPP_ENABLED=true` in prod. Billing sprint (`subscription_status_changed_at`) also pending.

### What each sprint shipped

- **S1** — Demo pipeline + outbox foundation (P1–6)
- **S2** — 7 BullMQ workers incl. OutboxPoller, approval flow, manual posting (P7–13)
- **S3** — Supabase Auth, admin CRM pages, business onboarding, Stripe, Sentry + security headers (P14a–16)
- **S4** — Notification failover, weekly summaries, archival poller, security + E2E tests (P17, 18)
- **Post-S4** — Place ID resolution (PlaceAutocomplete primary + SerpAPI fallback, `place_id_verified` gate, PlaceIdValidationWorker)
- **S5A** — Weekly Value Report + Monthly Impact, owner dashboard, engagement detection + re-engagement, churn risk score (19a, 19c, 19d, 19f)
- **S5B** — Automated ranking tracking, owner settings + dashboard approval actions, partner satisfaction alert, onboarding drip (day 1/7/30), satisfaction pulse (HMAC feedback links) (19b, 19c-5B, 19d-5B, 19e, 19g)
- **S6** — Correlation IDs + structured logging, archival expansion + `api_costs_daily_rollups`, SerpAPI onboarding pre-fill, email deliverability + hard-bounce handling, launch runbook (20a–20e)
- **Channels Phase 0** — `channel_enrollments` table (migration 021), `NotificationChannel` interface + `EmailChannel`, `getChannel` factory, `getVerifiedEnrollments`, multi-channel `NotificationWorker` dispatcher, `createApprovalLink` channel-scoped with advisory lock, failover poller stale branch → admin alert (`tryClaimAlert`), admin Channels section UI + API, removed `notification_preference` field (2026-04-20/21)
- **Channels Phase 1 (SMS)** — migration 022 (soft-delete + `sms_sender_opt_outs` / `sms_sender_opt_out_events` tables, partial unique index on `channel_enrollments`), `SmsChannel` (Twilio Messaging Service wrapper), sms-body formatter (GSM-7 single-segment, two-tier fallback), sms-tracker cost guard (per-biz + global Redis ceilings), Twilio ingress (`/status` callback with terminal-precedence + race-safe retry, `/inbound` STOP/START with sender-wide opt-out fan-out + TCPA audit log), 6 admin API routes (verify/confirm/cancel/disable/delete/status, advisory-lock-serialized, Twilio-first ordering, env-readiness 503), `SmsEnrollmentWidget` (7-state machine + polling, server-authoritative flag), `NotificationWorker` cost-reservation try/finally + 21610 sender-wide handling. Merged to main 2026-04-22. Flag gated off (`CHANNELS_SMS_ENABLED=false`) pending 10DLC registration.
- **Channels Phase 2 (Telegram)** — zero migrations (migration 021 already accommodated telegram). New files: `TelegramChannel` + `TelegramClient` (native `fetch` wrapper with 10s AbortController timeout + 4 typed error classes) + `formatApprovalTelegram` (pure body formatter with HTML escape, 2-row inline keyboard: Approve/Regenerate callback + Edit URL); `worker/ingress/shared.ts` (extracted `claimInboundEvent` with `source` parameter); `worker/ingress/telegram.ts` (Model A ack ordering — ack AFTER cheap validation AND BEFORE approval tx; four permanent link-state errors + `ResponseNotPendingError` route to `processed` with editMessageText-in-place that replaces stale draft + drops buttons; unexpected errors route to `failed` for reclaim with text-only fallback, no raw token embed; group/channel chat rejection on `/start`; PII-stripped payload redaction before `inbound_events` persist); `worker/ingress/telegram-verify.ts` (constant-time compare against `TELEGRAM_WEBHOOK_SECRET`); `approveViaCallback`/`regenerateViaCallback` in `src/lib/approval/service.ts` (new typed errors `ConsumedLinkError`/`RevokedLinkError`/`ExpiredLinkError`/`ChannelMismatchError`, `recoverCorrelationId` inside tx, audit metadata with SHA-256 `chat_handle_hash` via `approval_audit_log.metadata` JSONB); 3 admin API routes (`start`/`cancel`/`disable`, same flag/env/auth gate as SMS but 404 hides route when off, `Cache-Control: no-store, private` on every response, advisory lock + state machine wrapped in `sql.begin`); server-rendered QR data URLs via `qrcode` dep (raw token never leaves server except to the admin browser); `TelegramEnrollmentWidget` (8-state client UI with 3s polling + 1h TTL countdown, distinguishes 401/403/5xx from empty enrollment); `NotificationWorker` telegram flag-skip + `TelegramRecipientBlockedError`→unsubscribed (`telegram_blocked`) / `TelegramChatNotFoundError`→disabled branches (handle-scoped UPDATE so stale send failures can't stomp re-enrolled handles). Regenerate UX: `editMessageText` replaces stale draft body with "🔄 Regenerating…" status line. PR to `main` opened 2026-04-23 post-ship-gate. Flag-gated off (`CHANNELS_TELEGRAM_ENABLED=false`) — prod cutover pending `@RepWorthBot` BotFather registration + prod `setWebhook` + real-bot pilot. Design: `docs/superpowers/specs/2026-04-22-telegram-phase-2-design.md`. Detailed implementation log: `docs/progresstracking.md`.
- **Channels Phase 3 (WhatsApp)** — code-complete on branch `feat/channels-whatsapp-phase-3` 2026-04-23 (23 commits, 1087/1087 tests pass, 0 tsc errors). **Zero migrations** — migration 021 + 022 already accommodate `channel='whatsapp'`. **Preparatory refactor (first atomic commit):** widened `CallbackAuditContext` from Telegram-shaped `{ updateId: number }` to provider-agnostic discriminated union `{ providerEventId: string; telegramUpdateId?: number XOR twilioMessageSid?: string }`; `buildCallbackAudit` now writes cross-channel `metadata.provider_event_id` unconditionally + channel-specific `metadata.update_id` (Telegram) or `metadata.message_sid` (WhatsApp) — discriminated union enforces "never both" at compile time, historical Telegram audit queries on `update_id` stay valid. **Second refactor:** extracted `classifyIntent` + `STOP_KEYWORDS` / `START_KEYWORDS` from `worker/ingress/twilio.ts` to new `worker/ingress/twilio-intent.ts` so SMS and WA ingress both import it. **New files:** `WhatsAppChannel` + `WhatsAppClient` (Twilio SDK wrapper with explicit `{ timeout: 10_000, autoRetry: false }` + 7 typed error classes split into owner-intent / config-error / transient categories — `classifyError` dispatch by Twilio code Set membership: 63014/63033 → blocked, 63024/21211/21408 → invalid recipient, 63040-42/63027-28 → template config, 63016 → session window bug, 63017/63018/429 → rate limit, AbortError/ETIMEDOUT → timeout, else → generic `WhatsAppApiError`) + `whatsapp-body` pure helpers (`formatApprovalWhatsApp` produces 9 content variables for `repworth_approval_request_v1`; `extractTokenFromApprovalUrl` enforces strict `/approve/<token>` shape — rejects query strings, hash fragments, trailing slashes, non-approve paths; `stripWaPrefix` / `toWaRecipient` / `truncate`); `worker/ingress/twilio-whatsapp.ts` (sibling to SMS ingress — **sql-mock-verified post-claim try/catch safety net** so any DB throw between `claimInboundEvent` and `markProcessed`/`markFailed` lands in `markFailed('post_claim_unexpected:...')` instead of leaking a stuck `received` row that future Twilio retries would treat as duplicate; **UUID regex validation on `ButtonPayload` approvalLinkId** before DB lookup to prevent Postgres "invalid input syntax for type uuid" from escaping the happy path; three flow paths distinguished by payload shape: ButtonPayload → approve/regenerate via `approveViaCallback`/`regenerateViaCallback` with `viaChannel='whatsapp'` + `twilioMessageSid` audit; `start-<token>` body → sha256 lookup + enrollment tx with `archived_at IS NULL` guards; STOP keyword → single-statement UPDATE (no `sql.begin`) with COALESCE pattern + handle-scoped + archived_at guard; status callback mirrors SMS pattern with `channel='whatsapp'` discriminator); 3 admin API routes (`start`/`cancel`/`disable`) mirror the Telegram pattern — flag → env → auth gate with 404 hiding route when flag off, 503 when env missing, advisory lock + state machine inside `sql.begin`, `Cache-Control: no-store, private` on every response, wa.me digit-only deep link construction (`TWILIO_WHATSAPP_NUMBER.replace(/^whatsapp:\+?/, '')`); `WhatsAppEnrollmentWidget` (8-state client UI, 3s polling, 1h TTL countdown, masked phone `+15•••4567`, onCancel force-resets to idle locally before refresh to avoid stale QR). **Dispatcher split (CRITICAL):** `NotificationWorker` extended with flag-skip + 6 WA error branches — owner-intent (`RecipientBlocked` → `unsubscribed`/`whatsapp_blocked`, `InvalidRecipient` → `disabled`) flips enrollment with handle-scoped + archived_at guard; **config-error (`TemplateConfigError`, `SessionWindowError`) leaves enrollment `verified` UNCHANGED** — template paused/broken is a RepWorth ops failure, not owner intent, and flipping to unsubscribed would falsely suppress notifications + mislead the admin widget (explicit integration test in `NotificationWorker.whatsapp.test.ts` asserts zero `channel_enrollments` UPDATE calls on `WhatsAppTemplateConfigError` — single most important regression guard in Phase 3); transient (`RateLimit`, `Timeout`) records `failed_delivery`, enrollment unchanged, BullMQ queue-level backoff handles retry. **Startup assertion** `assertChannelsWhatsAppEnv` is self-contained (does NOT depend on `assertChannelsSmsEnv` which early-returns when SMS flag is off) — verifies 7 env vars present + `TWILIO_WHATSAPP_NUMBER` matches `/^whatsapp:\+\d{7,15}$/` format + `WHATSAPP_APPROVAL_URL_BASE === NEXT_PUBLIC_APP_URL + '/approve/'` equality check prevents staging/local shipping URLs the Meta-approved template doesn't point at. **Raw-token locality invariant maintained** — raw approval token exists only in contentVariables['9'] for the URL button (same semantic boundary as email channel), never in ButtonPayload, never in `inbound_events.payload` (redaction strips Body + ButtonPayload + ProfileName + WaId), never in logs (anti-regression test asserts no console.log/error/warn call arg contains the raw token fixture across every WhatsAppClient error path). **Template contract** documented in local `docs/whatsapp-templates.md`: `twilio/card` Content type, 9 body variables, 2 quick-reply buttons (Approve/Regenerate with payload `a:<uuid>`/`r:<uuid>`) + 1 URL button (`https://app.repworth.com/approve/{{9}}`), UTILITY category. Flag-gated off (`CHANNELS_WHATSAPP_ENABLED=false`) — prod cutover pending Meta Business verification + WABA + approved Content template (2–4 week external clock). Design: `docs/superpowers/specs/2026-04-23-whatsapp-phase-3-design.md`. Plan: `docs/superpowers/plans/2026-04-23-whatsapp-phase-3.md`. Detailed implementation log: `docs/progresstracking.md`.

### Migrations (`supabase/migrations/`)

Next number: **026**. Inventory: 001 (schema), 002 (P2 fixes), 003 (audit_log RLS), 004 (sync_reviews dedup constraint), 005 (review_exception nullable review_id), 006 (users RLS), 007 (place_id_verified), 008 (retention core + monthly_impact_emails), 009 (report claim/sent columns), 010 (dashboard indexes), 011 (engagement_alert dedup), 012 (outbox_status doc), 013 (churn query indexes), 014 (retention expansion), 015 (drip_log claim state), 016 (satisfaction_alert index), 017 (S6 scale: `api_costs_daily_rollups` + `businesses.website` + `owner_email_bounced`), 018 (correlation + `'dispatching'` indexes), 019 (notification_deliveries bounce indexes), 020 (JSONB scalar-string repair — see lab note 2026-04-18), 021 (channel_enrollments + email backfill), 022 (channels Phase 1: drop notification_preference, soft-delete + partial unique index on channel_enrollments, sms_sender_opt_outs + sms_sender_opt_out_events with RLS + CHECK constraints, handle lookup index). **Phase 3 (WhatsApp) ships zero migrations** — migration 021 already accommodates `channel='whatsapp'`, and existing indexes cover both WA and Telegram., 023 (non-terminal response uniqueness: partial unique index enforcing at most one non-terminal response per review), 024 (notification_delivery dedup: unique index on notification_deliveries for send-before-record race prevention), 025 (signup schema: three partial indexes idx_businesses_pending_unpaid_self_serve_cleanup + idx_users_owner_auth_by_business + users_auth_id_uniq; email lowercase backfill with collision precondition; onboarded_by backfill with admin-presence precondition)

### Feature flags / non-obvious env vars

- `MOCK_EXTERNAL_APIS=true` — bypass SerpAPI + LLM locally
- `RANKING_TRACKING_ENABLED=false` — ranking worker off by default
- `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` — required for onboarding PlaceAutocomplete (Essentials tier)
- `ONBOARDING_DRIP_INTERVAL_MS` — optional, default 1h
- `NEXT_PUBLIC_DOCS_BASE_URL` — optional; makes `/admin/runbook` doc names clickable links
- `TEST_DATABASE_POOL_URL` — E2E tests skip gracefully when unset
- `CONTACT_NOTIFY_TO` — optional; overrides the hardcoded notification email for `/api/contact` form submissions (default: `norbertesekiel@gmail.com`)
- `NOTIFICATION_FAILOVER_DISABLED=true` — skip failover poller entirely (local dev / mock mode auto-skips too; RESEND_WEBHOOK_SECRET no longer consulted)
- `NOTIFICATION_FAILOVER_INTERVAL_MS` — optional, default 7200000 (2 hours)
- `CHANNELS_SMS_ENABLED` — gates factory, dispatcher, admin API routes, widget. Default off. Server-authoritative single source of truth; the admin page reads it via the business detail API (no `NEXT_PUBLIC_*` companion).
- `WORKER_PUBLIC_URL` — required when SMS enabled; statusCallback base + Twilio signature verification path component. Must match Twilio console config exactly (scheme, host, no trailing slash).
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_MESSAGING_SERVICE_SID`, `TWILIO_VERIFY_SERVICE_SID` — required when SMS enabled (worker startup assertion fails otherwise, except in `MOCK_EXTERNAL_APIS=true`).
- `SMS_DAILY_LIMIT_CENTS_PER_BUSINESS` (default 10) / `SMS_DAILY_LIMIT_CENTS_GLOBAL` (default 500) — SMS cost guard ceilings.
- `CHANNELS_TELEGRAM_ENABLED` — gates factory, dispatcher, admin API routes, widget. Default off. Server-authoritative via business detail API `telegramEnabled` field.
- `TELEGRAM_BOT_TOKEN` — BotFather token for `@RepWorthBot`. Required when Telegram enabled (worker startup assertion enforces; `MOCK_EXTERNAL_APIS=true` bypasses).
- `TELEGRAM_WEBHOOK_SECRET` — 32+ byte shared secret. Must match value passed to Telegram `setWebhook`. Ingress rejects 401 on mismatch. Rotate via fresh `setWebhook` + env update.
- `TELEGRAM_BOT_USERNAME` — optional; default `RepWorthBot`. Controls deep-link rendering (`https://t.me/<username>?start=<token>`).
- `CHANNELS_WHATSAPP_ENABLED` — gates factory, dispatcher, admin API routes, widget. Default off. Worker startup assertion (self-contained) verifies 7 env vars + TWILIO_WHATSAPP_NUMBER format + WHATSAPP_APPROVAL_URL_BASE equality with NEXT_PUBLIC_APP_URL.
- `TWILIO_WHATSAPP_NUMBER` — WA sender. Format: `whatsapp:+<digits>`. Required when flag on.
- `WHATSAPP_APPROVAL_TEMPLATE_SID` — Twilio Content SID for `repworth_approval_request_v1`. Required when flag on.
- `WHATSAPP_APPROVAL_URL_BASE` — must equal `NEXT_PUBLIC_APP_URL + '/approve/'` (boot assertion enforces).

### GBP API

Not applied for. Mechanical swap plan lives in Phase 5 of `docs/Implementation_Phases_SerpAPI_First.md`.

## Known residual risks (shipped as-is, tracked for later)

These are real bugs accepted with current mitigations. Not landmines — documented so oncall knows the edges.

- **Approval email crash-after-send race (2026-04-18).** `NotificationWorker` creates the approval link, sends via Resend, then records the delivery row. If the worker crashes in the millisecond window between Resend acking the message and `recordNotificationDelivery` writing, the next retry finds no delivery row, revokes the "orphaned" link as stale, creates a fresh token, and sends a SECOND email. Owner sees two approval emails; the first token is revoked (clicking it shows "expired"); the second works. Partially covered by `NotificationFailoverPoller` which handles the symmetric lost-email case. Proper fix: insert a provisional delivery row with `sent_at=NOW()` BEFORE the Resend call, update `external_message_id` after success. Trade-off is a silently-failing Resend would leave the owner with no email at all. Deferred — current design prefers retry-duplicate over lost-email.

- **`past_due` grace period based on mutable `businesses.updated_at` (2026-04-18).** `checkSubscription` in `src/lib/shared/subscription-guard.ts` computes the 7-day grace window from `businessUpdatedAt`, but any unrelated write to the businesses row (admin profile edit, keyword change, bounce flag, tier update) resets `updated_at` and extends the grace indefinitely. Low exploit risk because admins editing a `past_due` business are typically trying to help them pay, not exploit grace. **Planned for the next billing-focused sprint:** add a dedicated `subscription_status_changed_at` column, write it only in the Stripe webhook on actual status transitions, update every `checkSubscription` caller to pass it instead of `updated_at`.

## Lab notes

- [2026-04-09] Postgres.js returns JSONB columns as strings (not parsed objects) when using `DATABASE_POOL_URL` with PgBouncer. Always guard with `typeof x === 'string' ? JSON.parse(x) : x` when reading JSONB columns. Hit this in OutboxPoller (payload) and demo viewer (reviews_snapshot, generated_responses).
- [2026-04-11] SerpAPI Google Maps Reviews rejects `num` parameter on the initial page unless `next_page_token` is also set. Always returns 8 results on first page. Removed `num` from both `SerpApiSource` and `SerpApiMonitor`; results are sliced client-side after fetch.
- [2026-04-11] Anthropic model `claude-3-5-haiku-latest` was deprecated and returns 404. Updated to `claude-haiku-4-5-20251001` in generator and cost tracker.
- [2026-04-11] Vercel serverless functions cannot reach local Docker Redis. Rate limiter must gracefully skip when `REDIS_CACHE_URL` is not set or Redis is unreachable, rather than crashing the request. The approval service has its own idempotency guards as defense-in-depth.
- [2026-04-11] BullMQ rejects `:` in custom job IDs (`Custom Id cannot contain :`). OutboxPoller uses `_` as separator for attempt-suffixed job IDs.
- [2026-04-11] Supabase PgBouncer pooled connections have a short default `statement_timeout` (~8s). The OutboxPoller watchdog CTE can exceed this when updating locked rows. Set `connection: { statement_timeout: 30_000 }` on the Postgres.js client.
- [2026-04-13] Google Maps URLs contain hex CIDs (`0x...:0x...`) in the `!1s` data segment, NOT canonical Place IDs. SerpAPI's `data_id` parameter for hex CIDs is unreliable — many fail with "no results." Always resolve to canonical Place IDs via SerpAPI `engine=google_maps` search or Google Place Autocomplete.
- [2026-04-13] Google Place IDs are NOT limited to the `ChIJ` prefix. Valid prefixes include `GhIJ`, `Eic`, `Iho`, and others. Match on base64url character set + minimum length (20+ chars, starts with letter), not prefix.
- [2026-04-13] `gmp-place-autocomplete` (PlaceAutocompleteElement) has a closed shadow DOM — no CSS custom properties or `::part()` selectors can change the background. However, it respects `color-scheme`. If the system is in dark mode, it renders dark. Fix: `color-scheme: light only !important`. Also: `overflow: hidden` on the element clips the suggestions dropdown — never set it.
- [2026-04-13] Google Maps Platform pricing changed March 2025 to tier-based (Essentials/Pro/Enterprise) with Free Usage Caps (10,000/month baseline). `displayName` field is Pro tier; `id` + `formattedAddress` + `location` are Essentials tier. Stay in Essentials to minimize costs.
- [2026-04-13] `@googlemaps/js-api-loader` v2 `setOptions()` accesses `window` — crashes during Next.js SSR. Guard with `if (typeof window !== 'undefined')`. The deprecated `google.maps.places.Autocomplete` class is blocked for new customers since March 2025; use `PlaceAutocompleteElement` instead.
- [2026-04-14] Stripe webhook stores the full **event** object in `inbound_events.payload`. The session ID is at `payload->'data'->'object'->>'id'`, NOT `payload->>'id'` (which is the event ID like `evt_...`). The payment-success route was querying the wrong JSON path, causing perpetual 404s.
- [2026-04-18] `${JSON.stringify(payload)}::jsonb` in Postgres.js v3 DOUBLE-ENCODES JSONB values into scalar strings. When you pass a JS string to a position cast with `::jsonb`, Postgres.js's JSON type adapter wraps the already-stringified JSON in additional JSON quotes — so `{"a":1}` becomes `"{\"a\":1}"`, which Postgres parses as a JSONB scalar string (a jsonb value that is itself a string), NOT as a JSONB object. `jsonb_typeof(payload)` returns `'string'` on these rows, and `payload->>'correlation_id'` returns NULL. **Correct pattern:** pass the OBJECT directly via the `jsonb()` helper from `src/lib/db/server.ts`: `await sql\`INSERT INTO t (col) VALUES (${jsonb(payload)})\`` — the helper wraps `sql.json(value)` and returns a Parameter with OID 3802 (jsonb), so Postgres.js sends the object serialized exactly once. Never use `${JSON.stringify(x)}::jsonb`anywhere. Migration 020 normalizes legacy rows by running`payload = (payload#>>'{}')::jsonb WHERE jsonb_typeof(payload) = 'string'` across every JSONB column.

## MCP Usage Reference

| MCP                   | When to use                                                                                            | Sprint      |
| --------------------- | ------------------------------------------------------------------------------------------------------ | ----------- |
| **Supabase**          | Database queries, migrations, checking table data, debugging data issues                               | All sprints |
| **Context7**          | Looking up library docs (SerpAPI, BullMQ, Resend, Stripe SDKs, Next.js App Router) before implementing | Sprints 1-3 |
| **Playwright**        | Writing and running E2E tests for approval flow, demo pages, admin pages                               | Sprints 2-4 |
| **Sentry**            | Setting up error tracking, checking error reports, debugging production issues                         | Sprints 3+  |
| **Google Chrome Dev** | Debugging approval page rendering, mobile responsiveness, performance profiling                        | Sprints 2-4 |
