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

---

## D-A6 · 2026-08-03 · T5 — the owner route's `../../location-scope` import fails lint

**What:** T5 Step 3's route body imports
`{ requireContactsWriteAccess, resolveContactsScopedId } from '../../location-scope'`.
That is one level deeper than the sibling `[id]/route.ts` precedent it mirrors,
and `@typescript-eslint/no-restricted-imports` rejects it:

```
'../../location-scope' import is restricted — No ../.. parent-traversal for
src-internal imports — use @/ path aliases
```

**Fix:** `@/app/api/dashboard/contacts/location-scope`. Same module, so the
route suite's `vi.mock('../location-scope', …)` still intercepts it (the two
specifiers resolve to one absolute id) — proven by the mocked-repo call
assertions, which would not fire if the real gate had run.

**Blast radius:** one import line. No behaviour change.

**Verdict:** ACCEPT — the plan's snippet was written at the sibling route's
depth and not re-checked one directory down.

---

## D-A7 · 2026-08-03 · T5 — the owner routes' flag-gate test lives in `flag-404.test.ts`

**What:** T5 Step 5 lists "returns the feature-disabled 404 before attempting
owner authentication" among the tests for
`src/app/api/dashboard/contacts/__tests__/suppression-route.test.ts`. It is
instead covered by registering `POST`/`DELETE
/api/dashboard/contacts/[id]/suppression` in the existing
`src/app/api/dashboard/contacts/__tests__/flag-404.test.ts` route table.

**Why:** that file's header states the convention outright — "Every
/api/dashboard/contacts/* route registers here … so the flag gate stays covered
in one place" — and it already asserts the gate fires *before* auth
(`expect(mockRequireWritableOwner).not.toHaveBeenCalled()`), which is the exact
claim the promised title makes. Writing it a second time in
`suppression-route.test.ts` would need that file to un-mock `../location-scope`
mid-suite and would leave two owners of one fact. The other two Step 5 extras
(same-origin enforcement, id derivation from authenticated scope only) ARE in
`suppression-route.test.ts`; the same-origin one swaps the identity
`withSameOrigin` stand-in for the real wrapper via `vi.doUnmock` +
`vi.resetModules` and asserts both the 403 and a non-vacuous 200.

**Blast radius:** test placement only. The gate is covered either way, and the
two new routes are now in the shared table that future contacts routes join.

**Verdict:** ACCEPT — follows the repo convention the target file documents.

---

## D-A8 · 2026-08-03 · T7 — the confirm step is on the safe direction, not the risky one

**What:** the plan puts a confirm step on **marking** do-not-contact and none on
**clearing** it. T7 implemented it exactly as specified and flagged the
asymmetry rather than silently "fixing" it.

**Why it is backwards:** marking is the safe direction — it stops mail, and a
mis-click costs one click to undo. Clearing is the direction with consequences:
it resumes review requests to a contact the owner deliberately marked
do-not-contact, and a mis-click is not visible anywhere afterwards. Guarding the
harmless direction while leaving the consequential one one-click is the wrong way
round.

**Resolution:** put a confirm step on clearing too, with **different copy** from
the marking confirm. §7.6 requires the two controls not read as the same thing,
so identical confirm dialogs would themselves be a defect — the clear confirm
names what resumes ("We'll start including this contact in review requests
again"), the mark confirm names what stops.

Note this is an owner clearing THEIR OWN account-scoped row. A global row still
renders no control at all, so no confirm can exist on that path by construction.

**Verdict:** ACCEPT — implemented as a T7 follow-up, in scope for §7.6.

---

## D-A9 · 2026-08-03 · gate harness — two integration suites collide on one coverage directory

**What:** `scripts/verify-gate.sh --review` reported
`integration-src-lib-solicitation---tests---contacts-` **FAIL** with
`ENOENT: lstat '.feature/coverage/src-lib-solicitation---tests---contacts-/.tmp'`.
Not a test failure: the same run showed TWO rows with that identical name, only
ONE log file existed, and four coverage directories existed for five suites.

**Root cause:** the gate derives a per-suite key by sanitizing the test path and
truncating it (~40 chars). `contacts-do-not-contact.integration.test.ts` and the
pre-existing `contacts-repo.integration.test.ts` both live in
`src/lib/solicitation/__tests__/`, so both truncate to
`src-lib-solicitation---tests---contacts-`. The two suites then share one
coverage output directory and race on `.tmp`. Only reproducible with coverage
enabled (`--review`), which is why the four earlier plain-gate runs were green.

**Fix applied here:** renamed the new suite to
`owner-do-not-contact.integration.test.ts` (key
`src-lib-solicitation---tests---owner-do`). In-surface, no test title changed,
and it is the better name anyway — the suite covers the owner do-not-contact
paths, not contacts generally. Plan references updated in the same change.

**The underlying harness bug is NOT fixed** and will recur for any two suites in
one directory sharing a ~40-character prefix. `scripts/verify-gate.sh` is outside
this feature's `allowed_edit_surface`, and widening it would have burned the
second surface amendment on unrelated tooling. **Promote at step 8**: the
sanitizer should hash or use the full relative path rather than truncate, and a
collision should be a loud gate error rather than an ENOENT from a racing
coverage writer.

**Verdict:** ACCEPT the rename; the harness fix is a separate follow-up.

---

## D-A10 · 2026-08-03 · production estimate missed by 2.5x — the `reclassify` trigger fired

**What:** `estimated_prod_lines` was ±750. Actual non-test added lines: **1901**
(1649 TS/TSX, 82 SQL, 170 markdown). The gate's `reclassify` row fired at >2x.
The test bucket was 2824 against ±1600 — 1.77x, under threshold.

**Where the estimate broke — both UI, both the same mistake:**

| File | Estimated | Actual |
|---|---|---|
| `SuppressionsClient.tsx` | ~230 | 547 |
| `ContactList.tsx` | ~60 | 345 |
| `suppressions-service.ts` | ~105 | 216 |

`ContactList.tsx` was sized as *an edit to an existing file* and became a
refactor: props restructure, a suppression hook, a badge, a three-state control
and two confirm-copy variants. `SuppressionsClient.tsx` was sized as one form and
is three regions with their own error, empty and confirm states. Backend
estimates were within tolerance.

**Owner call: record and proceed** (2026-08-03). The trigger exists to catch a
feature pushed through controls too light for it; that is not what happened here.
RISK=high with a staging ride is already the heaviest non-epic lane, and the only
heavier routing is EPIC — decompose, don't implement — which would mean tearing
down eight completed, tested, gate-green tasks. The lane was right; the estimate
was wrong.

**Lesson to promote at step 8:** when estimating a `/feature` intake, an admin
console client with lookup + entry + a confirmed destructive action runs
**400-550 lines**, not 230; and "add a control to an existing list component"
should be estimated as a **refactor of that component**, not as a diff against
it — the props threading alone exceeded the whole original estimate.

**Verdict:** ACCEPT — estimate defect, not a lane defect.

---

# STEP 6 TRIAGE ROLL-UP (orchestrator, 2026-08-03)

Read end to end before review dispatch. Every entry is by definition something
the plan did not anticipate, so this is the highest-signal defect list on the
branch. Verdicts:

| # | Entry | Verdict |
|---|---|---|
| D-A1 | Surface amendment #1 — `src/lib/shared/__tests__/**` | **ACCEPT** — mechanically required by the #573 live-DB convention; test-helper tree only, no production code |
| D-A2 | Cross-worktree contention on `tenant-scope-allowlist.ts` | **ACCEPT** — append-only handling held; T4 added 3 entries and moved the baseline 416→419 without touching another branch's rows |
| D-A3 | Migration number collision with #656 | **ACCEPT** — this branch keeps 098 and merges first; #656 renumbered to 099. Merge order **#645 → #656** |
| D-A4 | `btrim` CHECK contradicted its own test | **ACCEPT** — a real plan defect, corrected toward the plan's stated behaviour and verified against PG16 |
| D-A5 | T3 left the allowlist snippet stale; T4 fixed it | **ACCEPT** — but see the process lesson below |
| D-A6 | `../../location-scope` import fails lint | **ACCEPT** — plan snippet written at the sibling route's depth; alias fix, no behaviour change |
| D-A7 | Flag-gate test placed in `flag-404.test.ts` | **ACCEPT** — follows the convention that file documents as its own. Not one of the 18 contract titles, so the gate is unaffected. **Flagged to the spec reviewer** to confirm the gate really is covered for both new routes |
| D-A8 | Confirm step on the safe direction, not the risky one | **ACCEPT** — implemented as a follow-up; clearing now confirms with copy distinct from marking, per §7.6 |
| D-A9 | Two integration suites collide on one coverage directory | **ACCEPT** the rename; the harness bug itself is unfixed and promoted to step 8 |
| D-A10 | Production estimate missed by 2.5x | **ACCEPT** — estimate defect, not a lane defect; owner call recorded |

**None RE-PLAN. No entry invalidates a locked intake decision**, so the abort
criteria do not fire. Surface amendments used: **1 of 2**.

## Two process lessons for step 8 promotion

1. **D-A5 is my error, not T3's.** I dispatched T2+T3 and then T4+T5 in parallel
   without running the gate between batches, so T3's stale-allowlist red was
   discovered by T4 as "already red on arrival" rather than by me at the batch
   boundary. It cost T4 diagnosis time on someone else's defect. **Run the gate
   between parallel batches, not only at the end** — the whole point of a cheap
   gate is that re-running it is cheap.
2. **A statement-shape change invalidates its tenant-scope allowlist entry.**
   `ci:tenant-scope` keys on `file + table + normalized SQL`, so adding a column
   to a *shared SQL fragment* silently breaks the allowlist entry of every call
   site that composes it. Not obvious from the fragment's own file.
