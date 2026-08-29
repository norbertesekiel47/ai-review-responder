'use client';

import { useAccountData } from '@/hooks/useAccountData';
import { BillingPanel } from '@/components/dashboard/settings/BillingPanel';
import { TrialBanner } from '@/components/dashboard/account-state/SubscriptionStatusBanner';
import { SubscriptionStatus } from '@/lib/shared/subscription-status';

export function BillingClient() {
  const account = useAccountData();
  const subscription = account.data?.subscription;
  // The trial notice moved here from the dashboard overview (owner decision,
  // 2026-08-29). It states days left, the charge date, and how to manage the
  // subscription — every one of those is a billing fact, and the banner's own
  // copy used to link to THIS page.
  //
  // The gate is stricter than the dashboard's was. That one keyed on
  // `trialEndsAt` alone; here the status is already loaded, so the banner asks
  // for `trialing` as well. A `trial_ends_at` that outlives the trial — a
  // converted account keeps the timestamp — can no longer show a countdown for a
  // trial that already ended. `BillingPanel` derives its own `trialing` prop the
  // same way one level down.
  const trialEndsAt =
    subscription?.status === SubscriptionStatus.TRIALING ? subscription.trialEndsAt : null;
  return (
    <>
      {trialEndsAt && <TrialBanner trialEndsAt={trialEndsAt} />}
      <BillingPanel
        accountData={account.data}
        accountLoading={account.loading}
        accountError={account.error}
        onAccountRefetch={account.refetch}
      />
    </>
  );
}
