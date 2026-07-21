# F1 — Owner-Unreachable Escalation Implementation Plan (rev 2, post-codex)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. Every path is relative to the worktree root `RepWorth-worktrees/f1-owner-unreachable-escalation/`.

**Goal:** Model the notification *owner-unreachable outcome* (an approval draft whose account/location has zero verified channel enrollments at send time — the `no_verified_enrollments` branch) as a distinct `job_outbox.completion_reason='owner_unreachable'` marker instead of a silent `markOutboxCompleted`; observe it with a durable health-alert check; escalate + retry it on the `NotificationFailoverPoller` cadence.

**Architecture:** The worker's authoritative "no verified enrollment" verdict is persisted as an additive `job_outbox.completion_reason` marker (single source — read, never re-derived). Owner-unreachable is **current-state, not sticky**: the health check and poller arm key off the **latest completed `send_notification`'s** reason, so a later non-owner_unreachable completion (subscription-skip retry, or a successful delivery) supersedes a stale marker. A new `checkOwnerUnreachable` health finding observes it with a **4h age floor** (durable, unlike the windowed `checkZeroDeliveryNotifications`, which is de-conflated to exclude the marker). A disjoint third arm of `NotificationFailoverPoller` re-enqueues `send_notification` inside a **per-response advisory-locked transaction** (at-most-once across concurrent pollers) and sends a best-effort 24h-deduped admin email. No new external seam; no new index (migration 082 already provides the lookups); every change deepens an existing module.

**Tech Stack:** Postgres.js `sql` tagged templates + `sql.begin`/`pg_advisory_xact_lock`; BullMQ/job_outbox outbox; Vitest (mock-sql `.test.ts` for shaping/control-flow + `.integration.test.ts` for SQL-predicate semantics — **CI provisions `TEST_DATABASE_POOL_URL` and applies all migrations, so these run in CI**); fast-check (property test); Sentry (health findings).

**Glossary (CONTEXT.md, verbatim):**
- **Owner-unreachable outcome** — the notification result when an approval draft's account/location has zero verified channel enrollments at send time (`no_verified_enrollments`), recorded as `job_outbox.completion_reason='owner_unreachable'` on the completed `send_notification` row, and *current* only while that is the **latest** completed `send_notification` for the response. Distinct from **all-failed** (a delivery was attempted on an enrolled channel and every attempt failed) and **stale** (delivered but the owner hasn't acted). The draft stays `pending_approval` and is retried on the `NotificationFailoverPoller` cadence until a channel appears.

**Codex round-1 findings resolved in this rev:** age-floor reconciled to 4h (§1); latest-reason predicate handles subscription-blocked retry (§2); advisory-locked at-most-once re-enqueue (§3); index dropped — 082 already covers the lookups (§4); `worker-types.ts` added to surface (§6, signed off); real test harness + honest property/worker/poller tests + fixture shift (§7). Known residual (out of F1 scope, follow-up): `checkZeroDeliveryNotifications` still fires on subscription-skip / all-flag-disabled zero-delivery completions (§5) — those need their own markers.

---

## File Structure

| File | Create/Modify | Responsibility |
|---|---|---|
| `supabase/migrations/083_outbox_owner_unreachable.sql` | Create | Additive nullable `completion_reason` column (no index) |
| `src/lib/shared/outbox-completion-reason.ts` | Create | Typed constant for the marker value |
| `src/lib/shared/outbox.ts` | Modify | Add `markOutboxOwnerUnreachable` (attempt-guarded CAS) |
| `src/lib/shared/__tests__/outbox.test.ts` | Modify | fast-check property test (guard composition + noop-warn) |
| `src/lib/shared/worker-types.ts` | Modify | Widen `SendNotificationPayload.failover.reason` union |
| `worker/jobs/notification/NotificationWorker.ts` | Modify | `no_verified_enrollments` branch → new helper |
| `worker/jobs/notification/__tests__/NotificationWorker.test.ts` | Modify | Branch calls the mocked helper; no dispatch |
| `worker/background/pollers/health-alert/checks.ts` | Modify | `checkOwnerUnreachable` (latest-reason, 4h floor) + config + de-conflate |
| `worker/background/pollers/health-alert/__tests__/checks.test.ts` | Modify | Shaping + de-conflation + `runHealthChecks` fixture shift |
| `worker/background/pollers/health-alert/__tests__/checks.integration.test.ts` | Create | Real-PG predicate invariants |
| `src/lib/config/worker.ts` | Modify | `HEALTH_ALERT_OWNER_UNREACHABLE_AGE_S` + `_THRESHOLD` |
| `worker/background/pollers/NotificationFailoverPoller.ts` | Modify | Disjoint `processOwnerUnreachable` arm (advisory-locked retry) |
| `worker/background/pollers/__tests__/NotificationFailoverPoller.test.ts` | Modify | Arm control-flow (mock-sql) |
| `worker/background/pollers/__tests__/NotificationFailoverPoller.integration.test.ts` | Create | Real-PG: predicate disjointness/self-clearing + at-most-once |
| `.claude/reference/migrations-log.md` · `.claude/reference/env-vars.md` · `CONTEXT.md` · `docs/adr/0010-owner-unreachable-outcome.md` | Modify/Create | Docs |

**Blocking edges:** Task 1 blocks 2/3/4 (they consume the column + constant). 2, 3, 4 are independent. Task 5 (docs/ADR) after 1–4.

**Shared predicate (single source — copy verbatim into the health check, the poller-arm SELECT, and the integration fixtures):** a response `r` is **owner-unreachable now** iff:
```
r.status = 'pending_approval'
AND b.archived_at IS NULL
AND r.created_at < NOW() - <age floor>
AND ( SELECT jo.completion_reason FROM job_outbox jo
      WHERE jo.topic = 'send_notification' AND jo.aggregate_id = r.id AND jo.status = 'completed'
      ORDER BY jo.completed_at DESC LIMIT 1 ) = 'owner_unreachable'
AND NOT EXISTS ( SELECT 1 FROM notification_deliveries nd
                 WHERE nd.response_id = r.id AND nd.template = 'approval_request' )
```
The correlated subquery reads the **latest** completed send_notification reason; `= 'owner_unreachable'` is NULL-safe (a later NULL-reason completion or no completion → not equal → excluded). The `approval_request`-scoped `NOT EXISTS` means the admin-email delivery (a different template) can't erase the signal, and a real delivery clears it.

---

## Task 1: Marker foundation — migration, constant, CAS helper, property test

**Files:** Create `supabase/migrations/083_outbox_owner_unreachable.sql`, `src/lib/shared/outbox-completion-reason.ts`; Modify `src/lib/shared/outbox.ts`, `src/lib/shared/__tests__/outbox.test.ts`, `.claude/reference/migrations-log.md`.

- [ ] **Step 1: Confirm head + read 082** — read `.claude/reference/migrations-log.md` (head 082 → next 083) and `supabase/migrations/082_failover_lookup_indexes.sql` (note it already provides `idx_jo_send_notification_by_aggregate` and `idx_responses_pending_approval_created` — the lookups this feature needs; **no new index required**).

- [ ] **Step 2: Write migration 083 (pure ADD COLUMN, no index)**

`supabase/migrations/083_outbox_owner_unreachable.sql`:
```sql
-- 083_outbox_owner_unreachable.sql
-- F1 (docs/superpowers/plans/2026-07-16-prod-hardening-followup-map.md): distinct
-- owner-unreachable notification outcome. A send_notification job that completes
-- because the owner has zero verified channel enrollments records
-- completion_reason='owner_unreachable' on its completed job_outbox row, so
-- HealthAlertPoller.checkOwnerUnreachable and the NotificationFailoverPoller
-- owner-unreachable arm can observe + escalate it. Additive nullable column; all
-- other topics and existing rows keep NULL and unchanged behavior.
--
-- NO INDEX: the owner-unreachable lookups drive FROM responses
-- (idx_responses_pending_approval_created, migration 082) and correlate to
-- send_notification rows by aggregate_id (idx_jo_send_notification_by_aggregate,
-- migration 082) — both already exist. ADD COLUMN of a nullable, no-default
-- column is metadata-only, but bound the brief ACCESS EXCLUSIVE lock so it can't
-- queue behind a long write on the hot job_outbox table. Apply staging first,
-- then prod in lockstep.
BEGIN;
SET LOCAL lock_timeout = '3s';
ALTER TABLE job_outbox ADD COLUMN IF NOT EXISTS completion_reason TEXT;
COMMIT;
```

- [ ] **Step 3: Typed constant** — `src/lib/shared/outbox-completion-reason.ts`:
```typescript
// Single authoritative owner for the job_outbox.completion_reason vocabulary.
// Import this constant wherever the marker value is written or read — never a
// bare 'owner_unreachable' string literal (repworth.md). Column added in 083.
export const OUTBOX_COMPLETION_REASON = {
  OWNER_UNREACHABLE: 'owner_unreachable',
} as const;

export type OutboxCompletionReason =
  (typeof OUTBOX_COMPLETION_REASON)[keyof typeof OUTBOX_COMPLETION_REASON];
```

- [ ] **Step 4: Write the failing property test**

Append to `src/lib/shared/__tests__/outbox.test.ts` (it already hoists `createMockSql` → `{ mockSql, sqlReturnQueue, sqlCalls, resetMockSql }`, `mkTaggedResult`, and casts `execMock`). The pure invariant: the helper always composes the completed-status + marker write, attempt-guards iff a concrete attempt is supplied, and no-ops-with-warn iff a concrete attempt matched zero rows.
```typescript
import fc from 'fast-check';
import { markOutboxOwnerUnreachable } from '../outbox';
import { OUTBOX_COMPLETION_REASON } from '../outbox-completion-reason';

describe('markOutboxOwnerUnreachable (invariants)', () => {
  it('composes the marker + attempt-guard and no-ops-with-warn on a superseded attempt', async () => {
    await fc.assert(fc.asyncProperty(
      fc.option(fc.integer({ min: 0, max: 50 }), { nil: undefined }), // attempt
      fc.boolean(),                                                    // guarded row matched?
      async (attempt, matched) => {
        resetMockSql();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        sqlReturnQueue.push(mkTaggedResult(matched ? [{ id: 'x' }] : []));
        await markOutboxOwnerUnreachable(execMock, 'outbox-1', attempt);
        const q = sqlCalls.at(-1)!;
        expect(q.text).toContain("SET status = 'completed'");
        expect(q.text).toContain('completion_reason');
        expect(q.values).toContain(OUTBOX_COMPLETION_REASON.OWNER_UNREACHABLE);
        if (typeof attempt === 'number') {
          expect(q.text).toContain("status = 'dispatched'");
          expect(q.text).toContain('attempts =');
          expect(q.values).toContain(attempt);
        } else {
          expect(q.text).not.toContain('attempts =');
        }
        expect(warn).toHaveBeenCalledTimes(typeof attempt === 'number' && !matched ? 1 : 0);
        warn.mockRestore();
      },
    ), { numRuns: 100 });
  });
});
```

- [ ] **Step 5: Run, verify FAIL** — `pnpm test src/lib/shared/__tests__/outbox.test.ts` → FAIL (`markOutboxOwnerUnreachable` not exported).

- [ ] **Step 6: Implement the helper** — add to `src/lib/shared/outbox.ts` (import the constant; place beside `markOutboxCompletedIfOwned`, reusing private `dispatchedRow`/`warnOutboxNoop`/`hasAttempt`):
```typescript
import { OUTBOX_COMPLETION_REASON } from './outbox-completion-reason';

/**
 * Marks a send_notification outbox entry completed with a distinct
 * `owner_unreachable` reason — the approval draft's owner had ZERO verified
 * channel enrollments (NotificationWorker `no_verified_enrollments` branch), so
 * nothing was dispatched. Distinct from a plain markOutboxCompleted so
 * HealthAlertPoller + NotificationFailoverPoller can observe + escalate it. Same
 * attempt-guarded CAS as markOutboxCompletedIfOwned: a stale superseded attempt
 * no-ops (0 rows logged + swallowed). Idempotent re-marking on a later retry is
 * expected; downstream reads the LATEST completed reason, not the mere presence.
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

- [ ] **Step 7: Run, verify PASS** — `pnpm test src/lib/shared/__tests__/outbox.test.ts` → PASS (100 runs).

- [ ] **Step 8: migrations-log** — set head to `083` / next `084`, add a one-line 083 entry (additive `completion_reason`, no index — reuses 082 indexes).

- [ ] **Step 9: Typecheck + commit** — `pnpm typecheck`; then `git add` the five files, `git commit -m "feat(F1): owner_unreachable outbox marker + attempt-guarded CAS helper (migration 083)"`.

---

## Task 2: NotificationWorker records the marker (blocked by Task 1)

**Files:** Modify `worker/jobs/notification/NotificationWorker.ts:75-83`; `worker/jobs/notification/__tests__/NotificationWorker.test.ts`.

- [ ] **Step 1: Write the failing test** — the suite already `vi.mock`s the outbox module (so its helpers are `vi.fn`s). Import the mocked `markOutboxOwnerUnreachable` + `markOutboxCompleted` and assert the branch calls the new helper (not the plain one) and never dispatches. Ensure the outbox mock object exports `markOutboxOwnerUnreachable`.
```typescript
it('records owner_unreachable via the helper when no verified enrollments (no dispatch)', async () => {
  // getEligibleChannels mocked -> { ok:false, reason:'no_verified_enrollments' }
  await handleSendNotification(mockSql, job);
  expect(markOutboxOwnerUnreachable).toHaveBeenCalledWith(mockSql, expect.any(String), expect.anything());
  expect(markOutboxCompleted).not.toHaveBeenCalled();
  expect(mockDispatchAll).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run, verify FAIL** — `pnpm test worker/jobs/notification/__tests__/NotificationWorker.test.ts` → FAIL.

- [ ] **Step 3: Swap only the `no_verified_enrollments` branch** in `NotificationWorker.ts` (add the import; leave the other-reason branch on `markOutboxCompleted`):
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

- [ ] **Step 4: Run, verify PASS** — `pnpm test worker/jobs/notification/__tests__/NotificationWorker.test.ts` → PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat(F1): NotificationWorker records owner_unreachable on no_verified_enrollments"`.

---

## Task 3: Durable health-alert check + de-conflation (blocked by Task 1)

**Files:** Modify `worker/background/pollers/health-alert/checks.ts`, `src/lib/config/worker.ts`, `worker/background/pollers/health-alert/__tests__/checks.test.ts`; Create `worker/background/pollers/health-alert/__tests__/checks.integration.test.ts`; Modify `.claude/reference/env-vars.md`.

- [ ] **Step 1: Config fields** — in `src/lib/config/worker.ts` add next to the `HEALTH_ALERT_*` entries: `HEALTH_ALERT_OWNER_UNREACHABLE_AGE_S: rawOpt,` and `HEALTH_ALERT_OWNER_UNREACHABLE_THRESHOLD: rawOpt,`.

- [ ] **Step 2: Failing mock-sql tests** — in `checks.test.ts`: extend `CFG` with `ownerUnreachableAgeS: 14400, ownerUnreachableThreshold: 0`. Add: (a) `checkOwnerUnreachable` returns a `key:'owner_unreachable'`, `level:'warning'` finding when the queued count > threshold; (b) returns null at/below threshold; (c) `checkZeroDeliveryNotifications`'s last query text contains `completion_reason` (de-conflation clause present). **Also** update the `runHealthChecks` test's ordered `sqlReturnQueue` fixtures to insert one extra row for the new check in its sequential slot (immediately after `checkZeroDeliveryNotifications`).

- [ ] **Step 3: Run, verify FAIL** — `pnpm test worker/background/pollers/health-alert/__tests__/checks.test.ts` → FAIL.

- [ ] **Step 4: Implement** — in `checks.ts`: import `OUTBOX_COMPLETION_REASON`; extend `HealthAlertConfig` with `ownerUnreachableAgeS: number; ownerUnreachableThreshold: number;`; in `resolveHealthAlertConfig` add `ownerUnreachableAgeS: num(cfg.HEALTH_ALERT_OWNER_UNREACHABLE_AGE_S, 14400),` and `ownerUnreachableThreshold: num(cfg.HEALTH_ALERT_OWNER_UNREACHABLE_THRESHOLD, 0),` (14400s = 4h, matching the poller-arm floor). Add the check (uses the **shared predicate** — latest-reason subquery + `approval_request`-scoped NOT EXISTS):
```typescript
import { OUTBOX_COMPLETION_REASON } from '../../../../src/lib/shared/outbox-completion-reason';

// Approval drafts whose owner has NO verified channel — the LATEST completed
// send_notification was owner_unreachable AND no approval_request was ever
// delivered — still pending_approval on a live business past the age FLOOR.
// Durable (a floor, not a completion window): keeps firing every cycle until the
// owner enrolls and the retried send delivers (an approval_request row clears it)
// or a later non-owner_unreachable completion (subscription-skip retry)
// supersedes the marker. Counts distinct responses. The approval_request-scoped
// NOT EXISTS keeps the signal alive after the failover admin email (different
// template) is recorded.
export async function checkOwnerUnreachable(sql: postgres.Sql, cfg: HealthAlertConfig): Promise<HealthFinding | null> {
  const [row] = await sql<{ count: number }[]>`
    SELECT COUNT(*)::int AS count
    FROM responses r
    JOIN businesses b ON b.id = r.business_id
    WHERE r.status = 'pending_approval'
      AND b.archived_at IS NULL
      AND r.created_at < NOW() - make_interval(secs => ${cfg.ownerUnreachableAgeS})
      AND (
        SELECT jo.completion_reason
        FROM job_outbox jo
        WHERE jo.topic = ${QUEUE_NAMES.SEND_NOTIFICATION}
          AND jo.aggregate_id = r.id
          AND jo.status = 'completed'
        ORDER BY jo.completed_at DESC
        LIMIT 1
      ) = ${OUTBOX_COMPLETION_REASON.OWNER_UNREACHABLE}
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
De-conflate `checkZeroDeliveryNotifications` — add to its WHERE so it stops double-counting the marker (the genuine dispatch-drop net; NOTE it still fires on subscription-skip / all-flag-disabled zero-delivery — out of F1 scope, see follow-up):
```sql
      AND jo.completion_reason IS DISTINCT FROM ${OUTBOX_COMPLETION_REASON.OWNER_UNREACHABLE}
```
Register in `runHealthChecks`, in the SEQUENTIAL block (do NOT add Promise.all — #505), right after `checkZeroDeliveryNotifications`: `collect(await checkOwnerUnreachable(sql, cfg));`.

- [ ] **Step 5: Run, verify PASS** — `pnpm test worker/background/pollers/health-alert/__tests__/checks.test.ts` → PASS.

- [ ] **Step 6: Real-PG integration test** — create `checks.integration.test.ts` mirroring `src/lib/auto-approval/__tests__/suspension.integration.test.ts` (`const testDatabaseUrl = process.env.TEST_DATABASE_POOL_URL; (testDatabaseUrl ? describe : describe.skip)(...)`; open a real postgres client; FK-ordered seed; reverse cleanup). Cases:
  1. Latest completed send_notification = owner_unreachable + pending_approval + live + aged + no approval_request delivery → count ≥ 1.
  2. + an admin-template delivery (`template='admin_notification_owner_unreachable'`) → still counted (no self-erase).
  3. + an `approval_request` delivery → count 0 (self-clearing).
  4. A **later** completed send_notification with `completion_reason IS NULL` (simulating a subscription-skip retry) → count 0 (marker superseded — the §2 fix).
  5. Below the age floor / business archived / no completed send_notification → count 0.
  6. `checkZeroDeliveryNotifications`: marker row → count 0 (de-conflation); an unmarked pending zero-delivery row → count ≥ 1.

- [ ] **Step 7: Run** — `pnpm test worker/background/pollers/health-alert/__tests__/checks.integration.test.ts` → SKIP without `TEST_DATABASE_POOL_URL`; PASS against a real DB (and in CI, which provisions it).

- [ ] **Step 8: env-vars.md** — document `HEALTH_ALERT_OWNER_UNREACHABLE_AGE_S` (default 14400 — 4h age floor) and `HEALTH_ALERT_OWNER_UNREACHABLE_THRESHOLD` (default 0 — fire above this count).

- [ ] **Step 9: Typecheck + commit** — `pnpm typecheck`; `git commit -m "feat(F1): durable checkOwnerUnreachable (latest-reason, 4h floor) + de-conflate zero-delivery"`.

---

## Task 4: NotificationFailoverPoller owner-unreachable arm (blocked by Task 1)

**Files:** Modify `worker/background/pollers/NotificationFailoverPoller.ts`, `src/lib/shared/worker-types.ts`, `worker/background/pollers/__tests__/NotificationFailoverPoller.test.ts`; Create `worker/background/pollers/__tests__/NotificationFailoverPoller.integration.test.ts`.

- [ ] **Step 1: Widen the payload union** — `src/lib/shared/worker-types.ts:63-65`:
```typescript
  failover?: {
    reason: 'all_deliveries_failed' | 'owner_unreachable_retry';
  };
```

- [ ] **Step 2: Failing control-flow test** — in `NotificationFailoverPoller.test.ts` (hoisted mock-sql queue + `mockSendInternalEmail`; `pg_advisory_xact_lock` is a no-op that does not dequeue): queue one owner-unreachable candidate for the arm's SELECT, then the in-flight re-check (empty → proceed) and the INSERT. Assert: (a) an email is sent via the `admin_notification_owner_unreachable` template; (b) an INSERT into `job_outbox` with `send_notification` is issued. Second case: in-flight re-check returns a row → assert **no** INSERT. Match the queue ordering the existing arms use.

- [ ] **Step 3: Run, verify FAIL** — `pnpm test worker/background/pollers/__tests__/NotificationFailoverPoller.test.ts` → FAIL.

- [ ] **Step 4: Implement the arm** — in `NotificationFailoverPoller.ts` add `import { OUTBOX_COMPLETION_REASON } from '../../../src/lib/shared/outbox-completion-reason';`. Add `processOwnerUnreachable(logger)` and call it from `runFailoverPollerOnce` after the stale arm (keeps `runFailoverPollerOnce` a thin orchestrator — invariant #12). Disjoint by construction (`NOT EXISTS approval_request delivery`). Re-enqueue is **advisory-locked** for at-most-once across concurrent pollers (the plain `WHERE NOT EXISTS` is not race-safe — no unique in-flight index):
```typescript
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
      AND (
        SELECT jo.completion_reason FROM job_outbox jo
        WHERE jo.topic = ${QUEUE_NAMES.SEND_NOTIFICATION}
          AND jo.aggregate_id = resp.id AND jo.status = 'completed'
        ORDER BY jo.completed_at DESC LIMIT 1
      ) = ${OUTBOX_COMPLETION_REASON.OWNER_UNREACHABLE}
      AND NOT EXISTS (
        SELECT 1 FROM notification_deliveries nd
        WHERE nd.response_id = resp.id AND nd.template = 'approval_request'
      )
    ORDER BY resp.created_at ASC
    LIMIT ${BATCH_LIMIT}
  `;

  const adminEmail = getWorkerConfig().ADMIN_NOTIFICATION_EMAIL;
  for (const row of rows) {
    if (adminEmail) {
      const outcome = await tryClaimAlert(
        row.response_id, 'admin_notification_owner_unreachable', adminEmail,
        async () => {
          const { messageId } = await sendInternalEmail({
            to: adminEmail,
            subject: `Owner unreachable: ${row.business_name} — no verified notification channel`,
            bodyHtml: `<p>A draft response to <strong>${escapeHtml(row.reviewer_name)}</strong>'s ${row.star_rating}-star review of <strong>${escapeHtml(row.business_name)}</strong> cannot be delivered: the owner has <strong>no verified notification channel</strong>. Help them enroll one; the system auto-delivers once a channel is verified.</p><p><em>Response ID: ${row.response_id}</em></p>`,
            category: 'internal',
          });
          return messageId;
        },
        { accountId: row.account_id, businessId: row.business_id, responseId: row.response_id },
      );
      if (outcome === 'send_error') logger.error('Failed to send owner-unreachable alert', { response_id: row.response_id });
    }

    // At-most-once retry: advisory-lock the (response) key, re-check in-flight
    // INSIDE the lock, then INSERT — race-safe across concurrent pollers.
    const correlationId = await recoverFailoverCorrelationId(row.response_id);
    try {
      await sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext(${`send_notification_retry:${row.response_id}`}))`;
        const inFlight = await tx`
          SELECT 1 FROM job_outbox
          WHERE topic = ${QUEUE_NAMES.SEND_NOTIFICATION}
            AND aggregate_id = ${row.response_id}
            AND status IN ('pending', 'dispatching', 'dispatched')
          LIMIT 1
        `;
        if (inFlight.length > 0) return;
        const payload: SendNotificationPayload = {
          response_id: row.response_id,
          business_id: row.business_id,
          failover: { reason: 'owner_unreachable_retry' },
          correlation_id: correlationId,
        };
        await tx`
          INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
          VALUES (${uuidv7()}, ${QUEUE_NAMES.SEND_NOTIFICATION}, 'response', ${row.response_id}, ${tx.json(payload)}, 'pending')
        `;
      });
    } catch (err: unknown) {
      logger.error('Failed to queue owner-unreachable retry', { response_id: row.response_id }, toError(err));
    }
  }
  if (rows.length > 0) logger.log('Processed owner-unreachable responses', { count: rows.length });
}
```
Call it in `runFailoverPollerOnce` after the stale block: `await processOwnerUnreachable(logger);` (it is disjoint, so ordering vs all-failed/stale is not correctness-critical, but place it last).

- [ ] **Step 5: Run, verify PASS** — `pnpm test worker/background/pollers/__tests__/NotificationFailoverPoller.test.ts` → PASS.

- [ ] **Step 6: Real-PG integration test** — create `NotificationFailoverPoller.integration.test.ts` (gated on `TEST_DATABASE_POOL_URL`). Seed a real owner-unreachable response (latest completed send_notification marked, no approval_request delivery, aged, live) and assert one `send_notification` pending row is created + one admin delivery row (`admin_notification_owner_unreachable`). Negative cases: (a) an `approval_request` delivery exists → no retry (disjoint from stale/all-failed); (b) an in-flight send_notification exists → no new row; (c) run the arm twice → still exactly one in-flight row (at-most-once via the advisory-locked re-check).

- [ ] **Step 7: Run** — SKIP without `TEST_DATABASE_POOL_URL`; PASS against a real DB / in CI.

- [ ] **Step 8: Commit** — `pnpm typecheck`; `git commit -m "feat(F1): NotificationFailoverPoller owner-unreachable arm (advisory-locked retry + admin email)"`.

---

## Task 5: Glossary + ADR (after 1–4)

**Files:** Modify `CONTEXT.md`; Create `docs/adr/0010-owner-unreachable-outcome.md`.

- [ ] **Step 1: Glossary** — add the **Owner-unreachable outcome** term (verbatim from the Glossary section above) to `CONTEXT.md`.

- [ ] **Step 2: ADR 0010** — record: (a) modeled as `job_outbox.completion_reason` marker, NOT a new `responses.status` (blast-radius; the draft is legitimately still pending_approval); (b) **current-state via latest completed reason**, not sticky marker presence (handles subscription-blocked retry); (c) durable 4h age-floor health check vs the transient windowed zero-delivery check, and the de-conflation (plus the known residual: subscription-skip / all-flag-disabled still fire `checkZeroDeliveryNotifications` — follow-up ticket); (d) poller-driven advisory-locked retry (reuse `NotificationFailoverPoller` cadence, self-clearing, at-most-once) over event-driven re-notify; (e) both escalation surfaces; (f) no new index (082 covers the lookups). Note the map-level correction: `checkZeroDeliveryNotifications` already partially observed the case within its 1h window — F1 makes it distinct + durable.

- [ ] **Step 3: Commit** — `git commit -m "docs(F1): glossary term + ADR 0010 for owner-unreachable outcome"`.

---

## Self-Review (completed)

- **Spec coverage:** marker (T1) · worker records it (T2) · durable latest-reason health check + de-conflation (T3) · advisory-locked retry + admin email (T4) · docs/ADR (T5). All intake `user_visible_behavior` + `tests_to_add` map to a task. ✓
- **Type consistency:** `markOutboxOwnerUnreachable(exec, outboxId, attempt)` · `OUTBOX_COMPLETION_REASON.OWNER_UNREACHABLE` · `checkOwnerUnreachable(sql, cfg)` · `ownerUnreachableAgeS`(14400)/`ownerUnreachableThreshold`(0) · `failover.reason: 'owner_unreachable_retry'` · `processOwnerUnreachable(logger)` — consistent. ✓
- **Codex round-1:** all six REVISE items addressed (age reconcile, latest-reason predicate, advisory-lock, index dropped, surface amended, honest tests). Rejected items (schema-wide unique index; full subscription/flag de-conflation; churn-backoff) documented as out-of-scope with reasons. ✓
- **Residual risks for reviewers:** (1) `checkZeroDeliveryNotifications` still counts subscription-skip / all-flag-disabled zero-delivery (pre-existing; follow-up); (2) admin-email dedup is best-effort (provider-accept-then-db-fail), same as existing arms; (3) `level:'warning'` is a tunable call.
