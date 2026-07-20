# feat-477-split-pg-pools-poolwait — deviations

## 2026-07-19 — Task 1 (`sqlRead` bulkhead)

### Blocking gap: `pnpm ci:tenant-scope` fails after wiring `sqlRead` — root cause is OUT OF the Task 1 edit surface

- **What failed:** After moving the `job_outbox` read and the completed-job `responses`
  lookup in `src/app/api/dashboard/past-replies/draft-status/route.ts` onto `sqlRead`
  (exactly per plan Task 1 step 10), `pnpm ci:tenant-scope` fails:
  ```
  tenant-scope-audit: failed — entries: 394 (baseline: 394)
  src/app/api/dashboard/past-replies/draft-status/route.ts: responses: unused tenant scope allowlist entry
  ```
- **Why:** `scripts/ci/tenant-scope-audit.ts`'s `extractSqlTagNames()` (lines ~704–718)
  only recognizes a tagged-template call as a scannable SQL statement when it comes from
  an import specifier whose **source-side** name is literally `sql` (i.e. `import { sql }`
  or `import { sql as X }` from a `db/server` module — the check is
  `if (parts[0]?.trim() !== 'sql') continue;`, where `parts[0]` is the *original* export
  name, not the local alias). `sqlRead` is exported under its own literal name (never
  `sql as sqlRead`), so no import alias trick can satisfy this check — the source name is
  always `sqlRead`, never `sql`. The scanner therefore never even sees the `sqlRead\`...\``
  template in that file, so the pre-existing `tenant-scope-allowlist.ts` entry for
  `draft-status/route.ts: responses` (which legitimized the now-`sqlRead`-tagged SELECT)
  has zero matching scanned statements and is flagged as **stale/unused** — a hard
  failure, independent of the `394 === 394` total-count check.
- **Silent-skip corollary (worth flagging, not a failure today):** the KPI route's gate
  SELECT (`accounts`, also a `TENANT_TABLES` entry) moved to `sqlRead` too, but it had NO
  prior allowlist entry (it was presumably recognized as self-scoped — `WHERE id =
  ${accountId}::uuid` against the tenant-root table itself — without needing one). Since
  the scanner can't see `sqlRead` templates at all, that statement is now silently
  **excluded from tenant-scope auditing entirely** rather than re-verified. It happens to
  cause no CI failure today, but it means any *future* `sqlRead`-tagged query anywhere in
  the codebase will bypass this audit silently until the scanner is fixed.
- **Why I did not fix it:** The task's edit-surface guard was armed for exactly 4 files
  (`src/lib/db/server.ts`, `src/lib/config/server.ts`,
  `src/app/api/dashboard/kpis/route.ts`,
  `src/app/api/dashboard/past-replies/draft-status/route.ts`) + their `__tests__`, with an
  explicit "editing anything else is BLOCKED by a hook — do not attempt." The fix belongs
  in `scripts/ci/tenant-scope-audit.ts`, which is a shared cross-cutting CI script owned
  by no task in this plan's File Structure list — out of scope for Task 1 by design, and I
  did not attempt to edit it (per instruction).
- **The fix, precisely, for whoever picks this up** (in
  `scripts/ci/tenant-scope-audit.ts`, `extractSqlTagNames()`): change
  ```ts
  if (parts[0]?.trim() !== 'sql') continue;
  ```
  to recognize both db/server SQL-tag exports, e.g.
  ```ts
  const SQL_TAG_SOURCE_NAMES = new Set(['sql', 'sqlRead']);
  ...
  if (!SQL_TAG_SOURCE_NAMES.has(parts[0]?.trim() ?? '')) continue;
  tagNames.add(parts[1]?.trim() || (parts[0]?.trim() as string));
  ```
  (the `tagNames.add(parts[1]?.trim() || 'sql')` fallback also needs to stop hard-coding
  `'sql'` as the default local name — it should fall back to the *source* name so an
  un-aliased `sqlRead` import registers as tag `sqlRead`, not `sql`). This needs its own
  regression test in `scripts/ci/__tests__/tenant-scope-audit.test.ts` (assert a
  `sqlRead\`SELECT ... FROM accounts ...\`` template IS extracted) before landing.
- **Net effect on Task 1 verification (before resolution):** `pnpm ci:db-imports` ✅,
  `pnpm ci:static-policy` ✅, `pnpm typecheck` ✅, all affected vitest suites ✅ (241 tests
  across the 4 touched files + their tests). `pnpm ci:tenant-scope` ❌ — blocked on the
  out-of-surface scanner fix described above.

### Resolution — edit surface amended, scanner fixed

Coordinator approved amending the edit surface to include
`scripts/ci/tenant-scope-audit.ts` (its `__tests__` was already in-surface). Applied the
exact fix diagnosed above, surgically:

- `extractSqlTagNames()`: added `DB_SERVER_SQL_TAG_SOURCE_NAMES = new Set(['sql',
  'sqlRead'])`; the per-specifier check now tests source-side membership in that set
  (was: `!== 'sql'`), and the local-name fallback is `parts[1]?.trim() || sourceName`
  (was: hard-coded `|| 'sql'`) — so an un-aliased `sqlRead` import registers tag
  `sqlRead`, not `sql`. `tx`/`db` handling (the base `tagNames` seed set) is untouched.
- Added 2 regression tests to `scripts/ci/__tests__/tenant-scope-audit.test.ts`
  (immediately after the existing "extracts sql, transaction, and imported sql-alias
  tagged templates" case, following its exact style): one asserts
  `extractSqlTemplates` now returns a `{ tag: 'sqlRead', ... }` entry for an
  un-aliased `sqlRead` import (alongside a sibling `sql` import, proving both tags
  coexist correctly); the other asserts `auditSqlText` passes a
  `sqlRead`-tagged `accounts` self-scope query (`WHERE id = ${accountId}::uuid`) with
  zero findings and no allowlist entry needed — mirroring how the same predicate already
  passes when written as `sql`.
- Confirmed via a real `pnpm ci:tenant-scope` run: **`entries: 394 (baseline: 394)`,
  passed** — no "unused tenant scope allowlist entry" finding. The pre-existing
  `draft-status/route.ts: responses` allowlist entry is matched again (its `sqlSnippet`
  comparison is tag-agnostic — text-only — so once the scanner extracts the `sqlRead`
  template, `getAllowlistEntry` matches it identically to before). The KPI route's
  `accounts` gate read is now correctly re-verified as self-scoped by
  `accountTableScoped()` (was previously invisible to the scanner, not merely
  allowlisted) — coverage is *restored*, not loosened.
- **Net effect on Task 1 verification (final):** `pnpm ci:db-imports` ✅,
  `pnpm ci:tenant-scope` ✅, `pnpm ci:static-policy` ✅, `pnpm typecheck` ✅. All affected
  vitest suites (server.test.ts, kpis/route.test.ts, draft-status.test.ts,
  tenant-scope-audit.test.ts) — 107 tests, all passing. Committed together with the
  `sqlRead` wiring as a single Task 1 commit.
