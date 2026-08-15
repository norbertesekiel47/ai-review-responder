// src/lib/notifications/channels/deep-links.ts
//
// Single owner of the mobile-channel enrollment deep link. Both portals and both
// channels resolve through buildMobileDeepLink, which is what makes a per-portal
// copy of these expressions unspellable — the bug class this exists to close.
// The per-portal copies diverged twice historically: Telegram's blank-username
// fallback (`??` vs `||`) — already closed in PR 1, which is why both current
// routes agree — and WhatsApp's number normalisation (`/^whatsapp:\+?/` vs
// `/\D/g`), still open at the time of writing and closed here.
//
// The Record<MobileChannel, …> makes this exhaustive: adding a mobile channel
// forces a deep-link decision at THIS one site.

import type { MobileChannel } from '@/lib/channels/mobile-enrollment';
import { getServerConfig } from '@/lib/config/server';

const BUILDERS: Record<MobileChannel, (rawToken: string) => string> = {
  telegram: (rawToken) => {
    // `||` (not `??`) so a blank TELEGRAM_BOT_USERNAME falls back too. The var is
    // declared `rawOpt` (src/lib/config/server.ts), which preserves ''/'   '
    // byte-for-byte, so `??` would emit a broken https://t.me/?start=... link.
    const botUsername = getServerConfig().TELEGRAM_BOT_USERNAME?.trim() || 'RepWorthBot';
    return `https://t.me/${botUsername}?start=${rawToken}`;
  },
  whatsapp: (rawToken) => {
    // TWILIO_WHATSAPP_NUMBER is declared `rawOpt` (src/lib/config/server.ts), and
    // MOCK_EXTERNAL_APIS=true makes assertWhatsAppEnvReady() return null WITHOUT
    // the var being set (whatsapp-env.ts → whatsappEnvReady). The env gate
    // therefore does not guarantee it here, so a bare `!` turned a reachable
    // config gap into a TypeError. Throw with context instead — and note the
    // caller builds the link BEFORE it writes anything (start.ts), so this
    // surfaces as a clean failure with no enrollment row left holding the
    // migration-027 unique slot.
    const configured = getServerConfig().TWILIO_WHATSAPP_NUMBER;
    if (!configured) {
      throw new Error(
        'TWILIO_WHATSAPP_NUMBER is unset — cannot build a wa.me deep link ' +
          '(MOCK_EXTERNAL_APIS=true bypasses the WhatsApp env gate)',
      );
    }
    // wa.me requires digits only — strip every non-digit (the whatsapp: prefix,
    // a leading +, and any spaces/dashes/parens the env value may carry). The
    // narrower /^whatsapp:\+?/ form the admin route used left formatting in the
    // path and produced a broken link.
    const digits = configured.replace(/\D/g, '');
    const prefilled = encodeURIComponent(`start-${rawToken}`);
    return `https://wa.me/${digits}?text=${prefilled}`;
  },
};

export function buildMobileDeepLink(channel: MobileChannel, rawToken: string): string {
  return BUILDERS[channel](rawToken);
}
