# #1190 round-1 mutation operation — proposed, NOT authorized

Review pin: `6c42b8050acdeac698171a57d26b56d4fcbd8fcf`; fork and merge-base:
`8b92d85395f902879d93748b5929b0b503c0ad86`. Branch `feat/1190`, worktree
`/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-1190`.
No mutation, round-start, dotenv swap, preview stop, or proposed-runner execution
has occurred. Prior #1185/#1189 permissions are not authority for this proposal.

## Complete candidate inventory and budget

The independent read-only inventory agent `/root/feature_1190/mutation_inventory`
checked the pinned diff in both directions: changed tests/golden consumers and
changed production hunks/reverse importers. It found 26 unique Vitest candidates:
seven compiler-type cases, nine request-schema cases, five contract-audit cases,
one canonical-name case, and four wiring cases (one explicit plus three new
`ci:admin-contract` parameterizations). Existing AAL2 boolean-only tests do not
assert the added gate-name output and are explicitly excluded as unchanged
behavior. The actual-repository contract test consumes all committed generated
artifacts; no additional golden importer was found. The real CLI workflow covers
generation, audit success/failure, regeneration and stale-output removal.

Minimum: 26 green individual baselines plus one mutant each = 52 supervised
launches. Proposed ceiling: 26 baselines plus at most two mutants each = **78
TOTAL supervised launches**, including any collection or retry launches. This
does not grant extra retries above 78, a round reset, another round, sampling,
or a relaxed 120000 ms timeout. Any unexecuted candidate remains incomplete.
CLI subprocesses inside their individual Vitest case remain under its outer
120-second supervised limit.

## Exact proposed runner

Canonical source `.agents/skills/red-team/scripts/mutation-runner.mjs` SHA-256:
`159fc7b5f2b8b3e93308ae1ecb5c64f5e08c94d148ff8d20b77b4ed1e70347f5`.
Temporary proposal `/private/tmp/1190-mutation-runner-proposed.mjs` SHA-256:
`94fb4a29be056939c943b18cf5caedf5a41eb46e599059d9f4c1ea7aaee32d35`.

Sole diff:

```diff
-export const MAX_RUNS_PER_ROUND = 30;
+export const MAX_RUNS_PER_ROUND = 78;
```

Only after explicit owner approval, this copy may serve the `run` command for
this branch, pin, and round 1. The canonical script owns every other command:
watchers, round-start, escaping, dotenv isolation, mutation journals, result
assertions and finalization. Repository tooling is unchanged. The copy itself
does not enforce the branch/pin scope; the invoking lead must revalidate them
before dispatch, and the verifier must hash-check the copy before using it.

## Shared preview pause and restoration

An elevated canonical watcher check at approximately 2026-09-10 15:42 PDT refused
on the parent checkout's port 3101 preview. Current observed identities:

- Listener PID 14527, `next-server (v16.3.0)`, started Sep 10 15:33:51 PDT.
- Launcher PID 14493, started Sep 10 15:33:50 PDT, parent PID 8575.
- Cwd for both: `/Users/norbertesekiel/Developer/startups/RepWorth`.
- Exact launcher command: `node /Users/norbertesekiel/.nvm/versions/node/v24.15.0/bin/pnpm exec next start -p 3101`.

These replaced earlier PIDs independently. Authorization must scope the same
port/cwd/command identity, freshly checked immediately before stopping; stale
PIDs are never targets. Stop only the verified preview launcher and listener
gracefully. Never stop PID 8575, an unrelated process, another port, or a newly
discovered different watcher. If a process resists graceful termination, stop
the operation and report rather than assume permission for a broader kill.

Expected local-preview interruption: 15–25 minutes. End measurement and begin
finalization by 45 minutes after the pause even if incomplete. Staging and
production services are not part of this operation. Finalization and verified
preview startup may take additional time after the 45-minute measurement cutoff.

The lead owns explicit watcher checks, delegated to the verifier as a mandatory
precondition immediately before EACH `mutate` and EACH `run`. Use the same
elevated, process-visible execution context for both checks and operation. First
run `ps -Ao pid=,command=` with stdout suppressed and require exit zero; separately
verify that a PID-only process listing is nonempty and includes the checking
shell. Then run the canonical `watchers` command and require success. A failed,
empty, or unreadable process inspection is an abort, never evidence of no watchers.
Any detected watcher stops new work and triggers the lead's original finalizer;
the verifier must notify the lead immediately. Do not kill a new watcher.

These are point-in-time checks, not an automatic or continuous monitor: canonical
`mutate` and `run` do not call `watchers` internally. A watcher that appears during
an active supervised test is not instantly detected; the next explicit check
must abort. No stronger detection guarantee is claimed.

The invoking feature lead owns cleanup on success, failure or interruption:
run the ORIGINAL finalizer, verify no live supervised process groups or open
dotenv swap/mutation entries, verify the tracked tree matches the pin, then
restart the same absolute command in the same cwd using the existing build.
Verify the new listener and Ready output. Do not rebuild or edit parent files.
The original process's environment overrides have not been inspected or saved;
restart uses the normal shell and existing workspace configuration, so an
undocumented process-only override cannot be promised identical. No secrets
are copied into the proposal or reports.

This proposal still requires independent operation review, the exact-pin green
gate and explicit owner approval before any proposed operation executes.
