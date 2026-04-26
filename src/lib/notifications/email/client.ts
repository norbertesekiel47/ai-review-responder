// src/lib/notifications/email/client.ts
//
// Lazy Resend client. Constructed on first use so that environment variable
// availability does not need to be guaranteed at module-load time.
import { Resend } from 'resend';

let _resend: Resend | null = null;

export function getResend(): Resend {
  if (!_resend) {
    _resend = new Resend(process.env.RESEND_API_KEY);
  }
  return _resend;
}
