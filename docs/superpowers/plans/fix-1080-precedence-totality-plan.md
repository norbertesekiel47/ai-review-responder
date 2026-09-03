# Plan — #1080 · make the compiler prove precedence totality

Branch: `fix/1080-precedence-totality`
Intake: `.feature/intake.json` — materialized at arming by `scripts/feature-setup.sh`,
which ALSO commits the audit copy to
`docs/superpowers/plans/fix-1080-precedence-totality-intake.json`. That commit is
what makes `ci:feature-surface` enforce this branch's surface at all; without it
the audit passes vacuously and only the in-session hooks bind.
Revision 3 — after plan-skeptic rounds 1 (13 findings) and 2 (9 findings). All ACCEPT.

## The defect, restated

`AUTO_APPROVAL_BLOCK_PRECEDENCE` (`src/lib/refusals/vocabulary.ts:555-577`)
carries `as const satisfies readonly AutoApprovalBlockReason[]`. That proves
every LISTED member is a valid block reason. It does not prove the converse. A
member mapped to a real category in `POLICY_GATE_HELD_REFUSAL_CATEGORIES` and
forgotten here type-checks, then throws `unranked_auto_approval_block_reason`
at `vocabulary.ts:656` — inside the response-persist transaction.

## What #1003 actually locked — the TICKET IS WRONG about this

Ticket #1080 says *"#1003 explicitly forbade a consistency test between the veto
set and the precedence list"*. That is backwards, and building to it would have
forbidden this plan's own property test. Verified against three sources:

- `vocabulary.ts:498-504` scopes "the two" to the two ORDERS: *"The two orders
  are independent on purpose, and they legitimately DISAGREE… #998 proposed a
  test pinning the two in agreement"*.
- `docs/superpowers/plans/feat-1013-refusal-policy-gate-held-plan.md:169-176`
  lists the two tests #1003 rejected under "Two tests that must NOT be written".
  **Both are about `REFUSAL_CATEGORIES` order**: #998's consistency test, and a
  drift test asserting a `REFUSAL_CATEGORIES` reorder cannot change a category.
- `docs/reviews/refusal-ledger-audit/spec-verification.md:78` records that
  **#1003's exhaustiveness test is REQUIRED and EXISTS** — `vocabulary.test.ts:513`,
  *"every AutoApprovalBlockReason member appears exactly once across the veto set
  and the precedence list"*.

So the real constraint is narrower than the ticket states:

- FORBIDDEN: any test coupling the precedence list to `REFUSAL_CATEGORIES` order.
- REQUIRED and already shipped: the veto-vs-precedence exhaustiveness test.
- THIS TICKET: move that shipped RUNTIME exhaustiveness guarantee into the type
  system, leaving the order independence untouched.

## The derivation — verified by compilation, not by reading

Round 1 compiled the sketch against the real declarations under the repo's own
TypeScript 6.0.3 and `strict` + `noUncheckedIndexedAccess`:

| case | `UnrankedBlockReason` | diagnostics |
|---|---|---|
| current HEAD | `never` | 0 |
| `autopilot_tier_required` remapped `null` → `'autonomy_paused'` | `"autopilot_tier_required"` | 0 |
| `daily_cap_exhausted` deleted from precedence | `"daily_cap_exhausted"` | 0 |

The computation is sound and names the hole member. **All three rows report
zero diagnostics** — the sketch is a dead alias with no consumer. Shipping it
verbatim reproduces the `feat/refusal-log` failure exactly.

## Tracer bullets

### T1 — the assertion, in the one spelling proved to fire

- Seam: `pnpm typecheck` — the gate's **`typecheck` row**, which is separate from
  the `lint` row (`scripts/verify-gate.sh:320-321`). In CI the `lint` job runs
  `pnpm typecheck`; locally they are two rows. Cite the right one as evidence.
- The derivation stays as sketched, keyed on `extends null`:

```ts
type RankableBlockReason = {
  [K in AutoApprovalBlockReason]:
    (typeof POLICY_GATE_HELD_REFUSAL_CATEGORIES)[K] extends null ? never : K;
}[AutoApprovalBlockReason];

type UnrankedBlockReason = Exclude<
  RankableBlockReason,
  (typeof AUTO_APPROVAL_BLOCK_PRECEDENCE)[number]
>;
```

- **The consuming assertion — PARAMETERIZED, which is round 2's correction.**
  Round 2 compiled the revision-2 spelling and found the `TS2344` fires at the
  DECLARATION SITE in `vocabulary.ts` whether or not any test file names the
  alias. A test that merely references it therefore asserts nothing, and the
  export existed only to feed that empty test. Parameterizing the derivation
  over the ranks fixes both:

```ts
export type AssertNever<T extends never> = T;

export type UnrankedIn<P extends readonly AutoApprovalBlockReason[]> =
  Exclude<RankableBlockReason, P[number]>;

// Self-consuming, private, `_`-prefixed. Fires at THIS line on a real hole.
type _PrecedenceIsTotal = AssertNever<UnrankedIn<typeof AUTO_APPROVAL_BLOCK_PRECEDENCE>>;
```

  Round 2 compiled it: healthy tree → zero diagnostics; a production hole →
  `TS2344` at the declaration AND at the test's seeded-hole line.

- **Only the two helpers are exported, and neither is `_`-prefixed.** They have
  a real consumer — `vocabulary.test.ts` seeds a hole in the type argument. The
  private `_PrecedenceIsTotal` keeps its underscore and stays unexported;
  `varsIgnorePattern: '^_'` and the absent `noUnusedLocals` already cover it.
  This resolves round 2's contradiction: an exported `_`-prefixed symbol is a
  private marker on public API, and `vocabulary.ts:455-462`'s "a vocabulary is
  read by humans" rationale does not transfer to an assertion alias.

- **The two exports need `// fallow-ignore-next-line unused-export`, and this is
  the one unverified step in the plan.** `.fallowrc.jsonc:71` records that fallow
  excludes test files as consumers, so a type imported only by a test still reads
  as unused. But the repo has ZERO precedent for that directive above an
  `export type` — all 20 uses sit above `export const` / `export function` — and
  `ci:fallow` is excluded from the local gate (`scripts/verify-gate.sh:7`), so a
  wrong rule id surfaces only in CI. Read the rule id off fallow's own output;
  do not guess it.

- **Six spellings that pass VACUOUSLY — do not use any of them.** Each is clean
  on the healthy tree AND on the seeded hole: the bare alias with no consumer;
  `type _X = Unranked extends never ? true : false`; the unconsumed
  "error object" conditional; `const _x: Unranked[] = []`;
  `const _x = [] satisfies Unranked[]`; `declare const _probe: Unranked`.
  The last two match this module's `satisfies` idiom and would survive review.

- **One spelling is a FALSE POSITIVE — the trap that leads to a vacuous ship.**
  `type Bad<T> = T extends never ? true : { UNRANKED: T }` with
  `const _x: Bad<Unranked> = true` fails on the HEALTHY tree, because a naked
  type parameter distributes over `never`. An implementer seeing red on a
  correct vocabulary concludes "too strict" and weakens it to a vacuous form.
  The tuple wrapper `[T] extends [never]` is what suppresses distribution.

- **Key on `extends null`, never on `RefusalCategory`.** Deriving
  `RankableBlockReason` via `Extract<(typeof MAP)[K], RefusalCategory>` makes the
  assertion depend on the category SET, so a future category rename fires here.
  That is the indirect re-coupling to avoid.

- **Naming.** `_`-prefixed. `eslint.config.mjs:122-126` sets
  `varsIgnorePattern: '^_'`, and `tsconfig.json` sets neither `noUnusedLocals`
  nor `noUnusedParameters`. Export it with the module's own
  `// fallow-ignore-next-line unused-export` directive — the convention this
  file already uses at `:463` and `:554`, justified at `:455-462` ("a vocabulary
  is read by humans as often as it is called"). Round 1's finding stands: a
  blanket "do not export" contradicts the module being edited.

- **A 23rd union member with no map entry** now also emits `TS2536` at the alias
  declaration, on top of the existing `TS1360` from `satisfies Record<…>`. It is
  correct but points at the assertion rather than the missing map entry. One
  comment beside the alias, so the next reader is not sent to the wrong place.

- **A member listed TWICE in precedence is NOT caught** — `Prec[number]`
  collapses duplicates and `Exclude` cannot see them (compiled: clean). It is
  out of scope, and the reason is named rather than implied:
  `vocabulary.test.ts:527` already asserts
  `new Set(precedence).size === precedence.length`, and `Array.find`
  (`vocabulary.ts:650`) makes a later duplicate unreachable anyway.

- **RED STEP, and it is stricter than "typecheck fails".** Seed the hole (remap
  `autopilot_tier_required` to a real category), run `pnpm typecheck`, and
  confirm the failure message contains that member's LITERAL NAME. A non-zero
  exit alone is satisfied by the `Bad<T>` false positive. Record the verbatim
  `TS2344` output in the deviations file as the assertion's evidence, then
  restore.

- Tests: titles 1, 2 and 5 below.

### T2 — the prose, corrected precisely and only where it is wrong

Round 1 found the plan's T2 half wrong. Corrected:

- **`vocabulary.ts:652-655` — CORRECT.** (Not `:653-656`; `:656` is the throw
  itself.) It says the branch is "unreachable while the map is total and the
  partition holds" and points at `vocabulary.test.ts`. After T1 the compiler
  carries it. Rewrite it.
- **`vocabulary.ts:615-621` — DO NOT TOUCH.** That paragraph is about the
  **`unmapped_auto_approval_block_reason`** throw at `:645`, and it already
  appeals to the compiler ("the `satisfies` clause above"), not to a test. The
  string `vocabulary.test.ts` does not appear in `:592-621`. "Correcting" it
  would mis-attribute the map's totality guarantee to the new precedence
  assertion and leave the docblock LESS accurate than HEAD.
- **`src/lib/shared/worker-types.ts:183-190` — DO NOT TOUCH, and it stays out
  of the edit surface.** Its claim ("`vocabulary.test.ts` asserts that partition
  by parsing this declaration as text") stays literally true, because
  `vocabulary.test.ts:513-540` is not modified. Round 1 verified this.

- **The `unranked_...` throw stays, and T2 must record WHY in a way that
  survives.** The plan's round-1 justification ("an assertion of a state the
  invariants exclude") is verbally identical to the justification recorded ten
  lines below at `vocabulary.ts:659-664` for **deleting** the sibling
  `veto_member_won_precedence` throw. A future reader applying that precedent
  symmetrically deletes this one. The decisive argument, which must go in the
  docblock: **`Array.prototype.find` returns `T | undefined` unconditionally and
  the compiler cannot narrow it, whatever the assertion proves about the set.**
  Removing `if (winner === undefined) throw` makes `refusalCode: winner` fail to
  typecheck. The throw is structurally REQUIRED, not defensive — and the
  realistic regression is not deletion but replacement with `find(...)!`, which
  is exactly the hidden-bug shape `working-rules.md:40-41` bans.
- Blocking edge: T1.

### T3 — nothing at run time moved, and totality is pinned as a property

- The existing `vocabulary.test.ts` partition (`:513-540`), tier-contiguity
  (`:542-553`), veto and precedence-winner assertions stay green with no edit.
- The existing `policy-gate-precedence.property.test.ts` asserts two properties:
  the veto rule and winner-∈-co-occurring-set. Neither asserts non-throwing, so
  the totality property below is new coverage, not a duplicate.
- `.claude/commands/feature.md:409` requires at least one `fast-check` property
  per declared invariant for auto-approval work. Title 5 is that property, and
  it draws from the UNION (`worker-types.ts`), not from the two arrays — so it
  is a totality claim, not the order-agreement test #1003 rejected.
- Blocking edge: T1.

## The five promised titles (verbatim — `verify-gate.sh:451-475` greps fixed strings)

1. `the precedence totality derivation rejects a precedence list missing a mapped rank`
   — in `vocabulary.test.ts`, seeding the hole in the TYPE ARGUMENT so the case
   routes through the real `RankableBlockReason` and the real precedence tuple:

```ts
type Ranks = typeof AUTO_APPROVAL_BLOCK_PRECEDENCE;
type Holed = readonly Exclude<Ranks[number], 'daily_cap_exhausted'>[];
// @ts-expect-error — dropping a rank leaves daily_cap_exhausted unranked
type _Holed = AssertNever<UnrankedIn<Holed>>;
```

   This is a PERMANENT committed proof that the derivation catches a missing
   rank, not one-shot red-step evidence. The repo has 22 `@ts-expect-error`
   uses, zero `expectTypeOf`, and no vitest `typecheck` block, so this is the
   only mechanism with repo support; test files are inside `tsconfig.json`'s
   `include`, and an unnecessary directive is itself `TS2578` — the inversion IS
   the assertion. Precedent: `src/lib/refusals/__tests__/write.test.ts:227-230`.

2. `the precedence totality derivation accepts the current precedence list unchanged`
   — `type _Whole = AssertNever<UnrankedIn<Ranks>>;` with NO directive.

3. `resolvePolicyGateRefusal still throws unmapped_auto_approval_block_reason for a code in neither list`

4. `resolvePolicyGateRefusal resolves the same winner for every locked tier after the change`

5. `invariants: no subset of the mapped non-veto block reasons in any order throws unranked_auto_approval_block_reason`
   — the `fast-check` property, and it is the property for **invariant 7** (the
   `unranked` throw). **THE POOL IS THE MAPPED NON-NULL KEYS, NOT THE 22.**
   `resolvePolicyGateRefusal` (`vocabulary.ts:643-648`) returns `null` on the
   first null-mapped member BEFORE reaching `find`, so a subset drawn from all
   22 witnesses a hole only when it contains the hole member and none of the
   seven vetoes — about 0.4% per run, ~86% over 500 runs, i.e. a ~14% false
   green on the one property meant to pin totality. The file already documents
   this trap in its own second property: *"The input is drawn from the
   precedence members ONLY, because a veto member would make the expected result
   `null` and the property vacuous."* Draw from
   `Object.keys(map).filter((k) => map[k] !== null)`.

   Source of members: the MAP KEYS, not a union parse. `unionMembers` is a
   private text-parsing helper in `vocabulary.test.ts:192` and does not exist in
   `worker/`; porting a filesystem-reading union parser into the worker property
   file would be new machinery in a type-level ticket.

## Non-goals restated as guards

- No edit to `persist.ts` or `write.ts` — #1079 owns those in a sibling worktree
  this wave.
- No reorder of the fifteen members, no member moved between tiers.
- No test coupling the precedence list to REFUSAL_CATEGORIES order, and no
  REFUSAL_CATEGORIES drift test. Those are the two #1003 rejected. The
  veto-vs-precedence exhaustiveness test at vocabulary.test.ts:513 is REQUIRED
  and stays.
- No edit to `worker-types.ts` or to `vocabulary.ts:615-621`.

## Verification

`bash .agents/skills/feature/scripts/verified-gate.sh`. The **`typecheck`** gate
row is the primary evidence. The committed `@ts-expect-error` case (title 1) is
the durable proof that the derivation fires; the red step's raw `TS2344` output
goes in the deviations file as corroboration, not as the only record.
