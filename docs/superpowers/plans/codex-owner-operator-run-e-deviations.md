# Run D / Run E parallel-start coordination

## D-E1 — Local Run E starts while Run D observes

**Date:** 2026-09-14 UTC.

The original ticket required D and its documentation closeout to merge before E started. During D's required full-day observation, the owner asked to start E now because D implementation was finished. Root accepted this as authority to overlap local work only.

The worktrees overlap in Operator modules, worker code, tests and documentation. Run C is already shipped and receives no edits. Run D remains at candidate `4b13d96621b156a47dbc4140995f45745bc8114d` on staging for its existing observation window, 2026-09-13T21:46:17Z through no earlier than 2026-09-14T21:46:17Z. Its hourly browser checks and five-minute health sampling continue without a reset or discarded sample.

Run E starts in `codex-owner-operator-run-e` from that committed D candidate, with its own dependency installation and local database `test_ws5`; D uses `test_ws4`. No agent writes across worktrees. E remote migrations, staging deployment, final review gate and merge wait for D and D's closeout. After D lands, root normalizes E onto current main, resolves any D review-fix overlap explicitly, then freezes E's final review fork. No guard or fingerprint is rewritten to pretend the temporary stacked base is main.

**Verdict:** ACCEPT — owner-requested local parallel start; final D-before-E shipping order and the full-day observation remain intact.

## D-E2 — Observation closed and E resumed after D closeout

The owner subsequently ended D observation early and authorized proceeding. D's evidence records the actual shortened duration, without claiming a full day. D feature #1291 and documentation #1292 merged before E resumed on `30896acbcb2ee127131504e531f230fcfc7e4409`. After automatic approval review interpreted the earlier authority as D-only, the owner directly answered “Yes finish it” to continuing and finishing E. The earlier pause and D-E1 observation wording are retained as history and superseded by these explicit instructions.

**Verdict:** ACCEPT — explicit owner authority; production Operator remains disabled and the pilot owner/window remain human decisions.

## E-S1 — Required supporting test and directory paths

The first mechanically counted surface amendment adds `src/lib/llm/__tests__/openai-provider.test.ts`, `docs/directory/app-authenticated.md`, and `docs/directory/app-api-b.md` to both intake copies. The provider regression assertion incorrectly required every strict input object to have at least one field; the approved empty-input clear/restore operations require accepting strict empty objects while retaining exact required-key and additional-properties checks. The two directory pages inventory the new Restore and timeline UI/API files. These support the approved E behavior and introduce no provider calls or new product scope.

**Verdict:** ACCEPT — necessary supporting paths within the owner-authorized E implementation; surface amendment count is one.

## E-S2 — Owner-approved second adversarial pass and supporting scope

On 2026-09-15 UTC the owner answered “Yes, approve the scoped E second pass” to the exact question retained in `docs/reviews/codex-owner-operator-run-e/second-pass-authorization.md`. The reviewed proposal is retained in `budget-extension-review.md` beside it. This is a finite execution grant for round 2, capped at 1,600 supervised local launches. It grants no third round, coverage waiver, external provider probe, Claude/Opus delegate or production Operator enablement.

The second mechanically counted amendment adds the six named runner/checker/skill/test support files and `docs/runbooks/beta-launch-alerting.md`, and corrects the intake's unhashed red-team directory to `docs/reviews/red-team/codex-owner-operator-run-e-eb15ab/**`. Both intake copies match. The five new verbatim test promises include one parameterized UI title covering both approved regression cases and four verifier safeguards; the runtime UI cases retain their individual identities. Other contract fields and earlier promises are unchanged.

The first round exhausted the generic 30-launch allowance after 15 baseline/mutant pairs. Its original final reports retain all 2,113 inventory rows and three P1 findings. Root finalized the mutations before fixing the UI and assertion/doc findings; the verifier finished pinned read-only reporting while those fixes proceeded. The wrong intake directory deferred canonical publication until this approval. Commit `76f7914636e3d20c4a676a5d7ef512e17dab25ce` now preserves the exact original report bytes, independently hash-verified against scratch. Admission appends only the exact execution grant; original measured HEAD remains `890eea76c8c04b8d2acfcc73a895ec3112560e38`.

The corrected product baseline `54cb1a05e82de192355e379b7eb7b76182189306` passed its complete review gate: 16,130 database-enabled tests passed, 11 skipped; the separate unit/coverage lane passed 14,815 tests with 1,316 expected skips; E2E passed 60 with 108 skipped. Fingerprint `3d6ec29351a474287a5e2217c93dbc1088b472f06d9d9fb4b0d483333cdcd1a7`. The approved support edits require a new final gate and adversarial evidence; this earlier green is not reused for the amended tree.

The matching button Restore alert is now documented with its emitted endpoint/message, level, grouping, cadence/throttle and destination. Staging installation/readback remain part of T7; configuration is distinct from delivery testing. The final risk-waiver array remains empty, with the exact grant retained in immutable admission history, as explicitly included in the approval.

**Verdict:** ACCEPT — explicit owner approval for the bounded second-pass budget, supporting files, report routing, staging alert and final evidence format. No further round is authorized.
