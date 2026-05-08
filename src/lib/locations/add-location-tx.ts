// src/lib/locations/add-location-tx.ts
//
// Atomic add-location transaction. Inserts businesses + account_audit_log +
// job_outbox rows in a single sql.begin() transaction. If any INSERT fails,
// the entire transaction rolls back (all-or-nothing).
//
// Voice config (tone, products_services, staff_names, highlight_facts,
// avoid_facts, sample_responses) is cloned from the account's primary
// location at creation time. After creation, each location's voice config
// is independent — edits to one location do not propagate to others.
//
// Validation contract: VAL-LOC-007 (atomic tx), VAL-LOC-008 (is_primary=FALSE),
// VAL-LOC-024 (location_created audit event), VAL-LOC-031 (voice cloning),
// VAL-LOC-032 (voice independence), VAL-LOC-036 (display_label from input).

import { v7 as uuidv7 } from 'uuid';
import { sql, jsonb } from '@/lib/db/server';
import type { AccountId, LocationId } from '@/lib/shared/ids';

// ── Input / Output types ───────────────────────────────────────────────────

export interface AddLocationTxInput {
  /** Account to add the location to. */
  accountId: string;
  /** User-visible location name (e.g., "Downtown Cafe"). Stored as display_label. */
  displayLabel: string;
  /** Google Place ID (optional, from Place Autocomplete wizard step). */
  googlePlaceId?: string | null;
  /** Whether the Place ID was verified by the autocomplete widget. */
  placeIdVerified?: boolean;
  /** Google Maps URL (optional, from manual URL entry wizard step). */
  googleMapsUrl?: string | null;
  /** User ID of the actor performing the add (for audit log). */
  actorUserId?: string | null;
  /** Account's subscription tier (read before tx, passed in to avoid re-read). */
  subscriptionTier: string;
  /** Account's subscription status (read before tx, passed in to avoid re-read). */
  subscriptionStatus: string;
  /** Count of active locations before the add (for audit payload). */
  activeLocationsBefore: number;
}

export interface AddLocationTxResult {
  /** ID of the newly created businesses row. */
  businessId: string;
  /** The display_label that was stored. */
  displayLabel: string;
  /** Whether voice config was cloned from primary. */
  voiceClonedFromPrimary: boolean;
}

// ── Primary location voice row ─────────────────────────────────────────────

interface PrimaryVoiceRow {
  tone: string | null;
  products_services: string | null;
  staff_names: string[] | null;
  highlight_facts: string[] | null;
  avoid_facts: string[] | null;
  sample_responses: string[] | null;
}

// ── addLocationTransaction ──────────────────────────────────────────────────

/**
 * Executes the add-location atomic transaction.
 *
 * VAL-LOC-007: Atomically inserts businesses + account_audit_log + job_outbox.
 * VAL-LOC-008: New businesses row has is_primary = FALSE.
 * VAL-LOC-024: Audit log records 'location_created' event with actor and payload.
 * VAL-LOC-031: Voice config cloned from primary location at creation time.
 * VAL-LOC-032: No implicit voice inheritance after creation — each location independent.
 * VAL-LOC-036: display_label set from user input.
 */
export async function addLocationTransaction(
  input: AddLocationTxInput,
): Promise<AddLocationTxResult> {
  const {
    accountId,
    displayLabel,
    googlePlaceId,
    placeIdVerified,
    googleMapsUrl,
    actorUserId,
    subscriptionTier,
    subscriptionStatus,
    activeLocationsBefore,
  } = input;

  const businessId = uuidv7();

  // ── Step 1: Clone voice config from primary location ──────────────────
  //
  // VAL-LOC-031: Voice config is cloned from the account's current primary
  // location at creation time. This ensures the new location starts with
  // sensible defaults rather than an empty voice config.
  //
  // VAL-LOC-032: After creation, the voice config is independent — each
  // location's tone/facts/resplies can be edited independently. The cloning
  // is a one-time snapshot at creation, not ongoing inheritance.
  const [primaryVoice] = await sql<PrimaryVoiceRow[]>`
    SELECT
      tone,
      products_services,
      staff_names,
      highlight_facts,
      avoid_facts,
      sample_responses
    FROM businesses
    WHERE account_id = ${accountId}::uuid
      AND is_primary = TRUE
      AND archived_at IS NULL
    LIMIT 1
  `;

  // Fallback defaults when no primary exists (edge case: all archived, or
  // first location somehow not primary — shouldn't happen but be safe)
  const tone = primaryVoice?.tone ?? 'professional and friendly';
  const productsServices = primaryVoice?.products_services ?? null;
  const staffNames = primaryVoice?.staff_names ?? [];
  const highlightFacts = primaryVoice?.highlight_facts ?? [];
  const avoidFacts = primaryVoice?.avoid_facts ?? [];
  const sampleResponses = primaryVoice?.sample_responses ?? [];
  const voiceClonedFromPrimary = primaryVoice !== undefined && primaryVoice !== null;

  // ── Step 2: Execute atomic transaction ────────────────────────────────
  //
  // VAL-LOC-007: All three INSERTs happen inside sql.begin(). If any
  // INSERT fails, the entire transaction rolls back — nothing is committed.
  await sql.begin(async (tx) => {
    // 2a. Insert businesses row
    // VAL-LOC-008: is_primary = FALSE (this is NOT the first location)
    // VAL-LOC-036: display_label set from user input
    await tx`
      INSERT INTO businesses (
        id, account_id, is_primary, display_label,
        name, google_place_id, place_id_verified, google_maps_url,
        tone, products_services, staff_names, highlight_facts,
        avoid_facts, sample_responses, owner_name, owner_email,
        subscription_tier, subscription_status
      ) VALUES (
        ${businessId}::uuid,
        ${accountId}::uuid,
        FALSE,
        ${displayLabel},
        ${displayLabel},
        ${googlePlaceId ?? null},
        ${placeIdVerified ?? false},
        ${googleMapsUrl ?? null},
        ${tone},
        ${productsServices},
        ${staffNames ?? []},
        ${highlightFacts ?? []},
        ${avoidFacts ?? []},
        ${sampleResponses ?? []},
        ${null},
        ${null},
        ${subscriptionTier},
        ${subscriptionStatus}
      )
    `;

    // 2b. Insert audit log entry
    // VAL-LOC-024: Records 'location_created' with actor and payload
    await tx`
      INSERT INTO account_audit_log (
        id, account_id, location_id, event_type, actor_user_id, payload
      ) VALUES (
        ${uuidv7()}::uuid,
        ${accountId}::uuid,
        ${businessId}::uuid,
        'location_created',
        ${actorUserId ?? null}::uuid,
        ${jsonb({
          display_label: displayLabel,
          google_place_id: googlePlaceId ?? null,
          active_locations_before: activeLocationsBefore,
          voice_cloned_from_primary: voiceClonedFromPrimary,
        })}
      )
    `;

    // 2c. Enqueue Stripe overage update
    // VAL-BILLING-072: Uses outbox pattern instead of Checkout redirect for active accounts
    await tx`
      INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
      VALUES (
        ${uuidv7()},
        'update_stripe_overage_quantity',
        'account',
        ${accountId}::uuid,
        ${jsonb({
          account_id: accountId,
          correlation_id: uuidv7(),
        })},
        'pending'
      )
    `;

    // 2d. Enqueue Zernio initial backfill for the new location
    // VAL-LOC-052: zernio_initial_backfill job enqueued for new location.
    // The job will be picked up by the ZernioInitialBackfillWorker, which
    // checks for an active Zernio connection for this location. If no
    // connection exists (owner skipped the Zernio step), the job completes
    // as a no-op. This ensures per-location Zernio independence — each
    // location gets its own backfill, and skipping is graceful.
    await tx`
      INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
      VALUES (
        ${uuidv7()},
        'zernio_initial_backfill',
        'business',
        ${businessId}::uuid,
        ${jsonb({
          business_id: businessId,
          account_id: accountId,
          correlation_id: uuidv7(),
        })},
        'pending'
      )
    `;
  });

  return {
    businessId,
    displayLabel,
    voiceClonedFromPrimary,
  };
}
