# Spec & correctness review — `feat/1186-admin-api-cors`

Axis: spec conformance + correctness. READ-ONLY. Reviewed the COMMITTED tree only
(`git show 4f132aae:<path>`), diffed against merge-base `c2de39d8`.

Sources checked: intake JSON (every field), plan §2/§3/§5/§8, ADR 0026 D1–D8,
deviations DEV-1…DEV-7, blast-radius, `docs/reviews/finding-checklists/spec-correctness.md`.

## Findings

| severity | file:line | finding |
|---|---|---|
| low | `src/__tests__/proxy.test.ts:685` | Test #23 (`echoes the normalized allowed origin, never the raw Origin header`) ships only a mixed-case fixture; plan §2:164 and §8 round-2 correction #6 (`plan.md:410`) both promise "mixed-case **and tab-bearing** fixtures". The tab case is the one that actually distinguishes canonical output from raw bytes (WHATWG parsing strips HTAB, which is a legal header-value byte), and it is unasserted. |
| low | `src/lib/config/admin-origins.ts:144` | Citation `ADR 0026 D14` does not resolve — ADR 0026 has D1–D8 only. The intended referent is plan §5 delta **D-14**. A permanent code comment pointing at a non-existent ADR decision. |
| low | `.claude/reference/arch-review-log.md:36` | "40 proxy tests + **37** config/CSRF tests" — actual counts at `4f132aae` are 40 in `src/__tests__/proxy.test.ts` and **30** across `admin-origins.test.ts` (12) + `flags.test.ts` (4) + `csrf.test.ts` (14). The arch log is a durable reference; the number is wrong by 7. |
| low | `docs/superpowers/plans/feat-1186-admin-api-cors-handoff.md:18` | Handoff's read-order table says the deviations file holds "DEV-1 … DEV-4"; it holds **DEV-1 … DEV-7** (DEV-5/6/7 were added during execution). The handoff's stated job is "everything below is a POINTER" — this pointer under-counts the deviations a resuming session must read. |

No medium or high finding. The functional contract is delivered as specified; see below.

## Verified — field by field

### `goal`
Delivered. `proxy()` (`src/proxy.ts:120-152`) runs the CORS block before `handleProxy`,
which is where `isProtectedRoute` lives. Preflight 204 with the fixed set; refusal
403 `{"error":"origin"}`; ACAO on the real response; `Vary: Origin` on every
`/api/admin/**` exit.

### `non_goals` — all 10 hold
1. **Branch 4 untouched.** Verified mechanically, not by reading:
   `git show c2de39d8:src/proxy.ts | sed -n '/^export async function proxy/,$p' | tail -n +2`
   vs the same slice from `/^async function handleProxy/` at `4f132aae` → **byte-identical**.
   The only change is the signature line (`proxy` → `handleProxy`, explicit
   `Promise<NextResponse>` return type, which the body already satisfied).
2. `next.config.mjs` not in the diff; `Cross-Origin-Resource-Policy: same-origin` intact.
3. No `withAdminCors()`; no `OPTIONS` handler under `src/app/api/admin/**`.
4. No pattern entry — `parseAllowlistEntry` throws on `*` (`admin-origins.ts:78-83`).
5. No WAF/runbook change in the diff.
6. `git grep 'Access-Control' 4f132aae -- src worker next.config.mjs scripts` returns
   `src/proxy.ts` + one comment in `admin-origins.ts` only. No `Allow-Credentials`,
   no `Expose-Headers` written anywhere.
7. `ADMIN_CORS_ALLOW_METHODS` omits DELETE.
8. `assertSameOrigin` keeps all five throw sites and all four message shapes; only the
   final comparison delegates to `isSelfOrigin`. Env read, Sec-Fetch-Site check and
   missing-Origin check are unchanged and still precede the verdict.
9. No impersonation/migration/flag/dependency/prod-env change.
10. `isAdminApiRoute` gates everything; a non-admin route takes the untouched path.

### `user_visible_behavior` — all 9 hold
Each is covered by a test that asserts the claim (not a weaker one). Notably:
`createServerClient` non-construction is asserted on the preflight and every refusal
path; the self-origin POST is asserted to reach branch 4's pre-existing 401 rather than
403; the no-Origin request is asserted to reach branch 4 and to carry `Vary` but no ACAO.

### `invariants` — all 10 hold
- **#1 Edge safety.** `admin-origins.test.ts` § "Edge safety" scans the four-file CORS
  graph for `node:`, `@/lib/db`, `postgres`, `bullmq`, `openai`, `@anthropic-ai/sdk`,
  `@supabase/supabase-js`, `ioredis`. The scan is one level, but the graph genuinely
  closes at four files: `csrf.ts` and `flags.ts` have zero imports, `admin-origins.ts`
  imports only those two.
- **#13.** No `NEXT_PUBLIC_ADMIN_*` anywhere; `ci:static-policy`'s allowlist untouched.
- **ADR D1/D2/D3/D4/D5.** Constants compared character by character against the ADR D3
  table: `GET, POST, PUT, PATCH, OPTIONS` / `Authorization, Content-Type` / `600` /
  `NextResponse.json({ error: 'origin' }, { status: 403 })` → `{"error":"origin"}`. Match.
- **One predicate owns "is this our own origin".** `isSelfOrigin` is the sole
  `NEXT_PUBLIC_APP_URL` comparison; pinned structurally in `csrf.test.ts` (csrf.ts is
  the only one of the three files that even mentions the var).
- **`src/lib/config/` process.env home.** `ADMIN_APP_ORIGINS` is read only in
  `admin-origins.ts` (allowlisted prefix). The new `NEXT_PUBLIC_APP_URL` read in
  `csrf.ts` is uncounted by `ci:process-env` — `isExemptIndicatorName` exempts the whole
  `NEXT_PUBLIC_` prefix (`scripts/ci/process-env-audit.ts:70`), and
  `process-env-baseline.ts:169` records csrf.ts as already removed for exactly that reason.
  `VERCEL_TARGET_ENV` in `flags.ts` is both prefix-allowlisted and indicator-exempt.
- **#12.** Parse + predicates are in the named module with focused tests; only
  header writing (`adminCorsPreflight`, `adminOriginRefusal`, `addVaryOrigin`) is inline.

### `edge_cases` — all 21 hold
Spot-verified the ones where the code could plausibly have diverged:
- Loopback is **terminal** (`admin-origins.ts:186`: `return !isProductionEnvironment()`),
  so a listed `http://localhost:3000` cannot re-admit loopback in production.
- Allowlist validation is unconditional and precedes every shortcut
  (`proxy.ts:126` before the origin branches), and is not reached on a non-admin route
  (`proxy.ts:121-123`).
- `''` vs absent: `rawOrigin === null` is the only "absent" test; `''`, `'null'`,
  `'not a url'`, multi-valued and `file://` all normalize to `null` and refuse.
  Confirmed `new URL('https://a https://b')` fails (space is a forbidden host code point).
- Path match uses the `isProtectedRoute` set exactly — confirmed against
  `protected-routes.ts` (`=== '/api/admin' || startsWith('/api/admin/')`);
  `/api/adminfoo` gets no header and no `Vary`.
- `assertSameOrigin` does not inherit the allowlist, pinned by a test.
- `isSelfOrigin` and `isAllowedAdminOrigin` are total; only the config parse throws.

### `test_seams`
All six exist with the declared signatures. `normalizeOrigin` is exported (round-2
correction #4 delivered). `isLoopbackOrigin` correctly stays internal.

### `tests_to_add` — 40 / 40 present verbatim
Machine-checked: every one of the 40 intake strings appears as an exact substring of the
four test files. Bodies read individually; the only title/body gap worth reporting is
#23 above. Weaker-than-title cases that are nonetheless covered elsewhere in the same
suite (recorded, not filed): #2 asserts only ACAO-null (the full sweep is #18); #17
asserts the two constants but not 204/max-age (#3 covers those); #16 asserts status +
no-Supabase but not header absence (#18 covers it); #20's first sub-case asserts status
and body but not the CORS stamp (#1 covers it). None of these lets a plausible mutant
through the *suite*.

### `allowed_edit_surface`
18 files changed; every one is on the 24-entry surface. Nothing outside it.
`scripts/ci/tenant-scope-allowlist.ts` was allowed but not needed — correct, no
cross-account query was added.

### Registries and code map
- `docs/eservices-variables.md:177` row present (machine-enforced lane).
- `.claude/reference/env-vars.md:48` behaviour row present and accurate — re-read every
  claim against the code: sole reader, not memoized, throws on `*`/unparseable/non-http(s)/
  userinfo-path-query-fragment, trailing slash normalized, loopback terminal + production-
  inert, implicit self, redeploy requirement. All true.
- `.env.example:131-140` present, server-only, no `NEXT_PUBLIC_`.
- `docs/directory/lib-dashboard-locations-accounts.md` — new row for `admin-origins.ts`
  and an amended `flags.ts` row. `docs/directory.md:45` maps `src/lib/config/` to this
  page, so `ci:directory-map` will find it. Page is 2,649 words, under the 3,000 cap
  (`docs/agents/context-layout.md:31`); the fork point was 2,538.
- `ci:config-coverage` is not owed: it audits only *unconditionally boot-required* vars,
  and `ADMIN_APP_ORIGINS` is optional by design.

### Blast radius (caller-side semantics, which typecheck cannot catch)
- `src/lib/shared/csrf.ts` — 21 importers, all via `assertSameOrigin`/`SameOriginError`
  (plus the new `admin-origins.ts`). `assertSameOrigin`'s observable behaviour is
  unchanged for every one of them: same preconditions in the same order, same five throws,
  same messages, same `URL.origin` comparison. `isSelfOrigin` re-reads
  `process.env.NEXT_PUBLIC_APP_URL` instead of reusing the local `appUrl`, which is
  indistinguishable within a single synchronous call.
- `src/lib/config/flags.ts` — 26 importers; the change is purely additive
  (`isProductionEnvironment`), no existing export touched.
- `src/proxy.ts` — no production importer (Next 16 loads it by convention).
- `src/lib/config/admin-origins.ts` — new, 3 importers.

## Low-confidence appendix (NOT findings)

- `docs/eservices-variables.md:177` places `ADMIN_APP_ORIGINS` under **Security / secrets**.
  It is an allowlist, not a secret; the **App / worker URLs & lifecycle** table below it
  is arguably the better home. Cosmetic, and the audit does not care which table.
- The Edge-safety scan enumerates its four files by hand rather than walking imports.
  Correct today (the graph closes at those four), but if `admin-origins.ts` later gains
  an import the guard silently stops covering the graph its title names.
- `assertSameOrigin keeps its four refusals…` actually exercises five throws (unset
  APP_URL, cross-site, missing Origin, malformed, mismatch). The title under-counts; the
  body is stronger than the promise, which is the harmless direction.
- The refusal and preflight responses carry no `Cache-Control`. `Vary: Origin` is the
  control the ADR specifies and Vercel does not cache un-hinted API responses, so this is
  a hardening note rather than a gap.
- If `readAdminAppOrigins()` throws, the resulting 500 carries no `Vary: Origin`, so
  "every `/api/admin/**` response" is literally untrue in the misconfigured state. The
  intake accepts loud failure there, so this is pedantry, not a defect.
