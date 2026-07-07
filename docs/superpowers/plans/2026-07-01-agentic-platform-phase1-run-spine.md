# Agentic Platform Phase 1 — WS1: Run Spine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the agent run spine — `agent_runs` / `agent_run_steps` / `agent_outcomes` tables plus a transactional writer library, with the existing review pipeline instrumented at its three natural checkpoints — so every review handled produces an attributable, owner-visible run record and outcome rows from day one.

**Architecture:** Attribution data, not an execution engine (design doc §3.2: "launch ships run *data*, not a run *engine*"). Existing workers write run/step/outcome rows **in the same Postgres transactions** as the state changes they describe (outbox discipline — a spine write failure fails the job and BullMQ retries; never a best-effort side log). Personas (Reply/Guardian/Insights) attach to steps via an explicit, tested step→persona map. Deny-all RLS; owner reads arrive later (WS5) through server routes.

**Tech Stack:** Postgres (Supabase, migration 071), Postgres.js transactional writes, Vitest with the repo's mocked-`sql.begin` test pattern, UUIDv7 app-side IDs.

**Design of record:** `docs/future-plans/2026-07-01-agentic-reputation-platform-design.md`

---

## Phase 1 decomposition (context — authoritative sequencing)

Per the writing-plans scope check, Phase 1 spans multiple independent subsystems; each ships as its own plan producing working software. **This document is WS1's plan.** WS2–WS8 each get their own spec→plan cycle when picked up (project convention), in this dependency order:

| WS | Scope | Depends on | Ships |
|---|---|---|---|
| **WS1 (this plan)** | Run spine: migration 071, writer lib `src/lib/agents/run-spine.ts`, instrumentation of ingest / persist / mark-posted | — | Run + outcome data for every handled review |
| WS2 | Triage: severity classification on the negative lane (cost-guarded LLM, output `{severity, issues, suggested_action}`, infra-failure → treat as `high`), recorded as a `triage` step | WS1 | Severity context for tone + escalation |
| WS3 | Guardian: escalation notification template, `review_escalations` state (escalated/acknowledged/resolved), acknowledge route, `review_escalated` outcome | WS2 | The Guardian persona's visible behavior |
| WS4 | Trust dial + veto window: `auto_approval_policies` scope extension (persona/action, `veto_window_minutes`, daily cap), delayed-publish veto path + cancel route, approval/edit outcome instrumentation (`reply_approved_no_edit`, `reply_edited_by_owner`), settings UI | WS1 | Autopilot's safety mechanics |
| WS5 | Persona surfaces: run-timeline page, dashboard "agent team" reframe, Insights persona labeling on the weekly report | WS1 | The product story owners see |
| WS6 | Judge + governor: judge poller (100% sampling of auto-posts at launch), verdict storage, auto-downgrade-to-hold + owner notify + admin alert; frozen governor thresholds | WS1, WS4 | The autonomy watchdog |
| WS7 | Eval-in-CI: path-filtered CI job running `pnpm eval:llm`, blocking on regression for prompt/policy/model-pin changes | — | The release gate |
| WS8 | Tier wiring: Copilot/Autopilot tier gates on policy editing; pricing page | WS4 | Monetized autonomy |

**Autopilot go-live gate:** WS4 + WS6 + WS7 landed, plus Zernio volume/cadence limits on record (design doc §4 item 1). `AUTO_APPROVAL_ENABLED` stays `false` until then.

---

## WS1 file structure

- Create: `supabase/migrations/071_agent_run_spine.sql`
- Create: `src/lib/agents/run-spine.ts` (writer library — the only module that writes spine tables)
- Create: `src/lib/agents/__tests__/run-spine.test.ts`
- Modify: `src/lib/reviews/process-review.ts` (run start + ingest step, both branches)
- Modify: `src/lib/reviews/__tests__/process-review.test.ts`
- Modify: `worker/jobs/response-generation/persist.ts` (draft/moderation/gate steps + `reply_drafted` outcome)
- Modify: `worker/jobs/response-generation/__tests__/` (matching test file for persist)
- Modify: `worker/jobs/publisher/mark-posted.ts` (posted step + `reply_posted`/`reply_auto_posted` outcomes + run completion)
- Modify: `worker/jobs/publisher/__tests__/mark-posted.test.ts`
- Modify: `scripts/ci/tenant-tables.ts` (+3 tables), `scripts/ci/tenant-scope-allowlist.ts` (spine writer queries), `docs/security/rls-inventory.md` (+3 rows), `.claude/reference/migrations-log.md` (071 entry, head → 071/next 072)

Naming note: the design doc's `billable_outcomes` ships as **`agent_outcomes`** — Decision 2 instruments outcomes without billing them; billing semantics (if ever) attach later without a rename.

---

### Task 1: Migration 071 — spine tables

**Files:**
- Create: `supabase/migrations/071_agent_run_spine.sql`

- [x] **Step 1: Write the migration file**

```sql
-- Migration 071: agent run spine — agent_runs, agent_run_steps, agent_outcomes
--
-- Phase 1 WS1 of the agentic platform (design doc 2026-07-01 §3.2): attribution
-- data written by the EXISTING pipeline in the SAME transactions as the state
-- changes it describes. NOT an execution engine — no lifecycle machinery here.
--
-- detail JSONB carries ids/enums/counts ONLY — never raw review/response text
-- (logging rules). Deny-all RLS on all three tables (server-only writes; owner
-- reads arrive in WS5 via server routes), same posture as analytics_events (049).
--
-- Additive; transactional (no CONCURRENTLY — all three tables are new, so the
-- index builds are instant). Apply staging first, then production, both
-- Supabase projects in lockstep.

CREATE TABLE IF NOT EXISTS agent_runs (
  id UUID PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('review_handler', 'weekly_insights')),
  subject_type TEXT NOT NULL CHECK (subject_type IN ('review', 'account_week')),
  subject_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'completed', 'failed')),
  correlation_id UUID,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  error JSONB,
  CONSTRAINT agent_runs_terminal_consistency
    CHECK ((status = 'running') = (ended_at IS NULL))
);

-- At most one running run per subject: startOrGetActiveRun's ON CONFLICT
-- target — predicate must stay byte-for-byte with the writer's conflict clause.
CREATE UNIQUE INDEX IF NOT EXISTS agent_runs_one_active_per_subject
  ON agent_runs (kind, subject_type, subject_id)
  WHERE status = 'running';

CREATE INDEX IF NOT EXISTS idx_agent_runs_business_started
  ON agent_runs (business_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_runs_account_started
  ON agent_runs (account_id, started_at DESC);

CREATE TABLE IF NOT EXISTS agent_run_steps (
  id UUID PRIMARY KEY,
  agent_run_id UUID NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  step_index INTEGER NOT NULL,
  step_key TEXT NOT NULL,
  attributed_agent TEXT NOT NULL
    CHECK (attributed_agent IN ('reply', 'guardian', 'insights', 'system')),
  status TEXT NOT NULL DEFAULT 'completed'
    CHECK (status IN ('completed', 'failed', 'skipped')),
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  latency_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT agent_run_steps_index_uniq UNIQUE (agent_run_id, step_index)
);

CREATE INDEX IF NOT EXISTS idx_agent_run_steps_run
  ON agent_run_steps (agent_run_id, step_index);

CREATE TABLE IF NOT EXISTS agent_outcomes (
  id UUID PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  agent_run_id UUID REFERENCES agent_runs(id) ON DELETE SET NULL,
  attributed_agent TEXT NOT NULL
    CHECK (attributed_agent IN ('reply', 'guardian', 'insights', 'system')),
  outcome_kind TEXT NOT NULL CHECK (outcome_kind IN (
    'reply_drafted', 'reply_posted', 'reply_auto_posted',
    'reply_approved_no_edit', 'reply_edited_by_owner',
    'review_escalated', 'escalation_resolved', 'digest_sent'
  )),
  unit_count INTEGER NOT NULL DEFAULT 1 CHECK (unit_count > 0),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Retry-safe outcome dedup: recordOutcome's ON CONFLICT target — predicate
-- must stay byte-for-byte with the writer's conflict clause.
CREATE UNIQUE INDEX IF NOT EXISTS agent_outcomes_once_per_run_kind
  ON agent_outcomes (agent_run_id, outcome_kind)
  WHERE agent_run_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_agent_outcomes_account_occurred
  ON agent_outcomes (account_id, occurred_at DESC);

ALTER TABLE agent_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_run_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_outcomes ENABLE ROW LEVEL SECURITY;
-- Deny-all: RLS enabled, NO policies. Server reaches these via the
-- RLS-bypassing postgres role only (same as analytics_events, migration 049).
```

- [x] **Step 2: Verify the migration applies cleanly against a throwaway Postgres**

Run (repo precedent from migrations 062/063 verification):

```bash
docker run --rm -d --name repworth-mig-verify -e POSTGRES_PASSWORD=pw -p 55432:5432 postgres:16
sleep 3
for f in supabase/migrations/*.sql; do
  echo "== $f"
  docker exec -i repworth-mig-verify psql -U postgres -v ON_ERROR_STOP=1 -f - < "$f" || break
done
docker exec repworth-mig-verify psql -U postgres -c "\d agent_runs" -c "\d agent_run_steps" -c "\d agent_outcomes"
docker stop repworth-mig-verify
```

Expected: every file applies; the three `\d` outputs show the tables with `agent_runs_one_active_per_subject` and `agent_outcomes_once_per_run_kind` partial unique indexes and "Policies (row security enabled): (none)".

(If earlier migrations fail on Supabase-specific objects like `auth.uid()`, verify from 071 alone against a schema dump instead — the gate that matters is 071's own syntax + index predicates.)

- [x] **Step 3: Commit**

```bash
git add supabase/migrations/071_agent_run_spine.sql
git commit -m "feat(agents): migration 071 — agent run spine tables"
```

---

### Task 2: Writer library — constants, types, and the persona map

**Files:**
- Create: `src/lib/agents/run-spine.ts`
- Create: `src/lib/agents/__tests__/run-spine.test.ts`

- [x] **Step 1: Write the failing tests** (constants + persona-map totality)

```typescript
// src/lib/agents/__tests__/run-spine.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/server', () => ({
  sql: { begin: vi.fn() },
  jsonb: vi.fn((v: unknown) => v),
}));

import {
  AGENT_PERSONAS,
  AGENT_RUN_KINDS,
  AGENT_OUTCOME_KINDS,
  STEP_PERSONA,
  personaForStep,
} from '../run-spine';

describe('run-spine constants', () => {
  it('exposes the three customer personas plus system', () => {
    expect(AGENT_PERSONAS).toEqual(['reply', 'guardian', 'insights', 'system']);
  });

  it('run kinds match migration 071 CHECK', () => {
    expect(AGENT_RUN_KINDS).toEqual(['review_handler', 'weekly_insights']);
  });

  it('outcome kinds match migration 071 CHECK', () => {
    expect(AGENT_OUTCOME_KINDS).toEqual([
      'reply_drafted', 'reply_posted', 'reply_auto_posted',
      'reply_approved_no_edit', 'reply_edited_by_owner',
      'review_escalated', 'escalation_resolved', 'digest_sent',
    ]);
  });
});

describe('persona map', () => {
  it('maps every known step key to a persona (totality)', () => {
    for (const [stepKey, persona] of Object.entries(STEP_PERSONA)) {
      expect(AGENT_PERSONAS).toContain(persona);
      expect(personaForStep(stepKey as keyof typeof STEP_PERSONA)).toBe(persona);
    }
  });

  it('attributes pipeline steps to the personas the design doc names', () => {
    expect(personaForStep('review_ingested')).toBe('system');
    expect(personaForStep('review_updated')).toBe('system');
    expect(personaForStep('draft_generated')).toBe('reply');
    expect(personaForStep('moderation_checked')).toBe('system');
    expect(personaForStep('policy_gate')).toBe('reply');
    expect(personaForStep('reply_posted')).toBe('reply');
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/lib/agents/__tests__/run-spine.test.ts`
Expected: FAIL — cannot resolve `../run-spine` (module does not exist).

- [x] **Step 3: Write the constants half of the module**

```typescript
// src/lib/agents/run-spine.ts
//
// The agent run spine: the ONLY module that writes agent_runs /
// agent_run_steps / agent_outcomes (migration 071). Attribution data, not an
// execution engine (design doc 2026-07-01 §3.2).
//
// Contract: every writer takes a TxClient and MUST be called inside the same
// transaction as the pipeline state change it describes. A spine failure
// fails the job (BullMQ retries) — never a best-effort side log.
// `detail` carries ids/enums/counts only — NEVER raw review/response text.

import { v7 as uuidv7 } from 'uuid';
import type postgres from 'postgres';
import { jsonb } from '@/lib/db/server';

type TxClient = postgres.TransactionSql;

export const AGENT_PERSONAS = ['reply', 'guardian', 'insights', 'system'] as const;
export type AgentPersona = (typeof AGENT_PERSONAS)[number];

export const AGENT_RUN_KINDS = ['review_handler', 'weekly_insights'] as const;
export type AgentRunKind = (typeof AGENT_RUN_KINDS)[number];

export const AGENT_OUTCOME_KINDS = [
  'reply_drafted', 'reply_posted', 'reply_auto_posted',
  'reply_approved_no_edit', 'reply_edited_by_owner',
  'review_escalated', 'escalation_resolved', 'digest_sent',
] as const;
export type AgentOutcomeKind = (typeof AGENT_OUTCOME_KINDS)[number];

// The single authoritative step→persona attribution map (design doc §3.1:
// "an attributed_agent field on the step, not vibes"). WS2/WS3/WS5 extend it.
export const STEP_PERSONA = {
  review_ingested: 'system',
  review_updated: 'system',
  draft_generated: 'reply',
  moderation_checked: 'system',
  policy_gate: 'reply',
  owner_notified: 'reply',
  reply_posted: 'reply',
} as const satisfies Record<string, AgentPersona>;

export type AgentStepKey = keyof typeof STEP_PERSONA;

export function personaForStep(stepKey: AgentStepKey): AgentPersona {
  return STEP_PERSONA[stepKey];
}
```

- [x] **Step 4: Run tests to verify the constant tests pass**

Run: `pnpm vitest run src/lib/agents/__tests__/run-spine.test.ts`
Expected: PASS (all tests written so far).

- [x] **Step 5: Commit**

```bash
git add src/lib/agents/run-spine.ts src/lib/agents/__tests__/run-spine.test.ts
git commit -m "feat(agents): run-spine constants + tested persona map"
```

---

### Task 3: Writer library — `startOrGetActiveRun`

**Files:**
- Modify: `src/lib/agents/run-spine.ts`
- Modify: `src/lib/agents/__tests__/run-spine.test.ts`

- [x] **Step 1: Write the failing tests** (append to the test file; reuse the repo's mocked-tx pattern from `process-review.test.ts`)

```typescript
import { startOrGetActiveRun } from '../run-spine';

function withCount<T extends unknown[]>(arr: T, count: number): T & { count: number } {
  return Object.assign(arr, { count });
}

describe('startOrGetActiveRun', () => {
  let tx: ReturnType<typeof vi.fn>;
  beforeEach(() => { tx = vi.fn(); });

  it('inserts a new running run and returns its id with created=true', async () => {
    tx.mockResolvedValueOnce(withCount([{ id: 'run-1' }], 1)); // INSERT … RETURNING id

    const out = await startOrGetActiveRun(tx as never, {
      kind: 'review_handler',
      subjectType: 'review',
      subjectId: 'rev-1',
      accountId: 'acct-1',
      businessId: 'biz-1',
      correlationId: 'corr-1',
    });

    expect(out.created).toBe(true);
    expect(out.runId).toBe('run-1');
    const insertSql = (tx.mock.calls[0]?.[0] as TemplateStringsArray | undefined)?.join('?') ?? '';
    expect(insertSql).toContain('INSERT INTO agent_runs');
    expect(insertSql).toContain('ON CONFLICT (kind, subject_type, subject_id)');
    expect(insertSql).toContain("WHERE status = 'running'");
  });

  it('returns the existing active run with created=false when the INSERT conflicts', async () => {
    tx.mockResolvedValueOnce(withCount([], 0)); // INSERT DO NOTHING → no row
    tx.mockResolvedValueOnce(withCount([{ id: 'run-existing' }], 1)); // SELECT active

    const out = await startOrGetActiveRun(tx as never, {
      kind: 'review_handler',
      subjectType: 'review',
      subjectId: 'rev-1',
      accountId: 'acct-1',
      businessId: 'biz-1',
    });

    expect(out.created).toBe(false);
    expect(out.runId).toBe('run-existing');
  });

  it('throws when the conflict path finds no active run (impossible state)', async () => {
    tx.mockResolvedValueOnce(withCount([], 0));
    tx.mockResolvedValueOnce(withCount([], 0));

    await expect(startOrGetActiveRun(tx as never, {
      kind: 'review_handler',
      subjectType: 'review',
      subjectId: 'rev-1',
      accountId: 'acct-1',
      businessId: 'biz-1',
    })).rejects.toThrow(/active run/i);
  });
});
```

- [x] **Step 2: Run to verify the new tests fail**

Run: `pnpm vitest run src/lib/agents/__tests__/run-spine.test.ts`
Expected: FAIL — `startOrGetActiveRun` is not exported.

- [x] **Step 3: Implement**

```typescript
export interface StartRunInput {
  kind: AgentRunKind;
  subjectType: 'review' | 'account_week';
  subjectId: string;
  accountId: string;
  businessId: string | null;
  correlationId?: string;
}

export interface StartRunResult {
  runId: string;
  created: boolean;
}

/**
 * Start a run for a subject, or return the already-running one. Race-safe via
 * the agent_runs_one_active_per_subject partial unique index — the ON CONFLICT
 * clause below must match its predicate byte-for-byte (migration 071).
 */
export async function startOrGetActiveRun(
  tx: TxClient,
  input: StartRunInput,
): Promise<StartRunResult> {
  const runId = uuidv7();
  const inserted = await tx<{ id: string }[]>`
    INSERT INTO agent_runs (
      id, account_id, business_id, kind, subject_type, subject_id,
      status, correlation_id
    ) VALUES (
      ${runId}, ${input.accountId}, ${input.businessId}, ${input.kind},
      ${input.subjectType}, ${input.subjectId}, 'running',
      ${input.correlationId ?? null}
    )
    ON CONFLICT (kind, subject_type, subject_id) WHERE status = 'running'
    DO NOTHING
    RETURNING id
  `;
  if (inserted.count > 0) {
    return { runId: inserted[0]!.id, created: true };
  }

  const [existing] = await tx<{ id: string }[]>`
    SELECT id FROM agent_runs
    WHERE kind = ${input.kind}
      AND subject_type = ${input.subjectType}
      AND subject_id = ${input.subjectId}
      AND status = 'running'
    FOR UPDATE
  `;
  if (!existing) {
    throw new Error(
      `run-spine: INSERT conflicted but no active run found for ${input.kind}/${input.subjectType}/${input.subjectId}`,
    );
  }
  return { runId: existing.id, created: false };
}
```

- [x] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/lib/agents/__tests__/run-spine.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/lib/agents/run-spine.ts src/lib/agents/__tests__/run-spine.test.ts
git commit -m "feat(agents): startOrGetActiveRun — race-safe run start"
```

---

### Task 4: Writer library — `recordStep`

**Files:**
- Modify: `src/lib/agents/run-spine.ts`
- Modify: `src/lib/agents/__tests__/run-spine.test.ts`

- [x] **Step 1: Write the failing tests**

```typescript
import { recordStep } from '../run-spine';

describe('recordStep', () => {
  let tx: ReturnType<typeof vi.fn>;
  beforeEach(() => { tx = vi.fn(); });

  it('locks the run, computes the next index, and inserts with the mapped persona', async () => {
    tx.mockResolvedValueOnce(withCount([{ next_index: 3 }], 1)); // lock + MAX(step_index)+1
    tx.mockResolvedValueOnce(withCount([], 0));                  // INSERT step

    await recordStep(tx as never, {
      runId: 'run-1',
      stepKey: 'draft_generated',
      detail: { response_id: 'resp-1', version: 1 },
      latencyMs: 1200,
    });

    const lockSql = (tx.mock.calls[0]?.[0] as TemplateStringsArray | undefined)?.join('?') ?? '';
    expect(lockSql).toContain('FOR UPDATE');

    const insertSql = (tx.mock.calls[1]?.[0] as TemplateStringsArray | undefined)?.join('?') ?? '';
    expect(insertSql).toContain('INSERT INTO agent_run_steps');
    const params = (tx.mock.calls[1] as unknown[]).slice(1);
    expect(params).toContain('draft_generated');
    expect(params).toContain('reply');   // persona from STEP_PERSONA, not caller input
    expect(params).toContain(3);         // next_index from the locked read
  });

  it('throws when the run row does not exist', async () => {
    tx.mockResolvedValueOnce(withCount([], 0));
    await expect(recordStep(tx as never, { runId: 'missing', stepKey: 'policy_gate' }))
      .rejects.toThrow(/run not found/i);
  });
});
```

- [x] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/lib/agents/__tests__/run-spine.test.ts`
Expected: FAIL — `recordStep` is not exported.

- [x] **Step 3: Implement**

```typescript
export interface RecordStepInput {
  runId: string;
  stepKey: AgentStepKey;
  status?: 'completed' | 'failed' | 'skipped';
  /** ids/enums/counts ONLY — never raw review/response text. */
  detail?: Record<string, unknown>;
  latencyMs?: number;
}

/**
 * Append a step to a run. Serializes concurrent appenders by locking the run
 * row before computing the next step_index (UNIQUE (agent_run_id, step_index)
 * is the backstop). Persona comes from STEP_PERSONA — callers cannot
 * mis-attribute a step.
 */
export async function recordStep(tx: TxClient, input: RecordStepInput): Promise<void> {
  const [row] = await tx<{ next_index: number }[]>`
    SELECT COALESCE(MAX(s.step_index), 0) + 1 AS next_index
    FROM agent_runs r
    LEFT JOIN agent_run_steps s ON s.agent_run_id = r.id
    WHERE r.id = ${input.runId}
    GROUP BY r.id
    FOR UPDATE OF r
  `;
  if (!row) {
    throw new Error(`run-spine: run not found for recordStep(${input.runId}, ${input.stepKey})`);
  }

  await tx`
    INSERT INTO agent_run_steps (
      id, agent_run_id, step_index, step_key, attributed_agent,
      status, detail, latency_ms
    ) VALUES (
      ${uuidv7()}, ${input.runId}, ${row.next_index}, ${input.stepKey},
      ${personaForStep(input.stepKey)}, ${input.status ?? 'completed'},
      ${jsonb(input.detail ?? {})}, ${input.latencyMs ?? null}
    )
  `;
}
```

- [x] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/lib/agents/__tests__/run-spine.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/lib/agents/run-spine.ts src/lib/agents/__tests__/run-spine.test.ts
git commit -m "feat(agents): recordStep — serialized, persona-mapped step append"
```

---

### Task 5: Writer library — `recordOutcome` + `completeRun`

**Files:**
- Modify: `src/lib/agents/run-spine.ts`
- Modify: `src/lib/agents/__tests__/run-spine.test.ts`

- [x] **Step 1: Write the failing tests**

```typescript
import { recordOutcome, completeRun } from '../run-spine';

describe('recordOutcome', () => {
  let tx: ReturnType<typeof vi.fn>;
  beforeEach(() => { tx = vi.fn(); });

  it('inserts with retry-safe ON CONFLICT dedup per (run, kind)', async () => {
    tx.mockResolvedValueOnce(withCount([], 0));

    await recordOutcome(tx as never, {
      runId: 'run-1',
      accountId: 'acct-1',
      businessId: 'biz-1',
      attributedAgent: 'reply',
      outcomeKind: 'reply_posted',
    });

    const sqlText = (tx.mock.calls[0]?.[0] as TemplateStringsArray | undefined)?.join('?') ?? '';
    expect(sqlText).toContain('INSERT INTO agent_outcomes');
    expect(sqlText).toContain('ON CONFLICT (agent_run_id, outcome_kind)');
    expect(sqlText).toContain('WHERE agent_run_id IS NOT NULL');
    expect(sqlText).toContain('DO NOTHING');
  });
});

describe('completeRun', () => {
  let tx: ReturnType<typeof vi.fn>;
  beforeEach(() => { tx = vi.fn(); });

  it('flips a running run to a terminal status and stamps ended_at', async () => {
    tx.mockResolvedValueOnce(withCount([{ id: 'run-1' }], 1));

    await completeRun(tx as never, 'run-1', 'completed');

    const sqlText = (tx.mock.calls[0]?.[0] as TemplateStringsArray | undefined)?.join('?') ?? '';
    expect(sqlText).toContain('UPDATE agent_runs');
    expect(sqlText).toContain("status = 'running'"); // only running runs transition
    expect(sqlText).toContain('ended_at = NOW()');
  });

  it('is a no-op (not an error) when the run is already terminal', async () => {
    tx.mockResolvedValueOnce(withCount([], 0));
    await expect(completeRun(tx as never, 'run-1', 'failed', { reason: 'llm_terminal' }))
      .resolves.toBeUndefined();
  });
});
```

- [x] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/lib/agents/__tests__/run-spine.test.ts`
Expected: FAIL — `recordOutcome` / `completeRun` not exported.

- [x] **Step 3: Implement**

```typescript
export interface RecordOutcomeInput {
  runId: string | null;
  accountId: string;
  businessId: string | null;
  attributedAgent: AgentPersona;
  outcomeKind: AgentOutcomeKind;
  unitCount?: number;
}

/**
 * Emit an outcome. Retry-safe: the ON CONFLICT clause matches the
 * agent_outcomes_once_per_run_kind partial unique index byte-for-byte
 * (migration 071), so a BullMQ retry after commit cannot double-emit.
 */
export async function recordOutcome(tx: TxClient, input: RecordOutcomeInput): Promise<void> {
  await tx`
    INSERT INTO agent_outcomes (
      id, account_id, business_id, agent_run_id, attributed_agent,
      outcome_kind, unit_count
    ) VALUES (
      ${uuidv7()}, ${input.accountId}, ${input.businessId}, ${input.runId},
      ${input.attributedAgent}, ${input.outcomeKind}, ${input.unitCount ?? 1}
    )
    ON CONFLICT (agent_run_id, outcome_kind) WHERE agent_run_id IS NOT NULL
    DO NOTHING
  `;
}

/**
 * Terminal transition. Only 'running' runs transition (idempotent: a retry
 * that re-completes an already-terminal run is a no-op, matching the
 * agent_runs_terminal_consistency CHECK).
 */
export async function completeRun(
  tx: TxClient,
  runId: string,
  status: 'completed' | 'failed',
  error?: Record<string, unknown>,
): Promise<void> {
  await tx`
    UPDATE agent_runs
    SET status = ${status},
        ended_at = NOW(),
        error = ${error ? jsonb(error) : null}
    WHERE id = ${runId}
      AND status = 'running'
  `;
}
```

- [x] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/lib/agents/__tests__/run-spine.test.ts`
Expected: PASS (whole file).

- [x] **Step 5: Commit**

```bash
git add src/lib/agents/run-spine.ts src/lib/agents/__tests__/run-spine.test.ts
git commit -m "feat(agents): recordOutcome + completeRun — retry-safe spine writers"
```

---

### Task 6: Instrument `processReview` (run start + ingest/update steps)

**Files:**
- Modify: `src/lib/reviews/process-review.ts`
- Modify: `src/lib/reviews/__tests__/process-review.test.ts`

- [x] **Step 1: Write the failing tests** (same tx-call assertion pattern the file already uses for sentiment; add a `vi.mock` for the spine so assertions target the seam, not SQL internals)

At the top of the test file, alongside the existing mocks:

```typescript
vi.mock('@/lib/agents/run-spine', () => ({
  startOrGetActiveRun: vi.fn().mockResolvedValue({ runId: 'run-1', created: true }),
  recordStep: vi.fn(),
}));
import { startOrGetActiveRun, recordStep } from '@/lib/agents/run-spine';
```

New tests (inside `describe('processReview')`; the mocked tx sequences must add one extra `mockResolvedValueOnce(withCount([{ account_id: 'acct-1' }], 1))` for the account lookup the instrumentation adds — see Step 3):

```typescript
it('new review starts a review_handler run and records review_ingested', async () => {
  const monitored = makeMonitoredReview();
  tx
    .mockResolvedValueOnce(withCount([], 0))
    .mockResolvedValueOnce(withCount([{ id: 'new-id' }], 1))
    .mockResolvedValueOnce(withCount([{ account_id: 'acct-1' }], 1)) // account lookup for the spine
    .mockResolvedValueOnce(withCount([], 0))
    .mockResolvedValueOnce(withCount([{ account_id: 'acct-1', earlier_exists: false }], 1));

  const result = await processReview(monitored, 'biz-1', 'corr-1');
  expect(result).toBe('new');

  expect(startOrGetActiveRun).toHaveBeenCalledWith(tx, expect.objectContaining({
    kind: 'review_handler',
    subjectType: 'review',
    subjectId: 'new-id',
    accountId: 'acct-1',
    businessId: 'biz-1',
    correlationId: 'corr-1',
  }));
  expect(recordStep).toHaveBeenCalledWith(tx, expect.objectContaining({
    runId: 'run-1',
    stepKey: 'review_ingested',
  }));
});

it('content-changed review records review_updated on its run', async () => {
  const monitored = makeMonitoredReview({ contentHash: 'new-hash' });
  tx
    .mockResolvedValueOnce(withCount([{ id: 'existing-rev', review_content_hash: 'old-hash', status: 'new' }], 1))
    .mockResolvedValueOnce(withCount([], 0))   // UPDATE reviews
    .mockResolvedValueOnce(withCount([{ account_id: 'acct-1' }], 1)) // account lookup for the spine
    .mockResolvedValueOnce(withCount([], 0))   // SELECT active response → none
    .mockResolvedValueOnce(withCount([{ next_version: 2 }], 1))
    .mockResolvedValueOnce(withCount([], 0));  // INSERT job_outbox

  const result = await processReview(monitored, 'biz-1', 'corr-1');
  expect(result).toBe('updated');

  expect(recordStep).toHaveBeenCalledWith(tx, expect.objectContaining({
    stepKey: 'review_updated',
  }));
});

it('unchanged review does NOT touch the run spine', async () => {
  const monitored = makeMonitoredReview({ contentHash: 'same-hash' });
  tx.mockResolvedValueOnce(withCount([{ id: 'existing-rev', review_content_hash: 'same-hash', status: 'new' }], 1));

  const result = await processReview(monitored, 'biz-1', 'corr-1');
  expect(result).toBe('unchanged');
  expect(startOrGetActiveRun).not.toHaveBeenCalled();
  expect(recordStep).not.toHaveBeenCalled();
});
```

Note: pre-existing tests in this file gain one extra mocked tx result wherever the new-review or content-changed paths run (the account lookup). Update their `mockResolvedValueOnce` chains and `toHaveBeenCalledTimes` counts accordingly — the RED run tells you exactly which ones.

- [x] **Step 2: Run to verify the new tests fail**

Run: `pnpm vitest run src/lib/reviews/__tests__/process-review.test.ts`
Expected: new tests FAIL (`startOrGetActiveRun` never called).

- [x] **Step 3: Implement the instrumentation**

In `src/lib/reviews/process-review.ts`:

Add imports:

```typescript
import { startOrGetActiveRun, recordStep } from '@/lib/agents/run-spine';
```

Add a private helper above `processReview`:

```typescript
async function startReviewRun(
  tx: TxClient,
  input: { reviewId: string; businessId: string; correlationId?: string; stepKey: 'review_ingested' | 'review_updated' },
): Promise<void> {
  const [biz] = await tx<{ account_id: string }[]>`
    SELECT account_id FROM businesses WHERE id = ${input.businessId}
  `;
  if (!biz) return; // orphaned business mid-teardown: skip spine, keep ingest alive
  const { runId } = await startOrGetActiveRun(tx, {
    kind: 'review_handler',
    subjectType: 'review',
    subjectId: input.reviewId,
    accountId: biz.account_id,
    businessId: input.businessId,
    correlationId: input.correlationId,
  });
  await recordStep(tx, { runId, stepKey: input.stepKey });
}
```

In the new-review win branch (directly after `if (inserted.count > 0) {`, before `enqueueGenerateResponse`):

```typescript
        await startReviewRun(tx, {
          reviewId,
          businessId,
          correlationId,
          stepKey: 'review_ingested',
        });
```

In `processExistingReview`, in the CONTENT CHANGED block — directly after the `UPDATE reviews` statement and before the active-response SELECT:

```typescript
  await startReviewRun(tx, {
    reviewId: existing.id,
    businessId,
    correlationId,
    stepKey: 'review_updated',
  });
```

(The unchanged/status-only paths get no spine writes — mirroring the sentiment discipline.)

- [x] **Step 4: Run the whole file; fix pre-existing tests' mock chains flagged by RED**

Run: `pnpm vitest run src/lib/reviews/__tests__/process-review.test.ts`
Expected: PASS (all tests, after adjusting the extra account-lookup mock in affected pre-existing tests).

- [x] **Step 5: Commit**

```bash
git add src/lib/reviews/process-review.ts src/lib/reviews/__tests__/process-review.test.ts
git commit -m "feat(agents): instrument processReview with run start + ingest/update steps"
```

---

### Task 7: Instrument `persistResponseAndNotify` (draft + moderation + gate steps, `reply_drafted` outcome)

**Files:**
- Modify: `worker/jobs/response-generation/persist.ts`
- Test: extend the existing persist test file in `worker/jobs/response-generation/__tests__/` (locate the file covering `persistResponseAndNotify`; follow its established mock pattern)

- [x] **Step 1: Write the failing tests**

Mock the spine seam in the persist test file, mirroring Task 6:

```typescript
vi.mock('../../../src/lib/agents/run-spine', () => ({
  recordStep: vi.fn(),
  recordOutcome: vi.fn(),
}));
import { recordStep, recordOutcome } from '../../../src/lib/agents/run-spine';
```

Three behaviors to assert (write them in the file's existing style — it already constructs `PersistResponseInput` fixtures and a mocked tx):

```typescript
it('records draft_generated + moderation_checked steps and a reply_drafted outcome in the persist tx', async () => {
  // arrange the file's standard happy-path fixture, plus one extra mocked tx
  // result for the run lookup (SELECT id FROM agent_runs … status='running')
  // → returns [{ id: 'run-1', account_id: 'acct-1' }]
  // act: await persistResponseAndNotify(input)
  expect(recordStep).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
    runId: 'run-1', stepKey: 'draft_generated',
    detail: expect.objectContaining({ response_id: expect.any(String), version: expect.any(Number) }),
  }));
  expect(recordStep).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
    runId: 'run-1', stepKey: 'moderation_checked',
  }));
  expect(recordOutcome).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
    runId: 'run-1', outcomeKind: 'reply_drafted', attributedAgent: 'reply',
  }));
});

it('records a policy_gate step with the auto-approval decision on the auto-approved path', async () => {
  // arrange the file's existing auto-approval fixture
  expect(recordStep).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
    stepKey: 'policy_gate',
    detail: expect.objectContaining({ decision: 'auto_approved' }),
  }));
});

it('skips spine writes when no running review_handler run exists (legacy rows)', async () => {
  // run lookup returns [] → no recordStep/recordOutcome calls, persist still succeeds
  expect(recordStep).not.toHaveBeenCalled();
});
```

- [x] **Step 2: Run to verify failure**

Run: `pnpm vitest run worker/jobs/response-generation/__tests__/`
Expected: new tests FAIL (spine seam never called).

- [x] **Step 3: Implement**

In `persist.ts`, add the import:

```typescript
import { recordStep, recordOutcome } from '../../../src/lib/agents/run-spine';
```

Add a private helper:

```typescript
async function findActiveReviewRun(
  tx: TxClient,
  reviewId: string,
): Promise<{ id: string; account_id: string } | null> {
  const [run] = await tx<{ id: string; account_id: string }[]>`
    SELECT id, account_id FROM agent_runs
    WHERE kind = 'review_handler'
      AND subject_type = 'review'
      AND subject_id = ${reviewId}
      AND status = 'running'
  `;
  return run ?? null;
}
```

Inside the `sql.begin` transaction (line ~65), after the `INSERT INTO responses` and the moderation/hold write, add — with `reviewId`, `businessId`, `responseId`, `version`, moderation result, and the auto-approval decision all in scope at that point:

```typescript
    const activeRun = await findActiveReviewRun(tx, input.reviewId);
    if (activeRun) {
      await recordStep(tx, {
        runId: activeRun.id,
        stepKey: 'draft_generated',
        detail: { response_id: responseId, version: input.version },
      });
      await recordStep(tx, {
        runId: activeRun.id,
        stepKey: 'moderation_checked',
        status: flaggedHigh ? 'failed' : 'completed',
        detail: { flagged: moderation.flagged, severity: moderation.severity ?? null, held: flaggedHigh },
      });
      await recordOutcome(tx, {
        runId: activeRun.id,
        accountId: activeRun.account_id,
        businessId: input.businessId,
        attributedAgent: 'reply',
        outcomeKind: 'reply_drafted',
      });
    }
```

And in the auto-approval decision branch (the ordered approve-UPDATE → audit → enqueue-publish block, ~line 137), inside the same tx:

```typescript
      if (activeRun) {
        await recordStep(tx, {
          runId: activeRun.id,
          stepKey: 'policy_gate',
          detail: { decision: autoApproved ? 'auto_approved' : 'held_for_owner' },
        });
      }
```

(Adapt local variable names — `flaggedHigh`, `moderation`, `autoApproved`, `responseId` — to the file's actual identifiers at the insertion points; the persist tx already has all of these in scope. The legacy-row guard is the `if (activeRun)` — pre-071 reviews regenerating simply skip the spine.)

- [x] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run worker/jobs/response-generation/__tests__/`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add worker/jobs/response-generation/persist.ts worker/jobs/response-generation/__tests__/
git commit -m "feat(agents): instrument response persist with draft/moderation/gate steps"
```

---

### Task 8: Instrument `markPostedAndMaybeEnqueueAutoPostNotice` (posted step, outcomes, run completion)

**Files:**
- Modify: `worker/jobs/publisher/mark-posted.ts`
- Modify: `worker/jobs/publisher/__tests__/mark-posted.test.ts`

- [x] **Step 1: Write the failing tests** (same seam-mock pattern; the file's existing tests already drive `markPostedAndMaybeEnqueueAutoPostNotice` with a mocked tx)

```typescript
vi.mock('../../../src/lib/agents/run-spine', () => ({
  recordStep: vi.fn(),
  recordOutcome: vi.fn(),
  completeRun: vi.fn(),
}));
import { recordStep, recordOutcome, completeRun } from '../../../src/lib/agents/run-spine';

it('owner-approved post records reply_posted step + outcome and completes the run', async () => {
  // arrange the file's owner-approval fixture; add one mocked tx result for the
  // run lookup → [{ id: 'run-1', account_id: 'acct-1' }]
  expect(recordStep).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
    runId: 'run-1', stepKey: 'reply_posted',
  }));
  expect(recordOutcome).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
    outcomeKind: 'reply_posted', attributedAgent: 'reply',
  }));
  expect(completeRun).toHaveBeenCalledWith(expect.anything(), 'run-1', 'completed');
});

it('auto_policy post additionally emits reply_auto_posted', async () => {
  // arrange the file's auto_policy fixture
  expect(recordOutcome).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
    outcomeKind: 'reply_auto_posted',
  }));
});

it('skips spine writes when no running run exists (legacy rows)', async () => {
  expect(recordStep).not.toHaveBeenCalled();
  expect(completeRun).not.toHaveBeenCalled();
});
```

- [x] **Step 2: Run to verify failure**

Run: `pnpm vitest run worker/jobs/publisher/__tests__/mark-posted.test.ts`
Expected: new tests FAIL.

- [x] **Step 3: Implement**

In `mark-posted.ts` (the function already receives the tx and RETURNS `approval_method` from its UPDATE), after the successful one-row UPDATE and before returning:

```typescript
  const [activeRun] = await tx<{ id: string; account_id: string }[]>`
    SELECT id, account_id FROM agent_runs
    WHERE kind = 'review_handler'
      AND subject_type = 'review'
      AND subject_id = ${reviewId}
      AND status = 'running'
  `;
  if (activeRun) {
    await recordStep(tx, {
      runId: activeRun.id,
      stepKey: 'reply_posted',
      detail: { response_id: responseId, approval_method: rows[0]!.approval_method },
    });
    await recordOutcome(tx, {
      runId: activeRun.id,
      accountId: activeRun.account_id,
      businessId,
      attributedAgent: 'reply',
      outcomeKind: 'reply_posted',
    });
    if (rows[0]!.approval_method === APPROVAL_METHOD.AUTO_POLICY) {
      await recordOutcome(tx, {
        runId: activeRun.id,
        accountId: activeRun.account_id,
        businessId,
        attributedAgent: 'reply',
        outcomeKind: 'reply_auto_posted',
      });
    }
    await completeRun(tx, activeRun.id, 'completed');
  }
```

(`reviewId`/`businessId`/`responseId` are already parameters/locals of the function; the `agent_outcomes_once_per_run_kind` index makes the two `recordOutcome` calls retry-safe. Note `reply_auto_posted` dedups independently of `reply_posted` because they are distinct kinds.)

- [x] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run worker/jobs/publisher/__tests__/mark-posted.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add worker/jobs/publisher/mark-posted.ts worker/jobs/publisher/__tests__/mark-posted.test.ts
git commit -m "feat(agents): instrument mark-posted with posted step, outcomes, run completion"
```

---

### Task 9: Audits, security inventory, and reference docs

**Files:**
- Modify: `scripts/ci/tenant-tables.ts` (add `agent_runs`, `agent_run_steps`, `agent_outcomes`)
- Modify: `scripts/ci/tenant-scope-allowlist.ts`
- Modify: `docs/security/rls-inventory.md` (three new deny-all rows, citing migration 071)
- Modify: `.claude/reference/migrations-log.md`

- [x] **Step 1: Add the three tables to `TENANT_TABLES`** in `scripts/ci/tenant-tables.ts`, following the file's existing entry format (deny-all RLS, service-role access only).

- [x] **Step 2: Run the audits and add allowlist entries for the spine's by-id queries**

Run: `pnpm ci:rls-audit && pnpm ci:tenant-scope`

Expected: rls-audit passes (migration 071 enables RLS on all three). tenant-scope flags the run-spine queries that are keyed by `run.id`/subject rather than `account_id`/`business_id` — add one allowlist entry per flagged query in `scripts/ci/tenant-scope-allowlist.ts` with `category: 'worker-job-scoped'` and reason: `"Run-spine writers execute inside ingest/persist/publish transactions that already carry businessId from source connection resolution; runs are keyed by id/subject within that scoped tx (migration 071)."` Re-run until green with the baseline bumped by exactly the added entries.

- [x] **Step 3: Add three deny-all rows to `docs/security/rls-inventory.md`** following the `analytics_events` row format, citing migration 071.

- [x] **Step 4: Update `.claude/reference/migrations-log.md`**: header → `Current head: **071** — next migration is **072**`; append a `- **071** —` entry summarizing the three tables, the two byte-for-byte ON CONFLICT/index pairings (`agent_runs_one_active_per_subject` ↔ `startOrGetActiveRun`, `agent_outcomes_once_per_run_kind` ↔ `recordOutcome`), deny-all RLS, and staging-first application. Add the three tables to the Key Tables Reference.

- [x] **Step 5: Commit**

```bash
git add scripts/ci/tenant-tables.ts scripts/ci/tenant-scope-allowlist.ts docs/security/rls-inventory.md .claude/reference/migrations-log.md
git commit -m "chore(agents): spine tables in RLS/tenant audits + migration log"
```

---

### Task 10: Full gates + PR

- [x] **Step 1: Run the full verification set**

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm ci:tenant-scope && pnpm ci:rls-audit && pnpm ci:analytics-events && pnpm ci:static-policy`
Expected: all green.

- [x] **Step 2: Push and open the PR**

```bash
git push -u origin feat/agent-run-spine
gh pr create --base main --title "feat(agents): agent run spine — migration 071 + pipeline instrumentation" \
  --body "WS1 of agentic-platform Phase 1 (design doc 2026-07-01 §3.2). Run/step/outcome attribution tables + transactional writer lib; ingest/persist/mark-posted instrumented in-tx. No execution engine, no behavior change to the pipeline. Apply migration 071 staging-first, both projects in lockstep."
```

- [x] **Step 3: After merge — apply migration 071 to staging Supabase, verify (`\d agent_runs` + deny-all RLS check), then production, per deployment-guide.**

---

## Implementation record (2026-07-07 — PR #459, subagent-driven with per-task spec + quality review)

**Status: WS1 implemented.** All tasks executed; every commit passed a spec-compliance review and a code-quality review, with fixes applied before proceeding. Full gates green (7461 tests, all CI audits).

### Amendments made during implementation (plan → shipped deltas)

1. **`jsonb()` import dropped (invariant #15 / `ci:db-imports` strict, post-dates this plan):** `run-spine.ts` uses `tx.json()` and never imports `@/lib/db/server`.
2. **`recordStep`'s planned single-statement `GROUP BY … FOR UPDATE` was invalid Postgres** — and the corrected single-statement form still had a READ COMMITTED stale-snapshot race. Shipped as lock-then-count (two statements: `SELECT … FOR UPDATE`, then `MAX(step_index)+1` on a post-lock snapshot).
3. **`agent_runs.correlation_id` is TEXT, not UUID** — live callers pass `zernio-poll:<id>` / provider event ids; UUID typing would have aborted live ingest (22P02).
4. **`findActiveReviewRun` lives exported in `run-spine.ts`** (single owner) instead of private copies in persist/mark-posted.
5. **Lock-ordering rule added** (`run-spine.ts` header): any tx locking an `agent_runs` row for a review-subject run takes that review's `reviews` row `FOR UPDATE` as its FIRST statement (before implicit FK KEY SHARE from child-row writes). Persist + mark-posted comply; prevents an upgrade-deadlock found in review.
6. **Migration 071 hardening beyond the plan SQL:** kind↔subject_type pairing CHECK, `ended_at >= started_at` CHECK, COMMENT ONs, redundant step index dropped. `RecordOutcomeInput.runId` narrowed to `string`; `StartRunInput` is a discriminated union; `completeRun` distinguishes already-terminal (no-op) from missing run (throw).
7. **Offboarding coverage (found in final review):** all three tables classified in `table-disposition.ts` (hard_delete); purge stages delete outcomes before runs (outcomes FK is ON DELETE SET NULL), steps cascade; fail-closed verification branches added.
8. **Test hardening beyond the plan:** migration-071 drift-guard test (pins both ON CONFLICT↔index pairings), live-DB integration suite for the writer lib (self-applies 071 idempotently until it ships), failure-propagation tests at ingest/persist/mark-posted checkpoints.

### Named follow-ups (not WS1 scope)

- **Edit-publish spine gap:** the `EDIT_REPLIES_ENABLED` posted path bypasses the mark-posted checkpoint → its run stays `running`. Fix shape: route `edit-publish`'s posted flip through the same checkpoint (its tx already locks the review first). Natural home: WS4/WS5 cycle.
- **Terminal-failure completion:** publisher failed-hook + superseded branches are the natural future `completeRun('failed')` checkpoints; until then WS5's timeline must render stale `running` runs sensibly.
- Post-while-regenerating interleaving leaves a v2 draft with no spine trace (run completed by v1's post) — disambiguated by `reply_posted.detail.response_id`.

## Self-review notes

- **Spec coverage:** Design doc §3.2 launch-spine requirements → Tasks 1 (tables), 2–5 (writers + persona map), 6–8 (the three natural checkpoints: ingest, generate/gate, post). Owner-facing timeline reads are WS5 by design, not a gap. Approval/edit outcomes (`reply_approved_no_edit`/`reply_edited_by_owner`) are deliberately WS4 (where the governor consumes them) — the outcome kinds ship in 071's CHECK now so WS4 needs no migration.
- **Type consistency:** `startOrGetActiveRun`/`recordStep`/`recordOutcome`/`completeRun` signatures match across Tasks 3–8; `STEP_PERSONA` keys used in Tasks 6–8 (`review_ingested`, `review_updated`, `draft_generated`, `moderation_checked`, `policy_gate`, `reply_posted`) all exist in Task 2's map.
- **Known adaptation points (not placeholders):** Tasks 7–8 name exact functions/files and give the code to insert, but local identifier names (`flaggedHigh`, `moderation`, `autoApproved`, `responseId`) must be matched to the file's actual locals at the stated insertion points — the persist tx has all of them in scope (verified 2026-07-01 against `persist.ts` lines 65–140 and `mark-posted.ts` lines 39–65).
