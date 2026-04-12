# Current Implementation Map

This file explains what is actually built in the repository today, how it maps to the implementation plan, and what is left to build.

Last updated: 2026-04-12 (after Sprint 3 completion)

---

## What We Built So Far

### Sprint 1: Scaffolding + Demo Engine (Prompts 1-6)

We set up the entire project foundation and built the prospect demo generator — the #1 sales weapon.

**What it does:** A sales partner pastes a Google Maps URL into the admin page, and within 60 seconds gets a shareable demo page showing that business's real reviews with AI-generated responses.

**What we built:**
- Next.js 14 app with TypeScript strict mode, Tailwind, App Router
- Full database schema (15 tables in Supabase) covering the entire long-term architecture
- Railway worker process with Fastify HTTP server + BullMQ job queue + OutboxPoller
- SerpAPI integration for fetching Google Maps reviews
- AI response generator with OpenAI (primary) + Anthropic (fallback)
- Cost tracking system with Redis-based budget guards
- Demo generation pipeline: admin UI → outbox → worker → SerpAPI → AI → viewer page
- Mock mode for local development without API keys

### Sprint 2: Production Pipeline (Prompts 7-13)

We built the complete automated review response workflow — the core product loop.

**What it does:** When a business signs up, the system automatically polls their Google reviews every 60 minutes, generates AI response drafts, emails the owner for approval, and queues approved responses for manual posting by the sales partner.

**What we built:**
- 7 shared utilities (subscription guard, outbox helpers, sanitizer, rate limiter, mock mode, worker types, voice learning)
- OutboxPoller watchdog recovery for crashed workers
- ReconciliationPoller — schedules review syncs every 60 minutes for active businesses
- ReviewSyncWorker — fetches reviews via SerpAPI, deduplicates, detects edits, triggers response generation
- ResponseGeneratorWorker — calls AI with cost guards, avoid-facts checking, voice learning
- NotificationWorker — generates approval tokens (SHA-256 hashed), sends approval emails via Resend
- Approval system — 5 API routes, device-bound cookies, CSRF protection, server+client approval page
- ResponsePublisherWorker — sets responses to awaiting_manual_post, emails admin with paste instructions
- AdminExceptionWorker — alerts admin when a reviewer edits their review after we already posted
- Resend webhook handler — tracks email delivery status
- Admin business detail page with copy-to-clipboard and mark-as-posted buttons

### Sprint 3: Admin Dashboard + Payments + Security (Prompts 14a-16)

We built the full admin interface, payment integration, and security hardening — everything needed for the sales partner to onboard and manage clients independently.

**What it does:** The sales partner logs in with Supabase Auth, onboards a business through a form, sends the owner a Stripe Payment Link, and monitors everything from admin dashboard pages. Stripe webhooks automatically activate the subscription when payment completes. Security headers and Sentry error tracking protect everything.

**What we built:**

**Authentication (Prompt 14a):**
- Supabase Auth with `@supabase/ssr` — cookie-based sessions, email/password login
- Middleware rewrote: session refresh + role-based route protection (admin/sales_partner for admin pages, owner for dashboard)
- `requireRole()` defense-in-depth on every admin API route
- Old API key auth completely removed
- RLS policy: users can only read their own row
- Auth callback route for email confirmations

**Admin Dashboard Pages (Prompt 14b):**
- Overview page — system health cards (pending outbox, failed jobs, today's cost, notification failures) + business table sorted by urgency, 30-second auto-refresh
- Costs page — breakdown by provider, business, day. Daily limit progress bar. 7d/30d/90d date filter. Businesses exceeding 80% of limit highlighted red.
- Notifications page — delivery log with business/channel/status filters, pagination
- Jobs page — outbox summary cards + BullMQ queue depth per queue. Gracefully shows "unavailable" if Redis is down. Failed jobs table with pagination.

**Business Onboarding + Management (Prompt 14c):**
- Onboarding form (`/admin/businesses/new`) — react-hook-form + Zod, 14 fields across 4 sections (business info, owner info, voice context, subscription tier). Creates business + owner user + initial sync outbox entry in one atomic transaction.
- Business list (`/admin/businesses`) — table with pagination, "Add Business" button, clickable rows
- Upgraded business detail page — inline-editable profile section (PATCH API), review list with color-coded response status badges (new=gray, pending_approval=yellow, approved=blue, awaiting_manual_post=orange, posted=green, failed=red), existing manual-post section preserved

**Stripe Payments (Prompt 15):**
- Stripe webhook handler on Railway (`/ingress/stripe`) — signature verification, dedup via inbound_events
- 5 event types: checkout.session.completed (pending_payment → active), invoice.payment_failed (→ past_due), invoice.paid (grace recovery → active), customer.subscription.deleted (→ cancelled), customer.subscription.updated (tier change)
- Payment Link URL returned from onboarding API with `client_reference_id` + `prefilled_email`
- Onboarding form copies Payment Link to clipboard after business creation
- Lazy Stripe singleton — worker doesn't crash if Stripe keys aren't set

**Security Hardening (Prompt 16):**
- Sentry error tracking — client/server/edge configs for Next.js + worker init. Sensitive data scrubbed (keys, secrets, tokens, passwords stripped from error payloads).
- Security headers on all Vercel responses: HSTS (2-year), CSP (production only), X-Frame-Options DENY, X-Content-Type-Options nosniff
- Security headers on all Railway responses: HSTS + nosniff via Fastify onSend hook
- Shared Zod schemas for business validation (replaces inline schemas in onboarding + PATCH)
- Demo generation rate limits: 50/day global + 5/min per IP

---

## Every File In The Project

### Root Config Files

| File | What it does |
|---|---|
| `package.json` | Dependencies and scripts: `pnpm dev`, `pnpm worker`, `pnpm test`, `pnpm build` |
| `tsconfig.json` | TypeScript strict mode, path aliases (`@/` → `./src/`) |
| `next.config.mjs` | Next.js 14 config, wrapped with Sentry, security headers (HSTS, CSP, X-Frame-Options, nosniff) |
| `sentry.client.config.ts` | Sentry browser-side init with sensitive data scrubbing |
| `sentry.server.config.ts` | Sentry server-side init with sensitive data scrubbing |
| `sentry.edge.config.ts` | Sentry Edge Runtime init (for middleware) |
| `tailwind.config.ts` | Tailwind CSS setup |
| `postcss.config.mjs` | PostCSS + Tailwind + Autoprefixer |
| `vitest.config.ts` | Test runner config: includes `src/**/__tests__/**` and `worker/**/__tests__/**` |
| `playwright.config.ts` | E2E test config (tests scaffolded, not yet implemented) |
| `.env.example` | Template for all environment variables with documentation |
| `.env.local` | Actual secrets (never committed to git) |

### Database (`supabase/migrations/`)

| File | What it does |
|---|---|
| `001_initial_schema.sql` | Creates all 15 tables: businesses, reviews, responses, approval_links, users, job_outbox, inbound_events, notification_deliveries, prospect_demos, api_costs, review_exceptions, weekly_summaries, ranking_snapshots, google_connections, approval_audit_log |
| `002_prompt2_fixes.sql` | Fixes audit log schema, adds missing indexes |
| `003_fix_audit_log_rls.sql` | Restores row-level security on audit log |
| `004_sync_reviews_dedup_constraint.sql` | Prevents duplicate sync_reviews outbox entries per business |
| `005_nullable_review_exception_review_id.sql` | Allows NULL review_id for identity collision exceptions + dedup index |
| `006_users_rls_policy.sql` | Enables RLS on users table + self-select policy for authenticated users |

### Worker Process (`worker/`)

Runs on Railway. Handles all background jobs — review syncing, AI generation, email sending, posting.

| File | What it does | Status |
|---|---|---|
| `index.ts` | Starts Fastify server + 6 BullMQ workers + OutboxPoller + ReconciliationPoller. Handles graceful shutdown. | Working |
| `env.ts` | Loads `.env.local` for the worker process (Next.js does this automatically, worker doesn't) | Working |
| `queues.ts` | Defines 7 BullMQ queues with retry config (3 attempts, exponential backoff at 5s). Handles Redis connection for local, Railway, and Upstash. | Working |
| `jobs/OutboxPoller.ts` | Runs every 10 seconds. Reads pending outbox entries from Postgres, dispatches to BullMQ queues. Includes watchdog that recovers entries stuck in "dispatched" for over 1 hour. Uses FOR UPDATE SKIP LOCKED. | Working |
| `jobs/ReconciliationPoller.ts` | Runs every 60 minutes. Finds active businesses due for a review sync and creates outbox entries. Skips in mock mode. Has atomic dedup guard backed by a DB unique index. | Working |
| `jobs/ReviewSyncWorker.ts` | Fetches reviews from SerpAPI (or mock), compares against DB using content hashes, inserts new reviews, detects edits, triggers response generation. Each review processed in its own transaction. | Working |
| `jobs/ResponseGeneratorWorker.ts` | Calls AI to generate a response draft. Handles cost reservation, concurrency limits, regen budget, avoid-facts checking with one retry, voice learning. Persists response + notification outbox in one transaction. | Working |
| `jobs/NotificationWorker.ts` | Generates approval token (SHA-256 hash only stored in DB), sends approval email via Resend, records delivery. Handles orphaned link recovery on retry. | Working |
| `jobs/DemoGenerationWorker.ts` | Generates prospect demos: fetches reviews + AI responses, saves snapshot to DB. Has stale-running recovery. | Working |
| `jobs/ResponsePublisherWorker.ts` | Sets response to "awaiting_manual_post" and emails the admin/sales partner with the approved text + Google Maps link for manual copy-paste posting. | Working |
| `jobs/AdminExceptionWorker.ts` | Emails admin when a reviewer edits their review after a response was already posted. | Working |
| `jobs/WeeklySummaryWorker.ts` | Placeholder — will send weekly review summaries to business owners. | Sprint 4 |
| `ingress/resend.ts` | Handles Resend delivery webhooks (delivered/bounced/complained). Verifies svix signatures, deduplicates via inbound_events. | Working |
| `ingress/stripe.ts` | Handles Stripe webhooks (checkout completed, payment failed, paid, subscription deleted/updated). Verifies signatures, deduplicates via inbound_events, updates business subscription status. | Working |

### Worker Tests (`worker/__tests__/`)

| File | Tests |
|---|---|
| `ReconciliationPoller.test.ts` | Interval parsing, mock mode skip, lifecycle |
| `ReviewSyncWorker.test.ts` | Business not found, cancelled sub, null place_id, SerpAPI errors, new review, unchanged review, content changed + pending, content changed + posted, collision insert, collision dedup |
| `ResponseGeneratorWorker.test.ts` | Success, cancelled sub, cost limit, mock mode, avoid-facts retry with skipCache + cache overwrite |
| `NotificationWorker.test.ts` | Success, pending_payment skip, idempotent skip, orphaned link revocation, email failure |
| `ResponsePublisherWorker.test.ts` | Success, cancelled sub, already posted, email failure, retry with awaiting_manual_post |
| `AdminExceptionWorker.test.ts` | Success, already resolved, email failure |

### Next.js Pages (`src/app/`)

| File | What it does | Status |
|---|---|---|
| `layout.tsx` | Root HTML shell | Working |
| `(public)/page.tsx` | Landing page | Placeholder |
| `(public)/demo/[slug]/page.tsx` | Public demo viewer — shows reviews + AI responses for prospects | Working |
| `(public)/approve/[token]/page.tsx` | Approval page server shell — validates token, renders business name, loads client component | Working |
| `(public)/approve/[token]/approval-client.tsx` | Approval page client component — fetches review+response, shows approve/edit/regenerate buttons | Working |
| `(authenticated)/dashboard/page.tsx` | Business owner dashboard | Placeholder — Sprint 5 |
| `(authenticated)/settings/page.tsx` | Business owner settings | Placeholder — Sprint 3 |
| `admin/demos/page.tsx` | Admin page for generating prospect demos | Working |
| `admin/businesses/new/page.tsx` | Business onboarding form — react-hook-form + Zod, 14 fields, creates business + owner + sync outbox in one transaction | Working |
| `admin/businesses/[id]/page.tsx` | Business detail — editable profile, review list with status badges, awaiting manual post section | Working |
| `admin/businesses/[id]/manual-post-section.tsx` | Copy-to-clipboard + mark-as-posted buttons | Working |
| `admin/businesses/page.tsx` | Business list with pagination, "Add Business" button, clickable rows | Working |
| `admin/overview/page.tsx` | Admin CRM — system health cards + business table with 30s auto-refresh | Working |
| `admin/costs/page.tsx` | Cost monitoring — provider/business/day breakdown, daily limit progress bar, date filter | Working |
| `admin/jobs/page.tsx` | Queue health — outbox summary, BullMQ queue depth, failed jobs list | Working |
| `admin/notifications/page.tsx` | Notification delivery log — filters by business/channel/status, pagination | Working |
| `admin/login/page.tsx` | Admin login — Supabase Auth email/password | Working |
| `admin/layout.tsx` | Admin layout wrapper | Working |
| `admin/providers.tsx` | React Query provider for admin pages | Working |

### API Routes (`src/app/api/`)

| File | What it does | Status |
|---|---|---|
| `admin/demos/generate/route.ts` | POST: queues demo generation via outbox. Rate limited: 50/day global + 5/min per IP. | Working |
| `admin/demos/route.ts` | GET: lists all demos | Working |
| `admin/businesses/route.ts` | GET: business list with pagination. POST: onboard new business (creates business + owner + sync outbox in one transaction, returns Payment Link URL). | Working |
| `admin/businesses/[id]/route.ts` | GET: business detail + reviews + responses. PATCH: update business settings (Zod validated). | Working |
| `admin/businesses/[id]/mark-posted/route.ts` | POST: marks response as posted (awaiting_manual_post → posted) | Working |
| `admin/overview/route.ts` | GET: system health metrics + business list with response stats | Working |
| `admin/costs/route.ts` | GET: cost breakdown by provider, business, day. Accepts ?days= filter. | Working |
| `admin/notifications/route.ts` | GET: notification delivery log with filters + pagination | Working |
| `admin/jobs/route.ts` | GET: outbox counts + BullMQ queue health + failed jobs list | Working |
| `auth/callback/route.ts` | GET: Supabase auth code exchange for email confirmations | Working |
| `approve/[token]/route.ts` | GET: validates approval token, returns review+response data, sets cookies | Working |
| `approve/[token]/session/route.ts` | POST: binds device cookie to approval link | Working |
| `approve/[token]/approve/route.ts` | POST: approves response, queues publishing | Working |
| `approve/[token]/edit/route.ts` | POST: approves with edits, computes Levenshtein distance | Working |
| `approve/[token]/regenerate/route.ts` | POST: supersedes response, queues new generation | Working |

### Shared Business Logic (`src/lib/`)

#### `src/lib/reviews/` — Review fetching and normalization

| File | What it does |
|---|---|
| `types.ts` | Core types: NormalizedReview, ReviewSource interface, MonitorResult, identity types |
| `serpapi-source.ts` | Demo-mode fetcher: calls SerpAPI, normalizes to NormalizedReview |
| `serpapi-monitor.ts` | Production-mode fetcher: same SerpAPI call but adds identity hashing + collision detection |
| `serpapi-normalize.ts` | Shared normalization logic used by both source and monitor |
| `detect-language.ts` | Language detection using franc-min (ISO 639-3 → 639-1 mapping) |
| `url-parser.ts` | Extracts Google Place ID from various Maps URL formats |
| `mock-source.ts` | 8 canned reviews in 4 languages for mock mode |
| `mock-monitor.ts` | Mock version of SerpApiMonitor with identity enrichment |
| `index.ts` | Barrel exports |

#### `src/lib/responses/` — AI response generation

| File | What it does |
|---|---|
| `types.ts` | BusinessContext, VoiceExample, GenerationOptions, GenerationResult |
| `prompt-builder.ts` | Builds system+user prompts for demo mode (infers tone) and production mode (uses business config) |
| `generator.ts` | Dual-mode generator: demo (no cost guard) and production (full cost lifecycle). OpenAI primary, Anthropic fallback. Supports skipCache for avoid-facts retry. |
| `mock-generator.ts` | Template-based mock responses in 4 languages for mock mode |
| `voice-learning.ts` | Fetches owner-edited responses as few-shot voice examples (activates after 5 edits) |
| `index.ts` | Barrel exports |

#### `src/lib/costs/` — Cost safety

| File | What it does |
|---|---|
| `tracker.ts` | Redis-based cost reservation (pessimistic 15 cents), concurrency limiter (max 3/business), regen budget (max 3/day), idempotent cache. Tier-aware limits. |
| `audit.ts` | Postgres audit trail: recordApiCost(), linkApiCostToResponse(), calculateCostUsd() with model pricing |
| `index.ts` | Barrel exports |

#### `src/lib/approval/` — Approval flow

| File | What it does |
|---|---|
| `service.ts` | Core logic: lockValidLink (FOR UPDATE), establishSession, approve, edit (Levenshtein), regenerate. All methods receive a transaction client. Checks response is still pending before consuming link. |
| `cookies.ts` | HMAC-signed device cookie + CSRF double-submit pattern. Constant-time comparisons. |
| `errors.ts` | Typed errors: InvalidToken, Expired, Revoked, Consumed, DeviceConflict, ResponseNotPending |
| `http-errors.ts` | Shared error-to-HTTP-response mapper used by all 4 POST approval routes |
| `index.ts` | Barrel exports |

#### `src/lib/notifications/` — Email sending

| File | What it does |
|---|---|
| `email.ts` | sendApprovalEmail (HTML template with stars, reviewer, preview, CTA button) + sendInternalEmail (admin notifications) + buildManualPostEmailHtml(). HTML escaping on all dynamic content. Mock mode support. |
| `delivery.ts` | Shared recordNotificationDelivery() — inserts into notification_deliveries table (used by NotificationWorker + ResponsePublisherWorker) |
| `index.ts` | Barrel exports |

#### `src/lib/demos/` — Demo generation

| File | What it does |
|---|---|
| `generator.ts` | Fetches reviews + generates AI responses in parallel. Pure computation — no DB writes. |
| `types.ts` | DemoJobPayload, DemoGeneratorInput/Result, DemoMetadata, DemoListItem |
| `index.ts` | Barrel exports |

#### `src/lib/shared/` — Shared utilities

| File | What it does |
|---|---|
| `subscription-guard.ts` | Checks if a worker should process work for a business. 4 statuses × 4 worker types. |
| `outbox.ts` | markOutboxCompleted() and markOutboxFailed() — used by every worker |
| `sanitize.ts` | Strips control characters, null bytes, collapses whitespace |
| `rate-limit.ts` | Atomic Lua script rate limiter on Redis. Gracefully skips when Redis unavailable. |
| `mock-mode.ts` | isMockMode() + getReviewMonitor() factory |
| `worker-types.ts` | Job payload interfaces: SyncReviews, GenerateResponse, SendNotification, PublishResponse, NotifyAdminException |
| `constants.ts` | ResponseStatus, SubscriptionStatus, ExceptionType enums, NO_STORE_HEADERS, buildGoogleMapsUrl() |
| `schemas.ts` | Shared Zod schemas for business validation: OnboardBusinessSchema, UpdateBusinessSchema, field sub-schemas |
| `html.ts` | Shared escapeHtml() used by email templates and workers |
| `index.ts` | Barrel exports |

#### `src/lib/db/` — Database clients + auth

| File | What it does |
|---|---|
| `server.ts` | Postgres.js client (for transactions) + Supabase service-role client. 30s statement timeout. |
| `browser.ts` | Supabase browser client using `@supabase/ssr` createBrowserClient (auth-aware, manages cookies) |
| `auth.ts` | Server-side auth helpers: getCurrentUser (reads session from cookies, looks up users table), requireAuth, requireRole, AuthError class |
| `supabase-server.ts` | Cookie-aware Supabase client for Server Components and Route Handlers (anon key, RLS-aware) |
| `redis-cache.ts` | Redis cache client singleton (getCacheRedis) — used by rate limiter, cost tracker |
| `client.ts` | Deprecated — import from server.ts or browser.ts directly |

#### `src/lib/reviews/` additions

| File | What it does |
|---|---|
| `process-review.ts` | Review ingestion state machine: dedup, content-hash comparison, branching (new/unchanged/edited). Extracted from ReviewSyncWorker for reuse by future GBP API Pub/Sub handler. |

#### Other

| File | What it does |
|---|---|
| `src/lib/publishing/index.ts` | Placeholder — future GBP API posting |
| `src/types/index.ts` | Shared TypeScript interfaces placeholder |
| `src/middleware.ts` | Supabase Auth session refresh + role-based route protection. Admin/sales_partner for /admin/*, owner for /dashboard/*. Uses HTTP-based Supabase client (Edge-compatible). |

### Tests (`src/lib/*/__tests__/`)

| File | What it tests |
|---|---|
| `reviews/__tests__/serpapi-source.test.ts` | Normalization, content hashing, language detection, URL parsing, SerpAPI adapter |
| `responses/__tests__/prompt-builder.test.ts` | Category→tone inference, word limits, language, voice examples |
| `responses/__tests__/generator.test.ts` | OpenAI/Anthropic fallback, demo/production modes, cost lifecycle |
| `costs/__tests__/tracker.test.ts` | Cost calculation, reservation, concurrency, regen budget |
| `shared/__tests__/subscription-guard.test.ts` | All statuses × worker types, grace period |
| `shared/__tests__/sanitize.test.ts` | Control chars, null bytes, whitespace |
| `shared/__tests__/rate-limit.test.ts` | Allow, deny, exact limit |
| `approval/__tests__/service.test.ts` | lockValidLink variants, session binding, approve, edit, regenerate |
| `approval/__tests__/cookies.test.ts` | Device cookie HMAC, CSRF validation |

### E2E Tests (`e2e/`)

| File | Status |
|---|---|
| `approval.spec.ts` | Scaffolded with 5 test scenarios (skipped) — deferred to Sprint 4 pending test infrastructure |

---

## Current Live Workflow

This is the complete working flow as of today:

```
1. ReconciliationPoller (every 60 min)
   → Finds active businesses due for sync
   → Inserts sync_reviews outbox entry (atomic dedup)

2. OutboxPoller (every 10 sec)
   → Reads pending outbox entries
   → Dispatches to BullMQ queues
   → Watchdog recovers entries stuck >1 hour

3. ReviewSyncWorker
   → Fetches reviews from SerpAPI (or mock)
   → Deduplicates by identity hash
   → Detects edits via content hash
   → New review → inserts generate_response outbox entry
   → Edited review + pending → fails old response, regenerates
   → Edited review + posted → creates admin exception

4. ResponseGeneratorWorker
   → Checks idempotent cache (skip if already generated)
   → Reserves cost budget (Redis atomic INCRBY)
   → Calls OpenAI gpt-4o-mini (falls back to Anthropic claude-haiku-4-5)
   → Checks avoid-facts, retries once with skipCache if violated
   → Persists response + send_notification outbox in one transaction

5. NotificationWorker
   → Generates raw approval token (randomUUID)
   → Stores only SHA-256 hash in approval_links
   → Sends approval email via Resend (or mock)
   → Records delivery in notification_deliveries

6. Owner clicks approval link in email
   → GET /approve/{token} → validates, shows review + draft response
   → POST /approve/{token}/session → binds device cookie
   → POST /approve/{token}/approve → consumes link, inserts publish_response outbox
   (or /edit with Levenshtein distance, or /regenerate → supersedes + new generation)

7. ResponsePublisherWorker
   → Sets response to awaiting_manual_post
   → Emails admin with approved text + Google Maps link
   → Records delivery for idempotent retry

8. Sales partner manually posts on Google Maps
   → Opens /admin/businesses/{id}
   → Copies approved text
   → Pastes on Google Maps
   → Clicks "Mark as Posted" → response status = posted
```

**Also working:**
- Demo generation (separate flow for sales prospects via /admin/demos)
- Business onboarding (form → Payment Link → Stripe checkout → webhook → active subscription → ReconciliationPoller picks up)
- Admin dashboard (overview, costs, notifications, jobs — all with real data)
- Sentry error tracking on both Vercel and Railway
- Security headers on all responses

---

## What's Left To Build

### Sprint 3: COMPLETE ✓

Everything listed below was built in Sprint 3. See next section for what remains.

### Sprint 4: Production Hardening (Prompts 17-18)

- Notification failover (alert when approval emails aren't delivered)
- Weekly summary email worker
- Outbox + event archival (prevent table bloat)
- Correlation IDs across service boundaries
- PostHog analytics
- Playwright E2E tests for approval flow (test infrastructure: seed scripts, DB setup)
- Load testing (50 concurrent demo loads, 100 approval page loads/min)
- Security testing (prompt injection, cost amplification, token enumeration)

### Sprint 5: Churn Killers (Prompt 19)

- Owner-facing ROI dashboard (before/after response rate)
- Ranking snapshots (manual Google Maps rank tracking)
- AI-powered weekly intelligence brief

### Sprint 6: Scale to $1K MRR (Prompt 20)

- Voice learning activation (uses real owner edits as few-shot examples)
- Onboarding automation (pre-fill business details from SerpAPI)
- Customer health scoring
- Data archival for old records

### GBP API Integration (When Google Approves)

- OAuth flow for business onboarding
- Google Pub/Sub for real-time review notifications
- Automated response posting via GBP API (replaces manual copy-paste)
- Adaptive polling intervals
- Migrate existing customers from SerpAPI to GBP API
