import { cookies } from 'next/headers';
import { requireOwnerAccess } from '@/lib/auth/require-owner-access';
import { IMPERSONATION_COOKIE_NAME } from '@/lib/admin/impersonation/cookie';
import { getAutoApprovalSettings } from '@/lib/auto-approval/settings';
import { getActiveLocationCount } from '@/lib/locations/repo';
import {
  shouldShowLocationsSettings,
  shouldUseMultiLocationSettings,
} from '@/lib/locations/multi-location-mode';
import { TopBar } from '@/components/dashboard/shell/TopBar';
import { AutoApprovalClient } from './AutoApprovalClient';

export const dynamic = 'force-dynamic';

export default async function AutoApprovalSettingsPage() {
  const [access, cookieStore] = await Promise.all([
    requireOwnerAccess(),
    cookies(),
  ]);
  const impersonated = Boolean(cookieStore.get(IMPERSONATION_COOKIE_NAME)?.value);
  const [activeLocationCount, initialState] = await Promise.all([
    getActiveLocationCount(access.accountId),
    getAutoApprovalSettings({
      accountId: access.accountId,
      impersonated,
    }),
  ]);
  const featureEnabled = process.env.MULTI_LOCATION_ENABLED === 'true';
  const multiLocationEnabled = shouldUseMultiLocationSettings(featureEnabled, activeLocationCount);
  const locationsSettingsEnabled = shouldShowLocationsSettings(featureEnabled);

  return (
    <>
      <TopBar
        title="Auto-approval"
        subtitle="Set which review ratings can skip owner review after all safety checks pass."
        rightLink={{ href: '/dashboard', label: 'Back to dashboard' }}
      />
      <AutoApprovalClient
        initialState={initialState}
        locationsSettingsEnabled={locationsSettingsEnabled}
        multiLocationEnabled={multiLocationEnabled}
      />
    </>
  );
}
