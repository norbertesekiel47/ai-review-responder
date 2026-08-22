# Round 3 — final verification (`feat-900-solicitation-release-poller`)

**Scope.** Verification-only, over `git diff a0386f70..HEAD` (commits `c7684913`,
`8e93bf4d`) — round 2's five fixes. Six files changed: `src/lib/solicitation/release.ts`,
`src/lib/solicitation/__tests__/release.integration.test.ts`,
`worker/background/pollers/__tests__/SolicitationReleasePoller.test.ts`,
`scripts/ci/tenant-scope-allowlist.ts`, and the two `#900` planning docs.

**Method.** Read every line of the round-2 diff; read every comment and docstring it
added or changed and checked each claim against the code it describes; traced the
control flow of the two new `try` boundaries by hand; read the SQL against migrations
088 and 091; verified the four cross-file claims (`guarded-poll.ts`, `logger.ts`,
`worker/sentry.ts`, `approval.ts`) at their sources. Did NOT re-run `verify-gate.sh`
or the live-DB suites — relying on the supplied evidence (GREEN at `8e93bf4d`,
28 rows, `diff-coverage` PASS, one owner-decided `reclassify` WARN).

---

## FIX 1 — per-batch isolation — **VERIFIED**

`release.ts:1120` opens a bare `try` around the batch-loop body; `release.ts:1224`
catches and calls `recordItemFailure('release', { account_id, batch_id }, isolated, error)`.

- **Sibling batches survive.** `applyJudgeSplit`, `selectRenderedOutreach` and
  `releaseOutreachRow` are all inside the inner `try`. A throw from any of them is
  recorded and the `for (const batch of accountBatches)` loop advances. Proven by the
  new case at `release.integration.test.ts:1985` — two batches on two locations of one
  account, `enqueueSolicitationSend.mockRejectedValueOnce` poisoning the older approval
  (which P4's `approved_at ASC` reaches first) — asserting `itemFailures: 1`,
  `released: 1`, and the sibling's row `queued` with one job.
- **The per-account unit is intact.** `readAccountDailySendCap`,
  `countAccountDispatchAttemptsToday` and `readAccountSubscriptionStatus`
  (`release.ts:1146–1163`) sit between the outer `try` and the batch loop, so only they
  can reach the outer catch at `release.ts:1233`. The account-granularity `continue`
  arms are unchanged.
- **Loop control unchanged.** Every `break` inside the inner `try` still targets its own
  loop (`break` in a `try` with no `finally` exits without running `catch`). `stopPhase`
  is set before each `break` exactly as before, and the account loop's
  `if (stopPhase) break;` at the top is untouched.
- **The corrected comment at `release.ts:1111` is TRUE for both units.** It names the
  account as the outer unit covering the two gate reads (correct — those are the only
  statements that can reach the outer catch) and the batch as the inner one covering the
  per-batch/per-row work (correct). The "bare `try`s rather than `isolateItem`" reason
  holds: both bodies carry `continue`/`break` that cannot cross a function boundary.

One consequence the fix did not sweep up: an existing test comment now describes the
pre-fix isolation unit — see NEW FINDING 2.

## FIX 2 — the `account_cap` counter — **VERIFIED**

- **Cap-bound ≠ idle.** `release.ts:1081` folds `scan.cappedAccountsWithheld` via
  `withhold(report, 'account_cap', count)`. Two integration cases pin both directions:
  `release.integration.test.ts:1053` (a cap-bound account alongside a releasable one →
  `account_cap: 1`, `released: 1`) and `:1063` (every candidate account capped →
  `released: 0`, `account_cap: 1`, `releasePhaseStoppedBy: null`).
- **Idle cannot be made to look cap-bound.** `withhold` returns early on `count <= 0`
  (`release.ts:1002`), so a zero writes nothing. The control case at `:1078` asserts
  `withheldByReason` deep-equals `{}` on a tick with nothing due.
- **It counts the capped half of `eligible`, not all capped accounts.** The `withheld`
  CTE is `COUNT(DISTINCT account_id)::int FROM eligible WHERE account_capped`, and
  `eligible` carries the full candidate predicate — `approved_at IS NOT NULL`,
  `halted_at IS NULL`, `send_closed_at IS NULL`, `veto_deadline_at IS NOT NULL AND
  NOW() >= …`, the 72h `approved_at` arm, and the `EXISTS` over a `rendered` Outreach
  row. An account at its cap with nothing releasable is not in `eligible` and does not
  register. The docstring at `release.ts:1300` says exactly this and is accurate.
- **The rewrite is semantically equivalent for the candidate set.** The old
  `NOT EXISTS (SELECT 1 FROM capped_accounts …)` became `EXISTS(…) AS account_capped` in
  `eligible` plus `WHERE NOT account_capped` in `candidates`; `EXISTS` is never NULL, so
  the two are identical. Ordering (`approved_at ASC`) and `LIMIT ${scanLimit}` still
  apply to the un-capped set only.
- **The aggregate always arrives.** An aggregate with no `GROUP BY` returns exactly one
  row (0 when the input is empty), and `LEFT JOIN candidates c ON TRUE` preserves it, so
  `rows[0].capped_accounts_withheld` is always present. The outer `ORDER BY
  c.approved_at ASC` is legal against a column not in the select list.
- **The tenant-scope allowlist moved with the SQL** (`scripts/ci/tenant-scope-allowlist.ts:403`)
  and the reason string gained a paragraph for the new CTE shape — no new table, no new
  scope, projects a single count.

The row-shape comment immediately below the query overstates one fact — see
NEW FINDING 1.

## FIX 3 — `alertPhaseFailure` — **VERIFIED**

- **Control flow genuinely unchanged.** `alertPhaseFailure` (`release.ts:1090` region,
  defined at `release.ts:283`) returns `await body()` on success and `throw error` — the
  original error object, not a wrapper — on failure. The three `tallyPhase(report, await
  …)` call sites pass the same value in the same order; the P4 and P5 sites are a plain
  `await`. Nothing is conditional, nothing is reordered.
- **The Send breaker's throw still halts.** `readSendBreaker` is called at
  `release.ts:1031`, inside `runReleasePhase` but outside every `try` in that function.
  Its throw leaves `runReleasePhase`, passes through `alertPhaseFailure('release', …)`
  which alerts and rethrows, aborts `runReleaseCycle`, and P5 is skipped — identical to
  before. It is never caught-and-continued: the new inner batch `try` starts ~90 lines
  later. The new case at `release.integration.test.ts:1865` asserts both halves —
  `await expect(cycle()).rejects.toThrow(...)` AND the `phase: 'release'` tag.
- **A Sentry failure cannot poison the path.** `Sentry.captureException` is inside its
  own `try {} catch {}`; the `logger.error` fallback sink is outside it, matching
  `recordItemFailure` and `alertUnknownTerminalization`.
- **Its docstring is TRUE, and so is the rewritten `isolateItem` docstring it leans on.**
  All four cross-file claims check out at source:
  - `createGuardedPoll.runOnce` catches with `logger.error(...)` and never rethrows
    (`worker/background/guarded-poll.ts:98–113`); `start()`'s `.catch(logUnhandledPollError)`
    is on a promise that cannot reject. So a cycle throw is never an `unhandledRejection`
    and `worker/index.ts`'s classifier never sees it. ✅
  - `src/lib/shared/logger.ts` contains no reference to Sentry (grep: zero hits), and
    `logUnhandledPollError` is a plain `createWorkerLogger(...).error`. ✅
  - `worker/sentry.ts`'s `Sentry.init` declares only `beforeSend` — no
    `captureConsoleIntegration`, which is opt-in in `@sentry/node`. So `logger.error`
    genuinely reaches no Sentry sink. ✅
  - `runReleaseCycle` has exactly one production caller,
    `worker/background/pollers/SolicitationReleasePoller.ts:57`, so "createGuardedPoll
    catches everything `runReleaseCycle` throws" is unqualifiedly true. ✅

## FIX 4 — the `downgradeApproval` CAS — **VERIFIED**

- **The decision now happens against the locked row.** `built_at > NOW() -
  make_interval(days => ${BATCH_APPROVAL_WINDOW_DAYS})` is arm five of the `UPDATE`'s
  `WHERE` (`release.ts:1543`), which runs after `SELECT … FOR UPDATE OF b` inside
  `sql.begin`. It is spelled in SQL, so the database clock decides it — the same shape as
  the send-window arm in `releaseOutreachRow`. The scan-time `approval_window_open` is
  now only the cheap pre-check that avoids taking a lock (`applyJudgeSplit:1444`), which
  is what the added docstring at `release.ts:1433` says.
- **The round-1 chain is closed.** Verified end to end:
  `deriveBatchState` returns `'expired'` past `built_at + 7d`
  (`src/lib/solicitation/outreach.ts:114`, `:299`); `approveBatch` refuses any state
  other than `'built'` under the lock (`src/lib/solicitation/approval.ts:281–287`, D2);
  `selectExpiredBatches` requires `approved_at IS NULL AND built_at <= NOW() - 7 days`
  (`release.ts:918–922`), which a downgraded-past-window batch would satisfy on the very
  next tick. With the CAS arm, a downgrade can only commit while the window is open, so
  P3 cannot select the batch that tick and the batch is genuinely re-approvable.
- **No NULL hazard.** `built_at` is nullable in 088, but 091's
  `solicitation_batches_send_ordering` CHECK enforces `approved_at IS NULL OR built_at
  IS NOT NULL`, and the CAS also requires `approved_at IS NOT NULL` — so the new arm can
  never silently three-value a legitimate row into no-match.
- **The `skipped` outcome is unchanged in kind.** A CAS miss still returns `undefined` →
  `'skipped'`, incrementing neither `downgraded` nor `heldForJudge`. The new case at
  `release.integration.test.ts:2061` proves the arm fires: it asserts `downgraded: 0`
  **and** `heldForJudge: 0` (so the scan saw the window open and the CAS is what refused)
  plus all four approval columns intact and no `approval_downgraded` step.
- The `JudgeSplitOutcome` comment rewritten alongside it is directionally right; its
  enumeration is slightly narrow — see Appendix A2, not a finding.

## FIX 5 — cheap corrections — **VERIFIED**

- **Orphaned `.fails` back-reference removed** (`SolicitationReleasePoller.test.ts:14–17`),
  along with the stale "task 0, the eval task" tag. A repo grep for `.fails` leaves only
  historical narrative in the handoff/deviations docs and unrelated plans — no source
  file makes a live back-reference.
- **The five widened seed helpers do not change any existing fixture's tenant.**
  `SeedIds` defaults to `primaryIds()` = `{ accountId: accountId(), userId: userId() }`,
  which is byte-for-byte what the helpers previously closed over. `SeededBatch` now
  carries its own `accountId`/`userId`, and `seedSendParent`, `seedAsk` and
  `seedOutreach` read them off the batch — for every pre-existing call site the batch was
  seeded with `primaryIds()`, so the value is identical. The only non-primary caller is
  `seedCappedForeignCandidate`, which is the fixture that previously hand-inlined the
  five helpers; its rewrite reproduces the old inline SQL exactly (`created_at NOW() -
  40 days`, `built_at 5h`, `approved_at 4h`, `owner`, `veto 3h`, `sending_started_at 3h`,
  a `running` send parent at 4h, CAP `queued` rows plus one trailing `rendered`).
  One behavioural detail checked because it would have been silent: the trailing
  `rendered` row is passed `queuedAgo: '0 seconds'`, but `seedOutreach` writes `queued_at`
  only for dispatched statuses (`release.integration.test.ts:445`, `:460`), so the
  account still has **exactly** `DEFAULT_DAILY_SEND_CAP_ACCOUNT` rows counted by the cap —
  the fixture comment's "at it exactly" stays true.
- **Deviations entry added** (`…-deviations.md`, "Round 2 fixes" section) — records the
  `user_visible_behavior` bullet-7 deviation, why the code is right and the bullet wrong,
  and the five additive test titles.
- **Both intake copies are byte-identical.** `cmp .feature/intake.json
  docs/superpowers/plans/feat-900-solicitation-release-poller-intake.json` → identical;
  md5 `0369641f5ed2849394b420c6f80abe2c` for both. (`.feature/` is gitignored, which is
  why only one copy appears in the diff.) Bullets 7 and 8 now describe the shipped
  hold/downgrade split including the CAS re-assertion; bullet 6 is untouched.
- **The 39 promised `tests_to_add` titles are all still present** — scripted check
  against every `*.test.ts` under `src/` and `worker/`: 39 in the intake, 0 missing.

---

## NEW FINDINGS

Both are false/stale rationale. Neither changes behaviour today; both are one-line
comment edits.

### FINDING 1 — `release.ts:1337` — a FALSE nullability claim, and it contradicts the code three lines below it (**this is the fifth**)

> `// The `LEFT JOIN` guarantees at least one row; a row with a NULL `id` is the`
> `// aggregate alone, not a batch. Every candidate column is NOT NULL in 091 or`
> `// computed non-null here, so one null id identifies that row completely.`

`sending_started_at` is a candidate column — it is selected into `eligible`, projected
by the outer `SELECT`, typed `Date | null` on both `ReleaseCandidateRow` and
`ReleaseCandidateBatch`, and it is declared **nullable** by migration 091
(`091_send_mode_spine_lifecycle.sql:103`, `ADD COLUMN IF NOT EXISTS sending_started_at
TIMESTAMPTZ`). It is NULL for every batch that has not begun dripping — i.e. for every
first-release candidate, which is the common case. Secondarily, the three columns that
*are* `NOT NULL` (`id`, `account_id`, `business_id`) are declared in **088**
(`088_solicitation_batch_executor.sql:119–121`), not 091.

The operative conclusion — "one null id identifies that row completely" — is true, and
the guard loop is correct: it deliberately tests `id`, `account_id`, `business_id` and
`approval_window_open` and deliberately omits `sending_started_at`. The comment asserts
the opposite of the reason that omission is correct.

Failure scenario: a maintainer tightening the guard to match the comment's stated
invariant — adding `if (row.sending_started_at === null) continue;` — would discard every
batch that has not yet started sending, i.e. every candidate on its first release, and
P4 would silently release nothing while `releasePhaseStoppedBy` stayed `null`. That is
the exact "reads like an idle tick" failure mode FIX 2 was written to remove.

Suggested correction: say what is actually load-bearing — `id` is the table's `NOT NULL`
primary key (088), so a NULL `id` can only be the aggregate-only row; `sending_started_at`
is legitimately nullable and is therefore not part of the discriminator.

### FINDING 2 — `release.integration.test.ts:1901` — FIX 1 falsified an existing comment about the isolation unit

> `// The cycle no longer PROPAGATES a per-item throw — it isolates it to`
> `// the account and reports it (round-1 error-isolation finding). What`
> `// this case is about is unchanged and is asserted below: the`
> `// transaction rolled back as one unit.`

The mocked failure is `enqueueSolicitationSend` rejecting inside `releaseOutreachRow`,
which is now caught by the **batch**-level catch added at `release.ts:1224`, not the
account-level one. After FIX 1 the blast radius of that throw is one batch, not one
account. The comment describes the pre-fix behaviour.

This is stale rather than dangerous, but it is the same failure mode as FINDING 1 and it
sits ~80 lines above the new case (`:1985`) whose entire point is that the release
phase's isolation unit is the batch, and directly contradicts the corrected comment at
`release.ts:1111`. A reader gets two incompatible answers to "what does a failing release
cost?" from the same test file.

Suggested correction: "…it isolates it to the batch and reports it".

### On the pattern

The orchestrator asked to be told plainly if a fifth false rationale turned up. It did —
FINDING 1 is a comment round 2 *wrote*, FINDING 2 is a comment round 2 *falsified*. That
is five and six on this branch, and the shape has not changed: confident, specific,
plausible, wrong, and invisible to typecheck, tests and the gate. Both of the new ones
are about *which unit* or *which column* a mechanism applies to — the same axis as the
`latchSystemHalt` lock claim and the `isolateItem` Sentry-sink claim. The four verified
cross-file claims in FIX 3's docstrings (`guarded-poll`, `logger`, `sentry.ts`,
`approval.ts`) were all correct, which suggests the failure concentrates in claims about
*this module's own* internal structure rather than in claims about other files. If
anything on this branch deserves a standing rule, it is that a comment asserting a
nullability, a lock, an isolation boundary, or an exhaustive enumeration inside
`release.ts` gets checked against the line it describes before it ships.

---

## APPENDIX — untriaged, out of scope, NOT findings

Observations against code the round-2 diff touched, deliberately kept out of the findings
table: each is either a consequence the fix's own author appears to have chosen, or below
the confidence bar, or a pre-existing property this diff merely widened. Recorded for the
owner; none is a request for a change in this round.

**A1 — `eligible` is a multiply-referenced CTE, so P4 no longer stops at `scanLimit`.**
`eligible` is referenced by both `candidates` and `withheld`, which makes Postgres
materialize it (default since PG12), so the full eligible set is computed every tick and
`LIMIT ${scanLimit}` now bounds only the rows *acted on*, not the rows *examined*.
`RELEASE_SCAN_LIMIT`'s own doc ("Rows scanned per phase per tick. Bounds the tick") is
looser than it was for P4. Immaterial at beta volumes — the eligible set is bounded by
live approved batches, and 091 admits one active send per business — but it is the kind
of thing PgBouncer's ~8s `statement_timeout` finds first at scale. The docstring's
alternative (a second statement) was rejected for a stated reason (a second spelling of
the candidate predicate) that I agree with.

**A2 — `JudgeSplitOutcome`'s "Two writers reach it" under-counts.** The CAS has five arms;
besides a Halt latch and the window shutting, a detached overlapping cycle (which this
module's own header at `release.ts:44` says is possible — the 45s `guarded-poll` deadline
frees the flag while the cycle keeps running) can defeat `approved_at IS NOT NULL` or
`sending_started_at IS NULL`, and a concurrent `closeBatchIfSettled` can set
`send_closed_at`. The comment's *consequence* claim — "both are one-tick states: the next
tick re-scans and reports the honest outcome (`held`, or no candidate at all)" — holds for
the unnamed writers too, which is why this is not a finding.

**A3 — `withheldByReason.account_cap` mixes granularities.** The new scan-level fold
counts *accounts*; the in-loop `continue` arm counts *accounts*; the two `break` arms
count *batches*/*rows*. The mixing predates round 2 (the in-loop arms already mixed
account and batch granularity), and the counter's stated job is "which dial", not "how
many of what". Worth one sentence in the field's doc if anyone ever charts it.

**A4 — per-outreach-row isolation is still absent.** A single deterministically-failing
Outreach row costs its whole batch every tick, because `selectRenderedOutreach` is
`ORDER BY rendered_at ASC` and re-selects it first. Blast radius is bounded (≤ one batch,
≤ 72h, then the batch terminalizes with a reason) and every attempt is counted and
alerted, so this is a narrower version of the wedge class, not a live instance of it.
FIX 1's comment does not claim row-level isolation, so nothing is misdescribed. It reads
as a deliberate stopping point.

**A5 — `judgeAvailable()` memoizes only on success, so a throwing probe is now re-run per
batch.** `judgeAvailability` stays `undefined` when `isJudgeHealthy` throws, and the probe
now sits inside the per-batch `try`, so a throwing probe is attempted once per batch
instead of once per account. Each attempt is isolated and counted; the "read ONCE per
tick" comment is about the *answer*, which is still memoized once obtained. No
correctness consequence found.

**A6 — FIX 4's residual boundary.** The CAS makes a downgrade legal only while the window
is open *under the lock*, but a batch inside the window by seconds is still downgraded and
then expires shortly after. This is the inherent residue of any time-boundary gate rather
than the round-1 defect (which was an unbounded scan-time snapshot), and closing it would
require a margin nobody has specified. Noted only so the owner knows the shape of what
remains.

---

# ROUND 3 TRIAGE (orchestrator, 2026-08-22) — the cap is reached

All five round-2 fixes verified YES. Two new findings, **both accepted and both
fixed by the orchestrator directly**, because each is a one-line comment-truth
defect whose underlying fact was verified against source rather than taken on
the agent's word:

- **F1 `release.ts:1337` — ACCEPTED, FIXED.** Verified independently: migration 091 declares `sending_started_at TIMESTAMPTZ` with no `NOT NULL` (`091_send_mode_spine_lifecycle.sql:103`), and it IS a projected candidate column. The comment claimed every candidate column is non-null; the guard three lines below correctly omits it. The code was right and the comment was wrong, which is the dangerous direction: a maintainer tightening the guard to match the stated invariant would drop every not-yet-sending candidate — i.e. every first-release candidate — and the phase would report `released: 0` with `releasePhaseStoppedBy: null`, the idle-looking tick that FIX 2 exists to remove. The replacement states why the column is excluded and names the failure mode.
- **F2 `release.integration.test.ts:1901` — ACCEPTED, FIXED.** Verified: the comment said the throw "isolates it to the account" while the corrected production comment at `release.ts:1108` says the account unit covers exactly the two gate reads. After FIX 1 the rejection is caught at the batch level. The file held two incompatible answers to "what does a failing release cost?". Corrected, and it now records that "the account" was true only between rounds 1 and 2.

**No round 4.** The workflow caps branch review at three rounds and the counter
reads 3. These two fixes therefore ship WITHOUT a review round to verify them,
and that is stated plainly rather than glossed: both are comment-only, neither
changes behaviour, and both underlying facts were checked at source by the
orchestrator (091's column definition; the two isolation `try` blocks).

## THE PATTERN, AND IT IS THE MOST USEFUL THING THIS BRANCH PRODUCED

**Six times on this branch a load-bearing rationale written in a comment was
FALSE** — the `latchSystemHalt` lock claim, both cycle-overlap claims, the
`isolateItem` Sentry-sink claim, and now F1 and F2. Every one was confident,
plausible, and wrong. **None was catchable by tests, typecheck, `diff-coverage`
or a 28-row gate, because comments do not execute.** Three review rounds caught
all six only because agents were told to read each justification against the
code it describes.

Round 3's diagnosis sharpens it further, and it is the actionable half: the four
CROSS-FILE claims round 2 wrote — about `guarded-poll.ts`, `logger.ts`,
`sentry.ts` and `approval.ts` — were all **correct**. Every falsity, all six,
was a claim about **this module's own internal structure**: which isolation
unit, which column, which boundary. Outbound references get checked because
checking them means opening another file; self-description does not, because the
author believes they already know.

**Promotion obligation:** this belongs in `.claude/reference/lab-notes.md`
beside the three entries this branch already promoted, as a rule for the next
feature of this class — *a comment asserting a property of the module you are
writing is the least-checked artifact in the change; review it against the code
the way you would review a diff.*
