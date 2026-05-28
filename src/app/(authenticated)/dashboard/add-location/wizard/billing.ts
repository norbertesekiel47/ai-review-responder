// src/app/(authenticated)/dashboard/add-location/wizard/billing.ts
//
// Pure billing math for the Add-location confirm step.

import type { BillingSnapshot } from '@/lib/accounts/quota';

export interface ProrationResult {
  prorationCents: number;
  daysRemaining: number;
  daysInMonth: number;
}

export interface NextLocationBillingPreview {
  nextOverageUnits: number;
  additionalLocationMonthlyCents: number;
  newMonthlyTotalCents: number;
}

/**
 * Computes the prorated charge for adding a location mid-billing-cycle.
 * Formula: (overagePriceCents / daysInMonth) * remainingDays
 *
 * VAL-LOC-066: proration line shows actual prorated charge.
 */
export function computeProration(
  overagePriceCents: number,
  now: Date = new Date(),
): ProrationResult {
  const year = now.getFullYear();
  const month = now.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today = now.getDate();
  const daysRemaining = Math.max(0, daysInMonth - today);

  // Proration: (overage / daysInMonth) * daysRemaining
  // Round to nearest cent
  const prorationCents = Math.round(
    (overagePriceCents / daysInMonth) * daysRemaining,
  );

  return { prorationCents, daysRemaining, daysInMonth };
}

export function computeNextLocationBillingPreview({
  activeLocationCount,
  billingSnapshot,
}: {
  activeLocationCount: number;
  billingSnapshot: BillingSnapshot;
}): NextLocationBillingPreview {
  const nextActiveLocations = activeLocationCount + 1;
  const nextOverageUnits = Math.max(
    0,
    nextActiveLocations - billingSnapshot.includedLocations,
  );
  const additionalOverageUnits = Math.max(
    0,
    nextOverageUnits - billingSnapshot.overageUnits,
  );
  const additionalLocationMonthlyCents =
    additionalOverageUnits * billingSnapshot.overagePriceCents;

  return {
    nextOverageUnits,
    additionalLocationMonthlyCents,
    newMonthlyTotalCents:
      billingSnapshot.basePriceCents +
      nextOverageUnits * billingSnapshot.overagePriceCents,
  };
}
