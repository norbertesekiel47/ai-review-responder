import { randomUUID } from 'node:crypto';
import { REFUSAL_LEDGER_FLAG } from '@/lib/refusals/write';
import { REVIEW_STATUS } from '@/lib/reviews/status';
import { insertOutreach } from '@/lib/shared/__tests__/helpers/outreach-fixture';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import postgres from 'postgres';
import type postgresType from 'postgres';
import { describeWithDb } from '@/__tests__/helpers/describe-with-db';
import { startOrGetActiveRun } from '@/lib/agents/run-spine';
import {
  cleanupTenantAccount,
  seedLocation,
  seedTenantAccount,
  type TenantSeed,
} from '@/lib/shared/__tests__/live-db-tenant';
import {
  acquireLiveDbLock,
  assertLocalTestDatabaseUrl,
  LIVE_DB_LOCK_HOOK_TIMEOUT_MS,
  resolveTestDatabaseUrl,
  type LiveDbLock,
} from '@/lib/shared/__tests__/helpers/live-db-lock';
import {
  assertSchemaReady,
  MIGRATION_071_RUN_SPINE,
  MIGRATION_088_SOLICITATION_BATCH_EXECUTOR,
  MIGRATION_093_SOLICITATION_CONSENT,
  MIGRATION_096_SOLICITATION_SUPPRESSIONS,
  MIGRATION_099_SOLICITATION_POSTAL_ADDRESS,
} from '@/lib/shared/__tests__/helpers/schema-ready';
import { enqueueGenerateSolicitationAsks } from '@/lib/shared/job-outbox-helpers';
import { QUEUE_NAMES } from '@/lib/shared/queue-names';
import type { BuildSolicitationBatchPayload } from '@/lib/shared/worker-types';
import { handleSolicitationBatchFailed } from '../../../../worker/jobs/solicitation-batch/failed-hook';
import { ASK_WITHHELD_REFUSAL_CATEGORIES } from '@/lib/refusals/vocabulary';
import { CONSENT_ATTESTATION_VERSION } from '../attestation';
import { acquireSolicitationBatchLock, buildSolicitationBatch } from '../batch-builder';
import { readLatestBatch } from '../batch-view';
import { ingestContactsCsvUpload } from '../ingest';
import { POSTAL_ADDRESS_ATTESTATION_VERSION } from '../postal-address';
import {
  BATCH_CAP,
  FRESHNESS_WINDOW_DAYS,
  MIN_GAP_DAYS,
  WITHHOLD_REASONS,
  type WithholdReason,
} from '../restraint-policy';
import { recordSuppression, type SuppressionSource } from '../suppression';

/**
 * #656 T6 — the only way to prove "a send-handoff enqueue failure rolls back the
 * batch build" is to make that one enqueue fail, and nothing in the schema can
 * be nudged into failing it on demand. Every other case in this suite runs the
 * REAL helper against the REAL migration-091 partial index — the dedup case
 * below depends on the live planner inferring it — so this wrapper delegates by
 * default and throws only while a test has armed `enqueueFailure.error`.
 */
const enqueueFailure = vi.hoisted(() => ({ error: null as Error | null }));

vi.mock('@/lib/shared/job-outbox-helpers', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/shared/job-outbox-helpers')>();
  return {
    ...actual,
    enqueueGenerateSolicitationAsks: async (
      ...args: Parameters<typeof actual.enqueueGenerateSolicitationAsks>
    ): Promise<string | null> => {
      if (enqueueFailure.error !== null) throw enqueueFailure.error;
      return actual.enqueueGenerateSolicitationAsks(...args);
    },
  };
});

// ── #1010 T3: the `ask_withheld` lane's Refusal write site ──────────────────
//
// WHY THE VOCABULARY MODULE IS MOCKED. One case here has to force a REAL ledger
// rejection from the REAL helper inside the REAL batch-build transaction — a
// mocked-away writer would prove only that a stub can reject, and every other
// case in this file supplies valid input. Bending ONE map entry to a category
// migration 116's CHECK does not admit makes the set INSERT violate
// `refusal_events_refusal_category_check`, which is exactly the writer bug the
// design says must abort the decision rather than be caught.
//
// The stand-in map is DERIVED from the real one inside the factory, never
// re-typed: every other case must run against the production vocabulary, and a
// hand-copied map here would be a second authority over the same six reasons.
// Same shape as `src/lib/auto-approval/__tests__/suspension.integration.test.ts`.
const { askWithheldCategories } = vi.hoisted(() => ({
  askWithheldCategories: {} as Record<string, string | null>,
}));

vi.mock('@/lib/refusals/vocabulary', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/refusals/vocabulary')>();
  Object.assign(askWithheldCategories, actual.ASK_WITHHELD_REFUSAL_CATEGORIES);
  return { ...actual, ASK_WITHHELD_REFUSAL_CATEGORIES: askWithheldCategories };
});

/** The default-ON kill switch. Only the literal string 'false' disables it. */

/** Postgres' CHECK-violation SQLSTATE. */
const CHECK_VIOLATION = '23514';

const testDatabaseUrl = resolveTestDatabaseUrl();
const businessId = randomUUID();
let db: postgresType.Sql | undefined;
let featureDatabaseLock: LiveDbLock | undefined;
let tenant: TenantSeed | undefined;

function sql(): postgresType.Sql {
  if (!db) throw new Error('batch-builder integration database was not initialized');
  return db;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function assertStillBlocked(promise: Promise<unknown>): Promise<void> {
  const outcome = await Promise.race([
    promise.then(() => 'completed', () => 'rejected'),
    new Promise<'blocked'>((resolveBlocked) => {
      setTimeout(() => resolveBlocked('blocked'), 150);
    }),
  ]);
  expect(outcome).toBe('blocked');
}

async function seedCompletedUpload(forBusinessId: string = businessId): Promise<string> {
  const uploadId = randomUUID();
  await sql()`
    INSERT INTO contact_csv_uploads (
      id, account_id, business_id, filename, byte_size, content_sha256,
      raw_csv, status, report, attested_by_user_id, attested_at,
      attestation_version, completed_at
    ) VALUES (
      ${uploadId}::uuid, ${tenant!.accountId}::uuid, ${forBusinessId}::uuid,
      'batch-builder.csv', 1, ${uploadId.replaceAll('-', '').padEnd(64, '0').slice(0, 64)},
      NULL, 'completed', ${sql().json({ accepted: 0 })},
      ${tenant!.userId}::uuid, NOW(), ${CONSENT_ATTESTATION_VERSION}, NOW()
    )
  `;
  return uploadId;
}

/** Mirrors the ingest ledger write (#625) so directly-seeded candidates stay
 *  send-eligible: consent now derives from `solicitation_consent`, not the
 *  upload row, so a contact seeded without a ledger row withholds no_consent. */
async function seedConsent(
  normalizedEmail: string,
  uploadId: string,
): Promise<void> {
  await sql()`
    INSERT INTO solicitation_consent (
      id, channel, normalized_handle, business_id, basis,
      attestation_version, attested_at, attested_by_user_id, source_upload_id
    ) VALUES (
      ${randomUUID()}::uuid, 'email', ${normalizedEmail}, ${businessId}::uuid,
      'owner_attested', ${CONSENT_ATTESTATION_VERSION}, NOW(),
      ${tenant!.userId}::uuid, ${uploadId}::uuid
    )
  `;
}

/** The Normalized handle `seedContact` stores — the ledger's join key (§1.1). */
function contactEmail(contactId: string): string {
  return `${contactId}@example.test`;
}

async function seedContact(
  uploadId: string,
  visitDate: string,
  options: { consent?: boolean } = {},
): Promise<string> {
  const contactId = randomUUID();
  const email = contactEmail(contactId);
  await sql()`
    INSERT INTO solicitation_contacts (
      id, business_id, name, email, created_by_upload_id
    ) VALUES (
      ${contactId}::uuid, ${businessId}::uuid, 'Batch Candidate',
      ${email}, ${uploadId}::uuid
    )
  `;
  await sql()`
    INSERT INTO solicitation_visits (
      id, contact_id, business_id, visit_date, upload_id
    ) VALUES (
      ${randomUUID()}::uuid, ${contactId}::uuid, ${businessId}::uuid,
      ${visitDate}::date, ${uploadId}::uuid
    )
  `;
  if (options.consent !== false) await seedConsent(email, uploadId);
  return contactId;
}

/**
 * Every Normalized handle this suite has written to the Suppression ledger.
 * Swept explicitly: a ledger row has no expiry and no ordinary delete path, and
 * `account_id` is a NO-ACTION FK to `accounts`, so a leaked row would outlive
 * the suite AND block `cleanupTenantAccount`.
 */
const suppressedHandles = new Set<string>();

/**
 * Writes one Suppression ledger row through the production writer — a fixture
 * built by hand could carry a source/scope pairing the writer can never emit —
 * and returns its `suppressed_at` exactly as the database renders it, which is
 * what the populate seam must surface into evidence.
 */
async function suppressHandle(
  handle: string,
  source: Exclude<SuppressionSource, 'owner_manual' | 'admin_manual'>,
): Promise<string> {
  suppressedHandles.add(handle);
  const suppressionId = await sql().begin(async (tx) =>
    recordSuppression(tx, {
      scope: 'global',
      channel: 'email',
      normalizedHandle: handle,
      accountId: tenant!.accountId,
      source,
    }),
  );
  if (suppressionId === null) {
    throw new Error(`expected a new Suppression ledger row for ${handle}`);
  }
  const [row] = await sql()<{ suppressed_at: string }[]>`
    SELECT suppressed_at::text AS suppressed_at
    FROM solicitation_suppressions
    WHERE id = ${suppressionId}::uuid
  `;
  return row!.suppressed_at;
}

async function sweepSuppressionFixtures(): Promise<void> {
  if (suppressedHandles.size === 0) return;
  const handles = [...suppressedHandles];
  suppressedHandles.clear();
  await sql()`
    DELETE FROM analytics_events
    WHERE event_name = 'solicitation_suppressed'
      AND account_id = ${tenant!.accountId}::uuid
  `;
  await sql()`
    DELETE FROM solicitation_suppressions
    WHERE normalized_handle = ANY(${handles}::text[])
  `;
}

const CSV_HEADER = 'name,email,phone,last_visit_date,note';

function daysAgoUtc(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

/** A 'pending' upload carrying raw CSV, ready for the REAL ingest path —
 *  the consent ledger is written only by ingestContactsCsvUpload (D8). */
async function seedPendingUpload(
  csvText: string,
  options: { attestationVersion?: string; attestedAgo?: string; forBusinessId?: string } = {},
): Promise<string> {
  const uploadId = randomUUID();
  const attestedAtExpr = options.attestedAgo === undefined
    ? sql()`NOW()`
    : sql()`NOW() - ${options.attestedAgo}::interval`;
  await sql()`
    INSERT INTO contact_csv_uploads (
      id, account_id, business_id, filename, byte_size, content_sha256,
      raw_csv, status, attested_by_user_id, attested_at, attestation_version
    ) VALUES (
      ${uploadId}::uuid, ${tenant!.accountId}::uuid,
      ${options.forBusinessId ?? businessId}::uuid,
      'customers.csv', ${Buffer.byteLength(csvText, 'utf8')},
      ${uploadId.replaceAll('-', '').padEnd(64, '0').slice(0, 64)},
      ${csvText}, 'pending', ${tenant!.userId}::uuid,
      ${attestedAtExpr}, ${options.attestationVersion ?? CONSENT_ATTESTATION_VERSION}
    )
  `;
  return uploadId;
}

interface StoredAskRow {
  contact_id: string;
  status: string;
  withheld_reason: string | null;
  evidence: unknown;
}

async function readAsks(batchId: string): Promise<StoredAskRow[]> {
  return sql()<StoredAskRow[]>`
    SELECT contact_id::text AS contact_id, status, withheld_reason, evidence
    FROM solicitation_asks
    WHERE batch_id = ${batchId}::uuid
    ORDER BY contact_id
  `;
}

function parseAskEvidence(value: unknown): Record<string, unknown> {
  const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error('expected stored ask evidence to be an object');
  }
  return parsed as Record<string, unknown>;
}

interface SeedBatchResult {
  batchId: string;
  outboxId: string;
  attempt: number;
}

async function seedBatch(attempt = 1, forBusinessId: string = businessId): Promise<SeedBatchResult> {
  const batchId = randomUUID();
  const outboxId = randomUUID();
  const sourceUploadId = await seedCompletedUpload(forBusinessId);
  await sql()`
    INSERT INTO solicitation_batches (
      id, account_id, business_id, source_upload_id
    ) VALUES (
      ${batchId}::uuid, ${tenant!.accountId}::uuid,
      ${forBusinessId}::uuid, ${sourceUploadId}::uuid
    )
  `;
  await sql()`
    INSERT INTO job_outbox (
      id, topic, aggregate_type, aggregate_id, payload,
      status, attempts, dispatched_at
    ) VALUES (
      ${outboxId}::uuid, ${QUEUE_NAMES.BUILD_SOLICITATION_BATCH},
      'solicitation_batch', ${batchId}::uuid,
      ${sql().json({ batch_id: batchId, business_id: forBusinessId })},
      'dispatched', ${attempt}, NOW()
    )
  `;
  return { batchId, outboxId, attempt };
}

async function build(batch: SeedBatchResult, forBusinessId: string = businessId) {
  return buildSolicitationBatch(sql(), {
    batchId: batch.batchId,
    businessId: forBusinessId,
    outboxId: batch.outboxId,
    attempt: batch.attempt,
    correlationId: 'batch-builder-integration',
  });
}

/** Narrows the build union so a case can read `sendHandoff` without `?.`, and
 *  fails loudly with the actual status when the build did not happen at all. */
function builtBatch(
  result: Awaited<ReturnType<typeof build>>,
): Extract<Awaited<ReturnType<typeof build>>, { status: 'built' }> {
  if (result.status !== 'built') {
    throw new Error(`expected a built batch, got status '${result.status}'`);
  }
  return result;
}

/** The **Attested postal address** these cases write. Two non-empty lines with
 *  a ZIP on the last one — the shape `lintPostalAddress` accepts. */
const FIXTURE_POSTAL_ADDRESS = '123 Main St\nAustin, TX 78701';

/** A canonical Google Place ID (base64url, 20+ chars) — passes `isPlaceId`. */
const FIXTURE_GOOGLE_PLACE_ID = 'ChIJN1t_tDeuEmsRUsoyG83frY4';

/**
 * Writes the whole migration-099 attestation tuple straight onto the shared
 * fixture business. Deliberately raw SQL rather than `attestPostalAddress`:
 * this suite's subject is the batch builder, and routing the fixture through
 * another module's writer would make these cases fail for that module's
 * reasons. The digest is computed by the same server-side expression 099's
 * CHECK recomputes, so the row is legal by construction — a hand-written digest
 * would be rejected.
 */
async function attestFixturePostalAddress(): Promise<void> {
  await sql()`
    UPDATE businesses
    SET solicitation_postal_address = ${FIXTURE_POSTAL_ADDRESS},
        solicitation_postal_address_attested_at = NOW(),
        solicitation_postal_address_attested_by_user_id = ${tenant!.userId}::uuid,
        solicitation_postal_address_attestation_version =
          ${POSTAL_ADDRESS_ATTESTATION_VERSION},
        solicitation_postal_address_attested_digest =
          encode(sha256(convert_to(${FIXTURE_POSTAL_ADDRESS}::text, 'UTF8')), 'hex')
    WHERE id = ${businessId}::uuid
  `;
}

async function setFixtureOwnerEmailBounced(bounced: boolean): Promise<void> {
  await sql()`
    UPDATE businesses
    SET owner_email_bounced = ${bounced}
    WHERE id = ${businessId}::uuid
  `;
}

async function setFixtureGooglePlaceId(placeId: string | null): Promise<void> {
  await sql()`
    UPDATE businesses
    SET google_place_id = ${placeId}
    WHERE id = ${businessId}::uuid
  `;
}

/**
 * Back to the `beforeAll` shape — unattested address, deliverable owner email.
 * Runs in `afterEach` because the fixture business is SHARED across every case
 * in this suite: without it a withheld-path case would leak its state into the
 * next test's send and turn a real regression into a green run.
 */
async function resetFixturePostalAddress(): Promise<void> {
  await sql()`
    UPDATE businesses
    SET solicitation_postal_address = NULL,
        solicitation_postal_address_attested_at = NULL,
        solicitation_postal_address_attested_by_user_id = NULL,
        solicitation_postal_address_attestation_version = NULL,
        solicitation_postal_address_attested_digest = NULL,
        owner_email_bounced = FALSE,
        google_place_id = ${FIXTURE_GOOGLE_PLACE_ID}
    WHERE id = ${businessId}::uuid
  `;
}

async function readGenerationOutboxRows(
  batchId: string,
): Promise<{ status: string }[]> {
  return sql()<{ status: string }[]>`
    SELECT status
    FROM job_outbox
    WHERE topic = ${QUEUE_NAMES.GENERATE_SOLICITATION_ASKS}
      AND aggregate_id = ${batchId}::uuid
  `;
}

async function readBuiltAt(batchId: string): Promise<string | null> {
  const [row] = await sql()<{ built_at: string | null }[]>`
    SELECT built_at::text AS built_at
    FROM solicitation_batches
    WHERE id = ${batchId}::uuid
  `;
  if (!row) throw new Error(`batch ${batchId} was not found`);
  return row.built_at;
}

async function seedParentRun(batchId: string): Promise<string> {
  return sql().begin(async (tx) => {
    const parent = await startOrGetActiveRun(tx, {
      kind: 'solicitation_batch',
      subjectType: 'solicitation_batch',
      subjectId: batchId,
      accountId: tenant!.accountId,
      businessId,
      correlationId: 'batch-builder-integration-parent',
    });
    return parent.runId;
  });
}

async function seedPriorAsk(input: {
  contactId: string;
  status: 'send' | 'withhold';
  decidedAt: string;
  withheldReason?: 'velocity_banked';
}): Promise<{ askId: string; batchId: string }> {
  const historical = await seedBatch();
  const askId = randomUUID();
  await sql()`
    UPDATE solicitation_batches
    SET created_at = ${input.decidedAt}::timestamptz - INTERVAL '1 second',
        built_at = ${input.decidedAt}::timestamptz
    WHERE id = ${historical.batchId}::uuid
  `;
  await sql()`
    UPDATE job_outbox
    SET status = 'completed', completed_at = NOW()
    WHERE id = ${historical.outboxId}::uuid
  `;
  await sql()`
    INSERT INTO solicitation_asks (
      id, account_id, business_id, batch_id, contact_id, status,
      withheld_reason, evidence, decided_at
    ) VALUES (
      ${askId}::uuid, ${tenant!.accountId}::uuid, ${businessId}::uuid,
      ${historical.batchId}::uuid, ${input.contactId}::uuid, ${input.status},
      ${input.withheldReason ?? null},
      ${sql().json({
        contact_id: input.contactId,
        policy_version: 'fixture',
        decided_at: input.decidedAt,
        decision: input.status,
        ...(input.withheldReason ? { reason: input.withheldReason } : {}),
      })},
      ${input.decidedAt}::timestamptz
    )
  `;
  return { askId, batchId: historical.batchId };
}

/** Retained attribution uses the existing ask and outreach fixture seams. */
async function seedAttributedReview(
  contactId: string,
  options: { reviewBusinessId?: string; ageDays?: number; reviewDate?: string | null } = {},
): Promise<{ reviewId: string; outreachId: string; reviewDate: string | null }> {
  const ageDays = options.ageDays ?? 60;
  const prior = await seedPriorAsk({
    contactId, status: 'send', decidedAt: `${daysAgoUtc(ageDays + 1)}T00:00:00Z`,
  });
  const outreachId = await insertOutreach(sql(), {
    accountId: tenant!.accountId, businessId, ...prior, contactId,
    deliveryStatus: 'sent',
    queuedAt: sql()`NOW() - make_interval(days => ${ageDays + 1})`,
    sentAt: sql()`NOW() - make_interval(days => ${ageDays + 1})`,
  });
  const reviewId = randomUUID();
  const [review] = await sql()<{ review_date: string | null }[]>`
    INSERT INTO reviews (
      id, business_id, provider, provider_review_id, provider_review_name,
      provider_location_name, reviewer_name, star_rating, review_text,
      review_date, detected_at, status
    ) VALUES (
      ${reviewId}::uuid, ${options.reviewBusinessId ?? businessId}::uuid,
      'zernio', ${reviewId}, ${`zernio://batch-1048/reviews/${reviewId}`},
      'zernio://batch-1048/locations/1', 'Batch Candidate', 5, 'Fixture review',
      ${options.reviewDate === undefined ? daysAgoUtc(ageDays) : options.reviewDate}::timestamptz,
      NOW(), ${REVIEW_STATUS.NEW}
    ) RETURNING review_date::text AS review_date
  `;
  await sql()`
    UPDATE solicitation_outreach
    SET attributed_review_id = ${reviewId}::uuid,
        attributed_at = NOW() - make_interval(days => ${ageDays}),
        attribution_rule = 'full_name', attribution_detail = '{}'::jsonb
    WHERE id = ${outreachId}::uuid
  `;
  return { reviewId, outreachId, reviewDate: review!.review_date };
}

// ── #1010 T3 fixtures: the Refusal ledger ───────────────────────────────────

interface RefusalRow {
  account_id: string;
  business_id: string | null;
  refusal_source: string;
  refusal_code: string | null;
  all_refusal_codes: string[] | null;
  refusal_category: string;
  vocabulary_version: string;
  subject_type: string | null;
  subject_id: string | null;
  occurred_at: string;
  created_at: string;
}

/**
 * Every Refusal this account carries, ordered by subject so a set comparison is
 * stable. Read as `::text` throughout: postgres.js decodes `timestamptz` to a JS
 * `Date` and TRUNCATES microseconds (#520), and the equality this lane claims
 * against `solicitation_asks.decided_at` lives in those digits.
 */
async function readRefusals(): Promise<RefusalRow[]> {
  return sql()<RefusalRow[]>`
    SELECT account_id::text AS account_id,
           business_id::text AS business_id,
           refusal_source,
           refusal_code,
           all_refusal_codes,
           refusal_category,
           vocabulary_version,
           subject_type,
           subject_id::text AS subject_id,
           occurred_at::text AS occurred_at,
           created_at::text AS created_at
    FROM refusal_events
    WHERE account_id = ${tenant!.accountId}::uuid
    ORDER BY subject_id
  `;
}

/**
 * Each Refusal joined to the `solicitation_asks` row it claims to record, with
 * the timestamp equality settled INSIDE Postgres.
 *
 * `exact` is the load-bearing column and it cannot be computed in JavaScript: a
 * decoded `Date` loses the microseconds, so an ask lane wrongly stamping
 * transaction time could compare EQUAL after truncation. The join is on
 * `subject_id` alone — that is the pointer under test, and adding a contact
 * predicate would let a mis-pointed row disappear from the result instead of
 * failing.
 */
async function readAskRefusalJoins(): Promise<{
  subject_id: string;
  refusal_code: string | null;
  ask_id: string | null;
  ask_batch_id: string | null;
  ask_status: string | null;
  ask_withheld_reason: string | null;
  ask_contact_id: string | null;
  exact: boolean | null;
  occurred_at: string;
  decided_at: string | null;
}[]> {
  return sql()`
    SELECT refusal.subject_id::text AS subject_id,
           refusal.refusal_code,
           ask.id::text AS ask_id,
           ask.batch_id::text AS ask_batch_id,
           ask.status AS ask_status,
           ask.withheld_reason AS ask_withheld_reason,
           ask.contact_id::text AS ask_contact_id,
           (refusal.occurred_at = ask.decided_at) AS exact,
           refusal.occurred_at::text AS occurred_at,
           ask.decided_at::text AS decided_at
    FROM refusal_events refusal
    LEFT JOIN solicitation_asks ask ON ask.id = refusal.subject_id
    WHERE refusal.account_id = ${tenant!.accountId}::uuid
      AND refusal.refusal_source = 'ask_withheld'
    ORDER BY refusal.subject_id
  `;
}

interface RecordedQuery {
  text: string;
  onTransaction: boolean;
}

/**
 * A pass-through `Sql` that records the TEXT of every statement, including the
 * ones issued on the transaction `sql.begin` opens.
 *
 * A DELIBERATE SECOND COPY of `approval.integration.test.ts`'s
 * `instrumentedExecutor`. The original lives in that file rather than in a
 * shared helper, and `src/lib/shared/__tests__/helpers/` is outside this
 * branch's edit surface — so this is copied rather than extracted, and the two
 * should be unified by whoever next needs a third.
 *
 * It exists for exactly one claim: 5,000 mapped withholds must reach Postgres as
 * ONE INSERT. Row counts alone cannot see the difference — a loop over the
 * single-row helper produces the same 5,000 rows, holding the per-Business
 * advisory lock across 5,000 sequential round trips (plan review R1-1).
 */
function recordingExecutor(base: postgresType.Sql): {
  executor: postgresType.Sql;
  queries: RecordedQuery[];
} {
  const queries: RecordedQuery[] = [];

  const record = (argArray: unknown[], onTransaction: boolean): void => {
    const strings = argArray[0] as TemplateStringsArray | undefined;
    if (strings && Array.isArray(strings.raw)) {
      queries.push({ text: strings.join(' ? '), onTransaction });
    }
  };

  const bindTrap = (target: object, prop: string | symbol): unknown => {
    const value: unknown = Reflect.get(target, prop);
    return typeof value === 'function'
      ? (value as (...args: unknown[]) => unknown).bind(target)
      : value;
  };

  const wrapTransaction = (tx: postgresType.TransactionSql): postgresType.TransactionSql =>
    new Proxy(tx, {
      apply(target, thisArg, argArray) {
        record(argArray, true);
        return Reflect.apply(
          target as unknown as (...args: unknown[]) => unknown,
          thisArg,
          argArray,
        );
      },
      get: bindTrap,
    }) as postgresType.TransactionSql;

  const executor = new Proxy(base, {
    apply(target, thisArg, argArray) {
      record(argArray, false);
      return Reflect.apply(target as unknown as (...args: unknown[]) => unknown, thisArg, argArray);
    },
    get(target, prop) {
      if (prop !== 'begin') return bindTrap(target, prop);
      return (...args: unknown[]) => {
        const callback = args[args.length - 1] as (
          tx: postgresType.TransactionSql,
        ) => Promise<unknown>;
        const leading = args.slice(0, -1);
        return (target.begin as (...forwarded: unknown[]) => Promise<unknown>)(
          ...leading,
          (tx: postgresType.TransactionSql) => callback(wrapTransaction(tx)),
        );
      };
    },
  }) as postgresType.Sql;

  return { executor, queries };
}

/**
 * Holds the per-Business advisory lock for `seconds`, resolving once it is
 * actually held.
 *
 * `constructBatch` opens its transaction, CASes the outbox attempt and THEN
 * takes this key — so a holder makes the build's transaction START measurably
 * earlier than the moment it decides. `prepareBatch` never takes the key, so it
 * runs to completion first and only construction blocks. That gap is what turns
 * "occurred_at is the decision time, never insert time" into a measurement
 * rather than an assertion: `refusal_events.created_at` defaults to `NOW()`,
 * which in Postgres is `transaction_timestamp()` — transaction START.
 */
function holdBatchLock(holdFor: string): { held: Promise<void>; released: Promise<void> } {
  const gate = deferred();
  // The hold is expressed as an INTERVAL literal rather than a bound number:
  // postgres.js infers a parameter's wire type from the JS value, and a
  // fractional `pg_sleep` argument is one round-trip's worth of ambiguity this
  // fixture does not need. `::interval` fixes the type at the call site.
  const released = sql().begin(async (tx) => {
    await acquireSolicitationBatchLock(tx, businessId);
    gate.resolve();
    await tx`SELECT pg_sleep(EXTRACT(EPOCH FROM ${holdFor}::interval))`;
  }).then(() => undefined);
  return { held: gate.promise, released };
}

describeWithDb('solicitation batch builder against live local Postgres', {
  enabled: Boolean(testDatabaseUrl),
  // 180s, not 90s: the 5000-contact window test runs 7s standalone but ~100s
  // under verify-gate's concurrent coverage load (same contention class as the
  // 120s cleanup hooks below) — a body budget near the observed worst case is
  // a flake, not a guard.
  timeout: 180_000,
}, () => {
  beforeAll(async () => {
    const databaseUrl = assertLocalTestDatabaseUrl(testDatabaseUrl);
    featureDatabaseLock = await acquireLiveDbLock(databaseUrl);
    db = postgres(databaseUrl, {
      max: 4,
      prepare: false,
    });
    await assertSchemaReady(db, [
      MIGRATION_071_RUN_SPINE,
      MIGRATION_088_SOLICITATION_BATCH_EXECUTOR,
      MIGRATION_093_SOLICITATION_CONSENT,
      MIGRATION_096_SOLICITATION_SUPPRESSIONS,
      // The Send-handoff precondition reads the attestation off the business
      // row this suite seeds (#656 T6); a behind-head DB must say so.
      MIGRATION_099_SOLICITATION_POSTAL_ADDRESS,
    ]);
    tenant = await seedTenantAccount(db, {
      userName: 'Batch Builder Integration Owner',
      accountDisplayName: 'Batch Builder Integration Account',
      subscriptionStatus: 'active',
    });
    // A canonical google_place_id from the start: since #914 the Send handoff
    // withholds a location without one, and most cases here are about the
    // OTHER two facts.
    await db`
      INSERT INTO businesses (
        id, name, owner_name, owner_email, account_id,
        subscription_status, category, google_place_id
      ) VALUES (
        ${businessId}::uuid, 'Batch Builder Integration Business',
        'Batch Owner', ${tenant.ownerEmail}, ${tenant.accountId}::uuid,
        'active', 'automotive', ${FIXTURE_GOOGLE_PLACE_ID}
      )
    `;
  }, LIVE_DB_LOCK_HOOK_TIMEOUT_MS);

  afterEach(async () => {
    delete process.env.SOLICITATION_WATCH_ENABLED;
    delete process.env.SOLICITATION_SEND_ENABLED;
    // The kill switch is default-ON and one case turns it off; a leak would
    // silently turn every ledger assertion in this file into a no-op that still
    // passes.
    delete process.env[REFUSAL_LEDGER_FLAG];
    enqueueFailure.error = null;
    // #1010's rows. Cleared per case so "exactly N Refusals" means this case's,
    // and swept BEFORE teardown deletes the account and location this table's
    // two no-action foreign keys point at.
    await sql()`DELETE FROM refusal_events WHERE account_id = ${tenant!.accountId}::uuid`;
    // The five #656 attestation columns plus owner_email_bounced, back to the
    // beforeAll shape. The business row is shared by every case here, and the
    // Send handoff reads it — a leaked attestation would silently un-withhold
    // the next test.
    await resetFixturePostalAddress();
    // Generation rows carry no business_id in their payload (batch_id only),
    // so they need their own batch-scoped delete — and it must run before the
    // uploads delete below cascades the batches away.
    await sql()`
      DELETE FROM job_outbox
      WHERE topic = ${QUEUE_NAMES.GENERATE_SOLICITATION_ASKS}
        AND aggregate_id IN (
          SELECT id FROM solicitation_batches
          WHERE business_id = ${businessId}::uuid
        )
    `;
    await sql()`
      DELETE FROM job_outbox
      WHERE aggregate_type = 'solicitation_batch'
        AND payload->>'business_id' = ${businessId}
    `;
    // Child-first set-based deletes instead of leaning on the
    // contact_csv_uploads ON DELETE CASCADE: cascading away the 5000-contact
    // window fixture fires ~15k per-row RI triggers, which blew this hook's
    // old 30s budget under verify-gate's concurrent coverage load. Worse, a
    // timed-out hook is ABANDONED, not cancelled — postgres.js keeps
    // executing the queued DELETEs, and the late cascade then removes rows
    // the NEXT test just seeded under the same suite-wide businessId (the
    // solicitation_asks_contact_business_fk violation in the gate log). Each
    // business-scoped DELETE below is one indexed statement; the cascades
    // that still fire probe already-empty child tables.
    await sql()`DELETE FROM solicitation_outreach WHERE business_id = ${businessId}::uuid`;
    await sql()`DELETE FROM reviews WHERE business_id = ${businessId}::uuid`;
    await sql()`DELETE FROM solicitation_asks WHERE business_id = ${businessId}::uuid`;
    await sql()`
      DELETE FROM agent_runs
      WHERE account_id = ${tenant!.accountId}::uuid
        AND kind IN ('solicitation_batch', 'solicitation_ask')
    `;
    await sql()`DELETE FROM solicitation_visits WHERE business_id = ${businessId}::uuid`;
    await sql()`DELETE FROM solicitation_contacts WHERE business_id = ${businessId}::uuid`;
    await sql()`DELETE FROM solicitation_batches WHERE business_id = ${businessId}::uuid`;
    await sql()`DELETE FROM contact_csv_uploads WHERE business_id = ${businessId}::uuid`;
    // Consent rows never cascade from uploads — migration 093 only SET NULLs
    // their source_upload_id — so sweep them explicitly.
    await sql()`DELETE FROM solicitation_consent WHERE business_id = ${businessId}::uuid`;
    // Suppression ledger rows hang off no business at all: they key on the
    // Normalized handle, so nothing above reaches them.
    await sweepSuppressionFixtures();
  }, 120_000);

  afterAll(async () => {
    try {
      if (db) {
        // BEFORE cleanupTenantAccount: solicitation_suppressions.account_id is a
        // NO-ACTION FK to accounts, which that helper deletes directly. A row
        // leaked by a failed afterEach would turn teardown into an FK error.
        await sweepSuppressionFixtures();
        await db`DELETE FROM businesses WHERE id = ${businessId}::uuid`;
        if (tenant) await cleanupTenantAccount(db, tenant);
      }
    } finally {
      try {
        if (db) await db.end({ timeout: 5 });
      } finally {
        await featureDatabaseLock?.release();
        featureDatabaseLock = undefined;
      }
    }
  }, 120_000);

  it('build_solicitation_batch atomically records decisions and completes the parent and owned outbox', async () => {
    process.env.SOLICITATION_WATCH_ENABLED = 'true';
    const uploadId = await seedCompletedUpload();
    const contactId = await seedContact(uploadId, daysAgoUtc(7));
    const batch = await seedBatch(3);

    const result = await build(batch);

    expect(result).toMatchObject({
      status: 'built',
      candidateCount: 1,
      sendCount: 1,
      withholdCount: 0,
    });
    const [state] = await sql()<{
      outbox_status: string;
      built_at: string | null;
      parent_status: string;
      child_status: string;
      linked_run_id: string | null;
      outcome_units: number;
      parent_steps: number;
      child_steps: number;
      evidence_text: string;
    }[]>`
      SELECT
        jo.status AS outbox_status,
        sb.built_at::text AS built_at,
        parent.status AS parent_status,
        child.status AS child_status,
        ask.agent_run_id::text AS linked_run_id,
        outcome.unit_count AS outcome_units,
        (SELECT COUNT(*)::int FROM agent_run_steps s
         WHERE s.agent_run_id = parent.id AND s.step_key = 'batch_built') AS parent_steps,
        (SELECT COUNT(*)::int FROM agent_run_steps s
         WHERE s.agent_run_id = child.id AND s.step_key = 'ask_evaluated') AS child_steps,
        ask.evidence::text AS evidence_text
      FROM solicitation_batches sb
      JOIN job_outbox jo ON jo.aggregate_id = sb.id
      JOIN agent_runs parent
        ON parent.kind = 'solicitation_batch' AND parent.subject_id = sb.id::text
      JOIN solicitation_asks ask
        ON ask.batch_id = sb.id AND ask.contact_id = ${contactId}::uuid
      JOIN agent_runs child ON child.id = ask.agent_run_id
      JOIN agent_outcomes outcome
        ON outcome.agent_run_id = parent.id
       AND outcome.outcome_kind = 'solicitation_batch_built'
      WHERE sb.id = ${batch.batchId}::uuid
    `;
    expect(state).toMatchObject({
      outbox_status: 'completed',
      parent_status: 'completed',
      child_status: 'completed',
      outcome_units: 1,
      parent_steps: 1,
      child_steps: 1,
    });
    expect(state!.built_at).not.toBeNull();
    expect(state!.linked_run_id).not.toBeNull();
    expect(state!.evidence_text).not.toContain('@example.test');
    expect(state!.evidence_text).not.toContain('Batch Candidate');
  });

  it('flag-on build with send asks enqueues one generation row and the real 091 index dedups a second enqueue', async () => {
    process.env.SOLICITATION_WATCH_ENABLED = 'true';
    process.env.SOLICITATION_SEND_ENABLED = 'true';
    // #656 T6: the Send handoff is now a precondition, not an unconditional
    // consequence of `sendCount > 0`. Without an Attested postal address this
    // build would be WITHHELD and the generation-row assertion below would see
    // zero — so the fixture attests first. The precondition itself is proven by
    // the dedicated cases at the end of this file.
    await attestFixturePostalAddress();
    const uploadId = await seedCompletedUpload();
    await seedContact(uploadId, new Date().toISOString().slice(0, 10));
    const batch = await seedBatch();

    await expect(build(batch)).resolves.toMatchObject({
      status: 'built',
      sendCount: 1,
      sendHandoff: { status: 'enqueued' },
    });

    // The build transaction enqueued exactly one pending generation row keyed
    // by the batch (091 comment contract: aggregate_id = batch id).
    const generationRows = await sql()<{
      status: string;
      payload_batch_id: string | null;
    }[]>`
      SELECT status, payload->>'batch_id' AS payload_batch_id
      FROM job_outbox
      WHERE topic = ${QUEUE_NAMES.GENERATE_SOLICITATION_ASKS}
        AND aggregate_id = ${batch.batchId}::uuid
    `;
    expect(generationRows).toHaveLength(1);
    expect(generationRows[0]).toMatchObject({
      status: 'pending',
      payload_batch_id: batch.batchId,
    });

    // Execution-level proof of the byte-for-byte contract: the helper's
    // ON CONFLICT predicate must be inferred against migration 091's partial
    // unique index by the REAL planner. If the spelling drifted, this second
    // enqueue would throw 42P10 (no matching constraint) or insert a
    // duplicate; instead it returns null — already in flight.
    const deduped = await sql().begin((tx) =>
      enqueueGenerateSolicitationAsks(tx, { batchId: batch.batchId, businessId }),
    );
    expect(deduped).toBeNull();
  });

  it('builds an empty accumulated pool with a zero-unit batch outcome', async () => {
    process.env.SOLICITATION_WATCH_ENABLED = 'true';
    const batch = await seedBatch();

    await expect(build(batch)).resolves.toMatchObject({
      status: 'built',
      candidateCount: 0,
      sendCount: 0,
      withholdCount: 0,
    });

    const [state] = await sql()<{
      built: boolean;
      unit_count: number;
      child_count: number;
    }[]>`
      SELECT
        sb.built_at IS NOT NULL AS built,
        outcome.unit_count,
        (SELECT COUNT(*)::int FROM agent_runs child
         WHERE child.parent_run_id = parent.id) AS child_count
      FROM solicitation_batches sb
      JOIN agent_runs parent
        ON parent.kind = 'solicitation_batch'
       AND parent.subject_id = sb.id::text
      JOIN agent_outcomes outcome
        ON outcome.agent_run_id = parent.id
       AND outcome.outcome_kind = 'solicitation_batch_built'
      WHERE sb.id = ${batch.batchId}::uuid
    `;
    expect(state).toEqual({ built: true, unit_count: 0, child_count: 0 });
  });

  it('priorBatch reads only would-have-sent asks and never velocity_banked decisions', async () => {
    process.env.SOLICITATION_WATCH_ENABLED = 'true';
    const uploadId = await seedCompletedUpload();
    const bankedContactId = await seedContact(uploadId, daysAgoUtc(7));
    const sentContactId = await seedContact(uploadId, daysAgoUtc(8));
    const recent = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    await seedPriorAsk({
      contactId: bankedContactId,
      status: 'withhold',
      withheldReason: 'velocity_banked',
      decidedAt: recent,
    });
    await seedPriorAsk({
      contactId: sentContactId,
      status: 'send',
      decidedAt: recent,
    });

    const batch = await seedBatch();
    await build(batch);

    const asks = await sql()<{
      contact_id: string;
      status: string;
      withheld_reason: string | null;
    }[]>`
      SELECT contact_id::text, status, withheld_reason
      FROM solicitation_asks
      WHERE batch_id = ${batch.batchId}::uuid
      ORDER BY contact_id
    `;
    expect(asks.find((ask) => ask.contact_id === bankedContactId)).toMatchObject({
      status: 'send',
      withheld_reason: null,
    });
    expect(asks.find((ask) => ask.contact_id === sentContactId)).toMatchObject({
      status: 'withhold',
      withheld_reason: 'over_contacted',
    });
  });

  it('concurrent location batches serialize so the later batch observes earlier would-have-sent history', async () => {
    process.env.SOLICITATION_WATCH_ENABLED = 'true';
    const uploadId = await seedCompletedUpload();
    await seedContact(uploadId, daysAgoUtc(7));
    const first = await seedBatch();
    const second = await seedBatch();

    const results = await Promise.all([build(first), build(second)]);

    expect(results.map((result) => result.status)).toEqual(['built', 'built']);
    const decisions = await sql()<{
      status: string;
      withheld_reason: string | null;
    }[]>`
      SELECT status, withheld_reason
      FROM solicitation_asks
      WHERE batch_id IN (${first.batchId}::uuid, ${second.batchId}::uuid)
      ORDER BY status
    `;
    expect(decisions).toHaveLength(2);
    expect(decisions.filter((decision) => decision.status === 'send')).toHaveLength(1);
    expect(decisions.filter(
      (decision) =>
        decision.status === 'withhold' &&
        decision.withheld_reason === 'over_contacted',
    )).toHaveLength(1);
  });

  it('retry after committed construction does not create an extra parent or duplicate asks or child runs', async () => {
    process.env.SOLICITATION_WATCH_ENABLED = 'true';
    const uploadId = await seedCompletedUpload();
    await seedContact(uploadId, daysAgoUtc(7));
    const batch = await seedBatch(2);

    await build(batch);
    await expect(build(batch)).resolves.toMatchObject({ status: 'stale' });

    const [counts] = await sql()<{
      parents: number;
      asks: number;
      children: number;
    }[]>`
      SELECT
        (SELECT COUNT(*)::int FROM agent_runs
         WHERE kind = 'solicitation_batch'
           AND subject_id = ${batch.batchId}) AS parents,
        (SELECT COUNT(*)::int FROM solicitation_asks
         WHERE batch_id = ${batch.batchId}::uuid) AS asks,
        (SELECT COUNT(*)::int FROM agent_runs child
         JOIN solicitation_asks ask ON ask.agent_run_id = child.id
         WHERE ask.batch_id = ${batch.batchId}::uuid
           AND child.kind = 'solicitation_ask') AS children
    `;
    expect(counts).toEqual({ parents: 1, asks: 1, children: 1 });
  });

  it('lockDispatchedOutboxAttemptIfOwned prevents a stale build attempt from creating a parent', async () => {
    process.env.SOLICITATION_WATCH_ENABLED = 'true';
    const batch = await seedBatch(4);

    await expect(
      buildSolicitationBatch(sql(), {
        batchId: batch.batchId,
        businessId,
        outboxId: batch.outboxId,
        attempt: 3,
      }),
    ).resolves.toMatchObject({ status: 'stale' });

    const [state] = await sql()<{
      outbox_status: string;
      built_at: string | null;
      parents: number;
    }[]>`
      SELECT
        jo.status AS outbox_status,
        sb.built_at::text AS built_at,
        (SELECT COUNT(*)::int FROM agent_runs
         WHERE kind = 'solicitation_batch'
           AND subject_id = sb.id::text) AS parents
      FROM solicitation_batches sb
      JOIN job_outbox jo ON jo.aggregate_id = sb.id
      WHERE sb.id = ${batch.batchId}::uuid
    `;
    expect(state).toEqual({
      outbox_status: 'dispatched',
      built_at: null,
      parents: 0,
    });
  });

  it('a dispatched builder serializes behind delete_data offboarding and closes without history effects', async () => {
    process.env.SOLICITATION_WATCH_ENABLED = 'true';
    const uploadId = await seedCompletedUpload();
    await seedContact(uploadId, daysAgoUtc(7));
    const batch = await seedBatch(2);
    const offboardingId = randomUUID();
    const accountLockHeld = deferred();
    const allowOffboardingCommit = deferred();
    let offboardingWriter: Promise<unknown> | undefined;
    let dispatchedBuilder: Promise<unknown> | undefined;

    try {
      offboardingWriter = sql().begin(async (tx) => {
        await tx`SET LOCAL lock_timeout = '4s'`;
        await tx`SET LOCAL statement_timeout = '7s'`;
        await tx`
          SELECT id
          FROM accounts
          WHERE id = ${tenant!.accountId}::uuid
          FOR UPDATE
        `;
        accountLockHeld.resolve();
        await allowOffboardingCommit.promise;
        await tx`
          INSERT INTO account_offboardings (id, account_id, mode, status)
          VALUES (
            ${offboardingId}::uuid,
            ${tenant!.accountId}::uuid,
            'delete_data',
            'pending'
          )
        `;
      });
      await accountLockHeld.promise;

      dispatchedBuilder = build(batch);
      await assertStillBlocked(dispatchedBuilder);
      allowOffboardingCommit.resolve();

      await offboardingWriter;
      await expect(dispatchedBuilder).resolves.toEqual({
        status: 'gate_closed',
        reason: 'account_offboarding_blocked',
        parentTerminalized: false,
      });

      const [state] = await sql()<{
        batch_count: number;
        outbox_status: string;
        ask_count: number;
        run_count: number;
      }[]>`
        SELECT
          (SELECT COUNT(*)::int
           FROM solicitation_batches
           WHERE id = ${batch.batchId}::uuid) AS batch_count,
          (SELECT status
           FROM job_outbox
           WHERE id = ${batch.outboxId}::uuid) AS outbox_status,
          (SELECT COUNT(*)::int
           FROM solicitation_asks
           WHERE batch_id = ${batch.batchId}::uuid) AS ask_count,
          (SELECT COUNT(*)::int
           FROM agent_runs
           WHERE account_id = ${tenant!.accountId}::uuid
             AND subject_id = ${batch.batchId}) AS run_count
      `;
      expect(state).toEqual({
        batch_count: 0,
        outbox_status: 'completed',
        ask_count: 0,
        run_count: 0,
      });
    } finally {
      allowOffboardingCommit.resolve();
      await Promise.allSettled([
        offboardingWriter ?? Promise.resolve(),
        dispatchedBuilder ?? Promise.resolve(),
      ]);
      await sql()`
        DELETE FROM account_offboardings
        WHERE id = ${offboardingId}::uuid
      `;
    }
  });

  it('build_solicitation_batch removes no-parent unbuilt work when the flag or subscription gate closes', async () => {
    const uploadId = await seedCompletedUpload();
    await seedContact(uploadId, daysAgoUtc(7));
    const flagClosed = await seedBatch(2);
    const untouched = await seedBatch(2);

    delete process.env.SOLICITATION_WATCH_ENABLED;
    await expect(build(flagClosed)).resolves.toEqual({
      status: 'gate_closed',
      reason: 'flag_disabled',
      parentTerminalized: false,
    });

    process.env.SOLICITATION_WATCH_ENABLED = 'true';
    const subscriptionClosed = await seedBatch(4);
    let subscriptionResult;
    try {
      await sql()`
        UPDATE accounts
        SET subscription_status = 'cancelled'
        WHERE id = ${tenant!.accountId}::uuid
      `;
      subscriptionResult = await build(subscriptionClosed);
    } finally {
      await sql()`
        UPDATE accounts
        SET subscription_status = 'active'
        WHERE id = ${tenant!.accountId}::uuid
      `;
    }
    expect(subscriptionResult).toEqual({
      status: 'gate_closed',
      reason: 'subscription_inactive',
      parentTerminalized: false,
    });

    const [state] = await sql()<{
      target_batches: number;
      untouched_batches: number;
      target_parents: number;
      target_asks: number;
      completed_outboxes: number;
    }[]>`
      SELECT
        (SELECT COUNT(*)::int
         FROM solicitation_batches
         WHERE id IN (
           ${flagClosed.batchId}::uuid,
           ${subscriptionClosed.batchId}::uuid
         )) AS target_batches,
        (SELECT COUNT(*)::int
         FROM solicitation_batches
         WHERE id = ${untouched.batchId}::uuid
           AND built_at IS NULL) AS untouched_batches,
        (SELECT COUNT(*)::int
         FROM agent_runs
         WHERE kind = 'solicitation_batch'
           AND subject_id IN (
             ${flagClosed.batchId},
             ${subscriptionClosed.batchId}
           )) AS target_parents,
        (SELECT COUNT(*)::int
         FROM solicitation_asks
         WHERE batch_id IN (
           ${flagClosed.batchId}::uuid,
           ${subscriptionClosed.batchId}::uuid
         )) AS target_asks,
        (SELECT COUNT(*)::int
         FROM job_outbox
         WHERE id IN (
           ${flagClosed.outboxId}::uuid,
           ${subscriptionClosed.outboxId}::uuid
         )
           AND status = 'completed') AS completed_outboxes
    `;
    expect(state).toEqual({
      target_batches: 0,
      untouched_batches: 1,
      target_parents: 0,
      target_asks: 0,
      completed_outboxes: 2,
    });
  });

  it('build_solicitation_batch gate closure after parent start completes the owned outbox and fails that parent as gate_closed', async () => {
    const uploadId = await seedCompletedUpload();
    await seedContact(uploadId, daysAgoUtc(7));
    const target = await seedBatch(3);
    const untouched = await seedBatch(3);
    const targetParentId = await seedParentRun(target.batchId);
    const untouchedParentId = await seedParentRun(untouched.batchId);

    delete process.env.SOLICITATION_WATCH_ENABLED;
    await expect(build(target)).resolves.toEqual({
      status: 'gate_closed',
      reason: 'flag_disabled',
      parentTerminalized: true,
    });

    const [state] = await sql()<{
      target_batch_count: number;
      untouched_batch_count: number;
      outbox_status: string;
      target_parent_status: string;
      target_error_code: string | null;
      target_error_gate: string | null;
      untouched_parent_status: string;
      target_asks: number;
    }[]>`
      SELECT
        (SELECT COUNT(*)::int FROM solicitation_batches
         WHERE id = ${target.batchId}::uuid) AS target_batch_count,
        (SELECT COUNT(*)::int FROM solicitation_batches
         WHERE id = ${untouched.batchId}::uuid
           AND built_at IS NULL) AS untouched_batch_count,
        (SELECT status FROM job_outbox
         WHERE id = ${target.outboxId}::uuid) AS outbox_status,
        (SELECT status FROM agent_runs
         WHERE id = ${targetParentId}::uuid) AS target_parent_status,
        (SELECT error->>'code' FROM agent_runs
         WHERE id = ${targetParentId}::uuid) AS target_error_code,
        (SELECT error->>'gate' FROM agent_runs
         WHERE id = ${targetParentId}::uuid) AS target_error_gate,
        (SELECT status FROM agent_runs
         WHERE id = ${untouchedParentId}::uuid) AS untouched_parent_status,
        (SELECT COUNT(*)::int FROM solicitation_asks
         WHERE batch_id = ${target.batchId}::uuid) AS target_asks
    `;
    expect(state).toEqual({
      target_batch_count: 0,
      untouched_batch_count: 1,
      outbox_status: 'completed',
      target_parent_status: 'failed',
      target_error_code: 'gate_closed',
      target_error_gate: 'flag_disabled',
      untouched_parent_status: 'running',
      target_asks: 0,
    });
  });

  it('build_solicitation_batch exhausted failure marks only the owned parent failed and keeps the unbuilt batch hidden', async () => {
    process.env.SOLICITATION_WATCH_ENABLED = 'true';
    const uploadId = await seedCompletedUpload();
    await seedContact(uploadId, daysAgoUtc(7));
    const target = await seedBatch(3);
    const untouched = await seedBatch(3);
    const targetParentId = await seedParentRun(target.batchId);
    const untouchedParentId = await seedParentRun(untouched.batchId);
    const job = {
      id: target.outboxId,
      data: {
        batch_id: target.batchId,
        business_id: businessId,
        outbox_id: target.outboxId,
        outbox_attempt: target.attempt,
        correlation_id: 'batch-builder-exhaustion',
      },
      attemptsMade: 3,
      opts: { attempts: 3 },
    } as unknown as Job<BuildSolicitationBatchPayload>;

    await handleSolicitationBatchFailed(
      sql(),
      job,
      new Error('contact-name@example.test must never be persisted'),
    );

    const [state] = await sql()<{
      target_batch_count: number;
      target_built_at: string | null;
      target_outbox_status: string;
      target_last_error: string | null;
      target_parent_status: string;
      target_error_code: string | null;
      target_error_class: string | null;
      untouched_parent_status: string;
      untouched_outbox_status: string;
      target_asks: number;
    }[]>`
      SELECT
        (SELECT COUNT(*)::int FROM solicitation_batches
         WHERE id = ${target.batchId}::uuid) AS target_batch_count,
        (SELECT built_at::text FROM solicitation_batches
         WHERE id = ${target.batchId}::uuid) AS target_built_at,
        (SELECT status FROM job_outbox
         WHERE id = ${target.outboxId}::uuid) AS target_outbox_status,
        (SELECT last_error FROM job_outbox
         WHERE id = ${target.outboxId}::uuid) AS target_last_error,
        (SELECT status FROM agent_runs
         WHERE id = ${targetParentId}::uuid) AS target_parent_status,
        (SELECT error->>'code' FROM agent_runs
         WHERE id = ${targetParentId}::uuid) AS target_error_code,
        (SELECT error->>'error_class' FROM agent_runs
         WHERE id = ${targetParentId}::uuid) AS target_error_class,
        (SELECT status FROM agent_runs
         WHERE id = ${untouchedParentId}::uuid) AS untouched_parent_status,
        (SELECT status FROM job_outbox
         WHERE id = ${untouched.outboxId}::uuid) AS untouched_outbox_status,
        (SELECT COUNT(*)::int FROM solicitation_asks
         WHERE batch_id = ${target.batchId}::uuid) AS target_asks
    `;
    expect(state).toEqual({
      target_batch_count: 1,
      target_built_at: null,
      target_outbox_status: 'failed',
      target_last_error: 'build_solicitation_batch_exhausted:Error',
      target_parent_status: 'failed',
      target_error_code: 'build_failed',
      target_error_class: 'Error',
      untouched_parent_status: 'running',
      untouched_outbox_status: 'dispatched',
      target_asks: 0,
    });
    expect(JSON.stringify(state)).not.toContain('contact-name@example.test');
  });

  it('repeated visit and evaluation histories remain buildable under a bounded statement timeout', async () => {
    process.env.SOLICITATION_WATCH_ENABLED = 'true';
    const uploadId = await seedCompletedUpload();
    const contactId = await seedContact(uploadId, daysAgoUtc(7));
    const fixtureSeed = randomUUID();
    const historyRows = 4_000;

    await sql()`
      WITH fixtures AS (
        SELECT
          n,
          md5(${fixtureSeed} || '-upload-' || n::text)::uuid AS upload_id
        FROM generate_series(1, ${historyRows}) AS n
      )
      INSERT INTO contact_csv_uploads (
        id, account_id, business_id, filename, byte_size, content_sha256,
        raw_csv, status, report, attested_by_user_id, attested_at,
        attestation_version, completed_at
      )
      SELECT
        upload_id,
        ${tenant!.accountId}::uuid,
        ${businessId}::uuid,
        'history.csv',
        1,
        md5(${fixtureSeed} || '-sha-' || n::text)
          || md5(${fixtureSeed} || '-sha-tail-' || n::text),
        NULL,
        'completed',
        ${sql().json({ accepted: 1 })},
        ${tenant!.userId}::uuid,
        NOW(),
        ${CONSENT_ATTESTATION_VERSION},
        NOW()
      FROM fixtures
    `;
    await sql()`
      WITH fixtures AS (
        SELECT
          n,
          md5(${fixtureSeed} || '-upload-' || n::text)::uuid AS upload_id,
          md5(${fixtureSeed} || '-batch-' || n::text)::uuid AS batch_id
        FROM generate_series(1, ${historyRows}) AS n
      )
      INSERT INTO solicitation_batches (
        id, account_id, business_id, source_upload_id, built_at, created_at
      )
      SELECT
        batch_id,
        ${tenant!.accountId}::uuid,
        ${businessId}::uuid,
        upload_id,
        NOW(),
        NOW() - INTERVAL '1 second'
      FROM fixtures
    `;
    await sql()`
      WITH fixtures AS (
        SELECT
          n,
          md5(${fixtureSeed} || '-upload-' || n::text)::uuid AS upload_id,
          md5(${fixtureSeed} || '-visit-' || n::text)::uuid AS visit_id
        FROM generate_series(1, ${historyRows}) AS n
      )
      INSERT INTO solicitation_visits (
        id, contact_id, business_id, visit_date, upload_id
      )
      SELECT
        visit_id,
        ${contactId}::uuid,
        ${businessId}::uuid,
        ${daysAgoUtc(7)}::date - n,
        upload_id
      FROM fixtures
    `;
    await sql()`
      WITH fixtures AS (
        SELECT
          n,
          md5(${fixtureSeed} || '-batch-' || n::text)::uuid AS batch_id,
          md5(${fixtureSeed} || '-ask-' || n::text)::uuid AS ask_id
        FROM generate_series(1, ${historyRows}) AS n
      )
      INSERT INTO solicitation_asks (
        id, account_id, business_id, batch_id, contact_id, status,
        withheld_reason, evidence, decided_at
      )
      SELECT
        ask_id,
        ${tenant!.accountId}::uuid,
        ${businessId}::uuid,
        batch_id,
        ${contactId}::uuid,
        'withhold',
        'stale_visit',
        ${sql().json({
          contact_id: contactId,
          policy_version: 'history-fixture',
          decided_at: '2026-07-23T00:00:00.000Z',
          decision: 'withhold',
          reason: 'stale_visit',
        })},
        NOW() - n * INTERVAL '1 second'
      FROM fixtures
    `;

    const batch = await seedBatch();
    const boundedSql = postgres(assertLocalTestDatabaseUrl(testDatabaseUrl), {
      max: 1,
      prepare: false,
    });
    try {
      await boundedSql`SET statement_timeout = '2s'`;
      await expect(
        buildSolicitationBatch(boundedSql, {
          batchId: batch.batchId,
          businessId,
          outboxId: batch.outboxId,
          attempt: batch.attempt,
          correlationId: 'batch-builder-history-bound',
        }),
      ).resolves.toMatchObject({
        status: 'built',
        candidateCount: 1,
      });
    } finally {
      await boundedSql.end({ timeout: 5 });
    }
  }, 30_000);

  it('candidate windows are capped at 5000 and rotate by least-recently-evaluated ask', async () => {
    process.env.SOLICITATION_WATCH_ENABLED = 'true';
    const uploadId = await seedCompletedUpload();
    await sql()`
      WITH contacts AS (
        INSERT INTO solicitation_contacts (
          id, business_id, name, email, created_by_upload_id
        )
        SELECT
          gen_random_uuid(), ${businessId}::uuid, 'Window Candidate',
          'window-' || n::text || '@example.test', ${uploadId}::uuid
        FROM generate_series(1, 5001) AS n
        RETURNING id
      )
      INSERT INTO solicitation_visits (
        id, contact_id, business_id, visit_date, upload_id
      )
      SELECT
        gen_random_uuid(), id, ${businessId}::uuid, ${daysAgoUtc(7)}::date,
        ${uploadId}::uuid
      FROM contacts
    `;
    await sql()`
      INSERT INTO solicitation_consent (
        id, channel, normalized_handle, business_id, basis,
        attestation_version, attested_at, attested_by_user_id, source_upload_id
      )
      SELECT
        gen_random_uuid(), 'email', c.email, ${businessId}::uuid,
        'owner_attested', ${CONSENT_ATTESTATION_VERSION}, NOW(),
        ${tenant!.userId}::uuid, ${uploadId}::uuid
      FROM solicitation_contacts c
      WHERE c.business_id = ${businessId}::uuid AND c.email IS NOT NULL
    `;
    const first = await seedBatch();
    const firstResult = await build(first);
    expect(firstResult).toMatchObject({ status: 'built', candidateCount: 5000 });

    const [neverEvaluated] = await sql()<{ id: string }[]>`
      SELECT c.id::text AS id
      FROM solicitation_contacts c
      LEFT JOIN solicitation_asks a
        ON a.contact_id = c.id AND a.batch_id = ${first.batchId}::uuid
      WHERE c.business_id = ${businessId}::uuid
        AND a.id IS NULL
    `;
    expect(neverEvaluated).toBeDefined();

    const second = await seedBatch();
    const secondResult = await build(second);
    expect(secondResult).toMatchObject({ status: 'built', candidateCount: 5000 });
    const [rotated] = await sql()<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM solicitation_asks
      WHERE batch_id = ${second.batchId}::uuid
        AND contact_id = ${neverEvaluated!.id}::uuid
    `;
    expect(rotated!.count).toBe(1);
  });

  it('consent_attested is no longer a tautology: a contact covered only by consent_attestation_v1 yields attested: false', async () => {
    const csv = `${CSV_HEADER}\nPat Taut,taut-check@example.test,,${daysAgoUtc(1)},`;
    const v1UploadId = await seedPendingUpload(csv, { attestationVersion: 'consent_attestation_v1' });
    await ingestContactsCsvUpload(sql(), v1UploadId, businessId);

    process.env.SOLICITATION_WATCH_ENABLED = 'true';
    const batch = await seedBatch();
    await expect(build(batch)).resolves.toMatchObject({
      status: 'built',
      candidateCount: 1,
      sendCount: 0,
      withholdCount: 1,
      withheldByReason: expect.objectContaining({ no_consent: 1 }),
    });

    const [ask] = await readAsks(batch.batchId);
    expect(ask).toMatchObject({ status: 'withhold', withheld_reason: 'no_consent' });
    // Case (b): the ledger row exists and names the v1 upload, so the #629
    // owner remedy ("re-upload this list") is truthful.
    expect(parseAskEvidence(ask!.evidence)).toMatchObject({
      reason: 'no_consent',
      upload_id: v1UploadId,
      attestation_version: 'consent_attestation_v1',
    });
  });

  it('the §1.2 re-upload trap: re-uploading the identical CSV under v2 inserts zero visits AND leaves the contact send-eligible', async () => {
    const csv = `${CSV_HEADER}\nRe Upload,reupload-trap@example.test,,${daysAgoUtc(2)},`;
    const v1UploadId = await seedPendingUpload(csv, {
      attestationVersion: 'consent_attestation_v1',
      attestedAgo: '1 hour',
    });
    await ingestContactsCsvUpload(sql(), v1UploadId, businessId);

    // The trap's exact conditions: the identical CSV re-ingested under v2
    // (later attested_at) dedupes EVERY visit — only the ledger row upgrades.
    const v2UploadId = await seedPendingUpload(csv);
    const report = await ingestContactsCsvUpload(sql(), v2UploadId, businessId);
    expect(report).toMatchObject({ visitsAdded: 0, duplicateVisits: 1 });

    process.env.SOLICITATION_WATCH_ENABLED = 'true';
    const batch = await seedBatch();
    // The visit sits well inside the automotive freshness window and no prior
    // send exists, so no later precedence reason fires: a clean send.
    await expect(build(batch)).resolves.toMatchObject({
      status: 'built',
      candidateCount: 1,
      sendCount: 1,
      withholdCount: 0,
    });
    const [ask] = await readAsks(batch.batchId);
    expect(ask).toMatchObject({ status: 'send', withheld_reason: null });
  });

  it('tenant scope: a consent row at business A does not make the same handle eligible at business B in the same account', async () => {
    const otherBusinessId = randomUUID();
    await sql()`
      INSERT INTO businesses (
        id, name, owner_name, owner_email, account_id,
        subscription_status, category
      ) VALUES (
        ${otherBusinessId}::uuid, 'Batch Builder Tenant-Scope Business',
        'Batch Owner', ${tenant!.ownerEmail}, ${tenant!.accountId}::uuid,
        'active', 'automotive'
      )
    `;
    let otherOutboxId: string | undefined;
    try {
      const csv = `${CSV_HEADER}\nShared Handle,shared-handle@example.test,,${daysAgoUtc(1)},`;
      // v2 coverage at business A; a v1-era row at business B.
      const uploadA = await seedPendingUpload(csv);
      await ingestContactsCsvUpload(sql(), uploadA, businessId);
      const uploadB = await seedPendingUpload(csv, {
        attestationVersion: 'consent_attestation_v1',
        forBusinessId: otherBusinessId,
      });
      await ingestContactsCsvUpload(sql(), uploadB, otherBusinessId);

      process.env.SOLICITATION_WATCH_ENABLED = 'true';
      const batchB = await seedBatch(1, otherBusinessId);
      otherOutboxId = batchB.outboxId;
      await expect(build(batchB, otherBusinessId)).resolves.toMatchObject({
        status: 'built',
        candidateCount: 1,
        sendCount: 0,
        withheldByReason: expect.objectContaining({ no_consent: 1 }),
      });
      const [askB] = await readAsks(batchB.batchId);
      expect(parseAskEvidence(askB!.evidence)).toMatchObject({
        reason: 'no_consent',
        upload_id: uploadB,
        attestation_version: 'consent_attestation_v1',
      });

      // The SAME handle at business A stays eligible: the row is scoped, not shared.
      const batchA = await seedBatch();
      await expect(build(batchA)).resolves.toMatchObject({
        status: 'built',
        candidateCount: 1,
        sendCount: 1,
      });
    } finally {
      if (otherOutboxId !== undefined) {
        await sql()`DELETE FROM job_outbox WHERE id = ${otherOutboxId}::uuid`;
      }
      await sql()`DELETE FROM agent_runs WHERE business_id = ${otherBusinessId}::uuid`;
      // The build at business B withholds `no_consent`, which since #1010 is a
      // Refusal — and `refusal_events.business_id` is a NO-ACTION foreign key,
      // so the row has to go before the location it names. The suite-wide
      // `afterEach` sweeps by ACCOUNT and runs after this block, so it cannot
      // help here: this is the one location this file deletes inline.
      await sql()`DELETE FROM refusal_events WHERE business_id = ${otherBusinessId}::uuid`;
      await sql()`DELETE FROM businesses WHERE id = ${otherBusinessId}::uuid`;
    }
  });

  it('legacy pre-ledger contacts read as no_consent case (a): visits without a ledger row yield null evidence', async () => {
    // Decision pinned (Codex adversarial M2, accepted alternative): pre-#625
    // contacts get NO ledger backfill, deliberately. Seeded DIRECTLY via SQL —
    // never through the new ingest, which would mint ledger rows — this is
    // exactly the shape a pre-#625 database carries: a completed v1 upload,
    // a contact, visits, and zero solicitation_consent rows. That cohort must
    // read as case (a) (both evidence fields null), whose #629 owner remedy
    // — "upload under the current attestation" — is truthful and works.
    const legacyUploadId = await seedCompletedUpload();
    await sql()`
      UPDATE contact_csv_uploads
      SET attestation_version = 'consent_attestation_v1'
      WHERE id = ${legacyUploadId}::uuid
    `;
    const legacyContactId = await seedContact(legacyUploadId, daysAgoUtc(1), { consent: false });

    process.env.SOLICITATION_WATCH_ENABLED = 'true';
    const batch = await seedBatch();
    await expect(build(batch)).resolves.toMatchObject({
      status: 'built',
      candidateCount: 1,
      sendCount: 0,
      withholdCount: 1,
      withheldByReason: expect.objectContaining({ no_consent: 1 }),
    });

    const [ask] = await readAsks(batch.batchId);
    expect(ask).toMatchObject({
      contact_id: legacyContactId,
      status: 'withhold',
      withheld_reason: 'no_consent',
    });
    expect(parseAskEvidence(ask!.evidence)).toMatchObject({
      reason: 'no_consent',
      upload_id: null,
      attestation_version: null,
    });
  });

  it("evidence shape: both no_consent cases round-trip through parseEvidence and satisfy migration 090's CHECK", async () => {
    // Case (b): a real v1 ingest leaves a stale-version ledger row.
    const v1UploadId = await seedPendingUpload(
      `${CSV_HEADER}\nCase B,case-b@example.test,,${daysAgoUtc(1)},`,
      { attestationVersion: 'consent_attestation_v1' },
    );
    await ingestContactsCsvUpload(sql(), v1UploadId, businessId);
    // Case (a): a contact with NO ledger row at all.
    const bareUploadId = await seedCompletedUpload();
    const caseAContactId = await seedContact(bareUploadId, daysAgoUtc(1), { consent: false });

    process.env.SOLICITATION_WATCH_ENABLED = 'true';
    const batch = await seedBatch();
    // Both asks persist through the real writer — the INSERT succeeding is
    // what exercises 090's solicitation_asks_evidence_matches_columns CHECK.
    await expect(build(batch)).resolves.toMatchObject({
      status: 'built',
      candidateCount: 2,
      withholdCount: 2,
      withheldByReason: expect.objectContaining({ no_consent: 2 }),
    });

    // Round-trip through the real read model: parseEvidence is its parse boundary.
    const view = await readLatestBatch(sql(), tenant!.accountId, businessId, { sendLane: true });
    if (view.state !== 'built') throw new Error('expected a built batch view');
    const group = view.groups.find((candidate) => candidate.reason === 'no_consent');
    expect(group?.total).toBe(2);
    const byContact = new Map(group!.sample.map((row) => [row.contactId, row.evidence]));
    expect(byContact.get(caseAContactId)).toMatchObject({
      reason: 'no_consent',
      upload_id: null,
      attestation_version: null,
    });
    const caseBEvidence = [...byContact.entries()].find(([id]) => id !== caseAContactId)?.[1];
    expect(caseBEvidence).toMatchObject({
      reason: 'no_consent',
      upload_id: v1UploadId,
      attestation_version: 'consent_attestation_v1',
    });
  });

  it("a suppressed candidate is withheld with reason 'suppressed' carrying the ledger source and timestamp as evidence", async () => {
    // Attestation never overrides suppression (CONTEXT.md): this contact has a
    // send-eligible consent row and a fresh visit, so without the ledger row it
    // sends. Consent and suppression are independent inputs — the recipient's
    // revocation is what turns it into a withhold.
    const uploadId = await seedCompletedUpload();
    const contactId = await seedContact(uploadId, daysAgoUtc(1));
    const suppressedAt = await suppressHandle(contactEmail(contactId), 'complaint');

    process.env.SOLICITATION_WATCH_ENABLED = 'true';
    const batch = await seedBatch();
    await expect(build(batch)).resolves.toMatchObject({
      status: 'built',
      candidateCount: 1,
      sendCount: 0,
      withholdCount: 1,
      withheldByReason: expect.objectContaining({ suppressed: 1 }),
    });

    const [ask] = await readAsks(batch.batchId);
    expect(ask).toMatchObject({
      contact_id: contactId,
      status: 'withhold',
      withheld_reason: 'suppressed',
    });
    // The ledger's own source and timestamp, not a re-derivation: this is the
    // record that answers "why did this contact drop out of my list".
    expect(parseAskEvidence(ask!.evidence)).toMatchObject({
      reason: 'suppressed',
      suppression_source: 'complaint',
      suppressed_at: suppressedAt,
    });
  });

  it('a withheld-suppressed candidate does not consume BATCH_CAP', async () => {
    // Populate, do not pre-filter (§4.2), proven by arithmetic: BATCH_CAP clean
    // candidates plus one suppressed. A `WHERE suppression.source IS NULL` in
    // loadCandidateWindow would drop the suppressed contact out of the window
    // entirely — candidateCount BATCH_CAP, suppressed 0 — and the owner would
    // never learn why their list shrank. Counting it against the cap instead
    // would push eligible past BATCH_CAP and bank one real send.
    const uploadId = await seedCompletedUpload();
    const eligibleIds: string[] = [];
    for (let index = 0; index < BATCH_CAP; index++) {
      eligibleIds.push(await seedContact(uploadId, daysAgoUtc(1)));
    }
    const suppressedContactId = await seedContact(uploadId, daysAgoUtc(1));
    await suppressHandle(contactEmail(suppressedContactId), 'unsubscribe_link');

    process.env.SOLICITATION_WATCH_ENABLED = 'true';
    const batch = await seedBatch();
    await expect(build(batch)).resolves.toMatchObject({
      status: 'built',
      candidateCount: BATCH_CAP + 1,
      sendCount: BATCH_CAP,
      withholdCount: 1,
      withheldByReason: expect.objectContaining({
        suppressed: 1,
        velocity_banked: 0,
      }),
    });

    const asks = await readAsks(batch.batchId);
    expect(asks).toHaveLength(BATCH_CAP + 1);
    expect(asks.filter((ask) => ask.status === 'send').map((ask) => ask.contact_id).sort())
      .toEqual([...eligibleIds].sort());
    expect(asks.find((ask) => ask.contact_id === suppressedContactId)).toMatchObject({
      status: 'withhold',
      withheld_reason: 'suppressed',
    });
  });

  // ── #656 T6: the Send handoff ─────────────────────────────────────────────
  //
  // `buildSolicitationBatch` is ONE builder shared by watch-mode and send-mode,
  // so the postal-address / bounced-email precondition attaches to the
  // send-only seam — the `enqueueGenerateSolicitationAsks` call at the end of
  // construction — and never to `closedGateReason`. The batch still builds and
  // the Spoilage report is unchanged; only the handoff is withheld. (Spec §7.6
  // point 1's "no batch produced" predates the shared builder; T9 records the
  // override in the spec directory. The decision itself is on ticket #656 and
  // wayfinder map #617.)
  //
  // This is deliberately NOT a Withhold reason: that enum is closed,
  // precedence-ordered and versioned by RESTRAINT_POLICY_VERSION, and every
  // member is a PER-CANDIDATE decision, while this is one PER-LOCATION fact.
  //
  // The load-bearing cases:
  //
  //  - "still produces a watch-mode batch" is the watch-mode regression guard:
  //    status 'built', a NON-ZERO candidateCount, and an intact withheldByReason.
  //
  //  - "does not change any per-candidate decision or reason count" runs the
  //    IDENTICAL fixture cohort twice — once attested, once not — and compares
  //    the two withheldByReason maps and the two sendCount/withholdCount pairs
  //    for byte-identity. "No new key appeared" is insufficient: the failure
  //    mode is a candidate leaking into an existing bucket like no_consent.
  //
  //  - "an enqueue failure rolls back the batch build" makes
  //    enqueueGenerateSolicitationAsks throw and then asserts `built_at IS NULL`
  //    and zero ask rows. Still one transaction (invariant #2) — a built batch
  //    with no generation work is not a reachable state.
  //
  // The shared beforeAll business fixture inserts NO postal address, and the
  // flag-on case above asserts exactly one generation row — so it attests
  // first, and `afterEach` resets all five attestation columns plus
  // owner_email_bounced so these withheld-path cases cannot leak into it. The
  // result-SHAPE assertions there use toMatchObject and tolerate the new
  // sendHandoff field; it was the ENQUEUE assertion that needed the fixture.

  /** Both lanes on: watch-mode evaluates, and the Send handoff is live so the
   *  precondition is actually reached. */
  function enableWatchAndSend(): void {
    process.env.SOLICITATION_WATCH_ENABLED = 'true';
    process.env.SOLICITATION_SEND_ENABLED = 'true';
  }

  it('batch build still produces a watch-mode batch when the location has no attested postal address', async () => {
    enableWatchAndSend();
    const uploadId = await seedCompletedUpload();
    const sendableContactId = await seedContact(uploadId, daysAgoUtc(1));
    const withheldContactId = await seedContact(uploadId, daysAgoUtc(1), {
      consent: false,
    });
    const batch = await seedBatch();

    const result = builtBatch(await build(batch));

    // The regression guard for the whole task: no Attested postal address, and
    // the batch is STILL built, still evaluated the whole cohort, and still
    // reports its per-candidate reasons. Only the handoff is withheld.
    expect(result).toMatchObject({
      status: 'built',
      candidateCount: 2,
      sendCount: 1,
      withholdCount: 1,
      sendHandoff: { status: 'withheld', reason: 'postal_address_missing' },
    });
    expect(result.withheldByReason).toEqual({
      no_consent: 1,
      suppressed: 0,
      already_reviewed: 0,
      stale_visit: 0,
      over_contacted: 0,
      velocity_banked: 0,
    });
    expect(await readBuiltAt(batch.batchId)).not.toBeNull();
    // The authoritative asks are on disk, decision by decision — the Spoilage
    // report an owner reads is untouched by the withheld handoff.
    const asks = await readAsks(batch.batchId);
    expect(asks).toHaveLength(2);
    expect(asks.find((ask) => ask.contact_id === sendableContactId)).toMatchObject({
      status: 'send',
      withheld_reason: null,
    });
    expect(asks.find((ask) => ask.contact_id === withheldContactId)).toMatchObject({
      status: 'withhold',
      withheld_reason: 'no_consent',
    });
  });

  it('batch build withholds the send handoff when the location has no attested postal address', async () => {
    enableWatchAndSend();
    const uploadId = await seedCompletedUpload();
    await seedContact(uploadId, daysAgoUtc(1));
    const batch = await seedBatch();

    const result = builtBatch(await build(batch));

    expect(result.sendCount).toBe(1);
    expect(result.sendHandoff).toEqual({
      status: 'withheld',
      reason: 'postal_address_missing',
    });
  });

  it('batch build withholds the send handoff when owner_email_bounced is TRUE', async () => {
    enableWatchAndSend();
    // Address attested and current: the ONLY thing wrong with this location is
    // that its owner email hard-bounced (§2.4).
    await attestFixturePostalAddress();
    await setFixtureOwnerEmailBounced(true);
    const uploadId = await seedCompletedUpload();
    await seedContact(uploadId, daysAgoUtc(1));
    const batch = await seedBatch();

    const result = builtBatch(await build(batch));

    expect(result.sendCount).toBe(1);
    expect(result.sendHandoff).toEqual({
      status: 'withheld',
      reason: 'owner_email_bounced',
    });
    expect(await readGenerationOutboxRows(batch.batchId)).toHaveLength(0);
  });

  it('batch build withholds the send handoff when the location has no canonical place id (#914)', async () => {
    enableWatchAndSend();
    // The ONLY thing wrong with this location is its place id. Both shapes of
    // the fault: NULL, and migration 007's legacy hex CID (present but
    // `writereview?placeid=<hex cid>` resolves to nothing).
    await attestFixturePostalAddress();
    await setFixtureGooglePlaceId(null);
    const uploadId = await seedCompletedUpload();
    await seedContact(uploadId, daysAgoUtc(1));
    const nullBatch = await seedBatch();

    const nullResult = builtBatch(await build(nullBatch));
    expect(nullResult.sendCount).toBe(1);
    expect(nullResult.sendHandoff).toEqual({
      status: 'withheld',
      reason: 'google_place_id_missing',
    });
    // Withheld BEFORE any child exists: no generation row at any status, so no
    // contact is spent on the config fault and no BullMQ retry budget burns.
    expect(await readGenerationOutboxRows(nullBatch.batchId)).toEqual([]);
    expect(await readBuiltAt(nullBatch.batchId)).not.toBeNull();

    // Erase run 1's traces before run 2, exactly like the attested/unattested
    // comparison case below: leaving the asks in place would hand run 2 a
    // prior-contact history (`over_contacted`) and zero its sendCount, and a
    // zero-send batch never reaches the handoff at all.
    await sql()`DELETE FROM solicitation_asks WHERE business_id = ${businessId}::uuid`;
    await sql()`
      DELETE FROM agent_runs
      WHERE account_id = ${tenant!.accountId}::uuid
        AND kind IN ('solicitation_batch', 'solicitation_ask')
    `;
    await sql()`DELETE FROM solicitation_batches WHERE business_id = ${businessId}::uuid`;

    await setFixtureGooglePlaceId('0x89c258f1234567:0xabcdef12345678');
    const cidBatch = await seedBatch();
    const cidResult = builtBatch(await build(cidBatch));
    expect(cidResult.sendHandoff).toEqual({
      status: 'withheld',
      reason: 'google_place_id_missing',
    });
    expect(await readGenerationOutboxRows(cidBatch.batchId)).toEqual([]);
  });

  it('postal_address_missing wins when the postal address is missing and owner email has bounced', async () => {
    enableWatchAndSend();
    // BOTH facts are wrong. First-match precedence, and the postal address is
    // first because it is the CAN-SPAM one.
    await setFixtureOwnerEmailBounced(true);
    const uploadId = await seedCompletedUpload();
    await seedContact(uploadId, daysAgoUtc(1));
    const batch = await seedBatch();

    const result = builtBatch(await build(batch));

    expect(result.sendHandoff).toEqual({
      status: 'withheld',
      reason: 'postal_address_missing',
    });
  });

  it('a withheld send handoff creates no generate_solicitation_asks outbox row', async () => {
    enableWatchAndSend();
    const uploadId = await seedCompletedUpload();
    await seedContact(uploadId, daysAgoUtc(1));
    const batch = await seedBatch();

    const result = builtBatch(await build(batch));
    expect(result.sendHandoff).toMatchObject({ status: 'withheld' });

    // Nothing downstream can pick this batch up: no generation row exists at
    // ANY status, so there is no in-flight work and nothing for the OutboxPoller
    // to dispatch.
    expect(await readGenerationOutboxRows(batch.batchId)).toEqual([]);
    // …and the batch itself committed. A withheld handoff is not a failed build.
    expect(await readBuiltAt(batch.batchId)).not.toBeNull();
    expect(await readAsks(batch.batchId)).toHaveLength(1);
  });

  it('withholding the send handoff does not change any per-candidate decision or reason count', async () => {
    enableWatchAndSend();
    const uploadId = await seedCompletedUpload();
    const firstSendableId = await seedContact(uploadId, daysAgoUtc(1));
    const secondSendableId = await seedContact(uploadId, daysAgoUtc(2));
    const withheldId = await seedContact(uploadId, daysAgoUtc(1), {
      consent: false,
    });

    // Run 1: the IDENTICAL cohort, unattested.
    const unattestedBatch = await seedBatch();
    const unattested = builtBatch(await build(unattestedBatch));
    const unattestedAsks = await readAsks(unattestedBatch.batchId);

    // Erase every trace of run 1's evaluation before run 2. Leaving the asks in
    // place would give run 2 a prior-send history run 1 never had, and the two
    // cohorts would stop being comparable — `over_contacted` instead of `send`.
    await sql()`DELETE FROM solicitation_asks WHERE business_id = ${businessId}::uuid`;
    await sql()`
      DELETE FROM agent_runs
      WHERE account_id = ${tenant!.accountId}::uuid
        AND kind IN ('solicitation_batch', 'solicitation_ask')
    `;
    await sql()`DELETE FROM solicitation_batches WHERE business_id = ${businessId}::uuid`;

    // Run 2: same contacts, same visits, same consent — only the location-level
    // fact changed.
    await attestFixturePostalAddress();
    const attestedBatch = await seedBatch();
    const attested = builtBatch(await build(attestedBatch));
    const attestedAsks = await readAsks(attestedBatch.batchId);

    // The handoff is the ONLY field that moved. Comparing the rest with a single
    // toEqual is what makes "byte-identical" a claim rather than a hope:
    // asserting merely that no new key appeared would miss the real failure
    // mode, a candidate leaking into an existing bucket like no_consent.
    const { sendHandoff: unattestedHandoff, ...unattestedRest } = unattested;
    const { sendHandoff: attestedHandoff, ...attestedRest } = attested;
    expect(attestedRest).toEqual(unattestedRest);
    expect(unattestedHandoff).toEqual({
      status: 'withheld',
      reason: 'postal_address_missing',
    });
    expect(attestedHandoff).toEqual({ status: 'enqueued' });

    // And the same claim at the row level: every stored per-candidate decision
    // and reason is identical across the two runs.
    const decisionOf = (ask: StoredAskRow) => ({
      contact_id: ask.contact_id,
      status: ask.status,
      withheld_reason: ask.withheld_reason,
    });
    expect(attestedAsks.map(decisionOf)).toEqual(unattestedAsks.map(decisionOf));
    expect(unattestedAsks).toHaveLength(3);
    expect(
      unattestedAsks.filter((ask) => ask.status === 'send').map((ask) => ask.contact_id).sort(),
    ).toEqual([firstSendableId, secondSendableId].sort());
    expect(unattestedAsks.find((ask) => ask.contact_id === withheldId)).toMatchObject({
      withheld_reason: 'no_consent',
    });
  });

  it('batch build performs the send handoff when the address is attested and the owner email is deliverable', async () => {
    enableWatchAndSend();
    await attestFixturePostalAddress();
    const uploadId = await seedCompletedUpload();
    await seedContact(uploadId, daysAgoUtc(1));
    const batch = await seedBatch();

    const result = builtBatch(await build(batch));

    expect(result.sendCount).toBe(1);
    expect(result.sendHandoff).toEqual({ status: 'enqueued' });
    const generationRows = await readGenerationOutboxRows(batch.batchId);
    expect(generationRows).toHaveLength(1);
    expect(generationRows[0]).toMatchObject({ status: 'pending' });
  });

  it('a send-handoff enqueue failure rolls back the batch build', async () => {
    enableWatchAndSend();
    await attestFixturePostalAddress();
    const uploadId = await seedCompletedUpload();
    await seedContact(uploadId, daysAgoUtc(1));
    const batch = await seedBatch();
    enqueueFailure.error = new Error('generation enqueue unavailable');

    await expect(build(batch)).rejects.toThrow('generation enqueue unavailable');

    // The handoff is inside the built_at CAS transaction (invariant #2), so its
    // failure takes the whole build with it: a built batch whose generation work
    // was never enqueued is not a reachable state.
    expect(await readBuiltAt(batch.batchId)).toBeNull();
    expect(await readAsks(batch.batchId)).toHaveLength(0);
    expect(await readGenerationOutboxRows(batch.batchId)).toEqual([]);
  });

  // ── #1010 T3: `ask_withheld` ──────────────────────────────────────────────
  //
  // One Refusal per withheld ask whose reason maps to a **Refusal category**,
  // written by `commitAskDecisions` inside the transaction that inserts the
  // asks. The lane is the HIGHEST-VOLUME one in this slice — `loadCandidateWindow`
  // bounds the cohort at `MAX_DATA_ROWS` (5,000) and a rebuild re-evaluates the
  // whole accumulated pool — which is why it writes a SET rather than looping
  // the single-row helper.
  //
  // Retained attributed reviews drive already_reviewed through the real build.

  it.each(['new', null])('withholds an attributed reviewer and records dated evidence plus one refusal on replay (review status %s)', async (reviewStatus) => {
    process.env.SOLICITATION_WATCH_ENABLED = 'true';
    const contactId = await seedContact(await seedCompletedUpload(), daysAgoUtc(1));
    // The null-status case is outside the contact cooldown, so losing its
    // attributed review would actually make the contact eligible to send.
    const evidence = await seedAttributedReview(contactId, { ageDays: reviewStatus === null ? 90 : 2 });
    await sql()`UPDATE reviews SET status = ${reviewStatus} WHERE id = ${evidence.reviewId}::uuid`;
    const batch = await seedBatch();
    expect(builtBatch(await build(batch))).toMatchObject({
      candidateCount: 1, sendCount: 0, withholdCount: 1,
      withheldByReason: { already_reviewed: 1, over_contacted: 0 },
    });
    const [ask] = await readAsks(batch.batchId);
    expect(ask).toMatchObject({ contact_id: contactId, status: 'withhold', withheld_reason: 'already_reviewed' });
    expect(parseAskEvidence(ask!.evidence)).toMatchObject({
      reason: 'already_reviewed', review_id: evidence.reviewId, review_date: evidence.reviewDate,
    });
    const children = await sql()<{ id: string; status: string }[]>`
      SELECT child.id, child.status FROM agent_runs child
      JOIN solicitation_asks ask ON ask.agent_run_id = child.id
      WHERE ask.batch_id = ${batch.batchId}::uuid
    `;
    expect(children).toEqual([{ id: expect.any(String), status: 'completed' }]);
    const refusals = await readRefusals();
    expect(refusals).toEqual([expect.objectContaining({
      refusal_source: 'ask_withheld', refusal_code: 'already_reviewed',
      refusal_category: 'wrong_moment', account_id: tenant!.accountId, business_id: businessId,
    })]);
    const [join] = await readAskRefusalJoins();
    expect(join).toMatchObject({ ask_contact_id: contactId, exact: true });
    await expect(build(batch)).resolves.toEqual({ status: 'stale' });
    expect(await readAsks(batch.batchId)).toEqual([ask]);
    expect(await readRefusals()).toEqual(refusals);
    const repeatedChildren = await sql()`
      SELECT child.id, child.status FROM agent_runs child
      JOIN solicitation_asks ask ON ask.agent_run_id = child.id
      WHERE ask.batch_id = ${batch.batchId}::uuid
    `;
    expect(repeatedChildren).toEqual(children);
  });

  it('uses retained attribution beyond the attribution display window and picks the latest evidence', async () => {
    process.env.SOLICITATION_WATCH_ENABLED = 'true';
    const contactId = await seedContact(await seedCompletedUpload(), daysAgoUtc(1));
    await seedAttributedReview(contactId, { ageDays: 120 });
    const latest = await seedAttributedReview(contactId, { ageDays: 90 });
    const batch = await seedBatch();
    expect(builtBatch(await build(batch)).withheldByReason.already_reviewed).toBe(1);
    expect(parseAskEvidence((await readAsks(batch.batchId))[0]!.evidence)).toMatchObject({
      review_id: latest.reviewId, review_date: latest.reviewDate,
    });
  });

  it.each(['physical-delete', 'soft-delete', 'null-date', 'no-attribution'] as const)(
    'does not fabricate evidence for a deleted review or missing review date (%s)', async (missing) => {
      process.env.SOLICITATION_WATCH_ENABLED = 'true';
      const contactId = await seedContact(await seedCompletedUpload(), daysAgoUtc(1));
      const evidence = await seedAttributedReview(contactId, missing === 'null-date' ? { reviewDate: null } : {});
      if (missing === 'physical-delete') {
        await sql()`DELETE FROM reviews WHERE id = ${evidence.reviewId}::uuid`;
      } else if (missing === 'soft-delete') {
        await sql()`UPDATE reviews SET status = ${REVIEW_STATUS.DELETED} WHERE id = ${evidence.reviewId}::uuid`;
      } else if (missing === 'no-attribution') {
        await sql()`UPDATE solicitation_outreach SET attributed_review_id = NULL, attributed_at = NULL,
          attribution_rule = NULL, attribution_detail = NULL WHERE id = ${evidence.outreachId}::uuid`;
      }
      const batch = await seedBatch();
      expect(builtBatch(await build(batch))).toMatchObject({ sendCount: 1, withholdCount: 0 });
      expect(parseAskEvidence((await readAsks(batch.batchId))[0]!.evidence)).not.toHaveProperty('review_id');
      expect(await readRefusals()).toEqual([]);
    },
  );

  it.each(['sibling', 'another-account'] as const)(
    'does not match attributed reviews from another account or sibling location (%s)', async (scope) => {
      process.env.SOLICITATION_WATCH_ENABLED = 'true';
      const otherTenant = scope === 'another-account' ? await seedTenantAccount(sql()) : undefined;
      const otherBusinessId = randomUUID();
      await seedLocation(sql(), otherTenant?.accountId ?? tenant!.accountId, { businessId: otherBusinessId, isPrimary: false });
      try {
        const contactId = await seedContact(await seedCompletedUpload(), daysAgoUtc(1));
        // The attribution FK permits a foreign review pointer; the read must abstain.
        await seedAttributedReview(contactId, { reviewBusinessId: otherBusinessId });
        expect(builtBatch(await build(await seedBatch()))).toMatchObject({ sendCount: 1, withholdCount: 0 });
      } finally {
        await sql()`DELETE FROM reviews WHERE business_id = ${otherBusinessId}::uuid`;
        await sql()`DELETE FROM businesses WHERE id = ${otherBusinessId}::uuid`;
        if (otherTenant) await cleanupTenantAccount(sql(), otherTenant);
      }
    },
  );

  it.each(['no_consent', 'suppressed'] as const)(
    'preserves consent and suppression precedence for an attributed reviewer (%s)', async (reason) => {
      process.env.SOLICITATION_WATCH_ENABLED = 'true';
      const contactId = await seedContact(await seedCompletedUpload(), daysAgoUtc(1), { consent: reason !== 'no_consent' });
      await seedAttributedReview(contactId);
      await suppressHandle(contactEmail(contactId), 'complaint');
      const batch = await seedBatch();
      expect(builtBatch(await build(batch)).withheldByReason[reason]).toBe(1);
      expect((await readAsks(batch.batchId))[0]!.withheld_reason).toBe(reason);
      expect((await readRefusals())[0]!.refusal_code).toBe(reason);
    },
  );

  it('withholds an attributed reviewer while the refusal ledger is disabled', async () => {
    process.env.SOLICITATION_WATCH_ENABLED = 'true';
    process.env[REFUSAL_LEDGER_FLAG] = 'false';
    const contactId = await seedContact(await seedCompletedUpload(), daysAgoUtc(1));
    await seedAttributedReview(contactId);
    expect(builtBatch(await build(await seedBatch())).withheldByReason.already_reviewed).toBe(1);
    expect(await readRefusals()).toEqual([]);
  });

  it('a batch build writes one refusal_events row per withheld ask and none for a send decision', async () => {
    process.env.SOLICITATION_WATCH_ENABLED = 'true';
    const uploadId = await seedCompletedUpload();
    const sendableContactId = await seedContact(uploadId, daysAgoUtc(1));
    const withheldContactIds = [
      await seedContact(uploadId, daysAgoUtc(1), { consent: false }),
      await seedContact(uploadId, daysAgoUtc(1), { consent: false }),
    ];
    const batch = await seedBatch();

    const result = builtBatch(await build(batch));
    expect(result).toMatchObject({ candidateCount: 3, sendCount: 1, withholdCount: 2 });

    const refusals = await readRefusals();
    // TWO, never three: the send decision is not a Refusal. A writer that
    // recorded every DECISION rather than every WITHHOLD passes a count-only
    // assertion against an all-withheld fixture and fails here.
    expect(refusals).toHaveLength(2);
    for (const refusal of refusals) {
      expect(refusal).toMatchObject({
        refusal_source: 'ask_withheld',
        // The withheld reason VERBATIM, never normalised — the code is the
        // input that keeps skew re-derivable later.
        refusal_code: 'no_consent',
        refusal_category: ASK_WITHHELD_REFUSAL_CATEGORIES.no_consent,
        subject_type: 'solicitation_ask',
        // Per-location (C3), and the code axis is a single code (C4/C5).
        business_id: businessId,
        all_refusal_codes: null,
      });
    }

    // …and the two subjects are the two WITHHELD asks, not the send one.
    const asks = await readAsks(batch.batchId);
    const withheldAskIds = await sql()<{ id: string }[]>`
      SELECT id::text AS id FROM solicitation_asks
      WHERE batch_id = ${batch.batchId}::uuid AND status = 'withhold'
      ORDER BY id
    `;
    expect(refusals.map((row) => row.subject_id).sort())
      .toEqual(withheldAskIds.map((row) => row.id).sort());
    expect(asks.find((ask) => ask.contact_id === sendableContactId)?.status).toBe('send');
    expect(withheldContactIds).toHaveLength(2);
  });

  it('a batch build writes no refusal_events row for a velocity_banked withhold', async () => {
    // `velocity_banked` maps to `null`, and that is the ONE null in this lane's
    // map: a banked candidate is DEFERRED, not refused — the send caps held it
    // back for this build and it stays in the pool for the next one. Telling the
    // owner we declined to contact them would be false.
    process.env.SOLICITATION_WATCH_ENABLED = 'true';
    const uploadId = await seedCompletedUpload();
    for (let index = 0; index < BATCH_CAP + 2; index += 1) {
      await seedContact(uploadId, daysAgoUtc(1));
    }
    const batch = await seedBatch();

    const result = builtBatch(await build(batch));
    expect(result).toMatchObject({
      candidateCount: BATCH_CAP + 2,
      sendCount: BATCH_CAP,
      withholdCount: 2,
      withheldByReason: expect.objectContaining({ velocity_banked: 2 }),
    });

    // Two withheld asks exist and NEITHER is a Refusal.
    expect(await readRefusals()).toEqual([]);
  });

  it("a batch build stamps every ask Refusal with the batch's decidedAt, never with insert time", async () => {
    process.env.SOLICITATION_WATCH_ENABLED = 'true';
    const uploadId = await seedCompletedUpload();
    await seedContact(uploadId, daysAgoUtc(1), { consent: false });
    await seedContact(uploadId, daysAgoUtc(1), { consent: false });
    const batch = await seedBatch();

    // THE MEASUREMENT, not an assertion from memory. `refusal_events.created_at`
    // is `DEFAULT NOW()` and `NOW()` in Postgres is `transaction_timestamp()` —
    // transaction START. Holding the per-Business advisory key forces
    // construction's transaction to begin, block, and only then compute
    // `decidedAt`, so the two clocks are separated by the hold. Without the
    // hold they agree to within a millisecond and a writer stamping insert time
    // would pass.
    const lock = holdBatchLock('0.5 seconds');
    await lock.held;
    const [result] = await Promise.all([build(batch), lock.released]);
    const built = builtBatch(result);
    expect(built.withholdCount).toBe(2);

    const refusals = await readRefusals();
    expect(refusals).toHaveLength(2);

    // Every row carries the SAME decision time — one build is one decision, so
    // a per-row clock read would show two values.
    const stamps = new Set(refusals.map((row) => row.occurred_at));
    expect(stamps.size).toBe(1);
    // …and that time is the batch's own `built_at`, which `constructBatch`
    // stamps from the same `decidedAt`.
    expect([...stamps][0]).toBe(await readBuiltAt(batch.batchId));

    // The skew that proves it is not insert time. Migration 116 keeps
    // `created_at` for exactly this diagnostic.
    const [skew] = await sql()<{ min_skew_seconds: string }[]>`
      SELECT MIN(EXTRACT(EPOCH FROM (occurred_at - created_at)))::text AS min_skew_seconds
      FROM refusal_events
      WHERE account_id = ${tenant!.accountId}::uuid
    `;
    expect(Number(skew!.min_skew_seconds)).toBeGreaterThan(0.3);
  });

  it("an ask Refusal's occurred_at equals solicitation_asks.decided_at inside PostgreSQL at full microsecond precision", async () => {
    // Round-1 plan review R1-5. The comparison happens IN POSTGRES because
    // postgres.js decodes `timestamptz` to a JS `Date` and truncates
    // microseconds (#520) — an ask lane wrongly using transaction time could
    // compare EQUAL after truncation and this claim would be unfalsifiable.
    process.env.SOLICITATION_WATCH_ENABLED = 'true';
    const uploadId = await seedCompletedUpload();
    await seedContact(uploadId, daysAgoUtc(1), { consent: false });
    await seedContact(uploadId, daysAgoUtc(400), { consent: true });
    const batch = await seedBatch();

    expect(builtBatch(await build(batch)).withholdCount).toBe(2);

    const joins = await readAskRefusalJoins();
    expect(joins).toHaveLength(2);
    for (const join of joins) {
      expect(join.ask_id, 'every Refusal resolves to an ask row').not.toBeNull();
      expect(join.exact, `${join.occurred_at} !== ${join.decided_at}`).toBe(true);
      // The fixture is not vacuous: sub-second digits are actually present, so
      // the equality is not two whole seconds agreeing by accident.
      expect(join.occurred_at).toMatch(/\.\d{1,6}/);
    }
  });

  it('a batch build that withholds nothing writes no refusal_events row', async () => {
    // An INSERT with an empty row set is not a decision, so the set-based arm
    // issues no statement at all.
    process.env.SOLICITATION_WATCH_ENABLED = 'true';
    const uploadId = await seedCompletedUpload();
    await seedContact(uploadId, daysAgoUtc(1));
    await seedContact(uploadId, daysAgoUtc(1));
    const batch = await seedBatch();

    const result = builtBatch(await build(batch));
    expect(result).toMatchObject({ candidateCount: 2, sendCount: 2, withholdCount: 0 });

    expect(await readRefusals()).toEqual([]);
  });

  it('two builds evaluating the same contact write two refusal_events rows, one per decision', async () => {
    // Round-1 plan review R1-8's other half. The ask id is minted PER BUILD, so
    // `refusal_events_subject_uniq` does not collapse two builds into one
    // Refusal — each build is its own decision about the same contact. A writer
    // keyed on the CONTACT would leave one row here.
    process.env.SOLICITATION_WATCH_ENABLED = 'true';
    const uploadId = await seedCompletedUpload();
    const contactId = await seedContact(uploadId, daysAgoUtc(1), { consent: false });

    const first = await seedBatch();
    expect(builtBatch(await build(first)).withholdCount).toBe(1);
    const second = await seedBatch();
    expect(builtBatch(await build(second)).withholdCount).toBe(1);

    const refusals = await readRefusals();
    expect(refusals).toHaveLength(2);
    expect(new Set(refusals.map((row) => row.subject_id)).size).toBe(2);

    // Both point at THIS contact's asks, one per batch.
    const joins = await readAskRefusalJoins();
    expect(joins.map((join) => join.ask_contact_id)).toEqual([contactId, contactId]);
    expect(new Set(joins.map((join) => join.ask_batch_id)))
      .toEqual(new Set([first.batchId, second.batchId]));
  });

  it('every ask_withheld refusal points to the exact solicitation_ask row whose decision it records', async () => {
    // Round-1 plan review R1-8. Minting an unrelated fresh UUID per event also
    // produces one row per withhold and dodges the unique index — the two-builds
    // case above cannot tell the two apart. This one resolves the pointer.
    process.env.SOLICITATION_WATCH_ENABLED = 'true';
    const uploadId = await seedCompletedUpload();
    const noConsentContactId = await seedContact(uploadId, daysAgoUtc(1), { consent: false });
    const staleContactId = await seedContact(
      uploadId,
      daysAgoUtc(FRESHNESS_WINDOW_DAYS.automotive + 10),
    );
    const batch = await seedBatch();

    expect(builtBatch(await build(batch)).withholdCount).toBe(2);

    const joins = await readAskRefusalJoins();
    expect(joins).toHaveLength(2);
    const byContact = new Map(joins.map((join) => [join.ask_contact_id, join]));
    for (const [contactId, expectedReason] of [
      [noConsentContactId, 'no_consent'],
      [staleContactId, 'stale_visit'],
    ] as const) {
      const join = byContact.get(contactId);
      expect(join, `no Refusal resolved to contact ${contactId}`).toBeDefined();
      expect(join!.ask_batch_id).toBe(batch.batchId);
      expect(join!.ask_status).toBe('withhold');
      // The Refusal's own code and the ask's stored reason are the SAME fact,
      // read from two tables. A row pointing at the wrong ask fails here even
      // though its count and its timestamp are right.
      expect(join!.ask_withheld_reason).toBe(expectedReason);
      expect(join!.refusal_code).toBe(expectedReason);
    }
  });

  it('a 5000-candidate batch of mapped withholds writes 5000 refusal_events rows in one INSERT', async () => {
    // The ceiling, and the reason this lane writes a SET at all (plan §0 D-A,
    // corrected by round-1 finding R1-9). `MAX_DATA_ROWS` bounds the window at
    // 5,000, and the maximum MAPPED cohort is reached when every candidate fails
    // an individual gate — here `no_consent`, by seeding no ledger rows. The
    // all-eligible case is the OTHER one: its withholds are `velocity_banked`
    // and write nothing at all.
    process.env.SOLICITATION_WATCH_ENABLED = 'true';
    const uploadId = await seedCompletedUpload();
    await sql()`
      WITH contacts AS (
        INSERT INTO solicitation_contacts (
          id, business_id, name, email, created_by_upload_id
        )
        SELECT
          gen_random_uuid(), ${businessId}::uuid, 'Ceiling Candidate',
          'ceiling-' || n::text || '@example.test', ${uploadId}::uuid
        FROM generate_series(1, 5000) AS n
        RETURNING id
      )
      INSERT INTO solicitation_visits (
        id, contact_id, business_id, visit_date, upload_id
      )
      SELECT gen_random_uuid(), id, ${businessId}::uuid, ${daysAgoUtc(3)}::date, ${uploadId}::uuid
      FROM contacts
    `;
    const batch = await seedBatch();
    const { executor, queries } = recordingExecutor(sql());

    const result = builtBatch(await buildSolicitationBatch(executor, {
      batchId: batch.batchId,
      businessId,
      outboxId: batch.outboxId,
      attempt: batch.attempt,
      correlationId: 'batch-builder-refusal-ceiling',
    }));

    expect(result).toMatchObject({
      candidateCount: 5000,
      sendCount: 0,
      withholdCount: 5000,
      withheldByReason: expect.objectContaining({ no_consent: 5000 }),
    });

    const [count] = await sql()<{ total: number }[]>`
      SELECT COUNT(*)::int AS total FROM refusal_events
      WHERE account_id = ${tenant!.accountId}::uuid
    `;
    expect(count!.total).toBe(5000);

    // ONE statement. Round-1 finding R1-1: a loop over the single-row helper
    // produces exactly these 5,000 rows while issuing 5,000 sequential round
    // trips inside a transaction holding the per-Business advisory lock AND the
    // batch row lock, behind the `src/lib/db/admission.ts` chokepoint — and
    // every other assertion in this case passes on it.
    const inserts = queries.filter((query) => /INSERT INTO refusal_events/.test(query.text));
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.onTransaction, 'the ledger write rides the deciding transaction').toBe(true);
  });

  it('every solicitation refusal reason writes its verbatim code and mapped category, and every null-mapped reason writes nothing', async () => {
    // ONE TITLE, THREE INSTANCES — one per lane, in each lane's own suite (this
    // one, `dispatch.integration.test.ts`, `approval.integration.test.ts`).
    // Plan §1: the title "spans T3, T4 and T5 and closes with them". No single
    // suite can drive all three lanes' fixtures, and a case that covered one
    // lane while claiming all three would be the over-claim this title exists to
    // prevent. This instance owns the ASK lane.
    //
    // Round-1 finding R1-4: a call site could hard-code one valid code and one
    // valid category and stay green under every count and timestamp assertion,
    // filing every reason but the fixture's wrong.
    process.env.SOLICITATION_WATCH_ENABLED = 'true';
    const uploadId = await seedCompletedUpload();

    const noConsentContactId = await seedContact(uploadId, daysAgoUtc(1), { consent: false });
    const suppressedContactId = await seedContact(uploadId, daysAgoUtc(1));
    await suppressHandle(contactEmail(suppressedContactId), 'complaint');
    const staleContactId = await seedContact(
      uploadId,
      daysAgoUtc(FRESHNESS_WINDOW_DAYS.automotive + 10),
    );
    const overContactedContactId = await seedContact(uploadId, daysAgoUtc(1));
    await seedPriorAsk({
      contactId: overContactedContactId,
      status: 'send',
      decidedAt: new Date(Date.now() - (MIN_GAP_DAYS - 5) * 86_400_000).toISOString(),
    });
    // Past BATCH_CAP so the surplus banks — the lane's ONE null-mapped reason.
    for (let index = 0; index < BATCH_CAP + 1; index += 1) {
      await seedContact(uploadId, daysAgoUtc(1));
    }

    const batch = await seedBatch();
    const result = builtBatch(await build(batch));
    expect(result.withheldByReason).toMatchObject({
      no_consent: 1,
      suppressed: 1,
      stale_visit: 1,
      over_contacted: 1,
      velocity_banked: 1,
      // Unreachable through the builder — see below.
      already_reviewed: 0,
    });

    const joins = await readAskRefusalJoins();
    const refusalByContact = new Map(joins.map((join) => [join.ask_contact_id, join]));
    const categoryByCode = new Map(
      (await readRefusals()).map((row) => [row.refusal_code, row.refusal_category]),
    );

    for (const [contactId, reason] of [
      [noConsentContactId, 'no_consent'],
      [suppressedContactId, 'suppressed'],
      [staleContactId, 'stale_visit'],
      [overContactedContactId, 'over_contacted'],
    ] as const) {
      const join = refusalByContact.get(contactId);
      expect(join, `${reason} produced no Refusal`).toBeDefined();
      // VERBATIM — the ask's stored reason and the Refusal's code are the same
      // string, and the category is the one this lane's map assigns it.
      expect(join!.refusal_code).toBe(reason);
      expect(join!.ask_withheld_reason).toBe(reason);
      expect(categoryByCode.get(reason)).toBe(ASK_WITHHELD_REFUSAL_CATEGORIES[reason]);
    }

    // The NULL-mapped reason wrote nothing at all: five withholds, four
    // Refusals.
    expect(result.withholdCount).toBe(5);
    expect(joins).toHaveLength(4);
    expect(joins.map((join) => join.refusal_code)).not.toContain('velocity_banked');

    // The retained-attribution cases above cover already_reviewed; this case
    // drives the other gates. Keep the closed enum covered across both sets.
    expect(ASK_WITHHELD_REFUSAL_CATEGORIES.already_reviewed).toBe('wrong_moment');
    const covered = new Set<WithholdReason>([
      'no_consent',
      'suppressed',
      'stale_visit',
      'over_contacted',
      'velocity_banked',
      'already_reviewed',
    ]);
    expect([...WITHHOLD_REASONS].filter((reason) => !covered.has(reason))).toEqual([]);
  });

  it("every refusal_events row these three lanes write carries the account and location already in the lane's scope", async () => {
    // ONE TITLE, THREE INSTANCES — see the note on the exhaustive-reason case
    // above. This instance owns the ASK lane.
    //
    // No lane resolves a tenant key it does not hold: the builder already has
    // both, off the locked batch row, and a Refusal that re-derived either
    // (through `businesses`, say) is the fan-out defect the parent effort hit.
    process.env.SOLICITATION_WATCH_ENABLED = 'true';
    const uploadId = await seedCompletedUpload();
    await seedContact(uploadId, daysAgoUtc(1), { consent: false });
    await seedContact(uploadId, daysAgoUtc(1), { consent: false });
    const batch = await seedBatch();

    expect(builtBatch(await build(batch)).withholdCount).toBe(2);

    const refusals = await readRefusals();
    expect(refusals).toHaveLength(2);
    for (const refusal of refusals) {
      expect(refusal.account_id).toBe(tenant!.accountId);
      // NOT NULL: C3 makes a null location mean "account-wide", which this lane
      // is not.
      expect(refusal.business_id).toBe(businessId);
    }
  });

  it('a ledger failure in the ask lane rolls back the whole batch build', async () => {
    process.env.SOLICITATION_WATCH_ENABLED = 'true';
    const uploadId = await seedCompletedUpload();
    await seedContact(uploadId, daysAgoUtc(1), { consent: false });
    const batch = await seedBatch();

    const original = { ...askWithheldCategories };
    // A writer bug: a category migration 116's CHECK does not admit. The helper
    // does NOT catch it — `ON CONFLICT` covers duplicate keys only — and a CHECK
    // violation must abort the decision, because catching it would hide the bug
    // in the one place the ledger cannot report it.
    askWithheldCategories.no_consent = 'a_category_the_ledger_never_named';
    try {
      await expect(build(batch)).rejects.toMatchObject({
        code: CHECK_VIOLATION,
        constraint_name: expect.stringContaining('refusal_events'),
      });
    } finally {
      for (const key of Object.keys(askWithheldCategories)) delete askWithheldCategories[key];
      Object.assign(askWithheldCategories, original);
    }

    // EVERYTHING construction wrote is gone: the asks, their child runs, the
    // `built_at` stamp and the outbox completion — one transaction, invariant #2.
    expect(await readBuiltAt(batch.batchId)).toBeNull();
    expect(await readAsks(batch.batchId)).toHaveLength(0);
    expect(await readRefusals()).toEqual([]);
    const [childRuns] = await sql()<{ total: number }[]>`
      SELECT COUNT(*)::int AS total FROM agent_runs
      WHERE account_id = ${tenant!.accountId}::uuid AND kind = 'solicitation_ask'
    `;
    expect(childRuns!.total).toBe(0);
    const [outbox] = await sql()<{ status: string }[]>`
      SELECT status FROM job_outbox WHERE id = ${batch.outboxId}::uuid
    `;
    expect(outbox!.status).toBe('dispatched');
  });

  it('all three lanes complete their decisions unchanged when REFUSAL_LEDGER_ENABLED is false', async () => {
    // ONE TITLE, THREE INSTANCES — see the note on the exhaustive-reason case
    // above. This instance owns the ASK lane.
    //
    // The comparison is against a REAL flag-on build of the identical cohort,
    // not against a hand-written expectation: "unchanged" is a claim about two
    // runs agreeing, and a literal only ever proves the literal.
    process.env.SOLICITATION_WATCH_ENABLED = 'true';
    const uploadId = await seedCompletedUpload();
    // EVERY candidate withholds, and every one of them for a reason that is not
    // history-dependent. A cohort containing a `send` would make the SECOND
    // build's decisions legitimately different — the first build's
    // would-have-sent ask becomes `over_contacted` history — and the comparison
    // below would be measuring the restraint policy rather than the kill switch.
    for (let index = 0; index < 3; index += 1) {
      await seedContact(uploadId, daysAgoUtc(1), { consent: false });
    }

    const ledgerOn = builtBatch(await build(await seedBatch()));
    expect(await readRefusals()).toHaveLength(3);
    await sql()`DELETE FROM refusal_events WHERE account_id = ${tenant!.accountId}::uuid`;

    process.env[REFUSAL_LEDGER_FLAG] = 'false';
    const offBatch = await seedBatch();
    const ledgerOff = builtBatch(await build(offBatch));

    // Byte-identical decisions.
    expect(ledgerOff.candidateCount).toBe(ledgerOn.candidateCount);
    expect(ledgerOff.sendCount).toBe(ledgerOn.sendCount);
    expect(ledgerOff.withholdCount).toBe(ledgerOn.withholdCount);
    expect(ledgerOff.withheldByReason).toEqual(ledgerOn.withheldByReason);

    // The batch is BUILT and its asks are stored — the switch stops the ledger
    // and nothing else.
    expect(await readBuiltAt(offBatch.batchId)).not.toBeNull();
    expect(await readAsks(offBatch.batchId)).toHaveLength(3);
    expect(await readRefusals()).toEqual([]);
  });
});
