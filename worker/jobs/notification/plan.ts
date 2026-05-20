import type { ChannelId } from '../../../src/lib/notifications/channels/types';

export type NotificationChannelName = ChannelId;

export const NOTIFICATION_DISPATCH_CHANNEL_ORDER = [
  'email',
  'sms',
  'telegram',
  'whatsapp',
] as const satisfies readonly ChannelId[];

export type NotificationChannelEligibility = Record<
  NotificationChannelName,
  { enabled: boolean }
>;

export function buildNotificationDispatchPlan(
  eligibility: NotificationChannelEligibility,
): NotificationChannelName[] {
  return NOTIFICATION_DISPATCH_CHANNEL_ORDER.filter(
    (channel) => eligibility[channel].enabled,
  );
}

export function orderNotificationDispatchEnrollments<
  T extends { channel: NotificationChannelName },
>(enrollments: readonly T[]): T[] {
  const eligibility: NotificationChannelEligibility = {
    email: { enabled: false },
    sms: { enabled: false },
    telegram: { enabled: false },
    whatsapp: { enabled: false },
  };

  for (const enrollment of enrollments) {
    eligibility[enrollment.channel].enabled = true;
  }

  const dispatchPlan = buildNotificationDispatchPlan(eligibility);
  const channelOrder = new Map(
    dispatchPlan.map((channel, index) => [channel, index]),
  );

  return [...enrollments].sort((a, b) => {
    const aOrder = channelOrder.get(a.channel) ?? Number.MAX_SAFE_INTEGER;
    const bOrder = channelOrder.get(b.channel) ?? Number.MAX_SAFE_INTEGER;
    return aOrder - bOrder;
  });
}
