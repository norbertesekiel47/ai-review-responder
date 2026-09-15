# Run E review corrections

The independent review wave examined committed candidate `890eea76c8c04b8d2acfcc73a895ec3112560e38` against `30896acbcb2ee127131504e531f230fcfc7e4409`. Spec/correctness requested one correction; database review approved; standards review approved with one comment nit. Root accepts both source-review findings.

| ID | Root disposition and correction | Evidence |
|---|---|---|
| E-SC1 | ACCEPT, fixed. Every proposal returned by a card write now overrides an older timeline row by ID, including a 409 response. A stale Restore offers Refresh plan bound to its source receipt. | Two component regressions first failed because Apply remained visible; both pass after the fix. Cases cover preparation in the current session and a pending Restore loaded after refresh. |
| E-M1 | ACCEPT, fixed. Catalog test title and narrowing comments now include prepare operations. | Existing four-kind assertion is unchanged. |
| E-RT-P1-1 | ACCEPT, fixed. Refusal subject-map assertion checks exact membership without incidental insertion order. | Distinct UUID and exact per-reason ledger identity assertions remain. |
| E-RT-P1-2 | ACCEPT, fixed. Plan completion and Apply precedents use full source paths and named functions instead of stale line numbers. | `completeTurnFenced` and `applyProposal` own the described seams. |
| E-RT-P1-3 | ACCEPT, correction drafted; not applied. The button Restore invariant needs its own matching alert rule. | Root confirmed the Restore endpoint emitter differs from the existing worker and Apply filters. `/private/tmp/run-e-restore-alert-proposed.patch` adds all rule facets and a response procedure; the alerting path awaits the scoped second surface amendment. No rule configuration or delivery is claimed. |

Focused validation: four suites, **44 tests passed**, including all RestoreWorkflow and useProposalWrites cases, catalog tests and refusal completion tests. RED reproduction: `/private/tmp/run-e-timeline-stale-red.log` (two intended failures). GREEN: `/private/tmp/run-e-review-corrections-tests.log`. Independent bounded follow-up: `spec-correctness-round-2.md`, APPROVE. These logs do not substitute for the pending updated full gate, second adversarial pass, staging or browser evidence.

## Preserved first-pass evidence and sequencing

The red-team runner stopped after exactly 30 supervised launches: 15 green individual baselines and 15 assertion-detected mutants. Root finalized all process groups and restored the clean pinned tree before any correction. The final report is INCOMPLETE_BUDGET: 2,113 inventory rows, 15 killed, 707 skipped-budget and 1,391 excluded. The 722 in-scope test cases require at least 1,414 additional launches to finish the unmeasured set; this is not an authorization to run them.

The intake mistakenly allowed the unhashed red-team directory; the checker derives `docs/reviews/red-team/codex-owner-operator-run-e-eb15ab/`. The verifier therefore wrote original round-1 reports only to `/private/tmp/run-e-round1-report/`. Root began the already authorized code corrections after finalization while the verifier finished read-only reporting from the pinned commit. This differs from canonical report-commit-before-fix ordering because that directory correction needs a second surface amendment. No original measurement or source identity was rewritten.

Frozen final artifact SHA-256: JSON `b869b052d2f39574c51418e2a608f136c43e375853e3692385921f95c2259a0c`; Markdown `42cc8719dba7356dac5e626b6d606628789b5d24698de4e7998cbcb138b0cc46`. Preserve those bytes and the census chronology in permanent history when the path amendment is approved. No extra E verifier budget, additional round, accepted-risk finding or provider call is granted by this correction record.
