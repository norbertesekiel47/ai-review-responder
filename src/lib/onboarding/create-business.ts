import { v7 as uuidv7 } from 'uuid';
import type { Sql } from 'postgres';
import { enqueueValidatePlaceId } from '@/lib/shared/job-outbox-helpers';
import { SubscriptionStatus } from '@/lib/shared/subscription-status';
import {
  SubscriptionTier,
  isSubscriptionTier,
  resolveTierSnapshot,
  type PriceVariant,
  type ResolvedTierSnapshot,
  type SubscriptionTierValue,
} from '@/lib/accounts/tier-config';
import { isFoundingWindowOpen } from '@/lib/payments/founding-window';
import { priceIdFor } from '@/lib/payments/price-tier-map';
import { assertTierPurchasable } from '@/lib/payments/tier-purchasability';

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
 * Place ID input — discriminated union makes "verified but no place ID"
 * and "unverified but no URL" unrepresentable at compile time. Only used
 * by admin onboarding; self-serve always writes NULL place fields and the
 * /onboarding/business wizard fills them in later.
 */
export type PlaceIdInput =
  | { placeIdVerified: true; placeId: string; googleMapsUrl?: string | null }
  | { placeIdVerified: false; placeId?: string | null; googleMapsUrl: string };

/**
 * Admin onboarding input shape — full business details captured up front
 * by the admin form. INSERTs an initial-sync outbox row in the same tx.
 */
export interface AdminBusinessTxInput {
  ownerEmail: string;
  ownerName: string;
  ownerPhone?: string | null;
  businessName: string;
  category?: string | null;
  tone?: string | null;
  productsServices?: string | null;
  staffNames?: string[];
  highlightFacts?: string[];
  avoidFacts?: string[];
  sampleResponses?: string[];
  subscriptionTier: SubscriptionTierValue;
  website?: string | null;
  placeId: PlaceIdInput;
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
 * Mode discriminator — admin onboarding and self-serve signup differ in two
 * critical ways: users.auth_id (admin=NULL, self_serve=<authId>) and whether
 * an outbox row is INSERTed (admin=yes, self_serve=no — the
 * /api/onboarding/business UPDATE enqueues the initial sync once the owner
 * supplies real business details).
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
 * Writes accounts + businesses + users + channel_enrollments in a single sql.begin
 * transaction. After migration 034, users.business_id was dropped; the
 * transaction now creates an accounts row and links everything via
 * users.account_id and businesses.account_id.
 * In admin mode, additionally INSERTs a job_outbox row for
 * validate_place_id when a Maps URL is provided (Place ID verified = no
 * enqueue — review ingestion is webhook-driven via Zernio).
 * In self_serve mode, skips the outbox insert entirely and writes the
 * businesses row with placeholder identity-only fields — the
 * /api/onboarding/business handler updates those fields and enqueues
 * validate_place_id once the owner finishes the wizard after Stripe payment.
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

  const subscriptionTier =
    options.mode === 'admin'
      ? (input as AdminBusinessTxInput).subscriptionTier
      : SubscriptionTier.COPILOT;
  if (!isSubscriptionTier(subscriptionTier)) {
    throw new Error(`Unknown WS8 subscription tier: ${String(subscriptionTier)}`);
  }
  // Admin provisioning is an authoritative tier choice. Gate it before the
  // transaction so a closed Autopilot launch performs zero persistence writes.
  if (options.mode === 'admin') {
    assertTierPurchasable(subscriptionTier);
  }
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

  const placeId = adminInput.placeId.placeIdVerified
    ? adminInput.placeId.placeId
    : adminInput.placeId.placeId ?? null;
  const googleMapsUrl = adminInput.placeId.googleMapsUrl ?? null;
  const placeIdVerified = adminInput.placeId.placeIdVerified;

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
        ${adminInput.category ?? null},
        ${placeId},
        ${placeIdVerified},
        ${googleMapsUrl},
        ${adminInput.tone ?? 'professional and friendly'},
        ${adminInput.productsServices ?? null},
        ${adminInput.staffNames ?? []},
        ${adminInput.highlightFacts ?? []},
        ${adminInput.avoidFacts ?? []},
        ${adminInput.sampleResponses ?? []},
        ${adminInput.ownerName},
        ${ownerEmail},
        ${adminInput.ownerPhone ?? null},
        ${billingSnapshot.tier},
        ${SubscriptionStatus.PENDING_PAYMENT},
        ${adminInput.website ?? null},
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
        ${adminInput.ownerPhone ?? null},
        'owner',
        ${accountId}::uuid
      )
    `;

    await tx`
      INSERT INTO channel_enrollments (id, account_id, business_id, channel, handle, status, verified_at)
      VALUES (${uuidv7()}::uuid, ${accountId}::uuid, ${businessId}::uuid, 'email', ${ownerEmail}, 'verified', NOW())
      ON CONFLICT (account_id, channel, COALESCE(location_id, '00000000-0000-0000-0000-000000000000')) WHERE archived_at IS NULL DO NOTHING
    `;

    const correlationId = uuidv7();
    if (placeIdVerified && placeId) {
      // No outbox enqueue for the verified path — review ingestion is now
      // webhook-driven via Zernio. The Zernio connect flow handles backfill
      // when the owner links their GBP account.
    } else if (googleMapsUrl) {
      await enqueueValidatePlaceId(tx, { businessId, googleMapsUrl, correlationId });
    }
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
