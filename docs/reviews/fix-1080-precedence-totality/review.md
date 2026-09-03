# Review record — `fix/1080-precedence-totality`

Fork point: `f797d25064c31997dfe400414baf99967b63315f` (unmoved; no rebase)
Round-1 reviewed SHA: `0bb77f47` · Round-2 reviewed SHA: `d3a6e562`
Production diff: 11 executable lines across 4 declarations, 86 comment, 4 blank.
**Zero runtime lines changed** — proved by byte-identical transpiled output
(4632 bytes both sides).

## The wave

`risk: high`, so the maintainability axis and the red-team pass were both
mandatory. Three members: spec/correctness, standards & maintainability, red
team. Red team then ran a scoped round 2 against the fix hunks.

**19 findings across both rounds. All ACCEPT. Zero defects in shipped
behaviour.** The type-level fix was called "sound and, unusually, over-proven".

## The central question, answered

Everything about this ticket reduces to: **does the assertion actually fire?**
The defect it fixes is a type assertion that compiles and proves nothing, and
that exact shape shipped once before on the parked `feat/refusal-log` branch.
Plan revision 1 reproduced it — the derivation computed the right answer and had
no consumer, reporting zero diagnostics on a seeded hole.

Three independent verifications, each seeding real holes:

- Healthy tree → `tsc --noEmit` exit 0, zero diagnostics; the seven veto members
  never fire.
- A mapped non-null member dropped from the precedence list → `TS2344` **naming
  that member**, at `_PrecedenceIsTotal`'s own declaration site.
- The committed `@ts-expect-error` is a **permanent** proof, not one-shot
  red-step evidence: it seeds the hole in the test's own type argument, so it
  routes through the real map and a real tuple. Two mutations that would make the
  derivation vacuous — `RankableBlockReason` → always `never`, and
  `AssertNever<T extends never>` → `AssertNever<T>`, the exact `feat/refusal-log`
  incident shape — both produce `TS2578` there.

The spec axis additionally proved zero runtime change by comparing transpiled JS
byte for byte, and did all its seeding in an extracted tree rather than the
worktree, restoring and verifying each by SHA-256.

## What review changed

**Two tests asserted nothing.** The locked-tier case derived both sides of its
comparison from the same filtered array, so it could not detect ANY reordering —
a within-tier swap passed 30/30. Tier membership now comes from the map, and
round 2 confirmed it detects a mapped-but-unranked member and an elect-by-position
mutant, while correctly documenting what it cannot catch (a within-tier swap,
deliberately unpinned; cross-tier, owned by the contiguity case). The second
duplicated a pre-existing case while claiming to pin that two faults report under
different names — it asserted only one.

**A probabilistic detector became a proof.** Three measurements of the totality
property's per-run witness rate disagreed. Rather than pick a fourth number, the
branch added a deterministic exhaustive singleton sweep: every mapped non-veto
member, alone, must resolve to itself. The singleton IS the witness. Round 2
confirmed the sweep contains no randomness, so one kill is the whole population,
and separately proved it is **scoped rather than vacuous** — it survives a
`winner = blockReasons[0]` stub, but that mutant provably preserves the invariant
under test, and two sibling cases kill it.

**Two false mechanisms.** The branch claimed dropping `as const` would make the
assertion vacuous and fire `TS2578`. Measured: zero diagnostics, and with a hole
seeded the assertion still fires — `satisfies` preserves the element literals.
The real hazard is the annotation form. Same mis-attribution corrected on
`RankableBlockReason`.

## The correction to the ticket itself

Issue #1080 states that #1003 forbade a consistency test between the veto set and
the precedence list. **That is backwards**, and building to it would have
forbidden this branch's own property test. Verified against three sources: #1003
forbade two tests about `REFUSAL_CATEGORIES` **order**, and it **required** the
veto-vs-precedence exhaustiveness test that ships today. One of those three
sources turned out to be untracked at HEAD and was dropped; the two tracked ones
carry the argument alone.

## Three iterations of one defect class

Worth recording, because it is the session's most transferable result.

1. **Round 1** found five claims the branch made about itself that were false.
2. **The fix pass** corrected them in the plan, the arch-log and the code
   comments — but **not in the intake** — and introduced three new inaccuracies.
3. **Round 2** found those, including the one real test defect: the oracle added
   to fix a vacuous test **failed a behaviour-preserving rename with a false
   message**. Renaming the resolver's loop variable made it report "the unmapped
   fault lost its own name", which is untrue. An oracle that reports a false
   cause on a refactor trains the next reader to distrust it.

The surviving intake defects were mine, not the fix agent's: its lease excluded
the intake, and I had fixed only two of its lines. Every `path:line` in the
intake is now symbol-anchored.

## Why this branch stops at `gate_green`

Red team's budget is two rounds and both are spent. Fixing round 2's findings
moved the tree, so `red-team-status.mjs` reports its evidence stale — and that
check offers no authorization escape, being a bare `git diff --quiet` whose
`authorizations` array pairs only with an `accepted-risk` finding disposition.

Owner-adjudicated 2026-09-03, on the same basis as the sibling branch: the delta
since round 2 is documentation and test-comment only, and the runtime output is
byte-identical, so the code round 2 verified is the code that ships.

`head_sha` was deliberately NOT edited — setting it to the current SHA would
assert round 2 ran against this tree, which is false. Sidecar edits, disclosed:
nine findings set to `disposition: "fixed"`, `counts` and `status` synced to the
checker's own recomputation. No evidence, reasoning, severity or SHA altered.

## Carried forward

- A member listed **twice** in the precedence list is still uncaught by the type
  (`Prec[number]` collapses duplicates). Covered at run time by the existing set-size
  assertion, and `Array.find` makes a later duplicate unreachable regardless.
- The pre-existing `fallow-ignore-next-line unused-export` on
  `AUTO_APPROVAL_BLOCK_PRECEDENCE` is now **stale**, because the test's new
  `typeof` reference is the first statically visible cross-module consumer.
  Left in place: it gates nothing, and the trigger is a fragile test-consumer
  edge that contradicts `.fallowrc.jsonc`'s own stated belief. Round 2
  re-derived the causal claim independently and confirmed it.
