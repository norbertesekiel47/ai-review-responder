import { createHash } from 'node:crypto';
import type postgres from 'postgres';

import { scrubOffboardingErrorForStorage } from '../../../src/lib/account-offboarding/scrub-error';

/**
 * Pure, stage-independent leaf helpers for the purge worker: identifier hashing, the
 * scrub-scope record shapes recorded in `provider_dispositions`, Supabase error mapping,
 * and the allowlisted by-business delete. Kept out of `purge-stages.ts` so that file holds
 * stage orchestration, not utilities.
 */

export interface JobOutboxScrubScopeRecord {
  type: 'job_outbox_scrub_scope';
  job_outbox_id: string;
  job_outbox_id_hash: string;
}

export interface ImpersonationSessionScrubScopeRecord {
  type: 'impersonation_session_scrub_scope';
  impersonation_session_id: string;
  impersonation_session_id_hash: string;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function jobOutboxScrubScopeRecord(entry: { id: string }): JobOutboxScrubScopeRecord {
  return {
    type: 'job_outbox_scrub_scope',
    job_outbox_id: entry.id,
    job_outbox_id_hash: sha256Hex(entry.id),
  };
}

export function impersonationSessionScrubScopeRecord(
  id: string,
): ImpersonationSessionScrubScopeRecord {
  return {
    type: 'impersonation_session_scrub_scope',
    impersonation_session_id: id,
    impersonation_session_id_hash: sha256Hex(id),
  };
}

export function safeSupabaseError(error: { message?: string; status?: number | string }): string {
  const status = error.status ? `status_${error.status}` : 'unknown_status';
  return `${status}:${scrubOffboardingErrorForStorage(error.message ?? 'unknown_error')}`;
}

export function isSupabaseAuthNotFound(
  error: { message?: string; status?: number | string },
): boolean {
  const status = typeof error.status === 'number' ? error.status : Number(error.status);
  return status === 404 || /not\s+found/i.test(error.message ?? '');
}

// Tables purged by deleting every row whose business belongs to the account.
// Allowlisted so the dynamic table identifier below can never be attacker-controlled.
const DELETABLE_BY_BUSINESS = new Set<string>([
  'approval_links',
  'responses',
  'reviews',
  'weekly_summaries',
  'monthly_impact_emails',
  'ranking_snapshots',
  'competitor_snapshots',
  'onboarding_drip_log',
  'onboarding_demos',
  'satisfaction_responses',
  'google_connections',
  'zernio_connections',
]);

export async function deleteByBusiness(
  tx: postgres.TransactionSql,
  tableName: string,
  accountId: string,
): Promise<void> {
  if (!DELETABLE_BY_BUSINESS.has(tableName)) {
    throw new Error(`unsupported_delete_by_business:${tableName}`);
  }
  await tx`
    DELETE FROM ${tx(tableName)}
    WHERE business_id IN (
      SELECT id FROM businesses WHERE account_id = ${accountId}::uuid
    )
  `;
}
