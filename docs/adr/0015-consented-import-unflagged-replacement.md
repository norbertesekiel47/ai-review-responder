# ADR 0015: The consented review import ships unflagged — sequencing, not a flag, carries the rollout

## Status

Accepted — 2026-08-05 (issue #668, map #667)

## Context

`.claude/reference/env-vars.md` registers 37 `*_ENABLED` flags. Every autonomy
surface in this codebase — `TRIAGE_ENABLED`, `JUDGE_ENABLED`,
`AUTO_APPROVAL_ENABLED`, `GOVERNOR_ENABLED`, `PAST_REPLIES_VIEW_ENABLED`,
`EDIT_REPLIES_ENABLED` — sits behind one, and the reflex is to add another. This
change does not fit that shape, and adding a flag on reflex would have cost more
than it bought.

The Consented Review Import (`docs/superpowers/specs/2026-08-05-consented-review-import-design.md`)
**replaces** the unconditional first-connect backfill rather than adding a lane
beside it. A flag would therefore keep two *import semantics* live at once: the
old `GAP_CAP`/`HISTORICAL_CAP` bucketing and activation-date anchoring, the
`processReview` insertion↔generation coupling (`src/lib/reviews/process-review.ts:93`),
and both counter pairs on `zernio_backfill_runs`, all standing in parallel with
their replacements across the epic's seven implementation tickets — plus a
retirement PR at the end that nobody is watching for.

Three facts, verified 2026-08-05 rather than assumed, decide it:

| Fact | Evidence |
|---|---|
| Production has **zero** customers | `udeyaqnvpojbwgoaxwdg`: 0 accounts, 0 businesses, 0 reviews, 0 backfill runs |
| GA is still gated | #286–#290 (`ops(GA)`) all open — secrets, flag flips, external drills, dashboards |
| The old path has **no external consumer** | the repo's own pre-launch rule: delete the old path, update callers, no shim |

A flag's actual job here would be to hide an incomplete feature while the epic
lands PR by PR. That job is discharged by **ticket ordering**, at zero standing
cost. The only genuinely dangerous intermediate state on `main` is a consent gate
that exists before the prompt that satisfies it — an owner blocked from importing
with no UI to say yes. That is an edge in the dependency graph, not a runtime
condition, so it is fixed where edges are fixed.

## Decision

### 1. No feature flag. The old path is deleted, not gated

No `*_ENABLED` var is introduced for this epic, and no entry is added to
`.claude/reference/env-vars.md`. `PAST_REPLIES_VIEW_ENABLED` and
`EDIT_REPLIES_ENABLED` are untouched — they gate the pre-existing Past Replies
surface the epic reuses (map #667), not the import.

> **Update, 2026-08-08 (#678).** `PAST_REPLIES_VIEW_ENABLED` was **retired** by
> the epic's last implementation ticket. The claim above held for every ticket
> that shipped under it and is left as written; what changed is that the surface
> the epic reuses became the **Reviews list**, the import's only destination — at
> which point a flag that can `notFound()` the destination could coexist with
> `import_decision='accepted'`, i.e. an owner consents and the reviews land
> nowhere. That is this ADR's own reasoning applied one ticket later: the flag's
> only job was hiding an incomplete surface, and the surface is complete.
> `EDIT_REPLIES_ENABLED` remains and is now the **sole** gate on the edit path —
> it governs the live-Google mutation, a materially larger risk.

### 2. The ordering constraint replaces the flag, and is binding

**#677 (import offer: decision API + prompt UI) lands before or with #676
(consent gate across the three enqueue paths).** Landing #676 first puts `main`
in a state where `finalize-tx.ts`, `maybeEnqueueBackfillResume` and
`archive-location-tx.ts` all refuse to enqueue while nothing can record an
`accepted` decision. This edge is load-bearing and belongs in both tickets'
`Blocked by:` lines, not in reviewer memory.

The other intermediate states are safe by construction: #674 adds a
non-generating `processReview` path (additive — the default is unchanged),
and #675 changes selection semantics for a population that is empty in
production.

### 3. Existing backfilled businesses: none survive, in either environment

There was no production cohort to migrate. The staging cohort — two connections
to a *single* real Google Business Profile (`ChIJqb_7RPR5UDcR6xUi5sIklYk`,
zernio location `3900285370405997311`) carrying 114 never-posted RepWorth drafts,
32 ingested owner replies and 2 live RepWorth replies — was resolved by a **full
staging data reset**, executed 2026-08-05, rather than by a data clause in
migration 100:

- All 50 `public` application tables truncated (`RESTART IDENTITY CASCADE`).
- The `role='admin'` user row (`norbertesekiel@gmail.com`) captured and
  re-inserted verbatim, and its Auth identity retained — it is the staging admin
  login, not a fixture. The other four Auth identities were deleted, because
  `signUp()` returns `identities: []` for an already-confirmed email and orphaned
  identities would block re-testing with the same addresses.
- **Nothing was mutated on Google.** The 2 RepWorth-authored replies remain live
  on the GBP. This is deliberate and self-correcting: a fresh connect re-ingests
  them as external replies, which restores the §6.4 Regenerate fixtures without
  ever touching real content.

Consequence for #673: **the consent columns need no backfill clause.** Both
environments hold zero `businesses` rows, so `NOT NULL DEFAULT 'pending'` is
exact rather than a stand-in for an awkward historical population, and the
"backdate consent to `accepted`" option — which would have written a consent that
was never given into the very record the feature exists to keep honest — is moot.

### 4. Backout is `git revert`, and migration 100 is shaped to keep it sufficient

With no flag, the backout for every ticket in the epic is reverting its PR. That
is only a *complete* backout if no PR leaves the schema unable to serve the
reverted code. So:

**Migration 100 is additive-only.** It ADDs `imported_count` and `skipped_count`
to `zernio_backfill_runs` and keeps `oldest_skipped_create_time`. It does **not**
drop `gap_processed_count`, `historical_processed_count`, `gap_skipped_count` or
`historical_skipped_count`. Those four are dropped by a **separate cleanup
migration after the epic is proven on staging**.

This does not re-litigate the locked counter collapse (map #667, "Decisions so
far") — it splits it in two so that at no point during the epic does reverting
code leave the old worker INSERTing into dropped columns. That is the same 42703
class the map already flagged for migration 099, and it is the failure mode that
turns a one-command backout into an incident.

## Consequences

- **`main` is briefly incoherent mid-epic, and that is accepted.** Between #675
  and #677 a first connect would import reviews and draft nothing, with no prompt
  explaining why. With zero production accounts and GA gated behind #286–#290,
  the blast radius is empty. **If GA is scheduled before this epic completes,
  this ADR must be revisited** — that is the one input change that invalidates
  the reasoning, and it is a scheduling decision, not a code one.

- **No flag-flip runbook entry, and the `flag-flip` skill does not apply** to
  this epic despite map #667 listing it as a candidate. Removing it from the
  per-session skill list is part of #673.

- **The epic owes a cleanup migration.** Dropping the four legacy counters is
  deferred work, not cancelled work; leaving them permanently is the failure mode
  where the split becomes an excuse. It is tracked as the epic's closing ticket
  and must not be folded into an unrelated migration slot (ADR 0011 collision
  class).

- **Staging evidence starts from zero.** The Solicitation SEND-MODE epic (#617)
  lost its staging fixtures in the same reset — 212 `solicitation_asks`, 46
  contacts, 7 consent rows, 5 batches, 5 CSV uploads, including the 2026-08-05
  soak. That soak's *evidence* is already committed under
  `docs/runbooks/evidence/`, so what was lost is reproducible work (CSV upload →
  batch build), not proof. #633 re-runs its flip against clean data.

- **The two-connections-to-one-location shape is gone and should not be
  recreated.** Both staging businesses pointed at the same `google_place_id` and
  the same Zernio location, which made per-location reasoning about consent
  ambiguous exactly where invariant #9 says it must not be. Fresh connects for
  this epic get distinct locations.
