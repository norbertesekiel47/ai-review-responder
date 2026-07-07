import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  AGENT_PERSONAS,
  AGENT_RUN_KINDS,
  AGENT_OUTCOME_KINDS,
  STEP_PERSONA,
  personaForStep,
  startOrGetActiveRun,
} from '../run-spine';

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
