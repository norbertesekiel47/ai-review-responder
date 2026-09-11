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

## Completed bounded diagnostic packet

The correctness review at `f78acacf41cf71a3b41e66e8bff19d48ebc054a5`
retained C2 for iteration assignment targets and initialized `var` parameter
redeclarations. The follow-up replaces default-unwritten inference with a
bounded proven-read classifier. Unknown reference roles refuse generation;
captured writes, assignment patterns, rest targets and loop targets are covered.

Before another full gate, the original reviewer completed a bounded diagnostic
audit of that classifier and the separate named-object proof. Two further
groups were consolidated with the complete fixture packet:

- A shorthand assignment default was attributed to the target symbol instead
  of its initializer symbol. The harmless scalar example happened to pass
  because its reference was omitted; the same omission hid an object alias.
  Symbol resolution now special-cases only the shorthand name, distinguishes
  default values from targets, and refuses the object escape.
- An annotated accessor or prototype getter could mutate a named object's
  status through `this`; spreads and computed keys could override the first
  explicit status. Status proof now requires actual literal sources to have
  unique static data/shorthand properties. Accessors, methods, prototype keys,
  spreads, computed members and duplicate keys are refused. Nested literals
  receive the same check when source resolution reaches them. Ordinary response
  body rendering retains its existing behavior.

The original reviewer `/root/feature_1190/correctness_review` explicitly closed
diagnostic preparation at source blob
`c07660b0f3191555b1c785b7d9c3a791bfaa232b` and test blob
`d2e603895023db0c19d72cdda08a9a2d3762158f`, finding no remaining concrete defect
in this agreed packet or directly introduced regression. This was read-only
candidate preparation, not a formal gate-backed approval.

The diagnostic candidate's T5 case contains **39 refusal and 10 preservation modules** in one
TypeScript program, retaining all earlier cases. The consolidated affected
coverage run passed **27/27 tests**: T5 took **512.9 ms**, and actual-repository
generation matched every committed artifact in **4377.1 ms**. Typecheck passed;
the default **5000 ms** test timeout is unchanged. Evidence is in
`/private/tmp/1190-c2-complete-proof-coverage.json` and the corresponding log,
plus `/private/tmp/1190-c2-complete-proof-typecheck.log`.

The independent inventory's final static-key check identified one remaining
oracle family before gating. Two modules now preserve quoted/numeric static
keys and refuse a numeric/string duplicate key. Source is unchanged; final test
blob `3b7b461c191c2b2c0bba5eee632d53e732a4a340` contains **40 refusal and 11
preservation modules**, still one executable test case. The response suite's
follow-up coverage run passed **10/10 tests**, with the complete matrix taking
**505.7 ms** (`/private/tmp/1190-c2-static-key-coverage.json`).

The independent inventory reviewer explicitly closed CR1–CR6 and the retained
branch map at those final source/test blobs: **25 candidates, 50 minimum–75
maximum launches including baselines**, with two unchanged exclusions and no
pending coverage edits identified. This is static inventory, not mutation proof.

A stable commit, a fresh full gate and formal C2 verification still precede the
separately authorized round-2 operation.
No new mutation budget, preview pause or merge authority is implied here.
