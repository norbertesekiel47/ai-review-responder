import type postgres from 'postgres';

export type AccountOffboardingSnapshotMissingField =
  | 'account'
  | 'stripe_customer_id'
  | 'stripe_subscription_id'
  | 'auth_user_id'
  | 'recipient_email'
  | 'location_ids';

export interface AccountOffboardingSnapshot {
  stripeCustomerId: string;
  stripeSubscriptionId: string;
  zernioAccountIds: string[];
  zernioProfileIds: string[];
  locationIds: string[];
  authUserId: string;
  recipientEmail: string;
}

interface LockedAccountRow {
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
}

interface OwnerRow {
  auth_id: string | null;
  email: string | null;
}

interface LocationRow {
  location_ids: string[] | null;
}

interface ZernioSnapshotRow {
  zernio_account_ids: string[] | null;
  zernio_profile_ids: string[] | null;
}

export interface CaptureAccountOffboardingSnapshotInput {
  accountId: string;
  actorUserId: string;
}

export type CaptureAccountOffboardingSnapshotResult =
  | { ok: true; snapshot: AccountOffboardingSnapshot }
  | {
    ok: false;
    missingFields: AccountOffboardingSnapshotMissingField[];
  };

export async function captureAccountOffboardingSnapshot(
  tx: postgres.TransactionSql,
  input: CaptureAccountOffboardingSnapshotInput,
): Promise<CaptureAccountOffboardingSnapshotResult> {
  const [account] = await tx<LockedAccountRow[]>`
    SELECT stripe_customer_id, stripe_subscription_id
    FROM accounts
    WHERE id = ${input.accountId}::uuid
    FOR UPDATE
  `;

  if (!account) {
    return { ok: false, missingFields: ['account'] };
  }

  const [owner] = await tx<OwnerRow[]>`
    SELECT auth_id, email
    FROM users
    WHERE id = ${input.actorUserId}::uuid
      AND account_id = ${input.accountId}::uuid
    LIMIT 1
  `;

  const [locations] = await tx<LocationRow[]>`
    SELECT COALESCE(
      array_agg(id ORDER BY is_primary DESC, created_at ASC)
        FILTER (WHERE id IS NOT NULL),
      ARRAY[]::uuid[]
    ) AS location_ids
    FROM businesses
    WHERE account_id = ${input.accountId}::uuid
      AND archived_at IS NULL
  `;

  const [zernio] = await tx<ZernioSnapshotRow[]>`
    SELECT
      COALESCE(
        array_agg(DISTINCT zc.zernio_account_id)
          FILTER (WHERE zc.zernio_account_id IS NOT NULL),
        ARRAY[]::text[]
      ) AS zernio_account_ids,
      COALESCE(
        array_agg(DISTINCT zc.zernio_profile_id)
          FILTER (WHERE zc.zernio_profile_id IS NOT NULL),
        ARRAY[]::text[]
      ) AS zernio_profile_ids
    FROM businesses b
    JOIN zernio_connections zc
      ON zc.business_id = b.id
     AND zc.status IN ('pending', 'active')
    WHERE b.account_id = ${input.accountId}::uuid
      AND b.archived_at IS NULL
  `;

  const missingFields: AccountOffboardingSnapshotMissingField[] = [];
  const locationIds = locations?.location_ids ?? [];
  if (!present(account.stripe_customer_id)) missingFields.push('stripe_customer_id');
  if (!present(account.stripe_subscription_id)) missingFields.push('stripe_subscription_id');
  if (!present(owner?.auth_id)) missingFields.push('auth_user_id');
  if (!present(owner?.email)) missingFields.push('recipient_email');
  if (locationIds.length === 0) {
    missingFields.push('location_ids');
  }

  if (missingFields.length > 0) {
    return { ok: false, missingFields };
  }

  return {
    ok: true,
    snapshot: {
      stripeCustomerId: account.stripe_customer_id!,
      stripeSubscriptionId: account.stripe_subscription_id!,
      zernioAccountIds: zernio?.zernio_account_ids ?? [],
      zernioProfileIds: zernio?.zernio_profile_ids ?? [],
      locationIds,
      authUserId: owner!.auth_id!,
      recipientEmail: owner!.email!,
    },
  };
}

function present(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
