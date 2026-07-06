// src/app/api/admin/channels/whatsapp/cancel/route.ts
//
// POST /api/admin/channels/whatsapp/cancel — admin cancels a pending WhatsApp
// verification, clearing the token hash + expiry. The full handler (flag/env →
// admin auth → businessId → advisory-locked cancel → cache invalidation) lives
// in the shared runAdminChannelCancel; this route supplies the WhatsApp
// bindings.

import { NextRequest } from 'next/server';
import { sql } from '@/lib/db/server';
import { isWhatsAppEnabled, flagOff, assertWhatsAppEnvReady } from '../_shared';
import { withSameOrigin } from '@/lib/auth/route-helpers';
import { runAdminChannelCancel } from '@/app/api/admin/channels/_shared/action';

export const POST = withSameOrigin()((req: NextRequest) =>
  runAdminChannelCancel(sql, req, {
    channel: 'whatsapp',
    isEnabled: isWhatsAppEnabled,
    flagOff,
    assertEnvReady: assertWhatsAppEnvReady,
  }),
);
