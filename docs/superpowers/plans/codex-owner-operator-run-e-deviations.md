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

## E-S3 — One correction within the existing second pass

The approved E-S2 proposal states: “A required additional code correction after admission invalidates the pin and requires root adjudication within the same second-round/cap contract; never silently move HEAD or reset spent launches.” Root applies that existing authority to correct overbroad candidate discovery after 124 supervised launches. No new grant, round, test-budget reset or risk waiver is introduced.

The root finalized the frozen b6 controller before edits. The checkpoint contains 62 restored mutation entries, 124 inactive supervisors and closed dotenv state. Sixty distinct identities have assertion kills; one earlier equivalent attempt and one database-check-intercepted attempt remain preserved before their successful second mutations. All 39 measured verifier cases used one mutation each and must spend their second available mutation on successor remeasurement. The two other cases that already used two mutations concern unchanged product paths and retain their original measurements.

The complete remaining census accounts for all 536 unmeasured identities without duplicates or omissions. It retains cases asserting E's behavior and identifies additional old tests separated by concrete mocks, branch/input cuts or assertions of unrelated unchanged output. Root reviewed those distinctions against the immutable diff; the exact correction manifest and per-case reasons are appended to `budget-extension-review.md`, preserving its original bytes and the earlier 162-case proof. An exclusion is a scope correction, never evidence that the excluded test is robust. Full regression gates continue to run those tests normally.

The finite verifier correction admits one successor HEAD and journals it before launch 125. It requires the original budget pin, exact closed checkpoint prefixes, unchanged non-supporting tracked files, preserved intake/report history and the reviewed manifest. The global cap remains 1,600, and the two-mutations-per-case limit spans both admission pins. Changed guard cases receive new measurements with the actual successor HEAD/controller; earlier measurements are never relabelled. A missing or second continuation, history tampering, counter rollback, unknown supporting change or third round fails closed.

Migration121's access-posture regression reads and executes the SQL during its test body after restoring pre121 constraints. Root retains that case as an explicit semantic SQL-mutation target: the skill's general exclusion assumes provisioning occurs before the test, which is false here. Source and live constraint restoration are required before continuing. This does not authorize a general migration exclusion exception.

**Verdict:** ACCEPT — root adjudication under E-S2's explicit same-round correction clause; all spent launches, earlier evidence and limits are retained. The corrected admission still requires focused checks, independent review and a fresh full gate before another adversarial launch.


## Same second-round corrective candidate after root-finalized launch 594

The existing owner-approved post-admission correction clause covers seven accepted fixture findings across five files (thirteen existing case identities), plus eight finite admission checks. Root finalized all 594 launches/297 restored mutations before freezing the checkpoint; both earlier pins and all attempts remain intact. Six unmeasured internal-validation siblings are explicitly deferred to their corrected first attempts, not excluded or represented as survivors. The next candidate is limited to exact reviewed fixture blobs, the existing six verifier support paths and these two append-only records. Its independent source review, exact checkpoint, hashes and remaining 90-pair inventory are retained in `docs/reviews/codex-owner-operator-run-e/budget-extension-review.md`. Application code is unchanged. No new owner approval, risk waiver, third round, larger cap, provider call or external action is inferred. Focused checks, the committed full gate and controller freeze precede any corrective launch.
