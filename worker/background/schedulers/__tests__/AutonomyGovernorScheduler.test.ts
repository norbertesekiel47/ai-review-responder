import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSql, sqlReturnQueue, sqlCalls, resetMockSql, mkTaggedResult } =
  await vi.hoisted(async () => {
    const helpers = await import('../../../__tests__/helpers/mock-sql');
    return { ...helpers.createMockSql(), mkTaggedResult: helpers.mkTaggedResult };
  });

vi.mock('@/lib/db/server', () => ({ sql: mockSql }));
vi.mock('uuid', () => ({ v7: vi.fn(() => 'event-1') }));

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

  it('advances past a poison candidate before its rate query rejects', async () => {
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
      .rejects.toBe(poisonError);
    expect(cursor.afterAccountId).toBe(poisonAccount);

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

  it('is registered for worker startup and graceful shutdown', () => {
    const workerEntry = readFileSync(resolve(process.cwd(), 'worker/index.ts'), 'utf8');
    expect(workerEntry).toContain("from './background/schedulers/AutonomyGovernorScheduler'");
    expect(workerEntry).toContain('startAutonomyGovernorScheduler();');
    expect(workerEntry).toContain('stopAutonomyGovernorScheduler();');
  });
});
