import { v7 as uuidv7 } from 'uuid';
import { sql, jsonb } from '@/lib/db/server';
import { buildPaymentLinkUrl } from '@/lib/payments/payment-link';
import type { SyncReviewsPayload, ValidatePlaceIdPayload } from '@/lib/shared/worker-types';

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
 * Place ID input — discriminated union makes "verified but no place ID"
 * and "unverified but no URL" unrepresentable at compile time.
 */
export type PlaceIdInput =
  | { placeIdVerified: true; placeId: string; googleMapsUrl?: string | null }
  | { placeIdVerified: false; placeId?: string | null; googleMapsUrl: string };

export interface BusinessTxInput {
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
 * Mode discriminator — admin onboarding and self-serve signup differ in two
 * critical ways: users.auth_id (admin=NULL, self_serve=<authId>) and whether
 * an outbox row is INSERTed (admin=yes, self_serve=no — Stripe webhook will
 * enqueue on activation).
 */
export type CreateBusinessOptions =
  | { mode: 'admin'; onboardedBy: string }
  | { mode: 'self_serve'; authId: string };

export interface CreateBusinessResult {
  businessId: string;
  userId: string;
  paymentUrl: string | null;
}

/**
 * Shared business-onboarding transaction used by both the admin route
 * (`POST /api/admin/businesses`) and self-serve signup (`POST /api/auth/signup`
 * + `POST /api/auth/finish-signup`).
 *
 * Writes businesses + users + channel_enrollments in a single sql.begin
 * transaction. In admin mode, additionally INSERTs a job_outbox row
 * (sync_reviews when Place ID is verified, validate_place_id otherwise).
 * In self_serve mode, skips the outbox insert — the Stripe webhook enqueues
 * the initial sync on subscription activation.
 *
 * On PG 23505 (unique_violation, typically users.email), throws
 * DuplicateEmailError so the caller can return 409.
 */
export async function createBusinessTx(
  input: BusinessTxInput,
  options: CreateBusinessOptions,
): Promise<CreateBusinessResult> {
  // Defense-in-depth: normalize email at the persistence boundary. The schema
  // layer does this too (normalizedEmailSchema via z.preprocess), but belt-and-
  // suspenders — createBusinessTx is shared by multiple callers.
  const ownerEmail = input.ownerEmail.trim().toLowerCase();

  const businessId = uuidv7();
  const userId = uuidv7();

  const placeId = input.placeId.placeIdVerified
    ? input.placeId.placeId
    : input.placeId.placeId ?? null;
  const googleMapsUrl = input.placeId.googleMapsUrl ?? null;
  const placeIdVerified = input.placeId.placeIdVerified;

  const authId = options.mode === 'self_serve' ? options.authId : null;
  const onboardedBy = options.mode === 'admin' ? options.onboardedBy : null;
  const enqueueInitialSync = options.mode === 'admin';

  // Compute payment URL BEFORE the transaction — if the env var is malformed
  // we return null gracefully rather than crashing mid-tx.
  const paymentUrl = buildPaymentLinkUrl(input.subscriptionTier, businessId, ownerEmail);

  try {
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
          ${input.businessName},
          ${input.category ?? null},
          ${placeId},
          ${placeIdVerified},
          ${googleMapsUrl},
          ${input.tone ?? 'professional and friendly'},
          ${input.productsServices ?? null},
          ${input.staffNames ?? []},
          ${input.highlightFacts ?? []},
          ${input.avoidFacts ?? []},
          ${input.sampleResponses ?? []},
          ${input.ownerName},
          ${ownerEmail},
          ${input.ownerPhone ?? null},
          ${input.subscriptionTier},
          'pending_payment',
          ${input.website ?? null},
          ${onboardedBy}
        )
      `;

      await tx`
        INSERT INTO users (id, auth_id, name, email, phone, role, business_id)
        VALUES (
          ${userId},
          ${authId},
          ${input.ownerName},
          ${ownerEmail},
          ${input.ownerPhone ?? null},
          'owner',
          ${businessId}
        )
      `;

      await tx`
        INSERT INTO channel_enrollments (id, business_id, channel, handle, status, verified_at)
        VALUES (${uuidv7()}, ${businessId}, 'email', ${ownerEmail}, 'verified', NOW())
        ON CONFLICT (business_id, channel) WHERE archived_at IS NULL DO NOTHING
      `;

      if (enqueueInitialSync) {
        const correlationId = uuidv7();
        if (placeIdVerified && placeId) {
          const payload: SyncReviewsPayload = {
            business_id: businessId,
            google_place_id: placeId,
            correlation_id: correlationId,
          };
          await tx`
            INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
            VALUES (
              ${uuidv7()},
              'sync_reviews',
              'business',
              ${businessId},
              ${jsonb(payload)},
              'pending'
            )
          `;
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
      }
    });
  } catch (err) {
    const pgErr = err as { code?: string };
    if (pgErr.code === '23505') {
      throw new DuplicateEmailError();
    }
    throw err;
  }

  return { businessId, userId, paymentUrl };
}
