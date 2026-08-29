import { TopBar } from '@/components/dashboard/shell/TopBar';
import { LiveRegion } from '@/components/ui/LiveRegion';
import { AnalyticsTabs } from '@/components/dashboard/analytics/AnalyticsTabs';
import './restraint.css';

export const dynamic = 'force-dynamic';

/**
 * `/dashboard/analytics/restraint` — the **Restraint tab** (CONTEXT.md, LOCKED):
 * the window's total refusal count and its breakdown by **Refusal category**.
 * Display only — this surface records no refusal, changes no gate, and writes
 * nothing.
 *
 * **T6 ships the SHELL only, and that is deliberate.** This file imports
 * nothing from `src/app/api/dashboard/refusals/route.ts` (T5) and nothing from
 * `src/components/dashboard/restraint/` (T7): T6's only blocking edge is T0, and
 * an import of either would make that edge false. It therefore renders the
 * routed tab bar, the TopBar and the loading branch of the shared dashboard
 * scaffold, and stops. **T7 wires the data** — one `RefusalLog` object fetched
 * through the location scope and the analytics window — and replaces the
 * skeleton below with the real screen.
 *
 * It does not call `renderDashboardStatePanel`: that helper emits its own
 * `TopBar` immediately followed by the content box, leaving nowhere between the
 * two for the tab bar, and `DashboardSurface` has no `'restraint'` member (its
 * file is outside T6's edit surface). The loading scaffold is reused by class
 * (`dashboard-skeleton` / `skeleton-card-lg`) instead. See deviations D10.
 */
export default function RestraintPage() {
  return (
    <>
      <TopBar
        title="Restraint"
        subtitle="What we chose not to do for you, and why."
      />
      <div className="content content--analytics">
        <AnalyticsTabs active="restraint" />
        <div className="rst-stack">
          <LiveRegion message="Loading your restraint log…" />
          <div className="dashboard-skeleton">
            <div className="skeleton-card-lg" />
          </div>
        </div>
      </div>
    </>
  );
}
