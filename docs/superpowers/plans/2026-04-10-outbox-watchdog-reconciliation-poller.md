# OutboxPoller Watchdog + ReconciliationPoller Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add watchdog recovery to the existing OutboxPoller and create a ReconciliationPoller that schedules SerpAPI review syncs for active businesses every 60 minutes.

**Architecture:** The OutboxPoller already runs every 10s with FOR UPDATE SKIP LOCKED. We add a watchdog query at the START of each cycle that recovers entries stuck in 'dispatched' for >1 hour (worker crash recovery). The ReconciliationPoller is a separate setInterval (same pattern as OutboxPoller) that queries active businesses due for sync and inserts outbox entries — it does NOT call SerpAPI itself. In mock mode, the ReconciliationPoller skips entirely.

**Tech Stack:** Postgres.js (`sql`), uuid v7, shared types from `src/lib/shared/worker-types.ts`, mock-mode helper from `src/lib/shared/mock-mode.ts`

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `worker/jobs/OutboxPoller.ts` | Modify | Add watchdog recovery queries at start of poll cycle |
| `worker/jobs/ReconciliationPoller.ts` | Create | 60-min interval poller that inserts sync_reviews outbox entries |
| `worker/index.ts` | Modify | Wire ReconciliationPoller start/stop |

---

### Task 1: Add watchdog recovery to OutboxPoller

**Files:**
- Modify: `worker/jobs/OutboxPoller.ts:23-32` (inside `sql.begin`, before the pending-entry SELECT)

- [ ] **Step 1: Add watchdog queries inside the transaction, before the pending SELECT**

Inside the `sql.begin(async (tx) => { ... })` block in `pollOutbox()`, add two queries BEFORE the existing `const entries = await tx<OutboxEntry[]>` SELECT:

```typescript
// ── Watchdog: recover stale dispatched entries ─────────────────
// If a BullMQ worker crashed after the OutboxPoller marked the entry
// as 'dispatched' but before the worker marked it as 'completed',
// the entry is stuck. Reset retryable ones to 'pending'; fail terminal ones.

const [recovered] = await tx<{ count: string }[]>`
  WITH recovered AS (
    UPDATE job_outbox
    SET status = 'pending', available_at = NOW(), dispatched_at = NULL
    WHERE status = 'dispatched'
      AND dispatched_at < NOW() - INTERVAL '1 hour'
      AND attempts < max_attempts
    RETURNING id
  )
  SELECT COUNT(*)::text AS count FROM recovered
`;

const [terminated] = await tx<{ count: string }[]>`
  WITH terminated AS (
    UPDATE job_outbox
    SET status = 'failed',
        last_error = 'Stale dispatched entry exceeded max_attempts',
        completed_at = NOW()
    WHERE status = 'dispatched'
      AND dispatched_at < NOW() - INTERVAL '1 hour'
      AND attempts >= max_attempts
    RETURNING id
  )
  SELECT COUNT(*)::text AS count FROM terminated
`;

const recoveredCount = parseInt(recovered?.count ?? '0', 10);
const terminatedCount = parseInt(terminated?.count ?? '0', 10);

if (recoveredCount > 0 || terminatedCount > 0) {
  console.log(
    `[OutboxPoller] Watchdog: recovered=${recoveredCount}, failed=${terminatedCount}`,
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Run existing tests to confirm no regressions**

Run: `pnpm test`
Expected: All tests pass (136/136)

- [ ] **Step 4: Commit**

```bash
git add worker/jobs/OutboxPoller.ts
git commit -m "feat: add watchdog recovery to OutboxPoller for stale dispatched entries"
```

---

### Task 2: Create ReconciliationPoller

**Files:**
- Create: `worker/jobs/ReconciliationPoller.ts`

- [ ] **Step 1: Create the ReconciliationPoller module**

```typescript
import { v7 as uuidv7 } from 'uuid';
import { sql } from '../../src/lib/db/server';
import { isMockMode } from '../../src/lib/shared/mock-mode';
import type { SyncReviewsPayload } from '../../src/lib/shared/worker-types';

const DEFAULT_INTERVAL_MS = 3_600_000; // 60 minutes

let pollerInterval: ReturnType<typeof setInterval> | null = null;
let isPolling = false;

function getIntervalMs(): number {
  const envVal = process.env.RECONCILIATION_INTERVAL_MS;
  return envVal ? parseInt(envVal, 10) : DEFAULT_INTERVAL_MS;
}

async function pollBusinesses(): Promise<void> {
  if (isPolling) return;
  isPolling = true;

  try {
    if (isMockMode()) {
      console.log('[ReconciliationPoller] Mock mode — skipping');
      return;
    }

    // Find active businesses due for sync that don't already have
    // an in-flight sync_reviews outbox entry (dedup guard).
    const businesses = await sql<{ id: string; google_place_id: string }[]>`
      SELECT b.id, b.google_place_id
      FROM businesses b
      WHERE b.subscription_status = 'active'
        AND b.google_place_id IS NOT NULL
        AND (b.last_sync_at IS NULL OR b.last_sync_at < NOW() - INTERVAL '60 minutes')
        AND NOT EXISTS (
          SELECT 1 FROM job_outbox jo
          WHERE jo.topic = 'sync_reviews'
            AND jo.aggregate_id = b.id
            AND jo.status IN ('pending', 'dispatched')
        )
    `;

    if (businesses.length === 0) return;

    console.log(
      `[ReconciliationPoller] Found ${businesses.length} businesses due for sync`,
    );

    for (const biz of businesses) {
      const payload: SyncReviewsPayload = {
        business_id: biz.id,
        google_place_id: biz.google_place_id,
      };

      await sql`
        INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
        VALUES (
          ${uuidv7()},
          'sync_reviews',
          'business',
          ${biz.id},
          ${JSON.stringify(payload)}::jsonb,
          'pending'
        )
      `;
    }

    console.log(
      `[ReconciliationPoller] Queued ${businesses.length} sync_reviews outbox entries`,
    );
  } catch (error) {
    console.error('[ReconciliationPoller] Poll cycle failed:', error);
  } finally {
    isPolling = false;
  }
}

export function startReconciliationPoller(): void {
  const intervalMs = getIntervalMs();
  console.log(`[ReconciliationPoller] Starting (interval=${intervalMs}ms)`);
  // Run once immediately, then on interval
  pollBusinesses().catch(console.error);
  pollerInterval = setInterval(() => {
    pollBusinesses().catch(console.error);
  }, intervalMs);
}

export function stopReconciliationPoller(): void {
  if (pollerInterval) {
    clearInterval(pollerInterval);
    pollerInterval = null;
    console.log('[ReconciliationPoller] Stopped');
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add worker/jobs/ReconciliationPoller.ts
git commit -m "feat: add ReconciliationPoller for 60-minute SerpAPI review sync scheduling"
```

---

### Task 3: Wire ReconciliationPoller into worker/index.ts

**Files:**
- Modify: `worker/index.ts` (add import, start call, stop call)

- [ ] **Step 1: Add import**

Add after the OutboxPoller import:

```typescript
import { startReconciliationPoller, stopReconciliationPoller } from './jobs/ReconciliationPoller';
```

- [ ] **Step 2: Add start call after OutboxPoller**

In the `main()` function, after `startOutboxPoller();`:

```typescript
startReconciliationPoller();
```

- [ ] **Step 3: Add stop call in shutdown**

In the `shutdown()` function, after `stopOutboxPoller();`:

```typescript
stopReconciliationPoller();
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Run all tests to confirm no regressions**

Run: `pnpm test`
Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
git add worker/index.ts
git commit -m "feat: wire ReconciliationPoller start/stop into worker lifecycle"
```

---

### Task 4: Final verification

- [ ] **Step 1: Full type check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 2: Full test suite**

Run: `pnpm test`
Expected: All 136+ tests pass

- [ ] **Step 3: Build check**

Run: `pnpm build`
Expected: Next.js build succeeds

- [ ] **Step 4: Update tracking files**

Update `.claude/CLAUDE.md` current status with Prompt 8 completion.
Append Prompt 8 entry to `docs/progresstracking.md`.
