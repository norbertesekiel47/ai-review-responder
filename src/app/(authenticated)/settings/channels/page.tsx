// src/app/(authenticated)/settings/channels/page.tsx
//
// Server component for the owner channel-management page. Auth +
// subscription guard run before any UI renders. Fetches the canonical
// enrollment shape and channel availability for SSR-driven hydration.

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { createServerClient } from '@supabase/ssr';
import { sql } from '@/lib/db/server';
import { SettingsTabs } from '@/components/dashboard/SettingsTabs';
import { ChannelsClient, type InitialEnrollment } from './ChannelsClient';
import { isTelegramEnabled, assertTelegramEnvReady } from '@/app/api/admin/channels/telegram/_shared';

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
  const cookieStore = await cookies();
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll() {
          /* server component cannot set cookies */
        },
      },
    },
  );

  const { data: { user: authUser } } = await supabase.auth.getUser();
  if (!authUser) redirect('/admin/login');

  const rows = await sql<{ role: string; business_id: string; subscription_status: string; owner_email: string }[]>`
    SELECT u.role, b.id AS business_id, b.subscription_status, u.email AS owner_email
    FROM users u
    JOIN businesses b ON b.id = u.business_id
    WHERE u.auth_id = ${authUser.id}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) redirect('/admin/login');
  if (row.role !== 'owner') redirect('/admin/overview');
  if (row.subscription_status !== 'active') redirect('/onboarding/pay');

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
    WHERE e.business_id = ${row.business_id}
      AND e.archived_at IS NULL
    ORDER BY e.created_at ASC
  `;

  const initialEnrollments: InitialEnrollment[] = enrollmentRows.map((r) => ({
    channel: r.channel,
    handle: r.handle,
    status: r.status,
    verified_at: r.verified_at?.toISOString() ?? null,
    disabled_at: r.disabled_at?.toISOString() ?? null,
    unsubscribed_at: r.unsubscribed_at?.toISOString() ?? null,
    unsubscribed_reason: r.unsubscribed_reason,
    expires_at: r.expires_at?.toISOString() ?? null,
  }));

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <SettingsTabs activeTab="channels" />
      <h1 className="text-2xl font-bold text-slate-100">Notification channels</h1>
      <p className="mt-1 text-sm text-slate-400">Choose where you get review approval requests.</p>
      <div className="mt-6">
        <ChannelsClient
          initialEnrollments={initialEnrollments}
          initialAvailability={{
            telegram: telegramAvailable(),
            sms: smsAvailable(),
            whatsapp: whatsappAvailable(),
          }}
          ownerEmailFallback={row.owner_email}
        />
      </div>
    </div>
  );
}
