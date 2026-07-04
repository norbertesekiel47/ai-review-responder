import { cookies } from 'next/headers';
import { sql } from '@/lib/db/server';
import { requireOwnerAccess } from '@/lib/auth/require-owner-access';
import { IMPERSONATION_COOKIE_NAME } from '@/lib/admin/impersonation/cookie';
import { getAutoApprovalSettings } from '@/lib/auto-approval/settings';
import { TopBar } from '@/components/dashboard/shell/TopBar';
import { AutoApprovalClient } from './AutoApprovalClient';

export const dynamic = 'force-dynamic';

export default async function AutoApprovalSettingsPage() {
  const [access, cookieStore] = await Promise.all([
    requireOwnerAccess(sql),
    cookies(),
  ]);
  const impersonated = Boolean(cookieStore.get(IMPERSONATION_COOKIE_NAME)?.value);
  const initialState = await getAutoApprovalSettings({
    accountId: access.accountId,
    impersonated,
  });

  return (
    <>
      <TopBar
        title="Auto-approval"
        subtitle="Set which review ratings can skip owner review after all safety checks pass."
        rightLink={{ href: '/dashboard', label: 'Back to dashboard' }}
      />
      <AutoApprovalClient
        initialState={initialState}
      />
    </>
  );
}
