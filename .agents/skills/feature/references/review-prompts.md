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

## Dispatching a Codex round

In native Codex, use the available subagent tools for independent reviews and
record the returned agent ID. Resume that same agent only to verify its prior
findings. Use `review-log.mjs attach-review --id <id> --report <report.md>`
after completion. Use the companion's `attach-codex --job <id>` only for a
review actually dispatched through the Claude codex-companion integration.
Never select a job with `--latest`. The CLI examples below are a fallback
when native subagent coordination is unavailable.

Measured from the feat/1008 plan rounds (`~/.codex/sessions`, 2026-08-29):
**7,272,916 input tokens for 56,233 output** across two waves — 129:1 — on one
small feature. Codex itself was fast (waves of 6 m 55 s and 5 m 19 s). The cost
was work repeated, not work done. Three rules fix that without removing a
single question from the review.

**1. Never dispatch the same brief twice.** In both waves the lead session
cloned itself three times with a near-identical prompt (3,937 chars ×3, then
4,763 ×3). Three copies of one question return one question's worth of
findings and cost three times the tokens, and the wave's wall clock becomes the
slowest of the three rather than the fastest.

Fan out only where the questions differ, and say so in the prompt:

```text
Do not spawn sub-agents that repeat this brief. If you delegate, each
delegate must receive a DIFFERENT question from the list below.
```

For a plan round the three questions are already distinct, so use them:

- **failability** — can this eval pass while the feature is still wrong?
- **cited artifacts** — does every file, section and SHA the plan cites resolve
  at current HEAD?
- **invariants** — which declared invariant, tenant boundary or authority gap
  does this plan leave unprotected?

That is the same wall clock and strictly more coverage than three clones.

**2. Resume for a verification-only round — and ONLY for that.** Wave 2 started
cold and re-derived everything wave 1 had already read: the same 13 `exec`
calls, another 1.08 M input tokens. The round was checking whether ITS OWN
prior findings were addressed, so its round-1 context is precisely what it
needs:

```bash
codex exec resume <session-id> "<the findings-and-fixes delta>"
```

Record the session id when round 1 returns — the workflow already asks for it
in the handoff doc, and this is what it is for.

Never resume for round 1, and never for an independent axis. A resumed session
is anchored on its earlier conclusions. That is correct for verification, where
the reviewer should be checking its own claims, and it destroys the
independence an axis exists to provide.

**3. Hand it a brief, not a repo pointer.** Sessions spent 10–17 `exec` calls
rebuilding context the root already held: `sed` over `.claude/CLAUDE.md`, two
repo-wide `rg` sweeps, `gh issue view` (twice in one session, once as an
approval retry), `migrations-log.md`, the plan with line numbers. Under
`approvals_reviewer`, each external call also costs an approval round-trip.

Write the brief to a file — plan, the cited excerpts, the diff, the fork SHA —
and open the prompt with:

```text
The brief below already contains the plan, the cited excerpts and the diff.
Do not re-read them from the repository. You keep full read access: use it
to CHECK a claim or follow a lead the brief does not cover, never to
re-derive what the brief already gives you.
```

Read access stays open on purpose. The cited-artifact check needs the
filesystem, and a reviewer that cannot look beyond its brief cannot discover
anything. The rule removes re-derivation, not discovery.

**Do not touch `approvals_reviewer`.** The short 13-event sessions beside every
round are that reviewer assessing each tool call (`{"risk_level":"low",
"outcome":"allow"}`). They are a security control, they cost about 5 seconds,
and they are not review fan-out. An earlier reading of these logs mistook them
for redundant sub-agents; they are not.

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
