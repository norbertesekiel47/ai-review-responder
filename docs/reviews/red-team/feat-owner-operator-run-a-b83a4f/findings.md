# Red team — feat/owner-operator-run-a — ROUND 3

**Status: `CLEAR`** (13 inventory rows: 11 executed, 0 inconclusive, 2 excluded · 27 of 30 mutation runs used). The round closed `OPEN_P1` on R11; the owner accepted R11 as risk on 2026-09-12 (authorization `auth-r11-accepted-risk-2026-09-12` in `findings.json`; the two clauses are corrected in the step-8 PR-description commit), which recomputes the status to `CLEAR`. P2s R9, R12, R13 remain open and never block.

| Field | Value |
|---|---|
| Mode | feature |
| Run id | `feature-feat-owner-operator-run-a-b83a4f` |
| Fork | `c5e94e6ca7e3c4187854a67129b1651a8f80566e` |
| Merge base | `c5e94e6ca7e3c4187854a67129b1651a8f80566e` |
| Head | `d21db9ecdf25fd124d8788acd07c5916271e3ad4` |
| Risk | high |
| Round | 3 (owner-authorized — `auth-round-3-2026-09-11`) |

Round 3 is SCOPED, by the owner authorization, to the round-2 fix hunks and their
direct callers: `git diff 0bd085391 d21db9ecd`. No front was opened against
unchanged code. Every claim below is evidence produced in this pass; the
`.feature/gate-status.json` GREEN claim was not trusted — each candidate's
baseline was re-run at head under the isolated environment before its mutant.

**Environment.** `mutation-runner.mjs env --tmp-home <mktemp -d> --test-db <localhost>`
(allowlist: PATH, temporary HOME, TMPDIR, NODE_ENV=test, CI, MOCK_EXTERNAL_APIS,
and `TEST_DATABASE_POOL_URL` after localhost validation), plus a `dotenv-swap` of
`.env.local` for the whole mutation phase. `--test-db` was passed on `env` and on
every `run`. Preconditions all passed closed: clean tree at a committed SHA,
`watchers` → none, `round-start` → round 3 open (it read the authorization from
the sidecar), budget reset to 30.

**Restoration.** All 12 journaled mutations were restored as they were taken;
every journaled path's working blob was verified byte-identical to its recorded
original before this file was written, `git status --porcelain` is empty, and no
supervisor process group is live. The finalizer (`mutation-runner.mjs finalize`)
is the invoking agent's step and still owes the journal close + dotenv restore.

## Duty 1 — hand-mutation

Two mutations per test at most, 120 s per run, 27 runs spent of 30.

| # | Candidate | Production line | Mutations | Outcome |
|---|---|---|---|---|
| r3-01 | `reads.integration` › carries each turn its own stored proposals | `proposals.ts:237` | always-empty Map; batched read loses `account_id` | **killed** ×2 |
| r3-02 | `snapshot.integration` › summarises each historical turn's own proposals | `proposals.ts:237` | always-empty Map; `describe` → stored rationale | **killed** ×2 |
| r3-03 | `reads.integration` › reports the location override and its dials | `context.ts:102` | `locationOverrideExists` forced `true`; location reads account default | **killed** ×2 |
| r3-04 | `snapshot.integration` › operating rules report the location override | `context.ts:102` | same two | **killed** ×2 |
| r3-05 | `AgentTurnWorker.test` › fails the turn unauthorized when the voice row vanished | `AgentTurnWorker.ts:198` | failure reason swapped; branch disabled | **killed** (mutation 1); mutation 2 = fixture TypeError, non-resolving |
| r3-06 | `context.test` › buildSnapshot scopes every read | `proposals.ts:244` | batched read loses `account_id` | **killed** |
| r3-07 | `voice-settings.test` › voice writer updates highlight_facts | `voice-settings.ts:152` | R7 reverted to `iso(updated_at)` | **killed** |
| r3-08 | `route.test` › PUT updates tone for a specific location | `route.ts:180` | route re-formats the token | **killed** |
| r3-09 | `schema.test` › status narrowings throw | `schema.ts:31` | `asTurnStatus` widens silently | **killed** |
| r3-10 | `reads.integration` › scopes the most-recent read to the actor | `context.ts:97` | wrong-but-POSITIVE veto window | **killed** |
| r3-11 | `AgentTurnWorker.test` › flag-off fails the turn operator_disabled | `AgentTurnWorker.ts:45` | kill switch never fires | **killed** |
| r3-12 | the other 15 `PUT /api/settings/voice` cases | — | — | excluded (reason on the row) |
| r3-13 | the 19 `skipped-budget` candidates from round 2 | — | — | excluded — **still unmeasured**, outside round 3's authorized scope |

**The two round-2 P0 mutants are now KILLED, each by two independent live-DB
oracles.** `listProposalsForTurns` forced to an empty Map dies in
`reads.integration.test.ts:406` (per-turn `toEqual`) and in
`snapshot.integration.test.ts:291` (`proposalSummaries`);
`projectOperatingRules.locationOverrideExists` forced `true` dies in
`reads.integration.test.ts:363` and `snapshot.integration.test.ts:352`. R3's
null-voice branch, R5's closed-list guard and R7's `RETURNING updated_at::text`
each kill their mutant as well.

One measurement did not resolve: disabling the `!voice` branch outright makes the
unit case fail on `TypeError: proposal.operation.preview is not a function`
inside `buildProposalRows` — the fixture's stub operation, not the test's oracle.
Per the skill a type error is never a kill, so it is recorded as a non-resolving
second mutation; the row is resolved by the failure-reason mutant.

## Duty 2 — fragile assertions

Two new absence-of-substring proxies entered with the new oracles
(`reads.integration.test.ts:494`, `snapshot.integration.test.ts:349`) — finding
R12, recorded at P2 because round 2 adjudicated this exact shape as R8/REJECTED
and because both sit beside a positive oracle (the first one's complement is what
actually killed a mutant this pass). The exact-count assertions the fix
introduced or changed (`context.test.ts:90` `toHaveLength(5)`,
`AgentTurnWorker.test.ts:190` `toHaveLength(2)`) are closed-list contracts with
their reasoning recorded in-line, and both were measured to kill a real
regression — not fragile. The proposal ORDER assertions are backed by a real
contract (`ORDER BY created_at ASC`, with the seed helper writing one row per
transaction precisely so the order is meaningful).

## Duty 3 — docs vs reality

`prevalidate-plan.py` at head: plan **PASS** (92 citations, 0 unresolved),
roadmap README **PASS**. Two script-reported issues were hand-resolved and are
NOT findings: the handoff's two "stale commits" are fragments of the dead Codex
*thread* UUID, which the same hunk labels as a thread id; and the deviations
file's `voice/route.ts:23` is R6's own description of the citation it removed,
quoted historically.

Hand-checked, since the script only proves a cited line exists: R6's replacement
rows resolve (`route.ts:29` is the `GET` handler), and every "verified by
applying it and reverting" claim in the deviations entry was independently
re-derived above rather than taken on trust.

One claim does NOT resolve — **R11 (P1)**: the new go-live entry at
`docs/roadmap/2026-09-11-owner-operator/README.md:638` says all six enumerated
terminal paths "resolve the turn and emit a `logger.warn` line".
`AgentTurnWorker.ts:46` emits `logger.log` (info), and `AgentTurnWorker.ts:265`
returns without resolving the turn at all. The entry's *conclusion* — no Sentry
signal in the lane, no rule row in the runbook, therefore one go-live decision —
is true and was re-verified; the per-path detail a rule would be built from is
not.

## Duty 4 — missed sibling cases

Pattern searched: a **Version token** built from a postgres.js `Date`
round-trip. Scope `src/lib` + `worker`, excluding `__tests__`; patterns
`function iso\(`, `iso\(row`, `new Date\([^)]*updated_at`, and every
`updated_at::text` site. Result: the R7 sibling is closed — reader and writer
now use the same `updated_at::text` spelling and return it verbatim, and `iso()`
is gone from `voice-settings.ts`. The only surviving `iso()` is
`src/lib/agents/read.ts:204`, which formats `created_at`/`occurred_at` display
values on the run spine — not a comparison token, and unchanged by this diff.
**Zero further siblings.**

## Duty 5 — operational completeness

The round-2 fix commit adds no new terminal or swallowed failure path — its only
production edit is the `RETURNING` clause. The pre-existing lane-wide gap (R9)
was re-verified static: no `captureException`/`Sentry` call under
`worker/jobs/agent-turn` or `src/lib/agents/operator`, and no rule row for the
lane in `docs/runbooks/beta-launch-alerting.md`. It stays DEFERRED per round 2
and is now documented in the roadmap; the documentation of it is what R11 is
about.

## Findings

| id | sev | at | disposition |
|---|---|---|---|
| R1 | P0 | `src/lib/agents/operator/proposals.ts:237` | **fixed** |
| R2 | P0 | `src/lib/agents/operator/context.ts:102` | **fixed** |
| R3 | P1 | `worker/jobs/agent-turn/AgentTurnWorker.ts:198` | **fixed** |
| R4 | P1 | `src/lib/agents/operator/__tests__/reads.integration.test.ts:261` | **fixed** |
| R5 | P1 | `src/lib/agents/operator/__tests__/context.test.ts:70` | **fixed** |
| R6 | P1 | `docs/superpowers/plans/feat-owner-operator-run-a-plan.md:71` | **fixed** |
| R7 | P1 | `src/lib/responses/voice-settings.ts:151` | **fixed** |
| R8 | P2 | `src/lib/agents/operator/__tests__/render.test.ts:307` | **rejected** |
| R9 | P2 | `worker/jobs/agent-turn/AgentTurnWorker.ts:213` | open (deferred to go-live) |
| R10 | P2 | `src/lib/agents/operator/schema.ts:31` | **fixed** |
| **R11** | **P1** | `docs/roadmap/2026-09-11-owner-operator/README.md:638` | **open** |
| R12 | P2 | `src/lib/agents/operator/__tests__/reads.integration.test.ts:494` | open |
| R13 | P2 | `worker/jobs/agent-turn/__tests__/AgentTurnWorker.test.ts:126` | open |

Full titles and the arbiter reasoning for each are in `findings.json`; the three
new ones are summarised above (R11 in Duty 3, R12 in Duty 2, R13 below).

**R13 (P2)** — the fix's new partial mock of `@/lib/agents/operator/turns`
(added so the null-voice case could stub `claimTurn` while keeping
`failTurnFenced` real) falsifies the untouched flag-gate test's own comment at
`AgentTurnWorker.test.ts:126` and the rationale it records. Measured, not
asserted: disabling the kill switch is still killed, so no coverage was lost.
Fix the comment, and assert `expect(mockClaimTurn).not.toHaveBeenCalled()` — the
assertion the comment says is impossible.

## Red-team findings rejected

- **R8 — REJECTED.** Absence-of-token proxies in the new render tests are not the
  only oracle: `src/lib/agents/operator/__tests__/render.test.ts:307` sits beside
  an exact `toEqual` over the stored array, and
  `turn-worker.integration.test.ts:429-430` beside a `parseReplySegments`
  round-trip that throws on the retired member, so a collapsed or empty output
  fails the positive half first. Recorded in round 2
  (`docs/reviews/feat-owner-operator-run-a/review-round-2.md`, R8 row;
  `docs/superpowers/plans/feat-owner-operator-run-a-deviations.md:645`) and
  carried forward unchanged.

## Authorizations

*Rendered from `findings.json`; never parsed back out of this file.*

- **`auth-round-3-2026-09-11`** (2026-09-11) — covers R1, R2, R3, R4, R5, R6, R7,
  R10. Verbatim: Owner (Norbert) authorizes a third round: "Authorize red-team
  round 3" — selected via AskUserQuestion on 2026-09-11 after round 2 closed
  OPEN_P0 with R1/R2 (oracle gaps) and R3–R7 (P1) open. Round 3 is scoped to the
  fix hunks for R1–R7 and R10.

## What is owed

1. `mutation-runner.mjs finalize` (invoking agent) — closes the journal and
   restores `.env.local`; the checker fails while either is open.
2. **R11 is an open P1 on a high-risk run at the round cap**, so it needs USER
   adjudication — fix the two clauses in the roadmap entry, or record an
   authorization naming R11 and set its disposition to `accepted-risk`. R12, R13
   and R9 are P2 and never block.
3. Round 2's 19 unmeasured candidates (r3-13) are still unmeasured. Round 3's
   authorization did not cover them, and no fourth round can open.
