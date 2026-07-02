import { sql } from '../../../src/lib/db/server';
import { QUEUE_NAMES } from '../../../src/lib/shared/queue-names';
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
          topic IN (${QUEUE_NAMES.GENERATE_RESPONSE}, ${QUEUE_NAMES.SEND_NOTIFICATION}, ${QUEUE_NAMES.PUBLISH_RESPONSE}, ${QUEUE_NAMES.AUTO_POST_NOTICE})
          AND payload->>'business_id' = ANY(${locationIds}::text[])
        )
        OR (
          topic IN (
            ${QUEUE_NAMES.ACCOUNT_OFFBOARDING_BILLING_SCHEDULE},
            ${QUEUE_NAMES.ACCOUNT_OFFBOARDING_REACTIVATION},
            ${QUEUE_NAMES.ACCOUNT_OFFBOARDING_TEARDOWN}
          )
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
  return (values ?? []).flatMap((value) => {
    const trimmed = value.trim();
    return trimmed.length > 0 ? [trimmed] : [];
  });
}
