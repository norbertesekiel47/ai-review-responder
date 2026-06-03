'use client';

import type { AggregateDashboardData, PerLocationKpi } from '@/lib/dashboard/types';
import { useLocationScope } from '@/contexts/LocationContext';
import type { LocationId } from '@/lib/shared/ids';
import { Icon } from '@/components/dashboard/shell/Icon';

interface Props {
  locationKpis: AggregateDashboardData['locationKpis'];
}

/** Per-location KPI strip below aggregate KpiCards. Each card shows:
 *  - Location name (display_label)
 *  - Pending approval count
 *  - Recent review count
 *  Clicking a card switches to that location's scoped view via LocationContext.
 *
 *  VAL-DASH-013: KPI strip card click switches to scoped view.
 *  VAL-DASH-027: Card renders "0 pending" and "0 reviews" without layout issues.
 */
export function LocationKpiStrip({ locationKpis }: Props) {
  const { setLocationScope } = useLocationScope();

  if (locationKpis.length <= 1) return null; // No strip needed for single location

  return (
    <div className="loc-kpi-strip">
      {locationKpis.map((kpi) => (
        <LocationKpiCard key={kpi.locationId} kpi={kpi} onClick={() => setLocationScope(kpi.locationId as LocationId)} />
      ))}
    </div>
  );
}

function LocationKpiCard({ kpi, onClick }: { kpi: PerLocationKpi; onClick: () => void }) {
  const hasPending = kpi.pendingApprovalCount > 0;

  return (
    <button
      type="button"
      className={`loc-kpi-card ${hasPending ? 'loc-kpi-card--has-pending' : ''}`}
      onClick={onClick}
    >
      <div className="loc-kpi-card-name">
        {kpi.isPrimary && <span className="loc-picker-primary-dot" style={{ width: 5, height: 5, flexShrink: 0 }} />}
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{kpi.displayName}</span>
      </div>
      <div className="loc-kpi-card-stats">
        <span className={hasPending ? 'stat-pending' : ''}>
          <Icon name="alert" size={10} /> {kpi.pendingApprovalCount} pending
        </span>
        <span>·</span>
        <span>{kpi.recentReviewCount} reviews</span>
      </div>
      <div className="loc-kpi-card-handled">
        {kpi.totalReviewsHandled} handled
        {/* VAL-DASH-028: Billing-pending pill shown when Stripe webhook hasn't confirmed overage */}
        {kpi.billingPending && (
          <span className="billing-pending-pill" title="Stripe billing update pending for this location">
            Billing update pending
          </span>
        )}
      </div>
    </button>
  );
}
