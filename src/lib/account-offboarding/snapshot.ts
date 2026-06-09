import type postgres from 'postgres';

export type AccountOffboardingSnapshotMissingField =
  | 'account'
  | 'stripe_customer_id'
  | 'stripe_subscription_id'
  | 'auth_user_id'
  | 'recipient_email'
  | 'location_ids';

export interface AccountOffboardingSnapshot {
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
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
  requireStripeCustomerId?: boolean;
  requireStripeSubscriptionId?: boolean;
  /**
   * Include archived locations in the captured `location_ids`. `delete_data`
   * sets this so a never-activated / fully-archived account (which has no ACTIVE
   * business row) can still offboard: purge deletes archived businesses anyway,
   * teardown archival is idempotent for already-archived rows, and the
   * confirmation email still has a business id to key delivery on. `cancel_only`
   * leaves it off and only snapshots active locations.
   */
  includeArchivedLocations?: boolean;
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

  const includeArchivedLocations = input.includeArchivedLocations === true;
  const [locations] = await tx<LocationRow[]>`
    SELECT COALESCE(
      array_agg(id ORDER BY is_primary DESC, created_at ASC)
        FILTER (WHERE id IS NOT NULL),
      ARRAY[]::uuid[]
    ) AS location_ids
    FROM businesses
    WHERE account_id = ${input.accountId}::uuid
      AND (${includeArchivedLocations} OR archived_at IS NULL)
  `;

  // sequential within tx after FOR UPDATE lock on the accounts row (Postgres.js serializes tx queries; parallelizing would contend the held row lock)
  // react-doctor-disable-next-line react-doctor/server-sequential-independent-await
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
  if (input.requireStripeCustomerId !== false && !present(account.stripe_customer_id)) {
    missingFields.push('stripe_customer_id');
  }
  if (input.requireStripeSubscriptionId !== false && !present(account.stripe_subscription_id)) {
    missingFields.push('stripe_subscription_id');
  }
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
      stripeCustomerId: present(account.stripe_customer_id) ? account.stripe_customer_id : null,
      stripeSubscriptionId: present(account.stripe_subscription_id) ? account.stripe_subscription_id : null,
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
