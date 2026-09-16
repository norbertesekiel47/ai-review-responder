# Run E second-pass execution authorization

The owner explicitly approved the following question in the Codex task on 2026-09-15 UTC. This execution grant is separate from a risk waiver; no finding or unmeasured case is waived.

> Question: May I apply the reviewed Run E proposal at /private/tmp/run-e-next-pass-proposal.md and run one second adversarial pass, capped at 1,600 local test launches? This covers the 707 remaining cases, the Restore fix and verifier safeguards, the named supporting files and staging alert setup. It preserves earlier evidence and your approval in history, leaves the final risk-waiver list empty, uses Codex only, and grants no third round.
>
> Owner: Yes, approve the scoped E second pass

Grant ID: `owner-run-e-second-pass-1600`. Branch: `codex/owner-operator-run-e`. Round: 2 only. Cap: 1,600 supervised local launches, counting all baseline, mutant, timeout and unsuccessful attempts. Existing per-run timeout, at-most-two-mutants-per-case, environment isolation and finalization rules remain active. No third round, external provider probe, Claude/Opus delegate, production Operator enablement or coverage waiver is granted.

Corrected code baseline: `54cb1a05e82de192355e379b7eb7b76182189306`. Original measured candidate: `890eea76c8c04b8d2acfcc73a895ec3112560e38`; fork `30896acbcb2ee127131504e531f230fcfc7e4409`. Original report hashes: JSON `b869b052d2f39574c51418e2a608f136c43e375853e3692385921f95c2259a0c`, Markdown `42cc8719dba7356dac5e626b6d606628789b5d24698de4e7998cbcb138b0cc46`. Original ordered identity digest: `cb7c194ac0f963e76e723f123007c143b913aea924360b77439b6a8007c4476b`.

The reviewed proposal permits six named verifier support files, the matching Restore invariant alert in `docs/runbooks/beta-launch-alerting.md`, and correction of the intake's red-team path to `docs/reviews/red-team/codex-owner-operator-run-e-eb15ab/**`. Both intake copies must match. It includes staging alert installation and readback without claiming a delivery drill. Production remains disabled.

Retain the untouched first-pass JSON/Markdown in an immutable historical commit before appending this exact grant to admission. The first launch pins the admission HEAD, grant digest and cap; later launches cannot reset or move that proof. The final report retains original identities and evidence history, reports new measurements honestly, and leaves the final risk-waiver `authorizations` array empty. This format was part of the initial approval and needs no separate report-format request.

The first pass recorded 2,113 rows: 15 killed, 707 skipped-budget and 1,391 excluded. The remaining 707 cases need at least 1,414 launches; two new UI cases need at least four more. The remaining allowance covers finite verifier safeguards and affected-case remeasurement. Reaching the cap with unfinished work must remain INCOMPLETE_BUDGET.
