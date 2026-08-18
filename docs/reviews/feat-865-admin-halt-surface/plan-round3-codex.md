# feat-865 — plan review round 3 (codex, FINAL, verification-only)

codex thread id: `01a01308-efa1-7542-81f3-3a974d3b1c5d` (same session as rounds 1-2)

Scope: the four defects round 2 introduced, plus round-1 finding 13. Nothing else.

---

I’m using the read-only `verify-spec` workflow for exactly these five fixes. I’ll compare both intake copies byte-for-byte, inspect only the revised invariant/test/correction/count/citation passages, and verify the cited diff-coverage behavior without running the gate.

---

Four fixes are confirmed in the reviewed text, including byte-identical intake copies. One detail needs exact checking: D1 now clearly labels sibling-worktree evidence, but the written path is `../…`, not an absolute path as the verification prompt describes; I’m verifying that it resolves to the claimed uncommitted file and section.

---

| # | fix | landed? | evidence | residual |
|---|---|---|---|---|
| 1 | Qualify the pending-batch invariant as admin-arm only | Yes | Both intake copies are byte-identical. Intake line 34 explicitly says `ADMIN ARM ONLY` and acknowledges that `haltBatch` retains the hole, matching non-goal line 15. | None. |
| 2 | Pin all four non-actionable panel cases | Yes | Plan §3.4:223–229 names `pending`, `halted`, `closed`, and no batch. Intake test title at line 107 names the same four cases verbatim. | None. |
| 3 | Correct diff-coverage explanation and replace the meta-test | Yes | Plan §6:390–403 and deviations D2:101–110 correctly state that `scripts/diff-coverage.ts:62–65` excludes tests and lines 104–106 pass when no production lines changed. Both require recorded final evidence of `30 passed / 0 skipped / 0 todo`. | The replacement is sufficient: it proves executable red tests at Task 0 and proves none were skipped or converted to todos at the final gate without adding a permanent syntax test. |
| 4 | Correct `edge_cases` delta to 11 → 15 | Yes | HEAD’s prior intake has 11 edge cases; both current byte-identical intake copies have 15. Deviations D2:77 now records `11 → 15`. | None. |
| 5 | Qualify finding 13 as sibling-worktree evidence | Partially | Deviations D1:51–57 now identifies sibling-worktree evidence, provides a path that resolves to the claimed file, and the named section exists at line 418. | The path shown is relative, not absolute. More importantly, the claim that the counterpart file is “deliberately uncommitted” is false: it is tracked, present in sibling HEAD `156b3457…`, and clean in that worktree. |

## NEW DEFECTS INTRODUCED BY THESE FIVE FIXES

- Deviations D1:53 does not provide the claimed absolute path; it provides `../feat-860-ask-regeneration-surface/...`.
- Deviations D1:54–56 incorrectly says the sibling evidence is uncommitted to preserve `lastGreenGateSha == headSha`. The file and cited section are committed in the sibling branch and have no working-tree modification.

VERDICT: REVISE

---

Not running `scripts/verify-gate.sh`: this round explicitly prohibits it because it writes files. The verification is complete with `VERDICT: REVISE`.
