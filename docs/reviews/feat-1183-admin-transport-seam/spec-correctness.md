# Spec & correctness review — `feat/1183-admin-transport-seam`

- Worktree: `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-1183-admin-transport-seam`
- Range reviewed: `4aa132ba..344dcbc0` (39 files, +2961/-90)
- Axis: does the diff do what the LOCKED intake, ticket #1183 and ADR 0025/0026 promised — and only that.
- Read-only review. No file was edited, no gate was run.

## Verdict

The branch implements the locked contract accurately. The refusal table is
byte-for-byte correct in the code (not merely in the tests), every non-goal
holds, all 21 `tests_to_add` titles exist verbatim and none is vacuous, and the
22-suite shim keeps the migrated authorization tests failable.

Two findings, one of which is the "hunt for a third undeclared cookie-path
behaviour change" the brief asked for. Neither is a security weakening; both
fail closed.

---

## 1. Contract-by-contract check

### 1.1 Refusal contract, read from the code

`src/lib/auth/admin-mfa-gate.ts:86-118`:

| Case | Code path | Response |
|---|---|---|
| seam returns `null` | `if (!identity) return refuse(401,'Unauthorized')` | 401 `{error:'Unauthorized'}` |
| no `users` row / role ≠ admin | `if (!admin \|\| admin.role !== 'admin')` | 403 `{error:'Forbidden'}` |
| `aal === null` | `refuse(403,'mfa_check_failed')` | 403 `{error:'mfa_check_failed'}` |
| `aal !== 'aal2'` | `refuse(403,'mfa_required')` | 403 `{error:'mfa_required'}` |
| throw (seam transport fault, `loadAppUser`) | `internalError(...)` | 500 `{error:'internal_error'}` |

`refuse` is a single closure that always passes `NO_STORE_HEADERS`, and
`internalError` (unchanged, `:16-24`) does the same. Nothing in the gate
constructs a redirect and `NextResponse.json` cannot emit a `Location`. The
`mfa_check_failed` test precedes the `mfa_required` test, so the intake's
"unreadable AAL → `mfa_check_failed`, readable non-aal2 → `mfa_required`"
ordering is right, not accidentally inverted. Matches ADR 0025 D9 and the
ticket's table exactly. **PASS.**

### 1.2 The seam and the predicate

- `src/lib/auth/admin-transport.ts` — zero imports, no `node:`, no
  `process.env`, no DB, no Supabase client. Edge-safe as ADR 0025 D6 requires.
  `isBearerRequest` is `headers.has('authorization')` (presence, per the locked
  intake); `readBearerToken` is `/^Bearer[ \t]+([^\s]+)$/i` over a trimmed
  header, so `Bearer t extra` is malformed. The two can only ever converge on a
  refusal, never on an acceptance — the invariant the intake names. **PASS.**
- `src/lib/auth/verified-identity.ts` — two sibling resolvers, no posture
  parameter (ADR D2). Bearer arm order is `getClaims` → `exp` → `sub` →
  `getUser(jwt)` (ADR D3); the client is built with
  `persistSession:false, autoRefreshToken:false`;
  `getAuthenticatorAssuranceLevel(jwt)` is never used. `authUserId` comes from
  `claims.sub`, the verified source (invariant #8). No role check, no AAL
  enforcement, no flag read. Does not import `@/lib/db/server` (invariant #15).
  **PASS.**
- Failure classification matches the plan's table line for line: each SDK
  `await` is wrapped individually (`:145-150`, `:160-165`), a throw from either
  is 401, and the 500 arm is driven by the RETURNED error type via
  `isTransportFailure` (`:65-68`), which is `isAuthRetryableFetchError ||
  (isAuthApiError && (status ?? 500) >= 500)`. Verified against the installed
  `@supabase/auth-js@2.106.2`: `getClaims(jwt, options)` accepts `allowExpired`
  (`GoTrueClient.js`, the `if (!options?.allowExpired) validateExp(...)` line),
  its `catch` returns `AuthError`s and rethrows everything else, and
  `lib/fetch.js` turns a plain HTTP 500 into `AuthApiError(status 500)`. The
  plan's measured claims are true of the version actually installed. **PASS.**
- `isExpired` (`:71-74`) treats a non-number `exp` as expired — the intake's
  "exp missing → 401" case. Zero leeway, mirroring `validateExp`. **PASS.**

### 1.3 `getCurrentUser` after the `loadAppUser` extraction

Both versions read (`src/lib/db/auth.ts:56-70` new, same lines old):

```
const supabase = cookieBackedServerClient(request);
const { data: { user: authUser } } = await supabase.auth.getUser();
if (!authUser) return null;
→ (old) inline query WHERE u.auth_id = ${authUser.id}
→ (new) return loadAppUser(authUser.id);
```

The SQL text, the column list, the correlated primary-location subquery, the
`LIMIT 1`, the row→`AppUser` mapping and the `null`-on-no-row behaviour are
byte-identical; only the bound parameter's *name* changed
(`${authUser.id}` → `${authUserId}`), which is why
`scripts/ci/tenant-scope-allowlist.ts` needed the one-line `sqlSnippet`
re-spelling (declared as deviation D5). **Behaviour-identical for the ~40 owner
routes. PASS.**

### 1.4 Non-goals

| Non-goal | Evidence |
|---|---|
| No route file changed | `git diff --name-only` under `src/app/` touches only `__tests__/` files |
| No `src/proxy.ts` change | absent from the diff |
| No CSRF change | `src/lib/shared/csrf.ts`, `src/lib/auth/route-helpers.ts` absent from the diff |
| No CORS / `ADMIN_APP_ORIGINS` | absent |
| `scripts/ci/admin-aal2-audit.ts` untouched | absent from the diff; `GATE_FN`/`GATE_JSON_FN`/`ADMIN_RESOLVER` unchanged, and the gate still exports `requireAdminWithAal2`, `requireAdminJson`, `internalError` with unchanged result shapes, so all three credited shapes still resolve |
| No migration / flag / env var / dependency | `supabase/migrations/`, `package.json`, `.env*` absent from the diff |
| `requireRole` / `requireRoleOr401` cookie-only | `requireRole → requireAuth → getCurrentUser → cookieBackedServerClient`; nothing in that chain reads a header. `route-helpers.ts` unchanged |
| `MFA_ENFORCEMENT_ENABLED` not read in seam or gate | `rg` finds it only in `flags.ts`, its own test, a gate COMMENT, and a `delete process.env` line in the seam test |
| Impersonation untouched | only the two impersonation *test* files changed (shim only) |

**All hold.**

Cross-checked the safety premise the ticket rests on: `src/proxy.ts` branch 4
(`:138-151`) still gates on the cookie-derived `authUser`, so a bearer-only
request is refused 401 before any route runs. The bearer arm is genuinely
unreachable in production until #1185. Also grepped `src/components` and
`src/app` for client code that sends an `Authorization` header to an admin
route — there is none, so the "a bearer wins" precedence cannot strand an
existing browser caller.

### 1.5 `tests_to_add` — presence and non-vacuity

All 21 titles present verbatim (verified programmatically against
`admin-transport-seam.test.ts`, `admin-transport.test.ts`,
`verified-identity.test.ts`, `db/__tests__/auth.test.ts`,
`admin-mfa-gate.test.ts`). Spot-audited each for substance:

- *bearer ok* asserts `getUser` was called **with the presented token** and
  `getClaims` with `(TOKEN, {allowExpired:true})`, plus `cookieClientCalls === 0`
  — not a "some getUser happened" stub.
- *bearer revoked* carries a valid admin cookie alongside and asserts the cookie
  client is never constructed. This is the test that fails on a fallback.
- *a malformed Authorization header does not fall back to the cookie* is
  parameterized over all six shapes, each with a live aal2 admin cookie, and
  asserts the cookie client count stays 0.
- *requireRole remains cookie-only …* exercises the REAL `requireRole` and
  `requireRoleOr401` (only the SDKs are mocked), covering `'admin'` and the
  mixed `('owner','admin')` call — closes the role-conditional-bearer hole.
- *identity mapping uses users.auth_id, never users.id* implements the R3-1
  strengthening exactly: it asserts the fragment adjacent to the bound value
  **ends with** `u.auth_id =` and carries the `WHERE u.id = ` counterexample as
  a rejected-assertion case.
- *a Supabase transport fault …* uses name-stamped real `AuthError`s (auth-js's
  predicates are name-based), covers `getClaims` and `getUser`, and adds the
  `loadAppUser`-throws case.
- *cookie + cross-origin still 403* asserts the wrapper's own body **and the
  absence of `Cache-Control`**, plus that the handler was never entered.
- Every refusal goes through `expectRefusal`, which asserts status + exact JSON
  + `Cache-Control: no-store, private` + `Location === null`.

Not vacuous. See finding **SC-2** for the one test that is weaker than its
Definition-of-Done text.

### 1.6 The 22 migrated route suites

Re-ran the plan's own enumeration command at HEAD: it returns exactly the 22
files on the edit surface — no suite was missed and none was added. All 22 carry
the identical two-part shim (`grep -c` = 2/2 in every file).

Read the shim in `flagged`, `impersonation/start` and `resend-invite` in full
and reasoned about the failure modes:

- **401 arm**: `mockRequireRole` rejects with `statusCode 401` → shim returns
  `null` → gate 401 `Unauthorized`. Same status and body as before.
- **403 arm**: rejects with `statusCode 403` → shim swallows it, then
  `loadAppUser` re-reads `mockRequireRole.mock.results.at(-1)`, awaits the same
  rejected promise, and returns `null` → gate 403 `Forbidden`. Same status and
  body as before, and the mock is invoked exactly ONCE per gate pass, so a
  `mockRejectedValueOnce` control keeps its meaning (this is deviation D3's
  fix, and it is present in all 22).
- **Other throws** are rethrown → gate 500, preserving the old `internalError`
  behaviour.
- **AAL arm**: `{ok:true}` → `'aal2'`; `{ok:false, reason:'mfa_check_failed'}` →
  `null` → 403 `mfa_check_failed`; anything else → `'aal1'` → 403
  `mfa_required`.

**Can a "rejects a non-admin" / "requires AAL2" test now pass while the route is
NOT gated?** No. If a route dropped its gate call, neither
`resolveDualModeIdentity` nor `loadAppUser` would run, the handler would execute
and return its success status, and the `expect(res.status).toBe(403)` assertion
fails. Verified concretely against `flagged/route.test.ts:111-124`
("returns 403 for non-admins" and "returns 403 without a current AAL2 session",
the latter also asserting `mockSql` was never reached) and
`channels/whatsapp/start.test.ts:136-153`. The shim removes no failure mode that
existed before it.

### 1.7 `ci:admin-aal2`

`scripts/ci/admin-aal2-audit.ts` is untouched. Its three credited shapes are
`requireAdminWithAal2`, `requireAdminJson` (both provenance-checked to
`src/lib/auth/admin-mfa-gate`) and `resolveAdminActor` (provenance-checked to
`src/app/api/_shared/channels/resolve-actor`). All three are still exported from
those exact modules with unchanged signatures and result shapes
(`{ok:true, admin} | {ok:false, response}`), and `resolve-actor.ts:70` still
calls `requireAdminWithAal2`. The audit reads route files, none of which changed.
**No credit is lost. PASS.**

### 1.8 Blast radius

Walked every importer list in
`docs/reviews/feat-1183-admin-transport-seam/blast-radius.md`:

- **`admin-mfa-gate.ts` (25 importers)** — 23 production callers use only
  `requireAdminWithAal2` / `requireAdminJson` / `internalError`; all three keep
  their names, signatures and result shapes. `resolve-actor.ts` composes the
  gate and reads `businessId` from the request body AFTER it — the bearer arm
  never touches the body, so `req.json()` in the resolver still works (the
  intake edge case holds).
- **`admin-transport.ts` (2)** — its own test and the seam.
- **`verified-identity.ts` (2)** — its own test and the gate.
- **`db/auth.ts` (59)** — the module's existing exports (`cookieBackedServerClient`,
  `getCurrentUser`, `requireRole`, `AuthError`, `AppUser`) are unchanged; the
  interface widened by exactly one export (`loadAppUser`). The only semantic
  question was whether `getCurrentUser` still behaves identically — checked
  line-by-line in §1.3, it does. Owner-route callers
  (`resolve-owner-scope.ts`, `route-helpers.ts`, `locations/owner-route.ts`,
  `approval/http-routes.ts`, `dashboard/policy.ts`, the zernio connect
  modules, `account-offboarding/destructive-auth.ts`) all reach
  `requireRole`/`getCurrentUser`, which are cookie-only and unchanged.

No caller relied on a behaviour that moved, **except** the admin gate itself —
see SC-1.

---

## 2. Findings

### SC-1 (P1) — an undeclared THIRD (and fourth) cookie-path behaviour change

**File:** `src/lib/auth/verified-identity.ts:91` and `:96`

```ts
const { data, error } = await supabase.auth.getUser();
if (isTransportFailure(error)) throw new IdentityTransportError(error);      // :91
...
const aalResult = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
if (isTransportFailure(aalResult.error)) throw new IdentityTransportError(...); // :96
```

`isTransportFailure` was applied to the COOKIE arm, not only the bearer arm.
That moves two more cookie-mode responses:

| Cookie-mode condition | On `main` (4aa132ba) | On this branch |
|---|---|---|
| `getUser()` returns `AuthRetryableFetchError` or a 5xx `AuthApiError` | `getCurrentUser` → `null` → `requireAuth` throws `AuthError('Unauthorized',401)` → **401 `{error:'Unauthorized'}`** | `IdentityTransportError` → gate catch → **500 `{error:'internal_error'}`** |
| `getAuthenticatorAssuranceLevel()` returns `AuthRetryableFetchError` or a 5xx `AuthApiError` | `requireCurrentAal2FromSupabase` → `{ok:false, reason:'mfa_check_failed'}` → **403 `{error:'mfa_check_failed'}`** | **500 `{error:'internal_error'}`** |

**Contract clauses violated (three, all naming this exact code):**

1. ADR 0025 **D4**: "*The cookie path's AAL read does not change. Cookie mode
   keeps `getAuthenticatorAssuranceLevel()`… Uniformity is not worth
   re-verifying a path that works.*"
2. Ticket #1183 "What to build" §2: "*`resolveCookieIdentity(request)` — today's
   path, **byte-for-byte**. `cookieBackedServerClient` → `getUser()`; AAL from
   `getAuthenticatorAssuranceLevel()`. **Do not touch it (ADR D4).***"
3. Intake `edge_cases`: "*Cookie mode: `getAuthenticatorAssuranceLevel` returns
   error or no data → aal null → 403 `mfa_check_failed` (**today's behaviour,
   preserved**).*" — now false for the transport-failure subset.

`docs/…-deviations.md` **D2** declares exactly two cookie-path deltas (missing
`users` row 401→403; unreadable AAL `mfa_required`→`mfa_check_failed`) and calls
them "the highest-signal behavioural change on the branch". These two are a
third and fourth, and they are not recorded anywhere.

**Concrete failure scenario:** during a GoTrue/Supabase outage (or a 500 from
the Auth server), a Legacy-admin-portal request to any `/api/admin/**` mutation
route that previously answered 401 (which the portal's client treats as
"session gone, re-authenticate") or 403 `mfa_check_failed` now answers 500
`internal_error`. The admin UI's error handling for the gate is therefore
exercised on a code it never received from this gate before.

**Also unpinned in either direction:** the cookie half of test 12 uses
`new Error('aal lookup failed')` (`admin-transport-seam.test.ts:258`), which is
not an `AuthError` and therefore not a transport failure, so it still yields
`mfa_check_failed`. No test covers the cookie + `AuthRetryableFetchError` case,
so neither the new 500 nor the old 403 is asserted anywhere.

**Note:** the change is defensible on the branch's own observability argument
(an outage should page someone rather than look like a wall of bad
credentials), and it fails closed. The finding is that it is an undeclared
change to a path three documents say must not change, on the highest-risk file
in the diff. The remedy is either to scope `isTransportFailure` to the bearer
arm, or to declare it — deviations entry + intake `edge_cases` correction +
a test pinning the new answer.

### SC-2 (P2) — test 20 is implemented weaker than its Definition of Done

**File:** `src/lib/auth/__tests__/admin-transport-seam.test.ts:388-412`

The plan's DoD item 20 specifies:

> **malformed JWT JSON and header shapes remain Unauthorized** — **the REAL SDK
> decode path (no `getClaims` stub)** with `Bearer ew.e30.AA` …,
> `Bearer bnVsbA.e30.AA` …, plus `Bearer aaaa.bbbb.cccc` … → 401 `Unauthorized`,
> no-store, no `Location`, and **no network call**. […] This is the test that
> fails if the seam's `try` is ever widened past the two SDK awaits, or narrowed
> to catch only `AuthError`s.

The implementation stubs `getClaims` with three synthetic thrown errors
(`mockGetClaims.mockRejectedValue(err)` at `:405`) and never presents any of the
three token strings — a repo-wide grep finds `ew.e30.AA`, `bnVsbA.e30.AA` and
`aaaa.bbbb.cccc` only inside comments (`verified-identity.ts:140-142`,
`admin-transport-seam.test.ts:390-391`). There is also no "no network call"
assertion, because `createClient` is mocked away in this file.

**What is lost:** the test still fails a `catch (err) { throw err }` narrowing
(the throw would reach the gate as a 500), so it is not vacuous. But it no
longer verifies the SDK premise the entire failure classification rests on —
that `decodeJWT`'s `JSON.parse` lets an attacker-supplied token escape
`getClaims` as a raw `SyntaxError`/`TypeError`. If an `@supabase/auth-js` patch
changed that split, the suite would stay green while the production classification
silently drifted; the plan called out exactly this ("measured, not assumed",
"a live probe against the installed SDK — not a reading — settled it"). The
substitution is not recorded in `deviations.md`.

**Confidence:** high — the plan text is explicit and the code plainly stubs the
call it says not to stub.

---

## 3. Low-confidence / informational (NOT findings)

- **`reason: 'aal2_required'` in 10 migrated suites.** Several AAL2 tests arm
  `mockRequireCurrentAal2FromSupabase` with `{ok:false, reason:'aal2_required'}`
  — a value `requireCurrentAal2FromSupabase` can never return (its type is
  `'mfa_required' | 'mfa_check_failed'`). Before the branch the gate echoed the
  reason, so the body was `{error:'aal2_required'}`; the shim now maps it to
  `'aal1'` and the body is `{error:'mfa_required'}`. Invisible because those
  tests assert status only. Not a regression introduced here (the fixture was
  already fictional), but those suites' AAL assertions are status-only and
  cannot detect a body change.
- **The `loadAppUser` shim ignores its `authUserId` argument** in all 22 suites,
  so none of them would catch the gate passing the wrong id to the mapper. That
  is covered by test 17 plus `admin-mfa-gate.test.ts`'s
  `expect(mockLoadAppUser).toHaveBeenCalledWith('auth-1')`, so the coverage
  exists — just not in the 22.
- **HS256 projects pay two `getUser` round-trips per bearer request.** If a
  Supabase project signs with a symmetric secret, `getClaims` itself falls back
  to `getUser(token)` (`GoTrueClient.js`, the `if (!signingKey)` branch), so the
  seam's explicit `getUser` is a second call. ADR 0025 records both projects as
  ES256, so this is latency only, and correctness is unaffected (the fallback
  still fails closed). Worth knowing before #1186 measures Admin-app latency.
- **Ordering side effect on the cookie path (no response change).** The gate now
  reads the AAL before the role check, so a cookie session belonging to an
  *owner* pays one `getAuthenticatorAssuranceLevel()` call it did not pay
  before. The response is still 403 `Forbidden` because the role test precedes
  the AAL tests in the gate. Only cost, not behaviour — except where it
  intersects SC-1.
- **`docs/directory/lib-platform.md` D4 rewrite.** Spot-checked the nine
  tightened rows against the files they now point at; the facts that were
  dropped (e.g. `page-gate.ts`'s "redirects to login/MFA-challenge") do exist in
  the target file's docblock, as D4 claims. Two new rows for
  `admin-transport.ts` and `verified-identity.ts` are present, so
  `ci:directory-map` has its one row per production file.
- **`scripts/ci/tenant-scope-allowlist.ts`** — the single changed entry re-spells
  the `sqlSnippet` for the renamed bind parameter and extends the `reason`. The
  SQL is otherwise byte-identical and the entry count is unchanged. Provably
  empty of behaviour, as deviation D5 claims.

## 4. Deviations triage read-back

| Entry | Independent verdict |
|---|---|
| D1 (stale progress ladder) | Not observable in the diff. No comment. |
| D2 (two cookie deltas) | Correct as far as it goes — but incomplete; see **SC-1**. |
| D3 (shim double-consumed a one-shot mock) | Confirmed fixed and uniform across all 22 suites. The `mock.results.at(-1)` form preserves the pre-ticket call count. ACCEPT stands. |
| D4 (`lib-platform.md` at its word cap) | Confirmed; no fact lost that is not in the pointed-at file. ACCEPT stands. |
| D5 (surface amendment #2: arch-review-log + tenant-scope allowlist) | Both hunks inspected; neither carries a behaviour or scope decision. ACCEPT stands. |
