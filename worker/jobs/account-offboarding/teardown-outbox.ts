import { sql } from '../../../src/lib/db/server';
import type { AccountOffboardingStepOutcome } from '../../../src/lib/account-offboarding/types';

interface OutboxTeardownRow {
  id: string;
  account_id: string;
  location_ids: string[] | null;
  job_terminalization_step: AccountOffboardingStepOutcome | null;
}

export async function runOutboxTerminalization(
  row: OutboxTeardownRow,
  currentOutboxId: string,
): Promise<void> {
  if (row.job_terminalization_step === 'success') {
    return;
  }

  const locationIds = normalizeIds(row.location_ids);
  await sql`
    UPDATE job_outbox
    SET status = 'completed',
        completed_at = NOW()
    WHERE status = 'pending'
      AND (
        (
          topic IN ('generate_response', 'send_notification', 'publish_response')
          AND payload->>'business_id' = ANY(${locationIds}::text[])
        )
        OR (
          topic IN ('account_offboarding_billing_schedule', 'account_offboarding_teardown')
          AND aggregate_type = 'account_offboarding'
          AND aggregate_id = ${row.id}
          AND id <> ${currentOutboxId}
        )
      )
  `;

  await sql`
    UPDATE account_offboardings
    SET job_terminalization_step = 'success',
        updated_at = NOW()
    WHERE id = ${row.id}::uuid
      AND account_id = ${row.account_id}::uuid
  `;
}

function normalizeIds(values: string[] | null): string[] {
  return (values ?? []).map((value) => value.trim()).filter((value) => value.length > 0);
}
