import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { createMockSql, type MockSqlHarness } from '../../../../worker/__tests__/helpers/mock-sql';

vi.mock('uuid', () => ({
  v7: () => '018f0000-0000-7000-8000-000000000001',
}));

import { enqueueAnalyticsEvent } from '../enqueue';

describe('enqueueAnalyticsEvent', () => {
  let harness: MockSqlHarness;

  beforeEach(() => {
    harness = createMockSql();
  });

  it('rejects invalid event names before calling the database', async () => {
    await expect(
      enqueueAnalyticsEvent(harness.mockSql as unknown as Sql, {
        eventName: 'freeform_event' as Parameters<typeof enqueueAnalyticsEvent>[1]['eventName'],
        eventKey: 'freeform_event:acct-1',
        distinctId: 'acct-1',
      }),
    ).rejects.toThrow('Invalid analytics event name: freeform_event');

    expect(harness.mockSql).not.toHaveBeenCalled();
  });

  it('inserts analytics_events with sanitized properties and idempotent duplicate handling', async () => {
    const insertedKeys = new Set<string>();
    let insertedCount = 0;

    const txMock = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join(' ');
      const eventKey = values[1];
      if (typeof eventKey !== 'string') {
        throw new Error('Expected event_key to be the second bound value');
      }

      if (insertedKeys.has(eventKey)) {
        if (!text.includes('ON CONFLICT (event_key) DO NOTHING')) {
          throw new Error(`Duplicate analytics event_key was not handled: ${eventKey}`);
        }
        return [];
      }

      insertedKeys.add(eventKey);
      insertedCount += 1;
      return [];
    });
    // Stand-in for Postgres.js's `sql.json` — enqueueAnalyticsEvent now calls
    // the injected client's `.json()` directly (no more `jsonb` helper import).
    const txJson = (value: unknown) => ({ __jsonb: value });
    const tx = Object.assign(txMock, { json: txJson }) as unknown as Sql;

    await enqueueAnalyticsEvent(tx, {
      eventName: 'first_response_drafted',
      eventKey: 'first_response_drafted:acct-1',
      distinctId: 'acct-1',
      accountId: 'acct-1',
      properties: { account_id: 'acct-1', response_text: 'drop me' },
    });
    await enqueueAnalyticsEvent(tx, {
      eventName: 'first_response_drafted',
      eventKey: 'first_response_drafted:acct-1',
      distinctId: 'acct-1',
      accountId: 'acct-1',
      properties: { account_id: 'acct-1', response_text: 'drop me again' },
    });

    expect(harness.mockSql).not.toHaveBeenCalled();
    expect(txMock).toHaveBeenCalledTimes(2);
    expect(insertedKeys).toEqual(new Set(['first_response_drafted:acct-1']));
    expect(insertedCount).toBe(1);

    const text = txMock.mock.calls[0]![0].join(' ');
    expect(text).toContain('INSERT INTO analytics_events');
    expect(text).toContain('ON CONFLICT (event_key) DO NOTHING');
    expect(txMock.mock.calls[0]).toContain('018f0000-0000-7000-8000-000000000001');
    expect(JSON.stringify(txMock.mock.calls[0])).not.toContain('drop me');
    expect(JSON.stringify(txMock.mock.calls[1])).not.toContain('drop me again');
  });
});
