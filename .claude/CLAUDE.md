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
- **Reviews**: Zernio webhooks (production ingestion); SerpAPI (demo engine + onboarding pre-fill + URL→placeId fallback only)
- **Email**: Resend
- **GBP API**: Zernio (`zernio.com`). Used for review listing + reply posting. Flag-gated by `ZERNIO_PUBLISHING_ENABLED`.
- **SMS / WhatsApp**: Twilio (Messaging Service for SMS, Content templates for WhatsApp). Flag-gated.
- **Telegram**: native fetch wrapper around Telegram Bot API (no SDK). Flag-gated.
- **Payments**: Stripe (Checkout via Payment Links + webhook on Railway)
- **Monitoring**: Sentry (errors)
- **Package manager**: pnpm
- **Testing**: Vitest (unit/integration), Playwright (E2E)

## Codex Review Bridge

- Scripts live at `~/dev/codex-bridge/`
- To start Codex: `bash ~/dev/codex-bridge/start`
- To send a prompt: `bash ~/dev/codex-bridge/nudge "review PR #42 for security issues"`
- To wait for review: `bash ~/dev/codex-bridge/watch 42`
- Session name: `cdx` (override with `$CDX_TMUX_SESSION`)
- Always run these in the WSL2 shell context

## Codebase Memory (codebase-memory-mcp)

Prefer graph tools over grep/Glob for structural code questions on this repo.
Graph queries return precise results in one tool call (~500 tokens) vs file-by-file (~80K).

- Before exploration/planning: ensure the graph is fresh — `index_repository` if stale
- "Who calls X?": `trace_call_path(function_name="X", direction="inbound")`
- "What does X call?": `trace_call_path(function_name="X", direction="outbound")`
- Find by pattern: `search_graph(label="Function", name_pattern=".*Pattern.*")`
- Dead code: `search_graph(label="Function", relationship="CALLS", direction="inbound", max_degree=0, exclude_entry_points=true)`
- Cross-service HTTP: `search_graph(relationship="HTTP_CALLS")`
- REST routes: `search_graph(label="Route")`
- Source: `get_code_snippet(qualified_name="...")` after finding via search

Use grep/Glob only for text search (string literals, error messages, config values).

## Directory structure

```
src/
├── app/                    # Next.js pages (Vercel)
│   ├── (public)/           # Landing + marketing (pricing, features, how-it-works, book-a-demo, privacy, terms),
│   │                       #   demo viewer, approval page, owner login/signup/forgot-password/reset-password,
│   │                       #   feedback (HMAC-link satisfaction pulse), components/
│   ├── (authenticated)/    # Owner dashboard + settings
│   │   └── dashboard/connect/      # Zernio connect flow: page.tsx + select-location/page.tsx + LocationPicker.tsx
│   ├── admin/              # Sales-partner CRM: overview, businesses (list/new/[id]), demos, costs, jobs,
│   │                       #   notifications, runbook, payment-success, login/forgot-password/reset-password
│   ├── onboarding/         # Self-serve signup: pay (plan picker), payment-success (poll), business (3-step wizard)
│   └── api/                # Route handlers: auth, signup, onboarding, dashboard, admin, contact, feedback, settings,
│                           #   approve, demo-request, zernio (connect/{start,callback,select-location,cancel} + disconnect)
├── components/
│   └── dashboard/          # ConnectGoogleBanner.tsx (Zernio reconnect CTA) + other dashboard widgets
├── lib/                    # Shared business logic
│   ├── approval/           # ApprovalService, token management, channel-scoped createApprovalLink, callback approve/regen
│   ├── auth/               # Route helpers (rate limits, role gating)
│   ├── costs/              # Cost guards: tracker.ts (LLM), sms-tracker.ts (Twilio SMS), audit.ts (DB trail)
│   ├── db/                 # Postgres.js client (server.ts), Supabase clients (client/browser/supabase-server),
│   │                       #   Redis cache client, jsonb() helper
│   ├── publishing/         # Manual posting workflow + zernio-publisher.ts (review-id lookup + transient-exhaustion fallback)
│   ├── zernio/             # client.ts, connect-state.ts, connect-session-cookie.ts, types.ts, errors.ts (HTTP client + Lua CAS + typed errors)
│   ├── demos/              # Demo generation pipeline
│   ├── notifications/      # email.ts, delivery.ts, enrollments.ts, sms-body.ts
│   │   └── channels/       # NotificationChannel implementations: email, sms, telegram, whatsapp
│   │                       #   (+ telegram-body, telegram-client, whatsapp-body, whatsapp-client)
│   ├── onboarding/         # createBusinessTx (admin + self_serve modes)
│   ├── payments/           # Stripe Payment Link URL builder
│   ├── responses/          # Response generator, prompt builder, voice learning, mock generator, review-summary (LLM)
│   ├── reviews/            # ReviewSource interface, SerpAPI source/monitor/normalize/prefill, mock source/monitor,
│   │                       #   place-id-resolver, url-parser, detect-language, process-review
│   └── shared/             # Constants (status enums, URL builders), schemas (Zod), subscription-guard, churn-score,
│                           #   rate-limit, csrf, sanitize, html, logger, mock-mode, outbox helpers, auth-flow,
│                           #   feedback-hmac, protected-routes, queue-names, request-ip
└── types/                  # Placeholder — types live in src/lib/*/types.ts

worker/                     # Railway worker (separate process, at project root)
├── env.ts                  # Dotenv loader — must be imported first in index.ts
├── index.ts                # Entry: Fastify + BullMQ workers + pollers + schedulers (graceful shutdown)
├── queues.ts               # BullMQ queue definitions + Redis connection
├── startup-assert.ts       # Boot-time env-var assertions (channel flags, Stripe links, Zernio gates)
├── jobs/                   # ~26 files. Workers: ReviewSync, ResponseGenerator, Notification, ResponsePublisher,
│                           #   AdminException, DemoGeneration, PlaceIdValidation, WeeklySummary, MonthlyImpact,
│                           #   EngagementAlert, OnboardingDrip, RankingTracking, OwnerEmail (Zernio reconnect/connection-lost),
│                           #   DrainOwnerConnect (re-enqueues parked publish_response). Pollers: Outbox, Reconciliation,
│                           #   NotificationFailover, EngagementMonitor, Archival, CleanupAbandonedSignups,
│                           #   EmailChannelReconcile, RankingTrackingScheduler, MonthlyImpactScheduler,
│                           #   WeeklySummaryScheduler, OnboardingDripScheduler
└── ingress/                # Webhook handlers: Stripe, Resend, Twilio (SMS + WhatsApp), Telegram + verify helpers,
                            #   Zernio (zernio.ts + zernio-verify.ts HMAC-SHA256), shared.ts (claimInboundEvent extracted)

```

Configure tsconfig paths so `worker/` can import shared code: `"@/lib/*": ["./src/lib/*"]`, `"@/types/*": ["./src/types/*"]`.

## Database

All tables use UUIDv7 (time-ordered). Base schema is in `supabase/migrations/001_initial_schema.sql`; current head is migration **027** (next: 028). See "Migrations" section below for the per-migration inventory.

Key tables:

- **Core**: `users`, `businesses` (includes `last_sync_at` for SerpAPI polling, `subscription_status`, `subscription_tier`, `place_id_verified`, `onboarded_by`, `stripe_customer_id`), `google_connections`
- **Review pipeline**: `reviews`, `responses`, `approval_links`, `approval_audit_log`, `review_exceptions`
- **Workflow plumbing**: `job_outbox` (transactional outbox), `inbound_events` (webhook dedup)
- **Notifications**: `notification_deliveries`, `channel_enrollments` (multi-channel: email/sms/telegram/whatsapp; soft-delete via `archived_at`), `sms_sender_opt_outs` + `sms_sender_opt_out_events` (TCPA audit)
- **Sales / demos**: `prospect_demos`
- **Cost / metering**: `api_costs`, `api_costs_daily_rollups`
- **Reporting / retention**: `weekly_summaries`, `monthly_impact_emails`, `ranking_snapshots`, `onboarding_drip_log`, `satisfaction_responses`

### Response status values

`'pending_approval'` | `'approved'` | `'edited'` | `'superseded'` | `'awaiting_owner_connect'` | `'posted'` | `'failed'`

- `superseded`: terminal — the owner requested a regeneration and this draft was replaced by a newer version. **At most one non-terminal response per review at a time.**
- `awaiting_owner_connect`: Zernio-mode state when an approved response cannot be posted because the business has no active Zernio connection (never connected, or connection was revoked). The dashboard shows a "Connect Google" banner; on successful (re)connect, `DrainOwnerConnectWorker` flips these back to `approved` and re-queues `publish_response` outbox entries. Non-terminal — counts against the per-review uniqueness rule.

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
- `pnpm worker` — Railway worker via tsx (Fastify on `PORT` env, default 3001)
- `pnpm build` — Next.js production build
- `pnpm start` — Next.js production server
- `pnpm lint` — Next.js / ESLint
- `pnpm test` — Run Vitest unit + integration tests
- `pnpm test:watch` — Vitest in watch mode
- `pnpm test:e2e` — Playwright E2E tests (skip gracefully without `TEST_DATABASE_POOL_URL`)
- Set `MOCK_EXTERNAL_APIS=true` in `.env.local` to bypass SerpAPI + LLM (and Twilio/Telegram channel boot assertions) for local testing
- Helper scripts (run via `pnpm tsx scripts/<name>.ts`): `clear-signup-rate-limits.ts` (clears Redis IP/email signup buckets between runbook scenarios)

## Current status

**Shipped:** Sprints 1–6 + Channels Phase 0–4 + Owner Self-Serve Signup + **Zernio GBP integration** — all code-complete, all flag-gated off in prod.

**Pending merges + prod actions:**

1. Merge `feat/owner-self-serve-signup` PR → configure Supabase custom SMTP + email templates → flip `SELF_SERVE_SIGNUP_ENABLED=true`
2. Merge Telegram PR + Channels Phase 4 PR (`feat/phase-4-owner-channels`, PR #10 — owner `/settings/channels` page + shared enrollment hook + migration 027) → register prod `@RepWorthBot` + `setWebhook` + pilot → flip `CHANNELS_TELEGRAM_ENABLED=true`
3. Merge WhatsApp PR → Meta Business verification (2–4 week clock) + WABA + Content template → flip `CHANNELS_WHATSAPP_ENABLED=true`
4. SMS: register 10DLC → flip `CHANNELS_SMS_ENABLED=true`
5. **Zernio: MERGED 2026-04-28 (#9).** Subscribe to Zernio Accelerate + Inbox add-on → set `ZERNIO_API_KEY` + `ZERNIO_WEBHOOK_SECRET` + `WORKER_PUBLIC_URL` in prod → run migration 026 in prod Supabase → configure webhook URL in Zernio dashboard pointing at `${WORKER_PUBLIC_URL}/ingress/zernio` → fire test webhook → flip `ZERNIO_PUBLISHING_ENABLED=true` → onboard one pilot customer per `docs/zernio-launch-runbook.md`. Local 6-scenario QA passed 2026-04-28 (`docs/zernio-test-report-2026-04-28.md`).
6. **Zernio ingestion replace SerpAPI: MERGED YYYY-MM-DD (#NN).** Apply migrations 028+029 in prod Supabase (in that order). Set `STRIPE_PAYMENT_LINK_PREMIUM` + `STRIPE_PRICE_PREMIUM` in prod env (Vercel + Railway). Confirm Zernio webhook URL still points at `${WORKER_PUBLIC_URL}/ingress/zernio` (no URL change — same endpoint now also handles `review.new`/`review.updated`). Manual smoke on staging Zernio sandbox (post a real review on the sandbox GBP, verify webhook → ingest → response in dashboard). The single `ZERNIO_PUBLISHING_ENABLED=true` flag controls both publishing + ingestion paths — no new flag.
7. Billing sprint: add `subscription_status_changed_at` (currently `updated_at` — see residual risks)

**Required before Self-Serve Signup flag flip:**

- Custom SMTP: `smtp.resend.com:465`, username `resend`, password = `RESEND_API_KEY`
- Confirm signup template: `{{ .Token }}` (6-digit OTP — NOT `{{ .ConfirmationURL }}`)
- Reset password + Invite user templates: `{{ .SiteURL }}/api/auth/callback?token_hash={{ .TokenHash }}&amp;type=recovery|invite&amp;flow=owner&amp;next=/reset-password` (`&amp;` required — unescaped `&` breaks `<a href>`)

### What each sprint shipped

- **S1** — Demo pipeline + outbox foundation (P1–6)
- **S2** — 7 BullMQ workers incl. OutboxPoller, approval flow, manual posting (P7–13)
- **S3** — Supabase Auth, admin CRM pages, business onboarding, Stripe, Sentry + security headers (P14a–16)
- **S4** — Notification failover, weekly summaries, archival poller, security + E2E tests (P17, 18)
- **Post-S4** — Place ID resolution (PlaceAutocomplete primary + SerpAPI fallback, `place_id_verified` gate, PlaceIdValidationWorker)
- **S5A** — Weekly Value Report + Monthly Impact, owner dashboard, engagement detection + re-engagement, churn risk score (19a, 19c, 19d, 19f)
- **S5B** — Automated ranking tracking, owner settings + dashboard approval actions, partner satisfaction alert, onboarding drip (day 1/7/30), satisfaction pulse (HMAC feedback links) (19b, 19c-5B, 19d-5B, 19e, 19g)
- **S6** — Correlation IDs + structured logging, archival expansion + `api_costs_daily_rollups`, SerpAPI onboarding pre-fill, email deliverability + hard-bounce handling, launch runbook (20a–20e)
- **Channels Phase 0** — migration 021 (`channel_enrollments`), `NotificationChannel` interface + `getChannel` factory, multi-channel `NotificationWorker` dispatcher, channel-scoped `createApprovalLink`, admin Channels UI. Removed `notification_preference`.
- **Channels Phase 1 (SMS)** — migration 022 (soft-delete, `sms_sender_opt_outs`, partial unique index), `SmsChannel` + Twilio ingress (`/status` terminal-precedence + `/inbound` STOP/START + TCPA audit), SMS cost guard (per-biz + global Redis), 6 admin API routes, `SmsEnrollmentWidget`. Flag: `CHANNELS_SMS_ENABLED`.
- **Channels Phase 2 (Telegram)** — zero migrations. `TelegramChannel` + `TelegramClient`, `TelegramEnrollmentWidget`, bot ingress (Model A ack: AFTER validation, BEFORE approval tx), `approveViaCallback`/`regenerateViaCallback`, SHA-256 `chat_handle_hash` in audit, QR deep-link enrollment. Flag: `CHANNELS_TELEGRAM_ENABLED`. Spec: `docs/superpowers/specs/2026-04-22-telegram-phase-2-design.md`.
- **Channels Phase 3 (WhatsApp)** — zero migrations. `WhatsAppChannel` + `WhatsAppClient` (7 typed error classes: owner-intent / config-error / transient), WA ingress + `WhatsAppEnrollmentWidget`. **Critical:** `TemplateConfigError`/`SessionWindowError` leave enrollment `verified` UNCHANGED — ops failure ≠ owner opt-out. Flag: `CHANNELS_WHATSAPP_ENABLED`. Spec: `docs/superpowers/specs/2026-04-23-whatsapp-phase-3-design.md`.
- **Channels Phase 4 (Owner Channel Dashboard)** — migration 027. `/settings/channels` page lets owners self-serve enroll/disconnect Telegram; SMS + WhatsApp render as "Coming soon". Pure `enrollmentReducer` (8 states, 27 unit tests) + thin `useEnrollment` hook extracted from inline state in `TelegramEnrollmentWidget`. Shared `startTelegramEnrollment` / `cancelTelegramEnrollment` / `disableTelegramEnrollment` transaction helpers consumed by both admin and owner routes. Owner routes under `/api/dashboard/channels/*` wrapped with `withSameOrigin`; `businessId` always sourced from session. **Concurrency hardening:** all four mobile-enrollment paths share `mobile_enroll:${businessId}` advisory lock; cancel routes hold the same lock and filter `archived_at IS NULL`; start helpers + WA inbound use `SELECT FOR UPDATE` to serialize against webhook ingress. Cancel now flips status to `disabled` so the row exits migration 027's predicate (preventing future SMS/WA enrollment lockout). Flag: `CHANNELS_TELEGRAM_ENABLED` (server-authoritative; `/settings/channels` Telegram row falls back to ComingSoonChannelRow when off). Plan: `docs/superpowers/plans/2026-04-28-phase-4-owner-channel-dashboard-plan.md`. Spec: `docs/superpowers/specs/2026-04-28-phase-4-owner-channel-dashboard-design.md`.
- **Owner Self-Serve Signup** — migration 025. Flow: `/signup` (OTP) → `/onboarding/pay` → Stripe Payment Link → `/onboarding/payment-success` → `/onboarding/business` wizard → `/dashboard`. Google OAuth: `/api/auth/callback` → `/signup/finish` → same flow. Key: `createBusinessTx` (dual admin/self-serve mode), `CleanupAbandonedSignupsPoller` (24h, TOCTOU-safe FOR UPDATE re-validation), `EmailChannelReconcilePoller` (10-min durable retry for missed enrollment rows), `resolveWizardDestination` (4-rule redirect guard). Admin onboarding now calls `inviteUserByEmail` + patches `auth_id`. Docs: `docs/signup-test-runbook.md`, `docs/currents.md`. Flag: `SELF_SERVE_SIGNUP_ENABLED`.

### Migrations (`supabase/migrations/`)

Next: **028**. 001–019 cover schema through S6 (see files). Key recent:

- 020 — JSONB scalar-string repair (`payload = (payload#>>'{}')::jsonb WHERE jsonb_typeof(payload)='string'` across all JSONB cols)
- 021 — `channel_enrollments` + email backfill
- 022 — Phase 1 SMS: drop `notification_preference`, soft-delete + partial unique index, `sms_sender_opt_outs`/`sms_sender_opt_out_events`
- 023 — non-terminal response uniqueness: partial unique index (at most one non-terminal response per review)
- 024 — `notification_deliveries` dedup unique index (send-before-record race prevention)
- 025 — signup: two partial indexes + email lowercase backfill + `onboarded_by` backfill (both collision-guarded)
- 026 — Zernio: widen `responses.status` → TEXT, recreate non-terminal-uniqueness index incl. `awaiting_owner_connect`, add `zernio_connections` + `zernio_finalize_incidents` tables, 2 dedup indexes on `notification_deliveries`, in-flight `publish_response` outbox uniqueness
- 027 — Channels Phase 4: partial unique index `channel_enrollments_one_mobile_per_biz` enforcing at most one pending/verified mobile channel (sms/telegram/whatsapp) per business; predicate excludes disabled/unsubscribed/archived rows so enrollment history is preserved across switches.
- 028 — Zernio first-connect backfill: `zernio_backfill_runs` table (per-business summary of gap/historical processed + skipped counts; tier and subscription_activated_at snapshotted; partial unique index `zernio_backfill_runs_one_per_business`).
- 029 — Decommission manual-post: bulk-fail orphan `awaiting_manual_post` rows with `posting_error='manual_post_deprecated_2026_04'`, rebuild `responses_one_non_terminal_per_review` without the dead status, drop the migration-024 stale `notification_deliveries_response_template_uniq` index. Apply AFTER migration 028.
- 030 — `ingest_zernio_review` outbox dedup: partial unique index `job_outbox_ingest_zernio_review_inflight` on `(aggregate_id, (payload->>'zernio_review_id'))` for non-terminal rows of `topic='ingest_zernio_review'`. Webhook fan-out's `INSERT ... ON CONFLICT DO NOTHING` uses this to dedup against in-flight rows when Zernio retries a webhook delivery mid-processing.

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
- `SELF_SERVE_SIGNUP_ENABLED=true` — gates owner self-serve signup/login/reset pages + APIs. Admin surfaces (`/admin/login`, `/admin/forgot-password`, `/admin/reset-password`) never gated. When on, requires `REDIS_CACHE_URL`, `NEXT_PUBLIC_APP_URL`, and both `STRIPE_PAYMENT_LINK_*` env vars (worker startup assertion fails otherwise).
- `CLEANUP_ABANDONED_SIGNUPS_INTERVAL_MS` — optional, default 24h.
- `CLEANUP_ABANDONED_SIGNUPS_BATCH_SIZE` — optional, default 100.
- `EMAIL_CHANNEL_RECONCILE_INTERVAL_MS` — optional, default 10min. Reconciliation poller for `channel_enrollments` rows that the verify-otp / finish-signup inline INSERT failed to create. Scope: `active`-subscription owner businesses with NO email enrollment row (including archived).
- `EMAIL_CHANNEL_RECONCILE_BATCH_SIZE` — optional, default 100.
- `EMAIL_CHANNEL_RECONCILE_DISABLED=true` — skip the reconcile poller entirely (mock mode auto-skips too).
- `ZERNIO_PUBLISHING_ENABLED` — gates connect routes (`start`/`callback`/`select-location`/`cancel`/`disconnect`), the worker's Zernio publishing branch in `ResponsePublisherWorker`, the `worker/ingress/zernio` webhook handler, and admin/dashboard panel CTAs. Default off. Server-authoritative; browser learns flag state via the business-detail API (`zernioPublishingEnabled` field). No `NEXT_PUBLIC_*` companion.
- `ZERNIO_API_KEY` — required when flag on. Worker startup assertion fails otherwise (mock mode bypasses).
- `ZERNIO_WEBHOOK_SECRET` — required when flag on. HMAC shared secret used by `worker/ingress/zernio-verify.ts`. Must match the value configured in the Zernio dashboard. Rotate by updating both env var and Zernio dashboard config (Zernio retries 7× over 51h, so a brief 401 window is tolerable).
- `ZERNIO_PROFILE_ID_PREFIX` — optional, default `'repworth-prod-'`. Prefixed onto Zernio profile names so prod/staging/local don't collide on the same Zernio workspace.
- `ZERNIO_INGEST_MAX_PAGES` — optional, default `4` (200 reviews). Caps `ZernioReviewIngestWorker`'s `listReviews` walk for `review.updated` lookups. Hitting the cap with `nextPageToken` still set escalates to `review_exceptions type='zernio_pagination_cap_exhausted'` (distinct from durable `zernio_review_not_found`) so ops can decide whether to bump the cap or accept the gap.
- `ZERNIO_API_BASE` — optional, default `'https://zernio.com/api'`. Override for sandbox.

### GBP API

Not applied for. Mechanical swap plan lives in Phase 5 of `docs/Implementation_Phases_SerpAPI_First.md`.

## Known residual risks (shipped as-is, tracked for later)

These are real bugs accepted with current mitigations. Not landmines — documented so oncall knows the edges.

- **Approval email crash-after-send race (2026-04-18).** `NotificationWorker` creates the approval link, sends via Resend, then records the delivery row. If the worker crashes in the millisecond window between Resend acking the message and `recordNotificationDelivery` writing, the next retry finds no delivery row, revokes the "orphaned" link as stale, creates a fresh token, and sends a SECOND email. Owner sees two approval emails; the first token is revoked (clicking it shows "expired"); the second works. Partially covered by `NotificationFailoverPoller` which handles the symmetric lost-email case. Proper fix: insert a provisional delivery row with `sent_at=NOW()` BEFORE the Resend call, update `external_message_id` after success. Trade-off is a silently-failing Resend would leave the owner with no email at all. Deferred — current design prefers retry-duplicate over lost-email.

- **`past_due` grace period based on mutable `businesses.updated_at` (2026-04-18).** `checkSubscription` in `src/lib/shared/subscription-guard.ts` computes the 7-day grace window from `businessUpdatedAt`, but any unrelated write to the businesses row (admin profile edit, keyword change, bounce flag, tier update) resets `updated_at` and extends the grace indefinitely. Low exploit risk because admins editing a `past_due` business are typically trying to help them pay, not exploit grace. **Planned for the next billing-focused sprint:** add a dedicated `subscription_status_changed_at` column, write it only in the Stripe webhook on actual status transitions, update every `checkSubscription` caller to pass it instead of `updated_at`.

- **Zernio backfill gap-window uses `subscription_activated_at`, not `connected_at` (2026-04-30).** `ZernioBackfillWorker` classifies reviews as "gap" (createTime ≥ subscription_activated_at, cap=25 all tiers) or "historical" (< activated, cap=50 premium-only). For a customer who activates Stripe in January but connects Zernio in July, all 6 months of pre-Zernio reviews are classified as "gap" — capped at 25, leaving the rest in historical (skipped on non-premium). Behaviorally correct per spec, but ops will field "where are my reviews?" tickets. **Workaround:** explain in onboarding that gap = "since you started paying," not "since you connected Zernio." **Proper fix (deferred):** use `zernio_connections.connected_at` as the gap boundary so the dashboard messaging more closely matches user expectations. Requires schema change to snapshot `connected_at` into `zernio_backfill_runs` for self-contained rows.

## Lab notes

- [2026-04-09] Postgres.js + PgBouncer returns JSONB columns as strings. Guard reads: `typeof x === 'string' ? JSON.parse(x) : x`.
- [2026-04-11] SerpAPI Maps Reviews ignores `num` on page 1 (always 8 results). Removed `num`; slice client-side.
- [2026-04-11] `claude-3-5-haiku-latest` deprecated → 404. Use `claude-haiku-4-5-20251001`.
- [2026-04-11] Vercel serverless can't reach local Docker Redis — rate limiter must gracefully skip when `REDIS_CACHE_URL` missing/unreachable.
- [2026-04-11] BullMQ rejects `:` in job IDs — OutboxPoller uses `_` separator.
- [2026-04-11] Supabase PgBouncer `statement_timeout` ~8s — set `connection: { statement_timeout: 30_000 }` on Postgres.js client (OutboxPoller watchdog CTE can exceed it).
- [2026-04-13] Google Maps URLs use hex CIDs (`0x...:0x...`), NOT canonical Place IDs. Resolve via PlaceAutocomplete or SerpAPI `engine=google_maps` search — not `data_id`.
- [2026-04-13] Place IDs: NOT `ChIJ`-only (also `GhIJ`, `Eic`, `Iho`, etc.). Match base64url charset + 20+ chars, not prefix.
- [2026-04-13] `PlaceAutocompleteElement` has closed shadow DOM — can't style via `::part()`. Fix: `color-scheme: light only !important`. Never set `overflow: hidden` (clips dropdown).
- [2026-04-13] Google Maps (March 2025): `displayName` is Pro tier. Use `id`+`formattedAddress`+`location` (Essentials, free tier).
- [2026-04-13] `@googlemaps/js-api-loader` v2 `setOptions()` accesses `window` — guard with `if (typeof window !== 'undefined')` for SSR. `Autocomplete` class blocked for new customers; use `PlaceAutocompleteElement`.
- [2026-04-14] Stripe `inbound_events.payload` stores full event object. Session ID: `payload->'data'->'object'->>'id'`, not `payload->>'id'` (that's the `evt_...` event ID).
- [2026-04-18] `${JSON.stringify(x)}::jsonb` in Postgres.js v3 double-encodes to JSONB scalar string. Use `jsonb()` helper (`sql.json(value)`, OID 3802) for all JSONB inserts.
- [2026-04-24] Server-side `supabase.auth.signUp()` uses implicit flow → confirmation emails return `#access_token=...` to homepage. Fix: 6-digit OTP (`{{ .Token }}` template + `/signup/check-email` entry) — also sidesteps email-scanner link prefetch.
- [2026-04-24] `channel_enrollments` row must only be inserted AFTER email is verified (post-OTP or post-Google-OAuth). Admin `createBusinessTx` keeps inline INSERT (pre-verified by definition). Forgetting the Google OAuth path silently drops all notifications for Google-signed-up businesses.
- [2026-04-24] Admin-onboarded owners had `auth_id=NULL` → couldn't log in. Admin route now calls `inviteUserByEmail` + patches `auth_id`. Compensating delete fires on invite failure to prevent email collision on retry.
- [2026-04-24] Supabase built-in SMTP: 2/hour limit. Fix: custom SMTP via Resend. In `/api/auth/signup`, disambiguate `over_email_send_rate_limit` → 429, not 409 `account_exists`.
- [2026-04-26] `CleanupAbandonedSignupsPoller` TOCTOU: re-validate ALL predicates inside the tx with `SELECT FOR UPDATE` after taking advisory locks. `deleteUser()` is irreversible + non-transactional — wrong here nukes paying accounts.
- [2026-04-26] Supabase `signUp()` returns obfuscated user (`identities: []`) for already-confirmed emails (anti-enumeration). Detect before `createBusinessTx` and return `account_exists`.
- [2026-04-26] `googleMapsUrlSchema` must call `parseGoogleMapsUrl()` and enforce same parseability contract as worker's `validate_place_id` — otherwise wizard marks business onboarded but worker permanently fails.
- [2026-04-27] Postgres rejects `STABLE` expressions in partial-index keys / predicates (ERROR 42P17). `timestamptz::date` is `STABLE` (depends on session timezone), so `(created_at::date)` in a unique index fails to apply. Fix: wrap in `AT TIME ZONE 'UTC'` first — `((created_at AT TIME ZONE 'UTC')::date)` is `IMMUTABLE`. The `ON CONFLICT` clause on any insert into that index must use the EXACT same expression (byte-for-byte) or Postgres won't recognize the constraint match.
- [2026-04-28] Zernio's `account.disconnected` webhook payload uses NESTED `account.id`, not flat `accountId`. Handler reads `body.account?.id` per spec §5.4. A flat-`accountId` payload returns `200 received:true` but the handler silently skips processing (logs `missing account.id — skipping`) — false-positive in CI/manual testing. Test helpers must build the nested shape.
- [2026-04-29] Postgres ON CONFLICT clause must reference partial-unique-index expressions BYTE-FOR-BYTE. The migration-005 `idx_review_exceptions_collision_dedup` predicate uses `(payload->>'provider_review_id')`, NOT `provider_review_id` — using the latter as the conflict key in INSERT statements (e.g. for the new zernio_review_not_found exception type) returns "no matching unique constraint" at runtime even when the values are semantically equivalent.

## MCP Usage Reference

| MCP                   | When to use                                                                                            | Sprint      |
| --------------------- | ------------------------------------------------------------------------------------------------------ | ----------- |
| **Supabase**          | Database queries, migrations, checking table data, debugging data issues                               | All sprints |
| **Context7**          | Looking up library docs (SerpAPI, BullMQ, Resend, Stripe SDKs, Next.js App Router) before implementing | Sprints 1-3 |
| **Playwright**        | Writing and running E2E tests for approval flow, demo pages, admin pages                               | Sprints 2-4 |
| **Sentry**            | Setting up error tracking, checking error reports, debugging production issues                         | Sprints 3+  |
| **Google Chrome Dev** | Debugging approval page rendering, mobile responsiveness, performance profiling                        | Sprints 2-4 |
