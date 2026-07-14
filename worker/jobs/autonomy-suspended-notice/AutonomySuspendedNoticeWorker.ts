import type { Job } from 'bullmq';
import type { Sql } from 'postgres';
import { getWorkerConfig } from '@/lib/config/worker';
import { createWorkerLogger } from '@/lib/shared/logger';
import {
  extractOutboxHandle,
  markOutboxCompleted,
  markOutboxFailed,
} from '@/lib/shared/outbox';
import type { AutonomySuspendedNoticePayload } from '@/lib/shared/worker-types';
import { getEligibleChannels } from '../notification/eligibility';
import { loadAutonomySuspendedNoticeContext } from './context';
import { dispatchAutonomySuspendedNotice } from './dispatch';

// Safety notices deliberately have NO feature-flag kill switch: disabling the
// autonomy runtime must never hide the fact that auto-posting was suspended.
// fallow-ignore-next-line complexity
export async function handleAutonomySuspendedNotice(
  sql: Sql,
  job: Job<AutonomySuspendedNoticePayload>,
): Promise<void> {
  const logger = createWorkerLogger('[AutonomySuspendedNoticeWorker]', job.data.correlation_id);
  const { account_id, suspension_event_id, trigger } = job.data;
  const { outboxId, attempt } = extractOutboxHandle(job.data, job.id!);

  const context = await loadAutonomySuspendedNoticeContext(sql, {
    accountId: account_id,
    suspensionEventId: suspension_event_id,
    trigger,
  }, logger);
  if (context.kind === 'fail') {
    await markOutboxFailed(sql, outboxId, context.reason, attempt);
    return;
  }
  if (context.kind === 'skip') {
    logger.log(`autonomy_suspended_notice skip event=${suspension_event_id} reason=${context.reason}`);
    await markOutboxCompleted(sql, outboxId, attempt);
    return;
  }

  const eligibility = await getEligibleChannels(sql, {
    accountId: context.account.account_id,
    locationId: context.business.business_id,
    subscriptionStatus: context.account.subscription_status,
    pastDueAt: context.account.account_past_due_at,
    accountFlags: context.account.account_flags,
  }, logger);
  if (!eligibility.ok) {
    logger.log(`autonomy_suspended_notice no-eligible-channels event=${suspension_event_id} reason=${eligibility.reason}`);
    await markOutboxCompleted(sql, outboxId, attempt);
    return;
  }
  if (eligibility.enrollments.length === 0) {
    logger.log(`autonomy_suspended_notice no-eligible-channels event=${suspension_event_id} reason=all_channels_flag_disabled`);
    await markOutboxCompleted(sql, outboxId, attempt);
    return;
  }

  // This safety notice is ACCOUNT-scoped: org-default enrollments (account_id
  // + channel + location_id IS NULL) are the owner's account-level contact
  // points, so they must not be shadowed by a per-location channel override on
  // the primary location. resolveChannels already marks each resolved
  // enrollment's scope via location_id (null = org-default); reuse that marker
  // instead of adding a resolution mode. Fall back to the primary location's
  // channels only when the owner has no org-default enrollment on ANY channel.
  const orgDefaultEnrollments = eligibility.enrollments.filter(
    (enrollment) => enrollment.location_id === null,
  );
  const enrollments = orgDefaultEnrollments.length > 0
    ? orgDefaultEnrollments
    : eligibility.enrollments;

  const appUrl = getWorkerConfig().NEXT_PUBLIC_APP_URL;
  if (!appUrl) {
    await markOutboxFailed(sql, outboxId, 'NEXT_PUBLIC_APP_URL not configured', attempt);
    return;
  }
  const baseUrl = appUrl.replace(/\/$/, '');
  const dispatch = await dispatchAutonomySuspendedNotice(sql, {
    accountId: context.account.account_id,
    businessId: context.business.business_id,
    suspensionEventId: suspension_event_id,
    accountName: context.account.display_name,
    ownerEmailBounced: context.business.owner_email_bounced,
    reason: context.audit.reason,
    settingsUrl: `${baseUrl}/settings/auto-approval`,
    supportUrl: 'mailto:support@repworth.net',
  }, enrollments, logger);

  logger.log(
    `autonomy_suspended_notice done event=${suspension_event_id} sent=${dispatch.sent} skipped=${dispatch.skipped} ` +
    `terminal_failed=${dispatch.terminalFailed} retryable_failed=${dispatch.retryableFailed}`,
  );
  const attempted = dispatch.skipped + dispatch.terminalFailed + dispatch.retryableFailed;
  if (dispatch.sent === 0 && attempted > 0) {
    logger.warn(`autonomy_suspended_notice systemic-failure event=${suspension_event_id} attempted=${attempted} no-notice-delivered`);
  }
  if (dispatch.retryableFailed > 0) {
    throw new Error(
      `autonomy_suspended_notice: ${dispatch.retryableFailed} retryable channel failure(s) for event ${suspension_event_id}`,
    );
  }
  await markOutboxCompleted(sql, outboxId, attempt);
}
