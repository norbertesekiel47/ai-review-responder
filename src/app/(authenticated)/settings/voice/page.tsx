// src/app/(authenticated)/settings/voice/page.tsx
//
// Server component for the Voice tab in Settings.
// Only rendered when MULTI_LOCATION_ENABLED is true.
// When the flag is off, voice config stays on the main /settings page.
//
// VAL-SETTINGS-017: Voice tab renders per-location voice config sections.

import { notFound } from 'next/navigation';
import { requireOwnerAccess } from '@/lib/auth/require-owner-access';
import { TopBar } from '@/components/dashboard/TopBar';
import { VoiceClient } from './VoiceClient';

export const dynamic = 'force-dynamic';

export default async function VoicePage() {
  // Gate by MULTI_LOCATION_ENABLED
  if (process.env.MULTI_LOCATION_ENABLED !== 'true') {
    notFound();
  }

  await requireOwnerAccess();

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
