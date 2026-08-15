import { v7 as uuidv7 } from 'uuid';
import type { Sql } from 'postgres';
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
 * Mode discriminator. The two modes still differ in ways that keep them
 * separate transactions:
 *   - users.auth_id — admin=NULL (patched after inviteUserByEmail returns an
 *     identity), self_serve=<authId> (the owner already authenticated).
 *   - businesses.name / accounts.display_name — admin writes the real name
 *     the admin typed, self_serve writes PLACEHOLDER_BUSINESS_NAME.
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
  paymentUrl: string | null;
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
 * The only content difference is `name` — real in admin mode,
 * PLACEHOLDER_BUSINESS_NAME in self_serve.
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

  const authId = options.mode === 'self_serve' ? options.authId : null;
  const onboardedBy = options.mode === 'admin' ? options.onboardedBy : null;
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

  // Self-serve signups no longer build a Payment Link URL here.
  // The select-plan route (/api/onboarding/select-plan) creates a Checkout
  // Session instead. Admin signups also skip this — paymentUrl is always null.
  const paymentUrl = null;

  try {
    if (options.mode === 'admin') {
      const adminInput = input as AdminBusinessTxInput;
      await runAdminTx(sql, {
        adminInput,
        accountId,
        businessId,
        userId,
        ownerEmail,
        onboardedBy: onboardedBy!,
        priceVariant,
        billingSnapshot,
      });
    } else {
      const selfServeInput = input as SelfServeBusinessTxInput;
      await runSelfServeTx(sql, {
        selfServeInput,
        accountId,
        businessId,
        userId,
        ownerEmail,
        authId: authId!,
        priceVariant,
        billingSnapshot,
      });
    }
  } catch (err) {
    if (isDuplicateEmailViolation(err)) {
      throw new DuplicateEmailError();
    }
    throw err;
  }

  return { businessId, userId, accountId, paymentUrl };
}

async function runAdminTx(
  sql: Sql,
  args: {
    adminInput: AdminBusinessTxInput;
    accountId: string;
    businessId: string;
    userId: string;
    ownerEmail: string;
    onboardedBy: string;
    priceVariant: PriceVariant;
    billingSnapshot: ResolvedTierSnapshot;
  },
): Promise<void> {
  const {
    adminInput,
    accountId,
    businessId,
    userId,
    ownerEmail,
    onboardedBy,
    priceVariant,
    billingSnapshot,
  } = args;

  await sql.begin(async (tx) => {
    // Create accounts row (source of truth for subscription state after
    // migration 034). owner_user_id references the users row we create
    // below — FK is satisfied by the time the transaction commits.
    await tx`
      INSERT INTO accounts (
        id, owner_user_id, display_name,
        subscription_tier, price_variant, subscription_status,
        base_price_cents, locations_overage_price_cents,
        locations_included, locations_paid
      ) VALUES (
        ${accountId}::uuid,
        ${userId}::uuid,
        ${adminInput.businessName},
        ${billingSnapshot.tier},
        ${priceVariant},
        ${SubscriptionStatus.PENDING_PAYMENT},
        ${billingSnapshot.baseCents},
        ${billingSnapshot.overageCents},
        ${billingSnapshot.included},
        ${0}
      )
    `;

    // Identity-only row: same shape as the self-serve placeholder (NULL place
    // fields, empty voice arrays, default tone) except `name` is the real one
    // the admin typed and `onboarded_by` marks this as an invited account.
    // place_id_verified is passed as FALSE explicitly so the column INSERT
    // order matches the self-serve path verbatim.
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
        ${businessId}::uuid,
        ${accountId}::uuid,
        TRUE,
        ${adminInput.businessName},
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
        ${adminInput.ownerName},
        ${ownerEmail},
        ${null},
        ${billingSnapshot.tier},
        ${SubscriptionStatus.PENDING_PAYMENT},
        ${null},
        ${onboardedBy}
      )
    `;

    await tx`
      INSERT INTO users (id, auth_id, name, email, phone, role, account_id)
      VALUES (
        ${userId}::uuid,
        ${null},
        ${adminInput.ownerName},
        ${ownerEmail},
        ${null},
        'owner',
        ${accountId}::uuid
      )
    `;

    await tx`
      INSERT INTO channel_enrollments (id, account_id, business_id, channel, handle, status, verified_at)
      VALUES (${uuidv7()}::uuid, ${accountId}::uuid, ${businessId}::uuid, 'email', ${ownerEmail}, 'verified', NOW())
      ON CONFLICT (account_id, channel, COALESCE(location_id, '00000000-0000-0000-0000-000000000000')) WHERE archived_at IS NULL DO NOTHING
    `;

    // No job_outbox INSERT — there is no place at creation time. The owner's
    // /api/onboarding/start enqueues validate_place_id when they capture one,
    // exactly as it does for a self-serve owner.
  });
}

async function runSelfServeTx(
  sql: Sql,
  args: {
    selfServeInput: SelfServeBusinessTxInput;
    accountId: string;
    businessId: string;
    userId: string;
    ownerEmail: string;
    authId: string;
    priceVariant: PriceVariant;
    billingSnapshot: ResolvedTierSnapshot;
  },
): Promise<void> {
  const {
    selfServeInput,
    accountId,
    businessId,
    userId,
    ownerEmail,
    authId,
    priceVariant,
    billingSnapshot,
  } = args;

  await sql.begin(async (tx) => {
    // Create accounts row (source of truth for subscription state after
    // migration 034). owner_user_id references the users row we create
    // below — FK is satisfied by the time the transaction commits.
    await tx`
      INSERT INTO accounts (
        id, owner_user_id, display_name,
        subscription_tier, price_variant, subscription_status,
        base_price_cents, locations_overage_price_cents,
        locations_included, locations_paid
      ) VALUES (
        ${accountId}::uuid,
        ${userId}::uuid,
        ${PLACEHOLDER_BUSINESS_NAME},
        ${billingSnapshot.tier},
        ${priceVariant},
        ${SubscriptionStatus.PENDING_PAYMENT},
        ${billingSnapshot.baseCents},
        ${billingSnapshot.overageCents},
        ${billingSnapshot.included},
        ${0}
      )
    `;

    // Placeholder row — name = PLACEHOLDER_BUSINESS_NAME, all place + profile
    // fields NULL or empty array. The /api/onboarding/business handler
    // UPDATEs these once the owner completes the wizard after Stripe payment.
    // place_id_verified intentionally left to its DB default of FALSE; we
    // pass FALSE explicitly here so the column INSERT order matches the
    // admin path verbatim and the row is unambiguously "not yet verified".
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
        ${businessId}::uuid,
        ${accountId}::uuid,
        TRUE,
        ${PLACEHOLDER_BUSINESS_NAME},
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
        ${selfServeInput.ownerName},
        ${ownerEmail},
        ${selfServeInput.ownerPhone ?? null},
        ${billingSnapshot.tier},
        ${SubscriptionStatus.PENDING_PAYMENT},
        ${null},
        ${null}
      )
    `;

    await tx`
      INSERT INTO users (id, auth_id, name, email, phone, role, account_id)
      VALUES (
        ${userId}::uuid,
        ${authId},
        ${selfServeInput.ownerName},
        ${ownerEmail},
        ${selfServeInput.ownerPhone ?? null},
        'owner',
        ${accountId}::uuid
      )
    `;

    // channel_enrollments INSERT deliberately deferred to /api/auth/verify-otp.
    // At this point the owner has only typed the email — they haven't proven
    // control of it. Marking the row 'verified' before OTP would mis-state the
    // data model and would mean any owner who never confirms still appears as
    // a verified email recipient until cleanup. Created post-OTP instead.

    // No job_outbox INSERT here — the /api/onboarding/business handler
    // enqueues validate_place_id (Maps URL path) once the owner supplies
    // real Place ID / Maps URL data. Verified PlaceAutocomplete path needs
    // no enqueue (review ingestion is webhook-driven via Zernio).
  });
}
