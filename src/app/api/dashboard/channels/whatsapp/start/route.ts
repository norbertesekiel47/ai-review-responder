// src/app/api/dashboard/channels/whatsapp/start/route.ts
//
// POST /api/dashboard/channels/whatsapp/start — owner-scoped enrollment.
// Same runner as the admin route; the only difference is resolveOwnerActor,
// which reads locationId from the SESSION and never from the body.

import { NextRequest } from 'next/server';
import { sql } from '@/lib/db/server';
import { withSameOrigin } from '@/lib/auth/route-helpers';
import { channelsWhatsappEnabled } from '@/lib/notifications/channels/flags';
import { assertWhatsAppEnvReady } from '@/lib/notifications/channels/whatsapp-env';
import { runChannelStart } from '@/app/api/_shared/channels/start';
import { resolveOwnerActor } from '@/app/api/_shared/channels/resolve-actor';

export const POST = withSameOrigin()((req: NextRequest) =>
  runChannelStart(sql, req, {
    channel: 'whatsapp',
    isEnabled: channelsWhatsappEnabled,
    assertEnvReady: assertWhatsAppEnvReady,
    resolveActor: resolveOwnerActor,
  }),
);
