# Plan — admin overview: window Response Rate + Avg Time to 30d (#482)

Intake contract: `.feature/intake.json`. Ticket: #482 (map #472). RISK=normal, SURFACE=mixed.

## Module / seam (codebase-design)

Deepens the existing `overview-service.ts` module — **no new interface, no new seam**.
- `OverviewData` gains one field (`responseMetricsWindowDays`), mirroring the
  `CostData.days` precedent in `cost-report-service.ts` so the UI label derives
  from the same constant the SQL window uses (single owner for "30").
- `churn-score.ts` is consumed unchanged (it stays the single owner of the churn
  formula — the churn sort stays in app code, per intake non-goals).
- No migration, no new table, `margin-service.ts` untouched (dropped from #482).

## Why the windowing can't be a blanket join predicate

The `businessRows` join feeds columns with opposite temporal needs:
- **Windowed** (recent-responsiveness signals): `total_responses`,
  `completed_responses` (→ responseRate), `avg_response_time_hours`.
- **All-time / current-state** (churn signals, must stay correct): pending count
  (status-based), reconnect count (status-based), last-activity (a dormant
  business's last activity may be >30d old — that *is* the signal).

So the window is applied as a per-aggregate `FILTER (WHERE resp.created_at >= CURRENT_DATE - N::int)`
on the three windowed aggregates only; pending/reconnect/last-activity aggregates
are left untouched. The single JOIN still scans the business's rows (last-activity
needs all-time), so this is a semantics/correctness change, not a hot-path rewrite
— and that is the honest framing at the 250-location capacity target.

## Tracer bullet (single slice)

1. **Tests first (red)** in `overview-service.test.ts`:
   - SQL contract: `businessRows` query carries the window `FILTER (WHERE resp.created_at >= CURRENT_DATE - ?::int)`
     on total/completed/avg; the window value (30) is bound; pending/reconnect
     CASE and last-activity MAX carry **no** created_at window.
   - `responseMetricsWindowDays` is surfaced and equals the value bound into the query.
   - Update the exhaustive `toEqual` shape test to include the new field.
   - Existing sort/pagination tests must stay green (proves windowing didn't reorder).
   (The mock can't execute SQL, so windowing is verified as a SQL contract — this
   is the established house pattern; behavioral exclusion of >30d rows *is* the
   pinned FILTER.)
2. **Implement (green)** in `overview-service.ts`: add `RESPONSE_METRICS_WINDOW_DAYS = 30`;
   convert total/completed/avg to windowed FILTERs; add `responseMetricsWindowDays`
   to `OverviewData` + the return.
3. **UI label** in `overview/page.tsx`: add the field to the local `OverviewData`
   interface; render `Response Rate ({data.responseMetricsWindowDays}d)` and
   `Avg Time ({data.responseMetricsWindowDays}d)`.
4. **Gate**: `scripts/verify-gate.sh` (lint, typecheck, test, ci:*, build since ui,
   + `pnpm ci:tenant-scope`). Confirm the modified query does not newly trip the
   tenant-scope audit (it adds no new table/scope pattern).

## Deviation from /feature step 4

Implementing in-session with TDD rather than dispatching per-task subagents: this
is a single-module tracer bullet and orchestrator context is healthy, so a subagent
handoff would add overhead without benefit (engineering.md — pragmatic, not dogmatic).
The verify gate + dual review (step 7) are unchanged.
