// Live-Postgres eval for the two Refusal lanes #1013 writes — `held_draft` and
// `policy_gate_held` — through the REAL persist boundary.
//
// TITLES ARE VERBATIM FROM THE INTAKE OF THE TICKET THAT OWNS THEM, and the
// citation names the TICKET, never a path. `.feature/intake.json` is per-RUN
// scratch: it held #1013's titles 13-36 when this file was written and holds a
// different ticket's the moment another `/feature` run arms this worktree — so
// "titles 13-36 of `.feature/intake.json`" stopped being true without anything
// here changing (#1079 T5).
//   * #1013 owns titles 13-36 — the two lanes' original eval.
//   * #1079 owns the five kill-switch-containment cases at the end of this file.
// The verify gate's `promised-tests` row matches on exact text, so a reworded
// title reads as an unwritten test.
//
// WHY A LIVE DATABASE AND NOT `persist.test.ts`'s mocked transaction. The unit
// suite proves which STATEMENTS persist issues, in what order. Only a real
// database proves the claims statement text cannot reach:
//
//   * that `occurred_at` takes the DECIDING transaction's clock to the
//     microsecond, which postgres.js truncates on any JS round trip (#520);
//   * that the byte-for-byte `ON CONFLICT` predicate actually INFERS
//     `refusal_events_subject_uniq` — a clause that reads right and infers
//     nothing raises 23505 and poisons the transaction the decision lives in;
//   * that a CHECK violation ABORTS the whole persist, response row included;
//   * that migration 116's C4 and C5 accept what the writer actually sends.
//
// Applies NO migration SQL and executes NO DDL. `pnpm test:db:setup` provisions
// the schema; this file asserts it with `assertSchemaReady` and seeds with
// `INSERT` only — run-time DDL deadlocks (40P01) across concurrent suites, and
// `ci:live-db-suites` R2 enforces that. The two abort cases use the non-DDL
// `abortingExecutor` rather than a temporary constraint, for the same reason.
//
// Harness mirrors `content-freshness-gate.integration.test.ts` (the sibling
// live-DB suite over this same persist boundary) for the tenant/business/review
// fixture, and `write.integration.test.ts` for the ledger assertions.
//
// THE TENANT IS SEEDED `autopilot`, NOT the `seedTenantAccount` DEFAULT of
// `copilot`. On Copilot every candidate carries `autopilot_tier_required`, which
// is a VETO member — so every `policy_gate_held` assertion below would pass
// against a row that was never written, and the suite would look green while
// proving nothing.

import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import type postgresType from 'postgres';
import { randomUUID } from 'node:crypto';
import { describeWithDb } from '@/__tests__/helpers/describe-with-db';
import {
  cleanupTenantAccount,
  seedTenantAccount,
  type TenantSeed,
} from '@/lib/shared/__tests__/live-db-tenant';
import {
  assertSchemaReady,
  type SchemaRequirement,
} from '@/lib/shared/__tests__/helpers/schema-ready';
import { abortingExecutor } from '@/lib/shared/__tests__/helpers/abort-injection';
import { GENERATE_RESPONSE_ORIGIN_LANE } from '@/lib/shared/worker-types';
import { TRIAGE_SOURCE } from '@/lib/reviews/triage-schema';
// The flag NAME comes from the module that READS it. Six test files each
// carried their own `'REFUSAL_LEDGER_ENABLED'` literal before the #1010
// follow-up centralised it; a rename would have left them green while testing a
// flag that no longer exists.
import {
  REFUSAL_LEDGER_FLAG,
  resetRefusalLedgerWarningForTests,
} from '@/lib/refusals/write';
import { persistResponseAndNotify, type PersistResponseInput } from '../persist';

// ---------------------------------------------------------------------------
// Forced-constraint injection, for titles 30 and 31.
//
// Both cases must produce a REAL `23514` from migration 116 through the REAL
// helper on the REAL persist path — a JS throw would prove nothing about a
// transaction that is actually in aborted state. The only way in from outside is
// to BEND one vocabulary answer, which is the mechanism `write.ts`'s docblock
// names ("the eval's forced-`23514` case bends one vocabulary entry"). The
// switches default to off, so every other case runs against the real vocabulary.
// ---------------------------------------------------------------------------

const poison = { heldDraftCategory: null as string | null, breakC5: false };

/**
 * A PLAIN JavaScript failure from the ledger writer, for the rethrow oracle.
 *
 * DISTINCT FROM THE TWO CONSTRAINT CASES, and the distinction is the whole
 * point. Those inject a real `23514`, which poisons the Postgres transaction —
 * so the rollback they observe comes from Postgres and would happen even if the
 * ledger-write fault were SWALLOWED on its way out. Red-team round 2 proved
 * exactly that: planting a swallow survived all 75 tests, and the A/B showed a
 * swallowed plain error COMMITS the response row with no Refusal.
 *
 * A plain `Error` leaves the transaction healthy, so the only thing that can
 * roll it back is the error reaching `persistResponseAndNotify` uncaught. That
 * makes this the one oracle guarding an invariant #4 dependency the round-1 fix
 * introduced. The reporter on that path is `captureLedgerWriteFault`, inside
 * `writeRefusalEvent` (#1083) — NOT `withLedgerAttribution`, which no longer
 * wraps a write on either lane. It captures and rethrows THE SAME INSTANCE, so
 * "attribution is not recovery" is the property this oracle pins.
 */
const ledgerPoison = { throwOnLane: null as null | 'held_draft' | 'policy_gate_held' };

vi.mock('@/lib/refusals/write', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/refusals/write')>();
  return {
    ...actual,
    async writeRefusalEvent(tx: unknown, input: { refusalSource: string }) {
      if (ledgerPoison.throwOnLane === input.refusalSource) {
        throw new Error('ledger_write_failed_plain_js');
      }
      return (actual.writeRefusalEvent as (t: unknown, i: unknown) => Promise<void>)(tx, input);
    },
  };
});

/**
 * A VOCABULARY fault, distinct from every poison above it (#1079).
 *
 * The other switches bend an ANSWER the resolver returns. This one makes the
 * resolver itself THROW — the fault `REFUSAL_LEDGER_ENABLED` could not contain,
 * because `recordPolicyGateRefusal` resolved three lines before anything read
 * the flag.
 */
const resolverPoison = { throwWith: null as Error | null };

/**
 * The resolver as a SPY, so its CALL COUNT is directly observable (#1079 T3).
 *
 * The count is the only oracle that separates the shipped fix from the one this
 * branch rejects. "No refusal row with the flag off" is already true on HEAD and
 * is equally true of a `try/catch` wrapped around the resolve — the shape that
 * leaves a vocabulary fault running inside the deciding transaction. Only
 * "the resolver was never CALLED" distinguishes them.
 *
 * `mockClear` (never `mockReset`) in `beforeEach`: the implementation is
 * installed once, here, when the module factory runs.
 */
const resolvePolicyGateRefusalSpy = vi.hoisted(() =>
  vi.fn<(codes: readonly string[]) => unknown>(),
);

vi.mock('@/lib/refusals/vocabulary', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/refusals/vocabulary')>();
  resolvePolicyGateRefusalSpy.mockImplementation((codes: readonly string[]) => {
    if (resolverPoison.throwWith) throw resolverPoison.throwWith;
    const resolveFn = (actual as Record<string, unknown>).resolvePolicyGateRefusal;
    if (typeof resolveFn !== 'function') return null;
    const resolved = (resolveFn as (c: readonly string[]) => unknown)(codes) as
      | { refusalCode: string; refusalCategory: string; allRefusalCodes: readonly string[] }
      | null;
    if (resolved && poison.breakC5) {
      // C5 requires the winner to be a MEMBER of the set it won. Naming a code
      // outside the array is the smallest way to make the database refuse a
      // row the writer believes is well formed.
      return { ...resolved, refusalCode: 'not_a_member_of_the_set' };
    }
    return resolved;
  });
  return {
    ...actual,
    get HELD_DRAFT_REFUSAL_CATEGORY() {
      return poison.heldDraftCategory
        ?? (actual as Record<string, unknown>).HELD_DRAFT_REFUSAL_CATEGORY;
    },
    resolvePolicyGateRefusal: resolvePolicyGateRefusalSpy,
  };
});

/**
 * A PARTIAL `@sentry/node` mock — two functions replaced, everything else real.
 *
 * THE LEDGER CAPTURES ARE THE BRANCH'S WHOLE OBSERVABILITY CLAIM, and there are
 * two of them on two different reporters: `captureLedgerWriteFault` inside
 * `writeRefusalEvent` owns every WRITE fault on every lane (#1083), and
 * `withLedgerAttribution` in `persist.ts` owns only the `policy_gate_held`
 * VOCABULARY resolve. They are disjoint by position and are told apart by the
 * `fault` tag (`ledger_write` versus `ledger_vocabulary`).
 *
 * Without a spy "tagged subsystem=refusal_ledger" is unverifiable: with no
 * DSN configured the real `captureException` returns an event id and drops the
 * envelope, so a capture that never carried the tags is indistinguishable from
 * one that did. `write.test.ts` is the house precedent for the hoisted stub;
 * the spread keeps this file from depending on which OTHER Sentry APIs the
 * persist graph happens to touch.
 */
const sentryStub = vi.hoisted(() => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

vi.mock('@sentry/node', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sentry/node')>();
  return {
    ...actual,
    captureException: sentryStub.captureException,
    captureMessage: sentryStub.captureMessage,
  };
});

const testDatabaseUrl = process.env.TEST_DATABASE_POOL_URL;

const MIGRATION_116_REFUSAL_EVENTS: SchemaRequirement = {
  migration: '116_refusal_events',
  tables: ['refusal_events'],
  indexes: [
    'idx_refusal_events_archival',
    'refusal_events_subject_uniq',
  ],
};

/**
 * Migration 123 (#1081) SUPERSEDED 116's `idx_refusal_events_account_window`
 * with `idx_refusal_events_account_window_covering` — the same leading keys plus
 * `id DESC` and an `INCLUDE (business_id)`. Its own requirement, never folded
 * into 116's, so a database carrying the 116 index and not this one fails with
 * the migration that fixes it named.
 */
const MIGRATION_123_REFUSAL_READ_INDEXES: SchemaRequirement = {
  migration: '123_refusal_read_indexes',
  indexes: ['idx_refusal_events_account_window_covering'],
};

let db: postgresType.Sql | undefined;
let tenant: TenantSeed | undefined;
const businessId = randomUUID();
const connectionId = randomUUID();
const policyId = randomUUID();

function sql(): postgresType.Sql {
  if (!db) throw new Error('refusal write integration database was not initialized');
  return db;
}

function accountId(): string {
  if (!tenant) throw new Error('refusal write integration tenant was not seeded');
  return tenant.accountId;
}

// ---------------------------------------------------------------------------
// Flag control. Read LIVE per call in production, so a per-case assignment is
// the whole arrangement — no module reset needed.
// ---------------------------------------------------------------------------

const AUTO_APPROVAL_FLAG = 'AUTO_APPROVAL_ENABLED';
const MODERATION_FLAG = 'OPENAI_MODERATION_ENABLED';
let savedEnv: Record<string, string | undefined> = {};

function setFlags(values: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(values)) {
    savedEnv[key] ??= process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

// ---------------------------------------------------------------------------
// Fixture.
// ---------------------------------------------------------------------------

interface ReviewOverrides {
  starRating?: number | null;
  contentHash?: string | null;
  triageSeverity?: string | null;
  triageSource?: string | null;
}

/**
 * `reviews_triage_consistency` makes the triage columns ALL-OR-NOTHING:
 * `triage_severity` NOT NULL demands `triage_source`, `triage_suggested_action`
 * AND `triaged_at` alongside it. Setting severity alone raises a CHECK
 * violation, so the whole group moves together here.
 *
 * `triage_source` defaults to `llm_triage_v1`, NOT `fallback_high_v1`, and the
 * choice is load-bearing: the fallback source raises `triage_fallback`, which is
 * precedence tier 2 (`watchdog_unavailable`) and would OUTRANK the
 * `triage_high_severity` these cases mean to isolate.
 */
async function seedReview(id: string, overrides: ReviewOverrides = {}): Promise<void> {
  const severity = overrides.triageSeverity ?? null;
  await sql()`
    INSERT INTO reviews (
      id, business_id, provider, provider_review_id, provider_review_name,
      provider_location_name, reviewer_name, star_rating, review_text, status,
      review_content_hash, triage_severity, triage_source,
      triage_suggested_action, triaged_at
    ) VALUES (
      ${id}::uuid, ${businessId}::uuid, 'zernio', ${`refusal-${id}`},
      ${`zernio://refusal/reviews/${id}`}, 'zernio://refusal/locations/1',
      'Refusal Reviewer', ${overrides.starRating === undefined ? 5 : overrides.starRating},
      'A review the gate will weigh.', 'pending',
      ${overrides.contentHash === undefined ? 'hash-loaded' : overrides.contentHash},
      ${severity},
      ${severity === null ? null : (overrides.triageSource ?? TRIAGE_SOURCE.LLM)},
      ${severity === null ? null : 'escalate'},
      ${severity === null ? null : new Date()}
    )
  `;
}

const CLEAN_MODERATION = {
  flagged: false,
  severity: 'low' as const,
  reason: null,
  categories: {},
  score: 0,
  source: 'openai_moderation' as const,
  providerStatus: 'clean' as const,
};

const HIGH_MODERATION = {
  ...CLEAN_MODERATION,
  flagged: true,
  severity: 'high' as const,
  reason: 'forced high-severity flag for the held_draft lane',
};

const LOW_FLAGGED_MODERATION = {
  ...CLEAN_MODERATION,
  flagged: true,
  severity: 'low' as const,
  reason: 'flagged below high — never a held_draft',
};

interface InputOverrides {
  moderation?: PersistResponseInput['moderation'];
  originLane?: PersistResponseInput['originLane'];
  suppressNotification?: boolean;
  version?: number;
  loadedReviewContentHash?: string | null;
  preLlmSubscriptionTier?: PersistResponseInput['preLlmSubscriptionTier'];
}

function makeInput(reviewId: string, overrides: InputOverrides = {}): PersistResponseInput {
  return {
    // A cleared Safety review (G4-F1). These cases are about other gates, so
    // the verdict is the approvable one — absence is not clearance, so it has
    // to be stated rather than left undefined.
    safetyVerdict: { cleared: true, concern: null, source: 'llm', provider: 'openai' } as const,
    result: {
      responseText: 'Thank you for taking the time to write this.',
      language: 'en',
      provider: 'openai',
      model: 'gpt-4o-mini-2024-07-18',
      usage: { promptTokens: 10, completionTokens: 5 },
      costUsd: 0.0001,
      apiCostId: null,
    },
    reviewId,
    businessId,
    version: overrides.version ?? 1,
    correlationId: 'refusal-lane-int',
    suppressNotification: overrides.suppressNotification ?? false,
    originLane: overrides.originLane ?? GENERATE_RESPONSE_ORIGIN_LANE.LIVE_INGEST_NEW,
    loadedReviewContentHash:
      overrides.loadedReviewContentHash === undefined
        ? 'hash-loaded'
        : overrides.loadedReviewContentHash,
    moderation: overrides.moderation ?? CLEAN_MODERATION,
    accountId: accountId(),
    preLlmSubscriptionTier: overrides.preLlmSubscriptionTier ?? 'autopilot',
    logger: { log: () => {}, warn: () => {} },
  };
}

interface RefusalRow {
  refusal_source: string;
  refusal_code: string | null;
  all_refusal_codes: string[] | null;
  refusal_category: string;
  subject_type: string | null;
  subject_id: string | null;
  account_id: string;
  business_id: string | null;
  occurred_at: Date;
}

async function refusals(subjectId: string, source?: string): Promise<RefusalRow[]> {
  return source === undefined
    ? sql()<RefusalRow[]>`
        SELECT refusal_source, refusal_code, all_refusal_codes, refusal_category,
               subject_type, subject_id, account_id, business_id, occurred_at
        FROM refusal_events WHERE subject_id = ${subjectId}::uuid
      `
    : sql()<RefusalRow[]>`
        SELECT refusal_source, refusal_code, all_refusal_codes, refusal_category,
               subject_type, subject_id, account_id, business_id, occurred_at
        FROM refusal_events
        WHERE subject_id = ${subjectId}::uuid AND refusal_source = ${source}
      `;
}

/**
 * Rows on one lane for THIS account.
 *
 * A time window (`occurred_at > NOW() - INTERVAL '5 seconds'`) was tried first
 * and is wrong: the positive cases above write real rows seconds earlier in the
 * same suite, so the window counts THEM and a rolled-back transaction reads as
 * five surviving rows. Every "wrote nothing" assertion whose subject was rolled
 * back therefore takes a BEFORE count and compares.
 */
async function laneCount(source: string): Promise<number> {
  const [row] = await sql()<{ n: number }[]>`
    SELECT count(*)::int AS n FROM refusal_events
    WHERE account_id = ${accountId()}::uuid AND refusal_source = ${source}
  `;
  return row!.n;
}

/**
 * The LEDGER-DARK captures only, so another subsystem's `captureMessage` cannot
 * inflate a count.
 *
 * Filtered by TAG rather than by message text: the tags are what an operator
 * actually alerts on, and a reworded message must not silently empty this.
 * `write.test.ts` filters the console line for the same reason.
 */
function ledgerDarkCaptures(): unknown[] {
  return sentryStub.captureMessage.mock.calls.filter((call) => {
    const options = call[1] as { tags?: Record<string, unknown> } | undefined;
    return options?.tags?.subsystem === 'refusal_ledger'
      && options.tags.flag === REFUSAL_LEDGER_FLAG;
  });
}

/**
 * Apply a temporary fixture mutation, run `body`, and ALWAYS restore.
 *
 * The `try/finally` is the entire point. Branch review round 1 (standards axis,
 * P1) found four bare mutate→act→restore pairs here with no guard, and two of
 * them set VETO conditions — `businesses.archived_at` and a `copilot` tier. A
 * failure in the middle skipped the restore, left the tenant permanently
 * vetoed, and made ELEVEN later "writes no row" assertions pass vacuously
 * against a tenant that could never write one. That is the exact failure this
 * file's own header warns about, and it is worse than a normal leak: the suite
 * stays GREEN while measuring nothing.
 */
async function withTemporary(
  mutate: () => Promise<unknown>,
  restore: () => Promise<unknown>,
  body: () => Promise<void>,
): Promise<void> {
  await mutate();
  try {
    await body();
  } finally {
    await restore();
  }
}

async function responseIdFor(reviewId: string): Promise<string | undefined> {
  const [row] = await sql()<{ id: string }[]>`
    SELECT id FROM responses WHERE review_id = ${reviewId}::uuid
  `;
  return row?.id;
}

describeWithDb('the held_draft and policy_gate_held Refusal lanes (live Postgres)', { timeout: 60_000 }, () => {
  beforeAll(async () => {
    db = postgres(testDatabaseUrl!, { max: 1, prepare: false });
    await assertSchemaReady(db, [MIGRATION_116_REFUSAL_EVENTS, MIGRATION_123_REFUSAL_READ_INDEXES]);

    tenant = await seedTenantAccount(db, {
      userName: 'Refusal Lane Owner',
      accountDisplayName: 'Refusal Lane Account',
      // NOT the copilot default — see the header. On Copilot every candidate
      // carries the autopilot_tier_required VETO and no row is ever written.
      subscriptionTier: 'autopilot',
      subscriptionStatus: 'active',
    });

    await db`
      INSERT INTO businesses (id, name, owner_name, owner_email, account_id, subscription_status)
      VALUES (${businessId}::uuid, 'Refusal Lane Biz', 'Refusal Lane Owner',
              ${tenant.ownerEmail}, ${tenant.accountId}::uuid, 'active')
    `;
    // An ACTIVE connection, so `active_zernio_connection_missing` never fires
    // except where a case removes it deliberately.
    await db`
      INSERT INTO zernio_connections (id, business_id, zernio_profile_id, zernio_account_id, zernio_location_id, status)
      VALUES (${connectionId}::uuid, ${businessId}::uuid, 'prof-1', 'acct-1', 'loc-1', 'active')
    `;
    // A CONFIGURED policy: `auto_approve_min_star` NOT NULL is what makes a
    // draft a genuine candidate under #998's narrowing.
    await db`
      INSERT INTO auto_approval_policies (id, account_id, location_id, auto_approve_min_star, veto_window_minutes)
      VALUES (${policyId}::uuid, ${tenant.accountId}::uuid, NULL, 4, 15)
    `;
  });

  beforeEach(() => {
    savedEnv = {};
    setFlags({ [AUTO_APPROVAL_FLAG]: 'true', [MODERATION_FLAG]: 'true', [REFUSAL_LEDGER_FLAG]: 'true' });
    // CLEAR, never RESET — `mockReset` would strip the implementation the module
    // factory installed once, and every later case would resolve `undefined`.
    resolvePolicyGateRefusalSpy.mockClear();
    sentryStub.captureException.mockClear();
    sentryStub.captureMessage.mockClear();
  });

  afterEach(async () => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    poison.heldDraftCategory = null;
    poison.breakC5 = false;
    ledgerPoison.throwOnLane = null;
    resolverPoison.throwWith = null;
  });

  afterAll(async () => {
    if (!db) return;
    if (tenant) {
      await sql()`DELETE FROM refusal_events WHERE account_id = ${tenant.accountId}::uuid`;
      await sql()`DELETE FROM job_outbox WHERE payload->>'business_id' = ${businessId}`;
      await sql()`DELETE FROM flagged_responses WHERE business_id = ${businessId}::uuid`;
      await sql()`DELETE FROM agent_run_steps WHERE agent_run_id IN (SELECT id FROM agent_runs WHERE business_id = ${businessId}::uuid)`;
      await sql()`DELETE FROM agent_outcomes WHERE agent_run_id IN (SELECT id FROM agent_runs WHERE business_id = ${businessId}::uuid)`;
      await sql()`DELETE FROM agent_runs WHERE business_id = ${businessId}::uuid`;
      await sql()`DELETE FROM approval_audit_log WHERE business_id = ${businessId}::uuid`;
      await sql()`DELETE FROM api_costs WHERE business_id = ${businessId}::uuid`;
      await sql()`DELETE FROM responses WHERE business_id = ${businessId}::uuid`;
      await sql()`DELETE FROM reviews WHERE business_id = ${businessId}::uuid`;
      await sql()`DELETE FROM auto_approval_policies WHERE id = ${policyId}::uuid`;
      await sql()`DELETE FROM zernio_connections WHERE id = ${connectionId}::uuid`;
      await sql()`DELETE FROM businesses WHERE id = ${businessId}::uuid`;
      await cleanupTenantAccount(sql(), tenant);
    }
    await db.end({ timeout: 5 });
  });

  // -------------------------------------------------------------------------
  // held_draft — T3's lane.
  // -------------------------------------------------------------------------

  it('a high-severity moderation flag writes one held_draft row with refusal_code null', async () => {
    const reviewId = randomUUID();
    await seedReview(reviewId);
    await persistResponseAndNotify(sql(), makeInput(reviewId, { moderation: HIGH_MODERATION }));

    const responseId = await responseIdFor(reviewId);
    expect(responseId).toBeDefined();
    const rows = await refusals(responseId!, 'held_draft');
    expect(rows).toHaveLength(1);
    // C4 is BICONDITIONAL: refusal_code IS NULL if and only if the lane is
    // held_draft. The lane has no code axis at all — `flagged_responses.reason`
    // is moderation prose that may never leave the server.
    expect(rows[0]!.refusal_code).toBeNull();
  });

  it('a high-severity moderation flag writes no policy_gate_held row', async () => {
    const reviewId = randomUUID();
    await seedReview(reviewId);
    await persistResponseAndNotify(sql(), makeInput(reviewId, { moderation: HIGH_MODERATION }));

    const responseId = await responseIdFor(reviewId);
    // #998's suppression rule: a draft with held === true writes NO
    // policy_gate_held row at all. Mapping moderation_held to null alone is not
    // sufficient — moderation_flagged fires at EVERY severity including high, so
    // the row would duplicate the held_draft lane under an unsafe_content
    // category.
    expect(await refusals(responseId!, 'policy_gate_held')).toHaveLength(0);
  });

  it("a held draft's refusal_events occurred_at equals its flagged_responses created_at", async () => {
    const reviewId = randomUUID();
    await seedReview(reviewId);
    await persistResponseAndNotify(sql(), makeInput(reviewId, { moderation: HIGH_MODERATION }));

    const responseId = await responseIdFor(reviewId);
    // Both are transaction_timestamp() inside ONE transaction — the ledger's
    // 'transaction_time' sentinel and flagged_responses.created_at's DEFAULT
    // NOW(). Compared IN THE DATABASE at full precision: postgres.js truncates
    // microseconds on decode (#520), so a JS round trip would silently pass a
    // comparison that is wrong by up to a millisecond.
    const [row] = await sql()<{ equal: boolean }[]>`
      SELECT (r.occurred_at = f.created_at) AS equal
      FROM refusal_events r
      JOIN flagged_responses f ON f.response_id = r.subject_id
      WHERE r.subject_id = ${responseId!}::uuid AND r.refusal_source = 'held_draft'
    `;
    expect(row?.equal).toBe(true);
  });

  it('a held_draft row persists unsafe_content with refusal_code null and all_refusal_codes null', async () => {
    const reviewId = randomUUID();
    await seedReview(reviewId);
    await persistResponseAndNotify(sql(), makeInput(reviewId, { moderation: HIGH_MODERATION }));

    const responseId = await responseIdFor(reviewId);
    const [row] = await refusals(responseId!, 'held_draft');
    // The constant could be correct and UNUSED. This asserts the STORED value.
    expect(row?.refusal_category).toBe('unsafe_content');
    expect(row?.refusal_code).toBeNull();
    // NULL, never '{}': C5 makes an empty array a different fact and rejects it.
    expect(row?.all_refusal_codes).toBeNull();
  });

  it('a non-high moderation flag writes no held_draft row and records policy_gate_held as unsafe_content when otherwise eligible', async () => {
    const reviewId = randomUUID();
    await seedReview(reviewId);
    await persistResponseAndNotify(
      sql(),
      makeInput(reviewId, { moderation: LOW_FLAGGED_MODERATION }),
    );

    const responseId = await responseIdFor(reviewId);
    // The severity BOUNDARY. held is `flagged && severity === 'high'`, so a
    // low-severity flag is not a hold — an implementation writing held_draft for
    // every flagged response passes the positive case and fails here.
    expect(await refusals(responseId!, 'held_draft')).toHaveLength(0);
    const [row] = await refusals(responseId!, 'policy_gate_held');
    // moderation_flagged still fires, and it is precedence tier 1.
    expect(row?.refusal_category).toBe('unsafe_content');
    expect(row?.refusal_code).toBe('moderation_flagged');
  });

  // -------------------------------------------------------------------------
  // policy_gate_held — T5's lane.
  // -------------------------------------------------------------------------

  it('a candidate draft the gate holds writes one policy_gate_held row against the response id', async () => {
    const reviewId = randomUUID();
    await seedReview(reviewId, { triageSeverity: 'high' });
    await persistResponseAndNotify(sql(), makeInput(reviewId));

    const responseId = await responseIdFor(reviewId);
    const rows = await refusals(responseId!, 'policy_gate_held');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.subject_id).toBe(responseId);
  });

  it('a policy_gate_held row carries the full co-occurring block reason set in all_refusal_codes', async () => {
    const reviewId = randomUUID();
    // Two stars: rating_below_threshold AND rating_below_positive_quadrant.
    await seedReview(reviewId, { starRating: 2 });
    await persistResponseAndNotify(sql(), makeInput(reviewId));

    const responseId = await responseIdFor(reviewId);
    const [row] = await refusals(responseId!, 'policy_gate_held');
    expect(row?.all_refusal_codes).toEqual(
      expect.arrayContaining(['rating_below_threshold', 'rating_below_positive_quadrant']),
    );
    // Nothing durable recorded the co-occurring codes before this lane —
    // persist.ts's fallback log is a logger.log. This is the first record.
    expect(row!.all_refusal_codes!.length).toBeGreaterThan(1);
  });

  it('a policy_gate_held row stores the precedence winner as refusal_code, stores its mapped category, includes the winner in all_refusal_codes, and preserves blockReasons order verbatim', async () => {
    const reviewId = randomUUID();
    // A suspended policy plus a below-threshold rating: #1003's deciding case.
    await seedReview(reviewId, { starRating: 2 });
    await withTemporary(
      () => sql()`UPDATE auto_approval_policies SET suspended_at = NOW() WHERE id = ${policyId}::uuid`,
      () => sql()`UPDATE auto_approval_policies SET suspended_at = NULL WHERE id = ${policyId}::uuid`,
      async () => {
        await persistResponseAndNotify(sql(), makeInput(reviewId));
      },
    );

    const responseId = await responseIdFor(reviewId);
    const [row] = await refusals(responseId!, 'policy_gate_held');
    // policy_suspended is tier 3 (autonomy_paused); the rating reasons are tier
    // 6. The owner must read "Autonomy paused", never "Sent to you".
    expect(row?.refusal_code).toBe('policy_suspended');
    expect(row?.refusal_category).toBe('autonomy_paused');
    // C5's membership half, proven through the write rather than the resolver.
    expect(row!.all_refusal_codes).toContain('policy_suspended');

    // VERBATIM order, asserted against the gate's OWN emission order.
    //
    // An earlier version compared the array to `[...new Set(itself)]`, which is
    // a tautology dressed as an order check: it only detects duplicates, and
    // `compactBlockReasons` already de-duplicates upstream, so a writer that
    // SORTED the array passed it. Both the spec axis and red team's mutation M6
    // caught that independently.
    //
    // `evaluateAutoApprovalCandidate` collects the threshold reason FIRST and
    // the suspension LAST, so the stored array must read in that order — the
    // opposite of precedence rank, which is exactly what makes this
    // discriminating: a writer that sorted by precedence, or alphabetically,
    // fails here.
    expect(
      row!.all_refusal_codes,
      'all_refusal_codes must preserve the gate emission order, not precedence or alphabetical order',
    ).toEqual(['rating_below_threshold', 'rating_below_positive_quadrant', 'policy_suspended']);
  });

  it('a genuine candidate writes no policy_gate_held row both when a null-mapped member precedes a precedence member and when it follows one', async () => {
    // BOTH orderings, in one body. "Before or after" would be satisfiable by a
    // single fixture, and the whole point of #1003's veto rule is that position
    // must not matter — a precedence-position implementation passes a one-sided
    // test and fails this one.
    //
    // Ordering A: archived_location (veto) fires EARLY in the evaluation order,
    // ahead of the later owner-review reasons a two-star review adds.
    const earlyReviewId = randomUUID();
    await seedReview(earlyReviewId, { starRating: 2 });
    await withTemporary(
      () => sql()`UPDATE businesses SET archived_at = NOW() WHERE id = ${businessId}::uuid`,
      () => sql()`UPDATE businesses SET archived_at = NULL WHERE id = ${businessId}::uuid`,
      async () => {
        await persistResponseAndNotify(sql(), makeInput(earlyReviewId));
      },
    );
    const earlyResponseId = await responseIdFor(earlyReviewId);
    expect(await refusals(earlyResponseId!, 'policy_gate_held')).toHaveLength(0);

    // Ordering B: autopilot_tier_required (veto) is collected AFTER the earlier
    // threshold reason. This is the downgraded-Autopilot account #1003 names —
    // the policy row survives the downgrade, so the draft is still evaluated.
    const lateReviewId = randomUUID();
    await seedReview(lateReviewId, { starRating: 2 });
    await withTemporary(
      () => sql()`UPDATE accounts SET subscription_tier = 'copilot' WHERE id = ${accountId()}::uuid`,
      () => sql()`UPDATE accounts SET subscription_tier = 'autopilot' WHERE id = ${accountId()}::uuid`,
      async () => {
        await persistResponseAndNotify(
          sql(),
          makeInput(lateReviewId, { preLlmSubscriptionTier: 'copilot' }),
        );
      },
    );
    const lateResponseId = await responseIdFor(lateReviewId);
    expect(await refusals(lateResponseId!, 'policy_gate_held')).toHaveLength(0);
  });

  it('a policy_gate_held refusal occurred_at equals the persisted response created_at to the microsecond', async () => {
    const reviewId = randomUUID();
    await seedReview(reviewId, { triageSeverity: 'high' });
    await persistResponseAndNotify(sql(), makeInput(reviewId));

    const responseId = await responseIdFor(reviewId);
    // policy_gate_held has NO immutable stamp of its own (#997 F5) — which is
    // exactly why occurred_at is writer-supplied. Both values are
    // transaction_timestamp() in one transaction, compared in the database so
    // the microseconds survive.
    const [row] = await sql()<{ equal: boolean }[]>`
      SELECT (r.occurred_at = p.created_at) AS equal
      FROM refusal_events r
      JOIN responses p ON p.id = r.subject_id
      WHERE r.subject_id = ${responseId!}::uuid AND r.refusal_source = 'policy_gate_held'
    `;
    expect(row?.equal).toBe(true);
  });

  it('a review with no spine run still writes its policy_gate_held row', async () => {
    const reviewId = randomUUID();
    await seedReview(reviewId, { triageSeverity: 'high' });
    // No agent_runs row is seeded, so findActiveReviewRun returns null and
    // recordDraftSpineCheckpoints returns null — the legacy pre-spine ingest.
    await persistResponseAndNotify(sql(), makeInput(reviewId));

    const responseId = await responseIdFor(reviewId);
    // #997 resolution 1, and the single most likely thing to get wrong: the
    // ledger write must NOT inherit the activeRun half of the `policy_gate`
    // step's `activeRun && !held` guard in `persistResponseAndNotify`'s
    // `activeRun && !held` guard. Inheriting it silently drops rows from the
    // highest-volume lane.
    // `agent_runs.subject_id` is TEXT, not uuid — a `::uuid` cast here raises
    // `operator does not exist: text = uuid` rather than returning no rows.
    expect(await sql()`SELECT id FROM agent_runs WHERE subject_id = ${reviewId}`).toHaveLength(0);
    expect(await refusals(responseId!, 'policy_gate_held')).toHaveLength(1);
  });

  it('a structural non-candidate draft writes no policy_gate_held row', async () => {
    const reviewId = randomUUID();
    await seedReview(reviewId, { triageSeverity: 'high' });
    setFlags({ [AUTO_APPROVAL_FLAG]: 'false' });
    await persistResponseAndNotify(sql(), makeInput(reviewId));

    const responseId = await responseIdFor(reviewId);
    // Deviation D4: the flag off makes every draft a structural non-candidate,
    // runtimeState is null, no policy row is read, and the narrowing is
    // unevaluable. #1013's Volume section and #1003's operational note both
    // claim a row here; both are FALSE against this code and are not implemented.
    expect(await refusals(responseId!, 'policy_gate_held')).toHaveLength(0);
  });

  it('a structurally eligible draft with no configured policy threshold writes no policy_gate_held row', async () => {
    const reviewId = randomUUID();
    await seedReview(reviewId, { triageSeverity: 'high' });

    // THE LEDGER ALONE CANNOT PROVE THIS, and an earlier version of this case
    // pretended otherwise. Branch review round 1 (spec axis, and red team's
    // mutation M10) showed the ledger assertion below is UNFALSIFIABLE: a null
    // threshold makes the gate emit `policy_not_enabled`, which is itself a VETO
    // member, so no row is written whether or not `isGenuineAutoCandidate` keeps
    // its `threshold !== null` arm. M10 deleted the entire narrowing and 75
    // tests stayed green. The old comment here — "an incorrectly narrowed helper
    // writes policy_not_enabled" — was impossible by construction.
    //
    // The arm IS observable, but on the LOG side, which has no veto concept:
    // `logAutoApprovalFallbackIfNeeded` shares the same predicate precisely so
    // the two can never diverge, so the fallback log is the oracle. Capturing it
    // is what makes this case able to fail.
    const logged: string[] = [];
    const capturingLogger = {
      log: (...args: unknown[]) => { logged.push(String(args[0])); },
      warn: () => {},
    };

    await withTemporary(
      () => sql()`UPDATE auto_approval_policies SET auto_approve_min_star = NULL WHERE id = ${policyId}::uuid`,
      () => sql()`UPDATE auto_approval_policies SET auto_approve_min_star = 4 WHERE id = ${policyId}::uuid`,
      async () => {
        await persistResponseAndNotify(sql(), {
          ...makeInput(reviewId),
          logger: capturingLogger,
        });
      },
    );

    const responseId = await responseIdFor(reviewId);
    expect(await refusals(responseId!, 'policy_gate_held')).toHaveLength(0);
    // The discriminating assertion. Drop the `threshold !== null` arm and the
    // shared predicate admits this draft, the fallback log fires, and this fails.
    expect(
      logged.filter((line) => line === 'Auto-approval fallback to owner review'),
      'the shared narrowing must exclude a draft whose account has no configured threshold',
    ).toEqual([]);
  });

  it('a draft whose flag flips off mid-persist writes auto_approval_disabled as autonomy_paused', async () => {
    const reviewId = randomUUID();
    await seedReview(reviewId, { triageSeverity: 'high' });
    // isAutoApprovalCandidate reads the flag BEFORE the transaction
    // (`isAutoApprovalCandidate`); `evaluateAutoApprovalCandidate` reads it again
    // INSIDE (`evaluateAutoApprovalCandidate`'s own `autoApprovalRuntimeEnabled()`
    // read). A flip between the two is the member's ONLY live path, and
    // it is why auto_approval_disabled stays in the precedence list rather than
    // being dead weight (deviation D4).
    const flippingSql = new Proxy(sql(), {
      get(target, property, receiver) {
        if (property === 'begin') {
          return (...args: unknown[]) => {
            setFlags({ [AUTO_APPROVAL_FLAG]: 'false' });
            return (target.begin as (...a: unknown[]) => unknown)(...args);
          };
        }
        return Reflect.get(target, property, receiver);
      },
    }) as postgresType.Sql;

    await persistResponseAndNotify(flippingSql, makeInput(reviewId));

    const responseId = await responseIdFor(reviewId);
    const [row] = await refusals(responseId!, 'policy_gate_held');
    expect(row?.refusal_code).toBe('auto_approval_disabled');
    expect(row?.refusal_category).toBe('autonomy_paused');
  });

  it('an auto-approved draft writes no policy_gate_held row', async () => {
    const reviewId = randomUUID();
    // Five stars, threshold 4, clean moderation, active connection, autopilot:
    // nothing blocks it, so blockReasons is empty and approved is true.
    await seedReview(reviewId);
    await persistResponseAndNotify(sql(), makeInput(reviewId));

    const responseId = await responseIdFor(reviewId);
    const [approved] = await sql()<{ approval_method: string | null }[]>`
      SELECT approval_method FROM responses WHERE id = ${responseId!}::uuid
    `;
    expect(approved?.approval_method).toBe('auto_policy');
    // Nothing was refused, so there is nothing to record — and C5 rejects an
    // empty all_refusal_codes outright, so a row here could not be stored.
    expect(await refusals(responseId!, 'policy_gate_held')).toHaveLength(0);
  });

  it('a stale-content skip writes no refusal_events row on either lane', async () => {
    const reviewId = randomUUID();
    await seedReview(reviewId, { contentHash: 'hash-current', triageSeverity: 'high' });
    const heldBefore = await laneCount('held_draft');
    const policyBefore = await laneCount('policy_gate_held');
    const outcome = await persistResponseAndNotify(
      sql(),
      makeInput(reviewId, { loadedReviewContentHash: 'hash-loaded', moderation: HIGH_MODERATION }),
    );

    // The content-freshness gate (ADR 0017) returns BEFORE either write site is
    // reached, with zero writes. No response row exists, so no subject does.
    expect(outcome).toEqual({ kind: 'skipped_stale_content' });
    expect(await responseIdFor(reviewId)).toBeUndefined();
    expect(await laneCount('held_draft')).toBe(heldBefore);
    expect(await laneCount('policy_gate_held')).toBe(policyBefore);
  });

  it('replaying held_draft and replaying policy_gate_held for the same subject each leave one row on that lane and neither aborts the caller transaction', async () => {
    // Through the HELPER against a seeded subject, not through persist twice:
    // persistResponseAndNotify mints a fresh response id and (review_id,
    // version) is unique, so a second persist call fails on the responses INSERT
    // long before it could reach the refusal partial index.
    const { writeRefusalEvent } = await import('@/lib/refusals/write');
    const heldReviewId = randomUUID();
    await seedReview(heldReviewId);
    await persistResponseAndNotify(sql(), makeInput(heldReviewId, { moderation: HIGH_MODERATION }));
    const heldResponseId = (await responseIdFor(heldReviewId))!;

    const policyReviewId = randomUUID();
    await seedReview(policyReviewId, { triageSeverity: 'high' });
    await persistResponseAndNotify(sql(), makeInput(policyReviewId));
    const policyResponseId = (await responseIdFor(policyReviewId))!;

    // Each lane replayed on its OWN subject. ON CONFLICT DO NOTHING must let the
    // transaction COMMIT — a bare unique index would raise 23505 and abort the
    // decision the ledger exists to record.
    await sql().begin(async (tx) => {
      await writeRefusalEvent(tx, {
        accountId: accountId(),
        businessId,
        refusalSource: 'held_draft',
        refusalCode: null,
        allRefusalCodes: null,
        refusalCategory: 'unsafe_content',
        subjectType: 'response',
        subjectId: heldResponseId,
        occurredAt: 'transaction_time',
      });
    });
    await sql().begin(async (tx) => {
      await writeRefusalEvent(tx, {
        accountId: accountId(),
        businessId,
        refusalSource: 'policy_gate_held',
        refusalCode: 'triage_high_severity',
        allRefusalCodes: ['triage_high_severity'],
        refusalCategory: 'owner_review_required',
        subjectType: 'response',
        subjectId: policyResponseId,
        occurredAt: 'transaction_time',
      });
    });

    expect(await refusals(heldResponseId, 'held_draft')).toHaveLength(1);
    expect(await refusals(policyResponseId, 'policy_gate_held')).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Atomicity. Four cases, each on a path that can actually occur — a held
  // draft returns at `if (suppressNotification || held)` before the
  // notification enqueue, and
  // policy_gate_held requires held === false, so no single run has both a
  // flagged_responses row and a send_notification enqueue.
  // -------------------------------------------------------------------------

  it('a held_draft ledger constraint failure rolls back the response insert and flagged_responses row', async () => {
    const reviewId = randomUUID();
    await seedReview(reviewId);
    // A category migration 116's refusal_category CHECK does not admit — a real
    // 23514 from the real helper, not a JS throw.
    poison.heldDraftCategory = 'not_a_real_category';

    await expect(
      persistResponseAndNotify(sql(), makeInput(reviewId, { moderation: HIGH_MODERATION })),
    ).rejects.toThrow();

    expect(await responseIdFor(reviewId)).toBeUndefined();
    expect(
      await sql()`SELECT id FROM flagged_responses WHERE review_id = ${reviewId}::uuid`,
    ).toHaveLength(0);
  });

  it('a plain ledger error is rethrown rather than swallowed, so the response row rolls back on both lanes', async () => {
    // The oracle for the ledger WRITE fault's rethrow — `captureLedgerWriteFault`
    // inside `writeRefusalEvent` (#1083), not `withLedgerAttribution`, which
    // wraps only the `policy_gate_held` vocabulary resolve and no write on either
    // lane. A plain `Error` leaves the Postgres transaction HEALTHY, so nothing
    // but the rethrow can roll it back — unlike the two constraint cases, whose
    // `23514` poisons the transaction and would roll back even under a swallow.
    // Red-team round 2 planted that swallow and it survived all 75 tests; this is
    // what kills it.
    for (const [lane, moderation] of [
      ['held_draft', HIGH_MODERATION],
      ['policy_gate_held', CLEAN_MODERATION],
    ] as const) {
      const reviewId = randomUUID();
      await seedReview(reviewId, lane === 'policy_gate_held' ? { triageSeverity: 'high' } : {});
      ledgerPoison.throwOnLane = lane;

      await expect(
        persistResponseAndNotify(sql(), makeInput(reviewId, { moderation })),
        `${lane}: a ledger failure must reject the persist`,
      ).rejects.toThrow(/ledger_write_failed_plain_js/);

      // The claim that matters: a swallow would leave THIS row committed, with
      // no Refusal recorded against it — a draft the ledger silently lost.
      expect(await responseIdFor(reviewId), `${lane}: the response must not commit`).toBeUndefined();
      ledgerPoison.throwOnLane = null;
    }
  });

  it('a policy_gate_held C5 constraint failure rolls back the response insert and spine checkpoints', async () => {
    const reviewId = randomUUID();
    const runId = randomUUID();
    await seedReview(reviewId, { triageSeverity: 'high' });
    await sql()`
      INSERT INTO agent_runs (id, account_id, business_id, kind, subject_type, subject_id, status)
      VALUES (${runId}::uuid, ${accountId()}::uuid, ${businessId}::uuid, 'review_handler', 'review', ${reviewId}::uuid, 'running')
    `;
    // C5 requires the winner to be a MEMBER of all_refusal_codes.
    poison.breakC5 = true;

    await expect(persistResponseAndNotify(sql(), makeInput(reviewId))).rejects.toThrow();

    expect(await responseIdFor(reviewId)).toBeUndefined();
    expect(
      await sql()`SELECT id FROM agent_run_steps WHERE agent_run_id = ${runId}::uuid`,
    ).toHaveLength(0);
  });

  it('an abort after a completed held_draft persist rolls back the response, flagged_responses row, and held_draft row', async () => {
    const reviewId = randomUUID();
    await seedReview(reviewId);
    // The persist callback runs to COMPLETION, then a real Postgres error
    // poisons the transaction. Non-DDL, so nothing strands on the shared
    // container if this test times out.
    const before = await laneCount('held_draft');
    const executor = abortingExecutor(sql(), (tx) => tx`SELECT 1 / 0`);

    await expect(
      persistResponseAndNotify(executor, makeInput(reviewId, { moderation: HIGH_MODERATION })),
    ).rejects.toThrow();

    expect(await responseIdFor(reviewId)).toBeUndefined();
    expect(
      await sql()`SELECT id FROM flagged_responses WHERE review_id = ${reviewId}::uuid`,
    ).toHaveLength(0);
    expect(await laneCount('held_draft')).toBe(before);
  });

  it('an abort after a completed policy_gate_held persist rolls back the response, policy_gate_held row, spine checkpoints, and send_notification outbox row', async () => {
    const reviewId = randomUUID();
    const runId = randomUUID();
    await seedReview(reviewId, { triageSeverity: 'high' });
    await sql()`
      INSERT INTO agent_runs (id, account_id, business_id, kind, subject_type, subject_id, status)
      VALUES (${runId}::uuid, ${accountId()}::uuid, ${businessId}::uuid, 'review_handler', 'review', ${reviewId}::uuid, 'running')
    `;
    const outboxBefore = await sql()<{ n: number }[]>`
      SELECT count(*)::int AS n FROM job_outbox
      WHERE topic = 'send_notification' AND payload->>'business_id' = ${businessId}
    `;
    const before = await laneCount('policy_gate_held');
    const executor = abortingExecutor(sql(), (tx) => tx`SELECT 1 / 0`);

    await expect(persistResponseAndNotify(executor, makeInput(reviewId))).rejects.toThrow();

    expect(await responseIdFor(reviewId)).toBeUndefined();
    expect(
      await sql()`SELECT id FROM agent_run_steps WHERE agent_run_id = ${runId}::uuid`,
    ).toHaveLength(0);
    const outboxAfter = await sql()<{ n: number }[]>`
      SELECT count(*)::int AS n FROM job_outbox
      WHERE topic = 'send_notification' AND payload->>'business_id' = ${businessId}
    `;
    expect(outboxAfter[0]!.n).toBe(outboxBefore[0]!.n);
    expect(await laneCount('policy_gate_held')).toBe(before);
  });

  // -------------------------------------------------------------------------
  // The kill switch. Two paths, split because they cannot coexist in one run.
  // -------------------------------------------------------------------------

  it('REFUSAL_LEDGER_ENABLED=false preserves a held response and flagged_responses row while writing no held_draft row or notification', async () => {
    const reviewId = randomUUID();
    await seedReview(reviewId);
    setFlags({ [REFUSAL_LEDGER_FLAG]: 'false' });
    await persistResponseAndNotify(sql(), makeInput(reviewId, { moderation: HIGH_MODERATION }));

    const responseId = await responseIdFor(reviewId);
    // The lever the ticket names — "not a revert deploy": the decision still
    // lands, unrecorded. Everything invariant #4 guarantees is byte-identical.
    expect(responseId).toBeDefined();
    expect(
      await sql()`SELECT id FROM flagged_responses WHERE review_id = ${reviewId}::uuid`,
    ).toHaveLength(1);
    expect(await refusals(responseId!, 'held_draft')).toHaveLength(0);
    // A high-severity flag skips the notification whether or not the ledger runs.
    const [outbox] = await sql()<{ n: number }[]>`
      SELECT count(*)::int AS n FROM job_outbox
      WHERE topic = 'send_notification' AND payload->>'response_id' = ${responseId!}
    `;
    expect(outbox?.n).toBe(0);
  });

  it('REFUSAL_LEDGER_ENABLED=false preserves a policy-held response, spine checkpoints, and send_notification outbox row while writing no policy_gate_held row', async () => {
    const reviewId = randomUUID();
    const runId = randomUUID();
    await seedReview(reviewId, { triageSeverity: 'high' });
    await sql()`
      INSERT INTO agent_runs (id, account_id, business_id, kind, subject_type, subject_id, status)
      VALUES (${runId}::uuid, ${accountId()}::uuid, ${businessId}::uuid, 'review_handler', 'review', ${reviewId}::uuid, 'running')
    `;
    setFlags({ [REFUSAL_LEDGER_FLAG]: 'false' });
    await persistResponseAndNotify(sql(), makeInput(reviewId));

    const responseId = await responseIdFor(reviewId);
    expect(responseId).toBeDefined();
    // The policy_gate spine step still lands — it is not the ledger.
    const steps = await sql()<{ step_key: string }[]>`
      SELECT step_key FROM agent_run_steps WHERE agent_run_id = ${runId}::uuid
    `;
    expect(steps.map((s) => s.step_key)).toContain('policy_gate');
    const [outbox] = await sql()<{ n: number }[]>`
      SELECT count(*)::int AS n FROM job_outbox
      WHERE topic = 'send_notification' AND payload->>'response_id' = ${responseId!}
    `;
    expect(outbox?.n).toBe(1);
    expect(await refusals(responseId!, 'policy_gate_held')).toHaveLength(0);
  });

  it('both lanes write subject_type response, the response id, and the account and business keys already in scope', async () => {
    const heldReviewId = randomUUID();
    await seedReview(heldReviewId);
    await persistResponseAndNotify(sql(), makeInput(heldReviewId, { moderation: HIGH_MODERATION }));
    const heldResponseId = (await responseIdFor(heldReviewId))!;

    const policyReviewId = randomUUID();
    await seedReview(policyReviewId, { triageSeverity: 'high' });
    await persistResponseAndNotify(sql(), makeInput(policyReviewId));
    const policyResponseId = (await responseIdFor(policyReviewId))!;

    for (const [subjectId, source] of [
      [heldResponseId, 'held_draft'],
      [policyResponseId, 'policy_gate_held'],
    ] as const) {
      const [row] = await refusals(subjectId, source);
      // C1 fixes the subject TYPE from the lane; C2 makes the pair whole; C3
      // requires business_id NOT NULL for every lane but autonomy_suspended.
      expect(row?.subject_type, source).toBe('response');
      expect(row?.subject_id, source).toBe(subjectId);
      expect(row?.account_id, source).toBe(accountId());
      expect(row?.business_id, source).toBe(businessId);
    }
  });

  // -------------------------------------------------------------------------
  // #1079 — the kill switch must contain a VOCABULARY fault, not just a write
  // fault.
  //
  // The two cases above prove the flag writes no ROW. Neither can see that
  // `recordPolicyGateRefusal` still RESOLVED a category first, so a throw from
  // `resolvePolicyGateRefusal` aborted the whole persist with the switch already
  // off — and reported as a generic `worker_job` failure. These five own the
  // call count and the attribution.
  // -------------------------------------------------------------------------

  it('with REFUSAL_LEDGER_ENABLED off, persistResponseAndNotify invokes no refusals vocabulary resolver on the policy lane and the draft row commits', async () => {
    const reviewId = randomUUID();
    // THE POLICY-LANE FIXTURE, and the next case reuses it verbatim: an
    // `autopilot` tenant, the live-ingest lane, a configured threshold, clean
    // moderation, not approved — a GENUINE candidate whose `triage_high_severity`
    // block reason resolves to a real Refusal. Every arm matters, because the
    // assertion below is an assertion of ABSENCE: a copilot tier, a wrong origin
    // lane, a null threshold, `held` or `approved` each make guards 1-3 return
    // before the resolver and make this pass on HEAD.
    await seedReview(reviewId, { triageSeverity: 'high' });
    setFlags({ [REFUSAL_LEDGER_FLAG]: 'false' });

    await persistResponseAndNotify(sql(), makeInput(reviewId));

    // THE CLAIM. Not "no row was written" — that is true on HEAD and true of a
    // `try/catch` around the resolve. The vocabulary never RAN.
    expect(resolvePolicyGateRefusalSpy).not.toHaveBeenCalled();

    // …and containment means the decision still lands. The switch is a lever,
    // not a revert deploy.
    const responseId = await responseIdFor(reviewId);
    expect(responseId).toBeDefined();
    expect(await refusals(responseId!, 'policy_gate_held')).toHaveLength(0);
  });

  it('with REFUSAL_LEDGER_ENABLED on, the same policy-lane fixture invokes the resolver exactly once and writes its refusal row', async () => {
    // THE MANDATORY POSITIVE CONTROL for the case above. Without it that zero is
    // unfalsifiable: any defect in the fixture — a veto member, a wrong tier, a
    // structural block — produces zero calls on HEAD too, and the pair would be
    // a permanent false green. The ONLY difference here is the flag.
    const reviewId = randomUUID();
    await seedReview(reviewId, { triageSeverity: 'high' });
    setFlags({ [REFUSAL_LEDGER_FLAG]: 'true' });

    await persistResponseAndNotify(sql(), makeInput(reviewId));

    expect(resolvePolicyGateRefusalSpy).toHaveBeenCalledTimes(1);
    expect(resolvePolicyGateRefusalSpy.mock.calls[0]![0]).toContain('triage_high_severity');

    const responseId = await responseIdFor(reviewId);
    const rows = await refusals(responseId!, 'policy_gate_held');
    expect(rows, 'the fixture really does write a Refusal').toHaveLength(1);
    expect(rows[0]!.refusal_code).toBe('triage_high_severity');
  });

  it('with REFUSAL_LEDGER_ENABLED off, a throwing vocabulary resolver never runs and the draft row still commits', async () => {
    // THE ARMED FORM OF THE FLAG-OFF CASE ABOVE, and it closes that case's gap.
    // There the only evidence was a spy count, which proves the resolver the SPY
    // models was not called. Here the resolver is LOADED — the same
    // `vocabulary_resolver_exploded` the flag-on cases below use to abort a
    // persist — so any reachable path into it, spied or not, converts the
    // containment claim from an absence into a rejection this case would show.
    const reviewId = randomUUID();
    await seedReview(reviewId, { triageSeverity: 'high' });
    resolverPoison.throwWith = new Error('vocabulary_resolver_exploded');
    setFlags({ [REFUSAL_LEDGER_FLAG]: 'false' });

    // NO REJECTION, and that IS the containment guarantee (#1079). An armed
    // resolver that is never reached cannot throw; the two flag-on cases below
    // are the control that shows the same arming really does abort a persist
    // when the switch is on, so this resolve is not the poison failing to work.
    await persistResponseAndNotify(sql(), makeInput(reviewId));

    expect(resolvePolicyGateRefusalSpy).not.toHaveBeenCalled();
    // The attribution wrapper never fired either — no ledger fault was reported,
    // because none happened.
    expect(sentryStub.captureException).not.toHaveBeenCalled();

    // …and the decision still LANDS. A switch that dropped the draft would be a
    // revert deploy, not a lever.
    const responseId = await responseIdFor(reviewId);
    expect(responseId, 'the draft committed with the resolver armed').toBeDefined();
    expect(await refusals(responseId!, 'policy_gate_held')).toHaveLength(0);
  });

  it('with REFUSAL_LEDGER_ENABLED off, a would-have-recorded decision warns once and a veto-only decision does not', async () => {
    // THE ORACLE FOR THE WHOLE FINDING, in both directions. Guard 4 keeps the
    // lane's ledger-dark warning without running the resolver, and the rule it
    // must respect is `writeRefusalEvents`' contract (bullet 1): a decision that
    // records NOTHING either way has no ledger GAP, so warning about it puts
    // noise on the one signal that says the ledger is dark.
    //
    // THE LATCH IS MODULE-LEVEL, so each half resets it. Without that, half B's
    // zero would be satisfied by half A having already latched — the false green
    // this case exists to avoid.

    // HALF A — every block reason maps to a real category, so a row WOULD have
    // been written. `triage_high_severity` is the same fixture the two cases
    // above use, and the flag-on control there proves it really does record.
    resetRefusalLedgerWarningForTests();
    sentryStub.captureMessage.mockClear();
    const recordedReviewId = randomUUID();
    await seedReview(recordedReviewId, { triageSeverity: 'high' });
    setFlags({ [REFUSAL_LEDGER_FLAG]: 'false' });

    await persistResponseAndNotify(sql(), makeInput(recordedReviewId));

    expect(resolvePolicyGateRefusalSpy, 'still contained').not.toHaveBeenCalled();
    expect(
      ledgerDarkCaptures(),
      'a withheld row reports the gap',
    ).toHaveLength(1);

    // HALF B — a `null`-mapped VETO member is present, so the decision records
    // nothing on ANY flag setting and there is no gap to report. The copilot
    // downgrade is the `autopilot_tier_required` fixture from the ordering case
    // above, where the flag-on run is already proven to write zero rows.
    //
    // THIS HALF IS THE `every`-VS-`some` DISCRIMINATOR. The set also carries the
    // earlier mapped threshold reason, so `some(mapped && non-null)` is TRUE
    // here and a `some` implementation warns — exactly the noise #1003's veto
    // rule forbids.
    resetRefusalLedgerWarningForTests();
    sentryStub.captureMessage.mockClear();
    const vetoedReviewId = randomUUID();
    await seedReview(vetoedReviewId, { starRating: 2 });
    await withTemporary(
      () => sql()`UPDATE accounts SET subscription_tier = 'copilot' WHERE id = ${accountId()}::uuid`,
      () => sql()`UPDATE accounts SET subscription_tier = 'autopilot' WHERE id = ${accountId()}::uuid`,
      async () => {
        await persistResponseAndNotify(
          sql(),
          makeInput(vetoedReviewId, { preLlmSubscriptionTier: 'copilot' }),
        );
      },
    );

    expect(resolvePolicyGateRefusalSpy, 'still contained').not.toHaveBeenCalled();
    expect(
      ledgerDarkCaptures(),
      'a decision that records nothing either way reports no gap',
    ).toHaveLength(0);

    // And the draft landed on this half too — the silence is "no gap", never
    // "no decision".
    expect(await responseIdFor(vetoedReviewId)).toBeDefined();
  });

  it('a policy-gate resolver throw with the flag on captures exactly once with subsystem refusal_ledger and refusal_lane policy_gate_held and rethrows the same error instance', async () => {
    const reviewId = randomUUID();
    await seedReview(reviewId, { triageSeverity: 'high' });
    const injected = new Error('vocabulary_resolver_exploded');
    resolverPoison.throwWith = injected;

    const rejection = await persistResponseAndNotify(sql(), makeInput(reviewId)).catch(
      (error: unknown) => error,
    );

    // ATTRIBUTION is the whole point of moving the resolve inside the wrapper.
    // Before this branch the throw escaped it and an operator saw
    // `subsystem=worker_job` on the terminal attempt — nothing naming the ledger
    // or its flag.
    expect(sentryStub.captureException).toHaveBeenCalledTimes(1);
    const [captured, options] = sentryStub.captureException.mock.calls[0] as [
      unknown,
      { tags?: Record<string, unknown> },
    ];
    expect(captured, 'the REAL error is reported, not a wrapper').toBe(injected);
    expect(options.tags).toMatchObject({
      subsystem: 'refusal_ledger',
      refusal_lane: 'policy_gate_held',
      flag: REFUSAL_LEDGER_FLAG,
    });

    // THE SAME INSTANCE, not an equal one. A wrapper that re-threw
    // `new Error(String(error))` would satisfy every message assertion and lose
    // the stack that says which vocabulary entry failed.
    expect(rejection).toBe(injected);
  });

  it('a policy-gate resolver throw with the flag on still aborts the persist transaction, leaves no response row, and the rejection carries the injected error message', async () => {
    // THE OVER-APPLICATION GUARD. Containment is by NON-EXECUTION with the flag
    // OFF; with the flag ON a vocabulary fault must still abort, because a draft
    // that commits without its Refusal is the thing invariant #4's sibling rule
    // forbids. A `try/catch` added around the resolve to "fix" #1079 dies here.
    const reviewId = randomUUID();
    await seedReview(reviewId, { triageSeverity: 'high' });
    const before = await laneCount('policy_gate_held');
    resolverPoison.throwWith = new Error('vocabulary_resolver_exploded');

    await expect(persistResponseAndNotify(sql(), makeInput(reviewId))).rejects.toThrow(
      /vocabulary_resolver_exploded/,
    );

    // A plain JS throw leaves the Postgres transaction HEALTHY, so nothing but
    // the rethrow can roll this back.
    expect(await responseIdFor(reviewId)).toBeUndefined();
    expect(await laneCount('policy_gate_held')).toBe(before);
  });

  it('the held_draft lane still writes its refusal row and still aborts on a writer fault with the flag on', async () => {
    // THE UNTOUCHED-LANE PIN. `recordModerationAndHold`'s write takes only
    // literals and the module constant, so it has no pre-write resolve and gains
    // no guard — this case is what makes that claim falsifiable rather than
    // asserted.
    const writeReviewId = randomUUID();
    await seedReview(writeReviewId);
    await persistResponseAndNotify(sql(), makeInput(writeReviewId, { moderation: HIGH_MODERATION }));

    const writtenResponseId = await responseIdFor(writeReviewId);
    expect(await refusals(writtenResponseId!, 'held_draft')).toHaveLength(1);
    // …and the policy lane's new guard did not leak onto it.
    //
    // ON THIS FIXTURE THE COUNT IS A GUARD-1 ORACLE, NOT A PIN, and an earlier
    // version of this comment had it backwards ("this lane calls no resolver on
    // ANY implementation"). #1079's red-team pass measured it: delete
    // `if (held) return;` from `persist.ts` and THIS assertion fails. With
    // `held` true the gate emits `moderation_held`, so `approved` is false and
    // guards 2, 3 and 4 all pass — the resolver runs, and the recorded call is
    // `["moderation_flagged","moderation_held"]`.
    //
    // That is the same measurement `recordPolicyGateRefusal`'s docblock now
    // states from the implementation side; leaving the old wording here would
    // have contradicted the docblock this assertion exists to corroborate.
    expect(resolvePolicyGateRefusalSpy).not.toHaveBeenCalled();

    const abortReviewId = randomUUID();
    await seedReview(abortReviewId);
    const before = await laneCount('held_draft');
    ledgerPoison.throwOnLane = 'held_draft';

    await expect(
      persistResponseAndNotify(sql(), makeInput(abortReviewId, { moderation: HIGH_MODERATION })),
    ).rejects.toThrow(/ledger_write_failed_plain_js/);

    expect(await responseIdFor(abortReviewId)).toBeUndefined();
    expect(await laneCount('held_draft')).toBe(before);
  });
});
