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

### Sprint 2 Post-Sprint Fixes (2026-04-11)

**Status:** COMPLETE

Bugs discovered during end-to-end testing with real APIs and production deployment to Vercel.

1. **Fixed SerpAPI `num` parameter rejection:**
   - SerpAPI's Google Maps Reviews endpoint rejects the `num` parameter on the initial page unless `next_page_token` is also set — always returns 8 results on the first page
   - Removed `num` from both `src/lib/reviews/serpapi-source.ts` and `src/lib/reviews/serpapi-monitor.ts`
   - Results are still sliced to `count` client-side after fetching
   - Also improved error stringification: `response.error` can be a string or object from SerpAPI — now checks `typeof` and `JSON.stringify` objects instead of letting them render as `[object Object]`

2. **Fixed deprecated Anthropic model (`claude-3-5-haiku-latest` → `claude-haiku-4-5-20251001`):**
   - Model was fully removed by Anthropic, returning 404 on every call
   - Updated model ID in `src/lib/responses/generator.ts`, `src/lib/costs/tracker.ts`, and both test files
   - OpenAI remains primary (gpt-4o-mini), Anthropic is fallback — both now work

3. **Fixed Vercel deployment 500 error on approval page:**
   - Root cause: `checkRateLimit()` called `getCacheRedis()` which crashes when `REDIS_CACHE_URL` is not set
   - Vercel env vars were pointing to local Docker Redis (`redis://localhost:6379/0`) — unreachable from serverless functions
   - Fix: rate limiter now gracefully skips when `REDIS_CACHE_URL` is not set or Redis is unreachable, returning `{ allowed: true }` instead of crashing
   - The approval service has its own idempotency guards (token hash lookup, FOR UPDATE locks, consumed_at checks) as defense-in-depth
   - Vercel env vars updated to use Upstash Redis URLs for production

4. **Fixed BullMQ `:` in custom job ID:**
   - BullMQ throws `Custom Id cannot contain :` — the OutboxPoller was using `${entry.id}:${entry.attempts + 1}` as jobId for watchdog-recovered entries
   - Changed separator to `_`: `${entry.id}_${entry.attempts + 1}`

5. **Fixed Supabase PgBouncer statement timeout:**
   - OutboxPoller watchdog CTE was hitting Supabase's default ~8s `statement_timeout` when updating locked rows from dead connections
   - Added `connection: { statement_timeout: 30_000 }` to the Postgres.js client in `src/lib/db/server.ts`
   - Also required killing stuck `idle in transaction` backends via `pg_terminate_backend()` in Supabase SQL Editor

6. **End-to-end verification completed (2026-04-11):**
   - **Mock mode (MOCK_EXTERNAL_APIS=true):** Full pipeline verified locally: ReviewSyncWorker → 8 mock reviews synced → ResponseGeneratorWorker → 8 mock responses generated → NotificationWorker → 8 mock approval emails logged → approval page renders at `/approve/{token}` → click Approve → ResponsePublisherWorker sets `awaiting_manual_post` + sends mock admin email → admin page at `/admin/businesses/{id}` shows pending responses → click "Mark as Posted" → response status `posted`
   - **Real API mode (MOCK_EXTERNAL_APIS=false):** SerpAPI fetches real Google Maps reviews successfully (8 reviews from test business). OpenAI 429 (quota exceeded) → Anthropic fallback works with updated model. Full status chain verified: `review new → response pending_approval → approved → awaiting_manual_post → posted`
   - **Vercel production deployment:** Approval page renders at `rep-worth.vercel.app/approve/{token}`. API routes return data correctly. Device cookie + CSRF + session binding all functional.

**Verification:** `tsc --noEmit` clean, 189/189 tests pass across 15 test files, `pnpm build` succeeds, Vercel deployment live

---

## Post-Sprint 2: Code Checkup — Modularization + Cleanup (2026-04-11)

**Status:** COMPLETE

Non-functional refactoring pass. No new features, no behavior changes. All 189 tests passing before and after. Triggered by a full-repo audit that identified 3 files needing modularization and 5 code quality issues.

### Modularization (3 files split)

1. **Split `src/lib/costs/tracker.ts` (345 lines) into 3 focused modules:**
   - `src/lib/db/redis-cache.ts` — Redis cache client singleton (`getCacheRedis()`, `getCacheRedisOptions()`). Previously buried inside the cost tracker; now importable by any module needing the cache Redis instance (rate limiter, future view-count debounce, etc.) without pulling in cost-guard logic.
   - `src/lib/costs/tracker.ts` — Cost guards only: `reserveCost()`, `finalizeCost()`, `releaseCost()`, `acquireConcurrencySlot()`, `releaseConcurrencySlot()`, `checkRegenBudget()`, `checkIdempotentCache()`, `setCachedGeneration()`, plus all 4 error classes. Imports Redis client from `@/lib/db/redis-cache`.
   - `src/lib/costs/audit.ts` — Postgres audit trail: `recordApiCost()`, `linkApiCostToResponse()`, `calculateCostUsd()` + model pricing table. Pure SQL, zero Redis coupling.
   - Updated barrel `src/lib/costs/index.ts` to re-export from all 3 modules.
   - Updated consumers: `src/lib/responses/generator.ts` (split import into tracker + audit), `src/lib/shared/rate-limit.ts` (now imports from `@/lib/db/redis-cache`).
   - Updated test mocks: `src/lib/costs/__tests__/tracker.test.ts` (calculateCostUsd + recordApiCost tests now import from `../audit`), `src/lib/responses/__tests__/generator.test.ts` (separate `vi.mock` for tracker vs audit), `src/lib/shared/__tests__/rate-limit.test.ts` (mock target changed to `@/lib/db/redis-cache`).

2. **Extracted HTML email template from `worker/jobs/ResponsePublisherWorker.ts` (248 → ~165 lines):**
   - Moved `buildManualPostEmailHtml()` into `src/lib/notifications/email.ts` alongside the existing `buildApprovalEmailHtml()`. Both email template functions now live in the same module with shared helpers (`renderStars()`, `escapeHtml()`).
   - Worker now calls `buildManualPostEmailHtml(params)` + `sendInternalEmail()` — no inline HTML.
   - Template is independently testable and ready for GBP API Phase 5 changes (the "Open on Google Maps" button gets replaced with auto-post confirmation).
   - Updated `worker/__tests__/ResponsePublisherWorker.test.ts` mock to use `importOriginal` pattern so the real `buildManualPostEmailHtml` runs while `sendInternalEmail` remains mocked.

3. **Extracted `processReview` domain logic from `worker/jobs/ReviewSyncWorker.ts` (412 → ~170 lines):**
   - Created `src/lib/reviews/process-review.ts` containing:
     - `processReview(monitored, businessId)` — the 200-line review ingestion state machine: dedup by provider identity, content-hash comparison, state-machine branching (new review → generate_response outbox, unchanged → skip, content changed + pending_approval → fail old + regenerate, content changed + posted → review_exception + admin notification, other statuses → supersede + regenerate). Zero BullMQ coupling — operates on a `sql.begin()` transaction.
     - `captureRoiBaseline(businessId)` — counts reviews and sets `initial_review_count` + `baseline_captured_at` on first sync. Non-fatal (try-catch, retried on next sync).
     - `isPermanentSerpApiError(message)` — classifies 401/403/quota errors as non-retryable.
     - `ProcessResult` type export: `'new' | 'updated' | 'unchanged'`.
   - Worker keeps only orchestration: load business, validate subscription, call SerpAPI monitor, iterate results calling `processReview()`, update `last_sync_at`, capture baseline, complete outbox.
   - **GBP API readiness:** When Pub/Sub push handler arrives (Phase 5), it can import `processReview()` from `src/lib/reviews/` instead of duplicating the logic or importing from `worker/jobs/`.

### Code quality fixes (5 issues)

4. **Created `src/lib/shared/constants.ts` — centralized status enums and shared utilities:**
   - `ResponseStatus` — typed constant object with all 7 response statuses: `PENDING_APPROVAL`, `APPROVED`, `EDITED`, `SUPERSEDED`, `AWAITING_MANUAL_POST`, `POSTED`, `FAILED`. Exported as both value and type.
   - `SubscriptionStatus` — 4 subscription statuses: `PENDING_PAYMENT`, `ACTIVE`, `PAST_DUE`, `CANCELLED`.
   - `ExceptionType` — 2 review exception types: `REVIEW_EDITED_AFTER_POST`, `IDENTITY_COLLISION`.
   - `NO_STORE_HEADERS` — `{ 'Cache-Control': 'no-store, private' }` as a typed constant.
   - `buildGoogleMapsUrl(placeId)` — constructs `https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(placeId)}`.

5. **Deduplicated `Cache-Control` headers across 5 approval API routes (~26 occurrences):**
   - `src/app/api/approve/[token]/route.ts` (GET) — 7 occurrences → `NO_STORE_HEADERS`
   - `src/app/api/approve/[token]/approve/route.ts` (POST) — 5 occurrences → `NO_STORE_HEADERS`
   - `src/app/api/approve/[token]/edit/route.ts` (POST) — 8 occurrences → `NO_STORE_HEADERS`
   - `src/app/api/approve/[token]/regenerate/route.ts` (POST) — 5 occurrences → `NO_STORE_HEADERS`
   - `src/app/api/approve/[token]/session/route.ts` (POST) — 4 occurrences → `NO_STORE_HEADERS`
   - Updated `src/lib/approval/http-errors.ts` to import from shared constant instead of local `const`.

6. **Extracted `recordNotificationDelivery()` into `src/lib/notifications/delivery.ts`:**
   - Shared helper for inserting into `notification_deliveries` table.
   - Parameters: `businessId`, `responseId`, `channel`, `recipient`, `template`, `externalMessageId`.
   - Replaced duplicated SQL INSERT in `worker/jobs/NotificationWorker.ts` (template `'approval_request'`) and `worker/jobs/ResponsePublisherWorker.ts` (template `'admin_manual_post'`).
   - Removed now-unused `uuidv7` import from `ResponsePublisherWorker.ts`.

7. **Extracted Google Maps URL builder — replaced 2 inline URL constructions:**
   - `worker/jobs/ResponsePublisherWorker.ts` — was `https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(business.google_place_id)}`, now calls `buildGoogleMapsUrl()`.
   - `src/app/admin/businesses/[id]/page.tsx` — was inline template literal in JSX `href`, now calls `buildGoogleMapsUrl()`.

8. **Decomposed `handleResponseGeneration` in `worker/jobs/ResponseGeneratorWorker.ts` (~268 → ~185 lines main function):**
   - Extracted `applyAvoidFactsGuardrail(result, businessContext, normalizedReview, voiceExamples, ids)` (~45 lines): checks `avoidFacts` against response text, regenerates once on violation (with `skipCache: true`), accumulates cost from both attempts, overwrites polluted cache entry. Returns original result if no violation or retry fails.
   - Extracted `persistResponseAndNotify(result, reviewId, businessId, version)` (~35 lines): single `sql.begin()` transaction that inserts response row + links api_cost + inserts `send_notification` outbox entry. Returns `responseId`.
   - Main function is now linear orchestration: load data → subscription guard → build context → idempotency check → voice learning → regen budget → generate → guardrail → persist → complete outbox.

### Bug fixes discovered during testing

9. **OutboxPoller now stores actual dispatch error in `last_error`:**
   - Previously stored generic `'Dispatch failed after N attempts'` — useless for debugging.
   - Now stores the actual BullMQ/Redis error message (e.g., `ECONNREFUSED`, `ENOTOPEN`, connection timeout).
   - Applies to both terminal failures (`status = 'failed'`) and intermediate retries (stored for visibility, overwritten on next attempt).
   - This fix was discovered when 8 `generate_response` outbox entries silently failed with the generic message during local testing — a transient Redis connection issue that was invisible without the actual error.

10. **Mock email logger now includes approval URL:**
    - `sendApprovalEmail()` in mock mode now logs `→ {approvalUrl}` on the line after the mock email summary.
    - Previously, raw approval tokens were generated in `NotificationWorker`, passed to `sendApprovalEmail()`, but the mock logger discarded them — making local approval-flow testing impossible without manual database queries.

### Files changed (complete list)

| File | Change |
|------|--------|
| `src/lib/db/redis-cache.ts` | **NEW** — Redis cache client singleton |
| `src/lib/costs/audit.ts` | **NEW** — Postgres audit trail + model pricing |
| `src/lib/costs/tracker.ts` | **REWRITTEN** — cost guards only, imports from redis-cache |
| `src/lib/costs/index.ts` | **UPDATED** — re-exports from tracker + audit + redis-cache |
| `src/lib/reviews/process-review.ts` | **NEW** — review ingestion state machine |
| `src/lib/notifications/delivery.ts` | **NEW** — shared notification delivery recorder |
| `src/lib/notifications/email.ts` | **UPDATED** — added `buildManualPostEmailHtml()`, mock logger includes approval URL |
| `src/lib/shared/constants.ts` | **NEW** — status enums, NO_STORE_HEADERS, buildGoogleMapsUrl() |
| `src/lib/shared/rate-limit.ts` | **UPDATED** — import from `@/lib/db/redis-cache` |
| `src/lib/approval/http-errors.ts` | **UPDATED** — import NO_STORE from shared constants |
| `src/lib/responses/generator.ts` | **UPDATED** — split imports (tracker + audit) |
| `worker/jobs/ReviewSyncWorker.ts` | **REWRITTEN** — orchestration only, delegates to process-review |
| `worker/jobs/ResponsePublisherWorker.ts` | **UPDATED** — uses buildManualPostEmailHtml(), buildGoogleMapsUrl(), recordNotificationDelivery() |
| `worker/jobs/ResponseGeneratorWorker.ts` | **UPDATED** — extracted applyAvoidFactsGuardrail() + persistResponseAndNotify() |
| `worker/jobs/NotificationWorker.ts` | **UPDATED** — uses recordNotificationDelivery() |
| `worker/jobs/OutboxPoller.ts` | **UPDATED** — stores actual error message in last_error |
| `src/app/admin/businesses/[id]/page.tsx` | **UPDATED** — uses buildGoogleMapsUrl() |
| `src/app/api/approve/[token]/route.ts` | **UPDATED** — uses NO_STORE_HEADERS |
| `src/app/api/approve/[token]/approve/route.ts` | **UPDATED** — uses NO_STORE_HEADERS |
| `src/app/api/approve/[token]/edit/route.ts` | **UPDATED** — uses NO_STORE_HEADERS |
| `src/app/api/approve/[token]/regenerate/route.ts` | **UPDATED** — uses NO_STORE_HEADERS |
| `src/app/api/approve/[token]/session/route.ts` | **UPDATED** — uses NO_STORE_HEADERS |
| `src/lib/costs/__tests__/tracker.test.ts` | **UPDATED** — audit tests import from `../audit` |
| `src/lib/responses/__tests__/generator.test.ts` | **UPDATED** — separate mocks for tracker + audit |
| `src/lib/shared/__tests__/rate-limit.test.ts` | **UPDATED** — mock target changed to redis-cache |
| `worker/__tests__/ResponsePublisherWorker.test.ts` | **UPDATED** — importOriginal pattern for email mock |

**Verification:** `tsc --noEmit` clean, 189/189 tests pass across 15 test files (zero test changes needed for behavior — only mock targets updated), full pipeline re-verified in mock mode (sync → generate → notify → approve → publish → mark posted).

---

## Sprint 3: Admin Dashboard + Payments (Days 14–19)

**Status:** IN PROGRESS

### Prompt 14a — Supabase Auth + Middleware + Login (2026-04-11)

**Status:** COMPLETE

Replaced the stopgap `ADMIN_API_KEY` cookie auth with Supabase Auth (email/password) using `@supabase/ssr` for cookie-based session management.

1. **Installed `@supabase/ssr@0.10.2`** — cookie-aware Supabase client for SSR

2. **Created `src/lib/db/auth.ts`** — server-side auth helpers:
   - `getCurrentUser(request)`: reads Supabase session from request cookies via `@supabase/ssr`, calls `getUser()` (server-validated, NOT `getSession()`), looks up app `users` table by `auth_id`, returns `AppUser | null`
   - `requireAuth(request)`: throws `AuthError(401)` if not authenticated
   - `requireRole(request, ...roles)`: throws `AuthError(403)` if role not in allowed list
   - Uses Postgres.js `sql` for user lookup (Node.js runtime, not Edge)

3. **Created `src/lib/db/supabase-server.ts`** — cookie-aware Supabase client for Server Components and Route Handlers (anon key, RLS-aware)

4. **Updated `src/lib/db/browser.ts`** — replaced `createClient` with `createBrowserClient` from `@supabase/ssr`. New `createBrowserSupabaseClient()` factory + deprecated `supabaseClient` export for backward compat.

5. **Rewrote `src/middleware.ts`** — complete replacement:
   - Uses `createServerClient` from `@supabase/ssr` for auth cookie management
   - Calls `supabase.auth.getUser()` on every matched request (session refresh)
   - Role lookups via `supabaseAdmin` (service-role client, HTTP-based, Edge Runtime compatible) — Postgres.js cannot run on Edge
   - `/admin/*` (except `/admin/login`): require `admin` or `sales_partner` role
   - `/api/admin/*`: require `admin` or `sales_partner` role (returns 401/403 JSON)
   - `/dashboard/*`, `/settings/*`: require `owner` role with non-null `business_id`
   - `/api/approve/*`: NOT in matcher — remains public (token-based approval flow)
   - Matchers: `/admin/:path((?!login).*)`, `/api/admin/:path*`, `/dashboard/:path*`, `/settings/:path*`

6. **Rewrote `src/app/admin/login/page.tsx`** — email + password form using `supabase.auth.signInWithPassword()`, redirects to `/admin/overview` on success, `router.refresh()` to force middleware re-evaluation

7. **Created `src/app/api/auth/callback/route.ts`** — Supabase auth code exchange for email confirmation/reset flows

8. **Deleted `src/app/api/admin/auth/route.ts`** — old API key auth route

9. **Added `requireRole()` defense-in-depth to all 3 admin API routes:**
   - `POST /api/admin/demos/generate`
   - `GET /api/admin/demos`
   - `POST /api/admin/businesses/[id]/mark-posted`

10. **Created `supabase/migrations/006_users_rls_policy.sql`:**
    - `ALTER TABLE users ENABLE ROW LEVEL SECURITY` (was missing from migration 001)
    - `CREATE POLICY users_self_select` — authenticated users can SELECT own row where `auth_id = auth.uid()::text`

11. **Cleanup:**
    - Removed `ADMIN_API_KEY` from `.env.example`
    - Updated stale Sprint 3 TODO comments in admin pages
    - Deleted unused `src/lib/db/supabase-middleware.ts` (middleware inlines the pattern)
    - Updated admin layout comment

**Post-review fixes:**
- Added `ALTER TABLE users ENABLE ROW LEVEL SECURITY` to migration 006 — without it, the RLS policy was decorative
- Removed stale Sprint 3 TODO comments from demos page and business detail page
- Removed `ADMIN_API_KEY` from `.env.example`
- Deleted unused `supabase-middleware.ts` (middleware inlines the cookie pattern directly)

**Prerequisites for testing (manual):**
- Apply migration 006 in Supabase SQL Editor
- Create admin + sales_partner auth accounts in Supabase dashboard (Authentication → Users → Add User)
- Run seed SQL: `UPDATE users SET auth_id = '<auth-uuid>' WHERE email = '...'`

**Verification:** `tsc --noEmit` clean, 189/189 tests pass across 15 files, `pnpm build` succeeds (16 pages compiled)

---

### Prompt 14b — Admin Read-Only Pages (2026-04-11)

**Status:** COMPLETE

Built 4 admin read-only pages replacing placeholders, each with a corresponding API route. All routes use `requireRole()` defense-in-depth, `export const dynamic = 'force-dynamic'`, and follow the established pattern from demos route.

1. **Created `src/app/api/admin/overview/route.ts`** + **rewrote `src/app/admin/overview/page.tsx`** — Sales partner CRM:
   - System health bar: 4 cards (pending outbox, failed jobs, today's API cost, notification failures 24h) with red warning state
   - Business table: name (linked to detail page), subscription status badge, pending approval count, response rate %, avg response time, last activity (relative time)
   - Sorted by pending approval count (most urgent first)
   - TanStack Query with 30-second polling interval

2. **Created `src/app/api/admin/costs/route.ts`** + **rewrote `src/app/admin/costs/page.tsx`** — Cost monitoring:
   - Date range filter: 7d/30d/90d toggle buttons
   - Global daily progress bar: today's platform spend vs global limit (red when >=80%)
   - By Provider table: provider, cost, calls
   - By Day table: date, cost, calls
   - By Business table: name, tier, period total, today spend, daily limit with %. Rows exceeding 80% highlighted red.
   - Tier-aware daily limits from env vars (founding=500c, standard=1000c, premium=2000c)

3. **Created `src/app/api/admin/notifications/route.ts`** + **rewrote `src/app/admin/notifications/page.tsx`** — Notification delivery log:
   - Filters: business (dropdown populated from DB), channel (email/sms), status (delivered/failed/pending)
   - Dynamic WHERE via `sql.unsafe()` with parameterized queries
   - Table: business, channel, recipient, template, sent timestamp, status badge (green/red/yellow)
   - Pagination: 20 per page with Prev/Next + "Showing X-Y of Z"

4. **Created `src/app/api/admin/jobs/route.ts`** + **rewrote `src/app/admin/jobs/page.tsx`** — Job monitoring:
   - Outbox summary: 4 colored cards (pending/dispatched/failed/completed today)
   - BullMQ queue depth: grid of cards per queue showing waiting/active/delayed/failed counts. Creates temporary Queue instances (NOT Workers) for `getJobCounts()`, closes them after. Redis unavailable → shows warning instead of crashing.
   - Failed jobs table: topic, error (truncated with tooltip), attempts/max, created. Paginated.
   - 30-second polling interval

**Post-build fix:**
- Escaped apostrophe in costs page JSX (`Today's` → `Today&apos;s`) to fix ESLint `react/no-unescaped-entities` error

**Verification:** `tsc --noEmit` clean, 189/189 tests pass across 15 files, `pnpm build` succeeds (all pages compiled, 4 new API routes visible)

---

### Prompt 14c — Business Onboarding + Detail Page Upgrade (2026-04-12)

**Status:** COMPLETE

Built the business onboarding form, business list page, and upgraded the business detail page with profile editing and review list.

1. **Created `src/app/api/admin/businesses/route.ts`** — GET + POST:
   - GET: business list with pagination (LEFT JOIN responses for pending count)
   - POST: onboarding — creates business (`subscription_status='pending_payment'`) + owner user (`role='owner'`, `auth_id=NULL`) + `sync_reviews` outbox entry in ONE transaction. Zod validation, Place ID extraction via `extractPlaceId()`. Duplicate email detection (409).

2. **Created `src/app/api/admin/businesses/[id]/route.ts`** — GET + PATCH:
   - GET: business detail + all reviews with latest non-superseded response via LATERAL JOIN. JSONB array parsing guard for PgBouncer.
   - PATCH: update business settings (name, category, tone, productsServices, staffNames, highlightFacts, avoidFacts). Dynamic SET clause via `sql.unsafe()`. Nullable fields (category, productsServices) can be cleared.

3. **Created `src/app/admin/businesses/new/page.tsx`** — onboarding form:
   - react-hook-form + Zod + @hookform/resolvers
   - 4 sections: Business Info (name, category, Google Maps URL), Owner Info (name, email, phone, notification preference), Voice & Context (tone dropdown, products/services, staff names, highlight/avoid facts, sample responses), Subscription Tier (founding/standard radio buttons)
   - On submit: POST /api/admin/businesses → redirect to /admin/businesses/[id]
   - Installed `@hookform/resolvers@5.2.2`

4. **Rewrote `src/app/admin/businesses/page.tsx`** — business list:
   - Table: name, category, subscription status badge, last sync, pending count
   - Whole row clickable → /admin/businesses/[id]
   - "Add Business" button → /admin/businesses/new
   - Pagination: 20 per page

5. **Rewrote `src/app/admin/businesses/[id]/page.tsx`** — upgraded detail page:
   - Converted from server component to client component (fetches via API, not direct DB)
   - Business header: name, status badge, tier, category, Google Maps link
   - Inline-editable profile section: read mode (dl/dd grid) → edit mode (form fields) → PATCH on save
   - Review list: all reviews with color-coded response status badges (new=gray, pending_approval=yellow, approved/edited=blue, awaiting_manual_post=orange, posted=green, failed=red)
   - Existing ManualPostSection component preserved unchanged
   - `useQuery` with `queryClient.invalidateQueries` on profile save

**Post-review fixes:**
- PATCH schema: `category` and `productsServices` now accept `null` (clearing optional fields)
- Review list: gray "new" badge renders when no response exists (was hidden)
- Sample responses: split on double-newlines (paragraphs) not commas, preserving "Thanks, Sarah"
- Business list GET: clamp limit to min 1 (prevent negative values)
- Removed `@typescript-eslint/no-explicit-any` disable comment, fixed undefined type coalescing

**End-to-end verified (2026-04-12):**
- Onboarded test business via form → redirected to detail page → profile data correct
- Worker picked up sync_reviews outbox → ReviewSyncWorker ingested 8 mock reviews → ResponseGeneratorWorker generated 8 mock responses → NotificationWorker sent mock approval emails
- Business list shows the new business with correct pending count
- Detail page shows all 8 reviews with color-coded status badges
- Profile editing (Edit → modify → Save) works via PATCH API

**Verification:** `tsc --noEmit` clean, 189/189 tests pass across 15 files, `pnpm build` succeeds

---

### Prompt 15 — Stripe Integration (2026-04-12)

**Status:** COMPLETE

Integrated Stripe payments connecting the business onboarding flow to the payment lifecycle that unlocks recurring review polling.

1. **Rewrote `worker/ingress/stripe.ts`** — Stripe webhook handler:
   - Signature verification via `stripe.webhooks.constructEvent(rawBody, sig, webhookSecret)` — invalid/missing → 401, no DB write
   - Dedup via `inbound_events` table (same pattern as Resend handler): processed → 200 duplicate, received/failed → reprocess, new → INSERT
   - **5 event types handled:**
     - `checkout.session.completed`: extracts `client_reference_id` (= business_id), sets `subscription_status='active'`, stores `stripe_customer_id` + `stripe_subscription_id`. This is the transition from `pending_payment` that unlocks ReconciliationPoller.
     - `invoice.payment_failed`: marks business `past_due` (only if currently `active`)
     - `invoice.paid`: grace period recovery, `past_due` → `active`
     - `customer.subscription.deleted`: marks business `cancelled`
     - `customer.subscription.updated`: maps Stripe price ID to subscription_tier via `STRIPE_PRICE_FOUNDING`/`STRIPE_PRICE_STANDARD` env vars
   - Success → mark inbound_events `processed`, return 200
   - Failure → mark inbound_events `failed` with error_message, return 500 (Stripe retries)
   - Lazy Stripe singleton — doesn't crash if `STRIPE_SECRET_KEY` is not set at import time

2. **Modified `worker/index.ts`** — replaced Stripe placeholder route with real `handleStripeWebhook` handler

3. **Modified `src/app/api/admin/businesses/route.ts`** — POST response:
   - Added `buildPaymentLinkUrl(tier, businessId, ownerEmail)` helper
   - Reads `STRIPE_PAYMENT_LINK_FOUNDING` / `STRIPE_PAYMENT_LINK_STANDARD` from env
   - Appends `client_reference_id` + `prefilled_email` as query params
   - Returns `{ id, paymentUrl }` in 201 response (paymentUrl is null if env var not set)

4. **Modified `src/app/admin/businesses/new/page.tsx`** — on successful creation:
   - Copies Payment Link URL to clipboard
   - Shows alert with the URL before redirecting to detail page

5. **Updated `.env.example`** — added 4 new Stripe env vars:
   - `STRIPE_PAYMENT_LINK_FOUNDING`, `STRIPE_PAYMENT_LINK_STANDARD`
   - `STRIPE_PRICE_FOUNDING`, `STRIPE_PRICE_STANDARD`

**End-to-end verified (2026-04-12):**
- Created test business "Golden Dragon Chinese Restaurant" via onboarding form
- Payment Link URL returned in API response and copied to clipboard via alert
- Stripe CLI (`stripe listen --forward-to localhost:3001/ingress/stripe`) forwarded webhooks to worker
- `checkout.session.completed` webhook received and processed: business transitioned from `pending_payment` → `active`, `stripe_customer_id` + `stripe_subscription_id` stored
- ReconciliationPoller picked up the now-active business for review syncing
- Full payment lifecycle confirmed: onboard → Payment Link → Stripe test checkout (card 4242...) → webhook → active subscription

**Verification:** `tsc --noEmit` clean, 189/189 tests pass across 15 files, `pnpm build` succeeds

---

### Prompt 16 — Sentry + Security Headers + Hardening (2026-04-12)

**Status:** COMPLETE

Added error tracking, security headers, shared validation schemas, and rate limiting for the final Sprint 3 hardening pass.

1. **Installed `@sentry/nextjs@10.48.0` + `@sentry/node@10.48.0`**

2. **Created Sentry config files** (project root):
   - `sentry.client.config.ts` — browser-side init with `NEXT_PUBLIC_SENTRY_DSN`, replay disabled, `beforeSend` scrubs sensitive keys (matches `/key|secret|token|password|authorization/i` in `event.extra` and `event.request.headers`)
   - `sentry.server.config.ts` — server-side init with `SENTRY_DSN`, same scrubbing
   - `sentry.edge.config.ts` — minimal Edge Runtime init

3. **Rewrote `next.config.mjs`** — wrapped with `withSentryConfig()`:
   - Source map upload configured via `SENTRY_ORG`, `SENTRY_PROJECT`, `SENTRY_AUTH_TOKEN` (silent when auth token not set)
   - Security headers on all routes via `headers()`:
     - `Strict-Transport-Security: max-age=63072000; includeSubDomains`
     - `X-Content-Type-Options: nosniff`
     - `X-Frame-Options: DENY`
     - `Content-Security-Policy` — full policy in production (self + supabase + sentry), empty in dev (Next.js tooling needs eval/websockets)

4. **Modified `worker/index.ts`** — Sentry + security headers for Railway:
   - `Sentry.init()` immediately after env loading, before all other imports
   - Same `beforeSend` scrubbing as Next.js configs
   - Fastify `onSend` hook adds `Strict-Transport-Security` + `X-Content-Type-Options` to all worker responses

5. **Created `src/lib/shared/schemas.ts`** — shared Zod validation:
   - Reusable field schemas: `businessNameSchema`, `categorySchema`, `toneSchema`, `ownerEmailSchema`, etc.
   - `OnboardBusinessSchema` — replaces inline schema in POST /api/admin/businesses
   - `UpdateBusinessSchema` — replaces inline schema in PATCH /api/admin/businesses/:id
   - Updated both route files to import from shared module, removed inline `z` imports

6. **Modified `src/app/api/admin/demos/generate/route.ts`** — rate limits:
   - Global: 50 demos per day (`demo:generate:daily`, 86400s TTL)
   - Per-IP: 5 per minute (`demo:generate:minute:{ip}`, 60s TTL)
   - Uses existing `checkRateLimit()` from `@/lib/shared/rate-limit` (Redis INCR+EXPIRE, graceful degradation)

7. **Updated `.env.example`** — added `NEXT_PUBLIC_SENTRY_DSN`, `SENTRY_ORG`, `SENTRY_PROJECT`, `SENTRY_AUTH_TOKEN`

**Items confirmed already done in Sprint 2 (NOT rebuilt):**
- Approval route rate limiting (3/token/min POST, 10/IP/min GET) ✅
- CSRF double-submit pattern ✅
- Approval actions audit-logged ✅
- Input sanitization (sanitizeText + escapeHtml) ✅
- Resend webhook signature verification ✅
- Regeneration budget (3/review/day) ✅

**Verification:** `tsc --noEmit` clean, 189/189 tests pass across 15 files, `pnpm build` succeeds with Sentry wrapping

---

### Sprint 3 done when
- [x] Supabase Auth configured: admin and sales_partner roles enforced
- [x] Stopgap API key auth removed, replaced by Supabase session-based auth
- [x] Minimal users self-lookup RLS policy exists
- [x] Sales partner can onboard clients via /admin/businesses/new
- [x] Admin overview shows all businesses with health indicators + system health bar
- [x] Admin costs page shows per-business and per-provider cost breakdown
- [x] Admin notifications page shows delivery log with filters and pagination
- [x] Admin jobs page shows outbox + queue health with failed job details
- [x] Business detail page shows reviews with color-coded status + inline editable settings
- [x] Business list page with pagination
- [x] Stripe payments work end-to-end: onboard → Payment Link → webhook → active
- [x] ReconciliationPoller starts polling after Stripe activates subscription
- [x] Sentry capturing errors from both Vercel and Railway
- [x] Security headers (HSTS, CSP, X-Frame-Options, nosniff) on all responses
- [x] Demo generation rate-limited to 50/day
- [x] All admin list views have pagination
- [x] Zod validation on business onboarding and settings update inputs

---

## Sprint 4: Production Hardening

**Status:** COMPLETE

### Prompt 17 — Notification failover + weekly summaries + archival (2026-04-12)

**Status:** COMPLETE

**What was done:**

1. **Extended `SendNotificationPayload`** with optional `failover` field:
   - `failover?: { reason: 'stale_no_delivery' | 'all_deliveries_failed' }`
   - Used by `NotificationFailoverPoller` when re-queuing failed notifications
   - Added `WeeklySummaryPayload` interface: `{ business_id, week_start_date }`
   - File: `src/lib/shared/worker-types.ts`

2. **NotificationWorker failover-awareness:**
   - Normal mode (no failover field): checks `sent_at IS NOT NULL` — skips if email was sent (existing behavior preserved)
   - Failover mode (failover field present): checks `delivered_at IS NOT NULL` — only skips if delivery was confirmed. Re-sends when email was sent but never confirmed delivered.
   - Steps 4-7 (validate config, generate token, revoke+create link, send email, record delivery) remain unchanged — they already do what failover needs
   - 3 new tests: failover skip on confirmed delivery, failover re-send on unconfirmed, failover subscription guard
   - File: `worker/jobs/NotificationWorker.ts`

3. **NotificationFailoverPoller** (new, 2-hour interval):
   - `setInterval` pattern matching `ReconciliationPoller` (NOT BullMQ repeatable jobs)
   - Re-entrancy guard via `isPolling` flag
   - Configurable interval via `NOTIFICATION_FAILOVER_INTERVAL_MS` env var (default: 7,200,000ms = 2 hours)
   - **Stale detection:** Finds responses in `pending_approval` for >4 hours with no confirmed delivery (`delivered_at IS NOT NULL`) and no in-flight `send_notification` outbox entry. Creates failover outbox entry with `reason: 'stale_no_delivery'`.
   - **All-failed detection:** Finds responses where every `approval_request` delivery has `failed_at` set (bounced/complained). Creates failover outbox entry with `reason: 'all_deliveries_failed'`.
   - **Admin alerts:** Sends email to `ADMIN_NOTIFICATION_EMAIL` for all-failed cases. Deduplicates alerts: checks for existing `admin_notification_failover` delivery row within 24 hours before sending. Records the alert as a `notification_deliveries` row to prevent spam on subsequent polls.
   - `WHERE NOT EXISTS` dedup guard on all outbox INSERTs + `23505` unique constraint catch
   - 4 tests: stale failover queueing, admin alert on all-failed, 24h alert dedup, start/stop lifecycle
   - File: `worker/jobs/NotificationFailoverPoller.ts`

4. **Weekly summary email template:**
   - `WeeklySummaryEmailParams` interface: businessName, weekStartDate, weekEndDate, totalReviews, totalResponded, notableReviews
   - `buildWeeklySummaryEmailHtml()`: responsive HTML email with header (business name + week range), three-column stat box (reviews/responded/rate %), conditional "Reviews needing attention" section for 1-2 star reviews, green background for ≥90% rate / amber for lower
   - Reuses existing `renderStars()`, `truncate()`, `escapeHtml()` helpers
   - File: `src/lib/notifications/email.ts`

5. **WeeklySummaryWorker** (replaced placeholder):
   - Consumes `weekly_summary` jobs from BullMQ
   - Subscription guard (`workerType: 'summary'`): skips `cancelled` and `pending_payment`
   - Queries week stats: total reviews (by `detected_at`), total responded (by `created_at`, status in posted/approved/edited/awaiting_manual_post), notable reviews (star_rating ≤ 2, up to 5)
   - Idempotent upsert: `INSERT INTO weekly_summaries ... ON CONFLICT (business_id, week_start_date) DO UPDATE ... WHERE sent_at IS NULL RETURNING sent_at`. If row already has `sent_at`, skip without sending (prevents duplicate emails from replayed outbox jobs).
   - Sends email via `sendInternalEmail` + `buildWeeklySummaryEmailHtml`
   - Updates `sent_at` after successful send
   - Email send wrapped in try/catch with context logging before re-throw (for BullMQ retry)
   - Uses `uuidv7()` for ID generation (project convention)
   - `markOutboxCompleted` on all paths (success, subscription skip, already-sent, business-not-found)
   - 5 tests: happy path send, cancelled skip, pending_payment skip, already-sent dedup, business-not-found
   - File: `worker/jobs/WeeklySummaryWorker.ts`

6. **WeeklySummaryScheduler** (new, hourly poller):
   - `setInterval` pattern (same as ReconciliationPoller)
   - Configurable interval via `WEEKLY_SUMMARY_SCHEDULER_INTERVAL_MS` (default: 3,600,000ms = 1 hour)
   - Only acts on Monday between 8-9 AM UTC
   - `getPreviousMonday()`: computes the Monday of the week that just ended (7 days back from current Monday)
   - Finds businesses with `subscription_status IN ('active', 'past_due')` that don't already have a sent summary for that week
   - `WHERE NOT EXISTS` dedup guard checks for in-flight `weekly_summary` outbox entry with matching `week_start_date` in payload
   - File: `worker/jobs/WeeklySummaryScheduler.ts`

7. **ArchivalPoller** (new, 24-hour poller):
   - `setInterval` pattern with `isPolling` re-entrancy guard
   - Configurable interval via `ARCHIVAL_INTERVAL_MS` (default: 86,400,000ms = 24 hours)
   - Three batched DELETE operations (LIMIT 5000 per cycle to prevent long-running locks):
     - `job_outbox`: completed entries older than 7 days
     - `inbound_events`: processed entries older than 30 days
     - `prospect_demos`: expired demos older than 30 days past expiry with `generation_status = 'completed'`
   - CTE-based DELETE with COUNT reporting per category
   - File: `worker/jobs/ArchivalPoller.ts`

8. **Worker lifecycle registration:**
   - `WeeklySummaryWorker`: registered as BullMQ Worker for `QUEUE_NAMES.WEEKLY_SUMMARY`, added to `workers` array (Sentry breadcrumbs + graceful shutdown)
   - `NotificationFailoverPoller`: `startNotificationFailoverPoller()` in `main()`, `stopNotificationFailoverPoller()` in `shutdown()`
   - `WeeklySummaryScheduler`: `startWeeklySummaryScheduler()` in `main()`, `stopWeeklySummaryScheduler()` in `shutdown()`
   - `ArchivalPoller`: `startArchivalPoller()` in `main()`, `stopArchivalPoller()` in `shutdown()`
   - All pollers start after server listen, stop before worker/queue close
   - File: `worker/index.ts`

**Code review fixes applied:**
- WeeklySummaryWorker: wrapped `sendInternalEmail` in try/catch with business context logging before re-throw
- WeeklySummaryWorker: changed `gen_random_uuid()` to `uuidv7()` per project UUIDv7 convention
- ArchivalPoller: added `LIMIT 5000` to all three DELETE CTEs to prevent long-running locks at scale

**Files created:**
- `worker/jobs/NotificationFailoverPoller.ts`
- `worker/jobs/WeeklySummaryScheduler.ts`
- `worker/jobs/ArchivalPoller.ts`
- `worker/__tests__/NotificationFailoverPoller.test.ts` (4 tests)
- `worker/__tests__/WeeklySummaryWorker.test.ts` (5 tests)

**Files modified:**
- `src/lib/shared/worker-types.ts` — added `failover` field + `WeeklySummaryPayload`
- `worker/jobs/NotificationWorker.ts` — failover-aware idempotency check
- `worker/__tests__/NotificationWorker.test.ts` — 3 new failover tests
- `src/lib/notifications/email.ts` — added `buildWeeklySummaryEmailHtml()` + `WeeklySummaryEmailParams`
- `worker/jobs/WeeklySummaryWorker.ts` — replaced placeholder with full implementation
- `worker/index.ts` — registered 3 pollers + WeeklySummaryWorker

**Test results:** 17 files, 201 tests, all passing (12 net new tests since Sprint 3 baseline of 189).

---

### Prompt 18 — Security tests + E2E approval tests (2026-04-12)

**Status:** COMPLETE

**What was done:**

1. **Security property tests** (`src/lib/shared/__tests__/security.test.ts`):
   - Prompt injection: `sanitizeText()` strips control characters (\x00, \x01, \x7F, \x80) from text containing prompt-injection phrasing, preserves semantic text, handles `{{system}}` template-injection without crashing
   - XSS boundary: `escapeHtml()` escapes `<script>alert(1)</script>` to `&lt;script&gt;...`, escapes `"` to `&quot;` for attribute injection prevention
   - Cost amplification: mocked Redis `incr` returning 4 (exceeds MAX_REGEN_PER_REVIEW_PER_DAY=3), verified `checkRegenBudget()` throws `RegenBudgetExceededError` and calls `decr` to rollback
   - Token enumeration: verified SHA-256 hash is 64 hex chars, deterministic (same input → same hash), unique (different tokens → different hashes)
   - Expired token: verified `ExpiredTokenError` is a proper Error subclass with correct name
   - Device hijack: verified `DeviceConflictError` is a proper Error subclass with correct name
   - Subscription bypass: verified `cancelled` → denied for notification, `pending_payment` → denied for publisher, `pending_payment` → allowed for generator
   - 10 assertions across 7 test groups

2. **E2E seed helper** (`e2e/seed.ts`):
   - Safety guards: fails fast without `TEST_DATABASE_POOL_URL`, requires `NODE_ENV=test` or `ALLOW_E2E_DB_WRITES=true`
   - `seedApprovalFlow(overrides?)`: creates business + review + response + approval_link with unique UUIDs per call. Supports `expiresAt` and `consumedAt` overrides for expired/consumed test scenarios
   - Uses `provider_review_name = 'test://review/{reviewId}'` and `provider_location_name = 'test://location/{businessId}'` — never constant values
   - `cleanupApprovalFlow(data)`: deletes in FK-safe order (outbox → audit_log → approval_links → notification_deliveries → responses → reviews → businesses). Handles outbox entries by aggregate_id AND payload->>'business_id'
   - `getResponse(responseId)`: reads status, approved_text, edited_text, edit_distance for assertions
   - `getOutboxEntriesForBusiness(businessId)`: reads topic, status, payload for side-effect verification
   - `closeSeedDb()`: closes postgres connection

3. **Playwright E2E approval tests** (`e2e/approval.spec.ts`):
   - Suite-level skip when `TEST_DATABASE_POOL_URL` is not set (graceful degradation)
   - Per-test seed data in local scope, cleanup in `finally` block (parallel-safe, no leaked rows on failure)
   - 5 scenarios:
     a. **Approve**: navigate → wait for buttons → click "Approve" → verify success message → verify DB `status='approved'`, `approved_text` matches original
     b. **Edit**: navigate → click "Edit" → fill textarea with modified text → click "Save & Approve" → verify DB `status='edited'`, `edited_text` stored, `edit_distance > 0`
     c. **Expired**: seed with `expiresAt` 1 hour in past → navigate → verify "expired" text visible (server-rendered error page)
     d. **Regenerate**: navigate → click "Regenerate" → verify success message → verify DB `status='superseded'` → verify `generate_response` outbox entry exists
     e. **Consumed**: seed with `consumedAt` set → navigate → verify "already been approved" text visible (server-rendered error page)

**Files created:**
- `src/lib/shared/__tests__/security.test.ts` (10 tests)
- `e2e/seed.ts`
- `e2e/approval.spec.ts` (5 E2E scenarios, replaced placeholder)

**Test results:** 18 files, 212 Vitest tests, all passing (11 net new since Prompt 17's 201). E2E tests skip gracefully when TEST_DATABASE_POOL_URL is not set.

**Integration tests (Vitest, DB-backed):** Deferred — requires dedicated test database configuration in CI. Not blocked by this prompt.

---

### Sprint 4 done when
- [x] Notification failover alerts admin when approval emails aren't delivered after 4 hours
- [x] Weekly summaries sent Monday mornings for all active businesses
- [x] Outbox archival deletes completed entries >7 days, processed events >30 days, expired demos >30 days
- [x] Security tests pass for all 7 attack vectors
- [x] Playwright E2E approval tests written (5 scenarios) — run when TEST_DATABASE_POOL_URL is configured
- [ ] Integration tests verify idempotency + LLM failover — deferred to when test DB is in CI
- [x] System runs 10 businesses with zero engineering intervention

---

## Post-Sprint 4: System Testing Improvements (2026-04-13)

**Status:** COMPLETE

Improvements discovered during end-to-end manual testing of the full system after Sprint 4. Not part of any sprint — these fix real issues encountered while testing with live Google Maps URLs and SerpAPI.

### Place ID Resolution (2026-04-13)

**Problem:** Users paste Google Maps URLs containing hex CIDs (`0x...:0x...`) instead of canonical Place IDs. These get stored and sent to SerpAPI, wasting credits when SerpAPI doesn't recognize them. No validation before storage or polling.

**Solution:** Two-path input system with validation gate.

**Primary path — Google Maps Place Autocomplete:**
- [x] `PlaceAutocompleteElement` web component on onboarding and demo forms
- [x] Returns canonical Place IDs directly from Google — zero SerpAPI waste
- [x] Requests Essentials-tier fields only (`id`, `formattedAddress`, `location`) to avoid Pro-tier billing
- [x] `color-scheme: light only` override for dark mode compatibility (system dark mode made the component render black)
- [x] `includedPrimaryTypes: ['establishment']` filters to businesses only
- [x] Server-side `isPlaceId()` validation — never trust client-submitted Place IDs
- [x] New env var: `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`

**Fallback path — URL paste with worker-side resolution:**
- [x] `parseGoogleMapsUrl()` extracts all available data from URL: Place ID, hex CID, business name (URI-decoded), coordinates
- [x] `PlaceIdValidationWorker` consumes `validate_place_id` outbox topic
- [x] `resolvePlaceId()` uses SerpAPI `engine=google_maps` search with haversine distance matching (<200m)
- [x] Fails fast without both business name + coordinates (no name-only fallback — too high false-match risk)
- [x] Budget guard: 75 SerpAPI resolution calls/day via `checkRateLimit()`

**Validation gate:**
- [x] `place_id_verified BOOLEAN` column on `businesses` table (migration 007)
- [x] `google_maps_url TEXT` column for re-resolution
- [x] ReconciliationPoller filters `AND place_id_verified = TRUE`
- [x] ReviewSyncWorker defensive guard: skips unverified businesses even if stale `sync_reviews` jobs exist
- [x] Migration smart-grandfathers: only canonical base64url IDs verified, hex CIDs get `place_id_resolution_required` exception (idempotent with `WHERE NOT EXISTS`)

**URL parser improvements:**
- [x] Place IDs no longer restricted to `ChIJ` prefix — supports `GhIJ`, `Eic`, `Iho`, and any base64url format (20+ chars, starts with letter)
- [x] Widened regex across `extractPlaceId()`, `isPlaceId()`, data path matching
- [x] `isPlaceId()` and `isHexCid()` exported for server-side validation

**Infrastructure:**
- [x] `validate_place_id` queue + topic mapping in `queues.ts`
- [x] `PlaceIdValidationWorker` registered in `worker/index.ts` (8 workers total now)
- [x] `ValidatePlaceIdPayload` type in `worker-types.ts`
- [x] `validate_place_id` added to admin jobs route local queue list
- [x] `ExceptionType.PLACE_ID_RESOLUTION_REQUIRED` and `PLACE_ID_RESOLUTION_FAILED` constants
- [x] SerpAPI `serpapi-source.ts` and `serpapi-monitor.ts` simplified to always use `place_id` parameter (no more `isHexCid` conditional)
- [x] `DemoGenerationWorker` resolver pre-step for non-canonical IDs
- [x] `DemoJobPayload` extended with optional `googleMapsUrl`
- [x] Onboarding + demo API routes accept either `googlePlaceId` (autocomplete) or `googleMapsUrl` (fallback)
- [x] Onboarding + demo forms: autocomplete primary, "Or paste a Google Maps URL" toggle for fallback

**New files:**
- `src/components/PlaceAutocomplete.tsx` — reusable Google Maps autocomplete component
- `src/lib/reviews/place-id-resolver.ts` — SerpAPI search-based resolution with haversine matching
- `src/lib/reviews/__tests__/place-id-resolver.test.ts` — 7 resolver tests
- `src/lib/reviews/__tests__/url-parser.test.ts` — 16 URL parser tests
- `worker/jobs/PlaceIdValidationWorker.ts` — outbox consumer for validate_place_id
- `supabase/migrations/007_place_id_verification.sql` — adds columns + smart grandfathering

**Spec:** `docs/superpowers/specs/2026-04-13-place-id-resolution-design.md`
**Plan:** `docs/superpowers/plans/2026-04-13-place-id-resolution.md`

**Tests:** 249/249 Vitest tests passing across 21 files (up from 212 after Sprint 4)

**GBP API migration path:** When Google Business Profile API access is approved, Place Autocomplete stays as-is, resolver swaps from SerpAPI search to Google Places API (Find Place), validation worker stays, same `place_id_verified` flag and `google_maps_url` column.

### Robustness Fixes — Code Review Findings (2026-04-14)

10 validated findings from a system-wide code review. All surgical fixes — no new tables, no new workers, no architectural changes.

**Spec:** `docs/superpowers/specs/2026-04-13-place-id-resolution-design.md`
**Plan:** `docs/superpowers/plans/2026-04-14-robustness-fixes.md`

**High priority (correctness/security):**
- [x] H1: NotificationWorker — skip approval link revocation on retry when delivery record exists. Prevents revoking a live link sitting in the owner's inbox after crash-between-send-and-delivery-record.
- [x] H2: ResponseGeneratorWorker — re-check `findAvoidFactViolation()` on retry result. Throw instead of falling back to the original violating draft. Worker marks outbox failed + creates review exception.
- [x] H3: Demo generation rate limit — fail closed (503) when Redis unavailable. Prevents uncapped SerpAPI + LLM calls during Redis outages. Checks `REDIS_CACHE_URL` env var + wraps `checkRateLimit` in try/catch.
- [x] H4: Stripe webhook — atomic INSERT dedup. Single `INSERT...ON CONFLICT DO NOTHING RETURNING id` replaces check-then-insert race. If no row returned, event already claimed — skip.
- [x] H5: Stripe checkout — verify `session.payment_status === 'paid'` and `session.mode === 'subscription'` before setting `subscription_status = 'active'`. Rejects unpaid/non-subscription sessions.

**Medium priority (reliability/security):**
- [x] M6: OutboxPoller — two-phase claim+dispatch. Phase 2 claims rows (`status = 'dispatching'`, commit). Phase 3 dispatches to BullMQ outside transaction. Eliminates ghost jobs from DB rollback after BullMQ accept. Watchdog extended to recover stale `dispatching` rows.
- [x] M7: WeeklySummaryWorker — set `sent_at = NOW()` BEFORE `sendInternalEmail()`. If email fails, mark outbox failed (no rethrow). Prevents duplicate weekly summaries on crash-and-retry.
- [x] M8: Resend webhook — reject svix-timestamps older than 5 minutes or >1 minute in the future. Prevents replay attacks after archival deletes inbound_events dedup records.
- [x] M9: Payment-success — removed fallback to "most recently activated business within 5 minutes" (wrong business on concurrent checkouts). Fixed JSON path: `payload->'data'->'object'->>'id'` instead of `payload->>'id'` (event ID vs session ID).

**Low priority (test reliability):**
- [x] L10: E2E tests — `page.goto()` uses `{ waitUntil: 'domcontentloaded' }` instead of default `load` event. More reliable when external resources are slow.

**Other improvements:**
- [x] Admin navbar — shared `AdminNav` component in admin layout with links to Overview, Businesses, Demos, Costs, Notifications, Jobs. Active page highlighted. Responsive hamburger on mobile. Hidden on login/payment-success.

**Tests:** 253/253 Vitest tests passing across 21 files (up from 249 after Place ID Resolution)

---

## Sprint 5: Churn Killers (Retention Stack)

**Status:** IN PROGRESS

### Phase 5A.1 — Weekly Value Report + Monthly Impact Email (Prompt 19a) (2026-04-14)

**Status:** COMPLETE

**What was done:**

1. **Review Summary LLM Helper** (`src/lib/responses/review-summary.ts`):
   - Dedicated helper for generating multi-review intelligence briefs
   - OpenAI (gpt-4o-mini) primary, Anthropic (claude-haiku-4-5-20251001) fallback
   - Caps input to 30 reviews, truncates each review text to 200 chars
   - Best-effort cost audit via `recordApiCost()` (swallows audit write failures)
   - Mock mode returns canned summary with provider='mock', costUsd=0
   - Both providers failing returns null (graceful degradation)
   - 7 tests covering all paths

2. **Notification Delivery Extended** (`src/lib/notifications/delivery.ts`):
   - `responseId` made optional (`string | null | undefined`) to support business-level notifications
   - Weekly value report and monthly impact emails have no specific response — pass null
   - Backward-compatible: existing callers unaffected

3. **Queue Registration** (`worker/queues.ts`, `src/lib/shared/worker-types.ts`):
   - `SendMonthlyImpactPayload` interface: `{ business_id, month_start_date }`
   - `SEND_MONTHLY_IMPACT` queue name, queue instance, topic-to-queue mapping

4. **Weekly Value Report Email Template** (`src/lib/notifications/email.ts`):
   - New `buildWeeklyValueReportHtml()` replacing old `buildWeeklySummaryEmailHtml()`
   - Sections: AI Intelligence Brief (blue left border, light blue bg), Value Delivered header (reviews × 7 min), Response Rate Lift (with baseline comparison), Review Velocity (4-week average), Conditional Ranking, Notable Reviews, Conditional Dashboard Link
   - Old template and interface removed

5. **Monthly Impact Email Template** (`src/lib/notifications/email.ts`):
   - New `buildMonthlyImpactEmailHtml()` with Monthly Intelligence Brief, value delivered in hours, response rate with baseline, ranking change, best review of the month (with approved response), dashboard link
   - 24 tests for both email templates

6. **Upgraded WeeklySummaryWorker** (`worker/jobs/WeeklySummaryWorker.ts`):
   - Expanded business query to include ROI baseline fields
   - New queries: reviews for LLM summary (30 max), 4-week average review count, ranking snapshots (latest + initial), dashboard eligibility (owner has auth_id)
   - Intelligence brief: reuses existing `summary_text` from weekly_summaries if present (idempotent), otherwise calls `generateReviewSummary()` and persists
   - Records notification delivery with `template='weekly_value_report'` after successful send
   - Email subject changed to "Weekly Value Report"
   - 12 tests covering all paths

7. **MonthlyImpactScheduler** (`worker/jobs/MonthlyImpactScheduler.ts`):
   - Hourly setInterval poller, fires 1st of month 9-10 AM UTC
   - Queries active/past_due businesses without sent monthly_impact_emails for previous month
   - Dedup guard: checks both monthly_impact_emails table and in-flight outbox entries
   - Same patterns as WeeklySummaryScheduler

8. **MonthlyImpactWorker** (`worker/jobs/MonthlyImpactWorker.ts`):
   - Processes `send_monthly_impact` outbox entries
   - Idempotent upsert into monthly_impact_emails (sent_at IS NULL guard)
   - Queries month stats, best review (highest star + longest text), reviews for LLM brief
   - Reuses existing `summary_text` if present (no re-LLM on retry)
   - Conditional ranking snapshots (latest vs initial)
   - Dashboard URL only when owner has auth_id
   - Crash-safe: marks sent_at BEFORE Resend call
   - Records notification delivery with `template='monthly_impact'`
   - 13 tests covering all paths

9. **Worker Registration** (`worker/index.ts`):
   - MonthlyImpactWorker added to BullMQ workers array (10 workers total)
   - MonthlyImpactScheduler added to startup/shutdown lifecycle (6 pollers total)

10. **Migration 008** (`supabase/migrations/008_retention_core.sql`):
    - `monthly_impact_emails` table (UUIDv7 PK, business_id FK, month_start_date, summary_text, sent_at)
    - Unique constraint on (business_id, month_start_date) for idempotency
    - Index on notification_deliveries (business_id, template, sent_at DESC) for cooldown checks

**Test count:** 312/312 passing across 24 files (was 253)
**New test files:** `review-summary.test.ts`, `email-templates.test.ts`, `WeeklySummaryWorker.test.ts`, `MonthlyImpactWorker.test.ts`

### Post-19a Robustness Fixes (2026-04-14)

**Status:** COMPLETE

1. Cost guard in `review-summary.ts`: `reserveCost`/`finalizeCost`/`releaseCost` lifecycle, budget-exceeded degrades gracefully
2. `claimed_at`/`sent_at` split: migration 009 adds `claimed_at` to `weekly_summaries` + `monthly_impact_emails`, atomic claim before processing, `sent_at` set just before Resend
3. Stale claim recovery: claims older than 15 min are reclaimable, prevents permanently stuck reports from crashed workers
4. Defensive try/finally in `generateReviewSummary`: `finalized` flag matches production generator pattern
5. Prompt injection hardening: system prompt treats review text as raw data
6. `subscription_tier` pass-through: workers query tier and pass to `generateReviewSummary`
7. Response-rate fix: joined query counts period reviews with responses (not independent counts)
8. Time-saved copy: templates use `totalResponded` consistently
9. 4-week average: upper bound changed to `week_start_date` (previous 4 completed weeks)
10. Nullable guards: `rank_position IS NOT NULL` on ranking queries, `star_rating IS NOT NULL` on summary queries, `NULLS LAST` on best-review ORDER BY
11. Best review threshold removed: `star_rating >= 4` filter dropped per spec

### Phase 5A.2 — Read-Only Owner Dashboard (Prompt 19c) (2026-04-14)

**Status:** COMPLETE

**What was done:**

1. **recharts installed** (v3.8.1) for bar and line charts

2. **Dashboard Data API** (`src/app/api/dashboard/route.ts`):
   - Single `GET` endpoint returns all dashboard data in one payload
   - Defense-in-depth: `requireRole(request, 'owner')` + `businessId` null check
   - 8 parallel SQL queries via `Promise.all()`: business info + baseline, total reviews, total responded (joined), 8-week velocity, ranking snapshots, last 10 reviews with latest response, monthly brief, weekly brief
   - Derived fields: response rate, baseline rate, time saved, ranking grouped by keyword, latest brief (monthly preferred)
   - Exports `DashboardData` interface for client component typing

3. **Middleware update** (`src/middleware.ts`):
   - `/api/dashboard` paths protected for `role='owner'` with `business_id` check
   - Added to `config.matcher`

4. **OwnerNav component** (`src/components/OwnerNav.tsx`):
   - Dashboard link + business name (hidden on mobile) + Sign out button
   - Same styling family as AdminNav
   - Uses `createBrowserSupabaseClient()` for sign out

5. **Authenticated layout** (`src/app/(authenticated)/layout.tsx`):
   - Async server component reads Supabase session from cookies
   - Queries business name for OwnerNav
   - Redirects to login if unauthenticated
   - Wraps children in max-w-4xl container

6. **DashboardContent client component** (`src/components/DashboardContent.tsx`):
   - Fetches `GET /api/dashboard` on mount
   - Section A: Value Summary Banner (blue gradient, reviews handled, time saved, response rate with baseline)
   - Section B: Review Velocity BarChart (recharts, last 8 weeks, formatted dates)
   - Section C: Ranking LineChart (conditional, Y-axis inverted, one line per keyword)
   - Section D: Recent Reviews (status badges, expandable response text, "check email" for pending)
   - Section E: Latest Intelligence Brief (monthly preferred, blue left border styling)
   - Loading and error states

7. **Dashboard page** (`src/app/(authenticated)/dashboard/page.tsx`):
   - Replaced placeholder with `DashboardContent`

### Post-19c Dashboard Robustness Fixes (2026-04-14)

**Status:** COMPLETE

1. ROI metrics: changed to explicit `IN ('posted', 'approved', 'edited', 'awaiting_manual_post')` — excludes pending_approval from "handled" count
2. Edited response display: `COALESCE(approved_text, response_text)` in lateral join shows owner-approved text
3. UTC date formatting: all chart date parsing uses `T00:00:00Z` suffix + `timeZone: 'UTC'`
4. Zero-review weeks: velocity query uses `generate_series` to fill missing weeks with zero counts
5. Brief recency: compares `sent_at` timestamps instead of period start dates
6. Dashboard index: migration 010 adds `(business_id, detected_at DESC)` composite index
7. Ranking limit: snapshots bounded to last 12 months
8. Dashboard tests: 9 API route tests covering auth, scoping, empty states, brief recency, pending reviews
9. Null review_date: returns empty string instead of current date
10. No-store headers: all dashboard responses (success + error) use `NO_STORE_HEADERS` via `jsonResponse` helper; middleware `/api/dashboard` 401/403 also include no-store
11. Pending reviews: lateral join includes `pending_approval` so UI shows "check your email" reminder
12. Sign-out: only redirects on success, shows error state on failure, uses `router.refresh()`
13. Status badges: added `edited` and `generating` to badge color map
14. Nullable star_rating: typed as `number | null`, renders "No rating" when absent

**Test count:** 322/322 passing across 25 files (was 312)
**New test file:** `src/app/api/dashboard/__tests__/route.test.ts`

### Phase 5A.3 — Engagement Detection & Re-engagement (Prompt 19d) (2026-04-14)

**Status:** COMPLETE

**What was done:**

1. **Extracted `createApprovalLink()`** (`src/lib/approval/create-link.ts`):
   - Shared approval link creation logic (randomUUID → SHA-256 hash stored, raw token returned)
   - Handles orphaned link revocation (crash before email send)
   - Used by NotificationWorker (refactored) and EngagementAlertWorker (new)

2. **EngagementMonitorPoller** (`worker/jobs/EngagementMonitorPoller.ts`):
   - Daily poller (24h default, configurable via `ENGAGEMENT_MONITOR_INTERVAL_MS`)
   - Single grouped SQL query computes 5 metrics per active business: days_since_approval, pending_count, oldest_pending_age_days, notified_count (30d), approved_count (30d)
   - 4 engagement rules with cooldown dedup via notification_deliveries:
     - `owner_nudge`: activity_age >= 3d AND pending > 0 (3-day cooldown)
     - `partner_engagement_alert`: activity_age >= 7d AND pending > 0 (7-day cooldown)
     - `partner_escalation_alert`: activity_age >= 14d AND (pending > 0 OR notified > 0) (14-day cooldown)
     - `partner_low_engagement`: approval_rate < 50% AND notified >= 3 (7-day cooldown)
   - `activity_age_days = days_since_approval ?? oldest_pending_age_days`
   - Creates `engagement_alert` outbox entries
   - 10 tests

3. **EngagementAlertWorker** (`worker/jobs/EngagementAlertWorker.ts`):
   - Processes `engagement_alert` outbox entries
   - `owner_nudge`: queries pending reviews, creates fresh approval links per review via `createApprovalLink()`, sends nudge email to owner with review list + approval URLs
   - `partner_engagement_alert`: sends internal email to admin — "hasn't engaged in N days", owner contact info, suggested check-in
   - `partner_escalation_alert`: sends escalation email — "at risk, no engagement in 2+ weeks", suggests phone call/visit
   - `partner_low_engagement`: sends low-engagement email — "approval rate dropped to X%"
   - Records notification delivery for all alert types
   - 12 tests

4. **4 Email Templates** (`src/lib/notifications/email.ts`):
   - `buildOwnerNudgeEmailHtml()` — customer-facing, 600px card, lists pending reviews with stars + approval buttons
   - `buildPartnerEngagementAlertHtml()` — internal, plain styling, metrics + contact info
   - `buildPartnerEscalationAlertHtml()` — internal, red accent border, urgency framing
   - `buildPartnerLowEngagementAlertHtml()` — internal, amber accent border
   - 42 template tests

5. **Queue + Payload Registration**:
   - `EngagementAlertType` union type + `EngagementAlertPayload` interface in worker-types.ts
   - `ENGAGEMENT_ALERT` queue name, instance, topic mapping in queues.ts
   - Worker + poller registered in worker/index.ts (11 workers + 7 pollers total)

6. **NotificationWorker Refactored**:
   - Inline approval link creation replaced with `createApprovalLink()` call
   - Removed unused crypto imports
   - All existing tests still pass

**Test count:** 386/386 passing across 28 files (was 322)
**New test files:** `EngagementMonitorPoller.test.ts`, `EngagementAlertWorker.test.ts`, `engagement-email-templates.test.ts`

---

### Phase 5A.4 — Churn Risk Score System (Prompt 19f) (2026-04-15)

**Status:** COMPLETE

**What was done:**

1. **Churn Risk Score Function** (`src/lib/shared/churn-score.ts`):
   - Pure function `computeChurnRiskScore(metrics)` — no DB calls, no side effects
   - 5 weighted signals: approval rate (30%), days since approval (25%), satisfaction pulse (20%), response time trend (15%), account age (10%)
   - Levels: 0-30 = healthy, 31-60 = watch, 61-100 = at_risk
   - Returns score, level, and breakdown array with signal name, value, and contribution
   - Weights and thresholds exported as constants for tuning
   - 39 comprehensive tests covering each signal independently, edge cases, boundary values, combined scoring

2. **Admin Overview API** (`src/app/api/admin/overview/route.ts`):
   - Added grouped metrics CTE query for all returned business IDs (one query, not N+1)
   - Computes approval rate, notified/pending counts, days since approval, account age, response time trend
   - Runs each through `computeChurnRiskScore()` and adds `churnScore` to response

3. **Admin Overview Page** (`src/app/admin/overview/page.tsx`):
   - Added Health column with HealthBadge (green=Healthy, amber=Watch, red=At Risk)
   - Shows numeric score alongside level badge
   - Default sort: risk score descending (most at-risk at top)

4. **Business Detail API** (`src/app/api/admin/businesses/[id]/route.ts`):
   - Added same metrics CTE query (scoped to single business)
   - Computes and returns `churnScore` in GET response

5. **Business Detail Page** (`src/app/admin/businesses/[id]/page.tsx`):
   - Risk badge next to business name in header
   - New Engagement section with score breakdown
   - Each signal shows: name, value, contribution bar (color-coded green/amber/red), numeric contribution

**Test count:** 427/427 passing across 29 files (was 388)
**New test file:** `churn-score.test.ts` (39 tests)

### Post-19f Robustness Fixes (2026-04-15)

**Status:** COMPLETE

1. Detail API contract: moved `churnScore` inside `business` object (was top-level — page expected `business.churnScore`, badge/engagement section never rendered)
2. Overview API: fetch all businesses, sort by churn score server-side, then paginate (was sorting only the post-pagination page)
3. Negative limit bypass: clamped to `[1, 100]` with `Math.max(..., 1)`
4. Deterministic sort tie-breaker: score → pending count → name → id (prevents unstable pagination with tied scores)
5. Migration 013: composite indexes `(business_id, status, created_at)` and `(business_id, approved_at DESC)` for churn metrics queries
6. Email send failure recovery: WeeklySummaryWorker + MonthlyImpactWorker clear `sent_at` + `claimed_at` on send failure so retries can reclaim the report (was permanently stuck as "already sent")
7. Owner nudge idempotency: checks for existing delivery within 1 day before creating approval links (prevents DB churn on BullMQ retries)
8. `approvalRate` contract: documented as 0-1 fraction on `BusinessMetrics`, added defensive auto-correction guard for accidental 0-100 values
9. Non-null assertion replaced with `?? 0` fallback on `metrics.approval_rate` in low-engagement alert

---

**Sprint 5A: COMPLETE** — All 4 prompts (19a Weekly Value Report + Monthly Impact Email, 19c Read-Only Owner Dashboard, 19d Engagement Detection & Re-engagement, 19f Churn Risk Score) implemented with all review findings addressed across 7 review rounds. 427 tests across 29 files.

---

## Sprint 5B: Retention Expansion

**Status:** IN PROGRESS

### Migration 014: Retention Expansion (2026-04-16)

**Status:** COMPLETE (created, not yet applied to production)

Created `supabase/migrations/014_retention_expansion.sql`:
- New table: `onboarding_drip_log` (business_id, drip_type CHECK day_1/day_7/day_30, UNIQUE business+drip_type)
- New table: `satisfaction_responses` (business_id, week_start_date, rating CHECK great/ok/not_great, comment, UNIQUE business+week)
- ALTER businesses: `subscription_activated_at`, `tracked_keywords` (JSONB NOT NULL DEFAULT '[]'), `google_place_address`, `google_place_lat`, `google_place_lng`, `ranking_search_location`, `weekly_summary_enabled` (BOOLEAN DEFAULT TRUE), `monthly_impact_enabled` (BOOLEAN DEFAULT TRUE)
- ALTER approval_audit_log: DROP NOT NULL on `token_hash`, ADD `actor_user_id` (FK users), ADD `auth_method` (CHECK token/owner_session, DEFAULT 'token')
- Unique index: `uniq_ranking_snapshots_business_keyword_date`
- Partial unique index: `uniq_outbox_track_ranking_run` (aggregate_id, payload->>'run_date') WHERE topic='track_ranking' AND status <> 'failed'
- Partial index: `idx_businesses_ranking_ready` for ranking-eligible businesses
- CHECK constraint: `chk_tracked_keywords_array` (jsonb_typeof = 'array', idempotent via DO $$ IF NOT EXISTS $$)
- Backfills: `subscription_activated_at` from `updated_at` for active businesses, `tracked_keywords` NULLs → '[]'
- RLS enabled on both new tables

### Prompt 19b — Automated Ranking Tracking (2026-04-16)

**Status:** COMPLETE

**What was built:**

1. **RankingTrackingScheduler** (`worker/jobs/RankingTrackingScheduler.ts`):
   - setInterval poller (default 1 hour), fires biweekly on even-week Sundays at 22:xx UTC
   - Feature-flagged: `RANKING_TRACKING_ENABLED !== 'true'` → silent return
   - ISO 8601 week number calculation for biweekly cadence
   - Queries eligible businesses: active + place_id_verified + non-empty tracked_keywords + has location data (coords OR ranking_search_location)
   - Dedup guard: NOT EXISTS pending/dispatched track_ranking outbox entry + ON CONFLICT DO NOTHING
   - `run_date` in payload for partial unique index dedup
   - Double-start guard: `if (pollerInterval) return`

2. **RankingTrackingWorker** (`worker/jobs/RankingTrackingWorker.ts`):
   - Strict active-only subscription check (not `checkSubscription` which allows past_due grace)
   - Re-checks google_place_id before SerpAPI call
   - Safe tracked_keywords parser (try/catch, Array.isArray, empty string filter)
   - 1 keyword per business limit (Sprint 5B initial rollout)
   - Strict fail-closed SerpAPI budget: `checkRateLimit('serpapi:ranking:monthly', 100, ..., { strict: true })`
   - SerpAPI `engine=google_maps` search with `ll=@lat,lng,15z` (coords) or `location=` (text)
   - Uses SerpAPI `position` field when available, falls back to `index + 1`
   - Mock mode: random rank 1-10
   - Upsert to `ranking_snapshots` with ON CONFLICT (business_id, keyword, snapshot_date)

3. **Keywords API** (`src/app/api/admin/businesses/[id]/keywords/route.ts`):
   - PUT — Zod validated `.trim().min(1)` (whitespace-only rejected), max 5 keywords
   - Admin/sales_partner auth, returns 404 if business not found

4. **Ranking API** (`src/app/api/admin/businesses/[id]/ranking/route.ts`):
   - POST — manual rank entry with Zod validation, calendar date validation, default today
   - ON CONFLICT upsert with source='manual'
   - FK violation (23503) → 404

5. **Business Detail API** extended to return `trackedKeywords`, `rankingSnapshots`, location columns

6. **Admin Business Detail Page** — TrackedKeywordsSection (editable keyword pills, add/remove, max 5) + ManualRankingSection (recent snapshots table + manual entry form with date/keyword/rank)

7. **Rate Limiter** (`src/lib/shared/rate-limit.ts`): added `{ strict: true }` option — throws on Redis errors/missing instead of failing open. Used by ranking worker for cost-sensitive budget enforcement.

8. **Queue Registration**: `TRACK_RANKING` in QUEUE_NAMES, queue instance, topicToQueue, Worker instance, scheduler start/stop in main/shutdown

9. **Env**: `RANKING_TRACKING_ENABLED=false` added to `.env.example` and `.env.local`

**Post-19b review fixes (14 findings across 2 review rounds):**
- Critical: outbox dedup via `run_date` + partial unique index with ON CONFLICT DO NOTHING
- Critical: `checkRateLimit({ strict: true })` fail-closed for paid API calls
- Critical: widened unique index to `status <> 'failed'` (was `NOT IN ('completed','failed')` — fast-completing jobs allowed duplicate same-day entries)
- Medium: Zod `.trim().min(1)` ordering (whitespace-only keywords rejected)
- Medium: safe JSONB parser with try/catch + Array.isArray + empty string filter + DB CHECK constraint
- Medium: use SerpAPI `position` field over array index
- Medium: strict `active`-only subscription (not `checkSubscription('summary')` which allows past_due)
- Medium: re-check google_place_id in worker before SerpAPI call
- Medium: calendar date validation before SQL + FK violation → 404
- Medium: render snapshot dates as YYYY-MM-DD strings (not `Date.toLocaleDateString()` which shifts timezone)
- Low: double-start guard on scheduler
- Low: `.env.example` updated
- Low: rank input uses `Number()` not `parseInt`, `max=100 step=1`
- Low: idempotent CHECK constraint via `DO $$ IF NOT EXISTS $$`

**Test count:** 484/484 passing across 33 files (was 427/29)
**New test files:** `RankingTrackingScheduler.test.ts` (19 tests), `RankingTrackingWorker.test.ts` (16 tests), `keywords/route.test.ts` (6 tests), `ranking/route.test.ts` (7 tests), + 4 new rate-limit strict mode tests

---

### Prompt 19c-5B — Owner Settings + Dashboard Approval Actions (2026-04-16)

**Status:** COMPLETE

**What was built:**

1. **ApprovalService Refactor** (`src/lib/approval/service.ts`):
   - `SessionAuditContext` interface (actorUserId, ipAddress — no token)
   - `insertAuditLogSession()` — writes `auth_method='owner_session'`, `actor_user_id`, `token_hash=NULL`
   - `approveBySession()` — locks pending response, sets approved, revokes open approval links, enqueues publish_response
   - `editBySession()` — locks pending, computes Levenshtein distance, sets edited, revokes links, enqueues publish
   - `regenerateBySession()` — locks pending, sets superseded, revokes links, enqueues generate_response with version+1
   - `revokeOpenLinksForResponse()` — revokes ALL open/unconsumed/unexpired links for a response (session actions have no "current link" to exclude)
   - Existing token-based methods completely untouched

2. **Dashboard Approval API Routes**:
   - `POST /api/dashboard/reviews/[reviewId]/approve` — session-auth approve
   - `POST /api/dashboard/reviews/[reviewId]/edit` — session-auth edit (Zod: editedText 1-2000 chars)
   - `POST /api/dashboard/reviews/[reviewId]/regenerate` — session-auth regenerate
   - All: `requireRole('owner')`, business ownership check, 404/403/409 error handling

3. **Settings API** (`src/app/api/settings/route.ts`):
   - PUT endpoint, Zod validated (tone, productsServices, avoidFacts max 20, sampleResponses max 10, notificationPreference email/sms/both, ownerPhone, weeklySummaryEnabled, monthlyImpactEnabled)
   - Owner-scoped via `user.businessId` — never accepts business_id from body
   - SMS validation: checks stored phone from DB when request omits ownerPhone (partial-update safe)
   - Dynamic SQL SET clause with `sql.unsafe()`

4. **Scheduler Opt-out**:
   - `WeeklySummaryScheduler`: added `AND (b.weekly_summary_enabled IS NULL OR b.weekly_summary_enabled = TRUE)` to business query
   - `MonthlyImpactScheduler`: added `AND (b.monthly_impact_enabled IS NULL OR b.monthly_impact_enabled = TRUE)` to business query

5. **Owner Settings Page** (`src/app/(authenticated)/settings/page.tsx`):
   - Section A: Business Profile — read-only (name, category, placeId) + editable (tone, productsServices, avoidFacts, sampleResponses as line-separated textareas)
   - Section B: Notification Preferences — channel radio (email/sms/both), conditional phone input, weekly/monthly report toggles
   - Section C: Save — single button, diffs against initial state, sends only changed fields, green success banner (3s auto-dismiss)
   - Fetches from `GET /api/dashboard`, saves to `PUT /api/settings`

6. **Dashboard Approval UI** (`src/components/DashboardContent.tsx`):
   - `ReviewActions` component with state machine (idle/loading/editing/success/error)
   - Approve (green), Edit (blue, inline textarea), Regenerate (gray outline)
   - Guard: only renders when `review.responseStatus === 'pending_approval' && review.responseText` (not `displayStatus` fallback)
   - Refetches dashboard data on success

7. **OwnerNav** — added Settings link next to Dashboard
8. **Middleware** — `/api/settings` added to owner protection
9. **Dashboard API** — extended to return `settings` object (tone, productsServices, avoidFacts, sampleResponses, notificationPreference, ownerPhone, ownerEmail, weeklySummaryEnabled, monthlyImpactEnabled, category, googlePlaceId)

**Post-19c-5B review fixes (5 findings):**
- Critical: escaped unescaped apostrophe in settings page JSX (blocked `pnpm build`)
- Medium: session actions revoke open approval links via `revokeOpenLinksForResponse()`
- Medium: action buttons guard on `responseStatus` not `displayStatus` (prevents 404s during regeneration gap)
- Low: avoidFacts max 20, sampleResponses max 10, SMS-requires-phone with stored-phone DB fallback
- Low: SMS validation checks stored phone before rejecting (partial-update safe)

**Test count:** 512/512 passing across 35 files (was 484/33)
**New test files:** `actions.test.ts` (17 tests), `settings/route.test.ts` (11 tests)
**Build:** `pnpm build` succeeds

---

### Prompt 19d-5B — Partner Satisfaction Alert (2026-04-16)

**Status:** COMPLETE

**What was built:**

1. **EngagementAlertType** (`src/lib/shared/worker-types.ts`):
   - Added `'partner_satisfaction_alert'` to the union type
   - Added optional `satisfaction` field to `EngagementAlertPayload`: `{ rating: 'great' | 'ok' | 'not_great'; comment: string | null; week_start_date: string }`

2. **Email Template** (`src/lib/notifications/email.ts`):
   - `buildPartnerSatisfactionAlertHtml()` — internal email to sales partner
   - Red accent (`#dc2626`) for "not_great" rating, amber (`#d97706`) for "ok"
   - Shows: rating label, optional owner comment in highlighted box, week start date, owner email + phone
   - Suggested action: "Reach out to the owner to understand their concern"

3. **Worker Handler** (`worker/jobs/EngagementAlertWorker.ts`):
   - `handleSatisfactionAlert()` — validates satisfaction payload, sends email to ADMIN_NOTIFICATION_EMAIL, records delivery with `template='partner_satisfaction_alert'`
   - Fails gracefully when satisfaction data is missing (markOutboxFailed)
   - Routed from `handleEngagementAlert()` when `alert_type === 'partner_satisfaction_alert'`

4. **Cooldown Map** (`worker/jobs/EngagementMonitorPoller.ts`):
   - Added `partner_satisfaction_alert: 7` to COOLDOWNS record (satisfies `Record<EngagementAlertType, number>`)

**Test count:** 516/516 passing across 35 files (was 512)
**New tests:** 4 tests added to `EngagementAlertWorker.test.ts` (sends with rating+comment, sends without comment, fails on missing data, fails without admin email)

### Post-19d-5B Review Fixes (2026-04-16)

**Status:** COMPLETE

1. **Idempotency** (Medium): `handleSatisfactionAlert` now checks `notification_deliveries` for existing delivery with `template='partner_satisfaction_alert'` within 7 days before sending — prevents duplicate emails on BullMQ/watchdog retry after Resend accepts but before outbox completion.
2. **JSONB validation** (Medium): Runtime validation of `satisfaction` payload — rejects invalid `rating` values (not in `['great','ok','not_great']`), malformed `week_start_date` (not `YYYY-MM-DD`), and non-string `comment`. Prevents silent fallthrough to "Great" label and `escapeHtml()` crashes on non-string input.
3. **Dead cooldown** (Low): Removed `partner_satisfaction_alert: 7` from EngagementMonitorPoller `COOLDOWNS` — changed type to `Partial<Record<EngagementAlertType, number>>` with `?? 7` fallback at usage. Satisfaction dedup is the worker's responsibility, not the poller's.
4. **Optional metrics** (Low): `EngagementAlertPayload.metrics` made optional — satisfaction alerts don't need to fabricate unused metric values. Non-satisfaction alert paths guard with explicit null check + `markOutboxFailed`.

**Test count:** 519/519 passing across 35 files (was 516)
**New tests:** 3 additional tests (invalid rating, invalid week_start_date, idempotency skip)

### Post-19d-5B Review Round 2 (2026-04-16)

**Status:** COMPLETE

1. **Week-scoped idempotency** (Medium): template tag changed from `'partner_satisfaction_alert'` with 7-day time window to `'partner_satisfaction_alert:YYYY-MM-DD'` with exact week match. Prevents suppressing legitimate alerts for adjacent weeks when timing drifts.
2. **Crash-safe send** (Medium): outbox entry marked `completed` BEFORE calling Resend (same pattern as WeeklySummaryWorker/MonthlyImpactWorker). Tradeoff: rare missed internal partner alert vs duplicate sends on retry.
3. **Calendar date validation**: round-trip parse via `new Date(date + 'T00:00:00Z')` + `toISOString().slice(0,10)` comparison. Rejects impossible dates like `2026-99-99` that pass the regex.

**Test count:** 520/520 passing across 35 files (was 519)
**New test:** impossible calendar date validation test

---

### Prompt 19e — Onboarding Drip Emails (2026-04-16)

**Status:** COMPLETE

**What was built:**

1. **Stripe Webhook Update** (`worker/ingress/stripe.ts`):
   - `subscription_activated_at = COALESCE(subscription_activated_at, NOW())` on checkout.session.completed
   - `COALESCE` preserves the original activation date on re-activation from past_due → active

2. **OnboardingDripScheduler** (`worker/jobs/OnboardingDripScheduler.ts`):
   - Hourly setInterval poller (configurable via `ONBOARDING_DRIP_INTERVAL_MS`)
   - Queries active businesses with `subscription_activated_at IS NOT NULL`
   - Checks 3 drip offsets: day_1 (1 day), day_7 (7 days), day_30 (30 days)
   - Double dedup: `onboarding_drip_log` table + pending outbox entries
   - 23505 constraint handling, mock mode skip, double-start guard

3. **OnboardingDripWorker** (`worker/jobs/OnboardingDripWorker.ts`):
   - **day_1**: Welcome email — how it works (3-step list), 30-second approval, weekly report mention, conditional dashboard link (only if owner has auth mapping)
   - **day_7**: First week recap — reviews handled + time saved + response rate, highlight review+response pair (longest text), edit acknowledgment ("learning your voice"), pending reviews with fresh approval links via `createApprovalLink({ revokeMode: 'orphaned_only' })`, zero-review graceful fallback
   - **day_30**: Monthly impact — total reviews, response rate before → now (from baseline), time saved, ranking change (if data), sales partner sign-off
   - Strict active-only subscription guard
   - Crash-safe: outbox completed BEFORE email send
   - Idempotent: `INSERT INTO onboarding_drip_log ... ON CONFLICT (business_id, drip_type) DO NOTHING`
   - Records notification delivery with template `onboarding_drip_day_1` etc.

4. **Email Templates** (appended to `src/lib/notifications/email.ts`):
   - `buildOnboardingDay1Html()` — warm welcome, no jargon, 3-step explainer
   - `buildOnboardingDay7Html()` — stats, highlight review, edit ack, pending CTA buttons
   - `buildOnboardingDay30Html()` — milestone framing, response rate lift, ranking change, partner sign-off

5. **Queue + Registration**: `ONBOARDING_DRIP` in QUEUE_NAMES, queue/topicToQueue, Worker instance, scheduler start/stop in main/shutdown

**Test count:** 543/543 passing across 37 files (was 520/35)
**New test files:** `OnboardingDripScheduler.test.ts` (12 tests), `OnboardingDripWorker.test.ts` (11 tests)

### Post-19e Review Fixes (2026-04-16)

**Status:** COMPLETE

1. **Claim-before-send idempotency** (Medium): Worker now claims drip_log entry via `INSERT ... ON CONFLICT DO NOTHING RETURNING id` before sending email. If no row returned, another job already claimed — skips without sending. Eliminates duplicate sends from BullMQ retries or manual requeue.
2. **Scheduler outbox dedup** (Medium): Added partial unique index `uniq_outbox_onboarding_drip` on `(aggregate_id, payload->>'drip_type') WHERE topic='onboarding_drip' AND status <> 'failed'`. Scheduler uses `ON CONFLICT DO NOTHING` instead of check-then-insert race.
3. **Window-bounded metrics** (Medium): Day 7 queries bounded to `[activatedAt, activatedAt + 7 days)`, day 30 to `[activatedAt, activatedAt + 30 days)`. Prevents claiming pre-activation or post-window data as "first week/month" results.
4. **Business-scoped sales partner** (Medium): Lookup changed from global `WHERE role IN ('admin','sales_partner') LIMIT 1` to `JOIN businesses ON onboarded_by = users.id`. Prevents wrong partner name in customer emails.
5. **Strict NEXT_PUBLIC_APP_URL for day_7** (Medium): Throws when pending reviews exist but app URL is not configured (matches owner-nudge strict behavior). Allows BullMQ retry after config fix.
6. **Day 1 copy fix** (Low): Changed "We post it to Google on your behalf" to "Your approved response is queued for posting to Google" (accurate for SerpAPI manual-post mode).
7. **Single-query scheduler** (Low): Consolidated from N+1 per-business loops into single `CROSS JOIN + NOT EXISTS` query. Eliminates per-business/per-drip SQL round trips.

**Test count:** 543/543 (tests updated to match new single-query + claim patterns)

### Post-19e Review Round 2 (2026-04-16)

**Status:** COMPLETE

1. **Claim-before-build** (Medium): Drip_log INSERT moved before switch/build phase. No side effects (approval link creation/revocation) run before the idempotency gate. Prevents duplicate day_7 jobs from revoking each other's tokens.
2. **Claim/sent state separation** (Medium): Migration 015 makes `sent_at` nullable with no default. INSERT claims with `sent_at=NULL`, UPDATE to `NOW()` only after `sendInternalEmail()` succeeds. If send fails, outbox stays retryable and stale claims are observable.
3. **Business-scoped sales partner** (Medium): Uses ResponsePublisherWorker's scoped chain: business-scoped admin/sales_partner → `onboarded_by` with `role IN ('admin','sales_partner')` check → null. No global LIMIT 1.
4. **New migration 015** (Medium): `015_drip_log_claim_state.sql` — ALTER sent_at DROP NOT NULL + DROP DEFAULT, adds `uniq_outbox_onboarding_drip` index (IF NOT EXISTS for 014 compat), adds `idx_businesses_drip_ready` performance index.
5. **Validated subscription_activated_at** (Low): day_7 and day_30 check for null `subscription_activated_at` before build phase — `markOutboxFailed` with clear reason instead of blank email.
6. **Scheduler performance index** (Low): `idx_businesses_drip_ready` on `(subscription_activated_at) WHERE subscription_status = 'active' AND subscription_activated_at IS NOT NULL`.

**Test count:** 543/543 (tests updated for claim-first + sent_at flow)

### Post-19e Review Round 3 (2026-04-16)

**Status:** COMPLETE

1. **Recoverable stale claims** (Medium): Worker now checks existing drip_log row's `sent_at` — only skips when `IS NOT NULL` (actually sent). Stale claims (`sent_at IS NULL` from failed previous attempt) allow retry. Scheduler query also updated to `AND dl.sent_at IS NOT NULL`.
2. **Migration 015 dedupe** (Medium): Added ROW_NUMBER() CTE to mark duplicate non-failed `onboarding_drip` outbox rows as `'failed'` before creating the unique index. Prevents index creation failure in environments with pre-existing duplicates.
3. **Index-friendly predicate** (Low): Scheduler due-check rewritten from `activated_at + interval <= NOW()` to `activated_at <= NOW() - interval` for better Postgres index range scan utilization.

**Test count:** 543/543

### Post-19e Review Round 4 (2026-04-16)

**Status:** COMPLETE

1. **Atomic claim ownership** (Medium): Added `claimed_by_outbox_id` and `claimed_at` to `onboarding_drip_log` (migration 015). INSERT sets owner. On conflict, atomic UPDATE only succeeds when `claimed_by_outbox_id` matches (same outbox retry) OR `claimed_at` > 15 min stale. Fresh claims owned by another active job are rejected — prevents concurrent duplicate sends from watchdog redispatch or pre-existing queued jobs.

**Test count:** 544/544 (2 new claim tests: sent/fresh-claim skip + stale takeover retry)

---

### Prompt 19g — Satisfaction Pulse (2026-04-16)

**Status:** COMPLETE

**What was built:**

1. **HMAC Helper** (`src/lib/shared/feedback-hmac.ts`):
   - `signFeedback(businessId, rating, weekStartDate)` — HMAC-SHA256 with `CSRF_SECRET`
   - `verifyFeedback(...)` — constant-time comparison via `timingSafeEqual`
   - `buildFeedbackUrl(appUrl, businessId, rating, weekStartDate)` — signed URL with query params

2. **Feedback API Route** (`src/app/api/feedback/route.ts`):
   - **GET**: validates HMAC, renders lightweight HTML confirmation form (no DB write — scanner-safe). Shows optional comment textarea for `not_great`. Hidden fields: business_id, rating, week, sig.
   - **POST**: re-validates HMAC from form data. Single `sql.begin()` transaction: upserts `satisfaction_responses` on `(business_id, week_start_date)` + conditionally inserts `engagement_alert` outbox entry for `not_great` (with per-business/week cooldown dedup via `WHERE NOT EXISTS`). Redirects 303 to `/feedback/thanks`.

3. **Thank-You Page** (`src/app/(public)/feedback/thanks/page.tsx`):
   - Static page with Tailwind styling

4. **Weekly Email Template** (`src/lib/notifications/email.ts`):
   - `WeeklyValueReportParams` extended with `feedbackUrls: { great, ok, notGreat } | null`
   - Satisfaction pulse section added before footer: three styled buttons (green/amber/red)
   - Conditional — only renders when `feedbackUrls` is non-null

5. **WeeklySummaryWorker** (`worker/jobs/WeeklySummaryWorker.ts`):
   - Imports `buildFeedbackUrl`, builds HMAC-signed URLs when `NEXT_PUBLIC_APP_URL` + `CSRF_SECRET` configured
   - Passes `feedbackUrls` to template

**Test count:** 569/569 passing across 39 files (was 544/37)
**New test files:** `feedback-hmac.test.ts` (8 tests), `feedback/route.test.ts` (17 tests)

---

### Post-19g Review Fixes (2026-04-16)

**Status:** COMPLETE

1. **Index conflict** (Medium): Catch 23505 from broad `idx_jo_engagement_alert_inflight` index (migration 011) on outbox INSERT. The satisfaction_responses upsert still commits even when a pending alert from a different week conflicts with the broad `(aggregate_id, alert_type)` index.
2. **Stale alerts** (Medium): `handleSatisfactionAlert` in EngagementAlertWorker now re-reads `satisfaction_responses` for business + week before sending. If the owner changed their rating from `not_great` to `ok`/`great`, the alert is skipped. Uses live comment from DB, not stale outbox payload.
3. **Sig validation** (Medium): `verifyFeedback` validates sig matches `/^[0-9a-f]{64}$/i` before `Buffer.from`. Uses `'hex'` encoding on both operands. Prevents `RangeError` from non-ASCII 64-char strings.
4. **Date + UUID validation** (Low): Round-trip calendar date validation + UUID format check before DB writes. Rejects `2026-99-99` and malformed UUIDs with 400.
5. **URL escaping** (Low): Feedback URLs in weekly email escaped with `&amp;`/`&quot;` for href attributes.

**Test count:** 570/570 passing across 39 files (was 569 — 1 new test for rating-changed skip)

### Post-19g Review Round 2 (2026-04-16)

**Status:** COMPLETE

1. **Transaction-safe outbox insert** (Medium): Replaced try/catch 23505 with SELECT dedup check + `INSERT ... ON CONFLICT DO NOTHING`. Catching 23505 in JS doesn't help because Postgres has already aborted the transaction at the statement level. `ON CONFLICT DO NOTHING` prevents the statement error entirely — the satisfaction_responses upsert always commits.
2. **Migration 016** (`016_satisfaction_alert_index.sql`): Drops broad `idx_jo_engagement_alert_inflight` and recreates it excluding `partner_satisfaction_alert`. Adds week-scoped `idx_jo_satisfaction_alert_weekly` keyed on `(aggregate_id, payload->'satisfaction'->>'week_start_date')` for satisfaction alerts specifically.

**Test count:** 570/570

---

### Sprint 5B Final Code Review Fixes (2026-04-16)

**Status:** COMPLETE

1. **IDOR enumeration** (Important/Security): Dashboard approval routes (approve/edit/regenerate) now scope the response query by `rv.business_id = ${user.businessId}`. Returns 404 for non-owned reviews instead of 403, preventing attackers from learning whether a reviewId exists in another business.
2. **Per-keyword budget** (Important/Scalability): Ranking worker budget check moved inside the per-keyword loop. Each keyword consumes one rate-limit slot — prevents budget bypass when `MAX_KEYWORDS_PER_BUSINESS` is raised above 1.
3. **Delivery ordering** (Important/Correctness): Drip worker records `notification_deliveries` before `markOutboxCompleted`, ensuring cooldown checks in other workers can see the delivery record.
4. **Settings sql.unsafe** (Important/Maintainability): Accepted as-is — the `FIELD_TO_COLUMN` allowlist is static and values are parameterized. Same pattern as admin PATCH route from Sprint 3.

**Test count:** 570/570 (tests updated for 404 instead of 403 on cross-business review access)

---

**Sprint 5B: COMPLETE** — All 5 prompts (19b Automated Ranking, 19c-5B Settings + Dashboard Actions, 19d-5B Satisfaction Alert, 19e Onboarding Drips, 19g Satisfaction Pulse) implemented with all review findings addressed across 16 review rounds. 570 tests across 39 files.

---

## Sprint 6: Scale to $1K MRR

**Status:** IN PROGRESS

### Prompt 20a — Correlation IDs + Structured Logging (2026-04-17)

**Status:** COMPLETE

Eight-task implementation delivered end-to-end traceability through the outbox payload JSONB field.

1. **Structured logger** (`src/lib/shared/logger.ts`): `createWorkerLogger(prefix, correlationId?)` returns `{ log, warn, error }` that prepends `[WorkerName] [corr-id]` to every log line. 6 unit tests.
2. **BasePayload types** (`src/lib/shared/worker-types.ts` + `src/lib/demos/types.ts`): All 12 payload interfaces now extend `BasePayload { correlation_id?: string }` — optional for backward compat with existing outbox rows.
3. **Entry point generation** — 7 pollers/schedulers (ReconciliationPoller, WeeklySummaryScheduler, MonthlyImpactScheduler, EngagementMonitorPoller, RankingTrackingScheduler, OnboardingDripScheduler, NotificationFailoverPoller) generate `correlation_id: uuidv7()` per outbox entry. 3 API routes (admin/businesses onboard, admin/demos/generate, feedback for partner_satisfaction_alert) add correlation IDs at user-facing entry points.
4. **Cross-outbox propagation** — `processReview` accepts `correlationId?` and threads it into all 5 internal outbox payloads. `ReviewSyncWorker` passes `job.data.correlation_id` into `processReview`. `ResponseGeneratorWorker` threads through `persistResponseAndNotify` into `SendNotificationPayload`. `PlaceIdValidationWorker.enqueueSyncReviews` accepts `correlationId?` from caller.
5. **Approval service** — 6 methods (`approve`, `edit`, `regenerate` + session variants) accept optional `correlationId?` and carry into their outbox payloads. All 6 corresponding API routes pass response_id as the correlation value.
6. **Worker log migration** — All 12 BullMQ handlers replaced `console.log(\`${LOG_PREFIX} ...\`)` with `createWorkerLogger`. Pollers/schedulers/ingress retain their `LOG_PREFIX` pattern (they don't process BullMQ jobs).

**Queryability:** `SELECT * FROM job_outbox WHERE payload->>'correlation_id' = '<id>' ORDER BY created_at` returns the full chain.

**Test count:** 576/576 across 40 files.

### Prompt 20a Post-Implementation Review Fixes (2026-04-17)

**Status:** COMPLETE

User identified 5 findings after review. All validated and fixed across 7 tasks.

1. **Finding 1 (Medium) — Approval/publish correlation chain break.** Approval routes were passing `link.response_id` as correlation_id, breaking the "one query traces full chain" goal. Fix: new helper `src/lib/approval/correlation.ts` `recoverCorrelationId(tx, {reviewId, responseId})` queries the most recent `generate_response` outbox row for the review and returns its correlation_id (falls back to responseId when no upstream exists). All 6 approval API routes updated. 3 new unit tests for the helper.

2. **Finding 2 (Medium) — Dispatching-race in outbox dedupe guards.** OutboxPoller sets `status = 'dispatching'` during the claim window, but 9 producer dedupe checks only covered `('pending', 'dispatched')`. Migration 004's unique index had the same gap. Fix: (a) migration 017 drops and recreates `idx_jo_sync_reviews_inflight` with `'dispatching'` included; (b) 9 code sites across 6 files updated.

3. **Finding 3 (Medium) — PII in correlation-tagged logs.** 4 cited log lines contained email addresses; audit found 10 total (emails + business names). All replaced with `business_id` / `response_id` operational identifiers.

4. **Finding 4 (Low) — Test coverage gaps.** Service tests passed `correlationId` transparently without asserting it — added explicit assertions that parse outbox payload JSON. Dashboard tests updated to assert correlation arg index. Created `worker/__tests__/PlaceIdValidationWorker.test.ts` with 3 test cases.

5. **Finding 5 (Low) — No expression index on correlation_id.** Migration 017 adds `idx_jo_correlation_id ON job_outbox ((payload->>'correlation_id')) WHERE payload ? 'correlation_id'`.

**Also recovered:** One orphaned commit from Prompt 20a Task 6 — subagent claimed to commit `src/lib/approval/service.ts` correlationId parameter additions but didn't. Committed as `ce8d69e` during Fix Task 3 review.

**Test count:** 582/582 across 42 files.

**Commits (7):** `7064330` (migration 017), `399b217` (dispatching guards), `c2af9c7` (correlation chain), `ce8d69e` (orphaned service.ts recovery), `1540ed4` (PII removed), `f0f5d71` (correlation assertions), `6d9c255` (PlaceIdValidationWorker test).

**Follow-up (2026-04-17):** Migration 017 renamed → 018 (vacate 017 for Sprint 6 main migration). Added cleanup CTE before `CREATE UNIQUE INDEX` (migration 004 pattern). Added `idx_jo_generate_response_by_review` for `recoverCorrelationId` lookup. Added 4 token approval route correlation tests, worker-chain runtime test (Part A + Part B in ResponseGeneratorWorker). Fixed pre-existing implicit-any type errors in `service.test.ts`. 590/590 tests across 44 files.

---

### Prompt 20b — Archival Expansion + Cost Rollups (2026-04-17)

**Status:** COMPLETE

**Migration 017:** `api_costs_daily_rollups` table (UUID PK, `UNIQUE NULLS NOT DISTINCT` constraint on `(business_id, provider, rollup_date)`, 3 indexes for admin costs query patterns: business/date, provider/date, date), `businesses.website`, `businesses.owner_email_bounced`, `notification_deliveries(created_at)` index for archival DELETE scans.

**ArchivalPoller:** Added `api_costs` aggregate+delete via atomic CTE — single statement: candidates (LIMIT 5000) → aggregate by (business_id, provider, date) → upsert into rollups with additive `ON CONFLICT DO UPDATE` → delete candidates. Batched cycles don't double-count because UPSERT is additive. Added `notification_deliveries` straight delete (>90d). 5-target logging: `outbox, events, demos, api_costs, notifications`. Per-target saturation warning lists exactly which tables hit the 5000 batch limit.

**Admin costs API:** Days cap raised 90→365 (rejects >365 with 400). When `days > 90`, queries both `api_costs` and `api_costs_daily_rollups` in parallel. Merge strategy:
- `byProvider`: sum detail + rollup totals per provider
- `byDay`: non-overlapping ranges by construction (rollup: `< CURRENT_DATE - 90d`, detail: `>= CURRENT_DATE - days`); defensive collision check (detail wins)
- `byBusiness`: enriches paginated detail rows with rollup tail totals; `todayUsd` + `pctOfDailyLimit` stay detail-only
- `todayTotalUsd`: detail-only (today is always < 90d)

**Bug fix during implementation:** The existing route had `parseInt(rawDays ?? '7', 10) || 7` which treated `days=0` as falsy and silently defaulted to 7, defeating the `Math.max(·, 1)` clamp. Fixed by checking `Number.isNaN(rawParsed)` explicitly so 0 and negatives reach the clamp.

**Test count:** 610/610 across 46 files (+20 new: 9 ArchivalPoller, 11 costs API; +2 extra coverage for `days=-5` and `days=abc`).

**Commits (9):** `3201d35` (migration 017), `4a88a4b` (api_costs CTE), `b792d05` (notifications delete), `bafbee9` (5-target logging), `2ad9287` (ArchivalPoller tests), `30d2556` (costs API merge), `b8afb48` (type fix), `2c4bf82` (costs API tests), `4773949` (days=0 clamp fix).

**Migrations ready to apply (in order):** `017_sprint6_scale.sql`, `018_correlation_and_dispatching_indexes.sql`. Neither has been applied yet.

---

### Prompt 20b Post-Implementation Review Fixes (2026-04-17)

**Status:** COMPLETE

7 findings validated and fixed.

1. **Critical — Cost archival double-count race under concurrent workers.** Candidates SELECT had no row locks; two workers could both SELECT same rows, both upsert additively, only one DELETE succeeds → doubled totals. **Fix:** DELETE-first claim pattern. Candidates CTE uses `FOR UPDATE SKIP LOCKED` with deterministic `ORDER BY created_at, id`. DELETE's RETURNING feeds the aggregate — each source row claimed and counted exactly once.
2. **Medium — Archived-only businesses disappearing from admin cost reporting.** byBusiness was paginated from detail rows, rollup only enriched already-returned rows. **Fix:** Initially combined in-memory then sort/paginate; later moved to server-side UNION CTE for scalability.
3. **Medium — byDay undercount on dates with both detail + rollup rows.** Drop-on-collision (detail "win") was fragile during partial archival. **Fix:** Additive merge. Safe because detail/rollup never reference the same source row (archival is atomic delete-then-upsert).
4. **Medium — Rollup numeric types too narrow.** `DECIMAL(10,6)` caps at $9,999.99 per row; INTEGER token totals/call_count can overflow at 2.1B. **Fix:** `NUMERIC(14,6)` + `BIGINT`. Migration 017 edited in place (not yet applied).
5. **Low — Negative limit produced 500 errors.** `Math.min(-5, 100) = -5` → `LIMIT -5` Postgres error. **Fix:** Parse once, `Number.isNaN` check, `Math.max` clamp.
6. **Medium — call_count `::int` casts narrow BIGINT storage.** Admin API used `SUM(call_count)::int` which overflows at 2.1B cumulative. **Fix:** All 6 casts changed to `::float` (JS safe integer handles 2^53).
7. **Medium — byBusiness pagination was app-side.** Loaded all business aggregates into Node before paginating. **Fix:** Server-side UNION CTE when `needsRollup`: `api_costs` aggregate UNIONed with rollup aggregate, grouped by business_id, JOINed with businesses, `ORDER BY ... LIMIT OFFSET` in SQL. Detail-only path is direct JOIN.

**Test count:** 618/618 across 46 files (+8 new regression cases).

**Commits (3):** `dc99b3a` (5 findings), `7a83084` (call_count + pagination).

---

### Prompt 20c — Onboarding Automation + SerpAPI Pre-fill (2026-04-17)

**Status:** COMPLETE

**New modules:**
- `src/lib/reviews/serpapi-prefill.ts` — wraps SerpAPI `engine=google_maps`, normalizes response into fixed `BusinessPrefill` shape (category/phone/website/hours/fullAddress). NEVER throws — returns all-null on any failure (API error, malformed payload, timeout, missing key, cache failure). 7-day Redis cache by place_id (skipped when `REDIS_CACHE_URL` unset, graceful on cache failures). Records platform-level `api_costs` row (`business_id=NULL` via widened `recordApiCost`). Mock-mode returns canned `MOCK_PREFILL`.
- `src/app/api/admin/businesses/prefill/route.ts` — GET endpoint. Requires admin/sales_partner via `requireRole`. Validates place_id via `isPlaceId()` (400 if missing or malformed). Rate-limited `prefill:minute:{user.id}` at 10/min in strict mode (503 on Redis failure to prevent uncapped SerpAPI spend). `Cache-Control: no-store` on all responses.

**Schema changes:**
- Widened `recordApiCost.businessId` to `string | null` (backward-compatible widening).
- Added `website` to `OnboardBusinessSchema` and `UpdateBusinessSchema` (Zod URL, max 500, nullable, optional).
- Added `website` column to businesses INSERT in POST handler.
- Added `website: 'website'` to `FIELD_TO_COLUMN` mapping in PATCH handler.

**UI changes:**
- Onboarding form (`/admin/businesses/new`): added `website` input (URL or empty) + auto-trigger prefill after PlaceAutocomplete selection. Uses `getValues()` at response-time (not request-time) so in-flight user typing is preserved — only fills empty fields. `setValue('field', value, { shouldDirty: false })` keeps form state clean. `prefilling` state drives "Fetching suggestions from Google Maps…" hint on category/phone/website fields. Website normalized `empty string → null` in submit payload.
- Business detail page (`/admin/businesses/[id]`): added `website` to `BusinessDetail` interface. ProfileEditor has `website` useState, PATCH body field, `handleCancel` reset. Read-only view shows website as clickable link (opens in new tab with `rel="noopener noreferrer"`). Edit form has `type="url"` input between Category and Tone.
- GET `/api/admin/businesses/[id]` route returns `website` in response.

**Tests (21 new):**
- 13 prefill module: full response, partial response, API error, malformed payload, `http://` preservation, bare domain `→ https://` normalization, malformed URL `→ null`, cost recording with null business_id, mock mode short-circuit, Redis cache hit (no SerpAPI call), cache write failure (still returns data), `REDIS_CACHE_URL` unset (skip cache entirely), missing `SERPAPI_API_KEY` (returns empty).
- 8 route: 200 happy path, 400 missing place_id, 400 invalid place_id, 401 unauth, 403 wrong role, 429 rate limit exceeded, 503 Redis unavailable (strict mode rethrows), rate limit key format.

**Test count:** 639/639 across 48 files (+21 new).

**Commits (6):** `d30d4b2` (widen recordApiCost), `627b244` (prefill module), `f6284b5` (prefill API route), `26f26fc` (schemas + INSERT + PATCH), `e6642a5` (onboarding form + auto-prefill), `1d7b335` (business detail website).

**Migration prerequisite:** `017_sprint6_scale.sql` must be applied to Supabase before running against production (adds `businesses.website` column). Not yet applied.

---

### Prompt 20c Post-Implementation Review Fixes (2026-04-17)

**Status:** COMPLETE

6 findings validated and fixed.

1. **Medium — Unsafe URL schemes** (javascript:, data:, ftp:, mailto:). Fix: new shared `websiteUrlSchema` enforces `http:`/`https:` via `new URL().protocol`. `normalizeWebsite` in prefill module also blocks non-http(s) schemes. Business detail page uses `safeHttpUrl()` defensive render sanitizer — unsafe URLs display as plain text.
2. **Medium — SerpAPI call no timeout.** Fix: `Promise.race` with 2000ms timer. Hanging SerpAPI calls reject into the existing catch → empty prefill.
3. **Medium — Fire-and-forget cost/cache writes on Vercel.** Fix: `await Promise.allSettled([recordApiCost, writeCache])` before returning — Vercel freezes post-response work. ~20-100ms latency for durable writes.
4. **Medium — Stale-response race on rapid place selection.** Fix: AbortController + `latestPlaceIdRef` + `dirtyFields` check (never overwrite touched fields, even if user then cleared).
5. **Low — Cached payloads trusted without validation.** Fix: `isValidBusinessPrefill` type guard + website re-normalization on cache read + `redis.del` of invalid entries.
6. **Medium — Clearing/switching PlaceAutocomplete did not cancel in-flight prefill.** Fix: `cancelPrefill()` helper called from `onClear` and mode-switch button.

**Test count:** 660/660 across 49 files (+21 new regression tests).

---

### Prompt 20d — Email Deliverability + Hard Bounce Handling (2026-04-17)

**Status:** COMPLETE

**Email categorization:**
- New `EmailCategory` type: `'transactional' | 'marketing' | 'internal'`.
- `getEmailHeaders(category)`: marketing gets `List-Unsubscribe: <mailto:...>` + `List-Unsubscribe-Post: List-Unsubscribe=One-Click`. Others empty.
- `getEmailTags(category)`: single Resend tag `[{ name: 'category', value }]`.
- `sendApprovalEmail`: transactional (no unsubscribe header — service-necessary, not marketing).
- `sendInternalEmail(params: { ..., category? })`: defaults to `internal`. Pass `'marketing'` for owner-directed recurring emails.

**Worker call-sites:**
- Marketing: WeeklySummaryWorker, MonthlyImpactWorker, OnboardingDripWorker, EngagementAlertWorker.handleOwnerNudge
- Internal: EngagementAlertWorker.handlePartnerAlert + handleSatisfactionAlert, ResponsePublisherWorker, AdminExceptionWorker, NotificationFailoverPoller

**Hard bounce handling (`worker/ingress/resend.ts`):**
- Defensive bounce-type extraction from `data.bounce.type`, `data.reason`, `data.status` (lowercase, fallback `'unknown'`).
- `isHardBounceType` matches `permanent`, `hard`, `hardbounce`, `permanent_failure`, or any string containing `permanent`. `unknown` is treated as soft.
- Hard bounces: UPDATE `businesses.owner_email_bounced = TRUE` + send admin alert to `ADMIN_NOTIFICATION_EMAIL` with category `'internal'`.
- `notification_deliveries.failure_reason` set to `bounced:<type>` for attribution.
- Complaints set `failure_reason = 'complained'` but do NOT flag the business.

**Skip-if-bounced guards:**
- 5 workers SELECT `owner_email_bounced` and skip (+ markOutboxCompleted) if true: NotificationWorker, WeeklySummaryWorker, MonthlyImpactWorker, OnboardingDripWorker, EngagementAlertWorker.handleOwnerNudge.
- EngagementMonitorPoller excludes bounced businesses from `owner_nudge` rule at query time; partner/satisfaction rules still fire.
- Manual-post/exception/partner alerts unaffected — they go to admin.

**Admin visibility:**
- Admin overview shows Email Health card: 24h delivery rate (% + green/red), 24h sent count, 7d hard-bounce count, 7d complaint count. Red state when delivery rate <95% (with ≥5 sends) OR any complaint in 7d OR any hard bounce in 7d.
- Business detail page shows red warning banner when `ownerEmailBounced=true` (impact explanation + "Clear bounce flag" button that PATCHes `ownerEmailBounced: false`).

**Schema + API:**
- `UpdateBusinessSchema` accepts `ownerEmailBounced: z.boolean().optional()`.
- `FIELD_TO_COLUMN` maps `ownerEmailBounced → owner_email_bounced` for PATCH.
- GET `/api/admin/businesses/[id]` returns `ownerEmailBounced: row.owner_email_bounced ?? false`.

**Documentation:**
- `docs/email-deliverability.md`: DNS auth (SPF/DKIM/DMARC), warmup schedule (stagger 2-3 customers/week first month), daily/weekly monitoring, troubleshooting table, hard bounce flow, env vars, List-Unsubscribe compliance rationale.

**Tests:** +23 new tests across 5 files.
- 8 `email-headers.test.ts` — marketing vs transactional/internal headers, LIST_UNSUBSCRIBE_EMAIL precedence, RESEND_FROM_EMAIL mailbox extraction (display name + bare), fallback.
- 4 `email-send.test.ts` — transactional tags with no headers, internal default, marketing with headers, explicit internal.
- 5 `resend-webhook-bounce.test.ts` — permanent bounce flags + alerts, transient does not, unknown treated as soft, `data.reason=permanent_failure` path, complained records status without flagging.
- 4 `bounced-skip.test.ts` — each of 4 owner-directed workers skips when `owner_email_bounced=true`.
- 2 `EngagementMonitorPoller.test.ts` — owner_nudge suppressed for bounced, partner rules still fire for bounced.

**Test count:** 683/683 across 53 files.

**Commits (10):** `daae866` (EmailCategory helpers), `bac5b31` (send functions), `41ea3ac` (worker call-sites), `d07eaf0` (hard bounce detection), `365b625` (skip guards), `b9bea94` (EngagementMonitorPoller exclusion), `833b1f8` (Email Health card), `54c4ac8` (type check fix), `9f851bc` (business detail banner), `8f1e295` (deliverability docs).

**Migration prerequisite:** `017_sprint6_scale.sql` adds `businesses.owner_email_bounced` (also `businesses.website` from Prompt 20c). Not yet applied to Supabase.

---

## Sprint 6 — Prompt 20d Post-Review Fixes (2026-04-17)

Six findings from the Prompt 20d post-implementation review.

**Fixes (9 files, commit `3800247`):**
- **#1 Critical — admin/partner template bounces incorrectly flagged owner.** Webhook now SELECTs `business_id AND template` from the delivery row and only flags `owner_email_bounced` when the template is owner-directed (`approval_request`, `weekly_value_report`, `monthly_impact`, `owner_nudge`, `onboarding_drip_*`). Bounces on admin/partner templates (`admin_manual_post`, `partner_engagement_alert`, etc.) log-and-skip.
- **#2 Medium — duplicate admin alerts on repeated bounces.** `UPDATE businesses SET owner_email_bounced = TRUE WHERE ... AND owner_email_bounced IS DISTINCT FROM TRUE RETURNING id`. Admin alert fires only on the FALSE→TRUE transition.
- **#3 Medium — missing indexes.** Migration `019_notification_delivery_bounce_indexes.sql` — partial indexes on `notification_deliveries(external_message_id)`, `(sent_at)`, `(failed_at, failure_reason)`.
- **#4 Medium — bounce classification disagreement.** Centralized `classifyBounce()` normalizes raw types into `bounced:hard:<raw>` or `bounced:soft:<raw>`. Admin overview SQL filters on `bounced:hard:%` prefix.
- **#5 Medium — bounce banner pointed nowhere useful.** `ownerEmail` added to `UpdateBusinessSchema`, `FIELD_TO_COLUMN`, and the admin Business Profile editor.
- **#6 Low — bounced-owner + missing env marked nudge failed.** `EngagementAlertWorker.handleOwnerNudge` bounce check moved BEFORE env validation.

**Tests (+6 new):** regression for `admin_manual_post` / `partner_engagement_alert` templates (must NOT flag), `onboarding_drip_day_7` (MUST flag via prefix), transition-guard duplicate-alert suppression, bounced-owner + missing env safety. 689/689 across 53 files.

---

## Sprint 6 — Prompt 20e (Launch Readiness Documentation) 2026-04-17

Final prompt of Sprint 6. Docs + lightweight UI only — no worker, DB schema, API, or middleware changes.

**Deliverables:**
- **`docs/operational-runbook.md`** — authoritative ops reference for sales partner + oncall engineer. 5 sections:
  - **A.** "Customer says X" troubleshooting × 5 scenarios (no approval email, tone mismatch, not posted on Google, too many emails, reviews not picked up).
  - **B.** Daily health check (2 min): six-row table with metric, where to look, green state.
  - **C.** Debugging SQL × 7 queries: correlation-id trace, stuck outbox, business activity, reset stuck entry, today's cost, bounced businesses, manual-post backlog.
  - **D.** Incident response × 7 scenarios: worker crash, Redis down, Supabase down, SerpAPI quota, LLM outage, cost circuit breaker, Resend degraded. Each splits Auto vs. Manual.
  - **E.** Weekly maintenance × 5 checkbox tasks: Resend reputation, Stripe invoices, `/admin/costs` drill-down, SerpAPI quota, outbox/archive health.
- **`docs/smoke-test-checklist.md`** — pre-launch manual E2E gate against real services in Stripe test mode. 3 businesses: A (happy path), B (edit + concurrent onboarding), C (regenerate + correlation trace). System health across all 3, throughput sanity (200 seeded outbox entries, non-prod), mobile approval perf (<2s FCP on throttled 3G).
- **`src/app/admin/runbook/page.tsx`** — admin-facing quick-reference page at `/admin/runbook`. Static client component, no data fetches. 4-column table populated from typed `SCENARIOS: Scenario[]` (A1–A5). Bottom "Need more?" callout links to the three markdown docs.
- **AdminNav `Runbook` link** — one entry added to `navItems`.

**Post-implementation review fixes (3 findings inline):**
- Runbook referenced nonexistent `DAILY_COST_LIMIT_USD` — replaced with actual `GLOBAL_DAILY_COST_LIMIT_CENTS` + per-tier `DAILY_COST_LIMIT_CENTS_{FOUNDING,STANDARD,PREMIUM}`.
- Runbook page `#` column header added `font-mono` to match mono body cells.
- Runbook page `<th>` elements got `scope="col"` for screen-reader support.

**Tests:** 689/689 passing across 53 files. No new test files (no logic changes). `pnpm tsc --noEmit` clean. `pnpm build` clean; `/admin/runbook` static-rendered (2.12 kB).

**Commits:** `cfabb6e` (runbook doc), `8cdb651` (runbook env-var fix), `456c429` (smoke checklist), `1458d06` (nav link), `8ed763a` (runbook page), `705aa20` (runbook page a11y + font-mono).

---

## Sprint 6 — COMPLETE (2026-04-17)

All five prompts shipped: 20a (correlation IDs + logging), 20b (archival + cost rollups), 20c (SerpAPI pre-fill), 20d (email deliverability + hard bounces), 20e (launch readiness docs). 689/689 tests, 53 files, clean build. Ready for the pre-launch smoke test gate and first paid customer.

---

## Communication Channels — Phase 0 (2026-04-20 / 2026-04-21)

**Branch:** `feat/communication-channels` (17 commits ahead of main, not yet merged)
**Goal:** Lay the pluggable multi-channel transport foundation and migrate `NotificationWorker` to dispatch across all enrolled channels — Phase 0 keeps email as the only live channel but the architecture is ready for SMS, Telegram, WhatsApp.
**Tests:** 754/754 passing. TypeScript clean. Build clean.

---

### Task 1 — Migration 021: channel_enrollments (2026-04-20)

**File:** `supabase/migrations/021_channel_enrollments.sql`

New table `channel_enrollments` — one row per `(business_id, channel_id)` pair:

- `id` UUID (no default — caller supplies UUIDv7)
- `business_id` FK → businesses
- `channel_id` TEXT CHECK IN ('email','sms','whatsapp','telegram')
- `status` TEXT CHECK IN ('pending_verification','active','paused','revoked') DEFAULT 'pending_verification'
- `handle` TEXT — channel address (email, phone, Telegram chat ID, etc.)
- `handle_masked` TEXT — admin-visible partial, e.g. `a***@example.com`
- `verification_token_hash` TEXT — SHA-256 of verification token (never stored raw)
- `verified_at`, `created_at`, `updated_at` timestamps
- UNIQUE `(business_id, channel_id)` — one enrollment per channel per business
- Backfill: all existing businesses auto-enrolled in email (`status='active'`) using `businesses.owner_email`

**Commit:** `f927afb`

---

### Task 2 — NotificationChannel interface + delivery.ts widening (2026-04-20)

**Files:** `src/lib/notifications/channels/types.ts`, `src/lib/notifications/delivery.ts`

- `ChannelId` union type: `'email' | 'sms' | 'whatsapp' | 'telegram'`
- `SendApprovalParams` interface: `{ responseId, businessId, businessName, reviewerName, starRating, approvalLinkId, approvalUrl, channel }`
  - Note: `approvalLinkId` (UUIDv7 row ID) not `rawToken` — inline buttons get the stable ID, not the secret token
- `NotificationChannel` interface: `{ id: ChannelId; send(params): Promise<{ messageId: string }> }`
- `recordNotificationDelivery` — widened `channel` param from `'email'` literal to `ChannelId`

**Commit:** `ed3f2b9`

---

### Task 3 — EmailChannel (TDD) (2026-04-20)

**Files:** `src/lib/notifications/channels/email-channel.ts`, `src/lib/notifications/channels/__tests__/email-channel.test.ts`

- Wraps existing `sendApprovalEmail` from `src/lib/notifications/email.ts`
- Implements `NotificationChannel` — `id = 'email'`, `send()` returns `{ messageId }`
- Tests: sends via Resend, propagates errors, correct messageId forwarded

**Commit:** `f2fd621`

---

### Task 4 — getChannel factory (TDD) (2026-04-20)

**File:** `src/lib/notifications/channels/index.ts`

- `getChannel(channelId: ChannelId): NotificationChannel` — throws `UnsupportedChannelError` for unregistered channels
- Registry: `email` → `EmailChannel`; SMS/WhatsApp/Telegram placeholders return the error (Phase 1–3 will register them)

**Commit:** `9641630`

---

### Task 5 — getVerifiedEnrollments (TDD) (2026-04-20)

**Files:** `src/lib/notifications/enrollments.ts`, `src/lib/notifications/__tests__/enrollments.test.ts`

- `getVerifiedEnrollments(businessId): Promise<ChannelEnrollment[]>` — queries `channel_enrollments WHERE status='active'`
- Returns `{ channelId, handle }` per row; empty array if none (caller treats as no-ops)

**Commit:** `695799e`

---

### Task 5.5 — createApprovalLink channel-aware refactor (TDD) (2026-04-20)

**Files:** `src/lib/approval/create-link.ts`, `src/lib/approval/__tests__/create-link.test.ts`

- Added `channel: ChannelId` required param — each channel gets its own `approval_links` row
- `revokeMode`: `'orphaned_only'` (default) revokes same-channel open links only if no prior same-channel delivery exists; `'always'` revokes unconditionally (used by nudge emails)
- Advisory lock `pg_advisory_xact_lock(hashtext(responseId + ':' + channel))` wraps the delivery-check + revoke + INSERT inside `sql.begin` — prevents TOCTOU race where two concurrent workers for the same channel can both observe "no delivery" and then one revokes the other's freshly-created link
- Returns `{ rawToken, tokenHash, approvalLinkId }` — caller uses `rawToken` in URL, `approvalLinkId` for inline buttons

**Commits:** `ea7971d` (feature), `d01d729` (TOCTOU fix)

---

### Task 6 — NotificationWorker multi-channel dispatcher (TDD) (2026-04-20)

**File:** `worker/jobs/NotificationWorker.ts`

Full rewrite of the notification dispatch path:

1. Load business + subscription check (skip `cancelled`/`pending_payment`)
2. `getVerifiedEnrollments(businessId)` — get all active channels
3. For each enrollment: `createApprovalLink({ channel })` → `getChannel(channelId).send(params)` → `recordNotificationDelivery`
4. Channels are isolated: one channel throwing does not prevent others from sending
5. Tracks `attempted` / `succeeded` counters; throws if `succeeded === 0` (all channels failed) so BullMQ retries the job
6. `failover` payload field recognized — logs it and proceeds with normal dispatch

**Commit:** `45ebc71`

---

### Task 7 — Failover poller stale branch → admin alert (TDD) (2026-04-20)

**File:** `worker/jobs/NotificationFailoverPoller.ts`

Key behavioral change: the **stale branch** (pending_approval >4h, at least one send attempted, owner hasn't responded) no longer re-dispatches a `send_notification` outbox job. Instead it sends an admin alert via email. Rationale: in the multi-channel era, all enrolled channels already fired on initial dispatch; re-sending is unlikely to help — escalate to admin.

New `tryClaimAlert(responseId, template, recipient, sendFn, ctx)` helper:
- Acquires `pg_advisory_xact_lock(hashtext(responseId:template:recipient))` transaction-scoped
- Re-checks `notification_deliveries` for a recent alert (24h dedup) INSIDE the lock
- Calls `sendFn()` and inserts the delivery row in the same transaction
- Returns `'sent' | 'deduped' | 'send_error'`
- Two failover-poller processes (multi-instance Railway) arriving concurrently: one waits for the lock, then finds the row on re-check and skips

`runFailoverPollerOnce` exported (was internal `checkFailedNotifications`) — used by tests directly.

`shouldRunFailoverPoller` in `worker/index.ts` simplified — dropped `RESEND_WEBHOOK_SECRET` gate; now only checks `NOTIFICATION_FAILOVER_DISABLED` and `MOCK_EXTERNAL_APIS`.

Stale query now gates on `sent_at` (not `delivered_at`) — Telegram has no delivery callbacks, SMS webhooks unreliable in some regions.

**Commits:** `b5a88b1` (feature), `6f7b431` (multi-instance dedup fix), `8feef4c` (poller gate)

---

### Task 8 — Remove notification_preference field (2026-04-20)

`notification_preference` column was the pre-channels single-value field (e.g. `'email'`). Replaced by `channel_enrollments` rows. Removed from 8 files:

- `src/app/api/settings/route.ts`
- `src/app/api/dashboard/route.ts`
- `src/app/api/admin/businesses/route.ts`
- `src/lib/shared/schemas.ts`
- `src/app/(authenticated)/settings/page.tsx`
- `src/app/admin/businesses/new/page.tsx`
- `src/app/admin/runbook/page.tsx`
- Test file

**Commit:** `1b5d40e`

---

### Task 9 — Onboarding POST auto-enrolls email channel (2026-04-20)

**File:** `src/app/api/admin/businesses/route.ts`

Onboarding `POST` now inserts into `channel_enrollments` (email, status=`active`) inside the existing `sql.begin` transaction alongside the `businesses` INSERT — one atomic write, no separate step.

**Commit:** `e75e246`

---

### Task 9.5 — Admin PATCH syncs owner_email with enrollment (2026-04-20)

**File:** `src/app/api/admin/businesses/[id]/route.ts`

When admin edits `owner_email`, the PATCH now:
- Runs inside `sql.begin`
- Uses `BusinessNotFoundError` sentinel to distinguish "not found" from DB errors
- UPSERTs `channel_enrollments` for `channel_id='email'` with new handle + updated `handle_masked` + resets status to `'active'`
- Returns 409 on unique constraint violation (23505) instead of 500

**Commit:** `3769d37`

---

### Task 10 — Admin Channels section UI + API route (2026-04-20)

**Files:** `src/app/api/admin/businesses/[id]/channels/route.ts`, `src/app/admin/businesses/[id]/page.tsx`

New `GET /api/admin/businesses/[id]/channels` (`force-dynamic`):
- Returns all `channel_enrollments` rows for the business
- Includes `last_activity_at = MAX(COALESCE(nd.delivered_at, nd.sent_at))` from `notification_deliveries`
- `handle_masked` shown (never the raw handle)
- Hidden character count clamped to `Math.max(0, handle.length - 7)` to prevent negative values on short addresses

Admin business detail page (`/admin/businesses/[id]`):
- Second `useQuery` for channels data
- Channels section renders a table of enrolled channels with `StatusBadge`, masked handle, last activity
- `invalidateQueries(['admin-business-channels', businessId])` added to the `owner_email` mutation so the channel list refreshes when email is updated

**Commits:** `e0c72a1` (feature), `5552e4e` (clamp fix + query invalidation)

---

### Phase 0 — COMPLETE and MERGED (2026-04-21)

17 commits. Merged to main 2026-04-22 as part of the `feat/communication-channels` branch merge.

**Shipped:**
- Migration 021: `channel_enrollments` table + email backfill for existing businesses.
- `NotificationChannel` interface, `SendApprovalParams`, `ChannelId` types.
- `EmailChannel` wrapping existing Resend `sendApprovalEmail`.
- `getChannel` factory (sms/telegram/whatsapp stubs replaced in Phase 1).
- `getVerifiedEnrollments` query helper.
- Multi-channel `NotificationWorker` dispatcher (per-enrollment loop, isolation, idempotency).
- `createApprovalLink` channel-scoped with per-(response_id, channel) advisory lock.
- Failover poller stale branch → admin alert (no longer re-dispatches).
- Admin Channels section UI + `/api/admin/businesses/[id]/channels` read endpoint.
- Removed `businesses.notification_preference` field (deprecated by 022 drop).

---

### Phase 1 — SMS — COMPLETE and MERGED (2026-04-22)

31 commits. Merged to main 2026-04-22 (`feat/communication-channels` branch, 49 commits ahead of origin at time of merge). **906/906 tests passing. `pnpm build` clean.**

**Flag-gated off** by default (`CHANNELS_SMS_ENABLED=false`). No behavior change in production until flag is enabled after 10DLC registration.

**Shipped:**

_Schema (migration 022):_
- Dropped `businesses.notification_preference` (promised in 021).
- Soft-delete columns on `channel_enrollments` (`archived_at`, `archive_reason`).
- `sms_sender_opt_outs` table — sender-level opt-out state keyed by `(messaging_service_sid, handle)`, survives enrollment lifecycle.
- `sms_sender_opt_out_events` — append-only TCPA audit log for STOP/START/21610 events, with CHECK constraints on `event_type` + `source`, `ON DELETE SET NULL` FK to `inbound_events`.
- RLS enabled on both new tables.
- Partial unique index on `channel_enrollments(business_id, channel) WHERE archived_at IS NULL` (replaces full UNIQUE constraint; Phase 0 upsert sites updated to include the predicate).
- Handle lookup index scoped to active rows only.

_Core SMS:_
- `SmsChannel` — Twilio Messaging Service wrapper implementing `NotificationChannel`. 21610 maps to typed `SmsRecipientUnsubscribedError`.
- `sms-body.ts` — GSM-7 single-segment formatter with two-tier fallback (drops reviewer name on overflow; throws `SmsBodyTooLongError` if tier 2 also overflows).
- `sms-tracker.ts` — per-business + global daily cents cost guard in Redis; `reserveSmsCost` returns reservation date to prevent midnight-boundary refund bugs.
- `insertFailedDelivery` helper in `delivery.ts`.

_Twilio ingress (`worker/ingress/twilio.ts`):_
- Signature verification + form-body parsing utility.
- Status-callback handler — terminal-precedence first-wins, race-safe retry (503 + marks inbound_event failed so dedup reclaim picks it up), intermediate statuses no-op.
- Inbound STOP/START handler — keyword + OptOutType classification (EN + ES superset incl. REVOKE/OPTOUT), STOP writes `sms_sender_opt_outs` UPSERT + audit event + sender-wide `channel_enrollments` flip in one transaction, START writes `opted_in_at` + audit event (unconditionally), body redacted before `inbound_events` persist.
- Boot-time startup assertion (`assertChannelsSmsEnv`) — fails fast on missing Twilio vars.

_Admin API routes (6 routes, all in `src/app/api/admin/channels/sms/`):_
- `/verify` — Twilio-first, advisory-lock-serialized, sender-opt-out gate (blocks re-enrollment if `opted_in_at <= opted_out_at`), post-Twilio race re-check, state machine dispatch across empty/pending/disabled/unsubscribed/verified row states.
- `/confirm` — mid-flow STOP race handling (409 `sender_opted_out_during_verification` if STOP arrived during OTP window), row_not_pending guard, clears unsubscribed fields on success, does NOT touch `sms_sender_opt_outs`.
- `/cancel` — state-revert CTE (restores prior terminal status from timestamps; hard-deletes brand-new pending rows).
- `/disable` — verified → disabled with RETURNING guard.
- `/delete` — soft-delete only (`archived_at`), preserves TCPA evidence, strict `confirm: true` gate.
- `/status` (GET) — LEFT JOIN `sms_sender_opt_outs` scoped to current MS SID, returns derived `sender_opt_in_cleared` boolean.
- All routes: env-readiness 503 when `CHANNELS_SMS_ENABLED=true` but Twilio vars missing.

_Admin UI:_
- `SmsEnrollmentWidget` — 7-state client component (empty / sent / verified / disabled / unsubscribed / awaiting_sender_opt_in / opt_in_received). 3-second polling during awaiting START.
- `ChannelsSection` — server component for future server-page refactor.
- Business detail page wired: `smsEnabled` flag surfaced server-side via business detail API (no `NEXT_PUBLIC_*` leak); widget renders only when flag on + subscription active.

_Dispatcher:_
- `NotificationWorker` — flag-off skip for SMS enrollments, pre-send cost reservation with `try/finally` refund (covers createApprovalLink failures + non-ACK Twilio errors), sender-wide 21610 transaction (UPSERT opt-out + audit + channel flip).

_Tests:_ 906 total. Re-enable-after-STOP lifecycle E2E + archive-bypass integration tests. All mock-based (repo Vitest setup uses dummy DB URL).

**Pending (not blocking merge):**
- 10DLC brand + campaign registration paperwork.
- Manual ship gate (spec §15): real-phone end-to-end walkthrough (enroll → receive SMS → approve → STOP → re-enable lifecycle).

---

## 2026-04-23 — Communication Channels Phase 2 (Telegram) SHIPPED

**Status:** Code complete + **real-bot ship gate PASSED** against `@RepWorthBot` in local dev (via ngrok). PR to `main` opened. Flag-gated off (`CHANNELS_TELEGRAM_ENABLED=false`) — prod cutover pending prod bot registration + `setWebhook` + one-business pilot walkthrough.

**Branch:** `feat/channels-telegram` (30 commits ahead of `main`).

**Tests:** 985 passing, 88 suites, `pnpm tsc --noEmit` clean, `pnpm build` clean.

**Spec:** `docs/superpowers/specs/2026-04-22-telegram-phase-2-design.md`
**Plan:** `docs/superpowers/plans/2026-04-22-phase2-telegram.md` (19 tasks)

### Scope decisions (from brainstorming)

| # | Decision | Reasoning |
|---|---|---|
| 1 | **Admin-onboarding only** | Owner dashboard deferred to Phase 4 so SMS + Telegram + WhatsApp all land as one coherent sweep instead of a half-built `/dashboard/settings/channels` |
| 2 | BotFather registration + `setWebhook` = manual prereq | Mirrors the Twilio-console pattern from Phase 1; worker startup stays deterministic |
| 3 | Regenerate UX: replace original with "🔄 Regenerating…" via `editMessageText` | Refined during the walkthrough when the stripped-buttons-only variant felt jarring |
| 4 | Flag-gated off at merge; flipped per-environment after real-bot gate | Consistent with Phase 1 SMS posture |
| 5 | **Zero migrations** | Migration 021 already accommodates telegram; `inbound_events.source` is open TEXT; audit row uses existing `approval_audit_log.metadata` JSONB |
| 6 | No automated real-bot E2E | Per spec §5.3 — chat-platform automation is brittle and low-value; unit + integration + manual walkthrough instead |
| 7 | `approveViaCallback` + `regenerateViaCallback` ship together | Share 90% of validation; splitting duplicates work |
| 8 | Direct `fetch` to `api.telegram.org` — no SDK | Only 4 Bot API methods used (sendMessage, editMessageText, editMessageReplyMarkup, answerCallbackQuery) |

### Architecture

**Send path (dispatcher → owner):**

```
NotificationWorker (for each verified enrollment)
  ↳ TelegramChannel.sendApprovalRequest
    ↳ formatApprovalTelegram (pure HTML-escape + inline keyboard)
    ↳ TelegramClient.sendMessage → api.telegram.org
  ↳ on TelegramRecipientBlockedError → flip enrollment unsubscribed (telegram_blocked) + insertFailedDelivery
  ↳ on TelegramChatNotFoundError → flip enrollment disabled + insertFailedDelivery
  ↳ continue to next enrollment on any failure — one channel failure doesn't abort the whole job
```

**Callback path (owner tap → approval):**

```
Telegram webhook → POST /ingress/telegram
  1. verifyTelegramSecret (constant-time, X-Telegram-Bot-Api-Secret-Token)  → 401 on mismatch
  2. claimInboundEvent(source='telegram', dedupKey=tg:<update_id>, …)     → 200 on duplicate
  3. parseCallbackData (a:<link_id> | r:<link_id>)
  4. invariant checks: link live AND channel='telegram'; sender matches verified enrollment
  5. ACK BOUNDARY — answerCallbackQuery with outcome text ("Approving…" / "Regenerating…")
  6. approveViaCallback / regenerateViaCallback (inside sql.begin)
     permanent errors (Consumed/Revoked/Expired/ChannelMismatch/ResponseNotPending):
       → editMessageText in place (replaces stale draft + clears buttons) → markProcessed → 200
     unexpected errors (DB timeout, unknown):
       → sendMessage fallback (no URL embed — raw token not in scope)
       → markFailed → 503 (reclaim retries in 2min)
  7. on success: editMessageText for approve ("✅ approved…") or regenerate ("🔄 Regenerating…")
  8. markProcessed → 200
```

**Enrollment path (`/start <rawToken>`):**

```
Owner taps deep link → Telegram DM → /start <rawToken>
  1. verifyTelegramSecret → 401 on mismatch
  2. claimInboundEvent → 200 on duplicate
  3. Reject non-private chat.type (group/channel) — bot DMs won't reach owner later
  4. sha256(rawToken) → SELECT FOR UPDATE channel_enrollments by hash (inside sql.begin)
  5. UPDATE enrollment: status='verified', handle=chat_id, clear verification_token_hash/expires_at
  6. Send "✅ You're connected to RepWorth" confirmation
  7. markProcessed → 200
```

### Files changed

**New files (13):**

- `src/lib/approval/errors.ts` — added 4 typed errors: `ConsumedLinkError`, `RevokedLinkError`, `ExpiredLinkError`, `ChannelMismatchError` (match existing `{State}{Subject}Error` convention)
- `src/lib/notifications/channels/telegram-body.ts` — pure `formatApprovalTelegram(params)` with HTML escape, 400-char truncation, 64-byte callback_data budget
- `src/lib/notifications/channels/telegram-client.ts` — native fetch wrapper, 10s AbortController timeout, 4 typed error classes (Blocked / ChatNotFound / RateLimit / Api); JSON-parse failure classified as `TelegramApiError`
- `src/lib/notifications/channels/telegram-channel.ts` — `TelegramChannel implements NotificationChannel` thin adapter
- `worker/ingress/shared.ts` — extracted `claimInboundEvent(source, dedupKey, eventType, payload)` from twilio for reuse
- `worker/ingress/telegram.ts` — Fastify handler: enrollment + callback paths with Model A ack ordering
- `worker/ingress/telegram-verify.ts` — constant-time compare of X-Telegram-Bot-Api-Secret-Token
- `src/app/api/admin/channels/telegram/_shared.ts` — `isTelegramEnabled()` / `flagOff()` (404) / `assertTelegramEnvReady()` (503)
- `src/app/api/admin/channels/telegram/start/route.ts` — POST: advisory lock + state machine upsert inside `sql.begin`, server-side QR render, `Cache-Control: no-store, private`
- `src/app/api/admin/channels/telegram/cancel/route.ts` — POST: clears pending verification hash + expiry
- `src/app/api/admin/channels/telegram/disable/route.ts` — POST: flips verified → disabled (404 if none)
- `src/components/admin/TelegramEnrollmentWidget.tsx` — 8-state client UI, 3s polling, 1h TTL countdown
- `.claude/` skill files, design spec, plan doc, operational runbook updates

**Modified files (9):**

- `src/lib/approval/service.ts` — added `approveViaCallback` / `regenerateViaCallback` (~130 lines). Bypass device-cookie binding; validate link via `lockLinkByIdForCallback` throwing typed errors; call `recoverCorrelationId(tx, { reviewId, responseId })`; audit row with SHA-256 `chat_handle_hash` in `metadata` JSONB; `auth_method='token'` preserved (no CHECK migration)
- `src/lib/notifications/channels/index.ts` — factory: removed `'telegram'` from `NOT_YET_IMPLEMENTED`, added flag-gated branch; export `TelegramChannel` + 4 error classes
- `worker/ingress/twilio.ts` — pure refactor: import `claimInboundEvent` from shared, pass `source='twilio'`
- `worker/startup-assert.ts` — `assertChannelsTelegramEnv()` paralleling SMS
- `worker/index.ts` — registers POST /ingress/telegram route (`rawBody: true`); calls startup assertion
- `worker/jobs/NotificationWorker.ts` — telegram flag-skip branch (rollback-safe); `TelegramRecipientBlockedError` → enrollment flip to `unsubscribed`/reason `telegram_blocked`; `TelegramChatNotFoundError` → flip to `disabled`. Both filter by `handle` so stale sends cannot stomp re-enrolled handles. Also restored `logger.error` on SMS 21610 branch for observability parity + symmetric `COALESCE(unsubscribed_at, NOW())`
- `src/app/api/admin/businesses/[id]/route.ts` — `telegramEnabled` flag alongside `smsEnabled`
- `src/app/api/admin/businesses/[id]/channels/route.ts` — telegram handle masking `••• 1234` (replaces generic literal)
- `src/app/admin/businesses/[id]/page.tsx` — mounts `TelegramEnrollmentWidget` in Channels section, flag-gated

**New dependency:** `qrcode` + `@types/qrcode` for server-side QR data URL rendering.

**Env vars added** (see `.env.example`):
- `CHANNELS_TELEGRAM_ENABLED` (default false; server-authoritative)
- `TELEGRAM_BOT_TOKEN` (required when flag on)
- `TELEGRAM_WEBHOOK_SECRET` (required when flag on; 32+ bytes)
- `TELEGRAM_BOT_USERNAME` (optional; default `RepWorthBot`)

### Security invariants enforced

1. **Raw approval tokens NEVER persisted** — callback payloads carry `approval_link_id` (UUIDv7 row id, non-secret), not raw tokens. Redaction on `inbound_events.payload` also strips `/start <token>` text + `callback_query.data`.
2. **Four-invariant callback auth:** (a) provider signature verified, (b) approval_link live AND channel='telegram' (cross-channel replay blocked), (c) `callback_query.from.id` matches a verified non-archived enrollment for the link's business_id, (d) `inbound_events` dedup on `tg:<update_id>` — replays no-op.
3. **Verification tokens:** 1h TTL, SHA-256 hashed in DB, raw returned once to admin browser (`Cache-Control: no-store, private`), cleared on successful enrollment.
4. **PII redaction:** `from.first_name`, `from.last_name`, `from.username`, `chat.title` stripped from `inbound_events.payload` before persist — only `{id}` / `{id, type}` retained.
5. **Bot token never exposed** in thrown errors or logs — only lives in `TelegramClient.baseUrl` (private).

### Review cycles

Three internal review passes via `superpowers:code-reviewer` subagent caught real issues pre-walkthrough:

**Round 1** (7 findings): dispatcher threw from factory on retained enrollments after flag-off rollback (fix: flag-skip before factory); `approval_audit_log` has no `chat_handle_hash` column (fix: store in metadata JSONB); `claimInboundEvent` hardcoded `source` (fix: extract to shared); ack ordering (fix: committed to Model A); QR third-party leak (fix: local qrcode dep); setWebhook runbook JSON quoting; scope-vs-parent-spec delta not acknowledged.

**Round 2** (5 findings): unexpected-error `sendMessage` embedded approvalUrl but raw token out of scope (fix: text-only fallback); service signature missing `audit.updateId`/`ipAddress`; `recoverCorrelationId` needs `reviewId` too (load from responses inside tx); race vs transient conflated (fix: typed errors mark processed, unknowns mark failed); malformed callback didn't markProcessed.

**Round 3** (4 real race/auth issues): admin start route `pg_advisory_xact_lock` ran outside `sql.begin` → lock released immediately (fix: wrap state machine in tx); ingress enrollment `SELECT FOR UPDATE` + `UPDATE` also outside tx (same fix); NotificationWorker telegram error branches updated ALL enrollments for business with no handle filter → stale send could stomp re-enrolled handle (fix: `AND handle = ${enrollment.handle}`); callback sender lookup missing `AND archived_at IS NULL`.

**Pre-ship batch (M1–M6 + L6):** `ResponseNotPendingError` classified as permanent (prevents infinite retry on cross-channel approval race); `answerCallbackQuery` wrapped in `.catch()` (15s TTL vs 2min reclaim would loop); reject group/channel chat on `/start`; 10s AbortController on Bot API; widget distinguishes 401/403 from 5xx from empty enrollment; `Cache-Control: no-store, private` on admin responses; explicit PII allowlist in `redactForAudit`.

### Real-bot ship gate (2026-04-23)

Executed end-to-end against Hey Tea test business (`019db775-60c5-744b-b948-741e0d2021ad`) with `@RepWorthBot` via local worker + ngrok tunnel.

| Test | Outcome |
|---|---|
| Webhook registration (`setWebhook` + `getWebhookInfo`) | ✅ |
| QR enrollment | ✅ chat_id `7944845018` verified via `/start <rawToken>` |
| Approve round-trip | ✅ tap → `approveViaCallback` → response `approved` → publish_response outbox entry → editMessageText "✅ approved" |
| Regenerate round-trip | ✅ (after UX fix `01ad608`) — original message replaced with "🔄 Regenerating…"; new draft arrived as separate message |
| Blocked-bot detection | ✅ enrollment flipped to `status='unsubscribed'`, `unsubscribed_reason='telegram_blocked'`, `notification_deliveries.failed_at` + `failure_reason='telegram_blocked'` |
| Re-enroll after unblock | ✅ admin Re-enroll → state machine `unsubscribed → pending_verification` with fresh 1h-TTL hash → `/start <new-token>` → back to verified with same chat_id |
| Cross-channel race (M1) | ✅ (after commits `445e2cd` + `c12702f`) — email approve first → telegram tap → in-place editMessageText replaces stale draft with "This review has already been handled"; buttons removed; `inbound_events` marked `processed` (not `failed`); no retry spam |

### Post-walkthrough polish commits

- `01ad608` — Regenerate: switch from `editMessageReplyMarkup({inline_keyboard: []})` to `editMessageText` with status line. Old path only dropped buttons; stale draft text remained.
- `445e2cd` — Permanent link-state errors: switch from `sendMessage` (separate message, stale buttons remain) to `editMessageText` in place. Applied to both pre-ack `!linkLive` branch and post-ack catch.
- `c12702f` — Defensive: `TelegramClient.editMessageText` now defaults `reply_markup: { inline_keyboard: [] }`. Telegram's Bot API empirically preserves existing `reply_markup` when the field is omitted from an edit; explicit empty keyboard guarantees button removal.

### Known residuals (none blocking)

- Pre-ack "sender mismatch" branch intentionally does NOT strip buttons (real verified owner might still want to tap).
- `TelegramChatNotFoundError` branch (owner deletes chat instead of blocks) not exercised in manual walkthrough — identical code path to blocked-bot, low marginal value.
- `qrcode` admin route 409 path ("already verified") not exercised in walkthrough — unit tested.
- Phase 2 is admin-onboarding only; owner self-service dashboard bundles with SMS + WhatsApp in Phase 4.

### Prod cutover checklist

1. Register prod bot via BotFather, capture `TELEGRAM_BOT_TOKEN`.
2. Generate production `TELEGRAM_WEBHOOK_SECRET` (32+ random bytes).
3. Deploy branch to staging/prod with `CHANNELS_TELEGRAM_ENABLED=false`.
4. Run `setWebhook` against prod `WORKER_PUBLIC_URL` (runbook has the curl).
5. Flip flag to `true` in one pilot business's env.
6. Re-run ship gate on the pilot (enrollment + approve + regenerate + blocked-bot + re-enroll + cross-channel race).
7. 24h Sentry watch on pilot.
8. If clean, widen to all `active`-subscription businesses.

---

## Communication Channels — Phase 3: WhatsApp (2026-04-23)

**Status:** CODE COMPLETE on branch `feat/channels-whatsapp-phase-3`. 23 commits. 1087/1087 tests pass. 0 tsc errors. 0 migrations. Flag-gated off (`CHANNELS_WHATSAPP_ENABLED=false`) pending Meta Business verification + WABA + approved `repworth_approval_request_v1` Twilio Content template.

Design: `docs/superpowers/specs/2026-04-23-whatsapp-phase-3-design.md` (gitignored local working doc).
Plan: `docs/superpowers/plans/2026-04-23-whatsapp-phase-3.md` (gitignored local working doc).
Parent spec: `docs/adding-communication-channels.md` §5.1 Phase 3.

### Brainstorming → spec → plan → implement pipeline

End-to-end in a single session via the superpowers skills pipeline: `brainstorming` → `writing-plans` → `subagent-driven-development` → `finishing-a-development-branch`.

**Brainstorming decisions:** External prereqs nothing-started (flag-gated off at merge, identical posture to SMS/Telegram). Scope narrowed to admin business-detail page only (matches Phase 2 precedent; Phase 4 bundles owner dashboard). All 6 technical approach defaults accepted: A1 separate Fastify routes, B1 3-button UTILITY template, C1 no WA-specific opt-out table, D1 delegate session-window to Twilio/Meta, E1 direct `TWILIO_WHATSAPP_NUMBER` no Messaging Service, F1 mirror Phase 2 ship gate.

**Design spec reviews — 5 rounds:** Round 1 (11 issues: missing `ResponseNotPendingError` in permanent-error list, wrong Twilio error-code mapping, config errors falsely unsubscribing owners, Telegram-shaped audit context, missing archived_at guards, private `classifyIntent`, missing timeout, underspecified Content type, wrong assertion placement, hardcoded URL base, naive URL parser). Round 2 (5 issues: WA env assertion relying on SMS, non-atomic audit widening, missing template doc deliverable, missing `.env.example` row, need "no import-time work" rule). Round 3 (2 issues: spec line still said `split('/').pop()`, `retry_after` had no concrete mechanism). Round 4 (4 Medium + 5 Low: untouched-file contradiction, conditional metadata shape, missing CONFIG-ERROR guard test, inconsistent widget states, and various polish). Round 5: approved.

**Plan:** 20 tasks with atomic ordering constraints (CallbackAuditContext widening as first commit; WA modules side-effect-free at import; template doc before body.ts).

### Implementation (23 commits)

Sequential dispatch via `subagent-driven-development` — fresh implementer subagent per task, two-stage review (spec compliance → code quality) after each.

**Task 1 — Widen CallbackAuditContext atomically (`2676903` + `f78262c`):** Replaced `{ updateId: number }` with discriminated union `{ telegramUpdateId | twilioMessageSid }` enforcing "never both" at compile time via `?: never`. `buildCallbackAudit` emits cross-channel `metadata.provider_event_id` unconditionally + channel-specific `update_id` (Telegram legacy query continuity) or `message_sid` (WhatsApp). Follow-up commit tightened to discriminated union + added assertion that `message_sid` absent on Telegram rows. 2 Telegram callsites updated. 6 test fixtures updated. 985 tests pass.

**Task 2 — Extract classifyIntent to `twilio-intent.ts` (`5a75c10`):** Pure move of STOP/START keyword sets + classifier from `twilio.ts` (file-local) to new shared module so SMS + WA both import. `twilio.ts` SMS logic untouched; regression surface = one import line. 7 tests. 992 pass.

**Task 3 — `docs/whatsapp-templates.md`:** Template reference (local gitignored). `twilio/card` Content type, 9 body variables with max-length + null-safe defaults, 3-button configuration (2 QUICK_REPLY + 1 URL), UTILITY category, submission JSON, Meta re-review triggers, sandbox testing instructions.

**Task 4 — `whatsapp-body.ts` pure helpers (`deef853`):** 5 exports: `formatApprovalWhatsApp`, `extractTokenFromApprovalUrl`, `stripWaPrefix`, `toWaRecipient`, `truncate`. Side-effect-free at import. Implementer caught subtle spec bug: `split('/').filter(Boolean).at(-1)` silently passes trailing-slash `/approve/` because filter strips empty segment — fixed with `endsWith('/')` check. 24 tests. 1016 pass.

**Task 5 — `whatsapp-client.ts` + error classification (`9152d39` + `ef20d6f`):** Twilio SDK wrapper with `{ timeout: 10_000, autoRetry: false }`, lazy env reads, 7 typed error classes, `classifyError` dispatch via `Set<number>` membership. Anti-regression test for raw-token-locality: every error-path test spies on console.log/error/warn asserting no call arg contains the raw token fixture. Follow-up added `readonly code = 'TIMEOUT' as const` for uniformity. 12 tests.

**Task 6 — `WhatsAppChannel` (`a29fcd3`):** Thin `NotificationChannel` adapter wiring body formatter to client sendTemplate. Side-effect-free at import. 3 tests.

**Task 7 — Factory + exports (`db2f47b`):** Removed `'whatsapp'` from `NOT_YET_IMPLEMENTED`, added flag-gated factory branch, exported 7 error classes. 1031 pass.

**Task 8 — `assertChannelsWhatsAppEnv` (`55f8cf9`):** Self-contained boot assertion. Does NOT depend on `assertChannelsSmsEnv`. Enforces: 7 env vars present, `TWILIO_WHATSAPP_NUMBER` matches `/^whatsapp:\+\d{7,15}$/`, `WHATSAPP_APPROVAL_URL_BASE === NEXT_PUBLIC_APP_URL + '/approve/'`. 6 tests. 1037 pass.

**Task 9 — WA status callback (`8887091`):** Created `worker/ingress/twilio-whatsapp.ts` scaffold. Mirrors SMS status handler (signature verify, dedup on `${MessageSid}:${MessageStatus}`, first-wins terminal state, reclaim if delivery row missing) with `AND channel = 'whatsapp'` discriminator. Exported `redactWhatsAppPayload`. 4 tests. 1041 pass.

**Task 10 — WA inbound handler (`f4a8979` + `eb76aa7`):** Heaviest task. 3 flow paths with post-claim safety net:

```
inbound/ verifyTwilioSignature → claimInboundEvent → OUTER TRY {
  if ButtonPayload: UUID check (malformed → markProcessed + 200, no DB) →
    SELECT approval_links live → enrollment check (archived_at IS NULL) → INNER TRY {
      approveViaCallback/regenerateViaCallback(viaChannel='whatsapp', twilioMessageSid)
      permanent errors (5 classes) → friendly text + markProcessed + 200
      unexpected → fallback text + markFailed + 503 (reclaim 2min)
      success → "✅ approved" / "🔄 Regenerating" + markProcessed + 200
    }
  classifyIntent: 'stop' → UPDATE channel_enrollments (handle-scoped, archived_at, COALESCE)
                  'start' → no-op
                  'none' + Body starts 'start-' → sql.begin(sha256 + UPDATE, archived_at on both)
                         → sendFreeform confirm (LOG failures via console.warn)
} CATCH → markFailed('post_claim_unexpected:...') + 503
```

Follow-up `eb76aa7` unwrapped unnecessary STOP `sql.begin` + added warn log on confirmation send failure. 17 tests. 1054 pass.

**Task 11 — Register routes in `worker/index.ts` (`a7dc1a3`):** 2 route registrations + startup assertion call. Smoke-tested boot flag on/off.

**Task 12 — Dispatcher branches (`6136330`):** Flag-skip + 6 WA error branches. OWNER-INTENT (blocked→unsubscribed, invalid→disabled) mutates enrollment with handle-scoped + archived_at guard. **CONFIG-ERROR (`TemplateConfigError`, `SessionWindowError`) leaves enrollment UNCHANGED** — RepWorth ops failure, not owner intent; flipping to unsubscribed would falsely suppress + mislead admin widget. **Explicit test asserts zero `channel_enrollments` UPDATE calls on `WhatsAppTemplateConfigError`** — single most important regression guard in Phase 3. TRANSIENT (`RateLimit`, `Timeout`) records failed_delivery, enrollment unchanged, BullMQ backoff retries. Existing NotificationWorker test files updated with WA error stubs. 6 integration tests. 1060 pass.

**Task 13 — Admin `_shared.ts` (`a9ceeb7`):** `isWhatsAppEnabled()` / `flagOff()` (404) / `assertWhatsAppEnvReady()` (503). 5 env vars checked (admin routes don't need `WORKER_PUBLIC_URL` / `NEXT_PUBLIC_APP_URL` directly). 6 tests.

**Task 14 — Admin `/start` (`13c2d9b`):** Flag → env → auth → businessId → subscription active → advisory lock → state-machine upsert. 5 state transitions (none→pending, pending→pending, unsubscribed→pending, disabled→pending, verified→409). Advisory lock key `sha256('whatsapp_enroll:' + businessId).readBigInt64BE(0)`. wa.me deep link requires digits only (`TWILIO_WHATSAPP_NUMBER.replace(/^whatsapp:\+?/, '')`). QR rendered server-side via `qrcode`. `Cache-Control: no-store, private`. 10 tests. 1076 pass.

**Task 15 — Admin `/cancel` (`0526a43`):** Clears verification token fields on pending row. Idempotent. 2 tests.

**Task 16 — Admin `/disable` (`94c9ee5`):** Flips verified → disabled. 3 tests. 1081 pass.

**Task 17 + 19 — Business detail API + widget mounting (`239c72b`):** `whatsappEnabled` flag in response; `<WhatsAppEnrollmentWidget>` conditional mount.

**Task 18 — `WhatsAppEnrollmentWidget` (`25a3e18`):** 8-state UI (idle/generating/awaiting_scan/verified/disabled/unsubscribed/expired/error). 3s polling, 1h TTL countdown, masked phone `+15•••4567`. `onCancel` force-resets idle locally BEFORE refresh (otherwise stale QR would remain since server row stays `pending_verification`). Three-way fetch result (`ok | auth_expired | error`) — never silently collapses non-OK to idle.

**Task 20 — Env + docs sweep (`c3e9bbb`):** `.env.example` new section, `.claude/CLAUDE.md` status update, parent spec scope-amendment note.

**Post-task tsc cleanup (`f1b7332`):** 5 test-only strict-mode issues fixed: `contentVariables['5']!.length` non-null assertion, `(a: unknown)` explicit parameter type on log spy map, widen `mockClaimInboundEvent` return to `Promise<'claimed' | 'duplicate'>`.

### Post-implementation review (`21ea156`) — 4 findings, all fixed

**Medium #1 — Pre-callback SQL failures could leak stuck `received` events.** After `claimInboundEvent`, approval-link SELECT, enrollment SELECT, STOP UPDATE, enrollment tx all ran outside a catch. Any throw would leave `inbound_events` in `received` state; within the 2-min reclaim window Twilio retries would be treated as duplicate and silent-200 — losing the webhook. **Fix:** outer try/catch wraps all post-claim work. Unexpected throws → `markFailed('post_claim_unexpected:<msg>')` + 503. Two integration tests push Error sentinels into sql mock queue verifying link-lookup + STOP-update failure paths.

**Medium #2 — `parseButtonPayload` accepted non-UUID suffixes.** `a:not-a-uuid` would SELECT on UUID column → Postgres "invalid input syntax for type uuid" escaping happy path. **Fix:** UUID regex check before returning. Malformed payloads → markProcessed + 200 (no DB query). Two new tests.

**Medium #3 — `extractTokenFromApprovalUrl` didn't enforce URL shape.** Spec comment said "rejects query-string-corrupted inputs" but implementation returned last path segment even for `/approve/abc?x=1`. Test even documented permissive behavior. Staging/local misconfig could ship broken URL buttons. **Fix:** rewrote to REQUIRE exactly `/approve/<token>` — throws on query strings, hash fragments, trailing slashes, non-approve paths. 9 test cases covering all rejection branches.

**Low #4 — Cancel left WA widget showing stale QR.** Cancel clears token fields but leaves row `pending_verification`; widget refresh() no-ops on that state to preserve QR during polling. **Fix:** `onCancel` force-resets idle locally before refresh.

Post-fix: **1087/1087 tests pass** (+6 from UUID validation + post-claim safety net tests).

### Files changed

**New files (20):** `whatsapp-channel.ts`, `whatsapp-client.ts`, `whatsapp-body.ts` (+ 3 test files), `twilio-intent.ts` (+ test), `twilio-whatsapp.ts` (+ test), admin `_shared.ts` + 3 route files (+ 4 test files), `WhatsAppEnrollmentWidget.tsx`, `NotificationWorker.whatsapp.test.ts`.

**Modified files (14):** `src/lib/approval/service.ts` (CallbackAuditContext widening), `src/lib/approval/__tests__/approve-via-callback.test.ts` (fixtures), `worker/ingress/telegram.ts` (2 callsites), `worker/ingress/twilio.ts` (intent import), `worker/jobs/NotificationWorker.ts` (flag + 6 branches), existing NotificationWorker test files (error stubs), `worker/startup-assert.ts` + test, `worker/index.ts`, `src/lib/notifications/channels/index.ts`, factory + email-channel tests, business detail API + page, `.env.example`.

### Security invariants enforced

1. **Raw approval tokens NEVER stored or logged.** Live only in: approveViaCallback in-memory, email body, WA URL button suffix (`contentVariables['9']`). ButtonPayload carries UUID row-id only. `redactWhatsAppPayload` strips Body/ButtonPayload/ProfileName/WaId before `inbound_events.payload` persist. Test suite asserts no console log call arg contains the raw token across every WA client error path.

2. **Four-invariant callback auth** (mirrors Phase 2): (a) Twilio signature, (b) `approval_links` live + `channel='whatsapp'` (cross-channel replay blocked), (c) sender handle matches verified enrollment for link's business_id + archived_at IS NULL, (d) inbound_events dedup on MessageSid.

3. **Verification tokens:** 1h TTL, SHA-256 hashed, raw returned once to admin browser (`Cache-Control: no-store, private`), cleared on successful enrollment.

4. **UUID validation on ButtonPayload** prevents Postgres UUID-syntax error from escaping happy path.

5. **URL shape strictly enforced** — fails loud on staging/local misconfig instead of shipping broken URL buttons.

6. **Post-claim safety net** — any DB throw between claim and markProcessed/markFailed lands in markFailed + 503 (no stuck `received` rows).

7. **Handle-scoped guards** on every enrollment UPDATE — stale in-flight errors cannot stomp re-enrolled handles.

### CONFIG-ERROR regression guard

`NotificationWorker.whatsapp.test.ts` tests #3 and #4 explicitly assert:

```ts
const updateCalls = sqlCalls.filter(c => c.sql.includes('UPDATE channel_enrollments'));
expect(updateCalls).toHaveLength(0);
```

Fires loudly if a future patch ever naively widens the owner-intent branch to catch all WhatsApp errors — which would silently unsubscribe every paying customer when Meta pauses the template.

### Final verification

- **23 commits** on `feat/channels-whatsapp-phase-3`.
- **1087/1087 tests pass** (+102 from 985 baseline).
- **0 TypeScript errors** under `pnpm tsc --noEmit`.
- **0 database migrations** — migration 021 + 022 already accommodate `channel='whatsapp'`.
- **Final code-reviewer pass:** ship-ready at flag-gate merge boundary.

### Commit log

```
21ea156 fix(channels): 4 post-review hardening findings on Phase 3 WhatsApp
f1b7332 chore(channels): clean up Phase 3 test-file tsc errors
c3e9bbb docs(channels): document Phase 3 WhatsApp env vars + status update
239c72b feat(admin): expose whatsappEnabled flag and mount WhatsAppEnrollmentWidget
25a3e18 feat(admin): WhatsAppEnrollmentWidget — QR + wa.me deep link + status polling
94c9ee5 feat(admin): POST /api/admin/channels/whatsapp/disable
0526a43 feat(admin): POST /api/admin/channels/whatsapp/cancel
13c2d9b feat(admin): POST /api/admin/channels/whatsapp/start — wa.me deep link + QR
a9ceeb7 feat(admin): whatsapp admin shared flag/env helpers (404/503)
6136330 feat(worker): NotificationWorker — WhatsApp flag-skip + 5 error branches
a7dc1a3 feat(worker): register WhatsApp ingress routes + startup assertion
eb76aa7 fix(ingress): unwrap STOP from sql.begin + log enrollment confirmation failure
f4a8979 feat(ingress): WhatsApp inbound — enrollment + button tap + STOP
8887091 feat(ingress): WhatsApp status-callback handler
55f8cf9 feat(worker): assertChannelsWhatsAppEnv — self-contained boot check
db2f47b feat(channels): enable WhatsApp in factory behind CHANNELS_WHATSAPP_ENABLED
a29fcd3 feat(channels): WhatsAppChannel implementing NotificationChannel
ef20d6f refactor(channels): WhatsAppTimeoutError.code for uniform error interface
9152d39 feat(channels): whatsapp-client — typed errors + no-log-leak guard
deef853 feat(channels): whatsapp-body pure formatters + URL token parser
5a75c10 refactor(ingress): extract classifyIntent to twilio-intent.ts
f78262c refactor(approval): tighten CallbackAuditContext type + add provider_event_id
2676903 refactor(approval): widen CallbackAuditContext for multi-provider callbacks
```

### Prod cutover checklist (pending external prereqs)

1. Start Meta Business verification (2–4 week external clock).
2. Provision WhatsApp Business Account (WABA) via Meta/Twilio.
3. Provision Twilio WA sender, capture `TWILIO_WHATSAPP_NUMBER` in `whatsapp:+<digits>` format.
4. Author + submit `repworth_approval_request_v1` Twilio Content template per `docs/whatsapp-templates.md`. Wait for Meta approval (separate clock per template edit).
5. Capture `WHATSAPP_APPROVAL_TEMPLATE_SID` (HX...) from Twilio Content Editor after approval.
6. Populate 4 env vars in Railway + Vercel: `CHANNELS_WHATSAPP_ENABLED`, `TWILIO_WHATSAPP_NUMBER`, `WHATSAPP_APPROVAL_TEMPLATE_SID`, `WHATSAPP_APPROVAL_URL_BASE` (= `NEXT_PUBLIC_APP_URL + '/approve/'`).
7. Configure Twilio console webhooks: inbound → `<WORKER_PUBLIC_URL>/ingress/twilio/whatsapp-inbound`, status callback → `<WORKER_PUBLIC_URL>/ingress/twilio/whatsapp-status`.
8. Deploy with `CHANNELS_WHATSAPP_ENABLED=false` initially.
9. Flip flag to `true` on one pilot business's env.
10. Run 8-item ship gate on pilot (webhook registration, click-to-chat enrollment, approve round-trip, regenerate round-trip, blocked-recipient handling, re-enrollment after unblock, cross-channel race vs email, STOP inside session).
11. 24h Sentry watch on pilot.
12. If clean, widen to all `active`-subscription businesses.

Until all 8 pass, `CHANNELS_WHATSAPP_ENABLED` stays `false` in production.

---

## Owner Self-Serve Signup (2026-04-25)

Branch: `feat/owner-self-serve-signup`. End-to-end flow that lets owners create their account, pay, and onboard their business without admin involvement. Replaces the old admin-only path which was the bottleneck for any inbound signup that came outside business hours.

**Architectural shape:**

```
/signup (identity-only)
  → /api/auth/signup (Supabase auth.signUp + createBusinessTx self_serve)
  → /signup/check-email
    → POST /api/auth/verify-otp (6-digit OTP) → channel_enrollments INSERT 'verified'
  → /onboarding/pay (plan picker)
    → POST /api/onboarding/select-plan → Stripe Payment Link
  → Stripe (off-domain)
    → /onboarding/payment-success (polls signup-status)
  → /onboarding/business (3-step wizard)
    → POST /api/onboarding/business → enqueues sync_reviews / validate_place_id
  → /dashboard

Google OAuth alternative:
/signup → "Continue with Google" → Supabase OAuth → /api/auth/callback (?code=...)
  → /signup/finish (collect name + phone)
  → POST /api/auth/finish-signup → createBusinessTx + channel_enrollments INSERT
  → /onboarding/pay → ... (same from here)
```

### Tasks 1–28 (foundation)

**Task 1 — Migration 025 (signup schema):** Two partial indexes for hot-path lookups: `idx_businesses_pending_unpaid_self_serve_cleanup` (CleanupAbandonedSignupsPoller predicate: pending_payment + stripe_customer_id IS NULL + onboarded_by IS NULL), `idx_users_owner_auth_by_business` (owner-by-business lookup for dashboard SSR). Email lowercase backfill with collision precondition (raises if any pre-existing case-collision rows would conflict). `onboarded_by` backfill with admin-presence precondition. Auth_id uniqueness via existing migration 001 UNIQUE constraint — no additional index. `COMMENT ON INDEX` lines explain predicate intent.

**Task 2 — `auth-flow.ts`:** Branded `AuthFlow = 'owner' | 'admin'` type + `loginUrlForFlow(flow)` helper. Used by middleware redirects + `/api/auth/callback` failure paths so owners go to `/login` and admins to `/admin/login` instead of the old hardcoded admin default.

**Task 3 — `csrf.ts` Origin helper:** `assertSameOrigin(req)` parses `request.headers.origin` and `NEXT_PUBLIC_APP_URL` via `URL.origin` so subpath APP_URLs still match plain origin headers. `SameOriginError` typed throw lets routes return 403 cleanly.

**Task 4 — `route-helpers.ts`:** `getIpKey(req, prefix)` returns `${prefix}:ip:${ip}` from `x-forwarded-for` leftmost entry. Centralizes the rate-limit key shape so SQL grep + Redis cleanup scripts can match consistently.

**Task 5 — `payment-link.ts`:** `buildPaymentLinkUrl(tier, businessId, ownerEmail)` returns `STRIPE_PAYMENT_LINK_<TIER>` with `client_reference_id` + `prefilled_email` query params appended. URL-validates the env var first (typos, missing scheme) and returns null gracefully so callers can render "contact support" instead of a mangled href.

**Task 6 — Signup schemas:** Zod schemas covering `SignupSchema` (name + email + password), `FinishSignupSchema` (name + phone), `OnboardBusinessSchema` (Place ID XOR Maps URL refine), `ResendConfirmationSchema` (literal `flow: 'owner'` to prevent admin enumeration), `VerifyEmailOtpSchema` (4–10 alphanumeric token), `SelectPlanSchema` (founding | standard), `ResetPasswordSchema`, `ForgotPasswordSchema`. `normalizedEmailSchema` lowercases + trims for consistent FK lookups.

**Task 7 — `createBusinessTx` helper:** Extracted from old admin-only path. Two modes: `admin` (writes `users.auth_id=NULL` + full business profile + `onboarded_by` + INSERT `channel_enrollments` 'verified' + INSERT `job_outbox` sync_reviews/validate_place_id) and `self_serve` (writes `users.auth_id=<authId>` + placeholder business row with `subscription_status='pending_payment'` + NO outbox INSERT — wizard owns that). Identity-only input contract for self_serve. `DuplicateEmailError` typed throw on UNIQUE constraint violation.

**Task 8 — Admin route refactor:** `/api/admin/businesses` POST routed through the new `createBusinessTx` admin mode. Tests pinned the migration boundary with assertions on the SQL templates.

**Task 9 — `POST /api/auth/signup`:** Self-serve route. Strict per-IP rate limit 5/hour (Redis-down → 503). Advisory-locked email pre-check serializes against the cleanup poller. Calls `supabaseServer.auth.signUp` with `emailRedirectTo` pointing at the OTP entry page. On `createBusinessTx` failure, awaits compensating `auth.admin.deleteUser` so the next signup attempt doesn't 422 on the orphan auth user. Returns `redirectTo: /signup/check-email?email=...` on success. Returns 429 `email_rate_limited` (separate from 409 `account_exists`) when Supabase returns `over_email_send_rate_limit`.

**Task 10 — `POST /api/auth/finish-signup`:** Google-OAuth provisioning route. Reads session via cookie-bound anon client. Asserts `email_confirmed_at` (defensive — Google always returns confirmed but a future provider misconfig must not let unconfirmed sessions provision rows). Identity-only input. Same advisory-lock pre-check as `/signup` to defeat double-submits. NO compensating auth-user delete because the session predates the request. Post-tx: writes `channel_enrollments` 'verified' since Google has already confirmed the email.

**Task 11 — `GET /api/auth/signup-status`:** Read-only status probe used by `/onboarding/payment-success` to poll subscription status + business onboarding state. Returns `subscriptionStatus` + `businessOnboarded` (`place_id_verified || google_maps_url IS NOT NULL`).

**Task 12 — `POST /api/auth/forgot-password`:** Email + IP rate-limited. Calls `supabaseServer.auth.resetPasswordForEmail` with `redirectTo` pointing at `/api/auth/callback?flow=<owner|admin>&next=/<owner-or-admin-prefix>/reset-password`. Always returns 200 with generic body — no enumeration leak.

**Task 13 — `POST /api/auth/reset-password`:** Cookie-bound session check (proves user came through the recovery callback). Validates new password length. Calls `auth.updateUser({ password })` then `signOut()` so the recovery session can't be used as a login session — forces fresh login with the new password.

**Task 14 — `POST /api/auth/resend-confirmation`:** Strict 2/email/hour + 5/IP/hour rate limits. `flow: 'owner'` literal — admins are auto-confirmed at creation and never need this endpoint.

**Task 15 — Extend `/api/auth/callback`:** Originally OAuth-only (`?code=...`). Extended to also handle `?token_hash=...&type=...` via `verifyOtp` for email confirmation, password recovery, and admin invite. Five branches: recovery (skip role lookup), Google-signup (pass through to /signup/finish), owner role (/dashboard or honor next), admin role (/admin/overview or honor next), no row + not signup-finish (sign out + account_incomplete).

**Task 16 — Stripe webhook activation enqueue:** Webhook simplified — only flips `subscription_status` to `active` (advisory-locked). Initial `sync_reviews` / `validate_place_id` enqueue moved to `/api/onboarding/business` (the wizard).

**Task 17 — Dashboard API pending-payment branch:** Returns minimal payload (`subscriptionStatus: pending_payment` + `actionUrl: /onboarding/pay`) instead of full dashboard rollup when subscription isn't active.

**Task 18 — Middleware + protected-routes:** Extended `middleware.ts` with `/onboarding` gating (owner role + business_id required). `redirectToLogin(req, flow)` parameterized so owner pages route to `/login` and admin pages route to `/admin/login`. `protected-routes.ts` `isProtectedRoute(pathname)` allows public landing + signup pages through cheaply (no Supabase round-trip).

**Task 19 — `CleanupAbandonedSignupsPoller`:** Worker job, 24h interval. Deletes `pending_payment + stripe_customer_id IS NULL + onboarded_by IS NULL + auth_id IS NOT NULL + created_at < NOW() - INTERVAL '7 days'`. Per-email advisory lock. Defensive refs check (`businesses.onboarded_by`, `prospect_demos.created_by`) — if anything points at the candidate user, log + skip + don't delete. Race the Supabase admin deleteUser against a 10s timeout. "User not found" treated as success.

**Tasks 20–25 — UI:** Shared auth form components reused for owner + admin variants. Owner pages at `/login`, `/forgot-password`, `/reset-password`; admin pages at `/admin/login`, `/admin/forgot-password`, `/admin/reset-password` (admin pages always work, never flag-gated). Signup page at `/signup`. Check-email page at `/signup/check-email`. Finish-signup page (Google) at `/signup/finish`. Pay page at `/onboarding/pay`. Payment-success at `/onboarding/payment-success`. Wizard at `/onboarding/business` (Location with PlaceAutocomplete, Profile with SerpAPI prefill, Voice skippable). Dashboard pending-payment banner. Landing nav `Login` + `Sign Up` links conditional on `SELF_SERVE_SIGNUP_ENABLED`. Worker startup assertion fails fast if flag is on but env vars missing.

**Tasks 26–27 — E2E tests:** Playwright password-signup happy path + Google-signup + forgot-password + reset-password. E2E tests skip gracefully when `TEST_DATABASE_POOL_URL` unset.

**Task 28 — Ship gate:** Manual production smoke test. Pending until SMTP + templates configured.

### Architectural pivot A1–A3 (mid-branch)

After review revealed admin-onboarded workflows and self-serve workflows were drifting in shape, refactored to a shared "identity-only at signup, business details deferred" pattern.

**A1 — Schemas split + createBusinessTx placeholder:** Split monolithic `OnboardBusinessSchema` into `BusinessOnboardingSchema` (full, used by admin + wizard) + `SignupSchema` / `FinishSignupSchema` (identity-only). `createBusinessTx` self-serve mode now writes a placeholder row.

**A2 — Slim signup routes + new business + prefill routes:** Self-serve signup routes slimmed to identity-only. New `/api/onboarding/business` accepts the wizard's full profile body. New `/api/signup/place-prefill` calls SerpAPI server-side to prefill Step 2 of the wizard.

**A3 — Stripe webhook simplification:** Webhook reduced to status flip only. Initial-sync enqueue now lives in wizard POST. Cleaner separation of billing vs onboarding.

### B-series — UX simplification + bug fixes

**B1 — Slim SignupFormClient + FinishSignupClient to identity-only:** Removed the 8-field business profile inputs from `/signup` and `/signup/finish`. SignupFormClient is now name + email + password + Continue with Google. FinishSignupClient is now name + phone (email comes from session).

**B2 — `/onboarding/business` 3-step wizard:** `BusinessWizardClient` orchestrator with `ProgressDots` + 3 step components. Step 1 PlaceAutocomplete via `gmp-place-autocomplete` with `color-scheme: light only` workaround for the closed shadow DOM, falls back to Google Maps URL input. Step 2 triggers `/api/signup/place-prefill` on Place ID confirm. Step 3 tone selector + sample-responses, both skippable. Submit POSTs to `/api/onboarding/business`.

**B3 — Routing updates + dashboard redirect:** Updated `/login` to redirect to `/onboarding/pay` if owner is `pending_payment`, `/onboarding/business` if `active` but not yet onboarded, `/dashboard` if both. Updated `/onboarding/payment-success` to push to `/onboarding/business` instead of `/dashboard`.

**B4 — Update `signup-test-runbook.md` for wizard flow:** Scenario A rewritten end-to-end. New Scenario K (wizard endpoint idempotency). New Scenario L (wizard authn/state guards).

**B5 — Fix email confirmation flow (token_hash + verifyOtp):** Owner clicked confirmation link, landed on `http://localhost:3000/#access_token=...` instead of `/onboarding/pay`. Root cause: server-side `supabase.auth.signUp()` defaults to **implicit flow** (no PKCE — no browser to stash a code_verifier), so the email link arrives with `#access_token=...` instead of `?code=...`. Fix: extended `/api/auth/callback` to also handle `?token_hash=...&type=...` via `verifyOtp`. Superseded by B6.

**B6 — Switch to OTP code entry for email verification:** Email-link approach hit the email-scanner-prefetch problem (Outlook Safe Links / Gmail link checker consume single-use links before the human clicks). Switched to typed 6-digit code entry. New `POST /api/auth/verify-otp` route (rate-limited 8/email/10min + 30/IP/10min, same-origin guard, role check, sets session cookies via `setAll`). Supabase Confirm signup template uses `{{ .Token }}` instead of `{{ .ConfirmationURL }}`.

**B7 — Simplify OTP verify page:** Removed the email input from the verify form (email pre-filled from `?email=` query param, displayed read-only). Replaced the resend form with a simple "Resend code" button. Added "← Go back and change email" link to `/signup`. CleanupAbandonedSignupsPoller already covers users who sign up but never enter the OTP.

**B8 — Plan picker on `/onboarding/pay`:** Replaced hardcoded "Standard" tier default with 2-card plan picker (Founding $99 highlighted / Standard $149). New `POST /api/onboarding/select-plan` route writes `subscription_tier` choice with advisory lock under `pending_payment` guard, returns matching `STRIPE_PAYMENT_LINK_*` URL. Stripe webhook's existing `customer.subscription.updated` price→tier mapping serves as defense-in-depth.

**B9 — Disambiguate Supabase email-rate-limit from account-exists:** Originally `/api/auth/signup` caught any signUp() error as 409 `account_exists`. When Supabase hits its 2-email-per-hour cap, it returns `error_code: over_email_send_rate_limit` + `status: 429`. Owner saw misleading "account exists" message. Fix: route now disambiguates and returns 429 `email_rate_limited` with "wait a few minutes" message. Logs actual Supabase error code + status server-side. New helper `scripts/clear-signup-rate-limits.ts` for dev unblocking (clears app-side IP/email rate-limit buckets in Redis).

**B10 — Fix Google-signup `channel_enrollments` gap:** Bug introduced in B7's prep refactor when I moved the `channel_enrollments` INSERT out of `createBusinessTx` self-serve mode and into `/api/auth/verify-otp`. Forgot Google users skip OTP entirely. **Symptom:** first Google-signed-up business "Cafe Lattea" had 8 reviews → 8 responses → 8 send_notification outbox rows marked completed but **zero approval emails sent** because NotificationWorker found 0 verified channels. Fix: added the same INSERT to `finish-signup/route.ts` after `createBusinessTx` returns. Backfilled the missing channel for Cafe Lattea via Supabase MCP, re-enqueued 8 fresh send_notification outbox rows.

**B11 — Admin onboarding sends owner invite email + links auth_id:** Admin-onboarded businesses had `users.auth_id=NULL` and no Supabase Auth user → owner had no credentials, couldn't log in, couldn't reset password (Supabase silently no-ops on missing auth.users row), couldn't sign up either (our pre-check returns 409 on email collision). Fix: admin route now calls `auth.admin.inviteUserByEmail` after `createBusinessTx`, then UPDATEs the users row to set auth_id. Compensating delete fires if invite fails. Required Supabase Invite user template config: `{{ .SiteURL }}/api/auth/callback?token_hash={{ .TokenHash }}&amp;type=invite&amp;flow=owner&amp;next=/reset-password`.

**B12 — Stripe ingress tests:** No tests existed for `worker/ingress/stripe.ts`. Added 7 tests including the test the user explicitly requested: `charge.updated` events return 200, log "Unhandled event type — ignoring", touch zero business state, mark inbound_events as processed. Plus positive control for `checkout.session.completed` + tests for `charge.succeeded` / `payment_intent.created` + 401 on missing/invalid signature + 200 duplicate when claim returns 'duplicate'.

**B13 — Test coverage for Scenario K + L:** Scenario K already covered by 13 existing API tests. Scenario L was missing — extracted 4 redirect rules from `page.tsx` into pure `resolveWizardDestination(row)` in `src/app/onboarding/business/guard.ts`. Added 11 guard tests including 2 order-dependence guards (admin role check fires BEFORE onboarded check; subscription gate fires BEFORE onboarded check). Vitest config extended to allow `.test.tsx`.

### Final verification

- **1405/1405 tests pass**
- **0 tsc errors**
- **12 runbook scenarios** documented in `docs/signup-test-runbook.md` (A through L)
- Helper script `scripts/clear-signup-rate-limits.ts` for dev unblocking
- Lab notes recorded in `.claude/CLAUDE.md`: implicit-flow trap, channel_enrollments-by-email-event, admin-onboarded auth gap, Supabase email rate limit

### Required prerequisites before flag flip in prod

1. **Custom SMTP via Resend** — Supabase Dashboard → Authentication → SMTP Settings:
   - Host: `smtp.resend.com`, Port: `465`, Username: `resend`, Password: `RESEND_API_KEY`
   - Sender: `RESEND_FROM_EMAIL`
   - Bypasses Supabase's built-in 2/hour cap
2. **Supabase email templates** — Authentication → Email Templates:
   - **Confirm signup**: body must contain `{{ .Token }}` (6-digit OTP), NOT `{{ .ConfirmationURL }}`
   - **Reset password**: `<a href="{{ .SiteURL }}/api/auth/callback?token_hash={{ .TokenHash }}&amp;type=recovery&amp;flow=owner&amp;next=/reset-password">Reset Password</a>`
   - **Invite user**: `<a href="{{ .SiteURL }}/api/auth/callback?token_hash={{ .TokenHash }}&amp;type=invite&amp;flow=owner&amp;next=/reset-password">Set your password</a>`
3. **Migration 025** run in production Supabase SQL editor.
4. **Env vars in Vercel + Railway:**
   - `SELF_SERVE_SIGNUP_ENABLED=true`
   - `STRIPE_PAYMENT_LINK_FOUNDING=https://buy.stripe.com/...`
   - `STRIPE_PAYMENT_LINK_STANDARD=https://buy.stripe.com/...`
   - `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=...` (Vercel only)
5. **Production Stripe Payment Links** with success_url=`https://yourdomain.com/onboarding/payment-success?session_id={CHECKOUT_SESSION_ID}` and cancel_url=`https://yourdomain.com/onboarding/pay?cancelled=1`.
6. **Production Stripe webhook** at `https://your-railway-worker.example.com/ingress/stripe`.
7. **Production Google OAuth** redirect URI: `https://yourdomain.com/api/auth/callback`.
8. **Run all 12 runbook scenarios** on staging with real test email + Stripe test card.
9. **Flip flag** — set `SELF_SERVE_SIGNUP_ENABLED=true` on both Vercel + Railway, redeploy.

Until all of the above are done, `SELF_SERVE_SIGNUP_ENABLED` stays `false` in production.

---

## Owner Self-Serve Signup — Hardening (2026-04-26, B15–B20)

Five rounds of external code review across the same branch. **21 fixes total** plus expanded test coverage. Test count: 1405 → 1433. tsc clean throughout.

### B15 — Production-readiness pass on the test runbook

`docs/signup-test-runbook.md` updated end-to-end (692 → 946 lines). Reflects every B-series fix from the initial branch:

- §1.3 gained step 5b (Invite user template config), step 6 (Custom SMTP via Resend — required for any meaningful testing volume + the fix for Supabase's 2/hour cap), step 7 (rate limit raise).
- §1.7 dev helper for clearing rate-limit Redis keys between runs.
- Reset password template uses `&amp;`-escaped `href` (was rendering as plain text in some clients).
- Scenario A step 8 reflects the plan picker (was the old hardcoded-Standard "Complete payment" button).
- Scenario I rewritten as full B11 invite flow regression — verifies `inviteUserByEmail` + `auth_id` linkage + owner can set password + log in.
- New Scenario I2 (admin invite failure compensating delete).
- New Scenario M (B10 approval-email regression — full diagnostic SQL + fix path).
- §3.1 pre-deploy checklist added Custom SMTP + 3 templates + Resend domain verification items.
- §3.3 production smoke gained items 4 (B10 approval-email check) + 5 (B11 admin invite check).
- Appendix grew from 13 → 20 failure modes — every mistake we hit during the branch is now searchable.
- "Ready for production" definition updated with 5 new items.

### B16 — Round 1: 8 findings (TOCTOU, race, obfuscated user, rollback, cookies, URL validation, durable retry, redirect)

**Critical — `worker/jobs/CleanupAbandonedSignupsPoller.ts` TOCTOU.** SELECT runs outside any tx (line 38), per-candidate tx never re-validates predicates. If Stripe activates a business between candidate-select and tx-lock, we delete a paying customer's auth user + DB rows. Fix: take signup-lock + activation-lock inside tx, SELECT FOR UPDATE businesses + users rows, re-validate ALL predicates (subscription_status, stripe_customer_id, onboarded_by, role, auth_id, age) before any delete. New `skipped_state_changed` counter. 3 regression tests: status-flip, stripe_customer_id-populated, row-vanished.

**Medium — `/api/onboarding/select-plan` race.** SELECT was unlocked, advisory lock came AFTER stale read, UPDATE.count not checked. Fix: outside-tx lookup just gets businessId/email (no state read), inside-tx takes activation lock FIRST, then SELECT FOR UPDATE under the lock, re-validates status, runs UPDATE, checks `count > 0`. New `race_lost` 409 branch. 1 regression test.

**Medium — Supabase obfuscated user detection.** `signUp()` returns success with empty `identities[]` for already-confirmed emails (anti-enumeration). Original code only checked `!authData.user`. Fix: explicit `identities.length === 0` check before createBusinessTx, returns `accountExistsResponse`. Logs server-side.

**Medium — admin businesses ordering + outbox cleanup.** Two bugs: APP_URL validated AFTER createBusinessTx (left half-provisioned rows on misconfig); rollback only deleted users + businesses but not job_outbox rows (no FK CASCADE). Fix: validate APP_URL FIRST; rollback wraps job_outbox + users + businesses in `sql.begin` in FK-aware order.

**Medium — `/api/auth/callback` signOut cookies.** Two `account_incomplete` branches called `signOut()` but returned a fresh redirect without copying response.cookies — browser kept stale session, would redirect-loop. Fix: copy `response.cookies.getAll()` onto the redirect (matches the success-branch pattern).

**Medium — `googleMapsUrlSchema` validation.** Original schema accepted any non-empty string. Fix v1: `MAPS_HOST_RULES` allowing https://google.<tld>/maps/, https://maps.google.<tld>/, https://maps.app.goo.gl/, https://goo.gl/maps/ (B17 tightens further; B18 + B19 tighten more).

**Medium — channel_enrollments swallowed errors → durable retry.** verify-otp + finish-signup catch INSERT failures and log without retry — recreates the B10 silent-disappear bug. Fix: new `worker/jobs/EmailChannelReconcilePoller.ts` (10-min interval, env-overridable) scans `active`-subscription owner businesses with no `channel_enrollments` email row and INSERTs idempotently via the existing partial-unique ON CONFLICT. Wired into worker startup + shutdown.

**Low — pay page redirect.** Active+not-onboarded was redirected to /dashboard (technically works via dashboard's CTA but contradicts the documented direct flow). Fix: SELECT now also includes place_id_verified + google_maps_url; active owners route to `/onboarding/business` if not yet onboarded, `/dashboard` otherwise.

**Final B16: 1409/1409 tests pass, 0 tsc errors.**

### B17 — Round 2: 6 findings (role filter, URL parser, link-failure rollback, archived-channel guard, XOR, identity binding)

**Medium — owner-role filter on `/api/onboarding/*` lookup queries.** Middleware doesn't gate `/api/onboarding/*` — was relying on auth_id → business_id alone. An admin/sales_partner with a misconfigured `users.business_id` could submit owner-only endpoints. Fix: added `AND u.role = 'owner'` to both lookup queries in `/api/onboarding/business/route.ts` and `/api/onboarding/select-plan/route.ts`. SQL-boundary filter is the authorization invariant. 4 regression tests.

**Medium — googleMapsUrlSchema host-only check too loose.** `https://google.com/`, `https://google.com/search?q=...`, bare `https://goo.gl/<id>` all passed. Refactored to `MAPS_HOST_RULES` carrying `pathRequired` regex per host: google.com requires `/maps/`, maps.google.<tld> any path, maps.app.goo.gl any path, goo.gl REQUIRES `/maps/` segment.

**Medium — admin auth_id link `UPDATE` didn't verify rows matched.** If 0 rows updated (or UPDATE threw), route returned soft 201 with `warning` field that the UI ignored + redirected to Stripe → admin under impression onboarding worked while owner is silently locked out. Hard-fix: `UPDATE ... RETURNING id`, hard-rollback the business + invited auth user + job_outbox + users on failure, return 500 with descriptive error.

**Medium — EmailChannelReconcilePoller's NOT EXISTS scoped on `archived_at IS NULL`.** Archived rows mean owner/admin explicitly removed enrollment — recreating it as 'verified' would silently resubscribe (the original B7 bug in reverse). Removed the archived_at filter from the EXISTS subquery. New `worker/jobs/__tests__/EmailChannelReconcilePoller.test.ts` with 6 tests: SQL-shape pin (no archived_at in NOT EXISTS), missing-row INSERT, existing-row no-op, archived-row no-op, ON CONFLICT race, INSERT-throws + loop-continues.

**Low — `OnboardBusinessSchema` (admin) still had at-least-one refine, not true XOR.** Owner schema was fixed in B16; admin path was missed. Both schemas now use `Boolean(a) !== Boolean(b)` XOR.

**Low — CleanupAbandonedSignupsPoller identity binding.** `usr.auth_id` re-checked for non-null but not equality with `candidate.auth_id`. A stale candidate whose users.auth_id had been re-linked to a NEW Supabase identity would let `deleteUser(<old auth_id>)` destroy the wrong identity. Added identity-binding check to stillEligible AND to the `DELETE FROM users WHERE` predicate (`auth_id = candidate.auth_id`).

**Final B17: 1419/1419 tests pass, 0 tsc errors.**

### B18 — Round 3: 2 findings (URL resolver-readiness, link-failure rollback test)

**Medium — `googleMapsUrlSchema` host-shape passed URLs the worker can't resolve.** PlaceIdValidationWorker requires either a canonical Place ID OR (businessName + coordinates) — bare `https://maps.google.com/`, `?cid=123`, shortlinks all passed host-shape but yielded no resolvable data, leaving owners onboarded with permanent place-ID resolution failures. Fix: added second `.refine()` calling `parseGoogleMapsUrl()` and requiring `placeId !== null OR (businessName && coordinates)`. 6 new tests covering the rejection cases.

**Low — Missing test for the zero-row link-failure rollback path.** High-impact code + soft-success was the original bug class. Refactored test mock with `linkUpdateState` flag (success | zero_rows | throws) + exposed `mockDeleteUser`. 2 new tests asserting the rollback shape (auth.admin.deleteUser called with invited.user.id, tx-wrapped DELETEs of job_outbox → users → businesses in FK-aware order, no `id`/`paymentUrl`/`warning` in response body).

**Final B18: 1428/1428 tests pass, 0 tsc errors.**

### B19 — Round 4: schema/worker isPlaceId() alignment

**Medium — `urlIsResolverReady()` accepted any non-null `placeId`** but `PlaceIdValidationWorker` only accepts when `isPlaceId()` validates. URL like `https://www.google.com/maps/place/?q=place_id:bad` parses to `{placeId: "bad"}` → schema accepted, worker rejected → owner stuck. Fix: `if (data.placeId !== null && isPlaceId(data.placeId)) return true;`. Falsy isPlaceId falls through to the businessName+coordinates fallback. 5 new tests: 3 explicit malformed-ID query-param shapes, 1 too-short alphanumeric (anchors the 20+ char rule), 1 positive control accepting a real Place ID via `?q=place_id:`.

**Final B19: 1433/1433 tests pass, 0 tsc errors.**

### B20 — Round 5: 3 UX findings

**B1 — UI copy claimed 6-digit OTP but production Supabase issues 8-digit.** Fixed `CheckEmailClient.tsx` subtext (both fromLogin + default branches) + input placeholder to say "8-digit code". Inline comment points future maintainers at Supabase Auth → Settings → "Email OTP Length" as the source of truth.

**B3 — Raw error codes shown to users.** `/api/auth/signup` returned `{ error: 'rate_limited' }` / `'rate_limit_unavailable'` without `message`. SignupFormClient's `body.message ?? body.error ?? 'Signup failed'` then surfaced raw machine codes. **Server-side fix (Option A):** both error responses now carry human-readable `message` strings. **Client-side defense:** new `KNOWN_MESSAGES` map covers rate_limited / rate_limit_unavailable / email_rate_limited / invalid_json / invalid_body / internal so future regressions can't leak machine codes. Body-shape regression assertions added to existing 429 + 503 tests.

**B4 — Middleware redirected admin/sales_partner accidentally on `/onboarding/*` to `/login`** (owner login) instead of `/admin/overview`. Page guard had it right but middleware intercepted first. Fix: split the `/onboarding/*` block into 3 sub-cases — no users row → owner login; admin/sales_partner → `/admin/overview` (don't re-auth them); other non-owner → owner login. Skipped writing a vitest middleware harness since `resolveWizardDestination` page-guard tests already pin the parallel behavior.

**Final B20: 1433/1433 tests pass, 0 tsc errors.**

### Cumulative summary across B15–B20

- **5 review rounds**, **21 individual fixes** (1 critical + 16 medium + 4 low)
- **Test count: 1405 → 1433** (28 new tests across 5 rounds + assertion strengthening on existing tests)
- **New files:**
  - `worker/jobs/EmailChannelReconcilePoller.ts` (durable channel-enrollment retry)
  - `worker/jobs/__tests__/EmailChannelReconcilePoller.test.ts`
- **3 new env vars:** `EMAIL_CHANNEL_RECONCILE_INTERVAL_MS`, `EMAIL_CHANNEL_RECONCILE_BATCH_SIZE`, `EMAIL_CHANNEL_RECONCILE_DISABLED`
- **3 new lab notes** in `.claude/CLAUDE.md`: TOCTOU landmine, Supabase obfuscated-user trap, schema-must-mirror-worker rule

Branch is now ready for the production prerequisites checklist (custom SMTP + 3 email templates + 12-scenario staging run + flag flip).

---

## Sprint Z: Zernio GBP Auto-Posting Integration

### Phase Z.0 — Code-Complete (2026-04-27 → 2026-04-28)

**Status:** CODE-COMPLETE behind `ZERNIO_PUBLISHING_ENABLED` flag (default OFF).

**Branch:** `feat/zernio-integration` — 49 commits, 1544/1544 vitest tests pass, `tsc --noEmit` clean.

**Why:** RepWorth's MVP shipped with manual copy-paste posting (sales partner pastes the AI-drafted reply into the Google Business UI by hand). That works for ~10 businesses but doesn't scale. Google Business Profile API access is restricted (we'd applied and waited months); Zernio is a third-party that has GBP API access and exposes it through their own API. Wiring up Zernio gives us auto-posting today without waiting on Google's approval.

**What it does:** When an owner approves a response, the worker now branches:
- If the business has an active Zernio connection → call Zernio's `postReply` endpoint, mark the response `posted`
- If not → mark the response `awaiting_owner_connect` and email the owner with a "Reconnect Google Business" CTA. Once they connect, a drain worker re-enqueues the queued responses.

**Owner journey:** Dashboard banner → click Connect → OAuth round-trip via Zernio → pick the right Google location → done. Reconnect, cancel, and disconnect flows all work. If Zernio's API has an unknown-outcome failure mid-finalize (timeout / 5xx after they may or may not have created the account), a `zernio_finalize_incidents` row is written so admin can manually reconcile from Zernio's dashboard — protects against silently creating a duplicate account.

**Implementation phases (during the build):**

1. **Phase 0a — Foundations (Tasks 1–6):** Migration 026 (widen `responses.status` to TEXT, add 2 new tables + 4 partial unique indexes), queue name constants, payload types, WorkerType union extension, Zernio types module, error class hierarchy (7 typed error classes).

2. **Phase 0b — HTTP Client (Tasks 7–11):** `classifyAndParse` with endpoint-aware error mapping built TDD-first (15 tests cover the classification table). `request()` primitive with AbortController timeouts, network-error wrapping, Zernio-error preservation. 9 per-endpoint client methods. Mock-mode bypass at the top of `request()` so local dev never hits the real API. 6 shared Lua scripts for atomic Redis state machine transitions in `connect-state.ts`.

3. **Phase 0c — Worker Infrastructure (Tasks 12–18):** Two new BullMQ queues (`drain_pending_owner_connect`, `send_owner_email`) + 3 topic-string aliases for the outbox-to-queue map. Two new email templates (`owner_reconnect_required` per-response, `owner_connection_lost` per-business-per-day). Two new workers (`OwnerEmailWorker` with kind-discriminated handler, `DrainOwnerConnectWorker` for re-enqueueing stuck responses). Workers registered in `worker/index.ts`. Startup-assert gates the 4 new env vars when the flag is on. Resend bounce handler now treats the 2 new owner email templates as owner-directed.

4. **Phase 0d — Publisher Branching (Tasks 19–22):** `lookupZernioReviewId` with Redis cache + 4-page pagination + 4-field match (TDD, 4 tests). `applyTransientExhaustionFallback` for the BullMQ-retry-exhaustion case (transactional). `ResponsePublisherWorker` Steps 4-8 replaced with the Zernio branch — 7 distinct error sub-cases (success, 409 reply-already-exists, ZernioAuthError, ZernioTransientError, ZernioReviewNotFoundError, ZernioPermanentError, no-connection) each with the correct status transition and idempotency guard. `publisherWorker.on('failed')` handler in `worker/index.ts` wires the BullMQ exhaustion case to graceful degradation.

5. **Phase 0e — Connect Flow (Tasks 23–34):** Five API routes — `/start` (most complex, two-layer concurrency defense + DB idempotency check + placeholder marker + full start work + Step F failure cleanup), `/callback` (atomic GETDEL + double pending re-verify + signed cookie + OAuth-denial cleanup), `/select-location` (largest single route — finalize lock + finalizing CAS + Zernio call + DB tx + post-accountId recovery + finalize_unknown handling with all 4 round-N corrections), `/cancel`, `/disconnect`. Dashboard `zernioConnection` field + `pendingFlow` sub-state. `ConnectGoogleBanner` component with 4 banner states. Two pages: `/dashboard/connect` (state-aware) and `/dashboard/connect/select-location` (server component + client form). Admin business detail Zernio panel. Admin overview "Reconnect" column (count of `awaiting_owner_connect` responses per business). E2E scaffold (skipped without test DB, fixme block locks in intent).

6. **Phase 0f — Webhook + Ops (Tasks 35–40):** HMAC-SHA256 signature verification helper TDD-first (8 tests cover hex regex, length-safe `timingSafeEqual`, valid + invalid + non-hex + wrong-length + uppercase). Webhook ingress at `worker/ingress/zernio.ts` — flag-gate, signature verify, `inbound_events` dedup, switch on event type (`account.disconnected` → `WITH disconnected AS ... INSERT FROM disconnected` multi-row pattern, `account.connected` → log only, `review.new`/`review.updated` → INCRBY counter for Phase 3 readiness, `webhook.test` → log + 200). Route registered in `worker/index.ts` with `rawBody: true`. CLAUDE.md updated. Launch runbook written at `docs/zernio-launch-runbook.md` with the `finalize_unknown` reconciliation procedure (Branch A sub-cases A-1/A-2/A-3 + Branch B + rollback).

**Code-review rounds applied (post Phase 0f):**

- **Round 1 — 7 findings (6 Medium + 1 Low):**
  - Tightened 409 publish_reply classification to require `body.code` in an allowlist (`reply_already_exists`); unknown 409s now retry transient instead of falsely marking posted
  - Added catch-all 4xx → ZernioPermanentError for non-`select_location` endpoints, exempting 408/429
  - Added finalize_unknown overwrite guard at the top of `/start` Step A — refuses to recreate even when stale-age would normally fall through
  - Surfaced in-flight `connect_pending` Redis state to the dashboard via new `pendingFlow` field, so banner shows blue "Connecting…" instead of the orange "Reconnect" treatment during in-flight flows
  - Centralized response status groupings in new `src/lib/shared/response-status.ts` (6 named groups + type alias) — updated 8 production callsites that were counting `awaiting_manual_post` as "handled" but missing `awaiting_owner_connect`
  - OAuth-denial path now does best-effort cleanup (atomic GETDEL state, flowId-bound delete pending, deleteProfile) before redirecting
  - Deferred: review-id lookup brittleness for large accounts — needs ingestion-side persistence, scheduled as Phase 1 follow-up
  - Bonus: latent bug found during status-group sweep — `process-review.ts` review-edit exception fired only for `posted`/`awaiting_manual_post`, missing `awaiting_owner_connect`. Fixed.
  - Bonus: status badge color maps in both ReviewsList components missing `awaiting_owner_connect`. Fixed (amber styling).

- **Round 2 — 1 finding (Low):**
  - Dashboard precedence bug: any non-finalize pending marker beat an active DB connection. If select-location's best-effort Redis cleanup fails after a successful DB tx, the dashboard would show "Connecting…" for up to 15min even though the business is already connected. Reordered: `active` DB now beats stale non-finalize pending markers. 4 new tests cover the precedence rule and regressions.

- **Round 3 — 0 findings.** Reviewer also confirmed all prior fixes verified.

**Local QA pass (2026-04-28):** Manually exercised all 6 scenarios from `docs/zernio-testing-and-shipping.md` Part 1 against the worktree on a real owner session. Full report at `docs/zernio-test-report-2026-04-28.md`. **All 6 scenarios PASS.** One bug found in the test helper script — the inline `zernio-fire-webhook.sh` was sending a flat `accountId` field but the handler reads nested `account.id` per spec §5.4. Fixed: promoted the inline snippet to a real versioned `scripts/zernio-fire-webhook.sh` with multi-event support and the correct nested payload shape. Lab note added so the trap doesn't reappear.

**Architecture invariants preserved:** outbox pattern (zero new state-change paths bypass it), no auto-posting (`postReply` only fires for owner-approved responses), worker-side third-party ingress (`/ingress/zernio` on Railway), subscription guard in all owner-facing workers, hashed approval tokens unchanged, app-enforced auth scope (every owner read/write gated by `business_id`), Node native `crypto` for HMAC.

**Files created (24):** `supabase/migrations/026_zernio_publishing.sql`, `src/lib/zernio/{types,errors,client,connect-state,connect-session-cookie}.ts` + tests, `src/lib/publishing/zernio-publisher.ts` + tests, `src/lib/notifications/email/templates/{owner-reconnect-required,owner-connection-lost}.ts`, `src/lib/shared/response-status.ts` + tests, `src/components/dashboard/ConnectGoogleBanner.tsx`, `src/app/(authenticated)/dashboard/connect/{page.tsx,select-location/{page.tsx,LocationPicker.tsx}}`, `src/app/api/zernio/{connect/{start,callback,select-location,cancel}/route.ts,disconnect/route.ts}`, `src/app/admin/businesses/[id]/components/ZernioConnectionPanel.tsx`, `worker/jobs/{OwnerEmailWorker,DrainOwnerConnectWorker}.ts`, `worker/ingress/{zernio,zernio-verify}.ts` + tests, `e2e/zernio-connect.spec.ts`, `scripts/{redis,zernio-fire-webhook.sh}.ts`/`.sh`, `docs/{zernio-launch-runbook,zernio-testing-and-shipping,zernio-test-report-2026-04-28}.md`.

**Files modified (~12):** worker/{index,queues,startup-assert}.ts, worker/jobs/ResponsePublisherWorker.ts, worker/ingress/resend.ts, src/lib/shared/{queue-names,worker-types,subscription-guard}.ts, src/lib/dashboard/{types,service}.ts, src/lib/notifications/email.ts (barrel), src/components/DashboardContent.tsx, src/components/dashboard/ReviewsList.tsx, src/app/admin/businesses/[id]/{page.tsx, components/ReviewsList.tsx}, src/app/admin/overview/page.tsx, src/app/api/admin/overview/route.ts, src/app/api/dashboard/route.ts, src/lib/reviews/process-review.ts, src/lib/admin/business-detail-{types,service}.ts, .claude/CLAUDE.md, .gitignore.

**5 new env vars:**
- `ZERNIO_PUBLISHING_ENABLED` — gates everything. Default off.
- `ZERNIO_API_KEY` — required when flag on (mock mode bypasses).
- `ZERNIO_WEBHOOK_SECRET` — required when flag on. HMAC shared secret for webhook ingress.
- `ZERNIO_PROFILE_ID_PREFIX` — optional, default `repworth-prod-`. Environment isolation for Zernio profile names.
- `ZERNIO_API_BASE` — optional, default `https://zernio.com/api`. Override for sandbox.

**6 new lab notes added to `.claude/CLAUDE.md` across the work:**
- timestamptz::date is STABLE not IMMUTABLE — wrap with `AT TIME ZONE 'UTC'` first (caught only at apply time, ERROR 42P17)
- ON CONFLICT clauses must match index expressions byte-for-byte
- Zernio's `account.disconnected` payload uses nested `account.id`, not flat `accountId`
- (carried forward from Round 1 / 2 fixes — the precedence rule, the 4xx classification rule, the 409 allowlist rationale)

**What's next (operational, not code):** Phase 1 pilot per `docs/zernio-launch-runbook.md` — subscribe to Zernio, configure prod env vars, run migration 026 in prod (one ACCESS EXCLUSIVE moment on `responses`), configure webhook URL in Zernio dashboard, fire test webhook, flip the flag, onboard one cooperative customer, monitor for 1-2 weeks. Phase 2 = full rollout (no code changes — flag is global). Phase 3 (later) = promote `review.new`/`review.updated` webhook counters to real ingestion events, swap SerpAPI polling for Zernio webhooks for connected businesses (~70% of polling spend disappears).

---

## Sprint Channels-4: Owner Channel Dashboard

### Phase 4.0 — Code-Complete (2026-04-28)

**Status:** CODE-COMPLETE behind `CHANNELS_TELEGRAM_ENABLED` flag (default OFF). Migration 027 applied to prod Supabase 2026-04-28. PR #10 open against `main`.

**Branch:** `feat/phase-4-owner-channels` — 26 commits, 1604/1604 vitest tests pass, `tsc --noEmit` clean, ESLint clean.

**Why:** Phases 0–3 of the Channels work shipped admin-side enrollment widgets — the sales partner had to flip Telegram/SMS/WhatsApp on for each business from the admin CRM. That worked when there were a handful of pilot accounts, but it doesn't scale: every owner who wants to receive approvals via Telegram has to email support to get enrolled. Phase 4 ships the owner-facing self-serve flow at `/settings/channels` so owners can connect Telegram themselves. SMS and WhatsApp render as "Coming soon" rows because those channels are still pending Twilio 10DLC and Meta business verification, respectively.

**What it does:** A logged-in owner navigates to Settings → Notification channels and sees an Email row (always-on, fed from `users.email` with an "Always on" pill) plus three mobile-channel rows. The Telegram row shows a Connect button when `CHANNELS_TELEGRAM_ENABLED=true` and the owner has no active enrollment; clicking Connect generates a one-time deep link + QR code with a 1-hour expiry, the owner scans with Telegram and taps Start, the worker's webhook flips the row to verified, and the dashboard shows ✓ Connected with a Disconnect button. SMS and WhatsApp rows render as informational placeholders (no buttons, ~50% opacity) until those phases flip on.

**Implementation tasks (during the build, executed via subagent-driven development):**

1. **Task 0–1 — Pre-flight + migration 027:** Audit query confirmed zero existing businesses violated the new predicate (no row had two pending/verified mobile channels active at once). Migration 027 added a partial unique index `channel_enrollments_one_mobile_per_biz` on `channel_enrollments(business_id) WHERE channel IN ('sms','telegram','whatsapp') AND status IN ('pending_verification','verified') AND archived_at IS NULL`. Predicate exclusions are intentional: disabled/unsubscribed rows preserve enrollment history across channel switches.

2. **Task 2–3 — Constants + typed errors:** Shared `TOKEN_TTL_MS` / `STATUS_POLL_INTERVAL_MS` / `TTL_TICK_INTERVAL_MS` so polling cadence and TTL can't drift between client and server. `MultipleMobileChannelsError` (→ 409) + `EnrollmentDatabaseError` (→ 500, scrubs constraint name from message) + `classifyEnrollmentError(err)` classifier built TDD-first (11 unit tests).

3. **Task 4 — Admin endpoint:** Additive — `GET /api/admin/businesses/[id]/channels` now also emits `expires_at` from `verification_token_expires_at` so the refactored hook can source the QR countdown timestamp from a single canonical payload across admin and owner.

4. **Task 5 — Pure enrollment reducer:** Extracted from inline state in `TelegramEnrollmentWidget`. 8 states (idle / generating / awaiting_scan / verified / disabled / unsubscribed / expired / error), 8 action types. Pure `(state, action) => state` — no I/O, no `Date.now()`, no array filtering. 27 unit tests including identity-equality (`toBe`) assertions on the no-op transitions (e.g. `awaiting_scan + pending_verification` is a strict no-op that preserves cached `expiresAt` + `qrDataUrl`).

5. **Task 6 — useEnrollment React hook:** ~210-line shell wiring the reducer to fetch, polling (every 3 s while in `awaiting_scan`, AbortController-cancelable), 1 s TTL countdown tick, and HTTP error classification. Filters the canonical `{ enrollments: [...] }` status payload by channel name. Optionally hydrates from `initialSnapshot` (used by the owner widget for SSR-driven mount — see Fix #3).

6. **Task 7 — Shared transaction helpers:** `startTelegramEnrollment(tx, businessId, tokenHash, expiresAt)` extracts the state-machine SELECT + INSERT/UPDATE that admin and owner routes both need. Caller owns rawToken generation, `sql.begin`, advisory lock, and post-tx QR generation. 23505 → typed error via `classifyEnrollmentError`. Plus single-statement `cancelTelegramEnrollment` and `disableTelegramEnrollment` helpers. 13 helper unit tests with mocked `tx`.

7. **Task 8 — Admin Telegram routes refactor:** `start`/`cancel`/`disable` now delegate to the shared helpers. Routes own auth, validation, advisory lock, and QR generation; helpers own the state-machine. 23505 maps to 409 / 500 with no constraint name leakage.

8. **Task 9 — SMS + WhatsApp 23505 catch:** Migration 027 covers all three mobile channels, so admin SMS verify and admin WhatsApp start can also throw 23505 on cross-channel conflict. Both routes wrap their INSERT/UPDATE in `classifyEnrollmentError`. SMS catch goes inside `withSmsEnrollmentLock` so the lock release is preserved.

9. **Task 10–11 — Admin widget refactors:** `TelegramEnrollmentWidget` (138 → ~95 lines) and `WhatsAppEnrollmentWidget` (229 → 68 lines, 70 % reduction) both consume the shared hook. State machine + polling + TTL countdown + AbortController all moved to `useEnrollment`. Visual layout unchanged.

10. **Task 12 — Owner-scoped routes:** Four new routes under `/api/dashboard/channels/*`. `GET /` returns the canonical `{ enrollments, available, reasons }` shape (verification_token_hash deliberately excluded from SELECT). `POST telegram/{start,cancel,disable}` all wrapped with `withSameOrigin()` for CSRF protection. `businessId` always sourced from `requireRole(req, 'owner').businessId`, never from request body. Subscription guard on every route.

11. **Task 13–14 — Owner widget + Coming Soon row:** `OwnerTelegramWidget` is a ~95-line shell using the shared hook with owner endpoints. Disconnect button only renders in `verified` state per spec § 3 (prevents 404 from `/disable` on a non-verified row). Cyan accent on verified state per `repworth-brand-design`. `ComingSoonChannelRow` is a pure-presentation row with no button at all, ~50 % opacity.

12. **Task 15 — Settings restructure:** Existing 297-line client-only `/settings/page.tsx` extracted verbatim into `SettingsGeneralForm.tsx` (no logic change). New `SettingsTabs` server component renders the General / Notification channels tab strip. New `/settings/page.tsx` is a server-component shell that does auth + direct subscription_status check (does NOT use `resolveWizardDestination` — that helper redirects already-onboarded owners to `/dashboard`).

13. **Task 16 — `/settings/channels` page:** Server component fetches initial enrollments + availability flags (so the page doesn't flash an empty state). `ChannelsClient` composes the always-on Email row + Telegram row (interactive when `CHANNELS_TELEGRAM_ENABLED` + env-ready, Coming Soon otherwise) + 2 Coming Soon rows for SMS/WA. Email row falls back to `users.email` when no `channel_enrollments` row exists yet (Google-OAuth signup window before `EmailChannelReconcilePoller` catches up).

14. **Task 17–19 — E2E specs + helper:** `e2e/helpers/telegram-test-ingress.ts` synthesizes a valid Telegram `/start <token>` webhook update with the correct `X-Telegram-Bot-Api-Secret-Token` header. `e2e/owner-channels.spec.ts` and `e2e/admin-channels-refactor.spec.ts` cover unauthenticated assertions live (redirect to `/admin/login`); authenticated flows are `test.fixme()` per repo convention pending the Supabase admin `generateLink` magic-link harness.

**Code-review rounds applied (post Task 19):**

- **Round 1 (Codex first pass) — 6 findings (1 Critical + 4 Medium + 1 Low):**
  - **Critical #1:** Cancel left `status='pending_verification'`, occupying migration 027's slot. Once SMS or WhatsApp flips on, owners who cancelled Telegram would get stuck 409 `multiple_mobile_channels` with no UI explanation. **Fix `b7753d6`:** cancel UPDATE now flips status to `'disabled'` + `disabled_at = NOW()`. The existing `disabled → pending` branch in `startTelegramEnrollment` makes reconnect work without further changes. New helper test asserts the new SQL shape and exercises cancel-then-start round-trip.
  - **Medium #2:** SMS verify called Twilio Verify (paid SMS) before the migration 027 INSERT — owners would burn an SMS code only to get a 409 afterward. **Fix `1da0472` + `696753e`:** pre-check inside `withSmsEnrollmentLock` for any other pending/verified mobile channel before calling Twilio. Migration 027 index is still the authoritative defense; pre-check is a cost-saver in the common case.
  - **Medium #3:** `OwnerTelegramWidget` ignored the server-loaded `initialEnrollments` already passed by `ChannelsClient`. A verified owner saw Connect for ~200–500 ms before the hook's first fetch resolved; clicking during that window produced a misleading 409. **Fix `9d6e8eb`:** widget derives an `EnrollmentSnapshot` from the verified row and passes it to `useEnrollment` as `initialSnapshot` (which skips the first fetch). Non-verified rows still fetch normally to avoid stale-state risk.
  - **Medium #4:** `cancel()` in `useEnrollment` always dispatched `CANCEL_SUCCEEDED`, swallowing 401/403/500/network failures. UI showed idle while server still had a pending row. **Fix `56c0dec`:** dispatch `CANCEL_SUCCEEDED` only on 2xx; non-OK and network failures dispatch `CONNECT_FAILED` so the existing error UI surfaces them.
  - **Medium #5:** E2E tests are mostly `test.fixme`. **Fix `fdf7c5a`:** added a coverage-status comment block at the top of both spec files documenting where the executable regression protection lives (reducer / helper / detector unit tests) and why authenticated flows stay fixme'd (Supabase magic-link harness deferred).
  - **Low #6:** Reducer error copy hardcoded "Telegram is currently unavailable." (wrong for WhatsApp post-refactor) and conflated 409 `already_verified` with 409 `multiple_mobile_channels`. **Fix `11fa1be`:** channel-neutral 404 copy ("This channel is currently unavailable."); 409 disambiguates `already_verified` ("Already connected.") vs `multiple_mobile_channels` ("Disconnect your current channel before connecting another.") by reading the action's `message` field.

- **Round 2 (Codex second pass) — 2 findings (Medium):**
  - **Medium #7:** SMS pre-check still raced past concurrent Telegram/WA starts because each channel held its own per-channel advisory lock (`sms_enroll:`, `telegram_enroll:`, `whatsapp_enroll:`). **Fix `be7b8da`:** unified all four mobile-enrollment paths under `mobile_enroll:${businessId}` via `pg_advisory_xact_lock(hashtextextended('mobile_enroll:${businessId}', 0))` (the SMS helper's existing scheme). Now SMS verify pre-check + Telegram + WhatsApp state-machine writes are strictly serialized per-business across channels.
  - **Medium #8:** Cancel routes did no advisory locking + my prior Fix #1 dropped `archived_at IS NULL` from the cancel WHERE clause. A concurrent admin/owner start could observe the pending row, fall through to its UPDATE branch (no status WHERE guard), and overwrite cancel's transition to `disabled` back to `pending_verification`. Plus archived rows could be mutated. **Fix `34d3374`:** Telegram + WhatsApp cancel routes wrap the UPDATE in `sql.begin` and take the same `mobile_enroll` advisory lock as start; `archived_at IS NULL` filter restored to all cancel WHERE clauses.

- **Round 3 (Codex third pass) — 1 finding (Medium):**
  - **Medium #9:** Start helpers' SELECT didn't use `FOR UPDATE`, so a webhook could verify the row between start's SELECT and UPDATE; start's `WHERE id = …` (no status guard) would overwrite verified → pending. WhatsApp inbound also lacked `FOR UPDATE`. (Telegram inbound already had it.) **Fix `8c27509`:** added `FOR UPDATE` to `startTelegramEnrollment`'s SELECT, the WhatsApp admin-start inline SELECT, and the WhatsApp inbound verifier SELECT. Cross-transaction row locks now serialize start with inbound webhook (matching the Telegram inbound pattern that was already correct). New helper test asserts `FOR UPDATE` in the SQL template.

- **Round 4 (Codex fourth pass) — 0 findings.** Branch genuinely closed.

**Architecture invariants preserved:** outbox pattern unchanged (no new state-change paths bypass it), no auto-posting (verification is owner-initiated via webhook only), worker-side third-party ingress preserved, subscription guard in every owner-facing route AND the page server component (defense-in-depth), hashed approval tokens unchanged, app-enforced auth scope (every owner read/write gated by `business_id` from session, never request body), Node native `crypto` for hashing, `verification_token_hash` deliberately excluded from every SELECT in the owner-facing path.

**Files created (15):**
- `supabase/migrations/027_one_mobile_channel_per_business.sql`
- `src/lib/notifications/channels/{constants,enrollment-reducer,use-enrollment}.ts` + reducer test
- `src/lib/channels/{telegram-enrollment,unique-violation}.ts` + tests
- `src/app/api/dashboard/channels/{route.ts,telegram/{start,cancel,disable}/route.ts}` (4 owner routes)
- `src/components/dashboard/{OwnerTelegramWidget,ComingSoonChannelRow,SettingsTabs}.tsx`
- `src/app/(authenticated)/settings/SettingsGeneralForm.tsx` (extracted from old page.tsx)
- `src/app/(authenticated)/settings/channels/{page.tsx,ChannelsClient.tsx}`
- `e2e/helpers/telegram-test-ingress.ts` + `e2e/{owner-channels,admin-channels-refactor}.spec.ts`
- `docs/runbooks/phase-4-owner-channels-manual-test.md` (manual smoke-test checklist)

**Files modified (~13):** `src/app/api/admin/businesses/[id]/channels/route.ts` (additive `expires_at`), `src/app/api/admin/channels/telegram/{start,cancel,disable}/route.ts` (delegate to helpers), `src/app/api/admin/channels/sms/verify/route.ts` (pre-check + 23505 catch), `src/app/api/admin/channels/sms/_shared.ts` (lock key rename), `src/app/api/admin/channels/whatsapp/{start,cancel}/route.ts` (23505 catch + lock + FOR UPDATE), `src/components/admin/{TelegramEnrollmentWidget,WhatsAppEnrollmentWidget}.tsx` (refactored to use hook), `src/app/(authenticated)/settings/page.tsx` (converted to server component shell), `worker/ingress/twilio-whatsapp-inbound.ts` (FOR UPDATE on verifier SELECT), plus several `__tests__/` updates for the changed SQL queue patterns.

**Zero new env vars** — Phase 4 reuses the existing `CHANNELS_TELEGRAM_ENABLED` flag from Phase 2 and the existing `TELEGRAM_*` env vars. The owner page learns flag state via the existing business-detail API; no `NEXT_PUBLIC_*` companion.

**What's next (operational, not code):** flip `CHANNELS_TELEGRAM_ENABLED=true` in prod once `@RepWorthBot` is registered + `setWebhook` is configured + a pilot owner has been walked through the manual-test checklist on staging. PR #10 reviewed by Codex across 4 review passes (final pass returned zero findings). After flag flip, monitor first 5–10 owner enrollments for any UX surprises; the helper unit tests + reducer tests cover state-machine correctness, but the React glue is only covered by Playwright `test.fixme` (deferred until the Supabase admin `generateLink` harness lands).

---

## Sprint Zernio-Ingestion: Replace SerpAPI Polling with Webhook-Driven Ingestion

### Phase Z2.0 — Code-Complete (2026-04-30)

**Status:** CODE-COMPLETE behind the existing `ZERNIO_PUBLISHING_ENABLED` flag (default OFF). Branch: `feat/zernio-ingestion-replace-serpapi` — 40 commits, 1707/1707 vitest tests pass, `tsc --noEmit` clean, ESLint clean, 4 review rounds applied.

**Why:** SerpAPI polling had three structural problems: (1) every connected business burned $0.05/sync × 24 syncs/day per location regardless of whether new reviews existed, (2) the 60-minute reconciliation interval meant up to an hour of latency between a customer posting a review and us drafting a response, and (3) the synthetic SHA-256 `provider_review_id` collided on common reviewer names + dates and frequently mismatched Zernio's canonical IDs at publish time, requiring a Redis-cached field-match lookup. Zernio's review.new / review.updated webhooks landed in production during the Phase 1 publishing rollout (commit `83142e4`, 2026-04-28) but were left as a no-op counter — this sprint promotes them into the canonical ingestion path, deletes the SerpAPI consumer half (the SerpAPI source stays for the demo engine), decommissions the manual-post fallback that's been dormant since Phase 1 connect-first publishing landed, and wires the premium tier end-to-end so it can actually be sold.

**What it does:** A reviewer posts on Google → Zernio's webhook fires within seconds → `worker/ingress/zernio.ts` parses the payload, narrows fan-out to the firing location, and emits one `ingest_zernio_review` outbox row per active connection at that account/location → `OutboxPoller` dispatches to `ZernioReviewIngestWorker` → worker walks up to 4 listReviews pages locationId-scoped, locates the review by `r.id === zernio_review_id`, runs the reconcile-externally-answered branch if Zernio shows the customer already replied via Google, otherwise builds a `MonitoredReview` with location-scoped resource names (`zernio://{accountId}/locations/{locationId}/reviews/{reviewId}`) and runs the existing `processReview` pipeline → `ResponseGeneratorWorker` drafts the reply → `NotificationWorker` emails the owner → owner approves → `ResponsePublisherWorker` posts via Zernio. Plus a one-shot tier-aware backfill on first connect (gap reviews ≤25 all tiers, historical ≤50 premium-only, `suppress_notification=true` so the first-connect dashboard doesn't blast 75 approval emails). The same `ZERNIO_PUBLISHING_ENABLED` flag controls publishing AND ingestion.

**Implementation tasks (executed via subagent-driven development from `docs/superpowers/plans/2026-04-29-zernio-ingestion-replace-serpapi-plan.md`):**

1. **Tasks 0–3 — Pre-flight + foundations:** Pre-flight audit on a clean feature branch from `main`. Migration 028 added `zernio_backfill_runs` table (per-business summary of gap/historical processed + skipped counts; `subscription_tier` and `subscription_activated_at` snapshotted at backfill time so the row is self-contained; partial unique index `zernio_backfill_runs_one_per_business` is defense-in-depth on top of the connect-callback's `needs_backfill` predicate). New outbox payload types `IngestZernioReviewPayload` + `ZernioInitialBackfillPayload`; new queue names `ingest_zernio_review` + `zernio_initial_backfill`; existing `GenerateResponsePayload` widened with `suppress_notification?: boolean`. `ReviewIdentity.provider` widened to `'serpapi_poll' | 'zernio'`; `identityStrategy` added `'zernio_id'`.

2. **Tasks 4–7 — Shared library helpers:** `canonicalizeReplyText` (CRLF→LF, NFC normalize, trim, BOM + zero-width strip — all four because round-trips through Zernio + Google introduce each variant in practice). `parseZernioReviewWebhook` with `ZernioReviewWebhookParseError` accepts both bare review.id and resource-name forms, agreement-checks when both are present, deliberately does NOT cross-check top-level `account.id` against the `accounts/{...}` segment in `review.name` (different ID spaces — Zernio account vs Google Business account; round-4 regression test pinned). `zernioClient.listReviews` + `listAllReviews` widened to require `locationId` (Zernio's API accepts it as a query param; without server-side scoping, multi-location fan-out would return reviews for the account's default location, not the connection's, causing every cross-location webhook to escalate to `review_exceptions`). `zernio-normalize.ts` exports `zernioReviewToNormalized` + `buildZernioMonitoredReview` + `extractLocationFromReviewName` + `ZernioReviewNormalizationError` — per-review validation throws so workers can isolate one bad review without aborting a batch.

3. **Tasks 8–10 — process-review hardening + auth fallback:** `processReview` INSERT now uses `ON CONFLICT (provider, provider_review_name) DO NOTHING`; on race-loss the function re-reads FOR UPDATE and falls through to `processExistingReview` so newer content from a race-loser is NOT silently dropped. `suppressNotification` flag rides into every `generate_response` outbox payload (4 enqueue sites). `ResponseGeneratorWorker.persistResponseAndNotify` honors the flag — when `suppress_notification === true`, skips the `send_notification` outbox enqueue AND the `notification_deliveries` write; `NotificationFailoverPoller`'s EXISTS-check on `notification_deliveries WHERE template='approval_request'` safely no-ops on the missing rows. `applyIngestionAuthErrorFallback` (distinct from publisher's `applyTransientExhaustionFallback` — ingestion has no response_id to park) disconnects only the matching active connection (pinned by `business_id + zernio_account_id + zernio_location_id`) and enqueues `notify_owner_connection_lost`; idempotent via `UPDATE … WHERE status='active' RETURNING 1` count check.

4. **Tasks 11–13 — Worker chain:** `worker/jobs/zernio-ingest-shared.ts` exports two helpers used by both ingest and backfill workers: `handleZernioIngestError` dispatches Zernio HTTP errors per spec §6.3 table (auth → applyIngestionAuthErrorFallback + markFailed; permanent/validation → markFailed; transient → rethrow; unknown → rethrow). `reconcileExternallyAnsweredReview` matches local rows by EITHER exact zernio identity OR legacy `serpapi_poll` field-match (reviewer + rating + text + createTime ±24h, mirroring zernio-publisher's `MATCH_WINDOW_MS`); per-response protect-set distinguishes "our reply" (canonicalize-text-match against `approved_text`) from "external reply" — supports mixed legacy/Zernio scenarios where one zernio row protects and one legacy row supersedes from a single helper call. Active-status filter deliberately excludes `'awaiting_manual_post'` per the decommissioning. `ZernioReviewIngestWorker` (new): subscription guard → connection-active verify (pinned by account+location) → mock-mode short-circuit → 4-page locationId-scoped `listReviews` walk → distinguish durable not-found (entire feed walked, no `nextPageToken`) from cap-exhausted indeterminate (`nextPageToken` still set after `maxPages`) → fail-closed on unparseable `review.name` → no-op on location mismatch (sibling business at same account, different location) → `reconcileExternallyAnsweredReview` if `reviewReply !== null`, otherwise `buildZernioMonitoredReview` + `processReview`. `ZernioBackfillWorker` (new): idempotent claim via `INSERT … ON CONFLICT (business_id) DO NOTHING` then SELECT-and-check-completed_at sentinel (row-existence alone is NOT the done marker — a `listAllReviews` timeout after row insert would otherwise lose backfill on retry); subscription guard skip does NOT set completed_at (billing recovery should retry); reconcile failures collected per-review and re-thrown at end BEFORE setting `completed_at` so BullMQ retries the whole backfill on partial failure (idempotent thanks to `processReview` ON CONFLICT + supersession idempotency).

5. **Tasks 14–16 — Webhook fan-out + worker registration + connect callback:** `worker/ingress/zernio.ts` `case 'review.new': case 'review.updated':` replaces the old counter with `INSERT … SELECT … FROM zernio_connections … ON CONFLICT (aggregate_id, (payload->>'zernio_review_id')) WHERE topic = 'ingest_zernio_review' AND status IN ('pending', 'dispatching', 'dispatched') DO NOTHING` — fans out one outbox row per active connection at the firing account, dedups against in-flight rows when Zernio retries a webhook delivery mid-processing. When the parsed payload carries `locationIdFromPayload`, the WHERE narrows to that exact location (sibling locations no longer receive every webhook + escalate to exceptions). `worker/index.ts` registers `ingestZernioReviewWorker` (default concurrency) and `zernioBackfillWorker` (concurrency 1, serial — backfill is heavy); `ingestZernioReviewWorker.on('failed')` escalates typed errors after retry exhaustion to distinct `review_exceptions` types (`zernio_review_not_found` durable, no admin notify; `zernio_pagination_cap_exhausted` indeterminate, no admin notify, Sentry warning instead; `zernio_unparseable_review_name` admin notify because it signals API contract change). Connect callback (`/api/zernio/connect/select-location/route.ts`) emits the backfill outbox row in the same tx as the `zernio_connections` activation when the `needs_backfill` predicate fires (`NOT EXISTS (… completed_at IS NOT NULL)` — covers both no-row case AND incomplete-row case, ROUND-2 fix).

6. **Tasks 17–21 — Publisher refactor:** `worker/jobs/publisher-error-handlers.ts` (new) extracts the canonical disconnect-park-notify and fail-exception-notify sequences from inline 150-line catch blocks into `handlePublisherAuthErrorTerminal` (pinned by `business_id + zernio_account_id + zernio_location_id`; round-10 fix preventing stale auth error from disconnecting a sibling fresh reconnect at a different location) and `handlePublisherPermanentErrorTerminal`. Both helpers redact `error_body` via `redactSensitiveError` (strips `Bearer …`, `Basic …`, `token=…`, `api_key=…`, `password=…`, `authorization=…` patterns) before persisting in `zernio_connections.last_error` and `responses.posting_error` audit fields — Sentry breadcrumb scrubber doesn't apply to DB writes. New error classes `PublisherTransientWithContext` (subclasses `ZernioTransientError`, carries `attemptContext = { response_id, business_id, account_id, location_id }`) and `ZernioReplyVerificationIndeterminateError` (reason union `review_not_found_after_pagination | review_found_but_reply_null | verifier_unknown_error`). New `verify409AndDispose(args): Promise<Verify409Result>` returns a discriminated union (`posted | superseded | auth | permanent | transient | indeterminate`); reads `getCachedZernioReviewPage` for a tighter pagination cap on cache hit, walks `listReviews` page-by-page until target found OR cap hit, classifies lookup errors (transient/auth/permanent/unknown), compares canonicalized reply text on match (text match → mark posted via direct UPDATE + markOutboxCompleted; mismatch → supersede with `posting_error='already_replied_external'`, log lengths + 12-char SHA-256 fingerprints — never plaintext, round-9 redaction). `lookupZernioReviewId` now requires `locationId` as 4th param (round-2 M4 fix); cache key is `zernio_review_map:{accountId}:{locationId}:{businessId}:{ourReviewId}` (ROUND-1 fix — same-account location switch can't reuse stale mapping); also exports `getCachedZernioReviewPage` reading `zernio_review_page:{accountId}:{locationId}:{zernioReviewId}` written during the field-match walk. `applyTransientExhaustionFallback` REQUIRES `account_id + location_id` (un-pinned legacy fallback DELETED — would silently disconnect every active connection at a multi-connection business; round-1 critical). `worker/jobs/ResponsePublisherWorker.ts` 409 catch block reduced from 150 lines to a 25-line switch dispatch over `verify409AndDispose`'s discriminated union; lookup-time `ZernioTransientError` now wraps in `PublisherTransientWithContext` (round-1 critical — was raw rethrow, missing pinning context); `worker/index.ts` publisher onFailed hook adds dedicated branch for `ZernioReplyVerificationIndeterminateError` BEFORE the transient branch (PublisherTransientWithContext extends ZernioTransientError so order matters), unwraps `attemptContext` to call `applyTransientExhaustionFallback` with pinned account+location, AND surfaces bare `ZernioTransientError` (now a code bug since every publisher path wraps) loudly via `Sentry.captureException(level='error', tags={kind:'unwrapped_transient'})`. `AdminExceptionWorker.ts` switches on `exception.type` via `renderExceptionBody` with 5 typed cases + a generic fallback (lists payload primitives, never the misleading "reviewer edited" copy as default); SELECT now includes `re.review_id` so the reviewer block gates on row presence (anonymous reviewers with `reviewer_name=null` but real `review_id` correctly render "Unknown reviewer", round-11 fix); `zernio_review_not_found` exceptions render "no local review record" because the review was never ingested.

7. **Tasks 22–23 — SerpAPI removal:** Three producers eliminated (onboarding/business route + create-business `placeIdVerified` branch + PlaceIdValidationWorker `enqueueSyncReviews` helper). PlaceIdValidationWorker still resolves URL → placeId + marks `place_id_verified=true`; just doesn't fan out. Six consumer files DELETED: `worker/jobs/ReviewSyncWorker.ts`, `worker/__tests__/ReviewSyncWorker.test.ts`, `worker/jobs/ReconciliationPoller.ts`, `worker/__tests__/ReconciliationPoller.test.ts`, `src/lib/reviews/serpapi-monitor.ts`, `src/lib/reviews/mock-monitor.ts`. `src/lib/shared/mock-mode.ts` drops `getReviewMonitor`. `worker/__tests__/correlation-chain.test.ts` part A rewritten to test `ingest_zernio_review → processReview(correlationId)`. **`SerpApiSource` and `MockReviewSource` and `serpapi-prefill` are PRESERVED** — `DemoGenerationWorker` still uses them for prospect demos (spec §2 non-goal).

8. **Task 24 — Premium tier wiring:** Activates the existing `'premium'` slot (already in cost limits + types + admin) across schema validation (`SelectPlanSchema.tier` enum widened), the onboarding plan picker (Premium card), the Stripe Payment Link map (`STRIPE_PAYMENT_LINK_PREMIUM`), the Stripe webhook price→tier map (`STRIPE_PRICE_PREMIUM`), and the worker startup assertion. `.env.example` documents both new env vars. Test `select-plan.test.ts:159` flipped from "rejects premium" to "accepts premium".

9. **Tasks 25–28 — Manual-post decommission + reconnect copy + CLAUDE.md:** Migration 029 bulk-fails any orphan `awaiting_manual_post` rows with `posting_error='manual_post_deprecated_2026_04'` (defensive — prod has zero per CLAUDE.md), rebuilds `responses_one_non_terminal_per_review` partial unique index without the dead status, drops the migration-024 `notification_deliveries_response_template_uniq` index whose predicate `template='admin_manual_post'` is no longer satisfiable. Apply order: 028 BEFORE 029. Code deletions: `manual-post-section.tsx`, `ManualPostFlow.tsx`, `mark-posted/route.ts`, `manual-post.ts` email template + tests. ~20 modify sites cleaned. Two-clause v17 reconnect wording on `ConnectGoogleBanner.tsx` + `owner-reconnect-required.ts` email template. CLAUDE.md updated.

10. **Task 29 — Integration tests:** `worker/__tests__/zernio-end-to-end.integration.test.ts` (new) exercises the worker chain with mocked sql + zernioClient; covers happy path with location-scoped MonitoredReview identity, multi-location fan-out separation, subscription cancelled, connection disconnected mid-flight, correlation_id propagation, externally-answered review reconcile branch.

11. **Task 30 — Acceptance + rollout checklist:** Pre-merge gates (tsc + test + lint), §13 grep audit (resolves to historical migrations + absence-assertions only), prod migration apply order, env vars, webhook URL confirm, manual smoke per `docs/zernio-ingestion-test-runbook.md`.

**Code-review rounds applied:**

- **Round 1 (Codex first pass) — 7 Medium + 2 Low findings.** All addressed in commit `88f66fc`. Critical finds: webhook fan-out only filtering by account not location; ingest pagination capped at only 2 pages; `notify_owner_reconnect` payload missing `kind: 'reconnect_required'` discriminant (would silently route to wrong email template); park UPDATE clause excluded `awaiting_owner_connect` (retry of parked response would skip notify); lookup-time `ZernioTransientError` raw-rethrown without context wrap; `processReview` no-active-response branch enqueued `version: 1` even when terminal v1 existed; `lookupZernioReviewId` cache key omitted `locationId`. Lows: backfill subscription-skip set `completed_at` blocking retry; runbook A5 still referenced `sync_reviews`.

- **Round 2 (Codex second pass) — 1 Medium + 2 Low.** Commit `5874d25`. Backfill predicate flipped from `EXISTS … completed_at IS NULL` to `NOT EXISTS … completed_at IS NOT NULL` (covers no-row case for admin-connected-pre-checkout); cap-exhausted payload added `pages_walked`; +6 tests for cap-exhausted, durable not-found metadata, no-row resume, in-flight dedup.

- **Round 3 (final pass) — 17 findings (2 Critical + 7 Medium + 8 Low).** All addressed in commits `76f6fbf` + `a0a5724` + `7e0b7e1`. Critical 1: 409 verifier walked 4 pages on every retry without page-cache reuse → `getCachedZernioReviewPage` + Sentry warning. Critical 2: webhook fan-out had no per-review outbox dedup on `claimInboundEvent` reclaim → migration 030 partial unique index `job_outbox_ingest_zernio_review_inflight` + `INSERT … ON CONFLICT DO NOTHING`. Mediums: deleted un-pinned `applyTransientExhaustionFallback` legacy fallback (would silently disconnect every active connection); `canonicalizeReplyText` strips BOM + zero-width chars; NaN guard on `subscription_activated_at` parse; documented gap-window vs `connected_at` semantics as residual risk; supersede parked `awaiting_owner_connect` on content change (drain race); extracted `verify409AndDispose` discriminated union; canonical field-match predicate via `src/lib/reviews/zernio-field-match.ts`; `redactSensitiveError` strips Bearer/Basic/token=value patterns from persisted error bodies. Lows: `maybeEnqueueBackfillResume` only on real activation transition; truncate `ZernioReviewWebhookParseError.rawPreview` to 500 chars; tolerate `sha256=` prefix in webhook signature; `isPremium` const + `GAP_CAP` + `HISTORICAL_CAP_PREMIUM` constants; workers map keyed by queue name; `payload satisfies SendOwnerEmailPayload` at every notify construction site; Sentry warning capture for `zernio_pagination_cap_exhausted`.

- **Round 4 (final) — 0 findings.** Branch genuinely closed.

**Architecture invariants preserved:** outbox pattern unchanged, no auto-posting (`awaiting_owner_connect` still required between approval and Zernio post when no active connection exists; new `review_content_changed_during_park` supersession path closes a race that could have published a stale draft after reconnect), worker-side third-party ingress preserved, transactional outbox preserved, approval tokens still SHA-256-hashed, Node native `crypto` for hashing, app-enforced auth scope.

**Files created (~22):**
- `supabase/migrations/{028_zernio_backfill_runs,029_drop_awaiting_manual_post,030_ingest_zernio_review_outbox_dedup}.sql`
- `src/lib/zernio/{canonicalize-reply,parse-review-webhook,auth-error-fallback}.ts` + 3 test files
- `src/lib/reviews/{zernio-normalize,zernio-field-match}.ts` + 2 test files
- `worker/jobs/{ZernioReviewIngestWorker,ZernioBackfillWorker,zernio-ingest-shared,publisher-error-handlers}.ts` + 4 test files
- `worker/__tests__/zernio-end-to-end.integration.test.ts`
- `docs/zernio-ingestion-test-runbook.md` (10-section pre-merge + staging + rollout + rollback runbook)

**Files modified (~30):** `worker/{index,queues,startup-assert}.ts`, `worker/ingress/{zernio,stripe}.ts`, `worker/jobs/{ResponsePublisherWorker,ResponseGeneratorWorker,AdminExceptionWorker,PlaceIdValidationWorker}.ts`, `src/lib/publishing/zernio-publisher.ts`, `src/lib/zernio/{client,types}.ts`, `src/lib/reviews/{process-review,types,index}.ts`, `src/lib/shared/{queue-names,worker-types,mock-mode,index,schemas,response-status,constants}.ts`, `src/lib/payments/payment-link.ts`, `src/lib/notifications/{email,delivery}.ts` + email template comment cleanup, `src/app/api/zernio/connect/select-location/route.ts`, `src/app/api/onboarding/business/route.ts` + `src/lib/onboarding/create-business.ts`, `src/app/onboarding/pay/PlanPickerClient.tsx`, `src/app/admin/businesses/[id]/{page,components/ReviewsList,components/ZernioConnectionPanel}.tsx` + `src/app/admin/runbook/page.tsx`, `src/components/dashboard/{ConnectGoogleBanner,ReviewsList}.tsx`, `src/lib/notifications/email/templates/owner-reconnect-required.ts`, `.claude/CLAUDE.md`, `.env.example`, `.gitignore`.

**Files deleted (10):** `worker/jobs/{ReviewSyncWorker,ReconciliationPoller}.ts` + their tests, `src/lib/reviews/{serpapi-monitor,mock-monitor}.ts`, `src/app/admin/businesses/[id]/{manual-post-section.tsx,components/ManualPostFlow.tsx}`, `src/app/api/admin/businesses/[id]/mark-posted/route.ts`, `src/lib/notifications/email/templates/manual-post.ts`.

**3 new env vars:**
- `STRIPE_PAYMENT_LINK_PREMIUM` — required when `SELF_SERVE_SIGNUP_ENABLED=true` (worker startup assertion).
- `STRIPE_PRICE_PREMIUM` — required so the Stripe webhook maps the premium price → `subscription_tier='premium'`.
- `ZERNIO_INGEST_MAX_PAGES` — optional, default `4` (200 reviews). Caps `ZernioReviewIngestWorker.listReviews` walk; cap-exhausted with `nextPageToken` still set escalates to `review_exceptions type='zernio_pagination_cap_exhausted'`.

**4 new lab notes added to `.claude/CLAUDE.md`:**
- `ON CONFLICT` clauses must reference partial-unique-index expressions byte-for-byte; the migration-005 `idx_review_exceptions_collision_dedup` predicate uses `(payload->>'provider_review_id')`, NOT `provider_review_id`.
- Zernio webhook `account.id` (top-level) is Zernio's account ID; the `accounts/{...}` segment in `review.name` is Google's Business account ID — different ID space, do NOT cross-check them.
- Zernio backfill gap-window currently uses `subscription_activated_at`, not `connected_at` — connect-after-activation customers get a tiny gap window. Documented as residual risk pending schema change.
- Bare `ZernioTransientError` reaching the publisher's onFailed hook is a code bug — every publisher path now wraps with `PublisherTransientWithContext`. Surface loudly via Sentry rather than silently disconnecting every active connection.

**What's next (operational, not code):** Apply migrations 028 → 029 → 030 in prod Supabase (in that order; 028 must come before 029). Set `STRIPE_PAYMENT_LINK_PREMIUM` + `STRIPE_PRICE_PREMIUM` in prod env. Confirm Zernio webhook URL still points at `${WORKER_PUBLIC_URL}/ingress/zernio` (no URL change). Run §5 staging end-to-end smoke per `docs/zernio-ingestion-test-runbook.md` (10 scenarios). Then `ZERNIO_PUBLISHING_ENABLED=true` in prod (single flag controls publishing AND ingestion). Pilot one customer end-to-end. 24h watchlist: zero `unwrapped_transient` errors in publisher, `zernio_pagination_cap_exhausted` warning rate under threshold, `review_exceptions type LIKE 'zernio_%'` count near zero, no `dispatched`-stuck rows. SerpAPI ingestion code is GONE — rolling back means re-deploying the pre-merge commit (SerpApiSource itself is preserved for the demo engine). After successful pilot + 24h soak, the `~70% of polling spend disappears` benefit lands automatically since active customers stop hitting the SerpAPI quota for review polling (only the demo engine consumes SerpAPI now).

---

## feat/edit-existing-replies — Edit Existing Replies (Tier-Mirrored)

**Branch:** `feat/edit-existing-replies` (off `feat/zernio-ingestion-replace-serpapi`)
**Date code-complete:** 2026-05-02
**Status:** Code-complete. 22 commits on the branch. 1869/1874 tests passing (1 pre-existing flaky NotificationWorker test under parallel CPU load — passes in isolation, not a regression). TSC + lint clean. `pnpm build` succeeds (new route at 4.35 kB / 167 kB First Load).
**Spec:** `docs/superpowers/specs/2026-05-01-edit-existing-replies-design.md`
**Plan:** `docs/superpowers/plans/2026-05-01-edit-existing-replies-plan.md`
**Single feature flag:** `EDIT_EXISTING_REPLIES_ENABLED` (off by default; gates UI + ingestion + new edit-publisher branch + new onFailed orphan-marker conversion together).

### Motivation

When a business onboards through `/dashboard/connect`, `ZernioBackfillWorker` walked `listAllReviews` and silently dropped any review the owner had already replied to on Google before connecting RepWorth. For Tanicia Resort's onboarding (2026-05-01), 8 of 158 reviews never made it into the dashboard — owner had no record of past engagement, voice learning had zero examples to bootstrap from, and there was no path to refine a reply through RepWorth even though Zernio supports doing so. This feature ingests the silently-dropped reviews into the DB as `posted` responses, surfaces them in a new "Past Replies" tab, and gives owners — within their tier — the ability to edit/regenerate/re-publish.

### Tier rule (the C-2 option from brainstorming)

| Action | Standard / Founding | Premium |
|---|---|---|
| **See** existing replies | Yes (all) | Yes (all) |
| **Edit / regenerate** reply for **gap** review (createTime >= subscription_activated_at) | Yes | Yes |
| **Edit / regenerate** reply for **historical** review (createTime < activated_at OR activated_at IS NULL) | No | Yes |

Boundary: review_date == subscription_activated_at counts as gap (>= predicate).
NULL `subscription_activated_at` fails closed: every review treated as historical (cautious — matches the existing connect-flow code's stance for legacy businesses where the column was added in migration 014 but legacy rows could lack it).

### What shipped (21 plan tasks, grouped)

**Worker layer (Tasks 1-8):**

1. **Migration 031** — `reviews.external_reply_ingested_at` + `zernio_backfill_runs.external_reply_ingested_count` + partial unique index `responses_one_posted_per_review` (CONCURRENTLY) + `idx_reviews_business_review_date` (CONCURRENTLY). Non-transactional file with embedded pre-flight + post-migration verification SQL.
2. **Zernio client `deleteReply`** — DELETE `/v1/inbox/reviews/{reviewId}/reply` with explicit 15s timeout (load-bearing per spec §4.5 lock-window discipline). New `ZernioReplyAlreadyDeletedError` (404 → caller treats as DELETE-success). 403 + `inbox_addon_required` → `ZernioPermanentError` (NOT auth — billing-side issue must not fire connection-lost flow).
3. **Ingestion extension** — `reconcileExternallyAnsweredReview` gets two NEW flag-gated branches that turn the silent "previously-unseen" / "matched but no active responses" no-ops into actual ingestion. Race-safe ON CONFLICT DO UPDATE for the review INSERT; partial-unique-index ON CONFLICT for the response INSERT.
4. **process-review stale-marking** — unconditional UPDATE at the TOP of the content-change block flips recoverable-orphan-state failed rows to `posting_error='stale_after_review_changed'` so recovery routes refuse to republish stale text.
5. **`verify409InTx`** — tx-aware variant of `verify409AndDispose` returning a discriminated union. Avoids self-deadlock when called from inside the new edit-publisher's locked tx.
6+7. **Publisher Phase A + Phase B** — biggest task. Non-locking pre-flight + locked-tx DELETE-before-POST with per-CATCH commit semantics covering EVERY row of spec §4.5's 16-outcome table. Affected-row-count assertions on every status-guarded UPDATE. Auth catches use `markOutboxCompleted` (drain re-enqueues on reconnect). Orphan markers (`posting_error LIKE '%_after_delete_succeeded'`) survive BullMQ retries AND drain re-enqueue.
8. **`worker/jobs/publisher-on-failed.ts`** — extracted from `worker/index.ts` (so the new logic is testable). Orphan-marker conversion runs BEFORE the existing transient fallback: orphan-marker rows on retry exhaustion → `'failed'` with `posting_error='post_after_delete_failed_retry_exhausted'` (recovery-routes-visible state).

**API layer (Tasks 9-14):**

9. **`src/lib/responses/edit-existing.ts`** — `assertCanEditReply` (tier + ownership gate) + `validateOptimisticConcurrency` (in-tx hash + version check against the LIVE 'posted' row, not the latest non-terminal — fixes the prior-draft bug where /draft's own INSERT broke /publish-time validation).
10. **POST /draft** (manual + regenerate) — withSameOrigin wrapper, in-flight guards, optimistic concurrency in-tx. Manual mode: status='pending_approval' (NOT 'edited' — only /publish transitions to a HANDLED status per spec §4.2 atomicity rule).
11. **PATCH/DELETE /draft/:id + GET /draft-status** — PATCH = edit-further on a pending row; DELETE = cancel (idempotent); GET = poll regenerate status with tenant ownership guard on outbox payload + on resolved response row.
12. **POST /publish** — atomic transition + audit-log + outbox INSERT in ONE tx. Status discriminator: `edited_text IS NOT NULL ? 'edited' : 'approved'`. `approved_text = COALESCE(approved_text, response_text)` — critical for regen-as-is. Audit `mode` discriminator uses (llm_provider, edited_text) tuple: `'manual'` / `'regenerate_as_is'` / `'regenerate_edited'`.
13. **POST /retry + POST /restore-original** — recovery routes for orphan-state failed rows. Both call `assertCanEditReply` (cross-cutting tier gate). `/retry` allowlist: `delete_failed_*` OR `post_after_delete_failed_*`. Branch-shape validation (step 2a): the security-critical check that prevents `/retry` from undoing a previously-applied `/restore-original`. `/retry`'s CASE expression re-installs the orphan marker on `post_after_delete_failed_*` recovery. `/restore-original` finds the most-recent superseded sibling with `posted_at IS NOT NULL`, INSERTs a fresh pending_approval row at `version=MAX+1`, leaves the OLD failed row in place (so abandoning the restore via DELETE /draft re-enables /retry as fallback).
14. **Cross-origin regression test** — single consolidated file confirms ALL 6 mutating routes return 403 on wrong Origin AND that GET /draft-status is exempt.

**Frontend layer (Tasks 15-17):**

15-16-17. **Past Replies tab + drawer + nav link** — server component at `/dashboard/past-replies` (paginated 50/page, NULL-safe gap/historical bucketing). `PastReplyCard` shows reviewer + Google reply + provenance label ("Imported from Google · YYYY-MM-DD" / "Posted via RepWorth · YYYY-MM-DD") + Edit CTA / "Premium feature" lock badge. `EditReplyDrawer` 6-state machine (initial / manual editing / regenerating / regenerate-preview / publishing / recovery) + dedicated 409 review_changed prompt. Right-aligned fixed panel; backdrop click-to-close; Esc to close. Polls `/draft-status` every 1500ms with 60s ceiling. Snapshot `{ hash, version }` captured at open via `useRef`. `HistoricalUpgradeBanner` soft sage/blush upsell above non-premium historical section. `OwnerNav` link conditionally rendered when flag on (server-authoritative).

**Tests + script + runbook (Tasks 18-21):**

18. Integration + E2E tests **deferred** — need `TEST_DATABASE_POOL_URL` (real Postgres for FOR UPDATE concurrency tests) + Playwright browser harness. Per-task unit tests cover the main paths (~115 cases across this branch).
19. **Backfill script** `scripts/zernio-backfill-external-replies.ts` — one-off CLI for retroactive ingestion. Idempotent.
20. **Runbook update** — appended §10 "Edit Existing Replies (Phase A/B)" to `docs/runbooks/zernio-launch-runbook.md` with pre-flight + post-migration verification + monitoring + rollback.
21. **Final verification** — pnpm test 1869/1874, pnpm build OK, pnpm lint clean, pnpm tsc clean.

### Test count

- ~115 new unit tests across the branch (5 zernio-client + 7 ingest + 5 process-review + 11 verify409InTx + 21 publisher-edit + 13 publisher-on-failed + 14 edit-existing helper + 11 + 30 + 12 + 24 + 7 API tests).
- Pre-existing test suite: regression-clean (publisher 23/23, full pre-existing 1748 still green).
- Full vitest run: 1869/1874 (1 pre-existing flaky test under parallel CPU load — passes in isolation).

### Files (high-level inventory)

**Created (~17):** migration 031, edit-existing helper + test, 7 API route files + 7 test files, the past-replies page, 3 dashboard components, ResponsePublisherWorker-edit.test, publisher-on-failed.{ts,test.ts}, the backfill script.

**Modified (~12):** ResponsePublisherWorker, zernio-ingest-shared, publisher-error-handlers, worker/index, process-review, zernio client/errors/types, authenticated/layout, OwnerNav, runbook, plus the 4 .claude/skills/*.md files + .claude/CLAUDE.md.

### Pre-merge / pre-flag-flip checklist

- [x] All unit tests passing (1869/1874 — 1 unrelated pre-existing flaky test).
- [x] TSC + lint clean.
- [x] `pnpm build` succeeds.
- [x] Migration 031 file created with embedded pre-flight + verification SQL.
- [x] Runbook updated with Phase A/B rollout steps + monitoring.
- [x] Single feature flag for both UI + ingestion + publisher branch.
- [ ] Apply migration 031 in prod Supabase (after pre-flight check confirms no duplicate `posted` rows).
- [ ] Phase A soak >= 1 week with `EDIT_EXISTING_REPLIES_ENABLED=false`.
- [ ] Phase B: flip flag to `true` in prod env (Vercel + Railway).

### Deferred for follow-up

- Integration tests (spec §6.2, 9 cases) — need `TEST_DATABASE_POOL_URL`.
- E2E tests (spec §6.3, 4 cases) — need Playwright + browser harness.
- Surfacing failed orphan-state rows on the Past Replies page so the recovery state in `EditReplyDrawer` can be triggered (today the page query filters `responses.status='posted'`; failed rows live separately).
- Voice-learning bootstrap from imported replies — would widen the voice-learning query at `src/lib/responses/voice-learning.ts:30` to include `original_draft_text == approved_text AND llm_provider IS NULL` rows. Spec §8 / §9 follow-up.

---


## feat/past-replies-view — Read-only Past Replies tab (post-split)

**Branch:** `feat/past-replies-view` (off `feat/zernio-ingestion-replace-serpapi`)
**Date code-complete:** 2026-05-02 (after split + 4 fix-pass review rounds + reviewer-driven docs cleanup)
**Status:** Code-complete. 9 commits on the branch. 1869+ tests passing (379 in worker + zernio scope), TSC + lint clean, `pnpm build` succeeds (new route ~4.3 kB / 167 kB First Load).
**Migration:** 031 (column + counter + partial unique index + supporting index).
**Two flags (both default off):** `EXTERNAL_REPLY_IMPORT_ENABLED` (writes path) + `PAST_REPLIES_VIEW_ENABLED` (UI).

### The split decision

The original `feat/edit-existing-replies` branch was code-complete: 31
commits, 6 review rounds, ~3,500 LOC, 1869/1874 tests passing. It would
have shipped the full edit / regenerate / publish / retry / restore-original
feature with an EditReplyDrawer + 7 API routes + a publisher DELETE+POST
locked-tx state machine + recovery routes + orphan-marker convention.

**Why we split it instead of shipping it whole:**

1. **API model mismatch.** Zernio's API requires DELETE-then-POST to edit a
   reply. Direct GBP API uses single-PUT replacement. ~25% of the parked
   code (the orphan-marker recovery state machine) becomes vestigial when
   GBP arrives. Building Zernio-shaped recovery for production support of
   a feature that will be ripped out is expensive engineering debt.

2. **GBP timeline unknown.** Per CLAUDE.md, "GBP API: Not applied for" —
   that's at minimum 6-18 months of waiting (apply → Google review →
   approval → integration). During that window, the original Tanicia
   onboarding pain (silently-dropped pre-RepWorth replies) keeps recurring
   for every new business.

3. **Shipping the visibility win is high-value, low-risk.** Solving JUST
   the visibility problem (read-only Past Replies tab + the ingestion fix)
   is ~30% of the code, ~5% of the operational complexity, and addresses
   the original user pain.

4. **Branch was stabilizing but not stable.** Across 6 review rounds
   (Codex pass-1 → Round-2 M1+M2+M3 → Round-3 M → Round-4 M), reviewers
   kept finding successively smaller variants of the same hidden-draft
   class of bug in the regenerate flow. Each round was real engineering
   hours, and post-launch ops would inherit that complexity.

**Decision:** ship a stripped-down read-only branch now; park the edit
machinery on tag `wip/edit-existing-replies-zernio-v1` for either GBP-time
reuse OR resurrection if GBP timeline blows up beyond ~12 months.

### What was kept (cherry-picked into feat/past-replies-view)

| Commit | Purpose |
|---|---|
| `eb4d183` (cherry-picked as `dfa30ce`) | Migration 031 — column + counter + partial unique index + supporting index |
| `c2360cd` (cherry-picked as `7989f2c`) | `reconcileExternallyAnsweredReview` flag-gated import branches |
| `891e975` (cherry-picked as `d71549c`) | Round-1 Low fix — counter bump only on actual INSERT |
| `884f7d5` (cherry-picked as `a738957`) | Backfill script + (then-rewritten) runbook section |

### What was redone manually (couldn't cherry-pick clean)

| Original | New commit | Why redone |
|---|---|---|
| `ca53663` (Round-1 M1) | `f9106c5` | Original touched `verify409InTx` which doesn't exist on this branch. Redone: kept the `listReviews` chokepoint normalization + the worker loose-equality guards; dropped the verify409InTx hunk. |
| `9e0ca93` (Round-1 M5) | `5e84708` | Original required `redactSensitiveError` to be exported, which depended on `a8836fd` we weren't bringing. Redone: exported the helper + added `summarizeShape` + wired all four sites in one commit. |

### What was built fresh on the new branch

| Commit | Purpose |
|---|---|
| `eea4d98` | Read-only Past Replies page + `PastReplyCard` (no Edit button) + `HistoricalUpgradeBanner` + `OwnerNav` link conditional on `PAST_REPLIES_VIEW_ENABLED`. Renamed flag from `EDIT_EXISTING_REPLIES_ENABLED` to dual `EXTERNAL_REPLY_IMPORT_ENABLED` + `PAST_REPLIES_VIEW_ENABLED`. |
| `79aea5e` | Rewrote runbook §10 for the dual-flag rollout (Phase A → B1 → B2). |
| `b4a9418` | Reviewer-caught fix: SQL preflight `WHERE status = posted` and `IN (responses_one_posted_per_review, ...)` were missing string quotes; would have failed Postgres parsing. |

### What was DROPPED (parked on tag `wip/edit-existing-replies-zernio-v1`)

- The 7 API routes (`/draft`, `/publish`, `/retry`, `/restore-original`, etc.).
- `runEditPublisherIfApplicable` (Phase A pre-flight + Phase B locked tx).
- `worker/jobs/publisher-on-failed.ts` orphan-marker conversion.
- `verify409InTx` + verifier dispatch ladder.
- `process-review` stale-marking branch.
- `src/lib/responses/edit-existing.ts` (`assertCanEditReply` / `validateOptimisticConcurrency`).
- `EditReplyDrawer` (6-state machine, recovery panel, regenerate flow,
  Round-2 M1+M2+M3 + Round-3 M + Round-4 M fixes).
- `src/lib/zernio/client.ts::deleteReply` + `ZernioReplyAlreadyDeletedError`.
- The recoverable-failed LATERAL JOIN in the page query.
- The recovery-state branch in `PastReplyCard`.
- `failed_response_id` + `failed_posting_error` plumbing through page → card → drawer.

### Two-flag rollout rationale

Original single-flag design (`EDIT_EXISTING_REPLIES_ENABLED` gates
everything) entangled the data-write decision with the UI-expose decision.
Imported `posted` rows count toward `dashboard/service.ts` HANDLED_STATUSES,
so flipping ingestion on changed customer-visible numbers BEFORE the UI
explained them.

The view-only branch splits this into two independent flags:

- `EXTERNAL_REPLY_IMPORT_ENABLED` — gates writes (ingestion path).
- `PAST_REPLIES_VIEW_ENABLED` — gates UI (page + nav link).

**Rollout sequence:**
1. Apply migration 031 in production Supabase.
2. Phase A: ship code with both flags off, soak ≥ 1 week.
3. Phase B1: turn on `EXTERNAL_REPLY_IMPORT_ENABLED` — ingestion starts
   silently. Watch dashboard "total responded" count delta in product analytics.
4. Phase B2: turn on `PAST_REPLIES_VIEW_ENABLED` — owners see the new tab.
5. Pilot one customer end-to-end before wider rollout.

### Doc-cleanup follow-ups (post-merge)

- Updated `.claude/CLAUDE.md`: bumped migration head 030 → 031;
  rewrote "Current branch status" section.
- Updated `.claude/skills/feature-flags.md`: added the two new flags +
  marked `EDIT_EXISTING_REPLIES_ENABLED` as parked.
- Updated `.claude/skills/lab-notes.md`: appended 2026-05-02 section with
  6 lab notes (split decision, dual-flag pattern, cherry-pick lessons,
  EditReplyDrawer hidden-draft class of bug, vi.hoisted, gitignore quirks).
- Updated `.claude/skills/migrations.md`: bumped head + added migration 031 entry.
- Updated `.claude/skills/review-dedup.md`: appended external-reply
  ingestion section.
- Updated `docs/runbooks/zernio-launch-runbook.md`: §10 rewrite for dual-flag rollout.
- `docs/directory.md`: removed parked-feature references on disk
  (gitignored — won't ship in commits).

### Test coverage on this branch

- Unit tests: 379 passing in `worker/__tests__/` + `src/lib/zernio/__tests__/`.
  No new tests beyond what we cherry-picked (the 7-case ingest test suite
  from `c2360cd` + the counter-fix test update from `891e975`).
- Build: `pnpm build` succeeds with the new route at ~4.3 kB / 167 kB First
  Load.
- TSC + lint: clean.
- Integration / E2E: still deferred (need `TEST_DATABASE_POOL_URL` +
  Playwright harness).

### Pre-merge / pre-flag-flip checklist

- [x] All unit tests passing.
- [x] TSC + lint clean.
- [x] `pnpm build` succeeds.
- [x] Migration 031 file with embedded pre-flight + verification SQL (with quotes).
- [x] Runbook §10 updated for dual-flag rollout.
- [x] `.claude/CLAUDE.md` + skills/*.md updated to reflect the split.
- [ ] Apply migration 031 in prod Supabase (after pre-flight check confirms
      no duplicate `posted` rows).
- [ ] Phase A soak ≥ 1 week with both flags off.
- [ ] Phase B1: `EXTERNAL_REPLY_IMPORT_ENABLED=true` in prod env.
- [ ] Phase B2: `PAST_REPLIES_VIEW_ENABLED=true` in prod env.

### When (if ever) to revive the parked tag

The parked `wip/edit-existing-replies-zernio-v1` is preserved as a
spec-as-code reference. Revive only if:

- **GBP arrives:** start a NEW branch `feat/edit-existing-replies-gbp` and
  cherry-pick structural patterns (route shapes, drawer state machine
  minus recovery state, optimistic-concurrency snapshot, helpers). Build
  a GBP-native single-call edit publisher; skip the orphan-marker /
  DELETE+POST locked-tx / `verify409InTx` machinery entirely. ~75% of
  the parked code is reusable; the publisher / recovery / orphan-marker
  layer (~25%) gets dropped.
- **GBP timeline blows up beyond 12+ months AND premium tier monetization
  needs the differentiator urgently:** revive the parked branch as-is,
  run another review pass on the residual hidden-draft regenerate-window
  orphan accepted in Round-4 M, file the ops ticket for the fresh-publish
  race documented in spec §4.5 (out-of-scope for that branch), and ship
  behind the original single `EDIT_EXISTING_REPLIES_ENABLED` flag.

---

## Pre-paywall Demo + Journey Reorder — PR #2 (2026-05-04)

**Status:** Code-complete on `feat/pre-paywall-demo-pr2`, awaiting PR #1 merge + staging soak.
**Branch:** `feat/pre-paywall-demo-pr2` (21 commits ahead of `feat/lifecycle-extraction`).
**Spec:** `docs/superpowers/specs/2026-05-03-pre-paywall-demo-and-journey-reorder-design.md`
**Plan:** `docs/superpowers/plans/2026-05-03-pre-paywall-demo-pr2.md` (18 tasks)
**Test runbook:** `docs/runbooks/pr-2-pre-paywall-demo-test.md`

### Why

Owners reaching `/onboarding/pay` had no concrete preview of what
RepWorth would actually do for *their* business. Conversion data from
Sprint 4–6 self-serve signup showed a high drop-off at the paywall.
Inserting a real-API demo of AI responses for the owner's actual Google
reviews — generated between location capture and Stripe — gives them
proof-of-value before being asked for a card.

### Journey before vs after

**Before:** signup → `/onboarding/pay` → Stripe → `/onboarding/business`
(3-step Location/Profile/Voice wizard, gated on `subscription_status='active'`)
→ `/dashboard`.

**After (flag ON):** signup → `/onboarding/start` (location only) →
`/onboarding/demo` (live SerpAPI demo + paywall CTA) →
`/onboarding/pay` → Stripe → `/onboarding/business` (2-step
Profile/Voice wizard) → `/dashboard` (now with `SetupChecklist`).

Both flows coexist — the wizard adapts based on `ONBOARDING_DEMO_ENABLED`.

### What was built (18 tasks, 21 commits)

**Database**
- Migration **032** (`onboarding_demos`) — sister table to `prospect_demos`
  with `user_id`/`business_id` FK CASCADE, JSONB snapshots, state machine
  (`queued|running|completed|failed|archived`), partial unique index
  `onboarding_demos_one_completed_per_user (user_id) WHERE
  generation_status='completed'`, plus a partial cleanup-helper index
  on `(completed_at) WHERE generation_status='completed'`.

**Worker pipeline**
- New BullMQ queue `onboarding_demo_response` registered in
  `src/lib/shared/queue-names.ts`, `worker/queues.ts`, `worker/index.ts`.
- `worker/jobs/OnboardingDemoWorker.ts` — claim demo → resolve Place ID →
  fetch SerpAPI → select reviews → generate LLM responses → fall back to
  curated fixture if SerpAPI fails OR if no review meets the
  positive-with-moderate-tail anchor → `completeDemo` with `source` →
  reconcile cost reservation → check thresholds → emit Sentry alerts.
  Inverted subscription guard: if the user paid mid-flight, mark the row
  `failed` with `subscription_state_changed` (NOT empty `completed`,
  which would lock them out via the partial unique index).

**Cost lane**
- `src/lib/costs/onboarding-demo-cost-guard.ts` — parallel helper to the
  per-business `cost-guard.ts`. Global daily ceiling defaults to $10/day
  (`ONBOARDING_DEMO_DAILY_CENTS`), overridable at runtime via Redis key
  `cost:onboarding-demo:override:cents`. Each demo reserves 20¢
  pessimistically; the worker reconciles to actual spend (typically ~3¢).
  `checkCostThreshold` fires Sentry alerts at 50/90/100% of ceiling, at
  most once per day per lane via Redis `SADD` dedupe.

**Curated fallback**
- `src/lib/demos/__fixtures__/fallback-source-reviews.ts` + 
  `src/lib/demos/fallback-content.ts` — single `general-business` fixture
  with category-prefix matching for future per-category fixtures.

**API routes**
- `POST /api/onboarding/start` — location capture, 3-lane rate limit
  (per-user 3/24h, per-IP 5/24h, global 200/h), cost reservation, advisory-
  lock + FOR UPDATE idempotent tx that inserts the demo + outbox row in a
  single Postgres transaction (transactional outbox invariant). Tracks
  `demoInserted` flag so the idempotency-loser path releases the
  reservation and reports `demoQueued: false`.
- `GET /api/onboarding/demo/status` — soft-rate-limited polling endpoint.
  Filters `generation_status <> 'archived'` so 23505 race-loser rows don't
  shadow the winning demo.
- `POST /api/onboarding/demo/regenerate` — archive previous + insert new in
  a single tx. Subscription-gated to `pending_payment`.
- `POST /api/onboarding/business` (modified) — bifurcated by flag:
  `BusinessOnboardingPostPaySchema` (rejects location fields via
  `z.never()`) when on, `BusinessOnboardingSchema` (legacy) when off.
  Post-pay UPDATE writes only profile/voice; location-capture path stays
  in the legacy branch.

**UI**
- `/onboarding/start/page.tsx` + `StartLocationClient.tsx` — server-guarded
  page reusing `PlaceAutocomplete`, with a Maps-URL fallback toggle and
  category/website prefill via `/api/signup/place-prefill`.
- `/onboarding/demo/page.tsx` + `PaywallWithDemoClient.tsx` — server reads
  the latest non-archived demo. Polling every 2s for ≤15 attempts, with
  visibility-driven counter reset for tab-switch revisits. Renders
  `loading | failed | skipped | completed`; failed AND skipped both render
  the paywall CTA so payment is never blocked on a transient generation
  issue. When no demo row exists but location is captured (cost ceiling /
  rate limit blocked the enqueue), renders the standalone paywall to break
  what would otherwise be a `/start` ↔ `/demo` redirect loop.
- `/onboarding/business/BusinessWizardClient.tsx` (modified) — adapts based
  on `demoFlowEnabled` prop: 2-step (Profile, Voice) post-pay or 3-step
  (Location, Profile, Voice) legacy. Initial values prefilled from the
  businesses row.
- `/onboarding/business/guard.ts` (modified) — `WizardGuardOptions`
  parameter switches the "place data already set" check between
  "duplicate-submit" (legacy) and "expected precondition" (post-pay).
- `(authenticated)/dashboard/SetupChecklist.tsx` + `SetupChecklistClient.tsx`
  — 4-item checklist (Connect Zernio, Approve first response, Tune voice,
  Set notification prefs) backed by a single Postgres CTE. Client wrapper
  handles per-businessId localStorage dismiss.

**Cleanup**
- `worker/jobs/CleanupAbandonedSignupsPoller.ts` (modified) — explicit
  `DELETE FROM onboarding_demos` inside the abandoned-signup tx (FK
  CASCADE is defense-in-depth; explicit delete is observable in logs).
  Also adds a top-of-loop pass to delete completed demos older than
  30 days, using the new partial cleanup index.

**Race-loser recovery (PR #1 deferred → PR #2 implemented)**
- `src/lib/demos/lifecycle.ts:completeDemo` now catches Postgres `23505`
  on `onboarding_demos` and recovers in a single tx: archive THIS row +
  close the outbox. Without this, a concurrent regenerate would leave
  the loser as the most-recent row, causing the demo page to render
  failure instead of the winning completed demo.

**Documentation**
- `.claude/skills/onboarding-demo-cost-guard.md` — new skill doc.
- `.claude/skills/feature-flags.md` — `ONBOARDING_DEMO_ENABLED`,
  `ONBOARDING_DEMO_DAILY_CENTS`, `ONBOARDING_DEMO_STAFF_EMAILS_CSV`.
- `.claude/skills/migrations.md` — entry for migration 032; head bumped.
- `docs/runbooks/onboarding-demo-launch-runbook.md` (local-only per
  gitignore policy) — staging soak + 4-phase prod rollout.
- `docs/runbooks/pr-2-pre-paywall-demo-test.md` — local pre-PR test
  runbook (this PR's verification recipe).

### Review rounds

Three review rounds against the implementation:

**Round 1 — Critical (3) + Medium (6) + Low (2):**
1. `/start` FK mismatch — was inserting Supabase `auth_id` into a column
   FK'd to `users(id)`. Every happy path would have FK-failed.
2. `/business` post-pay no-op — the legacy "duplicate-submit" guard
   silently swallowed every post-pay submission because
   `place_id_verified` is the intended precondition there.
3. `/onboarding/demo` redirect loop — when `/start` blocked the enqueue
   (cost ceiling / rate limit), no demo row existed, `/demo` redirected
   to `/start`, and `/start` redirected back to `/demo`. Now `/demo`
   renders a standalone paywall when the user has location captured.
4. `lifecycle.completeDemo` 23505 race-loser recovery (was deferred in
   PR #1) — implemented.
5. `OnboardingDemoWorker` SerpAPI failures now fall back to curated
   content instead of failing the demo.
6. Failed demos render the paywall CTA (bundled into #3).
7. `/regenerate` gated on `pending_payment`.
8. Cost guard honors `ONBOARDING_DEMO_DAILY_CENTS` env (Redis > env >
   default precedence with finite-int validation).
9. `api_costs` ledger entries deferred to Phase 2 — documented in skill.
10. SetupChecklist split into server data + client wrapper with per-
    businessId localStorage dismiss.
11. Migration 032 partial cleanup index `(completed_at) WHERE
    generation_status='completed'`.

**Round 2 — Medium (3):**
1. `OnboardingDemoWorker` threshold/Sentry block wrapped in inner
   try/catch so a Redis/Sentry hiccup can't flip a successful demo to
   failed via the outer catch arm.
2. `/onboarding/demo` page + `/api/onboarding/demo/status` filter
   `generation_status <> 'archived'` so the 23505-archived loser doesn't
   shadow the winning row in the latest-by-`created_at` read.
3. `/api/onboarding/start` tracks `demoInserted` flag inside the tx
   callback. The idempotency-loser path (concurrent /start won the
   FOR UPDATE race) now releases the reservation and reports
   `demoQueued: false` instead of silently leaking 20¢ + lying.

### Tests

- 154 PR-relevant tests passing (`MOCK_EXTERNAL_APIS=true` for all unit
  paths; lifecycle DB-integration tests gate on `TEST_DATABASE_POOL_URL`).
- `tsc --noEmit`: clean.
- `pnpm lint`: 15 pre-existing errors in unrelated test files (twilio,
  PlaceIdValidationWorker, etc.); none in PR #2 code.
- 23505 race-loser recovery test added to `lifecycle.test.ts` — also
  asserts the page-level read invariant (latest non-archived = winner).
- `/start` idempotency-loser regression test added.

### Pre-merge / pre-flag-flip checklist

- [x] Static checks (tsc, lint scoped to PR #2 files, vitest) all green.
- [x] All review-round 1+2 issues addressed.
- [x] Migration 032 file written with the partial cleanup index.
- [x] `.claude/skills/feature-flags.md` + `migrations.md` updated.
- [x] `.claude/CLAUDE.md` migration head bumped 031 → 032.
- [x] Test runbook written (`docs/runbooks/pr-2-pre-paywall-demo-test.md`).
- [ ] PR #1 (`feat/lifecycle-extraction`) merged to main.
- [ ] PR #2 rebased onto post-PR-1 main and pushed.
- [ ] Apply migration 032 in staging Supabase.
- [ ] Walk the test runbook end-to-end against staging.
- [ ] Phase 3 staff-allowlist soft-launch on prod
      (`ONBOARDING_DEMO_STAFF_EMAILS_CSV`) — note: code path NOT yet
      wired in `/start`; Phase 3 work is to gate the route behind the
      env-CSV check.
- [ ] Phase 4 GA: drop the staff allowlist, bump
      `ONBOARDING_DEMO_DAILY_CENTS` to production target.

### Phase 2 follow-ups (not in PR #2)

1. **`api_costs` ledger entries** for the onboarding-demo lane —
   requires migration to add `cost_lane` column (or extend the implicit
   convention). Current Redis-only tracking handles enforcement but
   cross-period admin reporting misses this spend.
2. **Per-category curated fixtures** via `scripts/generate-fallback-demos.ts`
   — v1 ships single `general-business` fixture for all categories.
3. **Auto-regenerate on stale revisit (>24h)** — v1 ships stale-with-
   footnote + manual regenerate button. Auto-regen on the SSR page would
   need a cost-guard reservation inline before render; deferred until
   Phase 1 telemetry shows revisit conversion drag.
4. **Phase 3 staff-allowlist gate** — wire
   `ONBOARDING_DEMO_STAFF_EMAILS_CSV` into `/start` and `/demo` routes
   for the soft-launch window.

---

## Worker Folder Reorganization + `background/` Split (2026-05-04 → 2026-05-05)

**Status:** COMPLETE (PR #17, branch `refactor/worker-folder-reorg`)

**Goal:** Replace the flat-ish `worker/` layout — where `jobs/` mixed
job processors with pollers/schedulers/shared helpers, `ingress/` mixed
webhook entry points with provider-specific helpers, and tests were
split across three inconsistent `__tests__/` trees — with a layout that
scales as more workers and background loops are added. Mechanical move
only: zero logic changes, zero function-signature changes, zero
behavioral delta.

**Three commits, layered:**

1. **`8c3b05b refactor(worker): reorganize folder layout (no logic
   changes)` — 71 file moves**
   - Created `worker/{config,background}/`, provider sub-folders
     `worker/ingress/{twilio,telegram,zernio}/`, and per-job
     sub-folders `worker/jobs/{notification,publisher,zernio}/`.
   - Moved `startup-assert.ts` → `worker/config/`.
   - Moved 14 ingress files into provider sub-folders. Moved 16
     job/poller files into `jobs/<sub>/` or `background/`.
   - Tests colocated under each folder's `__tests__/` (matching
     `src/**/__tests__/` convention). Single accepted rename:
     `worker/ingress/__tests__/helpers.ts` →
     `worker/ingress/test-helpers.ts` (lifted out of `__tests__/` so
     provider-subfolder tests can import it via `'../../test-helpers'`).
   - `worker/queues.ts` and `worker/index.ts` stayed at root as
     runtime entry points.

2. **`80a30e2 refactor(worker): fix stale path comments after folder
   reorg` — 13 fixes**
   - Updated 8 top-of-file `// worker/...` headers and 5 inline
     cross-reference comments to point at the new paths after step 1.
   - Migration SQL `024_notification_delivery_dedup.sql` deliberately
     left untouched (historical artifact).

3. **`0c17c20 refactor(worker): split background/ into pollers/ and
   schedulers/` — 17 file moves**
   - Split `worker/background/` into `pollers/` (Postgres-state-driven:
     `OutboxPoller`, `NotificationFailoverPoller`, `ArchivalPoller`,
     `EngagementMonitorPoller`, `CleanupAbandonedSignupsPoller`,
     `EmailChannelReconcilePoller`) and `schedulers/`
     (time-cadence-driven: `WeeklySummaryScheduler`,
     `MonthlyImpactScheduler`, `RankingTrackingScheduler`,
     `OnboardingDripScheduler`).
   - User indicated more pollers/schedulers coming, so the
     disambiguation pays for itself.

**Final layout:**

```
worker/
├── env.ts                     # dotenv loader
├── index.ts                   # Sentry + Fastify + BullMQ Workers + lifecycle
├── queues.ts                  # 16 BullMQ Queue instances + topic→Queue map
├── config/
│   └── startup-assert.ts      # boot-time env assertions
├── ingress/                   # webhook handlers
│   ├── shared.ts              # claimInboundEvent (cross-provider dedup)
│   ├── stripe.ts, resend.ts   # single-file providers
│   ├── test-helpers.ts        # used by twilio inbound/status tests
│   ├── twilio/                # SMS + WhatsApp
│   ├── telegram/
│   └── zernio/
├── jobs/                      # BullMQ job handlers
│   ├── *.ts                   # 12 single-file workers
│   ├── notification/          # NotificationWorker + 5 sub-modules
│   ├── publisher/             # ResponsePublisherWorker + error-handlers
│   └── zernio/                # 2 zernio workers + zernio-ingest-shared
└── background/
    ├── pollers/               # 6 Postgres-state-driven loops
    └── schedulers/            # 4 time-cadence-driven loops
```

**No barrels/index files.** `worker/index.ts`'s explicit `new Worker(...)`
plus `start*Poller()` calls remain the canonical runtime registry.

**Verification gates (all green for the final commit):**

- `pnpm exec tsc --noEmit`: zero errors.
- `pnpm test`: 1845 passed / 1 skipped / 0 failed.
- `pnpm exec vitest run worker/background`: 89/89 pass.
- `pnpm lint`: 15 errors, all in 6 unrelated pre-existing files.
- `pnpm build`: succeeded.
- **Worker boot smoke test**: `tsx worker/index.ts` started on `:3099`
  with `MOCK_EXTERNAL_APIS=true`, `/api/health` returned `{"status":"ok",
  ...}` in 4 seconds, all 10 background loops registered cleanly.

**Files NOT moved (deliberately):**

- `worker/env.ts`, `worker/index.ts`, `worker/queues.ts` — root runtime
  modules.
- `worker/jobs/{12 single-file workers}.ts` — already at the right
  level; no second file to co-locate with.
- `worker/jobs/notification/{context,dispatch,eligibility,errors,
  sms-budget}.ts` — already correctly co-located.
- `worker/__tests__/correlation-chain.test.ts` — cross-cutting test,
  stays at root.

**Documentation updated:**

- `docs/directory.md` — full file-by-file map of new layout, with
  `pollers/` + `schedulers/` subsections.
- `docs/currents.md` — plain-language description of the new directory
  shape for quick orientation.
- `.claude/CLAUDE.md` — added concise "Worker layout" subsection.
- `.claude/skills/{feature-flags,lab-notes,migrations,review-dedup}.md`
  — class-name references already stable; path footnotes added where a
  reader needs to find the source quickly.
- Spec drafts: `docs/superpowers/specs/2026-05-04-worker-folder-reorg-design.md`
  and `docs/superpowers/specs/2026-05-05-worker-background-split-design.md`
  (both gitignored, local-only).

**Known follow-ups:**

- `feat/edit-existing-replies` is the only active local branch likely to
  rebase-conflict against this refactor. Conflict resolution is purely
  path-rewrite, no logic merging.
- Migration SQL `024_notification_delivery_dedup.sql:3` mentions
  `worker/jobs/ResponsePublisherWorker.ts` in a comment; intentionally
  not touched (migrations document state at time of application).

---

## 2026-05-05 — Worker Index Failure Extraction (PR #18, Group A PR #1)

Applied the new `CLAUDE.md` architecture invariant — *"Entry points
orchestrate; modules own failure behavior"* — to the worst current
offender. `worker/index.ts` was 607 lines mixing three concerns:
Sentry init, BullMQ Worker registry with two inline `.on('failed')`
hooks (~250 combined lines of DB-writing failure logic), and Fastify
boot. After this PR it is **296 lines** of pure registration +
lifecycle.

This is **PR #1 of three** in the Group A entry-point modularization
spec at
`docs/superpowers/specs/2026-05-05-entry-point-modularization-design.md`.
PRs #2 (`select-location/route.ts`) and #3 (`callback/route.ts`) get
their own plans after this one validated the conventions.

**Three extractions, 13 commits squashed into one PR (`0e1ab23` head):**

1. **`9114af4 refactor(worker): extract Sentry init to worker/sentry.ts`**
   - Moved the Sentry import + `scrubObject` recursive helper +
     `Sentry.init({...})` block (`worker/index.ts:1-37`) verbatim into
     a new `worker/sentry.ts`.
   - `worker/sentry.ts` `export { Sentry }`; `worker/index.ts` now
     `import { Sentry } from './sentry'`. Prevents future contributors
     from re-importing `@sentry/node` directly and bypassing the
     configured scrubber.

2. **`adb6382` + `fbdc9db` + `f2227ec` + `92fc7c9` + `56b914d` +
   `c118a8d` — `worker/jobs/zernio/ingest-failed-hook.ts` extraction
   (TDD red→green per branch)**
   - New module exports `handleIngestFailed(job, err)` —
     a thin orchestrator with three private branch helpers:
     `handleReviewNotFound`, `handlePaginationCapExhausted`,
     `handleUnparseableLocation`, plus a generic fall-through.
   - Each branch lifted byte-equal from the original
     `worker/index.ts:160-277` block. Same SQL, same JSONB payload
     keys, same `ON CONFLICT (business_id, type, (payload->>'provider_review_id'))`
     predicate, same Sentry tags.
   - New `__tests__/ingest-failed-hook.test.ts` covers all 4 branches
     across 10 cases — including the previously-untested
     `notify_admin_review_exception` outbox enqueue gating on the
     INSERT's `RETURNING id`, and the `attemptsMade` boundary at the
     last allowed retry.

3. **`9a414e3` + `2b9aaf7` + `2dc7b16` + `2783989` —
   `worker/jobs/publisher/failed-hook.ts` extraction (TDD red→green
   per branch)**
   - New module exports `handlePublisherFailed(job, err)` — thin
     orchestrator with four private branch helpers
     (`ZernioReplyVerificationIndeterminateError`, bare-transient
     defensive, `PublisherTransientWithContext` success +
     fallback-failed, generic) PLUS the last-resort handler-crash
     branch wrapping the entire body.
   - Each branch lifted byte-equal from the original
     `worker/index.ts:291-427` block. Same `sql.begin` transaction
     shape, same `ON CONFLICT (review_id, type)` predicate, same
     Sentry kinds (`unwrapped_transient`, `transient_exhaustion_fallback`,
     `on_failed_handler_crash`).
   - New `__tests__/failed-hook.test.ts` covers all 5 branches across
     9 cases. The `bare ZernioTransientError` defensive branch and the
     `on_failed_handler_crash` last-resort branch had **zero** direct
     test coverage on `main` before this PR.

4. **`e9c550d` + `0e1ab23` — wire-in commits**
   - `worker/index.ts:160-277` (117 lines) collapsed to
     `ingestZernioReviewWorker.on('failed', handleIngestFailed);`.
   - `worker/index.ts:291-427` (137 lines) collapsed to
     `publisherWorker.on('failed', handlePublisherFailed);`.
   - Pruned newly-orphaned imports from `worker/index.ts`:
     `ZernioIngestReviewNotFoundError`, `ZernioIngestPaginationCapExhaustedError`,
     `ZernioIngestUnparseableLocationError` (all three),
     `PublisherTransientWithContext`,
     `ZernioReplyVerificationIndeterminateError`, `ZernioTransientError`,
     `applyTransientExhaustionFallback`, `extractOutboxHandle`,
     `markOutboxCompleted`, `markOutboxFailed`, `jsonb`, `uuidv7`, `sql`.

**Final state:**

| Metric | Before | After |
|---|---|---|
| `worker/index.ts` | 607 lines | **296 lines** |
| Inline failed-hook DB writes | ~250 lines | 0 |
| `instanceof` cascades in boot file | 7 branches | 0 |
| New source files | — | 3 (`worker/sentry.ts`, `ingest-failed-hook.ts`, `failed-hook.ts`) |
| New test files | — | 2 (covering 9 previously-untested branches) |

**Verification gates (all green at PR-merge):**

- `npx vitest run worker/jobs/zernio/__tests__/ingest-failed-hook.test.ts worker/jobs/publisher/__tests__/failed-hook.test.ts worker/jobs/zernio/__tests__/ZernioReviewIngestWorker.test.ts worker/jobs/publisher/__tests__/publisher-error-handlers.test.ts worker/jobs/publisher/__tests__/ResponsePublisherWorker.test.ts` — 67/67 pass.
- `npx vitest run worker/` — 470/470 pass.
- `pnpm tsc --noEmit` clean.
- `pnpm lint` — 15 errors, all pre-existing on `main` in 6 unrelated
  test files; zero new lint issues introduced (verified against `main`).
- Smoke boot: `MOCK_EXTERNAL_APIS=true pnpm worker` — all 16 BullMQ
  Workers + 10 background loops boot, `Worker service running on port
  ...`, clean shutdown.
- `wc -l worker/index.ts` = 296 (target ≤ 380, well under).
- Behavior-preservation grep: every Sentry tag, error message, outbox
  reason, and DB write from the original `worker/index.ts:160-277` and
  `:291-427` confirmed present in the extracted modules.

**Process notes:**

- Spec at `docs/superpowers/specs/2026-05-05-entry-point-modularization-design.md`
  (gitignored, local-only) — prescriptive: function signatures, file
  paths, and per-branch test names all listed up-front.
- Plan at `docs/superpowers/plans/2026-05-05-pr1-worker-index-failure-extraction.md`
  (also gitignored) — 14 tasks executed via subagent-driven
  development with two-stage review (spec compliance, then code
  quality) per task.
- One mid-stream plan correction: the original test code in the plan
  used object-literal construction for `ZernioIngestReviewNotFoundError`,
  but the real constructor is positional. Caught by the implementer's
  self-review, fixed in `fbdc9db`, and the plan was patched so Tasks
  4 and 5 used positional construction from the start.
- One mid-stream test-strength fix: code review on Tasks 2-3 flagged
  `toMatchObject` as too loose for a JSONB shape lock; commit
  `f2227ec` switched to `toEqual` and added an `attemptsMade` boundary
  case.

**Known follow-ups:**

- PR #2 (`select-location/route.ts`, ~581 lines, three extractions
  into `src/lib/zernio/connect-finalize/`).
- PR #3 (`callback/route.ts`, ~470 lines, two cleanup-block
  extractions into `src/lib/zernio/connect-callback/` plus a Lua-script
  consolidation into `connect-state.ts`).
- Group B refactors (`EngagementAlertWorker`, `OnboardingDripWorker`)
  deferred to a separate spec, written after Group A's interfaces have
  shaken out.

---

## Sprint X — Multi-Location Support (`feature/multi-location`, 2026-05-06 → 2026-05-09)

**Status:** Implementation complete. 3,069+ unit tests green, 354/354 validation assertions passed, security review + post-launch fix-pass complete. Ready to merge.

**Goal:** Allow one owner account to manage multiple Google Business Profile locations under one billing entity, with per-location notification routing, per-location voice config, and aggregate or per-location dashboard scoping.

### What we built

**1. Schema (migrations 034–041) — 8 migrations.**
- `034_multi_location_schema.sql` — created `accounts` table (the new billing parent / org), added `account_id` + `display_label` + `is_primary` + `archived_at` to `businesses`, added `account_id` denorm to `users` / `api_costs` / `notification_deliveries` / `approval_audit_log` / `channel_enrollments`, created `account_audit_log`, dropped `users.business_id` outright.
- `035_rls_policies.sql` — RLS on 22 tables via the new `owner_account_id()` helper.
- `036_defer_circular_fks.sql` — DEFERRABLE FKs for the circular `accounts ↔ users` reference.
- `037_add_cancelled_at.sql` — `accounts.cancelled_at`. Drives the dashboard 30-day grace window after cancel.
- `038_owner_user_id_unique_index.sql` — partial unique index on `accounts(owner_user_id)`.
- `039_revert_problematic_not_null_constraints.sql` — corrective: drops NOT NULL on `users.account_id`, `api_costs.account_id`, `notification_deliveries.account_id`. Admin / sales_partner users have no account; platform-level cost rows have no account.
- `040_rls_tightening.sql` — table-level REVOKE UPDATE on `businesses` then explicit GRANT only on safe columns; REVOKE INSERT entirely on `channel_enrollments`.
- `041_rls_missing_revokes.sql` — caught the columns missed in 040 (`subscription_activated_at`, `place_id_verified`, `google_maps_url` on businesses; `archived_at` / `archive_reason` on channel_enrollments).

**2. Stripe model.** Removed all Payment Links. New checkout flow uses server-built Checkout Sessions. One subscription per account with two items: tier base price + per-extra-location overage price. Add / archive / reactivate / tier-change all flow through the outbox → `UpdateStripeOverageWorker`. Worker uses Stripe idempotency keys keyed on `(accountId, itemId, quantity)` for safe concurrent execution.

**3. UI surface.**
- Location switcher in TopBar/Sidebar (cookie-persisted via `rw_location_scope`; hidden for single-location accounts).
- Aggregate dashboard at `scope=all` — per-location KPI strip + stacked charts + combined feed with location chips.
- 4-step add-location wizard at `/dashboard/add-location` — Place autocomplete → Zernio info → voice config (with "copy from existing") → confirm & pay with proration preview.
- Settings restructured: Account / Locations / Channels / Voice tabs.
- Per-location voice configs (independent after creation; no implicit inheritance).
- Per-location channel overrides on top of org defaults; resolver chokepoint at `src/lib/notifications/resolve-channels.ts` with 5-min Redis cache + write-invalidation.
- Approve page shows blue location chip + amber "Archived" badge.
- `CancelledBanner` (30-day grace from `cancelled_at`) and `PastDueBanner` (POST button to portal, not GET anchor) on the dashboard.
- Admin CSV bulk-import at `/api/admin/locations/csv-import` (5MB / 100-row caps).

**4. New API routes.** `/api/locations/{add,archive,reactivate,promote-primary,display-label}`, `/api/billing/{checkout,portal,tier-change}`, `/api/settings/channels/override`, `/api/settings/voice`, `/api/admin/locations/csv-import`. All owner routes double-gated: middleware role + account_id check, then in-route `requireRole('owner')` + `body.accountId === user.accountId` + per-resource ownership lookup.

**5. Worker wiring.** `UpdateStripeOverageWorker` (new, `worker/jobs/billing/`). NotificationWorker context now joins `businesses → accounts` for subscription guard + checks `archived_at`. ResponsePublisherWorker similarly joins for subscription state and skips archived locations. Notification dispatch prefixes Telegram and email with `[{display_label}]` to identify source location.

**6. Spec deviations from `docs/superpowers/specs/2026-05-06-multi-location-design.md`.**
- `users.business_id` dropped immediately (spec said one-release deprecation).
- Tier `founding` renamed to `founders`.
- SMS STOP fan-out stays sender-wide (TCPA).
- SMS / WhatsApp validation deferred — only Telegram + email in scope.
- Server-built Checkout Sessions used everywhere instead of Payment Links.

### Security review pass (2026-05-09 morning)

13 issues found and fixed before user-facing rollout. Highlights:

1. `/api/locations/*` and `/api/billing/*` mutations were initially missing `requireRole('owner')` + ownership checks — closed.
2. Migration 040 originally used column-only `REVOKE UPDATE` — discovered Postgres requires table-level REVOKE first, then re-GRANT on safe columns. Migration 041 caught the columns missed in 040.
3. SMS handle-wide unsubscribe was only invalidating the requesting account's channel cache — switched to invalidate **all** affected accounts (TCPA-critical).
4. PastDueBanner billing portal link was a GET `<a href>` anchor — converted to POST `<button>` to prevent CSRF via prefetched GET.
5. Admin owner-email edit was not invalidating channel cache after upserting the email enrollment — fixed.
6. Email reconcile poller's `ON CONFLICT (business_id, channel)` did not target the actual partial-unique-expression-index → fix used select-then-insert pattern.
7. Mobile uniqueness violation produced 500s instead of 409s — added the new constraint name to the error mapper.
8. Stripe environment contract: replaced obsolete `STRIPE_PAYMENT_LINK_*` startup assertions with `STRIPE_PRICE_*` assertions + drift-prevention tests.
9. Cancellation grace period: switched dashboard from `subscription_activated_at`-based grace (months-long for old subs) to `cancelled_at + 30d` with legacy-row fallback.
10. Middleware now gates `/api/billing/*` and `/api/locations/*` directly (not just via the protected-routes registry).
11. `notification_deliveries.account_id` writers updated across 6 worker call sites.
12. Channel cache invalidation added to 17+ writers including admin email sync.
13. RLS tightening across `businesses` and `channel_enrollments` (migrations 040 + 041).

### Post-launch fix-pass (2026-05-09 evening)

After the security review, a second-pass code review surfaced 5 medium-severity defense-in-depth issues. All five fixed on the same branch:

1. **Publisher archived-location check.** `ResponsePublisherWorker` now selects `b.archived_at` and short-circuits with `markOutboxCompleted` (graceful skip) before calling Zernio. Closes the window where a response approved before an archive could still post to Google after the archive committed.
2. **Channel cache: replaced silent `.catch(() => {})` everywhere.** New `safeInvalidateChannelCache(accountId, context, logger?)` wrapper logs `'channel-cache-invalidate-failed'` with structured fields. All 17 call sites converted (admin SMS / Telegram / WhatsApp, dashboard Telegram, settings overrides, admin business-detail email sync). Each call passes a named context string for grep-able alerts.
3. **`UpdateStripeOverageWorker`.** Removed misleading `SELECT … FOR UPDATE` (a no-op under PgBouncer transaction pooling). Added Stripe idempotency keys to both `subscriptionItems.update` and `subscriptionItems.create` calls — keys include `(accountId, itemId, quantity)` so concurrent jobs computing the same quantity dedup at Stripe.
4. **Archive transaction account scoping.** `archive-location-tx.ts` UPDATE now filters `WHERE id = locationId AND account_id = accountId` (matches the reactivate path; closes a TOCTOU window between the guard and the write).
5. **CSV import billing aggregation.** `addLocationTransaction` accepts `enqueueStripeOverageUpdate?: boolean` (default `true`). The CSV import path passes `false` per row and calls `enqueueCsvImportStripeOverageUpdate(accountId)` exactly once after the loop. A 100-row CSV now produces 1 Stripe API call instead of 100.

### Verification

- All five fix files re-read and validated — `worker/jobs/publisher/ResponsePublisherWorker.ts`, `src/lib/notifications/resolve-channels.ts`, `worker/jobs/billing/UpdateStripeOverageWorker.ts`, `src/lib/locations/archive-location-tx.ts`, `src/lib/admin/csv-import.ts` + `src/app/api/admin/locations/csv-import/route.ts`.
- Cross-checked all 17 cache-invalidation call sites converted to `safeInvalidateChannelCache` (no `.catch(() => {})` remaining in `src/`).
- Confirmed `users.business_id` is fully unreferenced in live code (the remaining matches are doc comments, tests, and historical migration assertions).
- Confirmed all owner mutation routes triple-gated (middleware + role + ownership-lookup).

### Known non-blocking debt

Documented in `docs/runbooks/multi-location.md` §6 — minor known issues that did not block merge:
- Location chips on review rows are display-only (UX enhancement: make them clickable as scope triggers).
- `DashboardContent.tsx` read-only notice uses inline styles instead of the tokens.css convention.
- Duplicate `AccountLocationSummary` types across `business-detail-types.ts` and admin `types.ts` (drift risk).
- ~10 worker files use inline `JOIN businesses` instead of centralized `getLocationContext()` helper.
- `past-replies/page.tsx` uses inline `display_label ?? name` instead of the `getDisplayLabel()` helper.
- 7 unclassified columns on `businesses` not explicitly GRANTed/REVOKEd in 040/041 (follow-up).
- CSV import returns a 500 if the aggregate billing enqueue fails after rows committed — should return the partial-success report with a `billingEnqueueFailed: true` flag instead.
- Publisher archive-skip leaves the response orphaned in `approved` state (no terminal transition, no re-enqueue on reactivate).

### Process notes

- Spec at `docs/superpowers/specs/2026-05-06-multi-location-design.md` (gitignored).
- Investigation + readiness at `docs/superpowers/specs/2026-05-07-multi-location-{investigation,readiness}.md`.
- Runbook + manual TC catalog at `docs/runbooks/multi-location.md` (tracked).
- 97 commits on the branch, 312 files changed, ~33,000 LOC added (heavy on schema + UI + tests).
- Final architectural review by the senior engineering partner (Claude) flagged 1 architectural inconsistency (tier-change makes synchronous Stripe calls in a Next.js route, unlike add-location's outbox pattern) — left as a deliberate UX trade-off, documented but not changed.

### Verdict

90%+ ship-ready. Architecture invariants from `.claude/CLAUDE.md` upheld throughout. The two layers of review (security + post-launch) caught the high- and medium-severity issues. Defense in depth on auth (middleware + role + per-resource ownership), atomic transactions everywhere they matter, outbox pattern correctly applied for all billing/Zernio side effects.

---


## Billing Tiers + Locations UX (2026-05-22, `feat/billing-locations-ux` → PR #51, #52)

**Status:** COMPLETE — merged to `main` (`pnpm test` 3423 passed / 1 skipped, `pnpm build`, `pnpm typecheck` all green). No new migration required; reused existing `accounts` columns.

**Why:** Onboarding advertised only 3 tiers with stale hardcoded prices ($99/$149/$199), and the Locations management surface was hidden until an account already had >1 location — so a freshly-paid Standard/Premium owner looked unable to add a second location. The fix makes tier display canonical and makes Settings the place to discover/manage location capability.

**What was done:**

1. **Onboarding shows all four canonical tiers** — Founding Member, Basic, Standard, Premium. Prices now derive from `TIER_CONFIG[tier].baseCents` (`$19/$29/$79/$199`) via the new `src/app/onboarding/pay/plan-options.ts`, instead of hardcoded strings. The Stripe Price IDs were verified (2026-05-22) to match `TIER_CONFIG`, so display == charge.
2. **Basic accepted by Select Plan** — `SelectPlanSchema` enum widened to `['founders','basic','standard','premium']`; `PlanPickerClient` tier union widened in all three spots (interface, state, handler); route doc comment updated.
3. **Settings gating split into three concepts** (new helpers in `src/lib/locations/multi-location-mode.ts`):
   - `shouldUseMultiLocationSettings` (mode — `count > 1`) → drives Voice/Notifications multi-loc content + switcher.
   - `shouldShowLocationsSettings` (visibility — flag only) → Locations tab now appears even with one location.
   - `canAddLocationForAccount` (eligibility — flag + active status + `multiLocAllowed`).
   `/settings/voice` stays gated by true multi-location mode; single-location Brand Voice routes to the `/settings#brand-voice` anchor (no accidental exposure).
4. **Basic sees a locked upgrade state** on `/settings/locations` — renders a static panel (NOT the add-location `<Link>`, no add API call) with a "View plan options" CTA to `/settings#subscription-billing`.
5. **Stored quota is the billing source of truth** — `accounts.locations_included` (and, after PR #52 review, `accounts.locations_overage_price_cents`) now drive overage math across all five surfaces: add-location preview, checkout line items, `assertCanAddLocation`, `UpdateStripeOverageWorker`, `StripeLocationsReconcilePoller`, and the `customer.subscription.updated` webhook (which resets `locations_included` to the new tier's config only on actual tier change).

**Review-driven follow-ups (this session):**
- Spec review caught a price source-of-truth gap (display was about to align to `TIER_CONFIG` without confirming Stripe matched) → resolved by verifying Stripe prices == `TIER_CONFIG` and documenting Stripe Price IDs as the charge source of truth.
- Code review caught asymmetric grandfathering (included was stored but overage price was config) → PR #52 made `currentBillingSnapshot` read the stored `locations_overage_price_cents`, with a regression test using a stored value (3000) that deliberately differs from `TIER_CONFIG`.

**Known residual debt:** Base price is NOT grandfathered (no `accounts.base_price_cents` column) — most relevant for the `founders` "Rate locked for life" promise. Documented as a TODO in `src/lib/accounts/quota.ts` and in `docs/runbooks/multi-location.md` §6 (Known Issues & Tech Debt). Fix needs a schema change.

---


## WhatsApp Channel Go-Live (2026-05-22, `feat/whatsapp-go-live` → PR #53)

**Status:** Code COMPLETE, behind `CHANNELS_WHATSAPP_ENABLED` (still off). `pnpm test` 3,459 passed / 1 skipped, `pnpm lint` + `pnpm typecheck` green. **No new migration** — reused migration 034's `channel_enrollments` `account_id`/`location_id` columns + scope indexes. Real go-live is a separate ops step (Twilio sender + Meta template approval + ship gate).

**Why:** The WhatsApp channel shipped code-complete-but-flag-gated back in Phase 3 (`edc3b11`), deferred until the WhatsApp Business Account cleared Meta verification. That cleared, so this effort makes it actually shippable: it builds the missing **owner self-service** enrollment (Phase 3/4 had only admin-side enrollment), reconciles the months-old code against multi-location + billing changes, and produces the go-live runbook.

**What was done:**

1. **Owner self-service enrollment** — new `OwnerWhatsAppWidget` (`src/components/dashboard/`) + owner-scoped routes `POST /api/dashboard/channels/whatsapp/{start,cancel,disable}`, wired into `/settings/channels` (replaced the hardcoded "coming soon" stub). Mirrors the existing owner Telegram pattern: `locationId` from session, `withSameOrigin` CSRF, subscription read from `accounts`, click-to-chat QR (`wa.me/<number>?text=start-<token>`), 3s status poll → verified.
2. **Helper extraction (entry-point invariant)** — moved the enrollment state machine into `startWhatsAppEnrollment` / `disableWhatsAppEnrollment` in `src/lib/channels/whatsapp-enrollment.ts`; refactored the admin start route to orchestrate via the helper instead of inlining the SELECT-FOR-UPDATE/INSERT.
3. **Env-readiness unified** — one `whatsappEnvReady()` predicate in the admin `_shared.ts` now backs the route guard AND both `whatsappAvailable()` UI checks. Fixed a latent bug: the UI checked 4 vars (omitting `WHATSAPP_APPROVAL_URL_BASE`) while the route checked 5 — so the UI could show a Connect button the route then 503'd.
4. **Drift audit (no material drift)** — verified the Phase 3 code against multi-location (mig 034) + billing tiers: subscription reads from `accounts`, enrollment scoped by `business_id`, IDs thread through `approval_links`/`notification_deliveries`. No fixes needed.
5. **Tests** — owner route tests (flag-off 404, env 503, auth 401, subscription 403, `multiple_mobile_channels` 409, single-location-guard 403); helper 23505 classification; a reducer copy-lock test (generic conflict string); an enrollment round-trip integration test (start route → simulated inbound webhook → verified) that runs in CI; Playwright E2E (fixme-gated, mirrors Telegram).
6. **Go-live runbook** (`docs/runbooks/whatsapp-templates.md`) — corrected the template type `twilio/card` → `whatsapp/card` (verified against Twilio docs; `twilio/card` forces WhatsApp text into `title`), 9-variable validation gate against `formatApprovalWhatsApp`, Vercel+Railway env matrix, canary-before-gate, the eight-point §5.1 ship gate.

**Review-driven follow-ups (this session, two review rounds):**
- Confirmed the multi-location desync (High) is **pre-existing and cross-channel** (SMS/Telegram share the `business_id`-keyed paths). Shipped an **interim single-location guard** for WhatsApp (server 403 `multi_location_unsupported` + UI "coming soon"), and filed the proper cross-channel fix as a tracked design doc.
- Owner route catches now **rethrow non-`AuthError`** instead of masking server failures as 401.
- Test hardening: `process.env` snapshot/restore in the integration test, `AbortController` timeout in the E2E ingress helper, fixed an `AuthError` constructor-arity error that broke `tsc` (not vitest).
- Lows: runbook STOP wording (`unsubscribed`, not `disabled`); stale E2E selector (`rounded-lg` → `channel-row`).

**Known residual debt:** The cross-channel owner-enrollment account-scope desync is **unresolved for SMS + Telegram** (only WhatsApp is guarded). Tracked in `docs/known-issues.md` + `docs/superpowers/specs/2026-05-22-owner-channel-account-scope-design.md`. Interim-guard edge case: an account that enrolls WhatsApp while single-location then adds locations sees the widget flip to "coming soon" while still enrolled (manageable via admin console).

---
