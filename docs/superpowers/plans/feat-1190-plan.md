# #1190 — generated Admin API contract

Intent is ticket #1190 and ADR 0028, including the owner-approved 2026-09-10 D1/D5
amendment recorded before intake. Base: `8b92d85395f902879d93748b5929b0b503c0ad86`.
No runtime response or authorization changes. No impersonation route edits.

## Design and rationale

The generator owns compilation, route inventory and artifact comparison. It uses
the existing TypeScript compiler dependency and built-in Zod JSON Schema converter.
The shared admin-aal2 module remains the only reader of canonical gate provenance
and exported HTTP methods. Its exported analysis must preserve existing audit
findings while additionally exposing method/gate names to the contract.

Three focused implementation modules are justified by independent responsibilities:
the existing audit cannot own serialization or schema evaluation; the contract
audit coordinates artifacts, admin-contract-types owns compiler-derived portable
types, and admin-contract-schemas owns safe source-schema evaluation. New generated
files and the index-only DTO barrel are explicitly required by the ticket. Added
lines implement two compiler analyses and artifact completeness rather than a new
runtime abstraction; no package is added.

After first complete generation, the production estimate is 3,500 lines including
the generated declaration closure and schema JSON (previous 950 estimated tooling
only). The test estimate remains 550. This corrects accounting, not behavior or
edit surface; generated files are part of the production diff bucket.

## T1 — canonical method/gate inventory

Expose the existing audit's per-handler analysis and credited gate names; have
both existing audit and generator consume it. Preserve failure messages and
provenance allowlist. Paths: admin-aal2-audit.ts and its tests. Characterization
test: `reports canonical gate names for every exported method`; test aliased
canonical imports, sibling methods, fake imports and unsupported exports. No
dependency on another tracer. Precedent: scanRouteFile and collectGateEvidence.

## T2 — portable complete response declarations

Build a TypeScript Program from repo config without emitting runtime code or
loading modules. Starting at each exported handler, resolve reachable response
expressions and response-producing helper calls using compiler symbols. Bind actual
arguments to parameters at each call site, including jsonResponse/errorResponse,
response-bearing object properties, configuration callbacks and the original handler
carried by supported higher-order wrappers. Keep specialization state distinct by
call site and bound recursion/work; this is response analysis, never gate credit.
Unresolved callbacks fail with route, method and source location. Require fixtures
for the current channel-start chain, nested helper binding and an unresolved callback.
Record
source provenance; fail closed on unresolved response producers instead of silently
omitting them. Derive each actual JSON argument's compiler type, then project JSON
serialization: Date becomes string or null (invalid dates), broad numbers include
null (non-finite values), undefined object fields become optional and undefined
array slots become null. Reject unresolved top-level unknown/any producers and
bigint values that cannot serialize successfully. Preserve original DTO types,
including unknown payloads. Nested unknown/any wire fields retain explicit source
uncertainty as recursive JSON values: optional on objects, present on arrays, with
null possible. This describes successful JSON serialization, not a promise that
every runtime input serializes. Callable properties are omitted, not invented as
JSON functions. Require actual audit payload, invalid Date, non-finite number and
nested unknown object/array fixtures. Handle unions,
arrays, dictionaries, nullable values and shared types without leaking private
imports. Preserve supporting declaration dependencies deterministically.

The index-only src/lib/admin/api-contract.ts re-exports existing response DTOs.
Generate named route/method response declarations from actual expressions,
including route additions and projections, alongside DTO exports. Emit declarations
with TypeScript's emitDeclarationOnly option from the compiler-derived portable
source and typecheck a standalone consumer with no repository aliases. Derive
response status sets from response calls and helper paths; unresolved computed
status codes must be represented truthfully or fail closed. General error envelope
and proxy/MFA refusal prose are documented once; actual status-union exceptions
remain visible in method response declarations.

Paths: api-contract barrel, admin-contract-types.ts and tests, directory row,
generated admin-api.d.ts. Tests: `emits portable wire declarations for composed
responses and JSON serialization`, `rejects unsupported wire response types`.
Pin #1189 options to only betaCompActive and detail to nullable batchSummary.
Depends on T1 for route inventory; production shapes remain single-owner.

## T3 — source-derived request schemas

Resolve schemas actually used to parse each handler's request, distinguishing
body, query/path parameters and helper-owned parsing. Evaluate only the necessary
pure Zod expression and its constant/schema dependencies using a finite AST
expression/call allowlist (not arbitrary VM code);
never import routes or invoke app auth/DB/provider initialization. Reject unsupported
dependencies. Use z.toJSONSchema on the input side, keeping unrepresentable custom
refinements explicitly described as runtime-only constraints rather than asserting
the JSON Schema alone proves them. Identify normalization/overwrite operations and
their affected paths in generated metadata. Their emitted length/pattern constraints
may apply after normalization; label those schemas as approximations, unsuitable
as complete preflight validators. Pin padded max-length keywords and whitespace-only
inputs as witnesses for disagreement in both directions. Reject arbitrary callbacks,
getters and dynamic dependencies; extract callback source only as limitation metadata,
never execute it. Record no body and hand-parsed requests without
invented schemas. Paths: admin-contract-schemas.ts and tests, generated schemas.
Test: `generates request schemas without importing runtime modules`. Depends on
T1; may implement disjointly from T2 after establishing T1's precedent.

## T4 — deterministic audit and wiring

Generate all files into a temporary directory; byte-compare the full generated
tree with committed artifacts, rejecting missing/extra/stale files. Parse the
committed route table and compare its route/method inventory with the shared
resolver independently of a snapshot. README includes route/method, canonical
gate, request schema/absence, generated response type, status set, proxy bodies,
MFA vocabulary and existing exception shapes. No current inventory count is
hardcoded from the ADR's historical count.

Paths: admin-contract-audit.ts and tests, README, package.json, ci.yml lint job,
lefthook.yml, ci-audit-wiring.test.ts. Tests: `fails on edited declarations and
missing or stale route rows`, `detects route method and gate provenance drift`.
Depends on T1–T3. Regeneration command is separate from read-only audit mode.

## Verification and shipping

Run focused tests and standalone-consumer checks, complete guarded review gate,
then fresh independent correctness, maintainability, security and red-team passes
at one pinned committed SHA. Preserve exact reports under planned review paths.
Stop on three red gate rounds, second surface amendment, new ADR contradiction
or unauthorized production change. Mutations use only this ticket's default
budget; any request to stop shared preview processes goes to the orchestrator.

After final green gate: staging first, confirm ready deployment/source SHA,
regenerate/check artifacts at that SHA and record evidence in the review report.
This feature changes no browser journey; the relevant integration proof is the
independent consumer typecheck plus artifact regeneration and CI. Existing runtime
admin browser tests are not a substitute for compiler artifact validation.
Open PR, wait for current-head CI, then stop for explicit owner merge approval.
