# #1185 — independent spec/correctness review

VERDICT: APPROVED

Base: `07aef7a73c80f4d28d091316270325d5a584dbb9`  
Reviewed HEAD: `0b374b6a9b76ac4eee3222d84b47eae3e359bf4d`  
Required-gate fingerprint supplied by coordinator: `8ab55944040a89c01e73559101d73eafb831cfe49dec3faa4d30dc7e58d613cf`  
Production churn: **131 added + deleted lines**, across 23 mutation route files, `src/lib/auth/route-helpers.ts`, and `src/proxy.ts` (25 production files; the brief's 24-file count is a bookkeeping discrepancy).

## Scope and method

Reviewed the supplied `.feature/review-brief.md` plan, intake, approved deviations, repository rules, exact diff and every spec/correctness checklist entry. Follow-up production reads used the pinned committed object, never live production source. Concurrent red-team edits therefore do not affect this verdict. Review was read-only except this approved ignored report. No tests, browser sessions, external actions or commits were performed by this reviewer. Rule resolution for this report returned `none` through the Node/tsx entry point after the pnpm/tsx CLI encountered a sandbox IPC restriction.

ADR 0026 D7's CORS amendment and the owner's approved malformed-Authorization delta are part of the reviewed contract. Merged L1/L2 are dependencies; this review checks their composition without reopening their implementation. The requested review restrictions override verify-spec's generic additional-test, temporary-file and delegation steps.

## Actionable findings

None at or above 80% confidence. No missing mutation binding, owner-scope expansion, impersonation expansion, cookie fallback, CORS precedence regression, lost route argument, or changed handler body was found.

## Plan and intake evidence

All file references below refer to the reviewed HEAD.

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | Admin bearer reaches the route gate after CORS, without cookie client construction | VERIFIED | `src/proxy.ts:118` owns the existing CORS envelope; `:206` selects bearer before `createServerClient`; `src/__tests__/proxy.test.ts:88` asserts downstream continuation, forwarded Authorization/pathname, CORS, no redirect and zero cookie-client calls. |
| 2 | Shared presence predicate and parser, no proxy token verification | VERIFIED | Both new branches import `isBearerRequest` and `readBearerToken`; `src/lib/auth/admin-transport.ts:35` selects header presence and `:49` parses shape; proxy branch only selects/refuses/forwards. Neither shared helper changed. |
| 3 | Malformed Authorization gets 401/no-store, even beside a valid cookie | VERIFIED | `src/proxy.ts:207` and `src/lib/auth/route-helpers.ts:54` return the required JSON and `NO_STORE_HEADERS`; tests exercise empty, wrong scheme, missing token and internal whitespace, with cookie fixtures and no fallback/handler calls. |
| 4 | Bearer ignores cookie authority outside impersonation, including owner or aal1 cookies | VERIFIED | The early proxy return occurs before any cookie identity/AAL work, independent of cookie contents; the wrapper similarly never resolves cookies on its bearer arm. The unchanged canonical gate selects `resolveDualModeIdentity(request)` at `src/lib/auth/admin-mfa-gate.ts:104`. The proxy test includes an owner cookie and proves cookie client construction never occurs. |
| 5 | Missing Origin accepted for server bearer; rejected for cookie mutation | VERIFIED | Proxy bearer test includes no Origin; wrapper tests cover absent Origin with and without Authorization at `src/lib/auth/__tests__/route-helpers.test.ts:158` and `:171`. Cookie path delegates to the original wrapper. |
| 6 | Cookie proxy 401 and non-admin 403 remain | VERIFIED | Cookie branch is unchanged; `src/__tests__/proxy.test.ts:143` explicitly asserts both refusal statuses. |
| 7 | Owner APIs and admin pages do not gain bearer bypass | VERIFIED | Bearer branch requires `isAdminApiRoute(routePath)`; `src/lib/shared/protected-routes.ts` uses the exact `/api/admin` boundary. Proxy tests assert owner API 401 and admin-page login redirect. Owner gate/wrapper implementation is unchanged. |
| 8 | Exact impersonation prefix and descendants keep cookie path and existing CSRF wrapper | VERIFIED | `src/proxy.ts:204` excludes the normalized exact prefix and slash descendants. Tests cover prefix/start/end. `src/app/api/admin/impersonation/start/route.ts:119` and `end/route.ts:50` still export `withSameOrigin()` and are absent from the diff. |
| 9 | Disallowed Origin wins before bearer pass-through, allowed CORS headers survive | VERIFIED | CORS refusal/preflight remain before `handleProxy`; new tests assert disallowed Origin produces 403 `origin`, allowed Origin survives success and malformed-header refusal, and success carries `Vary: Origin`. |
| 10 | Admin-only wrapper bypasses CSRF for a well-formed bearer and preserves cookie behavior | VERIFIED | `src/lib/auth/route-helpers.ts:46` prebuilds `withSameOrigin()(handler)` once; absent Authorization delegates, malformed refuses, bearer invokes handler. Wrapper tests prove forged/missing Origin bearer acceptance and matching/cross/missing Origin cookie behavior. |
| 11 | Owner wrapper remains CSRF-checked even with cookie plus bearer | VERIFIED | `withSameOrigin` is unchanged at `src/lib/auth/route-helpers.ts:26`; new wrapper tests supply an owner cookie plus bearer and assert forbidden/missing Origin still returns 403 without invoking the handler. `assertSameOrigin` is not changed. |
| 12 | Route parameters, return identity and errors remain intact | VERIFIED | Both wrapper arms forward `(req, ...args)` and return the handler result. Tests pass a promise-valued route context through both arms, assert the same Response object, and assert thrown-error propagation at `src/lib/auth/__tests__/route-helpers.test.ts:201`. |
| 13 | Every current non-impersonation admin mutation export uses the wrapper | VERIFIED | Pinned export inventory contains 25 mutations: 23 use `withSameOriginUnlessBearer`, while the two impersonation exports retain `withSameOrigin`. This includes POST, PUT and PATCH; no DELETE export exists. Diff changes imports/export bindings plus two explanatory comment references only. |
| 14 | Canonical gate retains identity, live-user, admin-role and strict AAL2 ownership | VERIFIED | New wrapper performs no authorization. Existing gate still resolves identity, calls `loadAppUser`, refuses non-admin, then requires strict `aal2` (`src/lib/auth/admin-mfa-gate.ts:104`). Route bodies and their gate calls are unchanged. Channel resolver gate precedes request-body parsing and database work at `src/app/api/_shared/channels/resolve-actor.ts:75`. |
| 15 | Export-level transport tests reach the canonical gate and stop refused mutations | VERIFIED | `src/app/api/admin/channels/__tests__/bindings.test.ts:111` exercises all six real exported channel handlers, asserts the gate receives the same bearer request and exactly one mutation helper runs; a gate refusal returns `mfa_required` and none of the three mutation helpers runs. The gate itself is mocked: this proves binding and refusal propagation, not live Supabase identity/AAL2 verification. |
| 16 | Widened all-verb gate audit remains applicable to changed wrapper bindings | VERIFIED | Existing `scripts/ci/admin-aal2-audit.ts:563` traverses initializer/local-handler references without depending on the wrapper's name. It still credits the unchanged canonical call/resolver provenance. The audit implementation and credited gate vocabulary are unchanged by this diff. |
| 17 | Non-goals and allowed surface respected | VERIFIED | Diff does not change L1/L2 identity seams, owner auth, impersonation, API bodies, domain behavior, flags, schema, dependencies or production writers. The two authorized documentation amendments are represented in the supplied intake/deviations. |
| 18 | Documentation and observability match the implementation | VERIFIED | Architecture row and lib-platform directory describe bearer precedence, malformed 401/no-store, owner CSRF and impersonation accurately. No credential logging was introduced. Canonical JSON refusals and existing cookie/CORS refusal distinction remain. |

All eight `tests_to_add` entries have corresponding assertions at the requested public seams. The three proxy/wrapper/channel seams are exercised rather than being replaced by private-helper-only tests. Cookie fixtures in wrapper tests are incidental to transport selection; these tests appropriately prove refusal/dispatch, not that a placeholder cookie is a real authenticated session.

## Historical finding checklist dispositions

Each row below corresponds to one entry of the supplied `docs/reviews/finding-checklists/spec-correctness.md`, in source order. “Clear” means the analogous defect class was checked in this diff; “N/A” identifies a feature-specific class with no changed surface here.

| Entry | Defect class checked | Disposition |
|---|---|---|
| 1 | Guard misses alternate export spellings | Clear — retained AST audit follows handler references; current POST/PUT/PATCH inventory checked. |
| 2 | Exemption broader than its intended boundary | Clear — impersonation exclusion is exact prefix plus slash descendants, not a loose substring. |
| 3 | Guard fights an explicitly deferred feature | Clear — no new inventory guard or owner/CORS restriction added. |
| 4 | Test exercises formatting instead of deciding seam | Clear — tests invoke proxy, wrapper and real channel exports. |
| 5 | Fixture path does not determine loaded module | Clear — all six imported export identities are exercised; request pathname is irrelevant to already-bound handler selection. |
| 6 | Main goal excludes a high-traffic exception without recording it | Clear — impersonation and owner exceptions are explicit and tested. |
| 7 | Copy contradicts data source | N/A — no user-facing metric copy/query change. |
| 8 | Shared caller has a different period/context | Clear — shared helper's cookie callers retain original behavior. |
| 9 | Unconditional description contradicts null behavior | Clear — missing Authorization and malformed Authorization are explicit separate branches. |
| 10 | Claimed universal behavior is gated | Clear — proxy claim is limited to Admin API outside impersonation and after CORS. |
| 11 | Intake edge case absent without explanation | Clear — every intake edge case mapped above. |
| 12 | Breakpoint gap escapes desktop/mobile evidence | N/A — no CSS/layout change; deployment/browser evidence is outside this static review. |
| 13 | Test asserts a different component from its promise | Clear — real exported channel handlers and actual wrappers invoked. |
| 14 | Test title promises a relation it never asserts | Clear — canonical gate receives the actual request; return/context assertions are direct. |
| 15 | Wrong containing-block mechanism documented | N/A — no rendering geometry. |
| 16 | Stale deviation line citation | Clear — new deviations contain no fragile source line ranges. |
| 17 | Shared rule regresses an unenumerated third caller | Clear — new helper is opt-in; existing owner wrapper behavior is unchanged; all mutation callers inventoried. |
| 18 | Boundary condition chosen on wrong side of existing threshold | Clear — CORS precedes bearer branching; impersonation is tested before cookie bypass. |
| 19 | Failure branch does not carry adopted invariant | Clear — malformed refusal carries no-store and receives outer CORS headers; cookie refusal remains original behavior. |
| 20 | Test name claims behavior its environment cannot verify | Clear — channel tests assert binding and mocked refusal, not live identity. |
| 21 | Removal exposes unintended fallback | Clear — malformed present headers refuse instead of selecting cookie fallback. |
| 22 | Recorded evidence uses a different runtime container | Clear — tests explicitly identify their wrapper/proxy/binding seams; no live-browser assertion made. |
| 23 | Local fix unmasks a lower-priority unsafe branch | Clear — bearer presence cannot fall through to cookie handler after parsing fails. |
| 24 | Unsupported measurement claims drive implementation | Clear — new source has no unmeasured performance/geometry guarantee. |
| 25 | Identity assertion misses duplicate side effect | Clear — channel tests assert exactly one mutation helper call; refused branches assert all mutation helpers uncalled. |
| 26 | Missing environment reset invalidates measurements | Clear — new proxy tests stub and restore env; existing binding setup resets memoized server config. |
| 27 | Extreme small-size overflow | N/A — no visual surface changes. |
| 28 | Promised comparison absent, main mutant survives | Clear — bearer continuation, cookie refusal, forwarded arguments and mutation refusal use independent expected outcomes. No mutation execution claimed. |
| 29 | Accessibility edge case unimplemented/unrecorded | N/A — intake has no UI/accessibility change; all transport edges addressed. |
| 30 | Label counts wrong underlying unit | N/A — no product counting label. |
| 31 | Empty/degraded data returns meaningless copy | N/A — no data display changes; empty Authorization explicitly refuses. |
| 32 | Duplicate empty-state disclosure | N/A — no display states. |
| 33 | Realistic cadence invalidates recorded premise | Clear — caller inventory includes all existing mutation verbs and two exclusions. |
| 34 | Old test exclusion leaves new behavior unguarded | Clear — new wrapper receives dedicated tests, six channel bindings exercised, existing full gate remains applicable. |
| 35 | Durable source line citations shifted by same diff | Clear — architecture row uses symbols rather than line ranges. |
| 36 | Handoff claims an obsolete implementation phase | Clear — changed plan/deviations describe implemented scope and review/deployment requirements, not a falsely completed deployment. |
| 37 | Fixture silently overwrites intended scope | Clear — explicit Authorization/cookie/Origin fixture setup reaches the intended transport branches. |
| 38 | Count assertion misses loss of final retained event | Clear — downstream Authorization and pathname values are asserted, not just continuation count. |
| 39 | Test couples behavior to incidental paragraph count | Clear — mutation-helper call count is a real side-effect contract, not incidental structure. |
| 40 | Assertion allows duplicate disclosure | N/A — no rendered disclosure; mutation duplication is bounded by exact helper-call count. |
| 41 | SQL NULL behavior loses retained evidence | N/A — no SQL, schema or retained-data selection changes. |

## Uncertainty and verification limits

No unresolved suspected correctness defect remains in this diff. The coordinator reports the full required gate passed at the fingerprint above; this reviewer did not rerun it or independently inspect its full logs. Tests and source establish static/local seam correctness. Live token verification, the exact deployed-commit HTTP evidence, Computer Use desktop/mobile journeys and red-team mutation evidence remain owned by their separate verification steps; this report does not assert those occurred. That remaining workflow does not change this independent code-review approval.

Suite: required gate PASS (coordinator-supplied fingerprint; not rerun by reviewer) | reviewer tests SKIPPED by assignment | browser verification NOT PERFORMED by reviewer.

VERDICT: PASS — reviewed implementation claims verified; independent review verdict APPROVED.
