import { CHANNEL_IDS } from '../../../src/lib/notifications/channels/types';
import type { ChannelId } from '../../../src/lib/notifications/channels/types';

export type NotificationChannelName = ChannelId;

export const NOTIFICATION_DISPATCH_CHANNEL_ORDER = CHANNEL_IDS;

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
  const eligibility = Object.fromEntries(
    CHANNEL_IDS.map((channel) => [channel, { enabled: false }]),
  ) as NotificationChannelEligibility;

  for (const enrollment of enrollments) {
    if (!(enrollment.channel in eligibility)) continue; // stale TEXT rows (e.g. 'sms') are dropped, not crashed on
    eligibility[enrollment.channel].enabled = true;
  }

  const dispatchPlan = buildNotificationDispatchPlan(eligibility);
  const channelOrder = new Map(
    dispatchPlan.map((channel, index) => [channel, index]),
  );

  // Defensive normalization: callers currently provide a complete,
  // alphabetically ordered channel set, so this preserves behavior while
  // keeping dispatch tied to the canonical order above if input order drifts.
  // Unknown-channel rows are excluded from the output (not in channelOrder).
  return enrollments
    .filter((e) => channelOrder.has(e.channel))
    .sort((a, b) => {
      const aOrder = channelOrder.get(a.channel) ?? Number.MAX_SAFE_INTEGER;
      const bOrder = channelOrder.get(b.channel) ?? Number.MAX_SAFE_INTEGER;
      return aOrder - bOrder;
    });
}
