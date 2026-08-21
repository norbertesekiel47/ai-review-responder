// Unit half of `dispatchOutreach` (#899 Task 0 — the eval task).
//
// Everything here is about ORDER, ISOLATION and REDACTION — claims that a live
// database cannot witness because they are about what the module does BETWEEN
// its writes, not about the rows it leaves behind:
//
//   * the two slow gate checks run with NO lock held (decision 3),
//   * a retryable provider failure is absorbed INSIDE one handler invocation
//     with the same idempotency key and the same body (decision 9a),
//   * no raw unsubscribe token and no recipient handle ever reaches a log line
//     (invariant #5 plus CLAUDE.md's structured-logging rule),
//   * neither placeholder survives into the outbound message.
//
// The Messaging adapter is STUBBED here — reached through `getMessagingAdapter()`
// so the stub sits at the seam, never at `EmailAdapter` and never at a Resend
// client. No database, no network, no clock.
//
// Every title is `it.todo` until the task that owns it converts it: these five
// assertions depend on which collaborators `dispatch.ts` calls and in what
// order, and Tasks 3 and 6 make those choices. Writing the assertion now would
// pin an internal seam the plan has deliberately left to the implementer, while
// the two files that CAN be specified today (`dispatch-gate.test.ts`,
// `send-retry.test.ts`) carry real, currently-failing assertions.

import { describe, it } from 'vitest';

describe('dispatchOutreach — gate ordering and provider isolation', () => {
  // Task 3. `moderateResponse` fails OPEN for the reply lane (invariant #4's
  // OPENAI_MODERATION_ENABLED carve-out), and the Solicitation lane inverts
  // that: an unmoderated ask is not a send-eligible ask. The verdict lands at
  // gate slot 9 as `moderationClean: false`, so the row is WITHHELD with
  // `moderation_high` and the adapter stub records zero calls.
  it.todo('treats OPENAI_MODERATION_ENABLED=false as a failed re-moderation and never sends');

  // Task 3. The claim is temporal: re-lint and re-moderation complete before
  // `sql.begin` is entered. A fake `Sql` records when `begin` opens and closes;
  // the moderation stub records when it was called. Holding the batch row lock
  // across a remote call is how one slow provider stalls a whole batch.
  it.todo('runs re-lint and re-moderation before tx1 opens so no lock is held across a slow remote call');

  // Task 4. Assert over the captured logger output: the raw token appears
  // nowhere, only `unsubscribeTokenLogPrefix`'s prefix does, and the recipient
  // handle appears nowhere at all. String args are logged VERBATIM by
  // `createWorkerLogger` — the analytics blocked-key sanitizer only covers
  // object args, so this is not something the logger protects us from.
  it.todo('never logs the raw unsubscribe token or the recipient handle');

  // Task 6. The adapter stub rejects once with a retryable failure, then
  // resolves. Assert: two `send` calls, one handler invocation, and the two
  // calls carry byte-identical `outreachId` (the provider idempotency key) and
  // byte-identical bodies. A retry that rebuilds the body can send a DIFFERENT
  // message under the same key, which is worse than sending twice.
  it.todo('retries a retryable provider failure in process with the same idempotency key and the same body');

  // Task 4. Both placeholders are substituted in memory only. Assert the
  // outbound `OutboundMessage` contains neither literal placeholder, and that
  // the stored bytes handed in were never mutated — a recipient receiving a
  // raw placeholder is a visible defect no other test in this plan catches.
  it.todo('substitutes the review-link placeholder only in the outbound message and never sends the stored placeholder');
});
