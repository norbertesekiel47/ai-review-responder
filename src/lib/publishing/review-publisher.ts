// src/lib/publishing/review-publisher.ts
//
// The ReviewPublisher seam (modularity-audit Stage 5). Publishing was hard-wired
// to Zernio across ~7 worker files; the parked direct-GBP path would have been a
// rewrite, not an adapter swap. This interface is the seam: the Zernio adapter is
// the first implementation; a future GoogleBusinessProfile adapter is a second.
//
// SCOPE (locked 2026-06-26): a *transport* seam. The adapter owns Zernio's
// connection lookup, paginated review-id resolution, Redis page-cache, and
// field-match. The worker keeps catching the existing Zernio error classes and
// keeps all DB disposition — neutralizing the error taxonomy is deferred until a
// real GBP adapter forces (and validates) its shape. See
// docs/superpowers/plans/2026-06-26-audit-stage5-review-publisher-seam.md.

import type { ZernioTransientError } from '@/lib/zernio/errors';
import { ZernioReviewPublisher } from './zernio-review-publisher';

/**
 * Neutral identity of a reply-to-publish. App-owned ids ONLY — no provider nouns
 * (account/page/cache) ever appear here. This is the part of the contract worker
 * orchestration reads.
 */
export interface ReviewRef {
  responseId: string;
  reviewId: string;
  businessId: string;
}

/**
 * Provider coordinates that locate a review's reply slot. This is ALL the adapter's
 * transport methods need — the adapter never sees an app-owned id. The fields are
 * provider-shaped (today Zernio's account/location/review ids); they disappear from
 * the worker's view when the GBP adapter forces the error taxonomy to be neutralized.
 */
export interface ReviewLocator {
  /** zernio_account_id */
  accountId: string;
  /** zernio_location_id */
  locationId: string;
  /** Provider's canonical review id (resolved via the adapter's cached lookup). */
  providerReviewId: string;
}

/**
 * A resolved publishing target: a {@link ReviewLocator} plus the neutral {@link ReviewRef}
 * the worker needs for its retained disposition (status transitions, exceptions,
 * Sentry). Produced by `resolveTarget`; passed wherever both the provider coordinates
 * and the app-owned ids are needed (the fresh-post + post-verify paths).
 */
export interface ResolvedPublishTarget extends ReviewLocator {
  ref: ReviewRef;
}

/**
 * Outcome of resolving a {@link ReviewRef} to a publishing target. Every branch the
 * worker dispositions is a neutral result; only a genuinely terminal/unknown lookup
 * error throws (preserving today's bubble-to-BullMQ behavior).
 *
 * - `no_connection`  — no active publishing connection; worker parks for reconnect.
 * - `review_not_found` — the review couldn't be matched on the provider; worker
 *    opens a review_exception. `meta` is the provider's diagnostic (carries its
 *    own `reason`), persisted wholesale into the exception payload.
 * - `transient` — the resolution lookup failed transiently; worker wraps `error`
 *    with attempt context (`accountId`/`locationId`) and rethrows for BullMQ retry.
 * - `resolved` — success; `target` is ready for the transport methods.
 */
export type ResolveTargetResult =
  | { kind: 'no_connection' }
  | { kind: 'review_not_found'; meta: Record<string, unknown> }
  | { kind: 'transient'; accountId: string; locationId: string; error: ZernioTransientError }
  | { kind: 'resolved'; target: ResolvedPublishTarget };

/**
 * Neutral view of the provider feed for the post-verify and 409 paths. `findReply`
 * owns the page-cache bounding internally (a pure provider perf detail the worker
 * must not know about); it surfaces the walk extent as plain diagnostics so callers
 * can preserve their indeterminate-meta and Sentry telemetry.
 *
 * - `review_absent` — our review wasn't in the feed within the bounded walk.
 * - `found` — our review was located; `reply` is its current reply (or `null`).
 */
export type FindReplyResult =
  | { kind: 'review_absent'; pagesWalked: number; reviewsSeen: number }
  | { kind: 'found'; reply: { comment: string } | null };

/**
 * The publishing seam. One adapter today ({@link ZernioReviewPublisher}); the
 * methods are driven by exactly what the publisher worker call-sites need.
 *
 * Transport methods throw the existing provider error classes on failure (deferred
 * neutralization) — the worker catches and dispositions them, exactly as before.
 */
export interface ReviewPublisher {
  /**
   * Resolve a neutral {@link ReviewRef} to a publishing target. Owns ALL provider
   * resolution: the active-connection lookup, the paginated review-id match, and the
   * Redis cache. Returns a neutral {@link ResolveTargetResult}; rethrows genuinely
   * terminal/unknown lookup errors so they bubble as today.
   */
  resolveTarget(ref: ReviewRef): Promise<ResolveTargetResult>;

  /** Post a reply at the located review. Throws provider error classes on failure. */
  publishReply(locator: ReviewLocator, replyText: string): Promise<void>;

  /** Delete the located review's existing reply (edit = DELETE-before-POST). Throws on failure. */
  deleteReply(locator: ReviewLocator): Promise<void>;

  /**
   * Locate the review in the live feed and return its current reply. Bounds the
   * walk via the adapter-internal page cache. Throws provider error classes if the
   * feed fetch itself fails (worker classifies for retry/terminal).
   */
  findReply(locator: ReviewLocator): Promise<FindReplyResult>;
}

let cached: ReviewPublisher | null = null;

/**
 * The active publishing adapter. A lazy singleton (the adapter is stateless and
 * delegates to module-level clients). The factory shape is the selection seam: when
 * the direct-GBP adapter lands it is chosen here, not at every call-site.
 */
export function getReviewPublisher(): ReviewPublisher {
  if (cached === null) cached = new ZernioReviewPublisher();
  return cached;
}
