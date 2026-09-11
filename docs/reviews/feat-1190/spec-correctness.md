# #1190 independent spec/correctness review

**Verdict: REVISE**

- Reviewed head: `6c42b8050acdeac698171a57d26b56d4fcbd8fcf`.
- Fork and merge-base: `8b92d85395f902879d93748b5929b0b503c0ad86`.
- Axis: source/contract correctness, acceptance coverage, and failure on unsupported source forms.
- Evidence: immutable `git show <head>:<path>` reads and the diff between the pinned commits. The staging context was read first. No tests, application code, network operations, mutations, commits, or process signals were executed. The supplied green-gate fingerprint and 14,692-test/full-build result remain lead-supplied claims, not independently reproduced proof.
- All counterexamples below are static derivations from the pinned implementation. They are deliberately identified as such; none is represented as an executed mutation or observed runtime result.

## Actionable findings

### F1 — Medium / P2: line-only specialization keys discard distinct response calls

**Location:** `scripts/ci/admin-contract-types.ts:399` (with the line-only `location` implementation at lines 6–8).

**Contract:** intake invariants require complete compiler-derived wire bodies; edge cases require retaining actual helper arguments; T2 requires specialization state to remain distinct by call site. ADR 0028 amendment D1 requires truthful complete responses and failure when unsupported.

The visited key contains `location(node)`, `location(fn)`, and the locations of bound argument nodes. `location` records only filename and line, so distinct calls and arguments on one line receive the same key. The second response-producing helper call is skipped at line 400, while `call` still returns true at line 401, preventing fallback traversal.

Minimal counterexample for the existing response fixture (the GET declaration must stay on one line):

```ts
function reply(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, { status });
}
export function GET() { if (Date.now()) return reply({ ok: true }, 200); return reply({ error: 'later' }, 418); }
```

Both calls have the same call location, function location, and argument-location sequence. The implementation therefore records only the first call's body and status. Adding or changing the second branch can leave the generated declaration/status inventory unchanged rather than recording 418 or rejecting the source. This also makes contract coverage depend on formatting.

**Smallest correction:** key AST nodes by a unique source position, such as filename plus `getStart()`/`end`, rather than diagnostic line labels; preserve the bound environment in the specialization identity where different environments can reach the same nodes. Add a fixture with two differently shaped/statused helper calls on one line and assert both results. Confidence: **99%**.

### F2 — Medium / P2: reassigned status variables are reported as their initial values

**Location:** `scripts/ci/admin-contract-types.ts:240`; underlying unconditional initializer substitution at lines 162–164.

**Contract:** intake user-visible behavior promises source status coverage and failure on unsupported wire forms; T2 says unresolved computed status codes must be represented truthfully or fail closed. README lines 14–16 make the same status-derivation guarantee.

`statusText` calls `resolveBinding` before inspecting the compiler type. That resolver replaces every variable identifier with its initializer without checking whether the declaration is mutable or the binding was subsequently assigned. The body renderer explicitly avoids this mistake at lines 201–204, but status derivation does not.

Minimal counterexample:

```ts
export function GET() {
  let status = 200;
  status = 418;
  return NextResponse.json({ ok: true }, { status });
}
```

Static derivation: `statusText` resolves `status` directly to the numeric literal `200`, and line 242 immediately returns `200`. The actual JSON response uses 418. Inserting the reassignment into a previously generated route can therefore leave its status table byte-identical and the contract audit green. Conditional assignments have the same omission problem.

**Smallest correction:** preserve the status expression's compiler flow type and permit initializer reduction only for proven immutable bindings; reject a mutable/dynamically assigned status when a complete finite set cannot be proved. Add reassigned and conditional-status fixtures that must either include the real statuses or fail generation. Confidence: **99%**.

### F3 — Medium / P2: object-literal rendering bypasses unknown-body checks and drops index signatures

**Location:** `scripts/ci/admin-contract-types.ts:216–218` and `:232`.

**Contract:** intake edge cases explicitly require unresolved top-level `any`/`unknown` to fail; T2 includes dictionaries, composed objects, and truthfully preserving unknown source uncertainty. ADR 0028 amendment D1 prohibits silently inventing a complete response.

The object-literal branch reads only `checker.getPropertiesOfType(type)`. Unlike `renderJsonType`, it never checks top-level `Any`/`Unknown` and never emits `checker.getIndexInfosOfType(type)`. It then unconditionally returns an object type from those named properties.

Counterexamples:

```ts
declare const unknownPayload: any;
export function GET() { return NextResponse.json({ ...unknownPayload }); }
```

The spread makes the compiler's object expression type `any`, but this branch produces `{ }` instead of reaching the explicit top-level refusal at lines 39–42. Changes to the unknown producer can go undetected.

```ts
declare const values: Record<string, number>;
export function GET() { return NextResponse.json({ ...values }); }
```

The compiler's dictionary index signature is discarded, leaving `{ }`; changing the value type from `number` to `string` does not change that output. This is materially different from the supported direct `NextResponse.json(values)` path, which emits the index signature via lines 92–95. The empty structural type also accepts unrelated non-nullish primitives in a consumer and does not describe this JSON object's dictionary domain.

**Smallest correction:** apply the common top-level type validation and index-signature projection before returning the specialized object rendering, or delegate objects without actual parameter substitutions to `renderJsonType`. Keep the existing specialization for direct bound fields. Add fixtures for a dictionary spread and a top-level `any` spread. Confidence: **96%**.

### F4 — Medium / P2: unsupported request-input expressions silently suppress request schemas

**Location:** `scripts/ci/admin-contract-schemas.ts:265–275`, specifically the `if (location)` guard at line 267.

**Contract:** intake requires unsupported schema/provenance forms to fail with source location; T3 requires discovering the schemas actually used to parse each handler's request, including helper-owned parsing. A request with a real Zod parser must not be described as merely hand-parsed because provenance analysis stopped.

`origin` recognizes a short list of direct expressions and returns `undefined` for everything else (lines 209–221). A parse call whose argument uses an unrecognized expression is silently ignored, rather than rejected. Traversal later notices the underlying `req.json()` and emits `body: 'hand-parsed-json'` with no schema at line 308.

Minimal counterexample:

```ts
const Input = z.object({ name: z.string().max(12) });
export async function POST(req: Request) {
  const parsed = Input.safeParse((await req.json()) ?? {});
  return Response.json({ success: parsed.success });
}
```

Static derivation: the nullish-coalescing expression has no recognized origin, so `Input` is never evaluated. Changing `.max(12)` to `.max(3)` then changes runtime request acceptance without producing any generated schema or schema diff. An unsupported dynamic schema dependency behind this input spelling is also never rejected. Imported parsers that receive already-read body values are another route into the same silent omission: the traversal at lines 282–284 follows imported helpers only when they receive an entire recognized request object.

**Smallest correction:** track request-derived values through supported expression/helper forms and distinguish proven non-request parsing from unresolved request provenance. Fail with route/source location when an encountered request-derived parse cannot be described; do not silently downgrade it to hand-parsed. Add a fixture for the nullish-coalescing input, plus a constraint-change assertion or explicit refusal. Confidence: **99%**.

## Acceptance and regression coverage checked

The committed intake, full plan, owner-amended ADR 0028, deviations, new/changed test coverage across the four audit suites, gate wiring test changes, the re-export-only barrel, current route table, generated response declarations, and relevant current route/helper sources were checked. The spec-correctness finding checklist was read in full and every entry considered before findings were authored. Its historical UI-specific rules are not applicable to this tooling-only diff; its applicable lessons are non-vacuous acceptance assertions, source-derived inventories, all caller coverage, and recorded deviations rather than silent omissions. No conclusions from another reviewer were imported.

| Intake/plan field | Assessment at pinned head |
| --- | --- |
| Goal, user-visible artifacts, observability | Standalone declarations, 17 request schema files (16 body, one path), and 36 route rows are committed. Audit output identifies changed/missing/stale artifacts. The promised unsupported-source/drift guarantee has F1–F4 gaps. |
| Non-goals, surface, DB touching, dependencies | Diff has no runtime route edits, no impersonation edits, no database change, no dependency addition, no OpenAPI, no delivery workflow, and no production operation. |
| Invariant: canonical resolver reuse | `describeRouteHandlers` first calls the existing `scanRouteFile`, then uses the same handler inventory and `collectGateEvidence`. Changes add canonical names without removing the existing gate booleans or findings. No second gate parser was added. |
| Invariant: actual JSON-expression wire derivation | Implemented through TypeScript analysis and literal/helper discovery; F1–F3 identify loss of completeness. |
| Invariant: index-only DTO barrel | The new barrel contains only existing type re-exports. Generated portable DTO aliases and wire aliases are separate. |
| Invariant: no runtime module evaluation | Request schema interpreter constructs whitelisted Zod expressions and records callbacks as text. Response analysis reads compiler AST/types. No route/auth/DB import execution is required by generation. |
| Invariant: serialization/error exceptions | Date and broad-number nullability, optional omitted fields, callable omission, unknown nested JSON values, and bigint/custom-toJSON refusals have code and fixtures. General errors and batch-halt exceptions are documented. F3 bypasses part of this logic. |
| Edge: #1189 actual source shapes | `businesses/[id]/route.ts:41–42` enriches detail with `batchSummary`; generated declaration lines 1001–1011 contains its nullable shape. `businesses/options/route.ts:11` returns only `betaCompActive`; generated lines 1116–1120 contain that success branch plus the existing error branch. Existing #1189 route tests assert null summary/error paths and exact true/false options bodies. |
| Edge: helper/callback/wrapper bindings | Current channel start, canonical gate, JSON helper, and wrapper sources have corresponding generated responses and fixtures. Same-line call-site identity remains incomplete (F1). |
| Edge: normalization/refinement approximation | Keywords schema records `$.keywords[]` trim and marks approximation. Fixtures demonstrate padded and whitespace-only inputs disagreeing with raw length bounds. Imported provider-disposition schema records affected paths. |
| Edge: unsupported exports/dependencies | Existing export/gate reader rejects unsupported exports. Schema interpreter rejects its encountered unsupported operations and dynamic dependencies. Request provenance loss bypasses that rejection (F4). |
| Edge: hand-parsed/multipart/bodyless | Current channel requests are listed as hand-parsed, CSV import as multipart, and GETs as bodyless. These current classifications match inspected source patterns. F4 is about requests whose real parser is missed. |
| Edge: standalone private closure | Portable rendering emits aliases without repository imports; `emitPortableDeclarations` uses strict compilation with empty `types`, declaration-only emit, and throws diagnostics. The isolated declaration test rejects an unresolved private name. No standalone execution was performed by this reviewer. |
| Existing patterns and test seams | Shared AAL2 resolver and independent route-table check are used. `generateAdminContract`, byte comparison, and portable declaration emit are tested seams. CLI audit is read-only and `--write` is explicit regeneration. |
| Allowed edit surface / deviations | Actual diff stays within the intake's amended paths. The single recorded deviation adds the architecture ledger; no second amendment or unrecorded runtime scope expansion appears in the pinned diff. |
| Tests-to-add 1 | Canonical names test includes aliases, sibling methods, fake import provenance, and unsupported exports. Existing AAL2 callers still invoke the same scan implementation. |
| Tests-to-add 2 | Composed responses/serialization fixtures and full repository regeneration exist. Current detail/options shapes are correct; F1/F3 expose missing branch/spread cases. |
| Tests-to-add 3 | Unknown body, bigint, toJSON, optional tuple, opaque callback/return, and unresolved statuses are tested. F2/F3 expose unsupported forms that escape those checks. |
| Tests-to-add 4 | Fixtures cover no runtime imports, callbacks, imported schemas, actual current routes, and normalization metadata. F4 exposes an untested provenance loss. |
| Tests-to-add 5 | Tests edit declarations, add stale files, and check missing/stale rows. CLI fixture exercises generate → audit → drift failure → regenerate. |
| Tests-to-add 6 | Tests check method/gate table differences; wiring changes add the package command to lint CI and pre-push. |
| Verification commands | Present in intake and covered by the lead's supplied gate claim. No independent test/build execution was permitted for this review. |
| Estimates, rollback, approvals, open questions | Size/risk and estimates are recorded. Rollback is a tooling/artifact revert with no runtime/database/flag rollback. Commit/push/staging/merge remain owner workflow decisions; this review does not authorize them. No open design question is listed. |

## Non-actionable appendix

The README status column contains duplicate numeric entries where one response's status is itself a comma-separated set (for example resend-invite). The underlying known status vocabulary is still present. This is a presentation/deduplication issue, not a separate correctness blocker here.

No browser journey changed in the pinned diff. This review does not claim browser verification. Fresh integration/mutation execution and delivery evidence belong to the feature lead under the supplied protocol.
