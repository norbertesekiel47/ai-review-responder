// src/app/api/admin/channels/telegram/cancel/route.ts
//
// POST /api/admin/channels/telegram/cancel — admin cancels a pending Telegram
// verification. The full handler (flag/env → admin auth → businessId →
// advisory-locked cancel → cache invalidation) lives in the shared
// runAdminChannelCancel; this route supplies the Telegram bindings.

import { NextRequest } from 'next/server';
import { isTelegramEnabled, flagOff, assertTelegramEnvReady } from '../_shared';
import { withSameOrigin } from '@/lib/auth/route-helpers';
import { runAdminChannelCancel } from '@/app/api/admin/channels/_shared/action';

export const POST = withSameOrigin()((req: NextRequest) =>
  runAdminChannelCancel(req, {
    channel: 'telegram',
    isEnabled: isTelegramEnabled,
    flagOff,
    assertEnvReady: assertTelegramEnvReady,
  }),
);
