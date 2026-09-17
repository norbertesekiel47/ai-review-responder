# Standards & maintainability review — fix-1176-client-role-grant-sweep

Head reviewed: e791f2bb194e746e195bf215e06806068c2271aa (merge-base 889c8be6e479e4b6eae4b729cb1f6eeceafb9343)

Production diff measured: 522 lines (includes workflow docs); axis runs because risk = high.

Method: `thermo-nuclear-code-quality-review` skill applied to the pinned diff. All files read via `git show <head>:<path>`; nothing executed. Precedents compared: migration 119 + its suite, the 121 suite, `.claude/rules/migrations.md`, `.claude/rules/live-db-tests.md`, `.claude/CLAUDE.md`. Workflow artifacts (`docs/superpowers/plans/*`, `docs/reviews/*`) were treated as context only.

## Overall

Structure is sound and matches the sanctioned seam: a single-transaction migration with an owner guard and a version-gated MAINTAIN branch, plus an execute-not-parse suite registered in `MIGRATION_SHAPE_FILES` that follows 119/121 (lock, `max: 1`, `prepare: false`, `statement_timeout`, degrade → prove degrade → apply verbatim twice → diff every public table → verified restore). There is no new production module, dependency, flag or writer. The test file is 594 lines, well under the 1k threshold. I found no simpler overall design ("code judo"): a migration has to spell out its table list, and the suite's single-`beforeAll`-then-pure-assertions shape is simpler than 119's per-case DDL. The findings below are about locality, duplication and citations.

## Findings

| # | Severity | file:line | Finding |
|---|---|---|---|
| F1 | medium | supabase/migrations/122_client_role_grant_sweep.sql:58 | Durable artifacts rest their only MAINTAIN proof on "the plan's step 8": an unnamed workflow artifact, and the wrong locator |
| F2 | low | src/lib/shared/__tests__/migration-122-client-role-grant-sweep.integration.test.ts:350 | The default-ACL projection SQL is duplicated verbatim, and the `server_privileges` derivation appears three times |
| F3 | low | src/lib/shared/__tests__/migration-122-client-role-grant-sweep.integration.test.ts:494 | `role:privilege` strings are built by a helper but parsed ad hoc with `split(':')`, and the `CLIENT_ROLES` constant is bypassed by literals |
| F4 | low | src/lib/shared/__tests__/migration-122-client-role-grant-sweep.integration.test.ts:310 | `applyMigration` is an identity wrapper over `sql().unsafe` |

### F1 — medium — stale/ambiguous locator for the sole MAINTAIN-branch proof

- **Where:** `supabase/migrations/122_client_role_grant_sweep.sql:58-59`, `src/lib/shared/__tests__/migration-122-client-role-grant-sweep.integration.test.ts:17`, `.claude/reference/migrations-log.md:2900`.
- **Standard:** CLAUDE.md "checked-in docs are the durable, authoritative layer; one authoritative owner per fact". Checklist class: citations that don't resolve to tracked evidence (fix-1080 plan citation entries).
- **Evidence:** all three durable files say the PG17 four-right query "in the plan's step 8" is the only proof that the MAINTAIN branch works. None of them names the plan's path. The plan (`docs/superpowers/plans/fix-1176-client-role-grant-sweep-plan.md`) puts that query under "## Out of the plan, owned by step 8", so it lives in /feature workflow step 8, not in a step of the plan. The plan's own numbered "8." is the suite's restore step, and the test file reuses "Step 8" at `:314` to mean restore. A reader gets three meanings of "step 8" and no path to the SQL. The nearest precedent names its owner: 113's entry says "rides step 8 of the #631 plan". The migrations-log is the authoritative, durable home for "verify by introspection", and it doesn't contain the query.
- **Smallest correction:** paste the 7-line `has_table_privilege` count query (must return 0) into the migrations-log 122 entry under "Version guard limit". Change the migration header and the suite header to cite "`.claude/reference/migrations-log.md` § 122". Optionally rename the suite's `// Step 8:` comment to `// Restore:`.

### F2 — low — duplicated catalogue SQL inside the suite

- **Standard:** duplication and locality. Checklist class: duplicate renderers that can drift (feat/1190).
- **Evidence:** the `pg_default_acl` → `role|namespace|objtype|grantee|privilege|grantable` projection is written out in full twice: once in `readCatalogue` (`:217-227`) and once in `restore`'s verification (`:350-361`). The restore verification then compares one reading against the other, so if a later edit touches only one copy (for example, adding a column), the two encodings drift apart and restore verification fails with a misleading "failed to restore" error. Separately, `aclexplode(acldefault('r', current_user::regrole))` is derived at `:161-164`, `:236-239` and `:395-399`, even though `beforeAll` already holds the result in `serverPrivileges`.
- **Smallest correction:** extract `async function readDefaultAcl(): Promise<string[]>` and use it in both places. Pass `serverPrivileges` into the two catalogue queries as `${serverPrivileges}::text[]` in place of re-deriving the CTE, or keep one derivation and drop the others.

### F3 — low — stringly-typed encode/parse and bypassed constants

- **Standard:** use the constants you define (no string literals for the same concept) and keep the data model explicit rather than re-parsing strings.
- **Evidence:** `clientRight(role, privilege)` (`:142`) builds `role:privilege`, but readers take it apart ad hoc with `entry.split(':')[1] ?? ''` (`:494`, `:528`) and `entry.split(':')[0] ?? ''` (`:535`). The `acl` entries use a three-part `grantee:privilege:grantable` format, so `[0]`/`[1]` mean different things depending on which array the entry came from. `CLIENT_ROLES`/`RESTORED_ROLES` exist, yet the SQL spells `ARRAY['anon', 'authenticated']` (`:192`) and `ARRAY['anon', 'authenticated', 'service_role']` (`:241`), `nonClient` compares literal `'anon'`/`'authenticated'` (`:536`), and the degrade statements hardcode `anon, authenticated` (`:431-437`).
- **Smallest correction:** add `privilegeOf(entry)` and `granteeOf(entry)` next to `clientRight`, and pass `CLIENT_ROLES` / `RESTORED_ROLES` as `${[...CLIENT_ROLES]}::text[]` bind parameters in the two queries. `nonClient` should use `CLIENT_ROLES.includes`.

### F4 — low — identity wrapper

- **Evidence:** `async function applyMigration(migration) { await sql().unsafe(migration); }` (`:310-312`) adds a name and nothing else. It isn't used by the precedent suites, and its three call sites read just as clearly as `await sql().unsafe(migration)`.
- **Smallest correction:** inline it.

## Checked and not flagged

- File size: the test file is 594 lines, and no file crosses 1k.
- `scripts/ci/live-db-suites-audit.ts`: the registration is a single set entry with a reason comment, in the precedent format.
- Arch-review-log row and migrations-log entry: head/next bumped to 122/123. The entry sits after 121, which is where the file's existing out-of-order convention for 119/121 puts it. Neither cites line numbers, so no citations can go stale.
- Header claims re-resolved at head: `.github/workflows/ci.yml:252` does pin `postgres:16`; `src/proxy.ts:252` has `.from('users')`; `040_rls_tightening.sql:67,164` has column-level `GRANT UPDATE (…)`.
- Test comments match their assertions: the restore comment (`:314-316`) matches the three comparisons it makes, and the fail-open guards (`:479-481`) match 119's anti-vacuity precedent.
- The owner guard is covered by a dedicated case (D1), and the `DO` guard's comment duplicates the header only briefly.
- Every line of `docs/reviews/finding-checklists/standards-maintainability.md` was checked. The classes that apply here are unresolvable or stale citations (→ F1), duplicate encoders that can drift (→ F2), same-source oracles (not present: the per-table expectations are derived from `before`, not from the list the implementation uses, except DENY_ALL_TABLES, which is intent-level and whose recurrence guard is deferred to #1300), and comments promising guarantees their assertions don't give (none found). The UI, InfoTip, CSS, TS-type-assertion and mutation-runner entries don't apply to this diff.
