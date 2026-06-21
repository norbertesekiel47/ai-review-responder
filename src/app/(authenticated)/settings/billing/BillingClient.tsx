'use client';

import { useAccountData } from '@/hooks/useAccountData';
import { BillingPanel } from '@/components/dashboard/settings/BillingPanel';

export function BillingClient() {
  const account = useAccountData();
  return (
    <BillingPanel
      accountData={account.data}
      accountLoading={account.loading}
      accountError={account.error}
      onAccountRefetch={account.refetch}
    />
  );
}
