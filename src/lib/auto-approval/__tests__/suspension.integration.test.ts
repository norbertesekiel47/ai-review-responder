import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import type postgresType from 'postgres';
import { describeWithDb } from '@/__tests__/helpers/describe-with-db';
import {
  cleanupTenantAccount,
  seedTenantAccount,
  type TenantSeed,
} from '@/lib/shared/__tests__/live-db-tenant';
import { QUEUE_NAMES } from '@/lib/shared/queue-names';
import { getAutoApprovalSettings, patchAutoApprovalSettings } from '../settings';
import {
  AUTONOMY_SUSPENSION_REASONS,
  listSuspendedPolicies,
  suspendAccountAutonomy,
  unsuspendAccountAutonomy,
} from '../suspension';

// ── #1009 slice 2: the first Refusal write site ─────────────────────────────
//
// `suspendAccountAutonomy` is where the Refusal ledger gets its first caller —
// `autonomy_suspended`, one site, inside the existing transaction. The five
// cases at the foot of this file (titles 16-20) extend this suite rather than
// opening a sibling one: it already stands up the account, the TWO businesses
// and the policy rows they need, and a second file would fork that fixture and
// split one lane's coverage across two places.
//
// WHY THE VOCABULARY MODULE IS MOCKED. Title 20 has to force a REAL ledger
// rejection from the REAL helper inside the REAL deciding transaction — a
// mocked-away helper would prove only that a stub can reject, and every other
// case here supplies valid input, so a catch-and-swallow helper (or one that
// opened its own connection) would pass all of them. Bending ONE map entry to
// an unknown category makes the ledger INSERT violate
// `refusal_events_refusal_category_check`, which is exactly the writer bug the
// design says must abort the decision rather than be caught.
//
// The stand-in map is DERIVED from the real one inside the factory, never
// re-typed: titles 16-19 must run against the production vocabulary, and a
// hand-copied map here would be a second authority over the same four triggers.
const { autonomySuspendedCategories } = vi.hoisted(() => ({
  autonomySuspendedCategories: {} as Record<string, string>,
}));

vi.mock('@/lib/refusals/vocabulary', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/refusals/vocabulary')>();
  Object.assign(autonomySuspendedCategories, actual.AUTONOMY_SUSPENDED_REFUSAL_CATEGORIES);
  return { ...actual, AUTONOMY_SUSPENDED_REFUSAL_CATEGORIES: autonomySuspendedCategories };
});

/** The default-ON kill switch. Only the literal string 'false' disables it. */
const LEDGER_FLAG = 'REFUSAL_LEDGER_ENABLED';

/** Postgres' CHECK-violation SQLSTATE. */
const CHECK_VIOLATION = '23514';

const testDatabaseUrl = process.env.TEST_DATABASE_POOL_URL;

let db: postgresType.Sql | undefined;
let tenant: TenantSeed | undefined;
const primaryBusinessId = randomUUID();
const secondaryBusinessId = randomUUID();

function sql(): postgresType.Sql {
  if (!db) throw new Error('suspension integration database was not initialized');
  return db;
}

function requireTenant(): TenantSeed {
  if (!tenant) throw new Error('suspension integration tenant was not seeded');
  return tenant;
}

// Local-host refusal guard: any localhost/127.0.0.1 Postgres is accepted (the
// dev container AND the CI service container), everything else — notably any
// Supabase/pooler host — is refused. Never widen this to remote hosts.
function assertExactLocalDatabaseUrl(databaseUrl: string | undefined): string {
  let parsed: URL | undefined;
  try {
    parsed = databaseUrl === undefined ? undefined : new URL(databaseUrl);
  } catch {
    parsed = undefined;
  }
  const isLocalPostgres =
    parsed !== undefined &&
    (parsed.protocol === 'postgres:' || parsed.protocol === 'postgresql:') &&
    (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1');
  if (databaseUrl === undefined || !isLocalPostgres) {
    throw new Error('suspension integration requires a local (localhost) test database');
  }
  return databaseUrl;
}

async function cleanTaskRows(): Promise<void> {
  const accountId = requireTenant().accountId;
  await sql()`
    DELETE FROM job_outbox
    WHERE topic IN (
      ${QUEUE_NAMES.AUTONOMY_SUSPENDED_NOTICE},
      ${QUEUE_NAMES.AUTONOMY_ADMIN_ALERT}
    )
      AND payload->>'account_id' = ${accountId}
  `;
  await sql()`DELETE FROM refusal_events WHERE account_id = ${accountId}::uuid`;
  await sql()`DELETE FROM account_audit_log WHERE account_id = ${accountId}::uuid`;
  await sql()`DELETE FROM auto_approval_policies WHERE account_id = ${accountId}::uuid`;
}

async function suspend(trigger: 'judge_flag' | 'governor_edit_rate' = 'judge_flag') {
  const evidence = trigger === 'judge_flag'
    ? { verdict_id: randomUUID() } as const
    : { rate: 0.6, numer: 3, denom: 5, windowDays: 7 } as const;
  return sql().begin((tx) => suspendAccountAutonomy(tx, {
    accountId: requireTenant().accountId,
    trigger,
    suspensionEventId: randomUUID(),
    evidence,
  }));
}

interface AccountDefaultSuspensionRow {
  suspended_at: Date | null;
  suspended_reason: string | null;
}

async function readAccountDefaultSuspension(): Promise<AccountDefaultSuspensionRow> {
  const [row] = await sql()<AccountDefaultSuspensionRow[]>`
    SELECT suspended_at, suspended_reason
    FROM auto_approval_policies
    WHERE account_id = ${requireTenant().accountId}::uuid
      AND location_id IS NULL
  `;
  if (!row) throw new Error('expected an account-default auto-approval policy row');
  return row;
}

async function readSuspensionFactCounts(): Promise<{
  audit_count: number;
  notice_count: number;
  alert_count: number;
}> {
  const accountId = requireTenant().accountId;
  const [facts] = await sql()<{
    audit_count: number;
    notice_count: number;
    alert_count: number;
  }[]>`
    SELECT
      (SELECT COUNT(*)::int FROM account_audit_log
       WHERE account_id = ${accountId}::uuid
         AND event_type = 'autonomy_suspended') AS audit_count,
      (SELECT COUNT(*)::int FROM job_outbox
       WHERE payload->>'account_id' = ${accountId}
         AND topic = ${QUEUE_NAMES.AUTONOMY_SUSPENDED_NOTICE}) AS notice_count,
      (SELECT COUNT(*)::int FROM job_outbox
       WHERE payload->>'account_id' = ${accountId}
         AND topic = ${QUEUE_NAMES.AUTONOMY_ADMIN_ALERT}) AS alert_count
  `;
  if (!facts) throw new Error('expected suspension fact counts');
  return facts;
}

/** One Refusal row, every column the `autonomy_suspended` lane pins. */
interface RefusalRow {
  refusal_source: string;
  refusal_code: string | null;
  refusal_category: string;
  business_id: string | null;
  subject_type: string | null;
  subject_id: string | null;
  /**
   * Read as `::text`. postgres.js decodes timestamptz to a JS `Date` and
   * TRUNCATES microseconds (#520), and the six digits `NOW()` carries are
   * exactly what title 17's equality against `account_audit_log.created_at`
   * rests on — that join is the substitute #1006 accepted for a
   * `suspension_event_id` column.
   */
  occurred_at: string;
}

async function readRefusalRows(): Promise<RefusalRow[]> {
  return sql()<RefusalRow[]>`
    SELECT refusal_source,
           refusal_code,
           refusal_category,
           business_id::text AS business_id,
           subject_type,
           subject_id::text AS subject_id,
           occurred_at::text AS occurred_at
    FROM refusal_events
    WHERE account_id = ${requireTenant().accountId}::uuid
    ORDER BY occurred_at, refusal_source
  `;
}

describeWithDb('autonomy suspension against live local Postgres', { timeout: 30_000 }, () => {
  beforeAll(async () => {
    db = postgres(assertExactLocalDatabaseUrl(testDatabaseUrl), { max: 1, prepare: false });
    tenant = await seedTenantAccount(db, {
      userName: 'Suspension Integration Owner',
      accountDisplayName: 'Suspension Integration Account',
    });
    await db`
      INSERT INTO businesses (
        id, name, owner_name, owner_email, account_id, subscription_status, is_primary
      ) VALUES
        (${primaryBusinessId}::uuid, 'Suspension Primary', 'Owner', ${tenant.ownerEmail}, ${tenant.accountId}::uuid, 'active', TRUE),
        (${secondaryBusinessId}::uuid, 'Suspension Secondary', 'Owner', ${tenant.ownerEmail}, ${tenant.accountId}::uuid, 'active', FALSE)
    `;
  });

  beforeEach(async () => {
    // The ledger is default-ON. A 'false' leaked from title 18 would turn every
    // other Refusal assertion into a silently-passing no-op.
    delete process.env[LEDGER_FLAG];
    await cleanTaskRows();
  });

  afterEach(() => {
    delete process.env[LEDGER_FLAG];
  });

  afterAll(async () => {
    if (!db || !tenant) return;
    await cleanTaskRows();
    await sql()`DELETE FROM businesses WHERE id IN (${primaryBusinessId}::uuid, ${secondaryBusinessId}::uuid)`;
    await cleanupTenantAccount(sql(), tenant);
    await db.end({ timeout: 5 });
  });

  it('creates a suspended account-default row plus one audit and both outboxes', async () => {
    await expect(suspend()).resolves.toEqual({ newlySuspended: true });

    const [policy] = await sql()<{
      auto_approve_min_star: number | null;
      suspended_at: Date | null;
      suspended_reason: string | null;
    }[]>`
      SELECT auto_approve_min_star, suspended_at, suspended_reason
      FROM auto_approval_policies
      WHERE account_id = ${requireTenant().accountId}::uuid
        AND location_id IS NULL
    `;
    expect(policy).toMatchObject({
      auto_approve_min_star: null,
      suspended_reason: AUTONOMY_SUSPENSION_REASONS.judge_flag,
    });
    expect(policy?.suspended_at).not.toBeNull();

    const [facts] = await sql()<{ audit_count: number; outbox_count: number }[]>`
      SELECT
        (SELECT COUNT(*)::int FROM account_audit_log
         WHERE account_id = ${requireTenant().accountId}::uuid
           AND event_type = 'autonomy_suspended') AS audit_count,
        (SELECT COUNT(*)::int FROM job_outbox
         WHERE aggregate_id IN (
           SELECT (payload->>'suspension_event_id')::uuid
           FROM job_outbox
           WHERE payload->>'account_id' = ${requireTenant().accountId}
         )
           AND topic IN (
             ${QUEUE_NAMES.AUTONOMY_SUSPENDED_NOTICE},
             ${QUEUE_NAMES.AUTONOMY_ADMIN_ALERT}
           )) AS outbox_count
    `;
    expect(facts).toEqual({ audit_count: 1, outbox_count: 2 });
  });

  it('replays a same-trigger suspension as a no-op without duplicating audit or outbox facts', async () => {
    await expect(suspend('judge_flag')).resolves.toEqual({ newlySuspended: true });
    const before = await readAccountDefaultSuspension();
    expect(before.suspended_at).not.toBeNull();
    expect(before.suspended_reason).toBe(AUTONOMY_SUSPENSION_REASONS.judge_flag);

    await expect(suspend('judge_flag')).resolves.toEqual({ newlySuspended: false });

    const after = await readAccountDefaultSuspension();
    expect(after.suspended_at?.getTime()).toBe(before.suspended_at?.getTime());
    expect(after.suspended_reason).toBe(before.suspended_reason);
    await expect(readSuspensionFactCounts()).resolves.toEqual({
      audit_count: 1,
      notice_count: 1,
      alert_count: 1,
    });
  });

  it('keeps the original reason when the other trigger hits an already-suspended account', async () => {
    await expect(suspend('governor_edit_rate')).resolves.toEqual({ newlySuspended: true });
    const before = await readAccountDefaultSuspension();
    expect(before.suspended_reason).toBe(AUTONOMY_SUSPENSION_REASONS.governor_edit_rate);

    await expect(suspend('judge_flag')).resolves.toEqual({ newlySuspended: false });

    const after = await readAccountDefaultSuspension();
    expect(after.suspended_reason).toBe(AUTONOMY_SUSPENSION_REASONS.governor_edit_rate);
    expect(after.suspended_at?.getTime()).toBe(before.suspended_at?.getTime());
    await expect(readSuspensionFactCounts()).resolves.toEqual({
      audit_count: 1,
      notice_count: 1,
      alert_count: 1,
    });
  });

  it('projects the account suspension across every location including an override', async () => {
    await sql()`
      INSERT INTO auto_approval_policies (
        id, account_id, location_id, persona, action_class, auto_approve_min_star
      ) VALUES (
        ${randomUUID()}::uuid,
        ${requireTenant().accountId}::uuid,
        ${secondaryBusinessId}::uuid,
        'reply',
        'posting',
        5
      )
    `;

    await suspend('governor_edit_rate');
    const settings = await getAutoApprovalSettings(sql(), {
      accountId: requireTenant().accountId,
      impersonated: false,
    });

    expect(settings.locations).toHaveLength(2);
    expect(settings.locations.every((location) => location.effective.suspended)).toBe(true);
    expect(settings.locations.find((location) => location.locationId === secondaryBusinessId))
      .toMatchObject({ effective: { source: 'location_override', threshold: 5, suspended: true } });
  });

  it('preserves manual mode through suspended clear and admin unsuspend', async () => {
    await sql()`
      INSERT INTO auto_approval_policies (
        id, account_id, location_id, persona, action_class, auto_approve_min_star
      ) VALUES (
        ${randomUUID()}::uuid,
        ${requireTenant().accountId}::uuid,
        NULL,
        'reply',
        'posting',
        4
      )
    `;
    await suspend();

    const cleared = await patchAutoApprovalSettings(sql(), {
      accountId: requireTenant().accountId,
      actorUserId: requireTenant().userId,
      impersonated: false,
      operation: 'clear_account_default',
    });
    expect(cleared.accountDefault).toMatchObject({
      exists: true,
      threshold: null,
      suspended: true,
    });

    const unsuspended = await sql().begin((tx) => unsuspendAccountAutonomy(tx, {
      accountId: requireTenant().accountId,
      actorUserId: requireTenant().userId,
      note: 'Safety review completed.',
    }));
    expect(unsuspended).toEqual({ unsuspended: true, rearmed: false });

    const settings = await getAutoApprovalSettings(sql(), {
      accountId: requireTenant().accountId,
      impersonated: false,
    });
    expect(settings.accountDefault).toMatchObject({
      exists: true,
      threshold: null,
      suspended: false,
      suspendedReason: null,
    });
    expect(settings.locations.every((location) => !location.effective.suspended)).toBe(true);

    const [audit] = await sql()<{ previous_reason: string | null }[]>`
      SELECT payload->>'previous_reason' AS previous_reason
      FROM account_audit_log
      WHERE account_id = ${requireTenant().accountId}::uuid
        AND event_type = 'autonomy_unsuspended'
      ORDER BY created_at DESC
      LIMIT 1
    `;
    expect(audit?.previous_reason).toBe(AUTONOMY_SUSPENSION_REASONS.judge_flag);
  });

  it('returns only the newest five flags and tolerates non-array reasons JSONB', async () => {
    const rows = Array.from({ length: 7 }, (_, index) => ({
      reviewId: randomUUID(),
      responseId: randomUUID(),
      verdictId: randomUUID(),
      createdAt: new Date(Date.UTC(2026, 6, 13, 12, 0, index)),
    }));

    try {
      await suspend();
      await sql().begin(async (tx) => {
        for (const [index, row] of rows.entries()) {
          await tx`
            INSERT INTO reviews (
              id, business_id, provider, provider_review_id, provider_review_name,
              provider_location_name, reviewer_name, star_rating, review_text, status
            ) VALUES (
              ${row.reviewId}::uuid,
              ${primaryBusinessId}::uuid,
              'zernio',
              ${`suspension-flag-${row.reviewId}`},
              ${`zernio://suspension/reviews/${row.reviewId}`},
              'zernio://suspension/locations/primary',
              'Safety Reviewer',
              5,
              'Safe fixture review.',
              'posted'
            )
          `;
          await tx`
            INSERT INTO responses (
              id, review_id, business_id, response_text, original_draft_text,
              version, status, approval_method, posted_at
            ) VALUES (
              ${row.responseId}::uuid,
              ${row.reviewId}::uuid,
              ${primaryBusinessId}::uuid,
              'Safe fixture reply.',
              'Safe fixture reply.',
              1,
              'posted',
              'auto_policy',
              ${row.createdAt}
            )
          `;
          await tx`
            INSERT INTO judge_verdicts (
              id, account_id, business_id, review_id, response_id,
              verdict, reasons, rationale, model, prompt_version, created_at
            ) VALUES (
              ${row.verdictId}::uuid,
              ${requireTenant().accountId}::uuid,
              ${primaryBusinessId}::uuid,
              ${row.reviewId}::uuid,
              ${row.responseId}::uuid,
              'flag',
              ${tx.json(index === 6 ? { malformed: true } : ['fabricated_fact'])},
              'Enum-only fixture rationale.',
              'gpt-4o-mini-2024-07-18',
              '2026-07-13.1',
              ${row.createdAt}
            )
          `;
        }
      });

      const [suspension] = await listSuspendedPolicies(sql());
      expect(suspension?.recentFlagVerdicts.map((verdict) => verdict.id)).toEqual(
        rows.slice(2).reverse().map((row) => row.verdictId),
      );
      expect(suspension?.recentFlagVerdicts[0]?.reasons).toEqual([]);
    } finally {
      const responseIds = rows.map((row) => row.responseId);
      const reviewIds = rows.map((row) => row.reviewId);
      await sql()`DELETE FROM judge_verdicts WHERE response_id = ANY(${responseIds}::uuid[])`;
      await sql()`DELETE FROM responses WHERE id = ANY(${responseIds}::uuid[])`;
      await sql()`DELETE FROM reviews WHERE id = ANY(${reviewIds}::uuid[])`;
    }
  });

  // ── #1009: the first Refusal write site (titles 16-20) ────────────────────

  it('suspendAccountAutonomy writes exactly one refusal_events row per account with business_id IS NULL, never one per location', async () => {
    // The fixture seeds TWO businesses under this one account, and that is the
    // whole point of the case. The parent effort's defect joined the audit log
    // through `businesses` and multiplied one ACCOUNT-level event into one row
    // per location; `toBeGreaterThan` passes on that defect, so this asserts
    // EXACTLY one. CHECK C3 makes the shape unrepresentable at the schema
    // level; this is the regression test that the WRITER agrees.
    await expect(suspend()).resolves.toEqual({ newlySuspended: true });

    const rows = await readRefusalRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      refusal_source: 'autonomy_suspended',
      // The trigger VERBATIM, never normalised — it is the input that keeps
      // skew re-derivable (C4 requires a code for every lane but held_draft).
      refusal_code: 'judge_flag',
      refusal_category: 'autonomy_paused',
      // Account-wide: a suspension is an account-level act (C3).
      business_id: null,
      // This lane points at nothing, by design (C1/C2).
      subject_type: null,
      subject_id: null,
    });
  });

  it("the refusal_events row suspendAccountAutonomy writes carries occurred_at equal to the account_audit_log row's created_at from the same transaction", async () => {
    await expect(suspend()).resolves.toEqual({ newlySuspended: true });

    // Both columns read as ::text. This equality IS the join #1006 accepted in
    // place of a `suspension_event_id` column on refusal_events: `NOW()` is
    // `transaction_timestamp()` and `account_audit_log.created_at` is
    // `DEFAULT NOW()` (migration 034), so two rows written in one transaction
    // agree to the microsecond. A site that read the clock back as a JS `Date`
    // and passed it in would lose those microseconds (#520) and kill the join —
    // this is the only thing holding it together.
    const [pair] = await sql()<{
      refusal_occurred_at: string;
      audit_created_at: string;
    }[]>`
      SELECT refusal.occurred_at::text AS refusal_occurred_at,
             audit.created_at::text AS audit_created_at
      FROM refusal_events refusal
      JOIN account_audit_log audit
        ON audit.account_id = refusal.account_id
       AND audit.event_type = 'autonomy_suspended'
      WHERE refusal.account_id = ${requireTenant().accountId}::uuid
    `;

    expect(pair, 'expected one refusal row joined to one audit row').toBeDefined();
    expect(pair!.refusal_occurred_at).toBe(pair!.audit_created_at);
    // Microseconds are actually PRESENT, so the equality is not two truncated
    // values agreeing by accident.
    expect(pair!.refusal_occurred_at).toMatch(/\.\d{1,6}/);
  });

  it('suspendAccountAutonomy still suspends, still writes its audit row and still enqueues its notices when REFUSAL_LEDGER_ENABLED is false', async () => {
    process.env[LEDGER_FLAG] = 'false';

    await expect(suspend()).resolves.toEqual({ newlySuspended: true });

    // The kill switch stops the LEDGER and nothing else: suspension, audit and
    // notification behaviour stay byte-identical to before this slice. That is
    // what makes it a lever that is not a revert deploy.
    const policy = await readAccountDefaultSuspension();
    expect(policy.suspended_at).not.toBeNull();
    expect(policy.suspended_reason).toBe(AUTONOMY_SUSPENSION_REASONS.judge_flag);
    await expect(readSuspensionFactCounts()).resolves.toEqual({
      audit_count: 1,
      notice_count: 1,
      alert_count: 1,
    });

    expect(await readRefusalRows()).toEqual([]);
  });

  it('suspendAccountAutonomy writes no refusal_events row when the account was already suspended', async () => {
    await expect(suspend('judge_flag')).resolves.toEqual({ newlySuspended: true });
    expect(await readRefusalRows()).toHaveLength(1);

    // A Refusal records a DECISION. An already-suspended account made no new
    // decision — `newlySuspended: false` — so there is nothing to record, and
    // the write site sits after the `!policy` guard for exactly that reason.
    await expect(suspend('governor_edit_rate')).resolves.toEqual({ newlySuspended: false });
    expect(await readRefusalRows()).toHaveLength(1);
  });

  it('a writeRefusalEvent rejection rolls back the suspension policy, the audit row and the notice outbox rows', async () => {
    const original = { ...autonomySuspendedCategories };
    // A writer bug: a category the CHECK does not admit. The helper does NOT
    // catch this — `ON CONFLICT` covers duplicate keys only, and a CHECK
    // violation aborts the decision transaction on purpose, because catching it
    // would hide the bug in the one place the ledger cannot report it.
    autonomySuspendedCategories.judge_flag = 'a_category_the_ledger_never_named';
    try {
      await expect(suspend('judge_flag')).rejects.toMatchObject({
        code: CHECK_VIOLATION,
        constraint_name: expect.stringContaining('refusal_events'),
      });
    } finally {
      for (const key of Object.keys(autonomySuspendedCategories)) {
        delete autonomySuspendedCategories[key];
      }
      Object.assign(autonomySuspendedCategories, original);
    }

    // EVERYTHING the transaction wrote is gone.
    //
    // What this DOES discriminate: a helper that opens its own connection
    // instead of using the caller's `tx` — its row would survive this rollback.
    //
    // What it does NOT discriminate, corrected after red-team RT-4: a helper
    // that CATCHES its own insert error. postgres.js records `uncaughtError`
    // per query inside `scope()` and rethrows it after the callback returns
    // (`index.js:290-296`), so the transaction aborts even when the helper
    // swallows — that mutation is EQUIVALENT, not killed. An earlier version of
    // this comment claimed the opposite, which would have let a reader trust a
    // guarantee this assertion does not provide. The no-catch policy is held by
    // `write.ts`'s own comment and by review, not by this test.
    const [policy] = await sql()<{ id: string }[]>`
      SELECT id FROM auto_approval_policies
      WHERE account_id = ${requireTenant().accountId}::uuid
    `;
    expect(policy).toBeUndefined();
    await expect(readSuspensionFactCounts()).resolves.toEqual({
      audit_count: 0,
      notice_count: 0,
      alert_count: 0,
    });
    expect(await readRefusalRows()).toEqual([]);
  });
});
