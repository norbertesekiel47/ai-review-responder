// src/app/api/admin/channels/telegram/disable/route.ts
//
// POST /api/admin/channels/telegram/disable — admin disables a verified
// Telegram enrollment (404 when there's nothing to disable). The full handler
// lives in the shared runAdminChannelDisable; this route supplies the Telegram
// bindings. The disable cascade itself is owned by disconnectChannel.

import { NextRequest } from 'next/server';
import { isTelegramEnabled, flagOff, assertTelegramEnvReady } from '../_shared';
import { withSameOrigin } from '@/lib/auth/route-helpers';
import { runAdminChannelDisable } from '@/app/api/admin/channels/_shared/action';

export const POST = withSameOrigin()((req: NextRequest) =>
  runAdminChannelDisable(req, {
    channel: 'telegram',
    isEnabled: isTelegramEnabled,
    flagOff,
    assertEnvReady: assertTelegramEnvReady,
  }),
);
