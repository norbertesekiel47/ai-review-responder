import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSql, sqlReturnQueue, sqlCalls, resetMockSql, mkTaggedResult, mockLogger } =
  await vi.hoisted(async () => {
    const helpers = await import('../../../__tests__/helpers/mock-sql');
    return {
      ...helpers.createMockSql(),
      mkTaggedResult: helpers.mkTaggedResult,
      mockLogger: helpers.mockWorkerLogger(),
    };
  });

vi.mock('@/lib/db/server', () => ({ sql: mockSql }));
vi.mock('uuid', () => ({ v7: vi.fn(() => 'event-1') }));
vi.mock('@/lib/shared/logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/shared/logger')>()),
  createWorkerLogger: () => mockLogger,
}));

// #1009 surface amendment 1 of 2 — the Governor cycle's Sentry sink.
//
// `suspendAccountAutonomy` has two production callers and they reach Sentry by
// DIFFERENT routes. `JudgeWorker` is a BullMQ worker, so `attachJobFailureSink`
// raises an issue on the terminal attempt. `AutonomyGovernorScheduler` is NOT a
// BullMQ worker — it is a guarded poll whose per-candidate `catch` emitted
// `logger.error` alone. This slice makes a ledger CHECK violation a new way to
// reach that gap, and the failure mode is bad: the transaction rolls back, the
// account stays UN-SUSPENDED, the cycle advances its cursor, and the same thing
// happens silently every fifteen minutes.
const sentryStub = vi.hoisted(() => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  addBreadcrumb: vi.fn(),
}));

vi.mock('@sentry/node', () => sentryStub);

import {
  DEFAULT_GOVERNOR_INTERVAL_MS,
  GOVERNOR_CYCLE_TIMEOUT_MS,
  type GovernorScanCursor,
  getGovernorIntervalMs,
  runAutonomyGovernorCycle,
} from '../AutonomyGovernorScheduler';
import { resetWorkerConfigForTests } from '@/lib/config/worker';

describe('AutonomyGovernorScheduler cycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // `clearAllMocks` clears call history but KEEPS implementations, so a
    // throwing capture installed by the containment case would leak into every
    // later one. `mockReset` is the form that drops it.
    sentryStub.captureException.mockReset();
    sentryStub.captureMessage.mockReset();
    resetMockSql();
    resetWorkerConfigForTests();
    delete process.env.GOVERNOR_ENABLED;
    delete process.env.GOVERNOR_INTERVAL_MS;
  });

  afterEach(() => {
    resetWorkerConfigForTests();
    delete process.env.GOVERNOR_ENABLED;
    delete process.env.GOVERNOR_INTERVAL_MS;
  });

  it('is inert while the governor flag is off', async () => {
    await runAutonomyGovernorCycle(mockSql as never);

    expect(sqlCalls).toHaveLength(0);
    expect(mockSql.begin).not.toHaveBeenCalled();
  });

  it('suspends a breached account in its own cycle-free transaction with rate evidence', async () => {
    process.env.GOVERNOR_ENABLED = 'true';
    sqlReturnQueue.push(
      mkTaggedResult([{
        account_id: 'account-1',
        window_start: new Date('2026-07-10T00:00:00.000Z'),
      }]),
      mkTaggedResult([{
        account_id: 'account-1',
        edited_count: 3,
        approved_count: 2,
        vetoed_count: 0,
        auto_posted_count: 5,
      }]),
      mkTaggedResult([{ account_id: 'account-1', pass_count: 5, warn_count: 0, flag_count: 0 }]),
      mkTaggedResult([{ id: 'account-1' }]),
      mkTaggedResult([{
        location_id: null,
        persona: 'reply',
        action_class: 'posting',
        auto_approve_min_star: 5,
        suspended_at: null,
      }]),
      mkTaggedResult([]),
      mkTaggedResult([{ id: 'account-1' }]),
      mkTaggedResult([{ id: 'policy-1' }]),
      mkTaggedResult([]),
      mkTaggedResult([]),
      mkTaggedResult([]),
    );

    await runAutonomyGovernorCycle(mockSql as never);

    expect(mockSql.begin).toHaveBeenCalledOnce();
    expect(mockSql.json).toHaveBeenCalledWith({
      trigger: 'governor_edit_rate',
      suspension_event_id: 'event-1',
      evidence: { rate: 0.6, numer: 3, denom: 5, windowDays: 7 },
    });
    expect(sqlCalls.some((call) => call.text.includes('INSERT INTO auto_approval_policies')))
      .toBe(true);
    expect(sqlCalls.some((call) => call.values.includes('autonomy_suspended_notice')))
      .toBe(true);
    expect(sqlCalls.some((call) => call.values.includes('autonomy_admin_alert')))
      .toBe(true);
    expect(sqlCalls.some((call) => call.text.includes('FOR UPDATE'))).toBe(true);
    const allSql = sqlCalls.map((call) => call.text).join('\n');
    expect(allSql).not.toMatch(/\b(?:FROM|UPDATE|INSERT INTO)\s+(?:reviews|responses|agent_runs)\b/);
  });

  it('does not suspend when the account is disarmed after scan and rate computation', async () => {
    process.env.GOVERNOR_ENABLED = 'true';
    sqlReturnQueue.push(
      mkTaggedResult([{
        account_id: 'account-1',
        window_start: new Date('2026-07-10T00:00:00.000Z'),
      }]),
      mkTaggedResult([{
        account_id: 'account-1',
        edited_count: 3,
        approved_count: 2,
        vetoed_count: 0,
        auto_posted_count: 5,
      }]),
      mkTaggedResult([{ account_id: 'account-1', pass_count: 5, warn_count: 0, flag_count: 0 }]),
      mkTaggedResult([{ id: 'account-1' }]),
      mkTaggedResult([{
        location_id: null,
        persona: 'reply',
        action_class: 'posting',
        auto_approve_min_star: null,
        suspended_at: null,
      }]),
    );

    await runAutonomyGovernorCycle(mockSql as never, { afterAccountId: null });

    expect(mockSql.begin).toHaveBeenCalledOnce();
    expect(sqlCalls.some((call) => call.text.includes('INSERT INTO auto_approval_policies')))
      .toBe(false);
    expect(sqlCalls.some((call) => call.values.includes('autonomy_suspended'))).toBe(false);
    expect(sqlCalls.some((call) => call.values.includes('autonomy_suspended_notice')))
      .toBe(false);
    expect(sqlCalls.some((call) => call.values.includes('autonomy_admin_alert')))
      .toBe(false);
  });

  it('rotates past a full healthy page and evaluates the next account on the following cycle', async () => {
    process.env.GOVERNOR_ENABLED = 'true';
    const windowStart = new Date('2026-07-10T00:00:00.000Z');
    const firstPage = Array.from({ length: 50 }, (_, index) => ({
      account_id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      window_start: windowStart,
    }));
    const laterAccount = '00000000-0000-4000-8000-000000000051';
    const cursor: GovernorScanCursor = { afterAccountId: null };

    sqlReturnQueue.push(mkTaggedResult(firstPage));
    for (let index = 0; index < firstPage.length; index++) {
      sqlReturnQueue.push(
        mkTaggedResult([{
          account_id: firstPage[index]!.account_id,
          edited_count: 0,
          approved_count: 0,
          vetoed_count: 0,
          auto_posted_count: 0,
        }]),
        mkTaggedResult([{
          account_id: firstPage[index]!.account_id,
          pass_count: 0,
          warn_count: 0,
          flag_count: 0,
        }]),
      );
    }

    await runAutonomyGovernorCycle(mockSql as never, cursor);
    expect(cursor.afterAccountId).toBe(firstPage.at(-1)!.account_id);
    expect(mockSql.begin).not.toHaveBeenCalled();

    sqlReturnQueue.push(
      mkTaggedResult([{ account_id: laterAccount, window_start: windowStart }]),
      mkTaggedResult([{
        account_id: laterAccount,
        edited_count: 3,
        approved_count: 2,
        vetoed_count: 0,
        auto_posted_count: 0,
      }]),
      mkTaggedResult([{
        account_id: laterAccount, pass_count: 0, warn_count: 0, flag_count: 0,
      }]),
      mkTaggedResult([{ id: laterAccount }]),
      mkTaggedResult([{
        location_id: null,
        persona: 'reply',
        action_class: 'posting',
        auto_approve_min_star: 5,
        suspended_at: null,
      }]),
      mkTaggedResult([]),
      mkTaggedResult([{ id: laterAccount }]),
      mkTaggedResult([{ id: 'policy-later' }]),
      mkTaggedResult([]),
      mkTaggedResult([]),
      mkTaggedResult([]),
    );

    await runAutonomyGovernorCycle(mockSql as never, cursor);

    expect(cursor.afterAccountId).toBe(laterAccount);
    expect(mockSql.begin).toHaveBeenCalledOnce();
    expect(mockSql.json).toHaveBeenCalledWith(expect.objectContaining({
      trigger: 'governor_edit_rate',
      evidence: { rate: 0.6, numer: 3, denom: 5, windowDays: 7 },
    }));
    const candidateScans = sqlCalls.filter((call) =>
      call.text.includes('FROM auto_approval_policies armed'));
    expect(candidateScans).toHaveLength(2);
    expect(candidateScans[1]!.values).toContain(firstPage.at(-1)!.account_id);
  });

  it('advances past a poison candidate, contains its failure, and completes the cycle', async () => {
    process.env.GOVERNOR_ENABLED = 'true';
    const poisonError = new Error('synthetic rate-query failure');
    const rejected = Promise.reject(poisonError);
    rejected.catch(() => {});
    const windowStart = new Date('2026-07-10T00:00:00.000Z');
    const poisonAccount = '00000000-0000-4000-8000-000000000060';
    const nextAccount = '00000000-0000-4000-8000-000000000061';
    const cursor: GovernorScanCursor = { afterAccountId: null };
    sqlReturnQueue.push(
      mkTaggedResult([{ account_id: poisonAccount, window_start: windowStart }]),
      rejected,
    );

    await expect(runAutonomyGovernorCycle(mockSql as never, cursor))
      .resolves.toBeUndefined();
    expect(cursor.afterAccountId).toBe(poisonAccount);
    expect(mockLogger.error).toHaveBeenCalledOnce();
    expect(mockLogger.error).toHaveBeenCalledWith('autonomy_governor candidate-failed', {
      account_id: poisonAccount,
      error_name: 'Error',
    });

    sqlReturnQueue.push(
      mkTaggedResult([{ account_id: nextAccount, window_start: windowStart }]),
      mkTaggedResult([{
        account_id: nextAccount,
        edited_count: 0,
        approved_count: 0,
        vetoed_count: 0,
        auto_posted_count: 0,
      }]),
      mkTaggedResult([{
        account_id: nextAccount, pass_count: 0, warn_count: 0, flag_count: 0,
      }]),
    );

    await expect(runAutonomyGovernorCycle(mockSql as never, cursor)).resolves.toBeUndefined();
    expect(cursor.afterAccountId).toBe(nextAccount);
    const candidateScans = sqlCalls.filter((call) =>
      call.text.includes('FROM auto_approval_policies armed'));
    expect(candidateScans).toHaveLength(2);
    expect(candidateScans[1]!.values).toContain(poisonAccount);
  });

  it('still evaluates the surrounding candidates when the middle one throws', async () => {
    process.env.GOVERNOR_ENABLED = 'true';
    const rejected = Promise.reject(new Error('synthetic mid-batch failure'));
    rejected.catch(() => {});
    const windowStart = new Date('2026-07-10T00:00:00.000Z');
    const accounts = [
      '00000000-0000-4000-8000-000000000070',
      '00000000-0000-4000-8000-000000000071',
      '00000000-0000-4000-8000-000000000072',
    ];
    const cursor: GovernorScanCursor = { afterAccountId: null };
    const healthyRates = (accountId: string) => [
      mkTaggedResult([{
        account_id: accountId,
        edited_count: 0,
        approved_count: 0,
        vetoed_count: 0,
        auto_posted_count: 0,
      }]),
      mkTaggedResult([{ account_id: accountId, pass_count: 0, warn_count: 0, flag_count: 0 }]),
    ];
    sqlReturnQueue.push(
      mkTaggedResult(accounts.map((accountId) => ({
        account_id: accountId,
        window_start: windowStart,
      }))),
      ...healthyRates(accounts[0]!),
      rejected,
      ...healthyRates(accounts[2]!),
    );

    await expect(runAutonomyGovernorCycle(mockSql as never, cursor)).resolves.toBeUndefined();

    expect(cursor.afterAccountId).toBe(accounts[2]);
    expect(mockSql.begin).not.toHaveBeenCalled();
    expect(mockLogger.error).toHaveBeenCalledOnce();
    expect(mockLogger.error).toHaveBeenCalledWith('autonomy_governor candidate-failed', {
      account_id: accounts[1],
      error_name: 'Error',
    });
    // Rate queries bind account ids as a ::uuid[] array parameter.
    const outcomeScans = sqlCalls.filter((call) =>
      call.values.some((value) => Array.isArray(value) && value.includes(accounts[2]!)));
    expect(outcomeScans.length).toBeGreaterThan(0);
  });

  it('uses the frozen cadence and deadline', () => {
    expect(DEFAULT_GOVERNOR_INTERVAL_MS).toBe(900_000);
    expect(GOVERNOR_CYCLE_TIMEOUT_MS).toBe(60_000);
    expect(getGovernorIntervalMs()).toBe(900_000);

    process.env.GOVERNOR_INTERVAL_MS = '120000';
    resetWorkerConfigForTests();
    expect(getGovernorIntervalMs()).toBe(120_000);

    process.env.GOVERNOR_INTERVAL_MS = 'invalid';
    resetWorkerConfigForTests();
    expect(getGovernorIntervalMs()).toBe(900_000);
  });

  // ── #1009 T4b: the Sentry sink inside the containment catch ───────────────
  //
  // One fixture, two cases. Both drive a breaching candidate whose suspension
  // transaction rejects on its FIRST statement — the shape a ledger CHECK
  // violation takes — followed by a healthy candidate that must still be
  // reached in the SAME pass.
  const seedFailingSuspensionThenHealthyCandidate = (
    poisonError: Error,
  ): { breachingAccount: string; nextAccount: string; cursor: GovernorScanCursor } => {
    const windowStart = new Date('2026-07-10T00:00:00.000Z');
    const breachingAccount = '00000000-0000-4000-8000-000000000080';
    const nextAccount = '00000000-0000-4000-8000-000000000081';
    const cursor: GovernorScanCursor = { afterAccountId: null };
    const rejected = Promise.reject(poisonError);
    rejected.catch(() => {});

    sqlReturnQueue.push(
      mkTaggedResult([
        { account_id: breachingAccount, window_start: windowStart },
        { account_id: nextAccount, window_start: windowStart },
      ]),
      // 3 edits over 5 auto-posts — the same breaching shape the suspension
      // case above uses, so this candidate really does reach the transaction.
      mkTaggedResult([{
        account_id: breachingAccount,
        edited_count: 3,
        approved_count: 2,
        vetoed_count: 0,
        auto_posted_count: 5,
      }]),
      mkTaggedResult([{
        account_id: breachingAccount, pass_count: 5, warn_count: 0, flag_count: 0,
      }]),
      // The first statement inside `sql.begin` rejects, so the whole suspension
      // transaction — policy, audit row and both notice outboxes — rolls back.
      rejected,
      mkTaggedResult([{
        account_id: nextAccount,
        edited_count: 0,
        approved_count: 0,
        vetoed_count: 0,
        auto_posted_count: 0,
      }]),
      mkTaggedResult([{ account_id: nextAccount, pass_count: 0, warn_count: 0, flag_count: 0 }]),
    );

    return { breachingAccount, nextAccount, cursor };
  };

  const expectReachedNextCandidate = (nextAccount: string, cursor: GovernorScanCursor): void => {
    // The failure really was a SUSPENSION failure: the cycle opened the
    // transaction rather than falling over at rate computation.
    expect(mockSql.begin).toHaveBeenCalledOnce();
    expect(cursor.afterAccountId).toBe(nextAccount);
    // Rate queries bind account ids as a ::uuid[] array parameter, so the
    // second candidate's presence there is proof the loop actually evaluated it
    // rather than merely walking the cursor past it.
    const outcomeScans = sqlCalls.filter((call) =>
      call.values.some((value) => Array.isArray(value) && value.includes(nextAccount)));
    expect(outcomeScans.length).toBeGreaterThan(0);
  };

  it('a suspension failure inside the Governor cycle reports a Sentry issue and the cycle continues to the next candidate', async () => {
    process.env.GOVERNOR_ENABLED = 'true';
    const ledgerError = new Error('refusal ledger rejected the write');
    const { breachingAccount, nextAccount, cursor } =
      seedFailingSuspensionThenHealthyCandidate(ledgerError);

    await expect(runAutonomyGovernorCycle(mockSql as never, cursor)).resolves.toBeUndefined();

    // A real Sentry ISSUE, not a breadcrumb: nothing else pages for this path,
    // and without it the account stays un-suspended on every 15-minute cycle
    // with only a structured log line to show for it.
    expect(sentryStub.captureException).toHaveBeenCalledTimes(1);
    expect(sentryStub.captureException.mock.calls[0]?.[0]).toBe(ledgerError);
    expect(JSON.stringify(sentryStub.captureException.mock.calls[0]?.[1] ?? {}))
      .toContain(breachingAccount);

    // The structured line is unchanged, error CLASS only — DB error text can
    // echo bound values, which is why the existing line never logs the message.
    expect(mockLogger.error).toHaveBeenCalledWith('autonomy_governor candidate-failed', {
      account_id: breachingAccount,
      error_name: 'Error',
    });

    // Containment itself is untouched: one poison account must not starve the
    // batch for the whole interval.
    expectReachedNextCandidate(nextAccount, cursor);
  });

  it('a throwing Sentry capture inside the Governor catch still lets the cycle reach the next candidate', async () => {
    process.env.GOVERNOR_ENABLED = 'true';
    sentryStub.captureException.mockImplementation(() => {
      throw new Error('sentry transport is down');
    });
    const { breachingAccount, nextAccount, cursor } =
      seedFailingSuspensionThenHealthyCandidate(new Error('refusal ledger rejected the write'));

    // This `catch` block exists to CONTAIN a failure to one candidate. An
    // unguarded capture that throws propagates out of the containment handler,
    // aborts the cycle mid-loop and skips every remaining candidate — the exact
    // outcome the containment was written to prevent, now caused by the
    // telemetry added to observe it.
    await expect(runAutonomyGovernorCycle(mockSql as never, cursor)).resolves.toBeUndefined();

    expect(sentryStub.captureException).toHaveBeenCalledTimes(1);

    // `logger.error` ran even though the capture threw, which is only possible
    // if it runs FIRST: the structured line has to survive when Sentry does not.
    expect(mockLogger.error).toHaveBeenCalledWith('autonomy_governor candidate-failed', {
      account_id: breachingAccount,
      error_name: 'Error',
    });

    expectReachedNextCandidate(nextAccount, cursor);
  });

  it('is registered for worker startup and graceful shutdown', () => {
    const workerEntry = readFileSync(resolve(process.cwd(), 'worker/index.ts'), 'utf8');
    expect(workerEntry).toContain("from './background/schedulers/AutonomyGovernorScheduler'");
    // #505: the start is now thunk-wrapped in the staggered-boot loopStarts list
    // (`() => startAutonomyGovernorScheduler()`), so match the call without the
    // trailing semicolon. The stop still runs synchronously in stopBackgroundLoops.
    expect(workerEntry).toContain('startAutonomyGovernorScheduler()');
    expect(workerEntry).toContain('stopAutonomyGovernorScheduler();');
  });
});
