import type { AccountOffboardingStepOutcome } from '../../../src/lib/account-offboarding/types';
import {
  archiveLocationForAccountOffboardingTeardownTransaction,
} from '../../../src/lib/locations/archive-location-tx';
import { sql } from '../../../src/lib/db/server';

interface LocationTeardownRow {
  id: string;
  account_id: string;
  location_ids: string[] | null;
  location_archival_step: AccountOffboardingStepOutcome | null;
}

export async function runLocationTeardown(row: LocationTeardownRow): Promise<void> {
  const locationIds = normalizeIds(row.location_ids);
  if (row.location_archival_step === 'success') {
    return;
  }
  if (locationIds.length === 0 && row.location_archival_step === 'not_applicable') {
    return;
  }
  if (locationIds.length === 0) {
    await sql`
      UPDATE account_offboardings
      SET location_archival_step = 'not_applicable',
          updated_at = NOW()
      WHERE id = ${row.id}::uuid
        AND account_id = ${row.account_id}::uuid
    `;
    return;
  }

  for (const locationId of locationIds) {
    // Each archival is its own transaction taking a FOR UPDATE lock on the shared account-scoped
    // accounts row; running them in parallel would deadlock/contend on that row.
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
    await archiveLocationForAccountOffboardingTeardownTransaction(sql, {
      accountId: row.account_id,
      locationId,
      accountOffboardingId: row.id,
    });
  }

  await sql`
    UPDATE account_offboardings
    SET location_archival_step = 'success',
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
