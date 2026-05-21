# Prompt 20a Review Findings — Fix Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Address 5 validated findings from the Prompt 20a post-implementation review — broken approval/publish correlation chain, dispatching-race in 9 dedupe guards + 1 migration index, PII in correlation-tagged logs, test coverage gaps, and missing expression index on `correlation_id`.

**Architecture:** Four code changes + one migration. The correlation-chain fix reads the upstream correlation ID from the outbox in the approval API routes before calling the service (pragmatic, no service signature change). The dispatching-race fix is a mechanical SQL guard update across 9 sites + a migration rebuild of index `idx_jo_sync_reviews_inflight`. PII fixes replace email addresses in log calls with non-PII identifiers. Tests cover correlation propagation at both service and API layers plus the PlaceIdValidation chain. Finally, a migration adds an expression index so `payload->>'correlation_id'` queries stay fast at launch volume.

**Tech Stack:** TypeScript, Postgres.js, Vitest. One SQL migration (017). No new dependencies.

**Finding source:** User validation of Prompt 20a implementation — conversation context, 2026-04-17.

---

## File Structure

### New Files
| File | Responsibility |
|------|---------------|
| `supabase/migrations/017_correlation_and_dispatching_indexes.sql` | Rebuild sync_reviews unique index to include 'dispatching', add correlation_id expression index |
| `worker/__tests__/PlaceIdValidationWorker.test.ts` | Test correlation_id propagation from validate_place_id → sync_reviews |

### Modified Files
| File | Change |
|------|--------|
| `src/app/api/approve/[token]/approve/route.ts` | Read upstream correlation_id before calling `approve()` |
| `src/app/api/approve/[token]/edit/route.ts` | Read upstream correlation_id before calling `edit()` |
| `src/app/api/approve/[token]/regenerate/route.ts` | Read upstream correlation_id before calling `regenerate()` |
| `src/app/api/dashboard/reviews/[reviewId]/approve/route.ts` | Read upstream correlation_id before calling `approveBySession()` |
| `src/app/api/dashboard/reviews/[reviewId]/edit/route.ts` | Read upstream correlation_id before calling `editBySession()` |
| `src/app/api/dashboard/reviews/[reviewId]/regenerate/route.ts` | Read upstream correlation_id before calling `regenerateBySession()` |
| `worker/jobs/ReconciliationPoller.ts:65` | Add 'dispatching' to in-flight status check |
| `worker/jobs/PlaceIdValidationWorker.ts:120` | Add 'dispatching' to in-flight status check |
| `worker/jobs/WeeklySummaryScheduler.ts:83` | Add 'dispatching' to in-flight status check |
| `worker/jobs/MonthlyImpactScheduler.ts:63` | Add 'dispatching' to in-flight status check |
| `worker/jobs/RankingTrackingScheduler.ts:68` | Add 'dispatching' to in-flight status check |
| `worker/jobs/NotificationFailoverPoller.ts:59,115,147,173` | Add 'dispatching' to 4 in-flight status checks |
| `worker/jobs/NotificationWorker.ts:173` | Remove owner_email from log message |
| `worker/jobs/EngagementAlertWorker.ts:181` | Remove owner_email from log message |
| `worker/jobs/OnboardingDripWorker.ts:157` | Remove owner_email and business name from log message |
| `worker/jobs/ResponsePublisherWorker.ts:207-209` | Remove adminEmail from log message |
| `src/lib/approval/__tests__/service.test.ts` | Add assertions that correlation_id flows into outbox payloads |
| `src/app/api/dashboard/reviews/__tests__/actions.test.ts` | Add assertion that correlationId arg is passed to service methods |

---

## Task 1: Migration 017 — Correlation Index + Sync Reviews Dedup Rebuild

Addresses Finding 5 (expression index) and part of Finding 2 (sync_reviews unique index gap).

**Files:**
- Create: `supabase/migrations/017_correlation_and_dispatching_indexes.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Migration 017: Sprint 6 Prompt 20a review fixes
--
-- 1. Expression index on correlation_id for fast operational queries.
--    The runbook SQL `SELECT * FROM job_outbox WHERE payload->>'correlation_id' = '<id>'`
--    would scan the whole table without this index at launch volume.
--
-- 2. Rebuild idx_jo_sync_reviews_inflight to include the transient 'dispatching' status.
--    The original migration 004 predates the claim-ownership refactor in OutboxPoller that
--    introduced 'dispatching'. Without this fix, a concurrent INSERT during the
--    pending→dispatching claim window can succeed and create a duplicate in-flight job.

-- ─── Expression index on correlation_id ───────────────────────────────────
-- Partial index: only payloads that actually carry correlation_id pay the cost.
-- Backward compat: outbox rows inserted before Prompt 20a have no correlation_id
-- field; they are excluded from the index via the `payload ? 'correlation_id'` guard.
CREATE INDEX IF NOT EXISTS idx_jo_correlation_id
  ON job_outbox ((payload->>'correlation_id'))
  WHERE payload ? 'correlation_id';

-- ─── Rebuild sync_reviews in-flight unique index to cover 'dispatching' ──
-- CONCURRENTLY not used here because this runs at service startup; the table is
-- small at launch volume and brief locks are acceptable. If run against a large
-- production table later, rewrite as CONCURRENTLY outside a transaction block.
DROP INDEX IF EXISTS idx_jo_sync_reviews_inflight;

CREATE UNIQUE INDEX idx_jo_sync_reviews_inflight
  ON job_outbox (topic, aggregate_id)
  WHERE topic = 'sync_reviews'
    AND status IN ('pending', 'dispatching', 'dispatched');
```

- [ ] **Step 2: Apply the migration**

Run: via Supabase SQL editor, or `pnpm supabase db push` if CLI is configured.

Verify:
```sql
SELECT indexname FROM pg_indexes WHERE tablename = 'job_outbox' AND indexname IN ('idx_jo_correlation_id', 'idx_jo_sync_reviews_inflight');
```
Expected: 2 rows.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/017_correlation_and_dispatching_indexes.sql
git commit -m "chore: migration 017 — correlation expression index + sync_reviews inflight rebuild"
```

---

## Task 2: Fix Dispatching-Race in 9 Producer Dedupe Guards

Addresses Finding 2 (code side). The migration fix in Task 1 covers sync_reviews uniqueness; this task makes every producer's SELECT-NOT-EXISTS check consistent with the new migration and with other in-flight guards that already include `'dispatching'` (migrations 011, 016).

**Files:**
- Modify: `worker/jobs/ReconciliationPoller.ts:65`
- Modify: `worker/jobs/PlaceIdValidationWorker.ts:120`
- Modify: `worker/jobs/WeeklySummaryScheduler.ts:83`
- Modify: `worker/jobs/MonthlyImpactScheduler.ts:63`
- Modify: `worker/jobs/RankingTrackingScheduler.ts:68`
- Modify: `worker/jobs/NotificationFailoverPoller.ts:59,115,147,173`

The transformation is identical in every site:

**Before:**
```typescript
              AND jo.status IN ('pending', 'dispatched')
```

**After:**
```typescript
              AND jo.status IN ('pending', 'dispatching', 'dispatched')
```

- [ ] **Step 1: Update ReconciliationPoller.ts line 65**

Find the block starting at line 61:
```typescript
          WHERE NOT EXISTS (
            SELECT 1 FROM job_outbox jo
            WHERE jo.topic = 'sync_reviews'
              AND jo.aggregate_id = ${biz.id}
              AND jo.status IN ('pending', 'dispatched')
          )
```

Change the last line to:
```typescript
              AND jo.status IN ('pending', 'dispatching', 'dispatched')
```

- [ ] **Step 2: Update PlaceIdValidationWorker.ts line 120**

Find the block at line 116-121:
```typescript
    WHERE NOT EXISTS (
      SELECT 1 FROM job_outbox jo
      WHERE jo.topic = 'sync_reviews'
        AND jo.aggregate_id = ${businessId}
        AND jo.status IN ('pending', 'dispatched')
    )
```

Change to:
```typescript
        AND jo.status IN ('pending', 'dispatching', 'dispatched')
```

- [ ] **Step 3: Update WeeklySummaryScheduler.ts line 83**

Use Grep/Read to find the exact `status IN ('pending', 'dispatched')` line at ~83 and change to `('pending', 'dispatching', 'dispatched')`.

- [ ] **Step 4: Update MonthlyImpactScheduler.ts line 63**

Same transformation.

- [ ] **Step 5: Update RankingTrackingScheduler.ts line 68**

Same transformation.

- [ ] **Step 6: Update NotificationFailoverPoller.ts — 4 sites**

This file has FOUR occurrences at lines 59, 115, 147, 173. Each line is:
```typescript
              AND jo.status IN ('pending', 'dispatched')
```

Change all 4 to:
```typescript
              AND jo.status IN ('pending', 'dispatching', 'dispatched')
```

Use `replace_all` with unique context, or do each individually with Read-then-Edit.

- [ ] **Step 7: Verify no remaining buggy occurrences**

Run: `rg -n "status IN \('pending', 'dispatched'\)" src worker --type ts`
Expected: Zero matches in production code. Test files may retain the old pattern in fixtures — that's acceptable but worth grepping with `--glob "!*test*"` to be sure.

- [ ] **Step 8: Run tests**

Run: `pnpm test`
Expected: All 576 tests pass. None of these changes affect test mocks.

- [ ] **Step 9: Commit**

```bash
git add worker/jobs/ReconciliationPoller.ts worker/jobs/PlaceIdValidationWorker.ts worker/jobs/WeeklySummaryScheduler.ts worker/jobs/MonthlyImpactScheduler.ts worker/jobs/RankingTrackingScheduler.ts worker/jobs/NotificationFailoverPoller.ts
git commit -m "fix: include 'dispatching' in all outbox in-flight dedupe guards"
```

---

## Task 3: Preserve Upstream Correlation ID in Approval Chain

Addresses Finding 1. The approval API routes currently pass `link.response_id` (token flow) or `response.id` (session flow) as the correlation ID for the `publish_response` or `generate_response` outbox entry. This breaks the "one query traces full chain" goal because the original sync→generate→notify chain used a different correlation ID.

**Approach:** Before calling the service method, query the most recent `job_outbox` row for this response/review to recover the upstream correlation ID. Fall back to `response_id` only if no prior correlation exists (e.g., for legacy responses created before Prompt 20a).

**Why this approach:** Keeps the `ApprovalService` signatures stable, isolates the recovery logic in the API routes where per-request IO is expected, and uses the new `idx_jo_correlation_id` + existing `idx_jo_topic` indexes for a fast lookup.

**Files:**
- Modify: `src/app/api/approve/[token]/approve/route.ts`
- Modify: `src/app/api/approve/[token]/edit/route.ts`
- Modify: `src/app/api/approve/[token]/regenerate/route.ts`
- Modify: `src/app/api/dashboard/reviews/[reviewId]/approve/route.ts`
- Modify: `src/app/api/dashboard/reviews/[reviewId]/edit/route.ts`
- Modify: `src/app/api/dashboard/reviews/[reviewId]/regenerate/route.ts`
- Create: helper module `src/lib/approval/correlation.ts`

- [ ] **Step 1: Write tests for the correlation recovery helper**

```typescript
// src/lib/approval/__tests__/correlation.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { recoverCorrelationId } from '../correlation';

type TaggedTemplate = ((strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>) & {
  mock: { calls: unknown[][] };
};

function createMockTx(results: unknown[][]): TaggedTemplate {
  let i = 0;
  const fn = vi.fn(async () => {
    const row = results[i++] ?? [];
    return row;
  }) as unknown as TaggedTemplate;
  return fn;
}

describe('recoverCorrelationId', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the correlation_id from the most recent generate_response outbox row for the review', async () => {
    const tx = createMockTx([[{ correlation_id: 'upstream-abc' }]]);
    const result = await recoverCorrelationId(tx, { reviewId: 'rev-1', responseId: 'resp-1' });
    expect(result).toBe('upstream-abc');
  });

  it('falls back to responseId when no upstream outbox row exists', async () => {
    const tx = createMockTx([[]]);
    const result = await recoverCorrelationId(tx, { reviewId: 'rev-1', responseId: 'resp-1' });
    expect(result).toBe('resp-1');
  });

  it('falls back to responseId when the upstream row has no correlation_id (pre-20a data)', async () => {
    const tx = createMockTx([[{ correlation_id: null }]]);
    const result = await recoverCorrelationId(tx, { reviewId: 'rev-1', responseId: 'resp-1' });
    expect(result).toBe('resp-1');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- src/lib/approval/__tests__/correlation.test.ts`
Expected: FAIL — module `../correlation` not found.

- [ ] **Step 3: Implement the helper**

```typescript
// src/lib/approval/correlation.ts
import type postgres from 'postgres';

type TxClient = postgres.TransactionSql;

interface RecoveryInput {
  reviewId: string;
  responseId: string;
}

/**
 * Recover the upstream correlation_id for an approval action.
 *
 * Chain: sync_reviews → generate_response → send_notification → publish_response.
 * When the owner approves, publish_response should carry the SAME correlation_id
 * that the original sync_reviews generated, not a new one derived from response_id.
 *
 * Lookup strategy:
 *  1. Query the most recent generate_response outbox row for this review.
 *     (generate_response is the first hop that references the review_id as aggregate_id,
 *      so it's the canonical anchor for chain correlation.)
 *  2. If that row has a non-null correlation_id, return it.
 *  3. Otherwise fall back to responseId — a stable identifier that at least makes
 *     the publish hop traceable from the response, even if pre-20a data broke the chain.
 *
 * Uses idx_jo_topic (topic, status) for aggregate_id lookup, plus the new
 * idx_jo_correlation_id for payload field extraction.
 */
export async function recoverCorrelationId(
  tx: TxClient,
  input: RecoveryInput,
): Promise<string> {
  const rows = await tx<{ correlation_id: string | null }[]>`
    SELECT payload->>'correlation_id' AS correlation_id
    FROM job_outbox
    WHERE topic = 'generate_response'
      AND aggregate_id = ${input.reviewId}
    ORDER BY created_at DESC
    LIMIT 1
  `;

  const upstream = rows[0]?.correlation_id;
  return upstream ?? input.responseId;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- src/lib/approval/__tests__/correlation.test.ts`
Expected: 3 tests PASS.

- [ ] **Step 5: Update token-based approve route to recover correlation**

In `src/app/api/approve/[token]/approve/route.ts`, the current code (around line 38-42):

```typescript
    await sql.begin(async (tx) => {
      const link = await lockValidLink(tx, rawToken);
      const audit: AuditContext = { tokenHash: link.token_hash, deviceCookieHash, ipAddress: ip };
      await approve(tx, link, deviceCookieHash, audit, link.response_id);
    });
```

Change to:

```typescript
    await sql.begin(async (tx) => {
      const link = await lockValidLink(tx, rawToken);
      const audit: AuditContext = { tokenHash: link.token_hash, deviceCookieHash, ipAddress: ip };
      const [response] = await tx<{ review_id: string }[]>`
        SELECT review_id FROM responses WHERE id = ${link.response_id}
      `;
      const correlationId = response
        ? await recoverCorrelationId(tx, { reviewId: response.review_id, responseId: link.response_id })
        : link.response_id;
      await approve(tx, link, deviceCookieHash, audit, correlationId);
    });
```

Add the import at the top of the file:
```typescript
import { recoverCorrelationId } from '@/lib/approval/correlation';
```

- [ ] **Step 6: Update token-based edit route**

Apply the same pattern to `src/app/api/approve/[token]/edit/route.ts`. The current call at line 59:
```typescript
      await edit(tx, link, editedText.trim(), deviceCookieHash, audit, link.response_id);
```

Replace with the same correlation recovery block, using `correlationId` as the last argument.

- [ ] **Step 7: Update token-based regenerate route**

Apply the same pattern to `src/app/api/approve/[token]/regenerate/route.ts` line 41:
```typescript
      await regenerate(tx, link, deviceCookieHash, audit, link.response_id);
```

Replace with the same correlation recovery block.

- [ ] **Step 8: Update session-based dashboard approve route**

In `src/app/api/dashboard/reviews/[reviewId]/approve/route.ts`, the current call at line 53:
```typescript
      await approveBySession(tx, response.id as string, user.businessId!, audit, response.id as string);
```

The dashboard routes already have `response.id` from the lookup. Use the `reviewId` param directly — it's already in scope from the route params. Change to:
```typescript
      const correlationId = await recoverCorrelationId(tx, {
        reviewId: reviewId,
        responseId: response.id as string,
      });
      await approveBySession(tx, response.id as string, user.businessId!, audit, correlationId);
```

Add the import:
```typescript
import { recoverCorrelationId } from '@/lib/approval/correlation';
```

- [ ] **Step 9: Update session-based dashboard edit route**

Apply the same pattern to `src/app/api/dashboard/reviews/[reviewId]/edit/route.ts` line 71.

- [ ] **Step 10: Update session-based dashboard regenerate route**

Apply the same pattern to `src/app/api/dashboard/reviews/[reviewId]/regenerate/route.ts` line 51.

- [ ] **Step 11: Run tests**

Run: `pnpm test`
Expected: All existing tests pass. The dashboard approval route tests may need updating — they mock `sql` and expect specific call counts. Verify by reading the tests and adjusting mock return sequences if needed (the test file `src/app/api/dashboard/reviews/__tests__/actions.test.ts` uses a queue-based SQL mock and will need one additional returned row for the correlation recovery SELECT).

- [ ] **Step 12: Update dashboard test fixtures**

In `src/app/api/dashboard/reviews/__tests__/actions.test.ts`, any test that exercises a happy-path dashboard approval/edit/regenerate must provide an additional SQL result for the `recoverCorrelationId` lookup inside `sql.begin()`. Locate the test beforeEach or per-test setup and append an extra row to the mock queue. Example:

For a successful approve test, after the initial `setResponseLookup([{ id: RESPONSE_ID, ... }])`, push an additional result for the correlation recovery query INSIDE the transaction:
```typescript
mockSqlResults.push([{ correlation_id: 'upstream-corr-abc' }]);
```

Do this for each test that currently passes through `sql.begin()` to the approval service. Tests that assert on error paths (404, 403, invalid body) don't hit this code path and need no changes.

- [ ] **Step 13: Commit**

```bash
git add src/lib/approval/correlation.ts src/lib/approval/__tests__/correlation.test.ts src/app/api/approve/ src/app/api/dashboard/reviews/
git commit -m "fix(20a): preserve upstream correlation ID across approval/publish chain"
```

---

## Task 4: Remove PII from Correlation-Tagged Logs

Addresses Finding 3. Four worker log lines currently include full email addresses in operational logs. Now that those logs are tagged with correlation IDs, they're searchable and amplify PII exposure.

**Files:**
- Modify: `worker/jobs/NotificationWorker.ts:173`
- Modify: `worker/jobs/EngagementAlertWorker.ts:181`
- Modify: `worker/jobs/OnboardingDripWorker.ts:157`
- Modify: `worker/jobs/ResponsePublisherWorker.ts:207-209`

**Replacement strategy:** Log `business_id`, `response_id`, `template`, and counts — everything operational — but NOT the email address. Recipient info lives in `notification_deliveries` rows keyed by `external_message_id`, which is the right place to look up the actual address when needed.

- [ ] **Step 1: Update NotificationWorker.ts line 173**

Current (line 173):
```typescript
  logger.log(`Approval email sent for response ${response_id} to ${business.owner_email}`);
```

Change to:
```typescript
  logger.log(`Approval email sent for response ${response_id} (business ${business_id})`);
```

- [ ] **Step 2: Update EngagementAlertWorker.ts line 181**

Current (line 181):
```typescript
  logger.log(`Owner nudge sent to ${business.owner_email} (${totalPending} pending reviews)`);
```

Change to:
```typescript
  logger.log(`Owner nudge sent for business ${businessId} (${totalPending} pending reviews)`);
```

Note: Verify the variable is `businessId` (camelCase) in this scope. If the local variable is `business_id`, use that instead. Read the surrounding function signature before editing.

- [ ] **Step 3: Update OnboardingDripWorker.ts line 157**

Current (line 157):
```typescript
  logger.log(`${drip_type} sent to ${business.owner_email} for ${business.name}`);
```

Change to:
```typescript
  logger.log(`${drip_type} sent for business ${business_id}`);
```

Remove the business name too — it's PII-adjacent and the business_id is sufficient for operational correlation. If the surrounding variable is `businessId` (camelCase), use it; otherwise `business_id`.

- [ ] **Step 4: Update ResponsePublisherWorker.ts line 207-209**

Current (line 207-209):
```typescript
  logger.log(
    `Manual-post email sent to ${adminEmail} for response ${response_id}`,
  );
```

Change to:
```typescript
  logger.log(
    `Manual-post email sent for response ${response_id} (business ${business_id})`,
  );
```

- [ ] **Step 5: Audit for any other email-in-log patterns introduced by Prompt 20a**

Run: `rg -n "logger\.(log|warn|error).*owner_email|logger\.(log|warn|error).*adminEmail" worker/jobs/`
Expected: Zero matches after the four fixes above. If any remain, apply the same treatment.

Also check:
`rg -n "logger\.(log|warn|error).*\.email" worker/jobs/`
Expected: No matches. Any `\.email` access in a logger call is PII.

- [ ] **Step 6: Run tests**

Run: `pnpm test`
Expected: All tests pass. Tests that assert specific log strings (if any) may need updating — grep for `expect.*email.*sent` in test files.

- [ ] **Step 7: Commit**

```bash
git add worker/jobs/NotificationWorker.ts worker/jobs/EngagementAlertWorker.ts worker/jobs/OnboardingDripWorker.ts worker/jobs/ResponsePublisherWorker.ts
git commit -m "fix(20a): remove email addresses from correlation-tagged worker logs"
```

---

## Task 5: Add Correlation ID Assertion Tests

Addresses Finding 4. The existing approval service and dashboard API tests pass the new optional `correlationId` parameter transparently without asserting its value. Add explicit assertions at both layers.

**Files:**
- Modify: `src/lib/approval/__tests__/service.test.ts`
- Modify: `src/app/api/dashboard/reviews/__tests__/actions.test.ts`

- [ ] **Step 1: Add correlation_id assertion to approve() test**

Open `src/lib/approval/__tests__/service.test.ts`. Locate the existing approve test around line 165 that calls:
```typescript
    await approve(tx, link, 'device-hash-abc', AUDIT);
```

Change to pass an explicit correlationId and assert it reaches the outbox payload:

```typescript
    await approve(tx, link, 'device-hash-abc', AUDIT, 'test-correlation-xyz');

    // The outbox INSERT interpolates JSON.stringify(payload) as one of the tagged
    // template values. Find that string among the call arguments and parse it.
    const jsonArgs = tx.mock.calls
      .flat()
      .filter((arg: unknown): arg is string => typeof arg === 'string' && arg.startsWith('{'));
    const outboxPayloads = jsonArgs.map((s) => JSON.parse(s) as Record<string, unknown>);
    const publishPayload = outboxPayloads.find((p) => p.response_id === link.response_id);
    expect(publishPayload).toBeDefined();
    expect(publishPayload!.correlation_id).toBe('test-correlation-xyz');
```

Replicate this assertion pattern for the `edit` and `regenerate` test cases in the same file. Look for calls to `await edit(...)` and `await regenerate(...)` and add the correlationId parameter + assertion.

- [ ] **Step 2: Add correlation_id assertion to dashboard approve test**

Open `src/app/api/dashboard/reviews/__tests__/actions.test.ts`. Locate the happy-path approve test around line 144 that currently uses:
```typescript
    expect(mockApproveBySession).toHaveBeenCalledOnce();
```

Replace with:
```typescript
    expect(mockApproveBySession).toHaveBeenCalledOnce();
    // Signature: approveBySession(tx, responseId, businessId, audit, correlationId)
    const callArgs = mockApproveBySession.mock.calls[0];
    expect(callArgs?.[4]).toBeDefined();  // correlationId argument present
    expect(typeof callArgs?.[4]).toBe('string');
```

Also update the mock queue setup (the `mockSqlResults.push(...)` sequence) to include a row for the correlation recovery SELECT that's now in the route. The test needs:
1. First SQL result: the response lookup row
2. Second SQL result (inside sql.begin): the correlation recovery row

Refer to the test file's mock infrastructure around `setResponseLookup()` and add:
```typescript
setResponseLookup([{ id: RESPONSE_ID, business_id: BUSINESS_ID, status: 'pending_approval' }]);
mockSqlResults.push([{ correlation_id: 'recovered-corr-123' }]);  // for recoverCorrelationId
```

Then assert that the correlationId passed matches:
```typescript
expect(callArgs?.[4]).toBe('recovered-corr-123');
```

- [ ] **Step 3: Add the same assertions to dashboard edit and regenerate tests**

Apply the same pattern to the happy-path edit and regenerate tests in the same file. The service signatures are:
- `editBySession(tx, responseId, businessId, editedText, audit, correlationId)` — correlationId is arg index 5
- `regenerateBySession(tx, responseId, businessId, audit, correlationId)` — correlationId is arg index 4

- [ ] **Step 4: Run tests**

Run: `pnpm test`
Expected: All tests pass, including the new assertions.

- [ ] **Step 5: Commit**

```bash
git add src/lib/approval/__tests__/service.test.ts src/app/api/dashboard/reviews/__tests__/actions.test.ts
git commit -m "test(20a): assert correlation IDs reach outbox payloads and service calls"
```

---

## Task 6: Create PlaceIdValidationWorker Test

Addresses Finding 4 (missing worker test). Sprint 2 had tests for most workers but the PlaceIdValidationWorker was never tested. Prompt 20a introduced correlation_id propagation through `enqueueSyncReviews`, so coverage here is overdue.

**Files:**
- Create: `worker/__tests__/PlaceIdValidationWorker.test.ts`

- [ ] **Step 1: Read the existing worker + a similar test for reference**

Read `worker/jobs/PlaceIdValidationWorker.ts` to understand the handler's dependencies (markOutboxCompleted/markOutboxFailed, SQL queries, the resolver module). Read `worker/__tests__/ReviewSyncWorker.test.ts` to understand the project's preferred mocking pattern for worker tests.

- [ ] **Step 2: Write the test file**

```typescript
// worker/__tests__/PlaceIdValidationWorker.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';
import type { ValidatePlaceIdPayload } from '../../src/lib/shared/worker-types';

// ── Mock SQL ─────────────────────────────────────────────────────────

const mockSqlResults: unknown[] = [];
const sqlCallCounter = { value: 0 };

function sqlMock(_strings: TemplateStringsArray, ..._values: unknown[]): Promise<unknown> {
  const result = mockSqlResults[sqlCallCounter.value++];
  return Promise.resolve(Array.isArray(result) ? result : [result]);
}

vi.mock('../../src/lib/db/server', () => ({
  sql: Object.assign(vi.fn(sqlMock), {
    begin: (fn: (tx: typeof sqlMock) => unknown) => Promise.resolve(fn(sqlMock as unknown as typeof sqlMock)),
  }),
}));

// ── Mock outbox helpers ─────────────────────────────────────────────

const mockMarkCompleted = vi.fn();
const mockMarkFailed = vi.fn();
vi.mock('../../src/lib/shared/outbox', () => ({
  markOutboxCompleted: (...args: unknown[]) => mockMarkCompleted(...args),
  markOutboxFailed: (...args: unknown[]) => mockMarkFailed(...args),
}));

// ── Mock Place ID resolver ──────────────────────────────────────────

const mockResolvePlaceId = vi.fn();
vi.mock('../../src/lib/reviews/place-id-resolver', () => ({
  resolvePlaceIdFromUrl: (...args: unknown[]) => mockResolvePlaceId(...args),
}));

// ── Mock uuid ───────────────────────────────────────────────────────

vi.mock('uuid', () => ({ v7: vi.fn(() => 'test-outbox-uuid') }));

// ── Helper: make a job ──────────────────────────────────────────────

function makeJob(overrides?: Partial<ValidatePlaceIdPayload>): Job<ValidatePlaceIdPayload> {
  return {
    id: 'bullmq-job-id',
    data: {
      business_id: 'biz-001',
      google_maps_url: 'https://maps.google.com/?q=test',
      correlation_id: 'corr-upstream-abc',
      ...overrides,
      outbox_id: 'outbox-001',
    } as ValidatePlaceIdPayload & { outbox_id: string },
  } as unknown as Job<ValidatePlaceIdPayload>;
}

// ── Tests ───────────────────────────────────────────────────────────

describe('handlePlaceIdValidation', () => {
  beforeEach(() => {
    mockSqlResults.length = 0;
    sqlCallCounter.value = 0;
    mockMarkCompleted.mockClear();
    mockMarkFailed.mockClear();
    mockResolvePlaceId.mockClear();
  });

  it('propagates correlation_id into sync_reviews outbox payload on successful resolution', async () => {
    // Resolver succeeds
    mockResolvePlaceId.mockResolvedValue({
      placeId: 'ChIJ_resolved_place_id',
      verified: true,
    });

    // SQL mock queue:
    // 1. SELECT business row (inside handler)
    // 2. UPDATE businesses (place_id + verified)
    // 3. INSERT INTO job_outbox (sync_reviews)
    mockSqlResults.push([{
      id: 'biz-001',
      google_maps_url: 'https://maps.google.com/?q=test',
      subscription_status: 'pending_payment',
      updated_at: new Date(),
    }]);
    mockSqlResults.push([]);  // UPDATE returns no rows
    mockSqlResults.push([{ count: 1 }]);  // INSERT returns count

    const { handlePlaceIdValidation } = await import('../jobs/PlaceIdValidationWorker');
    await handlePlaceIdValidation(makeJob());

    // Find the JSON string passed to the INSERT — it should carry correlation_id
    const { sql } = await import('../../src/lib/db/server');
    const sqlFn = sql as unknown as { mock: { calls: unknown[][] } };
    const jsonArgs = sqlFn.mock.calls
      .flat()
      .filter((arg: unknown): arg is string => typeof arg === 'string' && arg.startsWith('{'));
    const payloads = jsonArgs.map((s) => JSON.parse(s) as Record<string, unknown>);
    const syncPayload = payloads.find((p) => p.google_place_id === 'ChIJ_resolved_place_id');
    expect(syncPayload).toBeDefined();
    expect(syncPayload!.correlation_id).toBe('corr-upstream-abc');
    expect(mockMarkCompleted).toHaveBeenCalledWith('outbox-001');
  });

  it('marks outbox failed when resolver cannot identify a place', async () => {
    mockResolvePlaceId.mockResolvedValue({
      placeId: null,
      verified: false,
      reason: 'No canonical Place ID could be resolved',
    });

    mockSqlResults.push([{
      id: 'biz-001',
      google_maps_url: 'https://maps.google.com/?q=test',
      subscription_status: 'pending_payment',
      updated_at: new Date(),
    }]);
    // UPDATE with verified=false
    mockSqlResults.push([]);
    // INSERT review_exceptions row
    mockSqlResults.push([]);

    const { handlePlaceIdValidation } = await import('../jobs/PlaceIdValidationWorker');
    await handlePlaceIdValidation(makeJob());

    // Either markOutboxFailed or markOutboxCompleted should be called — check worker behavior
    // The worker marks completed even on resolution failure because retrying wouldn't help.
    // Adjust this assertion once worker source is read — the key assertion is that NO
    // sync_reviews outbox entry is created when placeId is null.
    const { sql } = await import('../../src/lib/db/server');
    const sqlFn = sql as unknown as { mock: { calls: unknown[][] } };
    const jsonArgs = sqlFn.mock.calls
      .flat()
      .filter((arg: unknown): arg is string => typeof arg === 'string' && arg.startsWith('{'));
    const payloads = jsonArgs.map((s) => {
      try { return JSON.parse(s) as Record<string, unknown>; } catch { return null; }
    }).filter(Boolean);
    const syncPayload = payloads.find((p) => p && p.google_place_id);
    expect(syncPayload).toBeUndefined();
  });
});
```

Note: Before running the test, read `worker/jobs/PlaceIdValidationWorker.ts` start-to-finish and list every SQL query the handler issues in order (SELECT business, UPDATE business, INSERT review_exceptions if unresolved, INSERT job_outbox if resolved). Then update the `mockSqlResults.push(...)` queue in each test case to match that exact order. If a test case exercises an error path, match only the queries that fire before the error. The critical assertion — that `correlation_id` appears in the sync_reviews payload — doesn't depend on call order; it just needs the INSERT payload JSON to be among the SQL args. Use `(sql as unknown as { mock: { calls: unknown[][] } }).mock.calls.flat().filter(...)` to extract payload strings without caring about position.

- [ ] **Step 3: Run the new test**

Run: `pnpm test -- worker/__tests__/PlaceIdValidationWorker.test.ts`
Expected: 2 tests PASS. If SQL call order doesn't match, iterate — the important assertion is that `correlation_id` is present in the sync_reviews payload when resolution succeeds.

- [ ] **Step 4: Run full test suite**

Run: `pnpm test`
Expected: All tests pass (578+).

- [ ] **Step 5: Commit**

```bash
git add worker/__tests__/PlaceIdValidationWorker.test.ts
git commit -m "test(20a): add PlaceIdValidationWorker test covering correlation propagation"
```

---

## Task 7: Final Verification

- [ ] **Step 1: Re-audit all in-flight dedupe guards**

Run: `rg -n "status IN \('pending', 'dispatched'\)" src worker --type ts --glob "!*test*" --glob "!*__tests__*"`
Expected: Zero matches.

- [ ] **Step 2: Verify no emails remain in logger calls**

Run: `rg -n "logger\.(log|warn|error).*(owner_email|adminEmail|business\.email|\.email)" worker/jobs/`
Expected: Zero matches.

- [ ] **Step 3: Verify the migration is applied**

Via Supabase SQL:
```sql
SELECT indexname, indexdef FROM pg_indexes
WHERE tablename = 'job_outbox'
  AND indexname IN ('idx_jo_correlation_id', 'idx_jo_sync_reviews_inflight');
```
Expected: 2 rows. The sync_reviews index's `indexdef` should include `'dispatching'`.

- [ ] **Step 4: Run full test suite**

Run: `pnpm test`
Expected: All tests pass. Test count should be at least 578 (576 original + 3 correlation helper + 2 PlaceIdValidation).

- [ ] **Step 5: Run build**

Run: `pnpm build`
Expected: Build succeeds, no type errors.

- [ ] **Step 6: Manual chain trace verification (local smoke test)**

With the worker and dev server running in mock mode (`MOCK_EXTERNAL_APIS=true`), trigger a sync via the admin onboarding flow, then approve a generated response via the email link. Then run:

```sql
SELECT id, topic, status, payload->>'correlation_id' AS corr, created_at
FROM job_outbox
WHERE payload->>'correlation_id' = '<corr-id-from-any-outbox-row-for-this-business>'
ORDER BY created_at;
```

Expected: a single query returns the full chain: sync_reviews → generate_response → send_notification → publish_response, all sharing the same correlation_id.

If the publish_response row has a different correlation_id, Task 3 didn't work — investigate the approval route and correlation recovery helper.

- [ ] **Step 7: Update tracking docs**

Update `.claude/CLAUDE.md` "Current status" section to note:
> Post-Prompt 20a review fixes: 5 findings addressed (migration 017 — correlation expression index + dispatching-inclusive sync_reviews unique index; dispatching-race guards updated in 9 sites; PII removed from 4 worker logs; correlation preserved across approval chain via recoverCorrelationId; test coverage added for approval correlation + PlaceIdValidationWorker).

Update `docs/progresstracking.md` with a Sprint 6 entry for these fixes.

- [ ] **Step 8: Final commit**

```bash
git add .claude/CLAUDE.md docs/progresstracking.md
git commit -m "docs: track Prompt 20a review-fix completion"
```
