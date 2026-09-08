# Red team — feat/1186-admin-api-cors

- **Mode** feature · **Round** 1 of 2 · **Risk** high · **Status** `OPEN_P0`
- **fork / merge-base** `c2de39d879c92cc657941b36d0be330cd0c20abf`
- **HEAD under review** `4f132aae5175329d272a41bd9a0f89b9dff6c2c7`
- **intake sha256** `0522267d5d33339d5bebb8c4e020bbb0d2a6184f6b0d5b082bcfb161b4fc8b9a`
- **Generated** 2026-09-08T10:13:11.057697Z
- **Mutations applied** 28 (23 main battery + 4 follow-up + 1 confirmation), across 23 distinct test titles · **29 of 30 round-1 runs consumed** (1 green-baseline run + 28 mutant runs) · every mutation journaled and restored

## Verdict

The production code is, as far as this pass can establish, correct. All thirteen of the
security properties the dispatcher named as "most damning if they survive" were mutated and
all thirteen were killed — the terminal loopback clause, every parser throw except one, the
self-origin predicate, the pre-shortcut allowlist read, the refusal status and body, the raw-vs-
normalized echo, `addVaryOrigin`, `Vary` on the refusal and on the pass-through,
`Allow-Credentials`, the `Access-Control-Request-Headers` echo, both `isAdminApiRoute`
boundaries, the CORS-before-`isProtectedRoute` ordering, and the `VERCEL_TARGET_ENV` lane
predicate. Twenty-one of twenty-three executed titles killed their mutant.

Two assertions do not do what their titles say, and both are provable rather than argued.
Neither is a live defect; both are guards that would not catch the edit they exist to catch.
That is the definition of a proven-fake test, so both are P0 by the skill's severity table.
Each is a one-line fix.

## Findings

| Severity | file:line | Finding | Survived mutation? |
|---|---|---|---|
| **P0** | `src/lib/config/__tests__/admin-origins.test.ts:75` | The `http:`/`https:` scheme guard in parseAllowlistEntry is asserted by no test — all four fixtures are caught by the PATH guard instead | yes (M3) |
| **P0** | `src/lib/config/__tests__/admin-origins.test.ts:212` | The Edge-safety guard's `node:` entry can never match, and side-effect imports are invisible — both node-builtin import shapes survive | yes (M27, M28) |
| **P1** | `src/lib/config/admin-origins.ts:144` | `ADR 0026 D14` is cited for the normalized-echo rule, but ADR 0026 contains only D1-D8 and no canonical-output decision at all | n/a |
| **P1** | `src/proxy.ts:125` | The terminal AdminOriginConfigError edge-throw (500 on every /api/admin/** request) has no rule row in the alerting runbook | n/a |
| **P1** | `.feature/logs/t1-baseline-record.md:33` | The T1 baseline record's promised 'Second record' was never written; five proxy titles that are green before AND after the implementation are left unclassified | n/a |
| **P2** | `src/__tests__/proxy.test.ts:582` | `expect(ALL_ACCESS_CONTROL_HEADERS).toHaveLength(6)` is tautological — it asserts the length of a literal declared 190 lines above in the same file | n/a |
| **P2** | `src/proxy.ts:268` | handleProxy branch 4 keeps the looser `startsWith('/api/admin')` while isAdminApiRoute uses the exact form the CORS comment claims | n/a |
| **P2** | `src/__tests__/proxy.test.ts:560` | Absence-of-substring proxies stand in for behavioural claims in three assertions | n/a |
| **P2** | `.claude/reference/arch-review-log.md:1` | prevalidate-plan reports 4 unresolved citations in .claude/reference/arch-review-log.md, all in entries this diff did not touch | n/a |

### RT-1 — P0 — The `http:`/`https:` scheme guard in parseAllowlistEntry is asserted by no test — all four fixtures are caught by the PATH guard instead

**At** `src/lib/config/__tests__/admin-origins.test.ts:75` · **Duty** 1 · **Disposition** `open`

Confirmed non-equivalent by inspection. All four fixtures have a non-empty, non-'/' pathname (file:///etc/passwd -> '/etc/passwd', data:text/html,<script> -> 'text/html,<script>', blob:https://admin.example/1234 -> 'https://admin.example/1234', javascript:alert(1) -> 'alert(1)'), so with the scheme throw deleted every one still throws AdminOriginConfigError from the path throw two guards later. The mutant is observably different: readAdminAppOrigins() returns ['ftp://admin.example'] / ['null'] instead of throwing for entries whose pathname is '/' (ftp://, ws://, wss://, file://host) — that is an exported-function behaviour change, so 'equivalent' cannot be claimed. Not an unexecuted branch: the test DOES run the scheme guard, its assertion simply cannot distinguish which guard fired. Security impact is nil today because normalizeOrigin independently enforces http(s) on the request side, so no extra origin becomes admissible; the defect is in the ORACLE. One-line fix: add an entry whose ONLY disqualifier is the scheme (e.g. 'ftp://admin.example' or 'ws://admin.example') to the fixture list.

### RT-2 — P0 — The Edge-safety guard's `node:` entry can never match, and side-effect imports are invisible — both node-builtin import shapes survive

**At** `src/lib/config/__tests__/admin-origins.test.ts:212` · **Duty** 1 · **Disposition** `open`

Confirmed non-equivalent and semantically meaningful. The membership test is `s === bad || s.startsWith(`${bad}/`)`; for bad='node:' that demands the specifier be exactly 'node:' or start with 'node:/', neither of which is a real specifier, so 'node:crypto' passes (M27 survived). Separately the extractor is /from\s+['"]([^'"]+)['"]/g, so a bare `import 'node:crypto';` yields no specifier at all (M28 survived). The 'node builtins' third of the test's stated property is enforced by nothing, which is the exact hole the cited precedent (src/lib/auth/__tests__/admin-transport.test.ts:114-119) documents a prior red-team pass walking through twice. The '@/lib/db', 'postgres', 'bullmq', 'openai', '@anthropic-ai/sdk', '@supabase/supabase-js' and 'ioredis' entries DO match and are unaffected. No live defect: the graph carries no node: import at HEAD. Fix: special-case the scheme (s.startsWith('node:')) and widen the extractor to /(?:from|import)\s+['"]([^'"]+)['"]/g.

### RT-3 — P1 — `ADR 0026 D14` is cited for the normalized-echo rule, but ADR 0026 contains only D1-D8 and no canonical-output decision at all

**At** `src/lib/config/admin-origins.ts:144` · **Duty** 3 · **Disposition** `open`

Re-resolved against 4f132aae: `rg -o '\bD[0-9]{1,2}\b' docs/adr/0026-admin-api-cors.md` yields D1 D2 D3 D4 D5 D6 D7 D8 only, and `rg -i 'canonical|normaliz'` over the same ADR returns zero hits. The other citations in the diff DO resolve: ADR 0026 D1/D2/D3/D4/D7 exist, and both verbatim quotes check out (D2 'Loopback is a separate code rule, not a list entry' at 0026:114; D4 'One predicate owns the origin comparison' at 0026:179). Rated P1 rather than P0 because the falsity is provenance-only: the behaviour the comment describes IS implemented and IS pinned by a killed mutation (M10), so no reader acting on it produces a defect — but a future engineer changing the echo would look for D14 and find nothing.

### RT-4 — P1 — The terminal AdminOriginConfigError edge-throw (500 on every /api/admin/** request) has no rule row in the alerting runbook

**At** `src/proxy.ts:125` · **Duty** 5 · **Disposition** `open`

The diff adds an operator-actionable TERMINAL path: a malformed ADMIN_APP_ORIGINS makes readAdminAppOrigins() throw inside the Edge proxy on every /api/admin/** request. The emitting half exists (src/instrumentation.ts:69-77 initialises Sentry for NEXT_RUNTIME==='edge', and onRequestError=Sentry.captureRequestError is exported), but docs/runbooks/beta-launch-alerting.md has no rule row for it: `rg -i 'proxy|middleware|CORS|origin|ADMIN_APP_ORIGINS'` over that runbook returns one unrelated hit (line 882). Duty 5 emits P1 when either half is missing; this is 'an emitted signal with no rule row'. Mitigants for the arbiter: (a) the path is unreachable in every environment today because ADMIN_APP_ORIGINS is unset everywhere and unset parses to [] without throwing; (b) .claude/reference/env-vars.md documents the failure and the redeploy remedy, so the destination-action half is written down, just not as a Sentry rule.

### RT-5 — P1 — The T1 baseline record's promised 'Second record' was never written; five proxy titles that are green before AND after the implementation are left unclassified

**At** `.feature/logs/t1-baseline-record.md:33` · **Duty** 3 · **Disposition** `open`

The record states the 23 proxy and 11 allowlist titles were a COLLECTION ERROR at c2de39d8 and 'Re-derived after T2/T3 land and before T4 (see the second record below)', then ends with an empty '## Second record' heading. The raw log .feature/logs/t1-baseline-proxy.txt does exist and shows 18 failed / 22 passed of 40, i.e. 18 of the 23 new titles red — but the five that were GREEN before the code (#2 'sends no Access-Control-Allow-Origin for a disallowed origin', #7 'lets a same-origin POST...', #8 'leaves an admin API request with no Origin header...', #12 'writes no Access-Control header on a non-admin route', #14 'does not read ADMIN_APP_ORIGINS on a non-admin request') carry no CHARACTERIZATION marker in the test source, unlike the two csrf titles that do. Partially discharged by this pass: I proved four of the five non-vacuous by mutation (M22 kills #2, M19 kills #7, M20 kills #8, M21 kills #14). #12 is still unprobed. The finding is the missing record, not a fake test.

### RT-6 — P2 — `expect(ALL_ACCESS_CONTROL_HEADERS).toHaveLength(6)` is tautological — it asserts the length of a literal declared 190 lines above in the same file

**At** `src/__tests__/proxy.test.ts:582` · **Duty** 2 · **Disposition** `open`

An exact-count assertion on test-local data. It can only fail when someone edits the literal, and it never fails when production stops emitting or starts emitting a header. Behavioural replacement: assert the SET of Access-Control-* header names on each response (accessControlHeaderNames already does this two lines above), and delete the length check.

### RT-7 — P2 — handleProxy branch 4 keeps the looser `startsWith('/api/admin')` while isAdminApiRoute uses the exact form the CORS comment claims

**At** `src/proxy.ts:268` · **Duty** 4 · **Disposition** `open`

Recorded sibling search, not a live defect. src/proxy.ts:50 matches '/api/admin' exactly as isProtectedRoute does (src/lib/shared/protected-routes.ts:85), which is what the doc comment claims and is true. But src/proxy.ts:268 still uses the prefix form, so '/api/adminfoo' would be admin-gated there without ever passing the CORS block. Unreachable today: handleProxy returns NextResponse.next() for any path isProtectedRoute rejects, and '/api/adminfoo' is such a path. Killed mutations M16/M17 pin line 50; nothing pins line 268.

### RT-8 — P2 — Absence-of-substring proxies stand in for behavioural claims in three assertions

**At** `src/__tests__/proxy.test.ts:560` · **Duty** 2 · **Disposition** `open`

proxy.test.ts:560 `.not.toContain('DELETE')` and :564 `.not.toContain('x-admin-override')` are each preceded by an exact-equality assertion on the same header, so they add nothing and would survive a rewrite that changed the constant. proxy.test.ts:423 `expect(response.status).not.toBe(403)` is subsumed by the `.toBe(401)` on the next line. csrf.test.ts:202-203 `expect(source).not.toContain('NEXT_PUBLIC_APP_URL')` is a source-substring proxy for 'this module does not read the variable' — the same class of guard RT-2 shows can be walked around. None is load-bearing; all three are redundancy, not coverage.

### RT-9 — P2 — prevalidate-plan reports 4 unresolved citations in .claude/reference/arch-review-log.md, all in entries this diff did not touch

**At** `.claude/reference/arch-review-log.md:1` · **Duty** 3 · **Disposition** `open`

Recorded for completeness, explicitly out of scope. `python3 ~/.claude/skills/grill-me-codex/scripts/prevalidate-plan.py .claude/reference/arch-review-log.md --repo .` reports CONTEXT.md:75 (file has 7 lines), pricing/page.tsx:17 (does not exist at HEAD), and two commit hashes that do not resolve. The #1186 entry added by this diff contains no path:line citation and no commit hash, so none of the four is introduced here. The plan, deviations and handoff docs all PREVALIDATE: PASS (7/3/0 citations checked, 0 unresolved).

## Duty 1 — hand-mutation

Environment: allowlist-only (`PATH`, temporary `HOME`, `TMPDIR`, `NODE_ENV=test`, `CI=true`,
`MOCK_EXTERNAL_APIS=true`, `REPWORTH_DISABLE_LIVE_DB_SUITES=1`), with `.env.local` swapped for
a scrubbed copy under the journaled rename-to-backup protocol. Green baseline established by
one run of all four files at HEAD: 77 passed / 77.

Every mutant run went through the paused supervisor with `assert-one-test`, so each verdict is
one executed test. After every mutation the file was restored and `git status --porcelain`
re-checked clean for that path before the next mutation was applied.

Mutations applied, by target:

| # | Target | Mutation | Test | Result |
|---|---|---|---|---|
| M1 | admin-origins.ts | loopback clause made non-terminal (falls through to the allowlist) | treats a loopback origin as the code rule's alone… | killed |
| M2 | admin-origins.ts | the `*` throw deleted | throws … contains a wildcard | killed |
| M3 | admin-origins.ts | the `http:`/`https:` scheme throw deleted | throws … is not an http or https origin | **SURVIVED → RT-1** |
| M4 | admin-origins.ts | the path throw deleted | throws … userinfo, a path, a query or a fragment | killed |
| M5 | admin-origins.ts | the userinfo/query/fragment throw deleted | throws … userinfo, a path, a query or a fragment | killed |
| M23 | admin-origins.ts | `ALLOWED_SCHEMES` guard deleted from `normalizeOrigin` | returns the canonical http(s) origin… | killed |
| M24 | admin-origins.ts | `127.0.0.1` removed from `LOOPBACK_HOSTNAMES` | applies the loopback rule across both hosts… | killed |
| M19 | admin-origins.ts | the `isSelfOrigin` allowance deleted | lets a same-origin POST … past the CORS block | killed |
| M22 | admin-origins.ts | allowlist membership check replaced by always-true | sends no Access-Control-Allow-Origin for a disallowed origin | killed |
| M27 | admin-origins.ts | `import { createHash } from 'node:crypto'` added | keeps the CORS import graph free of node builtins… | **SURVIVED → RT-2** |
| M28 | admin-origins.ts | bare `import 'node:crypto';` added | keeps the CORS import graph free of node builtins… | **SURVIVED → RT-2** |
| M6 | csrf.ts | `isSelfOrigin` returns true on an unset `NEXT_PUBLIC_APP_URL` | isSelfOrigin compares NEXT_PUBLIC_APP_URL… | killed |
| M7 | csrf.ts | `isSelfOrigin` returns true on a parse failure | isSelfOrigin is false for absent, malformed… | killed |
| M18 | flags.ts | `isProductionEnvironment` reads `VERCEL_ENV` | isProductionEnvironment is true only for VERCEL_TARGET_ENV=production | killed |
| M8 | proxy.ts | allowlist read moved inside the `rawOrigin !== null` branch | validates the entire allowlist before the … shortcuts | killed |
| M9a | proxy.ts | refusal status 403 → 401 | refuses an OPTIONS preflight … with 403 origin | killed |
| M9b | proxy.ts | refusal body `{error:'origin'}` → `{error:'forbidden'}` | refuses an OPTIONS preflight … with 403 origin | killed |
| M10 | proxy.ts | preflight echoes the RAW `Origin` header | echoes the normalized allowed origin, never the raw Origin header | killed |
| M11 | proxy.ts | `addVaryOrigin` degraded to `headers.set('Vary','Origin')` | adds Origin to an existing Vary header… | killed |
| M25 | proxy.ts | the `existing === '*'` short-circuit deleted | adds Origin to an existing Vary header… | killed |
| M12 | proxy.ts | `addVaryOrigin` dropped from the refusal | sets Vary: Origin on both the allowed and the refused preflight | killed |
| M13 | proxy.ts | `addVaryOrigin` dropped from the pass-through | sets Vary: Origin on every admin API response… | killed |
| M14 | proxy.ts | `Access-Control-Allow-Credentials: true` added | never sends Allow-Credentials or Expose-Headers… | killed |
| M15 | proxy.ts | `Access-Control-Request-Headers` echoed into `Allow-Headers` | returns the fixed preflight contract regardless… | killed |
| M16 | proxy.ts | `isAdminApiRoute` widened to `startsWith('/api/admin')` | matches bare and normalized admin API paths… | killed |
| M17 | proxy.ts | `isAdminApiRoute` narrowed to exclude the bare `/api/admin` | matches bare and normalized admin API paths… | killed |
| M20 | proxy.ts | the `rawOrigin !== null` guard dropped (no-Origin now refused) | leaves an admin API request with no Origin header… | killed |
| M21 | proxy.ts | `readAdminAppOrigins()` hoisted above the non-admin early return | does not read ADMIN_APP_ORIGINS on a non-admin request | killed |

Two of the dispatcher's thirteen were folded into equivalent forms rather than run as separate
mutants: "move the CORS block AFTER `isProtectedRoute`" is what M8/M20/M21 measure piecewise
(and is independently pinned by the four `expect(createServerClient).not.toHaveBeenCalled()`
assertions), and "drop `Vary` from the no-`Origin` response" is M13, since the no-`Origin` path
and the allowed path share the same `addVaryOrigin` call site.

Forty-four in-scope candidates were not executed and are recorded `skipped-budget`. Twenty-nine
of those are pre-existing `proxy.test.ts` / `csrf.test.ts` cases that enter the inventory only
through Direction B (they cover the verbatim `handleProxy` extraction and the `assertSameOrigin`
refactor); eighteen are new titles the 30-run round budget did not reach after the twenty-three
highest-value security properties were spent. Three `flags.test.ts` cases are `excluded` — they
cover `readFlag` / `isPreviewEnvironment`, untouched by this diff.

## Duty 2 — fragile assertions

Three, all P2 (RT-6, RT-8) — see above. No absence-of-tag proxy of the incident class was found
in the changed tests. The two source-scanning tests (`admin-origins.test.ts` § Edge safety and
`csrf.test.ts` § one predicate) are the fragile shape, and RT-2 is the proof that the shape
failed in practice here.

## Duty 3 — docs vs reality

`prevalidate-plan.py` was available and was run against all four changed docs:

| Doc | Result |
|---|---|
| `docs/superpowers/plans/feat-1186-admin-api-cors-plan.md` | PASS — 7 citations, 0 unresolved |
| `docs/superpowers/plans/feat-1186-admin-api-cors-deviations.md` | PASS — 3 citations, 0 unresolved |
| `docs/superpowers/plans/feat-1186-admin-api-cors-handoff.md` | PASS — 1 commit, 0 stale |
| `.claude/reference/arch-review-log.md` | 4 issues, all in untouched entries → RT-9 |

Hand-checked in addition, because the script does not resolve ADR decision ids:

- `ADR 0026 D14` → **does not exist** (RT-3).
- `ADR 0026 D1/D2/D3/D4/D7` → all resolve.
- Verbatim quote "Loopback is a separate code rule, not a list entry" → `docs/adr/0026-admin-api-cors.md:114`. ✅
- Verbatim quote "One predicate owns the origin comparison" → `docs/adr/0026-admin-api-cors.md:179`. ✅
- `src/proxy.ts:36` "`DELETE` is absent because no admin route exports one" → **true**: a method census over `src/app/api/admin/**` returns 39 handlers, GET/POST/PUT/PATCH only, zero DELETE.
- `src/proxy.ts:49` "matched exactly as `isProtectedRoute` matches it" → **true** of `src/proxy.ts:50` against `src/lib/shared/protected-routes.ts:85`; see RT-7 for the looser sibling at `src/proxy.ts:268`.
- `src/lib/config/admin-origins.ts:11` "`scripts/ci/process-env-baseline.ts` allowlists this prefix" → **true**: `ALLOWLIST_PREFIXES = ['src/lib/config/']` at `scripts/ci/process-env-baseline.ts:28`.
- arch-review-log "40 proxy tests + 37 config/CSRF tests" → **true** (proxy 40; admin-origins 12 + flags 11 + csrf 14 = 37).
- Intake `tests_to_add` = 40, and all 40 titles exist verbatim across the four files. The suites
  actually contain **41** new cases, i.e. one more than promised — no gate cares, recorded only.

## Duty 4 — missed sibling cases

Patterns searched, scope `src/` + `worker/` + `scripts/` at `4f132aae`, excluding `node_modules/`,
`.feature/` and (for the header search) `*.md`:

| Pattern | Scope | Result |
|---|---|---|
| `Access-Control` | whole repo, non-`.md` | `src/proxy.ts` only (+ its tests, + one prose mention in `admin-origins.ts`). **Zero siblings** — ADR 0026 D1's single-owner claim holds. `next.config.mjs` `headers()` writes seven security headers, none of them `Access-Control-*`. |
| `'Vary'` / `set('vary'` | `src/`, `worker/`, non-test | `src/proxy.ts` only. **Zero siblings** — nothing else can clobber the header. |
| `'/api/admin'` matchers | `src/`, `worker/`, non-test | three sites: `proxy.ts:50` (new, exact), `proxy.ts:268` (prefix — RT-7), `protected-routes.ts:85` (exact). |
| `NEXT_PUBLIC_APP_URL` used for an **origin comparison** | `src/`, `worker/`, non-test | `src/lib/shared/csrf.ts` only. The other 18 sites build URLs or validate a scheme; none compares an incoming `Origin`. ADR 0026 D4's one-predicate claim holds. |
| `VERCEL_TARGET_ENV` | `src/`, `worker/`, `scripts/`, non-test | `src/lib/config/flags.ts` only (plus CI-audit allowlists). **Zero siblings.** |
| Same `node:`-prefix guard bug as RT-2 | every Edge-safety test in the repo | the cited precedent `src/lib/auth/__tests__/admin-transport.test.ts:97-120` asserts **zero imports**, not "no bad imports", so it does not share the bug. **Zero siblings** — RT-2 is unique to the new test. |

## Duty 5 — operational completeness

One terminal path added: RT-4. Beyond it —

- **Rollback.** `ADMIN_APP_ORIGINS` is unset in every environment today and unset parses to `[]`,
  so the feature ships inert: only self-origin and (outside production) loopback are admitted,
  which is exactly the pre-change behaviour for a browser. `.claude/reference/env-vars.md` states
  the redeploy requirement — clearing the variable alone revokes nothing, because a running Vercel
  deployment keeps the value it was built with. DEV-3 in the deviations already records that
  `vercel env add` cannot set it on staging.
- **Misconfiguration in production.** Fails in the safe direction and the blast radius is bounded
  to `/api/admin/**`: `src/proxy.ts:118` returns before `readAdminAppOrigins()` for every other
  path, and mutation M21 proves that ordering is pinned. `/admin/login` and public pages cannot
  be taken down by a bad value.
- **Observability.** Edge Sentry is initialised (`src/instrumentation.ts:69`), so the throw is
  captured; what is missing is the rule row, which is RT-4.
- **Not a gap, worth stating.** Every `/api/admin/**` **mutation** route wrapped in
  `withSameOrigin()` (`src/lib/auth/route-helpers.ts:30`) will still refuse a cross-origin Admin
  app with 403 `{error:'forbidden'}` even after CORS admits it, because `assertSameOrigin` uses
  `isSelfOrigin` and deliberately not `isAllowedAdminOrigin`. That is ADR 0026 D4's stated
  decision, is pinned by a test, and is #1185's problem, not this one's — but it means the
  advertised `POST, PUT, PATCH` in `ADMIN_CORS_ALLOW_METHODS` are not yet usable end-to-end by a
  cross-origin caller. Recorded, not filed.

## Authorizations

None. No finding on this run is `accepted-risk`.

## Restoration

All 28 mutations were applied through the journaled runner and restored; `git status --porcelain`
is clean on every mutated path. The dotenv swap is left OPEN by design — the orchestrator's
`finalize` owns the restore, and the journal records the paths, the open flag and the hash of the
scrubbed replacement. Nothing outside this directory was created.
