# F1 — Owner-Unreachable Escalation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Every path below is relative to the worktree root `RepWorth-worktrees/f1-owner-unreachable-escalation/`.

**Goal:** Model the notification *owner-unreachable outcome* (an approval draft whose account/location has zero verified channel enrollments at send time — the `no_verified_enrollments` branch) as a distinct `job_outbox.completion_reason='owner_unreachable'` marker instead of a silent `markOutboxCompleted`; observe it with a durable health-alert check; escalate + retry it on the `NotificationFailoverPoller` cadence.

**Architecture:** The worker's authoritative "no verified enrollment" verdict is persisted as an additive `job_outbox.completion_reason` marker (single source — read, never re-derived, downstream). A new `checkOwnerUnreachable` health finding observes the marker with an **age floor** (durable, unlike the windowed `checkZeroDeliveryNotifications`, which is de-conflated to exclude the marker). A third, disjoint arm of `NotificationFailoverPoller` re-enqueues `send_notification` (self-clearing once the owner enrolls) and sends a 24h-deduped admin email. No new external seam; every change deepens an existing module.

**Tech Stack:** Postgres.js (`sql` tagged templates), BullMQ/job_outbox outbox, Vitest (mock-sql `.test.ts` for shaping/control-flow + `.integration.test.ts` gated on `TEST_DATABASE_POOL_URL` for SQL-predicate semantics), fast-check (property tests), Sentry (health findings).

**Glossary (CONTEXT.md, verbatim):**
- **Owner-unreachable outcome** — the notification result when an approval draft's account/location has zero verified channel enrollments at send time (`no_verified_enrollments`), recorded as `job_outbox.completion_reason='owner_unreachable'` on the completed `send_notification` row. Distinct from **all-failed** (a delivery was attempted on an enrolled channel and every attempt failed) and **stale** (delivered but the owner hasn't acted). The draft stays `pending_approval` and is retried on the `NotificationFailoverPoller` cadence until a channel appears.

**Invariant guards to respect (from `.feature/intake.json`):** attempt-guarded CAS on the marker write; single-source eligibility (worker is the only writer; SQL reads the marker); category disjointness (owner-unreachable ⟺ **no `approval_request` delivery ever**); no self-erase (admin-email delivery uses a distinct template, so predicates key off the marker + absence of `approval_request` delivery, never blanket zero-deliveries); self-clearing; retry + admin-alert idempotency; tenant scope; age FLOOR not a window; **count per-response, not per-attempt** (retries create multiple marked rows).

---

## File Structure

| File | Create/Modify | Responsibility |
|---|---|---|
| `supabase/migrations/083_outbox_owner_unreachable.sql` | Create | Additive `completion_reason` column + partial index |
| `src/lib/shared/outbox-completion-reason.ts` | Create | Typed constant for the marker value (no string literals) |
| `src/lib/shared/outbox.ts` | Modify | Add `markOutboxOwnerUnreachable` (attempt-guarded CAS, mirrors `markOutboxCompletedIfOwned`) |
| `src/lib/shared/__tests__/outbox.test.ts` | Modify | fast-check property test for the marker CAS |
| `worker/jobs/notification/NotificationWorker.ts` | Modify | `no_verified_enrollments` branch → `markOutboxOwnerUnreachable` |
| `worker/jobs/notification/__tests__/NotificationWorker.test.ts` | Modify | Branch calls the new helper, still no dispatch |
| `worker/background/pollers/health-alert/checks.ts` | Modify | `checkOwnerUnreachable` + config fields + de-conflate `checkZeroDeliveryNotifications` |
| `worker/background/pollers/health-alert/__tests__/checks.test.ts` | Modify | Finding-shaping (mock-sql) + de-conflation regression |
| `worker/background/pollers/health-alert/__tests__/checks.integration.test.ts` | Create | SQL-predicate invariants against real PG (skips w/o `TEST_DATABASE_POOL_URL`) |
| `src/lib/config/worker.ts` | Modify | `HEALTH_ALERT_OWNER_UNREACHABLE_AGE_S` + `_THRESHOLD` |
| `worker/background/pollers/NotificationFailoverPoller.ts` | Modify | New disjoint `processOwnerUnreachable` arm |
| `worker/background/pollers/__tests__/NotificationFailoverPoller.test.ts` | Modify | Arm re-enqueues (no-in-flight-guarded) + admin email; disjointness |
| `.claude/reference/migrations-log.md` | Modify | Record 083 (head → 083) |
| `.claude/reference/env-vars.md` | Modify | Two new env vars |
| `CONTEXT.md` | Modify | Glossary term |
| `docs/adr/0010-owner-unreachable-outcome.md` | Create | Design rationale |

**Blocking edges:** Task 1 blocks Tasks 2/3/4 (they consume the column + constant). Tasks 2, 3, 4 are mutually independent (parallelizable). Task 5 (docs/ADR) after 1–4.

---

## Task 1: Marker foundation — migration, constant, CAS helper, property test

**Files:**
- Create: `supabase/migrations/083_outbox_owner_unreachable.sql`
- Create: `src/lib/shared/outbox-completion-reason.ts`
- Modify: `src/lib/shared/outbox.ts`
- Test: `src/lib/shared/__tests__/outbox.test.ts`
- Modify: `.claude/reference/migrations-log.md`

- [ ] **Step 1: Read the migrations-log head + migration 082 for the CONCURRENTLY precedent**

Run: read `.claude/reference/migrations-log.md` (confirm head is 082, next 083) and `supabase/migrations/082_failover_lookup_indexes.sql` (mirror its `CREATE INDEX CONCURRENTLY` + no-surrounding-transaction convention).

- [ ] **Step 2: Write migration 083**

`supabase/migrations/083_outbox_owner_unreachable.sql`:

```sql
-- 083_outbox_owner_unreachable.sql
-- F1 (ticket docs/superpowers/plans/2026-07-16-prod-hardening-followup-map.md):
-- distinct owner-unreachable notification outcome. A send_notification job that
-- completes because the owner has zero verified channel enrollments records
-- completion_reason='owner_unreachable' on its completed job_outbox row (instead
-- of a silent NULL completion), so HealthAlertPoller.checkOwnerUnreachable and
-- the NotificationFailoverPoller owner-unreachable arm can observe + escalate it.
-- Additive nullable column; all other topics and existing rows stay NULL and
-- keep unchanged behavior.
ALTER TABLE job_outbox ADD COLUMN IF NOT EXISTS completion_reason TEXT;

-- Partial index for the owner-unreachable lookups (the marker is rare -> highly
-- selective). CONCURRENTLY + applied OUTSIDE a transaction block, mirroring
-- migration 082. When applying via the Supabase SQL editor, uncheck "single
-- transaction" (CREATE INDEX CONCURRENTLY cannot run inside a txn).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_jo_completion_reason
  ON job_outbox (topic) WHERE completion_reason IS NOT NULL;
```

- [ ] **Step 3: Write the typed constant**

`src/lib/shared/outbox-completion-reason.ts`:

```typescript
// Single authoritative owner for the job_outbox.completion_reason vocabulary.
// Import this constant everywhere the marker value is written or read — never a
// bare 'owner_unreachable' string literal (repworth.md: no status/reason string
// literals). Additive column added in migration 083.
export const OUTBOX_COMPLETION_REASON = {
  OWNER_UNREACHABLE: 'owner_unreachable',
} as const;

export type OutboxCompletionReason =
  (typeof OUTBOX_COMPLETION_REASON)[keyof typeof OUTBOX_COMPLETION_REASON];
```

- [ ] **Step 4: Write the failing property test for the CAS helper**

Add to `src/lib/shared/__tests__/outbox.test.ts` (mirror `worker/background/pollers/__tests__/cursor-store.test.ts` fast-check CAS style; reuse whatever fake-exec harness `outbox.test.ts` already uses for `markOutboxCompleted`). The pure invariant: the write is attempt-guarded and no-ops on a superseded attempt.

```typescript
import fc from 'fast-check';
import { markOutboxOwnerUnreachable } from '../outbox';
import { OUTBOX_COMPLETION_REASON } from '../outbox-completion-reason';

// A fake tagged-template exec that (a) composes nested fragments (dispatchedRow)
// and (b) returns a controllable { count }. Mirror the fake exec already used in
// this file for markOutboxCompleted; capture the last top-level query text.
describe('markOutboxOwnerUnreachable (invariants)', () => {
  it('is attempt-guarded and no-ops on a superseded attempt', async () => {
    await fc.assert(fc.asyncProperty(
      fc.option(fc.integer({ min: 0, max: 50 }), { nil: undefined }), // attempt
      fc.integer({ min: 0, max: 3 }),                                  // rows updated
      async (attempt, updatedCount) => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { exec, lastText } = makeFakeExec({ count: updatedCount });
        await markOutboxOwnerUnreachable(exec, 'outbox-1', attempt);
        // Always writes the completed status + the marker, always attempt-guarded.
        expect(lastText()).toContain("status = 'completed'");
        expect(lastText()).toContain('completion_reason');
        expect(lastText()).toContain("status = 'dispatched'");
        // warnOutboxNoop iff a concrete attempt matched zero rows (superseded).
        const shouldWarn = typeof attempt === 'number' && updatedCount === 0;
        expect(warn).toHaveBeenCalledTimes(shouldWarn ? 1 : 0);
        warn.mockRestore();
      },
    ), { numRuns: 100 });
  });
});
```

- [ ] **Step 5: Run it, verify it fails**

Run: `pnpm test src/lib/shared/__tests__/outbox.test.ts`
Expected: FAIL — `markOutboxOwnerUnreachable` is not exported.

- [ ] **Step 6: Implement `markOutboxOwnerUnreachable`**

Add to `src/lib/shared/outbox.ts` (import the constant at top; place next to `markOutboxCompletedIfOwned`, reusing the private `dispatchedRow`/`warnOutboxNoop`/`hasAttempt`):

```typescript
import { OUTBOX_COMPLETION_REASON } from './outbox-completion-reason';

/**
 * Marks a send_notification outbox entry completed with a distinct
 * `owner_unreachable` reason — the approval draft's owner had ZERO verified
 * channel enrollments (NotificationWorker `no_verified_enrollments` branch), so
 * nothing was dispatched. Distinct from a plain markOutboxCompleted so
 * HealthAlertPoller + NotificationFailoverPoller can observe and escalate it.
 * Same attempt-guarded CAS semantics as markOutboxCompletedIfOwned: a stale
 * superseded attempt no-ops (0 rows logged + swallowed).
 */
export async function markOutboxOwnerUnreachable(
  exec: SqlExecutor,
  outboxId: string,
  attempt?: number,
): Promise<void> {
  const res = await exec`
    UPDATE job_outbox
    SET status = 'completed',
        completed_at = NOW(),
        completion_reason = ${OUTBOX_COMPLETION_REASON.OWNER_UNREACHABLE}
    WHERE ${dispatchedRow(exec, outboxId, attempt)}
  `;
  if (hasAttempt(attempt) && res.count === 0) {
    warnOutboxNoop('markOutboxOwnerUnreachable', outboxId, attempt);
  }
}
```

- [ ] **Step 7: Run the property test, verify PASS**

Run: `pnpm test src/lib/shared/__tests__/outbox.test.ts`
Expected: PASS (100 runs).

- [ ] **Step 8: Update migrations-log head to 083**

Edit `.claude/reference/migrations-log.md`: change the head line to `Current head: **083** — next migration is **084**` and add a one-line 083 entry describing the additive `completion_reason` column + partial index.

- [ ] **Step 9: Typecheck + commit**

Run: `pnpm typecheck`
Expected: clean.
```bash
git add supabase/migrations/083_outbox_owner_unreachable.sql src/lib/shared/outbox-completion-reason.ts src/lib/shared/outbox.ts src/lib/shared/__tests__/outbox.test.ts .claude/reference/migrations-log.md
git commit -m "feat(F1): owner_unreachable outbox marker + attempt-guarded CAS helper (migration 083)"
```

---

## Task 2: NotificationWorker records the marker (blocked by Task 1)

**Files:**
- Modify: `worker/jobs/notification/NotificationWorker.ts:75-83`
- Test: `worker/jobs/notification/__tests__/NotificationWorker.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `NotificationWorker.test.ts` (mirror the file's existing mock-sql harness). Assert that when `getEligibleChannels` resolves `{ ok:false, reason:'no_verified_enrollments' }`, the worker issues an UPDATE carrying `completion_reason` and does NOT call `dispatchAll`. Concretely, spy the mocked `sql` for a query containing `completion_reason` and assert `dispatchAll` (mocked) was not called.

```typescript
it('records owner_unreachable (not a silent complete) when no verified enrollments', async () => {
  // Arrange: loadNotificationContext -> notify kind; getEligibleChannels ->
  //          { ok:false, reason:'no_verified_enrollments' } (mock the module).
  await handleSendNotification(mockSql, job);
  const texts = mockSql.mock.calls.map((c: any) => c[0].join(''));
  expect(texts.some((t: string) => t.includes('completion_reason'))).toBe(true);
  expect(mockDispatchAll).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm test worker/jobs/notification/__tests__/NotificationWorker.test.ts`
Expected: FAIL — no `completion_reason` in any query.

- [ ] **Step 3: Swap the branch**

In `NotificationWorker.ts`, add the import and change ONLY the `no_verified_enrollments` branch (lines 75-83). Keep the other-reason branch (`logger.log` + `markOutboxCompleted`) unchanged.

```typescript
import { markOutboxOwnerUnreachable } from '../../../src/lib/shared/outbox';
// ...
  if (!eligibility.ok) {
    if (eligibility.reason === 'no_verified_enrollments') {
      logger.warn(`Location ${businessId} has no verified channel enrollments — recording owner_unreachable`);
      await markOutboxOwnerUnreachable(sql, outboxId, outboxAttempt);
      return;
    }
    logger.log(`Location ${businessId} skipped: ${eligibility.reason}`);
    await markOutboxCompleted(sql, outboxId, outboxAttempt);
    return;
  }
```

- [ ] **Step 4: Run it, verify PASS**

Run: `pnpm test worker/jobs/notification/__tests__/NotificationWorker.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/jobs/notification/NotificationWorker.ts worker/jobs/notification/__tests__/NotificationWorker.test.ts
git commit -m "feat(F1): NotificationWorker records owner_unreachable on no_verified_enrollments"
```

---

## Task 3: Durable health-alert check + de-conflation (blocked by Task 1)

**Files:**
- Modify: `worker/background/pollers/health-alert/checks.ts`
- Modify: `src/lib/config/worker.ts`
- Test: `worker/background/pollers/health-alert/__tests__/checks.test.ts`
- Create: `worker/background/pollers/health-alert/__tests__/checks.integration.test.ts`
- Modify: `.claude/reference/env-vars.md`

- [ ] **Step 1: Add the two env fields to `worker.ts`**

In `src/lib/config/worker.ts`, add next to the other `HEALTH_ALERT_*` entries:
```typescript
  HEALTH_ALERT_OWNER_UNREACHABLE_AGE_S: rawOpt,
  HEALTH_ALERT_OWNER_UNREACHABLE_THRESHOLD: rawOpt,
```

- [ ] **Step 2: Write the failing mock-sql shaping test + de-conflation regression**

In `checks.test.ts`: extend `CFG` with `ownerUnreachableAgeS: 3600, ownerUnreachableThreshold: 0`. Add:
```typescript
it('checkOwnerUnreachable returns a finding when count exceeds threshold', async () => {
  sqlReturnQueue.push([{ count: 2 }]);
  const finding = await checkOwnerUnreachable(mockSql, CFG);
  expect(finding?.key).toBe('owner_unreachable');
  expect(finding?.level).toBe('warning');
});
it('checkOwnerUnreachable returns null at/below threshold', async () => {
  sqlReturnQueue.push([{ count: 0 }]);
  expect(await checkOwnerUnreachable(mockSql, CFG)).toBeNull();
});
it('checkZeroDeliveryNotifications query excludes the owner_unreachable marker', async () => {
  sqlReturnQueue.push([{ count: 0 }]);
  await checkZeroDeliveryNotifications(mockSql, CFG);
  const text = mockSql.mock.calls.at(-1)![0].join('');
  expect(text).toContain('completion_reason');
});
```

- [ ] **Step 3: Run it, verify it fails**

Run: `pnpm test worker/background/pollers/health-alert/__tests__/checks.test.ts`
Expected: FAIL — `checkOwnerUnreachable` not exported; de-conflation clause absent.

- [ ] **Step 4: Implement config fields + the check + de-conflation**

In `checks.ts`: import the constant; extend `HealthAlertConfig` with `ownerUnreachableAgeS: number; ownerUnreachableThreshold: number;`; in `resolveHealthAlertConfig` add
```typescript
    ownerUnreachableAgeS: num(cfg.HEALTH_ALERT_OWNER_UNREACHABLE_AGE_S, 3600),
    ownerUnreachableThreshold: num(cfg.HEALTH_ALERT_OWNER_UNREACHABLE_THRESHOLD, 0),
```
Add the check (drives FROM `responses` so the COUNT is per-response, not per-attempt; age FLOOR; `approval_request`-scoped NOT EXISTS so the admin-email delivery can't erase the signal):
```typescript
import { OUTBOX_COMPLETION_REASON } from '../../../../src/lib/shared/outbox-completion-reason';

// Approval drafts whose owner has NO verified channel (marked owner_unreachable
// by NotificationWorker) that are STILL pending_approval on a live business and
// were never sent an approval_request. Durable: an age FLOOR (not a completion
// window), so it keeps firing every cycle until the owner enrolls a channel and
// the retried send delivers. Counts distinct responses (retries mark multiple
// outbox rows). The approval_request-scoped NOT EXISTS keeps the signal alive
// after the failover admin email (a different template) is recorded.
export async function checkOwnerUnreachable(sql: postgres.Sql, cfg: HealthAlertConfig): Promise<HealthFinding | null> {
  const [row] = await sql<{ count: number }[]>`
    SELECT COUNT(*)::int AS count
    FROM responses r
    JOIN businesses b ON b.id = r.business_id
    WHERE r.status = 'pending_approval'
      AND b.archived_at IS NULL
      AND r.created_at < NOW() - make_interval(secs => ${cfg.ownerUnreachableAgeS})
      AND EXISTS (
        SELECT 1 FROM job_outbox jo
        WHERE jo.topic = ${QUEUE_NAMES.SEND_NOTIFICATION}
          AND jo.aggregate_id = r.id
          AND jo.completion_reason = ${OUTBOX_COMPLETION_REASON.OWNER_UNREACHABLE}
      )
      AND NOT EXISTS (
        SELECT 1 FROM notification_deliveries nd
        WHERE nd.response_id = r.id AND nd.template = 'approval_request'
      )
  `;
  const count = row?.count ?? 0;
  if (count <= cfg.ownerUnreachableThreshold) return null;
  return {
    key: 'owner_unreachable',
    level: 'warning',
    title: `${count} approval draft(s) have no verified owner channel (owner-unreachable > ${cfg.ownerUnreachableAgeS}s) — owners cannot be notified`,
    detail: { count, age_floor_s: cfg.ownerUnreachableAgeS },
  };
}
```
De-conflate `checkZeroDeliveryNotifications`: add to its WHERE (so it no longer double-counts the marked rows; it becomes the genuine dispatch-drop net):
```sql
      AND jo.completion_reason IS DISTINCT FROM ${OUTBOX_COMPLETION_REASON.OWNER_UNREACHABLE}
```
Register in `runHealthChecks`, in the SEQUENTIAL block (do NOT introduce Promise.all — #505), right after `checkZeroDeliveryNotifications`:
```typescript
  collect(await checkOwnerUnreachable(sql, cfg));
```

- [ ] **Step 5: Run the shaping test, verify PASS**

Run: `pnpm test worker/background/pollers/health-alert/__tests__/checks.test.ts`
Expected: PASS.

- [ ] **Step 6: Write the real-PG integration test (predicate semantics)**

Create `checks.integration.test.ts` (mirror `src/lib/auto-approval/__tests__/suspension.integration.test.ts`: `const testDatabaseUrl = process.env.TEST_DATABASE_POOL_URL;` + `describe.skipIf(!testDatabaseUrl)`; open a real postgres client; seed with FK-ordered inserts; clean up in reverse). Cases:
  1. Marked + pending_approval + live + aged + no approval_request delivery → `checkOwnerUnreachable` count ≥ 1.
  2. Same row + an admin-template delivery row (`template='admin_notification_owner_unreachable'`) → still counted (no self-erase).
  3. Same row + an `approval_request` delivery row → count 0 (self-clearing).
  4. Below the age floor / business archived / marker absent → count 0.
  5. Marked row → `checkZeroDeliveryNotifications` count 0 (de-conflation); an unmarked zero-delivery pending row → `checkZeroDeliveryNotifications` count ≥ 1.

- [ ] **Step 7: Run integration test (skips without DB; run against a real test DB if available)**

Run: `pnpm test worker/background/pollers/health-alert/__tests__/checks.integration.test.ts`
Expected: SKIP without `TEST_DATABASE_POOL_URL`; PASS against a real test DB (also exercised on staging in step 8).

- [ ] **Step 8: Update env-vars.md**

Edit `.claude/reference/env-vars.md`: document `HEALTH_ALERT_OWNER_UNREACHABLE_AGE_S` (default 3600 — age floor before an owner-unreachable draft counts) and `HEALTH_ALERT_OWNER_UNREACHABLE_THRESHOLD` (default 0 — fire on any count above this).

- [ ] **Step 9: Typecheck + commit**

Run: `pnpm typecheck`
```bash
git add worker/background/pollers/health-alert/checks.ts worker/background/pollers/health-alert/__tests__/checks.test.ts worker/background/pollers/health-alert/__tests__/checks.integration.test.ts src/lib/config/worker.ts .claude/reference/env-vars.md
git commit -m "feat(F1): durable checkOwnerUnreachable health finding + de-conflate zero-delivery check"
```

---

## Task 4: NotificationFailoverPoller owner-unreachable arm (blocked by Task 1)

**Files:**
- Modify: `worker/background/pollers/NotificationFailoverPoller.ts`
- Test: `worker/background/pollers/__tests__/NotificationFailoverPoller.test.ts`

- [ ] **Step 1: Write the failing test**

In `NotificationFailoverPoller.test.ts` (hoisted mock-sql queue + `mockSendInternalEmail`). Queue a single owner-unreachable candidate row for the new arm's SELECT, then assert: (a) `tryClaimAlert` path sends an email with the new template, and (b) a re-enqueue INSERT (query text contains `job_outbox` + `send_notification`) is issued. Then a second case where an in-flight row exists → the guarded INSERT is a no-op (`WHERE NOT EXISTS ...` in the text; assert no new pending row semantics). Follow the ordering the existing arms use in this test file.

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm test worker/background/pollers/__tests__/NotificationFailoverPoller.test.ts`
Expected: FAIL — no owner-unreachable arm.

- [ ] **Step 3: Implement the arm as a named function**

In `NotificationFailoverPoller.ts`, add `import { OUTBOX_COMPLETION_REASON } from '../../../src/lib/shared/outbox-completion-reason';` and a `processOwnerUnreachable(logger)` helper (keeps `runFailoverPollerOnce` a thin orchestrator — invariant #12). Call it from `runFailoverPollerOnce` after the stale arm. Disjoint by construction: `NOT EXISTS(approval_request delivery)` vs the all-failed/stale arms which require one. Add a per-response age gate mirroring the 4h the other arms use. Template: `admin_notification_owner_unreachable`.

```typescript
// ── 3. Owner-unreachable: pending_approval, marked owner_unreachable, and NO
// approval_request delivery was ever recorded (disjoint from all-failed/stale,
// which both require an approval_request delivery). Re-enqueue send_notification
// (self-clears once the owner enrolls a channel) + one 24h-deduped admin email.
async function processOwnerUnreachable(logger: ReturnType<typeof createWorkerLogger>): Promise<void> {
  const rows = await sql<{
    response_id: string; business_id: string; account_id: string;
    business_name: string; reviewer_name: string; star_rating: number;
  }[]>`
    SELECT resp.id AS response_id, resp.business_id,
           b.account_id, b.name AS business_name, r.reviewer_name, r.star_rating
    FROM responses resp
    JOIN businesses b ON resp.business_id = b.id
    JOIN reviews r ON resp.review_id = r.id
    WHERE resp.status = 'pending_approval'
      AND b.archived_at IS NULL
      AND resp.created_at < NOW() - INTERVAL '4 hours'
      AND EXISTS (
        SELECT 1 FROM job_outbox jo
        WHERE jo.topic = ${QUEUE_NAMES.SEND_NOTIFICATION}
          AND jo.aggregate_id = resp.id
          AND jo.completion_reason = ${OUTBOX_COMPLETION_REASON.OWNER_UNREACHABLE}
      )
      AND NOT EXISTS (
        SELECT 1 FROM notification_deliveries nd
        WHERE nd.response_id = resp.id AND nd.template = 'approval_request'
      )
      AND NOT EXISTS (
        SELECT 1 FROM job_outbox jo
        WHERE jo.topic = ${QUEUE_NAMES.SEND_NOTIFICATION}
          AND jo.aggregate_id = resp.id
          AND jo.status IN ('pending', 'dispatching', 'dispatched')
      )
    ORDER BY resp.created_at ASC
    LIMIT ${BATCH_LIMIT}
  `;

  const adminEmail = getWorkerConfig().ADMIN_NOTIFICATION_EMAIL;
  for (const row of rows) {
    if (adminEmail) {
      const outcome = await tryClaimAlert(
        row.response_id,
        'admin_notification_owner_unreachable',
        adminEmail,
        async () => {
          const { messageId } = await sendInternalEmail({
            to: adminEmail,
            subject: `Owner unreachable: ${row.business_name} — no verified notification channel`,
            bodyHtml: `<p>A draft response to <strong>${escapeHtml(row.reviewer_name)}</strong>'s ${row.star_rating}-star review of <strong>${escapeHtml(row.business_name)}</strong> cannot be delivered: the owner has <strong>no verified notification channel</strong>. Help them enroll a channel; the system will auto-deliver once one is verified.</p><p><em>Response ID: ${row.response_id}</em></p>`,
            category: 'internal',
          });
          return messageId;
        },
        { accountId: row.account_id, businessId: row.business_id, responseId: row.response_id },
      );
      if (outcome === 'send_error') {
        logger.error('Failed to send owner-unreachable alert', { response_id: row.response_id });
      }
    }

    const payload: SendNotificationPayload = {
      response_id: row.response_id,
      business_id: row.business_id,
      failover: { reason: 'owner_unreachable_retry' },
      correlation_id: await recoverFailoverCorrelationId(row.response_id),
    };
    try {
      await sql`
        INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
        SELECT ${uuidv7()}, ${QUEUE_NAMES.SEND_NOTIFICATION}, 'response', ${row.response_id}, ${jsonb(payload)}, 'pending'
        WHERE NOT EXISTS (
          SELECT 1 FROM job_outbox jo
          WHERE jo.topic = ${QUEUE_NAMES.SEND_NOTIFICATION}
            AND jo.aggregate_id = ${row.response_id}
            AND jo.status IN ('pending', 'dispatching', 'dispatched')
        )
      `;
    } catch (err: unknown) {
      if ((err as { code?: string }).code === '23505') continue;
      logger.error('Failed to queue owner-unreachable retry', { response_id: row.response_id }, toError(err));
    }
  }
  if (rows.length > 0) logger.log('Processed owner-unreachable responses', { count: rows.length });
}
```
Confirm `SendNotificationPayload.failover.reason` is a widenable string (add `'owner_unreachable_retry'` to its union if it is a literal union in `worker-types.ts`).

- [ ] **Step 4: Run it, verify PASS**

Run: `pnpm test worker/background/pollers/__tests__/NotificationFailoverPoller.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/background/pollers/NotificationFailoverPoller.ts worker/background/pollers/__tests__/NotificationFailoverPoller.test.ts
git commit -m "feat(F1): NotificationFailoverPoller owner-unreachable arm (retry + 24h-deduped admin email)"
```

---

## Task 5: Glossary + ADR (after 1–4)

**Files:**
- Modify: `CONTEXT.md`
- Create: `docs/adr/0010-owner-unreachable-outcome.md`

- [ ] **Step 1: Add the glossary term to CONTEXT.md** (verbatim from the Glossary section above).

- [ ] **Step 2: Write ADR 0010** recording: (a) modeled as a `job_outbox.completion_reason` marker, NOT a new `responses.status` (blast-radius avoidance; the draft is still legitimately pending_approval); (b) durable age-floor health check vs the transient windowed zero-delivery check, and the de-conflation; (c) poller-driven retry (reuse `NotificationFailoverPoller` cadence, self-clearing) chosen over event-driven re-notify (smaller surface, resilient); (d) both escalation surfaces (Sentry finding + 24h-deduped admin email). Note the map-level correction: `checkZeroDeliveryNotifications` already partially observed the case (within its 1h window) — F1 makes it distinct + durable.

- [ ] **Step 3: Commit**

```bash
git add CONTEXT.md docs/adr/0010-owner-unreachable-outcome.md
git commit -m "docs(F1): glossary term + ADR 0010 for owner-unreachable outcome"
```

---

## Self-Review (completed)

- **Spec coverage:** distinct marker (T1) · worker records it (T2) · durable health check + de-conflation (T3) · retry + admin email (T4) · docs/ADR (T5). All intake `user_visible_behavior` + `tests_to_add` map to a task. ✓
- **Type consistency:** `markOutboxOwnerUnreachable(exec, outboxId, attempt)` · `OUTBOX_COMPLETION_REASON.OWNER_UNREACHABLE` · `checkOwnerUnreachable(sql, cfg)` · config `ownerUnreachableAgeS`/`ownerUnreachableThreshold` — consistent across tasks. ✓
- **Placeholders:** none — concrete SQL/TS in every implementation step; test scaffolding references exact precedent harness files (repo-readable). ✓
- **Open risks for reviewers:** (1) `SendNotificationPayload.failover.reason` union may need widening; (2) `CREATE INDEX CONCURRENTLY` must be applied outside a txn — staging first, prod in lockstep; (3) `checkOwnerUnreachable` `level:'warning'` is a tunable call (owner-unreachable is real "owner not told" but partly expected during onboarding — age floor + threshold dampen noise).
