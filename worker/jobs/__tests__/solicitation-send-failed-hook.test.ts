// The `'failed'` exhaustion hook for the Solicitation send worker
// (#899 Task 0 — the eval task, Task 7 converts these).
//
// The hook is the ONLY writer that terminalizes an Outreach row on BullMQ
// exhaustion, and its whole correctness rests on one predicate: has the FINAL
// attempt failed? Fire early and a row that still has retries left is written
// `failed` / `send_exhausted` while a later attempt is still allowed to run —
// which, with a stable provider idempotency key, means a "failed" row whose
// message may yet be delivered.
//
// THE TERMINAL PREDICATE HERE IS THE `'failed'`-EVENT FORM — `attemptsMade >=
// max` — and it is deliberately NOT `isTerminalAttempt` from
// `src/lib/shared/outbox.ts`, which is the CATCH-BLOCK form and fires one
// attempt early in this position. `worker/jobs/judge/failed-hook.ts` keeps its
// own copy for exactly this reason and says "do not unify them". Test 34 is
// what stops a future edit from unifying them anyway.
//
// The hook writes the terminal facts itself; it does NOT delegate to the
// terminal job-failure sink (`worker/job-failure-sink.ts`), which raises the
// Sentry issue and writes nothing to `job_outbox` — failed-hooks own that
// surface.

import { describe, it } from 'vitest';

describe('handleSolicitationSendFailed', () => {
  // On the terminal attempt: `delivery_status='failed'` with
  // `disposition_reason='send_exhausted'`, the Lazy child terminalized
  // `failed`, the outbox row marked failed, and `closeBatchIfSettled` called in
  // the SAME transaction — a Settled batch has no Outreach row left in
  // `rendered`, `queued` or `sending`, and an exhausted row that never joins
  // leaves the batch open forever and permanently consumes the account's one
  // active-batch slot.
  it.todo('writes failed with send_exhausted on the terminal attempt and calls closeBatchIfSettled');

  // The negative half, and the one that catches the `isTerminalAttempt`
  // confusion above: with `attemptsMade` one short of `max`, the hook writes
  // NOTHING — no Outreach terminal, no child terminal, no outbox completion.
  // BullMQ still owns the job.
  it.todo('does not terminalize, fail the child, or complete the outbox before the final BullMQ attempt');
});
