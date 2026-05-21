# Final Implementation Plan — Claude Code Edition

_This is your single source of truth. Every sprint tells you exactly what to build, what to prompt Claude Code, and which MCPs to use._

_Sources: 04-final-plan.md (architecture), Implementation_Phases_SerpAPI_First.md (SerpAPI-first sequencing), Product_Brief_AI_Review_Responder.docx (product requirements)_

## Read This First — Architecture Review Overrides

If any later prompt conflicts with the rules below, these rules win:

- **Demo generation runs asynchronously on Railway via the outbox.** The admin route creates a `prospect_demos` row + `job_outbox` entry (topic `generate_demo`) in one transaction. The OutboxPoller dispatches it. The actual SerpAPI fetch + multi-review LLM generation must NOT run inside a Vercel API route. This is consistent with the "transactional outbox for all async work" invariant.
- **Third-party webhooks terminate on Railway directly.** Resend, Stripe, future Twilio, and future Google Pub/Sub push endpoints should point at `worker/ingress/*` in production. Do not add Vercel forwarding routes for webhook traffic.
- **Use one worker path everywhere:** `worker/index.ts`, not `src/worker/index.ts`.
- **Worker HTTP ingress uses Fastify (or Hono).** The worker needs a real HTTP framework for webhook ingress — not bare `http.createServer()`. Stripe signature verification requires exact raw-body preservation. Choose Fastify or Hono in Prompt 3 and mount ingress routes alongside the health endpoint.
- **Auth must have an explicit mapping.** Supabase Auth identity must map to `users.auth_id`; owner authorization must always be checked against `business_id`; keep `SUPABASE_SERVICE_KEY` server-only.
- **Businesses start in `pending_payment`, not `active`.** The default `subscription_status` must be `pending_payment`. Stripe's `checkout.session.completed` webhook transitions to `active`. The ReconciliationPoller only polls `active` businesses. The onboarding form may trigger ONE initial sync as an internal demo: reviews are ingested and responses are generated (visible in admin UI during the sales call), but `NotificationWorker` and `ResponsePublisherWorker` MUST skip `pending_payment` businesses — no approval emails or posting instructions are sent until payment is confirmed. This is the hard boundary.
- **Subscription-state guard in ALL customer-facing workers.** Every worker that produces customer-visible output must check `business.subscription_status` early and no-op + complete the outbox entry for `cancelled` businesses. For `past_due`, treat as a 7-day grace period: workers continue running, but if still `past_due` after 7 days, treat as `cancelled`. Apply this guard consistently to: `ResponseGeneratorWorker`, `NotificationWorker`, `ResponsePublisherWorker`, `WeeklySummaryWorker`.
- **Only one actionable response per review at a time.** When an owner regenerates, the old response must be marked `superseded` in the same transaction. A response in `superseded` is terminal — it cannot be approved, edited, or regenerated.
- **Capture ROI baseline during onboarding or first sync.** The later dashboard work depends on storing an initial review/response snapshot rather than trying to reconstruct "before us" metrics after the fact.
- **SerpAPI review identity: prefer the source-provided ID.** If SerpAPI's response includes a review identifier or reviewer profile URL, use it for `provider_review_id` instead of the synthetic `SHA-256(name+date)` hash. The NormalizedReview DTO stays clean — the monitor module captures source identity separately. If no stable source ID exists, flag ambiguous matches (same name+date, different content on first encounter) to `review_exceptions`.
- **Monitoring stack for MVP:** Sentry for app errors, PostHog for product analytics. Add Better Stack later only if you want separate uptime/incident tooling.

---

## Pre-Work: Project Setup (Do This Before Any Coding)

### 1. Create accounts and get credentials (30 minutes)

Do these manually — Claude Code can't do account creation for you:

- [ ] **Supabase**: Create project → note `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_KEY`, `DATABASE_URL`, `DATABASE_POOL_URL` → enable PgBouncer in Settings → Database → Connection Pooling
- [ ] **Upstash**: Create TWO Redis databases: `review-responder-cache` and `review-responder-queue` → note both URLs
- [ ] **OpenAI**: Get API key from platform.openai.com
- [ ] **Anthropic**: Get API key from console.anthropic.com
- [ ] **SerpAPI**: Get API key from serpapi.com (start with $50/month plan — covers 5 businesses at 60-min polling; upgrade to $100/month at 10 businesses)
- [ ] **Resend**: Create account, verify your domain → get API key
- [ ] **Stripe**: Create account → create two products ("Founding Member" $99/mo, "Standard" $149/mo) → get secret key + webhook secret
- [ ] **Vercel**: Link your GitHub account
- [ ] **Railway**: Link your GitHub account → create a new project, connect your repo
- [ ] **Sentry**: Create project for Node.js/Next.js → get DSN
- [ ] **GitHub**: Create repo `repworth` (or your preferred name)

> **Twilio (SMS)**: DEFERRED until email approval flow is validated with real customers. The schema supports SMS (`notification_preference`, per-channel `approval_links`) but adding Twilio setup to the MVP critical path adds complexity without proving value. Add after Sprint 4 when 2-3 customers are using email approval successfully.

### 2. Submit GBP API application (15 minutes)

Do this NOW — approval takes 2-4 weeks, runs in parallel with everything:

- [ ] Create Google Cloud project at console.cloud.google.com
- [ ] Set up OAuth consent screen (External, Testing mode)
- [ ] Submit GBP API access request form
- [ ] Check approval status weekly in GCP Console → APIs & Services

### 3. Set up your `.claude` folder

Create this BEFORE starting Sprint 1. This is what makes Claude Code effective.

---

## `.claude/CLAUDE.md`

**ALREADY CREATED.** The live version is at `.claude/CLAUDE.md` in the project root. It has been updated with all fixes from this review (SerpAPI dedup patterns, `last_sync_at`, `awaiting_manual_post`, GBP migration path, `approval_audit_log`, native crypto). The reference copy below is kept for documentation but the live file is the source of truth.

```markdown
# AI Review Responder — Claude Code Context

## What this project is
An automated service for small businesses that monitors Google reviews via SerpAPI polling and generates personalized, multilingual AI response drafts for owner approval. Built with Next.js 14 + Railway workers + Supabase + BullMQ.

## Architecture invariants — NEVER violate these
- **Vercel serves UI only.** All SLA-critical compute (review sync, response generation, notifications, publishing) runs on Railway workers. NEVER put LLM calls, external API calls, or long-running operations in Next.js API routes.
- **Transactional outbox for all async work.** Every state change + its follow-up work are written in the SAME Postgres transaction via the `job_outbox` table. NEVER write to Postgres and then separately enqueue a BullMQ job — if the enqueue fails, work is lost silently.
- **No auto-posting.** Every response requires explicit owner approval. The system must make it architecturally impossible to bypass approval. There is NO code path from response generation to Google posting without an approval step.
- **Approval tokens are NEVER stored raw.** Only SHA-256 hashes go in `approval_links`. Raw tokens exist only in memory during generation and in the sent email. They are NEVER persisted in Postgres, outbox payloads, or logs.
- **ReviewSource contract.** All review sources (SerpAPI, manual paste, future GBP API) normalize to the same `NormalizedReview` DTO. No source-specific fields leak into the prompt builder.

## Tech stack
- **Runtime**: Node.js 20 LTS, TypeScript 5 strict mode
- **Framework**: Next.js 14 App Router (Vercel)
- **Worker**: Standalone Node.js process (Railway) — BullMQ consumers + OutboxPoller
- **Database**: PostgreSQL 15 via Supabase (PgBouncer pooling enabled)
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
│   └── (admin)/            # Sales partner CRM, demos, costs, notifications
├── lib/                    # Shared business logic
│   ├── db/                 # Supabase client, query helpers
│   ├── reviews/            # ReviewSource interface + SerpAPI impl
│   ├── responses/          # Response generator, prompt builder
│   ├── approval/           # ApprovalService, token management
│   ├── notifications/      # Resend email service
│   ├── publishing/         # Manual posting workflow (GBP API stub)
│   ├── costs/              # CostTracker, circuit breaker
│   ├── demos/              # Demo generation pipeline
│   └── shared/             # Types, utils, constants
├── worker/                 # Railway worker (separate process)
│   ├── index.ts            # Entry point
│   ├── queues.ts           # BullMQ queue definitions
│   ├── jobs/               # Workers: ReviewSync, ResponseGenerator, etc.
│   └── ingress/            # Webhook handlers: Stripe, Twilio, Resend
└── types/                  # Shared TypeScript interfaces
```

## Database
All tables use UUIDv7 (time-ordered). Full schema is in `supabase/migrations/001_initial_schema.sql`.

Key tables: `businesses`, `reviews`, `responses`, `approval_links`, `job_outbox`, `inbound_events`, `prospect_demos`, `notification_deliveries`, `api_costs`, `review_exceptions`, `weekly_summaries`, `users`

## Key patterns to follow
- **Cost guard**: Redis INCRBY for pessimistic cost reservation BEFORE LLM calls. DECRBY to refund on failure. DB `api_costs` table is the audit trail, reconciled hourly.
- **Approval flow**: GET is read-only (renders page). POST /api/approval/session binds device cookie. POST approve/edit/regenerate requires device cookie + CSRF. Email scanners prefetch GET but never POST.
- **Review deduplication (SerpAPI mode)**: stable identity = SHA-256(reviewerName + "|" + reviewDate). Mutable content = SHA-256(starRating + "|" + reviewText). Compare content hash to detect edits.
- **Voice learning**: fetch recent owner-edited responses as few-shot examples. Returns empty array until ≥5 edited+posted responses exist. The hook is in place; it activates naturally.
- **Error handling**: all workers are idempotent. Replaying an outbox entry must produce the same result. Use unique constraints + ON CONFLICT for deduplication.

## Testing approach
- Unit tests (Vitest): business logic, cost calculation, token hashing, dedup logic
- Integration tests (Vitest + real Supabase): full pipeline flows, outbox recovery, idempotency
- E2E tests (Playwright): approval page flows, demo generation, admin pages

## Current status
[UPDATE THIS AS YOU COMPLETE SPRINTS]
- Sprint 1: [NOT STARTED / IN PROGRESS / DONE]
- Sprint 2: [NOT STARTED / IN PROGRESS / DONE]
- ...

## MCP servers available
- **Supabase**: Database queries and management
- **Sentry**: Error tracking and monitoring
- **Playwright**: Browser testing
- **Context7**: Library documentation lookup
```

### `.claude/skills/`

**ALREADY CREATED.** The three skill files below have been created at their respective paths. They are the live versions — the reference copies below are kept for documentation.

**`.claude/skills/outbox-pattern.md`**
```markdown
# Transactional Outbox Pattern

Every async workflow uses this pattern:

1. In a single Postgres transaction:
   - Write the state change (e.g., insert response)
   - Write a `job_outbox` row with topic, payload, and aggregate info

2. OutboxPoller (runs every 10s on Railway):
   - SELECT ... FOR UPDATE SKIP LOCKED from job_outbox WHERE status = 'pending'
   - Dispatch each entry to BullMQ
   - If dispatch fails and attempts < max_attempts: reset to 'pending'
   - If attempts >= max_attempts: transition to 'failed' (terminal)
   - Watchdog: reset entries stuck in 'dispatched' for > 1 hour

3. Worker processes the BullMQ job:
   - All workers are idempotent
   - On completion: UPDATE job_outbox SET status = 'completed'

NEVER write to Postgres then separately enqueue to BullMQ outside a transaction.
```

**`.claude/skills/approval-security.md`**
```markdown
# Approval Token Security

- Raw tokens are NEVER stored in Postgres. Only SHA-256(token) in approval_links.
- Token generation happens in NotificationWorker, right before sending email.
- GET /approve/:token is READ-ONLY. It renders the page but NEVER writes to DB.
- POST /api/approval/session binds device_cookie_hash on first deliberate action.
- POST approve/edit/regenerate requires: raw token + device cookie + CSRF token.
- Approval links have 48-hour TTL.
- Regenerate revokes ALL outstanding links for that response.
- Rate limit: 3 actions per token per minute.
```

**`.claude/skills/cost-guard.md`**
```markdown
# LLM Cost Guard Pattern

1. BEFORE any LLM call:
   - Redis INCRBY on cost:daily:{businessId}:{date} with pessimistic estimate (15 cents)
   - Redis INCRBY on cost:global:{date}
   - If either exceeds limit: DECRBY to release, throw CostLimitExceeded
   - Acquire concurrency slot: INCR on gen:active:{businessId}, max 3

2. AFTER LLM call:
   - Calculate actual cost from token usage
   - Adjust Redis counters: INCRBY(actual - estimated) — can be negative
   - Mark as finalized — NEVER refund after finalization

3. ON FAILURE (before finalization):
   - DECRBY to release the reservation
   - DECR concurrency slot in finally block

4. Tier-aware limits: founding=500¢/day, standard=1000¢/day, premium=2000¢/day
5. Global circuit breaker: if global daily exceeds hard cap, ALL generation halts
```

---

## Sprint 1: Scaffolding + Demo Engine (Days 1–5)

### What you build
Project skeleton, database, infrastructure, and the Prospect Demo Generator.

### Claude Code prompts

**Prompt 1 — Project initialization (Day 1)**
```
Initialize a Next.js 14 project with TypeScript strict mode, Tailwind CSS, and App Router in src/ directory. Set up the full directory structure from CLAUDE.md. Install these dependencies:

Production: zustand @tanstack/react-query react-hook-form zod openai @anthropic-ai/sdk serpapi bullmq ioredis resend stripe franc-min nanoid @supabase/supabase-js postgres isomorphic-dompurify uuid fastify @fastify/raw-body
Dev: vitest @playwright/test

IMPORTANT: Do NOT install crypto-js — use Node.js native `import { createHash, randomUUID } from 'node:crypto'` for all hashing (SHA-256 for tokens, review dedup, content hash). The native module is faster and more secure.

Use isomorphic-dompurify (NOT dompurify) — it bundles jsdom so it works in both Next.js SSR and Railway workers where there is no browser DOM.

Configure tsconfig.json with strict: true, noUncheckedIndexedAccess: true.
Create placeholder files for every directory in the structure.
Create a .env.local template with all required variables. Reference docs/Implementation_Phases_SerpAPI_First.md section 2.3 for the complete list. Key variables:

- DATABASE_URL, DATABASE_POOL_URL
- SUPABASE_URL, SUPABASE_SERVICE_KEY
- NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY
- REDIS_CACHE_URL, REDIS_QUEUE_URL
- OPENAI_API_KEY, ANTHROPIC_API_KEY, SERPAPI_API_KEY
- RESEND_API_KEY, RESEND_WEBHOOK_SECRET
- STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET
- NEXT_PUBLIC_APP_URL, WORKER_SERVICE_URL, SENTRY_DSN
- SESSION_COOKIE_SECRET, CSRF_SECRET

Keep `SUPABASE_SERVICE_KEY`, webhook secrets, and cookie/CSRF secrets server-only. Comment out GBP API variables (GOOGLE_CLIENT_ID, etc.) as "Added in Phase 5".
```

**Prompt 2 — Database schema (Day 1)**

Use the **Supabase MCP** here:
```
Read the database schema from supabase/migrations/001_initial_schema.sql (I'll provide it). Create all tables with indexes in my Supabase project. The schema includes: businesses, google_connections, reviews, responses, approval_links, users, inbound_events, job_outbox, notification_deliveries, prospect_demos, weekly_summaries, api_costs, review_exceptions, approval_audit_log.

Important modifications to the base schema from 04-final-plan.md:

1. Change `businesses.subscription_status` DEFAULT from `'active'` to `'pending_payment'`. Businesses must not start in `active` — Stripe's `checkout.session.completed` webhook is the transition to `active`. This prevents SerpAPI polling and LLM generation for unpaid accounts.

2. Add `'awaiting_manual_post'` and `'superseded'` to the responses.status comment. The column is VARCHAR so no CHECK constraint change needed, but document the valid values: `'pending_approval'`, `'approved'`, `'edited'`, `'superseded'`, `'awaiting_manual_post'`, `'posted'`, `'failed'`. The `superseded` status is terminal — it means the owner requested a regeneration and this draft was replaced by a newer version. Enforce the invariant: at most one non-terminal response per review at a time.

3. Add a `last_sync_at TIMESTAMPTZ` column to the `businesses` table. In SerpAPI mode there are no `google_connections` rows, so the ReconciliationPoller needs this column to track when each business was last synced.

3. Create an `approval_audit_log` table for audit-logging all approval actions:
   - id UUID PRIMARY KEY DEFAULT uuidv7()
   - response_id UUID NOT NULL REFERENCES responses(id)
   - business_id UUID NOT NULL REFERENCES businesses(id)
   - token_hash TEXT NOT NULL (the SHA-256 hash — never the raw token)
   - device_cookie_hash TEXT
   - action TEXT NOT NULL ('approve', 'edit', 'regenerate', 'session_bind')
   - ip_address TEXT
   - metadata JSONB DEFAULT '{}'
   - created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   - Index: idx_aal_response ON approval_audit_log(response_id)
   - Index: idx_aal_business ON approval_audit_log(business_id, created_at)

4. Check if `pg_uuidv7` extension is available in your Supabase project (run `CREATE EXTENSION IF NOT EXISTS pg_uuidv7;` in the SQL editor). If not available, use the `uuid` npm package (v10+) to generate UUIDv7 in the application layer via `import { v7 as uuidv7 } from 'uuid'` and pass them explicitly to INSERT statements instead of relying on DEFAULT uuidv7(). Remove the DEFAULT from the schema and always provide IDs from app code.

5. Add these additional indexes not in the base schema:
   - `CREATE INDEX idx_businesses_sync ON businesses(subscription_status, last_sync_at) WHERE subscription_status = 'active';` — used by ReconciliationPoller every 60 minutes
   - `CREATE INDEX idx_businesses_status ON businesses(subscription_status);` — used by subscription guards in all workers

All primary keys use UUIDv7.
```

*Copy the FULL SQL from Section 5 of 04-final-plan.md into the migration file before running this prompt. Then add the modifications above (last_sync_at, subscription_status default, response statuses, approval_audit_log table, additional indexes).*

**Migration checklist by sprint** — schema additions beyond the initial migration:

| Sprint | Migration | Before which prompt |
|---|---|---|
| Sprint 1 | `prospect_demos`: add `generation_status`, `generation_error`, `started_at`, `completed_at` columns | Before Prompt 6 |
| Sprint 3 | `businesses`: add ROI baseline fields (`initial_review_count`, `initial_responded_count`, `baseline_captured_at`) — or create a dedicated `business_baselines` table | Before Prompt 13 onboarding form |
| Sprint 5A | Create `monthly_impact_emails` table and notification delivery cooldown index | Before Prompt 19a |
| Sprint 5B | Add deferred retention objects only when implementing 5B (`satisfaction_responses`, `onboarding_drip_log`, `businesses.tracked_keywords`, `businesses.subscription_activated_at`, ranking location columns, notification opt-out columns, approval audit owner-session columns if not already present, and a unique ranking snapshot constraint before automated ranking upserts) | Before the relevant 5B prompt |

`ranking_snapshots` already exists in the initial schema. Sprint 5A may read it if data exists, but must not require new SerpAPI ranking automation.

Run each migration before the prompt that depends on it. Keep migrations in `supabase/migrations/` with sequential numbering.

**Prompt 3 — Worker skeleton + HTTP ingress + DB client + basic OutboxPoller (Day 2)**
```
Create the Railway worker service AND the shared database client. This prompt has two parts.

PART A — Database client (src/lib/db/client.ts):
Create the application-level Postgres/Supabase client that ALL later prompts depend on. Install `postgres` (pnpm add postgres) for raw SQL with transaction support — @supabase/supabase-js does NOT support multi-statement transactions, and the outbox pattern requires them.

Create src/lib/db/client.ts exporting:
- `sql` — a Postgres.js client initialized with DATABASE_POOL_URL for direct SQL with full transaction support: `sql.begin(async (tx) => { ... })`. This is the PRIMARY client for all transactional writes (outbox + state change in one commit).
- `supabaseServer` — a Supabase client initialized with SUPABASE_URL + SUPABASE_SERVICE_KEY for server-side reads, auth admin operations, and storage. NEVER import this in browser code.
- `supabaseClient` — a Supabase client initialized with NEXT_PUBLIC_SUPABASE_URL + NEXT_PUBLIC_SUPABASE_ANON_KEY for browser-side auth and real-time subscriptions.

PART B — Worker service (worker/index.ts):
It needs THREE responsibilities: Fastify HTTP server (webhook ingress), BullMQ queue processing, and OutboxPoller dispatch.

HTTP framework: use Fastify (pnpm add fastify @fastify/raw-body). Fastify provides:
- Native raw-body support via @fastify/raw-body plugin — critical for Stripe/Resend webhook signature verification
- Proper routing for health + webhook ingress endpoints
- Good TypeScript support and low overhead

Set up the worker entry point:
1. Create a Fastify server listening on process.env.PORT
2. Register @fastify/raw-body plugin (enables rawBody on routes that need it)
3. Add GET /api/health endpoint returning { status: 'ok', timestamp }
4. Add placeholder POST routes for future webhook ingress:
   - POST /ingress/stripe (with rawBody: true on route config)
   - POST /ingress/resend (with rawBody: true on route config)
   These are placeholders that return 200 OK for now. They will be implemented in Prompts 10 and 14.
5. Import and initialize BullMQ with the REDIS_QUEUE_URL connection
6. Define queues: generate_demo, sync_reviews, generate_response, send_notification, publish_response, weekly_summary, notify_admin_review_exception
7. Set up placeholder worker handlers for each queue that just log the job data
8. Set up a FUNCTIONAL OutboxPoller (10-second setInterval) — NOT just a placeholder:
   - Query: SELECT * FROM job_outbox WHERE status = 'pending' AND available_at <= NOW() ORDER BY available_at LIMIT 50
   - For each entry: dispatch to BullMQ queue matching entry.topic, using entry.id as jobId (idempotent)
   - On successful dispatch: UPDATE status = 'dispatched', dispatched_at = NOW(), attempts = attempts + 1
   - On dispatch failure: log error, leave as 'pending' for retry on next cycle
   - This basic version is needed for Sprint 1 demo generation to work. Prompt 7 will add FOR UPDATE SKIP LOCKED, watchdog recovery, max_attempts terminal failure, and batch locking.

Use ioredis for the Redis connection. Export queue references, the Fastify instance, and the sql client for use by other modules.

IMPORTANT: The Fastify server, BullMQ workers, and OutboxPoller run in the same process. The server handles HTTP ingress (webhooks, health), BullMQ consumers handle async queue processing, and the OutboxPoller bridges Postgres outbox entries to BullMQ. This is the standard Railway worker pattern.
```

**Prompt 4 — ReviewSource + SerpAPI (Day 3)**

Use **Context7 MCP** to look up SerpAPI docs:
```
@context7 Look up the SerpAPI Node.js library documentation for Google Maps Reviews API.

Now build the ReviewSource interface and SerpAPI implementation:

1. Create src/lib/reviews/types.ts with:
   - NormalizedReview interface: reviewerName, starRating, reviewText (string | null), reviewDate (ISO 8601), detectedLanguage (ISO 639-1)
   - ReviewSource interface with fetchReviews(placeId: string, maxResults?: number): Promise<NormalizedReview[]>
   - ContentHashable type extending NormalizedReview with a computeContentHash() utility that returns SHA-256(starRating + "|" + reviewText) — this is used later by the production monitor for edit detection
   - Use `import { createHash } from 'node:crypto'` for hashing — NOT crypto-js

2. Create src/lib/reviews/serpapi-source.ts that implements ReviewSource:
   - Calls SerpAPI Google Maps Reviews endpoint
   - Normalizes response to NormalizedReview[]
   - Strips ALL SerpAPI-specific fields (only keep the contract fields)
   - Uses franc-min for language detection on each review (map franc's ISO 639-3 to ISO 639-1, fallback to 'en')
   - NOTE: franc-min has limited accuracy on short reviews (<20 words). For short texts, default to 'en' rather than trusting a low-confidence detection. The LLM will self-correct language in the response regardless since the system prompt says "respond in the same language as the review" — franc is a hint, not a gate.
   - Returns 10-15 most recent reviews
   - This is the DEMO mode source — fetches once, no deduplication

3. Create src/lib/reviews/serpapi-monitor.ts — the PRODUCTION monitoring variant:
   - Same SerpAPI call as serpapi-source.ts but designed for polling + dedup
   - IMPORTANT: inspect the raw SerpAPI response for any stable review identifier (review_id field, review permalink, or reviewer profile URL). Log or print the raw response shape during development to discover available fields.
   - For each review, compute the identity fields using the BEST available identifier:
     - PREFERRED: if SerpAPI provides a review_id or review link, use it directly as provider_review_id
     - FALLBACK: if no stable source ID exists, use SHA-256(reviewerName + "|" + reviewDate + "|" + reviewerProfileUrl) — include the reviewer profile URL to disambiguate reviewers with the same display name on the same date
     - LAST RESORT: SHA-256(reviewerName + "|" + reviewDate) only if no other disambiguator is available. Log a warning for reviews where reviewerName is null, empty, or "A Google User" — these are collision-prone.
   - Synthetic resource names (regardless of ID strategy):
     - provider_review_name = 'serpapi://{placeId}/reviews/{provider_review_id}'
     - provider_location_name = 'serpapi://{placeId}'
   - Mutable content hash: review_content_hash = SHA-256(starRating + "|" + reviewText) — used for edit detection, NOT for identity
   - If two reviews produce the same identity key but have different content on first encounter, flag the second one to `review_exceptions` with type `'identity_collision'` instead of silently merging
   - Returns enriched reviews with all identity + hash fields populated
   - The NormalizedReview DTO stays clean (no source-specific fields) — identity data is separate metadata
   - When GBP API arrives, this module is swapped for gbp-api-source.ts — the dedup logic in ReviewSyncWorker stays the same

4. Create src/lib/reviews/url-parser.ts that extracts Google Place ID from various Google Maps URL formats (full URL, short link, CID parameter)

5. Write contract tests in src/lib/reviews/__tests__/serpapi-source.test.ts that verify:
   - Output shape matches NormalizedReview exactly — no extra fields allowed
   - Content hash is deterministic (same input → same hash)
   - Language detection produces valid ISO 639-1 codes
```

**Prompt 5 — Response generator + prompt builder (Day 4)**
```
Build the response generation pipeline:

1. Create src/lib/responses/prompt-builder.ts:
   - buildDemoPrompt(review, businessName, category): for demo engine, infers tone from category
   - buildProductionPrompt(review, business, voiceExamples): for production, uses full business context
   - System prompt from the plan: specific to review content, match tone, under 80 words positive / 120 negative, same language as review, never placeholder text

2. Create src/lib/responses/generator.ts:
   - generateResponse(review, businessContext, options): calls OpenAI GPT-4o-mini
   - Falls back to Anthropic Claude Haiku if OpenAI fails
   - Returns { responseText, language, provider, usage, costUsd }
   - For demo mode: skip cost guards (no Redis needed)
   - For production mode: full cost guard pattern from .claude/skills/cost-guard.md

3. Create src/lib/costs/tracker.ts:
   - Redis-based atomic cost reservation per .claude/skills/cost-guard.md
   - record() writes to api_costs table
   - Tier-aware daily limits
```

**Prompt 6 — Demo generation pipeline + UI (Day 5)**
```
Build the complete demo generation feature as an ASYNC worker-driven workflow:

1. Create src/lib/demos/generator.ts for use by a Railway worker:
   - Takes a Google Maps URL
   - Parses URL → extracts Place ID
   - Fetches 10-15 reviews via SerpAPI ReviewSource  
   - Generates AI response for each review
   - Generates a nanoid(10) slug
   - Saves the completed snapshot to prospect_demos
   - Returns the demo URL

2. If `prospect_demos` does not already track generation lifecycle, add a migration before building the UI:
   - `generation_status` (`queued` | `running` | `completed` | `failed`)
   - `generation_error` (nullable text)
   - `started_at`, `completed_at`
   - Keep this SEPARATE from `prospect_status`, which is the sales lifecycle.

3. Create worker/jobs/DemoGenerationWorker.ts:
   - Consumes `generate_demo` jobs
   - Reads the queued prospect_demos record
   - Marks it `running`
   - Calls src/lib/demos/generator.ts
   - On success: saves reviews snapshot + generated responses + marks `completed`
   - On failure: marks `failed` and stores a human-readable `generation_error`

4. Create the demo viewer page at src/app/(public)/demo/[slug]/page.tsx:
   - SSR page, mobile-first design
   - Shows business name, review count, response rate comparison
   - Each review as a card with stars, text, date
   - AI response below each review
   - Multilingual badge on non-English pairs
   - CTA at bottom with Calendly link
   - Increments view_count: use a Redis INCR per slug (debounced), flush to Postgres on a 5-minute interval via a simple cron or on-read check. This prevents write pressure if a demo link goes viral. For MVP, direct Postgres increment is acceptable — add debouncing in Sprint 4 if needed.

5. Create the admin demo page at src/app/(admin)/demos/page.tsx:
   - Input field for Google Maps URL
   - "Generate Demo" button that queues work and returns immediately
   - Polling UI for `generation_status`: queued, running, completed, failed
   - List of generated demos with view count, status, copy-link button
   - Auth protection is deferred to Sprint 3 (Prompt 13). For Sprint 1, add a TODO comment for auth on admin routes. During development you are the only user.

6. Create API routes:
   - POST /api/admin/demos/generate — validates auth/input, then in ONE transaction: creates a `prospect_demos` row (generation_status='queued') + inserts a `job_outbox` entry with topic='generate_demo'. Returns demo id/slug immediately. Do NOT enqueue directly to BullMQ — use the outbox pattern so if the enqueue fails, the OutboxPoller recovers it. This is consistent with the "transactional outbox for all async work" invariant.
   - GET /api/admin/demos — list all demos with generation status
```

### Deployment (between prompts — do this after Prompt 3)

Deploy both services before continuing to Prompt 4:

1. **Vercel**: Run `vercel --prod` or connect your GitHub repo in the Vercel dashboard. Verify the default Next.js page loads at your production URL.
2. **Railway**: Create a new service in your Railway project. Set the start command to `npx tsx worker/index.ts` (or configure a build step). Add all environment variables from `.env.local`. Verify `https://yourworker.railway.app/api/health` returns `{"status":"ok"}`.

### Sprint 1 done when
- [ ] App is live on Vercel, worker on Railway (both health checks passing)
- [ ] All 14 database tables exist (13 from plan + approval_audit_log)
- [ ] Pasting a Google Maps URL generates a demo in under 90 seconds
- [ ] Demo page is mobile-optimized and shareable
- [ ] Non-English reviews get same-language responses
- [ ] Sales partner can generate demos independently

---

## Sprint 2: Production Pipeline (Days 6–13)

### What you build
Shared worker utilities, SerpAPI polling, outbox-driven response generation, email notifications, approval flow, and manual posting.

### Sprint 2 Architecture Review Overrides

If any prompt below conflicts with these rules, these rules win:

- **OutboxPoller is ALREADY hardened.** Do NOT recreate it. It already has: `FOR UPDATE SKIP LOCKED`, transaction wrapping, `max_attempts` enforcement, JSONB parsing guard. Only ADD the missing watchdog recovery.
- **JSONB parsing guard EVERYWHERE.** Postgres.js returns JSONB columns as strings through PgBouncer. EVERY worker reading JSONB from Postgres must use: `typeof x === 'string' ? JSON.parse(x) : x`. This was discovered in Sprint 1 and is documented in `.claude/CLAUDE.md` lab notes.
- **Subscription guard rules (from CLAUDE.md — authoritative):**
  - `cancelled` → skip, complete outbox
  - `past_due` → check how long (7-day grace). If `> 7 days`, treat as cancelled. Otherwise allow.
  - `pending_payment` → `ResponseGeneratorWorker` is ALLOWED (admin-visible demo drafts during sales call). `NotificationWorker` and `ResponsePublisherWorker` MUST skip.
- **Worker registration pattern.** Every new worker MUST: (1) import the handler in `worker/index.ts`, (2) create `new Worker(QUEUE_NAMES.X, handler, { connection: redisOpts })`, (3) add to the `workers` array for graceful shutdown.
- **Outbox completion.** Every worker MUST mark its originating outbox entry as `completed` or `failed` on every code path. Use the shared `markOutboxCompleted()` utility (created in Prompt 7).
- **Mock mode.** When `MOCK_EXTERNAL_APIS=true`, workers that call external APIs (SerpAPI, OpenAI, Anthropic, Resend) must use mock implementations. This allows local testing without API keys or costs.
- **All job payload shapes must be defined as TypeScript interfaces** in a shared location so producers and consumers agree on the contract.

### Claude Code prompts

**Prompt 7 — Shared worker utilities (Day 6)**
```
Create the shared utilities that ALL Sprint 2 workers depend on. These MUST exist before any worker is built.

1. Create src/lib/shared/subscription-guard.ts:
   - Export: checkSubscription(status: string, businessUpdatedAt: Date, workerType: 'generator' | 'notification' | 'publisher' | 'summary'): { allowed: true } | { allowed: false; reason: string }
   - Rules per CLAUDE.md (these are AUTHORITATIVE):
     - cancelled → { allowed: false, reason: 'cancelled' }
     - past_due → check Date.now() - businessUpdatedAt.getTime() > 7 * 86_400_000. If exceeded: { allowed: false, reason: 'past_due_expired' }. Otherwise: { allowed: true }
     - pending_payment → if workerType === 'generator': { allowed: true }. Otherwise: { allowed: false, reason: 'pending_payment' }
     - active → { allowed: true }
   - Write tests in src/lib/shared/__tests__/subscription-guard.test.ts covering all 4 statuses × 4 worker types + grace period boundary

2. Create src/lib/shared/outbox.ts:
   - Import sql from '@/lib/db/server'
   - Export: markOutboxCompleted(outboxId: string): Promise<void> — UPDATE job_outbox SET status = 'completed', completed_at = NOW() WHERE id = $1
   - Export: markOutboxFailed(outboxId: string, error: string): Promise<void> — UPDATE job_outbox SET status = 'failed', last_error = $1, completed_at = NOW() WHERE id = $2
   - These are currently local functions in DemoGenerationWorker.ts. Extract them here and update DemoGenerationWorker to import from this shared module.

3. Create src/lib/shared/sanitize.ts:
   - Export: sanitizeText(input: string): string
   - Strip Unicode control characters (U+0000-U+001F except \n \r \t, U+007F-U+009F)
   - Strip null bytes (\x00)
   - Collapse multiple whitespace into single space
   - Trim leading/trailing whitespace
   - Write tests in src/lib/shared/__tests__/sanitize.test.ts

4. Create src/lib/shared/rate-limit.ts:
   - Import getCacheRedis from '@/lib/costs/tracker'
   - Export: checkRateLimit(key: string, maxRequests: number, windowSeconds: number): Promise<{ allowed: boolean; remaining: number }>
   - Uses Redis INCR + EXPIRE pattern on the cache instance (NOT the queue instance)
   - Write tests with mocked Redis

5. Create src/lib/shared/mock-mode.ts:
   - Export: isMockMode(): boolean — returns process.env.MOCK_EXTERNAL_APIS === 'true'
   - Export: getReviewMonitor(apiKey: string): SerpApiMonitor | MockSerpApiMonitor
   - Create src/lib/reviews/mock-monitor.ts that returns a MockSerpApiMonitor:
     - Reuses reviews from MockReviewSource (src/lib/reviews/mock-source.ts)
     - Enriches each with identity fields (provider='serpapi_poll', providerReviewId=SHA-256 hash, providerReviewName, providerLocationName) and contentHash
     - Returns MonitorResult { reviews: MonitoredReview[], collisions: [] }
   - This is needed by ReviewSyncWorker in mock mode

6. Create src/lib/shared/worker-types.ts — ALL job payload interfaces:
   - SyncReviewsPayload: { business_id: string; google_place_id: string }
   - GenerateResponsePayload: { review_id: string; business_id: string; version: number }
   - SendNotificationPayload: { response_id: string; business_id: string }
   - PublishResponsePayload: { response_id: string; business_id: string }
   - NotifyAdminExceptionPayload: { review_exception_id: string; business_id: string }
   - DemoJobPayload already exists in src/lib/demos/types.ts — leave it there
   - These types are imported by BOTH the producer (whoever writes the outbox entry) and the consumer (the worker)

7. Create src/lib/responses/voice-learning.ts:
   - Export: getApprovedResponsePairs(businessId: string): Promise<VoiceExample[]>
   - Query: SELECT original_draft_text, edited_text, r.star_rating FROM responses resp JOIN reviews r ON resp.review_id = r.id WHERE resp.business_id = $1 AND resp.status = 'posted' AND resp.edited_text IS NOT NULL ORDER BY resp.posted_at DESC LIMIT 10
   - Filter to ≤ 5 results
   - Return as VoiceExample[] (from src/lib/responses/types.ts)
   - Uses the existing idx_responses_voice index
   - Returns [] if < 5 edited+posted responses exist (voice learning hasn't activated yet)
   - JSONB parsing guard on any JSONB columns read

8. Install the `fastest-levenshtein` package (needed by Prompt 12 approval edit flow):
   pnpm add fastest-levenshtein

After creating all utilities, verify:
- tsc --noEmit passes
- pnpm test passes (all new + existing tests)
```

**Prompt 8 — OutboxPoller watchdog + ReconciliationPoller (Day 6)**
```
The OutboxPoller (worker/jobs/OutboxPoller.ts) is ALREADY implemented with FOR UPDATE SKIP LOCKED, transaction wrapping, and max_attempts enforcement. Do NOT recreate it. This prompt adds TWO things: watchdog recovery and the ReconciliationPoller.

1. ADD watchdog recovery to the EXISTING OutboxPoller (worker/jobs/OutboxPoller.ts):
   - At the START of each poll cycle (inside the sql.begin, before the pending-entry SELECT), run a watchdog query:
     UPDATE job_outbox SET status = 'pending', available_at = NOW()
     WHERE status = 'dispatched' AND dispatched_at < NOW() - INTERVAL '1 hour' AND attempts < max_attempts
   - For entries that are dispatched AND exceeded max_attempts:
     UPDATE job_outbox SET status = 'failed', last_error = 'Stale dispatched entry exceeded max_attempts', completed_at = NOW()
     WHERE status = 'dispatched' AND dispatched_at < NOW() - INTERVAL '1 hour' AND attempts >= max_attempts
   - Log how many entries were recovered and how many were failed
   - This recovers from the scenario where a BullMQ worker crashes after the OutboxPoller marks the entry as 'dispatched' but before the worker marks it as 'completed'

2. Create worker/jobs/ReconciliationPoller.ts:
   - Uses setInterval (same pattern as OutboxPoller, NOT BullMQ repeatable jobs — simpler and consistent)
   - Interval: 60 minutes (configurable via RECONCILIATION_INTERVAL_MS env var, default 3_600_000)
   - Re-entrancy guard: isPolling flag (same pattern as OutboxPoller)
   - If isMockMode() from src/lib/shared/mock-mode.ts: log and skip. ReconciliationPoller should not create sync jobs in mock mode.
   - Query active businesses due for sync:
     SELECT id, google_place_id FROM businesses
     WHERE subscription_status = 'active'
       AND google_place_id IS NOT NULL
       AND (last_sync_at IS NULL OR last_sync_at < NOW() - INTERVAL '60 minutes')
   - DEDUP GUARD: For each business, check for in-flight sync before creating a new outbox entry:
     WHERE NOT EXISTS (
       SELECT 1 FROM job_outbox
       WHERE topic = 'sync_reviews' AND aggregate_id = business.id
         AND status IN ('pending', 'dispatched')
     )
   - For each eligible business, insert outbox entry in a transaction:
     INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
     VALUES (uuidv7(), 'sync_reviews', 'business', business.id, '{"business_id":"...","google_place_id":"..."}'::jsonb, 'pending')
   - Use SyncReviewsPayload from src/lib/shared/worker-types.ts for the payload shape
   - Export startReconciliationPoller() / stopReconciliationPoller()

3. Update worker/index.ts:
   - Import and call startReconciliationPoller() after startOutboxPoller()
   - Call stopReconciliationPoller() in the shutdown function

4. When GBP API arrives: ReconciliationPoller becomes the FALLBACK path with adaptive intervals (60/120/240 min based on review velocity). The architecture stays the same.
```

**Prompt 9 — ReviewSyncWorker (Day 7)**
```
Build worker/jobs/ReviewSyncWorker.ts that processes sync_reviews jobs.

Job payload type: SyncReviewsPayload from src/lib/shared/worker-types.ts
  { business_id: string; google_place_id: string }

1. Read business from DB:
   SELECT id, subscription_status, updated_at, google_place_id, baseline_captured_at
   FROM businesses WHERE id = $1
   - If not found: log warning, markOutboxCompleted(), return
   - Subscription guard: checkSubscription(status, updatedAt, 'generator'). If not allowed: markOutboxCompleted(), return
   - Null google_place_id guard: if null, log warning, markOutboxCompleted(), return

2. Fetch reviews:
   - If isMockMode(): use MockSerpApiMonitor from src/lib/reviews/mock-monitor.ts
   - Otherwise: use SerpApiMonitor from src/lib/reviews/serpapi-monitor.ts with SERPAPI_API_KEY
   - Call monitor.fetchReviews(business.google_place_id)
   - Returns MonitorResult { reviews: MonitoredReview[], collisions: IdentityCollision[] }
   - SerpAPI error handling:
     - Transient errors (network, 429 rate limit, 5xx): THROW so BullMQ retries with exponential backoff
     - Permanent errors (401 auth, 403 quota): markOutboxFailed() with error message, return

3. Handle collisions:
   - For each collision in MonitorResult.collisions, insert into review_exceptions:
     INSERT INTO review_exceptions (id, business_id, review_id, type, payload)
     VALUES (uuidv7(), business_id, NULL, 'identity_collision', $collisionJson::jsonb)
     ON CONFLICT DO NOTHING (use the unique partial index on review_id + type WHERE status = 'open')
   - Note: review_id is NULL for identity collisions detected at fetch time (the review hasn't been inserted yet)

4. Process each review — use ONE Postgres transaction PER REVIEW (intentional: partial success is better than all-or-nothing failure):
   Inside sql.begin(async (tx) => { ... }):

   a. Read existing review with FOR UPDATE lock:
      SELECT id, review_content_hash FROM reviews
      WHERE provider = ${identity.provider} AND provider_review_name = ${identity.providerReviewName}
      FOR UPDATE

   b. Upsert the review:
      INSERT INTO reviews (id, business_id, provider, provider_review_id, provider_review_name, provider_location_name, reviewer_name, star_rating, review_text, review_date, detected_language, review_content_hash, status)
      VALUES (uuidv7(), ...)
      ON CONFLICT (provider, provider_review_name) DO UPDATE SET
        reviewer_name = EXCLUDED.reviewer_name,
        star_rating = EXCLUDED.star_rating,
        review_text = EXCLUDED.review_text,
        review_content_hash = EXCLUDED.review_content_hash,
        detected_at = NOW()
      RETURNING id

   c. Branch logic:
      - NEW review (no existing row from step a):
        Insert outbox entry topic='generate_response' with GenerateResponsePayload { review_id, business_id, version: 1 }
      - CONTENT CHANGED (existing row AND review_content_hash differs):
        Check response status: SELECT status FROM responses WHERE review_id = existingId AND status NOT IN ('superseded', 'failed') ORDER BY version DESC LIMIT 1
        * If response is 'pending_approval': UPDATE responses SET status = 'failed', posting_error = 'Review updated by reviewer' WHERE id = responseId. Insert new generate_response outbox entry with version+1
        * If response is 'posted' or 'awaiting_manual_post': INSERT review_exceptions (type='review_edited_after_post') ON CONFLICT DO NOTHING. Insert notify_admin_review_exception outbox entry.
      - UNCHANGED: skip (no action)

5. After all reviews processed:
   UPDATE businesses SET last_sync_at = NOW() WHERE id = $business_id

6. ROI baseline capture:
   If business.baseline_captured_at IS NULL (first sync for this business):
   - Count: SELECT COUNT(*) FROM reviews WHERE business_id = $1 (total just ingested)
   - SerpAPI does NOT reliably provide owner reply counts. Default initial_responded_count = 0.
   - UPDATE businesses SET initial_review_count = $count, initial_responded_count = 0, baseline_captured_at = NOW() WHERE id = $1
   - This powers Sprint 5's ROI dashboard. Accuracy improves when GBP API arrives.

7. markOutboxCompleted(outboxId)

8. Register worker in worker/index.ts:
   - Import handleReviewSync from './jobs/ReviewSyncWorker'
   - const reviewSyncWorker = new Worker(QUEUE_NAMES.SYNC_REVIEWS, handleReviewSync, { connection: redisOpts })
   - Add to workers array

Write tests covering: new review → outbox entry created, unchanged review → no action, content changed + pending response → old response failed + new outbox, content changed + posted → exception created, null google_place_id → early return, subscription cancelled → skip.
```

**Prompt 10 — ResponseGeneratorWorker (Day 8)**
```
Build worker/jobs/ResponseGeneratorWorker.ts. This is a thin orchestration wrapper around the existing generateResponse() in src/lib/responses/generator.ts, which already implements the full cost guard lifecycle.

Job payload type: GenerateResponsePayload from src/lib/shared/worker-types.ts
  { review_id: string; business_id: string; version: number }

1. Read review and business from DB:
   SELECT * FROM reviews WHERE id = $reviewId
   SELECT * FROM businesses WHERE id = $businessId
   - If either not found: markOutboxFailed(), return
   - Build BusinessContext from the business row (map DB snake_case columns to TypeScript camelCase: tone, products_services → productsServices, staff_names → staffNames, etc.)

2. Subscription guard:
   checkSubscription(business.subscription_status, business.updated_at, 'generator')
   - If not allowed: markOutboxCompleted(), return

3. Input sanitization:
   Apply sanitizeText() from src/lib/shared/sanitize.ts to review.review_text before passing to the generator. This strips Unicode control chars, null bytes, and collapses whitespace.

4. Voice learning:
   const voiceExamples = await getApprovedResponsePairs(businessId)
   - From src/lib/responses/voice-learning.ts (created in Prompt 7)
   - Returns [] until ≥ 5 edited+posted responses exist

5. Generate response with guardrails:
   - If isMockMode(): use generateMockResponse() from src/lib/responses/mock-generator.ts
   - Otherwise: call generateResponse(review, businessContext, voiceExamples, { mode: 'production', reviewId, version, businessId, subscriptionTier })
   - The generator.ts already handles: idempotent cache, cost reservation, concurrency limit, OpenAI → Anthropic fallback, finalization, audit trail
   - AFTER getting the result: check business.avoid_facts against result.responseText. If any avoid_fact string appears (case-insensitive substring match): log a warning and regenerate ONCE with the same parameters. Accumulate cost from both attempts. If the second attempt also violates, use it anyway (best-effort).
   - Regeneration budget: call checkRegenBudget(reviewId) from src/lib/costs/tracker.ts BEFORE generating. Skip if budget exceeded.

6. After successful generation, in ONE sql.begin() transaction:
   - INSERT INTO responses (id, review_id, business_id, response_text, response_language, version, status, original_draft_text, llm_provider, llm_model, prompt_tokens, completion_tokens)
     VALUES (uuidv7(), reviewId, businessId, result.responseText, result.language, version, 'pending_approval', result.responseText, result.provider, result.model, result.usage.promptTokens, result.usage.completionTokens)
     RETURNING id
   - Link api_costs: if result.apiCostId is not null, call linkApiCostToResponse(result.apiCostId, responseId)
   - INSERT outbox entry topic='send_notification' with SendNotificationPayload { response_id: responseId, business_id: businessId }
   - Do NOT include any approval token in the outbox payload. Token generation happens in NotificationWorker.

7. markOutboxCompleted(outboxId)

8. Error handling:
   - CostLimitExceededError, GlobalCostLimitExceededError: markOutboxFailed() with the error message. Do NOT retry (the limit is real).
   - ConcurrencyLimitExceededError: THROW so BullMQ retries later (transient — other jobs will finish).
   - RegenBudgetExceededError: markOutboxFailed(). Do NOT retry.
   - LLM call failures (after both OpenAI and Anthropic fail): markOutboxFailed() with error.
   - DB transaction failures: THROW so BullMQ retries (transient).

9. Register worker in worker/index.ts (same pattern as Prompt 9 step 8).

Write tests covering: successful generation → response + outbox created, subscription cancelled → skip, cost limit exceeded → outbox failed, mock mode → uses mock generator, avoid_facts violation → regenerates once.
```

**Prompt 11 — NotificationWorker + email + delivery tracking (Day 9)**
```
Build the notification system.

PREREQUISITES: Add RESEND_FROM_EMAIL to .env.local and .env.example:
  RESEND_FROM_EMAIL="RepWorth <notifications@yourdomain.com>"
  You must verify the sender domain in the Resend dashboard first.

Job payload type: SendNotificationPayload from src/lib/shared/worker-types.ts
  { response_id: string; business_id: string }

1. Create src/lib/notifications/email.ts:
   - Import { Resend } from 'resend'
   - Initialize with RESEND_API_KEY
   - Export: sendApprovalEmail(params: { to: string; from: string; businessName: string; reviewerName: string; starRating: number; reviewText: string | null; responsePreview: string; approvalUrl: string }): Promise<{ messageId: string }>
   - HTML template (inline CSS, single-column, mobile-first, max-width 600px):
     - Subject: "New review for {businessName} — response ready"
     - Body: star rating as "★★★★☆" text, reviewer name + date, review text (truncated to 200 chars with "..." if longer, or "Rating only — no written review"), draft response preview (first 100 chars), big blue CTA button "Review & Approve" linking to approvalUrl, footer "This link expires in 48 hours"
   - Returns { messageId } from Resend response (the external_message_id)
   - If isMockMode(): log the email contents and return { messageId: 'mock-' + randomUUID() } instead of calling Resend

2. Create worker/jobs/NotificationWorker.ts:
   - Consumes send_notification jobs
   - Read response + review + business from DB:
     SELECT resp.*, r.reviewer_name, r.star_rating, r.review_text, r.review_date
     FROM responses resp JOIN reviews r ON resp.review_id = r.id
     WHERE resp.id = $responseId
     SELECT owner_email, owner_name, name as business_name FROM businesses WHERE id = $businessId
   - Subscription guard: checkSubscription(status, updatedAt, 'notification'). This correctly skips cancelled, past_due beyond grace, AND pending_payment.
   - Generate approval token: import { randomUUID, createHash } from 'node:crypto'. const rawToken = randomUUID(). const tokenHash = createHash('sha256').update(rawToken).digest('hex').
   - Idempotency: check for existing unexpired approval link for this response:
     SELECT id FROM approval_links WHERE response_id = $responseId AND revoked_at IS NULL AND expires_at > NOW()
     If one exists, the email was already sent (retry scenario). markOutboxCompleted(), return.
   - In ONE sql.begin() transaction:
     - INSERT INTO approval_links (id, response_id, business_id, token_hash, channel, expires_at)
       VALUES (uuidv7(), responseId, businessId, tokenHash, 'email', NOW() + INTERVAL '48 hours')
     - The raw token is NEVER persisted — only the hash goes to Postgres
   - Construct approval URL: ${process.env.NEXT_PUBLIC_APP_URL}/approve/${rawToken}
   - Send email via sendApprovalEmail(). If Resend call FAILS: THROW so BullMQ retries. The approval link already exists in DB (idempotent — next retry will find it and skip link creation, but still needs to send the email). Actually NO — the idempotency check above will see the existing link and return. FIX: the idempotency check should be: if link exists AND notification_deliveries has a sent_at for this response. If link exists but no delivery record, the email was never sent — proceed to send.
   - CORRECTED idempotency logic:
     a. Check approval_links for existing unexpired link for this response → get linkId if exists
     b. Check notification_deliveries for existing sent delivery for this response → if exists, markOutboxCompleted(), return
     c. If no link exists: create approval link in transaction
     d. If link exists but no delivery: reuse the existing link's raw token... WAIT — we can't reconstruct the raw token from the hash. So if the link was created but email failed, we're stuck.
     e. SOLUTION: On retry, if an unexpired link exists but no delivery, REVOKE the old link and create a new one with a new token. This is safe because the old link was never emailed.
   - After successful email send:
     INSERT INTO notification_deliveries (id, business_id, response_id, channel, recipient, template, sent_at, external_message_id)
     VALUES (uuidv7(), businessId, responseId, 'email', ownerEmail, 'approval_request', NOW(), messageId)
   - markOutboxCompleted(outboxId)
   - The raw token exists only in memory during this function. NEVER log it, NEVER store it in outbox payloads.

3. Create worker/ingress/resend.ts — Resend delivery webhook handler:
   - Replace the placeholder in worker/index.ts: app.post('/ingress/resend', ...) with a real handler
   - Route MUST have { config: { rawBody: true } } (already configured in the placeholder)
   - Verify webhook signature using RESEND_WEBHOOK_SECRET and the raw body
     (Resend provides a svix-id, svix-timestamp, svix-signature headers — use the Resend SDK's webhook verification or manual HMAC verification)
   - Write to inbound_events for deduplication:
     INSERT INTO inbound_events (id, source, external_event_key, event_type, payload, status)
     VALUES (uuidv7(), 'resend', eventId, eventType, payload::jsonb, 'received')
     ON CONFLICT (external_event_key) DO NOTHING
   - If insert succeeded (not a duplicate), process the event:
     - email.delivered: UPDATE notification_deliveries SET delivered_at = NOW() WHERE external_message_id = $messageId
     - email.bounced: UPDATE notification_deliveries SET failed_at = NOW(), failure_reason = $reason WHERE external_message_id = $messageId
     - email.complained: same as bounced
   - Return 200 OK (even for duplicates — Resend expects 2xx)

4. Register worker in worker/index.ts (same pattern as previous prompts).

5. In production, point the Resend webhook to https://yourworker.railway.app/ingress/resend. Do NOT create a Vercel forwarding route.
```

**Prompt 12 — Approval flow (Days 10-11)**

Use **Playwright MCP** for E2E testing:
```
Build the complete approval system.

1. Create src/lib/approval/service.ts per .claude/skills/approval-security.md:
   - All methods receive a Postgres transaction client (tx) from the caller, NOT create their own. This lets callers compose multiple operations in the same transaction.

   - lockValidLink(tx, rawToken): FOR UPDATE on approval_links, validates:
     * token_hash matches SHA-256(rawToken)
     * consumed_at IS NULL (not already used)
     * revoked_at IS NULL (not revoked by regeneration)
     * expires_at > NOW() (not expired — MUST check on POST actions too, not just GET)
     Returns the link row or throws a typed error (ExpiredTokenError, RevokedTokenError, InvalidTokenError, ConsumedTokenError)

   - establishApprovalSession(tx, linkId, deviceCookieHash):
     * UPDATE approval_links SET device_cookie_hash = $hash WHERE id = $linkId AND device_cookie_hash IS NULL
     * If device_cookie_hash is already set and differs from the new hash: throw DeviceConflictError
     * Audit log: INSERT INTO approval_audit_log (id, response_id, business_id, action, device_cookie_hash, ip_address) using tx

   - approve(tx, linkId, deviceCookieHash):
     * Verify device_cookie_hash matches the link's bound device
     * UPDATE approval_links SET consumed_at = NOW() WHERE id = $linkId
     * UPDATE responses SET status = 'approved', approved_at = NOW(), approved_text = response_text WHERE id = link.response_id
     * Revoke ALL sibling links for the same response: UPDATE approval_links SET revoked_at = NOW() WHERE response_id = link.response_id AND id != $linkId AND consumed_at IS NULL
     * INSERT outbox entry topic='publish_response' with PublishResponsePayload { response_id, business_id }
     * Audit log

   - edit(tx, linkId, editedText, deviceCookieHash):
     * Same as approve, plus:
     * Compute Levenshtein edit_distance using fastest-levenshtein: distance(originalDraftText, editedText)
     * UPDATE responses SET status = 'edited', approved_at = NOW(), approved_text = editedText, edited_text = editedText, edit_distance = $distance

   - regenerate(tx, linkId, deviceCookieHash):
     * Verify device
     * UPDATE approval_links SET consumed_at = NOW() — consume the current link
     * Revoke ALL links for the same response (including consumed ones? No — only unclosed ones): UPDATE approval_links SET revoked_at = NOW() WHERE response_id = link.response_id AND consumed_at IS NULL AND id != $linkId
     * Read current response version: SELECT version FROM responses WHERE id = link.response_id
     * Mark OLD response as superseded: UPDATE responses SET status = 'superseded' WHERE id = link.response_id
     * INSERT outbox entry topic='generate_response' with GenerateResponsePayload { review_id: response.review_id, business_id, version: currentVersion + 1 }
     * Audit log
     * This triggers: ResponseGeneratorWorker → new response → NotificationWorker → new email with new link

   Error types to export: ExpiredTokenError, RevokedTokenError, InvalidTokenError, ConsumedTokenError, DeviceConflictError

2. Create src/lib/approval/cookies.ts:
   - Import { randomUUID, createHash, createHmac } from 'node:crypto'
   - DEVICE COOKIE:
     * setDeviceCookie(response: NextResponse): string — generates randomUUID(), HMAC-signs with SESSION_COOKIE_SECRET, sets cookie '__device' (Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=172800). Returns the cookie value.
     * getDeviceCookieHash(request: NextRequest): string | null — reads '__device' cookie, returns SHA-256(cookieValue) or null if not present
     * verifyDeviceCookie(request: NextRequest): boolean — reads cookie, verifies HMAC signature with SESSION_COOKIE_SECRET
   - CSRF (double-submit cookie pattern):
     * setCsrfCookie(response: NextResponse): string — generates randomUUID(), sets cookie '__csrf' (Secure; SameSite=Lax; Path=/; NOT HttpOnly). Returns the token.
     * validateCsrf(request: NextRequest): boolean — compares x-csrf-token header with __csrf cookie value

3. Create API routes — ALL under /api/approve/ (consistent base path):
   - GET /api/approve/[token]/route.ts:
     * Read-only. Hash the URL token, look up in approval_links → response → review → business
     * If valid: set device cookie + CSRF cookie, return { review, response, businessName }
     * Set Cache-Control: no-store, private
     * Rate limit: checkRateLimit(`approve:get:${ip}`, 10, 60) using src/lib/shared/rate-limit.ts
     * Error responses with specific messages: expired, revoked, invalid, consumed

   - POST /api/approve/[token]/session/route.ts:
     * Validate CSRF. Get device cookie hash.
     * sql.begin(tx => approvalService.establishApprovalSession(tx, linkId, deviceCookieHash))
     * Set Cache-Control: no-store, private

   - POST /api/approve/[token]/approve/route.ts:
     * Validate CSRF + device cookie
     * sql.begin(tx => { lockValidLink(tx, rawToken); approve(tx, linkId, deviceCookieHash) })
     * Return { success: true, message: "Response approved! We'll post it to Google shortly." }

   - POST /api/approve/[token]/edit/route.ts:
     * Same + parse editedText from body, validate non-empty
     * sql.begin(tx => { lockValidLink(tx, rawToken); edit(tx, linkId, editedText, deviceCookieHash) })

   - POST /api/approve/[token]/regenerate/route.ts:
     * sql.begin(tx => { lockValidLink(tx, rawToken); regenerate(tx, linkId, deviceCookieHash) })
     * Return { success: true, message: "Generating a new response — check your email in a few minutes." }

   ALL responses include Cache-Control: no-store, private.

4. Create src/app/(public)/approve/[token]/page.tsx:
   - Server component renders minimal shell:
     * Hash the token server-side, look up approval_links → responses → businesses.name
     * If invalid/expired: render error message directly (no client fetch needed)
     * If valid: render shell with business name + "Review a draft response" — NO review text in HTML
   - Client component (loaded via 'use client' child):
     * Fetch GET /api/approve/{token} via TanStack Query
     * POST /api/approve/{token}/session on mount (binds device cookie)
     * Display: review card (stars, reviewer, date, text), response text in editable textarea
     * Three buttons: Approve, Edit & Approve (saves textarea), Regenerate
     * Each button POSTs to the corresponding endpoint with x-csrf-token header
     * Shows success/error messages
     * Mobile-first layout

5. Write Playwright E2E tests:
   - Setup: create a test business + review + response + approval link directly in DB
   - Test: navigate to /approve/{rawToken} → see review + response → click Approve → success message
   - Test: navigate → edit response text → click Edit & Approve → success
   - Test: navigate to expired link → see "This link has expired"
   - Test: navigate → click Regenerate → see "check your email" message
   - Test: navigate to already-approved link → see "Already approved"
```

**Prompt 13 — Manual posting + AdminExceptionWorker (Days 12-13)**
```
Build the posting workflow for SerpAPI mode.

Job payload types from src/lib/shared/worker-types.ts:
  PublishResponsePayload: { response_id: string; business_id: string }
  NotifyAdminExceptionPayload: { review_exception_id: string; business_id: string }

PREREQUISITE: Add ADMIN_NOTIFICATION_EMAIL to .env.local and .env.example:
  ADMIN_NOTIFICATION_EMAIL=your-admin@email.com
  This is where manual posting instructions and exception alerts are sent.

1. Create worker/jobs/ResponsePublisherWorker.ts:
   - Consumes publish_response jobs
   - Read response + review + business from DB
   - Subscription guard: checkSubscription(status, updatedAt, 'publisher'). Skips cancelled and pending_payment. Allows past_due within grace (response was already approved).
   - UPDATE responses SET status = 'awaiting_manual_post' WHERE id = $responseId
   - Determine admin email: query users WHERE role IN ('admin', 'sales_partner') AND business_id = businessId or fall back to ADMIN_NOTIFICATION_EMAIL env var
   - Send internal email via Resend (or mock in mock mode):
     - To: admin/sales partner email
     - Subject: "Manual post needed: {businessName}"
     - Body: business name, reviewer name + rating, approved response text (the approved_text from response row), Google Maps URL (construct from business.google_place_id)
     - Instructions: "Copy the response below and paste it as an owner reply on Google Maps."
   - markOutboxCompleted(outboxId)
   - If email fails: THROW for BullMQ retry (response is already awaiting_manual_post, so retry is safe)

2. Create worker/jobs/AdminExceptionWorker.ts:
   - Consumes notify_admin_review_exception jobs
   - Read exception from DB:
     SELECT re.*, r.reviewer_name, r.star_rating, b.name as business_name
     FROM review_exceptions re
     JOIN reviews r ON re.review_id = r.id
     JOIN businesses b ON re.business_id = b.id
     WHERE re.id = $exceptionId
   - If exception is already resolved (status != 'open'): markOutboxCompleted(), return
   - Send email to ADMIN_NOTIFICATION_EMAIL:
     - Subject: "Review exception: {businessName} — {exception.type}"
     - Body: explain what happened (review was edited after response was posted), include original review text and new review text from exception payload
   - markOutboxCompleted(outboxId)

3. Build minimal admin business detail page at src/app/admin/businesses/[id]/page.tsx:
   (This replaces the placeholder. Full admin dashboard is Sprint 3, but we need this for the manual posting workflow to be testable.)
   - Server component that reads business + responses from DB
   - Show: business name, subscription status, google_place_id
   - Section: "Awaiting Manual Post" — list responses with status = 'awaiting_manual_post':
     - Reviewer name, star rating, approved response text
     - "Copy to Clipboard" button (copies approved_text)
     - "Mark as Posted" button → calls POST /api/admin/businesses/[id]/mark-posted with response_id
   - Create API route POST /api/admin/businesses/[id]/mark-posted:
     - Protected by middleware (admin auth)
     - Updates: UPDATE responses SET status = 'posted', posted_at = NOW() WHERE id = $responseId AND business_id = $businessId AND status = 'awaiting_manual_post'
     - Returns 200 on success

4. Register both workers in worker/index.ts (same pattern as previous prompts).

5. End-to-end verification (manual, not automated):
   - In mock mode: manually insert a business (active) + outbox entry for sync_reviews
   - Watch: ReviewSyncWorker processes → generates response → NotificationWorker sends email (or logs in mock mode) → open approval link → approve → ResponsePublisherWorker sends manual-post email → admin page shows "Awaiting Manual Post" → click "Mark as Posted"
   - Verify all status transitions in the DB: review new → response pending_approval → approved → awaiting_manual_post → posted
   - For real SerpAPI test: set MOCK_EXTERNAL_APIS=false, use a real Google Maps place ID, and verify the full flow with real API calls
```

### Sprint 2 done when
- [ ] Shared utilities: subscription guard, outbox helpers, sanitizer, rate limiter, mock monitor, voice learning, worker types — all tested
- [ ] OutboxPoller watchdog recovers stale dispatched entries (> 1 hour)
- [ ] ReconciliationPoller creates sync_reviews outbox entries every 60 minutes for active businesses (with dedup guard)
- [ ] Reviews polled via SerpAPI (or mock) and upserted with dedup (identity + content hash)
- [ ] New reviews trigger response generation automatically
- [ ] Cost circuit breaker works (per-business + global daily limits, concurrency, regen budget)
- [ ] Avoid-facts guardrail checks generated responses and retries once if violated
- [ ] Voice learning returns few-shot examples when ≥ 5 edited+posted responses exist
- [ ] Email notifications sent with approval links (delivery tracked via Resend webhooks)
- [ ] Approval tokens stored as SHA-256 hashes only — raw tokens never in Postgres, outbox payloads, or logs
- [ ] Approval page works on mobile: approve, edit (with Levenshtein distance), regenerate
- [ ] Regeneration chain works end-to-end: old response superseded → new generated → new email → new link
- [ ] Owner sees "we'll post it shortly" — manual posting invisible to them
- [ ] Admin business detail page shows awaiting-manual-post responses with copy + mark-as-posted buttons
- [ ] Review edit detection: edited reviews trigger regeneration (pending) or admin exception (posted)
- [ ] Mock mode works for all workers (no real API calls in local development)
- [ ] All workers register in worker/index.ts with graceful shutdown
- [ ] E2E approval flow tests pass in Playwright

---

## Sprint 3: Admin Dashboard + Payments + Security (Days 14–19)

### Sprint 3 Architecture Review Overrides

If any prompt below conflicts with these rules, these rules win:

- **Sprint 2 already implemented these — do NOT rebuild:** approval route rate limiting (3/token/min + 10/IP/min GET), CSRF double-submit pattern, approval_audit_log, input sanitization (sanitizeText + escapeHtml), Resend webhook signature verification. These are listed here so prompts don't duplicate work.
- **Extend, don't replace, existing pages.** The business detail page at `src/app/admin/businesses/[id]/page.tsx` already has manual posting UI from Sprint 2 Prompt 13. Sprint 3 adds profile editing and review lists ON TOP of the existing code.
- **Admin routes use `admin/` (real route segment), not `(admin)/` (route group).** Sprint 1 audit changed this — all admin pages are at `/admin/*` in the URL.
- **Payment Links first, not Checkout Sessions.** The onboarding form creates a `businesses` row with `subscription_status='pending_payment'` and returns a tier-specific Stripe Payment Link containing `client_reference_id={business_id}`. Do NOT pre-create a Stripe customer for Payment Links; the Stripe webhook writes `stripe_customer_id` and `stripe_subscription_id` from the completed Checkout Session after payment.
- **Owner login is not on the MVP critical path.** Approval remains token-based and notification-first. Create the owner `users` row during onboarding, but do not invite/create a Supabase Auth account for the owner unless the owner dashboard is intentionally enabled later. Admin and sales_partner Auth accounts are required in Sprint 3.

### Claude Code prompts

**Prompt 14a — Supabase Auth + middleware + login (Day 14)**
```
Replace the stopgap API key auth with Supabase Auth.

PREREQUISITES (manual, before coding):
- Enable email/password provider in Supabase dashboard (Authentication → Providers)
- Create admin + sales_partner auth accounts via Supabase dashboard (Authentication → Users → Add User)
- Run seed SQL to link them:
    UPDATE users SET auth_id = '<auth-user-uuid>' WHERE email = 'norbertesekiel@gmail.com';
    UPDATE users SET auth_id = '<auth-user-uuid>' WHERE email = 'norbertliverpoolgmail.com';

Install: pnpm add @supabase/ssr

1. Create src/lib/db/auth.ts — server-side auth helpers:
   - getCurrentUser(request: NextRequest): reads Supabase session from cookies via @supabase/ssr, queries users table by auth_id to get role + business_id. Returns { user, role, businessId } or null.
   - requireAuth(request): calls getCurrentUser, throws 401 if null
   - requireRole(request, ...roles): calls getCurrentUser, throws 403 if role not in allowed list
   - Identity mapping: auth.users.id → users.auth_id. The users table is the source of truth for role and business scope.

2. Rewrite src/middleware.ts — replace API key auth with Supabase Auth:
   - Use @supabase/ssr createServerClient() for cookie-based session in middleware
   - /admin/* routes: require role = 'admin' or 'sales_partner'
   - /dashboard/* and /settings/* routes: require role = 'owner' and non-null business_id. Do NOT put `(authenticated)` in middleware matchers — route groups are not URL paths.
   - /(public)/* route group pages and /api/approve/* routes: no auth required (token-based approval flow)
   - /api/admin/* routes: require admin/sales_partner role
   - Unauthenticated → redirect to /admin/login (pages) or 401 (API)
   - Keep matchers explicit: /admin/:path*, /api/admin/:path*, /dashboard/:path*, /settings/:path*. Avoid matching /api/approve/*.

3. Rewrite src/app/admin/login/page.tsx — Supabase Auth login:
   - Email + password form using supabaseClient.auth.signInWithPassword()
   - Redirect to /admin/overview on success
   - Error handling for invalid credentials
   - Remove the old API key validation flow
   - Remove src/app/api/admin/auth/route.ts (no longer needed)

4. Create src/app/api/auth/callback/route.ts — Supabase auth callback:
   - Handles the auth code exchange for cookie-based sessions
   - Required by @supabase/ssr for server-side auth

5. Update src/lib/db/browser.ts — add auth-aware browser client:
   - Export createBrowserSupabaseClient() that uses @supabase/ssr for auth state management
   - Used by client components that need the current user session

Split Supabase clients explicitly:
- Browser: NEXT_PUBLIC_SUPABASE_URL + NEXT_PUBLIC_SUPABASE_ANON_KEY (auth + real-time)
- Server/worker: SUPABASE_URL + SUPABASE_SERVICE_KEY (admin operations)
- Never import service-role client into browser code

RLS decision for Sprint 3:
- Browser clients only manage auth state and should not query business/review/response tables directly.
- Admin data access goes through server API routes that call requireRole() and then query with the server DB client.
- Add the minimal RLS policy needed for middleware/user lookup: authenticated users can SELECT their own users row where users.auth_id = auth.uid()::text. If auth_id remains VARCHAR, cast auth.uid() to text. Do not add broad owner-readable policies yet.
- Every /api/admin/* route must call requireRole(request, 'admin', 'sales_partner') even though middleware also protects the route. Middleware is a coarse gate; route handlers are the authorization boundary.

Verify: login works with Supabase credentials, admin pages are protected, public pages (demo viewer, approval page) work without auth, approval token-based flow is unaffected.
```

**Prompt 14b — Admin read-only pages: overview, costs, notifications, jobs (Day 14-15)**
```
Build the 4 read-only admin pages that replace placeholders. Each page needs a corresponding API route for data fetching.

All pages: use TanStack Query for client-side fetching, Tailwind for styling, pagination from the start (offset + limit params). Auth is already enforced by middleware from Prompt 14a.

1. Replace src/app/admin/overview/page.tsx — sales partner CRM (the "single screen"):
   - System health bar at top: pending outbox count, failed jobs count, today's total API cost, notification failures in last 24h
   - Business table below: name, subscription status, pending approval count, response rate (%), avg response time (hours), last activity timestamp
   - Sort by pending approval count (most urgent first)
   - Click any row → /admin/businesses/[id]
   - TanStack Query with 30-second polling interval for real-time feel
   - Create API: GET /api/admin/overview at src/app/api/admin/overview/route.ts
     - Aggregation queries across businesses, responses, job_outbox, notification_deliveries, api_costs
     - Return: { systemHealth: {...}, businesses: [...] }

2. Replace src/app/admin/costs/page.tsx — cost monitoring:
   - Cost breakdown by provider (openai, anthropic, serpapi), by business, by day
   - Businesses exceeding 80% of daily threshold highlighted in red
   - Today's total platform spend vs global daily limit (progress bar)
   - Date range filter (last 7/30/90 days)
   - Create API: GET /api/admin/costs at src/app/api/admin/costs/route.ts
     - Query api_costs table with GROUP BY provider, business_id, date
     - Accept ?days=7 query param

3. Replace src/app/admin/notifications/page.tsx — delivery log:
   - Table: business name, channel, recipient, template, sent_at, delivered_at, failed_at, failure_reason
   - Filter by: business (dropdown), channel (email/sms), status (delivered/failed/pending)
   - Pagination: 20 rows per page
   - Create API: GET /api/admin/notifications at src/app/api/admin/notifications/route.ts
     - Join notification_deliveries with businesses for business name
     - Accept ?business_id, ?channel, ?status, ?limit, ?offset query params

4. Replace src/app/admin/jobs/page.tsx — outbox + queue health:
   - Summary cards: pending count, dispatched count, failed count, completed today count
   - Queue depth cards per BullMQ queue: waiting, active, delayed, failed. Use Queue.getJobCounts() with Queue instances only; do not instantiate Workers from a Vercel API route.
   - Failed jobs table: id, topic, last_error, attempts, created_at
   - Pagination on failed jobs list
   - Create API: GET /api/admin/jobs at src/app/api/admin/jobs/route.ts
     - Aggregate counts from job_outbox by status
     - Return failed entries with error details
     - Also return BullMQ queue counts. If Redis is unavailable, return outbox counts plus queueHealth: { unavailable: true } instead of failing the whole page.

Verify: all 4 pages render real data from Supabase, filters work, pagination works, 30-second auto-refresh works on overview.
```

**Prompt 14c — Business onboarding + detail page upgrade (Day 15)**
```
Build the business onboarding form and upgrade the existing business detail page.

1. Create src/app/admin/businesses/new/page.tsx — onboarding form:
   - Fields: business name, category, Google Maps URL (auto-parse Place ID via extractPlaceId() from src/lib/reviews/url-parser.ts), owner name, email, phone, notification preference (email default)
   - Tone: dropdown with options (warm/casual, professional/friendly, professional/reassuring, etc.)
   - Products/services: free text textarea
   - Staff names: comma-separated input
   - Highlight facts: textarea (things to always mention)
   - Avoid facts: textarea (things to never mention)
   - Sample responses: textarea (paste 2-3 examples)
   - Subscription tier: radio buttons (Founding $99/mo, Standard $149/mo)
   - Use react-hook-form + Zod validation for all inputs
   - On submit: POST /api/admin/businesses →
     a. Create businesses row (subscription_status='pending_payment', parse arrays for staff_names/highlight_facts/avoid_facts/sample_responses)
     b. Create users row (role='owner', business_id=<new business id>, email from form, auth_id=NULL). Do not send an owner Auth invite in MVP unless dashboard access is explicitly turned on.
     c. Write ONE sync_reviews outbox entry for immediate initial sync (this one-time sync is allowed before payment — gives the customer a "wow" moment during the sales call)
     d. Redirect to /admin/businesses/[id]
   - The onboarding form does NOT create a Stripe customer. Prompt 15 returns a tier-specific Payment Link URL with client_reference_id={business_id}; Stripe creates/returns the customer during checkout.
   - ROI baseline is NOT captured here — ReviewSyncWorker handles it automatically on first sync when baseline_captured_at IS NULL

2. Replace src/app/admin/businesses/page.tsx — business list:
   - Table: name, category, subscription status, last sync, pending approval count
   - Click row → /admin/businesses/[id]
   - "Add Business" button → /admin/businesses/new
   - Pagination (20 per page)
   - Create API: GET /api/admin/businesses at src/app/api/admin/businesses/route.ts
     - Join businesses with response counts
     - Accept ?limit, ?offset query params

3. EXTEND src/app/admin/businesses/[id]/page.tsx — add to existing manual-post page:
   The page already has the "Awaiting Manual Post" section with copy + mark-as-posted from Sprint 2 Prompt 13. ADD these sections above it:
   - Business profile section (inline editable via PATCH API): name, category, tone, products_services, staff_names, highlight_facts, avoid_facts
   - Review list: all reviews for this business with color-coded response status badges (new=gray, pending_approval=yellow, approved=blue, awaiting_manual_post=orange, posted=green, failed=red)
   - Keep the existing ManualPostSection component and "Awaiting Manual Post" section unchanged
   - Create API: GET /api/admin/businesses/[id] at src/app/api/admin/businesses/[id]/route.ts (returns business + reviews + responses)
   - Create API: PATCH /api/admin/businesses/[id] at same route file (updates business settings, Zod-validated)

Verify: onboard a test business via the form, see it in the business list, see initial sync trigger in worker logs, edit business settings inline, view reviews with color-coded statuses.
```

**Prompt 15 — Stripe integration (Day 16)**
```
Integrate Stripe payments. This connects the business onboarding flow to the payment lifecycle that unlocks recurring review polling.

PREREQUISITES (manual):
- Create two Stripe Payment Links in Stripe dashboard: Founding ($99/mo), Standard ($149/mo)
- Note the link format: https://buy.stripe.com/XXXXX?client_reference_id={business_id}
- Create a Stripe webhook endpoint pointing to your Railway worker URL
- Store the two base Payment Link URLs in env/config, e.g. STRIPE_PAYMENT_LINK_FOUNDING and STRIPE_PAYMENT_LINK_STANDARD. The app appends client_reference_id and optionally prefilled_email.
- Configure Stripe price/product IDs in env/config for tier mapping, e.g. STRIPE_PRICE_FOUNDING, STRIPE_PRICE_STANDARD. Do not infer subscription_tier from product display names.

1. Replace worker/ingress/stripe.ts (currently a placeholder):
   - Import Stripe SDK: import Stripe from 'stripe'
   - Verify webhook signature: stripe.webhooks.constructEvent(rawBody, sig, STRIPE_WEBHOOK_SECRET)
   - Must use rawBody from Fastify's rawBody field (already configured with { config: { rawBody: true } })
   - Write to inbound_events for deduplication (same pattern as Resend handler):
     INSERT INTO inbound_events (id, source, external_event_key, event_type, payload, status)
     VALUES (uuidv7(), 'stripe', stripeEventId, eventType, payload::jsonb, 'received')
     ON CONFLICT (external_event_key) DO NOTHING
   - Idempotency rule:
     - Invalid/missing Stripe signature: return 401, do not write inbound_events.
     - Existing inbound_event with status='processed': return 200 duplicate.
     - Existing inbound_event with status='received' or 'failed': retry processing instead of ignoring it.
     - If processing fails after a valid signature, mark inbound_events.status='failed', store error_message, and return 500 so Stripe retries.
   - Handle events:
     - checkout.session.completed: extract client_reference_id (= business_id) from the session object. As fallback only, use session.metadata.business_id if configured. UPDATE businesses SET subscription_status='active', stripe_customer_id = session.customer, stripe_subscription_id = session.subscription WHERE id = business_id. This is the transition from pending_payment that unlocks recurring polling by ReconciliationPoller.
     - invoice.payment_failed: find business by stripe_customer_id, UPDATE subscription_status='past_due'
     - invoice.paid: find business by stripe_customer_id, if subscription_status='past_due' then UPDATE to 'active' (grace period recovery)
     - customer.subscription.deleted: find business by stripe_customer_id, UPDATE subscription_status='cancelled'
     - customer.subscription.updated: find business by stripe_customer_id, map Stripe price ID to subscription_tier using config/env, then UPDATE subscription_tier if changed
   - Mark inbound_events as 'processed' on success
   - Return 200 for successfully processed events and already-processed duplicates only

2. Wire into worker/index.ts:
   - Import handleStripeWebhook from './ingress/stripe'
   - Replace the stripe placeholder route: app.post('/ingress/stripe', { config: { rawBody: true } }, handleStripeWebhook)

3. Update onboarding API (POST /api/admin/businesses from Prompt 14c):
   - Do NOT create a Stripe customer when using Payment Links. Stripe returns session.customer in checkout.session.completed.
   - Build the Payment Link URL from the selected tier:
     const url = new URL(paymentLinkForTier(subscriptionTier))
     url.searchParams.set('client_reference_id', businessId)
     url.searchParams.set('prefilled_email', ownerEmail)
   - Return this URL in the API response so the sales partner can copy and send it to the business owner.
   - Keep businesses.subscription_status='pending_payment' until checkout.session.completed arrives.

4. Point Stripe webhook to Railway: https://yourworker.railway.app/ingress/stripe
   Do NOT create a Vercel forwarding route — webhooks terminate on Railway directly per architecture invariant.

Verify: create a test business via onboarding form, copy the Payment Link, complete checkout in Stripe test mode, verify webhook fires in worker logs, verify subscription_status transitions to 'active' in DB, verify ReconciliationPoller starts picking up the business for sync.
```

**Prompt 16 — Sentry + security headers + remaining hardening (Days 17-18)**

Sprint 2 already implemented: approval route rate limiting, CSRF, audit logging, input sanitization, Resend webhook verification. This prompt covers only what's NEW.

```
Add error tracking, security headers, and remaining hardening items.

Install: pnpm add @sentry/nextjs @sentry/node

1. Sentry error tracking:
   - Initialize in Next.js: create sentry.client.config.ts, sentry.server.config.ts, sentry.edge.config.ts following @sentry/nextjs setup guide
   - Initialize in Railway worker: load worker/env first, then call Sentry.init() before constructing the Fastify app or BullMQ Workers
   - Configure beforeSend hook to scrub sensitive values: strip any key containing 'key', 'secret', 'token', 'password' from error payloads. This catches OPENAI_API_KEY, SERPAPI_API_KEY, STRIPE_SECRET_KEY, raw approval tokens, webhook secrets, and session secrets.
   - Set up source maps upload for readable stack traces in production
   - Add Sentry breadcrumbs in OutboxPoller (on dispatch success/failure) and in each worker (on job start/complete/fail)
   - Add SENTRY_DSN to .env.example and .env.local

2. Security headers in next.config.mjs:
   Add a headers() function returning:
   - Strict-Transport-Security: max-age=63072000; includeSubDomains (Vercel serves HTTPS but doesn't set HSTS by default on custom domains)
   - Content-Security-Policy. Start with a practical MVP policy that does not break Next.js/Supabase/Sentry:
     default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' https://*.supabase.co https://*.sentry.io https://o*.ingest.sentry.io; frame-ancestors 'none'; base-uri 'self'; form-action 'self'
     In local development, relax as needed for Next dev tooling. If this blocks production scripts, ship it as Content-Security-Policy-Report-Only first and tighten before customer #10.
   - X-Content-Type-Options: nosniff
   - X-Frame-Options: DENY
   Also set Strict-Transport-Security and X-Content-Type-Options on Fastify server responses in worker/index.ts for ingress endpoints.

3. Rate limit on demo generation:
   - Add a global daily limit to POST /api/admin/demos/generate: checkRateLimit('demo:generate:daily', 50, 86400)
   - Also add a short-window guard by admin user or IP, e.g. demo:generate:minute:{userOrIp}, 5/minute
   - This endpoint is admin-authenticated, but it is still cost-sensitive because it triggers SerpAPI + multi-review LLM generation.

4. Zod validation schemas for business settings:
   - Create src/lib/shared/schemas.ts with Zod schemas for: business name, category, tone, owner email/phone, staff_names array, highlight_facts array, avoid_facts array
   - Apply in POST /api/admin/businesses (onboarding) and PATCH /api/admin/businesses/:id (settings update) from Prompt 14c
   - Reject invalid inputs with 400 + descriptive error messages

Items already done in Sprint 2 (do NOT rebuild):
- Approval route rate limiting (3/token/min on POST, 10/IP/min on GET) ✅
- CSRF double-submit pattern on all approval POST routes ✅
- Approval actions audit-logged to approval_audit_log table ✅
- Input sanitization: sanitizeText() for control chars, escapeHtml() for email templates ✅
- Resend webhook signature verification ✅
- Regeneration budget (max 3/review/day via Redis) ✅

Verify: trigger a test error from both Vercel and Railway → appears in Sentry dashboard. Check security headers in browser DevTools Network tab. Try generating 51 demos → 429 on the 51st. Submit invalid business settings → 400 with Zod error.
```

### Sprint 3 done when
- [ ] Supabase Auth configured: admin and sales_partner roles enforced; owner route guard exists, with owner Auth invitation deferred unless dashboard access is intentionally enabled
- [ ] Stopgap API key auth removed, replaced by Supabase session-based auth
- [ ] Minimal users self-lookup RLS policy exists; browser clients do not query business/review/response tables directly
- [ ] Sales partner can onboard clients in under 5 minutes via /admin/businesses/new
- [ ] Admin overview shows all businesses with health indicators + system health bar
- [ ] Admin costs page shows per-business and per-provider cost breakdown
- [ ] Admin notifications page shows delivery log with filters and pagination
- [ ] Admin jobs page shows outbox + queue health with failed job details
- [ ] Business detail page shows reviews with color-coded status + inline editable settings
- [ ] Business list page with pagination
- [ ] Stripe payments work end-to-end: onboard -> Payment Link with client_reference_id -> Railway webhook -> active
- [ ] Stripe webhook retries are safe: invalid signatures rejected, processed duplicates ignored, failed received events can be reprocessed
- [ ] ReconciliationPoller starts polling after Stripe activates subscription
- [ ] Sentry capturing errors from both Vercel and Railway
- [ ] Security headers (HSTS, CSP, X-Frame-Options, nosniff) on all responses
- [ ] Demo generation rate-limited to 50/day
- [ ] All admin list views have pagination
- [ ] Zod validation on business onboarding and settings update inputs

---

## Sprint 4: Production Hardening (Weeks 5–6)

### Sprint 4 Architecture Review — Trimmed Scope

The original Sprint 4 included correlation IDs, PostHog analytics, and k6 load testing. These are deferred to Sprint 6 (scale to $1K MRR) because:
- **Correlation IDs**: At 10 businesses, Sentry breadcrumbs + `[WorkerName]` log prefixes are sufficient. Add when debugging cross-service issues becomes genuinely hard.
- **PostHog**: Zero paying customers = zero analytics value. Add after customer #5.
- **k6/Artillery load testing**: 10 businesses × 10 reviews/month = ~100 reviews/month. Load testing at 10x adds complexity without proportional safety. Add at Sprint 6.

What remains is what actually prevents production failures: notification failover, weekly summaries, table archival, security tests, and the deferred Playwright E2E tests.

**Architecture override**: The original prompts specified BullMQ repeatable jobs for notification failover and weekly summary scheduling. This violates the transactional outbox invariant — if the worker crashes mid-check, there's no outbox recovery. Use `setInterval` pollers (same pattern as ReconciliationPoller) that query the DB and create outbox entries instead.

### Claude Code prompts

**Prompt 17 — Monitoring + weekly summaries + archival**
```
Build production hardening features that ensure the system runs 10 businesses with zero engineering intervention.

1. Notification failover poller:
   - Use setInterval (same pattern as ReconciliationPoller, NOT BullMQ repeatable job — must follow the outbox pattern)
   - Interval: 2 hours (configurable via NOTIFICATION_FAILOVER_INTERVAL_MS)
   - Re-entrancy guard: isPolling flag (same as OutboxPoller/ReconciliationPoller)
   - Query: find responses in 'pending_approval' for >4 hours that have NO successful notification_delivery row (`delivered_at IS NOT NULL`) and no in-flight `send_notification` outbox entry (`status IN ('pending', 'dispatched')`)
   - Extend `SendNotificationPayload` with optional failover fields: `failover?: { reason: 'stale_no_delivery' | 'all_deliveries_failed' }`
   - Modify `NotificationWorker` so normal retry idempotency remains unchanged, but failover payloads do NOT skip merely because an old `notification_deliveries.sent_at` row exists. In failover mode:
     1. Re-check the response is still `pending_approval` and the business subscription still allows notifications.
     2. If an approval email has already been delivered (`delivered_at IS NOT NULL`), mark the outbox completed and do nothing.
     3. Revoke all open, unconsumed approval links for the response because the raw token cannot be recovered.
     4. Create a fresh approval link/token, send a fresh email, record a new `notification_deliveries` row, and mark the failover outbox completed.
   - For each stale response: insert a new `send_notification` outbox entry with `{ response_id, business_id, failover: { reason: 'stale_no_delivery' } }`
   - Also find responses where ALL approval-request deliveries have `failed_at` set (bounced/complained). Insert a failover `send_notification` outbox entry with `reason: 'all_deliveries_failed'`, and alert admin via `sendInternalEmail`.
   - Deduplicate admin alerts: before sending the admin alert, check no `notification_deliveries` row exists for that response with `template = 'admin_exception'`, the same admin recipient, and `created_at > NOW() - INTERVAL '24 hours'`. After sending, record a `notification_deliveries` row so the next poll does not spam the admin.
   - Export startNotificationFailoverPoller() / stopNotificationFailoverPoller()
   - Register in worker/index.ts lifecycle (start after other pollers, stop in shutdown)
   - Reuse `SendNotificationPayload` after adding the optional failover field above

2. Weekly summary scheduler + worker:
   - WeeklySummaryScheduler: setInterval poller (same pattern as ReconciliationPoller, NOT BullMQ cron)
   - Interval: runs every hour, checks if it's Monday between 8-9 AM UTC
   - Timezone: use UTC for MVP. Store as a constant `WEEKLY_SUMMARY_TIMEZONE = 'UTC'`. When businesses span time zones, add a `timezone` column — but NOT now.
   - IMPORTANT: Monday 8-9 AM sends the summary for the week that just ended, not the empty week that just started. Compute `week_start_date` as the previous Monday 00:00 UTC and query `[week_start_date, week_start_date + 7 days)`.
   - For each active/past_due business (skip cancelled + pending_payment): schedule a `weekly_summary` outbox entry when there is no existing `weekly_summaries` row for that business/week OR the row exists but `sent_at IS NULL`. Do not schedule when `sent_at IS NOT NULL`.
   - Also check for an in-flight `weekly_summary` outbox entry for that same `business_id` and `week_start_date` payload before inserting a new outbox entry.
   - WeeklySummaryWorker (replace placeholder in worker/jobs/WeeklySummaryWorker.ts):
     - Consumes weekly_summary jobs
     - Subscription guard (workerType 'summary'): skip cancelled + pending_payment
     - Query: count reviews this week, count responses (posted/approved/edited), find 1-2 star reviews with text
     - Insert or update the `weekly_summaries` row before sending using this pattern: `INSERT INTO weekly_summaries (...) VALUES (...) ON CONFLICT (business_id, week_start_date) DO UPDATE SET total_reviews = EXCLUDED.total_reviews, total_responded = EXCLUDED.total_responded, notable_reviews = EXCLUDED.notable_reviews WHERE weekly_summaries.sent_at IS NULL RETURNING sent_at`
     - If the existing row already has `sent_at IS NOT NULL`, mark the outbox completed and return without sending. This prevents duplicate emails from replayed outbox jobs.
     - Build HTML email: business name, week dates, review count, response count, response rate %, list of negative reviews needing attention
     - Send via sendInternalEmail to business.owner_email
     - Update weekly_summaries.sent_at on success
     - markOutboxCompleted on all paths
   - Register worker + scheduler in worker/index.ts

3. Outbox + event archival poller:
   - ArchivalPoller: setInterval, runs every 24 hours (configurable via ARCHIVAL_INTERVAL_MS)
   - Re-entrancy guard
   - Three DELETE queries (not soft-delete — this is cleanup):
     a. DELETE FROM job_outbox WHERE status = 'completed' AND completed_at < NOW() - INTERVAL '7 days'
     b. DELETE FROM inbound_events WHERE status = 'processed' AND processed_at < NOW() - INTERVAL '30 days'
     c. DELETE FROM prospect_demos WHERE expires_at < NOW() - INTERVAL '30 days' AND generation_status = 'completed'
   - Log counts for each deletion
   - Export startArchivalPoller() / stopArchivalPoller()
   - Register in worker/index.ts

Write tests for: WeeklySummaryWorker (active business gets summary, cancelled skipped, duplicate week skipped), notification failover (stale response triggers new outbox entry, all-failed triggers admin alert).
```

**Prompt 18 — Security tests + E2E approval tests**
```
Write tests that verify security properties and the end-to-end approval flow.

1. Security tests (Vitest — src/lib/shared/__tests__/security.test.ts):
   These verify that existing security mechanisms work correctly. No new features — just test coverage. Do NOT add placeholder tests such as `expect(true).toBe(true)`, and do NOT change production behavior just to satisfy an inaccurate test.

   - Prompt injection / XSS boundary:
     * `sanitizeText()` is prompt/input sanitization, not HTML rendering. It strips control characters and collapses whitespace; it currently does NOT strip semantic text or HTML tags.
     * Test `sanitizeText()` with control characters plus prompt-injection phrasing and assert it strips control characters without crashing.
     * Test `escapeHtml()` separately with `<script>alert(1)</script>` and assert rendered output escapes `<`, `>`, and quotes. Do NOT force `sanitizeText()` to become an HTML sanitizer.
   - Cost amplification: mock Redis to simulate the 4th regeneration attempt on the same review and verify `checkRegenBudget()` throws `RegenBudgetExceededError`. Match the current implementation: mock `getCacheRedis()` with `incr`, `expire`, and `decr` methods, not `eval`.
   - Token enumeration: verify approval_links stores SHA-256 hash only — call createHash('sha256').update(rawToken).digest('hex') and confirm it matches what lockValidLink expects
   - Webhook replay: add a real DB-backed integration test only if the test suite has a dedicated test database configured. Insert an inbound_event with `status='processed'`, attempt to insert the same `external_event_key` with `ON CONFLICT DO NOTHING`, and verify affected row count is 0. If no dedicated test DB exists, extend the existing Stripe/Resend webhook unit tests instead of adding a fake placeholder.
   - Expired token: extend `src/lib/approval/__tests__/service.test.ts` if needed; it already tests `lockValidLink()` variants. Verify a past `expires_at` throws `ExpiredTokenError`.
   - Device hijack: extend `src/lib/approval/__tests__/service.test.ts` if needed. Establish session with `device_cookie_hash_A`, then attempt an action with `device_cookie_hash_B` and verify `DeviceConflictError`.
   - Subscription bypass: call checkSubscription with 'cancelled' + workerType 'notification' → verify {allowed: false}

2. Playwright E2E approval flow tests (e2e/approval.spec.ts):
   Replace the skipped scaffolded tests with working E2E tests.

   Hard safety requirements:
   - These tests perform destructive cleanup. Use `TEST_DATABASE_POOL_URL` for E2E seed/cleanup. Do NOT point E2E cleanup at production or staging `DATABASE_POOL_URL`.
   - The seed helper must fail fast unless `TEST_DATABASE_POOL_URL` is set and `NODE_ENV === 'test'` or `ALLOW_E2E_DB_WRITES === 'true'`.
   - Seed data must be unique per test and per Playwright project because `playwright.config.ts` runs desktop and mobile projects and `fullyParallel: true`.
   - Use `provider_review_name = 'test://review/{reviewId}'` and `provider_location_name = 'test://location/{businessId}'`; never use constant provider identity values.
   - Cleanup must delete outbox rows by all affected aggregate IDs (`responseId`, `reviewId`, `businessId`) and by JSON payload `business_id`, then delete audit logs, approval links, notification deliveries, responses, reviews, and the business.

   PREREQUISITE: Create a test seed script at e2e/seed.ts that:
   - Creates a test business (subscription_status='active')
   - Creates a test review
   - Creates a test response (status='pending_approval')
   - Creates an approval_link with a known raw token (hash stored in DB, raw token returned for test use)
   - Exports helpers: `seedApprovalFlow()`, `cleanupApprovalFlow(seedData)`, `getResponse(responseId)`, and `getOutboxEntriesForBusiness(businessId)`
   - Returns `{ businessId, reviewId, responseId, rawToken, approvalLinkId }`

   Test scenarios:
   a. Happy path approve: navigate to /approve/{rawToken} → wait for the approval buttons to render (session binding happens automatically in the current UI; do not add a fake "session bind" click) → click Approve → see success message → verify response status='approved' and `approved_text=response_text` in DB
   b. Edit flow: navigate → click Edit → edit textarea → click Save & Approve → verify `status='edited'`, `edited_text` stored, and `edit_distance > 0`
   c. Expired token: seed with expires_at in past → navigate → see "expired" error message
   d. Regenerate: navigate → click Regenerate → see "generating new response" or "check your email" message → verify old response `status='superseded'` and a new `generate_response` outbox entry exists for the review/business
   e. Already consumed: seed with consumed_at set → navigate → see "already used" message

   Each test should use local seed data inside the test body or a per-test fixture. Do not use a shared module-level `let data` because Playwright can run tests in parallel. Cleanup must run in `finally` so a failed assertion does not leave rows behind.
   Use the Playwright webServer config to start `pnpm dev` automatically.

3. Integration tests (Vitest — worker/__tests__/integration.test.ts):
   Test the full pipeline with mocked external APIs but real DB queries only against a dedicated test database. Never use production/staging `DATABASE_POOL_URL` for destructive test setup.

   - Idempotency: insert a response, call handleResponseGeneration twice with same payload → verify only 1 response exists (not 2)
   - LLM failover: mock OpenAI to throw, verify Anthropic fallback produces a response
   - Outbox completion: for each Sprint 4 worker path, assert the originating outbox entry transitions to `completed` or `failed` on every handled branch. Do not attempt a vague "every worker path" meta-test; add targeted cases for WeeklySummaryWorker, NotificationFailoverPoller-created send_notification jobs, and existing workers only where coverage is missing.
```

### Sprint 4 done when
- [ ] Notification failover alerts admin when approval emails aren't delivered after 4 hours
- [ ] Weekly summaries sent Monday mornings for all active businesses
- [ ] Outbox archival deletes completed entries >7 days, processed events >30 days, expired demos >30 days
- [ ] Security tests pass for all 7 attack vectors
- [ ] Playwright E2E approval tests pass (5 scenarios)
- [ ] Integration tests verify idempotency + LLM failover
- [ ] System runs 10 businesses with zero engineering intervention

### Deferred to Sprint 6
- [ ] Correlation IDs (cross-service tracing)
- [ ] PostHog analytics integration
- [ ] k6/Artillery load testing (10x volume)

---

## Sprint 5: Retention Stack (Weeks 7–10)

### Architecture review overrides for Sprint 5

These override any conflicting guidance in individual prompts:

1. **Split Sprint 5 into 5A and 5B.** Sprint 5A ships the retention layer that proves ROI with the least breakage risk: value emails, monthly impact email, read-only owner dashboard, engagement alerts, and admin churn score. Sprint 5B carries the deferred/riskier work: automated ranking, satisfaction pulse, onboarding drips, owner settings, and dashboard approval actions.
2. **Email is the primary retention surface.** The owner dashboard exists and should be polished, but the weekly/monthly emails are where owners actually live. If forced to cut scope, cut dashboard features before email features.
3. **Sprint 5A must not introduce new SerpAPI spend.** Weekly/monthly value reports and the read-only dashboard may display ranking only when `ranking_snapshots` data already exists. They must not trigger ranking searches.
4. **Keep the current approval flow stable in Sprint 5A.** Do not add dashboard approve/edit/regenerate actions in 5A. The existing token-based email approval routes remain unchanged until the dedicated 5B dashboard action work.
5. **All new pollers follow existing patterns.** Use `setInterval` pollers (like WeeklySummaryScheduler, ArchivalPoller), NOT BullMQ repeatable jobs. Pollers create outbox entries; workers process them. Consistent with transactional outbox invariant.
6. **All new workers follow Sprint 2 mandatory patterns.** JSONB parsing guard, subscription guard, outbox completion, mock mode, worker registration with graceful shutdown, typed payloads. See Sprint 2 architecture overrides for the full list. Extend `WorkerType` with a retention/engagement type if needed, or explicitly reuse the existing `summary` guard semantics; do not bypass subscription checks.
7. **Engagement metrics are computed at query time, not stored.** Approval rate, last approval date, response time averages — all derivable from existing tables. No new columns for computed metrics. The churn risk score is a pure function over queried metrics.
8. **5B ranking tracking is feature-flagged and cost-capped.** Automated ranking is disabled by default, runs biweekly at most, tracks one explicit keyword per business initially, and must check a monthly SerpAPI budget cap before making calls.
9. **5B satisfaction pulse must use GET for confirmation only, POST for mutation.** Email clients prefetch GET links; GET must validate and render a confirmation page without writing to the database.
10. **5B onboarding drip emails only fire for `active` businesses.** Never for `pending_payment`. The drip timing is based on `subscription_activated_at`, not `created_at`.
11. **Owner dashboard links require owner auth.** Owner `users` rows currently have `auth_id = NULL` unless an owner account is explicitly created. Do not include `/dashboard` links in customer emails unless that business has an owner auth mapping, or Sprint 5A includes an explicit owner invite/magic-link enablement step.

### Sprint 5A database objects (single migration)

Create migration `008_retention_core.sql`:

```sql
-- Monthly impact email idempotency
-- NOTE: No DEFAULT on id — app must supply UUIDv7, same convention as all tables
-- after migration 002 dropped gen_random_uuid() defaults.
CREATE TABLE IF NOT EXISTS monthly_impact_emails (
  id UUID PRIMARY KEY,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  month_start_date DATE NOT NULL,
  summary_text TEXT,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, month_start_date)
);

ALTER TABLE monthly_impact_emails ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_monthly_impact_emails_business_month
  ON monthly_impact_emails(business_id, month_start_date DESC);

-- Speeds cooldown checks for engagement alerts and value-email delivery records.
CREATE INDEX IF NOT EXISTS idx_notification_deliveries_business_template_sent
  ON notification_deliveries(business_id, template, sent_at DESC)
  WHERE sent_at IS NOT NULL;
```

Do not create new Sprint 5B objects in Sprint 5A. `ranking_snapshots` already exists in the initial schema and may be read conditionally if data exists. Add deferred 5B tables/columns only when implementing the deferred 5B prompts that need them.

### Sprint 5B deferred database objects

When implementing Sprint 5B, create a separate migration such as `009_retention_expansion.sql`. Keep this separate from 5A so the lower-risk customer-visible ROI work can ship without adding unused tables/columns.

```sql
-- Onboarding drip log for idempotent email delivery
-- NOTE: No DEFAULT on id — app must supply UUIDv7, same convention as all tables
-- after migration 002 dropped gen_random_uuid() defaults.
CREATE TABLE IF NOT EXISTS onboarding_drip_log (
  id UUID PRIMARY KEY,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  drip_type TEXT NOT NULL CHECK (drip_type IN ('day_1', 'day_7', 'day_30')),
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, drip_type)
);

ALTER TABLE onboarding_drip_log ENABLE ROW LEVEL SECURITY;

-- Satisfaction pulse responses from weekly email
CREATE TABLE IF NOT EXISTS satisfaction_responses (
  id UUID PRIMARY KEY,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  week_start_date DATE NOT NULL,
  rating TEXT NOT NULL CHECK (rating IN ('great', 'ok', 'not_great')),
  comment TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, week_start_date)
);

ALTER TABLE satisfaction_responses ENABLE ROW LEVEL SECURITY;

-- Deferred business columns for 5B ranking, onboarding drip, and notification opt-out
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS subscription_activated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS tracked_keywords JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS google_place_address TEXT,
  ADD COLUMN IF NOT EXISTS google_place_lat NUMERIC(10, 7),
  ADD COLUMN IF NOT EXISTS google_place_lng NUMERIC(10, 7),
  ADD COLUMN IF NOT EXISTS ranking_search_location TEXT,
  ADD COLUMN IF NOT EXISTS weekly_summary_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS monthly_impact_enabled BOOLEAN NOT NULL DEFAULT TRUE;

-- Backfill subscription_activated_at for existing active businesses.
-- Uses updated_at as best approximation of when they became active.
UPDATE businesses
  SET subscription_activated_at = updated_at
  WHERE subscription_status = 'active'
    AND subscription_activated_at IS NULL;

-- Normalize tracked_keywords before relying on it in the ranking worker.
UPDATE businesses
  SET tracked_keywords = '[]'::jsonb
  WHERE tracked_keywords IS NULL;

ALTER TABLE businesses
  ALTER COLUMN tracked_keywords SET DEFAULT '[]'::jsonb,
  ALTER COLUMN tracked_keywords SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_satisfaction_responses_business_week
  ON satisfaction_responses(business_id, week_start_date DESC);

CREATE INDEX IF NOT EXISTS idx_onboarding_drip_business
  ON onboarding_drip_log(business_id);

CREATE INDEX IF NOT EXISTS idx_businesses_ranking_ready
  ON businesses(subscription_status, place_id_verified)
  WHERE subscription_status = 'active'
    AND place_id_verified = TRUE
    AND tracked_keywords <> '[]'::jsonb;

-- Required before automated ranking upserts use:
-- ON CONFLICT (business_id, keyword, snapshot_date)
-- If this fails, manually dedupe existing duplicate snapshots first.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_ranking_snapshots_business_keyword_date
  ON ranking_snapshots(business_id, keyword, snapshot_date);

-- 5B dashboard approval actions need session-authenticated audit records.
-- Existing token approval routes continue to write token_hash.
ALTER TABLE approval_audit_log
  ALTER COLUMN token_hash DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS actor_user_id UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS auth_method TEXT NOT NULL DEFAULT 'token'
    CHECK (auth_method IN ('token', 'owner_session'));
```

### Claude Code prompts

**Prompt 19a — Sprint 5A Email Value Engine + AI Intelligence Brief**
```
Upgrade the weekly email into a retention-driving Value Report and add a monthly impact email.

1. Upgrade WeeklySummaryWorker + email template:
   The existing weekly email shows review count, responded count, response rate, notable reviews.
   Upgrade it to a "Weekly Value Report" with this content order (top to bottom):

   a. AI Intelligence Brief (NEW):
      - Skip the LLM call entirely if zero reviews were detected that week (no input
        to summarize). Set summary_text = NULL and omit the brief section from the email.
      - When reviews exist, send review texts + star ratings to LLM with a summarization
        prompt. Cap the review list/truncated text so one unusually high-volume customer
        cannot exceed the weekly budget.
      - Output: 3-5 sentence brief covering recurring themes, new mentions,
        sentiment trend, one actionable recommendation
      - Save to `summary_text` column on `weekly_summaries` table. On retry, if
        a non-null summary_text already exists for that business/week, reuse it
        instead of making another LLM call.
      - Cost: ~$0.01-0.03 per business per week (negligible)
      - Create a dedicated review-summary helper that reuses the same LLM provider
        fallback and cost reservation/audit pattern as production response generation;
        do not force this through `generateResponse()` because that function is
        shaped for one review response, not multi-review summaries.
      - In mock mode, return a canned summary string
       - After Resend returns success, record notification_deliveries with
         template='weekly_value_report' and response_id=NULL. Extend
         `recordNotificationDelivery()` to allow business-level notifications
         and pass the returned Resend messageId as externalMessageId.

   b. "Value Delivered" header (NEW):
      - "This week RepWorth handled X reviews for you, saving you approximately Y minutes"
      - Calculate time saved: reviews_handled × 7 (business plan cites 5-10 min/review)

   c. Response rate lift (ENHANCED):
      - "Your response rate: 100% (was 22% before RepWorth)"
      - Uses `initial_review_count` and `initial_responded_count` from businesses table
        (already captured by captureRoiBaseline() in process-review.ts)
      - If baseline not yet captured, show just the current rate

   d. Review velocity (NEW):
      - "New reviews this week: 7 | 4-week average: 5.2"
      - Simple text, no chart in email

   e. Google Maps ranking (conditional, no new SerpAPI calls in 5A):
      - "Your ranking for 'tacos san jose': #4 (was #6 when you joined)"
      - Only show if ranking_snapshots exist for this business
      - Compare latest snapshot to earliest snapshot

   f. Notable reviews (EXISTING, keep as-is)

   g. Dashboard link (NEW):
      - "See your full dashboard →" linking to /dashboard only when the owner has
        `users.auth_id IS NOT NULL`; otherwise omit the link so owners are not
        sent to an inaccessible login.

2. Monthly Impact Email:
   - New MonthlyImpactScheduler: hourly poller, fires 1st of month 9-10 AM UTC
   - Queries active businesses with no monthly_impact_emails row for previous month
     OR an existing row where sent_at IS NULL
   - Also checks for an in-flight `send_monthly_impact` outbox entry for the same
     business_id + month_start_date before inserting a new outbox entry
   - Creates outbox entries with topic 'send_monthly_impact'
   - New MonthlyImpactWorker processes the outbox entry:
      a. Upsert monthly_impact_emails row first, supplying an app-generated UUIDv7
         for new rows. If sent_at is already non-null, the email was already sent
         — complete the outbox entry without re-sending.
      b. Query full month stats: total reviews, total responded, response rate,
         time saved (reviews × 7 min), ranking change only if ranking snapshots
         already exist
      c. Find "best review of the month" — highest star rating with longest text
      d. If monthly_impact_emails.summary_text already exists, reuse it. Otherwise
         send the month's reviews to LLM for monthly intelligence brief (3-5
         sentences, broader themes than weekly), cap/truncate inputs so monthly
         volume cannot exceed the budget, then save summary_text.
      e. Mark sent_at = NOW() BEFORE calling Resend (same crash-safe pattern as
         WeeklySummaryWorker). This accepts the rare risk of a missed monthly
         email if the worker crashes or Resend fails after sent_at is marked,
         but prevents duplicate sends from replayed outbox jobs.
      f. Build and send email via Resend
       g. After Resend returns success, record notification_deliveries with
          template='monthly_impact', response_id=NULL, and the returned Resend
          messageId as externalMessageId.

   - Monthly email template content:
     a. Monthly intelligence brief
     b. "In [Month], we handled X reviews, saving you approximately Y hours"
     c. Response rate: current vs baseline
      d. Ranking change since joining (if data exists)
      e. Best review of the month (star rating + text + approved/posted response if available)
     f. Dashboard link only when the owner has `users.auth_id IS NOT NULL`;
        otherwise omit the link so owners are not sent to an inaccessible login.

3. Email templates:
   - buildWeeklyValueReportHtml() — replaces existing buildWeeklySummaryEmailHtml()
   - buildMonthlyImpactEmailHtml() — new template
   - Both: mobile-first, 600px max-width, same styling family as approval email
   - Do not include satisfaction pulse links in Sprint 5A; that is deferred to 5B.

Register MonthlyImpactScheduler + MonthlyImpactWorker in worker/index.ts.
Add 'send_monthly_impact' to OutboxPoller topic dispatch.
```

**Prompt 19b — Sprint 5B Automated Ranking Tracking (deferred)**
```
Do not implement this in Sprint 5A. Automated Google Maps ranking is useful,
but it is not the core ROI proof and it creates ongoing SerpAPI spend.
Implement it in Sprint 5B only after the value emails, read-only dashboard,
engagement alerts, and churn score are stable.

1. RankingTrackingScheduler:
   - Feature flag: if RANKING_TRACKING_ENABLED !== 'true', do not enqueue work
   - Biweekly poller: runs every other Sunday at 22:00 UTC
   - Implementation: setInterval at 1 hour, but only acts when:
      a. Current day is Sunday
      b. ISO week number is even (or odd — pick one, be consistent)
      c. Current hour is 22 UTC
   - Queries active businesses with:
     a. verified/canonical Google place ID
     b. usable location (`google_place_lat` + `google_place_lng`, or explicit
        `ranking_search_location`)
     c. non-empty tracked_keywords
   - Creates one outbox entry per business with topic 'track_ranking'
   - Dedup guard: skip if a pending/dispatched 'track_ranking' outbox entry
      already exists for this business

2. RankingTrackingWorker:
   - Processes 'track_ranking' outbox entries
   - Reads business.tracked_keywords (JSONB array of strings)
   - If tracked_keywords is empty, skip and log the reason. Do NOT auto-generate
     keywords inside the worker at runtime; admin setup can suggest and persist
     a default keyword before tracking starts.
   - For Sprint 5B initial rollout, track at most 1 keyword per business. Raise
     the limit only after SerpAPI usage is measured.
   - Before calling SerpAPI, check a monthly budget/rate-limit key such as
     `serpapi:ranking:monthly`. If the cap is hit, mark the outbox entry completed
     with a skip reason instead of retrying.
   - For each keyword:
      a. Call SerpAPI with engine=google_maps and q=keyword. Prefer
         `ll=@{google_place_lat},{google_place_lng},15z` when coordinates exist;
         otherwise use `location=ranking_search_location`. If neither exists,
         skip this business and mark the outbox completed with a skip reason.
      b. Parse local_results array from response
      c. Find the business by matching place_id against results[].place_id
      d. If found: rank_position = index + 1
      e. If not found in results: rank_position = NULL
      f. Upsert into ranking_snapshots with source='serpapi'
         (ON CONFLICT business_id, keyword, snapshot_date).
         Use 'serpapi' to match the existing schema values ('manual', 'serpapi', 'api').
   - Rate limit: 1 SerpAPI call per 2 seconds (reuse existing rate limiter)
   - Cost target: 10 businesses × 1 keyword × 2 runs/month = ~20 calls/month
   - In mock mode: generate random rank positions 1-10

   5B migration prerequisite:
   - Add `businesses.tracked_keywords JSONB DEFAULT '[]'::jsonb` if it does not exist
   - Add ranking location columns if they do not exist:
     `google_place_address`, `google_place_lat`, `google_place_lng`, `ranking_search_location`
   - Update onboarding/admin edit code to persist `googlePlaceAddress`, lat, and lng
     from `PlaceAutocomplete`; for existing businesses, allow admin to set
     `ranking_search_location` manually before enabling automated tracking
   - Add a unique index/constraint for `ranking_snapshots(business_id, keyword, snapshot_date)`
     before using ON CONFLICT upserts

3. Admin manual entry fallback:
   - On admin business detail page, add a "Ranking" section
   - Form: keyword (text), rank position (number), date (defaults to today)
   - POST /api/admin/businesses/[id]/ranking — inserts with source='manual'
   - This is a fallback, not the primary path

4. Tracked keywords management:
   - On admin business detail page, add "Tracked Keywords" section
   - Display current keywords as editable list (add/remove)
   - PUT /api/admin/businesses/[id]/keywords — updates tracked_keywords JSONB
   - Default: suggested from category + city as a placeholder, but only persisted
     after admin confirmation

Register RankingTrackingScheduler + RankingTrackingWorker in worker/index.ts.
Add 'track_ranking' to OutboxPoller topic dispatch.
```

**Prompt 19c — Sprint 5A Read-Only Owner Dashboard; 5B Settings + Dashboard Actions**
```
Build the authenticated owner dashboard as a read-only ROI surface in Sprint 5A.
The dashboard is a complement to the email experience, not a replacement.
Settings and approval mutations are deferred to Sprint 5B.

Owner auth prerequisite:
- Existing owner `users` rows are created with `auth_id = NULL`. Before exposing
  the dashboard link to a customer, either create/map a Supabase Auth owner account
  or omit the dashboard link for that business.
- Low-risk Sprint 5A path: implement the dashboard and `/api/dashboard`, but only
  show email dashboard links when `EXISTS (SELECT 1 FROM users WHERE business_id =
  businesses.id AND role='owner' AND auth_id IS NOT NULL)`.
- If owner dashboard access is turned on for a customer, create an explicit admin
  flow to send an owner invite/magic link and update `users.auth_id` after Supabase
  Auth identity is created. Do not auto-invite every owner during 5A without a
  separate decision.

1. Dashboard layout (src/app/(authenticated)/layout.tsx):
   - Replace the current pass-through layout with a minimal shell
   - 5A top nav: Dashboard | business name + Sign out button
   - 5B can add Settings when the settings page is implemented
   - Mobile-responsive: hamburger menu on small screens
   - No sidebar
   - Use Supabase Auth session for user identity, look up business_id from users table

2. Dashboard page (src/app/(authenticated)/dashboard/page.tsx):
   - Replace the current placeholder with a real data-driven page
   - Mobile-first, sections stack vertically

   Section A — Value Summary Banner:
   - Top of page, high-contrast card
   - "Since joining RepWorth" framing
   - Stats: total reviews handled, total time saved (reviews × 7 min),
     response rate (before → now using ROI baseline)
   - Same numbers as monthly email for consistency

   Section B — Review Velocity Chart:
   - Bar chart, last 8 weeks
   - One small chart dependency: recharts (widely used, tree-shakeable)
   - No interactivity needed, glance-and-go

   Section C — Google Maps Ranking Chart (conditional):
   - Line chart, position over time from ranking_snapshots
   - Y-axis inverted (rank #1 at top)
   - One line per tracked keyword
   - If no data yet: hide the chart or show "Ranking data will appear once tracking is enabled"
   - Do not call SerpAPI from the dashboard in Sprint 5A

   Section D — Recent Reviews (read-only in Sprint 5A):
   - Last 10 reviews with status badges (color-coded, same palette as admin)
   - Pending reviews show status and a reminder to approve from the email link.
     Do not try to reconstruct approval URLs from the database; only token hashes
     are stored.
   - Do not add Approve, Edit, or Regenerate buttons in Sprint 5A
   - Do not modify the existing token-based approval API routes in Sprint 5A
   - Reviews show response text read-only (expandable)

   Section E — Latest Intelligence Brief:
   - Show most recent monthly summary, or if none, most recent weekly summary
   - Read-only text block

3. Data API:
   - GET /api/dashboard — returns all dashboard data in one payload
   - Scoped by owner's business_id from auth session (NEVER trust client-submitted IDs)
   - Do not rely only on middleware. The API route itself must call `requireRole(request, 'owner')`
     and verify `user.businessId` is non-null before querying.
   - Add `/api/dashboard/:path*` to middleware matcher if dashboard APIs grow beyond
     this single route, but keep route-level authorization as defense-in-depth.
   - Queries: reviews (last 10), review counts by week (last 8), ranking snapshots,
     ROI baseline, latest summary text
   - No polling/TanStack Query needed — single fetch on mount

4. 5B deferred Settings page (src/app/(authenticated)/settings/page.tsx):
   - Do not implement in Sprint 5A unless it becomes a direct customer-retention blocker.

   Section A — Business Profile:
   - Business name, category, and Google place ID (read-only, displayed for reference)
   - Tone/personality (editable textarea)
   - Products/services to highlight (editable textarea mapped to `businesses.products_services`)
   - Facts to avoid mentioning (editable list mapped to `businesses.avoid_facts`)
   - Sample responses (editable textarea/list mapped to `businesses.sample_responses`)
   - Use the existing business profile columns unless a later migration explicitly
     introduces a settings JSONB shape

   Section B — Notification Preferences:
   - Email address for notifications (editable, default from login)
   - Channel toggle: Email only | SMS only | Both
   - Phone number (shown only if SMS selected)
   - Weekly summary: on/off toggle → `businesses.weekly_summary_enabled` (BOOLEAN, added in 009)
   - Monthly impact report: on/off toggle → `businesses.monthly_impact_enabled` (BOOLEAN, added in 009)
   - Channel + phone map to existing `notification_preference` VARCHAR(20) and `owner_phone` VARCHAR(20)
   - WeeklySummaryScheduler and MonthlyImpactScheduler must respect these flags
     (skip businesses where the relevant flag is FALSE)

   Section C — Save:
   - Single "Save Changes" button for the whole page
   - PUT /api/settings — Zod validation, scoped by owner's business_id
   - Do not rely only on middleware. The API route itself must call
     `requireRole(request, 'owner')` and use `user.businessId`; never accept a
     business_id in the request body.
   - Partial updates (only changed fields)
   - Success toast notification

5. 5B deferred Dashboard approval API (separate routes, not modifying token-based routes):
   - Do not implement in Sprint 5A.
   - New routes under src/app/api/dashboard/reviews/[reviewId]/:
     - POST /api/dashboard/reviews/[reviewId]/approve — approve response
     - POST /api/dashboard/reviews/[reviewId]/edit — edit + approve (body: { edited_text })
     - POST /api/dashboard/reviews/[reviewId]/regenerate — request new draft
   - Auth: Supabase session required (via requireAuth + requireRole('owner')).
      Verify that the review belongs to the owner's business_id.
   - Do not try to process session-authenticated actions through raw approval
      tokens. The raw token is never stored, and ApprovalService token methods
      verify device-cookie binding.
   - Implementation: refactor ApprovalService so the core response mutations are
      token-agnostic internal helpers, then expose two entry points:
      a. existing token methods used by public email approval routes
      b. new owner-session methods used by dashboard routes after owner auth +
         business ownership checks
   - The owner-session methods must write approval_audit_log with
     auth_method='owner_session', actor_user_id=<users.id>, token_hash=NULL.
   - This avoids modifying the existing token-based routes (which are public,
      security-sensitive, and well-tested). The dashboard routes are a separate
      entry point with session auth, converging on the same core service logic.
   - The email-based token flow remains completely unchanged.
```

**Prompt 19d — Sprint 5A Engagement Monitoring + Re-engagement**
```
Build the engagement detection and re-engagement system. Three layers:
tracking (computed), automated nudges to owner, and escalation to sales partner.

1. EngagementMonitorPoller:
   - Daily poller (24h interval via setInterval, same pattern as ArchivalPoller)
   - Use one grouped metrics query for all active businesses rather than one query
     per business. Keep the first version simple, but avoid an avoidable N+1 loop.
   - For each active business, computes engagement metrics at query time:
      a. Approval rate (30-day rolling): approved_count / notified_count, where
         notified_count counts DISTINCT response_id values from approval-request
         notification deliveries with sent_at IS NOT NULL in the last 30 days,
         and approved_count counts those same distinct notified responses whose
         current status is approved/edited/posted/awaiting_manual_post. Use
         NULLIF/notified_count guard; if notified_count = 0, approval_rate = NULL
         and low-engagement rule does not fire.
     b. Days since last approval: CURRENT_DATE - MAX(responses.approved_at)
        where business_id = X and status IN ('approved','edited','posted',
        'awaiting_manual_post')
      c. Pending reviews: COUNT(responses) WHERE status = 'pending_approval'
         AND business_id = X
      d. Oldest pending age: CURRENT_DATE - MIN(responses.created_at) for
         pending_approval responses. This is the fallback clock when the business
         has no approval history yet; otherwise rule timing uses days since last
         approval.
      e. Notified response count for 30-day sample-size gating
   - Applies engagement rules (see table below)
   - Creates outbox entries with topic 'engagement_alert' when triggered
   - Dedup: each alert type + business has a cooldown. Check notification_deliveries
     for recent sends of that alert type before creating outbox entry.

    Engagement rules:
    Use `activity_age_days = days_since_last_approval ?? oldest_pending_age_days`
    for the no-approval-activity thresholds below. If both are null, do not fire
    a no-approval-activity alert.

    | Condition | Alert type | Cooldown |
    |---|---|---|
    | activity_age_days >= 3 AND pending > 0 | owner_nudge | 3 days |
    | activity_age_days >= 7 AND pending > 0 | partner_engagement_alert | 7 days |
    | activity_age_days >= 14 AND (pending > 0 OR notified_count > 0) | partner_escalation_alert | 14 days |
    | Approval rate < 50% (30d rolling) AND notified_count >= 3 | partner_low_engagement | 7 days |

2. EngagementAlertWorker:
   - Processes 'engagement_alert' outbox entries
   - Payload: { business_id, alert_type, metrics: { days_since_approval,
      oldest_pending_age_days, pending_count, approval_rate } }
   - Sends the appropriate email template based on alert_type:

   a. owner_nudge → sends to business owner:
      - "You have X reviews waiting for your approval"
      - Lists each pending review: star rating, reviewer name, first 50 chars of text
      - Each review has a direct link to its approval page. For each pending review:
        1. Do NOT try to reuse an existing approval URL. Raw approval tokens are
           never stored, only SHA-256 hashes are stored.
        2. Revoke existing open, unconsumed approval links for the response.
        3. Generate a fresh approval link/token using shared approval-link
           creation logic extracted from NotificationWorker: randomUUID →
           SHA-256 hash stored, raw token in URL only.
        4. Never persist the raw token in Postgres, outbox payloads, or logs.
      - Tone: friendly, short, not naggy
      - Template: buildOwnerNudgeEmailHtml()

   b. partner_engagement_alert → sends to sales partner (admin email):
      - "Customer [business name] hasn't engaged in [N] days"
      - Shows: days since last approval, pending review count, approval rate,
        owner email + phone
      - Suggested action: "Consider sending a check-in message"
      - Template: buildPartnerEngagementAlertHtml()

   c. partner_escalation_alert → sends to sales partner:
      - "⚠ Customer [business name] may be at risk — no engagement in 2+ weeks"
      - Same metrics as above but with stronger urgency framing
      - Suggested action: "Recommend a personal phone call or visit"
      - Template: buildPartnerEscalationAlertHtml()

   d. partner_low_engagement → sends to sales partner:
      - "Customer [business name] approval rate dropped to X%"
      - Shows 30-day approval rate, trend direction, pending count
      - Template: buildPartnerLowEngagementAlertHtml()

   e. 5B partner_satisfaction_alert → sends to sales partner:
      - Triggered by a "not great" satisfaction pulse response
      - Shows rating, optional owner comment, business name, owner email + phone
      - Template: buildPartnerSatisfactionAlertHtml()

    - Records delivery in notification_deliveries (reuse existing infrastructure).
      Extend `recordNotificationDelivery()` to allow `responseId: string | null`
      because engagement alerts are business-level notifications, and pass the
      returned Resend messageId as externalMessageId.

3. Email templates:
   - buildOwnerNudgeEmailHtml() — mobile-first, same styling as approval email
   - buildPartnerEngagementAlertHtml() — internal, plain styling
   - buildPartnerEscalationAlertHtml() — internal, red accent for urgency
   - buildPartnerLowEngagementAlertHtml() — internal, amber accent
   - 5B: buildPartnerSatisfactionAlertHtml() — internal, red/amber accent for "not great"
   - All in src/lib/notifications/email.ts

Register EngagementMonitorPoller + EngagementAlertWorker in worker/index.ts.
Add 'engagement_alert' to OutboxPoller topic dispatch.
```

**Prompt 19e — Sprint 5B Onboarding Drip Emails (deferred)**
```
Do not implement this in Sprint 5A. Build the automated onboarding email
sequence in Sprint 5B after value reports, monthly impact email, read-only
dashboard, engagement alerts, and churn score are stable. Fires at day 1, 7,
and 30 after a business's subscription activates.

Before this prompt, add the 5B migration for `onboarding_drip_log` and
`businesses.subscription_activated_at`, and update the Stripe webhook handler
so the transition to `subscription_status = 'active'` sets
`subscription_activated_at = now()` when it is null.

1. OnboardingDripScheduler:
   - Hourly poller (same pattern as WeeklySummaryScheduler)
   - Queries businesses WHERE subscription_status = 'active'
     AND subscription_activated_at IS NOT NULL
   - For each business, checks which drip emails are due:
     a. day_1: subscription_activated_at + 1 day has passed, no 'day_1' row
        in onboarding_drip_log for this business
     b. day_7: subscription_activated_at + 7 days has passed, no 'day_7' row
     c. day_30: subscription_activated_at + 30 days has passed, no 'day_30' row
   - Creates outbox entry with topic 'send_onboarding_drip' for each due email
   - Payload: { business_id, drip_type }

2. OnboardingDripWorker:
   - Processes 'send_onboarding_drip' outbox entries
   - Reads business profile + stats based on drip_type
   - Builds and sends the appropriate email template
   - Inserts into onboarding_drip_log (idempotent via unique constraint ON CONFLICT DO NOTHING)
   - Marks outbox completed

   Day 1 — Welcome + What to Expect:
   - "Welcome to RepWorth! Here's how it works."
   - Sets expectations: email per new review, tap approve/edit/regenerate, 30 seconds
   - Mentions weekly value report and dashboard
   - Link to dashboard
   - Tone: warm, short, no jargon
   - Template: buildOnboardingDay1Html()

   Day 7 — First Week Recap:
   - "Your first week with RepWorth"
   - Query: reviews handled this week, time saved (reviews × 7 min), response rate
   - Highlight one specific review + response as an example
   - If owner has edited responses: "Thanks for the edits — we're learning your voice
     and will get closer each time"
   - If zero approvals: softer version — "We've got X reviews ready for your approval"
     with direct links to pending approval pages. Use the same shared approval-link
     creation logic from 19d (revoke existing open links for each pending response,
     generate fresh token, store only SHA-256 hash, raw token in URL only).
   - Template: buildOnboardingDay7Html()

   Day 30 — First Month Impact:
   - "Your first month with RepWorth — here's what changed"
   - Full month stats: total reviews, response rate before → now, time saved,
     ranking change (if data exists)
   - Framed as a milestone, not a routine report
   - Ends with: "Questions? Reply to this email — [sales partner name] is here to help."
   - Template: buildOnboardingDay30Html()

3. Email templates:
   - buildOnboardingDay1Html(), buildOnboardingDay7Html(), buildOnboardingDay30Html()
   - Mobile-first, 600px max-width, same styling family
   - All in src/lib/notifications/email.ts

Register OnboardingDripScheduler + OnboardingDripWorker in worker/index.ts.
Add 'send_onboarding_drip' to OutboxPoller topic dispatch.
```

**Prompt 19f — Sprint 5A Churn Risk Score + Admin Enhancements**
```
Build the churn risk scoring system and surface it in the admin dashboard.
The score gives the sales partner an at-a-glance answer to "who needs attention?"

1. Churn risk score function:
   - New file: src/lib/shared/churn-score.ts
   - Pure function: computeChurnRiskScore(metrics: BusinessMetrics): ChurnScore
   - No database calls, no side effects — takes pre-queried metrics, returns score

   Input (BusinessMetrics):
   - approvalRate: number | null (0-1, 30-day rolling; null when no approval-request notifications exist)
   - notifiedResponseCount30d: number
   - pendingResponseCount: number
   - daysSinceLastApproval: number | null
   - satisfactionResponses: Array<{ rating: 'great'|'ok'|'not_great' }> | null
     (last 4 weeks; null until Sprint 5B satisfaction pulse exists)
   - responseTimeTrend: 'faster_or_stable' | 'slower' | 'stopped' | null
   - accountAgeDays: number

   Output (ChurnScore):
   - score: number (0-100, higher = higher risk)
   - level: 'healthy' | 'watch' | 'at_risk'
   - breakdown: Array<{ signal: string, value: string, contribution: number }>

   Scoring model (5 weighted signals):
   | Signal | Weight | Scoring |
   |---|---|---|
   | Approval rate (30d) | 30% | null or notifiedResponseCount30d < 3 = 0, 100%=0, 80%=20, 50%=50, <30%=100 |
   | Days since last approval | 25% | null + no pending responses=0, null + pending responses=60, 0-2d=0, 3-5d=30, 7+d=60, 14+d=100 |
   | Satisfaction pulse trend | 20% | unavailable/null=0 until 5B is enabled, all great=0, mix=30, not_great streak=80, no responses after 5B enablement=40 |
   | Response time trend | 15% | null or faster_or_stable=0, slower=50, stopped=100 |
   | Account age | 10% | weeks 1-4=20, weeks 5-12=10, 12+=0 |

   Levels: 0-30 = healthy, 31-60 = watch, 61-100 = at_risk

   Weights and thresholds are exported constants — easy to tune later.

2. Admin Overview page enhancement:
   - GET /api/admin/overview already queries businesses
   - Add one grouped metrics query for all businesses returned by the overview
     page. Do not run a separate metrics query per business.
   - Metrics: approval rate, notified response count, pending response count,
      last approval date, response time trend (derived from current week average
      approval latency vs previous 4-week average), and satisfaction responses only
      if the Sprint 5B satisfaction pulse table/feature is enabled; otherwise pass null
   - Run each through computeChurnRiskScore()
   - Add "Health" column to the business CRM table:
     - Green badge "Healthy" for 0-30
     - Amber badge "Watch" for 31-60
     - Red badge "At Risk" for 61-100
   - Default sort: risk score descending (most at-risk at top)
   - Keep existing sort options as alternatives

3. Admin Business Detail page enhancement:
   - Show risk score with color badge in the business header area
   - Add "Engagement" section below existing sections:
     - Score breakdown: which signals are contributing and how much
     - e.g., "Approval rate: 45% ↓ (contributing 50/30 to risk score)"
     - "Days since last approval: 8 (contributing 60/25)"
   - This gives the sales partner talking points before calling the customer

4. Unit tests for churn score:
   - Test each signal independently (one signal active, others neutral)
   - Test combined scoring
   - Test edge cases: new account with no data, perfect engagement, completely disengaged
   - Test level thresholds (boundary values at 30 and 60)
```

**Prompt 19g — Sprint 5B Satisfaction Pulse (deferred)**
```
Do not implement this in Sprint 5A. Add the satisfaction pulse only after the
weekly/monthly value emails and engagement alerts are stable.

1. Weekly Value Report template change:
   - Add bottom-of-email prompt: "How was your experience this week?"
   - Three links: Great | OK | Not great
   - Each link points to GET /api/feedback?business_id=X&rating=great&week=YYYY-MM-DD&sig=HMAC_HEX
   - week must be the week_start_date date, not an ISO week string, so it maps
     directly to satisfaction_responses.week_start_date.
   - HMAC input must include business_id, rating, and week_start_date.

2. Scanner-safe feedback routes:
   - GET /api/feedback validates HMAC and renders a lightweight confirmation page.
     It must not write to the database because email scanners prefetch GET URLs.
   - The confirmation page posts to POST /api/feedback with hidden signed fields.
   - POST /api/feedback validates HMAC again, then in a SINGLE sql.begin()
     transaction: upserts into satisfaction_responses on (business_id,
     week_start_date), and if rating='not_great', inserts an engagement_alert
     outbox entry. This follows the transactional outbox invariant (state change
     + follow-up work in the same Postgres transaction). Redirects to
     /feedback/thanks after commit.
   - For "not_great", render an optional comment textbox on the confirmation page
     and persist the comment in the same POST transaction.
   - No Supabase login is required for this public feedback flow; the HMAC is the
     authorization boundary. Do not accept unsigned business_id/rating/week fields.

3. Partner alert:
   - When rating='not_great', create an engagement_alert outbox entry with
     alert_type='partner_satisfaction_alert' and payload metrics/comment.
   - EngagementAlertWorker sends a partner email and records notification_deliveries
     with template='partner_satisfaction_alert'.
   - Add cooldown dedup for one partner_satisfaction_alert per business/week.

4. Tests:
   - GET with a valid signature renders confirmation and does not write to DB.
   - GET with invalid signature returns 400.
   - POST with valid signature upserts exactly one row.
   - Duplicate POST updates the existing row rather than inserting another.
   - "Not great" creates one partner alert outbox entry with cooldown dedup.
```

### Sprint 5A done when
- [ ] Weekly email upgraded to Value Report (intelligence brief, time saved, rate lift when baseline exists, velocity, conditional existing ranking data, dashboard link)
- [ ] Monthly impact email sends on 1st of month with full-month stats + intelligence brief
- [ ] Monthly impact email is idempotent by business + month and only sends for `active` businesses
- [ ] Customer emails omit dashboard links unless the owner has an auth mapping or owner dashboard access was explicitly enabled
- [ ] Owner dashboard is read-only with: value summary, velocity chart, conditional ranking chart, recent reviews, latest intelligence brief
- [ ] `/api/dashboard` performs route-level owner auth and business scoping; it does not rely only on middleware
- [ ] Dashboard does not mutate approvals and does not modify the existing token-based approval routes
- [ ] Engagement monitoring uses grouped metrics and safe zero-denominator handling for: 3-day owner nudge, 7-day partner alert, 14-day escalation, low approval rate alert
- [ ] All engagement alerts have cooldown dedup
- [ ] Owner nudges generate fresh approval links without persisting raw tokens and without trying to reconstruct old approval URLs
- [ ] Churn risk score computed and shown on admin overview (Health column, sorted by risk)
- [ ] Churn risk breakdown on admin business detail page
- [ ] All new Sprint 5A workers registered with graceful shutdown
- [ ] All new Sprint 5A outbox topics dispatched by OutboxPoller
- [ ] Migration 008 applied only for Sprint 5A database needs (`monthly_impact_emails` + notification delivery cooldown index)
- [ ] Tests for: weekly value report fallbacks, monthly impact idempotency/subscription guard, dashboard business scoping, engagement rules, and churn score function

### Sprint 5B backlog
- [ ] Satisfaction pulse works with GET confirmation page + POST mutation, comment box for "not great", and sales partner alert
- [ ] Automated biweekly ranking tracking via SerpAPI is feature-flagged, budget-capped, limited to explicit tracked keywords, and only runs when ranking location data exists
- [ ] Manual ranking entry fallback on admin business detail page
- [ ] Tracked keywords management on admin business detail page
- [ ] Owner settings page: business profile editing (voice settings), notification preferences (weekly/monthly opt-out via `weekly_summary_enabled` / `monthly_impact_enabled` columns)
- [ ] WeeklySummaryScheduler and MonthlyImpactScheduler respect opt-out flags
- [ ] Dashboard approval actions support session-authenticated approve/edit/regenerate without changing the email token flow
- [ ] Onboarding drip: day 1 welcome, day 7 recap, day 30 impact — only for active subscriptions
- [ ] 5B migrations added only as needed (`satisfaction_responses`, `onboarding_drip_log`, `tracked_keywords`, `subscription_activated_at`, ranking location columns, notification opt-out columns, approval audit owner-session columns)
- [ ] Tests for: satisfaction pulse scanner-safe flow, ranking worker cost controls, dashboard approval authorization, and drip timing

---

## Sprint 6: Scale to $1K MRR (Weeks 11–12)

### What you build
Correlation IDs for end-to-end traceability, archival expansion for database health, onboarding automation via SerpAPI pre-fill, email deliverability hardening, and operational documentation for launch readiness.

**Design spec:** `docs/superpowers/specs/2026-04-16-sprint-6-scale-design.md`
**Implementation plan:** `docs/superpowers/plans/2026-04-16-sprint-6-scale.md`

### Sprint 6 Architecture Review Overrides

If any prompt below conflicts with these rules, these rules win:

1. **No new workers or pollers.** Sprint 6 enhances existing infrastructure. 12 workers + 9 pollers is sufficient for 20 businesses.
2. **No PostHog in Sprint 6.** Add product analytics only after customer #5 is live and generating real events. Zero customers = zero analytics value.
3. **Correlation IDs use the outbox payload JSONB field.** Every outbox entry already has a UUIDv7 `id` that travels through BullMQ job data. Add `correlation_id` to the payload — no new database columns needed. Entry points (pollers, schedulers, webhooks) generate the ID; workers propagate it when creating downstream outbox entries.
4. **Archival uses the existing CTE + LIMIT 5000 pattern.** New archival targets (api_costs, notification_deliveries) follow the identical ArchivalPoller pattern — extend the existing poller, don't create a new one.
5. **Onboarding pre-fill is a SerpAPI call in the admin API route, not a worker job.** Single fast lookup (<2s), needed synchronously for form pre-fill. This is one of the rare justified Vercel API route external calls — it's a single GET, not a multi-step pipeline.
6. **Email warmup is a process, not code.** The deliverability prompt produces documentation (DNS checklist, warmup schedule) plus small code changes (List-Unsubscribe headers, category tags, bounce handling).
7. **The operational runbook is a Markdown document, not application code.** It references existing admin pages, SQL queries, and worker behaviors.
8. **No formal load testing.** The architecture has built-in throttling (per-business concurrency limits, cost circuit breakers, outbox batching). A 3-business smoke test with real APIs is more valuable than synthetic k6 benchmarks at 0 customers. Load testing deferred to Sprint 7 when there's real traffic to profile.
9. **Voice learning is already implemented.** `getApprovedResponsePairs()` returns few-shot examples when ≥5 edited+posted responses exist. No Sprint 6 work needed — it activates naturally as customers use the product. PostHog tracking of edit_distance trends is deferred with the rest of PostHog.

### Sprint 6 Migration

Single migration 017 covers all Sprint 6 schema needs. Apply before starting Prompt 20b.

```sql
-- supabase/migrations/017_sprint6_scale.sql
-- Sprint 6: cost rollups for archival, website for onboarding pre-fill, bounce flag for deliverability

CREATE TABLE IF NOT EXISTS api_costs_daily_rollups (
  id UUID PRIMARY KEY,
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  provider VARCHAR(20) NOT NULL,
  rollup_date DATE NOT NULL,
  total_cost_usd DECIMAL(10,6) NOT NULL,
  total_input_tokens INTEGER NOT NULL DEFAULT 0,
  total_output_tokens INTEGER NOT NULL DEFAULT 0,
  call_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (business_id, provider, rollup_date)
);

ALTER TABLE api_costs_daily_rollups ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_cost_rollups_business_date
  ON api_costs_daily_rollups(business_id, rollup_date DESC);

ALTER TABLE businesses ADD COLUMN IF NOT EXISTS website TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS owner_email_bounced BOOLEAN NOT NULL DEFAULT FALSE;
```

### Claude Code prompts

**Prompt 20a — Correlation IDs + Structured Logging**
```
Add end-to-end correlation IDs so any review can be traced from ingestion to posting in a single SQL query.

1. Create src/lib/shared/logger.ts:
   - Export: createWorkerLogger(prefix: string, correlationId?: string): WorkerLogger
   - WorkerLogger has { log, warn, error } methods
   - Output format: [WorkerName] [corr-id] message (omit corr-id bracket if not provided)
   - This replaces raw console.log in all workers
   - Write tests in src/lib/shared/__tests__/logger.test.ts: format with/without correlation ID, all three log levels

2. Add BasePayload to src/lib/shared/worker-types.ts:
   - export interface BasePayload { correlation_id?: string }
   - Change all 11 payload interfaces to extend BasePayload:
     SyncReviewsPayload, GenerateResponsePayload, SendNotificationPayload,
     PublishResponsePayload, NotifyAdminExceptionPayload, WeeklySummaryPayload,
     ValidatePlaceIdPayload, SendMonthlyImpactPayload, EngagementAlertPayload,
     TrackRankingPayload, OnboardingDripPayload
   - The field is optional for backward compat with existing outbox rows
   - No OutboxPoller changes needed — correlation_id is already inside the payload
     spread: `{ ...payload, outbox_id: entry.id }` at OutboxPoller.ts line 137

3. Generate correlation IDs at all entry points — wherever an outbox entry is created:
   - All 9 pollers/schedulers: import { v7 as uuidv7 } from 'uuid', generate correlationId = uuidv7(),
     add correlation_id to the payload object they write to job_outbox
   - Webhook ingress (worker/ingress/stripe.ts): use the Stripe event ID as correlation_id
     when creating outbox entries in event handlers
   - Onboarding API (src/app/api/admin/businesses/route.ts): generate uuidv7() for the
     sync_reviews/validate_place_id outbox entry
   - Approval API routes: use the response_id as correlation_id when ApprovalService
     creates publish_response or generate_response outbox entries

4. Propagate correlation IDs through cross-outbox chains:
   - When a worker creates a NEW outbox entry as a result of processing a job, carry
     forward job.data.correlation_id into the new outbox payload. Update:
   - ReviewSyncWorker: carries correlation_id into generate_response and
     notify_admin_review_exception outbox entries
   - ResponseGeneratorWorker: carries correlation_id into send_notification outbox entry
   - ApprovalService: carries correlation_id into publish_response and generate_response
     outbox entries (passed from the API route caller)
   - Chain example: ReconciliationPoller [corr-abc] → sync_reviews → ReviewSyncWorker →
     generate_response [corr-abc] → ResponseGeneratorWorker → send_notification [corr-abc]

5. Replace console.log with createWorkerLogger in all 12 BullMQ worker handler files:
   - Remove const LOG_PREFIX = '[WorkerName]' lines
   - At top of handler: const logger = createWorkerLogger('[WorkerName]', job.data.correlation_id)
   - Replace console.log(`${LOG_PREFIX}...`) with logger.log(...)
   - Replace console.warn with logger.warn, console.error with logger.error
   - Do NOT change pollers/schedulers or ingress handlers — they don't process BullMQ jobs
   - Apply to: ReviewSyncWorker, ResponseGeneratorWorker, NotificationWorker,
     ResponsePublisherWorker, WeeklySummaryWorker, MonthlyImpactWorker,
     EngagementAlertWorker, AdminExceptionWorker, PlaceIdValidationWorker,
     DemoGenerationWorker, OnboardingDripWorker, RankingTrackingWorker

6. Queryability: to trace any review's full journey:
   SELECT topic, status, created_at, completed_at, last_error
   FROM job_outbox WHERE payload->>'correlation_id' = '<id>' ORDER BY created_at;

Write tests: logger formatting (5 tests), verify existing test suite passes (correlation_id is additive/optional).
```

**Prompt 20b — Archival Expansion + Cost Rollups**

Prerequisite: Migration 017 must be applied.

```
Extend the ArchivalPoller with two new archival targets and update the admin costs page to use rollup data.

1. Extend worker/jobs/ArchivalPoller.ts — add two new archival queries AFTER the existing
   three (outbox, events, demos). Use the exact same CTE + LIMIT 5000 + DELETE RETURNING pattern.

   a. api_costs > 90 days — aggregate then delete:
      - CTE flow: SELECT candidates (LIMIT 5000, WHERE created_at < NOW() - INTERVAL '90 days')
        → aggregate by (business_id, provider, created_at::date) with SUM(cost_usd),
        SUM(input_tokens), SUM(output_tokens), COUNT(*)
        → UPSERT into api_costs_daily_rollups ON CONFLICT (business_id, provider, rollup_date)
        DO UPDATE SET totals = existing + excluded (additive — supports batched archival)
        → DELETE original candidates → RETURNING count
      - Use gen_random_uuid() for rollup IDs in the upsert (server-side, no app UUIDv7 needed
        since these are internal aggregates)

   b. notification_deliveries > 90 days — straight delete:
      - Same CTE pattern: SELECT candidates WHERE created_at < NOW() - INTERVAL '90 days'
        LIMIT 5000, DELETE, RETURNING count
      - No aggregation needed — cooldown dedup checks use much shorter windows (24h, 3-7 days)

2. Update the archival logging to include all 5 targets:
   - Log: Archived: outbox=X, events=X, demos=X, api_costs=X, notifications=X
   - Add saturation warnings: if any count >= 5000, warn that more rows are pending

3. Update src/app/api/admin/costs/route.ts:
   - When the requested date range includes dates older than 90 days, query BOTH
     api_costs (for recent data) AND api_costs_daily_rollups (for archived periods)
   - Merge strategy: detail rows are authoritative for dates they cover; rollup rows
     fill in for dates where detail rows have been archived
   - Build a Set of (business_id:provider:date) keys from detail rows; filter rollup
     rows to exclude those keys; combine both arrays

Write tests: verify archival skips rows newer than 90 days, verify rollup produces correct
aggregated sums (mock SQL or integration test), verify costs API correctly merges detail + rollup data.
```

**Prompt 20c — Onboarding Automation + SerpAPI Pre-fill**
```
Reduce onboarding time from 20 to 10 minutes by auto-filling business details from SerpAPI.

Prerequisite: Migration 017 must be applied (adds businesses.website column).

1. Create src/lib/reviews/serpapi-prefill.ts:
   - Export: fetchBusinessDetails(placeId: string): Promise<BusinessPrefill>
   - BusinessPrefill = { category: string|null, phone: string|null, website: string|null,
     hours: string|null, fullAddress: string|null }
   - Calls SerpAPI with engine=google_maps, place_id=placeId
   - Extracts: type → category, phone, website, operating_hours → formatted string, address
   - Records the SerpAPI call to api_costs table (provider='serpapi', endpoint='google_maps_prefill',
     cost_usd=0.005)
   - NEVER throws — returns partial data (nulls for missing fields) on any failure
   - In mock mode: returns canned BusinessPrefill data
   - Write tests with SerpAPI mocked: full response, partial response, API error, mock mode

2. Create API route src/app/api/admin/businesses/prefill/route.ts:
   - GET handler, requires admin/sales_partner role via requireRole()
   - Accepts query param: place_id (required, returns 400 if missing)
   - Rate limited: checkRateLimit(`prefill:minute:${user.id}`, 10, 60) — 10/min per user
   - Calls fetchBusinessDetails(placeId)
   - Returns the BusinessPrefill JSON
   - This is a justified Vercel external API call — single fast SerpAPI lookup (<2s),
     needed synchronously for form UX

3. Add website to business schemas:
   - In src/lib/shared/schemas.ts: add website: z.string().url().max(500).optional().nullable()
     to OnboardBusinessSchema and the PATCH settings schema
   - In src/app/api/admin/businesses/route.ts POST handler: add website to the INSERT columns
     and values (${data.website ?? null})
   - In the PATCH handler for /api/admin/businesses/[id]: allow website updates

4. Update onboarding form (src/app/(admin)/businesses/new/page.tsx):
   - After PlaceAutocomplete fires onPlaceSelect(place), auto-trigger a fetch to
     /api/admin/businesses/prefill?place_id={place.placeId}
   - While fetching: show small loading spinners on category, phone, website fields
   - On success: pre-fill fields only if they're currently empty (don't override manual input)
     Use react-hook-form's setValue() with { shouldDirty: false }
   - On failure: silently ignore — fields remain empty for manual entry
   - Add a website text input field to the form (optional, below the business name section)

Write tests: SerpAPI prefill module (4 cases), prefill API rate limiting, Zod schema accepts website.
Verify existing onboarding and settings tests still pass.
```

**Prompt 20d — Email Deliverability + Bounce Handling**

Prerequisite: Migration 017 must be applied (adds businesses.owner_email_bounced column).

```
Ensure approval emails and value reports land in inboxes by adding List-Unsubscribe headers,
email category tagging, hard bounce detection, and email health monitoring.

1. Add email categories and List-Unsubscribe headers to src/lib/notifications/email.ts:
   - Define: type EmailCategory = 'transactional' | 'marketing' | 'internal'
   - Create helper: getEmailHeaders(category: EmailCategory) returns headers object
     - marketing: { 'List-Unsubscribe': '<mailto:unsubscribe@yourdomain.com?subject=unsubscribe>',
       'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }
     - transactional and internal: empty object (no unsubscribe header)
   - Update sendApprovalEmail: category = 'transactional', no List-Unsubscribe
   - Update sendInternalEmail: add optional category parameter (default 'internal'),
     include appropriate headers and Resend tags: [{ name: 'category', value: category }]
   - Update all worker call sites to pass the correct category:
     - Weekly value report, monthly impact, onboarding drips, owner nudge: category = 'marketing'
     - Manual post instructions, partner alerts, admin exceptions: category = 'internal'
   - Write tests: List-Unsubscribe present on marketing, absent on transactional/internal

2. Hard bounce handling in worker/ingress/resend.ts:
   - In the email.bounced case, check the bounce type from the event data
   - If hard bounce: UPDATE businesses SET owner_email_bounced = true WHERE id =
     (SELECT business_id FROM notification_deliveries WHERE external_message_id = $emailId LIMIT 1)
   - Also send an internal alert email to ADMIN_NOTIFICATION_EMAIL about the hard bounce
   - Update the failure_reason to include bounce type: 'bounced:hard' or 'bounced:soft'

3. Skip bounced businesses in notification-sending workers:
   - In worker/jobs/NotificationWorker.ts: after reading the business, check
     business.owner_email_bounced. If true: log warning, markOutboxCompleted, return.
   - In worker/jobs/EngagementMonitorPoller.ts: add owner_email_bounced to the business
     query. Skip businesses where it's true for owner_nudge alerts (partner alerts still
     send to admin email, not the bounced owner email).

4. Email health metrics on admin overview:
   - In src/app/api/admin/overview/route.ts: add a query aggregating notification_deliveries:
     sent (24h), delivered (24h), bounces (7d), complaints (7d)
   - Include in response under systemHealth.emailHealth
   - In src/app/(admin)/overview/page.tsx: add "Email Health" card to system health bar
     showing delivery rate percentage, bounce count, complaint count
     Red badge if delivery rate < 95% or any complaints in 7 days

5. Create docs/email-deliverability.md — documentation only, not code:
   - DNS authentication checklist: SPF (Resend adds automatically), DKIM (3 CNAMEs from Resend),
     DMARC (TXT record: v=DMARC1; p=none; rua=mailto:dmarc@yourdomain.com)
   - Warmup schedule: Week 1 (5-10/day internal), Week 2 (20-30/day first customers),
     Week 3+ (organic). Key rule: stagger onboarding 2-3 customers/week.
   - Monitoring: Resend dashboard weekly, admin overview email health daily
   - Troubleshooting table: spam, hard bounce, soft bounce, complaint

Write tests: email headers (marketing vs transactional), hard bounce flags business,
NotificationWorker skips bounced businesses. Verify all existing email tests pass.
```

**Prompt 20e — Operational Runbook + Smoke Test Checklist**
```
Create operational documentation for launch readiness. This prompt produces Markdown documents
and one small UI addition — no worker or pipeline changes.

1. Create docs/operational-runbook.md with 5 sections:

   Section A — "Customer says X" troubleshooting (5 scenarios):
   - "I never got the approval email": check /admin/notifications, notification_deliveries,
     job_outbox for stuck send_notification, responses status. Fix: reset outbox, verify email,
     clear bounce flag.
   - "The response doesn't sound like me": check tone, avoid_facts, sample_responses, voice
     learning status. Fix: update business context in admin.
   - "I approved but it's not posted on Google": check responses.status = awaiting_manual_post.
     Fix: sales partner posts manually from admin page.
   - "I'm getting too many emails": check opt-out flags. Fix: toggle in settings or admin.
   - "My reviews aren't being picked up": check last_sync_at, subscription_status, google_place_id,
     failed sync_reviews in admin jobs. Fix: check SerpAPI quota, re-validate place ID.

   Section B — Daily health check (2 minutes):
   - Open /admin/overview, check: failed jobs=0, pending outbox<50, notification failures(24h)=0,
     cost<80% limit, email delivery rate>95%

   Section C — Debugging SQL queries (6 queries with exact SQL):
   - Trace review via correlation_id, find stuck outbox, check business activity,
     reset stuck outbox entry, check today's costs, find bounced businesses

   Section D — Incident response (6 scenarios):
   - Worker crash, Redis unavailable, Supabase unavailable, SerpAPI exhausted,
     LLM provider down, cost circuit breaker tripped
   - For each: what happens automatically, what you need to do manually

   Section E — Weekly maintenance tasks:
   - Resend dashboard, Stripe dashboard, /admin/costs, SerpAPI quota

2. Create docs/smoke-test-checklist.md — 14-step pre-launch verification:
   Requires 3 real businesses, MOCK_EXTERNAL_APIS=false, real API keys, Stripe test mode.
   - Business A: full happy path (onboard with prefill, Stripe checkout, sync, approval email,
     approve on mobile, mark as posted)
   - Business B: edit flow + concurrent onboarding (no interference between businesses)
   - Business C: regeneration + correlation ID tracing
   - System health: all 3 businesses in admin overview, costs tracked, notifications logged,
     email health card, notification failover after 4+ hours

3. Add runbook link to admin navigation:
   - Add a "Runbook" link to src/components/AdminNav.tsx
   - Create a minimal src/app/(admin)/runbook/page.tsx that renders the Section A
     troubleshooting table as a quick-reference page (pulls from the same content,
     formatted for the web)

No new tests (this is documentation). The smoke test checklist IS the test.
```

### Sprint 6 done when
- [ ] Correlation IDs trace any review from ingestion to posting: `SELECT * FROM job_outbox WHERE payload->>'correlation_id' = ? ORDER BY created_at` returns the full chain
- [ ] All 12 workers use createWorkerLogger with correlation ID in log output
- [ ] All 9 pollers/schedulers generate correlation IDs when creating outbox entries
- [ ] Cross-outbox chains (sync → generate → notify → publish) carry the same correlation ID
- [ ] ArchivalPoller handles 5 targets: outbox (7d), events (30d), demos (30d), api_costs (90d with rollup), notification_deliveries (90d)
- [ ] api_costs rows > 90 days are aggregated into api_costs_daily_rollups before deletion
- [ ] Admin costs page transparently queries rollup data for historical date ranges
- [ ] Onboarding form pre-fills category, phone, website from SerpAPI within 2 seconds of Place selection
- [ ] Pre-fill fields are editable (not locked) and failure degrades gracefully (empty fields)
- [ ] businesses.website column exists and is editable in both onboarding and admin detail page
- [ ] SerpAPI pre-fill calls are cost-tracked in api_costs table
- [ ] All customer marketing emails have List-Unsubscribe headers; transactional emails do not
- [ ] Resend sends are tagged by category (transactional/marketing/internal)
- [ ] Hard bounces set businesses.owner_email_bounced = true and alert the sales partner
- [ ] NotificationWorker and EngagementMonitorPoller skip businesses with bounced email flag
- [ ] Admin overview shows email health card: delivery rate, bounce count, complaint count
- [ ] SPF/DKIM/DMARC verification documented in docs/email-deliverability.md
- [ ] Warmup schedule documented: stagger 2-3 customers/week in first month
- [ ] Operational runbook covers 5 common customer complaints with step-by-step Check/Fix
- [ ] Runbook includes debugging SQL queries, incident response playbook, weekly maintenance
- [ ] Smoke test checklist documents 14-step pre-launch verification with 3 real businesses
- [ ] Admin nav includes Runbook link

### Deferred to Sprint 7
- [ ] PostHog analytics integration (add after customer #5)
- [ ] Voice learning edit_distance tracking via PostHog
- [ ] k6/Artillery load testing (add when there's real traffic to profile)
- [ ] Supabase connection pool monitoring alerts

---

## GBP API Integration (When Approved — Variable Timeline)

**This is NOT a sprint with a fixed schedule.** Start this the moment your GBP API access is approved. It can run in parallel with serving customers from Sprints 3-6.

Full instructions are in `docs/Implementation_Phases_SerpAPI_First.md`, Phase 5. Key steps:

1. Enable all 8 Business Profile APIs in GCP Console
2. Build OAuth flow for business onboarding (populate `google_connections` table)
3. Set up Pub/Sub for real-time review notifications
4. Add `gbp-api-source.ts` ReviewSource implementation (uses real Google review IDs)
5. Update ResponsePublisherWorker to auto-post via GBP API (branch: if `google_connections` exists, auto-post; otherwise, fall back to manual posting)
6. Switch ReconciliationPoller to adaptive intervals (60/120/240 min) since Pub/Sub becomes the primary path
7. Migrate existing customers: OAuth flow → backfill `google_connections` → switch `provider` from `'serpapi_poll'` to `'google'` → enable Pub/Sub → disable SerpAPI polling

The architecture was designed so this is a mechanical swap — same outbox, same workers, same approval flow, same dedup logic. SerpAPI drops to demo-only usage (~$5/month).

---

## MCP Usage Reference

| MCP | When to use | Sprint |
|---|---|---|
| **Supabase** | Database queries, migrations, checking table data, debugging data issues | All sprints |
| **Context7** | Looking up library docs (SerpAPI, BullMQ, Resend, Stripe SDKs, Next.js App Router) before implementing | Sprints 1-3 |
| **Playwright** | Writing and running E2E tests for approval flow, demo pages, admin pages | Sprints 2-4 |
| **Sentry** | Setting up error tracking, checking error reports, debugging production issues | Sprints 3+ |
| **Google Chrome Dev** | Debugging approval page rendering, mobile responsiveness, performance profiling | Sprints 2-4 |

---

## Daily Workflow With Claude Code

1. **Start of day**: Open Claude Code, it reads CLAUDE.md automatically
2. **Before each prompt**: Update the "Current status" section in CLAUDE.md
3. **Each prompt**: Reference the specific prompt number from this plan (e.g., "Do Prompt 7 from the implementation plan")
4. **After each prompt**: Test the output, commit working code, update status
5. **End of day**: Update CLAUDE.md with what was completed and any issues

## Key Rule
Never prompt Claude Code to build something not in this plan without first updating CLAUDE.md with the new context. The CLAUDE.md file is the contract — if it's not in there, Claude Code will make assumptions that conflict with the architecture.
