# feat-677-import-offer-prompt-decision — deviations

Entries the plan did not anticipate. Each gets a triage verdict (ACCEPT /
RE-PLAN) at step 6 before review.

---

## D1 — Merge-order agreement with #679 (owner-approved at intake, 2026-08-06)

`scripts/feature-setup.sh` reported **"No code-surface overlap with other armed
worktrees"**, and that is a false negative for the pair that matters:
`/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-679-import-offer-expiry-block`
holds `.feature/intake.parked.json`, not `.feature/intake.json` — it is parked,
so the surface checker does not see it. Its declared surface **does** include
`src/lib/reviews/import-consent.ts`, which this ticket also owns.

**Agreed resolution (owner, at intake):**

- **#677 owns `src/lib/reviews/import-consent.ts`** and creates it, including
  `importConsentStateSql` — the single owner of the derived-expiry predicate
  (spec §5.3). #677 needs it for two things #679 does not cover: prompt
  eligibility, and the F3 atomic-transition `WHERE` clause on the decision
  write.
- **#679 rebases onto `main` after #677 merges** and its plan is edited, not
  just replayed: it drops the `importConsentStateSql` task and its four helper
  tests, keeping only `guardImportConsent` and the `ZernioBackfillWorker`
  wiring. Its worktree has zero implementation committed (one intake commit),
  so nothing is thrown away.
- **Merge order: #677 → #679 → #676.**

**Accepted consequence.** Between #677 and #679 landing, `main` has no
worker-side consent guard, so a hand-inserted `zernio_initial_backfill` outbox
row still imports without consent. ADR 0015 accepts exactly this class of
intermediate state ("`main` is briefly incoherent mid-epic") on the standing
condition that production holds zero customers and GA stays gated behind
#286–#290. #677 closes **all three** product enqueue paths (see D4), so the only
remaining opening is the manual admin path — which is the one #679 exists to
close.

> **Corrected 2026-08-06 (plan review round 1, F102).** This paragraph
> originally claimed the same thing while #677 gated only *two* paths, which was
> false: `reactivateLocationTransaction` is owner-reachable, not an admin seam.
> See D4.

**Note for the post-merge lab-notes sweep (step 8):** a parked worktree is
invisible to the cross-worktree surface check. "No overlap" from
`feature-setup.sh` means "no overlap with *armed* worktrees" and must not be
read as "no collision" when a parked branch is known to be in flight.

---

## D2 — Surface amendment: `src/lib/reviews/import-offer-view.ts` (auto-approved)

Adds **one** file inside `src/lib/reviews/`, a directory tree
`allowed_edit_surface` already covers → auto-approved under step 2's amendment
rule, recorded here rather than escalated. **Does not count toward the
abort-criteria amendment budget** (it widens by one file inside an existing
tree, not a new tree).

**Why a second module rather than folding it into `import-consent.ts`:** the
banner's read model joins `businesses` consent against `zernio_backfill_runs`
and `job_outbox`. `import-consent.ts` is the module **#679's
`ZernioBackfillWorker` guard imports** — dragging an outbox/run read model into
it would make the worker's dependency surface wider than the predicate it
actually needs. Split keeps `import-consent.ts` at predicate + transitions.

Both intake copies (`docs/superpowers/plans/…-intake.json` and
`.feature/intake.json`) updated in the same change.

---

## D3 — Consent inheritance needs no predicate (design simplification)

The intake framed F3 constraint 1 as "inherit the archived sibling's decision",
which reads as needing a terminal-state test (declined? expired?). It does not.
`add-location-tx.ts` copies **all three consent columns verbatim** from the most
recent archived sibling for the same `(account_id, google_place_id)`, with no
branching, and every case lands correctly:

| Sibling state | Inherited | Result on the new row |
|---|---|---|
| `declined` | `declined` | never re-offered (D8) ✅ |
| `pending`, deadline passed | `pending` + passed deadline | derives expired, never re-offered ✅ |
| `pending`, deadline live | `pending` + live deadline | the offer simply continues ✅ |
| `accepted` | `accepted` | import runs for the new row — the owner did consent for this place ✅ |

No new export on `import-consent.ts`, no terminal-state list to keep in sync
with the enum, and no branch to test in isolation. Anti-slop: assert impossible
states rather than branching around them.

**Amended 2026-08-06 (plan review rounds 1 and 3, F103/F104).** The *lineage
key* was wrong even though the no-branching claim holds. URL-mode adds store a
`google_maps_url` with a NULL `google_place_id` until `validate_place_id`
resolves it (`add-location-tx.ts:263-279`), so a place-id-only lookup misses a
declined URL-mode sibling and re-offers it.

Round 1's fix — "place id when the new row has one, else maps url" — chose the
key from the **new row only** and was still wrong: round 3 showed it misses a
new row carrying a canonical place id whose archived sibling never resolved one.
The final rule is a **disjunction over non-NULL keys**: a sibling qualifies when
`google_place_id` matches (both non-NULL) **OR** `google_maps_url` matches (both
non-NULL). Never NULL to NULL in either column. Scoped by `account_id`, ordered
`archived_at DESC, created_at DESC, id DESC` so a timestamp tie is
deterministic. Both directions are pinned by test (titles 48, 65).

---

## D4 — Surface amendment: the third enqueue gate (#676 absorbed) · **owner-approved**

**Counts as amendment 1 of the abort-criteria budget** (a new file outside any
tree the surface covered: `src/lib/locations/archive-location-tx.ts`).

Plan review round 1 (F102) established a fact the intake got wrong:
`reactivateLocationTransaction` is **owner-reachable** via
`src/app/api/locations/reactivate/route.ts:111`. Its own module header calls it
"admin re-activate" (`archive-location-tx.ts:8`), which is what the intake's
gate-scope question was framed on — so the owner's original "absorb the two
sites I already edit" answer was given on a false premise.

Left un-gated, an owner who declined could **archive the location and reactivate
it from the locations UI** to get the import anyway: a D8 violation reachable in
two clicks, no SQL required.

Re-presented to the owner with the corrected fact (2026-08-06). Decision:
**absorb all three gates; #676 is absorbed into #677** and noted on the tracker
at merge rather than retitled now.

Consequences recorded in both intake copies: `archive-location-tx.ts` added to
`allowed_edit_surface`; the "third path stays with #676" non-goal removed;
reactivation gating added to `user_visible_behavior`; estimates raised
600/1250 → 780/2100 prod/test lines. The stale header comment at `:8` is
corrected in the same edit.

---

## D5 — Test-count growth is a retitle-class change, not an amendment

`tests_to_add` grew 28 → 57 across the round-1 triage, then **57 → 70** across
the round-2 triage (revision 3's 13 added titles). **70 is the current and
authoritative count** — it is the length of `tests_to_add` in both intake copies,
and plan T0 assigns each of the 70 a suite and a live-DB verdict. Round 3's first
clerical finding was precisely that revision 3 added the 13 titles but left T0
ordering "all 57"; a resumed session that authors 57 skips every round-2 fix.
Per the workflow's abort
criteria, `tests_to_add` changes are **owner-approved deviations-file entries,
not `allowed_edit_surface` amendments**, and do not consume the budget (the
#643 lesson). Recorded here for the audit trail; the driving findings and their
accept/reject verdicts are in the plan's §6 review appendix.

Estimates were raised *with* the test growth rather than after it, so the step-5
`reclassify` row measures the diff against a post-review estimate. If the actual
diff still exceeds 2× either bucket, that is a genuine signal and step 0 gets
re-run — not a bookkeeping artifact.

---

## D6 — T0's file matrix was off by one; corrected at the start of execution (owner-decided, 2026-08-07)

Found while bootstrapping execution, before T0 was dispatched. **Revision 4
renumbered `tests_to_add` to 70 correctly but built T0's file matrix against the
old numbering**, in which the `import-consent` block held 14 titles; the intake's
holds 13. Every range from title 14 onward was therefore shifted by one.

This was not cosmetic. Four representative consequences, each of which would have
survived a green test run:

| Title | Actual subject | Where revision 4's matrix sent it |
|---|---|---|
| 14 | `finalize-tx` creates the offer, enqueues nothing when pending | `import-consent.integration.test.ts` |
| 31 | **`live DB:`** accept rolls back the consent write when the outbox INSERT fails | `route.test.ts` — a **mocked** suite |
| 49 | `ImportOfferBanner` renders the one-time wording | `add-location-tx.integration.test.ts` — a live DB suite |
| 55 | `DashboardOperationalContent` renders the banner | `ImportOfferBanner.test.tsx` |

Title 31 is the load-bearing one: a `live DB:` rollback title placed in a mocked
suite cannot falsify rollback, which is the exact failure mode §2 exists to
prevent. Three prose citations carried the same shift — titles 61 and 62 were
described **swapped**, and the eval-bar's mount check cited title 56 for what is
title 55. §2's binding/no-row citation (9–10 → 8–9), §6's `no_offer` citation
(10 → 9), and three §7 forward references were shifted too.

**Corrected matrix** now carries a per-row `Count` column, sums to 70, and
partitions 1–70 with no gap or overlap — verified mechanically, subject-matched
against every title, not by eye.

**The one owner decision.** Re-indexing preserved every row's count except the
add-location block (titles 44–48, 65), where the block boundary genuinely moved.
Owner chose **§2's rationale over the old shape**: only title 45 (no archived
sibling → stays pending) is a mocked binding assertion; all five lineage titles —
44, 46, 47, 48, 65 — run live, because the disjunction over non-NULL keys, the
`ORDER BY` tie-break, tenant scoping, and both cross-representation directions
are SQL semantics a mocked `sql` tag cannot falsify. This makes the suite match
§2's stated coverage ("consent lineage across archived siblings, incl. the
URL-mode path") verbatim, and moves title 44 out of the mocked suite where the
old 2/4 shape would have kept it.

**No plan decision reopened, no review round opened** — `planReviewRounds` stays
3. Per D5's precedent, test placement is a deviations-file entry, not an
`allowed_edit_surface` amendment, so the abort budget is untouched (still 1 of 2
used, D4).

**Why this kept recurring, worth carrying forward:** three separate revisions
mis-stated the test count or its indexing (rev 3 left "57", rev 4 fixed the count
but shifted the matrix, and the handoff kept "57" a revision longer than the
plan). A title *range* is a derived value copied by hand across four documents.
The durable fix is the one now in T0: **state the counts, assert the partition,
and re-derive the row from the intake before authoring it** — never trust a
remembered range.

---

## D7 — The analytics slice moves to #679; the intake contradicted itself (owner-decided, 2026-08-07)

Found at the start of T1, reading precedents before writing code.

**The contradiction, inside the locked intake.** `observability` required two new
events — `import_offer_created` and `import_decision_recorded` — while `non_goals`
said, verbatim: *"No migration — the Import consent columns shipped as migrations
100+101 (#673). The one-migration-in-flight slot stays free."*

Those cannot both hold. `analytics_events.event_name` carries a DB CHECK
enumerating exactly 23 names (migration 097; verified against the live test DB with
`pg_get_constraintdef`). Neither new name is in it, so an INSERT with either raises
a constraint violation. Extending it requires a migration. `ci:analytics-events`
additionally enforces code↔doc parity against `docs/analytics/events.md`, so a name
added to `ANALYTICS_EVENT_NAMES` without a doc entry fails the `lint` job. Neither
`supabase/migrations/**` nor `docs/analytics/events.md` was in
`allowed_edit_surface`, so honouring `observability` needed **two further surface
amendments** — taking the count to 3 against a 2-amendment budget and tripping the
abort criteria.

**Worse than a lint failure.** The plan had the acceptance transaction emitting
`import_decision_recorded` *inside* `sql.begin`. With no CHECK entry that INSERT
raises inside the transaction and **rolls back a legitimate consent decision** —
the owner clicks "Import my reviews", sees an error, and the offer stays `pending`.
Three plan-review rounds missed it: the events were named in T1, titled in round 2
(the self-heal emission), and never traced to the CHECK.

**Owner decision: defer the whole analytics slice to #679.** Chosen over amending
the surface (which consumes the migration slot #679 itself needs, and trips the
abort criteria) and over dropping the events permanently (which loses the
offer-created → decision-recorded ratio the intake names as *the* churn signal).

Consequences, all applied:

- `tests_to_add` **70 → 69**. The dropped title is *"GET import-offer self-heal
  records import_offer_created in the same transaction"*. Per D5 this is a
  deviations-file entry, not a surface amendment — the abort budget stays at
  **1 of 2** (D4).
- **Removing an array element renumbered the tail:** old 69 → **68**, old 70 →
  **69**. Propagated to both intake copies, T0's matrix and counts, all five
  `Turns green` lines, and every test-file header. Re-verified mechanically: 69/69
  verbatim and correctly placed, and the `Turns green` lists still partition 1–69
  with no gap or overlap.
- **`src/lib/analytics/events.ts` was REMOVED from `allowed_edit_surface`.** A
  surface *reduction*, so it costs no amendment — and it turns the deferral from a
  note a reader might miss into something the edit-surface guard enforces.
- T1, T3 and T4 lost their `enqueueAnalyticsEvent` instructions, each replaced by
  an explicit "no analytics event (D7)" plus the reason.
- **T6 must hand #679 the full slice**: migration 102 extending the CHECK, the
  `docs/analytics/events.md` entries, both names in `ANALYTICS_EVENT_NAMES` (not
  `CLIENT_ENQUEUEABLE_EVENT_NAMES` — durable server facts), the three emission
  sites, and the dropped title restored as a **same-transaction** assertion. #679
  will need its own surface amendment for the migration and the analytics doc.

**The lesson, and it is D6's from another direction:** a plan can name an artifact
(`ANALYTICS_EVENT_NAMES`) without anyone checking what *enforces* it — here a DB
CHECK plus a doc-parity audit. Three rounds reviewed the event names as a naming
question. A cited-artifact check should extend to the constraints and audits that
govern an artifact, not just confirm the artifact exists.
