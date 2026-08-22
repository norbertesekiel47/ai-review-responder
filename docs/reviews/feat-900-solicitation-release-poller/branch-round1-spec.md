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
| `.claude/reference/env-vars.md` · `CONTEXT.md` · `docs/directory.md` · `docs/future-plans/…backlog.md` · `docs/superpowers/plans/**` · `docs/reviews/**` | exact |

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
