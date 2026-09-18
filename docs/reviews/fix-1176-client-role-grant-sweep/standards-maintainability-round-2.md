# Standards & maintainability — branch round 2 (verification only)

Round-1 SHA: e791f2bb194e746e195bf215e06806068c2271aa
Fix SHA (HEAD): 68ecc1d707f2994d771d131a97a4359f04559e34
Method: `git diff e791f2b..68ecc1d` and `git show 68ecc1d:<path>` only. No tests or gates run.

| finding | fixed? | evidence (file:line @ 68ecc1d) | new defect introduced |
|---|---|---|---|
| M1: "the plan's step 8" was an imprecise locator for the only MAINTAIN proof | yes | `.claude/reference/migrations-log.md:2899-2909` (four-right `has_table_privilege` count SQL, must return 0, now inline in entry 122); `supabase/migrations/122_client_role_grant_sweep.sql:58-60` cites "`.claude/reference/migrations-log.md` entry 122"; `src/lib/shared/__tests__/migration-122-client-role-grant-sweep.integration.test.ts:17-18` cites the same entry. `git grep "plan's step 8"` at HEAD matches only review/deviation workflow docs, not durable files | none |
| M2: duplicated pg_default_acl projection | yes | single `readDefaultAcl()` at `...integration.test.ts:148-163`; used by `readCatalogue` at `:234` and `restore` at `:353`; old inline copies removed | none. `restore` still compares `[...restoredDefaultAcl].sort()` against `[...originalDefaultAcl].sort()` (`:357`); `originalDefaultAcl` is `original.defaultAcl` (`:445`), which also comes from `readDefaultAcl()`. Both sides use the same source and a JS sort, so the SQL `ORDER BY 1` vs the old `array_agg(... ORDER BY entry)` difference cannot cause a false mismatch. The empty case also still holds: an empty result set gives `[]`, which matches the old `coalesce(..., '{}')` |
| M3 | n/a (rejected in triage, not re-litigated) | — | — |
| M4: `applyMigration` identity wrapper | yes | wrapper deleted; call sites inlined as `await sql().unsafe(migration)` at `...integration.test.ts:407`, `:434`, `:436`; `git grep applyMigration\b` at HEAD finds no leftover reference (only the unrelated `applyMigration074IfMissing`) | none |

## Appendix (untriaged, outside the accepted fixes)

- The four-right SQL now appears verbatim in both `.claude/reference/migrations-log.md` entry 122 and the plan (`docs/superpowers/plans/fix-1176-client-role-grant-sweep-plan.md`, step-8 section). That is acceptable because the plan is a workflow artifact and the log is the durable owner. If the query is ever edited, though, the plan copy will go stale.
- The `// Step 8:` comment above `restore` (`...integration.test.ts:317`) still uses the suite's own step numbering. Now that no durable file says "step 8" for the PG17 proof, the three-way ambiguity round 1 noted no longer exists.
- `docs/superpowers/plans/fix-1176-client-role-grant-sweep-deviations.md` D5 still says "the plan's step 8". That is correct for a workflow doc and is not a durable locator.
