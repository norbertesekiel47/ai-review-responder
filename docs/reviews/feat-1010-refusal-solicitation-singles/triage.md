# Triage — #1010, the three solicitation single-site lanes

Review wave, round 1, dispatched in one parallel message against the pinned fork
`06a163f0` and head `e9a6a50b`, with the review gate green (33 rows) behind it.

| Axis | Report | Findings |
|---|---|---|
| Spec & correctness | `spec-correctness.md` | 2 LOW |
| Standards & maintainability (cross-branch) | `standards-cross-branch.md` | 6 touching this branch |
| Red team | `docs/reviews/red-team/feat-1010-refusal-solicitation-singles-bb4cba/` | 3 P1, 3 P2 · 21 planted / 19 killed / 1 equivalent · **`INCOMPLETE_BUDGET`** |

**Nothing was rejected.** Two P1s fixed here (recorded as D0 in the deviations
file); the rest deferred with reasons.

---

## What did NOT survive, recorded because it is the point of the pass

Every area briefed as likely hollow measured real. The single-statement claim
dies to a loop at both the helper and the call site — the 5000-row case counts
STATEMENTS, not rows. All three clock swaps die on comparisons computed inside
PostgreSQL; **the ask swap failed by 9 ms, which a JS-`Date` comparison would
have missed entirely.** The second `ON CONFLICT` spelling dies to a source-text
comparison against both its sibling arm and migration 116. All five null-mapped
reasons die by runtime ABSENCE rather than by map assertion. Every early-return
guard removal died, and the halt write's position died.

## Coverage debt, stated rather than glossed

The pass ended **`INCOMPLETE_BUDGET`**: 21 of 39 mutation candidates were unrun
at the 30-run cap. The report records which are covered transitively. This is
recorded coverage debt, not a claim of completeness, and it is the honest reading
of a branch with three lanes and five live-DB suites.

---

## P1-A — the dispatch write's LAST position was unpinned · ACCEPT, FIXED
## P1-B — a SYSTEM halt ledger failure reached no alert path · ACCEPT, FIXED

Both are recorded in full as **D0** in
`docs/superpowers/plans/feat-1010-refusal-solicitation-singles-deviations.md`,
each re-proved by re-planting its mutation. P1-B cost surface amendment 2 of 2,
owner-approved.

## P1-C — `vocabulary.ts`'s header is now false · ACCEPT, DEFERRED

Three of its five maps gained a production caller here. **No swarm branch can fix
it** — the file is outside all three edit surfaces by construction, which is the
premise of running them in parallel — so #1010's own D3 handoff ("whichever of
#1011/#1012 lands last") cannot work either. Carried on the orchestrator as a
post-merge item.

## SC-1 — LOW — three docs attribute the kill switch to one helper · ACCEPT, DEFERRED

`.claude/reference/env-vars.md`, `docs/eservices-variables.md` and
`docs/runbooks/beta-launch-alerting.md` all say the switch is read in, and the
disabled warning emitted by, `writeRefusalEvent` alone. `writeRefusalEvents` now
does both. All three paths are off-surface; same follow-up as P1-C. (Red team
raised the third of these independently as its own P2.)

## SC-2 — LOW — the gate-clock case discriminates against only one alternative · ACCEPT, SUPERSEDED

It asserts `gate_skew_seconds > 0.3`, which separates the gate clock from
transaction START but not from a `new Date()` taken later inside
`commitWithhold`. **Superseded by P1-A's fix**, which pins the ledger statement's
position as the LAST of five in a single transaction — a later clock read inside
`commitWithhold` cannot satisfy that ordering and the skew bound together.

## Standards findings · ACCEPT, DEFERRED

- **MEDIUM — the source-text test compares only the `ON CONFLICT` clause.** The
  two statements carry separate column lists, so a nullable column added to
  migration 116 lands in one arm and silently NULLs in the other with every test
  green. The comment calling that test "the compensating control" overstates it.
  Real, and the right fix is a column-list comparison, which belongs with #1013
  when `policy_gate_held` becomes the first lane to exercise the set arm's
  `text[]` and `COALESCE` branches — both currently uncovered (also raised as a
  standards LOW).
- **MEDIUM — `RefusalEventRow`'s keys and the `AS event(...)` alias list are two
  hand-kept copies.** A renamed key falls through `COALESCE(…, NOW())` with no
  error. Same home as above.
- **MEDIUM — two contradictory positioning rules in one branch.** Four sites say
  "before the spine/outbox", one says "after everything"; "LAST, after every
  other write" is self-falsifying on the next append. P1-A's test now pins the
  dispatch ordering mechanically, which makes the prose the weaker authority
  rather than the only one. Wording cleanup deferred.
- **MEDIUM — the three byte-identical cross-lane `it` titles** (D1). The sharper
  objection than the one recorded in D1's verdict: a CI failure line names the
  wrong scope, and `-t` runs three unrelated suites. **#1011 and #1012 wrote
  per-lane titles for the same claims**, which settles that per-lane wording was
  available. Deferred as a retitle; the coverage is correct today.
- **LOW — a title claims "full microsecond precision" for a lane whose clock is a
  JS `Date`.** Borrowed from two lanes where it is load-bearing; the guard is
  `/\.\d{1,6}/`. Over-claiming title, correct test. Deferred.
- **LOW — `'REFUSAL_LEDGER_ENABLED'` re-spelled as a literal in six test files**
  while `write.ts` owns it privately and already exports `WARN_RETRY_COOLDOWN_MS`
  as the precedent for exporting it. Deferred to the same follow-up.

## Red-team P2s

- **`localeCompare` sort compared against a Postgres `ORDER BY` on a `uuid`
  column** (`write.integration.test.ts`). Latent flake, not a live failure.
  ACCEPT, DEFERRED.
- **`already_reviewed` has no producer** (D2). Pre-existing, already escalated to
  the owner; not a ledger question.
- **`beta-launch-alerting.md` attribution** — same as SC-1.
