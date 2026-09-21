# Review — spec & correctness (security lens)

- **Axis:** spec-correctness, with the security/authorization lens
- **MERGE_BASE:** `75c8d54cb77ac34d1f2f7686b9171528871b81f3`
- **HEAD_SHA:** `25bf1b3fda644238778fa1322b3da5055f8e8c30`
- **Branch:** `fix/1149-mfa-second-factor-name`
- **Measured production diff** (`git diff --numstat`, test files excluded): **2 files, +59 / -3**
  - `src/components/auth/useMfaEnrollment.ts` +37 / -3
  - `src/lib/auth/mfa.ts` +22 / -0
  - (non-production, for completeness: `src/components/auth/__tests__/useMfaEnrollment.test.tsx` +142, `src/lib/auth/__tests__/mfa.test.ts` +31, `.claude/reference/arch-review-log.md` +2, the two plan docs +110)
- **Read method:** every source line read from the committed SHA via `git show <SHA>:<path>` / `git grep <SHA>`; the working tree was never read (live mutation run in progress). SDK facts read from `node_modules/.pnpm/@supabase+auth-js@2.106.2/node_modules/@supabase/auth-js` (read-only).

---

## 1. Contract conformance — what holds

Checked every field of `docs/superpowers/plans/fix-1149-mfa-second-factor-name-intake.json` against the diff.

| Contract field | Verdict | Evidence |
|---|---|---|
| goal | met | `useMfaEnrollment.ts:189-200` reads fresh, derives, enrolls under the derived name |
| user_visible_behavior[0] (`RepWorth`, `RepWorth 2`, … first unused, any status) | met | `mfa.ts:87-95`; `collectFactors` (`mfa.ts:140-152`) gathers `totp` **and** `all`, and `normalizeFactor` keeps every status (`useMfaEnrollment.ts:21-48`) |
| user_visible_behavior[1] (zero factors → `RepWorth`) | met | `mfa.ts:88-89` |
| user_visible_behavior[2] (`mfa_factor_name_conflict` copy) | met, string byte-exact | `useMfaEnrollment.ts:69-71` |
| user_visible_behavior[3] (`too_many_enrolled_mfa_factors` copy) | met, string byte-exact | `useMfaEnrollment.ts:72-74`; see F2 for the copy's actionability |
| user_visible_behavior[4] (message passthrough, generic fallback) | met | `useMfaEnrollment.ts:75-78` |
| invariants[0] (name ≠ any name the fresh list returned) | met | `mfa.ts:88-94` builds `taken` from exactly that list and returns the first miss |
| invariants[1] (pure, no clock/randomness) | met | `mfa.ts:87-95` — `Set`, `while`, template string; no `Date`, no `Math.random` |
| invariants[2] (only `code`/`message` reach UI state) | met | `useMfaEnrollment.ts:63-79` reads only those two keys; no `console.*` anywhere in the file; the secret/QR are dispatched on the **success** branch only (`:207-214`) and the error branch cannot see them |
| invariants[3] (rendered as React text) | met | `SecuritySections.tsx:56` renders `{error}` as a child of `<p role="alert">`; no `dangerouslySetInnerHTML` in either consumer |
| invariants[4] (no new direct Supabase MFA call besides the fresh `listFactors()`) | met | diff adds exactly one call, `useMfaEnrollment.ts:189`; challenge/verify/unenroll still `fetch('/api/auth/mfa/challenge')` (`:225`, `:239`, `:270`) |
| edge_cases[0] (start→cancel→start) | met in production code, **under-proven by its test** — see **F1**; consequence at n>2 — see **F2** |
| edge_cases[1] (`RepWorth` + `RepWorth 3` → `RepWorth 2`) | met | asserted at `mfa.test.ts:175` |
| edge_cases[2] (null / out-of-sequence names ignored) | met | `mfa.ts:88` filters null; `taken.has` is exact |
| edge_cases[3] (fresh read fails → no enroll) | met | `useMfaEnrollment.ts:190-193` returns before `enroll`; asserted `useMfaEnrollment.test.tsx:157-171` |
| edge_cases[4] (no rename of a legacy `RepWorth`) | met | nothing in the diff writes a factor name |
| edge_cases[5] (exact, case-sensitive compare) | met | `Set.has`; asserted with `'repworth 2'` at `mfa.test.ts:180` |
| non_goals[0..4] | all respected | no change under `src/app/api/auth/mfa/`, no name input, no cleanup call, no presentation change, `normalizeChallengeFactors` untouched |
| test_seams | both used as specified | `renderHook` + mocked `createBrowserSupabaseClient`; `nextFactorFriendlyName` exported from `src/lib/auth/mfa.ts` |
| tests_to_add (11) | **11/11 present, titles verbatim** (D2 self-correction confirmed) | `mfa.test.ts:168-193`, `useMfaEnrollment.test.tsx:98-238` |
| allowed_edit_surface | respected | 7 files touched, all listed (ledger added by the D3 surface amendment) |
| estimated_prod_lines 45 | 59 measured | within tolerance for the small lane; not a finding |
| dependencies_added [] | respected | `fast-check` already a dependency (`package.json:114`), already used by `src/lib/reviews/__tests__/sentiment.test.ts:1` |

### SDK facts verified against the installed package

- `AuthError.code` exists and is a `string | undefined` — `dist/main/lib/errors.d.ts:18-24`. So `typeof record?.code === 'string'` is the right probe, and `AuthApiError` (the shape a GoTrue rejection produces) extends it.
- Both mapped codes are real members of the `ErrorCode` union — `dist/main/lib/error-codes.d.ts:6` lists `'too_many_enrolled_mfa_factors'` and `'mfa_factor_name_conflict'`. **This matters**: the mapping tests feed the same literals the production code compares, so a typo'd code would have been invisible to the suite; the package confirms both strings.
- `listFactors().all` **does** include unverified factors, and `.totp` **does not** — `dist/main/GoTrueClient.js:4489-4502`:
  ```js
  for (const factor of user?.factors ?? []) {
      data.all.push(factor);
      if (factor.status === 'verified') { data[factor.factor_type].push(factor) }
  }
  ```
  The production code is therefore correct (it reads both arrays). The **test fixtures are not** — see F1.
- `listFactors()` is a genuine fresh read: `_listFactors` calls `this.getUser()` (`:4485`), which round-trips `GET /user`, rather than reading cached session state. The intake's "fresh" claim holds at the SDK level.

### Security lens — findings and non-findings

- **Trust boundary / server authority:** unchanged. The one new call is a read of the caller's own factor list; every state-changing MFA action still terminates on `/api/auth/mfa/challenge`, which owns the rate limits (`route.ts:23`), the current-AAL2 gate on unenroll (`route.ts:244-258`) and the audit sink. No new route, no new privilege.
- **Secret/QR/token leakage into an error string or log:** none reachable. `enrollmentErrorMessage` is handed `enrollError` only; the `data` object carrying `totp.secret` / `totp.qr_code` is never in scope on that branch; the hook logs nothing.
- **Provider error text rendered:** as React text only (`SecuritySections.tsx:55-57`), so no injection. It *is* pattern-matched, which is F4.
- **Staleness / race on the fresh read:** the two-tab and double-click races both converge on the same derived name, and the loser's `enroll` is rejected by the Auth server with `mfa_factor_name_conflict` — which this branch now maps to copy that tells the user to reload. The race is real, bounded, and the branch's own mapping is its remedy. The in-tab double-click is additionally blocked by `disabled={busy}` (`SecurityClient.tsx:88`), committed before the first `await`. Not a finding.
- **Unbounded `while` in the name derivation:** bounded by `|taken| + 1`, i.e. by the user's own factor count, which the Auth server caps. Not attacker-influenced. Not a finding.

---

## 2. Findings (≥ 80% confidence)

### F1 — [P2] The branch's headline edge case is guarded by a fixture the real SDK never produces; the `all` arm of `collectFactors` is untested anywhere

- **file:line:** `src/components/auth/__tests__/useMfaEnrollment.test.tsx:125` (fixture) → `src/lib/auth/mfa.ts:148` (the unguarded line)
- **Contract field:** `edge_cases[0]`, `tests_to_add[5]` ("re-reads the factor list before enroll so a cancelled enrollment does not reuse its name")
- **Evidence:**
  - The test's third `listFactors` fixture places an **unverified** factor under `totp`:
    `totp: [{ id: 'factor-1', friendly_name: 'RepWorth', factor_type: 'totp', status: 'unverified' }]`
  - The installed SDK never emits that shape. `dist/main/GoTrueClient.js:4496-4502` pushes every factor to `all` and only `status === 'verified'` ones into `data[factor_type]`. In production an abandoned enrollment appears **only** in `all`.
  - `git grep "all: \[" <SHA> -- src/**/__tests__/**` returns three empty `all: []` arrays and one dedupe fixture. The only non-empty `all` in the tree is `src/lib/auth/__tests__/mfa.test.ts:149`, and that test puts the **same** factor in `totp` and `all` (it asserts de-duplication). **No test in the repository covers a factor that is present only in `all`.**
- **Failure scenario (named surviving mutant):** delete `...(Array.isArray(record.all) ? record.all : []),` from `src/lib/auth/mfa.ts:148`. Every test on the branch and every pre-existing MFA test stays green — including the "re-reads the factor list" test, because its fixture uses `totp`. In production, `nextFactorFriendlyName` then sees an empty name set for a user whose only factor is the abandoned unverified `RepWorth`, derives `RepWorth`, and `enroll` is rejected with `mfa_factor_name_conflict` — **#1149 reproduced for exactly the edge case this branch was written to fix**, with nothing red.
- **Concrete fix:** move the unverified factor to `all` in the `:125` fixture (and ideally add an `all`-only case to `normalizeChallengeFactors`/`collectFactors` in `mfa.test.ts`), so the fixture matches the SDK and the mutant dies.

### F2 — [P2] Each cancel now leaves another abandoned unverified factor server-side, without bound; the intake stops at n=2 and the deviations do not record it

- **file:line:** `src/components/auth/useMfaEnrollment.ts:306-308` (`cancelEnrollment`), consequence surfaced at `:72-74`
- **Contract field:** `edge_cases[0]` (stated only for the first repetition), `non_goals[2]` ("No cleanup of abandoned unverified factors")
- **Evidence:**
  - `cancelEnrollment` dispatches local state only — it issues no unenroll; the intake itself says "cancelEnrollment leaves an unverified factor named `RepWorth` on the server".
  - Before this change the accumulation was self-limiting: the second start reused `RepWorth` and the Auth server rejected it, so at most **one** abandoned factor could exist. After this change each start→cancel cycle successfully enrolls a *new* factor under a *new* name, so the count grows once per cycle from a single button with no confirmation.
  - Supabase Auth caps enrolled factors per user; when the cap is reached `enroll` returns `too_many_enrolled_mfa_factors` (`dist/main/lib/error-codes.d.ts:6`), which this branch maps to *"You have the maximum number of authenticator apps. Remove one before you add another."*
  - Removal is not available to the user in the state that produces the cap from abandoned factors: `src/app/api/auth/mfa/challenge/route.ts:244-258` requires a **current AAL2** session for `unenroll` and returns 403 otherwise; the hook renders that as "Sign in again with your authenticator before removing this factor" (`useMfaEnrollment.ts:275-281`). A user with zero *verified* factors cannot reach AAL2, so the new copy instructs an action the product refuses. The documented exit is the break-glass runbook `docs/runbooks/mfa-factor-reset.md`, i.e. admin intervention.
- **Failure scenario:** an owner opens Settings → Security, presses "Add authenticator app", closes the QR, and repeats while trying to get their authenticator app working. Each attempt banks a factor. On reaching the cap the page tells them to remove one; the Remove button 403s because they have never verified a factor. They cannot enrol MFA at all until support runs the reset runbook.
- **Caveat stated honestly:** the exact cap semantics (whether the server counts all factors or only verified ones) is a GoTrue-side value I could not verify from this repo or the installed SDK; if the cap counts only verified factors the dead end is not reachable, but the unbounded server-side accumulation from one button remains, and it is new on this branch.
- **Minimum expected action (matching the repository's accepted precedent for this class — "intake edge case unmet AND unrecorded"): record the accumulation consequence as a deviation with a reason, or have `cancelEnrollment` unenroll the factor it just created.**

### F3 — [P3] The promised invariant property test is vacuous: its generator essentially never produces a name inside the `RepWorth N` sequence

- **file:line:** `src/lib/auth/__tests__/mfa.test.ts:183-193`
- **Contract field:** `tests_to_add[3]` ("invariant: nextFactorFriendlyName never returns a name an existing factor holds")
- **Evidence:** the generator is `fc.array(fc.option(fc.string(), { nil: null }), { maxLength: 20 })`. `fc.string()` draws arbitrary strings; the probability that any draw equals `'RepWorth'` or `'RepWorth 2'` is effectively zero, so `taken` never intersects the candidate sequence and the property reduces to "an arbitrary `RepWorth N` is not in a list of random strings".
- **Failure scenario (named surviving mutant):** replace the whole body of `nextFactorFriendlyName` with `return 'RepWorth';`. The property test passes on every run. (The three example tests catch that particular mutant, so protection is not zero — but the *invariant* test, which is the one the intake bills as covering the whole input space, contributes nothing.) A subtler mutant it also misses: `let n = 2` → `let n = 1` is only caught by examples, never by the property.
- **Concrete fix:** draw names from a biased generator that includes the sequence, e.g. `fc.oneof(fc.constantFrom('RepWorth','RepWorth 2','RepWorth 3','RepWorth 10'), fc.option(fc.string(), { nil: null }))`, which makes the invariant bite.

### F4 — [P3] Provider-controlled error text now feeds a caller-side regex that decides whether to render the AAL2 step-up link

- **file:line:** `src/components/auth/useMfaEnrollment.ts:76` → `src/app/(authenticated)/settings/security/SecuritySections.tsx:41-42`
- **Contract field:** `user_visible_behavior[4]`; blast radius (`SecuritySections.tsx` is a listed importer)
- **Evidence:** `SecurityErrorNotice` appends a "Verify with your authenticator" link whenever `isStepUpRequiredError(error)` — `/sign in again/i.test(error)` — matches. Its docstring says it exists for exactly one error, the hook's own AAL2 refusal sentence ("Sign in again with your authenticator before removing this factor", `useMfaEnrollment.ts:278`). This branch makes the error string partly provider-authored: `Could not start MFA enrollment: ${message}`.
- **Failure scenario:** a session/reauthentication class rejection from GoTrue whose message contains the phrase "sign in again" (a common phrasing in that family) produces an *enrollment* error line that renders a step-up link. For the user in the canonical #1149 state (adding a *second* factor) the link is merely noise; for a user with no verified factor it routes to a challenge page they cannot satisfy. The coupling is new, is inside the declared blast radius, and is not named in the deviations file.
- **Concrete fix:** have the hook mark the step-up case structurally (a discriminated error kind, or keep the regex but anchor it to the hook's own sentence) rather than pattern-matching a string that now carries third-party text.

---

## 3. Weakened checks (derived by reading the test diff — `pnpm ci:weakened-checks` NOT run)

**Tests removed / skipped / loosened:** **none.** `git diff --numstat` over the two test paths is `142 / 0` and `31 / 0` — additions only. No `.skip`, no `.only`, no `it.fails`, no deleted assertion, no widened matcher anywhere in the range. `git grep "\.skip\|\.only" <SHA>` over the two changed test files returns nothing. **No protection was lost.**

**Can the new tests pass while the promised behavior is wrong?**

| New test | Proves what it claims? |
|---|---|
| `enrolls a second factor under a name no existing factor holds` | Yes. Verified factor under `totp` is the realistic shape; asserts the exact `friendlyName` argument. |
| `re-reads the factor list before enroll…` | **Freshness: yes** — the hook's loaded `state.factors` is empty and the expected name is `RepWorth 2`, so a stale-state implementation fails the assertion. **Payload realism: no** — see F1. |
| `does not call enroll when the fresh factor list cannot be loaded` | Yes. Asserts both `not.toHaveBeenCalled()` and the exact copy. Strong negative test on the new failure path. |
| three error-code mapping tests + the no-message test | Yes for the mapping logic, with one residual risk the tests cannot cover: the literals are supplied by the test itself, so a wrong code string would be invisible. I closed that gap externally against `error-codes.d.ts:6` — both codes are real. |
| `nextFactorFriendlyName` example tests (3) | Yes; they pin `RepWorth`, the gap-fill, and the case-sensitivity. |
| `invariant:` property test | **No** — F3. |

**Negative tests where the change crosses a trust boundary:** present for the fresh-read failure (no enroll) and for every mapped and unmapped provider error. Absent, and worth noting rather than blocking: nothing asserts that the secret/QR cannot reach `error` (unreachable by construction), and nothing asserts the two-tab conflict path end-to-end (the code-mapping test is a reasonable proxy).

**Compromises this change makes that the deviations record does not name** (D1 = gate env var, D2 = test titles, D3 = ledger surface amendment; none cover these):

1. Abandoned unverified factors now accumulate once per cancel, unbounded from one button — **F2**.
2. The `mfa_factor_name_conflict` copy ("Reload the page and try again") is the *only* handling of the two-tab / concurrent-start race; the branch chose detect-and-tell over prevent, which is defensible but is an undeclared design decision.
3. The provider message is now part of a string that a caller regex-matches — **F4**.
4. `startEnrollment` fetches a fresh factor list and then **discards** it — `state.factors` is not refreshed from that read (`useMfaEnrollment.ts:194`), so the surface can render a factor list it already knows is stale. Deliberate minimality (non_goal[3]), but undeclared.
5. Every "Add authenticator app" click now costs an extra `GET /user` round-trip before the QR appears. Negligible, undeclared.

---

## 4. Appendix — non-actionable observations (below the reporting bar or unverifiable read-only)

- **A1.** Whether GoTrue's `/user` response actually carries unverified factors is the single assumption the whole fix rests on. The SDK's own `status === 'verified'` filter (`GoTrueClient.js:4498`) is strong circumstantial evidence that it does, and the intake's `risk_reasons[1]` already names this as staging-only provable. Flagging it as the one thing the staging smoke must genuinely confirm — the smoke as written (two factors listed as `RepWorth` and `RepWorth 2`) does exercise it, and `SecuritySections.tsx:94` does render `factor.friendlyName`, so the observability item is satisfiable as specified.
- **A2.** `if (message)` treats a whitespace-only provider message as non-empty, producing `"Could not start MFA enrollment: "`. `message.trim()` would be strictly better. Cosmetic.
- **A3.** `enrollmentErrorMessage`'s docstring asserts the enroll error carries no secret/QR/factor id "anyway" — true of the shapes I inspected, but it is a claim about a third-party payload rather than about this code. The code's own guarantee (it reads only two named keys) is the load-bearing part and is correct.
- **A4.** `mfa_verified_factor_exists` is another real MFA code (`error-codes.d.ts:6`) that is not mapped; it falls to the message-passthrough branch, which is what `user_visible_behavior[4]` prescribes. Correct by contract, noted only so a future reader does not mistake it for an omission.
- **A5.** `collectFactors` gathers `all`, which on the real SDK includes `phone` and `webauthn` factors. Feeding their names into `taken` is a superset of what a TOTP name conflict needs — conservative and safe, never wrong, occasionally skipping a name it need not. Worth a one-line comment, not a change.
- **A6.** The new property test sits directly inside `describe('nextFactorFriendlyName')`, whereas the cited house style (`src/lib/reviews/__tests__/sentiment.test.ts:42`) groups fast-check invariants under their own commented block. Style only.
- **A7.** `startEnrollment` has `try { … } finally { … }` with no `catch`; a thrown (rather than returned) SDK rejection still escapes to the caller as an unhandled rejection. Pre-existing shape, unchanged by this branch, and `auth-js` returns rather than throws on both calls used here.
- **A8.** The arch-review-log entry (`.claude/reference/arch-review-log.md:3`) cites no line numbers — which is the correct response to this checklist's single most-repeated accepted finding class ("the commit that writes the citation is the commit that moves the target"). Its substantive claims all resolve at HEAD.

---

**VERDICT: REVISE** — on F1 (the headline edge case's fixture contradicts the installed SDK and leaves `mfa.ts:148` mutant-survivable) and F2 (new unbounded accumulation of abandoned factors, unrecorded, with copy that can point at an AAL2-gated action). F3 and F4 are cheap and should ride along.
