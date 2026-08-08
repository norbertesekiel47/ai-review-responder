I’ll use the `verify-spec` workflow again, limited strictly to the round-one findings and the fixes recorded in the revised plan/intake/deviations file. I’ll verify exact titles, instructions, dependencies, and referenced test behavior without editing or running mutating gates.
The verification skill calls for parallel checks at this size, so I’m splitting only the accepted fixes, eval changes, and rejection rationale. I will not inspect unrelated unchanged plan areas or treat newly noticed unrelated issues as verdict-affecting.
## Verification

| Round-1 finding | Addressed? | Evidence or what is still wrong |
|---|---:|---|
| 1. Retarget failover integration test | Partial | Intake now allows the file; T1 Step 2b retargets its import, calls, title, and persisted-value assertion; T2 runs it. However, the file’s header comment at line 4 also names `markOutboxOwnerUnreachable`. T1 does not update it, so T2’s required `rg` still finds a straggler while T2 says it must not touch that file. |
| 2. Retarget all seven existing assertions | Yes | T1 enumerates actual lines 175/187/199/209/240/247/309, requires `rg`, and preserves the plain mock entry at line 83. A stale downstream count remains under introduced defects. |
| 3. Correct spec §5.3 contradiction | Yes | T4 Step 2 explicitly replaces the false application-enqueue claim and acknowledges that a database insertion trigger could cover manual SQL. |
| 4. Correct stale helper names in authoritative docs | Yes | T4 Steps 3–4 explicitly replace `markOutboxCompleted(tx, …)` in both `CONTEXT.md` and `.claude/CLAUDE.md`. |
| 5. Remove bare integration-test literals | Partial | All live assertions now use `OUTBOX_COMPLETION_REASON`. The new wire-value test intentionally uses literals, but the amended intake still forbids bare literals “at any site, tests included” without recording that exception. |
| 6. Add `{T3,T4} → Gate` | Yes | Present in the dependency graph at plan lines 75–79 and repeated in the Gate at 979–985. |
| 7. Remove false “re-derivable from businesses” claim | **No** | T3, `CONTEXT.md`, and intake edge cases are corrected, but Task 2’s proposed vocabulary comment still says the state is recoverable from `businesses.import_decision + import_offer_expires_at` at lines 595–596. |
| 8. Qualify legacy NULL ambiguity | Yes | ADR instructions add both the deployment-time bound and the explicit pre-deployment NULL caveat. Intake carries the same caveat. |
| 9. Correct immutable-migration argument | Yes | §1 concedes `CREATE OR REPLACE` and frames the objection as duplicate spelling, unenforced drift, and two-project deployment coupling. T4 requires the ADR to preserve that strength. |
| 10. Correct ADR 0010 structure | Yes | T4 lists ADR 0010’s actual headings and explicitly says ADR 0016 adds `Alternatives considered`. |
| Three added promised tests | Yes | All appear verbatim in the amended intake and plan. The wire-value contract, live-Postgres owner CAS/value, and live-pending persisted marker assertions are substantive. |
| Transaction test retitle | Yes | The revised title and comment accurately limit the unit evidence to invocation while the transaction callback is open; the existing forced-race test remains the real-Postgres safety pin. |
| Folded assertions | Yes | `completed_at`, requested ID bind, legacy-path dispatched status, NotificationWorker ID/reason/attempt tuple, and generic-completion reason absence are all present. Two comments around these fixes need correction below. |

## Defects introduced by fixes

| Defect | Evidence |
|---|---|
| Revised test counts are internally inconsistent | Task 1 still says 11 instead of 14; Step 1 says “these three” but shows four tests; Step 4 says three live-DB titles but shows four; T3 says four pre-existing block tests despite the corrected inventory of five block cases/seven assertions. |
| Wire-value exception contradicts the amended intake | Plan lines 104–107 permit the compatibility-test literals; the intake invariant still says no bare literal at any site, tests included. |
| The failover retarget leaves a textual straggler | The existing integration-suite header at line 4 names the deleted helper, so T2’s exact `rg` command will fail unless T1 Step 2b also updates that comment. |
| Integration samples use a nonexistent logger | Plan lines 470, 494, and 535 pass `testLogger`, while lines 548–551 correctly state the suite defines `silentLogger` and incorrectly claim all samples use it. |
| New pending-test rationale misstates migration 100 | Lines 505–507 call a pending row with a live deadline the migration-100 default population. The default is pending with a NULL deadline; the test itself correctly exercises live pending. |
| New `completed_at` rationale names the wrong readers | The comment says `NotificationFailoverPoller` and `checkOwnerUnreachable` order/window on `completed_at`; both use response/outbox `created_at`. Keeping `completed_at` is correct, but that explanation is not. |

## Rejections

- Requested-row per-caller test — **sound**: the unchanged shared fragment has direct ID coverage, and the revised helper test also checks the requested ID bind.
- Terminal-row per-caller test — **sound**: shared-fragment tests pin `status = 'dispatched'` on guarded and legacy paths, now reinforced in the generalized-helper property.
- Mock-sql sentinel surgery — **sound**: the forced-race test’s guard client is `max: 1`; using the outer client inside its reserved transaction would self-starve before reaching the required outbox-lock topology.
- `subagent-driven-development` availability — **sound as a rejection of the round-one artifact claim**: it is harness-owned, so absence from repository/Codex skill directories does not establish absence from the intended Claude harness.

## Appendix — unrelated pre-existing observation

The retargeted NotificationWorker test destructures `reasonArg` without using it. That existed in the round-one plan and is therefore outside this verdict, but it may trip the unused-variable lint rule.

VERDICT: REVISE

1. Correct the remaining false recovery claim in Task 2’s vocabulary comment.
2. Add the failover integration header-comment rename to T1 Step 2b.
3. Record the wire-contract-test literal exception in the intake.
4. Replace all `testLogger` samples with `silentLogger`.
5. Fix the four stale counts and the two inaccurate newly added test comments.
Gate evidence is not applicable to this read-only plan verification. No implementation was performed, and running the gate could mutate generated artifacts or test state. No files were changed.
