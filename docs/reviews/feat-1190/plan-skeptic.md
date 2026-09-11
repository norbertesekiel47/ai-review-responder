# Independent plan-skeptic report — #1190

Reviewer: `/root/feature_1190/plan_skeptic`; base `8b92d85395f902879d93748b5929b0b503c0ad86`.
Lead-recorded findings from the independent review, attached to the durable review
transcript with the native reviewer ID. Reviewed intake, plan, amended ADR 0028 and every
plan-skeptic checklist entry. No code edits, tests or external operations by reviewer.

## F1 — P1: call-site specialization

Plan T2 proposed resolving helpers through compiler symbols, but
`src/lib/auth/route-helpers.ts:63` accepts `body: unknown`; `errorResponse` adds
another helper layer at line 73. The channel-start route supplies callbacks through
its configuration object (`src/app/api/admin/channels/telegram/start/route.ts:19`),
and `src/app/api/_shared/channels/start.ts:35` invokes these erased-return callbacks
and returns their response properties. CSRF wrappers call bound handlers.

Following declarations alone loses the actual payload/status/callback binding.
Skipping these producers omits responses; scanning entire helper modules adds
unrelated owner responses. Require bounded call-site parameter substitution,
response-bearing property and callback resolution, distinct specialization states,
and a route/method/source error for unresolved producers. Fixtures must cover
channel start, nested jsonResponse/errorResponse and unresolved callbacks. This
analysis does not expand gate credit.

Triage: **ACCEPT**. Plan T2 and intake now require these bindings and fixtures.

## F2 — P2: JSON serialization boundaries

`src/lib/admin/business-detail-types.ts:175` includes `payload: unknown` in
AccountAuditLogEntry. Blanket unknown rejection blocks an existing response;
inventing a shape would misstate its contract. Invalid Date serializes as null,
and non-finite numbers also serialize as null.

Preserve original DTO unknown fields. Reject unresolved top-level unknown/any
producers; nested values in successfully serialized wire payloads are JSON values,
optional in object members and present in arrays with null possible. Document
source uncertainty, successful serialization limits, invalid-Date and non-finite
number behavior. Add actual audit payload and object/array/date/number fixtures.

Triage: **ACCEPT**. Plan T2 and intake now state the conservative projection and
distinguish source DTO types from successful wire values.

## F3 — P2: schema normalization limitations

`src/app/api/admin/businesses/[id]/keywords/route.ts:15` validates after `.trim()`.
The installed Zod converter emits minLength/maxLength from its validation bag
(`node_modules/zod/src/v4/core/json-schema-processors.ts:28`), while trim is an
overwrite (`node_modules/zod/src/v4/core/api.ts:1138`). Input mode does not encode
normalization. Padded 255-character keywords pass runtime but fail raw maxLength;
whitespace-only input may pass raw minLength but fails runtime after trimming.

Identify normalization operations and affected paths in generated metadata; label
these projections as approximations, unsuitable for complete preflight validation.
Add padded and whitespace-only witnesses. Any relaxed constraints must derive from
source operations, never route-specific handwritten overrides.

Triage: **ACCEPT**. Plan T3 and intake now require normalization/refinement
limitation metadata and both witnesses. The evaluator uses a finite AST allowlist,
rejecting arbitrary callback/getter/dynamic execution.

## Other reviewed controls

Owner-approved amendment consistent; no new ADR conflict. T1 reuses canonical gate
provenance without allowlist growth. T4 rejects missing/extra/stale artifacts and
independently checks method inventory. Standalone declaration compilation and
deterministic closure are appropriate. No runtime or impersonation edits proposed.
CI wiring, staging first and owner merge approval preserved. The checklist's
soft-deleted review-attribution query entry is inapplicable to this tooling scope.

**Round 1 verdict: REVISE — F1–F3 require plan/intake corrections before implementation.**
