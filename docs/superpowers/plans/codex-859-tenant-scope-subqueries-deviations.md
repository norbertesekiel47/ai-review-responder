# codex-859 — deviations

---

## D1 — surface overlap with `feat-860-ask-regeneration-surface` (owner-decided, merge order agreed)

**When:** recorded from the `feat-860` session at its step 2, 2026-08-17.

**What:** `feat-860` (per-ask **Ask regeneration** surface, issue #860) adds a
third owner verb `requestAskRegeneration` to `src/lib/solicitation/approval.ts`
and two new fields plus an in-flight `job_outbox` read to
`src/lib/solicitation/batch-view.ts` — the same two files this ticket rewrites.

This ticket collapses `lockBatchForAction`'s two-statement split back into one
correlated form and `approveBatch`'s readiness anti-join back into `NOT EXISTS`.
`feat-860` reuses `lockBatchForAction` but does not change its signature or
return type, so the reuse is unaffected either way. The genuine conflict surface
is the file-header prose and the SQL hunks.

**Owner decision:** **merge order is `#859` before `#860`.** Nothing is required
of this ticket — land normally. `feat-860` sequences its `approval.ts` /
`batch-view.ts` work last and rebases onto this branch's result.

If `feat-860` reaches those tickets before this one merges, it will write its new
statements in the scanner-shaped workaround form. Treat that as one more #629-era
workaround to revert, consistent with this ticket's existing scope.

**Also noted in:** `feat-860-ask-regeneration-surface` deviations.

---

## D2 — branch review found two analyzer false negatives; fixed before merge (owner-directed)

**When:** branch review, 2026-08-17, after the first green gate (fingerprint
`936e4757…`).

**What:** adversarial fixtures run through `auditSqlText` with allowlists
disabled showed two shapes the flattened scanner FLAGGED and the query-block
analyzer ACCEPTED — the exact "must not start accepting genuinely unscoped
queries" risk #859 named:

1. **Unqualified proof on a column the table lacks.** `directlyScoped` allowed
   `account_id = $1` / `business_id = $1` for any single-binding block. But
   `reviews`, `responses` and 20 other tenant tables carry only `business_id`;
   `auto_approval_policies`, `account_audit_log` and others only `account_id`.
   Inside a subquery PostgreSQL resolves the missing column to the OUTER row, so
   `EXISTS (SELECT 1 FROM reviews WHERE account_id = $1)` compiles and restricts
   nothing (`EXPLAIN` on the test DB: filterless `Seq Scan on reviews`). At the
   root the same statement is a compile error, which is why the old rule was
   safe there and unsafe once the analyzer descended.
2. **Grandchild inherits a shadowed ancestor alias.** `analyzeQueryBlock` passed
   `input.ancestors` down unfiltered, so a block that re-bound `r` (non-tenant
   table, derived table, table function) hid `r` from ITS bindings but not from
   its children's — contradicting the plan's "alias names never cross lexical
   blocks".

**Fix:** (1) `TENANT_SCOPE_COLUMNS` in `scripts/ci/tenant-tables.ts` — an
exhaustive `Record<TenantTable, …>` (typecheck-enforced) that `directlyScoped`,
`tenantIdentityColumns` and the via-account/via-business rules consult; a
read-only live-DB suite asserts it against `information_schema` at migration
head so a dropped column cannot silently re-open the hole. (2) children receive
only ancestors the current block does not re-bind (none when a relation's alias
is undeterminable). Plus a cosmetic third: a plain literal nested in a `${…}`
placeholder no longer inherits the enclosing tag (it is a bind parameter, not a
statement). Four regression tests added; parser suite 107 → 111. Neither fix
moved a repository finding (applied gate 381 / disabled 342 unchanged), and one
existing fixture that had used `reviews … account_id` — a schema-impossible
statement — was re-pointed at `channel_enrollments`.

**Surface:** `scripts/ci/tenant-tables.ts`,
`scripts/ci/__tests__/tenant-tables.integration.test.ts` and `docs/directory.md`
(its `approval.ts` row still instructed "never in a subquery … do not re-nest")
added to the intake surface; estimates re-stated 1,400 / 1,250 lines.
