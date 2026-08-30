# Plan review round 3 — final, verification-only

**Reviewer:** codex exec, read-only. **Thread:** 01a05436-5259-7bb1-aeba-0fb10a1d9d8c
**Under review:** commit 5dbe8efa

---

| # | round-2 defect | verdict | note |
|---|---|---|---|
| 1 | “six files” over seven rows; test 26 self-certifying | PARTIAL | The map now assigns all 28 tests exactly once across seven distinct files, and test 26 scans its own file. However, the claimed independent `diff-coverage` guard is unsound: it excludes test files and measures only added production lines, so `.todo` stubs do not mechanically fail it. |
| 2 | Unguarded `captureException` inside Governor containment | ADDRESSED | T4b requires `logger.error` first and gives `captureException` its own swallowing guard. Test 27 explicitly exercises a throwing capture and requires the next candidate to run, preserving containment against the newly added telemetry path. |
| 3 | Latch-before-capture causes permanent silence | PARTIAL | Success-first latching fixes one transient failure, and three attempts bound spam. But three consecutive transient failures exhaust the lifetime counter; if Sentry then recovers while the kill switch remains off, the warning is permanently silent. |
| 4 | D3 said six over seven and omitted finding 2 | ADDRESSED | D3 now names seven round-1 findings, includes finding 2/test 21, adds the two round-2 tests, and consistently accounts for nine additions and 19→26→28. |

| # | severity | file:line | new defect | correction |
|---|---|---|---|---|
| 1 | high | `docs/superpowers/plans/feat-1009-refusal-ledger-write-path-plan.md:415` | The rejected CI audit is justified by a false claim. `scripts/diff-coverage.ts` explicitly excludes `__tests__` and `.test.*` files and examines only added production lines. It therefore cannot establish that promised tests execute; at T1, before production changes exist, it passes with “nothing to cover.” Later it can also pass from unrelated/existing coverage while test 26 remains `.todo`. | Add an independent syntax-aware gate outside the seven-file test set that rejects `.todo`/`.skip`/`.fails` call expressions and requires active test calls in all seven files, including test 26. |
| 2 | medium | `docs/superpowers/plans/feat-1009-refusal-ledger-write-path-plan.md:327` | `MAX_WARN_ATTEMPTS = 3` is a lifetime cap. The sequence throw, throw, throw, recover leaves `warned=false` and `attempts=3`, so thousands of later disabled decisions produce permanent silence—the same failure mode the fix claims to eliminate. | Use rate-limited retries with a cooldown/backoff rather than a lifetime attempt ceiling; latch only on success, and test three failures followed by recovery after the cooldown. |
| 3 | low | `docs/superpowers/plans/feat-1009-refusal-ledger-write-path-plan.md:427` | The seven-row map now has two consecutive Markdown headers/separators, leaving the table malformed. | Remove the obsolete two-column header and retain only `File | Tests | New?`. |

Out of scope — not triaged

- The pre-existing prose at plan line 474 still says round 1 found “six” additions, although D3 correctly establishes seven; it was not introduced by these four fixes.
- All “Turns green” assignments plus T1’s explicit ownership of test 26 cover tests 1–28 exactly once.
- The adversarial references match the intake titles.
- `.feature/intake.json` is byte-identical to the tracked mirror; both contain 28 entries.
- The deviations header, four table rows, four `## D<n>` sections, and four ACCEPT/zero RE-PLAN count agree.

VERDICT: REVISE