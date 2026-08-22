# Handoff — feat-900-solicitation-release-poller

A resumed session bootstraps from this file. **It never needs the prior transcript.**

**Worktree:** `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-900-solicitation-release-poller`
**Branch:** `feat-900-solicitation-release-poller` · **Issue:** #900
**Lane:** RISK = high · SURFACE = backend · `db_touching: true` · **no migration**
**Phase:** `executing` — mid `/feature` step 4. **Next action: dispatch Task 4.**

## Reconciliation, already done — expect these values

Run the resume skill's checks anyway; they should agree with this table. A
mismatch means something changed after this file was written.

Deliberately self-verifying — no hardcoded SHAs, because the commit that writes
this file changes HEAD.

| Check | Expected |
|---|---|
| `.feature/state.json` `headSha` | **equals** `git rev-parse HEAD` |
| `lastGreenGateSha` | **equals** HEAD — gate is GREEN at HEAD, all 22 rows |
| `phase` | `executing` **or** `gate_green` — see the note below |
| `planReviewRounds` | 3 (plan gate CLOSED at `APPROVED`; do not re-open) |
| `branchReviewRounds` | absent — step 7 has not started |
| `git status --porcelain` | empty |
| intake copies | identical (`diff -q` clean) |
| `git rev-list --count HEAD..origin/main` | 0 |
| `scripts/arm-check.sh` | ARMED |

**On `phase`:** `scripts/verify-gate.sh` stamps `gate_green` every time it runs
green, so that value keeps overwriting `executing`. **`gate_green` here does NOT
mean step 5 is finished** — it means the gate was green at that commit. The true
position is mid-step-4 with Tasks 4-10 outstanding. Trust this document's
"Remaining" table over the phase string.

## Read these, by path — do not restate them

| Artifact | Path |
|---|---|
| Intake contract (39 tests, 20 surface entries) | `.feature/intake.json` |
| The plan (11 tasks, blocking edges) | `docs/superpowers/plans/2026-08-22-solicitation-release-poller.md` |
| **Deviations — READ EVERY ENTRY** | `docs/superpowers/plans/feat-900-solicitation-release-poller-deviations.md` |
| Plan review rounds 1–3 | `docs/reviews/feat-900-solicitation-release-poller/plan-round{1,2,3}-codex.md` |
| Design of record | `docs/superpowers/specs/2026-07-28-send-mode-executor-approval-design.md` §4 D7/D9/D10, §5 D11/D12/D14, §7 D18 |
| Amendments (**win on conflict**) | `docs/superpowers/specs/2026-07-28-send-mode-cross-spec-amendments.md` B3, B6, B7, B10, B14, B15 |
| Glossary — **re-read before dispatching** | `CONTEXT.md`: Halt latch, Owner approval, Send breaker, Dispatch gate, Batch state, Lazy child, Settled batch |

## Done — 12 commits, oldest first

| Task | Commit | What |
|---|---|---|
| setup | `f8bc9e1d` `2b29fb73` `09ab44ff` | intake, plan, three codex plan-review rounds → `APPROVED` |
| stubs | `8721ac13` | `release.ts` + poller contract stubs, `worker/index.ts` registration, two `directory.md` rows |
| 0 | `ec6ec8d0` | eval task — 39 tests, complete bodies under `.fails` |
| 1 | `2047cf1d` | `enqueueSolicitationSend` typed outbox helper (B10) |
| 2 | `c2a00505` | `latchSystemHalt`, the third **Halt latch** arm |
| — | `b655737f` | amendment 1 — `src/lib/agents/run-spine.ts` |
| 3 | `b8957d97` | release phase: governors, Judge split, release transaction |
| — | `383ed74d` `68b8198b` | amendment 2 — tenant-scope allowlist |
| — | `9aa53e26` | amendment 3 — spine-caller allowlist |

## Remaining — Tasks 4-10, SERIAL

Tasks 4-7 all edit `src/lib/solicitation/release.ts`. **No parallel dispatch.**

| Task | Turns green | Notes |
|---|---|---|
| **4** | `latches send_window_elapsed past the 72h send window and cancels the live Outreach rows` | predicate P2 → `latchSystemHalt(reason:'send_window_elapsed')`. The latch owns the cancel, the step and the join — write nothing else. |
| **5** | `latches batch_expired…`, `a batch that receives no approval for 7 days closes cleanly and raises no stalled alert`, and RE-VERIFY `does not latch batch_expired on a batch with no Send batch parent` | predicate P3. The `EXISTS` over `agent_runs` is mandatory or a watch-mode batch is latched. |
| **6** | `terminalizes a sending Outreach row as unknown…`, `terminalizes the lazy child run…`, `rolls back unknown Outreach terminalization when lazy-child completion fails`, and RE-VERIFY both `does not terminalize…` | predicate P1. **Both belts**: grace period AND the in-flight `NOT EXISTS` **repeated inside the terminal CAS**. Also `completeRun` on the **Lazy child**. |
| **7** | `closes a settled batch the inline path missed`, `runs the sweeps and the backstop while SOLICITATION_SEND_ENABLED is off` | backstop = `closeBatchIfSettled` per still-open batch. **No second join implementation.** |
| **8** | poller loop-mechanics (already green) | ONLY: `SOLICITATION_RELEASE_POLL_INTERVAL_MS` (+ `env-vars.md` row) and the P2 backlog entry. Registration already shipped in `8721ac13`. |
| **9** | — | refine the two `directory.md` rows; update `CONTEXT.md` **Halt latch** ("no writer yet" is now false) and **Send breaker** (future tense → present). |
| **10** | — | open the deferred follow-up issue: amendment B14's `platform_halt` gap + the residual §7.1 yield-to-transactional obligation. |

**8 tests remain `.fails`.** Each is owned by exactly one task above.

## Six facts a resumed session must NOT re-derive

1. **Spec §9's parent disposition rollup is already built.** `closeBatchIfSettled` writes the `send_batch_closed` step detail with `disposition` and all five counts. Add no rollup code — call the function.
2. **Migration 091 enforces the Judge split.** `sending_started_at IS NULL OR approved_at IS NOT NULL` makes a mid-drip downgrade impossible at the database.
3. **091's halt CHECK forces `halted_by IS NULL`** for both system reasons. That is why `actorUserId` is `string | null`.
4. **The Lazy child is created at `src/lib/solicitation/dispatch.ts:1752`, inside #899's tx1, BEFORE the `sending` CAS.** A crash leaves both a `sending` row and a `running` child. Task 6 terminalizes **both, in one transaction**.
5. **Release-level governor order is QUOTED from amendment B6's closing paragraph:** breaker → platform ceiling → account cap → `subscriptionGrantsFullAccess`, then the Judge split. B6's per-child numbering is a different list. A wrong order is silent (#910 B3.2).
6. **Issue #895(b)'s unreachable CAS is now pinned.** Deleting `AND halted_at IS NULL` turns 2 of 4 tests red, counterexample `["owner","send_window_elapsed"]`.

## Two process rules that have each caught a real defect

**THE UNMASK STEP IS MANDATORY.** `it.fails` passes whether a test fails for the
right reason or the wrong one. Every task that removes a marker must run the
test unmasked and confirm it passes **for the reason its name states**. This has
already caught: three fixture defects in Task 0 (a `send_ordering` CHECK
violation in every mid-drip fixture), and a Task 3 defect where `beforeEach`
re-armed four delegating spies with themselves, so 31 cases died on stack
overflow while `.fails` reported them fine.

**THREE TESTS PASS VACUOUSLY RIGHT NOW.** Each opens with
`TASK 5/6 MUST RE-VERIFY THIS` and names the exact guard arm to delete to see it
go red: P3's `EXISTS`, P1's `NOT EXISTS` belt, and the `NOT EXISTS` repeated
inside the `unknown` CAS. Do not inherit a false green.

## Amendment budget: SPENT — 3 of 2 used

All three were owner-approved individually. **Root cause, recorded in the
deviations file: the intake declared ONE of the four governance registries this
class of module must touch** — `directory.md` (declared), `run-spine.ts`
`STEP_PERSONA`, `tenant-scope-allowlist.ts` `background-global-scan`, and
`outcome-anchor-pairing.test.ts` `CALLER_ALLOWLIST`.

**A fourth off-surface need is NOT another exception to request.** Stop, and
surface it as a re-plan decision.

**Step 8 promotion obligation:** that four-registry list goes into
`.claude/reference/lab-notes.md`, not just the deviations file.

## After Task 7 — the steps that follow

- **Step 5:** final gate run is `scripts/verify-gate.sh --review` (adds coverage + a changed-line `diff-coverage` row).
- **Step 6:** read the deviations file end to end, log ACCEPT / RE-PLAN per entry, commit the verdicts.
- **Step 7:** `bash scripts/blast-radius.sh` first, then `bash scripts/feature-state.sh incr-round branch`, then ONE full round of three parallel agents (spec+correctness, standards, adversarial — RISK = high gets all three). Reports to `docs/reviews/<branch>/`, findings tables only in context. **COMMIT the reports and triage verdicts.**
- **Step 8 (RISK = high):** ride `staging` first, verify, then PR to `main` and **PAUSE for explicit merge approval**. No migration to apply in lockstep.

## Ship-lane reminder

`SOLICITATION_SEND_ENABLED` stays OFF everywhere. Issue #915 names this ticket's
`unknown` sweep as the blocker for ever flipping it, so **Task 6 is the one that
discharges #915**.
