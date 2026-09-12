// The BullMQ 'failed' hook for agent_turn, against a recording `sql` double.
// Nothing is mocked below the hook: `markOutboxFailed` and
// `failTurnIfNonTerminal` are the real functions, so the statements and their
// ORDER are the assertion.
import { describe, it, expect, vi } from 'vitest';
import type { Job } from 'bullmq';
import { TURN_FAILURE_REASON } from '@/lib/agents/operator/schema';
import type { AgentTurnPayload } from '@/lib/shared/worker-types';

import { handleAgentTurnFailed } from '../failed-hook';

type Recorded = { text: string; values: unknown[] };

/** STATEMENTS, not every tagged-template call: `markOutboxFailed` composes its
 * WHERE from the shared `dispatchedRow` FRAGMENT, which is itself a tagged
 * template and is indistinguishable from a statement at this seam. Filtering on
 * a leading SQL verb separates the two. */
const statementsOf = (calls: readonly Recorded[]): Recorded[] =>
  calls.filter((call) => /^\s*(?:UPDATE|SELECT|INSERT|DELETE)\b/i.test(call.text));

/** `count` is what the outbox CAS returns: 1 = this dispatch still owns the
 * row, 0 = a newer attempt superseded it. */
function makeSql(calls: Recorded[], count = 1) {
  const record = (...args: unknown[]) => {
    const [first] = args;
    if (Array.isArray(first) && Object.prototype.hasOwnProperty.call(first, 'raw')) {
      const strings = first as unknown as TemplateStringsArray;
      calls.push({ text: strings.join(' ? '), values: args.slice(1) });
      return Promise.resolve(Object.assign([], { count }));
    }
    return { __helper: first };
  };
  return Object.assign(record, {
    begin: async (cb: (tx: unknown) => Promise<unknown>) =>
      cb(Object.assign(record, { json: (v: unknown) => v })),
    json: (v: unknown) => v,
  });
}

const payload: AgentTurnPayload = {
  turn_id: '00000000-0000-7000-8000-000000000011',
  account_id: '00000000-0000-7000-8000-00000000ac01',
  conversation_id: '00000000-0000-7000-8000-00000000c001',
  outbox_id: '00000000-0000-7000-8000-00000000ob01',
  outbox_attempt: 3,
};

function jobFor(attemptsMade: number, attempts = 5): Job<AgentTurnPayload> {
  return {
    id: `job-${payload.turn_id}`,
    data: payload,
    opts: { attempts },
    attemptsMade,
  } as unknown as Job<AgentTurnPayload>;
}

describe('agent_turn failed hook', () => {
  it('writes nothing until the retry ladder is exhausted', async () => {
    // The Worker emits 'failed' after moveToFailed() incremented attemptsMade
    // to INCLUDE the failing attempt, so with attempts=5 only 5/5 is terminal.
    // Every earlier failure is a retry still in flight: the outbox row must
    // stay `dispatched` and the turn must stay claimable.
    for (const attemptsMade of [1, 2, 3, 4]) {
      const calls: Recorded[] = [];
      await handleAgentTurnFailed(makeSql(calls) as never, jobFor(attemptsMade), new Error('boom'));
      expect(statementsOf(calls), `attempt ${attemptsMade}/5`).toHaveLength(0);
    }

    // A missing job is not an exhaustion either.
    const none: Recorded[] = [];
    await handleAgentTurnFailed(makeSql(none) as never, undefined, new Error('boom'));
    expect(statementsOf(none)).toHaveLength(0);

    // `attempts` unset means one attempt, so the first failure IS terminal.
    const single: Recorded[] = [];
    await handleAgentTurnFailed(
      makeSql(single) as never,
      { id: 'job-1', data: payload, opts: {}, attemptsMade: 1 } as unknown as Job<AgentTurnPayload>,
      new Error('boom'),
    );
    expect(statementsOf(single)).toHaveLength(2);
  });

  it('on exhaustion runs the outbox CAS FIRST and only then fails the turn, in one transaction', async () => {
    const calls: Recorded[] = [];
    class ProviderTimeout extends Error { override name = 'ProviderTimeout'; }

    await handleAgentTurnFailed(makeSql(calls) as never, jobFor(5), new ProviderTimeout('slow'));

    const statements = statementsOf(calls);
    expect(statements).toHaveLength(2);
    // THE ORDER IS THE CONTRACT. `markOutboxFailed` matches only a row still
    // `dispatched` at exactly this attempt, so it answers the question that has
    // to come first: does this exhausted dispatch still own the row? The
    // watchdog may have re-dispatched while this job burned its last retry.
    expect(statements[0]!.text).toContain('UPDATE job_outbox');
    expect(statements[1]!.text).toContain('UPDATE agent_turns');

    // The error class is BOUNDED and carries no message — never provider text.
    expect(statements[0]!.values).toContain('agent_turn_exhausted:ProviderTimeout');
    expect(calls.some((call) => call.values.includes(payload.outbox_id))).toBe(true);
    expect(calls.some((call) => call.values.includes(payload.outbox_attempt))).toBe(true);
    expect(statements[0]!.values.some((v) => typeof v === 'string' && v.includes('slow'))).toBe(false);

    // The turn transition is account-scoped and status-guarded, not fenced on a
    // token: the hook runs after the processor is gone and holds no claim.
    expect(statements[1]!.values).toContain(TURN_FAILURE_REASON.EXHAUSTED);
    expect(statements[1]!.values).toContain(payload.turn_id);
    expect(statements[1]!.values).toContain(payload.account_id);
    expect(statements[1]!.text).toContain('account_id');
    expect(statements[1]!.text).toContain('status IN');
  });

  it('writes nothing when a newer dispatch has superseded this one', async () => {
    // count = 0: the CAS matched no row, so this exhausted job lost ownership.
    // A newer attempt may be running right now, or may already have completed
    // the turn — failing it from here would kill that live attempt's work.
    const calls: Recorded[] = [];
    await handleAgentTurnFailed(makeSql(calls, 0) as never, jobFor(5), new Error('boom'));

    const statements = statementsOf(calls);
    expect(statements).toHaveLength(1);
    expect(statements[0]!.text).toContain('UPDATE job_outbox');
    expect(calls.some((call) => call.text.includes('UPDATE agent_turns'))).toBe(false);
  });

  it('swallows a transaction failure rather than letting it escape the hook', async () => {
    // The transaction rolled back as a unit, so the row stays `dispatched` and
    // the watchdog can reclaim it. A throw here would surface as an unhandled
    // rejection in the Worker's own event handler.
    const exploding = Object.assign(
      () => {
        throw new Error('connection reset');
      },
      { begin: () => Promise.reject(new Error('connection reset')), json: (v: unknown) => v },
    );
    await expect(
      handleAgentTurnFailed(exploding as never, jobFor(5), new Error('boom')),
    ).resolves.toBeUndefined();
  });

  it('does not log owner text or the provider message', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const calls: Recorded[] = [];
      await handleAgentTurnFailed(makeSql(calls, 0) as never, jobFor(5), new Error('the owner said X'));
      const logged = [...errorSpy.mock.calls, ...logSpy.mock.calls].flat().join(' ');
      expect(logged).not.toContain('the owner said X');
      expect(logged).toContain(payload.turn_id);
    } finally {
      errorSpy.mockRestore();
      logSpy.mockRestore();
    }
  });
});
