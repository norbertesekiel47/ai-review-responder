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

// Single owner is src/lib/shared/queue-health-states.ts (shared with the admin
// UI, src/app/admin/jobs); re-exported here so worker/index.ts and this
// module's tests keep importing it from queue-health.
export { QUEUE_HEALTH_JOB_STATES };

const BEARER_PREFIX = 'Bearer ';

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
}

/**
 * Builds the `GET /internal/queue-health` Fastify handler. Responds:
 *   - 503 {disabled:true}        when the secret is unset (no data exposed),
 *   - 401 {error:'unauthorized'} on missing/malformed/mismatched bearer token,
 *   - 200 {queues}               per-queue depths for every ALL_QUEUE_NAMES entry.
 * Returns ONLY queue depths — no PII.
 */
export function createQueueHealthHandler(
  deps: QueueHealthDeps,
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
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

    const queues: Record<string, Record<string, number>> = {};
    for (const name of ALL_QUEUE_NAMES) {
      queues[name] = await deps.getQueueCounts(name);
    }
    reply.code(200).send({ queues });
  };
}
