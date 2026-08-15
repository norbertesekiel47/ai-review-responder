// src/app/api/admin/channels/whatsapp/start/route.ts
//
// POST /api/admin/channels/whatsapp/start — admin generates a one-time WhatsApp
// verification deep link + QR for owner scan via wa.me click-to-chat.
//
// The full handler lives in the shared runChannelStart
// (@/app/api/_shared/channels/start); this route supplies only the WhatsApp +
// admin bindings.
//
// Subscription gate: strict full-access status. Dispatcher honors past_due grace
// at send time; admin enrollment mutations during grace require explicit active.

import { NextRequest } from 'next/server';
import { sql } from '@/lib/db/server';
import { withSameOrigin } from '@/lib/auth/route-helpers';
import { channelsWhatsappEnabled } from '@/lib/notifications/channels/flags';
import { assertWhatsAppEnvReady } from '@/lib/notifications/channels/whatsapp-env';
import { runChannelStart } from '@/app/api/_shared/channels/start';
import { resolveAdminActor } from '@/app/api/_shared/channels/resolve-actor';

export const POST = withSameOrigin()((req: NextRequest) =>
  runChannelStart(sql, req, {
    channel: 'whatsapp',
    isEnabled: channelsWhatsappEnabled,
    assertEnvReady: assertWhatsAppEnvReady,
    resolveActor: (db, request) => resolveAdminActor(db, request, { requireFullAccess: true }),
  }),
);
