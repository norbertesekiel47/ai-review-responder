# Standards & Maintainability review — `feat/1183-admin-transport-seam`

Range `4aa132ba..344dcbc0` · HEAD `344dcbc0` · read-only pass, no gate run, no edits.

Axis: does this follow *this* repo's documented standards, and will it be maintainable?
Read: `.claude/CLAUDE.md` (invariants #1/#8/#12/#13/#15, Working rules, gotchas),
`.agents/skills/feature/references/working-rules.md` § Anti-slop, `.claude/rules/supabase-auth.md`,
`docs/agents/context-layout.md`, ADR 0025, the branch's own intake/plan/deviations.

---

## 1. Verdict in one paragraph

The engineering is strong and unusually well-argued. There is no `any`, no
`@ts-`/`eslint-disable`, no silent catch in production code, no string-literal
status, no new top-level directory, and invariants #1/#8/#12/#13/#15 all hold
(`verified-identity.ts` never imports `@/lib/db/server`; the DB access stays in
`src/lib/db/auth.ts`, the owner-classified composition root). The seam is placed
where ADR 0025 D1/D2 says it goes, the two-module split is justified by a real
constraint rather than by taste, and the four test files each state why they are
distinct rather than overlapping. What the branch gets wrong is almost entirely in
the *narrative* layer it invests most heavily in: three separate present-tense
claims that `src/proxy.ts` already participates in this design are false today, and
a 22-fold verbatim duplication of a security-contract translation shim was accepted
for a process reason rather than an engineering one.

---

## 2. The two new modules

### `src/lib/auth/admin-transport.ts` — 51 lines, 2 functions, 1 type

Thin by line count, deep by consequence. `isBearerRequest` is a one-line
`headers.has('authorization')` and `readBearerToken` is a single regex, so the
"deep module / narrow interface" test fails on volume. It passes on the axis that
actually matters here: the module's value is that it *fixes a decision* ("presence,
not well-formedness, selects the transport") in one place, and both the comment and
`admin-transport.test.ts` bind that decision with a test that would fail if someone
"tightened" it to `header !== ''`. That is a real invariant, and it belongs
somewhere nameable.

**Was a separate file justified with one caller?** Yes, and this is the one place
the "no abstraction before the second use" rule should not fire. `verified-identity.ts`
imports `@/lib/db/auth`, which imports `@/lib/db/server` (postgres). Anything the
Edge runtime imports must not reach that graph. So the predicate *cannot* live in
`verified-identity.ts` and still be importable by `src/proxy.ts`. The split is a
runtime constraint, not a speculative generalisation. Correct call.

**But the Edge constraint is comment-only.** `admin-transport.ts:8-11` calls it "a
hard constraint rather than a nicety" and then enforces nothing. This repo already
owns the mechanism for exactly this — `src/__tests__/eslint-boundaries.test.ts`
guards invariant #1's runtime-import boundary the same way. Adding a `node:`/`postgres`/
`@supabase` import to this module today is a green build; it becomes a broken Edge
bundle only when #1185 lands, in a different PR, with a different author. Finding P2-2.

**The false claim.** `admin-transport.ts:4-6` reads: *"this module and `src/proxy.ts`
both consume it (#1185)"*. `src/proxy.ts` contains no reference to
`admin-transport`, `Authorization` or `Bearer`; its only auth import is
`@/lib/auth/flags`. The ADR is careful here ("`src/proxy.ts` imports it next"), and
so is `.claude/reference/arch-review-log.md` ("because `src/proxy.ts` imports it
next"). The module comment is the one place that states it in the present tense, in
a security-boundary docblock, where a reader auditing "who checks for a bearer" will
take it at face value and conclude the Edge backstop is already transport-aware.
Finding P1-1.

### `src/lib/auth/verified-identity.ts` — 194 lines, 3 functions

This is the deep module. Its interface is three facts (`authUserId`, `aal`,
`transport`) and its body absorbs four genuinely hard things: the `getClaims`-then-
`getUser` ordering, the returned-vs-thrown error taxonomy, the expiry channel move,
and the AAL normalisation across two transports that report it differently. The
"decides nothing" property is asserted structurally *and* pinned by a test
(`verified-identity.test.ts:182`, "is blind to role"). Seam placement matches ADR
0025 D1 exactly, and the reason it is below `requireAdminWithAal2` rather than
inside `requireRole` — ~40 owner routes reach `requireRole` via `requireRoleOr401`
and none asked for a bearer — is the correct reason.

**Two modules or one, or three?** Two is right. One would have made the seam
un-Edge-safe (above). Three — splitting `resolveBearerIdentity` out — would have
separated the two arms of a single either/or, which is the shape ADR D2 explicitly
argues against for `resolveDualModeIdentity`'s delegation. No finding.

**Export-surface asymmetry.** `resolveCookieIdentity` is exported
(`verified-identity.ts:85`) and has zero production consumers — `resolveDualModeIdentity`
reaches it through module scope, and the only importer is
`verified-identity.test.ts`. Its sibling `resolveBearerIdentity` is private. The
module docblock's "TWO SIBLING RESOLVERS, never one with a posture parameter" reads
as a statement about the public interface, but the public interface has one sibling
and one entry point. Either export both (matching the docblock and #1185's likely
need) or export neither. Finding P2-5.

**`IdentityTransportError`** is honest about why it exists (it makes a fault reach
the gate's catch as a fault, not a refusal), but nothing in production performs an
`instanceof` or reads `.cause`; the gate catches bare. It buys a better Sentry name
and nothing else. Not a finding — see appendix A1.

---

## 3. Comment quality

This repo writes long comments deliberately and this branch is at the upper end of
that. Most of them earn their length by recording a trap that cost real time:

- `verified-identity.ts:129-145` (the scoped `try`) is the best comment on the
  branch. It names the concrete attacker input (`ew.e30.AA`, `bnVsbA.e30.AA`), the
  concrete exception types, and the concrete consequence (an unauthenticated caller
  forcing 500s on the admin control plane with a two-character token). That is not
  restatement — you cannot derive it from the code.
- `admin-mfa-gate.ts` refusal table and the `MFA_ENFORCEMENT_ENABLED` line are
  contract, not narration.
- `db/auth.ts:80-83` (`u.auth_id`, never `u.id`) records invariant #8 at the exact
  site where transposing them is plausible. Earns it.

Three comments do not hold up:

1. **`admin-transport.ts:4-6`** — false claim about another file (P1-1, above).
2. **Four node_modules line citations** — `verified-identity.ts:55`
   (`lib/fetch.js:24-30, 72`), `:62` (`lib/errors.js:49-51, 222-224`), `:70`
   (`lib/helpers.js:270-276`). Verified: all four resolve correctly, but **only
   against `dist/module/`**, not `dist/main/`, and the comment does not say which
   build. In `dist/main` the same paths land on `_getErrorMessage`, an
   `AuthApiError` constructor and PKCE code-challenge code respectively — a reader
   who checks the CJS build will conclude the comment is wrong. And every one of
   them dies on the next `@supabase/auth-js` patch bump, with no test pinning either
   the version or the claims. The repo has the pattern for this
   (`model-pinning.test.ts`, `design-doc-token-pin.test.ts`). The *substance* of the
   claims is correct — I verified `handleError`'s `NETWORK_ERROR_CODES`, the
   `AuthApiError(status || 500)` fallthrough, `isAuthApiError`/`isAuthRetryableFetchError`
   comparing `error.name`, and `validateExp` throwing a plain `Error('JWT has expired')`.
   Finding P2-1.
3. **`admin-transport.ts:37-43`** — "the credential is a single RFC 6750 `token68`"
   overstates the regex, which enforces "no whitespace", not the token68 charset.
   Harmless (the token is verified downstream) and the sentence immediately explains
   the real rule. Appendix A2, not a finding.

One good property worth naming: **no comment on this branch cites a line number
inside this repository.** The citations that exist are to node_modules and to ADR
section IDs, which are stable. That is the right discipline; the node_modules ones
are the exception because they point at a build artifact.

---

## 4. `src/lib/db/auth.ts` — the `loadAppUser` extraction

**The seam is in the right place.** `getCurrentUser` was doing two things —
"read a Supabase session from cookies" and "map an auth identity to a `users` row
plus primary location". The bearer arm needs the second without the first. The cut
is exactly on that line, `getCurrentUser` shrinks to five lines that read as one
sentence, and it remains coherent (its docblock still describes what it does:
cookie session → auth identity → app user).

Placing `loadAppUser` in `src/lib/db/auth.ts` rather than in the seam is required
by invariant #15 — `db/auth.ts` is a named composition root that owns the singleton,
and a domain module under `src/lib/auth/` may not import `@/lib/db/server`. The
alternative (threading `sql` into the seam) would have forced every gate caller to
acquire it. Correct.

The SQL is byte-identical apart from the bound parameter rename, and the
`tenant-scope-allowlist.ts` entry was re-spelled rather than widened (baseline
stays at 379). Verified against the diff.

**One defect.** `getCurrentUser`'s docblock still ends with the "Migration note
(034)" paragraph (`db/auth.ts:52-54`), which was written about the query that has
now moved, and is reproduced verbatim in `loadAppUser`'s docblock at `:85-86`. Two
live copies of one fact, which CLAUDE.md's "one authoritative owner per fact" rule
exists to prevent, and the copy left behind is the one attached to code that no
longer contains the query. Finding P2-4.

---

## 5. The 22 migrated test suites — shim vs. shared helper

**Verdict: a shared helper should have won. The 22-fold duplication is a P1
maintainability finding.**

The shim is ~37 lines (a `loadAppUser` stub in the `@/lib/db/auth` factory plus a
`vi.mock('@/lib/auth/verified-identity')`), byte-identical in all 22 suites — I
diffed them; not one specialises it. What it encodes is not fixture data. It is a
*translation of the gate's refusal contract*: 401 → `null` identity, 403 →
`loadAppUser` returns null, `{ok:true}` → `'aal2'`, `{reason:'mfa_check_failed'}` →
`null`, everything else → `'aal1'`. That is domain knowledge about a security
boundary, replicated 22 times.

Arguments for the shared helper, in order of force:

1. **The branch's own D3 proves the failure is real and silent.** Three of the four
   parallel migration agents independently produced a *wrong* shim, and the wrongness
   direction is the dangerous one: a `mockRejectedValueOnce(403)` was consumed by the
   seam shim, `loadAppUser` fell through to the `beforeEach` default admin, and the
   suite's "rejects a non-admin" test asserted a **success** status while staying
   green. One shared helper is one place to get that wrong, one place to fix it, and
   one place a reviewer has to read.
2. **Lockstep maintenance is now mandatory and unenforced.** #1184 folds nine GETs
   onto this gate, #1185 adds the bearer arm and `withSameOriginUnlessBearer`. Each
   of those changes the mapping this shim implements. Twenty-two files must then move
   together; a missed one does not fail — it goes green and stops testing
   authorization. Nothing in `ci:*` detects a stale copy.
3. **Precedent exists and defeats the "new file" objection.** `src/__tests__/helpers/`
   already holds exactly this class of thing (`describe-with-db.ts`,
   `concurrency-handoff.ts`, `css-tokens.ts`). "A shared helper would have needed a
   new file outside the declared edit surface" is a process constraint, and the
   branch took two surface amendments anyway (D5) for strictly smaller reasons — a
   one-line ledger entry and a parameter rename.
4. **The mechanical objection is solvable.** `vi.mock` factories are hoisted above
   imports, so a static import of a helper is unusable — but an async factory is not:
   `vi.mock('@/lib/auth/verified-identity', async () => (await import('@/__tests__/helpers/admin-gate-shim')).identityShim(mockRequireRole, mockRequireCurrentAal2FromSupabase))`
   works, and the two mocks are already `vi.hoisted`/`mock`-prefixed in every suite.

Argument against, stated fairly: a mock factory is deliberately local, and a shared
one couples 22 suites to a single helper's evolution, so a change intended for one
suite silently changes 21 others. That is a genuine cost — but it is the *same* cost
the duplication already imposes, minus the "one of them silently rots" failure mode,
and these 22 suites are not independent: they all exercise one gate.

Finding P1-4.

**Separate, smaller defect in the same 22 files.** Each suite still carries
`vi.mock('@/lib/auth/mfa', …)` (e.g. `businesses/__tests__/route.test.ts:132`) and a
`cookieBackedServerClient: () => ({ auth: { mfa: {} } })` stub in the `@/lib/db/auth`
factory (`:63`). Neither intercepts anything any more: no route under
`src/app/api/admin/**` and nothing in its lib graph imports `@/lib/auth/mfa`
(verified — the importers are `page-gate.ts`, `shell-context.ts`,
`destructive-auth.ts`, the MFA challenge route and the reset-password route, none of
which these routes reach), `route-helpers.ts` does not import
`cookieBackedServerClient`, and `verified-identity` is mocked wholesale so the real
one is never constructed. Dead scaffolding × 22, and it misleads the next reader
about what the gate depends on. Net-negative bias says delete it in the same PR that
made it dead. Finding P2-3.

Minor: the `mockRequireCurrentAal2FromSupabase` and `mockRequireRole` mocks carry no
`expect(...)` assertions in any of the 22 suites — they are pure input controls — so
D3's "which also preserves the pre-ticket call count" is defending a property nothing
observes. Appendix A3.

---

## 6. `docs/directory/lib-platform.md` — the nine rewritten rows

I checked every fact dropped from every rewritten row against the file the row now
points at. **The compression is overwhelmingly clean.** Confirmed present in the
target files:

| Dropped from the row | Present at |
|---|---|
| `require-owner-access`: "validates role + subscription_status", redirect targets | `require-owner-access.ts:4-14` |
| `page-gate`: "redirects to login/MFA-challenge on failure" | `page-gate.ts:59-83` |
| `get-request-scope`: "primary first"; "so the layout need not re-query" | `get-request-scope.ts:26-30, 62-67` |
| `provision-auth-user`: `admin.getUserById`; param names | `provision-auth-user.ts:23-37` |
| `reset-password-error`: "else 400"; "unusable status" | `reset-password-error.ts:6-7, 44` |
| `resolve-owner-scope`: `requireRole('owner')`, `subscriptionGrantsFullAccess`, `past_due_read_only` | `resolve-owner-scope.ts:5, 67, 71, 101` |
| `mfa`: the `factorStatusBefore` WHY | `mfa.ts:44-57` |

Three defects, all in the `mfa.ts` and `admin-transport.ts` rows:

1. **Line 82 states a falsehood about `src/proxy.ts`.** The new row says "the proxy
   and page gate still use these". The page gate does (`page-gate.ts:7`). The proxy
   does **not** — it imports only `@/lib/auth/flags` and inlines its own
   `getAuthenticatorAssuranceLevel` call at `src/proxy.ts:92-103`. That inlined copy
   is precisely the lenient-vs-strict divergence ADR 0025 D6 holds up as the worked
   example of why two copies of an auth test are dangerous; the row now asserts the
   opposite. Finding P1-2.
2. **Line 86 states the same falsehood about `admin-transport.ts`** — "Traps: ONE
   owner, shared with `src/proxy.ts` (#1185)". Reference pages describe current
   state; the module has one production consumer. Finding P1-3.
3. **Line 82's "WHY: the module docblock" points at something that does not exist.**
   `src/lib/auth/mfa.ts` opens at line 1 with `export type Aal2Result` — there is no
   module docblock. The WHY is a *function* docblock at `:41-57`. Same line also
   drops the old row's `mfa_factor_enrolled` / `mfa_challenge_succeeded` pair, which
   appears nowhere in `mfa.ts` (only in `supabase/migrations/117_admin_audit_log.sql:19-20`
   and the challenge-route tests) — so it is the one genuine counterexample to D4's
   audit claim that "no row lost a fact that does not exist verbatim in the file it
   now points at". The semantic survives in `mfa.ts:49-53` ("a different event"); the
   event names do not. Finding P2-6.

The remedy applied (move the WHY to the pointed-at file) is one of the three
`docs/agents/context-layout.md` sanctions, correctly chosen, and D4's flag to the
orchestrator — the page is back at exactly 2,998/3,000 and the next `src/lib/` file
forces a `docs/directory.md` split — is the right thing to have surfaced.

---

## 7. Standards checklist

| Rule | Result |
|---|---|
| No `any` (JSONB carve-out N/A) | Pass — zero added `any`, `as any`, `@ts-`, `eslint-disable` |
| No silent catches | Pass in production. Every `catch` in `verified-identity.ts` classifies before returning. The 22 test shims have `catch { return null }` — test-only |
| No string literals for status/tier/job/review-status | Pass. `'admin'`, `'aal2'`, `'cookie'`/`'bearer'` are role/AAL/transport, none of which is on the banned list; `'aal2'` and the transport union are typed |
| Invariant #1 (Vercel = UI only) | Pass — no banned runtime import added under `src/app`/`src/components` |
| Invariant #8 (auth scope, `users.auth_id`) | Pass, and reinforced by the `loadAppUser` docblock |
| Invariant #12 (entry points orchestrate) | Pass — `requireAdminWithAal2` is now ~30 lines of pure orchestration |
| Invariant #13 (flags server-authoritative) | Pass — no `NEXT_PUBLIC_*` added; `MFA_ENFORCEMENT_ENABLED` deliberately unread |
| Invariant #15 (explicit DB client) | Pass — the seam never imports `@/lib/db/server`; the query stays in the classified root |
| No new top-level directory | Pass |
| `docs/directory/` row ships with the new file | Pass (`ci:directory-map`) |
| One authoritative owner per fact | **Fail** — `db/auth.ts:52-54` vs `:85-86` (P2-4) |
| No dead code / net-negative bias | **Fail** — 22× dead `vi.mock('@/lib/auth/mfa')` + `cookieBackedServerClient` stub (P2-3) |
| No near-duplicates | **Fail** — the 22× shim (P1-4) |
| Comments record WHY, no stale citations | **Fail** — P1-1, P2-1 |
| Backwards-compat shim | Pass — none; the refusal-table changes are made outright and recorded (D2) |

---

## 8. Findings table

| severity | file:line | finding |
|---|---|---|
| P1 | `src/lib/auth/admin-transport.ts:5` | Comment asserts present-tense that `src/proxy.ts` consumes this module; `src/proxy.ts` has no import of it and no `Authorization`/`Bearer` reference at all. |
| P1 | `docs/directory/lib-platform.md:82` | Rewritten row states "the proxy … still use[s] these" of `mfa.ts`; `src/proxy.ts` imports only `@/lib/auth/flags` and inlines its own AAL read (`src/proxy.ts:92-103`) — the exact divergence ADR 0025 D6 cites. |
| P1 | `docs/directory/lib-platform.md:86` | Rewritten row states `admin-transport.ts` is "shared with `src/proxy.ts`"; it has exactly one production consumer (`verified-identity.ts:21`). |
| P1 | `src/app/api/admin/businesses/__tests__/route.test.ts:49-62,140-156` (×22) | The gate's refusal-contract translation shim is duplicated verbatim across 22 suites with no shared helper, despite `src/__tests__/helpers/` precedent; #1184/#1185 force a 22-file lockstep edit whose miss mode is a silently vacuous authorization test (the branch's own D3). |
| P2 | `src/lib/auth/verified-identity.ts:55,62,70` | Four node_modules line citations pinned to `@supabase/auth-js` 2.106.2 that resolve only against `dist/module/` (not `dist/main/`, unstated) and are invalidated by any patch bump, with no pinning test. |
| P2 | `src/lib/auth/admin-transport.ts:8` | "EDGE-SAFE … hard constraint" is enforced by comment only; `src/__tests__/eslint-boundaries.test.ts` is the repo's mechanism for exactly this and was not used. |
| P2 | `src/app/api/admin/businesses/__tests__/route.test.ts:63,132` (×22) | `vi.mock('@/lib/auth/mfa', …)` no longer intercepts anything and the `cookieBackedServerClient` stub is never invoked — dead scaffolding left in all 22 migrated suites. |
| P2 | `src/lib/db/auth.ts:52-54` | `getCurrentUser`'s "Migration note (034)" is a second live copy of the fact now owned by `loadAppUser`'s docblock at `:85-86`, attached to code that no longer contains the query. |
| P2 | `src/lib/auth/verified-identity.ts:85` | `resolveCookieIdentity` is exported with no production consumer (tests only) while its sibling `resolveBearerIdentity` is private, contradicting the docblock's "two sibling resolvers" framing. |
| P2 | `docs/directory/lib-platform.md:82` | "WHY: the module docblock" points at a docblock `src/lib/auth/mfa.ts` does not have (file opens with `export type`), and the row drops `mfa_factor_enrolled`/`mfa_challenge_succeeded`, which appear nowhere in that file — the one counterexample to D4's audit claim. |

---

## Appendix — low-confidence observations (not findings)

- **A1.** `IdentityTransportError` (`verified-identity.ts:47`) is never `instanceof`-checked
  and its `readonly cause` is never read; a bare `throw error` would behave
  identically. It buys a named Sentry frame and documents intent, which is probably
  worth 8 lines. Also note `readonly cause` shadows the standard `Error.cause`
  accessor — benign here since the field is assigned, but a trap if anyone later
  adds `super(message, { cause })`.
- **A2.** `readBearerToken`'s comment (`admin-transport.ts:37-43`) says the credential
  "is a single RFC 6750 `token68`"; the regex enforces only "no whitespace". The
  sentence goes on to state the real rule, and the token is verified downstream, so
  this is imprecision rather than a defect.
- **A3.** `mockRequireRole`/`mockRequireCurrentAal2FromSupabase` carry no `expect(...)`
  assertions in any of the 22 suites, so D3's "preserves the pre-ticket call count"
  defends a property nothing observes.
- **A4.** `docs/directory/lib-platform.md:81` now ends with "Cookie-only; #1183 did not
  widen it." A statement about what a past change did *not* do reads as noise in a
  current-state reference page once #1183 is history; "cookie-only" alone carries it.
- **A5.** The whole bearer arm is unreachable today — `src/proxy.ts` branch 4 401s
  `/api/admin*` from the cookie before any route runs, and admin mutations still wrap
  `withSameOrigin()`. ADR 0025 D5/D6 explicitly stages this and the arch-review-log
  says so plainly, so it is not a violation of the "no code for a future caller" rule
  — but the branch ships ~200 lines of production code with no live caller, and that
  is worth carrying into the merge decision rather than discovering later.
- **A6.** `resolveBearerIdentity` constructs a fresh `createClient` per request. I
  checked whether that defeats JWKS caching and it does not — auth-js 2.106.2 keys
  its cache on a module-level `GLOBAL_JWKS[storageKey]`
  (`dist/main/GoTrueClient.js:48-59`), and `storageKey` derives from the project URL.
  ADR 0025's "cached ~10 min per warm process" consequence holds. No finding; recorded
  so the next reviewer does not re-derive it.
- **A7.** The branch adds five documents under `docs/superpowers/plans/` and
  `docs/reviews/`. Both live in the history layer per `context-layout.md` §4, so no
  cap or ownership rule applies, but `docs/reviews/feat-1183-admin-transport-seam/`
  is a new directory whose convention (`docs/reviews/<branch>/`) is not stated in
  `context-layout.md`'s "How to add" list.
