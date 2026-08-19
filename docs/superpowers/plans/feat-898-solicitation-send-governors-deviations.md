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

## plan round 1 — codex unavailable; orchestrator ran the review

**Found:** Three `codex exec` attempts failed to deliver a verdict — the first hit the
10-minute foreground cap mid-turn (thread `01a01908-f132-7f70-8a67-b83731ff035a`), the
second stalled at 141 lines with no progress for 2+ minutes, the third emitted zero
lines in 3 minutes (stderr showed repeated
`codex_models_manager: failed to renew cache TTL: missing field base_instructions`).
The codex CLI is wedged in this environment, not merely slow.

**Did:** Ran round 1 myself, split in two.
 (a) Cited-artifact check — mechanical, done by grep: all 19 symbols, 7 precedent
     files, both runbooks (§5/§6/§7 at lines 207/243/280) and 091's
     one_live_per_ask + daily_send_cap resolve. **One defect found and fixed**: the
     plan cited a non-existent `@/lib/shared/uuid`; the repo uses
     `import { v7 as uuidv7 } from 'uuid'` (audit/log.ts, notifications/delivery.ts).
     The plan's own fallback to `randomUUID()` was also wrong — that is UUIDv4, which
     breaks the time-ordered-PK convention. T5 step 2's branch is now closed.
 (b) Eval-first critique — can the 27 tests pass while the feature is wrong? Four
     probes held (LEAST semantics vs `() => 10`; MIN_SENDS boundary; asymmetric vs
     cohort window; ON CONFLICT inference, which the idempotence test de-risks).
     **Three holes found**, all closed by new tests:
       1. classifyBreach precedence was unobservable — no test breached both
          thresholds at once, so a reversed implementation passed everything.
       2. countAccountDispatchAttemptsToday never proved it filters on account_id —
          the fixture had one tenant, so dropping the filter changed nothing.
       3. resolvePlatformDailyCap never exercised the unsafe-integer branch.

**Blast radius:** `tests_to_add` 27 → 30 in BOTH intake copies (verified identical);
`estimated_test_lines` 1300 → 1400. Per the workflow this is a deviations entry, NOT a
surface amendment — the amendment budget is untouched at 0 of 2.

**Invalidates a locked decision?** no.

**Verdict:** ACCEPT (self-triaged at step 3; re-confirm at step 6).
