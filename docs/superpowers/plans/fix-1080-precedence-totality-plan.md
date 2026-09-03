# Plan — #1080 · make the compiler prove precedence totality

Branch: `fix/1080-precedence-totality`
Intake: `.feature/intake.json` — materialized at arming by `scripts/feature-setup.sh`,
which ALSO commits the audit copy to
`docs/superpowers/plans/fix-1080-precedence-totality-intake.json`. That commit is
what makes `ci:feature-surface` enforce this branch's surface at all; without it
the audit passes vacuously and only the in-session hooks bind.
Revision 3 — after plan-skeptic rounds 1 (13 findings) and 2 (9 findings). All ACCEPT.

Revision 4 — after the branch review's thirteen accepted findings. Two changes of
substance, both recorded in place below: the totality property gained an
exhaustive deterministic companion (the probability argument it used to rest on
is gone, not restated), and two mechanism claims that credited `as const` were
corrected to `satisfies`. **Every citation in this document is anchored BY SYMBOL
— a declaration name, a test title, a gate row, a section heading — and never by
line number.** Nine of this plan's line ranges had already rotted by the time the
branch was reviewed, and one cited a file that is not tracked at `HEAD` at all.
Line numbers are what rotted; symbols are what survive a rebase.

## The defect, restated

`AUTO_APPROVAL_BLOCK_PRECEDENCE` (`src/lib/refusals/vocabulary.ts`) carries
`as const satisfies readonly AutoApprovalBlockReason[]`. That proves every LISTED
member is a valid block reason. It does not prove the converse. A member mapped
to a real category in `POLICY_GATE_HELD_REFUSAL_CATEGORIES` and forgotten here
type-checks, then throws `unranked_auto_approval_block_reason` from
`resolvePolicyGateRefusal`'s `winner === undefined` branch — inside the
response-persist transaction.

## What #1003 actually locked — the TICKET IS WRONG about this

Ticket #1080 says *"#1003 explicitly forbade a consistency test between the veto
set and the precedence list"*. That is backwards, and building to it would have
forbidden this plan's own property test. Verified against two TRACKED sources —
and only two, deliberately:

- `src/lib/refusals/vocabulary.ts`, the `AUTO_APPROVAL_BLOCK_PRECEDENCE`
  docblock, scopes "the two" to the two ORDERS: *"The two orders are independent
  on purpose, and they legitimately DISAGREE… #998 proposed a test pinning the
  two in agreement"*.
- `docs/superpowers/plans/feat-1013-refusal-policy-gate-held-plan.md`, under
  *"Two tests that must NOT be written"*, lists the two tests #1003 rejected.
  **Both are about `REFUSAL_CATEGORIES` order**: #998's consistency test, and a
  drift test asserting a `REFUSAL_CATEGORIES` reorder cannot change a category.

  > A third citation stood here through revision 3 —
  > `docs/reviews/refusal-ledger-audit/spec-verification.md` — and it is
  > REMOVED, not re-anchored. That file is **not tracked at `HEAD`**; it exists
  > only in the parent checkout's working tree, so a reader on a fresh clone
  > cannot resolve it and CI never sees it. The #1003 reinterpretation is this
  > branch's load-bearing claim and must rest on tracked evidence. The two
  > sources above carry it alone. The same untracked citation also appears in
  > this branch's intake `non_goals`, which is outside the edit surface and is
  > reported for the root to fix.

So the real constraint is narrower than the ticket states:

- FORBIDDEN: any test coupling the precedence list to `REFUSAL_CATEGORIES` order.
- REQUIRED and already shipped: the veto-vs-precedence exhaustiveness test —
  `vocabulary.test.ts`'s `'every AutoApprovalBlockReason member appears exactly
  once across the veto set and the precedence list'`.
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
  its `lint` row (`scripts/verify-gate.sh`). In CI the `lint` job runs
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
  private marker on public API, and the `POLICY_GATE_HELD_REFUSAL_CATEGORIES`
  export comment's "a vocabulary is read by humans" rationale does not transfer
  to an assertion alias.

- **The two exports need `// fallow-ignore-next-line unused-export`, and this is
  the one unverified step in the plan.** `.fallowrc.jsonc` records (in its
  comment on the test-file exclusion) that fallow excludes test files as
  consumers, so a type imported only by a test still reads as unused. But the
  repo has ZERO precedent for that directive above an `export type` — every
  existing use sits above `export const` / `export function` — and `ci:fallow` is
  excluded from the local gate (`scripts/verify-gate.sh`'s skip list), so a wrong
  rule id surfaces only in CI. Read the rule id off fallow's own output; do not
  guess it.

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

- **Naming.** `_`-prefixed. `eslint.config.mjs` sets
  `varsIgnorePattern: '^_'`, and `tsconfig.json` sets neither `noUnusedLocals`
  nor `noUnusedParameters`. Export it with the module's own
  `// fallow-ignore-next-line unused-export` directive — the convention this
  file already uses above `POLICY_GATE_HELD_REFUSAL_CATEGORIES` and above
  `AUTO_APPROVAL_BLOCK_PRECEDENCE`, justified in the module header ("a vocabulary
  is read by humans as often as it is called"). Round 1's finding stands: a
  blanket "do not export" contradicts the module being edited.

- **A 23rd union member with no map entry** now also emits `TS2536` at the alias
  declaration, on top of the existing `TS1360` from `satisfies Record<…>`. It is
  correct but points at the assertion rather than the missing map entry. One
  comment beside the alias, so the next reader is not sent to the wrong place.

- **A member listed TWICE in precedence is NOT caught** — `Prec[number]`
  collapses duplicates and `Exclude` cannot see them (compiled: clean). It is
  out of scope, and the reason is named rather than implied: `vocabulary.test.ts`'s
  partition case already asserts `new Set(precedence).size === precedence.length`,
  and the `Array.prototype.find` inside `resolvePolicyGateRefusal` makes a later
  duplicate unreachable anyway.

- **RED STEP, and it is stricter than "typecheck fails".** Seed the hole (remap
  `autopilot_tier_required` to a real category), run `pnpm typecheck`, and
  confirm the failure message contains that member's LITERAL NAME. A non-zero
  exit alone is satisfied by the `Bad<T>` false positive. Record the verbatim
  `TS2344` output in the deviations file as the assertion's evidence, then
  restore.

- Tests: titles 1, 2 and 5 below.

### T2 — the prose, corrected precisely and only where it is wrong

Round 1 found the plan's T2 half wrong. Corrected:

- **`resolvePolicyGateRefusal`'s `winner === undefined` comment — CORRECT.** (Not
  the `throw` line itself.) It says the branch is "unreachable while the map is
  total and the partition holds" and points at `vocabulary.test.ts`. After T1 the
  compiler carries it. Rewrite it.
- **The `unmapped_auto_approval_block_reason` paragraph in
  `resolvePolicyGateRefusal`'s docblock — DO NOT TOUCH.** That paragraph is about
  the **`unmapped_auto_approval_block_reason`** throw in the veto pass, and it
  already appeals to the compiler ("the `satisfies` clause above"), not to a
  test. The string `vocabulary.test.ts` does not appear in it. "Correcting" it
  would mis-attribute the map's totality guarantee to the new precedence
  assertion and leave the docblock LESS accurate than HEAD.
- **`src/lib/shared/worker-types.ts`'s `AutoApprovalBlockReason` docblock — DO
  NOT TOUCH, and it stays out of the edit surface.** Its claim
  ("`vocabulary.test.ts` asserts that partition by parsing this declaration as
  text") stays literally true, because the partition case in `vocabulary.test.ts`
  is not modified. Round 1 verified this.

- **The `unranked_...` throw stays, and T2 must record WHY in a way that
  survives.** The plan's round-1 justification ("an assertion of a state the
  invariants exclude") is verbally identical to the justification recorded a few
  lines below, at the lookup after `find`, for **deleting** the sibling
  `veto_member_won_precedence` throw. A future reader applying that precedent
  symmetrically deletes this one. The decisive argument, which must go in the
  docblock: **`Array.prototype.find` returns `T | undefined` unconditionally and
  the compiler cannot narrow it, whatever the assertion proves about the set.**
  Removing `if (winner === undefined) throw` makes `refusalCode: winner` fail to
  typecheck. The throw is structurally REQUIRED, not defensive — and the
  realistic regression is not deletion but replacement with `find(...)!`, which
  is exactly the hidden-bug shape `working-rules.md` bans under its rule against
  silencing a compiler error with an unchecked assertion.
- Blocking edge: T1.

### T3 — nothing at run time moved, and totality is pinned as a property

- The existing `vocabulary.test.ts` partition case, tier-contiguity case, veto
  and precedence-winner assertions stay green with no edit.
- The existing `policy-gate-precedence.property.test.ts` asserts two properties:
  the veto rule and winner-∈-co-occurring-set. Neither asserts non-throwing, so
  the totality coverage below is new, not a duplicate.
- `.claude/commands/feature.md` requires at least one `fast-check` property per
  declared invariant for auto-approval work. Title 5 is that property, and it
  draws from the map's non-`null` KEYS, not from the precedence array — so it is
  a totality claim, not the order-agreement test #1003 rejected.
- **Totality is proved DETERMINISTICALLY and sampled only for order.** Beside the
  property sits an exhaustive singleton sweep (`'every mapped non-veto block
  reason alone resolves to itself, exhaustively'`): for every mapped non-`null`
  member, `resolve([member])` alone must elect that member. The SINGLETON IS THE
  WITNESS — nothing else in a one-element input can veto before `find` — so
  sweeping the finite pool is a proof rather than a detector, and no per-run
  witness rate needs to be estimated, quoted, or defended. Verified against a
  seeded hole in a mirror of the resolver: caught 30/30, and the thrown message
  named the member. The property beside it is then narrowed to the ORDER and
  CO-OCCURRENCE dimension a singleton sweep cannot reach.
- Blocking edge: T1.

## The five promised titles (verbatim — the gate's `promised-tests` row greps fixed strings)

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
   rank, not one-shot red-step evidence. The repo has zero `expectTypeOf` calls
   and no vitest `typecheck` block, so `@ts-expect-error` is the only mechanism
   with repo support; test files are inside `tsconfig.json`'s `include`, and an
   unnecessary directive is itself `TS2578` — the inversion IS the assertion.
   Precedent: `src/lib/refusals/__tests__/write.test.ts`'s `occurredAt` case.

   The repo's one OTHER compile-time assertion,
   `src/lib/solicitation/__tests__/restraint-policy.test.ts`'s
   `'is sentiment-blind at the TYPE level, not only in serialized output'`, uses
   `type AssertSentimentBlind<T> = … extends never ? true : never` consumed by a
   `const … = true`. It is not copied because its failure is a `TS2322` that
   never names the offending member; naming the unranked member is this ticket's
   deliverable. That departure is recorded in the test's own docblock, so it
   reads as considered rather than missed.

2. `the precedence totality derivation accepts the current precedence list unchanged`
   — `type _Whole = AssertNever<UnrankedIn<Ranks>>;` with NO directive.

   Its anti-vacuity guard is the `@ts-expect-error` on
   `const notARank: Ranks[number] = 'moderation_held'`. **What that guard watches
   is the `satisfies` clause, NOT `as const`** — measured, and the obvious guess
   is wrong in both directions. Dropping `as const` from
   `AUTO_APPROVAL_BLOCK_PRECEDENCE` yields ZERO diagnostics, because `satisfies
   readonly AutoApprovalBlockReason[]` contextually types the elements and the
   fifteen literals survive. Respelling the declaration as a type ANNOTATION
   (`const AUTO_APPROVAL_BLOCK_PRECEDENCE: readonly AutoApprovalBlockReason[] =
   [...]`) DOES widen `Ranks[number]` to the whole union, makes the directive
   unnecessary, and fails the typecheck row with `TS2578`. The same correction
   applies to `RankableBlockReason`'s docblock, which credited `as const
   satisfies` for preserving the map's per-key literals: `satisfies` alone
   carries it, and the annotation form is the hazard.

3. `resolvePolicyGateRefusal still throws unmapped_auto_approval_block_reason for a code in neither list`

   This must assert BOTH fault names, or it is a tighter restatement of the
   pre-existing `'resolvePolicyGateRefusal throws on a code in neither the veto
   set nor the precedence list'`. The `unranked` fault cannot be provoked at run
   time — that needs a mapped member with no rank, which `_PrecedenceIsTotal` now
   makes a compile error — so its distinct name is asserted from the module's
   SOURCE TEXT, which is this file's established idiom for facts nothing can
   enumerate at run time.

4. `resolvePolicyGateRefusal resolves the same winner for every locked tier after the change`

   Tier membership is derived from the MAP's keys, never from the precedence
   array, so a mapped member with no rank still enters the input and blows up
   naming itself. The winner claim is checked for ORDER-INVARIANCE (forward vs
   reversed input, both from the resolver) rather than against a value filtered
   out of the same array the resolver reads — that earlier spelling could not
   detect any reordering at all. Cross-tier moves stay owned by
   `'AUTO_APPROVAL_BLOCK_PRECEDENCE groups its members into the six locked
   category tiers in order'`; within-tier order is deliberately unpinned, because
   `vocabulary.ts` records it carries no `vocabulary_version` obligation.

5. `invariants: no subset of the mapped non-veto block reasons in any order throws unranked_auto_approval_block_reason`
   — the `fast-check` property, and it is the property for **invariant 7** (the
   `unranked` throw). **THE POOL IS THE MAPPED NON-NULL KEYS, NOT THE 22.**
   `resolvePolicyGateRefusal` returns `null` on the first null-mapped member
   BEFORE reaching `find`, so a subset drawn from all 22 reaches the code path
   under test only when it contains no veto member — the case would be vacuous
   exactly when a veto lands in the sample, and how often that happens is a fact
   about the generator, not about the resolver. Drawing from the mapped non-null
   keys removes the question rather than estimating it. The file already
   documents this trap in its own second property: *"The input is drawn from the
   precedence members ONLY, because a veto member would make the expected result
   `null` and the property vacuous."* Draw from
   `Object.keys(map).filter((k) => map[k] !== null)`.

   The totality claim itself is carried by the exhaustive singleton sweep beside
   this property, not by this property's sampling; see T3.

   Source of members: the MAP KEYS, not a union parse. `unionMembers` is a
   private text-parsing helper in `vocabulary.test.ts` and does not exist in
   `worker/`; porting a filesystem-reading union parser into the worker property
   file would be new machinery in a type-level ticket.

## Non-goals restated as guards

- No edit to `persist.ts` or `write.ts` — #1079 owns those in a sibling worktree
  this wave.
- No reorder of the fifteen members, no member moved between tiers.
- No test coupling the precedence list to REFUSAL_CATEGORIES order, and no
  REFUSAL_CATEGORIES drift test. Those are the two #1003 rejected. The
  veto-vs-precedence exhaustiveness test — `vocabulary.test.ts`'s `'every
  AutoApprovalBlockReason member appears exactly once across the veto set and the
  precedence list'` — is REQUIRED and stays.
- No edit to `worker-types.ts`, and none to the
  `unmapped_auto_approval_block_reason` paragraph of `resolvePolicyGateRefusal`'s
  docblock.
- No runtime line changes anywhere. The branch's defining property is that the
  transpiled JS is byte-identical to its fork point.

## Verification

`bash .agents/skills/feature/scripts/verified-gate.sh`. The **`typecheck`** gate
row is the primary evidence. The committed `@ts-expect-error` case (title 1) is
the durable proof that the derivation fires; the red step's raw `TS2344` output
goes in the deviations file as corroboration, not as the only record.
