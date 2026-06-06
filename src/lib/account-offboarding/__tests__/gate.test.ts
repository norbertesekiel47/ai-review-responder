import { describe, expect, it, vi } from 'vitest';

import {
  createOffboardingGate,
  canReactivate,
  getOffboardingState,
  isApprovalCallbackBlocked,
  isBillingMutationBlocked,
  isBillingManagementBlocked,
  isCheckoutBlocked,
  isConnectBlocked,
  isKeepMyDataBlocked,
  isNotificationBlocked,
  isOffboardingIntentBlocked,
  isOffboardingReactivationBlocked,
  isOffboardingStatusBlocked,
  isOperationalUIBlocked,
  isPublishingBlocked,
  isProcessingBlocked,
  OFFBOARDING_INTENTS,
  purgeEligible,
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
    expect(isApprovalCallbackBlocked(null)).toBe(false);
    expect(isNotificationBlocked(null)).toBe(false);
    expect(isPublishingBlocked(null)).toBe(false);
    expect(isCheckoutBlocked(null)).toBe(false);
    expect(isBillingMutationBlocked(null)).toBe(false);
    expect(isBillingManagementBlocked(null)).toBe(false);
    expect(isConnectBlocked(null)).toBe(false);
    expect(isOperationalUIBlocked(null)).toBe(false);
    expect(isOffboardingStatusBlocked(null)).toBe(false);
    expect(isKeepMyDataBlocked(null)).toBe(true);
    expect(isOffboardingReactivationBlocked(null)).toBe(true);
    expect(canReactivate(null)).toBe(false);
    expect(purgeEligible(null)).toBe(false);
  });

  it.each([
    {
      label: 'cancel_only pending',
      state: offboardingState({ mode: 'cancel_only', status: 'pending' }),
      blocked: [],
      reactivatable: false,
    },
    {
      label: 'cancel_only scheduled',
      state: offboardingState({ mode: 'cancel_only', status: 'scheduled' }),
      blocked: ['checkout', 'billing_expanding_mutation'],
      reactivatable: true,
    },
    {
      label: 'cancel_only tearing_down',
      state: offboardingState({
        mode: 'cancel_only',
        status: 'tearing_down',
        teardownStartedAt: new Date('2026-07-01T00:00:00.000Z'),
      }),
      blocked: fullBlockIntents(),
      reactivatable: false,
    },
    {
      label: 'cancel_only failed',
      state: offboardingState({
        mode: 'cancel_only',
        status: 'failed',
        failedStep: 'teardown',
      }),
      blocked: fullBlockIntents(),
      reactivatable: false,
    },
    {
      label: 'delete_data pending',
      state: offboardingState({ mode: 'delete_data', status: 'pending' }),
      blocked: fullBlockIntents(),
      reactivatable: false,
    },
    {
      label: 'delete_data tearing_down',
      state: offboardingState({
        mode: 'delete_data',
        status: 'tearing_down',
        teardownStartedAt: new Date('2026-07-01T00:00:00.000Z'),
      }),
      blocked: fullBlockIntents(),
      reactivatable: false,
    },
    {
      label: 'delete_data purge_scheduled',
      state: offboardingState({
        mode: 'delete_data',
        status: 'purge_scheduled',
        purgeAfter: new Date('2026-07-31T00:00:00.000Z'),
      }),
      blocked: fullBlockIntents(),
      reactivatable: false,
    },
    {
      label: 'delete_data failed',
      state: offboardingState({
        mode: 'delete_data',
        status: 'failed',
        failedStep: 'purge',
      }),
      blocked: fullBlockIntents(),
      reactivatable: false,
    },
  ] satisfies Array<{
    label: string;
    state: ActiveOffboardingState;
    blocked: OffboardingIntent[];
    reactivatable: boolean;
  }>)('applies the policy matrix for $label', ({ state, blocked, reactivatable }) => {
    const blockedIntents = blocked as readonly OffboardingIntent[];
    for (const intent of OFFBOARDING_INTENTS) {
      expect(isOffboardingIntentBlocked(state, intent), `${intent}`).toBe(
        blockedIntents.includes(intent),
      );
    }

    expect(isProcessingBlocked(state)).toBe(blockedIntents.includes('processing'));
    expect(isApprovalCallbackBlocked(state)).toBe(blockedIntents.includes('approval_callback'));
    expect(isNotificationBlocked(state)).toBe(blockedIntents.includes('notification'));
    expect(isPublishingBlocked(state)).toBe(blockedIntents.includes('publishing'));
    expect(isCheckoutBlocked(state)).toBe(blockedIntents.includes('checkout'));
    expect(isConnectBlocked(state)).toBe(blockedIntents.includes('connect'));
    expect(isOperationalUIBlocked(state)).toBe(blockedIntents.includes('operational_ui'));
    expect(isBillingManagementBlocked(state)).toBe(blockedIntents.includes('billing_management'));
    expect(isBillingMutationBlocked(state)).toBe(
      blockedIntents.includes('billing_expanding_mutation'),
    );
    expect(isOffboardingStatusBlocked(state)).toBe(false);
    expect(isOffboardingReactivationBlocked(state)).toBe(!reactivatable);
    expect(canReactivate(state)).toBe(reactivatable);
  });

  it.each([
    {
      label: 'delete_data pending',
      state: offboardingState({ mode: 'delete_data', status: 'pending' }),
      blocked: false,
    },
    {
      label: 'delete_data tearing_down before purge starts',
      state: offboardingState({
        mode: 'delete_data',
        status: 'tearing_down',
        teardownStartedAt: new Date('2026-07-01T00:00:00.000Z'),
      }),
      blocked: false,
    },
    {
      label: 'delete_data purge_scheduled before purge starts',
      state: offboardingState({
        mode: 'delete_data',
        status: 'purge_scheduled',
        purgeAfter: new Date('2026-07-31T00:00:00.000Z'),
      }),
      blocked: false,
    },
    {
      label: 'cancel_only scheduled',
      state: offboardingState({ mode: 'cancel_only', status: 'scheduled' }),
      blocked: true,
    },
    {
      label: 'delete_data failed',
      state: offboardingState({
        mode: 'delete_data',
        status: 'failed',
        failedStep: 'purge',
      }),
      blocked: true,
    },
    {
      label: 'delete_data purge already started',
      state: offboardingState({
        mode: 'delete_data',
        status: 'purge_scheduled',
        purgeAfter: new Date('2026-07-31T00:00:00.000Z'),
        purgeStartedAt: new Date('2026-08-01T00:00:00.000Z'),
      }),
      blocked: true,
    },
    {
      label: 'delete_data purge already cancelled',
      state: offboardingState({
        mode: 'delete_data',
        status: 'purge_scheduled',
        purgeAfter: new Date('2026-07-31T00:00:00.000Z'),
        purgeCancelledAt: new Date('2026-07-15T00:00:00.000Z'),
      }),
      blocked: true,
    },
  ])('applies the keep-my-data action guard for $label', ({ state, blocked }) => {
    expect(isOffboardingIntentBlocked(state, 'offboarding_keep_my_data')).toBe(false);
    expect(isKeepMyDataBlocked(state)).toBe(blocked);
  });

  it('caches loaded offboarding state within a gate instance only', async () => {
    const { db, fn } = createMockDb([]);
    const gate = createOffboardingGate(db);

    await expect(gate.getOffboardingState('018ff6f0-97b2-7b80-9e1d-58d50c717e64')).resolves.toBeNull();
    await expect(gate.getOffboardingState('018ff6f0-97b2-7b80-9e1d-58d50c717e64')).resolves.toBeNull();
    await expect(gate.getOffboardingState('018ff6f0-97b2-7b80-9e1d-58d50c717e65')).resolves.toBeNull();

    expect(fn.mock.calls).toHaveLength(2);
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

function fullBlockIntents(): OffboardingIntent[] {
  return [
    'processing',
    'approval_callback',
    'notification',
    'publishing',
    'checkout',
    'connect',
    'billing_expanding_mutation',
    'billing_management',
    'operational_ui',
  ];
}
