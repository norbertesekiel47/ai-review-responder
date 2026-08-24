# review_attributed Shadow Attribution — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record `review_attributed` as a shadow, never-billed outcome on the terminal **Lazy child** run when a newly ingested review matches a sent **Outreach row** inside the 14-day **Attribution window**, and show the owner each **Attributed review** with its evidence on the Requests surface.

**Architecture:** Attribution is a **lookback at review ingest**, not a timer (spec D16b). The live ingest transaction enqueues one `solicitation_attribution` outbox row — guarded so no job is enqueued when the business has no eligible Outreach row. A dedicated worker loads candidates, runs a pure two-rule name matcher, and writes the attribution columns plus the spine outcome in one transaction. The owner reads the result through a dedicated route, independent of which batch is current.

**Tech Stack:** Postgres.js + `job_outbox` + BullMQ (Railway worker) · Next.js 16 App Router route + client component · Vitest + fast-check.

**Ticket:** #632 · **Map:** #617 · **Specs:** `docs/superpowers/specs/2026-07-28-send-mode-executor-approval-design.md` D14/D16, `docs/future-plans/2026-05-22-saas-2-0-vertical-agent-platform-design.md` §6.3–6.4 · **Intake:** `.feature/intake.json`

---

## Module and seam design (`codebase-design`)

| Module | Verdict | Interface |
|---|---|---|
| `src/lib/solicitation/attribution.ts` | **NEW, deep** | 4 exports: `normalizePersonName`, `matchAttribution` (pure), `attributeReview` (write tx), `listAttributedReviews` (read model) — plus 3 constants. Hides normalization, both match rules, the ambiguity policy, an 8-predicate candidate query, the write transaction, the spine outcome emit, and the read projection. Deletion test: the rules would reappear in the worker AND the route. |
| `src/lib/reviews/process-review.ts` | **Deepened** | Interface unchanged. One new call inside the existing `sql.begin`. |
| `src/lib/shared/job-outbox-helpers.ts` | **Deepened** | One new export matching the other 18. |
| `worker/jobs/solicitation-attribution/` | **NEW, thin adapter** | Entry point at the BullMQ seam. Orchestrates only (invariant #12). |
| `src/app/api/dashboard/solicitation/attributed/route.ts` | **NEW, thin adapter** | Flag gate, owner auth, location scope, one module call. |
| `AttributedReviews.tsx` | **NEW, presentational** | Render seam. |

No new abstract seam is introduced. Every new module has exactly one implementation — no speculative interface (`one adapter means a hypothetical seam`).

### `matchAttribution` is an internal seam

`matchAttribution` is pure and DB-free. Its property tests cross it without a database. That is an internal seam used by the module's own tests, not a second external interface.

### Layering decision: the enqueue guard

`src/lib/shared/job-outbox-helpers.ts` imports only from `src/lib/shared/`. It must not import a domain module. So the guard does **not** re-spell the candidate predicate. Two rules keep one owner per fact:

1. The helper's guard is a deliberately **coarser superset**: any real candidate satisfies it, so it can never drop a match. Documented as such in the helper.
2. The window number has exactly one owner — `ATTRIBUTION_WINDOW_DAYS` in `attribution.ts`. `process-review.ts` imports it and passes it to the helper as `eligibilityWindowDays`. The helper spells no `14`.

---

## The match rule (locked at grilling, exact form)

```
tokens(raw) = NFD → strip combining marks → lowercase → '.'/',' → space
              → collapse whitespace → trim → split → drop empties

Both sides need >= 2 tokens. Otherwise REJECT (the bare-first-name rule).

first = tokens[0]        last = tokens[len - 1]        (middles ignored)

isInitial(t)      = t.length === 1
compatible(x, y)  = x === y
                  || (isInitial(x) && y.startsWith(x))
                  || (isInitial(y) && x.startsWith(y))

MATCH when  compatible(firstA, firstB)
       AND  compatible(lastA,  lastB)
       AND  (firstA === firstB || lastA === lastB)   ← shared-full-token rule

rule = 'full_name'           when firstA === firstB AND lastA === lastB
     = 'first_last_initial'  otherwise
```

Worked against every example the grilling locked:

| Contact | Reviewer | Result |
|---|---|---|
| `dana rodriguez` | `dana rodriguez` | MATCH · `full_name` |
| `dana rodriguez` | `dana r.` | MATCH · `first_last_initial` |
| `michael okafor` | `m. okafor` | MATCH · `first_last_initial` |
| `dana m rodriguez` | `dana rodriguez` | MATCH · `full_name` (middles ignored) |
| `dana rodriguez` | `dana` | REJECT — fewer than 2 tokens |
| `dana rodriguez` | `dana ramirez` | REJECT — neither surname is an initial |
| `d. rodriguez` | `dana r.` | REJECT — no shared full token |

> **Flagged for the owner.** The locked preview wrote rule B as "first tokens equal", and gave "no shared full token" as the reason `d. rodriguez` ~ `dana r.` is rejected. The rule above takes the *rationale* as the contract, which makes `m. okafor` ~ `michael okafor` a match — the mirror of the stated rule at identical strength, and the shape the owner-surface mock showed. If the owner wants the literal narrower reading (`first tokens equal` only), drop the `isInitial` arm from `compatible(firstA, firstB)`; one line, one test.

---

## Schema decisions

**`attribution_rule TEXT`, not `attribution_score NUMERIC`.** The intake preview carried a score column, written before the match rule was locked. The locked rule is a two-rule boolean with no scored fallback, so a score column would ship with no writer. The rule name is what the future M3 precision bar will slice by. Recorded as a deviation.

**`attribution_detail` carries no PII.** No `reviewer_name`, no `contact_name`. Both live in their own tables and the owner surface joins for them. Denormalizing the reviewer name would survive the review's deletion, which is a retention leak the **Body redaction** discipline exists to prevent.

**FK is `ON DELETE SET NULL`.** Deleting a review must never delete the Outreach row that recorded the send. The consistency CHECK is one-directional on purpose: a review id requires a timestamp, rule and detail, but a timestamp may outlive its review id — which is exactly what SET NULL leaves behind.

---

## File structure

| File | Responsibility |
|---|---|
| `supabase/migrations/114_solicitation_attribution.sql` | 4 columns, 1 CHECK, 2 indexes |
| `src/lib/solicitation/attribution.ts` | matcher, candidate query, write tx, read model |
| `src/lib/shared/queue-names.ts` | `SOLICITATION_ATTRIBUTION` topic |
| `src/lib/shared/worker-types.ts` | `SolicitationAttributionPayload` |
| `src/lib/shared/job-outbox-helpers.ts` | `enqueueSolicitationAttribution` |
| `src/lib/reviews/process-review.ts` | the enqueue call, in the existing tx |
| `worker/jobs/solicitation-attribution/SolicitationAttributionWorker.ts` | BullMQ handler |
| `worker/queues.ts`, `worker/index.ts` | queue + worker registration |
| `src/app/api/dashboard/solicitation/attributed/route.ts` | owner read route |
| `src/app/(authenticated)/dashboard/requests/AttributedReviews.tsx` | the section |
| `src/app/(authenticated)/dashboard/requests/RequestsClient.tsx` | fetch + mount |

---

## Task graph

```
Task 0 (eval) ──► Task 1 (migration) ──► Task 2 (matcher) ──┬─► Task 3 (write tx) ─┐
                                                             └─► Task 4 (enqueue) ──┴─► Task 5 (worker)
                                                                                          │
                                                                    Task 6 (read + route) ◄┘
                                                                                │
                                                                    Task 7 (UI) ┘ ──► Task 8 (docs)
```

**Mutually independent — parallel-dispatch eligible:** Task 3 and Task 4. Disjoint files, no blocking edge between them, both blocked only by Task 2. Every other pair is serial.

---

## Task 0: The eval task — author every promised test as failing

Authors all 26 `tests_to_add` titles verbatim. Slices not yet buildable use `.todo`. This is the spec in executable form and lands before any implementation.

**Files:**
- Create: `src/lib/solicitation/__tests__/attribution.test.ts`
- Create: `src/lib/solicitation/__tests__/attribution.integration.test.ts`
- Create: `src/lib/shared/__tests__/migration-114-solicitation-attribution.integration.test.ts`
- Create: `src/app/api/dashboard/solicitation/attributed/__tests__/route.test.ts`
- Create: `src/app/(authenticated)/dashboard/requests/__tests__/attributed-reviews.test.tsx`
- Modify: `src/lib/shared/__tests__/job-outbox-helpers.test.ts`
- Modify: `src/lib/reviews/__tests__/process-review.test.ts`

- [ ] **Step 1: Write the pure-matcher suite with every title verbatim**

`src/lib/solicitation/__tests__/attribution.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  matchAttribution,
  normalizePersonName,
  type AttributionCandidate,
} from '../attribution';

function candidate(name: string, id = 'o1'): AttributionCandidate {
  return {
    outreachId: id,
    contactName: name,
    sentAt: '2026-08-10T15:03:00.000Z',
    agentRunId: 'run-1',
  };
}

describe('matchAttribution', () => {
  it('exact normalized full-name equality attributes', () => {
    const result = matchAttribution('Dana Rodriguez', [candidate('dana rodriguez')]);
    expect(result).toEqual({
      resolution: 'attributed',
      candidate: candidate('dana rodriguez'),
      rule: 'full_name',
    });
  });

  it('first name plus matching last initial attributes', () => {
    const result = matchAttribution('Dana R.', [candidate('Dana Rodriguez')]);
    expect(result.resolution).toBe('attributed');
    expect(result).toMatchObject({ rule: 'first_last_initial' });
  });

  it('a bare first name with no surname token never attributes', () => {
    const result = matchAttribution('Dana', [candidate('Dana Rodriguez')]);
    expect(result).toEqual({ resolution: 'no_match', candidateCount: 1 });
  });

  it('accents and letter case normalize before comparison', () => {
    const result = matchAttribution('JOSÉ MARTÍNEZ', [candidate('jose martinez')]);
    expect(result).toMatchObject({ resolution: 'attributed', rule: 'full_name' });
  });

  it('two candidates matching the same review abstain with resolution ambiguous', () => {
    const result = matchAttribution('Dana R.', [
      candidate('Dana Rodriguez', 'o1'),
      candidate('Dana Ramirez', 'o2'),
    ]);
    expect(result).toEqual({ resolution: 'ambiguous', candidateCount: 2 });
  });

  it('a null or empty reviewer name never attributes', () => {
    expect(matchAttribution(null, [candidate('Dana Rodriguez')]))
      .toEqual({ resolution: 'no_match', candidateCount: 1 });
    expect(matchAttribution('   ', [candidate('Dana Rodriguez')]))
      .toEqual({ resolution: 'no_match', candidateCount: 1 });
  });

  describe('invariants', () => {
    const nameArb = fc.stringMatching(/^[a-z]{1,8}( [a-z]{1,8}){0,2}$/);

    it('matchAttribution never returns more than one attributed candidate', () => {
      fc.assert(
        fc.property(nameArb, fc.array(nameArb, { maxLength: 6 }), (reviewer, names) => {
          const result = matchAttribution(
            reviewer,
            names.map((n, i) => candidate(n, `o${i}`)),
          );
          if (result.resolution !== 'attributed') return true;
          const winners = names.filter(
            (n) => matchAttribution(reviewer, [candidate(n)]).resolution === 'attributed',
          );
          return winners.length === 1;
        }),
      );
    });

    it('matchAttribution never attributes when no candidate shares a full name token', () => {
      fc.assert(
        fc.property(nameArb, nameArb, (reviewer, contact) => {
          const result = matchAttribution(reviewer, [candidate(contact)]);
          if (result.resolution !== 'attributed') return true;
          const a = normalizePersonName(reviewer).split(' ');
          const b = normalizePersonName(contact).split(' ');
          return a[0] === b[0] || a[a.length - 1] === b[b.length - 1];
        }),
      );
    });
  });
});
```

- [ ] **Step 2: Write the integration suite with every title verbatim, bodies as `.todo`**

`src/lib/solicitation/__tests__/attribution.integration.test.ts` — file name ends `.integration.test.ts` so vitest's serialized `integration` project selects it. **No run-time DDL** (`ci:live-db-suites`). Use `assertSchemaReady`, following `src/lib/solicitation/__tests__/batch-view.integration.test.ts`.

```typescript
describe('attribution', () => {
  it.todo('the candidate query excludes bounced, complained and unknown outreach rows');
  it.todo('the candidate query excludes rows outside the 14-day attribution window');
  it.todo('an unsubscribed outreach row is still a candidate');
  it.todo('an already-attributed outreach row is never a candidate for a second review');
  it.todo('the handler writes the attribution columns and the review_attributed outcome in one transaction');
  it.todo('re-running the handler for the same review is idempotent and emits exactly one outcome');
  it.todo('attribution is sentiment-blind — a one-star review attributes like a five-star review');
  it.todo('a matched outreach row with a null agent_run_id writes columns and skips the outcome');
});

describe('listAttributedReviews', () => {
  it.todo('returns matches across batches within the last 30 days');
  it.todo('scopes every read by account_id and business_id');
  it.todo('returns an empty list when SOLICITATION_SEND_ENABLED is off');
});
```

- [ ] **Step 3: Write the migration shape suite as `.todo`**

`src/lib/shared/__tests__/migration-114-solicitation-attribution.integration.test.ts`, following `migration-091-send-mode-spine.integration.test.ts`:

```typescript
describe('migration 114', () => {
  it.todo('attribution columns, the consistency CHECK and the partial unique index exist');
  it.todo('deleting an attributed review nulls attributed_review_id and leaves the outreach row');
});
```

- [ ] **Step 4: Add the two enqueue titles as `.todo`**

Append to `src/lib/shared/__tests__/job-outbox-helpers.test.ts`:

```typescript
describe('enqueueSolicitationAttribution', () => {
  it.todo('enqueues nothing when the business has no eligible outreach row in the window');
  it.todo('enqueues exactly one row per new review with an eligible candidate');
});
```

- [ ] **Step 5: Add the three UI titles as `.todo`**

`src/app/(authenticated)/dashboard/requests/__tests__/attributed-reviews.test.tsx`:

```typescript
describe('AttributedReviews', () => {
  it.todo('renders reviewer name, stars, review date and ask date for each match');
  it.todo('renders the shadow-metric never-billed disclosure');
  it.todo('renders an empty state when no review is attributed');
});
```

- [ ] **Step 6: Run the matcher suite and verify it fails**

Run: `pnpm vitest run src/lib/solicitation/__tests__/attribution.test.ts`
Expected: FAIL — `Failed to resolve import "../attribution"`.

- [ ] **Step 7: Verify the promised-tests row passes**

Run: `bash scripts/verify-gate.sh` and read `.feature/gate-status.json`.
Expected: the `promised-tests` row is PASS — all 26 titles exist verbatim. Other rows may fail; that is expected at Task 0.

- [ ] **Step 8: Commit**

```bash
git add src/lib/solicitation/__tests__/attribution.test.ts \
        src/lib/solicitation/__tests__/attribution.integration.test.ts \
        src/lib/shared/__tests__/migration-114-solicitation-attribution.integration.test.ts \
        src/lib/shared/__tests__/job-outbox-helpers.test.ts \
        src/app/api/dashboard/solicitation/attributed/__tests__/route.test.ts \
        src/app/\(authenticated\)/dashboard/requests/__tests__/attributed-reviews.test.tsx \
        src/lib/reviews/__tests__/process-review.test.ts
git commit -m "test(632): failing eval suite for review_attributed shadow attribution"
```

---

## Task 1: Migration 114 — attribution columns

**Blocked by:** Task 0.

**Files:**
- Create: `supabase/migrations/114_solicitation_attribution.sql`
- Modify: `src/lib/shared/__tests__/migration-114-solicitation-attribution.integration.test.ts`

> **Read `.claude/reference/migrations-log.md` before writing the first line of SQL, and invoke the `new-migration` skill.** Head is 113; this is 114.

- [ ] **Step 1: Write the migration**

```sql
-- 114_solicitation_attribution.sql
-- #632 — review_attributed shadow attribution (map #617, spec D16).
--
-- Additive and re-runnable. Records the Attributed review on the Outreach row
-- that earned it. Nothing writes these columns until the attribution worker
-- lands in the same PR; nothing reads them until the Requests route does.
--
-- FK is ON DELETE SET NULL, never CASCADE: deleting a review must not delete
-- the Outreach row that recorded a real send to a real person. The consistency
-- CHECK is one-directional on purpose — a review id requires a timestamp, rule
-- and detail, but a timestamp may outlive its review id, which is exactly what
-- SET NULL leaves behind.
--
-- attribution_detail carries NO PII: no reviewer name, no contact name. Both
-- live in their own tables, and the owner surface joins for them. A
-- denormalized reviewer name would survive the review's deletion — the
-- retention leak the Body redaction discipline exists to prevent.

ALTER TABLE solicitation_outreach
  ADD COLUMN IF NOT EXISTS attributed_review_id UUID
    REFERENCES reviews(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS attributed_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS attribution_rule   TEXT,
  ADD COLUMN IF NOT EXISTS attribution_detail JSONB;

ALTER TABLE solicitation_outreach
  DROP CONSTRAINT IF EXISTS solicitation_outreach_attribution_consistency;
ALTER TABLE solicitation_outreach
  ADD CONSTRAINT solicitation_outreach_attribution_consistency CHECK (
    attributed_review_id IS NULL
    OR (
      attributed_at IS NOT NULL
      AND attribution_rule IN ('full_name', 'first_last_initial')
      AND attribution_detail IS NOT NULL
    )
  );

-- One review attributes to at most one Outreach row. business_id leads so the
-- index is tenant-scoped and usable by the candidate scan's equality prefix.
CREATE UNIQUE INDEX IF NOT EXISTS solicitation_outreach_attributed_review_uniq
  ON solicitation_outreach (business_id, attributed_review_id)
  WHERE attributed_review_id IS NOT NULL;

-- The Attribution window scan. The partial predicate byte-matches the
-- candidate query's fixed arms in src/lib/solicitation/attribution.ts; only
-- the sent_at range is parameterized.
CREATE INDEX IF NOT EXISTS solicitation_outreach_attribution_candidates
  ON solicitation_outreach (business_id, sent_at DESC)
  WHERE delivery_status = 'sent'
    AND attributed_review_id IS NULL
    AND bounced_at IS NULL
    AND complained_at IS NULL;

COMMENT ON COLUMN solicitation_outreach.attributed_review_id IS
  'The Attributed review (#632). Shadow metric, never billed — May 6.4 M3 owns the billable bar.';
```

- [ ] **Step 2: Apply to the local test DB**

Run: `pnpm test:db:setup`
Expected: exits 0, schema at migrations head.

- [ ] **Step 3: Replace the two `.todo` shape assertions with real bodies**

```typescript
it('attribution columns, the consistency CHECK and the partial unique index exist', async () => {
  const cols = await sql<{ column_name: string; is_nullable: string }[]>`
    SELECT column_name, is_nullable FROM information_schema.columns
     WHERE table_name = 'solicitation_outreach'
       AND column_name IN ('attributed_review_id','attributed_at','attribution_rule','attribution_detail')
     ORDER BY column_name
  `;
  expect(cols.map((c) => c.column_name)).toEqual([
    'attributed_at', 'attributed_review_id', 'attribution_detail', 'attribution_rule',
  ]);
  expect(cols.every((c) => c.is_nullable === 'YES')).toBe(true);

  const [check] = await sql<{ conname: string }[]>`
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'solicitation_outreach'::regclass
       AND conname = 'solicitation_outreach_attribution_consistency'
  `;
  expect(check).toBeDefined();

  const idx = await sql<{ indexname: string }[]>`
    SELECT indexname FROM pg_indexes
     WHERE tablename = 'solicitation_outreach'
       AND indexname IN (
         'solicitation_outreach_attributed_review_uniq',
         'solicitation_outreach_attribution_candidates'
       )
     ORDER BY indexname
  `;
  expect(idx.map((i) => i.indexname)).toEqual([
    'solicitation_outreach_attributed_review_uniq',
    'solicitation_outreach_attribution_candidates',
  ]);
});
```

The second test seeds an outreach row with an attribution, deletes the review, then asserts the outreach row survives with `attributed_review_id` NULL and `attributed_at` still set.

- [ ] **Step 4: Run the shape suite**

Run: `TEST_DATABASE_POOL_URL=$TEST_DATABASE_POOL_URL pnpm vitest run --project integration src/lib/shared/__tests__/migration-114-solicitation-attribution.integration.test.ts`
Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/114_solicitation_attribution.sql \
        src/lib/shared/__tests__/migration-114-solicitation-attribution.integration.test.ts
git commit -m "feat(632): migration 114 — attribution columns on solicitation_outreach"
```

---

## Task 2: The pure matcher

**Blocked by:** Task 1. **Turns green:** the 6 `matchAttribution` tests and the 2 `invariants` property tests.

**Files:**
- Create: `src/lib/solicitation/attribution.ts`

- [ ] **Step 1: Write the module header, constants and types**

```typescript
/**
 * Review attribution (#632) — the shadow, never-billed `review_attributed`
 * outcome. Spec: 2026-07-28-send-mode-executor-approval-design.md D14/D16.
 *
 * Attribution is a LOOKBACK evaluated when a review arrives (D16b), never a
 * timer: May §6.3's `wait_for_async_signals` presumes an engine that can park
 * a step, and D17 declined to build one. The 14 days are a filter constant.
 *
 * D16d is binding: there is NO deterministic contact-to-review identity seam.
 * A Google review carries a display name and a date, nothing else. This module
 * does not claim to solve that — it abstains rather than guesses, which is why
 * map #617 decision 1 keeps the metric shadow / no-charge.
 *
 * Domain module — receives its DB client explicitly (invariant #15); it never
 * imports the singleton. Every query carries BOTH account_id and business_id
 * (invariant #8).
 */

import type { Sql, TransactionSql } from 'postgres';
import { recordOutcome } from '@/lib/agents/run-spine';
import { reviewTimeAnchor } from '@/lib/kpi/fragments';

/** The Attribution window (May §6.4, spec D16b). The ONE owner of this number. */
export const ATTRIBUTION_WINDOW_DAYS = 14;

/** How far back the owner-facing list reaches. Presentation only. */
export const ATTRIBUTION_DISPLAY_WINDOW_DAYS = 30;

/** Stamped into attribution_detail so a stored verdict stays attributable to
 *  the ruleset that produced it — the ASK_LINT_VERSION precedent. */
export const ATTRIBUTION_MATCHER_VERSION = 'attribution_v1';

/** Byte-matches migration 114's CHECK. */
export const ATTRIBUTION_RULES = ['full_name', 'first_last_initial'] as const;
export type AttributionRule = (typeof ATTRIBUTION_RULES)[number];

export interface AttributionCandidate {
  outreachId: string;
  contactName: string;
  sentAt: string;
  /** NULL when the Lazy child was never minted — columns still get written. */
  agentRunId: string | null;
}

export type AttributionMatch =
  | { resolution: 'attributed'; candidate: AttributionCandidate; rule: AttributionRule }
  | { resolution: 'no_candidates' }
  | { resolution: 'no_match'; candidateCount: number }
  | { resolution: 'ambiguous'; candidateCount: number };
```

- [ ] **Step 2: Write the normalizer and the matcher**

```typescript
/**
 * NFD, strip combining marks, lowercase, punctuation to space, collapse.
 * Follows `normalizeName` in src/lib/reviews/place-id-resolver.ts.
 */
export function normalizePersonName(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[.,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(raw: string): string[] {
  const normalized = normalizePersonName(raw);
  return normalized.length === 0 ? [] : normalized.split(' ');
}

const isInitial = (token: string): boolean => token.length === 1;

/** Equal, or one side is an initial the other side starts with. */
function compatible(a: string, b: string): boolean {
  if (a === b) return true;
  if (isInitial(a) && b.startsWith(a)) return true;
  if (isInitial(b) && a.startsWith(b)) return true;
  return false;
}

/**
 * The rule, and why each arm exists:
 *   - BOTH sides need >= 2 tokens. A bare first name is a coincidence as often
 *     as a signal, and precision is what the future M3 bar is judged on.
 *   - first AND last must be `compatible`. Middles are ignored, so
 *     "dana m rodriguez" still matches "dana rodriguez".
 *   - At least one position must be a FULL-token match. Without it,
 *     "d. rodriguez" would match "dana r." on two initials and no evidence.
 */
function ruleFor(contactName: string, reviewerName: string): AttributionRule | null {
  const a = tokens(contactName);
  const b = tokens(reviewerName);
  if (a.length < 2 || b.length < 2) return null;

  const firstA = a[0]!, lastA = a[a.length - 1]!;
  const firstB = b[0]!, lastB = b[b.length - 1]!;

  if (!compatible(firstA, firstB) || !compatible(lastA, lastB)) return null;

  const firstExact = firstA === firstB;
  const lastExact = lastA === lastB;
  if (!firstExact && !lastExact) return null;

  return firstExact && lastExact ? 'full_name' : 'first_last_initial';
}

/**
 * Pure. Two or more matches ABSTAIN (grilling decision): a shadow metric that
 * guesses is worse than one that abstains, and the abstention rate is the
 * direct input to the M3 precision question.
 */
export function matchAttribution(
  reviewerName: string | null,
  candidates: AttributionCandidate[],
): AttributionMatch {
  if (candidates.length === 0) return { resolution: 'no_candidates' };
  const candidateCount = candidates.length;
  if (reviewerName === null || normalizePersonName(reviewerName).length === 0) {
    return { resolution: 'no_match', candidateCount };
  }

  const hits: { candidate: AttributionCandidate; rule: AttributionRule }[] = [];
  for (const candidate of candidates) {
    const rule = ruleFor(candidate.contactName, reviewerName);
    if (rule !== null) hits.push({ candidate, rule });
  }

  if (hits.length === 0) return { resolution: 'no_match', candidateCount };
  if (hits.length > 1) return { resolution: 'ambiguous', candidateCount };
  return { resolution: 'attributed', candidate: hits[0]!.candidate, rule: hits[0]!.rule };
}
```

- [ ] **Step 3: Run the matcher suite**

Run: `pnpm vitest run src/lib/solicitation/__tests__/attribution.test.ts`
Expected: 8 passed.

- [ ] **Step 4: Commit**

```bash
git add src/lib/solicitation/attribution.ts
git commit -m "feat(632): pure two-rule attribution matcher with abstain-on-ambiguity"
```

---

## Task 3: Candidate query and the write transaction

**Blocked by:** Task 2. **Independent of Task 4** — may run in parallel.
**Turns green:** the 8 `attribution:` integration tests.

**Files:**
- Modify: `src/lib/solicitation/attribution.ts`
- Modify: `src/lib/solicitation/__tests__/attribution.integration.test.ts`

- [ ] **Step 1: Add the candidate query**

Append to `attribution.ts`:

```typescript
interface CandidateRow {
  outreach_id: string;
  contact_name: string;
  sent_at: string;
  agent_run_id: string | null;
}

/**
 * Candidates for one review. Every fixed arm byte-matches migration 114's
 * `solicitation_outreach_attribution_candidates` partial predicate, so the
 * index is used; only the sent_at range is parameterized.
 *
 * Why each exclusion (grilling decisions):
 *   - `delivery_status = 'sent'` — `unknown` is "possibly contacted" for
 *     over-contact purposes and explicitly NOT a confirmed send for
 *     review_attributed (spec D12d).
 *   - bounced / complained — the email never reached the person, so a
 *     same-name review cannot have been caused by it.
 *   - unsubscribed rows STAY eligible: an unsubscribe is evidence the mail was
 *     opened, and the two acts happen in either order.
 *   - already attributed — one Outreach row attributes at most one review.
 *
 * The anchor is `reviewTimeAnchor` (ADR 0019), the single owner of
 * LEAST(review_date, detected_at). A review whose anchor precedes sent_at is
 * not a candidate: it existed before the ask.
 */
async function loadCandidates(
  tx: TransactionSql,
  input: { reviewId: string; businessId: string; accountId: string },
): Promise<AttributionCandidate[]> {
  const rows = await tx<CandidateRow[]>`
    WITH anchor AS (
      SELECT ${reviewTimeAnchor(tx as unknown as Sql, 'bare')} AS at
        FROM reviews r_outer
        JOIN businesses b ON b.id = r_outer.business_id
       WHERE r_outer.id = ${input.reviewId}::uuid
         AND r_outer.business_id = ${input.businessId}::uuid
         AND b.account_id = ${input.accountId}::uuid
    )
    SELECT o.id AS outreach_id, c.name AS contact_name,
           o.sent_at, o.agent_run_id
      FROM solicitation_outreach o
      JOIN solicitation_contacts c
        ON c.id = o.contact_id AND c.business_id = o.business_id
     CROSS JOIN anchor
     WHERE o.business_id = ${input.businessId}::uuid
       AND o.account_id  = ${input.accountId}::uuid
       AND o.delivery_status = 'sent'
       AND o.attributed_review_id IS NULL
       AND o.bounced_at    IS NULL
       AND o.complained_at IS NULL
       AND o.sent_at IS NOT NULL
       AND o.sent_at <= anchor.at
       AND o.sent_at >  anchor.at - make_interval(days => ${ATTRIBUTION_WINDOW_DAYS})
     ORDER BY o.sent_at DESC
  `;
  return rows.map((row) => ({
    outreachId: row.outreach_id,
    contactName: row.contact_name,
    sentAt: row.sent_at,
    agentRunId: row.agent_run_id,
  }));
}
```

> The `reviewTimeAnchor` call takes the `'bare'` prefix form. Confirm the exact
> parameter against `src/lib/kpi/fragments.ts` before writing — that module is
> the single owner and its signature wins over this plan.

- [ ] **Step 2: Add the write transaction**

```typescript
/**
 * Resolve and record attribution for ONE newly ingested review. Runs inside
 * the caller's transaction, NEVER inside the review-ingest transaction: a
 * matcher fault must not roll back a review write (that is why #632 ships an
 * outbox topic rather than an inline call).
 *
 * Idempotent by construction. The UPDATE's `attributed_review_id IS NULL`
 * guard plus migration 114's partial unique index make a second run a no-op,
 * and `recordOutcome`'s ON CONFLICT makes the outcome emit-once.
 */
export async function attributeReview(
  tx: TransactionSql,
  input: { reviewId: string; businessId: string; accountId: string },
): Promise<AttributionMatch> {
  const candidates = await loadCandidates(tx, input);
  const [review] = await tx<{ reviewer_name: string | null; star_rating: number | null }[]>`
    SELECT reviewer_name, star_rating FROM reviews
     WHERE id = ${input.reviewId}::uuid AND business_id = ${input.businessId}::uuid
  `;
  // A missing review is a caller bug, not a replay: the enqueue happens in the
  // same transaction as the INSERT. Assert rather than branch.
  if (review === undefined) {
    throw new Error(`attributeReview: review ${input.reviewId} not found for business`);
  }

  const match = matchAttribution(review.reviewer_name, candidates);
  if (match.resolution !== 'attributed') return match;

  const detail = {
    rule: match.rule,
    matcher_version: ATTRIBUTION_MATCHER_VERSION,
    sent_at: match.candidate.sentAt,
    star_rating: review.star_rating,
    candidate_count: candidates.length,
  };

  const updated = await tx<{ id: string }[]>`
    UPDATE solicitation_outreach
       SET attributed_review_id = ${input.reviewId}::uuid,
           attributed_at        = NOW(),
           attribution_rule     = ${match.rule},
           attribution_detail   = ${tx.json(detail as never)},
           updated_at           = NOW()
     WHERE id         = ${match.candidate.outreachId}::uuid
       AND account_id = ${input.accountId}::uuid
       AND business_id = ${input.businessId}::uuid
       AND attributed_review_id IS NULL
    RETURNING id
  `;
  // Zero rows means a concurrent run already attributed it — a replay, not a
  // failure. Return the match without a second outcome.
  if (updated.count === 0) return match;

  if (match.candidate.agentRunId !== null) {
    await recordOutcome(tx, {
      runId: match.candidate.agentRunId,
      accountId: input.accountId,
      businessId: input.businessId,
      attributedAgent: 'solicitation',
      outcomeKind: 'review_attributed',
      unitCount: 1,
    });
  }
  return match;
}
```

- [ ] **Step 3: Fill in the 8 `attribution:` integration test bodies**

Seed via the existing helpers in `src/lib/solicitation/__tests__/` (follow `batch-view.integration.test.ts` for account/business/batch/contact/outreach fixtures). Assert on `attributed_review_id`, `attribution_rule` and a single `agent_outcomes` row of kind `review_attributed`. The idempotency test calls `attributeReview` twice and asserts `COUNT(*) = 1`.

- [ ] **Step 4: Run the integration suite**

Run: `TEST_DATABASE_POOL_URL=$TEST_DATABASE_POOL_URL pnpm vitest run --project integration src/lib/solicitation/__tests__/attribution.integration.test.ts -t "attribution"`
Expected: 8 passed.

- [ ] **Step 5: Commit**

```bash
git add src/lib/solicitation/attribution.ts \
        src/lib/solicitation/__tests__/attribution.integration.test.ts
git commit -m "feat(632): attribution candidate query and idempotent write transaction"
```

---

## Task 4: Topic, payload, helper and the ingest enqueue

**Blocked by:** Task 2. **Independent of Task 3** — may run in parallel.
**Turns green:** the 2 `enqueueSolicitationAttribution` tests.

**Files:**
- Modify: `src/lib/shared/queue-names.ts`
- Modify: `src/lib/shared/worker-types.ts`
- Modify: `src/lib/shared/job-outbox-helpers.ts`
- Modify: `src/lib/reviews/process-review.ts`
- Modify: `src/lib/shared/__tests__/job-outbox-helpers.test.ts`
- Modify: `src/lib/reviews/__tests__/process-review.test.ts`

- [ ] **Step 1: Add the topic**

In `src/lib/shared/queue-names.ts`, beside `SOLICITATION_VETO_NOTICE`:

```typescript
  SOLICITATION_ATTRIBUTION: 'solicitation_attribution',
```

- [ ] **Step 2: Add the payload type**

In `src/lib/shared/worker-types.ts`:

```typescript
/**
 * SolicitationAttributionPayload — emitted ONLY by
 * enqueueSolicitationAttribution, in the SAME tx as the review INSERT
 * (invariant #2). Drives the D16 attribution lookback.
 *
 * ids only. The Attribution window, the match rule and the anchor all live in
 * src/lib/solicitation/attribution.ts and are re-read at handle time, never
 * frozen onto a payload that may sit in the outbox across a deploy.
 *
 * `business_id` is the tenant proof every query is scoped by (invariant #8) —
 * a bare review UUID proves nothing.
 */
export interface SolicitationAttributionPayload extends BasePayload {
  review_id: string;
  business_id: string;
  account_id: string;
}
```

- [ ] **Step 3: Add the helper with its coarse eligibility guard**

In `src/lib/shared/job-outbox-helpers.ts`, following `enqueueSolicitationVetoNotice`:

```typescript
export interface EnqueueSolicitationAttributionInput {
  reviewId: string;
  businessId: string;
  accountId: string;
  /**
   * The Attribution window in days. Supplied by the caller, NOT spelled here:
   * `ATTRIBUTION_WINDOW_DAYS` in src/lib/solicitation/attribution.ts is its one
   * owner, and this file may not import a domain module.
   */
  eligibilityWindowDays: number;
  correlationId?: string;
  outboxId?: string;
}

/**
 * Enqueue the #632 attribution lookback for ONE newly ingested review.
 *
 * The `WHERE EXISTS` guard is a deliberately COARSER SUPERSET of the matcher's
 * candidate predicate — it drops the anchor comparison and the bounce and
 * complaint arms. Any real candidate satisfies it, so it can never drop a
 * match; it only skips businesses that have never sent an ask, which is every
 * business while SOLICITATION_SEND_ENABLED is off. Over-enqueueing is harmless:
 * the handler resolves `no_candidates` and exits. Do NOT tighten it into a
 * second copy of the candidate query — that would give one fact two owners.
 */
export async function enqueueSolicitationAttribution(
  tx: TxClient,
  input: EnqueueSolicitationAttributionInput,
): Promise<string | null> {
  const outboxId = input.outboxId ?? uuidv7();
  const payload: SolicitationAttributionPayload = {
    review_id: input.reviewId,
    business_id: input.businessId,
    account_id: input.accountId,
  };
  if (input.correlationId !== undefined) {
    payload.correlation_id = input.correlationId;
  }

  const inserted = await tx<{ id: string }[]>`
    INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
    SELECT
      ${outboxId},
      ${QUEUE_NAMES.SOLICITATION_ATTRIBUTION},
      ${AGGREGATE_TYPE_REVIEW},
      ${input.reviewId},
      ${tx.json(payload as never)},
      ${JOB_OUTBOX_STATUS_PENDING}
    WHERE EXISTS (
      SELECT 1 FROM solicitation_outreach o
       WHERE o.business_id = ${input.businessId}
         AND o.delivery_status = 'sent'
         AND o.attributed_review_id IS NULL
         AND o.sent_at > NOW() - make_interval(days => ${input.eligibilityWindowDays})
    )
    ON CONFLICT (topic, aggregate_id)
    WHERE topic = 'solicitation_attribution' -- topic-audit-ignore: partial-index inference needs a literal
      AND status IN ('pending', 'dispatching', 'dispatched')
    DO NOTHING
    RETURNING id
  `;
  return inserted.count === 0 ? null : outboxId;
}
```

> The `ON CONFLICT` partial-index target must exist. Check
> `.claude/reference/migrations-log.md` for the `job_outbox` in-flight index
> convention. If no per-topic partial unique index covers
> `solicitation_attribution`, add it to migration 114 in this task and re-run
> `pnpm test:db:setup`. Re-spell the status set BY HAND — it is a byte-for-byte
> contract owned by `src/lib/shared/job-outbox-status.ts` and `ci:outbox-status`
> checks members AND order.

- [ ] **Step 4: Call it from the live ingest transaction**

In `src/lib/reviews/process-review.ts`, inside the existing `sql.begin`, immediately after the new-review spine step:

```typescript
      // #632: the attribution lookback. Enqueued in THIS transaction
      // (invariant #2), handled on the worker — a matcher fault must never
      // roll back a review write. The helper's guard means no row is written
      // for a business that has never sent an ask.
      await enqueueSolicitationAttribution(tx, {
        reviewId,
        businessId,
        accountId: biz.account_id,
        eligibilityWindowDays: ATTRIBUTION_WINDOW_DAYS,
        correlationId,
      });
```

Placed on the NEW-review path only. The update, unchanged and status-only paths get no enqueue — a review that already existed was never caused by an ask sent after it.

- [ ] **Step 5: Fill in the two enqueue test bodies and run**

Run: `TEST_DATABASE_POOL_URL=$TEST_DATABASE_POOL_URL pnpm vitest run --project integration -t "enqueueSolicitationAttribution"`
Expected: 2 passed.

- [ ] **Step 6: Run the outbox audits**

Run: `pnpm ci:outbox-seam && pnpm ci:outbox-status && pnpm ci:topic-audit`
Expected: all exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/lib/shared/queue-names.ts src/lib/shared/worker-types.ts \
        src/lib/shared/job-outbox-helpers.ts src/lib/reviews/process-review.ts \
        src/lib/shared/__tests__/job-outbox-helpers.test.ts \
        src/lib/reviews/__tests__/process-review.test.ts
git commit -m "feat(632): solicitation_attribution topic, guarded helper, ingest enqueue"
```

---

## Task 5: The worker

**Blocked by:** Task 3 and Task 4.

**Files:**
- Create: `worker/jobs/solicitation-attribution/SolicitationAttributionWorker.ts`
- Modify: `worker/queues.ts`
- Modify: `worker/index.ts`

- [ ] **Step 1: Write the handler**

```typescript
// worker/jobs/solicitation-attribution/SolicitationAttributionWorker.ts
//
// Handles the #632 attribution lookback. Entry point — orchestrates only
// (invariant #12): open the transaction, call attributeReview, log the
// resolution. Every rule lives in src/lib/solicitation/attribution.ts.
//
// No `'failed'` exhaustion hook by design: attribution is a shadow metric with
// no downstream consumer, so an exhausted job costs one uncounted review and
// nothing else. The shared job-failure sink still raises the Sentry issue on
// the terminal attempt.

import type { Job } from 'bullmq';
import type { Sql } from 'postgres';
import { attributeReview } from '../../../src/lib/solicitation/attribution';
import { createWorkerLogger } from '../../../src/lib/shared/logger';
import type { SolicitationAttributionPayload } from '../../../src/lib/shared/worker-types';

const logger = createWorkerLogger('solicitation-attribution');

export async function handleSolicitationAttribution(
  sql: Sql,
  job: Job<SolicitationAttributionPayload>,
): Promise<void> {
  const { review_id: reviewId, business_id: businessId, account_id: accountId } = job.data;

  const match = await sql.begin((tx) =>
    attributeReview(tx, { reviewId, businessId, accountId }),
  );

  // The ONE observability signal for this feature. `resolution` is a closed
  // set; a rising `ambiguous` rate is the evidence that the name rule is too
  // loose, and it is the direct input to May 6.4's M3 precision bar. NEVER
  // log the reviewer name or the review text.
  logger.log('attribution_resolved', {
    reviewId,
    businessId,
    resolution: match.resolution,
    candidateCount: match.resolution === 'no_candidates' ? 0 : match.candidateCount ?? 1,
    rule: match.resolution === 'attributed' ? match.rule : null,
  });
}
```

> `match.candidateCount` is absent on the `attributed` arm. Narrow the union
> explicitly rather than reaching for `??` on a property TypeScript cannot see —
> fix the expression to a `switch` on `match.resolution` if the compiler
> complains. No `any`.

- [ ] **Step 2: Register the queue**

In `worker/queues.ts`, beside `solicitationVetoNotice`:

```typescript
  solicitationAttribution: new Queue(QUEUE_NAMES.SOLICITATION_ATTRIBUTION, { connection: opts, defaultJobOptions }),
```

and in the topic map:

```typescript
  [QUEUE_NAMES.SOLICITATION_ATTRIBUTION]: queues.solicitationAttribution,
```

- [ ] **Step 3: Register the worker**

In `worker/index.ts`, beside `solicitationVetoNoticeWorker`:

```typescript
// #632 attribution lookback. No `'failed'` exhaustion hook by design — see the
// worker file's header.
const solicitationAttributionWorker = new Worker(
  QUEUE_NAMES.SOLICITATION_ATTRIBUTION,
  withJobLogContext<SolicitationAttributionPayload>((job) => handleSolicitationAttribution(sql, job)),
  workerOpts,
);
```

and in the worker map:

```typescript
  [QUEUE_NAMES.SOLICITATION_ATTRIBUTION]: solicitationAttributionWorker,
```

- [ ] **Step 4: Typecheck and run the worker-facing audits**

Run: `pnpm typecheck && pnpm ci:db-imports && pnpm ci:static-policy`
Expected: all exit 0. `ci:db-imports` must stay green — `attribution.ts` takes `tx` explicitly and imports no singleton; `worker/index.ts` is a composition root and may.

- [ ] **Step 5: Commit**

```bash
git add worker/jobs/solicitation-attribution/ worker/queues.ts worker/index.ts
git commit -m "feat(632): SolicitationAttributionWorker and registration"
```

---

## Task 6: Read model and owner route

**Blocked by:** Task 5. **Turns green:** the 3 `listAttributedReviews` tests and the route test.

**Files:**
- Modify: `src/lib/solicitation/attribution.ts`
- Create: `src/app/api/dashboard/solicitation/attributed/route.ts`
- Modify: `src/lib/solicitation/__tests__/attribution.integration.test.ts`
- Modify: `src/app/api/dashboard/solicitation/attributed/__tests__/route.test.ts`

- [ ] **Step 1: Add the read model**

```typescript
export interface AttributedReviewView {
  outreachId: string;
  reviewId: string;
  reviewerName: string | null;
  starRating: number | null;
  reviewDate: string | null;
  askSentAt: string;
  attributedAt: string;
  rule: AttributionRule;
}

/**
 * Every Attributed review for one location in the display window, newest
 * first. Deliberately NOT part of BatchView: that contract is "the most recent
 * batch", and attribution lands up to 14 days after a send, by which time a
 * newer batch usually exists. A per-batch surface would hide the common case.
 *
 * `sendEnabled` is passed IN, never read here (invariant #13) — the same shape
 * readLatestBatch uses for its send lane.
 *
 * Rows whose review has since been deleted drop out: migration 114's FK sets
 * attributed_review_id to NULL, and the INNER JOIN then excludes them.
 */
export async function listAttributedReviews(
  sql: Sql,
  input: { accountId: string; businessId: string; sendEnabled: boolean },
): Promise<AttributedReviewView[]> {
  if (!input.sendEnabled) return [];

  const rows = await sql<{
    outreach_id: string; review_id: string; reviewer_name: string | null;
    star_rating: number | null; review_date: string | null;
    ask_sent_at: string; attributed_at: string; attribution_rule: AttributionRule;
  }[]>`
    SELECT o.id AS outreach_id, r.id AS review_id, r.reviewer_name,
           r.star_rating, r.review_date,
           o.sent_at AS ask_sent_at, o.attributed_at, o.attribution_rule
      FROM solicitation_outreach o
      JOIN reviews r ON r.id = o.attributed_review_id
     WHERE o.account_id  = ${input.accountId}::uuid
       AND o.business_id = ${input.businessId}::uuid
       AND o.attributed_review_id IS NOT NULL
       AND o.attributed_at > NOW() - make_interval(days => ${ATTRIBUTION_DISPLAY_WINDOW_DAYS})
     ORDER BY o.attributed_at DESC
  `;
  return rows.map((row) => ({
    outreachId: row.outreach_id,
    reviewId: row.review_id,
    reviewerName: row.reviewer_name,
    starRating: row.star_rating,
    reviewDate: row.review_date,
    askSentAt: row.ask_sent_at,
    attributedAt: row.attributed_at,
    rule: row.attribution_rule,
  }));
}
```

- [ ] **Step 2: Write the route**

Mirror `src/app/api/dashboard/solicitation/batch/route.ts` exactly — watch flag gate first, `withDashboardOwnerRead`, `requireContactsLocationScope`.

```typescript
// GET /api/dashboard/solicitation/attributed — every Attributed review for one
// location in the display window (#632). Route orchestrates only: flag gates,
// owner auth, location resolution; the tenant-scoped read lives in
// src/lib/solicitation/attribution.ts.
//
// Deliberately NOT folded into ./batch: that GET is polled every 2s while a
// batch builds, and attribution spans batches. A separate route keeps a slow
// attribution read off the poll and keeps BatchView's "most recent batch"
// contract intact.
//
// Response carries `enabled` explicitly (invariant #13): the browser learns
// the send-flag state from the response, and an empty list under `enabled:true`
// is a genuine empty state rather than a hidden flag.
```

Return `jsonResponse({ enabled: solicitationSendEnabled(), attributed })`.

- [ ] **Step 3: Fill in the three read tests and the route test, then run**

Run: `TEST_DATABASE_POOL_URL=$TEST_DATABASE_POOL_URL pnpm vitest run --project integration -t "listAttributedReviews"` then `pnpm vitest run src/app/api/dashboard/solicitation/attributed`
Expected: all pass.

- [ ] **Step 4: Run the scope audits**

Run: `pnpm ci:tenant-scope && pnpm ci:rls-audit`
Expected: both exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/lib/solicitation/attribution.ts \
        src/app/api/dashboard/solicitation/attributed/ \
        src/lib/solicitation/__tests__/attribution.integration.test.ts
git commit -m "feat(632): listAttributedReviews read model and owner route"
```

---

## Task 7: The owner surface

**Blocked by:** Task 6. **Turns green:** the 3 `AttributedReviews` tests.

**Files:**
- Create: `src/app/(authenticated)/dashboard/requests/AttributedReviews.tsx`
- Modify: `src/app/(authenticated)/dashboard/requests/RequestsClient.tsx`
- Modify: `src/app/(authenticated)/dashboard/requests/requests.css`
- Modify: `src/app/(authenticated)/dashboard/requests/__tests__/attributed-reviews.test.tsx`

> **Invoke the `repworth-brand-design` skill before writing the component.**
> `/dashboard/requests` is a Console-system surface; read that system's Style
> Reference for tokens and layout before finalizing.

- [ ] **Step 1: Write the component**

Follow `BatchReport.tsx` for structure, heading level, empty-state shape and copy voice. Required content, from `user_visible_behavior`:

- Heading: `Reviews from your requests`, with the window stated (`last 30 days`).
- One row per match: reviewer name, star rating, review date, and the ask's sent date.
- A disclosure line stating the count is a shadow metric and is never billed.
- An empty state when the list is empty.
- Renders nothing at all when `enabled` is false.

A one-star match renders identically to a five-star one — no filtering, no separate group. That is the locked sentiment-blind decision (ADR 0012's reasoning).

- [ ] **Step 2: Mount it in RequestsClient**

Add a `const ATTRIBUTED_PATH = '/api/dashboard/solicitation/attributed';` beside `BATCH_PATH`, fetch it with the existing `withSolicitationScope(...)` + `signal` shape, and render `<AttributedReviews … />` below the batch report. Do NOT add it to the 2-second build poll.

- [ ] **Step 3: Fill in the three UI tests and run**

Run: `pnpm vitest run src/app/\(authenticated\)/dashboard/requests/__tests__/attributed-reviews.test.tsx`
Expected: 3 passed.

- [ ] **Step 4: Build and run the React check**

Run: `pnpm build` then the `react-doctor` skill.
Expected: build succeeds; React Doctor 100/100 (SURFACE includes ui).

- [ ] **Step 5: Commit**

```bash
git add src/app/\(authenticated\)/dashboard/requests/
git commit -m "feat(632): Reviews-from-your-requests section on the Requests surface"
```

---

## Task 8: Docs and glossary sweep

**Blocked by:** Task 7.

**Files:**
- Modify: `CONTEXT.md`
- Modify: `docs/directory.md`
- Modify: `.claude/reference/migrations-log.md`

- [ ] **Step 1: Coin the terms in CONTEXT.md**

Append to the `## Solicitation (send-mode)` section, in the house format (bold term, definition, `_Avoid_:` line, `*(coined in #632)*`):

- **Attribution window** — the 14 days after `sent_at` inside which a newly ingested review may attribute to an Outreach row. A filter constant evaluated at ingest, never a timer or a parked step (spec D16b). One owner: `ATTRIBUTION_WINDOW_DAYS`. _Avoid_: attribution timer, attribution wait.
- **Attributed review** — a review recorded against exactly one Outreach row by the name matcher. Shadow and never billed until May §6.4's M3 bar clears. _Avoid_: won review, earned review, converted review.
- **Attribution match** — the two-rule name test (`full_name`, `first_last_initial`). Requires two tokens on both sides and one full-token match. _Avoid_: fuzzy match, name score.
- **Ambiguous attribution** — two or more Outreach rows matching one review. Attributes nothing and records the abstention. Its rate is the direct input to the M3 precision bar. _Avoid_: unresolved match, tie.

- [ ] **Step 2: Add the `docs/directory.md` rows**

One row per new production file under `worker/` and `src/lib/` — `ci:directory-map` fails on a production file with no row:

- `src/lib/solicitation/attribution.ts`
- `worker/jobs/solicitation-attribution/SolicitationAttributionWorker.ts`

- [ ] **Step 3: Record migration 114 in the log**

Add the 114 entry and move `Current head` to **114**, next migration **115**.

- [ ] **Step 4: Run the docs audits**

Run: `pnpm ci:directory-map && pnpm vitest run src/__tests__/claude-md-shape.test.ts`
Expected: both exit 0.

- [ ] **Step 5: Commit**

```bash
git add CONTEXT.md docs/directory.md .claude/reference/migrations-log.md
git commit -m "docs(632): attribution glossary terms, directory rows, migration 114 log"
```

---

## Out-of-band, owner-owned (not a task)

Map #617's migration-queue line must record that **#632 is migration-bearing (114)**. That map lives on the issue tracker, not in this repo, and its own rule says the session that discovers it updates it. Done in the orchestrating session at ship time, not by a subagent.

## Follow-ups to file, deliberately not in this PR

1. **`already_reviewed` wiring** — `batch-builder.ts:366` keeps `matchedReview: null`. The matcher this PR builds is what that pre-send gate has been waiting for, but promoting a heuristic from no-charge shadow to a gate that suppresses real sends needs its own grilling and its own risk review.
2. **The mirror-rule narrowing**, if the owner prefers the literal `first tokens equal` reading — one line in `compatible`, one test.
