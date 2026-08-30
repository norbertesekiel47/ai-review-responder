# Review prompts

Pin the merge-base and provide reviewers the exact diff command, intake path,
spec/plan paths, applicable standards, and relevant deviations. Reviewers are
read-only: they must not edit, commit, or run external mutations.

Run independent axes in parallel when both are required. Do not expose one
reviewer's conclusions to another.

Log every round, finding, and triage verdict as it happens. Read
[progress-and-live-view.md](progress-and-live-view.md) for the commands. The
axis names in that file are these axes; keep them in step.

## Finding checklists — every axis

Before dispatching an axis, check for
`docs/reviews/finding-checklists/<axis>.md`. When it exists, include it in
the reviewer's prompt with this instruction:

```text
The attached checklist lists defect classes a review on this axis ACCEPTED
on a real branch in this repository. Check the diff against every line
before reporting your own findings.
```

The file is committed and cross-feature: `review-log.mjs triage --verdict
ACCEPT` appends to it automatically, so each accepted finding hardens every
later review on its axis. Prune a line only when the defect class can no
longer occur (the seam it named is gone).

## Plan skeptic — high risk only

```text
Read the approved intake and proposed plan. Act as a read-only plan skeptic.
Challenge assumptions, missing failure/recovery modes, unnecessary interfaces,
tenant or authorization gaps, and simpler approaches. Check every objection
against repository source. Return only findings you hold with at least 80%
confidence. Each finding must cite the plan section and repository evidence,
state the failure scenario, and propose the smallest correction. End with
VERDICT: APPROVED or VERDICT: REVISE. Do not edit files.
```

The root increments the durable plan-review counter before every round. Stop
after three rounds and surface unresolved disagreement to the user.

## Spec and correctness

```text
Review the branch diff against the intake and spec from the fixed merge-base.
Check every user-visible behavior, invariant, edge case, promised test, test
seam, non-goal, and allowed path. Find missing behavior, incorrect behavior,
scope creep, invalid assumptions, and caller-side regressions. Report only
findings at least 80% confident. For each, provide severity, file:line,
contract field, repository evidence, and a concrete failure scenario. Do not
edit files. Put uncertain observations in a separate non-actionable appendix.
```

## Standards and maintainability

```text
Review the branch diff from the fixed merge-base against AGENTS.md,
.claude/CLAUDE.md, applicable ADRs, and the nearest repository precedents.
Evaluate module depth, seam placement, locality, duplication, speculative
generality, error handling, test coupling, naming, and dependency growth. Skip
issues already enforced by green tooling unless the diff circumvents the
tool. Report only findings at least 80% confident. For each, provide severity,
file:line, the named violated standard or smell, evidence, and the smallest
maintainable correction. Do not edit files.
```

## Conditional risk axes

Activate only those implicated by `risk_reasons`:

- **Security/authorization:** trust boundaries, token handling, confused
  deputy paths, server/client authority, denial and replay scenarios.
- **Database/tenancy:** tenant predicates, transaction boundaries, migration
  compatibility, rollback, locks, retries, and partial application.
- **Billing:** source-of-truth amounts, idempotency, reconciliation, rounding,
  status transitions, retries, and duplicate events.
- **Async/operations:** outbox atomicity, idempotency, poison work, timeout and
  retry bounds, observability, recovery, and kill switches.
- **UI/accessibility:** keyboard and screen-reader behavior, loading/error/empty
  states, responsive layout, and server-authoritative state.

Use the applicable contract fields and project invariants in the prompt. Do
not run every risk axis “just in case.”

## Root triage

For every actionable finding:

1. Open the cited source and contract field.
2. Reproduce the scenario or prove the violated standard applies.
3. Record `ACCEPT` or `REJECT` with one evidence-based reason, in the
   transcript as well as in the report.
4. Fix accepted findings in the root context or give a bounded edit lease.
5. Rerun the verified gate after any change.

Do not fix a finding merely because a reviewer sounded confident.
