// worker/internal/queue-health.ts
//
// First-party internal endpoint (NOT third-party webhook ingress, so it lives in
// worker/internal/ rather than worker/ingress/ — invariant #6). Backs the Vercel
// admin jobs panel's per-queue depth: the panel can't read Railway Redis directly
// (private network is IPv6-only / not Vercel-reachable, invariant #1), so it
// fetches this endpoint server-side instead (#408).
//
// Auth: shared bearer secret (WORKER_INTERNAL_SECRET), compared in constant time.
// When the secret is unset the endpoint refuses to expose data (503 {disabled})
// so absence degrades cleanly instead of opening an unauthenticated surface.
//
// The handler is dependency-injected (secret reader + per-queue count fetcher) so
// worker/index.ts owns the BullMQ/Redis wiring and this module stays unit-testable
// without booting the queues (invariant #12).

import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ALL_QUEUE_NAMES } from '../../src/lib/shared/queue-names';
import { QUEUE_HEALTH_JOB_STATES } from '../../src/lib/shared/queue-health-states';
import { withTimeout } from '../../src/lib/shared/with-timeout';
import { createWorkerLogger, toError } from '../../src/lib/shared/logger';
import type { BacklogDepth } from '../../src/lib/shared/backlog-depth';

// Single owner is src/lib/shared/queue-health-states.ts (shared with the admin
// UI, src/app/admin/jobs); re-exported here so worker/index.ts and this
// module's tests keep importing it from queue-health.
export { QUEUE_HEALTH_JOB_STATES };

const BEARER_PREFIX = 'Bearer ';

const LOG_PREFIX = '[queue-health]';

// Deadline for the best-effort Postgres backlog read. Kept < the admin
// consumer's 5s AbortSignal deadline (src/app/api/admin/jobs/route.ts) so a slow
// count degrades to `backlog: null` here instead of aborting the whole request.
export const BACKLOG_ENDPOINT_TIMEOUT_MS = 4000;

/**
 * Constant-time bearer-secret check. Requires `Authorization: Bearer <secret>`
 * and a byte-for-byte match with `secret`. The length guard is necessary because
 * `timingSafeEqual` throws on unequal-length buffers; it leaks only the token
 * length, never its bytes. Returns false for any missing/malformed header.
 */
export function isAuthorizedQueueHealthRequest(
  authHeader: string | undefined,
  secret: string,
): boolean {
  if (!authHeader || !authHeader.startsWith(BEARER_PREFIX)) return false;
  const provided = Buffer.from(authHeader.slice(BEARER_PREFIX.length));
  const expected = Buffer.from(secret);
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

export interface QueueHealthDeps {
  /** Resolves the shared secret at request time; undefined ⇒ endpoint disabled. */
  getSecret: () => string | undefined;
  /** Per-queue job counts for the QUEUE_HEALTH_JOB_STATES set. */
  getQueueCounts: (queueName: string) => Promise<Record<string, number>>;
  /**
   * Best-effort Postgres backlog read (pending-row counts for job_outbox +
   * analytics_events). May be slow or fail; the handler bounds the WAIT with
   * BACKLOG_ENDPOINT_TIMEOUT_MS and degrades to `backlog: null` on any
   * error/timeout — it never regresses the primary `queues` signal.
   */
  getBacklogDepth: () => Promise<BacklogDepth>;
}

/**
 * Builds the `GET /internal/queue-health` Fastify handler. Responds:
 *   - 503 {disabled:true}                 when the secret is unset (no data exposed),
 *   - 401 {error:'unauthorized'}          on missing/malformed/mismatched bearer token,
 *   - 200 {queues, backlog}               per-queue depths + best-effort Postgres backlog.
 *
 * `queues` is ALWAYS returned. `backlog` is `BacklogDepth | null`: a
 * best-effort add-on that degrades to `null` on any error/timeout and must not
 * regress the primary `queues` signal. Returns ONLY integer counts — no PII.
 */
export function createQueueHealthHandler(
  deps: QueueHealthDeps,
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  const logger = createWorkerLogger(LOG_PREFIX);
  return async function handleQueueHealth(request, reply) {
    const secret = deps.getSecret();
    if (!secret) {
      reply.code(503).send({ disabled: true });
      return;
    }

    if (!isAuthorizedQueueHealthRequest(request.headers.authorization, secret)) {
      reply.code(401).send({ error: 'unauthorized' });
      return;
    }

    // Start the timed + already-caught backlog read BEFORE the sequential queue
    // loop so its 4000ms deadline overlaps queue collection (no added latency)
    // and its rejection is handled immediately (no unhandled-rejection window).
    // This withTimeout bounds the WAIT; the query itself is separately bounded to
    // ~4s by queryBacklogDepth's `SET LOCAL statement_timeout`, so a slow count is
    // cancelled server-side and its pooled connection is released — it never
    // lingers to the 30s global statement_timeout.
    const backlogResult: Promise<BacklogDepth | null> = withTimeout(
      deps.getBacklogDepth(),
      BACKLOG_ENDPOINT_TIMEOUT_MS,
      'queue-health-backlog',
    ).catch((err: unknown) => {
      logger.warn('queue-health backlog unavailable', toError(err));
      return null;
    });

    const queues: Record<string, Record<string, number>> = {};
    for (const name of ALL_QUEUE_NAMES) {
      queues[name] = await deps.getQueueCounts(name);
    }

    const backlog = await backlogResult; // already settled → no extra wait
    reply.code(200).send({ queues, backlog });
  };
}
