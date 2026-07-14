import type { Sql } from 'postgres';
import { getWorkerConfig } from '@/lib/config/worker';
import { getChannel } from '@/lib/notifications/channels';
import type {
  SendAutonomySuspendedNoticeParams,
  SendAutonomySuspendedNoticeResult,
} from '@/lib/notifications/channels/types';
import {
  claimAutonomySuspendedNoticeDelivery,
  failDelivery,
  finalizeDeliverySent,
  releaseDeliveryClaim,
} from '@/lib/notifications/delivery';
import type { ResolvedChannel } from '@/lib/notifications/resolve-channels';
import type { WorkerLogger } from '@/lib/shared/logger';
import { classifyAutonomySuspendedNoticeSendError } from './errors';

export interface AutonomySuspendedNoticeDispatchInput {
  accountId: string;
  businessId: string;
  suspensionEventId: string;
  accountName: string;
  ownerEmailBounced: boolean;
  reason: string;
  settingsUrl: string;
  supportUrl: string;
}

export interface AutonomySuspendedNoticeDispatchResult {
  sent: number;
  skipped: number;
  terminalFailed: number;
  retryableFailed: number;
}

// fallow-ignore-next-line complexity
export async function dispatchAutonomySuspendedNotice(
  sql: Sql,
  input: AutonomySuspendedNoticeDispatchInput,
  enrollments: ResolvedChannel[],
  logger: WorkerLogger,
): Promise<AutonomySuspendedNoticeDispatchResult> {
  const result = { sent: 0, skipped: 0, terminalFailed: 0, retryableFailed: 0 };
  const whatsappTemplateSid = getWorkerConfig().WHATSAPP_AUTONOMY_SUSPENDED_TEMPLATE_SID;

  for (const enrollment of enrollments) {
    const channel = enrollment.channel;
    const recipient = enrollment.handle;
    if (channel === 'email' && input.ownerEmailBounced) {
      result.skipped += 1;
      logger.log(`autonomy_suspended_notice skipped channel=email reason=owner_email_bounced event=${input.suspensionEventId}`);
      continue;
    }
    if (channel === 'whatsapp' && !whatsappTemplateSid) {
      result.skipped += 1;
      logger.log(`autonomy_suspended_notice skipped channel=whatsapp reason=template_unset event=${input.suspensionEventId}`);
      continue;
    }

    // Delivery lifecycle DB work is deliberately OUTSIDE the provider-send
    // catch. A claim/finalize/release/fail error is infrastructure failure and
    // must rethrow unchanged; classifying it as a provider error can falsely
    // settle a notice whose provider side effect already succeeded.
    const claim = await claimAutonomySuspendedNoticeDelivery(sql, {
      accountId: input.accountId,
      businessId: input.businessId,
      entityId: input.suspensionEventId,
      channel,
      recipient,
    });
    if (claim.kind === 'settled') {
      result.skipped += 1;
      logger.log(`autonomy_suspended_notice dedup channel=${channel} event=${input.suspensionEventId}`);
      continue;
    }
    if (claim.kind === 'pending') {
      // Do not complete the outbox while a live claim is unresolved. A prior
      // provider acceptance followed by finalize failure is ambiguous; retries
      // wait for lifecycle recovery or the bounded stale-claim reap. Email's
      // provider idempotency key prevents duplication. Telegram/WhatsApp are
      // necessarily at-least-once if recovery eventually reaps and re-sends.
      throw new Error(
        `autonomy_suspended_notice pending delivery claim channel=${channel} event=${input.suspensionEventId}`,
      );
    }
    const deliveryId = claim.deliveryId;
    const params: SendAutonomySuspendedNoticeParams = {
      handle: recipient,
      accountName: input.accountName,
      reason: input.reason,
      settingsUrl: input.settingsUrl,
      supportUrl: input.supportUrl,
      suspensionEventId: input.suspensionEventId,
    };
    const channelSender = getChannel(channel);

    let sendResult: SendAutonomySuspendedNoticeResult;
    try {
      sendResult = await channelSender.sendAutonomySuspendedNotice(params);
    } catch (providerError) {
      const classification = classifyAutonomySuspendedNoticeSendError(providerError);
      if (classification.retryable) {
        await releaseDeliveryClaim(sql, deliveryId);
        result.retryableFailed += 1;
        logger.warn(`autonomy_suspended_notice retryable-failed channel=${channel} event=${input.suspensionEventId}`);
      } else {
        await failDelivery(sql, deliveryId, classification.reason, logger);
        result.terminalFailed += 1;
        logger.warn(`autonomy_suspended_notice terminal-failed channel=${channel} event=${input.suspensionEventId}`);
      }
      continue;
    }

    if (sendResult.status === 'skipped') {
      await releaseDeliveryClaim(sql, deliveryId);
      result.skipped += 1;
      logger.log(`autonomy_suspended_notice skipped channel=${channel} reason=${sendResult.reason} event=${input.suspensionEventId}`);
      continue;
    }
    await finalizeDeliverySent(sql, deliveryId, sendResult.externalMessageId, logger);
    result.sent += 1;
    logger.log(`autonomy_suspended_notice sent channel=${channel} event=${input.suspensionEventId}`);
  }
  return result;
}
