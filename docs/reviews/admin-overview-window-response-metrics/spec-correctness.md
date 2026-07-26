# Spec & Correctness Review — admin-overview-window-response-metrics (#482)

Reviewed diff: `git diff 96b4f28c...HEAD` in worktree
`RepWorth-worktrees/admin-overview-window-response-metrics`.
Contract: `.feature/intake.json`. Plan: `docs/superpowers/plans/admin-overview-window-response-metrics.md`.

## VERDICT: 0 findings (0 high, 0 med) — faithful implementation.

The diff faithfully implements the intake contract field by field. No correctness
bug meets the ≥80% confidence bar. Two low-confidence observations recorded in the
appendix only (not blocking).

---

## Field-by-field verification against `.feature/intake.json`

### goal + user_visible_behavior — PASS
- Response Rate + Avg Time are windowed to a trailing 30d via per-aggregate
  `FILTER (WHERE resp.created_at >= CURRENT_DATE - ${RESPONSE_METRICS_WINDOW_DAYS}::int)`
  on `total_responses`, `completed_responses`, `avg_response_time_hours`
  (`overview-service.ts:244-246`).
- Churn sort + LIMIT/OFFSET stay in app code (`overview-service.ts:310-320`),
  unchanged.
- Pending/Reconnect/Last-Activity stay all-time: `pending_approval_count`,
  `pending_reconnect_count` (`:242-243`) and `last_activity` MAX (`:247`) carry
  no window.
- UI relabels both columns to "Response Rate (30d)" / "Avg Time (30d)" via
  `data.responseMetricsWindowDays` (`page.tsx:275-280`).
- Nothing more, nothing less: no other columns/behaviors changed. `totalResponses`
  / `completedResponses` are not rendered in the UI (only `responseRate%` and
  `avgResponseTimeHours` are — `page.tsx:333-339`), so the windowed counts do not
  leak as unlabeled all-time numbers.

### non_goals — PASS (all respected)
- `margin-service.ts`: not in the changed-files list. UNCHANGED. ✓
- Churn formula not re-implemented in SQL: `businessRows` query contains no churn
  math; `computeChurnRiskScore` (JS, single owner) consumed unchanged
  (`overview-service.ts:132`). ✓
- `api_costs_daily_rollups`: not referenced anywhere in the diff (only named in
  intake/plan prose). ✓
- Pending / Reconnect / Last Activity semantics: unchanged (no window applied). ✓
- Churn score computation + sort order: unchanged. ✓

### invariants — PASS
- Sort keys (`churnScore.score`, `pendingApprovalCount`, `name`, `id` —
  `:313-319`) are none of the windowed columns; churnScore derives from the
  SEPARATE `metricsRows` CTE (`:258-305`), which is untouched. Windowing cannot
  reorder. ✓
- `overview-service.ts` stays born-injected: `sql` is a parameter; no
  `@/lib/db/server` import added. `pnpm ci:tenant-scope` passes at baseline 393
  (unchanged), and db-imports baseline untouched. ✓
- Route stays thin (`route.ts:22-24` — parse → call → `NextResponse.json(data)`);
  not edited. ✓
- No new tenant-scope flagged pattern: audit passes with 393==393 entries; the 3
  allowlist snippets (accounts/businesses/responses) all updated byte-consistently.
  ✓
- No new `NEXT_PUBLIC_*` (grep clean). No new string-literal statuses introduced —
  new code uses `HANDLED_STATUSES` constant; the `'pending_approval'` /
  `'awaiting_owner_connect'` / `'superseded'` literals are pre-existing and
  unchanged by this diff. ✓
- Single owner for "30": `RESPONSE_METRICS_WINDOW_DAYS = 30` (`:25`) feeds the SQL
  window (`:244-246`), the DTO field (`:333`), and the UI label (via
  `data.responseMetricsWindowDays`). No duplicated magic 30. ✓

### edge_cases — PASS (all four handled)
1. Only-old responses → in-window `total_responses` = 0 → `responseRate` = 0 via
   `row.total_responses > 0 ? … : 0` guard (`:120-123`); avg FILTER matches no
   rows → `AVG` NULL → `avg_response_time_hours` null → UI '—'. Business still
   produces a row (GROUP BY b.id). ✓ Pinned by existing test `overview-service.test.ts:217-219`.
2. Old still-pending items: `pending_approval_count` is un-windowed (all-time
   status CASE) → still counted. ✓
3. Dormant business last-activity >30d: `MAX(GREATEST(...))` un-windowed → true old
   timestamp shown. ✓
4. In-window responses but none approved-in-window: avg FILTER (requires
   `approved_at IS NOT NULL`) matches none → NULL → '—'; responseRate from windowed
   total/completed. ✓

### tests_to_add — PASS (all six accounted for)
- (1) Windowed rate excludes >30d, (2) windowed avg excludes >30d, (3) pending/
  reconnect all-time, (4) last-activity all-time: covered by the SQL-contract test
  `overview-service.test.ts:508-533` (asserts the window FILTER is present on the
  windowed aggregates and ABSENT from the pending/reconnect/last-activity
  expressions; value 30 bound). The mock cannot execute SQL, so behavioral
  exclusion is verified as the pinned FILTER — the established house pattern noted
  in the file header and the plan.
- (2, null→'—' service path): pre-existing test `:217-219` pins
  `avgResponseTimeHours` null + `responseRate` 0. The '—' render is UI
  (`page.tsx:336-338`). ✓
- (5) Sort unchanged: existing `:333` sort/tiebreaker + `:426` pagination tests act
  as the regression guard (their fixtures don't depend on the windowed aggregates,
  so a passing run proves windowing didn't reorder). ✓
- (6) `responseMetricsWindowDays` surfaced == constant: `:535-542` + the exhaustive
  shape `toEqual` updated at `:166`. ✓
- All 15 tests pass (`pnpm vitest run` — 15 passed).

### allowed_edit_surface — PASS
Edited product files: `overview-service.ts`, its `__tests__`, `overview/page.tsx`,
`tenant-scope-allowlist.ts` — all inside the declared surface. Remaining changed
files (`.feature/intake.json`, `.feature/sessions`, the plan doc) are /feature
workflow artifacts, not product code. No file edited outside the surface.

---

## Correctness deep-dive (the requested scrutiny points)

1. **FILTER semantics vs old CASE.**
   - `total_responses`: old `COUNT(resp.id)` → new `COUNT(resp.id) FILTER (WHERE
     created_at >= window)`. No-response business (LEFT JOIN → single all-NULL row):
     FILTER `NULL >= window` = false → 0; old `COUNT(NULL)` = 0. Equivalent, both
     produce a row. ✓
   - `completed_responses`: old `COUNT(CASE WHEN status=ANY THEN 1 END)` → new
     `COUNT(*) FILTER (WHERE status=ANY AND created_at>=window)`. For the null-pad
     row, `status = ANY(...)` is NULL → FILTER false → 0 (matches old CASE→NULL→
     uncounted). `COUNT(*)` == `COUNT(resp.id)` here because the FILTER's
     `status=ANY` already requires a real (non-null) row. Equivalent-but-windowed. ✓
   - `completed ≤ total` always holds (handled ⊆ non-superseded, both windowed the
     same way) → `responseRate ≤ 100`, no NaN/∞ (guard on total>0). ✓
   - No NULL/LEFT-JOIN edge produces a spurious row or flips 0↔NULL versus the old
     query.

2. **Postgres type-check of `CURRENT_DATE - ${WINDOW}::int`.** `date - integer =
   date`; `timestamptz >= date` promotes the date to session-tz midnight — valid,
   and identical to the pre-existing CTE idiom (`rp.created_at >= CURRENT_DATE - 7`,
   `:272/282/284`). Bind renders as `CURRENT_DATE - $1::int` with 30 as the bound
   param (test asserts `values` contains 30 and text contains
   `CURRENT_DATE - ?::int`). No render risk. ✓

3. **Churn sort inputs unaffected.** `churnScore` ← `metricsRows` CTE (unchanged);
   `pendingApprovalCount` ← un-windowed businessRows aggregate; `name`/`id`
   unchanged. `responseTimeTrend` uses `m.avg_hours_current/prev` (CTE), not the
   windowed businessRows avg. Windowing touches no sort input. ✓

4. **UI scope of `data.responseMetricsWindowDays`.** `data` is guaranteed non-null
   at the `<th>` render: early return `if (isError || !data)` at `page.tsx:158`,
   then `const { systemHealth, businesses } = data` at `:171`. The `<th>` labels
   (`:276/279`) reference `data.responseMetricsWindowDays` after that guard. Route
   passes the field through (`NextResponse.json(data)`), local `OverviewData`
   interface includes it (`page.tsx:31`). No undefined-render risk. ✓

5. **Tenant-scope allowlist consistency.** All three snippets (accounts /
   businesses / responses) updated identically to the new FILTER text; audit passes
   with entry count unchanged (393 → 393), confirming byte-consistency with the
   audit's normalization and no over-broad widening. ✓

---

## Low-confidence appendix (non-blocking, NOT in the findings table)

- **Contract-test looseness (info).** `overview-service.test.ts:519` asserts
  `text.toContain('resp.created_at >= CURRENT_DATE - ?::int')`, which confirms the
  window FILTER appears at least once but does not individually bind it to each of
  the three windowed aggregates (`total`/`completed`/`avg`). The explicit
  substring assertions for the un-windowed pending/reconnect/last-activity columns
  are precise, so a regression that dropped the window from, say, only
  `avg_response_time_hours` while keeping it on `total_responses` could slip
  through. Given the mock can't execute SQL and the plan explicitly frames this as
  the house SQL-contract pattern, this is a test-strength note, not a defect.
- **No behavioral (executed-SQL) test (info).** The windowing behavior is verified
  purely as a query contract. This is inherent to the mock harness and consistent
  with the existing file; an integration test against a real DB would be the only
  way to pin actual >30d row exclusion, but that is out of scope for this module's
  established test approach.
