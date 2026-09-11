# #1190 round-1 operation authorization

Recorded 2026-09-10 from the owner reply relayed by the orchestrator `/root`.

Verbatim owner reply: **I approve.**

The reply approves the immediately preceding root request for the exact proposal
SHA-256 `53d7b3f1e438399404b7e640a2b8b035b3ececf81594cebbc4d8aa4cd9b9c7a5`:
78 TOTAL supervised launches for #1190 round 1 at committed head
`6c42b8050acdeac698171a57d26b56d4fcbd8fcf`, at most two mutants per candidate,
120000 ms per run, no round reset or additional retry allowance. The temporary
runner `/private/tmp/1190-mutation-runner-proposed.mjs`, SHA-256
`94fb4a29be056939c943b18cf5caedf5a41eb46e599059d9f4c1ea7aaee32d35`, may serve
only `run`; the original runner owns every other operation and finalization.

The approval includes graceful temporary pause of the port 3101 parent preview
only after freshly verifying its port, cwd, command and process identity; never
stop parent PID 8575 or another watcher. Restart the same command/cwd after the
original finalizer and restoration checks. Expected interruption 15–25 minutes;
end measurement within 45 minutes of pause, then complete cleanup/startup.
Original undocumented process-only environment overrides were not preserved;
restart uses the normal shell and existing workspace configuration, as disclosed.
There is no permission for SIGKILL, broad process termination, production writes,
new rounds above their ordinary budget, or merge.

Before execution the lead rechecked the exact head, clean tracked tree, current
green fingerprint `30e17684a306fea6b1c925f7e315326eb2c0eb214a536fa1013a90e45c852795`,
the unchanged proposal and both runner hashes. The original journal reports
round 0, runs 0, no mutations, no open dotenv swap and no supervisors.

This authorization will be retained with the final review evidence; it does not
change the frozen implementation or claim that measurement has begun.

## Execution start

At 2026-09-10 16:36:50 PDT (epoch 1789083410), the lead freshly verified listener
14527 and launcher 14493 against exact port, command, cwd, parents and start
times, then sent only SIGTERM to those two processes. Parent 8575 was untouched.
Process-visible canonical watchers subsequently returned clear. Canonical
round-start opened round 1 with zero launches; its default-cap message is 30,
while only the approved run-only copy permits the authorized ceiling of 78.
Canonical dotenv-swap scrubbed one file, `.env.local`, with its atomic backup.
The verifier uses `/private/tmp/1190-redteam-home-round1`, no database argument,
and the canonical allowlist/live-DB kill switch for every run.

Measurement cutoff: epoch 1789086110, 2026-09-10 17:21:50 PDT. The feature lead
runs the original finalizer after each mutant, then reopens the identical dotenv
swap before authorizing the next mutant. The verifier cannot write reports until
the lead confirms final restoration. This avoids stacked mutations in the
canonical journal and does not reset its launch counter.

## Completion and restoration

Round 1 completed all 26 candidates using 53 supervised launches: 26 green
individual baselines and 27 mutant measurements. Twenty-five candidates killed
a meaningful mutant; one confirmed survivor exposes an insufficient preprocessing
schema assertion. The second attempt for the helper-status case resolved its
first unexecuted-branch attempt. No candidate remains unexecuted or unresolved.

The original finalizer confirmed all 53 journaled process groups empty, all 27
mutation entries restored, no active supervisor and no open dotenv swap. The
tracked worktree remained clean at the approved pin. Only then were report bytes
authorized. No budget reset, timeout increase or additional round occurred.

The exact original preview command restarted in the original parent cwd, using
the existing build. It reported Ready in 128 ms. Listener PID 77175, launcher
77172, started 2026-09-10 16:56:52 PDT; the listener cwd was independently checked.
The preview interruption was 20 minutes 2 seconds, within the estimate and well
before the 17:21:50 measurement cutoff. This completes the approved pause and
restoration; another pause is not implicitly authorized by this record.
