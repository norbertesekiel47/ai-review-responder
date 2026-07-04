// worker/jobs/publisher/publisher-error-handlers.ts
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
//
// verify409AndDispose — extracted from the inline 409 catch block in
//   ResponsePublisherWorker. Returns a discriminated union; caller dispatches.

import { createHash } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import type postgres from 'postgres';
import { sql, jsonb } from '../../../src/lib/db/server';
import { QUEUE_NAMES } from '../../../src/lib/shared/queue-names';
import {
  ZernioAuthError,
  ZernioPermanentError,
  ZernioTransientError,
  ZernioValidationError,
} from '../../../src/lib/zernio/errors';
import { canonicalizeReplyText } from '../../../src/lib/zernio/canonicalize-reply';
import { getReviewPublisher } from '../../../src/lib/publishing/review-publisher';
import type { FindReplyResult, ReviewLocator } from '../../../src/lib/publishing/review-publisher';
import { markOutboxCompleted } from '../../../src/lib/shared/outbox';
import type { WorkerLogger } from '../../../src/lib/shared/logger';
import type { SendOwnerEmailPayload } from '../../../src/lib/shared/worker-types';
import * as Sentry from '@sentry/node';
import { maybeCaptureActivationCompleted } from './activation';
import { markPostedAndMaybeEnqueueAutoPostNotice } from './mark-posted';

/** Strip credential-bearing patterns from an error body before persisting
 *  in audit fields (zernio_connections.last_error, responses.posting_error).
 *  Sentry's breadcrumb scrubber doesn't apply to DB writes. Conservative:
 *  redacts Bearer tokens, basic-auth passwords, and any "token=value" /
 *  "secret=value" / "key=value" pairs in URL/query-string-style strings.
 *  A defensive sanity-check in case Zernio ever echoes a token in 401/403
 *  body (some APIs do). */
export function redactSensitiveError(body: string): string {
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
      | 'reply_text_mismatch'
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
    // sendConnectionLost (wrong template). `satisfies` keeps the payload
    // shape locked against the discriminated union — drop kind/wrong field
    // names and TS catches it at compile time.
    void reviewId;  // not in payload — OwnerEmailWorker reads review_id from DB
    const reconnectPayload = {
      kind: 'reconnect_required',
      response_id,
      business_id,
    } satisfies SendOwnerEmailPayload;
    await tx`
      INSERT INTO job_outbox (
        id, topic, aggregate_type, aggregate_id, payload, attempts, max_attempts
      ) VALUES (
        ${uuidv7()}, 'notify_owner_reconnect', 'response', ${response_id},
        ${jsonb(reconnectPayload)}, 0, 5
      )
    `;

    if (disconnected.count > 0) {
      const lostPayload = {
        kind: 'connection_lost',
        business_id,
      } satisfies SendOwnerEmailPayload;
      await tx`
        INSERT INTO job_outbox (
          id, topic, aggregate_type, aggregate_id, payload, attempts, max_attempts
        ) VALUES (
          ${uuidv7()}, 'notify_owner_connection_lost', 'business', ${business_id},
          ${jsonb(lostPayload)}, 0, 5
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

    // Serialize the unknown-shape error_body to JSON, then run through
    // redactSensitiveError before persisting to review_exceptions.payload.
    // Zernio response bodies for some endpoints (start_connect /
    // select_location / OAuth flows) can carry tokens; this strips
    // Bearer / Basic / token=value / "token":"..." patterns.
    // See Code Review fix Medium 5 (2026-05-02).
    let safeErrorBody: string;
    try {
      safeErrorBody = redactSensitiveError(JSON.stringify(error_body) ?? 'null');
    } catch {
      safeErrorBody = '[unserializable]';
    }

    const [exception] = await tx<{ id: string }[]>`
      INSERT INTO review_exceptions (id, business_id, review_id, response_id, type, payload)
      VALUES (
        ${uuidv7()}, ${business_id}, ${review_id}, ${response_id},
        'zernio_permanent_4xx',
        ${jsonb({
          endpoint_kind,
          http_status,
          error_body: safeErrorBody,
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
          ${uuidv7()}, ${QUEUE_NAMES.NOTIFY_ADMIN}, 'review',
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

// ── verify409AndDispose ─────────────────────────────────────────────────────

/**
 * Discriminated union returned by verify409AndDispose.
 * The caller dispatches on `outcome` — the function itself handles DB writes
 * for 'posted' and 'superseded'; the caller handles terminal notifications for
 * 'auth' and 'permanent'; the caller re-throws for 'transient' and 'indeterminate'.
 */
export type Verify409Result =
  | { outcome: 'posted' }
  | { outcome: 'superseded' }
  | { outcome: 'auth'; lookupErr: ZernioAuthError }
  | { outcome: 'permanent'; lookupErr: ZernioPermanentError | ZernioValidationError }
  | { outcome: 'transient'; lookupErr: ZernioTransientError }
  | {
      outcome: 'indeterminate';
      reason:
        | 'review_not_found_after_pagination'
        | 'review_found_but_reply_null'
        | 'verifier_unknown_error';
      meta: {
        pages_walked?: number;
        reviews_seen?: number;
        underlying_error?: string;
      };
    };

interface Verify409Args {
  response_id: string;
  business_id: string;
  review_id: string;
  account_id: string;
  location_id: string;
  zernio_review_id: string;
  approved_text: string;
  outboxId: string;
  outboxAttempt: number | undefined;
  /** Propagated to the auto-post FYI enqueue on the 409 recovery for trace continuity. */
  correlation_id?: string;
  logger: WorkerLogger;
}

/**
 * 409 verify-first handler per spec §6.10b.
 *
 * When postReply returns ZernioReplyAlreadyExistsError, we cannot safely mark
 * the response 'posted' without confirming the existing reply is OURS. This
 * function walks the review list (using the page-cache from lookupZernioReviewId
 * to bound the maxPages), finds the target review, reads its existing reply, and
 * canonicalize-compares against our approved_text.
 *
 * - 'posted': reply text matches → UPDATE responses posted + mark outbox done
 * - 'superseded': reply text mismatches → UPDATE responses superseded + mark done
 * - 'auth'/'permanent': lookup failed with a terminal Zernio error → caller notifies
 * - 'transient': lookup failed transiently → caller re-throws for BullMQ retry
 * - 'indeterminate': review not found / reply null / unknown → caller re-throws
 *   ZernioReplyVerificationIndeterminateError
 *
 * When the walk hits the cap without finding the target, captures a Sentry
 * warning for ops visibility (cap tuning).
 */
export async function verify409AndDispose(args: Verify409Args): Promise<Verify409Result> {
  const {
    response_id, business_id, review_id,
    account_id, location_id, zernio_review_id,
    approved_text, outboxId, outboxAttempt, correlation_id, logger,
  } = args;

  const locator: ReviewLocator = {
    accountId: account_id,
    locationId: location_id,
    providerReviewId: zernio_review_id,
  };

  let findResult: FindReplyResult;
  try {
    findResult = await getReviewPublisher().findReply(locator);
  } catch (lookupErr) {
    if (lookupErr instanceof ZernioTransientError) {
      logger.warn(
        `409 verifier hit transient error for response ${response_id}: ${lookupErr.message} — wrapping for retry`,
      );
      return { outcome: 'transient', lookupErr };
    }
    if (lookupErr instanceof ZernioAuthError) {
      logger.warn(`409 verifier hit auth error for response ${response_id}`);
      return { outcome: 'auth', lookupErr };
    }
    if (lookupErr instanceof ZernioPermanentError || lookupErr instanceof ZernioValidationError) {
      logger.error(`409 verifier hit permanent error for response ${response_id}: ${lookupErr.message}`);
      return { outcome: 'permanent', lookupErr };
    }
    logger.warn(
      `409 verifier hit unknown error for response ${response_id}: ` +
      `${lookupErr instanceof Error ? lookupErr.message : lookupErr} — indeterminate, retrying`,
    );
    return {
      outcome: 'indeterminate',
      reason: 'verifier_unknown_error',
      meta: {
        underlying_error: lookupErr instanceof Error ? lookupErr.message : String(lookupErr),
      },
    };
  }

  if (findResult.kind === 'review_absent') {
    // Capture for ops visibility — this fires when the review slipped past
    // the page cap (old review pushed back by newer accumulations). Sentry
    // allows tuning maxPages before the problem affects customers.
    Sentry.captureMessage('zernio_409_verifier_pages_walked_at_cap', {
      level: 'warning',
      extra: {
        response_id,
        business_id,
        review_id,
        account_id,
        location_id,
        zernio_review_id,
        pages_walked: findResult.pagesWalked,
        reviews_seen: findResult.reviewsSeen,
      },
    });
    logger.warn(
      `409 verifier could not locate review ${zernio_review_id} after walking ${findResult.reviewsSeen} reviews ` +
      `(maxPages=${findResult.pagesWalked}) — indeterminate, retrying`,
    );
    return {
      outcome: 'indeterminate',
      reason: 'review_not_found_after_pagination',
      meta: { pages_walked: findResult.pagesWalked, reviews_seen: findResult.reviewsSeen },
    };
  }

  const existingReply = findResult.reply;

  if (existingReply === null) {
    logger.warn(
      `409 verifier found review ${zernio_review_id} but reviewReply=null — indeterminate (Zernio lag?), retrying`,
    );
    return {
      outcome: 'indeterminate',
      reason: 'review_found_but_reply_null',
      meta: {},
    };
  }

  const existingText = canonicalizeReplyText(existingReply.comment);
  const ourText = canonicalizeReplyText(approved_text);

  if (existingText === ourText) {
    // Same shared helper as the fresh-2xx path (Codex R1 #1): the auto-post FYI
    // must be enqueued on THIS retry-after-409 recovery too, atomically with the
    // status flip, or it is silently lost. The affected-row guard means a row
    // already posted (no transition) emits no stray FYI.
    await sql.begin(async (tx) => {
      await markPostedAndMaybeEnqueueAutoPostNotice({
        tx,
        responseId: response_id,
        businessId: business_id,
        correlationId: correlation_id,
        logger,
      });
    });
    logger.log(`Response ${response_id} already posted on Zernio (409, text match), marked posted`);
    await maybeCaptureActivationCompleted({
      responseId: response_id,
      businessId: business_id,
      reviewId: review_id,
      logger,
    });
    await markOutboxCompleted(outboxId, outboxAttempt);
    return { outcome: 'posted' };
  }

  await sql`
    UPDATE responses
    SET status = 'superseded',
        posting_error = 'already_replied_external',
        updated_at = NOW()
    WHERE id = ${response_id}
      AND business_id = ${business_id}
      AND status IN ('approved', 'edited', 'awaiting_owner_connect')
  `;
  const fp = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 12);
  logger.warn(
    `Response ${response_id} 409 text mismatch — ` +
    `existing(len=${existingText.length},fp=${fp(existingText)}) ` +
    `ours(len=${ourText.length},fp=${fp(ourText)}) ` +
    `— superseded as already_replied_external`,
  );
  await markOutboxCompleted(outboxId, outboxAttempt);
  return { outcome: 'superseded' };
}

// ── verify409InTx — tx-aware variant for the edit-publisher locked tx ─────────
//
// The existing `verify409AndDispose` opens a fresh `sql` connection and calls
// `markOutboxCompleted` itself. The upcoming edit-publisher branch holds
// `responses FOR UPDATE` on the candidate row inside a `sql.begin` tx;
// invoking `verify409AndDispose` from there would self-deadlock (the verifier's
// separate connection waits forever on the outer tx's lock).
//
// `verify409InTx` differs from `verify409AndDispose` by:
//   - Taking the open `tx: postgres.TransactionSql` as its first arg so any
//     reads share the outer tx's snapshot/locks. Currently no reads are needed
//     beyond the Zernio listReviews HTTP call; the param is reserved for
//     future use (e.g. fetching audit context inside the same tx).
//   - Returning a discriminated union — caller dispatches.
//   - NOT calling `markOutboxCompleted` (caller owns the outbox lifecycle).
//   - NOT writing to `responses` or any sibling rows (caller owns the writes).
//
// All other behavior — page-cache lookup, maxPages bounding, error
// classification, canonicalization — matches `verify409AndDispose`.

/**
 * Discriminated union returned by `verify409InTx`. The caller dispatches on
 * `disposition`. Mismatch/match expose the canonicalized verifier text so the
 * caller can record it (e.g. into responses.posting_error context or audit).
 */
export type Verify409Disposition =
  | { disposition: 'matches_our_text'; verifierText: string }
  | { disposition: 'mismatch'; verifierText: string }
  | {
      disposition: 'indeterminate';
      reason:
        | 'review_not_found_after_pagination'
        | 'review_found_but_reply_null'
        | 'verifier_unknown_error';
      meta: {
        pages_walked?: number;
        reviews_seen?: number;
        underlying_error?: string;
      };
    }
  | { disposition: 'auth'; lookupErr: ZernioAuthError }
  | { disposition: 'permanent'; lookupErr: ZernioPermanentError | ZernioValidationError }
  | { disposition: 'transient'; lookupErr: ZernioTransientError };

interface Verify409InTxArgs {
  /** Outer tx — currently unused but reserved so future reads share its
   *  snapshot/locks without changing the public signature. */
  tx: postgres.TransactionSql;
  account_id: string;
  location_id: string;
  zernio_review_id: string;
  approved_text: string;
  logger: WorkerLogger;
}

/**
 * Tx-aware 409 verifier for the edit-publisher path.
 *
 * The edit-publisher holds `responses FOR UPDATE` inside an open `sql.begin`
 * tx. Calling `verify409AndDispose` from that context would self-deadlock
 * (separate connection waiting forever on the outer lock). This function takes
 * the open tx handle and performs the same Zernio listReviews walk and
 * canonicalization comparison without touching the DB or outbox — the caller
 * owns all writes and the outbox lifecycle.
 *
 * Returns a `Verify409Disposition` discriminated union:
 * - 'matches_our_text': existing Google reply canonicalizes to our approved_text
 * - 'mismatch': reply exists but differs — real conflict
 * - 'indeterminate': review not found / reply null / unknown error
 * - 'auth' / 'permanent' / 'transient': Zernio lookup error classifications
 */
export async function verify409InTx(args: Verify409InTxArgs): Promise<Verify409Disposition> {
  const { account_id, location_id, zernio_review_id, approved_text, logger } = args;

  const locator: ReviewLocator = {
    accountId: account_id,
    locationId: location_id,
    providerReviewId: zernio_review_id,
  };

  let findResult: FindReplyResult;
  try {
    findResult = await getReviewPublisher().findReply(locator);
  } catch (lookupErr) {
    if (lookupErr instanceof ZernioAuthError) {
      return { disposition: 'auth', lookupErr };
    }
    if (lookupErr instanceof ZernioTransientError) {
      return { disposition: 'transient', lookupErr };
    }
    if (lookupErr instanceof ZernioPermanentError || lookupErr instanceof ZernioValidationError) {
      return { disposition: 'permanent', lookupErr };
    }
    logger.warn(
      `409 verifier (in-tx) hit unknown error: ${lookupErr instanceof Error ? lookupErr.message : lookupErr}`,
    );
    return {
      disposition: 'indeterminate',
      reason: 'verifier_unknown_error',
      meta: {
        underlying_error: lookupErr instanceof Error ? lookupErr.message : String(lookupErr),
      },
    };
  }

  if (findResult.kind === 'review_absent') {
    return {
      disposition: 'indeterminate',
      reason: 'review_not_found_after_pagination',
      meta: { pages_walked: findResult.pagesWalked, reviews_seen: findResult.reviewsSeen },
    };
  }

  if (findResult.reply == null) {
    // Loose-equality catches both null and undefined (defense-in-depth;
    // findReply normalizes to null today but the guard is cheap).
    return {
      disposition: 'indeterminate',
      reason: 'review_found_but_reply_null',
      meta: {},
    };
  }

  const verifierText = canonicalizeReplyText(findResult.reply.comment);
  const ourText = canonicalizeReplyText(approved_text);
  if (verifierText === ourText) {
    return { disposition: 'matches_our_text', verifierText };
  }
  return { disposition: 'mismatch', verifierText };
}
