import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql, TransactionSql } from 'postgres';
import type { EscalationStatus } from '../types';

const { recordOutcomeMock } = vi.hoisted(() => ({
  recordOutcomeMock: vi.fn(),
}));
vi.mock('@/lib/agents/run-spine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/agents/run-spine')>()),
  recordOutcome: recordOutcomeMock,
}));

import { acknowledgeEscalation, resolveEscalation } from '../transitions';

interface RecordedCall {
  text: string;
  values: unknown[];
}

/**
 * Tagged-template stub with a FIFO result queue shared between the outer
 * `sql` and the `tx` handed to `sql.begin`. Outer calls (the scope pre-check)
 * land in `calls`; in-transaction calls land in `txCalls` so lock ORDER is
 * assertable. `begin` returns the callback's value — transitions return their
 * results from inside the tx.
 */
function makeSqlStub(results: unknown[][]) {
  const queue = [...results];
  const calls: RecordedCall[] = [];
  const txCalls: RecordedCall[] = [];
  const recorder = (target: RecordedCall[]) =>
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      target.push({ text: strings.join('?'), values });
      const rows = queue.shift() ?? [];
      return Promise.resolve(Object.assign(rows, { count: rows.length }));
    };
  const tx = recorder(txCalls) as never as TransactionSql;
  const beginMock = vi.fn(
    async (callback: (transaction: TransactionSql) => unknown) => callback(tx),
  );
  const sql = Object.assign(recorder(calls), { begin: beginMock }) as never as Sql;
  return { sql, tx, calls, txCalls, beginMock };
}

const input = { escalationId: 'esc-1', accountId: 'acc-1' };

function escalationRow(status: EscalationStatus, agentRunId: string | null = 'run-1') {
  return {
    id: 'esc-1',
    status,
    account_id: 'acc-1',
    business_id: 'biz-1',
    review_id: 'rev-1',
    agent_run_id: agentRunId,
  };
}

const preCheckRow = { review_id: 'rev-1' };

beforeEach(() => {
  recordOutcomeMock.mockReset();
});

describe('acknowledgeEscalation', () => {
  it('escalated → acknowledged: updates status + acknowledged_at, returns { ok: true, noop: false }', async () => {
    const { sql, calls, txCalls } = makeSqlStub([
      [preCheckRow],
      [{ id: 'rev-1' }],
      [escalationRow('escalated')],
      [],
    ]);
    const result = await acknowledgeEscalation(sql, input);
    expect(result).toEqual({ ok: true, status: 'acknowledged', noop: false });
    expect(calls[0]!.text).toContain('FROM review_escalations');
    expect(calls[0]!.text).toContain('account_id =');
    const update = txCalls[2]!;
    expect(update.text).toContain('UPDATE review_escalations');
    expect(update.text).toContain('acknowledged_at = NOW()');
    expect(update.text).toContain('updated_at = NOW()');
    // Invariant #8: the write itself is account-scoped, not just the lock.
    expect(update.text).toContain('account_id =');
    expect(update.values).toContain('acc-1');
  });

  it('acknowledged → acknowledge again: no UPDATE issued, returns { ok: true, noop: true }', async () => {
    const { sql, txCalls } = makeSqlStub([
      [preCheckRow],
      [{ id: 'rev-1' }],
      [escalationRow('acknowledged')],
    ]);
    const result = await acknowledgeEscalation(sql, input);
    expect(result).toEqual({ ok: true, status: 'acknowledged', noop: true });
    expect(txCalls).toHaveLength(2);
    expect(txCalls.some((call) => call.text.includes('UPDATE review_escalations'))).toBe(false);
  });

  it('resolved → acknowledge: returns { ok: false, code: "invalid_transition" }, no UPDATE', async () => {
    const { sql, txCalls } = makeSqlStub([
      [preCheckRow],
      [{ id: 'rev-1' }],
      [escalationRow('resolved')],
    ]);
    const result = await acknowledgeEscalation(sql, input);
    expect(result).toEqual({ ok: false, code: 'invalid_transition' });
    expect(txCalls.some((call) => call.text.includes('UPDATE review_escalations'))).toBe(false);
  });

  it('unknown id or wrong account: returns { ok: false, code: "not_found" } without taking locks', async () => {
    const { sql, beginMock } = makeSqlStub([[]]);
    const result = await acknowledgeEscalation(sql, input);
    expect(result).toEqual({ ok: false, code: 'not_found' });
    expect(beginMock).not.toHaveBeenCalled();
  });

  it('locks the reviews row as the transaction FIRST statement, before the escalation row', async () => {
    const { sql, txCalls } = makeSqlStub([
      [preCheckRow],
      [{ id: 'rev-1' }],
      [escalationRow('escalated')],
      [],
    ]);
    await acknowledgeEscalation(sql, input);
    expect(txCalls[0]!.text).toContain('FROM reviews');
    expect(txCalls[0]!.text).toContain('FOR UPDATE');
    expect(txCalls[0]!.values).toContain('rev-1');
    expect(txCalls[1]!.text).toContain('FROM review_escalations');
    expect(txCalls[1]!.text).toContain('FOR UPDATE');
    expect(txCalls[1]!.text).toContain('account_id =');
  });
});

describe('resolveEscalation', () => {
  it('escalated → resolved: stamps BOTH acknowledged_at and resolved_at', async () => {
    const { sql, txCalls } = makeSqlStub([
      [preCheckRow],
      [{ id: 'rev-1' }],
      [escalationRow('escalated')],
      [],
    ]);
    const result = await resolveEscalation(sql, input);
    expect(result).toEqual({ ok: true, status: 'resolved', noop: false });
    const update = txCalls[2]!;
    expect(update.text).toContain('UPDATE review_escalations');
    expect(update.text).toContain('acknowledged_at = COALESCE(acknowledged_at, NOW())');
    expect(update.text).toContain('resolved_at = NOW()');
    expect(update.text).toContain('updated_at = NOW()');
    // Invariant #8: the write itself is account-scoped, not just the lock.
    expect(update.text).toContain('account_id =');
    expect(update.values).toContain('acc-1');
  });

  it('acknowledged → resolved: preserves the existing acknowledged_at (COALESCE) and stamps resolved_at', async () => {
    const { sql, txCalls } = makeSqlStub([
      [preCheckRow],
      [{ id: 'rev-1' }],
      [escalationRow('acknowledged')],
      [],
    ]);
    const result = await resolveEscalation(sql, input);
    expect(result).toEqual({ ok: true, status: 'resolved', noop: false });
    const update = txCalls[2]!;
    // COALESCE keeps the original acknowledgement timestamp; only resolved_at is new.
    expect(update.text).toContain('acknowledged_at = COALESCE(acknowledged_at, NOW())');
    expect(update.text).toContain('resolved_at = NOW()');
    expect(update.text).toContain('updated_at = NOW()');
  });

  it('resolved → resolve again: noop success, recordOutcome NOT called', async () => {
    const { sql, txCalls } = makeSqlStub([
      [preCheckRow],
      [{ id: 'rev-1' }],
      [escalationRow('resolved')],
    ]);
    const result = await resolveEscalation(sql, input);
    expect(result).toEqual({ ok: true, status: 'resolved', noop: true });
    expect(txCalls.some((call) => call.text.includes('UPDATE review_escalations'))).toBe(false);
    expect(recordOutcomeMock).not.toHaveBeenCalled();
  });

  it('records escalation_resolved via the stored agent_run_id (attributedAgent guardian)', async () => {
    const { sql, tx } = makeSqlStub([
      [preCheckRow],
      [{ id: 'rev-1' }],
      [escalationRow('acknowledged', 'run-7')],
      [],
    ]);
    await resolveEscalation(sql, input);
    expect(recordOutcomeMock).toHaveBeenCalledTimes(1);
    expect(recordOutcomeMock).toHaveBeenCalledWith(tx, {
      runId: 'run-7',
      accountId: 'acc-1',
      businessId: 'biz-1',
      attributedAgent: 'guardian',
      outcomeKind: 'escalation_resolved',
    });
  });

  it('skips recordOutcome when agent_run_id is null, still resolves the row', async () => {
    const { sql, txCalls } = makeSqlStub([
      [preCheckRow],
      [{ id: 'rev-1' }],
      [escalationRow('escalated', null)],
      [],
    ]);
    const result = await resolveEscalation(sql, input);
    expect(result).toEqual({ ok: true, status: 'resolved', noop: false });
    expect(recordOutcomeMock).not.toHaveBeenCalled();
    expect(txCalls[2]!.text).toContain('UPDATE review_escalations');
  });
});
