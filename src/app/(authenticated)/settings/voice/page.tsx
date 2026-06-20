// src/app/(authenticated)/settings/voice/page.tsx
//
// Server component for the Brand Voice settings route. Account-scoped:
// single-location accounts return one voice config (no location selector),
// multi-location accounts get the per-location selector in VoiceClient.

import { requireOwnerAccess } from '@/lib/auth/require-owner-access';
import { TopBar } from '@/components/dashboard/shell/TopBar';
import { VoiceClient } from './VoiceClient';

export const dynamic = 'force-dynamic';

export default async function VoicePage() {
  await requireOwnerAccess();
  return (
    <>
      <TopBar
        title="Brand Voice"
        subtitle="How RepWorth writes replies for your business."
        rightLink={{ href: '/dashboard', label: 'Back to dashboard' }}
      />
      <VoiceClient />
    </>
  );
}
