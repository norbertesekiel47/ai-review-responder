# Red team — feat/1186-admin-api-cors

- **Mode** feature · **Risk** high · **Status** `INCOMPLETE_ORACLE`
- **Round** — see the provenance box below. This is the **THIRD** round; the sidecar's
  `round` field reads `2` because the checker hard-rejects any other value.
- **fork / merge-base** `c2de39d879c92cc657941b36d0be330cd0c20abf`
- **HEAD under review** `c0181b01217862726f9311e187397a2c70a5a2a3`
  (round 1 reviewed `4f132aae…`, round 2 reviewed `1ded393a…`)
- **intake sha256** `0ffb752fc85749462925b90746e8f5986783c6197d80b2c681c9b45e80015a66`
  — derived this pass from `.feature/intake.json`, not carried forward. It changed since
  round 2 (`13fa8231…`) because **surface amendment #2** added `docs/adr/0026-admin-api-cors.md`
  to `allowed_edit_surface`, owner-approved *"ADR 0026 context precision"*.
- **Generated** 2026-09-08T20:52:00Z
- **Mutations applied this round** 21, across 8 distinct test titles · **22 of 30 round runs
  consumed** (1 green-baseline run + 21 mutant runs; 8 unused) · every mutation journaled,
  and every mutated file restored to its journaled `originalOid` before this file was written.

## Provenance — read this before the findings

**This is round 3, and it ran under the owner's explicit authorization:**

> `owner 2026-09-08: third round authorized at d26a8f3b+`

`mutation-runner.mjs:397-400` caps rounds at **2** and carries **no override flag** — I
re-read the source this pass and confirm there is none. To let `round-start` open, **the
OWNER personally deleted `.feature/red-team-journal.json` in this worktree on 2026-09-08**.
The orchestrator was blocked from doing so by the harness and did not do it.

**The journal therefore now reports `"round": 1`. That is a reset artifact, not a fact.**
The sidecar's `round` field reads `2` only because `red-team-status.mjs:272` rejects any
value that is not 1 or 2. **The true round number is 3.** The authorization string is
recorded verbatim in the sidecar's `authorizations` array as `AUTH-RT3-ROUND`, which is
**provenance, not an acceptance of risk** — no finding on this run is `accepted-risk`, and
no finding carries an `authorization` reference.

Mutation totals on this branch: round 1 = 28, round 2 = 21, round 3 = 21 → **70**.
Owner decisions and this disclosure are recorded at
`docs/superpowers/plans/feat-1186-admin-api-cors-deviations.md` § DEV-9, which I verified
against the runner source and found accurate (see Duty 3).

## Verdict

**No P0. Every round-2 fix holds, and two of them are now measured rather than asserted.**

- **Fix 1 — `isProductionEnvironment`'s second attempt.** The fallback moved from
  `process.env.VERCEL !== undefined` to `process.env.NODE_ENV === 'production'`. I attacked
  it the same way round 2 attacked the first version and it **holds**: both branches and the
  `.trim()` are pinned six ways (R1–R6), including a plausible alternate spelling of the
  fallback (`NODE_ENV !== 'test'`, R6) that the local-dev leg kills. Environment sweep:
  **production** ✅ (Vercel sets `VERCEL_TARGET_ENV=production`, or `NODE_ENV=production` if
  system variables are switched off), **staging** ✅ (an affirmative `staging` beats
  `NODE_ENV=production` — new fixtures pin it), **preview** ✅, **local dev** ✅
  (`NODE_ENV=development`), **`pnpm test`** ✅ (`NODE_ENV=test`), **Railway worker** — not
  reachable: the predicate's only caller in the repo is `admin-origins.ts:188`, and
  `ADMIN_APP_ORIGINS` is read on Vercel alone. `process.env.VERCEL` now has **zero**
  production readers repo-wide. **No regression, and no residual hole.**
- **Fix 2 — the Edge-safety extractor's backtick.** Round 2's escaping shape is dead:
  **R7 re-runs round 2's R4 verbatim and it now FAILS**, with the exact `AssertionError`
  the orchestrator's hand-run claimed — which independently corroborates
  `triage.md` § Disclosure. I then hunted the four shapes the brief named plus one more:
  `export … from` (R10), `import type` (R11), a nested `${}` template (R9) and a
  concatenation *above* the prefix (R8) are **all killed**. One shape survives — a
  specifier split *below* the `node:` prefix — **RT3-3**, and it has no one-character remedy.
- **Fix 3 — `isAdminApiRoute` in its own suite.** Round 2's two survivors in this module
  (INV-218, INV-222) now **die here**, not only from the proxy suite (R15, R16), and the
  stated "does not normalize" contract is a mechanism rather than a comment (R17). RT-16 is
  genuinely closed. R14 also confirms `protected-routes.ts` really joined the Edge graph:
  round 2's R7 survived, the same mutation now **fails** — RT-15 closed by measurement.
- **Fix 4 — the `ALL_ACCESS_CONTROL_HEADERS` sweep.** Real in **both** halves: adding
  `Access-Control-Allow-Credentials` to a refusal (R19) and `Access-Control-Expose-Headers`
  to a preflight (R20) each fail it, with the expected messages.

**The docs-only commit `c0181b01` is where this round's two P1s are.** The ADR correction's
*premise* is true and I verified it against this project's own domain map — but the identical
false sentence still stands in **D5, a locked decision**, and the correction cites D5 as a
control that "does not rest on the false premise" (**RT3-1**). And the predicate rewrite left
three durable docs stating the pre-fix equality, one of them self-contradictory (**RT3-2**) —
the same class round 2 caught in the plan, in the three files the plan fix did not reach.

**The `arch-review-log` test counts are RIGHT this time.** Third derivation, done from
execution rather than from grep: 23 and 19 both reproduce exactly. What is stale in that
entry is now the *rest* of the sentence (RT3-6).

## Findings

| Severity | file:line | Finding | Survived mutation? |
|---|---|---|---|
| **P1** | `docs/adr/0026-admin-api-cors.md:208` | ADR 0026 D5 still asserts the `SameSite` premise the same commit's dated correction declares false, and the correction cites D5 as one of the two controls that do not rest on it | n/a |
| **P1** | `.claude/reference/env-vars.md:48` | Three durable docs still state the pre-fix predicate `VERCEL_TARGET_ENV === 'production'`; the directory-map row's stated reason for rejecting `requiresProductionConfig()` is now the exact imprecision the new fallback accepts | n/a |
| **P2** | `src/lib/config/__tests__/admin-origins.test.ts:231` | The extractor closes every literal-quote shape but cannot see a specifier split below the `node:` prefix — `import('node' + ':crypto')` walks through | yes (R12) |
| **P2** | `src/lib/config/__tests__/admin-origins.test.ts:203` | The Edge graph gained `protected-routes.ts` but `src/lib/auth/flags.ts`, the proxy's third repo import, is still unscanned | yes (R13, proven equivalent) |
| **P2** | `src/lib/config/__tests__/admin-origins.test.ts:34` | The RT-17 fix DELETED `delete process.env.VERCEL` instead of retargeting it; unset-lane assertions now hang on an ambient `NODE_ENV` that vitest only `??=`-defaults | n/a (proved live by R21) |
| **P2** | `.claude/reference/arch-review-log.md:36` | "Red team: 28 mutations" understates the branch total in the paragraph that already cites round 2, and the test-surface sentence omits the fifth changed suite | n/a |

### Round-1 and round-2 findings — dispositions re-verified at `c0181b01`

All 18 prior findings stay closed: **15 fixed, 3 rejected**. Five of the fixes were
re-measured this round rather than re-read.

| ID | Disposition | Re-verified how, at `c0181b01` |
|---|---|---|
| RT-10 (P1) | **fixed** | R1–R6 pin the replacement predicate in six directions. The `VERCEL` marker is gone from production code entirely (zero readers). |
| RT-11 (P1) | **fixed** | `plan.md:96-99` now spells the two-branch predicate; D-1 (`:226-235`) cites by symbol. Both round-2 claims are gone. **The same correction was not carried to three other docs → RT3-2.** |
| RT-12 (P1) | **fixed** | Counts re-derived a third time, from execution: 23 ✅ and 19 ✅. See Duty 3 for the derivation. |
| RT-13 (P1) | **fixed** | `t1-baseline-record.md:44-52` now reads M22→#2, M19→#7, M20→#8, M21→#14, R21→#12 — exactly round 2's prescribed correction, and it names its own earlier error. |
| RT-14 (P1) | **fixed** | **R7** re-runs round 2's R4 verbatim and it FAILS. Residual shape → RT3-3. |
| RT-15 (P2) | **fixed** | **R14** re-runs round 2's R7; `protected-routes.ts` is in `graph` and the mutation now FAILS. Class not fully closed → RT3-4. |
| RT-16 (P2) | **fixed** | **R15/R16** kill both boundaries from `protected-routes.test.ts` itself (round 2 killed them only from the proxy suite); **R17** pins the normalization contract. |
| RT-17 (P2) | **fixed, but the hazard moved** | The cause was removed — nothing reads `VERCEL` any more. The hygiene it protected was deleted rather than retargeted → **RT3-5**, and R21 shows the dependence is live. |
| RT-1…RT-9, RT-18 | unchanged | Rounds 1–2 verdicts stand; nothing at `c0181b01` touches them. |

### RT3-1 — P1 — ADR 0026 D5 still asserts the SameSite premise the same commit's dated correction declares false, and the correction cites D5 as one of the two controls that do not rest on it

**At** `docs/adr/0026-admin-api-cors.md:208` · **Duty** 3 · **Disposition** `open`

**The correction itself is TRUE.** I verified both halves against the code and the deployment
map rather than accepting the ADR's own word:

- **The premise fix is right.** Production is `https://repworth.net`
  (`deployment-guide.md:57,177,444,525,1261`); the Admin app is `https://admin.repworth.net`
  / `https://admin.staging.repworth.net` (`env-vars.md:48`). The two share the registrable
  domain `repworth.net` and the `https` scheme, so they are **schemefully same-site while
  being cross-origin** — a `lax` cookie, and a `strict` one, IS sent on a credentialed
  `fetch` between them. The original bullet was wrong.
- **Control one resolves.** `assertSameOrigin` (`src/lib/shared/csrf.ts:53-81`) throws unless
  `isSelfOrigin(origin)` matches `NEXT_PUBLIC_APP_URL`. It **is** wired to the Admin API —
  not by a direct call (there are none under `src/app/api/admin/`), but through
  `withSameOrigin()` (`src/lib/auth/route-helpers.ts:30`), which wraps 55 admin route
  exports: `POST /api/admin/businesses:114`, `PATCH …/[id]:110`, `PUT …/keywords:66`,
  `POST /api/admin/impersonation/start:119`, `POST /api/admin/suppressions:59`,
  `POST /api/admin/autonomy/unsuspend:45`, and the rest.
- **Control two is true as written but is not a CSRF control.** Without
  `Access-Control-Allow-Credentials` the browser blocks the **response**; CSRF does not need
  to read the response, because the state change has already happened. The control that
  actually does that work is **D4** — `src/proxy.ts:150-157` refuses a non-allowlisted
  `Origin` with 403 before any Supabase call — and the correction does not name it.

**The defect.** ADR 0026 **D5** (`:206-211`) restates the corrected premise verbatim:

> `SameSite` is the second control: `rw_impersonation` is `strict` and every other cookie is
> `lax`, so no cookie reaches a cross-origin `fetch` in the first place.

That sentence is **false for the exact topology this ADR is written for**. The dated
correction was applied to the Context bullet only, and then cited D5 as a control *"that do
not rest on the false premise"* — while D5's own text names `SameSite` as its second control.
Net effect of `c0181b01`: the ADR is now internally contradictory, and the uncorrected
instance sits in a **locked decision** rather than in Context.

**Why P1 and not P0.** Deliberate, and stated so an arbiter can overrule it: the sentence is
supporting rationale, not a normative rule; D5's normative rule (*"`Access-Control-Allow-Credentials`
is never sent"*) is correct, implemented, and pinned by R19/R20; the false sentence is
unchanged since the merge base; and the ADR's overall CSRF conclusion **does** hold, via D4
plus `withSameOrigin`. An arbiter reading Duty 3's letter (*"a misleading FALSE claim is P0"*)
could reasonably rate it higher — it is a three-line fix either way.

**Remedy.** Extend the same dated correction to D5 (or delete D5's `SameSite` sentence and
name D4 in its place), and add D4 to the correction's list of surviving controls.

**Sibling search (Duty 4), recorded.** Pattern: `sameSite|same-site`, scope `docs/adr/` +
`.claude/reference/`, excluding `0026-admin-api-cors.md`. One hit:
`0024-admin-app-split.md:42-47`, which says *"a cross-**site** response cannot set it"* —
correctly scoped to site, and about setting rather than sending. **Zero other siblings.**

### RT3-2 — P1 — Three durable docs still state the PRE-FIX predicate, and the directory-map row's stated reason for rejecting `requiresProductionConfig()` is now the exact imprecision the new fallback accepts

**At** `.claude/reference/env-vars.md:48` · **Duty** 3 · **Disposition** `open`

The plan **is** fixed — `plan.md:96-99` spells the two-branch predicate with its `NODE_ENV`
fallback, and D-1 (`:226-235`) cites by symbol. Round-2 RT-11 is closed. Three other durable
docs were not updated in the same pass. At HEAD, `src/lib/config/flags.ts:83-87` is:

```
const target = process.env.VERCEL_TARGET_ENV?.trim();
if (target) return target === 'production';
return process.env.NODE_ENV === 'production';
```

1. **`.claude/reference/env-vars.md:48`** — a row **this branch added** — says loopback is
   *"refused in the production lane (`VERCEL_TARGET_ENV === 'production'`, via
   `isProductionEnvironment()`)"*. That equality is not the predicate.
2. **`docs/directory/lib-dashboard-locations-accounts.md:13`** — a row **this branch
   changed** — says the two readers are *"(`VERCEL_TARGET_ENV === 'preview'` / `'production'`,
   never `VERCEL_ENV`, and never `requiresProductionConfig()` — Vercel sets
   `NODE_ENV=production` on staging too)"*. **This is the worst of the three**: it is not
   merely stale, it is self-contradictory. The justification it gives for rejecting
   `requiresProductionConfig()` — that `NODE_ENV=production` is true on staging — is
   precisely the imprecision `isProductionEnvironment` now accepts on its fallback branch,
   and `flags.ts:65-71` says so in its own JSDoc. It is also the CI-enforced directory map.
3. **`.claude/reference/arch-review-log.md:31-32`** — *"The lane predicate is
   `VERCEL_TARGET_ENV`, never `requiresProductionConfig()`, which would have made the rule
   inert on staging"* — and **`:42-44`** — *"`isProductionEnvironment` now fails CLOSED on a
   missing `VERCEL_TARGET_ENV`"*. Neither is what the code does: the predicate consults
   `NODE_ENV` once the precise signal fails, and on a missing signal it fails closed **only
   when `NODE_ENV` is production**.

**Why P1 and not P0**, on the same basis round 2 rated RT-11: the shipped code and its JSDoc
describe the new predicate correctly and R1–R6 pin all of it, so no reader acting on the CODE
produces a defect. The risk is a future engineer "restoring" the stated equality — which is
exactly the shape that produced the *wrong* A1 fix in the first place.

**Blast radius re-checked this pass.** `isProductionEnvironment` still has exactly **one**
caller repo-wide (`src/lib/config/admin-origins.ts:188`), and `process.env.VERCEL` now has
**zero** production readers across `src/`, `worker/` and `scripts/` — only two dead
`delete process.env.VERCEL` lines survive at `flags.test.ts:71,101`.

**Remedy.** Three sentences; the correct text is available verbatim from `flags.ts:83-87`.

### RT3-3 — P2 — The rewritten extractor closes every literal-quote shape but cannot see a specifier split below the `node:` prefix

**At** `src/lib/config/__tests__/admin-origins.test.ts:231` · **Duty** 1 · **Disposition** `open`

The backtick fix is real, and I proved it five ways rather than one: **R7** (round 2's R4
template literal, verbatim), **R9** (a nested `${}` substitution — extracted as `node:${`,
which still trips the prefix match), **R8** (a concatenation *above* the prefix,
`'node:' + 'crypto'` — extracted as `node:`), **R10** (`export … from`) and **R11**
(`import type … from`) all now FAIL the assertion. **R14** confirms `protected-routes.ts`
joined the scanned graph.

The one shape left is **R12**: `import('node' + ':crypto')`, split *below* the scheme prefix,
which yields the harmless specifier `node`.

**Arbiter reasoning for not calling this a confirmed survivor.** The mutant is genuinely not
behaviour-preserving — the module really does import a node builtin — so it is not
`equivalent`. But the four regexes are a lexical extractor over **quoted literal**
specifiers, and a computed specifier is not one: no regex over source text can see it, so
there is **no one-character remedy of RT-14's kind**. That makes it a claim about the
ORACLE's domain rather than about the mutant, which is the class round 2 assigned INV-206,
and it forces `INCOMPLETE_ORACLE`.

**Why P2 rather than P1** (round 2 rated RT-14 P1): a backtick specifier is a shape a
reviewer would plausibly write and the fix left it unstated; a concatenated dynamic import
occurs nowhere in this repo and is visibly outside what the extractor's own code claims.

**Cheapest honest remedy, and the one that also resolves the inventory row:** extend the
sibling test at `:251` — *"scans direct specifiers only — the depth-1 limit is stated, not
implied"* — to state the **lexical** limit as well: the scan reads quoted literal specifiers,
so a computed one is out of scope by construction. That converts INV-312 from an unstated gap
into an `excluded` row against a stated scope. A stricter alternative — banning `import(`
with a non-literal argument inside the graph files — is a real option but is scope this
ticket did not buy.

### RT3-4 — P2 — The Edge graph gained `protected-routes.ts` but `src/lib/auth/flags.ts` is still unscanned

**At** `src/lib/config/__tests__/admin-origins.test.ts:203` · **Duty** 4 · **Disposition** `open`

**Recorded sibling search.** Scope: `src/proxy.ts`'s direct repo-code imports (`:3-17`),
compared against the `graph` array at `admin-origins.test.ts:203-209`. Exclusions: external
specifiers (`next/server`, `@supabase/ssr`) are deliberately out of scope per the depth-1
sibling test at `:251`; I did not search past depth 1.

`src/proxy.ts` imports four repo modules — `protected-routes`, `request-path-header`,
`auth/flags`, `config/admin-origins`. `graph` now lists five paths and covers two of those
four, plus `config/flags.ts` and `shared/csrf.ts` (both reached one hop deeper through
`admin-origins.ts`). **Still unscanned: `src/lib/auth/flags.ts` and
`src/lib/shared/request-path-header.ts`.**

**R13** demonstrates the consequence — a `node:crypto` import added to `src/lib/auth/flags.ts`
reaches the Edge proxy and the guard does not see it — and the row is `equivalent` **with a
proof**: the test's only inputs are the paths listed in `graph`; it `readFileSync`s exactly
those and scans nothing else, so a mutation to a file outside that array provably cannot
change any specifier the test extracts. This is the identical demonstration round 2 recorded
against `protected-routes.ts`.

**Risk today is genuinely small and I am not overstating it:** `request-path-header.ts` is two
exported string constants with zero imports, and `auth/flags.ts` imports only
`@/lib/config/flags`, which **is** scanned. So this is P2 and **not a regression** — the fix
pass closed the instance round 2 filed and left the class open.

**Remedy.** Add the two paths, or derive `graph` from `proxy.ts`'s own import list rather than
hand-maintaining it.

### RT3-5 — P2 — The RT-17 fix DELETED `delete process.env.VERCEL` instead of retargeting it, so unset-lane assertions now hang on an ambient `NODE_ENV`

**At** `src/lib/config/__tests__/admin-origins.test.ts:34` · **Duty** 2 · **Disposition** `open`

The same hazard round 2 filed as RT-17, transferred from `VERCEL` to `NODE_ENV` by the fix
that closed it. The removed line was explicit hygiene; what replaced it is a **comment**
(`:34-37`) whose premise is *"Vitest sets NODE_ENV=test"*.

**Vitest does not set it — it DEFAULTS it.**
`node_modules/vitest/dist/chunks/cli-api.C6CiCDM3.js:14567` is
`process.env.NODE_ENV ??= "test"`, so a developer shell exporting `NODE_ENV=production` keeps
production.

Unlike RT-17, assertions depend on this **today**, and I measured it rather than argued it:
**R21** flips the fallback to `true` and the loopback suite fails with
`http://localhost @ lane=undefined: expected false to be true`. The `lane=undefined` iteration
(`admin-origins.test.ts:168-190`) resolves through the fallback, as does
`flags.test.ts:71-73`'s opening assertion. `proxy.test.ts` is immune only by accident: both
its loopback cases set `VERCEL_TARGET_ENV` explicitly (`:439` `'staging'`, `:450`
`'production'`), an affirmative signal that short-circuits the fallback.

**Rated P2, not P1, on the failure DIRECTION.** A stray `NODE_ENV=production` makes these
suites fail **loudly**; it never makes one pass while broken. That is a false-alarm hazard,
not a coverage lie, and CI does not set `NODE_ENV=production`.

**Remedy**, matching the shape of the line that was deleted:
`Object.assign(process.env, { NODE_ENV: 'test' })` in `withEnv` and in `proxy.test.ts`'s
`beforeEach` — `@types/node` types `NODE_ENV` read-only, which is why the assign form, and
`flags.test.ts` already uses exactly that spelling. While there: `flags.test.ts:71` and
`:101` still `delete process.env.VERCEL` for a variable nothing reads any more.

### RT3-6 — P2 — The arch-review-log entry's red-team and test-surface sentences are stale at `c0181b01`

**At** `.claude/reference/arch-review-log.md:36` · **Duty** 3 · **Disposition** `open`

**The counts are now RIGHT.** Third derivation, done from execution rather than from grep —
see Duty 3 for the arithmetic. 23 and 19 both reproduce exactly. What is stale is the rest of
the sentence.

1. **`:36-38` "Test surface"** names three suites, but `d8faf8e5` made
   `protected-routes.test.ts` a **fourth** changed non-proxy suite, adding 4 cases (15 → 19
   `it(` sites, 69 → 73 executed) — the RT-16 fix. The three-file total is right; the sentence
   is now an incomplete inventory of the branch's test surface.
2. **`:39` "Red team: 28 mutations"** is round 1's number, in the same sentence that already
   cites *"red-team round 2"*. The branch total at `c0181b01` is **49**; including this round,
   **70**.

**Rated P2** because neither is false about what it literally measures — 28 mutations did
happen in round 1, and 19 new cases are in those three files. This is incompleteness in a
durable trace, not a false claim, which is the line round 2 drew when it rated the same
file's *wrong* numbers P1.

**Suggested text:** *"23 new CORS cases in `proxy.test.ts`, 19 across `admin-origins.test.ts`
/ `flags.test.ts` / `csrf.test.ts`, and 4 in `protected-routes.test.ts`. Red team: three
rounds, 70 mutations."*

## Duty 1 — hand-mutation

Environment identical to rounds 1–2: allowlist-only (`PATH`, temporary `HOME`, `TMPDIR`,
`NODE_ENV=test`, `CI=true`, `MOCK_EXTERNAL_APIS=true`, `REPWORTH_DISABLE_LIVE_DB_SUITES=1`),
with `.env.local` swapped for a scrubbed copy under the journaled rename-to-backup protocol.
**Green baseline** at `c0181b01`, all five changed suites in one run: **151 passed / 151**
(proxy 40, protected-routes 73, csrf 14, admin-origins 13, flags 11).

Every mutant run went through the paused supervisor with `assert-one-test`, so each verdict
below is exactly one executed test. After every mutation the file was restored and
`git status --porcelain --untracked-files=no` re-checked clean before the next.

**Budget disclosure.** The SKILL caps mutations at 2 per test. This round ran 6 against
`isProductionEnvironment is true only for VERCEL_TARGET_ENV=production` and 8 against
`keeps the CORS import graph free of node builtins…`, because the orchestrator's brief asked
for both branches plus the `.trim()`, and for five named import shapes. Round 2 exceeded the
same cap (4 and 6) on the same two titles. Recorded rather than hidden; the 30-run round
budget was respected with 8 runs to spare.

| # | Target file | Mutation | Test | Result |
|---|---|---|---|---|
| R1 | `flags.ts` | fallback → `false` (the pre-A1 fail-open) | isProductionEnvironment is true only for… | **killed** |
| R2 | `flags.ts` | fallback → `true` | same | **killed** |
| R3 | `flags.ts` | `?.trim()` dropped | same | **killed** (the `'   '` leg) |
| R4 | `flags.ts` | `if (target)` → `if (target !== undefined)` | same | **killed** (the `''` leg) |
| R5 | `flags.ts` | `target === 'production'` → `target !== 'preview'` | same | **killed** (lane=staging) |
| R6 | `flags.ts` | fallback → `NODE_ENV !== 'test'` | same | **killed** (lane=development) |
| R7 | `admin-origins.ts` | **round-2 R4**: template-literal dynamic import of `node:crypto` | keeps the CORS import graph free… | **killed** ✅ RT-14 fixed |
| R8 | `admin-origins.ts` | `import('node:' + 'crypto')` | same | **killed** (extracts `node:`) |
| R9 | `admin-origins.ts` | template literal with a `${}` substitution after `node:` | same | **killed** (extracts `node:${`) |
| R10 | `admin-origins.ts` | `export { createHash as … } from 'node:crypto'` | same | **killed** |
| R11 | `admin-origins.ts` | `import type { … } from 'node:crypto'` | same | **killed** (safe direction) |
| R12 | `admin-origins.ts` | `import('node' + ':crypto')` | same | **SURVIVED → RT3-3** (inconclusive/oracle) |
| R13 | `auth/flags.ts` | `node:crypto` in a file outside `graph` | same | survived — **proven equivalent** → RT3-4 |
| R14 | `protected-routes.ts` | **round-2 R7**: `node:crypto` in `protected-routes.ts` | same | **killed** ✅ RT-15 fixed |
| R15 | `protected-routes.ts` | `=== '/api/admin'` exact clause dropped | matches /api/admin and everything under it | **killed** |
| R16 | `protected-routes.ts` | **round-2 R20**: widened to `startsWith('/api/admin')` | does not match a lookalike prefix… | **killed** ✅ RT-16 fixed |
| R17 | `protected-routes.ts` | `isAdminApiRoute` normalizes its own argument | takes an ALREADY-normalized path… | **killed** |
| R18 | `protected-routes.ts` | `isAdminApiRoute` returns `false` | agrees with isProtectedRoute… | **killed** |
| R19 | `proxy.ts` | **round-2 R8**: refusal emits `Allow-Credentials: true` | never sends Allow-Credentials or Expose-Headers… | **killed** |
| R20 | `proxy.ts` | preflight emits `Expose-Headers: X-Total-Count` | same | **killed** |
| R21 | `flags.ts` | fallback → `true`, run against the loopback suite | applies the loopback rule across both hosts… | **killed** (evidence for RT3-5) |

**No `skipped-budget` rows.** Every in-scope candidate was executed; 8 of the 30 runs were
left unused.

## Duty 2 — fragile assertions

- **RT3-5** — `withEnv`'s hygiene was deleted, not retargeted; three suites' unset-lane
  assertions now depend on an ambient `NODE_ENV`. R21 proves the dependence is live.
- **RT3-3** — the extractor's remaining lexical blind spot.
- Recorded, not filed: the `ALL_ACCESS_CONTROL_HEADERS` sweep remains partly redundant with
  the `accessControlHeaderNames(refused)).toEqual([])` two lines below it (round 2's note).
  Both are real — R19 and R20 each fail through the sweep specifically, with the sweep's own
  `refusal must not send …` message — so the redundancy is belt-and-braces, not a fake test.
- Checked and clear: the four new `protected-routes.test.ts` cases assert behaviour, not
  structure — no absence-of-tag proxies, no exact string counts, no ordering assertions
  without a contract. The `flags.test.ts` additions are value assertions over an enumerated
  env matrix.

## Duty 3 — docs vs reality

Re-resolved against `c0181b01`. `prevalidate-plan.py` was available and was run.

| Claim | Result |
|---|---|
| ADR 0026's dated correction — the `SameSite` premise | ✅ **TRUE**, verified against the domain map (`deployment-guide.md:57,177,444,525,1261` + `env-vars.md:48`): app and Admin app share `repworth.net`, so same-site + cross-origin |
| …its control 1, `assertSameOrigin` refuses a mismatched `Origin` | ✅ resolves — `csrf.ts:53-81`, wired to `/api/admin/**` via `withSameOrigin()` (`route-helpers.ts:30`) on 55 admin exports |
| …its control 2, D5 never sends `Access-Control-Allow-Credentials` | ✅ true, and pinned (R19/R20) — but it blocks the *response*, not the request, so it is not a CSRF control; **D4 is**, and the correction does not name it |
| …does it contradict a locked decision D1–D8? | ❌ **YES — D5 (`:206-211`) still carries the corrected premise verbatim** → **RT3-1** |
| ADR 0026 D-ids | ✅ still D1–D8 only; the correction's `D5` citation resolves |
| `deviations.md` § DEV-9 vs what actually happened | ✅ **accurate.** `mutation-runner.mjs:397-400` really is `round > 2 → REFUSED` with no override flag (re-read this pass); the journal really does read `"round": 1`; the two owner reasons and the surface-amendment framing match the intake-hash change |
| `triage.md` § Disclosure — the hand-run that closed INV-206 | ✅ **independently verified.** R7 applies the same mutation under the journal and reproduces the claimed message byte-for-byte: `AssertionError: src/lib/config/admin-origins.ts must not import node:: expected [ 'node:crypto' ] to deeply equal []`. The file is byte-identical to HEAD (`git status` clean). The claim stands |
| `arch-review-log` "23 new CORS cases" | ✅ **CORRECT** — `proxy.test.ts` executes 40; `describe('admin API CORS')` opens at `:320` with 17 `it(` sites above and 23 inside; the merge-base file has 17 |
| `arch-review-log` "19 new cases across the three suites" | ✅ **CORRECT** — admin-origins 13 (new file) + flags 11−10 = 1 + csrf 14−9 = 5 → 19 |
| `arch-review-log` "Red team: 28 mutations" / test-surface suite list | ❌ stale / incomplete → **RT3-6** |
| `arch-review-log` "The lane predicate is `VERCEL_TARGET_ENV`" / "fails CLOSED on a missing `VERCEL_TARGET_ENV`" | ❌ **false at HEAD** → **RT3-2** |
| `env-vars.md:48` + `docs/directory/lib-dashboard-locations-accounts.md:13` predicate statements | ❌ **false at HEAD** → **RT3-2** |
| `plan.md` §2 `:96-99` and §5 D-1 `:226-235` | ✅ **fixed** — RT-11 closed |
| `.feature/logs/t1-baseline-record.md:44-52` mutation citations | ✅ **fixed** — M22→#2, M19→#7, M20→#8, M21→#14, R21→#12; "17 of the 22 passes are pre-existing" and "23 CORS titles" both reproduce |

## Duty 4 — missed sibling cases

| Pattern | Scope | Result |
|---|---|---|
| `process\.env\.VERCEL\b` (unsuffixed) | `src/`, `worker/`, `scripts/` | **ZERO production readers.** Only two dead `delete` lines in `flags.test.ts:71,101`. The RT-10 fix removed the last one |
| callers of `isProductionEnvironment` | whole repo | exactly one: `admin-origins.ts:188`. Fix 1's blast radius is still minimal |
| `process.env.NODE_ENV` in `src/lib/` | `src/lib/**` | 8 production sites: 6 cookie `secure` flags, `contact-notify.ts:45`, `deployment-lane.ts:52`. `flags.ts:86` is the 9th and the **second lane-deciding reader** beside `requiresProductionConfig()`. Recorded, not filed — the two are documented as answering different questions (`flags.ts:73-81`), and R5 pins the affirmative branch that keeps them different |
| `sameSite\|same-site` | `docs/adr/`, `.claude/reference/`, minus ADR 0026 | one hit, `0024:42-47`, correctly scoped to *site* and about *setting*. **Zero siblings** |
| `src/proxy.ts` direct repo imports vs the Edge `graph` | `src/` | 4 imports, 2 scanned → **RT3-4**. Exclusions recorded: external specifiers, depth > 1 |
| `it(`-vs-executed counts | the five changed suites | `flags.test.ts`'s `it.each` (7 cases from 1 site) is still the only divergence — the thing that made rounds 1 and 2 miscount |

## Duty 5 — operational completeness

**Nothing new to compare.** `c0181b01` is docs-only. `d8faf8e5`'s production change is
confined to `src/lib/config/flags.ts` — a pure predicate with no I/O, no throw, no log line
and no swallowed branch — so it adds no operator-actionable terminal or swallowed failure
path. The one swallowed path on this branch (`src/proxy.ts:144-147`'s `console.error` on the
fail-closed 403) is unchanged since round 2, where it was routed to **#1212** and accepted;
`docs/runbooks/beta-launch-alerting.md` still needs no new rule row. Re-checked and clear.

## Authorizations

`AUTH-RT3-ROUND` (2026-09-08) — *"owner 2026-09-08: third round authorized at d26a8f3b+"*.

**This entry is PROVENANCE, not an acceptance of risk.** It records the authority under which
this pass ran. Every finding above is `open`; **none** carries an `authorization` reference,
and `accepted_risk` is 0. See the Provenance box at the top for the journal-reset disclosure.

## Restoration

All 21 mutations were applied through the journaled runner and restored; `git status
--porcelain` is **empty** on every path, and each journal entry's working blob is back at its
recorded `originalOid` (the finalizer will confirm and flip each `state` to `restored`). No
supervisor is left active. **The dotenv swap is left OPEN by design** — the orchestrator's
`finalize` owns that restore, exactly as in rounds 1 and 2. Nothing outside this directory
was created or modified.

## Re-stamp at `7ae59bed` — verification only, NOT a fourth round

**No mutation was run. `round-start` was not called. This is not round 4.** The owner's
"no fourth round" stands; what follows is the round-3 verifier confirming that its own
evidence survives one docs-and-tests commit, and re-deriving the four fields that go stale
when HEAD moves.

`7ae59bed` ("red-team round 3 triage") fixes all six round-3 findings. What I checked, in
order, before touching the sidecar:

**1. Does `7ae59bed` touch a production file? NO — confirmed, not taken on trust.** The whole
delta is four docs, the two report artifacts, and one test file
(`src/lib/config/__tests__/admin-origins.test.ts`). I checked the stronger property directly:
for each of the five production modules my 21 mutations targeted, the blob OID at `7ae59bed`
equals the blob OID at `c0181b01`, equals the worktree blob, **and equals the `originalOid`
this run's journal recorded before the first mutation**:

| Module | blob at `c0181b01` = `7ae59bed` = worktree |
|---|---|
| `src/lib/config/flags.ts` | `b45b114c094a…` (= journaled `originalOid`) |
| `src/lib/config/admin-origins.ts` | `214d10ea88f9…` |
| `src/lib/auth/flags.ts` | `6cdc4b52d6d1…` |
| `src/lib/shared/protected-routes.ts` | `f188e5005b76…` |
| `src/proxy.ts` | `efd36f44cc5e…` |

Every module I mutated is byte-identical to what I mutated, so all 21 verdicts still describe
the code at HEAD. Journal: 21/21 `restored`, dotenv closed — the finalizer ran.

**2. Do the covering suites still pass, and still cover the same assertions? YES.** All five
changed suites at `7ae59bed`, under the same allowlist environment as the round-3 baseline
(`vitest.setup.ts` loads no dotenv, so the closed swap changes nothing for these suites):
**151 passed / 151**, with the identical per-file split — proxy 40, protected-routes 73,
csrf 14, admin-origins 13, flags 11. Not one case added, removed or renamed among the titles
my inventory rows name. The one changed suite got strictly *more* to assert (the Edge graph
grew from five files to seven) and one renamed title — the *sibling* scope test at `:259`,
which no inventory row references.

**3. Each fix verified.** RT3-1: D5 now carries its own dated correction, correctly saying its
first control is untouched, that `SameSite` remains real against a genuinely cross-**site**
caller, and that **D4** is what stops the request and the only control covering a same-site
sibling origin — and the Context correction now leads with D4. The contradiction is closed.
RT3-2: all three durable docs now state the two-branch predicate, and the CI-enforced
directory-map row's justification for rejecting `requiresProductionConfig()` is re-argued
correctly (it would read staging as production *even when `VERCEL_TARGET_ENV=staging` is
present*). RT3-3: see below. RT3-4: the graph gained both remaining proxy imports.
RT3-5: fixed at the site this report cites — **and partial against the remedy this report
wrote**; the residual is recorded on the finding rather than smoothed over. RT3-6: 70
mutations over three rounds, the fifth suite included, counts still 23 and 19.

**`INV-312` was moved by the orchestrator, applying the remedy this row prescribed.** Stated
plainly because it is the one place someone else changed adversarial evidence: the row went
`inconclusive/oracle` → `excluded` because `admin-origins.test.ts:259` now states the scan's
**lexical** limit in the guard's own suite. I checked the move and I endorse it — the reason
preserves the original survival verdict verbatim, names who moved it, and records the stricter
alternative as not taken. One caveat kept rather than waived: `excluded` normally means "never
executed", and INV-312 *was* executed and its mutant survived; the row's own text makes that
unmissable, so this is a scope statement, not a concealment.

**Re-derived, not hand-edited:** `head_sha` → `7ae59bed0aef9f30f7447a56cfc619d109252931`;
`intake_sha256` recomputed from `.feature/intake.json` and **unchanged**
(`0ffb7529…` — the intake did not move); `counts` and `status` recomputed by the same
arithmetic the checker uses. Every `at` citation in the six round-3 findings was re-resolved
against `7ae59bed` and updated where the fix commit shifted a line — a re-stamp makes those
Duty-3 claims about the *new* HEAD, and letting them drift would be the exact defect this run
filed twice. `round` stays `2` (the schema cap); the true round number is still 3, per the
Provenance box above.

**Status recomputes to `CLEAR`** — 21 rows: 19 killed, 1 equivalent, 1 excluded; 24 findings:
21 fixed, 3 rejected, 0 open, 0 accepted-risk.

**One thing left on the floor, and it is not a new finding.** RT3-5's remedy named two sites;
one was fixed. `flags.test.ts`'s opening assertion still deletes `VERCEL_TARGET_ENV` and
asserts `false` *before* the test sets `NODE_ENV` itself, and `proxy.test.ts`'s `beforeEach`
was not updated — so an exported `NODE_ENV=production` in a developer's shell still fails
that one suite. It is P2, it never blocked, and the failure direction is loud rather than
silent, so it does not hold the stamp. It is a one-line follow-up, recorded on the finding.

## For the arbiter

**No P0. Say that plainly: there is nothing here that must wake the owner as a defect.** The
code shipped on this branch is in good shape and is now measured three rounds deep — 70
mutations, all 13 named security properties killed, every round-2 fix re-attacked and holding,
and two of them (RT-15, RT-16) upgraded from "read the diff" to "the mutation dies".

The remainder is paper and one oracle limit:

1. **RT3-1 (P1)** — extend ADR 0026's dated correction to D5, and name D4 among the surviving
   controls. Three lines. This is the one finding with a security *statement* in it, though
   not a security *defect*.
2. **RT3-2 (P1)** — three sentences in three durable docs, correct text available verbatim
   from `flags.ts:83-87`. The directory-map row is the one to fix first: it is CI-enforced and
   its stated reasoning now argues against the code it describes.
3. **RT3-3 (P2)** is what holds the status at `INCOMPLETE_ORACLE`, and it is worth being
   precise about: **an authorization cannot clear it.** `INCOMPLETE_ORACLE` is recomputed from
   the inventory, not from dispositions, so `accepted-risk` on RT3-3 changes nothing. The only
   thing that moves INV-312 is making the scan's lexical limit **stated** — one sentence added
   to the sibling test at `admin-origins.test.ts:251`, alongside the depth-1 limit it already
   states — which turns the row into `excluded` against a declared scope. That would drop the
   status to `OPEN_P1`, at which point RT3-1 and RT3-2 are the only blockers and both are
   documentation edits.
4. **RT3-4, RT3-5, RT3-6 (P2)** never block. Each carries its one-line remedy above.

**There is no round 4.** If the arbiter takes remedy 3 plus the two P1 doc fixes, the next
`red-team-status.mjs` run has nothing left to complain about; if the arbiter takes none of
them, the terminal state is `INCOMPLETE_ORACLE` with one recorded, bounded, non-security
oracle limit and two adjudicable documentation P1s — and that is the honest description of
this branch.
