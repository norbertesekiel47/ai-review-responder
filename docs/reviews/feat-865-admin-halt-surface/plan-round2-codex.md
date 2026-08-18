# feat-865 — plan review round 2 (codex, VERIFICATION-ONLY)

codex thread id: `01a01308-efa1-7542-81f3-3a974d3b1c5d` (same session as round 1)

Brief: `scratchpad/codex-865-plan-round2-brief.md` — findings-and-fixes delta only.

---

I’m using the read-only `verify-spec` workflow again, limited strictly to the 14 round-one findings and defects introduced by their fixes. I’ll compare the revised plan/intake mechanically, then re-check the two rejected tests, the admin-only pending guard, the cited code facts, and the five-step transaction order. I will not run the write-producing gate.

---

The repository is dirty only in the review artifacts under inspection; I’m auditing that working-tree state, not claiming HEAD behavior. The skill calls for parallel checking above roughly 15 claims, so I’m separating the 30-title/file-routing comparison from the 14-finding remediation audit, while I personally verify the rejected reasoning and transaction/lifecycle fixes.

---

The revised test matrix is structurally consistent at first inspection: 13 domain integration + 3 read-model + 3 unit/property/type + 7 route + 3 panel + 1 page-source equals 30. I’m now checking whether the rejected meta-test rationale is actually supported by the diff-coverage implementation—particularly whether changed test files are coverable inputs at all.

---

| # | round-1 finding | addressed? | evidence | residual risk |
|---|---|---|---|---|
| 1 | `.todo` allowed the eval to pass | Partially | Plan §4:247–258 now prohibits `.todo`/`.skip` and requires a recorded 30-failure red run for the correct reasons. Rejecting a permanent syntax-marker test is reasonable. | The claimed diff-coverage backstop is false: `scripts/diff-coverage.ts:5–6,62–65` excludes tests and lines 104–106 pass when there are no changed production lines. Require final evidence of 30 passed, zero skipped, or another non-permanent enforcement check. |
| 2 | Pending-batch/schema-builder collision | Partially | D11 and §3.1:142–151 correctly refuse `pending` in `adminHaltBatch`; intake test 13 pins it. Keeping the existing owner arm unchanged is a defensible scope boundary, and §7 records a mandatory follow-up. | The intake invariant at line 34 incorrectly claims all unbuilt batches are never latched, contradicting the owner-arm non-goal at line 15. The new pending-panel behavior is also untested. |
| 3 | Inert or unsafe UI could pass | Mostly | Intake tests 14–16 and 27–30 cover safe projection, counts, positive submission, terminal/empty states, sending copy, and sequential page wiring. | The D11-introduced `pending` UI state is missing from the negative panel test. |
| 4 | Spine cardinality and settlement ownership uncovered | Yes | Intake tests 2–3 and 8–9 cover second-spine cardinality, live sending-parent behavior, delegation, direct-update prohibition, and the parentless join. Plan §4:280–283 specifies discriminating assertions. | None identified. |
| 5 | Transaction rollback and audit ordering uncovered | Yes | Intake tests 6–7 and plan §4:271–279 require rollback, call order, and shared transaction identity. Plan §3.1:92–111 orders CAS → cancel → audit → spine → join. | None identified. |
| 6 | Wrong property invariant and unpinned type surface | Yes | Plan §4:285–294 separates exact type/export checks and spends the property test on arbitrary outreach-status multisets plus fixed-point/cardinality behavior. | None identified. |
| 7 | Route could ignore a supplied reason | Yes | Plan §3.3:196–202 and intake test 22 require 400 for `reason`, `haltReason`, and `halt_reason`, with no domain call. | None identified. |
| 8 | `sending` misrepresented as cancellable | Yes | Plan §3.2:153–188 splits `cancellableCount`, `sendingCount`, and `sentCount`; §3.4:223–227 requires explicit UI copy. | None identified. |
| 9 | Missing route, audit, flag, and tenant edge coverage | Yes | Intake tests 5, 14–16, and 20–26 cover exact audit data, tenant scoping, AAL2, non-admin, spoofed fields, note bounds, cross-origin, all result mappings, and flag-off behavior. The route-level replacement for the rejected module flag test is sound because it can catch an accidental route gate. | None identified. |
| 10 | Incorrect glossary spelling | Yes | Plan lines 10–13 exactly match `CONTEXT.md`: **Halt latch**, **Batch state**, **Send batch parent**, **Settled batch**, **Outreach row**, **Ask**, and **Lazy child**. | None identified. |
| 11 | D2 misattributed body sourcing to the AAL2 audit | Yes | D2 now cites `resolve-actor.ts`; its lines 10–14 and 61–75 confirm body sourcing. `admin-aal2-audit.ts:11–19` confirms that audit enforces AAL2 reachability and page parity only. | None identified. |
| 12 | D3 misstated canonicalization behavior | Yes | D3 now matches `approval.ts:95–98,112–135,402–408`: the locked query is casing-independent, while public entry points canonicalize for later text-key consumers. `outreach.ts:321` also lowercases defensively. | None identified. |
| 13 | Unresolvable sibling-worktree citation | No | The referenced section exists only in the sibling worktree, at `../feat-860-ask-regeneration-surface/docs/superpowers/plans/feat-860-ask-regeneration-surface-deviations.md:418`. | Deviations lines 51–53 still use the same bare filename and do not qualify it as sibling-worktree evidence. |
| 14 | Planned-new artifacts absent | Yes / not yet applicable | Plan §6:394–395 correctly makes their existence a branch-review obligation. | None pre-implementation. |

The 30 intake titles and Task 0 routing agree exactly: 13 domain integration, 3 read-model, 3 unit/property/type, 7 route, 3 panel, and 1 page-source test. The checked-in and `.feature` intake copies are byte-identical.

The revised D2, D3, §3.2, glossary spellings, and five-step transaction ordering are factually correct. Audit failure rejects the surrounding `sql.begin` callback, rolling back the CAS and cancellations; all `agent_runs` access remains after the advisory and batch-row locks.

## NEW DEFECTS INTRODUCED BY A FIX

- Intake invariant line 34 must be qualified as admin-only. As written, it contradicts the deliberate owner-arm non-fix.
- Missing test: `the admin halt panel shows no stop control for a pending batch, a halted batch, a closed batch, or when there is no batch` — assert all four non-actionable states.
- Plan §6:384–385 and deviations D2:92–95 incorrectly claim diff coverage mechanically rejects all-`.todo` tests. It excludes test files and can pass with nothing to cover.
- Deviations D2:73 says `edge_cases` changed from 12 to 15; the actual delta is 11 to 15.

## Unrelated observations (not triaged)

- `outreach.ts:309–315` says the send parent is resolved before the settled predicate, but the implementation tallies and returns `not_settled` at lines 350–359 before looking up the parent at lines 364–375. This predates the reviewed fixes.

VERDICT: REVISE

---

Not running `scripts/verify-gate.sh`: the user explicitly prohibited it because it writes files. The round-two review is complete and remains `VERDICT: REVISE`.
