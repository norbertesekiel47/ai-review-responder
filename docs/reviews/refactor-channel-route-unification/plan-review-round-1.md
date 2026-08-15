# Channel route unification — adversarial plan review, round 1

## Verdict

**REVISE.** Yes: Task 2 can pass while the feature is wrong. The plan supplies several characterization tests, but it does not test the route bindings or the transaction protocol that the refactor is meant to preserve.

## High-confidence findings

| Severity | Artifact:line | Finding | Missing failing test |
|---|---|---|---|
| High | `docs/superpowers/plans/2026-08-15-channel-route-unification.md:993` | The proposed admin resolver returns 400/403/404 responses without `Cache-Control: no-store, private`, directly contradicting the locked intake's required admin response change. Task 2 checks no admin failure headers. | Parameterize admin start/cancel/disable failure cases and assert `{ 'cache-control': 'no-store, private' }`; at minimum test missing `businessId`, unknown business, and inactive start subscription. |
| High | `docs/superpowers/plans/2026-08-15-channel-route-unification.md:607` | The sole "admin and dashboard distinct" cache-label test calls only the dashboard route. If `resolveAdminActor` produced `surface: 'dashboard'`, it would pass while admin invalidations/audits were wrong. | Invoke an admin disable and an owner disable, asserting `admin.telegram.disable` and `dashboard.telegram.disable` respectively. |
| High | `docs/superpowers/plans/2026-08-15-channel-route-unification.md:1138` | No test pins token minting outside `sql.begin`, `pg_advisory_xact_lock(hashtextextended('mobile_enroll:'+accountId, 0))` inside that transaction, or lock-before-`startMobileEnrollment` ordering. All can regress with the 21 titles green. | Runner test with spies/fakes asserting mint before `begin`, exactly one `begin`, lock as its first tx query, the exact account-scoped key, and `startMobileEnrollment` after the lock. |
| High | `docs/superpowers/plans/2026-08-15-channel-route-unification.md:495` | The newly authored owner-cancel test uses a lossy queue mock: an added/reordered query consumes the next fixture and `consume` silently returns `[]`, while its success assertion checks only HTTP 200. This is the failure mode the plan itself warns about. | Make the queue strict (fail on under/over-consumption), assert all expected query texts/order, and assert the queue is empty after every test. Apply the same rule to the new 404 and disable additions. |

## Medium-confidence findings

| Severity | Artifact:line | Finding | Missing failing test |
|---|---|---|---|
| Medium | `docs/superpowers/plans/2026-08-15-channel-route-unification.md:1389` | The resolver unit proves `requireFullAccess: false` works in isolation, but no test proves all four admin cancel/disable shims bind it. They can silently gain the forbidden subscription gate. Telegram start also has no existing inactive-subscription test, so it can silently lose its required gate. | For each admin cancel/disable binding, a cancelled account returns 200/its normal disable result; add `POST /api/admin/channels/telegram/start returns 403 subscription_not_active for a cancelled account`. |
| Medium | `docs/superpowers/plans/2026-08-15-channel-route-unification.md:1045` | The resolver unit preserves a `blocked` result, but action routes/runners are never exercised with it. A blanket 404 mapping after actor resolution would leave the listed new no-account tests green. | `runChannelCancel` and `runChannelDisable` (or one route for each) return the original 402 `past_due_read_only` and 403 `subscription_not_active`/offboarding response, not 404. |
| Medium | `docs/superpowers/plans/2026-08-15-channel-route-unification.md:1138` | Only `runChannelStart` is directly tested for flag-before-auth/DB. `runChannelCancel` and `runChannelDisable` can authenticate first, leaking a disabled route to unauthenticated callers, while all listed tests still pass. Env-before-auth is likewise unpinned for every runner. | For start, cancel, and disable: disabled flag returns 404 without resolver/SQL; enabled flag plus failed env returns 503 without resolver/SQL. Use an unauthenticated resolver sentinel. |
| Medium | `docs/superpowers/plans/2026-08-15-channel-route-unification.md:466` | "admin and owner build the same wa.me deep link" invokes `buildMobileDeepLink` twice; it never invokes either route. Admin WhatsApp can retain the old prefix-only sanitizer and pass, despite the locked formatted-number fix. | POST admin WhatsApp start with `TWILIO_WHATSAPP_NUMBER='+1 (555) 123-4567'` and assert `https://wa.me/15551234567?text=start-...`; retain a matching owner route assertion. |
| Medium | `docs/superpowers/plans/2026-08-15-channel-route-unification.md:1158` | `EnrollmentDatabaseError` is neither in Task 2 nor pinned by the existing route suites. The shared runner can rethrow, mis-map, or report token material with green listed tests. | `runChannelStart` maps `EnrollmentDatabaseError` to no-store 500 `{ error: 'internal' }` and verifies `reportCaughtError` metadata excludes raw token and hash. |
| Medium | `docs/superpowers/plans/2026-08-15-channel-route-unification.md:1317` | The graph makes T2 precede T3, but Task 3 lists only T1 as a blocker. T3 can therefore implement before the declared failing eval exists. | Make T2 an explicit T3 dependency; no new runtime test required. |

## Primary-question matrix

| Concern | Can green eval still be wrong? | Required test |
|---|---|---|
| Owner resolver honours a body `businessId`/`locationId` | No, not for `resolveOwnerActor` itself: Task 2 passes a body location different from the session and asserts the session value reaches `resolveWritableAccountForLocation`. | Keep that test; optionally add a route-level version to protect every shim. |
| Admin cancel/disable subscription gate or start gate | Yes. | Binding tests above. |
| `blocked` over-applied as 404 | Yes. | Per-action blocked pass-through tests above. |
| Advisory lock / tx / token ordering | Yes. | Protocol test above. |
| Flag → env → auth ordering | Yes. | Per-runner short-circuit tests above. |
| Queue mock alignment | Yes. | Strict, asserted query mock above. |

## Plan-level review

The four-field `ChannelRouteConfig` is sufficient for the stated runners. `requireFullAccess` varies by admin action but correctly belongs inside the resolver closure rather than as a fifth runner configuration field; endpoint, deep link, and cache labels are derivable from the actor/channel/action.

T6, T7, and T8 have disjoint named files: the six admin routes, the six dashboard action routes, and dashboard status/page/directory documentation respectively. They are file-disjoint. The more material ordering defect is T2 → T3 above.

No planned implementation file falls outside the intake `allowed_edit_surface`, and the plan does not intentionally touch an intake non-goal. The proposed code, however, fails the intake's mandated admin no-store header change.

## Cited-artifact check

All specifically requested current artifacts exist and match the cited symbols:

- `src/lib/channels/disable-enrollment.ts:24` declares `surface: 'admin' | 'dashboard'`.
- `src/lib/notifications/channels/constants.ts` exports `TOKEN_TTL_MS`.
- `src/lib/shared/ids.ts` exports `asAccountId`.
- `src/lib/channels/unique-violation.ts` exports `MultipleMobileChannelsError` and `EnrollmentDatabaseError`.
- `src/lib/auth/route-helpers.ts` exports `requireRoleOr401`, `errorResponse`, and `withSameOrigin`.
- `src/lib/auth/admin-mfa-gate.ts` returns `{ ok: true, admin }`; `admin` is `AppUser` and includes `id`.
- `src/lib/config/server.ts` exposes `TELEGRAM_BOT_USERNAME` and `TWILIO_WHATSAPP_NUMBER` through `getServerConfig()`.
- `src/lib/notifications/channels/__tests__/flags.test.ts` table-tests both Telegram and WhatsApp flag accessors.
- `AppUser` in `src/lib/db/auth.ts` has both `id` and `locationId`, so `user.id` is valid for the audit actor.

The plan's other missing paths are explicitly created by earlier tasks (for example `src/app/api/_shared/channels/resolve-actor.ts` in T4 and the moved env/deep-link files in T3), so they are not broken citations. `src/app/(authenticated)/settings/channels/page.tsx` also exists; a naive extension-only path scan must not misclassify it because its filename is `page.tsx`.

## Low-confidence appendix

The plan's claim about the historic Telegram `??`/`||` divergence is not reproducible in this worktree: both current start routes use the trim-plus-`||` fallback. It is harmless historical wording because Task 1 says the earlier PR already patched it, but it should be phrased as a previously closed divergence rather than as a current code fact.
