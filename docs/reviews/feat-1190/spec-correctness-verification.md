# #1190 spec/correctness correction verification

**Verdict: REVISE — C1, C3, and C4 are fixed; C2 is partially fixed.**

- Current reviewed head: `83184894ee71e895fd1b91fa8f3c0869cfd89859`.
- Prior reviewed head: `6c42b8050acdeac698171a57d26b56d4fcbd8fcf`.
- Original fork/merge-base: `8b92d85395f902879d93748b5929b0b503c0ad86`.
- C1–C4 below refer respectively to F1–F4 in my original staged report.
- Scope: verification of my four findings and their directly touched correction hunks/tests, adjacent undefined/Symbol/type-parameter handling, and the requested compiler-host/standalone-library changes. This is not a new review of unrelated source areas or another reviewer's findings.
- All application/tooling source evidence came from immutable `git show` and the diff between the two reviewed heads. No tests, full gates, application execution, mutation, commits, or process operations were performed. The authorized `pnpm agent:rules .feature/review-staging/spec-correctness-verification.md` check returned `none` before this report was written.

The supplied exact-head gate claim is 14,698 tests plus 224 focused checks/build/audits passing, fingerprint `f285ea4036d4d954c26fe5a20ce65bd5f8dabfc0d194ac005b1ca4bf09720885`. I did not independently execute those checks. Intermittent claude-mem hook failures briefly interrupted reads; ordinary retries recovered and all source/test evidence cited below was subsequently read. No hook or process bypass was used.

## Findings disposition

| Finding | Verdict | Pinned evidence |
| --- | --- | --- |
| C1: line-only helper specialization identity | Fixed | `scripts/ci/admin-contract-types.ts:159` now identifies nodes by filename/start/end; `:162` assigns binding-environment identities; `:422` combines both the callee environment and each argument's source/environment. `scripts/ci/__tests__/admin-contract-types.test.ts:79` covers two same-line calls through a nested helper, asserting both statuses and their corresponding distinct body fields. |
| C2: reassigned status reported as its initial value | Partially fixed; remains medium/P2 | `scripts/ci/admin-contract-types.ts:185` restricts variable-initializer substitution to `const`, so the original mutable-local scenarios no longer reduce to 200. Tests at `scripts/ci/__tests__/admin-contract-types.test.ts:91` assert refusal for unconditional and conditional local assignments. However, parameter substitution at `types.ts:182–183` still precedes this check, and `const` init objects remain mutable. Both remaining scenarios are detailed below. |
| C3: inline object renderer bypasses validation/dictionaries | Fixed | `scripts/ci/admin-contract-types.ts:241` first applies common JSON rendering, so top-level `any` spread reaches the existing refusal. `:249` returns the ordinary rendering when no specialization is needed; specialized objects also use shared `renderObjectType` at `:250`, including its index signatures at `:106`. Tests at `scripts/ci/__tests__/admin-contract-types.test.ts:100` assert an actual numeric dictionary signature, parity with a named body, and refusal for an `any` spread. |
| C4: unsupported request-input provenance silently loses schemas | Fixed for the reported defect and correction scope | `scripts/ci/admin-contract-schemas.ts:223` recursively checks descendants, including non-expression property nodes. `:291` refuses request-derived parser inputs whose origin cannot be represented; `:298` follows imported helpers receiving already-read bodies. Tests at `scripts/ci/__tests__/admin-contract-schemas.test.ts:121` cover nullish fallback, property selection, object-property nesting, and an imported body parser with an asserted generated maxLength. |

## C2 remaining actionable gap — medium/P2, 99% confidence

**Contract:** the original C2/F2 requirement remains unchanged: status sets must describe the actual JSON response or fail closed when status provenance cannot be proved. Restricting direct variable declarations to `const` does not establish immutability for bound parameters or object properties.

### Reassigned helper parameter

**Exact location:** `scripts/ci/admin-contract-types.ts:183`, consumed by `statusText` at `:263`.

```ts
function reply(status: number): NextResponse {
  status = 418;
  return NextResponse.json({ ok: true }, { status });
}
export function GET() { return reply(200); }
```

Static source trace: `call` binds the `status` parameter to the literal 200 at lines 416–420. The visitor does not invalidate that binding on `status = 418`. `resolveBinding` follows the environment entry immediately at line 183, before the new const-only variable-declaration check. `statusText` then sees the numeric literal 200 and returns it at line 265. Runtime uses the reassigned parameter value 418. Adding or changing that reassignment can leave the generated status inventory unchanged.

This is the original reassigned-status defect through the existing helper-parameter seam, not a separate proposed feature. The new test at `admin-contract-types.test.ts:91` only exercises a local `let` declaration and cannot catch this path.

### Mutated `const` response-init object

**Exact locations:** `scripts/ci/admin-contract-types.ts:185` and `:391–397`.

```ts
export function GET() {
  const init = { status: 200 };
  init.status = 418;
  return NextResponse.json({ ok: true }, init);
}
```

Static source trace: the new check accepts the `const` binding, substitutes its object initializer, and the JSON-call branch reads the original literal `status` property at lines 395–396. It never accounts for `init.status = 418`, so it records 200 although runtime uses 418. `const` protects the binding from reassignment, not the object's status property. Again, the emitted contract can remain unchanged after the runtime response changes.

### Smallest correction

Failing closed is sufficient; no general interpreter is needed. Before substituting a bound response/status parameter, reject reassignment or update of that symbol within its analyzed function scope (including relevant captured writes). For named response-init/status objects, only reduce the initializer when mutation/escape analysis establishes that the relevant value is unchanged; otherwise reject the named object as unsupported. If that proof is intentionally outside the supported subset, reject that object form rather than assuming `const` makes its properties immutable. Preserve direct object literals and proven unmodified helper bindings.

Add focused fixtures for both snippets above, with an oracle that requires either the real 418 status or a source-located unsupported-status/init failure. These examples were not executed by this reviewer; the conclusion is derived from the exact pinned control flow, and lead-owned reproduction remains appropriate.

## Directly adjacent corrections

- **Undefined:** `scripts/ci/admin-contract-types.ts:46–48` rejects a top-level undefined/void wire body while retaining nested-array null behavior; optional object omission still occurs in shared object rendering. The cache distinguishes nested and top-level requests. `scripts/ci/__tests__/admin-contract-types.test.ts:63–65` asserts both generator refusal and the platform `Response.json(undefined)` failure. No new inconsistency found in this correction.
- **Symbols and unresolved type parameters:** the unconditional check at `scripts/ci/admin-contract-types.ts:82–83` now runs before object expansion, so incidental properties cannot turn these unsupported values into invented object shapes. Tests at `scripts/ci/__tests__/admin-contract-types.test.ts:66–71` directly cover a Symbol expression and an unresolved generic body. The policy remains fail closed; it does not claim full Symbol serialization support.
- **Generated declaration changes:** the scoped artifact diff adds more specifically inferred error literals, consistent with the new shorthand-property helper substitution at `scripts/ci/admin-contract-types.ts:244`. The broad error branch remains, and the diff does not remove the existing detail `batchSummary`, options `betaCompActive`, DTO exports, or wire branches. No runtime route change is part of these correction hunks.

## Compiler-host and performance-change assessment

`scripts/ci/admin-contract-audit.ts:154–158` changes only the source-analysis host to `JSDocParsingMode.ParseForTypeInfo`. It retains the parsed repository compiler options and the same route/barrel roots. The declaration validation/emission program remains separate and uses full diagnostic checking at `:28–34`.

The JS regression fixture at `scripts/ci/__tests__/admin-contract-audit.test.ts:17` is meaningful: its function returns `JSON.parse`, whose implementation alone does not supply the declared numeric field. The numeric return information comes from JSDoc, and the real CLI assertion at `:93` requires `"value": number | null`. Dropping that type information would produce uncertainty instead and fail this assertion. The repository golden comparison at `:73–75` still checks all generated artifact bytes; it was not replaced with a weaker subset.

The standalone program now explicitly uses `lib.es2022.d.ts` with `types: []` (`scripts/ci/admin-contract-audit.ts:15–19`). It retains Date support while requiring unresolved/private/DOM-only names to fail diagnostics. Tests at `scripts/ci/__tests__/admin-contract-audit.test.ts:64–70` assert private-name refusal, HTMLElement refusal, and successful Date emission. No source-level correctness regression was found in these two compiler-option changes within this scoped review.

`docs/reviews/feat-1190/performance-diagnosis.md` records the isolated failure, CPU profile attribution, later timings, and unchanged integration timeout. Those measurements are recorded evidence, not measurements made in this verification pass. The source/test changes are consistent with its preservation claims, but this report does **not** independently certify the timings, reproduce the final gate, or claim a red-team P0 is resolved.

## Checklist and scope conclusion

The already-read spec-correctness checklist's applicable defect classes were reapplied to these hunks: acceptance oracles must exercise the changed behavior, inventories must be source-derived, helper callers must remain represented, and verification claims must match their evidence. C1/C3/C4 fixtures exercise their corrected behavior. C2's new fixture is meaningful but narrower than the still-supported mutable parameter/object paths, so the original defect class cannot yet be closed.

No additional uncertain findings or unrelated recommendations are promoted by this verification. The remaining approval blocker on this axis is C2 alone.
