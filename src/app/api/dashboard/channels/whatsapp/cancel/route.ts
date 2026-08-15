// src/app/api/dashboard/channels/whatsapp/cancel/route.ts
//
// POST /api/dashboard/channels/whatsapp/cancel — owner-scoped cancel of a
// pending verification. Handler: runChannelCancel (@/app/api/_shared/channels/action).

import { NextRequest } from 'next/server';
import { sql } from '@/lib/db/server';
import { withSameOrigin } from '@/lib/auth/route-helpers';
import { channelsWhatsappEnabled } from '@/lib/notifications/channels/flags';
import { assertWhatsAppEnvReady } from '@/lib/notifications/channels/whatsapp-env';
import { runChannelCancel } from '@/app/api/_shared/channels/action';
import { resolveOwnerActor } from '@/app/api/_shared/channels/resolve-actor';

export const POST = withSameOrigin()((req: NextRequest) =>
  runChannelCancel(sql, req, {
    channel: 'whatsapp',
    isEnabled: channelsWhatsappEnabled,
    assertEnvReady: assertWhatsAppEnvReady,
    resolveActor: resolveOwnerActor,
  }),
);
