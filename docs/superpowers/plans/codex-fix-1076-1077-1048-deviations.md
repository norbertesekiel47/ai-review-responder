# Deviations

## D1 — Required pre-merge architecture-log entry

The committed-tree merge-ledger audit requires an architecture-log addition for
a production change, even though the documentation skill describes that file's
merge-counter update as post-merge only. Add a labeled pre-merge entry and leave
the counter untouched. This satisfies both factual accuracy and the audit.
The first surface amendment adds only `.claude/reference/arch-review-log.md`;
it changes no approved product behavior, schema, dependency, or remote action.

**Verdict:** ACCEPT — required repository verification within the authorized
local documentation and commit work. No merge is claimed or performed.
