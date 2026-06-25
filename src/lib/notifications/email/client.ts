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
