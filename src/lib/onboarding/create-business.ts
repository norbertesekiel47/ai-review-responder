import { v7 as uuidv7 } from 'uuid';
import type { Sql, TransactionSql } from 'postgres';
import { SubscriptionStatus } from '@/lib/shared/subscription-status';
import {
  SubscriptionTier,
  resolveTierSnapshot,
  type PriceVariant,
  type ResolvedTierSnapshot,
  type SubscriptionTierValue,
} from '@/lib/accounts/tier-config';
import { isFoundingWindowOpen } from '@/lib/payments/founding-window';
import { priceIdFor } from '@/lib/payments/price-tier-map';

/**
 * Thrown when the businesses+users insert transaction fails on a PG 23505
 * (unique_violation) on the `users.email` unique constraint. Callers
 * translate this into a 409 response. Any 23505 on a DIFFERENT constraint
 * (e.g. businesses_account_place_uniq, migration 062) propagates unchanged —
 * mislabeling it as a duplicate email would mask the real conflict.
 */
export class DuplicateEmailError extends Error {
  constructor() {
    super('users.email unique constraint violation');
    this.name = 'DuplicateEmailError';
  }
}

export class TierPriceConfigurationError extends Error {
  constructor(
    tier: SubscriptionTierValue,
    variant: PriceVariant,
    kind: 'base' | 'overage',
  ) {
    super(`Missing ${kind} Stripe Price configuration for ${tier}/${variant}`);
    this.name = 'TierPriceConfigurationError';
  }
}

function assertTierPriceConfiguration(
  tier: SubscriptionTierValue,
  variant: PriceVariant,
): void {
  if (!priceIdFor(tier, variant, 'base')) {
    throw new TierPriceConfigurationError(tier, variant, 'base');
  }
  if (!priceIdFor(tier, variant, 'overage')) {
    throw new TierPriceConfigurationError(tier, variant, 'overage');
  }
}

/** Default-named inline UNIQUE on users.email (001_initial_schema.sql). */
const USERS_EMAIL_CONSTRAINT = 'users_email_key';

/** True only for a PG unique violation (23505) on users.email — mirrors the
 * constraint-name matching in src/lib/locations/duplicate-location.ts. */
function isDuplicateEmailViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as Record<string, unknown>;
  return e.code === '23505' && e.constraint_name === USERS_EMAIL_CONSTRAINT;
}

/**
 * Sentinel name written into the `businesses.name` column for self-serve
 * signups before the owner has completed the business-details wizard.
 * The /onboarding/business UPDATE replaces this with the real value.
 */
export const PLACEHOLDER_BUSINESS_NAME = '(pending setup)';

/**
 * Admin onboarding input shape — identity only, plus the real business name
 * the admin typed. Place, voice/context and tier are no longer captured by
 * the admin form: the invited owner supplies them inside the self-serve
 * funnel (/onboarding/start, the post-payment wizard, /onboarding/pay), so
 * the admin row is shape-identical to the self-serve placeholder row except
 * that `name` is real and `onboarded_by` is set.
 */
export interface AdminBusinessTxInput {
  ownerEmail: string;
  ownerName: string;
  businessName: string;
}

/**
 * Self-serve signup input shape — identity-only. Business details are
 * collected by /onboarding/business after Stripe payment. The placeholder
 * row written here has NULL place fields, an empty array for staff/facts/
 * sample responses, and `name = PLACEHOLDER_BUSINESS_NAME`.
 */
export interface SelfServeBusinessTxInput {
  ownerEmail: string;
  ownerName: string;
  ownerPhone?: string | null;
}

/**
 * Mode discriminator. The two modes differ only in the values
 * `OwnerRowValues` carries plus one extra row:
 *   - users.auth_id — admin=NULL (patched after inviteUserByEmail returns an
 *     identity), self_serve=<authId> (the owner already authenticated).
 *   - businesses.name / accounts.display_name — admin writes the real name
 *     the admin typed, self_serve writes PLACEHOLDER_BUSINESS_NAME.
 *   - businesses.owner_phone / users.phone — self_serve only (admin=NULL).
 *   - businesses.onboarded_by — admin only; it is the beta-invite marker
 *     downstream (coupon eligibility, funnel routing).
 *   - channel_enrollments — admin inserts a verified email row at creation
 *     (an admin vouches for the address); self_serve defers it to
 *     /api/auth/verify-otp, post-OTP.
 * Neither mode INSERTs a job_outbox row any more: the owner's
 * /api/onboarding/start enqueues validate_place_id once THEY capture a place.
 */
export type CreateBusinessOptions =
  | { mode: 'admin'; onboardedBy: string }
  | { mode: 'self_serve'; authId: string };

export interface CreateBusinessResult {
  businessId: string;
  userId: string;
  accountId: string;
}

export async function createBusinessTx(
  sql: Sql,
  input: AdminBusinessTxInput,
  options: { mode: 'admin'; onboardedBy: string },
): Promise<CreateBusinessResult>;
export async function createBusinessTx(
  sql: Sql,
  input: SelfServeBusinessTxInput,
  options: { mode: 'self_serve'; authId: string },
): Promise<CreateBusinessResult>;
/**
 * Shared business-onboarding transaction used by both the admin route
 * (`POST /api/admin/businesses`) and self-serve signup (`POST /api/auth/signup`
 * + `POST /api/auth/finish-signup`).
 *
 * Writes accounts + businesses + users (+ channel_enrollments in admin mode)
 * in a single sql.begin transaction. After migration 034, users.business_id
 * was dropped; the transaction now creates an accounts row and links
 * everything via users.account_id and businesses.account_id.
 * Both modes write an identity-only businesses row with NULL place fields,
 * empty voice arrays and the default tone, and NEITHER enqueues anything: the
 * owner's /api/onboarding/start (place) and /api/onboarding/business (wizard)
 * fill those fields in and enqueue validate_place_id when a place arrives.
 * Both modes go through the one `insertOwnerRows`, so each table's column
 * list exists exactly once (#1356).
 *
 * On PG 23505 (unique_violation, typically users.email), throws
 * DuplicateEmailError so the caller can return 409.
 *
 * @param sql Postgres.js client (composition root supplies the singleton —
 *   this module never imports @/lib/db/server).
 */
export async function createBusinessTx(
  sql: Sql,
  input: AdminBusinessTxInput | SelfServeBusinessTxInput,
  options: CreateBusinessOptions,
): Promise<CreateBusinessResult> {
  // Defense-in-depth: normalize email at the persistence boundary. The schema
  // layer does this too (normalizedEmailSchema via z.preprocess), but belt-and-
  // suspenders — createBusinessTx is shared by multiple callers.
  const ownerEmail = input.ownerEmail.trim().toLowerCase();

  const businessId = uuidv7();
  const userId = uuidv7();
  const accountId = uuidv7();

  const priceVariant: PriceVariant = isFoundingWindowOpen() ? 'founding' : 'list';

  // Both modes create on the safe Copilot pending snapshot. Admin
  // provisioning is no longer an authoritative tier choice — the invited
  // owner picks their tier at /onboarding/pay like any self-serve owner — so
  // there is nothing here for `assertTierPurchasable` to gate; that check
  // lives at the surfaces where a tier is actually chosen (select-plan,
  // checkout, tier-change).
  const subscriptionTier: SubscriptionTierValue = SubscriptionTier.COPILOT;
  const billingSnapshot = resolveTierSnapshot(subscriptionTier, priceVariant);
  assertTierPriceConfiguration(subscriptionTier, priceVariant);

  const shared = { accountId, businessId, userId, ownerEmail, priceVariant, billingSnapshot };
  let rows: OwnerRowValues;
  if (options.mode === 'admin') {
    const adminInput = input as AdminBusinessTxInput;
    rows = {
      ...shared,
      businessName: adminInput.businessName,
      ownerName: adminInput.ownerName,
      ownerPhone: null,
      authId: null,
      onboardedBy: options.onboardedBy,
    };
  } else {
    const selfServeInput = input as SelfServeBusinessTxInput;
    rows = {
      ...shared,
      businessName: PLACEHOLDER_BUSINESS_NAME,
      ownerName: selfServeInput.ownerName,
      ownerPhone: selfServeInput.ownerPhone ?? null,
      authId: options.authId,
      onboardedBy: null,
    };
  }

  try {
    await sql.begin(async (tx) => {
      await insertOwnerRows(tx, rows);

      if (options.mode === 'admin') {
        // An admin vouches for the address, so the email channel is verified
        // at creation. Self-serve defers this row to /api/auth/verify-otp:
        // until the owner enters the OTP they have only typed the email, and a
        // 'verified' row would mis-state the data model.
        await tx`
          INSERT INTO channel_enrollments (id, account_id, business_id, channel, handle, status, verified_at)
          VALUES (${uuidv7()}::uuid, ${accountId}::uuid, ${businessId}::uuid, 'email', ${ownerEmail}, 'verified', NOW())
          ON CONFLICT (account_id, channel, COALESCE(location_id, '00000000-0000-0000-0000-000000000000')) WHERE archived_at IS NULL DO NOTHING
        `;
      }

      // No job_outbox INSERT in either mode — there is no place at creation
      // time. /api/onboarding/start and /api/onboarding/business enqueue
      // validate_place_id once the owner supplies one.
    });
  } catch (err) {
    if (isDuplicateEmailViolation(err)) {
      throw new DuplicateEmailError();
    }
    throw err;
  }

  return { businessId, userId, accountId };
}

/** The per-mode values `insertOwnerRows` writes; every other column is fixed. */
interface OwnerRowValues {
  accountId: string;
  businessId: string;
  userId: string;
  ownerEmail: string;
  /** accounts.display_name + businesses.name. */
  businessName: string;
  ownerName: string;
  /** businesses.owner_phone + users.phone. */
  ownerPhone: string | null;
  authId: string | null;
  onboardedBy: string | null;
  priceVariant: PriceVariant;
  billingSnapshot: ResolvedTierSnapshot;
}

/**
 * The accounts + businesses + users rows both modes write. The one place each
 * column list is spelled — a column added here reaches both modes, so the two
 * can no longer drift into a wrong-column write.
 */
async function insertOwnerRows(tx: TransactionSql, v: OwnerRowValues): Promise<void> {
  // Create accounts row (source of truth for subscription state after
  // migration 034). owner_user_id references the users row we create
  // below — FK is satisfied by the time the transaction commits. The billing
  // columns are the point-in-time snapshot invariant #9a reads.
  await tx`
    INSERT INTO accounts (
      id, owner_user_id, display_name,
      subscription_tier, price_variant, subscription_status,
      base_price_cents, locations_overage_price_cents,
      locations_included, locations_paid
    ) VALUES (
      ${v.accountId}::uuid,
      ${v.userId}::uuid,
      ${v.businessName},
      ${v.billingSnapshot.tier},
      ${v.priceVariant},
      ${SubscriptionStatus.PENDING_PAYMENT},
      ${v.billingSnapshot.baseCents},
      ${v.billingSnapshot.overageCents},
      ${v.billingSnapshot.included},
      ${0}
    )
  `;

  // Identity-only row: NULL place fields, empty voice arrays, default tone.
  // The /api/onboarding/business handler UPDATEs these once the owner
  // completes the wizard. place_id_verified is passed FALSE explicitly so the
  // row is unambiguously "not yet verified". onboarded_by is the Admin invite
  // marker (non-NULL only in admin mode).
  await tx`
    INSERT INTO businesses (
      id,
      account_id,
      is_primary,
      name,
      category,
      google_place_id,
      place_id_verified,
      google_maps_url,
      tone,
      products_services,
      staff_names,
      highlight_facts,
      avoid_facts,
      sample_responses,
      owner_name,
      owner_email,
      owner_phone,
      subscription_tier,
      subscription_status,
      website,
      onboarded_by
    ) VALUES (
      ${v.businessId}::uuid,
      ${v.accountId}::uuid,
      TRUE,
      ${v.businessName},
      ${null},
      ${null},
      ${false},
      ${null},
      ${'professional and friendly'},
      ${null},
      ${[]},
      ${[]},
      ${[]},
      ${[]},
      ${v.ownerName},
      ${v.ownerEmail},
      ${v.ownerPhone},
      ${v.billingSnapshot.tier},
      ${SubscriptionStatus.PENDING_PAYMENT},
      ${null},
      ${v.onboardedBy}
    )
  `;

  await tx`
    INSERT INTO users (id, auth_id, name, email, phone, role, account_id)
    VALUES (
      ${v.userId}::uuid,
      ${v.authId},
      ${v.ownerName},
      ${v.ownerEmail},
      ${v.ownerPhone},
      'owner',
      ${v.accountId}::uuid
    )
  `;
}
