# Deviations — fix/portal-audit-pr1-correctness

Entries the plan did not anticipate. Each gets an ACCEPT / RE-PLAN verdict at
step 6 before review.

---

## D1 — spec §3.5 said a new `labels.ts`; using existing `types.ts` instead

**Amendment #1 to `allowed_edit_surface`** (auto-approved: adds one file inside
`src/lib/auto-approval/`, a tree the surface already covered).

The spec's §3.5 called for a new `src/lib/auto-approval/labels.ts`. Checking
before creating it (anti-slop: "name the existing file that was considered")
showed `src/lib/auto-approval/types.ts` already:

- exports runtime constants, not only types (`APPROVAL_METHOD`,
  `POLICY_PERSONA_REPLY`, `POLICY_ACTION_POSTING`)
- is already imported by the admin panel being edited
  (`AutoApprovalDiagnosticsPanel.tsx`)
- is already imported by client components (`ReviewFeedCard.tsx`,
  `AutoApprovedBadge.tsx`, `approval-client.tsx`), so it is client-safe

So the threshold labels go in `types.ts` and no new file is created, per
CLAUDE.md's "default is no new file". Surface amended: `labels.ts` →
`types.ts`, both intake copies updated.

**Verdict: ACCEPT.** using existing `types.ts` instead of a new `labels.ts` is the repo's stated default and the file was already a client-safe home for runtime constants. Surface amendment #1, substantively a narrowing.

---

## D2 — spec §3.4 mechanics: extracted `loadRivalPickerViews` rather than an inline loop

Not a surface amendment — `src/lib/competitors/named-rival.ts` was already in
the declared surface.

Spec §3.4 said "sequential accumulation" without saying where the loop lives.
Putting it inline in `settings/competitors/page.tsx` would have placed the added
lines in a server component, which this repo has **no executing-test precedent
for** (the convention is source-text assertion via `page-source.test.ts`, which
yields 0% line coverage). Since `diff-coverage` is an aggregate over added
instrumented lines, an inline loop pushed the projected aggregate to ~76%,
under the 80% gate.

Extracting `loadRivalPickerViews(sql, { accountId, businessIds })` into
`named-rival.ts` follows the existing `loadLocationsSettingsView` precedent
(loader owns every query, runs them sequentially, page is a one-line call),
satisfies invariant #15, and makes the sequential behaviour unit-testable in the
existing `named-rival.test.ts`. Projected aggregate coverage ~91%.

**Verdict: ACCEPT.** the extraction follows a named precedent (`loadLocationsSettingsView`), satisfies invariant #15, and is what makes the sequencing testable at all. Not a surface amendment.

---

## D3 — BLOCKER: `edit-surface-guard.sh` cannot match the three `[id]` route paths

`edit-surface-guard.sh:122` matches with bash's `[[ "$REL_PATH" == $GLOB ]]`,
where `[id]` is a **character class** (one char, `i` or `d`) — not the literal
directory name of a Next.js dynamic route segment. Every declared entry under
`src/app/admin/businesses/[id]/` is therefore unmatchable, and the guard rejects
writes to paths the signed intake explicitly lists.

Confirmed:

```
p="src/app/admin/businesses/[id]/__tests__/page-source.test.ts"
[[ $p == "src/app/admin/businesses/[id]/__tests__/**" ]]   # false
```

Consequence: Task 1 Step 5 could not create
`src/app/admin/businesses/[id]/__tests__/page-source.test.ts`, so the promised
test title `keeps the admin business detail page free of Promise.all fan-out`
is **not yet authored**. Tasks 5 and 6 will hit the identical wall on
`src/app/admin/businesses/[id]/page.tsx` and
`src/app/admin/businesses/[id]/_components/AutoApprovalDiagnosticsPanel.tsx`.

Not fixed here, deliberately: the only routes to unblocking are amending
`.feature/intake.json` or relaxing the guard, and both are contract/permission
changes that need the user's own sign-off rather than an agent's judgement.

Two candidate fixes for the user to choose between:

1. **Durable** — make the guard match literally (`jq`-side `fnmatch`, or
   `case` with the glob quoted) instead of through bash pattern expansion. Every
   dynamic-route segment in the repo hits this otherwise.
2. **Local** — append `?`-for-bracket siblings to `.feature/intake.json` (the
   untracked runtime artifact), leaving the tracked intake in its `[id]` form:
   `src/app/admin/businesses/?id?/page.tsx`,
   `src/app/admin/businesses/?id?/__tests__/*`,
   `src/app/admin/businesses/?id?/_components/AutoApprovalDiagnosticsPanel.tsx`.

### Resolution (owner decision, 2026-08-15): option 2 now, option 1 as a follow-up

The three `?id?` siblings were appended to `.feature/intake.json` only. The
tracked intake keeps its `[id]` spelling, so the audit copy still records the
surface as declared and reviewed.

**This is NOT a surface amendment and does not count toward the abort budget.**
The set of reachable files is identical before and after — the same three paths
were already declared. Only the spelling changed, so a buggy matcher can read
what the contract already said. `?id?` cannot over-match here either:
`src/app/admin/businesses/` contains only `[id]`, `new`, `__tests__`,
`page.tsx`, and `BusinessesClient.tsx`, and `?id?` matches none of those but
`[id]`.

Verified under **bash** (the guard's interpreter — `#!/usr/bin/env bash`), not
the interactive zsh:

```
[id]  globs  -> NO MATCH   (blocker confirmed)
?id?  globs  -> all three target paths match
```

Note for anyone re-checking this: verifying in zsh gives the right verdict for
the wrong reason — zsh's `?` did not match `[` in the same expression where
bash's does. Re-run any glob check with `bash -c`.

**Follow-up — RECORDED HERE ONLY, not yet filed as an issue (not in this PR):**
`.claude/hooks/edit-surface-guard.sh:122`
should match literally rather than through bash pattern expansion. Every Next.js
dynamic segment in this repo hits the same wall — `[reviewId]`, `[token]`,
`[responseId]`, `[sessionId]`, `[offboardingId]`, `[escalationId]`,
`[businessId]`. Keeping it out of this branch preserves the small-diff bias and
keeps a tooling fix from riding inside a correctness PR.

**Verdict: ACCEPT.** the guard bug is real and confirmed under bash. The local `?id?` unblock changes spelling, not reach, so it is not a surface amendment. Durable guard fix deliberately deferred to its own change.

---

## D4 — the plan's page-source tests forbade the string they should have required

A flaw in the plan (my own), caught by running the test rather than by review.

Both page-source tests were specified as `expect(source).not.toContain('Promise.all')`
against the raw file. But the house idiom for this exact invariant — used
verbatim in `admin/costs/page.tsx` and `admin/overview/page.tsx` — is the
comment *"do NOT re-introduce a Promise.all here"*. So the naive assertion
fails on the **correct** implementation, and the only way to make it pass is to
delete the comment explaining why the code is shaped that way. The test would
have actively removed the thing that stops the next reader re-introducing the
fan-out.

Fixed by stripping comments before asserting, in both
`src/app/admin/businesses/[id]/__tests__/page-source.test.ts` and
`src/app/(authenticated)/settings/competitors/__tests__/page-source.test.ts`.
The admin one additionally asserts the word `SEQUENTIAL` **is** present, so the
explanatory comment is now required rather than forbidden.

The duplicated 4-line `stripComments` helper is deliberate: not worth a shared
file for 4 lines across two call sites.

**Correction (review round 1):** the original wording here claimed a shared
helper "would need a home outside both `__tests__` directories (and outside the
declared surface)". That justification was wrong — `src/__tests__/helpers/`
already exists. The conclusion stands on the size argument alone.

**Verdict: ACCEPT.** my own plan defect, caught by running the test. The corrected assertion is strictly stronger: it now *requires* the explanatory comment rather than forbidding it.

---

## D5 — `reclassify` WARN fired on a miscount; step 0 re-run confirms the lane

The gate reported `production 481 > 2x estimated_prod_lines (70)`, which is a
mandatory stop-and-re-classify trigger. Re-measuring the diff against the fork
point by bucket:

| Bucket | Estimate | Actual | Ratio |
|---|---|---|---|
| Production | 70 | **84** | 1.2× |
| Test | 180 | **263** | 1.46× |
| Spec doc (`docs/superpowers/specs/`) | — | 362 | — |
| Workflow docs (`docs/superpowers/plans/`) | — | 985 | excluded by gate |

Both real buckets are inside the 2× trigger. The 481 figure counts the
**362-line spec document** as production: the gate excludes
`docs/superpowers/plans/**` and `docs/reviews/**`, but not
`docs/superpowers/specs/**`, and this branch carries the spec commit because the
worktree was based on `docs/portal-audit-remediation-spec` so the spec would
ship with the first PR that implements it.

Step 0 was re-run with the true numbers. Classification is unchanged:
**RISK = normal · SURFACE = mixed · SIZE = normal**. The trigger was obeyed, not
waived — it simply did not survive contact with the real measurement.

**Follow-up — RECORDED HERE ONLY, not yet filed as an issue (not in this PR):**
add `docs/superpowers/specs/**` to the gate's
workflow-artifact exclusion alongside `plans/**` and `reviews/**`. Any feature
that carries its own spec on the branch will otherwise trip this trigger.

**Verdict: ACCEPT.** trigger obeyed; step 0 re-run on true numbers (84 prod / 263 test) confirms the same lane. No re-plan warranted.
