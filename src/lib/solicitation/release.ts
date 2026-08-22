// The Solicitation release lane (#900) — one deep module behind one function.
//
// PHASE ORDER, and the order is the contract rather than an implementation
// detail:
//
//   1. `unknown` sweep (D12d)   — first, so a wedged row can settle its batch
//                                 in this same tick.
//   2. `send_window_elapsed`    — before release, so an overdue batch never
//                                 releases.
//   3. `batch_expired` (B7)
//   4. RELEASE phase            — the only phase gated on
//                                 `SOLICITATION_SEND_ENABLED`.
//   5. backstop join (D11)      — `closeBatchIfSettled` over every still-open
//                                 batch the tick saw. One implementation, two
//                                 callers; the backstop cannot drift from the
//                                 inline path.
//
// THE FLAG GATES PHASE 4 ONLY, and that departs from the `JudgeSweepPoller`
// precedent deliberately. If the whole cycle were flag-gated, flipping
// `SOLICITATION_SEND_ENABLED` off mid-drip would stop phase 2, so the batch's
// `queued` rows would never be reclaimed and migration 091's
// `solicitation_batches_one_active_send_per_business` index would block that
// location forever. That is the permanent wedge issue #915 exists to close.
//
// RELEASE-LEVEL GOVERNOR ORDER, quoted from amendment B6's closing paragraph
// rather than inferred: circuit breaker -> platform ceiling -> account cap ->
// `subscriptionGrantsFullAccess`, then the Judge availability split (#619 D18).
// B6's per-child item numbering is a DIFFERENT list and does not govern here.
// A wrong order is silent — issue #910's B3.2.
//
// The Judge is evaluated LAST, and that position is load-bearing: a downgrade
// clears `approved_at`, so evaluating it before the account cap would destroy
// the approval evidence of a batch the cap alone would simply have stopped.
//
// Caps are enforced HERE ONLY (amendment B3) — a single loop on the
// single-replica worker, serialized by construction, which is what replaces
// atomic-reservation machinery. If this loop is ever parallelized, that
// resolution must be revisited (P2 entry in
// docs/future-plans/2026-06-17-worker-scaling-hardening-backlog.md).
//
// Invariant #15: this module takes its DB client as an explicit parameter and
// never imports `@/lib/db/server`. Its composition root is
// `worker/background/pollers/SolicitationReleasePoller.ts`.

import type { Sql } from 'postgres';

/**
 * Which release-level gate withheld a release. A closed union — a new member
 * means a new gate, and every gate is named in the module header's order.
 */
export type ReleaseWithheldReason =
  | 'flag_off'
  | 'breaker_open'
  | 'platform_ceiling'
  | 'account_cap'
  | 'subscription'
  | 'judge_unhealthy'
  | 'per_tick_budget';

export interface ReleaseCycleReport {
  released: number;
  /** The FIRST gate that stopped the whole release phase, or null when it ran. */
  releasePhaseStoppedBy: ReleaseWithheldReason | null;
  /** Per-account and per-batch withholds, counted by reason. */
  withheldByReason: Partial<Record<ReleaseWithheldReason, number>>;
  downgraded: number;
  heldForJudge: number;
  sendWindowElapsed: number;
  batchExpired: number;
  unknownTerminalized: number;
  backstopClosed: number;
}

export interface ReleaseCycleOptions {
  /** Outreach rows released platform-wide per tick. Default RELEASE_PER_TICK_BUDGET. */
  perTickBudget?: number;
  /** Candidate rows scanned per phase. Default RELEASE_SCAN_LIMIT. */
  scanLimit?: number;
}

/**
 * The drip's pacing lever, and the only one this lane owns.
 *
 * The deliverability spec §7.1 asks dispatch to yield to transactional mail on
 * the shared 10 req/s Resend TEAM limit. The releaser is the only producer of
 * `solicitation_send` jobs, so bounding its output per tick is the scheduling
 * act available to it. At a 60s cadence a full 10-row account daily cap drips
 * over five minutes. True priority-yielding against a shared limiter is NOT
 * built here.
 */
export const RELEASE_PER_TICK_BUDGET = 2;

/** Rows scanned per phase per tick. Bounds the tick, and every phase logs what it dropped. */
export const RELEASE_SCAN_LIMIT = 50;

/**
 * Run one release cycle.
 *
 * Deliberately the module's ONLY export beyond its vocabulary: the phase order
 * is a domain rule, so a caller that could run the phases separately could run
 * them wrongly. The phases' predicates are disjoint, which is what makes each
 * one testable through this single interface by seeding only its own state.
 */
export async function runReleaseCycle(
  _sql: Sql,
  _options?: ReleaseCycleOptions,
): Promise<ReleaseCycleReport> {
  throw new Error('runReleaseCycle: not implemented (#900 tasks 3-7)');
}
