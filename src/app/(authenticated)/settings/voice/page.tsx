// src/app/(authenticated)/settings/voice/page.tsx
//
// Server component for the Brand Voice settings route. Account-scoped:
// single-location accounts return one voice config (no location selector),
// multi-location accounts get the per-location selector in VoiceClient.

import { sql } from '@/lib/db/server';
import { requireOwnerAccess } from '@/lib/auth/require-owner-access';
import { TopBar } from '@/components/dashboard/shell/TopBar';
import { VoiceClient } from './VoiceClient';
// PROTOTYPE (ticket #536) — throwaway import, remove with the prototype branch.
import { VoiceReportCardPrototype } from './VoiceReportCardPrototype';

export const dynamic = 'force-dynamic';

export default async function VoicePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireOwnerAccess(sql);

  // PROTOTYPE (ticket #536): ?variant= renders the throwaway Voice Report
  // Card variants instead of the real Brand Voice settings. Dev-only.
  const params = await searchParams;
  if (typeof params.variant === 'string' && process.env.NODE_ENV !== 'production') {
    return (
      <>
        <TopBar
          title="Voice Report Card (prototype)"
          subtitle="Throwaway variants for ticket #536 — ?variant=A|B|C, ?state=learned|empty."
          rightLink={{ href: '/dashboard', label: 'Back to dashboard' }}
        />
        <VoiceReportCardPrototype />
      </>
    );
  }

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
