import type { Sql } from 'postgres';
import { sendInternalEmail } from '../../../src/lib/notifications/email';
import { recordNotificationDelivery } from '../../../src/lib/notifications/delivery';
import { markOutboxCompleted, markOutboxFailed } from '../../../src/lib/shared/outbox';
import type { WorkerLogger } from '../../../src/lib/shared/logger';
import type { OnboardingDripPayload } from '../../../src/lib/shared/worker-types';
import type { LocationId } from '../../../src/lib/shared/ids';

export interface SendAndRecordDripInput {
  sql: Sql;
  logger: WorkerLogger;
  dripType: OnboardingDripPayload['drip_type'];
  businessId: LocationId;
  accountId: string;
  ownerEmail: string;
  /** `onboarding_drip_log.id` claimed by step 4 of `handleOnboardingDrip`. */
  claimId: string;
  outboxId: string;
  outboxAttempt: number | undefined;
  subject: string;
  html: string;
  /**
   * True when this drip's body can vary between attempts — `day_7`, per
   * `dripBodyVariesPerAttempt` in `OnboardingDripWorker.ts`. Decides which of
   * the two crash-after-send defences below applies; see that function for
   * WHY they differ per drip type.
   */
  bodyVaries: boolean;
}

/**
 * The send-and-record tail of `handleOnboardingDrip` (#1403) — "deliver,
 * record the outcome, close the outbox row." Extracted verbatim from the
 * handler with no behavior change, to take `handleOnboardingDrip` back under
 * the fallow complexity threshold (invariant #12: "extract any error-handling
 * branch over ~30 lines into a named module with focused tests").
 *
 * Four constraints are load-bearing here — each cost a review round to
 * establish across #1363, and #1403 re-pins them by test:
 *
 * 1. A send whose body can vary (`bodyVaries`) carries NO provider
 *    idempotency key — a 409 would write a synthetic `external_message_id`,
 *    and `worker/ingress/resend.ts` correlates hard bounces only on the real
 *    Resend id.
 * 2. `day_7` marks `onboarding_drip_log.sent_at` BEFORE sending, and the
 *    marker is never rolled back on a send failure — `EmailSendTimeoutError`
 *    fires while the orphaned fetch may still deliver.
 * 3. The keyed path (`!bodyVaries`) rethrows on a send failure so BullMQ can
 *    retry and still legitimately deliver; the marked path (`bodyVaries`)
 *    does not, because a retry cannot (sent_at is already committed).
 * 4. The marked path's failure record is best-effort with its OWN
 *    `try/catch` (`.claude/rules/worker-layout.md` — "Best-effort work after
 *    a worker's primary side effect"). Unguarded, a rejection there escapes
 *    the handler, BullMQ retries, and the retry reaches the caller's step-4
 *    skip branch — which marks the outbox row COMPLETED, re-opening the
 *    duplicate this catch exists to close.
 *
 * See `docs/context/core-platform-runtime.md` "Send idempotency key" /
 * "Idempotent replay" for the provider-level mechanics these branches defend.
 */
export async function sendAndRecordDrip(input: SendAndRecordDripInput): Promise<void> {
  const {
    sql,
    logger,
    dripType,
    businessId,
    accountId,
    ownerEmail,
    claimId,
    outboxId,
    outboxAttempt,
    subject,
    html,
    bodyVaries,
  } = input;

  if (bodyVaries) {
    // MARK-BEFORE-SEND. The mark is NOT rolled back on a send error, and that
    // is deliberate: `EmailSendTimeoutError` fires at 10s while the orphaned
    // fetch may still reach Resend, so a rollback would re-send a mail the
    // provider already accepted — the duplicate this whole change exists to
    // stop. WeeklySummaryWorker states the same rule
    // (`summary-report-helpers.ts:115-118`).
    //
    // The COST is wider than a crash, and the catch below is what makes it
    // honest: ANY send error — a transient Resend 5xx, a timeout — loses this
    // drip permanently, because `onboarding_drip_log UNIQUE (business_id,
    // drip_type)` means the scheduler can never re-mint the pair. At the
    // merge-base that error retried and delivered. #1363 review round 2.
    await sql`
      UPDATE onboarding_drip_log SET sent_at = NOW() WHERE id = ${claimId}
    `;
  }

  // The Send idempotency key is scoped to (business_id, drip_type), NOT to the
  // outbox row. The scope is load-bearing: the caller's stale-claim takeover
  // (step 4) admits a SECOND outbox row on a claim still carrying sent_at IS
  // NULL, which is exactly the crash-after-send case this key defends. Two
  // outbox rows carry two ids, so an outbox-scoped key would not dedupe them;
  // (business_id, drip_type) mirrors the onboarding_drip_log UNIQUE
  // constraint that already bounds one drip per pair. It is spelled to match
  // the notification_deliveries.template written below, so one grep ties the
  // provider key to the delivery record.
  let messageId: string;
  let idempotentReplay: boolean | undefined;
  try {
    ({ messageId, idempotentReplay } = await sendInternalEmail({
      to: ownerEmail,
      subject,
      bodyHtml: html,
      category: 'marketing',
      ...(bodyVaries ? {} : { idempotencyKey: `onboarding_drip_${dripType}:${businessId}` }),
    }));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (!bodyVaries) {
      // sent_at is still NULL, so a retry can legitimately re-send under the
      // same key. Rethrow and let BullMQ do exactly that.
      throw err;
    }
    // sent_at is already committed, so no retry can ever deliver this drip.
    // Rethrowing would only churn BullMQ into the caller's step-4 skip branch,
    // which marks the row COMPLETED — the job ledger would then record a
    // success for a mail that never went out. Record the failure durably
    // instead.
    logger.error(`${dripType} send failed after sent_at was committed: ${reason}`);
    // Best-effort, and it MUST carry its own try/catch
    // (`.claude/rules/worker-layout.md` — "Best-effort work after a worker's
    // primary side effect"). An unguarded rejection here escapes the handler,
    // BullMQ retries the job, and the retry reaches the step-4 skip branch
    // which marks the row COMPLETED — re-opening the very defect this catch
    // closes. Observability must never poison the path it observes.
    try {
      await markOutboxFailed(sql, outboxId, `send failed after mark: ${reason}`, outboxAttempt);
    } catch (recordErr) {
      logger.error(
        `${dripType} could not record the send failure: ${recordErr instanceof Error ? recordErr.message : String(recordErr)}`,
      );
    }
    return;
  }

  if (idempotentReplay) {
    // Resend refused a second send under this key, which proves the first
    // attempt was accepted. The email IS delivered, so completion below runs
    // unchanged — skipping it would leave the claim open for a third attempt.
    logger.log(`${dripType} already delivered under its idempotency key`, {
      business_id: businessId,
      drip_type: dripType,
    });
  }

  // Mark sent_at after successful delivery — the keyed path only; the marked
  // path already set it before the send, above.
  if (!bodyVaries) {
    await sql`
      UPDATE onboarding_drip_log SET sent_at = NOW() WHERE id = ${claimId}
    `;
  }

  // Record delivery BEFORE outbox completion — ensures cooldown checks in
  // other workers can see this delivery record.
  await recordNotificationDelivery(sql, {
    accountId,
    businessId,
    channel: 'email',
    recipient: ownerEmail,
    template: `onboarding_drip_${dripType}`,
    externalMessageId: messageId,
  });

  await markOutboxCompleted(sql, outboxId, outboxAttempt);

  logger.log(`${dripType} sent for business ${businessId}`);
}
