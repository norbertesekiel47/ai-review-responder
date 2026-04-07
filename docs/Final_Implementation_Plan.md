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
| Sprint 5 | Create `ranking_snapshots` table | Before Prompt 18 |

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
SerpAPI polling, outbox-driven response generation, email notifications, approval flow, and manual posting.

### Claude Code prompts

**Prompt 7 — OutboxPoller + ReconciliationPoller (Day 6)**
```
Build the outbox infrastructure in the worker service:

1. Create worker/jobs/OutboxPoller.ts following .claude/skills/outbox-pattern.md EXACTLY:
   - Runs every 10 seconds via setInterval
   - Watchdog recovery: reset entries stuck in 'dispatched' for > 1 hour (check attempts vs max_attempts for terminal vs retry)
   - SELECT with FOR UPDATE SKIP LOCKED, batch size 50
   - Dispatch to BullMQ by topic, using outbox entry ID as jobId (idempotent)
   - Handle dispatch failures: retry if under max_attempts, terminal 'failed' if over

2. Create worker/jobs/ReconciliationPoller.ts:
   - BullMQ repeatable job every 60 minutes
   - Queries active businesses using `businesses.last_sync_at` (NOT google_connections — those are empty in SerpAPI mode):
     WHERE subscription_status = 'active' AND (last_sync_at IS NULL OR last_sync_at < NOW() - INTERVAL '60 minutes')
   - Writes sync_reviews outbox entries for each business (payload includes business_id and google_place_id)
   - This is the PRIMARY ingestion path while using SerpAPI
   - When GBP API arrives: this becomes the fallback path with adaptive intervals (60/120/240 min)
```

**Prompt 8 — ReviewSyncWorker (Day 7)**
```
Build worker/jobs/ReviewSyncWorker.ts that processes sync_reviews jobs:

1. Fetch reviews via the serpapi-monitor.ts module built in Prompt 4 (production mode, NOT the demo serpapi-source.ts). This returns reviews with pre-computed identity fields (provider_review_id, provider_review_name, provider_location_name) and content hashes. If SerpAPI returns an empty array (business has no reviews), skip to step 3 — update last_sync_at and return.

2. For EACH review, inside a Postgres transaction (use `sql.begin()` from the Postgres.js client created in Prompt 3):
   - Read existing review row with FOR UPDATE lock to get current review_content_hash BEFORE the upsert overwrites it (the upsert's RETURNING would return the NEW hash, making comparison useless)
   - Use the identity fields DIRECTLY from serpapi-monitor output — do NOT recompute identity in the worker. The monitor already applied the tiered identity strategy (source ID → fallback with profile URL → last resort hash). Fields: provider, provider_review_id, provider_review_name, provider_location_name, review_content_hash.
   - Upsert the review using ON CONFLICT (provider, provider_review_name)
   - If NEW (no existing row): insert job_outbox entry topic='generate_response' in SAME transaction
   - If CONTENT CHANGED (review_content_hash differs) and response is pending: set old response status to 'failed' with reason 'Review updated by reviewer', insert new generate_response outbox entry
   - If CONTENT CHANGED and response is posted: insert review_exceptions row with type='review_edited_after_post' + notify_admin_review_exception outbox entry. ON CONFLICT DO NOTHING on the unique partial index to prevent notification storms.
   - If unchanged: skip silently (no action needed)

3. Update `businesses.last_sync_at = NOW()` for this business

4. ROI baseline capture: after syncing, if `businesses.baseline_captured_at IS NULL`, this is the first sync for this business. Count total reviews ingested and how many already have owner replies (from SerpAPI data if available, or default to 0). Write `initial_review_count`, `initial_responded_count`, `baseline_captured_at = NOW()` to the businesses table. This baseline powers Sprint 5's "before us vs after us" ROI dashboard. Do NOT capture baseline during onboarding (reviews haven't been synced yet at that point).

Critical: the review upsert and outbox entry MUST be in the same transaction (sql.begin). This is the #1 silent data loss vector per the plan. If the worker crashes between them, the review sits in 'new' status forever with no generation job queued.
```

**Prompt 9 — ResponseGeneratorWorker (Day 8)**
```
Build worker/jobs/ResponseGeneratorWorker.ts with the FULL implementation:

1. Consumes generate_response jobs
2. Cancellation guard: check business.subscription_status — if 'cancelled' or 'past_due', complete the outbox entry and skip silently. This prevents burning LLM tokens for businesses that stopped paying.
3. Idempotent cache check: Redis key gen:{reviewId}:v{version}
4. Cost reservation via cost-guard.md pattern
4. Concurrency limiter: max 3 per business
5. Regeneration budget: max 3 per review per day via Redis counter
6. Input sanitization: strip Unicode control chars, null bytes, collapse whitespace
7. Language detection from review
8. Voice learning: getApprovedResponsePairs() — returns [] until ≥5 edited+posted responses exist
9. generateWithGuardrails: check avoid_facts on output, retry once if violated, accumulate cost across retries
10. Fallback from OpenAI to Anthropic
11. Two-phase cost accounting: reserve before, finalize after, NEVER refund after finalization
12. After success, in ONE transaction:
    - Insert response with original_draft_text
    - Insert job_outbox topic='send_notification' (payload has response_id + business_id, NO raw token)
13. Complete originating outbox entry

DO NOT generate approval tokens here. That happens in NotificationWorker.
```

**Prompt 10 — NotificationWorker + email + delivery tracking (Day 9)**
```
Build the notification system:

1. Create src/lib/notifications/email.ts:
   - Uses Resend SDK
   - sendApprovalEmail(to, reviewData, responsePreview, approvalUrl, businessName)
   - Clean mobile-friendly HTML template with:
     - Subject: "New review for [Business Name] — response ready for approval"
     - Star rating as visual stars
     - Reviewer name and date
     - Review text (truncated to 200 chars — full text on approval page)
     - Draft response preview (first 100 chars)
     - Big "Review & Approve" button linking to /approve/{token}
     - "This link expires in 48 hours"
   - Returns the Resend message ID for delivery tracking

2. Create worker/jobs/NotificationWorker.ts:
   - Consumes send_notification jobs
   - Subscription guard: read business, skip if subscription_status is 'cancelled', 'past_due' (beyond grace), or 'pending_payment' — do NOT send approval emails to owners of unpaid businesses. Complete outbox entry and return.
   - Reads response + review + business from database
   - Generates approval token HERE: `import { randomUUID } from 'node:crypto'` then randomUUID()
   - Stores ONLY SHA-256(token) in approval_links with 48-hour TTL. Use `createHash('sha256').update(rawToken).digest('hex')`.
   - Constructs approval URL with the raw token
   - Sends email via Resend
   - Writes to notification_deliveries with the external_message_id from Resend
   - The raw token is NEVER persisted in Postgres or outbox payloads
   - Complete outbox entry

3. Create worker/ingress/resend.ts — Resend delivery webhook handler:
   - Verify webhook signature (Resend signs webhooks with a secret)
   - Write to inbound_events for deduplication (external_event_key = Resend event ID)
   - Handle events:
     - email.delivered: update notification_deliveries.delivered_at
     - email.bounced: update notification_deliveries.failed_at + failure_reason
     - email.complained: update notification_deliveries.failed_at + failure_reason
   - Without this handler, the admin notification log will show all emails as "pending" forever

4. Point the Resend webhook directly at the Railway ingress endpoint in production. Do NOT create a Vercel forwarding route for this.
```

**Prompt 11 — Approval flow (Days 10-11)**

Use **Playwright MCP** for E2E testing:
```
Build the complete approval system:

1. Create src/lib/approval/service.ts per .claude/skills/approval-security.md:
   - establishApprovalSession(rawToken, deviceCookieHash)
   - approve(rawToken, deviceCookieHash): transaction: consume link + revoke siblings + update response + insert publish_response outbox
   - edit(rawToken, editedText, deviceCookieHash): same + store edited_text + compute Levenshtein edit_distance
   - regenerate(rawToken, deviceCookieHash): in ONE transaction: consume link + revoke ALL sibling links + mark the OLD response as `superseded` (UPDATE responses SET status = 'superseded' WHERE id = old_response_id) + insert generate_response outbox with version+1. This enforces the invariant: at most one non-terminal response per review at a time.
   - lockValidLink(): FOR UPDATE inside transaction, validates hash + device cookie + expiry
   - ALL approval actions (approve, edit, regenerate, session_bind) MUST write to approval_audit_log in the same transaction: token_hash, device_cookie_hash, action, ip_address, response_id, business_id

2. Create src/lib/approval/cookies.ts — device cookie + CSRF implementation:
   - DEVICE COOKIE: On GET /approve/:token, if no `__device` cookie exists, generate a random value via `randomUUID()`, HMAC-sign it with `SESSION_COOKIE_SECRET` (`createHmac('sha256', secret).update(value).digest('hex')`), set the signed value as cookie `__device` with attributes: `Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=172800` (48h matching token TTL). The `device_cookie_hash` stored in `approval_links` is `SHA-256(cookie_value)`.
   - CSRF: Use double-submit cookie pattern. On GET /approve/:token, generate a random CSRF token via `randomUUID()`, set it as cookie `__csrf` with `Secure; SameSite=Lax; Path=/` (NOT HttpOnly — JS needs to read it). Client JS reads the cookie and sends it as `x-csrf-token` header on all POST requests. Server validates: header value === cookie value.
   - Export helpers: `setDeviceCookie(res)`, `getDeviceCookieHash(req)`, `setCsrfCookie(res)`, `validateCsrf(req)`.

3. Create API routes:
   - GET /api/approve/[token] — read-only, returns review + response data, sets device cookie + CSRF cookie. MUST set `Cache-Control: no-store, private` — these responses contain sensitive review/draft content behind a bearer-style token and must never be cached by browsers, proxies, or shared devices. Rate limit: 10 lookups per minute per IP (prevents token enumeration reconnaissance).
   - POST /api/approval/session — binds device cookie hash. Requires device cookie present.
   - POST /api/approve/[token]/approve — requires device cookie + CSRF header
   - POST /api/approve/[token]/edit — requires device cookie + CSRF header
   - POST /api/approve/[token]/regenerate — requires device cookie + CSRF header
   All approval API responses (GET and POST) must include `Cache-Control: no-store, private`.
   Error responses should distinguish: expired token ("This link has expired"), revoked/superseded token ("A newer version was generated — check your email for the latest link"), invalid token ("Invalid link"), device conflict ("This link is already open on another device"), already processed ("Already approved").

3. Create src/app/(public)/approve/[token]/page.tsx:
   - SSR returns minimal shell (business name + "Review a draft response") — NO review text in initial HTML
   - Client-side fetch loads actual content via TanStack Query
   - Mobile-first: review card + editable response + approve/edit/regenerate buttons
   - On approve: show "Response approved! We'll post it to Google shortly."
   - On edit: inline editor, save button
   - On regenerate: loading state, then new draft

4. Write Playwright E2E tests:
   - Owner clicks link → approve → confirmation
   - Owner clicks link → edit → save → confirmation  
   - Owner clicks expired link → expiration message
   - Owner clicks link → regenerate → new draft appears → approve new
```

**Prompt 12 — Manual posting + AdminExceptionWorker (Days 12-13)**
```
Build the posting workflow for SerpAPI mode:

1. Create worker/jobs/ResponsePublisherWorker.ts:
   - Consumes publish_response jobs
   - Subscription guard: read business, skip if subscription_status is 'cancelled'. Complete outbox entry and return. (Past_due within grace period is allowed — the response was already approved.)
   - Updates response status to 'awaiting_manual_post'
   - Sends internal email to admin/sales partner via Resend:
     - Business name, approved response text, Google Maps link
     - Instructions to copy-paste as owner reply
   - Complete outbox entry

2. Create worker/jobs/AdminExceptionWorker.ts:
   - Consumes notify_admin_review_exception jobs
   - Sends email to admin about review-edited-after-post
   - Checks if exception is already resolved (skip if so)
   - Complete outbox entry

3. Add "Mark as Posted" to admin business detail page:
   - Show responses with status 'awaiting_manual_post'
   - "Copy to Clipboard" button + "Mark as Posted" button
   - Mark as Posted: updates status to 'posted', sets posted_at

4. Run full end-to-end test:
   - Add real business → wait for poll → verify review in DB → verify response generated → verify email received → approve → verify awaiting_manual_post → mark as posted
```

### Sprint 2 done when
- [ ] Reviews polled every 60 minutes via SerpAPI using serpapi-monitor.ts
- [ ] Review dedup works: synthetic identity (SHA-256 of name+date) + content hash for edit detection
- [ ] AI responses generated automatically for new reviews
- [ ] Email notifications sent with approval links (delivery tracked via Resend webhooks)
- [ ] Approval page works on mobile: approve, edit, regenerate
- [ ] Approval tokens stored as SHA-256 hashes only — raw tokens never persisted
- [ ] Owner sees "we'll post it shortly" — manual posting invisible to them
- [ ] Cost circuit breaker works (per-business + global daily limits)
- [ ] Review edit detection works: edited reviews trigger regeneration (if pending) or admin exception (if posted)
- [ ] E2E tests pass in Playwright

---

## Sprint 3: Admin Dashboard + Payments (Days 14–19)

### Claude Code prompts

**Prompt 13 — Admin dashboard + authentication + business management (Days 14-15)**
```
Build the sales partner admin dashboard with proper authentication:

FIRST — Bootstrap admin identity + set up Supabase Auth:
- Configure Supabase Auth in the Supabase dashboard (enable email/password provider)
- BOOTSTRAP: Create the first admin and sales_partner accounts. Either:
  (a) Use the Supabase dashboard (Authentication → Users → Add User) to create auth accounts for your admin and sales partner emails, then run a seed script:
      UPDATE users SET auth_id = '<auth-user-uuid>' WHERE email = 'admin@yourdomain.com';
      UPDATE users SET auth_id = '<auth-user-uuid>' WHERE email = 'partner@yourdomain.com';
  (b) Or create a one-time seed script (supabase/seed.ts) that uses the Supabase Admin API to create auth accounts and users rows in one step.
  Without this bootstrap step, the admin dashboard will be fully implemented but inaccessible.
- Create src/lib/db/auth.ts with helpers: getCurrentUser(), requireAuth(), requireRole('admin' | 'sales_partner' | 'owner')
- Define the identity mapping explicitly: `auth.users.id` -> `users.auth_id`. When onboarding an owner, create or invite the Supabase Auth user and persist the linked `users` row in the same flow.
- Create middleware.ts that protects route groups:
  - (admin)/* routes: require role = 'admin' or 'sales_partner'
  - (authenticated)/* routes: require role = 'owner' and business_id matches
  - (public)/* routes: no auth required (approval pages are token-based)
- Create a login page at /login for admin and owner access
- Split Supabase clients explicitly:
  - browser/client auth helper uses `NEXT_PUBLIC_SUPABASE_URL` + `NEXT_PUBLIC_SUPABASE_ANON_KEY`
  - server/worker helper uses `SUPABASE_URL` + `SUPABASE_SERVICE_KEY`
  - never import the service-role client into browser code
- Add RLS policies or keep all data access server-only. Do NOT leave owner-readable tables effectively wide open because "the app checks auth anyway".

THEN — Build the admin pages:

1. /admin/overview page:
   - System health bar: pending outbox, queue depth, failed jobs, today's cost, notification failures 24h
   - Business table: name, status, pending approvals, response rate, avg response time, last activity
   - Sort by pending approval count (most urgent first)
   - Click row → /admin/businesses/[id]
   - Use TanStack Query with 30-second polling for real-time feel

2. /admin/businesses/[id] page:
   - Business profile + settings (inline editable)
   - Review list with color-coded response status
   - Pending approvals + awaiting manual post sections
   - Copy to clipboard + Mark as Posted buttons

3. /admin/businesses/new page — onboarding form:
   - Business name, category, Google Maps URL (auto-parse Place ID via url-parser.ts)
   - Owner name, email, phone
   - Tone, products/services, staff names, highlight facts, avoid facts
   - Sample owner responses (paste 2-3 examples)
   - Subscription tier selector
   - ROI baseline: do NOT capture during onboarding — reviews haven't been synced yet. The ReviewSyncWorker (Prompt 8) automatically captures the baseline after the first sync when `baseline_captured_at IS NULL`. The onboarding form just needs the baseline columns to exist on the `businesses` table (added in the Sprint 3 migration checklist).
   - On submit: create business (subscription_status='pending_payment') + create user (role='owner') + write ONE sync_reviews outbox entry for an immediate initial sync as a trial/demo (this one-time sync is allowed before payment — it gives the customer an immediate "wow" moment during the onboarding call). The ReconciliationPoller will NOT pick up this business for recurring polls until Stripe confirms payment and sets subscription_status='active'.

4. /admin/costs page:
   - Cost breakdown by provider, by business, by day
   - Businesses exceeding thresholds highlighted
   - Today's total platform spend vs. global daily limit

5. /admin/notifications page:
   - Delivery log with filters by business, channel, status (delivered, failed, pending)
   - Shows: business name, channel, recipient, template, sent_at, delivered_at, failed_at, failure_reason
   - Essential for troubleshooting "I never got the notification" complaints

6. /admin/jobs page — operational health (from Implementation_Phases 4.4):
   - Outbox health: pending, dispatched, failed counts from job_outbox
   - BullMQ queue depths per topic (sync_reviews, generate_response, etc.)
   - Failed jobs with error details and last_error text for manual investigation
   - This is the engineering troubleshooting page — essential for diagnosing silent failures

All admin pages require Supabase Auth with role = admin or sales_partner.

PAGINATION: All list views (business table, review list, notification log, jobs page) must support cursor-based or offset pagination from the start. Use TanStack Query's `useInfiniteQuery` or page-based fetching with `limit` + `offset` params. Without pagination, these pages will degrade as data grows — the notification log alone grows by ~10 rows/week/business.
```

**Prompt 14 — Stripe integration (Day 16)**
```
Integrate Stripe payments:

1. Create Stripe Payment Links for each tier in Stripe dashboard (I'll do this manually)

2. Build worker/ingress/stripe.ts and mount on the Fastify server created in Prompt 3:
   - Use the rawBody from @fastify/raw-body for stripe.webhooks.constructEvent(rawBody, sig, secret) — this is why Prompt 3 set up Fastify with raw-body support
   - Verify webhook signature — MUST use raw body, not parsed JSON
   - Write to inbound_events (deduplicate by Stripe event ID)
   - Handle: checkout.session.completed → set subscription_status='active' (this is the transition from pending_payment, which unlocks recurring polling)
   - Handle: invoice.payment_failed → mark past_due
   - Handle: customer.subscription.deleted → mark cancelled
   - Handle: customer.subscription.updated → update tier if changed

3. Point the Stripe webhook directly at the Railway ingress endpoint (e.g., https://yourworker.railway.app/ingress/stripe) in production. Do NOT create a Vercel forwarding route for this.

4. Update business onboarding to include Stripe customer creation
```

**Prompt 15 — Security hardening (Days 17-18)**

Use **Sentry MCP** for error tracking setup:
```
Harden the application:

1. Rate limiting on all public endpoints:
   - /api/approve/*/approve|edit|regenerate: 3 per token per minute
   - /api/approve/*/regenerate: additionally enforce max 3 regenerations per review per day via Redis counter regen:{reviewId}:{date} (prevents cost amplification attacks)
   - /api/admin/demos/generate: 50 per day (prevent SerpAPI cost runaway)
   - /api/webhooks/*: 100 per minute per source IP
   - Use Redis CACHE instance (not queue instance) for rate limit counters

2. Set up Sentry for error tracking:
   - Initialize in both Next.js app and Railway worker
   - Capture all unhandled errors
   - Add breadcrumbs for outbox operations
   - Set up source maps for readable stack traces
   - Configure `beforeSend` hook to scrub sensitive values: strip API keys (OPENAI_API_KEY, SERPAPI_API_KEY, STRIPE_SECRET_KEY), raw approval tokens, webhook secrets, and session secrets from error payloads. Use pattern matching (keys containing 'key', 'secret', 'token') as a safety net.

3. Input sanitization:
   - Use isomorphic-dompurify (NOT dompurify — needs jsdom for SSR/worker) for review text rendered in approval page
   - Validate and sanitize all business settings inputs with Zod schemas
   - Review text sanitization in the worker: strip Unicode control chars, null bytes, collapse whitespace (already in ResponseGeneratorWorker)

4. Audit logging:
   - Approval actions are already logged to approval_audit_log table (added in Prompt 11)
   - Verify all actions are captured: who (device hash), when, what (approve/edit/regenerate/session_bind), token hash, IP address
   - Queryable by response_id and business_id

5. CSRF protection on all approval POST endpoints:
   - Set CSRF cookie on GET /approve/:token
   - Require CSRF token in body/header on all POST actions

6. Webhook signature verification:
   - Stripe: verify using stripe.webhooks.constructEvent()
   - Resend: verify webhook signature header
   - All webhook handlers MUST write to inbound_events first (deduplicate by external event ID) before processing. This prevents double-processing from webhook retries.

7. Security headers:
   - Vercel: add `headers` config in `next.config.js` or `vercel.json`:
     - `Strict-Transport-Security: max-age=63072000; includeSubDomains` (Vercel serves HTTPS but doesn't set HSTS by default on custom domains)
     - `Content-Security-Policy: script-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'` — defense in depth against XSS on the approval page which renders user-generated review text
     - `X-Content-Type-Options: nosniff`
     - `X-Frame-Options: DENY`
   - Railway Fastify: set the same headers on the Fastify server for ingress endpoints (`Strict-Transport-Security`, `X-Content-Type-Options`).
```

### Sprint 3 done when
- [ ] Supabase Auth configured: admin, sales_partner, and owner roles enforced
- [ ] Sales partner can onboard clients in under 5 minutes
- [ ] Admin overview shows all businesses with health indicators
- [ ] Admin jobs page shows outbox + queue health with failed job details
- [ ] Admin notifications page shows delivery log with status (delivered/failed/pending)
- [ ] Stripe payments work end-to-end
- [ ] Rate limiting active on all public endpoints (including regenerate daily cap)
- [ ] Sentry capturing errors from both Vercel and Railway
- [ ] All webhook handlers (Stripe, Resend) deduplicate via inbound_events
- [ ] Approval actions audit-logged to approval_audit_log table

---

## Sprint 4: Production Hardening (Weeks 5–6)

### Claude Code prompts

**Prompt 16 — Monitoring + weekly summaries**
```
Build production hardening features:

1. Notification failover:
   - BullMQ repeatable job every 2 hours
   - Find responses in pending_approval for >4 hours with no successful delivery
   - Alert admin via email

2. Weekly summary worker:
   - Runs Monday 8 AM via BullMQ cron
   - Timezone rule for MVP: use a single platform timezone (America/Los_Angeles or UTC) for all businesses. Store the chosen timezone as a constant. When businesses span time zones later, add a `timezone` column to `businesses` and schedule per-business using their local 8 AM — but do NOT over-engineer this now.
   - For each active business: count reviews, count responses, flag 1-2 star reviews
   - Subscription guard: skip `cancelled` businesses, skip `pending_payment` businesses
   - Send summary email via Resend
   - Save to weekly_summaries table

3. Outbox + event archival:
   - Daily cron: archive completed outbox >7 days, processed events >30 days, expired demos >30 days

4. Correlation IDs:
   - Generate x-correlation-id at entry points
   - Propagate through outbox payloads and BullMQ job data
   - Include in all log output

5. PostHog integration:
   - Track: demo generated, review synced, response generated, approval action, response posted
   - Track: edit rate per business (quality metric)
```

**Prompt 17 — Load + security testing**

Use **Playwright MCP**:
```
Write comprehensive tests:

1. Page load tests (Playwright):
   - 50 concurrent demo page loads
   - 100 approval page loads per minute
   - Verify no errors under load

1b. System load tests (k6 or Artillery — NOT Playwright):
   Playwright tests page rendering, not backend throughput. Install k6 (pnpm add -D k6) or Artillery for these:
   - Flood webhook ingress endpoints: 100 Stripe/Resend webhook POSTs per minute
   - Queue stress: inject 200 outbox entries, verify OutboxPoller processes all within 30 seconds
   - Worker concurrency: 10 simultaneous generate_response jobs for the same business, verify concurrency limiter holds at 3
   - Redis contention: cost reservation under parallel load, verify no budget drift

2. Security tests (Vitest):
   - Prompt injection via review text → verify sanitization
   - Cost amplification via regenerate spam → verify rate limit + daily budget
   - Token enumeration → verify hash-only storage
   - Webhook replay → verify inbound_events deduplication
   - Expired token → verify rejection

3. Integration tests (Vitest + real Supabase):
   - Full pipeline: review → generation → notification → approval → manual post
   - Outbox replay recovery: simulate Redis failure, verify poller recovers
   - Cost limit exceeded → circuit breaker → admin alert
   - LLM failover: OpenAI down → Anthropic succeeds
   - Idempotency: replay any outbox entry → no duplicate responses
```

### Sprint 4 done when
- [ ] Monitoring alerts fire for all failure modes
- [ ] Weekly summaries go out Monday mornings
- [ ] Outbox archival prevents table bloat
- [ ] Load tests pass at 10x current volume
- [ ] Security tests pass for all attack vectors
- [ ] System runs 10 businesses with zero engineering intervention

---

## Sprint 5: Churn Killers (Weeks 7–8)

### Claude Code prompts

**Prompt 18 — ROI dashboard + intelligence brief**
```
Build the churn prevention features:

1. Update /dashboard page with ROI stats:
   - Response rate: before us vs after us (calculate "before" from review history at onboarding time)
   - Average response time
   - Total reviews handled
   - Review velocity: new reviews per week, last 4 weeks as a simple bar/line

2. Add ranking_snapshots table (migration):
   - business_id, keyword, rank_position, search_location, snapshot_date, source
   - Admin form to manually enter weekly rank data
   - Display on owner dashboard as position-over-time line chart

3. Upgrade WeeklySummaryWorker with AI intelligence brief:
   - After collecting week's reviews, send ALL to LLM with summarization prompt
   - Output: 3-5 sentence brief covering recurring themes, new mentions, sentiment trend, one actionable recommendation
   - Include brief in weekly email ABOVE the stats
   - Save summary_text to weekly_summaries table
   - Cost: ~$0.01-0.03 per business per week (negligible)
```

### Sprint 5 done when
- [ ] Owner dashboard shows ROI stats with before/after comparison
- [ ] Weekly email includes AI-generated intelligence brief
- [ ] Ranking tracked manually and displayed

---

## Sprint 6: Scale to $1K MRR (Weeks 9–12)

**Prompt 19 — Voice learning + onboarding automation**
```
Optimize for scale:

1. Voice learning activation:
   - getApprovedResponsePairs() now returns real data for businesses with ≥5 edited+posted responses
   - Include up to 5 most recent edit pairs as few-shot examples in prompts
   - Track edit_distance trends per business via PostHog

2. Onboarding automation:
   - Pre-fill business details from SerpAPI Google Maps search (name, category, address)
   - Auto-trigger initial sync on business creation (don't wait for next polling cycle)
   - Reduce onboarding to 10 minutes

3. Customer health score:
   - Compute from: approval rate, edit rate, response time, review velocity
   - Show in admin overview
   - Flag at-risk customers (low approval rate = not engaging)

4. Data archival:
   - Archive api_costs >90 days (keep daily aggregates)
   - Archive notification_deliveries >90 days
   - Monitor Supabase connection pool + table sizes
```

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
