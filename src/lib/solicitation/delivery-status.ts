// The THREE named owners of the send lane's delivery-status subsets (#890).
//
// Three distinct two-and-three-member subsets live in this lane, and each
// answers a DIFFERENT question — that is why there are three constants and why
// none may be derived as the complement of another. One constant answering two
// of these questions is the anti-pattern this file exists to prevent; the
// terminal set (`TERMINAL_DELIVERY_STATUSES`) stays module-private in
// outreach.ts on purpose and is NOT re-exported here.
//
// The SQL spellings of these sets stay LITERAL at their query sites
// (approval.ts's latch/withdraw writes, batch-view.ts's cancellable count):
// the status literals are parameters the query-shape pins assert by value, and
// a bind parameter inside `ON CONFLICT … WHERE` defeats partial-index
// inference. `__tests__/delivery-status.test.ts` mechanically ties those
// literal spellings back to these constants, so a one-sided widening fails a
// test instead of silently understating the admin panel's cancel copy.
//
// This file is a dependency-free leaf ON PURPOSE: two client components
// (ApprovalPanel.tsx, AskList.tsx) import it at runtime, so nothing here may
// pull a server module (invariant #1).

import type { BatchState } from './outreach';

/** May an owner still cancel it? The Halt latch's row predicate and the
 *  withdraw verb's eligible subset — rows not yet handed to a send job. */
export const CANCELLABLE_DELIVERY_STATUSES = ['rendered', 'queued'] as const;

/** Is anything still live? The settledness question `closeBatchIfSettled`
 *  asks — cancellable rows plus `sending`, which is past the point of no
 *  return and resolves itself. */
export const LIVE_DELIVERY_STATUSES = ['rendered', 'queued', 'sending'] as const;

/** What can a dead send job leave behind? The failed-hook's terminalizable
 *  arrivals — `rendered` is absent because that row was never dispatched. */
export const DISPATCHED_ARRIVAL_STATUSES = ['queued', 'sending'] as const;

/** From which Batch states may an owner withdraw one ask? Mirrors
 *  `isWithdrawableState` (approval.ts), which derives from this constant. */
export const WITHDRAWABLE_BATCH_STATES = [
  'veto_window',
  'approved',
  'sending',
] as const satisfies readonly BatchState[];

export type CancellableDeliveryStatus = (typeof CANCELLABLE_DELIVERY_STATUSES)[number];

/** Answers ONLY the cancellable question — never use for liveness (that is
 *  `LIVE_DELIVERY_STATUSES`) or for what a dead job left behind. */
export function isCancellableDeliveryStatus(
  status: string,
): status is CancellableDeliveryStatus {
  return (CANCELLABLE_DELIVERY_STATUSES as readonly string[]).includes(status);
}
