# Security review — #1185

VERDICT: APPROVED

Reviewed HEAD `0b374b6a9b76ac4eee3222d84b47eae3e359bf4d` against BASE `07aef7a73c80f4d28d091316270325d5a584dbb9`. Scope: 131 production lines of added/deleted churn across 25 production files: 23 mutation-route bindings, the transport wrapper, and proxy. Used the supplied review brief and additional committed-object reads only. Supplied full-gate evidence: `8ab55944`; this reviewer did not run tests, exercise a browser, or perform remote actions.

## Findings

No actionable changed-area security findings at or above 80% confidence. No concrete authorization bypass, credential disclosure, cookie fallback, confused deputy, or replay regression identified.

## Boundary assessment

- ADR 0025 D6–D8 and ADR 0026 D7 are satisfied with the approved parser clarification. `src/proxy.ts` checks CORS before invoking `handleProxy`; the bearer arm runs before cookie-client construction, calls the shared header-presence predicate and parser, and forwards the original request headers and pathname through `createDownstreamRequest`. It does not treat syntactic acceptance as verified identity. Refused origins still return 403 before bearer processing.
- `src/lib/auth/route-helpers.ts:47` delegates absent Authorization to the unchanged `withSameOrigin` wrapper. Present malformed Authorization returns 401 `Unauthorized` with `NO_STORE_HEADERS`; it cannot obtain authority from a cookie. A shaped bearer passes the original request and variadic arguments to the handler, whose canonical gate remains responsible for authentication and authorization.
- All 23 changed mutation exports retain a canonical gate before protected reads or effects: 14 direct `requireAdminWithAal2` bindings, three `requireAdminJson` bindings, and six channel bindings through `resolveAdminActor`. The latter calls `requireAdminWithAal2` before reading body-selected business/account data. Existing channel flag/environment refusals can precede identity resolution; no protected action precedes it.
- Owner mutations retain `withSameOrigin`; `assertSameOrigin` and owner identity resolution are unchanged. The proxy excludes the exact `/api/admin/impersonation` path and its descendants from bearer pass-through, using the normalized path. Both impersonation exports still use `withSameOrigin` and require their existing cookie-proxy path. Owner API paths and admin pages receive no bearer shortcut.
- The unchanged identity seam gives Authorization precedence, verifies claims and expiry, performs the live `getUser` check, and loads the current application role at the canonical gate. Owner/no-user-row identities are refused 403; non-AAL2 identities are refused 403; invalid credentials are refused 401, with no cookie fallback. The new wrapper introduces no token storage, logging, refresh, verification cache, or replay mechanism. Existing mutation attribution and idempotency behavior are untouched.
- Added tests cover malformed Authorization alongside cookies, forwarded Authorization/pathname, origin rejection ordering, owner/impersonation exclusions, cookie CSRF, arguments/errors, and the channel gate's refusal preventing effects. Channel binding tests mock the canonical gate: they prove delegation and refusal propagation, not live Supabase identity verification.

## Route gate inventory

All paths below are relative to `src/app/api/admin/` at the pinned HEAD.

| Changed mutation | Canonical gate call |
|---|---|
| `autonomy/unsuspend/route.ts` POST | `requireAdminJson`, line 18 |
| `billing/grant-extension/route.ts` POST | `requireAdminWithAal2`, line 41 |
| `businesses/[id]/keywords/route.ts` PUT | `requireAdminWithAal2`, line 22 |
| `businesses/[id]/ranking/route.ts` POST | `requireAdminWithAal2`, line 24 |
| `businesses/[id]/resend-invite/route.ts` POST | `requireAdminWithAal2`, line 89 |
| `businesses/[id]/route.ts` PATCH | `requireAdminWithAal2`, line 57 |
| `businesses/[id]/zernio-queue/route.ts` POST | `requireAdminWithAal2`, line 39 |
| `businesses/route.ts` POST | `requireAdminWithAal2`, line 67 |
| `channels/{telegram,whatsapp}/{start,cancel,disable}/route.ts` six POST exports | `resolveAdminActor`; canonical gate at `src/app/api/_shared/channels/resolve-actor.ts:70` |
| `demos/generate/route.ts` POST | `requireAdminWithAal2`, line 89 |
| `flagged/route.ts` POST | `requireAdminWithAal2`, line 74 |
| `locations/csv-import/route.ts` POST | `requireAdminWithAal2`, line 53 |
| `offboardings/[offboardingId]/provider-disposition/route.ts` POST | `requireAdminWithAal2`, line 22 |
| `solicitation/batch/halt/route.ts` POST | `requireAdminJson`, line 107 |
| `solicitation/breaker/reset/route.ts` POST | `requireAdminJson`, line 30 |
| `suppressions/correct/route.ts` POST | `requireAdminWithAal2`, line 24 |
| `suppressions/lookup/route.ts` POST | `requireAdminWithAal2`, line 53 |
| `suppressions/route.ts` POST | `requireAdminWithAal2`, line 28 |

## Limits and uncertainty

This is a bounded static review of the changed area, not live credential/revocation or deployment verification. Runtime CORS delivery and real-account journeys remain the feature lead's verification responsibility. ADR 0025 already records the outstanding-token limit after factor removal; this patch neither changes nor closes it. No new uncertain security concern requires escalation from this review. No security checklist file was supplied or invented.
