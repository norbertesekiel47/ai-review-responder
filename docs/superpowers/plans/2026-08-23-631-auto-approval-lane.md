# #631 Auto-Approval Lane Implementation Plan (rev 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development
> (recommended) or executing-plans to implement this plan task-by-task. Steps
> use checkbox (`- [ ]`) syntax for tracking.

> Rev 2, 2026-08-23: incorporates all 14 confirmed findings of plan-review
> round 1 (`docs/reviews/631-auto-approval-lane/plan-round-1.md`) and the
> owner's three re-lock decisions (anchor = sent_at; intake rev 2; notice
> gates on batch state only).

**Goal:** An Autopilot-tier batch auto-approves as `approval_method='auto_policy'`
at the ask-generation finale behind `SOLICITATION_AUTO_APPROVAL_ENABLED`, with
the D9 veto window anchored on the first provider-accepted **Veto notice**
(`sent_at`), fail-closed.

**Architecture:** One new deep module `src/lib/solicitation/auto-approval.ts`
owns the auto lane: condition gate, auto-approve verb, veto-deadline anchor,
release-time re-check. One new worker family
`worker/jobs/solicitation-veto-notice/` mirrors `pending-post-notice`. The
releaser gains one anchor phase and one re-check call; its `downgradeApproval`
split is refactored to take a typed reason. Migration 113 is index-only.

**Tech Stack:** Postgres.js (`tx.savepoint` for the CAS), BullMQ via
`job_outbox`, run spine (`recordStep`), vitest + `fast-check`, zod.

**Intake (rev 2):** `docs/superpowers/plans/631-auto-approval-lane-intake.json`
— the drift detector; 44 promised test titles.

**Deviations file:** `docs/superpowers/plans/631-auto-approval-lane-deviations.md`.

---

## Locked design decisions (read before any task)

1. **Hook point** — the auto-approval decision runs inside the ask-generation
   FINALE transaction (`ask-generation.ts` `sql.begin` at ~1131), AFTER
   `closeBatchIfSettled`, only when `tally.alive > 0` and
   `close.status === 'not_settled'`. Initial generation only — never on
   `regenerateAsk`.
2. **Owner-won race is a quiet outcome, not a throw** (R1 finding 1). The last
   child render commits BEFORE the finale opens, so an owner approval can land
   in between. The auto CAS carries `approved_at IS NULL`; zero rows with
   `approved_at` already set ⇒ return `{ status: 'owner_won' }` and write
   nothing. The throw stays only for the impossible arm (zero rows while the
   row lock shows the batch unapproved and unhalted).
3. **Approval-time condition reads are serialized** (R1 finding 2): inside the
   finale, after the batch row lock, take the account lock via
   `src/lib/auto-approval/account-lock.ts` (the documented batch-then-account
   order), THEN read conditions, THEN CAS. Settings and Governor writers take
   the same account lock, so no opt-out or suspension can commit between read
   and stamp.
4. **Anchor = `MIN(sent_at)`** (owner re-lock decision). The Reply lane's
   shipped anchor (`veto-window-gate.ts:84`) uses provider-accepted `sent_at`;
   Telegram has no delivery receipt. The anchor phase scans auto batches with
   `veto_deadline_at IS NULL`, joins `notification_deliveries.sent_at` for
   `template='solicitation_veto_notice'`, and CASes the deadline computed IN
   SQL (µs gotcha). Fail-closed: no sent notice ⇒ no release, ever.
5. **Two spine steps.** `batch_approved` (approval_method `auto_policy`,
   granted `veto_window_minutes` read from the policy row at approval) and
   `veto_window_granted` (first send time, deadline, actor `system`). The
   anchor reads the granted window back from the LATEST `batch_approved` step.
6. **Release-time re-check** — before the Judge split in `runBatchArm`, an
   `auto_policy` batch re-checks ONLY: auto flag (`auto_approval_disabled`),
   Autopilot tier (`autopilot_entitlement_lost`), policy row presence
   (`policy_removed`), account-wide suspension (`policy_suspended`).
   **Subscription lapse is NOT a downgrade** — B14: the existing
   `subscription` withhold in `runAccountArm` already holds the batch and it
   resumes on recovery. **Master send flag off is NOT a downgrade** — B15:
   `runReleasePhase` already stops with `flag_off` before any batch arm runs.
   (R1 finding 4.) The re-check re-reads conditions INSIDE the downgrade
   transaction under the batch + account locks before the downgrade CAS
   (R1 finding 3); the residual per-row window after a passing re-check is the
   same one-tick class the existing subscription gate accepts — documented,
   not hidden.
7. **`downgradeApproval` grows a typed reason** (R1 finding 5). Today it
   hard-writes `judge_unavailable`. Refactor: one shared
   `applyDowngradeSplit(sql, batch, reason)` used by the Judge arm
   (`judge_unavailable`) and the auto arm (the four reasons above). One
   implementation, truthful durable reasons.
8. **No approval-time Judge check.** Judge stays release-owned (#900).
9. **Notice exhaustion = fail-closed per D9.** No failed-hook; the
   `send_window_elapsed` sweep terminalizes an unanchored batch; the
   `job-failure-sink` raises the Sentry issue.
10. **Veto-notice CTA**: `${appUrl}/dashboard/requests`, tokenless (R1
    finding 10 — the real route; `createApprovalLink` is NOT the precedent).
11. **Notice worker gates on batch state only** (owner re-lock decision):
    skip when the batch is no longer `auto_policy`, or is halted/closed.
    Anchored is NOT a skip (retries must cover unclaimed channels). No flag
    reads in the worker.
12. **Systemic-failure covers BOTH zero paths** (R1 finding 11): the dispatch
    zero-sent path AND the Worker's zero-enrolled early return.
13. **Savepoint control flow** (R1 finding 13): the auto CAS runs through the
    `tx.savepoint(...)` handle; the `23505` ESCAPES the savepoint callback and
    is caught OUTSIDE it (precedent `src/lib/reviews/import-consent.ts:563`).
    Only `solicitation_batches_one_active_send_per_business` maps to
    `slot_held`; any other constraint rethrows.
14. **Settings extend the discriminated-union operation contract** (R1
    finding 7) — not an optional slice. Upserts use the literal
    `ON CONFLICT (account_id, persona, action_class) WHERE location_id IS NULL`
    (R1 finding 8, `settings.ts:727` precedent) and `uuidv7()` ids (R1
    finding 9, migration 055 convention).
15. **Real tier ids are `copilot` / `autopilot`** (`tier-config.ts:12`) —
    never invent tier strings (R1 finding 6).
16. **Hard-bounce classification**: add `'solicitation_veto_notice'` to
    `OWNER_DIRECTED_TEMPLATES` in `worker/ingress/resend.ts:90` (+ test), so a
    hard-bounced veto email marks `owner_email_bounced` (R1 finding 12;
    surface granted by intake rev 2).

**Glossary (CONTEXT.md, verbatim):** Outreach row, Send batch parent, Owner
approval, Halt latch, Ask exclusion. New terms Task 9 coins: **Auto-approval
lane**, **Veto notice**, **Veto anchor**.

**Precedents (@-read per task):**
- `worker/jobs/pending-post-notice/` (all 4 files) — notice family shape
- `worker/jobs/publisher/veto-window-gate.ts` — anchor semantic + granted-window read-back
- `src/lib/notifications/delivery.ts` — claim + finalize helpers
- `src/lib/shared/job-outbox-helpers.ts:346-388` — `enqueuePendingPostNotice`
- `src/lib/solicitation/approval.ts:269-451` — `approveBatch`
- `src/lib/solicitation/release.ts` — phases, `applyJudgeSplit`, `downgradeApproval`
- `src/lib/auto-approval/account-lock.ts` — lock order
- `src/lib/reviews/import-consent.ts:563` — savepoint flow
- `supabase/migrations/074_trust_dial_veto_window.sql` §4 — index pair
- `src/lib/auto-approval/settings.ts` + `types.ts` + route + `AutoApprovalClient.tsx` — settings seam

---

### Task 1: Eval task — the spec in executable form (RUNS ALONE, FIRST)

**Files:**
- Create: `src/lib/solicitation/__tests__/auto-approval.test.ts`
- Create: `src/lib/solicitation/__tests__/auto-approval.integration.test.ts`
- Create: `worker/jobs/solicitation-veto-notice/__tests__/dispatch.test.ts`
- Create: `worker/jobs/solicitation-veto-notice/__tests__/SolicitationVetoNoticeWorker.test.ts`
- Modify: `src/lib/solicitation/__tests__/release.integration.test.ts` (append)
- Modify: `src/lib/solicitation/__tests__/ask-generation.integration.test.ts` (append)
- Modify: `src/lib/auto-approval/__tests__/settings.test.ts` (append)
- Modify: `worker/ingress/__tests__/` — the existing resend ingress test file (append; find it via `ls worker/ingress/__tests__/`)

- [ ] **Step 1: Scaffold all 44 promised titles as `it.todo`**, VERBATIM from
  intake rev 2 `tests_to_add`, distributed:

`auto-approval.test.ts` (unit — gate): titles 1-7
("leaves the batch in owner review when SOLICITATION_AUTO_APPROVAL_ENABLED is off",
"…when the tier does not grant Autopilot", "…when no solicitation policy row
exists", "…when any policy row for the account is suspended", "a Reply policy
row or location override alone never enables Solicitation auto approval", "a
suspended policy on another account never blocks this account", "invariants:
the auto-approval gate never approves when any single condition fails").

`auto-approval.integration.test.ts` (live-DB): verb titles
("auto-approves a built batch as auto_policy when all four conditions hold and
records the spine step", "enqueues the veto notice through job_outbox in the
same transaction as the auto approval", "falls back to owner review when the
one-active-send-batch index rejects the auto approval", "preserves an owner
approval committed after the final render but before the generation finale",
"autoApproveBatch rethrows a 23505 from every constraint except
solicitation_batches_one_active_send_per_business", "the database-backed gate
approves a trialing autopilot account", "turning the auto flag on does not
retroactively approve a previously built batch") + anchor titles
("anchors veto_deadline_at from the first sent notice exactly once via CAS",
"never anchors a halted batch even when a notice send lands later", "records
the granted window from the policy row at approval and ignores later policy
edits", "one corrupt anchor candidate does not prevent a healthy sibling batch
from anchoring", "a wrong-template or different-batch delivery row never
anchors").

`ask-generation.integration.test.ts` — append a describe block:
("the initial ask-generation finale auto-approves and enqueues the Veto notice
when every gate holds", "regenerateAsk never invokes the auto-approval lane",
"the real generation finale leaves the batch built when
SOLICITATION_SEND_ENABLED is off", "Judge unavailability at approval time does
not block auto approval").

`release.integration.test.ts` — append:
("downgrades an unreleased auto_policy batch to owner review when the auto
flag is off at release", "…when the account loses the Autopilot tier", "…when
the solicitation policy row is removed", "…when a Governor suspension latches
after approval", "a subscription lapse holds an auto_policy batch unchanged
and never downgrades it", "the auto downgrade records its exact reason and
never judge_unavailable", "a mid-drip auto_policy batch is held when an auto
condition fails, never unapproved", "runReleaseCycle runs the Veto anchor
phase before release and reports the anchored count").

`worker/jobs/solicitation-veto-notice/__tests__/dispatch.test.ts`:
("dispatches the veto notice to enrolled channels and records
notification_deliveries rows", "logs a systemic failure when zero veto-notice
channels deliver", "an unset WhatsApp veto template skips only WhatsApp while
other channels continue", "the veto-notice CTA links to /dashboard/requests
and contains no approval token").

`worker/jobs/solicitation-veto-notice/__tests__/SolicitationVetoNoticeWorker.test.ts`:
("the Worker logs systemic failure when no veto-notice channels are enrolled",
"a queued veto notice is quietly skipped after downgrade, halt, or send
closure").

resend ingress test file — append:
("a hard bounce for solicitation_veto_notice marks owner_email_bounced").

`src/lib/auto-approval/__tests__/settings.test.ts` — append:
("PATCH creates the solicitation policy row only for an Autopilot account",
"PATCH rejects daily_send_cap outside 1..50 and veto windows other than 30 or
60", "PATCH round-trips valid dials and defaults an omitted veto window to
60", "enabling Solicitation twice upserts exactly one account-default row",
"removing the opt-in deletes only the solicitation account-default row and the
lane stays off", "GET marks solicitation available only when both server flags
and tierGrantsAutopilot hold").

- [ ] **Step 2:** `pnpm vitest run` the touched unit files — PASS, 0 failures,
  N todo.
- [ ] **Step 3:** Commit:
  `test(631): eval scaffolds — 44 promised titles for the Auto-approval lane`.

*(Orchestrator: first-task enforcement spot check after this task.)*

---

### Task 2: Migration 113 (blocked by: Task 1)

Unchanged from rev 1 — index-only; both indexes as below. Invoke the
`new-migration` skill FIRST.

```sql
-- 113_solicitation_auto_approval_lane.sql
-- #631 Auto-approval lane: two dedup indexes. 074 §4 shape.
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

Steps: write → `pnpm test:db:setup` → `psql … "\di …"` proves both indexes →
update `.claude/reference/migrations-log.md` (head 113) → commit
`feat(631): migration 113 — veto-notice outbox + delivery-claim indexes`.

---

### Task 3: Flag + condition gate (blocked by: Task 2)

**Files:** Modify `src/lib/solicitation/flags.ts`; Create
`src/lib/solicitation/auto-approval.ts`; Test `auto-approval.test.ts`.

- [ ] **Step 1: Flag accessor** (unchanged from rev 1):

```ts
/** Auto-approval lane switch (#631, map #617 decision 7). Default off; #633
 *  owns the staging flip via the flag-flip skill. Gates ONLY the Autopilot
 *  lane — SOLICITATION_SEND_ENABLED masters the whole send surface.
 *  Server-authoritative, invariant #13. */
export function solicitationAutoApprovalEnabled(): boolean {
  return readFlag('SOLICITATION_AUTO_APPROVAL_ENABLED');
}
```

- [ ] **Step 2: The gate.** Interface:

```ts
export type AutoApprovalDeclineReason =
  | 'send_flag_off' | 'auto_flag_off' | 'subscription' | 'tier'
  | 'policy_suspended' | 'no_policy_row';

export type AutoApprovalDecision =
  | { eligible: true; vetoWindowMinutes: number }
  | { eligible: false; reason: AutoApprovalDeclineReason };

/** Pure decision core, exported for the property test. */
export function decideAutoApproval(c: AutoApprovalConditionSnapshot): AutoApprovalDecision;

/** DB-backed evaluator. CALLER CONTRACT: the batch row lock AND the account
 *  lock (account-lock.ts, batch-then-account order) are already held — the
 *  same serialization settings/Governor writers use (R1 finding 2). */
export async function evaluateAutoApproval(
  tx: TransactionSql,
  input: { accountId: string },
): Promise<AutoApprovalDecision>;
```

Reads (tenant-scoped): the accounts row (`subscription_status`,
`subscription_tier`); `EXISTS` over suspended policy rows for the account; the
`persona='solicitation' AND action_class='sending' AND location_id IS NULL`
row's `veto_window_minutes`. Decision order = reason precedence:
`send_flag_off`, `auto_flag_off`, `subscription`
(`subscriptionGrantsFullAccess`), `tier` (`tierGrantsAutopilot`),
`policy_suspended`, `no_policy_row`.

- [ ] **Step 3: Unit tests green** — titles 1-6 + the property test over the
  pure core with REAL tier ids from `tier-config.ts` (`'autopilot'`,
  `'copilot'`, null — R1 finding 6). The positive arm must be reachable:
  assert at least one generated case approves.
- [ ] **Step 4:** Commit `feat(631): auto-approval condition gate + property test`.

---

### Task 4: Auto-approve verb + outbox topic + finale hook (blocked by: Task 3)

**Files:** Modify `auto-approval.ts`, `src/lib/shared/queue-names.ts`
(+ `SOLICITATION_VETO_NOTICE: 'solicitation_veto_notice'`),
`src/lib/shared/worker-types.ts` (+ `SolicitationVetoNoticePayload`),
`src/lib/shared/job-outbox-helpers.ts` (+ `enqueueSolicitationVetoNotice`,
mirror of `enqueuePendingPostNotice` with `AGGREGATE_TYPE_SOLICITATION_BATCH`
and the `'solicitation_veto_notice'` ON CONFLICT literal),
`src/lib/solicitation/ask-generation.ts` (finale hook). Tests:
`auto-approval.integration.test.ts` verb titles +
`ask-generation.integration.test.ts` finale titles.

- [ ] **Step 1: Outbox helper** (as rev 1).
- [ ] **Step 2: The verb**:

```ts
export type AutoApproveOutcome =
  | { status: 'approved'; approvedCount: number; vetoWindowMinutes: number }
  | { status: 'owner_won' }
  | { status: 'slot_held' };
```

Body — the enclosing finale tx already holds the advisory lock, the batch row
lock, and (new) the account lock:
1. The CAS through a savepoint, 23505 caught OUTSIDE the callback
   (decision 13):

```ts
let casRow: { id: string } | undefined;
try {
  await tx.savepoint(async (sp) => {
    const rows = await sp<{ id: string }[]>`
      UPDATE solicitation_batches
      SET approved_at = NOW(), approval_method = 'auto_policy'
      WHERE id = ${batchId}::uuid AND account_id = ${accountId}::uuid
        AND business_id = ${businessId}::uuid
        AND approved_at IS NULL AND halted_at IS NULL
        AND send_closed_at IS NULL AND built_at IS NOT NULL
      RETURNING id
    `;
    casRow = rows[0];
  });
} catch (error) {
  if (isUniqueViolationOn(error, 'solicitation_batches_one_active_send_per_business')) {
    return { status: 'slot_held' };
  }
  throw error;
}
if (casRow === undefined) {
  // The row lock is held, so the ONLY way the CAS misses is a pre-existing
  // approval (owner raced ahead between the last render and the finale) —
  // R1 finding 1. Anything else is corruption: assert it.
  const [b] = await tx<{ approved_at: string | null; halted_at: string | null }[]>`
    SELECT approved_at::text AS approved_at, halted_at::text AS halted_at
    FROM solicitation_batches WHERE id = ${batchId}::uuid
      AND account_id = ${accountId}::uuid AND business_id = ${businessId}::uuid
  `;
  if (b?.approved_at !== null) return { status: 'owner_won' };
  throw new Error(`autoApproveBatch: CAS missed for ${batchId} with no prior approval`);
}
```
2. `approvedCount` (rendered Outreach count, approval.ts:411 shape).
3. `recordStep` `batch_approved` with `approval_method: 'auto_policy'`,
   `approved_count`, `veto_window_minutes`.
4. `enqueueSolicitationVetoNotice(tx, …)` — SAME tx (invariant #2).

- [ ] **Step 3: Finale hook** — as rev 1, plus the account lock BEFORE the
  condition read (decision 3):

```ts
if (tally.alive > 0 && close.status === 'not_settled') {
  await acquireAutoApprovalAccountLock(tx, ctx.accountId); // account-lock.ts helper
  const decision = await evaluateAutoApproval(tx, { accountId: ctx.accountId });
  autoApproval = decision.eligible
    ? await autoApproveBatch(tx, { …, vetoWindowMinutes: decision.vetoWindowMinutes })
    : { status: 'declined', reason: decision.reason };
}
```
(Use `account-lock.ts`'s exported helper by its real name — READ the file
first.) Extend the finished log line with `auto_approval` status/reason.
`generateAsksForBatch` only; `regenerateAsk` untouched.

- [ ] **Step 4: Integration tests green** — the 7 verb titles + the 4 finale
  titles. The owner-race title seeds an owner approval after renders exist,
  then drives the finale and asserts `owner_won` + intact owner approval.
- [ ] **Step 5:** Commit
  `feat(631): auto_policy approval at the generation finale, veto notice enqueued in-tx`.

---

### Task 5: Veto-notice worker family (blocked by: Task 4; parallel with 6 and 8)

**Files:** as rev 1 (family of 4 + `delivery.ts` claim +
`channels/types.ts` + channel adapters + `config/worker.ts` SID key +
`queues.ts`/`index.ts`/health-alert registration) PLUS:
- Modify: `worker/ingress/resend.ts` — add `'solicitation_veto_notice'` to
  `OWNER_DIRECTED_TEMPLATES` (line ~90) (decision 16)
- Test: the resend ingress test file (bounce title) + the two new worker test
  files.

Deltas from the pending-post-notice clone (decisions 10-12):
- CTA: `${appUrl}/dashboard/requests`, tokenless. NOT `createApprovalLink` —
  R1 finding 10 corrected the precedent claim; the notice builds the URL from
  the same app-base-url config `pending-post-notice`'s CONTENT uses for its
  fallback links (READ context.ts + dispatch.ts to locate it).
- Handler skip conditions: batch not found, `approval_method !== 'auto_policy'`,
  `halted_at`/`send_closed_at` set. Anchored is NOT a skip. NO flag reads.
- Systemic-failure log on the Worker's zero-enrolled early return AND the
  dispatch zero-sent path (both titles pin it).
- WhatsApp pre-filter on `WHATSAPP_SOLICITATION_VETO_TEMPLATE_SID` unset;
  bounced-owner-email pre-filter kept (and now fed by decision 16).

Steps: read family → clone with deltas → registration (+ health-alert queue
list) → resend template registration + test → tests green (6 titles) → commit
`feat(631): solicitation veto-notice worker family`.

---

### Task 6: The Veto anchor (blocked by: Task 4; parallel with 5 and 8)

**Files:** Modify `auto-approval.ts` (+ `anchorVetoDeadlines`),
`release.ts` (phase wiring + `anchored` report field). Tests: the 5 anchor
titles in `auto-approval.integration.test.ts` + the phase-wiring title in
`release.integration.test.ts`.

- [ ] **Step 1: `anchorVetoDeadlines(sql, scanLimit): Promise<number>`** —
  scan predicate on **`sent_at`** (decision 4):

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
      AND nd.sent_at IS NOT NULL
  )
LIMIT ${scanLimit}
```

Per candidate, ONE transaction with `isolateItem` per-item isolation: lock the
batch `FOR UPDATE`; read the LATEST `batch_approved` step's
`detail->>'veto_window_minutes'` from the send parent run (missing ⇒ THROW
with batch id — corrupted lane state, item-isolated); CAS with the deadline
computed IN SQL:

```sql
UPDATE solicitation_batches b
SET veto_deadline_at = sub.first_sent + make_interval(mins => ${grantedMinutes})
FROM (
  SELECT MIN(nd.sent_at) AS first_sent
  FROM notification_deliveries nd
  WHERE nd.entity_id = ${batchId}::uuid
    AND nd.template = 'solicitation_veto_notice'
    AND nd.sent_at IS NOT NULL
) sub
WHERE b.id = ${batchId}::uuid AND b.account_id = ${accountId}::uuid
  AND b.business_id = ${businessId}::uuid
  AND b.approval_method = 'auto_policy' AND b.veto_deadline_at IS NULL
  AND b.halted_at IS NULL AND b.send_closed_at IS NULL
RETURNING b.veto_deadline_at::text AS veto_deadline_at
```

Zero rows ⇒ a **Halt latch**/downgrade won — skip, no step. One row ⇒
`recordStep` `veto_window_granted`
(`granted_window_minutes`, `first_sent_at`, `veto_deadline_at`,
`actor: 'system'`).

- [ ] **Step 2: Phase wiring** in `runReleaseCycle`, immediately before the
  release phase: `report.anchored = tallyPhase(report,
  await alertPhaseFailure('veto_anchor', () => anchorVetoDeadlines(sql, scanLimit)))`;
  `ReleaseCycleReport` gains `anchored: number`.
- [ ] **Step 3:** Tests green (6 titles; seed `notification_deliveries` rows
  directly with `sent_at`).
- [ ] **Step 4:** Commit
  `feat(631): Veto anchor — deadline CAS from first sent notice`.

---

### Task 7: Release-time re-check (blocked by: Task 6 — same file)

**Files:** Modify `release.ts`, `auto-approval.ts`. Tests: the 7 re-check
titles in `release.integration.test.ts`.

- [ ] **Step 1:** `ReleaseCandidateBatch` gains `approval_method: string | null`
  (+ scan projection).
- [ ] **Step 2: Refactor the split** (decision 7): extract
  `applyDowngradeSplit(sql, batch, reason: DowngradeReason)` from
  `applyJudgeSplit`'s body — same held/skipped arms, same
  Sentry-then-log pattern, reason in the spine detail and Sentry tag.
  `applyJudgeSplit` becomes `applyDowngradeSplit(sql, batch, 'judge_unavailable')`.
  `downgradeApproval`'s spine write takes the reason as a parameter instead of
  the hard-coded constant (R1 finding 5; check `release.ts:1800` for the
  current write site).
- [ ] **Step 3: The re-check** in `runBatchArm`, BEFORE the Judge split, ONLY
  for `approval_method === 'auto_policy'` (decision 6):
  - Quick read of the four conditions (auto flag, tier, policy row,
    suspension) — `readAutoApprovalConditions` reused. Subscription and master
    flag are NOT consulted here (B14/B15 — already owned by the existing
    phase/account gates).
  - On failure: `applyAutoDowngrade` = re-read the SAME conditions INSIDE the
    downgrade transaction under the batch + account locks (R1 finding 3); if
    they now pass, skip (raced back to healthy); else
    `applyDowngradeSplit(sql, batch, reason)`.
  - Report: `autoDowngradedByReason: Partial<Record<AutoDowngradeReason, number>>`,
    incremented only on `'downgraded'`. Judge `downgraded` counter untouched.
- [ ] **Step 4:** Tests green (7 titles — including "a subscription lapse
  holds …" which asserts the batch remains approved with rows unreleased, and
  "the auto downgrade records its exact reason and never judge_unavailable").
- [ ] **Step 5:** Commit
  `feat(631): release-time auto-lane re-check, reason-parameterized downgrade split`.

---

### Task 8: D20 opt-in surface (blocked by: Task 2; parallel with 5-7)

**Files:** Modify `src/lib/auto-approval/types.ts`, `settings.ts`, the route
(only if a new error shape needs mapping), `AutoApprovalClient.tsx`. Tests:
the 6 settings titles.

- [ ] **Step 1: READ `types.ts:159-214`, `settings.ts`, and the route
  end-to-end.** The PATCH contract is a strict discriminated **operation
  union** (R1 finding 7) — extend it with solicitation operations in the same
  style (e.g. an operation that enables/updates the solicitation lane with
  `dailySendCap` + `vetoWindowMinutes`, and one that disables it). Follow the
  union's existing naming pattern EXACTLY; do not invent a parallel shape.
- [ ] **Step 2: Settings module.** Enable ⇒ upsert the account-default row
  with the LITERAL predicate
  `ON CONFLICT (account_id, persona, action_class) WHERE location_id IS NULL`
  (`settings.ts:727` precedent), id via `uuidv7()` (migration 055 convention),
  `veto_window_minutes` defaulting 60, cap zod-bounded 1..50. Refuse when
  `!tierGrantsAutopilot(tier)`. Disable ⇒ DELETE only the
  solicitation/sending/account-default row. Enabling routes through the
  existing expansion-confirmation machinery (decision 10 of rev 1, upheld).
  All writes under the account lock the module already takes
  (`settings.ts:381`).
- [ ] **Step 3: GET state** gains the solicitation slice with
  `available = solicitationSendEnabled() && solicitationAutoApprovalEnabled()
  && tierGrantsAutopilot(tier)` (server-authoritative, invariant #13).
- [ ] **Step 4: UI.** Solicitation card in `AutoApprovalClient.tsx`, rendered
  only when `available`; toggle + cap input + 30/60 select. Invoke
  `repworth-brand-design` before writing UI.
- [ ] **Step 5:** Tests green (6 titles). Commit
  `feat(631): solicitation auto-approval opt-in on the settings surface`.

---

### Task 9: Registries, docs, glossary (blocked by: Tasks 5, 7, 8)

As rev 1 (env-vars rows for `SOLICITATION_AUTO_APPROVAL_ENABLED` +
`WHATSAPP_SOLICITATION_VETO_TEMPLATE_SID`; whatsapp-templates.md row;
directory.md rows for every new production file; CONTEXT.md terms
**Auto-approval lane**, **Veto notice**, **Veto anchor** — the Veto notice
entry states the `sent_at` anchor semantic and cites veto-window-gate.ts as
the port source). Commit `docs(631): registries, runbook row, glossary terms`.

---

## Verification (step 5 of /feature)

After Task 9: `bash scripts/verify-gate.sh` (full), fix, re-run; final
pre-review run `bash scripts/verify-gate.sh --review` (diff-coverage ≥80%).
`TEST_DATABASE_POOL_URL` must be set — SKIP rows on integration suites are not
review-ready here (db_touching).

## Task graph

```
1 (eval, alone) → 2 (migration) → 3 (gate) → 4 (verb+hook) → 5 (notice family + resend) ─┐
                                        │                └──→ 6 (anchor) → 7 (re-check) ─┼→ 9 (docs)
                                        └────────────────────→ 8 (settings) ─────────────┘
```
Parallel-safe after 4: {5, 6, 8}. 7 after 6 (both edit `release.ts`). 9 last.
