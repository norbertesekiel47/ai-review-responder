# Deviations — feat-645-manual-suppression-paths

Entries the plan did not anticipate. Every one gets a triage verdict (ACCEPT /
RE-PLAN) at step 6, before any review agent is dispatched.

---

## D-A1 · Surface amendment #1 (of 2 before abort criteria fire) — plan time

**What:** added `src/lib/shared/__tests__/**` to `allowed_edit_surface` in both
intake copies.

**Why:** the repo's live-DB convention (#573, `ci:live-db-suites`) puts migration
shape suites at `src/lib/shared/__tests__/migration-NNN-*.integration.test.ts`
and their schema requirements in
`src/lib/shared/__tests__/helpers/schema-ready.ts`. Migration 098 needs both.
Two test files in one tree, mechanically required by a documented convention —
no production code is in scope there.

**Status:** applied; surfaced to the owner in the plan summary for veto.

---

## D-A2 · Known cross-worktree conflict — `scripts/ci/tenant-scope-allowlist.ts`

**What:** the `admin-console-phase3` worktree (branch `admin-console-phase3`,
4 commits + uncommitted work at plan time) also appends entries to
`TENANT_SCOPE_ALLOWLIST` and bumps `ALLOWLIST_BASELINE`.

**Agreed handling:** append-only list, so no merge order is imposed. Whichever
branch merges second rebases and **re-appends its own entries, then recomputes
the baseline from the actual entry count** — never reverting the other branch's
entries and never reusing its baseline number. The audit fails on a count
mismatch in either direction, so a botched resolution is caught by CI rather
than shipped.

**Also noted:** `src/components/admin/ui/DataTable.tsx` is owned by that
worktree right now. Task 6 reads it but must not modify it; if the admin
suppressions client needs something DataTable lacks, it renders a plain table
locally and records that here.

---

## D-A3 · Migration-number collision with #656 — resolved in #656's favour of this branch

**Recorded from the #656 session, 2026-08-03.** `/feature 656`
(`feat-656-postal-address-attestation`, the attested solicitation postal address)
armed its worktree and `feature-setup.sh` reported an overlap on
`supabase/migrations/098_*.sql` — **this branch and #656 were both claiming
098**, the ADR-0011 collision class.

Root cause: map #617 still says "Neither #644, #645 nor #657 is
migration-bearing," which this branch's own grilling superseded. The map line is
stale; this branch IS migration-bearing.

**Owner call: this branch keeps 098 and merges FIRST. #656 renumbered to 099.**
Rationale: this branch is materially ahead and renumbering it would have forced
a plan revision plus a rename of the `migration-098-*.integration.test.ts` file
the plan already cites, while #656 had written nothing.

> **Correction (recorded by the #645 session):** the #656 note gave "plan
> approved at review round 2" as part of the rationale. That was not accurate at
> the time it was written — plan review round 1 returned REVISE and was
> addressed in `711575f4`, but round 2 was stopped before producing any verdict.
> What was true: the plan was revised and the gate was green on docs-only mode.
> The 098-keeps-this-branch call stands on the other grounds above; this note
> exists so nobody later reads an approval into the record that never happened.

**Nothing on this branch changes.** Recorded here only so the merge order is
visible from both sides: **#645 → #656**. The `tenant-scope-allowlist.ts`
contention with #656 follows the same append-only handling as D-A2 above.
