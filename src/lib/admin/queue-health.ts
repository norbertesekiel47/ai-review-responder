// src/lib/admin/queue-health.ts
//
// Extracted verbatim from src/app/api/admin/jobs/route.ts's fetchQueueHealth
// (admin console Phase 2, Task 3). No logic changes — every degrade branch
// (missing secret, bad worker URL, non-200, missing `queues`, throw/timeout)
// is preserved so the route's existing tests define this module's contract.

import { getServerConfig } from '@/lib/config/server';
import { getWorkerPublicUrl } from '@/lib/shared/worker-public-url';

// Vercel = UI only (invariant #1): per-queue depth lives on the Railway worker,
// which owns the BullMQ/Railway-Redis connection (Vercel can't reach the private
// IPv6-only network). This fetches the worker's authed internal endpoint
// server-side with a short, explicit timeout and NO retry — an admin read that
// degrades to {unavailable:true} on any failure rather than blocking the panel.
export const QUEUE_HEALTH_TIMEOUT_MS = 5_000;

// Local HTTP-boundary mirror of the PoolWait shape, whose canonical owner is
// src/lib/shared/pool-wait.ts (a type-only import would be invariant-#1-legal,
// but this route mirrors its queue-health DTOs locally by convention — same as
// `queueHealth` — to keep the admin boundary decoupled from probe-internal
// semantics). Kept in lockstep with that owner.
export type PoolWaitPayload = { waitMs: number; timedOut: boolean; saturating: boolean; max: number };

export interface QueueHealthResult {
  queueHealth: Record<string, Record<string, number>> | { unavailable: true };
  pool: PoolWaitPayload | null;
}

/**
 * Fetch per-queue depth (+ the worker's best-effort shared-pool wait) from the
 * Railway worker's authed internal endpoint. `queueHealth` degrades to the
 * existing graceful shape `{ unavailable: true }` and `pool` to `null` on ANY
 * failure — missing config (WORKER_PUBLIC_URL / WORKER_INTERNAL_SECRET), invalid
 * worker URL, non-200, network error, or the 5s timeout — logging a warning
 * instead of throwing, so the panel always renders. Never logs the secret. The
 * worker may itself return `pool:null` (probe unavailable) even on a 200; that
 * passes through unchanged.
 */
export async function fetchQueueHealth(): Promise<QueueHealthResult> {
  const unavailable: QueueHealthResult = { queueHealth: { unavailable: true }, pool: null };

  const secret = getServerConfig().WORKER_INTERNAL_SECRET;
  if (!secret) return unavailable;

  let origin: string;
  try {
    origin = getWorkerPublicUrl();
  } catch {
    // WORKER_PUBLIC_URL unset or not a valid URL — degrade silently.
    return unavailable;
  }

  try {
    const response = await fetch(`${origin}/internal/queue-health`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(QUEUE_HEALTH_TIMEOUT_MS),
      cache: 'no-store',
    });
    if (!response.ok) {
      console.warn(`[api/admin/jobs] worker queue-health returned ${response.status}; queue health unavailable`);
      return unavailable;
    }
    const body = (await response.json()) as {
      queues?: Record<string, Record<string, number>>;
      pool?: PoolWaitPayload | null;
    };
    if (!body.queues) {
      console.warn('[api/admin/jobs] worker queue-health response missing queues; queue health unavailable');
      return unavailable;
    }
    return { queueHealth: body.queues, pool: body.pool ?? null };
  } catch (error) {
    console.warn('[api/admin/jobs] worker queue-health fetch failed; queue health unavailable:', error);
    return unavailable;
  }
}
