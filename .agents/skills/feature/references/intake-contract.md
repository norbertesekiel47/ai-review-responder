# Intake contract

Use one strict JSON object. Do not add prose fields or unknown keys.

```json
{
  "version": 1,
  "size": "standard",
  "risk": "normal",
  "risk_reasons": [],
  "surface": "backend",
  "db_touching": false,
  "goal": "One observable outcome using CONTEXT.md terms",
  "non_goals": [],
  "user_visible_behavior": [],
  "invariants": [],
  "edge_cases": [],
  "existing_patterns_to_follow": [],
  "test_seams": [],
  "allowed_edit_surface": [],
  "tests_to_add": [],
  "verification_commands": [],
  "estimated_prod_lines": 0,
  "estimated_test_lines": 0,
  "dependencies_added": [],
  "rollback_plan": "",
  "observability": [],
  "required_approvals": [],
  "open_questions": []
}
```

## Field rules

- `size` describes implementation breadth; `risk` describes failure impact.
  Never combine them into one classification.
- `risk_reasons` must name why `risk=high`; do not merely repeat `high`.
- `goal` is one observable outcome, not an implementation plan.
- `non_goals` excludes tempting adjacent work.
- `user_visible_behavior` names observable behavior changes. For an internal
  change, name the observable operational or developer behavior instead.
- `invariants` names what must remain true across the change.
- `edge_cases` contains resolved scenarios, not unanswered questions.
- `existing_patterns_to_follow` uses repository paths and named modules.
- `test_seams` names public interfaces through which behavior is verified.
- `allowed_edit_surface` is the smallest honest glob set. Never use `*`, `**`,
  or `**/*`.
- `tests_to_add` contains exact test titles, each tied to behavior, an
  invariant, or an edge case. Leave empty only when tests are inapplicable and
  `verification_commands` supplies deterministic evidence.
- `verification_commands` contains non-destructive commands beyond the
  repository gate. Never put schema reset, deployment, or production commands
  here.
- Estimate production and test churn separately. Exclude workflow artifacts.
- `dependencies_added` lists package names. When non-empty, include the
  applicable `package.json` and `pnpm-lock.yaml` in the edit surface and write
  `.feature/deps-justification.md` before manifest edits.
- `rollback_plan` is mandatory for database, externally visible contract, and
  high-risk operational changes.
- `observability` names the signal that distinguishes success from silent
  failure after release. It may be empty for purely local changes.
- `required_approvals` names authority boundaries such as `commit`, `push`,
  `staging_deploy`, `remote_migration`, `merge`, or `production_flag_flip`.
  Listing an approval does not grant it.
- `open_questions` must be empty before setup.

## Question policy

Ask only when the answer materially changes behavior, architecture, risk,
scope, or an external action. Resolve repository-discoverable questions from
source. State reversible assumptions in the intake and continue. For a
ticket-seeded run, preserve parent decisions unless new evidence invalidates
them.

## Artifact policy

- Trivial: do not create feature paperwork unless the user requests it.
- Small: keep only the validated intake and machine state.
- Standard: keep the intake and plan; create deviations only when needed.
- High: keep the standard artifacts plus durable evidence for accepted review
  findings and operational risks.
- Create a handoff only when work actually pauses or changes tasks.
- Create an ADR only for a hard-to-reverse, surprising decision arising from a
  real tradeoff.
