import type postgres from 'postgres';
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

export async function runZernioTeardown(
  sql: postgres.Sql,
  row: ZernioTeardownRow,
): Promise<void> {
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
        // Rate-limited Zernio provider calls must stay sequential; parallelizing would breach the
        // provider's rate limit and trip throttling.
        // react-doctor-disable-next-line react-doctor/async-await-in-loop
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
    // Rate-limited Zernio provider calls must stay sequential; parallelizing would breach the
    // provider's rate limit and trip throttling.
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
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
  return (values ?? []).flatMap((value) => {
    const trimmed = value.trim();
    return trimmed.length > 0 ? [trimmed] : [];
  });
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
