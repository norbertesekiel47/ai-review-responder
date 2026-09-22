# Review — Standards & Maintainability

- **Axis:** standards-maintainability (read-only, thermo-nuclear pass)
- **MERGE_BASE:** `75c8d54cb77ac34d1f2f7686b9171528871b81f3`
- **HEAD_SHA:** `25bf1b3fda644238778fa1322b3da5055f8e8c30`
- **Source read:** committed objects only (`git show <sha>:<path>` / `git diff`). The working tree was never read for source.

## Measured diff size

Production (tests and docs excluded), `git diff --numstat MERGE_BASE HEAD_SHA`:

| File | + | − |
|---|---|---|
| `src/components/auth/useMfaEnrollment.ts` | 37 | 3 |
| `src/lib/auth/mfa.ts` | 22 | 0 |
| **Total production** | **59** | **3** |

Non-production in the same range: `src/components/auth/__tests__/useMfaEnrollment.test.tsx` (+142),
`src/lib/auth/__tests__/mfa.test.ts` (+31), `.claude/reference/arch-review-log.md` (+2),
`docs/superpowers/plans/fix-1149-*` (+110). Intake estimate was 45 production / 150 test lines —
production came in 59, test 173. No dependency added (`fast-check` is already a devDependency with
20+ existing call sites, including the cited house-style precedent).

## Method

Checked the diff against `.claude/CLAUDE.md` (architecture invariants 1–15, Working rules,
"Non-obvious gotchas"), `AGENTS.md`, `docs/reviews/finding-checklists/standards-maintainability.md`
(all 30 accepted classes), and the nearest in-repo precedents: the unchanged parts of
`src/lib/auth/mfa.ts` (comment density, docblock shape, export style), the unchanged parts of
`src/components/auth/useMfaEnrollment.ts` (reducer/dispatch semantics, error-copy locality, mock
usage in its test file), `src/app/api/auth/mfa/challenge/route.ts` (the sibling MFA surface's
narrowing style), `src/lib/reviews/__tests__/sentiment.test.ts` (the intake's own cited
property-test house style), and `docs/directory/lib-platform.md:82` (the code-map row that owns
`mfa.ts`). Locked intake decisions (the `RepWorth`/`RepWorth 2` sequence, the fresh `listFactors()`
read, the error-code mapping copy) were treated as settled and are not re-litigated.

---

## Findings

### S1 — [P2] The `nextFactorFriendlyName` property test is near-vacuous: its generator can never produce a colliding name, so the loop it exists to protect is never executed

**File:** `src/lib/auth/__tests__/mfa.test.ts:183-194`
**Standard / smell:** accepted finding class, checklist line 8 — "the totality property is green …
against a real seeded hole"; test that cannot fail for the reason it claims to test. Also
CLAUDE.md Working rules, "Always write tests for …" (a test that proves nothing is not a test).

**Evidence.** The property is:

```ts
fc.property(
  fc.array(fc.option(fc.string(), { nil: null }), { maxLength: 20 }),
  (existingNames) => {
    const next = nextFactorFriendlyName(existingNames);
    expect(existingNames).not.toContain(next);
  },
)
```

`fc.string()` draws from a general character unit; the probability that it emits the exact
8-character literal `RepWorth` (or `RepWorth 2`, …) in any of the ≤20 array slots across the default
100 runs is effectively zero. Therefore on essentially every run `taken.has('RepWorth')` is `false`,
`nextFactorFriendlyName` returns on its **first line** (`mfa.ts:89`), and `let n = 2` / the `while`
loop at `mfa.ts:90-93` — the entire mechanism the ticket exists to add — is never entered. The
assertion `expect(existingNames).not.toContain('RepWorth')` then holds trivially for the same reason.

The consequence is measurable as a surviving mutant: replace the whole body with
`return 'RepWorth';` and this property stays green. Only the three example-based `it()`s above it
(`:168-181`) catch that mutation, so the property adds no detection over them while reading as if it
carries the general guarantee. The intake lists it as a distinct promised test
(`"invariant: nextFactorFriendlyName never returns a name an existing factor holds"`), so its
weight is currently overstated in the evidence trail as well.

**Smallest maintainable correction.** Bias the generator into the name space so collisions actually
occur, leaving the assertion as-is:

```ts
const factorName = fc.oneof(
  { arbitrary: fc.constantFrom('RepWorth', 'RepWorth 2', 'RepWorth 3', 'RepWorth 10', 'repworth 2', 'Laptop'), weight: 3 },
  { arbitrary: fc.option(fc.string(), { nil: null }), weight: 1 },
);
fc.assert(fc.property(fc.array(factorName, { maxLength: 20 }), (existingNames) => { … }));
```

Optionally add a second assertion in the same property — `expect(next).toMatch(/^RepWorth( \d+)?$/)` —
so the property also pins that the function stays inside the locked sequence. No production change.

---

### S2 — [P3] The `mockListFactors` chain couples the new tests to the exact number and order of SDK calls, departing from this file's own precedent for the same mock

**File:** `src/components/auth/__tests__/useMfaEnrollment.test.tsx:120-124` (and the same shape at `:157-159`)
**Standard / smell:** test coupled to a mock's internal call sequence rather than to behavior;
inconsistent with the nearest precedent in the same file.

**Evidence.** The new cancel-and-restart test pre-loads a three-deep `mockResolvedValueOnce` queue
whose correctness depends entirely on `startEnrollment` issuing exactly one `listFactors()` call per
phase — the three inline comments (`// initial load`, `// fresh read before the first
startEnrollment`, `// fresh read before the second startEnrollment`) exist only to explain that
positional coupling. Any refactor that routes the fresh read through `loadFactors()` (see S3), adds a
retry, or dispatches the fresh list into state shifts the queue and turns the test red for a reason
unrelated to the behavior it names.

The same file already establishes the robust pattern for this exact mock: the pre-existing
`runs enroll → challenge → verify` test (`:50-95`) sets `mockListFactors.mockResolvedValue(...)` once
per phase, re-setting it at `:72` immediately before the reload it wants to observe, with no
assumption about call counts. The `mockResolvedValueOnce` chains that do exist in this file
(`:57-58`, `:245`) are on `fetch`, where the request sequence *is* the contract under assertion.

**Smallest maintainable correction.** In both new tests, set `mockListFactors.mockResolvedValue(...)`
before each `act()` block instead of queuing `Once` values, e.g. `mockResolvedValue({ totp: [] })` →
first `startEnrollment` → assert `RepWorth` → `cancelEnrollment()` →
`mockResolvedValue({ totp: [{ …friendly_name: 'RepWorth', status: 'unverified' }] })` → second
`startEnrollment` → assert `RepWorth 2`. Identical coverage, three fewer positional comments, no
call-count assumption.

---

### S3 — [P3] `startEnrollment` reads the authoritative factor list and discards it, leaving `state.factors` knowingly stale with no note saying that is deliberate

**File:** `src/components/auth/useMfaEnrollment.ts:189-195`
**Standard / smell:** two notions of the same truth inside one module; a comment that diagnoses
staleness three lines above code that then preserves it.

**Evidence.** The comment at `:186-188` states the problem precisely — "start → cancel → start leaves
an unverified factor on the server while the hook's loaded state is stale". The fix reads
`listFactors()` fresh at `:189`, normalizes it at `:194` into a full `MfaFactor[]`, extracts only the
names, and drops the rest. After the call the hook holds a freshly-fetched server truth it has thrown
away and continues to render `state.factors`, which it has just proven to be wrong. The hook is
documented at `:152-158` as the *single authoritative implementation* of the flow, and
`normalizeFactor`'s own comment at `:49-52` says these surfaces "must render an unverified factor so
the user can finish or abandon that enrollment" — precisely the factor this read just discovered and
discarded. A maintainer landing here has no way to tell whether the discard is intentional scope
control or an oversight.

**Smallest maintainable correction (comment-only, zero behavior change — preferred, keeps the
intake's `user_visible_behavior` list exact):** extend the existing comment to say the fresh list is
deliberately *not* written into state, and why — e.g. "… and a name derived from stale state would
collide. The fresh list is used only for the name; it is deliberately not dispatched, so this fix
changes no rendered output (#1149 non-goal 3)."

**Alternative if a behavior change is in scope:** dispatch `{ type: 'loadSuccess', factors }` with the
normalized fresh list (`loading` is already `false` at this point, so the reducer's only effect is
replacing `factors`). This gives the hook one owner for the factor list and matches
`normalizeFactor`'s stated intent, but it does render the unverified factor mid-enrollment and so is
outside the locked `user_visible_behavior` — it needs the owner, not this review.

---

### S4 — [P3] `docs/directory/lib-platform.md:82` names `mfa.ts`'s notable exports and their traps; the new export and its caller-obligation trap are absent, and `ci:directory-map` is structurally unable to catch that

**File:** `docs/directory/lib-platform.md:82` (row unchanged by this branch)
**Standard / smell:** CLAUDE.md Working rules — "check `docs/directory.md` (Pages table) + the
folder's `docs/directory/<page>.md` first"; checklist class "docs claim is false / incomplete at
HEAD". The tooling exemption does not apply: `ci:directory-map` enforces *one row per production
file, no stale rows*, and the row exists, so the audit is green while its content has drifted — the
diff does not circumvent the tool, the tool simply does not cover this.

**Evidence.** The row reads: "Supabase AAL helpers — `requireAal2FromSupabase` (lenient) /
`requireCurrentAal2FromSupabase` (strict; …), `factorStatusBefore`, `mfaChallengePath`,
`collectFactors`. **Traps:** `factorStatusBefore` (#468) is read BEFORE `verify`, which flips it …".
The row's established shape is therefore *notable exports + the non-obvious obligation attached to
each*. `nextFactorFriendlyName` is a new public export of that file carrying exactly that shape of
obligation — its own docblock (`mfa.ts:83-85`) says "The caller … is responsible for reading
`listFactors()` fresh before calling this, since a stale list can omit a factor the server already
holds" — and a developer who reads the code map before touching `mfa.ts` (the documented entry
point) will not see it. Mitigating: the row is already non-exhaustive at merge-base
(`normalizeChallengeFactors` is exported and unlisted), so this is about the missing *trap*, not
about an export inventory.

**Smallest maintainable correction.** Append to the row: "`nextFactorFriendlyName` — next unused
`RepWorth`/`RepWorth 2`/… name for a TOTP enroll (#1149); pure, so the CALLER must pass a **fresh**
`listFactors()` read — a cancelled enrollment leaves an unverified factor the hook's state does not
know about." Note the process cost: `docs/directory/lib-platform.md` is not in the intake's
`allowed_edit_surface`, so this needs the same owner-approved surface amendment that D3 took for
`arch-review-log.md`, or a follow-up.

---

### S5 — [P3] Four new `it()` titles restate the function name their `describe` already carries, and the property sits inside that `describe` rather than in the separate invariants block the intake itself cites as house style

**File:** `src/lib/auth/__tests__/mfa.test.ts:167-194`
**Standard / smell:** inconsistency with the file's own style and with the branch's declared
precedent; overlaps deviation D2, which accepted the title text but did not weigh the structural half.

**Evidence.** Inside `describe('nextFactorFriendlyName')`, three titles are
`it('nextFactorFriendlyName returns RepWorth when no factor holds it')`,
`it('nextFactorFriendlyName returns the first unused numbered name and fills a gap')`,
`it('nextFactorFriendlyName ignores null names and names outside the sequence')`, and the fourth is
`it('invariant: nextFactorFriendlyName never returns a name an existing factor holds')`. Every one of
the other 21 `it()`s in this file is a bare behavior phrase with no function name — e.g.
`describe('normalizeChallengeFactors')` → `it('keeps verified factors and projects them to id + label')`,
`describe('factorStatusBefore')` → `it('reports unverified for a factor still mid-enrollment')`. The
reported output therefore reads `nextFactorFriendlyName > nextFactorFriendlyName returns …`.

Separately, the intake's `existing_patterns_to_follow` names
`src/lib/reviews/__tests__/sentiment.test.ts` as "the fast-check invariants describe block (house
style for the property test)". That precedent puts properties in their own sibling block —
`describe('classifySentiment invariants')` at `:45`, with plain titles such as
`it('is deterministic and always tagged with the v1 source')` and `it('score stays in [-1, 1] …')`,
no `invariant:` prefix. The branch nests its property in the function block with the prefix inline,
so the cited pattern is named but not followed.

Root cause is real and documented in D2: the `promised-tests` gate greps each intake
`tests_to_add` string literally, and the intake's strings are written function-name-first. The
tooling constraint and the file style are in conflict only because the *title source* was authored in
the tool's shape.

**Smallest maintainable correction.** Fix the source, not the test: write the intake's
`tests_to_add` entries as the bare behavior phrases (`"returns RepWorth when no factor holds it"`,
…) plus a `nextFactorFriendlyName invariants` block entry, and let the `it()` titles match verbatim
— the grep still passes and the file stays internally consistent. The intake is locked for this run,
so this belongs in the deviations file as an intake-authoring lesson alongside D2 and D3 (a promised
test title must be written in the *test file's* voice, because the audit will freeze it), with the
test titles corrected in a follow-up rather than here.

---

## Explicitly checked and clean

These were examined against the specific questions in the brief and produced no finding:

- **`enrollmentErrorMessage` file and depth (`useMfaEnrollment.ts:58-78`) — correct.** It is
  user-facing UI copy, and the hook's own docblock (`:152-158`) claims ownership of "the flow — and
  its error/notice semantics". `src/lib/auth/mfa.ts` is shared with the server challenge route and
  `src/proxy.ts`, where this copy is meaningless; moving it there would put browser strings in a
  server-reachable auth module for no caller. Private (unexported) is right: its five branches are
  reachable and pinned through `renderHook`, the seam the intake names, and it has exactly one
  caller — the repo's "no abstractions for a single caller" rule cuts against exporting it, not
  against the function. Depth is appropriate: it is a total function over `unknown` that never
  throws, matching the file's other narrowers.
- **The two Supabase error-code literals (`:71`, `:74`) — acceptable as literals.** CLAUDE.md's
  "no string literals" rule enumerates *subscription status, tier IDs, job names, review status* —
  values with a single authoritative TS file in this repo. Provider error codes are not in that set,
  and the established precedent is inline comparison: `PGRST116` (`api/auth/callback/route.ts:117`),
  `23505` (five sites), `40P01` (`lib/approval/http-errors.ts:23`), `'user_not_found'`
  (`lib/onboarding/resend-invite.ts:226`). No SDK-exported code union applies either: the project
  pins `@supabase/supabase-js@^2.106.2`, whose `AuthError.code` is typed as a plain optional
  `string`, so there is nothing to import and a hand-written union would be a second, drift-prone
  copy of the provider's vocabulary. Each literal has exactly one use site and one pinning test.
- **Comment density and content — matches the surrounding code.** `mfa.ts` new block: 13 docblock
  lines over 9 code lines; the file's own neighbours are `factorStatusBefore` (17/12) and
  `collectFactors` (9/15), so the new ratio sits inside the established band. The prose explains
  *why* and gives a worked example (`RepWorth` + `RepWorth 3` → `RepWorth 2`) rather than restating
  the loop; the purity claim and the caller obligation are both facts not derivable from the body.
  The hook's 3-line comment at `:186-188` matches the file's existing 2-line "Routed through the
  server so removal requires a current AAL2 session" note. No restatement of code found in either
  block.
- **Architecture invariants.** #1 (Vercel = UI only): no new heavy runtime import; `listFactors()` is
  a short user-blocking auth SDK call in an already-client module. #8: auth scope untouched. #13/#14:
  no new `NEXT_PUBLIC_*`, no client table access. #12: the hook gained ~14 lines and one 17-line
  named helper, well under the ~30-line extraction threshold, and no route/boot file changed.
  Invariants #2–#7, #9–#11, #15 are not on this diff's surface.
- **Dependency growth: none.** `fast-check@^4.9.0` is a pre-existing devDependency used by 20+ test
  files including three others under `src/lib/`. No new production import in either changed file
  beyond the intra-repo `nextFactorFriendlyName`.
- **Duplication.** `'Could not load MFA factors.'` now appears twice in `useMfaEnrollment.ts`
  (`:173`, `:191`), but the file's pre-existing precedent duplicates
  `'Too many MFA attempts. Try again in a few minutes.'` across the challenge and verify 429 branches
  (`:214`, `:231`). Consistent with the file; not a finding. `normalizeFactors` is reused rather
  than re-implemented for the fresh read — correct.
- **Speculative generality: none.** `nextFactorFriendlyName` takes names, not factors, so it has no
  knowledge of the SDK shape; there is no configurable prefix, no options bag, no exported type for a
  hypothetical second caller.
- **`arch-review-log.md` row.** Cites by symbol and file, not by line number — avoids the stale-citation
  class the checklist flags three times (lines 12, 19). Its claims re-resolve against HEAD: the
  function is in `src/lib/auth/mfa.ts` beside `collectFactors`, no new module/seam/dependency/flag/
  migration exists in the diff, and challenge/verify/unenroll are untouched.

---

## Appendix — observations below the 80% confidence bar (not actionable)

- **`'RepWorth'` appears three times inside the 9-line `nextFactorFriendlyName` body** (`mfa.ts:89`
  twice, `:91` inside the template literal). A local `const BASE_FACTOR_NAME = 'RepWorth'` would make
  a rename single-point, and the repo does prefer named constants for repeated protocol strings
  (`RATE_LIMITS`, `TURN_KEY_CONSTRAINT`, `DUPLICATE_LOCATION_CONSTRAINT`). Against: all three
  occurrences are visible in one screenful, the name is a locked intake decision unlikely to change,
  and `src/components/sections/landing/footer/footer-copy.ts`'s `WORDMARK` is landing-page
  presentation copy that would be a *worse* coupling to import here. Genuinely a judgment call; I
  would not block on it.
- **The new error-path tests do not assert `busy === false` after `setError`.** The `finally`
  dispatching `actionDone` is what keeps the Add-authenticator button usable after a failed enroll,
  and nothing new pins it. This is coverage completeness rather than a standards violation, and it
  belongs to the spec/red-team axes; noting it only so it is not assumed covered.
- **`enrollmentErrorMessage`'s docblock closes with "none of which the enroll error carries
  anyway"**, which slightly undercuts the guarantee the sentence opens with — the branch structure,
  not the provider payload, is what makes the claim true. Rephrasing is cosmetic.
- **Deviation D2's verdict ("no behavior change; the titles now match the intake verbatim") is
  accurate but records only the benefit**, not the style cost that S5 describes. Whether a deviation
  entry must record both sides is a process question for the swarm root, not a code finding.
