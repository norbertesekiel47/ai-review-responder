// src/app/(authenticated)/settings/channels/page.tsx
//
// Server component for the owner channel-management page. Auth +
// subscription guard run before any UI renders. Fetches the canonical
// enrollment shape and channel availability for SSR-driven hydration.

import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
import { sql } from '@/lib/db/server';
import { requireOwnerAccess } from '@/lib/auth/require-owner-access';
import { TopBar } from '@/components/dashboard/TopBar';
import { type InitialEnrollment } from './ChannelsClient';
import { ChannelsTabClient } from './ChannelsTabClient';
import { isTelegramEnabled, assertTelegramEnvReady } from '@/app/api/admin/channels/telegram/_shared';

const KNOWN_CHANNELS = new Set<string>(['email', 'sms', 'telegram', 'whatsapp']);

function smsAvailable(): boolean {
  if (process.env.CHANNELS_SMS_ENABLED !== 'true') return false;
  if (process.env.MOCK_EXTERNAL_APIS === 'true') return true;
  const required = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_MESSAGING_SERVICE_SID', 'TWILIO_VERIFY_SERVICE_SID'];
  return required.every((k) => process.env[k] && process.env[k]!.trim().length > 0);
}

function whatsappAvailable(): boolean {
  if (process.env.CHANNELS_WHATSAPP_ENABLED !== 'true') return false;
  if (process.env.MOCK_EXTERNAL_APIS === 'true') return true;
  const required = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_WHATSAPP_NUMBER', 'WHATSAPP_APPROVAL_TEMPLATE_SID'];
  return required.every((k) => process.env[k] && process.env[k]!.trim().length > 0);
}

function telegramAvailable(): boolean {
  if (!isTelegramEnabled()) return false;
  return assertTelegramEnvReady() === null;
}

export default async function ChannelsPage() {
  const access = await requireOwnerAccess();

  // Get the owner's email for the email enrollment fallback.
  // requireOwnerAccess() no longer returns email (VAL-AUTH-023 shape change).
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

  // verification_token_hash INTENTIONALLY excluded from SELECT.
  const enrollmentRows = await sql<{
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
      e.channel, e.handle, e.status,
      e.verified_at, e.disabled_at, e.unsubscribed_at, e.unsubscribed_reason,
      e.verification_token_expires_at AS expires_at
    FROM channel_enrollments e
    WHERE e.account_id = ${access.accountId}
      AND e.archived_at IS NULL
    ORDER BY e.created_at ASC
  `;

  const initialEnrollments: InitialEnrollment[] = enrollmentRows
    .filter((r) => KNOWN_CHANNELS.has(r.channel))
    .map((r) => ({
      channel: r.channel as InitialEnrollment['channel'],
      handle: r.handle,
      status: r.status,
      verified_at: r.verified_at?.toISOString() ?? null,
      disabled_at: r.disabled_at?.toISOString() ?? null,
      unsubscribed_at: r.unsubscribed_at?.toISOString() ?? null,
      unsubscribed_reason: r.unsubscribed_reason,
      expires_at: r.expires_at?.toISOString() ?? null,
    }));

  return (
    <>
      <TopBar
        title="Settings"
        subtitle="Notification channels"
        rightLink={{ href: '/dashboard', label: 'Back to dashboard' }}
      />
      <ChannelsTabClient
        initialEnrollments={initialEnrollments}
        initialAvailability={{
          telegram: telegramAvailable(),
          sms: smsAvailable(),
          whatsapp: whatsappAvailable(),
        }}
        ownerEmailFallback={ownerEmail}
      />
    </>
  );
}
