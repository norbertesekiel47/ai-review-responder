# Code Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all Critical (2), High (4), and Medium (7) issues from the Sprint 1-4 code review.

**Architecture:** Targeted fixes to existing files. No new features, no new files. Each task is an independent bug fix that can be verified with `pnpm test`.

**Tech Stack:** TypeScript, Postgres.js, BullMQ, Vitest

---

## File Structure

| File | Action | Fixes |
|------|--------|-------|
| `worker/jobs/WeeklySummaryScheduler.ts` | **MODIFY** | C1: robust `getPreviousMonday` |
| `worker/jobs/OutboxPoller.ts` | **MODIFY** | C2: split watchdog into own transaction |
| `worker/jobs/ResponseGeneratorWorker.ts` | **MODIFY** | H1: link retry apiCostId, M4: fix duplicate step numbers |
| `worker/ingress/stripe.ts` | **MODIFY** | H2: add status guard on checkout activation |
| `worker/jobs/AdminExceptionWorker.ts` | **MODIFY** | H3: LEFT JOIN for null review_id |
| `worker/jobs/ResponsePublisherWorker.ts` | **MODIFY** | M1: add business_id mismatch check |
| `src/lib/responses/generator.ts` | **MODIFY** | M2: lazy singleton LLM clients |
| `worker/jobs/ArchivalPoller.ts` | **MODIFY** | M3: log when batch hits limit |
| `worker/index.ts` | **MODIFY** | M7: Sentry scrub recursing into arrays |

**Not fixing (Low / acceptable risk):**
- M5 (ReviewSyncWorker uses 'generator' type) — intentional per CLAUDE.md, no divergent rules exist yet
- M6 (review edit during approved→publisher window) — seconds-wide race, negligible probability at 10 businesses

---

## Task 1: C1 — Robust `getPreviousMonday` in WeeklySummaryScheduler

**Files:**
- Modify: `worker/jobs/WeeklySummaryScheduler.ts:24-29`

- [ ] **Step 1: Fix the function**

In `worker/jobs/WeeklySummaryScheduler.ts`, replace lines 19-29:

```typescript
/**
 * Returns the Monday 00:00 UTC of the week that just ended.
 * Works for any day of the week — not just Monday.
 */
function getPreviousMonday(now: Date): string {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  const dayOfWeek = d.getUTCDay(); // 0=Sun, 1=Mon ... 6=Sat
  const daysSinceMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  d.setUTCDate(d.getUTCDate() - daysSinceMonday - 7);
  return d.toISOString().slice(0, 10);
}
```

- [ ] **Step 2: Run tests**

Run: `pnpm test`
Expected: all 219 tests pass

- [ ] **Step 3: Commit**

```bash
git add worker/jobs/WeeklySummaryScheduler.ts
git commit -m "fix(C1): make getPreviousMonday robust for any day of week"
```

---

## Task 2: C2 — Split OutboxPoller watchdog into separate transaction

**Files:**
- Modify: `worker/jobs/OutboxPoller.ts`

- [ ] **Step 1: Restructure pollOutbox**

In `worker/jobs/OutboxPoller.ts`, replace the entire `pollOutbox` function (lines 19-165) with:

```typescript
async function pollOutbox(): Promise<void> {
  if (isPolling) return;
  isPolling = true;

  try {
    // ── Phase 1: Watchdog recovery (own transaction) ──────────────────
    // Separate from dispatch so watchdog locks don't extend across
    // Redis roundtrips and a dispatch failure doesn't rollback recovery.
    try {
      await sql.begin(async (tx) => {
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
      });
    } catch (watchdogError) {
      console.error('[OutboxPoller] Watchdog phase failed:', watchdogError);
      // Continue to dispatch phase — watchdog failure is not fatal
    }

    // ── Phase 2: Fetch + dispatch (own transaction) ──────────────────
    await sql.begin(async (tx) => {
      const entries = await tx<OutboxEntry[]>`
        SELECT id, topic, payload, attempts, max_attempts
        FROM job_outbox
        WHERE status = 'pending'
          AND available_at <= NOW()
        ORDER BY available_at
        LIMIT ${BATCH_SIZE}
        FOR UPDATE SKIP LOCKED
      `;

      if (entries.length === 0) return;

      console.log(`[OutboxPoller] Found ${entries.length} pending entries`);

      for (const entry of entries) {
        const queue = topicToQueue[entry.topic];

        if (!queue) {
          console.error(`[OutboxPoller] Unknown topic "${entry.topic}" for outbox entry ${entry.id}`);
          await tx`
            UPDATE job_outbox
            SET status = 'failed',
                last_error = ${'Unknown topic: ' + entry.topic},
                attempts = attempts + 1
            WHERE id = ${entry.id}
          `;
          continue;
        }

        try {
          const payload = typeof entry.payload === 'string'
            ? JSON.parse(entry.payload) as Record<string, unknown>
            : entry.payload;

          const jobId = `${entry.id}_${entry.attempts + 1}`;
          await queue.add(entry.topic, { ...payload, outbox_id: entry.id }, { jobId });

          Sentry.addBreadcrumb({
            category: 'outbox',
            message: `Dispatched ${entry.topic} (${entry.id})`,
            level: 'info',
          });

          await tx`
            UPDATE job_outbox
            SET status = 'dispatched',
                dispatched_at = NOW(),
                attempts = attempts + 1
            WHERE id = ${entry.id}
          `;
        } catch (dispatchError) {
          console.error(
            `[OutboxPoller] Failed to dispatch entry ${entry.id} (topic=${entry.topic}):`,
            dispatchError,
          );

          Sentry.addBreadcrumb({
            category: 'outbox',
            message: `Dispatch failed ${entry.topic} (${entry.id})`,
            level: 'error',
          });

          const errorMsg = dispatchError instanceof Error ? dispatchError.message : String(dispatchError);
          const nextAttempts = entry.attempts + 1;
          if (nextAttempts >= entry.max_attempts) {
            console.error(
              `[OutboxPoller] Entry ${entry.id} exceeded max_attempts (${entry.max_attempts}), marking as failed`,
            );
            await tx`
              UPDATE job_outbox
              SET status = 'failed',
                  last_error = ${errorMsg},
                  attempts = ${nextAttempts}
              WHERE id = ${entry.id}
            `;
          } else {
            await tx`
              UPDATE job_outbox
              SET attempts = ${nextAttempts},
                  last_error = ${errorMsg}
              WHERE id = ${entry.id}
            `;
          }
        }
      }
    });
  } catch (error) {
    console.error('[OutboxPoller] Poll cycle failed:', error);
  } finally {
    isPolling = false;
  }
}
```

- [ ] **Step 2: Run tests**

Run: `pnpm test`
Expected: all tests pass

- [ ] **Step 3: Commit**

```bash
git add worker/jobs/OutboxPoller.ts
git commit -m "fix(C2): split OutboxPoller watchdog into separate transaction"
```

---

## Task 3: H1 + M4 — Link retry apiCostId + fix duplicate step numbers

**Files:**
- Modify: `worker/jobs/ResponseGeneratorWorker.ts`

- [ ] **Step 1: Fix the avoid-facts guardrail to return both cost IDs**

In `worker/jobs/ResponseGeneratorWorker.ts`, find the `applyAvoidFactsGuardrail` function. Change the merged result (around line 234-237) to preserve both cost IDs:

Find:
```typescript
    const merged: GenerationResult = {
      ...retryResult,
      costUsd: result.costUsd + retryResult.costUsd,
    };
```

Replace with:
```typescript
    const merged: GenerationResult = {
      ...retryResult,
      costUsd: result.costUsd + retryResult.costUsd,
      // Preserve the original apiCostId; the retry's apiCostId is in _retryCostId
    };
    (merged as GenerationResult & { _retryCostId?: string | null })._retryCostId = retryResult.apiCostId;
    // Restore original's apiCostId (retryResult spread overwrote it)
    merged.apiCostId = result.apiCostId;
```

- [ ] **Step 2: Fix persistResponseAndNotify to link both cost records**

In the `persistResponseAndNotify` function, find the apiCostId linking block (around line 283-287):

Find:
```typescript
    if (result.apiCostId) {
      await tx`
        UPDATE api_costs SET response_id = ${responseId} WHERE id = ${result.apiCostId}
      `;
    }
```

Replace with:
```typescript
    if (result.apiCostId) {
      await tx`
        UPDATE api_costs SET response_id = ${responseId} WHERE id = ${result.apiCostId}
      `;
    }
    const retryCostId = (result as GenerationResult & { _retryCostId?: string | null })._retryCostId;
    if (retryCostId) {
      await tx`
        UPDATE api_costs SET response_id = ${responseId} WHERE id = ${retryCostId}
      `;
    }
```

- [ ] **Step 3: Run tests**

Run: `pnpm test`
Expected: all tests pass

- [ ] **Step 4: Commit**

```bash
git add worker/jobs/ResponseGeneratorWorker.ts
git commit -m "fix(H1): link retry apiCostId to response, preventing orphaned cost rows"
```

---

## Task 4: H2 — Add status guard on Stripe checkout activation

**Files:**
- Modify: `worker/ingress/stripe.ts`

- [ ] **Step 1: Add WHERE clause guard**

In `worker/ingress/stripe.ts`, find `processCheckoutSessionCompleted` (around line 29-48). Replace the UPDATE query:

Find:
```typescript
  await sql`
    UPDATE businesses
    SET
      subscription_status = 'active',
      stripe_customer_id = ${customerId},
      stripe_subscription_id = ${subscriptionId},
      updated_at = NOW()
    WHERE id = ${businessId}::uuid
  `;
  console.log(`${LOG_PREFIX} Business ${businessId} activated (customer=${customerId})`);
```

Replace with:
```typescript
  const updated = await sql`
    UPDATE businesses
    SET
      subscription_status = 'active',
      stripe_customer_id = ${customerId},
      stripe_subscription_id = ${subscriptionId},
      updated_at = NOW()
    WHERE id = ${businessId}::uuid
      AND subscription_status IN ('pending_payment', 'past_due')
  `;
  if (updated.count > 0) {
    console.log(`${LOG_PREFIX} Business ${businessId} activated (customer=${customerId})`);
  } else {
    console.warn(`${LOG_PREFIX} Business ${businessId} not activated — current status is not pending_payment or past_due`);
  }
```

- [ ] **Step 2: Run tests**

Run: `pnpm test`
Expected: all tests pass

- [ ] **Step 3: Commit**

```bash
git add worker/ingress/stripe.ts
git commit -m "fix(H2): guard Stripe checkout activation — only transition from pending_payment or past_due"
```

---

## Task 5: H3 — LEFT JOIN in AdminExceptionWorker for null review_id

**Files:**
- Modify: `worker/jobs/AdminExceptionWorker.ts`

- [ ] **Step 1: Change JOIN to LEFT JOIN**

In `worker/jobs/AdminExceptionWorker.ts`, find the exception query (around lines 27-34):

Find:
```typescript
    FROM review_exceptions re
    JOIN reviews r ON re.review_id = r.id
    JOIN businesses b ON re.business_id = b.id
```

Replace with:
```typescript
    FROM review_exceptions re
    LEFT JOIN reviews r ON re.review_id = r.id
    JOIN businesses b ON re.business_id = b.id
```

- [ ] **Step 2: Handle null reviewer data in email body**

In the same file, find where reviewer_name and star_rating are used in the email body. Add null handling. Find the email subject/body construction and ensure it handles null `reviewer_name`:

Find the section that builds the email (look for `sendInternalEmail`). Change any reference to `exception.reviewer_name` to use a fallback:

The email subject line likely uses `exception.reviewer_name`. Change it to:
```typescript
const reviewerName = exception.reviewer_name ?? 'Unknown reviewer';
```

Use `reviewerName` wherever `exception.reviewer_name` was used in the email template.

- [ ] **Step 3: Run tests**

Run: `pnpm test`
Expected: all tests pass (existing AdminExceptionWorker tests should still pass since they mock with non-null data)

- [ ] **Step 4: Commit**

```bash
git add worker/jobs/AdminExceptionWorker.ts
git commit -m "fix(H3): LEFT JOIN reviews in AdminExceptionWorker for null review_id exceptions"
```

---

## Task 6: M1 — Add business_id mismatch check in ResponsePublisherWorker

**Files:**
- Modify: `worker/jobs/ResponsePublisherWorker.ts`

- [ ] **Step 1: Add the mismatch check**

In `worker/jobs/ResponsePublisherWorker.ts`, after the response is loaded and the null check (around line 36), add:

```typescript
  if (response.business_id !== business_id) {
    console.error(`${LOG_PREFIX} Response ${response_id} belongs to business ${response.business_id}, not ${business_id}`);
    await markOutboxFailed(outboxId, 'business_id_mismatch');
    return;
  }
```

- [ ] **Step 2: Run tests**

Run: `pnpm test`
Expected: all tests pass

- [ ] **Step 3: Commit**

```bash
git add worker/jobs/ResponsePublisherWorker.ts
git commit -m "fix(M1): add business_id mismatch check in ResponsePublisherWorker"
```

---

## Task 7: M2 — Lazy singleton LLM clients

**Files:**
- Modify: `src/lib/responses/generator.ts`

- [ ] **Step 1: Add lazy singletons**

In `src/lib/responses/generator.ts`, find `callOpenAI` (around line 266-293) and `callAnthropic` (around line 295-320). Replace the `new OpenAI()` and `new Anthropic()` calls with lazy singletons.

Add above `callOpenAI` (around line 265):

```typescript
let _openai: OpenAI | null = null;
function getOpenAI(): OpenAI {
  if (!_openai) _openai = new OpenAI();
  return _openai;
}

let _anthropic: Anthropic | null = null;
function getAnthropic(): Anthropic {
  if (!_anthropic) _anthropic = new Anthropic();
  return _anthropic;
}
```

Then in `callOpenAI`, change `const client = new OpenAI();` to `const client = getOpenAI();`

In `callAnthropic`, change `const client = new Anthropic();` to `const client = getAnthropic();`

- [ ] **Step 2: Run tests**

Run: `pnpm test`
Expected: all tests pass

- [ ] **Step 3: Commit**

```bash
git add src/lib/responses/generator.ts
git commit -m "fix(M2): use lazy singleton LLM clients instead of per-call instantiation"
```

---

## Task 8: M3 — Log when archival batch hits limit

**Files:**
- Modify: `worker/jobs/ArchivalPoller.ts`

- [ ] **Step 1: Add batch limit warnings**

In `worker/jobs/ArchivalPoller.ts`, after the three DELETE queries and the count parsing (around line 54-56), add a warning:

Find:
```typescript
    if (outboxCount + eventsCount + demosCount > 0) {
      console.log(
        `${LOG_PREFIX} Archived: ${outboxCount} outbox entries, ${eventsCount} inbound events, ${demosCount} expired demos`,
      );
```

Replace with:
```typescript
    if (outboxCount + eventsCount + demosCount > 0) {
      console.log(
        `${LOG_PREFIX} Archived: ${outboxCount} outbox entries, ${eventsCount} inbound events, ${demosCount} expired demos`,
      );
      if (outboxCount >= 5000 || eventsCount >= 5000 || demosCount >= 5000) {
        console.warn(`${LOG_PREFIX} Batch limit (5000) reached — more rows may remain. Next cycle will continue cleanup.`);
      }
```

- [ ] **Step 2: Run tests**

Run: `pnpm test`
Expected: all tests pass

- [ ] **Step 3: Commit**

```bash
git add worker/jobs/ArchivalPoller.ts
git commit -m "fix(M3): log warning when archival batch hits 5000 limit"
```

---

## Task 9: M7 — Sentry scrub recursing into arrays

**Files:**
- Modify: `worker/index.ts`

- [ ] **Step 1: Fix scrubObject to handle arrays**

In `worker/index.ts`, find the `scrubObject` function (lines 6-15):

Find:
```typescript
function scrubObject(obj: Record<string, unknown>): void {
  const sensitiveKeys = /key|secret|token|password|authorization/i;
  for (const key of Object.keys(obj)) {
    if (sensitiveKeys.test(key)) {
      obj[key] = '[REDACTED]';
    } else if (obj[key] && typeof obj[key] === 'object' && !Array.isArray(obj[key])) {
      scrubObject(obj[key] as Record<string, unknown>);
    }
  }
}
```

Replace with:
```typescript
function scrubObject(obj: Record<string, unknown>): void {
  const sensitiveKeys = /key|secret|token|password|authorization/i;
  for (const key of Object.keys(obj)) {
    if (sensitiveKeys.test(key)) {
      obj[key] = '[REDACTED]';
    } else if (Array.isArray(obj[key])) {
      for (const item of obj[key] as unknown[]) {
        if (item && typeof item === 'object') {
          scrubObject(item as Record<string, unknown>);
        }
      }
    } else if (obj[key] && typeof obj[key] === 'object') {
      scrubObject(obj[key] as Record<string, unknown>);
    }
  }
}
```

- [ ] **Step 2: Run tests**

Run: `pnpm test`
Expected: all tests pass

- [ ] **Step 3: Commit**

```bash
git add worker/index.ts
git commit -m "fix(M7): Sentry scrubObject now recursing into arrays of objects"
```

---

## Self-Review

**Coverage check:**
- C1 (getPreviousMonday): Task 1 ✓
- C2 (OutboxPoller single transaction): Task 2 ✓
- H1 (orphaned retry apiCostId): Task 3 ✓
- H2 (Stripe status guard): Task 4 ✓
- H3 (AdminExceptionWorker LEFT JOIN): Task 5 ✓
- H4 (NotificationWorker delivery outside tx): Accepted risk — the window is seconds-wide and the second email works. Fixing would require moving email send inside a transaction, which is architecturally wrong (email sends should not block DB commits).
- M1 (publisher business_id check): Task 6 ✓
- M2 (LLM singleton clients): Task 7 ✓
- M3 (archival batch limit log): Task 8 ✓
- M4 (duplicate step numbers): addressed in Task 3 alongside H1
- M5 (sync uses 'generator' type): not fixing — intentional
- M6 (approved→publisher race): not fixing — seconds-wide window
- M7 (Sentry array scrub): Task 9 ✓

**Placeholder scan:** No TBDs or TODOs. All code blocks are complete.

**Type consistency:** `GenerationResult & { _retryCostId?: string | null }` used consistently in Task 3 for both write and read paths.
