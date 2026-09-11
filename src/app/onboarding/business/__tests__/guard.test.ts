import { describe, it, expect } from 'vitest';
import { resolveWizardDestination, shouldUseDemoWizard, wizardClientProps } from '../guard';

// These tests cover Scenario K step 5 + Scenario L from
// docs/signup-test-runbook.md — the four redirect cases the
// /onboarding/business server component fires before rendering the wizard.

describe('resolveWizardDestination — Scenario L wizard guards', () => {
  it('L.1b no users row (signup never finished provisioning) → /signup', () => {
    expect(resolveWizardDestination(null)).toEqual({
      kind: 'redirect',
      path: '/signup',
    });
    expect(resolveWizardDestination(undefined)).toEqual({
      kind: 'redirect',
      path: '/signup',
    });
  });

  it('L.2 admin role → /admin/overview (admins must not see owner pages)', () => {
    expect(
      resolveWizardDestination({
        role: 'admin',
        subscription_status: 'active',
        place_id_verified: false,
        google_maps_url: null,
      }, { adminDestination: 'https://admin.example.com' }),
    ).toEqual({ kind: 'redirect', path: 'https://admin.example.com' });
  });

  it('L.2b sales_partner role → /login (unsupported legacy role fails closed)', () => {
    expect(
      resolveWizardDestination({
        role: 'sales_partner',
        subscription_status: 'active',
        place_id_verified: false,
        google_maps_url: null,
      }),
    ).toEqual({ kind: 'redirect', path: '/login' });
  });

  it('L.3 pending_payment owner → /onboarding/pay', () => {
    expect(
      resolveWizardDestination({
        role: 'owner',
        subscription_status: 'pending_payment',
        place_id_verified: false,
        google_maps_url: null,
      }),
    ).toEqual({ kind: 'redirect', path: '/onboarding/pay' });
  });

  it('L.3b past_due owner → /onboarding/pay (any non-active status)', () => {
    expect(
      resolveWizardDestination({
        role: 'owner',
        subscription_status: 'past_due',
        place_id_verified: false,
        google_maps_url: null,
      }),
    ).toEqual({ kind: 'redirect', path: '/onboarding/pay' });
  });

  it('L.3c cancelled owner → /onboarding/pay (defense-in-depth)', () => {
    expect(
      resolveWizardDestination({
        role: 'owner',
        subscription_status: 'cancelled',
        place_id_verified: false,
        google_maps_url: null,
      }),
    ).toEqual({ kind: 'redirect', path: '/onboarding/pay' });
  });

  it('L.4 / K.5 active owner with place_id_verified=true → /dashboard', () => {
    expect(
      resolveWizardDestination({
        role: 'owner',
        subscription_status: 'active',
        place_id_verified: true,
        google_maps_url: null,
      }),
    ).toEqual({ kind: 'redirect', path: '/dashboard' });
  });

  it('L.4b active owner with google_maps_url set (place ID resolution pending) → /dashboard', () => {
    expect(
      resolveWizardDestination({
        role: 'owner',
        subscription_status: 'active',
        place_id_verified: false,
        google_maps_url: 'https://maps.google.com/?cid=1',
      }),
    ).toEqual({ kind: 'redirect', path: '/dashboard' });
  });

  it('happy path: active owner who has not onboarded → render wizard', () => {
    expect(
      resolveWizardDestination({
        role: 'owner',
        subscription_status: 'active',
        place_id_verified: false,
        google_maps_url: null,
      }),
    ).toEqual({ kind: 'render' });
  });

  // Order-dependence guard: an admin row with a stale active subscription must
  // route by ROLE first (admin/overview), not by onboarding-state. Without the
  // role check happening before the onboarded check, a misconfigured admin
  // with place_id_verified=true would be routed to /dashboard (unauthorized).
  it('order: admin role check fires BEFORE onboarded check', () => {
    expect(
      resolveWizardDestination({
        role: 'admin',
        subscription_status: 'active',
        place_id_verified: true,
        google_maps_url: 'https://maps.google.com/?cid=1',
      }, { adminDestination: 'https://admin.example.com' }),
    ).toEqual({ kind: 'redirect', path: 'https://admin.example.com' });
  });

  // Order-dependence guard: a pending-payment owner who already filled in
  // place_id (somehow — manual SQL, or a partial wizard write) must still be
  // sent to /onboarding/pay. Subscription gate beats onboarded gate.
  it('order: pending_payment status check fires BEFORE onboarded check', () => {
    expect(
      resolveWizardDestination({
        role: 'owner',
        subscription_status: 'pending_payment',
        place_id_verified: true,
        google_maps_url: null,
      }),
    ).toEqual({ kind: 'redirect', path: '/onboarding/pay' });
  });
});

describe('shouldUseDemoWizard — demo mode requires a pre-captured location', () => {
  const loc = (over: Partial<{ place_id_verified: boolean; google_maps_url: string | null }> = {}) => ({
    place_id_verified: false,
    google_maps_url: null,
    ...over,
  });

  it('demo env ON + location verified → demo wizard (Profile/Voice/Connect)', () => {
    expect(shouldUseDemoWizard(true, loc({ place_id_verified: true }))).toBe(true);
  });

  it('demo env ON + google_maps_url set → demo wizard', () => {
    expect(shouldUseDemoWizard(true, loc({ google_maps_url: 'https://maps.google.com/?cid=1' }))).toBe(true);
  });

  // The card-up-front trial: subscribed but NO location captured (it skipped the
  // pre-pay demo). Must be FALSE so the non-demo wizard captures the location —
  // returning true here is exactly the bug that ping-ponged trials
  // /onboarding/business → /onboarding/start → /dashboard.
  it('demo env ON + NO location → non-demo wizard (the trial loop fix)', () => {
    expect(shouldUseDemoWizard(true, loc())).toBe(false);
  });

  it('demo env OFF → never demo wizard', () => {
    expect(shouldUseDemoWizard(false, loc({ place_id_verified: true }))).toBe(false);
  });

  it('null/undefined row → false', () => {
    expect(shouldUseDemoWizard(true, null)).toBe(false);
    expect(shouldUseDemoWizard(true, undefined)).toBe(false);
  });
});

describe('wizardClientProps — the row → BusinessWizardClient props', () => {
  const row = {
    role: 'owner',
    subscription_status: 'active',
    place_id_verified: true,
    google_maps_url: null,
    category: 'Cafe',
    website: 'https://example.com',
    name: 'RepWorth Cafe',
    subscription_tier: 'autopilot',
  };

  it('seeds the wizard from the row and runs demo mode when the demo is on and the location is captured', () => {
    expect(wizardClientProps(row, true)).toEqual({
      initialValues: { category: 'Cafe', website: 'https://example.com', businessName: 'RepWorth Cafe' },
      demoFlowEnabled: true,
      subscriptionTier: 'autopilot',
    });
  });

  it('falls back to the non-demo wizard when the demo flag is off', () => {
    expect(wizardClientProps(row, false).demoFlowEnabled).toBe(false);
  });

  it('falls back to the non-demo wizard for a trial with no location yet (the /start bounce-loop guard)', () => {
    const trial = { ...row, place_id_verified: false, google_maps_url: null };
    expect(wizardClientProps(trial, true).demoFlowEnabled).toBe(false);
  });

  it('collapses null seeds to empty strings and a null tier stays null', () => {
    expect(
      wizardClientProps({ ...row, category: null, website: null, subscription_tier: null }, true),
    ).toEqual({
      initialValues: { category: '', website: '', businessName: 'RepWorth Cafe' },
      demoFlowEnabled: true,
      subscriptionTier: null,
    });
  });

  it('yields empty seeds for a missing row — the guard redirects it before render', () => {
    expect(wizardClientProps(undefined, true)).toEqual({
      initialValues: { category: '', website: '', businessName: '' },
      demoFlowEnabled: false,
      subscriptionTier: null,
    });
  });
});
