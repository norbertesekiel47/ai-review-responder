# #631 Auto-Approval Lane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development
> (recommended) or executing-plans to implement this plan task-by-task. Steps
> use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An Autopilot-tier batch auto-approves as `approval_method='auto_policy'`
at the ask-generation finale behind `SOLICITATION_AUTO_APPROVAL_ENABLED`, with
the D9 60-minute veto window anchored on the first confirmed-delivered **Veto
notice**, fail-closed.

**Architecture:** One new deep module `src/lib/solicitation/auto-approval.ts`
owns the whole auto lane: condition gate, auto-approve verb, veto-deadline
anchor, release-time re-check. One new worker family
`worker/jobs/solicitation-veto-notice/` mirrors `pending-post-notice`. The
releaser (`release.ts`) gains one anchor phase and one re-check call; it reuses
its own `downgradeApproval`. Migration 113 is index-only.

**Tech Stack:** Postgres.js (`sql`/`tx`), BullMQ via `job_outbox`, run spine
(`recordStep`), vitest (+ `fast-check` for the gate property test), zod for the
settings PATCH.

**Intake:** `docs/superpowers/plans/631-auto-approval-lane-intake.json` — the
drift detector. Every task stays inside `allowed_edit_surface`.

**Deviations file:** `docs/superpowers/plans/631-auto-approval-lane-deviations.md`
— subagents append there; never dump context on the orchestrator.

---

## Locked design decisions (read before any task)

1. **Hook point** — the auto-approval decision runs inside the ask-generation
   FINALE transaction (`src/lib/solicitation/ask-generation.ts`, the
   `sql.begin` at ~line 1131), AFTER `closeBatchIfSettled`, only when
   `tally.alive > 0` and `close.status === 'not_settled'`. Initial generation
   only — never on the `regenerateAsk` path (regen exists only in `built`,
   which after this feature means "the auto lane declined"). The batch row is
   already locked `FOR UPDATE` there; the advisory lock is already held; the
   lock order batch → run is preserved.
2. **Two spine steps.** At approval: `batch_approved` with
   `approval_method: 'auto_policy'` and `veto_window_minutes` (the granted
   window, read from the policy row AT approval). At anchor:
   `veto_window_granted` with the first delivery time and the computed
   deadline. The `batch_approved` step detail is the immutable granted-window
   record the anchor reads back — later policy edits never move an in-flight
   window (D9: "the step is the immutable record; the column is the index").
3. **Anchor mechanism** (owner fork, locked): a new release-cycle phase
   (`anchorVetoDeadlines`) scans auto batches with `veto_deadline_at IS NULL`,
   joins the first `notification_deliveries.delivered_at` for
   `template='solicitation_veto_notice'`, and CASes the deadline. No hooks in
   webhook ingress. The deadline is computed IN SQL from `delivered_at`
   (repo gotcha: a JS `Date` round-trip truncates microseconds).
4. **Release-time re-check** (owner fork, locked): before the Judge split in
   `runBatchArm`, an `auto_policy` batch re-checks flag + tier + policy row +
   suspension. Any failure ⇒ `downgradeApproval` (existing verb) with reason
   vocabulary `auto_approval_disabled | autopilot_entitlement_lost |
   policy_removed | policy_suspended`, Sentry warning in the `applyJudgeSplit`
   pattern.
5. **No approval-time Judge check.** Judge stays a dispatch precondition owned
   by the releaser (#900 `applyJudgeSplit`). A batch auto-approved while Judge
   is down gets downgraded at the first tick — accepted churn.
6. **Notice exhaustion = fail-closed, per D9 verbatim.** No failed-hook for the
   veto-notice topic. If no notice ever delivers, the batch sits and the
   existing `send_window_elapsed` sweep terminalizes it `cancelled`. The
   `job-failure-sink` raises the Sentry issue on the terminal attempt.
7. **No one-click halt token.** The notice deep-links to the dashboard Requests
   page (login required). `approval_links` is response-scoped; minting a
   batch-scoped token lane is out of scope.
8. **No Requests-panel copy work.** An auto-approved unanchored batch derives
   state `approved` (`deriveBatchState`: `approved_at` set, `veto_deadline_at`
   NULL). The existing panel renders it; copy polish rides a follow-up if
   review demands it.
9. **Decline is a log line, not a spine step.** A declined auto-approval means
   the batch proceeds in the owner lane — a non-action. The finale log line
   gains `auto_approval: declined` + reason.
10. **Settings opt-in mirrors the Reply lane's expansion-confirmation flow.**
    Enabling the solicitation lane is an EXPANSION; the existing
    `AutoApprovalConfirmationRequiredError` machinery applies. Absence of the
    persona row = lane off (D20).

**Glossary (CONTEXT.md, use verbatim):** Outreach row, Send batch parent,
Owner approval, Halt latch, Ask exclusion. New terms this feature coins (Task
9): **Auto-approval lane**, **Veto notice**, **Veto anchor**.

**Precedents (@-read before implementing, per task):**
- `worker/jobs/pending-post-notice/` (all 4 files) — notice family shape
- `src/lib/notifications/delivery.ts` — `claimPendingPostNoticeDelivery`
- `src/lib/shared/job-outbox-helpers.ts:346-388` — `enqueuePendingPostNotice`
- `src/lib/solicitation/approval.ts:269-451` — `approveBatch` (CAS + step shape)
- `src/lib/solicitation/release.ts` — `applyJudgeSplit`, `downgradeApproval`,
  `runReleaseCycle` phase list, `ReleaseCycleReport`
- `worker/jobs/publisher/auto-policy-publish.ts` — downgrade reason vocabulary
- `supabase/migrations/074_trust_dial_veto_window.sql` §4 — index pair shape
- `src/lib/auto-approval/settings.ts` + `types.ts` + route — settings seam

---

### Task 1: Eval task — the spec in executable form (RUNS ALONE, FIRST)

**Files:**
- Create: `src/lib/solicitation/__tests__/auto-approval.test.ts`
- Create: `src/lib/solicitation/__tests__/auto-approval.integration.test.ts`
- Create: `worker/jobs/solicitation-veto-notice/__tests__/dispatch.test.ts`
- Modify: `src/lib/solicitation/__tests__/release.integration.test.ts` (append a describe block)
- Modify: `src/lib/auto-approval/__tests__/settings.test.ts` (append a describe block; if the file does not exist, find the module's existing test file via `ls src/lib/auto-approval/__tests__/` and append there)

- [ ] **Step 1: Scaffold every promised test title as `it.todo`**

The 19 titles from the intake's `tests_to_add`, VERBATIM, distributed:

`src/lib/solicitation/__tests__/auto-approval.test.ts` (unit — gate):
```ts
import { describe, it } from 'vitest';

describe('evaluateAutoApproval', () => {
  it.todo('leaves the batch in owner review when SOLICITATION_AUTO_APPROVAL_ENABLED is off');
  it.todo('leaves the batch in owner review when the tier does not grant Autopilot');
  it.todo('leaves the batch in owner review when no solicitation policy row exists');
  it.todo('leaves the batch in owner review when any policy row for the account is suspended');
});

describe('invariants', () => {
  it.todo('invariants: the auto-approval gate never approves when any single condition fails');
});
```

`src/lib/solicitation/__tests__/auto-approval.integration.test.ts` (live-DB —
verb + anchor; suite name selects the serialized `integration` project, no
run-time DDL):
```ts
import { describe, it } from 'vitest';

describe('autoApproveBatch', () => {
  it.todo('auto-approves a built batch as auto_policy when all four conditions hold and records the spine step');
  it.todo('enqueues the veto notice through job_outbox in the same transaction as the auto approval');
  it.todo('falls back to owner review when the one-active-send-batch index rejects the auto approval');
});

describe('anchorVetoDeadlines', () => {
  it.todo('anchors veto_deadline_at from the first delivered notice exactly once via CAS');
  it.todo('never anchors a halted batch even when a delivery confirmation arrives later');
  it.todo('records the granted window from the policy row at approval and ignores later policy edits');
});
```

`src/lib/solicitation/__tests__/release.integration.test.ts` — append:
```ts
describe('auto_policy release re-check', () => {
  it.todo('downgrades an unreleased auto_policy batch to owner review when the auto flag is off at release');
  it.todo('downgrades an unreleased auto_policy batch when the account loses the Autopilot tier');
  it.todo('downgrades an unreleased auto_policy batch when the solicitation policy row is removed');
});
```

`worker/jobs/solicitation-veto-notice/__tests__/dispatch.test.ts`:
```ts
import { describe, it } from 'vitest';

describe('solicitation veto notice dispatch', () => {
  it.todo('dispatches the veto notice to enrolled channels and records notification_deliveries rows');
  it.todo('logs a systemic failure when zero veto-notice channels deliver');
});
```

`src/lib/auto-approval/__tests__/settings.test.ts` — append:
```ts
describe('solicitation persona opt-in', () => {
  it.todo('PATCH creates the solicitation policy row only for an Autopilot account');
  it.todo('PATCH rejects daily_send_cap outside 1..50 and veto windows other than 30 or 60');
  it.todo('removing the opt-in deletes the solicitation policy row and the lane stays off');
});
```

- [ ] **Step 2: Run the suites — todos report, nothing fails**

Run: `cd <worktree> && pnpm vitest run src/lib/solicitation/__tests__/auto-approval.test.ts worker/jobs/solicitation-veto-notice/__tests__/dispatch.test.ts`
Expected: PASS (0 failures, N todo).

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "test(631): eval scaffolds — the 19 promised titles for the Auto-approval lane"
```

*(Orchestrator: run the first-task enforcement spot check after this task.)*

---

### Task 2: Migration 113 (blocked by: Task 1)

**Files:**
- Create: `supabase/migrations/113_solicitation_auto_approval_lane.sql`
- Modify: `.claude/reference/migrations-log.md` (head → 113 + entry)

- [ ] **Step 0: Invoke the `new-migration` skill** (mandatory before any
  `supabase/migrations/` file) and follow it.

- [ ] **Step 1: Write the migration** — index-only, no columns, no CHECKs
  (091 already did D19):

```sql
-- 113_solicitation_auto_approval_lane.sql
-- #631 Auto-approval lane: two dedup indexes. 074 §4 shape.
--
-- In-flight status set: byte-for-byte contract owned by
-- src/lib/shared/job-outbox-status.ts; re-spelled by hand (ci:outbox-status).
CREATE UNIQUE INDEX IF NOT EXISTS idx_jo_solicitation_veto_notice_inflight
  ON job_outbox (topic, aggregate_id)
  WHERE topic = 'solicitation_veto_notice'
    AND status IN ('pending', 'dispatching', 'dispatched');

-- Claim-before-send dedup. entity_id (076's generic non-response notice
-- entity key) carries the solicitation_batches id for this template.
CREATE UNIQUE INDEX IF NOT EXISTS notification_deliveries_solicitation_veto_notice_claim
  ON notification_deliveries (entity_id, channel, recipient)
  WHERE entity_id IS NOT NULL AND template = 'solicitation_veto_notice';
```

- [ ] **Step 2: Provision + verify**

Run: `pnpm test:db:setup` → then
`psql "$TEST_DATABASE_POOL_URL" -c "\di idx_jo_solicitation_veto_notice_inflight"`
Expected: the index exists.

- [ ] **Step 3: Log + commit**

Update `.claude/reference/migrations-log.md` (head 113, entry per its format).
```bash
git add -A && git commit -m "feat(631): migration 113 — veto-notice outbox + delivery-claim indexes"
```

---

### Task 3: Flag + condition gate (blocked by: Task 2)

**Files:**
- Modify: `src/lib/solicitation/flags.ts`
- Create: `src/lib/solicitation/auto-approval.ts`
- Test: `src/lib/solicitation/__tests__/auto-approval.test.ts` (turn todos green)

- [ ] **Step 1: Flag accessor** (`flags.ts`):

```ts
/** Auto-approval lane switch (#631, map #617 decision 7). Default off; #633
 *  owns the staging flip via the flag-flip skill. Gates ONLY the Autopilot
 *  lane — SOLICITATION_SEND_ENABLED masters the whole send surface.
 *  Server-authoritative, invariant #13. */
export function solicitationAutoApprovalEnabled(): boolean {
  return readFlag('SOLICITATION_AUTO_APPROVAL_ENABLED');
}
```

- [ ] **Step 2: The gate.** New module `auto-approval.ts`. Interface (module
  header documents the lane; style: `release.ts`):

```ts
export type AutoApprovalDeclineReason =
  | 'send_flag_off'
  | 'auto_flag_off'
  | 'subscription'
  | 'tier'
  | 'policy_suspended'
  | 'no_policy_row';

export type AutoApprovalDecision =
  | { eligible: true; vetoWindowMinutes: number }
  | { eligible: false; reason: AutoApprovalDeclineReason };

/** The shared condition read both the finale gate and the release re-check
 *  consume. ONE reader so the two sites cannot drift (D20's four conditions
 *  + the account-wide Governor read, D19). */
interface AutoApprovalConditions {
  subscriptionStatus: string | undefined;
  subscriptionTier: string | null;
  anySuspended: boolean;
  policy: { vetoWindowMinutes: number } | null;
}
async function readAutoApprovalConditions(sql: Sql | TransactionSql, accountId: string): Promise<AutoApprovalConditions>;

export async function evaluateAutoApproval(
  tx: TransactionSql,
  input: { accountId: string },
): Promise<AutoApprovalDecision>;
```

Reads (tenant-scoped by `account_id`):
```sql
SELECT subscription_status, subscription_tier FROM accounts WHERE id = ${accountId}::uuid
```
```sql
SELECT EXISTS(
  SELECT 1 FROM auto_approval_policies
  WHERE account_id = ${accountId}::uuid AND suspended_at IS NOT NULL
) AS any_suspended
```
```sql
SELECT veto_window_minutes FROM auto_approval_policies
WHERE account_id = ${accountId}::uuid AND persona = 'solicitation'
  AND action_class = 'sending' AND location_id IS NULL
LIMIT 1
```

Decision order (first failure wins; the order is the reason-precedence
contract, test it): `send_flag_off` (`solicitationSendEnabled()`),
`auto_flag_off`, `subscription` (`subscriptionGrantsFullAccess`), `tier`
(`tierGrantsAutopilot`), `policy_suspended` (account-wide, ANY row),
`no_policy_row`. Eligible ⇒ `vetoWindowMinutes` from the policy row.

- [ ] **Step 3: Unit tests green** — the 4 gate todos become real tests (mock
  `sql` per the house unit style in `src/lib/solicitation/__tests__/release.test.ts`),
  plus the property test (house style:
  `src/lib/reviews/__tests__/sentiment.test.ts` "invariants" block):

```ts
it('invariants: the auto-approval gate never approves when any single condition fails', () => {
  fc.assert(fc.property(
    fc.record({
      sendFlag: fc.boolean(), autoFlag: fc.boolean(),
      status: fc.constantFrom('active', 'trialing', 'cancelled', 'past_due', 'pending_payment'),
      tier: fc.constantFrom('autopilot_monthly', 'copilot_monthly', null),
      anySuspended: fc.boolean(), hasPolicy: fc.boolean(),
    }),
    (c) => {
      const decision = decide(c); // the pure decision core, exported for tests
      const allHold = c.sendFlag && c.autoFlag
        && subscriptionGrantsFullAccess(c.status)
        && tierGrantsAutopilot(c.tier) && !c.anySuspended && c.hasPolicy;
      return decision.eligible === allHold;
    },
  ));
});
```
(Use the REAL tier ids from `src/lib/accounts/tier-config.ts` — read it first;
never invent tier strings.)

Run: `pnpm vitest run src/lib/solicitation/__tests__/auto-approval.test.ts`
Expected: PASS, 0 todo remaining in this file.

- [ ] **Step 4: Commit** — `feat(631): auto-approval condition gate + property test`

---

### Task 4: Auto-approve verb + outbox topic + finale hook (blocked by: Task 3)

**Files:**
- Modify: `src/lib/solicitation/auto-approval.ts` (add the verb)
- Modify: `src/lib/shared/queue-names.ts` (+ `SOLICITATION_VETO_NOTICE: 'solicitation_veto_notice'`)
- Modify: `src/lib/shared/worker-types.ts` (+ `SolicitationVetoNoticePayload { batch_id; business_id; correlation_id? }`)
- Modify: `src/lib/shared/job-outbox-helpers.ts` (+ `enqueueSolicitationVetoNotice`)
- Modify: `src/lib/solicitation/ask-generation.ts` (finale hook)
- Test: `src/lib/solicitation/__tests__/auto-approval.integration.test.ts` (verb todos green)

- [ ] **Step 1: Outbox helper** — mirror `enqueuePendingPostNotice`
  byte-for-byte in shape: `AGGREGATE_TYPE_SOLICITATION_BATCH`, aggregate_id =
  batch id, `ON CONFLICT (topic, aggregate_id) WHERE topic =
  'solicitation_veto_notice' -- topic-audit-ignore: partial-index inference
  needs a literal` + the in-flight trio, `DO NOTHING`. Backed by 113's index.

- [ ] **Step 2: The verb** (same module as the gate):

```ts
export type AutoApproveOutcome =
  | { status: 'approved'; approvedCount: number; vetoWindowMinutes: number }
  | { status: 'slot_held' };

export async function autoApproveBatch(
  tx: TransactionSql,
  input: {
    batchId: string; accountId: string; businessId: string;
    sendParentRunId: string; vetoWindowMinutes: number; correlationId?: string;
  },
): Promise<AutoApproveOutcome>;
```

Body, in order (the enclosing finale tx already holds the advisory lock and
the batch row lock):
1. The CAS, inside a SAVEPOINT (`tx.savepoint(...)`) so a unique-violation
   cannot poison the finale transaction:
```sql
UPDATE solicitation_batches
SET approved_at = NOW(), approval_method = 'auto_policy'
WHERE id = ${batchId}::uuid AND account_id = ${accountId}::uuid
  AND business_id = ${businessId}::uuid
  AND approved_at IS NULL AND halted_at IS NULL AND send_closed_at IS NULL
  AND built_at IS NOT NULL
RETURNING id
```
   `veto_deadline_at` stays NULL — the **Veto anchor** owns it (D9).
   `approved_by_user_id` stays NULL — 091's consistency CHECK requires that
   for `auto_policy`. Catch ONLY the `23505` on
   `solicitation_batches_one_active_send_per_business` → `{ status: 'slot_held' }`
   (the batch stays `built` for **Owner approval**); rethrow anything else.
   A CAS that matches nothing under the held row lock is impossible — throw
   with context (`approveBatch`'s own claim, approval.ts:396-409).
2. `approvedCount`: `COUNT(*)` of this batch's `rendered` Outreach rows
   (approval.ts:411-418 shape).
3. Spine step (same `stepKey` as the owner lane — the lane is the detail):
```ts
await recordStep(tx, {
  runId: input.sendParentRunId,
  stepKey: 'batch_approved',
  detail: {
    approval_method: 'auto_policy',
    approved_count: approvedCount,
    veto_window_minutes: input.vetoWindowMinutes,
  },
});
```
4. `await enqueueSolicitationVetoNotice(tx, { batchId, businessId, correlationId })`
   — SAME transaction (invariant #2).

- [ ] **Step 3: Finale hook** (`ask-generation.ts`, after `closeBatchIfSettled`
  inside the finale tx; `generateAsksForBatch` path ONLY):

```ts
let autoApproval:
  | { status: 'not_attempted' | 'slot_held' }
  | { status: 'approved'; vetoWindowMinutes: number }
  | { status: 'declined'; reason: AutoApprovalDeclineReason } = { status: 'not_attempted' };
if (tally.alive > 0 && close.status === 'not_settled') {
  const decision = await evaluateAutoApproval(tx, { accountId: ctx.accountId });
  autoApproval = decision.eligible
    ? await autoApproveBatch(tx, {
        batchId: ctx.batchId, accountId: ctx.accountId, businessId: ctx.businessId,
        sendParentRunId: parentRunId, vetoWindowMinutes: decision.vetoWindowMinutes,
        correlationId: ctx.correlationId,
      })
    : { status: 'declined', reason: decision.reason };
}
```
Return `autoApproval` from the finale; extend the "ask generation finished"
log line with `auto_approval` + reason. (Decision 9: a decline is a log line,
never a spine step.)

- [ ] **Step 4: Integration tests green** — titles 1, 6, 7 (seed via the house
  helpers used by `approval.integration.test.ts`; the one-active conflict test
  seeds a second approved batch for the same business first). Flag toggling:
  set/unset `process.env.SOLICITATION_AUTO_APPROVAL_ENABLED` per test
  (readFlag is unmemoized by design).

Run: `pnpm vitest run src/lib/solicitation/__tests__/auto-approval.integration.test.ts`
Expected: PASS (anchor todos still todo).

- [ ] **Step 5: Commit** — `feat(631): auto_policy approval at the generation finale, veto notice enqueued in-tx`

---

### Task 5: Veto-notice worker family (blocked by: Task 4; parallel with Task 6 and Task 8)

**Files:**
- Create: `worker/jobs/solicitation-veto-notice/SolicitationVetoNoticeWorker.ts`
- Create: `worker/jobs/solicitation-veto-notice/context.ts`
- Create: `worker/jobs/solicitation-veto-notice/dispatch.ts`
- Create: `worker/jobs/solicitation-veto-notice/errors.ts`
- Modify: `src/lib/notifications/delivery.ts` (+ `claimSolicitationVetoNoticeDelivery`, keyed `(entity_id, channel, recipient)`, `template='solicitation_veto_notice'` — backs 113's claim index byte-for-byte)
- Modify: `src/lib/notifications/channels/types.ts` (+ `SendSolicitationVetoNoticeParams`)
- Modify: `src/lib/notifications/channels/*.ts` (each adapter gains `sendSolicitationVetoNotice`)
- Modify: `src/lib/config/worker.ts` (+ `WHATSAPP_SOLICITATION_VETO_TEMPLATE_SID: rawOpt`)
- Modify: `worker/queues.ts`, `worker/index.ts`, `worker/background/pollers/health-alert/checks.ts` (registration; the emitter-error + job-failure-sink loops attach via the existing registration pattern)
- Test: `worker/jobs/solicitation-veto-notice/__tests__/dispatch.test.ts`

- [ ] **Step 1: READ the whole `worker/jobs/pending-post-notice/` family and
  clone its shape** (604 lines total). Deltas only:
  - Payload `SolicitationVetoNoticePayload`; the notice is about a **batch**
    (`entity_id` on `notification_deliveries`, no `response_id`).
  - Handler skip conditions (quiet completes, logged): batch not found;
    `approval_method !== 'auto_policy'` (downgraded since); `halted_at` or
    `send_closed_at` set. Anchored (`veto_deadline_at` set) is NOT a skip —
    a retry after a partial dispatch must still cover unclaimed channels.
  - Content (STE, one job per sentence): "RepWorth auto-approved a batch of
    N review requests for {business}. They send after your veto window. Stop
    them from the Requests page: {link}." Link = dashboard `/requests` URL
    built the way `pending-post-notice/context.ts` builds its dashboard link
    (READ it; no `createApprovalLink` — decision 7).
  - WhatsApp pre-filter on `WHATSAPP_SOLICITATION_VETO_TEMPLATE_SID` unset →
    clean skip (precedent lines 109-118). Bounced-owner-email pre-filter kept.
  - Systemic failure: 0 of N channels sent ⇒ the precedent's systemic-failure
    log line with the batch id (title 15 pins it).
- [ ] **Step 2: Registration** — `queues.ts` Queue + map entry; `index.ts`
  Worker + `withJobLogContext` + workers map (the sink/emitter loops pick it
  up from there); health-alert `checks.ts` queue list (+
  `QUEUE_NAMES.SOLICITATION_VETO_NOTICE`).
- [ ] **Step 3: Tests green** — titles 14, 15 (unit, mocked channels — clone
  the pending-post-notice dispatch test style).

Run: `pnpm vitest run worker/jobs/solicitation-veto-notice/`
Expected: PASS.

- [ ] **Step 4: Commit** — `feat(631): solicitation veto-notice worker family`

---

### Task 6: The Veto anchor (blocked by: Task 4; parallel with Task 5 and Task 8)

**Files:**
- Modify: `src/lib/solicitation/auto-approval.ts` (+ `anchorVetoDeadlines`)
- Modify: `src/lib/solicitation/release.ts` (phase wiring + report field)
- Test: `src/lib/solicitation/__tests__/auto-approval.integration.test.ts` (anchor todos green)

- [ ] **Step 1: `anchorVetoDeadlines(sql, scanLimit): Promise<number>`**
  Scan (read-only, tenant keys carried through):

```sql
SELECT b.id, b.account_id, b.business_id
FROM solicitation_batches b
WHERE b.approval_method = 'auto_policy'
  AND b.veto_deadline_at IS NULL
  AND b.halted_at IS NULL AND b.send_closed_at IS NULL
  AND EXISTS (
    SELECT 1 FROM notification_deliveries nd
    WHERE nd.entity_id = b.id
      AND nd.template = 'solicitation_veto_notice'
      AND nd.delivered_at IS NOT NULL
  )
LIMIT ${scanLimit}
```

Per candidate, ONE transaction (per-item isolation via `isolateItem`, the
release phase's own pattern): lock the batch row `FOR UPDATE`; find the send
parent run and its LATEST `batch_approved` step; read
`detail->>'veto_window_minutes'` (missing step = corrupted lane state — THROW
with batch id: assert impossible states, the item isolation reports it);
then the CAS, deadline computed IN SQL (decision 3):

```sql
UPDATE solicitation_batches b
SET veto_deadline_at = sub.first_delivered + make_interval(mins => ${grantedMinutes})
FROM (
  SELECT MIN(nd.delivered_at) AS first_delivered
  FROM notification_deliveries nd
  WHERE nd.entity_id = ${batchId}::uuid
    AND nd.template = 'solicitation_veto_notice'
    AND nd.delivered_at IS NOT NULL
) sub
WHERE b.id = ${batchId}::uuid AND b.account_id = ${accountId}::uuid
  AND b.business_id = ${businessId}::uuid
  AND b.approval_method = 'auto_policy' AND b.veto_deadline_at IS NULL
  AND b.halted_at IS NULL AND b.send_closed_at IS NULL
RETURNING b.veto_deadline_at::text AS veto_deadline_at
```

Zero rows = a **Halt latch** or downgrade won the race — skip, no step. One
row ⇒ `recordStep(tx, { runId, stepKey: 'veto_window_granted', detail:
{ granted_window_minutes, veto_deadline_at, actor: 'system' } })`.

- [ ] **Step 2: Phase wiring** — in `runReleaseCycle`, immediately before the
  `release` phase:

```ts
report.anchored = tallyPhase(
  report,
  await alertPhaseFailure('veto_anchor', () => anchorVetoDeadlines(sql, scanLimit)),
);
```
`ReleaseCycleReport` gains `anchored: number` (init 0).

- [ ] **Step 3: Integration tests green** — titles 8, 9, 10. Seed
  `notification_deliveries` rows directly (the worker is not under test here).
  Title 10 seeds the policy at 60, approves (step records 60), edits the
  policy to 30, delivers, anchors — expects a 60-minute deadline.

Run: `pnpm vitest run src/lib/solicitation/__tests__/auto-approval.integration.test.ts`
Expected: PASS, file fully green.

- [ ] **Step 4: Commit** — `feat(631): Veto anchor — deadline CAS from first delivered notice`

---

### Task 7: Release-time re-check (blocked by: Task 6 — same file `release.ts`)

**Files:**
- Modify: `src/lib/solicitation/release.ts`
- Modify: `src/lib/solicitation/auto-approval.ts` (+ `autoReleaseBlockReason`)
- Test: `src/lib/solicitation/__tests__/release.integration.test.ts` (todos green)

- [ ] **Step 1:** `ReleaseCandidateBatch` gains `approval_method: string | null`;
  add it to `selectReleaseCandidates`' projection.
- [ ] **Step 2:** `autoReleaseBlockReason(sql, { accountId }):
  Promise<'auto_approval_disabled' | 'autopilot_entitlement_lost' |
  'policy_removed' | 'policy_suspended' | null>` — thin mapper over
  `readAutoApprovalConditions` (ONE reader, decision: the finale gate and this
  re-check cannot drift). Both flags off-or-either ⇒ `auto_approval_disabled`;
  subscription/tier ⇒ `autopilot_entitlement_lost`; suspension ⇒
  `policy_suspended`; missing row ⇒ `policy_removed`.
- [ ] **Step 3:** In `runBatchArm`, BEFORE the Judge split:

```ts
if (batch.approval_method === 'auto_policy') {
  const reason = await autoReleaseBlockReason(ctx.sql, { accountId: batch.account_id });
  if (reason !== null) {
    const outcome = await applyAutoDowngrade(ctx.sql, batch, reason);
    if (outcome === 'downgraded') {
      ctx.report.autoDowngradedByReason[reason] =
        (ctx.report.autoDowngradedByReason[reason] ?? 0) + 1;
    }
    return 'next';
  }
}
```

`applyAutoDowngrade` clones `applyJudgeSplit`'s body (same
`downgradeApproval` call, same held/skipped arms, same Sentry-then-log
pattern) with message constant
`'Solicitation batch approval downgraded: auto lane conditions failed'` and
the reason as tag. `ReleaseCycleReport` gains
`autoDowngradedByReason: Partial<Record<AutoDowngradeReason, number>>`.
The Judge `downgraded` counter stays untouched.

- [ ] **Step 4: Integration tests green** — titles 11, 12, 13 (seed an
  auto-approved anchored batch with an elapsed deadline; flip the condition;
  run `runReleaseCycle`; assert the four approval columns are NULL and the
  spine carries the downgrade step `downgradeApproval` already writes).

Run: `pnpm vitest run src/lib/solicitation/__tests__/release.integration.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit** — `feat(631): release-time auto-lane re-check downgrades, before the Judge split`

---

### Task 8: D20 opt-in surface (blocked by: Task 2 only; parallel with Tasks 5-7)

**Files:**
- Modify: `src/lib/auto-approval/types.ts` (PATCH schema + GET state gain a `solicitation` slice)
- Modify: `src/lib/auto-approval/settings.ts` (read + upsert/delete of the persona row)
- Modify: `src/app/api/settings/auto-approval/route.ts` (only if a new error shape needs mapping — the route stays a thin shim)
- Modify: `src/app/(authenticated)/settings/auto-approval/AutoApprovalClient.tsx` (Solicitation card)
- Test: `src/lib/auto-approval/__tests__/settings.test.ts`

- [ ] **Step 1: READ `src/lib/auto-approval/settings.ts` + `types.ts` + the
  route end-to-end first.** Mirror the Reply lane's shapes exactly.
- [ ] **Step 2: Types.** PATCH gains optional
  `solicitation?: { enabled: boolean; dailySendCap?: number | null; vetoWindowMinutes?: 30 | 60 }`
  (zod: `z.number().int().min(1).max(50).nullable()` for the cap — title 17
  pins the bounds). GET state gains
  `solicitation: { available: boolean; enabled: boolean; dailySendCap: number | null; vetoWindowMinutes: number | null }`
  where `available = solicitationSendEnabled() && solicitationAutoApprovalEnabled()
  && tierGrantsAutopilot(tier)` — the browser learns flag state via the API
  response (invariant #13), never a `NEXT_PUBLIC_*`.
- [ ] **Step 3: Settings module.** `enabled: true` ⇒ upsert the account-default
  row `(account_id, persona='solicitation', action_class='sending',
  location_id NULL, veto_window_minutes default 60, daily_send_cap)` — id via
  `randomUUID()` from `node:crypto` if the table has no default (READ how the
  Reply lane inserts; invariant #10). Refuse when `!tierGrantsAutopilot(tier)`
  (title 16). `enabled: false` ⇒ DELETE the row (absence = off, D20).
  Enabling routes through the existing expansion-confirmation machinery
  (decision 10). Writes go through this server module only (invariant #14 —
  `ci:static-policy` enforces it).
- [ ] **Step 4: UI.** `AutoApprovalClient.tsx` gains a Solicitation card
  rendered only when `solicitation.available`; toggle + cap input + 30/60
  select. Invoke the `repworth-brand-design` skill before writing UI. Match
  the page's existing form/save patterns exactly.
- [ ] **Step 5: Tests green** — titles 16, 17, 18.

Run: `pnpm vitest run src/lib/auto-approval/`
Expected: PASS.

- [ ] **Step 6: Commit** — `feat(631): solicitation auto-approval opt-in on the settings surface`

---

### Task 9: Registries, docs, glossary (blocked by: Tasks 5, 7, 8)

**Files:**
- Modify: `.claude/reference/env-vars.md` (+2 rows)
- Modify: `docs/runbooks/whatsapp-templates.md` (+ veto-notice template row)
- Modify: `docs/directory.md` (+ rows: `auto-approval.ts`, the 4 worker-family files; `ci:directory-map` fails without them)
- Modify: `CONTEXT.md` (send-mode section)

- [ ] **Step 1: env-vars.md rows**, matching the section formats:
  - `SOLICITATION_AUTO_APPROVAL_ENABLED` — Railway, unset (OFF). The
    Auto-approval lane switch (#631, map decision 7). Both this AND
    `SOLICITATION_SEND_ENABLED` must be true. Approval-time gate AND
    release-time re-check (off ⇒ unreleased `auto_policy` batches downgrade to
    owner review). Server-only, no `NEXT_PUBLIC_*` companion. Flip via
    `flag-flip` (#633 owns the staging flip).
  - `WHATSAPP_SOLICITATION_VETO_TEMPLATE_SID` — Railway, unset (WhatsApp
    channel skips cleanly; Telegram/email still deliver).
- [ ] **Step 2: CONTEXT.md** — add to "Solicitation (send-mode)" (LOCKED,
  coined in #631): **Auto-approval lane** (the `approval_method='auto_policy'`
  path: four-condition opt-in D20, Governor account-wide read, Judge-gated at
  dispatch, veto-windowed); **Veto notice** (the owner notification whose
  first confirmed delivery starts the window; template
  `solicitation_veto_notice`, `entity_id` = batch id); **Veto anchor** (the
  release-cycle phase that CASes `veto_deadline_at` once from the first
  `delivered_at`; no delivered notice ⇒ no release, ever). Each with an
  _Avoid_ line, matching the section's entry format.
- [ ] **Step 3:** whatsapp-templates.md row (template body + variables +
  the SID env var), directory.md rows.
- [ ] **Step 4: Commit** — `docs(631): registries, runbook row, glossary terms`

---

## Verification (step 5 of /feature)

After Task 9: `bash scripts/verify-gate.sh` (full), fix, re-run; the LAST
pre-review run is `bash scripts/verify-gate.sh --review` (diff-coverage ≥80%).
`TEST_DATABASE_POOL_URL` must be set — a SKIP row on the integration suites is
NOT review-ready for this feature (db_touching).

## Task graph

```
1 (eval, alone) → 2 (migration) → 3 (gate) → 4 (verb+hook) → 5 (notice family) ─┐
                                        │                └──→ 6 (anchor) → 7 (re-check) ─┼→ 9 (docs)
                                        └────────────────────→ 8 (settings) ────────────┘
```
Parallel-safe sets after 4: {5, 6, 8} (disjoint files, no edges). 7 after 6
(both edit `release.ts`). 9 last.
