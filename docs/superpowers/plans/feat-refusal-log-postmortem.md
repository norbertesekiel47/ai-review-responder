# Post-mortem — feat/refusal-log

**Outcome: the `/feature` run STOPS at step 7 (branch review, round 1 of 3).**
Owner decision, 2026-08-29: build the durable ledger first. This is the abort
path, taken on evidence rather than on exhaustion.

**Nothing is thrown away.** The branch is committed, the gate is GREEN at
`1466ffc6` (32 checks), and the owner's instruction was explicit that the
vocabulary, read and screen stay. This is a re-scope, not a teardown.

## What stopped it

The adversarial approach review (`docs/reviews/feat-refusal-log/approach-review.log`,
`VERDICT: REVISE`) argued that a **projection over six operational tables cannot
be the durable record the feature claims to be**. Three supporting facts, each
verified against the code, not accepted on the reviewer's word:

1. **`ArchivalPoller` deletes terminal `agent_runs` after 180 days**
   (`AGENT_SPINE_RETENTION_DAYS = 180`), and `solicitation_outreach`'s run FK is
   `ON DELETE SET NULL (agent_run_id)` (091:256-259). So after six months
   **every** dispatch-time S6 refusal loses its immutable anchor and falls back
   to mutable `updated_at`, where a later write can move its date between
   windows. ADR 0023 claimed this affected only the rare best-effort-attach
   case. That was wrong — see "What the plan got wrong" below.
2. **Offboarding purges the sources.** `purge-stages.ts` deletes S1/S5/S6/S7
   dependencies plus responses, runs and reviews, and scrubs S4's trigger
   payload. Correct privacy behaviour, and proof the log is not independently
   durable.
3. **Vocabulary changes retroactively re-categorise old decisions**, because no
   decision was ever recorded — only re-derived.

A fourth point, also verified: the largest selectable window is 90 days
(`DASHBOARD_WINDOWS`), so the "two-year record" framing was never reachable
through the UI even where the data survived.

## What the intake and plan got wrong

### 1. The premise was inherited, not tested

The brief's key finding — "RepWorth does NOT discard refusal reasons; the work
is to unify and surface what already exists" — was carried into the intake as a
non-goal ("no new capture layer") **without asking whether what exists is
durable enough to be the record**. It is not. Six operational tables are shaped
for the decisions they serve, with their own retention and purge lifecycles; a
two-year audit surface is a different requirement and needed its own store.

The premise was right about *availability* (the reasons are there) and wrong
about *durability* (they do not stay there). Those are different claims and the
grilling never separated them.

### 2. The retention question was never asked

The intake has 12 edge cases, 11 invariants and 74 test titles. **None of them
mentions retention, archival or purge.** Three review rounds against the plan
did not surface it either, because all three were reasoning about correctness at
write time and read time — not about what the data looks like in eighteen
months, which is exactly the horizon the feature's value proposition rests on.

The question that would have caught it: *"for each source, what deletes this row
and when?"* That is now a standing question for any feature claiming a durable
record.

### 3. The empty state made a claim the data cannot support

`RestraintReport.tsx:146` renders "We did not hold anything back… Everything we
were asked to do, we did." The highest-volume refusal lane
(`AutoApprovalBlockReason`, held-for-owner) is log-only, so an account whose
drafts were held for cap exhaustion or a rating threshold sees that sentence and
is misled.

This is the worst defect the run produced, and it is instructive: the gap was
*known* (recorded in ADR 0023 and CONTEXT.md as "we report THAT, never WHY"),
but nobody traced the consequence forward into the zero case. **A documented
limit is not a handled limit.** The copy had to change and never did, because it
was written from the same premise the limit contradicts.

### 4. The estimate missed 2×, for a legible reason

Production came in at 1,267 lines against 700. The miss was not the six arms —
it was what each arm costs once tenant isolation must be *proved* rather than
asserted: a `businesses` bridge, a child tie, a separately-spelled `inLocation`
conjunct so `ci:tenant-scope` can see it, and its own behavioural negative-row
test because one `UNION ALL` defeats structural assertions. Roughly 3× the naive
per-arm estimate. Already recorded as D15b.

## What went right, and should be repeated

- **Verifying every agent claim rather than accepting reports.** This caught a
  live-DB suite silently *skipping* (a skip is visually identical to a pass), a
  glossary term claiming "the third tab" on a page with no tab bar, and an S3
  map keyed by a six-member enum where the database stores five values.
- **Mutation-proving tests instead of trusting green.** T3 drove the tenant
  audit over two broken variants (0 findings as written, 4 without the bridge,
  2 without the child tie). T4 collapsed each half of the S6 anchor (2 and 4
  failures) and joined S4 through locations (6 failures). Those numbers are the
  evidence; "the tests pass" is not.
- **The screenshot rule earning its place.** T7's first build repeated one
  category-level link once per entry. **The eval would have passed it.** Only
  the 390px capture exposed it (D16b).
- **The three-round plan review converging 24 → 4 → 1**, correcting four factual
  errors in the brief's own source table before a line of code was written —
  including that a judge verdict is not a refusal at all.
- **`null` as an explicit mapping decision** rather than an omission, tested
  with `Object.hasOwn` rather than truthiness.

## What the next run inherits

Reusable as-is:

| Artifact | Note |
|---|---|
| `src/lib/refusals/vocabulary.ts` | The whole decision, unchanged by a ledger. 42 codes, 25→category, 17→null. |
| `src/components/dashboard/restraint/*` | Presentation over one `RefusalLog`. Empty-state copy needs the honesty fix first. |
| `src/app/api/dashboard/refusals/route.ts` | Thin composition root; re-points at a new read. |
| `AnalyticsTabs` + the restraint route | Unaffected. |
| ADR 0023 | Correct on redaction and the two-axis vocabulary; **wrong on durability** — needs the correction above. |
| The 74-title eval | Mostly survives; the six per-source arm tests become backfill tests. |

Becomes something else:

- `src/lib/refusals/read.ts`'s six `UNION ALL` arms. They stop being the read —
  but they are exactly the **one-time backfill** a ledger needs to populate
  history from existing rows, so the logic is not wasted.

## Re-classification: this is now an EPIC

The expanded scope adds a migration **and** worker write sites. By the
workflow's own trigger — "spans multiple risk domains (e.g. schema + billing +
worker)" — it is no longer feature-scale, and `/feature`'s enforcement loop
(tight edit surface, one reviewable diff, one staging ride) does not fit it.

The next step is therefore **not** another `/feature` run. It is a `wayfinder`
decomposition into separately-merged tickets, each sized to a single `/feature`.
A first cut of that map:

1. Land this branch's honest subset (vocabulary + screen + route) behind the
   corrected copy, OR park it — owner's call.
2. Migration 117: `refusal_events`, append-only, with an explicit retention
   policy and an offboarding purge stage.
3. Write path per lane, transactional with each decision — six sites, each its
   own ticket, each an outbox-pattern review.
4. Backfill from the six operational tables (this branch's `read.ts` arms).
5. Re-point the read; delete the projection.
6. Widen the window control past 90 days, without which the record is
   unreachable.

Also carry forward, independent of the ledger: the 15 unfixed round-1 review
findings in `spec-correctness.md` and `standards.md` — three of them HIGH,
including that the tab bar vanishes during load on one analytics route but not
the other, and that `AUTONOMY_SUSPENDED_EVENT_TYPE` is hand-spelled with no tie
to its writer, so a rename would empty the S4 arm with every test green.
