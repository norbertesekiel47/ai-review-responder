// worker/transient-rejection-governor.ts
//
// Governor (Release It! pattern) that decides when RECOVERED transient-DB
// unhandledRejections have stopped being "transient" and the worker should
// escalate to a fatal exit (so Railway restarts + restart-alerting fires).
//
// The hard part is distinguishing a BURST from a STORM. At boot ~20 pollers +
// 24 queues fire at once, so ONE short DB brownout can fan out into dozens of
// recovered rejections within a few seconds — that is a single transient event
// and MUST be survived. A genuinely broken path instead keeps failing across many
// cycles. So we escalate on DURATION, not raw count: a storm that PERSISTS
// (rejections keep arriving with no idle gap) for at least `sustainedMs` is no
// longer transient. A quiet gap of `idleResetMs` ends the current storm, so a
// brief boot fan-out — however large — never escalates.
//
// Pure + caller-supplied clock → unit-testable without booting the worker.

const DEFAULT_SUSTAINED_MS = 600_000; // 10 min of continuous rejections → escalate
const DEFAULT_IDLE_RESET_MS = 300_000; // 5 min with no rejection → the storm is over

export interface TransientRejectionGovernor {
  /**
   * Record one recovered transient-DB rejection at `nowMs`. Returns true once the
   * current UNINTERRUPTED storm has persisted for at least `sustainedMs` — the
   * caller should then escalate (fatal exit) instead of recovering again.
   */
  record(nowMs: number): boolean;
}

export function createTransientRejectionGovernor(
  opts: { sustainedMs?: number; idleResetMs?: number } = {},
): TransientRejectionGovernor {
  const sustainedMs = opts.sustainedMs ?? DEFAULT_SUSTAINED_MS;
  const idleResetMs = opts.idleResetMs ?? DEFAULT_IDLE_RESET_MS;

  let stormStartMs: number | null = null;
  let lastMs: number | null = null;

  return {
    record(nowMs: number): boolean {
      // The first ever rejection, or one after a long-enough quiet gap, begins a
      // fresh storm (so a brief boot fan-out that then stops can never escalate).
      if (stormStartMs === null || lastMs === null || nowMs - lastMs > idleResetMs) {
        stormStartMs = nowMs;
      }
      lastMs = nowMs;
      return nowMs - stormStartMs >= sustainedMs;
    },
  };
}
