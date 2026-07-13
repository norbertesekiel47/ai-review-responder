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
  findActiveReviewRun,
  recordStep,
  recordOutcome,
  completeRun,
} from '../run-spine';

describe('run-spine constants', () => {
  it('exposes the three customer personas plus system', () => {
    expect(AGENT_PERSONAS).toEqual(['reply', 'guardian', 'insights', 'system']);
  });

  it('run kinds match migration 071 CHECK', () => {
    expect(AGENT_RUN_KINDS).toEqual(['review_handler', 'weekly_insights']);
  });

  it('outcome kinds match the migration 074 CHECK (071 superset + reply_vetoed_by_owner)', () => {
    expect(AGENT_OUTCOME_KINDS).toEqual([
      'reply_drafted', 'reply_posted', 'reply_auto_posted',
      'reply_approved_no_edit', 'reply_edited_by_owner', 'reply_vetoed_by_owner',
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
    expect(personaForStep('triage')).toBe('guardian');
    expect(personaForStep('escalation_raised')).toBe('guardian');
    expect(personaForStep('escalation_sent')).toBe('guardian');
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
