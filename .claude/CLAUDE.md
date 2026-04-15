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
- Sprint 1: COMPLETE (Prompts 1-6 done + audit fixes applied; demo pipeline verified with mock data)
  - Post-audit fixes (2026-04-09): mock data path, OutboxPoller hardening (FOR UPDATE SKIP LOCKED, max_attempts, transaction wrapping), DemoGenerationWorker crash recovery, admin auth middleware, JSONB parsing guard, local Redis, vitest config
- Sprint 2: COMPLETE (Prompts 7-13 done; all 7 BullMQ workers implemented; 189 tests across 15 files; end-to-end verified locally + deployed to Vercel)
  - Prompt 7 (shared worker utilities): COMPLETE (2026-04-10)
  - Prompt 8 (OutboxPoller watchdog + ReconciliationPoller): COMPLETE (2026-04-10)
  - Prompt 9 (ReviewSyncWorker): COMPLETE (2026-04-10)
  - Prompt 10 (ResponseGeneratorWorker): COMPLETE (2026-04-10)
  - Prompt 11 (NotificationWorker + email + Resend webhook): COMPLETE (2026-04-10)
  - Prompt 12 (Approval flow): COMPLETE (2026-04-10) — app code + unit tests done; Playwright E2E deferred to Prompt 18 (Sprint 4) pending test DB/seed/worker harness
  - Prompt 13 (Manual posting + AdminExceptionWorker): COMPLETE (2026-04-10)
  - Post-sprint fixes (2026-04-11): SerpAPI `num` param removal, Anthropic model upgrade (`claude-haiku-4-5-20251001`), graceful rate-limit fallback when Redis unavailable, Vercel deployment env var configuration
- Post-Sprint 2 code checkup (2026-04-11): modularization + cleanup, no functional changes
  - Split `src/lib/costs/tracker.ts` → `src/lib/db/redis-cache.ts` (Redis client), `src/lib/costs/tracker.ts` (cost guards), `src/lib/costs/audit.ts` (Postgres audit trail + pricing)
  - Extracted `buildManualPostEmailHtml()` from `ResponsePublisherWorker` → `src/lib/notifications/email.ts`
  - Extracted `processReview()`, `captureRoiBaseline()`, `isPermanentSerpApiError()` from `ReviewSyncWorker` → `src/lib/reviews/process-review.ts` (reusable for GBP API Pub/Sub handler)
  - Extracted `recordNotificationDelivery()` → `src/lib/notifications/delivery.ts` (shared by NotificationWorker + ResponsePublisherWorker)
  - Created `src/lib/shared/constants.ts`: `ResponseStatus`, `SubscriptionStatus`, `ExceptionType` enums, `NO_STORE_HEADERS`, `buildGoogleMapsUrl()`
  - Deduplicated `Cache-Control` headers across 5 approval routes → use shared `NO_STORE_HEADERS`
  - Broke up `handleResponseGeneration` → extracted `applyAvoidFactsGuardrail()` + `persistResponseAndNotify()`
  - OutboxPoller now stores the actual dispatch error message in `last_error` (was storing generic message)
  - Mock email logger now includes approval URL for local testing
  - 189/189 tests passing after all changes
- Sprint 3: IN PROGRESS
  - Prompt 14a (Supabase Auth + middleware + login): COMPLETE (2026-04-11) — @supabase/ssr installed, middleware rewritten with session refresh + role-based protection, login page uses signInWithPassword(), auth callback route created, old API key auth removed, requireRole() defense-in-depth on all admin API routes, users RLS policy created, 189/189 tests passing
  - Prompt 14b (Admin read-only pages): COMPLETE (2026-04-11) — 4 admin pages + 4 API routes built: overview (system health + business CRM table, 30s polling), costs (provider/business/day breakdown, daily limit progress bar, date range filter), notifications (delivery log with business/channel/status filters, pagination), jobs (outbox summary + BullMQ queue depth + failed jobs list, graceful Redis unavailable handling). 189/189 tests passing.
  - Prompt 14c (Business onboarding + detail page): COMPLETE (2026-04-11) — Onboarding form at /admin/businesses/new (react-hook-form + Zod, creates business + owner + sync outbox in one transaction), business list at /admin/businesses (pagination, Add Business button), upgraded detail page at /admin/businesses/[id] (inline-editable profile + review list with color-coded status badges + existing manual-post section). 189/189 tests passing.
  - Prompt 15 (Stripe integration): COMPLETE (2026-04-12) — Stripe webhook handler (signature verification, dedup via inbound_events, 5 event types: checkout.session.completed, invoice.payment_failed, invoice.paid, customer.subscription.deleted, customer.subscription.updated). Payment Link URL returned from onboarding API + copied to clipboard. Lazy Stripe singleton. End-to-end verified: onboard → Payment Link → Stripe checkout → webhook → subscription_status='active' → ReconciliationPoller picks up business. 189/189 tests passing.
  - Prompt 16 (Sentry + security headers + hardening): COMPLETE (2026-04-12) — Sentry error tracking (client/server/edge configs with sensitive data scrubbing, worker init), security headers (HSTS, CSP in production, X-Frame-Options, nosniff) on both Vercel and Railway, shared Zod schemas for business validation, demo generation rate limits (50/day global + 5/min per IP). 189/189 tests passing.
- **Sprint 3: COMPLETE** — All 5 prompts (14a, 14b, 14c, 15, 16) done.
- **Sprint 4: COMPLETE** — Both prompts (17, 18) done.
  - Prompt 17 (Notification failover + weekly summaries + archival): COMPLETE (2026-04-12) — NotificationFailoverPoller (2h interval, stale/all-failed detection, admin alerts with 24h dedup), NotificationWorker failover-awareness (checks `delivered_at` not `sent_at` in failover mode), WeeklySummaryScheduler (hourly, fires Monday 8-9 AM UTC for previous week), WeeklySummaryWorker (stats query, idempotent upsert via ON CONFLICT WHERE sent_at IS NULL, email send), ArchivalPoller (24h, batched DELETEs with LIMIT 5000: outbox 7d, events 30d, demos 30d), weekly summary email template. 201/201 tests passing.
  - Prompt 18 (Security tests + E2E approval tests): COMPLETE (2026-04-12) — 10 security property tests (sanitizeText prompt injection, escapeHtml XSS, regen budget cost amplification, SHA-256 token hash verification, error type checks, subscription bypass). 5 Playwright E2E approval scenarios (approve, edit, expired, regenerate, consumed) with per-test seed/cleanup via `TEST_DATABASE_POOL_URL`. E2E seed helper with safety guards (fail-fast without test DB + env gate). 212/212 Vitest tests passing; E2E tests skip gracefully when no test DB configured.
- **Post-Sprint 4: System Testing Improvements (2026-04-13)**
  - Place ID Resolution: COMPLETE — Google Maps Place Autocomplete as primary input (PlaceAutocompleteElement, Essentials-tier fields, `color-scheme: light only` for dark mode compat). URL paste fallback with worker-side SerpAPI search resolution (`engine=google_maps`, haversine <200m matching). `place_id_verified` flag gates ReconciliationPoller + ReviewSyncWorker. PlaceIdValidationWorker (`validate_place_id` outbox topic). Budget guard 75/day via checkRateLimit. Migration 007 smart-grandfathers canonical IDs only, inserts `place_id_resolution_required` exceptions for hex CIDs. URL parser upgraded with `parseGoogleMapsUrl()` extracting name + coords + ID. Place IDs no longer restricted to `ChIJ` prefix (supports `GhIJ`, `Eic`, `Iho`, etc.). 249/249 tests passing across 21 files.
  - New files: `src/components/PlaceAutocomplete.tsx`, `src/lib/reviews/place-id-resolver.ts`, `worker/jobs/PlaceIdValidationWorker.ts`, `supabase/migrations/007_place_id_verification.sql`
  - New env var: `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` (Google Maps JS API key with Places API enabled)
  - Robustness fixes (2026-04-14): COMPLETE — 10 validated findings from system-wide code review. All surgical, no new tables or workers.
    - H1: NotificationWorker skips approval link revocation on retry when delivery record exists
    - H2: ResponseGeneratorWorker re-checks avoid-facts on retry, fails instead of returning violating draft
    - H3: Demo generation rate limit fails closed (503) when Redis unavailable
    - H4: Stripe webhook uses atomic INSERT dedup (no check-then-insert race)
    - H5: Stripe checkout verifies `payment_status=paid` + `mode=subscription` before activation
    - M6: OutboxPoller dispatches BullMQ jobs outside DB transaction (two-phase claim+dispatch)
    - M7: WeeklySummaryWorker marks `sent_at` before email send (prevents duplicate on crash)
    - M8: Resend webhook rejects stale svix-timestamps (>5min replay protection)
    - M9: Payment-success removes fallback to recent business + fixes session ID JSON path lookup
    - L10: E2E tests use `domcontentloaded` waitUntil
    - Admin navbar added to all admin pages (shared layout component)
    - 253/253 tests passing across 21 files
- **Sprint 5: IN PROGRESS**
  - Prompt 19a (Weekly Value Report + Monthly Impact Email): COMPLETE (2026-04-14) — Review summary LLM helper (OpenAI→Anthropic fallback + cost audit), `recordNotificationDelivery` extended for business-level notifications (responseId optional), `SendMonthlyImpactPayload` + BullMQ queue registered, WeeklySummaryWorker upgraded to Weekly Value Report with AI Intelligence Brief + value-delivered header + response rate lift + review velocity + conditional ranking + dashboard link, old `buildWeeklySummaryEmailHtml` replaced with `buildWeeklyValueReportHtml`, MonthlyImpactScheduler (1st of month 9-10 AM UTC), MonthlyImpactWorker (idempotent upsert, LLM brief, best review, crash-safe sent_at), `buildMonthlyImpactEmailHtml` template, migration 008 (monthly_impact_emails table + notification delivery index). 307/307 tests passing across 24 files.
  - New files: `src/lib/responses/review-summary.ts`, `worker/jobs/MonthlyImpactScheduler.ts`, `worker/jobs/MonthlyImpactWorker.ts`, `supabase/migrations/008_retention_core.sql`
  - Post-19a fixes: cost guard in review-summary (reservation/finalization), claimed_at/sent_at split (migration 009), defensive try/finally, prompt injection hardening, nullable star_rating guards, stale claim recovery (15-min lease), subscription_tier pass-through, response-rate join fix, time-saved copy consistency, 4-week average range fix. 312/312 tests.
  - Prompt 19c (Read-Only Owner Dashboard): COMPLETE (2026-04-14) — `GET /api/dashboard` API route (8 parallel queries scoped by owner business_id, defense-in-depth requireRole), OwnerNav component (Dashboard + business name + Sign out), authenticated layout shell with session lookup, DashboardContent client component (value summary banner, review velocity BarChart, conditional ranking LineChart with inverted Y-axis, recent reviews with status badges + expandable responses, latest intelligence brief), middleware updated for `/api/dashboard` owner protection. recharts installed. 312/312 tests.
  - New files: `src/app/api/dashboard/route.ts`, `src/components/OwnerNav.tsx`, `src/components/DashboardContent.tsx`
- GBP API: NOT APPLIED FOR

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

## MCP Usage Reference

| MCP | When to use | Sprint |
|---|---|---|
| **Supabase** | Database queries, migrations, checking table data, debugging data issues | All sprints |
| **Context7** | Looking up library docs (SerpAPI, BullMQ, Resend, Stripe SDKs, Next.js App Router) before implementing | Sprints 1-3 |
| **Playwright** | Writing and running E2E tests for approval flow, demo pages, admin pages | Sprints 2-4 |
| **Sentry** | Setting up error tracking, checking error reports, debugging production issues | Sprints 3+ |
| **Google Chrome Dev** | Debugging approval page rendering, mobile responsiveness, performance profiling | Sprints 2-4 |
