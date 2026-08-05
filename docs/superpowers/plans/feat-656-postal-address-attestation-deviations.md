# Deviations — #656 (feat-656-postal-address-attestation)

## D1 — Migration renumbered 098 → 099; merge order agreed with #645

**Found at:** step 2 setup, before planning. `scripts/feature-setup.sh` reported
a surface overlap on `supabase/migrations/098_*.sql` with the live worktree
`feat-645-manual-suppression-paths`.

**Why it happened:** map #617 records "Neither #644, #645 nor #657 is
migration-bearing." That line is **stale**. #645's own grilling made it
migration-bearing — its `.feature/intake.json` carries `db_touching: true` and
claims `supabase/migrations/098_*.sql`, and its deviations file already cites
`migration-098-*.integration.test.ts` by name. Two in-flight tickets were
therefore both claiming 098: the ADR-0011 collision class the map's
ONE-migration-in-flight rule exists to prevent.

**Resolution (owner call, 2026-08-03):** **#656 takes migration 099. #645 keeps
098 and merges FIRST.** #645 is materially ahead — committed plan, one revision
round applied, gate green in docs-only mode, three commits — while #656 had
written nothing. Renumbering the not-yet-started ticket is free; renumbering
#645 would have cost a plan revision and a test-file rename mid-flight on the
ticket further along.

> **Correction (2026-08-03, from the #645 session).** This entry originally said
> #645's plan was "approved at review round 2." That was wrong: round 1 returned
> **REVISE** and was addressed in `711575f4`; round 2 was stopped before it
> produced a verdict. No approval ever happened. Corrected here so the two
> branches' records agree — the 098-keeps-#645 call is unaffected, standing on
> the grounds above rather than on an approval that did not exist.

**Not counted as an `allowed_edit_surface` amendment.** The surface still covers
exactly one migration file in a directory it already covered — this is a
number correction, not a widening or a scope change, and the abort budget exists
to detect scope drift. Stating the judgment openly rather than leaving it
implicit. Both intake copies and `rollback_plan` were updated and re-armed.

**Binding on this branch:** do not open the PR to `main` until #645 has merged.
099 must land after 098.

> **✅ RESOLVED 2026-08-04.** #645 merged (PR #659), migration 098 applied to
> staging and production in lockstep (PR #661), post-merge sweep landed (#663).
> This branch was rebased onto `origin/main` at `4a16bcfd` — clean, 10 commits
> replayed. `supabase/migrations/098_solicitation_suppression_corrections.sql` is
> present and `.claude/reference/migrations-log.md` now reads
> **"Current head: 098 — next migration is 099"**, exactly matching this plan.
> The PR blocker is lifted and round-1 finding 10 (the pre-T2 existence check) is
> satisfied by fact rather than by a check we still need to write — keep the
> check anyway, since a future resumed session must not re-derive this.

## D2 — Residual surface overlap: `scripts/ci/tenant-scope-allowlist.ts`

Shared with `feat-645-manual-suppression-paths`. This is the standing
append-only contention point across #644, #645 and admin-console-phase3 — each
branch appends its own entries and the file conflicts textually, never
semantically.

**Resolution:** same merge order as D1 (#645 first). This branch rebases on the
merged #645 and re-appends its own entries if the allowlist needs them at all —
#656 may well need no entry, since it adds columns to `businesses` rather than a
new table.

> **✅ RESOLVED 2026-08-04.** #645 merged and this branch rebased onto it; its
> three `suppression_corrections` allowlist entries are now on `main` and were
> absorbed cleanly with no conflict. If #656 turns out to need entries of its
> own, append them and **recompute `ALLOWLIST_BASELINE` from the actual entry
> count** — never reuse #645's number. The audit fails on a mismatch in either
> direction, so a botched resolution is caught by CI rather than shipped.

## D3 — Surface NARROWED at plan time after the `codebase-design` consult

**Removed from `allowed_edit_surface`:** `src/app/api/settings/route.ts`,
`src/app/api/settings/__tests__/**`, `src/hooks/useSettingsForm.ts`.
**Also dropped:** `src/components/dashboard/settings/ProfilePanel.tsx`.

**Why:** the intake assumed the attestation panel would read its prefill state
through the shared `/api/settings` GET payload and its `useSettingsForm` hook —
which would have widened an interface **four other settings panels depend on**,
purely to carry data one panel needs.

`src/app/(authenticated)/settings/profile/page.tsx` is already a server
component. It fetches the postal-address state server-side (composition root,
invariant #15) and passes it as a prop to `ProfileClient`, which renders the new
`SolicitationAddressPanel` beside the existing `ProfilePanel`. This is exactly
what `settings/locations/page.tsx` already does. `ProfilePanel` itself is
untouched — the new panel is a sibling, not an edit to it.

Net effect: no shared interface widened, one fewer client round-trip, four
fewer files in the surface. Writes still go to the dedicated
`/api/settings/postal-address` route.

**Auto-approved** under step 2's amendment rule (narrowing only). Both intake
copies updated.

## D4 — Surface amendment #1 (of 2 before abort criteria fire): the send-handoff log seam

**Added to `allowed_edit_surface`:** `worker/jobs/solicitation-batch/index.ts`.
**Owner-approved 2026-08-03.**

**Why:** the intake's `observability` field said "a structured log line from the
batch builder." Recon showed **`batch-builder.ts` contains no logging at all** —
it returns result objects and `worker/jobs/solicitation-batch/index.ts:31` logs
them in one structured `'solicitation batch build finished'` object
(`send_count`, `withheld_by_reason`, …). That is the `codebase-design`
"return results, don't produce side effects" pattern, deliberately.

Putting the first side effect into batch-builder to avoid a surface amendment
would have been the tail wagging the dog, and would give the fact two owners.
The withheld reason instead rides the existing log object as one more field.

**Intake `observability` text corrected in place** to name the worker as the
emitter — an intake-field correction, recorded here rather than counted as a
second amendment.

**Process note:** this was found because two earlier `rg -rn "a\|b"` recon
commands were malformed — `-r` is ripgrep's *replace* flag, so `-rn` meant
"replace with n". One returned empty output that was briefly read as a real
answer. Re-run with `-n` and a `grep` filter. Worth remembering: an empty
ripgrep result is only evidence if the flags were right.

## D5 — Tasks executed SEQUENTIALLY, not in parallel as the plan permits

**Found at:** execution, immediately after T1. **Not an intake or surface change.**

The plan's dependency graph is correct about *logical* independence — T7, T8 and
T9 touch disjoint files once T2 lands, as do T4 and T6 once T3 lands. But
"logically independent" is not "safe to dispatch concurrently **into one git
worktree**":

- Every task's commit step is `git add -A && git commit`. Two agents running that
  concurrently stage **each other's** in-progress files, so a half-written T8
  lands inside T7's commit — silently, with a plausible-looking message.
- Concurrent `git commit` also contends on `.git/index.lock`, which fails
  noisily and is the *lucky* outcome; the staging race is the one that corrupts
  history quietly.

**Resolution: run every task sequentially in the dependency order.** It is slower
and buys back correctness that would be expensive to unpick — an interleaved
commit is only visible by reading each diff against its task.

The parallelism in the plan is not wrong, it is just conditional: it is safe only
with per-task worktree isolation (`isolation: 'worktree'`) or a commit step
narrowed to that task's own paths. Neither is in the plan, so neither is assumed
here. **If a future session wants the parallel speedup, change the commit steps to
explicit paths FIRST** — `git add <path> …`, never `-A`.
