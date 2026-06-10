// src/lib/notifications/mask-handle.ts
//
// Channel-aware handle masking for API responses. Email addresses are the
// owner's own login identity and pass through; phone-shaped handles
// (whatsapp) show first 3 + last 4; telegram follows its existing display
// rule. Unknown channel values (stale TEXT rows) are masked like phone
// numbers — never returned raw.

import type { ChannelId } from './channels/types';

export function maskChannelHandle(channel: ChannelId | string, handle: string): string {
  if (channel === 'email') return handle;
  if (channel === 'whatsapp') {
    // Show first 3 + last 4, mask the rest. For short handles (<= 7 chars),
    // the hidden section becomes zero-width — must clamp to avoid
    // `'•'.repeat(-1)` which throws RangeError.
    if (handle.length <= 4) return handle;
    const hidden = Math.max(0, handle.length - 7);
    return handle.slice(0, 3) + '•'.repeat(hidden) + handle.slice(-4);
  }
  if (channel === 'telegram') {
    // Telegram chat_id is a numeric identifier. Show last 4 digits for admin
    // recognition — not PII-sensitive (the owner voluntarily enrolled via QR).
    if (handle.length <= 4) return handle;
    return '••• ' + handle.slice(-4);
  }
  // Unknown/stale channel (e.g. 'sms' after removal): mask like a phone number
  // rather than returning the handle raw — conservative default.
  if (handle.length <= 4) return handle;
  const hidden = Math.max(0, handle.length - 7);
  return handle.slice(0, 3) + '•'.repeat(hidden) + handle.slice(-4);
}
