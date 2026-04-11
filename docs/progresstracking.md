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
   - Removed barrel re-exports from `client.ts` and `index.ts` — files now contain import guidance comments only, no code paths that traverse both server and browser modules
   - Removed unused `server-only` package (throws in raw Node.js, incompatible with worker process)

9. **Deployed to production (2026-04-06):**
   - Next.js app deployed to Vercel
   - Worker service deployed to Railway
   - `NEXT_PUBLIC_APP_URL` and `WORKER_SERVICE_URL` cross-linked between environments

---

### Prompt 4 — ReviewSource + SerpAPI (2026-04-07)

**Status:** COMPLETE

1. **Created `src/lib/reviews/types.ts`** — core contracts:
   - `NormalizedReview` interface: `reviewerName`, `starRating`, `reviewText` (string | null), `reviewDate` (ISO 8601), `detectedLanguage` (ISO 639-1)
   - `ReviewSource` interface with `fetchReviews(placeId, maxResults?)` contract — all review sources (SerpAPI, manual paste, future GBP API) implement this
   - `ContentHashable` type + `computeContentHash()` utility: SHA-256(starRating + "|" + reviewText) for edit detection
   - Monitor types: `ReviewIdentity`, `MonitoredReview`, `IdentityCollision`, `MonitorResult`
   - Uses `import { createHash } from 'node:crypto'` per CLAUDE.md (not crypto-js)

2. **Created `src/lib/reviews/detect-language.ts`** — franc-min wrapper:
   - Maps all 82 franc-min ISO 639-3 codes → ISO 639-1 (2-letter codes only)
   - Languages without ISO 639-1 (Cebuano, Iloko) fall back to `'en'`
   - Short text (<20 words) defaults to `'en'` — franc is unreliable on short reviews, and the LLM self-corrects language anyway

3. **Created `src/lib/reviews/serpapi-source.ts`** — demo-mode `SerpApiSource`:
   - Implements `ReviewSource` interface
   - Calls SerpAPI `google_maps_reviews` engine with `place_id`, `sort_by: 'newestFirst'`
   - Prefers `extracted_snippet.original` over `snippet` (avoids machine-translated text)
   - Validates SerpAPI error payloads — throws on quota/auth/rate-limit errors instead of silently returning empty
   - Returns 10-15 most recent reviews, no deduplication

4. **Created `src/lib/reviews/serpapi-monitor.ts`** — production-mode `SerpApiMonitor`:
   - Same SerpAPI call but enriches each review with identity + content hash metadata
   - Identity strategy cascade (per CLAUDE.md dedup spec):
     - **PREFERRED:** SerpAPI `review_id` field → `identityStrategy: 'source_id'`
     - **FALLBACK:** SHA-256(reviewerName + "|" + reviewDate + "|" + reviewerProfileUrl) → `'profile_hash'`
     - **LAST RESORT:** SHA-256(reviewerName + "|" + reviewDate) → `'name_date_hash'` (warns on ambiguous names)
   - Synthetic resource names: `serpapi://{placeId}/reviews/{id}` and `serpapi://{placeId}`
   - Intra-batch collision detection: if two reviews share identity but differ in content, flagged in `MonitorResult.collisions` for worker to write to `review_exceptions`
   - `NormalizedReview` DTO stays clean — identity data is separate metadata

5. **Created `src/lib/reviews/serpapi-normalize.ts`** — shared normalization:
   - Extracted from both serpapi-source.ts and serpapi-monitor.ts to prevent drift
   - Single `normalizeSerpApiReview()` function strips all SerpAPI-specific fields
   - Validates required fields: `rating` must be number 1-5, `iso_date` must be non-empty string — throws descriptive errors on malformed SerpAPI payloads

6. **Created `src/lib/reviews/url-parser.ts`** — `extractPlaceId()`:
   - Handles: raw Place ID (`ChIJ...`), `?q=place_id:`, `?placeid=`, `!1s` data path
   - CID URLs return `null` (CID ≠ Place ID, SerpAPI uses different parameter)
   - Uses optional chaining on regex match results for `noUncheckedIndexedAccess` compliance

7. **Created `src/lib/reviews/__tests__/serpapi-source.test.ts`** — 32 contract tests:
   - NormalizedReview shape validation (exactly 5 fields, no extras)
   - Content hash determinism (same input → same hash, SHA-256 64-char hex)
   - Content hash ignores non-content fields (reviewer name, date, language)
   - Language detection: null → 'en', short text → 'en', Spanish/German detection, strictly 2-char codes
   - URL parser: raw IDs, query params, data path, CID rejection, empty/unknown input
   - Adapter normalization (mocked `getJson`): SerpApiSource field mapping, `extracted_snippet.original` preference, null text handling, Anonymous fallback
   - SerpApiMonitor: identity strategy selection, collision detection, no SerpAPI field leakage

8. **Updated `src/lib/reviews/index.ts`** — barrel re-exports for all public APIs

**Post-validation fixes (same session):**
- Fixed TypeScript errors: `match()[1]` returns `string | undefined` with `noUncheckedIndexedAccess` — used optional chaining `match()?.[1]`
- Removed CID URL support: URL parser returned `cid:...` but both adapters only send `place_id` — mismatch would cause SerpAPI failures
- Removed `ceb`/`ilo` from language map: these 3-letter codes violated the ISO 639-1 contract — now fall through to `'en'` default
- Added 9 adapter normalization tests exercising actual SerpApiSource and SerpApiMonitor through mocked `getJson`
- Extracted duplicated `normalizeReview` function to shared `serpapi-normalize.ts`
- Added SerpAPI error payload detection: both sources throw on `response.error` instead of returning empty
- Added field validation in `serpapi-normalize.ts`: throws on missing/invalid `rating` or `iso_date`

**Verification:** `tsc --noEmit` clean, 36/36 tests pass (37 total with scaffold)

---

### Prompt 5 — Response Generator + Prompt Builder (2026-04-07)

**Status:** COMPLETE

1. **Created `src/lib/responses/types.ts`** — shared types:
   - `DemoBusinessContext`: minimal (name + category) for demo mode callers
   - `BusinessContext extends DemoBusinessContext`: full production context (id, tone, productsServices, staffNames, highlightFacts, avoidFacts, sampleResponses, subscriptionTier)
   - `VoiceExample`: originalDraft, editedVersion, reviewStarRating (for tone-matched few-shot examples from owner-edited responses)
   - `GenerationOptions`: mode ('demo' | 'production'), reviewId, version, businessId, subscriptionTier
   - `GenerationResult`: responseText, language, provider, model, usage (promptTokens + completionTokens), costUsd, apiCostId (UUID for worker to link to response row)
   - `BuiltPrompt`: systemPrompt + userPrompt (separate for OpenAI messages vs Anthropic system param)

2. **Created `src/lib/responses/prompt-builder.ts`** — two pure functions, no I/O:
   - `buildDemoPrompt(review, businessName, category)`:
     - Infers tone from category via keyword matching (restaurant→"warm and appreciative", hotel→"professional and gracious", salon→"warm and personal", medical→"professional and caring", etc.)
     - Defaults to "professional and friendly" for unknown categories
   - `buildProductionPrompt(review, business, voiceExamples)`:
     - Uses full BusinessContext: owner-configured tone, staffNames, productsServices, highlightFacts, avoidFacts
     - Includes up to 3 voice examples (tone-matched: positive examples for 4-5 star reviews, negative for 1-3), showing both AI draft and owner's edited version
   - Shared system prompt template:
     - Word limit: 80 words for 4-5 stars, 120 words for 1-3 stars
     - Language directive: uses human-readable name ("Respond in Spanish") for long reviews (≥20 words, confident detection), falls back to "Respond in the same language as the review" for short reviews (prevents forcing English on short non-English reviews)
     - Rules: respond in same language, match tone, reference specific details, never use placeholders, never invent facts
   - User prompt: `{starRating}-star review from {name} on {date}: "{text}"` or `(no written review)` for rating-only

3. **Created `src/lib/responses/generator.ts`** — `generateResponse()` with dual mode:
   - **Type safety:** Accepts `DemoBusinessContext | BusinessContext`. Runtime type guard (`'id' in ctx && 'tone' in ctx`) throws TypeError if production mode receives demo-shaped context.
   - **Demo mode:** buildDemoPrompt → OpenAI gpt-4o-mini → Anthropic claude-3-5-haiku-latest fallback → return result. No Redis, no cost guard, no caching.
   - **Production mode** (full cost guard per `.claude/skills/cost-guard.md`):
     1. Validates required options (reviewId, version, businessId, subscriptionTier) — throws TypeError if missing
     2. Checks idempotent cache `gen:{reviewId}:v{version}` — returns cached result with costUsd: 0 on hit
     3. Reserves 15 cents pessimistic via `reserveCost(businessId, tier)` — captures `reservationDate` for consistent key targeting across midnight
     4. Acquires concurrency slot (max 3/business) — inside try block so cost is released on failure
     5. Builds production prompt → calls OpenAI → falls back to Anthropic on failure
     6. Finalizes cost (adjusts Redis by actual - estimated, using `reservationDate`)
     7. Post-finalization bookkeeping (best-effort, wrapped in try-catch — must not throw):
        - Caches result for 24h idempotency
        - Writes `api_costs` audit trail, returns `apiCostId` UUID for worker to link to response row
     8. `finally` block: cleanup is best-effort (individual try-catch per operation). Releases concurrency slot only if acquired; releases cost only if not finalized. Redis TTLs (5min concurrency, 24h cost) are the safety net.
   - **Language detection:** Detects language from the LLM response text (80-120 words, always above franc's threshold) rather than from `review.detectedLanguage` — ensures correct metadata even for short non-English reviews
   - Re-exports error classes: `CostLimitExceededError`, `GlobalCostLimitExceededError`, `ConcurrencyLimitExceededError`, `RegenBudgetExceededError`

4. **Created `src/lib/costs/tracker.ts`** — Redis-based atomic cost guard:
   - **Redis client:** Lazy singleton via `getCacheRedis()`, mirrors `worker/queues.ts` Upstash pattern for `REDIS_CACHE_URL`/`REDIS_CACHE_TOKEN` (NOT the queue instance)
   - **Cost reservation:** `reserveCost()` — atomic INCRBY on `cost:daily:{businessId}:{date}` + `cost:global:{date}`, checks tier limit, DECRBY rollback if exceeded. Returns `dateStr` so callers use the same date across midnight boundaries.
   - **Finalization:** `finalizeCost(businessId, cents, reservationDate)` — adjusts by (actual - 15 cents), can be negative. Uses reservation date, not current date. Once finalized, NEVER refund.
   - **Failure path:** `releaseCost(businessId, reservationDate)` — DECRBY 15 cents on both keys using the same date as reservation
   - **Concurrency:** `acquireConcurrencySlot()` / `releaseConcurrencySlot()` — INCR/DECR on `gen:active:{businessId}`, max 3, 5-minute TTL safety net, floors at 0
   - **Regeneration budget:** `checkRegenBudget()` — INCR `regen:{reviewId}:{date}`, max 3/day, 86400s TTL
   - **Idempotent cache:** `checkIdempotentCache()` / `setCachedGeneration()` — GET/SET on `gen:{reviewId}:v{version}` with 24h TTL
   - **Audit trail:** `recordApiCost()` — INSERT into `api_costs` table with UUIDv7 via `uuid.v7()`, returns the UUID for response linking. `linkApiCostToResponse(apiCostId, responseId)` — UPDATE to set `response_id` after worker inserts the response row.
   - **Model pricing:** `calculateCostUsd()` with hardcoded rates — gpt-4o-mini ($0.15/$0.60 per 1M tokens), claude-3-5-haiku-latest ($0.80/$4.00 per 1M). Rounds to 6 decimal places (matches `DECIMAL(10,6)` column).
   - **Tier limits:** founding=500, standard=1000, premium=2000 cents/day (with env overrides: `DAILY_COST_LIMIT_CENTS_FOUNDING`, etc.). Global cap via `GLOBAL_DAILY_COST_LIMIT_CENTS` (default 10000).
   - All Redis operations use pipelines for atomicity. Cost counters stored in cents (integers) to avoid floating-point issues.

5. **Created tests (55 new tests across 3 files):**
   - `src/lib/responses/__tests__/prompt-builder.test.ts` (26 tests): category→tone inference, word limits (80 vs 120), language name lookup, user prompt formatting, null reviewText handling, production-only clauses (staff, products, avoid, highlight, voice examples), voice example tone-matching and max 3 limit
   - `src/lib/responses/__tests__/generator.test.ts` (15 tests): OpenAI primary call, Anthropic fallback, both-fail throw, usage mapping from both SDKs, demo mode skips cost guard, production mode full lifecycle, cache hit returns costUsd:0, TypeError on missing required options, TypeError on demo-shaped context in production, finally-block cleanup on failure, concurrency failure releases cost, result survives cache write failure, result survives finally-block cleanup failure
   - `src/lib/costs/__tests__/tracker.test.ts` (17 tests): calculateCostUsd for both models + unknown model throw, reserveCost INCRBY + limit checks + rollback + returns date, acquireConcurrencySlot + overflow throw, finalizeCost negative adjustment with reservation date, releaseCost DECRBY with reservation date, releaseConcurrencySlot floor at 0, checkRegenBudget allow 3 + throw on 4th, recordApiCost SQL insert, checkIdempotentCache hit/miss

6. **Updated barrel exports:**
   - `src/lib/responses/index.ts` — types, prompt-builder, generator, error classes
   - `src/lib/costs/index.ts` — all tracker functions (including `linkApiCostToResponse`), error classes, Redis client

7. **Created `supabase/migrations/003_fix_audit_log_rls.sql`** — restores `ENABLE ROW LEVEL SECURITY` on `approval_audit_log` table (lost when migration 002 dropped and recreated it)

**Post-validation fixes (same session):**
- Fixed Anthropic model ID: `claude-haiku-4-5-20251001` (invalid) → `claude-3-5-haiku-latest` (per Anthropic docs). Updated pricing to $0.80/$4.00 per 1M.
- Fixed post-finalization double-spend: `setCachedGeneration` and `recordApiCost` wrapped in individual try-catch after `finalized = true`. Result always returned once cost is settled.
- Fixed type-unsafe production context: added `DemoBusinessContext` type + runtime type guard. Production mode now throws TypeError if passed demo-shaped context.
- Fixed short non-English review language: prompt builder uses generic "Respond in the same language as the review" for <20 word reviews. Generator detects language from response text (80-120 words) instead of review's `detectedLanguage`.
- Fixed midnight boundary race: `reserveCost` returns date string, `finalizeCost`/`releaseCost` accept it as parameter. All operations target the same day's keys.
- Fixed concurrency failure leaking cost: moved `acquireConcurrencySlot` inside try block with `concurrencyAcquired` flag. Cost released if concurrency fails.
- Fixed finally-block cleanup masking results: each cleanup operation in finally wrapped in its own try-catch. Redis TTLs are the safety net.
- Fixed dead `responseId`: `recordApiCost` returns UUID, `GenerationResult` includes `apiCostId`, added `linkApiCostToResponse()` for worker to call after inserting response row.
- Fixed SerpAPI error payloads: both sources throw on `response.error` instead of silently returning empty.
- Fixed SerpAPI field validation: `serpapi-normalize.ts` validates `rating` (number 1-5) and `iso_date` (non-empty string) before normalization.
- Fixed missing RLS: created migration 003 to re-enable RLS on `approval_audit_log`.
- Fixed response language detection for short outputs: added `detectResponseLanguage()` to `detect-language.ts` — uses `franc(text, { minLength: 3 })` without the 20-word guard. Generator uses this instead of `detectLanguage` for LLM response text. Short Spanish/French responses now correctly tagged.

**Verification:** `tsc --noEmit` clean, 98/98 tests pass across 5 test files

---

### Prompt 6 — Demo Generation Pipeline + UI (2026-04-07)

**Status:** COMPLETE

1. **Created `src/lib/demos/types.ts`** — shared types:
   - `DemoJobPayload`: demoId, googlePlaceId, businessName, category (BullMQ job shape)
   - `DemoGeneratorInput`: placeId, businessName, category (generator input)
   - `DemoGeneratorResult`: placeId, reviews[], responses[], metadata (generator output)
   - `DemoMetadata`: totalReviews, successfulResponses, failedResponses, totalCostUsd, generationDurationMs
   - `DemoListItem`: API response shape for admin list

2. **Created `src/lib/demos/generator.ts`** — `generateDemo()`:
   - Fetches 10-15 reviews via `SerpApiSource(SERPAPI_API_KEY).fetchReviews(placeId, 15)`
   - Generates AI response for each review using `generateResponse(review, ctx, [], { mode: 'demo' })` in parallel via `Promise.allSettled` — partial failures OK (null response for that review, logged, generation continues)
   - Computes metadata: counts, total cost, duration
   - Pure computation — no DB writes (worker handles persistence)

3. **Created `worker/jobs/DemoGenerationWorker.ts`** — `handleDemoGeneration()`:
   - Idempotency guard: checks `generation_status === 'queued'` before processing, skips if already running/completed
   - Race-safe transition: `UPDATE ... WHERE generation_status = 'queued'` — only one worker can claim
   - On success: saves `reviews_snapshot` + `generated_responses` as JSONB, marks `completed`, updates job_outbox to `completed`
   - On failure: marks `failed` with human-readable `generation_error`, updates job_outbox to `failed`, rethrows for BullMQ tracking
   - JSONB layout: parallel arrays — `reviews_snapshot` = `NormalizedReview[]`, `generated_responses` = `(GenerationResult | null)[]`

4. **Modified `worker/index.ts`** — wired real handler:
   - `generate_demo` queue now uses `handleDemoGeneration` instead of placeholder
   - Other 6 queues remain placeholder handlers

5. **Created API routes:**
   - `POST /api/admin/demos/generate`: Zod-validates input (googleMapsUrl, businessName, category?), extracts Place ID via `extractPlaceId`, generates UUIDv7 IDs + nanoid(10) slug, creates `prospect_demos` row + `job_outbox` entry in ONE transaction (outbox pattern). Returns 201 `{ id, slug, status: 'queued' }`.
   - `GET /api/admin/demos`: Lists all demos ordered by `generated_at DESC`, returns `DemoListItem[]`
   - Both routes have TODO comments for Sprint 3 auth

6. **Built `src/app/(public)/demo/[slug]/page.tsx`** — SSR demo viewer:
   - Server component, mobile-first Tailwind
   - **States:** not found/expired → 404, queued/running → loading page with `<meta http-equiv="refresh" content="5" />` auto-reload, failed → error message, completed → full demo
   - **Layout:** header with business name + stats, review cards (star rating, reviewer, date, text), AI response section below each card (blue-50 bg), multilingual badge, CTA with placeholder Calendly link
   - View count: direct Postgres increment (fire-and-forget). TODO for Redis debouncing (Sprint 4)

7. **Built `src/app/(admin)/demos/page.tsx`** — admin panel:
   - Client component using `@tanstack/react-query`
   - Generate form: Google Maps URL + Business Name + Category → POST generate
   - Demo list with auto-polling (5s interval while any demo is queued/running)
   - Status badges: gray (queued), yellow/animated (running), green (completed), red (failed)
   - Copy-link button for completed demos
   - `src/app/(admin)/providers.tsx` — QueryClientProvider wrapper
   - `src/app/(admin)/layout.tsx` — wraps children with AdminProviders

8. **Updated `src/lib/demos/index.ts`** — barrel re-exports

**No migration needed:** `prospect_demos` table already has `generation_status`, `generation_error`, `started_at`, `completed_at` columns from migration 001.

**Post-validation fixes (same session):**
- Fixed view count overcounting: moved `view_count` increment AFTER the `generation_status === 'completed'` check. Loading state auto-refreshes every 5s and was inflating count before the demo was even ready.
- Fixed outbox stuck in dispatched: all early-return paths (demo not found, already non-queued, already claimed) now call `markOutboxCompleted(outboxId)` so the outbox row reaches a terminal state.
- Fixed non-transactional state updates: success and failure paths now wrap both `prospect_demos` and `job_outbox` updates in `sql.begin()` transactions. Prevents inconsistent state if the second write fails.

**Verification:** `tsc --noEmit` clean, 98/98 tests pass, `next build` succeeds (14 pages compiled)

---

### Sprint 1 Audit + Fixes (2026-04-09)

**Status:** COMPLETE

Full codebase audit against `docs/Final_Implementation_Plan.md` (Prompts 1-6), `docs/Implementation_Phases_SerpAPI_First.md`, and `docs/04-final-plan.md`. All blockers, quality issues, minor issues, and CLAUDE.md improvements addressed. Demo pipeline verified end-to-end with mock data.

**Audit findings and fixes:**

1. **Mock data path (blocker):**
   - Created `src/lib/reviews/mock-source.ts` — `MockReviewSource` implementing `ReviewSource` interface, 8 canned reviews (5-star EN, 1-star EN, 4-star ES, 3-star null-text, 5-star FR, 2-star EN, 5-star short EN, 4-star DE)
   - Created `src/lib/responses/mock-generator.ts` — `generateMockResponse()` with sentiment-aware (positive/negative/neutral) and multilingual (EN/ES/FR/DE) template responses
   - Modified `src/lib/demos/generator.ts` — checks `MOCK_EXTERNAL_APIS=true` env var, uses `MockReviewSource` + `generateMockResponse` instead of real SerpAPI/LLM calls
   - Added `MOCK_EXTERNAL_APIS=true` to `.env.local`

2. **OutboxPoller hardening (quality):**
   - Added `FOR UPDATE SKIP LOCKED` to the SELECT query in `worker/jobs/OutboxPoller.ts`
   - Wrapped entire SELECT + dispatch loop in `sql.begin()` transaction so row locks are actually held during dispatch
   - Added `max_attempts` enforcement: entries exceeding max attempts marked `failed` (terminal) instead of retrying forever
   - All UPDATEs now use `tx` (transaction client) instead of bare `sql`

3. **DemoGenerationWorker fixes (quality):**
   - Removed re-throw after failure transaction succeeds — BullMQ job completes cleanly, no pointless retry. Only re-throws if the failure transaction itself fails.
   - Added stale "running" recovery: demos stuck in `running` for >5 minutes are reset to `queued` for retry. Non-stale running demos are skipped with outbox completed.
   - Terminal states (`completed`/`failed`) now handled explicitly — outbox entry completed cleanly.

4. **JSONB parsing guard (blocker — discovered during testing):**
   - Postgres.js returns JSONB columns as strings (not parsed objects) when using PgBouncer pooled connections
   - Fixed `worker/jobs/OutboxPoller.ts` — payload parsed before passing to BullMQ: `typeof entry.payload === 'string' ? JSON.parse(entry.payload) : entry.payload`
   - Fixed `src/app/(public)/demo/[slug]/page.tsx` — reviews_snapshot and generated_responses parsed before use
   - Added lab note to `.claude/CLAUDE.md` for future reference

5. **Admin auth middleware (critical — from code review):**
   - Created `src/middleware.ts` — Next.js middleware protecting all `/admin/*` pages and `/api/admin/*` API routes
   - Behavior: `ADMIN_API_KEY` unset + dev → open access; unset + prod → all blocked (fail-closed); set → requires `__admin_key` cookie or `x-admin-key` header
   - Created `src/app/admin/login/page.tsx` — simple login form accepting admin key
   - Created `src/app/api/admin/auth/route.ts` — validates key, sets httpOnly cookie (7-day TTL)
   - Removed per-route `requireAdminKey()` guards from API routes — middleware handles everything
   - Deleted `src/lib/auth/admin-guard.ts` (unused after middleware approach)
   - Added `ADMIN_API_KEY` to `.env.example` with documentation

6. **Route group fix (blocker — discovered during testing):**
   - `src/app/(admin)/` route group made pages accessible at `/demos` not `/admin/demos` (Next.js route groups with parentheses are invisible in URL)
   - Renamed `(admin)` to `admin` (real route segment) — all admin pages now at `/admin/*`

7. **Redis infrastructure (blocker — Upstash free tier exhausted):**
   - Removed placeholder BullMQ Workers for unimplemented queues — reduced from 7 workers to 1 (`generate_demo` only). Placeholder workers were burning Redis requests polling for jobs that never arrive.
   - Added `db` field parsing to Redis connection options in `worker/queues.ts` and `src/lib/costs/tracker.ts` — supports `redis://127.0.0.1:6379/1` (local Docker Redis with DB selection)
   - Switched `.env.local` to local Docker Redis (`redis://127.0.0.1:6379/0` for cache, `redis://127.0.0.1:6379/1` for queue). Upstash URLs preserved as comments for production.
   - Updated `.env.example` with local Redis as default

8. **Minor/cosmetic fixes:**
   - Created `.env.example` with all variable names, placeholder values, and documentation comments
   - Replaced broken `calendly.com/PLACEHOLDER` CTA with `mailto:` link using `NEXT_PUBLIC_CONTACT_EMAIL` env var
   - Created `vitest.config.ts` with path aliases matching tsconfig
   - Added `console.error` to view count fire-and-forget catch block (was silently swallowing errors)

9. **CLAUDE.md improvements:**
   - Added `worker/env.ts` to directory structure
   - Added `fastify-raw-body` package name clarification
   - Added "Dev commands" section
   - Added "Demo vs Production mode" and "Mock mode" pattern docs
   - Removed phantom "Sprint 6" from status
   - Added lab note about Postgres.js JSONB-as-string behavior

**Verification:** `tsc --noEmit` clean, 97/97 tests pass across 4 test files, demo pipeline verified end-to-end with mock data (admin → outbox → worker → DB → viewer)

---

### Sprint 1 done when
- [x] App live on Vercel, worker on Railway (health checks passing)
- [x] All 15 database tables exist (confirmed via migrations 001-003)
- [x] Pasting a Google Maps URL generates a demo (mock mode: ~2s, real SerpAPI: <90s)
- [x] Demo page is mobile-optimized and shareable
- [x] Non-English reviews get same-language responses (ES, FR, DE verified in mock data)
- [x] Sales partner can generate demos independently (admin UI at /admin/demos)
- [x] Admin routes protected by middleware auth (fail-closed in production)
- [x] OutboxPoller hardened: FOR UPDATE SKIP LOCKED, max_attempts enforcement, transaction-wrapped
- [x] DemoGenerationWorker crash recovery: stale running detection, terminal state handling

---

## Sprint 2: Production Pipeline (Days 6–13)

**Status:** IN PROGRESS

### Prompt 7 — Shared Worker Utilities (2026-04-10)

**Status:** COMPLETE

All shared utilities that Sprint 2 workers depend on are now in place. Every subsequent worker (ReviewSyncWorker, ResponseGeneratorWorker, NotificationWorker, ResponsePublisherWorker, AdminExceptionWorker) imports from these shared modules.

1. **Created `src/lib/shared/subscription-guard.ts`** — `checkSubscription()`:
   - Input: subscription status, business updatedAt timestamp, worker type (`'generator'` | `'notification'` | `'publisher'` | `'summary'`)
   - Returns `{ allowed: true }` or `{ allowed: false; reason: string }`
   - Rules per CLAUDE.md (authoritative): `cancelled` → denied; `past_due` → 7-day grace check; `pending_payment` → only generator allowed (admin-visible demo drafts during sales call); `active` → allowed
   - Unknown statuses denied with descriptive reason

2. **Created `src/lib/shared/outbox.ts`** — extracted from DemoGenerationWorker:
   - `markOutboxCompleted(outboxId)` — UPDATE job_outbox SET status='completed'
   - `markOutboxFailed(outboxId, error)` — UPDATE job_outbox SET status='failed', last_error
   - Imports `sql` from `@/lib/db/server` (standalone client, not for use inside transactions)

3. **Created `src/lib/shared/sanitize.ts`** — `sanitizeText()`:
   - Strips null bytes, ASCII control chars (U+0001–U+001F except `\n \r \t`), DEL + C1 block (U+007F–U+009F)
   - Collapses whitespace runs to single space, trims

4. **Created `src/lib/shared/worker-types.ts`** — 5 job payload interfaces:
   - `SyncReviewsPayload`: `{ business_id, google_place_id }`
   - `GenerateResponsePayload`: `{ review_id, business_id, version }`
   - `SendNotificationPayload`: `{ response_id, business_id }`
   - `PublishResponsePayload`: `{ response_id, business_id }`
   - `NotifyAdminExceptionPayload`: `{ review_exception_id, business_id }`
   - `DemoJobPayload` remains in `src/lib/demos/types.ts` (unchanged)

5. **Created `src/lib/shared/rate-limit.ts`** — `checkRateLimit()`:
   - Atomic Lua script for INCR + EXPIRE in single Redis round-trip (uses cache instance via `getCacheRedis()`)
   - Returns `{ allowed: boolean; remaining: number }`
   - Initial implementation had a bug: separate INCR then EXPIRE calls were not failure-safe — if the process crashed between them, the key would be left without a TTL. Fixed by switching to a Lua script that runs both atomically.

6. **Created `src/lib/shared/mock-mode.ts`** — mock mode helpers:
   - `isMockMode()` — checks `MOCK_EXTERNAL_APIS === 'true'`
   - `getReviewMonitor(apiKey)` — returns `SerpApiMonitor` or `MockSerpApiMonitor` based on mock mode

7. **Created `src/lib/reviews/mock-monitor.ts`** — `MockSerpApiMonitor`:
   - Same interface as `SerpApiMonitor`: `fetchReviews(placeId, maxResults?) → MonitorResult`
   - Reuses canned reviews from `MockReviewSource`
   - Enriches each with identity fields: `provider='serpapi_poll'`, SHA-256 identity hash, synthetic resource names, `identityStrategy='name_date_hash'`
   - Computes `contentHash` via `computeContentHash()` from `reviews/types.ts`
   - Returns `{ reviews: MonitoredReview[], collisions: [] }` (no collisions in mock data)

8. **Created `src/lib/responses/voice-learning.ts`** — `getApprovedResponsePairs()`:
   - Queries `responses` joined with `reviews` for posted + edited responses, uses `idx_responses_voice` partial index
   - LIMIT 10 from DB, returns ≤ 5 as `VoiceExample[]`
   - Returns `[]` if fewer than 5 edited+posted responses exist (voice learning activation threshold)

9. **Modified `worker/jobs/DemoGenerationWorker.ts`**:
   - Removed local `markOutboxCompleted()` function (lines 141-147)
   - Now imports `markOutboxCompleted` from `@/lib/shared/outbox`
   - Transactional outbox completions (inside `sql.begin()`) remain as inline `tx` SQL

10. **Updated barrel exports:**
    - `src/lib/shared/index.ts` — re-exports all new modules
    - `src/lib/reviews/index.ts` — added `MockSerpApiMonitor` export
    - `src/lib/responses/index.ts` — added `getApprovedResponsePairs` export

11. **Installed `fastest-levenshtein@1.0.16`** — needed by Prompt 12 (approval edit flow, Levenshtein distance calculation)

12. **Tests (3 new test files, 27 new tests):**
    - `src/lib/shared/__tests__/subscription-guard.test.ts` (11 tests): all 4 statuses × 4 worker types, grace period boundary cases (6d23h59m allowed, 7d0m1s denied), unknown status handling
    - `src/lib/shared/__tests__/sanitize.test.ts` (11 tests): null bytes, control chars, DEL/C1, whitespace collapse, trim, empty/whitespace-only input, unicode preservation, combined edge cases
    - `src/lib/shared/__tests__/rate-limit.test.ts` (5 tests): first request, subsequent, exact limit, over limit, well past limit — all using mocked Redis `eval`

**Verification:** `tsc --noEmit` clean, 136/136 tests pass across 7 test files, `pnpm build` succeeds

---

### Prompt 8 — OutboxPoller Watchdog + ReconciliationPoller (2026-04-10)

**Status:** COMPLETE

Added watchdog recovery to the existing OutboxPoller and created the ReconciliationPoller for 60-minute SerpAPI review sync scheduling.

1. **Modified `worker/jobs/OutboxPoller.ts`** — added watchdog recovery:
   - Two CTE queries run at the START of each poll cycle, inside the `sql.begin()` transaction, BEFORE the pending-entry SELECT
   - **Recover retryable:** entries with `status='dispatched'` AND `dispatched_at < NOW() - INTERVAL '1 hour'` AND `attempts < max_attempts` → reset to `'pending'`, clear `dispatched_at`, set `available_at = NOW()`
   - **Fail terminal:** entries with same stale condition AND `attempts >= max_attempts` → set `status='failed'`, `last_error='Stale dispatched entry exceeded max_attempts'`, `completed_at = NOW()`
   - Logs recovered and failed counts only when non-zero
   - Recovers from the scenario where a BullMQ worker crashes after dispatch but before completion

2. **Created `worker/jobs/ReconciliationPoller.ts`** — 60-minute sync scheduler:
   - Same `setInterval` + `isPolling` re-entrancy guard pattern as OutboxPoller
   - Interval: 60 minutes (configurable via `RECONCILIATION_INTERVAL_MS` env var, default `3_600_000`)
   - **Mock mode skip:** if `isMockMode()` returns true, logs and returns without touching DB
   - **Query:** finds businesses with `subscription_status = 'active'`, non-null `google_place_id`, and `last_sync_at` older than 60 minutes (or NULL)
   - **Dedup guard:** `NOT EXISTS` subquery prevents creating a new `sync_reviews` outbox entry if one is already `pending` or `dispatched` for that business
   - For each eligible business: inserts a `job_outbox` entry with `topic='sync_reviews'`, `aggregate_type='business'`, payload typed as `SyncReviewsPayload` from `src/lib/shared/worker-types.ts`
   - UUIDv7 for outbox entry IDs
   - Exports `startReconciliationPoller()` / `stopReconciliationPoller()`

3. **Modified `worker/index.ts`** — wired lifecycle:
   - Import `startReconciliationPoller` / `stopReconciliationPoller`
   - `startReconciliationPoller()` called after `startOutboxPoller()` in `main()`
   - `stopReconciliationPoller()` called after `stopOutboxPoller()` in `shutdown()`

**Verification:** `tsc --noEmit` clean, 136/136 tests pass across 7 test files, `pnpm build` succeeds

---

### Prompt 9 — ReviewSyncWorker (2026-04-10)

**Status:** COMPLETE

Built the ReviewSyncWorker that processes `sync_reviews` BullMQ jobs — fetches reviews via SerpAPI (or mock), deduplicates against the DB, triggers response generation for new reviews, handles review edits, and captures ROI baselines.

1. **Created `worker/jobs/ReviewSyncWorker.ts`** — `handleReviewSync()`:
   - Exports a single handler function consuming `Job<SyncReviewsPayload>`
   - **Step 1 (validation):** Reads business from DB, validates existence (`markOutboxFailed` if not found), subscription status via `checkSubscription('generator')` (`markOutboxCompleted` if ineligible), and `google_place_id` presence (`markOutboxFailed` if null)
   - **Step 2 (fetch):** Uses `getReviewMonitor()` from shared mock-mode (auto-selects real vs mock). Permanent SerpAPI errors (401/403/quota) → `markOutboxFailed`; transient errors → throws for BullMQ retry
   - **Step 3 (collisions):** Logs identity collisions as warnings (can't insert to `review_exceptions` — `review_id` is NOT NULL in schema, collisions are pre-insert)
   - **Step 4 (per-review processing):** Each review processed in its own `sql.begin()` transaction for partial success:
     - `FOR UPDATE` lock on existing review by `(provider, provider_review_name)`
     - **NEW review:** insert review row + `generate_response` outbox entry
     - **Content changed + no active response:** queue fresh generation
     - **Content changed + `pending_approval`:** fail old response with `'review_content_changed'`, queue regeneration with `version + 1`
     - **Content changed + `posted`/`awaiting_manual_post`:** insert `review_exception` (`ON CONFLICT DO NOTHING` for partial unique index) + `notify_admin_review_exception` outbox entry
     - **Content changed + `approved`/`edited`:** supersede old response, queue regeneration
     - **Unchanged:** skip (no action)
   - **Step 5:** Updates `businesses.last_sync_at = NOW()`
   - **Step 6 (ROI baseline):** On first sync (`baseline_captured_at IS NULL`), captures `initial_review_count` and `initial_responded_count`. Non-fatal — caught and logged if fails.
   - **Step 7:** `markOutboxCompleted(outboxId)`
   - Tracks new/updated/unchanged/error counts per sync for logging

2. **Modified `worker/index.ts`** — registered the worker:
   - Imported `handleReviewSync` from `./jobs/ReviewSyncWorker`
   - Created `reviewSyncWorker = new Worker(QUEUE_NAMES.SYNC_REVIEWS, handleReviewSync, { connection: redisOpts })`
   - Added to `workers` array for graceful shutdown
   - Removed commented-out placeholder

3. **Created `worker/__tests__/ReviewSyncWorker.test.ts`** — 6 unit tests:
   - Business not found → `markOutboxFailed` called
   - Subscription cancelled → `markOutboxCompleted` called (real `checkSubscription` used, not mocked)
   - Null `google_place_id` → `markOutboxFailed` called
   - Permanent SerpAPI error (403/quota) → `markOutboxFailed` with `serpapi_permanent` prefix, does not throw
   - Transient SerpAPI error (ECONNRESET) → throws for BullMQ retry, neither outbox helper called
   - New review happy path → `sql.begin` called for per-review transaction, `markOutboxCompleted` called at end
   - Uses `vi.hoisted()` for shared mock state between hoisted `vi.mock` factories and test code

4. **Created `supabase/migrations/004_sync_reviews_dedup_constraint.sql`** — race-safe dedup for ReconciliationPoller:
   - Collapses pre-existing duplicate in-flight `sync_reviews` outbox entries before creating constraint
   - Partial unique index `idx_jo_sync_reviews_inflight` on `(topic, aggregate_id)` WHERE `topic = 'sync_reviews' AND status IN ('pending', 'dispatched')`
   - ReconciliationPoller catches Postgres unique violation (error code `23505`) gracefully

**Post-review fixes:**
- Fixed env var name: `SERPAPI_KEY` → `SERPAPI_API_KEY` (matches `.env.local`)
- ReconciliationPoller dedup made atomic: `INSERT ... SELECT ... WHERE NOT EXISTS` + DB-level unique constraint + `catch` for `23505` error code
- ReconciliationPoller interval parsing: `getIntervalMs()` validates with `Number.isFinite(parsed) && parsed > 0`, falls back to default on invalid input
- Migration 004 cleanup: collapses existing duplicates before creating unique index to prevent deployment failures

**Verification:** `tsc --noEmit` clean, 149/149 tests pass across 9 test files, `pnpm build` succeeds

---

### Prompt 10 — ResponseGeneratorWorker (2026-04-10)

**Status:** COMPLETE

Built the ResponseGeneratorWorker — a thin orchestration wrapper around the existing `generateResponse()` / `generateMockResponse()` with subscription guards, input sanitization, voice learning, avoid-facts guardrails, and transactional response persistence.

1. **Created `worker/jobs/ResponseGeneratorWorker.ts`** — `handleResponseGeneration()`:
   - Exports a single handler consuming `Job<GenerateResponsePayload>` (`{ review_id, business_id, version }`)
   - **Step 1 (read):** Reads review and business from DB. If either not found → `markOutboxFailed`
   - **Step 2 (subscription):** `checkSubscription('generator')` — allows active + pending_payment (admin demo drafts). Cancelled → `markOutboxCompleted`
   - **Step 3 (sanitize):** Applies `sanitizeText()` to review text before passing to generator
   - **Step 4 (context):** Maps DB snake_case columns to `BusinessContext` camelCase. JSONB parsing guard on all array columns (`staff_names`, `highlight_facts`, `avoid_facts`, `sample_responses`) via `parseArray()` helper
   - **Step 5 (voice):** Calls `getApprovedResponsePairs(businessId)` — returns `[]` until ≥ 5 edited+posted responses
   - **Step 6 (regen budget):** For `version > 1`, calls `checkRegenBudget(reviewId)`. If exceeded → `markOutboxFailed` (terminal, no retry)
   - **Step 7 (generate):** Mock mode → `generateMockResponse()`. Real mode → `generateResponse()` (handles cost guard lifecycle, caching, LLM fallback internally)
   - **Step 8 (avoid-facts):** Case-insensitive substring check against `businessContext.avoidFacts`. On violation → regenerates ONCE with `skipCache: true` (so the idempotent cache doesn't return the violating first result). After successful retry, overwrites cache via `setCachedGeneration()` with the clean result. Accumulates cost from both attempts. If retry also violates or fails → uses the original (best-effort)
   - **Step 9 (persist):** In ONE `sql.begin()` transaction: INSERT response row (status `'pending_approval'`) + `UPDATE api_costs SET response_id` (links cost to response) + INSERT `send_notification` outbox entry. All three commit or rollback together. NO approval token in payload — token generation happens in NotificationWorker
   - **Error handling:** `CostLimitExceededError` / `GlobalCostLimitExceededError` → `markOutboxFailed` (terminal). `ConcurrencyLimitExceededError` → throw for BullMQ retry (transient). `RegenBudgetExceededError` → `markOutboxFailed`. LLM failures → `markOutboxFailed`. DB transaction failures → throw for retry

2. **Modified `src/lib/responses/types.ts`** — added `skipCache?: boolean` to `GenerationOptions`:
   - Skips idempotent cache read AND write when true
   - Used by the avoid-facts retry path so a cached violating response doesn't short-circuit regeneration

3. **Modified `src/lib/responses/generator.ts`** — `skipCache` support:
   - `runProductionMode()` skips `checkIdempotentCache()` read when `options.skipCache` is true
   - Skips `setCachedGeneration()` write when `options.skipCache` is true
   - Normal (non-retry) calls still cache as before

4. **Modified `worker/index.ts`** — registered the worker:
   - Imported `handleResponseGeneration` from `./jobs/ResponseGeneratorWorker`
   - Created `responseGenWorker = new Worker(QUEUE_NAMES.GENERATE_RESPONSE, handleResponseGeneration, { connection: redisOpts })`
   - Added to `workers` array for graceful shutdown

5. **Modified `worker/queues.ts`** — added `defaultJobOptions` to all 7 queues:
   - `attempts: 3, backoff: { type: 'exponential', delay: 5_000 }`
   - Ensures transient failures (network, rate limits) retry at 5s/10s/20s instead of waiting for the 1-hour OutboxPoller watchdog

6. **Created `worker/__tests__/ResponseGeneratorWorker.test.ts`** — 5 unit tests:
   - Successful generation → `generateResponse` called, `sql.begin` persists response + outbox, `mockTx` args contain cost ID `'cost-1'` (proves `UPDATE api_costs` runs inside the transaction), `markOutboxCompleted` called
   - Subscription cancelled → `markOutboxCompleted` called, no generator invoked
   - Cost limit exceeded → `markOutboxFailed` called with error message, does not throw
   - Mock mode → `generateMockResponse` called instead of `generateResponse`
   - Avoid-facts violation → generator called twice, retry uses `skipCache: true` (asserted), first call has no `skipCache`, `setCachedGeneration` called with review ID `'rev-1'`, version `1`, and JSON containing the clean retry response text, `markOutboxCompleted` still called

**Post-review fixes:**
- Fixed avoid-facts retry returning cached violating response: added `skipCache` option to `GenerationOptions`, generator respects it for both cache read and write, worker passes `skipCache: true` on retry, worker overwrites cache with accepted result via `setCachedGeneration()` after successful retry
- Fixed `linkApiCostToResponse` being outside the transaction: moved to inline `tx` UPDATE inside `sql.begin()` so response insert, cost link, and notification outbox all commit or rollback together
- Fixed BullMQ queues having no retry config: added `defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 5_000 } }` to all 7 queues in `worker/queues.ts`
- Added targeted test assertions: cost link inside transaction (tx args contain cost ID), skipCache on retry (asserted on second call opts), cache overwrite (setCachedGeneration called with clean response)

**Verification:** `tsc --noEmit` clean, 159/159 tests pass across 10 test files, `pnpm build` succeeds

---

### Prompt 11 — NotificationWorker + Email + Resend Webhook (2026-04-10)

**Status:** COMPLETE

Built the complete notification pipeline: email sending via Resend, NotificationWorker that generates approval tokens and sends approval emails, and Resend delivery webhook handler for tracking email delivery status.

1. **Created `src/lib/notifications/email.ts`** — `sendApprovalEmail()`:
   - Lazy Resend singleton via `getResend()`
   - `ApprovalEmailParams` interface: to, from, businessName, reviewerName, starRating, reviewText, responsePreview, approvalUrl
   - HTML template: inline CSS, single-column, mobile-first, max-width 600px. Star rating as `★★★★☆`, reviewer name, review text (truncated to 200 chars or "Rating only — no written review"), draft response preview (100 chars), big blue "Review & Approve" CTA button, "This link expires in 48 hours" footer
   - Subject: "New review for {businessName} — response ready"
   - Mock mode: logs email contents, returns `{ messageId: 'mock-' + randomUUID() }` without calling Resend
   - Returns `{ messageId }` from Resend response

2. **Created `worker/jobs/NotificationWorker.ts`** — `handleSendNotification()`:
   - Reads response+review (JOIN) and business from DB. Not found → `markOutboxFailed`
   - Subscription guard with workerType `'notification'` — correctly skips `cancelled`, expired `past_due`, AND `pending_payment`
   - **Corrected idempotency logic:**
     - Check `notification_deliveries` for existing sent delivery → if exists, `markOutboxCompleted` (already sent)
     - Check `approval_links` for existing unexpired unrevoked link → if exists but no delivery, revoke it (orphaned from previous crash — can't reconstruct raw token from hash)
     - Create new approval link with fresh token
   - Generates raw token via `randomUUID()`, stores ONLY `SHA-256(rawToken)` in `approval_links` with 48-hour TTL
   - Constructs approval URL: `${NEXT_PUBLIC_APP_URL}/approve/${rawToken}`
   - Sends email via `sendApprovalEmail()`. On failure → throws for BullMQ retry (next retry: finds orphaned link, revokes it, creates new token)
   - Records delivery in `notification_deliveries` with Resend `messageId` as `external_message_id`
   - Raw token ONLY exists in memory during this function — NEVER persisted, logged, or stored in outbox payloads

3. **Created `worker/ingress/resend.ts`** — Resend delivery webhook handler:
   - Replaced placeholder with real handler
   - **Svix signature verification:** HMAC-SHA256 over `svixId.svixTimestamp.rawBody`, base64 comparison with `timingSafeEqual`, supports multiple signatures. `RESEND_WEBHOOK_SECRET` unset → skips verification (dev mode)
   - **Dedup via `inbound_events`:** `INSERT ... ON CONFLICT (external_event_key) DO NOTHING`. Duplicate → returns 200 (Resend expects 2xx)
   - **Event processing:** `email.delivered` → sets `delivered_at`. `email.bounced`/`email.complained` → sets `failed_at` + `failure_reason`. All match by `external_message_id`
   - Updates `inbound_events` status to `'processed'` or `'failed'`
   - Always returns 200 (even for processing errors — Resend should not retry)

4. **Modified `worker/index.ts`** — registered worker + ingress:
   - Imported `handleSendNotification` from `./jobs/NotificationWorker`
   - Created `notificationWorker = new Worker(QUEUE_NAMES.SEND_NOTIFICATION, handleSendNotification, { connection: redisOpts })`
   - Added to `workers` array for graceful shutdown
   - Imported `handleResendWebhook` from `./ingress/resend`
   - Replaced `/ingress/resend` placeholder with real handler (rawBody: true preserved)

5. **Modified `.env.example`** — added `RESEND_FROM_EMAIL`

6. **Updated `src/lib/notifications/index.ts`** — barrel exports for `sendApprovalEmail` + `ApprovalEmailParams`

7. **Created `worker/__tests__/NotificationWorker.test.ts`** — 5 unit tests:
   - Success flow → approval link created (sql.begin), email sent with correct params (to, businessName, reviewerName, approvalUrl pattern), delivery recorded, markOutboxCompleted
   - Subscription pending_payment → markOutboxCompleted, no email sent (real checkSubscription used)
   - Existing delivery → idempotent skip, markOutboxCompleted
   - Orphaned link revocation → old link revoked, new link created, email sent
   - Email send failure → throws for BullMQ retry, markOutboxCompleted NOT called

**Post-review fixes:**
- Fixed HTML injection in approval emails: all dynamic content (`businessName`, `reviewerName`, `reviewText`, `responsePreview`) now escaped via `escapeHtml()` (replaces `& < > " '`). The `approvalUrl` href attribute is also quote-escaped. Email subject uses plain text (no escaping — `R&D` stays `R&D`, not `R&amp;D`)
- Fixed Resend webhook verification failing open in production: `verifySignature()` now only allows unsigned requests when `MOCK_EXTERNAL_APIS=true`. In production, missing `RESEND_WEBHOOK_SECRET` → returns false → 401
- Fixed orphaned approval link on missing `RESEND_FROM_EMAIL`: moved the env var check before token generation and link creation. If missing, worker calls `markOutboxFailed` immediately without creating any DB state
- Fixed missing review date in email template: added `reviewDate: string` to `ApprovalEmailParams`, template now shows `"Jane · Apr 1, 2026"` with `formatDate()` for human-readable output
- Added `RESEND_FROM_EMAIL` to `.env.local` (was only in `.env.example`)

**Verification:** `tsc --noEmit` clean, 164/164 tests pass across 11 test files, `pnpm build` succeeds

---

### Prompt 12 — Approval Flow (2026-04-10)

**Status:** COMPLETE

Built the complete approval system: service layer (token validation, approve/edit/regenerate), cookie utilities (device binding + CSRF), 5 API routes, approval page (server shell + client interactive), and unit tests.

1. **Created `src/lib/approval/errors.ts`** — 5 typed error classes:
   - `InvalidTokenError`, `ExpiredTokenError`, `RevokedTokenError`, `ConsumedTokenError`, `DeviceConflictError`
   - Each has a descriptive message and unique `name` property for `instanceof` checks

2. **Created `src/lib/approval/service.ts`** — core approval business logic:
   - All methods receive a Postgres `tx` (TransactionSql) from the caller — never create their own transactions
   - `lockValidLink(tx, rawToken)`: SHA-256 hashes raw token, SELECT FOR UPDATE, validates consumed/revoked/expired state, returns typed `ApprovalLink`
   - `establishApprovalSession(tx, linkId, deviceCookieHash, audit)`: binds device cookie hash on first visit, no-ops on same device, throws `DeviceConflictError` on different device
   - `approve(tx, link, deviceCookieHash, audit)`: verifies device, consumes link, updates response to `'approved'`, revokes sibling links, inserts `publish_response` outbox entry
   - `edit(tx, link, editedText, deviceCookieHash, audit)`: same as approve + computes Levenshtein `edit_distance` via `fastest-levenshtein`, stores `edited_text`, status `'edited'`
   - `regenerate(tx, link, deviceCookieHash, audit)`: consumes link, revokes unclosed siblings, marks old response `'superseded'`, inserts `generate_response` outbox entry with `version + 1`
   - All methods insert into `approval_audit_log` with `token_hash`, `device_cookie_hash`, `action`, `ip_address`, `metadata`

3. **Created `src/lib/approval/cookies.ts`** — device binding + CSRF utilities:
   - **Device cookie** (`__device`): HMAC-signed with `SESSION_COOKIE_SECRET`, format `{uuid}.{hmac}`, HttpOnly, Secure, SameSite=Lax, 48h max-age. Constant-time comparison for HMAC verification
   - `setDeviceCookie(response)`: generates + sets cookie, returns signed value
   - `getDeviceCookieHash(request)`: reads cookie, verifies HMAC, returns SHA-256 hash for DB comparison
   - `verifyDeviceCookie(request)`: validates HMAC signature
   - **CSRF** (`__csrf`): double-submit cookie pattern, NOT HttpOnly (JS reads it)
   - `setCsrfCookie(response)`: generates token, sets cookie
   - `validateCsrf(request)`: compares `x-csrf-token` header with cookie value, constant-time

4. **Updated `src/lib/approval/index.ts`** — barrel exports for service, cookies, errors

5. **Created 5 API routes** under `src/app/api/approve/[token]/`:
   - **GET `route.ts`**: read-only token lookup, rate-limited (`10/min per IP`), fetches review+response+business, sets device+CSRF cookies, returns data with Cache-Control: no-store
   - **POST `session/route.ts`**: validates CSRF, gets device cookie hash, calls `lockValidLink` + `establishApprovalSession` in one transaction
   - **POST `approve/route.ts`**: validates CSRF + device cookie, calls `lockValidLink` + `approve` in one transaction
   - **POST `edit/route.ts`**: same + parses `editedText` from body (validated non-empty), calls `lockValidLink` + `edit`
   - **POST `regenerate/route.ts`**: same pattern, calls `lockValidLink` + `regenerate`
   - All routes return typed error responses (404/410/403/400/500) with descriptive messages, all set Cache-Control: no-store, private

6. **Created approval page** at `src/app/(public)/approve/[token]/`:
   - **Server component** (`page.tsx`): hashes token server-side, validates approval link in DB. Invalid/expired/consumed/revoked → renders error page directly. Valid → renders minimal shell (business name + "Review a draft response") with NO review text in server HTML
   - **Client component** (`approval-client.tsx`): fetches GET `/api/approve/{token}` on mount, POSTs `/api/approve/{token}/session` for device binding. Displays: review card (stars, reviewer name, date, text), response in editable textarea, 3 action buttons (Approve, Edit, Regenerate). Edit mode toggles textarea to editable. All POSTs include `x-csrf-token` header. Shows loading spinner, success confirmation, error messages. Mobile-first Tailwind layout. Expiry countdown in hours.

7. **Created unit tests** (17 new tests across 2 files):
   - `src/lib/approval/__tests__/service.test.ts` (10 tests): lockValidLink (valid/unknown/expired/consumed/revoked), establishApprovalSession (bind + device conflict), approve (outbox payload verification), edit (real Levenshtein computation), regenerate (version increment + payload)
   - `src/lib/approval/__tests__/cookies.test.ts` (7 tests): setDeviceCookie (format + cookie set), getDeviceCookieHash (valid hash + missing), verifyDeviceCookie (valid HMAC + tampered), validateCsrf (match + mismatch)

**Post-review fixes:**
- Fixed non-atomic approval state changes: added `lockPendingResponse()` helper that locks the response row with `FOR UPDATE` and checks `status === 'pending_approval'` BEFORE any link is consumed. `approve`, `edit`, and `regenerate` all call this first — if the response is no longer pending, `ResponseNotPendingError` is thrown and the entire transaction rolls back (no link consumed, no false success). New error type added to `errors.ts`, exported from barrel, handled with HTTP 409 in all 3 action routes.
- Fixed device cookie regenerated on every GET: `GET /api/approve/[token]` now calls `verifyDeviceCookie(request)` first and only creates a new device cookie when one doesn't exist or has an invalid HMAC. CSRF token still refreshed every time (short-lived nonce). Client component now checks the `/session` POST response and throws if non-2xx, preventing the UI from showing action buttons when session binding fails.
- Created `playwright.config.ts` with test dir `./e2e`, chromium + mobile-chrome projects, webServer config for local dev. Created `e2e/approval.spec.ts` with documented 5 test scenarios (skipped — see deferred item below).

**Deferred: Playwright E2E tests (plan deviation)**
Prompt 12 in `docs/Final_Implementation_Plan.md:908` specifies Playwright E2E tests for the approval flow (approve, edit, expired, regenerate, already-approved). These are **deferred to Prompt 18 (Sprint 4 hardening)** because meaningful approval-flow E2E requires: (1) seeded Postgres test state with stable tokens, (2) env isolation for test DB, (3) running worker process with Redis for the full regenerate/publish chain, and (4) ResponsePublisherWorker (Prompt 13) which does not exist yet. The `e2e/approval.spec.ts` file documents all 5 required scenarios as skipped placeholders. `pnpm test:e2e` validates the Playwright config but reports 0 passed with skipped placeholder tests (currently 2 skipped because the same skipped scenario runs across 2 Playwright projects) — this is NOT actual E2E coverage. The test infrastructure (seed scripts, server coordination, teardown) will be built in Sprint 4 and serve all E2E suites.

**Verification:** `tsc --noEmit` clean, 181/181 tests pass across 13 test files, `pnpm build` succeeds (approval page at `/approve/[token]` renders as dynamic route, 1.97 kB + 89.2 kB first load JS)

---

### Prompt 13 — Manual Posting + AdminExceptionWorker (2026-04-10)

**Status:** COMPLETE

Built the SerpAPI-mode posting workflow: ResponsePublisherWorker sends manual-post instructions to the sales partner, AdminExceptionWorker alerts on review edits after posting, and a minimal admin business detail page lets the sales partner copy responses and mark them as posted.

1. **Added `sendInternalEmail()` to `src/lib/notifications/email.ts`**:
   - Simple HTML email sender for admin notifications (reuses Resend singleton + mock mode)
   - `InternalEmailParams`: to, subject, bodyHtml
   - Requires `RESEND_FROM_EMAIL` (throws if not set — no hardcoded fallback)
   - Updated barrel exports in `index.ts`

2. **Created `worker/jobs/ResponsePublisherWorker.ts`** — `handlePublishResponse()`:
   - Reads response (with approved_text) + review + business from DB
   - **Idempotency**: if response is already `awaiting_manual_post` or `posted` → markOutboxCompleted, return
   - Subscription guard with workerType `'publisher'` — skips cancelled and pending_payment
   - Sets response status to `awaiting_manual_post`
   - Determines admin email: queries `users` table for admin/sales_partner role, falls back to `ADMIN_NOTIFICATION_EMAIL` env var. If neither exists → logs warning, markOutboxCompleted
   - Sends HTML email with: business name, reviewer + star rating, approved text in copyable block, Google Maps URL (`place_id:${google_place_id}`), paste instructions
   - All dynamic content HTML-escaped
   - Email failure → throws for BullMQ retry (safe — idempotency check prevents double status update)

3. **Created `worker/jobs/AdminExceptionWorker.ts`** — `handleAdminException()`:
   - Reads exception from `review_exceptions` joined with `reviews` + `businesses`
   - If exception not found or already resolved (`status != 'open'`) → markOutboxCompleted, return
   - JSONB parsing guard on `payload` column
   - If `ADMIN_NOTIFICATION_EMAIL` not set → markOutboxCompleted (can't send without recipient)
   - Sends HTML email explaining: business name, exception type, reviewer + rating, current review text, what happened, response status at time of edit, action needed
   - Email failure → throws for BullMQ retry

4. **Modified `worker/index.ts`** — registered both workers:
   - `publisherWorker` on `PUBLISH_RESPONSE` queue
   - `adminExceptionWorker` on `NOTIFY_ADMIN` queue
   - Both added to `workers` array for graceful shutdown
   - All 7 queue workers now implemented: demo, reviewSync, responseGen, notification, publisher, adminException (+ weekly summary remaining for Sprint 4)

5. **Replaced `src/app/admin/businesses/[id]/page.tsx`** — admin business detail:
   - Server component: reads business + all responses with `status = 'awaiting_manual_post'`
   - Shows: business name, subscription status, category, Google Maps link
   - "Awaiting Manual Post" section: reviewer + rating, review text snippet, approved response text in blue block
   - Client component (`manual-post-section.tsx`): "Copy to Clipboard" button (navigator.clipboard API), "Mark as Posted" button → POSTs to mark-posted API
   - Success state: shows green "Marked as posted" after successful POST

6. **Created `src/app/api/admin/businesses/[id]/mark-posted/route.ts`**:
   - POST route (protected by existing admin middleware)
   - Parses `responseId` from body, validates non-empty
   - `UPDATE responses SET status = 'posted', posted_at = NOW() WHERE id = $responseId AND business_id = $businessId AND status = 'awaiting_manual_post'`
   - Returns 200 on success, 404 if not found or wrong status

7. **Added `ADMIN_NOTIFICATION_EMAIL`** to `.env.example` and `.env.local`

8. **Created unit tests** (7 new tests across 2 files):
   - `worker/__tests__/ResponsePublisherWorker.test.ts` (4 tests): success (sets awaiting_manual_post + sends email), cancelled subscription (skip), already posted (idempotent skip), email failure (throws for retry)
   - `worker/__tests__/AdminExceptionWorker.test.ts` (3 tests): success (sends alert email), already resolved (skip), email failure (throws for retry)

**Post-review fixes:**
- Fixed manual-post email retries being skipped: `awaiting_manual_post` is no longer terminal in the idempotency check — only `posted` causes a skip. The worker proceeds to the email send path on retry, so a crash between the status UPDATE and sendInternalEmail doesn't silently lose the notification. Added a dedicated retry regression test (test 5) that verifies `sendInternalEmail` is called when response is already `awaiting_manual_post`.
- Fixed stale/wrong-business job resurrecting responses: status UPDATE now guards with `WHERE status IN ('approved', 'edited') AND business_id = $businessId`. A delayed `publish_response` outbox entry for a superseded or failed response returns `count: 0` and the worker completes the outbox without changing anything. Existing `awaiting_manual_post` skips the UPDATE and goes straight to email send.
- Fixed admin recipient lookup not business-scoped: replaced global admin query with spec-compliant chain: (1) `SELECT email FROM users WHERE role IN ('admin', 'sales_partner') AND business_id = $businessId`, (2) onboarding partner via `businesses.onboarded_by` (restricted to admin/sales_partner role), (3) `ADMIN_NOTIFICATION_EMAIL` env var. No global admin fallback — responses for business X never route to a sales partner managing business Y.

**Verification:** `tsc --noEmit` clean, 189/189 tests pass across 15 test files, `pnpm build` succeeds

---

### Sprint 2 done when
- [x] Shared utilities: subscription guard, outbox helpers, sanitizer, rate limiter, mock monitor, voice learning, worker types — all tested
- [x] OutboxPoller watchdog recovers stale dispatched entries (> 1 hour)
- [x] ReconciliationPoller creates sync_reviews outbox entries every 60 minutes for active businesses (with dedup guard)
- [x] Reviews polled via SerpAPI (or mock) and upserted with dedup (identity + content hash)
- [x] New reviews trigger response generation automatically
- [x] Cost circuit breaker works (per-business + global daily limits, concurrency, regen budget)
- [x] Avoid-facts guardrail checks generated responses and retries once if violated
- [x] Voice learning returns few-shot examples when >= 5 edited+posted responses exist
- [x] Email notifications sent with approval links (delivery tracked via Resend webhooks)
- [x] Approval tokens stored as SHA-256 hashes only — raw tokens never in Postgres, outbox payloads, or logs
- [x] Approval page works on mobile: approve, edit (with Levenshtein distance), regenerate
- [x] Regeneration chain works: old response superseded → new generated → new email → new link
- [x] Owner sees "we'll post it shortly" — manual posting invisible to them
- [x] Admin business detail page shows awaiting-manual-post responses with copy + mark-as-posted buttons
- [x] Review edit detection: edited reviews trigger regeneration (pending) or admin exception (posted)
- [x] Mock mode works for all workers (no real API calls in local development)
- [x] All workers register in worker/index.ts with graceful shutdown
- [ ] E2E approval flow tests pass in Playwright — **DEFERRED to Prompt 18 (Sprint 4)**, scaffolded in `e2e/approval.spec.ts`

---

## Sprint 3: Admin Dashboard + Payments (Days 14–19)

**Status:** NOT STARTED

---

## Sprint 4: Payments + Notifications

**Status:** NOT STARTED

---

## Sprint 5: GBP API Integration

**Status:** NOT STARTED
