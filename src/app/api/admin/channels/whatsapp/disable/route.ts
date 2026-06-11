// src/app/api/admin/channels/whatsapp/disable/route.ts
//
// POST /api/admin/channels/whatsapp/disable — admin disables a verified
// WhatsApp enrollment (404 when there's nothing to disable). The full handler
// lives in the shared runAdminChannelDisable; this route supplies the WhatsApp
// bindings. The disable cascade itself is owned by disconnectChannel.

import { NextRequest } from 'next/server';
import { isWhatsAppEnabled, flagOff, assertWhatsAppEnvReady } from '../_shared';
import { withSameOrigin } from '@/lib/auth/route-helpers';
import { runAdminChannelDisable } from '@/app/api/admin/channels/_shared/action';

export const POST = withSameOrigin()((req: NextRequest) =>
  runAdminChannelDisable(req, {
    channel: 'whatsapp',
    isEnabled: isWhatsAppEnabled,
    flagOff,
    assertEnvReady: assertWhatsAppEnvReady,
  }),
);
