export type NotificationChannelName = 'email' | 'sms' | 'telegram' | 'whatsapp';

export type NotificationChannelEligibility = Record<
  NotificationChannelName,
  { enabled: boolean }
>;

export function buildNotificationDispatchPlan(
  eligibility: NotificationChannelEligibility,
): NotificationChannelName[] {
  return (['email', 'sms', 'telegram', 'whatsapp'] as const).filter(
    (channel) => eligibility[channel].enabled,
  );
}
