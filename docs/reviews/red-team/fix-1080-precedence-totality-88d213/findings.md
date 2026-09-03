# Red team — `fix/1080-precedence-totality` — ROUND 2 (scoped)

| | |
|---|---|
| Mode | `feature` |
| Run id | `feature-fix-1080-precedence-totality-88d213` |
| Round | **2 of 2 — there is no round 3** |
| Fork / merge-base | `f797d25064c31997dfe400414baf99967b63315f` (identical — the branch is a clean descendant) |
| Head reviewed | `d3a6e562900133ac826b9bf9b27e4b8ab7361c1b` |
| Round-1 head | `0bb77f47d305bdcf616f38f34946073616411433` |
| Intake sha256 | `c64ada5eca1adeeae4885f2519cf21765ddd0f7344c5d7a5a189791f0ff02222` (round 1 saw `7ebe5611…`) |
| Risk | **high** (from the intake) |
| Status | **`OPEN_P1`** |
| Worktree | `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/fix-1080-precedence-totality` |

## Scope of this round

Per the dispatch, this round attacks **the fix hunks (`git diff 0bb77f47 HEAD`) and their direct
callers only**. Taken as given from round 1 and NOT re-derived: that the assertion fires (healthy
tree → 0 diagnostics; seeded hole → `TS2344` naming the member), that the seven veto members never
fire, that the committed `@ts-expect-error` routes through the real map and a real tuple, and that
zero runtime lines changed *as a line-level claim* (this round re-proved the stronger form — see
RT1080-07).

Nine files changed in the round-2 commit. Three carry code or tests
(`src/lib/refusals/vocabulary.ts`, `src/lib/refusals/__tests__/vocabulary.test.ts`,
`worker/jobs/response-generation/__tests__/policy-gate-precedence.property.test.ts`); the rest are
the plan, the intake, the arch-review-log row, the round-1 report pair, and an appended
finding-checklist file.

## Verdict in one paragraph

**The four headline mechanisms all re-verify.** The deterministic singleton sweep is a real proof of
#1080's invariant 7, it kills a seeded hole and names the member, and it is not vacuous — it is
*scoped*, and I can prove the scoping is correct rather than accidental. Both previously-empty tests
now assert something a mutation can break, and each does so as the sole detector of the defect it
was strengthened for. Both corrected `satisfies`-vs-`as const` claims are true in both directions,
compiled. The plan's citations are clean and its one surviving `path:line` in the arch-review-log row
is the deliberately-historical one, whose historical claim is exactly right.

**What is not done is the same class of problem the dispatch predicted.** The corrections stopped at
the plan and the code and did not reach two artifacts this branch also created and also amended: the
committed intake still ships the refuted per-run figure (RT1080-02) and six fork-relative citations,
two now pointing at different content and two of those inside forward-facing *"do not edit"*
instructions (RT1080-03). A third artifact carries a corrected number that the correcting commit
itself invalidated (RT1080-07). And one new assertion is fragile in a way I measured (RT1080-08).

**No `P0`.** Nothing I found is a proven-fake test, a false behavioural claim, or a correctness
defect. Four `P1`s and two `P2`s are open. On a `high`-risk run the checker requires user
adjudication for every open `P1`, and there is no round behind this one.

## Severity table

| Id | Sev | Disposition | What |
|---|---|---|---|
| RT1080-01 | P1 | **fixed** | `as const` / TS2578 false mechanism — corrected and re-measured both directions |
| RT1080-02 | P1 | **open** | The refuted `~86% over 500 runs` figure survives in the committed intake |
| RT1080-03 | P1 | **open** | Six fork-relative citations survive in the committed intake; two now point at different content |
| RT1080-04 | P2 | **fixed** | Locked-tier case now detects two real defects; its stated limits are true as measured |
| RT1080-05 | P2 | **fixed** | `RankableBlockReason` docblock mis-attribution — corrected and re-measured |
| RT1080-06 | P2 | **rejected** | Stale fallow suppression — round-1 rejection stands |
| RT1080-07 | P1 | **open** | `79 comment lines` was re-derived at round-1 HEAD; the same commit took it to 86 |
| RT1080-08 | P1 | **open** | Fragile assertion: the source-text oracle fails a behaviour-preserving rename, with a false message |
| RT1080-09 | P2 | **open** | Locked-tier comment describes a failure mode its own new assertion pre-empts |
| RT1080-10 | P2 | **open** | The precedent docblock misquotes the `TS2322` text it reasons from |

## Preconditions and environment

- Worktree clean at `d3a6e562` before any mutation; clean again after (`git status --porcelain`
  empty except this round's two report artifacts).
- `mutation-runner.mjs watchers` → none. `round-start` → round 2 open, 30 runs available.
- Environment is the runner's allowlist with a temporary `HOME`, `NODE_ENV=test`, `CI=true`,
  `MOCK_EXTERNAL_APIS=true` and, with no validated local database supplied,
  `REPWORTH_DISABLE_LIVE_DB_SUITES=1`. `.env.local` was swapped for a scrubbed copy for every
  mutation cycle and restored by `finalize` each time. **The live-DB lane was never woken** and
  `pnpm test:db:setup` was never run — this branch is `db_touching: false` and a sibling worktree
  owns the shared database. Vitest ran with `MAX_PARALLEL=2 VITEST_WORKERS=2`.
- Budget: 6 supervised `run` invocations of the 30 available, plus four unsupervised `tsc --noEmit`
  invocations (typecheck is not a Vitest candidate and takes ~5s). No candidate was skipped for
  budget.

## 1 — The deterministic sweep

`policy-gate-precedence.property.test.ts:156`, `'every mapped non-veto block reason alone resolves
to itself, exhaustively'`.

**Does it catch a seeded hole, every time?** Yes (INV-01). Removing `'daily_cap_exhausted'` from
`AUTO_APPROVAL_BLOCK_PRECEDENCE` made the sweep fail with
`Error: unranked_auto_approval_block_reason:daily_cap_exhausted` thrown from
`resolvePolicyGateRefusal`, under `assert-one-test` confirming exactly one executed test. The
"every time" is stronger than a 30/30 trial: **the sweep contains no randomness** — it walks
`Object.keys(map)` and calls `resolve([member])` — so one kill is the entire population. The
branch's reported 30/30 against a mirrored resolver is the same measurement repeated, and is
consistent with mine.

**Is the singleton really the witness?** Yes, and it is a proof rather than a heuristic. `resolve`
throws `unranked` only when every input member is mapped, none is `null`-mapped, and none is in
precedence. If every mapped non-`null` member individually *is* in precedence, then any subset of
mapped non-`null` members contains a ranked member and `find` succeeds; a subset containing a
`null`-mapped member returns before `find`; an unmapped code throws the *other* error. So singleton
coverage implies totality over all `2^15` subsets in all orders. The claim in the file's comment is
sound.

**Is it vacuous if the resolver is stubbed to return the input unchanged?** This was the sharpest
question in the dispatch, and the answer is **no — it is scoped, and correctly so** (INV-02). I
replaced the precedence lookup with `const winner = blockReasons[0]`, which for a singleton input is
exactly "return the input unchanged". The sweep survived. But the survivor is *provably* behaviour-
preserving **for the property the sweep asserts**: under that mutant `winner` is `undefined` only
for empty input, and empty input already returned at the destructure guard above, so the
`unranked_auto_approval_block_reason` throw is unreachable — invariant 7 still holds. The sweep
passing is the correct answer, not a blind spot. Classified `equivalent` with that proof, which does
not block.

The election rule that mutant *does* break is not the sweep's job, and the tests that own it did
fire: `'resolvePolicyGateRefusal resolves the same winner for every locked tier after the change'`
(`tier watchdog_unavailable elects by input position`) and
`'resolvePolicyGateRefusal picks the highest precedence tier present, not the evaluation order'`.

## 2 — The two tests that previously asserted nothing

### 2a. The locked-tier case (RT1080-04 → fixed; RT1080-09 opened)

Tier membership now comes from `Object.keys(map)` instead of `precedence.filter(...)`, and two
independent oracles were added. Measured:

| Mutation | Result |
|---|---|
| Drop `'daily_cap_exhausted'` from precedence (mapped-but-unranked) | **detected** — `tier owner_review_required has mapped members with no rank: expected [ 'daily_cap_exhausted' ] to deeply equal []` |
| `find(...)` → `blockReasons[0]` (elect by input position) | **detected** — `tier watchdog_unavailable elects by input position: expected 'triage_fallback' to be 'provider_moderation_disabled'` |
| Within-tier swap (`provider_moderation_error` ↔ `provider_moderation_disabled`) | **not detected — by 31 of 31 tests.** Deliberate: `vocabulary.ts`'s own docblock says within-tier order "changes the stored `refusal_code` only … carries no `vocabulary_version` obligation (#1003) … deliberately NOT pinned by any test". Independently re-read at HEAD — the docblock says exactly that. |
| Cross-tier move (`triage_fallback` → end of tuple) | **detected, by the contiguity case only** — `tiers are not contiguous, or not in the locked order`. The locked-tier case did not fire, exactly as its comment says. |

So the comment's account of what it can and cannot catch is accurate, on all four axes, as measured.

One residual: numbered claim (1) says a mapped-but-unranked member "blows up in `resolve` below with
`unranked_auto_approval_block_reason` naming it". It does not — the `toEqual([])` assertion added
immediately *above* `resolve` fires first and `resolve` is never reached. That is a description one
revision behind its own code, filed as **RT1080-09 (P2)**.

### 2b. The duplicate / reverse-hole case (real oracle; but see RT1080-08)

**Is the source-text assertion a real oracle or a restatement?** A real oracle, and the sole one
(INV-05). Renaming the unranked throw to `unmapped_auto_approval_block_reason` — the exact
"collapse the two faults into one name" defect — failed **1 test of 31**, and it was this one:
`the unranked fault lost its own name, or was folded into the unmapped one`. The two anchored
regexes above it passed unchanged under that mutant, so the source-text lines are not a restatement
of them.

The comment's supporting claim also checks out: the `unranked` throw cannot be provoked at run time
at HEAD, because all fifteen non-`null` map keys are in precedence and `resolve` takes only
`AutoApprovalBlockReason`s, so no test input can reach it without editing the module.

But the assertion is **fragile** (**RT1080-08, P1**). It pins the entire `new Error(...)` expression
including the interpolated identifier. Renaming only the resolver's loop variable
`code` → `reason` — behaviour byte-identical — turns the suite red with
`the unmapped fault lost its own name`, which is false. The fix is to narrow, not delete: this same
file already demonstrates the robust shape at `:269-278` (regex-extract the declaration, assert the
minimal literal). A bare `toContain('unranked_auto_approval_block_reason')` would be *too* loose —
both names also appear in prose inside `vocabulary.ts`'s docblocks — so the throw expression must
stay part of the anchor:

```ts
expect(source).toMatch(/throw new Error\(`unranked_auto_approval_block_reason:\$\{[^}]+\}`\)/);
```

## 3 — The two corrected mechanisms, compiled

Four `tsc --noEmit` runs against the real tree. Every prediction the branch now makes is true.

| Variant | Predicted by the branch | Measured |
|---|---|---|
| `POLICY_GATE_HELD_REFUSAL_CATEGORIES` loses `as const`, keeps `satisfies` | zero diagnostics | **zero diagnostics**, exit 0 |
| `AUTO_APPROVAL_BLOCK_PRECEDENCE` loses `as const`, keeps `satisfies` | zero diagnostics | **zero diagnostics**, exit 0 |
| The map respelled as a type **annotation** | `_PrecedenceIsTotal` fires on a healthy tree | **`TS2344`** at `vocabulary.ts:658` *and* at `vocabulary.test.ts:711`, `Type '"policy_not_enabled"' is not assignable to type 'never'` (+ `TS2322` fallout at `vocabulary.ts:764`) |
| The array respelled as a type **annotation** | the `@ts-expect-error` becomes unnecessary → `TS2578` | **`TS2578` Unused '@ts-expect-error' directive** at `vocabulary.test.ts:728` (+ the same `TS2322` fallout). `_Whole` goes silent, which is precisely why the *directive* is the guard |

One nuance, recorded rather than filed: under the map-annotation form `UnrankedIn<…>` resolves to
the **seven veto members**, while `RankableBlockReason` is what resolves to the full 22. The
`vocabulary.ts` docblock states this precisely; the arch-review-log row's compressed
"fire on a HEALTHY tree with all 22 members" is loose but not false.

## 4 — Citations

Method: `prevalidate-plan.py` is **not present** on this host under `~/.claude/skills/grill-me-codex/scripts/`,
so every citation was hand-checked and this is the record of that, as the skill requires.

**The plan (`docs/superpowers/plans/fix-1080-precedence-totality-plan.md`) is clean.** Zero
`path:line` citations survive. Every symbol citation re-resolves at HEAD, each verified individually:

- `restraint-policy.test.ts`'s `'is sentiment-blind at the TYPE level, not only in serialized output'` → `src/lib/solicitation/__tests__/restraint-policy.test.ts:626`, and its `type AssertSentimentBlind<T> = Extract<keyof T, SentimentBearingKey> extends never ? true : never` consumed as `const candidateIsBlind: AssertSentimentBlind<AskCandidate> = true` is exactly as described.
- `feat-1013-refusal-policy-gate-held-plan.md` § *"Two tests that must NOT be written"* → `:167`.
- `vocabulary.test.ts`'s `'every AutoApprovalBlockReason member appears exactly once across the veto set and the precedence list'` → `:518`; the `new Set(precedence).size` assertion it names → `:532`.
- `working-rules.md` → `.agents/skills/feature/references/working-rules.md`, and its § *"Precedent over invention — … Name the precedent in the summary"* at `:23-24` does require what the new paragraph says it requires.
- `.fallowrc.jsonc`, `eslint.config.mjs`, `scripts/verify-gate.sh`, `.claude/commands/feature.md`, `src/lib/shared/worker-types.ts`, `src/lib/refusals/__tests__/write.test.ts` — all present.
- `docs/reviews/refusal-ledger-audit/spec-verification.md` — correctly **dropped rather than re-anchored**; `git ls-files` does not know that path, confirming RT1080-03's premise and the fix.

**The arch-review-log row's one surviving `path:line` is the deliberately-historical one, and its
historical claim is exactly right.** Verified by `git show` at all three SHAs:

| | `f797d250` (fork) | `0bb77f47` | `d3a6e562` |
|---|---|---|---|
| `vocabulary.test.ts:513` | the partition test title | `'below_our_bar',` | `'below_our_bar',` |
| `vocabulary.test.ts:527` | `new Set(precedence).size` | blank | blank |

Both moved by exactly +5, to `:518` and `:532`, and `:513` does land on `'below_our_bar',` inside
`LOCKED_TIER_ORDER` — "plausible enough that a reader misses the miss", as the row says.

**The committed intake was not re-anchored (RT1080-03).** Six fork-relative citations survive there.
Four of the six are ones round 1 listed by name:

| Intake location | Citation | At HEAD |
|---|---|---|
| `non_goals[1]` | `vocabulary.test.ts:513-540` | **stale**, +5 → `518-545` |
| `non_goals[2]` | `vocabulary.ts:615-621` | **stale and now different content** — the `AssertNever` docblock, not the unmapped-throw paragraph the non-goal describes |
| `invariants[1]` | `vocabulary.test.ts:513` | **stale**, → `518` |
| `edge_cases[2]` | `vocabulary.test.ts:527` | **stale**, → `532` |
| `edge_cases[2]` | `vocabulary.ts:650` | **stale and now different content** — the `TS2536` signpost comment, not the `Array.prototype.find` call |
| `existing_patterns_to_follow[5]` | `vocabulary.test.ts:513-553` | **stale**, +5 |

Still correct at HEAD and needing no change (each re-checked): `vocabulary.ts:455-462`, `:463`,
`:490-505`, `:554`; `write.test.ts:227-230`; `eslint.config.mjs:122-126`; `.fallowrc.jsonc:71`.

`non_goals[1]` and `non_goals[2]` are *"do not edit"* instructions, so a later agent honouring them
protects the wrong regions. The same commit re-anchored two *other* `non_goals` entries by symbol,
so the file now mixes two conventions with nothing marking which is which.

## 5 — The counts (RT1080-07)

Token-classified line counts on `src/lib/refusals/vocabulary.ts`, at two commit pairs:

| Range | code | comment | blank | comment removed |
|---|---|---|---|---|
| `f797d250..0bb77f47` (round-1 HEAD) | 11 | **79** | 4 | 4 |
| `f797d250..d3a6e562` (**HEAD — the row's actual subject**) | 11 | **86** | 4 | 4 |

`"11 executable lines across 4 declarations"` **re-verifies at HEAD** — the eleven lines are
`RankableBlockReason` (5), `AssertNever` (1), `UnrankedIn` (4) and `_PrecedenceIsTotal` (1), and
there are exactly four declarations. `"4 blank"` re-verifies. `"79 comment lines"` **does not**: the
round-2 commit rewrote the `RankableBlockReason` docblock, adding 11 comment lines and removing 4,
taking the figure to 86 added / 82 net. The number was carried over from the round-1 measurement
rather than re-derived at the commit that changed it — the same mechanism the row itself spends a
sentence warning about ("the commit that writes the citation is the commit that moves the target").

`"ZERO runtime lines changed — the transpiled JS is byte-identical to the fork point"` **is true,
and I proved it by a stronger method than the row uses**: `tsc` emit of `vocabulary.ts` at
`f797d250` and at `d3a6e562` (same `--target es2022 --module esnext --removeComments`) is
byte-identical at 4632 bytes.

The `@ts-expect-error` tally was correctly replaced by a qualitative claim, and **both halves of that
claim are true**: there is no `expectTypeOf` **call** anywhere in the repo (the four textual hits are
all prose — this file's own sentence, the round-1 report, the plan, and a `feat-727` plan discussing
it as a rejected option), and `vitest.config.ts` has no `typecheck` block.

## 6 — Duty 4, missed siblings (zero, with the search recorded)

Patterns searched, over `**/*.ts` and `**/*.tsx`, excluding `node_modules/` and `docs/reviews/`:

- `as const.{0,60}(literal|widen|preserv)` and `(literal|widen|preserv).{0,60}as const` — comments crediting `as const` with what `satisfies` does.
- `extends never> = T`, `AssertNever`, `extends never \? true`, `: never =`, `satisfies never` — other compile-time assertion aliases.
- `readRepoFile` — other source-text assertions of the shape RT1080-08 concerns.

**Result: zero siblings of the corrected defect.** The one candidate,
`src/lib/solicitation/__tests__/suppression.test.ts:75` ("The whole reason the arrays are
`as const`"), is **not** the same defect: `SUPPRESSION_SCOPES`, `SUPPRESSION_SOURCES` and
`SUPPRESSION_CHANNELS` are declared with a bare `as const` and **no** `satisfies` clause, so there
`as const` genuinely is the load-bearing clause. `src/lib/refusals/vocabulary.ts:714`'s pre-existing
"erases the `as const satisfies` literal types" paragraph exists unchanged at the fork point and is
out of this round's scope.

The `readRepoFile` search found the new assertion is the fifth in this file (`:93`, `:199`, `:269`,
`:407` are pre-existing), so the *technique* follows house precedent — but the two closest
pre-existing ones regex-extract a declaration first, which is the shape RT1080-08 asks for.

## 7 — Duty 5, operational completeness

Vacuously satisfied, and proved rather than asserted: the diff adds **no runtime code** — the `tsc`
emit is byte-identical to the fork point — so no failure path, log line, Sentry signal, tag or
grouping title can have changed. No `docs/runbooks/beta-launch-alerting.md` rule row is required or
affected. Nothing to compare on any of the six facets.

## 8 — The intake amendment

**Confirmed: the intake changed by exactly two `non_goals` lines and nothing else.** The diff
`0bb77f47..d3a6e562` on `docs/superpowers/plans/fix-1080-precedence-totality-intake.json` is a
single hunk, `-2 / +2`, both lines inside `non_goals`, re-anchoring the two entries that had cited
the untracked `docs/reviews/refusal-ledger-audit/spec-verification.md`. That is the fix for RT1080-03
and it is correct. `.feature/intake.json` and the committed copy are byte-identical
(`c64ada5e…`); round 1 recorded `7ebe5611…`, which is why the evidence-integrity checker flags an
amendment.

**Does the amendment affect anything I measured? No.** Nothing in this round depends on either
edited line. `goal`, `invariants`, `edge_cases`, `allowed_edit_surface`, `tests_to_add`,
`verification_commands` and `risk` are unchanged; all five promised `tests_to_add` titles still
exist verbatim in the tree, so the gate's `promised-tests` row is unaffected. The only consequence
is that the round-1 sidecar's `intake_sha256` no longer matches — expected, and this round's sidecar
carries the current hash.

**One second-order consequence, and it is what RT1080-02 and RT1080-03 are about.** Amending the
intake spends the defence that the contract is frozen. Having chosen to edit it, the branch left
inside it the refuted `~86% over 500 runs` figure and six fork-relative citations — including two
now pointing at different content, inside forward-facing "do not edit" instructions.

## 9 — What I could not verify

- **The branch's "30/30 in a mirrored resolver"** — I did not reconstruct their mirrored harness. I
  measured the real sweep against a real seeded hole in the real module (1 kill) and established
  that the sweep is deterministic, which makes 30/30 the same fact. The two are consistent; I have
  not reproduced their exact instrument.
- **The round-1 givens** listed under *Scope* — taken as given per the dispatch, except the
  zero-runtime-change claim, which I re-derived in a stronger form.
- **The PR body.** Per the skill, PR-body validation happens after the draft PR exists and is not
  part of this pass. RT1080-06's rejection must appear in a *"Red-team findings rejected"* section
  there.

## Red-team findings rejected

**RT1080-06 — P2 — `src/lib/refusals/vocabulary.ts:554`.** *Verdict:* not a defect; the round-1
rejection stands unchanged in round 2. `arch-review-log.md` already records the stale
`fallow-ignore-next-line unused-export` as a deliberate non-gating side effect with a stated reason;
round 1 independently verified every fact in that record (`ci:fallow` reports it but exits 0, and
the test's new `typeof` reference is the first statically visible cross-module consumer); and
nothing in the round-2 fix hunks touches that line or the `.fallowrc.jsonc` belief it rests on.

## Authorizations

None. No finding on this run is `accepted-risk`.

---

*The full inventory, every mutation's reasoning, and the machine-readable dispositions are in
`findings.json` beside this file. The checker recomputes counts and status from that file and does
not parse this one.*
