/**
 * Pure guard logic for the /onboarding/business page.
 *
 * Extracted from page.tsx so the four redirect rules (no row, wrong role,
 * not-yet-paid, already-onboarded) can be unit-tested without dragging
 * a React/JSX transformer into the vitest pipeline.
 *
 * Order matters — earlier branches preempt later ones (e.g. an admin with
 * subscription_status='active' should redirect to the trusted Admin app home, not
 * /dashboard).
 */

import { subscriptionGrantsFullAccess } from '@/lib/shared/subscription-status';

export interface WizardGuardRow {
  role: string;
  subscription_status: string;
  place_id_verified: boolean;
  google_maps_url: string | null;
}

export type WizardGuardOutcome =
  | { kind: 'redirect'; path: string }
  | { kind: 'render' };

export interface WizardGuardOptions {
  /** Trusted server-provided home, keeping this guard pure of environment reads. */
  adminDestination?: string;
  /**
   * True only when the location was ALREADY captured at /onboarding/start (the
   * pre-pay demo flow), so the wizard runs its Profile/Voice/Connect steps. The
   * caller MUST gate this on the location actually being present — see
   * `shouldUseDemoWizard`. A card-up-front trial skips the pre-pay demo and
   * arrives subscribed with NO location; the caller passes demoFlowEnabled=false
   * for it so it gets the non-demo wizard (Location/Profile/Voice), which
   * captures the location itself. (Passing demoFlowEnabled=true without a
   * location previously bounced trials to /onboarding/start, which redirects
   * subscribed accounts back to /dashboard → infinite loop.)
   */
  demoFlowEnabled?: boolean;
}

/**
 * Whether the /onboarding/business wizard should run in demo mode
 * (Profile/Voice/Connect — location pre-captured at /onboarding/start) vs the
 * non-demo mode (Location/Profile/Voice — captures the location itself).
 *
 * Demo mode is ONLY valid when the location is already present. A card-up-front
 * trial subscribes WITHOUT going through the pre-pay demo, so it has no location
 * yet and must use the non-demo wizard — otherwise it ping-pongs
 * /onboarding/business → /onboarding/start → /dashboard. Gating on `hasLocation`
 * is what prevents that loop.
 */
export function shouldUseDemoWizard(
  envEnabled: boolean,
  row: Pick<WizardGuardRow, 'place_id_verified' | 'google_maps_url'> | null | undefined,
): boolean {
  if (!envEnabled || !row) return false;
  const hasLocation = row.place_id_verified || row.google_maps_url !== null;
  return hasLocation;
}

export function resolveWizardDestination(
  row: WizardGuardRow | null | undefined,
  options: WizardGuardOptions = {},
): WizardGuardOutcome {
  if (!row) return { kind: 'redirect', path: '/signup' };
  if (row.role === 'admin') {
    if (!options.adminDestination) throw new Error('Admin destination is required for an admin redirect');
    return { kind: 'redirect', path: options.adminDestination };
  }
  if (row.role !== 'owner') return { kind: 'redirect', path: '/login' };
  if (!subscriptionGrantsFullAccess(row.subscription_status)) {
    return { kind: 'redirect', path: '/onboarding/pay' };
  }
  if (options.demoFlowEnabled) {
    if (!row.place_id_verified && row.google_maps_url === null) {
      return { kind: 'redirect', path: '/onboarding/start' };
    }
    return { kind: 'render' };
  }
  if (row.place_id_verified || row.google_maps_url !== null) {
    return { kind: 'redirect', path: '/dashboard' };
  }
  return { kind: 'render' };
}

/** The page's SELECT: the guard columns plus the wizard's seed values. */
export interface WizardPageRow extends WizardGuardRow {
  category: string | null;
  website: string | null;
  name: string;
  subscription_tier: string | null;
}

export interface WizardClientProps {
  initialValues: { category: string; website: string; businessName: string };
  demoFlowEnabled: boolean;
  subscriptionTier: string | null;
}

/**
 * Everything `BusinessWizardClient` needs from the row, resolved in one place.
 * `demoFlowEnabled` is `shouldUseDemoWizard` — true ONLY when the demo lane is
 * on AND the location was already captured — so a card-up-front trial (no
 * location yet) gets the non-demo wizard instead of the /onboarding/start
 * bounce loop described on `WizardGuardOptions`. A missing row yields empty
 * seeds; the caller still runs `resolveWizardDestination`, which redirects it.
 */
export function wizardClientProps(
  row: WizardPageRow | null | undefined,
  envDemoEnabled: boolean,
): WizardClientProps {
  return {
    initialValues: {
      category: row?.category ?? '',
      website: row?.website ?? '',
      businessName: row?.name ?? '',
    },
    demoFlowEnabled: shouldUseDemoWizard(envDemoEnabled, row),
    subscriptionTier: row?.subscription_tier ?? null,
  };
}
