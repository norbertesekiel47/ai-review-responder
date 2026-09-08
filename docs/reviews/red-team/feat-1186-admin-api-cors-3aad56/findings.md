# Red team — feat/1186-admin-api-cors

- **Mode** feature · **Round** 2 of 2 (the cap) · **Risk** high · **Status** `INCOMPLETE_ORACLE`
- **fork / merge-base** `c2de39d879c92cc657941b36d0be330cd0c20abf`
- **HEAD under review** `1ded393ae3bd1f2c9085f0eed4ad7de6da5633f7` (round 1 reviewed `4f132aae5175329d272a41bd9a0f89b9dff6c2c7`)
- **intake sha256** `13fa823169fb6ae87648961f964a6ca8e64e8e1df00071f8da1d88caf294cfe4` (changed since round 1 — the surface amendment added
  `src/lib/shared/protected-routes.ts` + its test)
- **Generated** 2026-09-08T10:55:11.377853Z
- **Mutations applied this round** 21, across 8 distinct test titles · **25 of 30 round-2 runs
  consumed** (1 green-baseline run + 21 mutant runs + 3 second-suite re-runs of the same mutant) ·
  every mutation journaled and restored
- **Scope** the fix hunks of `1ded393a` and their direct callers, per the pipeline. Round 1's
  thirteen killed security properties were NOT re-mutated; round 1's inventory stands as the
  record of round 1.

## Verdict

**The fixes work. Nothing regressed. No P0.**

All four fixes were attacked and none broke anything:

- **Fix 1** (`isProductionEnvironment` fails closed) is pinned in all four directions — replacing
  the fallback with `false` or `true`, dropping the `?.trim()`, and widening `if (target)` to
  `if (target !== undefined)` are each killed by the new fixtures (R14–R17). Its only caller in
  the repo is the loopback clause; local dev, `pnpm test` and the Railway worker are unaffected.
  **But the marker it keys on does not do what the fix says it does — RT-10.**
- **Fix 2** (the config throw caught at the proxy boundary) is correct and well pinned. The
  rewritten test is **as strong as the `rejects.toThrow` it replaced**: R9 re-runs round 1's M8
  and it still dies, because the no-`Origin` leg is what distinguishes the moved read. The
  `console.error` (R10), the refusal-not-degrade behaviour (R11) and the parser's own throw (R13)
  are all killed. The rethrow of a non-`AdminOriginConfigError` is unreachable at HEAD and
  measured by nothing — RT-18, no action recommended.
- **Fix 3** (the `isAdminApiRoute` extraction — the branch's highest-blast-radius change) is
  behaviour-identical. `return false` is killed from `protected-routes.test.ts` (R19), so
  `isProtectedRoute` genuinely calls it and **no route's protection changed in either
  direction**. Both boundaries are killed — from the proxy suite (R18/R20). Coverage-location
  note: RT-16.
- **Fix 4** (the two round-1 P0s) repaired both. **M3 now DIES** (R1). **M27 and M28 now DIE**
  (R2, R3), as do `require('node:crypto')` (R5) and an aliased re-export (R6). The
  `ALL_ACCESS_CONTROL_HEADERS` sweep can genuinely fail (R8). One shape still escapes: a
  template-literal specifier — RT-14.

What round 2 found instead is a **documentation-and-evidence cluster**: four of the five P1s are
claims that do not survive re-derivation, and three of those four were written BY the fix pass.
The code is in better shape than the paper around it.

## Findings

| Severity | file:line | Finding | Survived mutation? |
|---|---|---|---|
| **P1** | `src/lib/config/flags.ts:71` | Fix 1's fail-closed fallback keys on VERCEL, which Vercel documents as the marker that system environment variables ARE exposed - so in the exact configuration A1 describes the predicate still returns false | n/a |
| **P1** | `docs/superpowers/plans/feat-1186-admin-api-cors-plan.md:222` | Plan section 2 and section 5 delta D-1 still state the PRE-FIX predicate VERCEL_TARGET_ENV === 'production', and D-1's code citation now lands on isPreviewEnvironment | n/a |
| **P1** | `.claude/reference/arch-review-log.md:36` | The corrected test counts in the #1186 arch-review-log entry are still wrong on all three numbers (23 not 24, 19 not 18, 38 not 31) | n/a |
| **P1** | `.feature/logs/t1-baseline-record.md:44` | The RT-5 fix's evidence sentence is wrong: it claims all five characterization titles were mutation-tested, cites a mutation/title pair that is not one of the five, and omits the two round 1 actually recorded | n/a |
| **P1** | `src/lib/config/__tests__/admin-origins.test.ts:226` | The rewritten Edge-safety extractor still cannot see a template-literal specifier, so import(`node:crypto`) walks through the guard | yes (R4) |
| **P2** | `src/lib/config/__tests__/admin-origins.test.ts:201` | The Edge-safety scan's four-file graph omits src/lib/shared/protected-routes.ts, which Fix 3 made the owner of the CORS block's own gate predicate | yes (R7, proven equivalent) |
| **P2** | `src/lib/shared/protected-routes.ts:83` | The extracted isAdminApiRoute is pinned only from the proxy suite; protected-routes.test.ts gained no fixture for it, and it is the one exported predicate in that module that does not normalize its own input | yes (R18/R20 vs the module suite, proven equivalent) |
| **P2** | `src/__tests__/proxy.test.ts:335` | proxy.test.ts beforeEach clears VERCEL_TARGET_ENV but not VERCEL, the hygiene the same fix added to the two suites that exercise the loopback rule | n/a |
| **P2** | `src/proxy.ts:126` | The catch's non-AdminOriginConfigError rethrow is unreachable at HEAD and exercised by no test | yes (R12, proven equivalent) |

### Round-1 findings — dispositions re-verified at `1ded393a`

| ID | Round-1 severity | Disposition | Verified how |
|---|---|---|---|
| RT-1 | P0 | **fixed** | R1 re-runs M3 (scheme throw deleted) → the test now FAILS. `ftp://admin.example` and `ws://admin.example/` each break only the scheme rule. |
| RT-2 | P0 | **fixed** | R2 (M27) and R3 (M28) both now FAIL, plus R5 (`require`) and R6 (re-export). Residual shape → RT-14. |
| RT-3 | P1 | **fixed** | `rg -o '\bD[0-9]{1,2}\b' docs/adr/0026-admin-api-cors.md` still yields D1–D8 only; the comment now cites plan §5 D-14, which exists at `plan.md:276`, and says so explicitly. |
| RT-4 | P1 | **fixed (differently)** | The throw no longer escapes `proxy()`, so there is no 500 to alert on. The remaining `console.error`-with-no-sink is routed to **#1212**, which resolves: a real follow-up cut by #1183 (`docs/reviews/red-team/feat-1183-admin-transport-seam-7ee6d4/findings.md:1078`, `src/lib/auth/verified-identity.ts:59`). |
| RT-5 | P1 | **fixed** | The "Second record" exists and classifies all five titles. Its evidence sentence is wrong → RT-13. |
| RT-6 | P2 | **fixed** | R8 adds `Access-Control-Allow-Credentials` to the refusal and the new sweep FAILS. |
| RT-7 | P2 | **rejected** | Verdict holds on unreachability and remit. One inexactness in the stated reason, recorded in the sidecar, not re-opened. |
| RT-8 | P2 | **fixed** | Both absence-of-substring proxies removed. |
| RT-9 | P2 | **rejected** | Verdict holds: the fix commit edits only the #1186 entry; the four unresolved citations are in other branches' entries. |

### RT-10 — P1 — Fix 1's fail-closed fallback keys on VERCEL, which Vercel documents as the marker that system environment variables ARE exposed - so in the exact configuration A1 describes the predicate still returns false

**At** `src/lib/config/flags.ts:71` · **Duty** 3 · **Disposition** `open`

Duty 3, re-resolved this pass against vercel.com/docs/environment-variables/system-environment-variables via the Vercel documentation MCP: 'VERCEL environment variable - Indicates that system environment variables are exposed to the deployment. VERCEL=1'. VERCEL is itself a system environment variable and its documented meaning is that the exposure toggle is ON. A1's scenario is a project whose system variables are NOT exposed; there VERCEL_TARGET_ENV is absent AND VERCEL is absent, so process.env.VERCEL !== undefined is false and isProductionEnvironment() returns false - http://localhost:<any port> stays admissible on a real production deployment, which is the hole the fix was written to close. Two consequences, both checked. (a) NO REGRESSION: the new predicate returns exactly what the old one returned in every configuration where the fallback runs, and R14/R15/R16/R17 all killed, so the shipped behaviour is unchanged and correctly pinned. (b) The CLAIM is what fails: the JSDoc at src/lib/config/flags.ts:57-62 ('on Vercel with the signal switched off - treat as production') and triage.md:37's A1 disposition both assert a property the marker cannot deliver. Rated P1 not P0 because the evidence is vendor documentation rather than a probe of this project's own deployment, and because nothing regressed. Blast radius checked and small: isAllowedAdminOrigin's loopback clause (src/lib/config/admin-origins.ts:188) is the ONLY caller in the repo. Local dev, pnpm test and the Railway worker are unaffected - VERCEL is unset in all three, and the repo runs next dev, never vercel dev (no occurrence of 'vercel dev' outside node_modules). Remedy: verify live the way src/lib/config/deployment-lane.ts:5-10 verified the Railway signals ('Verified live against Railway on 2026-07-28'), or key the fallback on something that survives the toggle. If this project's toggle is ON - the default - the fallback is dead code and A1 was hypothetical here; say that instead of claiming a fix.

### RT-11 — P1 — Plan section 2 and section 5 delta D-1 still state the PRE-FIX predicate VERCEL_TARGET_ENV === 'production', and D-1's code citation now lands on isPreviewEnvironment

**At** `docs/superpowers/plans/feat-1186-admin-api-cors-plan.md:222` · **Duty** 3 · **Disposition** `open`

Duty 3, re-resolved against 1ded393a. Two live claims the fix falsified and did not update: plan.md:98 (isProductionEnvironment(): boolean // process.env.VERCEL_TARGET_ENV === 'production') and plan.md:222 (The lane test is VERCEL_TARGET_ENV === 'production'). Neither is true at HEAD - src/lib/config/flags.ts:68-72 is a two-branch predicate with a trim and a fallback. The citation on :222, src/lib/config/flags.ts:32-37, now resolves to isPreviewEnvironment's comment block (verified: those lines are the VERCEL_ENV-vs-VERCEL_TARGET_ENV note; isProductionEnvironment's JSDoc starts at :57 and its body at :68). The same commit DID re-cite the adjacent D-2 by symbol, saying the fork-relative numbers now land on unrelated lines - D-1 was left behind in that same pass. Stronger than round-1 RT-3, which was provenance-only: this states BEHAVIOUR the code no longer has, in the doc the handoff's read-order table lists third. Rated P1 not P0 because the shipped code and its JSDoc describe the new predicate correctly and R14-R17 pin it, so no reader acting on the CODE produces a defect; the risk is a future engineer 'restoring' the plan's stated equality. An arbiter could reasonably read Duty 3's letter ('a misleading FALSE claim is P0') and rate it higher - it is a two-line fix either way.

### RT-12 — P1 — The corrected test counts in the #1186 arch-review-log entry are still wrong on all three numbers (23 not 24, 19 not 18, 38 not 31)

**At** `.claude/reference/arch-review-log.md:36` · **Duty** 3 · **Disposition** `open`

Duty 3, re-derived this pass at 1ded393a as the round-2 brief asked. The entry claims '24 new CORS cases in proxy.test.ts (40 file-wide) and 18 new cases across admin-origins.test.ts / flags.test.ts / csrf.test.ts (31 file-wide)'. Measured: proxy.test.ts executes 40 tests (correct), of which 17 precede describe('admin API CORS') and 23 - not 24 - are inside it; the same 23 is the diff delta against c2de39d8 (17 -> 40 source it( sites). For the other three files vitest executes 13 + 11 + 14 = 38, not 31, and the new-case delta is 13 (admin-origins, a new file) + 1 (flags) + 5 (csrf) = 19, not 18. The 31 is reproducible as an it(-source count that misses flags.test.ts's it.each block (4 source it( sites vs 11 executed cases), which also explains the missing +1 in the 18. Rated P1 because this is the SECOND pass at these numbers - the spec axis already flagged them once, and triage.md records them as 'Corrected to the measured...' - and arch-review-log.md is the durable architecture trace. Correct values: 23 new CORS cases (40 file-wide); 19 new cases across the three config/CSRF suites (38 file-wide).

### RT-13 — P1 — The RT-5 fix's evidence sentence is wrong: it claims all five characterization titles were mutation-tested, cites a mutation/title pair that is not one of the five, and omits the two round 1 actually recorded

**At** `.feature/logs/t1-baseline-record.md:44` · **Duty** 3 · **Disposition** `open`

Duty 3, checked against round 1's own mutation table in this directory's findings.md. The record's closing sentence reads 'Every one of these five was independently mutation-tested in the review wave (M19 ... #7; M22 ... #2; M8 moved the allowlist read and #13 killed it)'. Three defects: (1) #13 ('validates the entire allowlist before the self-origin, loopback and missing-Origin shortcuts', intake tests_to_add[13]) is NOT one of the five characterization titles - the five are #2, #7, #8, #12, #14 - and #13 was RED at baseline, so citing it as evidence about the five is a non-sequitur; (2) it omits M20 -> #8 and M21 -> #14, which round 1 DID record; (3) 'every one of these five' was FALSE when written - round-1 RT-5 states verbatim that '#12 is still unprobed'. Downgraded from a false-evidence P0 to P1 because I settled the substance rather than argue it: round-2 mutation R21 widened proxy()'s non-admin early return to stamp Vary and Access-Control-Allow-Origin, and #12 killed it (INV-223), so all five titles are now measured and only the cross-references are wrong. Correction to write: M22 -> #2, M19 -> #7, M20 -> #8, M21 -> #14, round-2 R21 -> #12.

### RT-14 — P1 — The rewritten Edge-safety extractor still cannot see a template-literal specifier, so import(`node:crypto`) walks through the guard

**At** `src/lib/config/__tests__/admin-origins.test.ts:226` · **Duty** 2 · **Disposition** `open`

Duty 1/2. Round 1's RT-2 fix widened the extractor from one regex to four and made the node: entry a prefix match; R2, R3, R5 and R6 confirm that from '...', a bare import '...', require('...') and an aliased re-export are all killed now. R4 shows the residual: all four regexes spell their quote class as ['"], so a backtick specifier yields no match and the mutant passes (INV-206). NOT classified survived-confirmed-P0: the guard is no longer a fake test - it enforces its property for every shape that occurs in this repo and for the three a reviewer would try - and the escaping shape is one the oracle never examines rather than one it evaluates wrongly, which is an ORACLE claim (INCOMPLETE_ORACLE), not a MUTANT claim. Not equivalent either: the mutated file really does import a node builtin. Rated P1 rather than P2 because a reviewer reading a guard that was just P0-fixed FOR incomplete matching will assume the matching is now complete. One-character remedy: ['"`] in all four quote classes; INV-206 then becomes killed and the run's status clears to OPEN_P1.

### RT-15 — P2 — The Edge-safety scan's four-file graph omits src/lib/shared/protected-routes.ts, which Fix 3 made the owner of the CORS block's own gate predicate

**At** `src/lib/config/__tests__/admin-origins.test.ts:201` · **Duty** 4 · **Disposition** `open`

Duty 4, recorded sibling search. graph is ['src/proxy.ts', 'src/lib/config/admin-origins.ts', 'src/lib/config/flags.ts', 'src/lib/shared/csrf.ts']. src/proxy.ts has four repo-code direct imports - protected-routes, request-path-header, auth/flags and config/admin-origins - and only the last is scanned. R7 demonstrates the consequence: a node:crypto import added to protected-routes.ts reaches the Edge proxy and the guard does not see it (INV-207, proven equivalent w.r.t. the assertion because that file is not one of the four inputs). NOT a regression introduced by this branch, which is why it is P2 and not P1: git show c2de39d8:src/proxy.ts already imported @/lib/shared/protected-routes at the merge base, so the gap predates the diff. What Fix 3 changed is its relevance - isAdminApiRoute, the predicate that gates the entire CORS block, now lives in an unscanned file, and the sibling test added at :245 states the depth-1 limit but not this one. One-line remedy: add 'src/lib/shared/protected-routes.ts' to graph.

### RT-16 — P2 — The extracted isAdminApiRoute is pinned only from the proxy suite; protected-routes.test.ts gained no fixture for it, and it is the one exported predicate in that module that does not normalize its own input

**At** `src/lib/shared/protected-routes.ts:83` · **Duty** 1 · **Disposition** `open`

Duty 1, coverage location. Fix 3 is behaviour-identical - the clause moved verbatim, and R19 (return false) is killed by '/api/admin/businesses is protected', so isProtectedRoute genuinely calls it and no route changed protection in either direction. But the module's own suite carries only '/api/admin/businesses': no bare '/api/admin' and no '/api/adminfoo', so BOTH boundary mutations survive there (INV-218, INV-222) and are killed only from src/__tests__/proxy.test.ts (INV-220, INV-221). The branch's stated principle for this extraction is that a comment is not a mechanism; the same argument applies to leaving the mechanism's own fixtures in another suite. Second, smaller point: isProtectedOwnerApiRoute and isProtectedMixedRoleApiRoute both call normalizePath on their argument, isAdminApiRoute does not (its JSDoc says so), so an external caller passing '/API/Admin/x' gets false. Both call sites normalize today, so that is a shape note, not a defect. src/lib/shared/__tests__/protected-routes.test.ts is inside allowed_edit_surface.

### RT-17 — P2 — proxy.test.ts beforeEach clears VERCEL_TARGET_ENV but not VERCEL, the hygiene the same fix added to the two suites that exercise the loopback rule

**At** `src/__tests__/proxy.test.ts:335` · **Duty** 2 · **Disposition** `open`

Duty 2, environment dependence. Fix 1 added 'delete process.env.VERCEL' to admin-origins.test.ts's withEnv (:37) with the reason that 'leaving a stray VERCEL in the environment would silently make every lane read as production', and to flags.test.ts (:71). proxy.test.ts's beforeEach was not updated. No assertion depends on it TODAY - both loopback proxy cases set VERCEL_TARGET_ENV explicitly ('staging' at :439, 'production' at :450), an affirmative signal that short-circuits the new fallback - so this is P2 and no test is currently fragile. It becomes a live hazard the moment a loopback case is added without setting the target env: the suite would then pass or fail on whether the developer's shell exports VERCEL. One-line remedy, matching the two sibling suites.

### RT-18 — P2 — The catch's non-AdminOriginConfigError rethrow is unreachable at HEAD and exercised by no test

**At** `src/proxy.ts:126` · **Duty** 1 · **Disposition** `open`

Duty 1, uncovered defensive branch. R12 deletes the rethrow so the catch swallows every error, and the covering test still passes (INV-212). Recorded as equivalent rather than a survivor because the mutant is PROVABLY behaviour-preserving at HEAD: readAdminAppOrigins() reaches only process.env, String split/map/filter/trim, parseAllowlistEntry (which throws AdminOriginConfigError alone) and url.origin, and parseUrl catches new URL() - so every error that can arrive at the catch already IS an AdminOriginConfigError. The rethrow is correct defensive depth for a future in which that stops being true. Filed so the arbiter knows nothing measures it; no action recommended, since a test would mean stubbing a module that cannot fail.

## Duty 1 — hand-mutation

Environment identical to round 1: allowlist-only (`PATH`, temporary `HOME`, `TMPDIR`,
`NODE_ENV=test`, `CI=true`, `MOCK_EXTERNAL_APIS=true`, `REPWORTH_DISABLE_LIVE_DB_SUITES=1`),
with `.env.local` swapped for a scrubbed copy under the journaled rename-to-backup protocol.
Green baseline: one run of all four changed suites at `1ded393a` — **78 passed / 78** (round 1
had 77; the extra case is the depth-1 sibling test Fix 4 added).

Every mutant run went through the paused supervisor with `assert-one-test`, so each verdict is
one executed test. After every mutation the file was restored and `git status --porcelain
--untracked-files=no` re-checked clean before the next mutation.

| # | Target | Mutation | Test | Result |
|---|---|---|---|---|
| R1 | admin-origins.ts | **round-1 M3**: the `http:`/`https:` throw deleted | throws … is not an http or https origin | **killed** |
| R2 | admin-origins.ts | **round-1 M27**: `import { createHash } from 'node:crypto'` | keeps the CORS import graph free of node builtins… | **killed** |
| R3 | admin-origins.ts | **round-1 M28**: bare `import 'node:crypto';` | same | **killed** |
| R4 | admin-origins.ts | template-literal `import(`node:crypto`)` | same | **SURVIVED → RT-14** (inconclusive/oracle) |
| R5 | admin-origins.ts | `require('node:crypto')` | same | **killed** |
| R6 | admin-origins.ts | aliased re-export from `'node:crypto'` | same | **killed** |
| R7 | protected-routes.ts | `node:crypto` in a file outside the four-file `graph` | same | survived — **proven equivalent** → RT-15 |
| R8 | proxy.ts | refusal emits `Access-Control-Allow-Credentials: true` | never sends Allow-Credentials or Expose-Headers… | **killed** (the sweep can fail) |
| R9 | proxy.ts | **round-1 M8**: allowlist read (with its try/catch) moved inside `rawOrigin !== null` | validates the entire allowlist before the … shortcuts | **killed** |
| R10 | proxy.ts | the `console.error` dropped from the catch | same | **killed** |
| R11 | proxy.ts | catch falls through with `allowlist = []` | same | **killed** |
| R12 | proxy.ts | the non-`AdminOriginConfigError` rethrow deleted | same | survived — **proven equivalent** → RT-18 |
| R13 | admin-origins.ts | the wildcard throw deleted (does the parser still throw?) | same | **killed** |
| R14 | flags.ts | `VERCEL !== undefined` fallback → `false` | isProductionEnvironment is true only for … | **killed** |
| R15 | flags.ts | `?.trim()` dropped | same | **killed** |
| R16 | flags.ts | `if (target)` → `if (target !== undefined)` | same | **killed** |
| R17 | flags.ts | fallback → `true` | same | **killed** |
| R18 | protected-routes.ts | **round-1 M17**: bare `/api/admin` exact match dropped | /api/admin/businesses is protected | survived — **proven equivalent** → RT-16 |
| R18 | protected-routes.ts | (same mutant) | matches bare and normalized admin API paths… | **killed** |
| R19 | protected-routes.ts | `isAdminApiRoute` returns `false` | /api/admin/businesses is protected | **killed** |
| R20 | protected-routes.ts | **round-1 M16**: widened to `startsWith('/api/admin')` | /api/admin/businesses is protected | survived — **proven equivalent** → RT-16 |
| R20 | protected-routes.ts | (same mutant) | matches bare and normalized admin API paths… | **killed** |
| R21 | proxy.ts | non-admin early return widened to stamp `Vary` + ACAO | writes no Access-Control header on a non-admin route | **killed** (discharges title #12) |

**No `skipped-budget` rows.** Round 2's scope is the fix hunks and their direct callers, and every
candidate in that scope was executed; 5 of the 30 runs were left unused.

## Duty 2 — fragile assertions

- The `ALL_ACCESS_CONTROL_HEADERS` sweep that replaced round 1's tautology is real (R8 kills it).
  It is now partly redundant with `accessControlHeaderNames(refused)).toEqual([])` two lines
  below, which is the stronger assertion because it does not depend on the list — recorded, not
  filed.
- RT-14: the Edge-safety extractor's four quote classes.
- RT-17: `proxy.test.ts` clears `VERCEL_TARGET_ENV` but not `VERCEL`.

## Duty 3 — docs vs reality

Re-resolved against `1ded393a`. `prevalidate-plan.py` was available and was run.

| Claim | Result |
|---|---|
| ADR 0026 D-ids | still D1–D8 only; the D14 miscitation is gone (RT-3 fixed) |
| plan §5 D-14 exists | ✅ `plan.md:276` |
| plan §2 `:98` and §5 D-1 `:222` predicate statements | ❌ **false at HEAD** → RT-11 |
| plan §5 D-1's `flags.ts:32-37` citation | ❌ resolves to `isPreviewEnvironment` → RT-11 |
| arch-review-log #1186 counts | ❌ 24/18/31 vs measured 23/19/38 → RT-12 |
| `.feature/logs/t1-baseline-record.md` "Second record" | exists; its cross-references are wrong → RT-13 |
| `#1212` (RT-4's deferral target) | ✅ resolves — cut by #1183 |
| `VERCEL` as the "system vars not exposed" marker | ❌ contradicted by Vercel's own docs → RT-10 |
| triage.md coverage of round-1 findings | ✅ all nine of RT-1…RT-9 carry a verdict |

## Duty 4 — missed sibling cases

| Pattern | Scope | Result |
|---|---|---|
| `process.env.VERCEL` (unsuffixed) | whole repo, non-`node_modules` | one production site (`flags.ts:71`) + three test sites. **Zero siblings.** |
| callers of `isProductionEnvironment` | whole repo | exactly one: `admin-origins.ts:188`. Blast radius of Fix 1 confirmed minimal. |
| `vercel dev` | whole repo | zero occurrences; `package.json` runs `next dev`. Fix 1 cannot break local dev. |
| direct repo-code imports of `src/proxy.ts` vs the Edge-safety `graph` | `src/` | four imports, one scanned → RT-15 (pre-existing: `git show c2de39d8:src/proxy.ts` already imported protected-routes). |
| `it(`-vs-executed test counts | the four changed suites | `flags.test.ts` has an `it.each`, which is what makes the arch-review-log numbers wrong (RT-12). |

## Duty 5 — operational completeness

Fix 2 REMOVES the terminal path round 1 filed as RT-4: the throw no longer escapes `proxy()`, so
there is no unhandled edge exception and no 500. What replaces it is a `console.error` on a
fail-closed 403 — a SWALLOWED path with a log line and no Sentry sink. Not filed again: it is the
identical gap `#1183` measured and the owner accepted with follow-up ticket **#1212**, which
resolves and carries the measurements. `docs/runbooks/beta-launch-alerting.md` needs no new rule
row for a path that no longer emits a terminal signal.

Checked and clear: the 403 is reachable on every path the throw was reachable on (the catch
precedes the method branch, the `rawOrigin` read and the preflight branch, so no-`Origin`,
self-origin, loopback, preflight and every method all get the same envelope — statically, and
three of them by assertion); the caught path returns before `handleProxy`, so no Supabase work
(asserted); `console.error` is a plain call with no environment dependence.

## Authorizations

None. No finding on this run is `accepted-risk`.

## Restoration

All 21 mutations were applied through the journaled runner and restored; `git status --porcelain
--untracked-files=no` is clean on every mutated path, and each journal entry's working blob is
back at its recorded `originalOid`. The dotenv swap is left OPEN by design — the orchestrator's
`finalize` owns the restore, exactly as in round 1. Nothing outside this directory was created.

## For the arbiter

No P0. On a high-risk run every open P1 needs adjudication, and the status is
`INCOMPLETE_ORACLE` because of one row (INV-206 / RT-14).

Cheapest path to a clean sidecar, in order:

1. **RT-14** — one character (`['\"`]`) in the four extractor regexes at
   `admin-origins.test.ts:226-231`. INV-206 becomes `killed`; status drops to `OPEN_P1`.
2. **RT-11, RT-12, RT-13** — three documentation corrections, all with the exact replacement text
   in their findings above.
3. **RT-10** is the only one that needs a decision rather than an edit: either verify the
   `VERCEL` marker live (the `deployment-lane.ts` precedent) or stop claiming the fallback closes
   A1. Nothing regressed either way.

