// src/lib/admin/business-detail-service.ts
//
// Service layer for `GET/PATCH /api/admin/businesses/[id]`.
// Orchestrates the business-detail fetch: batch1 → null guard → batch2 → map.
// SQL lives in ./business-detail/queries, mapping in ./business-detail/mappers,
// the write path in ./business-detail/update.
// Mirrors the src/lib/dashboard/service.ts split shipped earlier in this branch.

import type { Sql } from 'postgres';
import { fetchBusinessDetailBatch1, fetchBusinessDetailBatch2 } from './business-detail/queries';
import { mapBusinessDetailResponse } from './business-detail/mappers';
import { isSubscriptionTier } from '@/lib/accounts/tier-config';
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
  sql: Sql,
  businessId: string,
): Promise<BusinessDetailResponse | null> {
  const {
    businessRows,
    reviewRows,
    reviewsTotal,
    rankingSnapshots,
    zernioConnectionRows,
    awaitingOwnerConnectRows,
    finalizeIncidentRows,
  } = await fetchBusinessDetailBatch1(sql, businessId);

  const business = businessRows[0];
  if (!business) {
    return null;
  }
  // The ONLY tier guard on this path (it used to be spelled a second time, with
  // the same message, inside mapBusinessDetailResponse). It stays here rather
  // than in the mapper so an unsupported tier costs one query bundle instead of
  // two — pinned by "rejects an unsupported tier after batch 1 and before every
  // batch-2 query". The narrowed value is passed down; the mapper re-derives
  // nothing.
  if (!isSubscriptionTier(business.subscription_tier)) {
    throw new Error(`invalid_ws8_subscription_tier:${business.subscription_tier}`);
  }
  const subscriptionTier = business.subscription_tier;

  const {
    metricsRows,
    accountLocationRows,
    approvalAuditRows,
    accountAuditRows,
    autoApprovalPolicyRows,
    autoApprovalAccountRows,
  } =
    await fetchBusinessDetailBatch2(sql, businessId, business.account_id);

  return mapBusinessDetailResponse({
    business,
    subscriptionTier,
    reviewRows,
    reviewsTotal,
    rankingSnapshots,
    zernioConnectionRows,
    awaitingOwnerConnectRows,
    finalizeIncidentRows,
    metrics: metricsRows[0],
    accountLocationRows,
    approvalAuditRows,
    accountAuditRows,
    autoApprovalPolicyRows,
    autoApprovalAccountRows,
  });
}
