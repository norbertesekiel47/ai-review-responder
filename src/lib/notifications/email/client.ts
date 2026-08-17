// src/lib/notifications/email/client.ts
//
// Lazy Resend client. Constructed on first use so that environment variable
// availability does not need to be guaranteed at module-load time.
import { Resend } from 'resend';
import { getServerConfig } from '@/lib/config/server';

let _resend: Resend | null = null;

export function getResend(): Resend {
  if (!_resend) {
    // Optional field — tolerates undefined exactly as the prior raw read did.
    _resend = new Resend(getServerConfig().RESEND_API_KEY);
  }
  return _resend;
}

let _solicitationResend: Resend | null = null;

/**
 * Domain-scoped Resend client for the solicitation lane (spec §1.6). Same lazy
 * shape as getResend() with one deliberate difference: it FAILS CLOSED. An unset
 * key throws rather than constructing a client with `undefined`, because a
 * solicitation send that silently proceeds without its own key would be a send
 * on the transactional identity.
 */
export function getSolicitationResend(): Resend {
  if (!_solicitationResend) {
    const key = getServerConfig().SOLICITATION_RESEND_API_KEY?.trim();
    if (!key) {
      throw new Error(
        'SOLICITATION_RESEND_API_KEY is not set — the solicitation lane cannot send (fail-closed, spec §1.6/§9)',
      );
    }
    _solicitationResend = new Resend(key);
  }
  return _solicitationResend;
}
