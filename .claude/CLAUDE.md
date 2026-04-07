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
- **Worker**: Standalone Node.js process (Railway) — Fastify HTTP server (webhook ingress) + BullMQ consumers + OutboxPoller
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
│   ├── db/                 # Supabase client, query helpers
│   ├── reviews/            # ReviewSource interface, SerpAPI source + monitor
│   ├── responses/          # Response generator, prompt builder
│   ├── approval/           # ApprovalService, token management
│   ├── notifications/      # Resend email service
│   ├── publishing/         # Manual posting workflow (GBP API stub)
│   ├── costs/              # CostTracker, circuit breaker
│   ├── demos/              # Demo generation pipeline
│   └── shared/             # Types, utils, constants
└── types/                  # Shared TypeScript interfaces

worker/                     # Railway worker (separate process, at project root)
├── index.ts                # Entry point — `npx tsx worker/index.ts`
├── queues.ts               # BullMQ queue definitions
├── jobs/                   # Workers: ReviewSync, ResponseGenerator, DemoGeneration, etc.
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

## Current status
- Sprint 1: IN PROGRESS (scaffolding complete, DB migrations next)
- Sprint 2: NOT STARTED
- Sprint 3: NOT STARTED
- Sprint 4: NOT STARTED
- Sprint 5: NOT STARTED
- Sprint 6: NOT STARTED
- GBP API: NOT APPLIED FOR

## MCP servers available
- **Supabase**: Database queries and management
- **Sentry**: Error tracking and monitoring
- **Playwright**: Browser testing
- **Context7**: Library documentation lookup
