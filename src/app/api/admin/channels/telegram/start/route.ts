// src/app/api/admin/channels/telegram/start/route.ts
//
// POST /api/admin/channels/telegram/start — admin generates a one-time Telegram
// verification deep link + QR for owner scan.
//
// The full handler (flag/env → admin auth → businessId → active-subscription
// account → advisory-locked enrollment upsert → QR response) lives in the
// shared runAdminChannelStart; this route supplies the Telegram bindings.
// State machine logic lives in src/lib/channels/mobile-enrollment.ts and is
// shared with the owner route at /api/dashboard/channels/telegram/start.

import { NextRequest } from 'next/server';
import { sql } from '@/lib/db/server';
import { isTelegramEnabled, flagOff, assertTelegramEnvReady } from '../_shared';
import { withSameOrigin } from '@/lib/auth/route-helpers';
import { runAdminChannelStart } from '@/app/api/admin/channels/_shared/start';
import { getServerConfig } from '@/lib/config/server';

function buildTelegramDeepLink(rawToken: string): string {
  // `||` (not `??`) so a blank TELEGRAM_BOT_USERNAME falls back too. The var is
  // declared `rawOpt` (src/lib/config/server.ts), which preserves ''/'   '
  // byte-for-byte, so `??` would emit a broken https://t.me/?start=... link.
  // Mirrors the owner route at api/dashboard/channels/telegram/start.
  const botUsername = getServerConfig().TELEGRAM_BOT_USERNAME?.trim() || 'RepWorthBot';
  return `https://t.me/${botUsername}?start=${rawToken}`;
}

export const POST = withSameOrigin()((req: NextRequest) =>
  runAdminChannelStart(sql, req, {
    channel: 'telegram',
    isEnabled: isTelegramEnabled,
    flagOff,
    assertEnvReady: assertTelegramEnvReady,
    buildDeepLink: buildTelegramDeepLink,
    cacheLabel: 'admin.telegram.start',
    endpoint: 'telegram/start',
  }),
);
