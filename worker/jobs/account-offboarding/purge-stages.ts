import type postgres from 'postgres';
import type { SupabaseClient } from '@supabase/supabase-js';
import { verifyAccountOffboardingPurge } from '../../../src/lib/account-offboarding/purge-verification';
import {
  extractConcreteAdminProviderDispositions,
  hasConcreteAdminProviderDisposition,
  unresolvedApplicableTeardownProviders,
} from '../../../src/lib/account-offboarding/provider-disposition';
import { enqueueOffboardingPurged } from '../../../src/lib/account-offboarding/analytics';
import { enqueueAccountOffboardingEmail } from '../../../src/lib/account-offboarding/outbox';
import { acquireSolicitationBatchLock } from '../../../src/lib/solicitation/batch-builder';
import { acquireCsvIngestLock } from '../../../src/lib/solicitation/ingest';
import {
  deleteByBusiness,
  impersonationSessionScrubScopeRecord,
  isSupabaseAuthNotFound,
  jobOutboxScrubScopeRecord,
  safeSupabaseError,
} from './purge-helpers';

export interface AccountOffboardingPurgeRow {
  id: string;
  account_id: string;
  mode: 'delete_data';
  status: 'purge_scheduled' | 'purged' | 'failed';
  terminal_at: Date | string | null;
  teardown_completed_at: Date | string | null;
  purge_started_at: Date | string | null;
  purge_cancelled_at: Date | string | null;
  auth_user_id: string | null;
  recipient_email: string | null;
  provider_dispositions: unknown;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  zernio_account_ids: string[] | null;
  zernio_profile_ids: string[] | null;
  location_ids: string[] | null;
  stripe_step: string | null;
  zernio_accounts_step: string | null;
  zernio_profiles_step: string | null;
  location_archival_step: string | null;
}

interface AuthRevalidationRow {
  can_delete: boolean;
  already_detached: boolean;
}

class StaleOutboxAttemptError extends Error {
  constructor() {
    super('account_offboarding_purge_stale_outbox_attempt');
    this.name = 'StaleOutboxAttemptError';
  }
}

export function isStaleOutboxAttemptError(err: unknown): boolean {
  return err instanceof StaleOutboxAttemptError;
}

export async function loadPurgeOffboarding(
  sql: postgres.Sql,
  accountOffboardingId: string,
  accountId: string,
): Promise<AccountOffboardingPurgeRow | null> {
  const [row] = await sql<AccountOffboardingPurgeRow[]>`
    SELECT id, account_id, mode, status, terminal_at, teardown_completed_at,
           purge_started_at, purge_cancelled_at, auth_user_id,
           recipient_email, provider_dispositions, stripe_customer_id,
           stripe_subscription_id, zernio_account_ids, zernio_profile_ids,
           location_ids, stripe_step, zernio_accounts_step, zernio_profiles_step,
           location_archival_step
    FROM account_offboardings
    WHERE id = ${accountOffboardingId}::uuid
      AND account_id = ${accountId}::uuid
  `;
  return row ?? null;
}

export function validatePurgeableOffboarding(
  row: AccountOffboardingPurgeRow,
): string | null {
  if (row.mode !== 'delete_data') return 'account_offboarding_mode_not_delete_data';
  if (row.status !== 'purge_scheduled') {
    return `account_offboarding_status_not_purgeable:${row.status}`;
  }
  if (row.terminal_at !== null) return 'account_offboarding_already_terminal';
  if (row.purge_cancelled_at !== null) return 'account_offboarding_purge_cancelled';
  if (row.purge_started_at === null) return 'account_offboarding_purge_not_started';
  if (row.teardown_completed_at === null) {
    // Teardown did not complete normally — this row reached purge_scheduled via an
    // admin force-transition. Re-assert the same invariant that gate enforces, as
    // defense-in-depth before the irreversible purge: there must be a concrete
    // disposition, AND it (plus any others) must cover EVERY applicable provider
    // resource the teardown left unresolved. Otherwise a purge would destroy the
    // local pointers to a live provider resource that was never torn down.
    if (!hasConcreteAdminProviderDisposition(row.provider_dispositions)) {
      return 'account_offboarding_teardown_incomplete';
    }
    const unresolved = unresolvedApplicableTeardownProviders(
      row,
      extractConcreteAdminProviderDispositions(row.provider_dispositions),
    );
    if (unresolved.length > 0) {
      return 'account_offboarding_teardown_incomplete';
    }
  }
  return null;
}

export async function runAuthBindingPurgeStage(
  sql: postgres.Sql,
  supabaseServer: SupabaseClient,
  row: AccountOffboardingPurgeRow,
): Promise<void> {
  if (!row.auth_user_id?.trim()) return;

  const authUserId = row.auth_user_id;
  const resolution = await revalidateAuthBinding(sql, row, authUserId);
  if (resolution === 'already_detached') return;

  const result = await supabaseServer.auth.admin.deleteUser(authUserId);
  if (result.error && !isSupabaseAuthNotFound(result.error)) {
    throw new Error(`supabase_delete_user_failed:${safeSupabaseError(result.error)}`);
  }

  await sql.begin(async (tx) => {
    await tx`
      UPDATE users
      SET auth_id = NULL,
          updated_at = NOW()
      WHERE account_id = ${row.account_id}::uuid
        AND auth_id = ${authUserId}
    `;
  });
}

async function revalidateAuthBinding(
  sql: postgres.Sql,
  row: AccountOffboardingPurgeRow,
  authUserId: string,
): Promise<'delete_required' | 'already_detached'> {
  const [match] = await sql.begin(async (tx) => tx<AuthRevalidationRow[]>`
    SELECT
      EXISTS (
        SELECT 1
        FROM users u
        WHERE u.auth_id = ${authUserId}
          AND u.account_id = ${row.account_id}::uuid
          AND NOT EXISTS (
            SELECT 1
            FROM users future_binding
            WHERE future_binding.auth_id = ${authUserId}
              AND future_binding.account_id <> ${row.account_id}::uuid
          )
      ) AS can_delete,
      NOT EXISTS (
        SELECT 1
        FROM users u
        WHERE u.account_id = ${row.account_id}::uuid
          AND u.auth_id IS NOT NULL
      ) AS already_detached
  `);

  if (match?.can_delete) return 'delete_required';
  if (match?.already_detached) return 'already_detached';

  throw new Error('account_offboarding_auth_revalidation_failed');
}

export async function runDependentReferencePurgeStage(sql: postgres.Sql, row: AccountOffboardingPurgeRow): Promise<void> {
  await sql.begin(async (tx) => {
    // Sequential awaits share one Postgres.js transaction connection (sql.begin); they execute
    // serially on a single connection and cannot be parallelized.
    // react-doctor-disable-next-line react-doctor/async-parallel
    await tx`
      DELETE FROM account_offboarding_tokens t
      USING account_offboardings ao
      WHERE t.account_offboarding_id = ao.id
        AND ao.id = ${row.id}::uuid
        AND ao.account_id = ${row.account_id}::uuid
    `;
    await tx`
      UPDATE approval_audit_log
      SET response_id = NULL,
          token_hash = NULL,
          device_cookie_hash = NULL,
          ip_address = NULL,
          metadata = '{}'::jsonb,
          actor_user_id = NULL,
          response_text_at_approval = NULL
      WHERE account_id = ${row.account_id}::uuid
    `;
    await tx`
      DELETE FROM notification_deliveries nd
      WHERE nd.account_id = ${row.account_id}::uuid
         OR nd.business_id IN (
           SELECT id FROM businesses WHERE account_id = ${row.account_id}::uuid
         )
    `;
    await tx`
      UPDATE api_costs
      SET account_id = NULL,
          business_id = NULL,
          response_id = NULL,
          endpoint = 'scrubbed:' || id::text,
          moderation_categories = NULL,
          flag_reason = NULL,
          output_excerpt = NULL
      WHERE account_id = ${row.account_id}::uuid
    `;
    await tx`
      UPDATE api_costs ac
      SET account_id = NULL,
          business_id = NULL,
          response_id = NULL,
          endpoint = 'scrubbed:' || ac.id::text,
          moderation_categories = NULL,
          flag_reason = NULL,
          output_excerpt = NULL
      FROM businesses b
      WHERE ac.business_id = b.id
        AND b.account_id = ${row.account_id}::uuid
    `;
    await tx`
      UPDATE review_exceptions re
      SET review_id = NULL,
          response_id = NULL,
          payload = '{}'::jsonb
      FROM businesses b
      WHERE re.business_id = b.id
        AND b.account_id = ${row.account_id}::uuid
    `;
  });
}

export async function runContentPurgeStage(sql: postgres.Sql, row: AccountOffboardingPurgeRow): Promise<void> {
  await sql.begin(async (tx) => {
    // Serialize against in-flight contacts-CSV ingestion (#582) BEFORE any
    // delete, mirroring the ingest transaction's own lock-first discipline.
    //
    // src/lib/solicitation/ingest.ts documents a per-business contract: every
    // writer of `contact_csv_uploads` opens by taking the csv_ingest advisory
    // lock. Three writers honoured it; this stage — which hard-DELETEs those
    // rows by account_id — did not, so the contract was true of three of its
    // four writers while reading, from inside ingest.ts, as though it held
    // universally. The purge could commit between an ingest's `status='pending'`
    // read and its terminal write, leaving the job to report success for an
    // upload whose row no longer existed.
    //
    // The lock is per-BUSINESS and this stage is per-ACCOUNT, so it takes one
    // per business under the account. Via acquireCsvIngestLock rather than a
    // hand-spelled `hashtext('csv_ingest_' || id)` on purpose: two derivations
    // of one key is how a lock silently stops contending while still looking
    // taken. `businesses` (not DISTINCT business_id from the uploads table) is
    // the source so a business with no upload row yet is still covered, and so
    // this does not itself become the pre-lock peek ingest.ts warns about.
    //
    // Waiting here is the intended behaviour: an ingest holds its lock across a
    // <=5,000-row transaction, so the purge blocks for at most that long.
    //
    // The same argument, and the same shape, apply to the solicitation_batch
    // lock (#624 T8): batch construction holds it across the transaction that
    // row-locks and builds a batch, and this stage's DELETE of
    // contact_csv_uploads cascades into solicitation_batches — taking row locks
    // on the very rows construction is mutating, and transitively removing
    // solicitation_asks and (migration 091) solicitation_outreach, whose
    // batch_id/account_id/business_id FK is ON DELETE CASCADE. No DELETE of its
    // own for either child table; the cascade is the sweep.
    //
    // GLOBAL LOCK ORDER — advisory first, then row locks. This loop is the
    // "advisory first" half for both keys; batch construction obeys the same
    // order from the other side (acquireSolicitationBatchLock's docstring owns
    // the contract). Reversing either side is an ABBA deadlock.
    const businesses = await tx<{ id: string }[]>`
      SELECT id FROM businesses WHERE account_id = ${row.account_id}::uuid ORDER BY id
    `;
    // Sequential by necessity — one transaction connection — and ordered by id
    // so two purges touching a shared business can never deadlock. Both keys
    // are taken per business in one pass, always csv_ingest then
    // solicitation_batch, so two purges cannot invert them either.
    // react-doctor-disable-next-line react-doctor/async-parallel
    for (const business of businesses) {
      await acquireCsvIngestLock(tx, business.id);
      await acquireSolicitationBatchLock(tx, business.id);
    }

    // Sequential awaits share one Postgres.js transaction connection (sql.begin); they execute
    // serially on a single connection and cannot be parallelized.
    // react-doctor-disable-next-line react-doctor/async-parallel
    await tx`
      DELETE FROM flagged_responses
      WHERE account_id = ${row.account_id}::uuid
    `;
    // Contacts CSV ingestion + batch persistence (migrations 086/088):
    // deleting the account-scoped upload rows CASCADEs to solicitation_contacts
    // and solicitation_batches; contacts transitively remove visits, while
    // batches transitively remove solicitation_asks and, since migration 091,
    // solicitation_outreach. Visits also cascade through
    // their own upload_id FK and through the composite
    // solicitation_visits_contact_business_fk on solicitation_contacts(id,
    // business_id), so no separate DELETE is needed for any child table.
    // Verified against migrations 086 and 088. businesses/accounts are
    // retain_deidentified (UPDATE-tombstoned, never DELETEd), so this explicit
    // DELETE is the only way these three hard_delete/must_be_absent tables
    // actually get swept; without it, purge-verification.ts fails every
    // account that has ever uploaded a contacts CSV.
    await tx`
      DELETE FROM contact_csv_uploads
      WHERE account_id = ${row.account_id}::uuid
    `;
    // Consent ledger (migration 093, #625): businesses rows are TOMBSTONED,
    // never deleted, so 093's business_id ON DELETE CASCADE never fires on
    // this path (spec §7.2's cascade assumption was wrong). The upload delete
    // above only nulls source_upload_id (ON DELETE SET NULL) and consent has
    // no FK to contacts, so this explicit sweep is the ONLY deleter at purge.
    // Consent fails closed (DR1): a deleted row is safe, a surviving one is
    // residual customer data — purge-verification's must_be_absent check
    // backstops this. Runs under the same csv-ingest/batch advisory locks
    // acquired above, after the upload delete so it sweeps post-SET-NULL rows.
    await deleteByBusiness(tx, 'solicitation_consent', row.account_id);
    // Suppression ledger (migration 096, #643) — spec §6.3. Retention splits on
    // the Suppression scope axis (D7). Account-scoped (owner_manual) rows are
    // the account's own preference about their own customer: once purged, no
    // path exists to mail that person through this account, so nothing is
    // protected by keeping them. GLOBAL rows are deliberately untouched — they
    // are the recipient's revocation against our one shared sending identity
    // and survive with account_id intact, pointing at the already-tombstoned
    // accounts row (096 gives that FK no ON DELETE action on purpose).
    await tx`
      DELETE FROM solicitation_suppressions
      WHERE scope = 'account' AND account_id = ${row.account_id}::uuid
    `;
    // Unsubscribe token (migration 096, #643) — spec §6.3: scrub the
    // provenance, keep the mechanism. Redemption after the sender is gone still
    // writes a ledger row (§5.2); honouring the opt-out matters, knowing which
    // dead account minted the token does not.
    //
    // G12's implication CHECK means nulling account_id obliges business_id and
    // ask_id to be null too, so these three MUST go in ONE statement — nulling
    // account_id alone throws. outreach_id is deliberately absent: its own
    // ON DELETE SET NULL (G1) nulls it when the outreach row cascades away with
    // the upload deleted above, and it is excluded from the CHECK precisely so
    // that can happen independently.
    await tx`
      UPDATE solicitation_unsubscribe_tokens
      SET account_id = NULL,
          business_id = NULL,
          ask_id = NULL
      WHERE account_id = ${row.account_id}::uuid
         OR business_id IN (SELECT id FROM businesses WHERE account_id = ${row.account_id}::uuid)
    `;
    await deleteByBusiness(tx, 'approval_links', row.account_id);
    await deleteByBusiness(tx, 'responses', row.account_id);
    // Guardian escalations (migration 073): review_id FK has no cascade, so
    // these must go before the reviews delete. notification_deliveries.
    // escalation_id is ON DELETE SET NULL — deliveries purge independently —
    // and escalations.agent_run_id is likewise ON DELETE SET NULL, so deleting
    // escalations here (before the agent_runs delete below) is order-safe.
    await tx`
      DELETE FROM review_escalations
      WHERE account_id = ${row.account_id}::uuid
    `;
    await deleteByBusiness(tx, 'reviews', row.account_id);
    await deleteByBusiness(tx, 'weekly_summaries', row.account_id);
    await deleteByBusiness(tx, 'monthly_impact_emails', row.account_id);
    await deleteByBusiness(tx, 'ranking_snapshots', row.account_id);
    await deleteByBusiness(tx, 'competitor_snapshots', row.account_id);
    await deleteByBusiness(tx, 'onboarding_drip_log', row.account_id);
    await deleteByBusiness(tx, 'onboarding_demos', row.account_id);
    await deleteByBusiness(tx, 'satisfaction_responses', row.account_id);
    await deleteByBusiness(tx, 'google_connections', row.account_id);
    await tx`
      DELETE FROM prospect_demos
      WHERE created_by IN (
        SELECT id FROM users WHERE account_id = ${row.account_id}::uuid
      )
    `;
    // Agent run spine (migration 071): per-account attribution rows whose
    // subject/detail ids reference the reviews/responses deleted above.
    // Outcomes first (their agent_run_id FK is ON DELETE SET NULL — deleting
    // runs first would only orphan them), then runs; agent_run_steps needs no
    // explicit DELETE because its agent_runs FK is ON DELETE CASCADE.
    await tx`
      DELETE FROM agent_outcomes
      WHERE account_id = ${row.account_id}::uuid
    `;
    await tx`
      DELETE FROM agent_runs
      WHERE account_id = ${row.account_id}::uuid
    `;
  });
}

// Scrubs raw account-linked content out of the schemaless payload columns of
// inbound_events + job_outbox. Because those payloads are unstructured JSON, the
// scope identifiers are matched with a substring LIKE over payload::text rather
// than a structured key lookup. This is an accepted tradeoff: the identifiers are
// UUIDs / Stripe ids / Zernio ids (effectively unique high-entropy strings), so a
// cross-account false-positive scrub is vanishingly unlikely, and the verification
// twin (purge-verification.ts) checks the same scope shape on the read side so the
// purge cannot stamp purged_at while a matching raw identifier survives.
export async function runRawPayloadPurgeStage(
  sql: postgres.Sql,
  row: AccountOffboardingPurgeRow,
  currentOutboxId: string,
): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`
      WITH account_businesses AS (
        SELECT b.id::text AS id FROM businesses b WHERE b.account_id = ${row.account_id}::uuid
      ),
      onboarding_demo_scope AS (
        SELECT od.id::text AS identifier
        FROM onboarding_demos od
        JOIN businesses b ON b.id = od.business_id
        WHERE b.account_id = ${row.account_id}::uuid
      ),
      offboarding_scope AS (
        SELECT id::text AS identifier FROM account_businesses
        UNION ALL SELECT identifier FROM onboarding_demo_scope
        UNION ALL SELECT ${row.account_id}::text
        UNION ALL SELECT ${row.id}::text
        UNION ALL SELECT ${row.auth_user_id ?? null}::text
        UNION ALL SELECT ${row.stripe_customer_id ?? null}::text
        UNION ALL SELECT ${row.stripe_subscription_id ?? null}::text
        UNION ALL SELECT UNNEST(${row.zernio_account_ids ?? []}::text[])
        UNION ALL SELECT UNNEST(${row.zernio_profile_ids ?? []}::text[])
        UNION ALL
        SELECT auth_user_id FROM account_offboardings
        WHERE id = ${row.id}::uuid AND account_id = ${row.account_id}::uuid AND auth_user_id IS NOT NULL
        UNION ALL
        SELECT stripe_customer_id FROM account_offboardings
        WHERE id = ${row.id}::uuid AND account_id = ${row.account_id}::uuid AND stripe_customer_id IS NOT NULL
        UNION ALL
        SELECT stripe_subscription_id FROM account_offboardings
        WHERE id = ${row.id}::uuid AND account_id = ${row.account_id}::uuid AND stripe_subscription_id IS NOT NULL
        UNION ALL
        SELECT unnest(zernio_account_ids) FROM account_offboardings
        WHERE id = ${row.id}::uuid AND account_id = ${row.account_id}::uuid AND zernio_account_ids IS NOT NULL
        UNION ALL
        SELECT unnest(zernio_profile_ids) FROM account_offboardings
        WHERE id = ${row.id}::uuid AND account_id = ${row.account_id}::uuid AND zernio_profile_ids IS NOT NULL
      )
      UPDATE inbound_events
      SET external_event_key = 'scrubbed:' || id::text,
          aggregate_key = NULL,
          payload = '{}'::jsonb,
          error_message = NULL
      WHERE EXISTS (
        SELECT 1 FROM offboarding_scope s
        WHERE s.identifier IS NOT NULL
          AND length(btrim(s.identifier)) > 0
          AND (
            inbound_events.payload::text LIKE ('%' || s.identifier || '%')
            OR inbound_events.aggregate_key LIKE ('%' || s.identifier || '%')
            OR inbound_events.error_message LIKE ('%' || s.identifier || '%')
        )
      )
    `;
    const scopedOutboxRows = await tx<{ id: string }[]>`
      WITH account_businesses AS (
        SELECT b.id::text AS id FROM businesses b WHERE b.account_id = ${row.account_id}::uuid
      ),
      onboarding_demo_scope AS (
        SELECT od.id::text AS identifier
        FROM onboarding_demos od
        JOIN businesses b ON b.id = od.business_id
        WHERE b.account_id = ${row.account_id}::uuid
      ),
      offboarding_scope AS (
        SELECT id::text AS identifier FROM account_businesses
        UNION ALL SELECT identifier FROM onboarding_demo_scope
        UNION ALL SELECT ${row.account_id}::text
        UNION ALL SELECT ${row.id}::text
        UNION ALL SELECT ${row.auth_user_id ?? null}::text
        UNION ALL SELECT ${row.stripe_customer_id ?? null}::text
        UNION ALL SELECT ${row.stripe_subscription_id ?? null}::text
        UNION ALL SELECT UNNEST(${row.zernio_account_ids ?? []}::text[])
        UNION ALL SELECT UNNEST(${row.zernio_profile_ids ?? []}::text[])
      )
      SELECT id
      FROM job_outbox
      WHERE EXISTS (
        SELECT 1 FROM offboarding_scope s
        WHERE s.identifier IS NOT NULL
          AND length(btrim(s.identifier)) > 0
          AND (
            job_outbox.payload::text LIKE ('%' || s.identifier || '%')
            OR job_outbox.aggregate_id::text = s.identifier
            OR job_outbox.last_error LIKE ('%' || s.identifier || '%')
          )
      )
        AND job_outbox.id <> ${currentOutboxId}::uuid
    `;

    if (scopedOutboxRows.length > 0) {
      await tx`
        UPDATE account_offboardings
        SET provider_dispositions = provider_dispositions || ${tx.json(scopedOutboxRows.map(jobOutboxScrubScopeRecord) as never)},
            updated_at = NOW()
        WHERE id = ${row.id}::uuid
          AND account_id = ${row.account_id}::uuid
          AND terminal_at IS NULL
      `;
      await tx`
        UPDATE job_outbox
        SET aggregate_id = NULL,
            payload = '{}'::jsonb,
            last_error = NULL,
            status = CASE
              WHEN status IN ('pending', 'dispatching', 'dispatched') THEN 'completed'
              ELSE status
            END,
            completed_at = CASE
              WHEN status IN ('pending', 'dispatching', 'dispatched') THEN COALESCE(completed_at, NOW())
              ELSE completed_at
            END
        WHERE id = ANY(${scopedOutboxRows.map((entry) => entry.id)}::uuid[])
      `;
    }
  });
}

export async function runAnalyticsPurgeStage(sql: postgres.Sql, row: AccountOffboardingPurgeRow): Promise<void> {
  // One scrub over a single account-scope predicate: every analytics row owned by this
  // account by FK (account/business/user) OR by a raw account identifier still sitting in
  // `distinct_id` (the FK-independent case the unenforced "raw UUID implies FK" invariant
  // used to miss). This predicate is the write-side twin of the post-purge read-side check
  // in `purge-verification.ts` (`account_id IS NULL ... distinct_id IN`); keep the two in
  // sync — a divergence is what previously let scrubbed-distinct_id rows survive (M1).
  await sql`
    UPDATE analytics_events
    SET event_key = 'scrubbed:' || id::text,
        distinct_id = 'scrubbed:' || id::text,
        anonymous_id = NULL,
        account_id = NULL,
        user_id = NULL,
        business_id = NULL,
        properties = '{}'::jsonb,
        last_error = NULL
    WHERE account_id = ${row.account_id}::uuid
       OR business_id IN (SELECT id FROM businesses WHERE account_id = ${row.account_id}::uuid)
       OR user_id IN (SELECT id FROM users WHERE account_id = ${row.account_id}::uuid)
       OR distinct_id IN (${row.account_id}, ${`account:${row.account_id}`})
  `;
}

export async function runProviderIdentifierPurgeStage(sql: postgres.Sql, row: AccountOffboardingPurgeRow): Promise<void> {
  await sql.begin(async (tx) => {
    // Sequential awaits share one Postgres.js transaction connection (sql.begin); they execute
    // serially on a single connection and cannot be parallelized.
    // react-doctor-disable-next-line react-doctor/async-parallel
    await deleteByBusiness(tx, 'zernio_connections', row.account_id);
    await tx`
      UPDATE zernio_finalize_incidents zfi
      SET zernio_profile_id = 'scrubbed:' || zfi.id::text,
          flow_id = 'scrubbed:' || zfi.id::text,
          zernio_account_id = NULL,
          zernio_location_id = NULL,
          resolution_notes = NULL,
          updated_at = NOW()
      FROM businesses b
      WHERE zfi.business_id = b.id
        AND b.account_id = ${row.account_id}::uuid
    `;
    await tx`
      UPDATE zernio_backfill_runs zbr
      SET zernio_account_id = 'scrubbed:' || zbr.id::text,
          zernio_location_id = 'scrubbed:' || zbr.id::text,
          updated_at = NOW()
      FROM businesses b
      WHERE zbr.business_id = b.id
        AND b.account_id = ${row.account_id}::uuid
    `;
    await tx`
      DELETE FROM channel_enrollments
      WHERE account_id = ${row.account_id}::uuid
    `;
    await tx`
      DELETE FROM auto_approval_policies
      WHERE account_id = ${row.account_id}::uuid
    `;
    await tx`
      DELETE FROM api_costs_daily_rollups acdr
      USING businesses b
      WHERE acdr.business_id = b.id
        AND b.account_id = ${row.account_id}::uuid
    `;
  });
}

export async function runAuditAndCostPayloadPurgeStage(sql: postgres.Sql, row: AccountOffboardingPurgeRow): Promise<void> {
  await sql.begin(async (tx) => {
    const impersonationSessionIds = await scopedImpersonationSessionIds(tx, row);
    await tx`
      UPDATE account_audit_log
      SET location_id = NULL,
          actor_user_id = NULL,
          payload = '{}'::jsonb,
          entity_id = NULL,
          ip = NULL,
          user_agent = NULL,
          request_id = NULL
      WHERE account_id = ${row.account_id}::uuid
    `;
    if (impersonationSessionIds.length > 0) {
      await tx`
        UPDATE account_offboardings
        SET provider_dispositions = provider_dispositions || ${tx.json(impersonationSessionIds.map(impersonationSessionScrubScopeRecord) as never)},
            updated_at = NOW()
        WHERE id = ${row.id}::uuid
          AND account_id = ${row.account_id}::uuid
          AND terminal_at IS NULL
      `;
      await tx`
        UPDATE impersonation_sessions
        SET ticket_id = 'scrubbed:' || id::text,
            reason = 'account purged',
            account_id = NULL,
            impersonated_user_id = NULL,
            ended_at = COALESCE(ended_at, NOW())
        WHERE id = ANY(${impersonationSessionIds}::uuid[])
      `;
    }
  });
}

export async function runParentTombstonePurgeStage(sql: postgres.Sql, row: AccountOffboardingPurgeRow): Promise<void> {
  await sql.begin(async (tx) => {
    // Sequential awaits share one Postgres.js transaction connection (sql.begin) and tombstone
    // account-scoped rows ending on the shared accounts row; parallel = lock contention/deadlock.
    // react-doctor-disable-next-line react-doctor/async-parallel
    await tx`
      UPDATE users
      SET name = 'Deleted user',
          email = 'deleted-' || id::text || '@repworth.invalid',
          phone = NULL,
          auth_id = NULL,
          updated_at = NOW()
      WHERE account_id = ${row.account_id}::uuid
    `;
    await tx`
      UPDATE businesses
      SET name = 'Deleted location',
          category = NULL,
          google_place_id = NULL,
          google_maps_url = NULL,
          tone = 'professional and friendly',
          products_services = NULL,
          staff_names = NULL,
          highlight_facts = NULL,
          avoid_facts = NULL,
          sample_responses = NULL,
          owner_name = 'Deleted owner',
          owner_email = 'deleted-' || id::text || '@repworth.invalid',
          owner_phone = NULL,
          stripe_customer_id = NULL,
          stripe_subscription_id = NULL,
          tracked_keywords = '[]'::jsonb,
          google_place_address = NULL,
          google_place_lat = NULL,
          google_place_lng = NULL,
          ranking_search_location = NULL,
          website = NULL,
          display_label = NULL,
          archived_at = COALESCE(archived_at, NOW()),
          updated_at = NOW()
      WHERE account_id = ${row.account_id}::uuid
    `;
    await tx`
      UPDATE accounts
      SET display_name = 'Deleted account',
          stripe_customer_id = NULL,
          stripe_subscription_id = NULL,
          flags = '{}'::jsonb,
          updated_at = NOW()
      WHERE id = ${row.account_id}::uuid
    `;
  });
}

export async function finalizePurgeInTransaction(
  sql: postgres.Sql,
  row: AccountOffboardingPurgeRow,
  outboxId: string,
  outboxAttempt: number | undefined,
): Promise<void> {
  await sql.begin(async (tx) => {
    // Sequential awaits share one Postgres.js transaction connection (sql.begin);
    // they cannot run in parallel and ordering (lock → scrub → verify → finalize) is load-bearing.
    // react-doctor-disable-next-line react-doctor/async-parallel
    await lockCurrentOutboxAttempt(tx, outboxId, outboxAttempt);

    await tx`
      UPDATE job_outbox
      SET aggregate_id = NULL,
          payload = ${tx.json({} as never)},
          last_error = NULL
      WHERE id = ${outboxId}::uuid
    `;

    await scrubLifecycleReceiptInTransaction(tx, row);

    const verification = await verifyAccountOffboardingPurge(
      {
        accountId: row.account_id,
        offboardingId: row.id,
        currentOutboxId: outboxId,
        authUserId: row.auth_user_id,
        stripeCustomerId: row.stripe_customer_id,
        stripeSubscriptionId: row.stripe_subscription_id,
        zernioAccountIds: row.zernio_account_ids,
        zernioProfileIds: row.zernio_profile_ids,
      },
      tx,
    );
    if (!verification.ok) {
      throw new Error(
        `account_offboarding_purge_verification_failed:${verification.issues
          .map((issue) => issue.table)
          .join(',')}`,
      );
    }

    const [updated] = await tx<{ id: string }[]>`
      UPDATE account_offboardings
      SET status = 'purged',
          purged_at = NOW(),
          terminal_at = COALESCE(terminal_at, NOW()),
          failed_step = NULL,
          last_error = NULL,
          updated_at = NOW()
      WHERE id = ${row.id}::uuid
        AND account_id = ${row.account_id}::uuid
        AND status = 'purge_scheduled'
        AND terminal_at IS NULL
        AND recipient_email IS NULL
        AND stripe_customer_id IS NULL
        AND stripe_subscription_id IS NULL
        AND zernio_account_ids IS NULL
        AND zernio_profile_ids IS NULL
        AND auth_user_id IS NULL
      RETURNING id
    `;

    if (!updated) {
      throw new Error('account_offboarding_purge_finalize_precondition_failed');
    }

    await enqueueOffboardingPurged(tx, {
      offboardingId: row.id,
    });

    // Durable purge receipt: enqueue inside the finalize tx so a crash after
    // commit cannot lose it (the prior best-effort post-commit send could). The
    // recipient is carried in the outbox payload because the row's
    // recipient_email is scrubbed in this same transaction; the email worker
    // sends it and scrubs the payload afterwards.
    //
    // ACCEPTED RESIDUAL (M4): this means a single raw owner email lives in
    // job_outbox.payload past the purged_at stamp — sending the final "your data
    // was deleted" notice inherently requires retaining the address until it is
    // sent, and the account row is tombstoned so it cannot be re-derived. The
    // window is bounded by the outbox dispatch + BullMQ retry guarantee, and the
    // email worker scrubs the payload atomically on completion. The verification
    // gate above intentionally does not scan for this (it would never allow the
    // receipt to be sent). The only way it persists is a permanently-undeliverable
    // receipt; the outbox failure surface is the place to detect that.
    const recipient = row.recipient_email?.trim();
    if (recipient) {
      await enqueueAccountOffboardingEmail(tx, {
        accountOffboardingId: row.id,
        accountId: row.account_id,
        emailType: 'purge_receipt',
        recipientEmail: recipient,
        purgedAt: new Date().toISOString(),
      });
    }

    await completeCurrentOutboxAttempt(tx, outboxId, outboxAttempt);
  });
}

async function lockCurrentOutboxAttempt(
  tx: postgres.TransactionSql,
  outboxId: string,
  outboxAttempt: number | undefined,
): Promise<void> {
  const [row] = typeof outboxAttempt === 'number' && Number.isFinite(outboxAttempt)
    ? await tx<{ id: string }[]>`
        SELECT id
        FROM job_outbox
        WHERE id = ${outboxId}::uuid
          AND status = 'dispatched'
          AND attempts = ${outboxAttempt}
        FOR UPDATE
      `
    : await tx<{ id: string }[]>`
        SELECT id
        FROM job_outbox
        WHERE id = ${outboxId}::uuid
          AND status = 'dispatched'
        FOR UPDATE
      `;

  if (!row) {
    throw new StaleOutboxAttemptError();
  }
}

async function scrubLifecycleReceiptInTransaction(
  exec: postgres.Sql | postgres.TransactionSql,
  row: AccountOffboardingPurgeRow,
): Promise<void> {
  await exec`
    UPDATE account_offboardings
    SET recipient_email = NULL,
        stripe_customer_id = NULL,
        stripe_subscription_id = NULL,
        zernio_account_ids = NULL,
        zernio_profile_ids = NULL,
        auth_user_id = NULL,
        last_error = NULL,
        updated_at = NOW()
    WHERE id = ${row.id}::uuid
      AND account_id = ${row.account_id}::uuid
      AND terminal_at IS NULL
  `;
}

async function completeCurrentOutboxAttempt(
  tx: postgres.TransactionSql,
  outboxId: string,
  outboxAttempt: number | undefined,
): Promise<void> {
  const [row] = typeof outboxAttempt === 'number' && Number.isFinite(outboxAttempt)
    ? await tx<{ id: string }[]>`
        UPDATE job_outbox
        SET status = 'completed',
            completed_at = NOW()
        WHERE id = ${outboxId}::uuid
          AND status = 'dispatched'
          AND attempts = ${outboxAttempt}
        RETURNING id
      `
    : await tx<{ id: string }[]>`
        UPDATE job_outbox
        SET status = 'completed',
            completed_at = NOW()
        WHERE id = ${outboxId}::uuid
          AND status = 'dispatched'
        RETURNING id
      `;

  if (!row) {
    throw new StaleOutboxAttemptError();
  }
}

export async function markPurgeRetryableFailure(
  sql: postgres.Sql,
  row: AccountOffboardingPurgeRow,
  safeMessage: string,
): Promise<void> {
  await sql`
    UPDATE account_offboardings
    SET last_error = ${safeMessage},
        retry_count = retry_count + 1,
        updated_at = NOW()
    WHERE id = ${row.id}::uuid
      AND account_id = ${row.account_id}::uuid
      AND status = 'purge_scheduled'
      AND terminal_at IS NULL
  `;
}

export async function markPurgeTerminalFailure(
  sql: postgres.Sql,
  row: AccountOffboardingPurgeRow,
  safeMessage: string,
): Promise<void> {
  await sql`
    UPDATE account_offboardings
    SET status = 'failed',
        failed_step = 'purge',
        last_error = ${safeMessage},
        retry_count = retry_count + 1,
        updated_at = NOW()
    WHERE id = ${row.id}::uuid
      AND account_id = ${row.account_id}::uuid
      AND terminal_at IS NULL
  `;
}

async function scopedImpersonationSessionIds(
  tx: postgres.TransactionSql,
  row: AccountOffboardingPurgeRow,
): Promise<string[]> {
  const rows = await tx<{ id: string }[]>`
    SELECT DISTINCT s.id
    FROM impersonation_sessions s
    WHERE s.account_id = ${row.account_id}::uuid
       OR s.impersonated_user_id IN (
         SELECT id FROM users WHERE account_id = ${row.account_id}::uuid
       )
  `;
  return rows.map((entry) => entry.id);
}
