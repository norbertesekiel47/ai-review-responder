import { describe, it, expect } from 'vitest';
import { resolveWizardDestination } from '../guard';

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
      }),
    ).toEqual({ kind: 'redirect', path: '/admin/overview' });
  });

  it('L.2b sales_partner role → /admin/overview (same admin-class rule)', () => {
    expect(
      resolveWizardDestination({
        role: 'sales_partner',
        subscription_status: 'active',
        place_id_verified: false,
        google_maps_url: null,
      }),
    ).toEqual({ kind: 'redirect', path: '/admin/overview' });
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
      }),
    ).toEqual({ kind: 'redirect', path: '/admin/overview' });
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
