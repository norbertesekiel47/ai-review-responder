// src/app/api/admin/channels/whatsapp/start/route.ts
//
// POST /api/admin/channels/whatsapp/start — admin generates a one-time WhatsApp
// verification deep link + QR for owner scan via wa.me click-to-chat.
//
// The full handler (flag/env → admin auth → businessId → active-subscription
// account → advisory-locked enrollment upsert → QR response) lives in the
// shared runAdminChannelStart; this route supplies the WhatsApp bindings.
// State machine logic lives in src/lib/channels/mobile-enrollment.ts.
//
// Subscription gate: strict 'active' status. Dispatcher honors past_due grace at
// send time; admin enrollment mutations during grace require explicit active.

import { NextRequest } from 'next/server';
import { isWhatsAppEnabled, flagOff, assertWhatsAppEnvReady } from '../_shared';
import { withSameOrigin } from '@/lib/auth/route-helpers';
import { runAdminChannelStart } from '@/app/api/admin/channels/_shared/start';
import { getServerConfig } from '@/lib/config/server';

function buildWhatsAppDeepLink(rawToken: string): string {
  // wa.me requires digits only (no +, no whatsapp:) per WhatsApp click-to-chat.
  const digits = getServerConfig().TWILIO_WHATSAPP_NUMBER!.replace(/^whatsapp:\+?/, '');
  const prefilled = encodeURIComponent(`start-${rawToken}`);
  return `https://wa.me/${digits}?text=${prefilled}`;
}

export const POST = withSameOrigin()((req: NextRequest) =>
  runAdminChannelStart(req, {
    channel: 'whatsapp',
    isEnabled: isWhatsAppEnabled,
    flagOff,
    assertEnvReady: assertWhatsAppEnvReady,
    buildDeepLink: buildWhatsAppDeepLink,
    cacheLabel: 'admin.whatsapp.start',
    endpoint: 'whatsapp/start',
  }),
);
