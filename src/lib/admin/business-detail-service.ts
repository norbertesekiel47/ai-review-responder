// src/lib/admin/business-detail-service.ts
//
// Service layer for `GET/PATCH /api/admin/businesses/[id]`.
// Orchestrates the business-detail fetch: batch1 → null guard → batch2 → map.
// SQL lives in ./business-detail/queries, mapping in ./business-detail/mappers,
// the write path in ./business-detail/update.
// Mirrors the src/lib/dashboard/service.ts split shipped earlier in this branch.

import { fetchBusinessDetailBatch1, fetchBusinessDetailBatch2 } from './business-detail/queries';
import { mapBusinessDetailResponse } from './business-detail/mappers';
import type {
  BusinessDetailResponse,
} from './business-detail-types';

export { AdminBusinessNotFoundError } from './business-detail/errors';
export { updateBusiness, FIELD_TO_COLUMN } from './business-detail/update';

/**
 * Fetch the admin business-detail aggregation: business row + reviews +
 * latest non-superseded responses + ranking snapshots + churn-score
 * metrics. Returns null when the business does not exist (route maps
 * to 404).
 */
export async function getBusinessDetail(
  businessId: string,
): Promise<BusinessDetailResponse | null> {
  const {
    businessRows,
    reviewRows,
    rankingSnapshots,
    zernioConnectionRows,
    awaitingOwnerConnectRows,
    finalizeIncidentRows,
  } = await fetchBusinessDetailBatch1(businessId);

  const business = businessRows[0];
  if (!business) {
    return null;
  }

  const { metricsRows, accountLocationRows, approvalAuditRows, accountAuditRows } =
    await fetchBusinessDetailBatch2(businessId, business.account_id);

  return mapBusinessDetailResponse({
    business,
    reviewRows,
    rankingSnapshots,
    zernioConnectionRows,
    awaitingOwnerConnectRows,
    finalizeIncidentRows,
    metrics: metricsRows[0],
    accountLocationRows,
    approvalAuditRows,
    accountAuditRows,
  });
}

