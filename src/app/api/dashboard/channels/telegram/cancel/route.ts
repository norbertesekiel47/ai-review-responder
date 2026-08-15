// src/app/api/dashboard/channels/telegram/cancel/route.ts
//
// POST /api/dashboard/channels/telegram/cancel — owner-scoped cancel of a
// pending verification. Handler: runChannelCancel (@/app/api/_shared/channels/action).

import { NextRequest } from 'next/server';
import { sql } from '@/lib/db/server';
import { withSameOrigin } from '@/lib/auth/route-helpers';
import { channelsTelegramEnabled } from '@/lib/notifications/channels/flags';
import { assertTelegramEnvReady } from '@/lib/notifications/channels/telegram-env';
import { runChannelCancel } from '@/app/api/_shared/channels/action';
import { resolveOwnerActor } from '@/app/api/_shared/channels/resolve-actor';

export const POST = withSameOrigin()((req: NextRequest) =>
  runChannelCancel(sql, req, {
    channel: 'telegram',
    isEnabled: channelsTelegramEnabled,
    assertEnvReady: assertTelegramEnvReady,
    resolveActor: resolveOwnerActor,
  }),
);
