# Current Implementation Map

This file explains what is actually built in the repository today, how it maps to the implementation plan, and what is left to build.

Last updated: 2026-04-15 (after Sprint 5A completion)

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

### Sprint 4: Production Hardening (Prompts 17-18)

We built the safety nets that let the system run 10 businesses without anyone touching it — automatic recovery when emails don't deliver, weekly owner summaries, database cleanup, and tests that verify the security mechanisms actually work.

**What it does:** If an approval email gets lost or bounces, the system detects it within 2 hours and re-sends automatically (alerting the admin if all attempts fail). Every Monday morning, business owners get a summary email with their week's review stats and any negative reviews needing attention. Old completed jobs and expired data are cleaned up automatically so database tables don't grow forever. Security tests verify that the cost guards, token hashing, input sanitization, and subscription checks all work correctly.

**What we built:**

**Notification Failover (Prompt 17):**
- NotificationFailoverPoller — runs every 2 hours, finds approval emails that were sent but never confirmed delivered after 4 hours, and re-queues them with a fresh approval token
- Detects two failure modes: "stale" (email sent, never delivered) and "all-failed" (every delivery attempt bounced or was marked as spam)
- Sends an admin alert email when all delivery attempts for a response have failed, with 24-hour dedup so the admin doesn't get spammed
- NotificationWorker upgraded with "failover-awareness" — normal retries check `sent_at` (was the email sent?), but failover re-sends check `delivered_at` (was it actually delivered?) so it can re-send when an email was sent but lost in transit

**Weekly Summaries (Prompt 17):**
- WeeklySummaryScheduler — runs every hour, checks if it's Monday 8-9 AM UTC, and queues summary emails for all active businesses
- WeeklySummaryWorker — queries the week's stats (total reviews, total responded, response rate %, notable negative reviews), builds a responsive HTML email, and sends it to the business owner
- Idempotent: uses `ON CONFLICT` + `WHERE sent_at IS NULL` so replayed jobs never send duplicate emails
- Summary covers the previous week (Monday to Sunday), not the current week

**Database Cleanup (Prompt 17):**
- ArchivalPoller — runs every 24 hours, deletes old data in batches of 5,000 to avoid long-running locks:
  - Completed outbox entries older than 7 days
  - Processed webhook events older than 30 days
  - Expired prospect demos older than 30 days past expiry

**Security Tests (Prompt 18):**
- 10 Vitest security property tests verifying existing security mechanisms work correctly:
  - `sanitizeText()` strips control characters from prompt-injection text without crashing or stripping semantic content
  - `escapeHtml()` escapes `<script>` tags and quote-based attribute injection
  - `checkRegenBudget()` rejects the 4th regeneration attempt per review per day and rolls back the Redis counter
  - `lockValidLink()` queries with SHA-256 hash of the raw token (verified by capturing the hash via mock)
  - Webhook replay dedup logic correctly identifies already-processed events
  - `ExpiredTokenError` and `DeviceConflictError` are proper Error subclasses
  - Subscription guard denies cancelled/pending_payment for notification and publisher workers

**E2E Approval Tests (Prompt 18):**
- 5 Playwright E2E test scenarios for the full approval flow (require `TEST_DATABASE_POOL_URL`):
  - Approve: navigate → click Approve → verify response status becomes 'approved' in DB
  - Edit: navigate → click Edit → modify text → Save & Approve → verify edited_text and edit_distance in DB
  - Expired: navigate to expired link → see "expired" error message
  - Regenerate: navigate → click Regenerate → verify old response 'superseded' + new generate_response outbox entry
  - Consumed: navigate to already-used link → see "already been approved" message
- Seed helper (`e2e/seed.ts`) with safety guards: fails fast without `TEST_DATABASE_POOL_URL`, creates unique data per test with cleanup in `finally` blocks
- Tests skip gracefully when no test DB is configured

**Infrastructure Fixes:**
- Redis cache client now fails fast when Redis is unreachable (3-second connect timeout, 1 retry max, offline queue disabled) — prevents API routes from hanging indefinitely when local Redis isn't running
- Two bugs fixed in Prompt 17 code: notification failover now processes all-failed BEFORE stale (so admin alerts actually fire), and weekly summary upsert correctly detects already-sent summaries

### Sprint 5A: Retention Stack (Prompts 19a, 19c, 19d, 19f)

We built everything needed to prove ROI to business owners and detect churn risk before customers leave — upgraded emails, an owner dashboard, automated engagement alerts, and a churn scoring system.

**What it does:** Business owners now receive rich "Weekly Value Report" emails with an AI Intelligence Brief summarizing customer themes, plus monthly impact emails showing cumulative value. They can log into a dashboard to see review velocity charts, response rate lift, and ranking trends. Meanwhile, the system watches for disengaged owners (not approving reviews) and automatically nudges them, escalating to the sales partner if they go silent for too long. The admin overview shows a Health column ranking every business by churn risk.

**Weekly Value Report + Monthly Impact Email (Prompt 19a):**
- Upgraded the basic weekly summary email into a "Weekly Value Report" with 7 sections: AI Intelligence Brief (3-5 sentence LLM summary of the week's reviews), Value Delivered header ("handled 7 reviews, saving you 49 minutes"), Response Rate Lift (current vs baseline), Review Velocity (this week vs 4-week average), conditional Google Maps Ranking, Notable Reviews, and a Dashboard link (only shown when owner has a login)
- New monthly impact email — sent on the 1st of each month with monthly intelligence brief, cumulative stats, best review of the month (with the approved response), and ranking change since joining
- AI Intelligence Brief uses a dedicated `generateReviewSummary()` helper with OpenAI→Anthropic fallback, cost reservation lifecycle, and mock mode support. Caps at 30 reviews, truncates text to prevent budget overruns. Reuses existing summary on retry (no duplicate LLM calls).
- Crash-safe email delivery: `claimed_at` column prevents duplicate sends between concurrent workers, `sent_at` set just before Resend call. If the send fails, both are cleared so retries can reclaim the report.
- MonthlyImpactScheduler polls hourly, fires on the 1st of the month 9-10 AM UTC
- `recordNotificationDelivery()` extended to support business-level notifications (responseId now optional)

**Read-Only Owner Dashboard (Prompt 19c):**
- `GET /api/dashboard` — single API endpoint returning all dashboard data in one payload, scoped by the authenticated owner's `business_id`. Defense-in-depth: `requireRole('owner')` + `businessId` null check. All responses use `NO_STORE_HEADERS`.
- Dashboard page with 5 sections: Value Summary Banner (blue gradient, reviews handled + time saved + response rate with baseline comparison), Review Velocity bar chart (recharts, last 8 weeks with zero-week fill), conditional Google Maps Ranking line chart (Y-axis inverted, one line per keyword, limited to 12 months), Recent Reviews list (last 10 with color-coded status badges, expandable approved response text, "check your email" for pending), Latest Intelligence Brief (most recent by `sent_at`, monthly preferred over weekly)
- OwnerNav component with business name + sign-out button (error handling on sign-out failure)
- Authenticated layout shell reads Supabase session, queries business name, renders OwnerNav
- Middleware protects `/api/dashboard` for owner role with no-store headers on 401/403

**Engagement Detection & Re-engagement (Prompt 19d):**
- EngagementMonitorPoller — runs daily, computes engagement metrics for ALL active businesses in one grouped CTE query (not N+1). 5 metrics: approval rate (30-day rolling), days since last approval, pending count, oldest pending age, notified response count.
- 4 engagement rules with cooldown dedup: owner_nudge (3+ days inactive, 3-day cooldown), partner_engagement_alert (7+ days, 7-day cooldown), partner_escalation_alert (14+ days, 14-day cooldown), partner_low_engagement (approval rate below 50% with 3+ notifications, 7-day cooldown)
- Atomic dedup: `INSERT ... WHERE NOT EXISTS` checks both cooldown deliveries and in-flight outbox entries. Backed by a partial unique index (migration 011) that catches concurrent races via 23505.
- EngagementAlertWorker routes by `alert_type`: owner_nudge creates fresh approval links for each pending review (via extracted `createApprovalLink()`) and sends a customer-facing nudge email; partner alerts send internal emails to the admin with business metrics and owner contact info
- `createApprovalLink()` extracted from NotificationWorker into `src/lib/approval/create-link.ts` for reuse. Supports `revokeMode: 'orphaned_only'` (normal notifications) and `revokeMode: 'always'` (nudge emails that replace stale links).
- 4 email templates: owner nudge (customer-facing, lists pending reviews with approval buttons), partner engagement alert (plain), partner escalation alert (red accent, "at risk"), partner low-engagement (amber accent, neutral wording — trend direction deferred to Sprint 5B)
- Owner nudge idempotency: checks for existing delivery within 1 day before creating links

**Churn Risk Score (Prompt 19f):**
- Pure function `computeChurnRiskScore()` — no DB calls, no side effects. Takes pre-queried metrics, returns a 0-100 score with level and signal breakdown.
- 5 weighted signals: Approval rate 30% (0-1 fraction with defensive auto-correction for 0-100), Days since approval 25%, Satisfaction pulse 20% (null until Sprint 5B), Response time trend 15%, Account age 10%
- Levels: 0-30 = healthy (green), 31-60 = watch (amber), 61-100 = at_risk (red)
- Weights and thresholds exported as constants for easy tuning
- Admin Overview enhanced: grouped metrics CTE query computes churn data for all businesses in one round trip. Sorted by risk score descending server-side before paginating. Health column with colored HealthBadge.
- Business Detail enhanced: risk badge next to business name + Engagement section with 5-signal breakdown showing name, value, color-coded contribution bar, and numeric contribution
- Response time trend derived from current-week vs previous-4-week average approval latency (>1.5x = slower, pending+stale = stopped)

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
| `007_place_id_verification.sql` | Place ID verification flag + PlaceIdValidationWorker outbox topic |
| `008_retention_core.sql` | Creates `monthly_impact_emails` table + notification delivery index for cooldown checks |
| `009_report_claim_columns.sql` | Adds `claimed_at` to `weekly_summaries` + `monthly_impact_emails` for atomic send claims |
| `010_dashboard_indexes.sql` | Composite index `(business_id, detected_at DESC)` on reviews for dashboard queries |
| `011_engagement_alert_dedup.sql` | Partial unique index on `job_outbox` for in-flight engagement alerts (prevents concurrent duplicates) |
| `012_outbox_status_doc.sql` | Documents `dispatching` status in outbox lifecycle comment |
| `013_churn_query_indexes.sql` | Response indexes for churn metrics: `(business_id, status, created_at)` + `(business_id, approved_at DESC)` |

### Worker Process (`worker/`)

Runs on Railway. Handles all background jobs — review syncing, AI generation, email sending, posting.

| File | What it does | Status |
|---|---|---|
| `index.ts` | Starts Fastify server + 11 BullMQ workers + OutboxPoller + ReconciliationPoller + NotificationFailoverPoller + WeeklySummaryScheduler + ArchivalPoller + MonthlyImpactScheduler + EngagementMonitorPoller. Handles graceful shutdown. | Working |
| `env.ts` | Loads `.env.local` for the worker process (Next.js does this automatically, worker doesn't) | Working |
| `queues.ts` | Defines 11 BullMQ queues with retry config (3 attempts, exponential backoff at 5s). Handles Redis connection for local, Railway, and Upstash. | Working |
| `jobs/OutboxPoller.ts` | Runs every 10 seconds. Two-phase dispatch: claims rows as 'dispatching' with `dispatched_at = NOW()`, then adds to BullMQ. Watchdog recovers 'dispatched' entries stuck >1 hour and stale 'dispatching' entries >2 minutes. Uses FOR UPDATE SKIP LOCKED. | Working |
| `jobs/ReconciliationPoller.ts` | Runs every 60 minutes. Finds active businesses due for a review sync and creates outbox entries. Skips in mock mode. Has atomic dedup guard backed by a DB unique index. | Working |
| `jobs/ReviewSyncWorker.ts` | Fetches reviews from SerpAPI (or mock), compares against DB using content hashes, inserts new reviews, detects edits, triggers response generation. Each review processed in its own transaction. | Working |
| `jobs/ResponseGeneratorWorker.ts` | Calls AI to generate a response draft. Handles cost reservation, concurrency limits, regen budget, avoid-facts checking with one retry, voice learning. Persists response + notification outbox in one transaction. | Working |
| `jobs/NotificationWorker.ts` | Calls shared `createApprovalLink()` for token generation + hash storage, sends approval email via Resend, records delivery. Handles orphaned link recovery on retry. Failover-aware: normal retries check sent_at, failover re-sends check delivered_at. | Working |
| `jobs/DemoGenerationWorker.ts` | Generates prospect demos: fetches reviews + AI responses, saves snapshot to DB. Has stale-running recovery. | Working |
| `jobs/ResponsePublisherWorker.ts` | Sets response to "awaiting_manual_post" and emails the admin/sales partner with the approved text + Google Maps link for manual copy-paste posting. | Working |
| `jobs/AdminExceptionWorker.ts` | Emails admin when a reviewer edits their review after a response was already posted. | Working |
| `jobs/WeeklySummaryWorker.ts` | Upgraded to Weekly Value Report: AI Intelligence Brief (via `generateReviewSummary`), value-delivered header, response rate lift, review velocity, conditional ranking, dashboard link. claimed_at/sent_at crash-safe pattern. Clears both on send failure for retry recovery. | Working |
| `jobs/WeeklySummaryScheduler.ts` | Runs every hour. On Monday 8-9 AM UTC, creates weekly_summary outbox entries for all active/past_due businesses. Dedup guard prevents duplicate entries. | Working |
| `jobs/NotificationFailoverPoller.ts` | Runs every 2 hours. Finds approval emails that were sent but never delivered after 4 hours and re-queues them. Alerts admin when all attempts fail. 24h admin alert dedup. | Working |
| `jobs/MonthlyImpactWorker.ts` | Processes `send_monthly_impact` outbox entries. Upserts `monthly_impact_emails` row (idempotent), queries month stats + best review, generates AI intelligence brief (reuses on retry), builds email, sends via Resend. claimed_at/sent_at crash-safe pattern. | Working |
| `jobs/MonthlyImpactScheduler.ts` | Runs every hour. On 1st of month 9-10 AM UTC, queues monthly impact emails for all active businesses. Dedup guard checks both table and in-flight outbox. | Working |
| `jobs/EngagementMonitorPoller.ts` | Runs every 24 hours. Single grouped CTE query computes engagement metrics across all active businesses. Applies 4 rules (owner_nudge, partner_engagement, partner_escalation, partner_low_engagement) with cooldown dedup. Atomic INSERT with NOT EXISTS + partial unique index. | Working |
| `jobs/EngagementAlertWorker.ts` | Routes by alert_type: owner_nudge creates fresh approval links per pending review and sends customer-facing nudge email; partner alerts send internal emails to admin. Idempotency check on owner nudge (skips if recent delivery exists). | Working |
| `jobs/PlaceIdValidationWorker.ts` | Validates Google Place IDs via SerpAPI search + haversine matching. | Working |
| `jobs/ArchivalPoller.ts` | Runs every 24 hours. Deletes completed outbox entries >7 days, processed events >30 days, expired demos >30 days. Batched at 5000 per cycle. | Working |
| `ingress/resend.ts` | Handles Resend delivery webhooks (delivered/bounced/complained). Verifies svix signatures, deduplicates via inbound_events. | Working |
| `ingress/stripe.ts` | Handles Stripe webhooks (checkout completed, payment failed, paid, subscription deleted/updated). Verifies signatures, deduplicates via inbound_events, updates business subscription status. | Working |

### Worker Tests (`worker/__tests__/`)

| File | Tests |
|---|---|
| `ReconciliationPoller.test.ts` | Interval parsing, mock mode skip, lifecycle |
| `ReviewSyncWorker.test.ts` | Business not found, cancelled sub, null place_id, SerpAPI errors, new review, unchanged review, content changed + pending, content changed + posted, collision insert, collision dedup |
| `ResponseGeneratorWorker.test.ts` | Success, cancelled sub, cost limit, mock mode, avoid-facts retry with skipCache + cache overwrite |
| `NotificationWorker.test.ts` | Success, pending_payment skip, idempotent skip, orphaned link revocation, email failure, failover skip on delivered, failover re-send on undelivered, failover subscription guard |
| `ResponsePublisherWorker.test.ts` | Success, cancelled sub, already posted, email failure, retry with awaiting_manual_post |
| `AdminExceptionWorker.test.ts` | Success, already resolved, email failure |
| `NotificationFailoverPoller.test.ts` | Stale failover queueing, all-failed admin alert, 24h alert dedup, lifecycle |
| `WeeklySummaryWorker.test.ts` | Full value report: LLM summary call, template switch, delivery recording, summary_text reuse, no-reviews skip, ranking data, dashboard URL, baseline rate, email failure recovery |
| `MonthlyImpactWorker.test.ts` | Full monthly flow: stats query, best review, LLM brief, idempotent upsert, already-sent skip, ranking, dashboard, baseline, email failure recovery |
| `EngagementMonitorPoller.test.ts` | All 4 engagement rules, cooldown suppression, multi-alert per business, null activityAge, insufficient sample size |
| `EngagementAlertWorker.test.ts` | Owner nudge with approval links, partner alerts (engagement/escalation/low-engagement), subscription guard, missing config, idempotency, email failure |

### Next.js Pages (`src/app/`)

| File | What it does | Status |
|---|---|---|
| `layout.tsx` | Root HTML shell | Working |
| `(public)/page.tsx` | Landing page | Placeholder |
| `(public)/demo/[slug]/page.tsx` | Public demo viewer — shows reviews + AI responses for prospects | Working |
| `(public)/approve/[token]/page.tsx` | Approval page server shell — validates token, renders business name, loads client component | Working |
| `(public)/approve/[token]/approval-client.tsx` | Approval page client component — fetches review+response, shows approve/edit/regenerate buttons | Working |
| `(authenticated)/layout.tsx` | Authenticated layout shell — reads Supabase session, renders OwnerNav with business name | Working |
| `(authenticated)/dashboard/page.tsx` | Owner dashboard — value summary banner, review velocity chart, ranking chart, recent reviews, intelligence brief | Working |
| `(authenticated)/settings/page.tsx` | Business owner settings | Placeholder — Sprint 5B |
| `admin/demos/page.tsx` | Admin page for generating prospect demos | Working |
| `admin/businesses/new/page.tsx` | Business onboarding form — react-hook-form + Zod, 14 fields, creates business + owner + sync outbox in one transaction | Working |
| `admin/businesses/[id]/page.tsx` | Business detail — editable profile, review list with status badges, churn risk badge + Engagement breakdown section, awaiting manual post section | Working |
| `admin/businesses/[id]/manual-post-section.tsx` | Copy-to-clipboard + mark-as-posted buttons | Working |
| `admin/businesses/page.tsx` | Business list with pagination, "Add Business" button, clickable rows | Working |
| `admin/overview/page.tsx` | Admin CRM — system health cards + business table with Health column (churn risk badges), sorted by risk score descending, 30s auto-refresh | Working |
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
| `admin/businesses/[id]/route.ts` | GET: business detail + reviews + responses + churn risk score. PATCH: update business settings (Zod validated). | Working |
| `dashboard/route.ts` | GET: owner dashboard data (8 parallel queries scoped by owner's business_id — value summary, velocity, ranking, recent reviews, briefs). All responses use NO_STORE_HEADERS. | Working |
| `admin/businesses/[id]/mark-posted/route.ts` | POST: marks response as posted (awaiting_manual_post → posted) | Working |
| `admin/overview/route.ts` | GET: system health metrics + business list with churn risk scores (grouped CTE metrics query, server-side risk sort, paginated) | Working |
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
| `review-summary.ts` | LLM-powered multi-review intelligence brief generator. OpenAI→Anthropic fallback, cost reservation lifecycle, caps at 30 reviews, mock mode support. Used by WeeklySummaryWorker + MonthlyImpactWorker. |
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
| `create-link.ts` | Shared approval link creation: generates randomUUID token, stores SHA-256 hash, supports `revokeMode: 'orphaned_only'` (normal) or `'always'` (nudge emails). Used by NotificationWorker + EngagementAlertWorker. |
| `cookies.ts` | HMAC-signed device cookie + CSRF double-submit pattern. Constant-time comparisons. |
| `errors.ts` | Typed errors: InvalidToken, Expired, Revoked, Consumed, DeviceConflict, ResponseNotPending |
| `http-errors.ts` | Shared error-to-HTTP-response mapper used by all 4 POST approval routes |
| `index.ts` | Barrel exports |

#### `src/lib/notifications/` — Email sending

| File | What it does |
|---|---|
| `email.ts` | sendApprovalEmail + sendInternalEmail + 8 template builders: buildManualPostEmailHtml, buildWeeklyValueReportHtml (AI brief, value stats, velocity, ranking, dashboard link), buildMonthlyImpactEmailHtml (monthly brief, best review, ranking), buildOwnerNudgeEmailHtml (pending reviews with approval buttons), buildPartnerEngagementAlertHtml, buildPartnerEscalationAlertHtml (red accent), buildPartnerLowEngagementAlertHtml (amber accent). All with HTML escaping + mock mode. |
| `delivery.ts` | Shared recordNotificationDelivery() — inserts into notification_deliveries. responseId is optional (supports business-level notifications like weekly/monthly reports). |
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
| `churn-score.ts` | Pure function `computeChurnRiskScore()` — 5 weighted signals (approval rate 30%, days since approval 25%, satisfaction pulse 20%, response time trend 15%, account age 10%). Returns score 0-100, level (healthy/watch/at_risk), and signal breakdown. Exported constants for tuning. |
| `worker-types.ts` | Job payload interfaces: SyncReviews, GenerateResponse, SendNotification (with failover), PublishResponse, NotifyAdminException, WeeklySummary, SendMonthlyImpact, ValidatePlaceId, EngagementAlert (with alert_type + metrics) |
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
| `redis-cache.ts` | Redis cache client singleton (getCacheRedis) — used by rate limiter, cost tracker. Fails fast with 3s timeout when Redis unreachable. |
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
| `src/components/OwnerNav.tsx` | Owner dashboard navigation — business name + sign-out button with error handling |
| `src/components/DashboardContent.tsx` | Owner dashboard client component — value summary banner, velocity BarChart, ranking LineChart (recharts), recent reviews with status badges + expandable responses, intelligence brief |
| `src/components/AdminNav.tsx` | Admin navigation bar with responsive mobile menu |
| `src/components/PlaceAutocomplete.tsx` | Google Maps Place Autocomplete input for business onboarding |
| `src/middleware.ts` | Supabase Auth session refresh + role-based route protection. Admin/sales_partner for /admin/*, owner for /dashboard/* and /api/dashboard (with no-store headers). Uses HTTP-based Supabase client (Edge-compatible). |

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
| `shared/__tests__/security.test.ts` | Prompt injection sanitization, XSS escaping, regen budget cost amplification, SHA-256 token hash verification via lockValidLink mock, webhook replay dedup logic, error type checks, subscription bypass (3 scenarios) |
| `shared/__tests__/churn-score.test.ts` | 39 tests: each signal independently, perfect engagement, fully disengaged, new account, boundary values (30/31/60/61), combined scoring, insufficient data, Sprint 5B null satisfaction |
| `responses/__tests__/review-summary.test.ts` | LLM summary, empty reviews, truncation, mock mode, fallback, both-fail, cost audit failure, cost reservation/finalization |
| `notifications/__tests__/email-templates.test.ts` | Weekly value report (11 tests: brief, time saved, baseline, velocity, ranking, dashboard, escaping) + monthly impact (7 tests) |
| `notifications/__tests__/engagement-email-templates.test.ts` | Owner nudge (8 tests) + partner engagement (6 tests) + partner escalation (5 tests) + partner low-engagement (5 tests). HTML escaping on all. |
| `api/dashboard/__tests__/route.test.ts` | 9 tests: auth errors, missing business, full data, null ranking/brief, zero velocity, weekly-over-monthly brief preference, pending reviews |

### E2E Tests (`e2e/`)

| File | Status |
|---|---|
| `seed.ts` | Test data seed/cleanup helper. Creates unique business + review + response + approval_link per test. Safety: fails fast without `TEST_DATABASE_POOL_URL`. Cleanup in FK-safe order. | Working |
| `approval.spec.ts` | 5 Playwright E2E scenarios: approve, edit (with Levenshtein), expired, regenerate (superseded + outbox), consumed. Per-test isolation with cleanup in `finally`. Skips gracefully when no test DB configured. | Working (requires TEST_DATABASE_POOL_URL) |

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
- Admin dashboard (overview with Health column, costs, notifications, jobs — all with real data)
- Owner dashboard (value summary, velocity chart, ranking chart, recent reviews, intelligence brief)
- Sentry error tracking on both Vercel and Railway
- Security headers on all responses
- NotificationFailoverPoller (every 2h) — re-sends approval emails that were never delivered, alerts admin on permanent failures
- WeeklySummaryScheduler (Monday 8-9 AM UTC) → WeeklySummaryWorker → sends Weekly Value Report with AI Intelligence Brief
- MonthlyImpactScheduler (1st of month 9-10 AM UTC) → MonthlyImpactWorker → sends Monthly Impact Report
- EngagementMonitorPoller (every 24h) → EngagementAlertWorker → owner nudges with fresh approval links + partner escalation alerts
- ArchivalPoller (every 24h) — cleans up old completed outbox entries, processed events, and expired demos
- Churn risk scoring on admin overview + business detail pages

---

## Page Workflow — What Links Where

This documents every page-to-page navigation path in the application.

### Public Pages (no auth required)

```
Landing Page (/)
├── Nav: "Admin Login" → /admin/login
├── Hero: "Get Started" → /admin/login
├── Hero: "See How It Works" → #how-it-works (scroll)
└── Footer: "Admin" → /admin/login

Demo Viewer (/demo/[slug])
├── Standalone — no outbound links to other app pages
└── CTA at bottom (Calendly link when configured)

Approval Page (/approve/[token])
├── Standalone — owner lands here from email link
├── "Approve" button → POST /api/approve/[token]/approve → success message
├── "Edit" button → shows textarea → "Save & Approve" → POST /api/approve/[token]/edit → success
└── "Regenerate" button → POST /api/approve/[token]/regenerate → success message
```

### Owner Pages (requires owner auth)

```
/dashboard
├── Value Summary Banner (reviews handled, time saved, response rate with baseline)
├── Review Velocity bar chart (last 8 weeks)
├── Google Maps Ranking chart (conditional — only if ranking data exists)
├── Recent Reviews list (last 10, expandable responses, "check email" for pending)
├── Latest Intelligence Brief (most recent monthly or weekly)
└── OwnerNav: "Sign out" → /admin/login
```

### Admin Pages (requires admin/sales_partner auth)

```
/admin/login
└── On success → /admin/overview

/admin/overview (CRM home)
├── Business table rows → /admin/businesses/[id]
├── Nav links → /admin/costs, /admin/notifications, /admin/jobs, /admin/demos
└── "Add Business" → /admin/businesses/new

/admin/businesses (list)
├── Table rows → /admin/businesses/[id]
└── "Add Business" → /admin/businesses/new

/admin/businesses/new (onboarding form)
└── On submit → /admin/businesses/[id] (redirects to new business detail)

/admin/businesses/[id] (detail)
├── Inline-editable profile fields → PATCH /api/admin/businesses/[id]
├── Review list with status badges (read-only)
├── "Copy to Clipboard" → copies approved response text
└── "Mark as Posted" → POST /api/admin/businesses/[id]/mark-posted

/admin/demos (demo generator)
├── "Generate Demo" → POST /api/admin/demos/generate → polls for completion
└── Demo list: "Copy Link" → copies /demo/[slug] URL to clipboard

/admin/costs → standalone dashboard (no outbound links)
/admin/notifications → standalone dashboard (no outbound links)
/admin/jobs → standalone dashboard (no outbound links)
```

### Email-Triggered Flows (no direct page links)

```
Approval email → owner clicks "Review & Approve" → /approve/[token]
Manual-post email → admin reads instructions → opens Google Maps manually
Weekly Value Report email → owner reads stats → optional "See your full dashboard →" link → /dashboard (if owner has auth)
Monthly Impact Report email → owner reads cumulative stats → optional dashboard link
Owner nudge email → owner clicks "Review & Approve →" → /approve/[token] (fresh link)
Partner engagement/escalation/low-engagement alert → admin reads alert (no app link)
Admin exception alert → admin reads alert (no app link)
Notification failover → re-sends approval email → /approve/[token]
```

---

## What's Left To Build

### Sprint 3: COMPLETE ✓
### Sprint 4: COMPLETE ✓
### Sprint 5A: COMPLETE ✓

Everything through Sprint 5A is built and working. See next section for what remains.

### Deferred from Sprint 4 to Sprint 6:
- Correlation IDs across service boundaries (Sentry breadcrumbs + log prefixes sufficient at 10 businesses)
- PostHog analytics (zero paying customers = zero analytics value)
- Load testing with k6/Artillery (10 businesses × 10 reviews/month doesn't warrant it yet)
- DB-backed integration tests (requires dedicated test database in CI)

### Sprint 5B: Deferred Retention Features

- Automated ranking tracking (SerpAPI, feature-flagged, biweekly, cost-capped)
- Satisfaction pulse (weekly email with great/ok/not_great response — GET confirms, POST mutates)
- Onboarding drip emails (day 1, 7, 30 — only for `active` businesses, based on `subscription_activated_at`)
- Owner settings page (notification preferences, dashboard approval actions)
- Low-engagement trend direction (requires historical approval_rate snapshots)

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

### Upstash Redis VS Railway Redis (Take in consideration while deploying)


Railway lets you spin up a Redis instance as a Railway service inside the same project as your worker. When two Railway services talk to each other within the same project, the traffic stays on Railway's internal network — $0 egress.    
  
  Right now your setup looks like:                                                                                                                                                                                                                                                                                                                                                                                                                                                            
  Railway (worker) ──TLS over internet──▶ Upstash Redis (external)                                                                                                                                                                                                   ↑ every byte = $0.05/GB egress                                                                                                                                                                                                                                                                                                                                                                                                                                            With Railway's Redis addon:                                                                                                                                                                                                                                                                                                                                                                                                                                                                   Railway (worker) ──internal network──▶ Railway Redis (same project)                                                                                                                                                                                                ↑ $0 egress                                                                                                                                                                                                              

  How to set it up

  1. In your Railway project dashboard, click "+ New" → "Database" → "Redis"
  2. Railway provisions a Redis instance and exposes connection variables (REDIS_URL, REDIS_PRIVATE_URL, etc.) automatically
  3. Use REDIS_PRIVATE_URL (internal networking) as your REDIS_QUEUE_URL — this routes through Railway's private network, not the public internet
  4. Remove (or keep as fallback) the Upstash queue Redis credentials

  Cost comparison

  ┌───────────────────┬─────────────────────────────┬─────────────────────────────────────────┐
  │                   │      Upstash (current)      │              Railway Redis              │
  ├───────────────────┼─────────────────────────────┼─────────────────────────────────────────┤
  │ Egress            │ $0.05/GB (was $16/day)      │ $0 (internal)                           │
  ├───────────────────┼─────────────────────────────┼─────────────────────────────────────────┤
  │ Compute           │ Free tier / pay-per-command │ ~$5-10/mo for a small instance          │
  ├───────────────────┼─────────────────────────────┼─────────────────────────────────────────┤
  │ Blocking commands │ Unreliable (serverless)     │ Native Redis, BRPOPLPUSH works properly │
  └───────────────────┴─────────────────────────────┴─────────────────────────────────────────┘

  The blocking commands point matters a lot. Upstash is serverless Redis — it doesn't truly support BRPOPLPUSH blocking, which is likely why BullMQ was spin-polling so aggressively. A real Redis instance blocks properly, so even without   
  the drainDelay fix, it would idle quietly.

  Tradeoff

  Railway Redis costs a flat ~$5-10/mo for a small instance regardless of usage, vs Upstash which is pay-per-command (cheap when idle). But you already proved that "cheap when idle" doesn't apply when BullMQ is polling 35 times/sec. The   
  flat cost is far more predictable.

  You'd still keep your Upstash cache Redis separate (the one used by redis-cache.ts for rate limiting/cost guards) — that one gets hit infrequently and is fine as external. It's only the BullMQ queue Redis that's chatty.

  ## Light/Dark mode future consideration -  
  Your system is in dark mode (prefers-color-scheme: dark) and the gmp-place-autocomplete element has color-scheme: light dark — so it picks dark. The rest of your app ignores system dark mode but Google's component doesn't. (Current Implementation) The fix is simple: force color-scheme: light only on the element. Let me rewrite using the new PlaceAutocompleteElement class properly with this fix
