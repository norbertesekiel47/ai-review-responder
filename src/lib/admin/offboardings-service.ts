// src/lib/admin/offboardings-service.ts
//
// Extracted verbatim from src/app/api/admin/offboardings/route.ts's GET body
// (admin console Phase 3, Task 6). Same two queries in the same Promise.all,
// same row→DTO mapping, same redactor. Born-injected: `sql` is a parameter,
// not an import — the composition roots (the route and the offboardings server
// page) supply the singleton (invariant #15).
//
// `limit`/`offset` clamping, the `Cache-Control: no-store` header, and the
// `internalError` mapping deliberately stay in the route: it owns query-param
// parsing and HTTP shape. This service takes already-clamped numbers.

import type { Sql } from 'postgres';
import {
  extractConcreteAdminProviderDispositions,
  type AccountOffboardingProviderDispositionProvider,
  type AdminProviderDispositionRecord,
} from '@/lib/account-offboarding/provider-disposition';

interface AdminOffboardingRow {
  id: string;
  account_id: string;
  account_name: string;
  subscription_status: string;
  mode: string;
  status: string;
  failed_step: string | null;
  last_error: string | null;
  requested_at: Date | string;
  access_ends_at: Date | string | null;
  teardown_started_at: Date | string | null;
  teardown_completed_at: Date | string | null;
  purge_after: Date | string | null;
  purge_started_at: Date | string | null;
  purge_cancelled_at: Date | string | null;
  purged_at: Date | string | null;
  terminal_at: Date | string | null;
  stripe_step: string;
  zernio_accounts_step: string;
  zernio_profiles_step: string;
  location_archival_step: string;
  job_terminalization_step: string;
  retry_count: number;
  provider_dispositions: unknown;
  is_stuck: boolean;
}

/** The provider vocabulary the disposition form offers. Single owner is the offboarding domain module. */
export type AdminOffboardingProvider = AccountOffboardingProviderDispositionProvider;

/** One recorded admin provider disposition, as stored in `provider_dispositions` JSONB. */
export type AdminProviderDisposition = AdminProviderDispositionRecord;

export interface AdminOffboarding {
  id: string;
  accountId: string;
  accountName: string;
  subscriptionStatus: string;
  mode: string;
  status: string;
  failedStep: string | null;
  /** Redacted by `scrubAdminLastError` — never the raw operational error. */
  lastError: string | null;
  // Every field below is ISO-8601. Postgres.js decodes timestamptz into a Date;
  // `formatTimestamp` converts here so the RSC path (server page → client
  // component) can never hand a `Date` to a field typed `string`.
  requestedAt: string;
  accessEndsAt: string | null;
  teardownStartedAt: string | null;
  teardownCompletedAt: string | null;
  purgeAfter: string | null;
  purgeStartedAt: string | null;
  purgeCancelledAt: string | null;
  purgedAt: string | null;
  terminalAt: string | null;
  retryCount: number;
  isStuck: boolean;
  providerSteps: {
    stripe: string;
    zernioAccounts: string;
    zernioProfiles: string;
    locationArchival: string;
    jobTerminalization: string;
  };
  providerDispositions: AdminProviderDisposition[];
}

export interface AdminOffboardingsList {
  offboardings: AdminOffboarding[];
  total: number;
}

/**
 * One page of the active / failed / stuck account-offboarding lifecycles plus
 * the unpaginated total, for the console's Offboardings page (spec §4).
 *
 * Callers must gate on admin + current AAL2 first: this is a cross-tenant read
 * of operational offboarding state (allowlisted in tenant-scope for exactly
 * that reason).
 */
export async function getAdminOffboardings(
  sql: Sql,
  { limit, offset }: { limit: number; offset: number },
): Promise<AdminOffboardingsList> {
  const [rows, countRows] = await Promise.all([
    sql<AdminOffboardingRow[]>`
        SELECT
          ao.id,
          ao.account_id,
          a.display_name AS account_name,
          a.subscription_status,
          ao.mode,
          ao.status,
          ao.failed_step,
          ao.last_error,
          ao.requested_at,
          ao.access_ends_at,
          ao.teardown_started_at,
          ao.teardown_completed_at,
          ao.purge_after,
          ao.purge_started_at,
          ao.purge_cancelled_at,
          ao.purged_at,
          ao.terminal_at,
          ao.stripe_step,
          ao.zernio_accounts_step,
          ao.zernio_profiles_step,
          ao.location_archival_step,
          ao.job_terminalization_step,
          ao.retry_count,
          ao.provider_dispositions,
          (
            ao.status = 'failed'
            OR ao.failed_step IS NOT NULL
            OR ao.last_error IS NOT NULL
            OR (
              ao.status = 'scheduled'
              AND ao.access_ends_at IS NOT NULL
              AND ao.access_ends_at <= NOW()
              AND ao.teardown_started_at IS NULL
            )
            OR (
              ao.status = 'purge_scheduled'
              AND ao.purge_after IS NOT NULL
              AND ao.purge_after <= NOW()
              AND ao.purge_started_at IS NULL
            )
          ) AS is_stuck
        FROM account_offboardings ao
        JOIN accounts a ON a.id = ao.account_id
        WHERE ao.terminal_at IS NULL
           OR ao.status = 'failed'
        ORDER BY
          CASE
            WHEN ao.status = 'failed' THEN 0
            WHEN ao.last_error IS NOT NULL THEN 1
            ELSE 2
          END,
          ao.requested_at DESC,
          ao.id ASC
        LIMIT ${limit} OFFSET ${offset}
      `,
    sql<{ total: number }[]>`
        SELECT COUNT(*)::int AS total
        FROM account_offboardings
        WHERE terminal_at IS NULL
           OR status = 'failed'
      `,
  ]);

  return {
    offboardings: rows.map(mapOffboardingRow),
    total: countRows[0]?.total ?? 0,
  };
}

function mapOffboardingRow(row: AdminOffboardingRow): AdminOffboarding {
  return {
    id: row.id,
    accountId: row.account_id,
    accountName: row.account_name,
    subscriptionStatus: row.subscription_status,
    mode: row.mode,
    status: row.status,
    failedStep: row.failed_step,
    lastError: scrubAdminLastError(row.last_error),
    requestedAt: formatTimestamp(row.requested_at),
    accessEndsAt: formatTimestamp(row.access_ends_at),
    teardownStartedAt: formatTimestamp(row.teardown_started_at),
    teardownCompletedAt: formatTimestamp(row.teardown_completed_at),
    purgeAfter: formatTimestamp(row.purge_after),
    purgeStartedAt: formatTimestamp(row.purge_started_at),
    purgeCancelledAt: formatTimestamp(row.purge_cancelled_at),
    purgedAt: formatTimestamp(row.purged_at),
    terminalAt: formatTimestamp(row.terminal_at),
    retryCount: row.retry_count,
    isStuck: row.is_stuck,
    providerSteps: {
      stripe: row.stripe_step,
      zernioAccounts: row.zernio_accounts_step,
      zernioProfiles: row.zernio_profiles_step,
      locationArchival: row.location_archival_step,
      jobTerminalization: row.job_terminalization_step,
    },
    providerDispositions: extractConcreteAdminProviderDispositions(row.provider_dispositions),
  };
}

// Overloaded so `requested_at` (NOT NULL, migration 056) maps to a non-nullable
// DTO field without a cast; the body is the route's original, unchanged.
function formatTimestamp(value: Date | string): string;
function formatTimestamp(value: Date | string | null): string | null;
function formatTimestamp(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

/**
 * Security-relevant redactor: operational offboarding errors can carry provider
 * credentials verbatim. Moved byte-for-byte from the route — do not "improve"
 * or reformat these regexes.
 */
function scrubAdminLastError(value: string | null): string | null {
  if (!value) return null;
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\bBasic\s+[A-Za-z0-9._~+/=-]+/gi, 'Basic [redacted]')
    .replace(
      /(["']?)(api[_-]?key|client[_-]?secret|token|access[_-]?token|refresh[_-]?token|secret|password|authorization)\1\s*[=:]\s*(?:"[^"]*"|'[^']*'|[^,\s}]+)/gi,
      (_match, _quote, key: string) => `${key}=[redacted]`,
    )
    .slice(0, 500);
}
