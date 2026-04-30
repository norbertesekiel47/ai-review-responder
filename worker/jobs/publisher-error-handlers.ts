// worker/jobs/publisher-error-handlers.ts
//
// Shared terminal-sequence helpers for ResponsePublisherWorker. Both the
// in-worker error branches AND the new 409 verifier (Task 19) call into
// these helpers so the canonical disconnect-park-notify (auth) and
// fail-exception-notify (permanent) sequences live in ONE place.
//
// Also exports two error classes used by the 409 verifier path:
//   PublisherTransientWithContext — wraps ZernioTransientError with the
//     attempt's account+location so the failed-hook can pin the disconnect.
//   ZernioReplyVerificationIndeterminateError — thrown when the verifier
//     can't determine ours-vs-external.

import { v7 as uuidv7 } from 'uuid';
import { sql, jsonb } from '../../src/lib/db/server';
import { ZernioTransientError } from '../../src/lib/zernio/errors';
import { markOutboxCompleted } from '../../src/lib/shared/outbox';
import type { WorkerLogger } from '../../src/lib/shared/logger';

/** Strip credential-bearing patterns from an error body before persisting
 *  in audit fields (zernio_connections.last_error, responses.posting_error).
 *  Sentry's breadcrumb scrubber doesn't apply to DB writes. Conservative:
 *  redacts Bearer tokens, basic-auth passwords, and any "token=value" /
 *  "secret=value" / "key=value" pairs in URL/query-string-style strings.
 *  A defensive sanity-check in case Zernio ever echoes a token in 401/403
 *  body (some APIs do). */
function redactSensitiveError(body: string): string {
  return body
    .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer [REDACTED]')
    .replace(/Basic\s+[A-Za-z0-9+/]+=*/gi, 'Basic [REDACTED]')
    .replace(/(token|secret|api[_-]?key|password|authorization)=([^&\s"']+)/gi, '$1=[REDACTED]')
    .replace(/("(token|secret|api[_-]?key|password|authorization)"\s*:\s*)"[^"]*"/gi, '$1"[REDACTED]"');
}

// ── Error classes ───────────────────────────────────────────────────────

/** Wraps a ZernioTransientError with the publisher's attempt context so the
 *  failed hook can pin the disconnect to the attempted account+location.
 *  Subclasses ZernioTransientError so existing `instanceof` checks pass. */
export class PublisherTransientWithContext extends ZernioTransientError {
  constructor(
    inner: ZernioTransientError,
    readonly attemptContext: {
      response_id: string;
      business_id: string;
      account_id: string;
      location_id: string;
    },
  ) {
    super(inner.kind, inner.meta);
    this.cause = inner;
    this.name = 'PublisherTransientWithContext';
  }
}

/** Thrown by the publisher 409 verifier when the existing reply on Google
 *  cannot be verified as ours-vs-external. The publisher's failed-hook
 *  lands the full terminal sequence on retry exhaustion. */
export class ZernioReplyVerificationIndeterminateError extends Error {
  constructor(readonly meta: {
    response_id: string;
    business_id: string;
    review_id: string;
    account_id: string;
    location_id: string;
    zernio_review_id: string;
    reason:
      | 'review_not_found_after_pagination'
      | 'review_found_but_reply_null'
      | 'verifier_unknown_error';
    pages_walked?: number;
    reviews_seen?: number;
    underlying_error?: string;
  }) {
    super(`[409 verifier indeterminate] ${meta.reason} (response=${meta.response_id})`);
    this.name = 'ZernioReplyVerificationIndeterminateError';
  }
}

// ── Terminal helpers ────────────────────────────────────────────────────

interface AuthErrorTerminalArgs {
  response_id: string;
  business_id: string;
  account_id: string;
  location_id: string;
  error_body: string;
  outboxId: string;
  outboxAttempt: number | undefined;
  correlation_id?: string;
  logger: WorkerLogger;
}

/**
 * Full terminal sequence for ZernioAuthError on the publish path:
 *   1. Disconnect the matching active zernio_connections row (PINNED to
 *      account_id + location_id).
 *   2. Park the response at status='awaiting_owner_connect' with
 *      posting_error='zernio_auth_error'.
 *   3. Enqueue notify_owner_reconnect (response-scoped).
 *   4. Enqueue notify_owner_connection_lost (business-scoped, capped to one
 *      per UTC day via migration 026 dedup index) — only if we actually
 *      disconnected something.
 *   5. markOutboxCompleted.
 *
 * Idempotent — re-call on already-disconnected / already-parked no-ops.
 */
export async function handlePublisherAuthErrorTerminal(args: AuthErrorTerminalArgs): Promise<void> {
  const {
    response_id, business_id, account_id, location_id,
    error_body, outboxId, outboxAttempt, logger,
  } = args;

  const safeErrorBody = redactSensitiveError(error_body);

  await sql.begin(async (tx) => {
    const disconnected = await tx`
      UPDATE zernio_connections
      SET status = 'disconnected',
          disconnected_at = NOW(),
          disconnect_reason = 'auth_error_on_publish',
          last_error = ${safeErrorBody},
          last_error_at = NOW(),
          updated_at = NOW()
      WHERE business_id = ${business_id}
        AND zernio_account_id = ${account_id}
        AND zernio_location_id = ${location_id}
        AND status = 'active'
      RETURNING 1
    `;

    // Include awaiting_owner_connect so a re-attempt of an already-parked
    // response (e.g. retry after a transient throw) still routes through
    // notify enqueue. Without this, a parallel publisher attempt could
    // disconnect the connection and then skip the reconnect email because
    // the response UPDATE returns 0 rows.
    const parked = await tx<{ review_id: string }[]>`
      UPDATE responses
      SET status = 'awaiting_owner_connect',
          posting_error = 'zernio_auth_error',
          updated_at = NOW()
      WHERE id = ${response_id}
        AND business_id = ${business_id}
        AND status IN ('approved', 'edited', 'awaiting_owner_connect')
      RETURNING review_id
    `;

    if (parked.length === 0) {
      logger.warn(`Response ${response_id} already terminal — skipping reconnect notify`);
      return;
    }

    const reviewId = parked[0]!.review_id;

    // OwnerEmailWorker dispatches by job.data.kind — 'reconnect_required'
    // routes to sendReconnectRequired; absence falls through to
    // sendConnectionLost (wrong template).
    await tx`
      INSERT INTO job_outbox (
        id, topic, aggregate_type, aggregate_id, payload, attempts, max_attempts
      ) VALUES (
        ${uuidv7()}, 'notify_owner_reconnect', 'response', ${response_id},
        ${jsonb({ kind: 'reconnect_required', response_id, business_id, review_id: reviewId })}, 0, 5
      )
    `;

    if (disconnected.count > 0) {
      await tx`
        INSERT INTO job_outbox (
          id, topic, aggregate_type, aggregate_id, payload, attempts, max_attempts
        ) VALUES (
          ${uuidv7()}, 'notify_owner_connection_lost', 'business', ${business_id},
          ${jsonb({ kind: 'connection_lost', business_id })}, 0, 5
        )
      `;
    }
  });

  await markOutboxCompleted(outboxId, outboxAttempt);
}

interface PermanentErrorTerminalArgs {
  response_id: string;
  business_id: string;
  review_id: string;
  endpoint_kind: string;
  http_status: number;
  error_body: unknown;
  outboxId: string;
  outboxAttempt: number | undefined;
  logger: WorkerLogger;
}

/**
 * Full terminal sequence for ZernioPermanentError / ZernioValidationError
 * on the publish path:
 *   1. Mark response failed with posting_error='zernio_permanent_4xx'.
 *   2. Open review_exception type='zernio_permanent_4xx' (idempotent
 *      ON CONFLICT DO UPDATE).
 *   3. Enqueue notify_admin_review_exception.
 *   4. markOutboxCompleted.
 */
export async function handlePublisherPermanentErrorTerminal(args: PermanentErrorTerminalArgs): Promise<void> {
  const {
    response_id, business_id, review_id, endpoint_kind, http_status,
    error_body, outboxId, outboxAttempt, logger,
  } = args;

  await sql.begin(async (tx) => {
    const updated = await tx`
      UPDATE responses
      SET status = 'failed',
          posting_error = 'zernio_permanent_4xx',
          updated_at = NOW()
      WHERE id = ${response_id}
        AND business_id = ${business_id}
        AND status IN ('approved', 'edited', 'awaiting_owner_connect')
      RETURNING 1
    `;
    if (updated.count === 0) return;

    const [exception] = await tx<{ id: string }[]>`
      INSERT INTO review_exceptions (id, business_id, review_id, response_id, type, payload)
      VALUES (
        ${uuidv7()}, ${business_id}, ${review_id}, ${response_id},
        'zernio_permanent_4xx',
        ${jsonb({
          endpoint_kind,
          http_status,
          error_body,
          retries_exhausted_at: new Date().toISOString(),
        })}
      )
      ON CONFLICT (review_id, type) WHERE status = 'open'
      DO UPDATE SET payload = review_exceptions.payload
      RETURNING id
    `;

    if (exception) {
      await tx`
        INSERT INTO job_outbox (
          id, topic, aggregate_type, aggregate_id, payload, attempts, max_attempts
        ) VALUES (
          ${uuidv7()}, 'notify_admin_review_exception', 'review',
          ${review_id},
          ${jsonb({ review_exception_id: exception.id, business_id })},
          0, 5
        )
      `;
    }
  });

  await markOutboxCompleted(outboxId, outboxAttempt);
  logger.warn(`Response ${response_id} permanently failed (${endpoint_kind} ${http_status}) — exception opened`);
}
