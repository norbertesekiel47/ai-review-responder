# Plan review — round 1 (Codex, adversarial, read-only)

**Dispatched:** direct `codex exec --sandbox read-only` (not the companion wrapper — it has lost
task ids across session resumes). codex-cli 0.145.0. Raw transcript (9,241 lines, not committed):
`<scratchpad>/codex-plan-review-719-out.txt`; brief: `<scratchpad>/codex-plan-review-719.md`.

**Verdict: `REVISE`** — 11 HIGH, 4 MEDIUM. Plan revised to v2; this file records the triage.

Leading question asked: *can the eval pass in full while the feature is still wrong?* Answer: yes,
ten distinct ways. That is the finding that mattered — the review was worth its cost on the eval
axis alone.

## Findings table + triage

| # | Sev | Where | Finding | Verdict |
|---|---|---|---|---|
| 1 | HIGH | Task 6 sink | The watchdog terminalizer (`OutboxPoller.ts:140-143`) sets `last_error` **unconditionally**, destroying whatever the sink wrote — the plan's promised diagnosis never survives | **ACCEPT** — verified by direct read. Dropped the `last_error` write entirely; Sentry only |
| 2 | HIGH | surface / D1 | Preserving it requires editing `OutboxPoller.ts`, outside `allowed_edit_surface` → 2nd amendment → step-5 abort | **ACCEPT** — moot once #1 is dropped. Surface unchanged; amendment count stays 1 |
| 3 | HIGH | Task 6 | `recordOutboxLastError` duplicates the existing `recordOutboxTransientError` (`outbox.ts:183`); `isFinalAttempt` duplicates `isTerminalAttempt` (`:210`) | **ACCEPT** — verified. `src/lib/shared/outbox.ts` **removed** from the surface; the sink imports both |
| 4 | HIGH | Task 6 / CSV | Persisting + string-logging raw `err.message` breaches csv-ingest's PII contract (`failed-hook.ts:34`: bounded error CLASS only, messages may embed contact handles) | **ACCEPT** — verified. Sink logs `err.name`; the message goes only to Sentry, which has its own scrubber |
| 5 | HIGH | Task 6 | The `status='dispatched'` guard is insufficient: `generate-failed-hook.ts:263` deliberately leaves retryable exhaustion `dispatched` with its own `last_error`, which the generic sink would overwrite | **ACCEPT** — verified. Moot once the write is dropped |
| 6 | HIGH | Task 6 wiring | Every sink test can pass while `worker/index.ts` never attaches it | **ACCEPT** — added title 25, `worker boot attaches the failure sink to every registered worker` |
| 7 | HIGH | Task 1 gate | `describeWithDb`'s 2-arg form registers **skipped** suites without `TEST_DATABASE_POOL_URL`; `test:db:setup` doesn't export it. Vitest exits green with all live cases unrun | **ACCEPT** — added the execution sentinel (title 1) + `assertSchemaReady`; the run command now exports the URL |
| 8 | HIGH | Task 1 t12-16 | Mocking the outbox module makes the sink suite blind to the real writer | **ACCEPT** — moot; the sink no longer calls a writer |
| 9 | HIGH | Task 1 t1-6 | Day_7's five branch-specific queries have **no** live coverage — another dropped column there stays invisible | **ACCEPT** — added title 9, a full live day_7 run |
| 10 | HIGH | Task 1 t4 | The test runs a *copied SQL literal*, not production code: it passes before the fix and proves nothing | **ACCEPT** — the sharpest finding. Titles 2-11 now call the real `resolveDashboardUrl` / `handleOnboardingDrip` |
| 11 | HIGH | Task 1 scheduler | `checkAndSchedule` catches its query error and returns, so "zero rows" passes whether the skip ran or the query crashed — every negative test was vacuous | **ACCEPT** — extracted `runOnboardingDripCycle(exec, asOf)` which **throws**; only the poll wrapper swallows. Title 20 pins it |
| 12 | HIGH | Task 5 | `COALESCE(completed_at, created_at)` measures row age, not failure time: a long-lived row that failed recently is wrongly re-queued | **ACCEPT** — verified both poller paths. Now `COALESCE(completed_at, dispatched_at, created_at)`; title 17 pins it |
| 13 | MED | Task 1 | Tests 4, 8, 9, 11 already pass pre-fix — the claimed all-red eval cannot exist | **ACCEPT** — folded into #10/#11. Task 1 Step 6 now requires all of 2-25 red and says a green one does not discriminate |
| 14 | MED | citations | `require-owner-access.ts:63` joins by *authenticated user*, not location→account owner; `AutonomyGovernorScheduler.integration.test.ts` passes its own client rather than redirecting the singleton | **ACCEPT** — both verified wrong. Corrected; the real singleton precedent is `ArchivalPoller.integration.test.ts:250-261` |
| 15 | MED | Task 7 ordering | Docs may run after T2 but before T3 while claiming the drip repair landed | **ACCEPT** — T6 now blocks on T3, T4 and T5 |
| 16 | MED | Task 4 titles | Keeping `ownerHasDashboardAuth` in test titles after the rename, purely to satisfy the title gate, makes the names false | **ACCEPT** — merged the collapse into Task 2 and retitled honestly; intake `tests_to_add` updated (a retitle is a deviations entry, not an amendment) |
| 17 | MED | deviations | Both entries still read "Verdict: pending" though the file says verdicts precede review | **REJECT** — misreads the process. The file states verdicts are logged at **step 6**; we are at step 3. The header already says so. No change |

Also accepted without a table row: the staleness boundary was wrong. v1's `<=` classified a drip
*at* the grace boundary as too-late, but the locked intake says send at the boundary and skip past
it. Now strict `<`, with titles 12-14 pinning boundary / just-past / outer-window.

## Net effect on the plan

- 7 tasks → 6 (the `resolveDashboardUrl` collapse merged into the fix task).
- 16 promised tests → **25**; `estimated_test_lines` ±500 → ±800.
- `src/lib/shared/outbox.ts` **removed** from `allowed_edit_surface` (a narrowing — auto-approved).
- `allowed_edit_surface` otherwise unchanged; amendment count remains **1**.
- Two follow-ups filed: the repo-wide SQL-column CI audit, and making the watchdog terminalizer
  preserve a non-generic `last_error`.

## Rounds

Round 1 of a hard cap of 3 (`.feature/state.json` `planReviewRounds`). Round 2 is
**verification-only**: it re-checks these findings against v2 and may flag a defect a fix
introduced, but may not open new fronts against unchanged sections.
