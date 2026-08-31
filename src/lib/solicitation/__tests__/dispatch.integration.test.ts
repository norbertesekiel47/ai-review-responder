// Live-DB suite for the Solicitation send worker's dispatch lane (#899 Task 0 —
// the eval task). Twenty-six cases, every one of them a claim about rows that
// only real Postgres can settle: the seven-item Dispatch gate's withheld
// reasons, the unsubscribe token mint, the `queued → sending → sent` CAS, the
// single transaction that commits every terminal fact at once, and — since the
// 2026-08-22 guard-integrity pass — the lane's integrity spine.
//
// CONVENTIONS THIS FILE IS BOUND BY
//
//   * The `*.integration.test.ts` NAME is load-bearing — it is what selects
//     vitest's serialized `integration` project. A live-DB suite outside that
//     glob runs in the fully parallel project against every other live-DB
//     writer (`ci:live-db-suites` R1).
//   * NO RUN-TIME DDL — not a CREATE, not an ALTER, not a temporary CHECK
//     constraint. DDL takes ACCESS EXCLUSIVE on a shared relation and deadlocks
//     (40P01) against siblings holding ordinary row locks in the other order,
//     and the victim is whichever transaction Postgres picks, so the failure
//     lands somewhere unrelated and reads as flake (`ci:live-db-suites` R2).
//     `pnpm test:db:setup` provisions the schema; this file ASSERTS it with
//     `assertSchemaReady`. To force a transaction abort — which test 16's
//     all-or-nothing claim needs — use `helpers/abort-injection.ts`'s
//     `abortingExecutor`, whose poison is a real Postgres error and which
//     leaves nothing behind on a vitest timeout. Never a temporary constraint.
//   * Every lifecycle timestamp is written as a SQL interval off `NOW()`, never
//     as a JS `Date`: postgres.js truncates timestamptz microseconds, so a
//     JS-derived stamp can land before the `NOW()`-defaulted column it must not
//     precede and trip a constraint unrelated to the case under test (#520).
//
// All twenty-six cases are live — no `it.todo` remains. `seedQueuedOutreach`
// is the ONE fixture chain (upload → contact → batch → send Ask → queued
// Outreach row → dispatched outbox row); extend it rather than building a
// second. Note `solicitation_batches_one_active_send_per_business` (D8) admits
// only one approved-and-unclosed batch per location, so seeding a sibling batch
// means retiring the previous one — the fixture already does this.

import { randomUUID } from 'node:crypto';
import { REFUSAL_LEDGER_FLAG } from '@/lib/refusals/write';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import type postgresType from 'postgres';
import type { ModerationDecision } from '@/lib/moderation/output-filter';
import { describeWithDb } from '@/__tests__/helpers/describe-with-db';
import { resetServerConfigForTests } from '@/lib/config/server';
import { resetWorkerConfigForTests } from '@/lib/config/worker';
import { startOrGetSolicitationSendBatchRun } from '@/lib/agents/run-spine';
import { QUEUE_NAMES } from '@/lib/shared/queue-names';
import { abortingExecutor } from '@/lib/shared/__tests__/helpers/abort-injection';
import { checksum, insertOutreach } from '@/lib/shared/__tests__/helpers/outreach-fixture';
import {
  acquireLiveDbLock,
  assertLocalTestDatabaseUrl,
  LIVE_DB_LOCK_HOOK_TIMEOUT_MS,
  resolveTestDatabaseUrl,
  type LiveDbLock,
} from '@/lib/shared/__tests__/helpers/live-db-lock';
import {
  assertSchemaReady,
  MIGRATION_091_SEND_MODE_SPINE_LIFECYCLE,
  MIGRATION_093_SOLICITATION_CONSENT,
  MIGRATION_096_SOLICITATION_SUPPRESSIONS,
  MIGRATION_099_SOLICITATION_POSTAL_ADDRESS,
  MIGRATION_108_OUTREACH_OWNER_EXCLUDED,
  MIGRATION_110_SEND_GOVERNORS,
} from '@/lib/shared/__tests__/helpers/schema-ready';
import {
  cleanupTenantAccount,
  seedLocation,
  seedTenantAccount,
  type TenantSeed,
} from '@/lib/shared/__tests__/live-db-tenant';
import { OUTREACH_WITHHELD_DISPATCH_REFUSAL_CATEGORIES } from '@/lib/refusals/vocabulary';
import type { AskInterpolationInputs } from '../ask-prompt-policy';
import {
  assembleAskBody,
  REVIEW_LINK_PLACEHOLDER,
  UNSUBSCRIBE_URL_PLACEHOLDER,
} from '../ask-render';
import { haltBatch, type HaltBatchResult } from '../approval';
import { acquireSolicitationBatchLock } from '../batch-builder';
import { CONSENT_ATTESTATION_VERSION } from '../attestation';
import { dispatchOutreach } from '../dispatch';
import { closeBatchIfSettled } from '../outreach';
import { POSTAL_ADDRESS_ATTESTATION_VERSION } from '../postal-address';
import {
  hashUnsubscribeToken,
  isWellFormedUnsubscribeToken,
  mintUnsubscribeRawToken,
} from '../unsubscribe';

// ── Three seams stubbed, and only three ──────────────────────────────────────
//
// The **Messaging adapter**, reached through `getMessagingAdapter()` so the stub
// sits at the seam and never at `EmailAdapter` or a Resend client. It is both
// the provider under test — its answer is what tx2 records — and the spy that
// proves decision 9's refusal path never reaches a provider at all.
const messagingMocks = vi.hoisted(() => ({
  send: vi.fn<(message: unknown) => Promise<{ providerMessageId: string }>>(),
}));
vi.mock('@/lib/messaging/messaging-adapter', () => ({
  getMessagingAdapter: () => ({ send: messagingMocks.send }),
}));

// The moderation provider — a REMOTE call, and the one collaborator a live-DB
// suite must not make for real. The default delegates to the production
// function so every gate case below keeps the verdict it was written against
// (with the provider off, that is a REFUSAL — §3.4 makes a clean provider
// verdict a dispatch precondition). Only the mint cases, whose subject is what
// happens AFTER the gate passes, swap in a clean verdict.
const moderationMocks = vi.hoisted(() => ({
  moderateResponse: vi.fn<(text: string) => Promise<ModerationDecision>>(),
  real: { current: null as null | ((text: string) => Promise<ModerationDecision>) },
}));
vi.mock('@/lib/moderation/moderate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/moderation/moderate')>();
  moderationMocks.real.current = actual.moderateResponse;
  return { moderateResponse: moderationMocks.moderateResponse };
});

// The **run spine**'s step writer, WRAPPED rather than replaced — the one seam
// this file adds beyond the two above, and it exists for exactly one case.
//
// The `queued → sending` CAS cannot be raced from a second connection:
// `runDispatchTx` holds the Outreach row `FOR UPDATE` from the triage read all
// the way to the CAS, so a competing UPDATE blocks until the transaction
// commits and the predicate is unreachable from outside. Staging that race
// therefore means writing on the SAME transaction, and `recordStep` is the ONE
// importable collaborator `dispatch.ts` hands `tx` to between the triage and
// the claim.
//
// The default is a pass-through, so every other case in this file is untouched.
const runSpineMocks = vi.hoisted(() => ({
  onRecordStep: {
    current: null as
      | null
      | ((tx: postgresType.TransactionSql, input: { stepKey: string }) => Promise<void>),
  },
}));
vi.mock('@/lib/agents/run-spine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/agents/run-spine')>();
  return {
    ...actual,
    recordStep: async (
      tx: postgresType.TransactionSql,
      input: Parameters<typeof actual.recordStep>[1],
    ): Promise<void> => {
      await runSpineMocks.onRecordStep.current?.(tx, input);
      return actual.recordStep(tx, input);
    },
  };
});

// ── #1010 T4: the `outreach_withheld` DISPATCH lane's Refusal write site ─────
//
// WHY THE VOCABULARY MODULE IS MOCKED. One case here forces a REAL ledger
// rejection from the REAL helper inside tx1 — a mocked-away writer would prove
// only that a stub can reject, and every other case supplies valid input.
// Bending ONE map entry to a category migration 116's CHECK does not admit makes
// the INSERT violate `refusal_events_refusal_category_check`, which is the
// writer bug the design says must abort the decision rather than be caught.
//
// The stand-in map is DERIVED from the real one inside the factory, never
// re-typed: every other case must run against the production vocabulary. Same
// shape as `src/lib/auto-approval/__tests__/suspension.integration.test.ts`.
const { outreachWithheldCategories } = vi.hoisted(() => ({
  outreachWithheldCategories: {} as Record<string, string>,
}));

vi.mock('@/lib/refusals/vocabulary', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/refusals/vocabulary')>();
  Object.assign(outreachWithheldCategories, actual.OUTREACH_WITHHELD_DISPATCH_REFUSAL_CATEGORIES);
  return {
    ...actual,
    OUTREACH_WITHHELD_DISPATCH_REFUSAL_CATEGORIES: outreachWithheldCategories,
  };
});

/** The default-ON kill switch. Only the literal string 'false' disables it. */

/** Postgres' CHECK-violation SQLSTATE. */
const CHECK_VIOLATION = '23514';

/** The clean provider verdict. A CONSTANT rather than an inline literal because
 *  two of the integrity cases install their own `mockImplementation` — they
 *  write to Postgres from inside the provider call — and so cannot go through
 *  `withCleanModeration`, which sets a resolved VALUE. */
const CLEAN_MODERATION: ModerationDecision = {
  flagged: false,
  severity: 'low',
  reason: null,
  categories: { openai_moderation: 'clean' },
  score: 0,
  source: null,
  providerStatus: 'clean',
};

const testDatabaseUrl = resolveTestDatabaseUrl();

/** The location under test. One `businesses` row = one Google Business Profile
 *  location, and the Dispatch gate's postal-address item is a fact about it. */
const businessId = randomUUID();

let db: postgresType.Sql | undefined;
let featureDatabaseLock: LiveDbLock | undefined;
let tenant: TenantSeed | undefined;

/** The seeded handles, narrowed. `beforeAll` runs before any case, so an
 *  `undefined` here is a bug in this file rather than a state a case handles. */
function sql(): postgresType.Sql {
  if (!db) throw new Error('live-DB handle used before beforeAll');
  return db;
}

function accountId(): string {
  if (!tenant) throw new Error('tenant seed used before beforeAll');
  return tenant.accountId;
}

function userId(): string {
  if (!tenant) throw new Error('tenant seed used before beforeAll');
  return tenant.userId;
}

/**
 * One queued **Outreach row** with the whole chain it needs — upload → contact
 * → batch → send **Ask** → the row — plus the `dispatched` `job_outbox` row
 * this worker owns the attempt of.
 *
 * Every stamp is a SQL interval off `NOW()`, never a JS `Date` (see the
 * header): 091 requires `queued_at` of every dispatched status, and a
 * JS-derived stamp truncated to milliseconds can land before the `NOW()`
 * default it must not precede.
 */
interface QueuedOutreachFixture {
  batchId: string;
  askId: string;
  outreachId: string;
  outboxId: string;
  attempt: number;
  /** The contact's **Normalized handle** — what both ledgers key on. */
  handle: string;
}

/**
 * The address the fixture bakes into the stored body. `assembleAskBody` puts it
 * in VERBATIM as its own line, and the Dispatch gate's byte-match is a
 * containment test against exactly those bytes — so the mismatch case moves the
 * BUSINESS's attested address afterwards and leaves the stored body alone,
 * which is the shape the real defect takes (an owner edits their address after
 * approval).
 */
const SEEDED_POSTAL_ADDRESS = '742 Evergreen Terrace\nSpringfield, IL 62704';

/** Deliberately not `consent_attestation_v2`: `SEND_ELIGIBLE_ATTESTATION_VERSIONS`
 *  omits v1 because its text disclaimed sending, and the gate is a MEMBERSHIP
 *  test against that list rather than a "not v1" test. */
const STALE_ATTESTATION_VERSION = 'consent_attestation_v1';

/** Canonical per `isPlaceId`. `seedLocation` leaves `google_place_id` NULL, and
 *  an unbuildable review link THROWS (rulings 2/3) — so the send path needs a
 *  location that carries one. */
const SEEDED_PLACE_ID = 'ChIJdispatchLiveDb0000000000';

/** Pinned, not inherited: the unsubscribe URL is built from this, and the
 *  "never written to Postgres" claim is a claim about exactly this prefix. */
const APP_URL = 'https://dispatch-live.test';

/** ≥32 bytes — `mintUnsubscribeRawToken` signs with it and
 *  `isWellFormedUnsubscribeToken` verifies against it. */
const SESSION_SECRET = 'dispatch-live-db-session-secret-0123456789';

const priorEnv = {
  appUrl: process.env.NEXT_PUBLIC_APP_URL,
  sessionSecret: process.env.SESSION_COOKIE_SECRET,
};

/** The subject stored on the fixture row. Lint-clean by construction: short,
 *  one clause, no URL, no digits, no disallowed interpolated value. */
const SEEDED_SUBJECT = 'How did we do?';

/** The model-authored half of the stored body, before `assembleAskBody` adds the
 *  footer. Lint-clean: no incentive, no steering, no capitalized token that the
 *  §2.4 provenance corpus cannot account for. */
const SEEDED_LLM_BODY = 'Thanks for stopping by — would you mind leaving us a review?';

/**
 * The §5.3 `interpolation_inputs` snapshot the render persisted, and therefore
 * the ONLY corpus the dispatch-time re-lint is allowed to replay against — the
 * live ask row may have moved since approval, and re-deriving from it is exactly
 * what would break the byte-for-byte **Owner approval** contract this gate
 * protects. `business_name` matches the fixture's `assembleAskBody` argument.
 */
const SEEDED_INTERPOLATION_INPUTS = {
  contact_first_name: 'Dana',
  business_name: 'Dispatch Business',
  days_since_visit_bucket: 'last week',
  vertical: 'other',
  visit_note: null,
  note_disposition: 'absent',
  // `satisfies`, not an annotation: the interface carries no index signature, so
  // an annotated constant would not be assignable to the fixture's JSONB
  // parameter while still being checked against the real snapshot shape.
} satisfies AskInterpolationInputs;

/** What the Consent ledger says about the seeded handle at dispatch. */
type ConsentFixture = 'send_eligible' | 'stale_attestation' | 'absent';

interface SeedQueuedOutreachOptions {
  consent?: ConsentFixture;
  /**
   * Attach this row to an EXISTING batch instead of minting a fresh one.
   *
   * The batch-closure cases need SEVERAL Outreach rows on ONE batch, and D8's
   * `solicitation_batches_one_active_send_per_business` admits one
   * approved-and-unclosed batch per location — so a second call that minted its
   * own batch would retire the first, which is the very closure fact those
   * cases are about. When present, the retire step, the batch INSERT and the
   * **Send batch parent** mint are all skipped: that batch already has all
   * three. Everything else — upload, contact, consent, ask, Outreach row,
   * outbox row — is seeded exactly as it is for a fresh batch, so this stays
   * ONE fixture chain rather than a second one.
   */
  batchId?: string;
  /** The model-authored body the fixture assembles the footer onto. */
  llmBody?: string;
  /**
   * The stored snapshot. `{}` is one of the two LEGAL empty states migration 092
   * and locked decision 6 produce (a redacted row, a never-assembled
   * `render_failed` row) — `parseOutreachInterpolationInputs` reads it as null,
   * which is the case "withholds rather than sending…" drives.
   */
  interpolationInputs?: Record<string, unknown>;
}

async function seedQueuedOutreach(
  options: SeedQueuedOutreachOptions = {},
): Promise<QueuedOutreachFixture> {
  const uploadId = randomUUID();
  await sql()`
    INSERT INTO contact_csv_uploads (
      id, account_id, business_id, filename, byte_size, content_sha256,
      raw_csv, status, report, attested_by_user_id, attested_at,
      attestation_version, completed_at
    ) VALUES (
      ${uploadId}::uuid, ${accountId()}::uuid, ${businessId}::uuid,
      ${`dispatch-${uploadId}.csv`}, 1, ${checksum(uploadId)},
      NULL, 'completed', ${sql().json({ accepted: 1 })},
      ${userId()}::uuid, NOW(), 'dispatch-test', NOW()
    )
  `;

  const contactId = randomUUID();
  const handle = `${contactId}@example.test`;
  await sql()`
    INSERT INTO solicitation_contacts (
      id, business_id, name, email, created_by_upload_id
    ) VALUES (
      ${contactId}::uuid, ${businessId}::uuid, 'Dispatch Candidate',
      ${handle}, ${uploadId}::uuid
    )
  `;

  const consent = options.consent ?? 'send_eligible';
  if (consent !== 'absent') {
    await sql()`
      INSERT INTO solicitation_consent (
        id, channel, normalized_handle, business_id, basis,
        attestation_version, attested_at, attested_by_user_id, source_upload_id
      ) VALUES (
        ${randomUUID()}::uuid, 'email', ${handle}, ${businessId}::uuid,
        'owner_attested',
        ${consent === 'send_eligible' ? CONSENT_ATTESTATION_VERSION : STALE_ATTESTATION_VERSION},
        NOW() - INTERVAL '1 day', ${userId()}::uuid, ${uploadId}::uuid
      )
    `;
  }

  const attachedBatchId = options.batchId;
  const batchId = attachedBatchId ?? randomUUID();

  if (attachedBatchId === undefined) {
    // D8's `solicitation_batches_one_active_send_per_business` admits ONE
    // approved-and-unclosed batch per location, so every fixture retires the
    // previous one. Closing rather than halting keeps the halt latch's own case
    // (test: "no-ops when the batch is halted…") the only halted batch in play.
    await sql()`
      UPDATE solicitation_batches
      SET send_closed_at = NOW()
      WHERE business_id = ${businessId}::uuid
        AND approved_at IS NOT NULL
        AND send_closed_at IS NULL
        AND halted_at IS NULL
    `;

    // Approved, past its veto window, inside the 72h send window and already
    // dripping — `deriveBatchState` reads `sending`, which with `approved`
    // is the only pair the Dispatch gate's batch_open item lets through.
    await sql()`
      INSERT INTO solicitation_batches (
        id, account_id, business_id, source_upload_id, created_at, built_at,
        approved_at, approval_method, approved_by_user_id, veto_deadline_at,
        sending_started_at
      ) VALUES (
        ${batchId}::uuid, ${accountId()}::uuid, ${businessId}::uuid,
        ${uploadId}::uuid, NOW() - INTERVAL '3 hours', NOW() - INTERVAL '2 hours',
        NOW() - INTERVAL '90 minutes', 'owner', ${userId()}::uuid,
        NOW() - INTERVAL '60 minutes', NOW() - INTERVAL '45 minutes'
      )
    `;
  }

  const askId = randomUUID();
  await sql()`
    INSERT INTO solicitation_asks (
      id, account_id, business_id, batch_id, contact_id, status,
      withheld_reason, evidence, decided_at
    ) VALUES (
      ${askId}::uuid, ${accountId()}::uuid, ${businessId}::uuid,
      ${batchId}::uuid, ${contactId}::uuid, 'send', NULL,
      ${sql().json({
        contact_id: contactId,
        policy_version: 'dispatch-fixture',
        decision: 'send',
      })},
      NOW() - INTERVAL '1 hour'
    )
  `;

  // The real assembler, not a hand-rolled string: the postal byte-match is a
  // claim about the bytes `assembleAskBody` emits, so a fixture that spelled
  // its own footer would prove the check against a shape nothing ships.
  const renderedBody = assembleAskBody(
    options.llmBody ?? SEEDED_LLM_BODY,
    { businessName: 'Dispatch Business', postalAddress: SEEDED_POSTAL_ADDRESS },
  );
  if (renderedBody === null) {
    throw new Error('fixture: assembleAskBody refused the seeded postal address');
  }

  const outreachId = await insertOutreach(sql(), {
    accountId: accountId(),
    businessId,
    batchId,
    askId,
    contactId,
    renderedSubject: SEEDED_SUBJECT,
    renderedBody,
    interpolationInputs: options.interpolationInputs ?? SEEDED_INTERPOLATION_INPUTS,
    deliveryStatus: 'queued',
    renderedAt: sql()`NOW() - INTERVAL '30 minutes'`,
    queuedAt: sql()`NOW() - INTERVAL '30 seconds'`,
  });

  // `aggregate_id` is the OUTREACH id here, not the batch id — that is
  // migration 091's `job_outbox_solicitation_send_inflight` contract, and it is
  // what makes one in-flight dispatch per row rather than per batch.
  const outboxId = randomUUID();
  await sql()`
    INSERT INTO job_outbox (
      id, topic, aggregate_type, aggregate_id, payload,
      status, attempts, dispatched_at
    ) VALUES (
      ${outboxId}::uuid, ${QUEUE_NAMES.SOLICITATION_SEND}, 'solicitation_outreach',
      ${outreachId}::uuid,
      ${sql().json({ batch_id: batchId, business_id: businessId, outreach_id: outreachId })},
      'dispatched', 1, NOW()
    )
  `;

  // The **Send batch parent** the generation lane mints. The send worker looks
  // it up and NEVER creates one, so a fixture without it is not "a batch with
  // no parent" — it is the impossible state `dispatchOutreach` throws on. An
  // attached row inherits the one its batch already carries.
  if (attachedBatchId === undefined) {
    await sql().begin(async (tx) => {
      await startOrGetSolicitationSendBatchRun(tx, {
        batchId,
        accountId: accountId(),
        businessId,
        correlationId: `dispatch-fixture-${batchId}`,
      });
    });
  }

  return { batchId, askId, outreachId, outboxId, attempt: 1, handle };
}

/**
 * The location's attested postal address, written as the all-or-nothing
 * five-column unit migration 099's CHECK requires. `null` clears the whole
 * attestation — the state gate item 6 calls `no_postal_address`.
 *
 * The digest is computed IN SQL from the same bytes, exactly as
 * `attestPostalAddress` does: `businesses_solicitation_postal_address_digest`
 * binds the two together, so a fabricated checksum is rejected. That writer
 * itself is not reused because it also runs `lintPostalAddress`, which
 * NORMALIZES the address — and this suite's whole subject is whether the stored
 * body still byte-matches the stored column.
 */
async function setAttestedPostalAddress(address: string | null): Promise<void> {
  const clearing = address === null;
  await sql()`
    UPDATE businesses
    SET solicitation_postal_address = ${address},
        solicitation_postal_address_attested_at =
          ${clearing ? null : sql()`NOW() - INTERVAL '7 days'`},
        solicitation_postal_address_attested_by_user_id =
          ${clearing ? null : userId()}::uuid,
        solicitation_postal_address_attestation_version =
          ${clearing ? null : POSTAL_ADDRESS_ATTESTATION_VERSION},
        solicitation_postal_address_attested_digest =
          ${clearing
            ? null
            : sql()`encode(sha256(convert_to(${address}::text, 'UTF8')), 'hex')`}
    WHERE id = ${businessId}::uuid
      AND account_id = ${accountId()}::uuid
  `;
}

/**
 * One ACCOUNT-scoped Suppression ledger row for the handle. Account scope, not
 * global, for a teardown reason as much as a domain one: a `global` row carries
 * no `account_id`, so this suite could never clean one up (see `afterAll`).
 * `owner_manual` is the only source the §3.1 source→scope CHECK pairs with
 * `account`.
 */
async function seedAccountSuppression(handle: string): Promise<void> {
  await sql()`
    INSERT INTO solicitation_suppressions (
      id, channel, normalized_handle, scope, account_id, source, created_by_user_id
    ) VALUES (
      ${randomUUID()}::uuid, 'email', ${handle}, 'account',
      ${accountId()}::uuid, 'owner_manual', ${userId()}::uuid
    )
  `;
}

interface OutreachLifecycleRow {
  delivery_status: string;
  disposition_reason: string | null;
  sending_at: string | null;
  sent_at: string | null;
  provider_message_id: string | null;
  /** Stamped by `terminal_bounce` and by NOTHING else — it feeds the Suppression
   *  ledger and the **Send breaker**'s hard-bounce numerator. */
  bounced_at: string | null;
  /** Left NULL by this lane on purpose: `send-breaker.ts` counts an
   *  unclassified bounce WITH the hard ones, so the worker never asserts a kind
   *  the provider did not give it. */
  bounce_kind: string | null;
  agent_run_id: string | null;
  consent_basis: string | null;
  consent_attestation_version: string | null;
  consent_row_id: string | null;
  moderation_status: string;
}

async function readOutreach(outreachId: string): Promise<OutreachLifecycleRow> {
  const [row] = await sql()<OutreachLifecycleRow[]>`
    SELECT delivery_status, disposition_reason,
           sending_at::text AS sending_at, sent_at::text AS sent_at,
           provider_message_id, bounced_at::text AS bounced_at, bounce_kind,
           agent_run_id,
           consent_basis, consent_attestation_version, consent_row_id,
           moderation_status
    FROM solicitation_outreach
    WHERE id = ${outreachId}::uuid
      AND account_id = ${accountId()}::uuid
      AND business_id = ${businessId}::uuid
  `;
  if (!row) throw new Error(`seeded outreach row ${outreachId} vanished`);
  return row;
}

/** The batch's closure stamp — D11's join, asserted from the batch row rather
 *  than from `closeBatchIfSettled`'s return value. */
async function readBatchClosedAt(batchId: string): Promise<string | null> {
  const [row] = await sql()<{ send_closed_at: string | null }[]>`
    SELECT send_closed_at::text AS send_closed_at
    FROM solicitation_batches
    WHERE id = ${batchId}::uuid
      AND account_id = ${accountId()}::uuid
      AND business_id = ${businessId}::uuid
  `;
  if (!row) throw new Error(`seeded batch ${batchId} vanished`);
  return row.send_closed_at;
}

/** The **Send batch parent** the generation lane minted for this batch. */
async function readSendParentRunId(batchId: string): Promise<string> {
  const [row] = await sql()<{ id: string }[]>`
    SELECT id FROM agent_runs
    WHERE kind = 'solicitation_send_batch'
      AND subject_type = 'solicitation_batch'
      AND subject_id = ${batchId.toLowerCase()}
      AND account_id = ${accountId()}::uuid
      AND business_id = ${businessId}::uuid
  `;
  if (!row) throw new Error(`no send batch parent run for batch ${batchId}`);
  return row.id;
}

interface OutcomeRow {
  outcome_kind: string;
  unit_count: number;
  attributed_agent: string;
}

/** Every outcome on one run. Read per-run rather than per-batch: D14's whole
 *  claim is about WHICH run carries `solicitation_sent`. */
async function readOutcomes(runId: string): Promise<OutcomeRow[]> {
  return sql()<OutcomeRow[]>`
    SELECT outcome_kind, unit_count, attributed_agent
    FROM agent_outcomes
    WHERE agent_run_id = ${runId}::uuid
    ORDER BY outcome_kind
  `;
}

interface ChildRunRow {
  kind: string;
  status: string;
  step_keys: string[];
}

/** The **Lazy child** the dispatch attempt created, with its step vocabulary. */
async function readChildRun(runId: string): Promise<ChildRunRow> {
  const [row] = await sql()<ChildRunRow[]>`
    SELECT run.kind, run.status,
           COALESCE(
             ARRAY(
               SELECT step.step_key FROM agent_run_steps step
               WHERE step.agent_run_id = run.id
               ORDER BY step.step_index
             ),
             ARRAY[]::text[]
           ) AS step_keys
    FROM agent_runs run
    WHERE run.id = ${runId}::uuid
      AND run.account_id = ${accountId()}::uuid
      AND run.business_id = ${businessId}::uuid
  `;
  if (!row) throw new Error(`child run ${runId} not found`);
  return row;
}

async function countAnalyticsEvents(eventKey: string): Promise<number> {
  const [row] = await sql()<{ total: number }[]>`
    SELECT COUNT(*)::int AS total
    FROM analytics_events
    WHERE event_key = ${eventKey}
      AND event_name = 'solicitation_suppressed_at_dispatch'
      AND business_id = ${businessId}::uuid
  `;
  return row?.total ?? 0;
}

interface OutboxLifecycleRow {
  status: string;
  completed_at: string | null;
}

async function readOutbox(outboxId: string): Promise<OutboxLifecycleRow> {
  const [row] = await sql()<OutboxLifecycleRow[]>`
    SELECT status, completed_at::text AS completed_at
    FROM job_outbox
    WHERE id = ${outboxId}::uuid
  `;
  if (!row) throw new Error(`seeded outbox row ${outboxId} vanished`);
  return row;
}

/** Runs the body with `SOLICITATION_SEND_ENABLED` off, restoring whatever the
 *  environment carried before — `.env.local` really is read off disk here. */
async function withSendFlagOff(run: () => Promise<void>): Promise<void> {
  const previous = process.env.SOLICITATION_SEND_ENABLED;
  delete process.env.SOLICITATION_SEND_ENABLED;
  try {
    await run();
  } finally {
    if (previous === undefined) delete process.env.SOLICITATION_SEND_ENABLED;
    else process.env.SOLICITATION_SEND_ENABLED = previous;
  }
}

/**
 * Runs the body with the moderation provider switched OFF.
 *
 * Pinned rather than inherited from `.env.local`, because the dispatch lane's
 * whole claim here is that OFF is a REFUSAL: spec §3.4 makes a clean provider
 * verdict a dispatch precondition, so `false` and a provider error are both
 * non-clean. A case that read whatever the environment happened to carry would
 * pass for the wrong reason on a machine that had it on.
 */
async function withProviderModerationOff(run: () => Promise<void>): Promise<void> {
  const previous = process.env.OPENAI_MODERATION_ENABLED;
  process.env.OPENAI_MODERATION_ENABLED = 'false';
  try {
    await run();
  } finally {
    if (previous === undefined) delete process.env.OPENAI_MODERATION_ENABLED;
    else process.env.OPENAI_MODERATION_ENABLED = previous;
  }
}

/** The inverse, for every case whose subject is a gate item AFTER `send_flag`:
 *  with the flag off, `dispatchOutreach` defers above tx1 and no item below it
 *  is ever evaluated. `readFlag` is not memoized, so this really does toggle. */
async function withSendFlagOn(run: () => Promise<void>): Promise<void> {
  const previous = process.env.SOLICITATION_SEND_ENABLED;
  process.env.SOLICITATION_SEND_ENABLED = 'true';
  try {
    await run();
  } finally {
    if (previous === undefined) delete process.env.SOLICITATION_SEND_ENABLED;
    else process.env.SOLICITATION_SEND_ENABLED = previous;
  }
}

/**
 * Runs the body with a CLEAN provider verdict, restoring the delegating default
 * afterwards so no later case inherits it. Only the mint cases use this: their
 * subject starts where the gate ends, and item 9 refusing would mean they never
 * reach it.
 */
async function withCleanModeration(run: () => Promise<void>): Promise<void> {
  moderationMocks.moderateResponse.mockResolvedValue(CLEAN_MODERATION);
  try {
    await run();
  } finally {
    moderationMocks.moderateResponse.mockImplementation(
      (text) => moderationMocks.real.current!(text),
    );
  }
}

/** The provider's answer for every case that is not about the provider. */
const DEFAULT_PROVIDER_MESSAGE_ID = 'msg_dispatch_live_default';

/**
 * The stub's steady state. `mockReset` clears the call log AND any
 * `mockRejectedValue` a failure case installed — this suite has no `beforeEach`,
 * so a leaked rejection would fail the next case for a reason it is not about.
 */
function resetProviderSend(providerMessageId = DEFAULT_PROVIDER_MESSAGE_ID): void {
  messagingMocks.send.mockReset();
  messagingMocks.send.mockResolvedValue({ providerMessageId });
}

/**
 * Runs the body with the provider REJECTING, then restores the steady state.
 *
 * The restore is a `mockImplementation`, deliberately NOT `resetProviderSend`:
 * a reset would clear the CALL LOG on the way out, and "zero retries" is a claim
 * about exactly that log, asserted after the helper returns.
 */
async function withProviderFailure(failure: unknown, run: () => Promise<void>): Promise<void> {
  messagingMocks.send.mockClear();
  messagingMocks.send.mockRejectedValue(failure);
  try {
    await run();
  } finally {
    messagingMocks.send.mockImplementation(
      async () => ({ providerMessageId: DEFAULT_PROVIDER_MESSAGE_ID }),
    );
  }
}

/**
 * One dispatch, all the way through: tx1, the provider call, tx2. Resolves —
 * the passing path throws nothing now that Task 6 has landed.
 */
async function dispatchToCompletion(
  fixture: QueuedOutreachFixture,
  correlationId: string,
): Promise<void> {
  await withCleanModeration(async () => {
    await withSendFlagOn(async () => {
      await dispatchOutreach(sql(), {
        batchId: fixture.batchId,
        businessId,
        outreachId: fixture.outreachId,
        outboxHandle: { outboxId: fixture.outboxId, attempt: fixture.attempt },
        correlationId,
      });
    });
  });
}

/**
 * The crash decision 9b is written for, produced without killing a process:
 * tx1 COMMITS (token minted, child created, row CAS'd to `sending`), the
 * provider is called, and tx2 is then aborted from inside — so nothing terminal
 * survives and the outbox attempt is left in flight for the watchdog.
 *
 * The poison fires on the SECOND transaction only. `abortingExecutor` runs it
 * after every `begin` callback, and poisoning tx1 would roll the mint back and
 * leave nothing to resume from. `SELECT 1 / 0` is `approval.integration.test.ts`'s
 * poison verbatim: a REAL Postgres error (22012), so the transaction is in
 * genuinely aborted state rather than merely unwound by a JS throw — and it
 * holds no schema, so a vitest timeout leaves nothing behind (never a temporary
 * CHECK constraint; run-time DDL deadlocks the live-DB lane).
 */
async function crashAfterTx1(
  fixture: QueuedOutreachFixture,
  correlationId: string,
): Promise<void> {
  let opened = 0;
  const poisoned = abortingExecutor(sql(), async (tx) => {
    opened += 1;
    if (opened < 2) return undefined;
    return tx`SELECT 1 / 0`;
  });

  await withCleanModeration(async () => {
    await withSendFlagOn(async () => {
      await expect(
        dispatchOutreach(poisoned, {
          batchId: fixture.batchId,
          businessId,
          outreachId: fixture.outreachId,
          outboxHandle: { outboxId: fixture.outboxId, attempt: fixture.attempt },
          correlationId,
        }),
      ).rejects.toThrow(/division by zero/i);
    });
  });
}

/**
 * The SAME invocation, re-run as a fresh process would. It resolves rather than
 * rejecting: the row is already `sending`, the raw token is gone with the
 * process that minted it, and decision 9's answer is to complete the attempt
 * and return — never to re-gate, never to throw and never to send.
 */
async function redispatchAfterCrash(
  fixture: QueuedOutreachFixture,
  correlationId: string,
): Promise<void> {
  await withCleanModeration(async () => {
    await withSendFlagOn(async () => {
      await dispatchOutreach(sql(), {
        batchId: fixture.batchId,
        businessId,
        outreachId: fixture.outreachId,
        outboxHandle: { outboxId: fixture.outboxId, attempt: fixture.attempt },
        correlationId,
      });
    });
  });
}

interface UnsubscribeTokenRow {
  id: string;
  token_hash: string;
  normalized_handle: string;
  channel: string;
  account_id: string | null;
  business_id: string | null;
  ask_id: string | null;
  outreach_id: string | null;
  sent_at: string | null;
  redeemed_at: string | null;
}

async function readTokenRows(outreachId: string): Promise<UnsubscribeTokenRow[]> {
  return sql()<UnsubscribeTokenRow[]>`
    SELECT id, token_hash, normalized_handle, channel,
           account_id, business_id, ask_id, outreach_id,
           sent_at::text AS sent_at, redeemed_at::text AS redeemed_at
    FROM solicitation_unsubscribe_tokens
    WHERE outreach_id = ${outreachId}::uuid
  `;
}

/** The mint's whole contract is ONE row per Outreach row, so every case that
 *  reads the token asserts that count before touching a field. */
async function readOnlyTokenRow(outreachId: string): Promise<UnsubscribeTokenRow> {
  const rows = await readTokenRows(outreachId);
  expect(rows).toHaveLength(1);
  const [row] = rows;
  if (!row) throw new Error(`no unsubscribe token row for outreach ${outreachId}`);
  return row;
}

/** Every column of one table, untyped on purpose: the invariant #5 scan below
 *  is a claim about ALL of them, and a hand-listed projection would quietly
 *  stop covering a column added later. */
async function readEveryColumn(
  table: 'solicitation_unsubscribe_tokens' | 'solicitation_outreach',
  outreachId: string,
): Promise<Record<string, unknown>[]> {
  const scope = table === 'solicitation_unsubscribe_tokens'
    ? sql()`outreach_id = ${outreachId}::uuid`
    : sql()`id = ${outreachId}::uuid
        AND account_id = ${accountId()}::uuid
        AND business_id = ${businessId}::uuid`;
  return sql()<Record<string, unknown>[]>`
    SELECT * FROM ${sql()(table)} WHERE ${scope}
  `;
}

/**
 * Invariant #5, asserted without knowing the raw token — which no test CAN
 * know, because it never leaves `dispatch.ts`'s memory. That is the point, and
 * it is also why the check cannot be a `.not.toContain(rawToken)`.
 *
 * Two nets, and between them a raw token has nowhere to hide: any
 * `<nonce>.<mac>` substring is run through `isWellFormedUnsubscribeToken`,
 * which VERIFIES the HMAC — so a leak is caught bare or embedded in JSON — and
 * the `/u/` URL prefix is matched directly, catching a substituted body
 * written back to a column.
 */
function carriesRawToken(text: string): boolean {
  return (text.match(/[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{40,}/g) ?? [])
    .some((candidate) => isWellFormedUnsubscribeToken(candidate));
}

function assertCarriesNoRawToken(rows: readonly Record<string, unknown>[], table: string): void {
  for (const row of rows) {
    for (const [column, value] of Object.entries(row)) {
      if (value === null || value === undefined) continue;
      const text = typeof value === 'string' ? value : JSON.stringify(value);
      expect(carriesRawToken(text), `${table}.${column} carries a raw unsubscribe token`)
        .toBe(false);
      expect(text, `${table}.${column} carries an unsubscribe URL`)
        .not.toContain(`${APP_URL}/u/`);
    }
  }
}

// ── #1010 T4 fixtures: the Refusal ledger ───────────────────────────────────

interface RefusalRow {
  account_id: string;
  business_id: string | null;
  refusal_source: string;
  refusal_code: string | null;
  all_refusal_codes: string[] | null;
  refusal_category: string;
  subject_type: string | null;
  subject_id: string | null;
  occurred_at: string;
  created_at: string;
  /**
   * `occurred_at - created_at`, in seconds, computed IN POSTGRES.
   *
   * `created_at` is `DEFAULT NOW()` and `NOW()` is `transaction_timestamp()` —
   * tx1's START. So this column IS the discriminator between the gate's own
   * clock and the transaction stamp, and it must be read at full precision:
   * postgres.js decodes `timestamptz` to a JS `Date` and truncates microseconds
   * (#520), which is exactly where a sub-millisecond difference would vanish.
   */
  gate_skew_seconds: string;
}

/** Every Refusal written against ONE Outreach row. Scoped by subject because
 *  this suite has no `afterEach` — each fixture mints its own outreach id. */
async function readRefusalsForOutreach(outreachId: string): Promise<RefusalRow[]> {
  return sql()<RefusalRow[]>`
    SELECT account_id::text AS account_id,
           business_id::text AS business_id,
           refusal_source,
           refusal_code,
           all_refusal_codes,
           refusal_category,
           subject_type,
           subject_id::text AS subject_id,
           occurred_at::text AS occurred_at,
           created_at::text AS created_at,
           EXTRACT(EPOCH FROM (occurred_at - created_at))::text AS gate_skew_seconds
    FROM refusal_events
    WHERE subject_id = ${outreachId}::uuid
    ORDER BY occurred_at
  `;
}

interface RecordedQuery {
  /** Static template text with every bound value elided. */
  text: string;
  /** True when the statement was issued on the TRANSACTION, not the pool. */
  onTransaction: boolean;
}

interface RecordingExecutor {
  executor: postgresType.Sql;
  queries: RecordedQuery[];
  /** One entry per `begin` — the exact objects a collaborator should receive. */
  transactions: postgresType.TransactionSql[];
}

/**
 * A `Proxy` over a REAL `Sql` that records every statement and WHICH receiver
 * issued it — the pooled client or the transaction the writer opened.
 *
 * THE THIRD COPY of this helper (`approval.integration.test.ts`'s
 * `instrumentedExecutor`, `batch-builder.integration.test.ts`'s
 * `recordingExecutor`), and the batch-builder copy's own note asks whoever needs
 * a third to unify them. It is NOT unified here because the only home for a
 * shared version — `src/lib/shared/__tests__/helpers/` — is outside this
 * branch's edit surface. Unify all three there next.
 *
 * It exists for exactly one claim: "inside tx1" is not a POSITION. Red-team
 * P1-A moved `commitWithhold`'s ledger write to the TOP of the function and all
 * 33 dispatch cases stayed green — because a row-existence assertion cannot see
 * order, and the rollback case passes vacuously when the write it aborts on is
 * the first thing the withhold does.
 *
 * A Proxy over a real `Sql`, never a `{ begin } as unknown as Sql` cast, and
 * every leading `begin` argument is forwarded — same contract, and the same
 * reasoning, as `helpers/abort-injection.ts`.
 */
function recordingExecutor(base: postgresType.Sql): RecordingExecutor {
  const queries: RecordedQuery[] = [];
  const transactions: postgresType.TransactionSql[] = [];

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

  const wrapTransaction = (tx: postgresType.TransactionSql): postgresType.TransactionSql => {
    const proxy = new Proxy(tx, {
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
    transactions.push(proxy);
    return proxy;
  };

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

  return { executor, queries, transactions };
}

/**
 * Holds the per-Business advisory lock for `holdFor`, resolving once it is
 * actually held.
 *
 * `runDispatchTx` opens tx1, CASes the outbox attempt and THEN takes this key,
 * so a holder makes tx1 START measurably earlier than the moment the gate
 * decides. That gap is what turns "occurred_at is the gate's clock, not
 * transaction start" into a measurement: without it the two land inside the same
 * millisecond and a sentinel-stamped row passes.
 *
 * The hold is an INTERVAL literal rather than a bound number — postgres.js
 * infers a parameter's wire type from the JS value, and a fractional `pg_sleep`
 * argument is ambiguity this fixture does not need.
 */
function holdBatchLock(holdFor: string): { held: Promise<void>; released: Promise<void> } {
  let resolveHeld!: () => void;
  const held = new Promise<void>((resolve) => {
    resolveHeld = resolve;
  });
  const released = sql().begin(async (tx) => {
    await acquireSolicitationBatchLock(tx, businessId);
    resolveHeld();
    await tx`SELECT pg_sleep(EXTRACT(EPOCH FROM ${holdFor}::interval))`;
  }).then(() => undefined);
  return { held, released };
}

/** One dispatch with the send flag on, using this suite's env discipline. */
async function dispatchWithFlagOn(
  fixture: QueuedOutreachFixture,
  correlationId: string,
): Promise<void> {
  await withSendFlagOn(async () => {
    await dispatchOutreach(sql(), {
      batchId: fixture.batchId,
      businessId,
      outreachId: fixture.outreachId,
      outboxHandle: { outboxId: fixture.outboxId, attempt: fixture.attempt },
      correlationId,
    });
  });
}

/** One parsed structured log line. */
interface CapturedLogLine {
  message: string;
  data?: Record<string, unknown>;
}

/**
 * Every structured WARN line one dispatch emitted, parsed.
 *
 * `dispatchOutreach` returns `void`, so the single place a `DispatchTxOutcome`
 * discriminant is observable outside the module is the line
 * `reportNonSendOutcome` writes. The integrity cases assert it, so each one
 * NAMES the outcome it is about instead of inferring it from a row shape
 * several outcomes share.
 *
 * `createWorkerLogger` emits one JSON object per line to `console.warn`, so
 * this parses rather than string-matches: a claim about `detector` is a claim
 * about a field, never about the text around it.
 */
async function captureWarnLines(run: () => Promise<void>): Promise<CapturedLogLine[]> {
  const lines: CapturedLogLine[] = [];
  const spy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    const [first] = args;
    if (typeof first !== 'string') return;
    try {
      lines.push(JSON.parse(first) as CapturedLogLine);
    } catch {
      // Not one of ours — a bare console.warn from somewhere else.
    }
  });
  try {
    await run();
  } finally {
    spy.mockRestore();
  }
  return lines;
}

describeWithDb(
  'solicitation dispatch lane',
  { enabled: Boolean(testDatabaseUrl), timeout: 90_000 },
  () => {
    beforeAll(async () => {
      const databaseUrl = assertLocalTestDatabaseUrl(testDatabaseUrl);
      featureDatabaseLock = await acquireLiveDbLock(databaseUrl);
      db = postgres(databaseUrl, { max: 4, prepare: false });
      // ASSERT, never apply. 091 carries the send-mode spine lifecycle the CAS
      // and the Lazy child depend on, 093 the Consent ledger, 096 the
      // Suppression ledger AND `solicitation_unsubscribe_tokens`, 099 the
      // attested postal address, 108 the owner-excluded disposition, and 110
      // (#898) the send governors this lane's bounce discrimination writes.
      await assertSchemaReady(db, [
        MIGRATION_091_SEND_MODE_SPINE_LIFECYCLE,
        MIGRATION_093_SOLICITATION_CONSENT,
        MIGRATION_096_SOLICITATION_SUPPRESSIONS,
        MIGRATION_099_SOLICITATION_POSTAL_ADDRESS,
        MIGRATION_108_OUTREACH_OWNER_EXCLUDED,
        MIGRATION_110_SEND_GOVERNORS,
      ]);
      tenant = await seedTenantAccount(db, {
        userName: 'Dispatch Owner',
        accountDisplayName: 'Dispatch Account',
      });
      await seedLocation(db, tenant.accountId, {
        businessId,
        name: 'Dispatch Business',
        isPrimary: true,
      });
      // `seedLocation` leaves `google_place_id` NULL, and the send path REFUSES
      // to build a review link without a canonical one (rulings 2/3). Written
      // here rather than in the fixture: it is a fact about the location, not
      // about any one Outreach row.
      await db`
        UPDATE businesses SET google_place_id = ${SEEDED_PLACE_ID}
        WHERE id = ${businessId}::uuid AND account_id = ${tenant.accountId}::uuid
      `;

      // Pinned so the unsubscribe URL is the same on every machine, and so a
      // missing SESSION_COOKIE_SECRET cannot turn the mint into a boot error.
      // Both accessors MEMOIZE — setting the variable without dropping the memo
      // would leave the first parse in this process authoritative.
      process.env.NEXT_PUBLIC_APP_URL = APP_URL;
      process.env.SESSION_COOKIE_SECRET = SESSION_SECRET;
      resetWorkerConfigForTests();
      resetServerConfigForTests();

      // The delegating default: every gate case below was written against the
      // production verdict, and only the mint cases override it.
      moderationMocks.moderateResponse.mockImplementation(
        (text) => moderationMocks.real.current!(text),
      );
      // The provider's steady state. Without a resolved value the adapter stub
      // returns `undefined` and the sent arm writes a NULL provider_message_id,
      // which 091 permits and every later bounce webhook cannot resolve.
      resetProviderSend();
    }, LIVE_DB_LOCK_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      try {
        if (db) {
          // Child-to-parent order: the FKs from the solicitation tables have no
          // cascade, and `agent_runs` holds the Lazy children this lane creates.
          // #1010's rows first: `refusal_events` has no-action foreign keys to
          // `accounts` and `businesses`, both of which this teardown deletes.
          await db`DELETE FROM refusal_events WHERE business_id = ${businessId}::uuid`;
          await db`DELETE FROM solicitation_unsubscribe_tokens WHERE business_id = ${businessId}::uuid`;
          await db`DELETE FROM solicitation_outreach WHERE business_id = ${businessId}::uuid`;
          await db`DELETE FROM solicitation_asks WHERE business_id = ${businessId}::uuid`;
          await db`DELETE FROM solicitation_batches WHERE business_id = ${businessId}::uuid`;
          await db`DELETE FROM solicitation_contacts WHERE business_id = ${businessId}::uuid`;
          await db`DELETE FROM contact_csv_uploads WHERE business_id = ${businessId}::uuid`;
          await db`DELETE FROM solicitation_consent WHERE business_id = ${businessId}::uuid`;
          // The suppression-at-dispatch signal. Deleted before agent_runs only
          // for readability — analytics_events has no FK to a run.
          await db`DELETE FROM analytics_events WHERE business_id = ${businessId}::uuid`;
          // BEFORE agent_runs, and not incidentally: the outcome's FK is
          // ON DELETE SET NULL, so deleting the runs first would ORPHAN every
          // `solicitation_sent` row here rather than remove it.
          await db`DELETE FROM agent_outcomes WHERE business_id = ${businessId}::uuid`;
          await db`DELETE FROM agent_runs WHERE business_id = ${businessId}::uuid`;
          // `solicitation_suppressions` is scoped by ACCOUNT, not by location:
          // a global-scope row carries no account_id at all and an
          // account-scope row carries no business_id. Deleting by business_id
          // would silently strand every row this lane wrote.
          if (tenant) {
            await db`DELETE FROM solicitation_suppressions WHERE account_id = ${tenant.accountId}::uuid`;
          }
          // `job_outbox` has no tenant columns — the scope lives in the
          // payload, which is why this reads it rather than a column.
          await db`DELETE FROM job_outbox WHERE payload->>'business_id' = ${businessId}`;
          await db`DELETE FROM businesses WHERE id = ${businessId}::uuid`;
          if (tenant) await cleanupTenantAccount(db, tenant);
        }
      } finally {
        try {
          if (db) await db.end({ timeout: 5 });
        } finally {
          if (priorEnv.appUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
          else process.env.NEXT_PUBLIC_APP_URL = priorEnv.appUrl;
          if (priorEnv.sessionSecret === undefined) delete process.env.SESSION_COOKIE_SECRET;
          else process.env.SESSION_COOKIE_SECRET = priorEnv.sessionSecret;
          resetWorkerConfigForTests();
          resetServerConfigForTests();
          await featureDatabaseLock?.release();
          featureDatabaseLock = undefined;
        }
      }
    }, 120_000);

    // ---- The seven-item Dispatch gate (Tasks 2 and 3) ----------------------
    //
    // Each case drives ONE item to failure with every other item passing, so a
    // green result names which item fired. `no_postal_address` here is a
    // dispatch-time fact about one Outreach row — never collapse it into the
    // Send handoff's `postal_address_missing`, which is a handoff-time fact
    // about the business.
    describe('Dispatch gate', () => {
      it('withholds with no_postal_address when the location has no Attested postal address', async () => {
        const fixture = await seedQueuedOutreach();
        await setAttestedPostalAddress(null);

        await withSendFlagOn(async () => {
          await dispatchOutreach(sql(), {
            batchId: fixture.batchId,
            businessId,
            outreachId: fixture.outreachId,
            outboxHandle: { outboxId: fixture.outboxId, attempt: fixture.attempt },
            correlationId: 'dispatch-no-postal-address',
          });
        });

        const row = await readOutreach(fixture.outreachId);
        expect(row.delivery_status).toBe('withheld');
        expect(row.disposition_reason).toBe('no_postal_address');
        // A withhold is not a send: nothing reached the wire.
        expect(row.sending_at).toBeNull();
        expect(row.sent_at).toBeNull();
        expect(row.provider_message_id).toBeNull();

        // Step 3's writer. The consent snapshot is stamped from the ledger row
        // read under the lock, so "which consent covered this attempt" stops
        // being a guess the moment the attempt is decided.
        expect(row.consent_basis).toBe('owner_attested');
        expect(row.consent_attestation_version).toBe(CONSENT_ATTESTATION_VERSION);
        expect(row.consent_row_id).not.toBeNull();

        // Decision 7 + 8: the Lazy child is created HERE and a correct
        // withhold terminalizes it `completed`, not `failed`.
        expect(row.agent_run_id).not.toBeNull();
        const child = await readChildRun(row.agent_run_id!);
        expect(child.kind).toBe('solicitation_ask');
        expect(child.status).toBe('completed');
        expect(child.step_keys).toEqual(['dispatch_gate_evaluated']);

        // The outbox attempt is spent by the domain, never by the handler.
        const outbox = await readOutbox(fixture.outboxId);
        expect(outbox.status).toBe('completed');
      });

      it('withholds with postal_address_mismatch when the stored footer no longer byte-matches', async () => {
        const fixture = await seedQueuedOutreach();
        // The owner corrects their address AFTER approval. The stored bytes are
        // the contract, so the footer the recipient would see now names an
        // address the business no longer attests to — present, but not a match.
        await setAttestedPostalAddress('1600 Pennsylvania Ave NW\nWashington, DC 20500');

        await withSendFlagOn(async () => {
          await dispatchOutreach(sql(), {
            batchId: fixture.batchId,
            businessId,
            outreachId: fixture.outreachId,
            outboxHandle: { outboxId: fixture.outboxId, attempt: fixture.attempt },
            correlationId: 'dispatch-postal-mismatch',
          });
        });

        const row = await readOutreach(fixture.outreachId);
        expect(row.delivery_status).toBe('withheld');
        // Present-but-mismatched and absent are DIFFERENT facts: only the
        // reason tells the owner which one they have to fix.
        expect(row.disposition_reason).toBe('postal_address_mismatch');
        expect(row.sent_at).toBeNull();
      });

      it('withholds with suppressed and emits solicitation_suppressed_at_dispatch when the handle is on the Suppression ledger', async () => {
        const fixture = await seedQueuedOutreach();
        await setAttestedPostalAddress(SEEDED_POSTAL_ADDRESS);
        // The opt-out lands AFTER the owner approved the batch — the exact
        // window §4.4 says this signal exists to measure.
        await seedAccountSuppression(fixture.handle);

        await withSendFlagOn(async () => {
          await dispatchOutreach(sql(), {
            batchId: fixture.batchId,
            businessId,
            outreachId: fixture.outreachId,
            outboxHandle: { outboxId: fixture.outboxId, attempt: fixture.attempt },
            correlationId: 'dispatch-suppressed',
          });
        });

        const row = await readOutreach(fixture.outreachId);
        expect(row.delivery_status).toBe('withheld');
        expect(row.disposition_reason).toBe('suppressed');
        expect(row.sent_at).toBeNull();

        // Keyed on the ASK, per the registered contract at
        // docs/analytics/events.md:272 — "one refusal per Ask", so neither a
        // BullMQ retry nor a regenerate re-dispatch inflates the count, and a
        // replay drops on ON CONFLICT (event_key).
        expect(
          await countAnalyticsEvents(
            `solicitation_suppressed_at_dispatch_${fixture.askId}`,
          ),
        ).toBe(1);
      });

      it('withholds with no_consent when the consent row is missing or its attestation version is not send-eligible', async () => {
        await setAttestedPostalAddress(SEEDED_POSTAL_ADDRESS);

        const missing = await seedQueuedOutreach({ consent: 'absent' });
        await withSendFlagOn(async () => {
          await dispatchOutreach(sql(), {
            batchId: missing.batchId,
            businessId,
            outreachId: missing.outreachId,
            outboxHandle: { outboxId: missing.outboxId, attempt: missing.attempt },
            correlationId: 'dispatch-no-consent-missing',
          });
        });

        const missingRow = await readOutreach(missing.outreachId);
        expect(missingRow.delivery_status).toBe('withheld');
        expect(missingRow.disposition_reason).toBe('no_consent');
        // No ledger row means the snapshot records exactly that.
        expect(missingRow.consent_basis).toBeNull();
        expect(missingRow.consent_row_id).toBeNull();

        // A row EXISTS here — the gate is a membership test against
        // SEND_ELIGIBLE_ATTESTATION_VERSIONS, never a "not v1" test, so a
        // future v3 that has not been added to that list refuses the same way.
        const stale = await seedQueuedOutreach({ consent: 'stale_attestation' });
        await withSendFlagOn(async () => {
          await dispatchOutreach(sql(), {
            batchId: stale.batchId,
            businessId,
            outreachId: stale.outreachId,
            outboxHandle: { outboxId: stale.outboxId, attempt: stale.attempt },
            correlationId: 'dispatch-no-consent-stale',
          });
        });

        const staleRow = await readOutreach(stale.outreachId);
        expect(staleRow.delivery_status).toBe('withheld');
        expect(staleRow.disposition_reason).toBe('no_consent');
        // The snapshot still records what the ledger said — the refusal is the
        // gate's verdict about that row, not an absence of one.
        expect(staleRow.consent_attestation_version).toBe(STALE_ATTESTATION_VERSION);
      });
      it('withholds with lint_failed when the stored bytes fail the current ASK_LINT_VERSION', async () => {
        await setAttestedPostalAddress(SEEDED_POSTAL_ADDRESS);
        // Copy that the lint's class 1 (incentive_language) blocks outright. The
        // row was APPROVED with these bytes — the re-lint exists because the
        // ruleset can move after approval, and the stored bytes are what ships.
        const fixture = await seedQueuedOutreach({
          llmBody: 'Thanks for stopping by — leave us a review and get 20% off your next visit.',
        });

        await withSendFlagOn(async () => {
          await dispatchOutreach(sql(), {
            batchId: fixture.batchId,
            businessId,
            outreachId: fixture.outreachId,
            outboxHandle: { outboxId: fixture.outboxId, attempt: fixture.attempt },
            correlationId: 'dispatch-lint-failed',
          });
        });

        const row = await readOutreach(fixture.outreachId);
        expect(row.delivery_status).toBe('withheld');
        // `lint_failed`, not `moderation_high`: B6's ORDER survived the split
        // gathering. Re-moderation also refuses here (the provider is off in
        // this environment), so this reason is only reachable if the gate still
        // evaluates item 8 before item 9.
        expect(row.disposition_reason).toBe('lint_failed');
        expect(row.sending_at).toBeNull();
        expect(row.sent_at).toBeNull();
        expect(row.provider_message_id).toBeNull();

        // The withhold is a full terminal act, same as every other gate item.
        expect(row.agent_run_id).not.toBeNull();
        const child = await readChildRun(row.agent_run_id!);
        expect(child.status).toBe('completed');
        expect(child.step_keys).toEqual(['dispatch_gate_evaluated']);
        expect((await readOutbox(fixture.outboxId)).status).toBe('completed');
      });
      // Decision 6 / amendment B1: the dispatch verdict NEVER overwrites the
      // render's `moderation_status` or `moderation_detail` — those columns are
      // render provenance. The withheld reason is the only thing that moves.
      it('withholds with moderation_high and leaves the render moderation_status untouched', async () => {
        await setAttestedPostalAddress(SEEDED_POSTAL_ADDRESS);
        // Lint-clean bytes, so item 8 passes and item 9 is the only thing left
        // to fail — which is what makes this case about moderation at all.
        const fixture = await seedQueuedOutreach();

        await withProviderModerationOff(async () => {
          await withSendFlagOn(async () => {
            await dispatchOutreach(sql(), {
              batchId: fixture.batchId,
              businessId,
              outreachId: fixture.outreachId,
              outboxHandle: { outboxId: fixture.outboxId, attempt: fixture.attempt },
              correlationId: 'dispatch-moderation-high',
            });
          });
        });

        const row = await readOutreach(fixture.outreachId);
        expect(row.delivery_status).toBe('withheld');
        expect(row.disposition_reason).toBe('moderation_high');
        expect(row.sent_at).toBeNull();

        // The other half of the claim, and the one a careless implementation
        // gets wrong: `moderation_status` still says what the RENDER's provider
        // verdict was. Overwriting it here would destroy the provenance B1 put
        // on the row and make "was this copy ever moderated clean" unanswerable.
        expect(row.moderation_status).toBe('clean');
      });
      // Decision 5: flag-off is a DEFER, not a withhold. 091/110 have no
      // `flag_off` reason and inventing one terminalizes a row the owner still
      // owns; the row stays `queued` and #900's producer re-drips it.
      it('defers a queued Outreach row without terminalizing it when SOLICITATION_SEND_ENABLED is off', async () => {
        const fixture = await seedQueuedOutreach();

        await withSendFlagOff(async () => {
          await dispatchOutreach(sql(), {
            batchId: fixture.batchId,
            businessId,
            outreachId: fixture.outreachId,
            outboxHandle: { outboxId: fixture.outboxId, attempt: fixture.attempt },
            correlationId: 'dispatch-flag-off',
          });
        });

        const row = await readOutreach(fixture.outreachId);
        // `queued` and nothing else: a deferred row is one #900 re-drips, so
        // every terminal fact must be absent, not merely "not withheld".
        expect(row.delivery_status).toBe('queued');
        expect(row.disposition_reason).toBeNull();
        expect(row.sending_at).toBeNull();
        expect(row.sent_at).toBeNull();
      });
      // The Halt latch cancels `rendered` and `queued` rows, never `sending`.
      // A job that arrives after the sweep finds a `cancelled` row and must do
      // nothing at all — not re-gate it, not re-terminalize it.
      it('no-ops when the batch is halted and the Outreach row is already cancelled', async () => {
        const fixture = await seedQueuedOutreach();
        await setAttestedPostalAddress(SEEDED_POSTAL_ADDRESS);
        // The Halt latch, as it actually lands: the batch latches and the sweep
        // cancels every `rendered`/`queued` row (never `sending`) in one act.
        await sql()`
          UPDATE solicitation_batches
          SET halted_at = NOW(), halt_reason = 'owner_halt',
              halted_by = ${userId()}::uuid
          WHERE id = ${fixture.batchId}::uuid
            AND account_id = ${accountId()}::uuid
            AND business_id = ${businessId}::uuid
        `;
        await sql()`
          UPDATE solicitation_outreach
          SET delivery_status = 'cancelled', disposition_reason = 'owner_halt'
          WHERE id = ${fixture.outreachId}::uuid
            AND account_id = ${accountId()}::uuid
            AND business_id = ${businessId}::uuid
        `;

        await withSendFlagOn(async () => {
          await dispatchOutreach(sql(), {
            batchId: fixture.batchId,
            businessId,
            outreachId: fixture.outreachId,
            outboxHandle: { outboxId: fixture.outboxId, attempt: fixture.attempt },
            correlationId: 'dispatch-halted-cancelled',
          });
        });

        const row = await readOutreach(fixture.outreachId);
        // Untouched in every dimension: not re-gated, not re-terminalized, and
        // no consent snapshot — the sweep already wrote every terminal fact.
        expect(row.delivery_status).toBe('cancelled');
        expect(row.disposition_reason).toBe('owner_halt');
        expect(row.consent_basis).toBeNull();
        expect(row.consent_row_id).toBeNull();
        expect(row.agent_run_id).toBeNull();
        expect(row.sent_at).toBeNull();

        // The attempt is still spent, or the watchdog re-pends a row that has
        // nothing left to do.
        const outbox = await readOutbox(fixture.outboxId);
        expect(outbox.status).toBe('completed');
        expect(outbox.completed_at).not.toBeNull();
      });
      // Task 3 — the stored interpolation snapshot is the Owner approval
      // guarantee's input. Absent, there is no byte-for-byte claim left to make,
      // so the only safe answer is to withhold rather than to re-derive.
      it('withholds rather than sending when the stored interpolation snapshot is absent', async () => {
        await setAttestedPostalAddress(SEEDED_POSTAL_ADDRESS);
        // `{}` is what 092's redaction leaves behind, and what locked decision 6
        // writes for a never-assembled `render_failed` row. Every OTHER gate
        // item passes here, so the snapshot is the only thing under test.
        const fixture = await seedQueuedOutreach({ interpolationInputs: {} });

        await withSendFlagOn(async () => {
          await dispatchOutreach(sql(), {
            batchId: fixture.batchId,
            businessId,
            outreachId: fixture.outreachId,
            outboxHandle: { outboxId: fixture.outboxId, attempt: fixture.attempt },
            correlationId: 'dispatch-absent-snapshot',
          });
        });

        const row = await readOutreach(fixture.outreachId);
        // An absent snapshot is NOT a lint pass. With no corpus to replay, the
        // §2.5 exemption cannot be reconstructed and there is no byte-for-byte
        // claim left to make — so the re-lint reports the check it could not
        // perform rather than waving the row through.
        expect(row.delivery_status).toBe('withheld');
        expect(row.disposition_reason).toBe('lint_failed');
        expect(row.sending_at).toBeNull();
        expect(row.sent_at).toBeNull();
        expect(row.provider_message_id).toBeNull();
      });
    });

    // ---- Unsubscribe token mint (Task 4, invariant #5) ---------------------
    describe('unsubscribe token mint', () => {
      // `solicitation_unsubscribe_tokens_outreach_uniq` is what makes this one
      // row per Outreach row. Only the SHA-256 hash is stored — the raw token
      // exists in memory and in the recipient's link, never in Postgres.
      it('mints one unsubscribe token row per outreach_id and stores only the SHA-256 hash', async () => {
        await setAttestedPostalAddress(SEEDED_POSTAL_ADDRESS);
        const fixture = await seedQueuedOutreach();

        resetProviderSend();
        await dispatchToCompletion(fixture, 'dispatch-token-mint');

        const token = await readOnlyTokenRow(fixture.outreachId);

        // The stored representation is a digest and nothing else — migration
        // 096's `..._token_hash_sha256_hex` CHECK is what makes a call site
        // that forgot to hash impossible rather than merely discouraged.
        expect(token.token_hash).toMatch(/^[a-f0-9]{64}$/);
        // ...and it really is THIS token's digest shape: hashing the stored
        // value again cannot reproduce it, which is the one-way property
        // decision 9 is built on.
        expect(hashUnsubscribeToken(token.token_hash)).not.toBe(token.token_hash);

        // Redemption keys on the handle + channel; provenance is what the
        // offboarding purge scrubs. `sent_at` is stamped at DISPATCH (B4
        // amends #621's "minted at render"), and the row is unredeemed.
        expect(token.normalized_handle).toBe(fixture.handle);
        expect(token.channel).toBe('email');
        expect(token.account_id).toBe(accountId());
        expect(token.business_id).toBe(businessId);
        expect(token.ask_id).toBe(fixture.askId);
        expect(token.outreach_id).toBe(fixture.outreachId);
        expect(token.sent_at).not.toBeNull();
        expect(token.redeemed_at).toBeNull();

        // ONE token, ONE send. The mint is per Outreach row and so is the
        // provider call, and the URL the recipient received resolves to exactly
        // the row asserted above.
        expect(messagingMocks.send).toHaveBeenCalledTimes(1);
      });

      // The provider idempotency key is the Outreach row id, so a retry that
      // minted a NEW token would re-issue a different body under the same key.
      it('re-uses the existing token row on a retry so the provider idempotency retry has a stable body', async () => {
        await setAttestedPostalAddress(SEEDED_POSTAL_ADDRESS);
        const fixture = await seedQueuedOutreach();

        // Invocation 1 mints, sends, and dies before tx2 commits — the row is
        // left `sending` with its token, which is the state a retry meets.
        await crashAfterTx1(fixture, 'dispatch-token-first');
        const first = await readOnlyTokenRow(fixture.outreachId);

        // The retry. It resumes rather than re-minting, so the row that already
        // exists is the one every later bounce, complaint and opt-out resolves
        // against. (The mint's own `ON CONFLICT (outreach_id) WHERE outreach_id
        // IS NOT NULL` — 096's partial index byte-for-byte — is the second net
        // under that, for a row a later writer moves out of `sending`.)
        await redispatchAfterCrash(fixture, 'dispatch-token-retry');

        const after = await readOnlyTokenRow(fixture.outreachId);
        expect(after.id).toBe(first.id);
        expect(after.token_hash).toBe(first.token_hash);
        expect(after.sent_at).toBe(first.sent_at);
      });

      // Assert across every column of `solicitation_unsubscribe_tokens` AND
      // `solicitation_outreach`: the raw token appears in none of them.
      it('substitutes the raw unsubscribe URL in memory and never writes it to Postgres', async () => {
        await setAttestedPostalAddress(SEEDED_POSTAL_ADDRESS);
        const fixture = await seedQueuedOutreach();

        await dispatchToCompletion(fixture, 'dispatch-token-in-memory');

        // NEGATIVE CONTROL. No test can hold the raw token — that IS invariant
        // #5 — so the scan recognises one by shape and signature instead. If
        // that detector stopped working, every assertion below would pass on
        // an empty claim.
        expect(carriesRawToken(`stored ${mintUnsubscribeRawToken()} value`)).toBe(true);

        const tokenRows = await readEveryColumn(
          'solicitation_unsubscribe_tokens',
          fixture.outreachId,
        );
        expect(tokenRows).toHaveLength(1);
        assertCarriesNoRawToken(tokenRows, 'solicitation_unsubscribe_tokens');

        const outreachRows = await readEveryColumn('solicitation_outreach', fixture.outreachId);
        expect(outreachRows).toHaveLength(1);
        assertCarriesNoRawToken(outreachRows, 'solicitation_outreach');

        // The other half of "in memory only": the STORED bytes are untouched.
        // Substitution is mechanical and excluded from the byte-for-byte
        // **Owner approval** contract precisely because it never lands here.
        const storedBody = outreachRows[0]?.rendered_body;
        expect(storedBody).toContain(UNSUBSCRIBE_URL_PLACEHOLDER);
        expect(storedBody).toContain(REVIEW_LINK_PLACEHOLDER);
      });
    });

    // ---- tx1 CAS, the provider call, tx2 (Task 6) --------------------------
    describe('send and terminal transaction', () => {
      // Decision 4 + 9b. A row already `sending` means a prior invocation owned
      // it; re-gating could withhold a message that is already on the wire.
      it('resumes a sending Outreach row without re-running the Dispatch gate', async () => {
        await setAttestedPostalAddress(SEEDED_POSTAL_ADDRESS);
        const fixture = await seedQueuedOutreach();

        // The crash: tx1 committed (token + `sending`), tx2 never did.
        await crashAfterTx1(fixture, 'dispatch-resume-crash');
        expect((await readOutreach(fixture.outreachId)).delivery_status).toBe('sending');

        // Now BREAK the gate underneath the row. If the resume path re-gated,
        // item 4 would fire and this row would end up `withheld` / `suppressed`
        // — a terminal lie about an ask that may already be in someone's inbox.
        await seedAccountSuppression(fixture.handle);

        messagingMocks.send.mockClear();
        await redispatchAfterCrash(fixture, 'dispatch-resume');

        const row = await readOutreach(fixture.outreachId);
        // The gate did not run: no withhold, no reason, and the consent
        // snapshot is the one the FIRST invocation stamped.
        expect(row.delivery_status).toBe('sending');
        expect(row.disposition_reason).toBeNull();
        expect(row.sent_at).toBeNull();
        expect(row.provider_message_id).toBeNull();
        // The suppression signal is a gate-item side effect, so its absence is
        // second, independent evidence that item 4 was never evaluated.
        expect(
          await countAnalyticsEvents(`solicitation_suppressed_at_dispatch_${fixture.askId}`),
        ).toBe(0);

        // And no second message: the raw token died with the first process, so
        // any body this one could build would carry a dead unsubscribe URL.
        expect(messagingMocks.send).not.toHaveBeenCalled();

        // The child is left `running` for #900's D12d sweep, and exactly ONE
        // child exists — a re-gate would have created a second run for the ask.
        expect(row.agent_run_id).not.toBeNull();
        const child = await readChildRun(row.agent_run_id!);
        expect(child.status).toBe('running');
        expect(child.step_keys).toEqual(['dispatch_gate_evaluated']);

        // The attempt is spent, or the watchdog re-pends work that can never
        // make progress.
        expect((await readOutbox(fixture.outboxId)).status).toBe('completed');
      });
      // A `sent` row with a NULL provider_message_id makes every later bounce
      // and complaint unattributable — persisting it is not optional.
      it('persists provider_message_id on every successful send', async () => {
        await setAttestedPostalAddress(SEEDED_POSTAL_ADDRESS);

        // TWO sends with DIFFERENT provider ids: "every" is the claim, and one
        // row cannot distinguish "persisted the id" from "persisted a constant".
        for (const providerMessageId of ['msg_live_first', 'msg_live_second']) {
          const fixture = await seedQueuedOutreach();
          resetProviderSend(providerMessageId);

          await dispatchToCompletion(fixture, `dispatch-sent-${providerMessageId}`);

          const row = await readOutreach(fixture.outreachId);
          expect(row.delivery_status).toBe('sent');
          expect(row.provider_message_id).toBe(providerMessageId);
          // 091 pairs the two: `(delivery_status = 'sent') = (sent_at IS NOT NULL)`.
          expect(row.sent_at).not.toBeNull();
          // The tx1 CAS's own stamp, and this row's alone — the batch's
          // `sending_started_at` is #900's column and a different fact.
          expect(row.sending_at).not.toBeNull();
          // A successful send has nothing to explain.
          expect(row.disposition_reason).toBeNull();
          expect(row.bounced_at).toBeNull();
        }

        resetProviderSend();
      });
      // D12a's all-or-nothing claim. Proved by aborting the transaction with
      // `abortingExecutor` and asserting NONE of the five facts survived — an
      // outbox row left incomplete keeps the watchdog owning the work, which is
      // why no orphan sweeper is needed.
      it('commits the terminal CAS, the child run terminal, the solicitation_sent outcome, the outbox completion and closeBatchIfSettled in one transaction', async () => {
        await setAttestedPostalAddress(SEEDED_POSTAL_ADDRESS);
        const fixture = await seedQueuedOutreach();
        resetProviderSend('msg_live_atomic');

        // tx1 commits, the provider is called, tx2 aborts on a REAL Postgres
        // error — never a temporary CHECK constraint, which is run-time DDL and
        // deadlocks the live-DB lane (40P01).
        await crashAfterTx1(fixture, 'dispatch-terminal-atomic');

        // The provider DID see the message. That is what makes the five
        // assertions below a claim about atomicity rather than about a dispatch
        // that never happened.
        expect(messagingMocks.send).toHaveBeenCalledTimes(1);

        const row = await readOutreach(fixture.outreachId);
        // 1. the terminal CAS
        expect(row.delivery_status).toBe('sending');
        expect(row.sent_at).toBeNull();
        expect(row.provider_message_id).toBeNull();

        // 2. the child run terminal
        expect(row.agent_run_id).not.toBeNull();
        const child = await readChildRun(row.agent_run_id!);
        expect(child.status).toBe('running');
        expect(child.step_keys).toEqual(['dispatch_gate_evaluated']);

        // 3. the outcome
        expect(await readOutcomes(row.agent_run_id!)).toEqual([]);

        // 4. the outbox completion — still in flight, so the watchdog owns the
        // work and there is no orphan class for a sweeper to own.
        const outbox = await readOutbox(fixture.outboxId);
        expect(outbox.status).toBe('dispatched');
        expect(outbox.completed_at).toBeNull();

        // 5. the batch-closure join
        expect(await readBatchClosedAt(fixture.batchId)).toBeNull();

        resetProviderSend();
      });
      // D14: outcomes live on CHILDREN. One on the Send batch parent would
      // double-count the batch in every downstream metric.
      it('emits solicitation_sent on the child run with unit_count 1, never on the Send batch parent', async () => {
        await setAttestedPostalAddress(SEEDED_POSTAL_ADDRESS);
        const fixture = await seedQueuedOutreach();
        const parentRunId = await readSendParentRunId(fixture.batchId);

        await dispatchToCompletion(fixture, 'dispatch-outcome-child');

        const row = await readOutreach(fixture.outreachId);
        expect(row.agent_run_id).not.toBeNull();
        expect(row.agent_run_id).not.toBe(parentRunId);

        // Half 1: the outcome exists on the CHILD, once, counting one ask.
        expect(await readOutcomes(row.agent_run_id!)).toEqual([
          { outcome_kind: 'solicitation_sent', unit_count: 1, attributed_agent: 'solicitation' },
        ]);

        // Half 2, and the half that actually pins D14:
        // `agent_outcomes_once_per_run_kind` is UNIQUE (agent_run_id,
        // outcome_kind), so a parent-attributed emit would collapse a 25-ask
        // batch into ONE row and under-report it by 24 forever.
        expect(
          (await readOutcomes(parentRunId)).filter(
            (outcome) => outcome.outcome_kind === 'solicitation_sent',
          ),
        ).toEqual([]);
      });
      // `terminal_bounce` is the only class that stamps `bounced_at`, and that
      // stamp is what feeds the Suppression ledger (#626).
      it('classifies a provider hard bounce as terminal with zero retries and stamps bounced_at', async () => {
        await setAttestedPostalAddress(SEEDED_POSTAL_ADDRESS);
        const fixture = await seedQueuedOutreach();

        // D12c row 1, in the shape `EmailAdapter` throws it: Resend's
        // `ErrorResponse` on `cause`, a 4xx that is not 408/429, a
        // recipient-scoped code, and the offending FIELD named in the message.
        // All four conjuncts are required — `validation_error` covers a bad
        // subject as readily as a bad recipient.
        await withProviderFailure(
          new Error('Resend refused the solicitation send', {
            cause: {
              name: 'validation_error',
              statusCode: 422,
              message: 'Invalid `to` field. The email address is not valid.',
            },
          }),
          async () => {
            await dispatchToCompletion(fixture, 'dispatch-hard-bounce');
          },
        );

        // ZERO retries: re-mailing a dead address is how a sender's reputation
        // dies, so the bounce class never re-enters the backoff ladder.
        expect(messagingMocks.send).toHaveBeenCalledTimes(1);

        const row = await readOutreach(fixture.outreachId);
        expect(row.delivery_status).toBe('failed');
        expect(row.disposition_reason).toBe('send_failed');
        expect(row.bounced_at).not.toBeNull();
        // Left NULL deliberately: `send-breaker.ts` counts an unclassified
        // bounce WITH the hard ones, so this lane never asserts a kind the
        // provider did not give it.
        expect(row.bounce_kind).toBeNull();
        // Nothing sent, so nothing to attribute a later webhook to.
        expect(row.sent_at).toBeNull();
        expect(row.provider_message_id).toBeNull();

        // Decision 8: a failure to send terminalizes the child `failed`, and
        // there is no `ask_sent` step and no `solicitation_sent` outcome.
        const child = await readChildRun(row.agent_run_id!);
        expect(child.status).toBe('failed');
        expect(child.step_keys).toEqual(['dispatch_gate_evaluated']);
        expect(await readOutcomes(row.agent_run_id!)).toEqual([]);

        // The attempt is spent and the batch still joins — a terminal failure
        // settles the batch exactly as a send does.
        expect((await readOutbox(fixture.outboxId)).status).toBe('completed');
        expect(await readBatchClosedAt(fixture.batchId)).not.toBeNull();
      });
      // The third class the first plan draft left unhandled: no `bounced_at`
      // (nothing bounced), still terminal, still joined. A class with no arm is
      // how rows get stranded in `sending` forever.
      it('terminalizes a terminal_other provider error without retrying or leaving the Outreach row sending', async () => {
        await setAttestedPostalAddress(SEEDED_POSTAL_ADDRESS);
        const fixture = await seedQueuedOutreach();

        // `classifySendFailure` is TOTAL over `unknown`, and everything its
        // three rows cannot name lands here — including this real one, which
        // `EmailAdapter` throws when Resend accepts a send but returns no id.
        await withProviderFailure(
          new Error('Resend accepted the solicitation send but returned no message id'),
          async () => {
            await dispatchToCompletion(fixture, 'dispatch-terminal-other');
          },
        );

        expect(messagingMocks.send).toHaveBeenCalledTimes(1);

        const row = await readOutreach(fixture.outreachId);
        // Terminal, and NOT left `sending`: a `sending` row is #900's D12d
        // sweep's to resolve after a grace window, and stranding a row we
        // already have an answer for is what that arm exists to prevent.
        expect(row.delivery_status).toBe('failed');
        expect(row.disposition_reason).toBe('send_failed');
        // NO bounce stamp — nothing bounced. Stamping one would suppress a
        // contact over our own failure and feed the breaker a false numerator.
        expect(row.bounced_at).toBeNull();
        expect(row.sent_at).toBeNull();

        const child = await readChildRun(row.agent_run_id!);
        expect(child.status).toBe('failed');
        expect(await readOutcomes(row.agent_run_id!)).toEqual([]);
        expect((await readOutbox(fixture.outboxId)).status).toBe('completed');
        expect(await readBatchClosedAt(fixture.batchId)).not.toBeNull();
      });
      // Decision 9b — the cost this plan accepts in writing. The raw token is
      // unrecoverable across a process boundary, so no correct message can be
      // built; re-issuing would send a body with a dead unsubscribe URL. The
      // row is left `sending` for #900's D12d sweep to call `unknown`.
      it('does not call the Messaging adapter when re-invoked in a fresh process without the raw token', async () => {
        await setAttestedPostalAddress(SEEDED_POSTAL_ADDRESS);
        const fixture = await seedQueuedOutreach();

        // Invocation 1 mints, CASes the row to `sending`, calls the provider —
        // and then dies before tx2 commits. In production that is a crash
        // between the provider's answer and the terminal transaction; here it
        // is `crashAfterTx1`, which produces the identical row state.
        await crashAfterTx1(fixture, 'dispatch-crash-first');
        const before = await readOutreach(fixture.outreachId);
        expect(before.delivery_status).toBe('sending');

        // Invocation 2 is the fresh process. It finds the row already
        // `sending`, with no way back to the raw token that built its body.
        messagingMocks.send.mockClear();
        await redispatchAfterCrash(fixture, 'dispatch-crash-retry');

        // THE claim. Re-issuing under the same idempotency key does not save
        // us: if the first request never reached the provider, the RETRY's body
        // is what gets delivered, carrying an unsubscribe URL for a token this
        // process cannot reproduce.
        //
        // Task 6 wires `getMessagingAdapter().send(message)` on the passing
        // path; this spy is stubbed at that seam so the assertion keeps its
        // meaning the moment that call becomes real.
        expect(messagingMocks.send).not.toHaveBeenCalled();

        // Nothing else moved either. `delivery_status` is left exactly as the
        // prior process left it — #900's D12d sweep is what terminalizes a
        // `sending` row `unknown` / `send_indeterminate`, not this worker.
        const after = await readOutreach(fixture.outreachId);
        expect(after.delivery_status).toBe(before.delivery_status);
        expect(after.disposition_reason).toBeNull();
        expect(after.sent_at).toBeNull();
        expect(after.provider_message_id).toBeNull();

        // But the attempt IS spent, or the watchdog re-pends a row that can
        // never make progress — a retry storm over an unrecoverable body.
        const outbox = await readOutbox(fixture.outboxId);
        expect(outbox.status).toBe('completed');
        expect(outbox.completed_at).not.toBeNull();
      });
      // At-least-once outbox delivery means the same attempt can arrive twice.
      // A stale attempt number must not reach the provider.
      it('ignores a stale outbox attempt and does not call the Messaging adapter', async () => {
        const fixture = await seedQueuedOutreach();
        await setAttestedPostalAddress(SEEDED_POSTAL_ADDRESS);

        await withSendFlagOn(async () => {
          await dispatchOutreach(sql(), {
            batchId: fixture.batchId,
            businessId,
            outreachId: fixture.outreachId,
            // The watchdog re-dispatched this row; the seeded outbox attempt is
            // 1, so attempt 2 is the ONLY owner and this job is the loser of
            // that race arriving late.
            outboxHandle: { outboxId: fixture.outboxId, attempt: fixture.attempt + 1 },
            correlationId: 'dispatch-stale-attempt',
          });
        });

        // The Messaging adapter is not reachable from a stale attempt because
        // the guard is the FIRST statement in tx1 — before the batch lock,
        // before the gate, before anything that could send. What a live DB can
        // witness is the whole state that would have moved on the way there,
        // and none of it did.
        const row = await readOutreach(fixture.outreachId);
        expect(row.delivery_status).toBe('queued');
        expect(row.sending_at).toBeNull();
        expect(row.sent_at).toBeNull();
        expect(row.provider_message_id).toBeNull();
        expect(row.consent_basis).toBeNull();
        expect(row.agent_run_id).toBeNull();

        // And the newer attempt's outbox row is left alone: completing it here
        // would strand the attempt that actually owns this work.
        const outbox = await readOutbox(fixture.outboxId);
        expect(outbox.status).toBe('dispatched');
        expect(outbox.completed_at).toBeNull();
      });
    });

    // ---- The inline join (Task 6, D11) -------------------------------------
    describe('batch closure', () => {
      // A Settled batch has no Outreach row left in `rendered`, `queued` or
      // `sending`. Every terminal writer calls `closeBatchIfSettled` in the
      // SAME transaction, so the last writer across a MIXED terminal set — not
      // just an all-sent one — is what closes it.
      it('closes the batch once the last Outreach row terminalizes across a mixed sent, withheld and failed set', async () => {
        await setAttestedPostalAddress(SEEDED_POSTAL_ADDRESS);

        // ONE batch, THREE children — the two later fixtures attach to the
        // first one's batch rather than minting their own, because a fresh
        // batch would retire this one (D8) and close it for the wrong reason.
        const sent = await seedQueuedOutreach();
        const withheld = await seedQueuedOutreach({
          batchId: sent.batchId,
          consent: 'absent',
        });
        const failed = await seedQueuedOutreach({ batchId: sent.batchId });

        // 1. A withhold is a terminal writer and calls the join like every
        //    other one — and the batch stays OPEN, because two siblings are
        //    still live. "Not before" is half of this claim.
        await withSendFlagOn(async () => {
          await dispatchOutreach(sql(), {
            batchId: withheld.batchId,
            businessId,
            outreachId: withheld.outreachId,
            outboxHandle: { outboxId: withheld.outboxId, attempt: withheld.attempt },
            correlationId: 'dispatch-mixed-withheld',
          });
        });
        expect((await readOutreach(withheld.outreachId)).delivery_status).toBe('withheld');
        expect(await readBatchClosedAt(sent.batchId)).toBeNull();

        // 2. A terminal provider failure — a DIFFERENT terminal status, which
        //    is what makes this a mixed set rather than three of a kind.
        await withProviderFailure(
          new Error('Resend accepted the solicitation send but returned no message id'),
          async () => {
            await dispatchToCompletion(failed, 'dispatch-mixed-failed');
          },
        );
        expect((await readOutreach(failed.outreachId)).delivery_status).toBe('failed');
        expect(await readBatchClosedAt(sent.batchId)).toBeNull();

        // 3. The LAST row to terminalize is what closes the batch, whichever
        //    terminal status it happens to carry.
        resetProviderSend('msg_live_mixed_close');
        await dispatchToCompletion(sent, 'dispatch-mixed-sent');
        expect((await readOutreach(sent.outreachId)).delivery_status).toBe('sent');

        const closedAt = await readBatchClosedAt(sent.batchId);
        expect(closedAt).not.toBeNull();

        // Closed ONCE. `closeBatchIfSettled` CASes `send_closed_at` on NULL and
        // gates the receipt step behind that CAS, so the parent carries exactly
        // one `send_batch_closed` — three terminal writers, one closure.
        const parentRunId = await readSendParentRunId(sent.batchId);
        const parent = await readChildRun(parentRunId);
        expect(parent.step_keys.filter((key) => key === 'send_batch_closed')).toHaveLength(1);

        // ...and a fourth caller writes nothing at all, which is what makes the
        // join safe to call from every terminal writer in the lane.
        const second = await sql().begin(async (tx) =>
          closeBatchIfSettled(tx, {
            batchId: sent.batchId,
            accountId: accountId(),
            businessId,
          }));
        expect(second).toMatchObject({ status: 'already_closed' });
        expect(await readBatchClosedAt(sent.batchId)).toBe(closedAt);

        resetProviderSend();
      });
      // The flag-off defer still completes the outbox attempt. Leaving it
      // in-flight would have the watchdog re-pend a row that was correctly
      // deferred, turning a quiet no-op into a retry storm.
      it('completes the outbox attempt when deferring on a flag-off so the watchdog does not re-pend it', async () => {
        const fixture = await seedQueuedOutreach();

        await withSendFlagOff(async () => {
          await dispatchOutreach(sql(), {
            batchId: fixture.batchId,
            businessId,
            outreachId: fixture.outreachId,
            outboxHandle: { outboxId: fixture.outboxId, attempt: fixture.attempt },
            correlationId: 'dispatch-flag-off-outbox',
          });
        });

        const row = await readOutbox(fixture.outboxId);
        // `completed`, not any in-flight status: the watchdog reclaims
        // ('pending', 'dispatching', 'dispatched'), so a defer that left the
        // row in that set would be re-dispatched every stale window forever.
        expect(row.status).toBe('completed');
        expect(row.completed_at).not.toBeNull();
      });
      // The Halt latch deliberately excludes `sending`. A halt that lands after
      // the CAS must leave the in-flight child alone; cancelling it would
      // terminalize a run whose message is already on the wire.
      it('does not cancel an in-flight sending child when a halt lands after the CAS', async () => {
        await setAttestedPostalAddress(SEEDED_POSTAL_ADDRESS);
        const inFlight = await seedQueuedOutreach();
        // A sibling left `queued` on the SAME batch, so the sweep has something
        // it may legitimately cancel. Without it, "left the sending row alone"
        // is indistinguishable from "the sweep never ran".
        const stillQueued = await seedQueuedOutreach({ batchId: inFlight.batchId });

        // The halt lands in the ONE window D10 is written about: tx1 has
        // committed (the row is `sending`, the token is minted), the message is
        // at the provider, and tx2 has not run yet. The adapter call is the
        // only moment that window exists, so that is where the halt is fired —
        // through the real `haltBatch`, never a hand-rolled UPDATE.
        let halt: HaltBatchResult | undefined;
        messagingMocks.send.mockImplementation(async () => {
          halt = await haltBatch(sql(), {
            batchId: inFlight.batchId,
            accountId: accountId(),
            businessId,
            haltedByUserId: userId(),
          });
          return { providerMessageId: 'msg_live_halt_after_cas' };
        });

        await dispatchToCompletion(inFlight, 'dispatch-halt-after-cas');
        resetProviderSend();

        // The latch really did land, and its sweep really did run: ONE
        // cancellation, and it is the `queued` sibling.
        expect(halt?.status).toBe('halted');
        expect(halt?.status === 'halted' ? halt.cancelledCount : -1).toBe(1);
        const swept = await readOutreach(stillQueued.outreachId);
        expect(swept.delivery_status).toBe('cancelled');
        expect(swept.disposition_reason).toBe('owner_halt');

        // THE claim. Halt means "no further sends", not "undo": a row past the
        // CAS is past the point of no return, and the residual exposure is one
        // child's send-transaction duration.
        const row = await readOutreach(inFlight.outreachId);
        expect(row.delivery_status).toBe('sent');
        expect(row.provider_message_id).toBe('msg_live_halt_after_cas');
        expect(row.sent_at).not.toBeNull();
        expect(row.disposition_reason).toBeNull();

        // Its child finished too — `completed`, never `cancelled`. Terminalizing
        // the run of a message already on the wire as refused would make the
        // spine lie about what the recipient received.
        expect(row.agent_run_id).not.toBeNull();
        const child = await readChildRun(row.agent_run_id!);
        expect(child.status).toBe('completed');
        expect(child.step_keys).toEqual(['dispatch_gate_evaluated', 'ask_sent']);

        // tx2 committed in full behind the halt: the attempt is spent, and its
        // own `closeBatchIfSettled` is what finally settles the halted batch —
        // the halt's join found this row still live and correctly declined.
        expect((await readOutbox(inFlight.outboxId)).status).toBe('completed');
        expect(await readBatchClosedAt(inFlight.batchId)).not.toBeNull();
      });
    });

    // ---- The integrity spine (2026-08-22 guard-integrity pass) -------------
    //
    // Three guards were measured UNPINNED by mutation: each one was deleted,
    // the whole solicitation lane ran, and everything stayed green. A
    // whole-repo grep of `src` + `worker` returned ZERO test-file references
    // for their outcome discriminants. Evidence:
    // docs/reviews/PATHFINDER-2026-08-22/06-guard-integrity.md.
    //
    // The lane's DECISION logic is well pinned by the cases above. What was
    // not pinned is its CONCURRENCY and INTEGRITY spine, and all three of
    // those failure modes are SILENT in production: moderating one artifact
    // and sending another, a value-ledger row with no join key behind it, and
    // a double send.
    //
    // Every case here asserts the OBSERVABLE OUTCOME — rows, adapter calls,
    // and the one structured line that carries the discriminant. Never the SQL
    // text: a query-shape pin passes with the predicate deleted, which is the
    // exact failure being fixed.
    describe('integrity spine', () => {
      // A4, and the SOLE mechanical proof that the bytes moderated are the
      // bytes sent. ADR 0020's immutability is enforced in a domain module and
      // NOT in the schema, so nothing in Postgres stops a repair script, a new
      // lane or a future writer from editing `rendered_body` after the slow
      // items were computed over it.
      //
      // The race is staged inside `moderateResponse` because that is the one
      // remote call the slow gather makes and it runs with NO lock held —
      // exactly the window a competing writer has. The digest is taken from the
      // IN-MEMORY row, so the update lands after the verdict was computed and
      // before the locked re-read, which is the whole hazard.
      it('defers with bytes_changed_under_gate when the stored body changes between the slow gate and the lock', async () => {
        await setAttestedPostalAddress(SEEDED_POSTAL_ADDRESS);
        const fixture = await seedQueuedOutreach();
        resetProviderSend();

        moderationMocks.moderateResponse.mockImplementation(async () => {
          // The competing writer. Only the BODY moves: `rendered_subject` stays
          // put so the row remains legal under 091's
          // `solicitation_outreach_body_presence` CHECK, and the body is the
          // half A4's length-prefixed digest exists to catch.
          await sql()`
            UPDATE solicitation_outreach
            SET rendered_body = ${'A different artifact entirely.'},
                updated_at = NOW()
            WHERE id = ${fixture.outreachId}::uuid
              AND account_id = ${accountId()}::uuid
              AND business_id = ${businessId}::uuid
          `;
          return CLEAN_MODERATION;
        });

        let warnings: CapturedLogLine[] = [];
        try {
          warnings = await captureWarnLines(async () => {
            await withSendFlagOn(async () => {
              await dispatchOutreach(sql(), {
                batchId: fixture.batchId,
                businessId,
                outreachId: fixture.outreachId,
                outboxHandle: { outboxId: fixture.outboxId, attempt: fixture.attempt },
                correlationId: 'dispatch-bytes-changed-under-gate',
              });
            });
          });
        } finally {
          moderationMocks.moderateResponse.mockImplementation(
            (text) => moderationMocks.real.current!(text),
          );
        }

        // THE discriminant. Without it every assertion below is also true of a
        // `not_dispatchable` row, and the case would pass with the comparison
        // deleted.
        expect(warnings.map((line) => line.message)).toContain(
          'solicitation send no-op: stored bytes changed between the gate and the lock',
        );

        // A DEFER, not a withhold. Nothing is wrong with the ask — a writer was
        // raced — so the row is left exactly as it was found, for a later
        // attempt to re-gather against the new bytes and decide honestly.
        const row = await readOutreach(fixture.outreachId);
        expect(row.delivery_status).toBe('queued');
        expect(row.disposition_reason).toBeNull();
        expect(row.sending_at).toBeNull();
        expect(row.sent_at).toBeNull();
        expect(row.provider_message_id).toBeNull();

        // The triage returns ABOVE `stampConsentSnapshot`, the mint and the
        // Lazy child, so none of the three ran. This is what separates a defer
        // from every terminal path in the file.
        expect(row.consent_row_id).toBeNull();
        expect(row.agent_run_id).toBeNull();
        expect(await readTokenRows(fixture.outreachId)).toHaveLength(0);

        // The adapter is NEVER reached: the whole point is that unverified
        // bytes do not go on the wire.
        expect(messagingMocks.send).not.toHaveBeenCalled();

        // Only the outbox attempt is spent. Leaving it in flight would have the
        // watchdog re-pend a row that was correctly deferred.
        const outbox = await readOutbox(fixture.outboxId);
        expect(outbox.status).toBe('completed');
        expect(outbox.completed_at).not.toBeNull();
      });

      // The terminal CAS. Its docstring states FOUR consequences of finding no
      // `sending` row, and none of them was asserted anywhere: the other
      // writer's terminal stands, `provider_message_id` does not persist, no
      // `solicitation_sent` value-ledger row is written, and the child is not
      // `completed`.
      //
      // The competing writer lands in the provider window — tx1 has committed,
      // the message is at the adapter, tx2 has not run — which is the only
      // window this hazard has, and the same window the halt case above uses.
      //
      // `unknown` / `send_indeterminate` rather than `failed`: BOTH real
      // candidates for a row already in `sending` write exactly that pair
      // (#900's D12d sweep, and the exhaustion hook's `sending` arm — its
      // `failed` / `send_exhausted` belongs to a `queued` arrival). Seeding
      // `failed` here would stage a state no writer in this lane produces.
      it('commits nothing when the terminal CAS finds the row already terminalized by another writer', async () => {
        await setAttestedPostalAddress(SEEDED_POSTAL_ADDRESS);
        const fixture = await seedQueuedOutreach();
        resetProviderSend('msg_live_terminal_cas_lost');

        messagingMocks.send.mockImplementation(async () => {
          await sql()`
            UPDATE solicitation_outreach
            SET delivery_status = 'unknown',
                disposition_reason = 'send_indeterminate',
                updated_at = NOW()
            WHERE id = ${fixture.outreachId}::uuid
              AND account_id = ${accountId()}::uuid
              AND business_id = ${businessId}::uuid
              AND delivery_status = 'sending'
          `;
          return { providerMessageId: 'msg_live_terminal_cas_lost' };
        });

        const warnings = await captureWarnLines(async () => {
          await withCleanModeration(async () => {
            await withSendFlagOn(async () => {
              await dispatchOutreach(sql(), {
                batchId: fixture.batchId,
                businessId,
                outreachId: fixture.outreachId,
                outboxHandle: { outboxId: fixture.outboxId, attempt: fixture.attempt },
                correlationId: 'dispatch-terminal-cas-lost',
              });
            });
          });
        });
        resetProviderSend();

        // The provider DID see the message. That is what makes the four claims
        // below a statement about the CAS rather than about a dispatch that
        // never happened.
        expect(warnings.map((line) => line.message)).toContain(
          'solicitation send: terminal CAS found no sending row — another writer owns it',
        );

        const row = await readOutreach(fixture.outreachId);
        // 1. the other writer's verdict STANDS — the CAS is what makes that true.
        expect(row.delivery_status).toBe('unknown');
        expect(row.disposition_reason).toBe('send_indeterminate');
        expect(row.sent_at).toBeNull();
        // 2. the provider id did not persist...
        expect(row.provider_message_id).toBeNull();

        expect(row.agent_run_id).not.toBeNull();
        // 3. ...which is precisely why no `solicitation_sent` outcome may be
        // written: it would be a value-ledger row with no join key behind it.
        expect(await readOutcomes(row.agent_run_id!)).toEqual([]);

        // 4. and no `completed` child, which would claim a delivery this
        // transaction failed to record.
        const child = await readChildRun(row.agent_run_id!);
        expect(child.status).toBe('running');
        expect(child.step_keys).toEqual(['dispatch_gate_evaluated']);

        // The outbox attempt is the ONE thing still owed on that branch — this
        // invocation reached the provider and can make no further progress.
        expect((await readOutbox(fixture.outboxId)).status).toBe('completed');
        // `closeBatchIfSettled` rides with the terminal facts, so a CAS that
        // found nothing must not join the batch either: the writer that DID
        // terminalize the row joins it in its own transaction.
        expect(await readBatchClosedAt(fixture.batchId)).toBeNull();
      });

      // The `queued → sending` CAS — the claim itself. After tx1 commits, a
      // token row ALWAYS implies a `sending` row, and decision 9's resume path
      // depends on that; without the predicate a second dispatcher re-claims a
      // row the first already owns and both reach the provider.
      //
      // Deliberately NOT merged with the terminal-CAS case above. They guard
      // opposite transitions — INTO `sending` versus OUT of it — and report
      // different discriminants.
      //
      // The competing dispatcher writes on the SAME transaction, because the
      // row is held `FOR UPDATE` from the triage read to the CAS and a second
      // connection would block rather than win. `recordStep` is the last spine
      // write before the claim and the only importable collaborator this
      // module hands `tx` to in that span.
      it('claims nothing and does not send when the queued CAS loses the row to another dispatcher', async () => {
        await setAttestedPostalAddress(SEEDED_POSTAL_ADDRESS);
        const fixture = await seedQueuedOutreach();
        resetProviderSend();

        // Distinctly EARLIER than the transaction's own `NOW()`, and still
        // `>= queued_at` (the fixture queues at `NOW() - 30 seconds`), so
        // 091's status/timestamp CHECK holds and a re-stamp by the CAS is
        // visible as a different value rather than hidden by
        // `NOW()` being constant inside one transaction.
        let claimedSendingAt: string | null = null;
        runSpineMocks.onRecordStep.current = async (tx, input) => {
          if (input.stepKey !== 'dispatch_gate_evaluated') return;
          if (claimedSendingAt !== null) return;
          const [claimed] = await tx<{ sending_at: string }[]>`
            UPDATE solicitation_outreach
            SET delivery_status = 'sending',
                sending_at = NOW() - INTERVAL '10 seconds',
                updated_at = NOW()
            WHERE id = ${fixture.outreachId}::uuid
              AND account_id = ${accountId()}::uuid
              AND business_id = ${businessId}::uuid
              AND delivery_status = 'queued'
            RETURNING sending_at::text AS sending_at
          `;
          claimedSendingAt = claimed?.sending_at ?? null;
        };

        let warnings: CapturedLogLine[] = [];
        try {
          warnings = await captureWarnLines(async () => {
            await withCleanModeration(async () => {
              await withSendFlagOn(async () => {
                await dispatchOutreach(sql(), {
                  batchId: fixture.batchId,
                  businessId,
                  outreachId: fixture.outreachId,
                  outboxHandle: { outboxId: fixture.outboxId, attempt: fixture.attempt },
                  correlationId: 'dispatch-queued-cas-lost',
                });
              });
            });
          });
        } finally {
          runSpineMocks.onRecordStep.current = null;
        }

        // The race really was staged — otherwise every assertion below is a
        // claim about a dispatch that simply never got that far.
        expect(claimedSendingAt).not.toBeNull();

        // THE discriminant, and its OWN detector: all the CAS observed is
        // "the row was no longer `queued`". `sending_row` would claim a fact
        // nothing here established, and it is reached by a different branch.
        const inFlight = warnings.find(
          (line) =>
            line.message
              === 'solicitation send: dispatch already in flight elsewhere — not re-sending',
        );
        expect(inFlight?.data?.detector).toBe('cas_lost');

        // No double send. This is the production damage the predicate prevents.
        expect(messagingMocks.send).not.toHaveBeenCalled();

        const row = await readOutreach(fixture.outreachId);
        // The other dispatcher's claim stands, untouched: the CAS wrote no
        // status, no `sending_at` and no `updated_at` re-stamp.
        expect(row.delivery_status).toBe('sending');
        expect(row.sending_at).toBe(claimedSendingAt);
        expect(row.sent_at).toBeNull();
        expect(row.provider_message_id).toBeNull();
        expect(row.disposition_reason).toBeNull();

        // Proof this case reached the CAS rather than short-circuiting at the
        // triage: the mint and the Lazy child are BOTH past, and they sit
        // between the triage and the claim.
        expect(await readTokenRows(fixture.outreachId)).toHaveLength(1);
        expect(row.agent_run_id).not.toBeNull();
        const child = await readChildRun(row.agent_run_id!);
        expect(child.status).toBe('running');
        expect(child.step_keys).toEqual(['dispatch_gate_evaluated']);

        // The attempt is spent: this invocation can make no further progress on
        // the row, so leaving it in flight would only have the watchdog
        // re-dispatch a job whose sole remaining act is to observe the same
        // thing.
        expect((await readOutbox(fixture.outboxId)).status).toBe('completed');
      });
    });

    // ── #1010 T4: `outreach_withheld`, the DISPATCH half ────────────────────
    //
    // One Refusal per withheld Outreach row, written by `commitWithhold` inside
    // tx1 — the same transaction as the withheld terminal, the Lazy child, the
    // receipt step, the outbox completion and the settlement join.
    //
    // `occurredAt` here is the GATE's own `now`, threaded in from
    // `runDispatchTx`, and NOT the `'transaction_time'` sentinel. tx1 acquires
    // the per-Business advisory lock and two row locks BEFORE the gate runs, so
    // under contention the sentinel would stamp a decision measurably before it
    // was made (plan §0 D-B).
    describe('Refusal ledger', () => {
      it('a dispatch withhold writes one refusal_events row against the outreach id', async () => {
        const fixture = await seedQueuedOutreach();
        await setAttestedPostalAddress(null);

        await dispatchWithFlagOn(fixture, 'dispatch-refusal-one-row');

        expect(await readOutreach(fixture.outreachId)).toMatchObject({
          delivery_status: 'withheld',
          disposition_reason: 'no_postal_address',
        });

        const refusals = await readRefusalsForOutreach(fixture.outreachId);
        // ONE row, against the OUTREACH — not the ask, and not the batch. The
        // ask is the subject of the `ask_withheld` lane and re-using it here
        // would collide two different decisions on one partial-index key.
        expect(refusals).toHaveLength(1);
        expect(refusals[0]).toMatchObject({
          account_id: accountId(),
          business_id: businessId,
          refusal_source: 'outreach_withheld',
          subject_type: 'solicitation_outreach',
          subject_id: fixture.outreachId,
          // The gate's reason VERBATIM, and the category this lane's map — the
          // DISPATCH half, never the render half — assigns it.
          refusal_code: 'no_postal_address',
          refusal_category: OUTREACH_WITHHELD_DISPATCH_REFUSAL_CATEGORIES.no_postal_address,
          all_refusal_codes: null,
        });
      });

      it("a dispatch withhold stamps occurred_at with the gate's decision clock, not with transaction start", async () => {
        const fixture = await seedQueuedOutreach();
        await setAttestedPostalAddress(null);

        // THE MEASUREMENT. Holding the advisory key makes tx1 begin, block, and
        // only then reach the gate — so the two candidate values are separated
        // by the hold rather than by a few microseconds. An assertion that only
        // checked "close to now" passes under BOTH and measures nothing.
        const lock = holdBatchLock('0.5 seconds');
        await lock.held;
        await Promise.all([
          dispatchWithFlagOn(fixture, 'dispatch-refusal-gate-clock'),
          lock.released,
        ]);

        const [refusal] = await readRefusalsForOutreach(fixture.outreachId);
        expect(refusal, 'the withhold wrote no Refusal').toBeDefined();
        // `created_at` IS tx1's `transaction_timestamp()`. A row stamped with
        // the `'transaction_time'` sentinel would land on it exactly, giving a
        // skew of zero.
        expect(Number(refusal!.gate_skew_seconds)).toBeGreaterThan(0.3);
        expect(refusal!.occurred_at).not.toBe(refusal!.created_at);
      });

      it('a dispatch defer writes no refusal_events row', async () => {
        // A defer is a NO-DECISION: the row keeps its status and #900's producer
        // re-drips it, so claiming RepWorth refused anything would be false.
        // BOTH defer paths are covered — the gate's own `batch_open` item, and
        // the flag-off short-circuit above tx1, which is decision 5's answer to
        // an item 091/110 carry no withheld reason for.
        const gateDefer = await seedQueuedOutreach();
        await setAttestedPostalAddress(SEEDED_POSTAL_ADDRESS);
        // The batch closes while the row is still `queued` — `isBatchOpenForSend`
        // then answers false and item 1 defers.
        await sql()`
          UPDATE solicitation_batches SET send_closed_at = NOW()
          WHERE id = ${gateDefer.batchId}::uuid AND account_id = ${accountId()}::uuid
        `;

        await dispatchWithFlagOn(gateDefer, 'dispatch-refusal-defer-batch-open');

        expect(await readOutreach(gateDefer.outreachId)).toMatchObject({
          delivery_status: 'queued',
          disposition_reason: null,
        });
        expect(await readRefusalsForOutreach(gateDefer.outreachId)).toEqual([]);

        const flagDefer = await seedQueuedOutreach();
        await withSendFlagOff(async () => {
          await dispatchOutreach(sql(), {
            batchId: flagDefer.batchId,
            businessId,
            outreachId: flagDefer.outreachId,
            outboxHandle: { outboxId: flagDefer.outboxId, attempt: flagDefer.attempt },
            correlationId: 'dispatch-refusal-defer-flag-off',
          });
        });

        expect(await readOutreach(flagDefer.outreachId)).toMatchObject({
          delivery_status: 'queued',
          disposition_reason: null,
        });
        expect(await readRefusalsForOutreach(flagDefer.outreachId)).toEqual([]);
      });

      it('a dispatch withhold writes its refusal_events row after the outreach terminal, the child run and the receipt step', async () => {
        // Red-team P1-A. "Inside tx1" is not a POSITION: the write was moved to
        // the TOP of `commitWithhold` and all 33 dispatch cases stayed green.
        // Row-existence assertions cannot see order, and the rollback case below
        // is the one that most looks like it can — it passes VACUOUSLY when the
        // statement it aborts on is the first thing the withhold does, because
        // then there is nothing earlier for the abort to take with it. This case
        // is what makes that one a claim about all five earlier writes.
        //
        // Technique copied from the halt lane's identical claim in
        // `approval.integration.test.ts`, whose mutant dies.
        const fixture = await seedQueuedOutreach();
        await setAttestedPostalAddress(null);
        const { executor, queries, transactions } = recordingExecutor(sql());

        await withSendFlagOn(async () => {
          await dispatchOutreach(executor, {
            batchId: fixture.batchId,
            businessId,
            outreachId: fixture.outreachId,
            outboxHandle: { outboxId: fixture.outboxId, attempt: fixture.attempt },
            correlationId: 'dispatch-refusal-write-position',
          });
        });

        // The withhold really happened — otherwise every ordering claim below is
        // about a dispatch that never reached `commitWithhold`.
        expect(await readOutreach(fixture.outreachId)).toMatchObject({
          delivery_status: 'withheld',
          disposition_reason: 'no_postal_address',
        });

        // RECEIVER IDENTITY first: ONE transaction (a withhold never opens tx2),
        // and the ledger statement rode it rather than the pooled client the
        // caller passed in. A Refusal written on the base client commits
        // independently of the terminal and survives its rollback.
        expect(transactions).toHaveLength(1);
        const ledgerQueries = queries.filter((query) =>
          /INSERT INTO refusal_events/.test(query.text));
        expect(ledgerQueries).toHaveLength(1);
        expect(ledgerQueries[0]!.onTransaction).toBe(true);

        const indexOf = (pattern: RegExp): number =>
          queries.findIndex((query) => pattern.test(query.text));
        const childIndex = indexOf(/INSERT INTO agent_runs/);
        // The TERMINAL specifically. `stampConsentSnapshot` issues its own
        // `UPDATE solicitation_outreach` a few lines earlier, so the bare table
        // name would match the wrong statement and the claim would be weaker
        // than it reads.
        const terminalIndex = indexOf(/delivery_status = 'withheld'/);
        const stepIndex = indexOf(/INSERT INTO agent_run_steps/);
        const childTerminalIndex = indexOf(/UPDATE agent_runs/);
        const outboxIndex = indexOf(/UPDATE job_outbox/);
        const ledgerIndex = indexOf(/INSERT INTO refusal_events/);

        // `commitWithhold`'s documented order, in full: the Lazy child, the
        // withheld terminal, the receipt step, the child's own terminal, the
        // outbox completion — and only then the Refusal.
        expect(childIndex).toBeGreaterThanOrEqual(0);
        expect(terminalIndex).toBeGreaterThan(childIndex);
        expect(stepIndex).toBeGreaterThan(terminalIndex);
        expect(childTerminalIndex).toBeGreaterThan(stepIndex);
        expect(outboxIndex).toBeGreaterThan(childTerminalIndex);
        expect(ledgerIndex).toBeGreaterThan(outboxIndex);

        // LAST OF ALL, which is the stronger form of the same claim and the one
        // that also pins the settlement join: nothing tx1 issues follows the
        // ledger write, so every statement this withhold makes is inside the
        // scope a ledger abort rolls back.
        expect(ledgerIndex).toBe(queries.length - 1);
      });

      it('a ledger failure in the dispatch lane rolls back the outreach withhold, child run, receipt step, outbox completion and batch close together', async () => {
        // Round-1 plan review R1-2: without this case a dispatch ledger error
        // could be caught, or the write moved outside tx1, with every other
        // dispatch case still green.
        const fixture = await seedQueuedOutreach();
        await setAttestedPostalAddress(null);
        const before = await readOutreach(fixture.outreachId);

        const original = { ...outreachWithheldCategories };
        outreachWithheldCategories.no_postal_address = 'a_category_the_ledger_never_named';
        try {
          await expect(
            dispatchWithFlagOn(fixture, 'dispatch-refusal-rollback'),
          ).rejects.toMatchObject({
            code: CHECK_VIOLATION,
            constraint_name: expect.stringContaining('refusal_events'),
          });
        } finally {
          for (const key of Object.keys(outreachWithheldCategories)) {
            delete outreachWithheldCategories[key];
          }
          Object.assign(outreachWithheldCategories, original);
        }

        // EVERY write tx1 made is gone. The row is still dispatchable, which is
        // the point: a ledger bug must not silently terminalize an Outreach the
        // owner still owns.
        const after = await readOutreach(fixture.outreachId);
        expect(after.delivery_status).toBe('queued');
        expect(after.disposition_reason).toBeNull();
        expect(after.agent_run_id).toBeNull();
        expect(after.consent_row_id).toBe(before.consent_row_id);

        const [childRuns] = await sql()<{ total: number }[]>`
          SELECT COUNT(*)::int AS total FROM agent_runs
          WHERE business_id = ${businessId}::uuid
            AND kind = 'solicitation_ask'
            AND subject_id = ${fixture.askId}
        `;
        expect(childRuns!.total, 'the Lazy child went with it').toBe(0);
        const [steps] = await sql()<{ total: number }[]>`
          SELECT COUNT(*)::int AS total FROM agent_run_steps step
          JOIN agent_runs run ON run.id = step.agent_run_id
          WHERE run.business_id = ${businessId}::uuid
            AND step.step_key = 'dispatch_gate_evaluated'
            AND run.subject_id = ${fixture.askId}
        `;
        expect(steps!.total, 'the receipt step went with it').toBe(0);
        // The attempt is still in flight, so the watchdog still owns the work.
        expect((await readOutbox(fixture.outboxId)).status).toBe('dispatched');
        // …and the batch did not close on a settlement that never happened.
        expect(await readBatchClosedAt(fixture.batchId)).toBeNull();
        expect(await readRefusalsForOutreach(fixture.outreachId)).toEqual([]);
      });

      it('every solicitation refusal reason writes its verbatim code and mapped category, and every null-mapped reason writes nothing', async () => {
        // ONE TITLE, THREE INSTANCES — one per lane, in each lane's own suite
        // (`batch-builder.integration.test.ts`, this one,
        // `approval.integration.test.ts`). Plan §1: the title "spans T3, T4 and
        // T5 and closes with them". No single suite can drive all three lanes'
        // fixtures, and a case covering one lane while claiming all three would
        // be the over-claim this title exists to prevent. This instance owns the
        // DISPATCH half of `outreach_withheld`.
        //
        // Round-1 finding R1-4: a call site could hard-code one valid code and
        // one valid category and stay green under every count and timestamp
        // assertion, filing every OTHER reason wrong.
        //
        // This lane has NO null-mapped reason — all six are RepWorth declining
        // to send. Its analogue of "writes nothing" is the DEFER, which carries
        // no withheld reason at all and has its own case above.
        const written = new Map<string, string>();

        // Item 3 — the opt-out that landed after approval.
        await setAttestedPostalAddress(SEEDED_POSTAL_ADDRESS);
        const suppressed = await seedQueuedOutreach();
        await seedAccountSuppression(suppressed.handle);
        await dispatchWithFlagOn(suppressed, 'dispatch-refusal-vocab-suppressed');

        // Item 4 — no ledger row for the handle at all.
        const noConsent = await seedQueuedOutreach({ consent: 'absent' });
        await dispatchWithFlagOn(noConsent, 'dispatch-refusal-vocab-no-consent');

        // Item 6, absent — the whole attestation is cleared.
        const noAddress = await seedQueuedOutreach();
        await setAttestedPostalAddress(null);
        await dispatchWithFlagOn(noAddress, 'dispatch-refusal-vocab-no-address');

        // Item 6, present-but-moved — the owner corrected their address AFTER
        // approval, so the stored footer no longer byte-matches.
        const mismatch = await seedQueuedOutreach();
        await setAttestedPostalAddress('1600 Pennsylvania Ave NW\nWashington, DC 20500');
        await dispatchWithFlagOn(mismatch, 'dispatch-refusal-vocab-mismatch');

        // Item 8 — copy the current lint refuses outright.
        await setAttestedPostalAddress(SEEDED_POSTAL_ADDRESS);
        const lintFailed = await seedQueuedOutreach({
          llmBody: 'Thanks for stopping by — leave us a review and get 20% off your next visit.',
        });
        await dispatchWithFlagOn(lintFailed, 'dispatch-refusal-vocab-lint');

        // Item 9 — an unmoderated ask is not a send-eligible ask (§3.4).
        const moderationHigh = await seedQueuedOutreach();
        await withProviderModerationOff(async () => {
          await dispatchWithFlagOn(moderationHigh, 'dispatch-refusal-vocab-moderation');
        });

        for (const fixture of [
          suppressed,
          noConsent,
          noAddress,
          mismatch,
          lintFailed,
          moderationHigh,
        ]) {
          const row = await readOutreach(fixture.outreachId);
          expect(row.delivery_status, `outreach ${fixture.outreachId} did not withhold`)
            .toBe('withheld');
          const [refusal] = await readRefusalsForOutreach(fixture.outreachId);
          expect(refusal, `no Refusal for ${row.disposition_reason}`).toBeDefined();
          // The Outreach row's stored reason and the Refusal's code are the SAME
          // string, read from two tables.
          expect(refusal!.refusal_code).toBe(row.disposition_reason);
          written.set(refusal!.refusal_code!, refusal!.refusal_category);
        }

        // Every member of the dispatch map, and nothing else. Derived from the
        // map rather than re-listed, so a seventh reason added upstream fails
        // here instead of going unrecorded.
        expect(Object.fromEntries(written)).toEqual({
          ...OUTREACH_WITHHELD_DISPATCH_REFUSAL_CATEGORIES,
        });
      });

      it("every refusal_events row these three lanes write carries the account and location already in the lane's scope", async () => {
        // ONE TITLE, THREE INSTANCES — see the exhaustive-reason case above.
        // This instance owns the DISPATCH lane.
        //
        // `scope` already carries the account and the location, read off the row
        // this attempt locked; no lane resolves a tenant key it does not hold.
        const fixture = await seedQueuedOutreach();
        await setAttestedPostalAddress(null);

        await dispatchWithFlagOn(fixture, 'dispatch-refusal-tenant-scope');

        const [refusal] = await readRefusalsForOutreach(fixture.outreachId);
        expect(refusal).toBeDefined();
        expect(refusal!.account_id).toBe(accountId());
        // NOT NULL: C3 makes a null location mean "account-wide", which this
        // lane is not.
        expect(refusal!.business_id).toBe(businessId);
      });

      it('all three lanes complete their decisions unchanged when REFUSAL_LEDGER_ENABLED is false', async () => {
        // ONE TITLE, THREE INSTANCES — see the exhaustive-reason case above.
        // This instance owns the DISPATCH lane.
        //
        // "Unchanged" is a claim about two runs agreeing, so the comparison is
        // against a REAL ledger-on dispatch of an identical fixture rather than
        // against a hand-written expectation.
        async function dispatchAndSnapshot(correlationId: string): Promise<{
          outreach: Omit<OutreachLifecycleRow, 'agent_run_id' | 'consent_row_id'>;
          childStatus: string;
          stepKeys: string[];
          outboxStatus: string;
          batchClosed: boolean;
          refusalCount: number;
        }> {
          const fixture = await seedQueuedOutreach();
          await setAttestedPostalAddress(null);
          await dispatchWithFlagOn(fixture, correlationId);

          const row = await readOutreach(fixture.outreachId);
          // The two id columns are excluded from the comparison and NOTHING
          // else is: they are freshly minted per fixture, so comparing them
          // would fail for a reason that has nothing to do with the switch.
          const { agent_run_id: runId, consent_row_id: consentRowId, ...comparable } = row;
          expect(runId, 'the Lazy child was not created').not.toBeNull();
          expect(consentRowId).not.toBeNull();
          const child = await readChildRun(runId!);
          return {
            outreach: comparable,
            childStatus: child.status,
            stepKeys: child.step_keys,
            outboxStatus: (await readOutbox(fixture.outboxId)).status,
            batchClosed: (await readBatchClosedAt(fixture.batchId)) !== null,
            refusalCount: (await readRefusalsForOutreach(fixture.outreachId)).length,
          };
        }

        const ledgerOn = await dispatchAndSnapshot('dispatch-refusal-flag-on');
        expect(ledgerOn.refusalCount).toBe(1);

        process.env[REFUSAL_LEDGER_FLAG] = 'false';
        try {
          const ledgerOff = await dispatchAndSnapshot('dispatch-refusal-flag-off');

          // The withhold, the child, the receipt step, the outbox completion and
          // the settlement join are all byte-identical…
          expect(ledgerOff.outreach).toEqual(ledgerOn.outreach);
          expect(ledgerOff.childStatus).toBe(ledgerOn.childStatus);
          expect(ledgerOff.stepKeys).toEqual(ledgerOn.stepKeys);
          expect(ledgerOff.outboxStatus).toBe(ledgerOn.outboxStatus);
          expect(ledgerOff.batchClosed).toBe(ledgerOn.batchClosed);
          // …and the ONLY difference is the Refusal that was not recorded.
          expect(ledgerOff.refusalCount).toBe(0);
        } finally {
          delete process.env[REFUSAL_LEDGER_FLAG];
        }
      });
    });
  },
);
