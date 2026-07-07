import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  AGENT_PERSONAS,
  AGENT_RUN_KINDS,
  AGENT_OUTCOME_KINDS,
  STEP_PERSONA,
  personaForStep,
  startOrGetActiveRun,
  recordStep,
  recordOutcome,
  completeRun,
} from '../run-spine';

/** Mocked tx with the Postgres.js `.json()` surface domain modules use (invariant #15). */
type MockTx = ReturnType<typeof vi.fn> & { json: ReturnType<typeof vi.fn> };

function makeMockTx(): MockTx {
  return Object.assign(vi.fn(), { json: vi.fn((value: unknown) => value) }) as MockTx;
}

function withCount<T extends unknown[]>(arr: T, count: number): T & { count: number } {
  return Object.assign(arr, { count });
}

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

describe('recordStep', () => {
  let tx: MockTx;
  beforeEach(() => { tx = makeMockTx(); });

  it('locks the run, computes the next index, and inserts with the mapped persona', async () => {
    tx.mockResolvedValueOnce(withCount([{ ok: 1 }], 1));         // lock (own statement)
    tx.mockResolvedValueOnce(withCount([{ next_index: 3 }], 1)); // MAX(step_index)+1 after lock
    tx.mockResolvedValueOnce(withCount([], 0));                  // INSERT step

    await recordStep(tx as never, {
      runId: 'run-1',
      stepKey: 'draft_generated',
      detail: { response_id: 'resp-1', version: 1 },
      latencyMs: 1200,
    });

    const lockSql = (tx.mock.calls[0]?.[0] as TemplateStringsArray | undefined)?.join('?') ?? '';
    expect(lockSql).toContain('FOR UPDATE');

    const nextIndexSql = (tx.mock.calls[1]?.[0] as TemplateStringsArray | undefined)?.join('?') ?? '';
    expect(nextIndexSql).toContain('MAX(step_index)');
    expect(nextIndexSql).not.toContain('FOR UPDATE'); // fresh snapshot AFTER the lock statement

    const insertSql = (tx.mock.calls[2]?.[0] as TemplateStringsArray | undefined)?.join('?') ?? '';
    expect(insertSql).toContain('INSERT INTO agent_run_steps');
    const params = (tx.mock.calls[2] as unknown[]).slice(1);
    expect(params).toContain('draft_generated');
    expect(params).toContain('reply');   // persona from STEP_PERSONA, not caller input
    expect(params).toContain(3);         // next_index from the post-lock read
  });

  it('throws when the run row does not exist', async () => {
    tx.mockResolvedValueOnce(withCount([], 0));
    await expect(recordStep(tx as never, { runId: 'missing', stepKey: 'policy_gate' }))
      .rejects.toThrow(/run not found/i);
  });
});

describe('recordOutcome', () => {
  let tx: MockTx;
  beforeEach(() => { tx = makeMockTx(); });

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
  let tx: MockTx;
  beforeEach(() => { tx = makeMockTx(); });

  it('flips a running run to a terminal status and stamps ended_at', async () => {
    tx.mockResolvedValueOnce(withCount([{ id: 'run-1' }], 1));

    await completeRun(tx as never, 'run-1', 'completed');

    const sqlText = (tx.mock.calls[0]?.[0] as TemplateStringsArray | undefined)?.join('?') ?? '';
    expect(sqlText).toContain('UPDATE agent_runs');
    expect(sqlText).toContain("status = 'running'"); // only running runs transition
    expect(sqlText).toContain('ended_at = NOW()');
    expect(sqlText).toContain('RETURNING id');
    expect(tx).toHaveBeenCalledTimes(1); // updated → no follow-up existence probe
  });

  it('is a no-op (not an error) when the run is already terminal', async () => {
    tx.mockResolvedValueOnce(withCount([], 0));                        // UPDATE hit nothing
    tx.mockResolvedValueOnce(withCount([{ status: 'completed' }], 1)); // probe: exists, terminal
    await expect(completeRun(tx as never, 'run-1', 'failed', { reason: 'llm_terminal' }))
      .resolves.toBeUndefined();
  });

  it('throws when the run does not exist at all', async () => {
    tx.mockResolvedValueOnce(withCount([], 0)); // UPDATE hit nothing
    tx.mockResolvedValueOnce(withCount([], 0)); // probe: no row
    await expect(completeRun(tx as never, 'missing', 'completed'))
      .rejects.toThrow(/run not found/i);
  });
});
