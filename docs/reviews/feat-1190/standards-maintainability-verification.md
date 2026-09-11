# Standards / maintainability verification — #1190

Exact reviewed HEAD: `83184894ee71e895fd1b91fa8f3c0869cfd89859`.
Prior review: `6c42b8050acdeac698171a57d26b56d4fcbd8fcf`.
Scope: my M1/M2 fixes, their direct consequences, and the requested compiler-host optimization. Source read only through immutable `git show`/`git diff`. `pnpm agent:rules .feature/review-staging/standards-maintainability-verification.md` returned `none`.

## Original findings

- **M1 FIXED — shared object renderer.** `scripts/ci/admin-contract-types.ts:88` now owns property omission, optionality, and index signatures together. Both ordinary rendering (`:85`) and parameter-specialized literal rendering (`:250`) use it; unspecialized literals return the ordinary result (`:249`). The specialization is limited to property-value overrides. The regression fixture at `scripts/ci/__tests__/admin-contract-types.test.ts:100` independently requires the dictionary signature and compares inline/local results, so mutual loss cannot satisfy the equality alone. The adjacent unknown-spread refusal protects the common validation path. The duplicated renderer and its dictionary discrepancy are resolved.
- **M2 FIXED — emitted constraints supply the oracle.** `scripts/ci/__tests__/admin-contract-schemas.test.ts:52` reads the generated keyword-item schema, asserts `minLength: 1` and `maxLength: 3`, then applies both witnesses using those properties. Missing or altered constraints now affect assertions. The independent runtime parser still establishes the opposite results. No new validation dependency or general-purpose test abstraction was added.

## Compiler-host and direct consequence review

`scripts/ci/admin-contract-audit.ts:154` confines `ParseForTypeInfo` to the source-extraction host and explains its purpose locally. The standalone emitter creates a separate default host (`:21`), retains `getPreEmitDiagnostics` (`:29`), and explicitly loads ES2022 rather than ambient DOM declarations (`:19`). The CLI fixture’s JS function needs its JSDoc return type (`scripts/ci/__tests__/admin-contract-audit.test.ts:17`), with the emitted numeric field asserted at `:93`; private-name rejection, DOM rejection, and Date acceptance are asserted at `:68`–`:70`. These are observable type-contract checks, not assertions of compiler implementation details. No additional actionable maintainability defect found.

Rechecked applicable checklist classes: divergent duplication, test vacuity/coupling, claims, locality, and dependency growth. Unrelated fronts remained excluded. The lead reported a green gate; I did not execute tests, gates, mutations, or independently measure performance. No uncertainty blocks this scoped verdict.

APPROVED
