// src/app/api/dashboard/channels/telegram/start/route.ts
//
// POST /api/dashboard/channels/telegram/start — owner-scoped enrollment.
// Same runner as the admin route; the only difference is resolveOwnerActor,
// which reads locationId from the SESSION and never from the body.

import { NextRequest } from 'next/server';
import { sql } from '@/lib/db/server';
import { withSameOrigin } from '@/lib/auth/route-helpers';
import { channelsTelegramEnabled } from '@/lib/notifications/channels/flags';
import { assertTelegramEnvReady } from '@/lib/notifications/channels/telegram-env';
import { runChannelStart } from '@/app/api/_shared/channels/start';
import { resolveOwnerActor } from '@/app/api/_shared/channels/resolve-actor';

export const POST = withSameOrigin()((req: NextRequest) =>
  runChannelStart(sql, req, {
    channel: 'telegram',
    isEnabled: channelsTelegramEnabled,
    assertEnvReady: assertTelegramEnvReady,
    resolveActor: resolveOwnerActor,
  }),
);
