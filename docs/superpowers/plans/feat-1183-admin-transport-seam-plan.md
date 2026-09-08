# Plan — #1183 Admin transport seam + dual-mode `requireAdminWithAal2`

Branch `feat/1183-admin-transport-seam`. Fork point `4aa132ba`.

Sources of truth, referenced by path, never restated:

- Intake (locked): `docs/superpowers/plans/feat-1183-admin-transport-seam-intake.json`
- Design of record: `docs/adr/0025-dual-mode-admin-gate.md` D1–D4, D9, D10 (+ D7 as
  amended by `docs/adr/0026-admin-api-cors.md` D7)
- Ticket: GitHub #1183 (map #1159). Sign-off is INHERITED from the ticket body per
  `docs/superpowers/plans/2026-09-08-admin-split-orchestrator-handoff.md` §4 —
  the ticket IS the locked intent; only deltas were grilled.
- Glossary: `docs/context/core-accounts-channels-admin.md` → **Admin transport**,
  **Verified admin**, **Channel actor**, **Admin app**, **Admin API**
- Research (facts, not design): `docs/research/admin-bearer-auth.md` on branch
  `research/admin-bearer-auth`

## Module design (`codebase-design` pass)

| Module | Deepen or new | Why |
|---|---|---|
| `src/lib/auth/admin-transport.ts` | **new interface, forced** | ADR 0025 D6 and the **Admin transport** glossary entry require ONE predicate that `src/proxy.ts` (Edge) and the identity seam both import. It cannot live in `verified-identity.ts`, which constructs Supabase clients and is not Edge-safe. Two exports, zero dependencies. |
| `src/lib/auth/verified-identity.ts` | **new interface, forced** | ADR 0025 D1: the transport branch lives BELOW the gates, not inside `requireRole`. Deep module — two sibling resolvers and one small result type hide two client shapes, two AAL sources, and the `getClaims`-then-`getUser` order. |
| `src/lib/db/auth.ts` | **deepen** | Extract `loadAppUser(authUserId)` from `getCurrentUser` (ticket item 3). The file is an invariant-#15 composition root (`scripts/ci/db-imports-audit.ts:112`), so it keeps its `sql` import and the seam never needs one. `getCurrentUser` becomes a two-step composition; its behaviour is unchanged for the ~40 owner routes. Interface widens by exactly one export. |
| `src/lib/auth/admin-mfa-gate.ts` | **deepen** | `requireAdminWithAal2` is re-pointed at the seam. Exported names and result shapes are UNCHANGED, so `ci:admin-aal2`'s allowlist and its three credited gate shapes are untouched, and `requireAdminJson` / `resolveAdminActor` inherit dual mode by composition. |

Nothing widens beyond `loadAppUser`. No logic is scattered across seams: the gate is
the only decider, the seam only reports facts, the predicate only parses a header.

## Contracts this plan is bound by

### The transport predicate (`admin-transport.ts`)

- `isBearerRequest(request)` — `request.headers.has('authorization')`, nothing more.
  Presence ALONE is the TRANSPORT choice, and it suppresses the cookie. An empty or
  whitespace-only value counts as present (round 1 finding 1: a "non-empty" test
  would let `Authorization: ` fall back to the cookie, which the locked intake
  forbids).
- `readBearerToken(request)` — the token from `Authorization: Bearer <token>`
  (scheme case-insensitive per RFC 7235; the token is a single `token68` with no
  internal whitespace, so `Bearer t extra` is malformed), or `null` when the header
  is absent or malformed.
- Edge-safe: no `node:` import, no DB, no Supabase client, no `process.env`.

Resolved delta (recorded in the intake `edge_cases`): the ticket's owed test
*"a malformed Authorization header does not fall back to the cookie"* binds
`isBearerRequest` to header PRESENCE, while ADR 0025 D6 describes `src/proxy.ts`
passing through a *well-formed* bearer. Both primitives are exported, so #1185
chooses `readBearerToken(...) !== null` if it wants well-formedness.

The adjudication, corrected per round 1 finding 10: **no request is accepted under
one reading and refused under the other.** A malformed `Authorization` header either
meets a refusal at the proxy, or reaches the canonical gate — where header presence
selects the bearer arm, `readBearerToken` returns `null`, and the answer is 401
`{ error: 'Unauthorized' }`. It can never authenticate through the cookie at that
gate. (The earlier claim that a malformed header always draws a proxy 401 was too
broad: a request carrying a valid admin cookie passes branch 4 today. What is true
is that it cannot pass the GATE.) Not an ADR contradiction; `src/proxy.ts` is a
non-goal here.

### The identity seam (`verified-identity.ts`)

```
VerifiedIdentity = { authUserId: string; aal: string | null; transport: 'cookie' | 'bearer' }
```

`aal === null` means "no readable assurance level" and maps to `mfa_check_failed`;
a readable non-`aal2` maps to `mfa_required`. The seam decides NOTHING — no role
check, no AAL enforcement, no flag read.

- `resolveCookieIdentity(request)` — today's path (ADR D4, untouched):
  `cookieBackedServerClient` → `getUser()`; AAL from `getAuthenticatorAssuranceLevel()`.
- `resolveDualModeIdentity(request)` — bearer when `isBearerRequest`, else
  **delegates to** `resolveCookieIdentity`. Two sibling functions, never one with a
  posture parameter (ADR D2, the **Channel actor** rule).
- Bearer arm, in this order (ADR D3): `auth.getClaims(jwt)` for the verified
  signature and `claims.aal`, THEN `auth.getUser(jwt)` for liveness. Client built
  with `persistSession: false, autoRefreshToken: false`.
  `getAuthenticatorAssuranceLevel(jwt)` is NEVER used (research finding 2b).
- `authUserId` comes from `claims.sub` — the verified source owns the identity.

#### Failure classification in the bearer arm (round 1 finding 7)

Measured in `@supabase/auth-js@2.106.2`
(`node_modules/.pnpm/@supabase+auth-js@2.106.2/.../GoTrueClient.js`, `getClaims`):
its own `catch` **returns** `{ data: null, error }` when `isAuthError(err)` and
**rethrows** otherwise. So the two failure channels do not line up with auth vs
infra:

- an **expired** token throws a plain `Error('JWT has expired')` from `validateExp`
  (`lib/helpers.js:270-276`) — NOT an `AuthError` — so it escapes `getClaims` as a
  throw, and it must still be **401** per the ticket's table;
- a **JWKS fetch failure** raises `AuthRetryableFetchError`, which IS an `AuthError`,
  so it comes back as a **returned** error — and mapping it to 401 would turn a
  Supabase outage into a silent lock-out of every admin with no alertable signal.

So "thrown ⇒ 500, returned ⇒ 401" is wrong in both directions.

**Round 2 caught a regression in the first attempt at this table** (its finding 7):
a catch-all "everything else ⇒ 401" swallows a GoTrue HTTP 500 and an unexpected
`TypeError` alike. Verified in `lib/fetch.js`: `handleError` raises
`AuthRetryableFetchError` for a transport failure and for statuses
`502,503,504,520-524,530` only (`:20-30`), and **everything else — including a plain
HTTP 500 — becomes `AuthApiError(message, status || 500, code)`** (`:72`), which is
an `AuthError` and therefore comes back RETURNED, where the catch-all would have
called it a bad credential.

The expiry throw is removed from the picture rather than pattern-matched: the bearer
arm calls `getClaims(jwt, { allowExpired: true })` and enforces `exp` itself with
auth-js's own zero-leeway rule (`exp <= Math.floor(Date.now()/1000)`,
`lib/helpers.js:270-276`). Rejecting `allowExpired: false` + matching
`err.message === 'JWT has expired'`: that is message-matching on an SDK-internal
string, which the house rule at `src/lib/auth/reset-password-error.ts:1` forbids
("matched on `code`, not message") and which a patch release can silently break.
Expiry stays closed twice over — this explicit check, and `getUser(jwt)`, which the
Auth server rejects for an expired token anyway.

`decodeJWT` throws `AuthInvalidJwtError` (`lib/helpers.js:142-151`), an `AuthError`,
so a garbage token still arrives through the RETURNED channel and is a 401.

**Round 3 killed the second attempt too**, and a live probe found the same hole
independently. `getClaims` does NOT funnel every attacker-supplied bad token through
its `AuthError` catch: `decodeJWT` regex-checks the three segments and then
`JSON.parse`s the decoded bytes (`lib/helpers.js:153-157`), so a token that is
well-formed base64url but not well-formed JSON escapes as a raw `SyntaxError`.
Measured against the installed SDK:

```
$ node -e "…createClient(…).auth.getClaims(t, { allowExpired: true })…"
"aaaa.bbbb.cccc"           -> THREW Error       | Invalid UTF-8 sequence
"eyJhIjox.eyJiIjoyfQ.cccc" -> THREW SyntaxError | Expected ',' or '}' after property value
"abc"                      -> returned error: AuthInvalidJwtError
""                         -> returned { data: null, error: null }
```

Round 3 adds `ew.e30.AA` (header decodes to `{` → `SyntaxError`) and `bnVsbA.e30.AA`
(header decodes to `null` → `header.alg` `TypeError`). So "any thrown error ⇒ 500"
lets an UNAUTHENTICATED caller force 500s on the admin control plane with a
two-character token — wrong against the ticket's table (bad token ⇒ 401) and a
free alert-noise vector against the very signal the 500 arm exists to preserve.

The resolution is scope, not a longer error taxonomy. **The seam's `try` wraps each
SDK `await` and nothing else** — those two awaits are the only places
attacker-controlled bytes are parsed:

| Outcome of `getClaims(jwt, {allowExpired:true})` / `getUser(jwt)` | Result |
|---|---|
| returned error where `isAuthRetryableFetchError(error)` | **rethrow** → the gate's existing 500 `{ error: 'internal_error' }` + its `console.error` |
| returned error named `AuthUnknownError` | **rethrow** → 500 — `await error.json()` threw, so whatever answered was not GoTrue (an HTML 502 from a CDN, a WAF block page, a truncated body). Added by the review wave: it is neither of the other two names, so the first version of this table turned exactly that outage into 401s. Found independently by the adversarial pass and the red team. |
| returned error where `isAuthApiError(error) && (error.status ?? 500) >= 500` | **rethrow** → 500 |
| any other returned `error` — `AuthInvalidJwtError`, `AuthSessionMissingError`, a 4xx `AuthApiError` — or `data === null` with no error | unauthenticated → **401** |
| **thrown out of either await** (`SyntaxError`, `TypeError`, `Error`) | unauthenticated → **401** — this is the malformed-token boundary |
| claims returned, but `exp` missing or `exp <= Math.floor(Date.now()/1000)` | unauthenticated → **401** (expired) |
| `getUser` returns `{ user: null }` | unauthenticated → **401** (the revocation arm) |
| anything thrown OUTSIDE those two awaits — client construction, our own logic, `loadAppUser` | propagates to the gate's catch → **500** |

Scoping the catch tightly costs no observability, and that is verifiable rather than
hoped: an infrastructure fault reaches us through the RETURNED channel in both
calls, because `_request` → `handleError` raises an `AuthError`
(`lib/fetch.js:24-30, 72`) which `getClaims` and `getUser` each catch via
`isAuthError` and return. The two rethrow rows above are therefore the complete
infra arm.

`isAuthRetryableFetchError` and `isAuthApiError` compare `error.name`
(`lib/errors.js:49-51, 222-224`), so they survive a duplicated module instance in a
way `instanceof` would not.

**Corrected after the review wave** (adversarial finding 2, red-team P1-2): the
earlier wording here — "a 500 someone is paged for" — was an unproven claim about
alerting. `internalError` writes a `console.error` and returns a response; it does
not emit a Sentry exception, `src/instrumentation.ts` has no console-capture
integration, `onRequestError` only fires for errors that ESCAPE a handler (this one
is caught), and `docs/runbooks/beta-launch-alerting.md` has no admin-5xx row. What
the classification actually buys is that the SIGNAL IS CORRECT: an outage is a 500
in the logs and a distinguishable status, instead of being laundered into 401s that
look like bad credentials. Routing it to an alert sink is real work and its own
ticket; this change gives that ticket something true to alert on.

**The classification applies to the BEARER arm only.** Review found that applying it
to `resolveCookieIdentity` silently moved two more cookie answers (a Supabase fault
went 401 → 500, and an AAL fault `mfa_check_failed` → 500), which ADR 0025 D4 and
the ticket's "byte-for-byte… Do not touch it" forbid. Reverted; a test now pins the
cookie arm's pre-ticket answers.

### The gate (`admin-mfa-gate.ts`)

`resolveDualModeIdentity` → `loadAppUser(authUserId)` → role check → strict
`aal === 'aal2'`. `MFA_ENFORCEMENT_ENABLED` is never read (ADR D10).

| Case | Response |
|---|---|
| No token, bad signature, expired, or revoked (and: no cookie session) | 401 `{ error: 'Unauthorized' }` |
| Verified, but no `users` row or role is not `admin` | 403 `{ error: 'Forbidden' }` |
| Verified, `aal` is not `aal2` | 403 `{ error: 'mfa_required' }` |
| `aal` claim missing or unreadable | 403 `{ error: 'mfa_check_failed' }` |
| Unexpected throw | 500 `{ error: 'internal_error' }` (unchanged) |

Every **gate** refusal carries `NO_STORE_HEADERS` and none is a redirect. This is a
statement about the gate only: `withSameOrigin()`'s own 403 is
`NextResponse.json({ error: 'forbidden' }, { status: 403 })` with NO cache header
(`src/lib/auth/route-helpers.ts:33`), it is unchanged by this ticket, and test 9
asserts that shape rather than the gate's (round 1 finding 9).

Two deliberate cookie-path deltas, both bound by the ticket's table and recorded in
the intake `edge_cases`:

1. Verified cookie session with NO `users` row: today 401 `Unauthorized`
   (`requireAuth` → `getCurrentUser` returns null); after this, 403 `Forbidden`.
2. Cookie `getAuthenticatorAssuranceLevel` returning `{ currentLevel: null }` with
   no error: today `mfa_required`; after this, `mfa_check_failed`. Unreachable after
   a successful `getUser` (a live session always carries `aal1` or `aal2`).

## Tracer bullets

T1 is the eval task and lands FIRST, as failing tests, before any implementation.

| # | Tracer | Blocked by | Files | Turns green |
|---|---|---|---|---|
| **T1** | **Eval — the 11 owed tests, verbatim titles, failing** | — | `src/lib/auth/__tests__/admin-transport-seam.test.ts` | (authors them) |
| **T2** | The transport predicate | T1 | `src/lib/auth/admin-transport.ts`, `src/lib/auth/__tests__/admin-transport.test.ts` | *a malformed Authorization header does not fall back to the cookie* (partly) |
| **T3** | The identity seam | T2 | `src/lib/auth/verified-identity.ts`, `src/lib/auth/__tests__/verified-identity.test.ts` | *bearer expired*, *bearer revoked (the getUser arm)*, *bearer with a forged signature* |
| **T4** | `loadAppUser` extraction + gate rewire | T3 | `src/lib/db/auth.ts`, `src/lib/db/__tests__/auth.test.ts`, `src/lib/auth/admin-mfa-gate.ts`, `src/lib/auth/__tests__/admin-mfa-gate.test.ts` | all remaining owed tests |
| **T5** | Migrate the 22 admin route suites' auth fixtures | T4 | the 22 `src/app/api/admin/**/__tests__/*.test.ts` entries added to the surface | keeps `pnpm test` green |
| **T6** | Directory rows | T4 | `docs/directory/lib-platform.md` | `ci:directory-map` |

Every tracer is a vertical slice that runs end to end. No two are mutually
independent (T3 imports T2; T4 imports T3; T5 depends on T4's new module shapes;
T6 documents T2+T3), so the whole set is serial. Per
`.agents/skills/feature/references/execution-lanes.md` § Standard, the root
implements the first tracer to establish precedent and delegates later work only
when tasks have disjoint edit leases — none do here, so implementation stays in
this #1183 feature session (round 1 finding 11 corrected an earlier citation of the
SMALL/high-risk lane, which does not apply to a `standard`/`high` intake).

### T5 is a surface amendment, not scope creep

Round 1 finding 8, verified: 22 admin route suites `vi.mock('@/lib/db/auth', …)`
with a factory supplying only `requireRole` / `cookieBackedServerClient` /
`AuthError`, and `vi.mock('@/lib/auth/mfa', …)` supplying
`requireCurrentAal2FromSupabase`, while executing the REAL gate. Once the gate calls
`resolveDualModeIdentity` + `loadAppUser`, those factories no longer satisfy it and
all 22 fail. Enumerated with:

```
for f in $(rg -l "vi.mock\('@/lib/db/auth'" src --glob '**/*.test.ts*'); do
  rg -q "requireCurrentAal2FromSupabase" "$f" && echo "$f"; done
```

The migration touches **test fixtures only** — no `route.ts` changes, so the #1184
non-goal holds, and no `scripts/ci/admin-aal2-audit.ts` change, so the allowlist
non-goal holds. Recorded as surface amendment #1
(`bash scripts/feature-state.sh incr-amendment`, `surfaceAmendments=1`), both intake
copies updated, `estimated_test_lines` 470 → 700. A SECOND amendment is a hard stop.

## Definition of done, as failable evidence

The eval is the 11 verbatim titles in `tests_to_add`. Each is a behavioural
assertion on status + JSON body + `Cache-Control`, not a call-count assertion:

Every refusal case below asserts **status + exact JSON body + `Cache-Control:
no-store, private` + the absence of a `Location` header**, except test 9, which is
the CSRF wrapper's own shape (see above).

1. **cookie ok** — cookie session, admin role, `currentLevel: 'aal2'` → `{ ok: true, admin }`; `transport` never leaks into the gate's result shape.
2. **bearer ok** — `Authorization: Bearer t`, `getClaims('t')` → `{ sub, aal: 'aal2' }`, `getUser('t')` → a user, admin row → `{ ok: true, admin }`. Asserts `getUser` was called **with `'t'`** — a stub that merely records "some getUser happened" does not prove the presented bearer was checked (finding 2).
3. **bearer aal1** — `claims.aal === 'aal1'` → 403 `mfa_required`.
4. **bearer non-admin** — `users.role === 'owner'` → 403 `Forbidden`.
5. **bearer with no users row** — `loadAppUser` → null → 403 `Forbidden`.
6. **bearer expired** — `getClaims(jwt, {allowExpired:true})` returns claims whose `exp` is in the past → 401 `Unauthorized`, and `getUser` is NOT called. A second case covers `exp` absent entirely.
7. **bearer revoked (the getUser arm)** — `getClaims('t')` verifies `{ sub, aal: 'aal2' }`; `getUser('t')` returns `{ data: { user: null }, error }`; **a valid admin cookie session is also present**. → 401 `Unauthorized`, with no cookie fallback and the cookie client never constructed (finding 2). This is the test that fails if someone "optimizes" `getUser` away or adds a fallback.
8. **bearer with a forged signature** — `getClaims` returns `{ data: null, error: AuthInvalidJwtError }` → 401 `Unauthorized`, `getUser` NOT called.
9. **cookie + cross-origin still 403** — `withSameOrigin()(handler)` over the gate, cookie session valid, `Origin` from another host → 403 `{ error: 'forbidden' }`, **no `Cache-Control`** (the wrapper sets none), and the gate never entered.
10. **an owner route rejects a bearer** — `requireRoleOr401(req, 'owner')` against the REAL `db/auth`, with a valid owner bearer and NO cookie → 401.
11. **a malformed Authorization header does not fall back to the cookie** — parameterized over `''`, `'   '`, `'Basic abc'`, `'Bearer'`, `'Bearer  '`, `'Bearer t extra'`, each alongside a VALID admin cookie session whose AAL would return `aal2` → 401 `Unauthorized` in every case, and the cookie client is never constructed (finding 1).

Added by the round 1 review, and added to the intake's `tests_to_add`:

12. **unreadable AAL returns mfa_check_failed on both transports** — bearer `claims.aal` missing / `null` / non-string with a successful `getUser` and an admin row; and cookie AAL returning an error, no data, or `{ currentLevel: null }` with no error → 403 `mfa_check_failed` (finding 3). Without this, an implementation that collapses `mfa_check_failed` into `mfa_required` passes everything else.
13. **cookie aal1 remains forbidden without an enrolled factor** — cookie `{ currentLevel: 'aal1', nextLevel: 'aal1' }` → 403 `mfa_required`. Pins the STRICT test against a regression to the proxy's lenient `nextLevel` form, with `MFA_ENFORCEMENT_ENABLED` unset (finding 3).
14. **requireRole remains cookie-only for admin and mixed roles** — no cookie, plus a bearer whose claims/user identify an `aal2` **admin**: `requireRoleOr401(req, 'admin')` → 401, and `requireRole(req, 'owner', 'admin')` throws `AuthError('Unauthorized', 401)`. Test 10 alone is passed by an implementation that turns bearer on only when the roles include `admin` (finding 4).
15. **cookie authentication failures preserve the refusal contract** — no `Authorization`; the AAL read would return `aal2`; parameterized over cookie `getUser()` returning `{ data: { user: null }, error: null }` AND `{ data: { user: null }, error: new AuthSessionMissingError() }` (round 2 finding 5 — the revoked-cookie variant, without which an implementation that throws a returned cookie error into the gate's 500 handler still passes) → 401 `Unauthorized` in both.
16. **verified cookie without an application user is Forbidden** — cookie `getUser()` succeeds, AAL2, `loadAppUser` → null → 403 `Forbidden`. Pins declared cookie delta #1 (finding 5).
17. **identity mapping uses users.auth_id, never users.id** — `loadAppUser` exercised for REAL against a tagged-template `sql` double (`@/lib/db/server` mocked, the `mkSql` recorder pattern from `src/app/api/_shared/channels/__tests__/resolve-actor.test.ts`). The assertion is **column-adjacent-to-placeholder**: for the `strings`/`values` pair the tag receives, the fragment `strings[i]` sitting immediately before `values[i] === authUserId` must **END with `u.auth_id =`** (trailing whitespace tolerated), and there must be exactly one such bound value. Round 3 R3-1 rejected the weaker wording "the preceding fragment CONTAINS `u.auth_id`": a whole tagged template can be one fragment, so `SELECT u.auth_id … WHERE u.id = ${authUserId}` satisfies "contains" while binding the wrong column. The test carries that exact string as a **rejected-assertion case** so the assertion's own strength is pinned. Substituted for round 1 finding 6's live-DB fixture proposal, which would make the branch `db_touching` and add a gate row that SKIPs loudly without `TEST_DATABASE_POOL_URL`; round 2 confirmed the substitution catches the transposition.
18. **a Supabase transport fault is internal_error, not Unauthorized** — parameterized over: `AuthRetryableFetchError` returned by `getClaims`; `AuthApiError` with `status: 500` returned by `getClaims`; the same two from `getUser`; an unexpected thrown `TypeError` from `getClaims`; and `loadAppUser` throwing. All → 500 `{ error: 'internal_error' }`, no-store, no redirect (round 1 finding 7, corrected by round 2 finding 7). A returned `AuthApiError` with a **4xx** status stays 401 — the same test pins that boundary.
19. **the bearer client is built with persistSession and autoRefreshToken off** — asserts the options passed to `createClient`, so the ADR D3 client posture cannot silently regress into one that writes a session.
20. **malformed JWT JSON and header shapes remain Unauthorized** — the REAL SDK decode path (no `getClaims` stub) with `Bearer ew.e30.AA` (header decodes to `{` → `SyntaxError`) and `Bearer bnVsbA.e30.AA` (header decodes to `null` → `header.alg` `TypeError`), plus `Bearer aaaa.bbbb.cccc` (invalid UTF-8) → 401 `Unauthorized`, no-store, no `Location`, and **no network call**. Round 3 finding 7: without this, an unauthenticated caller turns a two-character token into a 500. This is the test that fails if the seam's `try` is ever widened past the two SDK awaits, or narrowed to catch only `AuthError`s.
21. **a returned 4xx AuthApiError stays Unauthorized** — pins the 4xx/5xx boundary from the other side of test 18.

**Can this eval pass while the feature is still wrong?** The guards, each tied to a
concrete wrong implementation: 2+7 kill a `getClaims`-only bearer path AND a
revoked-bearer cookie fallback; 11 kills every malformed-header fallback shape; 14
kills a role-conditional bearer arm; 12+13 kill a collapsed AAL vocabulary and a
regression to the proxy's lenient check; 17 kills a `users.id`/`users.auth_id`
transposition in the extraction; 18 kills a blanket catch that turns a Supabase
outage into 401. Tests 9 and 10 are the two non-widening proofs — they fail if CSRF
or `requireRole` were touched.

## Verification

Gate rows beyond the standard set (from the intake `verification_commands`):
`pnpm vitest run src/lib/auth/__tests__ src/lib/db/__tests__`, `pnpm ci:admin-aal2`,
`pnpm ci:db-imports`, `pnpm ci:directory-map`.

## Rollback

Single PR, no migration, no flag. Revert the merge commit; the gate returns to
cookie-only. Nothing outside this repo depends on the bearer arm yet —
`src/proxy.ts` still 401s a bearer-only request at branch 4 (#1185) and no CORS
exists (#1186).

## Review appendix

### Codex plan-skeptic, round 1 — `VERDICT: REVISE`

Session id `01a07ec1-2cea-75f3-bcb4-aac113e41fbb` (resume this id for the
verification round; never start one cold). Full transcript:
`.feature/logs/codex-plan-round1-report.md`.

| # | Sev | Disposition |
|---|---|---|
| 1 | P1 | **ACCEPTED.** `isBearerRequest` is now `headers.has('authorization')` — pure presence. Test 11 parameterized over six shapes. My plan text ("non-empty") contradicted my own intake `edge_cases`; the intake was right. |
| 2 | P1 | **ACCEPTED.** Test 7 now carries a valid admin cookie and a token-sensitive `getUser('t')` assertion. Codex also correctly corrected me: a total `getUser` omission already fails tests 2 and 7 — the real hole was the cookie-fallback-after-revocation path. |
| 3 | P1 | **ACCEPTED.** New tests 12 and 13 — the refusal table's `mfa_check_failed` row and the strict cookie `aal1` case had no coverage at all. |
| 4 | P1 | **ACCEPTED.** New test 14. A bearer arm enabled only for `admin` roles passed the original test 10. |
| 5 | P1 | **ACCEPTED.** New tests 15 and 16. Codex independently confirmed both declared cookie deltas are implied by the ticket's shared refusal table and that **no existing test pins the old responses** — checked in `src/lib/db/__tests__/auth.test.ts`, which only covers the cookie adapter. |
| 6 | P1 | **ACCEPTED, fix substituted.** New test 17 proves `u.auth_id` binding against a tagged-template `sql` double instead of live-DB fixtures. Same defect class, no `db_touching` flip, no loud gate SKIP without `TEST_DATABASE_POOL_URL`. Reasoning recorded above at test 17. |
| 7 | P2 | **ACCEPTED, and sharpened.** Codex was right that expiry and infra faults must not collapse. Reading `GoTrueClient.js` showed the split is worse than stated — `getClaims` rethrows non-`AuthError`s and RETURNS `AuthError`s, so expiry (a plain `Error`) throws while a JWKS outage (`AuthRetryableFetchError`) returns. Rule rewritten by exported type, never message; new test 18. |
| 8 | P2 | **ACCEPTED.** 22 suites verified to break. Surface amendment #1; new tracer T5. |
| 9 | P2 | **ACCEPTED.** The blanket "all refusals carry NO_STORE_HEADERS" would have made a correct test 9 fail: `withSameOrigin` sets no cache header. Scoped to gate refusals. |
| 10 | P2 | **ACCEPTED.** Predicate proof corrected: the sound claim is that a malformed header can never authenticate at the GATE, not that the proxy always 401s it. |
| 11 | P2 | **ACCEPTED.** Lane citation corrected to `execution-lanes.md` § Standard. |
| 12 | P2 | **REJECTED — not a plan finding.** It reports Codex's own `.codex/hooks/stop-gate.sh` asking for a gate during a read-only review. That is the reviewer's harness, not this plan's contract; the review was correctly run read-only, and this run's gate is step 5's job. |

The contract surface moved (refusal classification, predicate definition, tracer
set, edit surface), so `contract-changed` reported CHANGED and a verification round
was owed — resumed from the session id above, not cold.

### Round 2 — verification-only, `VERDICT: REVISE`

Transcript `.feature/logs/codex-plan-round2-report.md`. Nine of eleven **ADDRESSED**,
including two independent confirmations worth keeping: the 22-suite enumeration is
**complete** (of 29 admin suites, four use role-only gates and three mock the admin
gate; global setup adds no hidden auth mocks), and the SQL-double substitution for
round 1 finding 6 **does** catch the column transposition. Two rows stayed open:

| # | Verdict | Disposition |
|---|---|---|
| 5 | NOT ADDRESSED (partial) | **ACCEPTED.** Test 15 gained the revoked-cookie variant (`AuthSessionMissingError` alongside `error: null`). Without it, an implementation that throws a returned cookie error into the gate's 500 handler passed. |
| 7 | **REGRESSION** — introduced by my round 1 fix | **ACCEPTED.** My catch-all "everything else ⇒ 401" swallowed a GoTrue HTTP 500: `handleError` only raises `AuthRetryableFetchError` for a transport failure and statuses `502,503,504,520-524,530`; every other status becomes `AuthApiError(status || 500)` (`lib/fetch.js:20-30,72`). Table rewritten with an explicit `>= 500` arm and test 18 parameterized. |

### Round 3 — verification-only, `VERDICT: REVISE`. Budget cap reached.

Transcript `.feature/logs/codex-plan-round3-report.md`. Finding 5 **ADDRESSED**.
Two rows remained, and BOTH are accepted and fixed above:

| # | Verdict | Disposition |
|---|---|---|
| 7 | NOT ADDRESSED (partial) | **ACCEPTED.** Confirmed `allowExpired: true` skips only `validateExp` and leaves signature verification intact — but found attacker-supplied token shapes (`ew.e30.AA`, `bnVsbA.e30.AA`) that escape `getClaims` as `SyntaxError`/`TypeError`, which the rule would have turned into 500s. **This session's own live probe against the installed SDK found the same hole independently, before reading round 3** (transcript in the classification section above). Fixed by scoping the seam's `try` to the two SDK awaits; new test 20. |
| R3-1 | **REGRESSION** — introduced by my round 2 fix | **ACCEPTED.** Test 17's "preceding fragment CONTAINS `u.auth_id`" is satisfied by `SELECT u.auth_id … WHERE u.id = ${authUserId}`, because a whole template can be one fragment. Tightened to "the fragment adjacent to the bound value ENDS WITH `u.auth_id =`", with that counterexample carried in the test as a rejected-assertion case. |

**No round 4 was run, and the plan is treated as approved.** `.claude/commands/feature.md`
§3 step 4 caps the loop at three rounds and says to surface the remaining
DISAGREEMENT to the owner. There is none: on both open rows the reviewer and this
session reached the same conclusion from independent evidence, and each fix was
prescribed rather than disputed. What the cap forbids is another adversarial round,
not applying an agreed fix — so both were applied and self-verified against the
findings table, per the same section's `UNCHANGED` guidance. Anything a fourth round
would have caught is now the step 7 review wave's and the red team's job, against
real code rather than prose.
