# Red team — fix/1149-mfa-second-factor-name (round 1)

- **Mode / risk:** feature / high (`.feature/intake.json`, sha256 `3031ba4d…51769`)
- **Fork ref:** `origin/main` → `75c8d54cb77ac34d1f2f7686b9171528871b81f3`
- **Merge base:** `75c8d54cb77ac34d1f2f7686b9171528871b81f3`
- **HEAD:** `25bf1b3fda644238778fa1322b3da5055f8e8c30` (re-derived; `git merge-base --is-ancestor` holds)
- **Status:** `INCOMPLETE_ORACLE` — one in-scope inconclusive row (oracle class) plus one open P1 on a high-risk run.
- **Generated:** 2026-09-21T16:20:13Z

Re-derived, not trusted: `.feature/gate-status.json` records `passed: true`, `mode: "full"`,
29 green rows, and `gate-fingerprint.mjs check` reports the fingerprint current at HEAD.
All 11 `tests_to_add` titles are present verbatim (grep of the two suites' `it(` strings)
and all 11 pass individually at HEAD (green baselines below).

## Severity table

| ID | Severity | file:line | Finding |
|---|---|---|---|
| RT-1149-F1 | P1 | `src/lib/auth/__tests__/mfa.test.ts:183` | The promised invariant test cannot falsify its invariant — `fc.string()` never draws a name in the RepWorth sequence, so a `return 'RepWorth'` implementation passes it. |
| RT-1149-F2 | P2 | `src/components/auth/useMfaEnrollment.ts:76` | Provider-controlled error text now reaches `isStepUpRequiredError`'s `/sign in again/i` sniff, which can attach a "Verify with your authenticator" link to an enrollment failure. |

No P0. No proven correctness defect in the production change.

## Environment isolation (step 3)

`mutation-runner.mjs env --tmp-home <mktemp -d>` — allowlist only (`PATH`, temporary `HOME`,
`TMPDIR`, `NODE_ENV=test`, `CI=true`, `MOCK_EXTERNAL_APIS=true`, and
`REPWORTH_DISABLE_LIVE_DB_SUITES=1` because no localhost test database was supplied).
`dotenv-swap` swapped `.env.local` for the scrubbed copy for the whole mutation phase and
the finalizer restored it. Preconditions: worktree clean at the committed SHA, `watchers`
reported none, `round-start` opened round 1. Both suites are jsdom unit suites with the
Supabase browser client mocked — no live DB, no network. Budget spent: 26 launches,
~30s of the 20-minute round budget; no row was skipped for budget.

## Duty 1 — hand-mutation inventory (17 rows)

Direction A = the 11 added test cases. Direction B = reverse-import search on the two
changed production files: `src/lib/auth/mfa.ts` (purely additive — one new export, so the
suite's other `describe` blocks are not candidates) and
`src/components/auth/useMfaEnrollment.ts` (two pre-existing cases now transit the new
fresh-read hunk; the two suites that import the hook are mock-only/type-only).
Every candidate has a green individual baseline at HEAD, and every mutant run reported
exactly one executed test (`assert-one-test`).

| Row | Test | Mutation | Outcome |
|---|---|---|---|
| rt-1149-01 | `nextFactorFriendlyName returns RepWorth when no factor holds it` | M1 — delete the unnumbered first name | **killed** |
| rt-1149-02 | `…returns the first unused numbered name and fills a gap` | M2 — append (`n = taken.size + 1`) instead of gap-fill | **killed** |
| rt-1149-03 | `…ignores null names and names outside the sequence` | M3 — case-insensitive compare | **killed** |
| rt-1149-04 | `invariant: …never returns a name an existing factor holds` | M4a — whole body → `return 'RepWorth';` | **inconclusive (oracle)** → RT-1149-F1 |
| rt-1149-05 | `enrolls a second factor under a name no existing factor holds` | M5 — read fresh, then derive from an empty list | **killed** |
| rt-1149-06 | `re-reads the factor list before enroll…` | M6 — drop the fresh read, use stale `state.factors` (the original bug) | **killed** |
| rt-1149-07 | `does not call enroll when the fresh factor list cannot be loaded` | M7 — keep the error dispatch, drop the `return` | **killed** |
| rt-1149-08 | `shows the name-conflict message…` | M8 — remove the `mfa_factor_name_conflict` branch | **killed** |
| rt-1149-09 | `shows the factor-limit message…` | M9 — remove the `too_many_enrolled_mfa_factors` branch | **killed** |
| rt-1149-10 | `shows the Supabase error message for an unmapped enrollment error` | M10 — remove the `if (message)` interpolation | **killed** |
| rt-1149-11 | `keeps the generic message when the enrollment error has no message` | M11 — `if (message)` → `if (typeof message === 'string')` | **killed** |
| rt-1149-12 | `runs enroll → challenge → verify and reloads factors on success` (pre-existing) | M12 — invert the new guard (`if (!listError)`) | **killed** |
| rt-1149-13 | `reports a rate-limit error without accepting the verification` (pre-existing) | M12 | **killed** |
| rt-1149-14 | `surfaces verified factors from the initial load` | — | excluded (unchanged `loadFactors` path) |
| rt-1149-15 | `maps a 403 on unenroll to the re-authenticate hint` | — | excluded (unchanged, server-routed) |
| rt-1149-16 | `SecurityClient` suite | — | excluded (`vi.mock`s the whole hook module) |
| rt-1149-17 | `SecuritySections` suite | — | excluded (type-only import) |

12 killed / 1 inconclusive / 0 survived-confirmed-P0 / 0 equivalent / 4 excluded / 0 skipped.

### RT-1149-F1 — P1 — `src/lib/auth/__tests__/mfa.test.ts:183`

**The measurement.** Replacing the entire body of `nextFactorFriendlyName` with
`return 'RepWorth';` — the exact negation of the asserted invariant — leaves
`invariant: nextFactorFriendlyName never returns a name an existing factor holds` GREEN.
The other three cases kill that mutant, so the production behaviour is covered; it is the
property test that carries no weight.

**Arbiter reasoning (recorded verbatim in the sidecar).** The mutant is not equivalent, and
the mutated statement is executed on every draw — but its divergence is confined to inputs
containing the literal `'RepWorth'`, and the shipped arbitrary cannot produce one:

- `fc.array(fc.option(fc.string(), { nil: null }), { maxLength: 20 })` produced **0 arrays
  containing `'RepWorth'` in 100,000 draws** (measured this pass; the suite runs
  fast-check's default 100).
- The mutant survives that arbitrary over 100,000 draws.
- A domain-shaped arbitrary
  `fc.oneof(fc.constantFrom('RepWorth','RepWorth 2','RepWorth 3','Laptop'), fc.option(fc.string(), { nil: null }))`
  **kills the mutant after 7 draws** and still passes against the real implementation over
  2,000 draws.

Because the gap is in the test's ability to detect rather than in the mutant, the row is
`inconclusive` / class `oracle` rather than a confirmed P0. The house style the intake
cites (`src/lib/reviews/__tests__/sentiment.test.ts:46`) draws from the real input domain
for exactly this reason. **Behavioural replacement:** keep the assertion, draw the names
from the RepWorth sequence alongside arbitrary strings.

**Consequence:** a high-risk run cannot ship an open P1 —
`red-team-status.mjs` fails until this is fixed (a one-line arbitrary change in a test
file) or the user records an authorization and the disposition becomes `accepted-risk`.

## Duty 2 — fragile assertions

Scanned all 11 added cases plus the two pre-existing cases that now transit the diff.
Checked for the three named shapes — absence-of-tag proxies, exact string counts on
rendered output, order assertions with no ordering contract.

- No absence-of-tag proxy and no rendered-output count assertion exists in either suite.
- The exact-string assertions in rows 08–11 are on UI copy the intake pins verbatim
  (`user_visible_behavior`), i.e. the behaviour under test, not incidental structure.
- `rt-1149-06` depends on the ORDER of `mockListFactors.mockResolvedValueOnce` values.
  That order IS the contract under test (initial load, then one fresh read per
  `startEnrollment`), and M6 proves the ordering is load-bearing — not a fragile assertion.
- The one assertion-quality defect found is RT-1149-F1 above, raised from the duty-1
  measurement rather than from inspection.

## Duty 3 — docs vs reality (re-resolved against HEAD)

`prevalidate-plan.py` was present and was run.

| Claim added by this branch | Verdict |
|---|---|
| `mfa.ts:76-86` docstring — first unused of `RepWorth`, `RepWorth 2`, …, any status | TRUE (`mfa.ts:87-95`) |
| …"Fills a gap (`RepWorth` + `RepWorth 3` → `RepWorth 2`)" | TRUE (proved by rt-1149-02) |
| …"Exact, case-sensitive compare; a null name or a name outside the sequence is ignored" | TRUE (proved by rt-1149-03) |
| …"Pure — no clock, no randomness" | TRUE (no imports, no `Date`, no `Math.random`) |
| …"The caller … is responsible for reading `listFactors()` fresh" | TRUE (`useMfaEnrollment.ts:189`) |
| `useMfaEnrollment.ts:58-62` — "Only the error's `code` and `message` are read" | TRUE (`useMfaEnrollment.ts:63-79`; no secret, QR payload or factor id is read or logged) |
| `useMfaEnrollment.ts:186-188` — "start → cancel → start leaves an unverified factor on the server while the hook's loaded state is stale" | TRUE (`cancelEnrollment` at `useMfaEnrollment.ts:306-308` clears local state only; no server unenroll) |
| ledger — "`startEnrollment` sent the fixed friendly name `RepWorth` on every TOTP enrollment" | TRUE at the fork point (`75c8d54c:src/components/auth/useMfaEnrollment.ts:165`) |
| ledger — "the enroll error's `code`/`message` map to UI text instead of one generic string" | TRUE (`useMfaEnrollment.ts:63-79`, `:202`) |
| ledger — "no new module, seam, dependency, flag or migration" | TRUE (diff touches no `package.json`, lockfile, migration or env registry; `fast-check` is already a devDependency, `package.json:114`) |
| ledger — "challenge/verify/unenroll stay on the server route" | TRUE (`useMfaEnrollment.ts:225-294` unchanged) |
| ledger — "one pure function beside `collectFactors`" | TRUE as prose (same module; the function sits at `mfa.ts:87`, `collectFactors` at `mfa.ts:140`) — no `path:line` is cited, so nothing is stale |
| Supabase "rejects a second factor with a name the user already holds" | NOT VERIFIABLE offline; the intake already records it as staging-only evidence (`risk_reasons[1]`). Not asserted as a repo fact — no finding. |

`prevalidate-plan.py .claude/reference/arch-review-log.md` reports 13 issues (9 unresolved
citations, 4 stale commit refs) — **the identical 13 at the fork point**
(`75c8d54c:.claude/reference/arch-review-log.md`, checked). The branch's paragraph adds no
`path:line` or commit citation and no new issue; grep of the report for `mfa|1149|nextFactor`
matches nothing. Not attributable to this change.
`prevalidate-plan.py docs/superpowers/plans/fix-1149-mfa-second-factor-name-deviations.md`:
**PASS** — its two cited artefacts resolve
(`scripts/ci/__tests__/edit-surface-guard-worktree.test.ts` exists; `aa0435c85` resolves to
a commit).

## Duty 4 — missed siblings

Scope: `src/` and `worker/` at HEAD, excluding `node_modules/`; `__tests__` excluded only
where noted. Patterns and results:

| Pattern | Scope | Result |
|---|---|---|
| `\.mfa\.enroll\(` | `src/`, `worker/` | **1 hit** — `src/components/auth/useMfaEnrollment.ts:197`, the fixed site. No sibling enroll call anywhere (no server route, no worker). |
| `friendlyName:` as an enroll argument | `src/` excl. tests | **1 hit** — the fixed site. No other hard-coded factor name is sent to any provider. |
| `'RepWorth'` string literal | `src/` excl. tests | 24 hits; the only MFA-factor-name use is the new `mfa.ts:89`. The rest are brand/wordmark/product copy (`layout.tsx`, `footer-copy.ts`, `legal/content.ts`, operator wording, `TELEGRAM_BOT_USERNAME` fallback) — different concern, no sibling. |
| surfaces rendering `friendlyName` | `src/app`, `src/components` excl. tests | **1 hit** — `SecuritySections.tsx:94`, `{factor.friendlyName ?? 'Authenticator app'}`: React text, no `dangerouslySetInnerHTML` (grepped: zero occurrences under `src/components/auth`, `settings/security`, `src/app/admin`). The challenge surface renders the parallel `label` at `MfaChallengeForm.tsx:323`, also React text. Invariant "rendered as React text only" holds on every surface. |
| consumers that SNIFF the hook's error string | `src/app`, `src/components` excl. tests | **1 hit** — `SecuritySections.tsx:42` `isStepUpRequiredError`. This is RT-1149-F2. |
| importers of `@/lib/auth/mfa` | `src/`, `worker/` | 13 modules; all import unchanged exports, and the change to `mfa.ts` is purely additive, so none is a regression candidate. |

### RT-1149-F2 — P2 — `src/components/auth/useMfaEnrollment.ts:76`

`enrollmentErrorMessage`'s unmapped branch interpolates the raw Supabase message into the
hook's `error`. `SecurityClient.tsx:71` passes that string to `SecurityErrorNotice`, and
`SecuritySections.tsx:42` decides whether to render the STEP_UP_HREF link by testing the
sentence against `/sign in again/i`. Before this branch the enrollment failure text was a
fixed constant, so that regex could never match it; the diff creates the coupling, and no
test covers it. Whether Supabase Auth ever emits an enroll-path message containing that
phrase was **not** verified in this pass (offline run) — recorded as a P2 coupling, not a
proven defect. Cheapest fix: have the hook set a sentinel for the step-up case instead of
having the presentation layer sniff prose.

## Duty 5 — operational completeness

Scope: operator-actionable terminal or swallowed failure paths the diff adds. The diff adds
two failure paths, both in browser code and both surfaced to the user rather than swallowed:
the fresh-`listFactors()` failure (`useMfaEnrollment.ts:190-193`, user sees
"Could not load MFA factors." and enroll is not attempted — proved by rt-1149-07) and the
enroll failure (`:201-203`, mapped copy). Neither emits a Sentry signal, and neither needs a
rule row: `docs/runbooks/beta-launch-alerting.md` carries one MFA row (`admin-mfa-gate` 500 →
Discord, line 45), which is a server-side Admin API signal this diff does not touch. Both
halves of the alert path are therefore consistent — no emitted signal without a row, no row
without a signal, and no documented facet contradicted. **No finding.**

Observation, not a finding: `startEnrollment` discards the fresh factor list after deriving
the name, so the rendered factor list stays stale until the next `loadFactors()`. The intake
locks that (`non_goals`: no presentation change; `edge_cases[0]` describes the stale state),
so it is out of scope for this pass.

## Restoration

`mutation-runner.mjs finalize` → `reap: every journaled process group is empty (26 recorded)`,
`restored 0 mutated file(s) and 1 dotenv file(s); journal closed` (each of the 13 mutations
was restored and verified immediately after its run, so the finalizer found nothing
outstanding). `git status --porcelain --untracked-files=no` is EMPTY, and the full
`git status --porcelain` shows nothing outside this report directory.

## Authorizations

None recorded.
