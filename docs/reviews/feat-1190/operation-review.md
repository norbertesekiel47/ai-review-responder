# #1190 mutation-operation proposal review

VERDICT: REVISE

Reviewer: `/root/feature_1190/operation_review`. Review performed on 2026-09-10 PDT. This is an independent, bounded review of the proposed operation, not a red-team execution, a feature correctness review, or owner permission to execute.

## Reviewed identities

- Worktree: `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-1190`.
- Actual branch: `feat/1190`.
- Actual HEAD: `74e1a97bfe43dc868a63f8420f76c4ed2ffc9545`.
- Actual merge-base against the supplied fork: `8b92d85395f902879d93748b5929b0b503c0ad86`.
- Proposal: `.feature/review-staging/operation-proposal.md`, SHA-256 `bb4b5f1e524970f7eed23306e87786848e5abe0425be9ec9745d9095b468e4d7`.
- Canonical runner: `.agents/skills/red-team/scripts/mutation-runner.mjs`, SHA-256 `159fc7b5f2b8b3e93308ae1ecb5c64f5e08c94d148ff8d20b77b4ed1e70347f5`.
- Temporary proposed runner: `/private/tmp/1190-mutation-runner-proposed.mjs`, SHA-256 `94fb4a29be056939c943b18cf5caedf5a41eb46e599059d9f4c1ea7aaee32d35`.

All three file hashes matched the supplied identities. `diff -u` confirmed exactly one changed line: `export const MAX_RUNS_PER_ROUND = 30;` becomes `export const MAX_RUNS_PER_ROUND = 78;`. The unchanged comment still describes the canonical 30-run budget; it does not alter behavior. There is no `scripts/mutation-runner.mjs` at the repository root; this review used the canonical path named above and in the proposal.

## Finding requiring revision

**R1 — The proposal does not specify the monitoring needed to make its newly started watcher abort promise true.** Proposal lines 70–71 say a newly started watcher during the operation must cause the canonical guard to abort. In the canonical runner, `cmdWatchers` is a separate command at line 513, invoked by command dispatch at line 862. Neither `cmdMutate` (line 550) nor `cmdRun` (line 586) invokes it, and the run wait/reap path contains no watcher monitor. Calling the initial watcher preflight therefore does not make a later watcher automatically abort a mutation or supervised test.

This is also sensitive to the process-inspection environment: my read-only `ps -p 14527,14493 -o pid=,ppid=,lstart=,command=` was denied by the sandbox. The canonical watcher command at lines 513–516 consumes stdout without checking the `ps` exit status, so running that guard in an environment where `ps` is denied can yield an empty process list and a misleading success. I did not execute that command or change its implementation.

Required proposal revision: assign an explicit lead-owned watcher-checking procedure, using a context where process inspection succeeds, and require failed/unreadable inspection to stop the operation. Require the canonical watcher command immediately before each mutation and launch, and state how detection stops new work and triggers the original finalizer. Retain the prohibition on killing a newly discovered watcher. If relying on point-in-time checks, disclose that a watcher starting during an active supervised run is not automatically or instantly detected; do not claim continuous enforcement by the runner. If adding polling, disclose its detection interval. This can be addressed in operation instructions without widening the temporary runner's one-line diff. The revised proposal needs a fresh hash and review before owner approval is sought.

## Accepted aspects of this exact proposal

1. **Budget accounting is internally consistent.** The supplied independent inventory contains 26 candidates, partitioned 7 + 9 + 5 + 1 + 4. Twenty-six individual green baselines plus one mutation per candidate require at least 52 supervised launches; at most two mutations each plus baselines requires 78. The runner counts every `run` launch at line 620, not only mutants, and rejects a launch when the journal already contains 78 under the proposed copy. Including collection and retries inside the same ceiling is correct: extra launches can reduce completed coverage, never enlarge the budget. This review checks the accounting against the supplied inventory; it does not redo the separate inventory review or claim that all candidates have been measured.

2. **The deviation is explicit and bounded.** Canonical skill policy is 30 runs, at most two mutations per test, and 120 seconds per run. The proposed copy changes only the launch cap. Its use is restricted to `run`, `feat/1190`, this full HEAD, and round 1, while canonical commands retain journals, round opening, escaping, dotenv operations, assertions and finalization. The copy does not enforce that branch/pin/round restriction itself; the lead's required fresh checks are material conditions, not optional documentation. The original runner's ticket-specific #1185 continuation cannot authorize #1190. The proposal correctly requires new explicit owner approval and does not grant a reset, another round, sampling, or acceptance of unexecuted candidates.

3. **Isolation and restoration remain canonical.** Reading `buildRunEnv` at line 136, `commandEnv` at line 390, mutation journaling at line 550, and finalization at line 778 confirms that the one-line copy preserves the allowlisted environment, temporary HOME, local-DB validation, process-group supervision, journaled mutations and restoration rules. The canonical skill still requires identical baseline/mutant environments and dotenv isolation. Missing-variable failures remain inconclusive; nothing in this proposal authorizes widening the environment. The original finalizer reaps supervised groups before restoring code and dotenv files, and refuses foreign file contents. Finalization and the tracked-pin check precede preview restart. The lead is explicitly responsible on success, failure and interruption.

4. **Shared-preview scope is appropriately limited, subject to fresh identity checks.** Read-only `lsof` independently confirmed that PID 14527 listens on TCP 3101 and that PIDs 14527 and 14493 both have cwd `/Users/norbertesekiel/Developer/startups/RepWorth`. I could not independently confirm argv, process start times or parent PID because `ps` was denied; those remain supplied observations, and the proposal correctly requires revalidation immediately before stopping. Stop authority is tied to port/cwd/command identity, not stale PIDs. Only graceful termination of the verified launcher/listener is proposed; PID 8575, unrelated processes and other services are excluded.

5. **The duration limit preserves incomplete outcomes.** The 15–25 minute interruption is an estimate, not a demonstrated completion time. Seventy-eight full 120-second launches could require 156 minutes before overhead, so the promise to end measurement and begin finalization by 45 minutes can legitimately leave the inventory incomplete. The proposal expressly preserves that result. The 45-minute point bounds measurement, not guaranteed completed cleanup and restored preview availability; finalization and startup verification can take additional time.

6. **Restart limitations are disclosed.** Restarting the same launcher command in the same parent cwd from the existing build, then checking the new listener and Ready output, is concrete. The proposal explicitly discloses that undocumented process-only environment overrides were not captured and cannot be promised identical after restart. It does not claim an exact environment reconstruction or copy secrets into evidence.

## Preconditions and review limits

`git status --porcelain` was empty at inspection, and no `.feature/red-team-journal.json` existed. The exact-pin full gate was reported as running; I did not inspect, execute, interrupt or claim a green result for it. Completion of that gate, an approved revised proposal, and explicit owner authorization remain prerequisites to any mutation operation, round start, dotenv swap or preview stop. Old ticket approvals do not transfer.

This pass used read-only file/hash/diff/git/process queries and `pnpm agent:rules .feature/review-staging/operation-review.md` (result: `none`). `git check-ignore` confirmed the report path is ignored workflow evidence. No mutation runner command, test, network request, dotenv swap or process signal was executed. No secret environment values were inspected. The only authored artifact is this review report.
