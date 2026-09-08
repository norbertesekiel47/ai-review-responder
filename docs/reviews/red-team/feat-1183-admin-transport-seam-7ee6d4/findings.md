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

---
---

# Red team — #1183 Admin transport seam — ROUND 2

- **Mode** `feature` · **Round** 2 · **Risk** `high`
- **Branch** `feat/1183-admin-transport-seam`
- **fork / merge-base** `4aa132bac9e3d7f6f2eb72e669b57885ba16c6e5`
- **round-1 head** `344dcbc0524e6733fef988ce66fc43db013dd088`
- **head (this round)** `dbefb3b80fdbfdf135b62b568cf5af1499f95088`
- **intake sha256** `f03eda84ed250d0b092116bdb03d38885c58e596b9039c144a10fc93280f6679` (the intake moved in the fix commit)
- **Status** `OPEN_P0` — RT8 is a confirmed mutation survivor.

**Scope, per the round-2 brief:** the fix hunks in `git diff 344dcbc0..dbefb3b8`
and their direct callers. Unchanged code is not re-reviewed; the one sibling found
outside the diff is in the Appendix, untriaged.

Environment: identical allowlist to round 1 (`mutation-runner env`, temporary
`HOME`, `NODE_ENV=test`, `CI=true`, `MOCK_EXTERNAL_APIS=true`,
`REPWORTH_DISABLE_LIVE_DB_SUITES=1`, `.env.local` swapped for a scrubbed copy for
the whole mutation phase). `watchers` reported none. `round-start` opened round 2
and reset the budget. `finalize` reaped 12 process groups, restored 0 mutated files
(each was restored by name immediately after its run, so the journal found every
target already at its original blob) and restored 1 dotenv file.

**Mutations run: 6 (M15–M20). Survivors: 2 (M19, M20 — one finding, RT8).**
12 supervised runs (6 baselines + 6 mutants). `git status --porcelain` is empty
outside this report directory.

---

## Round-2 findings

| # | Severity | file:line | Finding |
|---|---|---|---|
| RT8 | **P0** | `src/lib/auth/__tests__/admin-transport.test.ts:118` | The Edge zero-imports guard is defeated by two of the three natural import forms: a line-wrapped `import { … } from …` and a bare `import 'node:crypto';` both survive. Measured, not argued (M19, M20). |
| RT9 | **P1** | `src/lib/auth/verified-identity.ts:76` | The corrected comment replaces one false enumeration with another: `handleError` does not raise "exactly three shapes" — it has five throw sites. Repeated in the intake and the plan. |
| RT10 | **P1** | `src/lib/auth/__tests__/verified-identity.test.ts:206` | The unstubbed premise test is named "throws **non-AuthError**" but asserts only `.rejects.toThrow()`. An `AuthError` throw keeps it green — which is exactly the channel move it exists to catch. |
| RT11 | P2 | `src/lib/auth/__tests__/admin-transport-seam.test.ts:490` | The second "refusal precedence" test pins no precedence. With a null identity the gate returns 401 before `loadAppUser` runs, so its `sqlRows.next = [OWNER_ROW]` is inert and the case is behaviourally identical to `bearer with a forged signature` (`:320`). |
| RT12 | P2 | `src/lib/auth/verified-identity.ts:106` | The cookie-arm revert is complete for the fault classification, but the arm is not byte-for-byte for EVERY outcome: an ordering change makes `{live session, no users row or non-admin role} × {AAL call THROWS}` a 500 where the fork answered 401/403, and every refused cookie request now pays one extra AAL round-trip the fork short-circuited. |
| RT13 | P2 | `docs/directory/lib-platform.md:82` | Two facts were dropped that are not verbatim in the file the row points at: `mfa.ts`'s remaining consumer (the page gate), and `reset-password-error.ts`'s "the house rule for **every** Supabase error" generalization. |
| RT14 | P2 | `src/lib/auth/__tests__/admin-transport-seam.test.ts:368` | `namedAuthError('AuthUnknownError', 500)` is a shape the SDK cannot produce — `AuthUnknownError`'s constructor is `(message, originalError)` and never sets `status` — presented in a block whose comment calls these "the THREE shapes handleError can raise". |
| RT15 | P2 | `docs/reviews/feat-1183-admin-transport-seam/triage.md:16` | Rejection #16 says the limitation was "recorded in the test". `src/lib/db/__tests__/auth.test.ts` is byte-unchanged since `344dcbc0`, and its `:122-128` comment records the assertion's STRENGTH (the counterexample), not the limitation the finding named. |

---

## Verification of the round-1 fixes

### Fix 1 — the `AuthUnknownError` arm: CORRECT and COMPLETE. RT1 → `fixed`.

**Correct.** `AuthUnknownError extends AuthError` and calls `super(message)` only
(`dist/module/lib/errors.js:66-72`), so it carries `__isAuthError = true`,
`name = 'AuthUnknownError'` and `status === undefined`. `isAuthError` is a duck-type
check on `'__isAuthError' in error` (`:28-30`), not an `instanceof`, so the new arm
keeps the module-duplication property the comment claims for the other two.
`isTransportFailure` at `verified-identity.ts:95` therefore matches it, and the
`status ?? 500` fall-through was never going to (the `isAuthApiError` name test
fails first).

**Complete — the sound search, recorded.** `handleError`
(`dist/module/lib/fetch.js:23-72`) has **five** throw sites, not three:

| line | shape | classified as | correct? |
|---|---|---|---|
| 25 | `AuthRetryableFetchError(msg, 0)` — not a fetch Response | fault → 500 | ✅ |
| 29 | `AuthRetryableFetchError(msg, status)` — 502/503/504/520-524/530 | fault → 500 | ✅ |
| 36 | `AuthUnknownError` — `await error.json()` threw | fault → 500 | ✅ **(the fix)** |
| 59 / 63 | `AuthWeakPasswordError(msg, error.status, reasons)` | refusal → 401 | ✅ unreachable on `getUser`/`getClaims`; a genuine credential answer if it were |
| 69 | `AuthSessionMissingError()` (status 400) | refusal → 401 | ✅ correct — this is the revocation answer |
| 72 | `AuthApiError(msg, status \|\| 500, code)` | ≥500 → fault, else refusal | ✅ |

So there **is** a fourth and a fifth shape that fall through to 401, and both are
genuinely refusals on these two calls. The arm is complete. The COMMENT that says
there are three is not — see RT9.

Two channel checks were re-derived rather than assumed:

- `getClaims` catches everything and returns only `AuthError`s, rethrowing the rest
  (`GoTrueClient.js:4875-4880`). So `handleError`'s throws reach the seam through the
  RETURNED channel, which is what `isTransportFailure` reads.
- The JWKS path is covered by the same arm: `fetchJwk` (`:4735-4740`) issues a plain
  `_request` and rethrows its error, so a JWKS endpoint answering an HTML 502 from a
  CDN produces `AuthUnknownError` → returned by `getClaims` → **500**. That is a real
  reachable instance of the fixed bug, not a hypothetical.

**Mutation M15** — delete `verified-identity.ts:95` — turned
`admin-transport-seam.test.ts > a Supabase transport fault is internal_error, not
Unauthorized` **red** (exit 1, exactly one test executed). **Killed.**

### Fix 2 — the cookie-arm revert: COMPLETE for fault classification; one residual ordering delta. RT3 → `fixed`, new RT12 → P2.

Every cookie-mode outcome compared against the fork
(`git show 4aa132ba:src/lib/auth/admin-mfa-gate.ts:55-89`, `getCurrentUser`,
`requireCurrentAal2FromSupabase`):

| cookie scenario | fork (`4aa132ba`) | HEAD (`dbefb3b8`) | |
|---|---|---|---|
| no session (`getUser` → `user: null`) | 401 `Unauthorized` | 401 `Unauthorized` | same |
| returned auth error, `user: null` | 401 `Unauthorized` (error ignored) | 401 `Unauthorized` | same — **the revert** |
| session, no `users` row | 401 `Unauthorized` | 403 `Forbidden` | **declared delta 1** |
| session, role ≠ admin | 403 `Forbidden` | 403 `Forbidden` | same |
| session, admin, AAL returns `error` or `!data` | 403 `mfa_check_failed` | 403 `mfa_check_failed` | same — **the revert** |
| session, admin, `currentLevel: 'aal1'` | 403 `mfa_required` | 403 `mfa_required` | same |
| session, admin, `currentLevel: null` | 403 `mfa_required` | 403 `mfa_check_failed` | **declared delta 2** |
| session, admin, `currentLevel: 'aal2'` | ok | ok | same |
| `getUser` THROWS | 500 `internal_error` | 500 `internal_error` | same |
| session, **admin**, AAL call THROWS | 500 `internal_error` | 500 `internal_error` | same |
| `loadAppUser` / DB throws | 500 `internal_error` | 500 `internal_error` | same |
| session, **no row / non-admin**, AAL call THROWS | 401 / 403 | **500** | **RT12 — undeclared** |

Only the last row diverges, and it is ordering, not classification: the fork ran
`requireRole` first and returned before ever touching the AAL endpoint, while
`resolveCookieIdentity` always calls it. It requires a non-`AuthError` throw out of
`getAuthenticatorAssuranceLevel` (auth-js returns `AuthError`s rather than throwing;
a Web Locks timeout is the realistic instance). The same ordering also means every
refused cookie request now pays an AAL round-trip the fork skipped. P2: obscure, and
both answers are already failure answers — but "byte-for-byte… for EVERY outcome" is
the claim being made, so it is recorded rather than waved through.

The refusal-body bytes are identical: the fork's `AuthError` catch produced
`{ error: err.message }` with `err.statusCode`, and `requireAuth`/`requireRole` throw
exactly `'Unauthorized'` (401) and `'Forbidden'` (403).

**Mutation M16** — re-apply both classifier lines to `resolveCookieIdentity` — turned
`a cookie-path Supabase fault keeps its pre-ticket answer, not the bearer 500`
**red**. **Killed.** The revert is pinned.

### Fix 3 — the new tests

| Test | Failable? | Asserts its name? |
|---|---|---|
| `a cookie-path Supabase fault keeps its pre-ticket answer, not the bearer 500` | **Yes** — M16 kills it. | **Yes.** It drives both halves (the `getUser` error and the AAL error) and asserts the exact pre-ticket 401 / `mfa_check_failed`. |
| `answers Forbidden when the caller is BOTH a non-admin and unreadable-AAL` | **Yes** — M17 (move the role check below the two AAL checks) kills it. | **Yes.** This closes round-1 RT5. |
| `answers Unauthorized when the credential is bad AND the user is a non-admin` | Passes, but pins nothing new. | **No** — RT11. |
| `throws non-AuthError for malformed tokens that pass its shape checks` | **Yes**, and provably unstubbed: a green run is itself the proof, because `vi.mock` replaces `getClaims` with a `vi.fn()` that returns `undefined`, and `await expect(undefined).rejects.toThrow()` fails. So green ⇒ `vi.importActual` really bypassed the mock. No network is reached — `decodeJWT` throws before `fetchJwk`. | **No** — RT10: the assertion is `.rejects.toThrow()`, which an `AuthError` also satisfies. |
| `RETURNS an AuthError for a token that fails its shape checks` | **Yes**, same argument. | **Yes** — it asserts `data === null` and `error.name === 'AuthInvalidJwtError'`. |
| `has no imports at all, so src/proxy.ts can take it to the Edge (#1185)` | **Partly** — M18 kills it, M19 and M20 do not. | **No** — RT8. |

---

### RT8 — **P0** — `src/lib/auth/__tests__/admin-transport.test.ts:118` (Duty 1, confirmed survivor)

The guard the standards axis asked for is:

```ts
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const importLines = code
  .split('\n')
  .filter((line) => /^\s*(import|export)\s.*\sfrom\s/.test(line) || /^\s*import\s*\(/.test(line))
  .map((line) => line.trim());
expect(importLines).toEqual([]);
```

It is **line-oriented**, and an ES import is not. Three mutations of
`src/lib/auth/admin-transport.ts`, each adding the SAME Edge-breaking dependency,
each run against the single test under a paused supervisor with `assert-one-test`:

| # | mutant | result |
|---|---|---|
| M18 | `import { createHash } from 'node:crypto';` | exit 1 — **killed** |
| M19 | `import {`⏎`  createHash,`⏎`} from 'node:crypto';` | exit 0 — **SURVIVED** |
| M20 | `import 'node:crypto';` | exit 0 — **SURVIVED** |

**Arbiter confirmation.** Neither survivor is equivalent: after M19 and after M20 the
module genuinely imports `node:crypto`, which is precisely the condition the test's
own title ("has no imports **at all**") and the module header ("nothing here may
import `node:*`") declare impossible. Neither is on an unexecuted branch — the test
reads the mutated file off disk and scans every line of it. M19 evades because the
filter requires `import` and `from` on ONE line; M20 evades because a side-effect
import has no `from` at all. M19's shape is what Prettier produces for any import
list that exceeds the print width, so this is a formatter away from being the
default, not an adversarial construction.

**Blast radius, stated so the severity can be adjudicated proportionately.** This is
not a runtime security defect — the production module is correct today and the
predicate itself is right. The consequence is that the sole mechanical enforcement of
a stated hard constraint has a hole, so #1185 can discover "Edge-safe" as a broken
Edge bundle attributed to the wrong author, which is the exact failure the test's own
comment says it exists to prevent. It is P0 by the protocol's rule (a confirmed,
non-equivalent, executed survivor) and the fix is small: strip string and template
literals before scanning, then match `/(^|\n)\s*import\b/` and
`/(^|\n)\s*export\b[\s\S]*?\bfrom\b/` across the whole source rather than per line —
or simply assert `code` contains no `\bimport\b` and no `\brequire\b` at all, which
is the true contract for a module that is meant to have zero dependencies.

**On the brief's comment-stripping question.** The stripping itself is a smaller
hazard than the line-orientation, but it is not clean either. `/\/\*[\s\S]*?\*\//g`
runs BEFORE the `//` strip and is unaware of strings, so `const s = '/*';` … `'*/'`
would swallow every line between — including an import. Nothing in the file does that
today (its only regex literal, `/^Bearer[ \t]+([^\s]+)$/i`, contains no `/*`), so this
is theoretical where M19/M20 are demonstrated. Stripping strings first fixes both.

Disposition: **open**.

### RT9 — **P1** — `src/lib/auth/verified-identity.ts:76` (Duty 3)

The comment now reads:

> Measured against @supabase/auth-js 2.106.2, `lib/fetch.js` `handleError`, which
> raises **exactly three shapes** and each needs its own test

Measured at HEAD, `handleError` has five throw sites raising five classes — the table
under "Fix 1" above. Round 1's own RT1 enumerated them ("`handleError` has four other
exits"), so the correction had the right facts available and narrowed rather than
widened. The same "three" framing is restated in
`docs/superpowers/plans/feat-1183-admin-transport-seam-intake.json` ("covers all
THREE shapes handleError can raise") and, one step weaker, in
`.claude/reference/arch-review-log.md` ("raises a THIRD shape").

**No behavioural consequence today** — the two omitted shapes are
`AuthWeakPasswordError` (unreachable on `getUser`/`getClaims`) and
`AuthSessionMissingError` (a refusal, and the correct 401). This is a claim defect,
not a code defect. It is P1 because it is a false factual assertion in the one comment
whose entire job is to be the authoritative enumeration for an auth classifier, made
in the same edit that fixed the previous false enumeration in the same sentence — the
next maintainer who reasons "there are only three, so anything else must be an
`AuthApiError`" reaches the wrong conclusion the same way the first author did.

Correct wording: *five shapes — `AuthRetryableFetchError` (×2 paths),
`AuthUnknownError`, `AuthWeakPasswordError`, `AuthSessionMissingError`, and the
`AuthApiError` fall-through. Three are faults-or-refusals we must split; the last two
are refusals and are unreachable or correct on these two calls.*

Two smaller stale claims ride along in the same comment block and the plan:

- `verified-identity.ts:89` — "The **predicates** compare `error.name`". The new arm
  is not a predicate; it is `isAuthError(error) && error.name === '…'`, and
  `isAuthError` compares `'__isAuthError' in error`, not a name. The property claimed
  (survives a duplicated module instance) still holds, by a different mechanism.
- `docs/superpowers/plans/feat-1183-admin-transport-seam-plan.md:164` — "**Both**
  predicates compare `error.name` (`lib/errors.js:49-51, 222-224`)" is now three arms.
  The two line citations themselves re-resolve **CORRECT** at HEAD (`:49-51`
  `isAuthApiError`, `:222-224` `isAuthRetryableFetchError`).

Disposition: **open**.

### RT10 — **P1** — `src/lib/auth/__tests__/verified-identity.test.ts:206` (Duty 2)

```ts
it('throws non-AuthError for malformed tokens that pass its shape checks', async () => {
  …
  await expect(real.auth.getClaims(token, { allowExpired: true })).rejects.toThrow();
```

The name promises **non-**`AuthError`; the assertion promises only "rejects".
`.rejects.toThrow()` is satisfied by an `AuthError` too, and `AuthError extends Error`.

That gap is the whole point of the block. The seam's rule is "a throw from either SDK
await is a 401; the 500 arm is driven by the RETURNED error type"
(`verified-identity.ts:175-188`). If a dependency bump moved `ew.e30.AA` from a raw
`SyntaxError` to a thrown `AuthApiError(500)` — a shape that DOES exist in the
codebase's own vocabulary — the catch at `:185-188` would call `isTransportFailure`
on it, answer true, and an unauthenticated caller with a three-character token would
force 500s on the admin control plane. That is precisely the outcome the comment above
the try block says it exists to prevent, and this test would stay green through it.

Behavioural replacement: reject on the class, not merely on rejection —

```ts
await expect(real.auth.getClaims(token, { allowExpired: true })).rejects.toSatisfy(
  (e: unknown) => !isAuthError(e),
);
```

(or catch and `expect(isAuthError(err)).toBe(false)`), which is both failable and
exactly the sentence the test's name already claims.

Disposition: **open**.

### RT11 — P2 — `src/lib/auth/__tests__/admin-transport-seam.test.ts:490` (Duty 2)

```ts
it('answers Unauthorized when the credential is bad AND the user is a non-admin', async () => {
  mockGetClaims.mockResolvedValue({ data: null, error: namedAuthError('AuthInvalidJwtError') });
  sqlRows.next = [OWNER_ROW];
  await expectRefusal(refusalOf(await requireAdminWithAal2(bearerReq())), 401, { error: 'Unauthorized' });
```

There is no ordering choice at this point in the gate to pin. With
`AuthInvalidJwtError` returned, `resolveBearerIdentity` reaches
`if (!claims) return null` (`verified-identity.ts:190-191`), so
`requireAdminWithAal2` takes `if (!identity) return refuse(401, 'Unauthorized')`
(`admin-mfa-gate.ts:98`) **before** `loadAppUser` is called at `:100`.
`sqlRows.next = [OWNER_ROW]` is therefore never read, and the test is behaviourally
identical to `bearer with a forged signature` (`:320-327`), which arms the same
`namedAuthError('AuthInvalidJwtError')` and asserts the same 401.

Deliberately not measured as a mutation: the only mutation that would separate the two
(hoisting the role check above the identity null-check) turns BOTH tests red, which
proves nothing about the new one. Reported from a static read, on round 1's RT5
precedent, rather than manufacturing an `inconclusive` row.

Its sibling at `:475` is real and does pin the order — M17 confirms it. Nothing needs
deleting; the second case just should not be read as coverage it does not provide, and
its comment ("Same argument one level up") claims it is.

Disposition: **open**.

### RT12 — P2 — `src/lib/auth/verified-identity.ts:106` (Duty 1 / spec)

The last row of the equivalence table under "Fix 2". The docblock's "Today's path,
unchanged … 'byte-for-byte… Do not touch it'" and the gate's "Two refusals moved" are
true of the classification and of the refusal TABLE, and false of one ordering-induced
outcome: with a live cookie session but no admin row, a THROWN AAL failure is now 500
where it was 401/403.

Cheapest honest fixes, in order of preference: (a) say so — one clause in the docblock,
since the case is already a failure either way; or (b) restore the fork's order by
resolving the app user before reading AAL, which also removes the extra round-trip on
every refused request. Not (c) re-adding a classifier — that is what was just reverted.

Disposition: **open**.

### RT13 — P2 — `docs/directory/lib-platform.md:82` (Duty 3, information loss)

The page is at **2,999/3,000 words** (`wc -w`) after nine rows were rewritten to fit.
Each dropped fact was re-resolved against the file its row points at. Seven of nine are
clean — the fact survives verbatim in the target file:

| row | dropped | verbatim in the file? |
|---|---|---|
| `require-owner-access.ts` | the three memo names | ✅ `getRenderAuthUser` `:96`, `getRenderOwnerRow` `:123`, `getRenderRequestScope` `:142` |
| `verified-identity.ts` | "two sibling resolvers, never one with a posture parameter" | ✅ `:10` verbatim |
| `verified-identity.ts` | "D1–D4" → "ADR 0025" | ✅ the module cites D1, D3, D4 |
| `admin-transport.ts` | "D7" → "D6" | ✅ the module still says "ADR 0025 D6/D7" `:4` |
| `admin-mfa-gate.ts` | "Why: ADR 0025." | ✅ the module cites ADR 0025 at `:29`, `:39`, `:46`, `:59` |
| `provision-auth-user.ts` | "`signUp` → timestamp recovery" | ✅ "hosted-Auth timestamp-based recovery query" `:35`, `supabase.auth.signUp` `:34` |
| `route-helpers.ts`, `get-request-scope.ts`, `page-gate.ts`, `resolve-owner-scope.ts` | wording only | ✅ no fact removed |

Two are not:

1. **`mfa.ts` lost its remaining consumers.** The old row said "Since #1183 the admin
   API gate reads AAL via `verified-identity.ts`; **the proxy and page gate still use
   these**." The new row states the proxy half as a NEGATIVE ("`src/proxy.ts` does NOT
   use these") and drops the page gate entirely. `page-gate.ts`'s own row says only
   "optional AAL2" and names no helper, and `mfa.ts` has no module docblock naming its
   callers (the old row's "WHY: the module docblock" pointer went too). So the map no
   longer answers "who consumes `mfa.ts`" — the answer is
   `src/lib/auth/page-gate.ts:75`, `src/lib/admin/shell-context.ts:67`,
   `src/app/admin/impersonate/[sessionId]/view/page.tsx:43` and
   `src/app/api/auth/mfa/challenge/route.ts:249` (round 1, Duty 4, re-verified).
2. **`reset-password-error.ts` lost the generalization.** "matched on **`code`, never
   message**" survives (`:31-33`, "Matched on `code` alone, not the message text").
   "(the house rule for **every** Supabase error)" does not — that scope claim now
   exists only as a code comment in a different module
   (`verified-identity.ts:170-172`, "The house rule … is to match on code, never
   text"). Not lost from the repo; lost from the map, and the map is where a reader
   looks for a rule that binds more than one file.

The rest of the diff's rewrites are net INFORMATION GAINS — the `mfa.ts` row's restored
`mfa_factor_enrolled`/`mfa_challenge_succeeded` pair, the proxy divergence, "role
before AAL", and "asserted by a zero-imports test" — so this is a trim that overshot in
two cells, not a systematic regression.

Disposition: **open**.

### RT14 — P2 — `src/lib/auth/__tests__/admin-transport-seam.test.ts:368` (Duty 2)

`namedAuthError('AuthUnknownError', 500)` builds `new SupabaseAuthError('boom', 500)`
with the name overridden. The real class cannot present that way:
`AuthUnknownError`'s constructor is `(message, originalError)` and calls
`super(message)` with no status (`dist/module/lib/errors.js:66-72`), so
`status` is always `undefined`. The `namedAuthError('AuthUnknownError')` case above it
is the faithful fixture and is the one that matters.

Harmless as breadth — the arm is name-based, so both pass — but it sits under a comment
asserting "All THREE shapes `handleError` can raise are covered", which makes a
fictional fixture read as a measured one. Either drop the parameterized second case or
label it "defensive: the SDK never sets a status here".

Disposition: **open**.

### RT15 — P2 — `docs/reviews/feat-1183-admin-transport-seam/triage.md:16` (Duty 3)

See "Are the five rejections defensible?" #16 below. Disposition: **open**.

---

## Round-1 findings — dispositions at `dbefb3b8`

| # | Round-1 severity | Disposition | Evidence at this HEAD |
|---|---|---|---|
| RT1 | P1 | **fixed** | `verified-identity.ts:95` adds the arm; M15 kills. Completeness re-derived from `fetch.js` — no unhandled sixth shape. The comment's own enumeration is now RT9. |
| RT2 | P1 | **open** | The DOC half was fixed (the "paged" overclaim is gone from the module, plan and intake, and every replacement claim re-resolves TRUE — `internalError` is still `console.error` only at `admin-mfa-gate.ts:23`; `src/instrumentation.ts:48-54`/`:70-76` pass only `dsn`/`tracesSampleRate`/`beforeSend` with no `integrations` array and so no `captureConsoleIntegration`; `onRequestError = Sentry.captureRequestError` at `:9` fires only for escaping errors; `beta-launch-alerting.md` still has no admin-5xx row). The OPERATIONAL half is unchanged: a terminal 5xx class the diff adds still emits no Sentry signal and has no rule row, which is what Duty 5 grades. Correcting a claim about an alert is not the alert. This is a reasonable deferral, but a deferral is `accepted-risk` and needs an `authorization` entry; with none recorded it stays `open`. |
| RT3 | P1→n/a | **fixed** | The undeclared third cookie delta WAS the classifier on the cookie arm; reverting it makes "Two refusals moved" true again. M16 pins it. (RT12 is a different, ordering-induced delta, not this one.) |
| RT4 | P2 | **rejected** | Triage #16. Reasoning holds; one stated fact does not — see the rejections section. |
| RT5 | P2 | **fixed** | `refusal precedence` `:475`; M17 (role check moved below the AAL checks) turns it red. |
| RT6 | P2 | **fixed** | Intake edge case now reads "CONDITIONAL on a known kid — `fetchJwk` bypasses the TTL for an unknown one", and flags it for #1185. Re-resolved against `GoTrueClient.js:4721-4752`: correct. |
| RT7 | P2 | **rejected** | Triage #17, acknowledged as the #1185 boundary. `git diff 344dcbc0..dbefb3b8 -- src/proxy.ts` is empty, so the qualification still holds exactly as written. |

---

## Are the five rejections defensible?

**#13 (shared 22-suite shim → #1184) — DEFENSIBLE.** The engineering point is granted
by the triage itself; the argument is about WHERE, and it is sound: a shared helper is
a new file outside the declared surface, #1184 already edits all 22 files, and the
protection is against a future edit. The mitigation is measured rather than asserted —
round 1's M8/M9/M10 each removed the gate from a route and each suite went red, so the
shim is not vacuous today. Carried into the PR body and the ticket, so it is not a
silent skip.

**#14 (dead `vi.mock('@/lib/auth/mfa')` scaffolding) — DEFENSIBLE.** Same 22 files,
same ticket, and the stated risk (a suite that uses the mfa mock for something else)
is real: `mfa.ts` exports `factorStatusBefore`, `mfaChallengePath` and
`collectFactors`, which suites can legitimately consume. Deferring 22 tidy-up edits
behind a ticket that already opens all 22 files is the cheaper and safer order.

**#15 (auth-js line citations) — DEFENSIBLE, and the "partially accepted" label is the
honest one.** Verified: the brittle `lib/fetch.js:24-30, 72` numbers are gone from the
module comment, which now cites file + symbol + version; the module's remaining
`lib/errors.js` and `lib/helpers.js:270-276` references carry no line ranges except
`helpers.js:270-276`, which re-resolves CORRECT at HEAD. The substituted control — the
unstubbed decode-channel block — really is the stronger test, because it fails on the
BEHAVIOUR a bump would change rather than on a line number. Two carve-outs, neither
fatal to the verdict: the plan still carries `lib/errors.js:49-51, 222-224` (both
re-resolve correct today, so it is a latent staleness rather than a false claim), and
the substituted test under-asserts — RT10.

**#16 (invariant-#8 SQL regex) — REASONING DEFENSIBLE, ONE STATED FACT FALSE.** The
trade-off argument is right, and I am not re-asserting the finding: a live-DB fixture
would flip the branch to `db_touching` and add a gate row that SKIPs without
`TEST_DATABASE_POOL_URL`, which is a worse default than a deterministic offline
assertion that M6 proved non-vacuous. But the rejection's mitigation — "**with the
limitation recorded in the test**" — is not true. `src/lib/db/__tests__/auth.test.ts`
is byte-unchanged since `344dcbc0` (`git diff --stat 344dcbc0..dbefb3b8 --
src/lib/db/__tests__/auth.test.ts` is empty), and the comment at `:122-128` records the
counterexample, i.e. why the assertion is STRONGER than a `contains` check — the
opposite axis from the limitation, which is that a behaviour-preserving reformat
(`WHERE (u.auth_id) = …`, or renaming the `u` alias) turns it red. Concretely what
breaks: the next author who reformats that query sees a red test with no comment
explaining that the assertion, not the query, is what needs updating, and the recorded
rationale for keeping the regex is not where the rejection says it is. Fix is one
sentence in the test, or one word in the triage row.

**#17 (`src/proxy.ts` branch 4) — DEFENSIBLE.** "Acknowledged, no change" is exactly
right for a finding that was declared in the plan, the intake `user_visible_behavior`
and the staging-smoke section before the review ran. Re-verified: `src/proxy.ts` is
untouched by both commits, so the qualification is still accurate and the #1185
boundary is where it belongs.

---

## Round-2 mutation inventory

Six mutations, all executed; no `skipped-budget` rows. Protocol per row: green
individual baseline at `dbefb3b8` → one semantic mutation via `mutation-runner mutate`
→ the same single test re-run under a paused supervisor → `assert-one-test` → restore
by name.

| # | Mutation | Covering test | Outcome |
|---|---|---|---|
| M15 | delete the `AuthUnknownError` arm (`verified-identity.ts:95`) | seam > a Supabase transport fault is internal_error, not Unauthorized | **killed** |
| M16 | re-apply `isTransportFailure` to both cookie awaits (`verified-identity.ts:129`, `:133`) | seam > a cookie-path Supabase fault keeps its pre-ticket answer, not the bearer 500 | **killed** |
| M17 | move the role check below both AAL checks (`admin-mfa-gate.ts:111` → after `:118`) | seam > answers Forbidden when the caller is BOTH a non-admin and unreadable-AAL | **killed** |
| M18 | add `import { createHash } from 'node:crypto';` (`admin-transport.ts:17`) | admin-transport > has no imports at all… | **killed** |
| M19 | the same import, wrapped across three lines | admin-transport > has no imports at all… | **SURVIVED — RT8** |
| M20 | `import 'node:crypto';` (side-effect, no `from`) | admin-transport > has no imports at all… | **SURVIVED — RT8** |

Excluded candidates, with reasons:

- `verified-identity.test.ts > throws non-AuthError for malformed tokens…` and
  `> RETURNS an AuthError for a token that fails its shape checks` — their subject is
  installed-SDK behaviour in `node_modules`, not a production hunk, so there is no
  production line whose mutation would be meaningful. Both were run individually at
  HEAD (green), which is itself the non-vacuity proof: a stubbed `getClaims` returns
  `undefined` and both assertions would fail. Assertion strength is graded in RT10.
- `seam > answers Unauthorized when the credential is bad AND the user is a non-admin`
  — statically proven to exercise no ordering branch (RT11). The only separating
  mutation also kills its sibling, so running it would manufacture an uninformative
  row.

Round-1 exclusions still hold: no `supabase/migrations/` change, no Playwright/E2E
spec in the diff, and no test was DELETED by either commit.

## Duty 4 — missed sibling cases (round 2)

Pattern searched: name-based classification of a RETURNED `@supabase/*` auth error into
infra-vs-credential. Scope `src/ worker/ scripts/`, all `.ts`/`.tsx`, `node_modules`
excluded, test files reported separately.

`grep -rn 'isAuthRetryableFetchError\|isAuthApiError\|AuthUnknownError\|isAuthError'`
returns exactly two production sites: `src/lib/auth/verified-identity.ts` (the fixed
one) and `src/components/auth/useRecoveryStepUp.ts:151`. The latter is UNCHANGED on
this branch, so per the round-2 brief it is filed in the Appendix rather than triaged.
No third site exists; `src/proxy.ts`, `src/lib/auth/mfa.ts` and
`src/lib/auth/reset-password-error.ts` classify on `error || !data`, on `code`, or not
at all. **One sibling, recorded; nothing invented.**

## Duty 5 — operational completeness (round 2)

The fix commit adds no new terminal or swallowed failure path — it removes two
(`resolveCookieIdentity`'s two `throw new IdentityTransportError` sites) and adds one
classification arm to an existing one. The only Duty-5 item is therefore the unchanged
state of RT2, graded above. Re-verified at this HEAD rather than carried over:
`internalError` (`admin-mfa-gate.ts:22-25`) still emits `console.error` and nothing
else; `src/instrumentation.ts` still initialises Sentry with no `integrations` array in
either the nodejs (`:48-54`) or edge (`:70-76`) branch; and
`docs/runbooks/beta-launch-alerting.md` still carries no rule row matching an admin
5xx. Secret handling stays CLEAN — the fix adds no logging statement and no test
prints a token, claim or header value.

## Authorizations

None. No finding on either round is `accepted-risk`.

## Adjudication required

`risk: high`, cap reached (round 2 of 2). **RT8 is an open P0 and blocks the PR.** The
three open P1s (RT2, RT9, RT10) are on an auth seam and therefore need user
adjudication rather than root-agent arbitration. RT9 and RT10 are each a few lines;
RT8 is a test-only fix; RT2 is the one that needs a decision rather than a keystroke —
either an alert path or a recorded authorization deferring it to its named ticket.

---

## Appendix — outside the round-2 scope, untriaged

**A1 — `src/components/auth/useRecoveryStepUp.ts:151` (unchanged code).** The same
classification shape as the fixed one, with the same gap:

```ts
dispatch(userError.name === 'AuthRetryableFetchError'
  ? { type: 'probeFailed' }
  : { type: 'noSession' });
```

An `AuthUnknownError` — a CDN or WAF answering the recovery probe with a non-JSON body
at a status outside `NETWORK_ERROR_CODES` (500, 429, 403 HTML) — takes the `noSession`
branch, so the user is told their recovery link expired when the app merely could not
check. The file's own comment states the intended rule correctly ("not proof the
recovery link expired, only that this attempt to check couldn't complete"), which is
what makes this a miss rather than a deliberate choice. Client-side UX mis-diagnosis,
not an authorization boundary; P2 if triaged. Recorded here because it is the direct
sibling of the round-1 P1 and would otherwise be rediscovered.


---

## Checker

`node .agents/skills/feature/scripts/red-team-status.mjs` at `dbefb3b8` accepts the
sidecar's schema, path, SHAs, intake hash, dedupe, recomputed counts and recomputed
status, and reports exactly four blocking conditions — all of them findings, none of
them report defects:

```
red-team status is OPEN_P0 — every non-CLEAR status blocks the transition
finding RT2:  a high-risk run cannot ship an open P1
finding RT9:  a high-risk run cannot ship an open P1
finding RT10: a high-risk run cannot ship an open P1
```

---
---

# Round-2 fix verification — re-bound to `217a6e4a`

- **head** `217a6e4aad0a10544cef2c7e3ce97463e865a058` (was `dbefb3b8` when the round-2
  report above was written) · **intake sha256** unchanged
  (`f03eda84ed250d0b092116bdb03d38885c58e596b9039c144a10fc93280f6679`)
- **Status** `OPEN_P1` — RT2 only, escalated to the owner. **No open P0.**

This is a VERIFICATION pass, not a third round: `round-start` was NOT called, no new
front was opened, and every claim below is measured against
`git diff dbefb3b8..217a6e4a`. Four confirming mutations were run inside round 2's
remaining budget (18 of 30 runs used in total) with the same allowlisted environment
and dotenv swap; `finalize` reaped 18 process groups and restored the dotenv file, and
`git status --porcelain` is empty outside this report directory.

| # | Sev | Disposition | Verified how |
|---|---|---|---|
| RT8 | P0 | **fixed** | The guard is now `expect(code).not.toMatch(/\bimport\b/)` over the whole comment-stripped file instead of a per-line shape match. Re-measured rather than taken on trust: green individual baseline, then the two round-2 survivors plus the dynamic form — `import {`⏎`  createHash,`⏎`} from 'node:crypto';`, `import 'node:crypto';`, and `const h = await import('node:crypto');` — each applied via `mutation-runner mutate` and each run under a paused supervisor with `assert-one-test`. **3 mutants, 3 killed, 0 survivors** (M24–M26). |
| RT9 | P1 | **fixed** *(at the P1 site)* | `verified-identity.ts:75-96` now says "raises FIVE shapes", lists the three faults, and adds a paragraph naming `AuthSessionMissingError` and `AuthWeakPasswordError` as genuine credential refusals that correctly fall through to 401 — which matches the five throw sites at `dist/module/lib/fetch.js:25, 29, 36, 59/63, 69, 72`. Residual restatements survive elsewhere → **RT16**. |
| RT10 | P1 | **fixed** | `verified-identity.test.ts:222-236` now captures the rejected value and asserts `isAuthError(thrown) === false` (with `isAuthError` pulled from the same `vi.importActual`), plus `not.toBeNull()` so a RESOLVE still fails. The test now asserts the sentence its name makes. |
| RT11 | P2 | **fixed** | The `sql` mock counts calls and the test asserts `sqlRows.calls === 0`. Measured failable: baseline green, then hoisting `loadAppUser` above the identity null-check in `admin-mfa-gate.ts` — a mutation that leaves the STATUS at 401, so the old assertions could not see it — turned the test red (M27). The new assertion is the load-bearing one, exactly as its comment claims, and it pins a property worth having on its own (a refused credential costs no DB round-trip). |
| RT12 | P2 | **rejected** | Declared, not fixed — and the declaration is defensible. `deviations D6` states both consequences accurately (non-admin **or no `users` row** + a THROWING AAL read → 500 rather than 401/403; one extra AAL round-trip per refused cookie request), the gate docblock repeats the narrower half and points at D6, and the cost of fixing it is real: a lazy AAL read means handing back a thunk instead of the flat `{ authUserId, aal, transport }` ADR 0025 D1 says the seam returns. The delta is fail-closed and needs a Supabase fault and a non-admin simultaneously. One labelling nit, not worth reopening: D6's title calls this "a fifth cookie-path difference", which counts the two deltas the classifier revert already removed — at HEAD there are three. |
| RT13 | P2 | **fixed** | Both dropped facts are back: the `mfa.ts` row now names `requireCurrentAal2FromSupabase`'s consumers ("page gate, shell-context, impersonate view, MFA challenge route"), and the `reset-password-error.ts` row restores "**`code`, never message — the house rule for every Supabase error**". The page is at exactly 3,000 words, paid for by wording trims elsewhere, none of which drops a fact absent from its target file. One bonus correction rides along: the `verified-identity.ts` row dropped "the cookie arm is **byte-for-byte today's path**", which RT12 had just shown to be an overstatement. |
| RT14 | P2 | **fixed** | `namedAuthError('AuthUnknownError', 500)` is gone; a comment in its place records that the class's constructor is `(message, originalError)` and never sets a status, and that the `?? 500` in the classifier is for `AuthApiError`'s optional status. |
| RT15 | P2 | **fixed** | `src/lib/db/__tests__/auth.test.ts:123-133` now carries the limitation itself — a behaviour-preserving reformat turns it red, and it is the ASSERTION that needs updating then, not the query — alongside why the live-DB alternative was declined. The `ci:live-db-suites` workaround (not naming the env var literally) is a genuine constraint of that audit, not an evasion, and the sentence is still unambiguous about which variable it means. |
| RT2 | **P1** | **open** | Unchanged and correctly left open. Re-verified at this HEAD: `internalError` (`admin-mfa-gate.ts:22-25`) still emits `console.error` only, `src/instrumentation.ts` still has no `integrations` array in either runtime branch, and `beta-launch-alerting.md` still has no admin-5xx row. Only the CLAIM was corrected. Escalating rather than self-accepting is the right call — the protocol's `accepted-risk` needs an authorization entry, and a session that cannot reach the owner cannot mint one. |
| RT1, RT3, RT5, RT6 | — | **fixed** | Unchanged from the round-2 report. |
| RT4, RT7 | — | **rejected** | Unchanged. RT4's rejection is now fully sound, because RT15's fix supplied the one stated fact that was false. |

### RT16 — P2 — `docs/superpowers/plans/feat-1183-admin-transport-seam-intake.json:58` (Duty 3)

RT9's title named three sites; the fix reached one. The two restatements of the same
false enumeration are untouched by `dbefb3b8..217a6e4a`:

- `intake.json:58` — "The 500 arm … **covers all THREE shapes handleError can raise**".
  The module comment one file away now says five. A locked contract document and the
  code it governs assert different counts of the same SDK behaviour.
- `plan.md:161-162` — "**The two rethrow rows** above are therefore the complete infra
  arm", written when the table had two; the `AuthUnknownError` row was inserted at
  `plan.md:149` in the previous commit and the sentence beneath it was not updated. The
  conclusion ("the complete infra arm") is still TRUE — it is the count that is stale.

Both are one-word edits. Recorded rather than waved through because RT9 was P1
precisely on the argument that a false enumeration in the authoritative place is worth
fixing, and the intake is the authoritative place for the contract.

Re-resolved and CORRECT at this HEAD, so not findings: `plan.md:164`
(`isAuthRetryableFetchError` and `isAuthApiError` compare `error.name`, `lib/errors.js:49-51,
222-224` — both lines still resolve, and the sentence no longer claims those are the
only arms) and `plan.md:161` (`lib/fetch.js:24-30, 72` — `:25`/`:29` are the two
`AuthRetryableFetchError` throws, `:72` the `AuthApiError` fall-through).

### One residual on the new Edge guard, recorded not reopened

`/\bimport\b/` over the comment-stripped source is fail-CLOSED where the old guard was
fail-open, which is the right direction, and it costs a false red if anyone ever writes
the word "import" in a trailing `// …` comment (the strip only removes full-line `//`).
That is a conversation, not a bypass. The theoretical string-swallowing hazard noted in
RT8 (`const s = '/*'; … '*/'` eating the lines between) is unchanged and still
theoretical; stripping string literals before the block-comment pass would close it.
Neither is worth a finding against a guard that now kills every import form tested.

### Verification mutation inventory (M24–M27)

| # | Mutation | Covering test | Outcome |
|---|---|---|---|
| M24 | wrapped `import {`⏎`  createHash,`⏎`} from 'node:crypto';` (the round-2 M19 survivor) | admin-transport > has no imports at all… | **killed** |
| M25 | `import 'node:crypto';` (the round-2 M20 survivor) | admin-transport > has no imports at all… | **killed** |
| M26 | `const h = await import('node:crypto');` (dynamic form, not previously tested) | admin-transport > has no imports at all… | **killed** |
| M27 | hoist `loadAppUser` above the identity null-check, leaving the 401 status intact | seam > answers Unauthorized when the credential is bad AND the user is a non-admin | **killed** |

M19 and M20 keep their `survived-confirmed-P0` rows: they are the measurement that was
true at `dbefb3b8`, and deleting them would erase why RT8 exists. RT8's disposition,
not its inventory row, is what records that it is now fixed.

---

## Re-bind to `38151f18` — RT16 verified

- **head** `38151f189bef9e24c686f351aa9b89e54bf35254` · **intake sha256**
  `ae4de848af5a3e665df8db537bd7fa953c801a3cd343fd2c54154db6144e5cb1` (the intake moved,
  and `.feature/intake.json` still hashes identically to the `docs/superpowers/plans/`
  copy)
- **Status** `OPEN_P1` — RT2 alone. No open P0, no open P2.

`git diff --name-only 217a6e4a..38151f18 -- src worker scripts` is EMPTY: documentation
only, so no mutation was run and none was owed. Nothing executable changed, so every
measurement above still holds at this SHA.

**RT16 → `fixed`.** All three edits re-resolved against the tree:

- `intake.json:58` now reads "covers **the THREE FAULT shapes of the five** that
  handleError can raise" and names `AuthSessionMissingError` and
  `AuthWeakPasswordError` as the correct 401 fall-throughs. The five-class count is
  right and is now spelled identically in the module comment, the plan and the intake
  (`AuthRetryableFetchError` has two throw sites but is one class, which is the unit
  all three use).
- `plan.md:161-164` now says "**the three** rethrow rows above are therefore the
  complete infra arm" and carries the same five/three split. The table it refers to
  does have three rethrow rows. The conclusion was always true; the count is now true
  with it.
- `deviations.md` D4 corrected on both facts this pass would otherwise have raised:
  the word count (2,998 → "exactly 3,000", which `wc -w` confirms) and the flat "no row
  lost a fact that does not exist verbatim in the file it now points at", which is now
  the accurate version — two rows DID, RT13 named them, they are restored, and the
  other seven re-resolve clean. D6's title is corrected from "a fifth" to "a THIRD
  cookie-path difference", which was the labelling nit recorded but not reopened under
  RT12; at HEAD there are exactly three (no-`users`-row 401→403, `currentLevel: null`
  `mfa_required`→`mfa_check_failed`, and the ordering delta D6 declares).

**RT2 remains `open`, unchanged and deliberately.** It is the only blocking item, and
it goes to the owner as an authorization question rather than being self-accepted by
any agent in this session.

Final checker output at this SHA:

```
red-team-status: FAILED (2 issue(s))
  - red-team status is OPEN_P1 — every non-CLEAR status blocks the transition
  - finding RT2: a high-risk run cannot ship an open P1 — fix it, or record user
    authorization and set disposition accepted-risk
```

Both lines are the same fact.

---
---

# Owner adjudication of RT2 — re-bound to `35e48224`, status `CLEAR`

The owner answered on **2026-09-07** and chose **accept the risk plus a follow-up
ticket**, the first of the two options this report put to them.

- **RT2 → `accepted-risk`**, referencing authorization `AUTH-RT2`, whose verbatim
  text is *"owner 2026-09-07: accepted-risk, follow-up alerting ticket"*.
- **Follow-up ticket: RepWorth/ai-review-responder#1212**, "Admin API 5xx
  (internal_error) has no alert path", labelled `wayfinder:task,area:alerting`. It
  carries the measurements verbatim — `internalError` is `console.error` only;
  `src/instrumentation.ts` has no `integrations` array in either runtime branch, so
  no `captureConsoleIntegration`; `onRequestError` fires only for errors that escape
  a handler and this one is caught by design; no admin-5xx row in
  `beta-launch-alerting.md` — plus the two new sources #1183 adds (a bearer transport
  fault, and the D6 ordering case) and the two suggested fixes (a sanitized, tagged
  Sentry capture in `internalError`, or a `health-alert` check with its runbook row).
  They are recorded there so the next session does not re-derive them.

**Nothing about the finding changed — only its disposition.** The gap is real,
pre-existing, and still open in the codebase; what the owner accepted is shipping
#1183 while it is open, on the argument that this branch made the 500 signal
*correct* rather than laundering an outage into 401s, and that routing it somewhere
is a separate piece of work. The counts move `p1_open` 1 → 0 and `accepted_risk`
0 → 1; no finding was reclassified, closed, or downgraded to get there.

Final checker output:

```
red-team-status: passed (feature run feature-feat-1183-admin-transport-seam-7ee6d4,
round 2, status CLEAR, 27 inventory row(s), 16 finding(s))
```
