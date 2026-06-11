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
import { isTelegramEnabled, assertTelegramEnvReady } from '@/app/api/admin/channels/telegram/_shared';
import { whatsappEnvReady } from '@/app/api/admin/channels/whatsapp/_shared';
import { getChannelOverridesView } from '@/lib/channels/overrides-view';
import { CHANNEL_IDS } from '@/lib/notifications/channels/types';
import {
  shouldShowLocationsSettings,
  shouldUseMultiLocationSettings,
} from '@/lib/locations/multi-location-mode';

function isoOrNull(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function whatsappAvailable(): boolean {
  if (process.env.CHANNELS_WHATSAPP_ENABLED !== 'true') return false;
  return whatsappEnvReady();
}

function telegramAvailable(): boolean {
  if (!isTelegramEnabled()) return false;
  return assertTelegramEnvReady() === null;
}

export default async function ChannelsPage() {
  const access = await requireOwnerAccess();

  // One owner for the override surface: overrides + locations (active AND
  // archived, one query) + verified org channels.
  const overridesView = await getChannelOverridesView(access.accountId);
  const activeLocations = overridesView.locations.filter((location) => !location.archived);

  const featureEnabled = process.env.MULTI_LOCATION_ENABLED === 'true';
  const multiLocationEnabled = shouldUseMultiLocationSettings(featureEnabled, activeLocations.length);
  const locationsSettingsEnabled = shouldShowLocationsSettings(featureEnabled);
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

  // Org-level defaults (location_id IS NULL) — per-location overrides come
  // from the override view above.
  const enrollmentRows = await sql<{
    id: string;
    channel: string;
    handle: string | null;
    status: string;
    verified_at: Date | null;
    disabled_at: Date | null;
    unsubscribed_at: Date | null;
    unsubscribed_reason: string | null;
    expires_at: Date | null;
  }[]>`
    SELECT
      e.id, e.channel, e.handle, e.status,
      e.verified_at, e.disabled_at, e.unsubscribed_at, e.unsubscribed_reason,
      e.verification_token_expires_at AS expires_at
    FROM channel_enrollments e
    WHERE e.account_id = ${access.accountId}
      AND e.archived_at IS NULL
      AND e.location_id IS NULL
      AND e.channel = ANY(${[...CHANNEL_IDS] as string[]}::text[])
    ORDER BY e.created_at ASC
  `;

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
        multiLocationEnabled={multiLocationEnabled}
        locationsSettingsEnabled={locationsSettingsEnabled}
        canAddOverrides={canAddOverrides}
        perLocationOverrides={overridesView.overrides}
        locationOptions={activeLocations}
        verifiedOrgChannels={overridesView.verifiedOrgChannels}
      />
    </>
  );
}
