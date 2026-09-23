// Two named send strategies shared by OnboardingDripWorker (`day_7`) and
// EngagementAlertWorker (the owner nudge) — the two send-then-mark shapes
// #1363 hardened against a crash between "provider accepted" and "local
// state says sent". Each caller supplies its own mark/send/record steps by
// injection; this module owns only the SHAPE (#1403). Pure: no `sql` import,
// no domain vocabulary — see `docs/context/core-platform-runtime.md`
// "Send idempotency key" / "Idempotent replay" for the provider mechanics
// both strategies exist to defend.
import type { WorkerLogger } from '../../src/lib/shared/logger';

export interface SendMarkedFirstInput<TSendResult> {
  logger: WorkerLogger;
  /** Short label for log lines, e.g. `'day_7'` or `'owner nudge'`. */
  label: string;
  /** Commits durable state BEFORE the send. Never rolled back on failure. */
  mark: () => Promise<void>;
  /** The provider send. Must carry no idempotency key (see module header). */
  send: () => Promise<TSendResult>;
  /** Best-effort durable failure record, given the raw error message. */
  recordFailure: (reason: string) => Promise<void>;
  /** Runs only after a successful send. */
  recordSuccess: (result: TSendResult) => Promise<void>;
}

/**
 * Strategy 1: mark-before-send.
 *
 * The mark is committed before the send and is never rolled back — a send
 * timeout can fire while the request is still in flight at the provider, so
 * rolling back would risk a duplicate the mark exists to prevent. A send
 * failure is therefore never rethrown: the mark is already committed, so a
 * caller-level retry cannot help and could only send twice. `recordFailure`
 * is the failure's only durable trace, and gets its OWN `try/catch`
 * (`.claude/rules/worker-layout.md` "Best-effort work after a worker's
 * primary side effect") — an unguarded rejection there would escape this
 * function and let the caller's retry machinery re-enter a flow whose mark
 * is already set.
 */
export async function sendMarkedFirst<TSendResult>(
  input: SendMarkedFirstInput<TSendResult>,
): Promise<void> {
  await input.mark();

  let result: TSendResult;
  try {
    result = await input.send();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    input.logger.error(`${input.label} send failed after mark: ${reason}`);
    try {
      await input.recordFailure(reason);
    } catch (recordErr) {
      input.logger.error(
        `${input.label} could not record the send failure: ${recordErr instanceof Error ? recordErr.message : String(recordErr)}`,
      );
    }
    return;
  }

  await input.recordSuccess(result);
}

export interface SendKeyedInput<TSendResult> {
  /** The provider send, carrying a stable idempotency key. */
  send: () => Promise<TSendResult>;
  /** Runs after a successful send — a fresh delivery OR an idempotent replay. */
  recordSuccess: (result: TSendResult) => Promise<void>;
}

/**
 * Strategy 2: keyed send, no mark.
 *
 * Deliberately has no `try/catch`: nothing has marked durable state yet, so
 * a send failure propagates unchanged and the caller's retry machinery
 * (BullMQ) can legitimately re-send under the same idempotency key. An
 * idempotent replay (the provider's 409 for a key already used) is not a
 * failure — the caller's `send` resolves it rather than throwing — so it
 * reaches `recordSuccess` like any other delivery; the caller decides
 * whether and how to log it.
 */
export async function sendKeyed<TSendResult>(
  input: SendKeyedInput<TSendResult>,
): Promise<void> {
  const result = await input.send();
  await input.recordSuccess(result);
}
