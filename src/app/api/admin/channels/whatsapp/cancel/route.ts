// src/app/api/admin/channels/whatsapp/cancel/route.ts
//
// POST /api/admin/channels/whatsapp/cancel — admin cancels a pending WhatsApp
// verification. Handler: runChannelCancel (@/app/api/_shared/channels/action).

import { NextRequest } from 'next/server';
import { sql } from '@/lib/db/server';
import { withSameOrigin } from '@/lib/auth/route-helpers';
import { channelsWhatsappEnabled } from '@/lib/notifications/channels/flags';
import { assertWhatsAppEnvReady } from '@/lib/notifications/channels/whatsapp-env';
import { runChannelCancel } from '@/app/api/_shared/channels/action';
import { resolveAdminActor } from '@/app/api/_shared/channels/resolve-actor';

export const POST = withSameOrigin()((req: NextRequest) =>
  runChannelCancel(sql, req, {
    channel: 'whatsapp',
    isEnabled: channelsWhatsappEnabled,
    assertEnvReady: assertWhatsAppEnvReady,
    // No subscription gate: an admin must be able to tear down an enrollment on
    // a lapsed account (§4.2).
    resolveActor: (db, request) => resolveAdminActor(db, request, { requireFullAccess: false }),
  }),
);
