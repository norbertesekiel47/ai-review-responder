# Red team — #1183 Admin transport seam

- **Mode** `feature` · **Round** 1 · **Risk** `high`
- **Branch** `feat/1183-admin-transport-seam`
- **fork / merge-base** `4aa132bac9e3d7f6f2eb72e669b57885ba16c6e5`
- **head** `344dcbc0524e6733fef988ce66fc43db013dd088`
- **intake sha256** `d7ccd28ecb4e0447a7d86018d96507f3ee668f6655df03d00ee9c49975c1e979`
- **Status** `OPEN_P1` — two open P1s on a high-risk run require user adjudication.

Report path is the checker-derived one (`red-team-status.mjs` run with no report
named `docs/reviews/red-team/feat-1183-admin-transport-seam-7ee6d4/`). The brief's
suggested slug `1183-admin-transport-seam` is not the derived slug; the protocol's
derived path wins, because the checker computes it and will not look anywhere else.

Environment: allowlisted (`mutation-runner env`), temporary `HOME`, `NODE_ENV=test`,
`CI=true`, `MOCK_EXTERNAL_APIS=true`, `REPWORTH_DISABLE_LIVE_DB_SUITES=1`,
`.env.local` swapped for a scrubbed copy for the whole mutation phase and restored
by the finalizer. No watcher or dev server was serving the worktree.

**Mutations run: 14. Survivors: 0.** 27 supervised runs (13 baselines + 14 mutants;
one baseline was reused across two candidates sharing the same test at the same SHA).
Every mutation restored; `git status --porcelain` is empty outside this report
directory.

---

## Findings

| Severity | file:line | Finding |
|---|---|---|
| P1 | `src/lib/auth/verified-identity.ts:57` | FALSE doc claim about auth-js `handleError`, with a live consequence: an infra fault whose body is not JSON is classified as a refusal (401), not a fault (500). |
| P1 | `src/lib/auth/admin-mfa-gate.ts:23` | The 5xx class this diff newly routes into `internalError` emits NO Sentry signal and has NO rule row — both halves of the alert path are missing. |
| P2 | `docs/superpowers/plans/feat-1183-admin-transport-seam-deviations.md:25` | D2 enumerates TWO cookie-path refusal deltas; there is an undeclared THIRD (cookie transport fault 401 → 500). |
| P2 | `src/lib/db/__tests__/auth.test.ts:121` | The invariant-#8 assertion is a regex over SQL TEXT; it kills the real mutant but breaks on behaviour-preserving reformatting. |
| P2 | `src/lib/auth/admin-mfa-gate.ts:111` | The refusal table's ORDERING (role before assurance) is unpinned: no test supplies a non-admin AND a non-`aal2` together. |
| P2 | `docs/superpowers/plans/feat-1183-admin-transport-seam-intake.json:51` | "pays no extra fetch" holds only for a `kid` already in the JWKS cache; an unknown/rotated `kid` costs an uncached JWKS GET **per request**. |
| P2 | `src/proxy.ts:139` | Claim 1 is a MODULE contract, not an end-to-end one — no bearer request reaches the gate in a deployed environment today. Declared in the plan; recorded as a scope qualification. |

---

### RT1 — P1 — `src/lib/auth/verified-identity.ts:57` (Duty 3, docs vs reality)

The comment above `isTransportFailure` asserts, of `@supabase/auth-js` 2.106.2:

> `handleError` raises `AuthRetryableFetchError` for a transport failure and for
> statuses 502/503/504/520-524/530, and turns **EVERYTHING else** — a plain HTTP 500
> included — into `AuthApiError(message, status || 500, code)`.

Measured at HEAD against
`node_modules/.pnpm/@supabase+auth-js@2.106.2/node_modules/@supabase/auth-js/dist/module/lib/fetch.js:22-38`:

```
22  const NETWORK_ERROR_CODES = [502, 503, 504, 520, 521, 522, 523, 524, 530];
23  export async function handleError(error) {
25      if (!looksLikeFetchResponse(error)) throw new AuthRetryableFetchError(…, 0);
27      if (NETWORK_ERROR_CODES.includes(error.status)) throw new AuthRetryableFetchError(…);
32      try { data = await error.json(); }
35      catch (e) { throw new AuthUnknownError(_getErrorMessage(e), e); }   // <- not AuthApiError
```

"EVERYTHING else" is false. `handleError` has four other exits: `AuthUnknownError`
(line 36), `AuthWeakPasswordError`, `AuthSessionMissingError`, and only then the
`AuthApiError` fall-through at line 72.

Three of those are refusals and are handled correctly. `AuthUnknownError` is not:
its `name` is `'AuthUnknownError'` (`dist/module/lib/errors.js`,
`this.name = 'AuthUnknownError'`), and `isTransportFailure` at
`src/lib/auth/verified-identity.ts:66-67` is purely name-based —

```ts
if (isAuthRetryableFetchError(error)) return true;              // name === 'AuthRetryableFetchError'
return isAuthApiError(error) && (error.status ?? 500) >= 500;   // name === 'AuthApiError'
```

— so an `AuthUnknownError` matches neither. The seam returns `null`, and
`requireAdminWithAal2` answers **401 `Unauthorized`** where the declared contract
says 500 `internal_error`.

Reachability: any GoTrue/edge response whose status is 5xx-but-not-in-the-list
(500, 501, 505, 507, 529) or 429, carrying an HTML or empty body — a proxy error
page, a truncated response, a WAF interstitial. 502/503/504/520-524/530 are safe:
they hit `NETWORK_ERROR_CODES` **before** `.json()` is attempted.

This is precisely the failure mode the comment exists to prevent, stated at
`src/lib/auth/verified-identity.ts:40-42` ("rather than a 401 that would make an
admin-wide outage look like a wall of bad credentials") and re-tested at
`src/lib/auth/__tests__/admin-transport-seam.test.ts:354`. That test covers
`AuthRetryableFetchError(0)`, `AuthApiError(500)` and `AuthApiError(503)`; no test
supplies an `AuthUnknownError`, so the gap is green in CI.

Remedy: add `AuthUnknownError` (by name) to `isTransportFailure`, correct the
comment's "EVERYTHING else" to name the four exits, and add the case to the infra
list in the seam suite. Disposition: **open**.

### RT2 — P1 — `src/lib/auth/admin-mfa-gate.ts:23` (Duty 5, operational completeness)

The diff ADDS a terminal 5xx condition and nothing alerts on it.

**What is new.** Before this branch the cookie identity step was
`requireRole` -> `requireAuth` -> `getCurrentUser` -> `supabase.auth.getUser()`
(`src/lib/db/auth.ts:61-65` at the fork), which destructures `data.user` and
IGNORES `error`; auth-js returns rather than throws for a retryable fetch error, so
a Supabase outage produced `authUser === null` -> `AuthError('Unauthorized', 401)` ->
the old gate's **401**. After this branch, `resolveCookieIdentity`
(`src/lib/auth/verified-identity.ts:91`, `:96`) classifies the same error as a
transport failure and throws `IdentityTransportError`, which the gate's catch
(`src/lib/auth/admin-mfa-gate.ts:102-109`) turns into **500 `internal_error`**.
That is the right direction — and it means a Supabase outage now converts every
admin route from 401s to 500s.

**Neither half of the alert path exists.**

- *Emitting signal:* `internalError` logs with `console.error` only
  (`src/lib/auth/admin-mfa-gate.ts:23`). `src/instrumentation.ts:48-54` and `:70-76`
  initialise Sentry with `dsn`, `tracesSampleRate` and `beforeSend` — no
  `captureConsoleIntegration`. `onRequestError = Sentry.captureRequestError`
  (`src/instrumentation.ts:9`) fires only for errors that ESCAPE a handler; this one
  is caught and returned as JSON. So the 500 produces no Sentry event at all.
- *Rule row:* `docs/runbooks/beta-launch-alerting.md:370-380` carries nine rules
  (`health_alert`, `cost_event`, `stripe_reconciliation`, `import_consent_analytics`,
  `solicitation_send_breaker` (superseded), `solicitation_lane`,
  `unmapped_block_reason` x2, `stripe_subscription_out_of_order`). None matches this
  seam, and no `subsystem`/`feature`/`fault` tag is emitted for one to filter on.

**A bearer refusal is not distinguishable in logs.** The gate emits no log line on
401 or 403 at all, and the single 500 line — the literal
`[admin-mfa-gate] unexpected failure:` — carries no `transport` field even though
`VerifiedIdentity.transport` (`src/lib/auth/verified-identity.ts:35`) is available
one frame up. A burst of bearer 401s from the new Admin app is invisible to the
operator, as is "which transport is failing" during an incident.

Remedy: tag the fault (`subsystem: 'admin_identity'` plus `transport`) through a
Sentry capture on the `IdentityTransportError` arm, and add the matching rule row.
Disposition: **open**.

### RT3 — P2 — `.../feat-1183-admin-transport-seam-deviations.md:25` (Duty 3)

D2 says "**Two** cookie-mode responses change" and lists the missing-`users`-row
401->403 and the `{ currentLevel: null }` `mfa_required`->`mfa_check_failed` move.
The gate docblock repeats it at `src/lib/auth/admin-mfa-gate.ts:61` ("Two refusals
moved"). There is a third, described in RT2: cookie-mode Supabase transport fault
**401 -> 500**. It is inside the declared refusal table
(`src/lib/auth/admin-mfa-gate.ts:55-56`) but is not enumerated as a cookie delta in
either place, and it is the one with operational blast radius. Not a defect in the
code — an incomplete enumeration in the two documents a reviewer reads first.
Disposition: **open**.

### RT4 — P2 — `src/lib/db/__tests__/auth.test.ts:121` (Duty 2, fragile assertion)

```ts
expect(fragmentBinding(call, index).trimEnd()).toMatch(/\bu\.auth_id\s*=$/);
```

The invariant-#8 guarantee is enforced by a regex over SQL TEXT. It is not vacuous —
mutation M6 (`WHERE u.auth_id = ` -> `WHERE u.id = `) killed it — and it carries its
own counterexample at `:126-128`, which is more care than most such assertions get.
It is still structure-coupled: `WHERE (u.auth_id) = ${authUserId}` and any change to
the `u` alias are behaviour-preserving edits that turn it red, and a `JOIN` that
happens to end a different fragment with `auth_id =` would turn it green for the
wrong reason. Behavioural replacement: a live-DB suite that seeds two `users` rows
where row A's `id` equals row B's `auth_id`, then asserts `loadAppUser(<that value>)`
returns row B. Disposition: **open**.

### RT5 — P2 — `src/lib/auth/admin-mfa-gate.ts:111` (Duty 2, coverage)

```ts
111  if (!admin || admin.role !== 'admin') return refuse(403, 'Forbidden');
117  if (aal === null)   return refuse(403, 'mfa_check_failed');
118  if (aal !== 'aal2') return refuse(403, 'mfa_required');
```

Claim 1 is "refuses everything else per a byte-for-byte table", and the table is
ordered. Every role test in `admin-transport-seam.test.ts` supplies `aal2`
(`:270`, `:278`, `:286`) and every assurance test supplies an admin row
(`:223`, `:231`, `:246`), so no test ever presents both a non-admin AND a non-`aal2`.
Moving line 111 below 118 would change that caller's answer from `Forbidden` to
`mfa_required` with no test noticing. No privilege is gained either way — both are
403 refusals — which is why this is P2 and not higher.

Deliberately NOT measured as a mutation: the sidecar's outcome vocabulary forces a
survivor to be either a confirmed P0 or provably equivalent, and this is neither, so
running it would have manufactured an `inconclusive` row disproportionate to a
refusal-code reshuffle. Reported from a static read of the suite instead.
Disposition: **open**.

### RT6 — P2 — `.../feat-1183-admin-transport-seam-intake.json:51` (Duty 3 / Duty 5)

The intake edge case reads: "auth-js caches JWKS in a module-global keyed by
storageKey (`sb-<project-ref>-auth-token`, derived from the URL), so a per-request
client still shares the 10-minute JWKS cache and pays no extra fetch."

Both halves verified at HEAD, and the first is exactly right:

- `dist/module/GoTrueClient.js:43-60` — `const GLOBAL_JWKS = {}` with `get/set jwks`
  and `get/set jwks_cached_at` indexing `GLOBAL_JWKS[this.storageKey]`.
- `@supabase/supabase-js@2.106.2 dist/index.mjs:642` —
  `const defaultStorageKey = ` + "`sb-${baseUrl.hostname.split('.')[0]}-auth-token`" + `,
  applied at `:646`. So the per-request `createClient` at
  `src/lib/auth/verified-identity.ts:125-129` genuinely shares one cache.
- `dist/main/lib/constants.js:30` — `JWKS_TTL = 10 * 60 * 1000`. Ten minutes,
  as claimed.

The "pays no extra fetch" half is conditional. `fetchJwk`
(`dist/main/GoTrueClient.js:4724-4753`) returns from cache only when the `kid` is
present in it; when the `kid` is absent the TTL is bypassed entirely and a
`GET /.well-known/jwks.json` is issued, and if the key is still not found it returns
`null`, which sends `getClaims` down its `getUser(token)` fallback — a second
outbound call. So a request presenting a well-formed JWT with an unknown `kid` costs
**two** unauthenticated outbound Supabase calls, with no cache damping and no
backoff, once per request.

Not currently reachable: `src/proxy.ts:139-142` refuses a bearer-only request with
401 before the route handler runs (see RT7). It becomes an unauthenticated
amplification surface on the admin control plane the moment #1185 lets bearers
through, and `docs/runbooks/vercel-waf-rate-limiting.md` has no rule scoped to
`/api/admin`. Recorded here so #1185 inherits the constraint rather than
rediscovering it. Disposition: **open**.

### RT7 — P2 — `src/proxy.ts:139` (Duty 4, scope qualification)

`src/proxy.ts` is UNCHANGED on this branch (`git diff --stat … -- src/proxy.ts` is
empty), and branch 4 still gates `/api/admin/*` on the cookie session:

```
139  if (routePath.startsWith('/api/admin')) {
140    if (!authUser) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
```

`authUser` there is read from cookies, so a bearer-only request is refused by the
proxy — with a body that carries no `Cache-Control` — before `requireAdminWithAal2`
is ever entered. Claim 1 therefore holds of the FUNCTION and of its unit contract,
but not of any deployed admin route today.

This is declared, not hidden:
`docs/superpowers/plans/feat-1183-admin-transport-seam-plan.md:293` says
"`src/proxy.ts` still 401s a bearer-only request at branch 4 (#1185)". Recorded as a
qualification on the claim rather than as a defect. Disposition: **open**.

---

## Duty 1 — mutation inventory

Candidate set: the eight mutation targets named in the brief (the route-suite bullet
expands to three rows, one per suite), plus three self-selected high-value candidates
on the changed surface (M11 lenient-vs-strict AAL, M12 owner-gate widening, M13
token68 anchor) and one boundary candidate (M14 missing `exp`). All 14 were executed;
there are no `skipped-budget` rows.

Protocol per row: green individual baseline at HEAD -> one semantic mutation via
`mutation-runner mutate` (original blob hashed into the object DB first) -> the same
single test re-run under a paused supervisor -> `assert-one-test` confirming exactly
one executed test -> restore.

| # | Mutation | Covering test | Outcome |
|---|---|---|---|
| M1 | delete the `getUser(jwt)` liveness round-trip, return the claims-derived identity (`verified-identity.ts:160-168`) | `admin-transport-seam.test.ts` > bearer revoked (the getUser arm) | **killed** |
| M2 | `isBearerRequest` presence -> well-formedness (`readBearerToken(request) !== null`) (`admin-transport.ts:32`) | seam > a malformed Authorization header does not fall back to the cookie | **killed** |
| M3 | transpose the `mfa_check_failed` / `mfa_required` arms (`admin-mfa-gate.ts:117-118`) | seam > unreadable AAL returns mfa_check_failed on both transports | **killed** |
| M4 | `!admin \|\| admin.role !== 'admin'` -> `!admin` (`admin-mfa-gate.ts:111`) | seam > bearer non-admin | **killed** |
| M5 | `resolveDualModeIdentity` bearer arm falls through to `resolveCookieIdentity` on `null` (`verified-identity.ts:191-193`) | seam > a malformed Authorization header does not fall back to the cookie | **killed** |
| M6 | `WHERE u.auth_id = ` -> `WHERE u.id = ` (`db/auth.ts:104`) | `db/__tests__/auth.test.ts` > identity mapping uses users.auth_id, never users.id | **killed** |
| M7 | widen the `getClaims` try to enclose the returned-error transport check, so the fault is swallowed into `return null` (`verified-identity.ts:145-152`) | seam > a Supabase transport fault is internal_error, not Unauthorized | **killed** |
| M8 | delete the gate call from the route (`src/app/api/admin/flagged/route.ts:22-23`) | `admin/flagged/__tests__/route.test.ts` > returns 403 for non-admins | **killed** |
| M9 | replace `requireAdminJson` with a bare body parse (`src/app/api/admin/solicitation/batch/halt/route.ts:107-108`) | `admin/solicitation/batch/__tests__/routes.test.ts` > the admin halt route refuses a non-admin caller even with an AAL2 session and writes nothing | **killed** |
| M10 | delete the gate call from `resolveAdminActor` (`src/app/api/_shared/channels/resolve-actor.ts:70-72`) | `admin/channels/telegram/__tests__/disable.test.ts` > returns 403 when MFA step-up is not satisfied (AAL2) | **killed** |
| M11 | cookie AAL `currentLevel` -> `nextLevel` (the proxy's lenient form) (`verified-identity.ts:102`) | `verified-identity.test.ts` > passes a non-aal2 level through instead of refusing it | **killed** |
| M12 | make `getCurrentUser` dual-mode, widening `requireRole`/`requireRoleOr401` (`db/auth.ts:59-67`) | seam > requireRole remains cookie-only for admin and mixed roles | **killed** |
| M13 | drop the `$` anchor from the token68 regex, so `Bearer a b` yields `a` (`admin-transport.ts:49`) | `admin-transport.test.ts` > returns null for every malformed shape | **killed** |
| M14 | `isExpired`: non-numeric `exp` -> `false` instead of `true` (`verified-identity.ts:72`) | seam > bearer expired | **killed** |

**14 mutations, 14 killed, 0 survivors, 0 inconclusive, 0 skipped.**

Exclusions recorded: `supabase/migrations/` (none in the diff) and Playwright/E2E
specs (none in the diff). No test was DELETED by this diff, so there is no
lost-coverage row. Every behaviour-affecting production hunk in the diff
(`admin-transport.ts`, `verified-identity.ts`, `admin-mfa-gate.ts`, `db/auth.ts`)
has at least one covering candidate above, so no hunk is uncovered.

**The vacuity check the brief asked for came back negative.** All three migrated
route suites (M8, M9, M10) still fail when their route loses its gate, despite the
suites mocking `resolveDualModeIdentity` and `loadAppUser` wholesale. The D3 shim
hazard — a `...Once`-armed `mockRequireRole` consumed twice — is genuinely closed by
reading `mock.results.at(-1)` in the `loadAppUser` shim rather than re-invoking.

## Duty 2 — fragile assertions

Scanned every added/modified test in the diff. Two entries, both recorded above
(RT4, RT5). Explicitly examined and judged NOT fragile:

- `expectRefusal` (`admin-transport-seam.test.ts:148-158`) asserts status + exact
  JSON body + `Location === null` + `Cache-Control`. That is the byte-for-byte
  contract, not a proxy for it, and it catches the redirect regression ADR 0025 D9
  is about.
- `cookieClientCalls.count` / `cookieClients.count` — counting cookie-client
  CONSTRUCTIONS is the only available proof that a bearer refusal did not retry the
  other transport. Behavioural, not incidental.
- `expect(Object.keys(identity!).sort()).toEqual(['aal','authUserId','transport'])`
  (`verified-identity.test.ts:189`) — an exact key set, which normally reads as
  incidental structure; here it IS the "the seam decides nothing" contract, since a
  fourth key would mean the seam started carrying a decision. Kept.
- `expect(result).not.toHaveProperty('transport')` (`admin-transport-seam.test.ts:189`)
  — an absence assertion, but of the exact property whose appearance would break
  `ci:admin-aal2`'s credited gate shape. Kept.

No absence-of-tag proxies, no exact string counts on rendered output, no order
assertions without an ordering contract.

## Duty 3 — docs vs reality

`python3 ~/.claude/skills/grill-me-codex/scripts/prevalidate-plan.py` was run against
all four changed docs. Raw result: plan `6 ISSUES`, handoff `2 ISSUES`, deviations
`PASS`, blast-radius `PASS`. All were hand-resolved against HEAD:

| Cited | Script verdict | Hand-resolved at HEAD |
|---|---|---|
| `lib/helpers.js:270` (`validateExp`) | unresolved — not a repo path | **CORRECT.** `dist/module/lib/helpers.js:270` = `export function validateExp(exp)`, throwing a plain `Error('Missing exp claim')` / `Error('JWT has expired')` at `:272`/`:276`. The seam's "throws a PLAIN Error … the house rule is to match on code, never text" is accurate. |
| `lib/helpers.js:142` (`decodeJWT`) | unresolved | **CORRECT.** `dist/module/lib/helpers.js:142`. Segments are `BASE64URL_REGEX`-checked, then `JSON.parse`d unguarded, so `ew.e30.AA` (header decodes to `{`) escapes as `SyntaxError` and `bnVsbA.e30.AA` (header decodes to `null`) escapes as `TypeError` at `header.alg`. The comment at `verified-identity.ts:138-144` is measured, not assumed. |
| `lib/helpers.js:153` | unresolved | **CORRECT.** Inside `decodeJWT`'s regex/parse body. |
| `lib/errors.js:49`, `:222` | unresolved | **CORRECT.** `dist/module/lib/errors.js:49` `isAuthApiError` and `:222` `isAuthRetryableFetchError`, both `error.name ===` comparisons — so the seam's "keeps working across a duplicated module instance where `instanceof` would not" is sound. |
| `lib/fetch.js:20`, `:24-30, 72` | unresolved | **PARTIALLY FALSE — see RT1.** `:22` `NETWORK_ERROR_CODES`, `:25`/`:29` the two `AuthRetryableFetchError` throws and `:72` the `AuthApiError` fall-through are all correct; the prose claim that the fall-through catches EVERYTHING else is not. |
| `01a07ec1`, `aac113e41fbb` (handoff:46) | "does not resolve to a commit" | **FALSE POSITIVE.** Those are two halves of one UUID `01a07ec1-2cea-75f3-bcb4-aac113e41fbb` (an eval-round id), not SHAs. |
| `scripts/ci/db-imports-audit.ts:112` (plan:24) | resolved | **CORRECT to the line.** `:112` is `if (file === 'src/lib/db/auth.ts') return true;` — `db/auth.ts` really is a named composition root, so the extraction of `loadAppUser` into it does not violate invariant #15. |
| `src/lib/auth/route-helpers.ts:33` (plan:186, seam test:20) | resolved | **CORRECT to the line.** `:33` is `return NextResponse.json({ error: 'forbidden' }, { status: 403 });` — and the accompanying claim "that wrapper sets no cache header" is true, which is what the seam suite's one `noStore: false` case pins. |
| `src/lib/auth/reset-password-error.ts:1` (plan:113) | resolved | Correct in substance (the file maps on `AuthError['code']`, never on message text); `:1` is a whole-file pointer rather than a precise line. Not worth a finding. |
| JWKS cache claim (intake:51) | n/a | **Verified correct on the sharing half, conditional on the fetch half — RT6.** |

## Duty 4 — missed sibling cases

Patterns searched, scope `src/ worker/ scripts/`, exclusion `__tests__/` for the
production-site counts:

1. `requireCurrentAal2FromSupabase` — the AAL primitive the gate STOPPED calling.
   Five production sites remain, all same-origin browser surfaces where no bearer
   exists: `src/app/admin/impersonate/[sessionId]/view/page.tsx:43`,
   `src/app/api/auth/mfa/challenge/route.ts:249`, `src/lib/auth/page-gate.ts:75`,
   `src/lib/admin/shell-context.ts:67`, plus the audit's own constant at
   `scripts/ci/admin-aal2-audit.ts:189`. Not dead, and correctly left cookie-only.
   **Zero siblings.**
2. `requireAdminWithAal2` / `requireAdminJson` / `resolveAdminActor` — the three
   gate shapes `ci:admin-aal2` credits. Both compositional shapes were MEASURED, not
   assumed: `requireAdminJson` via M9 and `resolveAdminActor` via M10, and both suites
   went red when the underlying gate call was removed. This answers the brief's
   "covered, or only assumed?" — covered.
3. `git diff --name-only <mb> <head> -- 'src/app/api/admin/**/route.ts'` — EMPTY. No
   admin route handler changed; the 22 migrated suites are test-only edits, so no
   route silently lost or gained a gate in this diff.
4. `git diff --stat <mb> <head> -- src/proxy.ts` — EMPTY, which is the basis of RT7.

A zero-sibling result on searches 1 and 3 is the honest outcome; nothing was invented
to fill them.

## Duty 5 — operational completeness

Full comparison in RT2. Summary against the six facets:

| Facet | Emitted | Rule row |
|---|---|---|
| Signal identity | none — `console.error` only, no Sentry event | — |
| Filter tag | none (`subsystem`/`feature`/`fault` unset) | — |
| Level | n/a | — |
| Grouping title | the literal `[admin-mfa-gate] unexpected failure:` | — |
| Threshold / cadence | n/a | — |
| Destination action | n/a | — |

Both halves absent, so the comparison is a single P1 rather than six.

**Secret handling — CLEAN.** No token, claim, header value or identity is logged
anywhere in the diff: `src/lib/auth/verified-identity.ts` and
`src/lib/auth/admin-transport.ts` contain zero logging statements, and the only log
site added or touched is `internalError`, which passes the error object and never the
request. As defence-in-depth on the new bearer surface,
`src/lib/shared/sentry-scrub.ts:22`'s
`SENSITIVE_KEY_RE = /key|secret|token|password|authorization/i` does cover an
`authorization` header key should a request event ever reach Sentry via
`onRequestError`.

## Authorizations

None. No finding on this run is `accepted-risk`.

## Adjudication required

`risk: high` with two open P1s. Per the protocol the invoking root agent is not the
arbiter here — RT1 and RT2 need user adjudication, or a fix, before the `reviewed`
transition can pass. RT1 is a small, self-contained code + comment change; RT2 is a
tagging + runbook-row change. Neither requires re-planning.
