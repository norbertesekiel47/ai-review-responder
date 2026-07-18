# Standards & Maintainability Review — feat-archival-run-spine-retention

Read-only review. Scope: `git diff main...HEAD` over the six named files.
Method: `thermo-nuclear-code-quality-review` skill applied to the diff, plus the
RepWorth-specific standards checks requested.

## Verdict

The change is clean, precedent-faithful, and well-documented. Arms 7/8 mirror the
existing 5/6 shape, the migration matches the 065 CONCURRENTLY header, the
integration test copies the 078 idiom verbatim, the retention constant is
single-owner and correctly placed, and a build-failing invariant test binds the
window above every live consumer. No structural regression, no shallow
abstraction, no boundary/type leak, no file-size explosion. Only two low-severity
stale-reference nits clear the >=80% confidence bar; the rest is a nice-to-have
appendix.

---

## Findings (>=80% confidence)

### 1. Stale "6 batched DELETEs" comment in the timeout rationale — `worker/background/pollers/ArchivalPoller.ts:8`

The PR correctly updated the arm-count comment at line 27 (`Six` → `Eight`), but
the sibling comment on the `ARCHIVAL_CYCLE_TIMEOUT_MS` rationale still reads:

```
// tick instead ... 30min is far above a real cycle (6 batched
// DELETEs, LIMIT 5000 each → minutes) ...
```

There are now eight batched DELETEs. Two comments describe the same fact (arm
count) and they have drifted apart within one file — a single-owner violation
(`engineering.md`: one authoritative representation per fact) and a stale "what"
comment (`design.md`: comments current). The 30-min headroom conclusion still
holds; only the count is wrong. Fix in the same change.

### 2. Stale "all 6 targets" test description — `worker/background/pollers/__tests__/ArchivalPoller.test.ts:129`

```ts
it('logs "Nothing to archive" when all 6 targets return 0', async () => {
```

The suite now drives eight arms (the same file's neighbours were correctly
relabeled 6→8 at lines 101 and 110). This test's `queueArchivalResults` call
supplies five explicit zeros and lets analytics/agentOutcomes/agentRuns default
to 0, so all eight arms return 0 and the assertion is still valid — but the
description says "6 targets". Stale test name; update to 8 for consistency with
its relabeled siblings.

---

## Detailed standards assessment

**Repo rules / CLAUDE.md invariants**
- Invariant #15 (DB client injection): N/A — `ArchivalPoller` is a
  worker-registered poller and thus a composition root, so the `sql` singleton
  import at line 2 is allowed. Correct.
- No `any`: the diff adds no `any`. Test-only casts (`as TemplateStringsArray`,
  `as string`) match the existing precedent in the same file (the analytics-arm
  query-shape test) — acceptable.
- No string-literal statuses/enums in TS: the only string literals are inside SQL
  template bodies (`status = 'completed'`, etc.), matching arms 1/6. Not a TS
  enum boundary.
- Structured logging: counts only; no raw review/response text, tokens, or
  secrets logged. The saturation warning still joins target *names* into a string
  because the sanitizer drops arrays — consistent with the pre-existing note.
- `make_interval(days => ${...})`: correct parameterization for a numeric day
  window (an `INTERVAL 'N days'` literal can't take a bound param). Matches the
  governor's canonical pattern (`src/lib/auto-approval/governor.ts:72`).

**Deep-module discipline (`codebase-design`)**
- The two new arms follow the flat-arm precedent and add no shallow abstraction.
  The file explicitly documents the flat structure as intentional ("the length is
  the retention vocabulary, one block per table") and carries a
  `fallow-ignore-next-line complexity`. A table-driven loop would be the wrong
  move here: arm 4 (api_costs → rollup aggregation) and arm 1 (dual-status
  predicate) don't share a uniform DELETE shape, so a generic dispatcher would
  hide real per-arm differences behind a leaky abstraction. Keeping arms flat is
  the correct call — reader burden per arm is unchanged; the reader holds one
  more instance of an already-known shape, not a new concept.
- `AGENT_SPINE_RETENTION_DAYS` is single-owner, exported once, co-located with the
  poller that uses it, and consumed by both the arms and the invariant test.
  Well-placed.

**Precedent adherence**
- Arms 7/8 match arms 5/6 (`notification_deliveries`/`analytics_events`) shape
  exactly: `WITH candidates AS (SELECT id ... LIMIT 5000 FOR UPDATE SKIP LOCKED)`,
  `deleted AS (DELETE ... RETURNING id)`, `SELECT COUNT(*)::text`. Bookkeeping
  (count parse, total sum, log field, saturation push) extended uniformly.
- Migration 079 header matches 065 verbatim in structure (CONCURRENTLY warning,
  `pg_index WHERE NOT indisvalid` recovery), and adds the correct staging→prod
  lockstep note. The partial index `WHERE ended_at IS NOT NULL` mirrors 065's
  `idx_ie_archival` partial-predicate pattern, and the migration-log entry cites
  that precedent explicitly.
- The 079 integration test copies the 078 local-DB guard idiom
  (`assertLocalMigrationDatabaseUrl` / `afterLocalMigrationDatabaseGuard` /
  `sql()`). Because CONCURRENTLY indexes can't be built inside a rollback-only
  transaction, it correctly asserts against the already-migrated DB instead of
  emulating the boundary — the right deviation from 078's transaction-scoped
  approach, and the header comment explains why.

**Glossary consistency**
- No CONTEXT.md concept (account, business, outbox job, poller cadence, watchdog)
  is renamed. New terms ("agent-run spine", retention "arm", "retention window")
  are additive; "arm" is pre-existing vocabulary in this file.

**Test quality**
- The invariant suite is the strongest part: it derives
  `maxDashboardWindowDays` from `DASHBOARD_WINDOWS`/`dashboardWindowParams` and
  asserts `AGENT_SPINE_RETENTION_DAYS` strictly exceeds both it and
  `GOVERNOR_WINDOW_DAYS`, so raising any consumer window past retention fails the
  build. This is a real single-owner guard, not a tautology.
- Query-shape assertions (`fullSql.toContain('occurred_at < NOW() -
  make_interval(days =>')`) are moderately whitespace-sensitive but match the
  established precedent for arms 5/6 in the same file, and the matched substrings
  live within single template chunks (unaffected by the `join(' ')`). The
  `not.toContain('DELETE FROM agent_run_steps')` negative assertion is a valid
  regression guard for the "steps prune via cascade, no separate arm" decision,
  reinforced by the integration test's `confdeltype = 'c'` FK check.

---

## Nice-to-have appendix (low confidence / stylistic)

- **Bookkeeping grows linearly with arms.** Count-parse + total-sum + log-field +
  saturation-push are now repeated eight times each. This is the weakest seam in
  the file, but it follows deliberate precedent and arm 4's non-uniform shape
  makes a data-driven collapse unattractive. Not worth changing in this PR; flag
  only if a 9th/10th arm is ever added, at which point a `{name, count}[]` list
  feeding the log object and saturation loop would pay for itself.
- **Migration comment style inconsistency.** `idx_agent_outcomes_archival` gets a
  multi-line block comment; `idx_agent_runs_archival` gets a single ~180-char
  one-liner. Cosmetic — wrapping the second to match the first would read better.
- **Retention comment hardcodes "90".** `ArchivalPoller.ts:16` states the
  dashboard "reads agent_outcomes up to 90 days back" as prose while the test
  derives that bound from `DASHBOARD_WINDOWS`. The test is the real guard, so the
  literal is at worst harmless drift, but phrasing it as "the largest dashboard
  window" would avoid a future stale number.
