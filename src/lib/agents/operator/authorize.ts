// Worker step 3 (spec §5.2): re-resolve the actor, the account and the location
// from the database. The POST-time check is not reusable here — minutes may
// have passed, the owner may be revoked and the account may have entered
// offboarding. No snapshot is built until this returns ok.
import type postgres from 'postgres';
import { isSubscriptionTier, type SubscriptionTierValue } from '@/lib/accounts/tier-config';
import { assertWritableSubscriptionForAccount } from '@/lib/shared/writable-subscription';

type Sql = postgres.Sql;

export interface ReauthorizeInput {
  accountId: string;
  actorUserId: string;
  locationId: string;
}

export type ReauthorizeResult =
  | { ok: true; subscriptionTier: SubscriptionTierValue; locationName: string }
  | { ok: false; reason: 'unauthorized' | 'account_offboarding' };

export async function reauthorizeTurn(sql: Sql, input: ReauthorizeInput): Promise<ReauthorizeResult> {
  const [actor] = await sql<{ id: string }[]>`
    SELECT id
    FROM users
    WHERE id = ${input.actorUserId}::uuid
      AND account_id = ${input.accountId}::uuid
      AND role = 'owner'
  `;
  if (!actor) return { ok: false, reason: 'unauthorized' };

  // The same gate `requireWritableOwner` uses at the route
  // (src/lib/auth/route-helpers.ts), so the two boundaries cannot disagree.
  const writable = await assertWritableSubscriptionForAccount(input.accountId, sql);
  if (!writable.ok) {
    return writable.error === 'account_offboarding_blocked'
      ? { ok: false, reason: 'account_offboarding' }
      : { ok: false, reason: 'unauthorized' };
  }

  const [location] = await sql<{ name: string }[]>`
    SELECT name
    FROM businesses
    WHERE id = ${input.locationId}::uuid
      AND account_id = ${input.accountId}::uuid
      AND archived_at IS NULL
  `;
  if (!location) return { ok: false, reason: 'unauthorized' };

  const [account] = await sql<{ subscription_tier: string }[]>`
    SELECT subscription_tier
    FROM accounts
    WHERE id = ${input.accountId}::uuid
  `;
  if (!account || !isSubscriptionTier(account.subscription_tier)) {
    return { ok: false, reason: 'unauthorized' };
  }

  return { ok: true, subscriptionTier: account.subscription_tier, locationName: location.name };
}
