import { v7 as uuidv7 } from 'uuid';
import { getWorkerConfig } from '../../../src/lib/config/worker';
import { sql, jsonb } from '../../../src/lib/db/server';
import { QUEUE_NAMES } from '../../../src/lib/shared/queue-names';
import { sendInternalEmail } from '../../../src/lib/notifications/email';
import { escapeHtml } from '../../../src/lib/shared/html';
import { createWorkerLogger, toError } from '../../../src/lib/shared/logger';
import { enqueueSendNotification } from '../../../src/lib/shared/job-outbox-helpers';
import { createGuardedPoll } from '../guarded-poll';
import {
  OUTBOX_COMPLETION_REASON,
  OWNER_UNREACHABLE_AGE_FLOOR_SECONDS,
} from '../../../src/lib/shared/outbox-completion-reason';
import { num } from './health-alert/checks';
import type { SendNotificationPayload } from '../../../src/lib/shared/worker-types';

const LOG_PREFIX = '[NotificationFailover]';
const DEFAULT_INTERVAL_MS = 7_200_000; // 2 hours
// Hard per-cycle deadline (#414). 30min is above the legitimate worst case
// (<=200 rows x <=2 admin emails, ~7min) and far under the 2h interval, so a
// cycle hung on a stale connection frees the single-flight flag before the next
// tick instead of pinning it forever and silently disabling failover alerting.
const FAILOVER_CYCLE_TIMEOUT_MS = 1_800_000; // 30 minutes

// Per-tick row cap (deep-scan §5.7). The two driving SELECTs below are otherwise
// unbounded; this caps how many candidate rows one 2-hour tick loads into memory.
// Paired with ORDER BY created_at ASC so the oldest-stuck responses are triaged
// first. all-failed rows leave the predicate set once their failover outbox row
// is queued (drains cleanly across ticks); the stale arm re-selects already-
// alerted rows but tryClaimAlert's 24h dedup makes re-processing a cheap no-op,
// so a >200 simultaneous-stuck backlog (itself a sev incident) is triaged
// oldest-first over successive ticks rather than loaded all at once.
const BATCH_LIMIT = 200;

function getIntervalMs(): number {
  const envVal = getWorkerConfig().NOTIFICATION_FAILOVER_INTERVAL_MS;
  if (!envVal) return DEFAULT_INTERVAL_MS;
  const parsed = parseInt(envVal, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_INTERVAL_MS;
}

/**
 * Recover the correlation_id from the upstream review chain so a failover
 * send_notification job shows up under the SAME correlation key as the
 * original sync/generate/notify chain in `payload->>'correlation_id'`
 * queries. Without this, every failover breaks Sprint 6's single-query
 * traceability promise.
 *
 * Lookup order:
 *   1. Most recent send_notification row for this response_id — if a prior
 *      attempt already carried a correlation_id, reuse it.
 *   2. Most recent generate_response row for the response's review_id —
 *      this is the canonical anchor used by `recoverCorrelationId` in
 *      src/lib/approval/correlation.ts.
 *   3. Fresh uuidv7() — graceful fallback for pre-20a rows with no
 *      correlation payload.
 */
type AlertOutcome = 'sent' | 'deduped' | 'send_error';

/**
 * Race-safe admin-alert claim helper.
 *
 * Two failover-poller processes (multi-instance deployments) can both pass a
 * time-windowed dedup SELECT and send duplicate admin emails. This helper
 * serializes per (response_id, template, recipient) via a transaction-scoped
 * advisory lock: the dedup re-check, the email send, and the delivery-row
 * insert all run INSIDE one `sql.begin` holding the lock. A second process
 * arriving concurrently waits for the lock, then sees the delivery row on
 * re-check and skips.
 *
 * The email send happens inside the transaction — the connection is held
 * during the Resend/Twilio round-trip. Acceptable for the admin-alert
 * volume (low-throughput, seconds-level latency). Revisit if connection
 * pool exhaustion becomes observable.
 *
 * Returns:
 *   'sent'       — we acquired the claim and the provider accepted the message
 *   'deduped'    — a prior alert in the 24h window already exists (no-op)
 *   'send_error' — the provider rejected the send (transaction rolled back;
 *                  next poll will retry since no delivery row persisted)
 */
async function tryClaimAlert(
  responseId: string,
  template: string,
  recipient: string,
  sendFn: () => Promise<string>,
  ctx: { accountId: string; businessId: string; responseId: string },
): Promise<AlertOutcome> {
  let outcome: AlertOutcome = 'deduped';
  try {
    await sql.begin(async (tx) => {
      await tx`
        SELECT pg_advisory_xact_lock(hashtext(${`${responseId}:${template}:${recipient}`}))
      `;
      const [recentAlert] = await tx<{ id: string }[]>`
        SELECT id FROM notification_deliveries
        WHERE response_id = ${responseId}
          AND template = ${template}
          AND recipient = ${recipient}
          AND created_at > NOW() - INTERVAL '24 hours'
        LIMIT 1
      `;
      if (recentAlert) {
        outcome = 'deduped';
        return;
      }
      const messageId = await sendFn();
      await tx`
        INSERT INTO notification_deliveries
          (id, account_id, business_id, response_id, channel, recipient, template, sent_at, external_message_id)
        VALUES (
          ${uuidv7()}, ${ctx.accountId}, ${ctx.businessId}, ${ctx.responseId}, 'email',
          ${recipient}, ${template}, NOW(), ${messageId}
        )
      `;
      outcome = 'sent';
    });
  } catch {
    outcome = 'send_error';
  }
  return outcome;
}

async function recoverFailoverCorrelationId(responseId: string): Promise<string> {
  const [existingSend] = await sql<{ correlation_id: string | null }[]>`
    SELECT payload->>'correlation_id' AS correlation_id
    FROM job_outbox
    WHERE topic = ${QUEUE_NAMES.SEND_NOTIFICATION} AND aggregate_id = ${responseId}
    ORDER BY created_at DESC
    LIMIT 1
  `;
  if (existingSend?.correlation_id) return existingSend.correlation_id;

  const [upstream] = await sql<{ correlation_id: string | null }[]>`
    SELECT jo.payload->>'correlation_id' AS correlation_id
    FROM responses r
    JOIN job_outbox jo
      ON jo.topic = ${QUEUE_NAMES.GENERATE_RESPONSE}
     AND jo.aggregate_id = r.review_id
    WHERE r.id = ${responseId}
    ORDER BY jo.created_at DESC
    LIMIT 1
  `;
  if (upstream?.correlation_id) return upstream.correlation_id;

  return uuidv7();
}

/**
 * Owner-unreachable arm (F1). A draft whose latest completed send_notification
 * recorded `completion_reason='owner_unreachable'` means the account/location had
 * ZERO verified channel enrollments at send time, so nothing was ever delivered.
 * This arm (a) re-enqueues send_notification so delivery retries once a channel
 * might exist, and (b) sends a best-effort 24h-deduped admin escalation email.
 *
 * The candidate SELECT excludes drafts with an in-flight send_notification
 * (matching the all-failed/stale arms) so a backlog of in-flight-stuck oldest
 * rows can't monopolize the BATCH_LIMIT and starve newer drafts. Excluded rows
 * wait ~1 retry cycle for their admin email; the durable Sentry
 * `checkOwnerUnreachable` finding covers them meanwhile.
 *
 * The re-enqueue is advisory-locked and re-checked INSIDE the lock: the candidate
 * SELECT is stale by the time we act, and the plain in-flight `NOT EXISTS` guard
 * alone is not race-safe against a concurrent poller (no unique in-flight index
 * exists). Two independent flags are re-checked under the lock:
 *   - `unreachable` — still owner-unreachable NOW (incl. the 4h age floor). Gates
 *     the admin email (R3-B), but NOT after the owner resolved.
 *   - `in_flight` — a live send_notification exists; gates the retry INSERT. Now
 *     guards the concurrency race (a second poller enqueued between our candidate
 *     SELECT and our lock), not steady-state in-flight rows (already excluded).
 * `sql.begin` returns `unreachable` so a commit failure (throws) => NO email (R3-C).
 */
async function processOwnerUnreachable(
  logger: ReturnType<typeof createWorkerLogger>,
): Promise<void> {
  // Age floor bound to the SAME source as the health check's checkOwnerUnreachable
  // (same env var, same default constant, same num() parse) so the two can't desync.
  const ageFloorSeconds = num(
    getWorkerConfig().HEALTH_ALERT_OWNER_UNREACHABLE_AGE_S,
    OWNER_UNREACHABLE_AGE_FLOOR_SECONDS,
  );
  const rows = await sql<{
    response_id: string;
    business_id: string;
    account_id: string;
    business_name: string;
    reviewer_name: string | null;
    star_rating: number;
  }[]>`
    SELECT resp.id AS response_id, resp.business_id,
           b.account_id, b.name AS business_name, r.reviewer_name, r.star_rating
    FROM responses resp
    JOIN businesses b ON resp.business_id = b.id
    JOIN reviews r ON resp.review_id = r.id
    WHERE resp.status = 'pending_approval'
      AND b.archived_at IS NULL
      AND resp.created_at < NOW() - make_interval(secs => ${ageFloorSeconds})
      AND (
        SELECT jo.completion_reason FROM job_outbox jo
        WHERE jo.topic = ${QUEUE_NAMES.SEND_NOTIFICATION}
          AND jo.aggregate_id = resp.id AND jo.status = 'completed'
        ORDER BY jo.created_at DESC LIMIT 1
      ) = ${OUTBOX_COMPLETION_REASON.OWNER_UNREACHABLE}
      AND NOT EXISTS (
        SELECT 1 FROM notification_deliveries nd
        WHERE nd.response_id = resp.id AND nd.template = 'approval_request'
      )
      AND NOT EXISTS (
        SELECT 1 FROM job_outbox jo
        WHERE jo.topic = ${QUEUE_NAMES.SEND_NOTIFICATION}
          AND jo.aggregate_id = resp.id
          AND jo.status IN ('pending', 'dispatching', 'dispatched')
      )
    ORDER BY resp.created_at ASC
    LIMIT ${BATCH_LIMIT}
  `;

  const adminEmail = getWorkerConfig().ADMIN_NOTIFICATION_EMAIL;
  for (const row of rows) {
    const correlationId = await recoverFailoverCorrelationId(row.response_id);

    let confirmedUnreachable = false;
    try {
      confirmedUnreachable = await sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext(${`send_notification_retry:${row.response_id}`}))`;
        const [state] = await tx<{ unreachable: boolean; in_flight: boolean }[]>`
          SELECT
            EXISTS (
              SELECT 1 FROM responses resp
              JOIN businesses b ON b.id = resp.business_id
              WHERE resp.id = ${row.response_id}
                AND resp.status = 'pending_approval'
                AND b.archived_at IS NULL
                AND resp.created_at < NOW() - make_interval(secs => ${ageFloorSeconds})
                AND (
                  SELECT jo.completion_reason FROM job_outbox jo
                  WHERE jo.topic = ${QUEUE_NAMES.SEND_NOTIFICATION}
                    AND jo.aggregate_id = resp.id AND jo.status = 'completed'
                  ORDER BY jo.created_at DESC LIMIT 1
                ) = ${OUTBOX_COMPLETION_REASON.OWNER_UNREACHABLE}
                AND NOT EXISTS (
                  SELECT 1 FROM notification_deliveries nd
                  WHERE nd.response_id = resp.id AND nd.template = 'approval_request'
                )
            ) AS unreachable,
            EXISTS (
              SELECT 1 FROM job_outbox jo
              WHERE jo.topic = ${QUEUE_NAMES.SEND_NOTIFICATION}
                AND jo.aggregate_id = ${row.response_id}
                AND jo.status IN ('pending', 'dispatching', 'dispatched')
            ) AS in_flight
        `;
        if (!state?.unreachable) return false;
        if (!state.in_flight) {
          await enqueueSendNotification(tx, {
            responseId: row.response_id,
            businessId: row.business_id,
            correlationId,
            failover: { reason: 'owner_unreachable_retry' },
          });
        }
        return true;
      });
    } catch (err: unknown) {
      logger.error(
        'Failed to process owner-unreachable retry',
        { response_id: row.response_id },
        toError(err),
      );
      continue; // commit failed → no retry queued → no email (R3-C)
    }

    // Admin escalation whenever the locked re-check confirmed still-unreachable,
    // regardless of whether a retry was queued this cycle (R3-B). tryClaimAlert
    // 24h-dedups. reviewer_name is NULLABLE (migration 001) and escapeHtml throws
    // on a non-string → coalesce before interpolating (R3-D).
    if (confirmedUnreachable && adminEmail) {
      const reviewerName = row.reviewer_name ?? 'a customer';
      const outcome = await tryClaimAlert(
        row.response_id,
        'admin_notification_owner_unreachable',
        adminEmail,
        async () => {
          const { messageId } = await sendInternalEmail({
            to: adminEmail,
            subject: `Owner unreachable: ${row.business_name} — no verified notification channel`,
            bodyHtml: `<p>A draft response to <strong>${escapeHtml(reviewerName)}</strong>'s ${row.star_rating}-star review of <strong>${escapeHtml(row.business_name)}</strong> cannot be delivered: the owner has <strong>no verified notification channel</strong>. Help them enroll one; the system auto-delivers once a channel is verified.</p><p><em>Response ID: ${row.response_id}</em></p>`,
            category: 'internal',
          });
          return messageId;
        },
        {
          accountId: row.account_id,
          businessId: row.business_id,
          responseId: row.response_id,
        },
      );
      if (outcome === 'send_error') {
        logger.error('Failed to send owner-unreachable alert', { response_id: row.response_id });
      }
    }
  }

  if (rows.length > 0) {
    logger.log('Processed owner-unreachable responses', { count: rows.length });
  }
}

// Arm-dispatcher: one sequential try/catch-isolated block per failover arm
// (all-failed · stale · owner-unreachable), same shape as OutboxPoller's cycle
// runner. Cyclomatic count tracks the arm count, not tangled control flow;
// each arm's logic lives in its own helper (processOwnerUnreachable, etc.).
// fallow-ignore-next-line complexity
export async function runFailoverPollerOnce(): Promise<void> {
  const logger = createWorkerLogger(LOG_PREFIX);

  try {
    // ── 1. All-failed: every approval_request delivery has failed_at set ──
    // IMPORTANT: Process all-failed BEFORE stale. The stale query's "no delivered_at"
    // condition also matches all-failed responses. If stale ran first, its outbox INSERT
    // would cause the all-failed query's in-flight check to skip, and the admin alert
    // would never fire.
    const allFailedResponses = await sql<{
      response_id: string;
      business_id: string;
      account_id: string;
      business_name: string;
      reviewer_name: string;
      star_rating: number;
    }[]>`
      SELECT resp.id AS response_id, resp.business_id,
             b.account_id, b.name AS business_name, r.reviewer_name, r.star_rating
      FROM responses resp
      JOIN businesses b ON resp.business_id = b.id
      JOIN reviews r ON resp.review_id = r.id
      WHERE resp.status = 'pending_approval'
        AND resp.created_at < NOW() - INTERVAL '4 hours'
        AND EXISTS (
          SELECT 1 FROM notification_deliveries nd
          WHERE nd.response_id = resp.id AND nd.template = 'approval_request'
        )
        AND NOT EXISTS (
          SELECT 1 FROM notification_deliveries nd
          WHERE nd.response_id = resp.id
            AND nd.template = 'approval_request'
            AND nd.failed_at IS NULL
        )
        AND NOT EXISTS (
          SELECT 1 FROM job_outbox jo
          WHERE jo.topic = ${QUEUE_NAMES.SEND_NOTIFICATION}
            AND jo.aggregate_id = resp.id
            AND jo.status IN ('pending', 'dispatching', 'dispatched')
        )
      ORDER BY resp.created_at ASC
      LIMIT ${BATCH_LIMIT}
    `;

    for (const row of allFailedResponses) {
      const adminEmail = getWorkerConfig().ADMIN_NOTIFICATION_EMAIL;
      if (adminEmail) {
        // Serialize concurrent failover pollers (multi-instance deployments)
        // on the (response_id, template, recipient) key so only ONE worker
        // fires the admin alert per 24h window. The advisory lock is held for
        // the duration of the dedup-check + send + record, so a second worker
        // arriving in the middle either waits or finds the row on re-check.
        const claimed = await tryClaimAlert(
          row.response_id,
          'admin_notification_failover',
          adminEmail,
          async () => {
            const { messageId } = await sendInternalEmail({
              to: adminEmail,
              subject: `Notification failure: ${row.business_name} — all delivery attempts failed`,
              bodyHtml: `<p>All approval email delivery attempts have failed for a response to <strong>${escapeHtml(row.reviewer_name)}</strong>'s ${row.star_rating}-star review of <strong>${escapeHtml(row.business_name)}</strong>.</p><p>The system will re-attempt delivery. Please check the Resend dashboard for bounce/complaint details.</p>`,
              category: 'internal',
            });
            return messageId;
          },
          {
            accountId: row.account_id,
            businessId: row.business_id,
            responseId: row.response_id,
          },
        );
        if (claimed === 'send_error') {
          logger.error('Failed to send admin alert', { response_id: row.response_id });
        }
      }

      const payload: SendNotificationPayload = {
        response_id: row.response_id,
        business_id: row.business_id,
        failover: { reason: 'all_deliveries_failed' },
        correlation_id: await recoverFailoverCorrelationId(row.response_id),
      };
      // Not enqueueSendNotification: this arm runs OUTSIDE a transaction (there
      // is no accompanying state change to be atomic with), so it cannot take
      // the helper's TransactionSql, and it needs the WHERE NOT EXISTS in-flight
      // guard the helper deliberately does not carry — enqueueSendNotification
      // is a plain INSERT because its callers each gate on a state transition
      // first, and this poller has no such transition to gate on.
      try {
        await sql`
          -- outbox-seam-ignore: no surrounding tx to pass the helper, plus an in-flight dedup guard enqueueSendNotification does not model
          INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
          SELECT
            ${uuidv7()},
            ${QUEUE_NAMES.SEND_NOTIFICATION},
            'response',
            ${row.response_id},
            ${jsonb(payload)},
            'pending'
          WHERE NOT EXISTS (
            SELECT 1 FROM job_outbox jo
            WHERE jo.topic = ${QUEUE_NAMES.SEND_NOTIFICATION}
              AND jo.aggregate_id = ${row.response_id}
              AND jo.status IN ('pending', 'dispatching', 'dispatched')
          )
        `;
      } catch (err: unknown) {
        const code = (err as { code?: string }).code;
        if (code === '23505') continue;
        logger.error(
          'Failed to queue all-failed failover',
          { response_id: row.response_id },
          toError(err),
        );
      }
    }

    if (allFailedResponses.length > 0) {
      logger.log('Processed all-failed responses', { count: allFailedResponses.length });
    }

    // ── 2. Stale: pending_approval >4h, at least one send attempted, no approval ──
    //
    // Query gates on sent_at (we tried to notify), NOT delivered_at. Telegram
    // Bot API has no "delivered to recipient" callback, and SMS/WhatsApp
    // delivery webhooks are unreliable in some regions — gating on
    // delivered_at would false-alert on every Telegram-enrolled owner.
    //
    // Multi-channel era: re-sending has already happened across every enrolled
    // channel on initial dispatch. If the owner hasn't approved after 4h on
    // ANY channel, resending is unlikely to help — escalate to admin instead.
    // See docs/plans/adding-communication-channels.md §3.5.
    const staleResponses = await sql<{
      response_id: string;
      business_id: string;
      account_id: string;
      business_name: string;
      reviewer_name: string;
      star_rating: number;
    }[]>`
      SELECT resp.id AS response_id, resp.business_id,
             b.account_id, b.name AS business_name, r.reviewer_name, r.star_rating
      FROM responses resp
      JOIN businesses b ON resp.business_id = b.id
      JOIN reviews r ON resp.review_id = r.id
      WHERE resp.status = 'pending_approval'
        AND resp.created_at < NOW() - INTERVAL '4 hours'
        AND EXISTS (
          SELECT 1 FROM notification_deliveries nd
          WHERE nd.response_id = resp.id
            AND nd.template = 'approval_request'
            AND nd.sent_at IS NOT NULL
        )
        AND NOT EXISTS (
          SELECT 1 FROM job_outbox jo
          WHERE jo.topic = ${QUEUE_NAMES.SEND_NOTIFICATION}
            AND jo.aggregate_id = resp.id
            AND jo.status IN ('pending', 'dispatching', 'dispatched')
        )
      ORDER BY resp.created_at ASC
      LIMIT ${BATCH_LIMIT}
    `;

    const adminEmail = getWorkerConfig().ADMIN_NOTIFICATION_EMAIL;
    let alertedCount = 0;
    for (const row of staleResponses) {
      if (!adminEmail) {
        logger.warn('Stuck response detected but ADMIN_NOTIFICATION_EMAIL not set — no alert sent', {
          response_id: row.response_id,
        });
        continue;
      }

      const outcome = await tryClaimAlert(
        row.response_id,
        'approval_responsiveness_alert',
        adminEmail,
        async () => {
          const { messageId } = await sendInternalEmail({
            to: adminEmail,
            subject: `Approval stuck: ${row.business_name} — no response in 4+ hours`,
            bodyHtml: `<p>A draft response to <strong>${escapeHtml(row.reviewer_name)}</strong>'s ${row.star_rating}-star review of <strong>${escapeHtml(row.business_name)}</strong> has been waiting for owner approval for more than 4 hours.</p>
              <p>At least one enrolled channel was notified; the owner simply hasn't responded. Check the delivery log for partial failures. Consider a check-in call.</p>
              <p><em>Response ID: ${row.response_id}</em></p>`,
            category: 'internal',
          });
          return messageId;
        },
        {
          accountId: row.account_id,
          businessId: row.business_id,
          responseId: row.response_id,
        },
      );
      if (outcome === 'sent') alertedCount++;
      if (outcome === 'send_error') {
        logger.error('Failed to send responsiveness alert', { response_id: row.response_id });
      }
    }

    if (alertedCount > 0) {
      logger.log('Sent responsiveness alerts', {
        alerted_count: alertedCount,
        stuck_candidate_count: staleResponses.length,
      });
    }

    // ── 3. Owner-unreachable: latest completed send_notification recorded ──
    // completion_reason='owner_unreachable' (zero verified enrollments at send
    // time). Advisory-locked re-enqueue + best-effort admin escalation. Runs
    // AFTER all-failed and stale — its predicate is disjoint (no
    // approval_request delivery ever existed), so ordering is for consistency
    // with the arm-per-concern layout, not correctness.
    await processOwnerUnreachable(logger);
  } catch (error) {
    logger.error('Poll cycle failed', toError(error));
  }
}

const guard = createGuardedPoll(runFailoverPollerOnce, {
  label: LOG_PREFIX,
  intervalMs: getIntervalMs,
  timeoutMs: FAILOVER_CYCLE_TIMEOUT_MS,
});

export function startNotificationFailoverPoller(): void {
  guard.start(() =>
    createWorkerLogger(LOG_PREFIX).log('Starting', { interval_ms: getIntervalMs() }),
  );
}

export function stopNotificationFailoverPoller(): void {
  guard.stop();
}
