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
098 and merges FIRST.** #645 is materially ahead — plan approved at review round
2, gate green, three docs-only commits — while #656 had written nothing.
Renumbering the not-yet-started ticket is free; renumbering #645 would have cost
a plan revision and a test-file rename mid-flight on the ticket further along.

**Not counted as an `allowed_edit_surface` amendment.** The surface still covers
exactly one migration file in a directory it already covered — this is a
number correction, not a widening or a scope change, and the abort budget exists
to detect scope drift. Stating the judgment openly rather than leaving it
implicit. Both intake copies and `rollback_plan` were updated and re-armed.

**Binding on this branch:** do not open the PR to `main` until #645 has merged.
099 must land after 098.

## D2 — Residual surface overlap: `scripts/ci/tenant-scope-allowlist.ts`

Shared with `feat-645-manual-suppression-paths`. This is the standing
append-only contention point across #644, #645 and admin-console-phase3 — each
branch appends its own entries and the file conflicts textually, never
semantically.

**Resolution:** same merge order as D1 (#645 first). This branch rebases on the
merged #645 and re-appends its own entries if the allowlist needs them at all —
#656 may well need no entry, since it adds columns to `businesses` rather than a
new table.

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
