# WS3 — Guardian Escalation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a triaged review's `suggested_action` is `escalate`/`respond_and_escalate`, atomically raise a `review_escalations` row + `review_escalated` outcome + `escalation_notice` outbox enqueue inside `persistTriage`; deliver the notice via email/Telegram/WhatsApp; let the owner Acknowledge/Resolve from the dashboard, recording `escalation_resolved`.

**Spec:** `docs/superpowers/specs/2026-07-07-ws3-guardian-escalation-design.md` (authoritative on any conflict).

**Architecture:** Migration 073 (new tenant table + notice-dedup indexes) → shared plumbing (queue/payload/enqueue/step keys) → `raiseEscalation` wired into `persistTriage` → `escalation_notice` channel method + worker package (clone of `auto-post-notice`) → `transitions` module + dashboard routes → dashboard read-path join + review-card badge/actions. No LLM calls; flag `ESCALATION_ENABLED` (default off).

**Tech stack:** Next.js 16 routes (composition roots), Fastify/BullMQ Railway worker, Postgres.js (`sql`/`tx` injected per invariant #15), Vitest (`createMockSql` harness + `describeWithDb`), Resend/Telegram/Twilio channel seams.

**Branch:** `feat/ws3-guardian-escalation` (already created off `main`; spec committed).

**Binding ground rules (from CLAUDE.md + WS1/WS2 lessons — repeat in every subagent prompt):**
- `ci:db-imports` STRICT: `src/lib/**` modules take `sql: Sql` / `tx: TransactionSql` params; only composition roots import `@/lib/db/server`.
- Lock ordering: any tx recording a step/outcome for a review-subject run takes that review's `reviews` row `FOR UPDATE` as the tx's FIRST statement.
- `ON CONFLICT` predicates must match their partial index byte-for-byte; index-name literals stay literals (never bound params); add `-- topic-audit-ignore` on outbox topic literals in SQL.
- Never log raw review/response text; step `detail` and outbox payloads carry ids/enums/counts only.
- No string literals for statuses — import constants.
- Migration CHECKs: `DROP CONSTRAINT IF EXISTS` before ADD (069/072 precedent); `IF NOT EXISTS` everywhere (re-runnable).
- Tests: mocked-`sql` via `worker/__tests__/helpers/mock-sql.ts` (`vi.hoisted` recipe in its header); live-DB via `describeWithDb`. Known flaky (unrelated): `worker/jobs/publisher/__tests__/integration-edit-existing-reply.test.ts`.
- Commit after each task with a conventional message; run the named verification commands and paste output before claiming done.

---

## File structure (locked decomposition)

| File | Responsibility |
|---|---|
| `supabase/migrations/073_review_escalations.sql` (create) | Table + CHECKs + one-open-per-review index + `notification_deliveries.escalation_id` + claim index + outbox in-flight index + RLS |
| `src/lib/escalations/types.ts` (create) | `ESCALATION_STATUS` constants + `EscalationStatus` type (single status owner) |
| `src/lib/escalations/flags.ts` (create) | `escalationEnabled()` |
| `src/lib/escalations/raise.ts` (create) | `shouldEscalate` + `raiseEscalation(tx, …)` (INSERT ON CONFLICT → outcome → step → enqueue) |
| `src/lib/escalations/transitions.ts` (create) | `acknowledgeEscalation` / `resolveEscalation` (lock-ordered, scoped, `escalation_resolved` outcome) |
| `src/lib/reviews/triage.ts` (modify) | `persistTriage` gains `accountId`/`correlationId` inputs + flag-gated `raiseEscalation` call |
| `src/lib/reviews/triage-schema.ts` (modify) | `TRIAGE_ISSUE_LABELS` humanized map |
| `src/lib/agents/run-spine.ts` (modify) | `STEP_PERSONA` += `escalation_raised`, `escalation_sent` (guardian) |
| `src/lib/shared/queue-names.ts` (modify) | `ESCALATION_NOTICE: 'escalation_notice'` |
| `src/lib/shared/worker-types.ts` (modify) | `EscalationNoticePayload` |
| `src/lib/shared/job-outbox-helpers.ts` (modify) | `enqueueEscalationNotice(tx, …)` |
| `worker/queues.ts` (modify) | Queue instance + `topicToQueue` entry |
| `worker/index.ts` (modify) | Worker registration + `workersByQueue` |
| `worker/jobs/response-generation/triage.ts` (modify) | Thread `accountId`/`correlationId` into `persistTriage` |
| `worker/jobs/ResponseGeneratorWorker.ts` (modify) | Pass `correlationId` into `runTriagePhase` ids arg |
| `src/lib/notifications/channels/types.ts` (modify) | `SendEscalationNoticeParams`/`Result` + interface method |
| `src/lib/notifications/email/templates/escalation-notice.ts` (create) | `sendEscalationNoticeEmail` |
| `src/lib/notifications/email.ts` (modify) | Barrel re-export |
| `src/lib/notifications/channels/email-channel.ts` (modify) | `sendEscalationNotice` |
| `src/lib/notifications/channels/telegram-body.ts` (modify) | `formatEscalationNoticeTelegram` |
| `src/lib/notifications/channels/telegram-channel.ts` (modify) | `sendEscalationNotice` |
| `src/lib/notifications/channels/whatsapp-body.ts` (modify) | `formatEscalationNoticeWhatsApp` |
| `src/lib/notifications/channels/whatsapp-channel.ts` (modify) | `sendEscalationNotice` (skips w/o template SID) |
| `src/lib/config/worker.ts` (modify) | `WHATSAPP_ESCALATION_TEMPLATE_SID` (rawOpt) |
| `src/lib/notifications/delivery.ts` (modify) | `claimEscalationNoticeDelivery` |
| `worker/jobs/escalation-notice/{EscalationNoticeWorker,context,dispatch,errors}.ts` (create) | Notice worker package (auto-post-notice clone) |
| `worker/ingress/resend.ts` (modify) | `OWNER_DIRECTED_TEMPLATES` += `'escalation_notice'` |
| `src/app/api/dashboard/escalations/[escalationId]/{acknowledge,resolve}/route.ts` (create) | Composition roots |
| `src/lib/dashboard/service.ts`, `types.ts`, `service-mappers.ts` (modify) | Open-escalation join on `recentReviews` (per-location view only) |
| `src/components/dashboard/reviews/{ReviewsCard,ReviewFeedCard,ReviewActions}.tsx` (modify) | Badge + Acknowledge/Resolve actions |
| Registries (modify) | `scripts/ci/tenant-tables.ts`, `scripts/ci/tenant-scope-allowlist.ts` (+ baseline), `docs/security/rls-inventory.md`, `src/lib/account-offboarding/table-disposition.ts`, `worker/jobs/account-offboarding/purge-stages.ts` |
| Docs (modify) | `.claude/reference/migrations-log.md`, `.claude/reference/env-vars.md`, `docs/directory.md`, `docs/runbooks/whatsapp-templates.md` |

Out of scope (documented): aggregate-view badges (WS5), tokenized ack links, Telegram inline ack buttons, auto-retract.

---

### Task 1: Migration 073 + migrations-log entry

**Files:**
- Create: `supabase/migrations/073_review_escalations.sql`
- Modify: `.claude/reference/migrations-log.md` (read its head + the 067/071/072 entries FIRST for conventions)

- [ ] **Step 1: Read conventions** — Read `.claude/reference/migrations-log.md` (confirm head is 072 → next 073), `supabase/migrations/072_review_triage.sql`, `067_auto_post_notice_outbox_and_claim.sql`, and `071_agent_run_spine.sql` (RLS stanza at lines 109–111).

- [ ] **Step 2: Write the migration**

```sql
-- Migration 073: WS3 Guardian escalation — review_escalations + escalation-notice dedup
--
-- Spec: docs/superpowers/specs/2026-07-07-ws3-guardian-escalation-design.md §2.3.
-- One row per raised escalation; forward-only state machine
-- escalated → acknowledged → resolved (direct escalated → resolved allowed,
-- stamping BOTH timestamps — resolve implies acknowledge). Triage columns are
-- a SNAPSHOT of what Guardian acted on (reviews.triage_* is rewritable by
-- re-triage). agent_run_id is captured at raise so escalation_resolved can be
-- attributed days later, after the run completed (ON DELETE SET NULL).
--
-- RLS: deny-all (enable, no policies — agent_outcomes/migration-071 posture).
-- All access via server routes/workers, app-enforced account scoping.
--
-- Additive; re-runnable (IF NOT EXISTS / DROP CONSTRAINT IF EXISTS); no
-- CONCURRENTLY (brand-new table + zero-row predicates). Apply staging first,
-- then production, both Supabase projects in lockstep.

CREATE TABLE IF NOT EXISTS review_escalations (
  id UUID PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES accounts(id),
  business_id UUID NOT NULL REFERENCES businesses(id),
  review_id UUID NOT NULL REFERENCES reviews(id),
  agent_run_id UUID REFERENCES agent_runs(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'escalated',
  triage_severity TEXT NOT NULL,
  triage_source TEXT NOT NULL,
  triage_suggested_action TEXT NOT NULL,
  triage_issues TEXT[],
  escalated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  acknowledged_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE review_escalations IS
  'Guardian escalations (WS3): one row per raised escalation. Triage columns snapshot what Guardian acted on at raise time.';

ALTER TABLE review_escalations DROP CONSTRAINT IF EXISTS review_escalations_status;
ALTER TABLE review_escalations ADD CONSTRAINT review_escalations_status
  CHECK (status IN ('escalated', 'acknowledged', 'resolved'));

ALTER TABLE review_escalations DROP CONSTRAINT IF EXISTS review_escalations_severity;
ALTER TABLE review_escalations ADD CONSTRAINT review_escalations_severity
  CHECK (triage_severity IN ('low', 'medium', 'high'));

ALTER TABLE review_escalations DROP CONSTRAINT IF EXISTS review_escalations_suggested_action;
ALTER TABLE review_escalations ADD CONSTRAINT review_escalations_suggested_action
  CHECK (triage_suggested_action IN ('escalate', 'respond_and_escalate'));

-- Forward-only state/timestamp consistency. Direct resolve stamps BOTH
-- timestamps, so 'resolved' always implies acknowledged_at IS NOT NULL.
ALTER TABLE review_escalations DROP CONSTRAINT IF EXISTS review_escalations_state_timestamps;
ALTER TABLE review_escalations ADD CONSTRAINT review_escalations_state_timestamps
  CHECK (
    (status = 'escalated'    AND acknowledged_at IS NULL     AND resolved_at IS NULL)
    OR (status = 'acknowledged' AND acknowledged_at IS NOT NULL AND resolved_at IS NULL)
    OR (status = 'resolved'     AND acknowledged_at IS NOT NULL AND resolved_at IS NOT NULL)
  );

-- One OPEN escalation per review: dedups the cost-cap fallback burst, absorbs
-- the concurrent-generation duplicate-triage race, and allows a NEW escalation
-- after the previous one resolved. Backs raiseEscalation's
-- ON CONFLICT (review_id) WHERE status <> 'resolved', byte-for-byte.
CREATE UNIQUE INDEX IF NOT EXISTS review_escalations_one_open_per_review
  ON review_escalations (review_id) WHERE status <> 'resolved';

COMMENT ON INDEX review_escalations_one_open_per_review IS
  'At most one open (non-resolved) escalation per review. Backs raiseEscalation ON CONFLICT (review_id) WHERE status <> resolved, byte-for-byte.';

-- Dashboard read shape: open escalations per account (WS3 §2.3).
CREATE INDEX IF NOT EXISTS idx_review_escalations_account_status
  ON review_escalations (account_id, status);

-- Deny-all RLS (no policies): server-only access, app-enforced scoping.
ALTER TABLE review_escalations ENABLE ROW LEVEL SECURITY;

-- Claim-before-send dedup for the escalation notice. An escalation is not a
-- response, so the notice claim keys on a new nullable escalation_id column
-- (auto_post_notice keys on response_id — migration 067 precedent).
ALTER TABLE notification_deliveries
  ADD COLUMN IF NOT EXISTS escalation_id UUID REFERENCES review_escalations(id) ON DELETE SET NULL;

COMMENT ON COLUMN notification_deliveries.escalation_id IS
  'FK to review_escalations for template=escalation_notice deliveries; NULL for every other template.';

CREATE UNIQUE INDEX IF NOT EXISTS notification_deliveries_escalation_notice_claim
  ON notification_deliveries (escalation_id, channel, recipient)
  WHERE escalation_id IS NOT NULL AND template = 'escalation_notice';

COMMENT ON INDEX notification_deliveries_escalation_notice_claim IS
  'Claim-before-send dedup for the escalation notice: at most one delivery per (escalation_id, channel, recipient). Backs claimEscalationNoticeDelivery ON CONFLICT (escalation_id, channel, recipient) WHERE escalation_id IS NOT NULL AND template = escalation_notice, byte-for-byte.';

-- In-flight outbox dedup (mirrors idx_jo_auto_post_notice_inflight, migration 067).
CREATE UNIQUE INDEX IF NOT EXISTS idx_jo_escalation_notice_inflight
  ON job_outbox (topic, aggregate_id)
  WHERE topic = 'escalation_notice'
    AND status IN ('pending', 'dispatching', 'dispatched');

COMMENT ON INDEX idx_jo_escalation_notice_inflight IS
  'At-most-one in-flight escalation_notice per escalation. Backs enqueueEscalationNotice ON CONFLICT (topic, aggregate_id) WHERE topic = escalation_notice AND status IN (pending,dispatching,dispatched), byte-for-byte.';
```

- [ ] **Step 3: Verify re-runnability** — if `TEST_DATABASE_POOL_URL` is set locally, apply the file twice with `psql "$TEST_DATABASE_POOL_URL" -f supabase/migrations/073_review_escalations.sql` (second apply must succeed with no errors). If not set, state that and rely on the Task 4/8 `describeWithDb` integration tests.

- [ ] **Step 4: migrations-log entry** — add the 073 bullet following the 072 entry's format exactly: what changed; every CHECK and index named; the two byte-for-byte `ON CONFLICT` writers named (`raiseEscalation` in `src/lib/escalations/raise.ts`, `claimEscalationNoticeDelivery` in `src/lib/notifications/delivery.ts`, `enqueueEscalationNotice` in `src/lib/shared/job-outbox-helpers.ts`); RLS deny-all posture; additive/re-runnable/no-CONCURRENTLY notes; the standard staging-first lockstep closer. Bump the head line to “Current head: **073** — next migration is **074**” and add the table-summary row for `review_escalations`.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/073_review_escalations.sql .claude/reference/migrations-log.md
git commit -m "feat(escalation): migration 073 — review_escalations + notice dedup indexes (WS3)"
```

---

### Task 2: Tenant/offboarding/security registries for the new table

**Files:**
- Modify: `scripts/ci/tenant-tables.ts`
- Modify: `src/lib/account-offboarding/table-disposition.ts`
- Modify: `worker/jobs/account-offboarding/purge-stages.ts`
- Modify: `docs/security/rls-inventory.md`
- Tests: existing suites are the guard — `src/lib/account-offboarding/__tests__/*`, `worker/jobs/account-offboarding/__tests__/PurgeWorker.test.ts`

- [ ] **Step 1: `tenant-tables.ts`** — append to the migration-071 comment block (after `'agent_outcomes'`):

```ts
  // Deny-all RLS (migration 073, WS3 Guardian escalation) — carries account_id/
  // business_id; written by src/lib/escalations/* inside pipeline transactions;
  // non-owner-scoped statements are exempt via tenant-scope-allowlist.ts.
  'review_escalations',
```

- [ ] **Step 2: `table-disposition.ts`** — add after the `agent_outcomes` entry (~line 303):

```ts
  {
    table: 'review_escalations',
    disposition: 'hard_delete',
    scopeEvidence: 'direct_account_id',
    purgeVerification: 'must_be_absent',
    reason: 'Guardian escalation state (WS3) references deleted reviews/runs; account attribution data with no retention rationale.',
  },
```

- [ ] **Step 3: `purge-stages.ts`** — `review_escalations.review_id` is a NOT NULL FK to `reviews` with NO cascade, so it MUST be deleted BEFORE the stage's `DELETE FROM reviews`. Locate the reviews DELETE in `purge-stages.ts` and insert immediately BEFORE it:

```ts
    // Guardian escalations (migration 073): review_id FK has no cascade, so
    // these must go before the reviews delete. notification_deliveries.
    // escalation_id is ON DELETE SET NULL — deliveries purge independently.
    await tx`
      DELETE FROM review_escalations
      WHERE account_id = ${row.account_id}::uuid
    `;
```

- [ ] **Step 4: `rls-inventory.md`** — add a row mirroring the `agent_outcomes` deny-all row: table `review_escalations`, scope column `account_id`, enforcement note “deny-all RLS; server routes + workers only (WS3)”.

- [ ] **Step 5: Run the guard suites**

Run: `pnpm vitest run src/lib/account-offboarding worker/jobs/account-offboarding scripts/ci 2>&1 | tail -20`
Expected: PASS. If a purge-verification or disposition-derived test fails naming a missing site, follow the failure message (that red-test loop is the designed guard) and fix within this task.

- [ ] **Step 6: Run the audits**

Run: `pnpm ci:tenant-scope && pnpm ci:rls-audit`
Expected: PASS (the new table has no SQL touchpoints yet; the purge DELETE is account-scoped so it needs no allowlist entry — if the audit disagrees, add a `worker-job-scoped` entry for `purge-stages.ts` + bump `ALLOWLIST_BASELINE` by exactly the entries added).

- [ ] **Step 7: Commit**

```bash
git add scripts/ci/tenant-tables.ts src/lib/account-offboarding/table-disposition.ts worker/jobs/account-offboarding/purge-stages.ts docs/security/rls-inventory.md scripts/ci/tenant-scope-allowlist.ts
git commit -m "feat(escalation): register review_escalations in tenant/offboarding/security registries (WS3)"
```

---

### Task 3: Shared plumbing — queue, payload, enqueue helper, step personas, status constants, flag

**Files:**
- Modify: `src/lib/shared/queue-names.ts`, `src/lib/shared/worker-types.ts`, `src/lib/shared/job-outbox-helpers.ts`, `worker/queues.ts`, `src/lib/agents/run-spine.ts`
- Create: `src/lib/escalations/types.ts`, `src/lib/escalations/flags.ts`
- Test: `src/lib/shared/__tests__/job-outbox-helpers.test.ts` (extend existing if present, else create), run-spine persona tests (extend where WS2 added `triage`)

- [ ] **Step 1: Write the failing enqueue-helper test** — locate the existing job-outbox-helpers test file (`rg -l "enqueueAutoPostNotice" src --glob '*test*'`); mirror its `enqueueAutoPostNotice` cases for the new helper. If none exists, create `src/lib/shared/__tests__/enqueue-escalation-notice.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { enqueueEscalationNotice } from '../job-outbox-helpers';

function makeTx() {
  const calls: { text: string; values: unknown[] }[] = [];
  const tx = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join('?'), values });
    return Promise.resolve([]);
  }) as never as import('postgres').TransactionSql & { json: (v: unknown) => unknown };
  (tx as { json: (v: unknown) => unknown }).json = vi.fn((v: unknown) => v);
  return { tx, calls };
}

describe('enqueueEscalationNotice', () => {
  it('inserts an escalation_notice outbox row keyed by escalation id with an in-flight guard', async () => {
    const { tx, calls } = makeTx();
    await enqueueEscalationNotice(tx, {
      escalationId: 'esc-1',
      businessId: 'biz-1',
      correlationId: 'corr-1',
    });
    expect(calls).toHaveLength(1);
    const { text, values } = calls[0]!;
    expect(text).toContain('INSERT INTO job_outbox');
    expect(text).toContain("WHERE topic = 'escalation_notice'");
    expect(text).toContain("status IN ('pending', 'dispatching', 'dispatched')");
    expect(values).toContainEqual('escalation_notice');
    expect(values).toContainEqual('escalation');
    expect(values).toContainEqual('esc-1');
    expect(values).toContainEqual({
      escalation_id: 'esc-1',
      business_id: 'biz-1',
      correlation_id: 'corr-1',
    });
  });

  it('omits correlation_id when not provided', async () => {
    const { tx, calls } = makeTx();
    await enqueueEscalationNotice(tx, { escalationId: 'esc-1', businessId: 'biz-1' });
    expect(calls[0]!.values).toContainEqual({ escalation_id: 'esc-1', business_id: 'biz-1' });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run src/lib/shared/__tests__/enqueue-escalation-notice.test.ts`
Expected: FAIL — `enqueueEscalationNotice` is not exported.

- [ ] **Step 3: Implement plumbing**

`src/lib/shared/queue-names.ts` — after `AUTO_POST_NOTICE`:

```ts
  ESCALATION_NOTICE: 'escalation_notice',
```

`src/lib/shared/worker-types.ts` — after `AutoPostNoticePayload`:

```ts
/**
 * EscalationNoticePayload — emitted ONLY by raiseEscalation
 * (src/lib/escalations/raise.ts) in the same tx that inserts the
 * review_escalations row (WS3 spec §2.2). ids only — never review text.
 */
export interface EscalationNoticePayload extends BasePayload {
  escalation_id: string;
  business_id: string;
}
```

`src/lib/shared/job-outbox-helpers.ts` — import `EscalationNoticePayload`; add near the other aggregate constants `const AGGREGATE_TYPE_ESCALATION = 'escalation';` and after `enqueueAutoPostNotice`:

```ts
export interface EnqueueEscalationNoticeInput {
  outboxId?: string;
  escalationId: string;
  businessId: string;
  correlationId?: string;
}

/**
 * Enqueues the Guardian escalation notice (WS3). In-flight guard mirrors
 * enqueueAutoPostNotice: partial unique index idx_jo_escalation_notice_inflight
 * (migration 073) backs the byte-for-byte ON CONFLICT below. The caller
 * (raiseEscalation) only enqueues when the escalation INSERT affected a row,
 * so this guard is defense-in-depth against replays.
 */
export async function enqueueEscalationNotice(
  tx: TxClient,
  input: EnqueueEscalationNoticeInput,
): Promise<string> {
  const outboxId = input.outboxId ?? uuidv7();
  const payload: EscalationNoticePayload = {
    escalation_id: input.escalationId,
    business_id: input.businessId,
  };
  if (input.correlationId !== undefined) {
    payload.correlation_id = input.correlationId;
  }

  await tx`
    INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
    VALUES (
      ${outboxId},
      ${QUEUE_NAMES.ESCALATION_NOTICE},
      ${AGGREGATE_TYPE_ESCALATION},
      ${input.escalationId},
      ${tx.json(payload as never)},
      ${JOB_OUTBOX_STATUS_PENDING}
    )
    ON CONFLICT (topic, aggregate_id)
    WHERE topic = 'escalation_notice' -- topic-audit-ignore: partial-index inference needs a literal
      AND status IN ('pending', 'dispatching', 'dispatched')
    DO NOTHING
  `;
  return outboxId;
}
```

`worker/queues.ts` — mirror `autoPostNotice` (line ~68): add `escalationNotice: new Queue(QUEUE_NAMES.ESCALATION_NOTICE, { connection: opts, defaultJobOptions }),` to `queues` and `[QUEUE_NAMES.ESCALATION_NOTICE]: queues.escalationNotice,` to `topicToQueue` (~line 102).

`src/lib/agents/run-spine.ts` — extend `STEP_PERSONA` after `triage`:

```ts
  escalation_raised: 'guardian',
  escalation_sent: 'guardian',
```

Create `src/lib/escalations/types.ts`:

```ts
// src/lib/escalations/types.ts
//
// Single owner of the review_escalations status vocabulary (WS3 spec §2.3).
// Forward-only: escalated → acknowledged → resolved; direct escalated →
// resolved is legal and stamps both timestamps (resolve implies acknowledge).

export const ESCALATION_STATUS = {
  ESCALATED: 'escalated',
  ACKNOWLEDGED: 'acknowledged',
  RESOLVED: 'resolved',
} as const;

export type EscalationStatus = (typeof ESCALATION_STATUS)[keyof typeof ESCALATION_STATUS];
```

Create `src/lib/escalations/flags.ts`:

```ts
import { readFlag } from '@/lib/config/flags';

/** WS3 Guardian escalation kill switch. Default off; staging first (spec §2.9).
 *  Checked at RAISE time (persistTriage) and again at SEND time
 *  (EscalationNoticeWorker) — flipping off stops outbound notices without
 *  hiding already-raised escalations. */
export function escalationEnabled(): boolean {
  return readFlag('ESCALATION_ENABLED');
}
```

- [ ] **Step 4: Extend the persona totality tests** — find where WS2 added the `triage` persona expectation (`rg -n "triage: 'guardian'|personaForStep" src/lib/agents/__tests__/`) and add `escalation_raised`/`escalation_sent` → `guardian` cases in the same style.

- [ ] **Step 5: Run tests**

Run: `pnpm vitest run src/lib/shared/__tests__/enqueue-escalation-notice.test.ts src/lib/agents 2>&1 | tail -8`
Expected: PASS.

- [ ] **Step 6: Typecheck + commit**

```bash
pnpm typecheck
git add -A src/lib/shared src/lib/escalations src/lib/agents worker/queues.ts
git commit -m "feat(escalation): escalation_notice plumbing — queue, payload, enqueue helper, guardian step personas, status constants, flag (WS3)"
```

---

### Task 4: `raiseEscalation` domain module + `persistTriage` wiring (TDD)

**Files:**
- Create: `src/lib/escalations/raise.ts`
- Create: `src/lib/escalations/__tests__/raise.test.ts`
- Modify: `src/lib/reviews/triage.ts` (persistTriage), `worker/jobs/response-generation/triage.ts`, `worker/jobs/ResponseGeneratorWorker.ts`
- Modify: existing `persistTriage` tests (locate via `rg -l "persistTriage" src/lib/reviews/__tests__/`)
- Create (integration): `src/lib/escalations/__tests__/raise.integration.test.ts` (`describeWithDb`)

- [ ] **Step 1: Write the failing unit tests**

`src/lib/escalations/__tests__/raise.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TriageClassification } from '@/lib/reviews/triage';

const { recordOutcomeMock, recordStepMock, enqueueMock } = vi.hoisted(() => ({
  recordOutcomeMock: vi.fn(),
  recordStepMock: vi.fn(),
  enqueueMock: vi.fn(),
}));
vi.mock('@/lib/agents/run-spine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/agents/run-spine')>()),
  recordOutcome: recordOutcomeMock,
  recordStep: recordStepMock,
}));
vi.mock('@/lib/shared/job-outbox-helpers', () => ({
  enqueueEscalationNotice: enqueueMock,
}));

import { raiseEscalation, shouldEscalate } from '../raise';

function classification(
  action: 'respond' | 'escalate' | 'respond_and_escalate',
  source = 'llm_triage_v1',
): TriageClassification {
  return {
    output: { severity: 'high', issues: ['staff_conduct'], suggested_action: action },
    source: source as TriageClassification['source'],
    model: 'gpt-4o-mini-2024-07-18',
    latencyMs: 100,
  };
}

/** Tagged-template tx stub: FIFO of results for awaited statements. */
function makeTx(results: unknown[][]) {
  const queue = [...results];
  const calls: { text: string; values: unknown[] }[] = [];
  const tx = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join('?'), values });
    const rows = queue.shift() ?? [];
    return Promise.resolve(Object.assign(rows, { count: rows.length }));
  }) as never as import('postgres').TransactionSql;
  return { tx, calls };
}

const baseInput = {
  reviewId: 'rev-1',
  businessId: 'biz-1',
  accountId: 'acc-1',
  activeRun: { id: 'run-1', account_id: 'acc-1' },
  correlationId: 'corr-1',
};

beforeEach(() => {
  recordOutcomeMock.mockReset();
  recordStepMock.mockReset();
  enqueueMock.mockReset();
});

describe('shouldEscalate', () => {
  it('is true only for escalate / respond_and_escalate', () => {
    expect(shouldEscalate(classification('respond'))).toBe(false);
    expect(shouldEscalate(classification('escalate'))).toBe(true);
    expect(shouldEscalate(classification('respond_and_escalate'))).toBe(true);
  });
});

describe('raiseEscalation', () => {
  it('inserts, records outcome + step, and enqueues when the insert wins', async () => {
    const { tx, calls } = makeTx([[{ id: 'esc-1' }]]);
    const result = await raiseEscalation(tx, {
      ...baseInput,
      classification: classification('escalate'),
    });
    expect(result.escalationId).not.toBeNull();
    expect(calls[0]!.text).toContain('INSERT INTO review_escalations');
    expect(calls[0]!.text).toContain("ON CONFLICT (review_id)");
    expect(calls[0]!.text).toContain("WHERE status <> 'resolved'");
    expect(recordOutcomeMock).toHaveBeenCalledWith(tx, expect.objectContaining({
      runId: 'run-1',
      attributedAgent: 'guardian',
      outcomeKind: 'review_escalated',
    }));
    expect(recordStepMock).toHaveBeenCalledWith(tx, expect.objectContaining({
      runId: 'run-1',
      stepKey: 'escalation_raised',
      detail: expect.objectContaining({ severity: 'high', source: 'llm_triage_v1' }),
    }));
    expect(enqueueMock).toHaveBeenCalledWith(tx, expect.objectContaining({
      businessId: 'biz-1',
      correlationId: 'corr-1',
    }));
  });

  it('skips outcome + step (but still enqueues) for a legacy review with no active run', async () => {
    const { tx } = makeTx([[{ id: 'esc-1' }]]);
    const result = await raiseEscalation(tx, {
      ...baseInput,
      activeRun: null,
      classification: classification('respond_and_escalate'),
    });
    expect(result.escalationId).not.toBeNull();
    expect(recordOutcomeMock).not.toHaveBeenCalled();
    expect(recordStepMock).not.toHaveBeenCalled();
    expect(enqueueMock).toHaveBeenCalled();
  });

  it('is a full no-op when an open escalation already exists (ON CONFLICT lost)', async () => {
    const { tx } = makeTx([[]]);
    const result = await raiseEscalation(tx, {
      ...baseInput,
      classification: classification('escalate'),
    });
    expect(result.escalationId).toBeNull();
    expect(recordOutcomeMock).not.toHaveBeenCalled();
    expect(recordStepMock).not.toHaveBeenCalled();
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('never carries review text in the step detail', async () => {
    const { tx } = makeTx([[{ id: 'esc-1' }]]);
    await raiseEscalation(tx, { ...baseInput, classification: classification('escalate') });
    const detail = recordStepMock.mock.calls[0]![1].detail as Record<string, unknown>;
    expect(Object.keys(detail).sort()).toEqual(
      ['escalation_id', 'severity', 'source', 'suggested_action'].sort(),
    );
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/lib/escalations/__tests__/raise.test.ts`
Expected: FAIL — module `../raise` not found.

- [ ] **Step 3: Implement `src/lib/escalations/raise.ts`**

```ts
// src/lib/escalations/raise.ts
//
// WS3 Guardian escalation raise (spec §2.2). Called by persistTriage inside
// the triage-persist transaction, AFTER the reviews.triage_* UPDATE and the
// triage step, with the review row already locked FOR UPDATE (lock-ordering
// rule). All-or-nothing with the triage write: a failure here rolls the whole
// triage tx back and the generation job retries.
//
// Dedup: the INSERT's ON CONFLICT matches the partial unique index
// review_escalations_one_open_per_review (migration 073) byte-for-byte. A
// lost conflict (open escalation already exists) is a FULL no-op — no
// outcome, no step, no enqueue.

import { v7 as uuidv7 } from 'uuid';
import type { TransactionSql } from 'postgres';
import { recordOutcome, recordStep } from '@/lib/agents/run-spine';
import { enqueueEscalationNotice } from '@/lib/shared/job-outbox-helpers';
import type { TriageClassification } from '@/lib/reviews/triage';
import { ESCALATION_STATUS } from './types';

const ESCALATING_ACTIONS: readonly string[] = ['escalate', 'respond_and_escalate'];

/** Trigger predicate (spec §2.1): source-agnostic — fallback rows escalate
 *  immediately; mock rows never reach here (mock always suggests 'respond'). */
export function shouldEscalate(classification: TriageClassification): boolean {
  return ESCALATING_ACTIONS.includes(classification.output.suggested_action);
}

export interface RaiseEscalationInput {
  reviewId: string;
  businessId: string;
  accountId: string;
  /** The review's running review_handler run, or null for legacy reviews
   *  (outcome + step are skipped; the escalation row still persists). */
  activeRun: { id: string; account_id: string } | null;
  classification: TriageClassification;
  correlationId?: string;
}

export interface RaiseEscalationResult {
  /** null ⇔ an open escalation already existed (nothing was raised). */
  escalationId: string | null;
}

export async function raiseEscalation(
  tx: TransactionSql,
  input: RaiseEscalationInput,
): Promise<RaiseEscalationResult> {
  const { output } = input.classification;
  const escalationId = uuidv7();

  const inserted = await tx<{ id: string }[]>`
    INSERT INTO review_escalations (
      id, account_id, business_id, review_id, agent_run_id, status,
      triage_severity, triage_source, triage_suggested_action, triage_issues
    ) VALUES (
      ${escalationId}, ${input.accountId}, ${input.businessId}, ${input.reviewId},
      ${input.activeRun?.id ?? null}, ${ESCALATION_STATUS.ESCALATED},
      ${output.severity}, ${input.classification.source},
      ${output.suggested_action}, ${output.issues}
    )
    ON CONFLICT (review_id)
    WHERE status <> 'resolved'
    DO NOTHING
    RETURNING id
  `;
  if (inserted.count === 0) {
    return { escalationId: null };
  }

  if (input.activeRun) {
    await recordOutcome(tx, {
      runId: input.activeRun.id,
      accountId: input.accountId,
      businessId: input.businessId,
      attributedAgent: 'guardian',
      outcomeKind: 'review_escalated',
    });
    await recordStep(tx, {
      runId: input.activeRun.id,
      stepKey: 'escalation_raised',
      detail: {
        severity: output.severity,
        suggested_action: output.suggested_action,
        source: input.classification.source,
        escalation_id: escalationId,
      },
    });
  }

  await enqueueEscalationNotice(tx, {
    escalationId,
    businessId: input.businessId,
    correlationId: input.correlationId,
  });

  return { escalationId };
}
```

- [ ] **Step 4: Run unit tests to verify pass**

Run: `pnpm vitest run src/lib/escalations/__tests__/raise.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Wire into `persistTriage`** (`src/lib/reviews/triage.ts`). Extend the input and restructure the tail of the function — the current early-return `if (!activeRun) return;` must NOT skip the raise:

```ts
export interface PersistTriageInput {
  reviewId: string;
  businessId: string;
  /** Billing-parent scope for the escalation row (WS3). */
  accountId: string;
  classification: TriageClassification;
  /** The review_content_hash of the text that was classified (pre-LLM read). */
  contentHash: string | null;
  correlationId?: string;
}
```

Replace the block from `const activeRun = await findActiveReviewRun(...)` to the end of the function with:

```ts
  const activeRun = await findActiveReviewRun(tx, input.reviewId);
  if (activeRun) {
    const detail: Record<string, unknown> = {
      severity: output.severity,
      suggested_action: output.suggested_action,
      issues: output.issues,
      source: input.classification.source,
      model: input.classification.model,
    };
    if (input.classification.failureReason) {
      // Error NAME only (enum-like) — makes fallbacks triageable from
      // agent_run_steps without ever carrying message/review text.
      detail.reason = input.classification.failureReason;
    }

    await recordStep(tx, {
      runId: activeRun.id,
      stepKey: 'triage',
      status: input.classification.source === TRIAGE_SOURCE.FALLBACK ? 'failed' : 'completed',
      detail,
      latencyMs: input.classification.latencyMs ?? undefined,
    });
  }

  // WS3 Guardian escalation: raised in the SAME tx as the triage write, still
  // under the review lock, independent of run existence (legacy reviews
  // escalate too — spec §2.2).
  if (escalationEnabled() && shouldEscalate(input.classification)) {
    await raiseEscalation(tx, {
      reviewId: input.reviewId,
      businessId: input.businessId,
      accountId: input.accountId,
      activeRun,
      classification: input.classification,
      correlationId: input.correlationId,
    });
  }
```

Add imports: `import { escalationEnabled } from '@/lib/escalations/flags';` and `import { raiseEscalation, shouldEscalate } from '@/lib/escalations/raise';`. Update the function's doc comment to mention the escalation raise. (Import-cycle note: `raise.ts` imports only the TYPE `TriageClassification` from `triage.ts` — `import type` breaks the runtime cycle; keep it `import type`.)

- [ ] **Step 6: Thread `accountId`/`correlationId` from the worker.** In `worker/jobs/response-generation/triage.ts`, extend the `ids` parameter to `{ reviewId: string; businessId: string; correlationId?: string }` and pass through:

```ts
    await persistTriage(tx, {
      reviewId: ids.reviewId,
      businessId: ids.businessId,
      accountId: ctx.accountId,
      classification,
      contentHash: ctx.loadedReviewContentHash,
      correlationId: ids.correlationId,
    });
```

In `worker/jobs/ResponseGeneratorWorker.ts`, find the `runTriagePhase(sql, ctx, { reviewId, businessId }, logger)` call site (`rg -n "runTriagePhase" worker/jobs/ResponseGeneratorWorker.ts`) and add `correlationId: job.data.correlation_id` to the ids object (matching however the payload exposes it in that scope).

- [ ] **Step 7: Extend the persistTriage unit tests.** Locate them (`rg -l "persistTriage" src/lib/reviews/__tests__ worker/jobs/response-generation/__tests__`). Fix compile errors from the new required `accountId` field, then add three cases using `vi.mock` on `@/lib/escalations/flags` and `@/lib/escalations/raise`:
  1. flag ON + `suggested_action='escalate'` → `raiseEscalation` called once with `{ reviewId, businessId, accountId, activeRun }` after the triage step;
  2. flag ON + `suggested_action='respond'` → not called;
  3. flag OFF + `'escalate'` → not called.
  Also assert case 1 with a null active run still calls `raiseEscalation` with `activeRun: null`.

- [ ] **Step 8: Integration test** — `src/lib/escalations/__tests__/raise.integration.test.ts` using the repo's `describeWithDb` helper (find the pattern via `rg -l "describeWithDb" src/lib --glob '*.test.ts'` and copy its setup/teardown idiom, seeding account → business → review):
  1. `persistTriage` (flag mocked ON) with an escalating classification → `review_escalations` row exists with the snapshot columns + `status='escalated'`; `job_outbox` has one `escalation_notice` row for the escalation id;
  2. calling `persistTriage` again (re-triage) → still exactly ONE open escalation and ONE in-flight outbox row (index absorbed it);
  3. after `UPDATE review_escalations SET status='resolved', acknowledged_at=NOW(), resolved_at=NOW()`, a third `persistTriage` → a SECOND escalation row exists.

- [ ] **Step 9: Run the affected suites**

Run: `pnpm vitest run src/lib/escalations src/lib/reviews worker/jobs/response-generation 2>&1 | tail -10`
Expected: PASS (integration cases skip gracefully without `TEST_DATABASE_POOL_URL`).

- [ ] **Step 10: Audits + commit**

```bash
pnpm typecheck && pnpm ci:tenant-scope && pnpm ci:db-imports
git add -A src/lib/escalations src/lib/reviews worker/jobs
git commit -m "feat(escalation): raiseEscalation in the triage-persist tx — row + outcome + step + notice enqueue (WS3)"
```

If `ci:tenant-scope` flags `raise.ts` statements, add `worker-job-scoped` entries (file `src/lib/escalations/raise.ts`, reason “triage-persist tx; tenant ids fixed by the generation job payload; review row locked upstream”) — if the category's path rules reject the path, add the file to `allowedFiles` with a review comment (run-spine precedent) — and bump `ALLOWLIST_BASELINE` by exactly the count added, in the same commit.

---

### Task 5: Channel seam — `sendEscalationNotice` interface + email template + EmailChannel

**Files:**
- Modify: `src/lib/notifications/channels/types.ts`, `src/lib/reviews/triage-schema.ts`, `src/lib/notifications/email.ts` (barrel), `src/lib/notifications/channels/email-channel.ts`
- Create: `src/lib/notifications/email/templates/escalation-notice.ts`
- Test: `src/lib/notifications/email/templates/__tests__/escalation-notice.test.ts` (mirror the auto-post-notice template test if one exists — `rg -l "sendAutoPostNoticeEmail" --glob '*test*'`)

- [ ] **Step 1: Write the failing template test**

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildEscalationNoticeEmailHtml, escalationNoticeSubject } from '../escalation-notice';

afterEach(() => vi.unstubAllEnvs());

const baseParams = {
  to: 'owner@example.com',
  from: 'noreply@repworth.com',
  locationLabel: 'Main St',
  businessName: 'Acme Diner',
  reviewerName: 'Jane D',
  starRating: 1 as number | null,
  reviewText: 'Terrible experience, found a hair in my food.',
  severity: 'high' as const,
  issues: ['safety_or_health' as const],
  suggestedAction: 'respond_and_escalate' as const,
  isFallback: false,
  dashboardUrl: 'https://app.repworth.com/dashboard/reviews',
  escalationId: 'esc-1',
};

describe('escalation notice email', () => {
  it('renders severity, humanized issues, review text, and the dashboard CTA', () => {
    const html = buildEscalationNoticeEmailHtml(baseParams);
    expect(html).toContain('High severity');
    expect(html).toContain('Safety or health');
    expect(html).toContain('Terrible experience');
    expect(html).toContain('https://app.repworth.com/dashboard/reviews');
  });

  it('uses needs-a-look copy and NO severity claim for fallback-sourced escalations', () => {
    const html = buildEscalationNoticeEmailHtml({ ...baseParams, isFallback: true, issues: [] });
    expect(html).not.toContain('High severity');
    expect(html).toContain("couldn&#39;t assess this review automatically");
  });

  it('escapes reviewer-controlled text', () => {
    const html = buildEscalationNoticeEmailHtml({
      ...baseParams,
      reviewText: '<script>alert(1)</script>',
    });
    expect(html).not.toContain('<script>');
  });

  it('subject flags urgency and carries the location label', () => {
    expect(escalationNoticeSubject(baseParams)).toBe('[Main St] 🚨 A review needs your attention');
    expect(escalationNoticeSubject({ ...baseParams, isFallback: true }))
      .toBe('[Main St] ⚠️ A review needs a look');
  });

  it('handles rating-less reviews without rendering stars', () => {
    const html = buildEscalationNoticeEmailHtml({ ...baseParams, starRating: null });
    expect(html).toContain('No star rating');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/lib/notifications/email/templates/__tests__/escalation-notice.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement.**

`src/lib/reviews/triage-schema.ts` — add (next to `TRIAGE_ISSUES`):

```ts
/** Humanized labels for owner-facing escalation notices (WS3). Single owner —
 *  exhaustive over TriageIssue so adding a taxonomy value forces a label. */
export const TRIAGE_ISSUE_LABELS: Record<TriageIssue, string> = {
  service_quality: 'Service quality',
  product_quality: 'Product quality',
  wait_time: 'Wait time',
  pricing: 'Pricing',
  cleanliness: 'Cleanliness',
  staff_conduct: 'Staff conduct',
  order_accuracy: 'Order accuracy',
  communication: 'Communication',
  safety_or_health: 'Safety or health',
  billing_or_refund: 'Billing or refund',
  other: 'Other',
};
```

`src/lib/notifications/channels/types.ts` — add after `SendAutoPostNoticeResult`, and the method on `NotificationChannel`:

```ts
/**
 * Params for the Guardian escalation notice (WS3). Content comes from the
 * persisted triage snapshot on review_escalations — no approval affordance,
 * no LLM call. Review text is legal in the MESSAGE (private owner channel);
 * it must never reach logs/step detail/outbox payloads.
 */
export interface SendEscalationNoticeParams {
  /** Per-enrollment recipient: email address, E.164 phone, or telegram chat_id. */
  handle: string;
  locationLabel: string;
  businessName: string;
  reviewerName: string;
  starRating: number | null;
  reviewText: string | null;
  severity: TriageSeverity;
  issues: TriageIssue[];
  suggestedAction: 'escalate' | 'respond_and_escalate';
  /** triage_source === 'fallback_high_v1' ⇒ "couldn't assess" copy, no severity claim. */
  isFallback: boolean;
  /** `${APP_URL}/dashboard/reviews` — the acknowledge surface (spec §2.7). */
  dashboardUrl: string;
  /** review_escalations id — provider idempotency + WhatsApp template suffix. */
  escalationId: string;
}

export type SendEscalationNoticeResult =
  | { status: 'sent'; externalMessageId: string }
  | { status: 'skipped'; reason: string };
```

with `import type { TriageIssue, TriageSeverity } from '@/lib/reviews/triage-schema';` at the top. Do NOT touch the `NotificationChannel` interface itself in this task (see the sequencing rule below).

**Sequencing rule so every commit typechecks:** this task adds the `SendEscalationNoticeParams`/`SendEscalationNoticeResult` types, the email template, and the EmailChannel method as a plain (not-yet-interface) method — but does NOT add `sendEscalationNotice` to the `NotificationChannel` interface yet (that would break TelegramChannel/WhatsAppChannel compilation). Task 6 adds the interface method in the same commit as the remaining two implementations.

Create `src/lib/notifications/email/templates/escalation-notice.ts` (clone the auto-post-notice template's structure — imports, mock-mode branch, `sendEmail`, `getEmailTags('transactional')`):

```ts
// src/lib/notifications/email/templates/escalation-notice.ts
//
// Guardian escalation notice email (WS3) — transactional. Sent when triage
// says the owner must be alerted (suggested_action escalate /
// respond_and_escalate). Fallback-sourced escalations (triage_source
// fallback_high_v1) use "couldn't assess" copy and claim NO severity.
// Delivery rows use template 'escalation_notice' (owner-directed for bounce
// classification — worker/ingress/resend.ts).

import { randomUUID } from 'node:crypto';
import { isMockMode } from '@/lib/shared/mock-mode';
import { escapeHtml } from '@/lib/shared/html';
import { sendEmail } from '../send-email';
import { getEmailTags, type EmailCategory } from '../headers';
import { LOG_PREFIX, renderStars, escapeHrefUrl, buildEmailShell } from './shared';
import { sanitizeLocationLabelForPrefix } from '@/lib/notifications/channels/template-prefix';
import { TRIAGE_ISSUE_LABELS, type TriageIssue, type TriageSeverity } from '@/lib/reviews/triage-schema';

const REVIEW_TEXT_PREVIEW_CHARS = 400;

const SEVERITY_LABELS: Record<TriageSeverity, string> = {
  low: 'Low severity',
  medium: 'Medium severity',
  high: 'High severity',
};

export interface EscalationNoticeEmailParams {
  to: string;
  from: string;
  locationLabel: string;
  businessName: string;
  reviewerName: string;
  starRating: number | null;
  reviewText: string | null;
  severity: TriageSeverity;
  issues: TriageIssue[];
  suggestedAction: 'escalate' | 'respond_and_escalate';
  isFallback: boolean;
  dashboardUrl: string;
  escalationId: string;
  idempotencyKey?: string;
}

export function escalationNoticeSubject(
  params: Pick<EscalationNoticeEmailParams, 'locationLabel' | 'isFallback'>,
): string {
  const safeLabel = sanitizeLocationLabelForPrefix(params.locationLabel);
  return params.isFallback
    ? `[${safeLabel}] ⚠️ A review needs a look`
    : `[${safeLabel}] 🚨 A review needs your attention`;
}

export function buildEscalationNoticeEmailHtml(
  params: Omit<EscalationNoticeEmailParams, 'to' | 'from' | 'idempotencyKey'>,
): string {
  const safeLabel = escapeHtml(sanitizeLocationLabelForPrefix(params.locationLabel));
  const safeReviewer = escapeHtml(params.reviewerName);
  const stars = params.starRating !== null
    ? `<p style="margin:0 0 4px;font-size:24px;letter-spacing:2px;">${renderStars(params.starRating)}</p>`
    : '<p style="margin:0 0 4px;font-size:13px;color:#6b7280;">No star rating</p>';
  const preview = params.reviewText
    ? escapeHtml(
        params.reviewText.length > REVIEW_TEXT_PREVIEW_CHARS
          ? `${params.reviewText.slice(0, REVIEW_TEXT_PREVIEW_CHARS)}…`
          : params.reviewText,
      )
    : '(no review text)';

  const assessment = params.isFallback
    ? `<p style="margin:0 0 20px;font-size:14px;color:#666;">We couldn&#39;t assess this review automatically — please take a look.</p>`
    : `<p style="margin:0 0 20px;font-size:14px;color:#666;"><strong>${SEVERITY_LABELS[params.severity]}.</strong>${
        params.issues.length > 0
          ? ` Flagged for: ${escapeHtml(params.issues.map((i) => TRIAGE_ISSUE_LABELS[i]).join(', '))}.`
          : ''
      } A reply draft follows the usual approval flow — this alert is about the underlying issue.</p>`;

  return buildEmailShell(`        <tr><td style="padding:32px 24px 0;">
          <h1 style="margin:0 0 4px;font-size:20px;color:#111;">[${safeLabel}] ${params.isFallback ? '⚠️ A review needs a look' : '🚨 A review needs your attention'}</h1>
          ${assessment}
        </td></tr>
        <tr><td style="padding:0 24px;">
          <table role="presentation" width="100%" style="background:#f9fafb;border-radius:6px;padding:16px;border:1px solid #e5e7eb;">
            <tr><td>
              ${stars}
              <p style="margin:0 0 8px;font-size:14px;color:#374151;">Review from <strong>${safeReviewer}</strong>:</p>
              <p style="margin:0;font-size:14px;color:#374151;line-height:1.5;white-space:pre-wrap;">${preview}</p>
            </td></tr>
          </table>
        </td></tr>
        <tr><td style="padding:24px;" align="center">
          <a href="${escapeHrefUrl(params.dashboardUrl)}" style="display:inline-block;background:#dc2626;color:#ffffff;padding:12px 28px;border-radius:6px;font-size:15px;font-weight:600;text-decoration:none;">Open dashboard</a>
        </td></tr>
        <tr><td style="padding:0 24px 24px;">
          <p style="margin:0;font-size:12px;color:#9ca3af;text-align:center;">Acknowledge or resolve this escalation from your reviews dashboard.</p>
        </td></tr>`);
}

export async function sendEscalationNoticeEmail(
  params: EscalationNoticeEmailParams,
): Promise<{ messageId: string }> {
  const subject = escalationNoticeSubject(params);

  if (isMockMode()) {
    const mockId = `mock-${randomUUID()}`;
    console.log(`${LOG_PREFIX} [MOCK] Escalation notice email to=${params.to} subject="${subject}" messageId=${mockId}`);
    return { messageId: mockId };
  }

  const html = buildEscalationNoticeEmailHtml(params);

  // Transactional alert: no List-Unsubscribe header (operational, not marketing).
  const category: EmailCategory = 'transactional';
  const { data, error } = await sendEmail(
    {
      from: params.from,
      to: params.to,
      subject,
      html,
      tags: getEmailTags(category),
    },
    { idempotencyKey: params.idempotencyKey },
  );

  if (error) {
    throw new Error(`Resend API error: ${error.message}`);
  }

  return { messageId: data!.id };
}
```

`src/lib/notifications/email.ts` barrel — add `export * from './email/templates/escalation-notice';`.

`src/lib/notifications/channels/email-channel.ts` — add the method (plain method this task; becomes the interface implementation in Task 6):

```ts
  async sendEscalationNotice(p: SendEscalationNoticeParams): Promise<SendEscalationNoticeResult> {
    const from = getWorkerConfig().RESEND_FROM_EMAIL;
    if (!from) {
      throw new Error('RESEND_FROM_EMAIL not configured');
    }

    const { messageId } = await sendEscalationNoticeEmail({
      to: p.handle,
      from,
      locationLabel: p.locationLabel,
      businessName: p.businessName,
      reviewerName: p.reviewerName,
      starRating: p.starRating,
      reviewText: p.reviewText,
      severity: p.severity,
      issues: p.issues,
      suggestedAction: p.suggestedAction,
      isFallback: p.isFallback,
      dashboardUrl: p.dashboardUrl,
      escalationId: p.escalationId,
      idempotencyKey: `escalation_notice:${p.escalationId}`,
    });

    return { status: 'sent', externalMessageId: messageId };
  }
```

(with the two new types added to the existing `./types` import).

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm vitest run src/lib/notifications 2>&1 | tail -8 && pnpm typecheck`
Expected: PASS (interface method NOT yet declared, so Telegram/WhatsApp still compile).

- [ ] **Step 5: Commit**

```bash
git add -A src/lib/notifications src/lib/reviews/triage-schema.ts
git commit -m "feat(escalation): escalation-notice email template + EmailChannel send + issue labels (WS3)"
```

---

### Task 6: Telegram + WhatsApp escalation notice + interface method

**Files:**
- Modify: `src/lib/notifications/channels/{types,telegram-body,telegram-channel,whatsapp-body,whatsapp-channel}.ts`, `src/lib/config/worker.ts`, `docs/runbooks/whatsapp-templates.md`
- Test: extend the existing body-formatter tests (`rg -l "formatAutoPostNoticeTelegram|formatAutoPostNoticeWhatsApp" --glob '*test*'`) with sibling escalation cases

- [ ] **Step 1: Write the failing formatter tests** (in the located suites, mirroring the auto-post-notice cases):

```ts
describe('formatEscalationNoticeTelegram', () => {
  const params = {
    locationLabel: 'Main St',
    reviewerName: 'Jane <b>D</b>',
    starRating: 1 as number | null,
    reviewText: 'Awful & <unsafe>',
    severity: 'high' as const,
    issues: ['staff_conduct' as const],
    isFallback: false,
    dashboardUrl: 'https://app.repworth.com/dashboard/reviews',
  };

  it('renders severity header, escaped review text, and a dashboard button', () => {
    const { text, inline_keyboard } = formatEscalationNoticeTelegram(params);
    expect(text).toContain('🚨');
    expect(text).toContain('High severity');
    expect(text).toContain('Staff conduct');
    expect(text).toContain('Awful &amp; &lt;unsafe&gt;');
    expect(inline_keyboard).toEqual([[{ text: '📋 Open dashboard', url: params.dashboardUrl }]]);
  });

  it('uses needs-a-look copy with no severity claim for fallback', () => {
    const { text } = formatEscalationNoticeTelegram({ ...params, isFallback: true });
    expect(text).not.toContain('High severity');
    expect(text).toContain("couldn't assess this review automatically");
  });
});
```

```ts
describe('formatEscalationNoticeWhatsApp', () => {
  it('maps template variables and clamps names', () => {
    const { contentSid, contentVariables } = formatEscalationNoticeWhatsApp(
      {
        businessName: 'Acme Diner',
        reviewerName: 'Jane D',
        starRating: 1,
        severityLabel: 'High severity',
        escalationId: 'esc-1',
      },
      'HXescalation',
    );
    expect(contentSid).toBe('HXescalation');
    expect(contentVariables).toEqual({
      '1': 'Acme Diner',
      '2': 'Jane D',
      '3': '1',
      '4': 'High severity',
      '5': 'esc-1',
    });
  });

  it('renders a rating-less review as "–"', () => {
    const { contentVariables } = formatEscalationNoticeWhatsApp(
      { businessName: 'A', reviewerName: 'B', starRating: null, severityLabel: 'Needs a look', escalationId: 'e' },
      'HX1',
    );
    expect(contentVariables['3']).toBe('–');
  });
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm vitest run src/lib/notifications/channels` → FAIL (functions not exported).

- [ ] **Step 3: Implement.**

`telegram-body.ts` — after `formatAutoPostNoticeTelegram`, following its idioms (`escapeHtml`, `sanitizeLocationLabelForPrefix`, param interface named like `TelegramAutoPostNoticeParams`):

```ts
export interface TelegramEscalationNoticeParams {
  locationLabel: string;
  reviewerName: string;
  starRating: number | null;
  reviewText: string | null;
  severity: TriageSeverity;
  issues: TriageIssue[];
  isFallback: boolean;
  dashboardUrl: string;
}

const ESCALATION_REVIEW_PREVIEW_CHARS = 400;

const TELEGRAM_SEVERITY_LABELS: Record<TriageSeverity, string> = {
  low: 'Low severity',
  medium: 'Medium severity',
  high: 'High severity',
};

export function formatEscalationNoticeTelegram(
  p: TelegramEscalationNoticeParams,
): FormattedApprovalMessage {
  const location = escapeHtml(sanitizeLocationLabelForPrefix(p.locationLabel));
  const reviewer = escapeHtml(p.reviewerName);
  const stars = p.starRating !== null ? `⭐${p.starRating}` : 'no rating';
  const preview = p.reviewText
    ? escapeHtml(
        p.reviewText.length > ESCALATION_REVIEW_PREVIEW_CHARS
          ? `${p.reviewText.slice(0, ESCALATION_REVIEW_PREVIEW_CHARS)}…`
          : p.reviewText,
      )
    : '(no review text)';
  const assessment = p.isFallback
    ? "We couldn't assess this review automatically — please take a look."
    : `${TELEGRAM_SEVERITY_LABELS[p.severity]}.${
        p.issues.length > 0
          ? ` Flagged for: ${escapeHtml(p.issues.map((i) => TRIAGE_ISSUE_LABELS[i]).join(', '))}.`
          : ''
      }`;

  const text = [
    `<b>[${location}] ${p.isFallback ? '⚠️ A review needs a look' : '🚨 A review needs your attention'}</b>`,
    assessment,
    `Review from ${reviewer} (${stars}):`,
    `<i>${preview}</i>`,
  ].join('\n');

  const inline_keyboard: TelegramInlineButton[][] = [
    [{ text: '📋 Open dashboard', url: p.dashboardUrl }],
  ];

  return { text, inline_keyboard };
}
```

(imports: `TRIAGE_ISSUE_LABELS`, `type TriageIssue`, `type TriageSeverity` from `@/lib/reviews/triage-schema` — match the file's existing import style.)

`whatsapp-body.ts` — after `formatAutoPostNoticeWhatsApp`, reusing its `oneLine`/`truncate`/`BUSINESS_NAME_MAX`/`REVIEWER_NAME_MAX` helpers:

```ts
export interface EscalationNoticeWhatsAppParams {
  businessName: string;
  reviewerName: string;
  starRating: number | null;
  /** Pre-humanized: 'High severity' | … | 'Needs a look' (fallback). */
  severityLabel: string;
  escalationId: string;
}

export function formatEscalationNoticeWhatsApp(
  params: EscalationNoticeWhatsAppParams,
  contentSid: string,
): WhatsAppSendContent {
  return {
    contentSid,
    contentVariables: {
      '1': truncate(oneLine(params.businessName), BUSINESS_NAME_MAX),
      '2': truncate(oneLine(params.reviewerName || 'Reviewer'), REVIEWER_NAME_MAX),
      '3': params.starRating !== null ? String(params.starRating) : '–',
      '4': params.severityLabel,
      '5': params.escalationId,
    },
  };
}
```

`src/lib/config/worker.ts` — add `WHATSAPP_ESCALATION_TEMPLATE_SID: rawOpt,` next to `WHATSAPP_AUTOPOST_TEMPLATE_SID` (line ~138), and mention it in the nearby comment (~174) if that comment enumerates rawOpt vars.

`types.ts` — NOW add the method to the `NotificationChannel` interface (the params/result types already exist from Task 5):

```ts
  /**
   * Send the Guardian escalation notice (WS3): "this review needs your
   * attention", with triage context and a dashboard CTA. Returns a
   * sent/skipped union (WhatsApp skips without its approved template SID).
   */
  sendEscalationNotice(p: SendEscalationNoticeParams): Promise<SendEscalationNoticeResult>;
```


`telegram-channel.ts`:

```ts
  async sendEscalationNotice(p: SendEscalationNoticeParams): Promise<SendEscalationNoticeResult> {
    const { text, inline_keyboard } = formatEscalationNoticeTelegram({
      locationLabel: p.locationLabel,
      reviewerName: p.reviewerName,
      starRating: p.starRating,
      reviewText: p.reviewText,
      severity: p.severity,
      issues: p.issues,
      isFallback: p.isFallback,
      dashboardUrl: p.dashboardUrl,
    });
    const client = new TelegramClient();
    const result = await client.sendMessage({
      chat_id: p.handle,
      text,
      reply_markup: { inline_keyboard },
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
    return { status: 'sent', externalMessageId: `${result.chat.id}:${result.message_id}` };
  }
```

`whatsapp-channel.ts` (self-protecting skip, mirroring `sendAutoPostNotice`):

```ts
  async sendEscalationNotice(p: SendEscalationNoticeParams): Promise<SendEscalationNoticeResult> {
    // Business-initiated → outside any 24h session window → approved template
    // only (ADR 0003). Until WHATSAPP_ESCALATION_TEMPLATE_SID is set, skip
    // cleanly — email + Telegram still send.
    const contentSid = getWorkerConfig().WHATSAPP_ESCALATION_TEMPLATE_SID;
    if (!contentSid) {
      return { status: 'skipped', reason: 'whatsapp_escalation_template_unset' };
    }

    const severityLabel = p.isFallback
      ? 'Needs a look'
      : `${p.severity.charAt(0).toUpperCase()}${p.severity.slice(1)} severity`;
    const { contentVariables } = formatEscalationNoticeWhatsApp(
      {
        businessName: p.businessName,
        reviewerName: p.reviewerName,
        starRating: p.starRating,
        severityLabel,
        escalationId: p.escalationId,
      },
      contentSid,
    );
    const client = new WhatsAppClient();
    const result = await client.sendTemplate({
      to: toWaRecipient(p.handle),
      contentSid,
      contentVariables,
      statusCallback: `${getWorkerPublicUrl()}/ingress/twilio/whatsapp-status`,
    });
    return { status: 'sent', externalMessageId: result.externalMessageId };
  }
```

- [ ] **Step 4: Runbook** — add an “Escalation notice (`WHATSAPP_ESCALATION_TEMPLATE_SID`)” section to `docs/runbooks/whatsapp-templates.md`, following the existing auto-post template section's format: proposed body (e.g. `🚨 {{1}}: a review from {{2}} ({{3}}★) was assessed as {{4}} and needs your attention. Open your RepWorth dashboard to acknowledge.`), the 5 variables (1 business, 2 reviewer, 3 stars, 4 severity label, 5 escalation id — note 5 is reserved for a future URL-button suffix), category `UTILITY`, and the Twilio submission steps that section uses.

- [ ] **Step 5: Run + typecheck** — `pnpm vitest run src/lib/notifications 2>&1 | tail -8 && pnpm typecheck` → PASS (interface method now implemented by all three channels).

- [ ] **Step 6: Commit**

```bash
git add -A src/lib/notifications src/lib/config docs/runbooks/whatsapp-templates.md
git commit -m "feat(escalation): Telegram + WhatsApp escalation notice + NotificationChannel interface method (WS3)"
```

---

### Task 7: Delivery claim + `escalation-notice` worker package + registration

**Files:**
- Modify: `src/lib/notifications/delivery.ts`, `worker/index.ts`, `worker/ingress/resend.ts`
- Create: `worker/jobs/escalation-notice/{EscalationNoticeWorker.ts,context.ts,dispatch.ts,errors.ts}`
- Create: `worker/jobs/escalation-notice/__tests__/{EscalationNoticeWorker.test.ts,context.test.ts,dispatch.test.ts}` — clone `worker/jobs/auto-post-notice/__tests__/` and adapt (read those suites first; they use the `createMockSql` harness per its header recipe)

- [ ] **Step 1: `claimEscalationNoticeDelivery`** in `src/lib/notifications/delivery.ts` (after `claimAutoPostNoticeDelivery`):

```ts
/**
 * Insert a pending claim keyed by (escalation_id, channel, recipient) for
 * template='escalation_notice'. Returns the new delivery id, or null when a
 * live claim already exists. ON CONFLICT predicate matches the partial index
 * `notification_deliveries_escalation_notice_claim` (migration 073)
 * BYTE-FOR-BYTE — the 'escalation_notice' literal must stay a literal.
 */
export async function claimEscalationNoticeDelivery(sql: Sql, params: {
  accountId: string;
  businessId: string;
  escalationId: string;
  channel: ChannelId;
  recipient: string;
}): Promise<string | null> {
  const id = uuidv7();
  const claimed = await sql<{ id: string }[]>`
    INSERT INTO notification_deliveries
      (id, account_id, business_id, escalation_id, channel, recipient, template)
    VALUES
      (${id}, ${params.accountId}, ${params.businessId}, ${params.escalationId},
       ${params.channel}, ${params.recipient}, 'escalation_notice')
    ON CONFLICT (escalation_id, channel, recipient)
      WHERE escalation_id IS NOT NULL AND template = 'escalation_notice'
      DO NOTHING
    RETURNING id
  `;
  return claimed.length === 1 ? id : null;
}
```

- [ ] **Step 2: Worker package.** Clone the four `auto-post-notice` files and adapt — the structural deltas (everything else stays byte-similar, including the per-channel claim→send→finalize|release|fail loop, the claim-failure re-throw, the systemic-failure error log, and the retryable re-throw):

`errors.ts` — rename to `classifyEscalationNoticeSendError`, same body over `isTransientChannelSendError`.

`context.ts` — `loadEscalationNoticeContext(sql, { escalationId, businessId }, logger)` returning the ok/fail/skip union:

```ts
export interface EscalationRow {
  id: string;
  status: string;
  esc_business_id: string;
  account_id: string;
  review_id: string;
  triage_severity: TriageSeverity;
  triage_source: string;
  triage_suggested_action: 'escalate' | 'respond_and_escalate';
  triage_issues: TriageIssue[] | null;
  reviewer_name: string;
  star_rating: number | null;
  review_text: string | null;
}
```

Query: `SELECT e.id, e.status, e.business_id AS esc_business_id, e.account_id, e.review_id, e.triage_severity, e.triage_source, e.triage_suggested_action, e.triage_issues, r.reviewer_name, r.star_rating, r.review_text FROM review_escalations e JOIN reviews r ON r.id = e.review_id WHERE e.id = ${input.escalationId}`. Guards, in order: not found → `fail('escalation_not_found')`; `esc_business_id !== input.businessId` → `fail('business_id_mismatch')`; `status === ESCALATION_STATUS.RESOLVED` → `skip('already_resolved')` (acknowledged still sends — the notice may be what acknowledges it elsewhere; only resolved is moot). Business query: copy the auto-post-notice business query verbatim (it already selects name/display_label/subscription/offboarding projection; `google_maps_url` may be dropped). Same archived/offboarding skips.

`dispatch.ts` — `dispatchEscalationNotice(sql, input, enrollments, logger)` where

```ts
export interface EscalationNoticeDispatchInput {
  escalationId: string;
  businessId: string;
  accountId: string;
  dashboardUrl: string;
  business: { name: string; displayLabel: string | null };
  review: { reviewerName: string; starRating: number | null; reviewText: string | null };
  triage: {
    severity: TriageSeverity;
    issues: TriageIssue[];
    suggestedAction: 'escalate' | 'respond_and_escalate';
    isFallback: boolean;
  };
}
```

WhatsApp pre-filter checks `WHATSAPP_ESCALATION_TEMPLATE_SID`; claim via `claimEscalationNoticeDelivery` (keyed on `escalationId`); send via `getChannel(channelId).sendEscalationNotice(params)`; per-channel error handling identical to the auto-post-notice loop (release on retryable, `failDelivery` on terminal, re-throw claim-infra failures). Log lines say `escalation_notice … escalation=${input.escalationId}` and never include review text.

`EscalationNoticeWorker.ts` — `handleEscalationNotice(sql, job: Job<EscalationNoticePayload>)`:
1. logger prefix `[EscalationNoticeWorker]`; extract `escalation_id`, `business_id`, outbox handle.
2. **Kill switch first** (spec §2.4): `if (!escalationEnabled()) { logger.log('escalation_notice flag-off skip escalation=…'); await markOutboxCompleted(sql, outboxId, outboxAttempt); return; }`.
3. `loadEscalationNoticeContext` → fail/skip handling identical to auto-post-notice.
4. `getEligibleChannels` (same call shape) → empty/blocked → `markOutboxCompleted`.
5. `NEXT_PUBLIC_APP_URL` guard (fail outbox when missing); `dashboardUrl = `${appUrl.replace(/\/$/, '')}/dashboard/reviews``.
6. `dispatchEscalationNotice(...)` with `isFallback: ctx.escalation.triage_source === TRIAGE_SOURCE.FALLBACK` (import from `@/lib/reviews/triage-schema`), `issues: ctx.escalation.triage_issues ?? []`.
7. Same systemic-failure error log; `if (dispatch.retryableFailed > 0) throw …` BEFORE recording the step.
8. **`escalation_sent` step** — only on full success (`retryableFailed === 0 && sent > 0`; the claim dedup makes a later retry converge to exactly one step):

```ts
  if (dispatch.retryableFailed === 0 && dispatch.sent > 0) {
    await sql.begin(async (tx) => {
      // Lock-ordering rule: review row FIRST, then any spine write.
      const locked = await tx<{ id: string }[]>`
        SELECT id FROM reviews WHERE id = ${ctx.escalation.review_id} FOR UPDATE
      `;
      if (locked.count === 0) return;
      const activeRun = await findActiveReviewRun(tx, ctx.escalation.review_id);
      if (!activeRun) return;
      await recordStep(tx, {
        runId: activeRun.id,
        stepKey: 'escalation_sent',
        detail: {
          escalation_id: ctx.escalation.id,
          sent: dispatch.sent,
          skipped: dispatch.skipped,
          terminal_failed: dispatch.terminalFailed,
        },
      });
    });
  }
  await markOutboxCompleted(sql, outboxId, outboxAttempt);
```

`worker/index.ts` — import `handleEscalationNotice` + `EscalationNoticePayload`; register next to the auto-post-notice worker (line ~166): `const escalationNoticeWorker = new Worker(QUEUE_NAMES.ESCALATION_NOTICE, withJobLogContext<EscalationNoticePayload>((job) => handleEscalationNotice(sql, job)), workerOpts);` and `[QUEUE_NAMES.ESCALATION_NOTICE]: escalationNoticeWorker,` in `workersByQueue` (~249).

`worker/ingress/resend.ts` — add to `OWNER_DIRECTED_TEMPLATES`:

```ts
  // Guardian escalation notice (WS3) — owner-directed, so a hard bounce flags
  // businesses.owner_email_bounced like any other owner email.
  'escalation_notice',
```

- [ ] **Step 3: Tests.** Adapt the cloned suites; the REQUIRED cases beyond the mechanical clone:
  - worker: flag OFF → `markOutboxCompleted`, no context load, no sends;
  - worker: context skip `already_resolved` → completed, no sends;
  - worker: happy path → dispatch called, `escalation_sent` step recorded with counts (assert the review `FOR UPDATE` is the tx's first statement via the recorded SQL text);
  - worker: `retryableFailed > 0` → throws BEFORE any step write;
  - worker: no active run → no step, outbox still completed;
  - dispatch: claim-null → skip; channel-skipped → claim released; terminal → `failDelivery`; retryable → claim released + counted; claim-infra failure (claim throws) → whole job re-throws;
  - context: each fail/skip branch.

Run: `pnpm vitest run worker/jobs/escalation-notice src/lib/notifications 2>&1 | tail -10`
Expected: PASS.

- [ ] **Step 4: Audits + commit**

```bash
pnpm typecheck && pnpm ci:tenant-scope && pnpm ci:db-imports
git add -A worker src/lib/notifications scripts/ci/tenant-scope-allowlist.ts
git commit -m "feat(escalation): EscalationNoticeWorker — claim-before-send delivery over the channel seam (WS3)"
```

`ci:tenant-scope` WILL flag the context loader's escalation-by-id query → add a `worker-job-scoped` entry (file `worker/jobs/escalation-notice/context.ts`, table `review_escalations`) + baseline bump in the same commit.

---

### Task 8: `transitions` domain module (TDD)

**Files:**
- Create: `src/lib/escalations/transitions.ts`
- Create: `src/lib/escalations/__tests__/transitions.test.ts`
- Create (integration): `src/lib/escalations/__tests__/transitions.integration.test.ts` (`describeWithDb`)

- [ ] **Step 1: Write the failing unit tests** — use the same tagged-template stub idiom as Task 1 of `raise.test.ts` (FIFO result queue; `sql.begin` stub that invokes the callback with the same stub as `tx`), `vi.mock` on `@/lib/agents/run-spine` for `recordOutcome`. Required cases:

```ts
// acknowledgeEscalation
it('escalated → acknowledged: updates status + acknowledged_at, returns { ok: true, noop: false }')
it('acknowledged → acknowledge again: no UPDATE issued, returns { ok: true, noop: true }')
it('resolved → acknowledge: returns { ok: false, code: "invalid_transition" }, no UPDATE')
it('unknown id or wrong account: returns { ok: false, code: "not_found" }')
it('locks the reviews row as the transaction FIRST statement, before the escalation row')
// resolveEscalation
it('escalated → resolved: stamps BOTH acknowledged_at and resolved_at')
it('acknowledged → resolved: stamps resolved_at only')
it('resolved → resolve again: noop success, recordOutcome NOT called')
it('records escalation_resolved via the stored agent_run_id (attributedAgent guardian)')
it('skips recordOutcome when agent_run_id is null, still resolves the row')
```

Write each as a full test with explicit queued rows (pre-check row → locked review row → locked escalation row → update result) and assertions on the recorded SQL texts (`expect(calls[0]!.text).toContain('FROM review_escalations')` for the scope pre-check, `expect(txCalls[0]!.text).toContain('FROM reviews')` + `toContain('FOR UPDATE')` for lock order).

- [ ] **Step 2: Run to verify failure** — `pnpm vitest run src/lib/escalations/__tests__/transitions.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement `src/lib/escalations/transitions.ts`**

```ts
// src/lib/escalations/transitions.ts
//
// Owner-driven escalation state machine (WS3 spec §2.7): forward-only
// escalated → acknowledged → resolved, direct escalated → resolved stamps
// both timestamps. Repeating the SAME action is an idempotent no-op success;
// backward transitions are invalid (route maps to 409). Lock ordering: the
// review row FOR UPDATE is the tx's FIRST statement (run-spine contract) —
// serializes against persistTriage/raiseEscalation on the same review.

import type { Sql, TransactionSql } from 'postgres';
import { recordOutcome } from '@/lib/agents/run-spine';
import { ESCALATION_STATUS, type EscalationStatus } from './types';

export type EscalationTransitionResult =
  | { ok: true; status: EscalationStatus; noop: boolean }
  | { ok: false; code: 'not_found' | 'invalid_transition' };

export interface EscalationTransitionInput {
  escalationId: string;
  /** Owner's billing-parent scope (invariant #8) — never trusted from the client. */
  accountId: string;
}

interface LockedEscalationRow {
  id: string;
  status: EscalationStatus;
  account_id: string;
  business_id: string;
  review_id: string;
  agent_run_id: string | null;
}

async function lockScopedEscalation(
  tx: TransactionSql,
  input: EscalationTransitionInput,
): Promise<LockedEscalationRow | null> {
  const [row] = await tx<LockedEscalationRow[]>`
    SELECT id, status, account_id, business_id, review_id, agent_run_id
    FROM review_escalations
    WHERE id = ${input.escalationId} AND account_id = ${input.accountId}::uuid
    FOR UPDATE
  `;
  return row ?? null;
}

export async function acknowledgeEscalation(
  sql: Sql,
  input: EscalationTransitionInput,
): Promise<EscalationTransitionResult> {
  // Scope pre-check outside the tx so a wrong-tenant id never takes locks.
  const [pre] = await sql<{ review_id: string }[]>`
    SELECT review_id FROM review_escalations
    WHERE id = ${input.escalationId} AND account_id = ${input.accountId}::uuid
  `;
  if (!pre) return { ok: false, code: 'not_found' };

  return sql.begin(async (tx) => {
    await tx`SELECT id FROM reviews WHERE id = ${pre.review_id} FOR UPDATE`;
    const row = await lockScopedEscalation(tx, input);
    if (!row) return { ok: false, code: 'not_found' } as const;

    if (row.status === ESCALATION_STATUS.ACKNOWLEDGED) {
      return { ok: true, status: row.status, noop: true } as const;
    }
    if (row.status !== ESCALATION_STATUS.ESCALATED) {
      return { ok: false, code: 'invalid_transition' } as const;
    }

    await tx`
      UPDATE review_escalations
      SET status = ${ESCALATION_STATUS.ACKNOWLEDGED},
          acknowledged_at = NOW(),
          updated_at = NOW()
      WHERE id = ${row.id}
    `;
    return { ok: true, status: ESCALATION_STATUS.ACKNOWLEDGED, noop: false } as const;
  });
}

export async function resolveEscalation(
  sql: Sql,
  input: EscalationTransitionInput,
): Promise<EscalationTransitionResult> {
  const [pre] = await sql<{ review_id: string }[]>`
    SELECT review_id FROM review_escalations
    WHERE id = ${input.escalationId} AND account_id = ${input.accountId}::uuid
  `;
  if (!pre) return { ok: false, code: 'not_found' };

  return sql.begin(async (tx) => {
    await tx`SELECT id FROM reviews WHERE id = ${pre.review_id} FOR UPDATE`;
    const row = await lockScopedEscalation(tx, input);
    if (!row) return { ok: false, code: 'not_found' } as const;

    if (row.status === ESCALATION_STATUS.RESOLVED) {
      return { ok: true, status: row.status, noop: true } as const;
    }

    // Direct escalated → resolved stamps both timestamps (resolve implies
    // acknowledge — the state_timestamps CHECK makes anything else invalid).
    await tx`
      UPDATE review_escalations
      SET status = ${ESCALATION_STATUS.RESOLVED},
          acknowledged_at = COALESCE(acknowledged_at, NOW()),
          resolved_at = NOW(),
          updated_at = NOW()
      WHERE id = ${row.id}
    `;

    // Run-spine interplay (spec §2.6): the stored agent_run_id lets resolution
    // attribute to a run that may have COMPLETED long ago; recordOutcome does
    // not require a running run. NULL (legacy review / deleted run) → skip.
    if (row.agent_run_id !== null) {
      await recordOutcome(tx, {
        runId: row.agent_run_id,
        accountId: row.account_id,
        businessId: row.business_id,
        attributedAgent: 'guardian',
        outcomeKind: 'escalation_resolved',
      });
    }

    return { ok: true, status: ESCALATION_STATUS.RESOLVED, noop: false } as const;
  });
}
```

- [ ] **Step 4: Run unit tests** — `pnpm vitest run src/lib/escalations/__tests__/transitions.test.ts` → PASS.

- [ ] **Step 5: Integration test** (`transitions.integration.test.ts`, `describeWithDb`): seed account/business/review + a `review_handler` run via `startOrGetActiveRun`, then `completeRun(tx, runId, 'completed')`, then INSERT an escalation with that `agent_run_id`. Assert:
  1. `acknowledgeEscalation` → row `acknowledged`, `acknowledged_at` set;
  2. `resolveEscalation` → row `resolved`, both timestamps set, and `agent_outcomes` has an `escalation_resolved` row for the COMPLETED run (this is the spec's key run-spine claim);
  3. second `resolveEscalation` → noop, still exactly one outcome row;
  4. direct resolve (fresh escalation, no ack) → both timestamps stamped, CHECK satisfied.

- [ ] **Step 6: Run + commit**

```bash
pnpm vitest run src/lib/escalations 2>&1 | tail -8 && pnpm typecheck && pnpm ci:tenant-scope
git add -A src/lib/escalations scripts/ci/tenant-scope-allowlist.ts
git commit -m "feat(escalation): acknowledge/resolve transitions with escalation_resolved outcome (WS3)"
```

The bare `SELECT id FROM reviews WHERE id = … FOR UPDATE` lock has no tenant column → add a `tenant-root-lookup` allowlist entry (file `src/lib/escalations/transitions.ts`, table `reviews`, reason “lock-ordering statement; scope established by the account-filtered escalation pre-check in the same function”) + baseline bump, same commit.

---

### Task 9: Acknowledge/Resolve routes

**Files:**
- Create: `src/app/api/dashboard/escalations/[escalationId]/acknowledge/route.ts`
- Create: `src/app/api/dashboard/escalations/[escalationId]/resolve/route.ts`
- Create: `src/app/api/dashboard/escalations/__tests__/routes.test.ts` (mirror the approve route's test if one exists — `rg -l "approve" src/app/api/dashboard/reviews --glob '*test*'`; else colocate per repo pattern)

- [ ] **Step 1: Write the failing route tests.** Mock `@/lib/db/server` (`vi.mock` returning `{ sql: {} }`), `@/lib/approval/http-routes` (`requireDashboardReviewOwner`), `@/lib/shared/writable-subscription`, and `@/lib/escalations/transitions`. Cases:
  - unauthenticated (`requireDashboardReviewOwner` returns a NextResponse) → that response passes through;
  - read-only subscription → its status/error pass through;
  - `{ ok: false, code: 'not_found' }` → 404; `{ ok: false, code: 'invalid_transition' }` → 409;
  - `{ ok: true, status: 'acknowledged', noop: false }` → 200 `{ success: true, status: 'acknowledged' }`;
  - resolve route calls `resolveEscalation` (not acknowledge).

- [ ] **Step 2: Run to verify failure** — route modules don't exist yet.

- [ ] **Step 3: Implement both routes.** `acknowledge/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { requireDashboardReviewOwner } from '@/lib/approval/http-routes';
import { acknowledgeEscalation } from '@/lib/escalations/transitions';
import { withSameOrigin } from '@/lib/auth/route-helpers';
import { NO_STORE_HEADERS } from '@/lib/shared/constants';
import { assertWritableSubscriptionForAccount } from '@/lib/shared/writable-subscription';

export const dynamic = 'force-dynamic';

async function acknowledge(
  request: NextRequest,
  { params }: { params: Promise<{ escalationId: string }> },
): Promise<NextResponse> {
  const owner = await requireDashboardReviewOwner(request);
  if (owner instanceof NextResponse) return owner;

  const writable = await assertWritableSubscriptionForAccount(owner.accountId, sql);
  if (!writable.ok) {
    return NextResponse.json({ error: writable.error }, { status: writable.status, headers: NO_STORE_HEADERS });
  }

  const { escalationId } = await params;
  const result = await acknowledgeEscalation(sql, { escalationId, accountId: owner.accountId });
  if (!result.ok) {
    return result.code === 'not_found'
      ? NextResponse.json({ error: 'Escalation not found' }, { status: 404, headers: NO_STORE_HEADERS })
      : NextResponse.json({ error: 'Escalation is already resolved' }, { status: 409, headers: NO_STORE_HEADERS });
  }
  return NextResponse.json(
    { success: true, status: result.status },
    { status: 200, headers: NO_STORE_HEADERS },
  );
}

export const POST = withSameOrigin()(acknowledge);
```

`resolve/route.ts` is identical with `resolveEscalation`, handler name `resolve`, and 409 body `{ error: 'Invalid escalation state' }`. (Note: `requireDashboardReviewOwner` is escalation-agnostic — it only resolves the owner + account. If its name reads too review-specific, do NOT rename it in this task; note it for the integration review.)

- [ ] **Step 4: Run tests + typecheck** — `pnpm vitest run src/app/api/dashboard/escalations 2>&1 | tail -6 && pnpm typecheck` → PASS.

- [ ] **Step 5: Commit**

```bash
git add -A src/app/api/dashboard/escalations
git commit -m "feat(escalation): dashboard acknowledge/resolve routes (WS3)"
```

---

### Task 10: Dashboard read path + review-card badge/actions

**Files:**
- Modify: `src/lib/dashboard/service.ts` (recentReviews query, ~line 140), `src/lib/dashboard/types.ts` (recentReviews item, ~line 93), `src/lib/dashboard/service-mappers.ts` (`mapRecentReviews`)
- Modify: `src/components/dashboard/reviews/ReviewsCard.tsx`, `ReviewFeedCard.tsx`, `ReviewActions.tsx`
- Test: extend `src/lib/dashboard/__tests__/service-mappers.test.ts`; component behavior via existing component-test pattern if present (`rg -l "ReviewActions" src/components --glob '*test*'`), else rely on typecheck + the mapper tests
- **Sub-skill:** the implementing subagent MUST invoke `repworth-brand-design` before writing the badge/button JSX and follow its tokens/classes.

Scope note (spec §2.7): per-location view only; `AggregateReviewsCard` badges are WS5. No UI feature flag — the UI is data-driven (escalations only exist when the server flag is on).

- [ ] **Step 1: Failing mapper test** — extend `service-mappers.test.ts`: a recent-review row with `escalation_id`/`escalation_status`/`escalation_severity` set maps to `escalation: { id, status, severity }`; nulls map to `escalation: null`.

- [ ] **Step 2: Read path.** `service.ts` — add to the recentReviews SELECT list `esc.id AS escalation_id, esc.status AS escalation_status, esc.triage_severity AS escalation_severity,` and after the existing `resp` LATERAL join:

```sql
      LEFT JOIN LATERAL (
        SELECT id, status, triage_severity
        FROM review_escalations e
        WHERE e.review_id = rev.id
          -- Explicit tenant scope (defense-in-depth, mirrors the resp join).
          AND e.business_id = ${businessId}
          AND e.status <> 'resolved'
        LIMIT 1
      ) esc ON true
```

`types.ts` — extend the `recentReviews` item:

```ts
    /** Open Guardian escalation (WS3); null when none. Resolved escalations never surface here. */
    escalation: {
      id: string;
      status: 'escalated' | 'acknowledged';
      severity: 'low' | 'medium' | 'high';
    } | null;
```

`service-mappers.ts` — map the three columns in `mapRecentReviews` (null id → `escalation: null`), following the file's existing narrowing style.

- [ ] **Step 3: UI.** Thread `escalation` through `ReviewsCard` → `ReviewFeedCard` (add to `ReviewFeedItem`), render a status badge next to the existing card header meta:

```tsx
{review.escalation && (
  <span
    className={`escalation-badge escalation-badge--${review.escalation.severity}`}
    title={review.escalation.status === 'acknowledged' ? 'Escalation acknowledged' : 'Escalated to you by Guardian'}
  >
    {review.escalation.status === 'acknowledged' ? '👁 Acknowledged' : '🚨 Needs attention'}
  </span>
)}
```

`ReviewActions.tsx` — add two buttons rendered only when `escalation` is non-null (Acknowledge only while `status === 'escalated'`; Resolve for both open states), POSTing to `/api/dashboard/escalations/${escalation.id}/acknowledge|resolve` with the same fetch/error/pending idiom the file's existing approve/regenerate buttons use, and calling the existing `onActionSuccess` on 200. Badge + button styling: follow `repworth-brand-design` (severity color mapping: high→danger, medium→warning, low→neutral tokens); add the CSS where the component's existing styles live (globals or module — match ReviewFeedCard's current approach).

- [ ] **Step 4: Run** — `pnpm vitest run src/lib/dashboard 2>&1 | tail -6 && pnpm typecheck && pnpm lint` → PASS.

- [ ] **Step 5: Commit**

```bash
git add -A src/lib/dashboard src/components/dashboard
git commit -m "feat(escalation): open-escalation badge + acknowledge/resolve actions on review cards (WS3)"
```

---

### Task 11: Docs, env, full gates

**Files:**
- Modify: `.claude/reference/env-vars.md`, `docs/directory.md`
- Verify: whole branch

- [ ] **Step 1: `env-vars.md`** — add `ESCALATION_ENABLED` following `TRIAGE_ENABLED`'s entry format (server-only, default off, read by worker + Next server; raise-time AND send-time kill switch; operational coupling: inert without `TRIAGE_ENABLED`; staging first). Add `WHATSAPP_ESCALATION_TEMPLATE_SID` following `WHATSAPP_AUTOPOST_TEMPLATE_SID`'s entry (optional; unset ⇒ WhatsApp channel skips escalation notices cleanly).

- [ ] **Step 2: `docs/directory.md`** — add `src/lib/escalations/` (raise/transitions/types/flags), `worker/jobs/escalation-notice/`, the two new routes, and the new email template, following the file's existing entry style. Grep for stale cross-references: `rg -n "escalation" docs/directory.md docs/currents.md` and reconcile.

- [ ] **Step 3: Full gates**

Run: `pnpm lint && pnpm typecheck && pnpm test 2>&1 | tail -15`
Run: `pnpm ci:tenant-scope && pnpm ci:rls-audit && pnpm ci:analytics-events && pnpm ci:static-policy && pnpm ci:db-imports`
Run: `pnpm eval:llm 2>&1 | tail -5` (offline; no prompt changes — regression guard only)
Expected: ALL PASS (the known-flaky publisher integration test may need one re-run).

- [ ] **Step 4: Commit**

```bash
git add -A docs .claude/reference
git commit -m "docs(escalation): env-vars + directory entries for WS3 Guardian escalation"
```

---

## Verification & completion

After all tasks: the orchestrator runs the whole-branch integration review (adversarial: failure-matrix tracing on the raise tx and the notice worker; race hunting on the one-open index + claim lifecycle; fail-open channel checks; doc-accuracy verification against `docs/directory.md`/`migrations-log.md`), fixes findings, then opens the PR to `main` with the WS2 PR (#460) as the format precedent. Spec §6-style amendments get appended to the WS3 spec for any review-driven divergence. Migration 073 is applied by the user to BOTH Supabase projects (staging first) before merge; staging rollout per spec §5.


