// src/app/(authenticated)/settings/voice/page.tsx
//
// Server component for the Voice tab in Settings.
// Only rendered when MULTI_LOCATION_ENABLED is true.
// When the flag is off, voice config stays on the main /settings page.
//
// VAL-SETTINGS-017: Voice tab renders per-location voice config sections.
// VAL-SETTINGS-036: Voice tab for single-location account when MULTI_LOCATION_ENABLED=true.

import { notFound } from 'next/navigation';
import { requireOwnerAccess } from '@/lib/auth/require-owner-access';
import { TopBar } from '@/components/dashboard/TopBar';
import { VoiceClient } from './VoiceClient';
import { getActiveLocationCount } from '@/lib/locations/repo';
import { shouldUseMultiLocationSettings } from '@/lib/locations/multi-location-mode';

export const dynamic = 'force-dynamic';

export default async function VoicePage() {
  // Gate by MULTI_LOCATION_ENABLED
  if (process.env.MULTI_LOCATION_ENABLED !== 'true') {
    notFound();
  }

  const access = await requireOwnerAccess();
  const activeLocationCount = await getActiveLocationCount(access.accountId);
  if (!shouldUseMultiLocationSettings(true, activeLocationCount)) {
    notFound();
  }

  return (
    <>
      <TopBar
        title="Settings"
        subtitle="Voice"
        rightLink={{ href: '/dashboard', label: 'Back to dashboard' }}
      />
      <VoiceClient />
    </>
  );
}
