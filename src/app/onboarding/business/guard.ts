/**
 * Pure guard logic for the /onboarding/business page.
 *
 * Extracted from page.tsx so the four redirect rules (no row, wrong role,
 * not-yet-paid, already-onboarded) can be unit-tested without dragging
 * a React/JSX transformer into the vitest pipeline.
 *
 * Order matters — earlier branches preempt later ones (e.g. an admin
 * with subscription_status='active' should redirect to /admin/overview,
 * not /dashboard).
 */

export interface WizardGuardRow {
  role: string;
  subscription_status: string;
  place_id_verified: boolean;
  google_maps_url: string | null;
}

export type WizardGuardOutcome =
  | { kind: 'redirect'; path: string }
  | { kind: 'render' };

export function resolveWizardDestination(
  row: WizardGuardRow | null | undefined,
): WizardGuardOutcome {
  if (!row) return { kind: 'redirect', path: '/signup' };
  if (row.role !== 'owner') return { kind: 'redirect', path: '/admin/overview' };
  if (row.subscription_status !== 'active') {
    return { kind: 'redirect', path: '/onboarding/pay' };
  }
  if (row.place_id_verified || row.google_maps_url !== null) {
    return { kind: 'redirect', path: '/dashboard' };
  }
  return { kind: 'render' };
}
