import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockSql = vi.hoisted(() => vi.fn());

vi.mock('@/lib/db/server', () => ({
  sql: mockSql,
  jsonb: (value: unknown) => ({ __jsonb: value }),
}));

vi.mock('uuid', () => ({
  v7: () => '018f0000-0000-7000-8000-000000000001',
}));

import { enqueueAnalyticsEvent } from '../enqueue';

describe('enqueueAnalyticsEvent', () => {
  beforeEach(() => {
    mockSql.mockReset();
  });

  it('rejects invalid event names before calling the database', async () => {
    await expect(
      enqueueAnalyticsEvent({
        eventName: 'freeform_event' as Parameters<typeof enqueueAnalyticsEvent>[0]['eventName'],
        eventKey: 'freeform_event:acct-1',
        distinctId: 'acct-1',
      }),
    ).rejects.toThrow('Invalid analytics event name: freeform_event');

    expect(mockSql).not.toHaveBeenCalled();
  });

  it('inserts analytics_events with sanitized properties and idempotent duplicate handling', async () => {
    const insertedKeys = new Set<string>();
    let insertedCount = 0;

    const tx = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
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

    await enqueueAnalyticsEvent(
      {
        eventName: 'first_response_drafted',
        eventKey: 'first_response_drafted:acct-1',
        distinctId: 'acct-1',
        accountId: 'acct-1',
        properties: { account_id: 'acct-1', response_text: 'drop me' },
      },
      tx as Parameters<typeof enqueueAnalyticsEvent>[1],
    );
    await enqueueAnalyticsEvent(
      {
        eventName: 'first_response_drafted',
        eventKey: 'first_response_drafted:acct-1',
        distinctId: 'acct-1',
        accountId: 'acct-1',
        properties: { account_id: 'acct-1', response_text: 'drop me again' },
      },
      tx as Parameters<typeof enqueueAnalyticsEvent>[1],
    );

    expect(mockSql).not.toHaveBeenCalled();
    expect(tx).toHaveBeenCalledTimes(2);
    expect(insertedKeys).toEqual(new Set(['first_response_drafted:acct-1']));
    expect(insertedCount).toBe(1);

    const text = tx.mock.calls[0]![0].join(' ');
    expect(text).toContain('INSERT INTO analytics_events');
    expect(text).toContain('ON CONFLICT (event_key) DO NOTHING');
    expect(tx.mock.calls[0]).toContain('018f0000-0000-7000-8000-000000000001');
    expect(JSON.stringify(tx.mock.calls[0])).not.toContain('drop me');
    expect(JSON.stringify(tx.mock.calls[1])).not.toContain('drop me again');
  });
});
