# RepWorth — Progress Tracking

---

## Sprint 1: Project Scaffolding + Infrastructure

### Phase 1.1 — Project Initialization (2026-04-06)

**Status:** COMPLETE

**What was done:**

1. **Initialized Next.js 14 project** in `C:\Users\norbe\Desktop\RepWorth\`
   - App Router with `src/` directory structure
   - TypeScript strict mode enabled
   - Tailwind CSS v3 + PostCSS + Autoprefixer configured

2. **Installed 22 production dependencies:**
   - Core: `next@14.2.35`, `react@18.3.1`, `react-dom@18.3.1`
   - State/forms: `zustand@5.0.12`, `@tanstack/react-query@5.96.2`, `react-hook-form@7.72.1`, `zod@4.3.6`
   - LLM: `openai@6.33.0`, `@anthropic-ai/sdk@0.82.0`
   - Reviews: `serpapi@2.2.1`
   - Queue/cache: `bullmq@5.73.0`, `ioredis@5.10.1`
   - Email/payments: `resend@6.10.0`, `stripe@22.0.0`
   - Database: `@supabase/supabase-js@2.101.1`, `postgres@3.4.9`
   - Utilities: `franc-min@6.2.0`, `nanoid@5.1.7`, `isomorphic-dompurify@3.7.1`, `uuid@13.0.0`
   - Worker HTTP: `fastify@5.8.4`, `fastify-raw-body@5.0.0`

3. **Installed 11 dev dependencies:**
   - `typescript@5.9.3`, `@types/react@18.3.28`, `@types/react-dom@18.3.7`, `@types/node@25.5.2`
   - `tailwindcss@3.4.19`, `postcss@8.5.8`, `autoprefixer@10.4.27`
   - `eslint@8.57.1`, `eslint-config-next@14.2.35`
   - `vitest@4.1.2`, `@playwright/test@1.59.1`

4. **Configured tsconfig.json:**
   - `strict: true`, `noUncheckedIndexedAccess: true`
   - Path aliases: `@/*` -> `./src/*`, `@/lib/*` -> `./src/lib/*`, `@/types/*` -> `./src/types/*`
   - Worker can import shared code via `@/lib/` and `@/types/`

5. **Created full directory structure with placeholder files:**

   **App pages (12 routes across 3 route groups):**
   - `src/app/(public)/` — Landing page (`/`), Demo viewer (`/demo/[slug]`), Approval page (`/approve/[token]`)
   - `src/app/(authenticated)/` — Dashboard (`/dashboard`), Settings (`/settings`)
   - `src/app/(admin)/` — Overview (`/overview`), Businesses (`/businesses`, `/businesses/[id]`), Demos (`/demos`), Notifications (`/notifications`), Costs (`/costs`), Jobs (`/jobs`)

   **Lib modules (9 modules):**
   - `src/lib/db/`, `src/lib/reviews/`, `src/lib/responses/`, `src/lib/approval/`
   - `src/lib/notifications/`, `src/lib/publishing/`, `src/lib/costs/`
   - `src/lib/demos/`, `src/lib/shared/`

   **Shared types:**
   - `src/types/index.ts`

   **Worker (at project root, per CLAUDE.md):**
   - `worker/index.ts` — Entry point (Fastify + BullMQ + OutboxPoller)
   - `worker/queues.ts` — BullMQ queue definitions
   - `worker/jobs/` — 7 workers: ReviewSync, ResponseGenerator, Notification, ResponsePublisher, WeeklySummary, DemoGeneration, OutboxPoller
   - `worker/ingress/` — Stripe and Resend webhook handlers

6. **Created configuration files:**
   - `next.config.mjs` — React strict mode, postgres in serverComponentsExternalPackages
   - `tailwind.config.ts` — Content paths for `src/app/` and `src/components/`
   - `postcss.config.mjs` — Tailwind + Autoprefixer
   - `.eslintrc.json` — extends `next/core-web-vitals`
   - `.gitignore` — node_modules, .next, .env.local, etc.

7. **Created `.env.local` template** with all required variables:
   - Database: `DATABASE_URL`, `DATABASE_POOL_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`
   - Public Supabase: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - Redis: `REDIS_CACHE_URL`, `REDIS_QUEUE_URL` (two separate instances)
   - LLM: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`
   - Reviews: `SERPAPI_API_KEY`
   - Email: `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`
   - Payments: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`
   - Security: `SESSION_COOKIE_SECRET`, `CSRF_SECRET`
   - App: `NEXT_PUBLIC_APP_URL`, `WORKER_SERVICE_URL`, `SENTRY_DSN`
   - GBP API vars commented out as "Added in Phase 5"
   - Server-only secrets annotated

8. **Verified build passes:** `pnpm build` completes successfully — all 12 pages compile and generate.

9. **Post-validation fixes (same session):**
   - Added `tsx@4.21.0` as dev dependency — worker script was using `npx tsx` (runtime download). Changed to `tsx` (local). `pnpm worker` now exits 0 self-contained.
   - Added `ENCRYPTION_KEY` and `ENCRYPTION_KEY_VERSION` to `.env.local` Security section — were present in `docs/Implementation_Phases_SerpAPI_First.md:223` but missed in initial template.
   - Added bootstrap test file `src/lib/shared/index.test.ts` so `pnpm test` exits 0 instead of failing on empty test suite.

**Decisions & notes:**
- `@fastify/raw-body` does NOT exist on npm (verified 404 on registry). Used `fastify-raw-body@5.0.0` (unscoped name, same functionality, same API).
- `@types/uuid` is deprecated (uuid v13 ships its own types). Not installed.
- Pinned to compatible versions: React 18 types, ESLint 8, eslint-config-next@14, Tailwind v3, TypeScript 5 — all matching Next.js 14 ecosystem.
- Package manager: pnpm 10.17.1

---

### Phase 1.2 — Database Migrations (2026-04-06)

**Status:** COMPLETE

1. **Migration file** `supabase/migrations/001_initial_schema.sql` was created with full schema (15 tables, all indexes, RLS enabled).
2. **User ran migration** directly in Supabase SQL Editor — all tables created successfully.
3. **Supabase project provisioned** — credentials filled into `.env.local`.
4. **Two Upstash Redis instances provisioned** (cache + queue) — credentials filled into `.env.local`.
5. **All API keys populated** — OpenAI, Anthropic, SerpAPI, Resend, Stripe keys added to `.env.local`.
6. **Admin user seeded** — 1 admin row confirmed in `users` table.
7. **Corrective migration `002_prompt2_fixes.sql` applied** (2026-04-06):
   - Fixed `approval_audit_log` schema: added `token_hash TEXT NOT NULL` and `metadata JSONB`, removed `approval_link_id` and `user_agent` (per `docs/Final_Implementation_Plan.md:263-274`)
   - Added missing `idx_businesses_sync` and `idx_businesses_status` indexes (per `docs/Final_Implementation_Plan.md:278-280`)
   - Dropped `gen_random_uuid()` defaults on all 15 table PKs — app code must supply UUIDv7 via `import { v7 as uuidv7 } from 'uuid'` (per `docs/Final_Implementation_Plan.md:276`)

---

### Phase 1.3 — Worker Skeleton + Database Client (2026-04-06)

**Status:** COMPLETE (code done, deploy pending)

1. **Created `src/lib/db/client.ts`** — three exported clients:
   - `sql` — Postgres.js with PgBouncer pooled connection (`prepare: false`), for all transactional writes (`sql.begin()`)
   - `supabaseServer` — Supabase client with service-role key, for auth admin + storage + server reads
   - `supabaseClient` — Supabase client with anon key, for browser-side auth + real-time
   - Re-exported from `src/lib/db/index.ts`

2. **Created `worker/queues.ts`** — BullMQ queue infrastructure:
   - `getRedisOptions()` — handles both Upstash REST URLs (`https://`) and standard Redis URLs (`redis://`, `rediss://`). Extracts host from REST URL, constructs Redis protocol connection with TLS + `maxRetriesPerRequest: null`
   - 7 queues defined: `sync_reviews`, `generate_response`, `send_notification`, `publish_response`, `generate_demo`, `weekly_summary`, `notify_admin_review_exception`
   - `topicToQueue` lookup: maps `job_outbox.topic` string → Queue instance
   - `QUEUE_NAMES` const object with type export

3. **Created `worker/jobs/OutboxPoller.ts`** — functional 10-second interval poller:
   - Queries `job_outbox WHERE status = 'pending' AND available_at <= NOW()` (batch of 50)
   - For each entry: dispatches to matching BullMQ queue via `topicToQueue[entry.topic]`
   - Uses outbox entry `id` as BullMQ `jobId` for idempotency
   - On success: updates entry to `status = 'dispatched'`, increments `attempts`
   - On failure: logs error, leaves as `pending` for retry next cycle
   - Exports `startOutboxPoller()` / `stopOutboxPoller()`

4. **Created `worker/index.ts`** — full worker entry point (three responsibilities):
   - **Fastify HTTP server**: health check (`GET /api/health`), webhook placeholders (`POST /ingress/stripe`, `POST /ingress/resend`) with `rawBody: true` per route
   - **BullMQ workers**: placeholder handler for each of 7 queues (logs job data)
   - **OutboxPoller**: started after Fastify listens
   - Graceful shutdown on SIGTERM/SIGINT: stops poller → closes workers → closes Fastify → closes DB

5. **Created `worker/env.ts`** — dotenv loader imported first to avoid CJS import hoisting issue (queues.ts reads `process.env` at module scope)

6. **Installed `dotenv@17.4.1`** — required for worker process to load `.env.local` (Next.js loads it automatically, standalone worker does not)

7. **Verified:**
   - `pnpm build` passes (12 pages, Next.js 14)
   - `pnpm worker` starts: Fastify listening on :3001, health endpoint returns `{"status":"ok"}`, OutboxPoller runs, BullMQ connects to Upstash Redis
   - Postgres connects successfully — `DATABASE_POOL_URL` password configured

8. **Post-validation fixes (2026-04-06):**
   - Split `src/lib/db/client.ts` into `server.ts` (sql + supabaseServer) and `browser.ts` (supabaseClient) — prevents Node-only `postgres` import from leaking into client component bundles
   - Added `isPolling` re-entrancy guard to OutboxPoller — prevents overlapping poll cycles from causing duplicate dispatches
   - Added `Queue.close()` calls in shutdown — prevents dangling Redis connections on process exit
   - Unknown `job_outbox.topic` values now marked `status = 'failed'` with `last_error` — prevents infinite retry spam
   - Exported `app`, `queues`, `QUEUE_NAMES`, `sql` from `worker/index.ts` for ingress handler and test access

**Pending:** Deploy to Vercel + Railway

---

## Sprint 2: Review Pipeline

**Status:** NOT STARTED

---

## Sprint 3: Response Generation + Approval

**Status:** NOT STARTED

---

## Sprint 4: Payments + Notifications

**Status:** NOT STARTED

---

## Sprint 5: GBP API Integration

**Status:** NOT STARTED

---

## Sprint 6: Monitoring + Polish

**Status:** NOT STARTED
