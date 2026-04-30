import { v7 as uuidv7 } from 'uuid';
import { sql, jsonb } from '@/lib/db/server';
import { buildPaymentLinkUrl } from '@/lib/payments/payment-link';
import type { ValidatePlaceIdPayload } from '@/lib/shared/worker-types';

/**
 * Thrown when the businesses+users insert transaction fails on a PG 23505
 * (unique_violation) — currently the `users.email` unique constraint is the
 * only expected trigger. Callers translate this into a 409 response.
 */
export class DuplicateEmailError extends Error {
  constructor() {
    super('users.email unique constraint violation');
    this.name = 'DuplicateEmailError';
  }
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
  subscriptionTier: 'founding' | 'standard';
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
  paymentUrl: string | null;
}

export async function createBusinessTx(
  input: AdminBusinessTxInput,
  options: { mode: 'admin'; onboardedBy: string },
): Promise<CreateBusinessResult>;
export async function createBusinessTx(
  input: SelfServeBusinessTxInput,
  options: { mode: 'self_serve'; authId: string },
): Promise<CreateBusinessResult>;
/**
 * Shared business-onboarding transaction used by both the admin route
 * (`POST /api/admin/businesses`) and self-serve signup (`POST /api/auth/signup`
 * + `POST /api/auth/finish-signup`).
 *
 * Writes businesses + users + channel_enrollments in a single sql.begin
 * transaction. In admin mode, additionally INSERTs a job_outbox row for
 * validate_place_id when a Maps URL is provided (Place ID verified = no
 * enqueue — review ingestion is webhook-driven via Zernio).
 * In self_serve mode, skips the outbox insert entirely and writes the
 * businesses row with placeholder identity-only fields — the
 * /api/onboarding/business handler updates those fields and enqueues
 * validate_place_id once the owner finishes the wizard after Stripe payment.
 *
 * On PG 23505 (unique_violation, typically users.email), throws
 * DuplicateEmailError so the caller can return 409.
 */
export async function createBusinessTx(
  input: AdminBusinessTxInput | SelfServeBusinessTxInput,
  options: CreateBusinessOptions,
): Promise<CreateBusinessResult> {
  // Defense-in-depth: normalize email at the persistence boundary. The schema
  // layer does this too (normalizedEmailSchema via z.preprocess), but belt-and-
  // suspenders — createBusinessTx is shared by multiple callers.
  const ownerEmail = input.ownerEmail.trim().toLowerCase();

  const businessId = uuidv7();
  const userId = uuidv7();

  const authId = options.mode === 'self_serve' ? options.authId : null;
  const onboardedBy = options.mode === 'admin' ? options.onboardedBy : null;

  // Self-serve hardcodes 'standard' tier (admin retains the founding/standard
  // choice via AdminBusinessTxInput.subscriptionTier).
  const subscriptionTier =
    options.mode === 'admin'
      ? (input as AdminBusinessTxInput).subscriptionTier
      : ('standard' as const);

  // Compute payment URL BEFORE the transaction — if the env var is malformed
  // we return null gracefully rather than crashing mid-tx.
  const paymentUrl = buildPaymentLinkUrl(subscriptionTier, businessId, ownerEmail);

  try {
    if (options.mode === 'admin') {
      const adminInput = input as AdminBusinessTxInput;
      await runAdminTx({
        adminInput,
        businessId,
        userId,
        ownerEmail,
        onboardedBy: onboardedBy!,
      });
    } else {
      const selfServeInput = input as SelfServeBusinessTxInput;
      await runSelfServeTx({
        selfServeInput,
        businessId,
        userId,
        ownerEmail,
        authId: authId!,
      });
    }
  } catch (err) {
    const pgErr = err as { code?: string };
    if (pgErr.code === '23505') {
      throw new DuplicateEmailError();
    }
    throw err;
  }

  return { businessId, userId, paymentUrl };
}

async function runAdminTx(args: {
  adminInput: AdminBusinessTxInput;
  businessId: string;
  userId: string;
  ownerEmail: string;
  onboardedBy: string;
}): Promise<void> {
  const { adminInput, businessId, userId, ownerEmail, onboardedBy } = args;

  const placeId = adminInput.placeId.placeIdVerified
    ? adminInput.placeId.placeId
    : adminInput.placeId.placeId ?? null;
  const googleMapsUrl = adminInput.placeId.googleMapsUrl ?? null;
  const placeIdVerified = adminInput.placeId.placeIdVerified;

  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO businesses (
        id,
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
        ${businessId},
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
        ${adminInput.subscriptionTier},
        'pending_payment',
        ${adminInput.website ?? null},
        ${onboardedBy}
      )
    `;

    await tx`
      INSERT INTO users (id, auth_id, name, email, phone, role, business_id)
      VALUES (
        ${userId},
        ${null},
        ${adminInput.ownerName},
        ${ownerEmail},
        ${adminInput.ownerPhone ?? null},
        'owner',
        ${businessId}
      )
    `;

    await tx`
      INSERT INTO channel_enrollments (id, business_id, channel, handle, status, verified_at)
      VALUES (${uuidv7()}, ${businessId}, 'email', ${ownerEmail}, 'verified', NOW())
      ON CONFLICT (business_id, channel) WHERE archived_at IS NULL DO NOTHING
    `;

    const correlationId = uuidv7();
    if (placeIdVerified && placeId) {
      // No outbox enqueue for the verified path — review ingestion is now
      // webhook-driven via Zernio. The Zernio connect flow handles backfill
      // when the owner links their GBP account.
    } else if (googleMapsUrl) {
      const payload: ValidatePlaceIdPayload = {
        business_id: businessId,
        google_maps_url: googleMapsUrl,
        correlation_id: correlationId,
      };
      await tx`
        INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
        VALUES (
          ${uuidv7()},
          'validate_place_id',
          'business',
          ${businessId},
          ${jsonb(payload)},
          'pending'
        )
      `;
    }
  });
}

async function runSelfServeTx(args: {
  selfServeInput: SelfServeBusinessTxInput;
  businessId: string;
  userId: string;
  ownerEmail: string;
  authId: string;
}): Promise<void> {
  const { selfServeInput, businessId, userId, ownerEmail, authId } = args;

  await sql.begin(async (tx) => {
    // Placeholder row — name = PLACEHOLDER_BUSINESS_NAME, all place + profile
    // fields NULL or empty array. The /api/onboarding/business handler
    // UPDATEs these once the owner completes the wizard after Stripe payment.
    // place_id_verified intentionally left to its DB default of FALSE; we
    // pass FALSE explicitly here so the column INSERT order matches the
    // admin path verbatim and the row is unambiguously "not yet verified".
    await tx`
      INSERT INTO businesses (
        id,
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
        ${businessId},
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
        ${'standard'},
        'pending_payment',
        ${null},
        ${null}
      )
    `;

    await tx`
      INSERT INTO users (id, auth_id, name, email, phone, role, business_id)
      VALUES (
        ${userId},
        ${authId},
        ${selfServeInput.ownerName},
        ${ownerEmail},
        ${selfServeInput.ownerPhone ?? null},
        'owner',
        ${businessId}
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
