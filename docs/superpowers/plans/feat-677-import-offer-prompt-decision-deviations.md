# feat-677-import-offer-prompt-decision — deviations

Entries the plan did not anticipate. Each gets a triage verdict (ACCEPT /
RE-PLAN) at step 6 before review.

**Step-6 read-back completed 2026-08-07. All nine entries: ACCEPT. Zero
RE-PLAN, so the abort criteria are not engaged.** Each verdict below was
checked against code, not against this file's own prose — the specific
command evidence is named on each line. Standing totals confirmed at
read-back: surface amendments **1 of 2** (D4 only), `planReviewRounds` **3**
(exhausted), `tests_to_add` **69**, `open_questions` **[]**.

---

## D1 — Merge-order agreement with #679 (owner-approved at intake, 2026-08-06)

**VERDICT: ACCEPT.** Owner-agreed at intake; the interim opening is exactly the
class ADR 0015 R2 accepts, and it narrows rather than persists (#679 closes it).
Verified this branch does create the file it claims to own —
`src/lib/reviews/import-consent.ts`, +365 lines, new in the diff stat.

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

**VERDICT: ACCEPT.** One file inside a tree the surface already covered → step
2's auto-approval rule, correctly not charged to the budget. The split reason
holds and is load-bearing for #679: `import-offer-view.ts` reads `job_outbox`
and `zernio_backfill_runs`, neither of which the worker guard needs. Verified
both intake copies carry the path and are byte-identical (`diff` clean,
sha256 matches `state.json`'s `intakeSha256`).

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

**VERDICT: ACCEPT.** The no-branching claim and the twice-corrected lineage key
both hold in code. Verified at `src/lib/locations/add-location-tx.ts:293-303`:
the sibling lookup is a disjunction over non-NULL keys
(`google_place_id IS NOT NULL AND … = $x` **OR** `google_maps_url IS NOT NULL
AND … = $y`), never NULL-to-NULL, with the deterministic
`ORDER BY ab.archived_at DESC, ab.created_at DESC, ab.id DESC` tie-break the
entry describes.

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

**VERDICT: ACCEPT.** Re-presented to the owner on the corrected fact and
re-decided — the archive→reactivate bypass it closes was reachable in two
clicks. Correctly charged as amendment **1 of 2**; that remains the only charge
against the budget. Note for review: the entry says "all three gates", the
glossary and the shipped code say **four** product enqueue paths (the decision
route itself is the fourth). Same scope, two countings — the review agents get
the intake, which is authoritative.

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

**VERDICT: ACCEPT.** Correct reading of the abort criteria (the #643 lesson):
`tests_to_add` changes are deviations-file entries, not `allowed_edit_surface`
amendments. The count it calls authoritative (70) has since moved to **69** under
D7 — that supersession is recorded there, not a contradiction here.

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

**VERDICT: ACCEPT.** Caught before T0 dispatched, so no test was authored into
the wrong suite. Title 31 is the one that mattered — a `live DB:` rollback
assertion in a mocked suite cannot falsify rollback — and it now lives in
`route.integration.test.ts`. The step-5 `promised-tests` row (PASS, 69/69
verbatim) independently confirms the corrected partition.

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

**VERDICT: ACCEPT** — and this is the entry that came closest to RE-PLAN, so the
reasoning is recorded rather than assumed. It drops an item the locked intake's
`observability` named, which is normally abort-criteria territory. It is not,
for three reasons: the two fields were **mutually unsatisfiable as locked**
(`observability` demanded a migration `non_goals` forbade), so something had to
give and only the owner could choose which; the owner chose, on the record; and
the choice **preserved** the binding constraint (no migration, slot stays free
for #679) while deferring the softer one. The alternative — amend the surface for
`supabase/migrations/**` and `docs/analytics/events.md` — would have taken
amendments to 3 against a budget of 2 and tripped the abort criteria to buy
telemetry.

The severity claim checks out too: the plan had the emission **inside**
`sql.begin`, so a CHECK violation would have rolled back a legitimate consent
decision — a silent correctness bug, not a missing metric.

Verified the deferral actually holds in code, not just in prose: `git diff
origin/main...HEAD` adds **zero** `enqueueAnalyticsEvent` call sites. The one at
`finalize-tx.ts:171` is the pre-existing `gbp_connected` emission, untouched by
this branch (the symbol does not appear on any `+` line of the diff), and
`src/lib/analytics/events.ts` is absent from `allowed_edit_surface` so the
edit-surface guard enforces the deferral rather than trusting it.

**Carried into review:** `observability` now promises three structured log
lines instead. The spec agent must confirm those exist — a deferral that quietly
took the *replacement* signal with it would leave the feature unobservable.

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

---

## D8 — Surface amendment: `select-location/__tests__/**` (owner-approved, 2026-08-07)

**VERDICT: ACCEPT.** Test-only, and the mechanical fallout of D4's
already-approved production scope — charging it would have tripped the abort
criteria on a one-line test fix, which is precisely the failure mode the #643
lesson names. The `importConsent` harness knob defaulting to `'pending'`
(migration 100's DEFAULT) is the right default: a test must opt IN to the
enqueue, so a future test cannot inherit consent by omission.

Found running T3's suites. Gating producer 1 (`finalizeConnectionTx`) broke one
test in a suite that is **not** the producer's own:
`src/app/api/zernio/connect/select-location/__tests__/route.test.ts` — *"uses
account subscription fields under a row lock when enqueueing initial backfill"*.
That route is a CALLER of `finalizeConnectionTx`, and its test asserted the
unconditional enqueue that D4 deliberately replaced with a consent gate.

**Amendment:** `src/app/api/zernio/connect/select-location/__tests__/**` added to
`allowed_edit_surface` in both intake copies. **Test-only** — no production file in
that directory is touched by this ticket.

**The fix, one knob:** that suite's hoisted harness had its own `needsBackfill`
scenario field driving a `needs_backfill` mock branch. Both are gone with the
predicate; the harness now carries `importConsent` (default `'pending'`, migration
100's DEFAULT, so a test must opt IN to the enqueue) and the one affected test sets
`'accepted'` because it is about the row lock and the payload, not the gate.

**Budget:** owner accepted the reading that this does **not** consume the
2-amendment budget — it is the mechanical test fallout of already-approved scope
(D4 gated all three producers; this route calls producer 1), the same reasoning
D5 and D6 used for test-placement changes. **Still 1 of 2 used (D4).** Had it
counted, the abort criteria would have tripped on a one-line test fix.

**Related, and inside the surface already:** two other suites needed the same
treatment and got it without an amendment —
`finalize/__tests__/finalize-modules.test.ts` (its two `needs_backfill`-named tests
were REMOVED, not ported: they named a predicate this ticket deletes, and titles
14–19 in `import-offer-junction.test.ts` are their replacement) and
`locations/__tests__/archive-location-tx.test.ts` (gained the same `importConsent`
knob, defaulting to `'accepted'` there so its pre-existing reactivation tests keep
asserting the enqueue they were written for).

**Worth carrying forward:** the plan sized T3 as "the third gate is one added
conjunct". True of the production edit. What it did not size is that a
behaviour-changing gate invalidates assertions in every suite that exercises a
CALLER of the gated function — and callers' suites are not in the producer's
directory, so they are not in the producer's surface either. When a future task
gates an existing side effect, budget for caller-suite fallout at intake.

---

## D9 — Audit-config and consumer-test amendments (owner-approved, 2026-08-07)

**VERDICT: ACCEPT**, on D8's reading — all four paths are consequences of settled
scope, and the `tenant-scope` batch is a net **shrink** (two suppressions
deleted, baseline 420 → 418). Both production findings verified in code:
`importConsentStateSql` takes no interpolation and hard-codes the `b.` alias
(`import-consent.ts:98-104`), and `readImportOfferView` scopes run rows to
`run_reason = 'initial'` (`import-offer-view.ts:96`) with the reasoning in its
header.

**Two things this entry hands forward to review rather than settles.** The
`b.`-alias contract is now a naming convention four producers must honour with
no compiler or audit enforcing it — a caller aliasing `businesses` differently
compiles clean and derives consent from the wrong row. The mitigation is
`import-consent-lock-order-source.test.ts`; whether it actually binds all four
call sites is a review question, not a deviations claim. Separately, the live
UNIQUE partial index — not the plan — is what surfaced the reactivation-recurrence
bug; that the banner would otherwise have flipped back to "Importing your
reviews…" months later is the strongest argument on this branch for the four
live-DB rows being non-negotiable at the step-5 gate.

Four more paths, all forced by T3/T4's approved production changes. Owner approved
both batches; like D8 they are consequences of settled scope, not new scope.

**Batch 1 — `scripts/ci/tenant-scope-allowlist.ts` + `scripts/ci/static-policy-audit.ts`.**

- **Deleted two `tenant-scope` allowlist entries** whose `sqlSnippet` is the
  verbatim `needs_backfill` SELECT that T3 removes from `finalize-tx.ts`, and
  dropped `ALLOWLIST_BASELINE` **420 → 418**. Not optional: the audit fails on
  *unused* entries, so deleting the query it described forces deleting the entry.
  A **shrink** — two fewer suppressions in the tree.
- **Moved one `static-policy` entry, `shared.ts:112` → `:137`.** The allowlist is
  keyed `file:line`, and wrapping `maybeEnqueueBackfillResume` in `sql.begin` +
  a businesses row lock (round-2 F107) pushed the `IN ('active','trialing')`
  predicate down 25 lines. Same literal, same rule, same annotation.

**Batch 2 — `worker/ingress/__tests__/**` + `scripts/ci/__tests__/**`.**

- `stripe-activation-enqueue.test.ts` (4 tests): asserted the post-activation
  resume enqueues unconditionally. It is consent-gated now, and the suite's
  `sqlReturnQueue` is a **strict FIFO**, so the three new statements (row lock,
  `createImportOffer`, `readImportConsent`) had to be fed in exact order — a
  missing entry silently shifts every later result onto the wrong query. Also
  bumped three `expectExactSqlCalls` 22 → 25, and one 21 → **22** (the tier guard
  throws right after the target SELECT, so offer/consent never run — the +1 vs +3
  asymmetry *is* the assertion that "before the child outbox INSERT" still holds).
- `static-policy-audit.test.ts` (1 test): hardcoded `shared.ts:112` as a sample
  allowlist member. Retargeted to `:137` with a note that these are samples, not a
  contract, and that `file:line` keys shift on any insertion above them.

**Two production findings that came out of this, both kept:**

1. **`importConsentStateSql` lost its `alias` parameter.** It injected the alias via
   postgres.js's identifier form `db(alias)` — correct against real Postgres, but
   the four producers' suites use hand-rolled `sql` mocks that implement only the
   tagged-template call form, so `db('b')` arrived as a bare string and died on
   `strings.join is not a function` across several directories. A fragment called
   from four producers must not require every mock in the repo to grow identifier
   support: the alias is now a fixed contract (callers alias `businesses` as `b`)
   and the fragment takes no interpolation at all.
2. **`ci:tenant-scope` strips subqueries before analysing predicates**, so a
   `business_id` bound inside `EXISTS (…)` is invisible to it and the table reads
   as unscoped. Three sites were restructured to bind tenant keys in **top-level**
   predicates: `createImportOffer` joins the junction halves instead of testing
   them with `EXISTS` (safe — `accounts.id` is the PK and
   `zernio_connections_one_active_per_business` makes an active row unique per
   business); `finalize-tx`'s completed-run guard became its own statement ahead of
   the INSERT; and `import-offer-view` uses a `LEFT JOIN` for the run row plus a
   second, conditional query for the newest outbox row.

**Also surfaced by a live fixture, and it changed behaviour:** the DB carries
`zernio_backfill_runs_one_initial_per_business`, a UNIQUE partial index on
`(business_id) WHERE run_reason = 'initial'`. A fixture seeding two `initial` runs
was rejected, which exposed that **reactivation runs recur by design** — so
"newest run wins" would have flipped the banner back to "Importing your reviews…"
every time an archived location was reactivated, months after the one-time import
finished. `readImportOfferView` now scopes run rows to `run_reason = 'initial'`.
The plan did not specify this; the constraint found it.

**Budget:** owner approved both batches on D8's reading — mechanical consequences
of approved scope do not consume the 2-amendment budget. **Still 1 of 2 used (D4).**

---

## D10 — Round-1 review: three owner decisions (owner-decided, 2026-08-07)

Step 7 round 1 ran three axes (spec `APPROVE WITH CHANGES`, standards
`REQUEST CHANGES`, Codex adversarial `needs-attention`). Triage is in
`docs/reviews/feat-677-import-offer-prompt-decision/triage-round-1.md`: 10
accepted, 5 rejected with reasoning, 3 escalated. The three escalations and the
owner's calls:

**1. Ship order — RE-AFFIRMED.** Codex returned a no-ship on the ground that
consent is not enforced at the worker trust boundary. Correct, and already
known: D1 + ADR 0015 R2 + the `Import consent` glossary entry all record that the
fail-closed guard is #679's. Its own remedy ("hold behind a rollout gate until
#679 is deployed") is materially what ADR 0015 R2 decided. Premises re-checked
at review time and all still hold — production holds zero customers, GA stays
gated behind #286–#290, and the only remaining opening is the manual admin path
that #679 exists to close. **Merge order #677 → #679 stands.**

**2. Enqueue triplication — EXTRACT NOW.** See D11.

**3. Inheritance bypassing the junction — FIX, with a refinement the owner's
chosen option required.** See D12.

---

## D11 — The recorded `ci:outbox-seam` blocker was false (owner-decided, 2026-08-07)

The handoff's "Decided from the code" section recorded, as settled: *"The outbox
enqueue is a raw `INSERT INTO job_outbox`. No helper exists for
`ZERNIO_INITIAL_BACKFILL`; minting one turns every raw producer red under
`ci:outbox-seam`."* Round 1's standards axis called this false; verified, and it
is.

**What the audit actually does.** `scripts/ci/outbox-seam-audit.ts:84` pins
`HELPER_MODULE` to `src/lib/shared/job-outbox-helpers.ts`, and `:458` derives the
helper-topic key set **only** from that file. So the true statement is narrower
than the recorded one:

- Minting a helper **in `job-outbox-helpers.ts`** → every raw `ZERNIO_INITIAL_BACKFILL`
  producer turns red and must migrate in the same PR. This part was right.
- Extracting a shared function **anywhere else** → the audit does not see a
  helper, one raw `INSERT` remains for a topic with no helper, which is legal
  under invariant #2's carve-out. **CI stays green.**

The recorded reasoning conflated the two, and the cost was three copies of the
enqueue across three directories with the completed-run guard spelled three
different ways.

**Not a cosmetic cost.** The copies had already diverged: the three gates
suppress on **any** completed run while `readImportOfferView` scopes to
`run_reason = 'initial'`, so a completed *reactivation* run permanently
suppresses an initial import the banner still reports as `importing`, on a 4s
poll, forever. Found independently by two axes (spec #4, standards #7).

**Owner decision: extract `enqueueInitialImport` into `import-consent.ts` now**,
in this ticket, rather than ticket it. Reasoning recorded because it cuts against
the small-diff bias: the divergence has already produced a real bug, the fix for
that bug edits those same predicates anyway, and doing both in one pass is less
total risk than two. It also hands #679 **one** chokepoint to put its
fail-closed guard behind instead of four.

**No surface amendment** — every file involved is already in
`allowed_edit_surface`. Budget stays **1 of 2 (D4)**.

---

## D12 — Inheritance must not carry a LIVE deadline; the first-choice fix would have tripped the abort criteria (owner-decided + orchestrator correction, 2026-08-07)

**The defect.** `add-location-tx.ts:280-306` copies `import_offer_expires_at`
straight from the archived sibling — a direct write to the deadline column that
bypasses `createImportOffer`, the module whose own header states it proves both
junction halves *"because the callers do not check, so the helper must."*
Inheritance is a caller that writes the column without going through it.

Confirmed reachable, three steps each verified against code: the copy at
`add-location-tx.ts:280-306` (no junction predicate) → `import-offer-view.ts:105-109`
returns `state: 'offer'` for any `pending` row with a non-NULL live deadline (no
junction check) → `recordImportDecisionAndEnqueue`'s guard is `pending AND
IS NOT NULL AND > now()` (no junction check, by design). So: archive a location
holding a live unanswered offer, re-add the same place, and the new row presents
an answerable offer with **no active `zernio_connections` row**, possibly before
its own activation. Accepting enqueues an import the worker cannot service.

**Severity, stated precisely.** Not a consent violation — the owner genuinely was
offered the import for that place, and nothing imports without their Yes. The
blast radius is an enqueue for an unconnected location, which fails visibly. It
is a broken invariant, not unauthorized access.

**The correction that matters for the next session.** The owner chose "inherit
the decision, leave the deadline NULL". Presented that way it was incomplete:
leaving the deadline NULL for an *expired* sibling makes the re-added row
eligible for a fresh offer, and `user_visible_behavior` locks the opposite,
verbatim — *"Re-adding a location whose archived row … had declined **or let the
offer expire** does not re-offer the import; the new row inherits that
decision."* Per step 5's abort criteria, a deviation that invalidates a locked
intake decision means post-mortem and teardown. The option as literally stated
would have aborted the branch to fix a Medium.

**The rule actually implemented** — delivers the owner's intent, preserves every
locked behaviour: **copy the deadline only when it is already in the past; leave
it NULL when it is live.**

| Sibling state | Deadline | Result | Status |
|---|---|---|---|
| `declined` | irrelevant | never re-offered | locked ✅ |
| `accepted` | irrelevant | import runs for the new row | locked ✅ |
| `pending`, deadline passed | **copied** | derives expired, never re-offered | locked ✅ |
| `pending`, deadline live | **NULL** | fresh offer at the new row's OWN junction | **hole closed** |

D3's "no branching, copies all three verbatim" gives way to one `CASE`. That is
a demotion of an aesthetic argument by evidence: D3's case was "every case lands
correctly", and the live-pending case does not.

**Test consequences** (deviations-file entries per D5, NOT surface amendments —
budget stays **1 of 2**):

- **Title 48 retitled.** Was *"add-location copies accepted and live-pending
  sibling consent verbatim including both timestamps"* — "verbatim including
  both timestamps" is now false for the live-pending half.
- **One title added, 69 → 70**, pinning the expired case: the past deadline IS
  copied, so the row still derives expired. That is the regression guard for the
  locked `user_visible_behavior` item this deviation came within one option of
  breaking.

**Codex's wider claim is separately rejected** — that inherited `accepted` causes
a second import for the same place. Reviews are stored per `business_id`; a
re-added row has zero reviews and genuinely needs its inventory. D3's table is
right about that.

---

## D13 — One stale JSDoc is deliberately left for #679 (surface-budget decision, 2026-08-07)

Round 1 (standards #4) found three JSDocs still describing the `needs_backfill`
predicate this diff deletes. Two are fixed here (`finalize-tx.ts:30`,
`worker/ingress/stripe/shared.ts:79`). The third, **`src/lib/shared/worker-types.ts:226-227`,
is NOT** — `src/lib/shared/**` is not in `allowed_edit_surface` (only
`src/lib/shared/__tests__/**` is), so touching it would be **amendment 2 of 2**,
and a 2nd surface amendment is itself an abort trigger.

Spending the teardown budget on a comment is the wrong trade. Handed to #679,
which already needs its own amendments for the migration and the analytics doc.
CLAUDE.md's "grep the filename to clean every cross-reference in the same change"
is knowingly and narrowly broken here, with the reason recorded.

---

## D14 — O3's blast radius reached three audit/caller files the brief did not name, and moved one behaviour by a hair (2026-08-07, fix batch A)

**No surface amendment.** Every file below is already inside
`allowed_edit_surface`; budget stays **1 of 2 (D4)**. Recorded because the fix
brief for batch A scoped itself to four production files plus their own suites,
and the extraction could not stop there.

**1. `ci:tenant-scope` — four entries deleted, `ALLOWLIST_BASELINE` 418 → 414.**
All four described `maybeEnqueueBackfillResume`'s resume SELECT. Removing the
`NOT EXISTS` completed-run subquery (it lives in `enqueueInitialImport` now,
scoped to `run_reason = 'initial'`) made the `zernio_backfill_runs` entry unused,
and the audit fails on unused entries — so the deletion was forced, not
optional. The remaining three went with it: the narrowed eligibility SELECT
binds `zc.business_id`, `b.account_id` and `a.id` in TOP-LEVEL predicates, which
is exactly what the audit can see, so it needs no suppression at all. A
**shrink**, same shape as D9 batch 1.

**2. `ci:static-policy` — the line-keyed carve-out moved `:137` → `:147`**
(`worker/ingress/stripe/shared.ts`, the `IN ('active','trialing')` predicate),
plus the sample assertion in `scripts/ci/__tests__/static-policy-audit.test.ts`.
Second move inside this ticket; the first was round-2 F107. Nothing else to do
about it — the allowlist is keyed `file:line` by design and its own comment says
so.

**3. Three caller suites, not the producers' own.** D8's lesson repeating
exactly: a change to a producer invalidates assertions in suites that exercise
its CALLERS, and those suites live in other directories.
`select-location/__tests__/route.test.ts` and `finalize/__tests__/finalize-modules.test.ts`
assert the initial-backfill payload, which is now resolved inside
`enqueueInitialImport` rather than spelled by `finalizeConnectionTx` — both
needed a mock branch for the new statement.
`worker/ingress/__tests__/stripe-activation-enqueue.test.ts` is the strict-FIFO
one: three `expectExactSqlCalls` went 25 → **26**, and the tier-guard test stayed
at 22 — that +1 vs +4 asymmetry is still the assertion that the guard throws
before the child outbox INSERT.

**4. One deliberate behaviour delta, in the Stripe resume path only.**
`createImportOffer` used to sit *behind* the target SELECT, so a business with a
completed backfill run never reached it. The completed-run guard now lives after
offer creation, inside the shared enqueue, so `createImportOffer` runs in that
case too. Assessed and kept rather than reconstructed:

- it can still only act on a `pending` row with a NULL deadline **at the
  junction** (both halves proven in its own SQL), so the population is "legacy
  row that already imported but was never offered anything" — pre-GA, zero
  customers;
- `finalizeConnectionTx` has always called `createImportOffer` before any
  completed-run check, so this makes producers 1 and 2 agree rather than diverge;
- it is the same argument as round-1 F106, which put offer creation *ahead* of
  the `zernioPublishingEnabled()` return: creation is durable state the owner is
  entitled to, and gating it on something that gates the ENQUEUE loses the offer
  with no replay path.

**5. Cost.** The shared enqueue re-reads its payload from the database under the
caller's row lock instead of taking it as six parameters. That is +1 statement on
the Stripe path (finalize is unchanged — it traded its completed-run SELECT for
this one). Chosen deliberately: three producers previously reached the enqueue
holding three different snapshots of the same facts, and a six-field parameter
list can only *ask* a caller to have checked the junction. Re-reading makes an
enqueue for an unconnected, unactivated or archived business unrepresentable.
