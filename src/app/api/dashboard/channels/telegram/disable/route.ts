// src/app/api/dashboard/channels/telegram/disable/route.ts
//
// POST /api/dashboard/channels/telegram/disable — owner-scoped disconnect.
// Handler: runChannelDisable (@/app/api/_shared/channels/action).

import { NextRequest } from 'next/server';
import { sql } from '@/lib/db/server';
import { withSameOrigin } from '@/lib/auth/route-helpers';
import { channelsTelegramEnabled } from '@/lib/notifications/channels/flags';
import { assertTelegramEnvReady } from '@/lib/notifications/channels/telegram-env';
import { runChannelDisable } from '@/app/api/_shared/channels/action';
import { resolveOwnerActor } from '@/app/api/_shared/channels/resolve-actor';

export const POST = withSameOrigin()((req: NextRequest) =>
  runChannelDisable(sql, req, {
    channel: 'telegram',
    isEnabled: channelsTelegramEnabled,
    assertEnvReady: assertTelegramEnvReady,
    resolveActor: resolveOwnerActor,
  }),
);
