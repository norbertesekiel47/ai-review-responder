# Deviations — feat-898-solicitation-send-governors

Every entry here is, by definition, something the plan did not anticipate — the
highest-signal bug source on the branch. Step 6 reads this file end to end before
any review agent is dispatched and logs a one-line **ACCEPT** or **RE-PLAN** verdict
against each entry.

**Subagents: append, never rewrite.** One entry per surprise, using the template
below. Do not dump context into the orchestrator instead — this file is where an
unanticipated fact goes.

```
## <task id> — <one-line title>

**Found:** what the plan said, and what the code/schema/tooling actually is.
**Did:** the adaptation made, with the exact file and symbol.
**Blast radius:** what else this touches, or "none".
**Invalidates a locked decision?** yes/no — if yes, STOP and report; abort criteria apply.

**Verdict:** _(orchestrator fills this in at step 6: ACCEPT or RE-PLAN)_
```

Two branches the plan deliberately left open, because they cannot be resolved without
running a command. Neither is a placeholder; each states its check and both outcomes.
**Record the outcome here either way** — including "checked, no change needed", so a
resumed session does not re-investigate:

- **T2 step 5** — whether `TABLE_DISPOSITIONS` is exhaustive over the live schema. If it
  is, `solicitation_send_breaker` needs a `not_applicable` entry in
  `src/lib/account-offboarding/table-disposition.ts`, which is **outside**
  `allowed_edit_surface` and needs a surface amendment first.
- **T5 step 2** — the repo's UUIDv7 helper path. If none exists, use `randomUUID()` from
  `node:crypto` (invariant #10). **Do not add a dependency**: that needs
  `.feature/deps-justification.md` plus `package.json` and `pnpm-lock.yaml` in the edit
  surface, none of which this feature has.

## Surface amendment log

Only `allowed_edit_surface` changes count toward the 2-amendment abort budget.
`tests_to_add` retitles and `verification_commands` corrections are ordinary entries above.

| # | Date | Change | Auto-approved or owner sign-off |
|---|---|---|---|
| — | — | none yet | — |
