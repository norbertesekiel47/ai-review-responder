# Red team — fix/1378-outbox-watchdog-dispatching-terminal

- **Mode** feature · **Risk** high · **Round** 1
- **fork_sha / merge_base_sha** `10377aa9bc8db7be9f7af1fdd2c5418ba81fabe9`
- **head_sha** `3bc5f1a31cf857ad991e2b5387e90b2da929cda6`
- **intake_sha256** `950c1de55af51703653a30a113c33c1bec776487c28bf58fecd3dd4ed4933767`
  (`.feature/intake.json` was parked to `.feature/intake.parked.json` by the
  orchestrator at 23:18Z, mid-run; it hashes byte-identical to
  `docs/superpowers/plans/fix-1378-outbox-watchdog-dispatching-terminal-intake.json`,
  so the locked contract is unchanged.)
- **Generated** 2026-09-20T23:33:40Z
- **Budget spent** 22s of 1200s measured test time, 11 of 400 launches
- **Status** `OPEN_P1`

## Preconditions

| Check | Result |
|---|---|
| tracked tree clean at a committed SHA | PASS (`git status --porcelain --untracked-files=no` empty) |
| no watcher/dev-server on this worktree | PASS (`mutation-runner watchers`) |
| journal closed, round open | PASS (`round-start`: round 1) |
| environment isolated | PASS (`env --tmp-home` allowlist + `dotenv-swap --test-db` against `localhost:5499/test_ws4`) |
| finalizer | PASS — 10 journaled mutations restored, 1 dotenv restored, journal closed |

Baselines at HEAD, under the isolated environment: watchdog suite 10/10 green,
operator suite 9/9 green.

---

## Duty 1 — hand-mutation

Nine distinct semantic mutations, each applied through `mutation-runner mutate`,
run against **both** live-DB suites (19 cases), then restored. Running the whole
pair per mutation rather than one `-t` case per launch was a deliberate trade:
the suites cost ~1-2s, and the full kill set per mutation is the measurement the
review actually needs ("which of the six go red?"). Every launch was supervised
and reaped.

| # | Mutation | Line | Result |
|---|---|---|---|
| M1 | `dispatching` disjunct re-scoped to `topic = AGENT_TURN` (the pre-#1378 form) | `OutboxPoller.ts:150` | **killed** — 5 red |
| M2 | terminal arm `INTERVAL '2 minutes'` -> `'2 hours'` | `:151` | **killed** — 6 red |
| M3 | `CASE WHEN status = 'dispatching'` -> `'dispatched'` (reclaim text inverted) | `:142` | **killed** — 3 red |
| M4 | `dispatched_at IS NULL OR` dropped from terminal arm | `:151` | **killed** — 2 red |
| M5 | `attempts >= max_attempts` -> `attempts > max_attempts` | `:146` | **killed** — 11 red |
| M6 | `array_agg(id) FILTER (WHERE topic = AGENT_TURN)` -> `array_agg(id)` | `:156` | **SURVIVED — 19/19 green** |
| M7 | terminal arm `INTERVAL '2 minutes'` -> `'2 seconds'` (narrowing) | `:151` | **killed** — 1 red |
| M8 | M6 **plus** the callee topic guard removed | `:156` + `turns.ts:58` | **killed** — 2 red |
| M9 | arm 3 (re-pend) `INTERVAL '2 minutes'` -> `'2 hours'` | `:176` | **killed** — 1 red |

### M1 — which of the six new cases actually pin the fix

Reverting the predicate to the topic-scoped pre-#1378 form turns **four** of the
six new cases red, plus the modified operator case:

```
RED: watchdog recovery of exhausted dispatching Operator work preserves live claims and other topics
RED: terminalizes a stale dispatching row at max_attempts on a non-agent_turn topic
RED: terminalizes a stale dispatching row whose dispatched_at is NULL
RED: writes the dispatching reclaim text when a terminalized dispatching row recorded no error
RED: keeps a per-job last_error when terminalizing a stale dispatching row
```

All four fail with clean assertion errors on the exact predicate behaviour
(`expected 'dispatching' to be 'failed'`, `expected null to be 'Stale
dispatching entry exceeded max_...'`), not setup or import errors. **This
independently re-derives the claim "the four new terminal cases failed first for
the right reason"** — which is otherwise not recoverable from disk, since the
branch carries no red-phase artifact and both commits already squash onto the fix.

The remaining two (`re-pends a stale dispatching row that still has attempts
left`, `leaves a freshly claimed dispatching row at max_attempts alone`) survive
M1. That is correct — they are guards on arm 3 and on the false-positive window,
and the file says so. Both are independently real: M9 kills the first and only
the first; M7 kills the second and only the second. But the claim **"Six new
live-DB cases prove the widened watchdog arm" is overstated: four do.** (P2-2.)

### M6 — the survivor, and its arbiter verdict

Making the `array_agg` FILTER topic-agnostic — so `reconcileTurnForFailedOutbox`
is invoked for **every** terminalized row on **every** topic — leaves all 19
cases green, including the operator case that D1 says exists to pin exactly that.

Arbiter inspection: the mutant is **proven equivalent** for correctness.
`reconcileTurnForFailedOutbox` re-filters on topic in its own first statement:

```
src/lib/agents/operator/turns.ts:58
      AND topic = ${QUEUE_NAMES.AGENT_TURN} AND aggregate_type = topic
```

so a non-`agent_turn` outbox id returns `'unchanged'` before touching
`agent_turns`, `deferredCount` is unaffected, and `terminatedCount` is unchanged.
Confirmed constructively by M8: removing **both** guards *is* killed (the
operator `otherTopic` fixture's turn flips to `failed`). The row is therefore
recorded `equivalent`, not a P0.

What the mutation *does* prove is a documentation defect, raised separately as
**P1-1**: the FILTER is redundant defence-in-depth, not the safety boundary, and
no test pins it independently. It is not free either — without it the watchdog
issues one extra `SELECT` per terminalized row inside the transaction, so a
future "it's redundant, delete it" refactor is safe for correctness and costs N
round trips during a mass sweep.

---

## Duty 2 — fragile assertions

**P2-3.** `OutboxPoller.watchdog.integration.test.ts:315`

```ts
expect(DISPATCHING_RECLAIM_TEXT).not.toBe(GENERIC_RECLAIM_TEXT);
```

Both operands are string literals declared in this same file (`:68`, `:72`). The
assertion compares the test file to itself and can never fail on any
implementation, broken or not. It is the textbook "passes on a broken
implementation" shape.

The assertion that *would* carry weight is absent. Every #1378 case is seeded on
`PROBE_TOPIC` and the header comment states the premise explicitly — "The cases
below are seeded on PROBE_TOPIC precisely because it is not `agent_turn`" — yet
nothing pins that premise. `expect(PROBE_TOPIC).not.toBe(QUEUE_NAMES.AGENT_TURN)`
would. Behavioural replacement: swap the self-comparison for the premise check.

No other fragile shapes found: no absence-of-tag proxies, no exact string counts
on rendered output, no order assertions. The `toMatchObject` in the operator
suite asserts named fields, not shape.

---

## Duty 3 — docs vs reality

`~/.claude/skills/grill-me-codex/scripts/prevalidate-plan.py` was **not**
present, so every citation below was re-resolved by hand against `3bc5f1a31`.

| Citation | Where | Verdict |
|---|---|---|
| `OutboxPoller.ts:142-144` (status-chosen reclaim text) | `docs/context/core-platform-runtime.md:9` | **resolves exactly** |
| `OutboxPoller.ts:156` (array_agg FILTER) | `core-platform-runtime.md:9`, deviations D1 | **resolves exactly** — but the claim it supports is P1-1 |
| `core-platform-runtime.md:9` / `:11` | deviations D2 | **resolve** (Watchdog / Job-failure sink) |
| `OutboxPoller.operator.integration.test.ts:161-178` | deviations D1 | resolves (the `it(` opens at `:163`; the range covers the body) |
| **`OutboxPoller.ts:158-159`, "one topic filter removed"** | **deviations D3** | **DOES NOT RESOLVE** — `:158` is the closing backtick of the statement and `:159` is `let deferredCount = 0;`. The changed predicate is at `:150-151`. |
| **"the measured production diff is 16" / "the remaining 14 are the comment"** | **deviations D3** | **DOES NOT RESOLVE** — `git diff --numstat origin/main...HEAD -- worker/background/pollers/OutboxPoller.ts` is `8 4` (12 lines touched, 8 added). The predicate is 2 and the comment block is 7-added-for-3-removed. Neither 16 nor 14 is derivable. |
| `OutboxPoller.ts:152` (FILTER) | intake `non_goals` | stale (now `:156`) — **explicitly acknowledged in D1** |
| `OutboxPoller.ts:166-176`, `:172` (arm 3) | intake `existing_patterns_to_follow`, `edge_cases` | stale (arm 3 is `:170-180`; the `dispatched_at IS NULL` predicate is `:176`) |
| **`checkFailedOutboxJobs`** | intake `observability`, and the task brief | **symbol does not exist** — the function is `checkFailedOutboxByTopic`, `worker/background/pollers/health-alert/checks.ts:105` |
| "`build` passed in 1m9s on PR #1389" | deviations D4 | **resolves** — `gh pr checks 1389` reports `build pass 1m9s` |

The production comment's own falsifiable claim — "Re-scoping it turns the
non-agent_turn case in `OutboxPoller.watchdog.integration.test.ts` red"
(`OutboxPoller.ts:134`) — is **true**, measured by M1.

### Claimed evidence re-derived independently

- **"Zero orphan rows exist in production or staging" — VERIFIED.** Queried both
  Supabase projects directly (`udeyaqnvpojbwgoaxwdg` prod,
  `kubdiqdhqbhwmqfditeg` staging) for
  `status='dispatching' AND attempts >= max_attempts AND (dispatched_at IS NULL OR dispatched_at < NOW() - INTERVAL '2 minutes')`.
  Zero rows in both — and zero rows in `status='dispatching'` at all. Total
  `job_outbox` rows: 13 prod, 50 staging. Caveat recorded, not raised as a
  finding: `ArchivalPoller.ts:77-78` prunes completed rows at 7 days, so this is
  a snapshot of a small retained window and says nothing about whether an orphan
  ever existed and was pruned.
- **"15,299 tests pass; lint, typecheck and 26 ci:* audits green" — STALE.** See
  **P1-4**.
- **"The `build` gate row fails in every git worktree and is unrelated to this
  diff"** — the load-bearing half holds (CI's real clone built #1389 in 1m9s, and
  the diff touches only `worker/` and `docs/`, neither of which Next compiles).
  The universal "every git worktree" rests on n=3 worktrees against one real
  checkout; recorded as the sample it is, not challenged further.

---

## Duty 4 — missed sibling cases

**Pattern searched.** A recovery/reclaim arm over an outbox-shaped table whose
predicate is scoped to one topic, such that rows on other topics match no arm and
no claim.

**Scope.** `rg -n "topic = \$\{" worker/ src/lib/ scripts/` excluding
`__tests__/` and `*.test.ts`; plus every file under `worker/background/` that
mentions `status = 'dispatching'`, `status = 'dispatched'` or `stale` (25 files,
each read for its reclaim arm).

**Exclusions.** `scripts/ci/tenant-scope-allowlist.ts` (frozen SQL snapshots, not
live code) and `scripts/burst-drill-load.ts` (a drill harness).

**Result: zero siblings.** Every other `topic = ${...}` hit is a read-scoped
lookup or a dedup `NOT EXISTS` for one specific topic — the correct shape, not a
recovery arm. The two structurally closest candidates were checked and cleared:

- `src/lib/agents/operator/turns.ts:58` and `:369` are topic-scoped **by design**;
  `:58` is the guard that makes M6 equivalent.
- `AnalyticsDispatchPoller.ts:116-124`, the other **Watchdog** named in the
  glossary, cannot produce this orphan class at all: its stale reclaim writes
  `attempts = GREATEST(attempts - 1, 0)`, so it can never strand a row at
  `max_attempts` in `dispatching`.

A sound search that found nothing, recorded as one.

---

## Duty 5 — operational completeness

**P1-3.** The diff adds a terminal, operator-actionable failure path for ~30 of
the 37 registered topics, and that path has **no alert half at all**.

- `checkFailedOutboxByTopic` (`worker/background/pollers/health-alert/checks.ts:105-124`)
  is a CLOSED allowlist of 7 topics — `publish_response`, `send_notification`,
  `generate_response`, `build_solicitation_batch`, `generate_solicitation_asks`,
  `solicitation_veto_notice`, `agent_turn`. `QUEUE_NAMES` holds 37.
- The **Job-failure sink** does not cover it either: it fires on a BullMQ terminal
  `'failed'` event, and a watchdog terminalization produces no such event.
- `docs/runbooks/beta-launch-alerting.md:346-349` describes the companion signal
  as covering "the watchdog terminalising a long-`dispatched` row". After this
  change it also terminalizes a long-`dispatching` row on every topic. **No rule
  row was added or amended.**

The asymmetry that makes this a finding rather than a pre-existing gap: before
#1378 such a row raised `outbox_stale_dispatching` (`checks.ts:166`, level
`error`) **permanently**. The change replaces a loud-but-misleading signal with
silence for the 30 non-allowlisted topics.

**Is the acknowledgement accurate and complete?** Accurate in what it says,
**incomplete in what it omits.** The intake's `observability` entry names the
allowlist gap but frames the outcome as neutral — "correct in `job_outbox` but
does not page" — and `user_visible_behavior` #3 presents the clearing of
`outbox_stale_dispatching` as a benefit. Neither says an existing alert signal is
being **removed**. It also names the wrong symbol (`checkFailedOutboxJobs`;
P2-4). Mitigation on the record: `ArchivalPoller.ts:78` retains `failed` rows for
90 days, so the row stays auditable via `/admin/jobs` — discoverable, never pushed.

---

## Findings

### P1-1 — the named safety boundary is not the real one, and nothing pins it

`worker/background/pollers/OutboxPoller.ts:135-136`

Three places state that the `array_agg(id) FILTER (WHERE topic = AGENT_TURN)` at
`:156` is what keeps `reconcileTurnForFailedOutbox` Operator-only:

- the production comment, `OutboxPoller.ts:135-136` — "the array_agg FILTER below
  is what keeps `reconcileTurnForFailedOutbox` Operator-only";
- `docs/context/core-platform-runtime.md:9` — "reached only through the
  `array_agg(id) FILTER (WHERE topic = AGENT_TURN)` at `OutboxPoller.ts:156`";
- deviations **D1**, which justifies the changed operator assertion as "it now
  pins the topic-scoping of the RECONCILIATION rather than of the TERMINALIZATION".

**Measured (M6): removing the FILTER entirely leaves all 19 cases green,
including that operator case.** The authoritative guard is the callee's own
`AND topic = ${QUEUE_NAMES.AGENT_TURN}` at `src/lib/agents/operator/turns.ts:58`;
M8 confirms the operator case only bites when both fall. The FILTER is a
redundant pre-filter (and a real N-round-trip saving), and D1's justification for
weakening the operator assertion does not hold: the case does not pin what D1
says it pins.

Behavioural fix, either one: assert the invariant where it lives — a case that
terminalizes a non-`agent_turn` row and asserts `reconcileTurnForFailedOutbox`
was not reached — or correct the three statements to name `turns.ts:58` as the
guard and the FILTER as the cost optimisation it is.

### P1-2 — the 2-minute terminal window is smaller than the dispatch path's own worst case

`worker/background/pollers/OutboxPoller.ts:150-151`

The widened arm terminalizes any `dispatching` row at `attempts >= max_attempts`
older than 2 minutes. The dispatch path can hold a claimed row in `dispatching`
for longer than that:

- topic groups dispatch **serially** (`:441-455`), each bounded by
  `OUTBOX_DISPATCH_TIMEOUT_MS`, default **10 s** (`:54`);
- `QUEUE_NAMES` has 37 topics and the default batch is 50 rows, so one batch can
  span ~37 groups ~= **6 minutes** worst case under a degraded Redis;
- the overlap guard (`:84`) assumes a cycle wedged after `max(interval*4, 60s)` =
  **60 s** and starts a fresh cycle, which runs the watchdog first.

So a third cycle's watchdog can terminalize rows the first cycle has claimed and
not yet dispatched. `markDispatched` (`:244`) is status-scoped to `'dispatching'`,
so it then writes **nothing, silently**, while `addBulk` may have succeeded and
the job runs — leaving the row terminal against work that executed.

The same 2-minute race already existed on arm 3 for retryable rows, where the
cost is a duplicate and every handler is idempotent by invariant. What #1378
changes is the consequence: for exhausted rows the outcome is now **terminal**, on
every topic instead of only `agent_turn`. The intake's guard sentence ("A row
claimed less than 2 minutes ago is never terminalized") is true but assumes the
claim->dispatch gap is short; measured against the dispatch loop it is not bounded
by 2 minutes.

Raised for adjudication, not as a fix request: the intake's `non_goals` explicitly
forbid changing the 2-minute window or `OUTBOX_WATCHDOG_STALE_MS` in this run.

### P1-3 — terminal path for ~30 topics with no alert half

`worker/background/pollers/health-alert/checks.ts:105-124`

See Duty 5 above. Either half is missing: no rule row in
`docs/runbooks/beta-launch-alerting.md` for the new failure class, and no
emitting signal for the 30 non-allowlisted topics. The change also removes the
pre-existing `outbox_stale_dispatching` error those rows used to raise.

### P1-4 — the claimed gate evidence was produced before HEAD existed

`.feature/gate-status.json:1`

- `gate-status.json` `timestamp` `1789945687` = **2026-09-20T23:08:07Z**, and
  `"passed": false`.
- `.feature/state.json` pins `"headSha": "650f625e788d1a87a770c77d40ae8a2d41730982"`
  — the **base** commit — with `"intakeSha256": ""` and `"phase": "executing"`.
- `f9aa7d350` and `3bc5f1a31` were both committed at **2026-09-20T23:22:31Z**, 14
  minutes after that gate run.
- `surfaceAmendmentLog[1]`, the amendment that adds the
  `.claude/reference/arch-review-log.md` row *because `ci:merge-ledger` requires
  it*, is stamped **23:18:12Z** — also after the gate recorded `merge-ledger: PASS`.

The claim "15,299 tests pass; lint, typecheck and 26 ci:* audits green" therefore
describes a tree that is not `3bc5f1a31`. Per the gate-evidence rule, the verify
gate must be re-run against current HEAD as the last serialized step after this
review wave lands; the recorded evidence cannot stand in for it.

### P2-1 — D3's line citation and line counts do not resolve

`docs/superpowers/plans/fix-1378-outbox-watchdog-dispatching-terminal-deviations.md`
(D3). `OutboxPoller.ts:158-159` points at the statement terminator and
`let deferredCount = 0;`; the predicate is `:150-151`. "16 production lines" and
"the remaining 14 are the comment" are not derivable from `git diff --numstat`
(`8 4`).

### P2-2 — "six new cases prove the widened arm" is overstated

`worker/background/pollers/__tests__/OutboxPoller.watchdog.integration.test.ts:262`.
M1 turns four red. The other two are arm-3 and false-positive guards — correctly
described in-file, but they do not pin the fix.

### P2-3 — a tautological assertion, and the meaningful one missing

`worker/background/pollers/__tests__/OutboxPoller.watchdog.integration.test.ts:315`.
See Duty 2.

### P2-4 — intake citations stale, and one symbol does not exist

`docs/superpowers/plans/fix-1378-outbox-watchdog-dispatching-terminal-intake.json`.
`OutboxPoller.ts:152` (acknowledged in D1), `:166-176` and `:172` for arm 3, and
`checkFailedOutboxJobs` — the function is `checkFailedOutboxByTopic`. Line drift
in a contract locked at the pre-change HEAD is expected; the wrong symbol name is
not, and the task brief inherited it.

### P2-5 — the declared log-line behaviour has no assertion

`worker/background/pollers/__tests__/OutboxPoller.watchdog.integration.test.ts:89`.
`loggerStub` is a `vi.fn()` triple that is never asserted and never cleared
between cases, while the intake declares as user-visible behaviour that the
`[OutboxPoller] Watchdog recovered stale entries` line's `failed` count now
includes these rows. The terminalization itself is covered four ways; only the
counter's declared behaviour is unasserted.

---

## Inventory

| id | case | outcome | evidence |
|---|---|---|---|
| A1 | terminalizes a stale dispatching row at max_attempts on a non-agent_turn topic | killed | M1, M2, M5 |
| A2 | terminalizes a stale dispatching row whose dispatched_at is NULL | killed | M1, M4, M5 |
| A3 | writes the dispatching reclaim text when a terminalized dispatching row recorded no error | killed | M1, M2, M3, M5 |
| A4 | keeps a per-job last_error when terminalizing a stale dispatching row | killed | M1, M2, M5 |
| A5 | re-pends a stale dispatching row that still has attempts left | killed | M9 |
| A6 | leaves a freshly claimed dispatching row at max_attempts alone | killed | M7 |
| A7 | watchdog recovery of exhausted dispatching Operator work preserves live claims and other topics (modified) | killed | M1, M2, M4, M5, M8 |
| B1 | keeps a per-job last_error when terminalizing a stale exhausted row | killed | M5 |
| B2 | writes the generic reclaim text only when no error was recorded | killed | M3, M5 |
| B3 | dispatch exhaustion rolls back the outbox transition when its turn update fails | killed | M2, M3, M5 |
| B4 | watchdog recovery of exhausted dispatching work defers a turn locked by completion | killed | M2, M5 |
| B5 | a worker crash after ambiguous dispatch exhaustion remains recoverable by the watchdog | killed | M5 |
| B6 | watchdog exhaustion terminalizes an accepted Operator turn in the same transaction | killed | M5 |
| B7 | dispatch exhaustion ignores mismatched account and aggregate identities | killed | M8 |
| B8 | reconciliation topic-scoping via the array_agg FILTER | equivalent | M6 survived; proof at `turns.ts:58`, corroborated by M8 |
| X1 | `supabase/migrations/` | excluded | out of scope — the DB is provisioned before the run |
| X2 | `e2e/` Playwright specs | excluded | out of scope — fragile-assertion review only; none touch this surface |
| X3 | `OutboxPoller.ts:131-137` comment hunk | excluded | comment-only; no behaviour to mutate |

No row is `inconclusive`. No in-scope row is `skipped-budget` — 22 s of the
1200 s round budget was spent, and the inventory ran to completion.

## Authorizations

None. No finding on this run is `accepted-risk`.

## Restoration

`mutation-runner finalize` reaped 11 process groups, restored 10 journaled
mutations across `worker/background/pollers/OutboxPoller.ts` and
`src/lib/agents/operator/turns.ts`, and restored `.env.local` from its journaled
backup. `git status --porcelain --untracked-files=no` is **empty**;
`git diff HEAD` is empty. The only untracked paths are this run's report
directory and the sibling review axis's `.feature/review-staging/`.
