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
