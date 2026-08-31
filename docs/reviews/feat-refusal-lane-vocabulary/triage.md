# Triage — feat/refusal-lane-vocabulary

TWO review axes, both fresh agents, both read-only, both dispatched against the
pinned fork `fab6a49c` with a green review gate behind them.

The second axis exists because of the reclassification (deviations D8): the
`reclassify` row measured 241 production lines against a 120 estimate, SMALL was
the wrong lane, and STANDARD owes spec/correctness AND
standards/maintainability. It earned its place — eight findings, four MEDIUM,
including a false claim about what `| null` buys that had been true in neither
this branch's wording nor #1009's.

| Axis | Head reviewed | Report | Findings |
|---|---|---|---|
| Spec & correctness | `0a21f352` | `spec-correctness.md` | 4 — 3 ACCEPT, 1 REJECT |
| Standards & maintainability | `a7ff420b` | `standards.md` | 8 — 8 ACCEPT |

---

# Axis 1 — spec & correctness

Four findings, none HIGH. Two accepted and fixed, one accepted and corrected in
the intake, one rejected with reasons.

---

## F1 — MEDIUM — `docs/directory.md:889` misdescribes `vocabulary.ts`

**Claim.** The row still says `AUTONOMY_SUSPENDED_REFUSAL_CATEGORIES` is "the one
lane map this slice ships" and that the file "Holds no code→category map for the
other six lanes". Both are false once this branch merges. `ci:directory-map`
checks that a row EXISTS, never that it is true, so CI stays green on a false
code map.

**Verdict: ACCEPT.** Reproduced by reading the row. The finding is exactly the
class the global rule names — green CI is not proof that documentation is true.

**Fix.** The row now names six of seven lane maps, states the `| null` rule and
what `null` means, records that the two `outreach_withheld` halves are separate
constants that must agree where they overlap, and explains why `BATCH_HALTED`
re-composes its key type instead of importing the private `LatchHaltReason`. It
still says the file holds no map for `policy_gate_held` or `held_draft`, which
remains true — both arrive with #1013.

**Cost, recorded rather than buried.** The fix needed `docs/directory.md` in the
edit surface: **surface amendment 2**, which the workflow lists as an abort
criterion. The owner waived it for a one-row documentation correction, with the
reason recorded through `feature-state.sh incr-amendment --reason`. The counter
cannot distinguish a doc correction from scope drift; the waiver is the owner
making that distinction, and it is the last amendment this branch may take.

---

## F2 — MEDIUM — a false claim in a comment this branch wrote

**Claim.** `src/lib/shared/worker-types.ts` justified moving
`AutoPolicyDowngradeReason` with "nothing under `src/lib/` imports from
`worker/` — no such import exists anywhere in the repository". About twenty
files under `src/lib/**/__tests__/` do, one of them importing the worker
production module `purge-stages`.

**Verdict: ACCEPT.** The reviewer greps; the comment asserted. The production
half of the claim is true and the move is still right, but the sentence
overstated it, and an overstated justification is how a boundary gets treated as
stronger than it is.

**Fix.** Narrowed to production modules, with the test exception named in the
comment rather than left for the next reader to discover.

---

## F3 — LOW — the intake promised a compile error it cannot deliver

**Claim.** `user_visible_behavior` said a new member of `LatchHaltReason` without
a category is a compile error. It is not: the vocabulary re-composes that union
from `OwnerHaltReason | 'admin_halt' | SystemHaltReason`, so a member added as a
bare literal to `approval.ts`'s private union widens neither import. It fails the
eval instead.

**Verdict: ACCEPT.** The guard is real but weaker than the sentence claimed, and
D2 recorded the re-composition without recording the downgrade.

**Fix.** Both intake copies now state the asymmetry as two separate behaviours —
compile error via either public union, test failure via a bare literal — and
`vocabulary.ts` carries the same distinction at the alias. Byte-identical copies
re-verified.

---

## F4 — LOW — `unsubscribed` has a category in neither outreach map

**Claim.** Migration 111's `withheld` arm admits eight codes; the dispatch and
render maps cover seven between them. `unsubscribed` is mapped nowhere, while
`dispatch.ts:146` says it is "written by other lanes".

**Verdict: REJECT.**

**Reasons.** The maps are keyed on the live TypeScript enums, and for a WRITER
that is the correct authority — a map exists to give a writer a category for a
decision it is about to record. `unsubscribed` is in no writer's enum today, so
no map owes it an entry, and adding one would assign a **Refusal category** to a
decision nothing makes. The guard against the case the finding fears is already
in place and is stronger than a speculative entry: when a lane does begin writing
`unsubscribed`, that lane's enum gains the member and its map's
`satisfies Record<Enum, …>` fails until someone decides the category. The
migration's column vocabulary is deliberately WIDER than any single writer's
enum — it is the union of every disposition the table may hold — so parity
between the two was never the contract.

**Carried forward, not dismissed.** #1010 owns the dispatch lane and #1011 the
render lane. If either finds a live `unsubscribed` writer while implementing,
that is a real gap and belongs in its deviations file.

---

# Axis 2 — standards & maintainability

Eight findings, four MEDIUM, **all eight ACCEPTED**. No rejections: every one
named either a false statement in a comment this branch wrote or a guard weaker
than its own description.

## S1 — MEDIUM — the re-export is a shim with no consumer

**Claim.** `worker/jobs/publisher/auto-policy-downgrade.ts` re-exported
`AutoPolicyDowngradeReason` and defended it with "every existing import still
resolves" — a set the reviewer measured as EMPTY, at the merge base and at head.
`working-rules.md` bans a compatibility shim with no named external consumer,
and the cited precedent `AutonomySuspensionTrigger` has no re-export at all.

**Verdict: ACCEPT.** Re-verified independently: `grep` finds the identifier in
that file, in `worker-types.ts`, and in the ledger's vocabulary and eval —
nowhere else, on either SHA. The docblock pre-defended a deletable line, which
is its own smell.

**Fix.** Re-export and its docblock deleted; the import carries a short comment
recording that nothing has ever imported it and that the ban is why. Net
negative, and the "NOT A COMPATIBILITY SHIM" protest is gone with it.

## S2 — MEDIUM — the `| null` justification was false

**Claim.** Two places said omitting `| null` is what stops "an omission from
type-checking as a decision". False. `satisfies Record<K, V>` demands every key
K whatever V is, so a missing key is a compile error in all six maps either way;
`| null` widens the value type only.

**Verdict: ACCEPT**, and it is the sharpest finding of the two axes. The claim
was load-bearing prose about a type-level guarantee, and it was wrong.

**Fix.** Both statements corrected to what the narrow value type ACTUALLY buys:
`null` is unspellable in a lane where every code is a Refusal, so nobody can
silence a lane one entry at a time. **#1009's own sentence carried the same
error and is corrected too** — it is in this file, this branch already edits the
file, and leaving a known-false adjacent sentence is exactly the defect axis 1's
F1 was about. The correction says it is a correction, so it does not read as a
silent rewrite of someone else's reasoning.

## S3 — MEDIUM — the client-safety guard covered one of three vectors

**Claim.** `vocabulary.ts` states a client-safety invariant that NO ESLint rule
covers (invariant #1's ban reaches `src/app/**` and `src/components/**`, not
`src/lib/refusals/`), so the eval is its only guard — and it filtered
`/^import\s/` alone. An `export { X } from '…'` or a dynamic `import()` would
pass silently while pulling the same graph into the browser bundle.

**Verdict: ACCEPT.** A guard weaker than the invariant it is the only guard for.

**Fix.** Three assertions instead of one: plain imports, re-exports
(`export … from` that is not `export type`), and dynamic `import(`. Each names
what it catches.

## S4 — MEDIUM — the amendment-2 row contradicted itself

**Claim.** The `docs/directory.md` row that surface amendment 2 was spent to
make true said "Each is `satisfies Record<Enum, RefusalCategory | null>`" and
then, three sentences later, that `| null` appears only where a null member
exists. Four of six maps have no `| null`.

**Verdict: ACCEPT**, with the irony noted rather than hidden: the fix for a
false doc row introduced a smaller false statement into the same row.

**Fix.** The row now says `satisfies Record<Enum, …>`, states that four of six
omit `| null`, and states what the narrow value type buys — the same correction
as S2, kept in step with it.

## S5 — MEDIUM/LOW — the future author stands in `approval.ts`, not here

**Claim.** The bare-literal `LatchHaltReason` path fails only in a distant
refusals eval, and the docblock at the site where someone adds a halt reason
mentions neither the ledger nor the map — and still said "all five".

**Verdict: ACCEPT, and this REVERSES deviation D4.** D4 left that comment alone
to avoid a surface collision with #1010. That reasoning was wrong twice:
`src/lib/solicitation/approval.ts` was in this branch's `allowed_edit_surface`
from the start, so no amendment was ever needed, and the prerequisite lands
BEFORE #1010 arms, so the collision is sequenced away regardless.

**Fix.** The docblock now says SIX with the reason the count was stale, states
why the union must stay unexported (actor classes, the pinning test), and names
the second obligation: a reason added to either public union is a compile error
in the ledger's map, one added as a bare literal is caught only by the eval —
decide the category in the same change either way.

## S6 — LOW — the regex uniqueness claim was untrue

**Claim.** `unionMembers`'s comment said "a union name is unique in its module,
so the looser anchor cannot match something else". Untrue of an unanchored
raw-text regex — and D4 routed a rewrite of `approval.ts`'s comment to #1010,
which is precisely the collision: a JSDoc line reading `* type LatchHaltReason =
…` would match before the declaration.

**Verdict: ACCEPT.** Not hypothetical; this branch's own paperwork pointed at
the collision.

**Fix.** Anchored at column zero — `(?:^|\n)(?:export )?type` — which excludes
every indented line and every comment body, since a top-level declaration always
starts at column zero in these modules. The comment now explains the anchor
instead of asserting uniqueness. (S5's fix made the collision live in this very
branch, which is why the two were fixed together.)

## S7 — LOW — nothing re-checks for an orphaned map after land

**Claim.** Five maps exist ahead of their write sites by design. If a slice is
abandoned or re-scoped, `ci:fallow` gates nothing and `ci:fallow:coverage`
cannot move on a fully-asserted constant, so an orphaned map keeps a
present-tense "Written by X (#1010)" docblock forever.

**Verdict: ACCEPT as a recorded obligation, not a code change.** There is no
mechanical check to add that would not be a worse guess than a human reading the
ticket number already in each docblock.

**Fix.** Recorded in the deviations file and in the architecture review log: if
any of #1010/#1011/#1012 is abandoned or re-scoped away from its lane, its map
is deleted in that same decision. The ticket number in every docblock is the
pointer that makes the check possible at all.

## S8 — LOW — the relocation was recorded in neither directory row

**Claim.** `AutoPolicyDowngradeReason` moved between two files whose
`docs/directory.md` rows both went unmentioned. `ci:directory-map` checks that a
row exists, never that it is true — the same blind spot as F1.

**Verdict: ACCEPT.**

**Fix.** Both rows updated: the `worker-types.ts` row records the two non-payload
unions it now holds and the rule for which worker-owned union belongs there; the
`auto-policy-downgrade.ts` row records that it keeps the behaviour, no longer
declares the union, and imports rather than re-exports it.
