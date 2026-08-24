// The release cycle's PHASE SEAM (#900; extracted in #631's round-1 review):
// the per-item isolation idiom, the phase-level alerting sink, and the tally
// vocabulary every phase of `release.ts`'s `runReleaseCycle` speaks — plus the
// **Veto anchor** (`anchorVetoDeadlines` in `auto-approval.ts`), the first
// phase to live OUTSIDE `release.ts`. It is its own module for exactly that
// reason: while the seam lived inside `release.ts` (which imports the anchor),
// the anchor could not import it back without a cycle, so the anchor carried a
// hand-kept copy — and the copy had already drifted (it baked its phase into
// the message text, breaking the one-stable-prefix rule stated on
// `ITEM_FAILURE_MESSAGE`). One owner, no cycle: both `release.ts` and
// `auto-approval.ts` depend downward on this file.
//
// This is safety-critical error-sink code — the isolate-don't-poison-the-tick
// idiom is the #915 wedge-closure. It must have one owner.
//
// Invariant #15 does not arise here: nothing in this module touches the
// database. The logger prefix is `[SolicitationRelease]` on purpose — every
// phase's failure lines group under the release lane's one prefix, and the
// PHASE rides the log context / Sentry tag, never the prefix or the text.

import * as Sentry from '@sentry/node';
import { createWorkerLogger, toError } from '@/lib/shared/logger';

const logger = createWorkerLogger('[SolicitationRelease]');

/**
 * What one phase's per-item loop did: the items it acted on, and the items it
 * isolated. Both halves are per-PHASE; the cycle report folds them through
 * {@link tallyPhase}.
 */
export interface PhaseTally {
  handled: number;
  failed: number;
}

/** Stable prefix for the isolated-item log line, for the same grouping reason
 *  the release lane's alert titles are constants. The phase is a Sentry TAG
 *  rather than part of the text so one query answers "which phase is
 *  poisoned". */
const ITEM_FAILURE_MESSAGE = 'Solicitation release item failed and was isolated';

/**
 * Run ONE item's body, isolating a throw to that item.
 *
 * **WHY EVERY PER-ITEM LOOP NEEDS THIS, stated once here.** The phases run in
 * sequence and every scan is `ORDER BY … ASC`, so without isolation a single
 * deterministically-failing item is re-selected as the FIRST row of its phase on
 * every subsequent tick and aborts every phase after it — platform-wide, and
 * permanently. That is issue #915's wedge arriving through the door built to
 * close it. One poisoned item must cost one item, not the lane.
 *
 * NOT A SILENT CATCH. Every failure is logged with the ids needed to find the
 * row, counted into `ReleaseCycleReport.itemFailures`, and raised to Sentry —
 * the log line is the fallback sink for Sentry itself being unreachable, so it
 * lives outside that guard, exactly as `alertUnknownTerminalization` does.
 *
 * It does NOT wrap a phase's SCAN, and a scan throw does NOT reach the
 * crash-net. `createGuardedPoll` catches everything `runReleaseCycle` throws and
 * never rethrows (`worker/background/guarded-poll.ts`), so the throw is never an
 * `unhandledRejection` and `worker/index.ts`'s classifier never sees it; what it
 * leaves behind is one `logger.error` JSON line, and the logger has NO Sentry
 * hook (`src/lib/shared/logger.ts`). A scan, `readSendBreaker` or
 * `groupByAccount` throw therefore aborts every LATER phase — P5's backstop join
 * included — on every tick for as long as the condition persists, which is a
 * wider blast radius than any item failure. `alertPhaseFailure` is that class's
 * sink: it alerts and RETHROWS, so the containment behaviour is unchanged and
 * only the alerting is added.
 */
export async function isolateItem<T>(
  phase: string,
  context: Record<string, string>,
  tally: { failed: number },
  body: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await body();
  } catch (error) {
    recordItemFailure(phase, context, tally, error);
    return undefined;
  }
}

/**
 * The sink `isolateItem` wraps. Once exposed for release-phase bodies whose
 * `continue`/`break` could not cross a function boundary; every unit now uses
 * `isolateItem` itself (release.ts "Both units are `isolateItem`"), so the
 * sink is internal again.
 */
function recordItemFailure(
  phase: string,
  context: Record<string, string>,
  tally: { failed: number },
  error: unknown,
): void {
  tally.failed += 1;
  const cause = toError(error);
  try {
    Sentry.captureException(cause, {
      level: 'warning',
      tags: { subsystem: 'solicitation-release', phase },
      extra: { ...context },
    });
  } catch {
    // The log line below is the fallback sink for Sentry itself being
    // unreachable, so it lives OUTSIDE this guard.
  }
  logger.error(ITEM_FAILURE_MESSAGE, cause, { phase, ...context });
}

/** Stable prefix for the phase-level failure line, grouped like the others. The
 *  phase is a Sentry TAG, so one query separates "which phase is poisoned" from
 *  the item-level issues that carry the same tag. */
const PHASE_FAILURE_MESSAGE = 'Solicitation release phase failed and aborted the cycle';

/**
 * Give a PHASE-level throw the alerting sink the per-item catch already has,
 * then RETHROW.
 *
 * **IT CHANGES NO CONTROL FLOW.** The cycle still aborts, `createGuardedPoll`
 * still catches, and the tick still ends without the phases after this one —
 * that containment is deliberate and unchanged. What this closes is the
 * asymmetry `isolateItem`'s docstring describes: an ITEM failure (blast radius
 * one row) raised a Sentry issue while a SCAN failure (blast radius every later
 * phase, every tick, P5's backstop join included) raised nothing at all. A
 * `selectReleaseCandidates` that starts timing out under PgBouncer's
 * `statement_timeout` is exactly that shape — the lane silently stops closing
 * batches and no alert fires.
 *
 * `readSendBreaker`'s throw comes through here too, and belongs here: the throw
 * IS the fail-closed halt signal (#622 §3.2B), and a halt signal that suppresses
 * P5 for as long as it persists is worth an alert. Alerting is not catching —
 * the rethrow is what keeps that invariant intact.
 */
export async function alertPhaseFailure<T>(phase: string, body: () => Promise<T>): Promise<T> {
  try {
    return await body();
  } catch (error) {
    const cause = toError(error);
    try {
      Sentry.captureException(cause, {
        level: 'warning',
        tags: { subsystem: 'solicitation-release', phase },
      });
    } catch {
      // The log line below is the fallback sink for Sentry itself being
      // unreachable, so it lives OUTSIDE this guard.
    }
    logger.error(PHASE_FAILURE_MESSAGE, cause, { phase });
    throw error;
  }
}

/** Fold one phase's tally into the cycle report: the handled count is that
 *  phase's own field, the isolated failures accumulate across the tick. The
 *  report parameter is structurally the `itemFailures` slice of
 *  `ReleaseCycleReport` (owned by `release.ts`), narrowed here so the seam
 *  never has to import its own caller. */
export function tallyPhase(report: { itemFailures: number }, tally: PhaseTally): number {
  report.itemFailures += tally.failed;
  return tally.handled;
}
