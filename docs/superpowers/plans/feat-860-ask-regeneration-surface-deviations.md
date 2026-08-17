# feat-860 — deviations

Entries are things the plan did not anticipate. Each is read back end to end at
step 6 and given an ACCEPT / RE-PLAN verdict before any review agent sees it.

---

## D1 — surface overlap with `codex/859-tenant-scope-subqueries` (owner-decided at step 2)

**When:** step 2 (SETUP), reported by `scripts/feature-setup.sh`.

**What:** `feat-860`'s surface glob `src/lib/solicitation/*` overlaps two armed
worktrees. Only one overlap is real:

| Worktree | Files | Real collision |
|---|---|---|
| `codex-858-close-batch-case` | `src/lib/solicitation/outreach.ts` | **No** — covered by the glob, absent from this feature's planned file set |
| `codex-861-requests-load-copy-test` | `requests-client.test.tsx` | **No** — one test file this feature does not touch |
| `codex-859-tenant-scope-subqueries` | `src/lib/solicitation/approval.ts`, `src/lib/solicitation/batch-view.ts` | **Yes** |

The #859 collision is not merely a shared filename. That ticket fixes the
`ci:tenant-scope` parser and **reverts the #629 workarounds in the exact
statements this feature extends**: it collapses `lockBatchForAction`'s
two-statement split back into one correlated form, and `approveBatch`'s
readiness anti-join back into `NOT EXISTS`. Verified in its working tree
(uncommitted, +265/−183 across `approval.ts`, `batch-view.ts` and their tests).

`lockBatchForAction`'s signature and return type are unchanged by #859, so
`requestAskRegeneration` calling it is unaffected. The genuine conflict surface
is the file-header prose and the SQL hunks themselves.

**Owner decision (step 2):** **merge order is `#859` before `#860`.** This
branch proceeds now rather than blocking on another session's uncommitted WIP,
and the plan sequences the `approval.ts` / `batch-view.ts` tickets **last**:

- If #859 has merged by the time those tickets run, rebase onto it and write the
  new statements in the post-fix convention.
- If it has not, write them in the scanner-shaped workaround form. #859 already
  reverts the #629 workarounds; reverting one more is marginal cost to that
  ticket and is the direction that keeps the security audit's proof intact.

Rejected alternative: `#860` first. It would force a tenant-isolation audit to
re-derive its proof over SQL that did not exist when it was written — putting
the cost on the security ticket.

**Also noted in:** `codex-859-tenant-scope-subqueries` deviations.

---

## D2 — surface amendment #1: `src/lib/agents/*` (owner-approved at step 3)

**When:** step 3 (PLAN), during the pre-plan risk sweep.

**What:** the `ask_regeneration_requested` run step needs its key registered in
`STEP_PERSONA` (`src/lib/agents/run-spine.ts`), because `AgentStepKey` is
`keyof typeof STEP_PERSONA` — an unregistered key is a tsc error, not a runtime
surprise. There is **no** DB CHECK on `agent_run_steps.step_key`, so this needs
no migration. Only two files in the repo reference `STEP_PERSONA`: `run-spine.ts`
and its own test.

**Owner decision:** amend `allowed_edit_surface` with `src/lib/agents/*`.
Applied to both intake copies (`.feature/intake.json` arming copy and the
committed audit copy), verified identical.

Rejected: reusing `ask_generated` (the worker writes a real one on the swap, so
the timeline would show two generations for one regenerate) and dropping the
step (reverses the step-1 actor decision and leaves an owner-triggered LLM spend
unattributable).

**Amendment count: 1 of 2.** A pre-plan sweep found no other out-of-surface file:
`docs/`, `CONTEXT.md` and `.feature/` are always-allowed by both matchers;
`queue-names.ts`, `job-outbox-helpers.ts`, `job-outbox-status.ts` and the auth
helpers are read-only imports; `worker/` needs no change because
`worker/jobs/solicitation-batch/generate.ts` already dispatches on `ask_id`.

---

## D3 — `job_outbox` is not a tenant table (finding, no action)

**When:** step 3 (PLAN), risk sweep.

**What:** `batch-view.ts`'s new in-flight regeneration read carries no
`account_id` / `business_id` predicate. That is correct, not an oversight:
`job_outbox` is absent from `scripts/ci/tenant-tables.ts`, so a statement
referencing only `job_outbox` is not audited by `ci:tenant-scope` and needs no
allowlist entry.

**Consequence for implementation:** the read must NOT join `solicitation_batches`
to "look scoped". Doing so would pull a tenant table into the statement, make it
auditable, and require scope keys on a query whose safety comes from elsewhere —
the caller already proved the batch belongs to the tenant via the scoped
lifecycle read, and `aggregate_id` is that same proven id. Write that reasoning
as a code comment so a reviewer does not read the absent keys as a defect.
