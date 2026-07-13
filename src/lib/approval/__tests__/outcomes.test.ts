// Unit coverage for the shared owner-decision instrumentation helpers
// (WS4 plan Task 10, spec §2.8). run-spine runs REAL against the shared
// fragment-aware Postgres.js mock so the agent_outcomes INSERT shape —
// including the retry-absorbing ON CONFLICT clause — is pinned as text.
import { describe, it, expect, beforeEach } from 'vitest';
import type { TransactionSql } from 'postgres';

import {
  createMockSql,
  mkTaggedResult,
  type MockSqlHarness,
} from '../../../../worker/__tests__/helpers/mock-sql';
import { anchorReviewLockOrder, recordOwnerDecisionOutcome } from '../outcomes';

const ACTIVE_RUN = { id: 'run-1', account_id: 'acct-1' };

let harness: MockSqlHarness;

function tx(): TransactionSql {
  return harness.mockSql as unknown as TransactionSql;
}

beforeEach(() => {
  harness = createMockSql();
});

describe('anchorReviewLockOrder', () => {
  it('issues the UNLOCKED responses pre-read, then the reviews FOR UPDATE (veto.ts lock-order pattern)', async () => {
    harness.sqlReturnQueue.push(
      mkTaggedResult([{ review_id: 'rev-1' }]), // unlocked pre-read
      mkTaggedResult([{ id: 'rev-1' }]), // reviews FOR UPDATE
    );

    await anchorReviewLockOrder(tx(), 'resp-1', 'biz-1');

    const [preRead, reviewLock] = harness.sqlCalls;
    expect(preRead).toBeDefined();
    expect(preRead!.text).toContain('SELECT review_id FROM responses');
    expect(preRead!.text).not.toContain('FOR UPDATE');
    expect(preRead!.values).toEqual(['resp-1', 'biz-1']);

    expect(reviewLock).toBeDefined();
    expect(reviewLock!.text).toContain('FROM reviews');
    expect(reviewLock!.text).toContain('FOR UPDATE');
    expect(reviewLock!.values).toEqual(['rev-1', 'biz-1']);
  });

  it('skips the reviews lock when the response row is missing (caller claim throws its own not-found)', async () => {
    harness.sqlReturnQueue.push(mkTaggedResult([]));

    await anchorReviewLockOrder(tx(), 'resp-1', 'biz-1');

    expect(harness.sqlCalls).toHaveLength(1);
    expect(harness.sqlCalls[0]!.text).not.toContain('FOR UPDATE');
  });
});

describe('recordOwnerDecisionOutcome', () => {
  it("records the outcome on the running run with attributed_agent 'reply' and the given kind", async () => {
    harness.sqlReturnQueue.push(
      mkTaggedResult([ACTIVE_RUN]), // findActiveReviewRun
      mkTaggedResult([]), // agent_outcomes INSERT
    );

    await recordOwnerDecisionOutcome(tx(), {
      reviewId: 'rev-1',
      businessId: 'biz-1',
      outcomeKind: 'reply_approved_no_edit',
    });

    const insert = harness.sqlCalls.find((c) => c.text.includes('INSERT INTO agent_outcomes'));
    expect(insert).toBeDefined();
    // values: [uuid, account_id, business_id, run_id, attributed_agent, kind, unit_count]
    expect(insert!.values.slice(1)).toEqual([
      'acct-1', 'biz-1', 'run-1', 'reply', 'reply_approved_no_edit', 1,
    ]);
  });

  it('skips silently when no run is running (legacy/no-run posture) — exactly one lookup, zero inserts', async () => {
    harness.sqlReturnQueue.push(mkTaggedResult([]));

    await recordOwnerDecisionOutcome(tx(), {
      reviewId: 'rev-1',
      businessId: 'biz-1',
      outcomeKind: 'reply_edited_by_owner',
    });

    expect(harness.sqlCalls).toHaveLength(1);
    expect(harness.sqlCalls[0]!.text).toContain('FROM agent_runs');
    expect(harness.sqlCalls.some((c) => c.text.includes('INSERT INTO agent_outcomes'))).toBe(false);
  });

  it('is retry-safe: driving the emitter twice issues two INSERTs that both carry the per-(run,kind) ON CONFLICT absorber', async () => {
    harness.sqlReturnQueue.push(
      mkTaggedResult([ACTIVE_RUN]),
      mkTaggedResult([]),
      mkTaggedResult([ACTIVE_RUN]),
      mkTaggedResult([]),
    );

    const input = {
      reviewId: 'rev-1',
      businessId: 'biz-1',
      outcomeKind: 'reply_edited_by_owner' as const,
    };
    await recordOwnerDecisionOutcome(tx(), input);
    await recordOwnerDecisionOutcome(tx(), input);

    const inserts = harness.sqlCalls.filter((c) => c.text.includes('INSERT INTO agent_outcomes'));
    expect(inserts).toHaveLength(2);
    for (const insert of inserts) {
      // Must match the agent_outcomes_once_per_run_kind partial index
      // byte-for-byte (migration 071) — the second insert is absorbed in-DB.
      expect(insert.text).toContain('ON CONFLICT (agent_run_id, outcome_kind) WHERE agent_run_id IS NOT NULL');
      expect(insert.text).toContain('DO NOTHING');
    }
  });
});
