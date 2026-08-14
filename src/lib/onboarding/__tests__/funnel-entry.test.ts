import { describe, expect, it } from 'vitest';
import {
  resolveFunnelEntry,
  type FunnelEntryUrl,
  type FunnelOwnerState,
} from '../funnel-entry';
import { SubscriptionStatus } from '@/lib/shared/subscription-status';

// The five-row funnel matrix (plan step 7 / ticket T2). Row 2 — pending_payment
// with a captured place — is the drop-off return point: an owner who captured a
// location and then abandoned must land back on the demo, never skip it.

const state = (over: Partial<FunnelOwnerState> = {}): FunnelOwnerState => ({
  subscriptionStatus: SubscriptionStatus.PENDING_PAYMENT,
  demoEnabled: false,
  hasPlace: false,
  wizardCompleted: false,
  ...over,
});

describe('resolveFunnelEntry — the five-row funnel matrix', () => {
  it('pending_payment with demo enabled and no place resolves to /onboarding/start', () => {
    expect(
      resolveFunnelEntry(
        state({
          subscriptionStatus: SubscriptionStatus.PENDING_PAYMENT,
          demoEnabled: true,
          hasPlace: false,
        }),
      ),
    ).toBe('/onboarding/start');
  });

  it('pending_payment with demo enabled and a captured place resolves to /onboarding/demo', () => {
    expect(
      resolveFunnelEntry(
        state({
          subscriptionStatus: SubscriptionStatus.PENDING_PAYMENT,
          demoEnabled: true,
          hasPlace: true,
        }),
      ),
    ).toBe('/onboarding/demo');
  });

  it('pending_payment with demo disabled resolves to /onboarding/pay', () => {
    expect(
      resolveFunnelEntry(
        state({
          subscriptionStatus: SubscriptionStatus.PENDING_PAYMENT,
          demoEnabled: false,
          hasPlace: false,
        }),
      ),
    ).toBe('/onboarding/pay');
  });

  it('post-payment with an incomplete wizard resolves to /onboarding/business', () => {
    expect(
      resolveFunnelEntry(
        state({
          subscriptionStatus: SubscriptionStatus.ACTIVE,
          wizardCompleted: false,
        }),
      ),
    ).toBe('/onboarding/business');
  });

  it('post-payment with a completed wizard resolves to /dashboard', () => {
    expect(
      resolveFunnelEntry(
        state({
          subscriptionStatus: SubscriptionStatus.ACTIVE,
          wizardCompleted: true,
        }),
      ),
    ).toBe('/dashboard');
  });
});

describe('resolveFunnelEntry — precedence', () => {
  // Rows 1-3 fire on pending_payment BEFORE the wizard rows are consulted: a
  // stale onboarding_wizard_completed_at (manual SQL, a re-subscribe) must not
  // let an unpaid owner out of the pay/demo funnel.
  it.each<[string, boolean, boolean, FunnelEntryUrl]>([
    ['demo on, no place', true, false, '/onboarding/start'],
    ['demo on, place captured', true, true, '/onboarding/demo'],
    ['demo off', false, true, '/onboarding/pay'],
  ])(
    'pending_payment (%s) preempts the wizard rows even when the wizard is stamped complete',
    (_label, demoEnabled, hasPlace, expected) => {
      expect(
        resolveFunnelEntry(
          state({
            subscriptionStatus: SubscriptionStatus.PENDING_PAYMENT,
            demoEnabled,
            hasPlace,
            wizardCompleted: true,
          }),
        ),
      ).toBe(expected);
    },
  );

  // demoEnabled/hasPlace are pending_payment-only inputs: once the owner has
  // paid, the wizard rows own the decision regardless of the demo flag.
  it.each<[boolean, boolean]>([
    [true, true],
    [true, false],
    [false, true],
    [false, false],
  ])(
    'post-payment ignores demoEnabled=%s / hasPlace=%s and routes on the wizard stamp',
    (demoEnabled, hasPlace) => {
      expect(
        resolveFunnelEntry(
          state({
            subscriptionStatus: SubscriptionStatus.ACTIVE,
            demoEnabled,
            hasPlace,
            wizardCompleted: false,
          }),
        ),
      ).toBe('/onboarding/business');
      expect(
        resolveFunnelEntry(
          state({
            subscriptionStatus: SubscriptionStatus.ACTIVE,
            demoEnabled,
            hasPlace,
            wizardCompleted: true,
          }),
        ),
      ).toBe('/dashboard');
    },
  );
});

describe('resolveFunnelEntry — entitlement is subscriptionGrantsFullAccess, never a raw active check', () => {
  // Invariant #11: `trialing` is a card-up-front trial with FULL access, so it
  // must route exactly like `active` on both wizard branches. A raw
  // `=== 'active'` check here would dump every trial onto /dashboard with an
  // un-run wizard.
  it.each<[boolean, FunnelEntryUrl]>([
    [false, '/onboarding/business'],
    [true, '/dashboard'],
  ])(
    'trialing with wizardCompleted=%s routes exactly like active',
    (wizardCompleted, expected) => {
      const trialing = resolveFunnelEntry(
        state({ subscriptionStatus: SubscriptionStatus.TRIALING, wizardCompleted }),
      );
      const active = resolveFunnelEntry(
        state({ subscriptionStatus: SubscriptionStatus.ACTIVE, wizardCompleted }),
      );
      expect(trialing).toBe(expected);
      expect(trialing).toBe(active);
    },
  );

  // past_due / cancelled are neither pending_payment nor full-access: they fall
  // through to /dashboard, which owns their account-state screens (past-due
  // grace, cancelled) — the funnel must not try to re-run onboarding for them.
  it.each<[string, boolean]>([
    [SubscriptionStatus.PAST_DUE, false],
    [SubscriptionStatus.PAST_DUE, true],
    [SubscriptionStatus.CANCELLED, false],
    [SubscriptionStatus.CANCELLED, true],
  ])('%s (wizardCompleted=%s) falls through to /dashboard', (subscriptionStatus, wizardCompleted) => {
    expect(
      resolveFunnelEntry(state({ subscriptionStatus, wizardCompleted, demoEnabled: true, hasPlace: true })),
    ).toBe('/dashboard');
  });

  it('an unknown status falls through to /dashboard rather than into the funnel', () => {
    expect(
      resolveFunnelEntry(state({ subscriptionStatus: 'not_a_status', demoEnabled: true })),
    ).toBe('/dashboard');
  });
});
