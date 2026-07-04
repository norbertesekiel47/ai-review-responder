import { sql } from '@/lib/db/server';
import { requireOwnerAccess } from '@/lib/auth/require-owner-access';
import { TopBar } from '@/components/dashboard/shell/TopBar';
import { BillingClient } from './BillingClient';

export default async function BillingPage() {
  await requireOwnerAccess(sql);
  return (
    <>
      <TopBar
        title="Billing"
        subtitle="Your plan, location quota, and subscription."
        rightLink={{ href: '/dashboard', label: 'Back to dashboard' }}
      />
      <BillingClient />
    </>
  );
}
