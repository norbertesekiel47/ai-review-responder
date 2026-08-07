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

import type { Sql } from 'postgres';
import { v7 as uuidv7 } from 'uuid';
import { rethrowAsDuplicateLocation } from './duplicate-location';
import { enqueueValidatePlaceId, enqueueStripeOverageRecompute } from '@/lib/shared/job-outbox-helpers';
import type { SubscriptionTierValue } from '@/lib/accounts/tier-config';
import { acquireLocationLifecycleLock } from '@/lib/accounts/billing-locks';
import {
  getOffboardingState,
  isBillingMutationBlocked,
  lockAccountBeforeOffboardingProjection,
} from '@/lib/account-offboarding/gate';

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
  /** Owner identity copied onto the businesses row for legacy NOT NULL columns. */
  ownerName?: string | null;
  ownerEmail?: string | null;
  /** Account's subscription tier (read before tx, passed in to avoid re-read). */
  subscriptionTier: SubscriptionTierValue;
  /** Account's subscription status (read before tx, passed in to avoid re-read). */
  subscriptionStatus: string;
  /** Count of active locations before the add (for audit payload). */
  activeLocationsBefore: number;
  /** Optional voice config overrides from the wizard. When provided,
   *  these values are used instead of cloning from the primary location.
   *  This allows the user to "copy from existing" or manually customize. */
  voiceConfig?: {
    tone?: string;
    productsServices?: string | null;
    avoidFacts?: string[];
    sampleResponses?: string[];
  };
  /** Disable when a batch caller will enqueue one aggregate overage update. */
  enqueueStripeOverageUpdate?: boolean;
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
  sql: Sql,
  input: AddLocationTxInput,
): Promise<AddLocationTxResult> {
  const {
    accountId,
    displayLabel,
    googlePlaceId,
    placeIdVerified,
    googleMapsUrl,
    actorUserId,
    ownerName: inputOwnerName,
    ownerEmail: inputOwnerEmail,
    subscriptionTier,
    subscriptionStatus,
    activeLocationsBefore,
    voiceConfig,
    enqueueStripeOverageUpdate = true,
  } = input;

  const businessId = uuidv7();

  // ── Step 1: Resolve voice config ──────────────────────────────────────
  //
  // When the wizard provides voiceConfig overrides (e.g. "copy from existing"
  // or manual customization), use those. Otherwise, clone from the account's
  // current primary location (VAL-LOC-031).
  let tone: string;
  let productsServices: string | null;
  let staffNames: string[] | null;
  let highlightFacts: string[] | null;
  let avoidFacts: string[];
  let sampleResponses: string[];
  let voiceClonedFromPrimary: boolean;

  if (voiceConfig) {
    // User explicitly provided voice config via the wizard
    tone = voiceConfig.tone ?? 'professional and friendly';
    productsServices = voiceConfig.productsServices ?? null;
    staffNames = [];
    highlightFacts = [];
    avoidFacts = voiceConfig.avoidFacts ?? [];
    sampleResponses = voiceConfig.sampleResponses ?? [];
    voiceClonedFromPrimary = false;
  } else {
    // Clone from primary location
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

    tone = primaryVoice?.tone ?? 'professional and friendly';
    productsServices = primaryVoice?.products_services ?? null;
    staffNames = primaryVoice?.staff_names ?? [];
    highlightFacts = primaryVoice?.highlight_facts ?? [];
    avoidFacts = primaryVoice?.avoid_facts ?? [];
    sampleResponses = primaryVoice?.sample_responses ?? [];
    voiceClonedFromPrimary = primaryVoice !== undefined && primaryVoice !== null;
  }

  let ownerName = inputOwnerName?.trim() || null;
  let ownerEmail = inputOwnerEmail?.trim() || null;
  if (!ownerName || !ownerEmail) {
    const [ownerRow] = await sql<{ name: string | null; email: string | null }[]>`
      SELECT u.name, u.email
      FROM accounts a
      JOIN users u ON u.id = a.owner_user_id
      WHERE a.id = ${accountId}::uuid
      LIMIT 1
    `;
    ownerName = ownerName ?? ownerRow?.name?.trim() ?? null;
    ownerEmail = ownerEmail ?? ownerRow?.email?.trim() ?? null;
  }

  if (!ownerName || !ownerEmail) {
    throw new Error('account_owner_identity_required');
  }

  // ── Step 2: Execute atomic transaction ────────────────────────────────
  //
  // VAL-LOC-007: All three INSERTs happen inside sql.begin(). If any
  // INSERT fails, the entire transaction rolls back — nothing is committed.
  //
  // A duplicate active google_place_id trips businesses_account_place_uniq
  // (migration 062, Postgres 23505); map it to the typed 'duplicate_location'
  // error so the route returns 409 instead of a generic 500.
  try {
    await sql.begin(async (tx) => {
      await acquireLocationLifecycleLock(tx, accountId);

      // Expansion authority is decided inside the write transaction. The
      // account lock composes with offboarding confirmation; the lifecycle
      // projection must be a later READ COMMITTED command so a waiter sees the
      // offboarding row inserted by the transaction that released the lock.
      const accountLocked = await lockAccountBeforeOffboardingProjection(
        tx,
        accountId,
      );
      if (!accountLocked) throw new Error('account_not_found');
      const offboardingState = await getOffboardingState(accountId, tx);
      if (isBillingMutationBlocked(offboardingState)) {
        throw new Error('account_offboarding_blocked');
      }

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
          ${ownerName},
          ${ownerEmail},
          ${subscriptionTier},
          ${subscriptionStatus}
        )
      `;

      // 2a-bis. Inherit the archived sibling's Import consent (#677, spec §7).
      //
      // WHY: without this, an owner who DECLINED the Review import could archive
      // the location and re-add it to get a fresh `pending` offer — a D8
      // violation reachable from the locations UI in a few clicks, no SQL
      // required. Consent is per place, and archiving is not a way to withdraw
      // it.
      //
      // THE DECISION IS COPIED UNCONDITIONALLY; THE DEADLINE ONLY WHEN IT HAS
      // ALREADY PASSED (round-1 escalation, deviations D12). Revision 1 copied
      // all three columns verbatim, and that was a defect: `import_offer_expires_at`
      // is the column `createImportOffer` exists to own — it proves BOTH junction
      // halves (activation non-NULL and an active `zernio_connections` row)
      // "because the callers do not check, so the helper must". Inheritance is a
      // caller, and copying a LIVE deadline writes that column behind the helper's
      // back. Reachable in two steps: archive a location holding a live unanswered
      // Import offer, re-add the same place, and the new row presents an
      // ANSWERABLE offer with no active connection — possibly before its own
      // activation — so accepting enqueues an import the worker cannot service.
      //
      // The CASE is keyed on the DEADLINE ALONE, not on the decision. That is the
      // stronger, smaller invariant: inheritance never writes a future deadline,
      // full stop, so `createImportOffer` remains the only writer that can mint a
      // live one. For an answered row the column is inert either way —
      // `importConsentStateSql` derives 'expired' only for `pending`, and returns
      // the stored decision whatever the deadline. The boundary is `<=`, matching
      // spec §5.3 exactly: a deadline that has arrived has passed, so it is copied
      // and the new row derives expired. A NULL sibling deadline falls to ELSE and
      // stays NULL, which is the same value it would have been copied as.
      //
      // A PAST deadline MUST still be copied. `user_visible_behavior` locks it:
      // re-adding a location whose archived row "declined or let the offer expire"
      // does not re-offer the import. Dropping a past deadline to NULL would leave
      // the row `pending` + NULL, which `importConsentStateSql` reads as plain
      // pending — and the new row would be re-offered at its own junction, which
      // is exactly the behaviour the copy exists to prevent.
      //
      // THE MATCH KEY IS A DISJUNCTION OVER NON-NULL KEYS, both directions
      // (round-1 F103, corrected by a round-2 Medium). Choosing the key from the
      // NEW row only — place id if it has one, else maps url — still misses the
      // cross-representation case, because URL-mode adds deliberately store a
      // `google_maps_url` with a NULL `google_place_id` until `validate_place_id`
      // resolves it (see 2c below). So both of these occur in practice:
      //   - new row has a place id, archived sibling's place id is NULL
      //   - archived sibling has a place id, new row's is NULL
      // A sibling qualifies when EITHER key matches with BOTH sides non-NULL.
      // Never NULL to NULL, in either column: NULL = NULL is not a match, it is
      // two locations that merely both lack an identifier.
      //
      // ORDER BY is three-deep (round-1 Medium, F104): `archived_at` alone is
      // nondeterministic on a tie, and two siblings archived in the same
      // statement share it exactly. Scoped by `account_id` (invariant #8) so a
      // foreign account's archived row for the same place can never donate
      // consent.
      //
      // Still ONE statement and no read-then-decide: the deadline rule is a CASE
      // evaluated in-database, so `now()` is POSTGRES's. A JS-side comparison
      // would be wrong here for the same reason it is wrong in
      // `importConsentStateSql` — postgres.js truncates `timestamptz`
      // microseconds to milliseconds, so a deadline that round-tripped through JS
      // can land on the wrong side of its own boundary. A follow-up UPDATE rather
      // than folding the lookup into the INSERT above: smaller diff, and the
      // existing insert stays untouched.
      await tx`
        UPDATE businesses AS nb
        SET import_decision = sib.import_decision,
            import_decision_at = sib.import_decision_at,
            import_offer_expires_at = CASE
              WHEN sib.import_offer_expires_at <= now()
              THEN sib.import_offer_expires_at
              ELSE NULL
            END
        FROM (
          SELECT ab.import_decision, ab.import_decision_at, ab.import_offer_expires_at
          FROM businesses ab
          WHERE ab.account_id = ${accountId}::uuid
            AND ab.id <> ${businessId}::uuid
            AND ab.archived_at IS NOT NULL
            AND (
              (
                ab.google_place_id IS NOT NULL
                AND ${googlePlaceId ?? null}::text IS NOT NULL
                AND ab.google_place_id = ${googlePlaceId ?? null}::text
              )
              OR (
                ab.google_maps_url IS NOT NULL
                AND ${googleMapsUrl ?? null}::text IS NOT NULL
                AND ab.google_maps_url = ${googleMapsUrl ?? null}::text
              )
            )
          ORDER BY ab.archived_at DESC, ab.created_at DESC, ab.id DESC
          LIMIT 1
        ) AS sib
        WHERE nb.id = ${businessId}::uuid
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
          ${tx.json({
            display_label: displayLabel,
            google_place_id: googlePlaceId ?? null,
            active_locations_before: activeLocationsBefore,
            voice_cloned_from_primary: voiceClonedFromPrimary,
          })}
        )
      `;

      // 2c. Enqueue validate_place_id on the Maps-URL path (no verified place id).
      //
      // URL-mode adds store a google_maps_url with NULL google_place_id, so they
      // bypass businesses_account_place_uniq (migration 062, NON-NULL only) until
      // the place id is resolved. Enqueueing validate_place_id (same topic the
      // onboarding paths use) makes the worker resolve + check the place id, where
      // a duplicate trips the unique index. WHERE NOT EXISTS dedups against an
      // already-in-flight validate_place_id row for this business.
      // Gate on the DATA, not the client-supplied placeIdVerified flag: a
      // crafted/buggy request claiming verified-with-no-place-id must still
      // resolve, or the row permanently bypasses migration 062 (NULL never
      // collides). A stored place id (verified or not) suppresses the enqueue
      // so resolution can never overwrite an explicitly supplied id — the
      // route schema additionally rejects the url+place-id shape outright.
      if (googleMapsUrl && !googlePlaceId) {
        await enqueueValidatePlaceId(tx, { businessId, googleMapsUrl });
      }

      if (enqueueStripeOverageUpdate) {
        // 2d. Enqueue Stripe overage update
        // VAL-BILLING-072: Uses outbox pattern instead of Checkout redirect for active accounts
        await enqueueStripeOverageRecompute(tx, accountId);
      }

      // Zernio backfill is queued by /api/zernio/connect/select-location after
      // the owner connects this location. At add-location time there is no
      // zernio_connections row yet, so enqueueing here would create a malformed
      // worker payload.
    });
  } catch (err) {
    rethrowAsDuplicateLocation(err);
  }

  return {
    businessId,
    displayLabel,
    voiceClonedFromPrimary,
  };
}
