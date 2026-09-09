# #1185 — Admin bearer proxy and mutation CSRF

## Locked intent and approved delta

Implement ticket #1185 under ADR 0025 D6–D8 and ADR 0026 D7's CORS amendment. L1/L2 remain intact. The owner explicitly approved the discovered predicate mismatch resolution with “Go for it”: `isBearerRequest` continues to mean Authorization presence; reuse `readBearerToken` for shape validation. Malformed Authorization gets 401 `Unauthorized` plus `NO_STORE_HEADERS`, without cookie fallback. Neither helper nor the identity seam changes. This is resolved intake scope, not a surface amendment.

## Tracers

### T1 — Bearer reaches the canonical route gate

In `src/proxy.ts`, evaluate Admin API bearer transport before constructing the cookie client, after the existing CORS check. Exclude the exact `/api/admin/impersonation` prefix and its descendants, retaining their cookie path. Reuse `isBearerRequest` and `readBearerToken`; refuse malformed headers 401/no-store, otherwise forward original request headers/pathname using the existing downstream-request builder. Perform no bearer verification in the proxy. Cookie branch 4 remains unchanged. Precedent: existing public-path early return and shared Edge-safe transport helpers.

Public seam: `proxy()` in `src/__tests__/proxy.test.ts`. Prove no cookie client for valid bearer; cookie 401/non-admin 403 unchanged; malformed + valid cookie fails closed; no bypass on owner/admin-page/impersonation paths; refused Origin still wins; allowlisted CORS headers and forwarded Authorization survive. Blocked by merged #1184, verified at base `07aef7a73c80f4d28d091316270325d5a584dbb9`.

### T2 — Admin mutation transport wrapper

Add `withSameOriginUnlessBearer()` beside `withSameOrigin()` in `src/lib/auth/route-helpers.ts`. Delegate absent Authorization to a prebuilt `withSameOrigin()(handler)`; malformed present Authorization returns 401/no-store; well-formed bearer invokes the handler with all arguments intact. The route gate still verifies identity, role and AAL2. Owner wrapper and `assertSameOrigin` remain unchanged. Precedent: generic variadic handler wrapper already in this module. No new production file/dependency.

Public seam: existing `src/lib/auth/__tests__/route-helpers.test.ts`. Test forged/missing Origin with bearer passes wrapper, malformed bearer refuses before handler despite cookie, cookie cross/missing Origin stays 403, matching Origin cookie succeeds, owner wrapper with valid cookie plus bearer remains CSRF-checked, and route arguments/return/error propagation remain intact. Independent of T1.

### T3 — Apply the wrapper at admin mutation exports

Replace imports/export wrappers in every current admin mutation route except `impersonation/start` and `impersonation/end`; handler bodies and gate ownership remain untouched. Add transport cases to existing channel route-binding tests, exercising a real exported mutation and its canonical gate. Validate all mutation export bindings, the unchanged impersonation wrappers and the widened `ci:admin-aal2` audit. Blocked by T2. Precedent: current wrapper-at-export convention, preserving its visibility.

## Verification and reviews

Run each tracer's test red before production changes, then green. Run the feature verified gate, `pnpm build`, and independent spec/correctness, standards/maintainability and security reviews plus the high-risk red-team protocol. No rebase while the review wave runs. Three failed full gate rounds or second surface amendment stops for owner; new ADR contradictions, impersonation expansion or touched-area security alerts also stop.

The user authorizes scoped commits, feature push, staging ride and PR creation. Deploy staging using the deployment runbook and capture HTTP evidence from the exact deployed commit. Computer Use desktop/mobile user-journey evidence is required by AGENTS; investigate tool/login availability and report an explicit blocker if unavailable, without substituting another browser tool as that proof. Never mint/reset the existing staging admins. Stop with PR awaiting owner merge approval; no production writes, flag changes or migrations. After later approved merge: resolution comment with PR, staging evidence and merge SHA, then staging realignment.

## Rollback and observability

Revert this ticket's commit through a PR and restore staging to the approved baseline through the runbook. Observe allowlisted bearer calls reaching canonical JSON refusals/success without redirects, cookie CSRF failures remaining 403, and refused origins remaining 403 `origin`. Never log credentials. Expected production churn is about 100 lines across the wrapper, proxy and mechanical route bindings; test churn approximately 200 lines. Added lines protect the newly exposed authorization seam and transport combinations.
