# #651 Plan Review Round 3 — Root Triage

**Reviewer verdict:** REVISE  
**Root verdict:** finding ACCEPTED; merge-order revision APPROVED

## Finding 1 — promised-test titles would leave the gate red

**ACCEPT.** The approved intake makes each `tests_to_add` entry a verbatim gate
contract. The plan shortened two ingress titles, split the combined shutdown
contract across differently named tests, and described the ADR-capacity proof
without requiring a test carrying its promised title. Following that wording
would make `promised-tests` fail even if the behavior was correct.

The plan now copies every intake title verbatim. The combined shutdown test
proves both the new client's lifecycle and the existing propagation of a shared
`sql.end()` rejection. The deterministic capacity test reads ADR 0009 and pins
the 15-isolate/189-client model, the conservative 54-of-57 case, and the fixed
pool maximum in code.

## Merge-order disposition

The skeptic approved the revised #651-first order as safe and executable. The
worktrees share the fixed base but remain filesystem-isolated; #651 targets the
current caller-owned transaction interface, while #652 preserves its uncommitted
work and later adapts to `redeemUnsubscribeToken(sqlUnsubscribe, input)`. No
commit, push, deployment, or staging-drill authority is inferred.

This was the third and final plan-skeptic round. The accepted correction is a
test-contract reconciliation, not a behavior or scope change, so execution may
continue against the already approved feature design.
