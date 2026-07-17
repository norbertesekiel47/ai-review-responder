import { beforeEach, describe, expect, it, vi } from 'vitest';
import { APPROVAL_METHOD } from '../../../../src/lib/auto-approval/types';
import { AUDIT_ACTION_AUTO_APPROVED_BY_POLICY } from '../../../../src/lib/approval/audit';

const mocks = vi.hoisted(() => ({
  markCompletedIfOwned: vi.fn(),
  enqueuePublish: vi.fn(),
}));

const { mockSql, sqlReturnQueue, sqlCalls, resetMockSql } = await vi.hoisted(async () => {
  const { createMockSql } = await import('../../../__tests__/helpers/mock-sql');
  return { ...createMockSql() };
});

vi.mock('../../../../src/lib/shared/outbox', () => ({
  markOutboxCompletedIfOwned: mocks.markCompletedIfOwned,
}));
vi.mock('../../../../src/lib/shared/job-outbox-helpers', () => ({
  enqueuePublishResponse: mocks.enqueuePublish,
}));

import { enforceElapsedVetoWindowInTx } from '../veto-window-gate';

const RESPONSE_ID = 'response-veto-1';
const BUSINESS_ID = 'business-veto-1';
const OUTBOX_ID = 'outbox-veto-1';
const OUTBOX_ATTEMPT = 3;
const CORRELATION_ID = 'correlation-veto-1';
const FIRST_SENT = new Date('2026-07-15T12:00:00.000Z');
const VETO_WINDOW_MINUTES = 15;
const ANCHORED_DEADLINE = new Date('2026-07-15T12:15:00.000Z');

function createInput() {
  return {
    responseId: RESPONSE_ID,
    businessId: BUSINESS_ID,
    outboxId: OUTBOX_ID,
    outboxAttempt: OUTBOX_ATTEMPT,
    correlationId: CORRELATION_ID,
    logger: { log: vi.fn() },
  };
}

function gateRow(dbNow: Date) {
  return [{ first_sent: FIRST_SENT, db_now: dbNow }];
}

function grantRow(vetoWindowMinutes: number | null = VETO_WINDOW_MINUTES) {
  return [{ veto_window_minutes: vetoWindowMinutes }];
}

function expectGateQuery(): void {
  const query = sqlCalls[0]!;
  expect(query.text).toContain('MIN(nd.sent_at) AS first_sent');
  expect(query.text).toContain("nd.template = 'pending_post_notice'");
  expect(query.text).toContain('nd.sent_at IS NOT NULL');
  expect(query.values).toEqual([RESPONSE_ID, BUSINESS_ID]);
}

function expectGrantQuery(): void {
  const query = sqlCalls[1]!;
  expect(query.text).toContain("metadata->>'veto_window_minutes'");
  expect(query.text).toContain('ORDER BY aal.created_at DESC');
  expect(query.values).toEqual([
    RESPONSE_ID,
    BUSINESS_ID,
    AUDIT_ACTION_AUTO_APPROVED_BY_POLICY,
  ]);
}

function invocationOrder(mock: { mock: { invocationCallOrder: number[] } }, index = 0): number {
  const order = mock.mock.invocationCallOrder[index];
  if (order === undefined) throw new Error(`Expected invocation ${index} to exist`);
  return order;
}

beforeEach(() => {
  resetMockSql();
  mockSql.mockClear();
  mocks.markCompletedIfOwned.mockReset();
  mocks.markCompletedIfOwned.mockResolvedValue(true);
  mocks.enqueuePublish.mockReset();
  mocks.enqueuePublish.mockResolvedValue(undefined);
});

describe('elapsed veto-window gate — DB-less branch coverage', () => {
  it.each([
    ['missing aggregate row', []],
    ['NULL first delivery', [{ first_sent: null, db_now: new Date('2026-07-15T12:20:00.000Z') }]],
  ])('downgrades for %s', async (_case, result) => {
    const input = createInput();
    sqlReturnQueue.push(result);
    expect(sqlReturnQueue).toHaveLength(1);

    await expect(enforceElapsedVetoWindowInTx(mockSql as never, input)).resolves.toBe('downgrade');

    expect(sqlCalls).toHaveLength(1);
    expectGateQuery();
    expect(mocks.markCompletedIfOwned).not.toHaveBeenCalled();
    expect(mocks.enqueuePublish).not.toHaveBeenCalled();
    expect(input.logger.log).not.toHaveBeenCalled();
    expect(sqlReturnQueue).toHaveLength(0);
  });

  it.each([
    ['missing grant row', []],
    ['NULL granted window', grantRow(null)],
  ])('throws the approval invariant for a delivered notice with %s', async (_case, result) => {
    const input = createInput();
    sqlReturnQueue.push(
      gateRow(new Date('2026-07-15T12:20:00.000Z')),
      result,
    );
    expect(sqlReturnQueue).toHaveLength(2);

    await expect(enforceElapsedVetoWindowInTx(mockSql as never, input)).rejects.toThrow(
      `Invariant violation: auto_policy response ${RESPONSE_ID}`,
    );

    expect(sqlCalls).toHaveLength(2);
    expectGateQuery();
    expectGrantQuery();
    expect(mocks.markCompletedIfOwned).not.toHaveBeenCalled();
    expect(mocks.enqueuePublish).not.toHaveBeenCalled();
    expect(input.logger.log).not.toHaveBeenCalled();
    expect(sqlReturnQueue).toHaveLength(0);
  });

  it('proceeds at the exact anchored deadline boundary without touching outbox state', async () => {
    const input = createInput();
    sqlReturnQueue.push(gateRow(ANCHORED_DEADLINE), grantRow());
    expect(sqlReturnQueue).toHaveLength(2);

    await expect(enforceElapsedVetoWindowInTx(mockSql as never, input)).resolves.toBe('proceed');

    expect(sqlCalls).toHaveLength(2);
    expectGateQuery();
    expectGrantQuery();
    expect(mocks.markCompletedIfOwned).not.toHaveBeenCalled();
    expect(mocks.enqueuePublish).not.toHaveBeenCalled();
    expect(input.logger.log).not.toHaveBeenCalled();
    expect(sqlReturnQueue).toHaveLength(0);
  });

  it('completes without UPDATE or enqueue when the current outbox attempt loses its CAS', async () => {
    const input = createInput();
    mocks.markCompletedIfOwned.mockResolvedValueOnce(false);
    sqlReturnQueue.push(
      gateRow(new Date('2026-07-15T12:10:00.000Z')),
      grantRow(),
    );
    expect(sqlReturnQueue).toHaveLength(2);

    await expect(enforceElapsedVetoWindowInTx(mockSql as never, input)).resolves.toBe('completed');

    expect(sqlCalls).toHaveLength(2);
    expectGateQuery();
    expectGrantQuery();
    expect(mocks.markCompletedIfOwned).toHaveBeenCalledOnce();
    expect(mocks.markCompletedIfOwned).toHaveBeenCalledWith(
      mockSql,
      OUTBOX_ID,
      OUTBOX_ATTEMPT,
    );
    expect(mocks.enqueuePublish).not.toHaveBeenCalled();
    expect(input.logger.log).not.toHaveBeenCalled();
    expect(sqlReturnQueue).toHaveLength(0);
  });

  it('logs and does not enqueue when completion wins but the response UPDATE loses its race', async () => {
    const input = createInput();
    sqlReturnQueue.push(
      gateRow(new Date('2026-07-15T12:10:00.000Z')),
      grantRow(),
      [],
    );
    expect(sqlReturnQueue).toHaveLength(3);

    await expect(enforceElapsedVetoWindowInTx(mockSql as never, input)).resolves.toBe('completed');

    expect(sqlCalls).toHaveLength(3);
    expectGateQuery();
    expectGrantQuery();
    const update = sqlCalls[2]!;
    expect(update.text).toContain('UPDATE responses');
    expect(update.text).toContain("status = 'approved'");
    expect(update.values).toEqual([
      ANCHORED_DEADLINE,
      RESPONSE_ID,
      BUSINESS_ID,
      APPROVAL_METHOD.AUTO_POLICY,
    ]);
    expect(invocationOrder(mocks.markCompletedIfOwned)).toBeLessThan(
      invocationOrder(mockSql, 2),
    );
    expect(mocks.enqueuePublish).not.toHaveBeenCalled();
    expect(input.logger.log).toHaveBeenCalledWith(
      `Veto-window push for response ${RESPONSE_ID} lost a state race; completed outbox ${OUTBOX_ID} without re-enqueue`,
    );
    expect(sqlReturnQueue).toHaveLength(0);
  });

  it('anchors the pushed deadline and orders completion before UPDATE before delayed enqueue', async () => {
    const input = createInput();
    sqlReturnQueue.push(
      gateRow(new Date('2026-07-15T12:10:00.000Z')),
      grantRow(),
      [{ auto_post_scheduled_at: ANCHORED_DEADLINE }],
    );
    expect(sqlReturnQueue).toHaveLength(3);

    await expect(enforceElapsedVetoWindowInTx(mockSql as never, input)).resolves.toBe('completed');

    expect(sqlCalls).toHaveLength(3);
    expectGateQuery();
    expectGrantQuery();
    const update = sqlCalls[2]!;
    expect(update.text).toContain('UPDATE responses');
    expect(update.text).toContain('RETURNING auto_post_scheduled_at');
    expect(update.values).toEqual([
      ANCHORED_DEADLINE,
      RESPONSE_ID,
      BUSINESS_ID,
      APPROVAL_METHOD.AUTO_POLICY,
    ]);
    expect(mocks.markCompletedIfOwned).toHaveBeenCalledWith(
      mockSql,
      OUTBOX_ID,
      OUTBOX_ATTEMPT,
    );
    expect(mocks.enqueuePublish).toHaveBeenCalledOnce();
    expect(mocks.enqueuePublish).toHaveBeenCalledWith(mockSql, {
      responseId: RESPONSE_ID,
      businessId: BUSINESS_ID,
      correlationId: CORRELATION_ID,
      availableAt: ANCHORED_DEADLINE,
    });
    const completionOrder = invocationOrder(mocks.markCompletedIfOwned);
    const updateOrder = invocationOrder(mockSql, 2);
    const enqueueOrder = invocationOrder(mocks.enqueuePublish);
    expect(completionOrder).toBeLessThan(updateOrder);
    expect(updateOrder).toBeLessThan(enqueueOrder);
    expect(input.logger.log).toHaveBeenCalledWith(
      `Response ${RESPONSE_ID} veto window extended to ${ANCHORED_DEADLINE.toISOString()}, publish re-enqueued`,
    );
    expect(sqlReturnQueue).toHaveLength(0);
  });
});
