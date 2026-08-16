// src/app/(authenticated)/settings/voice/page.tsx
//
// Server component for the Brand Voice settings route. Account-scoped:
// single-location accounts return one voice config (no location selector),
// multi-location accounts get the per-location selector in VoiceClient.
//
// Multi-location MODE is resolved HERE and handed down as a prop, exactly as
// settings/channels/page.tsx does it. Two invariants meet on this line:
//   #9b — mode is `shouldUseMultiLocationSettings` (flag AND count > 1) and is
//         never re-derived from a bare location count;
//   #13 — the flag is server-authoritative, so the browser receives the
//         resolved boolean and never learns the flag itself.

import { sql } from '@/lib/db/server';
import { requireOwnerAccess } from '@/lib/auth/require-owner-access';
import { TopBar } from '@/components/dashboard/shell/TopBar';
import { getActiveLocationCount } from '@/lib/locations/repo';
import { shouldUseMultiLocationSettings } from '@/lib/locations/multi-location-mode';
import { multiLocationEnabled as isMultiLocationEnabled } from '@/lib/locations/flags';
import { VoiceClient } from './VoiceClient';

export const dynamic = 'force-dynamic';

export default async function VoicePage() {
  const access = await requireOwnerAccess(sql);
  const activeLocationCount = await getActiveLocationCount(sql, access.accountId);
  const multiLocationEnabled = shouldUseMultiLocationSettings(
    isMultiLocationEnabled(),
    activeLocationCount,
  );

  return (
    <>
      <TopBar
        title="Brand Voice"
        subtitle="How RepWorth writes replies for your business."
        rightLink={{ href: '/dashboard', label: 'Back to dashboard' }}
      />
      <VoiceClient multiLocationEnabled={multiLocationEnabled} />
    </>
  );
}
