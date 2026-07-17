import type { Sql, TransactionSql } from 'postgres';
import { AUDIT_ACTION_AUTO_APPROVED_BY_POLICY } from '../../../src/lib/approval/audit';
import { APPROVAL_METHOD } from '../../../src/lib/auto-approval/types';
import { enqueuePublishResponse } from '../../../src/lib/shared/job-outbox-helpers';
import { markOutboxCompletedIfOwned } from '../../../src/lib/shared/outbox';

export type VetoWindowGateOutcome =
  /** A full veto window has elapsed since the FIRST delivered notice — post. */
  | 'proceed'
  /** Zero delivered pending-post notices — caller downgrades to owner review. */
  | 'downgrade'
  /**
   * Deadline pushed to `first_sent + granted window` (or the push lost a state
   * race). The current outbox row is completed and, on a push, a fresh delayed
   * publish row is enqueued — the caller just returns.
   */
  | 'completed';

interface VetoWindowGateInput {
  responseId: string;
  businessId: string;
  outboxId: string;
  outboxAttempt: number | undefined;
  correlationId: string | undefined;
  logger: { log(message: string): void };
}

type VetoWindowGateRow = {
  first_sent: Date | null;
  db_now: Date;
};

/**
 * Notice-delivery gate for `auto_policy` publishes (spec §2.11).
 *
 * Guarantee enforced: a FULL veto window has elapsed since the FIRST delivered
 * `pending_post_notice`. A bare existence check is not enough — a
 * late-delivered notice (poller backlog, channel retries) would shrink the
 * owner's effective veto window to seconds.
 *
 * The granted window comes from the `auto_approved_by_policy` audit row's
 * `veto_window_minutes`, written in the SAME transaction as the approval
 * (persist.ts) and immutable afterwards. It is deliberately NOT derived from
 * `auto_post_scheduled_at - approved_at`: the push below mutates
 * `auto_post_scheduled_at`, so a delta-derived window would inflate by
 * `first_sent - approved_at` after the first push and the gate would re-push
 * on every subsequent run. (The audit row is already a runtime input — the
 * daily cap counts rows with this action.)
 *
 * One-push invariant: the pushed deadline is the ABSOLUTE instant
 * `first_sent + granted window`. When the re-enqueued job fires at that
 * deadline, `first_sent + window <= NOW()` holds (both operands are immutable
 * — `MIN(sent_at)` can only be set once per delivery row and the audit window
 * never changes), so the gate proceeds: at most ONE push per response, and a
 * redelivered push job recomputes the SAME deadline (idempotent UPDATE, no
 * drift).
 */
export async function enforceElapsedVetoWindow(
  sql: Sql,
  input: VetoWindowGateInput,
): Promise<VetoWindowGateOutcome> {
  return sql.begin((tx) => enforceElapsedVetoWindowInTx(tx, input));
}

/** Caller owns review -> business -> response locks. */
export async function enforceElapsedVetoWindowInTx(
  tx: TransactionSql,
  input: VetoWindowGateInput,
): Promise<VetoWindowGateOutcome> {
  const {
    responseId,
    businessId,
    outboxId,
    outboxAttempt,
    correlationId,
    logger,
  } = input;

  // Aggregate with no GROUP BY: always exactly one row (first_sent NULL when
  // zero delivered notices). db_now keeps the elapsed comparison on the DB
  // clock — the same clock that stamped sent_at.
  const [gate] = await tx<VetoWindowGateRow[]>`
    SELECT
      MIN(nd.sent_at) AS first_sent,
      NOW() AS db_now
    FROM notification_deliveries nd
    WHERE nd.response_id = ${responseId}
      AND nd.business_id = ${businessId}
      AND nd.template = 'pending_post_notice'
      AND nd.sent_at IS NOT NULL
  `;

  if (!gate || gate.first_sent === null) return 'downgrade';

  const [grant] = await tx<{ veto_window_minutes: number | null }[]>`
    SELECT (aal.metadata->>'veto_window_minutes')::int AS veto_window_minutes
    FROM approval_audit_log aal
    WHERE aal.response_id = ${responseId}
      AND aal.business_id = ${businessId}
      AND aal.action = ${AUDIT_ACTION_AUTO_APPROVED_BY_POLICY}
    ORDER BY aal.created_at DESC
    LIMIT 1
  `;

  if (grant?.veto_window_minutes == null) {
    // Impossible state: the approval transition writes the audit row (with
    // veto_window_minutes) in the same tx that stamps auto_policy. A missing
    // window means the approval invariant broke upstream — surface loudly
    // rather than posting without a verifiable veto window.
    throw new Error(
      `Invariant violation: auto_policy response ${responseId} has a delivered ` +
        'pending-post notice but no auto_approved_by_policy audit row with veto_window_minutes',
    );
  }

  // Sub-ms truncation (timestamptz µs → JS Date ms) is absorbed by poller
  // cadence, same as the approval-time availableAt bind in persist.ts.
  const anchoredDeadline = new Date(
    gate.first_sent.getTime() + grant.veto_window_minutes * 60_000,
  );
  if (anchoredDeadline.getTime() <= gate.db_now.getTime()) return 'proceed';

  // Late notice — the window has not fully elapsed yet. Push the deadline to
  // `first_sent + window` instead of posting (would cut the owner's window
  // short) or downgrading (the owner WAS notified; the countdown just started
  // late). One tx: guarded deadline UPDATE → complete the CURRENT outbox row →
  // enqueue a fresh delayed publish row. Completion MUST precede the insert:
  // the in-flight partial index counts pending/dispatching/dispatched rows,
  // and within this tx the completed current row no longer blocks the insert.
  {
    const ownsAttempt = await markOutboxCompletedIfOwned(tx, outboxId, outboxAttempt);
    if (!ownsAttempt) return 'completed';

    const [pushed] = await tx<{ auto_post_scheduled_at: Date }[]>`
      UPDATE responses
      SET auto_post_scheduled_at = ${anchoredDeadline},
          updated_at = NOW()
      WHERE id = ${responseId}
        AND business_id = ${businessId}
        AND status = 'approved'
        AND approval_method = ${APPROVAL_METHOD.AUTO_POLICY}
      RETURNING auto_post_scheduled_at
    `;

    if (!pushed) {
      // State changed since load (vetoed / downgraded / posted) — no-op exit,
      // same shape as the worker's other terminal no-ops.
      logger.log(
        `Veto-window push for response ${responseId} lost a state race; completed outbox ${outboxId} without re-enqueue`,
      );
      return 'completed';
    }

    await enqueuePublishResponse(tx, {
      responseId,
      businessId,
      correlationId,
      availableAt: pushed.auto_post_scheduled_at,
    });
    logger.log(
      `Response ${responseId} veto window extended to ${pushed.auto_post_scheduled_at.toISOString()}, publish re-enqueued`,
    );
    return 'completed';
  }
}
