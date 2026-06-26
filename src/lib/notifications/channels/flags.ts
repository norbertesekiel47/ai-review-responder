/**
 * Single authoritative owner for the notification-channel feature flags.
 * Mirrors the `<feature>/flags.ts` convention (see `auto-approval/flags.ts`),
 * each a one-line wrapper over the shared `readFlag` primitive
 * (byte-for-byte `process.env[name] === 'true'`).
 *
 *   - channelsTelegramEnabled():       the Telegram notification channel is on.
 *   - channelsWhatsappEnabled():        the WhatsApp notification channel is on.
 *   - emailChannelReconcileDisabled():  the EMAIL_CHANNEL_RECONCILE_DISABLED
 *     kill-switch — its `*_DISABLED` name encodes the meaning; call sites still
 *     read it as `=== 'true'` (true ⇒ the reconcile poller does not start).
 *
 * Server-authoritative (invariant #13): never expose via a `NEXT_PUBLIC_*`
 * companion; the browser learns the state through API responses / props.
 */
import { readFlag } from '@/lib/config/flags';

export function channelsTelegramEnabled(): boolean {
  return readFlag('CHANNELS_TELEGRAM_ENABLED');
}

export function channelsWhatsappEnabled(): boolean {
  return readFlag('CHANNELS_WHATSAPP_ENABLED');
}

export function emailChannelReconcileDisabled(): boolean {
  return readFlag('EMAIL_CHANNEL_RECONCILE_DISABLED');
}
