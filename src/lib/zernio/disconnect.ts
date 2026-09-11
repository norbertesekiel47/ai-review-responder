import type { Sql } from 'postgres';
import {
  activeOffboardingStateFromProjection,
  isConnectBlocked,
  type ActiveOffboardingProjection,
} from '@/lib/account-offboarding/gate';
import { reportCaughtError } from '@/lib/shared/report-caught-error';
import { zernioClient } from './client';

export type DisconnectResult =
  | { status: 200; body: { ok: true; note?: 'connection_already_disconnected' } }
  | { status: 403; body: { error: 'account_offboarding_blocked' } }
  | { status: 404; body: { error: 'no_active_connection' } };

/**
 * Shared manual Disconnect operation (ADR 0001's named exception).
 * Callers authenticate first. An owner caller must also establish writable
 * location scope and check its account's offboarding state before calling.
 * Admin callers intentionally target a business across account boundaries;
 * their offboarding check is owned here so both Admin transports share it.
 */
export async function disconnectZernioConnection(
  sql: Sql,
  businessId: string,
  initiator: 'owner' | 'admin',
): Promise<DisconnectResult> {
  if (initiator === 'admin') {
    const [accountRow] = await sql<Array<{
      account_id: string;
    } & ActiveOffboardingProjection>>`
      SELECT a.id AS account_id,
           ao.id AS offboarding_id,
           ao.account_id AS offboarding_account_id,
           ao.mode AS offboarding_mode,
           ao.status AS offboarding_status,
           ao.failed_step AS offboarding_failed_step,
           ao.access_ends_at AS offboarding_access_ends_at,
           ao.teardown_started_at AS offboarding_teardown_started_at,
           ao.purge_after AS offboarding_purge_after,
           ao.purge_started_at AS offboarding_purge_started_at,
           ao.purge_cancelled_at AS offboarding_purge_cancelled_at
      FROM businesses b
      JOIN accounts a ON a.id = b.account_id
      LEFT JOIN account_offboardings ao
        ON ao.account_id = a.id
       AND ao.terminal_at IS NULL
      WHERE b.id = ${businessId}
        AND b.archived_at IS NULL
      ORDER BY ao.created_at DESC NULLS LAST
      LIMIT 1
    `;
    const state = accountRow ? activeOffboardingStateFromProjection(accountRow) : null;
    if (isConnectBlocked(state)) {
      return { status: 403, body: { error: 'account_offboarding_blocked' } };
    }
  }

  const [connection] = await sql<{ zernio_account_id: string }[]>`
    SELECT zernio_account_id
    FROM zernio_connections
    WHERE business_id = ${businessId} AND status = 'active'
    LIMIT 1
  `;
  if (!connection) {
    return { status: 404, body: { error: 'no_active_connection' } };
  }

  const accountId = connection.zernio_account_id;
  const reason = initiator === 'owner' ? 'manual_owner' : 'manual_admin';
  let rowsUpdated = 0;
  await sql.begin(async (tx) => {
    // Pin the selected account as well as active status: a concurrent reconnect
    // must never turn this request into a disconnect of the new connection.
    const result = await tx`
      UPDATE zernio_connections
      SET status = 'disconnected',
          disconnected_at = NOW(),
          disconnect_reason = ${reason},
          last_error = NULL,
          last_error_at = NULL,
          updated_at = NOW()
      WHERE business_id = ${businessId}
        AND zernio_account_id = ${accountId}
        AND status = 'active'
    `;
    rowsUpdated = result.count;
  });
  if (rowsUpdated === 0) {
    return { status: 200, body: { ok: true, note: 'connection_already_disconnected' } };
  }

  // Await the existing bounded call once. A provider failure is reported but
  // does not undo the successful local transition or turn it into a failure.
  try {
    await zernioClient.deleteAccount(accountId);
  } catch (error) {
    reportCaughtError('api/zernio/disconnect', error, {
      businessId,
      kind: 'zernio_delete_account',
    });
  }
  return { status: 200, body: { ok: true } };
}
