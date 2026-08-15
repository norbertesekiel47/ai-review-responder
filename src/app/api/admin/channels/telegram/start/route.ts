// src/app/api/admin/channels/telegram/start/route.ts
//
// POST /api/admin/channels/telegram/start — admin generates a one-time Telegram
// verification deep link + QR for owner scan.
//
// The full handler lives in the shared runChannelStart
// (@/app/api/_shared/channels/start); this route supplies only the Telegram +
// admin bindings. The owner equivalent at /api/dashboard/channels/telegram/start
// binds the same runner with resolveOwnerActor.

import { NextRequest } from 'next/server';
import { sql } from '@/lib/db/server';
import { withSameOrigin } from '@/lib/auth/route-helpers';
import { channelsTelegramEnabled } from '@/lib/notifications/channels/flags';
import { assertTelegramEnvReady } from '@/lib/notifications/channels/telegram-env';
import { runChannelStart } from '@/app/api/_shared/channels/start';
import { resolveAdminActor } from '@/app/api/_shared/channels/resolve-actor';

export const POST = withSameOrigin()((req: NextRequest) =>
  runChannelStart(sql, req, {
    channel: 'telegram',
    isEnabled: channelsTelegramEnabled,
    assertEnvReady: assertTelegramEnvReady,
    // Enrollment is a paid mutation — admin start keeps its strict gate (§4.2).
    resolveActor: (db, request) => resolveAdminActor(db, request, { requireFullAccess: true }),
  }),
);
