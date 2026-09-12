// Unit seams for src/lib/agents/operator/turns.ts. The live proofs for
// createTurn's transaction and for the claim/fence protocol are T7's
// turn-worker.integration.test.ts; this file holds the mocked-sql assertions
// that T4 and T5 fill in.
import { describe, expect, it, vi } from 'vitest';

vi.mock('uuid', () => ({ v7: vi.fn(() => 'generated-uuid') }));

import { claimTurn, createTurn } from '../turns';

interface RecordedCall {
  text: string;
  values: unknown[];
}

/**
 * A recording `sql` double in the shape createTurn actually uses: a tagged
 * template that records `{ text, values }`, a `.json` identity (the outbox
 * helper binds its payload through `tx.json`), and a `.begin` that runs the
 * callback with the same tag. Statement results are routed by text so the
 * assertions read the ORDER of the calls rather than a fixed index.
 */
function makeRecordingSql(calls: RecordedCall[], nextSequence: number) {
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?').replace(/\s+/g, ' ').trim();
    calls.push({ text, values });
    if (text.includes('FROM businesses')) return Promise.resolve([{ id: 'location-1' }]);
    if (text.includes('FOR UPDATE')) return Promise.resolve([{ id: 'conversation-1' }]);
    if (text.includes('next_sequence')) return Promise.resolve([{ next_sequence: nextSequence }]);
    return Promise.resolve([]);
  };
  const sql = Object.assign(tag, {
    json: (value: unknown) => value,
    begin: (callback: (tx: typeof sql) => Promise<unknown>) => callback(sql),
  });
  return sql;
}

/** The claim's lease, in the units `claimTurn` binds it in. */
const LEASE_SECONDS = 180;

const INPUT = {
  accountId: '00000000-0000-7000-8000-00000000ac01',
  actorUserId: '00000000-0000-7000-8000-00000000u001',
  conversationId: '00000000-0000-7000-8000-00000000c001',
  clientTurnKey: '00000000-0000-7000-8000-000000009001',
  locationId: '00000000-0000-7000-8000-00000000b101',
  text: 'Make my replies warmer.',
};

describe('operator turns', () => {
  it('createTurn assigns the next sequence under the conversation row lock', async () => {
    const calls: RecordedCall[] = [];
    // The recording double stands in for postgres.Sql; `as never` keeps the
    // no-`any` rule intact while satisfying createTurn's parameter type.
    const sql = makeRecordingSql(calls, 4) as never;

    const result = await createTurn(sql, INPUT);

    expect(result).toEqual({
      kind: 'created',
      conversationId: INPUT.conversationId,
      turnId: 'generated-uuid',
    });

    const indexOf = (needle: string) => calls.findIndex((call) => call.text.includes(needle));
    const lockIndex = indexOf('FOR UPDATE');
    const turnKeyIndex = calls.findIndex(
      (call) => call.text.includes('client_turn_key = ?') && call.text.includes('SELECT id, conversation_id'),
    );
    const sequenceIndex = indexOf('next_sequence');
    const insertIndex = indexOf('INSERT INTO agent_turns');

    // THE ORDER IS THE ASSERTION (plan C8/F6): the conversation row lock is
    // taken BEFORE the turn-key idempotency read, and the sequence is read
    // after the lock and before the INSERT that consumes it. Reading the turn
    // key first would let two concurrent identical POSTs both miss `existing`
    // and turn the replay the constraint exists to absorb into a 500.
    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(lockIndex).toBeLessThan(turnKeyIndex);
    expect(turnKeyIndex).toBeLessThan(sequenceIndex);
    expect(sequenceIndex).toBeLessThan(insertIndex);

    const sequenceCall = calls[sequenceIndex]!;
    expect(sequenceCall.text).toContain('COALESCE(MAX(sequence), 0) + 1');
    // Invariant #9: the sequence read is account-scoped, not conversation-only.
    expect(sequenceCall.values).toContain(INPUT.conversationId);
    expect(sequenceCall.values).toContain(INPUT.accountId);

    // The computed sequence is what the INSERT binds, and `owner_text` is bound
    // VERBATIM alongside it.
    const insertCall = calls[insertIndex]!;
    expect(insertCall.values).toContain(4);
    expect(insertCall.values).toContain(INPUT.text);
    expect(insertCall.values).toContain(INPUT.accountId);

    // Invariant #2: the outbox row rides the SAME transaction as the turn
    // insert, after it.
    const outboxIndex = indexOf('INSERT INTO job_outbox');
    expect(outboxIndex).toBeGreaterThan(insertIndex);

    // Invariant #9: every statement over the new tables (and the tenant-scoped
    // location check) carries an account_id predicate or column — none of them
    // is ever touched account-blind. `job_outbox` is excluded on purpose: it is
    // not one of the new tables and carries its account id inside the payload.
    const tenantScoped = calls.filter((call) => !call.text.includes('job_outbox'));
    expect(tenantScoped.length).toBe(calls.length - 1);
    for (const call of tenantScoped) {
      expect(call.text).toContain('account_id');
    }
  });

  it('claimTurn binds the lease predicate that makes the Turn claim exclusive', async () => {
    const calls: RecordedCall[] = [];
    const sql = makeRecordingSql(calls, 1) as never;

    await claimTurn(sql, {
      turnId: '00000000-0000-7000-8000-000000000011',
      accountId: INPUT.accountId,
      leaseSeconds: LEASE_SECONDS,
    });

    const claim = calls.find((call) => call.text.includes('UPDATE agent_turns'));
    expect(claim).toBeDefined();
    // **Turn claim** — the UPDATE one dispatch wins, bounded by a 180 s lease.
    // **Fenced completion** (the terminal UPDATE fenced on `attempt_token`) is a
    // SEPARATE guard: it stops a stale attempt from WRITING, and only this
    // predicate stops a second attempt from SPENDING a second cost-guarded
    // model call. The live proof is turn-worker.integration.test.ts; this is the
    // cheap text oracle that the arm is still in the statement at all.
    expect(claim!.text).toContain('claimed_at IS NULL');
    expect(claim!.text).toContain("INTERVAL '1 second'");
    expect(claim!.values).toContain(LEASE_SECONDS);
    // Invariant #9: the claim is account-scoped, never turn-id alone.
    expect(claim!.values).toContain(INPUT.accountId);
  });
});
