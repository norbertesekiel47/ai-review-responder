# Spec & Correctness review — `feat/refusal-lane-vocabulary`

- Worktree: `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-refusal-lane-vocabulary`
- Reviewed diff: `fab6a49cf9e457885b1ead724c2135a04384f2d2..0a21f3528d6c58b04803f0c92277178adc19a20d`
- Reviewer: fresh, independent, read-only. No test suite was run; no file outside this one was touched.

---

## Findings table

| severity | file:line | one-line finding |
|---|---|---|
| MEDIUM | `docs/directory.md:889` | The `vocabulary.ts` row still calls `AUTONOMY_SUSPENDED_REFUSAL_CATEGORIES` "the one lane map this slice ships" and says the file "Holds no code→category map for the other six lanes" — both false after this change, and `ci:directory-map` checks row presence only, so CI stays green on a false doc. |
| MEDIUM | `src/lib/shared/worker-types.ts:134` | The type move's stated justification — "nothing under `src/lib/` imports from `worker/` — no such import exists anywhere in the repository" — is false as written; ~20 files under `src/lib/**/__tests__/` import from `worker/`, one of them a worker *production* module. |
| LOW | `docs/superpowers/plans/feat-refusal-lane-vocabulary-intake.json:20` | `user_visible_behavior` promises a **compile** error for an unmapped new `LatchHaltReason` member; a member added directly to `LatchHaltReason` produces no compile error in `vocabulary.ts`, only a test failure. Neither the intake nor D2 records the downgrade. |
| LOW | `src/lib/refusals/vocabulary.ts:253` | Migration 111's `withheld` arm admits eight codes; the dispatch + render maps between them cover seven. `unsubscribed` has a category in neither map, and `dispatch.ts:146` asserts it is "written by other lanes". |

---

## What I verified, and how

### 1. Harvest fidelity — PASS

`git show feat/refusal-log:src/lib/refusals/vocabulary.ts` compared value-by-value against the five maps in
`src/lib/refusals/vocabulary.ts:213-349`:

| map | parked value set | this branch | verdict |
|---|---|---|---|
| ask (`WithholdReason`) | 6 codes, `velocity_banked: null` | identical | verbatim |
| outreach dispatch | parked had one merged 8-key map | the 6 live keys, same values | verbatim for every shared key |
| outreach render | 3 codes | identical | verbatim |
| batch halted | 6 codes, 4 `null` | identical | verbatim |
| auto-post revoked | 6 codes | identical | verbatim |

Nothing was re-decided. The only value present in the parked map and absent here is `unsubscribed: 'no_permission'`
— see finding 4.

**The `lint_failed` / `moderation_high` question, decided against live code.** The prompt asked whether putting
these two in the *dispatch* map (the parked branch had them only in its render half) is correct.
It is. `src/lib/solicitation/dispatch.ts:149-156` declares the live `OutreachWithheldReason` as exactly the six
keys this map carries, and its own docblock (`:145-148`) says so explicitly. `applyDispatchGate`
(`src/lib/solicitation/dispatch.ts:237-257`) returns `withhold('lint', 'lint_failed')` at item 8 and
`withhold('moderation', 'moderation_high')` at item 9, fed by `SlowGateEvidence` gathered at
`dispatch.ts:503-518` (a re-lint and a re-moderation of the stored copy at send time, fail-closed). So the
dispatch gate really does produce both, the overlap with the render map is real, and the vocabulary comment at
`vocabulary.ts:238-244` describes the mechanism accurately.

### 2. The `null` decisions — PASS (with one appendix note)

- **`velocity_banked` → `null`** (`vocabulary.ts:225`). `WITHHOLD_REASONS`
  (`src/lib/solicitation/restraint-policy.ts:45-53`) lists it last, after the three `wrong_moment` codes; the
  parked branch's own reason cites `BatchReport.tsx` ruling it a bank rather than a hold. A banked candidate
  returns to the pool. Defensible, and it is the only `null` in that lane — the test pins both facts by name and
  by count.
- **`owner_veto` / `owner_halt` → `null`.** `ownerHaltReason` (`approval.ts:129`) derives these server-side from
  batch state on an *owner* request. Crediting them to RepWorth would misattribute the actor. Correct.
- **`send_window_elapsed` / `batch_expired` → `null`.** Both are members of `SystemHaltReason`
  (`approval.ts:121`), the union `approval.ts:92-99` describes as "the THREE Halt latch reasons NO actor can
  cause", two of them "derived from a clock". Migration 091's halt-consistency CHECK forces `halted_by IS NULL`
  for them, and `latchSystemHalt` (`approval.ts:844-852`) passes `actorUserId: null` **and** `audit: null`,
  with the comment "filing a clock there would make the log lie about who acted". The database and the audit
  layer already treat these as actor-less. `null` is consistent with both.
- **`platform_halt` → `autonomy_paused` — genuinely ours, not the clock's.** This is the one that had to be
  argued rather than assumed. `approval.ts:106-114` is explicit: `platform_halt` is *the same*
  `send_window_elapsed` sweep on *the same* 72h clock, and the only thing that distinguishes it is that the
  **Send breaker** was open — a platform-wide decision by RepWorth to stop sending — while the window ran out.
  The clock is the trigger; the breaker is the cause. `autonomy_paused` ("We are not acting on your behalf right
  now") is the honest category, and it is what the parked branch chose. The asymmetry the map comment flags
  (`platform_halt` writes no `account_audit_log` row) is real and correctly described as invisible to the
  category map.

### 3. `| null` presence — PASS

| map | `satisfies` constraint | has a null member? | consistent |
|---|---|---|---|
| `AUTONOMY_SUSPENDED_…` (pre-existing) | `Record<AutonomySuspensionTrigger, RefusalCategory>` | no | yes |
| `ASK_WITHHELD_…` | `Record<WithholdReason, RefusalCategory \| null>` | yes (`velocity_banked`) | yes |
| `OUTREACH_WITHHELD_DISPATCH_…` | `Record<OutreachWithheldReason, RefusalCategory>` | no | yes |
| `OUTREACH_WITHHELD_RENDER_…` | `Record<RenderWithholdReason, RefusalCategory>` | no | yes |
| `BATCH_HALTED_…` | `Record<BatchHaltedRefusalCode, RefusalCategory \| null>` | yes (4) | yes |
| `AUTO_POST_REVOKED_…` | `Record<AutoPolicyDowngradeReason, RefusalCategory>` | no | yes |

Six for six. (The *justification* the header gives for the rule is imprecise — see the appendix.)

### 4. The `LatchHaltReason` non-export — PASS on mechanics, one spec gap

- `src/lib/solicitation/approval.ts` is **byte-for-byte unchanged in this diff**:
  `git diff fab6a49c..0a21f352 -- src/lib/solicitation/approval.ts` produces zero lines. D2's revert is real.
- The composition is **correct and complete today**. `approval.ts:456` reads
  `type LatchHaltReason = OwnerHaltReason | 'admin_halt' | SystemHaltReason;` — character-for-character the union
  `vocabulary.ts` re-spells as `BatchHaltedRefusalCode`. `OwnerHaltReason` = 2 members (`:90`),
  `SystemHaltReason` = 3 (`:121`), plus the admin literal = 6. The map has exactly those 6 keys.
- **The test's source-text read is a real guard, not decorative.** `latchHaltMembers()` reads all three
  declarations out of `approval.ts` and the case asserts `toHaveLength(6)` *and* — via `expectLaneMap` —
  set-equality against the map's keys. So: a 7th member added to `OwnerHaltReason` or `SystemHaltReason` fails
  at **compile** time (both feed `BatchHaltedRefusalCode`) *and* at test time; a 7th added directly to
  `LatchHaltReason` fails this eval on the length assertion, and independently fails
  `src/lib/solicitation/__tests__/approval.test.ts:436-438`, which pins the declaration's exact source text with
  an anchored regex. A rename or a move of any of the three throws a named error out of `unionMembers`. D2's
  "both halves fail if either moves" is accurate.
- **What breaks it silently later:** nothing I could construct within TypeScript. The only residual paths are
  (a) widening the halt vocabulary in migration 091/111 and passing the new literal through a cast without
  touching the TS union, and (b) restructuring `LatchHaltReason` to compose a *third* named union — which fails
  loudly on the length assertion rather than silently. Neither is a defect of this change.
- **The spec gap** is that the intake sells all five enums as compile-time-guarded (finding 3). For four of the
  five that is literally true; for `LatchHaltReason`'s own inline literal it is test-time.

**`unionMembers`'s relaxed `(?:export )?type` anchor — checked, does not match the wrong declaration.** The
pattern is `(?:export )?type <Name>\s*=([^;]*);`. The `\s*=` immediately after the name means a longer
identifier with the same prefix cannot match (`type AutonomySuspensionTriggerX =` fails at the `=`). I grepped
each of the five target modules for a second textual occurrence of `type <Name>` and found none. `[^;]*` cannot
cross a `;`, so each body is bounded to its own declaration, and `quotedMembers` (`/'([a-z_]+)'/g`) picks up
only lower-snake literals — for `LatchHaltReason` that is `'admin_halt'` alone, which is exactly what the
three-way composition needs. The one theoretical weakness is that the anchor is not line-anchored, so a prose
comment containing the literal text `type LatchHaltReason = …;` earlier in the file would win; no such comment
exists, and `approval.test.ts` uses the stricter `(^|\n)` form for the same declaration.

### 5. The type move — PASS on mechanics, FAIL on the stated reason

`AutoPolicyDowngradeReason` now lives at `src/lib/shared/worker-types.ts:144-150` and is re-exported from
`worker/jobs/publisher/auto-policy-downgrade.ts:28` (`export type { AutoPolicyDowngradeReason };`, type-only, so
`isolatedModules`-safe). Every consumer resolves:

- `worker/jobs/publisher/auto-policy-downgrade.ts` `:39` and `:176` — two
  `satisfies Record<AutoPolicyDowngradeReason, string>` marker records — and `:54` (`reason?:`) all bind to the
  imported type.
- `src/lib/refusals/vocabulary.ts:48, :349`.
- No other importer exists (`rg AutoPolicyDowngradeReason` across the repo). Nothing under `worker/` imports it
  from the old path via a *different* specifier, so the re-export is currently unexercised but harmless — it is
  the module naming its own input, as its comment claims.

**The stated reason does not survive grep** — finding 2. `rg` over `src/lib` excluding `__tests__` returns zero
production importers of `worker/` (two comment-only path mentions in `src/lib/reviews/import-consent.ts`), so
the *narrow* claim is true. The appended absolute — "no such import exists anywhere in the repository" — is
false: ~20 test files under `src/lib/**/__tests__/` import `worker/__tests__/helpers/mock-sql`, including
`src/lib/refusals/__tests__/write.test.ts:28` in this very folder, and
`src/lib/solicitation/__tests__/batch-purge-concurrency.integration.test.ts:27` imports the worker **production**
module `worker/jobs/account-offboarding/purge-stages`. The parked branch itself imported
`AutoPolicyDowngradeReason` from `worker/jobs/publisher/auto-policy-downgrade` with `import type`. I also
checked `eslint.config.mjs`: there is no lint rule banning a `src/lib` → `worker` import (the worker-runtime bans
are scoped to `src/app/**`, `src/components/**` and `src/instrumentation.ts`, and allow type imports), so the
convention is the only authority and the comment is its statement of record. The move is still the right call on
`AutonomySuspensionTrigger`'s precedent; the sentence justifying it needs to be narrowed to production code.

### 6. Client safety — PASS

All four import statements in `vocabulary.ts` are `import type` (`:47-53`), and `import type` erases entirely, so
none of `@/lib/solicitation/{approval,dispatch,outreach,restraint-policy}` — all of which pull real runtime
graphs — can reach a browser bundle through this module. There are no `export … from` re-exports, no dynamic
`import()`, and no `require`.

The eval case is a real regression guard: it splits the file and rejects any line matching `/^import\s/` that is
not `/^import type\s/`, which catches both single-line and multi-line value imports (the first line of a
multi-line `import {` still starts with `import `) and bare side-effect imports. Two gaps worth knowing about,
neither present today: a value **re-export** (`export { x } from './y'`) and a dynamic `import()` would both slip
past. Recorded in the appendix rather than the table because the file contains neither and neither is a plausible
edit to a pure vocabulary module.

### 7. The eight promised tests — all present verbatim, and each asserts its title

Compared byte-for-byte against `docs/superpowers/plans/feat-refusal-lane-vocabulary-intake.json`
`tests_to_add`. All eight titles exist verbatim in `src/lib/refusals/__tests__/vocabulary.test.ts`; all are
active `it(` cases, none skipped or `todo`.

| title | does it assert the claim? |
|---|---|
| ask lane maps every `WithholdReason`, `velocity_banked` not a Refusal | yes — `expectLaneMap` against the runtime `WITHHOLD_REASONS` array, plus `velocity_banked` by name **and** a count assertion (`length - 1`) that fails if a future `null` is added anywhere in the map |
| dispatch maps every `OutreachWithheldReason` | yes — parsed from `dispatch.ts`, `toHaveLength(6)`, key-set equality, no `null` |
| render maps every `RenderWithholdReason` | yes — same shape, `toHaveLength(3)` |
| batch: only `admin_halt` + `platform_halt` categorised, other four `null` | yes — filters non-null entries and asserts the pair exactly, plus both categories by name; key-set equality supplies the "other four" half |
| auto-post maps every `AutoPolicyDowngradeReason` | yes — `toHaveLength(6)`, no `null`, and the `judge_disabled`/`judge_unhealthy` pair asserted individually |
| every assigned category ∈ `REFUSAL_CATEGORIES` | yes — sweeps all **six** maps (the five new plus the pre-existing one), with a non-vacuity guard |
| dispatch/render stay separate and agree on shared codes | yes — identity check, key-list inequality, and the shared set pinned to `['lint_failed','moderation_high']` with per-key category agreement |
| `vocabulary.ts` imports no value at runtime | yes, within the gaps noted in §6 |

**`expectLaneMap`'s two documented claims both hold.** Claim 1 ("keys are EXACTLY the members, so an omission and
an invention both fail") is delivered by the sorted array equality at the top, not merely by the `Object.hasOwn`
loop below it. Claim 2 ("every non-null value is a member of `REFUSAL_CATEGORIES`") is delivered by the loop,
which correctly *skips* `null` rather than treating it as missing — the key equality is what proves the null was
decided. The `expect(members.length).toBeGreaterThan(0)` non-vacuity guard is present and matters, because three
of the five member lists come from a regex parse that could silently return `[]`.

No title over-claims relative to what its body asserts. D3's retitle (`share no key` → `agree on the codes they
share`) is correct and necessary — the two maps genuinely share two keys — and was applied to the intake before
the tests were written, so `promised-tests` matching is intact.

### 8. Dead code — no gate is violated

Five exported constants have no production caller until #1010–#1012. I checked the `ci:` surface for anything
that would object:

- `ci:fallow` / `ci:fallow:coverage` run `fallow audit --gate new-only`. Every new export is exercised by the
  eval, so the coverage-fed gate has live data on all of it; the deviations record a pre-arming run returning
  "No issues in 5 changed files".
- `ci:feature-surface` — the audit requires every non-process `allowed_edit_surface` entry to match at least one
  file "tracked at HEAD, **or** in the branch diff". `src/lib/solicitation/approval.ts` is untouched by the diff
  after D2's revert but is tracked at HEAD, so the unused entry does not fail. `docs/reviews/**` and
  `docs/superpowers/plans/**` are inside the always-allowed `docs/**` process surface. Every changed file is
  inside the declared surface.
- `ci:merge-ledger` — satisfied; one row appended to `.claude/reference/arch-review-log.md`.
- `ci:directory-map` — satisfied by presence (no new files under `worker/` or `src/lib/`), which is precisely why
  finding 1 slips through: the audit does not read row *content*.
- `ci:db-imports`, `ci:static-policy`, `ci:env-registry`, `ci:outbox-*`, `ci:tenant-scope`, `ci:rls-audit` — none
  are implicated by a type-only, DB-free, flag-free change.

**The "dead code this repo gates on" sentence the prompt points at is not in `write.ts`.** `write.ts`'s header
(`:1-58`) makes no such claim; it says only that eleven call sites land across #1009–#1013 and nothing varies.
The sentence lived in `vocabulary.ts`'s own pre-change header and **was correctly rewritten by this diff**
(`vocabulary.ts:30-44`), which now states the cost explicitly rather than deleting the claim. The same phrase
survives in two #1008 review/deviation records, which are historical records and correctly left alone. No stale
copy remains in a live file.

### Field-by-field against the intake

| field | verdict |
|---|---|
| `goal` | met — five maps in one file, three downstream edit surfaces now disjoint |
| `non_goals` | respected — no `writeRefusalEvent` call, no `refusalCategoryFor`, no `REFUSAL_CATEGORY_META`, no `policy_gate_held`/`held_draft` map, no migration, no `RENDER_WITHHOLD_REASONS` resurrection, no set-based write arm |
| `user_visible_behavior` | bullet 1 met (no runtime change); bullet 2 met for four of five enums — finding 3 |
| `invariants` | met in substance. Note the literal text says every map is `satisfies Record<Enum, RefusalCategory \| null>`; three maps deliberately narrow to `Record<Enum, RefusalCategory>`. That is a strengthening, and the file explains it, but it is an undeclared departure from the invariant's wording (appendix) |
| `edge_cases` | all five handled as written, **except** the fifth ("`LatchHaltReason` was private. Exporting a type adds no runtime surface") — which the branch correctly abandoned, with D2 as the record |
| `allowed_edit_surface` | respected. Files changed: `src/lib/refusals/{vocabulary.ts,__tests__/vocabulary.test.ts}`, `src/lib/shared/worker-types.ts`, `worker/jobs/publisher/auto-policy-downgrade.ts`, `.claude/reference/arch-review-log.md`, two files under `docs/superpowers/plans/`. All declared |
| `tests_to_add` | all eight present verbatim and substantive |

---

## Low-confidence appendix

Everything below is either a judgement call, an accurate-but-imprecise comment, or an upstream gap this slice
inherited. None of it belongs in the table.

1. **`vocabulary.ts:183-186` states the `| null` rule's *mechanism* imprecisely.** "A lane whose codes are all
   Refusals is typed `Record<Enum, RefusalCategory>`, so an omission cannot type-check as a decision." Under
   `satisfies`, an omitted key is a compile error whether the value type includes `null` or not — the narrowing
   buys you something different and arguably better: an explicit `null` cannot be written where no null decision
   was made. The sentence is defensible on a charitable reading ("an omission *dressed as* a decision"), which is
   why this is not a table finding.

2. **`send_window_elapsed → null` is right for the latch, but the batch it terminalizes may have left no
   Refusal anywhere.** `applyDispatchGate` *defers* (writes nothing) on `batch_open` and `send_flag`
   (`dispatch.ts:241-242`), and `dispatch.ts:145-148`/`:64` record that inventing a `flag_off` withheld reason
   was deliberately rejected. So a batch that sits deferred for 72h because `SOLICITATION_SEND_ENABLED` is off
   then latches `send_window_elapsed` produces zero ledger rows, even though RepWorth's own flag is why nothing
   sent. That is an upstream capture gap (the same class #1001 records for `policy_gate_held`), not a wrong
   `null` in this map, and it is #1010's to notice if anyone's.

3. **The runtime-import eval does not catch a value re-export or a dynamic `import()`.** `export { x } from './y'`
   creates a real module-graph edge and starts with `export`, not `import`. Neither construct exists in
   `vocabulary.ts` and neither is a plausible edit to a leaf vocabulary module, so the guard is adequate for its
   purpose.

4. **`approval.ts:453`'s "all five" is still wrong (six).** D4 records this and defers the one-word fix to #1010,
   which edits the file anyway. Deferring is the right call given D2 removed the file from this branch's diff;
   noted here only so the next reviewer does not re-report it.

5. **Estimates.** `estimated_prod_lines: 120` against ~224 production lines added (the great majority comment
   prose). Not a defect, and the file's comment density is the house style.

6. **The test file's header still says "#1009 slice 2, task T1 (the RED phase)"** and "Every title here is
   VERBATIM from `.feature/intake.json`". The file now carries two slices' cases and the second slice's intake is
   a different file. Cosmetic; the titles are in fact verbatim from this branch's intake.

---

## Verdict

The change does what its intake says, the five maps are faithfully harvested, every `null` is defensible against
the code that produces its code, the `| null` discipline is applied consistently, the type move resolves for
every consumer, `approval.ts` is genuinely untouched, and all eight promised tests exist verbatim and assert what
they claim. The substantive issues are two false-in-writing claims — one in a doc CI does not read
(`docs/directory.md:889`), one in a production file comment (`worker-types.ts:134`) — plus a spec bullet the
implementation cannot quite honour for one of its five enums. Nothing here blocks the three-way parallel run the
slice exists to enable.
