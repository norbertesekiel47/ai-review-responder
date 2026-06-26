// worker/transient-rejection-governor.ts
//
// Governor (Release It! pattern) that bounds how long the worker tolerates
// RECOVERED transient-DB unhandledRejections before escalating to a fatal exit.
//
// The crash-net survives an isolated transient-DB blip (the loop reconciles next
// cycle). But a persistently-broken path — a query that ALWAYS times out — would
// otherwise emit warning-level Sentry events forever while `/ready` still returns
// 200 (it only runs `SELECT 1`), leaving the worker alive-but-broken with no
// restart and no page. This governor converts a SUSTAINED storm back into a
// fail-fast crash so Railway restarts the process and restart-alerting fires.
//
// Pure + injectable-clock so the rolling window is unit-testable without booting
// the worker.

const DEFAULT_WINDOW_MS = 60_000; // 1 minute
const DEFAULT_MAX_IN_WINDOW = 20; // > this many recovered rejections in the window → escalate

export interface TransientRejectionGovernor {
  /**
   * Record one recovered transient-DB rejection at `nowMs`. Returns true when the
   * count within the rolling window has EXCEEDED the threshold — the caller should
   * then escalate (fatal exit) instead of silently recovering again.
   */
  record(nowMs: number): boolean;
}

export function createTransientRejectionGovernor(
  opts: { windowMs?: number; maxInWindow?: number } = {},
): TransientRejectionGovernor {
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const maxInWindow = opts.maxInWindow ?? DEFAULT_MAX_IN_WINDOW;
  const hits: number[] = [];

  return {
    record(nowMs: number): boolean {
      const cutoff = nowMs - windowMs;
      while (hits.length > 0 && hits[0]! <= cutoff) hits.shift();
      hits.push(nowMs);
      return hits.length > maxInWindow;
    },
  };
}
