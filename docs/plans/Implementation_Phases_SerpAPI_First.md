# Implementation Phases — SerpAPI-First MVP

_Context: GBP API access has been applied for but is not yet approved. All phases below assume SerpAPI for review reading and manual copy-paste for response posting. When GBP API access arrives, Phase 5 upgrades the pipeline to automated ingestion and posting._

_Reference: 04-final-plan.md (Revised v2 — scale-first architecture)_

_Execution note: use the runtime-boundary overrides in `docs/Final_Implementation_Plan.md` as the implementation authority. In particular: demo generation should run asynchronously on Railway, and production webhooks should terminate on Railway directly rather than proxying through Vercel._

---

## Background Process: GBP API Application (runs in parallel with all phases)

This is not a phase — it's a background task you start on Day 0 and check weekly.

- [ ] Create a Google Cloud project at console.cloud.google.com
- [ ] Set up an OAuth consent screen (External, Testing mode — allows up to 100 test users)
- [ ] Submit the GBP API access request form: https://docs.google.com/forms/d/e/1FAIpQLSdJFfDSekwTMBEIbMFBj1MRmviRnECrTjRDX1yo_HM-bRGWbQ/viewform
  - Select "Application for Basic API Access"
  - Use your business domain email (not Gmail)
  - Project number: find it in your GCP project dashboard under "Project info"
  - Description: "We are building a review management platform that helps single-location small businesses respond to Google reviews. We use the API to read reviews and post owner replies on behalf of authenticated business owners via OAuth consent. Expected initial scale: 10-20 business locations."
- [ ] Ensure your company website is live (even a one-page Vercel landing page counts)
- [ ] Ensure your Google Business Profile is as complete as possible (logo, description, services, photos)
- [ ] Check approval status weekly: go to GCP Console → APIs & Services → Dashboard → check if Business Profile APIs appear in the list
- [ ] When approved: jump to Phase 5 (can be done in parallel with any current phase)

**Important**: Google requires the GBP to be verified and active for 60+ days. If your profile is brand new, approval may be delayed. Do NOT let this block you — the entire MVP runs on SerpAPI until approval arrives.

---

## Phase 1: Project Scaffolding + Infrastructure (Days 1–2)

### Goal
Empty application is live at production URLs with all database tables created, both Redis instances provisioned, and the worker service deployed. Nothing works yet — this is pure plumbing.

### Day 1: Repository + Database

**1.1 Initialize the monorepo**
```bash
npx create-next-app@14 ai-review-responder --typescript --tailwind --app --src-dir
cd ai-review-responder
pnpm add zustand @tanstack/react-query react-hook-form zod
pnpm add -D vitest @playwright/test
```

**1.2 Set TypeScript to strict mode**
In `tsconfig.json`:
```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "forceConsistentCasingInFileNames": true
  }
}
```

**1.3 Set up the project directory structure**
Create these directories to match the module boundaries from the plan:
```
src/
├── app/                          # Next.js App Router pages
│   ├── (public)/
│   │   ├── page.tsx              # Landing page
│   │   ├── demo/[slug]/
│   │   │   └── page.tsx          # Prospect demo viewer (SSR)
│   │   └── approve/[token]/
│   │       └── page.tsx          # Approval interface
│   ├── (authenticated)/
│   │   ├── dashboard/
│   │   │   └── page.tsx          # Business owner dashboard
│   │   └── settings/
│   │       └── page.tsx          # Business owner settings
│   └── (admin)/
│       ├── overview/
│       │   └── page.tsx          # Sales partner CRM view
│       ├── businesses/
│       │   ├── page.tsx          # Business list
│       │   └── [id]/
│       │       └── page.tsx      # Single business detail
│       ├── demos/
│       │   └── page.tsx          # Demo generation + tracking
│       ├── notifications/
│       │   └── page.tsx          # Notification delivery log
│       └── costs/
│           └── page.tsx          # Cost monitoring
├── lib/
│   ├── db/                       # Supabase client, query helpers
│   ├── reviews/                  # ReviewSource interface, SerpAPI impl
│   ├── responses/                # Response generator, prompt builder
│   ├── approval/                 # Approval service, token management
│   ├── notifications/            # Email (Resend), SMS (Twilio)
│   ├── publishing/               # Google posting (stub for now)
│   ├── costs/                    # Cost tracker, circuit breaker
│   ├── demos/                    # Demo generation pipeline
│   └── shared/                   # Utilities, types, constants
├── worker/                       # Railway worker service (separate entry point)
│   ├── index.ts                  # Worker entry point
│   ├── queues.ts                 # BullMQ queue definitions
│   ├── jobs/
│   │   ├── ReviewSyncWorker.ts
│   │   ├── ResponseGeneratorWorker.ts
│   │   ├── NotificationWorker.ts
│   │   ├── ResponsePublisherWorker.ts
│   │   ├── WeeklySummaryWorker.ts
│   │   └── OutboxPoller.ts
│   └── ingress/
│       ├── pubsub.ts             # Pub/Sub handler (stubbed for now)
│       ├── stripe.ts             # Stripe webhook handler
│       └── twilio.ts             # Twilio delivery webhook
└── types/
    └── index.ts                  # Shared TypeScript interfaces
```

**1.4 Create the Supabase project**
- Go to supabase.com, create a new project
- Note down: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_KEY`
- Go to Settings → Database → Connection Pooling → Enable PgBouncer
- Note down: `DATABASE_URL` (direct) and `DATABASE_POOL_URL` (pooled)

**1.5 Run database migrations**
Create a file `supabase/migrations/001_initial_schema.sql` containing ALL the SQL from Section 5 of the final plan:
- `businesses` table
- `google_connections` table (will remain empty until GBP API is approved — that's fine)
- `reviews` table
- `responses` table
- `approval_links` table
- `users` table
- `inbound_events` table
- `job_outbox` table
- `notification_deliveries` table
- `prospect_demos` table
- `weekly_summaries` table
- `api_costs` table
- `review_exceptions` table
- All indexes from the plan

Run via Supabase CLI:
```bash
npx supabase db push
```

Or directly via the Supabase SQL editor in the dashboard.

**1.6 Seed the database with initial data**
```sql
-- Create your admin user
INSERT INTO users (name, email, role) 
VALUES ('Norbert', 'your@email.com', 'admin');

-- Create your sales partner user
INSERT INTO users (name, email, role) 
VALUES ('YourPartnerName', 'partner@email.com', 'sales_partner');
```

### Day 2: Redis + Worker + Deployment

**2.1 Provision two Upstash Redis instances**
- Go to upstash.com, create two separate Redis databases:
  - `review-responder-cache` — for rate limits, cost tracking, retry cache
  - `review-responder-queue` — for BullMQ job queue
- Note down both `REDIS_CACHE_URL` and `REDIS_QUEUE_URL`

**2.2 Set up the worker service**
Install BullMQ dependencies:
```bash
pnpm add bullmq ioredis
```

Create `worker/index.ts` as a standalone Node.js process:
```typescript
// This is the entry point for the Railway worker service.
// It runs: OutboxPoller (10s interval), BullMQ consumers, and cron jobs.
// It does NOT serve web pages — that's Vercel's job.
import { Worker } from 'bullmq';
import { Redis } from 'ioredis';

const connection = new Redis(process.env.REDIS_QUEUE_URL!);

// For now, just log that the worker started
console.log('Worker service started');

// Health check endpoint for Railway
import { createServer } from 'http';
createServer((req, res) => {
  if (req.url === '/api/health') {
    res.writeHead(200);
    res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
  }
}).listen(process.env.PORT || 3001);
```

**2.3 Create the .env.local file**
```env
# Database (Supabase)
DATABASE_URL=               # Direct connection (for migrations only)
DATABASE_POOL_URL=          # Pooled connection (for application use)
SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_KEY=

# Redis — TWO separate instances
REDIS_CACHE_URL=
REDIS_QUEUE_URL=

# LLM
OPENAI_API_KEY=
ANTHROPIC_API_KEY=

# Review data (demo engine + production monitoring for now)
SERPAPI_API_KEY=

# Notifications (add when building Phase 3)
RESEND_API_KEY=
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_PHONE_NUMBER=

# Payments (add when building Phase 4)
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=

# Security
ENCRYPTION_KEY=             # Generate a random 32-byte hex string
ENCRYPTION_KEY_VERSION=1

# App
NEXT_PUBLIC_APP_URL=        # e.g., https://yourapp.vercel.app
WORKER_SERVICE_URL=         # Railway worker URL (for internal calls)

# --- Added in Phase 5 (GBP API) ---
# GOOGLE_CLIENT_ID=
# GOOGLE_CLIENT_SECRET=
# GCP_PROJECT_ID=
# GCP_PUBSUB_TOPIC=
# GCP_PUBSUB_SUBSCRIPTION=
# GCP_SERVICE_ACCOUNT_KEY=

# --- Added in Phase 6 (Monitoring) ---
# POSTHOG_API_KEY=
# BETTERSTACK_SOURCE_TOKEN=

# --- Configurable (defaults in code) ---
# OUTBOX_BATCH_SIZE=50
# DAILY_COST_LIMIT_CENTS_FOUNDING=500
# DAILY_COST_LIMIT_CENTS_STANDARD=1000
# GLOBAL_DAILY_COST_LIMIT_CENTS=10000
```

**2.4 Deploy skeleton to Vercel**
```bash
vercel --prod
```
Verify: `https://yourapp.vercel.app` loads the default Next.js page.

**2.5 Deploy worker skeleton to Railway**
- Create a new Railway project
- Connect your GitHub repo
- Set the start command to: `npx ts-node worker/index.ts` (or use a build step)
- Add all environment variables
- Verify: `https://yourworker.railway.app/api/health` returns `{"status":"ok"}`

### Phase 1 Done When
- [ ] Next.js app is live on Vercel
- [ ] Worker service is live on Railway
- [ ] All 13 database tables exist in Supabase
- [ ] Both Redis instances are provisioned and connectable
- [ ] Admin and sales partner users exist in the `users` table
- [ ] `.env.local` has all required variables

---

## Phase 2: Demo Engine + Prospect Demo Generator (Days 3–5)

### Goal
Your sales partner can paste a Google Maps URL into an admin page, and within 60 seconds get a shareable link showing that business's real reviews with AI-generated responses. This is the #1 sales weapon.

### Day 3: ReviewSource Interface + SerpAPI Implementation

**2.1 Define the ReviewSource interface**
This is the pluggable interface from the plan. Every review source — SerpAPI, manual paste, CSV upload, and eventually GBP API — must produce the same DTO.

```typescript
// src/lib/reviews/types.ts
export interface NormalizedReview {
  reviewerName: string;
  starRating: number;       // 1-5
  reviewText: string | null;
  reviewDate: string;        // ISO 8601
  detectedLanguage: string;  // ISO 639-1 (e.g., 'en', 'es', 'vi')
  // NO additional fields — this is the contract.
  // SerpAPI returns more data (photos, review ID, etc.) but we strip it here
  // to prevent "demo looks better than production" drift.
}

export interface ReviewSource {
  fetchReviews(placeId: string, maxResults?: number): Promise<NormalizedReview[]>;
}
```

**2.2 Implement SerpAPI review source**
```bash
pnpm add serpapi
```

Build `src/lib/reviews/serpapi-source.ts`:
- Accept a Google Place ID or extract it from a Google Maps URL
- Call SerpAPI's Google Maps Reviews endpoint
- Normalize the response to `NormalizedReview[]`
- Strip all SerpAPI-specific fields (thumbnail, review ID, response, etc.)
- Run language detection on each review text (use a lightweight library like `franc` or pass to the LLM)
- Return 10-15 reviews sorted by most recent

**2.3 Implement Google Maps URL parser**
Build `src/lib/reviews/url-parser.ts`:
- Accept various Google Maps URL formats:
  - `https://www.google.com/maps/place/.../@lat,lng,...`
  - `https://maps.google.com/?cid=...`
  - `https://g.co/kgs/...` (short links)
- Extract the Place ID or search query
- If a direct Place ID isn't in the URL, use SerpAPI's Google Maps search to find it

**2.4 Write contract tests**
Create tests that verify the SerpAPI source produces exactly the `NormalizedReview` shape:
```typescript
// src/lib/reviews/__tests__/serpapi-source.test.ts
// Verify: no extra fields, all required fields present, language detected
// Use a fixture of real SerpAPI response JSON (save one from a manual call)
```

### Day 4: Response Generator + Prompt Builder

**2.5 Build the response generator**
Install OpenAI SDK:
```bash
pnpm add openai @anthropic-ai/sdk
```

Build `src/lib/responses/generator.ts`:
- For the demo engine, this is a simplified version — no cost circuit breaker needed yet (that's for production)
- Inputs: `NormalizedReview` + business context (name, category, tone — inferred for demos since the business hasn't onboarded yet)
- Build the system prompt from Section 7 of the plan:
  ```
  You are a review response writer for a local business.
  Your responses must:
  1. Be specific to the review content — reference exact dishes, services, staff names mentioned
  2. Match the business's tone (provided in context)
  3. Be concise: under 80 words for positive reviews, up to 120 for negative
  4. Never make promises not authorized by the business
  5. For negative reviews: acknowledge the specific issue, empathize, don't argue
  6. Use the reviewer's name naturally if provided
  7. Respond in the same language as the review
  8. Never include placeholder text like [email] — say "please reach out to us directly"
  ```
- Call OpenAI GPT-4o-mini as primary
- If OpenAI fails, fall back to Anthropic Claude Haiku
- Track token usage and cost per call (write to `api_costs` table)
- Return: `{ responseText, language, provider, usage: { promptTokens, completionTokens }, costUsd }`

**2.6 Build the prompt builder**
Build `src/lib/responses/prompt-builder.ts`:
- For demos: infer business context from the Google Maps category (restaurant → warm/casual tone, dentist → professional/reassuring)
- For production (later): use the business's configured tone, staff names, highlight/avoid facts, and voice examples
- Construct the user message:
  ```
  Business: [name] ([category])
  Tone: [tone descriptor]
  
  Review (${starRating} stars) by ${reviewerName}:
  "${reviewText}"
  
  Language: ${detectedLanguage} — respond in this language.
  
  Write a response as the business owner.
  ```

**2.7 Add language detection**
```bash
pnpm add franc-min
```
Build `src/lib/shared/language.ts`:
- Use `franc` for fast client-side detection
- Map franc's ISO 639-3 codes to ISO 639-1 (e.g., 'spa' → 'es')
- Fallback to 'en' if detection confidence is too low

### Day 5: Demo Page + Admin Interface

**2.8 Build the demo generation pipeline**
Build `src/lib/demos/generator.ts`:
- Input: Google Maps URL
- Pipeline:
  1. Parse URL → extract Place ID
  2. Fetch 10-15 reviews via SerpAPI `ReviewSource`
  3. For each review, generate a response via the response generator
  4. Generate a short, clean URL slug (e.g., `nanoid(10)`)
  5. Save everything to the `prospect_demos` table:
     - `business_name`: from SerpAPI response
     - `google_place_id`: from URL parsing
     - `demo_url_slug`: the generated slug
     - `reviews_snapshot`: JSON array of reviews
     - `generated_responses`: JSON array of responses
     - `expires_at`: NOW() + 30 days
     - `prospect_status`: 'sent'
  6. Return the demo URL: `https://yourapp.com/demo/{slug}`

**2.9 Build the demo viewer page**
Build `src/app/(public)/demo/[slug]/page.tsx`:
- SSR page (important for fast load and SEO)
- Fetch the demo from `prospect_demos` by slug
- If expired or not found: show a clean "This demo has expired" page
- Increment `view_count` and update `last_viewed_at` on each visit
- Display:
  - Business name and category at the top
  - Summary stats: "X reviews found, Y currently unanswered, 100% response rate with us"
  - Each review as a card: reviewer name, stars (rendered as star icons), review text, date
  - AI response below each review card in a slightly different background color
  - A "multilingual" badge on any non-English review/response pair
  - CTA at the bottom: "Want this for your business? Book a call" with your Calendly link
- Mobile-first design — most business owners will view this on their phone

**2.10 Build the admin demo generation page**
Build `src/app/(admin)/demos/page.tsx`:
- Input field for Google Maps URL
- "Generate Demo" button
- Loading state while reviews are fetched and responses generated (this takes 30-60 seconds)
- List of all generated demos with: business name, created date, slug, view count, status
- Copy-to-clipboard button for the demo URL
- Protect this page with authentication (Supabase Auth — only admin and sales_partner roles)

### Phase 2 Testing
- Unit tests: prompt builder produces correct output for different business categories and review types
- Unit tests: `NormalizedReview` contract — verify SerpAPI source strips extra fields, all required fields present
- Manual: generate demos for 5 real businesses, verify response quality

### Phase 2 Done When
- [ ] Pasting a Google Maps URL into `/admin/demos` generates a demo in under 90 seconds
- [ ] Demo page at `/demo/{slug}` shows reviews + AI responses, mobile-optimized
- [ ] Non-English reviews get responses in the same language
- [ ] Demo URLs are shareable, track views, and expire after 30 days
- [ ] API costs are logged to `api_costs` table for every LLM call
- [ ] Your sales partner can generate demos independently without your help
- [ ] You've generated demos for at least 5 real local businesses and the responses are high quality

---

## Phase 3: Production Review Pipeline — SerpAPI Polling Mode (Days 6–13)

### Goal
When a business signs up, the system polls their Google reviews via SerpAPI every 60 minutes, detects new reviews, generates AI responses, and notifies the owner for approval. Posting is manual (copy-paste) for now.

### Why This Phase Exists
The original plan assumes GBP API + Pub/Sub for real-time ingestion. Since you don't have that yet, this phase builds a **SerpAPI-based polling pipeline** that uses the same architecture (outbox pattern, BullMQ workers, idempotent processing) so that swapping in GBP API later is a mechanical change, not an architectural rewrite.

### Timeline Note
This phase builds the outbox infrastructure, review sync, response generation pipeline, cost guards, notification system, approval flow, and manual posting workflow. The final plan allocates 10 working days (Weeks 2-3) for comparable scope. Budget 8 working days here — cutting it shorter risks fragile foundations in the outbox and approval systems, which are the hardest to fix retroactively.

### Days 6–7: SerpAPI Polling Worker + Review Ingestion + Outbox Infrastructure

**3.1 Extend ReviewSource for production monitoring**
The demo engine fetches reviews once. Production monitoring fetches reviews on a schedule and deduplicates against what's already in the database.

Build `src/lib/reviews/serpapi-monitor.ts`:
- Same SerpAPI call as the demo source
- But now: compare each review against existing `reviews` table rows
- **Stable synthetic identity** (must NOT include mutable text — otherwise an edited review looks like a new review and edit detection breaks):
  - `provider`: `'serpapi_poll'`
  - `provider_review_id`: `SHA-256(reviewerName + "|" + reviewDate)` — stable across text edits since reviewer name and original post date don't change
  - `provider_review_name`: `serpapi://{google_place_id}/reviews/{provider_review_id}` — synthetic resource name matching the plan's `provider_review_name` column contract
  - `provider_location_name`: `serpapi://{google_place_id}` — synthetic location name matching the plan's `provider_location_name` column contract
- **Mutations go in `review_content_hash`**: `SHA-256(starRating + "|" + reviewText)` — this is what the ReviewSyncWorker compares to detect edits
- This separation (stable identity vs. mutable content hash) aligns with `04-final-plan.md` lines 377-393 and ensures Phase 5 migration is mechanical: swap `provider` to `'google'`, replace synthetic IDs with canonical Google resource names, content hash logic stays identical
- **Critical**: when GBP API arrives, you'll switch `provider` to `'google'` and use real Google review IDs/resource names. The dedup + edit detection logic stays the same.

**3.2 Build the ReviewSyncWorker for SerpAPI mode**
Build `worker/jobs/ReviewSyncWorker.ts`:
- Consumes `sync_reviews` jobs from BullMQ
- Fetches reviews via `serpapi-monitor.ts`
- **Critical pattern (from Section 7 of the plan)**: For each review, read the existing row FIRST with `FOR UPDATE` lock to compare `review_content_hash` BEFORE the upsert overwrites it. The upsert's `RETURNING` would return the NEW hash, making comparison useless for detecting edits.
- For each new review (not already in DB):
  - Insert into `reviews` table populating ALL plan-required columns:
    - `provider = 'serpapi_poll'`
    - `provider_review_id = SHA-256(reviewerName + "|" + reviewDate)` (stable synthetic ID from 3.1)
    - `provider_review_name = 'serpapi://{google_place_id}/reviews/{provider_review_id}'`
    - `provider_location_name = 'serpapi://{google_place_id}'`
    - `reviewer_name`, `star_rating`, `review_text`, `review_date`
    - `detected_language` (from language detection)
    - `review_content_hash = SHA-256(starRating + "|" + reviewText)` (mutable content fingerprint)
  - In the SAME transaction, insert a `job_outbox` entry with `topic = 'generate_response'`
- For existing reviews where content hash changed (reviewer edited their review):
  - Update the review row
  - If the response is still `pending_approval`: set old response status to `failed` with reason `'Review updated by reviewer'`, then insert new `generate_response` outbox entry in the same transaction
  - If the response is already `posted`: create a `review_exceptions` entry with `type = 'review_edited_after_post'` AND insert a `notify_admin_review_exception` outbox entry. Do NOT auto-regenerate — this requires human judgment. Use `ON CONFLICT DO NOTHING` on the unique partial index to prevent notification storms from repeated polls detecting the same edit.
- If existing review and hash unchanged: skip silently (unchanged replay, no action needed)
- Mark sync timestamp on the business record

**3.3 Build the OutboxPoller**
Build `worker/jobs/OutboxPoller.ts` — copied almost directly from Section 7 of the plan:
- Runs every 10 seconds as a `setInterval` in the worker process
- Reads pending outbox entries using `FOR UPDATE SKIP LOCKED`
- Dispatches each entry to the appropriate BullMQ queue by `topic`
- Handles failures: if dispatch fails and attempts < max_attempts, reset to `pending`; if attempts >= max_attempts, transition to `failed` (terminal)
- Watchdog recovery: reset entries stuck in `dispatched` for > 1 hour

**3.4 Build the ReconciliationPoller (SerpAPI version)**
Build `worker/jobs/ReconciliationPoller.ts`:
- Runs as a BullMQ repeatable job every 60 minutes (not 30 — see SerpAPI Cost Estimate section; 60 min at 5 businesses fits the $50/month plan, 10 businesses requires the $100/month plan)
- Queries all businesses with `subscription_status = 'active'`
- For each business, writes a `sync_reviews` entry into `job_outbox`
- This is the primary ingestion path while using SerpAPI (replaces Pub/Sub)
- When GBP API arrives: this becomes the fallback path with adaptive intervals (60/120/240 min)

**3.5 Wire up BullMQ queues**
Build `worker/queues.ts`:
- Define queues: `sync_reviews`, `generate_response`, `send_notification`, `publish_response`, `weekly_summary`, `notify_admin_review_exception`
- Each queue has: 3 retry attempts, exponential backoff starting at 5 seconds
- Register workers for each queue

### Day 8: Response Generation Worker + Cost Guards

**3.6 Build the ResponseGeneratorWorker**
Build `worker/jobs/ResponseGeneratorWorker.ts`:
- Consumes `generate_response` jobs
- Full implementation from Section 7 of the plan, including:
  - Idempotent cache check (Redis key `gen:{reviewId}:v{version}`)
  - Cost reservation via Redis `INCRBY` BEFORE the LLM call
  - Global circuit breaker check
  - Concurrency limiter per business (max 3 simultaneous generations)
  - Regeneration budget: `assertRegenerateBudget()` — Redis counter `regen:{reviewId}:{date}` with 86400s TTL. If count > 3 (`MAX_REGENERATIONS_PER_REVIEW_PER_DAY`), throw `RegenerateLimitExceeded`. This is enforced in the worker (core logic), not just the API rate limiter — prevents outbox replay or direct queue injection from bypassing the limit.
  - Language detection from the review
  - Voice learning: call `getApprovedResponsePairs()` for few-shot examples, but **implement as a no-op that returns `[]` until the business has ≥5 posted responses with edits.** Don't let few-shot tuning delay launch or produce low-quality prompts from insufficient data. The hook is in place; it activates naturally as customers use the product.
  - `generateWithGuardrails`: run avoid_facts check on output, retry once if violated. **Cost accumulates across retries** — `totalSpentCents` = first attempt + retry. The cost reservation (pessimistic estimate of 15 cents) accounts for worst-case: long review + fallback provider + one guardrail retry. Finalization adjusts to actual total.
  - Fallback from OpenAI to Anthropic on failure
  - Input sanitization: strip Unicode control characters, null bytes, collapse excessive whitespace
  - **Two-phase cost accounting (from the plan)**: Phase 1 = pessimistic reservation via Redis `INCRBY` before LLM call. Phase 2 = finalize by adjusting reservation to actual spend. Once finalized, NEVER refund — even if later steps (DB write, cache set) fail. Those are retryable; the Redis budget counters must never drift backward.
  - After successful generation: in ONE transaction:
    - Insert response into `responses` table (with `original_draft_text`)
    - Insert `job_outbox` entry with `topic = 'send_notification'` (payload contains `response_id` and `business_id` — NO raw token)
  - **Do NOT generate approval tokens here.** Raw tokens must never be persisted in Postgres or outbox payloads. Token generation happens in the NotificationWorker right before send (see 3.10).
  - Complete the originating outbox entry

**3.7 Build the CostTracker**
Build `src/lib/costs/tracker.ts`:
- Redis-based atomic cost reservation (per-business daily + global daily)
- Tier-aware daily limits: founding = 500 cents, standard = 1000 cents, premium = 2000 cents
- `record()`: writes to `api_costs` table (audit trail)
- `alertAdmin()`: sends email to admin when a business exceeds 80% of daily limit

### Day 9: Notification System

**3.8 Set up Resend for email notifications**
```bash
pnpm add resend
```
- Create a Resend account, verify your domain
- Build `src/lib/notifications/email.ts`

**3.9 SMS notifications — DEFERRED**
SMS via Twilio is architecturally planned but deferred until the email approval flow is validated with real customers. The `notification_preference` column, `notification_deliveries` table, and per-channel `approval_links` rows all support SMS — but adding Twilio setup, delivery webhooks, and a second notification channel to the MVP critical path adds complexity without proving value. Add SMS after Phase 4 when at least 2-3 customers are using email approval successfully.

**3.10 Build the NotificationWorker**
Build `worker/jobs/NotificationWorker.ts`:
- Consumes `send_notification` jobs
- Reads the response, review, and business from the database (outbox payload has `response_id` + `business_id`)
- **Token generation happens HERE, not in ResponseGeneratorWorker.** For each channel being notified:
  1. Generate a raw token: `crypto.randomUUID()`
  2. Store ONLY `SHA-256(rawToken)` in `approval_links` with `channel = 'email'` and 48-hour TTL
  3. Construct the approval URL using the raw token: `https://yourapp.com/approve/{rawToken}`
  4. Send the notification via the channel
  5. The raw token lives only in memory and in the sent email/SMS — it is NEVER persisted in Postgres or outbox payloads
- This aligns with `04-final-plan.md` Section 5 (`approval_links`): hash-only storage, separate row per channel
- **MVP: email only.** Ship email approval first. Add SMS (Twilio) once the approval flow is validated with real customers. This removes Twilio setup, delivery webhook complexity, and a second notification channel from the critical path. The `notification_preference` column stays in the schema — just default everyone to `'email'` for now.
- Write delivery record to `notification_deliveries` table
- Complete the outbox entry

**3.11 Build the approval notification email template**
The email should contain:
- Subject: "New review for [Business Name] — response ready for approval"
- Body:
  - Star rating as visual stars (★★★★☆)
  - Reviewer name and date
  - Review text (truncated to 200 chars in email, full text on approval page)
  - Draft response preview (first 100 chars)
  - Big "Review & Approve" button linking to `/approve/{token}`
  - "This link expires in 48 hours"
- Keep it clean and mobile-friendly

### Days 10–11: Approval Flow

**3.12 Build the approval page**
Build `src/app/(public)/approve/[token]/page.tsx`:
- This is the most important screen in the product
- **SSR returns a minimal shell only** — no review text, no draft response in the initial HTML (prevents email preview bots from caching sensitive data)
- Client-side fetch loads the actual content after page mount
- Display:
  - Business name
  - Review card: reviewer name, stars, full text, date
  - Draft response in an editable text area
  - Three buttons: "Approve & Post", "Edit", "Generate New Response"
  - Expiry notice: "This link expires [time remaining]"
- "Approve & Post" flow:
  1. First click → POST `/api/approval/session` (binds device cookie)
  2. Then → POST `/api/approve/{token}/approve` (requires device cookie + CSRF)
  3. Show success confirmation: **"Response approved! We'll post it to Google shortly."** — same message regardless of SerpAPI or GBP mode. The owner's experience is done-for-you; manual posting is an internal admin/sales task they never see. This matches the product brief's core promise: the owner just taps approve, everything else is invisible.
- "Edit" flow: inline text editor appears, owner modifies text, submits
- "Generate New Response" flow: revokes current token, triggers new generation, shows loading state, then new draft

**3.13 Build the ApprovalService**
Build `src/lib/approval/service.ts`:
- Implementation directly from Section 7 of the plan
- `approve()`: validates token hash + device cookie, in ONE transaction: consume link, revoke siblings, update response status, insert outbox entry
- `edit()`: same as approve but stores `edited_text` and computes `edit_distance` (Levenshtein)
- `regenerate()`: consumes link, revokes ALL outstanding links, inserts outbox entry for new generation
- `establishApprovalSession()`: POST endpoint that binds `device_cookie_hash` on first deliberate user action

**3.14 Build the approval API routes**
```
src/app/api/approve/[token]/route.ts          → GET: validate token, return review + response data
src/app/api/approval/session/route.ts          → POST: bind device cookie
src/app/api/approve/[token]/approve/route.ts   → POST: approve response
src/app/api/approve/[token]/edit/route.ts      → POST: approve with edits
src/app/api/approve/[token]/regenerate/route.ts → POST: request new draft
```

### Days 12–13: Manual Posting Flow + AdminExceptionWorker + End-to-End Testing

**3.15 Build the manual posting workflow**
Since you can't auto-post to Google yet, the "publish" step needs a human-in-the-loop:

**Schema addition**: The plan's `responses.status` enum (`04-final-plan.md` line 412) does not include `awaiting_manual_post`. Add it explicitly in the migration:
```sql
-- In the initial migration or a new migration before Phase 3:
-- responses.status values: 'pending_approval', 'approved', 'edited', 'awaiting_manual_post', 'posted', 'failed'
-- The CHECK constraint (if any) must include 'awaiting_manual_post'
```
This status is used in admin queries (filter responses needing manual action), the "Mark as Posted" flow, and the ResponsePublisherWorker branching logic (manual vs. auto in Phase 5).

Build `worker/jobs/ResponsePublisherWorker.ts` (SerpAPI mode):
- Consumes `publish_response` jobs
- Instead of calling the GBP API:
  1. Update response status to `awaiting_manual_post`
  2. Send an internal email to the sales partner (or admin) via Resend with:
     - Business name
     - The approved response text (with "Copy to Clipboard" formatting)
     - A link to the business's Google Maps page: `https://www.google.com/maps/place/?q=place_id:{google_place_id}` (NOT a per-review deep link — SerpAPI doesn't provide canonical Google review resource names, so reliable per-review deep links aren't possible. Link to the business page and show the review snippet so the sales partner can find the right review.)
     - Instructions: "Please copy the response below and paste it as an owner reply on Google"
  3. The sales partner posts it manually
  4. Sales partner marks it as posted via the admin UI (updates status to `posted`, sets `posted_at`)

This is ugly but it works for the first 1-5 customers and proves the value. The owner never sees this — their experience is "approved, we'll handle it."

**3.16 Add a "Mark as Posted" button in the admin UI**
In the admin business detail page (`/admin/businesses/[id]`):
- Show all responses with status `awaiting_manual_post`
- For each: show the response text, a "Copy to Clipboard" button, and a "Mark as Posted" button
- "Mark as Posted" updates the response status to `posted` and sets `posted_at`

**3.17 Build the AdminExceptionWorker**
Build `worker/jobs/AdminExceptionWorker.ts`:
- Consumes `notify_admin_review_exception` outbox entries
- When a reviewer edits their review after a response was already posted, the system does NOT auto-regenerate. Instead, this worker sends an email to the admin/sales partner with:
  - Business name
  - Original review text vs. updated review text
  - The response that was already posted
  - Action options: regenerate a new response, dismiss the exception, or handle manually
- Looks up the exception in `review_exceptions` — if it's already resolved (another worker got there first), complete the outbox entry and skip
- Complete the outbox entry on success
- This is the safety net the plan describes in Section 7 (`AdminExceptionWorker`)

**3.18 End-to-end testing**
Test the complete loop manually:
1. Add a real business to the `businesses` table (use a restaurant you know)
2. Add their Google Place ID
3. Wait for the ReconciliationPoller to trigger a sync (or trigger manually)
4. Verify: new reviews appear in `reviews` with correct `provider_review_id`, `provider_review_name`, `provider_location_name`, and `review_content_hash`
5. Verify: responses are generated and appear in the `responses` table
6. Verify: email notification is sent with approval link (check Resend dashboard + your inbox)
7. Verify: approval page loads correctly on mobile
8. Approve a response → verify owner sees "we'll post it shortly" → verify response moves to `awaiting_manual_post`
9. Verify: sales partner receives internal email with approved text + Google Maps link
10. Mark as posted in admin → verify status updates to `posted` and `posted_at` is set

### Phase 3 Testing
Per final plan Section 11 — these are the critical flows to test before moving on:
- **Unit**: cost calculation and limit enforcement, approval token hashing + validation, review deduplication by `provider_review_name`, edit distance calculation, outbox entry creation logic
- **Integration**: full pipeline: manual review insert → outbox → generation → notification → approval → manual post (test with real Supabase, not mocks)
- **Integration**: outbox replay recovery — simulate Redis failure after Postgres commit, verify outbox poller recovers
- **Integration**: cost limit exceeded → circuit breaker halts generation → admin alerted
- **Integration**: LLM primary failure → fallback to Anthropic → success
- **Integration**: token revocation — regenerate revokes old links, new link works, old link rejected
- **Integration**: idempotency — replaying any outbox entry produces same result (no duplicate responses)
- **E2E (Playwright)**: owner clicks approval link → approve → confirmation page
- **E2E (Playwright)**: owner clicks approval link → edit text → save → confirmation
- **E2E (Playwright)**: owner clicks expired link → expiration message

### Phase 3 Done When
- [ ] Reviews are polled every 60 minutes for active businesses via SerpAPI
- [ ] New reviews trigger AI response generation automatically
- [ ] Owner receives email notification with approval link (SMS deferred — see 3.9)
- [ ] Approval tokens are generated in NotificationWorker, stored as SHA-256 hash only — raw tokens never persisted
- [ ] Approval page works on mobile: approve, edit, regenerate all functional
- [ ] Owner sees "we'll post it shortly" on approval — manual posting is invisible to them
- [ ] Approved responses are queued for manual posting by sales partner
- [ ] Sales partner can mark responses as posted from the admin UI
- [ ] Cost tracking works: every LLM call is logged with provider, tokens, and cost
- [ ] Cost circuit breaker halts generation when per-business or global daily limit is exceeded
- [ ] Review edit detection works: edited reviews trigger regeneration (if pending) or admin exception (if posted)
- [ ] AdminExceptionWorker sends email alerts for review-edited-after-post scenarios
- [ ] Full loop tested with at least one real business

---

## Phase 4: Admin Dashboard + Payments + Onboarding (Days 14–19)

### Goal
Sales partner can onboard a client, monitor all clients, and accept payment — all without engineering help.

### Days 14–15: Sales Partner Admin Dashboard

**4.1 Build the admin overview page** (`/admin/overview`)
This is the "single screen" CRM from the plan. Shows:
- System health bar at the top: pending outbox entries, queue depth, failed jobs, today's API cost, notification failures in last 24h
- Business table below: name, subscription status, pending approvals, response rate, avg response time, last activity
- Sort by "pending approval" by default (most urgent first)
- Click any row → navigate to business detail page
- Real-time updates via Supabase real-time subscriptions (or TanStack Query polling)

**4.2 Build the business detail page** (`/admin/businesses/[id]`)
Shows everything about one business:
- Business profile: name, category, owner info, subscription tier
- Review list: all reviews with response status (color coded)
- Pending approvals highlighted
- Responses awaiting manual posting highlighted with "Copy" and "Mark as Posted" buttons
- Business context: tone, staff names, highlight facts, avoid facts
- Edit all business settings inline

**4.3 Build the admin costs page** (`/admin/costs`)
Per final plan Section 6 (`GET /api/admin/costs`, `GET /api/admin/costs/alerts`):
- API cost breakdown by provider, by business, by day (reads from `api_costs` table)
- Businesses exceeding cost thresholds highlighted
- Today's total platform spend vs. global daily limit

**4.4 Build the admin jobs page** (`/admin/jobs`)
Per final plan Section 6 (`GET /api/admin/jobs`):
- Outbox health: pending, dispatched, failed counts from `job_outbox`
- BullMQ queue depths per topic (sync_reviews, generate_response, etc.)
- Failed jobs with error details for manual investigation
- This is the engineering troubleshooting page — essential for diagnosing silent failures

**4.5 Build the business onboarding form** (`/admin/businesses/new`)
The sales partner fills this during the 20-minute onboarding call:
- Business name, category, Google Place ID (or Google Maps URL — auto-parse)
- Owner name, email, phone
- Notification preference (email, SMS, both)
- Tone descriptor (dropdown: warm/casual, professional/friendly, professional/reassuring, etc.)
- Products/services (free text)
- Staff names (comma-separated)
- Things to always mention (e.g., "We make our horchata fresh daily")
- Things to never mention (e.g., "Don't mention prices")
- Sample owner responses (paste 2-3 examples of how the owner has responded before)
- Subscription tier (founding $99, standard $149)
- On submit:
  1. Creates the `businesses` row
  2. Creates the `users` row for the owner (role: 'owner')
  3. Triggers an initial review sync via SerpAPI (writes to `job_outbox`)
  4. Redirects to the business detail page

### Day 16: Stripe Integration

**4.6 Set up Stripe**
```bash
pnpm add stripe @stripe/stripe-js
```
- Create Stripe account
- Create two Products:
  - "Founding Member" — $99/month
  - "Standard" — $149/month
- Create a Stripe webhook endpoint pointing to your Railway worker

**4.7 Build the payment flow — Stripe Payment Links only**
- Create Stripe Payment Links for each tier in the Stripe dashboard (Founding $99/mo, Standard $149/mo)
- Sales partner sends the link after the onboarding call
- Stripe webhook updates `subscription_status` to 'active' when payment succeeds
- **Skip in-app checkout for MVP.** Payment Links work without any frontend code. Build in-app checkout only if customer conversion data shows the redirect is losing people — unlikely at this scale.

**4.8 Build the Stripe webhook handler**
Build `worker/ingress/stripe.ts`:
- Verify webhook signature
- Write to `inbound_events` (deduplicate by Stripe event ID)
- Handle events:
  - `checkout.session.completed`: update `businesses.subscription_status` to 'active', set `stripe_customer_id` and `stripe_subscription_id`
  - `invoice.payment_failed`: update status to 'past_due'
  - `customer.subscription.deleted`: update status to 'cancelled'
  - `customer.subscription.updated`: update tier if changed

### Day 17: Notification Delivery Tracking + Troubleshooting

**4.9 Build the notification log page** (`/admin/notifications`)
- List of all notification deliveries with: business name, channel, recipient, template, sent_at, delivered_at, failed_at, failure_reason
- Filter by business, channel, status (delivered, failed, pending)
- This is essential for troubleshooting "I never got the notification" complaints

**4.10 Set up delivery webhooks**
- Resend webhook: when an email is delivered/bounced/complained, update `notification_deliveries`
- Twilio webhook: when an SMS is delivered/failed, update `notification_deliveries`
- Both route through `inbound_events` for deduplication

### Days 18–19: Security Hardening

**4.11 Rate limiting**
Add rate limits to all public endpoints:
- `/api/approve/*/approve|edit|regenerate`: 3 actions per token per minute (from the plan's approval token security section)
- `/api/approve/*/regenerate`: additionally enforce max 3 regenerations per review per day via Redis counter `regen:{reviewId}:{date}` (prevents cost amplification attacks)
- `/api/admin/demos/generate`: 50 per day (prevent SerpAPI cost runaway)
- `/api/webhooks/*`: 100 per minute per source IP
- Use the cache Redis for rate limit counters

**4.12 Input sanitization**
- Review text rendered in the approval page: sanitize against XSS
- Business settings (tone, staff names): validate and sanitize on input
- Use `DOMPurify` or equivalent for any user-generated content rendered in HTML

**4.13 Authentication**
- Set up Supabase Auth for admin and owner logins
- Admin pages: require `role = 'admin' OR 'sales_partner'`
- Dashboard pages: require `role = 'owner'` and `business_id` matches
- Approval pages: NO authentication (token-based access only)

**4.14 Audit logging for approval actions**
- Log every approval action (approve, edit, regenerate) with: timestamp, token hash, device cookie hash, response ID, business ID, action type, IP address
- Store in a dedicated `approval_audit_log` table or append to an existing logging system
- This is critical for investigating "who approved what" disputes and detecting abuse patterns

**4.15 Webhook deduplication via `inbound_events`**
- All webhook handlers (Stripe, Twilio, Resend) MUST write to `inbound_events` first, deduplicated on the external event ID, before processing. This prevents double-processing from webhook retries. The plan is explicit about this pattern.

### Phase 4 Testing
- **E2E (Playwright)**: sales partner generates demo → copies link → demo loads
- **E2E (Playwright)**: sales partner onboards business → appears in overview with correct status
- **Integration**: Stripe webhook → `inbound_events` dedup → subscription status update
- **Security**: rate limit enforcement — hit approval endpoint >3 times/min, verify 429
- **Security**: regenerate >3 times/day for same review, verify rejection
- **Security**: unauthenticated access to admin pages → redirected to login

### Phase 4 Done When
- [ ] Sales partner can onboard a new client in under 5 minutes via the admin UI
- [ ] Admin overview shows all businesses with real-time health indicators
- [ ] Admin costs page shows per-business and per-provider cost breakdown
- [ ] Admin jobs page shows outbox + queue health with failed job details
- [ ] Stripe payment works: client pays, subscription activates automatically
- [ ] Notification delivery is tracked end-to-end (sent → delivered or failed)
- [ ] All public endpoints are rate-limited (including regenerate: max 3 per review per day)
- [ ] Admin pages are protected by authentication
- [ ] Approval actions are audit-logged (who, when, what, from where)
- [ ] All webhook handlers deduplicate via `inbound_events` before processing
- [ ] The entire system runs without any engineering intervention for daily operations

---

## Phase 5: GBP API Integration — When Approved (Variable Timeline)

### Goal
Replace SerpAPI polling with GBP API + Pub/Sub for real-time review ingestion. Enable automated posting of approved responses.

**This phase starts the moment your GBP API access is approved.** It can run in parallel with serving customers from Phase 3-4.

### What Changes

**5.1 Enable the 8 Business Profile APIs**
Once approved, they become visible in the GCP API Library:
- My Business Account Management API
- My Business Business Information API
- My Business Lodging API
- My Business Notifications API
- My Business Verifications API
- My Business Place Actions API
- My Business Q&A API
- Google My Business API 4.9

Enable all of them.

**5.2 Build the OAuth flow for business onboarding**
- When the sales partner onboards a new client, add an "Connect Google Business Profile" button
- This initiates the OAuth flow: redirect to Google → business owner grants access → callback saves tokens
- Store OAuth tokens using envelope encryption (DEK encrypted with KEK, per the plan)
- Save to `google_connections` table

**5.3 Set up Pub/Sub for real-time notifications**
- Create a Pub/Sub topic in GCP
- Create a push subscription pointing to your Railway worker endpoint
- Build `worker/ingress/pubsub.ts`:
  - Verify OIDC token on every request
  - Deduplicate via `inbound_events`
  - Write `sync_reviews` entry to `job_outbox`

**5.4 Update the ReviewSyncWorker for GBP API**
- Add a new `ReviewSource` implementation: `gbp-api-source.ts`
- Uses the GBP API to list reviews using `google_location_name`
- Uses real Google review IDs for deduplication (replace synthesized hashes)
- Handles token refresh with distributed locking (prevent thundering herd)
- Handles per-location error rate backoff + project-wide quota tracking

**5.5 Build automated posting**
- Update `ResponsePublisherWorker.ts`:
  - For businesses with a connected `google_connections` record: call GBP API `updateReply`
  - For businesses without: fall back to manual posting workflow
- Retry logic: exponential backoff, max 3 retries
- On success: update response status to `posted`

**5.6 Switch the ReconciliationPoller to adaptive intervals**
- With Pub/Sub as primary: polling becomes the fallback
- Businesses with recent notifications: poll every 120 minutes
- Businesses without notifications in 24h: poll every 60 minutes (may indicate notification gap)
- Businesses without notifications in 7 days: poll every 240 minutes (likely just quiet)

**5.7 Migrate existing customers**
- For each existing customer:
  1. Initiate OAuth flow (they need to grant access once)
  2. Backfill `google_connections` with their tokens and location name
  3. Switch their reviews from `provider = 'serpapi_poll'` to `provider = 'google'`
  4. Turn on Pub/Sub notifications for their location
  5. Turn off SerpAPI polling for their location

### Phase 5 Done When
- [ ] New customers connect via OAuth during onboarding
- [ ] Reviews arrive in near-real-time via Pub/Sub notifications
- [ ] Approved responses are posted to Google automatically
- [ ] Existing customers are migrated from SerpAPI to GBP API
- [ ] ReconciliationPoller runs at adaptive intervals as fallback
- [ ] SerpAPI is only used for the demo engine (prospect demos)

---

## Phase 6: Production Hardening + First 10 Customers (Weeks 5–6)

### Goal
System is reliable enough for 10 paying customers with zero daily manual intervention.

### Tasks

**6.1 Monitoring + Alerting**
- Set up PostHog: track approval rates, edit rates, response times, demo generation
- Set up Better Stack: error tracking, uptime monitoring for both Vercel and Railway
- Alerts:
  - Outbox entry stuck in `pending` for > 5 minutes
  - Outbox entry stuck in `dispatched` for > 1 hour
  - API cost exceeds 80% of daily limit for any business
  - Notification delivery failure
  - Worker process crash / restart

**6.2 Notification failover**
Build the `NotificationFailover` class from the plan:
- Cron job every 2 hours
- Check for responses in `pending_approval` for > 4 hours with no successful delivery
- Try alternate channel (if primary was email, try SMS and vice versa)
- Alert admin regardless

**6.3 Weekly summary email**
Build the `WeeklySummaryWorker`:
- Runs every Monday at 8 AM
- For each active business: count reviews, count responses, flag notable (1-2 star) reviews
- Send a clean email with the summary
- Save to `weekly_summaries` table

**6.4 Approval page performance**
- Target: loads in under 2 seconds on 3G
- Optimize: minimize JS bundle, lazy load non-critical elements
- Test on Chrome DevTools with network throttling

**6.5 Outbox + event archival**
Do this in hardening, not later — at 10 businesses the outbox table grows by ~150 entries/week, and `inbound_events` grows similarly. Waiting until Phase 8 risks table bloat affecting poller query performance.
- Build a cron job (BullMQ repeatable, runs daily) that:
  - Archives `job_outbox` rows with `status = 'completed'` older than 7 days
  - Archives `inbound_events` rows with `status = 'processed'` older than 30 days
  - Deletes expired `prospect_demos` past 30 days
- "Archive" means move to an `_archive` table or delete — choose based on audit requirements

**6.6 Correlation IDs**
Add `x-correlation-id` header propagation across service boundaries:
- Generate at the entry point (Pub/Sub notification, API request, outbox poller pickup)
- Propagate through outbox `payload` and BullMQ `job.data`
- Include in all structured log output
- The plan flags this as "not a launch blocker, but add during hardening — debugging distributed failures without it is painful"

**6.7 Bug fixes from early customers**
- Reserve 30% of time in Weeks 5-6 for customer-reported issues
- Common early issues: notification formatting, edge cases in review text, timezone handling

**6.8 Load testing**
Before accepting customer #10 (per final plan Section 11):
- 50 concurrent demo page loads
- 100 approval page loads per minute
- OutboxPoller processing 200 entries in under 30 seconds
- Verify no outbox entries are lost under concurrent load
- 100 SerpAPI poll notifications in 1 minute (burst simulation)

**6.9 Security testing**
Per final plan Section 11 — run before customer #10:
- Prompt injection via adversarial review text → verify sanitization + human approval catches output
- Cost amplification via regenerate spam → verify rate limiting + daily budget halts generation
- Token enumeration → verify hash-only storage prevents brute-force lookup
- XSS via review text in approval page → verify DOMPurify/sanitization
- Webhook replay → verify `inbound_events` deduplication rejects replays

### Phase 6 Done When
- [ ] 10 businesses running with zero manual engineering intervention
- [ ] Monitoring alerts fire correctly for all failure modes
- [ ] Notification failover catches missed deliveries
- [ ] Weekly summaries go out every Monday
- [ ] Approval page loads in under 2 seconds on 3G
- [ ] Load tests pass: system handles 10x current load without degradation
- [ ] Security tests pass: prompt injection, cost amplification, token enumeration, XSS, webhook replay all mitigated
- [ ] Correlation IDs propagate across Vercel → Railway → workers

---

## Phase 7: Churn Killers — ROI Dashboard + Intelligence Brief (Weeks 7–8)

### Goal
Prove value to existing customers with their own data. Reduce churn to near-zero.

### ROI Dashboard

**7.1 Add ROI stats to the business owner dashboard** (`/dashboard`)
- Response rate: before us (calculated from historical review data at onboarding) vs. after us (from responses table)
- Average response time: how quickly reviews are being responded to
- Total reviews handled: cumulative count
- Review velocity: new reviews per week, shown as a simple trend (last 4 weeks)

**7.2 Add Google Maps rank tracking (manual for now)**
- Add a `ranking_snapshots` table:
  ```sql
  CREATE TABLE ranking_snapshots (
    id UUID PRIMARY KEY DEFAULT uuidv7(),
    business_id UUID NOT NULL REFERENCES businesses(id),
    keyword VARCHAR(255) NOT NULL,
    rank_position INTEGER,
    search_location VARCHAR(255),
    snapshot_date DATE NOT NULL,
    source VARCHAR(20) DEFAULT 'manual',
    created_at TIMESTAMPTZ DEFAULT NOW()
  );
  ```
- Add a form in the admin business detail page: enter keyword, position, date
- Sales partner checks Google Maps ranking weekly and inputs it manually
- Display on the owner dashboard as a simple line chart (position over time)
- Automate later with SerpAPI Google Maps search or a dedicated rank tracking API

### Review Intelligence Brief

**7.3 Add LLM-powered summarization to weekly summaries**
Upgrade `WeeklySummaryWorker`:
- After collecting the week's reviews, feed them ALL to the LLM with a summarization prompt:
  ```
  You are a business consultant analyzing customer reviews for [Business Name].
  Here are the reviews from the past week:
  [array of reviews with text and rating]
  
  Provide a 3-5 sentence intelligence brief covering:
  1. Recurring themes (positive and negative)
  2. Any new mentions (menu items, staff, services mentioned for the first time)
  3. Overall sentiment trend compared to what you see
  4. One actionable recommendation
  
  Be specific — reference actual items, names, or service areas mentioned.
  Write as a paragraph, not bullet points.
  ```
- Include this brief in the weekly email above the stats
- Save the `summary_text` to the `weekly_summaries` table
- Cost: one additional LLM call per business per week (~$0.01-0.03)

### Phase 7 Done When
- [ ] Owner dashboard shows response rate, response time, reviews handled, and velocity
- [ ] Google Maps ranking is tracked (manually for now) and displayed
- [ ] Weekly email includes an AI-generated intelligence brief with pattern detection
- [ ] At least one customer says "I didn't know my customers were saying that" — that's the signal it's working

---

## Phase 8: Scale to $1K MRR (Weeks 9–12)

### Goal
8-10 paying customers, $1,000+ monthly recurring revenue, and a system that runs itself.

### Tasks

**8.1 Voice learning optimization**
- Analyze edit patterns across all businesses
- For businesses with high edit rates: review their business context and sample responses
- Tune prompts per business based on accumulated edit pairs
- Track edit distance trends — they should decrease over time

**8.2 Onboarding automation**
Based on friction points from first 10 customers:
- Reduce onboarding time from 20 minutes to 10 minutes
- Pre-fill business details from Google Maps data (name, category, address)
- Automate the initial review sync (don't wait for the next polling cycle)

**8.3 Cost data archival**
- Outbox and event archival was already built in Phase 6.5. Here, add:
- Archive `api_costs` older than 90 days (keep daily summary aggregates per business per provider)
- Archive `notification_deliveries` older than 90 days

**8.4 Database monitoring**
- Monitor Supabase connection pool utilization
- Monitor table sizes (reviews, responses, inbound_events)
- Set up alerts for approaching free tier limits

**8.5 Prepare for expansion**
- Document all operational runbook tasks (from Section 12 of the plan)
- Create a "customer health score" based on: approval rate, edit rate, response time, review velocity
- Identify which customers are ready for upsell (premium tier)

### Phase 8 Done When
- [ ] 8-10 paying customers active
- [ ] $1,000+ MRR
- [ ] System runs with < 30 minutes of engineering time per week
- [ ] Voice learning shows measurable improvement (edit rates decreasing)
- [ ] Database health is monitored and within limits
- [ ] Operational runbook is documented

---

## Quick Reference: What Goes Where

| Component | Runs on | Why |
|---|---|---|
| Landing page, demo pages, approval pages | Vercel (Next.js) | Fast SSR, CDN-cached |
| Admin dashboard, owner dashboard | Vercel (Next.js) | Authenticated pages |
| API routes (approval, admin, business) | Vercel (Next.js) | Short-lived request/response |
| OutboxPoller (10s interval) | Railway Worker | Long-running process |
| ReconciliationPoller (30 min) | Railway Worker | Scheduled background job |
| ReviewSyncWorker | Railway Worker | External API calls, variable latency |
| ResponseGeneratorWorker | Railway Worker | LLM calls, 5-30 second execution |
| NotificationWorker | Railway Worker | Email/SMS delivery |
| ResponsePublisherWorker | Railway Worker | Google API posting (when available) |
| WeeklySummaryWorker | Railway Worker | Monday morning cron |
| Webhook handlers (Stripe, Twilio, Resend) | Railway Worker | External ingress |

---

## SerpAPI Cost Estimate

| Activity | Monthly volume (10 businesses) | SerpAPI calls | Cost |
|---|---|---|---|
| Production polling (every 60 min) | 10 × 24/day × 30 = 7,200 | ~7,200 | $50/mo plan covers 5,000 searches. Need $100/mo plan for 10 businesses. |
| Production polling (5 businesses) | 5 × 24/day × 30 = 3,600 | ~3,600 | Fits within $50/mo plan. |
| Demo generation | ~30 demos/month | ~30 | Negligible |

**Recommendation**: Phase 3 uses 60-minute polling intervals. At 5 businesses, this fits within the $50/month SerpAPI plan. At 10 businesses, upgrade to the $100/month plan. When GBP API arrives, SerpAPI costs drop to demo-only (~$5/month).

---

## Risk Mitigation Summary

| Risk | Mitigation |
|---|---|
| GBP API never approved | Product works indefinitely on SerpAPI polling + manual posting. Less elegant but functional. Evaluate Outscraper or other review data sources as alternatives. |
| SerpAPI rate limits or blocks | Reduce polling frequency. Add manual review paste as fallback input. Cache reviews aggressively. |
| Customer expects auto-posting | The owner never knows posting is manual. They see "Response approved! We'll post it to Google shortly." The sales partner handles the actual posting internally. When GBP API arrives in Phase 5, this becomes truly automatic with zero customer-facing change. |
| LLM generates bad response | Human approval catches everything. Track edit distance to identify quality regression. |
| First customer churns | ROI dashboard (Phase 7) is the churn killer. If they can see their response rate went from 0% to 100%, they don't leave. |
