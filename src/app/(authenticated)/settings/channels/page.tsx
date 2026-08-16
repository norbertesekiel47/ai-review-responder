// src/app/(authenticated)/settings/channels/page.tsx
//
// Server component for the owner channel-management page. Auth +
// subscription guard run before any UI renders. Fetches the canonical
// org-level enrollment shape and channel availability for SSR-driven
// hydration, plus the per-location override view (overrides + locations +
// verified org channels) from its single owner, getChannelOverridesView.
//
// VAL-SETTINGS-012: Channels tab shows org-level defaults at top.
// VAL-SETTINGS-013: Per-location override panel collapsed by default.
// VAL-SETTINGS-032: Channels tab org-default section shows only Telegram and email.

import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
import { sql } from '@/lib/db/server';
import { requireOwnerAccess } from '@/lib/auth/require-owner-access';
import { TopBar } from '@/components/dashboard/shell/TopBar';
import { type InitialEnrollment } from './ChannelsClient';
import { ChannelsTabClient } from './ChannelsTabClient';
import {
  telegramAvailable,
  whatsappAvailable,
} from '@/lib/notifications/channels/availability';
import { getChannelOverridesView } from '@/lib/channels/overrides-view';
import { getOrgDefaultChannelEnrollments } from '@/lib/channels/org-default-enrollments';
import { shouldUseMultiLocationSettings } from '@/lib/locations/multi-location-mode';
import { multiLocationEnabled as isMultiLocationEnabled } from '@/lib/locations/flags';

function isoOrNull(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

export default async function ChannelsPage() {
  const access = await requireOwnerAccess(sql);

  // One owner for the override surface: overrides + locations (active AND
  // archived, one query) + verified org channels.
  const overridesView = await getChannelOverridesView(sql, access.accountId);
  const activeLocations = overridesView.locations.filter((location) => !location.archived);

  const featureEnabled = isMultiLocationEnabled();
  const multiLocationEnabled = shouldUseMultiLocationSettings(featureEnabled, activeLocations.length);
  const canAddOverrides = multiLocationEnabled && activeLocations.length > 1;

  // Get the owner's email for the email enrollment fallback.
  const cookieStore = await cookies();
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return cookieStore.getAll(); },
        setAll() {},
      },
    },
  );
  const { data: { user: authUser } } = await supabase.auth.getUser();
  const ownerEmail = authUser?.email ?? '';

  // Org-level defaults (location_id IS NULL) from their single owner — the same
  // read GET /api/dashboard/channels serves, so SSR and the status endpoint
  // cannot disagree. Per-location overrides come from the override view above.
  const enrollmentRows = await getOrgDefaultChannelEnrollments(sql, access.accountId);

  const orgLevelEnrollments: InitialEnrollment[] = enrollmentRows.map((r) => ({
    channel: r.channel as InitialEnrollment['channel'],
    handle: r.handle,
    status: r.status,
    verified_at: isoOrNull(r.verified_at),
    disabled_at: isoOrNull(r.disabled_at),
    unsubscribed_at: isoOrNull(r.unsubscribed_at),
    unsubscribed_reason: r.unsubscribed_reason,
    expires_at: isoOrNull(r.expires_at),
  }));

  return (
    <>
      <TopBar
        title="Settings"
        subtitle="Notification channels"
        rightLink={{ href: '/dashboard', label: 'Back to dashboard' }}
      />
      <ChannelsTabClient
        initialEnrollments={orgLevelEnrollments}
        initialAvailability={{
          telegram: telegramAvailable(),
          whatsapp: whatsappAvailable(),
        }}
        ownerEmailFallback={ownerEmail}
        canAddOverrides={canAddOverrides}
        perLocationOverrides={overridesView.overrides}
        locationOptions={activeLocations}
        verifiedOrgChannels={overridesView.verifiedOrgChannels}
      />
    </>
  );
}
