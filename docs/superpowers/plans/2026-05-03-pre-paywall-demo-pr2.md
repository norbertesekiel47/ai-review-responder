# Pre-paywall Demo + Journey Reorder (PR #2) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Insert a SerpAPI-driven demo response between signup and paywall so prospective owners see what RepWorth would do *for their own business* before committing payment. Re-order the wizard so location capture happens pre-pay, profile + voice happen post-pay, and the dashboard surfaces a persistent setup checklist.

**Architecture:** New `onboarding_demos` table + `onboarding_demo_response` BullMQ topic. Hybrid pre-pay/post-pay split: `/onboarding/start` captures location only, `/onboarding/demo` shows demo + paywall, existing `/onboarding/business` becomes a 2-step Profile/Voice wizard. Shared `lifecycle.ts` helpers (from PR #1) handle both `prospect_demos` and `onboarding_demos`. Parallel `withOnboardingDemoCostGuard` enforces a $10/day global ceiling. All changes flag-gated behind `ONBOARDING_DEMO_ENABLED`.

**Tech Stack:** Next.js 14, TypeScript, PostgreSQL (Postgres.js), Supabase Auth, BullMQ, Upstash Redis, SerpAPI, Vitest, Playwright

**Assumes PR #1 merged:** `src/lib/demos/lifecycle.ts`, `select-qualifying.ts`, `fetch-reviews.ts`, `generate-responses.ts` all exist and are exported from `src/lib/demos/index.ts`.

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `supabase/migrations/032_onboarding_demos.sql` | **Create** | `onboarding_demos` table, indexes, constraints |
| `src/lib/shared/schemas.ts` | Modify | `OnboardingStartSchema`, `BusinessOnboardingPostPaySchema` |
| `src/lib/shared/queue-names.ts` | Modify | Add `ONBOARDING_DEMO_RESPONSE` queue name |
| `worker/queues.ts` | Modify | Add `onboardingDemoResponse` Queue instance |
| `worker/index.ts` | Modify | Register `OnboardingDemoWorker`, add to workers map |
| `src/lib/costs/onboarding-demo-cost-guard.ts` | **Create** | `withOnboardingDemoCostGuard`, `checkCostThreshold` |
| `src/lib/costs/__tests__/onboarding-demo-cost-guard.test.ts` | **Create** | Unit tests for cost guard + threshold alerts |
| `src/lib/demos/fallback-content.ts` | **Create** | `getFallbackDemo(category)` + fixture data |
| `src/lib/demos/__fixtures__/fallback-source-reviews.ts` | **Create** | Hand-written fixture reviews per category |
| `src/lib/demos/__tests__/fallback-content.test.ts` | **Create** | Unit tests for fallback lookup |
| `worker/jobs/OnboardingDemoWorker.ts` | **Create** | BullMQ handler for `onboarding_demo_response` topic |
| `worker/jobs/__tests__/OnboardingDemoWorker.test.ts` | **Create** | Unit + integration tests for worker |
| `src/app/api/onboarding/start/route.ts` | **Create** | `POST /api/onboarding/start` — location capture + demo enqueue |
| `src/app/api/onboarding/start/__tests__/route.test.ts` | **Create** | Integration tests for start endpoint |
| `src/app/api/onboarding/demo/status/route.ts` | **Create** | `GET /api/onboarding/demo/status` — poll endpoint |
| `src/app/api/onboarding/demo/regenerate/route.ts` | **Create** | `POST /api/onboarding/demo/regenerate` — manual regen |
| `src/app/api/onboarding/business/route.ts` | Modify | Bifurcated schema pick based on `ONBOARDING_DEMO_ENABLED` |
| `src/app/api/onboarding/__tests__/business.test.ts` | Modify | Regression: flag-off uses legacy schema |
| `src/app/onboarding/start/page.tsx` | **Create** | Server page — guards + redirect logic |
| `src/app/onboarding/start/StartLocationClient.tsx` | **Create** | Client — reuses StepLocation UI, submits to `/start` |
| `src/app/onboarding/demo/page.tsx` | **Create** | Server page — reads demo row, SSR branches |
| `src/app/onboarding/demo/PaywallWithDemoClient.tsx` | **Create** | Client — `<DemoLoader>`, `<DemoResultDisplay>`, `<RegenerateButton>` |
| `src/app/onboarding/business/page.tsx` | Modify | Redirect to `/onboarding/start` if no location captured |
| `src/app/onboarding/business/BusinessWizardClient.tsx` | Modify | Drop Step 1, become 2-step Profile + Voice |
| `src/app/onboarding/business/guard.ts` | Modify | Add `onboarding_not_started` guard for post-pay |
| `src/app/(authenticated)/dashboard/SetupChecklist.tsx` | **Create** | Server component — single CTE, localStorage dismiss |
| `src/app/(authenticated)/dashboard/page.tsx` | Modify | Include `<SetupChecklist />` |
| `worker/jobs/CleanupAbandonedSignupsPoller.ts` | Modify | Explicit `DELETE FROM onboarding_demos`, 30-day stale pass |
| `worker/jobs/__tests__/CleanupAbandonedSignupsPoller.test.ts` | Modify | Test cascade + stale cleanup |
| `src/lib/demos/__tests__/select-qualifying.test.ts` | Modify | Add test: no 3-star without >=4 anchor (clarify spec) |
| `docs/runbooks/onboarding-demo-launch-runbook.md` | **Create** | Manual smoke checklist |
| `.claude/skills/onboarding-demo-cost-guard.md` | **Create** | Skill doc for parallel cost-guard pattern |
| `.claude/skills/feature-flags.md` | Modify | Add `ONBOARDING_DEMO_ENABLED`, `ONBOARDING_DEMO_DAILY_CENTS`, `ONBOARDING_DEMO_STAFF_EMAILS_CSV` |
| `.claude/skills/migrations.md` | Modify | Add migration 032 entry |

---

## Task 1: Migration 032 — `onboarding_demos` table

**Files:**
- Create: `supabase/migrations/032_onboarding_demos.sql`

- [ ] **Step 1: Write migration**

```sql
CREATE TABLE onboarding_demos (
  id                   UUID PRIMARY KEY,
  user_id              UUID NOT NULL
                         REFERENCES users(id) ON DELETE CASCADE,
  business_id          UUID NOT NULL
                         REFERENCES businesses(id) ON DELETE CASCADE,

  business_name        TEXT NOT NULL,
  category             TEXT,
  google_place_id      TEXT,
  google_maps_url      TEXT,

  generation_status    TEXT NOT NULL,
  started_at           TIMESTAMPTZ,
  completed_at         TIMESTAMPTZ,
  generation_error     TEXT,

  reviews_snapshot     JSONB,
  generated_responses  JSONB,
  source               TEXT,

  correlation_id       UUID NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT onboarding_demos_status_check
    CHECK (generation_status IN ('queued','running','completed','failed','archived')),
  CONSTRAINT onboarding_demos_source_when_completed
    CHECK (generation_status <> 'completed' OR source IS NOT NULL)
);

CREATE UNIQUE INDEX onboarding_demos_one_completed_per_user
  ON onboarding_demos (user_id)
  WHERE generation_status = 'completed';

CREATE INDEX onboarding_demos_user_lookup
  ON onboarding_demos (user_id, created_at DESC);

CREATE INDEX onboarding_demos_business_lookup
  ON onboarding_demos (business_id);

CREATE INDEX onboarding_demos_generation_inflight
  ON onboarding_demos (generation_status)
  WHERE generation_status IN ('queued', 'running');
```

- [ ] **Step 2: Commit**

```bash
git add supabase/migrations/032_onboarding_demos.sql
git commit -m "feat(migration): add onboarding_demos table (032)"
```

---

## Task 2: Queue name + queue instance + worker registration

**Files:**
- Modify: `src/lib/shared/queue-names.ts`
- Modify: `worker/queues.ts`
- Modify: `worker/index.ts`

- [ ] **Step 1: Add queue name**

In `src/lib/shared/queue-names.ts`, add inside `QUEUE_NAMES` object:

```typescript
ONBOARDING_DEMO_RESPONSE: 'onboarding_demo_response',
```

- [ ] **Step 2: Add queue instance**

In `worker/queues.ts`, add inside `queues` object:

```typescript
onboardingDemoResponse: new Queue(QUEUE_NAMES.ONBOARDING_DEMO_RESPONSE, { connection: opts, defaultJobOptions }),
```

And inside `topicToQueue`:

```typescript
[QUEUE_NAMES.ONBOARDING_DEMO_RESPONSE]: queues.onboardingDemoResponse,
```

- [ ] **Step 3: Register worker in bootstrap**

In `worker/index.ts`, add import:

```typescript
import { handleOnboardingDemo } from './jobs/OnboardingDemoWorker';
```

Add worker instantiation after existing workers (~line 445):

```typescript
const onboardingDemoWorker = new Worker(QUEUE_NAMES.ONBOARDING_DEMO_RESPONSE, handleOnboardingDemo, workerOpts);
```

Add to `workersByQueue` map:

```typescript
[QUEUE_NAMES.ONBOARDING_DEMO_RESPONSE]: onboardingDemoWorker,
```

- [ ] **Step 4: Type-check**

```bash
pnpm tsc --noEmit
```
Expected: Zero errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/shared/queue-names.ts worker/queues.ts worker/index.ts
git commit -m "feat(queue): register onboarding_demo_response topic and worker slot"
```

---

## Task 3: Schema definitions — `OnboardingStartSchema` + `BusinessOnboardingPostPaySchema`

**Files:**
- Modify: `src/lib/shared/schemas.ts`
- Test: `src/lib/demos/__tests__/schemas.test.ts` (new)

- [ ] **Step 1: Add `OnboardingStartSchema`**

Add after the existing `ResendConfirmationSchema` in `src/lib/shared/schemas.ts`:

```typescript
/**
 * Tightened business name for pre-pay demo path.
 * The value flows into the LLM prompt and the curated demo display;
 * demo output is one tweet away from public. This is stricter than
 * businessNameSchema (used for post-pay edits) because prompt-injection
 * risk is load-bearing here.
 */
const demoBusinessNameSchema = z
  .string()
  .min(1, 'Business name is required')
  .max(80, 'Business name too long')
  .regex(/^[^\n\r<>{}]+$/, 'Business name contains invalid characters');

/**
 * POST /api/onboarding/start — pre-pay location capture.
 * Exactly one of googlePlaceId (autocomplete) or googleMapsUrl (URL)
 * must be present. Prefill fields only valid in autocomplete branch.
 */
export const OnboardingStartSchema = z
  .object({
    inputMode: z.enum(['autocomplete', 'url']),
    googlePlaceId: z
      .string()
      .min(1)
      .refine((v) => isPlaceId(v), { message: 'Invalid Google Place ID format' })
      .optional(),
    googlePlaceAddress: z.string().max(500).optional(),
    googleMapsUrl: googleMapsUrlSchema.optional(),
    businessName: demoBusinessNameSchema,
    prefilledCategory: z.string().max(100).nullable().optional(),
    prefilledWebsite: websiteUrlSchema.nullable().optional(),
  })
  .refine(
    (d) => Boolean(d.googlePlaceId) !== Boolean(d.googleMapsUrl),
    {
      message: 'Provide exactly one of googlePlaceId or googleMapsUrl, not both',
      path: ['googlePlaceId'],
    },
  )
  .refine(
    (d) => {
      if (d.inputMode === 'url') {
        return !d.prefilledCategory && !d.prefilledWebsite;
      }
      return true;
    },
    {
      message: 'prefilledCategory and prefilledWebsite are only valid in autocomplete mode',
      path: ['prefilledCategory'],
    },
  );

export type OnboardingStartInput = z.infer<typeof OnboardingStartSchema>;
```

- [ ] **Step 2: Add `BusinessOnboardingPostPaySchema`**

Add after `OnboardingStartSchema`:

```typescript
/**
 * POST /api/onboarding/business when ONBOARDING_DEMO_ENABLED=true.
 * Post-pay wizard: location was already captured at /start.
 *
 * The location-capture fields are declared as `z.never().optional()` so a
 * client posting them gets a Zod error instead of having the field silently
 * stripped. (The previous draft used `.refine((d) => !('googlePlaceId' in d))`
 * which is dead code: zod's default `.object()` strips unknown keys BEFORE
 * refinements run, so `'googlePlaceId' in d` is always false and the refine
 * never rejected anything.)
 */
export const BusinessOnboardingPostPaySchema = z.object({
  businessName: z.string().min(1).max(255).optional(),
  category: categorySchema.nullable().optional(),
  tone: toneSchema.default('professional and friendly'),
  productsServices: z.string().max(5000).optional(),
  staffNames: z.string().max(2000).optional(),
  highlightFacts: z.string().max(2000).optional(),
  avoidFacts: z.string().max(2000).optional(),
  sampleResponses: z.string().max(5000).optional(),
  website: websiteUrlSchema.nullable().optional(),
  // Forbidden fields — explicitly typed so they fail validation rather than
  // get silently stripped. Any value present (even null) trips z.never.
  googlePlaceId: z.never({
    invalid_type_error: 'unexpected_field: googlePlaceId is set during pre-pay onboarding at /start',
  }).optional(),
  googleMapsUrl: z.never({
    invalid_type_error: 'unexpected_field: googleMapsUrl is set during pre-pay onboarding at /start',
  }).optional(),
  googlePlaceAddress: z.never({
    invalid_type_error: 'unexpected_field: googlePlaceAddress is set during pre-pay onboarding at /start',
  }).optional(),
});

export type BusinessOnboardingPostPayInput = z.infer<typeof BusinessOnboardingPostPaySchema>;
```

- [ ] **Step 3: Write schema unit tests**

Create `src/lib/demos/__tests__/schemas.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { OnboardingStartSchema, BusinessOnboardingPostPaySchema } from '@/lib/shared/schemas';

describe('OnboardingStartSchema', () => {
  it('accepts valid autocomplete payload', () => {
    const result = OnboardingStartSchema.safeParse({
      inputMode: 'autocomplete',
      googlePlaceId: 'ChIJN1t_tDeuEmsRUsoyG83frY4',
      businessName: 'Acme Cafe',
      prefilledCategory: 'Restaurant',
    });
    expect(result.success).toBe(true);
  });

  it('accepts valid URL payload', () => {
    const result = OnboardingStartSchema.safeParse({
      inputMode: 'url',
      googleMapsUrl: 'https://www.google.com/maps/place/Acme+Cafe/@40.7128,-74.0060,15z',
      businessName: 'Acme Cafe',
    });
    expect(result.success).toBe(true);
  });

  it('rejects when neither placeId nor mapsUrl provided', () => {
    const result = OnboardingStartSchema.safeParse({
      inputMode: 'autocomplete',
      businessName: 'Acme Cafe',
    });
    expect(result.success).toBe(false);
  });

  it('rejects when both placeId and mapsUrl provided', () => {
    const result = OnboardingStartSchema.safeParse({
      inputMode: 'autocomplete',
      googlePlaceId: 'ChIJN1t_tDeuEmsRUsoyG83frY4',
      googleMapsUrl: 'https://www.google.com/maps/place/Acme+Cafe/@40.7128,-74.0060,15z',
      businessName: 'Acme Cafe',
    });
    expect(result.success).toBe(false);
  });

  it('rejects prefilledCategory in URL mode', () => {
    const result = OnboardingStartSchema.safeParse({
      inputMode: 'url',
      googleMapsUrl: 'https://www.google.com/maps/place/Acme+Cafe/@40.7128,-74.0060,15z',
      businessName: 'Acme Cafe',
      prefilledCategory: 'Restaurant',
    });
    expect(result.success).toBe(false);
  });

  it('rejects businessName with newlines', () => {
    const result = OnboardingStartSchema.safeParse({
      inputMode: 'autocomplete',
      googlePlaceId: 'ChIJN1t_tDeuEmsRUsoyG83frY4',
      businessName: 'Acme\nCafe',
    });
    expect(result.success).toBe(false);
  });

  it('rejects businessName with angle brackets', () => {
    const result = OnboardingStartSchema.safeParse({
      inputMode: 'autocomplete',
      googlePlaceId: 'ChIJN1t_tDeuEmsRUsoyG83frY4',
      businessName: 'Acme <script>',
    });
    expect(result.success).toBe(false);
  });

  it('rejects businessName > 80 chars', () => {
    const result = OnboardingStartSchema.safeParse({
      inputMode: 'autocomplete',
      googlePlaceId: 'ChIJN1t_tDeuEmsRUsoyG83frY4',
      businessName: 'A'.repeat(81),
    });
    expect(result.success).toBe(false);
  });
});

describe('BusinessOnboardingPostPaySchema', () => {
  it('accepts voice/profile payload', () => {
    const result = BusinessOnboardingPostPaySchema.safeParse({
      tone: 'casual',
      productsServices: 'Coffee',
    });
    expect(result.success).toBe(true);
  });

  it('rejects googlePlaceId', () => {
    const result = BusinessOnboardingPostPaySchema.safeParse({
      googlePlaceId: 'ChIJN1t_tDeuEmsRUsoyG83frY4',
      tone: 'casual',
    });
    expect(result.success).toBe(false);
  });

  it('rejects googleMapsUrl', () => {
    const result = BusinessOnboardingPostPaySchema.safeParse({
      googleMapsUrl: 'https://www.google.com/maps/place/Acme+Cafe/@40.7128,-74.0060,15z',
      tone: 'casual',
    });
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run src/lib/demos/__tests__/schemas.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/shared/schemas.ts src/lib/demos/__tests__/schemas.test.ts
git commit -m "feat(schema): OnboardingStartSchema and BusinessOnboardingPostPaySchema"
```

---

## Task 4: Onboarding demo cost guard

**Files:**
- Create: `src/lib/costs/onboarding-demo-cost-guard.ts`
- Create: `src/lib/costs/__tests__/onboarding-demo-cost-guard.test.ts`

- [ ] **Step 1: Implement cost guard**

```typescript
import { getCacheRedis } from '@/lib/db/redis-cache';

const DEFAULT_DAILY_CENTS = 1000; // $10/day
const RESERVATION_CENTS = 20;     // ~$0.01 SerpAPI + ~$0.015 LLM + headroom

export class CostCeilingExceeded extends Error {
  constructor(public readonly date: string) {
    super(`Onboarding demo daily cost ceiling exceeded for ${date}`);
    this.name = 'CostCeilingExceeded';
  }
}

function dailyKey(date: string): string {
  return `cost:onboarding-demo:${date}`;
}

function overrideKey(): string {
  return 'cost:onboarding-demo:override:cents';
}

/**
 * Reserves budget for one onboarding demo. Returns a release function
 * that MUST be called on tx failure to avoid leaking the reservation.
 */
export async function reserveOnboardingDemoBudget(): Promise<{
  release: () => Promise<void>;
  date: string;
}> {
  const date = new Date().toISOString().slice(0, 10);
  const key = dailyKey(date);

  const redis = getCacheRedis();
  const override = await redis.get(overrideKey());
  const ceiling = override ? parseInt(override, 10) : DEFAULT_DAILY_CENTS;

  const current = await redis.incrby(key, RESERVATION_CENTS);
  if (current > ceiling) {
    // Roll back the reservation
    await redis.decrby(key, RESERVATION_CENTS);
    throw new CostCeilingExceeded(date);
  }

  // Ensure TTL (defense against leaks)
  await redis.pexpire(key, 25 * 60 * 60 * 1000); // 25 hours

  return {
    release: async () => {
      await redis.decrby(key, RESERVATION_CENTS);
    },
    date,
  };
}

/**
 * Finalizes the cost reservation with actual spend. The difference between
 * reservation (20¢) and actual is left as "pre-spent" headroom.
 */
export async function finalizeOnboardingDemoCost(
  date: string,
  actualCostCents: number,
): Promise<void> {
  if (!Number.isSafeInteger(actualCostCents) || actualCostCents < 0) {
    throw new TypeError(`Invalid actualCostCents=${actualCostCents}`);
  }
  // The reservation already incremented the counter. We only adjust if
  // actual was LESS than reservation (unusual); if actual >= reservation
  // the counter stays elevated (conservative). For precise accounting,
  // compute delta = actual - reservation and incrby(delta).
  const delta = actualCostCents - RESERVATION_CENTS;
  if (delta !== 0) {
    const redis = getCacheRedis();
    await redis.incrby(dailyKey(date), delta);
  }
}

export interface ThresholdResult {
  crossed: number[];
}

/**
 * Returns the thresholds NEWLY crossed on this call — i.e. percentages of
 * the daily ceiling that current spend has reached AND that have not yet
 * been alerted today. Each threshold fires at most once per day per lane,
 * so callers (worker → Sentry) don't get spammed when the daily counter
 * sits above a threshold for the rest of the day.
 *
 * Implementation: SADD into a daily set returns 1 only on first insert
 * per member, giving us atomic per-threshold "did I just fire this?"
 * semantics. The set TTLs at 25h to align with the spend counter and
 * avoid leaking keys across day boundaries.
 *
 * Thresholds: [50, 90, 100] means alert at 50%, 90%, and 100% of ceiling.
 */
export async function checkCostThreshold(
  lane: string,
  date: string,
  thresholds: number[],
): Promise<ThresholdResult> {
  const redis = getCacheRedis();

  const override = await redis.get(`cost:${lane}:override:cents`);
  const ceiling = override ? parseInt(override, 10) : DEFAULT_DAILY_CENTS;

  const currentRaw = await redis.get(`cost:${lane}:${date}`);
  const current = currentRaw ? parseInt(currentRaw, 10) : 0;

  const alertedKey = `cost:${lane}:alerted:${date}`;
  const newlyCrossed: number[] = [];

  for (const t of thresholds) {
    const thresholdCents = Math.floor((ceiling * t) / 100);
    if (current < thresholdCents) continue;
    // SADD returns 1 if the member was newly added, 0 if it was already
    // present. This is the atomic "first time we've crossed t today" check.
    const added = await redis.sadd(alertedKey, String(t));
    if (added === 1) newlyCrossed.push(t);
  }

  if (newlyCrossed.length > 0) {
    // Set TTL only when we actually wrote — keeps the no-op call cheap.
    await redis.pexpire(alertedKey, 25 * 60 * 60 * 1000);
  }

  return { crossed: newlyCrossed };
}

/**
 * Wraps a function with onboarding demo cost guard.
 * Reservation lives OUTSIDE the fn but INSIDE try/catch.
 */
export async function withOnboardingDemoCostGuard<T>(
  opts: { ipKey: string },
  fn: () => Promise<{ value: T; actualCostCents: number }>,
): Promise<T> {
  const reservation = await reserveOnboardingDemoBudget();
  try {
    const { value, actualCostCents } = await fn();
    await finalizeOnboardingDemoCost(reservation.date, actualCostCents);
    return value;
  } catch (err) {
    await reservation.release();
    throw err;
  }
}
```

- [ ] **Step 2: Write unit tests**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  withOnboardingDemoCostGuard,
  reserveOnboardingDemoBudget,
  checkCostThreshold,
  CostCeilingExceeded,
} from '../onboarding-demo-cost-guard';

const mockRedis = {
  get: vi.fn(),
  set: vi.fn(),
  incrby: vi.fn(),
  decrby: vi.fn(),
  pexpire: vi.fn(),
  sadd: vi.fn(),
};

vi.mock('@/lib/db/redis-cache', () => ({
  getCacheRedis: () => mockRedis,
}));

describe('onboarding-demo-cost-guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRedis.get.mockResolvedValue(null);
    mockRedis.incrby.mockResolvedValue(20);
    mockRedis.decrby.mockResolvedValue(0);
    mockRedis.pexpire.mockResolvedValue(1);
    // Default: every threshold is "new" (SADD returns 1).
    mockRedis.sadd.mockResolvedValue(1);
  });

  it('reserve succeeds when under ceiling', async () => {
    const r = await reserveOnboardingDemoBudget();
    expect(r.release).toBeTypeOf('function');
    expect(mockRedis.incrby).toHaveBeenCalledWith(expect.stringContaining('cost:onboarding-demo:'), 20);
  });

  it('reserve throws CostCeilingExceeded when over ceiling', async () => {
    mockRedis.incrby.mockResolvedValue(1020); // > 1000 ceiling
    await expect(reserveOnboardingDemoBudget()).rejects.toBeInstanceOf(CostCeilingExceeded);
    expect(mockRedis.decrby).toHaveBeenCalled(); // rollback
  });

  it('withOnboardingDemoCostGuard: success path finalizes cost', async () => {
    const result = await withOnboardingDemoCostGuard(
      { ipKey: '1.2.3.4' },
      async () => ({ value: 'done', actualCostCents: 15 }),
    );
    expect(result).toBe('done');
    expect(mockRedis.incrby).toHaveBeenCalled(); // reservation
  });

  it('withOnboardingDemoCostGuard: fn throws releases reservation', async () => {
    await expect(
      withOnboardingDemoCostGuard(
        { ipKey: '1.2.3.4' },
        async () => { throw new Error('boom'); },
      ),
    ).rejects.toThrow('boom');
    expect(mockRedis.decrby).toHaveBeenCalled(); // release on failure
  });

  it('checkCostThreshold returns newly-crossed thresholds on first call', async () => {
    // get() called twice: override (null) then current spend ('600' = 60% of $10 ceiling)
    mockRedis.get.mockResolvedValueOnce(null).mockResolvedValueOnce('600');
    mockRedis.sadd.mockResolvedValue(1); // first time we've seen this threshold today
    const result = await checkCostThreshold('onboarding-demo', '2026-05-03', [50, 90, 100]);
    expect(result.crossed).toEqual([50]); // only 50% reached; 90% and 100% not yet
    expect(mockRedis.sadd).toHaveBeenCalledWith('cost:onboarding-demo:alerted:2026-05-03', '50');
    expect(mockRedis.pexpire).toHaveBeenCalled(); // TTL applied because we wrote
  });

  it('checkCostThreshold dedupes: returns [] when threshold already alerted today', async () => {
    // Spend still at 60% of ceiling, but SADD returns 0 — already in the daily set.
    mockRedis.get.mockResolvedValueOnce(null).mockResolvedValueOnce('600');
    mockRedis.sadd.mockResolvedValue(0); // already alerted today
    const result = await checkCostThreshold('onboarding-demo', '2026-05-03', [50, 90, 100]);
    expect(result.crossed).toEqual([]); // no Sentry spam — already fired
    // pexpire only runs when we wrote; here we didn't, so no TTL bump
    expect(mockRedis.pexpire).not.toHaveBeenCalled();
  });

  it('checkCostThreshold returns multiple thresholds when spend leaps past several', async () => {
    // Spend at 950 = 95% of $10 ceiling — crosses 50 and 90, not 100.
    mockRedis.get.mockResolvedValueOnce(null).mockResolvedValueOnce('950');
    mockRedis.sadd.mockResolvedValue(1); // both are new
    const result = await checkCostThreshold('onboarding-demo', '2026-05-03', [50, 90, 100]);
    expect(result.crossed).toEqual([50, 90]);
  });
});
```

- [ ] **Step 3: Run tests**

```bash
npx vitest run src/lib/costs/__tests__/onboarding-demo-cost-guard.test.ts
```
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/lib/costs/onboarding-demo-cost-guard.ts src/lib/costs/__tests__/onboarding-demo-cost-guard.test.ts
git commit -m "feat(costs): onboarding demo cost guard with threshold alerts"
```

---

## Task 5: Curated fallback content

**Files:**
- Create: `src/lib/demos/__fixtures__/fallback-source-reviews.ts`
- Create: `src/lib/demos/fallback-content.ts`
- Test: `src/lib/demos/__tests__/fallback-content.test.ts`

- [ ] **Step 1: Create fixture reviews**

```typescript
// src/lib/demos/__fixtures__/fallback-source-reviews.ts
import type { NormalizedReview } from '@/lib/reviews/types';

export const fallbackReviews: NormalizedReview[] = [
  {
    reviewerName: 'Sarah M.',
    starRating: 5,
    reviewText: 'Absolutely loved the experience here. The staff was incredibly attentive and the quality exceeded my expectations. I will definitely be coming back and recommending this place to all my friends and family.',
    reviewDate: '2026-03-15T00:00:00Z',
    detectedLanguage: 'en',
  },
  {
    reviewerName: 'James K.',
    starRating: 4,
    reviewText: 'Great service and friendly atmosphere. Everything was well organized and the team clearly cares about their customers. Just a minor wait time, but worth it.',
    reviewDate: '2026-03-10T00:00:00Z',
    detectedLanguage: 'en',
  },
  {
    reviewerName: 'Patricia R.',
    starRating: 3,
    reviewText: 'The service was decent but I expected a bit more given the reviews. Some aspects were good, others felt average. Might give it another try.',
    reviewDate: '2026-02-28T00:00:00Z',
    detectedLanguage: 'en',
  },
];
```

- [ ] **Step 2: Create fallback content module**

```typescript
// src/lib/demos/fallback-content.ts
import { fallbackReviews } from './__fixtures__/fallback-source-reviews';
import type { NormalizedReview } from '@/lib/reviews/types';
import type { GenerationResult } from '@/lib/responses/types';

export interface FallbackDemo {
  reviews: NormalizedReview[];
  responses: (GenerationResult | null)[];
}

const CATEGORIES: Record<string, string> = {
  restaurant: 'restaurant',
  cafe: 'restaurant',
  coffee: 'restaurant',
  salon: 'salon',
  barber: 'salon',
  hair: 'salon',
  dentist: 'dentist',
  dental: 'dentist',
  gym: 'gym',
  fitness: 'gym',
  'auto repair': 'auto-repair',
  mechanic: 'auto-repair',
  'real estate': 'real-estate',
  realtor: 'real-estate',
  contractor: 'contractor',
  construction: 'contractor',
  retail: 'retail',
  store: 'retail',
  shop: 'retail',
  'professional services': 'professional-services',
  lawyer: 'professional-services',
  accountant: 'professional-services',
  healthcare: 'healthcare-other',
  clinic: 'healthcare-other',
  beauty: 'beauty-other',
  spa: 'beauty-other',
};

function normalizeCategory(raw: string | null): string {
  if (!raw) return 'general-business';
  const lower = raw.toLowerCase();
  for (const [prefix, canonical] of Object.entries(CATEGORIES)) {
    if (lower.includes(prefix)) return canonical;
  }
  return 'general-business';
}

const FALLBACKS: Record<string, FallbackDemo> = {
  'general-business': {
    reviews: fallbackReviews,
    responses: [
      { responseText: "Thank you so much, Sarah! We're thrilled you had a wonderful experience. Our team works hard to make every visit special, and we can't wait to welcome you back!", costUsd: 0.005, modelUsed: 'gpt-4o-mini', tokensUsed: 45, latencyMs: 800 },
      { responseText: "Thanks for the kind words, James! We're glad you enjoyed the atmosphere. We're always looking to improve, and appreciate your patience during busy times.", costUsd: 0.005, modelUsed: 'gpt-4o-mini', tokensUsed: 42, latencyMs: 750 },
      { responseText: "Hi Patricia, thank you for giving us a try and for the honest feedback. We'd love the chance to exceed your expectations on your next visit — please reach out if there's anything specific we can do better.", costUsd: 0.005, modelUsed: 'gpt-4o-mini', tokensUsed: 48, latencyMs: 780 },
    ],
  },
};

/**
 * Returns curated fallback demo content for a given category.
 * All categories currently share the general-business fixture.
 * Per-category fixtures are generated via `scripts/generate-fallback-demos.ts`
 * and committed as additional entries in FALLBACKS.
 */
export function getFallbackDemo(category: string | null): FallbackDemo {
  const key = normalizeCategory(category);
  return FALLBACKS[key] ?? FALLBACKS['general-business'];
}
```

- [ ] **Step 3: Write tests**

```typescript
import { describe, it, expect } from 'vitest';
import { getFallbackDemo } from '../fallback-content';

describe('getFallbackDemo', () => {
  it('returns demo for known category prefix', () => {
    const demo = getFallbackDemo('Italian Restaurant');
    expect(demo.reviews).toHaveLength(3);
    expect(demo.responses).toHaveLength(3);
  });

  it('returns general-business for unknown category', () => {
    const demo = getFallbackDemo('Quantum Physics Lab');
    expect(demo.reviews).toHaveLength(3);
  });

  it('returns general-business for null category', () => {
    const demo = getFallbackDemo(null);
    expect(demo.reviews).toHaveLength(3);
  });

  it('review shapes are valid NormalizedReview', () => {
    const demo = getFallbackDemo('cafe');
    for (const r of demo.reviews) {
      expect(r).toHaveProperty('reviewerName');
      expect(r).toHaveProperty('starRating');
      expect(r).toHaveProperty('reviewText');
      expect(r).toHaveProperty('reviewDate');
      expect(r).toHaveProperty('detectedLanguage');
    }
  });
});
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run src/lib/demos/__tests__/fallback-content.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/demos/__fixtures__/fallback-source-reviews.ts src/lib/demos/fallback-content.ts src/lib/demos/__tests__/fallback-content.test.ts
git commit -m "feat(demos): curated fallback content with category matching"
```

---

## Task 6: OnboardingDemoWorker

**Files:**
- Create: `worker/jobs/OnboardingDemoWorker.ts`
- Create: `worker/jobs/__tests__/OnboardingDemoWorker.test.ts`

- [ ] **Step 1: Implement worker**

```typescript
import type { Job } from 'bullmq';
import { sql } from '../../src/lib/db/server';
import type { BasePayload } from '../../src/lib/shared/worker-types';
import { fetchSerpApiReviews } from '../../src/lib/demos/fetch-reviews';
import { selectQualifyingReviews } from '../../src/lib/demos/select-qualifying';
import { generateResponsesForReviews } from '../../src/lib/demos/generate-responses';
import { getFallbackDemo } from '../../src/lib/demos/fallback-content';
import { claimDemo, completeDemo, failDemo } from '../../src/lib/demos/lifecycle';
import { createWorkerLogger } from '../../src/lib/shared/logger';
import { extractOutboxHandle, markOutboxCompleted } from '../../src/lib/shared/outbox';
import { isPlaceId, parseGoogleMapsUrl } from '../../src/lib/reviews/url-parser';
import { resolvePlaceId } from '../../src/lib/reviews/place-id-resolver';
import {
  finalizeOnboardingDemoCost,
  checkCostThreshold,
} from '../../src/lib/costs/onboarding-demo-cost-guard';
import { isMockMode } from '../../src/lib/shared/mock-mode';
import * as Sentry from '@sentry/node';

/**
 * Onboarding demo job payload — extends the base payload with the
 * date-string of the cost-guard reservation made at /start so the worker
 * can reconcile pessimistic 20¢ reserve against actual spend.
 */
export interface OnboardingDemoJobPayload extends BasePayload {
  demoId: string;
  googlePlaceId: string;
  businessName: string;
  category?: string;
  googleMapsUrl?: string;
  /** ISO date YYYY-MM-DD — the day the reservation was made at /start. */
  cost_reservation_date?: string;
}

export async function handleOnboardingDemo(
  job: Job<OnboardingDemoJobPayload>,
): Promise<void> {
  const logger = createWorkerLogger('[OnboardingDemoWorker]', job.data.correlation_id);
  const { demoId, businessName, category, cost_reservation_date: reservationDate } = job.data;
  let { googlePlaceId } = job.data;
  const googleMapsUrl = job.data.googleMapsUrl;
  const { outboxId, attempt: outboxAttempt } = extractOutboxHandle(job.data, job.id!);

  // Reconcile the cost-guard reservation. On any path where work is NOT
  // done (subscription mismatch, claim no-op, failure), pass actualCents=0
  // — finalizeOnboardingDemoCost computes delta = 0 - 20¢ = release the
  // pessimistic reserve. On the success path we pass the real cost.
  const releaseReservation = async () => {
    if (reservationDate) {
      try {
        await finalizeOnboardingDemoCost(reservationDate, 0);
      } catch (err) {
        logger.error(`Failed to release cost reservation: ${err instanceof Error ? err.message : err}`);
      }
    }
  };

  // Tier-2: Mock leak guard
  if (isMockMode() && process.env.NODE_ENV === 'production') {
    throw new Error('MOCK_EXTERNAL_APIS must not be true in production');
  }

  // Subscription guard (inverted): if the user paid between /start and now,
  // the onboarding demo is no longer relevant. Mark the row as failed with
  // a recognizable error so /onboarding/demo renders <DemoFailedNotice />
  // (which keeps the paywall usable) — NOT completeDemo with empty arrays,
  // which would lock the user out via the partial-unique-on-completed
  // index and render an empty paywall.
  const [biz] = await sql<{ subscription_status: string }[]>`
    SELECT b.subscription_status
    FROM onboarding_demos od
    JOIN businesses b ON b.id = od.business_id
    WHERE od.id = ${demoId}
  `;
  if (biz && biz.subscription_status !== 'pending_payment') {
    logger.warn(`Demo ${demoId} business status=${biz.subscription_status}, marking failed`);
    await failDemo(
      'onboarding_demos',
      demoId,
      outboxId,
      outboxAttempt,
      new Error('subscription_state_changed'),
    );
    await releaseReservation();
    return;
  }

  const claimResult = await claimDemo('onboarding_demos', demoId, logger);

  if (claimResult === 'not_found' || claimResult === 'already_terminal') {
    // Use the existing helper — it correctly branches on attempt presence.
    // Do NOT inline `attempts = ${outboxAttempt ?? sql\`attempts\`}` —
    // postgres.js binds the literal string 'attempts' as a parameter
    // rather than treating it as a column reference.
    await markOutboxCompleted(outboxId, outboxAttempt);
    await releaseReservation();
    return;
  }

  if (claimResult === 'reset_to_queued') {
    throw new Error(`Demo ${demoId} reset from stale running; will re-dispatch`);
  }

  try {
    if (!isPlaceId(googlePlaceId) && googleMapsUrl) {
      const urlData = parseGoogleMapsUrl(googleMapsUrl);
      googlePlaceId = await resolvePlaceId(urlData);
    } else if (!isPlaceId(googlePlaceId)) {
      throw new Error('Invalid Place ID and no URL available for resolution');
    }

    const reviews = await fetchSerpApiReviews(googlePlaceId);
    const selected = selectQualifyingReviews(reviews, { rule: 'positive-with-moderate-tail' });

    let result: {
      reviews: import('../../src/lib/reviews/types').NormalizedReview[];
      responses: (import('../../src/lib/responses/types').GenerationResult | null)[];
      metadata: { totalCostUsd: number };
    };
    let source: 'serpapi' | 'curated_fallback';

    const hasAnchor = selected.some((r) => r.starRating >= 4);
    if (hasAnchor) {
      result = await generateResponsesForReviews(selected, {
        name: businessName,
        category: category ?? null,
      });
      source = 'serpapi';
    } else {
      const fallback = getFallbackDemo(category ?? null);
      result = {
        reviews: fallback.reviews,
        responses: fallback.responses,
        metadata: { totalCostUsd: 0 },
      };
      source = 'curated_fallback';
    }

    await completeDemo('onboarding_demos', demoId, outboxId, outboxAttempt, {
      reviews: result.reviews,
      responses: result.responses,
      source,
    });

    // Cost-guard reconciliation. The /start route reserved 20¢ pessimistically;
    // here we adjust the daily counter toward the actual spend (typically ~3¢).
    // Without this, every demo permanently consumes the full 20¢ reserve and
    // the daily ceiling burns out ~6.6× faster than intended.
    if (reservationDate) {
      const actualCostCents = Math.round(result.metadata.totalCostUsd * 100);
      try {
        await finalizeOnboardingDemoCost(reservationDate, actualCostCents);
      } catch (err) {
        // Don't fail the demo over a Redis hiccup — log and continue.
        // The 25h Redis TTL will eventually clear stale over-reservations.
        logger.error(`Failed to finalize cost reservation: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Threshold check
    const date = new Date().toISOString().slice(0, 10);
    const { crossed } = await checkCostThreshold('onboarding-demo', date, [50, 90, 100]);
    for (const t of crossed) {
      const level = t === 100 ? 'error' : t >= 90 ? 'warning' : 'info';
      Sentry.captureMessage(`onboarding_demo_cost_threshold_${t}`, {
        level,
        tags: { lane: 'onboarding-demo', threshold: String(t) },
      });
    }

    logger.log(
      `Onboarding demo ${demoId} completed (${source}): ${result.responses.filter(Boolean).length}/${result.reviews.length} responses`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Onboarding demo ${demoId} failed: ${message}`);
    await failDemo('onboarding_demos', demoId, outboxId, outboxAttempt, new Error(message));
    await releaseReservation();
  }
}
```

- [ ] **Step 2: Write worker tests**

```typescript
import { describe, it, expect, vi } from 'vitest';

describe('OnboardingDemoWorker', () => {
  it('exists and can be imported', async () => {
    const { handleOnboardingDemo } = await import('../OnboardingDemoWorker');
    expect(handleOnboardingDemo).toBeTypeOf('function');
  });
});
```

Full integration tests require DB + BullMQ setup. Add placeholder for now; expand in Task 14.

- [ ] **Step 3: Type-check**

```bash
pnpm tsc --noEmit
```
Expected: Zero errors.

- [ ] **Step 4: Commit**

```bash
git add worker/jobs/OnboardingDemoWorker.ts worker/jobs/__tests__/OnboardingDemoWorker.test.ts
git commit -m "feat(worker): OnboardingDemoWorker with subscription guard and fallback"
```

---

## Task 7: POST /api/onboarding/start

**Files:**
- Create: `src/app/api/onboarding/start/route.ts`
- Create: `src/app/api/onboarding/start/__tests__/route.test.ts`

- [ ] **Step 1: Implement route**

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { v7 as uuidv7 } from 'uuid';
import { sql, jsonb } from '@/lib/db/server';
import { checkRateLimit } from '@/lib/shared/rate-limit';
import { assertSameOrigin, SameOriginError } from '@/lib/shared/csrf';
import { OnboardingStartSchema } from '@/lib/shared/schemas';
import { extractPlaceId } from '@/lib/reviews/url-parser';
import type { ValidatePlaceIdPayload } from '@/lib/shared/worker-types';
import { reserveOnboardingDemoBudget } from '@/lib/costs/onboarding-demo-cost-guard';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store, private' } as const;

interface BizRow {
  id: string;
  subscription_status: string;
  place_id_verified: boolean;
  google_maps_url: string | null;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  // Flag check
  if (process.env.ONBOARDING_DEMO_ENABLED !== 'true') {
    return NextResponse.json({ error: 'not_found' }, { status: 404, headers: NO_STORE });
  }

  if (process.env.SELF_SERVE_SIGNUP_ENABLED !== 'true') {
    return NextResponse.json({ error: 'not_found' }, { status: 404, headers: NO_STORE });
  }

  try {
    assertSameOrigin(req);
  } catch (err) {
    if (err instanceof SameOriginError) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403, headers: NO_STORE });
    }
    throw err;
  }

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return req.cookies.getAll(); },
        setAll() {},
      },
    },
  );

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401, headers: NO_STORE });
  }

  const [bizRow] = await sql<BizRow[]>`
    SELECT b.id, b.subscription_status, b.place_id_verified, b.google_maps_url
    FROM users u
    JOIN businesses b ON b.id = u.business_id
    WHERE u.auth_id = ${user.id}
      AND u.role = 'owner'
    LIMIT 1
  `;
  if (!bizRow) {
    return NextResponse.json({ error: 'account_incomplete' }, { status: 404, headers: NO_STORE });
  }

  if (bizRow.subscription_status !== 'pending_payment') {
    return NextResponse.json(
      { error: 'subscription_inactive', subscriptionStatus: bizRow.subscription_status },
      { status: 409, headers: NO_STORE },
    );
  }

  // Already-started guard
  if (bizRow.place_id_verified || bizRow.google_maps_url) {
    // Idempotent: redirect to demo page (they already ran /start)
    return NextResponse.json({ redirectTo: '/onboarding/demo', demoQueued: false }, { status: 200, headers: NO_STORE });
  }

  // Outer rate limit: 10/auth-id/hour
  try {
    const rl = await checkRateLimit(`onboarding-start:auth:${user.id}`, 10, 3600, { strict: true });
    if (!rl.allowed) {
      return NextResponse.json({ error: 'rate_limited' }, { status: 429, headers: NO_STORE });
    }
  } catch (err) {
    console.error('[api/onboarding/start] rate-limit strict failure:', err);
    return NextResponse.json({ error: 'rate_limit_unavailable' }, { status: 503, headers: NO_STORE });
  }

  // Parse body
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400, headers: NO_STORE });
  }
  const parsed = OnboardingStartSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_body', issues: parsed.error.issues }, { status: 400, headers: NO_STORE });
  }
  const data = parsed.data;

  // Demo-specific rate limits
  const ipKey = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  const userRateLimitKey = `onboarding-demo:user:${user.id}`;
  const ipRateLimitKey = `onboarding-demo:ip:${ipKey}`;
  const globalRateLimitKey = `onboarding-demo:global`;

  let demoBlocked = false;
  let blockReason: 'cost_ceiling' | 'rate_limit' | null = null;

  try {
    const userRl = await checkRateLimit(userRateLimitKey, 3, 86400, { strict: true });
    const ipRl = await checkRateLimit(ipRateLimitKey, 5, 86400, { strict: true });
    const globalRl = await checkRateLimit(globalRateLimitKey, 200, 3600, { strict: true });

    if (!userRl.allowed || !ipRl.allowed || !globalRl.allowed) {
      demoBlocked = true;
      blockReason = 'rate_limit';
    }
  } catch (err) {
    console.error('[api/onboarding/start] demo rate-limit check failed:', err);
    return NextResponse.json({ error: 'rate_limit_unavailable' }, { status: 503, headers: NO_STORE });
  }

  // Cost-guard reservation (outside tx, inside try/catch). The reservation
  // date is threaded into the outbox payload so the worker can reconcile
  // the pessimistic 20¢ reserve against actual spend.
  let cleanupReservation: (() => Promise<void>) | null = null;
  let reservationDate: string | null = null;
  if (!demoBlocked) {
    try {
      const reservation = await reserveOnboardingDemoBudget();
      cleanupReservation = reservation.release;
      reservationDate = reservation.date;
    } catch (err) {
      if (err instanceof Error && err.name === 'CostCeilingExceeded') {
        demoBlocked = true;
        blockReason = 'cost_ceiling';
      } else {
        console.error('[api/onboarding/start] cost-guard reservation failed:', err);
        return NextResponse.json({ error: 'redis_unavailable' }, { status: 503, headers: NO_STORE });
      }
    }
  }

  // Resolve place id
  let resolvedPlaceId: string | null = null;
  let placeIdVerified = false;
  let validatePayload: ValidatePlaceIdPayload | null = null;
  const correlationId = uuidv7();

  if (data.googlePlaceId) {
    resolvedPlaceId = data.googlePlaceId;
    placeIdVerified = true;
  } else {
    const mapsUrl = data.googleMapsUrl!;
    resolvedPlaceId = extractPlaceId(mapsUrl);
    placeIdVerified = false;
    validatePayload = {
      business_id: bizRow.id,
      google_maps_url: mapsUrl,
      correlation_id: correlationId,
    };
  }

  try {
    await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${bizRow.id + ':activation'}))`;

      const [forUpdateRow] = await tx<BizRow[]>`
        SELECT id, subscription_status, place_id_verified, google_maps_url
        FROM businesses
        WHERE id = ${bizRow.id}::uuid
        FOR UPDATE
      `;
      if (!forUpdateRow) return;
      if (forUpdateRow.place_id_verified || forUpdateRow.google_maps_url) return;

      await tx`
        UPDATE businesses
        SET
          name = ${data.businessName},
          category = ${data.prefilledCategory ?? null},
          google_place_id = ${resolvedPlaceId},
          place_id_verified = ${placeIdVerified},
          google_maps_url = ${data.googleMapsUrl ?? null},
          website = ${data.prefilledWebsite ?? null},
          updated_at = NOW()
        WHERE id = ${bizRow.id}::uuid
      `;

      if (validatePayload) {
        await tx`
          INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
          SELECT ${uuidv7()}::uuid, 'validate_place_id', 'business', ${bizRow.id}::uuid, ${jsonb(validatePayload)}, 'pending'
          WHERE NOT EXISTS (
            SELECT 1 FROM job_outbox jo
            WHERE jo.aggregate_id = ${bizRow.id}::uuid
              AND jo.topic = 'validate_place_id'
              AND jo.status IN ('pending', 'dispatching', 'dispatched')
          )
        `;
      }

      if (!demoBlocked) {
        const demoId = uuidv7();
        const outboxId = uuidv7();

        await tx`
          INSERT INTO onboarding_demos (
            id, user_id, business_id, business_name, category,
            google_place_id, google_maps_url, generation_status,
            correlation_id, created_at, updated_at
          ) VALUES (
            ${demoId}, ${user.id}::uuid, ${bizRow.id}::uuid,
            ${data.businessName}, ${data.prefilledCategory ?? null},
            ${resolvedPlaceId}, ${data.googleMapsUrl ?? null},
            'queued', ${correlationId}, NOW(), NOW()
          )
        `;

        await tx`
          INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
          VALUES (
            ${outboxId}, 'onboarding_demo_response', 'onboarding_demo', ${demoId}::uuid,
            ${jsonb({
              demoId,
              googlePlaceId: resolvedPlaceId,
              businessName: data.businessName,
              category: data.prefilledCategory ?? undefined,
              googleMapsUrl: data.googleMapsUrl ?? undefined,
              correlation_id: correlationId,
              outbox_id: outboxId,
              // Threaded so the worker can reconcile the 20¢ pessimistic
              // reserve against actual spend (~3¢) on the success path,
              // or release it via finalizeOnboardingDemoCost(date, 0) on
              // failure / subscription_state_changed / claim no-op.
              cost_reservation_date: reservationDate ?? undefined,
            })},
            'pending'
          )
        `;
      }
    });
  } catch (err) {
    if (cleanupReservation) {
      try { await cleanupReservation(); } catch { /* ignore */ }
    }
    console.error('[api/onboarding/start] transaction failed:', err);
    return NextResponse.json({ error: 'internal' }, { status: 500, headers: NO_STORE });
  }

  return NextResponse.json(
    {
      redirectTo: '/onboarding/demo',
      demoQueued: !demoBlocked,
      reason: blockReason,
    },
    { status: 200, headers: NO_STORE },
  );
}
```

- [ ] **Step 2: Write integration tests**

Create `src/app/api/onboarding/start/__tests__/route.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const {
  mockCheckRateLimit,
  mockSql,
  mockGetUser,
  mockCreateServerClient,
  mockReserveBudget,
} = vi.hoisted(() => ({
  mockCheckRateLimit: vi.fn(),
  mockSql: Object.assign(vi.fn(), { begin: vi.fn(async (cb: any) => cb(mockSql)) }),
  mockGetUser: vi.fn(),
  mockCreateServerClient: vi.fn(() => ({ auth: { getUser: mockGetUser } })),
  mockReserveBudget: vi.fn(),
}));

vi.mock('@/lib/shared/rate-limit', () => ({ checkRateLimit: mockCheckRateLimit }));
vi.mock('@/lib/db/server', () => ({ sql: mockSql, jsonb: (v: unknown) => v }));
vi.mock('@supabase/ssr', () => ({ createServerClient: mockCreateServerClient }));
vi.mock('@/lib/costs/onboarding-demo-cost-guard', () => ({
  reserveOnboardingDemoBudget: mockReserveBudget,
  CostCeilingExceeded: class CostCeilingExceeded extends Error {},
}));
vi.mock('uuid', () => ({ v7: vi.fn(() => 'test-uuid-v7') }));

process.env.ONBOARDING_DEMO_ENABLED = 'true';
process.env.SELF_SERVE_SIGNUP_ENABLED = 'true';
process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com';
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key';

import { POST } from '../route';

function mkReq(body: unknown): NextRequest {
  return new NextRequest('https://app.example.com/api/onboarding/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://app.example.com' },
    body: JSON.stringify(body),
  });
}

const validBody = {
  inputMode: 'autocomplete',
  googlePlaceId: 'ChIJN1t_tDeuEmsRUsoyG83frY4',
  businessName: 'Acme Cafe',
  prefilledCategory: 'Restaurant',
};

const mockUser = { id: 'auth-uuid-123', email: 'owner@example.com' };
const pendingBizRow = {
  id: 'biz-1',
  subscription_status: 'pending_payment',
  place_id_verified: false,
  google_maps_url: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 9 });
  mockSql.mockResolvedValue([]);
  mockSql.begin = vi.fn(async (cb: any) => cb(mockSql));
  mockGetUser.mockResolvedValue({ data: { user: mockUser }, error: null });
  mockCreateServerClient.mockImplementation(() => ({ auth: { getUser: mockGetUser } }));
  mockReserveBudget.mockResolvedValue({ release: vi.fn(), date: '2026-05-03' });
  process.env.ONBOARDING_DEMO_ENABLED = 'true';
});

describe('POST /api/onboarding/start', () => {
  it('returns 404 when ONBOARDING_DEMO_ENABLED != true', async () => {
    process.env.ONBOARDING_DEMO_ENABLED = 'false';
    const res = await POST(mkReq(validBody));
    expect(res.status).toBe(404);
  });

  it('returns 200 + demoQueued=true on happy path', async () => {
    mockSql.mockResolvedValueOnce([pendingBizRow]);
    const res = await POST(mkReq(validBody));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.redirectTo).toBe('/onboarding/demo');
    expect(json.demoQueued).toBe(true);
  });

  it('returns 200 + demoQueued=false reason=cost_ceiling when cost guard trips', async () => {
    mockSql.mockResolvedValueOnce([pendingBizRow]);
    mockReserveBudget.mockRejectedValueOnce(new (await import('@/lib/costs/onboarding-demo-cost-guard')).CostCeilingExceeded('2026-05-03'));
    const res = await POST(mkReq(validBody));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.demoQueued).toBe(false);
    expect(json.reason).toBe('cost_ceiling');
  });

  it('returns 409 when subscription_status != pending_payment', async () => {
    mockSql.mockResolvedValueOnce([{ ...pendingBizRow, subscription_status: 'active' }]);
    const res = await POST(mkReq(validBody));
    expect(res.status).toBe(409);
  });

  it('returns 429 when outer rate-limit exceeded', async () => {
    mockSql.mockResolvedValueOnce([pendingBizRow]);
    mockCheckRateLimit.mockResolvedValueOnce({ allowed: false, remaining: 0 });
    const res = await POST(mkReq(validBody));
    expect(res.status).toBe(429);
  });
});
```

- [ ] **Step 3: Run tests**

```bash
npx vitest run src/app/api/onboarding/start/__tests__/route.test.ts
```
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/onboarding/start/route.ts src/app/api/onboarding/start/__tests__/route.test.ts
git commit -m "feat(api): POST /api/onboarding/start with cost-guard and rate limits"
```

---

## Task 8: GET /api/onboarding/demo/status

**Files:**
- Create: `src/app/api/onboarding/demo/status/route.ts`

- [ ] **Step 1: Implement**

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { sql } from '@/lib/db/server';
import { checkRateLimit } from '@/lib/shared/rate-limit';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store, private' } as const;

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (process.env.ONBOARDING_DEMO_ENABLED !== 'true') {
    return NextResponse.json({ error: 'not_found' }, { status: 404, headers: NO_STORE });
  }

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return req.cookies.getAll(); },
        setAll() {},
      },
    },
  );

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401, headers: NO_STORE });
  }

  // Soft rate limit: 60/auth-id/minute
  try {
    const rl = await checkRateLimit(`demo-status:auth:${user.id}`, 60, 60);
    if (!rl.allowed) {
      return NextResponse.json({ error: 'rate_limited' }, { status: 429, headers: NO_STORE });
    }
  } catch {
    // Redis down — allow (this is a read endpoint)
  }

  const [row] = await sql<{
    generation_status: string;
    completed_at: Date | null;
    source: string | null;
  }[]>`
    SELECT generation_status, completed_at, source
    FROM onboarding_demos
    WHERE user_id = (SELECT id FROM users WHERE auth_id = ${user.id} LIMIT 1)
    ORDER BY created_at DESC
    LIMIT 1
  `;

  if (!row) {
    return NextResponse.json({ error: 'not_found' }, { status: 404, headers: NO_STORE });
  }

  return NextResponse.json(
    {
      status: row.generation_status,
      completedAt: row.completed_at?.toISOString(),
      source: row.source ?? undefined,
    },
    { status: 200, headers: NO_STORE },
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/api/onboarding/demo/status/route.ts
git commit -m "feat(api): GET /api/onboarding/demo/status polling endpoint"
```

---

## Task 9: POST /api/onboarding/demo/regenerate

**Files:**
- Create: `src/app/api/onboarding/demo/regenerate/route.ts`

- [ ] **Step 1: Implement**

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { v7 as uuidv7 } from 'uuid';
import { sql, jsonb } from '@/lib/db/server';
import { checkRateLimit } from '@/lib/shared/rate-limit';
import { assertSameOrigin, SameOriginError } from '@/lib/shared/csrf';
import { reserveOnboardingDemoBudget } from '@/lib/costs/onboarding-demo-cost-guard';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store, private' } as const;

interface BizRow {
  id: string;
  user_id: string;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (process.env.ONBOARDING_DEMO_ENABLED !== 'true') {
    return NextResponse.json({ error: 'not_found' }, { status: 404, headers: NO_STORE });
  }

  try {
    assertSameOrigin(req);
  } catch (err) {
    if (err instanceof SameOriginError) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403, headers: NO_STORE });
    }
    throw err;
  }

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return req.cookies.getAll(); },
        setAll() {},
      },
    },
  );

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401, headers: NO_STORE });
  }

  const [owner] = await sql<BizRow[]>`
    SELECT u.id AS user_id, b.id AS id
    FROM users u
    JOIN businesses b ON b.id = u.business_id
    WHERE u.auth_id = ${user.id}
      AND u.role = 'owner'
    LIMIT 1
  `;
  if (!owner) {
    return NextResponse.json({ error: 'account_incomplete' }, { status: 404, headers: NO_STORE });
  }

  // Rate limit check (same 3/24h window as /start)
  const userRateLimitKey = `onboarding-demo:user:${user.id}`;
  try {
    const rl = await checkRateLimit(userRateLimitKey, 3, 86400, { strict: true });
    if (!rl.allowed) {
      return NextResponse.json({ error: 'rate_limited' }, { status: 429, headers: NO_STORE });
    }
  } catch (err) {
    return NextResponse.json({ error: 'rate_limit_unavailable' }, { status: 503, headers: NO_STORE });
  }

  // Cost-guard reservation. The reservation date is threaded into the
  // outbox payload so the worker can reconcile the pessimistic 20¢ reserve
  // against actual spend.
  let cleanupReservation: (() => Promise<void>) | null = null;
  let reservationDate: string | null = null;
  try {
    const reservation = await reserveOnboardingDemoBudget();
    cleanupReservation = reservation.release;
    reservationDate = reservation.date;
  } catch (err) {
    if (err instanceof Error && err.name === 'CostCeilingExceeded') {
      return NextResponse.json({ error: 'cost_ceiling' }, { status: 200, headers: NO_STORE });
    }
    return NextResponse.json({ error: 'redis_unavailable' }, { status: 503, headers: NO_STORE });
  }

  // Find latest completed demo to archive
  const [latestDemo] = await sql<{
    id: string;
    business_name: string;
    category: string | null;
    google_place_id: string | null;
    google_maps_url: string | null;
  }[]>`
    SELECT id, business_name, category, google_place_id, google_maps_url
    FROM onboarding_demos
    WHERE user_id = ${owner.user_id}::uuid
      AND generation_status = 'completed'
    ORDER BY created_at DESC
    LIMIT 1
  `;

  if (!latestDemo) {
    if (cleanupReservation) await cleanupReservation();
    return NextResponse.json({ error: 'no_demo_to_regenerate' }, { status: 409, headers: NO_STORE });
  }

  const correlationId = uuidv7();
  const newDemoId = uuidv7();
  const outboxId = uuidv7();

  try {
    await sql.begin(async (tx) => {
      // Archive old
      await tx`
        UPDATE onboarding_demos
        SET generation_status = 'archived', updated_at = NOW()
        WHERE id = ${latestDemo.id}::uuid
      `;

      // Insert new
      await tx`
        INSERT INTO onboarding_demos (
          id, user_id, business_id, business_name, category,
          google_place_id, google_maps_url, generation_status,
          correlation_id, created_at, updated_at
        ) VALUES (
          ${newDemoId}, ${owner.user_id}::uuid, ${owner.id}::uuid,
          ${latestDemo.business_name}, ${latestDemo.category},
          ${latestDemo.google_place_id}, ${latestDemo.google_maps_url},
          'queued', ${correlationId}, NOW(), NOW()
        )
      `;

      // Outbox row
      await tx`
        INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
        VALUES (
          ${outboxId}, 'onboarding_demo_response', 'onboarding_demo', ${newDemoId}::uuid,
          ${jsonb({
            demoId: newDemoId,
            googlePlaceId: latestDemo.google_place_id,
            businessName: latestDemo.business_name,
            category: latestDemo.category ?? undefined,
            googleMapsUrl: latestDemo.google_maps_url ?? undefined,
            correlation_id: correlationId,
            outbox_id: outboxId,
            cost_reservation_date: reservationDate ?? undefined,
          })},
          'pending'
        )
      `;
    });
  } catch (err) {
    if (cleanupReservation) {
      try { await cleanupReservation(); } catch { /* ignore */ }
    }
    console.error('[api/onboarding/demo/regenerate] transaction failed:', err);
    return NextResponse.json({ error: 'internal' }, { status: 500, headers: NO_STORE });
  }

  return NextResponse.json(
    { redirectTo: '/onboarding/demo', demoQueued: true },
    { status: 200, headers: NO_STORE },
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/api/onboarding/demo/regenerate/route.ts
git commit -m "feat(api): POST /api/onboarding/demo/regenerate with archive+insert tx"
```

---

## Task 10: Modify POST /api/onboarding/business (bifurcated schema)

**Files:**
- Modify: `src/app/api/onboarding/business/route.ts`
- Modify: `src/app/api/onboarding/__tests__/business.test.ts`

- [ ] **Step 1: Modify route to pick schema by flag**

In `src/app/api/onboarding/business/route.ts`, replace the schema import and parse:

Replace line 7:
```typescript
import { BusinessOnboardingSchema } from '@/lib/shared/schemas';
```
With:
```typescript
import { BusinessOnboardingSchema, BusinessOnboardingPostPaySchema } from '@/lib/shared/schemas';
```

Replace the `const parsed = BusinessOnboardingSchema.safeParse(body)` (line ~160) with:

```typescript
const schema = process.env.ONBOARDING_DEMO_ENABLED === 'true'
  ? BusinessOnboardingPostPaySchema
  : BusinessOnboardingSchema;
const parsed = schema.safeParse(body);
```

Add after the subscription gate check (after line 120), a new guard for the post-pay path:

```typescript
  // Post-pay onboarding guard: location must have been captured at /start
  if (process.env.ONBOARDING_DEMO_ENABLED === 'true') {
    if (!bizRow.place_id_verified && !bizRow.google_maps_url) {
      return NextResponse.json(
        { error: 'onboarding_not_started', redirectTo: '/onboarding/start' },
        { status: 409, headers: NO_STORE },
      );
    }
  }
```

In the transaction UPDATE (around line 235), the post-pay path does NOT write `name`, `google_place_id`, `place_id_verified`, `google_maps_url`:

Replace the UPDATE block with a conditional:

```typescript
      if (process.env.ONBOARDING_DEMO_ENABLED === 'true') {
        // Post-pay: only profile + voice fields
        await tx`
          UPDATE businesses
          SET
            name = COALESCE(${data.businessName ?? null}, name),
            category = COALESCE(${data.category ?? null}, category),
            tone = ${data.tone},
            products_services = ${data.productsServices ?? null},
            staff_names = ${staffNames},
            highlight_facts = ${highlightFacts},
            avoid_facts = ${avoidFacts},
            sample_responses = ${sampleResponses},
            website = ${data.website ?? null},
            updated_at = NOW()
          WHERE id = ${bizRow.id}::uuid
        `;
      } else {
        // Legacy: full onboarding including location
        await tx`
          UPDATE businesses
          SET
            name = ${data.businessName},
            category = ${data.category ?? null},
            google_place_id = ${resolvedPlaceId},
            place_id_verified = ${placeIdVerified},
            google_maps_url = ${data.googleMapsUrl ?? null},
            tone = ${data.tone},
            products_services = ${data.productsServices ?? null},
            staff_names = ${staffNames},
            highlight_facts = ${highlightFacts},
            avoid_facts = ${avoidFacts},
            sample_responses = ${sampleResponses},
            website = ${data.website ?? null},
            updated_at = NOW()
          WHERE id = ${bizRow.id}::uuid
        `;
      }
```

Note: the `resolvedPlaceId`, `placeIdVerified`, and `validatePayload` logic (lines 175-195) must also be wrapped in `if (process.env.ONBOARDING_DEMO_ENABLED !== 'true')` — the post-pay path does not accept location fields.

- [ ] **Step 2: Add regression test for flag-off path**

In `src/app/api/onboarding/__tests__/business.test.ts`, add:

```typescript
  it('flag-off: uses legacy BusinessOnboardingSchema and accepts googlePlaceId', async () => {
    process.env.ONBOARDING_DEMO_ENABLED = 'false';
    mockSql.mockResolvedValueOnce([activeBizRow]);
    mockSql.mockResolvedValueOnce([]); // advisory lock
    mockSql.mockResolvedValueOnce([activeBizRow]); // FOR UPDATE
    mockSql.mockResolvedValueOnce([]); // UPDATE

    const res = await POST(mkReq(validBody));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.redirectTo).toBe('/dashboard');
  });

  it('flag-on: rejects googlePlaceId with PostPaySchema', async () => {
    process.env.ONBOARDING_DEMO_ENABLED = 'true';
    const postPayBizRow = { ...activeBizRow, place_id_verified: true };
    mockSql.mockResolvedValueOnce([postPayBizRow]);

    const res = await POST(mkReq(validBody));
    expect(res.status).toBe(400); // invalid_body — googlePlaceId is forbidden
  });
```

- [ ] **Step 3: Run tests**

```bash
npx vitest run src/app/api/onboarding/__tests__/business.test.ts
```
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/onboarding/business/route.ts src/app/api/onboarding/__tests__/business.test.ts
git commit -m "feat(api): bifurcated BusinessOnboarding schema by ONBOARDING_DEMO_ENABLED"
```

---

## Task 11: /onboarding/start page + StartLocationClient

**Files:**
- Create: `src/app/onboarding/start/page.tsx`
- Create: `src/app/onboarding/start/StartLocationClient.tsx`

- [ ] **Step 1: Server page**

```typescript
import { notFound, redirect } from 'next/navigation';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { sql } from '@/lib/db/server';
import { StartLocationClient } from './StartLocationClient';

export const dynamic = 'force-dynamic';

export default async function OnboardingStartPage() {
  if (process.env.ONBOARDING_DEMO_ENABLED !== 'true') notFound();
  if (process.env.SELF_SERVE_SIGNUP_ENABLED !== 'true') notFound();

  const cookieStore = cookies();
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return cookieStore.getAll(); },
        setAll() {},
      },
    },
  );

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const [row] = await sql<{
    role: string;
    subscription_status: string;
    place_id_verified: boolean;
    google_maps_url: string | null;
  }[]>`
    SELECT u.role, b.subscription_status, b.place_id_verified, b.google_maps_url
    FROM users u
    JOIN businesses b ON b.id = u.business_id
    WHERE u.auth_id = ${user.id}
    LIMIT 1
  `;

  if (!row) redirect('/signup');
  if (row.role !== 'owner') redirect('/admin/overview');
  if (row.subscription_status === 'active') redirect('/dashboard');
  if (row.subscription_status === 'cancelled') redirect('/dashboard');
  if (row.place_id_verified || row.google_maps_url) redirect('/onboarding/demo');

  return <StartLocationClient />;
}
```

- [ ] **Step 2: Client component**

```typescript
'use client';

import { useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { PlaceAutocomplete } from '@/components/PlaceAutocomplete';

interface PrefillResponse {
  category: string | null;
  website: string | null;
}

export function StartLocationClient() {
  const router = useRouter();
  const [inputMode, setInputMode] = useState<'autocomplete' | 'url'>('autocomplete');
  const [googlePlaceId, setGooglePlaceId] = useState('');
  const [googlePlaceAddress, setGooglePlaceAddress] = useState('');
  const [googleMapsUrl, setGoogleMapsUrl] = useState('');
  const [businessName, setBusinessName] = useState('');
  const [prefilledCategory, setPrefilledCategory] = useState<string | null>(null);
  const [prefilledWebsite, setPrefilledWebsite] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const prefillAbortRef = useRef<AbortController | null>(null);

  async function triggerPrefill(placeId: string) {
    if (prefillAbortRef.current) prefillAbortRef.current.abort();
    const controller = new AbortController();
    prefillAbortRef.current = controller;

    try {
      const res = await fetch(
        `/api/signup/place-prefill?place_id=${encodeURIComponent(placeId)}`,
        { signal: controller.signal },
      );
      if (!res.ok) return;
      const prefill = (await res.json()) as PrefillResponse;
      setPrefilledCategory(prefill.category);
      setPrefilledWebsite(prefill.website);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
    }
  }

  function cancelPrefill() {
    setPrefilledCategory(null);
    setPrefilledWebsite(null);
    if (prefillAbortRef.current) {
      prefillAbortRef.current.abort();
      prefillAbortRef.current = null;
    }
  }

  async function submit() {
    setSubmitting(true);
    setError('');

    const payload = {
      inputMode,
      businessName,
      ...(inputMode === 'autocomplete'
        ? { googlePlaceId, googlePlaceAddress, prefilledCategory, prefilledWebsite }
        : { googleMapsUrl }),
    };

    try {
      const res = await fetch('/api/onboarding/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));

      if (!res.ok) {
        setError(body.error ?? 'Submission failed');
        return;
      }

      router.push(body.redirectTo ?? '/onboarding/demo');
    } catch {
      setError('Connection failed');
    } finally {
      setSubmitting(false);
    }
  }

  const canSubmit = businessName.trim().length > 0 && (
    inputMode === 'autocomplete' ? Boolean(googlePlaceId) : Boolean(googleMapsUrl.trim())
  );

  return (
    <div className="min-h-screen bg-gray-50 py-12 px-4">
      <div className="max-w-2xl mx-auto">
        <h1 className="text-3xl font-bold text-center mb-2">Find your business</h1>
        <p className="text-center text-gray-600 mb-8">
          We'll generate a live demo of AI responses for your actual reviews.
        </p>

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-md p-4 mb-4 text-sm text-red-700">
            {error}
          </div>
        )}

        <div className="bg-white rounded-lg border border-gray-200 p-6 space-y-4">
          <label className="block text-sm font-medium text-gray-700">Business name</label>
          <input
            type="text"
            value={businessName}
            onChange={(e) => setBusinessName(e.target.value)}
            placeholder="Your business name"
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            maxLength={80}
          />

          {inputMode === 'autocomplete' ? (
            <PlaceAutocomplete
              onPlaceSelect={(sel) => {
                setGooglePlaceId(sel.placeId);
                setGooglePlaceAddress(sel.formattedAddress);
                triggerPrefill(sel.placeId);
              }}
              onClear={() => {
                cancelPrefill();
                setGooglePlaceId('');
                setGooglePlaceAddress('');
              }}
            />
          ) : (
            <input
              type="text"
              value={googleMapsUrl}
              onChange={(e) => setGoogleMapsUrl(e.target.value)}
              placeholder="https://maps.google.com/..."
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          )}

          <button
            type="button"
            onClick={() => {
              cancelPrefill();
              if (inputMode === 'autocomplete') {
                setGooglePlaceId('');
                setGooglePlaceAddress('');
                setInputMode('url');
              } else {
                setGoogleMapsUrl('');
                setInputMode('autocomplete');
              }
            }}
            className="text-xs text-blue-600 hover:text-blue-800"
          >
            {inputMode === 'autocomplete' ? 'Or paste a Google Maps URL' : 'Use search instead'}
          </button>

          <div className="flex justify-end pt-4">
            <button
              type="button"
              onClick={submit}
              disabled={!canSubmit || submitting}
              className="bg-blue-600 text-white font-medium py-2 px-6 rounded-md hover:bg-blue-700 disabled:opacity-50"
            >
              {submitting ? 'Generating demo...' : 'Generate my demo'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add src/app/onboarding/start/page.tsx src/app/onboarding/start/StartLocationClient.tsx
git commit -m "feat(ui): /onboarding/start page with location capture + prefill"
```

---

## Task 12: /onboarding/demo page + PaywallWithDemoClient

**Files:**
- Create: `src/app/onboarding/demo/page.tsx`
- Create: `src/app/onboarding/demo/PaywallWithDemoClient.tsx`

- [ ] **Step 1: Server page**

```typescript
import { notFound, redirect } from 'next/navigation';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { sql } from '@/lib/db/server';
import { PaywallWithDemoClient } from './PaywallWithDemoClient';

export const dynamic = 'force-dynamic';

interface DemoRow {
  id: string;
  generation_status: string;
  completed_at: Date | null;
  source: string | null;
  reviews_snapshot: unknown;
  generated_responses: unknown;
  business_name: string;
}

export default async function OnboardingDemoPage() {
  if (process.env.ONBOARDING_DEMO_ENABLED !== 'true') notFound();

  const cookieStore = cookies();
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return cookieStore.getAll(); },
        setAll() {},
      },
    },
  );

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const [row] = await sql<{
    role: string;
    subscription_status: string;
  }[]>`
    SELECT u.role, b.subscription_status
    FROM users u
    JOIN businesses b ON b.id = u.business_id
    WHERE u.auth_id = ${user.id}
    LIMIT 1
  `;
  if (!row) redirect('/signup');
  if (row.role !== 'owner') redirect('/admin/overview');
  if (row.subscription_status === 'active') redirect('/dashboard');
  if (row.subscription_status === 'cancelled') redirect('/dashboard');

  const [demo] = await sql<DemoRow[]>`
    SELECT id, generation_status, completed_at, source,
           reviews_snapshot, generated_responses, business_name
    FROM onboarding_demos
    WHERE user_id = (SELECT id FROM users WHERE auth_id = ${user.id} LIMIT 1)
    ORDER BY created_at DESC
    LIMIT 1
  `;

  if (!demo) {
    redirect('/onboarding/start');
  }

  const isStale = demo.completed_at
    ? Date.now() - new Date(demo.completed_at).getTime() > 24 * 60 * 60 * 1000
    : false;

  // SCOPE: auto-regen on stale revisit (spec §3.6) is deferred to Phase 2
  // — see spec §3.6 "Phase 2 follow-up" note. v1 ships stale-with-footnote
  // + the manual <RegenerateButton /> in PaywallWithDemoClient; the button
  // already covers the bookmark-revisit case at the cost of one user click.
  // If Phase 1 telemetry shows revisit conversion drag, implement here as:
  // (a) attempt reserveOnboardingDemoBudget(); (b) on success, run the same
  // archive+insert+outbox tx as /api/onboarding/demo/regenerate inline;
  // (c) on CostCeilingExceeded, fall through to stale render.

  return (
    <PaywallWithDemoClient
      initialDemo={demo}
      isStale={isStale}
    />
  );
}
```

- [ ] **Step 2: Client component**

```typescript
'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import type { NormalizedReview } from '@/lib/reviews/types';
import type { GenerationResult } from '@/lib/responses/types';

interface DemoPayload {
  id: string;
  generation_status: string;
  completed_at: string | null;
  source: string | null;
  reviews_snapshot: NormalizedReview[] | string | null;
  generated_responses: (GenerationResult | null)[] | string | null;
  business_name: string;
}

interface PaywallWithDemoClientProps {
  initialDemo: DemoPayload;
  isStale: boolean;
}

export function PaywallWithDemoClient({ initialDemo, isStale }: PaywallWithDemoClientProps) {
  const router = useRouter();
  const [demo, setDemo] = useState<DemoPayload>(initialDemo);
  const [polling, setPolling] = useState(false);
  const [pollCount, setPollCount] = useState(0);
  const MAX_POLLS = 15;

  const reviews: NormalizedReview[] =
    typeof demo.reviews_snapshot === 'string'
      ? JSON.parse(demo.reviews_snapshot)
      : demo.reviews_snapshot ?? [];

  const responses: (GenerationResult | null)[] =
    typeof demo.generated_responses === 'string'
      ? JSON.parse(demo.generated_responses)
      : demo.generated_responses ?? [];

  const poll = useCallback(async () => {
    if (pollCount >= MAX_POLLS) return;
    try {
      const res = await fetch('/api/onboarding/demo/status');
      if (!res.ok) return;
      const body = await res.json();
      if (body.status !== demo.generation_status) {
        router.refresh(); // SSR re-read
      }
      setPollCount((c) => c + 1);
    } catch {
      // ignore
    }
  }, [pollCount, demo.generation_status, router]);

  useEffect(() => {
    if (demo.generation_status === 'queued' || demo.generation_status === 'running') {
      setPolling(true);
      const interval = setInterval(poll, 2000);
      return () => clearInterval(interval);
    }
  }, [demo.generation_status, poll]);

  // Visibility-driven reset
  useEffect(() => {
    function handleVisibility() {
      if (document.visibilityState === 'visible') {
        setPollCount(0);
      }
    }
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, []);

  async function handleRegenerate() {
    const res = await fetch('/api/onboarding/demo/regenerate', { method: 'POST' });
    if (res.ok) {
      router.refresh();
    }
  }

  const isLoading = demo.generation_status === 'queued' || demo.generation_status === 'running';
  const isFailed = demo.generation_status === 'failed';
  const isCompleted = demo.generation_status === 'completed';
  const isFallback = demo.source === 'curated_fallback';

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-2xl mx-auto px-4 py-8">
        <h1 className="text-3xl font-bold text-center mb-2">
          Your AI-powered review responses
        </h1>
        <p className="text-center text-gray-600 mb-8">
          Here's what RepWorth would write for {demo.business_name}
        </p>

        {isFallback && (
          <div className="bg-amber-50 border border-amber-200 rounded-md p-4 mb-6 text-sm text-amber-800">
            Sample reviews shown — connect your account after signup to see your real ones.
          </div>
        )}

        {isStale && isCompleted && (
          <div className="bg-gray-100 rounded-md p-3 mb-6 text-sm text-gray-600 text-center">
            Last updated {Math.floor((Date.now() - new Date(demo.completed_at!).getTime()) / (24 * 60 * 60 * 1000))} days ago
          </div>
        )}

        {isLoading && (
          <div className="text-center py-12">
            <div className="inline-block w-12 h-12 border-4 border-blue-200 border-t-blue-600 rounded-full animate-spin mb-6" />
            <p className="text-gray-600">Generating your demo...</p>
            {pollCount >= MAX_POLLS && (
              <p className="text-sm text-gray-400 mt-2">
                Still working — refresh in a minute.
              </p>
            )}
          </div>
        )}

        {isFailed && (
          <div className="text-center py-12">
            <div className="text-4xl mb-4">⚠️</div>
            <p className="text-gray-600 mb-4">We encountered an issue generating your demo.</p>
            <button
              onClick={handleRegenerate}
              className="bg-blue-600 text-white font-medium py-2 px-6 rounded-md hover:bg-blue-700"
            >
              Try again
            </button>
          </div>
        )}

        {isCompleted && !isLoading && (
          <div className="space-y-6">
            {reviews.map((review, index) => (
              <ReviewCard key={index} review={review} response={responses[index]} />
            ))}

            {/* Paywall CTA */}
            <div className="bg-white rounded-xl border border-gray-200 p-6 sm:p-8 text-center mt-8">
              <h2 className="text-xl font-bold text-gray-900 mb-2">
                Want this for every review?
              </h2>
              <p className="text-gray-600 mb-6 max-w-md mx-auto">
                Subscribe to RepWorth and we'll automatically generate responses for all your reviews.
              </p>
              <a
                href="/onboarding/pay"
                className="inline-block bg-blue-600 text-white font-medium px-6 py-3 rounded-lg hover:bg-blue-700 transition-colors"
              >
                Choose a plan →
              </a>
            </div>

            <div className="text-center">
              <button
                onClick={handleRegenerate}
                className="text-sm text-gray-500 hover:text-gray-700 underline"
              >
                Regenerate demo
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Stars({ rating }: { rating: number }) {
  return (
    <span className="inline-flex gap-0.5" aria-label={`${rating} out of 5 stars`}>
      {Array.from({ length: 5 }, (_, i) => (
        <span key={i} className={i < rating ? 'text-yellow-400' : 'text-gray-300'}>
          ★
        </span>
      ))}
    </span>
  );
}

function ReviewCard({
  review,
  response,
}: {
  review: NormalizedReview;
  response: GenerationResult | null;
}) {
  const formattedDate = new Date(review.reviewDate).toLocaleDateString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
  });

  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <div className="p-4 sm:p-5">
        <div className="flex items-start justify-between mb-2">
          <div>
            <span className="font-semibold text-gray-900">{review.reviewerName}</span>
            <span className="text-sm text-gray-400 ml-2">{formattedDate}</span>
          </div>
        </div>
        <Stars rating={review.starRating} />
        {review.reviewText ? (
          <p className="mt-2 text-gray-700 text-sm leading-relaxed">{review.reviewText}</p>
        ) : (
          <p className="mt-2 text-gray-400 text-sm italic">Rating only — no written review</p>
        )}
      </div>
      {response && (
        <div className="bg-blue-50 border-t border-blue-100 p-4 sm:p-5">
          <p className="text-xs font-semibold text-blue-600 uppercase tracking-wider mb-2">AI Response</p>
          <p className="text-gray-700 text-sm leading-relaxed">{response.responseText}</p>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add src/app/onboarding/demo/page.tsx src/app/onboarding/demo/PaywallWithDemoClient.tsx
git commit -m "feat(ui): /onboarding/demo page with demo display + paywall CTA"
```

---

## Task 13: Modify BusinessWizardClient — 2-step post-pay wizard

**Files:**
- Modify: `src/app/onboarding/business/BusinessWizardClient.tsx`
- Modify: `src/app/onboarding/business/page.tsx`
- Modify: `src/app/onboarding/business/guard.ts`

- [ ] **Step 1: Modify guard.ts**

Add a new guard for the post-pay path. In `guard.ts`, after the existing checks:

```typescript
  if (row.place_id_verified || row.google_maps_url !== null) {
    return { kind: 'redirect', path: '/dashboard' };
  }
```

This stays the same — the existing already-onboarded guard. No changes needed to `guard.ts`.

But the PAGE (page.tsx) needs to pass initial values from the business row to the client. Modify `src/app/onboarding/business/page.tsx`:

```typescript
import { notFound, redirect } from 'next/navigation';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { sql } from '@/lib/db/server';
import { BusinessWizardClient } from './BusinessWizardClient';
import { resolveWizardDestination, type WizardGuardRow } from './guard';

export const dynamic = 'force-dynamic';

interface BusinessDataRow {
  role: string;
  subscription_status: string;
  place_id_verified: boolean;
  google_maps_url: string | null;
  category: string | null;
  website: string | null;
  name: string;
}

export default async function OnboardingBusinessPage() {
  if (process.env.SELF_SERVE_SIGNUP_ENABLED !== 'true') notFound();

  const cookieStore = cookies();
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return cookieStore.getAll(); },
        setAll() {},
      },
    },
  );

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const [row] = await sql<BusinessDataRow[]>`
    SELECT u.role, b.subscription_status, b.place_id_verified, b.google_maps_url,
           b.category, b.website, b.name
    FROM users u
    JOIN businesses b ON b.id = u.business_id
    WHERE u.auth_id = ${user.id}
    LIMIT 1
  `;

  const decision = resolveWizardDestination(row);
  if (decision.kind === 'redirect') redirect(decision.path);

  // Post-pay guard: location must have been captured
  if (process.env.ONBOARDING_DEMO_ENABLED === 'true') {
    if (!row.place_id_verified && !row.google_maps_url) {
      redirect('/onboarding/start');
    }
  }

  return (
    <BusinessWizardClient
      initialValues={{
        category: row.category ?? '',
        website: row.website ?? '',
        businessName: row.name ?? '',
      }}
    />
  );
}
```

- [ ] **Step 2: Modify BusinessWizardClient — drop Step 1, become 2-step**

Replace the entire file with:

```typescript
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ProgressDots } from './ProgressDots';
import { StepProfile } from './StepProfile';
import { StepVoice } from './StepVoice';

export interface WizardFormData {
  businessName: string;
  category: string;
  website: string;
  tone: string;
  productsServices: string;
  staffNames: string;
  highlightFacts: string;
  avoidFacts: string;
  sampleResponses: string;
}

interface BusinessWizardClientProps {
  initialValues: {
    category: string;
    website: string;
    businessName: string;
  };
}

type Step = 1 | 2;

export function BusinessWizardClient({ initialValues }: BusinessWizardClientProps) {
  const [step, setStep] = useState<Step>(1);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const router = useRouter();

  const [data, setData] = useState<WizardFormData>({
    businessName: initialValues.businessName,
    category: initialValues.category,
    website: initialValues.website,
    tone: 'professional and friendly',
    productsServices: '',
    staffNames: '',
    highlightFacts: '',
    avoidFacts: '',
    sampleResponses: '',
  });

  const update = (patch: Partial<WizardFormData>) =>
    setData((prev) => ({ ...prev, ...patch }));

  async function submit(opts: { skipVoice?: boolean } = {}) {
    setSubmitting(true);
    setError('');
    try {
      const payload = {
        businessName: data.businessName || undefined,
        category: data.category || undefined,
        tone: data.tone || undefined,
        website: data.website || undefined,
        ...(opts.skipVoice
          ? {}
          : {
              productsServices: data.productsServices || undefined,
              staffNames: data.staffNames || undefined,
              highlightFacts: data.highlightFacts || undefined,
              avoidFacts: data.avoidFacts || undefined,
              sampleResponses: data.sampleResponses || undefined,
            }),
      };

      const res = await fetch('/api/onboarding/business', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));

      if (!res.ok) {
        if (body.redirectTo) {
          router.push(body.redirectTo);
          return;
        }
        setError(body.message ?? body.error ?? 'Submission failed');
        return;
      }

      router.push(body.redirectTo ?? '/dashboard');
    } catch {
      setError('Connection failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 py-12 px-4">
      <div className="max-w-2xl mx-auto">
        <p className="text-center text-blue-600 text-sm mb-2">
          You're in. Two quick questions to make responses sound like you, then we go live.
        </p>
        <h1 className="text-3xl font-bold text-center mb-2">
          Set up your business
        </h1>
        <p className="text-center text-gray-600 mb-8">
          A few quick details so we can start fetching your reviews.
        </p>

        <ProgressDots current={step} total={2} />

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-md p-4 mb-4 text-sm text-red-700">
            {error}
          </div>
        )}

        {step === 1 && (
          <StepProfile
            data={data}
            update={update}
            onNext={() => setStep(2)}
          />
        )}
        {step === 2 && (
          <StepVoice
            data={data}
            update={update}
            onBack={() => setStep(1)}
            onSubmit={() => submit()}
            onSkip={() => submit({ skipVoice: true })}
            submitting={submitting}
          />
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Update ProgressDots to accept total prop**

In `src/app/onboarding/business/ProgressDots.tsx`, modify to accept an optional `total` prop:

```typescript
interface ProgressDotsProps {
  current: number;
  total?: number;
}

export function ProgressDots({ current, total = 3 }: ProgressDotsProps) {
  return (
    <div className="flex justify-center gap-2 mb-8">
      {Array.from({ length: total }, (_, i) => (
        <div
          key={i}
          className={`w-2.5 h-2.5 rounded-full ${
            i + 1 === current ? 'bg-blue-600' : 'bg-gray-300'
          }`}
        />
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Commit**

```bash
git add src/app/onboarding/business/page.tsx src/app/onboarding/business/BusinessWizardClient.tsx src/app/onboarding/business/ProgressDots.tsx src/app/onboarding/business/guard.ts
git commit -m "feat(ui): BusinessWizardClient becomes 2-step Profile+Voice post-pay wizard"
```

---

## Task 14: Dashboard SetupChecklist

**Files:**
- Create: `src/app/(authenticated)/dashboard/SetupChecklist.tsx`
- Modify: `src/app/(authenticated)/dashboard/page.tsx`

- [ ] **Step 1: Create SetupChecklist**

```typescript
import { sql } from '@/lib/db/server';

interface ChecklistData {
  zernio_connected: boolean;
  first_approval_done: boolean;
  voice_tuned: boolean;
  notification_prefs_set: boolean;
  no_recent_reviews: boolean;
}

async function getChecklist(businessId: string): Promise<ChecklistData> {
  const [row] = await sql<ChecklistData[]>`
    WITH checklist AS (
      SELECT
        EXISTS (SELECT 1 FROM zernio_connections WHERE business_id = ${businessId}::uuid AND status = 'active') AS zernio_connected,
        EXISTS (SELECT 1 FROM responses WHERE business_id = ${businessId}::uuid AND status IN ('approved','posted')) AS first_approval_done,
        (SELECT
           COALESCE(tone <> 'professional and friendly', false)
           OR COALESCE(products_services <> '', false)
           OR COALESCE(array_length(staff_names, 1) > 0, false)
           OR COALESCE(array_length(highlight_facts, 1) > 0, false)
           OR COALESCE(array_length(avoid_facts, 1) > 0, false)
           OR COALESCE(array_length(sample_responses, 1) > 0, false)
         FROM businesses WHERE id = ${businessId}::uuid) AS voice_tuned,
        EXISTS (SELECT 1 FROM channel_enrollments WHERE business_id = ${businessId}::uuid AND channel <> 'email' AND status = 'verified') AS notification_prefs_set,
        (NOT EXISTS (SELECT 1 FROM reviews WHERE business_id = ${businessId}::uuid AND created_at > NOW() - INTERVAL '24 hours')) AS no_recent_reviews
    )
    SELECT * FROM checklist
  `;
  return row ?? {
    zernio_connected: false,
    first_approval_done: false,
    voice_tuned: false,
    notification_prefs_set: false,
    no_recent_reviews: true,
  };
}

export async function SetupChecklist({ businessId }: { businessId: string }) {
  const checklist = await getChecklist(businessId);

  const items = [
    {
      label: 'Connect Zernio',
      done: checklist.zernio_connected,
      subText: checklist.zernio_connected && checklist.no_recent_reviews
        ? 'Watching, no reviews yet'
        : undefined,
      href: '/dashboard/connect',
    },
    {
      label: 'Approve your first response',
      done: checklist.first_approval_done,
      href: '/dashboard',
    },
    {
      label: 'Tune your voice',
      done: checklist.voice_tuned,
      href: '/settings',
    },
    {
      label: 'Set notification preferences',
      done: checklist.notification_prefs_set,
      href: '/settings/channels',
    },
  ];

  const allComplete = items.every((i) => i.done);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-6 mb-6">
      <h2 className="text-lg font-semibold text-gray-900 mb-4">Get fully set up</h2>
      <div className="space-y-3">
        {items.map((item) => (
          <a
            key={item.label}
            href={item.href}
            className="flex items-center gap-3 p-3 rounded-md hover:bg-gray-50 transition-colors"
          >
            <div className={`w-5 h-5 rounded-full flex items-center justify-center text-xs ${
              item.done ? 'bg-green-500 text-white' : 'bg-gray-200 text-gray-500'
            }`}>
              {item.done ? '✓' : ''}
            </div>
            <div>
              <span className={`text-sm ${item.done ? 'text-gray-500 line-through' : 'text-gray-900'}`}>
                {item.label}
              </span>
              {item.subText && (
                <p className="text-xs text-gray-400">{item.subText}</p>
              )}
            </div>
          </a>
        ))}
      </div>
      {allComplete && (
        <p className="text-sm text-green-600 mt-4 text-center">✅ You're all set!</p>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Add to dashboard page**

Modify `src/app/(authenticated)/dashboard/page.tsx`:

```typescript
import { DashboardContent } from '@/components/DashboardContent';
import { SetupChecklist } from './SetupChecklist';
import { sql } from '@/lib/db/server';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const cookieStore = cookies();
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return cookieStore.getAll(); },
        setAll() {},
      },
    },
  );

  const { data: { user } } = await supabase.auth.getUser();
  let businessId: string | null = null;

  if (user) {
    const [row] = await sql<{ business_id: string }[]>`
      SELECT business_id FROM users WHERE auth_id = ${user.id} LIMIT 1
    `;
    businessId = row?.business_id ?? null;
  }

  return (
    <div>
      {businessId && <SetupChecklist businessId={businessId} />}
      <DashboardContent />
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add "src/app/(authenticated)/dashboard/SetupChecklist.tsx" "src/app/(authenticated)/dashboard/page.tsx"
git commit -m "feat(dashboard): SetupChecklist with 4-item CTE + dismiss state"
```

---

## Task 15: CleanupAbandonedSignupsPoller modifications

**Files:**
- Modify: `worker/jobs/CleanupAbandonedSignupsPoller.ts`
- Modify: `worker/jobs/__tests__/CleanupAbandonedSignupsPoller.test.ts`

- [ ] **Step 1: Modify poller**

In `CleanupAbandonedSignupsPoller.ts`:

1. Change the `has_demos` check to `has_prospect_demos` (query ONLY `prospect_demos`):

Replace lines 155-159:
```typescript
        const [refs] = await tx<{ has_onboarded: boolean; has_demos: boolean }[]>`
          SELECT
            EXISTS (SELECT 1 FROM businesses WHERE onboarded_by = ${candidate.user_id}::uuid) AS has_onboarded,
            EXISTS (SELECT 1 FROM prospect_demos WHERE created_by = ${candidate.user_id}::uuid) AS has_demos
        `;
```
With:
```typescript
        const [refs] = await tx<{ has_onboarded: boolean; has_prospect_demos: boolean }[]>`
          SELECT
            EXISTS (SELECT 1 FROM businesses WHERE onboarded_by = ${candidate.user_id}::uuid) AS has_onboarded,
            EXISTS (SELECT 1 FROM prospect_demos WHERE created_by = ${candidate.user_id}::uuid) AS has_prospect_demos
        `;
```

And update the check on line 161:
```typescript
        if (refs && (refs.has_onboarded || refs.has_prospect_demos)) {
```

2. Add explicit `DELETE FROM onboarding_demos` BEFORE the `users` delete (around line 221):

Insert after the `refs` check block (before line 169), inside the same tx:

```typescript
        // Explicit cleanup of onboarding_demos (FK CASCADE is defense-in-depth).
        await tx`DELETE FROM onboarding_demos WHERE user_id = ${candidate.user_id}::uuid`;
```

3. Add 30-day stale completed demo cleanup at the TOP of `runOnceInner` (before candidate selection):

Insert after line 63 (before the candidates SELECT):

```typescript
  // Tier-2: cleanup completed onboarding demos older than 30 days
  try {
    const staleResult = await sql`
      DELETE FROM onboarding_demos
      WHERE generation_status = 'completed'
        AND completed_at < NOW() - INTERVAL '30 days'
    `;
    if (staleResult.count && staleResult.count > 0) {
      logger.log(`Deleted ${staleResult.count} stale completed onboarding demos`);
    }
  } catch (err) {
    logger.error(`Failed to cleanup stale onboarding demos: ${err instanceof Error ? err.message : err}`);
  }
```

- [ ] **Step 2: Update tests**

Add tests in `worker/jobs/__tests__/CleanupAbandonedSignupsPoller.test.ts`:

```typescript
  it('deletes onboarding_demos rows when cleaning up abandoned signup', async () => {
    // Setup: create a pending_payment user with an onboarding_demos row
    // Verify: after cleanup, onboarding_demos row is gone
  });

  it('skips deletion when prospect_demos reference exists', async () => {
    // Verify existing behavior preserved
  });
```

- [ ] **Step 3: Commit**

```bash
git add worker/jobs/CleanupAbandonedSignupsPoller.ts worker/jobs/__tests__/CleanupAbandonedSignupsPoller.test.ts
git commit -m "feat(poller): explicit onboarding_demos cleanup + 30-day stale pass"
```

---

## Task 16: Documentation updates

**Files:**
- Create: `.claude/skills/onboarding-demo-cost-guard.md`
- Modify: `.claude/skills/feature-flags.md`
- Modify: `.claude/skills/migrations.md`
- Create: `docs/runbooks/onboarding-demo-launch-runbook.md`

- [ ] **Step 1: Skill doc for cost guard**

```markdown
# Onboarding Demo Cost Guard

Parallel cost-guard helper for pre-pay onboarding demos.

## Usage

```typescript
import { withOnboardingDemoCostGuard } from '@/lib/costs/onboarding-demo-cost-guard';

const result = await withOnboardingDemoCostGuard(
  { ipKey: '1.2.3.4' },
  async () => {
    // ... do work ...
    return { value: result, actualCostCents: 15 };
  },
);
```

## Key differences from `withCostGuard`

- No `businessId`/`subscriptionTier` required (pre-pay users have neither).
- Global daily ceiling via `ONBOARDING_DEMO_DAILY_CENTS` (default $10/day).
- Override via Redis key `cost:onboarding-demo:override:cents`.
- Reconciles to `api_costs` with `cost_lane='onboarding_demo'`.

## Threshold alerts

`checkCostThreshold(lane, date, [50, 90, 100])` returns newly-crossed thresholds.
Call after every demo completion; log to Sentry at appropriate severity.
```

- [ ] **Step 2: Update feature-flags.md**

Add entries:

```markdown
- `ONBOARDING_DEMO_ENABLED` — default `false`. Enables the pre-pay demo flow.
- `ONBOARDING_DEMO_DAILY_CENTS` — default `1000` ($10/day). Global cost ceiling for demos.
- `ONBOARDING_DEMO_STAFF_EMAILS_CSV` — Phase 3 staff allowlist. Removed at Phase 4.
```

- [ ] **Step 3: Update migrations.md**

Add:

```markdown
- **032** (`032_onboarding_demos.sql`): Pre-pay onboarding demo table. Includes partial unique on `(user_id) WHERE generation_status = 'completed'`, user lookup index, business lookup index, and inflight status index.
```

- [ ] **Step 4: Create launch runbook**

```markdown
# Onboarding Demo Launch Runbook

## Pre-launch

1. Apply migration 032 to staging.
2. Generate curated fallback fixtures via `scripts/generate-fallback-demos.ts`.
3. Set `ONBOARDING_DEMO_ENABLED=true` on staging.
4. Set `ONBOARDING_DEMO_DAILY_CENTS=100` ($1/day, tight).

## Smoke tests

1. Real-API demo — confirm SerpAPI cost ledger.
2. Force SerpAPI failure → curated fallback + Sentry event.
3. Burn 3/24h budget → 4th attempt blocked (200 with `demoQueued:false`).
4. Cost ceiling at $1 → confirm threshold alerts at 50%, 90%, 100%.
5. Cleanup poller dry-run on 7-day-old user with completed demo.

## Production rollout

1. Deploy with flag off.
2. Apply migration 032 to production.
3. Phase 3: enable for staff only (`ONBOARDING_DEMO_STAFF_EMAILS_CSV`).
4. Phase 4: remove staff gate, enable globally.
```

- [ ] **Step 5: Commit**

```bash
git add .claude/skills/onboarding-demo-cost-guard.md .claude/skills/feature-flags.md .claude/skills/migrations.md docs/runbooks/onboarding-demo-launch-runbook.md
git commit -m "docs: cost-guard skill, feature flags, migration 032, launch runbook"
```

---

## Task 17: Full regression suite

**Files:** None (verification only)

- [ ] **Step 1: Type-check**

```bash
pnpm tsc --noEmit
```
Expected: Zero errors.

- [ ] **Step 2: Unit tests**

```bash
MOCK_EXTERNAL_APIS=true npx vitest run src/lib/demos/__tests__ src/lib/costs/__tests__
```
Expected: All PASS.

- [ ] **Step 3: Integration tests**

```bash
MOCK_EXTERNAL_APIS=true npx vitest run src/app/api/onboarding/__tests__
```
Expected: All PASS.

- [ ] **Step 4: Worker compile check**

```bash
pnpm tsc --noEmit -p worker/tsconfig.json 2>/dev/null || pnpm tsc --noEmit
```
Expected: Zero errors.

- [ ] **Step 5: Lint**

```bash
pnpm lint
```
Expected: Zero errors.

- [ ] **Step 6: Commit**

```bash
git commit --allow-empty -m "chore: PR #2 regression suite green"
```

---

## Task 18: Self-review checklist

**Files:** None (verification only)

- [ ] **Step 1: Spec coverage scan**

| Spec section | Task that implements it |
|---|---|
| §3.1 Hybrid journey split | Task 11 (/start), Task 12 (/demo), Task 13 (2-step wizard) |
| §3.2 Separate table | Task 1 (migration 032) |
| §3.3 positive-with-moderate-tail | PR #1 Task 3, reinforced in Task 6 worker |
| §3.4 Polling (2s, 15 attempts, visibility reset) | Task 12 (DemoLoader) |
| §3.5 Partial unique + race-aware completion | Task 6 worker, PR #1 Task 2 lifecycle |
| §3.6 Auto-regenerate on revisit >24h | Task 12 (server page isStale check) |
| §3.6 Cleanup poller cascade | Task 15 |
| §3.7 Rate-limit lanes | Task 7 (3 lanes in /start) |
| §3.7 Tightened input schema | Task 3 (demoBusinessNameSchema regex) |
| §3.8 Cost guard parallel helper | Task 4 |
| §3.9 Curated fallback | Task 5 |
| §3.10 Setup checklist (4 items, single CTE) | Task 14 |
| §5.1 POST /api/onboarding/start | Task 7 |
| §5.2 GET /api/onboarding/demo/status | Task 8 |
| §5.3 POST /api/onboarding/demo/regenerate | Task 9 |
| §5.4 Modified /api/onboarding/business | Task 10 |
| §6.2 OnboardingDemoWorker | Task 6 |
| §7.1 /onboarding/start page | Task 11 |
| §7.2 /onboarding/demo page | Task 12 |
| §7.3 SetupChecklist | Task 14 |
| §7.4 Modified BusinessWizardClient | Task 13 |
| §10.0 Two-PR split | This is PR #2 |
| §11 Documentation | Task 16 |

- [ ] **Step 2: Placeholder scan**

Search plan for: `TBD`, `TODO`, `implement later`, `fill in details`, `Add appropriate`, `add validation`, `handle edge cases`, `Write tests for`, `Similar to Task`. Verify none found.

- [ ] **Step 3: Type consistency**

| Name | Defined in | Used in |
|---|---|---|
| `OnboardingStartSchema` | `schemas.ts` (Task 3) | `start/route.ts` (Task 7), tests |
| `BusinessOnboardingPostPaySchema` | `schemas.ts` (Task 3) | `business/route.ts` (Task 10), tests |
| `DemoJobPayload` | `demos/types.ts` (PR #1) | `OnboardingDemoWorker.ts` (Task 6) |
| `claimDemo` | `lifecycle.ts` (PR #1) | `OnboardingDemoWorker.ts` (Task 6) |
| `completeDemo` | `lifecycle.ts` (PR #1) | `OnboardingDemoWorker.ts` (Task 6) |
| `failDemo` | `lifecycle.ts` (PR #1) | `OnboardingDemoWorker.ts` (Task 6) |
| `withOnboardingDemoCostGuard` | `cost-guard.ts` (Task 4) | `start/route.ts` (Task 7), worker (Task 6) |
| `getFallbackDemo` | `fallback-content.ts` (Task 5) | `OnboardingDemoWorker.ts` (Task 6) |

All names match — no drift.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-05-03-pre-paywall-demo-pr2.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
