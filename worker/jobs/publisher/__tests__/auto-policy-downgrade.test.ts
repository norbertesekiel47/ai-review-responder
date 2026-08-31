import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSql, sqlReturnQueue, sqlCalls, resetMockSql, mkTaggedResult } =
  await vi.hoisted(async () => {
    const helpers = await import('../../../__tests__/helpers/mock-sql');
    return { ...helpers.createMockSql(), mkTaggedResult: helpers.mkTaggedResult };
  });

import {
  AUTO_POST_REVOKED_REFUSAL_CATEGORIES,
  REFUSAL_VOCABULARY_VERSION,
} from '@/lib/refusals/vocabulary';
import { downgradeAutoApprovedResponseForManualReview } from '../auto-policy-downgrade';

const logger = { warn: vi.fn() };

/**
 * TWO DIFFERENT ACCOUNT IDS, and the difference is the whole point of the
 * `account_id` cases below.
 *
 * `insertAuditLogAutoPolicy` resolves its OWN account id with a second
 * `SELECT account_id FROM businesses` (`resolveAccountIdFromBusiness`), and the
 * owner explicitly declined to reuse that path — the Refusal must carry the id
 * the downgrade transaction's EXISTING business lock already read. If both
 * mocks returned one value, a write site that resolved the account the audit
 * way would pass every assertion here.
 */
const BUSINESS_LOCK_ACCOUNT_ID = 'account-from-the-business-lock';
const AUDIT_RESOLVED_ACCOUNT_ID = 'account-from-the-audit-resolver';

function input() {
  return {
    responseId: 'response-1',
    businessId: 'business-1',
    outboxId: 'outbox-1',
    outboxAttempt: 2,
    correlationId: 'correlation-1',
    reason: 'judge_unhealthy' as const,
    logger,
  };
}

/**
 * The queue for a downgrade that reaches every durable write, in statement
 * order. Named rather than inlined because five cases below need the same
 * ladder and only differ in one rung.
 */
function pushDowngradeQueue(overrides: { updateReturns?: unknown[] } = {}): void {
  sqlReturnQueue.push(
    mkTaggedResult([{ review_id: 'review-1' }]),
    mkTaggedResult([{ id: 'review-1' }]),
    mkTaggedResult([{ id: 'business-1', account_id: BUSINESS_LOCK_ACCOUNT_ID }]),
    mkTaggedResult([{ status: 'approved', approval_method: 'auto_policy' }]),
    mkTaggedResult([{}]),
    mkTaggedResult(overrides.updateReturns ?? [{ id: 'response-1' }]),
    mkTaggedResult([{ account_id: AUDIT_RESOLVED_ACCOUNT_ID }]),
    mkTaggedResult([]),
    mkTaggedResult([]),
    mkTaggedResult([]),
  );
}

function refusalInserts() {
  return sqlCalls.filter((call) => call.text.includes('INSERT INTO refusal_events'));
}

describe('downgradeAutoApprovedResponseForManualReview ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMockSql();
  });

  it('does no durable work when a newer outbox attempt owns the response', async () => {
    sqlReturnQueue.push(
      mkTaggedResult([{ review_id: 'review-1' }]),
      mkTaggedResult([{ id: 'review-1' }]),
      mkTaggedResult([{ id: 'business-1', account_id: BUSINESS_LOCK_ACCOUNT_ID }]),
      mkTaggedResult([{ status: 'approved', approval_method: 'auto_policy' }]),
      mkTaggedResult([]),
    );

    await expect(
      downgradeAutoApprovedResponseForManualReview(mockSql as never, input()),
    ).resolves.toBe('no-op');

    expect(sqlCalls[0]!.text).toContain('SELECT review_id FROM responses');
    expect(sqlCalls[1]!.text).toContain('SELECT id FROM reviews');
    expect(sqlCalls[2]!.text).toContain('FROM businesses');
    expect(sqlCalls[3]!.text).toContain('FROM responses');
    expect(sqlCalls[4]!.text).toContain("SET status = 'completed'");
    expect(sqlCalls[4]!.values).toEqual(['outbox-1', 2]);
    expect(sqlCalls.some((call) => call.text.includes("status = 'pending_approval'"))).toBe(false);
    expect(sqlCalls.some((call) => call.text.includes('approval_audit_log'))).toBe(false);
    expect(sqlCalls.some((call) => call.text.includes('INSERT INTO job_outbox'))).toBe(false);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('claims the dispatched attempt before mutating the response and writing follow-ups', async () => {
    pushDowngradeQueue();

    await expect(
      downgradeAutoApprovedResponseForManualReview(mockSql as never, input()),
    ).resolves.toBe('downgraded');

    // The FULL statement list, in order. It is an equality rather than a set of
    // `toContain`s because it is what pins the statement COUNT: the Refusal is
    // the ONE statement this slice adds, and a second `businesses` read to
    // resolve the account would show up here as an extra rung.
    expect(sqlCalls.map((call) => call.text)).toEqual([
      expect.stringContaining('SELECT review_id FROM responses'),
      expect.stringContaining('SELECT id FROM reviews'),
      expect.stringContaining('FROM businesses'),
      expect.stringContaining('FOR UPDATE'),
      expect.stringContaining("SET status = 'completed'"),
      expect.stringContaining("status = 'pending_approval'"),
      expect.stringContaining('SELECT account_id'),
      expect.stringContaining('INSERT INTO approval_audit_log'),
      expect.stringContaining('INSERT INTO refusal_events'),
      expect.stringContaining('INSERT INTO job_outbox'),
    ]);
    expect(sqlCalls[4]!.values).toEqual(['outbox-1', 2]);
    expect(sqlCalls[5]!.values).toContain('auto_policy_revoked_judge_unavailable');
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it('uses a distinct bounded marker and reason for Autopilot entitlement loss', async () => {
    pushDowngradeQueue();

    await expect(downgradeAutoApprovedResponseForManualReview(mockSql as never, {
      ...input(),
      reason: 'autopilot_entitlement_lost',
    })).resolves.toBe('downgraded');

    expect(sqlCalls[5]!.values).toContain('auto_policy_revoked_tier_entitlement');
    expect(sqlCalls[7]!.values).toContainEqual(expect.objectContaining({
      downgrade_reason: 'autopilot_entitlement_lost',
      runtime_enabled: true,
    }));
  });
});

// ── #1012: the `auto_post_revoked` Refusal write site ───────────────────────
//
// The cases live-Postgres cannot carry. Three of the five no-op exits and every
// row-shape assertion are in the sibling `*.integration.test.ts`; what is here
// is the SQL SHAPE — which statements the transaction emits, how many, and
// where each bound value came from. A live database can prove the row landed;
// only the emitted statement list can prove it was not paid for with a second
// query.
describe('downgradeAutoApprovedResponseForManualReview Refusal write', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMockSql();
  });

  it("a downgrade's refusal_events row carries the account_id read by the transaction's existing business lock", async () => {
    pushDowngradeQueue();

    await expect(
      downgradeAutoApprovedResponseForManualReview(mockSql as never, input()),
    ).resolves.toBe('downgraded');

    // THE STATEMENT COUNT, not merely the column. This is the assertion the
    // owner's decision rests on: the ticket proposed resolving the account
    // through `src/lib/approval/audit.ts` instead, and every shape of that
    // answer costs an extra query inside a decision transaction. A test that
    // only looked for `account_id` in the emitted SQL would pass on the very
    // implementation this branch rejected. The ladder below is the ONE Refusal
    // INSERT longer than the pre-slice ladder and no longer.
    expect(sqlCalls.map((call) => call.text)).toEqual([
      expect.stringContaining('SELECT review_id FROM responses'),
      expect.stringContaining('SELECT id FROM reviews'),
      expect.stringContaining('FROM businesses'),
      expect.stringContaining('FROM responses'),
      expect.stringContaining("SET status = 'completed'"),
      expect.stringContaining("status = 'pending_approval'"),
      expect.stringContaining('SELECT account_id'),
      expect.stringContaining('INSERT INTO approval_audit_log'),
      expect.stringContaining('INSERT INTO refusal_events'),
      expect.stringContaining('INSERT INTO job_outbox'),
    ]);

    // Exactly ONE `businesses` row LOCK, and it is the one that grew a column.
    // The other `businesses` read in the ladder is
    // `insertAuditLogAutoPolicy`'s own `resolveAccountIdFromBusiness` — it
    // predates this slice, it is unlocked, and `src/lib/approval/audit.ts` is
    // deliberately not edited here.
    const businessLocks = sqlCalls.filter(
      (call) => call.text.includes('FROM businesses') && call.text.includes('FOR UPDATE'),
    );
    expect(businessLocks).toHaveLength(1);
    expect(businessLocks[0]!.text).toMatch(/SELECT\s+id,\s*account_id/);

    const [refusal] = refusalInserts();
    expect(refusal, 'expected exactly one refusal_events INSERT').toBeDefined();
    expect(refusalInserts()).toHaveLength(1);
    // Position 2 of migration 116's column list — id, account_id, business_id, …
    expect(refusal!.values[1]).toBe(BUSINESS_LOCK_ACCOUNT_ID);
    // And NOT the id `insertAuditLogAutoPolicy` resolved for its own row.
    expect(refusal!.values).not.toContain(AUDIT_RESOLVED_ACCOUNT_ID);
    expect(refusal!.values[2]).toBe('business-1');
  });

  it('every AutoPolicyDowngradeReason maps to a Refusal category and the downgrade writes it', async () => {
    // The runtime enumeration is the vocabulary map itself:
    // `AutoPolicyDowngradeReason` is a bare union with no `as const` array
    // behind it, and the map `satisfies Record<AutoPolicyDowngradeReason, …>`,
    // so its keys ARE the members. A member added upstream without a category
    // fails to compile there and appears here the moment it does.
    const reasons = Object.keys(AUTO_POST_REVOKED_REFUSAL_CATEGORIES) as
      (keyof typeof AUTO_POST_REVOKED_REFUSAL_CATEGORIES)[];
    expect(reasons).toEqual([
      'auto_approval_disabled',
      'notice_undelivered',
      'judge_disabled',
      'judge_unhealthy',
      'autopilot_entitlement_lost',
      'policy_suspended',
    ]);

    for (const reason of reasons) {
      resetMockSql();
      pushDowngradeQueue();

      await expect(
        downgradeAutoApprovedResponseForManualReview(mockSql as never, { ...input(), reason }),
      ).resolves.toBe('downgraded');

      const [refusal] = refusalInserts();
      expect(refusal, `expected a refusal_events INSERT for ${reason}`).toBeDefined();
      // Migration 116's column list, in order: id, account_id, business_id,
      // refusal_source, refusal_code, all_refusal_codes, refusal_category,
      // vocabulary_version, subject_type, subject_id. `occurred_at` binds
      // nothing — it is the `NOW()` fragment asserted below.
      expect(refusal!.values).toEqual([
        expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/),
        BUSINESS_LOCK_ACCOUNT_ID,
        'business-1',
        'auto_post_revoked',
        // The reason VERBATIM (C4) — never a category, never a marker.
        reason,
        null,
        AUTO_POST_REVOKED_REFUSAL_CATEGORIES[reason],
        REFUSAL_VOCABULARY_VERSION,
        'response',
        'response-1',
      ]);
      // The transaction-time sentinel, so the row is stamped by `NOW()` rather
      // than a bound `Date` whose microseconds postgres.js already threw away.
      expect(refusal!.text).toContain('NOW()');
    }
  });

  it('a no-op downgrade on a missing business writes no refusal_events row', async () => {
    // The second of the five no-op exits, and the one live Postgres cannot
    // reach: `responses.business_id` has a foreign key, so a response whose
    // review anchor resolves ALWAYS has a business row to lock. It is reachable
    // here, and it is the exit that would fire if a business were deleted out
    // from under an in-flight publish.
    sqlReturnQueue.push(
      mkTaggedResult([{ review_id: 'review-1' }]),
      mkTaggedResult([{ id: 'review-1' }]),
      mkTaggedResult([]),
    );

    await expect(
      downgradeAutoApprovedResponseForManualReview(mockSql as never, input()),
    ).resolves.toBe('no-op');

    expect(refusalInserts()).toHaveLength(0);
    expect(sqlCalls.some((call) => call.text.includes('approval_audit_log'))).toBe(false);
  });

  it('a downgrade whose guarded response UPDATE matches no row writes no refusal_events row', async () => {
    // The FIFTH exit, and the only one AFTER the outbox-attempt CAS. A write
    // placed above `if (!downgraded)` passes every other no-op case in this
    // slice; this is the one that catches it. Defensive against live Postgres
    // (the response row is already held `FOR UPDATE`), so it is a unit case by
    // construction.
    pushDowngradeQueue({ updateReturns: [] });

    await expect(
      downgradeAutoApprovedResponseForManualReview(mockSql as never, input()),
    ).resolves.toBe('no-op');

    expect(sqlCalls.some((call) => call.text.includes("status = 'pending_approval'"))).toBe(true);
    expect(refusalInserts()).toHaveLength(0);
    expect(sqlCalls.some((call) => call.text.includes('INSERT INTO approval_audit_log'))).toBe(false);
  });
});

describe('auto-policy downgrade gates route their reason verbatim', () => {
  it('each production gate routes every AutoPolicyDowngradeReason verbatim to the shared downgrade', () => {
    // A SOURCE-SHAPE case, on `auto-policy-downgrade-lock-order.test.ts`'s
    // precedent. `refusal_code` is the reason VERBATIM, so a gate that
    // normalised, collapsed or defaulted its reason on the way in would write a
    // truthful-looking row for the wrong decision — and no row-level assertion
    // in the sibling suite can see a reason that never reached the function.
    const judgeGate = readFileSync(new URL('../judge-gate.ts', import.meta.url), 'utf8');
    const publish = readFileSync(new URL('../auto-policy-publish.ts', import.meta.url), 'utf8');

    // FOUR call sites carrying TWO reasons — the standalone and the InTx arm of
    // each of the two judge conditions. Round 1 of the plan review corrected an
    // earlier wording that read this site count as a reason count.
    const judgeSites = [...judgeGate.matchAll(
      /downgradeAutoApprovedResponseForManualReview(?:InTx)?\([^)]*?reason:\s*'([a-z_]+)'/g,
    )].map((match) => match[1]);
    expect(judgeSites).toEqual([
      'judge_disabled',
      'judge_unhealthy',
      'judge_disabled',
      'judge_unhealthy',
    ]);

    const publishSites = [...publish.matchAll(
      /downgradeForReason\(\s*tx,\s*input,\s*'([a-z_]+)'\s*\)/g,
    )].map((match) => match[1]);
    expect(publishSites.slice().sort()).toEqual([
      'auto_approval_disabled',
      'autopilot_entitlement_lost',
      'notice_undelivered',
      'policy_suspended',
    ]);
    // `downgradeForReason` is a forwarder, not a translator: the reason it was
    // handed is the reason the shared downgrade receives.
    expect(publish).toMatch(
      /downgradeAutoApprovedResponseForManualReviewInTx\(tx,\s*\{\s*\.\.\.input,\s*reason\s*\}\)/,
    );

    // Together the two gates cover the union, so no member reaches the ledger
    // through an untested path.
    expect([...new Set([...judgeSites, ...publishSites])].sort()).toEqual(
      Object.keys(AUTO_POST_REVOKED_REFUSAL_CATEGORIES).sort(),
    );
  });
});
