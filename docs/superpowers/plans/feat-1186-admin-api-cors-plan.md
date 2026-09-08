# feat/1186 — Admin API CORS: one owner in `src/proxy.ts`

Ticket: RepWorth/ai-review-responder#1186 (`wayfinder:feature`, map #1159).
Design of record: `docs/adr/0026-admin-api-cors.md` (D1–D8, LOCKED).
Amendments that win over their originals: ADR 0026 D4 over `docs/adr/0024-admin-app-split.md` D7;
ADR 0026 D7 over `docs/adr/0025-dual-mode-admin-gate.md` D7.
Intake: `docs/superpowers/plans/feat-1186-admin-api-cors-intake.json` (locked; sign-off
INHERITED from the ticket body per the orchestrator handoff
`docs/superpowers/plans/2026-09-08-admin-split-orchestrator-handoff.md` §4 — the ticket
plus ADR 0026 ARE the signed-off intake, and only deltas were grilled).
Glossary: `docs/context/core-accounts-channels-admin.md` → **Admin origin allowlist**,
**Admin app**, **Admin API**, **Legacy admin portal**, **Admin transport**, **Verified admin**.

Fork point: `origin/main` at `c2de39d8`.

## 1. Modules and seams (`codebase-design` pass)

| Module | Deepen or new? | Why |
|---|---|---|
| `src/lib/shared/csrf.ts` | **Deepen** — one new export, no new file | It already computes "is this our own origin" inside `assertSameOrigin`. ADR 0026 D4 requires ONE predicate shared with `src/proxy.ts`. Exporting the comparison it already performs narrows the module's interface rather than widening it; `assertSameOrigin` becomes a caller of its own core. |
| `src/lib/config/flags.ts` | **Deepen** — one new export | The file's own header declares it "the one home for the target-env resolution" (`isPreviewEnvironment`, `VERCEL_TARGET_ENV`). `isProductionEnvironment()` is the sibling rule. Putting a second `VERCEL_TARGET_ENV` reader anywhere else is the drift that comment forbids. |
| `src/lib/config/admin-origins.ts` | **NEW — forced** | `ADMIN_APP_ORIGINS` must be read in the `src/lib/config/` prefix, the only sanctioned `process.env` home (`scripts/ci/process-env-baseline.ts` `ALLOWLIST_PREFIXES`). Invariant #12 requires the decision branch to be a named module with focused tests. No existing `src/lib/config/` file fits: `flags.ts` is boolean `*_ENABLED` flags, `deployment-lane.ts` is lane resolution, `server.ts`/`client.ts` are Zod lane schemas. Row added to `docs/directory/lib-dashboard-locations-accounts.md` in this PR (`ci:directory-map`). |
| `src/proxy.ts` | **Deepen** — the CORS block + one wrapper | ADR 0026 D1: the proxy is the single owner of CORS and the ONLY writer of an `Access-Control-*` header. The *decision* leaves; the *header writing* stays. |

Nothing widens an interface. No abstraction is introduced for a single caller:
`isSelfOrigin` has two callers on day one (`assertSameOrigin` in `csrf.ts`, and
`admin-origins.ts`). `readAdminAppOrigins`/`isAllowedAdminOrigin` are justified by the
proxy caller and by invariant #12's "extract the decision branch into a named module
with focused tests" — **not** by future consumers: ADR 0026 D7 explicitly REJECTS
widening #1185's `withSameOriginUnlessBearer` to check the allowlist, and ADR 0029 D1
gives #1192 its own `ADMIN_APP_URL` accessor. Neither is a scheduled importer.

## 2. The contract, restated as code shape

### `src/lib/config/admin-origins.ts`

Three exports plus the error class. The comma-list parser stays internal and is driven
through `readAdminAppOrigins()` with `process.env` stubs, so the public surface stays minimal.

```
class AdminOriginConfigError extends Error

readAdminAppOrigins(): readonly string[]        // the ONLY env read; NOT memoized
  raw = process.env.ADMIN_APP_ORIGINS
  - undefined / '' / whitespace-only            → []
  - split ',', trim each, drop empties            (whitespace + trailing commas tolerated)
  - per entry, THROW AdminOriginConfigError when:
      · it contains '*'                            (ADR 0026 D2, mandated)
      · new URL(entry) throws
      · protocol is not http: or https:            (file:/data: have origin "null";
                                                    blob:https://a/b normalizes to https://a)
      · username, password, search or hash is non-empty
      · pathname is neither '' nor '/'             (a bare trailing slash is fine)
  - otherwise push new URL(entry).origin

normalizeOrigin(origin: string | null | undefined): string | null    // EXPORTED
  - new URL(origin).origin, but only when the scheme is http: or https:
  - null for '', the literal 'null', a malformed or multi-valued value, file:, data:
  - the proxy uses it to produce the value it echoes in Access-Control-Allow-Origin

isAllowedAdminOrigin(origin: string, allowlist: readonly string[]): boolean   // pure of the list
  0. normalized = normalizeOrigin(origin)
     null → false           ('' , 'null', malformed, multi-valued, file:, data:)
  1. isSelfOrigin(normalized)                                  → true   (ADR 0026 D4)
  2. isLoopbackOrigin(normalized)  → return !isProductionEnvironment()
                                                  the code rule is the SOLE authority for
                                                  loopback — a listed http://localhost entry
                                                  does NOT win in the production lane
  3. allowlist.includes(normalized)                            → true
  4. otherwise                                                 → false

isLoopbackOrigin(origin)   // internal
  - http: scheme AND hostname in { 'localhost', '127.0.0.1' }, ANY port
  - https://localhost and http://[::1] are NOT loopback (ADR 0024 D7 wrote http://localhost:*)
```

**Only the allowlist throws.** A malformed *request* `Origin` is not a config error:
`isAllowedAdminOrigin` returns `false` for it (refused 403) and never throws.

### `src/lib/shared/csrf.ts`

```
isSelfOrigin(origin: string | null | undefined): boolean   // NEW export, TOTAL
  false when origin is absent, when NEXT_PUBLIC_APP_URL is unset,
  or when either side fails new URL(x); otherwise compares .origin === .origin

assertSameOrigin(request)   // unchanged observable behaviour
  keeps: throw on unset NEXT_PUBLIC_APP_URL · throw on Sec-Fetch-Site: cross-site ·
         throw on missing Origin · throw "Malformed Origin or APP_URL — …" ·
         throw "Origin … does not match APP_URL …"
  the final comparison now goes through isSelfOrigin; the malformed branch keeps its
  own message by testing parseability locally before the verdict.
```

### `src/lib/config/flags.ts`

```
isProductionEnvironment(): boolean
  - a non-empty trimmed VERCEL_TARGET_ENV is trusted verbatim → === 'production'
  - MISSING signal → falls back to NODE_ENV === 'production' (fail closed)
```

The fallback is the round-1 review's A1 fix, corrected by red-team round 2 (RT-10). It
cannot key on `VERCEL`: that variable IS a system environment variable meaning "system
variables are exposed", so it is absent in exactly the configuration the fallback exists
for. `NODE_ENV === 'production'` is true on every Vercel build, production or not — an
imprecision that is acceptable ONLY here, because it is reached solely when the precise
signal is gone and it errs toward denying loopback.

Sibling of `isPreviewEnvironment()`, same file, same comment block.
**Not** `requiresProductionConfig()` — see §5 D-1.

### `src/proxy.ts`

Module constants (the ONLY `Access-Control-*` literals in the repo):

```
ADMIN_CORS_ALLOW_METHODS = 'GET, POST, PUT, PATCH, OPTIONS'   // no DELETE (measured)
ADMIN_CORS_ALLOW_HEADERS = 'Authorization, Content-Type'      // fixed, never echoed
ADMIN_CORS_MAX_AGE       = '600'                              // highest Safari honours
```

Structure — the existing body is extracted verbatim into `handleProxy(request)`, and the
exported `proxy()` becomes the CORS owner in front of it:

```
export async function proxy(request) {
  const routePath = normalizePath(request.nextUrl.pathname);
  const isAdminApi = routePath === '/api/admin' || routePath.startsWith('/api/admin/');

  if (!isAdminApi) return handleProxy(request);   // untouched: no CORS header, and
                                                  // ADMIN_APP_ORIGINS is never read

  const allowlist = readAdminAppOrigins();        // UNCONDITIONAL — a bad value fails
                                                  // loudly on EVERY admin request, including
                                                  // self-origin, loopback and no-Origin ones

  const raw = request.headers.get('origin');          // '' is present, not absent
  const normalized = raw === null ? null : normalizeOrigin(raw);
  const allowed = raw === null ? null : isAllowedAdminOrigin(raw, allowlist);

  if (allowed === false) {
    return corsRefusal();            // 403 {"error":"origin"} + Vary: Origin, no ACAO
  }
  if (allowed === true && request.method === 'OPTIONS') {
    return preflight(normalized);    // 204, ACAO + Methods + Headers + Max-Age + Vary
  }                                  // ← returns BEFORE isProtectedRoute / any Supabase work

  const response = await handleProxy(request);
  addVaryOrigin(response.headers);                            // MERGE, never overwrite
  if (allowed === true) response.headers.set('Access-Control-Allow-Origin', normalized);
  return response;
}

addVaryOrigin(headers)                 // '' → 'Origin'; '*' → left alone;
                                       // 'Accept-Encoding' → 'Accept-Encoding, Origin';
                                       // already contains Origin (any case) → left alone
```

`allowed === null` (no `Origin` header) is "no check": the request falls through to
`handleProxy` exactly as today and still gets `Vary: Origin`.

**`Access-Control-Allow-Origin` echoes the NORMALIZED origin, never the raw header.**
The value written is `normalizeOrigin(raw)` — the canonical serialization of the origin that
was matched, not the bytes the caller sent. WHATWG URL parsing strips tabs and newlines, so
a raw header can normalize onto an allowlisted origin while still differing from it byte for
byte; echoing the canonical form means the header we write is always exactly the origin we
decided about. For any real browser the two are identical (a browser serializes `Origin`
from an origin, so the host is already lowercase and the value carries no whitespace), so
there is no legitimate caller this can break. **This is a canonical-output argument, not a
CR/LF-injection one:** plan round 2 measured the installed `NextRequest`/`NextResponse` and
both throw `TypeError` on a CR or LF in a header value, so that channel does not exist in
this runtime. Test #23 therefore uses mixed-case and tab-bearing fixtures, not an
unconstructible CR/LF request.

## 3. Preflight contract (ADR 0026 D3 — byte-for-byte)

| | Allowlisted origin | Any other origin |
|---|---|---|
| Status | `204` (no body) | `403` `{"error":"origin"}` |
| `Access-Control-Allow-Origin` | the echoed exact origin | absent |
| `Access-Control-Allow-Methods` | `GET, POST, PUT, PATCH, OPTIONS` | absent |
| `Access-Control-Allow-Headers` | `Authorization, Content-Type` | absent |
| `Access-Control-Max-Age` | `600` | absent |
| `Vary: Origin` | present | present |

No `Access-Control-Allow-Credentials`. No `Access-Control-Expose-Headers`.
On a NON-preflight `/api/admin/**` response an allowed origin gets `Access-Control-Allow-Origin`
+ `Vary: Origin` only — `Allow-Methods`/`Allow-Headers`/`Max-Age` are preflight-only per spec.

## 4. Tracer bullets

| # | Tracer | Turns green | Files (edit lease) | Blocking edges | Independent? |
|---|---|---|---|---|---|
| **T1** | **Eval task** — author all 40 `tests_to_add` titles as tests | baseline recorded per title | `src/__tests__/proxy.test.ts`, `src/lib/config/__tests__/admin-origins.test.ts`, `src/lib/config/__tests__/flags.test.ts`, `src/lib/shared/__tests__/csrf.test.ts` | none | first, alone |
| **T2** | Allowlist module + lane predicate | tests 24–34, 40 | `src/lib/config/admin-origins.ts`, `src/lib/config/flags.ts` | T1 | ✅ disjoint from T3 |
| **T3** | Shared own-origin predicate | tests 35–39 | `src/lib/shared/csrf.ts` | T1 | ✅ disjoint from T2 |
| **T4** | Proxy CORS block + header stamping | tests 1–23 | `src/proxy.ts` | T1, T2, T3 | serial |
| **T5** | Registries + code map | `ci:env-registry`, `ci:directory-map`, `ci:static-policy`, `ci:process-env` | `.env.example`, `docs/eservices-variables.md`, `.claude/reference/env-vars.md`, `docs/directory/lib-dashboard-locations-accounts.md` | T2 (the var must exist) | ✅ |

T2 and T3 are mutually independent (no blocking edge, disjoint file sets). T2 is dispatched
FIRST and ALONE as the step-4 enforcement spot check.

Test-title map (exact `tests_to_add` strings, by index in the intake array, 1-based):

- 1–23 → `src/__tests__/proxy.test.ts`, in a new `describe('admin API CORS')` block.
- 24–34 → `src/lib/config/__tests__/admin-origins.test.ts` (new file).
- 35–39 → `src/lib/shared/__tests__/csrf.test.ts`.
- 40 → `src/lib/config/__tests__/flags.test.ts`.

**"All red" is not the eval's evidence, and neither is a fixed red/green count.** Several
titles are CHARACTERIZATION and are green from the first commit — at minimum #12 ("writes no
Access-Control header on a non-admin route": nothing writes one today), #14 ("does not read
`ADMIN_APP_ORIGINS` on a non-admin request": nothing reads it today), #36 and #38 (the
external-origin and loopback CSRF refusals already follow from `src/lib/shared/csrf.ts:35`).
T1 does not assert a count. It **records the observed baseline of every title** —
`green (characterization)` or `red`, with the red ones' failure message — and the rule is
that a red title must fail **for its intended assertion**. A module-collection error is never
counted as red evidence for any title in that file.

## 5. Deltas grilled against the code (the only grilling this run owed)

The ticket body + ADR 0026 are the locked intent. These are the points the ticket does not
resolve and the code does. **None contradicts a locked decision.**

- **D-1 — the production-lane predicate.** ADR 0026 D2 says the loopback rule is "inert in
  the production lane" and names no predicate. `requiresProductionConfig()`
  (`src/lib/config/deployment-lane.ts:107`) is the WRONG one: Vercel sets
  `NODE_ENV=production` on staging and preview builds too, so it would make loopback inert
  on staging — the exact environment ADR 0024 D7 built the loopback rule for. The lane test
  is `VERCEL_TARGET_ENV` — never `VERCEL_ENV`, because the staging custom env reports
  `VERCEL_ENV='preview'`. `isProductionEnvironment()` in `src/lib/config/flags.ts` owns it;
  its JSDoc carries the reasoning, including the fail-closed fallback the review wave added
  (see §8 round 1 A1 and the red-team round-2 correction RT-10) for the case where
  `VERCEL_TARGET_ENV` is absent on a real production deployment.
- **D-2 — `Vary: Origin` needs a wrapper, not four stamps.** A `/api/admin/**` request
  leaves `proxy()` from four sites today — branch 4's `401 Unauthorized`, its
  `403 Forbidden`, its `403 mfa_*` (all three inside `handleProxy`'s
  `routePath.startsWith('/api/admin')` block) and the final `return response` — and
  #1185/#1190 add more. (Cited by symbol, not by line: the fork-relative numbers this delta
  originally carried now land on unrelated lines in the same file.) The exported `proxy()` therefore post-stamps whatever the extracted
  `handleProxy()` returns. Branch 4's cookie/bearer authorization logic is not touched — that
  is #1185's ticket.
- **D-3 — `Access-Control-Allow-Origin` on the ACTUAL response.** ADR 0026 D3's table is
  titled "the preflight response", but a browser blocks every real cross-origin call whose
  response lacks ACAO, even after a successful preflight. The ticket's first two owed tests
  are unqualified ("allowed origin gets the echoed ACAO"), so the actual response carries it.
- **D-4 — `Vary: Origin` even with no `Origin` header.** "`Vary: Origin` goes on **every**
  `/api/admin/**` response" (ticket, ADR D3). The omitted case is precisely the
  cache-poisoning one the ADR names. "No `Origin` means no check" governs the 403, not the header.
- **D-5 — where the shared predicate lives.** `src/lib/shared/csrf.ts` already owns the
  comparison, so it exports it; `src/proxy.ts` and `admin-origins.ts` import it. `csrf.ts`
  has zero imports today, so it stays Edge-safe.
- **D-6 — decision out, header writing in.** The glossary sentence "**`src/proxy.ts`** …
  writes every `Access-Control-*` header" is preserved literally: only the allowlist parse
  and the predicates move to `src/lib/config/admin-origins.ts`, which is what ticket item 2 asks for.
- **D-7 — path match.** The CORS block uses `=== '/api/admin' || startsWith('/api/admin/')`,
  the set `isProtectedRoute` uses (`src/lib/shared/protected-routes.ts`), not branch 4's looser
  `startsWith('/api/admin')`. `/api/adminfoo` gets no `Access-Control-*` header. Branch 4's
  own matching is left unchanged.
- **D-8 — a malformed allowlist entry throws too.** ADR 0026 D2 mandates a throw only on `*`.
  An entry that is not a parseable absolute URL also throws: the failure is loud, the blast
  radius is `/api/admin/**` only, and ADR 0026 Consequences already names "a hard outage of
  the Admin app, not a silent weakening" as the safe direction. **Superseded in part by D-13:**
  a bare trailing slash is the ONLY non-origin component accepted (it normalizes away); a
  non-root path, a query, a fragment or userinfo is REJECTED rather than normalized away.
- **D-9 — loopback set.** Exactly `http://localhost:<any>` and `http://127.0.0.1:<any>`,
  per ADR 0024 D7's `http://localhost:*`. `https://localhost` and `http://[::1]` are not
  admitted; a developer needing either adds an explicit non-production allowlist entry.
- **D-10 — `OPTIONS` with no `Origin`** is not a preflight, so it is not short-circuited:
  it falls through to branch 4 and 401s as it does today.

Deltas D-11 … D-17 were added after plan round 1 (§8) and are the accepted findings:

- **D-11 — the allowlist is validated UNCONDITIONALLY inside the admin boundary**, before
  the self-origin / loopback / missing-`Origin` shortcuts, so `ADMIN_APP_ORIGINS=*` fails
  loudly on every `/api/admin/**` request as the intake promises — and is not read at all on
  a non-admin request, so a bad value can never break `/admin/login` or a public page.
- **D-12 — a loopback origin is the code rule's alone.** `isAllowedAdminOrigin` returns
  `!isProductionEnvironment()` for a loopback origin and never falls through to the list, so
  a listed `http://localhost:3000` cannot re-admit loopback in production. ADR 0026 D2:
  "Loopback is a separate code rule, **not a list entry**."
- **D-13 — the parser validates more than the mandated `*`.** `new URL()` accepts `file:`
  and `data:` (origin `"null"`) and rewrites `blob:https://admin.example/id` to
  `https://admin.example`; a userinfo, query or path component would silently widen an
  apparently URL-scoped entry into authority over the whole origin. Scheme must be
  `http:`/`https:`, and userinfo/path/query/fragment are rejected (a bare `/` is fine).
- **D-14 — `Access-Control-Allow-Origin` echoes the normalized origin**, not the raw header,
  so the header we write is always exactly the origin we decided about (canonical output —
  see §2; not a CR/LF-injection argument, which this runtime forecloses anyway).
- **D-15 — `Vary` is merged, not overwritten.** `headers.set('Vary','Origin')` discards an
  existing `Accept-Encoding`; the stamp appends the token, leaves `*` alone, and never
  duplicates it.
- **D-16 — Edge safety and single-ownership are pinned STRUCTURALLY.** `src/proxy.ts` is
  outside every ESLint invariant #1 zone (`eslint.config.mjs` covers `src/app/**`,
  `src/instrumentation.ts`, `src/components/**`), so a source-scan test asserts the CORS
  import graph carries no `node:` builtin, DB client or forbidden SDK — the
  `src/lib/auth/__tests__/admin-transport.test.ts` § "Edge safety" precedent from #1183.
  A second structural test pins that the own-origin comparison exists in exactly one place.
  The proxy reaches it through `admin-origins.ts` rather than importing `csrf.ts` directly;
  ADR 0026 D4's requirement is one predicate and no second copy, which holds.
- **D-17 — `ci:env-registry` does NOT enforce the second registry row for this var.**
  `scripts/ci/env-registry-audit.ts:756` requires a `.claude/reference/env-vars.md` row only
  for `readFlag` call sites; `ADMIN_APP_ORIGINS` is a raw read, so only the
  `docs/eservices-variables.md` row is machine-enforced. The `env-vars.md` row is added
  because the ticket requires it and is verified by reading, not by the audit. §6's earlier
  claim was overstated.

**One finding is recorded and NOT actioned here** (it changes no code on this branch and
touches a locked ADR): ADR 0026's Context asserts "No cookie can travel cross-origin" from
`SameSite`. That is imprecise — `admin.repworth.net` and `repworth.net` are *same-site*
though cross-origin, so a `lax` cookie IS sent on a cross-site-origin `fetch` between them.
The ADR's *conclusion* still holds by a different control: `assertSameOrigin` refuses any
`Origin` that is not `NEXT_PUBLIC_APP_URL`, so an Admin-app-origin credentialed mutation is
refused by CSRF, and this ticket does not change that either way (the same cookie behaviour
exists today, without CORS). Raised to the owner as an ADR-text correction, not a code change.

## 6. Verification

Gate rows beyond the standard set (`verification_commands`):
`pnpm ci:static-policy` (proves no new `NEXT_PUBLIC_*`), `pnpm ci:env-registry` (proves the
`docs/eservices-variables.md` row — it does NOT cover `.claude/reference/env-vars.md` for a
raw read, see D-17, so that row is verified by reading), `pnpm ci:directory-map` (proves the
new file's row), `pnpm ci:process-env` (proves the new `process.env` read is inside the
sanctioned prefix), and the three focused suites.

Staging smoke (step 8, against `https://staging.repworth.net` after the Vercel staging deploy):
`OPTIONS /api/admin/overview` from `https://admin.staging.repworth.net` → 204 + full header set ·
from `https://evil.example` → 403 `{"error":"origin"}` + `Vary: Origin`, no ACAO ·
`GET` with the refused origin → 403 before auth · `GET` with no `Origin` → the pre-existing 401 ·
same-origin `POST` shape with `Origin: https://staging.repworth.net` → not a CORS 403
(branch 4's 401 is the expected next refusal) · loopback origin → allowed on staging ·
`GET /admin/login` → 200 (Legacy admin portal still loads).

**Browser verification (AGENTS.md § "browser-observable behavior").** CORS is a browser
control, so status probes alone do not prove it. The **Admin app** does not exist at
`https://admin.staging.repworth.net` yet (that is Gate A, #1196), so the allowlisted origin
available for a real browser test is the **loopback rule**, which is live on staging. Serve a
one-page harness on `http://localhost:<port>` and run:

```js
fetch('https://staging.repworth.net/api/admin/overview', {
  credentials: 'omit',
  headers: { Authorization: 'Bearer cors-probe' },   // forces a real preflight
})
```

A plain `GET` would be a *simple* request and would never preflight, so the
`Authorization` header is load-bearing — it is also the exact header the **Admin app** will
send, and the one `Access-Control-Allow-Headers` exists to permit. Observe in the network
panel: an `OPTIONS` answered `204` with the full header set, then the real `GET` whose
pre-existing `401` body is READABLE to script rather than an opaque CORS failure. Then repeat
the same fetch from a page origin that is not allowlisted and observe it blocked with no
ACAO. Finally load `/admin/login` and confirm the **Legacy admin portal** renders.

**A same-origin legacy admin MUTATION is the one check this run cannot complete**, and it is
the ticket's named trap. It needs a staging admin session at `aal2`, and this session holds
no admin credentials (the staging admin accounts are re-minted under #1178/#1182, owner-held).
Per AGENTS.md the blocker is STATED, not substituted: the run records instead (a) the
curl-level proof that a same-origin `POST` shape carrying
`Origin: https://staging.repworth.net` is NOT refused by CORS — its next refusal is branch
4's `401`, which is the pre-existing behaviour — and (b) test #7 and #20, which pin the
self-origin allowance and every branch-4 exit. The owner (or #1197's Gate B) closes the
authenticated half.

## 7. Rollback

Revert the merge commit; `/api/admin/**` returns to writing no `Access-Control-*` header.
Narrower rollback that does not revert code: clear `ADMIN_APP_ORIGINS` in the Vercel
environment **and redeploy that environment** — a running deployment keeps the value it was
built with, so clearing the variable alone changes nothing — then verify the former origin is
refused `403`. The allowlist then admits nothing but loopback and this app's own origin, so
the Admin app is cut off while the Legacy admin portal keeps working.

## 8. Review appendix

### Plan round 1 — Codex plan-skeptic (thread `01a0802c-d198-7513-89b8-0e680c8b0368`)

`VERDICT: REVISE`. Prevalidate `PASS` (3 citations, 4 fixtures, 0 stale). 22 findings;
**21 accepted, 1 rejected in part.**

- **Failability (18 findings)** — all accepted. `tests_to_add` grew 19 → 40; the additions
  are D-11 … D-16 plus negative/parameterized coverage (lookalike hosts, opaque `Origin:
  null`, attacker-chosen preflight method and headers, every branch-4 exit, path
  inclusion/exclusion, no-memoization). Estimates raised 160→210 prod, 430→820 test.
- **Partially rejected — "echo the exact received Origin".** ACCEPTED that canonical
  fixtures cannot distinguish raw from normalized; REJECTED the direction. Echoing the raw
  header is a header-injection channel (WHATWG URL parsing strips tab/newline, so a raw value
  can normalize onto an allowlisted origin while still carrying control characters). The plan
  echoes the NORMALIZED origin, which is byte-identical to what a browser sends. Retitled
  #23 accordingly.
- **Cited artifacts** — 0 unresolved. One unsupported *claim* accepted and removed: §1 no
  longer says #1185/#1192 will import `isAllowedAdminOrigin` (ADR 0026 D7 rejects the former,
  ADR 0029 D1 gives the latter its own accessor).
- **Invariants** — accepted: the invariant-#1 import-boundary test (D-16), the one-owner
  structural test (D-16), the `ci:env-registry` overstatement (D-17), the "all 19 red" eval
  fallacy (§4), the missing browser verification (§6), and the rollback that silently
  requires a redeploy (§7). The ADR 0026 cookie-premise finding is recorded in §5 and raised
  to the owner rather than actioned, because the ADR is locked and no code on this branch
  changes.

### Plan round 2 — verification (resumed round 1, same thread)

`VERDICT: REVISE`. 22 of 24 prior findings confirmed ADDRESSED. Six corrections, **all six
accepted and applied**; every one is a consistency defect a FIX introduced, not a new front:

1. **Baseline classification still asserted a fixed count.** #14 and #38 are also
   characterization (nothing reads `ADMIN_APP_ORIGINS` today; `csrf.ts:35` already refuses an
   external origin). §4 no longer asserts a count — T1 records each title's observed baseline.
2. **The browser probe could not preflight.** A plain `GET` is a *simple* request. §6 now
   sends `Authorization: Bearer cors-probe` with `credentials: 'omit'`, which is both what
   forces the preflight and the exact header `Access-Control-Allow-Headers` exists to permit.
   The authenticated legacy-mutation half is recorded as a STATED BLOCKER (no staging admin
   credentials in this session) rather than substituted.
3. **D-8 and an intake edge case still said a path is "normalized away".** D-13 rejects it.
   Both corrected: a bare trailing slash is the only non-origin component accepted.
4. **`normalizeOrigin` was called by the proxy but absent from the declared exports.** Now
   an explicit third export, and `test_seams` was resynchronized with the two-argument
   predicate and the reader.
5. **Wrong ADR number**: `ADMIN_APP_URL` is ADR 0029 **D1**, not D3 (verified at
   `docs/adr/0029-admin-link-ownership-and-legacy-shell.md:54`). Both references corrected.
6. **The CR/LF-injection rationale for the normalized echo is unsupported in this runtime.**
   Round 2 measured the installed `NextRequest`/`NextResponse`: both throw `TypeError` on a
   CR or LF in a header value. The DECISION stands (echo the canonical origin) but is now
   argued as canonical output, and test #23 uses mixed-case and tab-bearing fixtures rather
   than an unconstructible CR/LF request.

Round 2 also independently confirmed the DEV-4 cookie reasoning sound for this ticket's
scope: simple credentialed cross-origin requests were already possible before CORS, omitting
`Access-Control-Allow-Credentials` keeps credentialed responses unreadable and credentialed
preflights unauthorized, and `assertSameOrigin` still refuses external-origin mutations.

`contract-changed` reports **CHANGED** after these fixes. The only surface that actually
moved is the plan's heading structure — this section's own title — because `tests_to_add`
and `allowed_edit_surface` are byte-identical to the round-2 snapshot (the 40-title list was
already in place when that snapshot was taken). The detector does not distinguish a heading
rename from a contract move, and its documented failure direction is "review it", so round 3
is owed and is dispatched rather than argued away.

### Plan round 3 — verification (resumed, final round under the cap)

**`VERDICT: APPROVED`.** All six round-2 corrections confirmed ADDRESSED; no new functional
defect introduced by them; **no BLOCKING items**. Two things the approval records explicitly:

- **The stated credential blocker is accepted, and the approval does not certify that
  journey.** The authenticated **Legacy admin portal** mutation stays unverified until the
  owner or #1197's Gate B exercises it. Carried into the final report as an owner item.
- **One NIT, fixed before locking:** D-14 still called the raw echo a "header-injection
  channel". Replaced with the canonical-output rationale §2 already carries.

Plan LOCKED at 3 of 3 rounds. Codex thread `01a0802c-d198-7513-89b8-0e680c8b0368` (all three
rounds; rounds 2 and 3 resumed it, never cold — per `review-prompts.md` § Dispatching a
Codex round).
