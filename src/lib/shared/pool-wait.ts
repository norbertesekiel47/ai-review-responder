// Single owner of shared-pool "pool-wait" measurement. Best-effort saturation
// probe: time how long sql.reserve() takes to hand back a connection, release
// immediately. Takes `postgres.Sql` as a parameter (invariant #15). Mirrors
// backlog-depth.ts (the queue-health data-source injection seam). Probes the
// SHARED pool on purpose (plan §"Capacity"); single-flight bounds it to ONE
// outstanding reservation globally so repeated endpoint hits can't accumulate
// queued reservations under a wedge (codex #2).
import type postgres from 'postgres';
import { withTimeout, TimeoutError } from './with-timeout';

export const DEFAULT_POOL_WAIT_TIMEOUT_MS = 1000;   // < backlog 4s < admin 5s abort
export const DEFAULT_POOL_SATURATING_MS = 50;       // PROVISIONAL default — calibrate on staging (Task 4 step 4); not final

export interface PoolWait {
  /** ms waiting for reserve(); on timeout this is a CENSORED LOWER BOUND (>=). May include connect latency, not pure queue wait. */
  waitMs: number;
  /** true when reserve() did not resolve within timeoutMs (waitMs is then a floor). */
  timedOut: boolean;
  /** timedOut OR waitMs >= threshold. */
  saturating: boolean;
  /** the shared pool's configured max (context). */
  max: number;
}
export interface PoolWaitOptions { timeoutMs: number; saturatingThresholdMs: number; max: number; }

// The latch is the RESERVATION promise itself, cleared ONLY when it SETTLES
// (resolve or reject) — NOT when a caller's bounded wait times out. So under a
// wedge, repeated callers reuse the ONE pending reserve() (no accumulation in
// postgres.js's internal queue — codex #2/#10), each racing it against their own
// withTimeout. release() is attached once, fires on settlement even if every
// caller has already timed out (leak-safe).
let inflightReservation: Promise<{ release: () => void }> | null = null;
let reservationStartMs = 0;

/** TEST ONLY: clear the reservation latch between cases. */
export function __resetPoolWaitInflight(): void { inflightReservation = null; }

function sharedReservation(sql: postgres.Sql): { reservation: Promise<{ release: () => void }>; startMs: number } {
  if (!inflightReservation) {
    reservationStartMs = Date.now();
    const r = sql.reserve() as unknown as Promise<{ release: () => void }>;
    // ONE caught chain: release on resolve, swallow the rejection (each caller
    // still observes r's rejection through its own withTimeout race on r), then
    // clear the latch on settlement. Do NOT attach a standalone `r.finally()` —
    // finally() returns a DERIVED promise that re-adopts r's rejection with no
    // handler, so a rejecting reserve() emits an unhandledRejection → the
    // worker crash-net's fatal path (worker/index.ts). Keeping the latch-clear
    // INSIDE the caught chain means the only promise deriving from a rejected r
    // is already handled.
    r.then((c) => c.release())
      .catch(() => { /* observed here; also surfaced to awaiters via their race on r */ })
      .finally(() => { inflightReservation = null; });
    inflightReservation = r;
  }
  return { reservation: inflightReservation, startMs: reservationStartMs };
}

/**
 * Best-effort pool-wait sample. Every caller gets an independently-bounded wait
 * (withTimeout) over the ONE shared reservation. Timeout → timedOut:true,
 * saturating:true, waitMs = timeoutMs (censored lower bound). A genuine
 * reserve() rejection propagates to every awaiter (handler → pool:null).
 */
export async function probePoolWait(sql: postgres.Sql, opts: PoolWaitOptions): Promise<PoolWait> {
  const { reservation, startMs } = sharedReservation(sql);
  try {
    await withTimeout(reservation, opts.timeoutMs, 'pool-wait-probe');
    const waitMs = Date.now() - startMs;
    return { waitMs, timedOut: false, saturating: waitMs >= opts.saturatingThresholdMs, max: opts.max };
  } catch (err) {
    if (err instanceof TimeoutError) return { waitMs: opts.timeoutMs, timedOut: true, saturating: true, max: opts.max };
    throw err;
  }
}
