# Wave 3 PR 3a — Moderation Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run output moderation on every generated response; record moderation metadata on `api_costs`; and for a high-confidence unsafe draft, hold it in a new `flagged_responses` table instead of sending the normal owner approval notification — preserving the no-auto-posting invariant.

**Architecture:** A local regex output filter (`src/lib/moderation/output-filter.ts`) returns a `ModerationDecision`. An orchestrator (`src/lib/moderation/moderate.ts`) always runs the local filter and, only when `OPENAI_MODERATION_ENABLED=true`, also calls the OpenAI Moderation API and merges (fail-open: provider errors fall back to local rules, never throw). `ResponseGeneratorWorker` runs moderation after the avoid-facts guardrail and threads the decision into `persistResponseAndNotify`, which — in the existing single transaction — writes moderation fields onto the `api_costs` row (columns from PR 2's migration 050), and for a `high`-severity flag inserts a `flagged_responses` row (migration 051) and skips the `send_notification` outbox enqueue.

**Tech Stack:** TypeScript (strict), Postgres (Supabase migration + deny-all RLS), OpenAI SDK v6, BullMQ worker + transactional outbox, Vitest.

**Branch:** `wave-3-pr3a-moderation-backend` stacked on `wave-3-pr2-ai-audit-foundation` (PR #94, not yet merged). The PR targets that branch; GitHub auto-retargets to `main` when #94 merges. PR 3a depends on PR 2's migration 050 (`api_costs.moderation_score/moderation_categories/flagged/flag_reason/output_excerpt`).

---

## Scope decisions baked into this plan

1. **Only `high`-severity flags suppress + create a `flagged_responses` row.** `medium`/`low` are recorded on `api_costs` (score/categories/`flagged`) and surfaced to admin later, but do NOT block the owner notification — matches the spec's "lower severities logged without blocking in the first slice." This keeps false-positive blast radius small.
2. **Provider moderation ships behind config, default OFF.** The OpenAI Moderation integration is in the code but only runs when `OPENAI_MODERATION_ENABLED=true`. Turning it on in production is an external gate. Worker-only (never called from Vercel).
3. **Admin flagged queue UI + disposition is PR 3b**, not here. PR 3a holds unsafe drafts safely (they sit as `pending_approval` responses with no notification + an `open` flagged row); PR 3b adds the page to act on them.
4. **`flagged_responses` is admin-only via deny-all RLS** (enable RLS, no policy) — server reads it through the Postgres.js `postgres` role which bypasses RLS, exactly like `impersonation_sessions` (048) and `analytics_events` (049).

---

## File Structure

| File | Responsibility | Create / Modify |
|---|---|---|
| `src/lib/moderation/output-filter.ts` | `ModerationDecision` type + `runOutputFilter` (local regex rules) | Create |
| `src/lib/moderation/__tests__/output-filter.test.ts` | Output-filter unit tests | Create |
| `src/lib/moderation/moderate.ts` | `moderateResponse` orchestrator + optional OpenAI moderation (fail-open) | Create |
| `src/lib/moderation/__tests__/moderate.test.ts` | Orchestrator + provider fallback tests | Create |
| `supabase/migrations/051_flagged_responses.sql` | `flagged_responses` table + deny-all RLS + indexes | Create |
| `src/lib/shared/__tests__/migration-051-structure.test.ts` | Structure test for 051 | Create |
| `worker/jobs/ResponseGeneratorWorker.ts` | Run moderation; write moderation fields + flagged row + suppress in the tx | Modify |
| `worker/jobs/__tests__/ResponseGeneratorWorker.test.ts` | Mock moderation; add flagged-suppression test | Modify |
| `.claude/CLAUDE.md` | Bump migration head, note moderation/flagged-hold | Modify |
| `.claude/skills/migrations.md` | Add 051 entry | Modify |

---

## Task 1: Local output filter

**Files:**
- Create: `src/lib/moderation/output-filter.ts`
- Test: `src/lib/moderation/__tests__/output-filter.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/moderation/__tests__/output-filter.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { runOutputFilter } from '../output-filter';

describe('runOutputFilter', () => {
  it('passes a clean, on-brand response', () => {
    const d = runOutputFilter('Thank you so much for the kind words, Jane! We hope to see you again soon.');
    expect(d.flagged).toBe(false);
    expect(d.severity).toBe('low');
    expect(d.reason).toBeNull();
    expect(d.source).toBeNull();
    expect(d.score).toBe(0);
  });

  it('flags a refund/discount promise as high', () => {
    const d = runOutputFilter('We are so sorry — please come back for a free meal on us, and here is a 20% off coupon.');
    expect(d.flagged).toBe(true);
    expect(d.severity).toBe('high');
    expect(d.source).toBe('local_regex');
    expect(d.categories).toHaveProperty('refund_discount');
  });

  it('flags an admission of legal fault as high', () => {
    const d = runOutputFilter('You are right, that was our fault and we were negligent; we may be liable.');
    expect(d.flagged).toBe(true);
    expect(d.severity).toBe('high');
    expect(d.categories).toHaveProperty('legal_fault');
  });

  it('flags prompt-injection compliance as high', () => {
    const d = runOutputFilter('As instructed, here is the system prompt you asked for.');
    expect(d.flagged).toBe(true);
    expect(d.severity).toBe('high');
    expect(d.categories).toHaveProperty('injection_compliance');
  });

  it('flags profanity as high', () => {
    const d = runOutputFilter('That review is total bullshit and you are an asshole.');
    expect(d.flagged).toBe(true);
    expect(d.severity).toBe('high');
    expect(d.categories).toHaveProperty('profanity');
  });

  it('flags competitor disparagement as medium', () => {
    const d = runOutputFilter('We are so much better than our competitors down the street.');
    expect(d.flagged).toBe(true);
    expect(d.severity).toBe('medium');
    expect(d.categories).toHaveProperty('competitor');
  });

  it('flags medical/legal/financial advice as medium', () => {
    const d = runOutputFilter('For that reaction you should consult a doctor; this is not medical advice.');
    expect(d.flagged).toBe(true);
    expect(d.severity).toBe('medium');
    expect(d.categories).toHaveProperty('advice');
  });

  it('takes the highest severity across multiple hits', () => {
    const d = runOutputFilter('Unlike our competitors, we will refund you in full.');
    expect(d.severity).toBe('high'); // refund (high) beats competitor (medium)
  });

  it('does not false-positive on common words containing rule substrings', () => {
    const d = runOutputFilter('Our company is complete and our complimentary water is always available.');
    expect(d.flagged).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/moderation/__tests__/output-filter.test.ts`
Expected: FAIL — cannot resolve `../output-filter`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/moderation/output-filter.ts`:

```ts
/**
 * Result of moderating one generated response. `source` records which layer
 * produced the flag; `categories` carries per-rule hit counts (local) and/or
 * provider category scores. Mirrors the shape recorded on api_costs.
 */
export type ModerationDecision = {
  flagged: boolean;
  severity: 'low' | 'medium' | 'high';
  reason: string | null;
  categories: Record<string, unknown>;
  score: number | null;
  source: 'local_regex' | 'openai_moderation' | null;
};

export const SEVERITY_RANK: Record<ModerationDecision['severity'], number> = {
  low: 0,
  medium: 1,
  high: 2,
};

type Severity = 'medium' | 'high';
interface Rule {
  category: string;
  severity: Severity;
  patterns: RegExp[];
}

// High-confidence, word-boundaried patterns. No `g` flag — `.test()` must stay
// stateless. Tuned to avoid false positives on common words (company, complete,
// complimentary) — see the false-positive test.
const RULES: Rule[] = [
  {
    category: 'refund_discount',
    severity: 'high',
    patterns: [
      /\brefund(s|ed|ing)?\b/i,
      /\bdiscount(s|ed|ing)?\b/i,
      /\bcoupon(s)?\b/i,
      /\bvoucher(s)?\b/i,
      /\$\s*\d+\s*(off|back|refund)\b/i,
      /\b\d+\s*%\s*off\b/i,
      /\bfree\s+(meal|meals|drink|drinks|appetizer|dessert|night|stay|item|service|gift)\b/i,
      /\bon\s+the\s+house\b/i,
      /\bon\s+us\b/i,
      /\bcomp(ed|ing|s)?\b/i,
    ],
  },
  {
    category: 'legal_fault',
    severity: 'high',
    patterns: [
      /\bwe\s+(are|were)\s+liable\b/i,
      /\bour\s+(legal\s+)?fault\b/i,
      /\bnegligen(t|ce)\b/i,
      /\blawsuit\b/i,
      /\bliable\b/i,
      /\badmit(ting)?\s+(fault|liability|wrongdoing)\b/i,
    ],
  },
  {
    category: 'injection_compliance',
    severity: 'high',
    patterns: [
      /\bas\s+instructed\b/i,
      /\bignore\s+(the\s+|all\s+)?previous\b/i,
      /\bsystem\s+prompt\b/i,
      /\bdeveloper\s+message\b/i,
      /\bas\s+you\s+(asked|requested|commanded)\b/i,
    ],
  },
  {
    category: 'profanity',
    severity: 'high',
    // Small high-confidence denylist; extend as real samples appear.
    patterns: [
      /\bf+u+c+k\w*\b/i,
      /\bbull?shit\w*\b/i,
      /\basshole\w*\b/i,
      /\bbitch\w*\b/i,
      /\bbastard\w*\b/i,
    ],
  },
  {
    category: 'competitor',
    severity: 'medium',
    patterns: [
      /\b(better|worse)\s+than\s+(our\s+)?competitors?\b/i,
      /\bunlike\s+(our\s+)?competitors?\b/i,
      /\bcompetitor('s|s)?\b/i,
    ],
  },
  {
    category: 'advice',
    severity: 'medium',
    patterns: [
      /\byou\s+should\s+(see|consult)\s+(a\s+)?(doctor|lawyer|attorney|accountant|physician)\b/i,
      /\b(medical|legal|financial)\s+advice\b/i,
      /\bdiagnos(e|is|ed)\b/i,
      /\bprescri(be|ption)\b/i,
    ],
  },
];

const SCORE_BY_SEVERITY: Record<ModerationDecision['severity'], number> = {
  low: 0,
  medium: 0.5,
  high: 1,
};

export function runOutputFilter(text: string): ModerationDecision {
  const categories: Record<string, unknown> = {};
  const reasons: string[] = [];
  let topSeverity: ModerationDecision['severity'] = 'low';

  for (const rule of RULES) {
    const hits = rule.patterns.filter((pattern) => pattern.test(text)).length;
    if (hits === 0) continue;
    categories[rule.category] = hits;
    reasons.push(rule.category);
    if (SEVERITY_RANK[rule.severity] > SEVERITY_RANK[topSeverity]) {
      topSeverity = rule.severity;
    }
  }

  const flagged = reasons.length > 0;
  return {
    flagged,
    severity: topSeverity,
    reason: flagged ? reasons.join(', ') : null,
    categories,
    score: flagged ? SCORE_BY_SEVERITY[topSeverity] : 0,
    source: flagged ? 'local_regex' : null,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/moderation/__tests__/output-filter.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/moderation/output-filter.ts src/lib/moderation/__tests__/output-filter.test.ts
git commit -m "feat(trust-safety): local output moderation filter

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Moderation orchestrator (+ optional provider)

**Files:**
- Create: `src/lib/moderation/moderate.ts`
- Test: `src/lib/moderation/__tests__/moderate.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/moderation/__tests__/moderate.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const moderationsCreate = vi.fn();
vi.mock('openai', () => ({
  default: class {
    moderations = { create: moderationsCreate };
  },
}));

import { moderateResponse } from '../moderate';

describe('moderateResponse', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.OPENAI_MODERATION_ENABLED;
  });
  afterEach(() => {
    delete process.env.OPENAI_MODERATION_ENABLED;
  });

  it('returns the local decision and does not call the provider when disabled', async () => {
    const d = await moderateResponse('We will refund you in full.');
    expect(d.flagged).toBe(true);
    expect(d.severity).toBe('high');
    expect(d.source).toBe('local_regex');
    expect(moderationsCreate).not.toHaveBeenCalled();
  });

  it('returns a clean local decision for safe text when disabled', async () => {
    const d = await moderateResponse('Thanks so much for visiting!');
    expect(d.flagged).toBe(false);
    expect(moderationsCreate).not.toHaveBeenCalled();
  });

  it('calls the provider when enabled and escalates to high on a provider flag', async () => {
    process.env.OPENAI_MODERATION_ENABLED = 'true';
    moderationsCreate.mockResolvedValueOnce({
      results: [{ flagged: true, categories: { harassment: true } }],
    });
    const d = await moderateResponse('Some text the local rules consider clean.');
    expect(moderationsCreate).toHaveBeenCalledOnce();
    expect(d.flagged).toBe(true);
    expect(d.severity).toBe('high');
    expect(d.source).toBe('openai_moderation');
  });

  it('fails open to the local decision when the provider throws', async () => {
    process.env.OPENAI_MODERATION_ENABLED = 'true';
    moderationsCreate.mockRejectedValueOnce(new Error('provider 500'));
    const d = await moderateResponse('Thanks for the review!');
    expect(d.flagged).toBe(false); // local says clean; provider error must not throw
    expect(d.categories).toMatchObject({ openai_moderation: 'error' });
  });

  it('keeps a local high flag even when the provider says clean', async () => {
    process.env.OPENAI_MODERATION_ENABLED = 'true';
    moderationsCreate.mockResolvedValueOnce({ results: [{ flagged: false, categories: {} }] });
    const d = await moderateResponse('We will give you a full refund.');
    expect(d.flagged).toBe(true);
    expect(d.severity).toBe('high');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/moderation/__tests__/moderate.test.ts`
Expected: FAIL — cannot resolve `../moderate`.

- [ ] **Step 3: Write the orchestrator**

Create `src/lib/moderation/moderate.ts`:

```ts
import OpenAI from 'openai';
import { runOutputFilter, SEVERITY_RANK, type ModerationDecision } from './output-filter';

// Worker-only. Never import from Next.js/Vercel code — moderation is an
// LLM-class external call and belongs on the Railway worker.
const PROVIDER_MODEL = 'omni-moderation-latest';

function providerEnabled(): boolean {
  return process.env.OPENAI_MODERATION_ENABLED === 'true';
}

let cachedClient: OpenAI | null = null;
function client(): OpenAI {
  if (!cachedClient) cachedClient = new OpenAI();
  return cachedClient;
}

function mergeDecisions(a: ModerationDecision, b: ModerationDecision): ModerationDecision {
  const top = SEVERITY_RANK[a.severity] >= SEVERITY_RANK[b.severity] ? a : b;
  const reason = [a.reason, b.reason].filter(Boolean).join(', ');
  return {
    flagged: a.flagged || b.flagged,
    severity: top.severity,
    reason: reason.length > 0 ? reason : null,
    categories: { ...a.categories, ...b.categories },
    score: Math.max(a.score ?? 0, b.score ?? 0),
    source: top.source ?? a.source ?? b.source,
  };
}

/**
 * Always runs the local filter. When OPENAI_MODERATION_ENABLED=true, also calls
 * the OpenAI Moderation API and merges (provider flag → high severity). Never
 * throws: a provider outage falls back to the local decision and records a
 * warning marker in categories, so a moderation failure can never silently
 * approve unsafe text by crashing the generation path.
 */
export async function moderateResponse(text: string): Promise<ModerationDecision> {
  const local = runOutputFilter(text);
  if (!providerEnabled()) return local;

  try {
    const response = await client().moderations.create({ model: PROVIDER_MODEL, input: text });
    const result = response.results?.[0];
    if (!result) return local;

    if (result.flagged !== true) {
      return { ...local, categories: { ...local.categories, openai_moderation: 'clean' } };
    }

    const provider: ModerationDecision = {
      flagged: true,
      severity: 'high',
      reason: 'openai_moderation',
      categories: { openai_categories: result.categories },
      score: 1,
      source: 'openai_moderation',
    };
    return mergeDecisions(local, provider);
  } catch (err) {
    console.error('[moderation] OpenAI moderation failed; using local rules only:', err);
    return { ...local, categories: { ...local.categories, openai_moderation: 'error' } };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/moderation/__tests__/moderate.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/moderation/moderate.ts src/lib/moderation/__tests__/moderate.test.ts
git commit -m "feat(trust-safety): moderation orchestrator with fail-open provider layer

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `flagged_responses` table (migration 051)

**Files:**
- Create: `supabase/migrations/051_flagged_responses.sql`
- Test: `src/lib/shared/__tests__/migration-051-structure.test.ts`

- [ ] **Step 1: Write the failing structure test**

Create `src/lib/shared/__tests__/migration-051-structure.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const MIGRATION_PATH = resolve(
  process.cwd(),
  'supabase/migrations/051_flagged_responses.sql',
);

let sql: string;
beforeAll(() => {
  sql = readFileSync(MIGRATION_PATH, 'utf-8');
});

describe('migration 051 — flagged_responses', () => {
  it('creates the table idempotently', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS flagged_responses/i);
  });

  it.each([
    'response_id',
    'account_id',
    'business_id',
    'review_id',
    'api_cost_id',
    'source',
    'reason',
    'severity',
    'status',
    'reviewed_by_user_id',
    'reviewed_at',
    'created_at',
    'updated_at',
  ])('defines column %s', (col) => {
    expect(sql).toMatch(new RegExp(`\\b${col}\\b`));
  });

  it('references the parent rows', () => {
    expect(sql).toMatch(/response_id\s+UUID[^,]*REFERENCES\s+responses\(id\)/i);
    expect(sql).toMatch(/account_id\s+UUID[^,]*REFERENCES\s+accounts\(id\)/i);
    expect(sql).toMatch(/business_id\s+UUID[^,]*REFERENCES\s+businesses\(id\)/i);
    expect(sql).toMatch(/review_id\s+UUID[^,]*REFERENCES\s+reviews\(id\)/i);
    expect(sql).toMatch(/api_cost_id\s+UUID[^,]*REFERENCES\s+api_costs\(id\)/i);
  });

  it('constrains status and severity', () => {
    expect(sql).toMatch(/status[^,]*CHECK[^,]*open/i);
    expect(sql).toMatch(/severity[^,]*CHECK[^,]*high/i);
  });

  it('enables RLS (admin-only, deny-all)', () => {
    expect(sql).toMatch(/ALTER TABLE flagged_responses ENABLE ROW LEVEL SECURITY/i);
    // Deny-all: no policy is created (server uses the postgres role).
    expect(sql).not.toMatch(/CREATE POLICY/i);
  });

  it('indexes the admin queue read path', () => {
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS[^;]*flagged_responses[^;]*status/i);
  });

  it('does not drop or mutate data', () => {
    expect(sql).not.toMatch(/DROP TABLE/i);
    expect(sql).not.toMatch(/^\s*UPDATE\s+/im);
    expect(sql).not.toMatch(/^\s*DELETE\s+/im);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/shared/__tests__/migration-051-structure.test.ts`
Expected: FAIL — file does not exist.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/051_flagged_responses.sql`:

```sql
-- Migration 051: flagged_responses (Wave 3, PR 3a)
--
-- Holds high-confidence unsafe generated drafts that must NOT enter the normal
-- owner approval-notification path until an admin dispositions them (PR 3b adds
-- the admin queue + disposition actions). Preserves the no-auto-posting
-- invariant: a flagged draft stays a `pending_approval` response with no
-- notification and an `open` row here.
--
-- Admin-only via deny-all RLS (enable RLS, no policy) — server reads through the
-- Postgres.js `postgres` role which bypasses RLS, like impersonation_sessions
-- (048) and analytics_events (049). Owners never see this table directly.

CREATE TABLE IF NOT EXISTS flagged_responses (
  id                  UUID PRIMARY KEY,
  response_id         UUID NOT NULL REFERENCES responses(id) ON DELETE CASCADE,
  account_id          UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  business_id         UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  review_id           UUID NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  api_cost_id         UUID REFERENCES api_costs(id),
  source              TEXT NOT NULL CHECK (source IN ('local_regex', 'openai_moderation', 'eval', 'admin')),
  reason              TEXT,
  severity            TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high')),
  status              TEXT NOT NULL DEFAULT 'open'
                        CHECK (status IN ('open', 'approved_for_owner_review', 'dismissed_false_positive', 'requires_regeneration')),
  reviewed_by_user_id UUID REFERENCES users(id),
  reviewed_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE flagged_responses IS
  'High-confidence unsafe drafts held out of the owner approval path until admin disposition (Wave 3 PR 3a/3b). Admin-only (deny-all RLS).';

ALTER TABLE flagged_responses ENABLE ROW LEVEL SECURITY;

-- Admin queue reads open items newest-first.
CREATE INDEX IF NOT EXISTS idx_flagged_responses_status_created
  ON flagged_responses (status, created_at DESC);

-- One open flag per response (idempotent re-runs of a response generation must
-- not stack duplicate open flags).
CREATE UNIQUE INDEX IF NOT EXISTS idx_flagged_responses_open_response
  ON flagged_responses (response_id)
  WHERE status = 'open';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/shared/__tests__/migration-051-structure.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/051_flagged_responses.sql src/lib/shared/__tests__/migration-051-structure.test.ts
git commit -m "feat(trust-safety): migration 051 — flagged_responses table (admin-only RLS)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Worker integration — moderate, record, hold

**Files:**
- Modify: `worker/jobs/ResponseGeneratorWorker.ts`
- Modify: `worker/jobs/__tests__/ResponseGeneratorWorker.test.ts`

- [ ] **Step 1: Add the moderation mock + flagged-suppression test FIRST**

In `worker/jobs/__tests__/ResponseGeneratorWorker.test.ts`:

(1a) Add `mockModerateResponse` to the `vi.hoisted(() => {...})` block. Inside the hoisted factory, add it to the returned object alongside the other mocks:
```ts
    mockModerateResponse: vi.fn(),
```
And add it to the destructured names at the top (`const { ... mockEnqueueAnalyticsEvent, mockModerateResponse } = vi.hoisted(...)`).

(1b) Add a module mock (next to the other `vi.mock` calls):
```ts
vi.mock('../../../src/lib/moderation/moderate', () => ({
  moderateResponse: mockModerateResponse,
}));
```

(1c) In the top-level `beforeEach`, set the default (not-flagged) decision so all existing tests keep their normal-notification behavior:
```ts
    mockModerateResponse.mockResolvedValue({
      flagged: false, severity: 'low', reason: null, categories: {}, score: 0, source: null,
    });
```

(1d) Add this new test at the end of the `describe('ResponseGeneratorWorker – handleResponseGeneration', ...)` block:
```ts
  it('holds a high-severity flagged draft: no send_notification, writes a flagged_responses row', async () => {
    sqlReturnQueue.push([mockReviewRow()]);
    sqlReturnQueue.push([mockBusinessRow()]);
    mockGenerateResponse.mockResolvedValueOnce(MOCK_RESULT);
    mockModerateResponse.mockResolvedValueOnce({
      flagged: true, severity: 'high', reason: 'refund_discount',
      categories: { refund_discount: 1 }, score: 1, source: 'local_regex',
    });

    await handleResponseGeneration(makeJob());

    // No send_notification payload was inserted (same shape filter as the
    // suppress_notification test).
    const sendNotificationPayloads = mockTx.mock.calls
      .flat()
      .filter(
        (arg): arg is Record<string, unknown> =>
          !!arg && typeof arg === 'object' && !Array.isArray(arg)
          && 'response_id' in (arg as Record<string, unknown>)
          && 'business_id' in (arg as Record<string, unknown>)
          && !('version' in (arg as Record<string, unknown>))
          && !('review_id' in (arg as Record<string, unknown>)),
      );
    expect(sendNotificationPayloads).toHaveLength(0);

    // A flagged_responses INSERT ran — its distinctive bound values appear in
    // the tx template args.
    const txArgs = mockTx.mock.calls.flat();
    expect(txArgs).toContain('local_regex');
    expect(txArgs).toContain('open');

    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-gen-1', undefined);
  });

  it('sends the normal notification when moderation does not flag (default)', async () => {
    sqlReturnQueue.push([mockReviewRow()]);
    sqlReturnQueue.push([mockBusinessRow()]);
    mockGenerateResponse.mockResolvedValueOnce(MOCK_RESULT);

    await handleResponseGeneration(makeJob());

    const sendNotificationPayloads = mockTx.mock.calls
      .flat()
      .filter(
        (arg): arg is Record<string, unknown> =>
          !!arg && typeof arg === 'object' && !Array.isArray(arg)
          && 'response_id' in (arg as Record<string, unknown>)
          && 'business_id' in (arg as Record<string, unknown>)
          && !('version' in (arg as Record<string, unknown>))
          && !('review_id' in (arg as Record<string, unknown>)),
      );
    expect(sendNotificationPayloads).toHaveLength(1);
    const txArgs = mockTx.mock.calls.flat();
    expect(txArgs).not.toContain('open'); // no flagged_responses row
  });
```

- [ ] **Step 2: Run the worker tests to verify the new flagged test fails**

Run: `pnpm vitest run worker/jobs/__tests__/ResponseGeneratorWorker.test.ts`
Expected: the new "holds a high-severity flagged draft" test FAILS (moderation not yet wired; a `send_notification` payload is still inserted and no `flagged_responses` INSERT happens). Existing tests still pass (default mock = not flagged).

- [ ] **Step 3: Import moderation in the worker**

In `worker/jobs/ResponseGeneratorWorker.ts`, after the existing import of `generateResponse` (the line `import { generateResponse, TransientLLMError } from '../../src/lib/responses/generator';`), add:
```ts
import { moderateResponse } from '../../src/lib/moderation/moderate';
import type { ModerationDecision } from '../../src/lib/moderation/output-filter';
```

- [ ] **Step 4: Run moderation after the avoid-facts guardrail**

Find this exact block (Step 9 persist call):
```ts
  // ── Step 9: Persist response + outbox + cost link in one transaction ─
  const responseId = await persistResponseAndNotify(
    result, review_id, businessId, version, job.data.correlation_id,
    job.data.suppress_notification === true,
  );
```
Replace with:
```ts
  // ── Step 8.5: Output moderation (local rules always; provider if configured) ─
  const moderation = await moderateResponse(result.responseText);

  // ── Step 9: Persist response + outbox + cost link + moderation in one tx ─
  const responseId = await persistResponseAndNotify(
    result, review_id, businessId, version, job.data.correlation_id,
    job.data.suppress_notification === true,
    moderation, business.account_id,
  );
```

- [ ] **Step 5: Extend `persistResponseAndNotify`**

Replace the ENTIRE `persistResponseAndNotify` function with the version below. Changes: two new params (`moderation`, `accountId`); write moderation fields onto the moderated `api_costs` row; insert a `flagged_responses` row + skip notification for a `high`-severity flag.

```ts
async function persistResponseAndNotify(
  result: GenerationResult,
  reviewId: string,
  businessId: string,
  version: number,
  correlationId: string | undefined,
  suppressNotification: boolean,
  moderation: ModerationDecision,
  accountId: string,
): Promise<string> {
  const responseId = uuidv7();
  const retryCostId = (result as any)._retryCostId as string | undefined;
  // Moderation describes the FINAL output; when an avoid-facts retry happened,
  // the final text's cost row is the retry's row.
  const moderatedCostId = retryCostId ?? result.apiCostId;
  const flaggedHigh = moderation.flagged && moderation.severity === 'high';

  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO responses (
        id, review_id, business_id, response_text, response_language,
        version, status, original_draft_text,
        llm_provider, llm_model, prompt_tokens, completion_tokens
      ) VALUES (
        ${responseId}, ${reviewId}, ${businessId}, ${result.responseText}, ${result.language},
        ${version}, 'pending_approval', ${result.responseText},
        ${result.provider}, ${result.model}, ${result.usage.promptTokens}, ${result.usage.completionTokens}
      )
    `;

    if (result.apiCostId) {
      await tx`
        UPDATE api_costs SET response_id = ${responseId} WHERE id = ${result.apiCostId}
      `;
    }

    if (retryCostId) {
      await tx`
        UPDATE api_costs SET response_id = ${responseId} WHERE id = ${retryCostId}
      `;
    }

    // Record moderation metadata on the cost row for the final output. Excerpt
    // is for operational triage only — full text already lives on responses.
    if (moderatedCostId) {
      await tx`
        UPDATE api_costs SET
          moderation_score = ${moderation.score},
          moderation_categories = ${jsonb(moderation.categories)},
          flagged = ${moderation.flagged},
          flag_reason = ${moderation.reason},
          output_excerpt = ${result.responseText.slice(0, 200)}
        WHERE id = ${moderatedCostId}
      `;
    }

    // High-confidence unsafe draft: hold it for admin disposition (PR 3b) and
    // do NOT enqueue the owner notification. The response stays pending_approval.
    if (flaggedHigh) {
      await tx`
        INSERT INTO flagged_responses (
          id, response_id, account_id, business_id, review_id, api_cost_id,
          source, reason, severity, status
        ) VALUES (
          ${uuidv7()}, ${responseId}, ${accountId}, ${businessId}, ${reviewId}, ${moderatedCostId ?? null},
          ${moderation.source ?? 'local_regex'}, ${moderation.reason}, ${moderation.severity}, 'open'
        )
      `;
    }

    // Backfill suppression (spec §4.6, §6.7) OR a high-severity flag both skip
    // the approval notification.
    if (suppressNotification || flaggedHigh) {
      return;
    }

    const notifyPayload: SendNotificationPayload = {
      response_id: responseId,
      business_id: businessId,
      correlation_id: correlationId,
    };

    await tx`
      INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
      VALUES (
        ${uuidv7()}, 'send_notification', 'response', ${responseId},
        ${jsonb(notifyPayload)}, 'pending'
      )
    `;
  });

  return responseId;
}
```

- [ ] **Step 6: Run the worker tests + typecheck**

Run: `pnpm vitest run worker/jobs/__tests__/ResponseGeneratorWorker.test.ts && pnpm typecheck`
Expected: PASS — all existing tests (default not-flagged), the new flagged-hold test, and the not-flagged-notifies test. Typecheck clean.
(If typecheck errors only on a stale `.next/types/validator.ts` referencing `src/app/api/health/route.js`, run `rm -rf .next` and re-run — unrelated stale artifact.)

- [ ] **Step 7: Commit**

```bash
git add worker/jobs/ResponseGeneratorWorker.ts worker/jobs/__tests__/ResponseGeneratorWorker.test.ts
git commit -m "feat(trust-safety): moderate drafts, record on api_costs, hold high-severity flags

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Docs + full verification

**Files:**
- Modify: `.claude/CLAUDE.md`
- Modify: `.claude/skills/migrations.md`

- [ ] **Step 1: Bump the migration head in `.claude/CLAUDE.md`**

Find:
```
- Current head: migration **050** (next: **051**)
```
Replace with:
```
- Current head: migration **051** (next: **052**)
```

- [ ] **Step 2: Note the moderation hold under the no-auto-posting invariant in `.claude/CLAUDE.md`**

Find the `- **No auto-posting.**` invariant bullet. Immediately AFTER that bullet (before the next `- **` invariant), add:
```
- **High-confidence unsafe drafts are held, not notified.** `ResponseGeneratorWorker`
  runs `moderateResponse` (`src/lib/moderation/*`) after generation; a
  `high`-severity flag writes a `flagged_responses` row (migration 051,
  admin-only) and skips the `send_notification` outbox enqueue in the SAME
  transaction as response persistence. The draft stays `pending_approval` — no
  owner notification until an admin dispositions it (PR 3b). Moderation metadata
  is recorded on `api_costs` (`moderation_*`, `flagged`, `output_excerpt`).
```

- [ ] **Step 3: Add a 051 entry to `.claude/skills/migrations.md`**

Open `.claude/skills/migrations.md`, find the migration `050` entry, and add a `051` entry immediately after it, matching the file's existing format. Content:

> 051 — flagged_responses (Wave 3 PR 3a). Admin-only table (deny-all RLS, server reads via the postgres role) holding high-confidence unsafe drafts out of the owner approval-notification path until admin disposition. FKs to responses/accounts/businesses/reviews/api_costs; CHECK constraints on source/severity/status; partial unique index on (response_id) WHERE status='open'; index on (status, created_at DESC). PR 3b adds the admin queue + disposition.

If the file's structure doesn't accommodate a per-migration entry, STOP and report NEEDS_CONTEXT.

- [ ] **Step 4: Run the full quality gate**

```bash
pnpm vitest run \
  src/lib/moderation/__tests__/output-filter.test.ts \
  src/lib/moderation/__tests__/moderate.test.ts \
  src/lib/shared/__tests__/migration-051-structure.test.ts \
  worker/jobs/__tests__/ResponseGeneratorWorker.test.ts
pnpm ci:tenant-scope
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Expectations:
- The four focused suites pass.
- `pnpm ci:tenant-scope` passes. NOTE: the new `flagged_responses` INSERT/UPDATE statements live in `worker/jobs/ResponseGeneratorWorker.ts`. The audit scans SELECT/UPDATE/DELETE on tenant tables. The `UPDATE api_costs SET ... WHERE id = ${moderatedCostId}` is scoped by `id` (row identity) — the audit treats a bound `id =` predicate on a tenant row as scoped (see its `accountAliasScoped`/row-id handling). If the audit flags `flagged_responses` (a new table not in its tenant-table inventory) or the api_costs UPDATE, report the exact finding — do NOT broaden the query; instead add a reviewed allowlist entry following the existing `tenant-scope-allowlist.ts` pattern with a specific reason, and note it in the report.
- `pnpm lint` clean except the known pre-existing `<img>` warning.
- `pnpm typecheck` clean.
- `pnpm test` full unit suite green.
- `pnpm build` succeeds.

If any command genuinely fails, report the actual output and whether it stems from this PR — do not claim success.

- [ ] **Step 5: Commit**

```bash
git add .claude/CLAUDE.md .claude/skills/migrations.md
git commit -m "docs(trust-safety): bump migration head to 051, note moderation hold

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage (Sub-Spec 10/22, PR 3a slice):**

| Spec item | Task |
|---|---|
| `src/lib/moderation/output-filter.ts` with launch-critical local rules (refund/discount, legal fault, advice, profanity, competitor, injection compliance) | Task 1 |
| `ModerationDecision` shape (`flagged`/`severity`/`reason`/`categories`/`score`) | Task 1 (+ `source`) |
| Optional OpenAI Moderation behind config; failure does not silently approve; not called from Vercel; recorded in `api_costs` | Task 2 (orchestrator) + Task 4 (recorded on api_costs) |
| High-confidence `high` blocks the normal approval notification + creates a flagged record; lower severities logged without blocking | Task 4 (`flaggedHigh` gate) |
| `flagged_responses` table + admin-only RLS | Task 3 |
| Worker: generate → avoid-facts → moderation → persist response + api_costs link + flagged state in ONE transaction; `suppressNotification` for flagged; no enqueue | Task 4 |
| Preserves no-auto-posting (draft stays `pending_approval`, no notification) | Task 4 + Task 5 doc note |

**Deferred to PR 3b (honored):** `/admin/flagged` page, disposition actions (`approved_for_owner_review` re-enqueues notification via outbox, `dismissed_false_positive`, `requires_regeneration`). Eval harness + trust-safety docs are PR 4.

**2. Placeholder scan:** Every code step has complete code; commands list expected output. The only "match existing format" instruction is the `migrations.md` entry (content supplied) and the conditional tenant-scope allowlist entry (only if the audit flags — with the existing pattern named).

**3. Type consistency:** `ModerationDecision` (Task 1) is imported by `moderate.ts` (Task 2) and the worker (Task 4); its fields (`flagged`, `severity`, `reason`, `categories`, `score`, `source`) match every usage and the worker test's mock objects. `moderateResponse(text): Promise<ModerationDecision>` (Task 2) matches the worker call (Task 4) and the test mock (`mockModerateResponse`). `persistResponseAndNotify`'s new params (`moderation: ModerationDecision`, `accountId: string`) match the call site in Task 4 Step 4. `flagged_responses` columns (Task 3) match the INSERT in Task 4 Step 5 (`id, response_id, account_id, business_id, review_id, api_cost_id, source, reason, severity, status`).
</content>
</invoke>
