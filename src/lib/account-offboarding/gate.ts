import type postgres from 'postgres';

import { sql } from '@/lib/db/server';
import type { ActiveOffboardingState } from './types';

type SqlExecutor = typeof sql | postgres.TransactionSql;

interface ActiveOffboardingRow {
  id: string;
  account_id: string;
  mode: ActiveOffboardingState['mode'];
  status: ActiveOffboardingState['status'];
  failed_step: ActiveOffboardingState['failedStep'];
  terminal_at: null;
  access_ends_at: Date | null;
  teardown_started_at: Date | null;
  purge_after: Date | null;
  purge_started_at: Date | null;
  purge_cancelled_at: Date | null;
}

export async function getOffboardingState(
  accountId: string,
  db: SqlExecutor = sql,
): Promise<ActiveOffboardingState | null> {
  const [row] = await db<ActiveOffboardingRow[]>`
    SELECT
      id,
      account_id,
      mode,
      status,
      failed_step,
      terminal_at,
      access_ends_at,
      teardown_started_at,
      purge_after,
      purge_started_at,
      purge_cancelled_at
    FROM account_offboardings
    WHERE account_id = ${accountId}::uuid
      AND terminal_at IS NULL
    ORDER BY created_at DESC
    LIMIT 1
  `;

  return row ? mapActiveOffboardingRow(row) : null;
}

export function isProcessingBlocked(
  state: ActiveOffboardingState | null,
): boolean {
  return isFullBlockState(state);
}

export function isBillingMutationBlocked(
  state: ActiveOffboardingState | null,
): boolean {
  return state !== null;
}

export function isConnectBlocked(
  state: ActiveOffboardingState | null,
): boolean {
  return isFullBlockState(state);
}

export function isOperationalUIBlocked(
  state: ActiveOffboardingState | null,
): boolean {
  return isFullBlockState(state);
}

export function canReactivate(state: ActiveOffboardingState | null): boolean {
  return (
    state !== null &&
    state.mode === 'cancel_only' &&
    state.status === 'scheduled' &&
    state.teardownStartedAt === null &&
    state.terminalAt === null
  );
}

export function purgeEligible(
  state: ActiveOffboardingState | null,
  now = new Date(),
): boolean {
  return (
    state !== null &&
    state.mode === 'delete_data' &&
    state.status === 'purge_scheduled' &&
    state.purgeAfter !== null &&
    state.purgeAfter <= now &&
    state.purgeStartedAt === null &&
    state.purgeCancelledAt === null
  );
}

function isFullBlockState(state: ActiveOffboardingState | null): boolean {
  if (state === null) return false;
  if (state.status === 'failed') return true;
  if (state.mode === 'delete_data') return true;
  return state.status === 'tearing_down' || state.status === 'purge_scheduled';
}

function mapActiveOffboardingRow(
  row: ActiveOffboardingRow,
): ActiveOffboardingState {
  return {
    id: row.id,
    accountId: row.account_id,
    mode: row.mode,
    status: row.status,
    failedStep: row.failed_step,
    terminalAt: row.terminal_at,
    accessEndsAt: row.access_ends_at,
    teardownStartedAt: row.teardown_started_at,
    purgeAfter: row.purge_after,
    purgeStartedAt: row.purge_started_at,
    purgeCancelledAt: row.purge_cancelled_at,
  };
}
