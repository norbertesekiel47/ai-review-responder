# Plan review — orchestrator self-review (round 2, eval-first)

Question asked: **can the 23-test eval pass while the feature is still wrong?**
Answer: yes, in six ways. Each gap below is stated as a missing failing test.

## Findings

| # | Severity | Artifact | Finding |
|---|---|---|---|
| S1 | **critical** | plan Task 6 / Task 0 test 14 | No test proves a re-dispatched job does not send twice. Test 14 asserts the gate is skipped, not that the provider sees the same idempotency key. Executor design line 1136 names this test explicitly. |
| S2 | **critical** | plan Task 2, `tx1` | The plan never locks the dispatched outbox attempt. `ask-generation.ts:988` uses `lockDispatchedOutboxAttemptIfOwned` for exactly this: a stale attempt N-1 job arriving after attempt N was dispatched. Without it two attempts can both reach the provider. |
| S3 | high | Task 0 test 13 | Test 13 proves the raw token never reaches Postgres. Nothing proves it never reaches a log line. `unsubscribeTokenLogPrefix` exists in `src/lib/solicitation/unsubscribe.ts:293`, which is the house answer — so the omission is a gap, not a non-issue. |
| S4 | high | Task 0 tests 16, 23 | Both call `closeBatchIfSettled`, but no test proves a batch with a MIXED terminal set actually settles. A batch that never settles permanently consumes the account's one-active-batch slot (D8). |
| S5 | medium | Task 0 test 9 | The flag-off defer leaves the row `queued`. The test does not assert the outbox row was COMPLETED. If it is not, the watchdog re-pends it every 15 minutes for 72 hours. |
| S6 | medium | Task 6 Step 4 | D10 excludes `sending` from the halt sweep on purpose. No test pins that contract, so a later "fix" could start cancelling in-flight children and produce the `sent`-but-`cancelled` lie. |

## Proposed additional test titles

Add to `tests_to_add` (this is a `tests_to_add` retitle/extension, recorded as an
owner-approved deviations entry, NOT an `allowed_edit_surface` amendment):

1. `re-dispatch carries the same provider idempotency key so the provider returns the original message`
2. `ignores a stale outbox attempt and does not call the Messaging adapter`
3. `never logs the raw unsubscribe token or the recipient handle`
4. `closes the batch once the last Outreach row terminalizes across a mixed sent, withheld and failed set`
5. `completes the outbox attempt when deferring on a flag-off so the watchdog does not re-pend it`
6. `does not cancel an in-flight sending child when a halt lands after the CAS`

## Plan corrections required

- **Task 2 Step 1** must add `lockDispatchedOutboxAttemptIfOwned` as the FIRST statement
  inside `tx1`, before the batch row lock, mirroring `ask-generation.ts:988`. A non-owned
  attempt logs and returns without touching the Outreach row.
- **Task 4 Step 3** must state that every log line uses `unsubscribeTokenLogPrefix`, never
  the raw token, and never the recipient handle.

## Low-confidence appendix

- Cross-tenant scoping of the `tx1` reads is covered statically by `ci:tenant-scope`; a
  dedicated test would be better but the audit is probably sufficient.
- `provider_message_id` could in principle come back as an empty string; asserting
  non-empty inside test 15 is cheap and worth folding in.

---

## Round record — codex dispatches failed to return

- **Round 1** (session `01a025fa-6716-7853-95fc-86fc7bdf4fe5`): went off-brief and ran
  `scripts/verify-gate.sh` instead of reviewing. Killed at the 10-minute cap. No findings.
- **Round 2** (background task `bp9yrtcpv`): stayed on-brief and read the specs, CONTEXT.md
  and `src/lib/solicitation/` for ~32 minutes, then produced no output for a further
  10 minutes while alive. Killed (exit 144). Output was 4216 lines of file reads and
  **zero analysis**. No findings.

Both rounds are counted in `.feature/state.json` (`planReviewRounds=2`). The findings above
are the orchestrator's own eval-first review and are the only review output this gate has.

### Correction to the round-2 record

The round-2 diagnosis above is WRONG and is kept only as a record. `timeout` is not
installed on this machine (no `timeout`, no `gtimeout`), so the three "wait windows"
used to poll for the verdict returned instantly rather than waiting. The line counts
that looked static were sampled seconds apart, not minutes apart. Codex was probably
still working normally when it was killed. The kill was an orchestrator error, not a
codex stall.

Durable lesson: on this machine, never bound a wait with `timeout` — it silently
becomes a no-op that returns success-looking output. Use the Bash tool's own
`timeout` parameter, or a Monitor with an until-loop.
