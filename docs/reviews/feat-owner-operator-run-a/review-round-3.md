# Review round 3 — fresh red-team run, round 1 — feat/owner-operator-run-a

Pinned: fork `10c9444a9832cae0e45854f1d19cb124bb2ee5e9` (origin/main after the
pre-pass merge) · head `5b223e33f19499534961bf2d60d8781a41af780f` · gate GREEN
at head (full mode, fingerprint `42bc6db1…`) · intake SHA-256 at the pass
`4e5d3007…` (amended to `43b0b7ef…` by surface amendment #5 after triage).
Member: red-team round 1 of a FRESH run (the closed run's three rounds are
preserved under `docs/reviews/red-team/feat-owner-operator-run-a-b83a4f-rounds1-3/`;
this run's artifacts are at `…-b83a4f/`). No review axes re-ran: the delta since
round 2's axes is one behavior-preserving refactor plus docs.

Why fresh: the runner caps one journal at three rounds; intake amendments #3/#4
and the fallow refactor voided the closed run's sidecar (owner decision
2026-09-12, recorded in the handoff). Why main was taken first: PR #1270 was
`BEHIND`; the update was owed at merge time regardless, and taking it before the
pass costs one gate run rather than a second pass (execution-lanes.md § Pin the
fork — cost asymmetry). Owner chose via `AskUserQuestion`.

## Red-team result at head

30/30 mutation runs. 25 killed, 1 survived (P0), 2 inconclusive (oracle), 238
skipped-budget, 3 excluded. Status `OPEN_P0`. Every validator rule at its
post-refactor home in `render.ts` and every `AgentTurnWorker` step helper was
killed. Duty 2 (fragile assertions): none. Duty 4 (siblings): one P2, three
sound zeros recorded with patterns and scope.

## Findings and verdicts (orchestrator re-verified each against head)

| # | Sev | Duty | Finding | Verdict | Disposition |
|---|---|---|---|---|---|
| P0-1 | P0 | 1 | `claimTurn` lease predicate deletable with the agent-turn set green (23/23): the `attempt_token` fence stops a stale WRITE, only the lease stops a second SPEND | ACCEPT | Test oracle, not a production defect. Fix: exactly-one `runLlmTask`/`recordApiCost` on the racy turn; direct `claimTurn` case — second claim inside the lease → null, after expiry → new token. |
| P1-1 | P1 | 1 | validator `allowedOperations` gate (`render.ts:231`) reached by no test; also unreachable today because `modelVisibleOperations` ignores tier | ACCEPT | One case proposing a catalog op the snapshot omits. Forward guard for Run B's tier gating. |
| P1-7 | P1 | 1 | `handleTurnError` budget-decision terminal branch untested; `budget_exceeded` appears in no test | ACCEPT | One live case: `CostLimitExceededError` → `failed`/`budget_exceeded`, outbox completed, no retry. |
| P1-2 | P1 | 5 | `agent_turn` absent from `checkFailedOutboxByTopic`'s CLOSED allowlist (#628 class) | ACCEPT | Surface amendment #5. Add the topic + regression test modeled on the #628 case. |
| P1-3 | P1 | 5 | job-failure-sink `subsystem:worker_job` + `queue:agent_turn` has no rule row | ACCEPT | Surface amendment #5. §1 bullet + click-path row 11 (every event, error). Dashboard config is a go-live step, flagged REQUIRED. |
| P1-4 | P1 | 5 | intake names a stuck `dispatched` row as "the orphaned-lease signal"; it is a topic-aggregated log line | ACCEPT | Terminal half becomes real through P1-2; spec §14 now states the re-pend half is a log line by design. |
| P1-5 | P1 | 3 | spec §14:638 claims all six terminal paths `logger.warn`; `operator_disabled` logs info, a lost lease resolves nothing (= closed run's R11) | ACCEPT | Rewritten. R11's accepted-risk rationale ("no further commit") no longer holds. |
| P1-6 | P1 | 3 | `postgres.md:17` names `turns.ts` for two `parseReplySegments` calls that live in `reads.ts` | ACCEPT | One-word fix. |
| P2-1 | P2 | 4 | fifth private `boundedErrorClass`, unhardened shape, hardened shared export exists | ACCEPT | Import `boundedErrorClass` from `solicitation-batch/failed-hook-shared.ts`. |

Rejected: none. Deferred: none.

## Next

Fix commit (tests, allowlist, import, docs) → full gate → red-team round 2
scoped to the fix hunks and their direct callers → review gate → `reviewed`.
