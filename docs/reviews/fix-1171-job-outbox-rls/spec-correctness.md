# Spec & correctness review — `fix-1171-job-outbox-rls`

Merge-base `602e9893` → HEAD `3a7d0ca9`. Read-only review; no file in the
worktree outside `.feature/review-staging/` was touched.

Diff under review (6 files, 683 insertions, 1 deletion):

| Path | Bucket |
|---|---|
| `supabase/migrations/119_job_outbox_rls.sql` | production (SQL) |
| `src/lib/shared/__tests__/migration-119-job-outbox-rls.integration.test.ts` | test |
| `.claude/reference/migrations-log.md` | doc |
| `.claude/reference/arch-review-log.md` | doc |
| `docs/superpowers/plans/fix-1171-job-outbox-rls-intake.json` | workflow artifact |
| `docs/superpowers/plans/fix-1171-job-outbox-rls-deviations.md` | workflow artifact |

---

## Findings

| # | Severity | File:line | Finding |
|---|---|---|---|
| F1 | medium | `src/lib/shared/__tests__/migration-119-job-outbox-rls.integration.test.ts:223` | The client-role privilege assertion covers only `SELECT` and `INSERT`; migration 117's suite — named in this file's own header as "the pattern this file follows" — covers `SELECT`/`INSERT`/`UPDATE`/`DELETE` for both roles. A later `GRANT UPDATE`/`DELETE`/`TRUNCATE` to `anon` or `authenticated` ships green through what the branch declares is this boundary's only guard. |
| F2 | low | `src/lib/shared/__tests__/migration-119-job-outbox-rls.integration.test.ts:180` | `tests_to_add[1]` (FORCE off) is vacuous against reversion — `relforcerowsecurity` is `false` by default on every table, so the case is green on a container migration 119 never touched. The branch admits two vacuous cases (D2, D5); this third one is not among them. |
| F3 | low | `supabase/migrations/119_job_outbox_rls.sql:57` | "78 production files bind it" (repeated in the test comment, the migrations-log and the arch-review-log) is the identifier-*reference* count. Only **55** production files contain a SQL binding of the table; the other 23 mention it in comments or constant names. |
| F4 | low | `src/lib/shared/__tests__/migration-119-job-outbox-rls.integration.test.ts:76` | Comment says the `SchemaRequirement` is "Kept for the provisioning-marker path". `assertSchemaReady` has no provisioning-marker path — the `test_meta.provision` marker is read only by `scripts/ci/rls-audit.ts`. The requirement's sole effect is asserting `job_outbox` exists. |
| F5 | low | `src/lib/shared/__tests__/migration-119-job-outbox-rls.integration.test.ts:222` | `test_seams[2]` names `information_schema.role_table_grants`; the suite uses `has_table_privilege()` instead. The substitution is a better choice (it is 117's precedent and it also catches a `PUBLIC` grant) but no deviation entry records it — D1 records only the owner-name derivation. |

---

## F1 — client-role privilege coverage narrowed from the 117 precedent

**Severity:** medium
**Contract field:** `invariants[3]` — "anon and authenticated hold no privilege on job_outbox"; `existing_patterns_to_follow[3]` / the suite's own stated role as the boundary guard.
**File:** `src/lib/shared/__tests__/migration-119-job-outbox-rls.integration.test.ts:223-226`

The catalogue case asserts four client-role arms:

```
has_table_privilege('anon',          'public.job_outbox', 'SELECT')
has_table_privilege('anon',          'public.job_outbox', 'INSERT')
has_table_privilege('authenticated', 'public.job_outbox', 'SELECT')
has_table_privilege('authenticated', 'public.job_outbox', 'INSERT')
```

`src/lib/shared/__tests__/migration-117-admin-audit-log.integration.test.ts:156-163`
asserts **eight** — `SELECT`, `INSERT`, `UPDATE`, `DELETE` for each of `anon`
and `authenticated` — in the same `toEqual` shape, on the same
`has_table_privilege` seam. This suite's header (`:1-7`) explicitly claims 117's
role and pattern:

> "`ci:rls-audit` only audits that list, so THIS suite is the regression guard
> for the boundary — the same role
> `migration-117-admin-audit-log.integration.test.ts` plays for
> `admin_audit_log`, and the pattern this file follows."

Both the migration header (`:54-61`) and the migrations-log entry state that
`ci:rls-audit` does **not** cover `job_outbox` and that this suite is therefore
the only regression guard. Live introspection (2026-09-07) confirms the roles
currently hold all seven privilege types on both projects
(`DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE`, grantor `postgres`),
so the invariant's scope is genuinely wider than two verbs.

**Concrete failure scenario.** A later migration adds
`GRANT UPDATE ON job_outbox TO authenticated` (e.g. an owner-facing "retry this
job" surface, or a copy-paste of a Supabase grant block). Because the local test
container's `test-db-bootstrap.sql` applies every migration, that grant lands
locally too — so the assertion *would* have caught it had `UPDATE` been an arm.
As written, the suite stays green, `ci:rls-audit` is silent by design, and the
file-text case only reads migration 119's own bytes, so nothing in the
repository notices. `authenticated` then holds UPDATE on the dispatch spine with
deny-all RLS as the sole remaining barrier — and if the same PR were to add a
policy, title 1's `policy_count` would be the only survivor.

The fix is four extra `has_table_privilege` arms in the existing query, matching
117 exactly. Zero new mechanism.

---

## F2 — the FORCE case is vacuous against reversion, and is not declared as such

**Severity:** low
**Contract field:** `tests_to_add[1]`; the deviations doc's own "one entry per surprise" contract (D2, D5 declare the other two vacuous cases).
**File:** `src/lib/shared/__tests__/migration-119-job-outbox-rls.integration.test.ts:180-192`

Reversion analysis over all five cases (revert = delete `119_*.sql` and restore
the pre-migration container state):

| Case | Line | Green after reversion? |
|---|---|---|
| registries (not a promised title) | 95 | green — never touched the migration |
| `tests_to_add[2]` REVOKE, file text | 108 | **red** — `readFileSync` throws `ENOENT` |
| "no policy / no FORCE", file text | 122 | **red** — same |
| `tests_to_add[0]` RLS enabled + 0 policies | 159 | **red** — this is the real detector |
| `tests_to_add[1]` FORCE off | 180 | **green** — `relforcerowsecurity` is `false` by default |
| `tests_to_add[3]` privileges | 194 | **green** locally (D5 covers the `anon` arms; the owner arms are also true without the migration) |

Live introspection confirms `relforcerowsecurity = false` on both Supabase
projects *today*, before the migration is applied — so the assertion is true in
every environment whether or not 119 exists.

This is not a defect in the assertion itself: as a *standing* guard against a
future migration setting FORCE it is load-bearing, and both the header (`:36-37`)
and the migrations-log ("FORCE stays off, asserted in catalogue AND file text")
present it that way. The defect is in the record: the migrations-log's
**"Known limit of the local guard"** paragraph and deviations D2/D5 enumerate
the vacuous cases, and this one is missing from both. A reader who trusts that
enumeration will read "asserted in catalogue" as evidence that 119 was applied,
which it is not.

**Concrete failure scenario.** A future session investigating whether the local
container is at migration head reads the migrations-log limits paragraph, sees
only the `anon`/`authenticated` caveat, and concludes the other three DB cases
prove application. Two of them do not.

---

## F3 — "78 production files bind it" is the reference count, not the binding count

**Severity:** low
**Contract field:** factual claims in the migration header, migrations-log entry, arch-review-log entry, and the test comment (the doc-claim class the checklist accepts).
**Files:** `supabase/migrations/119_job_outbox_rls.sql:57-58`; `.claude/reference/migrations-log.md:2718-2720`; `.claude/reference/arch-review-log.md:94`; `src/lib/shared/__tests__/migration-119-job-outbox-rls.integration.test.ts:99`

Reproduced at HEAD:

```
rg -l "job_outbox" src worker | grep -v __tests__ | grep -v '\.test\.'   → 78
rg -l -i "(from|into|update|join|table)\s+job_outbox" … same filters     → 55
```

Twenty-three of the 78 name the identifier without binding the table.
Verified examples:

- `src/app/(authenticated)/dashboard/requests/ApprovalPanel.tsx:719` — prose comment
- `src/app/(authenticated)/dashboard/requests/AskList.tsx:155` — prose comment
- `src/lib/shared/queue-names.ts:18,21,33` — partial-index names in comments
- `src/lib/shared/outbox-completion-reason.ts:1,54` — the column vocabulary's docstring

The number 78 is reproducible and the argument it supports ("membership would
cost dozens of allowlist entries") survives at 55, so this is a wording defect,
not a wrong decision. But the sentence appears in four durable references and
its verb is "bind", which is `ci:tenant-scope`'s own term of art for a SQL
binding — the exact thing 55 counts. Either say "reference" or use 55.

**Concrete failure scenario.** A later session re-evaluating `TENANT_TABLES`
membership re-derives the count with a binding-shaped grep, gets 55, and cannot
tell whether the codebase shrank or the record was wrong — the same
stale-cited-number class the accepted-findings checklist logs three times.

---

## F4 — the `SchemaRequirement` comment cites a mechanism that does not exist

**Severity:** low
**Contract field:** factual claim in a permanent code comment (doc-claim class).
**File:** `src/lib/shared/__tests__/migration-119-job-outbox-rls.integration.test.ts:75-80`

```
// 119 creates nothing, so the only object it can name is the table it hardens.
// Kept for the provisioning-marker path, not as proof the migration ran.
```

`assertSchemaReady`
(`src/lib/shared/__tests__/helpers/schema-ready.ts:563-596`) runs exactly five
existence probes — tables, columns, indexes, constraints, column types — and
reads no marker. The provisioning marker is `test_meta.provision`, and its only
reader is `scripts/ci/rls-audit.ts` (`readProvisionMarker`, `:129-150`), which
is a different process on a different code path. Grepping `marker` across
`src/lib/shared/__tests__/helpers/` returns nothing in `schema-ready.ts`,
`live-db-lock.ts`, or `describe-with-db.ts`.

D4's substantive claim is correct and well-argued — `assertSchemaReady` genuinely
cannot gate an object-free migration — so this is only the sentence that names
*what the weak requirement is still good for*. What it is actually good for is
failing on a completely unprovisioned container (no `job_outbox` at all), which
is worth saying accurately.

**Concrete failure scenario.** A later suite for another object-free migration
copies this file, keeps the comment, and its author assumes a marker check is
running underneath. Nothing checks the marker, and the suite silently passes on
a behind-head container.

---

## F5 — `test_seams[2]` was substituted without a deviation entry

**Severity:** low
**Contract field:** `test_seams[2]` — "`information_schema.role_table_grants` for job_outbox across grantees".
**File:** `src/lib/shared/__tests__/migration-119-job-outbox-rls.integration.test.ts:221-236`

The suite reads `has_table_privilege()` instead. The other two seams
(`pg_class.relrowsecurity`/`relforcerowsecurity`, `pg_policies`) are used exactly
as contracted.

D1 explains why the *owner name* stopped being spelled literally, and its "What
changed" paragraph describes only the `pg_get_userbyid(cls.relowner)`
derivation. Deriving the owner is orthogonal to the seam: the same subquery
could have joined `information_schema.role_table_grants`. So the seam swap
itself is unrecorded.

Substantively the substitution is an improvement and matches 117's precedent
(`migration-117-admin-audit-log.integration.test.ts:156-163`):
`has_table_privilege` reports the *effective* privilege, so it also catches a
`GRANT … TO PUBLIC`, which `REVOKE ALL … FROM anon, authenticated` would not
remove and which `role_table_grants` would list under a different grantee.
Nothing needs to change in the code; the deviations doc needs one sentence.

---

## Contract walk — every field checked

### `goal`

> "job_outbox carries deny-all RLS and zero anon/authenticated privileges on production, staging, and the local test database…"

Met by construction. The migration's three effective statements are exactly the
posture named. Local application verified through `.feature/gate-status.json`
(`db-provision: PASS`, `integration-…-migration-119-j-…: PASS`).

### `non_goals` — all six respected

| Non-goal | Verdict | Evidence |
|---|---|---|
| No RLS policy | ✅ | `rg -i "CREATE POLICY" supabase/migrations/119_*` → none; asserted at `:125` and by `policy_count` at `:177` |
| No FORCE ROW LEVEL SECURITY | ✅ | absent from the file; asserted absent in text (`:129`) and in catalogue (`:191`) |
| No change to `ci:rls-audit` / `ci:tenant-scope` / `TENANT_TABLES` / `REVIEWED_NOT_TENANT_SCOPED` / `rls-inventory.md` | ✅ | none of those five paths appears in `git diff --stat 602e9893..3a7d0ca9` |
| No REVOKE on any other deny-all table | ✅ | the file's single `REVOKE` names `job_outbox` only; pinned by the exactly-one-REVOKE assertion at `:118` |
| No outbox behaviour change / no production TypeScript | ✅ | diff contains zero `.ts`/`.tsx` outside `__tests__`; `docs/reviews/fix-1171-job-outbox-rls/blast-radius.md` reports "No changed production source files" |
| No DISABLE RLS on production | ✅ | no `DISABLE` statement anywhere in the diff |

### `allowed_edit_surface` — every changed path inside it

Four declared paths, all present and all changed as declared. The two
`docs/superpowers/plans/fix-1171-*` files are sanctioned workflow artifacts.
`.claude/reference/arch-review-log.md` is the D6 amendment
(`surfaceAmendments=1`, auto-approval rule satisfied: one file, inside
`.claude/reference/`, a tree the surface already covered). No path outside the
surface was touched. **No scope creep found.**

### `tests_to_add` — all four titles verbatim

| # | Title | Line | Verbatim? | Tests what it claims? |
|---|---|---|---|---|
| 0 | `migration 119 enables row level security on job_outbox and defines zero policies` | 159 | ✅ | ✅ reads `pg_class.relrowsecurity` + a `pg_policies` count; the only real head detector |
| 1 | `migration 119 leaves FORCE row level security off so the owner-role worker keeps dispatching` | 180 | ✅ | ⚠ asserts the right column; vacuous against reversion — **F2** |
| 2 | `migration 119 revokes every anon and authenticated privilege on job_outbox` | 108 | ✅ | ✅ as a file-text guard, with the exactly-one-REVOKE and no-wider-role pins. Acceptable: D2/D5 document why the catalogue cannot carry it locally, and the pinned literal `REVOKE ALL ON job_outbox FROM anon, authenticated;` does cover "every privilege" |
| 3 | `migration 119 leaves the job_outbox owner's privileges intact and denies the client roles` | 194 | ✅ (matches the D2 retitle, applied in both intake copies — verified byte-identical) | ⚠ owner half is load-bearing everywhere; client half covers 2 of 7 privilege types — **F1** |

Both intake copies are byte-identical (`diff .feature/intake.json
docs/superpowers/plans/fix-1171-job-outbox-rls-intake.json` → no output), so the
D2 retitle and the D7 estimate correction landed in both as claimed.

### `invariants`

| Invariant | Verdict |
|---|---|
| Invariant #2 holds; OutboxPoller keeps dispatching | ✅ no TypeScript change; owner bypasses RLS with FORCE off; production has run this posture since 2026-04-05 |
| `relrowsecurity = true`, `relforcerowsecurity = false` in all three | ✅ asserted locally; prod already true/false, staging becomes true/false on apply |
| zero rows in `pg_policies` | ✅ asserted; live count is 0 on both projects today |
| `anon`/`authenticated` hold no privilege | ⚠ **F1** — asserted for 2 of 7 privilege types |
| `postgres` and `service_role` privileges unchanged | ✅ guarded by the file-text no-wider-role assertion; D2's reasoning for not asserting `service_role` in the catalogue is sound (it holds Supabase defaults on both projects and nothing locally — verified) |
| No supabase-js path to `job_outbox` | ✅ re-resolved below |

### `edge_cases`

| Edge case | Verdict |
|---|---|
| ALTER is a no-op on prod | ✅ **re-verified live**: prod `relrowsecurity = true` |
| REVOKE is a real prod change | ✅ **re-verified live**: prod `anon`/`authenticated` hold `DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE` |
| staging + local `relrowsecurity = false` | ✅ **re-verified live**: staging `relrowsecurity = false` |
| REVOKE names only `anon`/`authenticated` | ✅ pinned by `:117-119` |
| Migration immutable once applied | ✅ handled correctly — see the LOCAL-ONLY section |
| Supabase ledger does not track `0xx` | ✅ stated in the header `:74-76` and in the log's own lab note |

### `test_seams`

Two of three used as contracted; the third substituted — **F5**.

---

## Re-resolution of every factual claim

All five DB claims were re-derived by direct introspection of both Supabase
projects on 2026-09-07 (read-only `SELECT`s), not taken from the branch's record.

**"`job_outbox` is the ONLY table of the 54 in schema `public` whose RLS
differs" — TRUE, exactly.**

```
prod    (udeyaqnvpojbwgoaxwdg): total_tables 54, rls_on 54, forced 0
staging (kubdiqdhqbhwmqfditeg): total_tables 54, rls_on 53, rls_off 1
                                rls_off_tables = job_outbox
```

Both the count (54) and the singleton are correct.

**"prod `relrowsecurity` true / staging FALSE, zero policies on both" — TRUE.**
Prod: `policies 0, owner postgres, relrowsecurity true, relforcerowsecurity false`.
Staging: `policies 0, owner postgres, relrowsecurity false, relforcerowsecurity false`.

**"on BOTH projects `anon` and `authenticated` still hold the Supabase default
table privileges" — TRUE**, and the grantor is `postgres` on every row, which is
also the table owner. That matters and the branch does not say it: `REVOKE`
removes only grants made by the invoking grantor, so a `postgres`-granted set is
removable by the `postgres`-owned migration session. The REVOKE will actually
take effect. (Had the grantor been `supabase_admin`, it would not have.)

**"zero matches for `from('job_outbox')` in `src` and `worker`" — TRUE**, and it
is not the whole safety argument, so I checked the ways the grep could be
evaded:

- no dynamic `supabaseServer.from(<variable>)` reaches the table — the
  offboarding/purge lane (`table-disposition.ts`, `purge-stages.ts`,
  `purge-helpers.ts`) uses Postgres.js for table work and touches supabase-js
  only for `auth.admin.deleteUser`
- **zero dependent views or matviews** over `job_outbox` on staging (checked via
  `pg_depend`/`pg_rewrite`) — so no PostgREST-exposed relation reaches it
  transitively
- no `CREATE FUNCTION` in any migration references `job_outbox`, so there is no
  `SECURITY INVOKER` RPC surface either

**Cited precedents — all five resolve.**

| Citation | Verdict |
|---|---|
| 118 deny-all posture | ✅ `118_poller_heartbeats.sql:78,81` — `ENABLE ROW LEVEL SECURITY` then `REVOKE ALL … FROM anon, authenticated` |
| 117 REVOKE precedent | ✅ `117_admin_audit_log.sql:65,68` |
| 107 provenance | ✅ `107_drop_legacy_ensure_rls_event_trigger.sql` exists and is the `ensure_rls` removal |
| 092/101 session-scoped `SET lock_timeout` | ✅ `092:75` and `101:30` both use bare `SET lock_timeout = '5s'` |
| 088/109/114 as the `SET LOCAL` contrast | ✅ `088:16` (`'3s'`), `109:25` (`'3s'`), `114:33` (`'10s'`) all use `SET LOCAL` |
| `scripts/ci/__tests__/rls-audit.test.ts:43` | ✅ line 43 is exactly `expect(REQUIRED_RLS_TABLES).toBe(TENANT_TABLES);` (the citation lives in `.feature/codex-adversarial-brief.md:73`, outside the diff) |
| "`ci:rls-audit` audits only `TENANT_TABLES`" | ✅ `scripts/ci/rls-audit.ts:14` — `REQUIRED_RLS_TABLES = TENANT_TABLES`, and both `findRlsFailures` and `findRlsCoverageFailures` iterate that list only |
| `test-db-bootstrap.sql` grants the client roles nothing on tables | ✅ `:51` is `GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role` and there is no table grant — D5's vacuity claim holds |
| "the same measure-first refutation the 2026-08-18 pass recorded for the four `TENANT_TABLES` candidates" | ✅ `.claude/reference/arch-review-log.md:1707` — "adding the four missing tables to `TENANT_TABLES` produces 63 red lines and 0 security fixes" |
| "78 production files bind it" | ⚠ **F3** |

**`COMMENT ON TABLE` overwrites nothing** — `obj_description` on prod
`job_outbox` is `NULL` today, and no earlier migration carries a
`COMMENT ON TABLE job_outbox`. The statement is purely additive.

---

## Migrations-log head bump and the LOCAL-ONLY convention

Both correct.

- Head bumped `118` → `119`, next `120`. `119_job_outbox_rls.sql` is the highest
  numbered file in `supabase/migrations/`, so the head matches the tree.
- The entry carries **LOCAL-ONLY** in its first line, as the header convention
  (`.claude/reference/migrations-log.md:7-16`) requires for a migration written
  before promotion.
- I traced the guard rather than trusting the convention text.
  `.claude/hooks/migration-immutability-guard.sh:59-67` extracts the entry with
  `awk` keyed on `index($0, "- **119**") == 1` and unblocks when the extracted
  block contains `LOCAL-ONLY`. The entry's first line is
  `- **119** — \`job_outbox\` deny-all RLS (#1171). **LOCAL-ONLY.** No new relation,`
  — marker at position 1, `LOCAL-ONLY` on the same line. The guard exits 0, so
  the still-unapplied file remains amendable, which is the correct posture for a
  migration that has not ridden staging.
- Entries are in descending order and the promotion sentence is correctly
  absent.

The `estimated_prod_lines` / `estimated_test_lines` correction to 150/260 (D7) is
present in both intake copies and matches the measured 147/255.

---

## Low-confidence appendix

Not reported in the table. Recorded so a later reader knows they were
considered and why they were not raised.

1. **No blank line between the 119 and 118 log entries.**
   `.claude/reference/migrations-log.md:2732-2733` — every other entry pair in
   the file is separated by one. Renders identically (the list is already
   loose), and the immutability guard's `awk` terminates on `/^- \*\*[0-9]/`
   either way, so nothing depends on it. Cosmetic.

2. **`MIGRATION_119_JOB_OUTBOX_RLS` is declared in the suite, not in
   `schema-ready.ts`.** That helper's own docstring (`:571-574`) says the
   migration→objects mapping is "owned in ONE place". `schema-ready.ts` is
   outside `allowed_edit_surface`, so the local declaration is the only legal
   option, and D4 argues correctly against widening the helper for one caller.
   Worth a sentence in the deviations doc, not a finding.

3. **`SET lock_timeout` (session-scoped) over a transaction-pooled remote
   apply.** If `apply_migration` were to send the file's statements as separate
   round-trips through Supavisor transaction mode, the `SET` and the `ALTER`
   could land on different backends and the bound would be inert — the exact
   failure D3 exists to prevent, one layer out. I could not establish how the
   Supabase management API routes a multi-statement migration, 092/101 set the
   precedent, and `scripts/test-db-setup.sh`'s one-psql-session-per-file path
   (the case D3 measured) is definitely fine. Flagging as a thing to watch at
   the staging apply, not as a defect.

4. **`revokes[0]).not.toMatch(/\b(postgres|service_role|PUBLIC)\b/)` is
   case-sensitive** (`:119`). A mutation spelled `FROM public` (lowercase) would
   pass. Also, the case pins the number of `REVOKE` lines but not the absence of
   `GRANT` lines, so `GRANT ALL ON job_outbox TO anon;` appended to the file
   would survive every case in the suite. Both are mutations of an immutable
   file that a human wrote and a human is reviewing; the realistic regression is
   a *later* migration, which is F1's subject.

5. **`user_visible_behavior[2]`** ("after this migration lands,
   `pnpm test:db:setup` must be re-run before `ci:rls-audit` and the live-DB
   suites pass locally") is **correct and I verified the mechanism**:
   `scripts/ci/rls-audit.ts:118-127` hashes the bootstrap plus every migration
   file's *content* and compares against `test_meta.provision`, so adding 119
   invalidates the marker regardless of what the migration creates. Nothing to
   report — noted because it is the one place where an object-free migration
   still has a mechanical head detector, and it is not the suite's.
