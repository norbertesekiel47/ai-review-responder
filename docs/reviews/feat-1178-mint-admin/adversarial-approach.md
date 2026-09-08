# Adversarial approach review — #1178 scripts/mint-admin.ts

Axis: adversarial approach (Codex, read-only). Session `01a07ee6-1424-79e2-9e06-da5337195ee9`.
Fork/merge-base `b23172836bc5c435dc429f1fa7505812c168fa87`, HEAD `8c4108b4bd2a6a50a2a63b5b7a044fd050719a39`.

## Findings table (>=80% confidence) and low-confidence appendix

| Severity | File:line | One-line finding | Smallest correction |
|---|---|---|---|
| High | [mint-admin.md:150](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-1178-mint-admin/docs/runbooks/mint-admin.md:150) | Manual recovery recreates the reconciliation hazards: elapsed time plus absence permits deletion, while any linked row counts as this invocation’s success. | Require conclusive transaction termination before deletion; verify the invocation’s user ID and audit event before declaring success. Otherwise preserve Auth. |
| Medium | [mint-admin.ts:591](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-1178-mint-admin/scripts/mint-admin.ts:591) | Commit uncertainty is handled only for Postgres: a lost Auth response can leave an identity without reconciliation, while the empty-response branch incorrectly asserts nothing was written. [SDK transport handling](https://github.com/supabase/supabase-js/blob/v2.106.2/packages/core/auth-js/src/lib/fetch.ts) | Report Auth creation as explicitly unknown, include email/target, and direct read-only reconciliation; never infer absence or automatically adopt/delete. |
| Medium | [mint-admin.ts:648](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-1178-mint-admin/scripts/mint-admin.ts:648) | Self-attribution records the privilege recipient as actor without recording the operator, contrary to the runbook’s provenance claim. | Retain the required FK, explicitly mark its bootstrap meaning, and record operator identity and its provenance separately in the payload. |

---

**Low-confidence appendix**

- **Dual Auth checks:** No ordinary-email adoption hole established. The API’s [duplicate predicate](https://github.com/supabase/auth/blob/master/internal/models/user.go) excludes some SSO identities, so its coverage differs from the SQL probe; repository evidence does not establish that configuration here.
- **Simpler compensation:** Preserving Auth after every SQL failure would remove classifier complexity, but I lack sufficient evidence that the added manual cleanup improves this CLI. The [pinned postgres.js implementation](https://github.com/porsager/postgres/blob/v3.4.9/src/index.js) supports the current conservative rollback treatment.

## Reviewer narration (for provenance)

- I’ll review the pinned diff and repository guidance, then trace the implementation’s assumptions around rollback, auth checks, and audit attribution. I’ll use the code-review skill and leave files and databases untouched.
- The code distinguishes a failed transaction from an unknown commit outcome and checks for a linked user before deleting Auth. I’m now checking whether that distinction also holds at the Auth boundary and in the runbook’s manual recovery steps.
- The runbook weakens the code’s safety rule: it tells operators to wait a few seconds, then delete Auth if no user row appears. That still leaves the late-commit risk. I’m also using the Supabase skill to check the Auth error semantics and audit attribution against their source definitions.
- The stop hook is asking for the feature gate, but this was a read-only review with database-writing tests explicitly prohibited. I’ll inspect the gate’s behavior before running anything.
- The review is complete. I did not run the requested gate: [verify-gate.sh](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-1178-mint-admin/scripts/verify-gate.sh:18) provisions the test database and runs database-writing suites, conflicting with your explicit review constraints. No files or databases were changed.
