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
