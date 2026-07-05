import { createHash } from 'node:crypto';
import { z } from 'zod';
import { jsonb, sql } from '@/lib/db/server';
import { writeAccountAuditLog } from '@/lib/audit/log';

const ADMIN_PROVIDER_DISPOSITION_TYPE = 'admin_provider_disposition';

const ACCOUNT_OFFBOARDING_PROVIDER_DISPOSITION_PROVIDERS = [
  'stripe',
  'zernio',
  'google',
  'supabase_auth',
  'other',
] as const;

export type AccountOffboardingProviderDispositionProvider =
  (typeof ACCOUNT_OFFBOARDING_PROVIDER_DISPOSITION_PROVIDERS)[number];

export const ProviderDispositionInputSchema = z.object({
  provider: z.enum(ACCOUNT_OFFBOARDING_PROVIDER_DISPOSITION_PROVIDERS),
  resourceType: z.string().trim().min(1).max(80),
  resourceReference: z.string().trim().min(1).max(240),
  reason: z.string().trim().min(1).max(1_000),
  ticket: z.string().trim().min(1).max(120).optional(),
});

export interface AdminProviderDispositionRecord {
  type: typeof ADMIN_PROVIDER_DISPOSITION_TYPE;
  provider: AccountOffboardingProviderDispositionProvider;
  resource_type: string;
  scrubbed_resource_reference: string;
  reason: string;
  admin_actor_user_id: string;
  recorded_at: string;
  ticket: string | null;
}

export interface RecordProviderDispositionInput {
  offboardingId: string;
  adminUserId: string;
  provider: AccountOffboardingProviderDispositionProvider;
  resourceType: string;
  resourceReference: string;
  reason: string;
  ticket?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

export interface RecordProviderDispositionResult {
  offboardingId: string;
  accountId: string;
  disposition: AdminProviderDispositionRecord;
  transitionedToPurgeScheduled: boolean;
}

interface ProviderDispositionOffboardingRow {
  id: string;
  account_id: string;
  mode: string;
  status: string;
  failed_step: string | null;
  terminal_at: Date | string | null;
  purge_after: Date | string | null;
  purge_cancelled_at: Date | string | null;
  stripe_subscription_id: string | null;
  zernio_account_ids: string[] | null;
  zernio_profile_ids: string[] | null;
  location_ids: string[] | null;
  stripe_step: string;
  zernio_accounts_step: string;
  zernio_profiles_step: string;
  location_archival_step: string;
  provider_dispositions: unknown;
}

// The immutable teardown snapshot + the mutable per-step outcomes. Applicability of
// a provider step is derived from the SNAPSHOT (was there work to do?), never from
// the step column alone — a step that never ran because teardown aborts on the first
// failure sits at its 'not_applicable' DEFAULT, indistinguishable from genuinely-N/A.
export interface ProviderTeardownStepState {
  stripe_subscription_id: string | null;
  zernio_account_ids: string[] | null;
  zernio_profile_ids: string[] | null;
  location_ids: string[] | null;
  stripe_step: string | null;
  zernio_accounts_step: string | null;
  zernio_profiles_step: string | null;
  location_archival_step: string | null;
}

export class ProviderDispositionError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(code);
    this.name = 'ProviderDispositionError';
  }
}

export function buildAdminProviderDispositionRecord(
  input: RecordProviderDispositionInput,
  recordedAt: Date = new Date(),
): AdminProviderDispositionRecord {
  return {
    type: ADMIN_PROVIDER_DISPOSITION_TYPE,
    provider: input.provider,
    resource_type: scrubDispositionText(input.resourceType, 80),
    scrubbed_resource_reference: hashResourceReference(
      scrubDispositionText(input.resourceReference, 240),
    ),
    reason: scrubDispositionText(input.reason, 1_000),
    admin_actor_user_id: input.adminUserId,
    recorded_at: recordedAt.toISOString(),
    ticket: input.ticket ? scrubDispositionText(input.ticket, 120) : null,
  };
}

export function hasConcreteAdminProviderDisposition(value: unknown): boolean {
  return extractConcreteAdminProviderDispositions(value).length > 0;
}

export function extractConcreteAdminProviderDispositions(
  value: unknown,
): AdminProviderDispositionRecord[] {
  return parseJsonArray(value).filter(isConcreteAdminProviderDisposition);
}

function isConcreteAdminProviderDisposition(
  value: unknown,
): value is AdminProviderDispositionRecord {
  if (!isRecord(value)) return false;
  if (value.type !== ADMIN_PROVIDER_DISPOSITION_TYPE) return false;
  if (!isKnownProvider(value.provider)) return false;
  return (
    isNonEmptyString(value.resource_type) &&
    isNonEmptyString(value.scrubbed_resource_reference) &&
    isNonEmptyString(value.reason) &&
    isNonEmptyString(value.admin_actor_user_id) &&
    isNonEmptyString(value.recorded_at) &&
    (value.ticket === null || typeof value.ticket === 'string')
  );
}

export async function recordProviderDisposition(
  input: RecordProviderDispositionInput,
  db: typeof sql = sql,
): Promise<RecordProviderDispositionResult> {
  const disposition = buildAdminProviderDispositionRecord(input);

  return db.begin(async (tx) => {
    const [row] = await tx<ProviderDispositionOffboardingRow[]>`
      SELECT id, account_id, mode, status, failed_step, terminal_at,
             purge_after, purge_cancelled_at,
             stripe_subscription_id, zernio_account_ids, zernio_profile_ids, location_ids,
             stripe_step, zernio_accounts_step, zernio_profiles_step,
             location_archival_step, provider_dispositions
      FROM account_offboardings
      WHERE id = ${input.offboardingId}::uuid
      FOR UPDATE
    `;

    if (!row) {
      throw new ProviderDispositionError(404, 'offboarding_not_found');
    }
    if (row.terminal_at !== null) {
      throw new ProviderDispositionError(409, 'offboarding_terminal');
    }
    if (row.mode !== 'delete_data') {
      throw new ProviderDispositionError(409, 'mode_not_delete_data');
    }

    const transitionedToPurgeScheduled = shouldTransitionToPurgeScheduled(
      row,
      disposition,
    );
    const nextStatus = transitionedToPurgeScheduled ? 'purge_scheduled' : row.status;
    const nextFailedStep = transitionedToPurgeScheduled ? null : row.failed_step;

    await tx`
      UPDATE account_offboardings
      SET provider_dispositions = provider_dispositions || ${jsonb([disposition])},
          status = ${nextStatus},
          failed_step = ${nextFailedStep},
          last_error = CASE WHEN ${transitionedToPurgeScheduled} THEN NULL ELSE last_error END,
          updated_at = NOW()
      WHERE id = ${row.id}::uuid
        AND account_id = ${row.account_id}::uuid
    `;

    await writeAccountAuditLog(tx, {
      accountId: row.account_id,
      actorUserId: input.adminUserId,
      eventType: 'account_offboarding_provider_disposition_recorded',
      entityType: 'account_offboarding',
      entityId: row.id,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
      requestId: input.requestId ?? null,
      payload: {
        provider: disposition.provider,
        resource_type: disposition.resource_type,
        scrubbed_resource_reference: disposition.scrubbed_resource_reference,
        reason: disposition.reason,
        ticket: disposition.ticket,
        previous_status: row.status,
        failed_step: row.failed_step,
        transitioned_to_purge_scheduled: transitionedToPurgeScheduled,
      },
    });

    return {
      offboardingId: row.id,
      accountId: row.account_id,
      disposition,
      transitionedToPurgeScheduled,
    };
  });
}

// Provider teardown steps that are APPLICABLE (snapshot non-empty) but not yet
// resolved — neither completed ('success') nor covered by a concrete admin
// disposition for that provider. A non-empty result means a force-purge would
// destroy the local pointers to a provider resource (e.g. a live Zernio account or
// Google location) that was never torn down and never dispositioned — a blind
// force-purge. Only stripe/zernio/google map to teardown steps.
export function unresolvedApplicableTeardownProviders(
  state: ProviderTeardownStepState,
  dispositions: AdminProviderDispositionRecord[],
): AccountOffboardingProviderDispositionProvider[] {
  const covered = new Set(dispositions.map((disposition) => disposition.provider));
  const checks: Array<{
    applicable: boolean;
    step: string | null;
    provider: AccountOffboardingProviderDispositionProvider;
  }> = [
    {
      applicable: Boolean(state.stripe_subscription_id?.trim()),
      step: state.stripe_step,
      provider: 'stripe',
    },
    {
      applicable: (state.zernio_account_ids?.length ?? 0) > 0,
      step: state.zernio_accounts_step,
      provider: 'zernio',
    },
    {
      applicable: (state.zernio_profile_ids?.length ?? 0) > 0,
      step: state.zernio_profiles_step,
      provider: 'zernio',
    },
    {
      applicable: (state.location_ids?.length ?? 0) > 0,
      step: state.location_archival_step,
      provider: 'google',
    },
  ];

  const unresolved = new Set<AccountOffboardingProviderDispositionProvider>();
  for (const check of checks) {
    if (check.applicable && check.step !== 'success' && !covered.has(check.provider)) {
      unresolved.add(check.provider);
    }
  }
  return [...unresolved];
}

function allApplicableTeardownProvidersResolved(
  state: ProviderTeardownStepState,
  dispositions: AdminProviderDispositionRecord[],
): boolean {
  return unresolvedApplicableTeardownProviders(state, dispositions).length === 0;
}

function shouldTransitionToPurgeScheduled(
  row: ProviderDispositionOffboardingRow,
  disposition: AdminProviderDispositionRecord,
): boolean {
  if (row.status !== 'failed') return false;
  if (row.failed_step !== 'teardown') return false;
  if (row.purge_after === null) return false;
  if (row.purge_cancelled_at !== null) return false;

  // The newly-recorded disposition PLUS any already-recorded ones must cover EVERY
  // applicable provider teardown step still not 'success'. A single provider
  // disposition must never terminalize a purge while another applicable provider
  // resource the teardown never reached is still unresolved and un-dispositioned.
  const dispositions = [
    ...extractConcreteAdminProviderDispositions(row.provider_dispositions),
    disposition,
  ];
  return allApplicableTeardownProvidersResolved(row, dispositions);
}

function scrubDispositionText(value: string, maxLength: number): string {
  const compact = value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\bBasic\s+[A-Za-z0-9._~+/=-]+/gi, 'Basic [redacted]')
    .replace(
      /(["']?)(api[_-]?key|client[_-]?secret|token|access[_-]?token|refresh[_-]?token|secret|password|authorization)\1\s*[=:]\s*(?:"[^"]*"|'[^']*'|[^,\s}]+)/gi,
      (_match, _quote, key: string) => `${key}=[redacted]`,
    )
    .replace(/\s+/g, ' ')
    .trim();
  return compact.slice(0, maxLength);
}

function hashResourceReference(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function isKnownProvider(
  value: unknown,
): value is AccountOffboardingProviderDispositionProvider {
  return (
    typeof value === 'string' &&
    ACCOUNT_OFFBOARDING_PROVIDER_DISPOSITION_PROVIDERS.includes(
      value as AccountOffboardingProviderDispositionProvider,
    )
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function parseJsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
