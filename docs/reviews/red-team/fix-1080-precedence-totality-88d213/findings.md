# Red team — `fix/1080-precedence-totality`

| | |
|---|---|
| Mode | `feature` (review wave, step 7) |
| Round | 1 of 2 |
| Fork / merge-base | `f797d25064c31997dfe400414baf99967b63315f` |
| Head | `0bb77f47d305bdcf616f38f34946073616411433` |
| Intake | `.feature/intake.json` · sha256 `7ebe561126c6d2c494e7d11e6c0a8912807e56f6994e5ebfb3f8378ee3077f20` · risk `high` · `db_touching: false` |
| Generated | 2026-09-03 |
| **Status** | **`OPEN_P1`** — no P0. Three open P1s. High-risk lane, so they need adjudication. |

Preconditions re-verified independently: tree clean at a committed SHA (`git status
--porcelain --untracked-files=no` empty), no watcher serving the worktree
(`mutation-runner.mjs watchers` → none), journal closed and round 1 opened.
`db_touching` is false, so `pnpm test:db:setup` was never run and
`REPWORTH_DISABLE_LIVE_DB_SUITES=1` was set for the whole pass.

---

## The two attacks the dispatch asked for, hardest first

### 1. Does the assertion actually fire? — YES, confirmed by measurement

| Tree state | `npx tsc --noEmit` |
|---|---|
| HEAD, unmutated | **0 diagnostics** — the seven `null`-mapped veto members do not fire |
| M1: `'rating_below_threshold'` deleted from `AUTO_APPROVAL_BLOCK_PRECEDENCE` | `src/lib/refusals/vocabulary.ts(650,39): error TS2344: Type '"rating_below_threshold"' does not satisfy the constraint 'never'.` (line 650 in the one-line-shorter mutant = `_PrecedenceIsTotal` at `vocabulary.ts:651` at HEAD) — **and it names the member** |

`rating_below_threshold` was chosen deliberately over `daily_cap_exhausted`: it is
the one rank whose removal leaves both run-time premises of the committed
`@ts-expect-error` case intact, so the kill is attributable to
`_PrecedenceIsTotal` alone.

The shipped spelling is not one of the six vacuous spellings the plan enumerates
(the bare alias, `type _X = U extends never ? true : false`, an unconsumed error
object, `const _x: U[] = []`, `const _x = [] satisfies U[]`, `declare const
_probe: U`) — it is a **constraint violation on a consumed type argument**,
`AssertNever<T extends never>`, which is the one shape that cannot go quiet. It
is also not the distributive false positive `type Bad<T> = T extends never ? …`:
the healthy tree compiles with zero diagnostics, which that spelling could not do.

The run-time half kills M1 too: the new fast-check property fails with
`Error: unranked_auto_approval_block_reason:rating_below_threshold` raised from
`resolvePolicyGateRefusal`.

### 2. Is the committed `@ts-expect-error` a real permanent proof? — YES, and it is the *only* detector

Two mutations attack the derivation itself rather than the data:

| Mutation | `tsc --noEmit` |
|---|---|
| M2 — `RankableBlockReason` rewritten to `{ [K in AutoApprovalBlockReason]: never }[…]` (vacuous derivation) | `src/lib/refusals/__tests__/vocabulary.test.ts(679,5): error TS2578: Unused '@ts-expect-error' directive.` |
| M3 — `export type AssertNever<T extends never> = T` → `export type AssertNever<T> = T` (**the exact shape that shipped wrong on `feat/refusal-log`**) | `src/lib/refusals/__tests__/vocabulary.test.ts(679,5): error TS2578: Unused '@ts-expect-error' directive.` |

In both cases `_PrecedenceIsTotal` in production goes silent — correctly, since a
vacuous derivation has nothing to complain about — and **nothing but the committed
test case catches it**. So the case is not asserting a fact about `AssertNever` in
isolation: it seeds the hole in its own type argument, routes through the real
`RankableBlockReason` (and therefore the real
`POLICY_GATE_HELD_REFUSAL_CATEGORIES`) and a real precedence tuple, and it is the
durable proof the ticket needed. This is the branch's strongest claim and it
holds.

---

## Findings

### RT1080-01 — P1 — the anti-vacuity docblock names a trigger that does not fire

`src/lib/refusals/__tests__/vocabulary.test.ts:699-705`

> "If `AUTO_APPROVAL_BLOCK_PRECEDENCE` ever lost its `as const` and widened to
> `readonly AutoApprovalBlockReason[]`, `Ranks[number]` would swallow the whole
> union, `UnrankedIn<Ranks>` would be `never` for the WRONG reason, and `_Whole`
> would pass while proving nothing. … so this directive is load-bearing and
> becomes TS2578 the day the widening happens."

Measured, three ways:

- **M5** — `as const` removed from `AUTO_APPROVAL_BLOCK_PRECEDENCE`, `satisfies
  readonly AutoApprovalBlockReason[]` kept: `tsc --noEmit` reports **zero
  diagnostics**. No TS2578. The named edit does not trigger the guard.
- **M5b** — same edit *plus* a dropped rank: `TS2344` still fires at
  `vocabulary.ts:650` and `vocabulary.test.ts:697`, naming
  `"rating_below_threshold"`. So `_Whole` is **not** vacuous under that edit —
  `Ranks[number]` does not swallow the union, because the `satisfies` contextual
  type still yields the union of the fifteen listed element literals.
- **M5c** — the real widening (`export const AUTO_APPROVAL_BLOCK_PRECEDENCE:
  readonly AutoApprovalBlockReason[] = […]`): **TS2578 fires** at
  `vocabulary.test.ts:706`, exactly as the comment describes.

So the guard is genuine and load-bearing — against the *annotation* form, not
against `as const` removal. The comment states a hazard that the edit it names
does not create and predicts a diagnostic that edit does not produce.

**Behavioural replacement:** state the trigger as the annotated form (or, more
robustly, "any widening that erases the element literal types"), and drop the
`as const` framing. Considered P0 and rejected: no shipped guarantee is
misrepresented — the assertion works, and the guard does fire on the real hazard.

**Disposition: open.**

### RT1080-02 — P1 — the property test's false-green arithmetic is wrong by ~5x, and the same figure is in the intake and the plan

`worker/jobs/response-generation/__tests__/policy-gate-precedence.property.test.ts:159`
· `docs/superpowers/plans/fix-1080-precedence-totality-plan.md:245`
· `.feature/intake.json` `edge_cases[9]`

> "…witnesses a hole only when it contains the hole member AND none of the seven
> vetoes — roughly 0.4% per run, ~86% over 500 runs. A 14% false green on the one
> property meant to pin totality is not a property."

0.4% is the independent-coin model (1/2 x 1/2^7 = 1/256). `fc.shuffledSubarray(pool,
{ minLength: 1 })` does not sample that way. Measured against
`fast-check@4.9.0`, the version in this lockfile:

- **Length histogram** over 100,000 draws from a 22-member pool: lengths 1-5 at
  ~7.1% each, lengths 6-22 at ~3.8% each, mean length **10.05**. Roughly uniform
  over the length range, not binomial.
- **Per-run witness rate**: 4,049 / 200,000 = **2.02%**, not 0.4%.
- **Detection over 500 runs**, 4,000 independent trials: **1.0000**. The false-green
  rate is ~0%, not 14%.

The design decision the paragraph justifies — draw the pool from the map's
non-`null` keys — is still right, and strictly better than the alternative
(deterministic instead of probabilistic). Only the arithmetic is false. It is
quoted in three committed artifacts, so a later reader has three chances to
inherit it.

**Behavioural replacement:** either re-derive the numbers against
`fc.shuffledSubarray`'s actual length distribution, or drop the numbers and keep
the categorical reason ("a 22-member pool makes the property probabilistic where
it can be deterministic").

**Disposition: open.**

### RT1080-03 — P1 — committed plan citations are fork-relative and stale at HEAD; one target does not exist

`docs/superpowers/plans/fix-1080-precedence-totality-plan.md` ·
`.claude/reference/arch-review-log.md:1510` · `.feature/intake.json`

`python3 ~/.claude/skills/grill-me-codex/scripts/prevalidate-plan.py
docs/superpowers/plans/fix-1080-precedence-totality-plan.md --repo .` →
`CITATIONS: 22 checked, 1 unresolved`.

**Unresolvable:** `docs/reviews/refusal-ledger-audit/spec-verification.md:78`
(plan:33, and an `.feature/intake.json` non-goal). The file does not exist at
HEAD — it is untracked in the root checkout and absent from this worktree, so the
citation cannot be followed by anyone reading the committed plan.

**Stale (each resolves exactly at `f797d250`, verified; each is wrong at HEAD):**

| Citation | Resolves at fork to | At HEAD |
|---|---|---|
| `vocabulary.test.ts:513` (plan:34; arch-log) | `it('every AutoApprovalBlockReason member appears exactly once…')` | line 518 |
| `vocabulary.test.ts:513-540` (plan:183) | the partition + tier assertions | 518-545 |
| `vocabulary.test.ts:527` (plan:153; arch-log (e)) | `expect(new Set(precedence).size, …)` | line 532 |
| `vocabulary.test.ts:192` (plan:253) | `function unionMembers(…)` | line 197 |
| `vocabulary.ts:650` (plan:155) | the `AUTO_APPROVAL_BLOCK_PRECEDENCE.find(…)` call | line 724 |
| `vocabulary.ts:652-655` (plan:170) | the unreachable-branch comment | 726-729 |
| `vocabulary.ts:656` (plan:18, 170) | the `unranked_…` throw | line 746 |
| `vocabulary.ts:659-664` (plan:188) | the deleted-sibling-throw comment | 749-754 |
| `vocabulary.ts:643-648` (plan:242) | the veto `for` loop | 717-722 |

The test file gained 5 lines above the shift point (the `import type` block and
its comment); `vocabulary.ts` gained ~74.

**Correct at HEAD, re-resolved and confirmed:** `vocabulary.ts:555-577`
(the precedence declaration), `vocabulary.ts:455-462`, `vocabulary.ts:498-504`,
`.fallowrc.jsonc:71` ("fallow excludes test files as consumers"),
`eslint.config.mjs:122-126` (`varsIgnorePattern: '^_'`), `scripts/verify-gate.sh:7`
("ci:fallow* is excluded"), `verify-gate.sh:451-475` (the promised-tests grep),
`.claude/commands/feature.md:409` (the fast-check requirement),
`write.test.ts:227-230` (the `@ts-expect-error` inversion precedent),
`worker-types.ts:183-190` (the 22 = 7 + 15 partition paragraph).

**Disposition: open.**

### RT1080-04 — P2 — the new tier case cannot detect any reordering of the precedence list

`src/lib/refusals/__tests__/vocabulary.test.ts:729-747`

`members` is derived from `blockPrecedence().filter(…)` and the assertion is
`resolved.refusalCode === members[0]`. Both sides move together, so the case is
structurally insensitive to precedence order. Measured:

- **M9** — cross-tier move (`'daily_cap_exhausted'` relocated from tier 6 to
  position 1): 1 failed / 29 passed, and the failure is the **pre-existing**
  `AUTO_APPROVAL_BLOCK_PRECEDENCE groups its members into the six locked category
  tiers in order` (`vocabulary.test.ts:547`). The new tier case passed.
- **M8** — within-tier swap (`triage_high_severity` <-> `daily_cap_exhausted`,
  both `owner_review_required`): **30/30 passed**, which independently confirms
  the module's own claim at `vocabulary.ts:516-520` that a within-tier reorder is
  deliberately unpinned.

It is not vacuous — **M10** (`const winner = blockReasons[0]`) kills it — but it
shares that kill with three pre-existing cases. Recorded so no later reader takes
it for the reorder guard; the reorder contract is owned entirely by
`vocabulary.test.ts:547`.

**Disposition: open** (P2, never blocks).

### RT1080-05 — P2 — the `RankableBlockReason` docblock mis-attributes which half is load-bearing

`src/lib/refusals/vocabulary.ts:589-592`

> "It reads the map through its OWN `as const satisfies` type … widen it and
> every value becomes `RefusalCategory | null`, every key survives `extends
> null`, and this resolves to the full 22 — an assertion that fires on a healthy
> tree."

- **M4** — `as const` dropped from `POLICY_GATE_HELD_REFUSAL_CATEGORIES`
  (`satisfies` kept): **zero diagnostics**. The values keep their literal types
  through the `satisfies` contextual type, so nothing widens.
- **M4b** — same edit plus a dropped rank: `TS2344` naming
  `"rating_below_threshold"` still fires at both sites. The derivation is intact.
- **M4c** — the real widening (`: Record<AutoApprovalBlockReason, RefusalCategory
  | null>` annotation): `TS2344 … Type '"policy_not_enabled"' is not assignable
  to type 'never'` on a **healthy** tree, plus `TS2322` at the lookup in
  `resolvePolicyGateRefusal`.

The **safety property the docblock claims is TRUE** — a widened map fails loudly
on a healthy tree, never silently. Only the attribution is imprecise: `satisfies`
carries it, `as const` is belt-and-braces. Same class as RT1080-01, lower stakes
because the conclusion is right.

**Disposition: open** (P2).

### RT1080-06 — P2 — the branch surfaces a stale fallow suppression, correctly documented, gates nothing

`src/lib/refusals/vocabulary.ts:554`

`FALLOW_BASE=f797d250 pnpm ci:fallow` at HEAD:

```
● Stale suppressions (1)
  src/lib/refusals/vocabulary.ts:554:0 // fallow-ignore-next-line unused-export
      (no unused-export issue found on the next line)
✗ 1 stale suppression   ·   exit code 0
```

`.claude/reference/arch-review-log.md`'s causal claim was re-derived rather than
trusted, and it is **TRUE**:

- Removing the production `_PrecedenceIsTotal` line (M6) does **not** clear it.
- Replacing the test's two `typeof vocabulary.AUTO_APPROVAL_BLOCK_PRECEDENCE`
  references (M7) **does** clear it — 0 stale suppressions.

So the test's new `typeof` reference is indeed the first statically visible
cross-module consumer, exactly as the log says. Exit code 0, so neither
`ci:fallow` nor the `ci:fallow:coverage` gate is affected. Recorded, not actioned;
the log's decision to leave it stands.

**Disposition: rejected** — the log already records this as a deliberate,
non-gating side effect with a stated reason ("removing it would trade a warn for a
real finding later"), and the measurement confirms every fact in that record.
Evidence: `src/lib/refusals/vocabulary.ts:554`, `.fallowrc.jsonc:71`,
`scripts/verify-gate.sh:7`.

---

## Duty 2 — fragile assertions

Scanned all five added cases plus the modified property file. **None found** of
the three named shapes: no absence-of-tag proxy, no exact string count on
rendered output, no order assertion where no ordering contract exists. The two
run-time companions in the `@ts-expect-error` cases
(`vocabulary.test.ts:684-689`, `:709`) are premise guards, not structural
proxies — they name which premise moved when the directive stops being necessary,
which is the correct pattern. `RT1080-04` is filed as an insensitivity finding,
not a fragility one.

## Duty 3 — docs vs reality

Ran `prevalidate-plan.py` (present). Every citation re-resolved by hand as well —
results in RT1080-03. Other prose claims checked against HEAD:

| Claim | Where | Verdict |
|---|---|---|
| "the repo has 22 `@ts-expect-error` uses" | `vocabulary.test.ts:655` | TRUE at the fork (`git grep -c` over `f797d250` = 22); 24 at HEAD |
| "zero `expectTypeOf`" | same | TRUE — the only tracked occurrence is that sentence |
| "no vitest `typecheck` block" | same | TRUE — `vitest.config.ts` has none |
| "Test files are inside `tsconfig.json`'s `include`" | same | TRUE — `include` is `["next-env.d.ts", "**/*.ts", "**/*.tsx", …]` |
| "`vocabulary.test.ts` already asserts `new Set(precedence).size`" | `vocabulary.ts:648` | TRUE — `vocabulary.test.ts:532` |
| "`_`-prefixed for `eslint.config.mjs`'s `varsIgnorePattern: '^_'`" | `vocabulary.ts:634-636` | TRUE — `eslint.config.mjs:124`; `npx eslint` over the three changed files exits 0 |
| "`tsconfig.json` sets no `noUnusedLocals`" | same | TRUE |
| "the throw is STRUCTURALLY REQUIRED — `find` returns `T \| undefined`" | `vocabulary.ts:727-737` | TRUE by construction; `refusalCode: winner` does not type-check without the branch |
| "a member listed TWICE is NOT caught" | `vocabulary.ts:646-650` | TRUE — `P[number]` collapses duplicates; covered at run time by `vocabulary.test.ts:532` |
| "`ci:fallow --fail-on-issues` exits 0" | arch-review-log | TRUE — measured, exit 0 |
| "the test's `typeof` reference is what makes `:554` stale" | arch-review-log | TRUE — M6/M7, see RT1080-06 |
| "ZERO runtime lines changed" | arch-review-log | TRUE — the only `resolvePolicyGateRefusal` hunk replaces comment lines |
| the anti-vacuity `as const` trigger | `vocabulary.test.ts:699-705` | **FALSE** → RT1080-01 |
| "~0.4% / ~86% / 14% false green" | property test, plan, intake | **FALSE** → RT1080-02 |
| "`as const satisfies` … widen it and every value becomes `RefusalCategory \| null`" | `vocabulary.ts:589-592` | imprecise → RT1080-05 |

All five `tests_to_add` titles appear verbatim in `*.test.ts` under `src`/`worker`
(the gate's own `grep -rqF` check, `verify-gate.sh:451-475`). Note for the record,
not as a finding against this branch: that gate row is a **presence** check on the
title string only — it never inspects what the case asserts. Every one of the five
was separately mutation-tested here, which is the coverage that row cannot give.

## Duty 4 — missed sibling cases

The defect shape is: *an ordered `as const satisfies readonly Enum[]` list that
must be TOTAL over the non-`null` keys of a companion `Record<Enum, V | null>`
map, where only membership is proved.*

Searched, scope `src/**` + `worker/**` + `scripts/**`, tracked files only:

- `git grep -n "as const satisfies readonly" -- '*.ts'` → 15 hits. Reviewed each;
  the other 14 are flat vocabularies with no companion nullable map
  (`TIERS`, `VARIANTS`, `ONBOARDING_PLAN_ORDER`, `AdminNavGroup`,
  `TableDisposition`, two `AccountOffboardingStatus`, `PRICE_VARIANTS`,
  `BUSINESS_HEALTH_FILTERS`, `AnalyticsEventName`, `AutoPolicyAuditMetadata` keys,
  `SubscriptionTierValue`, `BatchState`, one test-local).
- `git grep -n "as const satisfies Record<" -- 'src/lib/refusals/*.ts'` → the seven
  lane maps. Only three take `| null` (`WithholdReason` at `:298`,
  `BatchHaltedRefusalCode` at `:389`, `AutoApprovalBlockReason` at `:487`), and
  only `AutoApprovalBlockReason` has a companion ordered list.
  `WITHHOLD_REASONS` (`src/lib/solicitation/restraint-policy.ts:45`) is the
  *source* of its own union (`(typeof WITHHOLD_REASONS)[number]`), so the
  `satisfies Record<WithholdReason, …>` already gives totality in both
  directions — no hole.
- `git grep -n "\.find(" … | grep -i "ORDER|PRECEDENCE|PRIORITY|RANK"` →
  `vocabulary.ts:724` (the one under fix) plus two test-local helpers
  (`auto-approval.test.ts:272`, `dispatch-gate.test.ts:80`), both of which use
  `?? null` rather than throwing.
- `grep -n "^export const"` over `vocabulary.ts` → `AUTO_APPROVAL_BLOCK_PRECEDENCE`
  is the module's only ordered list, and `resolvePolicyGateRefusal` its only
  resolver.

Exclusions: `node_modules`, `.next`, untracked files, `supabase/migrations/`.

**Result: zero siblings.** Sound search, recorded as a result rather than padded
with an invented instance.

## Duty 5 — operational completeness

The diff changes **zero runtime lines**. It adds no terminal path, no swallowed
catch, and no new operator-actionable failure. The one throw in scope
(`unranked_auto_approval_block_reason`, `vocabulary.ts:746`) is unchanged and
pre-dates the branch; the change moves its trigger condition from run time to
compile time, which strictly reduces the operational surface. No rule row in
`docs/runbooks/beta-launch-alerting.md` is required or contradicted.

**No finding.**

## Restoration

`mutation-runner.mjs finalize` ran after every mutation and once more at the end.
All 15 journal entries are `state: "restored"`, `dotenv.open: false` with no
backup files, `supervisors: []`. `git status --porcelain` shows only
`?? docs/reviews/finding-checklists/` — the root's triage tooling, not this run —
plus this run's own two artifacts. No tracked file is modified.

### Protocol deviation, disclosed

Baseline and mutant commands were invoked directly (with the runner's `env`
allowlist applied inline: temporary `HOME`/`TMPDIR`, `NODE_ENV=test`, `CI=true`,
`MOCK_EXTERNAL_APIS=true`, `REPWORTH_DISABLE_LIVE_DB_SUITES=1`,
`MAX_PARALLEL=2 VITEST_WORKERS=2`) rather than through `mutation-runner.mjs run`,
so `journal.runs` reads 0. Consequence: the per-round run budget was self-enforced
(15 mutations, well inside the 30-run cap) instead of runner-enforced, and no
process group was journaled. Every mutation itself went through
`mutation-runner.mjs mutate`, so the blob-OID restore guarantee is intact and
verified. No dotenv swap was needed: the gate under test is `tsc --noEmit`, and
the two vitest suites are pure — neither reads `.env.local`.

## Authorizations

None.
