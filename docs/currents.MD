# Current Implementation Map

This file explains what is actually built in the repository today, how it maps to the implementation plan, and what is left to build.

Last updated: 2026-04-18 (after Sprint 6 completion)

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
- RankingTrackingScheduler (biweekly, feature-flagged) → RankingTrackingWorker → SerpAPI ranking search + upsert (strict fail-closed budget)
- OnboardingDripScheduler (hourly) → OnboardingDripWorker → day 1/7/30 onboarding emails with claim-before-send idempotency
- Owner settings page with notification opt-out (weekly/monthly toggle)
- Dashboard approval actions (approve/edit/regenerate via session auth, separate from token-based routes)
- Satisfaction pulse in weekly email (HMAC-signed links → scanner-safe GET confirmation → POST upsert + partner alert for "Not great")
- Admin keyword management + manual ranking entry on business detail page

---

## Sprint 5B Workflows

These are the new workflows added in Sprint 5B. Each one runs independently alongside the core review pipeline above.

### Automated Ranking Tracking

```
1. RankingTrackingScheduler (hourly, fires biweekly on even-week Sunday 22 UTC)
   → Checks RANKING_TRACKING_ENABLED === 'true' (skips silently if not)
   → Checks mock mode (skips if true)
   → Checks current time is Sunday, hour 22, ISO week number is even
   → Single query: finds active businesses with verified place ID +
     tracked keywords + location data (coords or search location)
   → Inserts track_ranking outbox entries with run_date for dedup
   → ON CONFLICT DO NOTHING (partial unique index prevents duplicates)

2. OutboxPoller dispatches to BullMQ

3. RankingTrackingWorker
   → Loads business, checks subscription_status === 'active' (strict — no past_due grace)
   → Re-checks google_place_id is still set
   → Parses tracked_keywords (JSONB guard + filters empty strings)
   → Limits to 1 keyword per business (Sprint 5B initial rollout)
   → Per-keyword: checks monthly SerpAPI budget via checkRateLimit({ strict: true })
     (fails closed when Redis unavailable — no ranking without budget enforcement)
   → In mock mode: generates random rank 1-10
   → In real mode: calls SerpAPI engine=google_maps with ll= (coords) or location= (text)
   → Finds business by matching place_id in local_results
   → Uses SerpAPI position field when available, falls back to index + 1
   → Upserts into ranking_snapshots ON CONFLICT (business_id, keyword, snapshot_date)
   → Marks outbox completed
```

### Owner Settings

```
1. Owner navigates to /settings (requires owner auth)

2. Page fetches GET /api/dashboard (includes settings data)
   → Shows read-only fields: name, category, Google Place ID
   → Shows editable fields: tone, products/services, avoid facts, sample responses
   → Shows notification preferences: channel (email/sms/both), phone, weekly/monthly toggles

3. Owner makes changes, clicks "Save Changes"
   → PUT /api/settings (Zod validated, owner-scoped by session — never accepts business_id in body)
   → Only sends changed fields (diff against initial values)
   → SMS channel requires phone number (checks stored phone for partial updates)
   → Success: green banner, auto-dismiss after 3 seconds

4. Opt-out takes effect:
   → WeeklySummaryScheduler skips businesses where weekly_summary_enabled = FALSE
   → MonthlyImpactScheduler skips businesses where monthly_impact_enabled = FALSE
```

### Dashboard Approval Actions

```
1. Owner navigates to /dashboard

2. Pending reviews show Approve / Edit / Regenerate buttons
   (only when review.responseStatus === 'pending_approval' AND responseText exists)

3. Owner clicks Approve:
   → POST /api/dashboard/reviews/{reviewId}/approve
   → requireRole('owner') + query scoped by business_id (prevents IDOR)
   → sql.begin: approveBySession() → lockPendingResponse + revokeOpenLinksForResponse
     + UPDATE status='approved' + INSERT publish_response outbox
   → approval_audit_log: auth_method='owner_session', actor_user_id, token_hash=NULL
   → ResponsePublisherWorker picks up (same manual-post flow as email-based approval)

4. Owner clicks Edit:
   → Textarea appears pre-filled with draft text
   → Owner modifies, clicks "Save & Approve"
   → POST /api/dashboard/reviews/{reviewId}/edit with { editedText }
   → Same flow as approve but computes Levenshtein distance, sets status='edited'

5. Owner clicks Regenerate:
   → POST /api/dashboard/reviews/{reviewId}/regenerate
   → Old response set to 'superseded', new generate_response outbox entry created
   → Owner sees "New draft requested — check your email"

Note: The existing email-based token approval flow is completely unchanged.
Dashboard actions are a parallel entry point using session auth, converging
on the same core response mutation logic.
```

### Onboarding Drip Emails

```
1. Business subscribes via Stripe
   → checkout.session.completed webhook fires
   → Sets subscription_activated_at = COALESCE(subscription_activated_at, NOW())
     (COALESCE preserves the anchor if re-activating from past_due)

2. OnboardingDripScheduler (hourly)
   → Single CROSS JOIN query: finds all (business, drip_type) pairs where:
     - subscription_status = 'active'
     - subscription_activated_at <= NOW() - interval (1/7/30 days)
     - No sent drip_log entry (sent_at IS NOT NULL)
     - No in-flight outbox entry
   → Inserts onboarding_drip outbox entries ON CONFLICT DO NOTHING

3. OutboxPoller dispatches to BullMQ

4. OnboardingDripWorker
   → Loads business, checks subscription_status === 'active'
   → Validates subscription_activated_at is not null (day 7/30)
   → Claims drip_log entry BEFORE any side effects:
     INSERT ... ON CONFLICT DO NOTHING RETURNING id
     If row exists: atomic UPDATE takeover if same outbox_id OR claim > 15 min stale
     If sent_at IS NOT NULL: skip (already sent)
   → Checks owner has auth (for dashboard URL)
   → Branches by drip_type:

   Day 1 (Welcome):
     → Sends welcome email: how it works, 30-second approval, weekly report mention
     → Conditional dashboard link (only if owner has auth mapping)

   Day 7 (First Week Recap):
     → Queries first-week stats bounded to [activatedAt, activatedAt + 7 days):
       reviews handled, time saved, response rate, highlight review, has edits
     → If pending reviews exist: creates fresh approval links via createApprovalLink()
       (throws if NEXT_PUBLIC_APP_URL missing — strict, matches owner-nudge behavior)
     → If zero reviews: "No reviews came in — we're watching"

   Day 30 (First Month Impact):
     → Queries first-month stats bounded to [activatedAt, activatedAt + 30 days)
     → Response rate before → now (from ROI baseline)
     → Ranking change if ranking_snapshots data exists
     → Sales partner sign-off (business-scoped via onboarded_by with role check)

   → Sends email via Resend (or mock)
   → Updates onboarding_drip_log.sent_at = NOW()
   → Records notification delivery
   → Marks outbox completed
```

### Satisfaction Pulse

```
1. WeeklySummaryWorker sends Weekly Value Report email
   → If CSRF_SECRET is configured:
     Builds 3 HMAC-signed feedback URLs (great / ok / not_great)
     HMAC input: business_id + rating + week_start_date
     Adds satisfaction pulse section at bottom of email:
     [Great]  [OK]  [Not great]

2. Owner clicks one of the three buttons
   → Opens GET /api/feedback?business_id=X&rating=Y&week=YYYY-MM-DD&sig=HMAC
   → Route validates: HMAC signature, UUID format, calendar date
   → Renders lightweight HTML confirmation page (NOT a Next.js page)
   → Shows rating label + "Submit Feedback" button
   → For "Not great": shows optional comment textarea
   → NEVER writes to database (email scanners prefetch GET URLs)

3. Owner clicks "Submit Feedback"
   → POST /api/feedback (HTML form submission, not JSON)
   → Re-validates HMAC from hidden form fields
   → Single sql.begin() transaction:
     a. Upsert satisfaction_responses ON CONFLICT (business_id, week_start_date)
        DO UPDATE SET rating, comment
     b. If rating = 'not_great':
        SELECT dedup check (existing alert for same business + week?)
        INSERT engagement_alert outbox ON CONFLICT DO NOTHING
        (ON CONFLICT prevents broad index from aborting the transaction)
   → Redirects 303 to /feedback/thanks

4. If "Not great" alert was queued:
   → OutboxPoller dispatches to BullMQ
   → EngagementAlertWorker.handleSatisfactionAlert()
     → Validates JSONB payload at runtime (rating, date, comment types)
     → Re-reads satisfaction_responses from DB (skips if owner changed to ok/great)
     → Checks week-scoped idempotency (template='partner_satisfaction_alert:YYYY-MM-DD')
     → Sends partner alert email with rating + comment + owner contact
     → Records delivery
```

---

## Page Workflow — What Links Where

This documents every page-to-page navigation path in the application,
verified against the source as of 2026-04-18.

### From the Landing Page — Full Traversal Map

The landing page `/` is the single entry point for both admins (via
`/admin/login`) and prospects. Below is the complete tree of what's
reachable from there, annotated with auth requirements and redirects.

```
/ (landing page, public)
│
├─[click "Admin Login" / "Get Started" / "Admin"]→ /admin/login
│
└─[click "See How It Works"]→ #how-it-works anchor (same page)


/admin/login (public, shared login for ALL roles — not admin-only despite the URL)
│
├─[sign-in succeeds, role = 'admin' or 'sales_partner']→
│      → honors ?from= if it's under /admin/*
│      → else → /admin/overview
│
├─[sign-in succeeds, role = 'owner']→
│      → honors ?from= if it's under /dashboard/* or /settings/*
│      → else → /dashboard
│
└─[sign-in succeeds, role unknown / missing]→ /admin/overview
       (middleware will bounce if role doesn't fit)


───── Admin branch (role = admin | sales_partner) ────────────────────

/admin/overview (the admin CRM home)
│ Landed here after admin sign-in. Shows system health cards + business
│ table sorted by churn risk. Has top AdminNav bar present on every
│ /admin/* page (except /admin/login and /admin/payment-success).
│
├─[AdminNav links]→ /admin/overview, /admin/businesses, /admin/demos,
│                   /admin/costs, /admin/notifications, /admin/jobs,
│                   /admin/runbook
├─[business table row click]→ /admin/businesses/[id]
├─[health "Demos" / "Manage" shortcut]→ /admin/demos / /admin/businesses
└─["Add Business" button]→ /admin/businesses/new


/admin/businesses (business list — paginated)
├─[AdminNav]→ same 7 admin links as above
├─[table row click]→ /admin/businesses/[id]
└─["Add Business" button]→ /admin/businesses/new


/admin/businesses/new (onboarding form)
│ react-hook-form + Zod. Creates business + owner user + initial
│ sync outbox in one atomic transaction. Returns Stripe Payment Link.
│
├─[form submit, paymentUrl returned]→ window.location = paymentUrl
│                                    (external — leaves the app to
│                                     Stripe Checkout)
├─[form submit, no paymentUrl]→ /admin/businesses/[id] (new detail page)
└─[AdminNav]→ same 7 admin links


/admin/businesses/[id] (business detail + review CRM)
│ Editable profile, review list with status badges, churn risk badge,
│ engagement breakdown, tracked keywords, ranking, manual-post section.
│
├─[inline profile editor save]→ PATCH /api/admin/businesses/[id]
│                               (no navigation — updates in place)
├─["Back to overview" link in header]→ /admin/overview
├─[Google Maps link]→ external maps.google.com
├─[Clear bounce flag button]→ PATCH {ownerEmailBounced:false}
│                            (no navigation)
├─[Manual Post Section "Copy to Clipboard"]→ clipboard only
├─[Manual Post Section "Mark as Posted"]→ POST .../mark-posted
│                                        (no navigation)
├─[Keywords PUT]→ PUT .../keywords (no navigation)
├─[Ranking manual entry]→ POST .../ranking (no navigation)
└─[AdminNav]→ same 7 admin links


/admin/demos (prospect demo generator)
├─["Generate Demo" button]→ POST /api/admin/demos/generate → polls
│                          /api/admin/demos for completion (no navigation)
├─[Demo list "Copy Link"]→ clipboard: /demo/<slug> URL
├─[Demo list slug link]→ /demo/[slug] (new tab)
└─[AdminNav]→ same 7 admin links


/admin/costs (cost monitoring — standalone dashboard)
├─[Day range selector]→ re-query via /api/admin/costs (no navigation)
└─[AdminNav]→ same 7 admin links


/admin/notifications (delivery log — standalone dashboard)
├─[Filter controls + pagination]→ re-query (no navigation)
└─[AdminNav]→ same 7 admin links


/admin/jobs (queue health — standalone dashboard)
├─[Shows 5 counters: Pending / Dispatching / Dispatched / Failed / Completed Today]
├─[Failed jobs pagination]→ re-query (no navigation)
└─[AdminNav]→ same 7 admin links


/admin/runbook (static quick-reference page)
├─[5-scenario "Customer says X" table — read only, no actions]
├─[Footer refs]→ docs/operational-runbook.md, docs/smoke-test-checklist.md,
│                docs/email-deliverability.md
│                (clickable anchors when NEXT_PUBLIC_DOCS_BASE_URL is set,
│                else rendered as <code> filenames)
└─[AdminNav]→ same 7 admin links


/admin/payment-success (post-Stripe-checkout landing)
│ Stripe redirects back here after the customer pays. Polls the
│ payment-success API by session_id to find the activated business.
│
├─[business found]→ router.push(/admin/businesses/[id])
├─["Go to business"/"Continue" buttons]→ /admin/businesses/[id]
└─["Go to overview"]→ /admin/overview
    (no AdminNav on this page — it's a transient landing)


───── Owner branch (role = owner) ────────────────────────────────────

/dashboard (owner home)
│ Landed here after owner sign-in. Has top OwnerNav bar present on
│ /dashboard and /settings.
│
├─[OwnerNav "Dashboard"]→ /dashboard
├─[OwnerNav "Settings"]→ /settings
├─[OwnerNav "Sign out"]→ router.push('/admin/login')
│                       (shared login page; on re-sign-in, role-aware
│                        redirect sends them back to /dashboard)
├─[Recent Reviews: Approve / Edit / Regenerate buttons on pending rows]→
│      POST /api/dashboard/reviews/[reviewId]/{approve,edit,regenerate}
│      (no navigation — content updates in place)
└─[No direct link to any public pages]


/settings (owner settings — profile + notification prefs)
├─[OwnerNav]→ same 3 items (/dashboard, /settings, Sign out)
├─["Save Changes"]→ PUT /api/settings (no navigation, shows toast)
└─[No links to other pages]


───── Email-triggered entry points (public URLs owners land on) ──────

Every approval email contains a token-authenticated URL that owners
click WITHOUT logging in. These are all public routes protected by
the HMAC/token in the URL itself.

/approve/[token] (approval page)
│ Owner lands here from an approval email. No auth UI — device cookie
│ + CSRF handle trust. Page is standalone (no nav bar).
│
├─["Approve" button]→ POST /api/approve/[token]/approve → success state
├─["Edit" button]→ textarea appears → "Save & Approve" →
│                  POST /api/approve/[token]/edit → success state
├─["Regenerate" button]→ POST /api/approve/[token]/regenerate → success state
├─[expired link]→ static "this link has expired" message
└─[already-consumed]→ static "already been approved" message


/demo/[slug] (prospect demo viewer)
│ Sales partner shares this URL with prospects. Renders their reviews
│ with AI-generated responses.
│
└─[CTA at bottom]→ mailto: link (NEXT_PUBLIC_CONTACT_EMAIL)


/api/feedback?business_id=X&rating=Y&week=...&sig=HMAC
│ Satisfaction pulse URLs in weekly value report emails. Validates
│ HMAC, renders a confirmation page. NOT a Next.js page — served
│ directly by the API route as HTML.
│
└─["Submit Feedback" button]→ POST /api/feedback → 303 redirect to
                              /feedback/thanks


/feedback/thanks (static thank-you page after satisfaction submission)
└─[No outbound links]
```


### Email → App Entry Points

These are the URLs embedded in customer-facing emails. All of them
land on the routes described above but originate from a worker's
email send, so they don't appear in any page-level navigation graph.

| Email | Button / link | Destination |
|---|---|---|
| Approval request (transactional) | "Review & Approve" | `/approve/[token]` |
| Manual-post alert (internal to admin) | *(read-only instructions)* | *(admin opens Google Maps manually)* |
| Weekly Value Report (marketing) | "See your full dashboard" | `/dashboard` (conditional on owner having auth) |
| Weekly Value Report (marketing) | Great / OK / Not great buttons | `GET /api/feedback?...&sig=HMAC` → submit → `/feedback/thanks` |
| Monthly Impact Report (marketing) | Dashboard link | `/dashboard` |
| Owner nudge (marketing) | "Review & Approve" (one per pending review) | `/approve/[token]` (fresh link) |
| Onboarding drip day 1 (marketing) | Dashboard link | `/dashboard` (conditional) |
| Onboarding drip day 7 (marketing) | Approval link per pending review | `/approve/[token]` |
| Onboarding drip day 30 (marketing) | *(read-only milestone)* | *(no link)* |
| Partner engagement / escalation / low-engagement alert (internal) | *(read-only)* | *(admin reads alert)* |
| Partner satisfaction alert (internal) | *(read-only)* | *(admin reads alert)* |
| Admin exception alert (internal) | *(read-only)* | *(admin reads alert)* |
| Notification failover re-send (transactional) | "Review & Approve" | `/approve/[token]` (replacement link) |


### Middleware Redirect Behavior

`src/middleware.ts` guards every page and API route. The behavior
matters for knowing where unauthenticated requests end up:

| Route pattern | Unauthenticated / wrong role | Authenticated with correct role |
|---|---|---|
| `/admin/login` | allowed | allowed (but the page itself sends you elsewhere on submit) |
| `/admin/*` (any other) | 302 → `/admin/login?from=<path>` | allowed |
| `/api/admin/*` | 401 | allowed |
| `/dashboard/*`, `/settings/*` | 302 → `/admin/login?from=<path>` | allowed |
| `/api/dashboard/*`, `/api/settings/*` | 401 / 403 | allowed |
| `/approve/*`, `/demo/*`, `/feedback/*`, `/` | always allowed (public) | — |
| `/api/approve/*`, `/api/feedback` | always allowed (token/HMAC auth) | — |

The login page (`/admin/login`) and the auth callback (`/api/auth/callback`)
are role-aware: after a successful sign-in they look up the user's role
and route to `/dashboard` for owner or `/admin/overview` for
admin/sales_partner. A requested `?from=` is honored only if the path
matches the user's role scope — otherwise the role default wins. This
prevents the post-sign-in redirect loop an owner would otherwise hit
when `?from` pointed into `/admin/*`.


### Known Navigation Observations (not bugs)

- **`/admin/login` is the shared login page for all roles.** The URL
  is misleading but changing it would break existing bookmarks and email
  templates. The page title is "RepWorth Admin" but actually accepts any
  role. The post-sign-in redirect is role-aware.
- **OwnerNav "Sign out" routes to `/admin/login`.** This is intentional
  (single login page for the whole app). After signing back in, the
  role-aware redirect sends owners to `/dashboard`.
- **No "back to landing" link anywhere inside the app.** Admins and
  owners are expected to stay inside their respective branches.
- **`/admin/runbook` references `docs/*.md` by filename.** These are
  clickable anchors only if `NEXT_PUBLIC_DOCS_BASE_URL` is set to the
  GitHub blob URL or similar. Otherwise they render as `<code>` text
  for oncall engineers with a local clone.
- **`/admin/payment-success` is transient.** It has no AdminNav (Stripe
  redirects here before the full admin shell is in play). It polls the
  payment-success API then redirects to the business detail page.

### Sprint 5B: Retention Expansion (Prompts 19b, 19c-5B, 19d-5B, 19e, 19g)

We built the remaining retention features — automated ranking tracking, owner settings with notification opt-out, dashboard approval actions, onboarding drip emails, and satisfaction pulse feedback.

**What it does:** Google Maps ranking is tracked automatically every two weeks via SerpAPI (feature-flagged, budget-capped). Business owners can now edit their profile and toggle weekly/monthly email preferences from a settings page. They can also approve, edit, or regenerate review responses directly from the dashboard (without needing the email link). New customers receive onboarding emails at day 1, 7, and 30 after subscribing. The weekly value report email now includes a satisfaction pulse — three buttons (Great / OK / Not great) that let the owner rate their experience without logging in. A "Not great" response triggers an alert to the sales partner.

**Automated Ranking Tracking (Prompt 19b):**
- RankingTrackingScheduler — runs hourly, fires biweekly on even-week Sundays at 22:00 UTC. Feature-flagged via `RANKING_TRACKING_ENABLED` env var (disabled by default). Queries eligible businesses (active, verified place ID, has coordinates or search location, non-empty tracked keywords).
- RankingTrackingWorker — calls SerpAPI `engine=google_maps` with the business's tracked keyword, finds the business by matching `place_id` in the results, and upserts the rank into `ranking_snapshots`. Uses SerpAPI's `position` field when available, falls back to array index. Strict active-only subscription check (no past_due grace for paid API calls).
- Monthly SerpAPI budget enforced via `checkRateLimit({ strict: true })` — fails closed when Redis is unavailable (unlike user-facing rate limits which fail open). Budget check is per-keyword, inside the loop — safe when keyword limit is raised.
- Admin business detail page has two new sections: Tracked Keywords (editable pill list, max 5, add/remove) and Ranking (recent snapshots table + manual entry form with keyword/rank/date).
- PUT `/api/admin/businesses/:id/keywords` — Zod validated, `.trim().min(1)` rejects whitespace-only
- POST `/api/admin/businesses/:id/ranking` — manual rank upsert with calendar date validation + FK→404

**Owner Settings + Dashboard Approval Actions (Prompt 19c-5B):**
- Owner settings page at `/settings` — two sections: Business Profile (read-only name/category/placeId, editable tone/products/avoid-facts/sample-responses) and Notification Preferences (email/sms/both channel toggle, phone number, weekly summary on/off, monthly impact on/off). Single "Save Changes" button sends only changed fields.
- PUT `/api/settings` — Zod validated, owner-scoped via `user.businessId` (never from request body). SMS channel requires phone number (checks stored phone from DB for partial updates).
- WeeklySummaryScheduler and MonthlyImpactScheduler respect `weekly_summary_enabled` / `monthly_impact_enabled` columns — businesses that opt out are skipped.
- ApprovalService refactored: new `approveBySession()`, `editBySession()`, `regenerateBySession()` methods share the same core mutation helpers as token-based methods but write `auth_method='owner_session'` + `actor_user_id` to audit log. Token-based routes untouched.
- Three new dashboard API routes: POST `/api/dashboard/reviews/[reviewId]/approve|edit|regenerate` — `requireRole('owner')`, business ownership check (query scoped by `business_id` to prevent IDOR), 409 for non-pending responses.
- Session-based actions revoke all open approval links for the response via `revokeOpenLinksForResponse()`.
- DashboardContent upgraded with Approve/Edit/Regenerate buttons on pending reviews (guard on `responseStatus === 'pending_approval'`, not `displayStatus` fallback).
- OwnerNav updated with Settings link.

**Partner Satisfaction Alert (Prompt 19d-5B):**
- `partner_satisfaction_alert` added to `EngagementAlertType` union
- `EngagementAlertPayload.satisfaction` optional field carries rating/comment/week_start_date
- `EngagementAlertPayload.metrics` made optional (satisfaction alerts don't need engagement metrics)
- `handleSatisfactionAlert()` in EngagementAlertWorker — validates JSONB payload at runtime (rating enum, date format, comment type), re-reads `satisfaction_responses` before sending (skips if owner changed rating from not_great), week-scoped idempotency via `template='partner_satisfaction_alert:YYYY-MM-DD'`, crash-safe outbox-completed-before-send
- `buildPartnerSatisfactionAlertHtml()` — red accent for not_great, amber for ok, shows comment + owner contact

**Onboarding Drip Emails (Prompt 19e):**
- Stripe webhook handler sets `subscription_activated_at = COALESCE(subscription_activated_at, NOW())` when activating — preserves anchor on re-activation from past_due.
- OnboardingDripScheduler — hourly poller, single CROSS JOIN query finds all (business, drip_type) pairs that are due. Index-friendly predicate (`activated_at <= NOW() - interval`). Only suppresses drips where `sent_at IS NOT NULL` (allows stale claim recovery).
- OnboardingDripWorker — three-way claim system: INSERT new claim → own-outbox retry → stale takeover (>15 min). Prevents concurrent duplicate sends via `claimed_by_outbox_id` column. Claims BEFORE any side effects (approval link creation).
  - Day 1: Welcome email — how it works (3-step list), 30-second approval, weekly report mention, conditional dashboard link
  - Day 7: First-week recap — reviews handled + time saved + response rate (all window-bounded to activation + 7 days), highlight review+response pair, edit acknowledgment, pending reviews with fresh approval links via `createApprovalLink()`. Throws when `NEXT_PUBLIC_APP_URL` missing and pending reviews exist.
  - Day 30: Monthly impact — total reviews, response rate before → now, time saved, ranking change if data exists. Business-scoped sales partner lookup (via `onboarded_by` with role check).
- `sent_at` set only after `sendInternalEmail()` succeeds. Delivery recorded before outbox completion.

**Satisfaction Pulse (Prompt 19g):**
- Weekly Value Report email now includes a satisfaction pulse section at the bottom: three HMAC-signed buttons (Great / OK / Not great). Links use `CSRF_SECRET` for signing. Only rendered when `CSRF_SECRET` is configured.
- HMAC helper (`src/lib/shared/feedback-hmac.ts`) — `signFeedback()`, `verifyFeedback()` (hex pattern validation + `Buffer.from(sig, 'hex')` + `timingSafeEqual`), `buildFeedbackUrl()`.
- GET `/api/feedback` — validates HMAC + UUID format + calendar date, renders lightweight HTML confirmation page with hidden signed fields. Shows optional comment textarea for not_great. **Never writes to DB** (email scanners prefetch GET URLs).
- POST `/api/feedback` — re-validates HMAC, single `sql.begin()` transaction: upserts `satisfaction_responses` on `(business_id, week_start_date)` + conditionally inserts `engagement_alert` outbox entry for not_great. Uses SELECT dedup + `INSERT ON CONFLICT DO NOTHING` to avoid aborting the transaction from the broad engagement-alert index. Redirects 303 to `/feedback/thanks`.
- Migration 016 replaces the broad `idx_jo_engagement_alert_inflight` index (which blocked different-week satisfaction alerts) with two indexes: one excluding `partner_satisfaction_alert`, one week-scoped for satisfaction alerts specifically.
- Static `/feedback/thanks` page.

**New database objects (3 migrations):**
- Migration 014: `onboarding_drip_log` table, `satisfaction_responses` table, 8 new columns on `businesses` (subscription_activated_at, tracked_keywords, google_place_address/lat/lng, ranking_search_location, weekly_summary_enabled, monthly_impact_enabled), `approval_audit_log` alterations (nullable token_hash, actor_user_id, auth_method), ranking dedup indexes, JSONB array CHECK constraint
- Migration 015: `onboarding_drip_log` claim/sent state separation (nullable sent_at, claimed_at, claimed_by_outbox_id), outbox dedup index for onboarding_drip, scheduler performance index
- Migration 016: Week-scoped satisfaction alert index (replaces broad engagement alert dedup)

---

## Every File In The Project

*(Additions and changes from Sprint 5B are marked with 🆕 for new files and 📝 for modified files)*

### Database (`supabase/migrations/`) — Sprint 5B additions

| File | What it does |
|---|---|
| 🆕 `014_retention_expansion.sql` | 2 new tables, 8 business columns, audit log alterations, ranking indexes, JSONB constraint |
| 🆕 `015_drip_log_claim_state.sql` | Drip log claim/sent separation, outbox dedup index, scheduler performance index |
| 🆕 `016_satisfaction_alert_index.sql` | Week-scoped satisfaction alert index, fixes broad engagement dedup |

### Worker Process (`worker/`) — Sprint 5B additions

| File | What it does | Status |
|---|---|---|
| 🆕 `jobs/RankingTrackingScheduler.ts` | Biweekly poller (even-week Sunday 22 UTC). Feature-flagged. Single query with dedup. | Working |
| 🆕 `jobs/RankingTrackingWorker.ts` | SerpAPI google_maps search, place_id matching, ranking_snapshots upsert. Strict fail-closed budget. | Working |
| 🆕 `jobs/OnboardingDripScheduler.ts` | Hourly poller. Single CROSS JOIN query finds due drips. Only suppresses sent drips. | Working |
| 🆕 `jobs/OnboardingDripWorker.ts` | Three-way claim (INSERT/retry/stale takeover). Day 1 welcome, day 7 recap with approval links, day 30 impact. | Working |
| 📝 `jobs/EngagementAlertWorker.ts` | Added `handleSatisfactionAlert()` — validates JSONB, re-reads DB before sending, week-scoped idempotency | Working |
| 📝 `jobs/EngagementMonitorPoller.ts` | COOLDOWNS changed to Partial (satisfaction alerts excluded — dedup is in the worker) | Working |
| 📝 `jobs/WeeklySummaryWorker.ts` | Passes HMAC-signed feedback URLs to the weekly email template | Working |
| 📝 `jobs/WeeklySummaryScheduler.ts` | Respects `weekly_summary_enabled` opt-out flag | Working |
| 📝 `jobs/MonthlyImpactScheduler.ts` | Respects `monthly_impact_enabled` opt-out flag | Working |
| 📝 `ingress/stripe.ts` | Sets `subscription_activated_at = COALESCE(subscription_activated_at, NOW())` on activation | Working |
| 📝 `index.ts` | Registers 4 new workers/schedulers (ranking + drip) with start/stop lifecycle | Working |
| 📝 `queues.ts` | Added `TRACK_RANKING` and `ONBOARDING_DRIP` queues | Working |

### Worker Tests — Sprint 5B additions

| File | Tests |
|---|---|
| 🆕 `__tests__/RankingTrackingScheduler.test.ts` | Feature flag, mock mode, time gates, eligible business query, dedup, ISO week, lifecycle (19 tests) |
| 🆕 `__tests__/RankingTrackingWorker.test.ts` | Subscription guard, empty keywords, JSONB guard, budget cap, Redis unavailable, coords vs location, SerpAPI position, NULL rank, mock mode, keyword limit, SerpAPI error (16 tests) |
| 🆕 `__tests__/OnboardingDripScheduler.test.ts` | Mock mode, day offsets, drip_log/outbox dedup, multi-drip queuing, lifecycle (12 tests) |
| 🆕 `__tests__/OnboardingDripWorker.test.ts` | Day 1/7/30 emails, auth check, approval links, zero reviews, ranking, claim idempotency, stale takeover, subscription guard (12 tests) |
| 📝 `__tests__/EngagementAlertWorker.test.ts` | Added satisfaction alert tests: send with rating+comment, no comment, missing data, invalid rating/date, idempotency skip, rating changed skip, admin email missing (added 9 tests, total 23) |

### Next.js Pages — Sprint 5B additions

| File | What it does | Status |
|---|---|---|
| 📝 `(authenticated)/settings/page.tsx` | Owner settings page — profile editing + notification preferences + opt-out toggles | Working |
| 🆕 `(public)/feedback/thanks/page.tsx` | Static thank-you page after satisfaction pulse submission | Working |
| 📝 `admin/businesses/[id]/page.tsx` | Added TrackedKeywordsSection (editable pills) + ManualRankingSection (table + form) | Working |

### API Routes — Sprint 5B additions

| File | What it does | Status |
|---|---|---|
| 🆕 `admin/businesses/[id]/keywords/route.ts` | PUT: update tracked keywords (max 5, Zod validated) | Working |
| 🆕 `admin/businesses/[id]/ranking/route.ts` | POST: manual rank entry with date validation + FK→404 | Working |
| 🆕 `dashboard/reviews/[reviewId]/approve/route.ts` | POST: session-auth approve (owner scoped) | Working |
| 🆕 `dashboard/reviews/[reviewId]/edit/route.ts` | POST: session-auth edit with Zod validation | Working |
| 🆕 `dashboard/reviews/[reviewId]/regenerate/route.ts` | POST: session-auth regenerate | Working |
| 🆕 `settings/route.ts` | PUT: owner settings update with SMS phone validation | Working |
| 🆕 `feedback/route.ts` | GET: HMAC-validated confirmation page (no DB write). POST: upsert satisfaction_responses + outbox | Working |
| 📝 `admin/businesses/[id]/route.ts` | Returns trackedKeywords + rankingSnapshots + location data in GET | Working |
| 📝 `dashboard/route.ts` | Returns settings data (tone, prefs, opt-out flags) in GET | Working |

### API Route Tests — Sprint 5B additions

| File | Tests |
|---|---|
| 🆕 `admin/businesses/[id]/keywords/__tests__/route.test.ts` | Non-array, >5, valid, empty, 404, whitespace (6 tests) |
| 🆕 `admin/businesses/[id]/ranking/__tests__/route.test.ts` | Missing keyword, rank 0, valid, default date, null rank, invalid date, whitespace (7 tests) |
| 🆕 `dashboard/reviews/__tests__/actions.test.ts` | All 3 routes: auth, 404, business scoping, validation, 409 not pending (17 tests) |
| 🆕 `settings/__tests__/route.test.ts` | No business, empty body, tone, prefs, toggles, invalid enum, body injection (11 tests) |
| 🆕 `feedback/__tests__/route.test.ts` | GET valid/invalid/missing, POST upsert/not_great outbox/great no outbox, redirect, comment trim (17 tests) |

### Shared Business Logic — Sprint 5B additions

| File | What it does |
|---|---|
| 🆕 `src/lib/shared/feedback-hmac.ts` | HMAC sign/verify for satisfaction pulse links (SHA-256, CSRF_SECRET, hex validation, constant-time compare) |
| 📝 `src/lib/shared/rate-limit.ts` | Added `{ strict: true }` option — throws on Redis errors instead of failing open |
| 📝 `src/lib/shared/worker-types.ts` | Added TrackRankingPayload, OnboardingDripPayload, EngagementAlertPayload.satisfaction field, metrics made optional |
| 📝 `src/lib/approval/service.ts` | Added approveBySession/editBySession/regenerateBySession + SessionAuditContext + revokeOpenLinksForResponse |
| 📝 `src/lib/notifications/email.ts` | Added 6 templates: 3 onboarding drip + satisfaction pulse section in weekly report + partner satisfaction alert |

### Shared Tests — Sprint 5B additions

| File | Tests |
|---|---|
| 🆕 `src/lib/shared/__tests__/feedback-hmac.test.ts` | Consistent signing, verify valid/tampered/wrong-length, buildFeedbackUrl (8 tests) |
| 📝 `src/lib/shared/__tests__/rate-limit.test.ts` | Added strict mode tests: Redis fail throws, REDIS_CACHE_URL missing throws, default mode still allows (4 tests) |

### Components — Sprint 5B changes

| File | What changed |
|---|---|
| 📝 `src/components/DashboardContent.tsx` | Added ReviewActions component with Approve/Edit/Regenerate buttons for pending reviews |
| 📝 `src/components/OwnerNav.tsx` | Added Settings link |

### Other — Sprint 5B changes

| File | What changed |
|---|---|
| 📝 `src/middleware.ts` | Added `/api/settings` to owner route protection |
| 📝 `.env.example` | Added `RANKING_TRACKING_ENABLED=false` and `RANKING_TRACKING_INTERVAL_MS` |

---

### Sprint 6: Scale + Operational Polish (Prompts 20a-20e)

We built the infrastructure and polish needed to operate the system at 10-20 paying customers without ops firefights — end-to-end request tracing, automatic archival of old cost data, auto-fill on the onboarding form, hard bounce detection for email compliance, and a full launch-readiness runbook.

**What it does:** Every review now carries an ID that threads through the entire pipeline, so oncall can trace a single review from sync → generate → notify → publish with one SQL query. Cost records older than 90 days are automatically rolled up into daily aggregates and the detail rows deleted, so `api_costs` stops growing unbounded. When a sales partner onboards a business, SerpAPI pre-fills the category, phone, and website — the admin just picks a place and most of the form is already filled. If an email hard-bounces, the system detects it from the Resend webhook, flags the business so it stops getting emails, and alerts the admin. There is now a written runbook explaining what to do when things break and a smoke-test checklist to validate the whole pipeline before the first real customer.

**Correlation IDs + Structured Logging (Prompt 20a):**
- New `createWorkerLogger()` helper wraps every worker's logs with a consistent prefix and an optional correlation ID tag. One ID follows a single review's whole chain: `sync_reviews → generate_response → send_notification → publish_response`.
- `BasePayload` interface added to all 12 outbox payload types with a `correlation_id?: string` field. IDs generated at every entry point: 7 pollers/schedulers (using `uuidv7()`), 3 admin API routes, and at every outbox INSERT inside the workers.
- `recoverCorrelationId()` helper in `src/lib/approval/correlation.ts` looks up the upstream `generate_response` payload by `review_id` when the approval flow crosses the token/session boundary, so approve/edit/regenerate actions stay on the original ID instead of generating a new one.
- 12 workers replaced `console.log` with `createWorkerLogger`. All PII (emails, names) scrubbed from correlation-tagged logs — only business_id / response_id appears.
- Migration 018 adds `idx_jo_correlation_id` (expression index on `payload->>'correlation_id'`) + rebuilds `idx_jo_sync_reviews_inflight` to include the `'dispatching'` status + adds `idx_jo_generate_response_by_review` for the canonical correlation-recovery lookup.
- Single trace SQL: `SELECT id, topic, status, attempts FROM job_outbox WHERE payload->>'correlation_id' = '<id>' ORDER BY created_at`.

**Archival Expansion + Cost Rollups (Prompt 20b):**
- New `api_costs_daily_rollups` table aggregates `api_costs` rows older than 90 days into one row per `(business_id, provider, rollup_date)`. Uses Postgres 15's `UNIQUE NULLS NOT DISTINCT` so platform-level costs (business_id=NULL, like SerpAPI prefill) aggregate correctly too.
- ArchivalPoller extended: new `api_costs` branch uses a DELETE-first CTE pattern (`FOR UPDATE SKIP LOCKED` → `DELETE ... RETURNING` → aggregate from RETURNING → upsert with additive `ON CONFLICT DO UPDATE`). This is atomic — no matter how many archival cycles overlap, each row is counted exactly once.
- `notification_deliveries` older than 90 days are straight-deleted (no rollup — the operational dedup windows are much shorter).
- Admin `/admin/costs` page now supports date ranges up to 365 days. The API merges detail rows (<90 days) with rollup rows (>=90 days) via a server-side UNION CTE — detail takes precedence on any same-date collision. `todayTotalUsd` stays detail-only.
- Schema also adds `businesses.website` (used by Prompt 20c) and `businesses.owner_email_bounced` (used by Prompt 20d).
- Fixes during review round: `days=0` clamping bug, negative `limit` handling, NUMERIC(14,6) widening for cost, BIGINT for tokens, server-side pagination via UNION CTE.

**Onboarding Automation + SerpAPI Pre-fill (Prompt 20c):**
- New `src/lib/reviews/serpapi-prefill.ts` module: takes a Google Place ID, calls SerpAPI `engine=google_maps`, returns a normalized `BusinessPrefill` object `{ category, phone, website, hours, fullAddress }`. Never throws — returns all-nulls on any failure.
- 7-day Redis cache by place_id. Cost tracked in `api_costs` with `business_id=NULL` (platform-level) on every outbound SerpAPI call including timeouts/errors (so admin dashboards don't underreport quota burn).
- 2-second `Promise.race` timeout so a stalled SerpAPI doesn't hang the onboarding UI.
- New admin-only route `/api/admin/businesses/prefill` with a 10/min per-user strict rate limit (returns 503 when Redis unavailable — prevents uncapped SerpAPI spend).
- Onboarding form at `/admin/businesses/new` auto-triggers prefill after PlaceAutocomplete selection. Uses `getFieldState(name).isDirty` at response-apply time (not captured at render time) so a user editing mid-flight never gets their edits overwritten. Clear button resets prefilled fields so the next selection starts fresh.
- Website field added to the form, onboarding INSERT, `FIELD_TO_COLUMN` PATCH mapping, business detail display + edit form.
- New `websiteUrlSchema` in `src/lib/shared/schemas.ts` — only accepts `http://` or `https://`, rejects `javascript:`/`data:`/`mailto:` etc. Defense-in-depth `safeHttpUrl()` at render time.
- During this prompt's development we also extended `normalizeResponse` to read `type`/`types`/`category`/`categories` variants for category (SerpAPI returns different field names for chains vs individual places) and to handle both object and array shapes for hours.

**Email Deliverability + Hard Bounce Handling (Prompt 20d):**
- New `EmailCategory` type: `'transactional' | 'marketing' | 'internal'`. Each send path tags its category explicitly.
- Marketing emails (weekly/monthly/drip/nudge) get RFC-8058-compliant `List-Unsubscribe` headers — required by Gmail and Yahoo's Feb-2024 bulk-sender rules. If `LIST_UNSUBSCRIBE_URL` is set, emits both the HTTPS form and the `List-Unsubscribe-Post: One-Click` header. Otherwise falls back to mailto-only (still valid). URL validation rejects unsafe schemes.
- Resend webhook (`worker/ingress/resend.ts`) upgraded: classifies bounce types defensively (reads `data.bounce.type`, `data.reason`, `data.status` — whichever SerpAPI sends), normalizes into `bounced:hard:<raw>` or `bounced:soft:<raw>`. Only flags `businesses.owner_email_bounced=TRUE` when the bounced template is owner-directed (approval_request / weekly_value_report / monthly_impact / owner_nudge / onboarding_drip_*). Admin-directed template bounces (admin_manual_post, partner_* alerts) log-and-skip. `UPDATE ... IS DISTINCT FROM TRUE RETURNING id` transition guard means the admin alert fires only on the flag's FALSE→TRUE flip — no duplicates from replayed webhooks.
- Skip-if-bounced guards in 5 owner-directed workers: NotificationWorker, WeeklySummaryWorker, MonthlyImpactWorker, OnboardingDripWorker, EngagementAlertWorker.handleOwnerNudge. EngagementMonitorPoller excludes bounced businesses from `owner_nudge` at query time. Partner/admin alerts still send to the admin regardless of the owner's bounce state.
- Admin `/admin/overview` gets a new Email Health card: 24h delivery rate (%, green/red), 7d bounces / hard bounces / complaints. Red state when delivery rate drops below 95% (with ≥5 sends) OR any complaint/hard bounce in the last 7 days.
- Business detail page shows a red "Owner email is bouncing" banner with a "Clear bounce flag" button when `owner_email_bounced=true`. Banner explains exactly which emails are being skipped.
- Owner email is now editable via the admin profile editor (added to `UpdateBusinessSchema` + `FIELD_TO_COLUMN` + the Edit form). Banner points admins to the editor.
- Migration 019 adds partial indexes on `notification_deliveries(external_message_id)`, `(sent_at)`, `(failed_at, failure_reason)` — all scoped to `WHERE ... IS NOT NULL` so they stay small.
- New `docs/email-deliverability.md` — full runbook covering SPF/DKIM/DMARC DNS setup, warmup schedule (2-3 customers/week first month), monitoring, troubleshooting table, hard-bounce flow, env vars, List-Unsubscribe compliance rationale.

**Launch Readiness Documentation (Prompt 20e):**
- New `docs/operational-runbook.md` — 5 sections: "Customer says X" troubleshooting (5 scenarios), daily 2-minute health check, debugging SQL queries (correlation-id trace + 6 others), incident response (7 scenarios with Auto vs Manual columns), weekly maintenance tasks.
- New `docs/smoke-test-checklist.md` — manual pre-launch E2E test across 3 real businesses (happy path, edit + concurrent onboarding, regenerate + correlation trace). Includes throughput sanity check and mobile approval performance check.
- New admin page at `/admin/runbook` — static client component, renders 5 "Customer says X" scenarios as a quick-reference table. Links to the full markdown files by filename (clickable if `NEXT_PUBLIC_DOCS_BASE_URL` env is set).
- AdminNav gains a "Runbook" link.
- Fixes from review: correlation-trace SQL corrected for actual `aggregate_id` semantics (sync_reviews uses business_id, generate_response uses review_id, send_notification/publish_response use response_id), smoke checklist cost assertions rewritten to match what the app actually records, place-id recovery procedure documented with real SQL, D2 Redis guidance corrected to reflect `reserveCost` throwing on Redis failure.

**Cross-cutting fixes (post-Sprint-6 cleanup):**
- **JSONB double-encoding fix (migration 020).** Root cause: `${JSON.stringify(payload)}::jsonb` in Postgres.js v3 double-encodes — when a string is bound to a jsonb position, Postgres.js wraps it in additional JSON quotes, producing a JSONB scalar string instead of a JSONB object. Result: `payload->>'correlation_id'` returned NULL on every row, runbook C1 trace was broken, correlation index was useless, 20% storage bloat. Fix: new `jsonb()` helper in `src/lib/db/server.ts` wraps `sql.json(value)` with a type cast — at runtime Postgres.js sends the object as a Parameter with OID 3802, serialized exactly once. All 34 call sites across 19 files swept. Migration 020 normalizes existing scalar-string rows across 8 JSONB columns.
- **Redis cache client first-request race fix.** `enableOfflineQueue: false` was too aggressive — the FIRST prefill request after dev-server boot would error with "Stream isn't writeable" before ioredis finished the TCP handshake. Flipped to the default `true`. Fail-fast on a truly-dead Redis is still guaranteed by `connectTimeout: 3s` + `retryStrategy` returning null after 2 retries.
- **Queue-name registry extracted.** Moved `QUEUE_NAMES` to `src/lib/shared/queue-names.ts` (pure constants, no BullMQ imports). Both `worker/queues.ts` and the admin `/api/admin/jobs` route now import from the same source of truth — the list can't drift again.
- **NotificationFailoverPoller correlation preservation.** Failover jobs used to generate a fresh uuidv7(), breaking the traceability chain. New `recoverFailoverCorrelationId()` helper looks up the prior `send_notification` row first, falls back to the upstream `generate_response` row, only uses a fresh ID as a last resort.
- **SerpAPI prefill cost on timeout.** Cost is now recorded even on timeout/error (endpoint tagged `:failed`). Without this, admin cost dashboards underreported quota burn exactly when something was going wrong. Cache write is skipped on failure so the next selection retries.
- **Admin cost boundary-day bug.** Rollup query used strict `<` against `CURRENT_DATE - 90 days`, silently losing the morning portion of the archived boundary day. Fixed to `<=` across 4 query locations. Regression test asserts the boundary operator.
- **List-Unsubscribe-Post compliance.** The Post header was emitted without an HTTPS URL, which per RFC 8058 is non-functional (and misleading to Gmail/Outlook). Now conditional on `LIST_UNSUBSCRIBE_URL` being set.

**New database objects (4 migrations):**
- Migration 017 (`sprint6_scale.sql`): `api_costs_daily_rollups` table with `UNIQUE NULLS NOT DISTINCT` + 3 indexes, `businesses.website`, `businesses.owner_email_bounced`, `idx_nd_created_at`
- Migration 018 (`correlation_and_dispatching_indexes.sql`): correlation expression index, sync_reviews in-flight index rebuilt to include `'dispatching'`, generate_response lookup index for correlation recovery
- Migration 019 (`notification_delivery_bounce_indexes.sql`): partial indexes on external_message_id / sent_at / (failed_at, failure_reason)
- Migration 020 (`normalize_jsonb_scalar_strings.sql`): one-time data repair — converts JSONB scalar strings back to proper objects across 8 columns (`UPDATE ... SET col = (col#>>'{}')::jsonb WHERE jsonb_typeof(col) = 'string'`)

---

## Sprint 6 Workflows

### End-to-End Correlation Trace

```
1. Entry point generates correlation_id
   → ReconciliationPoller inserts sync_reviews with correlation_id = uuidv7()
   → Or: approval API route generates correlation_id and passes it forward

2. ReviewSyncWorker reads payload.correlation_id
   → Propagates it into every generate_response outbox entry it creates
   → Same ID appears in the worker's structured logs (createWorkerLogger)

3. ResponseGeneratorWorker
   → Reads correlation_id from job payload
   → Passes it into the send_notification outbox entry

4. NotificationWorker / ResponsePublisherWorker
   → Same propagation pattern: read from payload, write to next outbox

5. Approval flow crosses a boundary
   → recoverCorrelationId(tx, { reviewId, responseId }) looks up the upstream
     generate_response payload and reuses its correlation_id
   → publish_response outbox entry carries the ORIGINAL chain ID, not a fresh one

6. Oncall trace query
   → SELECT * FROM job_outbox WHERE payload->>'correlation_id' = '<id>'
     ORDER BY created_at
   → Uses idx_jo_correlation_id (expression index, fast)
   → Returns every hop of the review chain in chronological order
```

### Archival + Cost Rollup

```
1. ArchivalPoller fires every 24 hours

2. For each of 5 targets (outbox, inbound_events, prospect_demos,
   api_costs, notification_deliveries):

   a. outbox: DELETE completed entries >7 days old (batch 5000)
   b. inbound_events: DELETE processed events >30 days (batch 5000)
   c. prospect_demos: DELETE expired >30 days past expiry (batch 5000)

   d. api_costs (NEW): atomic claim-and-aggregate CTE
      → candidates CTE: SELECT id FROM api_costs
        WHERE created_at < NOW() - INTERVAL '90 days'
        ORDER BY created_at, id LIMIT 5000
        FOR UPDATE SKIP LOCKED
      → deleted CTE: DELETE FROM api_costs WHERE id IN (candidates)
        RETURNING business_id, provider, created_at::date, cost_usd, tokens
      → aggregated CTE: SUM by (business_id, provider, cost_date)
      → INSERT INTO api_costs_daily_rollups
        ON CONFLICT ON CONSTRAINT uniq_cost_rollups_business_provider_date
        DO UPDATE SET total_cost_usd = existing + EXCLUDED (additive)

   e. notification_deliveries (NEW): DELETE >90 days old (batch 5000)

3. Logs per-target counts with saturation warning at 80% of batch size

4. Admin /admin/costs query logic:
   → If days <= 90: detail-only UNION CTE (single query)
   → If days > 90: detail + rollup UNION CTE
     - Detail rows authoritative on same-date collision
     - byBusiness pagination is server-side (SQL UNION + GROUP BY + LIMIT)
     - byDay is additive merge (rollup morning + detail afternoon)
```

### SerpAPI Prefill on Onboarding

```
1. Admin navigates to /admin/businesses/new

2. Admin selects a place in the PlaceAutocomplete widget
   → onPlaceSelect fires with { placeId, formattedAddress, lat, lng }
   → triggerPrefill(placeId) called async

3. triggerPrefill:
   → AbortController cancels any previous in-flight request
   → latestPlaceIdRef = placeId (guard against stale responses)
   → GET /api/admin/businesses/prefill?place_id=...

4. /api/admin/businesses/prefill route:
   → requireRole('admin', 'sales_partner')
   → checkRateLimit('prefill:minute:<userId>', 10, 60, { strict: true })
     → Returns 503 if Redis unavailable (no uncapped spend)
   → Calls fetchBusinessDetails(placeId)

5. fetchBusinessDetails:
   → Mock mode: return canned data
   → Cache read: 7-day TTL by place_id → return cached if hit
   → SerpAPI key guard: return empty if missing
   → Promise.race: getJson(engine=google_maps) vs 2s timeout
   → Record cost (always, even on failure) with endpoint = google_maps_prefill
     or google_maps_prefill:failed
   → Cache write (only on success)
   → Return { category, phone, website, hours, fullAddress } or all-nulls

6. Client response-apply:
   → Check latestPlaceIdRef === placeId (discard stale)
   → For each fillable field: check getFieldState(name).isDirty LIVE (not
     captured) — only fill if empty AND untouched by user
   → setValue('category', prefill.category, { shouldDirty: false })

7. Clear button:
   → cancelPrefill() aborts in-flight, clears latestPlaceIdRef
   → Resets googlePlaceId + googlePlaceAddress + prefilled fields via
     resetField() (also clears dirty state for next selection)
```

### Hard Bounce Handling

```
1. Resend sends an email. Some time later the recipient's MTA rejects it.

2. Resend POSTs to /ingress/resend on the Railway worker
   → Svix signature verification, stale-timestamp check, dedup via inbound_events
   → Body includes type='email.bounced' and a bounce classification

3. Worker extracts bounce type defensively
   → Tries data.bounce.type, data.reason, data.status (first one wins)
   → Normalizes via classifyBounce() into:
     - bounced:hard:<raw>  (matches 'permanent', 'hard', 'hardbounce', 'hard_bounce',
                             'permanent_failure', or anything containing 'permanent')
     - bounced:soft:<raw>  (everything else — including the 'unknown' fallback)

4. Worker looks up the delivery row by external_message_id
   → Gets business_id AND template

5. Worker UPDATEs notification_deliveries.failure_reason = normalized reason

6. If isHard AND template is owner-directed (approval_request,
   weekly_value_report, monthly_impact, owner_nudge, onboarding_drip_*):
   → UPDATE businesses SET owner_email_bounced = TRUE
     WHERE id = business_id AND owner_email_bounced IS DISTINCT FROM TRUE
     RETURNING id
   → If the transition fired (row returned): send admin alert via sendInternalEmail
   → Otherwise (already flagged): silent — no duplicate admin spam

7. Next owner-directed worker run for that business:
   → NotificationWorker / WeeklySummaryWorker / MonthlyImpactWorker /
     OnboardingDripWorker / EngagementAlertWorker.handleOwnerNudge all
     SELECT owner_email_bounced and skip-if-bounced
   → EngagementMonitorPoller also excludes bounced businesses from owner_nudge
   → Admin + partner alerts continue — they're not sent to the owner

8. Admin sees the red "Clear bounce flag" banner on /admin/businesses/<id>
   → Verifies the email address, updates it via the Business Profile editor if wrong
   → Clicks "Clear bounce flag" → PATCH { ownerEmailBounced: false }
   → Owner-directed emails resume on the next worker cycle
```

### /admin/runbook — Quick Reference

```
1. Admin has a customer-facing issue.

2. Opens /admin/runbook (5-scenario table rendered from static data).

3. Finds the matching "Customer says X" row:
   - A1: I never got the approval email
   - A2: The response doesn't sound like me
   - A3: I approved it but it's not posted on Google
   - A4: I'm getting too many emails
   - A5: My reviews aren't being picked up

4. Reads the "First check" and "Fix" columns for immediate action.

5. If more detail needed, clicks the `docs/operational-runbook.md` reference
   → Full runbook covers daily health check, debugging SQL (correlation
     trace, stuck outbox, business activity, reset stuck entry, today's cost,
     bounced businesses, manual-post backlog), incident response (worker
     crash, Redis down, Supabase down, SerpAPI quota, LLM down, cost breaker,
     Resend degraded), and weekly maintenance tasks.
```

---

## Every File In The Project

*(Additions and changes from Sprint 6 are marked with 🆕 for new files and 📝 for modified files)*

### Database (`supabase/migrations/`) — Sprint 6 additions

| File | What it does |
|---|---|
| 🆕 `017_sprint6_scale.sql` | `api_costs_daily_rollups` table, `businesses.website`, `businesses.owner_email_bounced`, `idx_nd_created_at` |
| 🆕 `018_correlation_and_dispatching_indexes.sql` | Correlation expression index, sync_reviews in-flight index rebuilt, generate_response lookup index |
| 🆕 `019_notification_delivery_bounce_indexes.sql` | Partial indexes on external_message_id / sent_at / (failed_at, failure_reason) |
| 🆕 `020_normalize_jsonb_scalar_strings.sql` | One-time data repair — converts JSONB scalar strings back to objects across 8 columns |

### Worker Process (`worker/`) — Sprint 6 changes

| File | What changed | Status |
|---|---|---|
| 📝 All 12 workers | Replaced `console.log` with `createWorkerLogger`. PII scrubbed from correlation-tagged logs. Read `correlation_id` from payload and propagate it to downstream outbox entries. | Working |
| 📝 `jobs/ArchivalPoller.ts` | Added api_costs DELETE-first CTE (FOR UPDATE SKIP LOCKED → aggregate from RETURNING → additive upsert). Added notification_deliveries >90d delete. 5-target logging with saturation warnings. | Working |
| 📝 `jobs/NotificationFailoverPoller.ts` | Added `recoverFailoverCorrelationId()` — preserves upstream correlation_id from prior send_notification or generate_response. Falls back to uuidv7 only as last resort. | Working |
| 📝 `ingress/resend.ts` | Defensive bounce-type extraction + normalized `classifyBounce()`. Template-gated owner flag (only flags for owner-directed templates). Transition guard prevents duplicate admin alerts. | Working |

### Worker Tests — Sprint 6 additions

| File | Tests |
|---|---|
| 🆕 `__tests__/correlation-chain.test.ts` | Proves correlation_id flows through sync_reviews → generate_response → send_notification chain |
| 🆕 `__tests__/webhook-dedup.test.ts` | Resend webhook dedup via external_event_key |
| 🆕 `__tests__/resend-webhook-bounce.test.ts` | 8 tests: hard bounce flags + alerts, soft bounces don't, template-gated (admin_manual_post + partner_engagement_alert don't flag), onboarding_drip_day_7 DOES flag, transition guard prevents duplicate alerts |
| 🆕 `__tests__/bounced-skip.test.ts` | 4 owner-directed workers skip-if-bounced |
| 📝 `__tests__/NotificationFailoverPoller.test.ts` | Added 2 regression tests: correlation recovery from existing send_notification + fallback to generate_response |
| 📝 `__tests__/ArchivalPoller.test.ts` | Added api_costs rollup path tests + concurrent-archival race safety |

### Next.js Pages — Sprint 6 additions

| File | What it does | Status |
|---|---|---|
| 🆕 `admin/runbook/page.tsx` | Static quick-reference page — 5-scenario "Customer says X" table, links to markdown runbook | Working |
| 📝 `admin/businesses/[id]/page.tsx` | Red "Owner email bouncing" banner + "Clear bounce flag" button + editable ownerEmail field in profile editor | Working |
| 📝 `admin/businesses/new/page.tsx` | SerpAPI prefill on place selection with AbortController + live `getFieldState` dirty check. Clear button resets prefilled fields. | Working |
| 📝 `admin/overview/page.tsx` | Email Health card (24h delivery rate + 7d bounces/hard-bounces/complaints, red state when <95% or any 7d complaint/hard) | Working |
| 📝 `admin/costs/page.tsx` | Added 180 and 365 day range options (exercises the rollup-backed path) | Working |

### API Routes — Sprint 6 additions

| File | What it does | Status |
|---|---|---|
| 🆕 `admin/businesses/prefill/route.ts` | GET: admin-only SerpAPI prefill by place_id. 10/min strict rate limit. | Working |
| 📝 `api/admin/costs/route.ts` | Days cap raised to 365. Server-side UNION CTE merges detail + rollup. byDay additive merge. Boundary filter uses `<=` (not `<`) against `CURRENT_DATE - 90 days`. | Working |
| 📝 `api/admin/overview/route.ts` | Email Health query (24h delivery + 7d bounces). Grouped CTE includes email health fields. | Working |
| 📝 `api/admin/jobs/route.ts` | Imports `ALL_QUEUE_NAMES` from the shared registry so the list can't drift behind worker/queues.ts | Working |
| 📝 `api/admin/businesses/[id]/route.ts` | Added `ownerEmail` + `ownerEmailBounced` to GET and PATCH allowlist | Working |

### Shared Business Logic — Sprint 6 additions

| File | What it does |
|---|---|
| 🆕 `src/lib/shared/logger.ts` | `createWorkerLogger(prefix, correlationId?)` — structured logs with optional correlation tag |
| 🆕 `src/lib/shared/queue-names.ts` | `QUEUE_NAMES` + `ALL_QUEUE_NAMES` constants. Pure — no BullMQ imports. Shared by worker/queues.ts AND /api/admin/jobs. |
| 🆕 `src/lib/approval/correlation.ts` | `recoverCorrelationId(tx, { reviewId, responseId })` — looks up upstream generate_response for approval-flow boundary |
| 🆕 `src/lib/reviews/serpapi-prefill.ts` | `fetchBusinessDetails(placeId)` — 7-day Redis cache, cost tracking (even on failure), 2s timeout, never throws |
| 📝 `src/lib/db/server.ts` | Added `jsonb<T>(value)` helper — wraps `sql.json(value)` so typed payloads satisfy Postgres.js's strict JSONValue. Used everywhere instead of `${JSON.stringify(x)}::jsonb` (which double-encodes). |
| 📝 `src/lib/db/redis-cache.ts` | Removed `enableOfflineQueue: false` (fixes first-request race on dev boot) |
| 📝 `src/lib/notifications/email.ts` | Added `EmailCategory` type, `getEmailHeaders()` (RFC 8058 compliant), `getEmailTags()`, 5 new templates for bounce banner + onboarding drip + satisfaction alert |
| 📝 `src/lib/shared/worker-types.ts` | `BasePayload` with `correlation_id?` — all 12 payload types extend it |
| 📝 `src/lib/shared/schemas.ts` | `websiteUrlSchema` (http/https only). `ownerEmail` + `website` added to `UpdateBusinessSchema`. |

### Shared Tests — Sprint 6 additions

| File | Tests |
|---|---|
| 🆕 `src/lib/shared/__tests__/email-headers.test.ts` | 8 tests: marketing vs transactional/internal, LIST_UNSUBSCRIBE_URL precedence, mailto fallback, unsafe scheme rejection |
| 🆕 `src/lib/notifications/__tests__/email-send.test.ts` | 4 tests: transactional tags, internal default, marketing with HTTPS URL, marketing mailto-only (no Post header) |
| 🆕 `src/lib/reviews/__tests__/serpapi-prefill.test.ts` | 33 tests: normalization variants (type/types/category/categories), hours shapes (array/object/nested), timeout cost recording, cache validation |

### Components — Sprint 6 changes

| File | What changed |
|---|---|
| 📝 `src/components/AdminNav.tsx` | Added "Runbook" link |
| 📝 `src/components/PlaceAutocomplete.tsx` | onClear callback now also cancels in-flight prefill |

### Documentation — Sprint 6 additions

| File | What it does |
|---|---|
| 🆕 `docs/operational-runbook.md` | Authoritative ops reference — 5 sections: Customer-says-X, daily health check, debugging SQL, incident response, weekly maintenance |
| 🆕 `docs/smoke-test-checklist.md` | Pre-launch manual E2E checklist — 3 businesses, throughput sanity, mobile approval perf |
| 🆕 `docs/email-deliverability.md` | SPF/DKIM/DMARC setup, warmup schedule, monitoring, troubleshooting table, hard bounce flow, List-Unsubscribe compliance |

### Test Infrastructure — Sprint 6 additions

| File | What changed |
|---|---|
| 🆕 `vitest.setup.ts` | Sets dummy SUPABASE_URL / SUPABASE_SERVICE_KEY / DATABASE_POOL_URL so unit tests that transitively import db/server can load |
| 📝 `vitest.config.ts` | Added `setupFiles: ['./vitest.setup.ts']` |
| 📝 ~30 test files | Added `jsonb: (v: unknown) => v` pass-through to all db/server `vi.mock` calls |

### Other — Sprint 6 changes

| File | What changed |
|---|---|
| 📝 `.env.example` | Added `LIST_UNSUBSCRIBE_URL` (optional) and `NEXT_PUBLIC_DOCS_BASE_URL` (optional — makes runbook filenames clickable anchors) |

---

## What's Left To Build

### Sprint 3: COMPLETE ✓
### Sprint 4: COMPLETE ✓
### Sprint 5A: COMPLETE ✓
### Sprint 5B: COMPLETE ✓
### Sprint 6: COMPLETE ✓

Everything through Sprint 6 is built and working.

### Still deferred (not yet needed):
- PostHog analytics (zero paying customers = zero analytics value)
- Load testing with k6/Artillery (10 businesses × 10 reviews/month doesn't warrant it yet)
- DB-backed integration tests (requires dedicated test database in CI)
- Voice learning activation (code is in place; activates naturally once ≥5 edited+posted responses exist per business)

### Known residual risks (shipped as-is)

Two real-but-narrow issues from the post-Sprint-6 review that were accepted rather than fixed. Full detail in `.claude/CLAUDE.md` under "Known residual risks":
- **Approval email crash-after-send race** — duplicate emails possible in a millisecond race between Resend-ack and DB-write. Partially covered by `NotificationFailoverPoller`.
- **`past_due` grace period based on mutable `updated_at`** — unrelated admin edits can reset the 7-day grace window. Low exploit risk. Planned for the next billing-focused sprint as a dedicated `subscription_status_changed_at` column.

### GBP API Integration (When Google Approves)

- OAuth flow for business onboarding
- Google Pub/Sub for real-time review notifications
- Automated response posting via GBP API (replaces manual copy-paste)
- Adaptive polling intervals
- Migrate existing customers from SerpAPI to GBP API

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
