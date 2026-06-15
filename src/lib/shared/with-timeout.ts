/**
 * Bound an awaited promise with an explicit deadline (production.md: "Put
 * explicit, intentional time limits on outbound calls and waits. Do not rely
 * on library defaults or allow infinite waits where finite response matters.").
 *
 * Used by the readiness probes (`readiness.ts`) and the OutboxPoller dispatch
 * loop, where a BullMQ enqueue can otherwise park forever in ioredis' offline
 * command queue (the queue connection uses `maxRetriesPerRequest: null`).
 */

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

/**
 * Race `work` against a timer. If `work` has not settled within `ms`, reject
 * with a {@link TimeoutError}. The timer is always cleared, so a `work` that
 * settles first never leaves a dangling handle.
 *
 * Contract caller obligation: a timeout rejection does NOT cancel `work` — the
 * underlying promise keeps running detached. Callers that hold a resource
 * (lock, claimed row) across `work` must assume it may still settle later and
 * design the recovery path accordingly (e.g. the OutboxPoller's stale-claim
 * watchdog re-pends a row whose dispatch timed out).
 */
export async function withTimeout<T>(work: Promise<T>, ms: number, label = 'operation'): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
