import { NextRequest, NextResponse } from 'next/server';
import { requireAdminWithAal2, internalError } from '@/lib/auth/admin-mfa-gate';
import { sql } from '@/lib/db/server';
import { extractConcreteAdminProviderDispositions } from '@/lib/account-offboarding/provider-disposition';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store, private' } as const;

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

export async function GET(request: NextRequest): Promise<NextResponse> {
  const gate = await requireAdminWithAal2(request);
  if (!gate.ok) return gate.response;

  const limit = Math.min(
    Math.max(parseInt(request.nextUrl.searchParams.get('limit') ?? '50', 10) || 50, 1),
    100,
  );
  const offset = Math.max(
    parseInt(request.nextUrl.searchParams.get('offset') ?? '0', 10) || 0,
    0,
  );

  try {
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

    return NextResponse.json(
      {
        offboardings: rows.map(mapOffboardingRow),
        total: countRows[0]?.total ?? 0,
        limit,
        offset,
      },
      { headers: NO_STORE },
    );
  } catch (err) {
    return internalError('[api/admin/offboardings] list failed:', err);
  }
}

function mapOffboardingRow(row: AdminOffboardingRow) {
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

function formatTimestamp(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

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
