# Sprint 1 Audit Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all issues found in the Sprint 1 codebase audit — blockers, quality issues, cosmetic fixes, CLAUDE.md improvements, and add a mock data path for testing without real API keys.

**Architecture:** Environment-based mock flag (`MOCK_EXTERNAL_APIS=true`) gates SerpAPI and LLM calls. Mock implementations share the same interfaces (`ReviewSource`, `generateResponse`) so the rest of the pipeline (outbox, worker, DB, UI) runs unmodified. No new dependencies needed.

**Tech Stack:** TypeScript, Vitest, Fastify, BullMQ, Postgres.js

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `src/lib/reviews/mock-source.ts` | Canned `ReviewSource` returning realistic mock reviews |
| Create | `src/lib/responses/mock-generator.ts` | Canned response generator matching `GenerationResult` shape |
| Create | `.env.example` | Template with placeholder values for all env vars |
| Create | `vitest.config.ts` | Vitest configuration with path aliases |
| Modify | `src/lib/demos/generator.ts` | Use mock source + mock generator when `MOCK_EXTERNAL_APIS=true` |
| Modify | `src/lib/responses/generator.ts` | Export mock-aware entry point |
| Modify | `worker/jobs/DemoGenerationWorker.ts` | Remove re-throw after failure transaction |
| Modify | `worker/jobs/OutboxPoller.ts` | Add `FOR UPDATE SKIP LOCKED` |
| Modify | `src/app/api/admin/demos/generate/route.ts` | Store `category` in `prospect_demos` INSERT |
| Modify | `src/app/(public)/demo/[slug]/page.tsx` | Replace Calendly placeholder with descriptive CTA |
| Modify | `.claude/CLAUDE.md` | Add missing docs, fix Sprint 6, add test commands |

---

### Task 1: Create mock ReviewSource

**Files:**
- Create: `src/lib/reviews/mock-source.ts`
- Modify: `src/lib/reviews/index.ts`

- [ ] **Step 1: Create the mock source**

Create `src/lib/reviews/mock-source.ts` with 8 realistic mock reviews covering: 5-star English, 1-star English, 4-star Spanish, 3-star with no text (rating-only), 5-star French, 2-star English long review, 5-star short English, 4-star German.

```typescript
import type { NormalizedReview, ReviewSource } from './types';

const MOCK_REVIEWS: NormalizedReview[] = [
  {
    reviewerName: 'Sarah Johnson',
    starRating: 5,
    reviewText: 'Absolutely wonderful experience! The staff was incredibly friendly and the food was delicious. We had the pasta special and it was cooked to perfection. Will definitely be coming back with friends and family. Highly recommend this place to anyone looking for great food and atmosphere.',
    reviewDate: '2026-03-15T00:00:00Z',
    detectedLanguage: 'en',
  },
  {
    reviewerName: 'Mike Chen',
    starRating: 1,
    reviewText: 'Terrible service. Waited 45 minutes for our food and when it arrived it was cold. The waiter was rude when we complained. Asked to speak with the manager but they were "unavailable". Never coming back.',
    reviewDate: '2026-03-14T00:00:00Z',
    detectedLanguage: 'en',
  },
  {
    reviewerName: 'Maria Garcia',
    starRating: 4,
    reviewText: 'Muy buena comida y excelente servicio. El ambiente es acogedor y perfecto para una cena en pareja. Los precios son razonables para la calidad que ofrecen. Solo le falta un poco mas de variedad en el menu de postres.',
    reviewDate: '2026-03-13T00:00:00Z',
    detectedLanguage: 'es',
  },
  {
    reviewerName: 'Anonymous',
    starRating: 3,
    reviewText: null,
    reviewDate: '2026-03-12T00:00:00Z',
    detectedLanguage: 'en',
  },
  {
    reviewerName: 'Pierre Dubois',
    starRating: 5,
    reviewText: "Un repas magnifique du debut a la fin. Le chef a vraiment un talent exceptionnel. Les ingredients sont frais et les saveurs sont parfaitement equilibrees. Le service etait impeccable et l'ambiance chaleureuse. Je recommande vivement!",
    reviewDate: '2026-03-11T00:00:00Z',
    detectedLanguage: 'fr',
  },
  {
    reviewerName: 'David Wilson',
    starRating: 2,
    reviewText: 'Disappointing visit. The place looks nice from outside but the food quality does not match the prices. My steak was overcooked despite asking for medium rare. The salad was wilted. On the positive side, the dessert was decent and the location is convenient. Would not recommend based on the main course quality.',
    reviewDate: '2026-03-10T00:00:00Z',
    detectedLanguage: 'en',
  },
  {
    reviewerName: 'Emma Thompson',
    starRating: 5,
    reviewText: 'Best brunch in town!',
    reviewDate: '2026-03-09T00:00:00Z',
    detectedLanguage: 'en',
  },
  {
    reviewerName: 'Hans Mueller',
    starRating: 4,
    reviewText: 'Sehr gutes Essen und freundlicher Service. Die Portionen waren grosszugig und der Preis war fair. Das Ambiente ist gemuetlich und einladend. Ein kleiner Kritikpunkt: die Wartezeit war etwas lang, aber das Essen hat es wettgemacht.',
    reviewDate: '2026-03-08T00:00:00Z',
    detectedLanguage: 'de',
  },
];

/**
 * Mock ReviewSource for testing without real SerpAPI calls.
 * Returns canned reviews that exercise: multiple languages, star ratings 1-5,
 * rating-only (null text), short text, and long text.
 */
export class MockReviewSource implements ReviewSource {
  async fetchReviews(
    _placeId: string,
    maxResults: number = 10,
  ): Promise<NormalizedReview[]> {
    // Simulate network latency
    await new Promise((resolve) => setTimeout(resolve, 200));
    return MOCK_REVIEWS.slice(0, Math.min(maxResults, MOCK_REVIEWS.length));
  }
}
```

- [ ] **Step 2: Export from index**

Add to `src/lib/reviews/index.ts`:

```typescript
export { MockReviewSource } from './mock-source';
```

- [ ] **Step 3: Verify it compiles**

Run: `npx tsc --noEmit --project tsconfig.json 2>&1 | head -20`
Expected: No errors related to mock-source.ts

---

### Task 2: Create mock response generator

**Files:**
- Create: `src/lib/responses/mock-generator.ts`

- [ ] **Step 1: Create the mock generator**

Create `src/lib/responses/mock-generator.ts` that produces template responses matching `GenerationResult` without calling any LLM.

```typescript
import type { NormalizedReview } from '@/lib/reviews/types';
import type {
  DemoBusinessContext,
  BusinessContext,
  VoiceExample,
  GenerationOptions,
  GenerationResult,
} from './types';

const POSITIVE_TEMPLATES = [
  'Thank you so much for your wonderful review, {name}! We are thrilled to hear you enjoyed your experience with us. Your kind words mean a lot to our team. We look forward to welcoming you back soon!',
  'We truly appreciate your feedback, {name}! It makes our day to know you had such a great experience. Thank you for taking the time to share — we hope to see you again!',
  '{name}, thank you for the fantastic review! We are delighted that you enjoyed everything. Our team works hard to create the best experience possible, and your support keeps us going!',
];

const NEGATIVE_TEMPLATES = [
  'Thank you for sharing your experience, {name}. We sincerely apologize for the issues you encountered. This is not the standard we hold ourselves to. We would love the opportunity to make things right — please reach out to us directly at your convenience so we can address your concerns personally.',
  '{name}, we are sorry to hear about your disappointing visit. Your feedback is important to us and we take it seriously. We have shared your comments with our team to ensure improvements are made. We hope you will give us another chance to provide you with the experience you deserve.',
];

const NEUTRAL_TEMPLATE =
  'Thank you for your feedback, {name}. We appreciate you taking the time to share your thoughts. We are always looking for ways to improve and your input helps us do that.';

const SPANISH_RESPONSE =
  'Muchas gracias por su resena, {name}! Nos alegra saber que disfruto de su experiencia. Su opinion es muy valiosa para nosotros. Esperamos verle de nuevo pronto!';

const FRENCH_RESPONSE =
  'Merci beaucoup pour votre avis, {name}! Nous sommes ravis que vous ayez apprecie votre experience. Vos commentaires comptent enormement pour nous. Au plaisir de vous revoir!';

const GERMAN_RESPONSE =
  'Vielen Dank fuer Ihre Bewertung, {name}! Wir freuen uns sehr, dass Ihnen Ihr Besuch gefallen hat. Ihr Feedback ist uns sehr wichtig. Wir freuen uns auf Ihren naechsten Besuch!';

function pickTemplate(review: NormalizedReview): { text: string; language: string } {
  const name = review.reviewerName;

  // Match language for non-English reviews
  if (review.detectedLanguage === 'es') {
    return { text: SPANISH_RESPONSE.replace('{name}', name), language: 'es' };
  }
  if (review.detectedLanguage === 'fr') {
    return { text: FRENCH_RESPONSE.replace('{name}', name), language: 'fr' };
  }
  if (review.detectedLanguage === 'de') {
    return { text: GERMAN_RESPONSE.replace('{name}', name), language: 'de' };
  }

  // English — pick by sentiment
  if (review.starRating >= 4) {
    const template = POSITIVE_TEMPLATES[Math.floor(Math.random() * POSITIVE_TEMPLATES.length)]!;
    return { text: template.replace('{name}', name), language: 'en' };
  }
  if (review.starRating <= 2) {
    const template = NEGATIVE_TEMPLATES[Math.floor(Math.random() * NEGATIVE_TEMPLATES.length)]!;
    return { text: template.replace('{name}', name), language: 'en' };
  }

  return { text: NEUTRAL_TEMPLATE.replace('{name}', name), language: 'en' };
}

/**
 * Mock response generator for testing without real LLM calls.
 * Returns template-based responses that match the GenerationResult shape.
 * Supports multilingual (ES, FR, DE) and sentiment-aware templates.
 */
export async function generateMockResponse(
  review: NormalizedReview,
  _businessContext: DemoBusinessContext | BusinessContext,
  _voiceExamples: VoiceExample[],
  _options: GenerationOptions,
): Promise<GenerationResult> {
  // Simulate LLM latency
  await new Promise((resolve) => setTimeout(resolve, 100 + Math.random() * 200));

  const { text, language } = pickTemplate(review);

  return {
    responseText: text,
    language,
    provider: 'openai',
    model: 'mock-gpt-4o-mini',
    usage: {
      promptTokens: 150 + Math.floor(Math.random() * 100),
      completionTokens: 50 + Math.floor(Math.random() * 50),
    },
    costUsd: 0,
    apiCostId: null,
  };
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit --project tsconfig.json 2>&1 | head -20`
Expected: No errors related to mock-generator.ts

---

### Task 3: Wire mock flag into demo generator

**Files:**
- Modify: `src/lib/demos/generator.ts`

- [ ] **Step 1: Update generator to check `MOCK_EXTERNAL_APIS`**

Replace the contents of `src/lib/demos/generator.ts`:

```typescript
import { SerpApiSource } from '@/lib/reviews/serpapi-source';
import { MockReviewSource } from '@/lib/reviews/mock-source';
import { generateResponse } from '@/lib/responses/generator';
import { generateMockResponse } from '@/lib/responses/mock-generator';
import type { NormalizedReview } from '@/lib/reviews/types';
import type { ReviewSource } from '@/lib/reviews/types';
import type { GenerationResult } from '@/lib/responses/types';
import type { DemoGeneratorInput, DemoGeneratorResult } from './types';

const useMocks = process.env.MOCK_EXTERNAL_APIS === 'true';

function getReviewSource(): ReviewSource {
  if (useMocks) return new MockReviewSource();
  return new SerpApiSource(process.env.SERPAPI_API_KEY!);
}

const respond = useMocks ? generateMockResponse : generateResponse;

/**
 * Core demo generation logic — called by DemoGenerationWorker on Railway.
 *
 * Fetches reviews via SerpAPI (or mock source when MOCK_EXTERNAL_APIS=true),
 * generates an AI response for each one.
 *
 * Pure computation — does NOT write to the database.
 * The worker handles all persistence.
 */
export async function generateDemo(
  input: DemoGeneratorInput,
): Promise<DemoGeneratorResult> {
  const startTime = Date.now();

  const source = getReviewSource();
  const reviews = await source.fetchReviews(input.placeId, 15);

  if (reviews.length === 0) {
    throw new Error('No reviews found for this business');
  }

  const businessContext = {
    name: input.businessName,
    category: input.category,
  };

  const settled = await Promise.allSettled(
    reviews.map((review) =>
      respond(review, businessContext, [], { mode: 'demo' }),
    ),
  );

  const responses: (GenerationResult | null)[] = settled.map(
    (result, index) => {
      if (result.status === 'fulfilled') {
        return result.value;
      }
      console.error(
        `[demo-generator] LLM failed for review ${index} (${reviews[index]?.reviewerName}):`,
        result.reason,
      );
      return null;
    },
  );

  const successful = responses.filter(
    (r): r is GenerationResult => r !== null,
  );

  return {
    placeId: input.placeId,
    reviews,
    responses,
    metadata: {
      totalReviews: reviews.length,
      successfulResponses: successful.length,
      failedResponses: reviews.length - successful.length,
      totalCostUsd: successful.reduce((sum, r) => sum + r.costUsd, 0),
      generationDurationMs: Date.now() - startTime,
    },
  };
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit --project tsconfig.json 2>&1 | head -20`
Expected: No errors

---

### Task 4: Fix DemoGenerationWorker re-throw

**Files:**
- Modify: `worker/jobs/DemoGenerationWorker.ts:72-96`

- [ ] **Step 1: Remove the re-throw after failure transaction**

In the catch block, after the failure transaction succeeds, log a message and return instead of re-throwing. This prevents BullMQ from triggering a pointless retry for an already-handled failure.

Replace the catch block (lines 72-96):

```typescript
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error);

    console.error(
      `[DemoGenerationWorker] Demo ${demoId} failed: ${message}`,
    );

    // Failure: update both in one transaction
    try {
      await sql.begin(async (tx) => {
        await tx`
          UPDATE prospect_demos
          SET generation_status = 'failed',
              generation_error = ${message},
              completed_at = NOW()
          WHERE id = ${demoId}
        `;

        await tx`
          UPDATE job_outbox
          SET status = 'failed',
              last_error = ${message},
              completed_at = NOW()
          WHERE id = ${outboxId}
        `;
      });
    } catch (txError) {
      // If the failure transaction itself fails, re-throw so BullMQ retries.
      // The idempotency check at the top will catch the retry.
      console.error(
        `[DemoGenerationWorker] Failed to record failure for demo ${demoId}:`,
        txError,
      );
      throw txError;
    }
    // Do NOT re-throw — the failure is fully handled in Postgres.
    // BullMQ job completes cleanly. The outbox entry is already marked failed.
  }
```

---

### Task 5: Add FOR UPDATE SKIP LOCKED to OutboxPoller

**Files:**
- Modify: `worker/jobs/OutboxPoller.ts:23-30`

- [ ] **Step 1: Update the SELECT query**

Replace lines 23-30 with:

```typescript
    const entries = await sql<OutboxEntry[]>`
      SELECT id, topic, payload, attempts, max_attempts
      FROM job_outbox
      WHERE status = 'pending'
        AND available_at <= NOW()
      ORDER BY available_at
      LIMIT ${BATCH_SIZE}
      FOR UPDATE SKIP LOCKED
    `;
```

This prevents overlapping poll cycles from double-dispatching the same entry. BullMQ's `jobId` dedup is the ultimate safety net, but `SKIP LOCKED` avoids noisy duplicate dispatch attempts.

---

### Task 6: Store category in prospect_demos INSERT

**Files:**
- Modify: `src/app/api/admin/demos/generate/route.ts:51-55`

- [ ] **Step 1: Add category to the INSERT**

The `prospect_demos` table has a `category` column via the `businesses` schema pattern but we need to check. Looking at the schema — `prospect_demos` does NOT have a `category` column. The category travels through the outbox payload to the worker. This is actually fine as-is since the worker gets it from the BullMQ job data.

**SKIP this task** — the category is already correctly passed through the outbox payload → BullMQ job → `DemoGeneratorInput`. The `prospect_demos` table doesn't have a `category` column and doesn't need one.

---

### Task 7: Create .env.example

**Files:**
- Create: `.env.example`

- [ ] **Step 1: Create the template file**

Create `.env.example` with all required variable names, placeholder values, and documentation comments. No real secrets.

```env
# =============================================================================
# RepWorth — Environment Variables
# =============================================================================
# Copy to .env.local and fill in actual values. NEVER commit .env.local to git.
# Server-only vars: SUPABASE_SERVICE_KEY, *_WEBHOOK_SECRET, *_SECRET
# =============================================================================

# --- Database (Supabase) ---
DATABASE_URL=postgresql://postgres:YOUR_PASSWORD@db.YOUR_REF.supabase.co:5432/postgres
DATABASE_POOL_URL=postgresql://postgres.YOUR_REF:YOUR_PASSWORD@aws-0-YOUR_REGION.pooler.supabase.com:6543/postgres?pgbouncer=true
SUPABASE_URL=https://YOUR_REF.supabase.co
SUPABASE_SERVICE_KEY=eyJ...                   # SERVER-ONLY

# --- Public Supabase (safe for browser) ---
NEXT_PUBLIC_SUPABASE_URL=https://YOUR_REF.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...

# --- Redis — TWO separate instances ---
REDIS_CACHE_URL=rediss://default:YOUR_TOKEN@YOUR_HOST.upstash.io:6379
REDIS_CACHE_TOKEN=                            # Upstash REST token (if using REST URL)
REDIS_QUEUE_URL=rediss://default:YOUR_TOKEN@YOUR_HOST.upstash.io:6379
REDIS_QUEUE_TOKEN=                            # Upstash REST token (if using REST URL)

# --- LLM Providers ---
OPENAI_API_KEY=sk-proj-...
ANTHROPIC_API_KEY=sk-ant-api03-...

# --- Review Data ---
SERPAPI_API_KEY=...

# --- Notifications ---
RESEND_API_KEY=re_...
RESEND_WEBHOOK_SECRET=                        # SERVER-ONLY

# --- Payments ---
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...               # SERVER-ONLY

# --- Security ---
ENCRYPTION_KEY=                               # SERVER-ONLY — random 32-byte hex (openssl rand -hex 32)
ENCRYPTION_KEY_VERSION=1
SESSION_COOKIE_SECRET=                        # SERVER-ONLY — random 32+ char string
CSRF_SECRET=                                  # SERVER-ONLY — random 32+ char string

# --- App URLs ---
NEXT_PUBLIC_APP_URL=http://localhost:3000
WORKER_SERVICE_URL=http://localhost:3001
SENTRY_DSN=

# --- Mock mode (set to 'true' to bypass SerpAPI + LLM calls) ---
MOCK_EXTERNAL_APIS=false

# --- Added in Phase 5 (GBP API) ---
# GOOGLE_CLIENT_ID=
# GOOGLE_CLIENT_SECRET=
# GCP_PROJECT_ID=

# --- Configurable (defaults in code) ---
# OUTBOX_BATCH_SIZE=50
# DAILY_COST_LIMIT_CENTS_FOUNDING=500
# DAILY_COST_LIMIT_CENTS_STANDARD=1000
# GLOBAL_DAILY_COST_LIMIT_CENTS=10000
```

---

### Task 8: Fix Calendly placeholder

**Files:**
- Modify: `src/app/(public)/demo/[slug]/page.tsx:112-119`

- [ ] **Step 1: Replace placeholder link with a non-clickable CTA**

Replace the Calendly link (lines 112-119) with a CTA that doesn't point to a broken URL:

```tsx
          <a
            href="/contact"
            className="inline-block bg-blue-600 text-white font-medium px-6 py-3 rounded-lg hover:bg-blue-700 transition-colors"
          >
            Get Started with RepWorth
          </a>
          <p className="text-sm text-gray-400 mt-2">
            Contact us to set up AI-powered review responses for your business.
          </p>
```

---

### Task 9: Create vitest.config.ts

**Files:**
- Create: `vitest.config.ts`

- [ ] **Step 1: Create Vitest config with path aliases**

```typescript
import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts', 'worker/**/__tests__/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
```

- [ ] **Step 2: Run tests to verify config works**

Run: `pnpm test`
Expected: All existing tests discover and run. No "cannot resolve @/lib/..." errors.

---

### Task 10: Update CLAUDE.md

**Files:**
- Modify: `.claude/CLAUDE.md`

- [ ] **Step 1: Apply all improvements**

Changes to make:

1. **Fix Sprint 6**: Remove "Sprint 6: NOT STARTED" — the plan has 5 sprints + GBP API Phase 5. Replace with the actual structure.

2. **Add `worker/env.ts`** to directory structure comment.

3. **Fix package name**: The tech stack says worker uses "Fastify HTTP server" — add note that the package is `fastify-raw-body` (not `@fastify/raw-body`).

4. **Add test/dev commands section** after "Testing approach":

```markdown
## Dev commands
- `pnpm dev` — Next.js dev server (port 3000)
- `pnpm worker` — Railway worker (port 3001)
- `pnpm test` — Run Vitest unit tests
- `pnpm test:watch` — Vitest in watch mode
- `pnpm test:e2e` — Playwright E2E tests
- Set `MOCK_EXTERNAL_APIS=true` in `.env.local` to bypass SerpAPI + LLM calls
```

5. **Add demo mode vs production mode note** under "Key patterns to follow":

```markdown
- **Demo vs Production mode**: The response generator has two modes. Demo mode (used by DemoGenerationWorker) skips cost guards, caching, and voice learning — fast feedback for prospect demos. Production mode (used by ResponseGeneratorWorker) runs the full cost guard lifecycle: reserve → concurrency slot → generate → finalize → cache → audit. The mode is set via `GenerationOptions.mode`.
```

---

### Task 11: Add MOCK_EXTERNAL_APIS to .env.local

**Files:**
- Modify: `.env.local`

- [ ] **Step 1: Add the mock flag**

Append to `.env.local`:

```env
# --- Mock mode ---
MOCK_EXTERNAL_APIS=true
```

Set to `true` for local testing without API keys. Set to `false` (or remove) for real SerpAPI + LLM calls.

---

### Task 12: Verify the full pipeline end-to-end

- [ ] **Step 1: Start the worker**

Run: `pnpm worker`
Expected: "Worker service running on port 3001" + "[OutboxPoller] Starting"

- [ ] **Step 2: Start the Next.js dev server**

Run: `pnpm dev`
Expected: "Ready on http://localhost:3000"

- [ ] **Step 3: Generate a mock demo**

Open http://localhost:3000/admin/demos in browser.
Enter any Google Maps URL (e.g., `https://www.google.com/maps/place/?q=place_id:ChIJN1t_tDeuEmsRUsoyG83frY4`), a business name, and optional category.
Click "Generate Demo".

Expected: Status transitions queued → running → completed. No SerpAPI or LLM calls made. Demo link appears.

- [ ] **Step 4: View the demo**

Click the demo link.
Expected: 8 mock reviews with AI response templates. Multilingual badges on Spanish, French, German reviews. Mobile-responsive layout.

- [ ] **Step 5: Commit all changes**

```bash
git add -A
git commit -m "fix: Sprint 1 audit fixes — mock data path, outbox locking, worker cleanup, CLAUDE.md updates"
```
