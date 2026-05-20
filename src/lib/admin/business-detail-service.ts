// src/lib/admin/business-detail-service.ts
//
// Service layer for `GET/PATCH /api/admin/businesses/[id]`.
// Owns the SQL queries; the route handler is a thin HTTP wrapper.
// Mirrors the src/lib/dashboard/service.ts split shipped earlier in this branch.

import { v7 as uuidv7 } from 'uuid';
import { sql } from '@/lib/db/server';
import { safeInvalidateChannelCache } from '@/lib/notifications/resolve-channels';
import { asAccountId } from '@/lib/shared/ids';
import { fetchBusinessDetailBatch1, fetchBusinessDetailBatch2 } from './business-detail/queries';
import { mapBusinessDetailResponse } from './business-detail/mappers';
import type {
  BusinessDetailResponse,
  BusinessPatch,
} from './business-detail-types';

/**
 * Thrown when the UPDATE businesses statement matches zero rows (the
 * business id does not exist). Route maps to 404.
 */
export class AdminBusinessNotFoundError extends Error {
  constructor() {
    super('Admin business not found');
    this.name = 'AdminBusinessNotFoundError';
  }
}

// Column name mapping from camelCase API fields to snake_case DB columns.
// `as const satisfies` freezes the table at compile time so a future field
// addition can't bypass the COLUMN_RE whitelist by widening the type.
//
// IMPORTANT: This whitelist + the COLUMN_RE check in the route handler are
// defense-in-depth. The route MUST keep its COLUMN_RE assertion so that if
// a future entry is added here with a column name that fails the regex,
// the route fails fast at HTTP-input validation instead of reaching
// `tx.unsafe`.
const FIELD_TO_COLUMN = {
  name: 'name',
  category: 'category',
  tone: 'tone',
  productsServices: 'products_services',
  staffNames: 'staff_names',
  highlightFacts: 'highlight_facts',
  avoidFacts: 'avoid_facts',
  website: 'website',
  ownerEmail: 'owner_email',
  ownerEmailBounced: 'owner_email_bounced',
} as const satisfies Record<string, string>;

export { FIELD_TO_COLUMN };

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

/**
 * Apply a PATCH update to a business. Builds a dynamic SET clause from
 * the FIELD_TO_COLUMN whitelist, then optionally upserts the email
 * `channel_enrollments` row in the SAME transaction.
 *
 * Throws:
 *   - `AdminBusinessNotFoundError` when the UPDATE matches zero rows.
 *   - The raw Postgres error (with `code: '23505'`) on duplicate-email
 *     constraint violations. Left to bubble for the route to map to 409;
 *     introducing a typed wrapper is unnecessary churn since the route
 *     is the only caller.
 */
export async function updateBusiness(
  businessId: string,
  patch: BusinessPatch,
): Promise<void> {
  const fields = Object.keys(patch) as (keyof BusinessPatch)[];

  // Build dynamic SET clause: $1 reserved for businessId, fields start at $2.
  // Values bind via $N placeholders; column names come from the hardcoded
  // FIELD_TO_COLUMN whitelist. The COLUMN_RE assertion is enforced in the
  // PATCH handler before this function is called.
  const setClauses: string[] = [];
  const values: (string | string[] | boolean | null)[] = [businessId];

  for (const field of fields) {
    const column = FIELD_TO_COLUMN[field];
    if (!column) {
      // Should be unreachable: the route's COLUMN_RE check rejects unknown
      // fields with 400 before calling here. Guard anyway so a future
      // refactor that loosens the route's check can't silently produce a
      // malformed UPDATE.
      throw new Error(
        `[business-detail-service] No column mapping for field '${String(field)}' — FIELD_TO_COLUMN is out of sync with UpdateBusinessSchema`,
      );
    }
    const value = patch[field] ?? null;
    values.push(value);
    setClauses.push(`${column} = $${values.length}`);
  }
  setClauses.push('updated_at = NOW()');

  const setClause = setClauses.join(', ');
  const query = `UPDATE businesses SET ${setClause} WHERE id = $1`;
  let accountIdToInvalidate: string | null = null;

  await sql.begin(async (tx) => {
    const result = await tx.unsafe(query, values);
    if (result.count === 0) {
      throw new AdminBusinessNotFoundError();
    }
    if (patch.ownerEmail !== undefined) {
      // Upsert: if the email enrollment row was previously disabled/
      // unsubscribed, a fresh owner_email edit is an explicit admin action
      // to re-enable the channel — refresh to verified state in the same
      // transaction as the business UPDATE.
      // After migration 034, channel_enrollments requires account_id and
      // uses the partial unique index on (account_id, channel, COALESCE(location_id, ...)).
      const [bizAccount] = await tx<{ account_id: string }[]>`
        SELECT account_id FROM businesses WHERE id = ${businessId}
      `;
      const accountId = bizAccount?.account_id;
      if (!accountId) {
        throw new Error(`[admin-business-detail] business ${businessId} has no account_id — data inconsistency after migration 034`);
      }
      accountIdToInvalidate = accountId;
      await tx`
        INSERT INTO channel_enrollments
          (id, account_id, business_id, channel, handle, status, verified_at)
        VALUES
          (${uuidv7()}, ${accountId}::uuid, ${businessId}, 'email', ${patch.ownerEmail}, 'verified', NOW())
        ON CONFLICT (account_id, channel, COALESCE(location_id, '00000000-0000-0000-0000-000000000000')) WHERE archived_at IS NULL DO UPDATE SET
          handle              = EXCLUDED.handle,
          status              = 'verified',
          verified_at         = NOW(),
          disabled_at         = NULL,
          unsubscribed_at     = NULL,
          unsubscribed_reason = NULL,
          updated_at          = NOW()
      `;
    }
  });

  if (accountIdToInvalidate) {
    await safeInvalidateChannelCache(
      asAccountId(accountIdToInvalidate),
      'admin.business.owner-email',
    );
  }
}
