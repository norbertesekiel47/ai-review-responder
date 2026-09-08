# feat/1186 — review wave triage

Round 1, four axes, dispatched in one message against committed `4f132aae`
(merge-base `c2de39d8`). Production diff measured at **398** lines, which is above
`execution-lanes.md` § The review wave's 300-line threshold — so the standards axis was
owed independently of RISK = high. Red-team finalizer: 0 mutations left, tree
byte-identical to `4f132aae`.

**23 findings: 19 ACCEPTED and fixed, 4 REJECTED with reasons.**

---

## Red team — 2 P0, 3 P1, 4 P2

The core came through clean: **all 13 dispatcher-named security properties were mutated
and all 13 killed**, including the terminal loopback clause, every parser throw,
`isSelfOrigin`'s two fail-open shapes, the allowlist read position, the refusal status and
body, the raw-vs-normalized echo, the `Vary` merge, `Allow-Credentials`, the echoed request
headers, and the path match. Both P0s are in the TEST surface — guards that did not guard.

| ID | Verdict | Disposition |
|---|---|---|
| RT-1 P0 — the `http:`/`https:` scheme guard is asserted by no test; all four fixtures trip the PATH guard two clauses later (M3 survived) | **ACCEPT** | Added `ftp://admin.example` and `ws://admin.example/` — a root path, no userinfo, no query, no fragment, so the scheme check is the only rule they break. Deleting the scheme throw now fails the test. |
| RT-2 P0 — the Edge-safety scan's `node:` entry can never match (`s === 'node:' \|\| s.startsWith('node:/')`), and a bare `import 'x';` yields no specifier (M27, M28 survived) | **ACCEPT** | The matcher now treats a scheme prefix (`node:`) as a prefix match and a package name as exact-or-subpath, and the extractor collects four import shapes: `from '…'`, bare `import '…'`, dynamic `import('…')` and `require('…')`. |
| RT-3 P1 — `ADR 0026 D14` cited; ADR 0026 has only D1–D8 | **ACCEPT** | Now cites plan §2 and §5 delta D-14 and says explicitly that ADR 0026 states no canonical-output decision. Also found by the spec and standards axes. |
| RT-4 P1 — the terminal edge throw (500 on every admin request) has no alerting rule row | **ACCEPT, differently** | Fixed at the source rather than the alarm: adversarial A2's mapping means the throw no longer escapes, so there is no 500 to alert on. What remains is a `console.error` with no sink — the same gap #1183 recorded and deferred to **#1212**; not re-opened here, and `docs/runbooks/beta-launch-alerting.md` is out of surface. |
| RT-5 P1 — the T1 baseline record's promised "Second record" was never written; 5 proxy titles green before AND after are unclassified | **ACCEPT** | Written. `.feature/logs/t1-baseline-record.md` now names all five, says why each is green at baseline and what each is FOR, and states plainly that none is evidence the code works. Each is cross-referenced to the mutation that proves its value (M19/M22/M8). |
| RT-6 P2 — `expect(ALL_ACCESS_CONTROL_HEADERS).toHaveLength(6)` is tautological | **ACCEPT** | The constant is now actually swept: every one of the six must be absent on a refusal. |
| RT-7 P2 — `handleProxy` branch 4 keeps the looser `startsWith('/api/admin')` | **REJECT** | Correct observation, but branch 4 is ticket **#1185**'s file and this branch's non-goals forbid touching it. Red team itself marks it currently unreachable: `isProtectedRoute` never admits `/api/adminfoo`, so branch 4 cannot see it. Now that `isAdminApiRoute` is exported from `protected-routes.ts`, #1185 has a one-line cleanup available. Recorded, not taken. |
| RT-8 P2 — three absence-of-substring proxies stand in for behavioural claims | **ACCEPT** | Removed. `not.toContain('DELETE')` beside an exact `toBe('GET, POST, PUT, PATCH, OPTIONS')` proves nothing the equality does not, and reads as if it did. |
| RT-9 P2 — 4 unresolved prevalidate citations in `arch-review-log.md` | **REJECT** | All four are in entries this diff did not touch (pre-existing, other branches' traces). Fixing another branch's citations is scope this ticket has no claim to; the audit that would catch them is not run on this file. |

## Adversarial (approach) — 2 P2, both accepted

| ID | Verdict | Disposition |
|---|---|---|
| A1 — an unknown deployment lane grants the loopback exception: `isProductionEnvironment()` read the ABSENCE of `VERCEL_TARGET_ENV` as evidence of non-production, so a Vercel project with system variables not exposed would admit `http://localhost:<any>` on a real production deployment | **ACCEPT** | `isProductionEnvironment()` now FAILS CLOSED: a non-empty target is trusted verbatim (`production` is production, anything else is a target Vercel does not call production); an empty or missing one falls back to `process.env.VERCEL !== undefined`, so "on Vercel with the signal off" reads as production and "not a Vercel deployment" (local, tests, the worker) does not. Staging and preview are unaffected — they carry an affirmative signal. |
| A2 — a config throw escapes `proxy()` as an unhandled exception: a platform 500 with no CORS envelope on EVERY `/api/admin/**` request, including no-`Origin` and same-origin ones, for the life of the deployment (the value cannot be re-read — changing it requires a redeploy) | **ACCEPT** | The parser still throws (ADR 0026 D2, and the mutation that deletes the throw must still fail — asserted). The proxy now CATCHES `AdminOriginConfigError` and returns the ordinary `403 {"error":"origin"}` + `Vary: Origin`, with a `console.error` naming the reason. **Partially rejected:** A2 asked for a sanitized log that omits the rejected entry. `ADMIN_APP_ORIGINS` holds public web origins an operator typed into a dashboard — server-authoritative (invariant #13), not confidential — and a config outage nobody can diagnose is the worse failure, so the entry is named. **Also not taken:** reusing the parser in the prebuild assertion. That would prevent the deployment rather than the 500, but `scripts/prebuild-assert-client-config.ts` is outside `allowed_edit_surface` and it would cost the second surface amendment; the 403 mapping already removes the 500. Follow-up. |

The report's low-confidence appendix (a future route header-writer or infrastructure
redirect could fall outside the wrapper's coverage) is recorded and untriaged, per the
confidence filter. It explicitly declines to assert the common "Vercel ignores `Vary`"
claim, having checked Next 16.3.0's own `Vary` handling.

## Spec & correctness — 4 low, no medium or high

It confirmed the `handleProxy` extraction is byte-identical to the pre-branch exported
body, which is the non-goal this branch most needed independently checked.

| Verdict | Disposition |
|---|---|
| **ACCEPT** — test #23 ships only a mixed-case fixture; plan §2 and §8 promise "mixed-case **and tab-bearing**", and the tab case is the one that distinguishes canonical output from raw bytes | Tab fixture added (`https://admin.stag\ting.repworth.net` normalizes onto the allowlisted origin while differing from it byte for byte). |
| **ACCEPT** — `ADR 0026 D14` citation | Same fix as RT-3. |
| **ACCEPT** — arch-review-log test counts wrong ("40 proxy + 37 config/CSRF") | Corrected to the measured 24 new CORS cases (40 file-wide) and 18 new config/CSRF cases (31 file-wide), and the entry now records the review outcome too. |
| **ACCEPT** — the handoff's read-order table says the deviations file holds "DEV-1 … DEV-4"; it holds seven | Replaced with a range-free pointer, so it cannot go stale again. |

## Standards & maintainability — 5 medium, 8 low

| Verdict | Disposition |
|---|---|
| **ACCEPT (M1)** — `isAdminApiRoute` re-spelt the `/api/admin` set `protected-routes.ts` already owns, held in sync only by a comment | Exported `isAdminApiRoute` from `src/lib/shared/protected-routes.ts`; `isProtectedRoute` now calls it and `src/proxy.ts` imports it. This is the branch's **one surface amendment** (2 files inside a tree the surface already covered → auto-approved). Fixing this on the branch whose stated principle is one owner per comparison was worth the amendment. |
| **REJECT (M2)** — an identical private `parseUrl` in `csrf.ts` and `admin-origins.ts` | Real duplication, but every fix is worse. `admin-origins` already imports `csrf`, so the reverse direction is a cycle; exporting a generic `parseUrl` from a CSRF module makes it "two things" — the exact smell this same review flags in L4; and a new `src/lib/shared/url.ts` is a new file for two five-line call sites, against "default is no new file" and "no abstraction before the second use". The **one-owner rule this branch preaches is about the own-origin comparison** — a security decision — not about a `try { new URL(x) } catch`. Revisit if a third caller appears. |
| **ACCEPT (M3)** — the Edge-safety scan misses `import 'x';`, `require()` and dynamic `import()` | Same fix as RT-2, which found it independently by mutation. |
| **ACCEPT (M4)** — the title claims "the CORS import graph" but the scan is depth-1, and the property is already false transitively (`src/proxy.ts` → `@supabase/ssr` → `@supabase/supabase-js`) | Added a sibling test that states the depth-1 limit out loud and pins that `@supabase/ssr` is the direct import and `@supabase/supabase-js` is not. The forbidden list stays a meaningful ban on DIRECT imports. |
| **ACCEPT (M5)** — arch-review-log counts | Same fix as the spec axis. |
| **ACCEPT (L1)** — `ADR 0026 D14` | Same fix as RT-3. |
| **ACCEPT (L2)** — the tautological length assertion | Same fix as RT-6. |
| **ACCEPT (L3)** — `origin` means "present or unparseable" before the guard and "present AND allowed" after, and it normalizes twice | Renamed to `candidate` / `allowedOrigin`, with the second declared only after the refusal guard so its name is true wherever it is readable. |
| **REJECT (L4)** — `addVaryOrigin` is exported from a Next file-convention module solely for its test; `src/lib/shared/` is the home | ADR 0026 D1 names `src/proxy.ts` as the owner of `Vary: Origin` alongside the `Access-Control-*` headers. Moving the helper out splits one locked rule across two homes to satisfy a convention about where utilities live. Next ignores extra exports from a proxy module. The export now carries a comment saying why it exists. |
| **ACCEPT (L5)** — the `requiresProductionConfig` paragraph documents `isProductionEnvironment` but is attached to `isPreviewEnvironment` | Rewritten as a JSDoc on `isProductionEnvironment` itself — which the A1 fix made essential, since the function is no longer a one-line equality. |
| **ACCEPT (L6)** — the parser rules are written out in three live places | `docs/directory/…` and `.env.example` are now pointers; `.claude/reference/env-vars.md` is the single owner, per `context-layout.md`'s one-owner-per-fact rule. |
| **ACCEPT (L7)** — the `stripComments` rationale is duplicated in two test files | The second copy is now a pointer to the first. The helper itself stays local to each suite: a shared test-util file is a new file for two callers. |
| **ACCEPT (L8)** — plan §5 D-2's line citations are fork-relative and now land on unrelated lines | Re-cited by symbol, with a note saying why. |
