// src/app/api/dashboard/channels/whatsapp/disable/route.ts
//
// POST /api/dashboard/channels/whatsapp/disable — owner-scoped disconnect.
// Handler: runChannelDisable (@/app/api/_shared/channels/action).

import { NextRequest } from 'next/server';
import { sql } from '@/lib/db/server';
import { withSameOrigin } from '@/lib/auth/route-helpers';
import { channelsWhatsappEnabled } from '@/lib/notifications/channels/flags';
import { assertWhatsAppEnvReady } from '@/lib/notifications/channels/whatsapp-env';
import { runChannelDisable } from '@/app/api/_shared/channels/action';
import { resolveOwnerActor } from '@/app/api/_shared/channels/resolve-actor';

export const POST = withSameOrigin()((req: NextRequest) =>
  runChannelDisable(sql, req, {
    channel: 'whatsapp',
    isEnabled: channelsWhatsappEnabled,
    assertEnvReady: assertWhatsAppEnvReady,
    resolveActor: resolveOwnerActor,
  }),
);
