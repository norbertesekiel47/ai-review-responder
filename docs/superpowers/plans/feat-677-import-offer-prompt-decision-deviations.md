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
#286–#290. #677 closes the two *product* enqueue paths, so the only remaining
opening is the manual admin path — which is the one #679 exists to close.

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
