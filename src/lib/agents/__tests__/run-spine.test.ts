import { describe, it, expect, beforeEach } from 'vitest';
import type { TransactionSql } from 'postgres';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  createMockSql,
  mkTaggedResult,
  type MockSqlHarness,
} from '../../../../worker/__tests__/helpers/mock-sql';
import {
  AGENT_PERSONAS,
  AGENT_RUN_KINDS,
  AGENT_OUTCOME_KINDS,
  STEP_PERSONA,
  personaForStep,
  startOrGetActiveRun,
  startOrGetSolicitationBatchRun,
  findActiveReviewRun,
  recordCompletedChildRuns,
  recordStep,
  recordOutcome,
  completeRun,
  completeSolicitationBatchRun,
  failSolicitationBatchRun,
} from '../run-spine';

describe('run-spine constants', () => {
  it('exposes the customer personas plus system', () => {
    expect(AGENT_PERSONAS).toEqual([
      'reply',
      'guardian',
      'insights',
      'solicitation',
      'system',
    ]);
  });

  it('run kinds match migration 088 CHECK', () => {
    expect(AGENT_RUN_KINDS).toEqual([
      'review_handler',
      'weekly_insights',
      'solicitation_batch',
      'solicitation_ask',
    ]);
  });

  it('outcome kinds match the migration 088 CHECK', () => {
    expect(AGENT_OUTCOME_KINDS).toEqual([
      'reply_drafted', 'reply_posted', 'reply_auto_posted',
      'reply_approved_no_edit', 'reply_edited_by_owner', 'reply_vetoed_by_owner',
      'review_escalated', 'escalation_resolved', 'digest_sent',
      'solicitation_batch_built',
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
    expect(personaForStep('triage')).toBe('guardian');
    expect(personaForStep('escalation_raised')).toBe('guardian');
    expect(personaForStep('escalation_sent')).toBe('guardian');
    expect(personaForStep('digest_sent')).toBe('insights');
    expect(personaForStep('ask_evaluated')).toBe('solicitation');
    expect(personaForStep('batch_built')).toBe('solicitation');
  });
});

// Drift guard: the module's ON CONFLICT clauses must pair byte-for-byte with
// the partial unique indexes in migration 071 (Postgres only recognizes the
// arbiter when column list + predicate match). The startOrGetActiveRun /
// recordOutcome suites below pin the module side of each pairing; these pin
// the migration side, so either half drifting fails a test instead of only
// falsifying a comment. (Pattern precedent: migration-038-structure.test.ts.)
describe('migration 071 pairing (drift guard)', () => {
  const migrationSql = readFileSync(
    resolve(process.cwd(), 'supabase/migrations/071_agent_run_spine.sql'),
    'utf-8',
  );

  it('agent_runs_one_active_per_subject matches startOrGetActiveRun ON CONFLICT', () => {
    expect(migrationSql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS agent_runs_one_active_per_subject\s+ON agent_runs \(kind, subject_type, subject_id\)\s+WHERE status = 'running'/,
    );
  });

  it('agent_outcomes_once_per_run_kind matches recordOutcome ON CONFLICT', () => {
    expect(migrationSql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS agent_outcomes_once_per_run_kind\s+ON agent_outcomes \(agent_run_id, outcome_kind\)\s+WHERE agent_run_id IS NOT NULL/,
    );
  });
});

// Writer suites run against the shared fragment-aware Postgres.js mock
// (worker/__tests__/helpers/mock-sql), the same harness the audit-log unit
// tests use — no hand-rolled tagged-template shim. The harness already
// provides the `.json()` surface injected domain modules use (invariant #15).
function tx(harness: MockSqlHarness): TransactionSql {
  return harness.mockSql as unknown as TransactionSql;
}

describe('startOrGetActiveRun', () => {
  let harness: MockSqlHarness;
  beforeEach(() => { harness = createMockSql(); });

  it('inserts a new running run and returns its id with created=true', async () => {
    harness.sqlReturnQueue.push(mkTaggedResult([{ id: 'run-1' }])); // INSERT … RETURNING id

    const out = await startOrGetActiveRun(tx(harness), {
      kind: 'review_handler',
      subjectType: 'review',
      subjectId: 'rev-1',
      accountId: 'acct-1',
      businessId: 'biz-1',
      correlationId: 'corr-1',
    });

    expect(out.created).toBe(true);
    expect(out.runId).toBe('run-1');
    expect(harness.sqlCalls).toHaveLength(1);
    const insertSql = harness.sqlCalls[0]!.text;
    expect(insertSql).toContain('INSERT INTO agent_runs');
    expect(insertSql).toContain('ON CONFLICT (kind, subject_type, subject_id)');
    expect(insertSql).toContain("WHERE status = 'running'");
  });

  it('returns the existing active run with created=false when the INSERT conflicts', async () => {
    harness.sqlReturnQueue.push(mkTaggedResult([])); // INSERT DO NOTHING → no row
    harness.sqlReturnQueue.push(mkTaggedResult([{ id: 'run-existing' }])); // SELECT active

    const out = await startOrGetActiveRun(tx(harness), {
      kind: 'review_handler',
      subjectType: 'review',
      subjectId: 'rev-1',
      accountId: 'acct-1',
      businessId: 'biz-1',
    });

    expect(out.created).toBe(false);
    expect(out.runId).toBe('run-existing');
    expect(harness.sqlCalls[1]!.text).toContain('FOR UPDATE');
  });

  it('throws when the conflict path finds no active run (impossible state)', async () => {
    harness.sqlReturnQueue.push(mkTaggedResult([]));
    harness.sqlReturnQueue.push(mkTaggedResult([]));

    await expect(startOrGetActiveRun(tx(harness), {
      kind: 'review_handler',
      subjectType: 'review',
      subjectId: 'rev-1',
      accountId: 'acct-1',
      businessId: 'biz-1',
    })).rejects.toThrow(/active run/i);
  });

  it('startOrGetActiveRun records Solicitation parent linkage without changing the active-run conflict predicate', async () => {
    harness.sqlReturnQueue.push(mkTaggedResult([{ id: 'ask-run-1' }]));

    const out = await startOrGetActiveRun(tx(harness), {
      kind: 'solicitation_ask',
      subjectType: 'solicitation_ask',
      subjectId: 'ask-1',
      accountId: 'acct-1',
      businessId: 'biz-1',
      parentRunId: 'batch-run-1',
    });

    expect(out).toEqual({ runId: 'ask-run-1', created: true });
    const insert = harness.sqlCalls[0]!;
    expect(insert.text).toContain('parent_run_id');
    expect(insert.values).toContain('batch-run-1');
    expect(insert.text).toContain(
      "ON CONFLICT (kind, subject_type, subject_id) WHERE status = 'running'",
    );
  });
});

describe('startOrGetSolicitationBatchRun', () => {
  let harness: MockSqlHarness;
  beforeEach(() => { harness = createMockSql(); });

  it('starts the Solicitation parent through a batch-specific spine seam', async () => {
    harness.sqlReturnQueue.push(mkTaggedResult([{ id: 'batch-run-1' }]));

    const out = await startOrGetSolicitationBatchRun(tx(harness), {
      batchId: 'batch-1',
      accountId: 'account-1',
      businessId: 'business-1',
      correlationId: 'correlation-1',
    });

    expect(out).toEqual({ runId: 'batch-run-1', created: true });
    const insert = harness.sqlCalls[0]!;
    expect(insert.text).toContain('INSERT INTO agent_runs');
    expect(insert.values).toContain('solicitation_batch');
    expect(insert.values).toContain('batch-1');
    expect(insert.values).toContain('correlation-1');
  });
});

describe('recordCompletedChildRuns', () => {
  let harness: MockSqlHarness;
  beforeEach(() => { harness = createMockSql(); });

  it('recordCompletedChildRuns bulk-writes one completed child and ask_evaluated step per ask', async () => {
    harness.sqlReturnQueue.push(mkTaggedResult([{ id: 'child-run-1' }]));
    harness.sqlReturnQueue.push(mkTaggedResult([{ id: 'step-1' }]));

    await recordCompletedChildRuns(tx(harness), {
      accountId: 'acct-1',
      businessId: 'biz-1',
      parentRunId: 'batch-run-1',
      children: [
        {
          runId: 'child-run-1',
          askId: 'ask-1',
          decision: 'withhold',
          withheldReason: 'velocity_banked',
        },
      ],
    });

    expect(harness.sqlCalls).toHaveLength(2);
    const [runs, steps] = harness.sqlCalls;
    expect(runs!.text).toContain('INSERT INTO agent_runs');
    expect(runs!.text).toContain('FROM unnest(');
    expect(runs!.text).toContain("'solicitation_ask'");
    expect(runs!.text).toContain("'completed'");
    expect(runs!.values).toContainEqual(['child-run-1']);
    expect(runs!.values).toContainEqual(['ask-1']);
    expect(steps!.text).toContain('INSERT INTO agent_run_steps');
    expect(steps!.text).toContain('FROM unnest(');
    expect(steps!.text).toContain("'ask_evaluated'");
    expect(steps!.text).toContain("'solicitation'");
    expect(steps!.values).toContainEqual(['velocity_banked']);
    expect(harness.sqlCalls.map((call) => call.text).join('\n'))
      .not.toContain('solicitation_asks');
  });
});

describe('findActiveReviewRun', () => {
  let harness: MockSqlHarness;
  beforeEach(() => { harness = createMockSql(); });

  it('returns the running review_handler run row for the review', async () => {
    harness.sqlReturnQueue.push(mkTaggedResult([{ id: 'run-1', account_id: 'acct-1' }]));

    const run = await findActiveReviewRun(tx(harness), 'rev-1');

    expect(run).toEqual({ id: 'run-1', account_id: 'acct-1' });
    expect(harness.sqlCalls).toHaveLength(1);
    const sqlText = harness.sqlCalls[0]!.text;
    expect(sqlText).toContain("kind = 'review_handler'");
    expect(sqlText).toContain("subject_type = 'review'");
    expect(sqlText).toContain("status = 'running'");
    expect(harness.sqlCalls[0]!.values).toContain('rev-1');
  });

  it('returns null when no running run exists (legacy review)', async () => {
    harness.sqlReturnQueue.push(mkTaggedResult([]));

    await expect(findActiveReviewRun(tx(harness), 'rev-legacy')).resolves.toBeNull();
  });
});

describe('recordStep', () => {
  let harness: MockSqlHarness;
  beforeEach(() => { harness = createMockSql(); });

  it('locks the run, computes the next index, and inserts with the mapped persona', async () => {
    harness.sqlReturnQueue.push(mkTaggedResult([{ ok: 1 }]));         // lock (own statement)
    harness.sqlReturnQueue.push(mkTaggedResult([{ next_index: 3 }])); // MAX(step_index)+1 after lock
    harness.sqlReturnQueue.push(mkTaggedResult([]));                  // INSERT step

    await recordStep(tx(harness), {
      runId: 'run-1',
      stepKey: 'draft_generated',
      detail: { response_id: 'resp-1', version: 1 },
      latencyMs: 1200,
    });

    expect(harness.sqlCalls).toHaveLength(3);
    expect(harness.sqlCalls[0]!.text).toContain('FOR UPDATE');

    const nextIndexSql = harness.sqlCalls[1]!.text;
    expect(nextIndexSql).toContain('MAX(step_index)');
    expect(nextIndexSql).not.toContain('FOR UPDATE'); // fresh snapshot AFTER the lock statement

    const insert = harness.sqlCalls[2]!;
    expect(insert.text).toContain('INSERT INTO agent_run_steps');
    expect(insert.values).toContain('draft_generated');
    expect(insert.values).toContain('reply');  // persona from STEP_PERSONA, not caller input
    expect(insert.values).toContain(3);        // next_index from the post-lock read
    expect(insert.values).toContainEqual({ response_id: 'resp-1', version: 1 });
    expect(insert.values).toContain(1200);
  });

  it('throws when the run row does not exist', async () => {
    harness.sqlReturnQueue.push(mkTaggedResult([]));
    await expect(recordStep(tx(harness), { runId: 'missing', stepKey: 'policy_gate' }))
      .rejects.toThrow(/run not found/i);
    expect(harness.sqlCalls).toHaveLength(1); // no index read, no insert
  });
});

describe('recordOutcome', () => {
  let harness: MockSqlHarness;
  beforeEach(() => { harness = createMockSql(); });

  it('inserts with retry-safe ON CONFLICT dedup per (run, kind)', async () => {
    harness.sqlReturnQueue.push(mkTaggedResult([]));

    await recordOutcome(tx(harness), {
      runId: 'run-1',
      accountId: 'acct-1',
      businessId: 'biz-1',
      attributedAgent: 'reply',
      outcomeKind: 'reply_posted',
    });

    const sqlText = harness.sqlCalls[0]!.text;
    expect(sqlText).toContain('INSERT INTO agent_outcomes');
    expect(sqlText).toContain('ON CONFLICT (agent_run_id, outcome_kind)');
    expect(sqlText).toContain('WHERE agent_run_id IS NOT NULL');
    expect(sqlText).toContain('DO NOTHING');
  });
});

describe('completeRun', () => {
  let harness: MockSqlHarness;
  beforeEach(() => { harness = createMockSql(); });

  it('flips a running run to a terminal status and stamps ended_at', async () => {
    harness.sqlReturnQueue.push(mkTaggedResult([{ id: 'run-1' }]));

    await completeRun(tx(harness), 'run-1', 'completed');

    expect(harness.sqlCalls).toHaveLength(1); // updated → no follow-up existence probe
    const sqlText = harness.sqlCalls[0]!.text;
    expect(sqlText).toContain('UPDATE agent_runs');
    expect(sqlText).toContain("status = 'running'"); // only running runs transition
    expect(sqlText).toContain('ended_at = NOW()');
    expect(sqlText).toContain('RETURNING id');
  });

  it('is a no-op (not an error) when the run is already terminal', async () => {
    harness.sqlReturnQueue.push(mkTaggedResult([]));                        // UPDATE hit nothing
    harness.sqlReturnQueue.push(mkTaggedResult([{ status: 'completed' }])); // probe: exists, terminal
    await expect(completeRun(tx(harness), 'run-1', 'failed', { reason: 'llm_terminal' }))
      .resolves.toBeUndefined();
  });

  it('throws when the run does not exist at all', async () => {
    harness.sqlReturnQueue.push(mkTaggedResult([])); // UPDATE hit nothing
    harness.sqlReturnQueue.push(mkTaggedResult([])); // probe: no row
    await expect(completeRun(tx(harness), 'missing', 'completed'))
      .rejects.toThrow(/run not found/i);
  });
});

describe('completeSolicitationBatchRun', () => {
  let harness: MockSqlHarness;
  beforeEach(() => { harness = createMockSql(); });

  it('atomically records the batch aggregate, zero-unit outcome, and completion through one Solicitation seam', async () => {
    harness.sqlReturnQueue.push(
      mkTaggedResult([{ ok: 1 }]),
      mkTaggedResult([{ next_index: 1 }]),
      mkTaggedResult([]),
      mkTaggedResult([]),
      mkTaggedResult([{ id: 'parent-run-1' }]),
    );

    await completeSolicitationBatchRun(tx(harness), {
      runId: 'parent-run-1',
      accountId: 'account-1',
      businessId: 'business-1',
      batchId: 'batch-1',
      candidateCount: 0,
      sendCount: 0,
      withholdCount: 0,
      withheldByReason: {
        no_consent: 0,
        suppressed: 0,
        already_reviewed: 0,
        stale_visit: 0,
        over_contacted: 0,
        velocity_banked: 0,
      },
    });

    expect(harness.sqlCalls).toHaveLength(5);
    const [lock, , step, outcome, completion] = harness.sqlCalls;
    expect(lock!.text).toContain('FOR UPDATE');
    expect(step!.text).toContain('INSERT INTO agent_run_steps');
    expect(step!.values).toContain('batch_built');
    expect(step!.values).toContainEqual({
      batch_id: 'batch-1',
      candidate_count: 0,
      send_count: 0,
      withhold_count: 0,
      withheld_by_reason: {
        no_consent: 0,
        suppressed: 0,
        already_reviewed: 0,
        stale_visit: 0,
        over_contacted: 0,
        velocity_banked: 0,
      },
    });
    expect(outcome!.text).toContain('INSERT INTO agent_outcomes');
    expect(outcome!.values).toContain('solicitation_batch_built');
    expect(outcome!.values).toContain(0);
    expect(completion!.text).toContain('UPDATE agent_runs');
    expect(completion!.values).toContain('completed');
  });
});

describe('failSolicitationBatchRun', () => {
  let harness: MockSqlHarness;
  beforeEach(() => { harness = createMockSql(); });

  it('records bounded gate-closure attribution while failing the parent', async () => {
    harness.sqlReturnQueue.push(mkTaggedResult([{ id: 'parent-run-1' }]));

    await failSolicitationBatchRun(tx(harness), {
      runId: 'parent-run-1',
      failure: {
        code: 'gate_closed',
        gate: 'flag_disabled',
      },
    });

    expect(harness.sqlCalls).toHaveLength(1);
    const transition = harness.sqlCalls[0]!;
    expect(transition.text).toContain('UPDATE agent_runs');
    expect(transition.values).toContain('failed');
    expect(transition.values).toContainEqual({
      code: 'gate_closed',
      gate: 'flag_disabled',
    });
  });
});
