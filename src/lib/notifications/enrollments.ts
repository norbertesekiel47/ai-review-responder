// src/lib/notifications/enrollments.ts
//
// Query helpers for channel_enrollments.

import { sql } from '../db/server';
import type { ChannelId } from './channels/types';

export interface VerifiedEnrollment {
  channel: ChannelId;
  handle: string;
}

/**
 * Returns all channels the business is currently enrolled on and can receive
 * approval notifications through. Excludes disabled and unsubscribed rows.
 * Order is stable (by created_at ASC) so the dispatcher processes channels
 * in enrollment order — useful for deterministic test + log output.
 */
export async function getVerifiedEnrollments(
  businessId: string,
): Promise<VerifiedEnrollment[]> {
  const rows = await sql<VerifiedEnrollment[]>`
    SELECT channel, handle
    FROM channel_enrollments
    WHERE business_id = ${businessId}
      AND status = 'verified'
      AND unsubscribed_at IS NULL
    ORDER BY created_at ASC
  `;
  return rows;
}
