new file mode 100644
index 0000000000000000000000000000000000000000..88b8a192f76abf969902ea43f3fa25e8a2b8d4bb
--- /dev/null
+++ b//tmp/verify-spec-findings-feat-624-spine-lifecycle-fanout-plan.md
@@ -0,0 +1,24 @@
+# Round 2 audit findings
+
+Worktree clean at audit start. Intake arming/audit copies compare byte-identical.
+
+Candidate findings (pending final re-check):
+
+- Tenant audit integration incomplete: registering solicitation_outreach makes
+  unscoped close/redaction queries auditable, while the new health query already
+  targets registered agent_runs globally. Plan/intake omit tenant-scope-allowlist.ts.
+- T2 says append a new "B8", but the binding amendment already has B8 and its
+  ticket-consequences section still assigns outreach_id to #624.
+- Redaction partial index includes every sent_at NULL row because its predicate
+  is only body_redacted_at IS NULL; contradicted by the "stays small" claim.
+- Rollback omits restoring the three widened auto_approval_policies domain
+  constraints / persona-action pairing, and reverses the stated apply order
+  incorrectly.
+- Verification command list omits directly affected mandatory CI gates
+  ci:db-imports, ci:feature-surface, and ci:live-db-suites.
+- Intake's claim that cancelled is unreachable until #630 conflicts with #629's
+  binding to own halt/veto and T5's halted→cancelled terminalization.
+- Purge-lock work proves build-vs-purge contention, but binding D6d names the
+  real race as dispatch-vs-purge. Neither T8 nor the #630 handoff requires the
+  send worker to participate; an xact advisory held only in tx1 would also be
+  released across the provider call before tx2.

hook: Stop
hook: Stop
hook: Stop
hook: Stop Completed
hook: Stop Completed
hook: Stop Completed
tokens used
259,934
The revised plan still needs changes. The arming and audit intake copies are byte-identical, and the worktree is clean.

1. **High — Tenant-scope coverage remains incomplete and should fail CI.** Registering `solicitation_outreach` activates auditing, but `closeBatchIfSettled` retains a `batch_id`-only predicate, while archival and health checks are intentional global scans. The exact-match allowlist required for these queries is absent from both the plan and allowed edit surface. [Plan](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-624-spine-lifecycle-fanout/docs/superpowers/plans/feat-624-spine-lifecycle-fanout-plan.md:236), [intake](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-624-spine-lifecycle-fanout/.feature/intake.json:50), [audit](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-624-spine-lifecycle-fanout/scripts/ci/tenant-scope-audit.ts:406), [allowlist](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-624-spine-lifecycle-fanout/scripts/ci/tenant-scope-allowlist.ts:627).

2. **High — The revised NULL test contradicts the revised CHECK.** The CHECK correctly requires `sent` to have a NULL reason, but the plan mislabels `sent` as non-terminal while the intake promises to reject NULL reasons for “every terminal delivery status.” The binding spec defines `sent` as terminal. That promised test cannot pass alongside the intended schema. [Plan](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-624-spine-lifecycle-fanout/docs/superpowers/plans/feat-624-spine-lifecycle-fanout-plan.md:194), [intake](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-624-spine-lifecycle-fanout/.feature/intake.json:113), [binding terminal set](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-624-spine-lifecycle-fanout/docs/superpowers/specs/2026-07-28-send-mode-executor-approval-design.md:377).

3. **High — Finding 11 is only half-fixed.** `(topic, aggregate_id)` is now valid, but G1 still defers `QUEUE_NAMES` and both typed helpers. The binding migration checklist explicitly assigns those obligations to 091/#624; a rationale inside the lower-precedence plan does not amend that contract. [Plan](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-624-spine-lifecycle-fanout/docs/superpowers/plans/feat-624-spine-lifecycle-fanout-plan.md:59), [binding migration](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-624-spine-lifecycle-fanout/docs/superpowers/specs/2026-07-28-send-mode-executor-approval-design.md:1066), [binding checklist](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-624-spine-lifecycle-fanout/docs/superpowers/specs/2026-07-28-send-mode-executor-approval-design.md:1074).

4. **High — T8 protects construction, not the dispatch race D6d names.** The plan wires and tests build-versus-purge contention, while D6d requires preventing purge during a real send. The future provider call sits between two transactions with no lock held, and neither T8 nor a #630 handoff defines how purge is excluded during that gap. [Plan](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-624-spine-lifecycle-fanout/docs/superpowers/plans/feat-624-spine-lifecycle-fanout-plan.md:454), [D6d](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-624-spine-lifecycle-fanout/docs/superpowers/specs/2026-07-28-send-mode-executor-approval-design.md:415), [send-worker transaction shape](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-624-spine-lifecycle-fanout/docs/superpowers/specs/2026-07-28-send-mode-executor-approval-design.md:548).

5. **Medium — `closeBatchIfSettled` is not idempotent in the stated order.** It writes the terminal step before the `send_closed_at` CAS, yet `appendRunStep` always appends. A serialized second caller can therefore add a duplicate `send_batch_closed` receipt even though the timestamp and terminal transition no-op. Require an early closed check or gate subsequent writes on a successful CAS. [Plan](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-624-spine-lifecycle-fanout/docs/superpowers/plans/feat-624-spine-lifecycle-fanout-plan.md:362), [appendRunStep](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-624-spine-lifecycle-fanout/src/lib/agents/run-spine.ts:294).

6. **Medium — The widened veto CHECK admits `reply/posting/60`.** D19’s dial check does not constrain the Reply veto window. After globally widening to 15/30/60, the existing Reply lane can store 60 despite its current 15/30 contract and D20 assigning 30/60 to Solicitation. [Plan](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-624-spine-lifecycle-fanout/docs/superpowers/plans/feat-624-spine-lifecycle-fanout-plan.md:240), [current constraint](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-624-spine-lifecycle-fanout/supabase/migrations/074_trust_dial_veto_window.sql:54), [D20](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-624-spine-lifecycle-fanout/docs/superpowers/specs/2026-07-28-send-mode-executor-approval-design.md:975).

7. **Medium — Required FK-action indexes are missing.** The planned index inventory has no business-leading, contact-leading, or non-NULL `agent_run_id` index. Cascading business/contact deletes and the 5,000-row agent-run archival sweep can repeatedly scan all outreach rows. Migration 088 explicitly added these RI-support shapes for asks. [Plan indexes](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-624-spine-lifecycle-fanout/docs/superpowers/plans/feat-624-spine-lifecycle-fanout-plan.md:220), [outreach FKs](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-624-spine-lifecycle-fanout/docs/superpowers/specs/2026-07-28-send-mode-executor-approval-design.md:295), [088 precedent](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-624-spine-lifecycle-fanout/supabase/migrations/088_solicitation_batch_executor.sql:206).

8. **Medium — The B4 ownership amendment remains internally inconsistent.** T2 says to append it as B8, but B8 already exists. It also leaves the binding consequences section assigning `outreach_id` to #624, producing two conflicting ownership statements. [Plan](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-624-spine-lifecycle-fanout/docs/superpowers/plans/feat-624-spine-lifecycle-fanout-plan.md:298), [existing B8](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-624-spine-lifecycle-fanout/docs/superpowers/specs/2026-07-28-send-mode-cross-spec-amendments.md:173), [current #624 assignment](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-624-spine-lifecycle-fanout/docs/superpowers/specs/2026-07-28-send-mode-cross-spec-amendments.md:210).

9. **Medium — The corrected rollback is still incomplete.** It does not restore the pre-091 persona, action-class, and veto-window CHECKs. Its claim that `cancelled` remains unreachable until #630 is also false once #629’s bound halt/veto path ships. [Intake rollback](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-624-spine-lifecycle-fanout/.feature/intake.json:139), [pre-091 checks](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-624-spine-lifecycle-fanout/supabase/migrations/074_trust_dial_veto_window.sql:48), [#629 binding](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-624-spine-lifecycle-fanout/docs/superpowers/specs/2026-07-28-send-mode-executor-approval-design.md:1167).

10. **Medium — Verification remains incomplete.** The commands omit the binding-required `ci:db-imports` gate, and the test inventory has no named coverage for approval/halt NULL pairings, `attempt_no > 0`, or the promised `send_batch_closed` persona/detail contract. [Commands](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-624-spine-lifecycle-fanout/.feature/intake.json:121), [binding gate](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-624-spine-lifecycle-fanout/docs/superpowers/specs/2026-07-28-send-mode-executor-approval-design.md:1080), [planned constraints](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-624-spine-lifecycle-fanout/docs/superpowers/plans/feat-624-spine-lifecycle-fanout-plan.md:171), [test inventory](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-624-spine-lifecycle-fanout/.feature/intake.json:79).

11. **Low — The redaction index is not actually small.** PostgreSQL B-trees include NULL keys, so `(sent_at) WHERE body_redacted_at IS NULL` permanently indexes every never-sent row. The predicate should also require `sent_at IS NOT NULL`. [Plan](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-624-spine-lifecycle-fanout/docs/superpowers/plans/feat-624-spine-lifecycle-fanout-plan.md:233).

The constructBatch flip itself preserves the ownership CAS and removes the batch-row/advisory ABBA edge. The `IS TRUE` mechanics, widened `deriveRunDisplayState` caller, STEP_PERSONA key, no-parent guard, bounded archival CTE, attempt uniqueness, lifecycle pairings, dependency edge, citation corrections, and intake byte identity otherwise check out.

VERDICT: REVISE
