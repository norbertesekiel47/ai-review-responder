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
    await archiveLocationForAccountOffboardingTeardownTransaction({
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
  return (values ?? []).map((value) => value.trim()).filter((value) => value.length > 0);
}
