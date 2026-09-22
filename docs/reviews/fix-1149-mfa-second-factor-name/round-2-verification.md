# Round 2 — verification of the round-1 fixes

Branch `fix/1149-mfa-second-factor-name`. Read-only, committed objects only.
`ROUND1_SHA=25bf1b3fda644238778fa1322b3da5055f8e8c30` → `FIX_HEAD=e9cdaa2b12bf84575b66f249d13ca91dea49f000`,
merge-base `75c8d54cb77ac34d1f2f7686b9171528871b81f3`.
Fix diff (tests + docs, `docs/reviews` excluded): 5 files, 118 added / 19 removed.
No tests were run (round-2 constraint); every verdict below is by inspection of the committed tree
plus the installed `@supabase/auth-js@2.106.2` and `fast-check@4.9.0` packages.

## 1. Accepted / partial round-1 findings

| Finding | Verdict | Evidence at FIX_HEAD |
|---|---|---|
| Spec F3 · Std S1 · RT-1149-F1 — the invariant property cannot falsify its invariant | ADDRESSED | `src/lib/auth/__tests__/mfa.test.ts:193-200` (biased arb), `:202-209` (property 1), `:211-225` (property 2) |
| Spec F1 · Codex F2 — start→cancel→start fixture puts an unverified factor under `totp` | ADDRESSED | `src/components/auth/__tests__/useMfaEnrollment.test.tsx:155-164`, `:169`; shape confirmed against `node_modules/.pnpm/@supabase+auth-js@2.106.2/.../dist/main/GoTrueClient.js:4489-4502` |
| Spec F4 · RT-1149-F2 · Codex (e) — provider text reaches the `/sign in again/i` sniff | ADDRESSED | `src/components/auth/useMfaEnrollment.ts:76-88`; test `src/components/auth/__tests__/useMfaEnrollment.test.tsx:256-274` |
| Std S2 — three-deep `mockResolvedValueOnce` queue | ADDRESSED | `src/components/auth/__tests__/useMfaEnrollment.test.tsx:130-133` (comment) + `:158-164` (per-phase re-set); precedent cited at `:73-76` is real |
| Std S3 — the fresh list is discarded under a staleness comment | ADDRESSED | `src/components/auth/useMfaEnrollment.ts:200-203`; claim checked against `:187`, `:273`, `:309` |
| Std S4 — `docs/directory/lib-platform.md` row omits the new export | ADDRESSED (with one stale pointer carried over, N1) | `docs/directory/lib-platform.md:82` |
| Std S5 — titles restate the function name; property not in an `invariants` block | ADDRESSED (the ACCEPTed half) | `src/lib/auth/__tests__/mfa.test.ts:187` (`describe('nextFactorFriendlyName invariants')`); the four locked titles unchanged at `:168`, `:173`, `:179`, `:202` |

### 1.1 The biased arbitrary (check 1)

`existingNamesArb` (`mfa.test.ts:193-200`) is `fc.array(fc.oneof(fc.constantFrom('RepWorth','RepWorth 2'…'RepWorth 5'), fc.string(), fc.constant(null)), {maxLength: 20})`.

- In-sequence density: each element is an in-sequence name with p ≈ 1/3 × 1/5 = 1/15, and `'RepWorth'`
  specifically with p ≈ 1/15. fast-check 4 sets `size: 'max'` when `maxLength` is given and no `size`
  (`defaultSizeToMaxWhenMaxSpecified`), so lengths run up to 20 — per run P(contains `'RepWorth'`) is
  roughly 1 − (14/15)^len, ~50 % at len 10. Over `fc.assert`'s default 100 runs the mutant
  `return 'RepWorth'` is falsified with overwhelming probability at `:206`
  (`expect(existingNames).not.toContain(next)`). D5's "RED at `mfa.test.ts:206`" resolves to that exact
  line. This is a genuine fix for the 0-useful-inputs-in-100 000 measurement of round 1.
- The locked title is verbatim: intake `tests_to_add[3]` = `invariant: nextFactorFriendlyName never
  returns a name an existing factor holds` — identical string at `mfa.test.ts:202`. The three
  non-property titles at `:168`, `:173`, `:179` also still match the intake verbatim, so the
  `promised-tests` grep (D2) is unaffected by the new `describe` wrapper.
- The second property (`:211-225`) is **not** tautological: the oracle is an independent re-derivation
  (regex `/^RepWorth(?: (\d+))?$/` + a loop asserting every smaller sequence member is taken), it never
  calls the implementation twice and shares no code with it. It kills mutants the first property does
  not — e.g. "always append at the end" (skips a gap → some smaller name untaken → RED) and "return a
  name outside the sequence" (regex → RED). One oracle blind spot, trivial: `'RepWorth 1'` parses as
  n = 1 and the loop is empty, so a mutant returning `'RepWorth 1'` would survive both properties
  (it is still killed by the example test at `:174`).

### 1.2 The rewritten fixtures (check 2)

`_listFactors` in auth-js 2.106.2 pushes **every** factor into `data.all` and only
`status === 'verified'` factors into `data[factor.factor_type]`
(`GoTrueClient.js:4489-4502`). Both rewritten fixtures match that:

- `useMfaEnrollment.test.tsx:103-112` — verified `f1` in both `totp` and `all`, unverified `f2` only in
  `all`. Its name (`Old Phone`) is outside the sequence, so this test deliberately does **not** depend
  on the `all` arm; the comment at `:99-102` says so.
- `:158-164` — `totp: []`, unverified `factor-1` only in `all`. **This is the mutation-detecting one:**
  delete the `all` arm of `collectFactors` (`src/lib/auth/mfa.ts:148`) and `existingNames` becomes `[]`,
  so `startEnrollment` sends `RepWorth` and the assertion at `:169`
  (`toHaveBeenNthCalledWith(2, {factorType:'totp', friendlyName:'RepWorth 2'})`) fails. D5's citation
  ("RED at `useMfaEnrollment.test.tsx:169`") is accurate.
- `collectFactors` reads only `totp` + `all`; auth-js also returns `phone` and `webauthn`, but every
  one of those is already in `all`, so nothing is missed.

### 1.3 The `/sign in again/i` guard (check 3)

- **Identical pattern?** Yes, byte-for-byte: `useMfaEnrollment.ts:84` `/sign in again/i.test(text)` vs
  `SecuritySections.tsx:42` `/sign in again/i.test(error)`.
- **Composed string vs raw message.** The guard tests the composed
  `` `Could not start MFA enrollment: ${message}` `` (`:76`, `:84`). That is exactly the string
  `SecurityErrorNotice` receives, so testing the composed form is the correct level. It is also
  behaviourally identical to testing the raw message here: the prefix
  `Could not start MFA enrollment: ` contains no substring of `sign in again`, so no match can straddle
  the join. The difference does not matter today; it would only matter if the prefix were ever reworded
  to end in `…sign in`, which is why the composed form is the safer of the two.
- **Can the mapped messages or the fallback match the sentinel?** No.
  `An authenticator app with this name already exists. Reload the page and try again.` (`:70`),
  `You have the maximum number of authenticator apps. Remove one before you add another.` (`:73`) and
  `Could not start MFA enrollment.` (`:85`, `:89`) contain no `sign in again`. They also return before
  the guard, so even a future reword of those two would bypass it — worth knowing, not a defect today.
- **Does the unenroll 403 still trigger the link?** Yes. That sentence is produced outside
  `enrollmentErrorMessage` (`useMfaEnrollment.ts:291-295`, `Sign in again with your authenticator before
  removing this factor.`), it matches `/sign in again/i`, and both directions are pinned by existing
  tests: `useMfaEnrollment.test.tsx:316` asserts the exact sentence, and
  `src/app/(authenticated)/settings/security/__tests__/SecurityClient.test.tsx:166` asserts
  `isStepUpRequiredError('Sign in again with your authenticator before removing this factor.') === true`.
- **New test strength.** `useMfaEnrollment.test.tsx:256-274` fails if the guard is deleted (the error
  would become `Could not start MFA enrollment: Please sign in again to continue.`). It asserts the
  hook's output string only, not `isStepUpRequiredError(output) === false` — see N3.
- **Residual.** No string containing `sign in again` exists anywhere in the installed `@supabase/*`
  packages, so the guard suppresses a hypothetical GoTrue phrasing rather than a known one; the cost of
  a false positive (a genuinely step-up-shaped enroll refusal being reduced to the generic sentence) is
  therefore low but non-zero. GoTrue signals that case with `insufficient_aal`, not with this wording.

### 1.4 Doc claims (check 4)

- `useMfaEnrollment.ts:200-203` — "the list the UI renders (`state.factors`) is refreshed separately, on
  verify and on unenroll, via `loadFactors()`" is TRUE: `loadFactors` is dispatched at `:187` and called
  at `:273` (after verify) and `:309` (after unenroll), and nothing in `startEnrollment` dispatches
  `loadSuccess`.
- `docs/directory/lib-platform.md:82` — names `nextFactorFriendlyName` in the export list (TRUE,
  `src/lib/auth/mfa.ts:87`) and states the caller obligation "needs a fresh `listFactors()` — a stale
  list can omit a held factor" (TRUE, matches the jsdoc at `mfa.ts:83-85` and the call at
  `useMfaEnrollment.ts:204`). The `factorStatusBefore` trap is still true (`mfa.ts:60-73`).
  The page is exactly 3 000 words, the cap in `src/__tests__/reference-shape.test.ts:86,151-153`
  (`toBeLessThanOrEqual`) — it was already exactly 3 000 at the merge-base and at ROUND1_SHA, so the
  rewrite was budget-neutral and the row still passes. Zero headroom is pre-existing, not introduced.
  The one untrue fragment is the carried-over `:92-103` pointer — N1.

## 2. Defects introduced by the fixes

| ID | Sev | file:line | Finding |
|---|---|---|---|
| N1 | P3 | `docs/directory/lib-platform.md:82` | The rewritten row re-asserts "`src/proxy.ts` skips these, inlining its lenient read (`:92-103`, ADR 0025 D6)". At FIX_HEAD `src/proxy.ts:92-103` is `adminCorsPreflight`; the inline lenient AAL read is `getAalGate` at `src/proxy.ts:260-271`. The stale pointer pre-dates this branch, but the fix's own job was to make this row true and it rewrote that exact sentence, so it is in scope. |
| N2 | P3 | `src/components/auth/useMfaEnrollment.ts:84-86` + `docs/superpowers/plans/fix-1149-mfa-second-factor-name-deviations.md:33` | The guard creates a carve-out in a LOCKED `user_visible_behavior` bullet ("For any other enrollment error with a non-empty message, the page shows: `Could not start MFA enrollment: <Supabase message>`", intake `user_visible_behavior[4]`). The triage sanctioned the behaviour, but D5 records only the pattern duplication as debt; it never names the locked bullet that now has an exception. One sentence in D5 closes it. |
| N3 | P3 | `src/components/auth/__tests__/useMfaEnrollment.test.tsx:256-274` | The duplicated sentinel is unpinned in both directions. The new test asserts only the hook's output literal; nothing asserts `isStepUpRequiredError(hookError) === false`. Change `SecuritySections.tsx:42`'s pattern (say to `/re-?authenticate/i`) and every test here and in `SecurityClient.test.tsx` stays green while the affordance silently re-breaks. The two sides are not even pinned to the same literal today — `SecuritySections.test.tsx:54` uses `Sign in again with your authenticator first.`, the hook emits `…before removing this factor.` |

No P0/P1/P2 defects found in the fix hunks or their direct callers. The production delta is the guard
plus two comments; `nextFactorFriendlyName`, `collectFactors`, the reducer and every other error path
are byte-identical to ROUND1_SHA.

## 3. Do the REJECT / PARTIAL / deferred reasons hold up?

| Row | Holds? |
|---|---|
| Spec F2 · Codex F1 — unverified-factor accumulation, OWNER — DEFERRED TO STAGING | HOLDS — the owner decision, the concrete staging measurement and the PR-blocking condition are recorded in D4 (`…deviations.md:20-26`); nothing offline can settle GoTrue's expiry. The residual risk is real and remains unmitigated in code, which is exactly what D4 says. |
| Std S5 — REJECT the rename | HOLDS — the four titles are verbatim intake strings and D2 records that `promised-tests` greps one literal per title; renaming them would red the gate. The ACCEPTed half (the `invariants` describe block) was applied. |
| Codex (a) — GoTrue's exact/case-sensitive conflict check asserted not evidenced, NOTED | HOLDS — unprovable offline; folded into the same staging ride as D4. The code's own behaviour (exact, case-sensitive `Set` compare, `mfa.ts:88-92`) matches what the intake locked, so the risk is purely about the server's rule. |
| Codex (c) — "Reload the page" advice, REJECT | HOLDS — the sentence is locked verbatim in the intake (`user_visible_behavior[2]`) and the mapped conflict is the recoverable outcome. |
| Codex (f) — numeric suffixes do not identify devices, REJECT | HOLDS — "No user-editable factor name field" is an explicit intake non-goal. |

## 4. Appendix — untriaged observations (new fronts, unchanged code, NOT part of this round's verdict)

- `docs/superpowers/plans/fix-1149-mfa-second-factor-name-deviations.md:31` says "One test beyond the
  intake's list"; there are in fact two (`does not surface provider text…` and
  `invariant: the result is always the first unused name in the sequence`). Cosmetic, disclosed
  elsewhere in the same paragraph.
- `docs/directory/lib-platform.md` sits at exactly its 3 000-word cap (pre-existing at the merge-base):
  the next word added to that page fails `reference-shape.test.ts`.
- The mapped-code branches (`useMfaEnrollment.ts:69-74`) return before the sentinel guard, so a future
  reword of either mapped sentence into something containing "sign in again" would reintroduce the
  round-1 bug without tripping any test.
- Property 2's oracle treats `RepWorth 1` as n = 1, so a mutant returning `RepWorth 1` survives both
  properties (killed by the example test at `mfa.test.ts:174`).

**VERDICT: APPROVED** — all seven ACCEPT/PARTIAL rows are addressed with evidence, the two mutation
claims in D5 resolve to the exact lines cited, and the only new findings are three P3s (one stale doc
pointer, one unrecorded intake carve-out, one unpinned cross-file sentinel).
