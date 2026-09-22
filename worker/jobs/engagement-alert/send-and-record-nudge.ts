import type { Sql } from 'postgres';
import { sendInternalEmail } from '../../../src/lib/notifications/email';
import { recordNotificationDelivery, insertFailedDelivery } from '../../../src/lib/notifications/delivery';
import { markOutboxCompleted } from '../../../src/lib/shared/outbox';
import type { WorkerLogger } from '../../../src/lib/shared/logger';

export interface SendAndRecordOwnerNudgeInput {
  sql: Sql;
  logger: WorkerLogger;
  outboxId: string;
  outboxAttempt: number | undefined;
  businessId: string;
  accountId: string;
  ownerEmail: string;
  subject: string;
  bodyHtml: string;
  /** Used only in the success log line, matching the pre-extraction message. */
  totalPending: number;
}

/**
 * The send-and-record tail of the owner nudge (#1403) — "deliver, record the
 * outcome, close the outbox row." Extracted verbatim from `handleOwnerNudge`
 * in `EngagementAlertWorker.ts`, with no behavior change, to take that
 * handler back under the fallow complexity threshold (invariant #12).
 *
 * Constraints load-bearing here — established across #1363's three review
 * rounds, re-pinned by test for #1403:
 *
 * 1. No provider idempotency key: `createApprovalLink` mints a fresh token
 *    per pending review on every attempt, so the body varies by construction
 *    — a stable key would draw Resend's 409 instead of a replay, and the
 *    delivery row would carry a synthetic message id that
 *    `worker/ingress/resend.ts` cannot correlate to a hard bounce.
 * 2. Marks the outbox row completed BEFORE sending, and the completion is
 *    never rolled back — the same "orphaned fetch may still deliver" reason
 *    as the drip's mark-before-send.
 * 3. NEVER rethrows on a send failure: the outbox row is already completed,
 *    so a BullMQ retry would re-enter the handler, find no delivery row (the
 *    cooldown probe's only record), mint fresh approval links, and send a
 *    SECOND nudge — the duplicate this ordering exists to prevent.
 * 4. The failure record is best-effort with its OWN `try/catch`
 *    (`.claude/rules/worker-layout.md` — "Best-effort work after a worker's
 *    primary side effect"). Unguarded, a rejection here escapes the handler
 *    despite constraint 3: BullMQ retries, the cooldown probe misses (this
 *    row has no `sent_at`), and a second nudge goes out anyway.
 *
 * See `docs/context/core-platform-runtime.md` "Send idempotency key" /
 * "Idempotent replay" for the provider-level mechanics.
 */
export async function sendAndRecordOwnerNudge(input: SendAndRecordOwnerNudgeInput): Promise<void> {
  const { sql, logger, outboxId, outboxAttempt, businessId, accountId, ownerEmail, subject, bodyHtml, totalPending } =
    input;

  // Completing the outbox row first is the same crash-safe shape
  // `handleSatisfactionAlert` uses: a crash between here and Resend accepting
  // loses ONE nudge, which beats sending two and beats silently disabling
  // bounce suppression.
  //
  // `handleSatisfactionAlert` is the precedent, NOT WeeklySummaryWorker — that
  // one completes its outbox row AFTER the send and can therefore still call
  // `markOutboxFailed` in its catch (`summary-report-helpers.ts:114-119`).
  // This path cannot, which is why its catch writes a failed DELIVERY row
  // instead (#1363 review round 2 corrected an earlier comment here that
  // cited the wrong precedent).
  await markOutboxCompleted(sql, outboxId, outboxAttempt);

  let messageId: string;
  try {
    ({ messageId } = await sendInternalEmail({
      to: ownerEmail,
      subject,
      bodyHtml,
      category: 'marketing',
    }));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // Do NOT rethrow. The outbox row is already completed, but a throw still
    // fails the BullMQ JOB, and BullMQ retries on its own clock — the handler
    // would re-enter, find no delivery row (the cooldown probe's only
    // record), mint fresh approval links and send a SECOND nudge. That is
    // the duplicate this ordering exists to prevent, so the error stops
    // here.
    //
    // `markOutboxFailed` is NOT the right record: the row is already
    // 'completed', so the attempt-guarded UPDATE would no-op silently. Write
    // a FAILED DELIVERY instead. It is durable, it names the reason, and
    // because the cooldown probe keys on `sent_at IS NOT NULL` a failed row
    // does not block the next legitimate nudge — which is the behaviour we
    // want, since this owner never received one. (Repeated failures append
    // unbounded failed_at-only rows, which neither dedupe nor throttle —
    // #1363 review round 3 rider.)
    //
    // Without it a Resend outage would drop every nudge while the job ledger
    // reported success (#1363 review round 2).
    logger.error(`Owner nudge send failed for business ${businessId}: ${reason}`);
    // Best-effort, and it MUST carry its own try/catch
    // (`.claude/rules/worker-layout.md` — "Best-effort work after a worker's
    // primary side effect"). An unguarded rejection here escapes the handler
    // despite the comment above saying the error stops here: BullMQ would
    // retry the job, the cooldown probe would miss (this row has no
    // `sent_at`), fresh approval links would be minted and a SECOND nudge
    // would go out — exactly the duplicate the mark-first ordering exists to
    // prevent.
    try {
      await insertFailedDelivery(sql, accountId, businessId, null, 'email', ownerEmail, reason, 'owner_nudge');
    } catch (recordErr) {
      logger.error(
        `Owner nudge could not record the send failure for business ${businessId}: ${recordErr instanceof Error ? recordErr.message : String(recordErr)}`,
      );
    }
    return;
  }

  await recordNotificationDelivery(sql, {
    accountId,
    businessId,
    channel: 'email',
    recipient: ownerEmail,
    template: 'owner_nudge',
    externalMessageId: messageId,
  });

  // No markOutboxCompleted here — it ran BEFORE the send, above.
  logger.log(`Owner nudge sent for business ${businessId} (${totalPending} pending reviews)`);
}
