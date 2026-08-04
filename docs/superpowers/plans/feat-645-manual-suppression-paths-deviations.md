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

---

## D-A4 · 2026-08-03 · T2 — the `reason` CHECK contradicted its own test; SQL changed

**What:** the plan's Task 2 Step 1 SQL spells the non-blank guard as
`CHECK (length(btrim(reason)) > 0)`, while Task 2 Step 4's shape test asserts
*"rejects every empty-or-whitespace reason"* over `['', ' ', '\t', '\n', '   ']`.
Those two cannot both hold. Shipped as
`CHECK (reason ~ '[^[:space:]]')` — "contains at least one non-whitespace
character".

**Why:** one-argument `btrim(text)` strips **spaces only**. Verified against the
live PG16 test container while writing the migration:

```
SELECT length(btrim(E'\t')), length(btrim(' ')), (E'\t' ~ '[^[:space:]]');
 -- 1 | 0 | f
```

So a tab- or newline-only reason satisfies `length(btrim(reason)) > 0` and the
plan's own test failed on the first non-space blank (`'\t'`). The test states
the intent — an unexplained correction must abort the data-modifying CTE, and
therefore the DELETE — so the predicate was the wrong side of the contradiction.
The regex form also matches the route gate: `CorrectSchema`'s
`z.string().trim().min(1)` uses JS `.trim()`, which strips all whitespace, so
the DB backstop and the request gate now agree rather than disagreeing on tabs.

**Blast radius:** none outside T2. No call site, no service signature, no test
title changed; T4's `'   '` rejection case (spaces) behaves identically under
both predicates. The migration comment and the `**098**` migrations-log entry
both carry the reasoning.

**Verdict:** ACCEPT — a defect in the plan's SQL, corrected toward the plan's
own stated behaviour.

---

## D-A5 · 2026-08-03 · T4 — T3 left the `suppressionMatchSql` allowlist snippet stale

**What:** T4 found `pnpm ci:tenant-scope` already RED on arrival, before any T4
file existed:

```
src/lib/solicitation/suppression.ts: solicitation_suppressions: unused tenant scope allowlist entry
src/lib/solicitation/suppression.ts: solicitation_suppressions: missing account_id or business_id scope
```

T3 Step 3 added `s.scope` to the fragment's projection, and the audit keys
allowlist entries by exact `file + table + normalized SQL` — so the existing
entry stopped matching the statement it exempts. The plan's T3 has no step for
this. Fixed in T4 by updating that ONE entry's `sqlSnippet` in place (adding
`s.scope,`) and extending its reason to name the new column.

**Why it is not a renumber/removal:** the cross-worktree rule on this file is
append-only with respect to OTHER branches' entries. This entry is this
branch's own dependency (T3's statement), the edit changes no other entry, and
the entry count is unchanged by it — `ALLOWLIST_BASELINE` moved 416 → 419 for
T4's three NEW entries only (`suppressions-service.ts`: the lookup statement
against `solicitation_suppressions` and against the `accounts` display-name
join, plus the Correction path CTE against `solicitation_suppressions`).
`solicitation_suppression_corrections` needs no entry — it is not in
`TENANT_TABLES`, correctly, because P-2 gives it no account-linked column.

**Blast radius:** none beyond the audit. No runtime code changed.

**Verdict:** ACCEPT — a step the plan omitted, discovered by the audit exactly
as the plan's "do not guess the count, run it" procedure intends.
