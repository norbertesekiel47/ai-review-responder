// src/app/(authenticated)/settings/channels/page.tsx
//
// Server component for the owner channel-management page. Auth +
// subscription guard run before any UI renders. Fetches the canonical
// enrollment shape and channel availability for SSR-driven hydration.
//
// For multi-location accounts, also fetches:
//   - Per-location channel overrides (channel_enrollments with location_id)
//   - Active locations list (for per-location override panel)
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
import { getLocationsForAccount, getActiveLocationCount } from '@/lib/locations/repo';
import { getDisplayLabel, type HasDisplayLabel } from '@/lib/locations/display-label';
import {
  shouldShowLocationsSettings,
  shouldUseMultiLocationSettings,
} from '@/lib/locations/multi-location-mode';

// 'sms' stays known: backend/admin can create SMS enrollments even though the
// owner UI has no SMS self-service yet (owner SMS is post-launch — see ChannelsClient).
const KNOWN_CHANNELS = new Set<string>(['email', 'sms', 'telegram', 'whatsapp']);

function whatsappAvailable(): boolean {
  if (process.env.CHANNELS_WHATSAPP_ENABLED !== 'true') return false;
  return whatsappEnvReady();
}

function telegramAvailable(): boolean {
  if (!isTelegramEnabled()) return false;
  return assertTelegramEnvReady() === null;
}

// ── Per-location override shape ──────────────────────────────────────────

interface PerLocationOverride {
  enrollmentId: string;
  locationId: string;
  locationName: string; // display_label ?? name
  channel: 'email' | 'sms' | 'telegram' | 'whatsapp';
  handle: string | null;
  status: string;
  verified_at: string | null;
}

interface LocationOption {
  id: string;
  displayName: string; // display_label ?? name
  isPrimary: boolean;
}

export default async function ChannelsPage() {
  const access = await requireOwnerAccess();
  const activeLocationCount = await getActiveLocationCount(access.accountId);
  const featureEnabled = process.env.MULTI_LOCATION_ENABLED === 'true';
  const multiLocationEnabled = shouldUseMultiLocationSettings(featureEnabled, activeLocationCount);
  const locationsSettingsEnabled = shouldShowLocationsSettings(featureEnabled);

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

  // Fetch ALL active enrollments (both org-level and per-location)
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
    location_id: string | null;
  }[]>`
    SELECT
      e.id, e.channel, e.handle, e.status,
      e.verified_at, e.disabled_at, e.unsubscribed_at, e.unsubscribed_reason,
      e.verification_token_expires_at AS expires_at,
      e.location_id
    FROM channel_enrollments e
    WHERE e.account_id = ${access.accountId}
      AND e.archived_at IS NULL
    ORDER BY e.location_id NULLS FIRST, e.created_at ASC
  `;

  // Separate org-level defaults from per-location overrides
  const orgLevelEnrollments: InitialEnrollment[] = [];
  const perLocationOverrides: PerLocationOverride[] = [];

  // We need location names for the overrides — fetch them
  let locationMap = new Map<string, { name: string; display_label: string | null }>();

  if (multiLocationEnabled) {
    const locations = await getLocationsForAccount(access.accountId);
    for (const loc of locations) {
      locationMap.set(loc.id, { name: loc.name, display_label: loc.display_label });
    }
  }

  for (const r of enrollmentRows) {
    if (!KNOWN_CHANNELS.has(r.channel)) continue;

    const enrollmentBase = {
      channel: r.channel as InitialEnrollment['channel'],
      handle: r.handle,
      status: r.status,
      verified_at: r.verified_at?.toISOString() ?? null,
      disabled_at: r.disabled_at?.toISOString() ?? null,
      unsubscribed_at: r.unsubscribed_at?.toISOString() ?? null,
      unsubscribed_reason: r.unsubscribed_reason,
      expires_at: r.expires_at?.toISOString() ?? null,
    };

    if (r.location_id === null) {
      // Org-level default
      orgLevelEnrollments.push(enrollmentBase);
    } else {
      // Per-location override
      const locInfo = locationMap.get(r.location_id);
      const locName = locInfo ? getDisplayLabel(locInfo as HasDisplayLabel) : r.location_id;

      perLocationOverrides.push({
        enrollmentId: r.id,
        locationId: r.location_id,
        locationName: locName,
        channel: r.channel as PerLocationOverride['channel'],
        handle: r.handle,
        status: r.status,
        verified_at: r.verified_at?.toISOString() ?? null,
      });
    }
  }

  // Build location options for the override panel
  let locationOptions: LocationOption[] = [];
  if (multiLocationEnabled) {
    const locations = await getLocationsForAccount(access.accountId);
    locationOptions = locations.map((loc) => ({
      id: loc.id,
      displayName: getDisplayLabel(loc as HasDisplayLabel),
      isPrimary: loc.is_primary,
    }));
  }

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
        perLocationOverrides={perLocationOverrides}
        locationOptions={locationOptions}
        accountId={access.accountId}
      />
    </>
  );
}
