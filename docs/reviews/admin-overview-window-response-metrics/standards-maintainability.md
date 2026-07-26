# Standards & Maintainability Review — admin-overview-window-response-metrics

Reviewer axis: repo coding standards (`.claude/CLAUDE.md` invariants + `.claude/rules/*.md`),
deep-module discipline (`codebase-design`), Fowler code-smell baseline, glossary/domain-language.
Applied via the `thermo-nuclear-code-quality-review` skill.

Diff reviewed: `git diff 96b4f28c...HEAD` (source files only; `.feature/*` and the
handoff doc are process artifacts, out of scope).

Changed source:
- `src/lib/admin/overview-service.ts`
- `src/app/admin/overview/page.tsx`
- `src/lib/admin/__tests__/overview-service.test.ts`
- `scripts/ci/tenant-scope-allowlist.ts`

## Verdict

**0 high/medium findings.** This is a tight, well-disciplined diff. The specific
standards flagged in the review brief were all checked hard and all pass. Two
low-confidence nits are recorded in the appendix only (below the reporting bar).

## Findings table (>=80% confidence, named standard)

_None._

## Standards checked (evidence)

### One authoritative owner for the window "30" — PASS
- `RESPONSE_METRICS_WINDOW_DAYS = 30` (overview-service.ts:25) is the single owner.
  It is referenced by all three windowed SQL FILTERs (lines 244, 245, 246) as a
  bound parameter (`${RESPONSE_METRICS_WINDOW_DAYS}::int`, not a literal) and by the
  DTO field `responseMetricsWindowDays` (line 333). The UI column labels
  (page.tsx:275, 279) derive from `data.responseMetricsWindowDays`, not a second `30`.
  No drift path exists — engineering.md "one authoritative owner for each fact" satisfied.
- The churn-metrics CTE's own `7 / 30 / 35`-day literals (lines 272, 282, 284) are a
  **distinct concept** (notification-approval window + response-time trend windows) and
  were correctly **left untouched**. The constant's comment (lines 23–24) explicitly
  disclaims them ("deliberately NOT the same concept as the churn-metrics CTE's own
  7/30/35-day signal windows"). No conflation occurred. This is exactly the discipline
  the brief asked to confirm.

### No business logic / no new abstraction in the route or presentation layer — PASS
- API route (`src/app/api/admin/overview/route.ts`, unchanged) remains a thin
  orchestrator: `NextResponse.json(await getAdminOverview(...))`. The new DTO field
  flows through untouched — no field-dropping, no reconstruction. repworth.md
  "route handlers parse input, call one module, return output" satisfied.
- page.tsx change is pure presentation: it interpolates the DTO number into the column
  label. No client-side computation of the window. design.md — no premature abstraction;
  a bare constant + FILTER, no wrapper/helper/mode-flag introduced (repworth.md
  "default is no new file / no abstraction before second use").

### Comment quality — PASS
- The stale `// At MVP scale (10-50 businesses) this is fine` comment was **removed**,
  not left to rot, and replaced (lines 231–238) with an accurate rationale. The new
  "Fine at the capacity target (250 locations)" matches ADR 0005's Addendum
  (`docs/adr/0005-beta-launch-posture.md:89`: "50 businesses at launch → 250 locations
  at 6 months"). No stale/contradicting comment survives. design.md "comments current
  and non-duplicative" satisfied.
- The new comments explain WHY (recent responsiveness vs lifetime dilution; why
  pending/last_activity stay all-time as churn signals), not WHAT the SQL does.
  CLAUDE.md global "comments for the why" satisfied.
- DTO JSDoc (line 107) is accurate: "Trailing window (days) that responseRate +
  avgResponseTimeHours cover."

### Naming — PASS
- `RESPONSE_METRICS_WINDOW_DAYS` / `responseMetricsWindowDays` is precise and
  non-surprising: it names the concept (the response-metrics reporting window) and the
  unit (days), and the doc comment ties it to the two aggregates it governs. It does not
  collide with or shadow the churn-signal windows. design.md "names reveal the abstraction."

### SQL readability — PASS
- The `avg_response_time_hours` change moved from
  `AVG(CASE WHEN approved_at IS NOT NULL THEN approved_at - created_at END)` to
  `AVG(approved_at - created_at) FILTER (WHERE approved_at IS NOT NULL AND created_at >= …)`.
  This is the idiomatic Postgres FILTER form and is arguably **more** readable than the
  prior CASE form, while cleanly composing the null-guard and the window into one clause.
- The window predicate is textually repeated across the three windowed aggregates. This
  is **inherent, not factorable duplication**: a query-level `WHERE` would wrongly window
  away the all-time `pending_approval_count` / `pending_reconnect_count` / `last_activity`
  churn signals that share the same `LEFT JOIN`. The per-aggregate FILTER is the correct
  design; folding it into a WHERE would be a behavior bug. No code-judo move available here.

### Test quality — PASS
- The SQL-contract tests pin the real contract, not a tautology: they assert the FILTER
  predicate text `resp.created_at >= CURRENT_DATE - ?::int` is present (parameterized, not
  hard-coded), assert the bound value `30` is in `businessQuery.values`, AND assert the
  current-state aggregates (`pending_approval_count`, `pending_reconnect_count`,
  `last_activity`) are NOT windowed. The second test ties the DTO field to the same bound
  value (`sqlCalls[5].values` contains `result.responseMetricsWindowDays`), directly
  proving the single-owner claim. This is meaningful regression protection for the exact
  invariant the feature introduces.
- The test file header documents the query-index contract (0..7), so the `sqlCalls[5]`
  index is a documented convention, not a magic number.

### tenant-scope allowlist sync — PASS
- All three allowlist snippets (accounts / businesses / responses entries) were updated
  byte-for-byte to match the new query text (scripts/ci/tenant-scope-allowlist.ts:878, 885,
  892). repworth.md "when marking … fix its audit tick in the same change" — the CI audit
  contract was kept in lockstep with the query, so `ci:tenant-scope` won't drift/fail.

## Low-confidence appendix (below reporting bar — NOT findings)

1. **Test could bind FILTER-to-alias more tightly.** The windowing test uses
   `.toContain(...)` for the FILTER predicate and separately for each `AS <alias>`, but
   does not assert the FILTER is attached to each of the three aggregates individually. A
   hypothetical regression that windowed only `total_responses` (and dropped it from
   `avg_response_time_hours`) could still pass. Confidence this matters: low — all three
   share one identical predicate and the current form is standard characterization
   coverage. Optional tightening: assert the predicate occurs 3× (regex/count) rather than
   presence-only.

2. **`CURRENT_DATE - N::int` vs `NOW() - INTERVAL` mixed styles in one file.** The new
   FILTER uses date arithmetic (`CURRENT_DATE - 30`), while the email-health aggregates in
   the same function use `NOW() - INTERVAL '…'`. Not a defect — the new code deliberately
   matches the **churn CTE** sibling style (which also uses `CURRENT_DATE - N`), which is
   the more relevant local convention for these response-window aggregates. Noting only for
   awareness; no change recommended.

## VERDICT: PASS — 0 table findings (0 high, 0 med), 2 low-confidence appendix notes.
