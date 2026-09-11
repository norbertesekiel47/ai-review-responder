# #1190 deviations

## D1 — mandatory architecture merge ledger omitted from initial surface

The first committed implementation made `ci:merge-ledger` require a pre-merge
entry in `.claude/reference/arch-review-log.md`. The initial surface omitted
that governance file. The first full gate before the commit was green; the
exact-commit gate exposed this omission alongside the integration-test timeout.

The first surface amendment adds only that ledger path to both intake copies.
It is recorded as amendment 1 by `scripts/feature-state.sh incr-amendment`,
whose first-amendment rule is automatic. The entry describes the implementation
and leaves the merge counter to the later pass. No API or design scope changes.
A second surface amendment still hits the owner's hard stop.

**Verdict:** ACCEPT — required workflow governance within the owner's authorized
ticket delivery; first amendment only, with no merge or production authority.
