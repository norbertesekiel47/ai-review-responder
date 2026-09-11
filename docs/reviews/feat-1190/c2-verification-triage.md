# C2 status-provenance correction

The scoped correctness verification at `83184894ee71e895fd1b91fa8f3c0869cfd89859`
approved C1/C3/C4 and the compiler options, but retained C2: assigned helper
parameters and mutated const response-init objects could still document their
initial status. Maintainability and security verified their own corrections.

The lead reproduced four isolated scenarios at that pin: parameter reassignment,
direct init-property mutation, mutation through an alias, and a mutating helper.
Each generated `["200"]` although the source returns 418. Temporary fixtures were
removed; no application or provider state was touched. C2V is ACCEPT in review
round 6 and the correctness checklist. This is the existing accepted defect
class, within the approved edit surface and contract; no new design amendment.

## Explicit implementation authority

Automatic approval review twice misidentified the feature implementation lead
as the dispatch-only orchestrator and rejected the direct patch. Neither attempt
edited source or ran the pending tests. The root then asked:

> Do you authorize the /root/feature_1190 implementation subagent to apply and test that prepared correction in feat-1190, while I remain dispatch-only?

The user's exact reply was **“Go for it”**, relayed by the root. The same direct
patch then passed ordinary approval review. No indirect workaround, plugin
change, production operation, mutation-budget approval, or merge approval was
involved. The actor-specific approval covers this correction and its tests;
round-2 execution remains a separate pending operation.

## Bounded correction and evidence

Status derivation now checks source references before substituting parameter
arguments or const initializers. Writes, captured updates, object aliases or
unmodeled escapes fail closed. Property lookup maps retain read-only aliases
and truthiness guards; recursive alias checks reject mutated descendants, and
method calls or exported mutable objects are not assumed safe. Direct JSON
options and proven unmodified parameter/named-init bindings retain support.
This is a conservative source proof, not an interpreter of arbitrary effects.

The existing mutable-status regression case now covers these failure forms and
positive stable parameter, named-init, and guarded-map examples. Focused tests
also retain the current finite lookup-map and domain-error vocabulary and compare
all actual repository artifacts byte for byte. No generated artifact changed.

Two intermediate focused runs rejected the existing provider-error mapping's
harmless truthiness guard and conditional alias. Their exact source forms were
added to the supported read-only proof and a direct positive fixture before
freezing the consolidated patch. They were focused integration failures, not
full-gate rounds; no timeout or assertion was weakened.

The final focused response/audit run passed **17/17 tests in 10.05 seconds**.
The source correction still requires a fresh committed full gate and scoped
independent C2 verification, followed by authorized round-2 mutation measurement.
The original red-team P0/P1 disposition is not changed by these focused results.
