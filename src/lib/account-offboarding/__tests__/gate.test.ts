import { describe, expect, it, vi } from 'vitest';

import {
  createOffboardingGate,
  getOffboardingState,
  isBillingMutationBlocked,
  isBillingManagementBlocked,
  isCheckoutBlocked,
  isConnectBlocked,
  isNotificationBlocked,
  isOffboardingIntentBlocked,
  isOperationalUIBlocked,
  isPublishingBlocked,
  isProcessingBlocked,
  OFFBOARDING_INTENTS,
  type OffboardingIntent,
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

  it('keeps null state as a no-op for every intent check', () => {
    for (const intent of OFFBOARDING_INTENTS) {
      expect(isOffboardingIntentBlocked(null, intent)).toBe(false);
    }
    expect(isProcessingBlocked(null)).toBe(false);
    expect(isNotificationBlocked(null)).toBe(false);
    expect(isPublishingBlocked(null)).toBe(false);
    expect(isCheckoutBlocked(null)).toBe(false);
    expect(isBillingMutationBlocked(null)).toBe(false);
    expect(isBillingManagementBlocked(null)).toBe(false);
    expect(isConnectBlocked(null)).toBe(false);
    expect(isOperationalUIBlocked(null)).toBe(false);
  });

  it.each([
    {
      label: 'cancel_only pending',
      state: offboardingState({ mode: 'cancel_only', status: 'pending' }),
      blocked: [],    },
    {
      label: 'cancel_only scheduled',
      state: offboardingState({ mode: 'cancel_only', status: 'scheduled' }),
      blocked: ['checkout', 'billing_expanding_mutation'],    },
    {
      label: 'cancel_only tearing_down',
      state: offboardingState({
        mode: 'cancel_only',
        status: 'tearing_down',
        teardownStartedAt: new Date('2026-07-01T00:00:00.000Z'),
      }),
      blocked: fullBlockIntents(),    },
    {
      label: 'cancel_only failed at teardown',
      state: offboardingState({
        mode: 'cancel_only',
        status: 'failed',
        failedStep: 'teardown',
        teardownStartedAt: new Date('2026-07-01T00:00:00.000Z'),
      }),
      blocked: fullBlockIntents(),    },
    {
      // C1: a pre-teardown billing failure must NOT fully lock the owner out
      // while Stripe keeps charging — only billing-expanding mutations freeze.
      label: 'cancel_only failed at billing (pre-teardown)',
      state: offboardingState({
        mode: 'cancel_only',
        status: 'failed',
        failedStep: 'billing',
        teardownStartedAt: null,
      }),
      blocked: ['checkout', 'billing_expanding_mutation'],    },
    {
      label: 'delete_data pending',
      state: offboardingState({ mode: 'delete_data', status: 'pending' }),
      blocked: fullBlockIntents(),    },
    {
      label: 'delete_data tearing_down',
      state: offboardingState({
        mode: 'delete_data',
        status: 'tearing_down',
        teardownStartedAt: new Date('2026-07-01T00:00:00.000Z'),
      }),
      blocked: fullBlockIntents(),    },
    {
      label: 'delete_data purge_scheduled',
      state: offboardingState({
        mode: 'delete_data',
        status: 'purge_scheduled',
        purgeAfter: new Date('2026-07-31T00:00:00.000Z'),
      }),
      blocked: fullBlockIntents(),    },
    {
      label: 'delete_data failed',
      state: offboardingState({
        mode: 'delete_data',
        status: 'failed',
        failedStep: 'purge',
      }),
      blocked: fullBlockIntents(),    },
  ] satisfies Array<{
    label: string;
    state: ActiveOffboardingState;
    blocked: OffboardingIntent[];
  }>)('applies the policy matrix for $label', ({ state, blocked }) => {
    const blockedIntents = blocked as readonly OffboardingIntent[];
    for (const intent of OFFBOARDING_INTENTS) {
      expect(isOffboardingIntentBlocked(state, intent), `${intent}`).toBe(
        blockedIntents.includes(intent),
      );
    }

    expect(isProcessingBlocked(state)).toBe(blockedIntents.includes('processing'));
    expect(isNotificationBlocked(state)).toBe(blockedIntents.includes('notification'));
    expect(isPublishingBlocked(state)).toBe(blockedIntents.includes('publishing'));
    expect(isCheckoutBlocked(state)).toBe(blockedIntents.includes('checkout'));
    expect(isConnectBlocked(state)).toBe(blockedIntents.includes('connect'));
    expect(isOperationalUIBlocked(state)).toBe(blockedIntents.includes('operational_ui'));
    expect(isBillingManagementBlocked(state)).toBe(blockedIntents.includes('billing_management'));
    expect(isBillingMutationBlocked(state)).toBe(
      blockedIntents.includes('billing_expanding_mutation'),
    );
  });

  it('caches loaded offboarding state within a gate instance only', async () => {
    const { db, fn } = createMockDb([]);
    const gate = createOffboardingGate(db);

    await expect(gate.getOffboardingState('018ff6f0-97b2-7b80-9e1d-58d50c717e64')).resolves.toBeNull();
    await expect(gate.getOffboardingState('018ff6f0-97b2-7b80-9e1d-58d50c717e64')).resolves.toBeNull();
    await expect(gate.getOffboardingState('018ff6f0-97b2-7b80-9e1d-58d50c717e65')).resolves.toBeNull();

    expect(fn.mock.calls).toHaveLength(2);
  });
});

function fullBlockIntents(): OffboardingIntent[] {
  return [
    'processing',
    'notification',
    'publishing',
    'checkout',
    'connect',
    'billing_expanding_mutation',
    'billing_management',
    'operational_ui',
  ];
}
