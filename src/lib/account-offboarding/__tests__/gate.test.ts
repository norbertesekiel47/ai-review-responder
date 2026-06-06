import { describe, expect, it, vi } from 'vitest';

import {
  canReactivate,
  getOffboardingState,
  isBillingMutationBlocked,
  isConnectBlocked,
  isOperationalUIBlocked,
  isProcessingBlocked,
  purgeEligible,
} from '../gate';
import type { ActiveOffboardingState } from '../types';

type GateSql = NonNullable<Parameters<typeof getOffboardingState>[1]>;
type MockSqlCall = [TemplateStringsArray, ...unknown[]];

function createMockDb(rows: unknown[]) {
  const fn = vi.fn(async (_strings: TemplateStringsArray, ..._values: unknown[]) => rows);
  return {
    db: fn as unknown as GateSql,
    fn: fn as unknown as { mock: { calls: MockSqlCall[] } },
  };
}

function offboardingState(
  overrides: Partial<ActiveOffboardingState> = {},
): ActiveOffboardingState {
  return {
    id: '018ff6f0-97b2-7b80-9e1d-58d50c717e63',
    accountId: '018ff6f0-97b2-7b80-9e1d-58d50c717e64',
    mode: 'cancel_only',
    status: 'scheduled',
    failedStep: null,
    terminalAt: null,
    accessEndsAt: new Date('2026-07-01T00:00:00.000Z'),
    teardownStartedAt: null,
    purgeAfter: null,
    purgeStartedAt: null,
    purgeCancelledAt: null,
    ...overrides,
  };
}

describe('account offboarding gate', () => {
  it('returns null when the account has no active offboarding row', async () => {
    const { db, fn } = createMockDb([]);

    await expect(getOffboardingState('018ff6f0-97b2-7b80-9e1d-58d50c717e64', db)).resolves.toBeNull();

    const query = fn.mock.calls[0]![0].join(' ');
    expect(query).toContain('FROM account_offboardings');
    expect(query).toContain('account_id = ');
    expect(query).toContain('terminal_at IS NULL');
  });

  it('maps an active offboarding database row', async () => {
    const accessEndsAt = new Date('2026-07-01T00:00:00.000Z');
    const { db } = createMockDb([
      {
        id: '018ff6f0-97b2-7b80-9e1d-58d50c717e63',
        account_id: '018ff6f0-97b2-7b80-9e1d-58d50c717e64',
        mode: 'cancel_only',
        status: 'failed',
        failed_step: 'billing',
        terminal_at: null,
        access_ends_at: accessEndsAt,
        teardown_started_at: null,
        purge_after: null,
        purge_started_at: null,
        purge_cancelled_at: null,
      },
    ]);

    await expect(getOffboardingState('018ff6f0-97b2-7b80-9e1d-58d50c717e64', db)).resolves.toEqual({
      id: '018ff6f0-97b2-7b80-9e1d-58d50c717e63',
      accountId: '018ff6f0-97b2-7b80-9e1d-58d50c717e64',
      mode: 'cancel_only',
      status: 'failed',
      failedStep: 'billing',
      terminalAt: null,
      accessEndsAt,
      teardownStartedAt: null,
      purgeAfter: null,
      purgeStartedAt: null,
      purgeCancelledAt: null,
    });
  });

  it('keeps null state as a no-op for all intent checks', () => {
    expect(isProcessingBlocked(null)).toBe(false);
    expect(isBillingMutationBlocked(null)).toBe(false);
    expect(isConnectBlocked(null)).toBe(false);
    expect(isOperationalUIBlocked(null)).toBe(false);
    expect(canReactivate(null)).toBe(false);
    expect(purgeEligible(null)).toBe(false);
  });

  it('allows paid-through cancel_only scheduled product behavior but blocks billing mutations', () => {
    const state = offboardingState();

    expect(isProcessingBlocked(state)).toBe(false);
    expect(isConnectBlocked(state)).toBe(false);
    expect(isOperationalUIBlocked(state)).toBe(false);
    expect(isBillingMutationBlocked(state)).toBe(true);
    expect(canReactivate(state)).toBe(true);
  });

  it('does not full-block cancel_only pending, but still blocks billing mutations', () => {
    const state = offboardingState({ status: 'pending' });

    expect(isProcessingBlocked(state)).toBe(false);
    expect(isConnectBlocked(state)).toBe(false);
    expect(isOperationalUIBlocked(state)).toBe(false);
    expect(isBillingMutationBlocked(state)).toBe(true);
    expect(canReactivate(state)).toBe(false);
  });

  it('fully blocks cancel_only teardown and failed states', () => {
    for (const status of ['tearing_down', 'failed'] as const) {
      const state = offboardingState({ status });

      expect(isProcessingBlocked(state)).toBe(true);
      expect(isConnectBlocked(state)).toBe(true);
      expect(isOperationalUIBlocked(state)).toBe(true);
      expect(isBillingMutationBlocked(state)).toBe(true);
      expect(canReactivate(state)).toBe(false);
    }
  });

  it('fully blocks every active delete_data state', () => {
    for (const status of [
      'pending',
      'tearing_down',
      'purge_scheduled',
      'failed',
    ] as const) {
      const state = offboardingState({ mode: 'delete_data', status });

      expect(isProcessingBlocked(state)).toBe(true);
      expect(isConnectBlocked(state)).toBe(true);
      expect(isOperationalUIBlocked(state)).toBe(true);
      expect(isBillingMutationBlocked(state)).toBe(true);
      expect(canReactivate(state)).toBe(false);
    }
  });

  it('marks only unstarted delete_data purge_scheduled rows as purge eligible', () => {
    const purgeAfter = new Date('2026-07-31T00:00:00.000Z');

    expect(
      purgeEligible(
        offboardingState({
          mode: 'delete_data',
          status: 'purge_scheduled',
          purgeAfter,
        }),
        new Date('2026-08-01T00:00:00.000Z'),
      ),
    ).toBe(true);
    expect(
      purgeEligible(
        offboardingState({
          mode: 'delete_data',
          status: 'purge_scheduled',
          purgeAfter,
        }),
        new Date('2026-07-01T00:00:00.000Z'),
      ),
    ).toBe(false);
    expect(
      purgeEligible(
        offboardingState({
          mode: 'delete_data',
          status: 'purge_scheduled',
          purgeAfter,
          purgeStartedAt: new Date('2026-08-01T00:00:00.000Z'),
        }),
        new Date('2026-08-01T00:00:00.000Z'),
      ),
    ).toBe(false);
    expect(
      purgeEligible(
        offboardingState({
          mode: 'cancel_only',
          status: 'scheduled',
          purgeAfter,
        }),
        new Date('2026-08-01T00:00:00.000Z'),
      ),
    ).toBe(false);
  });
});
