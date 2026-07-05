// worker/jobs/notification/eligibility.ts
//
// Determines which channels are eligible to dispatch an approval
// notification: subscription gate, per-channel feature flag, resolved
// channels. Returns the list of channels that should receive the
// notification — owner_email_bounced is applied per-enrollment in the
// dispatch loop because it depends on business row data the dispatch
// already has in hand.
//
// VAL-NOTIF-010: Uses resolveChannels instead of getVerifiedEnrollments.

import type { Sql } from 'postgres';
import {
  checkSubscription,
  type AccountFlagsInput,
} from '../../../src/lib/shared/subscription-guard';
import { resolveChannels, type ResolvedChannel } from '../../../src/lib/notifications/resolve-channels';
import { channelsTelegramEnabled, channelsWhatsappEnabled } from '../../../src/lib/notifications/channels/flags';
import type { ChannelId } from '../../../src/lib/notifications/channels/types';
import type { AccountId, LocationId } from '../../../src/lib/shared/ids';
import { asAccountId, asLocationId } from '../../../src/lib/shared/ids';

export interface EligibilityInput {
  accountId: string;
  locationId: string;
  subscriptionStatus: string;
  pastDueAt?: Date | string | null;
  accountFlags?: AccountFlagsInput;
}

export interface EligibilityLogger {
  log: (msg: string) => void;
}

export type EligibilityResult =
  | { ok: true; enrollments: ResolvedChannel[] }
  | { ok: false; reason: string };

/**
 * Per-channel feature-flag check. Email is always allowed if enrolled;
 * Telegram / WhatsApp each require their respective env flag to equal the
 * literal string `"true"`. Names + defaults match the original
 * NotificationWorker (default off — must be explicitly enabled).
 */
function isChannelFlagEnabled(channelId: ChannelId): boolean {
  if (channelId === 'email') return true;
  if (channelId === 'telegram') return channelsTelegramEnabled();
  if (channelId === 'whatsapp') return channelsWhatsappEnabled();
  return false;
}

/**
 * Subscription gate + per-channel flag filter + channel resolution via
 * resolveChannels (VAL-NOTIF-010). Returns either an enrollment list
 * to dispatch on, or a skip reason for the caller to log + complete
 * the outbox entry.
 *
 * Skip-log lines for flag-disabled channels match the original verbatim.
 */
export async function getEligibleChannels(
  sql: Sql,
  input: EligibilityInput,
  logger: EligibilityLogger,
): Promise<EligibilityResult> {
  const subCheck = checkSubscription({
    status: input.subscriptionStatus,
    pastDueAt: input.pastDueAt,
    accountFlags: input.accountFlags ?? {},
    workerType: 'notification',
  });
  if (!subCheck.allowed) {
    return { ok: false, reason: subCheck.reason };
  }

  const accountId: AccountId = asAccountId(input.accountId);
  const locationId: LocationId = asLocationId(input.locationId);

  const enrollments = await resolveChannels(sql, accountId, locationId);
  if (enrollments.length === 0) {
    return { ok: false, reason: 'no_verified_enrollments' };
  }

  const filtered: ResolvedChannel[] = [];
  for (const enrollment of enrollments) {
    if (!isChannelFlagEnabled(enrollment.channel)) {
      const channelLabel =
        enrollment.channel === 'telegram'
          ? 'Telegram'
          : enrollment.channel === 'whatsapp'
            ? 'WhatsApp'
            : enrollment.channel;
      logger.log(
        `${channelLabel} channel disabled by flag — skipping enrollment for location ${input.locationId}`,
      );
      continue;
    }
    filtered.push(enrollment);
  }

  return { ok: true, enrollments: filtered };
}
