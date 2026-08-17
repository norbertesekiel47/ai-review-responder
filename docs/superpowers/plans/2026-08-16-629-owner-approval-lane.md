# Owner approval lane on the Requests surface (#629) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an owner review a built **Solicitation batch**'s rendered **Outreach rows**, approve it (`approval_method='owner'`), exclude individual **Asks**, and stop it through the **Halt latch**.

**Architecture:** One new domain module (`src/lib/solicitation/approval.ts`) owns the two owner verbs as transactional writers behind a small interface — each returns a discriminated result union so the two new routes stay thin (invariant #12). The read model `batch-view.ts` is deepened, not replaced: `readLatestBatch` gains a `sendLane` arm carrying the **Batch state** and approval readiness. The client gains one island, `ApprovalPanel.tsx`, beside the unchanged `BatchReport`. Nothing dispatches — the releaser and send worker are #630, so this feature ships inert behind `SOLICITATION_SEND_ENABLED`.

**Tech Stack:** Next.js 16 App Router, Postgres.js (`sql`/`tx` explicit — invariant #15), vitest + fast-check, migration 108.

**Ticket:** #629 · **Map:** #617 · **Spec:** `docs/superpowers/specs/2026-07-28-send-mode-executor-approval-design.md` §10 (#629 bindings), D2/D6a/D9/D10/D11/D22/D23 · **Amendments:** `2026-07-28-send-mode-cross-spec-amendments.md` B2, B11 · **Intake:** `docs/superpowers/plans/feat-629-owner-approval-lane-intake.json`

---

## Glossary — use these terms verbatim (`CONTEXT.md`)

- **Batch state** — `deriveBatchState(row, now)` over `solicitation_batches`' monotone timestamps; closed union with fixed precedence `halted > closed > sending > veto_window > approved > expired > built > pending`. There is no `status` column.
- **Halt latch** — the single monotone `halted_at`/`halt_reason`/`halted_by` write. One mechanism, five reasons; this ticket writes two of them (`owner_veto`, `owner_halt`). Cancels rows in `rendered`/`queued`, **never `sending`**. No resume.
- **Outreach row** — one `solicitation_outreach` row: one dispatch attempt for one Ask, carrying the rendered subject/body and the send lifecycle.
- **Settled batch** — no Outreach row left in `rendered`, `queued` or `sending`. `closeBatchIfSettled` is its single owner.
- **Send batch parent** — the `agent_runs` row of kind `solicitation_send_batch`.
- **Requests** — the owner-facing name of the Solicitation surface (`/dashboard/requests`).
- **Spoilage report** — the withheld-candidate display. Unchanged by this ticket.

New terms coined here (Task 8 writes them into `CONTEXT.md`): **Owner approval**, **Ask exclusion**.

---

## Design pass (`codebase-design` vocabulary)

| Module | Move | Why |
|---|---|---|
| `src/lib/solicitation/approval.ts` | **NEW** | Deep: two functions hide the advisory lock, the CAS, exclusion cancellation, the readiness and expiry gates, the run step and the join. Deletion test: every caller (2 routes now, the admin halt surface and #631's auto lane later) would re-spell the lock order and the CAS. |
| `src/lib/solicitation/outreach.ts` | untouched | Its interface is the *machine* lifecycle (render persistence, join, derived state). Owner verbs take a `userId` actor and would make it a two-audience interface at ~950 lines. |
| `src/lib/solicitation/batch-view.ts` | **deepen** | Same interface (`readLatestBatch` → `BatchView`), more behaviour behind it. |
| `src/app/api/dashboard/contacts/location-scope.ts` | **deepen** | One more verb beside `requireContactsWriteAccess`; inlining the flag check into two routes would fork invariant #13's gate-first ordering. |
| `src/lib/agents/run-spine.ts` | **deepen** | Two entries in `STEP_PERSONA`. No interface change. |
| `.../requests/ApprovalPanel.tsx` | **NEW** | Interactive, owns selection state, posts. `BatchReport` is documented pure presentation of the Spoilage report — a different responsibility and a different test surface. |
| the two `route.ts` files | thin adapters | Parse, call one module function, map the result union to a status code. |

**No abstraction before the second use:** `approveBatch` ships with owner semantics only (`approval_method='owner'`, `approvedByUserId` required). #631 widens it for `auto_policy`; do **not** pre-generalise it here.

---

## File structure

**Create**
- `supabase/migrations/108_outreach_owner_excluded_disposition.sql`
- `src/lib/solicitation/approval.ts`
- `src/lib/solicitation/__tests__/approval.test.ts`
- `src/lib/solicitation/__tests__/approval.integration.test.ts`
- `src/app/api/dashboard/solicitation/batch/approve/route.ts`
- `src/app/api/dashboard/solicitation/batch/halt/route.ts`
- `src/app/api/dashboard/solicitation/batch/__tests__/approval-routes.test.ts`
- `src/app/(authenticated)/dashboard/requests/ApprovalPanel.tsx`
- `src/app/(authenticated)/dashboard/requests/__tests__/approval-panel.test.tsx`

**Modify**
- `src/lib/shared/__tests__/helpers/schema-ready.ts` — add `MIGRATION_108_OUTREACH_OWNER_EXCLUDED`
- `.claude/reference/migrations-log.md` — head bump 107 → 108 + entry
- `src/lib/agents/run-spine.ts` — two `STEP_PERSONA` keys
- `src/lib/solicitation/batch-view.ts` — `sendLane` arm + readiness query
- `src/lib/solicitation/__tests__/batch-view.test.ts` — sendLane cases
- `src/app/api/dashboard/contacts/location-scope.ts` — `requireSolicitationSendWriteAccess`
- `src/app/api/dashboard/solicitation/batch/route.ts` — pass the flag through
- `src/app/(authenticated)/dashboard/requests/RequestsClient.tsx` — mount the panel, refetch on change
- `src/app/(authenticated)/dashboard/requests/requests.css` — panel styles
- `src/app/(authenticated)/dashboard/requests/__tests__/requests-client.test.tsx` + `batch-report.test.tsx` — `sendLane: null` in fixtures
- `docs/directory.md`, `CONTEXT.md`

---

## Task graph

| Task | Blocked by | Notes |
|---|---|---|
| 1 — eval task | — | runs ALONE (enforcement spot check) |
| 2 — migration 108 | 1 | runs alone; migration-bearing |
| 3 — `approveBatch` | 2 | **independent of 5** |
| 5 — read model | 2 | **independent of 3** |
| 4 — `haltBatch` | 3 | same file as 3 → serial |
| 6 — routes | 3, 4, 5 | |
| 7 — UI | 5, 6 | |
| 8 — docs | all | |

Tasks 3 and 5 are mutually independent (no edges, disjoint file sets) and may be dispatched concurrently after Task 2.

---

### Task 1: Eval task — the spec in executable form

**Files:**
- Create: `src/lib/solicitation/__tests__/approval.test.ts`
- Create: `src/lib/solicitation/__tests__/approval.integration.test.ts`
- Create: `src/app/api/dashboard/solicitation/batch/__tests__/approval-routes.test.ts`
- Create: `src/app/(authenticated)/dashboard/requests/__tests__/approval-panel.test.tsx`
- Modify: `src/lib/solicitation/__tests__/batch-view.test.ts`

Every title below is copied VERBATIM from `.feature/intake.json` → `tests_to_add`. The verify gate's `promised-tests` row matches them character for character; retitling one means updating the intake in the same commit.

- [ ] **Step 1: Write the pure-unit eval file**

`src/lib/solicitation/__tests__/approval.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { deriveBatchState, type BatchLifecycleRow } from '../outreach';
import { ownerHaltReason } from '../approval';

const EPOCH = new Date('2026-08-16T12:00:00.000Z');

function lifecycle(overrides: Partial<BatchLifecycleRow> = {}): BatchLifecycleRow {
  return {
    built_at: EPOCH,
    approved_at: null,
    veto_deadline_at: null,
    sending_started_at: null,
    send_closed_at: null,
    halted_at: null,
    ...overrides,
  };
}

describe('invariants', () => {
  it('property: deriveBatchState returns the highest-precedence state for any lifecycle timestamp combination', () => {
    const stamp = fc.option(fc.date({ min: new Date('2026-01-01'), max: new Date('2027-01-01') }), {
      nil: null,
    });
    fc.assert(
      fc.property(stamp, stamp, stamp, stamp, stamp, stamp, (built, approved, veto, sending, closed, halted) => {
        const row: BatchLifecycleRow = {
          built_at: built,
          approved_at: approved,
          veto_deadline_at: veto,
          sending_started_at: sending,
          send_closed_at: closed,
          halted_at: halted,
        };
        const state = deriveBatchState(row, EPOCH);
        if (halted !== null) return state === 'halted';
        if (closed !== null) return state === 'closed';
        if (sending !== null) return state === 'sending';
        if (approved !== null) return state === 'veto_window' || state === 'approved';
        if (built === null) return state === 'pending';
        return state === 'built' || state === 'expired';
      }),
    );
  });

  it('property: the owner halt reason is owner_veto exactly when sending has not started', () => {
    fc.assert(
      fc.property(fc.constantFrom('built', 'approved', 'veto_window', 'sending', 'expired'), (state) => {
        const reason = ownerHaltReason(state);
        return state === 'sending' ? reason === 'owner_halt' : reason === 'owner_veto';
      }),
    );
  });
});

describe('deriveBatchState send-lane arms', () => {
  it('reports the derived batch state and approval readiness on the built batch view', () => {
    expect(deriveBatchState(lifecycle(), EPOCH)).toBe('built');
    expect(
      deriveBatchState(
        lifecycle({ approved_at: EPOCH, veto_deadline_at: new Date(EPOCH.getTime() + 60_000) }),
        EPOCH,
      ),
    ).toBe('veto_window');
  });
});
```

> `reports the derived batch state and approval readiness on the built batch view` is asserted twice on purpose: here over the pure function, and in Task 5 over the live read model. The gate matches the title in any test file.

- [ ] **Step 2: Write the live-DB eval file as `.todo` stubs**

`src/lib/solicitation/__tests__/approval.integration.test.ts` — one `it.todo` per title, so the file compiles before `approval.ts` exists:

```ts
import { describe, it } from 'vitest';

describe('approveBatch', () => {
  it.todo('approves a built batch with owner method and a 15-minute veto deadline');
  it.todo('a second approval writes nothing and reports the batch as already approved');
  it.todo('cancels excluded asks owner_excluded in the same transaction as the approval');
  it.todo('refuses to approve while a send ask has no outreach row');
  it.todo('refuses to approve a batch past its 7-day approval window');
  it.todo('excluding every ask closes the batch and terminalizes the send parent completed');
  it.todo('records the approval as a step on the send batch parent');
});

describe('haltBatch', () => {
  it.todo('halt latches once and a second halt writes nothing');
  it.todo('halt cancels rendered and queued rows and never a sending row');
  it.todo('halt before sending starts records owner_veto and after it records owner_halt');
  it.todo('refuses to halt a batch that is already closed');
  it.todo('halts a built batch that was never approved');
});

describe('tenant scope', () => {
  it.todo('refuses to approve or halt a batch owned by another account');
});
```

- [ ] **Step 3: Write the route eval file as `.todo` stubs**

`src/app/api/dashboard/solicitation/batch/__tests__/approval-routes.test.ts`:

```ts
import { describe, it } from 'vitest';

describe('POST /api/dashboard/solicitation/batch/approve', () => {
  it.todo('returns 404 from the approve route when send mode is off');
  it.todo('rejects an approval when the subscription does not grant full access');
  it.todo('treats a trialing subscription as full access at approval');
  it.todo('rejects an approval that carries no location scope');
  it.todo('rejects a cross-origin approval post');
});

describe('POST /api/dashboard/solicitation/batch/halt', () => {
  it.todo('returns 404 from the halt route when send mode is off');
});
```

- [ ] **Step 4: Write the UI eval file as `.todo` stubs**

`src/app/(authenticated)/dashboard/requests/__tests__/approval-panel.test.tsx`:

```tsx
import { describe, it } from 'vitest';

describe('ApprovalPanel', () => {
  it.todo('shows the approve control only when every ask has rendered');
  it.todo('excludes an ask when its control is cleared and approves the rest');
  it.todo('shows the stop control while the batch is in its veto window');
  it.todo('shows the expired state with no approve control');
  it.todo('shows a halted batch as read-only and states it cannot be resumed');
});
```

- [ ] **Step 5: Add the two read-model titles to the existing batch-view suite**

Append to `src/lib/solicitation/__tests__/batch-view.test.ts` inside the existing top-level `describe`:

```ts
  it.todo('omits every send-lane field from the batch view when send mode is off');
  it.todo('reports a moderation_high attempt without its subject or body');
```

- [ ] **Step 6: Run the eval files and confirm the shape**

Run: `pnpm vitest run src/lib/solicitation/__tests__/approval.test.ts`
Expected: FAIL — `Cannot find module '../approval'`. The `.todo` files report as skipped, not failed.

- [ ] **Step 7: Commit**

```bash
git add src/lib/solicitation/__tests__/approval.test.ts \
        src/lib/solicitation/__tests__/approval.integration.test.ts \
        src/app/api/dashboard/solicitation/batch/__tests__/approval-routes.test.ts \
        'src/app/(authenticated)/dashboard/requests/__tests__/approval-panel.test.tsx' \
        src/lib/solicitation/__tests__/batch-view.test.ts
git commit -m "test(solicitation): eval task for the owner approval lane (#629)"
```

---

### Task 2: Migration 108 — `owner_excluded` joins the cancel disposition set

**Files:**
- Create: `supabase/migrations/108_outreach_owner_excluded_disposition.sql`
- Modify: `src/lib/shared/__tests__/helpers/schema-ready.ts`
- Modify: `.claude/reference/migrations-log.md`

Head is **107**; this is **108**. Invoke the `new-migration` skill before writing the SQL.

- [ ] **Step 1: Write the migration**

```sql
-- 108_outreach_owner_excluded_disposition.sql
--
-- Adds 'owner_excluded' to solicitation_outreach's CANCEL disposition set so
-- the owner approval lane (#629, executor spec D23) can record a per-ask
-- exclusion. 091 shipped the cancel set without it — the term existed only in
-- the spec — so partial approval could not be written at all.
--
-- Additive and re-runnable: one CHECK is replaced by a wider one. No data
-- change; no row can carry the new value until #629's writer ships. Rollback
-- is re-applying 091's constraint text verbatim.
--
-- The whole predicate is RE-SPELLED rather than patched: a CHECK cannot be
-- widened in place, and re-spelling keeps this file readable next to 091.

ALTER TABLE solicitation_outreach
  DROP CONSTRAINT IF EXISTS solicitation_outreach_status_reason_consistency;

ALTER TABLE solicitation_outreach
  ADD CONSTRAINT solicitation_outreach_status_reason_consistency CHECK (
    (
      (delivery_status IN ('rendered', 'queued', 'sending', 'sent')
        AND disposition_reason IS NULL) OR
      (delivery_status = 'withheld' AND disposition_reason IN (
        'moderation_high', 'render_failed', 'lint_failed',
        'no_consent', 'suppressed', 'unsubscribed'
      )) OR
      (delivery_status = 'cancelled' AND disposition_reason IN (
        'owner_veto', 'owner_halt', 'admin_halt', 'owner_excluded',
        'batch_expired', 'send_window_elapsed', 'superseded'
      )) OR
      (delivery_status = 'failed' AND disposition_reason IN (
        'send_failed', 'send_exhausted'
      )) OR
      (delivery_status = 'unknown' AND disposition_reason = 'send_indeterminate')
    ) IS TRUE
  );

COMMENT ON CONSTRAINT solicitation_outreach_status_reason_consistency ON solicitation_outreach IS
  'Status <-> reason totality. 108 added owner_excluded to the cancel set for the owner approval lane (#629 D23); every other arm is 091 verbatim.';
```

- [ ] **Step 2: Register the schema requirement**

Append to `src/lib/shared/__tests__/helpers/schema-ready.ts`, after `MIGRATION_099_SOLICITATION_POSTAL_ADDRESS`:

```ts
/**
 * 108 REPLACES 091's status/reason CHECK with one that admits
 * `owner_excluded`. The constraint NAME is unchanged, so naming it here proves
 * only what 091 already guarantees — the distinguishing fact is the new member,
 * which no catalogue view exposes cheaply. Suites that write an exclusion must
 * therefore name this requirement AND accept that a 091-only database fails at
 * the INSERT rather than at assertSchemaReady. That is the honest bound: a
 * behavioural assertion, not a schema one.
 */
export const MIGRATION_108_OUTREACH_OWNER_EXCLUDED: SchemaRequirement = {
  migration: '108_outreach_owner_excluded_disposition',
  constraints: [
    { table: 'solicitation_outreach', name: 'solicitation_outreach_status_reason_consistency' },
  ],
};
```

- [ ] **Step 3: Bump the migrations log**

In `.claude/reference/migrations-log.md`, change `Current head: **107** — next migration is **108**` to `Current head: **108** — next migration is **109**`, and add the entry in the existing per-migration format, including the "APPLIED TO STAGING" line left blank until Task 8's staging ride.

- [ ] **Step 4: Provision the local test DB and verify**

```bash
pnpm test:db:setup
psql "$TEST_DATABASE_POOL_URL" -c "\d+ solicitation_outreach" | grep owner_excluded
```
Expected: the constraint text contains `owner_excluded`.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/108_outreach_owner_excluded_disposition.sql \
        src/lib/shared/__tests__/helpers/schema-ready.ts \
        .claude/reference/migrations-log.md
git commit -m "feat(db): migration 108 — owner_excluded cancel disposition (#629)"
```

---

### Task 3: `approveBatch` — the Owner approval writer

**Files:**
- Create: `src/lib/solicitation/approval.ts`
- Modify: `src/lib/agents/run-spine.ts`
- Test: `src/lib/solicitation/__tests__/approval.integration.test.ts`

- [ ] **Step 1: Add the two step keys**

In `src/lib/agents/run-spine.ts`, inside `STEP_PERSONA`, after `send_batch_closed`:

```ts
  batch_approved: 'solicitation',
  batch_halted: 'solicitation',
```

`step_key` has no DB CHECK — these are TS-only and need no migration.

- [ ] **Step 2: Write the module header and the pure helper**

Create `src/lib/solicitation/approval.ts`:

```ts
/**
 * The two owner verbs of send-mode's approval lane (#629; executor design
 * 2026-07-28 D9/D10/D22/D23).
 *
 * What lives here and nothing else: `approveBatch` and `haltBatch`. Both are
 * transactional writers with an actor; both return a discriminated result so
 * their routes stay thin (invariant #12) and neither throws for an outcome the
 * owner can cause.
 *
 * Deliberately NOT in outreach.ts: that module's interface is the machine
 * lifecycle (render persistence, the join, the derived state) and has no actor
 * in any signature. These two do, and they are the only writers a human
 * triggers.
 *
 * LOCK ORDER (amendment B11, and the reason both verbs share one shape):
 * advisory batch lock -> `solicitation_batches` row -> `agent_runs`. Every
 * run-spine call (recordStep, closeBatchIfSettled) therefore happens LAST.
 * Taking the run lock first is an ABBA deadlock against the offboarding purge.
 *
 * Domain module: the caller supplies `sql` (invariant #15) and both tenant ids
 * (invariant #8) — a batch id is a bare UUID carrying no tenant proof.
 */

import type { Sql, TransactionSql } from 'postgres';
import { recordStep } from '@/lib/agents/run-spine';
import { acquireSolicitationBatchLock } from './batch-builder';
import {
  closeBatchIfSettled,
  deriveBatchState,
  type BatchLifecycleRow,
  type BatchState,
  type CloseBatchIfSettledResult,
} from './outreach';

/** The owner veto window (D9): an undo, not a review window — the owner has
 *  already read every rendered message. The auto lane's 60-minute window is
 *  anchored differently and belongs to #631. */
export const VETO_WINDOW_MINUTES_OWNER = 15;

/** The two Halt-latch reasons an OWNER can cause. `admin_halt`,
 *  `send_window_elapsed` and `batch_expired` are the same latch with other
 *  writers (#630 and the admin surface); this module cannot spell them. */
export type OwnerHaltReason = 'owner_veto' | 'owner_halt';

/**
 * A veto is "halt at zero sends" (D10) — the same write, a different reason.
 * The reason is derived from the Batch state server-side and NEVER read from
 * the request: a client that could name its own reason could file a mid-drip
 * halt as a veto and make the audit trail lie about whether email had left.
 */
export function ownerHaltReason(state: BatchState): OwnerHaltReason {
  return state === 'sending' ? 'owner_halt' : 'owner_veto';
}
```

- [ ] **Step 3: Write the shared row loader**

Append to `approval.ts`:

```ts
interface BatchActionRow extends BatchLifecycleRow {
  send_parent_run_id: string | null;
}

/**
 * The locked batch row plus its Send batch parent, in ONE statement under the
 * advisory lock. Returns null when the batch does not exist for this tenant —
 * the caller maps that onto the uniform 404, so a foreign batch id and an
 * unknown one are indistinguishable.
 */
async function lockBatchForAction(
  tx: TransactionSql,
  input: { batchId: string; accountId: string; businessId: string },
): Promise<BatchActionRow | null> {
  await acquireSolicitationBatchLock(tx, input.businessId);

  const [batch] = await tx<BatchActionRow[]>`
    SELECT
      b.built_at,
      b.approved_at,
      b.veto_deadline_at,
      b.sending_started_at,
      b.send_closed_at,
      b.halted_at,
      (
        SELECT r.id
        FROM agent_runs r
        WHERE r.kind = 'solicitation_send_batch'
          AND r.subject_type = 'solicitation_batch'
          AND r.subject_id = b.id::text
          AND r.account_id = ${input.accountId}::uuid
          AND r.business_id = ${input.businessId}::uuid
        ORDER BY r.started_at DESC
        LIMIT 1
      ) AS send_parent_run_id
    FROM solicitation_batches b
    WHERE b.id = ${input.batchId}::uuid
      AND b.account_id = ${input.accountId}::uuid
      AND b.business_id = ${input.businessId}::uuid
    FOR UPDATE OF b
  `;
  return batch ?? null;
}
```

- [ ] **Step 4: Write `approveBatch`**

Append to `approval.ts`:

```ts
export interface ApproveBatchInput {
  batchId: string;
  accountId: string;
  businessId: string;
  /** The acting owner. Required: 091's approval-consistency CHECK demands a
   *  non-NULL approver whenever approval_method='owner'. */
  approvedByUserId: string;
  /** Outreach row ids the owner deselected. Every id must be a live `rendered`
   *  row of THIS batch or the whole approval is refused (fail-closed). */
  excludedOutreachIds: string[];
}

export type ApproveBatchResult =
  | {
      status: 'approved';
      approvedCount: number;
      excludedCount: number;
      vetoDeadlineAt: string;
      /** Present only when the approval settled the batch outright — the
       *  exclude-everything case. */
      close: CloseBatchIfSettledResult | null;
    }
  | { status: 'already_approved' }
  /** Generation has not finished: approving now would let a row render AFTER
   *  approval and become releasable unseen, breaking the byte-for-byte
   *  contract. */
  | { status: 'not_ready'; missingRenders: number }
  | { status: 'not_approvable'; state: BatchState }
  | { status: 'unknown_exclusion' }
  | { status: 'not_found' };

export async function approveBatch(
  sql: Sql,
  input: ApproveBatchInput,
): Promise<ApproveBatchResult> {
  return sql.begin(async (tx): Promise<ApproveBatchResult> => {
    const batch = await lockBatchForAction(tx, input);
    if (batch === null) return { status: 'not_found' };

    // Read the state ONCE, under the lock, from the same row every write below
    // targets. `expired` lands here: past built_at + 7 days neither lane may
    // approve (D2).
    const state = deriveBatchState(batch, new Date());
    if (state !== 'built') {
      return batch.approved_at !== null
        ? { status: 'already_approved' }
        : { status: 'not_approvable', state };
    }

    // Readiness: every send Ask must already have a non-cancelled Outreach row.
    // Asserted in SQL rather than trusted from the client, and inside the same
    // transaction as the approval, so a render committing between the check and
    // the CAS cannot slip through.
    const [gap] = await tx<{ missing: number }[]>`
      SELECT COUNT(*)::int AS missing
      FROM solicitation_asks a
      WHERE a.batch_id = ${input.batchId}::uuid
        AND a.account_id = ${input.accountId}::uuid
        AND a.business_id = ${input.businessId}::uuid
        AND a.status = 'send'
        AND NOT EXISTS (
          SELECT 1
          FROM solicitation_outreach o
          WHERE o.ask_id = a.id
            AND o.batch_id = a.batch_id
            AND o.delivery_status <> 'cancelled'
        )
    `;
    const missingRenders = gap?.missing ?? 0;
    if (missingRenders > 0) return { status: 'not_ready', missingRenders };

    // Exclusions first: an id that is not a live rendered row of this batch
    // means the owner acted on a stale screen, so the whole approval is
    // refused rather than silently approving a message they meant to drop.
    let excludedCount = 0;
    if (input.excludedOutreachIds.length > 0) {
      const excluded = await tx<{ id: string }[]>`
        UPDATE solicitation_outreach
        SET delivery_status = 'cancelled',
            disposition_reason = 'owner_excluded',
            updated_at = NOW()
        WHERE id = ANY(${input.excludedOutreachIds}::uuid[])
          AND batch_id = ${input.batchId}::uuid
          AND account_id = ${input.accountId}::uuid
          AND business_id = ${input.businessId}::uuid
          AND delivery_status = 'rendered'
        RETURNING id
      `;
      if (excluded.count !== input.excludedOutreachIds.length) {
        return { status: 'unknown_exclusion' };
      }
      excludedCount = excluded.count;
    }

    // The CAS. `approved_at IS NULL` makes a double-submit a no-op rather than
    // a second approval with a fresh veto deadline (D23).
    const [approved] = await tx<{ veto_deadline_at: string }[]>`
      UPDATE solicitation_batches
      SET approved_at = NOW(),
          approval_method = 'owner',
          approved_by_user_id = ${input.approvedByUserId}::uuid,
          veto_deadline_at = NOW() + make_interval(mins => ${VETO_WINDOW_MINUTES_OWNER})
      WHERE id = ${input.batchId}::uuid
        AND account_id = ${input.accountId}::uuid
        AND business_id = ${input.businessId}::uuid
        AND approved_at IS NULL
      RETURNING veto_deadline_at::text AS veto_deadline_at
    `;
    if (approved === undefined) return { status: 'already_approved' };

    const [live] = await tx<{ approved: number }[]>`
      SELECT COUNT(*)::int AS approved
      FROM solicitation_outreach
      WHERE batch_id = ${input.batchId}::uuid
        AND account_id = ${input.accountId}::uuid
        AND business_id = ${input.businessId}::uuid
        AND delivery_status = 'rendered'
    `;
    const approvedCount = live?.approved ?? 0;

    // The parent must exist: readiness passed, so generation ran and minted
    // one. A missing parent here is a broken invariant, not a branch to
    // absorb — fail loudly rather than approving a batch nothing can close.
    if (batch.send_parent_run_id === null) {
      throw new Error(
        `approveBatch: batch ${input.batchId} passed readiness with no send parent run`,
      );
    }

    await recordStep(tx, {
      runId: batch.send_parent_run_id,
      stepKey: 'batch_approved',
      detail: {
        approval_method: 'owner',
        approved_by_user_id: input.approvedByUserId,
        approved_count: approvedCount,
        excluded_count: excludedCount,
        veto_window_minutes: VETO_WINDOW_MINUTES_OWNER,
      },
    });

    // Exclude-everything settles the batch the instant it is approved. Calling
    // the join here — in the SAME transaction, like every other terminal
    // writer (D11) — is what keeps parent terminalization to one owner. It
    // no-ops (`not_settled`) whenever anything is still live.
    const close = await closeBatchIfSettled(tx, {
      batchId: input.batchId,
      accountId: input.accountId,
      businessId: input.businessId,
    });

    return {
      status: 'approved',
      approvedCount,
      excludedCount,
      vetoDeadlineAt: approved.veto_deadline_at,
      close: close.status === 'not_settled' ? null : close,
    };
  });
}
```

- [ ] **Step 5: Turn the seven `approveBatch` todos into real tests**

In `src/lib/solicitation/__tests__/approval.integration.test.ts`, replace the `approveBatch` describe block. Follow `src/lib/solicitation/__tests__/outreach-close.integration.test.ts` for fixture construction and `assertSchemaReady` usage; name `MIGRATION_091_SEND_MODE_SPINE_LIFECYCLE` and `MIGRATION_108_OUTREACH_OWNER_EXCLUDED`. The file must NOT execute DDL (`ci:live-db-suites`).

```ts
  it('approves a built batch with owner method and a 15-minute veto deadline', async () => {
    const { batchId, accountId, businessId, userId } = await seedRenderedBatch(sql, { renders: 3 });

    const result = await approveBatch(sql, {
      batchId, accountId, businessId,
      approvedByUserId: userId,
      excludedOutreachIds: [],
    });

    expect(result).toMatchObject({ status: 'approved', approvedCount: 3, excludedCount: 0 });
    const [row] = await sql<{ approval_method: string; gap_minutes: number }[]>`
      SELECT approval_method,
             EXTRACT(EPOCH FROM (veto_deadline_at - approved_at))::int / 60 AS gap_minutes
      FROM solicitation_batches WHERE id = ${batchId}::uuid
    `;
    expect(row.approval_method).toBe('owner');
    expect(row.gap_minutes).toBe(15);
  });
```

Write the remaining six against the same `seedRenderedBatch` helper:
`a second approval writes nothing and reports the batch as already approved` (call twice, assert the second is `already_approved` and `approved_at` is unchanged);
`cancels excluded asks owner_excluded in the same transaction as the approval` (exclude one of three, assert `delivery_status='cancelled'` + `disposition_reason='owner_excluded'` and `approvedCount` 2);
`refuses to approve while a send ask has no outreach row` (seed 3 send asks with 2 renders, assert `not_ready` with `missingRenders: 1` and `approved_at IS NULL`);
`refuses to approve a batch past its 7-day approval window` (seed `built_at = NOW() - interval '8 days'`, assert `{ status:'not_approvable', state:'expired' }`);
`excluding every ask closes the batch and terminalizes the send parent completed` (exclude all three, assert `send_closed_at IS NOT NULL` and the parent run is `completed`);
`records the approval as a step on the send batch parent` (assert one `agent_run_steps` row with `step_key='batch_approved'`, `attributed_agent='solicitation'`, and `detail->>'approved_count'` = `'3'`).

- [ ] **Step 6: Run the suite**

Run: `TEST_DATABASE_POOL_URL=$TEST_DATABASE_POOL_URL pnpm vitest run --project integration src/lib/solicitation/__tests__/approval.integration.test.ts -t approveBatch`
Expected: 7 passing.

- [ ] **Step 7: Commit**

```bash
git add src/lib/solicitation/approval.ts src/lib/agents/run-spine.ts \
        src/lib/solicitation/__tests__/approval.integration.test.ts
git commit -m "feat(solicitation): approveBatch with per-ask exclusion (#629)"
```

---

### Task 4: `haltBatch` — the owner arm of the Halt latch

**Files:**
- Modify: `src/lib/solicitation/approval.ts`
- Test: `src/lib/solicitation/__tests__/approval.integration.test.ts`

- [ ] **Step 1: Write `haltBatch`**

Append to `approval.ts`:

```ts
export interface HaltBatchInput {
  batchId: string;
  accountId: string;
  businessId: string;
  haltedByUserId: string;
}

export type HaltBatchResult =
  | {
      status: 'halted';
      reason: OwnerHaltReason;
      cancelledCount: number;
      close: CloseBatchIfSettledResult;
    }
  | { status: 'already_halted' }
  /** A closed batch is terminal — there is nothing left to stop. */
  | { status: 'not_haltable'; state: BatchState }
  | { status: 'not_found' };

/**
 * One monotone latch (D10). A veto inside the window and a mid-drip halt are
 * the same write; only the reason differs, and it is derived, never supplied.
 *
 * A batch that was never approved is haltable on purpose: that is the owner
 * discarding a built batch, and routing it through the latch means one code
 * path closes every batch that ends early.
 *
 * There is no resume, and it is structural: `halted_at` is monotone, the
 * releaser predicate (#630) requires `halted_at IS NULL`, and the rows this
 * cancels are terminal.
 */
export async function haltBatch(
  sql: Sql,
  input: HaltBatchInput,
): Promise<HaltBatchResult> {
  return sql.begin(async (tx): Promise<HaltBatchResult> => {
    const batch = await lockBatchForAction(tx, input);
    if (batch === null) return { status: 'not_found' };

    const state = deriveBatchState(batch, new Date());
    if (state === 'halted') return { status: 'already_halted' };
    if (state === 'closed') return { status: 'not_haltable', state };

    const reason = ownerHaltReason(state);

    // CAS on NULL keeps the latch monotone: a second halt returns above, and a
    // concurrent one writes nothing here.
    const [latched] = await tx<{ id: string }[]>`
      UPDATE solicitation_batches
      SET halted_at = NOW(),
          halt_reason = ${reason},
          halted_by = ${input.haltedByUserId}::uuid
      WHERE id = ${input.batchId}::uuid
        AND account_id = ${input.accountId}::uuid
        AND business_id = ${input.businessId}::uuid
        AND halted_at IS NULL
      RETURNING id
    `;
    if (latched === undefined) return { status: 'already_halted' };

    // 'sending' is excluded on purpose: that row is past the point of no
    // return and resolves itself. Halt means "no further sends", not "undo".
    const cancelled = await tx<{ id: string }[]>`
      UPDATE solicitation_outreach
      SET delivery_status = 'cancelled',
          disposition_reason = ${reason},
          updated_at = NOW()
      WHERE batch_id = ${input.batchId}::uuid
        AND account_id = ${input.accountId}::uuid
        AND business_id = ${input.businessId}::uuid
        AND delivery_status IN ('rendered', 'queued')
      RETURNING id
    `;

    // The parent may legitimately be absent — an owner can discard a built
    // batch whose generation never minted one. Skip the step, still join.
    if (batch.send_parent_run_id !== null) {
      await recordStep(tx, {
        runId: batch.send_parent_run_id,
        stepKey: 'batch_halted',
        detail: {
          halt_reason: reason,
          halted_by: input.haltedByUserId,
          cancelled_count: cancelled.count,
          state_at_halt: state,
        },
      });
    }

    const close = await closeBatchIfSettled(tx, {
      batchId: input.batchId,
      accountId: input.accountId,
      businessId: input.businessId,
    });

    return { status: 'halted', reason, cancelledCount: cancelled.count, close };
  });
}
```

- [ ] **Step 2: Turn the six halt/tenant todos into real tests**

`halt latches once and a second halt writes nothing` — halt twice; second is `already_halted`, `halted_at` unchanged.
`halt cancels rendered and queued rows and never a sending row` — seed one row per status; assert the `sending` row keeps `delivery_status='sending'` and a NULL reason.
`halt before sending starts records owner_veto and after it records owner_halt` — two batches, one with `sending_started_at` set; assert both `halt_reason` values.
`refuses to halt a batch that is already closed` — seed `send_closed_at`; assert `{ status:'not_haltable', state:'closed' }`.
`halts a built batch that was never approved` — no `approved_at`; assert `owner_veto` and no throw when `send_parent_run_id` is NULL.
`refuses to approve or halt a batch owned by another account` — call both verbs with a foreign `accountId`; assert `not_found` from each and that the batch row is untouched.

- [ ] **Step 3: Run the whole suite**

Run: `TEST_DATABASE_POOL_URL=$TEST_DATABASE_POOL_URL pnpm vitest run --project integration src/lib/solicitation/__tests__/approval.integration.test.ts`
Expected: 13 passing, 0 todo.

- [ ] **Step 4: Run the pure suite**

Run: `pnpm vitest run src/lib/solicitation/__tests__/approval.test.ts`
Expected: 3 passing (both property tests green).

- [ ] **Step 5: Commit**

```bash
git add src/lib/solicitation/approval.ts src/lib/solicitation/__tests__/approval.integration.test.ts
git commit -m "feat(solicitation): haltBatch, the owner arm of the halt latch (#629)"
```

---

### Task 5: Read model — the `sendLane` arm

**Files:**
- Modify: `src/lib/solicitation/batch-view.ts`
- Modify: `src/app/api/dashboard/solicitation/batch/route.ts`
- Test: `src/lib/solicitation/__tests__/batch-view.test.ts`

Independent of Tasks 3 and 4 — different files, no shared symbols.

- [ ] **Step 1: Add the view type**

In `batch-view.ts`, after `AskAttemptView`:

```ts
/**
 * The send lane as the owner reads it. `null` on the BatchView when
 * SOLICITATION_SEND_ENABLED is off — invariant #13: the browser learns flag
 * state from the response shape, never from a NEXT_PUBLIC companion.
 */
export interface SendLaneView {
  batchState: BatchState;
  /** True when every send Ask has a non-cancelled Outreach row — the
   *  precondition approveBatch re-asserts under its lock. */
  ready: boolean;
  /** Send Asks with no Outreach row yet; 0 once generation settles. */
  pendingRenders: number;
  approvedAt: string | null;
  vetoDeadlineAt: string | null;
  haltedAt: string | null;
  haltReason: string | null;
  /** moderation_high attempts as a COUNT (D6a) — the owner sees that some were
   *  held without ever seeing the bytes. */
  moderationWithheld: number;
}
```

Add `sendLane: SendLaneView | null;` to the `'built'` arm of `BatchView`.

- [ ] **Step 2: Gate the read on the flag**

Change the signature to `readLatestBatch(sql: Sql, accountId: string, businessId: string, options: { sendLane: boolean })` and thread `options` into `readBuiltBatch`. When `options.sendLane` is false, return `sendLane: null` **and** `attempts: []` — the flag masters the whole send-lane presentation, so a batch rendered before the flag was switched off does not keep surfacing bodies. (#628 shipped `attempts` unconditional; this narrows it deliberately.)

The flag is read by the ROUTE, not here: a read model that reads env cannot be tested without mutating `process.env`.

- [ ] **Step 3: Read the lifecycle row and the readiness counts**

Inside `readBuiltBatch`, when `options.sendLane` is true, add one statement to the existing REPEATABLE READ transaction:

```ts
  const [lane] = await tx<{
    built_at: Date | null;
    approved_at: Date | null;
    veto_deadline_at: Date | null;
    sending_started_at: Date | null;
    send_closed_at: Date | null;
    halted_at: Date | null;
    approvedAtText: string | null;
    vetoDeadlineAtText: string | null;
    haltedAtText: string | null;
    haltReason: string | null;
    pendingRenders: number;
    moderationWithheld: number;
  }[]>`
    SELECT b.built_at, b.approved_at, b.veto_deadline_at,
           b.sending_started_at, b.send_closed_at, b.halted_at,
           b.approved_at::text       AS "approvedAtText",
           b.veto_deadline_at::text  AS "vetoDeadlineAtText",
           b.halted_at::text         AS "haltedAtText",
           b.halt_reason             AS "haltReason",
           (
             SELECT COUNT(*)::int FROM solicitation_asks a
             WHERE a.batch_id = b.id AND a.account_id = b.account_id
               AND a.business_id = b.business_id AND a.status = 'send'
               AND NOT EXISTS (
                 SELECT 1 FROM solicitation_outreach o
                 WHERE o.ask_id = a.id AND o.batch_id = a.batch_id
                   AND o.delivery_status <> 'cancelled')
           ) AS "pendingRenders",
           (
             SELECT COUNT(*)::int FROM solicitation_outreach o
             WHERE o.batch_id = b.id AND o.account_id = b.account_id
               AND o.business_id = b.business_id
               AND o.disposition_reason = ${MODERATION_HIGH}
           ) AS "moderationWithheld"
      FROM solicitation_batches b
     WHERE b.id = ${batch.id}::uuid
       AND b.account_id = ${accountId}::uuid
       AND b.business_id = ${businessId}::uuid
  `;
```

Both timestamp shapes are selected on purpose: `deriveBatchState` needs JS `Date`s, the view ships `::text` so postgres.js's microsecond truncation never reaches the wire.

Build the arm with `deriveBatchState(lane, new Date())` and `ready: lane.pendingRenders === 0`.

- [ ] **Step 4: Pass the flag from the route**

In `src/app/api/dashboard/solicitation/batch/route.ts`, import `solicitationSendEnabled` and call `readLatestBatch(sql, accountId, location.locationId, { sendLane: solicitationSendEnabled() })`. Add `batchState` to the existing `logger.log('batch_view_read', …)` object.

- [ ] **Step 5: Write the two read-model tests**

Replace the two `it.todo`s in `batch-view.test.ts`:
`omits every send-lane field from the batch view when send mode is off` — call with `{ sendLane: false }`, assert `sendLane` is `null` and `attempts` is `[]` even with an outreach row seeded.
`reports a moderation_high attempt without its subject or body` — assert the attempt is `{ redacted: true }` with no `subject`/`body` keys and `sendLane.moderationWithheld === 1`.

- [ ] **Step 6: Fix the existing fixtures**

`requests-client.test.tsx` and `batch-report.test.tsx` build `built` views; add `sendLane: null` to each fixture so the types compile.

- [ ] **Step 7: Run and commit**

Run: `pnpm vitest run src/lib/solicitation/__tests__/batch-view.test.ts 'src/app/(authenticated)/dashboard/requests/__tests__'`
Expected: all passing.

```bash
git add src/lib/solicitation/batch-view.ts src/app/api/dashboard/solicitation/batch/route.ts \
        src/lib/solicitation/__tests__/batch-view.test.ts \
        'src/app/(authenticated)/dashboard/requests/__tests__'
git commit -m "feat(solicitation): sendLane arm on the batch view (#629)"
```

---

### Task 6: The two routes

**Files:**
- Create: `src/app/api/dashboard/solicitation/batch/approve/route.ts`
- Create: `src/app/api/dashboard/solicitation/batch/halt/route.ts`
- Modify: `src/app/api/dashboard/contacts/location-scope.ts`
- Test: `src/app/api/dashboard/solicitation/batch/__tests__/approval-routes.test.ts`

- [ ] **Step 1: Add the send-lane write gate**

In `location-scope.ts`, beside `requireContactsWriteAccess`:

```ts
/**
 * Write preamble for the send-lane mutation routes (#629). BOTH flags, because
 * the send surface lives inside the watch surface: `SOLICITATION_WATCH_ENABLED`
 * owns the Requests screen, `SOLICITATION_SEND_ENABLED` owns the approval lane
 * on it. Gate FIRST (invariant #13), then requireWritableOwner.
 */
export async function requireSolicitationSendWriteAccess(
  sql: Sql,
  request: NextRequest,
): Promise<WritableOwnerResult> {
  if (!solicitationWatchEnabled() || !solicitationSendEnabled()) {
    return { ok: false, response: errorResponse('Not found', 404) };
  }
  return requireWritableOwner(sql, request);
}
```

Import `solicitationSendEnabled` from `@/lib/solicitation/flags`.

- [ ] **Step 2: Write the approve route**

`src/app/api/dashboard/solicitation/batch/approve/route.ts` — modelled on `batch/reviewed/route.ts` line for line (flag gate, scope, same-origin, thin handler):

```ts
// POST /api/dashboard/solicitation/batch/approve — the owner approves a built
// batch, optionally excluding individual asks (#629; executor design D23).
// Route orchestrates only: flag gate, writable-owner auth, same-origin,
// location resolution, body parse; the transaction lives in
// src/lib/solicitation/approval.ts.

import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { errorResponse, jsonResponse, withSameOrigin } from '@/lib/auth/route-helpers';
import { createWorkerLogger } from '@/lib/shared/logger';
import { isValidUuid } from '@/lib/shared/ids';
import { reportCaughtError } from '@/lib/shared/report-caught-error';
import { approveBatch } from '@/lib/solicitation/approval';
import {
  requireContactsLocationScope,
  requireSolicitationSendWriteAccess,
} from '@/app/api/dashboard/contacts/location-scope';

export const dynamic = 'force-dynamic';

const logger = createWorkerLogger('api/dashboard/solicitation/batch/approve');

/** The batch id plus the excluded outreach ids, or null when the body is
 *  absent, malformed, or carries a non-UUID anywhere. */
async function readApproval(
  request: NextRequest,
): Promise<{ batchId: string; excludedOutreachIds: string[] } | null> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return null;
  }
  if (typeof body !== 'object' || body === null) return null;
  const { batchId, excludedOutreachIds } = body as {
    batchId?: unknown;
    excludedOutreachIds?: unknown;
  };
  if (typeof batchId !== 'string' || !isValidUuid(batchId)) return null;
  if (excludedOutreachIds === undefined) return { batchId, excludedOutreachIds: [] };
  if (!Array.isArray(excludedOutreachIds)) return null;
  if (!excludedOutreachIds.every((id) => typeof id === 'string' && isValidUuid(id))) return null;
  return { batchId, excludedOutreachIds };
}

async function approveHandler(request: NextRequest): Promise<NextResponse> {
  const owner = await requireSolicitationSendWriteAccess(sql, request);
  if (!owner.ok) return owner.response;
  const { user, accountId } = owner;

  try {
    const location = await requireContactsLocationScope(sql, request, {
      accountId,
      userLocationId: user.locationId,
    });
    if (!location.ok) return location.response;

    const parsed = await readApproval(request);
    if (parsed === null) return errorResponse('Not found', 404);

    const result = await approveBatch(sql, {
      batchId: parsed.batchId,
      accountId,
      businessId: location.locationId,
      approvedByUserId: user.id,
      excludedOutreachIds: parsed.excludedOutreachIds,
    });

    // Ids and counts only — no rendered subject or body is ever interpolated
    // into a log string (D6e: string args are logged verbatim).
    logger.log('batch_approved', {
      status: result.status,
      batchId: parsed.batchId,
      businessId: location.locationId,
      approvedCount: result.status === 'approved' ? result.approvedCount : 0,
      excludedCount: result.status === 'approved' ? result.excludedCount : 0,
    });

    switch (result.status) {
      case 'approved':
      case 'already_approved':
        return jsonResponse(result);
      case 'not_ready':
      case 'not_approvable':
        return jsonResponse(result, 409);
      case 'unknown_exclusion':
        return jsonResponse(result, 400);
      case 'not_found':
        return errorResponse('Not found', 404);
    }
  } catch (error) {
    reportCaughtError('api/dashboard/solicitation/batch/approve', error, { accountId });
    return errorResponse('Failed to approve batch', 500);
  }
}

export const POST = withSameOrigin()(approveHandler);
```

- [ ] **Step 3: Write the halt route**

Same file shape at `.../batch/halt/route.ts`, reading only `batchId`, calling `haltBatch`, logging `batch_halted` with `haltReason` and `cancelledCount`, and mapping: `halted` / `already_halted` → 200, `not_haltable` → 409, `not_found` → 404.

- [ ] **Step 4: Write the six route tests**

Mock `@/lib/solicitation/approval` and the auth helpers, following `src/app/api/dashboard/solicitation/batch/__tests__/route.test.ts`. Assert:
`returns 404 from the approve route when send mode is off` — with `SOLICITATION_SEND_ENABLED` unset, status 404 and `approveBatch` never called.
`rejects an approval when the subscription does not grant full access` — `requireWritableOwner` returns its refusal; assert that response is returned verbatim.
`treats a trialing subscription as full access at approval` — a `trialing` owner reaches `approveBatch`.
`rejects an approval that carries no location scope` — no `?scope=`, aggregate mode, 400.
`rejects a cross-origin approval post` — a foreign `Origin` header, and `approveBatch` never called.
`returns 404 from the halt route when send mode is off`.

- [ ] **Step 5: Run and commit**

Run: `pnpm vitest run src/app/api/dashboard/solicitation/batch/__tests__/approval-routes.test.ts`
Expected: 6 passing.

```bash
git add src/app/api/dashboard/solicitation/batch/approve src/app/api/dashboard/solicitation/batch/halt \
        src/app/api/dashboard/contacts/location-scope.ts \
        src/app/api/dashboard/solicitation/batch/__tests__/approval-routes.test.ts
git commit -m "feat(api): approve and halt routes for the owner approval lane (#629)"
```

---

### Task 7: The approval panel

**Files:**
- Create: `src/app/(authenticated)/dashboard/requests/ApprovalPanel.tsx`
- Modify: `src/app/(authenticated)/dashboard/requests/RequestsClient.tsx`
- Modify: `src/app/(authenticated)/dashboard/requests/requests.css`
- Test: `src/app/(authenticated)/dashboard/requests/__tests__/approval-panel.test.tsx`

Invoke the `repworth-brand-design` skill before writing markup — this is a Console-system surface; reuse `.card`, `.card-h2`, `.btn`, `.rq-*` tokens already in `requests.css`. Add no new colour values.

- [ ] **Step 1: Write the panel**

`ApprovalPanel.tsx` is a client island that owns exactly three things: which asks are excluded, the in-flight state of a POST, and the resulting error copy. It renders from `view.sendLane` + `view.attempts` and calls `onChanged()` so `RequestsClient` refetches — it never mutates the view it was given.

Render rules, by `sendLane.batchState`:

| State | Renders |
|---|---|
| `built`, `ready: false` | "Still preparing N messages" — no approve control |
| `built`, `ready: true` | the ask list with exclude controls + `Approve and start sending` |
| `veto_window`, `approved`, `sending` | read-only list + `Stop this batch` |
| `expired` | "This batch expired before it was approved" — no controls |
| `halted` | "You stopped this batch. It cannot be resumed." — read-only |
| `closed`, `pending` | read-only summary, no controls |

A `redacted: true` attempt renders its reason and never a body; the count comes from `sendLane.moderationWithheld`. Exclude controls are checkboxes with an accessible label naming the contact; the approve button's label carries the live count (`Approve and send 3 messages`). Announce the outcome through the existing `LiveRegion` by calling `onChanged` with a message.

- [ ] **Step 2: Mount it**

In `RequestsClient.tsx`'s `Screen`, for `phase.view.state === 'built'`, render `<ApprovalPanel …/>` above `<BatchReport …/>` when `phase.view.sendLane !== null`. `onChanged` calls the existing `retry()` so the refetch path stays single-owner.

- [ ] **Step 3: Write the five panel tests**

Render with fixture views; assert per the table above. `excludes an ask when its control is cleared and approves the rest` asserts the POST body carries exactly the cleared row's `outreachId` in `excludedOutreachIds`.

- [ ] **Step 4: Run and commit**

Run: `pnpm vitest run 'src/app/(authenticated)/dashboard/requests/__tests__'`
Expected: all passing.

```bash
git add 'src/app/(authenticated)/dashboard/requests'
git commit -m "feat(requests): owner approval panel with per-ask exclusion (#629)"
```

---

### Task 8: Documentation sweep

**Files:**
- Modify: `docs/directory.md`, `CONTEXT.md`

- [ ] **Step 1: Add the `docs/directory.md` rows**

One row per new production file under `src/lib/` and `worker/` — `ci:directory-map` fails on a missing row: `src/lib/solicitation/approval.ts`. Route and component files are outside the audited roots but follow the section conventions if rows exist for their siblings.

- [ ] **Step 2: Coin the two new terms in `CONTEXT.md`**

**Owner approval** — the `approved_at`/`approval_method='owner'`/`approved_by_user_id`/`veto_deadline_at` write on `solicitation_batches`, CAS'd on `approved_at IS NULL`, taken over a batch whose every send **Ask** already has a non-cancelled **Outreach row**. Cite the readiness rule as the mechanism behind "what was approved is byte-for-byte what sends", and record that the 15-minute window is an *undo*, not a review window. _Avoid_: sign-off, confirm batch, release.

**Ask exclusion** — the owner deselecting a single rendered ask at approval time: `delivery_status='cancelled'`, `disposition_reason='owner_excluded'` (migration **108**), written in the approval transaction. Record that it only ever moves toward restraint, needs no re-lint or re-moderation, and is the reason all-or-nothing approval is unnecessary given D22 forbids editing. _Avoid_: reject ask, skip ask, remove from batch.

- [ ] **Step 3: Run the map audit and commit**

Run: `pnpm ci:directory-map`
Expected: PASS.

```bash
git add docs/directory.md CONTEXT.md
git commit -m "docs(solicitation): directory rows + Owner approval / Ask exclusion terms (#629)"
```

---

## Self-review

**Spec coverage.** D2 windows → Tasks 3 (expiry refusal) and 5 (`batchState`). D6a → Task 5 (count-only) and the panel's redacted arm. D9 owner window → Task 3's `VETO_WINDOW_MINUTES_OWNER`. D10 latch → Task 4. D11 join → both verbs call `closeBatchIfSettled` in-transaction. D22 → no edit control anywhere in Task 7. D23 → Task 3's exclusion + CAS. B11 lock order → `lockBatchForAction`. Deferred with owner sign-off: regenerate (B2), admin halt, the auto lane.

**Placeholders.** None: every code step carries its code; the test steps name each assertion.

**Type consistency.** `ApproveBatchResult` / `HaltBatchResult` arms are consumed by the exact `switch` in Task 6. `SendLaneView` fields are read by Task 7's table. `ownerHaltReason` takes `BatchState` in both the property test and `haltBatch`.

**Known-soft.** `MIGRATION_108_OUTREACH_OWNER_EXCLUDED` cannot prove the new CHECK member exists, only the constraint name — recorded in its own doc comment rather than papered over.
