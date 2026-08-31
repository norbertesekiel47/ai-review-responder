# Triage — feat/refusal-lane-vocabulary

One review axis, per the SMALL lane: spec & correctness, fresh agent, read-only,
dispatched against the pinned fork `fab6a49c` and branch head `0a21f352` with
the review gate already green (26/26 rows, review mode).

Report: `docs/reviews/feat-refusal-lane-vocabulary/spec-correctness.md`.

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
