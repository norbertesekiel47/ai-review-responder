// Single owner of shared-pool "pool-wait" measurement. Best-effort saturation
// probe: time how long sql.reserve() takes to hand back a connection, release
// immediately. Takes `postgres.Sql` as a parameter (invariant #15). Mirrors
// backlog-depth.ts (the queue-health data-source injection seam). Probes the
// SHARED pool on purpose (plan §"Capacity"); single-flight bounds it to ONE
// outstanding reservation globally so repeated endpoint hits can't accumulate
// queued reservations under a wedge (codex #2). `max` is caller-supplied
// context only (the shared pool's configured ceiling) — never read here.
import type postgres from 'postgres';
import { withTimeout, TimeoutError } from './with-timeout';
import { createWorkerLogger, toError } from './logger';

const logger = createWorkerLogger('pool-wait');

export const DEFAULT_POOL_WAIT_TIMEOUT_MS = 1000;   // < backlog 4s < admin 5s abort
export const DEFAULT_POOL_SATURATING_MS = 50;       // staging-validated 2026-07-20 (ADR 0009): warm reserve p99≈3ms, design burst induced no queueing → ~16x headroom over warm noise, no false-fire under design load

/** postgres.js hands back a ReservedSql (structurally: has release(): void). */
type Reservation = Awaited<ReturnType<postgres.Sql['reserve']>>;

export interface PoolWait {
  /**
   * ms the shared outstanding reservation has been pending (coalesced across
   * callers — a probe reusing an in-flight reservation reports its total age,
   * not just its own wait). On timeout this is a CENSORED LOWER BOUND (>=).
   * May include connect latency, not pure queue wait.
   */
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
let inflightReservation: Promise<Reservation> | null = null;
let reservationStartMs = 0;

/** TEST ONLY: clear the reservation latch between cases. */
export function __resetPoolWaitInflight(): void { inflightReservation = null; }

function sharedReservation(sql: postgres.Sql): { reservation: Promise<Reservation>; startMs: number } {
  if (!inflightReservation) {
    reservationStartMs = Date.now();
    const r = sql.reserve();
    // ONE caught chain: release on resolve, observe the rejection (each caller
    // ALSO surfaces r's rejection through its own withTimeout race on r), then
    // clear the latch on settlement. Do NOT attach a standalone `r.finally()` —
    // finally() returns a DERIVED promise that re-adopts r's rejection with no
    // handler, so a rejecting reserve() emits an unhandledRejection → the
    // worker crash-net's fatal path (worker/index.ts). Keeping the latch-clear
    // INSIDE the caught chain means the only promise deriving from a rejected r
    // is already handled.
    r.then((c) => c.release())
      // Log rather than drop: if every awaiter has already timed out, this is
      // the ONLY observer of a genuine reserve() failure (no silent catch).
      .catch((err) => { logger.warn('pool-wait reserve() rejected (best-effort probe)', toError(err)); })
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
