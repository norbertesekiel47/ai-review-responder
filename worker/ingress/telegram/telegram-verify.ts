// worker/ingress/telegram/telegram-verify.ts
//
// Constant-time compare of the X-Telegram-Bot-Api-Secret-Token header against
// TELEGRAM_WEBHOOK_SECRET. Separate module so it's trivially unit-testable
// with fixtures.

import { timingSafeEqual } from 'node:crypto';

export function verifyTelegramSecret(headerValue: string | undefined): boolean {
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!expected || !headerValue) return false;
  const a = Buffer.from(headerValue, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
