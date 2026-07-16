import type postgres from 'postgres';

import type { ActiveOffboardingState } from './types';

type SqlExecutor = postgres.Sql | postgres.TransactionSql;

/**
 * Pins the account row before an offboarding-aware billing mutation reads the
 * active lifecycle row. The lifecycle read must be a *later SQL command* under
 * READ COMMITTED: a combined `SELECT ... FOR UPDATE` + join takes its statement
 * snapshot before waiting, so it can miss an offboarding row inserted by the
 * transaction that released the account lock.
 */
export async function lockAccountBeforeOffboardingProjection(
  tx: postgres.TransactionSql,
  accountId: string,
): Promise<boolean> {
  const rows = await tx<{ id: string }[]>`
    SELECT id
    FROM accounts
    WHERE id = ${accountId}::uuid
    FOR UPDATE
  `;
  return rows.length === 1;
}

export const OFFBOARDING_INTENTS = [
  'processing',
  'notification',
  'publishing',
  'checkout',
  'connect',
  'billing_expanding_mutation',
  'billing_management',
  'operational_ui',
] as const;
export type OffboardingIntent = (typeof OFFBOARDING_INTENTS)[number];

export interface OffboardingGate {
  getOffboardingState(accountId: string): Promise<ActiveOffboardingState | null>;
  isBlocked(state: ActiveOffboardingState | null, intent: OffboardingIntent): boolean;
}

export interface ActiveOffboardingProjection {
  offboarding_id?: string | null;
  offboarding_account_id?: string | null;
  offboarding_mode?: ActiveOffboardingState['mode'] | null;
  offboarding_status?: ActiveOffboardingState['status'] | null;
  offboarding_failed_step?: ActiveOffboardingState['failedStep'];
  offboarding_access_ends_at?: Date | null;
  offboarding_teardown_started_at?: Date | null;
  offboarding_purge_after?: Date | null;
  offboarding_purge_started_at?: Date | null;
  offboarding_purge_cancelled_at?: Date | null;
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
  db: SqlExecutor,
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

export function activeOffboardingStateFromProjection(
  row: ActiveOffboardingProjection,
): ActiveOffboardingState | null {
  if (
    !row.offboarding_id ||
    !row.offboarding_account_id ||
    !row.offboarding_mode ||
    !row.offboarding_status
  ) {
    return null;
  }

  return {
    id: row.offboarding_id,
    accountId: row.offboarding_account_id,
    mode: row.offboarding_mode,
    status: row.offboarding_status,
    failedStep: row.offboarding_failed_step ?? null,
    terminalAt: null,
    accessEndsAt: row.offboarding_access_ends_at ?? null,
    teardownStartedAt: row.offboarding_teardown_started_at ?? null,
    purgeAfter: row.offboarding_purge_after ?? null,
    purgeStartedAt: row.offboarding_purge_started_at ?? null,
    purgeCancelledAt: row.offboarding_purge_cancelled_at ?? null,
  };
}

/**
 * Per-request/per-job gate facade. Instantiate inside a route/worker handler to
 * avoid repeated account_offboardings reads without carrying state across
 * unrelated requests.
 */
export function createOffboardingGate(
  db: SqlExecutor,
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

function isBillingExpansionBlocked(state: ActiveOffboardingState): boolean {
  if (isFullBlockState(state)) return true;
  return isCancellationPendingLane(state);
}

function isFullBlockState(state: ActiveOffboardingState | null): boolean {
  if (state === null) return false;
  if (state.mode === 'delete_data') return true;
  if (state.status === 'tearing_down' || state.status === 'purge_scheduled') return true;
  if (state.status === 'failed') {
    // A cancel_only billing-step failure happens BEFORE teardown begins: the owner
    // is still being charged and nothing destructive has run, so a full lockout
    // would trap them while billing continues. Fall back to the cancellation-pending
    // lane instead. Any other failure (teardown started, or a non-billing failed
    // step) is a genuine full block.
    return state.teardownStartedAt !== null || state.failedStep !== 'billing';
  }
  return false;
}

/**
 * cancel_only, pre-teardown, still paid-through: a scheduled cancellation or a
 * billing-step failure that has not yet started teardown. In this lane the owner
 * keeps normal product access, but billing-expanding mutations stay frozen.
 */
function isCancellationPendingLane(state: ActiveOffboardingState): boolean {
  if (state.mode !== 'cancel_only') return false;
  if (state.teardownStartedAt !== null) return false;
  return (
    state.status === 'scheduled' ||
    (state.status === 'failed' && state.failedStep === 'billing')
  );
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
