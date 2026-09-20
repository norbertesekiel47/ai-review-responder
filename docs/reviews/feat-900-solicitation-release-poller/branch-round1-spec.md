# Branch review — round 1, agent 1: **Spec & correctness**

- Branch: `feat-900-solicitation-release-poller` · issue #900 · RISK = high
- Fork point: `53bb0fcf` · diff reviewed: `git diff 53bb0fcf..HEAD` (28 files, +6635/−24)
- Contract of record: `.feature/intake.json` (checked field by field, not from memory)
- Live-DB suites were **not executed** (two sibling reviewers share the machine and the
  test DB). Read-only audits were run: `ci:tenant-scope`, `ci:outbox-seam`,
  `ci:outbox-status`, `ci:directory-map` — all green.

---

## Findings

| severity | file:line | finding |
|---|---|---|
| Medium | `src/lib/solicitation/release.ts:947` (+ the `continue` at `:865`) | The release-candidate scan is global, `LIMIT scanLimit`, `ORDER BY approved_at ASC`, and a cap-exhausted account's batches are `continue`d **without leaving the candidate set** — so once ≥`scanLimit` (50) candidate batches belong to accounts at their daily cap, no other account releases anything until those batches age out of the 72h send window and are cancelled. Contradicts the intake edge case "no row is skipped permanently". |
| Low | `.claude/reference/env-vars.md:111` | The `SOLICITATION_PLATFORM_DAILY_CAP` row still reads "**#900 is the consumer that acts on it**; until #900 lands nothing on a send path reads either." This branch **is** #900 and `runReleasePhase` reads it (`release.ts:801`). `env-vars.md` is on `allowed_edit_surface` and was edited for the sibling interval var in the same commit. |

### Finding 1 — cap-exhausted accounts occupy the release scan window

**Where.** `selectReleaseCandidates` (`src/lib/solicitation/release.ts:947-970`) runs once per
tick, before any per-account filtering:

```
WHERE approved_at IS NOT NULL AND halted_at IS NULL AND send_closed_at IS NULL
  AND veto_deadline_at IS NOT NULL AND NOW() >= veto_deadline_at
  AND approved_at > NOW() - 72h AND EXISTS (… delivery_status = 'rendered')
ORDER BY approved_at ASC
LIMIT ${scanLimit}          -- 50
```

`runReleasePhase` then groups by account and, for an account whose daily cap is spent,
does `withhold(report, 'account_cap'); continue;` (`:864-866`). Nothing removes that
account's batches from the next tick's scan.

**Concrete failure.** Account A owns 11+ locations, each with one approved, dripping batch
(migration 091 admits one live send batch per business, so 11 locations = 11 candidate
batches; the daily send cap is per **account**, 10). By ~09:05 UTC A has spent its cap and
every one of its batches is refused for the rest of the day — but all 11 stay in the
candidate set, and their `approved_at` values only get older relative to later approvals.
Five such accounts (or one account with 51+ locations) put ≥50 such batches at the head of
`ORDER BY approved_at ASC`. From that point every tick selects the same 50, `continue`s all
of them on `account_cap`, and releases **zero** rows for every other account on the
platform — for up to 72 hours, at which point P2 halts those batches
`send_window_elapsed` and cancels their rows.

**Why it is a contract violation, not just a perf note.** The intake edge case reads: *"A
tick that hits the per-tick release budget leaves the remaining due rows for the next tick;
no row is skipped permanently."* Under this scenario rows outside the window are skipped
until they are cancelled — permanently, in the only sense that matters to an owner.

**Confidence.** ≥80% that the code behaves this way (the scan is unconditionally global and
the account filter is applied after it, per tick). The *likelihood* of the trigger at beta
scale is low, and the feature is inert until `SOLICITATION_SEND_ENABLED` flips — hence
Medium, not High.

**Shapes of a fix** (not prescribing one): exclude cap-exhausted accounts in SQL; or scan
per-account with a rotating cursor; or overfetch and skip. All three are more than a
one-liner, which is why this is reported rather than nitpicked.

### Finding 2 — stale `SOLICITATION_PLATFORM_DAILY_CAP` registry row

The row asserts a fact this branch falsifies. `src/lib/config/worker.ts:130` adds the var to
the **worker** schema precisely so `runReleasePhase` can read it, and the deviations file
records that decision (`Task 0 — SOLICITATION_PLATFORM_DAILY_CAP lives in the SERVER config`).
The neighbouring `SOLICITATION_RELEASE_POLL_INTERVAL_MS` row was written in the same commit,
so the omission is an oversight rather than a scoping decision. No audit catches it —
`ci:config-coverage` never reads `env-vars.md` (recorded as a deviation at Task 8), so the
green gate is not evidence here.

---

## What was checked, and what passed

### `allowed_edit_surface` — clean

Every changed path maps to an entry. Enumerated:

| Path | Surface entry |
|---|---|
| `worker/background/pollers/SolicitationReleasePoller.ts` | exact |
| `worker/background/pollers/__tests__/SolicitationReleasePoller.test.ts` | `__tests__/**` |
| `worker/index.ts` | exact |
| `src/lib/solicitation/release.ts` · `approval.ts` · `outreach.ts` | exact |
| `src/lib/solicitation/__tests__/{release,release.integration,approval,approval-system-halt.integration}.test.ts` | `__tests__/**` |
| `src/lib/shared/job-outbox-helpers.ts` + its `__tests__` | exact / `__tests__/**` |
| `src/lib/config/worker.ts` · `src/lib/agents/run-spine.ts` | exact |
| `scripts/ci/tenant-scope-allowlist.ts` | exact (AMENDMENT 2) |
| `src/lib/approval/__tests__/outcome-anchor-pairing.test.ts` | exact (AMENDMENT 3) |
| `.claude/reference/lab-notes.md` | exact (AMENDMENT 4) |
| `.claude/reference/env-vars.md` · `CONTEXT.md` · `docs/directory.md` · `docs/audits/…backlog.md` · `docs/superpowers/plans/**` · `docs/reviews/**` | exact |

`src/lib/solicitation/send-caps.ts` is on the surface and was **not** touched — permission,
not obligation; correct, since its two counters and two resolvers were already right.

**No file outside the surface was changed. No hard finding here.**

### `tests_to_add` — all 39 present verbatim, and each tests what it names

Machine-checked verbatim (script diffed each title against the four touched test files);
all 39 matched. I then read every body. Notes on the ones that could have been vacuous:

- **`evaluates the governors in the fixed order …`** — genuinely pins the order rather than
  the gates. Four rounds, each seeding a state where *every remaining* gate would fire, and
  round 3 asserts `withheldByReason.subscription` is **`undefined`** while `account_cap` is
  set (and round 4 the mirror). Because the account cap `continue`s before the subscription
  read is even issued, that pair of assertions is exactly the discriminator B6's closing
  paragraph needs. Best test on the branch.
- **`releases no more than the remaining platform capacity in one tick`** — headroom 1,
  budget 2, three candidates → 1 released, 2 left `rendered`. Reds if the ceiling is checked
  once at the top of the phase instead of decremented per release. Non-vacuous.
- **`stamps sending_started_at on the first release only`** — two ticks at budget 1 and a
  `getTime()` identity assertion; reds without the `sending_started_at IS NULL` CAS.
- **`does not terminalize a sending row whose outbox row is re-pended after selection`** —
  the `precedingExecutor` proxy injects the watchdog's re-pend at the top of the sweep's own
  transaction, which is the only way to reach the between-scan-and-CAS window. Deviations
  record it as the CAS belt's sole pin; I agree, and the probe result quoted there
  (deleting the outer belt leaves it green) is consistent with the code.
- **`does not latch batch_expired on a batch with no Send batch parent`** — re-verified
  non-vacuous by Task 5 (deleting P3's `EXISTS` reds only this case). The seeded batch has
  no `agent_runs` row at all, so the assertion is real.
- **`rolls back rendered-to-queued when enqueueSolicitationSend throws`** and
  **`rolls back unknown Outreach terminalization when lazy-child completion fails`** —
  both prove one-transaction atomicity by forced failure through a delegating spy, not by
  inspection. The first also asserts `sending_started_at` disappears with the CAS, which is
  the strongest available evidence the three writes are one unit.
- **`property: the account daily send cap is never exceeded …`** — the non-vacuity
  assertion (`released === min(candidates, remaining, perTickBudget * ticks)`) is what stops
  a mis-routed fake executor from passing trivially. The fake's route order was checked
  against every statement the release phase issues; P1/P2/P3/P5 correctly fall through to
  `[]`.
- **`property: the Halt latch is monotone under arbitrary halt orderings`** — crosses actor
  classes (owner / admin / both system reasons), which is the only way to reach
  `latchHalt`'s `halted_at IS NULL` CAS at all, given #895(b). Asserts first-writer-wins on
  `halt_reason`, actor presence following the reason (091's CHECK), exactly one
  `batch_halted` step, and audit rows ≤ 1 and exactly 1 only for the admin arm.

Weakest of the 39: **`a batch that receives no approval for 7 days closes cleanly and
raises no stalled alert`**. It proxies "no stalled alert" as `ended_at − started_at <
STALLED_THRESHOLD_SEND_BATCH_DAYS`, and never calls `deriveRunDisplayState`. It is still
sensitive to the anchor (an 11-day sweep would red the `batchExpired === 1` assertion
first), so I did not raise it — noted in the appendix.

### `edge_cases` — all 13 handled; here is where

| Edge case | Where |
|---|---|
| duplicate release inserts no second outbox row | `enqueueSolicitationSend` `ON CONFLICT (topic, aggregate_id) WHERE …` (`job-outbox-helpers.ts:733-748`) — verified **byte-for-byte** against migration 091:541-544 |
| flag OFF mid-drip: sweeps + backstop keep running | flag read at exactly one site, inside `runReleasePhase` (`release.ts:766`); phases 1/2/3/5 sit outside it |
| breaker open for days: expiry keeps running under it | breaker read is inside `runReleasePhase` only |
| subscription lapses mid-drip: rows stay `rendered` | per-account `continue` (`:868-872`), no write |
| batch with no Send batch parent | `latchHalt` skips the step (`approval.ts:576`) and still joins (`:590`) |
| `batch_expired` sweep skips watch-mode batches | P3's `EXISTS` over `agent_runs` (`release.ts:721-728`) |
| in-flight outbox row ⇒ not swept | both belts: `selectWedgedSendingOutreach` and the CAS |
| `unknown` counts as possibly contacted for `over_contacted` | true by construction — `restraint-policy.ts:405` keys off `solicitation_asks.status='send'` (`batch-builder.ts:501-513`), which an `unknown` row's ask still carries. See appendix A3 for a caveat about the *stated reason* |
| Judge downgrade legal only pre-first-release | `applyJudgeSplit` branch on `sending_started_at` + 091's `send_ordering` CHECK + the CAS's `sending_started_at IS NULL` arm |
| per-tick budget leaves the remainder | budget decremented per release; see Finding 1 for the one case where the remainder does *not* come back |
| cap counts `queued_at` in the UTC day | `send-caps.ts:66-77`, unchanged |
| trailing `AT TIME ZONE 'UTC'` kept | `send-caps.ts:74`, `:90` — unchanged by this branch |
| concurrent owner halt during a release tick | `releaseOutreachRow`'s locked re-read (`release.ts:1167-1177`) + the `does not clear approval when a concurrent Halt latch wins the batch lock` case |

### `invariants` — all 16 upheld

Checked against code, not comments:

1. **#2, CAS + outbox in ONE tx** — `releaseOutreachRow` is a single `sql.begin` containing
   the batch lock, the `rendered→queued` CAS, the `sending_started_at` stamp and
   `enqueueSolicitationSend`. Proved by the forced-failure test, not by shape.
2. **#2, in-flight status set re-spelled by hand, members AND order** — three sites
   (`selectWedgedSendingOutreach`, `terminalizeWedgedOutreach`'s CAS, the helper's
   `ON CONFLICT`). `ci:outbox-status` green (1126 TS + 110 migration files).
3. **#2, no raw INSERT for `solicitation_send`** — `ci:outbox-seam` green, 16 helper-owned
   topics. The only raw INSERTs for the topic are in test fixtures.
4. **Both guards** — the CAS **and** 091's partial unique index. The index predicate and
   the helper's `ON CONFLICT … WHERE` were diffed character by character; identical.
   The integration test additionally probes the DB constraint directly in a savepoint and
   asserts `23505`.
5. **#8, scoped reads/writes** — every *write* spells `account_id` AND `business_id` in a
   top-level `WHERE`. The five *scans* are cross-account and are the standing-sign-off
   exemptions; `ci:tenant-scope` is green at 390/390 with exactly 7 new entries
   (P4×2, P2×1, P3×2, P1×1, P5×1). **Note:** the intake's invariant text says
   "`countPlatformDispatchAttemptsToday` is the one allowlisted cross-account read", which
   the implementation exceeds — but that is the recorded, owner-signed STANDING SIGN-OFF,
   not a silent widening. No new category, no new file, no other registry.
6. **#11, `subscriptionGrantsFullAccess`** — used; no `=== 'active'` anywhere in
   `release.ts`. `readAccountSubscriptionStatus` returns `string | undefined` and the
   predicate returns `false` for `undefined` — fails closed on a missing account row.
7. **#15, injected client** — `release.ts` imports no `@/lib/db/server`; the poller is the
   composition root and is registered in `worker/index.ts:732` (start) and `:845` (stop).
8. **Governor order** — flag → breaker → platform ceiling → (per-tick budget) → account cap
   → subscription → Judge. Matches B6's closing paragraph, with the Judge last for the
   stated destructive-downgrade reason. Pinned by the order test.
9. **`readSendBreaker` fails closed, no try/catch** — grepped: the call at `release.ts:797`
   is bare, and the throw propagates out of `runReleaseCycle`. Pinned by
   `propagates a Send breaker read failure …`.
10. **Pure reader of the breaker** — `release.ts` imports only `readSendBreaker`; no
    `evaluateSendBreaker`, no `resetSendBreaker`, no write to `solicitation_send_breaker`.
11. **Halt latch monotone** — `latchHalt`'s `AND halted_at IS NULL` CAS, now genuinely
    load-bearing because `latchSystemHalt` skips the human arms' `state === 'halted'` guard.
    Pinned by the property test and by `a second system halt … writes nothing`.
12. **Halt never cancels a `sending` row** — `latchHalt`'s cancel predicate is
    `IN ('rendered','queued')`; pinned directly by `latchSystemHalt never cancels a sending
    Outreach row` (which calls the latch alone, so it is unaffected by the P1 interaction
    recorded in the deviations file).
13. **Halt never terminalizes the parent directly** — `latchHalt` calls
    `closeBatchIfSettled` and nothing else touches `agent_runs.status` for the parent.
14. **Lock order batch → run** — verified in all four transactional bodies:
    `terminalizeWedgedOutreach` (batch `FOR UPDATE OF b` first), `downgradeApproval`
    (batch first, `recordStep` last), `releaseOutreachRow` (batch first, no `agent_runs`
    touch at all), `latchSystemHalt` (`readBatchForAction`'s `FOR UPDATE OF b` first). No
    path takes the send parent's run lock before `closeBatchIfSettled`. The
    `outcome-anchor-pairing` allowlist entry states the same and is now pinned by that
    test's fourth carve-out.
15. **`sending` never re-gated / never re-sent** — P4 selects `rendered` only; the CAS is
    `delivery_status = 'rendered'`; the `unknown` sweep is the only writer in this module
    that touches a `sending` row.
16. **Caps enforced in the releaser only** — grepped: `resolveAccountDailySendCap`,
    `resolvePlatformDailyCap`, `countAccountDispatchAttemptsToday` and
    `countPlatformDispatchAttemptsToday` have exactly one production caller each,
    `release.ts`. The new P2 backlog entry (#17) carries B3's condition.

### `user_visible_behavior` — all 8 delivered

Each traced to code and to at least one test. The two Judge bullets are the ones worth
naming: the downgrade clears all four approval columns together (091's
approval-consistency CHECK requires it, and the panel would otherwise show an unactionable
batch), and I separately confirmed the downgraded batch is genuinely re-approvable —
`deriveBatchState` returns `built`, `approveBatch`'s `state !== 'built'` guard passes, the
send parent still exists so the `no_send_parent` refusal does not fire, and readiness
("non-cancelled") is satisfied by the untouched `rendered` rows.

### Scope creep — none found

Everything in the diff maps to the goal statement or to a named edge case / invariant. The
backstop join is not in `user_visible_behavior` but is in the goal ("backstops the join via
`closeBatchIfSettled`"). `UNKNOWN_GRACE_MINUTES`, `approval_downgraded` in `STEP_PERSONA`,
and the two config vars are all supporting vocabulary for named behaviour. The four surface
amendments are each documented and owner-signed.

### Blast radius — the `actorUserId` question, answered

`LatchHaltInput.actorUserId` widened `string` → `string | null`. `latchHalt` is **private**;
its three callers are `haltBatch` (passes `input.haltedByUserId: string`),
`adminHaltBatch` (passes `input.actorUserId: string`) and the new `latchSystemHalt`
(passes `null`). The two downstream consumers of the value:

- `writeAccountAuditLog(… actorUserId …)` — reached only when `input.audit !== null`, which
  is the admin arm only, which always passes a non-null actor. No existing caller can now
  reach it with `null`.
- `recordStep(… detail: { halted_by: input.actorUserId } …)` — JSONB; `null` is a legal and
  meaningful value there, and the system-halt test asserts `halted_by: null` in the step
  detail.

The DB column `solicitation_batches.halted_by` is nullable and 091's halt-consistency CHECK
*requires* NULL for exactly the two system reasons, so the widened type expresses a rule the
database already enforced. **No existing caller relied on non-null.** Verdict: safe.

`STEP_PERSONA` gained one key (`approval_downgraded`) — purely additive to a
`satisfies Record<string, AttributedAgentPersona>` object; the 55 importers read
`AgentStepKey` and `personaForStep`, both of which widen monotonically. `outreach.ts` gained
two exported constants and no behaviour. Nothing in the 17/18/42/55/98/100-importer sets
changes semantically.

---

## Low-confidence appendix

Observations I would **not** stake 80% on, or that are style/perf and belong to another
reviewer, recorded so they are not rediscovered:

**A1 — the locked re-read in `releaseOutreachRow` re-asserts 4 of P4's 5 arms, not 5.**
`release.ts:1167-1177` re-checks `approved_at IS NOT NULL`, `halted_at IS NULL`,
`send_closed_at IS NULL` and the 72h window under the lock, but **not**
`NOW() >= veto_deadline_at`. I traced every writer of `veto_deadline_at` (`approveBatch`
and `downgradeApproval`) and could not construct a reachable interleaving: a downgrade
NULLs `approved_at` in the same CAS (which *is* re-asserted), the loop `continue`s past a
downgraded batch in that tick, and a re-approval requires `approved_at IS NULL`. So this is
a defense-in-depth asymmetry rather than a hole. Worth a comment if anyone ever adds a
second writer of `veto_deadline_at`.

**A2 — a narrow ABBA deadlock between the `unknown` sweep and a stale `commitSendTerminal`.**
`commitSendTerminal` (`dispatch.ts:1103`) locks the **outreach row** (its terminal UPDATE)
before the **batch row** (inside `closeBatchIfSettled`); `terminalizeWedgedOutreach` locks
them in the opposite order. Two transactions on the *same* outreach row could deadlock
(40P01), aborting the whole release tick. I could not demonstrate reachability: for the
sweep to select the row, no in-flight outbox row may exist, and a running `commitSendTerminal`
always has one until its own (uncommitted) `markOutboxCompletedIfOwned`. `commitSendTerminal`
itself anticipates the *race* (its `terminalized.count === 0` branch names "#900's D12d
sweep") but that branch presumes a clean loser, not a deadlock. If a session ever sees
40P01 in `[SolicitationRelease]` logs, start here.

**A3 — the `unknown`-vs-`failed` comment's stated reason is not the mechanism.**
`release.ts:428-433` justifies `unknown` on the outreach row by saying the restraint policy's
`over_contacted` check "reads prior sends". It does not: `evaluateAsk` (`restraint-policy.ts:405`)
consults `candidate.priorBatch`, which `batch-builder.ts:501-513` derives from
`solicitation_asks.status = 'send'` and never looks at `delivery_status`. So `failed` and
`unknown` are indistinguishable to `over_contacted` today. The *outcome* the intake asks for
still holds (an `unknown` row counts as possibly contacted), and `unknown` is right for the
other reasons D12d gives (metrics, `review_attributed`) — but the comment names a mechanism
that would not, in fact, red if the value were changed. Cheap to correct; not a behaviour bug.

**A4 — a `batch_expired` batch closes with `disposition: 'halted'`, not `'expired'`.**
`deriveDisposition` (`outreach.ts:294-303`) puts `halted` above `expired`, and the B7 sweep
latches before it joins, so the `send_batch_closed` receipt on an expired batch reads
`halted`. Both map to parent `cancelled`, and `deriveDisposition` is pre-existing and
untouched here, so this is not a defect introduced by this branch — but it does make the
`expired` disposition close to unreachable now that B7 has a writer. Worth a decision
somewhere, not necessarily here.

**A5 — the two Sentry alerts are unasserted.** `observability` requires "A Sentry alert on
every `unknown` terminalization" and "A Sentry warning when a Judge outage downgrades".
Both exist (`alertUnknownTerminalization`, `applyJudgeSplit`), both are best-effort in their
own `try/catch` with a `logger.warn` fallback outside the guard — correct shape. Neither is
pinned by a test, and neither is in `tests_to_add`, so this is not a contract miss. Flagged
only because an alert nobody asserts is an alert that can silently stop firing.

**A6 — `withheldByReason.per_tick_budget` double-counts one exhaustion.** When the budget
runs out inside the outreach loop, the withhold is recorded there, `stopPhase` is set, and
the enclosing batch loop's top-of-loop check records it a second time before breaking
(`release.ts:891-899` / `:911-919`). `logBudgetExhausted` is guarded against the duplicate;
the counter is not. Every test uses `toBeGreaterThanOrEqual`, so nothing catches it.
Cosmetic — it makes one log line's tally larger than the number of rows actually withheld.

**A7 — backstop scan-window analogue of Finding 1, but self-healing.**
`selectOpenSendBatches` is also `LIMIT 50 ORDER BY approved_at ASC`. A settled-but-unclosed
batch beyond position 50 is not closed that tick — but unlike the release scan, batches
ahead of it *do* leave the set as they close, so it is eventually served. Not a finding.

**A8 — a `perTickBudget <= 0` passed via options records a withhold but leaves
`releasePhaseStoppedBy` null** (`release.ts:812-815`), which is the one path where the
observability promise "a tick that releases nothing states WHICH gate stopped it" is not
kept. Not production-reachable — the poller never passes options and
`RELEASE_PER_TICK_BUDGET` is 2.

---

## Verdict on the three things I was told

1. **2.1× line estimate** — confirmed and sized for: I read all 1224 lines of `release.ts`,
   all 183 changed lines of `approval.ts`, and all four test files end to end rather than
   sampling. The overshoot is real prose-and-predicate density, not padding; the four scan
   predicates and their allowlist justifications account for most of it.
2. **The unpinned outer `NOT EXISTS` in P1** — accepted, and I agree with the record: it is
   a bounding arm, the CAS belt is the correctness guard, and the CAS belt *is* pinned by
   `does not terminalize a sending row whose outbox row is re-pended after selection`. The
   comment at the site states the starvation mechanism and admits the backlog has not been
   shown reachable. Nothing to add.
3. **Four surface amendments on a budget of two** — each is documented, each is
   owner-signed, and each is a *governance registry* the intake failed to declare rather
   than new product scope. The root-cause note (the four-registry table) is the right
   artifact and it did land in `lab-notes.md`, which is what AMENDMENT 4 bought.

---

# TRIAGE — round 1, 2026-08-22 (orchestrator)

The most thorough traceability pass of the three: 39/39 test titles verified
verbatim AND checked that each tests what its title claims, 13 edge cases, 16
invariants and 8 user-visible behaviours traced to code, no surface violation, no
scope creep, and the `actorUserId` blast-radius question answered rather than
deferred.

- **Medium P4 starvation — ACCEPTED, FIX.** Independently found by the adversarial agent, which is what raised confidence enough to action it. This report's framing is the one that decides it: the behaviour contradicts the locked edge case "no row is skipped permanently". The concrete trigger given here (one account with 51+ locations, or five accounts with 11+ each) is what makes it reachable rather than theoretical.
- **Low stale `SOLICITATION_PLATFORM_DAILY_CAP` row — ACCEPTED, FIX.** `env-vars.md:111` still says nothing on a send path reads it. `release.ts:801` reads it. The file was edited in this very branch for the sibling interval var, so the stale row was in front of us.

**One disagreement with this report, recorded rather than resolved silently.**
It reports all 8 `user_visible_behavior` bullets traced to code. The adversarial
agent found that bullet 7 ("the batch reappears as approvable in the Requests
panel") is violated when a Judge downgrade lands on a batch whose `built_at` has
passed the 7-day approval window: it does not reappear as approvable, it is
cancelled by P3. The orchestrator verified the mechanism from source and sided
with the adversarial agent. The gap is narrow — it needs release blocked long
enough for `built_at` to cross 7 days before the first release — which is
probably why a field-by-field trace passed it.

---

# ROUND 2 VERIFICATION

- Axis: **Spec & correctness** · verification-only · fix commits `cabeff32`, `1bd27676`
- Diff reviewed: `git diff a23d8afd..HEAD` (10 files)
- Executed: `pnpm typecheck` (clean), `pnpm ci:tenant-scope` (PASS, 390 entries = baseline).
  Live-DB suites deliberately NOT run — two sibling reviewers share the machine and the
  test DB. Gate evidence relied on: `verify-gate.sh --review` GREEN at `1bd27676`.

## Verification table

| finding | fixed? | evidence |
|---|---|---|
| **1 — P4 starvation** (`capped_accounts` fairness arm) | **PARTIAL** | The arm works and the safety argument is sound (below), but it is keyed on the CONSTANT `DEFAULT_DAILY_SEND_CAP_ACCOUNT`, not on the account's resolved cap — so an account whose `daily_send_cap` is configured **below** 10 is at its cap while its count is `< 10`, is NOT excluded, and still holds `ORDER BY approved_at ASC LIMIT` slots for its whole 72h window. Same starvation shape, lower threshold. |
| **1a — "the arm cannot over-exclude"** | **YES, verified** | `resolveAccountDailySendCap` (`src/lib/solicitation/send-caps.ts:23-27`) is `configured === null ? 10 : Math.min(configured, 10)`, so a resolved cap is **never above** `DEFAULT_DAILY_SEND_CAP_ACCOUNT = 10` (`send-caps.ts:16`). The CTE (`src/lib/solicitation/release.ts:1134-1141`) excludes accounts with `COUNT(*) >= 10` on `queued_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'` — **character-identical** to the predicate in `countAccountDispatchAttemptsToday` (`send-caps.ts:70-77`). Therefore every excluded account has `accountRemaining = cap − count ≤ 10 − 10 = 0` and would have been `continue`d by the TypeScript gate (`release.ts:1005-1013`) anyway. Over-exclusion is impossible; under-exclusion is the only direction. Drift within a tick can only ADD rows to the TS count, which is the same safe direction. |
| **1b — edge case "no row is skipped permanently"** | **PARTIAL** | Satisfied for accounts on the **default** cap, and pinned by the new case `keeps releasing for other accounts when a capped account fills the candidate scan` (`release.integration.test.ts:1029`) with `scanLimit: 1`. Not satisfied for a sub-default configured cap: `auto_approval_policies_daily_send_cap_check` admits `1..50` (`supabase/migrations/091_send_mode_spine_lifecycle.sql:490`), and the existing case `does not downgrade a cap-exhausted batch when the Judge is unhealthy` (`release.integration.test.ts:1385`, `seedSolicitationPolicy(1)` + 1 queued row) is an instance of exactly that state — capped, un-excluded, still a candidate. Mitigant: **no TypeScript writes `daily_send_cap`** (grep across `src`/`worker`/`scripts` returns only the reader at `release.ts:1183`), so the state needs a manual DB/admin write. |
| **1c — allowlist `RELEASE_CANDIDATE_SCAN_SQL` byte-for-byte** | **YES** | `pnpm ci:tenant-scope` → `passed — entries: 390 (baseline: 390)`. Both `solicitation_outreach` occurrences (the CTE and the `rendered` `EXISTS`) share one entry as the comment claims; baseline did not move. |
| **2 — stale `SOLICITATION_PLATFORM_DAILY_CAP` row** | **YES** | `.claude/reference/env-vars.md:111` now reads "**#900 is the consumer that acts on it, and it has landed**: `runReleasePhase` (`src/lib/solicitation/release.ts`) reads this var once per tick…". Matches `release.ts:939-945`. |
| **3 — `tests_to_add` titles still verbatim** | **YES, 39/39** | Programmatic check of all 39 intake titles against every `*.test.ts` in `git ls-files`: 0 missing. |
| **3a — `rolls back rendered-to-queued when enqueueSolicitationSend throws` still proves ROLLBACK** | **YES** | `release.integration.test.ts:1840-1866`. The `rejects` harness is gone; every rollback assertion is intact and one is new: `delivery_status === 'rendered'`, `queued_at === null`, `readSendJobs() === []`, **and** `readBatch(...).sending_started_at === null` — the batch stamp is written in the same transaction, so its absence is positive proof the unit rolled back. Plus `itemFailures === 1` / `released === 0`. Strictly stronger than the old harness. |
| **3b — `rolls back unknown Outreach terminalization when lazy-child completion fails` still proves ROLLBACK** | **YES** | `release.integration.test.ts:1868-1900`. `terminalizeWedgedOutreach` UPDATEs the outreach row to `unknown` **before** calling `completeRun`, so asserting `delivery_status === 'sending'` after a forced `completeRun` rejection is a rollback assertion, not an absence assertion. `readRun(childRunId).status === 'running'` pins the other half. `unknownTerminalized === 0` additionally proves `alertUnknownTerminalization` was not fired (`sweepUnknownOutreach`, `release.ts:441-445` — the alert sits behind `moved !== true`). |
| **3c — the deliberate non-isolation of the breaker read** | **YES** | `readSendBreaker` is at phase level (`release.ts:931`), outside every per-item catch; `propagates a Send breaker read failure and enqueues no solicitation_send row` is unchanged. Scans are likewise unwrapped, as `isolateItem`'s docstring claims. Recorded in the deviations doc. |
| **4 — `itemFailures` consistent with the report contract** | **YES, with one documented asymmetry** | Additive scalar on `ReleaseCycleReport` (`release.ts:149`), initialised at `:281`, folded by `tallyPhase` for the four sweep/backstop phases (`:251-253`) and by a direct `+=` for P4 (`:1085`); no double-count on either path. It reaches the tick log unchanged via `logger.log('Release cycle complete', { ...report })` (`SolicitationReleasePoller.ts:58`). Asymmetry, documented in-code: the sweeps count per ROW, P4 counts per ACCOUNT (`release.ts:1081`), so one scalar mixes two units. `typecheck` clean. |
| **5 — Judge split now HOLDS past `BATCH_APPROVAL_WINDOW_DAYS`** | **YES for the bullet it was fixing; see NEW-2** | `release.ts:1254` is `sending_started_at !== null \|\| !approval_window_open`. `approval_window_open` is DB-computed as `built_at > NOW() − 7 days` (`release.ts:1142-1143`), the **exact complement** of P3's `built_at <= NOW() − 7 days` (`release.ts:853`), so no batch is both. It cannot be `NULL` for a candidate: 091's `(approved_at IS NULL OR built_at IS NOT NULL)` (`091…sql:161`) plus the scan's `approved_at IS NOT NULL` guarantee a non-null `built_at`, so the `boolean` type is honest. The held batch stays approved, so P2 reclaims it at `approved_at + 72h` (`selectSendWindowElapsedBatches`, `release.ts:757-771`) — the "honest reason" the docstring claims, verified. |
| **5a — the other Judge bullets** | **no break found** | UVB 8 (mid-drip hold, no state change) — the new arm is a superset of the same behaviour and the existing case `holds with no state change when the Judge is unhealthy mid-drip` is untouched. Edge case 9 ("a downgrade is only legal before the first release") — still true; the new arm makes `sending_started_at IS NULL` necessary-but-not-sufficient, which does not contradict it. UVB 5 (`batch_expired` for **unapproved** batches) — unaffected; P3 requires `approved_at IS NULL`. The parent cannot reach `STALLED_THRESHOLD_SEND_BATCH_DAYS` (11) via the new hold: the parent is minted at approval and P2 closes it 3 days later. |

## NEW findings introduced by the fixes

| severity | file:line | finding |
|---|---|---|
| Low | `src/lib/solicitation/release.ts:1151-1153` (the `NOT EXISTS capped_accounts` arm) | **The `account_cap` withhold counter goes silent for the rest of the UTC day, and the tick then names no gate at all.** Excluding a capped account from the SCAN means it never enters `byAccount`, so `withhold(report, 'account_cap')` at `:1010-1012` is never reached for it. When every candidate account is capped — which is the **designed steady state**, since UVB 2 forces a 25-ask batch across ≥3 calendar days at 10/day — the phase produces `released: 0`, `withheldByReason: {}`, and `releasePhaseStoppedBy: null` (none of the three phase-level early returns at `:923/:933/:944` fires, and `budgetRemaining` is 2). At a 60s interval that is ~1,400 consecutive ticks a day that release nothing and state no reason, indistinguishable in the log from "no work due". This contradicts the intake `observability` bullet "**A tick that releases nothing states WHICH gate stopped it**", and it silences precisely the dial the module's own `logBudgetExhausted` docstring says the staging ramp reads to tell "paced" from "capped". Pre-fix this tick reported `withheldByReason.account_cap`. Confidence ≥95% — the mechanism is structural, and the new test at `release.integration.test.ts:1029` asserts the silence directly (`expect(report.withheldByReason.account_cap).toBeUndefined()`). A per-tick `capped_accounts` count folded into `withheldByReason` would restore the signal without changing the fairness behaviour. |
| Low (documentation) | `docs/superpowers/plans/feat-900-solicitation-release-poller-deviations.md` (no entry) | **The Judge-split change deviates from a locked `user_visible_behavior` bullet and is not recorded in the deviations register.** UVB 7 states unconditionally: "A Judge outage **before the first release** returns the batch to owner review: `approved_at`, `approval_method` and `approved_by_user_id` are cleared and the batch reappears as approvable in the Requests panel." After `cabeff32` that is false whenever `built_at` has crossed 7 days — the batch is HELD and nothing is cleared. Round 1 established the bullet was **already** unsatisfiable in that state (the downgrade happened, then P3 destroyed the batch), so the fix picks the less destructive failure and I agree with the choice; but the intake bullet is now wrong in a second, different way and the branch's own convention is to record exactly this (33 existing entries, two added by `cabeff32`/`1bd27676` for smaller changes). Either amend UVB 7 with the approval-window condition or add the entry. |

## Untriaged appendix — NOT findings, recorded so they are not rediscovered

**U1 — the subscription gate has the identical structural shape to the original starvation finding, and `capped_accounts` does not cover it.** `release.ts:1017-1022` does `withhold(report, 'subscription'); continue;` at the account level, with nothing removing that account's batches from the next tick's scan — the same mechanism the round-1 finding described for the cap. A lapsed account's approved batches stay candidates for their full 72h window (edge case 4 requires exactly that: "remaining rows stay rendered, and paying inside the window resumes the drip"). This is **unchanged code** that round 1 did not flag, so it is out of round-2 scope and belongs to whoever triages the branch, not to this table.

**U2 — `emptyReport()` in `worker/background/pollers/__tests__/SolicitationReleasePoller.test.ts:51-63` no longer mirrors `ReleaseCycleReport`** (missing `itemFailures`). It is an untyped object literal fed to an untyped `vi.fn()`, so neither `tsc` nor any assertion catches the drift, and no case asserts the logged payload's shape. Harmless today; it is a mirror with no enforcement.

**U3 — `itemFailures` mixes two units.** Per-row for the four sweep/backstop phases, per-ACCOUNT for P4 (`release.ts:1081`). The in-code comment states this deliberately and the phase is a Sentry tag, so the ambiguity is only in the single cycle-line scalar. Noted rather than reported.

**U4 — the `capped_accounts` CTE adds a second platform-wide aggregate over `solicitation_outreach` per tick** (`release.ts:1134-1141`), alongside `countPlatformDispatchAttemptsToday`. Index suitability for `queued_at >= …` GROUP BY `account_id` is a performance question and belongs to another axis; flagged only because it runs every 60s.

**U5 — round-1 appendix items A1–A8 were not re-checked** except where the fixes touched them. A3 (the `unknown`-vs-`failed` comment) is now partly superseded: `findRunningLazyChild`'s docstring was rewritten with a correct argument (`release.ts:606-621`), but the separate `unknown`-vs-`failed` comment A3 named was not.

## ROUND 2 TRIAGE (orchestrator, 2026-08-22)

The most valuable report of the run: it independently verified the fix's central
safety claim, then found two things the fix broke.

- **"cannot over-exclude" — VERIFIED, and the fix stands on it.** `resolveAccountDailySendCap` is `Math.min(configured ?? 10, 10)` and the CTE's predicate is CHARACTER-IDENTICAL to `countAccountDispatchAttemptsToday`, so every excluded account would have been `continue`d anyway. Independently re-attacked by the adversarial agent four ways and held.
- **`account_cap` observability regression — ACCEPT, FIX, RE-GRADED Low → MEDIUM.** Corroborated by the adversarial agent. Excluding capped accounts from the scan means they never enter `byAccount`, so the withhold is never counted. A fully capped tick reports `released: 0`, `withheldByReason: {}`, `releasePhaseStoppedBy: null` — byte-identical to an idle tick. That is the DESIGNED steady state (a 25-ask batch is forced across ≥3 days at 10/day), so ~1,400 ticks/day would be indistinguishable from "no work due". It contradicts the intake observability bullet "a tick that releases nothing states WHICH gate stopped it" and blinds the exact dial the staging ramp reads to tell paced from capped. The agent graded it Low on the grounds that no runbook consumes the field; the grade is raised because the field's entire purpose is the distinction it now cannot draw.
- **P4 PARTIAL, sub-default configured cap — ACCEPT, DEFER to #919.** The CTE keys on the constant, not the resolved cap, so an account configured below 10 still holds scan slots. Genuinely unreachable today (no TypeScript writes `daily_send_cap`; the schema admits 1..50), and closing it means joining the policy table into an allowlisted global scan. Filed rather than fixed.
- **Missing deviations entry for the UVB 7 change — ACCEPT, FIX.** The branch's convention is to record exactly this; two entries were added by the fix commits themselves.
- **U1 (subscription gate has the same structural shape) — DEFER to #919.** Correctly held out of scope: unchanged code round 1 did not flag.
