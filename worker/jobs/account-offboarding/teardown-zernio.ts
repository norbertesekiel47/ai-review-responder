import { sql } from '../../../src/lib/db/server';
import type { AccountOffboardingStepOutcome } from '../../../src/lib/account-offboarding/types';
import { zernioClient } from '../../../src/lib/zernio/client';
import { ZernioPermanentError } from '../../../src/lib/zernio/errors';

interface ZernioTeardownRow {
  id: string;
  account_id: string;
  zernio_account_ids: string[] | null;
  zernio_profile_ids: string[] | null;
  zernio_accounts_step: AccountOffboardingStepOutcome | null;
  zernio_profiles_step: AccountOffboardingStepOutcome | null;
}

export async function runZernioTeardown(row: ZernioTeardownRow): Promise<void> {
  const accountIds = normalizeIds(row.zernio_account_ids);
  if (row.zernio_accounts_step !== 'success') {
    if (accountIds.length === 0) {
      if (row.zernio_accounts_step !== 'not_applicable') {
        await sql`
          UPDATE account_offboardings
          SET zernio_accounts_step = 'not_applicable',
              updated_at = NOW()
          WHERE id = ${row.id}::uuid
            AND account_id = ${row.account_id}::uuid
        `;
      }
    } else {
      for (const accountId of accountIds) {
        await deleteZernioResource(() => zernioClient.deleteAccount(accountId));
      }
      await sql`
        UPDATE account_offboardings
        SET zernio_accounts_step = 'success',
            updated_at = NOW()
        WHERE id = ${row.id}::uuid
          AND account_id = ${row.account_id}::uuid
      `;
    }
  }

  const profileIds = normalizeIds(row.zernio_profile_ids);
  if (row.zernio_profiles_step === 'success') {
    return;
  }
  if (profileIds.length === 0) {
    if (row.zernio_profiles_step !== 'not_applicable') {
      await sql`
        UPDATE account_offboardings
        SET zernio_profiles_step = 'not_applicable',
            updated_at = NOW()
        WHERE id = ${row.id}::uuid
          AND account_id = ${row.account_id}::uuid
      `;
    }
    return;
  }

  for (const profileId of profileIds) {
    await deleteZernioResource(() => zernioClient.deleteProfile(profileId));
  }
  await sql`
    UPDATE account_offboardings
    SET zernio_profiles_step = 'success',
        updated_at = NOW()
    WHERE id = ${row.id}::uuid
      AND account_id = ${row.account_id}::uuid
  `;
}

function normalizeIds(values: string[] | null): string[] {
  return (values ?? []).map((value) => value.trim()).filter((value) => value.length > 0);
}

async function deleteZernioResource(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (
      err instanceof ZernioPermanentError
      && (err.kind === 'http_404' || err.kind === 'http_410')
    ) {
      return;
    }
    throw err;
  }
}
