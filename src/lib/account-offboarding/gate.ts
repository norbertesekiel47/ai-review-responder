import type postgres from 'postgres';

import { sql } from '@/lib/db/server';
import type { ActiveOffboardingState } from './types';

type SqlExecutor = typeof sql | postgres.TransactionSql;

export const OFFBOARDING_INTENTS = [
  'processing',
  'approval_callback',
  'notification',
  'publishing',
  'checkout',
  'connect',
  'billing_expanding_mutation',
  'billing_management',
  'operational_ui',
  'offboarding_status',
  'offboarding_keep_my_data',
  'offboarding_reactivation',
] as const;
export type OffboardingIntent = (typeof OFFBOARDING_INTENTS)[number];

export interface OffboardingGate {
  getOffboardingState(accountId: string): Promise<ActiveOffboardingState | null>;
  isBlocked(state: ActiveOffboardingState | null, intent: OffboardingIntent): boolean;
}

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

/**
 * Per-request/per-job gate facade. Instantiate inside a route/worker handler to
 * avoid repeated account_offboardings reads without carrying state across
 * unrelated requests.
 */
export function createOffboardingGate(
  db: SqlExecutor = sql,
): OffboardingGate {
  const stateCache = new Map<string, Promise<ActiveOffboardingState | null>>();
  return {
    getOffboardingState(accountId: string) {
      const cached = stateCache.get(accountId);
      if (cached) return cached;
      const loaded = getOffboardingState(accountId, db);
      stateCache.set(accountId, loaded);
      return loaded;
    },
    isBlocked: isOffboardingIntentBlocked,
  };
}

export function isOffboardingIntentBlocked(
  state: ActiveOffboardingState | null,
  intent: OffboardingIntent,
): boolean {
  if (isDedicatedOffboardingIntent(intent)) return false;
  if (state === null) return false;

  if (intent === 'billing_expanding_mutation' || intent === 'checkout') {
    return isBillingExpansionBlocked(state);
  }

  return isFullBlockState(state);
}

export function isProcessingBlocked(
  state: ActiveOffboardingState | null,
): boolean {
  return isOffboardingIntentBlocked(state, 'processing');
}

export function isBillingMutationBlocked(
  state: ActiveOffboardingState | null,
): boolean {
  return isOffboardingIntentBlocked(state, 'billing_expanding_mutation');
}

export function isCheckoutBlocked(
  state: ActiveOffboardingState | null,
): boolean {
  return isOffboardingIntentBlocked(state, 'checkout');
}

export function isApprovalCallbackBlocked(
  state: ActiveOffboardingState | null,
): boolean {
  return isOffboardingIntentBlocked(state, 'approval_callback');
}

export function isNotificationBlocked(
  state: ActiveOffboardingState | null,
): boolean {
  return isOffboardingIntentBlocked(state, 'notification');
}

export function isPublishingBlocked(
  state: ActiveOffboardingState | null,
): boolean {
  return isOffboardingIntentBlocked(state, 'publishing');
}

export function isBillingManagementBlocked(
  state: ActiveOffboardingState | null,
): boolean {
  return isOffboardingIntentBlocked(state, 'billing_management');
}

export function isConnectBlocked(
  state: ActiveOffboardingState | null,
): boolean {
  return isOffboardingIntentBlocked(state, 'connect');
}

export function isOperationalUIBlocked(
  state: ActiveOffboardingState | null,
): boolean {
  return isOffboardingIntentBlocked(state, 'operational_ui');
}

export function isOffboardingStatusBlocked(
  state: ActiveOffboardingState | null,
): boolean {
  return isOffboardingIntentBlocked(state, 'offboarding_status');
}

export function canKeepMyData(state: ActiveOffboardingState | null): boolean {
  return (
    state !== null &&
    state.mode === 'delete_data' &&
    (
      state.status === 'pending' ||
      state.status === 'tearing_down' ||
      state.status === 'purge_scheduled'
    ) &&
    state.terminalAt === null &&
    state.purgeStartedAt === null &&
    state.purgeCancelledAt === null
  );
}

export function isKeepMyDataBlocked(
  state: ActiveOffboardingState | null,
): boolean {
  return isOffboardingIntentBlocked(state, 'offboarding_keep_my_data') || !canKeepMyData(state);
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

export function isOffboardingReactivationBlocked(
  state: ActiveOffboardingState | null,
): boolean {
  return isOffboardingIntentBlocked(state, 'offboarding_reactivation') || !canReactivate(state);
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

function isDedicatedOffboardingIntent(intent: OffboardingIntent): boolean {
  return (
    intent === 'offboarding_status' ||
    intent === 'offboarding_keep_my_data' ||
    intent === 'offboarding_reactivation'
  );
}

function isBillingExpansionBlocked(state: ActiveOffboardingState): boolean {
  if (isFullBlockState(state)) return true;
  return state.mode === 'cancel_only' && state.status === 'scheduled';
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
