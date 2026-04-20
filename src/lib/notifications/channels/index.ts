// src/lib/notifications/channels/index.ts
//
// Channel factory. Each channel implementation is imported lazily-safe
// (top-level imports are fine; the classes themselves don't call provider
// SDKs at construction time). Subsequent phases add SMS / Telegram / WhatsApp
// cases here.

import { EmailChannel } from './email-channel';
import type { NotificationChannel, ChannelId } from './types';

export { EmailChannel } from './email-channel';
export type { NotificationChannel, ChannelId, SendApprovalParams, SendApprovalResult } from './types';

const NOT_YET_IMPLEMENTED: ReadonlySet<ChannelId> = new Set(['sms', 'telegram', 'whatsapp']);

export function getChannel(id: ChannelId): NotificationChannel {
  if (id === 'email') return new EmailChannel();
  if (NOT_YET_IMPLEMENTED.has(id)) {
    throw new Error(`Channel "${id}" not yet implemented — scheduled for a later phase`);
  }
  throw new Error(`Unknown channel "${id}"`);
}
