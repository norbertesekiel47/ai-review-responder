// worker/jobs/notification/eligibility.ts
//
// Determines which channels are eligible to dispatch an approval
// notification: subscription gate, per-channel feature flag, verified
// enrollments. Returns the list of channels that should receive the
// notification — owner_email_bounced is applied per-enrollment in the
// dispatch loop because it depends on business row data the dispatch
// already has in hand.

import { checkSubscription } from '../../../src/lib/shared/subscription-guard';
import { getVerifiedEnrollments } from '../../../src/lib/notifications/enrollments';
import type { VerifiedEnrollment } from '../../../src/lib/notifications/enrollments';
import type { ChannelId } from '../../../src/lib/notifications/channels/types';

export interface EligibilityInput {
  businessId: string;
  subscriptionStatus: string;
  businessUpdatedAt: Date;
}

export interface EligibilityLogger {
  log: (msg: string) => void;
}

export type EligibilityResult =
  | { ok: true; enrollments: VerifiedEnrollment[] }
  | { ok: false; reason: string };

/**
 * Per-channel feature-flag check. Email is always allowed if enrolled;
 * SMS / Telegram / WhatsApp each require their respective env flag to
 * equal the literal string `"true"`. Names + defaults match the original
 * NotificationWorker (default off — must be explicitly enabled).
 */
export function isChannelFlagEnabled(channelId: ChannelId): boolean {
  if (channelId === 'email') return true;
  if (channelId === 'sms') return process.env.CHANNELS_SMS_ENABLED === 'true';
  if (channelId === 'telegram') return process.env.CHANNELS_TELEGRAM_ENABLED === 'true';
  if (channelId === 'whatsapp') return process.env.CHANNELS_WHATSAPP_ENABLED === 'true';
  return false;
}

/**
 * Subscription gate + per-channel flag filter + verified enrollment load.
 * Returns either an enrollment list to dispatch on, or a skip reason for
 * the caller to log + complete the outbox entry.
 *
 * Skip-log lines for flag-disabled channels match the original verbatim.
 */
export async function getEligibleChannels(
  input: EligibilityInput,
  logger: EligibilityLogger,
): Promise<EligibilityResult> {
  const subCheck = checkSubscription(
    input.subscriptionStatus,
    input.businessUpdatedAt,
    'notification',
  );
  if (!subCheck.allowed) {
    return { ok: false, reason: subCheck.reason };
  }

  const enrollments = await getVerifiedEnrollments(input.businessId);
  if (enrollments.length === 0) {
    return { ok: false, reason: 'no_verified_enrollments' };
  }

  const filtered: VerifiedEnrollment[] = [];
  for (const enrollment of enrollments) {
    if (!isChannelFlagEnabled(enrollment.channel)) {
      const channelLabel =
        enrollment.channel === 'sms'
          ? 'SMS'
          : enrollment.channel === 'telegram'
            ? 'Telegram'
            : enrollment.channel === 'whatsapp'
              ? 'WhatsApp'
              : enrollment.channel;
      logger.log(
        `${channelLabel} channel disabled by flag — skipping enrollment for business ${input.businessId}`,
      );
      continue;
    }
    filtered.push(enrollment);
  }

  return { ok: true, enrollments: filtered };
}
